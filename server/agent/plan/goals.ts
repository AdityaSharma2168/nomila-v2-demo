/**
 * agent/plan/goals.ts — the goals the athlete holds and the ones Mila recommends: ONE set of service functions behind
 * both the chat agent's goal tools (tools.ts) and the app routes (routes.ts). Every function takes the athlete id first
 * (from the session or the run, never from a body or a model) and is written against the AgentStore port.
 *
 *   readGoals        GET /me/agent/goals: goals (game plan + this week's actions), set-aside goals, recommended goals,
 *                    Home's "Coming up" (≤ 3, next 60 days, dated facts only), the biggest risk and upside, what would help,
 *                    and whether a plan run is in progress (deps.planning); a post action carries its idea, pillar and kit
 *   readResults      GET /me/agent/results: per goal, what you did and what came back (last 30 days)
 *   keepRecommended  a recommendation becomes a goal (source proposed_accepted); its held actions follow it
 *   skipRecommended  "Not now": skipped; Mila won't suggest it again for 90 days (validate.ts)
 *   changeGoal       new words, horizon or game plan (a game plan you write is yours: game_plan_by = athlete)
 *   setAsideGoal     paused; its pending actions expire       dropGoal   dropped; history kept; quiet for 90 days
 *   bringBackGoal    paused → active                           addGoal    your own goal (source said)
 *   suggestGoal      adds a pending recommendation only; changes nothing you hold
 *   undoChange       reverses one change (its decision row holds the before and after)
 * Each write records a memory_decisions row (kind goal, skill goals) with what changed, and returns the goal-change card.
 */
import type { Decision, Goal, GoalChangeCardPayload, GoalHorizon, GoalStatus, MemoryFact } from "../../../shared/agent";
import {
  AGENT_GOALS_CONTRACT, PLAN_BUTTON_LABELS,
  type ActionDecisionDetail, type AgentGoalsResponse, type AgentResultsResponse, type ClientGoalActionKind, type ComingUpItem,
  type GoalActionKitView, type GoalActionView, type MomentDecisionDetail, type MomentView, type GoalChangeDetail, type GoalDecisionDetail, type GoalsPlanningView, type GoalView,
  type OpenTarget, type PlanDeliverable, type PlanEventRef, type RecommendedGoalView,
} from "../../../shared/plan";
import type { AgentStore } from "../research/store";
import { MOMENTS_SKILL_ID } from "../moments/config";
import { PLAN, PLAN_SKILL_ID } from "./config";
import { isoDay, repeatsOf, riskUpsideOf, upcomingEvents, eventLabel } from "./input";
import { latestPlanRun, type PlanRunOutput } from "./run";
import { requestPlanRefresh, type RunStarter } from "./triggers";
import { sameGoal } from "./validate";
import { withTags } from "../postKit/caption";

export const GOALS_SKILL_ID = "goals";

export class GoalsError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

export interface GoalsDeps {
  store: AgentStore;
  now?: Date;
  /** Run starter for the plan refresh a write may request (tests). */
  start?: RunStarter;
  /** The plan run in progress, if any (routes: the workflow runner, planning.ts). Absent: the read says none. */
  planning?: (athleteId: string) => Promise<GoalsPlanningView | null>;
}

const DAY = 86_400_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Wed 15 Oct" (a calendar date, no timezone drift). */
export function dayWords(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const goalStateOf = (g: Goal) => ({ text: g.text, horizon: g.horizon ?? null, status: g.status, gamePlan: g.gamePlan ?? null, gamePlanBy: g.gamePlanBy ?? "mila" });

// ─── views ────────────────────────────────────────────────────────────────────────────────────────────────────────

const CLIENT_KIND: Record<string, ClientGoalActionKind> = { post: "post_kit", pitch: "pitch", reply: "reply", connect: "task", other: "task" };

/**
 * The draft Mila starts from: the body, and (plan 1.7.0) a post_brief's caption with its tags and its shots, which now
 * live in fields of their own rather than inside the body. "" when there is nothing.
 */
function draftOf(d: Pick<PlanDeliverable, "body" | "caption" | "hashtags" | "shots">): string {
  const caption = d.caption?.trim() ? withTags(d.caption, d.hashtags ?? []) : "";
  return [d.body, caption ? `Caption: ${caption}` : "", d.shots?.length ? `Shots: ${d.shots.join("; ")}` : ""].filter(Boolean).join("\n");
}

/** A post action's kit, in short: built, how many of her assets it holds, its preview's state. Null while none is built. */
function kitView(det: Partial<ActionDecisionDetail>): GoalActionKitView | null {
  const k = det.prepared?.postKit;
  if (!k || typeof k !== "object") return null;
  const p = k.preview;
  return {
    built: true,
    assets: Array.isArray(k.assets) ? k.assets.length : 0,
    aiGenerationNeeded: !!k.aiGenerationNeeded?.value,
    preview: p && (p.status === "queued" || p.status === "ready" || p.status === "failed") ? { status: p.status, requestedAt: p.requestedAt } : null,
  };
}

/**
 * One action decision as the Goals card shows it. Until Track E prepares it, the button is "Start with Mila". A post
 * action always opens its post kit, built or not (the kit screen says when nothing is built yet), and carries its idea,
 * its pillar and its kit in short for the Goals row.
 */
export function actionView(d: Decision): GoalActionView {
  const det = (d.detail ?? {}) as Partial<ActionDecisionDetail>;
  const answered = d.response === "accepted" || d.response === "edited";
  const state = answered ? "done" : det.state ?? "to_start";
  const planned = det.button ?? "start";
  // Connect works without anything prepared; everything else starts with Mila until something is made.
  const button = state === "made" || planned === "connect" ? planned : "start";
  const deliverable = det.deliverable ?? { type: "checklist", title: d.suggested, body: "", target: null, platform: null, thread: null, connector: null };
  const studioItemId = typeof det.prepared?.studioItemId === "string" ? det.prepared.studioItemId : null;
  const isPost = det.kind === "post";
  // A post action opens its post kit (its own row), built or not; another prepared kind opens the library focused on it.
  const open: OpenTarget = isPost ? { screen: "post-kit", params: { id: d.id } }
    : studioItemId ? { screen: "studio-item", params: { id: studioItemId } }
    : deliverable.connector ? { screen: "connect", params: { connector: deliverable.connector } }
    : deliverable.thread ? { screen: "opportunity", params: { opportunityId: deliverable.thread.opportunityId } }
    : null;
  return {
    id: d.id, title: det.what ?? d.suggested, kind: CLIENT_KIND[det.kind ?? "other"] ?? "task",
    when: det.dueOn ? dayWords(det.dueOn) : null, state, studioItemId, open,
    startPrompt: state === "to_start" ? [det.what ?? d.suggested, draftOf(deliverable) ? `Start from this draft:\n${draftOf(deliverable)}` : ""].filter(Boolean).join("\n\n") : null,
    planKind: det.kind ?? "other", why: d.why === "-" ? "" : d.why, button, buttonLabel: PLAN_BUTTON_LABELS[button],
    dueOn: det.dueOn ?? null, event: (det.event as PlanEventRef | null) ?? null, deliverable, approvalId: d.approvalId,
    post: isPost ? det.post ?? null : null,
    pillar: isPost ? det.idea?.pillar ?? null : null,
    kit: isPost ? kitView(det) : null,
  };
}

const byDue = (a: GoalActionView, b: GoalActionView) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999");

/**
 * A goal's actions for this week: what is waiting (soonest first), then what was done in the last 7 days. Every waiting
 * action shows (posts are not capped per goal, plan 1.5.0); what was done fills up to three rows.
 */
function weekActions(actions: Decision[], now: Date): GoalActionView[] {
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const waiting = actions.filter((d) => d.response === "pending").map(actionView).sort(byDue);
  const done = actions.filter((d) => (d.response === "accepted" || d.response === "edited") && (d.respondedAt ?? d.createdAt) >= weekAgo).map(actionView);
  return [...waiting, ...done].slice(0, Math.max(3, waiting.length));
}

const sourceOf = (f: MemoryFact): { label: string; url?: string } => {
  if (f.type === "said") return { label: "You told us" };
  if (f.source.url) {
    let host = f.source.url;
    try { host = new URL(f.source.url).hostname.replace(/^www\./, ""); } catch { /* keep */ }
    return { label: f.source.title || host, url: f.source.url };
  }
  return { label: f.source.title || "Nomila" };
};

export async function readGoals(athleteId: string, deps: GoalsDeps): Promise<AgentGoalsResponse> {
  const { store } = deps;
  const now = deps.now ?? new Date();
  const goals = await store.listGoals(athleteId);
  const decisions = await store.listDecisions(athleteId, { kinds: ["goal", "action"] });
  const actions = decisions.filter((d) => d.kind === "action");
  const changes = decisions.filter((d) => d.kind === "goal" && d.skillId === GOALS_SKILL_ID);

  const inYourWords = (g: Goal) => g.source === "said"
    || decisions.some((d) => d.id === g.decisionId && d.response === "edited")
    || changes.some((d) => { const c = d.detail as Partial<GoalChangeDetail>; return c.goalId === g.id && c.op === "change" && !c.undone && c.from?.text !== c.to?.text; });

  const view = (g: Goal): GoalView => {
    const mine = weekActions(actions.filter((d) => d.goalId === g.id), now);
    const nextEvent = mine.filter((a) => a.event && a.state !== "done").map((a) => a.event!).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
    return {
      id: g.id, text: g.text, plan: g.gamePlan, horizon: g.horizon ?? null, domain: g.domain ?? null, actions: mine, status: g.status, source: g.source,
      gamePlanBy: g.gamePlanBy ?? "mila", inYourWords: inYourWords(g), priority: g.priority, nextEvent,
      // plan 1.5.0: a goal kept from a standing recommendation repeats on its trigger (read off that recommendation).
      repeats: repeatsOf(decisions.find((d) => d.id === g.decisionId)) ?? "once",
    };
  };

  // Recommended: pending goal decisions (the plan's, and any Mila suggested in the chat).
  const recs = decisions.filter((d) => d.kind === "goal" && d.response === "pending" && (d.skillId === PLAN_SKILL_ID || d.skillId === GOALS_SKILL_ID));
  const evidenceIds = [...new Set(recs.flatMap((d) => d.evidence.flatMap((e) => (e.kind === "fact" ? [e.factId] : []))))];
  const factById = new Map((await store.getFacts(athleteId, evidenceIds)).map((f) => [f.id, f]));
  const recommended: RecommendedGoalView[] = recs.map((d) => {
    const det = (d.detail ?? {}) as Partial<GoalDecisionDetail>;
    const facts = d.evidence.flatMap((e) => (e.kind === "fact" && factById.get(e.factId) && factById.get(e.factId)!.status !== "removed" ? [factById.get(e.factId)!] : []));
    const v = det.value;
    return {
      decisionId: d.id, goal: d.suggested, horizon: det.horizon ?? "next", domain: det.domain ?? null, why: d.why === "-" ? "" : d.why, value: v?.text ?? "",
      valueRange: v && v.low != null && v.high != null && v.currency ? { low: v.low, high: v.high, currency: v.currency, drivers: v.drivers ?? [] } : null,
      valueConfidence: det.valueConfidence ?? "low", nextDecision: det.nextDecision ?? "", gamePlan: det.gamePlan?.length ? det.gamePlan.join("\n") : null,
      factIds: facts.map((f) => f.id),
      sources: facts.filter((f) => !f.sensitive).map(sourceOf).filter((s, i, all) => all.findIndex((x) => x.label === s.label && x.url === s.url) === i),
      actions: actions.filter((a) => a.parentDecisionId === d.id && a.response === "pending").map(actionView).sort(byDue),
      repeats: repeatsOf(d) ?? "once",
    };
  });

  // Coming up: dated event facts only. Ready = waiting actions timed for that event: any waiting action of a goal she
  // holds (as before), and, since posts are prepared before Keep, a waiting post action with a built kit under a goal
  // still only recommended. The row opens the soonest built kit.
  const facts = await store.listFacts(athleteId, ["active", "disputed"]);
  const today = isoDay(now);
  const heldGoalIds = new Set(goals.filter((g) => g.status === "active").map((g) => g.id));
  const recIds = new Set(recs.map((d) => d.id));
  const isPost = (a: Decision) => (a.detail as Partial<ActionDecisionDetail>)?.kind === "post";
  const kitBuilt = (a: Decision) => !!kitView((a.detail ?? {}) as Partial<ActionDecisionDetail>);
  const waitingForEvent = (factId: string) => actions.filter((a) => {
    if (a.response !== "pending") return false;
    if (((a.detail as Partial<ActionDecisionDetail>)?.event as PlanEventRef | undefined)?.factId !== factId) return false;
    if (a.goalId && heldGoalIds.has(a.goalId)) return true;
    return !!a.parentDecisionId && recIds.has(a.parentDecisionId) && isPost(a) && kitBuilt(a);
  });
  const comingUp: ComingUpItem[] = upcomingEvents(facts, today, PLAN.HORIZON_DAYS).slice(0, 3).map((f) => {
    const timed = waitingForEvent(f.id);
    const dueOf = (a: Decision) => (a.detail as Partial<ActionDecisionDetail>)?.dueOn ?? "9999";
    const kit = timed.filter((a) => isPost(a) && kitBuilt(a)).sort((a, b) => dueOf(a).localeCompare(dueOf(b)))[0];
    return {
      date: f.date!, precision: f.datePrecision ?? "day", label: eventLabel(f), factId: f.id,
      goalId: timed.find((a) => a.goalId && heldGoalIds.has(a.goalId))?.goalId ?? null, actionsReady: timed.length, kitActionId: kit?.id ?? null,
    };
  });

  // Moments: what the moments step chose and still holds (its pending candidates), every kind, soonest first. A moment
  // whose fact is gone (removed or superseded) is left out. Ready and the kit link are read as for Coming up.
  const liveFact = new Set(facts.map((f) => f.id));
  const horizon = isoDay(new Date(now.getTime() + PLAN.HORIZON_DAYS * 86_400_000));
  const moments: MomentView[] = (await store.listDecisions(athleteId, { skillId: MOMENTS_SKILL_ID, kinds: ["other"], responses: ["pending"] }))
    .map((d) => ({ d, m: (d.detail ?? {}) as Partial<MomentDecisionDetail> }))
    .filter(({ m }) => m.kind === "moment" && !!m.factId && !!m.date && liveFact.has(m.factId) && !m.retiredWhy)
    // A month-only date is the 1st: keep it while its month is current.
    .filter(({ m }) => (m.datePrecision === "month" ? m.date!.slice(0, 7) >= today.slice(0, 7) : m.date! >= today) && m.date! <= horizon)
    .sort((a, b) => a.m.date!.localeCompare(b.m.date!) || (a.m.rank ?? 99) - (b.m.rank ?? 99))
    .map(({ d, m }) => {
      const timed = waitingForEvent(m.factId!);
      const dueOf = (a: Decision) => (a.detail as Partial<ActionDecisionDetail>)?.dueOn ?? "9999";
      const kit = timed.filter((a) => isPost(a) && kitBuilt(a)).sort((a, b) => dueOf(a).localeCompare(dueOf(b)))[0];
      return {
        factId: m.factId!, date: m.date!, precision: m.datePrecision ?? "day", name: m.name ?? "", category: m.category ?? "schedule",
        whyNow: m.whyNow ?? "", angle: m.idea?.angle ?? null, hook: m.idea?.hook ?? d.suggested, actionsReady: timed.length, kitActionId: kit?.id ?? null,
      };
    });

  const brief = await store.currentBrief(athleteId);
  const last = await latestPlanRun(store, athleteId, now);
  const lastPlan = (last?.output as PlanRunOutput | undefined)?.plan;
  return {
    contract: AGENT_GOALS_CONTRACT,
    goals: goals.filter((g) => g.status === "active").map(view),
    setAside: goals.filter((g) => g.status === "paused").map(view),
    recommended,
    comingUp,
    moments,
    riskUpside: riskUpsideOf(brief),
    missing: lastPlan?.missing ?? [],
    plan: last ? { runId: last.id, at: last.endedAt ?? last.startedAt } : null,
    planning: deps.planning ? await deps.planning(athleteId) : null,
  };
}

export async function readResults(athleteId: string, deps: GoalsDeps): Promise<AgentResultsResponse> {
  const { store } = deps;
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - 30 * DAY).toISOString();
  const goals = await store.listGoals(athleteId);
  const actions = (await store.listDecisions(athleteId, { kinds: ["action"], since })).filter((d) => d.goalId);
  return {
    contract: "agent-results/1",
    since,
    goals: goals.filter((g) => g.status === "active" || g.status === "done" || actions.some((a) => a.goalId === g.id)).map((g) => {
      const mine = actions.filter((a) => a.goalId === g.id && a.response !== "expired");
      const pending = mine.filter((a) => a.response === "pending").map(actionView).sort(byDue);
      return {
        goalId: g.id, text: g.text, horizon: g.horizon ?? null,
        counts: { done: mine.filter((a) => a.response === "accepted" || a.response === "edited").length, skipped: mine.filter((a) => a.response === "skipped").length, toDo: pending.length },
        actions: mine.map((a) => {
          const v = actionView(a);
          return { id: a.id, title: v.title, planKind: v.planKind, response: a.response, respondedAt: a.respondedAt, outcome: a.outcome, outcomeNote: a.outcomeNote, state: v.state, createdAt: a.createdAt };
        }).reverse(),
        next: pending[0] ? { title: pending[0].title, dueOn: pending[0].dueOn } : null,
      };
    }),
  };
}

// ─── writes ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GoalChangeResult {
  card: GoalChangeCardPayload;
  goal: Goal | null;
  decisionId: string | null;
}

async function cardFor(store: AgentStore, athleteId: string, op: GoalChangeCardPayload["op"], before: Goal | null, after: { text: string; horizon: GoalHorizon | null; status: GoalStatus | "recommended" }, goalId: string | null, undoDecisionId: string | null, now: Date): Promise<GoalChangeCardPayload> {
  const actions = goalId ? await store.listDecisions(athleteId, { kinds: ["action"], goalId }) : [];
  return {
    op, goalId,
    before: before ? { text: before.text, horizon: before.horizon ?? null, status: before.status } : null,
    after, thisWeek: weekActions(actions, now).map((a) => ({ title: a.title, state: a.state })), undoDecisionId,
  };
}

async function record(store: AgentStore, athleteId: string, d: { suggested: string; why: string; response: "accepted" | "edited"; detail: GoalChangeDetail; goalId: string | null; runId?: string | null }): Promise<Decision> {
  return store.insertDecision(athleteId, {
    runId: d.runId ?? null, skillId: GOALS_SKILL_ID, kind: "goal", suggested: d.suggested.slice(0, 500), why: d.why.slice(0, 1000) || "-",
    evidence: [], detail: d.detail as unknown as Record<string, unknown>, goalId: d.goalId, response: d.response,
  });
}

async function mustGoal(store: AgentStore, athleteId: string, goalId: string, allowed: GoalStatus[]): Promise<Goal> {
  const g = await store.getGoal(athleteId, goalId);
  if (!g || (g.status === "dropped" && !allowed.includes("dropped"))) throw new GoalsError("goal not found", 404, "not_found");
  if (!allowed.includes(g.status)) throw new GoalsError(`this goal is ${g.status === "paused" ? "set aside" : g.status}`, 409, "conflict");
  return g;
}

/** Expire a goal's waiting actions (never one already in the approval queue). */
async function expireActions(store: AgentStore, athleteId: string, filter: { goalId?: string; parentDecisionId?: string }): Promise<string[]> {
  const waiting = await store.listDecisions(athleteId, { kinds: ["action"], responses: ["pending"], ...filter });
  const out: string[] = [];
  for (const d of waiting) {
    if (d.approvalId) continue;
    await store.respondDecision(athleteId, d.id, "expired", "the goal was set aside");
    out.push(d.id);
  }
  return out;
}

const horizonOf = (v: unknown): GoalHorizon | null | undefined => (v === undefined ? undefined : v === null ? null : v === "now" || v === "next" || v === "later" ? v : (() => { throw new GoalsError("horizon must be now, next or later", 400, "invalid"); })());

export async function keepRecommended(athleteId: string, decisionId: string, opts: { text?: string | null; runId?: string | null }, deps: GoalsDeps): Promise<GoalChangeResult> {
  const { store } = deps;
  const now = deps.now ?? new Date();
  const d = await store.getDecision(athleteId, decisionId);
  if (!d || d.kind !== "goal" || (d.skillId !== PLAN_SKILL_ID && d.skillId !== GOALS_SKILL_ID)) throw new GoalsError("recommendation not found", 404, "not_found");
  if (d.response !== "pending") throw new GoalsError("this recommendation was already answered", 409, "conflict");
  const words = clean(opts.text ?? "", 500);
  const text = words || d.suggested;
  const edited = !!words && words !== d.suggested;
  const det = (d.detail ?? {}) as Partial<GoalDecisionDetail>;
  const goal = await store.insertGoal(athleteId, {
    text, source: "proposed_accepted", decisionId: d.id, horizon: det.horizon ?? null, domain: det.domain ?? null,
    gamePlan: det.gamePlan?.length ? det.gamePlan.join("\n") : null, gamePlanBy: "mila",
  });
  await store.respondDecision(athleteId, d.id, edited ? "edited" : "accepted", null);
  await store.linkDecisionToGoal(athleteId, d.id, goal.id);
  // Its held actions now serve the goal.
  const held = await store.listDecisions(athleteId, { kinds: ["action"], responses: ["pending"], parentDecisionId: d.id });
  for (const a of held) await store.updateDecision(athleteId, a.id, { goalId: goal.id });
  const change = await record(store, athleteId, {
    suggested: `Kept: ${text}`, why: edited ? "You kept it in your own words." : "You kept it.", response: edited ? "edited" : "accepted", goalId: goal.id, runId: opts.runId,
    detail: { op: "keep", goalId: goal.id, from: null, to: goalStateOf(goal), expiredActionIds: [] },
  });
  if (!held.length) await requestPlanRefresh(athleteId, { trigger: "event", reason: "you kept a goal", goalId: goal.id, optional: true, now }, { store, start: deps.start });
  return { goal, decisionId: change.id, card: await cardFor(store, athleteId, "keep", null, { text, horizon: goal.horizon ?? null, status: "active" }, goal.id, change.id, now) };
}

export async function skipRecommended(athleteId: string, decisionId: string, opts: { reason?: string | null }, deps: GoalsDeps): Promise<{ decisionId: string; expiredActionIds: string[] }> {
  const { store } = deps;
  const d = await store.getDecision(athleteId, decisionId);
  if (!d || d.kind !== "goal" || (d.skillId !== PLAN_SKILL_ID && d.skillId !== GOALS_SKILL_ID)) throw new GoalsError("recommendation not found", 404, "not_found");
  if (d.response !== "pending") throw new GoalsError("this recommendation was already answered", 409, "conflict");
  await store.respondDecision(athleteId, d.id, "skipped", clean(opts.reason ?? "", 500) || null);
  const expiredActionIds = await expireActions(store, athleteId, { parentDecisionId: d.id });
  return { decisionId: d.id, expiredActionIds };
}

export async function changeGoal(athleteId: string, goalId: string, patch: { text?: unknown; horizon?: unknown; gamePlan?: unknown; runId?: string | null }, deps: GoalsDeps): Promise<GoalChangeResult> {
  const { store } = deps;
  const now = deps.now ?? new Date();
  const before = await mustGoal(store, athleteId, goalId, ["active", "paused"]);
  const text = patch.text === undefined ? undefined : clean(patch.text, 500);
  if (text === "") throw new GoalsError("a goal needs words", 400, "invalid");
  const horizon = horizonOf(patch.horizon);
  const gamePlan = patch.gamePlan === undefined ? undefined : clean(String(patch.gamePlan ?? ""), 400) || null;
  if (text === undefined && horizon === undefined && gamePlan === undefined) throw new GoalsError("nothing to change", 400, "invalid");
  const after = await store.updateGoal(athleteId, goalId, {
    ...(text !== undefined ? { text } : {}), ...(horizon !== undefined ? { horizon } : {}),
    ...(gamePlan !== undefined ? { gamePlan, gamePlanBy: "athlete" as const } : {}),
  });
  const change = await record(store, athleteId, {
    suggested: `Changed: ${after!.text}`, why: "You asked for this change.", response: "edited", goalId, runId: patch.runId,
    detail: { op: "change", goalId, from: goalStateOf(before), to: goalStateOf(after!) },
  });
  return { goal: after, decisionId: change.id, card: await cardFor(store, athleteId, "change", before, { text: after!.text, horizon: after!.horizon ?? null, status: after!.status }, goalId, change.id, now) };
}

async function setStatus(athleteId: string, goalId: string, op: "set_aside" | "drop" | "bring_back", reason: string | null, runId: string | null | undefined, deps: GoalsDeps): Promise<GoalChangeResult> {
  const { store } = deps;
  const now = deps.now ?? new Date();
  const allowed: GoalStatus[] = op === "set_aside" ? ["active"] : op === "drop" ? ["active", "paused"] : ["paused"];
  const before = await mustGoal(store, athleteId, goalId, allowed);
  const status: GoalStatus = op === "set_aside" ? "paused" : op === "drop" ? "dropped" : "active";
  const after = await store.updateGoal(athleteId, goalId, { status });
  const expiredActionIds = op === "bring_back" ? [] : await expireActions(store, athleteId, { goalId });
  const words = { set_aside: "Set aside", drop: "Dropped", bring_back: "Brought back" }[op];
  const change = await record(store, athleteId, {
    suggested: `${words}: ${before.text}`, why: reason || "You asked for this.", response: "accepted", goalId, runId,
    detail: { op, goalId, from: goalStateOf(before), to: goalStateOf(after!), expiredActionIds },
  });
  if (op === "bring_back") await requestPlanRefresh(athleteId, { trigger: "event", reason: "you brought a goal back", goalId, optional: true, now }, { store, start: deps.start });
  return { goal: after, decisionId: change.id, card: await cardFor(store, athleteId, op, before, { text: after!.text, horizon: after!.horizon ?? null, status }, goalId, change.id, now) };
}

export const setAsideGoal = (athleteId: string, goalId: string, opts: { reason?: string | null; runId?: string | null }, deps: GoalsDeps) => setStatus(athleteId, goalId, "set_aside", clean(opts.reason ?? "", 500) || null, opts.runId, deps);
export const dropGoal = (athleteId: string, goalId: string, opts: { reason?: string | null; runId?: string | null }, deps: GoalsDeps) => setStatus(athleteId, goalId, "drop", clean(opts.reason ?? "", 500) || null, opts.runId, deps);
export const bringBackGoal = (athleteId: string, goalId: string, opts: { runId?: string | null }, deps: GoalsDeps) => setStatus(athleteId, goalId, "bring_back", null, opts.runId, deps);

// A goal edit's refresh (add, keep, bring back) is AUTOMATIC: `optional: true`, so with MILA_WELCOME on it runs only for
// athletes who turned plan_refresh on (triggers.ts requestPlanRefresh; owner, 3 Nov 2026). The goal itself is saved either way.
export async function addGoal(athleteId: string, input: { text?: unknown; horizon?: unknown; runId?: string | null }, deps: GoalsDeps): Promise<GoalChangeResult> {
  const { store } = deps;
  const now = deps.now ?? new Date();
  const text = clean(input.text, 500);
  if (!text) throw new GoalsError("a goal needs words", 400, "invalid");
  const horizon = horizonOf(input.horizon) ?? null;
  const held = (await store.listGoals(athleteId)).filter((g) => g.status === "active" || g.status === "paused");
  if (held.some((g) => g.text.trim().toLowerCase() === text.toLowerCase())) throw new GoalsError("you already hold this goal", 409, "conflict");
  const goal = await store.insertGoal(athleteId, { text, source: "said", decisionId: null, horizon });
  const change = await record(store, athleteId, {
    suggested: `Added: ${text}`, why: "Your own goal.", response: "accepted", goalId: goal.id, runId: input.runId,
    detail: { op: "add", goalId: goal.id, from: null, to: goalStateOf(goal) },
  });
  await requestPlanRefresh(athleteId, { trigger: "event", reason: "you added a goal", goalId: goal.id, optional: true, now }, { store, start: deps.start });
  return { goal, decisionId: change.id, card: await cardFor(store, athleteId, "add", null, { text, horizon, status: "active" }, goal.id, change.id, now) };
}

/** Mila suggests a goal in the chat: a pending recommendation only (keep / not now), resting on real facts. */
export async function suggestGoal(athleteId: string, input: { goal?: unknown; horizon?: unknown; whyNow?: unknown; factIds?: unknown; runId?: string | null }, deps: GoalsDeps): Promise<GoalChangeResult> {
  const { store } = deps;
  const now = deps.now ?? new Date();
  const text = clean(input.goal, 90);
  if (!text) throw new GoalsError("a goal needs words", 400, "invalid");
  const horizon = horizonOf(input.horizon) ?? "next";
  const ids = (Array.isArray(input.factIds) ? input.factIds : []).map(String).slice(0, 10);
  const facts = (await store.getFacts(athleteId, ids)).filter((f) => (f.status === "active" || f.status === "disputed") && !(f.sensitive && f.careKind !== "conduct"));
  if (!facts.length) throw new GoalsError("a suggestion needs at least one of the athlete's facts", 400, "invalid");
  const held = (await store.listGoals(athleteId)).filter((g) => g.status === "active" || g.status === "paused");
  if (held.some((g) => sameGoal(g.text, text))) throw new GoalsError("the athlete already holds this goal", 409, "conflict");
  const detail: GoalDecisionDetail = { key: "chat", horizon, value: { text: "", low: null, high: null, currency: null, drivers: [] }, valueConfidence: "low", nextDecision: "", gamePlan: [] };
  const d = await store.insertDecision(athleteId, {
    runId: input.runId ?? null, skillId: GOALS_SKILL_ID, kind: "goal", suggested: text, why: clean(input.whyNow, 1000) || "-",
    evidence: facts.map((f) => ({ kind: "fact" as const, factId: f.id })), detail: detail as unknown as Record<string, unknown>,
  });
  return { goal: null, decisionId: d.id, card: await cardFor(store, athleteId, "suggest", null, { text, horizon, status: "recommended" }, null, null, now) };
}

/** Reverse one change (its decision row holds what it was before). */
export async function undoChange(athleteId: string, changeDecisionId: string, deps: GoalsDeps): Promise<GoalChangeResult> {
  const { store } = deps;
  const now = deps.now ?? new Date();
  const d = await store.getDecision(athleteId, changeDecisionId);
  const c = (d?.detail ?? {}) as Partial<GoalChangeDetail>;
  if (!d || d.skillId !== GOALS_SKILL_ID || d.kind !== "goal" || !c.op || c.op === "suggest" || !c.goalId) throw new GoalsError("change not found", 404, "not_found");
  if (c.undone) throw new GoalsError("this change was already undone", 409, "conflict");
  const goal = await store.getGoal(athleteId, c.goalId);
  let after: Goal | null = null;
  if (c.op === "add" || c.op === "keep") {
    // The goal was made by this change: it goes; a kept recommendation waits again, with its actions.
    if (goal) {
      const actions = await store.listDecisions(athleteId, { kinds: ["action"], goalId: goal.id });
      const fromRecommendation = c.op === "keep" && goal.decisionId ? goal.decisionId : null;
      if (fromRecommendation) await store.updateDecision(athleteId, fromRecommendation, { response: "pending", responseReason: null, goalId: null });
      for (const a of actions) {
        // Held actions go back to the recommendation; anything planned for the goal since then expires with it.
        if (fromRecommendation && a.parentDecisionId === fromRecommendation) await store.updateDecision(athleteId, a.id, { goalId: null });
        else if (a.response === "pending" && !a.approvalId) await store.respondDecision(athleteId, a.id, "expired", "the goal was undone");
      }
      await store.deleteGoal(athleteId, goal.id);
    }
  } else if (goal && c.from) {
    after = await store.updateGoal(athleteId, goal.id, { text: c.from.text, horizon: c.from.horizon, status: c.from.status, gamePlan: c.from.gamePlan, gamePlanBy: c.from.gamePlanBy });
    for (const id of c.expiredActionIds ?? []) {
      const a = await store.getDecision(athleteId, id);
      if (a && a.response === "expired") await store.updateDecision(athleteId, id, { response: "pending", responseReason: null });
    }
  } else throw new GoalsError("goal not found", 404, "not_found");
  await store.updateDecision(athleteId, d.id, { detail: { ...c, undone: true } as Record<string, unknown> });
  const shown = after ?? goal;
  return {
    goal: after, decisionId: null,
    card: await cardFor(store, athleteId, c.op, null, {
      text: shown?.text ?? c.to?.text ?? "", horizon: shown?.horizon ?? null,
      // Undoing a keep puts the recommendation back; undoing an add removes the goal.
      status: after ? after.status : c.op === "keep" ? "recommended" : "dropped",
    }, after?.id ?? null, null, now),
  };
}
