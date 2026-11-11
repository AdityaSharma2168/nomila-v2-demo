/**
 * agent/plan/validate.ts — the code checks after the plan call (design "Code checks after the call"). Pure: no
 * database, no clock (today comes in), so every rule is unit-tested on its own.
 *
 *   - every recommended goal and action rests on ≥ 1 real, non-removed fact key (F… or E…); unknown keys are dropped,
 *     then items with none are held; a PERSONAL care fact never supports a goal or an action (dropped from its keys)
 *   - caps: 3 recommended goals, 3 actions per goal of every kind but post, 2 plan lines (≤ 160 chars), goal ≤ 90 chars,
 *     action title ≤ 60
 *   - plan 1.5.0, the week: posts are never capped per goal — the week's one number is their only limit. `week` is read
 *     (posts, target, stories ≥ 0, whole, ≤ 21; why); post actions past `week.posts` (stories past `week.stories`) are
 *     held, and with no `week` the sane ceiling (21 a week) holds
 *   - plan 1.5.0: a recommended goal's `repeats` is one of GOAL_REPEATS, else "once" (never guessed)
 *   - no recommendation that repeats an active or paused goal, or one skipped or dropped in the last 90 days
 *   - goal_ref is an active goal id (G:<uuid>) or an R-key from this output
 *   - reply needs a thread_ref from the input; connect needs a connector marked can-offer
 *   - event_ref is an E-key from the input, and due_on falls on or before the event's date (a month-only event: before
 *     the month starts; a year-only event: before the year starts); a due_on before today is held
 *   - plan 1.7.0: a post_brief carries its caption, tags and shots as fields of their own (postPartsOf); they are words
 *     the athlete reads, so they pass every check the body does
 *   - deliverable text passes findNeverContent (contact formats, never-use names); pitches skip brands named in the
 *     athlete's avoid-list or in what an exclusivity / category conflict blocks (Understand's internal read, 1.9.0)
 *   - a goal's domain is one of GOAL_DOMAINS, else null (never guessed)
 *   - care facts may support timing in `why`, never appear in a deliverable (no run of five words from a care claim)
 *   - money in a value only with its drivers; value confidence "low" without measured facts
 *   - keys never reach text the athlete reads; text that says "AI" or "brain" is held
 *   - plan 1.3.0, the idea bank:
 *     a post's idea (`post`) needs a hook, a format from the list and what to show, and passes the same never-content,
 *     care and copy checks as the deliverable (else it is dropped, the action kept); `idea_ref` is an I-key (a bank
 *     idea, reused) or an X-key (a missed timely idea, adapted — only with an event_ref to time it to), each idea used
 *     once; a post timed to a moment with no idea named takes that moment's own bank entry; a post with neither an idea
 *     nor an event is a fresh evergreen idea and needs its `post` to be filed; `pillar_ref` is a P-key from the input or
 *     nothing; `idea_moves` skip an I-key or adapt an X-key to an E-key, never an idea an action uses. A bad ref never
 *     holds the action: the ref is dropped and the reason recorded — except a SECOND post action citing an idea another
 *     action of this plan already uses (plan 1.3.1, one idea one post): that action is held whole
 * Held items (and dropped refs) and their reasons are returned (agent_runs.output.held).
 */
import type { Decision, Goal, GoalHorizon, MemoryFact } from "../../../shared/agent";
import { GOAL_DOMAINS, GOAL_HORIZONS, GOAL_REPEATS, type GoalDomain, type GoalRepeats } from "../../../shared/agent";
import type { ExclusivityConflict } from "../research/store";
import {
  GOAL_NOTE_SUGGESTIONS, MISSING_UNLOCKS, PLAN_ACTION_KINDS, PLAN_BUTTONS, PLAN_CAPS, PLAN_CONTRACT, PLAN_DELIVERABLE_TYPES,
  PLAN_STAGE_BANDS, VALUE_CONFIDENCES,
  type PlanAction, type PlanDeliverable, type PlanEventRef, type PlanGamePlan, type PlanGoalRef, type PlanHeld, type PlanIdeaMove,
  type PlanPillarRef, type PlanPostIdea, type PlanPostSource, type PlanRecommendedGoal, type PlanValue, type PlanWeek, type ValidatedPlan,
} from "../../../shared/plan";
import { POST_FORMATS, POST_KIT_CAPTION_CHARS, type PostFormat } from "../../../shared/postKit";
import { ideaWords, pillarOfIdea, type BankIdea } from "../ideaBank/bank";
import { findNeverContent } from "../policy";
import { captionField, hashtagList, splitTags } from "../postKit/caption";
import { periodEnd } from "../moments/facts";
import { MOMENTS_SKILL_ID } from "../moments/config";
import { PLAN } from "./config";

/** A dated event as the plan saw it (an E-key). */
export interface PlanEvent extends PlanEventRef {
  fact: MemoryFact;
}

/** An open thread waiting on the athlete (a T-key). */
export interface OpenThread {
  opportunityId: string;
  threadId: string | null;
  brand: string;
  line: string;
  since: string | null;
}

/** Everything the checks need, keyed exactly as the model saw it. */
export interface PlanCheckContext {
  /** YYYY-MM-DD. */
  today: string;
  facts: Map<string, MemoryFact>;
  events: Map<string, PlanEvent>;
  threads: Map<string, OpenThread>;
  /** Every goal the athlete has, dropped ones included (for the quiet period). */
  goals: Goal[];
  /** Decisions of the last 90 days (skipped recommendations are not repeated). */
  decisions: Decision[];
  /** Connector ids that may be offered now (not connected). */
  offerableConnectors: string[];
  /** Every connector id in the catalog. */
  connectorIds: string[];
  neverTerms: string[];
  /** Active "avoid" preference statements, in the athlete's words. */
  avoid: string[];
  /** The exclusivity and category conflicts (Understand's internal read): a pitch to what one blocks is held. */
  conflicts: ExclusivityConflict[];
  /** True when measured (connected-account) facts exist. */
  hasMeasured: boolean;
  /** plan 1.3.0: the idea bank and the content pillars as the model saw them (NO_BANK in tests that leave it out). */
  bank: PlanBankContext;
}

/** The idea bank's keys as the plan saw them (agent/ideaBank/bank.ts planBank, planPillars). */
export interface PlanBankContext {
  on: boolean;
  /** I-keys → bank ideas the plan may reuse. */
  ideas: ReadonlyMap<string, BankIdea>;
  /** X-keys → missed timely ideas the plan may adapt. */
  missed: ReadonlyMap<string, BankIdea>;
  /** P-keys → the Brief's content pillars. */
  pillars: ReadonlyMap<string, PlanPillarRef>;
  /** An event's fact id → its pending moment decision, when the store has one (what an adapted idea is bound to). */
  momentByFact: ReadonlyMap<string, string>;
}

/** The idea bank switched off: nothing to reuse, adapt or file. */
export const NO_BANK: PlanBankContext = { on: false, ideas: new Map(), missed: new Map(), pillars: new Map(), momentByFact: new Map() };

const LEAKED_KEYS = /\s*[(\[]\s*(?:(?:[FETRIXP]\d+|G:[0-9a-f-]{36})\s*(?:,|and)?\s*)+[)\]]/g;
const GOAL_KEYS = /\bG:[0-9a-f-]{36}\b/gi;
/**
 * Strip any key the model leaked into text the athlete reads: bracketed key lists, goal refs, and the bare keys this
 * input actually used (`known`) — only those, so "F1" in a sentence about something else survives when no F1 was given.
 */
export function stripPlanKeys(text: string, known: ReadonlySet<string> = new Set()): string {
  let s = String(text ?? "").replace(LEAKED_KEYS, "").replace(GOAL_KEYS, "");
  if (known.size) s = s.replace(/\b[FETRIXP]\d+\b/g, (k) => (known.has(k) ? "" : k));
  return s.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

/** Copy rule: Nomila never calls itself (or Mila) "AI" or a "brain". */
export const BANNED_WORDS = /\bAI\b|\bA\.I\.|\bbrains?\b/;

const STOP = new Set(["a", "an", "the", "my", "your", "to", "of", "and", "or", "for", "in", "on", "with", "at", "by", "this", "that", "be", "get", "make", "more", "first"]);
const tokens = (s: string) => new Set(s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter((t) => t && !STOP.has(t)));
/** Two goal wordings say the same thing: one contains the other, or their content words mostly overlap. */
export function sameGoal(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const ta = tokens(x);
  const tb = tokens(y);
  if (!ta.size || !tb.size) return false;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / (ta.size + tb.size - inter) >= 0.6;
}

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
let KNOWN: ReadonlySet<string> = new Set();
const str = (v: unknown, max = 2000) => (typeof v === "string" ? stripPlanKeys(v, KNOWN).slice(0, max) : "");
const oneOf = <T extends string>(values: readonly T[], v: unknown, fallback: T): T => ((values as readonly string[]).includes(String(v)) ? (v as T) : fallback);
/** A goal's domain from the list, or null: never guessed. */
const domainOf = (v: unknown): GoalDomain | null => ((GOAL_DOMAINS as readonly string[]).includes(String(v)) ? (v as GoalDomain) : null);

/** Pitching this target is blocked by a conflict: its name appears in what the conflict blocks. */
export function blockedBy(target: string, conflicts: readonly ExclusivityConflict[]): ExclusivityConflict | null {
  const name = target.trim().toLowerCase();
  if (name.length < 2) return null;
  return conflicts.find((c) => (c.blocks ?? []).some((b) => {
    const blocks = String(b ?? "").toLowerCase();
    return blocks.length >= 2 && (blocks.includes(name) || name.includes(blocks));
  })) ?? null;
}

/** A care fact is personal unless marked conduct (null = personal, the stricter rule). */
const personalCare = (f: MemoryFact) => !!f.sensitive && f.careKind !== "conduct";

/** Five consecutive words of a care claim appearing in the text. */
export function carriesCareText(text: string, careFacts: readonly Pick<MemoryFact, "claim">[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const t = ` ${norm(text)} `;
  for (const f of careFacts) {
    const w = norm(f.claim).split(" ").filter(Boolean);
    for (let i = 0; i + 5 <= w.length; i++) if (t.includes(` ${w.slice(i, i + 5).join(" ")} `)) return true;
  }
  return false;
}

/**
 * The last date an action for this event may be due on: the day itself, or — for a month- or year-only event — the day
 * before its period starts. When that period has already started by `today` (a month-only moment in the current month),
 * there is no "before" left: the action may be due through the period's end.
 */
export function lastDueFor(e: PlanEventRef, today?: string): string {
  if (e.precision !== "month" && e.precision !== "year") return e.date;
  const d = new Date(e.precision === "year" ? `${e.date.slice(0, 4)}-01-01T00:00:00Z` : `${e.date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const before = d.toISOString().slice(0, 10);
  return today && before < today ? periodEnd(e.date, e.precision) : before;
}

export interface ValidationResult {
  plan: ValidatedPlan;
  held: PlanHeld[];
}

export function validatePlan(raw: any, ctx: PlanCheckContext): ValidationResult {
  const j = raw && typeof raw === "object" ? raw : {};
  // The keys this input used: only these are stripped as bare words from athlete-facing text.
  KNOWN = new Set([...ctx.facts.keys(), ...ctx.events.keys(), ...ctx.threads.keys(), "R1", "R2", "R3", ...ctx.bank.ideas.keys(), ...ctx.bank.missed.keys(), ...ctx.bank.pillars.keys()]);
  const held: PlanHeld[] = [];
  const hold = (what: string, reason: string) => held.push({ what: what.slice(0, 120), reason });

  const careFacts = [...ctx.facts.values(), ...[...ctx.events.values()].map((e) => e.fact)].filter((f) => f.sensitive);
  /** Keys → real, usable fact ids (F… and E…; never removed; never a personal care fact). */
  const factIds = (keys: unknown): string[] => {
    const out: string[] = [];
    for (const k of Array.isArray(keys) ? keys.map(String) : []) {
      const f = ctx.facts.get(k) ?? ctx.events.get(k)?.fact;
      if (!f || f.status === "removed" || f.status === "superseded" || personalCare(f)) continue;
      if (!out.includes(f.id)) out.push(f.id);
    }
    return out;
  };
  const banned = (...texts: string[]) => texts.some((t) => BANNED_WORDS.test(t));

  const activeGoals = ctx.goals.filter((g) => g.status === "active");
  const heldGoals = ctx.goals.filter((g) => g.status === "active" || g.status === "paused");
  const quietSince = new Date(Date.parse(`${ctx.today}T00:00:00Z`) - PLAN.QUIET_DAYS * 86_400_000).toISOString();
  const recentlyDropped = ctx.goals.filter((g) => g.status === "dropped" && g.updatedAt >= quietSince);
  const recentlySkipped = ctx.decisions.filter((d) => (d.kind ?? "other") === "goal" && d.response === "skipped" && (d.respondedAt ?? d.createdAt) >= quietSince);
  // A recommendation Mila made in the chat (suggest_goal) that is still waiting: the plan does not repeat it. The plan's
  // own pending recommendations are not here — a repeat of one of those keeps that decision (apply.ts).
  const waitingElsewhere = ctx.decisions.filter((d) => (d.kind ?? "other") === "goal" && d.response === "pending" && d.skillId !== "plan");

  // ── recommended goals ──────────────────────────────────────────────────────────────────────────────────────────
  const recommendedGoals: PlanRecommendedGoal[] = [];
  const rawGoals = Array.isArray(j.recommended_goals) ? j.recommended_goals : [];
  for (const g of rawGoals) {
    const goal = str(g?.goal, 500);
    const label = goal || "a recommended goal";
    if (recommendedGoals.length >= PLAN_CAPS.recommendedGoals) { hold(label, "cap: 3 recommended goals"); continue; }
    const key = typeof g?.key === "string" && /^R[1-3]$/.test(g.key) ? g.key : `R${recommendedGoals.length + 1}`;
    if (!goal) { hold(label, "no goal text"); continue; }
    if (goal.length > PLAN_CAPS.goalChars) { hold(label, `goal over ${PLAN_CAPS.goalChars} characters`); continue; }
    if (recommendedGoals.some((r) => r.key === key)) { hold(label, `duplicate key ${key}`); continue; }
    const ids = factIds(g?.fact_keys);
    if (!ids.length) { hold(label, "rests on no real fact"); continue; }
    // The model's own duplicate flag: a repeat of a goal held, or of one dropped inside the quiet period, is held.
    const similarId = typeof g?.similar_to_goal_id === "string" ? g.similar_to_goal_id.replace(/^G:/, "") : null;
    if (similarId && [...heldGoals, ...recentlyDropped].some((x) => x.id === similarId)) { hold(label, "the model flagged it as a repeat of a goal you have"); continue; }
    if (heldGoals.some((x) => sameGoal(x.text, goal))) { hold(label, "repeats a goal you hold"); continue; }
    if (recentlyDropped.some((x) => sameGoal(x.text, goal))) { hold(label, "you dropped it in the last 90 days"); continue; }
    if (recentlySkipped.some((d) => sameGoal(d.suggested, goal))) { hold(label, "you skipped it in the last 90 days"); continue; }
    if (recommendedGoals.some((r) => sameGoal(r.goal, goal))) { hold(label, "repeats another recommendation in this plan"); continue; }
    if (waitingElsewhere.some((d) => sameGoal(d.suggested, goal))) { hold(label, "repeats a recommendation already waiting for you"); continue; }
    const whyNow = str(g?.why_now, 1000);
    const nextDecision = str(g?.next_decision, 500);
    const value = valueOf(g?.value);
    if (banned(goal, whyNow, nextDecision, value.text)) { hold(label, "copy rule: never \"AI\" or \"brain\""); continue; }
    recommendedGoals.push({
      key, goal, horizon: oneOf<GoalHorizon>(GOAL_HORIZONS, g?.horizon, "next"), domain: domainOf(g?.domain), whyNow, value,
      valueConfidence: ctx.hasMeasured ? oneOf(VALUE_CONFIDENCES, g?.value_confidence, "low") : "low",
      nextDecision, factIds: ids, similarToGoalId: similarId && ctx.goals.some((x) => x.id === similarId) ? similarId : null,
      repeats: oneOf<GoalRepeats>(GOAL_REPEATS, g?.repeats, "once"),
    });
  }
  if (rawGoals.length && !recommendedGoals.length) hold("recommended goals", "none survived the checks");

  // ── goal refs ──────────────────────────────────────────────────────────────────────────────────────────────────
  const refOf = (v: unknown): PlanGoalRef | null => {
    const s = String(v ?? "").trim();
    const g = /^G:(.+)$/.exec(s);
    if (g) return activeGoals.some((x) => x.id === g[1]) ? { kind: "goal", goalId: g[1] } : null;
    return recommendedGoals.some((r) => r.key === s) ? { kind: "recommended", key: s } : null;
  };
  const refKey = (r: PlanGoalRef) => (r.kind === "goal" ? `G:${r.goalId}` : r.key);

  // ── game plans ─────────────────────────────────────────────────────────────────────────────────────────────────
  const gamePlans: PlanGamePlan[] = [];
  for (const p of Array.isArray(j.game_plans) ? j.game_plans : []) {
    const ref = refOf(p?.goal_ref);
    if (!ref) { hold(`game plan for ${String(p?.goal_ref ?? "?").slice(0, 50)}`, "goal_ref is not an active goal or a recommendation of this plan"); continue; }
    if (gamePlans.some((x) => refKey(x.goalRef) === refKey(ref))) { hold(`game plan for ${refKey(ref)}`, "a second game plan for the same goal"); continue; }
    const rawLines = (Array.isArray(p?.lines) ? p.lines : []).map((l: unknown) => str(l, 1000)).filter(Boolean);
    if (rawLines.length > PLAN_CAPS.planLines) hold(`game plan for ${refKey(ref)}`, `cap: ${PLAN_CAPS.planLines} lines (kept the first)`);
    const lines = rawLines.slice(0, PLAN_CAPS.planLines).map((l: string) => (l.length > PLAN_CAPS.planLineChars ? `${l.slice(0, PLAN_CAPS.planLineChars - 1).trimEnd()}…` : l));
    if (!lines.length) continue;
    if (banned(...lines)) { hold(`game plan for ${refKey(ref)}`, "copy rule: never \"AI\" or \"brain\""); continue; }
    const goal = ref.kind === "goal" ? activeGoals.find((x) => x.id === ref.goalId)! : null;
    // The athlete's own game plan is never rewritten: whatever the model echoed, the stored text is theirs.
    const athletes = goal?.gamePlanBy === "athlete";
    gamePlans.push({ goalRef: ref, domain: domainOf(p?.domain), lines: athletes ? [goal!.gamePlan ?? ""].filter(Boolean) : lines, keptAthleteText: athletes });
  }

  // ── the week (plan 1.5.0) ──────────────────────────────────────────────────────────────────────────────────────
  const week = weekOf(j.week, str);
  const postCap = Math.min(week?.posts ?? PLAN_CAPS.postsPerWeek, PLAN_CAPS.postsPerWeek);
  const storyCap = Math.min(week?.stories ?? PLAN_CAPS.storiesPerWeek, PLAN_CAPS.storiesPerWeek);
  let posts = 0;
  let stories = 0;

  // ── actions ────────────────────────────────────────────────────────────────────────────────────────────────────
  const actions: PlanAction[] = [];
  const perGoal = new Map<string, number>();
  // Bank ideas already claimed by an action or a move of this plan: each idea is used once.
  const taken = new Set<string>();
  /** Text that may not be copied into the bank or a post: never-content, care text, "AI" / "brain". */
  const unsafe = (text: string) => findNeverContent(text, ctx.neverTerms).length > 0 || carriesCareText(text, careFacts) || banned(text);
  const pillarRefOf = (v: unknown): PlanPillarRef | null => ctx.bank.pillars.get(String(v ?? "").trim()) ?? null;
  /**
   * Where a post's idea comes from. An I-key reuses a bank idea (a timely one only on a post timed to its own event); an
   * X-key adapts a missed timely idea to this action's event (and needs one, and its copied words must pass the checks);
   * a ref that fails is dropped into `held`. With no usable ref, a post timed to no event is a fresh evergreen idea
   * (filed only with its `post`), and a post timed to an event takes that moment's own bank entry when it has one (else
   * no bank source).
   */
  const sourceOf = (a: any, label: string, event: PlanEventRef | null, post: PlanPostIdea | null): PlanPostSource | null => {
    const key = typeof a?.idea_ref === "string" ? a.idea_ref.trim() : "";
    const pillarRef = pillarRefOf(a?.pillar_ref);
    if (key) {
      const idea = ctx.bank.ideas.get(key) ?? ctx.bank.missed.get(key);
      const adapting = ctx.bank.missed.has(key);
      // A timely bank idea belongs to its own event: on a post timed to another event, or to none, it is not that idea.
      const offEvent = !!idea && !adapting && idea.entry.timeBound && (!event || idea.eventFactId !== event.factId);
      if (!idea) hold(`idea for ${label}`, `idea_ref ${key.slice(0, 20)} is not an idea from the input (dropped)`);
      else if (adapting && !event) hold(`idea for ${label}`, `adapting ${key} needs the later event it is for (dropped)`);
      else if (offEvent) hold(`idea for ${label}`, `idea_ref ${key} is a timely idea for another event (dropped)`);
      else if (adapting && !post && unsafe(ideaWords(idea.entry))) hold(`idea for ${label}`, `adapting ${key} would copy never-content, a care fact or "AI"/"brain" (dropped)`);
      else {
        taken.add(idea.decisionId);
        return {
          from: adapting ? "adapted" : "bank", ideaId: idea.decisionId, pillar: pillarOfIdea(idea.entry, ctx.bank.pillars) ?? pillarRef,
          momentDecisionId: adapting ? ctx.bank.momentByFact.get(event!.factId) ?? null : null,
        };
      }
    }
    if (event) {
      // A post timed to a moment, with no idea named: it is that moment's own idea (its bank entry), when it has one.
      const own = [...ctx.bank.ideas.values()].find((b) => b.skillId === MOMENTS_SKILL_ID && b.eventFactId === event.factId && !taken.has(b.decisionId));
      if (!own) return null;
      taken.add(own.decisionId);
      return { from: "bank", ideaId: own.decisionId, pillar: null, momentDecisionId: null };
    }
    if (!post) { hold(`idea for ${label}`, "a fresh evergreen post needs its idea (post) to go in the idea bank (not filed)"); return null; }
    return { from: "fresh", ideaId: null, pillar: pillarRef, momentDecisionId: null };
  };
  const avoidText = ctx.avoid.join(" \n ").toLowerCase();
  for (const a of Array.isArray(j.actions) ? j.actions : []) {
    const what = str(a?.what, 500);
    const label = what || "an action";
    const ref = refOf(a?.goal_ref);
    if (!ref) { hold(label, "goal_ref is not an active goal or a recommendation of this plan"); continue; }
    const kind = oneOf(PLAN_ACTION_KINDS, a?.kind, "other");
    // Posts are never capped per goal (plan 1.5.0): the week's number is their limit, checked once the post is whole.
    const n = perGoal.get(refKey(ref)) ?? 0;
    if (kind !== "post" && n >= PLAN_CAPS.actionsPerGoal) { hold(label, `cap: ${PLAN_CAPS.actionsPerGoal} actions per goal (posts aside)`); continue; }
    if (!what) { hold(label, "no title"); continue; }
    if (what.length > PLAN_CAPS.actionTitleChars) { hold(label, `title over ${PLAN_CAPS.actionTitleChars} characters`); continue; }
    const button = oneOf(PLAN_BUTTONS, a?.button, "start");
    const ids = factIds(a?.fact_keys);
    if (!ids.length) { hold(label, "rests on no real fact"); continue; }

    // The dated event it is timed before, and its due date.
    let event: PlanEventRef | null = null;
    if (a?.event_ref != null && a.event_ref !== "") {
      const e = ctx.events.get(String(a.event_ref));
      if (!e) { hold(label, `event_ref ${String(a.event_ref).slice(0, 20)} is not a dated event from the input`); continue; }
      event = { factId: e.factId, label: e.label, date: e.date, precision: e.precision };
    }
    let dueOn: string | null = null;
    if (a?.due_on != null && a.due_on !== "") {
      const due: unknown = a.due_on;
      if (!isDate(due)) { hold(label, "due_on is not a date"); continue; }
      if (due < ctx.today) { hold(label, "due_on is in the past"); continue; }
      if (event && due > lastDueFor(event, ctx.today)) { hold(label, `due_on ${due} falls after the event (${event.date})`); continue; }
      dueOn = due;
    }

    // The deliverable.
    const d = a?.deliverable ?? {};
    let thread: PlanDeliverable["thread"] = null;
    if (kind === "reply" || d.thread_ref) {
      const t = ctx.threads.get(String(d.thread_ref ?? ""));
      if (!t) { if (kind === "reply") { hold(label, "a reply needs a thread from the input"); continue; } }
      else thread = { opportunityId: t.opportunityId, threadId: t.threadId, label: t.brand };
    }
    let connector: string | null = null;
    if (kind === "connect" || d.connector) {
      const c = String(d.connector ?? "");
      if (!ctx.offerableConnectors.includes(c)) { if (kind === "connect") { hold(label, `connect needs a connector that can be offered now (${c || "none"})`); continue; } }
      else connector = c;
    }
    const target = d.target && typeof d.target === "object" && typeof d.target.name === "string" && d.target.name.trim()
      ? { subjectKind: oneOf(["brand", "organization", "person", "other"] as const, d.target.subject_kind, "other"), name: d.target.name.trim().slice(0, 200) }
      : null;
    // A post's deliverable is always a post_brief (plan 1.7.0): whatever type the model named, so its caption, tags and
    // shots are always written (postPartsOf) and the kit never falls back to reading a 1.7.0 body for a caption.
    const type = kind === "post" ? "post_brief" : oneOf(PLAN_DELIVERABLE_TYPES, d.type, kind === "pitch" ? "pitch" : kind === "reply" ? "reply_draft" : kind === "connect" ? "connect_request" : "checklist");
    const deliverable: PlanDeliverable = {
      type,
      title: str(d.title, 300), body: str(d.body, 6000), target, platform: typeof d.platform === "string" && d.platform.trim() ? d.platform.trim().slice(0, 60) : null,
      thread, connector,
      // plan 1.7.0: only a post_brief carries the three parts (every other type stays exactly the shape it was).
      ...(type === "post_brief" ? postPartsOf(d, str) : {}),
    };
    const why = str(a?.why, 1000);
    // plan 1.7.0: a post_brief's caption, tags and shots are words the athlete reads too — the same checks as the body.
    const outgoing = [deliverable.title, deliverable.body, deliverable.caption ?? "", (deliverable.hashtags ?? []).join(" "), (deliverable.shots ?? []).join("\n")].join("\n");
    if (findNeverContent(outgoing, ctx.neverTerms).length) { hold(label, "the deliverable carries never-content (contact details or a never-use name)"); continue; }
    if (carriesCareText(outgoing, careFacts)) { hold(label, "a care fact appears in the deliverable"); continue; }
    if (target && (kind === "pitch" || deliverable.type === "pitch")) {
      const name = target.name.toLowerCase();
      if (name.length >= 2 && avoidText.includes(name)) { hold(label, "the pitch target is on your avoid-list"); continue; }
      if (blockedBy(target.name, ctx.conflicts)) { hold(label, "the pitch target is in an exclusivity or category conflict"); continue; }
    }
    if (banned(what, why, outgoing)) { hold(label, "copy rule: never \"AI\" or \"brain\""); continue; }

    // plan 1.3.0: the idea behind a post, and where it comes from (the idea bank).
    let post: PlanPostIdea | null = null;
    if (kind === "post" && a?.post && typeof a.post === "object") {
      post = postIdeaOf(a.post);
      // Held entries only while the bank reads them: with it off, a bad idea is dropped quietly (nothing files it).
      if (!post) { if (ctx.bank.on) hold(`the idea behind ${label}`, "a post's idea needs a hook, a format from the list and what to show (dropped; the action kept)"); }
      else if (unsafe(postWords(post))) {
        if (ctx.bank.on) hold(`the idea behind ${label}`, "the post's idea carries never-content, a care fact or \"AI\"/\"brain\" (dropped; the action kept)");
        post = null;
      }
    }
    // One idea, one post (plan 1.3.1): a second post action citing an idea another action of this plan already uses is
    // held whole — not kept as a fresh post with its ref dropped, which would still be a second post of the same idea.
    if (kind === "post" && ctx.bank.on) {
      const cited = typeof a?.idea_ref === "string" ? a.idea_ref.trim() : "";
      const idea = cited ? ctx.bank.ideas.get(cited) ?? ctx.bank.missed.get(cited) : undefined;
      if (idea && taken.has(idea.decisionId)) { hold(label, `a second post for idea ${cited}: another action in this plan already uses it`); continue; }
    }
    // The week's one number: posts past it (stories past the week's stories) are held.
    const story = kind === "post" && (post?.format ?? a?.post?.format) === "story";
    if (kind === "post" && (story ? stories >= storyCap : posts >= postCap)) {
      hold(label, story ? `the week's stories are full (${storyCap})` : `the week's posts are full (${postCap})`);
      continue;
    }
    const source = kind === "post" && ctx.bank.on ? sourceOf(a, label, event, post) : null;
    if (kind !== "post") perGoal.set(refKey(ref), n + 1);
    else if (story) stories++;
    else posts++;
    actions.push({ goalRef: ref, kind, what, why, dueOn, event, button, deliverable, factIds: ids, post, source });
  }

  // ── idea moves (plan 1.3.0) ────────────────────────────────────────────────────────────────────────────────────
  const ideaMoves: PlanIdeaMove[] = [];
  for (const m of ctx.bank.on && Array.isArray(j.idea_moves) ? j.idea_moves : []) {
    const key = String(m?.idea_ref ?? "").trim();
    const what = `idea ${key.slice(0, 20) || "(no key)"}`;
    if (m?.move === "skip") {
      const idea = ctx.bank.ideas.get(key);
      if (!idea) { hold(what, "skip needs an I-key from the idea bank"); continue; }
      if (taken.has(idea.decisionId)) { hold(what, "an action this plan wrote uses it"); continue; }
      taken.add(idea.decisionId);
      ideaMoves.push({ move: "skip", ideaId: idea.decisionId, event: null, momentDecisionId: null, timing: null, why: str(m?.why, 300) });
    } else if (m?.move === "adapt") {
      const idea = ctx.bank.missed.get(key);
      if (!idea) { hold(what, "adapt needs an X-key from the missed ideas"); continue; }
      if (taken.has(idea.decisionId)) { hold(what, "an action this plan wrote uses it"); continue; }
      const e = ctx.events.get(String(m?.event_ref ?? ""));
      if (!e) { hold(what, "adapt needs the later event it is for (an E-key from the input)"); continue; }
      const timing = str(m?.timing, 200);
      // The adapted row copies the missed idea's words: the same checks as a post's.
      if (unsafe(`${ideaWords(idea.entry)}
${timing}`)) { hold(what, "adapting would copy never-content, a care fact or \"AI\"/\"brain\""); continue; }
      taken.add(idea.decisionId);
      ideaMoves.push({
        move: "adapt", ideaId: idea.decisionId, event: { factId: e.factId, label: e.label, date: e.date, precision: e.precision },
        momentDecisionId: ctx.bank.momentByFact.get(e.factId) ?? null, timing: timing || null, why: str(m?.why, 300),
      });
    } else hold(what, "move is neither skip nor adapt");
  }

  // ── notes, missing, stage ──────────────────────────────────────────────────────────────────────────────────────
  const goalNotes = (Array.isArray(j.goal_notes) ? j.goal_notes : [])
    .map((n: any) => ({ goalId: String(n?.goal_id ?? "").replace(/^G:/, ""), suggest: oneOf(GOAL_NOTE_SUGGESTIONS, n?.suggest, "keep"), why: str(n?.why, 500) }))
    .filter((n: { goalId: string }) => ctx.goals.some((g) => g.id === n.goalId));
  const missing = (Array.isArray(j.missing) ? j.missing : [])
    .map((m: any) => ({ text: str(m?.text, 300), unlocks: oneOf(MISSING_UNLOCKS, m?.unlocks, "question"), connector: ctx.connectorIds.includes(String(m?.connector)) ? String(m.connector) : null }))
    .filter((m: { text: string }) => m.text && !BANNED_WORDS.test(m.text))
    .slice(0, 5);

  const plan: ValidatedPlan = {
    contract: PLAN_CONTRACT,
    stageRead: { band: oneOf(PLAN_STAGE_BANDS, j.stage_read?.band, "unclear"), why: str(j.stage_read?.why, 500) },
    recommendedGoals, gamePlans, actions, goalNotes, missing, ideaMoves, week,
    pathNote: typeof j.path_note === "string" ? j.path_note.slice(0, 500) : "",
  };
  return { plan, held };
}

/**
 * The week (plan 1.5.0): whole numbers, 0–21 (the target may be null: no playbook and no limit of the athlete's), and
 * one line of why. Null when the model gave no usable posts number.
 */
function weekOf(w: any, text: (v: unknown, max?: number) => string): PlanWeek | null {
  const whole = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), PLAN_CAPS.postsPerWeek) : null);
  const posts = whole(w?.posts);
  if (!w || typeof w !== "object" || posts === null) return null;
  return { posts, target: whole(w.target), stories: Math.min(whole(w.stories) ?? 0, PLAN_CAPS.storiesPerWeek), why: text(w.why, 300) };
}

/** A post's idea (plan 1.3.0), or null without a hook, a format from the list and what to show. */
function postIdeaOf(p: any): PlanPostIdea | null {
  const hook = str(p?.hook, 300);
  const show = str(p?.show, 600);
  const format = (POST_FORMATS as readonly string[]).includes(p?.format) ? (p.format as PostFormat) : null;
  if (!hook || !show || !format) return null;
  return { hook, format, show, captionAngle: str(p?.caption_angle, 300), avoid: str(p?.avoid, 300), mediaNeeds: str(p?.media_needs, 200) };
}

/**
 * A post_brief's own parts (plan 1.7.0), as the kit will take them (agent/postKit/caption.ts):
 *   caption   the model's words kept whole — only a leading "Caption:"-style label and wrapping quotes come off, never
 *             anything mid-text; one that opens with a production label ("Format:", "Slide 1:") is the brief in the
 *             wrong field and reads "". Tags in it move to `hashtags` (a closing run whole; an inline tag keeps its
 *             word). Capped at POST_KIT_CAPTION_CHARS (2,200), the limit the prompt states.
 *   hashtags  the model's list first, then the ones moved out of the caption: made safe, unique, at most five
 *   shots     trimmed, at most ten, each at most 300 characters
 * An answer with no `caption` key at all (an older shape; Structured Outputs always sends it, as a string or null)
 * writes none of the three, so the kit reads that body the way it reads every pre-1.7.0 row. Once the key is there —
 * "" and null included — the kit never reads the body for a caption.
 */
function postPartsOf(d: any, text: (v: unknown, max?: number) => string): Pick<PlanDeliverable, "caption" | "hashtags" | "shots"> {
  if (!d || typeof d !== "object" || !("caption" in d)) return {};
  const shots = (Array.isArray(d?.shots) ? d.shots : [])
    .map((s: unknown) => text(s, PLAN_CAPS.postShotChars).trim()).filter(Boolean).slice(0, PLAN_CAPS.postShots);
  const { words, tags } = splitTags(captionField(text(d?.caption, POST_KIT_CAPTION_CHARS)));
  const listed = Array.isArray(d?.hashtags) ? d.hashtags : [];
  return { caption: words, hashtags: hashtagList([...listed, ...tags], PLAN_CAPS.postHashtags), shots };
}

const postWords = (p: PlanPostIdea) => [p.hook, p.show, p.captionAngle, p.avoid, p.mediaNeeds].join("\n");

function valueOf(v: any): PlanValue {
  const drivers = (Array.isArray(v?.drivers) ? v.drivers : []).map((x: unknown) => str(x, 200)).filter(Boolean).slice(0, 5);
  const low = Number.isFinite(Number(v?.low)) && v?.low !== null ? Number(v.low) : null;
  const high = Number.isFinite(Number(v?.high)) && v?.high !== null ? Number(v.high) : null;
  // Money only with drivers, and only as a real range.
  const money = drivers.length > 0 && low !== null && high !== null && low >= 0 && high >= low;
  return {
    text: str(v?.text, 500), low: money ? low : null, high: money ? high : null,
    currency: money && typeof v?.currency === "string" && /^[A-Za-z]{3}$/.test(v.currency) ? v.currency.toUpperCase() : null,
    drivers,
  };
}
