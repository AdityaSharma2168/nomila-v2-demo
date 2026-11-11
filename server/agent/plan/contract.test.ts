/**
 * contract.test.ts — the Goals and Home prototypes (draft PR #900) against the plan step's response types
 * (shared/plan.ts AgentGoalsResponse). Contract first: every field the screens read must come from a served field, and
 * every field with no data source is listed here — reported, never invented.
 *
 *   C1 type level (tsc -p tsconfig.jest.json): pure adapters from the response to #900's proto shapes type-check, and
 *      the proto fields they cannot fill are pinned by name (Equals<…>)
 *   C2 the response's goals ARE the client's AgentGoal (client/lib/agent/types.ts): the shipped Goals screen reads them
 *   C3 each #900 persona's fixture objects, expressed as an AgentGoalsResponse (typed: they must fit it), map back to
 *      the fixture exactly on every sourced field
 *   C4 the unsourced list: exactly these proto fields / values have no data source today
 *   C5 a goal's domain (0119, plan 1.1.0) is served from the client's own domain list, and its card category is the
 *      client's DOMAIN_MARK
 */
jest.mock("../../db", () => ({ db: {} }));

import type { AgentGoal } from "../../../client/lib/agent/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GOAL_DOMAINS, type GoalDomain, type GoalHorizon } from "../../../shared/agent";
import { OPPORTUNITY_DOMAINS } from "../../services/intelligence/contracts/opportunity";
import {
  AGENT_GOALS_CONTRACT, GOAL_DOMAIN_MARK, PLAN_BUTTON_LABELS,
  type AgentGoalsResponse, type ComingUpItem, type GoalActionView, type GoalView, type PlanButton, type RecommendedGoalView,
} from "../../../shared/plan";
import {
  PR900_GOALS_PERSONAS, type ProtoAction, type ProtoEvent, type ProtoGoal, type ProtoGoalPlan, type ProtoGoalsPersona, type ProtoKey,
  type ProtoRecommendedGoal,
} from "./pr900Fixtures";

// ─── C1: adapters (response → proto) and the fields they cannot fill ────────────────────────────────────────────────

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** Home · Coming up. `place` has no source: a dated fact carries a date and a subject, not a venue. */
type EventUnsourced = "place";
function toProtoEvent(c: ComingUpItem): Omit<ProtoEvent, EventUnsourced> {
  return { id: c.factId, title: c.label, date: c.date, ready: c.actionsReady };
}

/** One of this week's actions, timed to an event ("Before <event> on <date>"). Every field is sourced. */
type ActionUnsourced = never;
function toProtoAction(a: GoalActionView): Omit<ProtoAction, ActionUnsourced> | null {
  if (!a.event) return null;                      // the prototype only draws actions timed to an event
  return { id: a.id, title: a.title, event: a.event.label, date: a.event.date, action: a.buttonLabel };
}

/** A goal card's game plan and actions. Every field is sourced. */
function toProtoGoalPlan(g: GoalView): ProtoGoalPlan {
  return { goalId: g.id, gamePlan: g.plan ?? "", actions: g.actions.map(toProtoAction).filter((x): x is ProtoAction => !!x) };
}

/** The card category (#900's `domain`: performance / commercial / audience / impact / positioning) of a served domain. */
const markOf = (d: GoalDomain | null): string => (d ? GOAL_DOMAIN_MARK[d] : "");

/**
 * A recommended goal. `domain` is sourced since plan 1.1.0 (the card shows its category). `horizon` is sourced but in
 * another vocabulary (now | next | later, not #900's Objective periods).
 */
type RecommendedUnsourced = "horizon";
function toProtoRecommended(r: RecommendedGoalView): Omit<ProtoRecommendedGoal, RecommendedUnsourced> & { horizon: GoalHorizon } {
  return { id: r.decisionId, domain: markOf(r.domain), text: r.goal, why: r.why, horizon: r.horizon };
}

/** A goal held. `domain` is memory_goals.domain (0119); `horizon` is now | next | later; `hers` is "in your words". */
type GoalUnsourced = "horizon";
function toProtoGoal(g: GoalView): Omit<ProtoGoal, GoalUnsourced> & { horizon: GoalHorizon | null } {
  return { id: g.id, domain: markOf(g.domain), text: g.text, hers: g.inYourWords, horizon: g.horizon };
}

// Pinned: if a proto field gains (or loses) a source, these stop compiling until the list here is updated.
const _pins: [
  Equals<Exclude<keyof ProtoEvent, keyof ReturnType<typeof toProtoEvent>>, EventUnsourced>,
  Equals<Exclude<keyof ProtoAction, keyof NonNullable<ReturnType<typeof toProtoAction>>>, ActionUnsourced>,
  Equals<Exclude<keyof ProtoRecommendedGoal, keyof ReturnType<typeof toProtoRecommended>>, never>,
  Equals<Exclude<keyof ProtoGoal, keyof ReturnType<typeof toProtoGoal>>, never>,
] = [true, true, true, true];
void _pins;

// ─── C3: the fixture objects as a response (they must fit the response types) ──────────────────────────────────────

/** The plan's button whose fixed label is the prototype's action word, or null when no button says it. */
/** A served domain whose card category is the prototype's (the first in the list), or null when none is. */
const domainFor = (mark: string): GoalDomain | null => GOAL_DOMAINS.find((d) => GOAL_DOMAIN_MARK[d] === mark) ?? null;

const buttonFor = (label: string): PlanButton | null => (Object.entries(PLAN_BUTTON_LABELS).find(([, l]) => l === label)?.[0] as PlanButton | undefined) ?? null;

function asResponse(p: ProtoGoalsPersona): { response: AgentGoalsResponse; unsourcedValues: string[] } {
  const unsourcedValues: string[] = [];
  const action = (a: ProtoAction): GoalActionView => {
    const button = buttonFor(a.action);
    if (!button) unsourcedValues.push(`ProtoAction.action "${a.action}"`);
    return {
      id: a.id, title: a.title, kind: "task", when: null, state: "made", studioItemId: null, open: null, startPrompt: null,
      planKind: "other", why: "", button: button ?? "review", buttonLabel: button ? PLAN_BUTTON_LABELS[button] : a.action,
      dueOn: a.date, event: { factId: `fact:${a.event}`, label: a.event, date: a.date, precision: "day" },
      deliverable: { type: "checklist", title: a.title, body: "", target: null, platform: null, thread: null, connector: null }, approvalId: null,
    } satisfies GoalActionView;
  };
  const goals: GoalView[] = p.goals.map((g) => {
    const plan = p.plans.find((x) => x.goalId === g.id);
    return {
      id: g.id, text: g.text, plan: plan?.gamePlan ?? null, horizon: null, domain: domainFor(g.domain), actions: (plan?.actions ?? []).map(action), status: "active",
      source: g.hers ? "said" : "proposed_accepted", gamePlanBy: "mila", inYourWords: g.hers, priority: null, nextEvent: null,
    } satisfies GoalView;
  });
  const recommended: RecommendedGoalView[] = p.recommended.map((r) => ({
    decisionId: r.id, goal: r.text, horizon: "next", domain: domainFor(r.domain), why: r.why, value: "", valueRange: null, valueConfidence: "low", nextDecision: "",
    gamePlan: null, factIds: [], sources: [], actions: [],
  } satisfies RecommendedGoalView));
  const comingUp: ComingUpItem[] = p.comingUp.map((e) => ({ date: e.date, precision: "day", label: e.title, factId: e.id, goalId: null, actionsReady: e.ready } satisfies ComingUpItem));
  const response: AgentGoalsResponse = {
    contract: AGENT_GOALS_CONTRACT, goals, setAside: [], recommended, comingUp, riskUpside: { risk: p.risk, upside: p.upside }, missing: [], plan: null,
  };
  return { response, unsourcedValues };
}

const PERSONAS = Object.keys(PR900_GOALS_PERSONAS) as ProtoKey[];

describe("the plan step's response serves #900's Goals and Home prototypes", () => {
  test("C2: the served goals are the client's AgentGoal (the shipped Goals screen reads them as they are)", () => {
    const { response } = asResponse(PR900_GOALS_PERSONAS.college);
    const asClient: AgentGoal[] = response.goals;                       // type-checked: GoalView ⊇ AgentGoal
    expect(asClient.map((g) => [g.id, g.text, g.plan, g.actions.length])).toEqual([
      ["g-c1", "Land my first paid partnership this season.", "Pitch two brands that already reach your audience, timed to the home opener.", 2],
      ["g-c2", "Grow my audience on [Platform B].", "Three posts around match days, one behind-the-scenes.", 1],
      ["g-c3", "Make my clinics part of my public story.", "Tell the clinic story once, in your words, on your page.", 0],
    ]);
  });

  test.each(PERSONAS)("C3: %s — every sourced field maps back to the fixture exactly", (key) => {
    const p = PR900_GOALS_PERSONAS[key];
    const { response } = asResponse(p);
    // Home · Coming up (≤ 3, soonest first — the fixtures already are).
    expect(response.comingUp.length).toBeLessThanOrEqual(3);
    expect(response.comingUp.map(toProtoEvent)).toEqual(p.comingUp.map(({ place: _place, ...e }) => e));
    // Goals tab: upside and risk once above the goals.
    expect(response.riskUpside).toEqual({ upside: p.upside, risk: p.risk });
    // Each goal card: the game plan and this week's actions, each timed to its event.
    expect(response.goals.map(toProtoGoalPlan)).toEqual(p.goals.map((g) => p.plans.find((x) => x.goalId === g.id) ?? { goalId: g.id, gamePlan: "", actions: [] }));
    expect(response.goals.map(toProtoGoal)).toEqual(p.goals.map(({ horizon: _h, ...g }) => ({ ...g, horizon: null })));
    // Recommended for you.
    expect(response.recommended.map(toProtoRecommended).map(({ horizon: _h, ...r }) => r)).toEqual(p.recommended.map(({ horizon: _h, ...r }) => r));
    // At most 3 actions per goal.
    for (const g of response.goals) expect(g.actions.length).toBeLessThanOrEqual(3);
  });

  test("C4: the fields and values with no data source today — reported, not invented", () => {
    const values = [...new Set(PERSONAS.flatMap((k) => asResponse(PR900_GOALS_PERSONAS[k]).unsourcedValues))];
    // "Set" (Set your floor rate) is no plan button: the buttons are Send · I'll post it · Review · Connect · Start with Mila.
    expect(values).toEqual(['ProtoAction.action "Set"']);
    const UNSOURCED_FIELDS: string[] = [
      "ProtoEvent.place",                    // a dated fact has no venue field
      "ProtoGoal.horizon / ProtoRecommendedGoal.horizon: this_season | next_12_months | multi_year (served: now | next | later)",
    ];
    expect(UNSOURCED_FIELDS).toHaveLength(2);
  });

  test("C5: the goal domains are the client's and the Objective's; each card category is the client's DOMAIN_MARK", () => {
    expect([...GOAL_DOMAINS].sort()).toEqual(OPPORTUNITY_DOMAINS.filter((d) => d !== "evidence").sort());
    const src = readFileSync(join(__dirname, "..", "..", "..", "client", "components", "strategy", "RecommendationVisual.tsx"), "utf8");
    const block = (name: string) => /\{([^}]*)\}/.exec(src.slice(src.indexOf(`export const ${name}`)))![1];
    const pairs = (b: string) => Object.fromEntries([...b.matchAll(/(\w+):\s*"([\w-]+)"/g)].map((m) => [m[1], m[2]]));
    expect(pairs(block("DOMAIN_MARK"))).toEqual(GOAL_DOMAIN_MARK);
    expect(Object.keys(pairs(block("DOMAIN_ICON"))).sort()).toEqual([...GOAL_DOMAINS].sort());
  });
});
