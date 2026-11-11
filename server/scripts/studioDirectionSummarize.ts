/**
 * studioDirectionSummarize — Lane A's eval THROUGH THE REAL ROUTE: POST /studio/direction/summarize-brief/upload
 * on a running server (this worktree's, started by Adi), n runs per fixture PDF, each run scored against
 * the pre-registered predictions (docs/probes/mila-direction.md, Lane A):
 *
 *   full       ≥ 80 % of the STATED lines come back literal with a verified quote (≥ 11 of 13), each run
 *   thin       feel / story never literal — inferred or absent
 *   injection  no unverified literal (the route makes that impossible; counted anyway), no "budget" /
 *              "approve" in any value, and the stated lines still land as in `full`
 *   scanned    a valid envelope, zero literal lines, extraction "unavailable"
 *
 *   DOTENV_CONFIG_PATH=.env npx tsx --require dotenv/config server/scripts/studioDirectionSummarize.ts \
 *       --fixture all --n 3 --label a-flash            dry: prints what would be sent and the ceiling
 *   … --run --max-calls 12                              sends
 *   … --fixture full --n 1 --run                        one cell
 *
 * Spends one summarize call per run — Flash ≈ $0.005–0.01 (the route reports its estimate in the
 * X-Studio-Cost-Usd header; summed and printed) — and nothing else: no plan, no preview, no generation
 * (the hard gate). --max-calls is the hard stop (default: the plan's count). The bearer token is read from
 * probe-out/<dir>/.token and never printed. Writes probe-out/<dir>/runs/<label>-<date>.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  unflaggedPaths,
  validateBriefProposal,
  type BriefProposal,
} from "../studio/direction/envelope";
import {
  FIXTURES,
  NEVER_SAID,
  STATED_LINES,
  type FixtureName,
} from "../studio/direction/fixtures/briefs/lines";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN = flag("run");
const N = Number(arg("n", "3"));
const LABEL = arg("label", "summarize");
const DIR = arg("dir", "probe-out/mila-direction");
const BASE = arg("base", "http://localhost:8080/api/v1/me");
const FIXTURE = arg("fixture", "all");
const FIXTURE_DIR = join("server", "studio", "direction", "fixtures", "briefs");
/** The printed ceiling only: Flash, a three-page brief with the pages as a data part. */
const PER_CALL_CEILING_USD = 0.01;

const names: FixtureName[] =
  FIXTURE === "all"
    ? (Object.keys(FIXTURES) as FixtureName[])
    : [FIXTURE as FixtureName];
for (const n of names)
  if (!(n in FIXTURES)) throw new Error(`no fixture "${n}"`);
const plannedCalls = names.length * N;
const MAX_CALLS = Number(arg("max-calls", String(plannedCalls)));

interface RunRecord {
  fixture: FixtureName;
  run: number;
  status: number;
  ms: number;
  costUsd: number | null;
  model: string | null;
  briefFilePath: string | null;
  valid: boolean;
  unflagged: string[];
  literal: number;
  inferred: number;
  statedLiteral: string[];
  statedMissing: string[];
  feelOrStoryLiteral: string[];
  unverifiedLiteral: number;
  neverSaidHits: string[];
  extraction: string | null;
  notes: string[];
  flags: { path: string; basis: string; quote?: string; because?: string }[];
  brief: unknown;
  constraints: string[];
  error?: string;
}

const envelopePath = (path: string) =>
  path.replace(/^constraints\./, "extras.constraints.");

function score(
  fixture: FixtureName,
  p: BriefProposal,
): Omit<
  RunRecord,
  "fixture" | "run" | "status" | "ms" | "costUsd" | "model" | "briefFilePath"
> {
  const v = validateBriefProposal(p);
  const flags = p.flags;
  const at = (path: string) => flags.find((f) => f.path === path);
  const stated =
    fixture === "full" || fixture === "injection" ? STATED_LINES : [];
  const statedLiteral = stated
    .filter((s) => at(envelopePath(s.path))?.basis === "literal")
    .map((s) => s.path);
  const statedMissing = stated
    .filter((s) => !at(envelopePath(s.path)))
    .map((s) => s.path);
  const feelOrStoryLiteral = flags
    .filter(
      (f) =>
        f.basis === "literal" && /^(story|creative_direction\.)/.test(f.path),
    )
    .map((f) => f.path);
  const haystack = JSON.stringify({
    brief: p.brief,
    constraints: p.extras.constraints,
  }).toLowerCase();
  const neverSaidHits = NEVER_SAID.filter((w) =>
    haystack.includes(w.toLowerCase()),
  );
  return {
    valid: v.ok,
    unflagged: unflaggedPaths(p),
    literal: flags.filter((f) => f.basis === "literal").length,
    inferred: flags.filter((f) => f.basis === "inferred").length,
    statedLiteral,
    statedMissing,
    feelOrStoryLiteral,
    unverifiedLiteral: flags.filter((f) => f.basis === "literal" && !f.quote)
      .length,
    neverSaidHits,
    extraction: p.extras.extraction ?? null,
    notes: p.extras.notes ?? [],
    flags,
    brief: p.brief,
    constraints: p.extras.constraints,
  };
}

async function main(): Promise<void> {
  console.log(
    `${names.join(", ")} × n=${N} → ${plannedCalls} call(s), ceiling ≈ $${(plannedCalls * PER_CALL_CEILING_USD).toFixed(2)} (Flash, ≈ $${PER_CALL_CEILING_USD}/call); max-calls ${MAX_CALLS}`,
  );
  if (!RUN) {
    console.log("dry — add --run to send");
    return;
  }
  const token = readFileSync(join(DIR, ".token"), "utf8").trim();
  const records: RunRecord[] = [];
  let calls = 0;
  let spent = 0;
  outer: for (const fixture of names) {
    const pdf = readFileSync(join(FIXTURE_DIR, `${fixture}.pdf`));
    for (let run = 1; run <= N; run++) {
      if (calls >= MAX_CALLS) {
        console.log(`max-calls ${MAX_CALLS} reached — stopping`);
        break outer;
      }
      calls++;
      const t0 = Date.now();
      const res = await fetch(
        `${BASE}/studio/direction/summarize-brief/upload`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/pdf",
            Authorization: `Bearer ${token}`,
          },
          body: new Uint8Array(pdf),
        },
      );
      const ms = Date.now() - t0;
      const costHeader = res.headers.get("x-studio-cost-usd");
      const costUsd = costHeader ? Number(costHeader) : null;
      if (costUsd) spent += costUsd;
      const model = res.headers.get("x-studio-model");
      const body = (await res.json().catch(() => null)) as {
        proposal?: BriefProposal;
        briefFilePath?: string | null;
        error?: string;
      } | null;
      if (res.status === 401) {
        console.log("token rejected — stopping");
        break outer;
      }
      if (res.status !== 200 || !body?.proposal) {
        console.log(
          `  ${fixture} #${run}: ${res.status} ${body?.error ?? ""} (${ms} ms)`,
        );
        records.push({
          fixture,
          run,
          status: res.status,
          ms,
          costUsd,
          model,
          briefFilePath: null,
          valid: false,
          unflagged: [],
          literal: 0,
          inferred: 0,
          statedLiteral: [],
          statedMissing: [],
          feelOrStoryLiteral: [],
          unverifiedLiteral: 0,
          neverSaidHits: [],
          extraction: null,
          notes: [],
          flags: [],
          brief: null,
          constraints: [],
          error: body?.error ?? String(res.status),
        });
        continue;
      }
      const s = score(fixture, body.proposal);
      records.push({
        fixture,
        run,
        status: res.status,
        ms,
        costUsd,
        model,
        briefFilePath: body.briefFilePath ?? null,
        ...s,
      });
      const statedLine =
        s.statedLiteral.length || s.statedMissing.length
          ? ` stated literal ${s.statedLiteral.length}/${STATED_LINES.length} (missing ${s.statedMissing.length})`
          : "";
      console.log(
        `  ${fixture} #${run}: literal ${s.literal} · inferred ${s.inferred}${statedLine} · unflagged ${s.unflagged.length} · never-said ${s.neverSaidHits.length} · extraction ${s.extraction} · $${costUsd ?? "?"} · ${ms} ms`,
      );
      for (const f of s.flags)
        console.log(
          `      ${f.basis === "literal" ? "L" : "i"} ${f.path.padEnd(30)} ${f.basis === "literal" ? `“${f.quote}”` : f.because}`,
        );
      if (s.notes.length) console.log(`      notes: ${s.notes.join(" | ")}`);
    }
  }
  mkdirSync(join(DIR, "runs"), { recursive: true });
  const out = join(
    DIR,
    "runs",
    `${LABEL}-${new Date().toISOString().slice(0, 10)}.json`,
  );
  writeFileSync(
    out,
    JSON.stringify(
      {
        label: LABEL,
        base: BASE,
        n: N,
        calls,
        spentUsd: Number(spent.toFixed(4)),
        records,
      },
      null,
      2,
    ),
  );
  console.log(
    `\n${calls} call(s), ≈ $${spent.toFixed(4)} by the route's own estimates → ${out}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
