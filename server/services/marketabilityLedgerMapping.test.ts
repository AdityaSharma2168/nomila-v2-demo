/**
 * marketabilityLedgerMapping.test.ts
 *
 * The mapping decides what of an evaluator's judgment survives into the record every downstream layer reads. These
 * tests protect the two things that are easy to get quietly wrong: the evidence-class mapping, and the separation of
 * "we lack this" from "this may be wrong".
 */
import { describe, expect, it } from "@jest/globals";
import {
  assessmentValueFor,
  bandNumeric,
  componentEvidenceClass,
  evidenceFor,
  findingFor,
  notesFor,
  signalPath,
  type ScoredDimension,
} from "./marketabilityLedgerMapping";
import { normalizeJudgements, type EvaluatorOutput } from "./marketabilityBeta1Evaluator";
import { buildBeta1Dimensions, type Beta1PriorFn } from "./marketabilityBeta1Freeze";
import { computeMarketabilityBeta1 } from "./marketabilityBeta1";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "./marketabilityBeta1FrozenParams";

const out = (over: Partial<EvaluatorOutput> = {}): EvaluatorOutput => ({
  judgements: [],
  identityConfidence: "HIGH",
  summary: "s",
  summaryWords: 1,
  evidence: [],
  dimensionAssessments: {},
  overallConfidence: { level: "HIGH", explanation: "e" },
  keyStrengths: [],
  keyConstraints: [],
  importantMissingData: [],
  identityOrEvidenceRisks: [],
  ...over,
});

describe("evidence class — a judgment is not an observation", () => {
  it("does not promote a non-imputed signal to MEASURED", () => {
    // Every non-imputed Marketability signal is `web_researched` — the evaluator read sources and formed a view.
    // Calling that MEASURED because it is a number and was not imputed would mislabel all 1,455 of them, and would
    // tell every downstream layer that an inference is an observation.
    expect(componentEvidenceClass(null, { source: "web_researched", imputed: false })).toBe("EVALUATED");
    expect(componentEvidenceClass(null, { source: "inferred", imputed: false })).toBe("EVALUATED");
  });

  it("reserves MEASURED for values actually observed", () => {
    expect(componentEvidenceClass(null, { source: "connected_verified", imputed: false })).toBe("MEASURED");
    expect(componentEvidenceClass(null, { source: "platform_public", imputed: false })).toBe("MEASURED");
  });

  it("maps an imputed signal to ASSUMED, by either marker", () => {
    expect(componentEvidenceClass(null, { source: "web_researched", imputed: true })).toBe("ASSUMED");
    expect(componentEvidenceClass(null, { source: "imputed", imputed: false })).toBe("ASSUMED");
  });

  it("maps a missing judgement to MISSING, whatever the signal says", () => {
    // `missing` is a legitimate, expected answer from this evaluator, and it outranks the signal's own source.
    expect(componentEvidenceClass({ status: "missing" }, { source: "connected_verified" })).toBe("MISSING");
    expect(componentEvidenceClass({ status: "missing" }, { source: "imputed", imputed: true })).toBe("MISSING");
  });

  it("falls back to EVALUATED, never MEASURED, for an unrecognised source", () => {
    expect(componentEvidenceClass(null, { source: "something_new" })).toBe("EVALUATED");
    expect(componentEvidenceClass(null, null)).toBe("EVALUATED");
  });
});

describe("findings carry the reasoning the ledger used to drop", () => {
  const dim: ScoredDimension = {
    dimension: "narrative_power", score: 88.65, confidence: 90, weight: 0.1,
    signals: [
      { key: "narrative_power.distinctiveness", value: 92, source: "web_researched", imputed: false, evidenceIds: ["E1", "E3"] },
      { key: "narrative_power.media_resonance", value: 85, source: "web_researched", imputed: false, evidenceIds: ["E3"] },
    ],
  };
  const o = out({
    dimensionAssessments: { narrative_power: { prose: "Her narrative is exceptionally distinct…", confidence: "HIGH", confidenceReason: "widely documented" } },
    judgements: [
      { dimension: "narrative_power", key: "distinctiveness", status: "scored", score: 92, confidence: "HIGH", evidenceIds: ["E1", "E3"], rationale: "pioneering status", present: true },
      { dimension: "narrative_power", key: "media_resonance", status: "missing", score: null, confidence: null, evidenceIds: [], rationale: "no coverage found", present: true },
    ],
  });

  it("carries the per-dimension prose and confidence reason", () => {
    const f = findingFor(dim, o);
    expect(f.rationale).toBe("Her narrative is exceptionally distinct…");
    expect(f.confidenceReason).toBe("widely documented");
    expect(f.confidence).toBe("HIGH");
    expect(f.value).toBe(88.65);
  });

  it("carries per-signal rationale, which was dropped for every signal", () => {
    const f = findingFor(dim, o);
    expect(f.components!.map((c) => c.rationale)).toEqual(["pioneering status", "no coverage found"]);
  });

  it("classes each component by how it was actually produced", () => {
    const f = findingFor(dim, o);
    expect(f.components!.map((c) => c.evidenceClass)).toEqual(["EVALUATED", "MISSING"]);
  });

  it("rolls dimension citations up from its components rather than inventing a list", () => {
    // The evaluator states evidence per signal, never per dimension. Anything else here would be manufactured.
    expect(findingFor(dim, o).citedEvidence).toEqual(["E1", "E3"]);
  });

  it("survives a dimension the evaluator wrote no assessment for", () => {
    const f = findingFor(dim, out());
    expect(f.rationale).toBeNull();
    expect(f.confidence).toBe("HIGH"); // falls back to the numeric dimension confidence
    expect(f.components).toHaveLength(2);
  });
});

describe("notes keep two different things apart", () => {
  it("separates missing evidence from risks to the evaluation", () => {
    // One is a research task; the other is a caveat on everything above it. A reader handed one array of strings
    // cannot act differently on them.
    const n = notesFor(out({
      importantMissingData: ["Public follower counts for X and Instagram."],
      identityOrEvidenceRisks: ["Occasional misspelling of his last name introduces search index risks."],
      keyStrengths: ["Historic first."],
      keyConstraints: ["Small audience."],
    }));
    expect(n.missingEvidence).toEqual(["Public follower counts for X and Instagram."]);
    expect(n.evaluationRisks).toEqual(["Occasional misspelling of his last name introduces search index risks."]);
    expect(n.strengths).toHaveLength(1);
    expect(n.constraints).toHaveLength(1);
  });

  it("omits a category rather than emitting an empty array", () => {
    expect(notesFor(out())).toEqual({});
  });
});

describe("cited evidence", () => {
  it("carries claim, url, type and date for each source", () => {
    const [e] = evidenceFor(out({
      evidence: [{ id: "E1", claim: "co-captained the U.S. team", sourceUrl: "https://example.org/a", sourceType: "secondary", sourceTitle: "A", date: "2026-09-16" }],
    }));
    expect(e).toEqual({
      id: "E1", claim: "co-captained the U.S. team", sourceUrl: "https://example.org/a",
      sourceType: "secondary", sourceTitle: "A", observedAt: "2026-09-16",
    });
  });

  it("drops an entry with no usable id rather than inventing one", () => {
    expect(evidenceFor(out({ evidence: [{ id: "  ", claim: "x", sourceUrl: null, sourceType: null, sourceTitle: null, date: null }] }))).toEqual([]);
  });
});

describe("the assembled assessment value", () => {
  it("is generic: findings, evidence, notes, headline — nothing marketability-shaped", () => {
    const v = assessmentValueFor([{ dimension: "brand_fit", score: 84.8, confidence: 90, signals: [] }], 638, out({
      evidence: [{ id: "E1", claim: "c", sourceUrl: null, sourceType: null, sourceTitle: null, date: null }],
      importantMissingData: ["m"],
    }));
    expect(Object.keys(v).sort()).toEqual(["evidence", "findings", "headline", "notes"]);
    expect(v.headline).toEqual({ key: "mia_score", value: 638, confidence: "HIGH" });
    expect(v.findings[0]!.key).toBe("brand_fit");
    expect(v.notes!.missingEvidence).toEqual(["m"]);
  });

  it("carries no per-finding gap list, because the evaluator produces none", () => {
    // Declaring a field nobody populates is the exact mistake that caused this correction.
    const v = assessmentValueFor([{ dimension: "brand_fit", score: 1, signals: [] }], 1, out({ importantMissingData: ["m"] }));
    expect(v.findings[0]).not.toHaveProperty("materialGaps");
  });
});

describe("numeric confidence banding", () => {
  it("bands 0-100 and 0-1, and refuses a non-number", () => {
    expect(bandNumeric(90)).toBe("HIGH");
    expect(bandNumeric(0.9)).toBe("HIGH");
    expect(bandNumeric(60)).toBe("MEDIUM");
    expect(bandNumeric(10)).toBe("LOW");
    expect(bandNumeric(null)).toBeNull();
  });
});

/**
 * Signal identity, end to end through the REAL pipeline shapes: a raw evaluator response goes through
 * normalizeJudgements (judgements carry `{ dimension, key }` with a BARE key), then buildBeta1Dimensions and the scorer
 * (signals carry the qualified path `dimension.key`), then the mapping. No provider, no database.
 *
 * Before the fix, the mapping looked the qualified path up in a map keyed by the bare key and found nothing, for every
 * signal: rationale null throughout, and a missing signal classed ASSUMED instead of MISSING.
 */
describe("signal identity is dimension-qualified, end to end", () => {
  const subWeights = MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights;
  const AS_OF = "2026-09-20T00:00:00.000Z";

  // Every signal scored by default, with a rationale and evidence id that name the signal's own path — so any
  // cross-wiring shows up as the wrong path in the output.
  const node = (dim: string, key: string) => ({
    status: "scored", score: 60, confidence: "HIGH", evidence_ids: [`E:${dim}.${key}`], rationale: `r:${dim}.${key}`,
  });
  const dimensions: Record<string, Record<string, unknown>> = Object.fromEntries(
    Object.entries(subWeights).map(([d, sub]) => [d, Object.fromEntries(Object.keys(sub).map((k) => [k, node(d, k)]))]),
  );
  // Representative departures from the default.
  dimensions.athletic_authority.role_importance = {
    status: "scored", score: 72, confidence: "LOW", evidence_ids: ["E7", "E9"], rationale: "starting centre-back on the national side",
  };
  // The same bare key in two dimensions, answered differently.
  dimensions.audience_scale.audience_growth = {
    status: "scored", score: 40, confidence: "MEDIUM", evidence_ids: ["E2"], rationale: "follower growth modest year on year",
  };
  dimensions.momentum.audience_growth = {
    status: "missing", score: null, confidence: null, evidence_ids: ["E5"], rationale: "no dated follower series found",
  };
  // Missing without a node at all (the evaluator omitted it).
  delete dimensions.commercial_proof.pricing_power;

  const raw = {
    dimensions,
    // Every cited id exists in the evidence list: an id that resolves to nothing is dangling, never support.
    evidence: [...new Set(Object.values(dimensions).flatMap((sub) => Object.values(sub).flatMap((n: any) => n?.evidence_ids ?? [])))]
      .map((id) => ({ id, claim: `c:${id}` })),
    dimension_assessments: {
      athletic_authority: { prose: "Senior international.", confidence: "HIGH", confidence_reason: "federation records" },
      momentum: { prose: "Direction unclear.", confidence: "LOW", confidence_reason: "no time series" },
    },
  };

  const evaluator = normalizeJudgements(raw, subWeights);
  const prior: Beta1PriorFn = (path, scope) => ({
    // Shaped as the production normalizer's prior: keyed by path, imputed, no evidence.
    key: path, value: 50, confidence: 0.5, source: "imputed", evidenceIds: [], modelVersion: "test;prior=sport", asOf: scope.asOf, imputed: true,
  });
  const built = buildBeta1Dimensions({ signals: evaluator.judgements }, "soccer", prior, subWeights, AS_OF);
  const result = computeMarketabilityBeta1({ asOf: AS_OF, dimensions: built as never }, MARKETABILITY_BETA1_FROZEN_PARAMS);
  const value = assessmentValueFor(result.dimensions as unknown as ScoredDimension[], result.score, evaluator);

  const finding = (d: string) => value.findings.find((f) => f.key === d)!;
  const component = (d: string, k: string) => finding(d).components!.find((c) => c.key === `${d}.${k}`)!;
  const allComponents = () => value.findings.flatMap((f) => f.components ?? []);

  it("pins the shapes the bug lived between: bare judgement keys, qualified signal keys", () => {
    expect(evaluator.judgements.find((j) => j.dimension === "athletic_authority" && j.key === "role_importance")).toBeTruthy();
    expect(evaluator.judgements.some((j) => j.key.includes("."))).toBe(false);
    expect(result.dimensions.find((d) => d.dimension === "athletic_authority")!.signals.map((s) => s.key))
      .toContain("athletic_authority.role_importance");
  });

  it("(a) carries every signal's rationale", () => {
    const total = Object.values(subWeights).reduce((n, sub) => n + Object.keys(sub).length, 0);
    expect(allComponents()).toHaveLength(total);
    // pricing_power had no node at all, so it has no rationale; every other signal does.
    expect(allComponents().filter((c) => c.rationale == null).map((c) => c.key)).toEqual(["commercial_proof.pricing_power"]);
    expect(component("athletic_authority", "role_importance").rationale).toBe("starting centre-back on the national side");
    expect(component("brand_fit", "brand_safety").rationale).toBe("r:brand_fit.brand_safety");
  });

  it("(b) takes a scored signal's confidence from the evaluator, and keeps the dimension's confidence reason", () => {
    expect(component("athletic_authority", "role_importance").confidence).toBe("LOW");
    expect(component("audience_scale", "audience_growth").confidence).toBe("MEDIUM");
    expect(finding("athletic_authority").confidence).toBe("HIGH");
    expect(finding("athletic_authority").confidenceReason).toBe("federation records");
    expect(finding("momentum").confidenceReason).toBe("no time series");
  });

  it("(b) prefers the evaluator's confidence over the numeric band where the two disagree", () => {
    // In the real pipeline the numeric confidence is derived from the evaluator's word, so the two agree; this pins
    // which one wins if they ever do not.
    const f = findingFor(
      {
        dimension: "athletic_authority", score: 70, confidence: 95,
        signals: [{ key: "athletic_authority.role_importance", value: 72, source: "web_researched", imputed: false, confidence: 0.95 }],
      },
      evaluator,
    );
    expect(f.components![0]!.confidence).toBe("LOW");
  });

  it("(c) keeps a signal the evaluator marked missing MISSING, not ASSUMED", () => {
    expect(component("momentum", "audience_growth").evidenceClass).toBe("MISSING");
    expect(component("commercial_proof", "pricing_power").evidenceClass).toBe("MISSING");
    expect(component("athletic_authority", "role_importance").evidenceClass).toBe("EVALUATED");
    // Every imputed signal here was imputed because the evaluator said missing, so none is merely ASSUMED.
    expect(allComponents().filter((c) => c.evidenceClass === "ASSUMED")).toEqual([]);
  });

  it("(d) gives each dimension its own judgement for a same-named signal", () => {
    expect(component("audience_scale", "audience_growth")).toMatchObject({
      evidenceClass: "EVALUATED", confidence: "MEDIUM", rationale: "follower growth modest year on year", citedEvidence: ["E2"],
    });
    expect(component("momentum", "audience_growth")).toMatchObject({
      evidenceClass: "MISSING", rationale: "no dated follower series found", citedEvidence: ["E5"],
    });
  });

  it("(d) is order-independent: the other dimension's judgement listed first cannot win", () => {
    const reversed = { ...evaluator, judgements: [...evaluator.judgements].reverse() };
    const again = assessmentValueFor(result.dimensions as unknown as ScoredDimension[], result.score, reversed);
    expect(again.findings).toEqual(value.findings);
  });

  it("(e) keeps cited evidence with its own dimension and signal", () => {
    expect(component("athletic_authority", "role_importance").citedEvidence).toEqual(["E7", "E9"]);
    for (const c of allComponents()) {
      for (const id of c.citedEvidence ?? []) {
        if (id.startsWith("E:")) expect(id).toBe(`E:${c.key}`);
      }
    }
    expect(finding("audience_scale").citedEvidence).toContain("E2");
    expect(finding("audience_scale").citedEvidence).not.toContain("E5");
    expect(finding("momentum").citedEvidence).toContain("E5");
    expect(finding("momentum").citedEvidence).not.toContain("E2");
  });
});

describe("signalPath", () => {
  it("qualifies a bare key and leaves a qualified one alone", () => {
    expect(signalPath("momentum", "audience_growth")).toBe("momentum.audience_growth");
    expect(signalPath("momentum", "momentum.audience_growth")).toBe("momentum.audience_growth");
  });
});
