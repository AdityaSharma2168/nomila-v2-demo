# Step 4 — M.I.A. Beta.1 Signal Mapping

Status: **WITHDRAWN — 14 Sep 2026.** Kept as the historical record of an approach that was tried and abandoned, not as a
live proposal. The deterministic mappings below were implemented and then removed before reaching main: scored against the
37-athlete development cohort they reached a Spearman of 0.08, where the rubric-constrained M.I.A. evaluator reaches 0.889
on the same athletes. Interpreting research evidence into a 0–100 qualitative judgement is the evaluator's job; the
deterministic engine keeps the arithmetic and the versioned priors. The central methodological rule below (a retrieval
count is not a real-world volume) survives the withdrawal and still binds any future mapping work.

Previously: **APPROVED WITH REVISIONS — 13 Sep 2026.** This was the record of what Slice E implemented (`server/services/marketabilityBeta1ResearchSignals.ts`, version `beta1-research-signals/1`) against Beta.1's frozen dimensions/weights/0–850 mapping (`beta1.md` §7, §9, §21 — unchanged, not reopened here). It supersedes the D1 proposal circulated for this review: the founder narrowed the mapping considerably before any of it shipped. No new sub-signal keys are invented; every row still maps to `factRegistry.ts` v2, `itemMapping.ts` item-mapping/2, and `researchSpecV1.ts` research-spec/1, or says plainly that the sub-signal stays on its versioned prior.

## Central methodological rule (founder, 13 Sep 2026)

> A **count** of facts/evidence returned by Gemini research is **not** a real-world volume/frequency measure. Search retrieval is not exhaustive. **No sub-signal below percentiles a raw research-return count** for media volume, deal frequency, crossover volume, momentum, or any other "how much / how often" question — unless the acquisition contract is later shown to establish a sufficiently complete bounded observation (not true today).

Every **OBSERVED** row below is either (a) a closed-taxonomy state of the *strongest confirmed evidence* — a rank bucket, an achievement level, a recency step, an outlet context — or (b) a *bounded positive-evidence state* at reduced confidence ("one" vs "multiple"; "historical" vs "one recent" vs "multiple recent"). Lack of retrieval is never a zero or a negative state — it falls to the prior. None of the thirteen sub-signals shipped in Slice E is a percentile of a retrieved-row count. This rule is why the D1 draft's `performance_results`, `media_volume_percentile`, `social_conversation`, `category_breadth`, `deal_frequency`, `renewals_repeat`, and every Momentum trend sub-signal changed shape or moved to prior-only.

## Scope

- Covers all 44 Beta.1 sub-signals. **10** are already sourced by `SOCIAL_FEATURE_KEYS` (`marketabilityBeta1Canonical.ts`) — untouched, unchanged from the D1 draft. **13** are now **OBSERVED**, deterministically derived from canonical research facts/evidence by Slice E. The remaining **21** stay on the versioned prior (`priors-v1`) — some by explicit founder decision (Narrative Power, in full), some because no research source exists at all (`verified_commercial_value`), some because a count-based approach was rejected under the central rule above (`media_volume_percentile`, `social_conversation`).
- Every OBSERVED signal is deterministic: a closed, versioned lookup (`marketability-lookups/1`, `BETA1_LOOKUPS_V1` in `marketabilityBeta1Params.ts`); nothing here asks an LLM to judge a score.
- Hard constraints carried through every row:
  - **Audience follower counts**: web-researched follower/engagement counts are never a quantitative Audience/Engagement/Momentum input; `social_metric_claim` evidence (item `follower_counts_as_stated`) is excluded from every row in this document. Authority for any social observable stays `connected_verified` > `platform_public` > `web_researched` > `prior` (§28.9).
  - **Cohort construction**: the 37-athlete dev-cohort percentile machinery (`COHORT_HIERARCHY`, min N = 8, holdout never contributes) is retained for future percentile-shaped signals, but **no OBSERVED sub-signal in Slice E uses it** — the central rule above replaced every percentile-of-a-count with a closed-taxonomy state or a bounded evidence state instead. `BETA1_COHORTS_V1` stays empty tables for now.
  - **Anti-double-counting**: one underlying observation feeds at most one **primary** sub-signal. With every count-based secondary-reuse candidate from the D1 draft (`media_resonance`, `durability`, `athletic_trajectory`, `media_trajectory`, `commercial_acceleration`) now prior-only, the live secondary-reuse pairs in Slice E are: `role_importance` reading the current-`affiliation` row `competition_level` owns primary (field `role`, not `orgKind`); `renewals_repeat` reading `endorsement` rows `deal_frequency`/`category_breadth` own primary (distinct statistic: repeat-brand evidence); and `content_versatility` reading `crossover_appearance` rows `crossover_recognition` owns primary (distinct statistic: format count, unioned with `content_formats` findings).
  - **S9 reputation**: evidence may only *reduce* `brand_safety`, and only via `official_finding_or_action` (55) or `resolution_or_outcome` (80) stage reputation_event rows — never `reported_allegation` alone (`researchSpecV1.ts` S9; `beta1.md` §21.1). No qualifying row ⇒ the versioned global prior (`priors-v1`: 85, confidence 0.4), not zero.
  - **Commercial proof**: a web-researched `endorsement` fact is a researched relationship, not verified commercial value. Bounded-state uses of `endorsement` facts are allowed at reduced confidence; dollar-value claims (`nil_mention`, `published_values`) are excluded from Commercial Proof entirely.
  - **Missing data**: never zero. Falls to the prior at the most specific cohort level available (or the flat global prior where no cohort applies), with reduced confidence.

Table columns (unchanged from D1): **sub-signal** | **source facts/evidence** | **deterministic transformation / lookup** | **freshness** | **confidence behaviour** | **missing-data prior** | **anti-double-counting**.

### Reference — the 10 sub-signals already sourced (untouched)

| Sub-signal | Source `FeatureKey`(s) (`SOCIAL_FEATURE_KEYS`) |
|---|---|
| `audience_scale.cross_platform_effective_reach` | `effective_reach_cross_platform` |
| `audience_scale.sport_level_audience_percentile` | `followers_latest` |
| `audience_scale.audience_growth` | `followers_growth_pct` |
| `audience_scale.platform_breadth` | `platform_breadth` |
| `engagement_quality.engagement_percentile` | `engagement_per_follower_median`, `interactions_per_reach_median`, `interactions_per_view_median` |
| `engagement_quality.reach_efficiency` | `reach_per_follower_median`, `views_per_follower_median`, `non_follower_reach_share` |
| `engagement_quality.shares_saves_quality` | `saves_per_1k_reach_median`, `shares_per_1k_reach_median`, `shares_per_1k_views_median` |
| `engagement_quality.video_retention` | `completion_pct_median` |
| `momentum.audience_growth` | `followers_growth_pct` (secondary in the adapter) |
| `brand_fit.geographic_relevance` | `audience_top_country_share`, `audience_geo_concentration` |

### Coverage summary (revised)

| Dimension | Total | Already sourced | **OBSERVED (Slice E)** | Prior-only |
|---|---|---|---|---|
| Athletic Authority | 6 | 0 | **6** (all) | 0 |
| Audience Scale | 4 | 4 | 0 | 0 |
| Engagement Quality | 6 | 4 | 0 | 2 (`story_efficiency`, `audience_authenticity`) |
| Cultural Relevance | 5 | 0 | **2** (`media_source_quality`, `crossover_recognition`) | 3 (`media_volume_percentile`, `search_interest`, `social_conversation`) |
| Narrative Power | 6 | 0 | 0 | 6 (all) |
| Brand Fit | 6 | 1 | **3** (`category_breadth`, `brand_safety`, `content_versatility`) | 2 (`audience_attractiveness`, `identity_values_coherence`) |
| Commercial Proof | 6 | 0 | **2** (`deal_frequency`, `renewals_repeat`) | 4 (`verified_commercial_value`, `brand_quality`, `campaign_performance`, `pricing_power`) |
| Momentum | 5 | 1 | 0 | 4 (`athletic_trajectory`, `media_trajectory`, `search_social_trajectory`, `commercial_acceleration`) |
| **Total** | **44** | **10** | **13** | **21** |

---

## 1. Athletic Authority — 15% (6 of 6 OBSERVED)

| Sub-signal (subweight) | Source facts/evidence | Transformation / lookup | Freshness | Confidence behaviour | Missing-data prior | Anti-double-counting |
|---|---|---|---|---|---|---|
| `competition_level` (25%) — **OBSERVED** | Current `affiliation` fact (`status="current"`), field `orgKind` (closed registry enum) | **L1**: orgKind → 0–100 — olympic 100, national 95, pro 85, club 50, school 45. `affiliation.level` (free text) is **never** used | `affiliations` family | web_researched, confidence 0.6–0.8 by orgKind | no current affiliation ⇒ prior `athletic_authority.competition_level` | Primary owner of `affiliation.orgKind`. Distinct from `role_importance` (same row, field `role`). |
| `performance_results` (25%) — **OBSERVED** | `achievement` facts, strongest confirmed level in the trailing 24 months (registry LEVELS enum) | **L-perf**: LEVELS → 0–100 (international 100 … other 25) — the *strongest recent level*, not a count | `achievements` family | web_researched, confidence 0.4–0.8 by level | no qualifying dated achievement in 24mo ⇒ prior `athletic_authority.performance_results` | Primary owner of level-bearing `achievement` rows. Revised **away** from a 12-month achievement-COUNT percentile (D1 draft) under the central rule. |
| `rankings_recognition` (15%) — **OBSERVED** | `ranking` fact (`scope`, `rank`) and `award` fact (`level`), strongest state within 24 months | **L-rank**: closed **scope token** (`international` ⟵ international/world/global, `national`, `conference`, `regional` ⟵ regional/state; anything else ⇒ `other`) × **rank bucket** (`top3` rank≤3, `top10` rank≤10, else `ranked`) — 15 `<scope>_<bucket>` combinations (100…45) — plus 8 `award_<LEVEL>` states (95…25); best of all 23 | `achievements` family | web_researched, confidence 0.5–0.8 by combination | no qualifying ranking/award ⇒ prior `athletic_authority.rankings_recognition` | Primary owner of `ranking`/`award` facts. `ranking.scope` is matched to a **closed** taxonomy now (no longer deferred) — unmatched scope text ⇒ `other`, not dropped. |
| `national_international_status` (15%) — **OBSERVED** | `achievement`/`award` fact at international level, else `national_team_participation` fact or a national-level honour | **L-nis**: international=100, national=80. "international" takes priority whenever any qualifying fact is at that level | `achievements` family | web_researched, confidence 0.7–0.8 | neither condition met ⇒ prior `athletic_authority.national_international_status` | Primary owner of the international/national determination; distinct fact fields from `competition_level` (`orgKind`) and `role_importance` (`role`). |
| `role_importance` (10%) — **OBSERVED** | Current `affiliation.role` (free text), matched against a closed token list only | **L-role**: exact tokens `captain`(100), `co_captain`(90), `starter`(75), `key_player`(75), `rotation`(55), `bench`(35), `redshirt`(30). No fuzzy matching — anything else resolves to `unknown` | `affiliations` family | web_researched, confidence ~0.5–0.6 | `unknown` (role absent or not an exact closed token) ⇒ prior `athletic_authority.role_importance` | **Secondary** reader of the same current-`affiliation` row `competition_level` owns as primary (different field: `role`, not `orgKind`). |
| `achievement_recency` (10%) — **OBSERVED** | Most recent dated `achievement`/`award`/`ranking` fact (any category) | **L-recency** step function on days-since: ≤90→100, 91–180→90, 181–365→75, 366–730→55, >730→35. Year-only dates use 1 July of that year (documented convention) | `achievements` family | web_researched, confidence 0.6–0.7 by step | no dated fact at all ⇒ prior `athletic_authority.achievement_recency` (not a decay-curve output) | **Secondary** reuse of rows `performance_results`/`rankings_recognition` already own as primary — distinct statistic: most-recent date, not level/rank. |

---

## 2. Engagement Quality — 15% (0 of 2 remaining OBSERVED — unchanged from D1)

| Sub-signal (subweight) | Source facts/evidence | Transformation / lookup | Freshness | Confidence behaviour | Missing-data prior | Anti-double-counting |
|---|---|---|---|---|---|---|
| `story_efficiency` (10%) — prior-only | No Beta.1 research source; needs a connected Story-analytics `FeatureKey` that does not exist in `metrics.ts` today | n/a | `signals` | n/a | prior `engagement_quality.story_efficiency`, imputed, low confidence | No overlap — social-feature gap, not a mapping gap. |
| `audience_authenticity` (10%) — **prior-only (decided)** | `authenticity_concerns` research finding could only ever supply a negative flag | **Excluded entirely** — a single uncorroborated finding is too weak a basis even capped; connected audience-quality data remains the intended real source | — | — | prior `engagement_quality.audience_authenticity` | Not built against research evidence at all. |

---

## 3. Cultural Relevance — 10% (2 of 5 OBSERVED)

| Sub-signal (subweight) | Source facts/evidence | Transformation / lookup | Freshness | Confidence behaviour | Missing-data prior | Anti-double-counting |
|---|---|---|---|---|---|---|
| `media_volume_percentile` (30%) — **prior-only (decided)** | `press_mention` evidence, `topic="coverage"` | **Rejected**: a count of retrieved coverage rows is a retrieval artifact, not a volume measure (central rule) | — | — | prior `cultural_relevance.media_volume_percentile`, imputed | Not built. |
| `media_source_quality` (20%) — **OBSERVED** | `press_mention` evidence, field `outletContext`, cited-equivalent lineage, trailing 12 months (no `topic` filter in code — any cited press row with an `outletContext`) | **L-outlet**: outletContext → 0–100 (international 100, national 90, mainstream 85, sport_specific 65, regional 45, local 35) — the **strongest confirmed** outletContext within 12 months (not a mean or an aggregate) | `press` family | web_researched, confidence 0.6–0.7 by outletContext; outletContext alone (no outlet-name→`SOURCE_TYPE` lookup — none exists) | no cited row with `outletContext` in 12mo ⇒ prior `cultural_relevance.media_source_quality` | Independent statistic; no other sub-signal reads `outletContext`. |
| `search_interest` (20%) — prior-only | No research-spec/1 item collects search volume; a press/social-count proxy would double-count | none | n/a | n/a | prior `cultural_relevance.search_interest`, imputed | Not built from `press_mention` — explicit anti-double-counting. |
| `social_conversation` (15%) — **prior-only (decided)** | `press_mention`, `topic="social_conversation"`/`"viral_moment"` | **Rejected**: retrieved-mention count is not a real-world conversation-volume measure | — | — | prior `cultural_relevance.social_conversation`, imputed | Not built. |
| `crossover_recognition` (15%) — **OBSERVED** | `crossover_appearance` evidence (field `medium`), all current rows (no time window in code) | **Bounded positive-evidence state**, not a count percentile: `confirmed_one`(60) — exactly one distinct medium — vs `confirmed_multiple`(85) — two or more. Lack of retrieval ≠ zero: no appearance evidence falls to the prior, never to `confirmed_one` | `press` family (`crossover_appearance` domain) | web_researched, confidence 0.5–0.6 | no qualifying appearance ⇒ prior `cultural_relevance.crossover_recognition` | Primary owner of `crossover_appearance` rows. `content_versatility` (Brand Fit) is a **secondary**, capped reader of the same rows (distinct statistic: format count, unioned with `content_formats` findings). |

---

## 4. Narrative Power — 10% (0 of 6 OBSERVED — all prior-only, decided)

All six sub-signals — `distinctiveness`, `story_depth`, `evidence_authenticity`, `commercial_applicability`, `media_resonance`, `durability` — are **prior-only for initial Beta.1** by explicit founder decision. No AI-assisted classifier (`L8`/`L9`-style) and no secondary reuse of Athletic Authority / Cultural Relevance rows was built.

| Sub-signal (subweight) | Source facts/evidence | Transformation / lookup | Freshness | Confidence behaviour | Missing-data prior | Anti-double-counting |
|---|---|---|---|---|---|---|
| `distinctiveness` (25%) | `narrative_claim` evidence | none built | n/a | n/a | prior `narrative_power.distinctiveness`, imputed | n/a |
| `story_depth` (20%) | `narrative_claim` evidence | none built | n/a | n/a | prior `narrative_power.story_depth`, imputed | n/a |
| `evidence_authenticity` (20%) | `narrative_claim.lineage` | none built | n/a | n/a | prior `narrative_power.evidence_authenticity`, imputed | n/a |
| `media_resonance` (15%) | `press_mention` rows Cultural Relevance owns | none built — secondary reuse rejected | n/a | n/a | prior `narrative_power.media_resonance`, imputed | n/a |
| `commercial_applicability` (10%) | none | none | n/a | n/a | prior `narrative_power.commercial_applicability`, imputed | n/a |
| `durability` (10%) | `achievement`/`award`/`press_mention` date span | none built — secondary reuse rejected | n/a | n/a | prior `narrative_power.durability`, imputed | n/a |

---

## 5. Brand Fit — 10% (3 of 5 remaining OBSERVED; `geographic_relevance` already sourced)

| Sub-signal (subweight) | Source facts/evidence | Transformation / lookup | Freshness | Confidence behaviour | Missing-data prior | Anti-double-counting |
|---|---|---|---|---|---|---|
| `category_breadth` (25%) — **OBSERVED** | `endorsement` fact, field `category`, trailing 24 months | **Bounded state** of distinct categories (not a count percentile): `one_category`(45), `two_categories`(65), `three_plus_categories`(85) | `brand_mentions` family | web_researched, confidence ~0.5 | no `endorsement` fact ⇒ prior `brand_fit.category_breadth` | Primary owner of `endorsement.category` breadth. `deal_frequency` owns deal *count*, not category diversity — disjoint statistic. |
| `brand_safety` (20%) — **OBSERVED** | `reputation_event` evidence, stages `official_finding_or_action`/`resolution_or_outcome` only — `reported_allegation` never read | **L-safety**: `official_finding`(55), `resolution`(80) | `press` family | web_researched, confidence 0.8 | no qualifying row ⇒ **global versioned prior** `priors-v1`: `brand_fit.brand_safety` = 85, confidence 0.4 (not zero, not penalized) | Exclusive: no other sub-signal reads `reputation_event`. |
| `audience_attractiveness` (20%) — prior-only | Demographic desirability is connected-only social data | n/a from research | `signals` | n/a | prior `brand_fit.audience_attractiveness` | No overlap — connected-data gap. |
| `identity_values_coherence` (15%) — **prior-only (decided)** | `narrative_claim` × `endorsement.category` | Depends on an AI classifier (L9) not built; also depends on Narrative Power staying prior-only | — | — | prior `brand_fit.identity_values_coherence`, imputed | Not built. |
| `content_versatility` (10%) — **OBSERVED** | `crossover_appearance.medium` (same rows `crossover_recognition` owns primary) ∪ `content_formats` research finding (S8, evidence-only, no registry key) | **Bounded positive-evidence state**: `confirmed_one`(50) — one distinct medium/format — vs `confirmed_multiple`(70) — two or more, across the unioned set. Lack of retrieval ≠ zero | `press`/`social_handles` (mixed) | web_researched, confidence 0.5–0.6 | no qualifying medium/format at all ⇒ prior `brand_fit.content_versatility` | **Secondary**, capped reader of `crossover_appearance` rows `crossover_recognition` owns as primary — distinct statistic (format diversity, unioned with `content_formats`, vs. crossover-medium count alone). |

---

## 6. Commercial Proof — 15% (2 of 6 OBSERVED)

Hard constraint carried through this section: a web-researched `endorsement` is a relationship, never a verified $ value; `nil_mention`/`published_values` are excluded from every row.

| Sub-signal (subweight) | Source facts/evidence | Transformation / lookup | Freshness | Confidence behaviour | Missing-data prior | Anti-double-counting |
|---|---|---|---|---|---|---|
| `verified_commercial_value` (30%) — prior-only | Requires `athlete_proof`/`connection` origin; no research source can feed this | n/a | n/a | n/a | prior `commercial_proof.verified_commercial_value` | No fact/evidence overlap — structurally research-blind. |
| `deal_frequency` (20%) — **OBSERVED** | `endorsement` facts, distinct `brand`+`dealType` pairs that are **recent** (dated within 24 months, or `status="current"` and undated) | **Bounded state, never an exact frequency**, all at confidence 0.4: `historical_confirmed_only`(45) — 0 recent distinct relationships (only older dated ones) — `one_recent_confirmed`(62) — exactly 1 — `multiple_recent_confirmed`(78) — 2+ | `brand_mentions` family | web_researched, confidence 0.4 (capped, uniform across states) | no `endorsement` fact at all ⇒ prior `commercial_proof.deal_frequency` | Primary owner of deal-relationship *state*. `category_breadth` owns category diversity over the same fact key — disjoint statistic. Revised **away** from a cohort-percentile of the raw count (D1 draft) under the central rule. |
| `brand_quality` (15%) — prior-only | `endorsement.brand`/`category` | No brand-tier dataset exists or is licensable; stays prior-only indefinitely, matching `verified_commercial_value` | n/a | n/a | prior `commercial_proof.brand_quality`, imputed | n/a — no L10 built. |
| `renewals_repeat` (15%) — **OBSERVED** | Explicit repeat evidence only: (a) ≥2 `endorsement` facts for one normalized `brand` with ≥2 distinct dated ranges, OR (b) a cited `renewals_repeat` research finding, OR (c) a cited `brand_mention` with `renewal:true` | **`confirmed_repeat`** state → 75 (present/absent — never a share-of-brands percentile) | `brand_mentions` family | web_researched, confidence 0.5 | no explicit repeat evidence ⇒ prior `commercial_proof.renewals_repeat` | **Secondary**, capped reader of `endorsement` rows `deal_frequency`/`category_breadth` already own as primary — distinct statistic (explicit repeat vs. recency-state vs. category). |
| `campaign_performance` (10%) — prior-only | No performance metric ever collected by research-spec/1 | none | n/a | n/a | prior `commercial_proof.campaign_performance`, imputed | n/a |
| `pricing_power` (10%) — prior-only | `published_values` is evidence-only, third-party-estimate shaped; excluded by the same rule as `nil_mention` | none | n/a | n/a | prior `commercial_proof.pricing_power`, imputed | n/a — explicit exclusion. |

---

## 7. Momentum — 10% (0 of 4 remaining OBSERVED — all prior-only, decided)

Every research-derived Momentum sub-signal is **prior-only initially**. The real platform `audience_growth` (already sourced from social features, untouched) is the only Momentum input in production today.

| Sub-signal (subweight) | Source facts/evidence | Transformation / lookup | Freshness | Confidence behaviour | Missing-data prior | Anti-double-counting |
|---|---|---|---|---|---|---|
| `athletic_trajectory` (30%) | `achievement`/`award`/`ranking` rows Athletic Authority owns | none built — trend-of-a-count rejected under the central rule | n/a | n/a | prior `momentum.athletic_trajectory` | n/a |
| `media_trajectory` (20%) | `press_mention` rows Cultural Relevance owns | none built | n/a | n/a | prior `momentum.media_trajectory` | n/a |
| `search_social_trajectory` (15%) | Depends on `search_interest`, itself prior-only | none | n/a | n/a | prior `momentum.search_social_trajectory`, imputed | n/a |
| `commercial_acceleration` (10%) | `endorsement` rows Commercial Proof owns | none built | n/a | n/a | prior `momentum.commercial_acceleration` | n/a |

---

## Lookups authored (`marketability-lookups/1`, `BETA1_LOOKUPS_V1` in `marketabilityBeta1Params.ts`)

| Lookup | Domain (closed set) | Values (0–100) | Feeds |
|---|---|---|---|
| `athletic_authority.competition_level` | `orgKind`: olympic, national, pro, club, school | 100, 95, 85, 50, 45 | `competition_level` |
| `athletic_authority.performance_results` | LEVELS: international, national, pro, conference, regional, school, club, other | 100…25 | `performance_results` |
| `athletic_authority.rankings_recognition` | scope (international/national/conference/regional/other) × bucket (top3/top10/ranked) = 15 states, ∪ award_&lt;LEVEL&gt; (8 states) | 100…45 (scope×bucket), 95…25 (award) | `rankings_recognition` |
| `athletic_authority.national_international_status` | international, national | 100, 80 | `national_international_status` |
| `athletic_authority.role_importance` | captain, co_captain, starter, key_player, rotation, bench, redshirt (`unknown` ⇒ prior, not a taxonomy member) | 100…30 | `role_importance` |
| `athletic_authority.achievement_recency` | d0_90, d91_180, d181_365, d366_730, d_over_730 | 100, 90, 75, 55, 35 | `achievement_recency` |
| `cultural_relevance.media_source_quality` | outletContext: international, national, mainstream, sport_specific, regional, local (strongest within 12mo, not a mean) | 100, 90, 85, 65, 45, 35 | `media_source_quality` |
| `cultural_relevance.crossover_recognition` | confirmed_one, confirmed_multiple | 60, 85 | `crossover_recognition` |
| `brand_fit.brand_safety` | official_finding, resolution | 55, 80 | `brand_safety` |
| `brand_fit.category_breadth` | one_category, two_categories, three_plus_categories | 45, 65, 85 | `category_breadth` |
| `brand_fit.content_versatility` | confirmed_one, confirmed_multiple | 50, 70 | `content_versatility` |
| `commercial_proof.deal_frequency` | historical_confirmed_only, one_recent_confirmed, multiple_recent_confirmed | 45, 62, 78 (confidence 0.4 uniformly) | `deal_frequency` |
| `commercial_proof.renewals_repeat` | confirmed_repeat | 75 | `renewals_repeat` |

**Deferred, not built**: `narrative_distinctiveness` (L8), `identity_values_coherence` (L9), `brand_tier` (L10) — all require an AI-assisted classifier or an external dataset that does not exist; the sub-signals they would feed stay prior-only (Decisions 7–10 below).

## Observables read by `deriveResearchSignals`

| Observable | Window | Feeds | Shape |
|---|---|---|---|
| Current `affiliation.orgKind` | as of scoring date | `competition_level` | closed enum, not a count |
| Strongest achievement `LEVEL` | trailing 24mo | `performance_results` | strongest state, not a count |
| Strongest `ranking.scope`×`rank` bucket / `award.level` state | trailing 24mo | `rankings_recognition` | scope × bucket, best-of |
| International/national achievement or `national_team_participation` | as of scoring date | `national_international_status` | boolean-priority state |
| Current `affiliation.role` (closed tokens only) | as of scoring date | `role_importance` | exact-match state, `unknown` ⇒ prior |
| Days since most recent dated `achievement`/`award`/`ranking` | as of scoring date | `achievement_recency` | step function |
| Strongest `outletContext` of cited `press_mention` rows | trailing 12mo | `media_source_quality` | strongest confirmed state, not a mean |
| Distinct `crossover_appearance.medium` values | all current rows (no window) | `crossover_recognition` | one vs. multiple state |
| Distinct crossover mediums ∪ `content_formats` finding values | all current rows | `content_versatility` | one vs. multiple state |
| `reputation_event` stage (official_finding / resolution) | as of scoring date | `brand_safety` | strongest stage state |
| Distinct `endorsement.category` values | trailing 24mo | `category_breadth` | one/two/three-plus state |
| Distinct recent `endorsement.brand`+`dealType` pairs (dated ≤24mo, or current+undated) | trailing 24mo or current | `deal_frequency` | historical/one-recent/multiple-recent state |
| `endorsement` rows sharing a brand (≥2 dated ranges), a cited `renewals_repeat` finding, or `renewal:true` on a cited `brand_mention` | all current rows | `renewals_repeat` | present/absent state, explicit evidence only |

None of the above is a percentile of a retrieved-row count — every one is a closed-taxonomy state of the strongest or most-recent qualifying evidence, per the central rule.

## Decisions taken (13 Sep 2026)

1. **`rankings_recognition` shape** — closed **scope token** (`international` ⟵ international/world/global, `national`, `conference`, `regional` ⟵ regional/state; anything else ⇒ `other`) × **rank bucket** (`top3` rank≤3, `top10` rank≤10, else `ranked`), plus `award_<LEVEL>`, strongest state within 24 months. Scope is now a closed taxonomy (not deferred): full 23-state set and values are in the Lookups table above.
2. **`role_importance` taxonomy** — kept as its own sub-signal with the 7-token closed set (captain, co_captain, starter, key_player, rotation, bench, redshirt), exact tokens only; anything else resolves to `unknown` ⇒ prior.
3. **`achievement_recency` curve** — a step function, not a continuous decay: ≤90d=100, 91–180d=90, 181–365d=75, 366–730d=55, >730d=35. Year-only dates use 1 July of that year (documented convention).
4. **`audience_authenticity`** — excluded entirely; stays prior-only. Connected audience-quality data remains the intended real source, not a single uncorroborated research finding.
5. **`media_source_quality`** — the **strongest confirmed** outletContext within 12 months, not a mean or an aggregate. Confidence rests on `outletContext` alone; no outlet-name → `SOURCE_TYPE` lookup built.
6. **`crossover_recognition`** — not a flat or weighted count-percentile; replaced with a bounded positive-evidence state (`confirmed_one` 60 / `confirmed_multiple` 85). Lack of retrieval ≠ zero — it falls to the prior.
7. **Narrative Power** — all 6 sub-signals stay prior-only for initial Beta.1. No classifier (L8/L9) built, no count-based thresholds calibrated.
8. **`media_resonance` / `durability` secondary reuse** — rejected; folded into Decision 7. Neither reads Cultural Relevance's or Athletic Authority's primary rows in Slice E.
9. **`identity_values_coherence`** — stays prior-only; depends on an unbuilt classifier (L9) and on Narrative Power, itself prior-only.
10. **`brand_quality` / `brand_tier`** — stays prior-only indefinitely; no internal or licensable brand-recognition dataset identified, matching `verified_commercial_value`.
11. **Momentum secondary reuse** — rejected across the board. All four research-derived trajectory/acceleration sub-signals stay prior-only; only the real platform `audience_growth` (social features) feeds Momentum today.
12. **`performance_results`** — revised away from a 12-month achievement-COUNT percentile toward the strongest confirmed achievement `LEVEL` in the trailing 24 months, via a closed lookup.
13. **`media_volume_percentile` / `social_conversation`** — revised to prior-only; a count of retrieved `press_mention` rows is a retrieval artifact, not a volume or conversation measure.
14. **`category_breadth`** — a bounded state of distinct categories (one/two/three-plus), not a percentile of the category count.
15. **`deal_frequency`** — a bounded state (`historical_confirmed_only` 45 / `one_recent_confirmed` 62 / `multiple_recent_confirmed` 78, confidence 0.4 uniformly) over distinct **recent** confirmed relationships (dated within 24 months, or `status="current"` and undated) — never an exact real-world deal frequency.
16. **`renewals_repeat`** — a present/absent `confirmed_repeat` state, built **only** on explicit evidence: two dated relationship-ranges with one brand, a cited `renewals_repeat` finding, or `renewal:true` on a cited `brand_mention` — not a percentile of the share of repeated brands.
17. **`brand_safety`** — confirmed: only `official_finding_or_action` (55) / `resolution_or_outcome` (80) stages read; no reputation evidence ⇒ the versioned global prior (`priors-v1`: 85, confidence 0.4), a sensible global prior, never tuned per athlete.
18. **`content_versatility`** — now **OBSERVED**: a bounded positive-evidence state (`confirmed_one` 50 / `confirmed_multiple` 70) over distinct `crossover_appearance.medium` values unioned with `content_formats` finding values — a secondary, capped reuse of `crossover_recognition`'s primary rows.

---

## Implementation

Slice E ships in `server/services/marketabilityBeta1ResearchSignals.ts`, function `deriveResearchSignals`, version `beta1-research-signals/1`. Implemented sub-signals (13): `athletic_authority.{competition_level, performance_results, rankings_recognition, national_international_status, role_importance, achievement_recency}`, `cultural_relevance.{media_source_quality, crossover_recognition}`, `brand_fit.{category_breadth, brand_safety, content_versatility}`, `commercial_proof.{deal_frequency, renewals_repeat}`. Everything else stays on its prior. It reads only:

- `athlete_facts` (registry v2), rows with `status` `current` or `historical`, never `superseded`.
- `research_evidence` rows with a cited-equivalent `lineageStatus` (`cited` / `native_supported` / `native_retrieved`), never `suspect`, never `superseded`.

Every value it emits comes from the closed lookups in the active bundle (`lookups-v1`) and the global priors (`priors-v1`, `server/services/marketabilityBeta1Params.ts`) — nothing in the function itself carries a tuned number. `lookups-v1`/`priors-v1` are versioned parameter rows, never per-athlete, per §21.1.

## Lineage recovery (13 Sep)

Binding precedence for a Gemini direct-evidence claim, tried in order, stopping at the first that binds (`server/services/intelligence/research/spec/directLineage.ts`): **(1)** exact quote, **(2)** exact statement, **(3)** conservatively normalized quote, **(4)** conservatively normalized statement. "Conservative normalization" is Unicode NFKC + whitespace collapse + terminal-punctuation strip + lower-casing only — never fuzzy or semantic. A method binds only when its needle occurs **exactly once** in the factual prose and that span is **contained in a provider-native grounding support** (the API's own index range); a second occurrence means that level does not bind. Failing all four, the claim is `asserted_only`. The winning method is persisted as `bindingMethod` (`quote_exact` / `statement_exact` / `quote_normalized_exact` / `statement_normalized_exact` / `none`) alongside the lineage `level` (`native_supported` / `native_retrieved` / `asserted_only` / `unsupported`).

The direct-evidence prompt has been tightened for future calls to make binding easier. Stored envelopes from prior calls are **reprocessed deterministically** against the new precedence — no new provider calls are made; lineage is recomputed from data already persisted.
