/**
 * intelligence/types.ts — the canonical contracts of the Commercial Intelligence architecture.
 *
 * Transcribed from the Nomila Product & Intelligence Architecture Blueprint V1 / Commercial
 * Intelligence Beta.1 specification (§5, §6, §11, §12, §17, §22.3, §28.4). This file is TYPES
 * ONLY: it imports nothing and no runtime code lives here.
 *
 * ── THE BOUNDARY (LOCKED, spec §19 / §28.10) ─────────────────────────────────
 * Nothing under server/services/intelligence/ may import from server/lib/integrations/ or any
 * other provider module. Scoring consumes canonical, versioned signals and features; provider
 * response shapes never reach an engine. boundary.test.ts enforces it in CI.
 *
 * ── TWO VERSIONS, NEVER CONFLATED ────────────────────────────────────────────
 * A parameter SET has a `version` ('v1.0-beta.1'); the SHAPE of its config has a
 * `schemaVersion` ('marketability-config/1'). model_params carries both as columns.
 *
 * ── WHAT IS DELIBERATELY LEFT OPEN ───────────────────────────────────────────
 * MarketabilityTier is a string until the tier vocabulary and display policy are decided.
 * MarketabilityResult.potential is nullable and unpopulated until §17's field is defined.
 * Neither is a methodology decision this file may make.
 */

// ─── Parameter store ─────────────────────────────────────────────────────────

/** The closed list of parameter families. Lives here, not as a DB CHECK (see migration 0043). */
export const PARAM_FAMILIES = [
  "marketability",       // dimension weights, sub-weights, the 0–850 mapping
  "signals",             // categorical lookup tables and taxonomy → number maps (§6)
  "priors",              // the missing-data prior hierarchy (§8)
  "cohorts",             // sport × level × stage × platform percentile tables
  "research_freshness",  // signal-family TTLs (§21.1)
  "research_policy",     // source-type authority tiers, corroboration, caps, retention (Step 2a)
  "identity_policy",     // Athlete Index matching weights, floors and tiers (Step 2c) — matching only, never authorization
  "commercial_proof",    // allowed sources, recency window, caps (§14)
  "rates",               // benchmarks, factor tables, add-ons (§11)
  "opportunity",         // volume scenarios (§12)
  "earnings",            // scenario assembly (§12)
] as const;
export type ParamFamily = (typeof PARAM_FAMILIES)[number];

export const PARAM_STATUSES = ["draft", "active", "inactive", "archived"] as const;
export type ParamStatus = (typeof PARAM_STATUSES)[number];

// ─── Provenance ──────────────────────────────────────────────────────────────

/**
 * Where a value came from, in authority order (spec §28.9):
 *   connected_verified > platform_public > web_researched > imputed
 * `inferred` is a DERIVED interpretation — Nomila's own heuristic or a bounded AI
 * classification — and must reference the underlying evidence it was derived from. It is not
 * evidence provenance in itself and never outranks the evidence behind it.
 * (§17 uses a four-value set; it maps verified→connected_verified,
 * public→platform_public | web_researched, inferred→inferred, imputed→imputed.)
 */
export const SOURCE_CLASSES = ["connected_verified", "platform_public", "web_researched", "inferred", "imputed"] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

/** A reference to one evidence item, as every scored claim must carry (§5). */
export interface EvidenceRef {
  evidenceId:  string;
  sourceClass: SourceClass;
  /** ISO timestamp the evidence was observed / published. */
  observedAt:  string;
  /** 0–1. */
  confidence:  number;
}

// ─── Signals and marketability (§6, §7, §9, §17) ─────────────────────────────

export const MARKETABILITY_DIMENSIONS = [
  "athletic_authority",
  "audience_scale",
  "engagement_quality",
  "cultural_relevance",
  "narrative_power",
  "brand_fit",
  "commercial_proof",
  "momentum",
] as const;
export type MarketabilityDimension = (typeof MARKETABILITY_DIMENSIONS)[number];

/** Open until the tier vocabulary and display policy are decided. */
export type MarketabilityTier = string;

export interface NormalizedSignal {
  key:          string;
  /** 0–100. */
  value:        number;
  /** 0–1. */
  confidence:   number;
  source:       SourceClass;
  evidenceIds:  string[];
  /** The parameter-set version that produced this signal, e.g. 'signals=v1.0-beta.1'. */
  modelVersion: string;
  /** ISO timestamp the signal is current at. */
  asOf:         string;
  /** True when the value came from a prior rather than an observation. Unknown is never zero (§8). */
  imputed:      boolean;
}

export interface DimensionScore {
  dimension:    MarketabilityDimension;
  /** 0–100. */
  score:        number;
  /** Top-level weight applied. */
  weight:       number;
  /** score × weight. */
  contribution: number;
  signals:      NormalizedSignal[];
}

/** One attributable reason a score sits where it does or moved (§13 explanation graph). */
export interface Driver {
  signalKey: string;
  dimension: MarketabilityDimension;
  /** Points on the 0–850 scale attributable to this driver. */
  delta:     number;
  because:   string;
}

export interface MarketabilityResult {
  /** 0–850. */
  score:      number;
  /** 0–100 weighted composite before the calibration mapping. */
  composite:  number;
  /** §17 field with no definition yet; null until defined. */
  potential:  number | null;
  /** 0–100 Data Confidence — a separate metric from the score (LOCKED). */
  confidence: number;
  tier:       MarketabilityTier;
  dimensions: DimensionScore[];
  drivers:    Driver[];
  /** The parameter-set version(s), e.g. 'marketability=v1.0-beta.1'. */
  version:    string;
  asOf:       string;
}

// ─── Social observations (§22.3, §28.4) ──────────────────────────────────────

export const METRIC_ENTITY_TYPES = ["account", "content", "audience"] as const;
export type MetricEntityType = (typeof METRIC_ENTITY_TYPES)[number];

/** The canonical observation shape Step 1's tables persist. Providers map INTO this; engines read only this. */
export interface SocialMetricObservation {
  athleteId:         string;
  platform:          string;
  accountId:         string;
  entityType:        MetricEntityType;
  entityId:          string;
  /** e.g. followers | reach | views | shares | saves | reel_median_views. Named precisely (§28.6). */
  metricKey:         string;
  value:             number;
  unit:              string;
  sourceClass:       SourceClass;
  /** e.g. meta_business_discovery | youtube_data_api | oauth_insights. */
  provider:          string;
  observedAt:        string;
  windowStart?:      string;
  windowEnd?:        string;
  /** 0–1. */
  confidence:        number;
  /** Version of the metric definition, so a provider/API change never rewrites history. */
  definitionVersion: string;
  syncRunId:         string;
}

// ─── Rates, opportunity, earnings (§11, §12, §17) ────────────────────────────

export const DELIVERABLE_TYPES = [
  // social distribution
  "instagram_post", "instagram_reel", "instagram_story", "tiktok_video", "youtube_integration", "x_post",
  // brand content
  "ugc_video", "product_photography", "brand_photoshoot", "short_form_package", "long_form_video",
  // in person
  "appearance", "speaking", "meet_and_greet", "camp_clinic", "autograph_session",
  // long term
  "brand_ambassador", "season_partnership", "annual_partnership",
  // carried from the v3 rate card; has no home in §11's taxonomy yet (Step 5 decides)
  "licensing",
] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];

export const RATE_ADD_ONS = ["paid_media", "organic_usage", "whitelisting", "exclusivity", "extended_usage", "production", "travel"] as const;
export type RateAddOn = (typeof RATE_ADD_ONS)[number];

export interface RateEstimate {
  deliverable: DeliverableType;
  low:         number;
  expected:    number;
  high:        number;
  /** 0–1. */
  confidence:  number;
  assumptions: string[];
  drivers:     Driver[];
  version:     string;
  asOf:        string;
}

export interface OpportunityRange {
  conservative: number;
  expected:     number;
  upside:       number;
}

export interface EarningsPotential {
  conservative12m:       number;
  expected12m:           number;
  upside12m:             number;
  optimizedExpected12m?: number;
  /** 0–1. */
  confidence:            number;
  opportunityVolume:     OpportunityRange;
  assumptions:           string[];
  version:               string;
}
