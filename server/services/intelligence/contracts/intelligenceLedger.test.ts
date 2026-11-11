/**
 * intelligenceLedger.test.ts — the ledger's two load-bearing rules are enforced, not documented.
 *
 *   1. An ASSESSMENT cannot produce an error. Structurally, not by convention — because if MIA error were computable,
 *      minimising it against commercial results is the obvious next move, and that is the circularity ADR-011 forbids.
 *   2. Supersession is keyed on EVIDENCE as-of, never on completion time, because jobs finish out of order.
 */
import {
  ADOPTION,
  JUDGEMENT_KINDS,
  calibrationError,
  isMeasurable,
  supersedes,
  type AssessmentEntry,
  type EstimateEntry,
  type ForecastEntry,
  type IntelligenceLedgerEntry,
  type RecommendationEntry,
} from "./intelligenceLedger";

const base = {
  subjectType: "athlete" as const,
  subjectId: "athlete-1",
  value: 616,
  confidence: "MEDIUM" as const,
  versions: { methodology: "v1.0.1-beta.1" },
  inputs: [],
  assumptions: [],
};

const assessment: AssessmentEntry = { ...base, entryId: "e1", kind: "ASSESSMENT", owner: "marketability", evidenceAsOf: "2026-09-14T00:00:00.000Z", createdAt: "2026-09-14T01:00:00.000Z" };
const estimate: EstimateEntry = { ...base, entryId: "e2", kind: "ESTIMATE", owner: "rates", unit: "USD", value: 1750, evidenceAsOf: "2026-09-14T00:00:00.000Z", createdAt: "2026-09-14T01:00:00.000Z" };
const forecast: ForecastEntry = { ...base, entryId: "e3", kind: "FORECAST", owner: "earnings", unit: "USD", value: 75000, horizonAt: "2027-09-14T00:00:00.000Z", evidenceAsOf: "2026-09-14T00:00:00.000Z", createdAt: "2026-09-14T01:00:00.000Z" };
const recommendation: RecommendationEntry = { ...base, entryId: "e4", kind: "RECOMMENDATION", owner: "commercial_plan", proposedAction: "counter at $4,500", evidenceAsOf: "2026-09-14T00:00:00.000Z", createdAt: "2026-09-14T01:00:00.000Z" };

describe("an ASSESSMENT has no commensurable outcome", () => {
  it("names all four judgement kinds", () => {
    expect([...JUDGEMENT_KINDS]).toEqual(["ASSESSMENT", "ESTIMATE", "FORECAST", "RECOMMENDATION"]);
  });

  it("marks only assessments as non-measurable", () => {
    expect(isMeasurable(assessment)).toBe(false);
    for (const e of [estimate, forecast, recommendation]) expect(isMeasurable(e)).toBe(true);
  });

  it("computes error for the kinds where a later observation arrives in the same units", () => {
    // Rate Intelligence said $1,750; the deal cleared at $2,000. That is legitimate calibration evidence.
    expect(calibrationError(estimate, 1750, 2000)).toEqual({ absolute: 250, relative: 0.125 });
    expect(calibrationError(forecast, 75000, 60000)).toEqual({ absolute: 15000, relative: 0.25 });
  });

  it("refuses an assessment at runtime as well as at compile time", () => {
    // @ts-expect-error — an AssessmentEntry is not assignable to MeasurableEntry. THIS is the guard; the throw below
    // only catches values that crossed a boundary untyped (a database row, a JSON payload).
    expect(() => calibrationError(assessment, 616, 700)).toThrow(/ASSESSMENT has no commensurable outcome/);
  });

  it("narrows to a measurable entry before an error can be taken", () => {
    const entries: IntelligenceLedgerEntry[] = [assessment, estimate, forecast, recommendation];
    const errors = entries.filter(isMeasurable).map((e) => calibrationError(e, 100, 110).absolute);
    expect(errors).toEqual([10, 10, 10]);   // three, not four — the assessment cannot participate
  });

  it("records whether a recommendation was followed, including when nothing was recommended", () => {
    expect([...ADOPTION]).toContain("not_recommended");
    expect([...ADOPTION]).toContain("recommended_and_not_followed");
  });
});

describe("supersession is keyed on evidence as-of, not completion time", () => {
  const evidenceA = "2026-09-14T10:00:00.000Z";
  const evidenceB = "2026-09-14T10:10:00.000Z";

  // The real scenario: a research refresh on evidence A starts first and finishes LAST.
  const fromNewerEvidence: IntelligenceLedgerEntry = { ...estimate, entryId: "b", evidenceAsOf: evidenceB, createdAt: "2026-09-14T10:15:00.000Z" };
  const fromOlderEvidenceButFinishedLater: IntelligenceLedgerEntry = { ...estimate, entryId: "a", evidenceAsOf: evidenceA, createdAt: "2026-09-14T10:25:00.000Z" };

  it("does not let a late job carrying older evidence overwrite a newer result", () => {
    expect(supersedes(fromOlderEvidenceButFinishedLater, fromNewerEvidence)).toBe(false);
    expect(supersedes(fromNewerEvidence, fromOlderEvidenceButFinishedLater)).toBe(true);
  });

  it("falls back to creation order only when the evidence is identical", () => {
    const earlier: IntelligenceLedgerEntry = { ...estimate, entryId: "x", evidenceAsOf: evidenceA, createdAt: "2026-09-14T11:00:00.000Z" };
    const later: IntelligenceLedgerEntry = { ...estimate, entryId: "y", evidenceAsOf: evidenceA, createdAt: "2026-09-14T12:00:00.000Z" };
    expect(supersedes(later, earlier)).toBe(true);
    expect(supersedes(earlier, later)).toBe(false);
  });
});

describe("inputs means upstream intelligence, not evidence lineage", () => {
  // The distinction is load-bearing and easy to lose, because a jsonb column accepts either. Marketability writes []
  // (ADR-011: it consumes no Nomila prediction) and records its evidence through its own run. Rates will write a
  // ValueRef to the Marketability entry it consumed, which is what makes staleness DETERMINABLE rather than inferred.
  const base = {
    entryId: "e1", subjectType: "athlete" as const, subjectId: "a1",
    value: {}, confidence: null, versions: { methodology: "v1.0.1-beta.1" },
    assumptions: [], evidenceAsOf: "2026-09-14T00:00:00.000Z", createdAt: "2026-09-14T01:00:00.000Z",
  };

  it("an ASSESSMENT that consumed no other judgment states so with an empty array", () => {
    const mia: AssessmentEntry = { ...base, kind: "ASSESSMENT", owner: "marketability", inputs: [] };
    expect(mia.inputs).toEqual([]);
  });

  it("a derived judgment names the exact upstream ENTRY, so staleness needs no date comparison", () => {
    // Dates cannot answer it: two assessments may legitimately share an evidenceAsOf, because a manual refresh
    // returns a fresh answer on identical supplied evidence and the later arrival wins. An entry id is exact —
    // upstream.supersededBy being set is the answer, with nothing to infer.
    const rate: EstimateEntry = {
      ...base, kind: "ESTIMATE", owner: "rates", unit: "usd_per_post",
      inputs: [{
        path: "marketability.mia", predictionId: "M42", owner: "marketability",
        evidenceClass: "EVALUATED", confidence: "MEDIUM", material: true,
      }],
    };
    expect(rate.inputs[0].predictionId).toBe("M42");
    expect(rate.inputs[0].material).toBe(true);
  });

  it("carries each engine's own parameter families alongside the common ones", () => {
    // Marketability records lookups/policy/priors/cohorts; another engine will record its own. The named keys are a
    // convenience, not the limit, or every engine would have to misuse `params` for everything it versions.
    const mia: AssessmentEntry = {
      ...base, kind: "ASSESSMENT", owner: "marketability", inputs: [],
      versions: { methodology: "v1.0.1-beta.1", evaluator: "blind-eval-spec/0.2.1", params: "v1.0.1-beta.1", lookups: "lookups-v1", policy: "policy-v0" },
    };
    expect(mia.versions.lookups).toBe("lookups-v1");
  });
});
