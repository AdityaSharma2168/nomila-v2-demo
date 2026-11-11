import { computeMarketabilityBeta1, mapCompositeToMiaBeta1 } from "./marketabilityBeta1";
import { MARKETABILITY_DIMENSIONS } from "./intelligence/types";
import { uniformBeta1Input } from "./marketabilityBeta1.testFixtures";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "./marketabilityBeta1FrozenParams";

describe("marketability Beta.1", () => {
  it("implements the frozen 0-850 calibration curve from injected params", () => {
    const mapping = MARKETABILITY_BETA1_FROZEN_PARAMS.config.mapping;
    expect(mapCompositeToMiaBeta1(0, mapping)).toBe(0);
    expect(mapCompositeToMiaBeta1(30, mapping)).toBe(324);
    expect(mapCompositeToMiaBeta1(50, mapping)).toBe(488);
    expect(mapCompositeToMiaBeta1(80, mapping)).toBe(711);
    expect(mapCompositeToMiaBeta1(100, mapping)).toBe(850);
  });

  it("returns the same dimension/composite when every normalized signal is equal", () => {
    const result = computeMarketabilityBeta1(uniformBeta1Input(70, 0.8), MARKETABILITY_BETA1_FROZEN_PARAMS);
    expect(result.composite).toBe(70);
    expect(result.confidence).toBe(80);
    expect(result.score).toBe(639);
    for (const dimension of result.dimensions) {
      expect(dimension.score).toBe(70);
      expect(dimension.confidence).toBe(80);
      expect(MARKETABILITY_DIMENSIONS).toContain(dimension.dimension);   // the canonical vocabulary (momentum has no underscore)
    }
  });

  it("clamps malformed normalized values instead of leaking outside the contract", () => {
    const input = uniformBeta1Input(120, -0.1);
    const result = computeMarketabilityBeta1(input, MARKETABILITY_BETA1_FROZEN_PARAMS);
    expect(result.composite).toBe(100);
    expect(result.confidence).toBe(0);
    expect(result.score).toBe(850);
  });

  it("preserves canonical signals and source-mode provenance", () => {
    const result = computeMarketabilityBeta1(uniformBeta1Input(70), MARKETABILITY_BETA1_FROZEN_PARAMS);
    const athletic = result.dimensions.find((dimension) => dimension.dimension === "athletic_authority")!;
    const first = athletic.signals[0];
    expect(first.source).toBe("platform_public");
    expect(first.evidenceIds.length).toBe(1);
    expect(first.modelVersion).toBe("test-normalizer-v1");
    expect(first.imputed).toBe(false);
    expect(result.provenance.sourceMode).toBe("canonical");
  });

  it("rejects drifted/incomplete parameter sets instead of silently scoring", () => {
    const params = structuredClone(MARKETABILITY_BETA1_FROZEN_PARAMS);
    params.config.dimensionWeights.momentum = 0.5;
    expect(() => computeMarketabilityBeta1(uniformBeta1Input(70), params)).toThrow(/sum to 1/);
  });
});
