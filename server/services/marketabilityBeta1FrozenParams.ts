/**
 * marketabilityBeta1FrozenParams.ts — the canonical frozen Beta.1 parameter artifact.
 *
 * THIS IS OPERATIONAL CONFIGURATION, NOT A TEST FIXTURE. It is the payload seeded into model_params and activated on
 * an environment, and it will eventually be the basis of production scoring. It lived in
 * marketabilityBeta1.testFixtures.ts until the Beta.1 dev activation, which is the wrong ownership model in a way
 * that matters: a file named for tests invites edits made for a test's convenience, and those edits would silently
 * become the parameters an athlete is scored by. The relationship runs the other way — these are the canonical
 * parameters, and the tests validate THEM.
 *
 * Production never imports this. Production loads the ACTIVE row from model_params via loadBeta1Params(), because the
 * parameters in force are a property of the environment, not of the deployed code. This module is what a seed writes
 * INTO the database and what the freeze gate checks the database against.
 *
 * DEPENDENCY-FREE BY DESIGN — a type import and nothing else. It deliberately does not live in
 * marketabilityBeta1Params.ts, whose loader reaches ../db through intelligence/params: putting the artifact there
 * would force every pure unit test that needs these values to boot a database module to read a constant.
 *
 * Changing anything here is a METHODOLOGY CHANGE. It bumps the version, invalidates the frozen goldens, and requires
 * re-running the 37-athlete development cohort. A version is immutable once seeded — insertDraftParams() refuses to
 * overwrite one with a different config hash, so an edit here without a version bump fails loudly at seed time rather
 * than quietly changing what an already-recorded assessment claimed to have been scored by.
 */
import type { MarketabilityBeta1Params } from "./marketabilityBeta1";

/**
 * Mirrors the reviewed Beta.1 draft parameter row; production callers load the row from model_params.
 *
 * v1.0.1-beta.1 (14 Sep 2026) adds `structurallyPrivate` and nothing else. The 44 sub-signals, every dimension weight and
 * sub-weight, and the 0–850 mapping are byte-identical to v1.0-beta.1 — the version bump exists because a missingness
 * rule changed, and a change to signals/weights/missingness/mapping always bumps the methodology version.
 */
export const MARKETABILITY_BETA1_FROZEN_PARAMS: MarketabilityBeta1Params = {
  version: "v1.0.1-beta.1",
  schemaVersion: "marketability-config/1",
  config: {
    status: "frozen",
    dimensionWeights: {
      athletic_authority: 0.15,
      audience_scale: 0.15,
      engagement_quality: 0.15,
      cultural_relevance: 0.10,
      narrative_power: 0.10,
      brand_fit: 0.10,
      commercial_proof: 0.15,
      momentum: 0.10,
    },
    subWeights: {
      athletic_authority: { competition_level: 0.25, performance_results: 0.25, rankings_recognition: 0.15, national_international_status: 0.15, role_importance: 0.10, achievement_recency: 0.10 },
      audience_scale: { cross_platform_effective_reach: 0.50, sport_level_audience_percentile: 0.25, audience_growth: 0.15, platform_breadth: 0.10 },
      engagement_quality: { engagement_percentile: 0.30, reach_efficiency: 0.25, shares_saves_quality: 0.15, video_retention: 0.10, story_efficiency: 0.10, audience_authenticity: 0.10 },
      cultural_relevance: { media_volume_percentile: 0.30, media_source_quality: 0.20, search_interest: 0.20, social_conversation: 0.15, crossover_recognition: 0.15 },
      narrative_power: { distinctiveness: 0.25, story_depth: 0.20, evidence_authenticity: 0.20, media_resonance: 0.15, commercial_applicability: 0.10, durability: 0.10 },
      brand_fit: { category_breadth: 0.25, brand_safety: 0.20, audience_attractiveness: 0.20, identity_values_coherence: 0.15, content_versatility: 0.10, geographic_relevance: 0.10 },
      commercial_proof: { verified_commercial_value: 0.30, deal_frequency: 0.20, brand_quality: 0.15, renewals_repeat: 0.15, campaign_performance: 0.10, pricing_power: 0.10 },
      momentum: { athletic_trajectory: 0.30, audience_growth: 0.25, media_trajectory: 0.20, search_social_trajectory: 0.15, commercial_acceleration: 0.10 },
    },
    mapping: { kind: "power", max: 850, exponent: 0.8, alpha: true },
    // Private by construction: unobservable without connected/private platform data, MISSING for every development-cohort
    // athlete bar one. Excluded from Engagement Quality while missing so 35% of the dimension does not sit at the neutral
    // prior for every unconnected athlete; dimension CONFIDENCE still falls. See marketabilityBeta1.ts and
    // server/scripts/calibration/analyzeEqPrivateMissingness.ts.
    structurallyPrivate: [
      "engagement_quality.shares_saves_quality",
      "engagement_quality.video_retention",
      "engagement_quality.story_efficiency",
    ],
  },
};
