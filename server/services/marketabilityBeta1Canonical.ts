/**
 * Shadow-only adapter between canonical Nomila intelligence and marketability-v1.0-beta.1.
 * It selects canonical evidence but deliberately does not invent percentile/lookup tables.
 */
import type { CanonicalAthleteContext } from "./intelligence/context/contract";
import {
  MARKETABILITY_DIMENSIONS,
  type EvidenceRef,
  type MarketabilityDimension,
  type NormalizedSignal,
  type SourceClass,
} from "./intelligence/types";
import type { FeatureRow } from "./intelligence/social/features";
import type { FeatureKey } from "./intelligence/social/metrics";
import type { MarketabilityBeta1Input, MarketabilityBeta1Params } from "./marketabilityBeta1";

export const MARKETABILITY_BETA1_CANONICAL_ADAPTER_VERSION = "marketability-beta1-canonical-adapter-v1" as const;

export type Beta1SignalPath = `${MarketabilityDimension}.${string}`;
export type StoredFeatureRow = FeatureRow & { id?: number | string };

export interface CanonicalSignalEvidence {
  path: Beta1SignalPath;
  features: StoredFeatureRow[];
  /** Stable identity for derived feature rows when persisted. */
  featureEvidence: EvidenceRef[];
  /** Underlying social observation lineage carried by FeatureRow.inputs.observationIds. */
  observationIds: string[];
  inputAccessClasses: Array<FeatureRow["inputAccessClass"]>;
  classified?: NormalizedSignal;
  context: {
    sport: string | null;
    segment: string | null;
    careerStatus: string | null;
    sourceMode: CanonicalAthleteContext["sourceMode"];
    /** The scoring as-of: freshness windows and prior timestamps are measured against it. */
    asOf: string;
  };
  ownership: "primary" | "secondary";
}

export interface MarketabilityBeta1Normalizer {
  version: string;
  normalize(evidence: CanonicalSignalEvidence): NormalizedSignal | null;
  prior(path: Beta1SignalPath, context: CanonicalSignalEvidence["context"]): NormalizedSignal;
}

export interface MarketabilityBeta1CanonicalSource {
  context: CanonicalAthleteContext;
  socialFeatures: StoredFeatureRow[];
  classifiedSignals?: Partial<Record<Beta1SignalPath, NormalizedSignal>>;
  asOf?: string;
}

/**
 * Only direct, semantically matching feature inputs belong here. Cohort normalization and
 * categorical maps live in the versioned normalizer/parameter layer, not this selector.
 */
/**
 * WITHDRAWN PATH — DO NOT USE FOR CONNECTED-SOCIAL WORK. See ADR-017.
 *
 * This maps social feature keys directly onto Beta.1 sub-signals: metric -> signal, deterministically. It is the
 * approach that was tried and withdrawn (Slice E scored 0.08 against the development reference set where the
 * rubric-constrained evaluator scores 0.887), and it is the single most tempting wrong turn in this codebase, because
 * it is a ready-made map from the metrics we collect to the exact ten social sub-signals.
 *
 * Connected metrics reach the evaluator as EVIDENCE, through server/scripts/calibration/blindEval/socialBlock.ts:
 * feature -> factual prose -> rubric-constrained judgment -> frozen arithmetic. Nomila computes rates; the evaluator
 * decides what a rate means for this athlete, sport and level.
 *
 * Retained only because marketabilityBeta1Canonical.ts and normalizationReadiness still reference it. It is deleted
 * with the canonical path in the cleanup. No NEW importer is permitted — enforced by
 * server/services/marketabilityBeta1CanonicalQuarantine.test.ts.
 *
 * @deprecated withdrawn deterministic signal derivation; do not add callers.
 */
export const SOCIAL_FEATURE_KEYS: Partial<Record<Beta1SignalPath, readonly FeatureKey[]>> = {
  "audience_scale.cross_platform_effective_reach": ["effective_reach_cross_platform"],
  "audience_scale.sport_level_audience_percentile": ["followers_latest"],
  "audience_scale.audience_growth": ["followers_growth_pct"],
  "audience_scale.platform_breadth": ["platform_breadth"],
  "engagement_quality.engagement_percentile": ["engagement_per_follower_median", "interactions_per_reach_median", "interactions_per_view_median"],
  "engagement_quality.reach_efficiency": ["reach_per_follower_median", "views_per_follower_median", "non_follower_reach_share"],
  "engagement_quality.shares_saves_quality": ["saves_per_1k_reach_median", "shares_per_1k_reach_median", "shares_per_1k_views_median"],
  "engagement_quality.video_retention": ["completion_pct_median"],
  "momentum.audience_growth": ["followers_growth_pct"],
  "brand_fit.geographic_relevance": ["audience_top_country_share", "audience_geo_concentration"],
};

function sourceRank(sourceClass: SourceClass): number {
  return { connected_verified: 5, platform_public: 4, web_researched: 3, inferred: 2, imputed: 1 }[sourceClass];
}

function selectFeatures(rows: StoredFeatureRow[], keys: readonly FeatureKey[], asOf: string): StoredFeatureRow[] {
  if (!keys.length) return [];
  const asOfMs = new Date(asOf).getTime();
  const candidates = rows.filter((row) =>
    keys.includes(row.featureKey) &&
    typeof row.value === "number" &&
    Number.isFinite(row.value) &&
    new Date(row.asOf).getTime() <= asOfMs,
  );

  // Privacy/access class is part of comparability (ADR-016). Public-only and private-inclusive
  // rows remain separate candidates even when every other coordinate matches.
  const selected = new Map<string, StoredFeatureRow>();
  for (const row of candidates) {
    const key = `${row.platform ?? "cross"}|${row.identityId ?? "cross"}|${row.featureKey}|${row.windowDays}|${row.inputAccessClass}`;
    const current = selected.get(key);
    if (!current || sourceRank(row.sourceClass) > sourceRank(current.sourceClass) ||
        (sourceRank(row.sourceClass) === sourceRank(current.sourceClass) && new Date(row.asOf) > new Date(current.asOf))) {
      selected.set(key, row);
    }
  }
  return [...selected.values()];
}

function contextFor(context: CanonicalAthleteContext, asOf: string): CanonicalSignalEvidence["context"] {
  return {
    sport: context.identity.sport?.value.sport ?? null,
    segment: context.affiliations.level.segment ?? null,
    careerStatus: context.identity.careerStatus.value.status ?? null,
    sourceMode: context.sourceMode,
    asOf,
  };
}

function featureEvidence(rows: StoredFeatureRow[]): EvidenceRef[] {
  return rows.flatMap((row) => row.id == null ? [] : [{
    evidenceId: `social_feature:${row.id}`,
    sourceClass: row.sourceClass,
    observedAt: row.asOf,
    confidence: row.confidence,
  }]);
}

function observationIds(rows: StoredFeatureRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const raw = (row.inputs as { observationIds?: unknown } | null | undefined)?.observationIds;
    if (!Array.isArray(raw)) continue;
    for (const id of raw) if (typeof id === "string" || typeof id === "number") ids.add(String(id));
  }
  return [...ids];
}

function evidenceFor(source: MarketabilityBeta1CanonicalSource, path: Beta1SignalPath, asOf: string): CanonicalSignalEvidence {
  const features = selectFeatures(source.socialFeatures, SOCIAL_FEATURE_KEYS[path] ?? [], asOf);
  return {
    path,
    features,
    featureEvidence: featureEvidence(features),
    observationIds: observationIds(features),
    inputAccessClasses: [...new Set(features.map((row) => row.inputAccessClass))],
    classified: source.classifiedSignals?.[path],
    context: contextFor(source.context, asOf),
    ownership: path === "momentum.audience_growth" ? "secondary" : "primary",
  };
}

function resolveSignal(
  source: MarketabilityBeta1CanonicalSource,
  normalizer: MarketabilityBeta1Normalizer,
  path: Beta1SignalPath,
  asOf: string,
): NormalizedSignal {
  const evidence = evidenceFor(source, path, asOf);
  const normalized = normalizer.normalize(evidence);
  if (normalized) return { ...normalized, modelVersion: normalized.modelVersion || normalizer.version };
  const prior = normalizer.prior(path, evidence.context);
  return { ...prior, modelVersion: prior.modelVersion || normalizer.version };
}

function pathsFor(params: MarketabilityBeta1Params): Beta1SignalPath[] {
  return MARKETABILITY_DIMENSIONS.flatMap((dimension) =>
    Object.keys(params.config.subWeights[dimension]).map((signal) => `${dimension}.${signal}` as Beta1SignalPath),
  );
}

export function inspectMarketabilityBeta1Evidence(
  source: MarketabilityBeta1CanonicalSource,
  params: MarketabilityBeta1Params,
): CanonicalSignalEvidence[] {
  const asOf = source.asOf ?? source.context.builtAt;
  return pathsFor(params).map((path) => evidenceFor(source, path, asOf));
}

export function buildMarketabilityBeta1InputFromCanonical(
  source: MarketabilityBeta1CanonicalSource,
  normalizer: MarketabilityBeta1Normalizer,
  params: MarketabilityBeta1Params,
): MarketabilityBeta1Input {
  const asOf = source.asOf ?? source.context.builtAt;
  const dimensions = Object.fromEntries(MARKETABILITY_DIMENSIONS.map((dimension) => {
    const signals = Object.fromEntries(Object.keys(params.config.subWeights[dimension]).map((signalKey) => {
      const path = `${dimension}.${signalKey}` as Beta1SignalPath;
      return [signalKey, resolveSignal(source, normalizer, path, asOf)];
    }));
    return [dimension, signals];
  })) as MarketabilityBeta1Input["dimensions"];

  return {
    athleteId: source.context.athleteId,
    asOf,
    sourceMode: source.context.sourceMode,
    contextBuiltAt: source.context.builtAt,
    dimensions,
  };
}
