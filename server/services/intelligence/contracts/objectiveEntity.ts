/**
 * objectiveEntity.ts — the LIVE Objective and its event log. PR3b-1.
 *
 * The governance boundary. An `ObjectiveProposal` (contracts/objective.ts) is what the evaluator emits: frozen,
 * digest-pinned, immutable, with no lifecycle and no disposition. An `Objective` is what the athlete governs. The
 * only way a proposal becomes one is through the transition in objective/entity.ts, and the only way an Objective
 * changes afterwards is through an `ObjectiveEvent`. The row is a projection of its events for every mutable field.
 *
 * THREE AXES, NEVER COLLAPSED (objectives-contract.md §2):
 *   origin        who created it, AT CREATION, derived from provenance by code. Immutable.
 *   disposition   what the athlete said. Moves only by her events.
 *   lifecycle     where it is. Moves as a consequence of disposition, supersession, abandonment, achievement.
 *
 * ADOPTION IS NOT HERE. It lives on MeasuredOutcome against a RECOMMENDATION ledger entry, which an Objective never
 * has (objectives-pr3b-design.md §1). No field on this type can say "recommended and followed".
 */
import type { OpportunityDomain } from "./opportunity";
import type { ConfidenceLevel, EvaluatedValue, MeasuredValue } from "./provenance";
import type {
  ObjectiveHorizon, ObjectiveOrigin, ObjectiveProposal, ObjectiveProvenance, ObjectiveSuccess,
} from "./objective";

/**
 * 1.1.0 (L1): additive — `lineage`. Rows written as 1.0.0 remain valid and are backfilled once; the validator
 * accepts both.
 */
export const OBJECTIVE_VERSION = "objective/1.1.0";

/**
 * A DEFERRAL CARRIES ITS KIND (L2). "Not now" means one of three things, and the rule that decides whether a later
 * run may bring the Objective back reads the kind, never the free text:
 *   information  "I don't know enough to decide" — NEVER re-surfaced automatically. Evidence change at its lineage
 *                paths is recorded as a signal and triggers nothing; only her return, or a later mechanism that can
 *                say her question was answered (`information_available`, no writer yet), brings it back.
 *   time         "later" — re-surfaced once `after` has passed.
 *   athlete      "I'll come back to it" — only by her `revisit`.
 * Rows deferred before L2 carry no deferral and are read as `information`, the conservative kind.
 */
export const DEFERRAL_KINDS = ["information", "time", "athlete"] as const;
export type DeferralKind = (typeof DEFERRAL_KINDS)[number];
export interface Deferral {
  kind: DeferralKind;
  /** `time` only: reconsider at or after this instant, computed at defer time from the period she chose. */
  after?: string;
  /** Her words, verbatim (the event's `said`), repeated here so the row is self-describing. */
  said: string | null;
}
/** Why a deferred Objective returned to the queue. `evidence_changed` is deliberately NOT a reason. */
export const RESURFACE_REASONS = ["time_elapsed", "athlete", "information_available"] as const;
export type ResurfaceReason = (typeof RESURFACE_REASONS)[number];
/** Versioned mapping from the period she chose to a duration. objective-deferral/1.0.0. */
export const DEFER_PERIOD_DAYS = { version: "objective-deferral/1.0.0", this_season: 90, next_12_months: 365 } as const;
export type DeferPeriod = "this_season" | "next_12_months";
export const ACCEPTED_OBJECTIVE_VERSIONS: readonly string[] = ["objective/1.0.0", OBJECTIVE_VERSION];

/**
 * STRATEGIC LINEAGE — what the Objective rests on, computed once at creation from the proposal and the map it was
 * judged from. Immutable. Evidence lineage identifies candidate strategic continuity or relationship; the
 * athlete-governed Objective entity remains the identity (objectives-lineage-design.md §1.2).
 */
export interface ObjectiveLineage {
  domain: OpportunityDomain;
  /** The cited opportunities, and the map they belong to — comparable only within that map. */
  opportunityKeys: string[];
  mapAsOf: string;
  /** Every State path the Objective rests on, directly and through its opportunities. Indices normalised, sorted. */
  evidencePaths: string[];
  /** Recorded; not an identity signal — one broad intent backs many outcomes. */
  intentPaths: string[];
}

export const OBJECTIVE_DISPOSITIONS = ["unreviewed", "accepted", "declined", "deferred", "modified"] as const;
export type ObjectiveDisposition = (typeof OBJECTIVE_DISPOSITIONS)[number];

export const OBJECTIVE_LIFECYCLES = ["proposed", "active", "achieved", "abandoned", "superseded"] as const;
export type ObjectiveLifecycle = (typeof OBJECTIVE_LIFECYCLES)[number];

/** Lifecycles nothing ever leaves. */
export const TERMINAL_LIFECYCLES: readonly ObjectiveLifecycle[] = ["achieved", "abandoned", "superseded"];

/**
 * The frozen artifact an Objective came from. Absent for athlete-created objectives. `setId` is the persisted
 * `objective_proposal_sets` row; `setAsOf` and `specVersion` are copied so a row is readable without a join.
 */
export interface FromProposal {
  key: string;
  setId: string;
  setAsOf: string;
  specVersion: string;
}

export interface Objective {
  id: string;
  athleteId: string;
  version: typeof OBJECTIVE_VERSION;

  /**
   * EVALUATED and owned by `objectives` when Nomila phrased it. MEASURED and owned by `athlete_intelligence` when
   * the athlete stated or restated it — Nomila must never become the author of the athlete's goal.
   */
  desiredState: EvaluatedValue<string> | MeasuredValue<string>;
  /** The evaluator's reading of the state at creation, or null when the athlete created it and stated none. */
  currentState: EvaluatedValue<string> | null;
  domain: OpportunityDomain;

  /** IMMUTABLE after creation. `origin` inside it is derived, never asserted. */
  provenance: ObjectiveProvenance & { supersedes?: string };
  /** Immutable. `quantified.statePath` and `baseline` in particular: they say what the Objective IS. */
  success: ObjectiveSuccess;
  /** Mutable by the athlete through `modify`. */
  horizon: ObjectiveHorizon;
  /** Recorded at creation from the proposal; never used to decide anything here. */
  athleteStance?: ObjectiveProposal["athleteStance"];
  confidence: ConfidenceLevel;

  disposition: ObjectiveDisposition;
  lifecycle: ObjectiveLifecycle;

  /** Immutable, from creation. Absent only on rows created before L1 (backfilled) and athlete-created Objectives
   *  (`evidencePaths: []` — they never match by lineage). */
  lineage?: ObjectiveLineage;
  /** Present while `disposition: deferred` (L2). Absent on rows deferred before L2: read as `information`. */
  deferral?: Deferral;
  /** Set when the athlete reshaped the wording. The previous wording survives verbatim; origin does NOT change. */
  modifiedFrom?: { desiredState: string; at: string };
  fromProposal?: FromProposal;
  /** Where this was replaced by a new Objective rather than modified in place. */
  supersededBy?: string;

  createdAt: string;
  reviewedAt?: string;
  activatedAt?: string;
  closedAt?: string;
}

/**
 * What can happen to an Objective. The decision verbs are the API's (objectives-pr3b-design.md §2, §5); the three
 * run-driven events are reconciliation's (§7) and are written by the system, never by a person.
 */
export const OBJECTIVE_ACTIONS = [
  "presented",   // system: the proposal was materialised into the review queue
  "created",     // athlete: an objective with no proposal behind it
  "accept",
  "modify",
  "decline",
  "defer",
  "abandon",
  "achieve",
  "supersede",
  "revisit",     // athlete: brings her own deferred Objective back to the queue (L2)
  // ── reconciliation (PR3b-2, migration 0064) ──
  "reaffirmed_by_run",          // a later run proposed the same outcome again while it is live or still queued; no row
  "re_proposed_while_declined", // a later run proposed it again inside the decline window; recorded, not shown
  "re_surfaced",                // she deferred it and a later run proposed it again; it returns to the queue
  // ── reconciliation 2.0 findings (L1, migration 0069). Relationships on the record; never rows, never edits ──
  "spans_live",                 // one proposal's lineage matched this AND other live Objectives: the evaluator consolidated
  "splits_live",                // two proposals in one set matched this live Objective: the evaluator decomposed
  "may_relate",                 // only a weak wording match: recorded, and the proposal is otherwise new
  // ── Slice 3 B (migration 0079). System; appended after her wording edit; never changes the Objective ──
  "change_assessed",            // the saved change assessment of her current wording (or `unassessed`) — objective/currentBasis.ts
  // ── Slice 3 A (migration 0079). Athlete; never changes the Objective ──
  "success_confirmed",          // she kept the success line, reviewed against her current wording — objective/successReview.ts
] as const;
export type ObjectiveAction = (typeof OBJECTIVE_ACTIONS)[number];

export const ACTOR_ROLES = ["athlete", "admin", "system"] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

/**
 * The actor. ADR-015: the USER who acted and the role their membership gives them on this athlete — recorded, never
 * assumed. `system` is the materialisation path and carries no user.
 */
export type ObjectiveActor =
  | { userId: string; role: "athlete" | "admin" }
  | { userId: null; role: "system" };

/** What changed. Only the fields an action may touch appear on its delta; the validator refuses the rest. */
export interface ObjectiveDelta {
  desiredState?: { from: string; to: string };
  horizon?: { from: ObjectiveHorizon; to: ObjectiveHorizon };
  /** `supersede`: the successor. `decline` that led to an athlete-created replacement: the replacement. */
  supersededBy?: string;
  ledTo?: string;
  /** `presented`: the set this came from. */
  setId?: string;
  /** `created`: whether she is pursuing it now or stated it for later. The fold needs it. */
  start?: "now" | "later";
  /** Run events and `presented` with history: the proposal that caused this, and how close it was. */
  proposalKey?: string;
  similarity?: number;
  /** `presented` for a proposal with history: the earlier Objective it echoes. */
  relatedObjectiveId?: string;
  /** Run events: the new proposal's rationale, so her queue shows why Nomila still sees it. */
  rationale?: string;
  /** `defer`: the structured kind she chose. `re_surfaced`: why it came back. `reaffirmed_by_run` on an
   *  information deferral: whether the evidence at its lineage paths changed — a SIGNAL, never a trigger. */
  deferral?: Deferral;
  because?: ResurfaceReason;
  evidenceChanged?: boolean;
  /** `re_surfaced` with `because: information_available` (additive, 27 Sep, experimental): the lineage — the Intelligence
   *  Request whose responsive evidence answered her condition, the gated run that observed it, and the evidence by
   *  reference. Auditable back to the request; never a copy of the evidence. */
  requestId?: string;
  observedInRun?: string;
  evidenceRefs?: Array<{ store: string; id: string; at: string }>;
  /** Reconciliation 2.0: how the relationship was found and how strong; the other Objectives it touched. */
  tier?: "A" | "B" | "C";
  evidenceJaccard?: number;
  siblingObjectiveIds?: string[];
  proposalKeys?: string[];
  /** `modify` (Slice 3 A): her success line, before and after. `observableCondition` only; `quantified` never changes. */
  success?: { from: string; to: string };
  /** `success_confirmed` (Slice 3 A): the line she kept, and the wording she reviewed it against. */
  successConfirmed?: { condition: string; forWording: string };
  /** `change_assessed` (Slice 3 B): the saved assessment of her edit. Typed and read by `objective/currentBasis.ts`
   *  (`ChangeAssessmentRecord`); opaque here so the contract takes no dependency on the assessment module. */
  changeAssessment?: Record<string, unknown>;
}

/** Append-only. Never updated, never deleted. The mutable fields of an Objective are a fold over these. */
export interface ObjectiveEvent {
  id: string;
  objectiveId: string;
  athleteId: string;
  at: string;
  actor: ObjectiveActor;
  action: ObjectiveAction;
  /** The athlete's words, verbatim, where she gave them. The one place prose belongs. */
  said: string | null;
  delta: ObjectiveDelta | null;
}

/**
 * A decision as it arrives from the athlete (or her authorised actor). Everything else about the resulting event —
 * the id, the timestamp, the delta's `from` side — is computed against the current Objective, never trusted.
 */
export type RunAction = "reaffirmed_by_run" | "re_proposed_while_declined" | "re_surfaced" | "spans_live" | "splits_live" | "may_relate";
export const RUN_ACTIONS: readonly RunAction[] = ["reaffirmed_by_run", "re_proposed_while_declined", "re_surfaced", "spans_live", "splits_live", "may_relate"];

export interface ObjectiveDecision {
  action: Exclude<ObjectiveAction, "presented" | "created" | RunAction | "change_assessed">;
  actor: Exclude<ObjectiveActor, { role: "system" }>;
  said?: string | null;
  /** `defer` only: the kind she chose, and for `time` the period. Unspecified → `information`. */
  deferral?: { kind: DeferralKind; period?: DeferPeriod };
  /** `modify` only. */
  desiredState?: string;
  /** `modify` only. */
  horizon?: ObjectiveHorizon;
  /** `modify` only (Slice 3 A): her success line (`observableCondition`). */
  success?: string;
  /** `supersede` only: the successor's id, which must already exist for this athlete. */
  supersededBy?: string;
}
