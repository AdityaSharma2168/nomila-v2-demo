/**
 * agent/onboarding/signupWillScore.ts — one M.I.A. score per sign-up.
 *
 * A waitlist sign-up runs signup_research (research_a/b → research_merge → mia_preview), and its mia_preview step is
 * the sign-up's score. Connecting Instagram during that run also starts social_sync, whose recompute_features step
 * asks for an evaluation of its own (SOCIAL_BLOCK_CHANGED). Both read the same evidence, the model scores it a little
 * differently each time, and the later one becomes current — on prod (24 Oct 2026) a sign-up was emailed 649 and then
 * shown 629 two minutes later, at twice the scoring cost.
 *
 * So while a sign-up run is active and has NOT yet started its merge, the social recompute leaves scoring to it: the
 * merge reads the connected account's measured facts and the run's mia_preview reads the features the recompute just
 * wrote, so nothing the connect added is lost. Once the merge has started the connect's evidence may be too late for
 * the run's score, so the social path asks for its own evaluation as before (rare: a connect in the last minute or two).
 *
 * SELECTs only.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { SIGNUP_RESEARCH_PROCESS } from "./dailyCap";

/** The step whose start decides whether the sign-up run will still read a connect's evidence. */
export const SIGNUP_EVIDENCE_CUTOFF_STEP = "research_merge";
/**
 * signup_research v4 (lean research) has no merge: its mia_preview step syncs her measured facts from her connected
 * accounts right before it builds the M.I.A. snapshot (services/miaPreview/preview.ts computePreview), so a connect
 * before that step starts is still read by the run's own score.
 */
export const LEAN_EVIDENCE_CUTOFF_STEP = "mia_preview";
export const cutoffStepFor = (definitionVersion: number) => (definitionVersion >= 4 ? LEAN_EVIDENCE_CUTOFF_STEP : SIGNUP_EVIDENCE_CUTOFF_STEP);

/** The id of her active sign-up run that will still score her with the evidence on file now, else null. */
export async function signupRunWillScore(athleteId: string): Promise<string | null> {
  const runs = await db.select({ id: workflowRuns.id, version: workflowRuns.definition_version }).from(workflowRuns)
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, SIGNUP_RESEARCH_PROCESS), inArray(workflowRuns.status, ["running", "waiting"])));
  for (const run of runs) {
    const started = await db.select({ status: workflowSteps.status }).from(workflowSteps)
      .where(and(eq(workflowSteps.run_id, run.id), eq(workflowSteps.step, cutoffStepFor(run.version))));
    // A merge row that is only `ready` (queued, not yet picked up) has not read anything yet.
    if (started.every((s) => s.status === "ready")) return run.id;
  }
  return null;
}
