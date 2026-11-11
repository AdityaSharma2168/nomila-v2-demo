/**
 * marketabilityBeta1Normalization.ts — the Beta.1 Signal Engine step that turns selected canonical evidence into
 * NormalizedSignal inputs (spec §6 conversion hierarchy, §8 priors, §21.1 ownership/freshness, §28 authority rule).
 *
 *   evidence (adapter) → freshness gate → authority pick → cohort percentile | categorical lookup → 0–100 + confidence
 *   nothing comparable                                   → prior by the §8 hierarchy (imputed; confidence from the prior table)
 *
 * Everything numeric is a PARAMETER supplied by the caller (cohort quantile tables, categorical lookups, prior tables,
 * confidence multipliers, the secondary-reuse cap, freshness days). This module ships NO values of its own: a signal
 * whose parameters are absent raises MissingParameterError naming the exact key, and `normalizationReadiness` lists
 * every such gap up front. Unknown is never zero; connected data replaces estimates (an accuracy event), it is never
 * a bonus; the frozen weights and mapping live in the engine and are not touched here.
 *
 * Pure: no DB, no network, no provider types. Shadow-only like the engine and the adapter.
 */

import type { InputAccessClass } from "./intelligence/social/features";
import type { FeatureKey } from "./intelligence/social/metrics";
import { MARKETABILITY_DIMENSIONS, type NormalizedSignal, type SourceClass } from "./intelligence/types";
import type { Beta1SignalPath, CanonicalSignalEvidence, MarketabilityBeta1Normalizer, StoredFeatureRow } from "./marketabilityBeta1Canonical";
import type { MarketabilityBeta1Params } from "./marketabilityBeta1";

export const MARKETABILITY_BETA1_NORMALIZER_VERSION = "marketability-beta1-normalizer-v1" as const;

// ─── Parameter contracts (versioned rows in model_params; which family holds each is decided outside this module) ──

export const COHORTS_SCHEMA_VERSION = "cohorts-config/1" as const;
export const PRIORS_SCHEMA_VERSION = "priors-config/1" as const;
export const LOOKUPS_SCHEMA_VERSION = "marketability-lookups/1" as const;
export const NORMALIZATION_POLICY_SCHEMA_VERSION = "marketability-normalization-policy/1" as const;

/** Cohort coordinates (spec §6): sport, competition level (LevelRecord.segment), career stage (CAREER_STATUSES slug), platform. null/absent = any. */
export interface CohortScope { sport?: string | null; level?: string | null; stage?: string | null; platform?: string | null }

/** The §8 hierarchy, most specific first. The ORDER is the spec's; every VALUE per level is a parameter. */
export const COHORT_HIERARCHY = ["sport_level_stage", "sport_level", "level", "global"] as const;
export type CohortHierarchyLevel = (typeof COHORT_HIERARCHY)[number];

export interface CohortPercentileTable {
  scope: CohortScope;
  featureKey: FeatureKey;
  /** The feature window the table was built from; null = any window. */
  windowDays?: number | null;
  /** Comparability (ADR-016): a table built from public-only observations must not rank private-inclusive rows, and vice versa. */
  accessClass: InputAccessClass | "any";
  /** Quantile points: p in [0,100] strictly increasing, value in feature units non-decreasing. At least two points. */
  quantiles: Array<{ p: number; value: number }>;
  /** Cohort size the table was estimated from. */
  n: number;
  asOf: string;
}
export interface CohortsConfig { version: string; schemaVersion: typeof COHORTS_SCHEMA_VERSION; tables: CohortPercentileTable[] }

export interface PriorEntry { scope: CohortScope; signal: Beta1SignalPath | "*"; value: number; confidence: number }
export interface PriorsConfig { version: string; schemaVersion: typeof PRIORS_SCHEMA_VERSION; entries: PriorEntry[] }

/** A bounded-taxonomy map (spec §6 categorical / AI-assisted classifications): category → 0–100, optional per-category confidence. */
export interface CategoricalLookup { signal: Beta1SignalPath; taxonomy: readonly string[]; values: Record<string, number>; confidence?: Record<string, number> }
export interface LookupsConfig { version: string; schemaVersion: typeof LOOKUPS_SCHEMA_VERSION; lookups: CategoricalLookup[] }

/** The treatments the spec leaves to calibration ("confidence penalties will be calibrated and versioned"). Required; no defaults. */
export interface NormalizationPolicy {
  version: string;
  schemaVersion: typeof NORMALIZATION_POLICY_SCHEMA_VERSION;
  confidence: {
    /** Multiplier on the evidence confidence by the hierarchy level the cohort table was found at. */
    cohortLevelMultiplier: Record<CohortHierarchyLevel, number>;
  };
  /** Secondary reuse of an evidence item in a second dimension is capped (spec §21.1): a 0–100 ceiling on the reused signal's value. */
  secondaryReuse: { valueCap: number };
  /** When a sub-signal maps to several feature keys: the first key with a current row AND a cohort table wins. Absent ⇒ the adapter's mapping order. */
  featurePreference: Partial<Record<Beta1SignalPath, readonly FeatureKey[]>>;
}

/** Days a feature row counts as CURRENT by source class — the substrate `signals.freshnessDays` table (spec §21.1 / §28). */
export type FreshnessDays = Partial<Record<SourceClass, number>>;

export interface NormalizationBundle {
  version?: string;
  cohorts: CohortsConfig;
  priors: PriorsConfig;
  lookups: LookupsConfig;
  policy: NormalizationPolicy;
  freshnessDays: FreshnessDays;
}

export class MissingParameterError extends Error {
  constructor(public readonly family: "cohorts" | "priors" | "lookups" | "policy" | "freshness", public readonly key: string, detail: string) {
    super(`missing ${family} parameter ${key}: ${detail}`);
    this.name = "MissingParameterError";
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────────────────────

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase() || null;
const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo);

function scopeFor(level: CohortHierarchyLevel, ctx: CohortScope): CohortScope {
  switch (level) {
    case "sport_level_stage": return { sport: ctx.sport, level: ctx.level, stage: ctx.stage, platform: ctx.platform };
    case "sport_level":       return { sport: ctx.sport, level: ctx.level, stage: null, platform: ctx.platform };
    case "level":             return { sport: null, level: ctx.level, stage: null, platform: ctx.platform };
    case "global":            return { sport: null, level: null, stage: null, platform: ctx.platform };
  }
}

function scopeMatches(table: CohortScope, want: CohortScope): boolean {
  return norm(table.sport) === norm(want.sport) && norm(table.level) === norm(want.level) && norm(table.stage) === norm(want.stage) && norm(table.platform) === norm(want.platform);
}

/** Linear interpolation of the percentile (0–100) of `value` on a monotone quantile table; clamps to the table's ends. */
export function percentileOf(quantiles: Array<{ p: number; value: number }>, value: number): number {
  const q = [...quantiles].sort((a, b) => a.p - b.p);
  if (q.length < 2) throw new Error("a cohort table needs at least two quantile points");
  for (let i = 1; i < q.length; i++) if (q[i].value < q[i - 1].value || q[i].p <= q[i - 1].p) throw new Error("cohort quantiles must be strictly increasing in p and non-decreasing in value");
  if (value <= q[0].value) return q[0].p;
  if (value >= q[q.length - 1].value) return q[q.length - 1].p;
  for (let i = 1; i < q.length; i++) {
    const a = q[i - 1], b = q[i];
    if (value <= b.value) return b.value === a.value ? b.p : a.p + ((value - a.value) / (b.value - a.value)) * (b.p - a.p);
  }
  return q[q.length - 1].p;
}

const SOURCE_RANK: Record<SourceClass, number> = { connected_verified: 5, platform_public: 4, web_researched: 3, inferred: 2, imputed: 1 };

/** A row is CURRENT when it is not newer than the as-of and no older than the source class's freshness window. */
function isCurrent(row: StoredFeatureRow, asOf: string, freshnessDays: FreshnessDays): boolean {
  const days = freshnessDays[row.sourceClass];
  if (days == null) throw new MissingParameterError("freshness", row.sourceClass, "no freshnessDays for this source class");
  const age = (new Date(asOf).getTime() - new Date(row.asOf).getTime()) / 86_400_000;
  return age >= 0 && age <= days;
}

function findTable(cohorts: CohortsConfig, ctx: CohortScope, row: StoredFeatureRow): { table: CohortPercentileTable; level: CohortHierarchyLevel } | null {
  for (const level of COHORT_HIERARCHY) {
    const want = scopeFor(level, { ...ctx, platform: row.platform ?? null });
    const table = cohorts.tables.find((t) =>
      t.featureKey === row.featureKey && scopeMatches(t.scope, want) &&
      (t.windowDays == null || t.windowDays === row.windowDays) &&
      (t.accessClass === "any" || t.accessClass === row.inputAccessClass));
    if (table) return { table, level };
  }
  return null;
}

function findPrior(priors: PriorsConfig, ctx: CohortScope, signal: Beta1SignalPath): { entry: PriorEntry; level: CohortHierarchyLevel } | null {
  for (const level of COHORT_HIERARCHY) {
    const want = scopeFor(level, { ...ctx, platform: null });
    // a signal-specific entry beats the wildcard at the same level; a more specific level beats a less specific one
    const entry = priors.entries.find((e) => e.signal === signal && scopeMatches(e.scope, want)) ?? priors.entries.find((e) => e.signal === "*" && scopeMatches(e.scope, want));
    if (entry) return { entry, level };
  }
  return null;
}

const modelVersionOf = (b: NormalizationBundle) =>
  `normalizer=${b.version ?? MARKETABILITY_BETA1_NORMALIZER_VERSION};cohorts=${b.cohorts.version};priors=${b.priors.version};lookups=${b.lookups.version};policy=${b.policy.version}`;

function evidenceIdsOf(rows: StoredFeatureRow[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.id != null) ids.add(`social_feature:${r.id}`);
    const raw = (r.inputs as { observationIds?: unknown } | null | undefined)?.observationIds;
    if (Array.isArray(raw)) for (const id of raw) if (typeof id === "string" || typeof id === "number") ids.add(`social_observation:${id}`);
  }
  return [...ids];
}

// ─── Validation ────────────────────────────────────────────────────────────────────────────────

export function validateNormalizationBundle(b: NormalizationBundle): void {
  if (b.cohorts.schemaVersion !== COHORTS_SCHEMA_VERSION) throw new Error(`cohorts schema ${b.cohorts.schemaVersion} is not ${COHORTS_SCHEMA_VERSION}`);
  if (b.priors.schemaVersion !== PRIORS_SCHEMA_VERSION) throw new Error(`priors schema ${b.priors.schemaVersion} is not ${PRIORS_SCHEMA_VERSION}`);
  if (b.lookups.schemaVersion !== LOOKUPS_SCHEMA_VERSION) throw new Error(`lookups schema ${b.lookups.schemaVersion} is not ${LOOKUPS_SCHEMA_VERSION}`);
  if (b.policy.schemaVersion !== NORMALIZATION_POLICY_SCHEMA_VERSION) throw new Error(`policy schema ${b.policy.schemaVersion} is not ${NORMALIZATION_POLICY_SCHEMA_VERSION}`);
  for (const level of COHORT_HIERARCHY) {
    const m = b.policy.confidence?.cohortLevelMultiplier?.[level];
    if (typeof m !== "number" || !(m >= 0 && m <= 1)) throw new MissingParameterError("policy", `confidence.cohortLevelMultiplier.${level}`, "must be a number in [0,1]");
  }
  const cap = b.policy.secondaryReuse?.valueCap;
  if (typeof cap !== "number" || !(cap >= 0 && cap <= 100)) throw new MissingParameterError("policy", "secondaryReuse.valueCap", "must be a number in [0,100]");
  for (const t of b.cohorts.tables) {
    percentileOf(t.quantiles, t.quantiles[0]?.value ?? 0);
    if (!(t.n > 0)) throw new Error(`cohort table ${t.featureKey} ${JSON.stringify(t.scope)} has no n`);
  }
  for (const p of b.priors.entries) {
    if (!(p.value >= 0 && p.value <= 100)) throw new Error(`prior ${p.signal} value out of range`);
    if (!(p.confidence >= 0 && p.confidence <= 1)) throw new Error(`prior ${p.signal} confidence out of range`);
  }
  for (const l of b.lookups.lookups) for (const c of l.taxonomy) {
    const v = l.values[c];
    if (typeof v !== "number" || !(v >= 0 && v <= 100)) throw new MissingParameterError("lookups", `${l.signal}.${c}`, "every taxonomy category needs a 0–100 value");
  }
}

/** A bounded classification (spec §6) → NormalizedSignal through the versioned lookup. The adapter's `classifiedSignals` are built with this. */
export function mapCategorical(bundle: NormalizationBundle, signal: Beta1SignalPath, category: string, i: { source: SourceClass; evidenceIds: string[]; asOf: string; confidence?: number }): NormalizedSignal {
  const lookup = bundle.lookups.lookups.find((l) => l.signal === signal);
  if (!lookup) throw new MissingParameterError("lookups", signal, "no categorical lookup for this signal");
  if (!lookup.taxonomy.includes(category)) throw new Error(`category "${category}" is outside the ${signal} taxonomy [${lookup.taxonomy.join(", ")}]`);
  const conf = i.confidence ?? lookup.confidence?.[category];
  if (conf == null) throw new MissingParameterError("lookups", `${signal}.confidence.${category}`, "no confidence for this category and none supplied with the classification");
  return { key: signal, value: clamp(lookup.values[category], 0, 100), confidence: clamp(conf, 0, 1), source: i.source, evidenceIds: i.evidenceIds, modelVersion: modelVersionOf(bundle), asOf: i.asOf, imputed: false };
}

// ─── The normalizer ────────────────────────────────────────────────────────────────────────────

export function createBeta1Normalizer(bundle: NormalizationBundle): MarketabilityBeta1Normalizer {
  validateNormalizationBundle(bundle);
  const version = modelVersionOf(bundle);

  const normalizeQuantitative = (e: CanonicalSignalEvidence): NormalizedSignal | null => {
    const ctx: CohortScope = { sport: e.context.sport, level: e.context.segment, stage: e.context.careerStatus, platform: null };
    const current = e.features.filter((r) => typeof r.value === "number" && Number.isFinite(r.value) && isCurrent(r, e.context.asOf, bundle.freshnessDays));
    if (!current.length) return null;
    const preference = bundle.policy.featurePreference[e.path] ?? [...new Set(current.map((r) => r.featureKey))];
    for (const key of preference) {
      // authority first (§28: connected_verified > platform_public > web_researched > …), then the freshest row
      const rows = current.filter((r) => r.featureKey === key)
        .sort((a, b) => SOURCE_RANK[b.sourceClass] - SOURCE_RANK[a.sourceClass] || new Date(b.asOf).getTime() - new Date(a.asOf).getTime());
      for (const row of rows) {
        const found = findTable(bundle.cohorts, ctx, row);
        if (!found) continue;
        let value = clamp(percentileOf(found.table.quantiles, row.value as number), 0, 100);
        if (e.ownership === "secondary") value = Math.min(value, bundle.policy.secondaryReuse.valueCap);
        return {
          key: e.path, value, confidence: clamp(row.confidence * bundle.policy.confidence.cohortLevelMultiplier[found.level], 0, 1),
          source: row.sourceClass, evidenceIds: evidenceIdsOf([row]), modelVersion: `${version};cohort=${found.level}`, asOf: row.asOf, imputed: false,
        };
      }
    }
    return null;   // current evidence, but no comparable cohort table: the readiness report names the gap; the caller falls back to the prior
  };

  return {
    version,
    normalize(e) {
      if (e.classified) {
        const c = e.classified;
        const value = e.ownership === "secondary" ? Math.min(clamp(c.value, 0, 100), bundle.policy.secondaryReuse.valueCap) : clamp(c.value, 0, 100);
        return { ...c, value, confidence: clamp(c.confidence, 0, 1), modelVersion: c.modelVersion || version };
      }
      return normalizeQuantitative(e);
    },
    prior(path, context) {
      const ctx: CohortScope = { sport: context.sport, level: context.segment, stage: context.careerStatus, platform: null };
      const found = findPrior(bundle.priors, ctx, path);
      if (!found) throw new MissingParameterError("priors", `${path}@${[ctx.sport, ctx.level, ctx.stage].map((v) => v ?? "*").join("/")}`, "no prior at any hierarchy level; unknown must not become zero");
      return { key: path, value: clamp(found.entry.value, 0, 100), confidence: clamp(found.entry.confidence, 0, 1), source: "imputed", evidenceIds: [], modelVersion: `${version};prior=${found.level}`, asOf: context.asOf, imputed: true };
    },
  };
}

// ─── Readiness: what the frozen tables must still supply ──────────────────────────────────────

export interface SignalReadiness {
  path: Beta1SignalPath;
  featureKeys: readonly FeatureKey[];
  cohortTables: number;
  lookup: boolean;
  prior: { present: boolean; level: CohortHierarchyLevel | null };
  /** quantitative = needs cohort tables; categorical = needs a lookup; unmapped = no evidence channel yet, only a prior can answer */
  kind: "quantitative" | "categorical" | "unmapped";
  ready: boolean;
  missing: string[];
}

export function normalizationReadiness(bundle: NormalizationBundle, params: MarketabilityBeta1Params, featureMap: Partial<Record<Beta1SignalPath, readonly FeatureKey[]>>, ctx: CohortScope): SignalReadiness[] {
  const out: SignalReadiness[] = [];
  for (const dimension of MARKETABILITY_DIMENSIONS) {
    for (const signal of Object.keys(params.config.subWeights[dimension])) {
      const path = `${dimension}.${signal}` as Beta1SignalPath;
      const keys = featureMap[path] ?? [];
      const lookup = bundle.lookups.lookups.some((l) => l.signal === path);
      const tables = bundle.cohorts.tables.filter((t) => keys.includes(t.featureKey) && COHORT_HIERARCHY.some((lvl) => scopeMatches(t.scope, scopeFor(lvl, { ...ctx, platform: t.scope.platform ?? null })))).length;
      const prior = findPrior(bundle.priors, ctx, path);
      const kind: SignalReadiness["kind"] = keys.length ? "quantitative" : lookup ? "categorical" : "unmapped";
      const missing: string[] = [];
      if (kind === "quantitative" && !tables) missing.push(`cohorts: no percentile table for ${keys.join("|")} at any hierarchy level for ${JSON.stringify(ctx)}`);
      if (kind === "unmapped") missing.push(`evidence: no feature mapping and no categorical lookup for ${path}`);
      if (!prior) missing.push(`priors: ${path}`);
      out.push({ path, featureKeys: keys, cohortTables: tables, lookup, prior: { present: !!prior, level: prior?.level ?? null }, kind, ready: missing.length === 0, missing });
    }
  }
  return out;
}
