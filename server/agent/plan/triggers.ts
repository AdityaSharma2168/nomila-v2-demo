/**
 * agent/plan/triggers.ts — what starts a plan refresh (design "Triggers"), and the guards on it.
 *
 *   after onboarding      Understand wrote the Brief (agent onboarding's understand step) → event, at once
 *   weekly                the daily cron (POST /api/internal/plan-refresh-cron) starts a scheduled run for an athlete
 *                         with none in the last 7 days
 *   new deal              the deal detector created a deal, or a deal was accepted / declined → event
 *   new measured data     a connected account was newly read, or a metric moved ≥ 10% → event
 *   dated event coming up the same daily cron: an event fact 3–14 days out with no action due before it → event
 *   you add or keep       add_goal / keep with no held actions → event scoped to that goal
 *   you ask in chat       refresh_plan → chat
 *
 * Standing goals (plan 1.5.0): a goal kept from a recommendation that repeats on a trigger (its decision's detail.repeats)
 * is what that trigger's run is scoped to — the weekly run (weekly), an event coming up (before_event), a deal agreed or
 * added (deal_signed) — so the plan writes the action the goal owes first. No new trigger: the existing ones carry it.
 *
 * Guards: off unless AGENT_PLAN; nothing without a current Brief; one run in flight per athlete (the runner: a request
 * while one is active JOINS it); an event within 6 hours of the last plan waits for those 6 hours (coalesced); at most
 * 1 scheduled and 4 event-or-chat runs per 7 days. The run itself also skips when the input is unchanged or a cost cap
 * would be passed (run.ts). Never throws: a trigger is fire-and-forget for its caller.
 *
 * MILA_WELCOME (agent/welcome/gate.ts): every AUTOMATIC refresh is the optional plan_refresh capability — the weekly
 * and before-event sweeps, an app event (a deal, new measured data) and a goal edit (add, keep, bring back) — so it is
 * requested with `optional: true` and requestPlanRefresh refuses it ("not_chosen") unless the athlete said yes; the
 * plan step checks again when it runs. Not optional: the chat ask (refresh_plan is itself a plan_refresh tool, refused
 * per call while it is off) and onboarding's FIRST plan (the registry's core first_plan: part of the sign-up service).
 */
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { GoalRepeats } from "../../../shared/agent";
import { createLogger } from "../../logger";
import type { AgentStore } from "../research/store";
import { EVENT_TOPICS } from "../moments/facts";
import { agentPlanEnabled, PLAN, PLAN_PROCESS, PLAN_SKILL_ID, repeatsOf } from "./config";
import type { PlanRefreshInput } from "./workflow";
import { enabledChoiceSql, jobAllowed, jobGate } from "../welcome/gate";

const logger = createLogger("agent/plan/triggers");
const DAY = 86_400_000;

export interface PlanRefreshRequest {
  trigger: PlanRefreshInput["trigger"];
  reason: string;
  goalId?: string | null;
  /** Skip the 6-hour coalescing (onboarding's first plan; a chat request). */
  immediate?: boolean;
  /**
   * plan 1.5.0: the standing trigger this request is (weekly, before_event, deal_signed): with no goalId, the run is
   * scoped to the athlete's active goal that repeats on it, when there is one.
   */
  standing?: Exclude<GoalRepeats, "once">;
  /** A chat request: the conversation that asked (recorded on the run as askedFrom; none when the chat has no id). */
  conversationId?: string | null;
  /** False: enqueue only — the workflow tick runs it (the daily sweep: a cron request never runs plans itself). */
  kick?: boolean;
  idempotencyKey?: string;
  now?: Date;
  /**
   * MILA_WELCOME: an automatic refresh of the OPTIONAL plan_refresh capability (the weekly and before-event sweeps, an
   * app event). Recorded on the run (input.optional), and the plan step checks the athlete's choice again when it runs,
   * so turning it off stops a refresh already waiting, and requestPlanRefresh refuses it up front (not_chosen) while
   * the athlete's choice is not enabled. A goal edit is automatic too (owner, 3 Nov: gated on plan_refresh). Not
   * optional: a chat ask and onboarding's first plan (core first_plan); joining an optional run makes that run theirs
   * (optional cleared).
   */
  optional?: boolean;
}

export type PlanRefreshResult =
  | { started: true; runId: string; joined: boolean; notBefore: string | null }
  | { started: false; reason: "off" | "not_chosen" | "no_brief" | "weekly_cap" | "event_cap" | "error" };

/** Starting a run (injectable for tests). */
export type RunStarter = (opts: { process: string; athleteId: string; input: PlanRefreshInput; createdBy: string; idempotencyKey?: string; kick?: false }) => Promise<{ runId: string; created: boolean }>;

const defaultStarter: RunStarter = async (o) => {
  await import("./workflow"); // registers plan_refresh (a no-op once the server has loaded every definition)
  const { startRun } = await import("../../workflow/runner");
  const { run, created } = await startRun({ process: o.process, athleteId: o.athleteId, input: o.input, createdBy: o.createdBy, idempotencyKey: o.idempotencyKey, ...(o.kick === false ? { kick: false } : {}) });
  return { runId: run.id, created };
};

async function storeOf(store?: AgentStore): Promise<AgentStore> {
  return store ?? (await import("../research/dbStore")).dbStore;
}

export async function requestPlanRefresh(athleteId: string, req: PlanRefreshRequest, deps: { store?: AgentStore; start?: RunStarter } = {}): Promise<PlanRefreshResult> {
  if (!agentPlanEnabled()) return { started: false, reason: "off" };
  try {
    // MILA_WELCOME: an automatic refresh runs only for athletes who turned plan_refresh on (transparent while off).
    if (req.optional && !(await jobAllowed("plan_refresh", athleteId))) return { started: false, reason: "not_chosen" };
    const store = await storeOf(deps.store);
    const now = req.now ?? new Date();
    if (!(await store.currentBrief(athleteId))) return { started: false, reason: "no_brief" };

    const runs = await store.listRunsSince(athleteId, { since: new Date(now.getTime() - 7 * DAY).toISOString(), skillId: PLAN_SKILL_ID });
    const counted = runs.filter((r) => r.status !== "failed");
    if (req.trigger === "schedule" && counted.filter((r) => r.trigger === "schedule").length >= PLAN.MAX_SCHEDULED_PER_WEEK) return { started: false, reason: "weekly_cap" };
    if (req.trigger !== "schedule" && counted.filter((r) => r.trigger !== "schedule").length >= PLAN.MAX_EVENT_PER_WEEK) return { started: false, reason: "event_cap" };

    // Coalesce: an event within 6 hours of the last plan waits until the 6 hours are up.
    const last = runs.length ? runs[runs.length - 1] : null;
    const until = last ? Date.parse(last.startedAt) + PLAN.COALESCE_MS : 0;
    const notBefore = req.trigger === "event" && !req.immediate && until > now.getTime() ? new Date(until).toISOString() : null;

    const askedFrom = req.trigger === "chat" && req.conversationId ? [req.conversationId] : [];
    const goalId = req.goalId ?? (req.standing ? await standingGoalFor(store, athleteId, req.standing) : null);
    const input: PlanRefreshInput = { trigger: req.trigger, reason: req.reason.slice(0, 200), goalId, notBefore, ...(askedFrom.length ? { askedFrom } : {}), ...(req.optional ? { optional: true } : {}) };
    const r = await (deps.start ?? defaultStarter)({ process: PLAN_PROCESS, athleteId, input, createdBy: `plan:${req.trigger}`, idempotencyKey: req.idempotencyKey, ...(req.kick === false ? { kick: false as const } : {}) });
    // A request that must not wait (a chat ask, onboarding's first plan) joined a run still waiting out its coalescing
    // window: the wait ends now, and the run goes.
    if (!r.created && req.immediate) await endWaitNow(r.runId);
    // A chat that joined a run (started by an event, a schedule or another chat) is told too: it is recorded as asking.
    if (!r.created && askedFrom.length) await addAskedFrom(r.runId, askedFrom[0]);
    // A request the athlete made joined an automatic (optional) run: the run now serves them, whatever their choice.
    if (!r.created && !req.optional) await clearOptional(r.runId);
    logger.info({ athleteId, trigger: req.trigger, reason: req.reason, runId: r.runId, joined: !r.created, notBefore }, "plan refresh requested");
    return { started: true, runId: r.runId, joined: !r.created, notBefore };
  } catch (err: any) {
    logger.warn({ athleteId, trigger: req.trigger, error: String(err?.message ?? err).slice(0, 200) }, "plan refresh request failed");
    return { started: false, reason: "error" };
  }
}

/**
 * The athlete's active goal that repeats on this trigger (plan 1.5.0): read off the recommendation each goal was kept
 * from (memory_goals.decision_id → detail.repeats). The highest priority, then the oldest, when several do; null when none.
 */
export async function standingGoalFor(store: AgentStore, athleteId: string, standing: Exclude<GoalRepeats, "once">): Promise<string | null> {
  const goals = (await store.listGoals(athleteId)).filter((g) => g.status === "active" && g.decisionId)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || a.createdAt.localeCompare(b.createdAt));
  for (const g of goals) {
    if (repeatsOf(await store.getDecision(athleteId, g.decisionId!).catch(() => null)) === standing) return g.id;
  }
  return null;
}

/** One UPDATE: a chat that joined the run is recorded on its input as asking (askedFrom), once, at most 10. Never throws. */
export async function addAskedFrom(runId: string, conversationId: string): Promise<void> {
  try {
    const { db } = await import("../../db");
    const { workflowRuns } = await import("../../../shared/schema");
    const list = sql`coalesce(${workflowRuns.input}->'askedFrom', '[]'::jsonb)`;
    await db.update(workflowRuns).set({ input: sql`jsonb_set(${workflowRuns.input}, '{askedFrom}', ${list} || to_jsonb(${conversationId}::text))` })
      .where(and(eq(workflowRuns.id, runId), sql`NOT (${list} ? ${conversationId})`, sql`jsonb_array_length(${list}) < 10`));
  } catch (err: any) {
    logger.warn({ runId, error: String(err?.message ?? err).slice(0, 200) }, "could not record the chat that joined (it may not be told)");
  }
}

/** One UPDATE: the run no longer counts as an automatic (optional) refresh. Never throws. */
export async function clearOptional(runId: string): Promise<void> {
  try {
    const { db } = await import("../../db");
    const { workflowRuns } = await import("../../../shared/schema");
    await db.update(workflowRuns).set({ input: sql`${workflowRuns.input} - 'optional'` })
      .where(and(eq(workflowRuns.id, runId), sql`${workflowRuns.input} ? 'optional'`));
  } catch (err: any) {
    logger.warn({ runId, error: String(err?.message ?? err).slice(0, 200) }, "could not mark the joined run as asked for");
  }
}

/**
 * One UPDATE: the run's wait step, when it is still waiting for a time in the future, is due now — then the run is
 * kicked in the background. Nothing for a run past its wait. Never throws (the request it serves already succeeded).
 */
export async function endWaitNow(runId: string): Promise<boolean> {
  try {
    const { db } = await import("../../db");
    const { workflowSteps } = await import("../../../shared/schema");
    const moved = await db.update(workflowSteps).set({ ready_at: sql`now()` })
      .where(and(eq(workflowSteps.run_id, runId), eq(workflowSteps.step, "wait"), eq(workflowSteps.status, "ready"), sql`${workflowSteps.ready_at} > now()`))
      .returning({ id: workflowSteps.id });
    if (moved.length) kickInBackground(runId);
    return moved.length > 0;
  } catch (err: any) {
    logger.warn({ runId, error: String(err?.message ?? err).slice(0, 200) }, "could not end a coalesced run's wait (the tick runs it when due)");
    return false;
  }
}

/**
 * Run a just-started run's steps without holding the caller (a chat turn must not wait minutes for a plan and its kits).
 * Never throws; if this instance stops first, the every-minute workflow tick picks the run up.
 */
export function kickInBackground(runId: string): void {
  void import("../../workflow/runner")
    .then(({ kick }) => kick(runId))
    .catch((err: any) => logger.warn({ runId, error: String(err?.message ?? err).slice(0, 200) }, "background kick failed: the tick will run it"));
}

/**
 * Fire and forget: for callers on a hot path (the deal detector, the measured sync). Never throws, never awaits long.
 * `standing`: the standing trigger this event is (a deal agreed or added: deal_signed), so a goal repeating on it leads.
 */
export function notifyPlanEvent(athleteId: string, reason: string, goalId: string | null = null, standing?: Exclude<GoalRepeats, "once">): void {
  if (!agentPlanEnabled()) return;
  // MILA_WELCOME: an automatic refresh is the optional plan_refresh capability — only for athletes who said yes
  // (requestPlanRefresh refuses an optional request otherwise).
  void requestPlanRefresh(athleteId, { trigger: "event", reason, goalId, optional: true, ...(standing ? { standing } : {}) }).catch(() => undefined);
}

/**
 * The daily sweep (POST /api/internal/plan-refresh-cron): for every athlete with a current Brief, a scheduled run when
 * none ran in the last 7 days; otherwise an event run when a dated event is 3–14 days out with no action due before
 * it. Batched (`limit` athletes per call, oldest plan first). It only ENQUEUES: runs start with kick: false (the
 * every-minute workflow tick runs them; a cron request never runs a plan itself) and idempotency key
 * "plan:<trigger>:<athlete>:<day>", so a re-sent cron the same day starts nothing new. Returns what it enqueued.
 */
export async function sweepPlanRefresh(opts: { now?: Date; limit?: number; start?: RunStarter } = {}): Promise<{ checked: number; scheduled: number; events: number; skipped: Record<string, number> }> {
  const out = { checked: 0, scheduled: 0, events: 0, skipped: {} as Record<string, number> };
  if (!agentPlanEnabled()) return out;
  const now = opts.now ?? new Date();
  const { db } = await import("../../db");
  const { memoryBriefs, memoryDecisions, memoryFacts } = await import("../../../shared/schema");
  const today = now.toISOString().slice(0, 10);
  const day = (n: number) => new Date(now.getTime() + n * DAY).toISOString().slice(0, 10);

  // Athletes with a current Brief, the ones whose last plan is oldest first.
  const rows = await db.select({
    athleteId: memoryBriefs.athlete_id,
    lastPlan: sql<string | null>`(SELECT max(r.started_at)::text FROM agent_runs r WHERE r.athlete_id = memory_briefs.athlete_id AND r.skill_id = ${PLAN_SKILL_ID})`,
  }).from(memoryBriefs).where(and(eq(memoryBriefs.status, "current"),
    // MILA_WELCOME: the weekly and before-event refreshes are optional — only athletes who said yes (no-op while off).
    enabledChoiceSql(memoryBriefs.athlete_id, "plan_refresh")))
    .orderBy(sql`2 ASC NULLS FIRST`).limit(Math.max(1, Math.min(opts.limit ?? 200, 1000)));

  const skip = (why: string) => { out.skipped[why] = (out.skipped[why] ?? 0) + 1; };
  const chose = jobGate("plan_refresh");
  for (const r of rows) {
    out.checked++;
    if (!(await chose(r.athleteId))) { skip("not_chosen"); continue; }
    const weekAgo = now.getTime() - 7 * DAY;
    if (!r.lastPlan || Date.parse(r.lastPlan) < weekAgo) {
      const s = await requestPlanRefresh(r.athleteId, { trigger: "schedule", reason: "weekly refresh", standing: "weekly", optional: true, now, kick: false, idempotencyKey: `plan:schedule:${r.athleteId}:${today}` }, { start: opts.start });
      if (s.started) out.scheduled++; else skip(s.reason);
      continue;
    }
    // An event coming up (3–14 days) with no action timed before it.
    const events = await db.select({ id: memoryFacts.id, date: memoryFacts.observed_on }).from(memoryFacts).where(and(
      eq(memoryFacts.athlete_id, r.athleteId), inArray(memoryFacts.status, ["active", "disputed"]),
      // The one moments store's predicate (agent/moments/facts.ts isEventFact), in SQL.
      or(inArray(memoryFacts.topic, [...EVENT_TOPICS]), eq(memoryFacts.subject_kind, "event")),
      gte(memoryFacts.observed_on, day(PLAN.EVENT_SWEEP_MIN_DAYS)), sql`${memoryFacts.observed_on} <= ${day(PLAN.EVENT_SWEEP_MAX_DAYS)}`,
    ));
    if (!events.length) continue;
    const timed = await db.select({ factId: sql<string>`${memoryDecisions.detail}->'event'->>'factId'` }).from(memoryDecisions).where(and(
      eq(memoryDecisions.athlete_id, r.athleteId), eq(memoryDecisions.kind, "action"), inArray(memoryDecisions.response, ["pending", "accepted", "edited"]),
      sql`${memoryDecisions.detail}->'event'->>'factId' IS NOT NULL`,
    ));
    const covered = new Set(timed.map((t) => t.factId));
    const open = events.filter((e) => !covered.has(e.id));
    if (!open.length) continue;
    const s = await requestPlanRefresh(r.athleteId, { trigger: "event", reason: `a dated event is coming up (${open.length})`, standing: "before_event", optional: true, now, kick: false, idempotencyKey: `plan:event:${r.athleteId}:${today}` }, { start: opts.start });
    if (s.started) out.events++; else skip(s.reason);
  }
  logger.info({ ...out, today }, "plan refresh sweep");
  return out;
}
