/**
 * opportunity.ts — strategic openings in an athlete's enterprise.
 *
 *   Athlete State → OPPORTUNITY MAP → Objectives → (Rate | Studio | Mila | research | relationships)
 *
 * Types only. The frozen evaluator lives in `../opportunity/evalSpec.ts`.
 *
 * WHAT AN OPPORTUNITY IS: an evidence-backed opening for improving, growing, unlocking, amplifying or maintaining
 * some part of the athlete's enterprise.
 *
 * WHAT IT IS NOT: a product, a price, a plan, a ranking or an instruction. Opportunity identifies openings and stops.
 * Objectives choose among them, and the capability layers — Rate, Studio, Mila, research, relationship work — execute
 * them. Collapsing any of those back into this layer is how Rate became the strategy engine.
 *
 * THIS IS THE FIRST LAYER ENTITLED TO AN OPINION. Athlete State composes and may not emit EVALUATED; Opportunity
 * judges, and everything it judges is EVALUATED with the state it rests on. That boundary is the point of the
 * separation: what is true about the athlete and what Nomila thinks they should do are produced by different things,
 * and can be inspected apart.
 *
 * NOT A COMMERCIAL ENGINE. The domain list deliberately spans philanthropy, media, post-playing career and
 * entrepreneurship, because that is the remit a real representation firm works across. An Opportunity layer that
 * could only see sponsorship would encode a sponsorship-shaped worldview and would never notice that an athlete's
 * best available move is a broadcasting introduction or a foundation.
 *
 * NOT THE SAME THING AS `commercial.ts`'s `OpportunityEstimate`. That type is monetization capacity — categories,
 * volume, conversion, capacity. This one is strategy. Two concepts, two names, deliberately: PR5 reconciles them and
 * until then the ambiguity is resolved by naming rather than by memory.
 */
import type { ConfidenceLevel, EvaluatedValue } from "./provenance";
import type { StatePreference } from "./athleteState";

export const OPPORTUNITY_MAP_VERSION = "opportunity-map/1.2.0";

/**
 * 1.2.0 (P6, 27 Sep 2026) — a taxonomy change on the EVALUATOR'S vocabulary: `evidence` is no longer a strategic domain
 * an opening may carry. A deficiency in Nomila's knowledge, records, observation or verification is not a Strategic
 * Opportunity for the athlete (opportunity-p6-knowledge-boundary-checkpoint.md). The shared enum below stays intact:
 * older maps type as before, the Objective contract keeps its domain type, and Objective 1.0.2's structural refusal of
 * `evidence` keeps firing. Openings in 1.2.0 maps carry a domain from OPPORTUNITY_STRATEGIC_DOMAINS only.
 */

/**
 * 1.1.0 (pass 2, 27 Sep 2026) — additive. An opening may carry `supportedBy` (context / responsive-evidence citations
 * that support, date or strengthen the interpretation; never its ground) and `carriedFrom` (key stabilization against
 * the prior snapshot). The evidence envelope gains a `context` slot. Nothing about 1.0.0 openings is reinterpreted.
 */

/**
 * The five moves.
 *
 * Each has a precondition that the others do not satisfy, because without discriminators an evaluator picks the
 * label that sounds best rather than the one that is true:
 *
 *   FIX       something present is actively costing them now — remove or repair it
 *   GROW      something is weak or absent but buildable — build it from where it is
 *   UNLOCK    something valuable already exists and is not being used AT ALL — start using it
 *   AMPLIFY   something already works — do more of it, or extend its reach
 *   MAINTAIN  something works and is at risk from change or neglect — protect it, change nothing
 *
 * FIX is distinguished by a cost being paid TODAY; GROW starts from weakness where AMPLIFY starts from strength;
 * UNLOCK is binary — the asset is idle, not underperforming; MAINTAIN requires a NAMED risk, or it is filler.
 *
 * The kind is a judgment about what move the situation calls for. It is NOT a lookup from a state finding: one
 * strong narrative may warrant AMPLIFY (tell it more widely), UNLOCK (it has never been told publicly) or MAINTAIN
 * (it is told well and a coming change threatens it). Same strength, three different strategic reads, which is
 * precisely why this layer needs an evaluator instead of a mapping table.
 */
export const OPPORTUNITY_KINDS = ["FIX", "GROW", "UNLOCK", "AMPLIFY", "MAINTAIN"] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

/**
 * Where an opportunity lives.
 *
 * Broad on purpose. `impact` and `career` are separate domains rather than commercial sub-cases because
 * philanthropy, media, broadcasting and post-playing transition are first-class parts of athlete representation,
 * and burying them inside `commercial` would make them invisible to an athlete whose best move is not a deal.
 *
 * `evidence` is a legitimate strategic domain, not bookkeeping. For an athlete Nomila barely knows, "connect this
 * account so we can see your audience" is frequently the highest-value and most honest move available — and it is
 * the alternative to inventing a strategy from a thin picture.
 */
export const OPPORTUNITY_DOMAINS = [
  "audience", "content", "positioning", "athletic", "commercial",
  "relationships", "owned_venture", "impact", "career", "evidence",
] as const;
export type OpportunityDomain = (typeof OPPORTUNITY_DOMAINS)[number];

/** 1.2.0: the domains an opening may carry — the shared enum without `evidence`. */
export const OPPORTUNITY_STRATEGIC_DOMAINS = OPPORTUNITY_DOMAINS.filter((d) => d !== "evidence") as ReadonlyArray<Exclude<OpportunityDomain, "evidence">>;
export type OpportunityStrategicDomain = Exclude<OpportunityDomain, "evidence">;

/**
 * A citation into Athlete State.
 *
 * State-wide by design. An opportunity may rest on a M.I.A.-derived finding, but equally on audience trajectory, a
 * commercial position, a recorded ambition, a constraint, the identity context, or a material gap. Restricting
 * citations to findings would have quietly made Opportunity a M.I.A. reader and left the rest of State unused.
 */
export interface StateCitation {
  /**
   * A path into the AthleteState this map was judged from, e.g.
   *   "findings[mia.narrative_power]" · "audienceTrajectory" · "commercialPosition.demonstratedEconomics"
   *   "preferences[wants_categories]" · "constraints[availability_window]" · "materialGaps[0]"
   */
  statePath: string;
  /** What this specific piece of state contributes to the opportunity. Not a restatement of it. */
  how: string;
}

/** A qualitative judgment with its claim attached. Deliberately ordinal — see the note on fake precision below. */
export interface OpportunityJudgement {
  level: "high" | "medium" | "low";
  /** The substance. A level without this is a score wearing a word. */
  claim: string;
}

/**
 * A citation into CONTEXT (`ctx[<n>]`) or RESPONSIVE EVIDENCE (`research[<n>]`) — the two lenses admitted in 1.1.0.
 * Support, never ground: an opening still rests on State; these say what dated the interpretation or strengthened it.
 */
export interface SupportCitation {
  ref: string;
  how: string;
}

export interface StrategicOpportunity {
  /**
   * Model-minted. Stable within ONE map only (uniqueness is enforced per response). Across adjacent snapshots the
   * normaliser may carry a prior key when continuity is unambiguous (`carriedFrom`) — that is key stabilization for
   * downstream readability, NOT Opportunity identity: the same coarse evidence legitimately supports several
   * interpretations, so neither a key nor a lineage establishes that two openings are the same durable thing.
   */
  key: string;
  kind: OpportunityKind;
  domain: OpportunityDomain;

  /** One sentence naming the opening. The first prose in the chain, and the first that is earned. */
  statement: EvaluatedValue<string>;

  /**
   * What in Athlete State this rests on. Never empty: an opportunity resting on nothing in State is an invention,
   * and this field is what makes that checkable rather than a matter of trust.
   */
  restsOn: StateCitation[];

  /** 1.1.0: context or responsive evidence that supports, dates or strengthens the interpretation. Optional; never the ground. */
  supportedBy?: SupportCitation[];

  /** 1.1.0: set by key stabilization when this opening's key was carried from the prior snapshot. Continuity, not identity. */
  carriedFrom?: { key: string; mapAsOf: string; lineage: number };

  /** What specifically would improve if this were pursued. */
  impact: OpportunityJudgement;
  /** What the athlete would actually have to do, and whether they plausibly can. */
  feasibility: OpportunityJudgement;
  /**
   * Only where something genuinely makes this time-dependent — a season, an event, a contract window, a moment.
   * `null` is the common and correct answer: most openings are not urgent, and a required urgency rating would
   * manufacture pressure that does not exist.
   */
  urgency: OpportunityJudgement | null;

  /**
   * Set when the athlete has said something bearing on this opportunity.
   *
   * The opportunity is still EMITTED. Flagging rather than filtering is what lets a surface say "this could be
   * valuable, but you've told me you don't want to coach" — a sentence that becomes impossible if the opportunity
   * was silently dropped, and that is the difference between advising someone and deciding for them.
   *
   * Distinct from an ambition that GENERATES an opportunity: that appears in `restsOn` as a citation into
   * preferences. A refusal constrains; an ambition creates. Both are the athlete's own truth and they are not the
   * same input.
   */
  athleteStance?: { stance: StatePreference["stance"]; subject: string; note?: string };

  confidence: ConfidenceLevel;
}

/**
 * Evidence supplied to the evaluator at call time.
 *
 * `stateBlock` is the only populated field in 1.0.0. The other two are declared now and left null so that adding
 * them later is additive rather than a reshape:
 *
 *   strategyIntelligence  versioned shared knowledge about how athletes build value — practitioner playbooks,
 *                         athlete-brand and career-development frameworks, and current trends across sponsorship,
 *                         NIL, creator businesses, direct-to-fan and athlete-owned ventures. Refreshed periodically
 *                         for everyone, never researched per athlete.
 *   targetedResearch      fresh external investigation where a specific athlete or opening warrants it.
 *
 * ONE RULE GOVERNS BOTH, and it is why they are named here rather than left to a future author: external
 * intelligence may inform judgment, and may NEVER overwrite or contradict an athlete-specific fact in State. State
 * is authoritative about the athlete; the world is authoritative about the world.
 */
export interface OpportunityEvidence {
  stateBlock: string;
  /**
   * 1.1.0: the continuous CONTEXT block (context-block/0.1.0, rendered; cited `ctx[<n>]`) — dated observations about
   * the athlete's world and the world around her. Per athlete, per window. Distinct from `strategyIntelligence`
   * (shared, never per athlete), which stays reserved.
   */
  context?: { version: string; block: string } | null;
  strategyIntelligence?: { version: string; block: string } | null;
  /** 1.1.0: RESPONSIVE EVIDENCE — projections of evidenced Intelligence Requests (targeted-research/0.1.0; cited `research[<n>]`). */
  targetedResearch?: { version: string; block: string } | null;
}

export interface OpportunityMap {
  athleteId: string;
  asOf: string;
  version: typeof OPPORTUNITY_MAP_VERSION;
  /** The frozen evaluator that produced this, e.g. "opportunity-eval-spec/1.0.0". */
  specVersion: string;
  /** The AthleteState this was judged from, so a map is always traceable to the picture behind it. */
  stateAsOf: string;

  opportunities: StrategicOpportunity[];

  /**
   * Why a domain yielded nothing, where that is itself informative — "no commercial opening is identifiable until
   * there is any audience measurement" tells a reader more than an absent entry.
   */
  notes: string[];

  /** Which intelligence sources were actually used. A v2 map with more inputs stays comparable to a v1 map. */
  inputs: Array<{ kind: "athlete_state" | "context" | "strategy_intelligence" | "targeted_research"; version: string | null; present: boolean }>;

  /** Cannot exceed the weakest material input — a map judged from a LOW-confidence state is LOW. */
  overallConfidence: ConfidenceLevel;
}
