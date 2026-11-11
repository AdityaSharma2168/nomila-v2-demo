/**
 * provenance.ts — the common provenance contract every Nomila intelligence surface shares.
 *
 * One vocabulary across Marketability, Rates, Opportunity, Earnings and the Commercial Snapshot, so a value's standing
 * is legible wherever it surfaces. See docs/architecture/intelligence-architecture-principles.md P-2..P-7.
 *
 * Types only. No engine behaviour lives here.
 */

/**
 * How a value came to be known. P-2.
 *
 * `DERIVED` is deliberately absent — it is a production METHOD, not an evidence class. A derived value keeps lineage to
 * its inputs, each of which carries its own class. See `DerivedValue`.
 */
export const EVIDENCE_CLASSES = ["MEASURED", "EVALUATED", "ASSUMED", "MISSING"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/** Ordinal confidence, shared with the M.I.A. evaluator's rubric so the two are directly comparable. */
export const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Which engine OWNS a field. Exactly one engine may originate a given field; others read it. */
export const VALUE_OWNERS = [
  "athlete_intelligence",
  "athlete_state",
  "marketability",
  "rates",
  "opportunity",
  "earnings",
  "commercial_plan",
  // Added 23 Sep 2026 (PR3b-1). PR3a wrote `owner: "objectives"` on every proposal's desiredState/currentState
  // through an untyped normaliser, so the owner was never checked against this list. The Objective evaluator is a
  // real owner: it phrases outcomes and reads state, and both are judgments.
  "objectives",
  // Added 2 Oct 2026 (Concept 0.4, Identity Intelligence v0). The synthesis of who the athlete is — identity statement,
  // positioning, themes — from admissible basis items (identityIntelligence/contract.ts). A judgment: EVALUATED only.
  "identity_intelligence",
] as const;
export type ValueOwner = (typeof VALUE_OWNERS)[number];

/**
 * The evidence classes each engine may emit. P-2: a surface does not manufacture uses for every class, and this
 * declaration is enforced by test rather than by review.
 *
 * Marketability has no business emitting ASSUMED: its missing sub-signals take a versioned prior, which the engine
 * records as an imputed signal rather than as a judgment. Opportunity may EVALUATE qualitative judgments (category fit,
 * commercial relevance) but its quantities — expected deal count, conversion probability — stay ASSUMED until outcomes
 * give a basis for estimating them (ADR-017).
 */
export const ENGINE_EMITS: Readonly<Record<ValueOwner, readonly EvidenceClass[]>> = {
  athlete_intelligence: ["MEASURED", "EVALUATED", "MISSING"],
  // Athlete State COMPOSES. It counts what it can count itself and reports what is absent; every judgment it carries
  // keeps the owner that made it, so a dimension score stays `marketability` even when State is the surface reading
  // it. EVALUATED is deliberately absent and enforced by test: the moment State may judge, it becomes a second
  // marketability engine with no rubric, and the boundary this vertical slice depends on is gone.
  athlete_state: ["MEASURED", "MISSING"],
  marketability: ["MEASURED", "EVALUATED", "MISSING"],
  // EVALUATED added 17 Sep 2026, a deliberate correction rather than a widening. The original entry described the
  // v3.1 conception of Rate — a deterministic formula engine over lookup-table constants, whose numbers genuinely
  // WERE assumptions. The approved Beta.1 methodology replaces that with a rubric-constrained evaluator judging an
  // athlete's price against verified market benchmarks, which is EVALUATED by definition.
  //
  // The class follows HOW A QUANTITY WAS PRODUCED, not whether it happens to be numeric. A suggested rate built from
  // approved benchmarks, athlete evidence, connected social data, MIA context and commercial evidence through the
  // frozen rubric is an evidence-grounded judgment. Calling it ASSUMED because it is a number would make the
  // vocabulary describe the output's type rather than its epistemic status, and would leave Rate unable to say the
  // one true thing about itself.
  //
  // ASSUMED remains available to Rate, and narrows to what it should always have meant: an EXPLICIT assumption
  // adopted where evidence is unavailable or where the methodology requires one.
  //
  // This does not disturb the Opportunity principle below. Opportunity's quantities stay ASSUMED because no basis
  // exists to estimate them until outcomes arrive; Rate is an ESTIMATE with commensurable commercial outcomes coming,
  // and is making an evidence-grounded pricing judgment rather than adopting a placeholder.
  rates: ["MEASURED", "EVALUATED", "ASSUMED", "MISSING"],
  opportunity: ["MEASURED", "EVALUATED", "ASSUMED", "MISSING"],
  earnings: ["ASSUMED", "MISSING"],
  commercial_plan: ["EVALUATED", "MISSING"],
  // Objectives phrase outcomes and read state: judgments only. The athlete's own wording of an Objective is not
  // this owner's — it is MEASURED and owned by athlete_intelligence (objectiveEntity.ts).
  objectives: ["EVALUATED"],
  // Identity Intelligence synthesises; every fact it states stays owned by its source (fact, evidence, assertion).
  identity_intelligence: ["EVALUATED"],
};

/** A pointer to another recorded value, so lineage survives persistence. */
export interface ValueRef {
  /** The value's stable id within its record (e.g. "rates.instagram_reel.expected"). */
  path: string;
  /** Present once the producing record is persisted. */
  predictionId?: string;
  owner: ValueOwner;
  evidenceClass: EvidenceClass;
  confidence: ConfidenceLevel;
  /** Whether this input can move the derived output by more than the derivation's threshold. P-3. */
  material: boolean;
}

/** Where an ASSUMED value came from. P-4: no invisible constants. */
export const ASSUMPTION_BASES = ["published_benchmark", "expert_judgment", "nomila_policy", "empirical_model"] as const;
export type AssumptionBasis = (typeof ASSUMPTION_BASES)[number];

export interface Assumption {
  /** Stable key, e.g. "opportunity.social_posts_per_year". */
  key: string;
  basis: AssumptionBasis;
  /** Human-readable source: the publication, the decision, or the model that produced it. */
  source: string;
  /** Versioned like engine parameters — model_params carries the `rates`/`opportunity`/`earnings` families. */
  version: string;
  confidence: ConfidenceLevel;
  /** Quantities state a range, never a bare point value. */
  range?: { low: number; high: number };
  note?: string;
}

/** Common envelope on every material value Nomila produces. */
interface ValueBase<T> {
  value: T;
  owner: ValueOwner;
  confidence: ConfidenceLevel;
  /** When the underlying evidence was observed or the judgment made. */
  asOf: string;
}

export interface MeasuredValue<T> extends ValueBase<T> {
  evidenceClass: "MEASURED";
  /** The authoritative observation(s) behind it. */
  evidenceIds: string[];
  sourceMethod: string;
}

export interface EvaluatedValue<T> extends ValueBase<T> {
  evidenceClass: "EVALUATED";
  evidenceIds: string[];
  /** Why the evaluator judged as it did. Persisted with the judgment; never independently regenerated. P-6. */
  rationale: string;
  /**
   * The observable outcome that would validate or falsify this judgment, where one exists. P-5.
   * `null` means genuinely no clean falsifier — not "we did not think about it".
   */
  falsifiedBy: string | null;
}

export interface AssumedValue<T> extends ValueBase<T> {
  evidenceClass: "ASSUMED";
  assumption: Assumption;
}

export interface MissingValue extends Omit<ValueBase<null>, "confidence"> {
  evidenceClass: "MISSING";
  value: null;
  /** Why it is missing — private-only metric, no evidence found, not applicable. */
  reason: string;
}

/**
 * A value computed from other values. `DERIVED` is a method, not an evidence class (P-2), so the lineage carries the
 * classes and the confidence obeys P-3: never higher than the least-confident MATERIAL input.
 */
export interface DerivedValue<T> extends ValueBase<T> {
  method: "DERIVED";
  /** The derivation itself, versioned so a change to the formula is visible. */
  derivation: { key: string; version: string; materialityThreshold: string };
  inputs: ValueRef[];
}

export type ProvenancedValue<T> =
  | MeasuredValue<T>
  | EvaluatedValue<T>
  | AssumedValue<T>
  | DerivedValue<T>
  | MissingValue;

const CONFIDENCE_RANK: Readonly<Record<ConfidenceLevel, number>> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * P-3: the confidence a derived value may carry — the weakest MATERIAL input's confidence.
 *
 * Immaterial inputs stay in the lineage but do not bind. With no material inputs the derivation cannot claim more than
 * LOW: a value derived entirely from things that cannot move it is not a measurement of anything.
 */
export function maxDerivedConfidence(inputs: readonly ValueRef[]): ConfidenceLevel {
  const material = inputs.filter((i) => i.material);
  if (!material.length) return "LOW";
  const weakest = material.reduce((lo, i) => (CONFIDENCE_RANK[i.confidence] < CONFIDENCE_RANK[lo] ? i.confidence : lo), "HIGH" as ConfidenceLevel);
  return weakest;
}

/** True when a derived value obeys P-3. Propagation may become more sophisticated later; it may never move upward. */
export function derivedConfidenceIsValid(v: Pick<DerivedValue<unknown>, "confidence" | "inputs">): boolean {
  return CONFIDENCE_RANK[v.confidence] <= CONFIDENCE_RANK[maxDerivedConfidence(v.inputs)];
}

/** True when an engine is permitted to emit this evidence class. P-2. */
export function engineMayEmit(owner: ValueOwner, evidenceClass: EvidenceClass): boolean {
  return ENGINE_EMITS[owner].includes(evidenceClass);
}
