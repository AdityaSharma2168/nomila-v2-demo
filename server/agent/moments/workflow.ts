/**
 * agent/moments/workflow.ts — the moments_scan process on the Postgres workflow runner: one step, one weekly scan.
 *
 *   scan   one moments scan (scan.ts). Its agent run's parent ref is "workflow:<run>:scan", so a retried step reuses a
 *          finished run and never pays twice. A skipped scan (no Brief, over a cap) is an answer, not a failure.
 *
 * Started only through requestMomentsScan (triggers.ts), which is off unless AGENT_MOMENTS is "true".
 */
import type { RunTrigger } from "../../../shared/agent";
import { defineWorkflow } from "../../workflow/registry";
import { runnerNow } from "../../workflow/runner";
import { dbStore } from "../research/dbStore";
import { MOMENTS_PROCESS } from "./config";
import { runMomentsScan } from "./scan";
import { dbMomentsSources } from "./sources";
import { jobAllowed } from "../welcome/gate";

export interface MomentsScanInput {
  trigger: Extract<RunTrigger, "schedule" | "event">;
  reason: string;
}

const inputOf = (raw: unknown): MomentsScanInput => {
  const i = (raw ?? {}) as Partial<MomentsScanInput>;
  return { trigger: i.trigger === "event" ? "event" : "schedule", reason: typeof i.reason === "string" ? i.reason.slice(0, 200) : "" };
};

export const MOMENTS_SCAN = defineWorkflow({
  process: MOMENTS_PROCESS,
  version: 1,
  steps: [
    {
      name: "scan", kind: "model", leaseMs: 10 * 60_000, retry: { maxAttempts: 2 },
      run: async (ctx) => {
        if (!ctx.athleteId) throw new Error("moments_scan requires an athlete");
        // MILA_WELCOME: checked again when the step RUNS (not only when the sweep queued it), so turning the weekly scan
        // off stops a scan already waiting. An answer, not a failure.
        if (!(await jobAllowed("moments_scan", ctx.athleteId))) return { status: "skipped", reason: "not_chosen" };
        const i = inputOf(ctx.runInput);
        return runMomentsScan({
          store: dbStore, sources: dbMomentsSources, athleteId: ctx.athleteId, trigger: i.trigger, parentRef: `workflow:${ctx.runId}:scan`, now: runnerNow(),
        });
      },
    },
  ],
});
