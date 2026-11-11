/**
 * seedModelParams.ts — insert the reviewed DRAFT parameter rows for Phase A, by hand.
 *
 * Run: npx tsx --require dotenv/config server/scripts/seedModelParams.ts [--apply]
 *
 * Without --apply it prints what it would insert. With --apply it inserts DRAFT rows only,
 * idempotently (an existing (family, version) is left untouched). It never activates
 * anything: activation is a separate, reviewed act (see server/services/intelligence/README).
 * No deploy runs this; migrations stay pure DDL.
 *
 * Every value below is an ALPHA parameter transcribed from, or proposed against, the
 * Commercial Intelligence Beta.1 spec, and reviewed on 10 Sep 2026. Nothing reads these rows
 * until the engine that owns each family is built (Steps 1, 4, 5).
 */

import { insertDraftParams, type InsertDraftInput } from "../services/intelligence/params";

const APPLY = process.argv.includes("--apply");
const CREATED_BY = "seedModelParams.ts";

const DRAFTS: InsertDraftInput[] = [
  // ── Marketability v1.0-beta.1 — frozen weights, transcribed from spec §7 and §9 ─────────────
  {
    family: "marketability",
    version: "v1.0-beta.1",
    schemaVersion: "marketability-config/1",
    note: "Beta.1 frozen top-level and sub-weights (spec §7, §21.1). Mapping exponent is an alpha calibration parameter (§9).",
    createdBy: CREATED_BY,
    config: {
      status: "frozen",
      dimensionWeights: {
        athletic_authority: 0.15, audience_scale: 0.15, engagement_quality: 0.15, cultural_relevance: 0.10,
        narrative_power: 0.10, brand_fit: 0.10, commercial_proof: 0.15, momentum: 0.10,
      },
      subWeights: {
        athletic_authority: { competition_level: 0.25, performance_results: 0.25, rankings_recognition: 0.15, national_international_status: 0.15, role_importance: 0.10, achievement_recency: 0.10 },
        audience_scale:     { cross_platform_effective_reach: 0.50, sport_level_audience_percentile: 0.25, audience_growth: 0.15, platform_breadth: 0.10 },
        engagement_quality: { engagement_percentile: 0.30, reach_efficiency: 0.25, shares_saves_quality: 0.15, video_retention: 0.10, story_efficiency: 0.10, audience_authenticity: 0.10 },
        cultural_relevance: { media_volume_percentile: 0.30, media_source_quality: 0.20, search_interest: 0.20, social_conversation: 0.15, crossover_recognition: 0.15 },
        narrative_power:    { distinctiveness: 0.25, story_depth: 0.20, evidence_authenticity: 0.20, media_resonance: 0.15, commercial_applicability: 0.10, durability: 0.10 },
        brand_fit:          { category_breadth: 0.25, brand_safety: 0.20, audience_attractiveness: 0.20, identity_values_coherence: 0.15, content_versatility: 0.10, geographic_relevance: 0.10 },
        commercial_proof:   { verified_commercial_value: 0.30, deal_frequency: 0.20, brand_quality: 0.15, renewals_repeat: 0.15, campaign_performance: 0.10, pricing_power: 0.10 },
        momentum:           { athletic_trajectory: 0.30, audience_growth: 0.25, media_trajectory: 0.20, search_social_trajectory: 0.15, commercial_acceleration: 0.10 },
      },
      mapping: { kind: "power", max: 850, exponent: 0.8, alpha: true, note: "MIA = 850 × (composite/100)^0.8, rounded (§9). Exponent is a calibration parameter." },
    },
  },

  // ── Research freshness v0.1-alpha — decision 5, with the 30-day current press window ───────
  {
    family: "research_freshness",
    version: "v0.1-alpha",
    schemaVersion: "research-freshness-config/1",
    note: "Family TTLs (days) after which evidence stops counting as CURRENT for signal computation. Evidence is never deleted. Reviewed 10 Sep 2026.",
    createdBy: CREATED_BY,
    config: {
      unit: "days",
      families: {
        identity:            { currentDays: 365, note: "name, sport, teams, career status; athlete-asserted values override" },
        competition_level:   { currentDays: 180, note: "a season" },
        achievements:        { currentDays: null, historicalFact: true, note: "never expire; recency scored by the achievement_recency sub-signal" },
        press_mentions:      { currentDays: 30, historyDays: 90, note: "current media relevance is a ~30-day window; older press stays as historical evidence, accessible ~90d+ for reference" },
        brand_mentions:      { currentDays: 180, note: "public partnership evidence; older items feed renewals/repeat only" },
        narrative:           { currentDays: 180, note: "re-classify twice a year or on a research event" },
        search_interest:     { currentDays: 30, note: "Google Trends is already a 30-day average" },
        social_public:       { currentDays: 7, note: "superseded by connected data whenever present (§28.9)" },
        social_connected:    { currentDays: 2, note: "collected daily; two days tolerates a missed run" },
        commercial:          { currentDays: null, historicalFact: true, note: "validated deals and payments never expire; recency handled by the commercial_proof policy" },
      },
    },
  },

  // ── Signals v0.1-alpha — Step 1a substrate parameters (decisions D2, D6; design §5–6) ─────────
  // Read by getSubstrateParams ONLY when ACTIVE; until then the code defaults (identical values)
  // apply. Activating a later version changes retention, windows or freshness without a deploy.
  {
    family: "signals",
    version: "v0.1-alpha",
    schemaVersion: "signals-config/1",
    note: "Raw payload retention, feature windows and per-class freshness for the social substrate. Reviewed 10 Sep 2026 (D2, D6).",
    createdBy: CREATED_BY,
    config: {
      rawRetentionDays: { connected_verified: 180, platform_public: 90, web_researched: 90 },
      windows: { default: [30, 90], cadence: [7, 30, 90], growth: [7, 30, 90] },
      freshnessDays: { connected_verified: 2, platform_public: 7, web_researched: 30, imputed: 3650 },
      stories: { sweepHours: 8, lastLookHours: 22 },
      metricDefinitionVersion: "v1",
      featureCalculationVersion: "v1",
      sanitizerVersion: "v1",
    },
  },

  // ── Research policy v0.1-alpha — Step 2a source-type authority, corroboration, caps, retention ──
  // Read by getResearchPolicy ONLY when ACTIVE; the code defaults are identical. Domain lists are
  // infrastructure (which hosts are governing bodies, schools, major outlets), never athlete data.
  {
    family: "research_policy",
    version: "v0.1-alpha",
    schemaVersion: "research-policy-config/1",
    note: "Source-type authority tiers, corroboration threshold, uncited confidence cap, raw retention and domain caps for the research substrate (design §4.3, §6). Reviewed 11 Sep 2026.",
    createdBy: CREATED_BY,
    config: {
      rawRetentionDays: 90,
      uncitedConfidenceCap: 0.5,
      minCorroboration: 2,
      domains: { denyDomains: [], maxChunkChars: 4000, maxChunksPerRun: 200 },
      sourceTypeTiers: { official_governing_body: 1, official_team_or_school: 2, major_news: 3, reference: 4, regional_news: 5, athlete_authored_public: 6, aggregator_or_blog: 7, unknown: 8 },
      note: "sourceTypeDomains default to the code list in research/config.ts; override per type here when the list is reviewed",
    },
  },

  // ── Research freshness v0.2-alpha — Step 2b (D6): an explicit social_handles family ─────────
  // v0.1-alpha plus `social_handles` (365 d); every other value equals the code default, so
  // activation changes no TTL and proves the read path. Activation is a separate, reviewed act.
  {
    family: "research_freshness",
    version: "v0.2-alpha",
    schemaVersion: "research-freshness-config/1",
    note: "v0.1-alpha + explicit social_handles family (365 d initial TTL; design step2b §3, D6). Reviewed 11 Sep 2026.",
    createdBy: CREATED_BY,
    config: {
      unit: "days",
      families: {
        identity:            { currentDays: 365, note: "name, sport, teams, career status; athlete-asserted values override" },
        competition_level:   { currentDays: 180, note: "a season" },
        achievements:        { currentDays: null, historicalFact: true, note: "never expire; the planner rescans for NEW items every research_policy.planner.rescanDays.achievements" },
        press_mentions:      { currentDays: 30, historyDays: 90, note: "current media relevance is a ~30-day window; older press stays as historical evidence" },
        brand_mentions:      { currentDays: 180, note: "public partnership evidence; older items feed renewals/repeat only" },
        narrative:           { currentDays: 180, note: "re-classify twice a year or on any refresh that touches the athlete" },
        search_interest:     { currentDays: 30, note: "Google Trends is already a 30-day average" },
        social_handles:      { currentDays: 365, note: "public handles; superseded by a connection whenever one exists; identity cadence initially (D6)" },
        social_public:       { currentDays: 7, note: "public social METRICS; superseded by connected data whenever present (§28.9)" },
        social_connected:    { currentDays: 2, note: "collected daily; two days tolerates a missed run" },
        commercial:          { currentDays: null, historicalFact: true, note: "validated deals and payments never expire; recency handled by the commercial_proof policy" },
      },
    },
  },

  // ── Research policy v0.2-alpha — Step 2b planner caps and the provisional cost model ──────────
  // Call caps are the AUTHORITATIVE safety controls (counted attempts, retries included, reserved
  // atomically); the USD caps and costModel are PROVISIONAL until two weeks of measured dev runs.
  {
    family: "research_policy",
    version: "v0.2-alpha",
    schemaVersion: "research-policy-config/2",
    note: "v0.1-alpha + planner caps/cadences and the provisional cost model (design step2b §5, D3). Reviewed 11 Sep 2026.",
    createdBy: CREATED_BY,
    config: {
      rawRetentionDays: 90,
      uncitedConfidenceCap: 0.5,
      minCorroboration: 2,
      domains: { denyDomains: [], maxChunkChars: 4000, maxChunksPerRun: 200 },
      sourceTypeTiers: { official_governing_body: 1, official_team_or_school: 2, major_news: 3, reference: 4, regional_news: 5, athlete_authored_public: 6, aggregator_or_blog: 7, unknown: 8 },
      planner: {
        maxRunsPerNight: 25,
        maxLlmCallsPerNight: 150,      // AUTHORITATIVE: Gemini + Kimi attempts only, retries included
        maxCallsPerRun: 8,             // AUTHORITATIVE
        geminiRetryMax: 2,             // AUTHORITATIVE for planner runs
        retryAllowancePerRun: 2,
        maxUsdPerNight: 5.0,           // PROVISIONAL
        maxUsdPerRun: 0.6,             // PROVISIONAL
        maxRunsPerAthletePerDay: 1,
        maxSignalRunsPerNight: 200,
        maxOtherCallsPerNight: 400,
        rescanDays: { achievements: 90 },
        disputeRecheckDays: 30,
        maxDisputeRechecks: 3,
        failureDeferDays: 7,
        maxConsecutiveFailures: 3,
      },
      costModel: {
        // gemini-3.5-flash on Vertex global, verified 27 Oct 2026 (research/policy.ts DEFAULT_COST_MODEL; was 0.3 / 2.5).
        gemini_grounded: { perCallUsd: 0.035, perMTokInUsd: 1.5, perMTokOutUsd: 9.0 },
        kimi_extract: { perMTokInUsd: 0.6, perMTokOutUsd: 2.5 },
        google_trends: { perCallUsd: 0 },
        gdelt: { perCallUsd: 0 },
      },
      note: "sourceTypeDomains default to the code list in research/policy.ts; override per type here when the list is reviewed",
    },
  },

  // ── Identity policy v0.1-alpha — Step 2c Athlete Index matching (design §4.2–4.3) ─────────
  // MATCHING only: weights, floors and tiers say which athlete record a query probably is. Nothing
  // here authorizes a claim (claim proof is code, design §4.4). Read by getIdentityPolicy ONLY when
  // ACTIVE; the code defaults are identical. Activation is a separate, reviewed act.
  {
    family: "identity_policy",
    version: "v0.1-alpha",
    schemaVersion: "identity-policy-config/1",
    note: "Athlete Index match weights, name floor, auto_match/candidate thresholds and the runner-up gap (design step2c §4). Initial guardrails; tuned from athlete_index_matches after two weeks on dev. Reviewed 11 Sep 2026.",
    createdBy: CREATED_BY,
    config: {
      nameFloor: 0.35,
      weights: { name: 0.55, sport: 0.15, team: 0.15, year: 0.05, handle: 0.10 },
      teamKindWeight: { said: 1.0, proof: 1.0, found: 0.7 },
      teamCorroboration: 0.6,
      autoMatch: 0.90,
      candidate: 0.60,
      gap: 0.15,
      yearTolerance: 1,
    },
  },

  // ── Commercial proof v0.1-alpha — decision 4: validated sources only; caps deferred ─────────
  {
    family: "commercial_proof",
    version: "v0.1-alpha",
    schemaVersion: "commercial-proof-config/1",
    note: "Which deal evidence may contribute to the Commercial Proof dimension (spec §14). Caps deliberately NOT set: saturation is calibrated in Step 4 once cohort normalization exists. Reviewed 10 Sep 2026.",
    createdBy: CREATED_BY,
    config: {
      allowedSources: [
        { rule: "athlete_confirmed", where: "deals.source IN ('contract_upload','self_reported') AND deals.status IN ('accepted','completed')" },
        { rule: "confirmed_settlement", where: "deals.payment_status = 'settled' (money moved through payments), any source" },
        { rule: "contract_derived", where: "a deal_periods row exists for the deal (schedule extracted from an authoritative contract document)" },
      ],
      excluded: [
        { rule: "summarizer_inference", where: "deals.source = 'inbox_scan' with status advanced by threadSummarizer.deal_stage and no settlement", reason: "LLM inference that a deal appears accepted is not validation" },
        { rule: "research_brand_mentions", where: "athlete_snapshots.research.brand_mentions", reason: "signal ownership: public partnership mentions belong to cultural_relevance / brand_fit, never commercial_proof" },
        { rule: "open_pipeline", where: "deals.status IN ('detected','pending','negotiating')" },
      ],
      value: { field: "deals.amount", note: "total guaranteed value: cash + stated product; commission excluded (same rule snapshotDealsFor applies)" },
      recency: { fullWeightMonths: 24, halfWeightMonths: 48, halfWeightAppliesTo: ["renewals_repeat"], note: "recency handled in signals, not by deletion" },
      caps: { policy: "deferred", to: "Step 4 cohort normalization", note: "raw verified economics are preserved; no per-deal, annual or deal-count cap is set in this version" },
    },
  },
];

async function main() {
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${DRAFTS.length} draft parameter rows`);
  for (const d of DRAFTS) {
    if (!APPLY) { console.log(`  would insert ${d.family} ${d.version} (${d.schemaVersion})`); continue; }
    const r = await insertDraftParams(d);
    console.log(`  ${r.created ? "inserted" : "exists  "} ${d.family} ${d.version} status=${r.row.status} hash=${r.row.hash}`);
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
