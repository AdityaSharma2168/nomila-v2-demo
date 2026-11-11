/**
 * studioQaAcceptance — PR Q's acceptance. Run the whole stage over the labeled corpus and score it.
 *
 *   npx tsx --require dotenv/config server/scripts/studioQaAcceptance.ts             # plan + cost
 *   npx tsx --require dotenv/config server/scripts/studioQaAcceptance.ts --run
 *   npx tsx --require dotenv/config server/scripts/studioQaAcceptance.ts --run --only 1.5a,3.1
 *   npx tsx --require dotenv/config server/scripts/studioQaAcceptance.ts --report    # saved run, free
 *
 * Reads images off disk and touches no database: `qa/inspect.ts` is the DB-backed entry point, and
 * this deliberately does not use it. The corpus rows are not all database rows — nine probe cells
 * and eight Q5 cells never had `derived_from_asset_id` at all — and a scorer that could only see
 * the ones with lineage would silently drop the invented-swoosh anchors.
 *
 * ─── ⚠️  SCORING RULE: `expect` MAY BE WRONG, AND THE IMAGE DECIDES ────────────────────────────
 *
 * `labeledSet.expect` is derived by me from Adi's written notes; his `verdict` is his. When a check
 * disagrees with an `expect`, the honest outcomes are (a) the check is wrong, or (b) the label is.
 * Commit 1 already hit case (b) once: 2.4a was marked an identity failure and the head-region pixel
 * difference is exactly 0.000, so the entry changed and the threshold did not.
 *
 * So this script REPORTS disagreements; it does not resolve them, and nothing here adjusts a
 * threshold to make a number come out. A check that cannot separate the corpus ships logging-only
 * with the miss written down — the brief's instruction, and the only defence against tuning until
 * six images are memorized.
 *
 * `expect: "unknown"` rows are EXCLUDED from that check's matrix rather than scored as passes.
 * Nobody assessed 4.1's hands; counting it as a true negative manufactures evidence.
 */
import { mkdir, readFile, writeFile } from "fs/promises";

import { FIXTURE_ROOT, loadOutput, loadSource } from "../studio/qa/corpus";
import {
  LABELED_SET,
  scorable,
  type LabeledOutput,
} from "../studio/qa/labeledSet";
import {
  runCreativeQa,
  summarize,
  type CreativeQaVerdict,
} from "../studio/qa/verdict";
import type { CheckStatus, ComparisonPair } from "../studio/qa/types";

const RUN = process.argv.includes("--run");
const REPORT = process.argv.includes("--report");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].split(",") : null;
})();
const OUT = `${FIXTURE_ROOT}/acceptance.json`;

type CheckName = "identity" | "marks" | "anatomy" | "adherence";
const CHECKS: CheckName[] = ["identity", "marks", "anatomy", "adherence"];
/** What `overall` summarizes. `marks` is recorded but advisory — see qa/verdict.ts GATING. */
const GATING_CHECKS: CheckName[] = ["identity", "anatomy", "adherence"];

/** The named criteria from the brief and the roadmap. These decide whether the PR is done. */
const MUST_FLAG_OR_FAIL: { cell: string; check: CheckName; why: string }[] = [
  { cell: "1.5a", check: "anatomy", why: "three hands" },
  {
    cell: "2.2",
    check: "adherence",
    why: "phantom success — the swoosh never appeared",
  },
  {
    cell: "3.1",
    check: "marks",
    why: "STANFORD wordmark and number destroyed",
  },
  { cell: "q5-p1-B-r1", check: "marks", why: "invented Nike swoosh" },
  {
    cell: "q5-p1-B-r2",
    check: "marks",
    why: "invented swoosh + invented adidas stripes",
  },
];

interface Row {
  cell: string;
  verdict: CreativeQaVerdict;
}

interface Report {
  at: string;
  rows: Row[];
  spendUsd: number;
}

async function pairFor(o: LabeledOutput): Promise<ComparisonPair | null> {
  if (!o.sourceId) return null;
  const [src, out] = await Promise.all([loadSource(o.sourceId), loadOutput(o)]);
  if (!src || !out) return null;
  return {
    sourceAssetId: o.sourceId,
    sourceBytes: src.bytes,
    sourceMimeType: src.mimeType,
    outputAssetId: o.outputId ?? o.outputFile ?? o.cell,
    outputBytes: out.bytes,
    outputMimeType: out.mimeType,
    // Every corpus row is ONE edit on ONE frame, so the row's source IS its chain root.
    chainDepth: 1,
    instruction: o.prompt,
  };
}

// ─── Scoring ────────────────────────────────────────────────────────────────────────────────────

/** A check "fired" when it said flag or fail. `unknown` is neither fired nor quiet — it is absent. */
const fired = (s: CheckStatus) => s === "flag" || s === "fail";

interface Matrix {
  tp: string[];
  fp: string[];
  tn: string[];
  fn: string[];
  unknown: string[];
}

function score(check: CheckName, rows: Row[]): Matrix {
  const m: Matrix = { tp: [], fp: [], tn: [], fn: [], unknown: [] };
  const byCell = new Map(rows.map((r) => [r.cell, r]));

  for (const o of scorable(LABELED_SET, check)) {
    const row = byCell.get(o.cell);
    if (!row) continue;
    const actual = row.verdict.checks[check].status;
    const shouldFire = o.expect[check] === "flag";

    if (actual === "unknown") m.unknown.push(o.cell);
    else if (shouldFire && fired(actual)) m.tp.push(o.cell);
    else if (shouldFire && !fired(actual)) m.fn.push(o.cell);
    else if (!shouldFire && fired(actual)) m.fp.push(o.cell);
    else m.tn.push(o.cell);
  }
  return m;
}

function printMatrix(check: CheckName, m: Matrix) {
  const n = m.tp.length + m.fp.length + m.tn.length + m.fn.length;
  console.log(
    `\n  ── ${check.toUpperCase()} ──  scored ${n}, unknown ${m.unknown.length}`,
  );
  console.log(
    `     true  positive ${String(m.tp.length).padStart(2)}  ${m.tp.join(" ")}`,
  );
  console.log(
    `     false negative ${String(m.fn.length).padStart(2)}  ${m.fn.join(" ")}${m.fn.length ? "   <-- MISSED" : ""}`,
  );
  console.log(
    `     false positive ${String(m.fp.length).padStart(2)}  ${m.fp.join(" ")}${m.fp.length ? "   <-- fired wrongly" : ""}`,
  );
  console.log(
    `     true  negative ${String(m.tn.length).padStart(2)}  ${m.tn.join(" ")}`,
  );
  if (m.unknown.length)
    console.log(`     could not answer   ${m.unknown.join(" ")}`);
}

function printAcceptance(rows: Row[]) {
  const byCell = new Map(rows.map((r) => [r.cell, r]));
  // Judged against the check that is supposed to catch each case, not against `overall`. `overall`
  // summarizes the GATING checks only, and `marks` is advisory by measurement (see qa/verdict.ts) —
  // so asking "did the overall move" would score the marks anchors against a summary that is
  // designed not to include them.
  console.log(
    `\n  ── ACCEPTANCE: each named failure must be caught by its own check ──`,
  );
  let allMet = true;
  for (const { cell, check, why } of MUST_FLAG_OR_FAIL) {
    const r = byCell.get(cell);
    if (!r) {
      console.log(`     ?  ${cell.padEnd(12)} not run`);
      allMet = false;
      continue;
    }
    const status = r.verdict.checks[check].status;
    const met = fired(status);
    if (!met) allMet = false;
    console.log(
      `     ${met ? "✓" : "✗"}  ${cell.padEnd(12)} ${check.padEnd(9)} ${status.padEnd(4)} — ${why}`,
    );
  }

  console.log(`\n  ── ACCEPTANCE: every Adi-verdicted CLEAN must pass ──`);
  const cleans = LABELED_SET.filter((o) => o.verdict === "CLEAN");
  const wrong: string[] = [];
  for (const o of cleans) {
    const r = byCell.get(o.cell);
    if (!r) continue;
    // A row Adi called CLEAN may still legitimately fire — 2.4b's mark was silently replaced,
    // q3-b mixes adidas with Nike — and `expect` records those. Judged on the GATING checks, for
    // the same reason the criteria above are: marks is advisory and its precision is known bad.
    const offenders = GATING_CHECKS.filter(
      (c) => o.expect[c] !== "flag" && fired(r.verdict.checks[c].status),
    );
    if (offenders.length) wrong.push(`${o.cell}(${offenders.join(",")})`);
  }
  console.log(
    wrong.length
      ? `     ✗  ${wrong.length} CLEAN row(s) did not pass: ${wrong.join(" ")}`
      : `     ✓  all ${cleans.length} CLEAN rows pass (or flag for a reason \`expect\` records)`,
  );
  return allMet && wrong.length === 0;
}

function printDisagreements(rows: Row[]) {
  const byCell = new Map(rows.map((r) => [r.cell, r]));
  const out: string[] = [];
  for (const o of LABELED_SET) {
    const r = byCell.get(o.cell);
    if (!r) continue;
    for (const c of CHECKS) {
      if (o.expect[c] === "unknown") continue;
      const actual = r.verdict.checks[c].status;
      if (actual === "unknown") continue;
      const shouldFire = o.expect[c] === "flag";
      if (shouldFire !== fired(actual))
        out.push(
          `     ${o.cell.padEnd(12)} ${c.padEnd(9)} expected ${o.expect[c].padEnd(4)} got ${actual.padEnd(4)}  "${r.verdict.checks[c].summary.slice(0, 90)}"`,
        );
    }
  }
  console.log(
    `\n  ── DISAGREEMENTS between a check and my derived \`expect\` ──`,
  );
  console.log(
    out.length
      ? out.join("\n") +
          `\n\n     Each is either a check that is wrong or a LABEL that is wrong. Decide by looking at\n     the image, and change whichever the picture says — never the threshold.`
      : "     none",
  );
}

function report(r: Report) {
  console.log(`\ncreative-QA acceptance — ${r.rows.length} rows, run ${r.at}`);
  for (const c of CHECKS) printMatrix(c, score(c, r.rows));
  const met = printAcceptance(r.rows);
  printDisagreements(r.rows);
  console.log(
    `\n  spend $${r.spendUsd.toFixed(4)} over ${r.rows.length} rows — $${(r.spendUsd / Math.max(1, r.rows.length)).toFixed(4)} per generation, against $0.1344 to generate one.`,
  );
  console.log(`\n  ACCEPTANCE ${met ? "MET" : "NOT MET"}\n`);
}

async function main() {
  if (REPORT) return report(JSON.parse(await readFile(OUT, "utf8")) as Report);

  const targets = LABELED_SET.filter(
    (o) => o.sourceId && (!ONLY || ONLY.includes(o.cell)),
  );

  console.log(`\ncreative-QA acceptance`);
  console.log(`  ${targets.length} labeled rows with a source frame on disk`);
  console.log(
    `  4 checks each; marks runs up to 5 vision calls, identity 2 + 2 embeddings`,
  );
  const est =
    targets.length *
    (8 * (1400 * (0.3 / 1e6) + 350 * (2.5 / 1e6)) + 2 * 0.0001);
  console.log(
    `\n  estimated spend: ~$${est.toFixed(3)}  (inspection only; no image is generated)`,
  );

  if (!RUN) {
    console.log(`\n  DRY RUN — nothing spent. Re-run with --run.\n`);
    return;
  }

  const rows: Row[] = [];
  let spendUsd = 0;
  for (const o of targets) {
    const pair = await pairFor(o);
    if (!pair) {
      console.log(
        `  ${o.cell.padEnd(12)} SKIPPED — image missing from the corpus`,
      );
      continue;
    }
    const verdict = await runCreativeQa(pair);
    spendUsd += verdict.spend.usd;
    rows.push({ cell: o.cell, verdict });
    console.log(`  ${o.cell.padEnd(12)} ${summarize(verdict)}`);
  }

  const out: Report = {
    at: new Date().toISOString(),
    rows,
    spendUsd: Number(spendUsd.toFixed(4)),
  };
  await mkdir(FIXTURE_ROOT, { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2));
  report(out);
  console.log(`  → ${OUT}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
