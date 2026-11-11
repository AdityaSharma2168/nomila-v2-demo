/**
 * reprocessDirectLineage.ts — DEV-ONLY CLI: re-derive direct-research lineage for already-stored Gemini findings,
 * with NO provider call, using the tightened bindGeminiFinding binder (quote/statement precedence + normalization,
 * spec/directLineage.ts, slice E). Every athlete it touches gets a NEW research_runs row (`trigger: "backfill"`) so
 * the resolver re-runs on the recovered evidence; the old run's research_evidence rows are marked superseded.
 *
 *   npx tsx --require dotenv/config server/scripts/calibration/reprocessDirectLineage.ts                       # dry run: report only, no writes
 *   npx tsx --require dotenv/config server/scripts/calibration/reprocessDirectLineage.ts --run                 # writes: every eligible athlete
 *   npx tsx --require dotenv/config server/scripts/calibration/reprocessDirectLineage.ts --run --keys <uuid>,<uuid>
 *
 * Eligible (default, no --keys): every athlete whose MOST RECENT research run has `providers[0].provider ===
 * "gemini_direct"` with status ok/partial and trigger !== "backfill" (research_runs.providers jsonb).
 * Refuses any database but dev (server/lib/devDatabaseGuard.ts). Writing additionally requires RESEARCH_SUBSTRATE_WRITE=true in the
 * environment (persist's own gate) — `--run` alone is not enough, matching runDirectResearch.ts's convention.
 * A JSON report is written to server/scripts/calibration/runs/reprocess-lineage-<date>.json (gitignored).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../../db";
import { assertDevDatabase } from "../../lib/devDatabaseGuard";
import { findEligibleAthleteIds, reprocessAthleteLineage, type ReprocessAthleteResult } from "../../services/intelligence/research/reprocessLineage";

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  return { run: a.includes("--run"), keys: (get("--keys") ?? "").split(",").map((s) => s.trim()).filter(Boolean), asOf: get("--as-of") };
}

function sumCounts(results: ReprocessAthleteResult[]) {
  const zero = () => ({ native_supported: 0, asserted_only: 0, native_retrieved: 0, other: 0 });
  const before = zero(), after = zero();
  for (const r of results) for (const k of Object.keys(before) as Array<keyof typeof before>) { before[k] += r.before[k]; after[k] += r.after[k]; }
  return { before, after };
}

async function main() {
  await assertDevDatabase(pool);   // dev only: the connected database must be dev, before any write
  const o = args();
  const asOf = o.asOf ? new Date(`${o.asOf}T00:00:00.000Z`) : new Date();

  if (o.run && process.env.RESEARCH_SUBSTRATE_WRITE !== "true") throw new Error("refusing: --run given but RESEARCH_SUBSTRATE_WRITE is not \"true\" (persist would write nothing)");

  const athleteIds = o.keys.length ? o.keys : await findEligibleAthleteIds();
  console.log(`reprocess-direct-lineage · ${REPROCESS_VERSION} · ${athleteIds.length} athlete(s)${o.keys.length ? " (--keys)" : " (default: eligible gemini_direct runs)"} · ${o.run ? "WRITING" : "dry run — add --run to write"}`);
  if (!athleteIds.length) { console.log("nothing to do"); return; }

  const results: ReprocessAthleteResult[] = [];
  for (const athleteId of athleteIds) {
    const r = await reprocessAthleteLineage(athleteId, { dryRun: !o.run, asOf });
    results.push(r);
    if (r.status === "skipped") { console.log(`  ${athleteId}: skipped — ${r.reason}`); continue; }
    console.log(`  ${athleteId}: ${r.status} · old ${r.oldRunId} → new ${r.newRunId ?? "(none)"}`);
    console.log(`    lineage before ${JSON.stringify(r.before)} → after ${JSON.stringify(r.after)}`);
    console.log(`    binding methods ${JSON.stringify(r.bindingMethodHistogram)} · legacy-kept ${r.legacyKeptCount} · ambiguous ${r.ambiguousBindings}`);
    console.log(`    facts before ${r.factsBefore} → after ${r.factsAfter} · superseded evidence ${r.supersededCount} · unmatched ${r.unmatchedCount}`);
  }

  const totals = sumCounts(results);
  const reprocessed = results.filter((r) => r.status === "reprocessed").length;
  const skippedN = results.filter((r) => r.status === "skipped").length;
  console.log(`\ntotal: ${reprocessed} reprocessed, ${skippedN} skipped, ${results.length - reprocessed - skippedN} dry-run-only`);
  console.log(`total lineage: before ${JSON.stringify(totals.before)} → after ${JSON.stringify(totals.after)}`);

  const dir = join(__dirname, "runs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = join(dir, `reprocess-lineage-${date}.json`);
  writeFileSync(reportPath, JSON.stringify({ version: REPROCESS_VERSION, ranAt: new Date().toISOString(), run: o.run, asOf: asOf.toISOString(), totals, results }, null, 2));
  console.log(`report written to ${reportPath}`);
}

const REPROCESS_VERSION = "lineage-recovery/1";

main().then(() => pool.end()).catch((err) => { console.error(err?.message ?? err); pool.end().finally(() => process.exit(1)); });
