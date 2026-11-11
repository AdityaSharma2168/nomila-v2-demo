import type { CanonicalAthleteContext } from "./intelligence/context/contract";
import type { FeatureRow } from "./intelligence/social/features";
import type { NormalizedSignal } from "./marketabilityBeta1";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "./marketabilityBeta1FrozenParams";
import {
  SOCIAL_FEATURE_KEYS,
  buildMarketabilityBeta1InputFromCanonical,
  inspectMarketabilityBeta1Evidence,
  type MarketabilityBeta1CanonicalSource,
  type MarketabilityBeta1Normalizer,
  type StoredFeatureRow,
} from "./marketabilityBeta1Canonical";
import { FEATURES } from "./intelligence/social/metrics";

function context(): CanonicalAthleteContext {
  return {
    contractVersion: "v1", athleteId: "athlete-1", builtAt: "2026-09-12T12:00:00.000Z", sourceMode: "canonical",
    coverage: {} as CanonicalAthleteContext["coverage"],
    identity: {
      name: {} as CanonicalAthleteContext["identity"]["name"], aliases: [],
      sport: { value: { sport: "Soccer" } } as CanonicalAthleteContext["identity"]["sport"], hometown: null, nationality: [],
      careerStatus: { value: { status: "active" } } as CanonicalAthleteContext["identity"]["careerStatus"],
      identityConfidence: 0.95, researchStatus: "research_complete", firstName: "A", photoUrl: null, createdAt: null,
    },
    affiliations: { current: null, all: [], level: { org: "Stanford", kind: "school", division: "D1", conference: "ACC", segment: "college", alsoNational: false }, teamsLine: null },
    profile: { position: null, classYear: null, graduationYear: null, event: [] }, achievements: [], press: [], brandMentions: [], nilMentions: [],
    inferences: { storyArc: null, sentiment: null, brandFitTags: null }, social: { handles: {}, connectionStatus: "active", connectedPlatforms: ["instagram"] },
    assertions: [], freshness: { byDomain: {}, researchAsOf: null }, commercial: { confirmedPartners: [], commercialState: "none" },
    audience: { gender: null, ageRange: null, topCity: null, geoCountry: [], share: null, sourceClass: "connected_verified", asOf: null, connected: false, platform: null },
    provenanceSummary: { canonicalFacts: 0, legacyFacts: 0, assertions: 0 },
  };
}

function feature(over: Partial<StoredFeatureRow> & Pick<FeatureRow, "featureKey" | "value">): StoredFeatureRow {
  // `over` always carries featureKey and value (Pick), so the defaults never name them: the spread supplies both.
  const defaults: Omit<StoredFeatureRow, "featureKey" | "value"> = {
    id: 1, platform: "instagram", identityId: "ig-1", valueJson: null,
    unit: "count", n: 10, windowDays: 30, asOf: "2026-09-12T10:00:00.000Z", sourceClass: "platform_public",
    inputAccessClass: "public_only", confidence: 0.8, inputs: { observationIds: [101, 102] }, calculationVersion: "v1",
  };
  return { ...defaults, ...over };
}

function signal(key: string, value: number, source: NormalizedSignal["source"] = "platform_public", imputed = false): NormalizedSignal {
  return {
    key, value, confidence: source === "imputed" ? 0.25 : 0.8, source,
    evidenceIds: source === "imputed" ? [] : [`e:${key}`], modelVersion: "test-normalizer-v1",
    asOf: "2026-09-12T12:00:00.000Z", imputed,
  };
}

const normalizer: MarketabilityBeta1Normalizer = {
  version: "test-normalizer-v1",
  normalize(evidence) {
    if (evidence.classified) return evidence.classified;
    if (!evidence.features.length) return null;
    return signal(evidence.path, Math.min(100, evidence.features.length * 10), evidence.features[0].sourceClass);
  },
  prior(path) { return signal(path, 50, "imputed", true); },
};

describe("marketability Beta.1 canonical adapter", () => {
  it("keeps public/private evidence separate, excludes future rows and exposes evidence lineage", () => {
    const rows: StoredFeatureRow[] = [
      feature({ id: 1, featureKey: "followers_latest", value: 1000, sourceClass: "platform_public", inputAccessClass: "public_only" }),
      feature({ id: 2, featureKey: "followers_latest", value: 1100, sourceClass: "connected_verified", inputAccessClass: "includes_athlete_private", inputs: { observationIds: [201] } }),
      feature({ id: 3, featureKey: "followers_latest", value: 900, platform: "youtube", identityId: "yt-1", sourceClass: "platform_public" }),
      feature({ id: 4, featureKey: "followers_latest", value: 9999, asOf: "2026-10-01T00:00:00.000Z", sourceClass: "connected_verified" }),
    ];
    const evidence = inspectMarketabilityBeta1Evidence({ context: context(), socialFeatures: rows, asOf: "2026-09-12T12:00:00.000Z" }, MARKETABILITY_BETA1_FROZEN_PARAMS);
    const audience = evidence.find((x) => x.path === "audience_scale.sport_level_audience_percentile")!;
    expect(audience.features).toHaveLength(3);
    expect(audience.inputAccessClasses.sort()).toEqual(["includes_athlete_private", "public_only"]);
    expect(audience.featureEvidence.map((x) => x.evidenceId).sort()).toEqual(["social_feature:1", "social_feature:2", "social_feature:3"]);
    expect(audience.observationIds.sort()).toEqual(["101", "102", "201"]);
  });

  it("maps only registered feature keys and uses the canonical cross-platform features", () => {
    for (const keys of Object.values(SOCIAL_FEATURE_KEYS)) {
      for (const key of keys ?? []) expect(FEATURES[key]).toBeDefined();
    }
    expect(SOCIAL_FEATURE_KEYS["audience_scale.cross_platform_effective_reach"]).toEqual(["effective_reach_cross_platform"]);
    expect(SOCIAL_FEATURE_KEYS["audience_scale.platform_breadth"]).toEqual(["platform_breadth"]);
    expect(SOCIAL_FEATURE_KEYS["momentum.audience_growth"]).toEqual(["followers_growth_pct"]);
  });

  it("uses priors for unknown signals rather than converting missing data to zero", () => {
    const input = buildMarketabilityBeta1InputFromCanonical({ context: context(), socialFeatures: [] }, normalizer, MARKETABILITY_BETA1_FROZEN_PARAMS);
    const story = input.dimensions.engagement_quality.story_efficiency;
    expect(story.value).toBe(50);
    expect(story.confidence).toBe(0.25);
    expect(story.source).toBe("imputed");
    expect(story.imputed).toBe(true);
    expect(story.modelVersion).toBe("test-normalizer-v1");
  });

  it("allows bounded classified evidence and labels audience-growth reuse in Momentum as secondary", () => {
    const classified = signal("brand_fit.brand_safety", 92, "web_researched");
    const source: MarketabilityBeta1CanonicalSource = {
      context: context(),
      socialFeatures: [feature({ featureKey: "followers_growth_pct", value: 12, unit: "percent" })],
      classifiedSignals: { "brand_fit.brand_safety": classified },
    };
    const evidence = inspectMarketabilityBeta1Evidence(source, MARKETABILITY_BETA1_FROZEN_PARAMS);
    expect(evidence.find((x) => x.path === "momentum.audience_growth")?.ownership).toBe("secondary");
    const input = buildMarketabilityBeta1InputFromCanonical(source, normalizer, MARKETABILITY_BETA1_FROZEN_PARAMS);
    expect(input.dimensions.brand_fit.brand_safety.value).toBe(92);
    expect(input.dimensions.audience_scale.audience_growth.value).toBe(10);
    expect(input.dimensions.momentum.audience_growth.value).toBe(10);
    expect(input.sourceMode).toBe("canonical");
  });
});
