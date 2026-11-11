/**
 * athleteState.ts — what is strategically true about an athlete right now.
 *
 *   canonical context + M.I.A. + social substrate + commercial record + athlete assertions
 *     → Athlete State
 *     → Opportunity Map → Objectives → (Rate | Studio | Mila | research | relationships)
 *
 * Types only. The composer lives in `../state/build.ts`.
 *
 * THREE RULES, each enforced by a test rather than by review.
 *
 * 1. STATE COMPOSES, IT DOES NOT JUDGE. Every value keeps the owner that produced it — a dimension score stays
 *    `marketability`, a follower count stays `athlete_intelligence`. `athlete_state` owns only what it counts itself,
 *    and it may never emit EVALUATED. New judgment begins at Opportunity. This is what keeps State from becoming a
 *    second marketability engine with no rubric.
 *
 * 2. STATE CITES, IT DOES NOT COPY. Findings carry `EvidenceRef` pointers into the systems that already hold the
 *    facts. A reader needing the underlying row reads it there. Duplicating the athlete profile here would create a
 *    second source of truth that silently goes stale.
 *
 * 3. STATE IS ATHLETE-AGNOSTIC. No field, threshold or classification may assume a sport, a level, a school, an
 *    audience size, a career stage, commercial history, or that the athlete is a creator at all. MISSING is a valid
 *    and common state and is never filled with a plausible-looking default. An athlete with no social accounts, no
 *    deals and no research must produce a valid AthleteState that says so.
 *
 * ON THE ABSENCE OF PROSE: findings are structured, not written. The persisted M.I.A. row carries no per-dimension
 * rationale (the contract in commercial.ts declares one; the data does not have it, and `drivers` is empty for every
 * athlete in the ledger today), so there is no judgment here to quote. Rather than generate language deterministically
 * and give it the standing of an assessment, State reports the structure and leaves the writing to the Opportunity
 * evaluator, which is the first layer entitled to an opinion.
 */
import type { LedgerEvidenceCitation } from "./intelligenceLedger";
import type {
  ConfidenceLevel,
  EvaluatedValue,
  MeasuredValue,
  MissingValue,
  ProvenancedValue,
  ValueOwner,
} from "./provenance";

/**
 * 1.1.0 — `neutral` added to FindingDirection (C-1), and StateFinding gained the evaluator projection:
 * `rationale`, `confidenceReason`, `citedEvidence`, `components`.
 *
 * The projection fields are additive. `neutral` is not: a consumer branching on `unknown` versus `gap` silently
 * mis-buckets an entire category once it appears, and the first Opportunity run proved that distinction changes
 * downstream reasoning materially. A contract whose meaning moved while its version did not is the drift this
 * codebase versions things to prevent, and leaving it at 1.0.0 would have been that drift in our own contract.
 */
/**
 * 1.2.0 — State projects what Nomila already held and dropped. Verified by the sufficiency audit:
 *   intent          goal_archetype / secondary_goals, LABELLED as a fixed-set onboarding choice, never as an Objective
 *   pipeline        detected / negotiating / rejected / accepted / completed as DISTINCT states — interest is not a deal
 *   inbound         the athlete's own classified inbox signals, compact and capped
 *   audience        composition — top country, top age, gender — one row per platform, not thousands
 *   content         format and cadence performance per platform
 *   representation  floors (a floor is not a market value), agent, agency
 *   dates           only populated real-world dates that can bear on strategy — the input grounded deadlines need
 * Deliberately NOT projected: brand_fit_narratives (written by a Mila pitch feature — evaluator material, not athlete
 * fact) and athlete_facts (67% disputed; shelved).
 */
/**
 * 1.3.0 (Checkpoint 1, slice 1) — ADDITIVE. State projects two kinds of newly available AUTHORITATIVE evidence it was
 * previously blind to, and nothing else changes:
 *   • CONTRACT EXCLUSIVITY she VERIFIED, from a contract deal she uploaded and reviewed (`constraints[contract.<deal>.
 *     exclusivity]`). Extracted-but-unconfirmed exclusivity is NOT projected: an unverified reading is not a bound.
 *   • TYPED ATHLETE ASSERTIONS that name-based filtering used to drop: `never_post` (a constraint), `brands_causes` and
 *     `hobbies` (open preferences), and her free `note`s (`athleteNotes[n]` — what she told us that has no typed home).
 * State remains a projection. Contract interpretation stays in the contract path, request ownership in the request
 * store; State reads their results and cites them.
 */
/**
 * 1.4.0 — ADDITIVE. HER DIRECTION: how she wants to be understood (`athleteDirection`), projected from her own
 * `direction` assertion. It is athlete authority — hers, current, superseded with history in the assertion ledger — and
 * it is NOT a fact, a finding, a preference/want, a goal or an Objective. State does not reconcile it against evidence:
 * M.I.A. and research are free to disagree, and nothing here rewrites them. Absent when she has given none.
 */
/**
 * 1.5.0 — SEMANTIC, though every new field is optional. M.I.A.'s cited sources are split by how strongly the
 * provider's grounding shows they were retrieved (`citationStrength`): `citedEvidence` now holds only DIRECT (grounded)
 * citations — or lineage-unrecorded ones on older rows — with `siteOnlyCitations` (weaker lineage: site retrieved,
 * page unproven), `nomilaSuppliedCitations`, `unsupportedCitations` (asserted / no usable source: NEVER support) and
 * `danglingEvidence` beside it, and `rationale.evidenceIds` excludes non-supporting ids. Existing fields therefore
 * mean something narrower to their readers (the Opportunity state block and objective evidence among them), which is
 * the 1.1.0 precedent: "a contract whose meaning moved while its version did not" is the drift versions exist to
 * prevent, whether or not the added fields are optional.
 */
export const ATHLETE_STATE_VERSION = "athlete-state/1.5.0";

/** Where a fact already lives. State points; it does not carry the fact. */
export interface EvidenceRef {
  source: "mia" | "social" | "deals" | "assertion" | "affiliation" | "context" | "onboarding" | "inbox";
  /**
   * How to find it again, in the shape its own system uses:
   *   mia          a ledger row id, optionally with a signal key — "<uuid>#athletic_authority.role_importance"
   *   social       "<platform>.<feature_key>"
   *   deals        a deal id
   *   assertion    the assertion key
   *   affiliation  an affiliation row id
   *   context      a canonical-context field path
   *   onboarding   "athletes.goal_archetype" / "athletes.secondary_goals[n]" — a fixed-set choice at a point in time
   *   inbox        an inbox_threads row id
   */
  locator: string;
  asOf: string;
}

/**
 * What a finding says about the athlete's position on some dimension of their enterprise.
 *
 * FOUR STATES, because three of them were previously collapsed into `unknown` and a consumer could not tell them
 * apart:
 *
 *   strength  measured, and above the declared band
 *   gap       measured, and below the declared band
 *   neutral   MEASURED, and between the bands — we know, and it is unremarkable
 *   unknown   evidence is genuinely insufficient: no score, or mostly imputed signals (P-8)
 *
 * `neutral` was added after the first Opportunity run, where the overload did both possible kinds of damage in one
 * cohort. One athlete's `audience_scale` — score 50, 0 of 4 signals imputed, fully measured — was labelled `unknown`,
 * and the evaluator BELIEVED it, writing "her audience scale is unmeasured", which is false. Another athlete's
 * `athletic_authority` — score 70.7, 0 of 6 imputed — was also `unknown`, and the evaluator OVERRODE it, calling it
 * "a highly strong athletic credential" by reading the raw score instead.
 *
 * A label a consumer must either disbelieve or ignore is worse than no label. The thresholds are unchanged: the
 * defect was semantic collapse, not where the bands sit.
 */
export type FindingDirection = "strength" | "gap" | "neutral" | "unknown";

/**
 * One structured observation.
 *
 * `unknown` is load-bearing and distinct from `gap`. A dimension scoring low on imputed signals means we have not
 * measured the athlete, not that the athlete is weak — the same distinction P-8 draws for a dormant social account.
 * Collapsing those would let absent evidence read as a deficiency, which is the single most damaging thing a
 * diagnosis can get wrong. `neutral` is equally distinct from `unknown`: it is a measurement, and it says the
 * athlete is ordinary here, which is a fact about them rather than about us.
 */
export interface StateFinding {
  /** Stable across recomputes, so a consumer can tell a persisting finding from a resolved one. */
  key: string;
  direction: FindingDirection;
  /** The measurement, keeping the owner that produced it. NEVER owned by athlete_state as EVALUATED. */
  basis: MeasuredValue<number> | MissingValue;
  /** How much of this finding rests on imputed rather than observed signals, where the source reports it. */
  imputedShare?: { imputed: number; total: number };
  evidence: EvidenceRef[];

  /**
   * PROJECTED FROM THE EVALUATOR, NEVER AUTHORED HERE.
   *
   * `owner` stays `marketability` and `evidenceClass` stays `EVALUATED`, so State carries someone else's judgment
   * without ever emitting one — the no-EVALUATED rule on `athlete_state` is untouched.
   *
   * And this is an EVALUATION, not a fact about the athlete. "Her narrative is exceptionally distinct" is what the
   * marketability evaluator concluded, supported by the sources in `citedEvidence`. A reader that promoted it to
   * canonical fact would launder an interpretation into evidence, which is the failure this whole projection exists
   * to prevent. Absent on ledger rows written before the contract was corrected.
   */
  rationale?: EvaluatedValue<string>;
  confidenceReason?: string;
  /**
   * The sources the EVALUATOR relied on for this finding, at DIRECT strength (1.5.0): grounded — the provider's
   * grounding binds the claim to a retrieved chunk from the cited source — or, on rows written before citation lineage
   * was recorded, lineage unrecorded (no `lineage` on the citation: unknown, not grounded). Not sources State
   * independently certifies. Weaker and non-supporting citations are in the lists below, never here.
   */
  citedEvidence?: LedgerEvidenceCitation[];
  /**
   * WEAKER LINEAGE: a page from the cited site was retrieved, but this page is unproven (Gemini chunk URIs are
   * redirects, so only the domain can be compared). Support, but never to be presented as equal to `citedEvidence`.
   */
  siteOnlyCitations?: LedgerEvidenceCitation[];
  /** Citations restating data Nomila itself supplied (the evidence snapshot's social block), not web sources. */
  nomilaSuppliedCitations?: LedgerEvidenceCitation[];
  /**
   * Sources the evaluator cited that its provider's grounding shows were NOT retrieved (`lineage.level`
   * asserted_only or unsupported). Kept for display and audit, NEVER support — not in any list above and not in
   * `rationale.evidenceIds`.
   */
  unsupportedCitations?: LedgerEvidenceCitation[];
  /** Evidence ids the evaluator cited that do not exist in its evidence list. Never support. */
  danglingEvidence?: string[];
  /** The evaluator's own decomposition, each part classed by how it was actually produced. */
  components?: Array<{ key: string; value: unknown; evidenceClass: string; confidence?: string | null; rationale?: string | null }>;
}

/** An athlete's stated position on an activity. Recorded, never judged, and never silently overridden. */
export interface StatePreference {
  /**
   * What the preference is about. Free text by design: the vocabulary of things an athlete may have an opinion about
   * is not closed, and constraining it to today's rate slots would make State a commercial artefact.
   */
  subject: string;
  stance: "wants" | "open" | "avoids" | "refuses";
  /** A floor or other quantity the athlete attached to the stance, in their own terms. */
  amount?: { value: number; unit: string };
  source: EvidenceRef;
  /** The athlete's own words where we have them. This is the one place prose belongs — it is theirs, not ours. */
  note?: string;
  /**
   * HOW it was recorded, because the semantics differ and a reader must not collapse them.
   *   onboarding_v1_choice   the athlete selected this from a predefined set at a point in time. It is evidence of
   *                          intent — she actually said it — and it is NOT a current strategic objective.
   *   assertion              said in conversation or a form, in their own words.
   */
  recordedAs?: { method: "onboarding_v1_choice" | "assertion"; at: string | null };
}

/** One classified inbound thread. INTEREST, never a deal: no amount, no revenue, no acceptance is implied. */
export interface StateInboundSignal {
  /** As classified by the inbox pipeline: PAID, GIFTING, … Never normalised here. */
  category: string;
  counterparty: string | null;
  /** From the classifier, where the thread stated one. */
  deadline: string | null;
  confidence: number | null;
  lastMessageAt: string;
  threadStatus: string | null;
  evidence: EvidenceRef;
}

/** Compact audience composition for one platform. Top buckets only; the thousands of rows stay in their table. */
export interface StateAudience {
  platform: string;
  followers: MeasuredValue<number> | MissingValue;
  topCountry?: { bucket: string; pct: number };
  topAge?: { bucket: string; pct: number };
  gender?: Array<{ bucket: string; pct: number }>;
  asOf: string;
  evidence: EvidenceRef[];
}

/** Format and cadence performance for one platform, from the social substrate's computed features. */
export interface StateContentPerformance {
  platform: string;
  postsPerWeek?: number;
  daysSinceLastPost?: number;
  formatMix?: unknown;
  reachMedianByFormat?: unknown;
  topDecileShare?: number;
  breakoutRate?: number;
  asOf: string;
  evidence: EvidenceRef[];
}

/**
 * What the athlete has told Nomila about representation and price floors.
 * A FLOOR IS NOT A MARKET VALUE; representation is a stated fact, not an inferred relationship strength.
 */
export interface StateRepresentation {
  agent: string | null;
  agency: string | null;
  floors: Array<{ key: string; amount: number }>;
  evidence: EvidenceRef;
}

/** A populated real-world date that can bear on strategy, with what it actually means. */
export interface StateDate {
  kind: "deal_term_end" | "inbound_deadline" | "affiliation_started";
  date: string;
  subject: string;
  evidence: EvidenceRef;
}

/**
 * Something that genuinely BOUNDS what may be recommended: season timing, eligibility rules, exclusivity terms,
 * availability, geography.
 *
 * An affiliation is NOT one of these. Being at a university, on a professional roster or at a club is context, and
 * it belongs in `identity.competitionContext`. The real constraints such an affiliation may imply — a season window,
 * an eligibility rule, a sponsor exclusivity — are not represented in Nomila today, and an empty list is the
 * truthful report of that. Promoting affiliation to constraint would fabricate bounds Nomila cannot actually state,
 * and PR4 would then decline recommendations for reasons no one recorded.
 */
/** 1.3.0. One thing she said, verbatim, with where it lives. */
export interface StateNote {
  text: string;
  /** Her exact words when they differ from the stored text. */
  said?: string;
  source: EvidenceRef;
}

/** 1.4.0. Her direction — how she wants to be understood — verbatim, with where and when she said it. */
export interface StateDirection {
  statement: string;
  /** Her exact words when they differ from the stored statement. */
  said?: string;
  source: EvidenceRef;
}

export interface StateConstraint {
  key: string;
  /** Free text for the same reason as StatePreference.subject. */
  kind: string;
  basis: ProvenancedValue<unknown>;
  evidence: EvidenceRef[];
}

/**
 * What the market has actually paid this athlete. Facts, not judgment — every field is counted or MISSING.
 *
 * `pricingEvidence` is reported, not acted on. It tells a downstream reader what Rate would have to work with before
 * Rate is called, which is how PR4 can decline to ask a question that cannot be answered.
 */
export interface CommercialPosition {
  closedDeals: MeasuredValue<number>;
  /** Brands with an accepted or completed deal. Names only; the rows stay in `deals`. */
  activeRelationships: MeasuredValue<string[]>;
  /** The range actually transacted, where any deal carries an amount. */
  demonstratedEconomics: MeasuredValue<{ low: number; high: number; currency: "USD" }> | MissingValue;
  /** Cash versus product, because a deal paid in product is not evidence of cash pricing power. */
  cashShare?: MeasuredValue<number>;
  pricingEvidence: "athlete_transactions" | "connected_measurement" | "public_only" | "none";
  /**
   * The pipeline as DISTINCT states. Counts, never money. `detected` is an inbound message the deal detector saw;
   * it establishes that a brand made contact and nothing more. Collapsing these into one number is how 200 inbound
   * emails become "200 deals".
   */
  pipeline: MeasuredValue<{ detected: number; negotiating: number; rejected: number; accepted: number; completed: number }>;
  /** The athlete's own classified inbound signals, most recent first, capped. Demonstrated market interest. */
  inbound: StateInboundSignal[];
}

export interface AthleteState {
  athleteId: string;
  asOf: string;
  version: typeof ATHLETE_STATE_VERSION;

  /**
   * The minimum needed to reason about strategy. Deliberately thin: a consumer wanting the profile reads canonical
   * context. Every field is nullable because every one of them is genuinely absent for some athlete.
   */
  identity: {
    name: string;
    sport: string | null;
    /** Where they compete, in whatever vocabulary their sport uses. Not a division, not a league, not a tier. */
    competitionContext: string | null;
    careerStatus: string | null;
  };

  /** Structured observations across the whole enterprise, not only its commercial parts. */
  findings: StateFinding[];

  /**
   * Direction of travel OF THE AUDIENCE, and nothing wider.
   *
   * Named for what it measures: follower growth on connected platforms. An athlete whose audience is cooling may be
   * ascending athletically, entering a bigger league, or about to sign the largest deal of their career — and a
   * reader that took this for whole-athlete trajectory would diagnose decline from a quiet posting month. Nomila has
   * no whole-athlete trajectory measurement today, and naming this one honestly is what keeps a future reader from
   * assuming it does.
   *
   * MEASURED where growth is observed, MISSING otherwise — never inferred.
   */
  audienceTrajectory: ProvenancedValue<"rising" | "steady" | "cooling"> | MissingValue;

  commercialPosition: CommercialPosition;
  constraints: StateConstraint[];
  preferences: StatePreference[];

  /** Composition per platform. Cite as audience[instagram]. */
  audience: StateAudience[];
  /** Format and cadence per platform. Cite as contentPerformance[instagram]. */
  contentPerformance: StateContentPerformance[];
  /** Null where the athlete has stated nothing about representation or floors. */
  representation: StateRepresentation | null;
  /** Cite as dates[n]. Empty means none are recorded, not that none exist. */
  dates: StateDate[];
  /**
   * 1.3.0. What she told us in her own words that has no typed home (an asserted `note`). Cite as athleteNotes[n].
   * Verbatim and hers — never summarised, never promoted into a preference or constraint by State.
   */
  athleteNotes: StateNote[];
  /**
   * 1.4.0. Her direction — how she wants to be understood. Cite as athleteDirection. Context for reasoning, never a
   * fact, a finding, a want, a goal or an Objective by itself. Absent when she has given none.
   */
  athleteDirection?: StateDirection;

  /** What we do not know that would most change this picture. Sourced, not invented. */
  materialGaps: string[];

  /**
   * Cannot exceed the weakest material input (P-3). A State assembled from a low-confidence assessment and no
   * connected measurement is LOW, however many findings it contains.
   */
  overallConfidence: ConfidenceLevel;

  /** Which systems actually answered, so a reader can tell a thin state from a poor one. */
  sources: Array<{ owner: ValueOwner | "athlete_state"; present: boolean; asOf: string | null }>;
}
