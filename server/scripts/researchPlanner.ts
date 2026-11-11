/**
 * researchPlanner.ts — run the Phase A Step 2b planner pass by hand (dev evidence).
 *
 *   npx tsx --require dotenv/config server/scripts/researchPlanner.ts                 dry-run (default): evaluates, writes ONLY a
 *                                                                                    research_planner_runs row, prints the proposed plan
 *   npx tsx --require dotenv/config server/scripts/researchPlanner.ts --athlete <id>  one athlete
 *   npx tsx --require dotenv/config server/scripts/researchPlanner.ts --as-of <iso>   evaluate as of a moment
 *   npx tsx --require dotenv/config server/scripts/researchPlanner.ts --apply         enqueue mode; REFUSES unless the execution gate
 *                                                                                    (RESEARCH_REFRESH_ENABLED && RESEARCH_SUBSTRATE_WRITE) is true
 */

import { researchPlannerExecutionEnabled } from "../services/intelligence/research/config";
import { runResearchPlanner } from "../services/intelligence/research/planner";
import { pool } from "../db";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply && !researchPlannerExecutionEnabled()) {
    console.error("refusing --apply: the execution gate is false (RESEARCH_REFRESH_ENABLED && RESEARCH_SUBSTRATE_WRITE must both be true)");
    process.exit(2);
  }
  const asOf = arg("--as-of") ? new Date(arg("--as-of")!) : new Date();
  const summary = await runResearchPlanner({ dryRun: !apply, asOf, athleteId: arg("--athlete") });
  const { plans, ...rest } = summary;
  console.log(JSON.stringify(rest, null, 2));
  console.log(`\nplans (${plans.length}):`);
  for (const p of plans as any[]) console.log(`  ${p.athleteId}  ${p.full ? "FULL" : p.domains.join(",")}  trigger=${p.trigger}  reserve=${p.reserveCalls}  est=$${p.estUsd}  ${p.workflowRunId ? `run=${p.workflowRunId}` : ""}`);
}

main().then(() => pool.end()).catch((err) => { console.error(err?.message ?? err); process.exit(1); });
