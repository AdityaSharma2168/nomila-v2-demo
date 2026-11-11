/**
 * agent/plan/planning.ts — whether a plan run is in progress for the athlete (GET /me/agent/goals `planning`), from the
 * workflow runner's active plan_refresh run. The Goals tab polls while it is set and refreshes itself when it clears.
 *
 * A run still in its wait step with the step not yet due (an event coalesced into the 6 hours after the last plan) is
 * not in progress: nothing is being made, so Goals neither says "Mila is updating your plan" nor polls for hours.
 * The athlete id always comes from the session; nothing here reads another athlete's runs.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { workflowSteps } from "../../../shared/schema";
import type { GoalsPlanningView } from "../../../shared/plan";
import { activeRunFor } from "../../workflow/runner";
import { PLAN_PROCESS } from "./config";

const STEPS: ReadonlyArray<GoalsPlanningView["step"]> = ["plan", "post_kits", "tell"];

export async function activePlanning(athleteId: string, now: Date = new Date()): Promise<GoalsPlanningView | null> {
  const active = await activeRunFor(athleteId, PLAN_PROCESS);
  if (!active) return null;
  const { run } = active;
  const current = run.current_step ?? "";
  if (current === "wait") {
    const [wait] = await db.select({ readyAt: workflowSteps.ready_at, status: workflowSteps.status }).from(workflowSteps)
      .where(and(eq(workflowSteps.run_id, run.id), eq(workflowSteps.step, "wait")))
      .orderBy(desc(workflowSteps.attempt)).limit(1);
    if (wait && wait.status === "ready" && wait.readyAt.getTime() > now.getTime()) return null;
  }
  const step = (STEPS as ReadonlyArray<string>).includes(current) ? (current as GoalsPlanningView["step"]) : "plan";
  return { runId: run.id, step, startedAt: run.started_at.toISOString() };
}
