/**
 * provenance.test.ts — the provenance contract's rules are enforced, not merely documented.
 *
 * P-2 (each engine declares the evidence classes it may emit) and P-3 (confidence never propagates upward) are the two
 * rules that stop the vocabulary becoming decorative. A comment saying "Marketability must not emit ASSUMED" survives
 * until the first refactor; a failing test does not.
 */
import {
  CONFIDENCE_LEVELS,
  ENGINE_EMITS,
  EVIDENCE_CLASSES,
  VALUE_OWNERS,
  derivedConfidenceIsValid,
  engineMayEmit,
  maxDerivedConfidence,
  type ConfidenceLevel,
  type ValueRef,
} from "./provenance";

const ref = (confidence: ConfidenceLevel, material: boolean): ValueRef => ({
  path: `x.${confidence}.${material}`,
  owner: "rates",
  evidenceClass: "MEASURED",
  confidence,
  material,
});

describe("P-2 — one vocabulary, and each engine declares what it may emit", () => {
  it("DERIVED is not an evidence class (it is a production method)", () => {
    expect(EVIDENCE_CLASSES).not.toContain("DERIVED" as never);
    expect([...EVIDENCE_CLASSES]).toEqual(["MEASURED", "EVALUATED", "ASSUMED", "MISSING"]);
  });

  it("uses MEASURED, not OBSERVED — the M.I.A. vocabulary is extended, not forked", () => {
    expect(EVIDENCE_CLASSES).toContain("MEASURED");
    expect(EVIDENCE_CLASSES).not.toContain("OBSERVED" as never);
  });

  it("every engine declares a non-empty, valid subset", () => {
    for (const owner of VALUE_OWNERS) {
      expect(ENGINE_EMITS[owner].length).toBeGreaterThan(0);
      for (const c of ENGINE_EMITS[owner]) expect(EVIDENCE_CLASSES).toContain(c);
    }
  });

  it("Marketability may not emit ASSUMED — its missing signals take a versioned prior, not a judgment", () => {
    expect(engineMayEmit("marketability", "ASSUMED")).toBe(false);
    expect(engineMayEmit("marketability", "EVALUATED")).toBe(true);
    expect(engineMayEmit("marketability", "MEASURED")).toBe(true);
  });

  it("Opportunity may evaluate judgments AND declare assumptions — it understands, it does not pretend to predict", () => {
    expect(engineMayEmit("opportunity", "EVALUATED")).toBe(true);
    expect(engineMayEmit("opportunity", "ASSUMED")).toBe(true);
  });

  it("Earnings originates no judgments — it derives from other engines' values", () => {
    expect(engineMayEmit("earnings", "EVALUATED")).toBe(false);
    expect(engineMayEmit("earnings", "MEASURED")).toBe(false);
  });
});

describe("P-3 — confidence propagates from the weakest material input, never upward", () => {
  it("takes the weakest material input", () => {
    expect(maxDerivedConfidence([ref("HIGH", true), ref("LOW", true)])).toBe("LOW");
    expect(maxDerivedConfidence([ref("HIGH", true), ref("MEDIUM", true)])).toBe("MEDIUM");
    expect(maxDerivedConfidence([ref("HIGH", true), ref("HIGH", true)])).toBe("HIGH");
  });

  it("ignores immaterial inputs — they stay in the lineage but do not bind", () => {
    expect(maxDerivedConfidence([ref("HIGH", true), ref("LOW", false)])).toBe("HIGH");
  });

  it("a derivation with no material inputs cannot claim more than LOW", () => {
    expect(maxDerivedConfidence([])).toBe("LOW");
    expect(maxDerivedConfidence([ref("HIGH", false)])).toBe("LOW");
  });

  it("the earnings case: one LOW assumption bounds the whole chain", () => {
    // Rate x volume x conversion x capacity — the rate is well evidenced, the volume is an assumption.
    const inputs = [ref("HIGH", true), ref("LOW", true), ref("LOW", true), ref("MEDIUM", true)];
    expect(maxDerivedConfidence(inputs)).toBe("LOW");
    expect(derivedConfidenceIsValid({ confidence: "LOW", inputs })).toBe(true);
    expect(derivedConfidenceIsValid({ confidence: "MEDIUM", inputs })).toBe(false);
    expect(derivedConfidenceIsValid({ confidence: "HIGH", inputs })).toBe(false);
  });

  it("claiming less than the ceiling is allowed; claiming more never is", () => {
    const inputs = [ref("HIGH", true)];
    for (const c of CONFIDENCE_LEVELS) expect(derivedConfidenceIsValid({ confidence: c, inputs })).toBe(true);
    const weak = [ref("LOW", true)];
    expect(derivedConfidenceIsValid({ confidence: "LOW", inputs: weak })).toBe(true);
    expect(derivedConfidenceIsValid({ confidence: "HIGH", inputs: weak })).toBe(false);
  });
});

describe("Rate emits EVALUATED — the class follows how a quantity was produced", () => {
  it("permits EVALUATED for rates", () => {
    // Corrected 17 Sep 2026. The original entry described v3.1's deterministic formula engine, whose numbers really
    // were assumptions. The approved Beta.1 methodology is a rubric-constrained evaluator pricing an athlete against
    // verified market benchmarks — an evidence-grounded judgment, which is what EVALUATED means.
    expect(engineMayEmit("rates", "EVALUATED")).toBe(true);
  });

  it("still permits ASSUMED for rates, for genuinely explicit assumptions", () => {
    // Narrowed rather than removed: ASSUMED is for an assumption deliberately adopted where evidence is unavailable,
    // not for "the output happened to be a number".
    expect(engineMayEmit("rates", "ASSUMED")).toBe(true);
  });

  it("leaves the Opportunity principle undisturbed", () => {
    // Opportunity's quantities stay ASSUMED because nothing yet gives a basis to estimate them. Rate differs because
    // commensurable commercial outcomes are coming, so its price is judged from evidence rather than placed.
    expect(engineMayEmit("opportunity", "ASSUMED")).toBe(true);
    expect(engineMayEmit("opportunity", "EVALUATED")).toBe(true);
  });

  it("marketability still may NOT emit ASSUMED", () => {
    // Unchanged: its missing sub-signals take a versioned prior, recorded as an imputed signal, not as a judgment.
    expect(engineMayEmit("marketability", "ASSUMED")).toBe(false);
  });
});
