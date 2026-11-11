/**
 * marketabilityBeta1.ts — pure deterministic M.I.A. Beta.1 scoring engine.
 *
 * The engine owns arithmetic only. It consumes canonical NormalizedSignal values and a
 * versioned marketability parameter set supplied by the caller. It never loads the DB,
 * provider payloads, priors or cohort tables itself.
 */

import {
  MARKETABILITY_DIMENSIONS,
  type DimensionScore,
  type Driver,
  type MarketabilityDimension,
  type NormalizedSignal,
} from "./intelligence/types";
import type { SourceMode } from "./intelligence/context/contract";

/**
 * Beta.1 methodology identity. Bumped to v1.0.1 on 14 Sep 2026 when the structurally-private missingness rule was added:
 * the 44 sub-signals, the weights and the 0–850 mapping are unchanged, but a change to signals, weights, missingness rules
 * or mapping always bumps this, so "the same Beta.1" cannot quietly mean two different calculations.
 */
export const MARKETABILITY_BETA1_VERSION = "v1.0.1-beta.1" as const;
export type { NormalizedSignal } from "./intelligence/types";

export interface MarketabilityBeta1Config {
  status?: string;
  dimensionWeights: Record<MarketabilityDimension, number>;
  subWeights: Record<MarketabilityDimension, Record<string, number>>;
  mapping: {
    kind: "power";
    max: number;
    exponent: number;
    alpha?: boolean;
    note?: string;
  };
  /**
   * Sub-signal paths ("dimension.key") that cannot be observed without private or connected platform data. While a listed
   * sub-signal is MISSING (imputed, i.e. it took its prior) it is EXCLUDED from its dimension's weighted sum and the
   * remaining sub-weights are renormalized. Absent or empty ⇒ every missing sub-signal contributes its prior, which stays
   * the behaviour for every path not listed here.
   *
   * The trigger is status, never evidence provenance: a listed sub-signal that IS scored participates at its normal
   * frozen weight. Renormalizing cannot invent a score — when the surviving sub-signals are themselves on the prior, the
   * renormalized result is that same prior.
   *
   * Beta.1 lists the three Engagement Quality signals (saves/shares, retention, story) that are private by construction;
   * see marketabilityBeta1.md and server/scripts/calibration/analyzeEqPrivateMissingness.ts for the 37-athlete evidence.
   */
  structurallyPrivate?: readonly string[];
}

export interface MarketabilityBeta1Params {
  version: string;
  schemaVersion: string;
  config: MarketabilityBeta1Config;
}

export interface MarketabilityBeta1Input {
  athleteId?: string;
  asOf: string;
  /** Context provenance for shadow auditing; never changes score arithmetic. */
  sourceMode?: SourceMode;
  contextBuiltAt?: string;
  dimensions: Record<MarketabilityDimension, Record<string, NormalizedSignal>>;
}

export interface MarketabilityBeta1DimensionScore extends DimensionScore {
  /** Data confidence for this dimension, 0-100 presentation scale. */
  confidence: number;
}

/**
 * Tier is intentionally absent: the architecture leaves tier vocabulary/display policy open.
 * Everything else uses the canonical marketability vocabulary and contracts.
 */
export interface MarketabilityBeta1Result {
  score: number;
  composite: number;
  potential: null;
  confidence: number;
  dimensions: MarketabilityBeta1DimensionScore[];
  drivers: Driver[];
  version: string;
  asOf: string;
  provenance: {
    sourceMode: SourceMode | null;
    contextBuiltAt: string | null;
  };
}

function clamp100(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round(value: number, digits = 2): number {
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}

function assertWeightSet(label: string, weights: Record<string, number>): void {
  const values = Object.values(weights);
  if (!values.length) throw new Error(`Empty weight set: ${label}`);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`Invalid weight in ${label}`);
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-6) throw new Error(`Weights for ${label} must sum to 1; got ${total}`);
}

export function validateMarketabilityBeta1Params(params: MarketabilityBeta1Params): void {
  if (!params.version || !params.schemaVersion) throw new Error("Marketability params require version and schemaVersion");
  assertWeightSet("dimensionWeights", params.config.dimensionWeights);
  if (params.config.mapping.kind !== "power" || !Number.isFinite(params.config.mapping.max) || params.config.mapping.max <= 0 ||
      !Number.isFinite(params.config.mapping.exponent) || params.config.mapping.exponent <= 0) {
    throw new Error("Invalid marketability mapping config");
  }
  for (const dimension of MARKETABILITY_DIMENSIONS) {
    if (typeof params.config.dimensionWeights[dimension] !== "number") throw new Error(`Missing dimension weight: ${dimension}`);
    assertWeightSet(`subWeights.${dimension}`, params.config.subWeights[dimension]);
  }
}

function scoreDimension(
  dimension: MarketabilityDimension,
  signals: Record<string, NormalizedSignal>,
  weights: Record<string, number>,
  structurallyPrivate: ReadonlySet<string> = new Set(),
): MarketabilityBeta1DimensionScore {
  let score = 0;
  let confidence01 = 0;
  const used: NormalizedSignal[] = [];

  // A structurally-private sub-signal that is MISSING leaves the weighted sum; the survivors are renormalized over the
  // weight that remains. Confidence is deliberately NOT renormalized — the athlete we know less about still reports lower
  // dimension confidence, which is how "score = what the evidence supports, confidence = how completely we know it" holds.
  const excluded = new Set(Object.keys(weights).filter((k) => structurallyPrivate.has(`${dimension}.${k}`) && signals[k]?.imputed));
  const keptWeight = Object.entries(weights).reduce((sum, [k, w]) => (excluded.has(k) ? sum : sum + w), 0);

  for (const [signalKey, weight] of Object.entries(weights)) {
    const signal = signals[signalKey];
    if (!signal) throw new Error(`Missing normalized signal ${dimension}.${signalKey}`);
    const value = clamp100(signal.value);
    const signalConfidence = clamp01(signal.confidence);
    if (!excluded.has(signalKey) && keptWeight > 0) score += value * (weight / keptWeight);
    else if (keptWeight <= 0) score += value * weight;   // every sub-signal excluded: fall back to the unrenormalized sum
    confidence01 += signalConfidence * weight;
    used.push({ ...signal, value, confidence: signalConfidence });
  }

  const dimensionScore = round(clamp100(score));
  return {
    dimension,
    score: dimensionScore,
    weight: 0, // filled by computeMarketabilityBeta1 from the versioned config
    contribution: 0,
    confidence: round(clamp01(confidence01) * 100),
    signals: used,
  };
}

export function mapCompositeToMiaBeta1(composite: number, mapping: MarketabilityBeta1Config["mapping"]): number {
  const c = clamp100(composite);
  if (mapping.kind !== "power") throw new Error(`Unsupported marketability mapping: ${mapping.kind}`);
  return Math.round(mapping.max * Math.pow(c / 100, mapping.exponent));
}

export function computeMarketabilityBeta1(
  input: MarketabilityBeta1Input,
  params: MarketabilityBeta1Params,
): MarketabilityBeta1Result {
  validateMarketabilityBeta1Params(params);

  const structurallyPrivate = new Set(params.config.structurallyPrivate ?? []);
  const dimensions: MarketabilityBeta1DimensionScore[] = MARKETABILITY_DIMENSIONS.map((dimension) => {
    const scored = scoreDimension(dimension, input.dimensions[dimension], params.config.subWeights[dimension], structurallyPrivate);
    const weight = params.config.dimensionWeights[dimension];
    return { ...scored, weight, contribution: round(scored.score * weight) };
  });

  const composite = round(clamp100(dimensions.reduce((sum, dimension) => sum + dimension.contribution, 0)));
  const confidence = round(clamp100(dimensions.reduce((sum, dimension) => sum + dimension.confidence * dimension.weight, 0)));

  return {
    score: mapCompositeToMiaBeta1(composite, params.config.mapping),
    composite,
    potential: null,
    confidence,
    dimensions,
    drivers: [],
    version: params.version,
    asOf: input.asOf,
    provenance: {
      sourceMode: input.sourceMode ?? null,
      contextBuiltAt: input.contextBuiltAt ?? null,
    },
  };
}
