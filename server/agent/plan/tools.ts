/**
 * agent/plan/tools.ts — the goal tools for the chat agent loop (design "Goal tools for the chat agent loop").
 *
 *   list_goals       read   active, set-aside and recommended goals with the game plan and this week's actions
 *   keep_goal        draft  a recommendation becomes a goal (in the athlete's words when given); held actions follow
 *   change_goal      draft  new words, horizon or game plan — ONLY a change the athlete asked for in this conversation
 *   set_aside_goal   draft  status → paused; its pending actions expire
 *   drop_goal        draft  status → dropped; history kept; not suggested again for 90 days
 *   bring_back_goal  draft  a set-aside goal is active again
 *   add_goal         draft  the athlete's own goal; plans for it
 *   suggest_goal     draft  a pending recommendation only — what Mila uses when the athlete did NOT ask for a change
 *   refresh_plan     draft  asks for a plan refresh ("plan my week"), subject to the plan's guards. Started (or joined): a
 *                           progress card carrying the run's id (planRunId), so the run's tell step comes back into this
 *                           chat when it is done; the run itself goes on in the background (the turn never waits for it).
 *                           Refused: the facts Mila says it from in the same turn (refused, used, limit, next_plan_on)
 *
 * Draft = private to Nomila and reversible: every write records a decision with what changed and returns a goal-change
 * card with Undo (built here by code, never from model prose). None takes an athlete id: the athlete is the run's.
 * The same service functions back the app routes (routes.ts).
 */
import { z } from "zod";
import type { ChatCard, GoalChangeCardPayload } from "../../../shared/agent";
import { errorResult, okResult, resolveFactKeys, type AgentTool, type ToolContext } from "../tools";
import { dbStore } from "../research/dbStore";
import type { AgentStore } from "../research/store";
import {
  addGoal, bringBackGoal, changeGoal, dropGoal, GoalsError, keepRecommended, readGoals, setAsideGoal, suggestGoal,
  type GoalChangeResult, type GoalsDeps,
} from "./goals";
import { PLAN, PLAN_SKILL_ID } from "./config";
import { dayWords } from "./goals";
import { kickInBackground, requestPlanRefresh, type PlanRefreshResult } from "./triggers";

const DAY = 86_400_000;

/** The progress card refresh_plan shows while the plan run works (the tell step flips it to done). */
export function planProgressCard(planRunId: string, ctx: ToolContext, kitsOn: boolean): ChatCard {
  const steps = [
    { label: "Planning your week", state: "running" as const },
    ...(kitsOn ? [{ label: "Getting your post kits ready", state: "pending" as const }] : []),
  ];
  return {
    id: `plan-progress:${planRunId}`, kind: "progress", title: "Updating your plan",
    payload: { step: 1, of: steps.length, label: steps[0].label, state: "running", steps, planRunId }, links: [], runId: ctx.runId,
  };
}

/** Why a refresh did not start, as facts Mila says it from: the weekly limit with how many were used, and when the next plan comes. */
export async function refusalFacts(store: AgentStore, athleteId: string, reason: Extract<PlanRefreshResult, { started: false }>["reason"], now: Date = new Date()) {
  const refused = reason === "weekly_cap" || reason === "event_cap" ? "weekly_limit" : reason;
  const runs = await store.listRunsSince(athleteId, { since: new Date(now.getTime() - 7 * DAY).toISOString(), skillId: PLAN_SKILL_ID });
  const counted = runs.filter((r) => r.status !== "failed");
  const lastScheduled = [...counted].reverse().find((r) => r.trigger === "schedule");
  return {
    refused,
    used: counted.filter((r) => r.trigger !== "schedule").length,
    limit: PLAN.MAX_EVENT_PER_WEEK,
    next_plan_on: lastScheduled ? dayWords(new Date(Date.parse(lastScheduled.startedAt) + 7 * DAY).toISOString()) : null,
  };
}

const horizon = z.enum(["now", "next", "later"]);
const id = z.string().min(1).max(80);

const TITLES: Record<GoalChangeCardPayload["op"], string> = {
  keep: "Goal kept", change: "Goal changed", set_aside: "Goal set aside", drop: "Goal dropped", add: "Goal added",
  bring_back: "Goal brought back", suggest: "A goal for you to consider",
};

function changeCard(result: unknown, ctx: ToolContext): ChatCard | null {
  const r = result as { card?: GoalChangeCardPayload } | null;
  if (!r?.card) return null;
  const links = r.card.op === "suggest" ? [] : [{ label: "See your goals", target: { screen: "goals" } }];
  return { id: `goal-change:${ctx.runId}:${r.card.goalId ?? r.card.after.text.slice(0, 20)}:${r.card.op}`, kind: "goal-change", title: TITLES[r.card.op], payload: r.card, links, runId: ctx.runId };
}

/**
 * A service error goes back to the model as an explicit error result (it tells the athlete), never as a tool failure.
 * Success says what changed: { status: "ok", changed, card, goal }.
 */
async function guarded(f: () => Promise<GoalChangeResult>): Promise<unknown> {
  try {
    const r = await f();
    return okResult({ changed: r.card.op, card: r.card, goal: r.goal ? { id: r.goal.id, text: r.goal.text, status: r.goal.status, horizon: r.goal.horizon ?? null } : null });
  } catch (err) {
    if (err instanceof GoalsError) return errorResult(err.message);
    throw err;
  }
}

/** The context block shows goal ids as "G:<id>" and recommendations as "D:<id>": accept either form. */
const bareId = (s: string | undefined) => (typeof s === "string" ? s.trim().replace(/^[GD]:/i, "") : s);
async function stripIds<T extends Record<string, unknown>>(_ctx: ToolContext, a: T): Promise<{ args: T }> {
  const out: Record<string, unknown> = { ...a };
  for (const k of ["goal_id", "decision_id"]) if (typeof out[k] === "string") out[k] = bareId(out[k] as string);
  return { args: out as T };
}

export function goalTools(store: AgentStore = dbStore): AgentTool[] {
  const deps = (): GoalsDeps => ({ store });
  return [
    {
      name: "list_goals",
      description: "The athlete's goals: active ones with their game plan and this week's actions, set-aside ones, and the goals Mila recommends (each with its decision_id, to keep). Also the next dated events and the biggest risk and upside. No arguments.",
      kind: "ours", permission: "read", args: z.object({}),
      async execute(ctx) {
        const v = await readGoals(ctx.athleteId, deps());
        return okResult({
          goals: v.goals.map((g) => ({ goal_id: g.id, text: g.text, horizon: g.horizon, game_plan: g.plan, this_week: g.actions.map((a) => ({ title: a.title, state: a.state, due_on: a.dueOn, event: a.event?.label ?? null })) })),
          set_aside: v.setAside.map((g) => ({ goal_id: g.id, text: g.text })),
          recommended: v.recommended.map((r) => ({ decision_id: r.decisionId, goal: r.goal, horizon: r.horizon, why: r.why, value: r.value })),
          coming_up: v.comingUp.map((c) => ({ date: c.date, label: c.label })),
          risk_upside: v.riskUpside,
        });
      },
    },
    {
      name: "keep_goal",
      description: "Keep a goal Mila recommended (decision_id from list_goals): it becomes the athlete's goal. Pass text only when the athlete reworded it. Use only when the athlete says to keep it.",
      kind: "ours", permission: "draft",
      args: z.object({ decision_id: id, text: z.string().max(500).optional().describe("The athlete's own wording, when they changed it.") }),
      prepare: stripIds,
      execute: (ctx, a: { decision_id: string; text?: string }) => guarded(() => keepRecommended(ctx.athleteId, a.decision_id, { text: a.text ?? null, runId: ctx.runId }, deps())),
      card: changeCard,
    },
    {
      name: "change_goal",
      description: "Change one of the athlete's goals: its words, its horizon (now = this month, next = this season, later = the year ahead) or its game plan. ONLY when the athlete asked for this change in this conversation; otherwise use suggest_goal. A game plan the athlete writes becomes theirs.",
      kind: "ours", permission: "draft",
      args: z.object({ goal_id: id, text: z.string().max(500).optional(), horizon: horizon.optional(), game_plan: z.string().max(400).optional() }),
      prepare: stripIds,
      execute: (ctx, a: { goal_id: string; text?: string; horizon?: string; game_plan?: string }) => guarded(() => changeGoal(ctx.athleteId, a.goal_id, { text: a.text, horizon: a.horizon, gamePlan: a.game_plan, runId: ctx.runId }, deps())),
      card: changeCard,
    },
    {
      name: "set_aside_goal",
      description: "Set one of the athlete's goals aside for now (it can come back). Its waiting actions are cleared. Only when the athlete asks.",
      kind: "ours", permission: "draft",
      args: z.object({ goal_id: id, reason: z.string().max(500).optional() }),
      prepare: stripIds,
      execute: (ctx, a: { goal_id: string; reason?: string }) => guarded(() => setAsideGoal(ctx.athleteId, a.goal_id, { reason: a.reason ?? null, runId: ctx.runId }, deps())),
      card: changeCard,
    },
    {
      name: "drop_goal",
      description: "Drop one of the athlete's goals. Its history is kept and Mila will not suggest it again for 90 days. Only when the athlete asks.",
      kind: "ours", permission: "draft",
      args: z.object({ goal_id: id, reason: z.string().max(500).optional() }),
      prepare: stripIds,
      execute: (ctx, a: { goal_id: string; reason?: string }) => guarded(() => dropGoal(ctx.athleteId, a.goal_id, { reason: a.reason ?? null, runId: ctx.runId }, deps())),
      card: changeCard,
    },
    {
      name: "bring_back_goal",
      description: "Bring a set-aside goal back to active. Only when the athlete asks.",
      kind: "ours", permission: "draft",
      args: z.object({ goal_id: id }),
      prepare: stripIds,
      execute: (ctx, a: { goal_id: string }) => guarded(() => bringBackGoal(ctx.athleteId, a.goal_id, { runId: ctx.runId }, deps())),
      card: changeCard,
    },
    {
      name: "add_goal",
      description: "Add a goal in the athlete's own words (start with a verb). Mila then plans for it.",
      kind: "ours", permission: "draft",
      args: z.object({ text: z.string().min(1).max(500), horizon: horizon.optional() }),
      execute: (ctx, a: { text: string; horizon?: string }) => guarded(() => addGoal(ctx.athleteId, { text: a.text, horizon: a.horizon, runId: ctx.runId }, deps())),
      card: changeCard,
    },
    {
      name: "suggest_goal",
      description: "Suggest a goal the athlete did not ask for: it only adds a recommendation they can keep or set aside, and changes nothing they hold. Needs the facts it rests on: their F-keys from CONTEXT or recall_facts.",
      kind: "ours", permission: "draft",
      args: z.object({ goal: z.string().min(1).max(90), horizon, why_now: z.string().min(1).max(1000), fact_ids: z.array(z.string().max(80)).min(1).max(10).describe("F-keys (or fact ids) the suggestion rests on.") }),
      // F-keys from the chat's context block resolve to the athlete's fact ids in code.
      async prepare(ctx, a: { goal: string; horizon: string; why_now: string; fact_ids: string[] }) {
        if (!ctx.turn) return { args: a };
        const ids = resolveFactKeys(ctx, a.fact_ids);
        return ids.length ? { args: { ...a, fact_ids: ids } } : { error: "none of those keys are facts in this conversation" };
      },
      execute: (ctx, a: { goal: string; horizon: string; why_now: string; fact_ids: string[] }) => guarded(() => suggestGoal(ctx.athleteId, { goal: a.goal, horizon: a.horizon, whyNow: a.why_now, factIds: a.fact_ids, runId: ctx.runId }, deps())),
      card: changeCard,
    },
    {
      name: "refresh_plan",
      description: "Ask for a fresh plan (\"plan my week\"): recommended goals, game plans, this week's actions and their post kits are rewritten in the background, within the plan's weekly limits. Optionally about one goal. Started: say you're on it and that you'll tell them here when it's done (a progress card shows; they can leave). Refused: say why from the facts it returns, in the same turn.",
      kind: "ours", permission: "draft",
      args: z.object({ goal_id: id.optional() }),
      prepare: stripIds,
      async execute(ctx, a: { goal_id?: string }) {
        // kick: false — the chat turn never waits for the plan; it runs in the background (the minute tick is the backstop).
        const r = await requestPlanRefresh(ctx.athleteId, { trigger: "chat", reason: "asked in the chat", goalId: a.goal_id ?? null, immediate: true, kick: false, conversationId: ctx.turn?.conversationId ?? null }, { store });
        // An error says so and nothing more (no further store read for a request that just failed).
        if (!r.started && r.reason === "error") return errorResult(`the plan was not refreshed: ${JSON.stringify({ refused: "error" })}`);
        if (!r.started) return errorResult(`the plan was not refreshed: ${JSON.stringify(await refusalFacts(store, ctx.athleteId, r.reason))}`);
        if (!r.joined) kickInBackground(r.runId);
        const { agentPostKitsEnabled } = await import("../postKit/config");
        return okResult({ started: true, joined: r.joined, plan_run_id: r.runId, post_kits: agentPostKitsEnabled() });
      },
      card: (result, ctx) => {
        const r = result as { status?: string; plan_run_id?: unknown; post_kits?: unknown } | null;
        return r?.status === "ok" && typeof r.plan_run_id === "string" ? planProgressCard(r.plan_run_id, ctx, r.post_kits === true) : null;
      },
    },
  ];
}
