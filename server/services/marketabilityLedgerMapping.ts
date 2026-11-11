/**
 * marketabilityLedgerMapping.ts — M.I.A.'s evaluator output → the generic ledger shape.
 *
 * Its own file because the mapping is a real piece of reasoning, not plumbing: it decides what of an evaluator's
 * judgment survives into the record every downstream layer reads. Keeping it testable without a database or a
 * provider is the point.
 *
 * WHAT THIS RECOVERS. Marketability produces eleven keys of judgement; the ledger carried four plus the scoring
 * layer's numbers. `dimensionAssessments` (the per-dimension prose, confidence and confidence reason), `evidence`
 * (the cited sources with URLs), `keyStrengths`, `keyConstraints` and `identityOrEvidenceRisks` were all discarded,
 * and per-signal rationale with them. This maps every one of them onto the generic contract.
 */
import type { Confidence, EvaluatorOutput, Judgement } from "./marketabilityBeta1Evaluator";
import type {
  AssessmentNotes,
  AssessmentValue,
  LedgerComponent,
  LedgerEvidenceCitation,
  LedgerFinding,
} from "./intelligence/contracts/intelligenceLedger";
import type { ConfidenceLevel, EvidenceClass } from "./intelligence/contracts/provenance";
import { groundCitations, type CitationGroundingContext } from "./marketabilityCitationLineage";

/** A scored dimension as the scoring layer produces it. Structural only — no import, to keep this file portable. */
export interface ScoredDimension {
  dimension: string;
  score: number;
  confidence?: number | null;
  weight?: number | null;
  contribution?: number | null;
  signals?: Array<{ key: string; value?: number | null; source?: string | null; imputed?: boolean; confidence?: number | null; evidenceIds?: string[] }>;
}

const conf = (c: Confidence | null | undefined): ConfidenceLevel | null =>
  c === "HIGH" || c === "MEDIUM" || c === "LOW" ? c : null;

/** M.I.A.'s dimension confidence is 0-100; the shared vocabulary is ordinal. */
export function bandNumeric(pct: number | null | undefined): ConfidenceLevel | null {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  const v = pct <= 1 ? pct * 100 : pct;
  return v >= 75 ? "HIGH" : v >= 50 ? "MEDIUM" : "LOW";
}

/**
 * How a component came to be known.
 *
 * THE MAPPING IS NOT MECHANICAL, and getting it wrong is worse than omitting it. A signal that was not imputed is
 * not therefore MEASURED: Marketability's non-imputed signals are all `web_researched`, which means the evaluator
 * read sources and formed a judgment. That is EVALUATED. MEASURED is reserved for a value actually observed —
 * connected platform data, a recorded transaction — and today no Marketability signal qualifies.
 *
 * Collapsing the two would tell every downstream layer that an evaluator's inference is an observation, which is
 * precisely the confusion the provenance vocabulary exists to prevent.
 */
export function componentEvidenceClass(
  judgement: Pick<Judgement, "status"> | null,
  signal: { source?: string | null; imputed?: boolean } | null,
): EvidenceClass {
  if (judgement?.status === "missing") return "MISSING";
  if (signal?.imputed || signal?.source === "imputed") return "ASSUMED";
  switch (signal?.source) {
    // Actually observed.
    case "connected_verified":
    case "platform_public":
      return "MEASURED";
    // Read and judged.
    case "web_researched":
    case "inferred":
      return "EVALUATED";
    default:
      // An unknown source is not quietly promoted to MEASURED. EVALUATED is the honest floor for an evaluator's
      // output whose production method we cannot name.
      return "EVALUATED";
  }
}

/**
 * A signal's identity is its dimension AND its key, never the key alone.
 *
 * The two sides spell it differently. The evaluator's judgement carries `{ dimension, key }` with a BARE key
 * (`role_importance`); the scoring layer's signal carries the qualified path (`athletic_authority.role_importance`),
 * because buildBeta1Dimensions and the prior lookup both key it by path. Matching one against the other found nothing,
 * so every component lost its rationale and confidence, and a signal the evaluator marked missing read as ASSUMED.
 *
 * The bare key alone is not an identity either: `audience_growth` is a sub-signal of both `audience_scale` and
 * `momentum`. Both sides are therefore brought to `dimension.key` before they meet.
 */
export function signalPath(dimension: string, key: string): string {
  return key.startsWith(`${dimension}.`) ? key : `${dimension}.${key}`;
}

/** One dimension → one generic finding, carrying the evaluator's own reasoning for it. */
export function findingFor(
  dim: ScoredDimension,
  out: Pick<EvaluatorOutput, "dimensionAssessments" | "judgements">,
): LedgerFinding {
  const assessment = out.dimensionAssessments?.[dim.dimension] ?? null;
  // Only this dimension's judgements, keyed by their qualified path — a same-named signal in another dimension can
  // never answer for this one.
  const byPath = new Map(
    (out.judgements ?? [])
      .filter((j) => j.dimension === dim.dimension)
      .map((j) => [signalPath(j.dimension, j.key), j]),
  );

  const components: LedgerComponent[] = (dim.signals ?? []).map((s) => {
    const j = byPath.get(signalPath(dim.dimension, s.key)) ?? null;
    return {
      key: s.key,
      value: s.value ?? null,
      evidenceClass: componentEvidenceClass(j, s),
      confidence: conf(j?.confidence ?? null) ?? bandNumeric(s.confidence),
      // Per-signal rationale. The evaluator writes one for every signal, scored or missing, and the ledger dropped
      // all of them.
      rationale: j?.rationale ?? null,
      citedEvidence: j?.evidenceIds ?? s.evidenceIds ?? [],
    };
  });

  return {
    key: dim.dimension,
    value: dim.score,
    confidence: conf(assessment?.confidence ?? null) ?? bandNumeric(dim.confidence),
    rationale: assessment?.prose ?? null,
    confidenceReason: assessment?.confidenceReason ?? null,
    // A dimension's citations are the union of what its components cited: the evaluator states evidence per signal,
    // not per dimension, so rolling up is the only honest answer and inventing a separate list would be worse.
    citedEvidence: [...new Set(components.flatMap((c) => c.citedEvidence ?? []))].sort(),
    components,
    ...(typeof dim.weight === "number" ? {} : {}),
  };
}

export function evidenceFor(out: Pick<EvaluatorOutput, "evidence">): LedgerEvidenceCitation[] {
  return (out.evidence ?? [])
    .filter((e) => e && typeof e.id === "string" && e.id.trim())
    .map((e) => ({
      id: e.id,
      claim: e.claim ?? "",
      sourceUrl: e.sourceUrl ?? null,
      sourceType: e.sourceType ?? null,
      sourceTitle: e.sourceTitle ?? null,
      observedAt: e.date ?? null,
    }));
}

/**
 * Notes, with the two kinds kept apart.
 *
 * `importantMissingData` is a research task — go and find this. `identityOrEvidenceRisks` is a caveat on everything
 * above it — this may be wrong for that reason. A reader handed one array cannot act differently on them.
 */
export function notesFor(
  out: Pick<EvaluatorOutput, "importantMissingData" | "identityOrEvidenceRisks" | "keyStrengths" | "keyConstraints">,
): AssessmentNotes {
  const some = (xs: string[] | undefined) => (xs ?? []).filter((x) => typeof x === "string" && x.trim());
  const notes: AssessmentNotes = {};
  const missing = some(out.importantMissingData);
  const risks = some(out.identityOrEvidenceRisks);
  const strengths = some(out.keyStrengths);
  const constraints = some(out.keyConstraints);
  if (missing.length) notes.missingEvidence = missing;
  if (risks.length) notes.evaluationRisks = risks;
  if (strengths.length) notes.strengths = strengths;
  if (constraints.length) notes.constraints = constraints;
  return notes;
}

/**
 * The generic half of an ASSESSMENT value. The engine keeps its own fields alongside.
 *
 * `grounding` is the run's stored grounding metadata and snapshot. With it, every citation carries its lineage —
 * whether the source was actually retrieved (marketabilityCitationLineage.ts). Cited ids that resolve to nothing are
 * moved to `danglingEvidence` either way.
 */
export function assessmentValueFor(
  dimensions: ScoredDimension[],
  score: number,
  out: EvaluatorOutput,
  grounding: CitationGroundingContext | null = null,
): AssessmentValue {
  const { findings, evidence } = groundCitations(dimensions.map((d) => findingFor(d, out)), evidenceFor(out), grounding);
  return {
    headline: { key: "mia_score", value: score, confidence: conf(out.overallConfidence?.level ?? null) },
    findings,
    evidence,
    notes: notesFor(out),
  };
}
