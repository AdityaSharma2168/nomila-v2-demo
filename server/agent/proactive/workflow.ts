/**
 * agent/proactive/workflow.ts — the mila_proactive process on the Postgres workflow runner: decide → speak → notify for
 * one logged event (dispatcher.ts). Started only by emitAthleteEvent (events.ts), which does nothing while
 * MILA_PROACTIVE is off. One run per event: the active scope and the idempotency key are the event id, so two events of
 * one athlete run side by side (each in its own session) and a repeated start joins the same run.
 *
 * speak is never retried (one attempt: a paid model turn runs once; a turn that cannot run sends the source's fixed-copy
 * push and the run ends). decide and notify are cheap and idempotent, retried as usual.
 */
import { defineWorkflow } from "../../workflow/registry";
import type { StepDef } from "../../workflow/types";
import { MILA_PROACTIVE_PROCESS } from "./config";

/** `recheck`: the one re-check a DEFER scheduled (dispatcher.ts); its own active scope, so it can start while the first run ends. */
export interface ProactiveRunInput { eventId: string; recheck: boolean }
const inputOf = (raw: unknown): ProactiveRunInput => {
  const r = (raw ?? {}) as { eventId?: unknown; recheck?: unknown };
  return { eventId: String(r.eventId ?? ""), recheck: r.recheck === true };
};

const need = (athleteId: string | null): string => {
  if (!athleteId) throw new Error("mila_proactive requires an athlete");
  return athleteId;
};
const decided = (outputs: Record<string, unknown>) => (outputs?.decide as { done?: boolean } | undefined)?.done === true;

const DECIDE: StepDef = {
  name: "decide", kind: "code", leaseMs: 60_000,
  run: async (ctx) => {
    const { decideStep } = await import("./dispatcher");
    return decideStep(need(ctx.athleteId), inputOf(ctx.runInput).eventId);
  },
};
const SPEAK: StepDef = {
  name: "speak", kind: "model", leaseMs: 6 * 60_000, retry: { maxAttempts: 1 },
  run: async (ctx) => {
    if (decided(ctx.outputs)) return { skipped: true };
    const { speakStep } = await import("./dispatcher");
    const input = inputOf(ctx.runInput);
    return speakStep(need(ctx.athleteId), input.eventId, {}, { recheck: input.recheck });
  },
};
const NOTIFY: StepDef = {
  name: "notify", kind: "code", leaseMs: 60_000,
  run: async (ctx) => {
    if (decided(ctx.outputs) || (ctx.outputs?.speak as { spoke?: boolean } | undefined)?.spoke !== true) return { skipped: true };
    const { notifyStep } = await import("./dispatcher");
    return notifyStep(need(ctx.athleteId), inputOf(ctx.runInput).eventId);
  },
};

/** v1: decide → speak → notify. */
export const MILA_PROACTIVE = defineWorkflow({
  process: MILA_PROACTIVE_PROCESS, version: 1, steps: [DECIDE, SPEAK, NOTIFY],
  activeScope: (raw) => `${MILA_PROACTIVE_PROCESS}:${inputOf(raw).eventId}${inputOf(raw).recheck ? ":recheck" : ""}`,
});
