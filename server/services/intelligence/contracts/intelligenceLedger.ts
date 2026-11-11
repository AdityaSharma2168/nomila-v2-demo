/**
 * intelligenceLedger.ts — one record of every judgment Nomila makes, and what later happened. P-7.
 *
 * SHARED INFRASTRUCTURE, INDEPENDENT ENGINES. Marketability, Rates, Opportunity, Earnings and Deal Intelligence each
 * own their own methodology and learn from their own outcomes. What they share is provenance, versioning and outcome
 * recording — not intelligence. Keeping the records separate is what makes a miss attributable: "the rate was right,
 * the opportunity volume was too high, so the earnings forecast was too high" is only sayable when three engines wrote
 * three entries. One model emitting one number can never tell you which part was wrong.
 *
 * NOT ALL JUDGMENTS ARE PREDICTIONS. The operative test is whether a COMMENSURABLE OUTCOME ever arrives — the same
 * quantity, observed later:
 *
 *   ASSESSMENT      MIA = 616                   No. Nothing ever arrives saying "her true marketability was 623".
 *   ESTIMATE        Reel rate $1,000-$2,500     Yes — the deal closes at a price, in the same units.
 *   FORECAST        12-month earnings $75K      Yes, at a horizon.
 *   RECOMMENDATION  counter at $4,500           Yes, plus whether the athlete actually followed it.
 *
 * This distinction is enforced by the type system, not by convention: an ASSESSMENT cannot be paired with an outcome
 * to produce an error, because `calibrationError` does not accept one. That matters more than it looks. If MIA error
 * were computable, the obvious next step is minimising it against commercial results — which is precisely the
 * circularity ADR-011 forbids, and how Marketability would quietly become a disguised predictor of deal value.
 * Marketability describes a construct; commercial outcomes may test whether it is useful, never redefine it.
 *
 * MIA's validation is therefore: golden reproduction, run-to-run stability, cohort behaviour, and later correlational
 * research — recorded here as `CorrelationalObservation`, which deliberately carries no error.
 *
 * Types only; no table and no writer in this file.
 *
 * Structural precedents to imitate rather than reinvent: `pending_actions` (a proposal and its disposition in one row),
 * `research_evidence`/`athlete_facts` (immutable rows, `superseded_by` self-FK, `run_id` batching),
 * `social_metric_observations` (one row per subject/kind/version/as-of), `model_params` (draft → active promotion).
 */
import type { Assumption, ConfidenceLevel, EvidenceClass, ValueOwner, ValueRef } from "./provenance";

/**
 * A GENERIC EVALUATED FINDING, and the evidence and reasoning behind it.
 *
 * Deliberately free of anything marketability-shaped. No dimensions, no `narrative_power`, no `imputed`, no
 * `signals`: a finding is a thing an evaluator concluded, its reasons, and what it relied on. Any engine writes the
 * same shape, and a reader projects it without knowing which engine produced it.
 *
 * WHY THIS EXISTS. `commercial.ts` already declared that a marketability dimension carries its rationale —
 * "Persisted with the judgment; never regenerated alone. P-6" — and the writer persisted the scoring layer's shape
 * instead. Nothing caught it, because that contract has no importers. The rationale the evaluator actually wrote was
 * stranded in its run artifact, a downstream layer could see a score with no meaning attached, and it reconstructed
 * the meaning by guessing. These types exist so the judgment and the reasons for it travel together.
 *
 * WHAT DOES NOT BELONG HERE. Execution lineage — the evidence snapshot, every retrieved chunk, the provider envelope
 * — stays with the engine and is reachable by `evaluationRunId`. The ledger carries the evidence a finding CITED,
 * which is part of the judgment. That line is the ledger contract's own, and erasing it is how everything ends up
 * in this row.
 */
export interface LedgerEvidenceCitation {
  /** Evaluator-local, e.g. "E1". Unique within this entry; NOT a global identifier. */
  id: string;
  claim: string;
  sourceUrl?: string | null;
  /** The evaluator's own characterisation — official, major_media, secondary… Never normalised here. */
  sourceType?: string | null;
  sourceTitle?: string | null;
  observedAt?: string | null;
  /**
   * Whether the source was actually retrieved, as the provider's own grounding metadata shows it — never the
   * evaluator's say-so. Computed at write time from the run's stored grounding; ABSENT on entries written before it
   * existed (unknown, not "retrieved"). See `LedgerCitationLineage`.
   */
  lineage?: LedgerCitationLineage;
}

/**
 * The research path's provenance vocabulary (research/spec/directLineage.ts), plus one level it never needed:
 *   native_supported — the provider's grounding binds the claim to a retrieved chunk from the cited source's domain;
 *   native_retrieved — the cited source's domain is among the retrieved chunks, but nothing binds this claim to it.
 *                      `match` says how precisely: `domain` when only the host could be compared (Gemini chunk URIs
 *                      are redirects, so the exact page can never be confirmed from stored data);
 *   asserted_only    — the evaluator wrote a URL no retrieved chunk corroborates, even by domain. Not support;
 *   unsupported      — no usable source at all (no URL, and not something Nomila supplied). Not support;
 *   nomila_supplied  — the citation restates what Nomila itself put in the evidence snapshot (the authoritative
 *                      social block). Identified from the snapshot, never from the evaluator's own label.
 */
export type CitationLineageLevel = "native_supported" | "native_retrieved" | "asserted_only" | "unsupported" | "nomila_supplied";
export interface LedgerCitationLineage {
  level: CitationLineageLevel;
  match: "index_support" | "domain" | "snapshot" | "none";
  /** The retrieved chunk domains it matched, where it matched any. */
  retrievedDomains?: string[];
  detail?: string | null;
}

/**
 * How strongly a citation supports what cited it — the ONE reading every consumer uses, so none can treat a domain
 * match as a directly retrieved source:
 *   grounded        the provider's grounding binds the claim to a retrieved chunk from the cited source (direct);
 *   site_only       WEAKER LINEAGE: a page from the cited site was retrieved, but this page is unproven;
 *   nomila_supplied Nomila's own supplied data (the snapshot's social block), restated;
 *   not_support     asserted_only or unsupported — never presented as supporting evidence, anywhere;
 *   unrecorded      no lineage recorded (an entry written before it existed) — unknown, never upgraded or downgraded.
 */
export type CitationStrength = "grounded" | "site_only" | "nomila_supplied" | "not_support" | "unrecorded";
export function citationStrength(c: Pick<LedgerEvidenceCitation, "lineage"> | null | undefined): CitationStrength {
  switch (c?.lineage?.level) {
    case "native_supported": return "grounded";
    case "native_retrieved": return "site_only";
    case "nomila_supplied": return "nomila_supplied";
    case "asserted_only":
    case "unsupported": return "not_support";
    default: return "unrecorded";
  }
}

/**
 * A decomposed part of a finding.
 *
 * `evidenceClass` is the shared provenance vocabulary, NOT a restatement of an engine's internal flags, and the
 * mapping matters: a component whose value the evaluator JUDGED from researched sources is EVALUATED, not MEASURED.
 * Calling it MEASURED because it is a number and was not imputed would mislabel every signal Marketability currently
 * produces — all 1,455 non-imputed ones are `web_researched` judgments, and none is an observation.
 */
export interface LedgerComponent {
  key: string;
  label?: string;
  value: unknown;
  evidenceClass: EvidenceClass;
  confidence?: ConfidenceLevel | null;
  /** Why this component reads as it does, where the evaluator says so. */
  rationale?: string | null;
  /** ids into the entry's `evidence`, so a source is stated once. */
  citedEvidence?: string[];
  /** ids the evaluator cited that do not exist in the entry's `evidence`. Recorded, never counted as support. */
  danglingEvidence?: string[];
  /** Only where the engine genuinely composes numerically. Most do not. */
  weight?: number;
}

export interface LedgerFinding {
  key: string;
  label?: string;
  /** The domain payload: a score, a band, a range, a category. */
  value: unknown;
  confidence: ConfidenceLevel | null;
  /** WHY. Evaluator-generated and EVALUATED — never canonical fact about the subject. */
  rationale?: string | null;
  confidenceReason?: string | null;
  citedEvidence?: string[];
  /** ids cited by this finding or its components that do not exist in the entry's `evidence`. Never support. */
  danglingEvidence?: string[];
  components?: LedgerComponent[];
}

/**
 * Assessment-level remarks, kept APART because they mean different things.
 *
 * A reader given two arrays of strings cannot tell "we lack this information" from "this assessment may be wrong
 * because of that", and those imply opposite responses: one is a research task, the other is a caveat on everything
 * above it. Marketability produces both and calls them `importantMissingData` and `identityOrEvidenceRisks`.
 *
 * There is deliberately no per-finding gap list. Marketability produces none — its `dimensionAssessments` entries
 * carry prose, confidence and a confidence reason, and nothing else — and declaring a field no evaluator populates
 * is the exact mistake that caused this whole correction.
 */
export interface AssessmentNotes {
  /** Evidence the evaluator looked for and could not find. */
  missingEvidence?: string[];
  /** Why this assessment might be unreliable. Not the same as missing evidence. */
  evaluationRisks?: string[];
  strengths?: string[];
  constraints?: string[];
}

/** The `value` of an ASSESSMENT entry, whichever engine wrote it. */
export interface AssessmentValue {
  headline?: { key: string; value: unknown; confidence: ConfidenceLevel | null };
  findings: LedgerFinding[];
  evidence: LedgerEvidenceCitation[];
  notes?: AssessmentNotes;
}

export const JUDGEMENT_KINDS = ["ASSESSMENT", "ESTIMATE", "FORECAST", "RECOMMENDATION"] as const;
export { LEDGER_SUBJECT_KINDS, isLedgerSubjectKind } from "./subjects";
import type { LedgerSubjectKind } from "./subjects";
export type JudgementKind = (typeof JUDGEMENT_KINDS)[number];

/**
 * WHAT A JUDGMENT OR AN OUTCOME IS ABOUT. The one vocabulary (contracts/subjects.ts): the canonical subject kinds plus
 * the three execution-side ones. Widened from athlete | deal | thread | opportunity because the outcome-attribution
 * forcing cases produced four subjects it could not express — a creative intent, a campaign deliverable, a campaign
 * (`outcome-attribution-forcing.md` §4). No semantic change to any entry or outcome beyond making real subjects nameable.
 */
export type LedgerSubjectType = LedgerSubjectKind;

interface LedgerEntryBase {
  entryId: string;
  subjectType: LedgerSubjectType;
  subjectId: string;
  owner: ValueOwner;

  /** The judgment itself, in the shape its own contract defines. */
  value: unknown;
  /**
   * The coarse band a reader acts on — or null where the engine has no VERSIONED policy mapping its aggregate
   * confidence onto one. Null is the honest answer in that case: inventing thresholds to fill the field is how a
   * presentation choice becomes methodology without anyone deciding it. The engine's own numeric confidence lives in
   * `value` and is always versioned.
   */
  confidence: ConfidenceLevel | null;

  /**
   * Every parameter set in force, so the judgment can be re-derived or re-explained later. The named keys are the
   * common ones; each engine adds its own families (Marketability records lookups/policy/priors/cohorts).
   */
  versions: { methodology?: string; evaluator?: string; params?: string; derivation?: string } & Record<string, string>;

  /**
   * UPSTREAM INTELLIGENCE this judgment consumed — not raw evidence lineage.
   *
   * The distinction is the whole value of the field. `inputs` is how a derived judgment records which other Nomila
   * judgments it was built on, so staleness is DETERMINABLE rather than inferred: a Rate that recorded MIA entry M42
   * is stale the moment M42.supersededBy is set, with no date comparison. That matters because dates cannot answer
   * it — two assessments may legitimately share an evidenceAsOf (a manual refresh returns a fresh answer on
   * identical supplied evidence), which is exactly the case a date check gets wrong.
   *
   * Evidence lineage does NOT belong here. It is engine-specific and recoverable through the engine's own records —
   * Marketability's runs as ledger -> evaluationRunId -> run -> snapshotId -> digest. Conflating the two would make
   * this field mean two things, and the first engine to copy the wrong one inherits a broken dependency graph.
   *
   * An EMPTY array is therefore an assertion, not an omission: this judgment consumed no other Nomila intelligence.
   * For Marketability that is ADR-011 made machine-checkable.
   */
  inputs: ValueRef[];
  assumptions: Assumption[];

  /**
   * The as-of of the EVIDENCE this judgment was made from — not when the job finished.
   *
   * This is the supersession ordering key, and using completion time instead is a real bug: a research refresh that
   * started at 10:00 can finish after a social sync that started at 10:10, and the older-evidence result would
   * overwrite the newer one. Supersession compares evidenceAsOf.
   */
  evidenceAsOf: string;
  createdAt: string;
  /** Set when a later entry built on NEWER evidence supersedes this one. Entries are never updated in place. */
  supersededBy?: string | null;
}

/** A judgment about a construct, with no commensurable future observation. MIA is the case. */
export interface AssessmentEntry extends LedgerEntryBase { kind: "ASSESSMENT" }

/** A quantity a later observation can be compared against directly. */
export interface EstimateEntry extends LedgerEntryBase { kind: "ESTIMATE"; unit: string }

/** An estimate whose observation only becomes available at a horizon. */
export interface ForecastEntry extends LedgerEntryBase { kind: "FORECAST"; unit: string; horizonAt: string }

/** A proposed action. Its outcome has an adoption dimension the others lack. */
export interface RecommendationEntry extends LedgerEntryBase { kind: "RECOMMENDATION"; proposedAction: string }

export type IntelligenceLedgerEntry = AssessmentEntry | EstimateEntry | ForecastEntry | RecommendationEntry;

/** The entries for which measuring an error is meaningful. Assessments are excluded BY CONSTRUCTION. */
export type MeasurableEntry = Exclude<IntelligenceLedgerEntry, AssessmentEntry>;

/**
 * Whether Nomila's judgment reached the decision-maker before the outcome, and whether it was followed.
 *
 * Not bookkeeping. It is the difference between a calibration dataset and a self-confirming loop: a system that learns
 * only from deals it recommended is measuring its own influence and calling it accuracy. It must be recorded for
 * outcomes that happened ANYWAY — `not_recommended` is as important a value as `recommended_and_followed`.
 */
export const ADOPTION = ["recommended_and_followed", "recommended_and_not_followed", "not_recommended", "unknown"] as const;
export type Adoption = (typeof ADOPTION)[number];

interface OutcomeBase {
  outcomeId: string;
  subjectType: LedgerSubjectType;
  subjectId: string;
  value: unknown;
  observedAt: string;
  createdAt: string;
  /** Where the realised value came from — a closed deal, a payment, a platform observation. */
  sourceIds: string[];
}

/** What actually happened, in units comparable to the entry it answers. */
export interface MeasuredOutcome extends OutcomeBase {
  kind: Exclude<JudgementKind, "ASSESSMENT">;
  /** Null when an outcome occurred with no preceding judgment — itself a finding worth keeping. */
  entryId: string | null;
  adoption: Adoption;
}

/**
 * Evidence bearing on an ASSESSMENT — deliberately NOT an outcome and NOT an error.
 *
 * "Athletes above MIA 700 closed more deals this quarter" is a legitimate research finding. "MIA was wrong by 40
 * points" is not a sentence that can be constructed, and this type is why.
 */
export interface CorrelationalObservation extends OutcomeBase {
  kind: "ASSESSMENT";
  entryId: string;
  /** What is being correlated, e.g. "closed deal count over 90 days". Never a target the assessment should match. */
  observedQuantity: string;
}

export type LedgerOutcome = MeasuredOutcome | CorrelationalObservation;

/** A judgment and its commensurable outcome. Assessments cannot form one. */
export interface CalibrationPair {
  entry: MeasurableEntry;
  outcome: MeasuredOutcome;
  error?: { absolute: number; relative: number };
}

/** True when this entry admits error measurement at all. Assessments never do. */
export function isMeasurable(entry: IntelligenceLedgerEntry): entry is MeasurableEntry {
  return entry.kind !== "ASSESSMENT";
}

/**
 * Error for a judgment against what happened.
 *
 * Passing an AssessmentEntry is a COMPILE error — that is the point of the signature. The runtime guard is belt and
 * braces for values crossing a boundary untyped (a database row, a JSON payload).
 */
export function calibrationError(entry: MeasurableEntry, predicted: number, actual: number): { absolute: number; relative: number } {
  if ((entry as IntelligenceLedgerEntry).kind === "ASSESSMENT") {
    throw new Error("calibrationError: an ASSESSMENT has no commensurable outcome — see ADR-011 and P-7");
  }
  const absolute = Math.abs(actual - predicted);
  return { absolute, relative: actual === 0 ? Number.NaN : absolute / Math.abs(actual) };
}

/**
 * Which of two entries for the same subject and kind is current.
 *
 * Keyed on evidenceAsOf, never on createdAt: jobs complete out of order, and an entry carrying older evidence must
 * never supersede one carrying newer. Equal evidence falls back to creation order.
 */
export function supersedes(candidate: IntelligenceLedgerEntry, incumbent: IntelligenceLedgerEntry): boolean {
  if (candidate.evidenceAsOf !== incumbent.evidenceAsOf) return candidate.evidenceAsOf > incumbent.evidenceAsOf;
  return candidate.createdAt > incumbent.createdAt;
}
