/**
 * marketabilityBeta1Service.ts — one athlete → a real M.I.A. Beta.1 result from canonical data (Phase A Step 4, Slice D).
 *
 * canonical context (facts, evidence, affiliations) + stored social features → the canonical adapter selects evidence per
 * sub-signal → the versioned normalizer (cohort percentiles, lookups, priors, freshness, confidence) → the frozen engine
 * (8 dimensions, weighted composite, 0–850). Shadow-only: nothing here writes a score anywhere.
 *
 * Qualitative sub-signals are NOT derived here. The deterministic research-to-score mappings that once fed this path were
 * withdrawn: interpreting evidence into a 0–100 judgement is the M.I.A. evaluator's job, and this service keeps only the
 * evidence loading, normalization and arithmetic around it.
 *
 * Every sub-signal without current, comparable evidence takes its versioned prior (imputed, low confidence); the result
 * reports how many did, so a first pass is honest about what it is.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { athleteFacts, researchEvidence, socialFeatures } from "../../shared/schema";
import { CITED_LINEAGES } from "./intelligence/research/registries";
import { buildCanonicalContext } from "./intelligence/context/build";
import type { NormalizedSignal } from "./intelligence/types";
import { computeMarketabilityBeta1, type MarketabilityBeta1Input, type MarketabilityBeta1Result } from "./marketabilityBeta1";
import { buildMarketabilityBeta1InputFromCanonical, SOCIAL_FEATURE_KEYS, type StoredFeatureRow } from "./marketabilityBeta1Canonical";
import { createBeta1Normalizer, normalizationReadiness, type SignalReadiness } from "./marketabilityBeta1Normalization";
import { loadBeta1Params, type LoadedBeta1Params } from "./marketabilityBeta1Params";

export interface Beta1ScoreOutcome {
  athleteId: string;
  asOf: string;
  result: MarketabilityBeta1Result;
  input: MarketabilityBeta1Input;
  /** Sub-signals resolved from evidence vs. taken from a prior. */
  evidenceSignals: number;
  imputedSignals: number;
  totalSignals: number;
  /** Weighted share (Σ dimension weight × sub-weight) of sub-signals resolved from evidence vs. imputed. */
  observedWeightedShare: number;
  /** The sub-signal paths resolved from evidence (social features or research-derived), with the research basis where applicable. */
  observedSignals: Array<{ path: string; source: string; basis: string | null }>;
  /** Accepted canonical inputs: registry facts (current/historical) and cited-equivalent evidence rows read for this score. */
  acceptedFacts: number;
  acceptedEvidence: number;
  /** The non-imputed signals ordered by dimension weight × sub-weight × value: the drivers a reader can trace to evidence. */
  drivers: Array<{ path: string; value: number; confidence: number; source: string; contribution: number }>;
  readiness: SignalReadiness[];
  scope: { sport: string | null; level: string | null; stage: string | null };
  versions: LoadedBeta1Params["versions"];
  sourceMode: string;
}

export async function loadStoredSocialFeatures(athleteId: string): Promise<StoredFeatureRow[]> {
  const feats = await db.select().from(socialFeatures).where(eq(socialFeatures.athlete_id, athleteId));
  return feats.map((f) => ({
    id: f.id, platform: f.platform, identityId: f.identity_id, featureKey: f.feature_key as StoredFeatureRow["featureKey"], value: f.value == null ? null : Number(f.value), valueJson: f.value_json,
    unit: f.unit, n: f.n, windowDays: f.window_days, asOf: f.as_of.toISOString(), sourceClass: f.source_class as StoredFeatureRow["sourceClass"], inputAccessClass: f.input_access_class as StoredFeatureRow["inputAccessClass"],
    confidence: Number(f.confidence), inputs: (f.inputs ?? {}) as Record<string, unknown>, calculationVersion: f.calculation_version,
  }));
}

export interface FactLike { id: string; factKey: string; value: Record<string, unknown>; status: string; confidence: number }
export interface EvidenceLike { id: string; kind: string; claim: Record<string, unknown>; lineageStatus: string; publishedAt: string | null; retrievedAt: string }
export interface Beta1ResearchInputs { facts: FactLike[]; evidence: EvidenceLike[] }

/** Canonical research inputs: registry facts (current/historical) and cited-equivalent, non-suspect, non-superseded evidence. */
export async function loadBeta1ResearchInputs(athleteId: string): Promise<Beta1ResearchInputs> {
  const facts = await db.select().from(athleteFacts).where(and(eq(athleteFacts.athlete_id, athleteId), inArray(athleteFacts.status, ["current", "historical"])));
  const evidence = await db.select().from(researchEvidence).where(and(eq(researchEvidence.athlete_id, athleteId), eq(researchEvidence.suspect, false), isNull(researchEvidence.superseded_by), inArray(researchEvidence.lineage_status, [...CITED_LINEAGES])));
  return {
    facts: facts.map((f) => ({ id: f.id, factKey: f.fact_key, value: (f.value ?? {}) as Record<string, unknown>, status: f.status, confidence: Number(f.confidence) })),
    evidence: evidence.map((e) => ({ id: e.id, kind: e.kind, claim: (e.claim ?? {}) as Record<string, unknown>, lineageStatus: e.lineage_status, publishedAt: e.published_at ? e.published_at.toISOString() : null, retrievedAt: e.retrieved_at.toISOString() })),
  };
}

/** Score one athlete. Returns null when the athlete has no canonical context (no athletes row). */
export async function scoreAthleteBeta1(athleteId: string, opts: { asOf?: Date; loaded?: LoadedBeta1Params } = {}): Promise<Beta1ScoreOutcome | null> {
  const loaded = opts.loaded ?? (await loadBeta1Params());
  const built = await buildCanonicalContext(athleteId);
  if (!built) return null;
  const ctx = built.ctx;
  const asOf = (opts.asOf ?? new Date()).toISOString();
  const stored = await loadStoredSocialFeatures(athleteId);
  const normalizer = createBeta1Normalizer(loaded.bundle);
  const researchInputs = await loadBeta1ResearchInputs(athleteId);
  const input = buildMarketabilityBeta1InputFromCanonical({ context: ctx, socialFeatures: stored, asOf }, normalizer, loaded.params);
  const result = computeMarketabilityBeta1(input, loaded.params);

  const signals: Array<{ dimension: string; key: string; s: NormalizedSignal }> = [];
  for (const [dimension, sigs] of Object.entries(input.dimensions)) for (const [key, s] of Object.entries(sigs)) signals.push({ dimension, key, s });
  const imputed = signals.filter((x) => x.s.imputed).length;
  const w = loaded.params.config;
  const drivers = signals.filter((x) => !x.s.imputed)
    .map((x) => ({ path: `${x.dimension}.${x.key}`, value: x.s.value, confidence: x.s.confidence, source: x.s.source, contribution: Math.round(x.s.value * (w.dimensionWeights as Record<string, number>)[x.dimension] * ((w.subWeights as Record<string, Record<string, number>>)[x.dimension]?.[x.key] ?? 0) * 100) / 100 }))
    .sort((a, b) => b.contribution - a.contribution);
  const weightOf = (dimension: string, key: string) => ((w.dimensionWeights as Record<string, number>)[dimension] ?? 0) * ((w.subWeights as Record<string, Record<string, number>>)[dimension]?.[key] ?? 0);
  const observedWeightedShare = Math.round(signals.filter((x) => !x.s.imputed).reduce((sum, x) => sum + weightOf(x.dimension, x.key), 0) * 1000) / 1000;
  const observedSignals = signals.filter((x) => !x.s.imputed).map((x) => ({ path: `${x.dimension}.${x.key}`, source: x.s.source, basis: null as string | null }));
  const scope = { sport: ctx.identity.sport?.value.sport ?? null, level: ctx.affiliations.level.segment ?? null, stage: ctx.identity.careerStatus.value.status ?? null };
  const readiness = normalizationReadiness(loaded.bundle, loaded.params, SOCIAL_FEATURE_KEYS, scope);
  return { athleteId, asOf, result, input, evidenceSignals: signals.length - imputed, imputedSignals: imputed, totalSignals: signals.length, observedWeightedShare, observedSignals, acceptedFacts: researchInputs.facts.length, acceptedEvidence: researchInputs.evidence.length, drivers, readiness, scope, versions: loaded.versions, sourceMode: ctx.sourceMode };
}
