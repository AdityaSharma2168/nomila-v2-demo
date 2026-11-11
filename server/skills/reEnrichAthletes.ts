/**
 * reEnrichAthletes.ts — Part B #4: periodic research re-enrichment.
 *
 * The NON-social scoring inputs (achievements, press, Google Trends score, GDELT
 * article count, story arc) + the enriched profile come from researchAthlete,
 * which — until now — only ran once at admin activation and stayed frozen
 * forever after. This re-runs research on a monthly cadence so those inputs stay
 * current (and the score/rates recompute off them).
 *
 * Safe by construction: researchAthlete only FILLS MISSING profile fields
 * (sport/school/conference/division) — it never clobbers existing/corrected
 * values. Runs with bounded concurrency and per-athlete isolation, so one
 * athlete's research failure never aborts the batch.
 *
 * Note on scale: this re-enriches every active athlete each run. If the roster
 * grows large, switch to only re-enriching athletes whose research is older than
 * N days (research_updated_at) to spread cost — cadence + concurrency already cap
 * the burst.
 */

import { db } from "../db";
import { athletes } from "../../shared/schema";
import { inArray } from "drizzle-orm";
import { buildSearchName, researchAthlete } from "./researchAthlete";
import { searchInputsFor } from "../services/intelligence/context/searchInputs";
import { researchPlannerExecutionEnabled } from "../services/intelligence/research/config";
import { createLogger } from "../logger";

const logger = createLogger("re-enrich");

// Phase A Step 2d-5 (#31): the local copy of buildSearchName is gone — the one exported legacy builder is used on the
// unlisted path; the listed path takes the search view's anchor (and, D7 / #33, its known handles).

export async function reEnrichAllAthletes(
  opts: { concurrency?: number; dryRun?: boolean } = {},
): Promise<{ processed: number; succeeded: number; failed: number; skipped?: boolean }> {
  // Phase A Step 2b: once planner EXECUTION is enabled (both flags), the domain refresh planner
  // owns re-research and this unconditional sweep is a no-op. Either flag false ⇒ unchanged.
  if (researchPlannerExecutionEnabled()) {
    logger.info("reEnrichAllAthletes superseded by the research planner (RESEARCH_REFRESH_ENABLED && RESEARCH_SUBSTRATE_WRITE) — no-op");
    return { processed: 0, succeeded: 0, failed: 0, skipped: true };
  }
  const concurrency = opts.concurrency ?? 2;
  const dryRun = opts.dryRun ?? false;

  const roster = await db.select().from(athletes)
    .where(inArray(athletes.status, ["enriched", "claimed", "active"]));
  logger.info({ count: roster.length, dryRun, concurrency }, "reEnrichAllAthletes start");

  const inputsFor = (a: typeof roster[number]) => searchInputsFor(a.id, { anchor: buildSearchName(a), handles: {} });   // today: no handles (D7)
  if (dryRun) {
    for (const a of roster) logger.info({ athleteId: a.id, searchName: (await inputsFor(a)).anchor }, "would re-enrich");
    return { processed: roster.length, succeeded: 0, failed: 0 };
  }

  let succeeded = 0, failed = 0;
  for (let i = 0; i < roster.length; i += concurrency) {
    const batch = roster.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((a) =>
      inputsFor(a).then((inputs) => researchAthlete(a.id, inputs.anchor, "re_enrich", undefined))
        .then(() => true)
        .catch((err: any) => {
          logger.error({ athleteId: a.id, error: err.message?.slice(0, 150) }, "re-enrich failed");
          return false;
        }),
    ));
    for (const ok of results) ok ? succeeded++ : failed++;
  }

  logger.info({ processed: roster.length, succeeded, failed }, "reEnrichAllAthletes complete");
  return { processed: roster.length, succeeded, failed };
}
