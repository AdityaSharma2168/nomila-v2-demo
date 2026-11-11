/**
 * marketabilityBeta1Normalization.test.ts — the Beta.1 normalizer with SYNTHETIC parameter fixtures. Every number below is a
 * test value, not a frozen Beta.1 parameter: the real cohort tables, priors, lookups and policy are versioned rows that
 * do not exist yet (see the readiness test). The behaviour under test is the spec's: cohort percentile → lookup → prior,
 * freshness, authority, access-class comparability, secondary-reuse cap, provenance, and "unknown is never zero".
 */
import type { CanonicalAthleteContext } from "./intelligence/context/contract";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "./marketabilityBeta1FrozenParams";
import { buildMarketabilityBeta1InputFromCanonical, inspectMarketabilityBeta1Evidence, SOCIAL_FEATURE_KEYS, type StoredFeatureRow } from "./marketabilityBeta1Canonical";
import { computeMarketabilityBeta1 } from "./marketabilityBeta1";
import {
  COHORTS_SCHEMA_VERSION, LOOKUPS_SCHEMA_VERSION, MissingParameterError, NORMALIZATION_POLICY_SCHEMA_VERSION, PRIORS_SCHEMA_VERSION,
  createBeta1Normalizer, mapCategorical, normalizationReadiness, percentileOf, validateNormalizationBundle, type NormalizationBundle,
} from "./marketabilityBeta1Normalization";

const AS_OF = "2026-09-12T12:00:00.000Z";

function context(over: Partial<{ sport: string | null; segment: string | null; careerStatus: string; sourceMode: CanonicalAthleteContext["sourceMode"] }> = {}): CanonicalAthleteContext {
  return {
    contractVersion: "v1", athleteId: "athlete-1", builtAt: AS_OF, sourceMode: over.sourceMode ?? "canonical",
    coverage: {} as CanonicalAthleteContext["coverage"],
    identity: {
      name: {} as CanonicalAthleteContext["identity"]["name"], aliases: [],
      sport: over.sport === null ? null : ({ value: { sport: over.sport ?? "soccer" } } as CanonicalAthleteContext["identity"]["sport"]), hometown: null, nationality: [],
      careerStatus: { value: { status: over.careerStatus ?? "active" } } as CanonicalAthleteContext["identity"]["careerStatus"],
      identityConfidence: 0.95, researchStatus: "research_complete", firstName: "A", photoUrl: null, createdAt: null,
    },
    affiliations: { current: null, all: [], level: { org: "Stanford", kind: "school", division: "D1", conference: "ACC", segment: over.segment === undefined ? "college" : over.segment, alsoNational: false }, teamsLine: null },
    profile: { position: null, classYear: null, graduationYear: null, event: [] }, achievements: [], press: [], brandMentions: [], nilMentions: [],
    inferences: { storyArc: null, sentiment: null, brandFitTags: null }, social: { handles: {}, connectionStatus: "active", connectedPlatforms: ["instagram"] },
    assertions: [], freshness: { byDomain: {}, researchAsOf: null }, commercial: { confirmedPartners: [], commercialState: "none" },
    audience: { gender: null, ageRange: null, topCity: null, geoCountry: [], share: null, sourceClass: "connected_verified", asOf: null, connected: false, platform: null },
    provenanceSummary: { canonicalFacts: 0, legacyFacts: 0, assertions: 0 },
  };
}

function feature(over: Partial<StoredFeatureRow> & Pick<StoredFeatureRow, "featureKey" | "value">): StoredFeatureRow {
  const defaults: Omit<StoredFeatureRow, "featureKey" | "value"> = {
    id: 1, platform: "instagram", identityId: "ig-1", valueJson: null, unit: "count", n: 10, windowDays: 30, asOf: "2026-09-12T10:00:00.000Z",
    sourceClass: "platform_public", inputAccessClass: "public_only", confidence: 0.8, inputs: { observationIds: [101] }, calculationVersion: "v1",
  };
  return { ...defaults, ...over };
}

/** TEST-ONLY parameters. */
function bundle(over: Partial<NormalizationBundle> = {}): NormalizationBundle {
  return {
    cohorts: {
      version: "test-cohorts", schemaVersion: COHORTS_SCHEMA_VERSION, tables: [
        { scope: { sport: "soccer", level: "college", stage: "active", platform: "instagram" }, featureKey: "followers_latest", windowDays: null, accessClass: "public_only", n: 40, asOf: AS_OF,
          quantiles: [{ p: 0, value: 100 }, { p: 50, value: 1000 }, { p: 90, value: 10000 }, { p: 100, value: 100000 }] },
        { scope: { sport: null, level: "college", stage: null, platform: "instagram" }, featureKey: "followers_latest", windowDays: null, accessClass: "includes_athlete_private", n: 60, asOf: AS_OF,
          quantiles: [{ p: 0, value: 50 }, { p: 100, value: 50000 }] },
        { scope: { sport: null, level: null, stage: null, platform: null }, featureKey: "effective_reach_cross_platform", windowDays: 30, accessClass: "any", n: 200, asOf: AS_OF,   // cross-platform rows carry platform null
          quantiles: [{ p: 0, value: 0 }, { p: 100, value: 2_000_000 }] },
        { scope: { sport: null, level: null, stage: null, platform: "instagram" }, featureKey: "followers_growth_pct", windowDays: 30, accessClass: "any", n: 200, asOf: AS_OF,
          quantiles: [{ p: 0, value: -50 }, { p: 50, value: 0 }, { p: 100, value: 50 }] },
      ],
    },
    priors: {
      version: "test-priors", schemaVersion: PRIORS_SCHEMA_VERSION, entries: [
        { scope: { sport: "soccer", level: "college", stage: "active" }, signal: "engagement_quality.story_efficiency", value: 61, confidence: 0.3 },
        { scope: { sport: "soccer", level: "college" }, signal: "*", value: 45, confidence: 0.25 },
        { scope: {}, signal: "*", value: 40, confidence: 0.2 },
      ],
    },
    lookups: {
      version: "test-lookups", schemaVersion: LOOKUPS_SCHEMA_VERSION, lookups: [
        { signal: "brand_fit.brand_safety", taxonomy: ["very_low", "low", "moderate", "high", "very_high"], values: { very_low: 5, low: 25, moderate: 50, high: 75, very_high: 95 }, confidence: { very_low: 0.6, low: 0.6, moderate: 0.6, high: 0.6, very_high: 0.6 } },
      ],
    },
    policy: {
      version: "test-policy", schemaVersion: NORMALIZATION_POLICY_SCHEMA_VERSION,
      confidence: { cohortLevelMultiplier: { sport_level_stage: 1, sport_level: 0.9, level: 0.8, global: 0.6 } },
      secondaryReuse: { valueCap: 60 },
      featurePreference: {},
    },
    freshnessDays: { connected_verified: 2, platform_public: 7, web_researched: 30, inferred: 30, imputed: 3650 },
    ...over,
  };
}

describe("percentileOf", () => {
  it("interpolates linearly, clamps at the ends and rejects non-monotone tables", () => {
    const q = [{ p: 0, value: 100 }, { p: 50, value: 1000 }, { p: 100, value: 10000 }];
    expect(percentileOf(q, 100)).toBe(0); expect(percentileOf(q, 1000)).toBe(50); expect(percentileOf(q, 10000)).toBe(100);
    expect(percentileOf(q, 550)).toBe(25); expect(percentileOf(q, 5500)).toBe(75);
    expect(percentileOf(q, 1)).toBe(0); expect(percentileOf(q, 1e9)).toBe(100);
    expect(() => percentileOf([{ p: 0, value: 1 }], 1)).toThrow(/two quantile/);
    expect(() => percentileOf([{ p: 0, value: 10 }, { p: 50, value: 5 }, { p: 100, value: 20 }], 7)).toThrow(/monotone|increasing|non-decreasing/);
  });
});

describe("normalizer — cohort percentile, hierarchy, access class, authority, freshness", () => {
  it("normalizes a current public row against the most specific cohort table and carries provenance", () => {
    const n = createBeta1Normalizer(bundle());
    const src = { context: context(), socialFeatures: [feature({ id: 7, featureKey: "followers_latest", value: 5500, windowDays: 0 })], asOf: AS_OF };
    const input = buildMarketabilityBeta1InputFromCanonical(src, n, MARKETABILITY_BETA1_FROZEN_PARAMS);
    const s = input.dimensions.audience_scale.sport_level_audience_percentile;
    expect(s.value).toBe(70); expect(s.imputed).toBe(false); expect(s.source).toBe("platform_public");   // 5500 sits 4500/9000 of the way from p50 (1000) to p90 (10000)
    expect(s.confidence).toBe(0.8);                       // 0.8 × multiplier 1 at sport_level_stage
    expect(s.evidenceIds).toEqual(["social_feature:7", "social_observation:101"]);
    expect(s.modelVersion).toMatch(/^normalizer=.*cohorts=test-cohorts.*;cohort=sport_level_stage$/);
    expect(s.asOf).toBe("2026-09-12T10:00:00.000Z");
  });

  it("keeps access classes separate: a private-inclusive row is ranked on the private table (level fallback), never on the public one", () => {
    const n = createBeta1Normalizer(bundle());
    const rows = [
      feature({ id: 1, featureKey: "followers_latest", value: 5500, windowDays: 0, sourceClass: "platform_public", inputAccessClass: "public_only" }),
      feature({ id: 2, featureKey: "followers_latest", value: 5500, windowDays: 0, sourceClass: "connected_verified", inputAccessClass: "includes_athlete_private", asOf: "2026-09-12T11:00:00.000Z" }),
    ];
    const input = buildMarketabilityBeta1InputFromCanonical({ context: context(), socialFeatures: rows, asOf: AS_OF }, n, MARKETABILITY_BETA1_FROZEN_PARAMS);
    const s = input.dimensions.audience_scale.sport_level_audience_percentile;
    // authority picks the connected row; its only comparable table is the level-scoped private one: (5500-50)/(50000-50) ≈ 10.9
    expect(s.source).toBe("connected_verified"); expect(s.value).toBeCloseTo(10.91, 1); expect(s.evidenceIds).toContain("social_feature:2");
    expect(s.confidence).toBeCloseTo(0.8 * 0.8, 5);      // level-fallback multiplier — connected data raised authority, not the value
    expect(s.modelVersion).toMatch(/cohort=level$/);
  });

  it("stale rows are not current: they fall to the prior (imputed, lower confidence) instead of zero", () => {
    const n = createBeta1Normalizer(bundle());
    const rows = [feature({ featureKey: "followers_latest", value: 5500, windowDays: 0, asOf: "2026-08-01T00:00:00.000Z" })];   // 42 days old, public freshness 7 d
    const input = buildMarketabilityBeta1InputFromCanonical({ context: context(), socialFeatures: rows, asOf: AS_OF }, n, MARKETABILITY_BETA1_FROZEN_PARAMS);
    const s = input.dimensions.audience_scale.sport_level_audience_percentile;
    expect(s).toMatchObject({ value: 45, confidence: 0.25, source: "imputed", imputed: true, evidenceIds: [], asOf: AS_OF });
    expect(s.modelVersion).toMatch(/prior=sport_level$/);
  });

  it("priors follow the §8 hierarchy: signal-specific at sport+level+stage, then sport+level wildcard, then global; none ⇒ MissingParameterError, never zero", () => {
    const n = createBeta1Normalizer(bundle());
    const ctx = { sport: "soccer", segment: "college", careerStatus: "active", sourceMode: "canonical" as const, asOf: AS_OF };
    expect(n.prior("engagement_quality.story_efficiency", ctx)).toMatchObject({ value: 61, confidence: 0.3, imputed: true });
    expect(n.prior("engagement_quality.audience_authenticity", ctx)).toMatchObject({ value: 45, confidence: 0.25 });
    expect(n.prior("engagement_quality.audience_authenticity", { ...ctx, sport: "tennis", segment: "pro" })).toMatchObject({ value: 40, confidence: 0.2 });
    const none = createBeta1Normalizer(bundle({ priors: { version: "empty", schemaVersion: PRIORS_SCHEMA_VERSION, entries: [] } }));
    expect(() => none.prior("engagement_quality.audience_authenticity", ctx)).toThrow(MissingParameterError);
    expect(() => none.prior("engagement_quality.audience_authenticity", ctx)).toThrow(/soccer\/college\/active/);
  });

  it("current evidence without a comparable cohort table is not normalized (null) — the caller falls back to the prior", () => {
    const n = createBeta1Normalizer(bundle());
    const ev = inspectMarketabilityBeta1Evidence({ context: context({ segment: "pro" }), socialFeatures: [feature({ featureKey: "followers_latest", value: 5500, windowDays: 0 })], asOf: AS_OF }, MARKETABILITY_BETA1_FROZEN_PARAMS)
      .find((x) => x.path === "audience_scale.sport_level_audience_percentile")!;
    expect(ev.features).toHaveLength(1);
    expect(n.normalize(ev)).toBeNull();
  });

  it("secondary reuse is capped by policy (momentum.audience_growth), the primary use is not", () => {
    const n = createBeta1Normalizer(bundle());
    const rows = [feature({ featureKey: "followers_growth_pct", value: 40, windowDays: 30, unit: "percent" })];   // p = 90 on the global growth table
    const input = buildMarketabilityBeta1InputFromCanonical({ context: context(), socialFeatures: rows, asOf: AS_OF }, n, MARKETABILITY_BETA1_FROZEN_PARAMS);
    expect(input.dimensions.audience_scale.audience_growth.value).toBe(90);
    expect(input.dimensions.momentum.audience_growth.value).toBe(60);
  });

  it("a cross-platform feature uses the cross scope; the engine scores the assembled input without the frozen weights changing", () => {
    const n = createBeta1Normalizer(bundle());
    const rows = [feature({ featureKey: "effective_reach_cross_platform", value: 500_000, platform: null, identityId: null, windowDays: 30 })];
    const input = buildMarketabilityBeta1InputFromCanonical({ context: context(), socialFeatures: rows, asOf: AS_OF }, n, MARKETABILITY_BETA1_FROZEN_PARAMS);
    expect(input.dimensions.audience_scale.cross_platform_effective_reach.value).toBe(25);
    const result = computeMarketabilityBeta1(input, MARKETABILITY_BETA1_FROZEN_PARAMS);
    expect(result.version).toBe("v1.0.1-beta.1"); expect(result.provenance.sourceMode).toBe("canonical");
    expect(result.dimensions.find((d) => d.dimension === "audience_scale")!.signals.find((s) => s.key === "audience_scale.cross_platform_effective_reach")!.imputed).toBe(false);
  });

  it("a missing freshness window for a source class is a parameter error, not a silent pass", () => {
    const n = createBeta1Normalizer(bundle({ freshnessDays: { platform_public: 7 } }));
    const ev = inspectMarketabilityBeta1Evidence({ context: context(), socialFeatures: [feature({ featureKey: "followers_latest", value: 5500, windowDays: 0, sourceClass: "connected_verified", inputAccessClass: "includes_athlete_private" })], asOf: AS_OF }, MARKETABILITY_BETA1_FROZEN_PARAMS)
      .find((x) => x.path === "audience_scale.sport_level_audience_percentile")!;
    expect(() => n.normalize(ev)).toThrow(MissingParameterError);
  });
});

describe("categorical lookups", () => {
  it("maps a bounded classification deterministically and rejects categories outside the taxonomy", () => {
    const b = bundle();
    const s = mapCategorical(b, "brand_fit.brand_safety", "high", { source: "web_researched", evidenceIds: ["research_evidence:9"], asOf: AS_OF });
    expect(s).toMatchObject({ key: "brand_fit.brand_safety", value: 75, confidence: 0.6, source: "web_researched", imputed: false, evidenceIds: ["research_evidence:9"] });
    expect(() => mapCategorical(b, "brand_fit.brand_safety", "excellent", { source: "web_researched", evidenceIds: [], asOf: AS_OF })).toThrow(/outside the .* taxonomy/);
    expect(() => mapCategorical(b, "brand_fit.category_breadth", "high", { source: "web_researched", evidenceIds: [], asOf: AS_OF })).toThrow(MissingParameterError);
  });
});

describe("bundle validation and readiness", () => {
  it("refuses a policy without the calibrated multipliers or the reuse cap, and a lookup with an unvalued category", () => {
    const b = bundle();
    expect(() => validateNormalizationBundle({ ...b, policy: { ...b.policy, confidence: { cohortLevelMultiplier: { sport_level_stage: 1, sport_level: 1, level: 1 } as any } } })).toThrow(/cohortLevelMultiplier.global/);
    expect(() => validateNormalizationBundle({ ...b, policy: { ...b.policy, secondaryReuse: { valueCap: 120 } } })).toThrow(/secondaryReuse.valueCap/);
    expect(() => validateNormalizationBundle({ ...b, lookups: { ...b.lookups, lookups: [{ signal: "brand_fit.brand_safety", taxonomy: ["low", "high"], values: { low: 10 } }] } })).toThrow(/brand_fit.brand_safety.high/);
  });

  it("readiness names every gap: unmapped signals, quantitative signals without a cohort table, missing priors", () => {
    const r = normalizationReadiness(bundle(), MARKETABILITY_BETA1_FROZEN_PARAMS, SOCIAL_FEATURE_KEYS, { sport: "soccer", level: "college", stage: "active" });
    expect(r).toHaveLength(44);
    const byPath = new Map(r.map((x) => [x.path, x]));
    expect(byPath.get("audience_scale.sport_level_audience_percentile")).toMatchObject({ kind: "quantitative", cohortTables: 2, ready: true });
    expect(byPath.get("engagement_quality.engagement_percentile")).toMatchObject({ kind: "quantitative", cohortTables: 0, ready: false });
    expect(byPath.get("engagement_quality.engagement_percentile")!.missing[0]).toMatch(/^cohorts: no percentile table/);
    expect(byPath.get("brand_fit.brand_safety")).toMatchObject({ kind: "categorical", lookup: true, ready: true });
    expect(byPath.get("athletic_authority.competition_level")).toMatchObject({ kind: "unmapped", ready: false });
    // with an empty bundle nothing is ready and every signal lists its prior as missing
    const empty = normalizationReadiness(bundle({ cohorts: { version: "e", schemaVersion: COHORTS_SCHEMA_VERSION, tables: [] }, priors: { version: "e", schemaVersion: PRIORS_SCHEMA_VERSION, entries: [] }, lookups: { version: "e", schemaVersion: LOOKUPS_SCHEMA_VERSION, lookups: [] } }), MARKETABILITY_BETA1_FROZEN_PARAMS, SOCIAL_FEATURE_KEYS, {});
    expect(empty.every((x) => !x.ready && x.missing.some((m) => m.startsWith("priors:")))).toBe(true);
  });
});
