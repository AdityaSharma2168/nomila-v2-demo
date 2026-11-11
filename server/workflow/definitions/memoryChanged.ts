/**
 * memory_changed — you changed facts in What Nomila knows: re-run only what used them (agent/memoryRerun.ts has the rule).
 * Started only through requestMemoryRerun, from the /me/facts edit routes (routes/meMemory.ts).
 *
 *   quiet          the 30-minute window: every edit inside it joins this run (one active run per athlete)
 *   decide         read the batch's edits; understand if the Brief cites a changed fact, M.I.A. if one was in its last
 *                  input, the plan if either; apply the daily caps
 *   act            the parts within today's caps: the M.I.A. through requestEvaluation, understand and plan recorded
 *                  as pending (no stand-alone trigger for them yet)
 *   wait           the next UTC day when a part was over its cap, else immediately
 *   act_deferred   the capped parts
 *
 * A LATE EDIT IS NOT LOST: when the run is done, an edit newer than `decide`'s cutoff starts one more run.
 */
import { defineWorkflow } from "../registry";
import { runnerNow } from "../runner";
import { actStep, changesSince, decideStep, MEMORY_CHANGED_PROCESS, nextUtcDay, QUIET_WINDOW_MS, requestMemoryRerun, type DecideOutput } from "../../agent/memoryRerun";

const athleteOf = (id: string | null): string => {
  if (!id) throw new Error("memory_changed requires an athlete");
  return id;
};

export const MEMORY_CHANGED = defineWorkflow({
  process: MEMORY_CHANGED_PROCESS,
  version: 1,
  onDone: async (run) => {
    const decided = run.outputs.decide as DecideOutput | undefined;
    if (!run.athleteId || !decided) return;
    const late = await changesSince(run.athleteId, { after: decided.cutoff, from: decided.cutoff });
    // The next run reads every edit after this run's cutoff (decideStep), so its own `since` is only a fallback.
    if (late.factIds.length) await requestMemoryRerun(run.athleteId, runnerNow());
  },
  steps: [
    { name: "quiet", kind: "schedule", readyAt: () => new Date(runnerNow().getTime() + QUIET_WINDOW_MS) },
    { name: "decide", kind: "code", run: async (ctx) => decideStep(athleteOf(ctx.athleteId), ctx.runId, ctx.runInput as { since?: string } | null, runnerNow()) },
    { name: "act", kind: "code", run: async (ctx) => actStep(athleteOf(ctx.athleteId), (ctx.outputs.decide as DecideOutput).now, runnerNow()) },
    {
      name: "wait", kind: "schedule",
      readyAt: (ctx) => ((ctx.outputs.decide as DecideOutput | undefined)?.deferred.length ? nextUtcDay(runnerNow()) : runnerNow()),
    },
    { name: "act_deferred", kind: "code", run: async (ctx) => actStep(athleteOf(ctx.athleteId), (ctx.outputs.decide as DecideOutput).deferred, runnerNow()) },
  ],
});
