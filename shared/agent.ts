/**
 * shared/agent.ts — THE contract for Nomila's agent harness (agent build plan v2, 9 Oct 2026, Week 1 step 1).
 *
 * One agent, Mila. She thinks on a model chosen per skill, follows SKILLS (written procedures, versioned in the repo),
 * acts through TOOLS (ours, provider built-ins, connectors — one format), remembers through MEMORY (evidence, brief,
 * decisions + outcomes, preferences), and never sends, posts or pays without the athlete's tap (the APPROVAL queue).
 * Every run leaves a TRACE, and the chat shows CARDS built from all of the above.
 *
 * Types and constants only: no runtime dependencies, so the server, the app and any worker import it as is. The
 * server's rules over these shapes live in server/agent/ (policy.ts, tools.ts, jobs.ts, memory.ts, trace.ts).
 *
 * Generic within Nomila's world — athletes and the brands, fans and organizations around them. Nothing here names an
 * athlete, sport, school, league, brand or use case, and nothing here may.
 *
 * Versioning: additive changes keep AGENT_CONTRACT_VERSION; a breaking change bumps it and every consumer at once.
 */

export const AGENT_CONTRACT_VERSION = "agent/1" as const;

// ─── Models ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** How hard the model thinks. Maps onto the provider's reasoning effort. */
export const EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * What a skill asks for. A skill names a TIER, never a model id: the one place that turns a tier (or a specific skill)
 * into a provider + model is server/agent/models.ts, so the fleet can move without touching a skill.
 *   reasoning  Mila's thinking: research, understand, decide, deals
 *   fast       quick turns and small skills
 *   cheap      tagging, short summaries
 */
export const MODEL_TIERS = ["reasoning", "fast", "cheap"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const MODEL_PROVIDERS = ["openai", "gemini"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** A resolved model choice — what a run actually used. */
export interface ModelChoice {
  provider: ModelProvider;
  /** Provider model id, e.g. whatever OPENAI_AGENT_MODEL resolves to. */
  model: string;
  effort: Effort;
}

// ─── Skills ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A skill's declared input or output field. Plain JSON types; `object` / `array` carry free structure. */
export interface SkillField {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required: boolean;
  /**
   * The input carries text from outside Nomila: web pages, emails, brand material, captions, research results, a
   * client's free text. A skill that declares one gets its input fenced by the transport (jobs.ts fenceSkillInput),
   * so that text can never close the fence around it. Absent = false.
   */
  external?: boolean;
}

/**
 * A skill: a written procedure Mila follows, stored as markdown with front-matter under server/agent/jobs/<id>.md and
 * loaded on demand. The markdown body is the instructions; the front-matter is everything below except `instructions`.
 */
export interface Skill {
  /** Path-like and stable, e.g. "echo/health". Lowercase, `/`-separated segments of [a-z0-9-]. */
  id: string;
  /** Semver of the procedure. Bump on any change to the instructions. Recorded on every run. */
  version: string;
  /** One line: what the skill does and when Mila should use it. */
  description: string;
  inputs: SkillField[];
  outputs: SkillField[];
  effort: Effort;
  /** The tier this skill needs; resolved to a ModelChoice in one place (server/agent/models.ts). */
  model: ModelTier;
  /** Tool names this skill may call. The harness offers nothing else, whatever the model asks for. */
  tools: string[];
  /**
   * Per-skill run limits (agent/1, additive; front-matter `limits`). Absent = the harness defaults (AGENT_MAX_STEPS,
   * AGENT_RUN_COST_CAP_USD, no web-search count). AGENT_SKILL_CAPS (JSON by skill id) overrides them without a deploy.
   */
  limits?: SkillLimits;
  /** The markdown body: the procedure itself. */
  instructions: string;
}

/** A skill's own run limits: model calls, spend per run (USD) and provider web searches per run. */
export interface SkillLimits {
  maxSteps?: number;
  costCapUsd?: number;
  maxWebSearches?: number;
}

/** A skill as listed (no instructions) — what a catalog, an eval or a UI needs. */
export type SkillSummary = Omit<Skill, "instructions">;

// ─── Tools ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a tool comes from. ONE tool format for all three:
 *   ours       a server function in Nomila (memory, deals, rates, card, Studio, approvals …)
 *   builtin    a provider built-in the model runs itself (web search, file search, code …)
 *   connector  a tool on a connected service, reached through an MCP-ready connector on the athlete's revocable grant
 */
export const TOOL_KINDS = ["ours", "builtin", "connector"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/**
 * What a tool is allowed to do, in increasing order of reach:
 *   read     look at data. Changes nothing.
 *   draft    make or change something INSIDE Nomila that is reversible and private (a draft, a fact, a brief).
 *   propose  put an item in the approval queue. Writes nothing outward.
 *   act      do something that leaves Nomila or moves money (send, post, publish, accept, pay, invite).
 *            The agent NEVER executes an act tool: the harness turns the call into an ApprovalItem and the athlete's
 *            tap executes it.
 */
export const TOOL_PERMISSIONS = ["read", "draft", "propose", "act"] as const;
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];

/** JSON Schema (draft 2020-12 subset) for a tool's arguments, as the model sees it. Never contains an athlete id. */
export type JsonSchema = { [key: string]: unknown };

/** The provider built-ins the harness knows how to offer. */
export const BUILTIN_TOOLS = ["web_search"] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOLS)[number];

/** A tool as the model and the policy layer see it. The executing function lives server-side only. */
export interface ToolSpec {
  /** snake_case, unique across all kinds. */
  name: string;
  /** Written for the model: what it returns and when to call it. */
  description: string;
  kind: ToolKind;
  permission: ToolPermission;
  /** Arguments schema. Empty object schema for a no-argument tool. */
  schema: JsonSchema;
  /** True when using it involves money (charges, payouts, prices committed to). Always needs a tap. */
  money?: boolean;
  /** kind = "connector": which connector serves it (e.g. an MCP server id) and the access it needs, in plain words. */
  connector?: { id: string; access: string[] };
  /** kind = "builtin": which built-in. */
  builtin?: BuiltinToolName;
}

// ─── Evidence references ──────────────────────────────────────────────────────────────────────────────────────────

/** A pointer to something a run read or a suggestion rests on. "How I got this" is built from these. */
export type EvidenceRef =
  | { kind: "fact"; factId: string }
  | { kind: "url"; url: string; title?: string }
  | { kind: "record"; table: string; id: string }
  | { kind: "tool_result"; runId: string; seq: number };

// ─── Runs and traces ──────────────────────────────────────────────────────────────────────────────────────────────

/** What started a run. Generic triggers only. */
export const RUN_TRIGGERS = ["chat", "schedule", "event", "approval", "test"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_STATUSES = ["running", "completed", "failed", "stopped"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Where a run's approval cards stand (agent_runs.approval_state, 0144), apart from RunStatus (how the model turn ended).
 * null: the run queued nothing for a tap. awaiting_approval → (a tap) resumed → completed | failed; all declined → cancelled.
 */
export const RUN_APPROVAL_STATES = ["awaiting_approval", "resumed", "completed", "cancelled", "failed"] as const;
export type RunApprovalState = (typeof RUN_APPROVAL_STATES)[number];

/** Why a run stopped early. */
export const STOP_REASONS = ["cost_cap_run", "cost_cap_day", "max_steps", "policy", "aborted", "error"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** Tokens, searches and money for a run (or one model call). Money in micro-dollars (1 USD = 1,000,000). */
export interface RunCost {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  webSearchCalls: number;
  microUsd: number;
}

/** What happened to one tool call. */
export const TOOL_OUTCOMES = ["ok", "error", "denied", "queued_for_approval"] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

export interface ToolCallRecord {
  name: string;
  kind: ToolKind;
  permission: ToolPermission;
  outcome: ToolOutcome;
  /** The policy rule that denied or queued it. */
  rule?: PolicyRule;
  /** outcome = queued_for_approval: the item waiting for the tap. */
  approvalId?: string;
  durationMs: number;
  /** The arguments as validated (agent/1, additive), long strings clipped: what the call asked for, for the trace and evals. */
  args?: Record<string, unknown>;
  /** outcome = error | denied: the reason the model was given (agent/1, additive). */
  reason?: string;
}

/** One step of a run, in order. The trace is the list of these. */
export type TraceStep =
  /**
   * `digest`: sha256 (hex) of the exact instructions the model received, after includes and the harness rules
   * (jobs.ts promptDigest). Never athlete data. Semver says what the author meant to change; the digest says what the
   * text actually was, so an edit to _shared/voice.md or HARNESS_RULES shows per run. Absent on runs before it existed.
   */
  | { seq: number; at: string; type: "skill"; skillId: string; version: string; digest?: string }
  | { seq: number; at: string; type: "model"; model: ModelChoice; cost: RunCost; durationMs: number }
  | { seq: number; at: string; type: "tool"; call: ToolCallRecord }
  | { seq: number; at: string; type: "web_search"; queries: string[]; sources: Array<{ url: string; title?: string }> }
  | { seq: number; at: string; type: "policy"; rule: PolicyRule; decision: "allow" | "deny" | "queue"; reason: string }
  | { seq: number; at: string; type: "error"; message: string };

/** One run of the agent: a skill, a model, its steps, what it read, what it cost. Stored in agent_runs. */
export interface AgentRun {
  id: string;
  athleteId: string;
  skillId: string;
  skillVersion: string;
  trigger: RunTrigger;
  model: ModelChoice;
  status: RunStatus;
  stopReason: StopReason | null;
  /** Where its approval cards stand; null (or absent) when it queued none. */
  approvalState?: RunApprovalState | null;
  startedAt: string;
  endedAt: string | null;
  cost: RunCost;
  /** The trace. */
  steps: TraceStep[];
  toolsCalled: ToolCallRecord[];
  evidenceRead: EvidenceRef[];
  /** The chat conversation this run answered in, when it was a chat turn. */
  conversationId: string | null;
  error: string | null;
}

/** Alias: a trace IS a run with its steps. */
export type Trace = AgentRun;

// ─── Memory: evidence ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a fact came from, in the Athlete Record's words:
 *   said      the athlete told us (chat, onboarding, a correction)
 *   found     found in a public or connected source (a page, a profile)
 *   measured  read as a number from a connected account (followers, reach, views)
 *   made      Nomila worked it out from other facts
 */
export const FACT_TYPES = ["said", "found", "measured", "made"] as const;
export type FactType = (typeof FACT_TYPES)[number];

/**
 *   active      current evidence
 *   superseded  replaced by a newer fact (supersededBy points at it), e.g. the athlete corrected it
 *   disputed    conflicts with another fact (disputes points at it); neither is overwritten until someone resolves it
 *   removed     the athlete removed it ("that's not right / not about me"); kept, never used again (agent/1, additive)
 */
export const FACT_STATUSES = ["active", "superseded", "disputed", "removed"] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/** What a fact is about. Generic kinds only. */
export const SUBJECT_KINDS = ["athlete", "brand", "organization", "person", "event", "content", "other"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export interface SubjectRef {
  kind: SubjectKind;
  /** Display name, as the source gave it. */
  name: string;
  /** A Nomila record id when the subject has one. */
  id?: string;
}

/**
 * One piece of evidence. EVERY fact has a source (policy: no claim without one): a URL for found/measured, a ref for
 * said (the chat message or onboarding answer) and made (the run that worked it out). The database enforces it too.
 */
export interface MemoryFact {
  id: string;
  athleteId: string;
  subject: SubjectRef;
  claim: string;
  type: FactType;
  source: { url?: string; ref?: string; title?: string };
  /** When the fact was true / observed (ISO date). */
  date: string | null;
  /** 0–1. */
  confidence: number;
  status: FactStatus;
  /** status = superseded: the fact that replaced it. */
  supersededBy: string | null;
  runId: string | null;
  createdAt: string;
  /** status = disputed: the fact this one conflicts with (agent/1, additive). */
  disputes?: string | null;
  /** Other sources that say the same thing (dual-pass research keeps every source it merged). Additive. */
  alsoSeenAt?: Array<{ url: string; title?: string }>;
  /**
   * Handle with CARE (agent/1, additive; the column is memory_facts.sensitive): public, sourced and career- or
   * brand-relevant, but delicate — a controversy, an injury or availability, leave or pregnancy as career status,
   * family as the athlete publicly presents it. Kept as a fact; used when relevant and respectfully (timing, risk,
   * positioning, or when the athlete raises it); never leads the reveal. Facts that must never be stored (private
   * contact info, home addresses, non-public information, children's names) are dropped before storage.
   */
  sensitive?: boolean;
  /**
   * Which kind of care (0113, additive; memory_facts.care_kind), set only when `sensitive`: "personal" (an injury or
   * availability, leave or pregnancy, family as the athlete presents it) or "conduct" (a confirmed controversy or an
   * official finding). M.I.A.'s facts-only evaluator may use personal care facts for momentum only, conduct care facts
   * for brand safety and momentum. Null/absent on a care fact = personal (the stricter rule).
   */
  careKind?: CareKind | null;
  /**
   * What the fact is about (0115, additive; memory_facts.topic): the research topic it was filed under (career,
   * sponsor, media …, research/schemas.ts FACT_TOPICS). Null for facts with no research topic (said, measured, made,
   * and facts written before 0115).
   */
  topic?: string | null;
  /**
   * The outlet type of its source (0115, additive; memory_facts.source_type): official | major_media | trade | local |
   * social | other. Null where it does not apply (said, measured, made) and for facts written before 0115.
   */
  sourceType?: FactSourceType | null;
  /**
   * How precise `date` is (0119, additive; memory_facts.date_precision): "day", "month" ("2026-12" is stored as the 1st)
   * or "year" (stored as 1 January). Null/absent = a full date, or a fact written before 0119.
   */
  datePrecision?: DatePrecision | null;
  /**
   * For an identity fact about the athlete (0119, additive; memory_facts.field / field_value): which identity field it
   * states, as the merge model labelled it, and that field's value in a few words. Null otherwise.
   */
  field?: IdentityField | null;
  fieldValue?: string | null;
}

/** How precise a fact's date is (0119). A month-only date is stored as the 1st of the month, a year-only as 1 January. */
export const DATE_PRECISIONS = ["day", "month", "year"] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

/**
 * The identity fields an identity fact about the athlete can state (0119; memory_facts.field). Generic slots only: the
 * merge model reads the claim and labels the slot; the value is the sources' words. Never a list of sports or positions.
 */
export const IDENTITY_FIELDS = ["sport", "team", "position", "level", "class_year", "school", "league"] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];

export const CARE_KINDS = ["personal", "conduct"] as const;
export type CareKind = (typeof CARE_KINDS)[number];

/** The outlet type of a fact's source (research 1.7.0; stored on memory_facts.source_type since 0115). */
export const FACT_SOURCE_TYPES = ["official", "major_media", "trade", "local", "social", "other"] as const;
export type FactSourceType = (typeof FACT_SOURCE_TYPES)[number];

/** Which facts an athlete-facing read returns: about the athlete, about others (context), or all. */
export const FACT_SUBJECT_FILTERS = ["athlete", "others", "all"] as const;
export type FactSubjectFilter = (typeof FACT_SUBJECT_FILTERS)[number];

const nameTokens = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/['’]s\b/g, "").split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Is this fact ABOUT THE ATHLETE (rather than context about someone or something else)? True when its subject kind is
 * "athlete" and its subject name is the athlete's (empty, or every word of the shorter name appears in the longer, so a
 * middle name or a possessive still matches). A teammate's deal, a team's sponsor, a school's partnership or an event
 * is never a fact about the athlete. The same rule serves the M.I.A. input builder and athlete-facing reads.
 */
export function isAboutAthlete(subject: { kind: string; name: string }, athleteName: string): boolean {
  if (subject.kind !== "athlete") return false;
  const a = nameTokens(subject.name ?? "");
  const b = nameTokens(athleteName ?? "");
  if (!a.length || !b.length) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((t) => long.includes(t));
}

/** What the athlete did with a fact when reviewing it. A correction becomes a new "said" fact; nothing is deleted. */
export const FACT_REVIEW_ACTIONS = ["confirm", "correct", "remove"] as const;
export type FactReviewAction = (typeof FACT_REVIEW_ACTIONS)[number];
/**
 * Every action a fact's history can record (0117, additive): the review card's three, plus "restore" (undo a hide) and
 * "dispute" ("this isn't right": the fact becomes disputed and Mila asks what's true), both from What Nomila knows.
 */
export const FACT_HISTORY_ACTIONS = [...FACT_REVIEW_ACTIONS, "restore", "dispute"] as const;
export type FactHistoryAction = (typeof FACT_HISTORY_ACTIONS)[number];

export interface FactReview {
  id: string;
  athleteId: string;
  factId: string;
  action: FactReviewAction;
  /** action = correct: the athlete's words. */
  correction: string | null;
  /** action = correct: the new "said" fact. */
  replacementFactId: string | null;
  note: string | null;
  createdAt: string;
}

// ─── Memory: brief ────────────────────────────────────────────────────────────────────────────────────────────────

/** The current understanding of the athlete. A new version only when the evidence changes; one current per athlete. */
export interface BriefSection {
  title: string;
  text: string;
  /** The facts this section rests on. */
  factIds: string[];
}

export interface Brief {
  id: string;
  athleteId: string;
  version: number;
  status: "current" | "superseded";
  /** One paragraph, plain words. */
  summary: string;
  sections: BriefSection[];
  /** Every fact the brief rests on (the union of the sections' factIds plus any the summary uses). */
  factIds: string[];
  runId: string | null;
  createdAt: string;
}

// ─── Memory: decisions and outcomes ───────────────────────────────────────────────────────────────────────────────

export const DECISION_RESPONSES = ["pending", "accepted", "edited", "skipped", "expired"] as const;
export type DecisionResponse = (typeof DECISION_RESPONSES)[number];

export const DECISION_OUTCOMES = ["unknown", "worked", "mixed", "did_not_work"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

/** What Mila suggested, why, on what evidence, what the athlete did, and what happened. The learning loop reads this. */
export interface Decision {
  id: string;
  athleteId: string;
  runId: string | null;
  skillId: string;
  /** The suggestion in one line. */
  suggested: string;
  /** Plain-words reason. */
  why: string;
  evidence: EvidenceRef[];
  response: DecisionResponse;
  /** The athlete's reason, when she gave one (e.g. why she skipped). */
  responseReason: string | null;
  respondedAt: string | null;
  outcome: DecisionOutcome;
  outcomeNote: string | null;
  outcomeAt: string | null;
  /** The approval item this decision became, if any. */
  approvalId: string | null;
  createdAt: string;
  /** The goal this decision serves, when it serves one (agent/1, additive). */
  goalId?: string | null;
  /**
   * What the decision is about (0118, additive; memory_decisions.kind): a recommended goal, an action toward a goal, or
   * anything else (every decision written before 0118 is "other").
   */
  kind?: DecisionKind;
  /** The structured detail of a goal or action decision (0118, additive; memory_decisions.detail). {} for "other". */
  detail?: Record<string, unknown>;
  /** An action held for a RECOMMENDED goal points at that goal's decision until the athlete keeps it (0118, additive). */
  parentDecisionId?: string | null;
}

/** What a decision is about (0118): a recommended goal, an action toward a goal, or anything else. */
export const DECISION_KINDS = ["goal", "action", "other"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

// ─── Memory: goals ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A goal the athlete holds, in their words — what the Goals screen shows. source "said" = typed by the athlete;
 * "proposed_accepted" = Mila proposed it and the athlete accepted or edited it (decisionId points at that proposal in
 * the decisions log). Decisions and actions taken FOR a goal point back at it (Decision.goalId). Additive to agent/1.
 */
export const GOAL_SOURCES = ["said", "proposed_accepted"] as const;
export type GoalSource = (typeof GOAL_SOURCES)[number];
export const GOAL_STATUSES = ["active", "paused", "done", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface Goal {
  id: string;
  athleteId: string;
  text: string;
  source: GoalSource;
  status: GoalStatus;
  /** 1 = first. Null until the athlete (or Mila, with the athlete's OK) orders them. */
  priority: number | null;
  /** How the athlete will get there, in plain words (1–2 lines on the Goals screen). */
  gamePlan: string | null;
  decisionId: string | null;
  createdAt: string;
  updatedAt: string;
  /** When it belongs: now | next | later (0118, additive; memory_goals.horizon). Null when nobody has said. */
  horizon?: GoalHorizon | null;
  /** Who wrote the game plan (0118, additive): "mila" (a plan run may rewrite it) or "athlete" (only they change it). */
  gamePlanBy?: GamePlanAuthor;
  /** What the goal is about (0119, additive; memory_goals.domain), from GOAL_DOMAINS. Null when nobody has said. */
  domain?: GoalDomain | null;
}

/**
 * What a goal is about (0119): the closed domain list the app draws a goal card's label and mark from
 * (client/components/strategy/RecommendationVisual.tsx DOMAIN_ICON; the Objective's domains without "evidence").
 * A test pins them equal.
 */
export const GOAL_DOMAINS = ["audience", "content", "positioning", "athletic", "commercial", "relationships", "owned_venture", "impact", "career"] as const;
export type GoalDomain = (typeof GOAL_DOMAINS)[number];

/** Who wrote a goal's game plan (0118). "Set aside" is GOAL_STATUSES "paused": no new status. */
export const GAME_PLAN_AUTHORS = ["mila", "athlete"] as const;
export type GamePlanAuthor = (typeof GAME_PLAN_AUTHORS)[number];

/**
 * What brings a goal a fresh action each time it happens (plan 1.5.0, standing suggestions): `once` is a goal that is
 * done when it is done; every other value is the one trigger that owes it a new action — each dated event of the kind
 * the goal names (`before_event`), every week, each signed deal, new photos or clips, a moment of the kind it names, a
 * new result. Stored on the recommendation's decision row (detail.repeats); a kept goal reads it through
 * memory_goals.decision_id, so no column holds it.
 */
export const GOAL_REPEATS = ["once", "before_event", "weekly", "deal_signed", "new_media", "moment", "after_result"] as const;
export type GoalRepeats = (typeof GOAL_REPEATS)[number];

// ─── Memory: preferences ──────────────────────────────────────────────────────────────────────────────────────────

/**
 *   voice          how she sounds (tone, words she uses or avoids)
 *   avoid          things to stay away from (topics, categories, kinds of partner)
 *   standing_rule  an instruction that runs automatically ("decline category X", "auto-acknowledge new requests")
 *   style          how she likes things done (length, format, timing)
 */
export const PREFERENCE_KINDS = ["voice", "avoid", "standing_rule", "style"] as const;
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];

export interface Preference {
  id: string;
  athleteId: string;
  kind: PreferenceKind;
  /** The preference in her words (or Mila's paraphrase, if source = inferred). */
  statement: string;
  /** said = she told us; inferred = Mila noticed it (shown to her to confirm). */
  source: "said" | "inferred";
  status: "active" | "retired";
  runId: string | null;
  createdAt: string;
}

// ─── Approvals ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What an approval item will do on the tap. Generic verbs. `save_memory` (agent/1, additive) is the chat's "Want me to
 * save that?": a fact, a correction or a preference the athlete told Mila, saved only when they tap Save (propose tools).
 */
export const APPROVAL_VERBS = ["send_message", "post", "publish", "deal_response", "payment", "calendar_invite", "other_act", "save_memory"] as const;
export type ApprovalVerb = (typeof APPROVAL_VERBS)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "dismissed", "failed"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * Where an approval card stands NOW, read from its pending_actions row when a saved chat is loaded (GET
 * /me/conversations/:id attaches it as the card's `approval`), so a reopened chat never asks again for something she
 * already sent or declined. pending → needs_approval (past its expiry → expired); approved → sent; dismissed → declined;
 * failed → failed. `at` is when it got there (sent: executed_at, else approved_at), null while it waits.
 */
export const APPROVAL_CARD_STATES = ["needs_approval", "sent", "declined", "failed", "expired"] as const;
export type ApprovalCardState = (typeof APPROVAL_CARD_STATES)[number];
export interface ApprovalCardStatus { state: ApprovalCardState; at: string | null }

/**
 * Something waiting for the athlete's tap. Stored as a pending_actions row of kind 'agent_action' (the existing
 * propose → approve → execute queue). Only her tap executes it; the agent cannot approve its own items.
 */
export interface ApprovalItem {
  id: string;
  athleteId: string;
  verb: ApprovalVerb;
  /** The act-level tool the tap will run, and the arguments it will run with (shown to her, editable before the tap). */
  tool: string;
  args: Record<string, unknown>;
  /** One line for the card. */
  title: string;
  /** Plain-words summary of what will happen. */
  summary: string;
  /** Present when money moves or is committed. Minor units. */
  money?: { amountMinor: number; currency: string };
  status: ApprovalStatus;
  runId: string | null;
  createdAt: string;
  expiresAt: string | null;
}

// ─── Policy ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The fixed rules. Everything else is the model's judgment inside a skill. `confirm_first` (agent/1, additive): a
 * propose tool is never run by the agent — the call is queued, and only the athlete's tap runs it.
 */
export const POLICY_RULES = ["tenancy", "tap_to_send", "money", "family_privacy", "source_required", "cost_cap", "skill_toolset", "confirm_first", "capability_off", "athlete_deleting"] as const;
export type PolicyRule = (typeof POLICY_RULES)[number];

export interface PolicyDecision {
  decision: "allow" | "deny" | "queue";
  rule: PolicyRule | null;
  reason: string;
}

// ─── Chat cards ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a card's link goes: an app screen (semantic name, the client maps it) or a web URL. */
export type CardLinkTarget = { screen: string; id?: string } | { url: string };

/**
 * The app screens Mila may open from the chat (open_screen): a FIXED allow-list of semantic names the client maps
 * (client/lib/agent/navigate.ts). `goal` needs one of the athlete's goal ids; `scouting` may name a section.
 */
export const OPEN_SCREENS = ["home", "goals", "goal", "me", "scouting", "knows"] as const;
export type OpenScreen = (typeof OPEN_SCREENS)[number];
export const SCOUTING_SECTIONS = ["mia", "working_for_you", "room_to_grow", "brands", "defines"] as const;
export type ScoutingSection = (typeof SCOUTING_SECTIONS)[number];

/**
 * The deal screens Mila's deals_open may point to (AGENT_DEALS_TOOLS): one deal's detail (`id` = the opportunity id),
 * the Deals board, and the closed / past deals (All deals, Closed).
 */
export const DEAL_SCREENS = ["deal", "deals", "deals-closed"] as const;
export type DealScreen = (typeof DEAL_SCREENS)[number];

/** A tap-to-open card: one screen, its label and why Mila points there. Built by code from open_screen. */
export interface OpenScreenCardPayload {
  /**
   * One of open_screen's allow-list, or "camera-roll": the camera-roll review's card (agent/media/tools.ts
   * check_camera_roll, CAMERA_ROLL_INTAKE), whose `id` is the review's filter (shared/cameraRollIntake.ts).
   */
  screen: OpenScreen | "camera-roll" | DealScreen;
  /** The goal id (screen goal) or the scouting section (screen scouting); null otherwise. */
  id: string | null;
  label: string;
  why: string;
}

export interface CardLink {
  label: string;
  target: CardLinkTarget;
}

export const CHAT_CARD_KINDS = [
  "action", "progress", "ready", "connect", "how-i-got-this",
  // Onboarding conversation (agent/1, additive): what Mila found, early insights, proposed goals, what Nomila can do.
  "reveal", "insight", "fact-review", "goal-proposal", "capability", "consent", "age-band",
  "mia-preview", "rate-ranges", "quick-question",
  // The plan step (agent/1, additive): what a goal tool did in the chat (keep, change, set aside, drop, add), with Undo.
  "goal-change",
  // The chat skill (agent/1, additive): a tap-to-open link to one app screen from a fixed allow-list.
  "open-screen",
  // Deals and bookings in the chat (agent/1, additive; AGENT_DEALS_TOOLS / AGENT_BOOKINGS_TOOLS): one deal, a reply for
  // her approval (the Muse pattern), a deal she closed (with Undo), her waiting queue, one booking.
  "deal", "deal-reply", "deal-closed", "deals-waiting", "booking",
  // The research refresh (agent/1, additive): Mila suggests a change to the athlete's strategy; Update · Keep mine · Edit.
  "brief-proposal",
  // Documents in the chat (agent/1, additive; AGENT_DOCUMENTS_TOOLS): one document — brand book, public page or a pitch —
  // with its preview, where it stands and Open · Change something · Share. PROPOSED: the server sends it only while
  // AGENT_DOCUMENTS_CARD is on (off everywhere until the owner approves the card); until then it sends a `ready` card.
  "document",
  // The landing's Mila-hosted waitlist (MILA_TF_WAITLIST, dev only; docs/design/mila-hosted-waitlist.md): Mila asks the
  // landing page to show one of its EXISTING join-flow cards again (show_waitlist_card). Sent only on the waitlist turn's
  // `done`; never saved to the chat history and never sent to the app.
  "waitlist-card",
  // The card system v2 (design "Mila card designs" v2.2, approved 3 Nov 2026; MILA_CARDS_V2, dev only): post ideas as a
  // carousel, a capability offer with its connect sheet, an answer with sources, and a list of deals as row cards. The
  // insight and quick-question kinds above grow in place (shared/milaCards.ts).
  "ideas", "turn-on", "answer", "deals-list",
] as const;
export type ChatCardKind = (typeof CHAT_CARD_KINDS)[number];

/** The landing's existing join-flow cards Mila may ask the page to show (show_waitlist_card). */
export const WAITLIST_CARDS = ["sport", "is_this_you", "handles", "score", "invite"] as const;
export type WaitlistCard = (typeof WAITLIST_CARDS)[number];
export interface WaitlistCardPayload { card: WaitlistCard }

/** An action card: something she can approve, edit or decline. Its buttons drive the approval item. */
export interface ActionCardPayload {
  approvalId: string;
  verb: ApprovalVerb;
  /** The draft text she will review (her own outgoing copy), when there is one. */
  body: string | null;
  money: { amountMinor: number; currency: string } | null;
  buttons: Array<"approve" | "edit" | "decline">;
  /** Its current state, attached when a saved chat is loaded (absent on a live card: it is waiting). */
  approval?: ApprovalCardStatus;
}

/** Work in progress (a worker building something). */
export interface ProgressCardPayload {
  step: number;
  of: number;
  label: string;
  state: "running" | "done" | "failed";
  /** Live research events, newest last (agent/1, additive). */
  events?: ResearchEvent[];
  /** Named steps, each with its state, listed under the bar (agent/1, additive). */
  steps?: Array<{ label: string; state: "pending" | "running" | "done" | "failed" }>;
  /**
   * The plan_refresh workflow run this card follows (agent/1, additive; refresh_plan). The run's tell step finds the
   * chats that asked by it, flips the card to done and writes Mila's follow-up under it.
   */
  planRunId?: string;
  /**
   * The document_build workflow run this card follows (agent/1, additive; documents_make). Its tell step finds the chats
   * that asked by it, flips the card to done (or failed) and writes Mila's line under it with the document's card.
   */
  workflowRunId?: string;
}

/** Something made and ready to review (lands in Studio). */
export interface ReadyCardPayload {
  itemKind: "deck" | "post_kit" | "page" | "visual" | "brief" | "draft" | "other";
  itemId: string;
  summary: string;
  experimental: boolean;
}

/** Ask to connect a service, with the smallest access needed, in plain words. */
export interface ConnectCardPayload {
  connectorId: string;
  service: string;
  access: string[];
  why: string;
}

/** The facts used, with sources, and why — built from the run's trace. Visible to the athlete. */
export interface HowIGotThisCardPayload {
  runId: string;
  skillId: string;
  why: string;
  facts: Array<{ claim: string; type: FactType; source: { label: string; url?: string } }>;
}

/** A source as a card shows it. */
export interface CardSource {
  label: string;
  url?: string;
}

/** "Here's what I found": polished, sourced highlights from research, shown before Mila asks for anything. */
export interface RevealCardPayload {
  /** The headline idea. */
  headline: string;
  /** 3–5 highlights. */
  highlights: Array<{ text: string; factIds: string[]; sources: CardSource[] }>;
  /** Where the athlete stands today (stage, level, momentum). Additive. */
  standing?: { text: string; factIds: string[]; sources: CardSource[] } | null;
  /** Timely windows ahead (season moments, events, deadlines). Additive. */
  windows?: Array<{ text: string; factIds: string[]; sources: CardSource[] }>;
}

/**
 * The M.I.A. PREVIEW (contract mia-preview/1): the existing M.I.A. — same evaluator, params, scorer and ledger — run on the
 * athlete's memory (public found facts + measured connected data). ONE shape for GET/POST /me/mia-preview and the
 * onboarding reveal card. Built by server/services/miaPreview/preview.ts; `assessment` is the exact My Intelligence
 * projection Home's ring reads (client ringBands(assessment)), so the reveal draws the same eight bands of 850.
 */
export type MiaConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

/** One of the ring's eight dimensions, as the read of record stores it (nothing recomputed). */
export interface MiaAssessmentDimension {
  key: string;
  state: "strength" | "neutral" | "gap" | "unknown";
  /** 0–100; null when unknown. */
  score: number | null;
  confidence: MiaConfidenceLevel | null;
  confidenceReason: string | null;
  rationale: string | null;
  components: Array<{ key: string; evidenceClass: "MEASURED" | "EVALUATED" | "ASSUMED" | "MISSING"; confidence: MiaConfidenceLevel | null; rationale: string | null; sources: string[] }>;
  sources: Record<"grounded" | "site_only" | "nomila_supplied" | "not_support" | "unrecorded", string[]>;
  /** The stored top-level weight and score × weight (what sizes the ring's band). */
  weight: number | null;
  contribution: number | null;
  signals: Array<{ key: string; value: number | null; source: string | null; imputed: boolean }>;
}

/** The My Intelligence assessment (my-intelligence/0.2), as served by GET /me/intelligence. */
export interface MiaAssessment {
  entryId: string;
  evidenceAsOf: string;
  createdAt: string;
  versions: { methodology: string | null; evaluator: string | null; params: string | null };
  score: number;
  readState: "assessed" | "assessed_partial" | "insufficient";
  overall: { level: MiaConfidenceLevel | null; explanation: string | null };
  confidenceBand: null;
  summary: string | null;
  hasReasons: boolean;
  dimensions: MiaAssessmentDimension[];
  evidence: Array<{ id: string; claim: string; sourceTitle: string | null; sourceUrl: string | null; sourceType: string | null; observedAt: string | null; strength: "grounded" | "site_only" | "nomila_supplied" | "not_support" | "unrecorded"; domain: string | null }>;
  notes: { strengths: string[]; constraints: string[]; missingEvidence: string[]; evaluationRisks: string[] };
}

/** One of the ring's four groups (Audience, Commercial, Brand, Performance), each pairing two dimensions. */
export interface MiaPreviewGroup {
  key: "audience" | "commercial" | "brand" | "performance";
  name: string;
  /** Σ the dimensions' stored contributions, or null when none is stored. */
  contribution: number | null;
  /** The weight-averaged score (0–100) of its scored dimensions, or null. */
  score: number | null;
  dimensions: Array<{ key: string; score: number | null; weight: number | null; contribution: number | null; state: string }>;
}

/** An input the read used: a public (found) fact, or measured data from a connected account. */
export interface MiaPreviewInput {
  kind: "public" | "measured";
  /** The memory fact behind it; null for a connected account read from the social-features substrate. */
  factId: string | null;
  /** The platform for a measured input; null for a public fact. */
  platform: string | null;
  label: string;
  source: { url: string | null; title: string | null; ref: string | null };
  observedAt: string | null;
}

/**
 * What would sharpen it. `connector` is the onboarding connector id (POST /api/v1/me/connect/:connector) the step needs,
 * or null when no connection helps (evidence the evaluator said it was missing).
 */
export type MiaSharpenStep =
  | { kind: "connect"; connector: string; service: string; reason: "measured_audience" }
  | { kind: "awaiting_data"; connector: string; service: string; reason: "connected_not_yet_read" }
  | { kind: "evidence"; connector: null; text: string };

export interface MiaPreview {
  contract: "mia-preview/1";
  athleteId: string;
  status: "ready" | "withheld_identity" | "not_assessed" | "missing_identity";
  /** 0–850 (the M.I.A. scale), or null. */
  score: number | null;
  scale: { min: 0; max: 850 };
  /** Always four, in the ring's order. */
  groups: MiaPreviewGroup[];
  /** The exact projection Home's ring reads; null when there is no read. */
  assessment: MiaAssessment | null;
  /** True unless measured data from at least one connected account went into the read. */
  preliminary: boolean;
  /** "Preliminary — connect to sharpen" while preliminary; null otherwise. */
  label: string | null;
  /** The evaluator's own overall confidence (rubric levels), never a number. */
  confidence: { level: MiaConfidenceLevel | null; explanation: string | null };
  inputs: { public: MiaPreviewInput[]; measured: MiaPreviewInput[] };
  sharpen: MiaSharpenStep[];
  evidenceAsOf: string | null;
  identity: { uncertain: boolean; factIds: string[] };
  provenance: { ledgerEntryId: string; evaluationRunId: string | null; snapshotId: string | null; digest: string | null; evidenceAsOf: string } | null;
  /** getMiaPreview only: what this call did. */
  computed?: "evaluated" | "reused" | "withheld" | "declined" | "skipped" | "in_flight";
}

export interface MiaPreviewCardPayload {
  preview: MiaPreview;
  /** Plain words: what "preliminary" means here and what sharpens it. */
  note: string;
}

/** Early rate ranges, with honest confidence. Wide without connected data; they sharpen when the athlete connects. */
export interface RateRangesCardPayload {
  items: Array<{ deliverable: string; low: number; high: number; currency: string; drivers: string[] }>;
  confidence: "low" | "medium" | "high";
  /** True when no connected-account data backs the ranges. */
  sharpenWithConnect: boolean;
  /** The social connectors (onboarding connector ids) whose connection would sharpen them; [] when none would. */
  sharpenConnectors: string[];
  /** Plain words, e.g. "Estimates from public data — these sharpen when you connect your accounts." */
  note: string;
  factIds: string[];
}

/** A quick question Mila asks (during the research wait or later); the answer comes back as a chat message. */
export interface QuickQuestionCardPayload {
  question: string;
  options: string[];
  why: string;
  /** Card system v2 (MILA_CARDS_V2): the brands' logo stack or atmosphere, a context line, and the once block. */
  media?: import("./milaCards").CardMedia | null;
  context?: string | null;
  once?: import("./milaCards").OnceBlock;
}

/** An early insight from the brief (a brand read, a strength, a gap, a timely opening). Proves value first. */
export interface InsightCardPayload {
  angle: "brand" | "strength" | "gap" | "timing" | "opportunity";
  text: string;
  factIds: string[];
  sources: CardSource[];
  /**
   * A strength or gap comes from the M.I.A. only: the M.I.A. dimension it rests on (e.g. "audience_scale"). Null for
   * every other angle; absent on cards written before onboarding 1.7.0.
   */
  miaDimension?: string | null;
}

/** The insight card as the card system v2 grows it (decision 10: one type, one view): `text` stays the v1 line. */
export type InsightCardPayloadV2 = Partial<InsightCardPayload> & import("./milaCards").InsightV2Payload;

/** Facts for the athlete to confirm, correct or remove. A correction becomes a "said" fact; a removal is recorded. */
/**
 * A fact's sensitivity as cards and APIs carry it: none | care | never. Stored as memory_facts.sensitive (care = true);
 * "never" facts are never stored, so a stored fact is none or care.
 */
export type FactSensitivity = "none" | "care" | "never";

export interface FactReviewCardPayload {
  facts: Array<{ factId: string; claim: string; type: FactType; date: string | null; status: FactStatus; sensitivity: FactSensitivity; sources: CardSource[] }>;
  buttons: Array<"confirm" | "correct" | "remove">;
}

/** When a goal or action belongs: now (this month), next (this season / quarter), later (the year ahead). */
export const GOAL_HORIZONS = ["now", "next", "later"] as const;
export type GoalHorizon = (typeof GOAL_HORIZONS)[number];

/**
 * A goal Mila proposes (Decide-lite). Accept, edit or skip; the proposal is a Decision, an accepted one becomes a Goal.
 * Every proposal carries why now, the evidence, the value and the next decision the athlete would make.
 */
export interface GoalProposalCardPayload {
  decisionId: string;
  goal: string;
  horizon: GoalHorizon;
  /** Why now, in one or two sentences. */
  why: string;
  /** What it is worth to the athlete (a range with its drivers, never false precision). */
  value: string;
  /** How sure the value is, like the rate cards: "low" without connected data (agent/1, additive). */
  valueConfidence?: "low" | "medium" | "high";
  /** The next decision the athlete would make if they take it on. */
  nextDecision: string;
  factIds: string[];
  sources: CardSource[];
  buttons: Array<"accept" | "edit" | "skip">;
}

/**
 * A consent tap. The terms are fixed text owned by Nomila (never model-written); Mila only chooses when to ask.
 * consentId names the terms and their version, e.g. "how_mila_works/1".
 */
export interface ConsentCardPayload {
  consentId: string;
  title: string;
  points: string[];
  buttons: Array<"agree" | "not_now">;
}

/**
 * Something Nomila can do for the athlete. Each capability is an ENTRY POINT: tapping it starts its own skill or
 * workflow (or opens its screen), so later skills plug in without changing onboarding.
 */
export interface CapabilityEntry {
  /** Stable, generic id (e.g. "deals"). */
  id: string;
  label: string;
  /** The skill that starts when the athlete taps it, once that skill exists. */
  skillId: string | null;
  /** Or the workflow process it starts. */
  workflow: string | null;
  /** Or the app screen it opens (semantic name, the client maps it). */
  screen: string | null;
  /** False until the skill / workflow / screen behind it is live; the card then says "coming soon". */
  available: boolean;
}

export interface CapabilityCardPayload {
  capability: CapabilityEntry;
  /** Mila's one-line pitch of this capability for THIS athlete. */
  pitch: string;
}

interface ChatCardBase<K extends ChatCardKind, P> {
  id: string;
  kind: K;
  title: string;
  payload: P;
  links: CardLink[];
  runId: string | null;
}

export type ChatCard =
  | ChatCardBase<"action", ActionCardPayload>
  | ChatCardBase<"progress", ProgressCardPayload>
  | ChatCardBase<"ready", ReadyCardPayload>
  | ChatCardBase<"connect", ConnectCardPayload>
  | ChatCardBase<"how-i-got-this", HowIGotThisCardPayload>
  | ChatCardBase<"reveal", RevealCardPayload>
  | ChatCardBase<"insight", InsightCardPayload | InsightCardPayloadV2>
  | ChatCardBase<"fact-review", FactReviewCardPayload>
  | ChatCardBase<"goal-proposal", GoalProposalCardPayload>
  | ChatCardBase<"capability", CapabilityCardPayload>
  | ChatCardBase<"consent", ConsentCardPayload>
  | ChatCardBase<"age-band", AgeBandCardPayload>
  | ChatCardBase<"mia-preview", MiaPreviewCardPayload>
  | ChatCardBase<"rate-ranges", RateRangesCardPayload>
  | ChatCardBase<"quick-question", QuickQuestionCardPayload>
  | ChatCardBase<"goal-change", GoalChangeCardPayload>
  | ChatCardBase<"open-screen", OpenScreenCardPayload>
  | ChatCardBase<"deal", DealCardPayload>
  | ChatCardBase<"deal-reply", DealReplyCardPayload>
  | ChatCardBase<"deal-closed", DealClosedCardPayload>
  | ChatCardBase<"deals-waiting", DealsWaitingCardPayload>
  | ChatCardBase<"booking", BookingCardPayload>
  | ChatCardBase<"brief-proposal", BriefProposalCardPayload>
  | ChatCardBase<"document", DocumentCardPayload>
  | ChatCardBase<"waitlist-card", WaitlistCardPayload>
  | ChatCardBase<"ideas", import("./milaCards").IdeasCardPayload>
  | ChatCardBase<"turn-on", import("./milaCards").TurnOnCardPayload>
  | ChatCardBase<"answer", import("./milaCards").AnswerCardPayload>
  | ChatCardBase<"deals-list", import("./milaCards").DealsListCardPayload>;

// ─── Documents in the chat (agent/1, additive; AGENT_DOCUMENTS_TOOLS) ─────────────────────────────────────────────
//
// Built by code from what the documents_* tools returned (server/agent/documents), never from model prose. Nothing on the
// card shares or publishes by itself: Share sends Mila the words "Share my …", which comes back as an approval (action)
// card that only the athlete's tap runs. PROPOSED (design "Mila and the documents", 23 Oct 2026): sent only while
// AGENT_DOCUMENTS_CARD is on; no client draws it yet.

/** One of the athlete's three documents. */
export type DocumentKind = "brand_book" | "public_page" | "pitch";

/** Where a document stands, in the card's words. */
export type DocumentState = "none" | "building" | "ready" | "failed";

export interface DocumentCardPayload {
  kind: DocumentKind;
  /** The brand a pitch is for (name and logo only); null for the brand book and the public page. */
  brand: { id: number; name: string; logoUrl: string | null } | null;
  state: DocumentState;
  /** One short line under the title: "Ready · updated today · not shared yet", "Published · version 3". */
  statusLine: string;
  /** The cover as a signed image URL (expires in about an hour; the client re-reads the document when it fails). */
  thumbUrl: string | null;
  updatedAt: string | null;
  /** Pitch: shared at least once, and how many opens since. Null for the others. */
  shared: { opens: number } | null;
  /** Public page: published, with its version. Null for the others. */
  published: { version: number | null } | null;
  /** The words each button sends Mila (Change something · Share); null hides the button. Open is the card's link. */
  actions: { change: string | null; share: string | null };
}

// ─── Deals and bookings in the chat (agent/1, additive) ───────────────────────────────────────────────────────────
//
// Built by code from what the deals.* / bookings.* tools returned (server/agent/deals, server/agent/bookings), never from
// model prose. Her floor is never in a card as a number. Nothing on these cards sends or moves money by itself: Send
// approves the existing send_reply proposal (POST /pending-actions/:id/approve with the body's hash), a booking's Accept
// and Decline are the existing /me/bookings/:id/accept | decline taps.

/** The brand as a card draws it (LogoMark): research fields only when confirmed. */
export interface DealCardBrand {
  name: string;
  logoUrl: string | null;
  domain: string | null;
  isPerson: boolean;
}

export type DealWhoseMove = "yours" | "theirs" | "nobody";

/** One deal: logo mark, the money, whose move, the read's chips, ONE action and "Open deal". */
export interface DealCardPayload {
  /** The opportunity id: "Open deal" opens its detail (closed ones read-only). */
  opportunityId: string;
  brand: DealCardBrand;
  /** Paid · Interview · Gift … (the type chip). */
  typeLabel: string | null;
  moneyLine: string;
  whoseMove: DealWhoseMove;
  /** "Your move" · "Waiting on them" · "Agreed" · "Closed". */
  moveLabel: string;
  /** Short read chips (≤ 3): "Above your minimum", "Nothing to flag", "Helps a goal". */
  chips: string[];
  /** The one next action, as words she sends Mila on tap ("Draft the counter"). Null when closed. */
  action: { label: string; message: string } | null;
  closed: boolean;
}

/** Where a reply goes out from: the inbox's own mark leads the approval card. */
export type ReplyInbox = "gmail" | "outlook" | "instagram" | "nomila";

/**
 * A reply for her approval (the Muse pattern): the inbox's logo, "Send this email from your Gmail?", From / To / Subject
 * / attachment / body, Send · Edit first · Not now. No "always allow": every message to a brand needs her tap. The card
 * reads `pendingActionId`'s status from the server, so "Sent … exactly as approved" survives reopening the chat.
 */
export interface DealReplyCardPayload {
  /** The inert send_reply proposal Send approves. */
  pendingActionId: string;
  /** sha256 of `body` (shared/bodyHash): sent with the approve so the approved body is the sent body. */
  bodySha256: string;
  opportunityId: string;
  dealId: string;
  threadId: string | null;
  brand: DealCardBrand;
  /** The reply intent (shared deal vocabulary) and its words ("Counter"). */
  intent: string;
  intentLabel: string;
  inbox: ReplyInbox | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  attachment: string | null;
  body: string;
  /** False when there is no in-app send path (Outlook, no inbound message): the card says where to reply instead. */
  sendable: boolean;
  whyNotSendable: string | null;
  /** Its current state, attached when a saved chat is loaded (the card also reads the live row itself). */
  approval?: ApprovalCardStatus;
}

/** A deal she closed from the chat (D1): her action, with Undo, and an optional polite no that still needs her tap. */
export interface DealClosedCardPayload {
  opportunityId: string;
  brand: DealCardBrand;
  reason: "not_a_deal" | "not_interested" | "expired";
  reasonLabel: string;
  /** The receipt Undo reverses (POST /agent-actions/:id/undo). Null when nothing can be undone. */
  receiptId: string | null;
  /** Always "you": the receipt is hers, never "set aside by Nomila". */
  actor: "you";
  /** The polite no, waiting for her Send (a full reply card). Null when she didn't want one. */
  politeNo: DealReplyCardPayload | null;
}

/** "3 replies are waiting for your tap": her queue of drafts and ask-for-terms messages. */
export interface DealsWaitingCardPayload {
  count: number;
  items: Array<{ pendingActionId: string; kind: "reply" | "ask_terms" | "other"; opportunityId: string | null; brand: string | null; title: string; createdAt: string }>;
}

/**
 * Where a booking stands, in her words (by shared/bookingsApi BookingPhase). Mila's bookings tools and the booking card
 * say the same; the card reads the booking's LIVE phase, so a reopened chat never offers Accept on an answered request.
 */
export const BOOKING_STATUS_LABEL: Record<string, string> = {
  request: "Waiting for you", waiting_buyer: "Waiting on the buyer", waiting_payment: "Waiting for payment", booked: "Confirmed",
  happening: "Happening now", finished: "After the session", on_hold: "On hold", paid: "Paid out", declined: "Declined",
  withdrawn: "Withdrawn", expired: "Expired", canceled: "Canceled", refunded: "Refunded",
};

/** One booking: who, what, when, the money (held until the session), where it stands; Accept / Decline on a request. */
export interface BookingCardPayload {
  bookingId: string;
  /** The buyer as the app shows them (first name and initial; never contact details). */
  who: string;
  what: string;
  when: string | null;
  moneyLine: string;
  statusLabel: string;
  /** A request waiting for her answer. */
  waitingForYou: boolean;
  /** Mila suggested this answer (bookings_respond): the card leads with it. Her tap still decides, on the existing taps. */
  suggested: "accept" | "decline" | null;
}

/**
 * A goal-change card (agent/1, additive): what a goal tool did in the chat, with Undo. Built by code from the tool's
 * result, never from model prose. `undoDecisionId` is the change's decision row (POST /me/agent/goals/changes/:id/undo);
 * null when there is nothing to undo (a suggestion only adds a recommendation).
 */
export interface GoalChangeCardPayload {
  op: "keep" | "change" | "set_aside" | "drop" | "add" | "bring_back" | "suggest";
  goalId: string | null;
  /** The goal before the change (null for keep, add and suggest). */
  before: { text: string; horizon: GoalHorizon | null; status: GoalStatus } | null;
  after: { text: string; horizon: GoalHorizon | null; status: GoalStatus | "recommended" };
  /** This week's actions for the goal after the change, as titles (≤ 3). */
  thisWeek: Array<{ title: string; state: "to_start" | "made" | "done" }>;
  undoDecisionId: string | null;
}

/**
 * Mila's suggestion to change the athlete's strategy (agent/1, additive; the research refresh, 12 Oct 2026). A refresh
 * found something material (a new team or level, a big audience shift, a new partner, an injury or comeback) and
 * Understand rewrote the strategy; the athlete's strategy has NOT changed. Built by code from the stored proposal
 * (memory_decisions, detail.kind "brief_proposal"), never from model prose beyond the proposal's own text.
 *   update     her strategy becomes the suggestion
 *   keep_mine  nothing changes; the same suggestion is not raised again unless the facts change further
 *   edit       the suggestion, with the positioning statement in her words (kept as hers on every later refresh)
 * POST /me/agent/suggestions/:decisionId { response: "update" | "keep_mine" | "edit", statement? }.
 */
export interface BriefProposalCardPayload {
  decisionId: string;
  /** Plain words to the athlete: what changed and why the strategy should move. */
  reason: string;
  changed: Array<"thesis" | "positioning" | "pillars" | "narrative">;
  before: BriefStrategyView;
  after: BriefStrategyView;
  sources: CardSource[];
  buttons: Array<"update" | "keep_mine" | "edit">;
  /** Her answer, once given (a card re-read from history shows it settled). */
  answered: null | "update" | "keep_mine" | "edit";
}

/** The strategy as the athlete reads it, for the suggestion card. */
export interface BriefStrategyView {
  bigIdea: string;
  statement: string;
  from: string;
  to: string;
  pillars: string[];
  contentPillars: string[];
}

// ─── Research events (agent/1, additive) ──────────────────────────────────────────────────────────────────────────

/**
 * What the UI shows live while research runs. Emitted as the work happens (sources as searches return, discoveries as
 * the model writes them) and kept on the run, so any instance can serve them:
 *   reading    a source a search pass is reading (domain + title)
 *   discovery  a short, sourced line a pass has found (preliminary: the merge checks it)
 *   pass_done  a pass finished, with how many facts it kept
 */
export type ResearchEvent =
  | { kind: "reading"; at: string; pass: "a" | "b"; domain: string; title?: string; url: string }
  | { kind: "discovery"; at: string; pass: "a" | "b"; text: string; source: { domain: string; url: string; title?: string } }
  | { kind: "pass_done"; at: string; pass: "a" | "b"; facts: number };
export const RESEARCH_EVENT_KINDS = ["reading", "discovery", "pass_done"] as const;

/**
 * Self-declared age band: OPTIONAL information (a "said" fact) that gates nothing. There are no product-imposed age
 * restrictions; only what law or partners impose is explained in plain words (payout accounts follow Stripe's rules;
 * accounts under 13 are not supported; NIL / eligibility rules vary — "check your school/association rules").
 */
export const AGE_BANDS = ["under_18", "18_plus"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/** Ask the athlete's age band (optional; fixed question and options; Mila only chooses whether and when). */
export interface AgeBandCardPayload {
  question: string;
  options: Array<{ value: AgeBand; label: string }>;
}

// ─── Onboarding checkpoints (agent/1, additive) ──────────────────────────────────────────────────────────────────

/**
 * Onboarding is ADAPTIVE: the model picks the order, depth, follow-ups and wording from what the athlete says. These
 * checkpoints are what code tracks (and what makes it resumable): onboarding is done when every REQUIRED one is met.
 *   name_sport      the athlete gave a name and a sport
 *   reveal          Mila showed "here's what I found" (always before Mila asks for anything)
 *   facts_review    the athlete was given the chance to confirm / correct / remove facts
 *   connect_offers  every useful connection was offered once (declining is fine; re-offers are capped, never nagging)
 *   goal            the athlete holds at least one goal (typed, or a recommendation kept) — tracked, NOT required
 *   capabilities    Mila introduced what Nomila can do
 *   consent         the athlete tapped to agree to how Mila works
 */
export const ONBOARDING_CHECKPOINTS = ["name_sport", "reveal", "facts_review", "connect_offers", "goal", "capabilities", "consent"] as const;
export type OnboardingCheckpoint = (typeof ONBOARDING_CHECKPOINTS)[number];

/**
 * The checkpoints onboarding WAITS for (onboarding 1.8.0, the plan step): every one but `goal`. Goals are optional
 * recommendations written by the plan run; `goal` is still tracked (offered / done / declined) so a resume knows where
 * it stood, but onboarding never waits for a goal or for the plan run.
 */
export const REQUIRED_ONBOARDING_CHECKPOINTS: ReadonlyArray<Exclude<OnboardingCheckpoint, "goal">> =
  ["name_sport", "reveal", "facts_review", "connect_offers", "capabilities", "consent"];

/** pending → offered (shown, waiting) → done; declined = the athlete said no (connect offers, consent "not now"). */
export const CHECKPOINT_STATUSES = ["pending", "offered", "done", "declined"] as const;
export type CheckpointStatus = (typeof CHECKPOINT_STATUSES)[number];

// ─── The chat wire (AGENT_V3) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What a harness chat turn adds to the existing SSE `done` event (field-presence additive, like the rest of that wire):
 * `cards` (rendered under the answer, in order) and `runId` (opens "How I got this"). Absent on the old loop.
 */
export interface AgentDoneFields {
  runId: string;
  cards?: ChatCard[];
}
