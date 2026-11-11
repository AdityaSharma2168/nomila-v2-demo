/**
 * objective.ts — changed future states worth pursuing.
 *
 *   Athlete State + Opportunity Map + explicit athlete intent → OBJECTIVE PROPOSALS → (Objective lifecycle, PR3d)
 *
 * Types only. The frozen evaluator lives in `../objective/evalSpec.ts`; the orchestrator, which calls a provider, lives
 * OUTSIDE this tree in `server/services/objectiveBeta1Orchestrator.ts`.
 *
 * THE BOUNDARY, stated once:
 *
 *   Athlete State   what is currently known and relevant
 *   Opportunity     what deserves strategic attention, and why
 *   Objective       what changed future state we intend or propose to create
 *   Plan / action   how we pursue it
 *
 * An Objective names an OUTCOME. It never names a move. `Objective: Grow X` is a paraphrase of an opportunity, and
 * `Email five CSR directors` is a task; neither passes this contract, and the guards are structural where they can be
 * (§ ObjectiveProposal) and honestly labelled as eval-harness invariants where they cannot (an imperative dressed as
 * an outcome is not lexically separable from a legitimate one).
 *
 * PR3a SHIPS THE PROPOSAL ONLY. `ObjectiveProposal` is what the evaluator emits: frozen, digest-pinned, immutable. It
 * carries no lifecycle, no disposition and no adoption, because those are operational and an athlete's decision
 * must never mutate an evaluator's artifact — the lesson M.I.A. cost a week to learn. The live `Objective` entity
 * with disposition and lifecycle arrives with persistence (PR3d), and is deliberately NOT declared here as a type
 * with no writer: a declared-but-unpopulated contract is exactly what caused the PR2 failure.
 *
 * ADOPTION DOES NOT LIVE HERE, OR ON THE FUTURE ENTITY. The ledger already records it on `MeasuredOutcome` at
 * observation time. A second copy would be a second source of truth.
 */
import type { ConfidenceLevel, EvaluatedValue } from "./provenance";
import type { StatePreference } from "./athleteState";
import type { OpportunityDomain } from "./opportunity";

export const OBJECTIVE_PROPOSAL_VERSION = "objective-proposal/1.0.0";

/**
 * WHO created this, AT CREATION. Immutable — nothing that happens later rewrites it.
 *
 * Derivable from provenance, and a validator checks the label against the derivation rather than trusting it:
 *   athlete  ⟺  no opportunities ∧ ≥1 athlete intent
 *   nomila   ⟺  ≥1 opportunity   ∧ no athlete intent
 *   joint    ⟺  both
 *
 * The evaluator MAY emit an `athlete`-origin proposal: the athlete's recorded intent created it, and the evaluator
 * recognised it as objective-worthy and phrased the outcome. The intent is the athlete's; the sentence is Nomila's
 * (`desiredState` is EVALUATED); origin records who created the objective, which is the athlete. A deterministic
 * intent→objective path that involves no evaluator at all is PR3c.
 */
export const OBJECTIVE_ORIGINS = ["athlete", "nomila", "joint"] as const;
export type ObjectiveOrigin = (typeof OBJECTIVE_ORIGINS)[number];

export interface StateCitation {
  /** A path into the AthleteState this was judged from — the same grammar Opportunity uses. */
  statePath: string;
  how: string;
}

export interface OpportunityCitation {
  /** A key in the OpportunityMap this was judged from. */
  opportunityKey: string;
  how: string;
}

export interface ObjectiveProvenance {
  origin: ObjectiveOrigin;
  /** EMPTY IS VALID — an athlete-originated objective has none. */
  fromOpportunities: OpportunityCitation[];
  /**
   * The athlete's own recorded intent. Each path must resolve to a State preference whose stance is `wants`: a
   * refusal or an avoidance cannot create an objective, only bear on one (see `athleteStance`).
   */
  fromAthleteIntent: StateCitation[];
  /** What is true today that this intends to change. NEVER EMPTY, whatever the origin. */
  currentStateEvidence: StateCitation[];
}

/**
 * NOT a range by default. Inspecting what State can ground — a deal count, a cash ratio, an economics range, a
 * dimension score — almost every honest strategic target is a floor. `exact` is deliberately absent: an exact
 * numeric target on a strategic objective is invented precision by definition.
 */
export type QuantifiedTarget =
  | { kind: "at_least"; value: number }
  | { kind: "at_most"; value: number }
  | { kind: "range"; low: number; high: number };

export interface ObjectiveSuccess {
  /**
   * ALWAYS PRESENT, NEVER NUMERIC BY REQUIREMENT. How a person would know the outcome had been reached.
   * An objective with no observable condition is not an objective; it is a wish.
   */
  observableCondition: string;
  /**
   * OPTIONAL AND EVIDENCE-BOUND. Only where a real metric exists in State with a value to move from.
   *
   * `baseline` is READ FROM STATE AT NORMALISATION, never emitted by the evaluator. The evaluator names the metric
   * and the path; the number comes from the state or the proposal is refused. That is how "never asserted" is
   * enforced structurally rather than requested.
   */
  quantified?: {
    metric: string;
    statePath: string;
    baseline: { value: number; asOf: string };
    direction: "increase" | "decrease" | "maintain";
    target?: QuantifiedTarget;
  };
}

/**
 * SHIPPED SHAPE: a period or nothing.
 *
 * `grounded_deadline` — a real date cited to a State path that carries it — is the documented extension and is
 * deliberately NOT here. State exposes no citable real-world date today (every date on it is an `asOf`), and a
 * variant no valid input can produce is a contract lie. It is added the day State projects a date its validator can
 * check, and not before.
 */
export const HORIZON_PERIODS = ["this_season", "next_12_months", "multi_year"] as const;
export type HorizonPeriod = (typeof HORIZON_PERIODS)[number];
export type ObjectiveHorizon = { kind: "period"; period: HorizonPeriod; why: string } | null;

/**
 * WHAT THE EVALUATOR EMITS. Frozen, digest-pinned, immutable.
 *
 * Structural anti-prescription: there is no `steps`, `tasks`, `actions`, `channel`, `recipient`, `deliverable`,
 * `cadence` or `budget` field, so there is nowhere to put "email five CSR directors" as data. Lexical guards catch the
 * crude case. Anything subtler is an eval-harness invariant, stated as such.
 */
export interface ObjectiveProposal {
  key: string;
  /** The OUTCOME, one sentence. Never a move. Owned by `objectives`, EVALUATED. */
  desiredState: EvaluatedValue<string>;
  /**
   * What is true today that this intends to change. The evaluator's READING of the state — EVALUATED, owned by
   * `objectives`, citing State. Not a fact.
   *
   * `evidenceIds` here carries the canonical evidence locators reachable through the cited State (a finding's
   * cited M.I.A. evidence, a ledger locator), and may be empty. It does NOT carry State paths: `evidenceIds` means
   * "the observations behind it" throughout provenance.ts, and overloading it with a second meaning to fit this
   * contract would break the one vocabulary every engine shares. The path citation is `provenance.currentStateEvidence`.
   *
   * Citation resolution is NOT entailment. A resolvable path can be cited in support of a sentence it does not
   * establish; PR2 proved it. Entailment is checked in the diagnostic, not by a brittle classifier here.
   */
  currentState: EvaluatedValue<string>;
  /**
   * The opportunity domain set, minus one in practice: `evidence` never appears on a proposal. A change in what
   * Nomila knows is information acquisition, not an outcome (objective-eval-spec 1.0.2), and gate 1 refuses it.
   * The type is not narrowed — the shape is unchanged — because the rule is a validator's, not the contract's.
   */
  domain: OpportunityDomain;
  provenance: ObjectiveProvenance;
  success: ObjectiveSuccess;
  horizon: ObjectiveHorizon;
  /** Recorded, never used to drop the proposal. */
  athleteStance?: { stance: StatePreference["stance"]; subject: string };
  confidence: ConfidenceLevel;
}

/** Why an opportunity did not become its own proposal. The declining is the deliverable. */
export interface OpportunityAccounting {
  opportunityKey: string;
  outcome: "consolidated" | "not_carried";
  /** The proposal key it was folded into, where `consolidated`. */
  into?: string;
  why: string;
}

export interface ObjectiveProposalSet {
  athleteId: string;
  asOf: string;
  version: typeof OBJECTIVE_PROPOSAL_VERSION;
  specVersion: string;
  /** The exact inputs this was judged from. Both must match what the citations resolve against. */
  stateAsOf: string;
  opportunityMapAsOf: string;
  proposals: ObjectiveProposal[];
  /** Every opportunity in the map appears here or in some proposal's `fromOpportunities`. Never both. */
  notes: OpportunityAccounting[];
  /** Cannot exceed the weakest material input. */
  overallConfidence: ConfidenceLevel;
}
