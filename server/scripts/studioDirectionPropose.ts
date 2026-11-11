/**
 * studioDirectionPropose — Lane B's eval THROUGH THE REAL ROUTE: POST /studio/direction/propose-campaign
 * on a running server (this worktree's, started by Adi), n runs per cell, each scored against the
 * pre-registered predictions (docs/probes/mila-direction.md, Lane B):
 *
 *   grow-following, no brand   3 proposals; every pairwise line overlap < 0.5 (the 6c measure,
 *                              studio/direction/measure.ts); feel present and inferred on every proposal;
 *                              product null; 0 claim-lexicon hits (the route drops them — counted here too)
 *   --prior <file>             Lane S: a moment brief's lines as prior context → ≥ 1 proposal whose
 *                              concept's because names the source
 *
 *   DOTENV_CONFIG_PATH=.env npx tsx --require dotenv/config server/scripts/studioDirectionPropose.ts \
 *       --objective grow-following --n 3 --label b-pro                dry: prints what would be sent
 *   … --run                                                             sends
 *   … --brand "Harbor Hydration" --occasion "the derby week" --run
 *   … --prior probe-out/mila-direction/moment.json --label s-stack --run
 *
 * Spends one Pro call per run (≈ $0.05–0.09; the route's estimate rides the X-Studio-Cost-Usd header) and
 * the planner's own library searches (≤ 4 embeddings, unpriced) — no plan, no preview, no generation
 * (the hard gate). The bearer token is read from probe-out/<dir>/.token and never printed. Writes
 * probe-out/<dir>/runs/<label>-<date>.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  unflaggedPaths,
  validateBriefProposal,
  type BriefProposal,
} from "../studio/direction/envelope";
import { jaccard } from "../studio/direction/measure";
import { claimHits } from "../studio/direction/propose";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN = flag("run");
const N = Number(arg("n", "3"));
const LABEL = arg("label", "propose");
const DIR = arg("dir", "probe-out/mila-direction");
const BASE = arg("base", "http://localhost:8080/api/v1/me");
const OBJECTIVE = arg("objective", "grow-following");
const BRAND = arg("brand", "");
const OCCASION = arg("occasion", "");
const PRIOR_FILE = arg("prior", "");
const MAX_CALLS = Number(arg("max-calls", String(N)));
const PER_CALL_CEILING_USD = 0.09;

const body: Record<string, unknown> = { objective: OBJECTIVE };
if (BRAND) body.brand = BRAND;
if (OCCASION) body.occasion = OCCASION;
if (PRIOR_FILE)
  body.priorContext = JSON.parse(readFileSync(PRIOR_FILE, "utf8"));

interface RunRecord {
  run: number;
  status: number;
  ms: number;
  costUsd: number | null;
  model: string | null;
  count: number;
  valid: boolean;
  unflagged: string[];
  overlaps: number[];
  maxOverlap: number;
  feelPresent: number;
  feelInferred: number;
  productNull: number;
  claimHits: string[];
  onPrior: number;
  proposals: {
    concept: unknown;
    brief: unknown;
    flags: unknown;
    notes?: string[];
  }[];
  notes: string[];
  error?: string;
}

const inputsText = [
  OBJECTIVE,
  BRAND,
  OCCASION,
  ...((body.priorContext as { lines?: string[] } | undefined)?.lines ?? []),
].join(" ");

function score(proposals: BriefProposal[]) {
  const lines = proposals.map((p) => p.extras.concept?.line ?? "");
  const overlaps: number[] = [];
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++)
      overlaps.push(Number(jaccard(lines[i], lines[j]).toFixed(2)));
  const claims = proposals.flatMap((p) =>
    claimHits(
      [
        p.extras.concept?.angle,
        p.extras.concept?.line,
        p.brief.story,
        p.brief.product?.line,
        ...p.brief.creative_direction.tone,
        p.brief.creative_direction.energy,
      ]
        .filter(Boolean)
        .join(" "),
      inputsText,
    ),
  );
  return {
    count: proposals.length,
    valid: proposals.every((p) => validateBriefProposal(p).ok),
    unflagged: proposals.flatMap((p) => unflaggedPaths(p)),
    overlaps,
    maxOverlap: overlaps.length ? Math.max(...overlaps) : 0,
    feelPresent: proposals.filter(
      (p) =>
        p.brief.creative_direction.tone.length > 0 ||
        p.brief.creative_direction.energy,
    ).length,
    feelInferred: proposals.filter((p) =>
      p.flags.some(
        (f) =>
          f.path.startsWith("creative_direction.") && f.basis === "inferred",
      ),
    ).length,
    productNull: proposals.filter((p) => p.brief.product === null).length,
    claimHits: claims,
    onPrior: proposals.filter((p) =>
      (
        p.flags.find((f) => f.path === "extras.concept")?.because ?? ""
      ).startsWith("from "),
    ).length,
  };
}

async function main(): Promise<void> {
  console.log(
    `propose-campaign ${JSON.stringify(body)} × n=${N} → ${N} call(s), ceiling ≈ $${(N * PER_CALL_CEILING_USD).toFixed(2)} (Pro, ≈ $${PER_CALL_CEILING_USD}/call); max-calls ${MAX_CALLS}`,
  );
  if (!RUN) {
    console.log("dry — add --run to send");
    return;
  }
  const token = readFileSync(join(DIR, ".token"), "utf8").trim();
  const records: RunRecord[] = [];
  let calls = 0;
  let spent = 0;
  for (let run = 1; run <= N && calls < MAX_CALLS; run++) {
    calls++;
    const t0 = Date.now();
    const res = await fetch(`${BASE}/studio/direction/propose-campaign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - t0;
    const costHeader = res.headers.get("x-studio-cost-usd");
    const costUsd = costHeader ? Number(costHeader) : null;
    if (costUsd) spent += costUsd;
    const model = res.headers.get("x-studio-model");
    const answer = (await res.json().catch(() => null)) as {
      proposals?: BriefProposal[];
      notes?: string[];
      error?: string;
    } | null;
    if (res.status === 401) {
      console.log("token rejected — stopping");
      break;
    }
    if (res.status !== 200 || !answer?.proposals) {
      console.log(`  #${run}: ${res.status} ${answer?.error ?? ""} (${ms} ms)`);
      records.push({
        run,
        status: res.status,
        ms,
        costUsd,
        model,
        count: 0,
        valid: false,
        unflagged: [],
        overlaps: [],
        maxOverlap: 0,
        feelPresent: 0,
        feelInferred: 0,
        productNull: 0,
        claimHits: [],
        onPrior: 0,
        proposals: [],
        notes: [],
        error: answer?.error ?? String(res.status),
      });
      continue;
    }
    const s = score(answer.proposals);
    records.push({
      run,
      status: res.status,
      ms,
      costUsd,
      model,
      ...s,
      proposals: answer.proposals.map((p) => ({
        concept: p.extras.concept,
        brief: p.brief,
        flags: p.flags,
        notes: p.extras.notes,
      })),
      notes: answer.notes ?? [],
    });
    console.log(
      `  #${run}: ${s.count} proposals · overlaps ${s.overlaps.join("/")} (max ${s.maxOverlap}) · feel ${s.feelPresent}/${s.count} present, ${s.feelInferred}/${s.count} inferred · product null ${s.productNull}/${s.count} · claims ${s.claimHits.length} · on prior ${s.onPrior} · unflagged ${s.unflagged.length} · valid ${s.valid} · $${costUsd ?? "?"} · ${ms} ms`,
    );
    answer.proposals.forEach((p, i) => {
      const c = p.extras.concept;
      const because =
        p.flags.find((f) => f.path === "extras.concept")?.because ?? "";
      console.log(
        `      ${String.fromCharCode(65 + i)} · ${c?.angle} · ${c?.feeling}\n        ${c?.line}\n        because: ${because}`,
      );
    });
    if (answer.notes?.length)
      console.log(`      notes: ${answer.notes.join(" | ")}`);
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
        body,
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
