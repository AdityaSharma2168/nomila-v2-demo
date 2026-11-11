/**
 * identityRunReportFormat.ts — PURE formatting/diff helpers for identityRunReport.ts. No DB, no provider, no fs.
 *
 * Kept separate from the DB-reading script so the parts worth unit-testing (basis-ref extraction, kind/tier
 * counting, the generic value→summary line, the Markdown renderer) can be exercised with fixtures instead of a
 * live database. Everything here is deterministic given its inputs.
 */
import { parseBasisRef, refKey, type BasisRef } from "../../services/intelligence/identityIntelligence/contract";

// ─── small generic helpers ─────────────────────────────────────────────────────

export function cap(s: string, n = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** A one-line, type-appropriate rendering of an arbitrary JSON value, generic over the contract shape. */
export function describeJsonValue(v: unknown, maxLen = 220): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "string") return v.trim() ? cap(v, maxLen) : "none";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return "none (0 items)";
    const items = v.slice(0, 4).map((x) => (typeof x === "object" && x !== null ? describeJsonValue(x, 60) : String(x)));
    const more = v.length > 4 ? `, … (+${v.length - 4} more)` : "";
    return `[${v.length} item${v.length === 1 ? "" : "s"}] ${items.join("; ")}${more}`;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Prefer a human line when the object looks like a {value|text, basis?} shape.
    const lead = o.value ?? o.text ?? o.summary ?? o.label;
    if (typeof lead === "string" && lead.trim()) {
      const basis = Array.isArray(o.basis) ? ` (${o.basis.length} basis)` : "";
      return `${cap(lead, maxLen)}${basis}`;
    }
    const keys = Object.keys(o);
    if (!keys.length) return "{} (empty)";
    return `{${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", …" : ""}}`;
  }
  return String(v);
}

// ─── basis-ref extraction ──────────────────────────────────────────────────────

/**
 * Walk an arbitrary JSON value and collect every embedded BasisRef-shaped object, deduped by refKey. Generic over
 * the contract version: it finds basis refs wherever they sit structurally, so a 0.2 record with new field names
 * (essence, positioning, pillars, …) still yields its refs as long as it keeps the same BasisRef shape.
 */
export function collectBasisRefs(node: unknown, seen: Map<string, BasisRef> = new Map()): BasisRef[] {
  if (node == null || typeof node !== "object") return [...seen.values()];
  if (Array.isArray(node)) {
    for (const x of node) collectBasisRefs(x, seen);
    return [...seen.values()];
  }
  const ref = parseBasisRef(node);
  if (ref) seen.set(refKey(ref), ref);
  for (const v of Object.values(node as Record<string, unknown>)) collectBasisRefs(v, seen);
  return [...seen.values()];
}

/** Same as collectBasisRefs, but over a plain object with one or more top-level keys removed first (e.g. "envelope"). */
export function collectBasisRefsExcluding(value: Record<string, unknown> | null | undefined, excludeKeys: readonly string[]): BasisRef[] {
  if (!value || typeof value !== "object") return [];
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (!excludeKeys.includes(k)) copy[k] = v;
  return collectBasisRefs(copy);
}

// ─── counting ───────────────────────────────────────────────────────────────────

export function countByKindTier(entries: ReadonlyArray<{ kind: string; tier: string }>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const e of entries) {
    const byTier = (out[e.kind] ??= {});
    byTier[e.tier] = (byTier[e.tier] ?? 0) + 1;
  }
  return out;
}

export function countByTier(entries: ReadonlyArray<{ tier: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.tier] = (out[e.tier] ?? 0) + 1;
  return out;
}

export function countByKey(values: ReadonlyArray<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Sorted kinds present with a non-zero count across a kind→tier→count map. */
export function kindsOf(counts: Record<string, Record<string, number>>): string[] {
  return Object.keys(counts).sort();
}

export interface KindDiff { added: string[]; removed: string[] }

/** Kinds present in `next` but not `prev`, and vice versa — both sorted. */
export function diffKinds(prevKinds: ReadonlyArray<string>, nextKinds: ReadonlyArray<string>): KindDiff {
  const prevSet = new Set(prevKinds);
  const nextSet = new Set(nextKinds);
  return {
    added: [...nextSet].filter((k) => !prevSet.has(k)).sort(),
    removed: [...prevSet].filter((k) => !nextSet.has(k)).sort(),
  };
}

// ─── field-by-field comparison of two ledger `value` blobs ─────────────────────

export interface FieldDiff { field: string; previous: string; latest: string; changed: boolean }

/** Metadata fields excluded from the side-by-side field comparison — shown elsewhere in the report. */
const COMPARISON_METADATA_FIELDS: readonly string[] = ["contract", "envelope", "claims", "specVersion", "policyVersion", "model", "generatedAt", "inputVersion"];

/**
 * Side-by-side of every top-level field present on EITHER value (contract-agnostic: works for 0.1's
 * identityStatement/positioningStatement/themes/differentiators as well as a future 0.2's
 * essence/positioning/pillars/narrative, since it just unions whatever keys each record happens to carry).
 */
export function compareValueFields(previous: Record<string, unknown> | null, latest: Record<string, unknown> | null): FieldDiff[] {
  const keys = new Set<string>([...Object.keys(previous ?? {}), ...Object.keys(latest ?? {})]);
  const out: FieldDiff[] = [];
  for (const field of [...keys].sort()) {
    if (COMPARISON_METADATA_FIELDS.includes(field)) continue;
    const p = describeJsonValue(previous?.[field]);
    const l = describeJsonValue(latest?.[field]);
    out.push({ field, previous: p, latest: l, changed: p !== l });
  }
  return out;
}

// ─── basis resolution rows (validation section) ────────────────────────────────

export interface BasisResolution { refKey: string; kind: string; tier: string; text: string; source: string }

// ─── markdown rendering ─────────────────────────────────────────────────────────

export interface RunSummary {
  id: string; queryId: string | null; domain: string; status: string;
  calls: number; signalCalls: number | null; otherCalls: number | null;
  estimatedCostUsd: string | null; confidenceOut: string | null;
  startedAt: string; finishedAt: string | null;
}

export interface AthleteMediaItem {
  kind: string; title: string | null; outlet: string | null; outletType: string | null;
  medium: string | null; participation: string | null; date: string | null; url: string | null;
  athleteQuoted: boolean | null;
}

export interface SignatureMoment { event: string | null; date: string | null; competition: string | null }

export interface ResearchDiscovery {
  workflowRunId: string | null;
  runs: RunSummary[];
  athleteMedia: AthleteMediaItem[];
  signatureMoments: SignatureMoment[];
  narrativeTopics: Record<string, number>;
  sourceTypeDistribution: Record<string, number>;
}

export interface ReadSourceSummary {
  url: string | null; mode: string | null; completed: boolean | null; refused: boolean | null;
  claims: number | null; statements: number | null; paraphrases: number | null; dropped: string | null;
}

export interface PayloadSummary { id: string; provider: string; model: string | null; endpointFamily: string; bytes: number | null; fetchedAt: string; payloadHash: string }

export interface AthleteStatementItem { text: string; topics: string[]; medium: string | null; timestampSeconds: number | null; outlet: string | null; sourceTitle: string | null }

export interface TargetedRead {
  readRun: RunSummary | null;
  readSpec: string | null;
  sources: ReadSourceSummary[];
  payloads: PayloadSummary[];
  athleteStatements: AthleteStatementItem[];
  otherEvidenceByKind: Record<string, { count: number; samples: string[] }>;
}

export interface FirstLookPlatform { platform: string; computedAt: string | null; themes: string[]; tone: string[]; interests: string[]; recurringPhrases: string[]; causesMentioned: string[] }
export interface BioRow { platform: string | null; text: string; sourceClass: string; asOf: string }
export interface FirstLookSection { platforms: FirstLookPlatform[]; bios: BioRow[] }

export interface LedgerRowSummary {
  id: string; contract: string | null; createdAt: string;
  envelopeCounts: Record<string, Record<string, number>>;
  claimTierCounts: Record<string, number>;
  citedKinds: string[];
}

export interface ComparisonResult {
  fields: FieldDiff[];
  citedCounts: { latest: Record<string, Record<string, number>>; previous: Record<string, Record<string, number>> };
  newlyUsedKinds: string[];
  droppedKinds: string[];
}

export interface IdentityRunReport {
  athleteId: string;
  generatedAt: string;
  research: ResearchDiscovery | null;
  targetedRead: TargetedRead | null;
  firstLook: FirstLookSection;
  identityIntelligence: {
    latest: LedgerRowSummary | null;
    previous: LedgerRowSummary | null;
    comparison: ComparisonResult | null;
    rawValue: unknown | null;
  };
  validation: BasisResolution[];
}

const none = (v: unknown) => (v === null || v === undefined || v === "" ? "none" : String(v));
const kindTierTable = (counts: Record<string, Record<string, number>>): string[] => {
  const kinds = Object.keys(counts).sort();
  if (!kinds.length) return ["  none"];
  const lines: string[] = [];
  for (const k of kinds) {
    const tiers = counts[k];
    const parts = Object.keys(tiers).sort().map((t) => `${t}=${tiers[t]}`).join(", ");
    lines.push(`  - ${k}: ${parts}`);
  }
  return lines;
};

/** Render the full report as readable Markdown. Pure: takes the already-resolved report object. */
export function renderMarkdownReport(report: IdentityRunReport): string {
  const L: string[] = [];
  const h = (s: string) => L.push(s, "");
  h(`# Identity run report — athlete ${report.athleteId}`);
  L.push(`Generated: ${report.generatedAt}`, "");

  // 1. Research discovery
  h("## 1. Research discovery (latest workflow run)");
  const r = report.research;
  if (!r) {
    L.push("No research_runs found for this athlete.", "");
  } else {
    L.push(`Workflow run: ${none(r.workflowRunId)}`, "");
    L.push("### Query runs", "", "| query | domain | status | calls | signal | other | cost (USD) | confidence | started | finished |", "|---|---|---|---:|---:|---:|---:|---:|---|---|");
    for (const run of r.runs) {
      L.push(`| ${none(run.queryId)} | ${run.domain} | ${run.status} | ${run.calls} | ${none(run.signalCalls)} | ${none(run.otherCalls)} | ${none(run.estimatedCostUsd)} | ${none(run.confidenceOut)} | ${run.startedAt} | ${none(run.finishedAt)} |`);
    }
    if (!r.runs.length) L.push("(none)");
    L.push("");
    L.push(`### athlete_media (press_mention / crossover_appearance) — ${r.athleteMedia.length} item(s)`, "");
    if (!r.athleteMedia.length) L.push("none", "");
    else {
      for (const m of r.athleteMedia) L.push(`- [${m.kind}] "${none(m.title)}" — ${none(m.outlet)} (${none(m.outletType)}), medium=${none(m.medium)}, participation=${none(m.participation)}, date=${none(m.date)}, quoted=${m.athleteQuoted ? "yes" : "no"}${m.url ? ` — ${m.url}` : ""}`);
      L.push("");
    }
    h(`### signature_moments — ${r.signatureMoments.length} item(s)`);
    if (!r.signatureMoments.length) L.push("none", "");
    else { for (const s of r.signatureMoments) L.push(`- ${none(s.event)} (${none(s.date)}${s.competition ? `, ${s.competition}` : ""})`); L.push(""); }
    h("### narrative_claim topics");
    const topics = Object.keys(r.narrativeTopics).sort();
    if (!topics.length) L.push("none", "");
    else { for (const t of topics) L.push(`- ${t}: ${r.narrativeTopics[t]}`); L.push(""); }
    h("### outlet source_type distribution");
    const types = Object.keys(r.sourceTypeDistribution).sort();
    if (!types.length) L.push("none", "");
    else { for (const t of types) L.push(`- ${t}: ${r.sourceTypeDistribution[t]}`); L.push(""); }
  }

  // 2. Targeted read
  h("## 2. Targeted read (READ step)");
  const tr = report.targetedRead;
  if (!tr || !tr.readRun) {
    L.push("No READ run found for this workflow run.", "");
  } else {
    const run = tr.readRun;
    L.push(`READ run: status=${run.status}, calls=${run.calls}, started=${run.startedAt}, finished=${none(run.finishedAt)}, readSpec=${none(tr.readSpec)}`, "");
    h(`### Sources read — ${tr.sources.length}`);
    if (!tr.sources.length) L.push("none", "");
    else {
      L.push("| url | mode | completed | claims | statements | paraphrases | dropped |", "|---|---|---|---:|---:|---:|---|");
      for (const s of tr.sources) L.push(`| ${none(s.url)} | ${none(s.mode)} | ${s.completed ? "yes" : s.refused ? "refused" : "no"} | ${none(s.claims)} | ${none(s.statements)} | ${none(s.paraphrases)} | ${none(s.dropped)} |`);
      L.push("");
    }
    h(`### Source payloads — ${tr.payloads.length}`);
    if (!tr.payloads.length) L.push("none", "");
    else { for (const p of tr.payloads) L.push(`- ${p.provider}${p.model ? `/${p.model}` : ""} (${p.endpointFamily}) — ${none(p.bytes)} bytes, fetched ${p.fetchedAt}, hash ${p.payloadHash.slice(0, 12)}…`); L.push(""); }
    h(`### athlete_statement rows — ${tr.athleteStatements.length}`);
    if (!tr.athleteStatements.length) L.push("none", "");
    else {
      for (const s of tr.athleteStatements) L.push(`- "${s.text}" — topics=[${s.topics.join(", ")}], medium=${none(s.medium)}, outlet=${none(s.outlet)}, source="${none(s.sourceTitle)}"${s.timestampSeconds != null ? `, t=${s.timestampSeconds}s` : ""}`);
      L.push("");
    }
    h("### Other source_read evidence by kind");
    const kinds = Object.keys(tr.otherEvidenceByKind).sort();
    if (!kinds.length) L.push("none", "");
    else {
      for (const k of kinds) {
        const v = tr.otherEvidenceByKind[k];
        L.push(`- ${k}: ${v.count} (e.g. ${v.samples.slice(0, 2).map((s) => `"${s}"`).join("; ") || "—"})`);
      }
      L.push("");
    }
  }

  // 3. First Look + bios
  h("## 3. First Look (latest per platform) and social bios");
  const fl = report.firstLook;
  if (!fl.platforms.length) L.push("No First Look snapshot found.", "");
  else {
    for (const p of fl.platforms) {
      L.push(`### ${p.platform} (computed ${none(p.computedAt)})`, "");
      L.push(`- themes: ${p.themes.join(", ") || "none"}`);
      L.push(`- tone: ${p.tone.join(", ") || "none"}`);
      L.push(`- interests: ${p.interests.join(", ") || "none"}`);
      L.push(`- recurring phrases: ${p.recurringPhrases.join(", ") || "none"}`);
      L.push(`- causes mentioned: ${p.causesMentioned.join(", ") || "none"}`, "");
    }
  }
  h("### profile.bio (social_features)");
  if (!fl.bios.length) L.push("none", "");
  else { for (const b of fl.bios) L.push(`- ${none(b.platform)} (${b.sourceClass}, as of ${b.asOf}): "${b.text}"`); L.push(""); }

  // 4. Latest identity_intelligence ledger row
  h("## 4. Latest identity_intelligence ledger row");
  const ii = report.identityIntelligence;
  if (!ii.latest) L.push("No identity_intelligence ledger row found for this athlete.", "");
  else {
    const latest = ii.latest;
    L.push(`id=${latest.id}, contract=${none(latest.contract)}, created=${latest.createdAt}`, "");
    h("### Envelope — counts by kind/tier");
    L.push(...kindTierTable(latest.envelopeCounts), "");
    h("### Claims — counts by tier");
    const tiers = Object.keys(latest.claimTierCounts).sort();
    if (!tiers.length) L.push("none", "");
    else { for (const t of tiers) L.push(`- ${t}: ${latest.claimTierCounts[t]}`); L.push(""); }
  }

  // 5. Raw value JSON
  h("## 5. Raw value JSON (latest row)");
  if (ii.rawValue == null) L.push("none", "");
  else L.push("```json", JSON.stringify(ii.rawValue, null, 2), "```", "");

  // 6. Validation / provenance
  h("## 6. Validation — every basis ref resolved to text, tier and source");
  if (!report.validation.length) L.push("none", "");
  else {
    L.push("| ref | kind | tier | text | source |", "|---|---|---|---|---|");
    for (const v of report.validation) L.push(`| ${v.refKey} | ${v.kind} | ${v.tier} | ${cap(v.text, 120).replace(/\|/g, "\\|")} | ${cap(v.source, 80).replace(/\|/g, "\\|")} |`);
    L.push("");
  }

  // 7. Comparison with previous ledger row
  h("## 7. Comparison with the previous identity_intelligence row");
  if (!ii.previous) L.push("No previous ledger row — this is the first recompute on record.", "");
  else if (!ii.comparison) L.push("Previous row present but comparison could not be computed.", "");
  else {
    L.push(`previous: id=${ii.previous.id}, contract=${none(ii.previous.contract)}, created=${ii.previous.createdAt}`);
    L.push(`latest:   id=${ii.latest?.id}, contract=${none(ii.latest?.contract)}, created=${ii.latest?.createdAt}`, "");
    h("### Field-by-field");
    L.push("| field | previous | latest | changed |", "|---|---|---|---|");
    for (const f of ii.comparison.fields) L.push(`| ${f.field} | ${cap(f.previous, 150).replace(/\|/g, "\\|")} | ${cap(f.latest, 150).replace(/\|/g, "\\|")} | ${f.changed ? "yes" : "no"} |`);
    L.push("");
    h("### Cited bases — counts by kind/tier");
    L.push("previous:");
    L.push(...kindTierTable(ii.comparison.citedCounts.previous));
    L.push("latest:");
    L.push(...kindTierTable(ii.comparison.citedCounts.latest));
    L.push("");
    h("### Newly used / dropped basis kinds");
    L.push(`- newly used: ${ii.comparison.newlyUsedKinds.join(", ") || "none"}`);
    L.push(`- dropped: ${ii.comparison.droppedKinds.join(", ") || "none"}`, "");
  }

  return L.join("\n");
}
