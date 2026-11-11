/**
 * marketabilityBeta1.testFixtures.ts — test-specific material only.
 *
 * The frozen Beta.1 parameter artifact used to live here and now lives in marketabilityBeta1FrozenParams.ts. It moved
 * because it is operational configuration: it is seeded into model_params and activated on an environment, and a file
 * named for tests should never be the source an environment is configured from. These helpers build synthetic
 * ATHLETE inputs, which is genuinely test material.
 */
import { MARKETABILITY_DIMENSIONS, type MarketabilityDimension, type NormalizedSignal } from "./intelligence/types";
import type { MarketabilityBeta1Input } from "./marketabilityBeta1";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "./marketabilityBeta1FrozenParams";

export function beta1Signal(key: string, value: number, confidence = 0.8, imputed = false): NormalizedSignal {
  return {
    key,
    value,
    confidence,
    source: imputed ? "imputed" : "platform_public",
    evidenceIds: imputed ? [] : [`evidence:${key}`],
    modelVersion: "test-normalizer-v1",
    asOf: "2026-09-12T00:00:00.000Z",
    imputed,
  };
}

export function uniformBeta1Input(value: number, confidence = 0.8, imputed = false): MarketabilityBeta1Input {
  const dimensions = Object.fromEntries(MARKETABILITY_DIMENSIONS.map((dimension) => [
    dimension,
    Object.fromEntries(Object.keys(MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights[dimension]).map((key) => [key, beta1Signal(`${dimension}.${key}`, value, confidence, imputed)])),
  ])) as Record<MarketabilityDimension, Record<string, NormalizedSignal>>;
  return { asOf: "2026-09-12T00:00:00.000Z", sourceMode: "canonical", contextBuiltAt: "2026-09-12T00:00:00.000Z", dimensions };
}
