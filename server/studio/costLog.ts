/**
 * studio/costLog — the spike's cost + latency record.
 *
 * The router already knows what a generation cost; nothing was capturing it. This appends one JSONL
 * line per completed generation so the spike can answer "Nano edit ran N times, $X total, ~Ys each"
 * instead of guessing.
 *
 * SPIKE TOOLING, deliberately small: append-only JSONL via fs.appendFile, no dependency, no table,
 * no migration. A file is the right shape because the spike reads it back by hand and throws it
 * away. If this ever outlives the spike it should become a real table — it is not one yet, and
 * pretending otherwise would mean a migration on a prod database for throwaway instrumentation.
 *
 * TWO RULES THAT MATTER
 *
 * 1. Never lose a generation to a logging failure. Every write is best-effort and swallowed — a full
 *    disk must not fail a call the user already paid for.
 * 2. Never log a secret. Reference and output URLs are frequently SIGNED GCS urls whose query string
 *    IS the credential, so only the path is ever recorded (see safeRef).
 */
import { appendFile, readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { createLogger } from "../logger";
import type { GenerationAttribution, GenerationTask, ProviderName } from "./types";

const logger = createLogger("studio/cost-log");

/** Where the JSONL lands. Kept out of the repo by default so a spike run never dirties the tree. */
export const logPath = () => process.env.STUDIO_COST_LOG ?? "studio-cost-log.jsonl";

/**
 * The adapters speak `reported | estimated`; the harness reports `authoritative | estimated`. Same
 * distinction, and the mapping lives here so the two vocabularies never drift into each other.
 * "authoritative" = the provider billed us this. "estimated" = we computed it and it could be wrong.
 */
export type CostBasis = "authoritative" | "estimated";
export const toCostBasis = (b: "reported" | "estimated"): CostBasis =>
  b === "reported" ? "authoritative" : "estimated";

/**
 * What a cost line may be FOR. The router's `GenerationTask` is a closed union that reaches every
 * adapter's `supports()` and the price table, and qa/cost.ts explains why an inspection must not be
 * added to it. The log is the one place the wider vocabulary belongs: everything that spends on a
 * model, through one door (PR 11, R-2).
 */
export type LoggedTask =
  | GenerationTask
  | "edit.recommend"
  | "image.detect"
  | "image.inspect"
  | "clip.inspect";

/** The six join keys, all nullable, never absent — see `emptyAttribution`. */
export type LineAttribution = GenerationAttribution;

export const emptyAttribution = (): LineAttribution => ({
  jobId: null,
  previewId: null,
  editPreviewId: null,
  batchId: null,
  promptVersion: null,
  assetId: null,
});

/**
 * Normalise a caller's partial attribution to the full key set. An `undefined` is written as null
 * so the line is readable without knowing which PR added which key: a reader that finds no `jobId`
 * KEY is looking at a pre-PR-11 line, and one that finds `jobId: null` is looking at a call site
 * that had no job.
 */
export function attributionFor(
  a: Partial<GenerationAttribution> | null | undefined,
): LineAttribution {
  const base = emptyAttribution();
  if (!a) return base;
  for (const k of Object.keys(base) as (keyof LineAttribution)[]) {
    base[k] = a[k] ?? null;
  }
  return base;
}

export interface GenerationRecord extends LineAttribution {
  kind: "generation";
  /** Stable id so a quality tag can be attached later without rewriting the line. */
  id: string;
  timestamp: string;
  task: LoggedTask;
  model: string;
  provider: ProviderName;
  /**
   * How many reference images went in, their ids when the caller supplied them, and — since typed
   * roles — which SLOT each one occupied, in the order they were sent.
   *
   * `slots` is what makes a cost line answer the question this feature will actually be audited on:
   * "was that generation conditioned on a style reference, and where did it sit?" Reconstructing it
   * from the count alone is impossible, and reconstructing it from the ids needs a database the log
   * deliberately does not have.
   */
  inputRefs: { count: number; ids?: string[]; slots?: string[] };
  /** Where the output went — path only, never a signed url's query string. Null for inline bytes. */
  outputRef: string | null;
  cost: number;
  costBasis: CostBasis;
  /**
   * How the number was reached — the adapter's own `cost.detail`, verbatim. Without it a
   * token-accurate Vertex cost and a silent fallback to the pre-generation estimate write
   * BYTE-IDENTICAL lines: both are basis "estimated", and detail is the only field that says which
   * one happened. That ambiguity is what made a cost investigation necessary in the first place.
   */
  detail: string | null;
  latencyMs: number;
  /** Always null from the harness. Filled by hand during the spike via tagGeneration(). */
  qualityTag: string | null;
}

/** An amendment line. Append-only: tagging never rewrites the original record. */
export interface TagRecord {
  kind: "tag";
  id: string;
  timestamp: string;
  qualityTag: string;
  note?: string;
}

export type LogLine = GenerationRecord | TagRecord;

/** Strip a url down to something safe to write: no query string (that is where signatures live). */
export function safeRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (ref.startsWith("gs://")) return ref;
  try {
    const u = new URL(ref);
    return `${u.origin}${u.pathname}`;
  } catch {
    return ref.split("?")[0];
  }
}

async function append(line: LogLine, path = logPath()): Promise<void> {
  try {
    await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch (err: any) {
    // Best effort by design — see rule 1 above.
    logger.warn({ error: err?.message?.slice(0, 120), path }, "cost log write failed");
  }
}

/** Record one completed generation. Returns the record id so it can be tagged later. */
export async function recordGeneration(
  r: Omit<
    GenerationRecord,
    "kind" | "id" | "timestamp" | "qualityTag" | keyof LineAttribution
  > & {
    timestamp?: string;
    /** The join keys (R-1). Whatever is missing is written as null, never left off the line. */
    attribution?: Partial<GenerationAttribution> | null;
  },
  path = logPath(),
): Promise<string> {
  const id = randomUUID();
  const { attribution, ...rest } = r;
  // The caller's fields are spread FIRST so the harness-owned identity fields always win. With the
  // spread last, a caller passing its own `id` silently detached the returned id from the written
  // line, and every later tagGeneration() would land on nothing.
  await append({
    ...rest,
    ...attributionFor(attribution),
    kind: "generation",
    id,
    timestamp: rest.timestamp ?? new Date().toISOString(),
    qualityTag: null,
  }, path);
  return id;
}

/**
 * Attach a hand-written quality judgement to a generation — "identity held", "drifted",
 * "artifact: hands". No scoring, no vocabulary: the spike decides what the words mean.
 */
export async function tagGeneration(id: string, qualityTag: string, note?: string, path = logPath()): Promise<void> {
  // `path` matters: the report script reads an explicit --log, and a tag written to the DEFAULT path
  // instead would silently vanish. Reads and writes must target the same file.
  await append({ kind: "tag", id, timestamp: new Date().toISOString(), qualityTag, ...(note ? { note } : {}) }, path);
}

/** Read the log back, folding each tag onto its generation. Missing file = empty, not an error. */
export async function readLog(path = logPath()): Promise<GenerationRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const gens = new Map<string, GenerationRecord>();
  const tags: TagRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: LogLine;
    try { parsed = JSON.parse(line) as LogLine; } catch { continue; }   // a torn line must not kill the report
    if (parsed.kind === "generation") gens.set(parsed.id, parsed);
    else if (parsed.kind === "tag") tags.push(parsed);
  }
  // Last tag wins, so a re-judgement during the spike is just another appended line.
  for (const t of tags) {
    const g = gens.get(t.id);
    if (g) g.qualityTag = t.qualityTag;
  }
  return [...gens.values()];
}

// --- Aggregation ---------------------------------------------------------------------------------

export interface ReportRow {
  model: string;
  task: LoggedTask;
  provider: ProviderName;
  count: number;
  /**
   * Cost is split by basis and NEVER summed across the two. An authoritative total is money we were
   * billed; an estimated total is arithmetic that could be wrong. Adding them would produce a number
   * that looks precise and isn't, which is the whole reason costBasis is carried through.
   */
  costAuthoritative: number;
  costEstimated: number;
  countAuthoritative: number;
  countEstimated: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  /** Counts per hand-written tag, e.g. { "identity held": 3, drifted: 1 }. */
  qualityTags: Record<string, number>;
  untagged: number;
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Group by (model, task, provider) — the three things that change what a generation costs. */
export function aggregate(records: GenerationRecord[]): ReportRow[] {
  const byKey = new Map<string, GenerationRecord[]>();
  for (const r of records) {
    const k = `${r.model} ${r.task} ${r.provider}`;
    const arr = byKey.get(k) ?? [];
    arr.push(r);
    byKey.set(k, arr);
  }

  const rows: ReportRow[] = [];
  for (const group of byKey.values()) {
    const latencies = group.map((g) => g.latencyMs);
    const auth = group.filter((g) => g.costBasis === "authoritative");
    const est = group.filter((g) => g.costBasis === "estimated");
    const qualityTags: Record<string, number> = {};
    let untagged = 0;
    for (const g of group) {
      if (g.qualityTag) qualityTags[g.qualityTag] = (qualityTags[g.qualityTag] ?? 0) + 1;
      else untagged++;
    }
    rows.push({
      model: group[0].model,
      task: group[0].task,
      provider: group[0].provider,
      count: group.length,
      costAuthoritative: round(auth.reduce((s, g) => s + g.cost, 0)),
      costEstimated: round(est.reduce((s, g) => s + g.cost, 0)),
      countAuthoritative: auth.length,
      countEstimated: est.length,
      avgLatencyMs: Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length),
      minLatencyMs: Math.min(...latencies),
      maxLatencyMs: Math.max(...latencies),
      qualityTags,
      untagged,
    });
  }
  // Most-used first — the spike cares about what it actually leaned on.
  return rows.sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
}

/** Render the rows as a fixed-width table. Returns the string so a test can assert on it. */
export function formatReport(rows: ReportRow[]): string {
  if (!rows.length) return "No generations logged yet.\n";

  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
  const head = ["MODEL", "TASK", "PROV", "N", "COST", "BASIS", "AVG", "MIN", "MAX"];
  const body = rows.map((r) => {
    // A group can legitimately hold both bases (a provider flip mid-spike); show both rather than
    // silently picking one.
    const parts: string[] = [];
    if (r.countAuthoritative) parts.push(money(r.costAuthoritative));
    if (r.countEstimated) parts.push(`${money(r.costEstimated)}~`);
    const basis = [
      r.countAuthoritative ? `${r.countAuthoritative} billed` : null,
      r.countEstimated ? `${r.countEstimated} est` : null,
    ].filter(Boolean).join(" + ");
    return [
      r.model,
      r.task.replace("image.", "img.").replace("video.", "vid."),
      r.provider,
      String(r.count),
      parts.join(" + "),
      basis,
      secs(r.avgLatencyMs),
      secs(r.minLatencyMs),
      secs(r.maxLatencyMs),
    ];
  });

  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();

  const totalAuth = rows.reduce((s, r) => s + r.costAuthoritative, 0);
  const totalEst = rows.reduce((s, r) => s + r.costEstimated, 0);
  const n = rows.reduce((s, r) => s + r.count, 0);

  const tagLines = rows
    .filter((r) => Object.keys(r.qualityTags).length || r.untagged)
    .map((r) => {
      const tags = Object.entries(r.qualityTags).map(([t, c]) => `${t} x${c}`).join(", ");
      return `  ${r.model} ${r.task}: ${tags || "no tags"}${r.untagged ? ` (${r.untagged} untagged)` : ""}`;
    });

  return [
    line(head),
    line(widths.map((w) => "-".repeat(w))),
    ...body.map(line),
    "",
    `${n} generation${n === 1 ? "" : "s"} - billed ${money(totalAuth)} - estimated ${money(totalEst)}~`,
    "~ = estimated, not billed. The two are never added together.",
    "",
    "QUALITY",
    ...(tagLines.length ? tagLines : ["  (none tagged yet - use tagGeneration(id, tag))"]),
    "",
  ].join("\n");
}

/** Read + aggregate + format in one call, for the script. */
export async function buildReport(path = logPath()): Promise<string> {
  return formatReport(aggregate(await readLog(path)));
}
