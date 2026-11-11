/**
 * agent/plan/workflow.ts — the plan_refresh process on the Postgres workflow runner.
 *
 *   wait       a schedule step: ready at once, or — for an event within 6 hours of the last plan — when those 6 hours
 *              are up (the input's notBefore). Events that arrive meanwhile join this run (one active run per athlete:
 *              the runner's own guarantee), so a burst of events is one plan.
 *   plan       one plan refresh (run.ts). Its agent run's parent ref is "workflow:<run>:plan", so a retried step reuses
 *              a finished run and never pays twice. A skipped run (no Brief, over a cap) is an answer, not a failure.
 *   post_kits  (v2; design "Moments → post kits" §9–§10, Track E) a post kit for each new post action toward a goal the
 *              athlete holds (agent/postKit/build.ts buildPendingPostKits), at most 3 a run. Off — an answer, no work —
 *              unless AGENT_POST_KITS is "true". Each kit's model run has the parent ref
 *              "workflow:<run>:post_kit:<decision id>", so a retried step never pays twice.
 *   tell       (v3; design "Goals tab post details + plan ready", 12 Oct 2026) Mila comes back in each chat that asked
 *              (tell.ts): the facts from this run's outputs, one plan/ready line checked by code (else the plain line),
 *              the progress card flipped to done and one follow-up row. No chat asked → nothing, no model call. Its
 *              model run's parent ref is "workflow:<run>:tell" and the follow-up card id is plan-ready:<run>, so a retry
 *              never pays twice and never writes twice. A chat-started run that finds no asking chat looks again after
 *              the runner's backoff (TELL_ATTEMPTS = 3): the chat turn may not be written yet. v3's post_kits answers
 *              {status:"failed"} after its retries instead of failing the run: kits are extra to the plan.
 *
 * v1 (wait → plan) and v2 (… → post_kits) stay registered: a run keeps the version it started on. New runs start v3.
 * Started only through requestPlanRefresh (triggers.ts), which is off unless AGENT_PLAN is "true".
 */
import type { RunTrigger } from "../../../shared/agent";
import { defineWorkflow } from "../../workflow/registry";
import { runnerNow } from "../../workflow/runner";
import type { StepDef } from "../../workflow/types";
import { dbStore } from "../research/dbStore";
import { PLAN_PROCESS } from "./config";
import { runPlan } from "./run";
import { dbPlanSources } from "./sources";

export interface PlanRefreshInput {
  trigger: Extract<RunTrigger, "event" | "schedule" | "chat">;
  reason: string;
  goalId: string | null;
  /** ISO: not before this time (event coalescing). */
  notBefore: string | null;
  /**
   * The chats (conversation ids) that asked for this run: the starting chat, and any chat request that joined it
   * (triggers.ts). The tell step looks again for their turns only while there are some; a chat with no conversation
   * adds none, so its run settles at once.
   */
  askedFrom?: string[];
  /** MILA_WELCOME: an automatic refresh of the optional plan_refresh capability (triggers.ts PlanRefreshRequest). */
  optional?: boolean;
}

/** At most this many asking chats are kept on a run (its input stays small). */
export const MAX_ASKED_FROM = 10;

export const inputOf = (raw: unknown): PlanRefreshInput => {
  const i = (raw ?? {}) as Partial<PlanRefreshInput>;
  return {
    trigger: i.trigger === "schedule" || i.trigger === "chat" ? i.trigger : "event",
    reason: typeof i.reason === "string" ? i.reason.slice(0, 200) : "",
    goalId: typeof i.goalId === "string" ? i.goalId : null,
    askedFrom: Array.isArray(i.askedFrom) ? i.askedFrom.filter((x): x is string => typeof x === "string").slice(0, MAX_ASKED_FROM) : [],
    notBefore: typeof i.notBefore === "string" ? i.notBefore : null,
    ...(i.optional === true ? { optional: true } : {}),
  };
};

/**
 * MILA_WELCOME: an automatic (optional) run whose athlete has plan_refresh off now is skipped when its step RUNS, so
 * turning it off stops a refresh already queued. Transparent while the flag is off; a run the athlete asked for is
 * never optional.
 */
async function optionalOff(ctx: { athleteId?: string | null; runInput?: unknown }): Promise<boolean> {
  if (!inputOf(ctx.runInput).optional || !ctx.athleteId) return false;
  const { jobAllowed } = await import("../welcome/gate");
  return !(await jobAllowed("plan_refresh", ctx.athleteId));
}

/** MILA_WELCOME: post kits are the optional post_ideas capability. Transparent while the flag is off. */
async function postIdeasOn(ctx: { athleteId?: string | null }): Promise<boolean> {
  if (!ctx.athleteId) return false;
  const { jobAllowed } = await import("../welcome/gate");
  return jobAllowed("post_ideas", ctx.athleteId);
}

const WAIT: StepDef = {
  name: "wait", kind: "schedule",
  readyAt: (ctx) => {
    const nb = inputOf(ctx.runInput).notBefore;
    const t = nb ? Date.parse(nb) : NaN;
    return Number.isFinite(t) && t > runnerNow().getTime() ? new Date(t) : runnerNow();
  },
};

const PLAN: StepDef = {
  name: "plan", kind: "model", leaseMs: 10 * 60_000, retry: { maxAttempts: 2 },
  run: async (ctx) => {
    if (!ctx.athleteId) throw new Error("plan_refresh requires an athlete");
    if (await optionalOff(ctx)) return { status: "skipped", reason: "not_chosen" };
    const i = inputOf(ctx.runInput);
    const out = await runPlan({
      store: dbStore, sources: dbPlanSources, athleteId: ctx.athleteId, trigger: i.trigger, reason: i.reason, goalId: i.goalId,
      parentRef: `workflow:${ctx.runId}:plan`, now: runnerNow(),
    });
    return out;
  },
};

const POST_KITS: StepDef = {
  name: "post_kits", kind: "model", leaseMs: 10 * 60_000, retry: { maxAttempts: 2 },
  run: async (ctx) => {
    if (!ctx.athleteId) throw new Error("plan_refresh requires an athlete");
    // Loaded lazily: the library port builds cloud clients at load, and nothing loads while the flag is off.
    const { agentPostKitsEnabled } = await import("../postKit/config");
    if (!agentPostKitsEnabled()) return { status: "off" };
    if (await optionalOff(ctx)) return { status: "skipped", reason: "not_chosen" };
    // MILA_WELCOME: kits pick from her own photos and clips, which is the optional post_ideas capability (its flag is
    // AGENT_POST_KITS), so they are built only when she turned it on — on every plan run, the first plan included.
    if (!(await postIdeasOn(ctx))) return { status: "skipped", reason: "not_chosen" };
    const { buildPendingPostKits } = await import("../postKit/build");
    const { dbPostKitDeps } = await import("../postKit/deps");
    const i = inputOf(ctx.runInput);
    const deps = { ...dbPostKitDeps(), now: runnerNow() };
    return { status: "done", ...(await buildPendingPostKits(deps, ctx.athleteId, { parentRef: `workflow:${ctx.runId}:post_kit`, trigger: i.trigger })) };
  },
};

/**
 * v3's post_kits: the same work, but kits are extra to the plan — after its retries a failure is an answer ({status:
 * "failed"}), never a failed run: the plan is written either way, and the tell step still comes back to her chat.
 */
const POST_KITS_V3: StepDef = {
  ...POST_KITS,
  run: async (ctx) => {
    try {
      return await POST_KITS.run!(ctx);
    } catch (err) {
      if (ctx.attempt < (POST_KITS.retry?.maxAttempts ?? 1)) throw err;
      return { status: "failed" };
    }
  },
};

/** How many times the tell step looks for the chat that asked before it settles on "nobody asked". */
export const TELL_ATTEMPTS = 3;

const TELL: StepDef = {
  name: "tell", kind: "model", leaseMs: 5 * 60_000, retry: { maxAttempts: TELL_ATTEMPTS },
  run: async (ctx) => {
    if (!ctx.athleteId) throw new Error("plan_refresh requires an athlete");
    const { tellPlanReady } = await import("./tell");
    const { dbTellChats, dbPlanReadyWriter } = await import("./tellDb");
    const { pushPlanReady } = await import("../../services/push/events");
    const athleteId = ctx.athleteId;
    const r = await tellPlanReady(
      {
        store: dbStore, chats: dbTellChats, write: dbPlanReadyWriter(athleteId, ctx.runId), now: runnerNow(),
        // Her phone, only when there is something to act on (PUSH_NOTIFICATIONS; once per run: dedupe key plan_ready:<run>).
        push: (facts) => pushPlanReady(athleteId, ctx.runId, facts),
      },
      ctx.athleteId,
      { runId: ctx.runId, outputs: (ctx.outputs ?? {}) as Record<string, unknown>, goalId: inputOf(ctx.runInput).goalId },
    );
    // A chat asked (it started the run, or joined it: askedFrom), but its turn — the row holding the progress card —
    // may not be written yet: a fast run can finish before the chat turn does. Look again after the runner's backoff
    // (planning stays at "tell"); on the last attempt, nobody asked. A chat with no conversation adds no askedFrom: its
    // run settles at once.
    // Every asking chat, not just one: a chat that joined may still be writing its turn after the first was told.
    const found = new Set(r.asked ?? []);
    if ((inputOf(ctx.runInput).askedFrom ?? []).some((c) => !found.has(c)) && ctx.attempt < TELL_ATTEMPTS) {
      throw new Error("tell: a chat that asked is not written yet; looking again");
    }
    const { facts: _facts, asked: _asked, ...out } = r;
    return out;
  },
};

/** v1: wait → plan. Kept so a run that started on it keeps resolving. */
export const PLAN_REFRESH_V1 = defineWorkflow({ process: PLAN_PROCESS, version: 1, steps: [WAIT, PLAN] });

/** v2: wait → plan → post_kits. Kept so a run that started on it keeps resolving. */
export const PLAN_REFRESH_V2 = defineWorkflow({ process: PLAN_PROCESS, version: 2, steps: [WAIT, PLAN, POST_KITS] });

/** v3, the default: wait → plan → post_kits → tell. */
export const PLAN_REFRESH = defineWorkflow({ process: PLAN_PROCESS, version: 3, steps: [WAIT, PLAN, POST_KITS_V3, TELL] });
