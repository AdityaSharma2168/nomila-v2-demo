/**
 * shared/plan.ts — the plan step's contract (design: "The plan step", 9 Oct 2026; growth loop steps 3 and 4).
 *
 * One model call (skill `plan`, server/agent/jobs/plan.md) reads what Nomila knows about the athlete and writes 2–3
 * recommended goals, a game plan per goal and this week's actions. Code validates it (server/agent/plan/validate.ts) and
 * stores it in memory_decisions (kind goal / action) and memory_goals (game_plan, horizon). This file holds:
 *
 *   1. the plan/1 vocabularies and the VALIDATED plan as stored on the run (agent_runs.output.plan)
 *   2. the detail stored on a goal or action decision (memory_decisions.detail), the seam Track E (prepare) reads
 *   3. the app's reads: GET /api/v1/me/agent/goals (AgentGoalsResponse) and GET /api/v1/me/agent/results
 *
 * Types and constants only, no runtime dependencies (shared/agent.ts rules). Additive to agent/1. Nothing here names an
 * athlete, sport, school, league or brand. The screens' shapes (draft PR #900, client/screens/prototypes) are pinned
 * against these types by server/agent/plan/contract.test.ts.
 */
import type { DatePrecision, GamePlanAuthor, GoalDomain, GoalHorizon, GoalRepeats, GoalSource, GoalStatus } from "./agent";
import type { PostFormat } from "./postKit";
import type { PostKit, PostKitHold } from "./postKit";

export const PLAN_CONTRACT = "plan/1" as const;

/**
 * The goal card's category (the mark and label the Goals cards draw: Performance, Commercial, Audience, Positioning,
 * Impact) for each served goal domain — the client's DOMAIN_MARK (client/components/strategy/RecommendationVisual.tsx);
 * a test pins the two equal. The served field is the finer domain; this is how a card groups it.
 */
export const GOAL_DOMAIN_MARK: Record<GoalDomain, "performance" | "commercial" | "audience" | "positioning" | "impact"> = {
  impact: "impact", positioning: "positioning", audience: "audience", content: "audience",
  commercial: "commercial", owned_venture: "commercial", career: "performance", athletic: "performance", relationships: "performance",
};

// ─── plan/1 vocabularies ─────────────────────────────────────────────────────────────────────────────────────────

/** What kind of move an action is. */
export const PLAN_ACTION_KINDS = ["post", "pitch", "reply", "connect", "other"] as const;
export type PlanActionKind = (typeof PLAN_ACTION_KINDS)[number];

/** The one button an action carries. */
export const PLAN_BUTTONS = ["send", "post", "review", "connect", "start"] as const;
export type PlanButton = (typeof PLAN_BUTTONS)[number];

/** The button's words (fixed copy, never model-written). */
export const PLAN_BUTTON_LABELS: Record<PlanButton, string> = {
  send: "Send", post: "I'll post it", review: "Review", connect: "Connect", start: "Start with Mila",
};

/** What the action's deliverable is. */
export const PLAN_DELIVERABLE_TYPES = ["post_brief", "pitch", "reply_draft", "connect_request", "checklist"] as const;
export type PlanDeliverableType = (typeof PLAN_DELIVERABLE_TYPES)[number];

/** The stage read, as the Brief's stage bands. */
export const PLAN_STAGE_BANDS = ["early", "developing", "established", "elite", "retired", "unclear"] as const;
export type PlanStageBand = (typeof PLAN_STAGE_BANDS)[number];

export const VALUE_CONFIDENCES = ["low", "medium", "high"] as const;
export type ValueConfidence = (typeof VALUE_CONFIDENCES)[number];

/** A goal note is a suggestion only: code never applies it. */
export const GOAL_NOTE_SUGGESTIONS = ["keep", "mark_done", "set_aside", "drop"] as const;
export type GoalNoteSuggestion = (typeof GOAL_NOTE_SUGGESTIONS)[number];

/** What a missing input would unlock. */
export const MISSING_UNLOCKS = ["connect", "question"] as const;

/**
 * The caps code enforces after the call (the instruction file asks for the same). `actionsPerGoal` caps the actions of
 * every kind but `post` (plan 1.5.0): posts are limited by the week's one number (`week.posts`, plus its stories), never
 * per goal.
 */
export const PLAN_CAPS = {
  recommendedGoals: 3,
  actionsPerGoal: 3,
  /** The most posts (feed posts, reels, carousels) one week may hold: more than three a day is never a sane plan. */
  postsPerWeek: 21,
  /** The most stories one week may add on top of its posts. */
  storiesPerWeek: 21,
  planLines: 2,
  planLineChars: 160,
  goalChars: 90,
  actionTitleChars: 60,
  /** plan 1.7.0, a post_brief's own fields: how many tags it carries, how many shots or slides, each this long. */
  postHashtags: 5,
  postShots: 10,
  postShotChars: 300,
} as const;

// ─── The validated plan (stored on the run) ──────────────────────────────────────────────────────────────────────

/** What it is worth: money only with its drivers (code clears low / high when there are none). */
export interface PlanValue {
  text: string;
  low: number | null;
  high: number | null;
  currency: string | null;
  drivers: string[];
}

/** A dated event an action is timed before (an E-key resolved to its fact). */
export interface PlanEventRef {
  factId: string;
  /** From the fact's subject (the event's name). */
  label: string;
  /** YYYY-MM-DD (a month-only date is the 1st of the month, a year-only date 1 January). */
  date: string;
  /** How precise the date is (memory_facts.date_precision, 0119): say "December", not "1 Dec", for a month. */
  precision: DatePrecision;
}

/** Who or what a pitch or post is aimed at. */
export interface PlanTarget {
  subjectKind: "brand" | "organization" | "person" | "other";
  name: string;
}

/** The action's deliverable, as the plan wrote it (caption + shot list, pitch email, reply text, or steps). */
export interface PlanDeliverable {
  type: PlanDeliverableType;
  title: string;
  body: string;
  target: PlanTarget | null;
  platform: string | null;
  /** reply only: the open thread it answers (a T-key resolved). */
  thread: { opportunityId: string; threadId: string | null; label: string } | null;
  /** connect only: the onboarding connector id (POST /api/v1/me/connect/:connector). */
  connector: string | null;
  /**
   * post_brief only (plan 1.7.0): the post's three parts as fields of their own, so nothing has to be cut back out of
   * `body`. `caption` is the words the athlete pastes (no label, no brief line, no tag; "" when the plan gave none);
   * `hashtags` each start with "#", case-insensitively unique, at most PLAN_CAPS.postHashtags; `shots` is the shot or
   * slide list, in order. Absent on every other type, and on a post_brief written before 1.7.0 — the post kit then
   * reads the caption back out of `body` (agent/postKit/kit.ts captionFromBody).
   */
  caption?: string;
  hashtags?: string[];
  shots?: string[];
}

/** A goal reference: an active goal's id, or a recommended goal of the same run (R1…R3). */
export type PlanGoalRef = { kind: "goal"; goalId: string } | { kind: "recommended"; key: string };

export interface PlanRecommendedGoal {
  key: string;
  goal: string;
  horizon: GoalHorizon;
  /** What the goal is about (plan 1.1.0); null when the model gave none from the list. */
  domain: GoalDomain | null;
  whyNow: string;
  value: PlanValue;
  valueConfidence: ValueConfidence;
  nextDecision: string;
  factIds: string[];
  similarToGoalId: string | null;
  /** plan 1.5.0: once, or the trigger that brings it a fresh action each time (GOAL_REPEATS); "once" when none given. */
  repeats: GoalRepeats;
}

/**
 * plan 1.5.0: the week's one number. `target` is the playbook's research-based posts a week (or the athlete's own limit
 * when they set one), `posts` this week's number toward it (the model may phase in over a few weeks from the athlete's
 * real pace; never a cap), `stories` the light stories added on top, and `why` one line on how it was set.
 */
export interface PlanWeek {
  posts: number;
  target: number | null;
  stories: number;
  why: string;
}

export interface PlanGamePlan {
  goalRef: PlanGoalRef;
  /** The goal's domain as the plan read it (plan 1.1.0); null when none from the list. */
  domain: GoalDomain | null;
  lines: string[];
  keptAthleteText: boolean;
}

/**
 * The idea behind a post action (plan 1.3.0), in the idea bank's own words (shared/postKit.ts IdeaBankEntry): what a
 * fresh or adapted idea is written to the bank as. Strategist input, never shown to the athlete on its own: the athlete
 * reads the deliverable.
 */
export interface PlanPostIdea {
  hook: string;
  format: PostFormat;
  show: string;
  captionAngle: string;
  avoid: string;
  mediaNeeds: string;
}

/** A content pillar as the plan saw it (a P-key resolved to the Brief's pillar). */
export interface PlanPillarRef {
  /** P1…P4 in the Brief the plan read (renumbered with every Brief). */
  key: string;
  /** The pillar's name: what the rotation matches on across Briefs. */
  name: string;
}

/**
 * Where a post action's idea comes from (the idea bank, design "Moments → post kits" §6–§7, build step 8):
 *   bank     an idea on file the plan reused (an I-key) — marked used by this action
 *   adapted  a missed timely idea re-pointed at this action's (later) event (an X-key) — a new bank row is written,
 *            the old one marked adapted
 *   fresh    a new evergreen idea under a content pillar, because the bank had nothing that fit — written to the bank
 *            as used
 * Null on a timely post taken straight from a moment with no bank entry, and on every action that is not a post.
 */
export interface PlanPostSource {
  from: "bank" | "adapted" | "fresh";
  /** The bank row reused (bank), or the missed row adapted (adapted); null when fresh. */
  ideaId: string | null;
  /** The pillar it serves: the bank idea's own when it has one, else the plan's pillar_ref. */
  pillar: PlanPillarRef | null;
  /** adapted only: the pending moment decision of the later event, when the store has one. */
  momentDecisionId: string | null;
}

export interface PlanAction {
  goalRef: PlanGoalRef;
  kind: PlanActionKind;
  what: string;
  why: string;
  dueOn: string | null;
  event: PlanEventRef | null;
  button: PlanButton;
  deliverable: PlanDeliverable;
  factIds: string[];
  /** A post's idea (plan 1.3.0); null for any other kind, or when the model gave none that passes the checks. */
  post: PlanPostIdea | null;
  /** Where a post's idea comes from (plan 1.3.0); null when the idea bank is off or the post has no bank source. */
  source: PlanPostSource | null;
}

/**
 * What the plan did with an idea it did not use this week (plan 1.3.0): skip an idea that is not worth doing at all,
 * or adapt a missed timely idea to a later event (a new bank row, status new; the old one adapted).
 */
export interface PlanIdeaMove {
  move: "skip" | "adapt";
  ideaId: string;
  /** adapt only: the later event, its pending moment decision when the store has one, and the new timing. */
  event: PlanEventRef | null;
  momentDecisionId: string | null;
  timing: string | null;
  why: string;
}

export interface ValidatedPlan {
  contract: typeof PLAN_CONTRACT;
  stageRead: { band: PlanStageBand; why: string };
  recommendedGoals: PlanRecommendedGoal[];
  gamePlans: PlanGamePlan[];
  actions: PlanAction[];
  goalNotes: Array<{ goalId: string; suggest: GoalNoteSuggestion; why: string }>;
  missing: Array<{ text: string; unlocks: (typeof MISSING_UNLOCKS)[number]; connector: string | null }>;
  /** plan 1.3.0: skips and adaptations in the idea bank (empty on runs from before the idea bank). Absent on older runs. */
  ideaMoves: PlanIdeaMove[];
  /** plan 1.5.0: the week's number of posts, its target and its stories; null when the model gave none. Absent on older runs. */
  week?: PlanWeek | null;
  pathNote: string;
}

/** Something the code checks held back, and why (agent_runs.output.held). */
export interface PlanHeld {
  what: string;
  reason: string;
}

// ─── Decision detail (memory_decisions.detail) ───────────────────────────────────────────────────────────────────

/** A recommended goal's decision detail (kind = goal, skill plan). */
export interface GoalDecisionDetail {
  /** The run-local key (R1…R3) of the run that last wrote it. */
  key: string;
  horizon: GoalHorizon;
  /** What the goal is about (plan 1.1.0): copied to memory_goals.domain when the athlete keeps it. Absent before 0119. */
  domain?: GoalDomain | null;
  value: PlanValue;
  valueConfidence: ValueConfidence;
  nextDecision: string;
  gamePlan: string[];
  /** plan 1.5.0: once, or the trigger that owes it a fresh action each time. Absent on rows written before (= once). */
  repeats?: GoalRepeats;
}

/**
 * The action's state, as the client's GoalAction.state: to_start (nothing prepared) → made (prepared, waiting for the
 * tap) → done (sent, posted or answered). Track E (prepare) moves it and writes `prepared` and approval_id.
 */
export type GoalActionState = "to_start" | "made" | "done";

/** An action's decision detail (kind = action). */
export interface ActionDecisionDetail {
  kind: PlanActionKind;
  what: string;
  button: PlanButton;
  dueOn: string | null;
  event: PlanEventRef | null;
  deliverable: PlanDeliverable;
  state: GoalActionState;
  /**
   * Track E writes what it prepared (a Studio item id, a draft) here. A post action's kit (shared/postKit.ts) lives at
   * `postKit`, with `studioItemId` = the decision's own id.
   */
  prepared?: { studioItemId?: string | null; postKit?: PostKit; postKitHold?: PostKitHold | null; [k: string]: unknown } | null;
  /** plan 1.3.0: the idea behind a post, as the plan wrote it. Absent on actions written before. */
  post?: PlanPostIdea | null;
  /**
   * plan 1.3.0, the idea bank: the bank row this post used (or wrote, for a fresh or adapted idea) and the content
   * pillar it serves — what the next plan's pillar rotation reads. Absent when the post has no bank source.
   */
  idea?: { ideaId: string | null; pillar: PlanPillarRef | null } | null;
}

/** A goal-tool change's decision detail (kind = goal, skill goals): what changed, so it can be undone. */
export interface GoalChangeDetail {
  op: "keep" | "change" | "set_aside" | "drop" | "add" | "bring_back" | "suggest";
  goalId: string | null;
  from: { text: string; horizon: GoalHorizon | null; status: GoalStatus; gamePlan: string | null; gamePlanBy: GamePlanAuthor } | null;
  to: { text: string; horizon: GoalHorizon | null; status: GoalStatus; gamePlan: string | null; gamePlanBy: GamePlanAuthor } | null;
  /** Pending actions this change expired (restored by Undo). */
  expiredActionIds?: string[];
  undone?: boolean;
}

// ─── Moments (the weekly moments scan, server/agent/moments) ─────────────────────────────────────────────────────

/** What kind of dated moment it is (skill moments). */
export const MOMENT_CATEGORIES = ["schedule", "league", "holiday_awareness", "cultural_trend", "partner_campaign"] as const;
export type MomentCategory = (typeof MOMENT_CATEGORIES)[number];

/** A post format (shared/postKit.ts POST_FORMATS): what a moment's idea carried before moments 1.2.0. */
export type MomentFormat = PostFormat;

/**
 * Why the scan retires a moment on file. The first four mean the moment as recorded is no longer true (it passed, was
 * cancelled or moved, or was wrong): the fact is superseded. not_worth_a_post means it is still true but not worth a
 * post: the fact stays, only its candidate post expires.
 */
export const MOMENT_RETIRE_WHYS = ["passed", "cancelled", "moved", "wrong", "not_worth_a_post"] as const;
export type MomentRetireWhy = (typeof MOMENT_RETIRE_WHYS)[number];

/**
 * A moment's candidate post (memory_decisions kind "other", skill moments, detail.kind "moment"; evidence = the moment's
 * fact). Strategist input for the plan step, never shown to the athlete on its own: the plan decides whether it becomes
 * this week's post action. One per moment fact: a later scan refreshes it in place; a retired moment's row is expired.
 *
 * Since moments 1.2.0 the scan returns the moment, its why-now and ONE angle with a hook (`idea.hook`, `idea.angle`); the
 * plan picks the format, platform, timing and shot list. Rows written before carry the old fields (`idea.format`,
 * `idea.platform`, `idea.timing`, `brief`, `mediaNeeds`): every reader treats them as optional.
 */
export interface MomentDecisionDetail {
  kind: "moment";
  /** The moment's fact (memory_facts, subject_kind event, topic moment). */
  factId: string;
  name: string;
  /** As stored on the fact: the first of the month for a month-only date. */
  date: string;
  datePrecision: "day" | "month";
  category: MomentCategory;
  whyNow: string;
  /** 1 = the most worth a post in this scan. */
  rank: number;
  idea: {
    hook: string; angle?: string; format?: MomentFormat; platform?: string; timing?: string;
    /** The copy pass (COPYWRITER_V1): the scan's own angle and hook, when the narrator's craft rewrote them. */
    original?: { hook: string; angle: string };
  };
  /** Before moments 1.2.0 only. */
  brief?: { show: string; captionAngle: string; avoid: string };
  /** Before moments 1.2.0 only. */
  mediaNeeds?: string;
  /** When a scan last wrote it (ISO). */
  scannedAt: string;
  /** Why the scan retired it (its candidate post expired), when it did: what the idea bank reads to keep a cancelled or
   * wrong moment's idea from being adapted. */
  retiredWhy?: MomentRetireWhy;
}

// ─── The app's reads ─────────────────────────────────────────────────────────────────────────────────────────────

export const AGENT_GOALS_CONTRACT = "agent-goals/1" as const;

/** The client's GoalAction kinds (client/lib/agent/types.ts GoalActionKind): post → post_kit, pitch, reply, else task. */
export type ClientGoalActionKind = "post_kit" | "deck" | "page" | "pitch" | "reply" | "visual" | "task";

/** Where an action or Studio item opens (the client's StudioItem["open"]). */
export type OpenTarget = { screen: string; params?: Record<string, unknown> } | { url: string } | null;

/** One of this week's actions toward a goal: the client's GoalAction plus what the plan wrote. */
export interface GoalActionView {
  /** The action's decision id. */
  id: string;
  title: string;
  kind: ClientGoalActionKind;
  /** When it is due, in words ("Wed 15 Oct"); null when undated. */
  when: string | null;
  state: GoalActionState;
  studioItemId: string | null;
  open: OpenTarget;
  /** state = to_start: what Mila is asked when the athlete taps "Start with Mila". */
  startPrompt: string | null;
  planKind: PlanActionKind;
  why: string;
  button: PlanButton;
  buttonLabel: string;
  dueOn: string | null;
  /** The dated event this action is timed before ("Before <label> on <date>"). */
  event: PlanEventRef | null;
  deliverable: PlanDeliverable;
  approvalId: string | null;
  /**
   * A post action's idea, as the plan wrote it (detail.post): the Goals row's opening line and format, and what the
   * opened row shows. Null for every other kind and for a post written before plan 1.3.0. Optional on the wire: a
   * server from before this field sends none.
   */
  post?: PlanPostIdea | null;
  /** The content pillar a post serves (detail.idea.pillar); null when it has none. */
  pillar?: PlanPillarRef | null;
  /** A post action's kit, in short (detail.prepared.postKit); null while none is built. */
  kit?: GoalActionKitView | null;
}

/**
 * A post kit as the Goals row needs it: whether it is built, how many of her own assets it holds (0 = it needs media),
 * and its preview's state. The kit screen reads the whole kit (GET …/actions/:id/post-kit).
 */
export interface GoalActionKitView {
  built: boolean;
  assets: number;
  aiGenerationNeeded: boolean;
  /** The render asked for, when one was: its status and when it was asked (the 10-minute stall rule reads it). */
  preview: { status: "queued" | "ready" | "failed"; requestedAt: string } | null;
}

/** Where a plan run in progress is (GET /me/agent/goals `planning`): the Goals tab polls while it is set. */
export interface GoalsPlanningView {
  runId: string;
  step: "plan" | "post_kits" | "tell";
  startedAt: string;
}

/** A goal the athlete holds, with its game plan and this week's actions (the client's AgentGoal, plus more). */
export interface GoalView {
  id: string;
  /** In the athlete's words, verbatim. */
  text: string;
  /** The game plan: 1–2 lines. */
  plan: string | null;
  horizon: GoalHorizon | null;
  /** What the goal is about (memory_goals.domain): the card's label (Commercial, Audience …). Null when nobody has said. */
  domain: GoalDomain | null;
  actions: GoalActionView[];
  status: GoalStatus;
  source: GoalSource;
  gamePlanBy: GamePlanAuthor;
  /** True when the goal's wording is the athlete's own (typed, or a recommendation they changed before keeping). */
  inYourWords: boolean;
  priority: number | null;
  /** The soonest dated event this goal's actions are timed before, when any. */
  nextEvent: PlanEventRef | null;
  /** plan 1.5.0: once, or what brings it a fresh action each time (from the recommendation it was kept from). Optional on the wire. */
  repeats?: GoalRepeats;
}

/** A goal Mila recommends (a pending decision; never a goal row until kept). The goal-proposal card's fields. */
export interface RecommendedGoalView {
  decisionId: string;
  goal: string;
  horizon: GoalHorizon;
  /** What the goal is about: the card's label. Null for a recommendation with none (one Mila made in the chat). */
  domain: GoalDomain | null;
  why: string;
  value: string;
  valueRange: { low: number; high: number; currency: string; drivers: string[] } | null;
  valueConfidence: ValueConfidence;
  nextDecision: string;
  gamePlan: string | null;
  factIds: string[];
  sources: Array<{ label: string; url?: string }>;
  /** Actions held for it until it is kept (posts are not capped per goal, plan 1.5.0). */
  actions: GoalActionView[];
  /** plan 1.5.0: once, or what brings it a fresh action each time. Optional on the wire: an older server sends none. */
  repeats?: GoalRepeats;
}

/** Home's "Coming up": the next dated events (≤ 3, next 60 days, soonest first, dated facts only). */
export interface ComingUpItem {
  /** YYYY-MM-DD; with precision month it is the 1st of the month ("December"), with year 1 January ("2027"). */
  date: string;
  precision: DatePrecision;
  label: string;
  factId: string;
  /** The goal whose actions are timed for it. */
  goalId: string | null;
  /**
   * Prepared (not expired, not done) actions with this event: waiting actions of a goal she holds, and waiting post
   * actions with a built kit under a goal still only recommended (posts are prepared before Keep).
   */
  actionsReady: number;
  /** The soonest waiting post action with a built kit for this event: the row opens that kit. Optional on the wire. */
  kitActionId?: string | null;
}

/**
 * A moment the moments step chose and still holds (its pending candidate post), as Home's Moments circle shows it: every
 * kind (games, league dates, holidays, cultural moments, partner campaigns), soonest first. Optional on the wire.
 */
export interface MomentView {
  factId: string;
  date: string;
  precision: DatePrecision;
  name: string;
  category: MomentCategory;
  whyNow: string;
  /** Mila's one angle for a post; null on rows from before moments 1.2.0. */
  angle: string | null;
  hook: string;
  /** Prepared actions timed for this moment (as ComingUpItem.actionsReady). */
  actionsReady: number;
  /** The soonest waiting post action with a built kit for this moment: the story opens that kit. */
  kitActionId: string | null;
}

/** The biggest risk and upside, once above the goals (the current Brief's risks_upside). */
export interface RiskUpside {
  risk: string;
  upside: string;
}

/** GET /api/v1/me/agent/goals. */
export interface AgentGoalsResponse {
  contract: typeof AGENT_GOALS_CONTRACT;
  /** Active goals, in priority order then oldest first. */
  goals: GoalView[];
  /** Set aside (paused) goals, for the "Set aside for now" fold. */
  setAside: GoalView[];
  recommended: RecommendedGoalView[];
  comingUp: ComingUpItem[];
  /** The moments the moments step chose (all kinds, next PLAN.HORIZON_DAYS days, soonest first). Absent on older servers. */
  moments?: MomentView[];
  riskUpside: RiskUpside | null;
  /** What would help, from the latest plan run ("Connect … so Mila can see what works"). */
  missing: Array<{ text: string; unlocks: "connect" | "question"; connector: string | null }>;
  /** The latest completed plan run, and when it finished; null before the first plan. */
  plan: { runId: string; at: string } | null;
  /**
   * A plan run in progress (the workflow runner's active plan_refresh run), or null. A run still waiting out its 6-hour
   * coalescing window is not in progress. Optional on the wire: a server from before this field sends none.
   */
  planning?: GoalsPlanningView | null;
}

/** One action as Results shows it: what you did and what came back. */
export interface ResultActionView {
  id: string;
  title: string;
  planKind: PlanActionKind;
  /** pending | accepted | edited | skipped | expired (what you did). */
  response: string;
  respondedAt: string | null;
  /** unknown | worked | mixed | did_not_work (what came back) and its note ("They asked for your rates"). */
  outcome: string;
  outcomeNote: string | null;
  state: GoalActionState;
  createdAt: string;
}

/** GET /api/v1/me/agent/results: last 30 days, per goal. */
export interface AgentResultsResponse {
  contract: "agent-results/1";
  since: string;
  goals: Array<{
    goalId: string;
    text: string;
    horizon: GoalHorizon | null;
    counts: { done: number; skipped: number; toDo: number };
    actions: ResultActionView[];
    /** The next pending action, when any. */
    next: { title: string; dueOn: string | null } | null;
  }>;
}

/**
 * GET /api/v1/me/agent/wins — the learning loop's exceptional-post messages of the last 7 days (memory_decisions, skill
 * learning, detail.kind exceptional_post), for Home v3's Wins circle (EXPO_PUBLIC_HOME_V3). Read-only; dark with the rest
 * of the Goals API (AGENT_PLAN). Every number is the loop's own stored reading; nothing here is written by a model.
 */
export interface AgentWinPost {
  /** The decision id (stable: the circle's "seen" key). */
  id: string;
  /** When the loop wrote it (ISO). */
  at: string;
  /** "instagram", "tiktok" … as the loop stored it. */
  platform: string;
  /** The post's format as stored ("reel", "carousel", "feed" …); null when unknown. */
  format: string | null;
  /** How many times the athlete's usual (2 decimals), and the metric in words ("saves", "reach"). */
  ratio: number;
  metric: string;
  /** The chat the loop posted its message in, when it did. */
  conversationId: string | null;
}

/** A brand paid her directly (its own payment notice, inbox paperwork `payment_received`, with an amount), last 7 days. */
export interface AgentWinPayment {
  /** The notice's thread id (stable: the circle's "seen" key). */
  id: string;
  /** When it was paid (ISO), from the notice. */
  at: string;
  /** The payer as her brand list names it ("" when unknown). */
  brand: string;
  cents: number;
  currency: string;
  /** Her deal it was matched to, when it was. */
  dealId: string | null;
}

export interface AgentWinsResponse {
  contract: "agent-wins/1";
  posts: AgentWinPost[];
  /** Absent from a server before payments were added. */
  payments?: AgentWinPayment[];
}
