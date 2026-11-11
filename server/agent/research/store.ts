/**
 * agent/research/store.ts — what the Research / Understand / onboarding skills need from memory, as one port.
 *
 * Two implementations: dbStore.ts (Drizzle over agent_runs + the memory_* tables, the real one) and the in-memory
 * store below (the smoke script, which must never write to a database, and pure unit tests). Every method is scoped by
 * athleteId: nothing reads or writes across athletes.
 *
 * This is a narrow port, not the harness's memory layer: when server/agent/memory.ts lands on the harness branch the
 * Drizzle implementation delegates to it, and this interface stays as the seam the skills are written against.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Brief, BriefSection, Decision, DecisionResponse, EvidenceRef, FactHistoryAction, FactStatus, FactType, Goal,
  MemoryFact, ModelChoice, RunCost, RunStatus, RunTrigger, StopReason, SubjectRef, TraceStep,
  CheckpointStatus, OnboardingCheckpoint, GoalSource, DecisionKind, GoalHorizon, GamePlanAuthor, GoalDomain,
} from "../../../shared/agent";
import { DATE_PRECISIONS, IDENTITY_FIELDS, ONBOARDING_CHECKPOINTS } from "../../../shared/agent";
import type { StageBand } from "./schemas";
import type { RateType } from "../../../shared/deals";
import { cleanNewFact } from "../factHygiene";

export interface NewFact {
  subject: SubjectRef;
  claim: string;
  type: FactType;
  source: { url?: string; ref?: string; title?: string };
  date: string | null;
  confidence: number;
  status?: FactStatus;
  disputes?: string | null;
  alsoSeenAt?: Array<{ url: string; title?: string }>;
  sensitive?: boolean;
  /** Set only on a care fact (0113): personal | conduct. */
  careKind?: MemoryFact["careKind"];
  /** The research topic (0115); research and merge write it. */
  topic?: string | null;
  /** The source's outlet type (0115); research and merge write it. */
  sourceType?: MemoryFact["sourceType"];
  /** How precise the date is (0119): day | month | year. Research and merge write it from the raw date. */
  datePrecision?: MemoryFact["datePrecision"];
  /** The identity field an identity fact about the athlete states, and its value (0119); merge writes them. */
  field?: MemoryFact["field"];
  fieldValue?: string | null;
  runId: string | null;
}

/** What a refresh may change on a fact (AgentStore.refreshFact). */
export interface FactRefresh {
  /** The subject's name as the refresh found it (the event's current name); unchanged when absent. */
  subjectName?: string;
  claim: string;
  source: { url?: string; ref?: string; title?: string };
  sourceType?: MemoryFact["sourceType"];
  date: string | null;
  datePrecision?: MemoryFact["datePrecision"];
  confidence: number;
  runId: string | null;
  /** True marks the fact care (personal unless it already has a kind). A refresh never clears care. */
  sensitive?: boolean;
}

/**
 * A refresh, cleaned (claim and source by the insert rules), with the previous source URL carried into also-seen when the
 * source URL changed, so where the fact was seen before is never lost.
 */
export function refreshedFields(prev: MemoryFact, patch: FactRefresh): { claim: string; source: FactRefresh["source"]; alsoSeenAt: Array<{ url: string; title?: string }> } {
  const carried = prev.source.url && prev.source.url !== patch.source.url
    ? [{ url: prev.source.url, ...(prev.source.title ? { title: prev.source.title } : {}) }, ...(prev.alsoSeenAt ?? [])]
    : prev.alsoSeenAt ?? [];
  const clean = cleanNewFact({ claim: patch.claim, source: patch.source, alsoSeenAt: carried });
  return {
    claim: clean.claim.slice(0, 2000),
    source: { ...(clean.source.url ? { url: clean.source.url } : {}), ...(clean.source.ref ? { ref: clean.source.ref } : {}), ...(clean.source.title ? { title: clean.source.title } : {}) },
    alsoSeenAt: (clean.alsoSeenAt ?? []).filter((a) => a.url !== clean.source.url),
  };
}

/**
 * The 0119 columns of a fact about to be stored, as both stores write them: a precision only with a date and from the
 * list; a field only from IDENTITY_FIELDS and only with a value (a few words, at most 120 characters), else neither.
 */
export function factExtrasOf(n: NewFact): { datePrecision: MemoryFact["datePrecision"]; field: MemoryFact["field"]; fieldValue: string | null } {
  const datePrecision = n.date && n.datePrecision && (DATE_PRECISIONS as readonly string[]).includes(n.datePrecision) ? n.datePrecision : null;
  const value = String(n.fieldValue ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const field = n.field && (IDENTITY_FIELDS as readonly string[]).includes(n.field) && value ? n.field : null;
  return { datePrecision, field, fieldValue: field ? value : null };
}

/** A brief line: one or two sentences, a fact or an inference, and the facts it rests on. */
export interface BriefLine {
  text: string;
  kind: "fact" | "inference";
  factIds: string[];
}

/** The contract's BriefSection plus the section key and its lines (additive fields, stored in the same jsonb). */
export interface StoredBriefSection extends BriefSection {
  key: string;
  lines: BriefLine[];
  /** The commercial implication, addressed to the athlete ("you"). */
  soWhat?: string;
}

export interface StoredBrief extends Omit<Brief, "sections"> {
  sections: StoredBriefSection[];
  /** The structured display fields as Understand returned them (memory_briefs.display, 0114); null before 0114. */
  display: BriefDisplay | null;
}

/**
 * The Brief's structured display fields, stored as Understand returned them (keys stripped from prose, refs mapped to
 * fact ids): the stage and the positioning. The per-section so-what lives on each section (StoredBriefSection.soWhat).
 * The Scouting report hero shows positioning.statement over "<stage.label> · <stage.band>".
 */
export interface BriefDisplay {
  stage: { label: string; band: StageBand; confidence: number; why: string; factIds: string[] };
  positioning: { from: string; to: string; statement: string; pillars: Array<{ name: string; line: string; factIds: string[] }>; factIds: string[] };
  /** understand 1.11.0: the 2–4 content pillars, each on at least one fact. Absent on a Brief written before 1.11.0. */
  contentPillars?: ContentPillar[];
  /**
   * The parts of the strategy the ATHLETE wrote (her "Edit it" on a Mila suggestion, agent research refresh): carried
   * forward on every refresh and shown to Understand as hers. Absent when she never edited.
   */
  editedByAthlete?: { fields: Array<"statement">; at: string };
}

/**
 * The strategy part of a Brief — what a research refresh CARRIES FORWARD unless the facts materially changed, and what
 * a Mila suggestion proposes to change (agent/researchRefresh/proposal.ts): the thesis and positioning sections as
 * stored, the positioning and content pillars as displayed, and the narrative (the Brief's summary).
 */
export interface BriefStrategy {
  thesis: StoredBriefSection | null;
  positioningSection: StoredBriefSection | null;
  positioning: BriefDisplay["positioning"] | null;
  contentPillars: ContentPillar[];
  summary: string;
}

/** Understand's carry-forward answer on a refresh, when the facts materially changed (understand 1.12.0). */
export interface BriefProposalDraft {
  kinds: string[];
  /** To the athlete, plain words: what changed and why the strategy should move. */
  reason: string;
  /** The NEW facts behind the change (ids). */
  factIds: string[];
  before: BriefStrategy;
  after: BriefStrategy;
  /** Which parts differ: thesis · positioning · pillars · narrative. */
  changed: Array<"thesis" | "positioning" | "pillars" | "narrative">;
}

/**
 * A content pillar (understand 1.11.0): a theme this athlete can always post about, whether or not anything dated is
 * happening, chosen from the athlete's own facts (never a fixed list). Apart from the three positioning pillars.
 */
export interface ContentPillar {
  /** P1…P4, in the order Understand returned them. */
  key: string;
  name: string;
  /** One line: why this theme fits this athlete specifically. */
  whyThisAthlete: string;
  /** The facts it rests on (at least one). */
  factIds: string[];
}

/**
 * The internal read: stored for Nomila, never returned whole by an athlete-facing route. Sponsors — current kept apart
 * from past (the eval's grader reads them) — and, since understand 1.9.0, the exclusivity and category conflicts: each
 * says what it is and what it blocks, with the facts it rests on. The Scouting report shows a conflict's words ("Your
 * brands") and the plan's pitch check reads what it blocks. No scores: the M.I.A. is the only score.
 */
export interface BriefInternal {
  currentSponsors: BriefSponsor[];
  pastSponsors: BriefSponsor[];
  /** Absent on a Brief written before understand 1.9.0. */
  exclusivityConflicts?: ExclusivityConflict[];
  /**
   * understand 1.13.0: the suggested rate range per kind of work that fits her, validated (services/rates.ts stores
   * them in athlete_rate_ranges, source "brief"). Private. Absent on a Brief written before 1.13.0.
   */
  rateRanges?: BriefRateRange[];
}

/** One suggested rate range (understand 1.13.0): whole currency units, low ≤ high, both above zero. */
export interface BriefRateRange {
  rateType: RateType;
  low: number;
  high: number;
  currency: string;
  confidence: "low" | "medium" | "high";
  /** What moves the range for her (at least one). */
  drivers: string[];
  /** The facts it rests on (unknown keys dropped; may be empty). */
  factIds: string[];
}

/** A partner in the internal read. */
export interface BriefSponsor {
  name: string;
  factIds: string[];
  /**
   * understand 1.10.0: when the partnership started (YYYY or YYYY-MM), only when a fact it rests on states it in its
   * claim; never inferred. Absent when unknown (and on every Brief written before 1.10.0).
   */
  since?: string;
}

/** One exclusivity or category conflict (understand 1.9.0): never a score. */
export interface ExclusivityConflict {
  /** The conflict in one plain sentence (who holds what: "Your team's apparel partner holds the apparel category"). */
  what: string;
  /** What it blocks, each a brand or a kind of brand in a few words, as the facts name them. */
  blocks: string[];
  /** The facts it rests on (at least one). */
  factIds: string[];
}

export interface RunStart {
  athleteId: string;
  skillId: string;
  skillVersion: string;
  trigger: RunTrigger;
  model: ModelChoice;
  /** What started it, e.g. "workflow:<run id>:<step>". A finished run with the same ref is reused, never repaid. */
  parentRef: string | null;
}

export interface RunFinish {
  status: Exclude<RunStatus, "running">;
  stopReason: StopReason | null;
  cost: RunCost;
  steps: TraceStep[];
  evidenceRead: EvidenceRef[];
  output: unknown;
  error: string | null;
}

export interface StoredRun {
  id: string;
  athleteId: string;
  skillId: string;
  skillVersion: string;
  /** What started it (chat | schedule | event | approval | test). */
  trigger: RunTrigger;
  model: ModelChoice;
  status: RunStatus;
  stopReason: StopReason | null;
  cost: RunCost;
  steps: TraceStep[];
  evidenceRead: EvidenceRef[];
  output: unknown;
  parentRef: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface NewDecision {
  runId: string | null;
  skillId: string;
  suggested: string;
  why: string;
  evidence: EvidenceRef[];
  /** 0118: goal | action | other (default other). */
  kind?: DecisionKind;
  /** 0118: the structured detail (default {}). */
  detail?: Record<string, unknown>;
  goalId?: string | null;
  parentDecisionId?: string | null;
  /** Default pending. A change the athlete made themselves is recorded already answered. */
  response?: DecisionResponse;
}

/** What may change on a decision after it is written. */
export interface DecisionPatch {
  /**
   * A conditional write: apply the patch only while the row still holds exactly this detail and this response (what
   * the writer read). A row that changed in between is left alone and the update answers null, so a slow writer never
   * overwrites a newer one (the post-kit builder and its edits use it).
   */
  ifUnchanged?: { detail: Record<string, unknown>; response: DecisionResponse };
  suggested?: string;
  why?: string;
  evidence?: EvidenceRef[];
  detail?: Record<string, unknown>;
  runId?: string | null;
  goalId?: string | null;
  parentDecisionId?: string | null;
  response?: DecisionResponse;
  responseReason?: string | null;
}

/** Which decisions to list. Every filter is optional and ANDed; the athlete is always the first argument. */
export interface DecisionFilter {
  runId?: string;
  skillId?: string;
  kinds?: DecisionKind[];
  responses?: DecisionResponse[];
  /** Created at or after (ISO). */
  since?: string;
  goalId?: string;
  parentDecisionId?: string;
}

/** What may change on a goal. */
export interface GoalPatch {
  text?: string;
  status?: Goal["status"];
  horizon?: GoalHorizon | null;
  gamePlan?: string | null;
  gamePlanBy?: GamePlanAuthor;
  priority?: number | null;
  /** 0119: what the goal is about (GOAL_DOMAINS). */
  domain?: GoalDomain | null;
}

export interface CheckpointRow {
  status: CheckpointStatus;
  offers: number;
  lastTurn: number | null;
  detail: Record<string, any>;
}
export type CheckpointState = Record<OnboardingCheckpoint, CheckpointRow>;
export interface CheckpointPatch {
  status?: CheckpointStatus;
  /** Add to the offer count. */
  offersInc?: number;
  lastTurn?: number;
  /** Replaces detail. */
  detail?: Record<string, any>;
}

export const emptyCheckpoints = (): CheckpointState =>
  Object.fromEntries(ONBOARDING_CHECKPOINTS.map((c) => [c, { status: "pending", offers: 0, lastTurn: null, detail: {} }])) as CheckpointState;

export interface AgentStore {
  startRun(r: RunStart): Promise<string>;
  finishRun(athleteId: string, runId: string, f: RunFinish): Promise<void>;
  getRun(athleteId: string, runId: string): Promise<StoredRun | null>;
  /** The completed run started by this parent ref, if any (idempotent retries). */
  findCompletedRun(athleteId: string, parentRef: string): Promise<StoredRun | null>;
  /** Total cost of the athlete's runs whose parent ref starts with this prefix (one onboarding = one prefix). */
  costByParentPrefix(athleteId: string, prefix: string): Promise<RunCost>;
  /** The athlete's runs whose parent ref starts with this prefix, oldest first. */
  listRunsByPrefix(athleteId: string, prefix: string): Promise<StoredRun[]>;
  /** Replace a finished run's output (a turn adds the cards it built to the model's JSON). */
  setRunOutput(athleteId: string, runId: string, output: unknown): Promise<void>;
  /** The athlete's runs started at or after `since` (ISO), optionally of one skill, oldest first (budgets, guards). */
  listRunsSince(athleteId: string, opts: { since: string; skillId?: string }): Promise<StoredRun[]>;
  /**
   * Her voice spend today (UTC), ESTIMATED (voice/voiceMinutes.ts voiceSpendTodayMicroUsd), so the day caps that sum
   * her runs (athleteDaySpendMicroUsd below) also count voice. Optional: a store without it (the in-memory one) has no
   * voice, so it adds 0.
   */
  voiceSpendTodayMicroUsd?(athleteId: string, now: Date): Promise<number>;

  /** Onboarding checkpoints for one onboarding (scope = its workflow run id). Missing rows read as pending. */
  getCheckpoints(athleteId: string, scope: string): Promise<CheckpointState>;
  setCheckpoint(athleteId: string, scope: string, checkpoint: OnboardingCheckpoint, patch: CheckpointPatch): Promise<void>;

  listFacts(athleteId: string, statuses?: FactStatus[]): Promise<MemoryFact[]>;
  getFacts(athleteId: string, ids: string[]): Promise<MemoryFact[]>;
  insertFacts(athleteId: string, facts: NewFact[]): Promise<MemoryFact[]>;
  setFactStatus(athleteId: string, factId: string, status: FactStatus, links?: { disputes?: string | null; supersededBy?: string | null }): Promise<void>;
  /**
   * Refresh an active or disputed fact in place, keeping its id (the weekly moments scan: a moment found again stays the
   * same row, so its decision and any plan action timed to it stay valid). The claim, source, date, confidence and run
   * change, cleaned by the same formatting rules as an insert; a replaced source URL is kept in also-seen. Null when the
   * fact is not this athlete's, or is superseded or removed.
   */
  refreshFact(athleteId: string, factId: string, patch: FactRefresh): Promise<MemoryFact | null>;
  /** The athlete's facts whose latest review is a confirm (the athlete said "that's right"): never rewritten by a scan. */
  confirmedFactIds(athleteId: string): Promise<Set<string>>;

  writeBrief(athleteId: string, b: { summary: string; sections: StoredBriefSection[]; factIds: string[]; internal: BriefInternal; display?: BriefDisplay | null; runId: string | null }): Promise<StoredBrief>;
  currentBrief(athleteId: string): Promise<StoredBrief | null>;
  /** Internal read of the current brief (Nomila only; never an athlete route). */
  currentBriefInternal(athleteId: string): Promise<BriefInternal | null>;

  insertDecision(athleteId: string, d: NewDecision): Promise<Decision>;
  /** Oldest first. */
  listDecisions(athleteId: string, filter: DecisionFilter): Promise<Decision[]>;
  getDecision(athleteId: string, decisionId: string): Promise<Decision | null>;
  updateDecision(athleteId: string, decisionId: string, patch: DecisionPatch): Promise<Decision | null>;
  respondDecision(athleteId: string, decisionId: string, response: DecisionResponse, reason: string | null): Promise<Decision | null>;

  insertGoal(athleteId: string, g: { text: string; source: GoalSource; decisionId: string | null; priority?: number | null; gamePlan?: string | null; horizon?: GoalHorizon | null; gamePlanBy?: GamePlanAuthor; domain?: GoalDomain | null }): Promise<Goal>;
  /** Goals that are not dropped (active, paused, done) — or every goal with includeDropped — in priority order then oldest first. */
  listGoals(athleteId: string, opts?: { includeDropped?: boolean }): Promise<Goal[]>;
  /** One goal, whatever its status. */
  getGoal(athleteId: string, goalId: string): Promise<Goal | null>;
  updateGoal(athleteId: string, goalId: string, patch: GoalPatch): Promise<Goal | null>;
  /**
   * Remove a goal row. ONLY for Undo of a goal the athlete added or kept moments ago (the change's decision row keeps
   * the history); every other way out of a goal is a status (paused / done / dropped).
   */
  deleteGoal(athleteId: string, goalId: string): Promise<boolean>;
  /** Link a decision to the goal it serves (both the athlete's). */
  linkDecisionToGoal(athleteId: string, decisionId: string, goalId: string): Promise<void>;

  insertReview(athleteId: string, r: { factId: string; action: FactHistoryAction; correction: string | null; replacementFactId: string | null; note: string | null }): Promise<string>;
}

// ─── In memory ────────────────────────────────────────────────────────────────────────────────────────────────────

const ZERO: RunCost = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd: 0 };
const add = (a: RunCost, b: RunCost): RunCost => ({
  inputTokens: a.inputTokens + b.inputTokens, cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  outputTokens: a.outputTokens + b.outputTokens, reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  webSearchCalls: a.webSearchCalls + b.webSearchCalls, microUsd: a.microUsd + b.microUsd,
});

/** A store that lives in this process only. Used by the smoke script (no DB writes) and by pure tests. */
/**
 * Her spend today (UTC) for the day caps that read the store (plan, moments, post kits): every run since midnight plus
 * her voice today, ESTIMATED (the store's voiceSpendTodayMicroUsd; 0 for a store without voice). The same total
 * agent/trace.ts spentTodayMicroUsd gives the harness and Mila's turns.
 */
export async function athleteDaySpendMicroUsd(store: AgentStore, athleteId: string, now: Date): Promise<number> {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const [runs, voice] = await Promise.all([
    store.listRunsSince(athleteId, { since: midnight }),
    store.voiceSpendTodayMicroUsd ? store.voiceSpendTodayMicroUsd(athleteId, now) : Promise.resolve(0),
  ]);
  return runs.reduce((n, r) => n + (r.cost?.microUsd ?? 0), 0) + voice;
}

export function createMemoryStore(): AgentStore & { dump(): Record<string, unknown> } {
  const runs = new Map<string, StoredRun>();
  const facts = new Map<string, MemoryFact>();
  const briefs: Array<StoredBrief & { internal: BriefInternal }> = [];
  const decisions = new Map<string, Decision>();
  const goals: Goal[] = [];
  const reviews: Array<Record<string, unknown>> = [];
  const checkpoints = new Map<string, CheckpointState>();
  const now = () => new Date().toISOString();
  let tick = 0;
  // Strictly increasing timestamps, so "oldest first" is stable within one millisecond.
  const stamp = () => new Date(Date.now() + tick++).toISOString();

  return {
    async startRun(r) {
      const id = randomUUID();
      runs.set(id, { id, athleteId: r.athleteId, skillId: r.skillId, skillVersion: r.skillVersion, trigger: r.trigger, model: r.model, status: "running", stopReason: null, cost: ZERO, steps: [], evidenceRead: [], output: null, parentRef: r.parentRef, error: null, startedAt: stamp(), endedAt: null });
      return id;
    },
    async listRunsSince(athleteId, opts) {
      return [...runs.values()].filter((r) => r.athleteId === athleteId && r.startedAt >= opts.since && (!opts.skillId || r.skillId === opts.skillId))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    },
    async finishRun(athleteId, runId, f) {
      const r = runs.get(runId);
      if (!r || r.athleteId !== athleteId) return;
      Object.assign(r, { status: f.status, stopReason: f.stopReason, cost: f.cost, steps: f.steps, evidenceRead: f.evidenceRead, output: f.output, error: f.error, endedAt: now() });
    },
    async getRun(athleteId, runId) {
      const r = runs.get(runId);
      return r && r.athleteId === athleteId ? r : null;
    },
    async findCompletedRun(athleteId, parentRef) {
      return [...runs.values()].find((r) => r.athleteId === athleteId && r.parentRef === parentRef && r.status === "completed") ?? null;
    },
    async costByParentPrefix(athleteId, prefix) {
      return [...runs.values()].filter((r) => r.athleteId === athleteId && (r.parentRef ?? "").startsWith(prefix)).reduce((a, r) => add(a, r.cost), ZERO);
    },
    async listRunsByPrefix(athleteId, prefix) {
      return [...runs.values()].filter((r) => r.athleteId === athleteId && (r.parentRef ?? "").startsWith(prefix)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    },
    async setRunOutput(athleteId, runId, output) {
      const r = runs.get(runId);
      if (r && r.athleteId === athleteId) r.output = output;
    },
    async getCheckpoints(athleteId, scope) {
      return structuredClone(checkpoints.get(`${athleteId}:${scope}`) ?? emptyCheckpoints());
    },
    async setCheckpoint(athleteId, scope, cp, patch) {
      const key = `${athleteId}:${scope}`;
      const state = checkpoints.get(key) ?? emptyCheckpoints();
      const row = state[cp];
      if (patch.status) row.status = patch.status;
      if (patch.offersInc) row.offers += patch.offersInc;
      if (patch.lastTurn !== undefined) row.lastTurn = patch.lastTurn;
      if (patch.detail) row.detail = patch.detail;
      checkpoints.set(key, state);
    },
    async listFacts(athleteId, statuses) {
      return [...facts.values()].filter((f) => f.athleteId === athleteId && (!statuses || statuses.includes(f.status)));
    },
    async getFacts(athleteId, ids) {
      return ids.map((id) => facts.get(id)).filter((f): f is MemoryFact => !!f && f.athleteId === athleteId);
    },
    async insertFacts(athleteId, list) {
      // The same formatting rules as the database store (agent/factHygiene.ts), for every writer.
      return list.map(cleanNewFact).map((n) => {
        if (!n.source.url && !n.source.ref) throw new Error("source_required: a fact needs a source url or ref");
        const f: MemoryFact = {
          id: randomUUID(), athleteId, subject: n.subject, claim: n.claim, type: n.type, source: n.source, date: n.date,
          confidence: n.confidence, status: n.status ?? "active", supersededBy: null, runId: n.runId, createdAt: stamp(),
          disputes: n.disputes ?? null, alsoSeenAt: n.alsoSeenAt ?? [], sensitive: n.sensitive ?? false,
          careKind: n.sensitive ? n.careKind ?? null : null,
          topic: n.topic ?? null, sourceType: n.sourceType ?? null,
          ...factExtrasOf(n),
        };
        facts.set(f.id, f);
        return f;
      });
    },
    async setFactStatus(athleteId, factId, status, links) {
      const f = facts.get(factId);
      if (!f || f.athleteId !== athleteId) return;
      f.status = status;
      if (links?.disputes !== undefined) f.disputes = links.disputes;
      if (links?.supersededBy !== undefined) f.supersededBy = links.supersededBy;
    },
    async refreshFact(athleteId, factId, patch) {
      const f = facts.get(factId);
      if (!f || f.athleteId !== athleteId || (f.status !== "active" && f.status !== "disputed")) return null;
      const r = refreshedFields(f, patch);
      if (!r.source.url && !r.source.ref) throw new Error("source_required: a fact needs a source url or ref");
      Object.assign(f, {
        ...(patch.subjectName?.trim() ? { subject: { ...f.subject, name: patch.subjectName.trim().slice(0, 300) } } : {}),
        claim: r.claim, source: r.source, alsoSeenAt: r.alsoSeenAt, date: patch.date, confidence: patch.confidence, runId: patch.runId,
        ...(patch.sourceType !== undefined ? { sourceType: patch.sourceType } : {}),
        datePrecision: patch.date && patch.datePrecision ? patch.datePrecision : null,
        ...(patch.sensitive ? { sensitive: true, careKind: f.careKind ?? "personal" } : {}),
      });
      return structuredClone(f);
    },
    async writeBrief(athleteId, b) {
      const mine = briefs.filter((x) => x.athleteId === athleteId);
      for (const x of mine) x.status = "superseded";
      const brief = { id: randomUUID(), athleteId, version: mine.length + 1, status: "current" as const, summary: b.summary, sections: b.sections, factIds: b.factIds, display: b.display ?? null, runId: b.runId, createdAt: now(), internal: b.internal };
      briefs.push(brief);
      const { internal: _i, ...shown } = brief;
      return shown;
    },
    async currentBrief(athleteId) {
      const b = briefs.find((x) => x.athleteId === athleteId && x.status === "current");
      if (!b) return null;
      const { internal: _i, ...shown } = b;
      return shown;
    },
    async currentBriefInternal(athleteId) {
      return briefs.find((x) => x.athleteId === athleteId && x.status === "current")?.internal ?? null;
    },
    async insertDecision(athleteId, d) {
      const answered = d.response && d.response !== "pending";
      const dec: Decision = {
        id: randomUUID(), athleteId, runId: d.runId, skillId: d.skillId, suggested: d.suggested, why: d.why, evidence: d.evidence,
        response: d.response ?? "pending", responseReason: null, respondedAt: answered ? now() : null, outcome: "unknown", outcomeNote: null,
        outcomeAt: null, approvalId: null, createdAt: stamp(), goalId: d.goalId ?? null, kind: d.kind ?? "other", detail: d.detail ?? {},
        parentDecisionId: d.parentDecisionId ?? null,
      };
      decisions.set(dec.id, dec);
      return structuredClone(dec);
    },
    async listDecisions(athleteId, filter) {
      return [...decisions.values()].filter((d) => d.athleteId === athleteId
        && (!filter.runId || d.runId === filter.runId) && (!filter.skillId || d.skillId === filter.skillId)
        && (!filter.kinds || filter.kinds.includes(d.kind ?? "other")) && (!filter.responses || filter.responses.includes(d.response))
        && (!filter.since || d.createdAt >= filter.since) && (!filter.goalId || d.goalId === filter.goalId)
        && (!filter.parentDecisionId || d.parentDecisionId === filter.parentDecisionId))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((d) => structuredClone(d));
    },
    async getDecision(athleteId, decisionId) {
      const d = decisions.get(decisionId);
      return d && d.athleteId === athleteId ? structuredClone(d) : null;
    },
    async updateDecision(athleteId, decisionId, p) {
      const d = decisions.get(decisionId);
      if (!d || d.athleteId !== athleteId) return null;
      if (p.ifUnchanged && (d.response !== p.ifUnchanged.response || !isDeepStrictEqual(JSON.parse(JSON.stringify(d.detail ?? {})), JSON.parse(JSON.stringify(p.ifUnchanged.detail))))) return null;
      if (p.suggested !== undefined) d.suggested = p.suggested;
      if (p.why !== undefined) d.why = p.why;
      if (p.evidence !== undefined) d.evidence = p.evidence;
      if (p.detail !== undefined) d.detail = p.detail;
      if (p.runId !== undefined) d.runId = p.runId;
      if (p.goalId !== undefined) d.goalId = p.goalId;
      if (p.parentDecisionId !== undefined) d.parentDecisionId = p.parentDecisionId;
      if (p.response !== undefined) { d.response = p.response; d.respondedAt = p.response === "pending" ? null : now(); }
      if (p.responseReason !== undefined) d.responseReason = p.responseReason;
      return structuredClone(d);
    },
    async respondDecision(athleteId, decisionId, response, reason) {
      const d = decisions.get(decisionId);
      if (!d || d.athleteId !== athleteId) return null;
      Object.assign(d, { response, responseReason: reason, respondedAt: now() });
      return d;
    },
    async insertGoal(athleteId, g) {
      const t = stamp();
      const goal: Goal = {
        id: randomUUID(), athleteId, text: g.text, source: g.source, status: "active", priority: g.priority ?? null, gamePlan: g.gamePlan ?? null,
        decisionId: g.decisionId, createdAt: t, updatedAt: t, horizon: g.horizon ?? null, gamePlanBy: g.gamePlanBy ?? "mila", domain: g.domain ?? null,
      };
      goals.push(goal);
      return structuredClone(goal);
    },
    async listGoals(athleteId, opts) {
      return goals.filter((g) => g.athleteId === athleteId && (opts?.includeDropped || g.status !== "dropped"))
        .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9) || a.createdAt.localeCompare(b.createdAt)).map((g) => structuredClone(g));
    },
    async getGoal(athleteId, goalId) {
      const g = goals.find((x) => x.id === goalId && x.athleteId === athleteId);
      return g ? structuredClone(g) : null;
    },
    async updateGoal(athleteId, goalId, p) {
      const g = goals.find((x) => x.id === goalId && x.athleteId === athleteId);
      if (!g) return null;
      if (p.text !== undefined) g.text = p.text;
      if (p.status !== undefined) g.status = p.status;
      if (p.horizon !== undefined) g.horizon = p.horizon;
      if (p.gamePlan !== undefined) g.gamePlan = p.gamePlan;
      if (p.gamePlanBy !== undefined) g.gamePlanBy = p.gamePlanBy;
      if (p.priority !== undefined) g.priority = p.priority;
      if (p.domain !== undefined) g.domain = p.domain;
      g.updatedAt = stamp();
      return structuredClone(g);
    },
    async deleteGoal(athleteId, goalId) {
      const i = goals.findIndex((x) => x.id === goalId && x.athleteId === athleteId);
      if (i < 0) return false;
      goals.splice(i, 1);
      for (const d of decisions.values()) if (d.goalId === goalId) d.goalId = null;
      return true;
    },
    async linkDecisionToGoal(athleteId, decisionId, goalId) {
      const d = decisions.get(decisionId);
      if (d && d.athleteId === athleteId && goals.some((g) => g.id === goalId && g.athleteId === athleteId)) d.goalId = goalId;
    },
    async insertReview(athleteId, r) {
      const id = randomUUID();
      reviews.push({ id, athleteId, ...r, createdAt: stamp() });
      return id;
    },
    async confirmedFactIds(athleteId) {
      const latest = new Map<string, string>();
      for (const r of reviews) if (r.athleteId === athleteId) latest.set(String(r.factId), String(r.action));
      return new Set([...latest].filter(([, a]) => a === "confirm").map(([id]) => id));
    },
    dump() {
      return { runs: [...runs.values()], facts: [...facts.values()], briefs, decisions: [...decisions.values()], goals, reviews, checkpoints: Object.fromEntries(checkpoints) };
    },
  };
}
