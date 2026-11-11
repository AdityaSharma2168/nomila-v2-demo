/**
 * marketabilityBeta1Lookups.ts — the versioned draft parameter VALUES for Beta.1 (lookups, priors, policy, cohorts,
 * derived-class freshness). Pure data, no database import, so pure tests can read them. Seeded into model_params by
 * marketabilityBeta1Params.ts; every value is a global calibration parameter, never athlete-specific.
 */

import { COHORTS_SCHEMA_VERSION, LOOKUPS_SCHEMA_VERSION, NORMALIZATION_POLICY_SCHEMA_VERSION, PRIORS_SCHEMA_VERSION, type CohortsConfig, type LookupsConfig, type NormalizationPolicy, type PriorsConfig } from "./marketabilityBeta1Normalization";

// ─── v0 drafts for the first end-to-end pass (explicit placeholders; replaced by version during calibration) ───

export const BETA1_LOOKUPS_V0: LookupsConfig = {
  version: "lookups-v0", schemaVersion: LOOKUPS_SCHEMA_VERSION,
  lookups: [
    // L1 — competition level of the current affiliation (registry LEVELS enum). Values monotone by tier; unknown ⇒ prior, never zero.
    { signal: "athletic_authority.competition_level", taxonomy: ["international", "national", "pro", "conference", "regional", "school", "club", "other"], values: { international: 100, national: 90, pro: 85, conference: 65, regional: 50, school: 40, club: 30, other: 20 }, confidence: { international: 0.8, national: 0.8, pro: 0.8, conference: 0.7, regional: 0.6, school: 0.6, club: 0.6, other: 0.4 } },
    // L2 — national/international recognition (national_team_participation level / achievement level).
    { signal: "athletic_authority.national_international_status", taxonomy: ["international", "national", "pro", "conference", "regional", "school", "club", "other"], values: { international: 100, national: 85, pro: 60, conference: 45, regional: 35, school: 30, club: 25, other: 20 }, confidence: { international: 0.8, national: 0.8, pro: 0.6, conference: 0.5, regional: 0.5, school: 0.5, club: 0.5, other: 0.4 } },
    // L3 — media outlet context (press_mention.outletContext) for source quality.
    { signal: "cultural_relevance.media_source_quality", taxonomy: ["international", "national", "mainstream", "sport_specific", "regional", "local"], values: { international: 100, national: 90, mainstream: 85, sport_specific: 65, regional: 45, local: 35 }, confidence: { international: 0.7, national: 0.7, mainstream: 0.7, sport_specific: 0.6, regional: 0.6, local: 0.6 } },
    // L4 — role importance (affiliation.role, closed taxonomy).
    { signal: "athletic_authority.role_importance", taxonomy: ["captain", "co_captain", "starter", "key_player", "rotation", "bench", "redshirt", "unknown"], values: { captain: 100, co_captain: 90, starter: 75, key_player: 75, rotation: 55, bench: 35, redshirt: 30, unknown: 50 }, confidence: { captain: 0.6, co_captain: 0.6, starter: 0.6, key_player: 0.5, rotation: 0.5, bench: 0.5, redshirt: 0.5, unknown: 0.2 } },
    // L5 — reputation safety impact (S9 official findings / resolutions ONLY; reported allegations never read).
    { signal: "brand_fit.brand_safety", taxonomy: ["none", "official_finding_minor", "official_finding_major", "resolution_cleared", "resolution_upheld", "resolution_settled"], values: { none: 100, official_finding_minor: 70, official_finding_major: 40, resolution_cleared: 95, resolution_upheld: 45, resolution_settled: 60 }, confidence: { none: 0.6, official_finding_minor: 0.8, official_finding_major: 0.9, resolution_cleared: 0.8, resolution_upheld: 0.9, resolution_settled: 0.8 } },
  ],
};

/** Freshness windows (days) for DERIVED feature rows when the signals substrate defines none: inferred 30, imputed 3650 (the substrate v0.1-alpha defaults the readiness script used). */
export const BETA1_FRESHNESS_V0_DERIVED = { inferred: 30, imputed: 3650 } as const;

export const BETA1_POLICY_V0: NormalizationPolicy = {
  version: "policy-v0", schemaVersion: NORMALIZATION_POLICY_SCHEMA_VERSION,
  confidence: { cohortLevelMultiplier: { sport_level_stage: 1.0, sport_level: 0.9, level: 0.8, global: 0.7 } },
  secondaryReuse: { valueCap: 70 },
  featurePreference: {},
};

/** One neutral global prior for every sub-signal: value 50, low confidence. Missing data is never zero and never precise. */
export const BETA1_PRIORS_V0: PriorsConfig = { version: "priors-v0-neutral", schemaVersion: PRIORS_SCHEMA_VERSION, entries: [{ scope: {}, signal: "*", value: 50, confidence: 0.3 }] };

/**
 * v1 lookups (Slice E, founder-approved mapping 13 Sep 2026): the strongest confirmed closed-taxonomy state or a bounded
 * positive-evidence state. No count-based volume/frequency percentiles. Absence of evidence is never a category — it is
 * the prior. Values are global calibration parameters, never athlete-specific.
 */
export const BETA1_LOOKUPS_V1: LookupsConfig = {
  version: "lookups-v1", schemaVersion: LOOKUPS_SCHEMA_VERSION,
  lookups: [
    // competition level of the CURRENT affiliation from the registry's closed orgKind enum (affiliation `level` is free text and is not read)
    { signal: "athletic_authority.competition_level", taxonomy: ["olympic", "national", "pro", "club", "school"], values: { olympic: 100, national: 95, pro: 85, club: 50, school: 45 }, confidence: { olympic: 0.8, national: 0.8, pro: 0.8, club: 0.6, school: 0.6 } },
    // strongest confirmed achievement level within 24 months (registry LEVELS enum); international/national outrank conference/regional/school
    { signal: "athletic_authority.performance_results", taxonomy: ["international", "national", "pro", "conference", "regional", "school", "club", "other"], values: { international: 100, national: 88, pro: 80, conference: 65, regional: 50, school: 40, club: 35, other: 25 }, confidence: { international: 0.8, national: 0.8, pro: 0.7, conference: 0.7, regional: 0.6, school: 0.6, club: 0.6, other: 0.4 } },
    // strongest confirmed recognition within 24 months: closed scope token × rank bucket (top3 / top10 / ranked), awards by recognition level
    { signal: "athletic_authority.rankings_recognition",
      taxonomy: ["international_top3", "international_top10", "international_ranked", "national_top3", "national_top10", "national_ranked", "conference_top3", "conference_top10", "conference_ranked", "regional_top3", "regional_top10", "regional_ranked", "other_top3", "other_top10", "other_ranked", "award_international", "award_national", "award_pro", "award_conference", "award_regional", "award_school", "award_club", "award_other"],
      values: { international_top3: 100, international_top10: 95, international_ranked: 85, national_top3: 92, national_top10: 86, national_ranked: 78, conference_top3: 70, conference_top10: 62, conference_ranked: 55, regional_top3: 62, regional_top10: 55, regional_ranked: 48, other_top3: 60, other_top10: 52, other_ranked: 45, award_international: 95, award_national: 85, award_pro: 78, award_conference: 62, award_regional: 50, award_school: 40, award_club: 35, award_other: 25 },
      confidence: { international_top3: 0.8, international_top10: 0.8, international_ranked: 0.7, national_top3: 0.8, national_top10: 0.8, national_ranked: 0.7, conference_top3: 0.7, conference_top10: 0.7, conference_ranked: 0.6, regional_top3: 0.6, regional_top10: 0.6, regional_ranked: 0.6, other_top3: 0.5, other_top10: 0.5, other_ranked: 0.5, award_international: 0.8, award_national: 0.8, award_pro: 0.7, award_conference: 0.7, award_regional: 0.6, award_school: 0.6, award_club: 0.6, award_other: 0.4 } },
    // national/international recognition: international-level achievement/award, else national-team participation or a national-level honour
    { signal: "athletic_authority.national_international_status", taxonomy: ["international", "national"], values: { international: 100, national: 80 }, confidence: { international: 0.8, national: 0.7 } },
    // role of the current affiliation; closed tokens only, unknown ⇒ prior (never a low score)
    { signal: "athletic_authority.role_importance", taxonomy: ["captain", "co_captain", "starter", "key_player", "rotation", "bench", "redshirt"], values: { captain: 100, co_captain: 90, starter: 75, key_player: 75, rotation: 55, bench: 35, redshirt: 30 }, confidence: { captain: 0.6, co_captain: 0.6, starter: 0.6, key_player: 0.5, rotation: 0.5, bench: 0.5, redshirt: 0.5 } },
    // days since the most recent dated achievement/award/ranking (founder's steps); year-only dates count as 1 July
    { signal: "athletic_authority.achievement_recency", taxonomy: ["d0_90", "d91_180", "d181_365", "d366_730", "d_over_730"], values: { d0_90: 100, d91_180: 90, d181_365: 75, d366_730: 55, d_over_730: 35 }, confidence: { d0_90: 0.7, d91_180: 0.7, d181_365: 0.7, d366_730: 0.6, d_over_730: 0.6 } },
    // strongest confirmed press outlet context within 12 months (outletContext only; no outlet-name classifier)
    { signal: "cultural_relevance.media_source_quality", taxonomy: ["international", "national", "mainstream", "sport_specific", "regional", "local"], values: { international: 100, national: 90, mainstream: 85, sport_specific: 65, regional: 45, local: 35 }, confidence: { international: 0.7, national: 0.7, mainstream: 0.7, sport_specific: 0.6, regional: 0.6, local: 0.6 } },
    // bounded positive-evidence states (lack of retrieval ≠ zero ⇒ prior)
    { signal: "cultural_relevance.crossover_recognition", taxonomy: ["confirmed_one", "confirmed_multiple"], values: { confirmed_one: 60, confirmed_multiple: 85 }, confidence: { confirmed_one: 0.5, confirmed_multiple: 0.6 } },
    { signal: "brand_fit.content_versatility", taxonomy: ["confirmed_one", "confirmed_multiple"], values: { confirmed_one: 50, confirmed_multiple: 70 }, confidence: { confirmed_one: 0.5, confirmed_multiple: 0.6 } },
    // reputation: only official findings/actions or resolutions; reported allegations never read; no evidence ⇒ prior
    { signal: "brand_fit.brand_safety", taxonomy: ["official_finding", "resolution"], values: { official_finding: 55, resolution: 80 }, confidence: { official_finding: 0.8, resolution: 0.8 } },
    // bounded breadth of confirmed commercial categories (missing relationships never establish zero)
    { signal: "brand_fit.category_breadth", taxonomy: ["one_category", "two_categories", "three_plus_categories"], values: { one_category: 45, two_categories: 65, three_plus_categories: 85 }, confidence: { one_category: 0.5, two_categories: 0.5, three_plus_categories: 0.5 } },
    // bounded commercial-activity state at reduced confidence — never an exact real-world deal frequency
    { signal: "commercial_proof.deal_frequency", taxonomy: ["historical_confirmed_only", "one_recent_confirmed", "multiple_recent_confirmed"], values: { historical_confirmed_only: 45, one_recent_confirmed: 62, multiple_recent_confirmed: 78 }, confidence: { historical_confirmed_only: 0.4, one_recent_confirmed: 0.4, multiple_recent_confirmed: 0.4 } },
    { signal: "commercial_proof.renewals_repeat", taxonomy: ["confirmed_repeat"], values: { confirmed_repeat: 75 }, confidence: { confirmed_repeat: 0.5 } },
  ],
};

/** v1 priors: neutral 50 everywhere except brand_safety (global prior 85, confidence 0.4: most athletes carry no adverse record). Global, versioned, never per athlete. */
export const BETA1_PRIORS_V1: PriorsConfig = { version: "priors-v1", schemaVersion: PRIORS_SCHEMA_VERSION, entries: [{ scope: {}, signal: "*", value: 50, confidence: 0.3 }, { scope: {}, signal: "brand_fit.brand_safety", value: 85, confidence: 0.4 }] };

/** No cohort tables yet: every quantitative sub-signal falls to the prior until D3 tables are built from the 37-athlete cohort. */
export const BETA1_COHORTS_V0: CohortsConfig = { version: "cohorts-v0-empty", schemaVersion: COHORTS_SCHEMA_VERSION, tables: [] };

