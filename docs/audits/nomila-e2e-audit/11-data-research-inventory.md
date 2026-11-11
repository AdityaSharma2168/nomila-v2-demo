# 11 — Data / research inventory: the ATHLETE half (Agent C)

This is the athlete-level half of the data, research and context inventory. The world/context half ("why now":
fixtures, moments, trends, news) is in `12-context-inventory.md` (Agent D). Evidence detail and citations for
everything summarised here are in `03-research-mia-state.md`. As-of: working tree `3f0139f6`, main `9fff9b15`, dev DB
read on 2026-09-27.

## Legend

**Class**, one per row:
- **R+** — requested and reliably obtained
- **R~** — requested but poorly populated
- **NR** — never requested (by production research)
- **DISC** — available elsewhere but discarded before State/Brain
- **STALE** — stale / not refreshed
- **MISPROJ** — incorrectly projected
- **DUP** — duplicated across stores

**Stores:**
- `snap` = `athlete_snapshots.research` (legacy researchAthlete)
- `spec1` = research-spec/1 substrate (`research_evidence` / `athlete_facts`). Calibration cohort only, **0 rows for
  product athletes**.
- `MIA` = `intelligence_ledger` marketability row (evaluator's own grounded research)
- `aff` = `athlete_affiliations`
- `ass` = `athlete_asserted`
- `soc` = `social_features` / `social_audience_distributions` / `social_metric_observations`
- `cur` = `athletes_current`
- `ath` = `athletes` columns

**Refresh:**
- legacy research runs at signup, on admin request, and on the monthly sweep (1st of month)
- M.I.A. runs on signup, a social-block change, or an admin/user refresh
- social runs nightly (04:30 UTC)

**Should be:** S = durable Athlete State; C = time-sensitive Context. The row gives a judgment of the target location
only; it is not a design.

**Brain sees / Planner sees:** checked against the rendered state block in
`docs/audits/artifacts/brain-substrate-live/final-live.json`. The outreach planner receives the same `stateBlock`
(`planner/evalSpec.ts:91-101`, flag off), so its column equals the Brain's unless noted.

**Studio sees:** checked against `server/services/athleteContext.ts` (deck/Studio athlete context).

## A. Identity and athletic

| # | item | class | captured? where | once / continuous | source authority | freshness (Mia) | reaches State? | should be | Brain sees | Planner | Studio |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Name | R+ | `ath.full_name` (signup) | once | athlete | — | ✅ `identity.name` | S | ✅ | ✅ | ✅ |
| 2 | Aliases / nickname | R~ (spec1 asks; legacy no) | `ass.nickname` field; spec1 `alias` facts (cohort) | once | athlete / web | — | ❌ | S | ❌ | ❌ | ❌ |
| 3 | Birth year / minor status | NR (legacy); spec1 asks | spec1 `birth_year` (cohort); M.I.A. prose (Lilia "born 2011") | once | web | — | ❌ (no minor flag in State) | S | prose only | prose only | ❌ |
| 4 | Nationality / heritage | NR (legacy); spec1 asks | M.I.A. evidence E2 ("first player of Indian descent…") | M.I.A. runs | web (Wikipedia, "secondary") | M.I.A. 09-21 | only inside M.I.A. prose | S | prose | prose | ❌ |
| 5 | Hometown / geography | R+ (legacy) | `snap.profile.hometown` (8/9 real athletes) | legacy runs | web | 09-03 | ❌ **DISC** | S | ❌ | ❌ | ❌ (Record ✅) |
| 6 | Sport | R+ | `ath.sport` (signup) | once | athlete | — | ✅ | S | ✅ | ✅ | ✅ |
| 7 | Discipline / position / event | R+ legacy / **DISC** | `snap.profile.position` ("Midfielder/Defender") | legacy runs | web | 09-03 | ❌ **DISC** | S | M.I.A. prose only | same | ❌ (Record ✅) |
| 8 | Current team + level | R+ (said) / **STALE** for transfers | `aff` (said at signup). Research never writes school (`researchAthlete.ts:759`) | once + athlete edits | athlete | signup | ✅ `competitionContext` "Stanford University · D1" | S | ✅ | ✅ | ✅ |
| 9 | Past teams (with years) | R~ | legacy `teams` = 0 for 8/9. `found` aff from achievements (Mia U-17 USWNT) | legacy runs | web | 09-03 | ❌ (live affiliations only) | S | ❌ | ❌ | partly |
| 10 | Career status (active / injured / retired) | NR (legacy) / **MISPROJ** | `ath.career_status` NOT NULL **default 'active'** (`shared/schema.ts:74`) | default | column default | — | ✅ "active", rendered as fact | S | ✅ (a default, unlabelled) | ✅ | ✅ |
| 11 | Career stage / class year / eligibility | R~ | `snap.profile.class_year` free text ("Senior (2026 season)"; Lilia 2029 vs "Class of 2028") | legacy runs | web | 09-03 | ❌ **DISC** | S | ❌ (M.I.A. prose says "master's program") | ❌ | ❌ |
| 12 | Education / degree / graduation | NR (legacy); spec1 asks | M.I.A. E3 (Symbolic Systems in 2.5 yrs; MS&E) | M.I.A. runs | web ("major_media") | M.I.A. 09-21 | prose only | S | prose | prose | ❌ |
| 13 | National-team programme | R~ | legacy achievements ("U-17 USWNT Captain"). `aff` found U-17 USWNT (ended 2022) | legacy | web | 09-03 | ❌ (ended rows not in competitionContext) | S | prose | prose | ✅ (marquee tag) |
| 14 | Results / titles / stats | R~ (**DUP** within list) | `snap.achievements` 33 (dupes). spec1 `season_statistic` (cohort) | legacy runs | web | 09-03 | ❌ **DISC** | S (career) / C (this season) | M.I.A. prose + E1 | same | ✅ top 5 |
| 15 | Rankings | R~ | spec1 `ranking` (cohort). Legacy only inside achievements | — | web | — | ❌ | S | prose | prose | ❌ |
| 16 | Awards / honours (athletic + academic) | R+ (legacy) | `snap.achievements` (All-America 4th team 2024 etc.) | legacy | web | 09-03 | ❌ **DISC** | S | E1 citation only | same | ✅ |
| 17 | Recent milestones / selections (12 mo) | NR (legacy); spec1 S3 asks | — (spec1 cohort only) | — | — | — | ❌ | C | ❌ | ❌ | ❌ |
| 18 | Injuries / returns | NR (legacy); spec1 S3 asks | — | — | — | — | ❌ | C → S when durable | ❌ | ❌ | ❌ |
| 19 | Transfers / signings | NR (legacy); spec1 asks | leaks into `snap.profile.school` + story arc (Lara → TCU). M.I.A. summary | legacy | web | 09-01 | ❌ **DISC** / **STALE** (State says Stanford) | S | ❌ (Lara) | ❌ | ❌ |
| 20 | Draft / pro / contract milestones | NR | — | — | — | — | ❌ | C | ❌ | ❌ | ❌ |
| 21 | Interests / hobbies | NR (research) | `ass.hobbies` (0 rows). `first_look.themes` (e.g. "morning routines", "academic milestones") | at connect | athlete / own posts | 09-03 | ❌ **DISC** | S | ❌ | ❌ | ❌ |
| 22 | Causes / values / philanthropy | NR (legacy); spec1 S6 asks | M.I.A. E3 (Yuwa). Legacy mis-files Yuwa as brand "partnership" ×2. `ass.brands_causes` (0). Studio `research.values/causes` **never populated** (0 snapshots) | M.I.A. / legacy | web | 09-21 | prose only (**MISPROJ** in legacy) | S | prose | prose | ❌ (Yuwa appears as a "brand") |
| 23 | Ventures / businesses | NR (legacy); spec1 S7 asks | spec1 `venture` evidence (cohort, evidence-only kind) | — | web | — | ❌ | S | ❌ | ❌ | ❌ |
| 24 | Personal narrative / story | R~ | `snap.story_arc` → `cur.story_arc` (evaluative, uncited). M.I.A. narrative_power prose (cited) | legacy / M.I.A. | web + model | 09-03 / 09-21 | M.I.A. prose ✅. story_arc ❌ | S | ✅ (M.I.A.) | ✅ | story_arc ✅ |
| 25 | Press coverage | R~ (undated) | `snap.press_mentions` 8 (all `date:null`). spec1 press (cohort). M.I.A. E1–E4 | legacy / M.I.A. | web | 09-03 | ❌ (only via M.I.A. citations) | C (recent) / S (footprint) | 4 cited items | same | counts |
| 26 | Cultural footprint / crossover / viral | NR (legacy); spec1 S5 asks | M.I.A. cultural_relevance | M.I.A. | web | 09-21 | prose ✅ | S | ✅ | ✅ | ❌ |
| 27 | Reputation / brand safety | NR (legacy); spec1 S9 asks | M.I.A. brand_safety=98. `notes.evaluationRisks` | M.I.A. | web | 09-21 | component ✅, risks ❌ | S | score only | same | ❌ |
| 28 | Representation (agent / agency) | NR (research) | `ath.deal_preferences.agent_name/agency_name` (athlete). spec1 `representation` (cohort) | athlete-set | athlete | — | ✅ `representation` | S | ✅ | ✅ | ❌ |
| 29 | Official handles | R+ | `snap.social_handles` + connected accounts (known handles win) | legacy + connect | athlete / platform | — | ❌ (implicit in audience platforms) | S | ❌ | ❌ | ❌ (not read by athleteContext.ts) |
| 30 | Search interest / news volume (Trends, GDELT) | R+ (numbers) | `snapshot.google_trends_score`, `gdelt_article_count` (Mia 0/0) | legacy runs | API | 09-03 | ❌ | **C** | ❌ | ❌ | ❌ (v7.2 uses) |

## B. Audience and content

| # | item | class | captured? where | once / continuous | source authority | freshness | reaches State? | should be | Brain | Planner | Studio |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 31 | Audience scale (followers) | R+ | `soc.followers_latest` (IG, TT, YT). `cur.ig_followers` | nightly | platform (connected) | 09-27 | ✅ **IG only** in `audience[]` (TikTok 15.5k absent) | S | IG only (+ M.I.A. prose "37,000 combined") | same | ✅ combined |
| 32 | Audience composition (age/gender/country/city) | R+ | `social_audience_distributions` 8,900 rows (IG) | nightly | platform | 09-27 | ✅ top country/age/gender. City ❌ | S | ✅ | ✅ | ✅ |
| 33 | Audience growth | R+ | `followers_growth_pct/abs` | nightly | platform | 09-27 | ✅ `audienceTrajectory` "cooling" (one categorical) | C (trend) / S (direction) | ✅ | ✅ | ❌ |
| 34 | Engagement / reach / saves / shares | R+ | IG features (engagement_per_follower 4.07%, reach_per_follower 47.03%, saves/shares per 1k) | nightly | platform | 09-27 | ❌ **DISC** (reaches M.I.A. social block → prose) | S | via M.I.A. prose | same | ✅ top post |
| 35 | Formats / cadence | R+ (IG) / R~ (TT, YT) | `format_mix`, `posts_per_week`, `days_since_last_post`. **No TikTok content features** despite 1,892 per-video obs each metric | nightly | platform | 09-27 | ✅ IG. TT = days since post only | S (pattern) / C (last 30 d) | ✅ | ✅ | ❌ |
| 36 | Breakout content | R+ | `breakout_rate`, `top_decile_share`, `reach_p90` | nightly | platform | 09-27 | ✅ (2 keys) | C | ✅ | ✅ | top post ✅ |
| 37 | Stories | R~ (collector on, **0 observations**) | Step 1b substrate | 8-hourly | platform | none | ❌ | C | ❌ | ❌ | ❌ |
| 38 | Content themes / tone | R+ | `athlete_snapshots.first_look` (IG/TT themes, tone, tagged handles e.g. @gorjana) | once at connect | own posts + Gemini | 09-03 | ❌ **DISC** | S | ❌ | ❌ | ❌ (Record ✅) |
| 39 | Public social (non-connected) | R+ | platform discovery → `snapshot.social` | legacy runs | public API | 09-03 | ❌ | S | ❌ | ❌ | followers via `rate_card.social` (athleteContext.ts:248) |

## C. Commercial

| # | item | class | captured? where | once / continuous | source authority | freshness | reaches State? | should be | Brain | Planner | Studio |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 40 | Existing / closed deals | R+ (inbox-derived) | `deals` accepted/completed (Mia: gorjana, $14k, 53.6% cash) | inbox ingest | inbox classifier + athlete | live | ✅ `closedDeals`, `demonstratedEconomics`, `cashShare` | S | ✅ | ✅ | ✅ confirmed partners |
| 41 | Active relationships not in deals (Adidas) | **DISC** / **DUP** | M.I.A. E4. `snap.brand_mentions`. `ass.note` *"Personal contract with Adidas; Nike is Stanford-affiliated"* | — | athlete (said) + web | 09-07 (said) | ❌ (`activeRelationships = ["gorjana"]`) | S | M.I.A. prose only. **Her own statement is dropped** | same | "undisclosed" inferred partner |
| 42 | Historical partnerships (brand mentions) | R~ (**MISPROJ**) | `snap.brand_mentions` (Adidas, Yuwa ×2 as "partnership", Nike team_apparel) | legacy | web | 09-03 | ❌ | S | ❌ | ❌ | ✅ as "undisclosed" |
| 43 | Inbound demand | R+ | `inbox_threads.classification` (category, advertiser, deadline, confidence). `inbox_brands` 180 | continuous | inbox classifier | 09-25 | ✅ top 12 + pipeline counts. Remainder/advertiser graph ❌ | C (live asks) / S (demand pattern) | ✅ 12 | ✅ | ❌ |
| 44 | Pipeline state | R+ | `deals.status` (detected 201 · negotiating 7 · rejected 2 · accepted 1) | continuous | classifier | live | ✅ | C | ✅ | ✅ | ❌ |
| 45 | Obligations / deliverables | NR / schema-only | `deal_deliverables`, `deal_periods`, `deal_installments` = **0/0/0 rows** | — | contract | — | ❌ | S | ❌ | ❌ | ❌ |
| 46 | Deal dates / term end | R~ | `deals.term_start/term_end` (null for all Mia active/negotiating rows) | — | inbox / contract | — | ✅ path exists; empty ("(none recorded)") | S | empty | empty | ❌ |
| 47 | Categories of her deals | NR | no column on `deals`. spec1 asks per brand (cohort) | — | — | — | ❌ | S | ❌ | ❌ | ❌ |
| 48 | Conflicts / exclusivity | NR | no column, no table | — | — | — | ❌ (`constraints` "none recorded"; `build.ts:519-522` admits it) | S | ❌ | ❌ | ❌ |
| 49 | Rate / value evidence: closed amounts | R+ | `deals.amount/amount_cash` | live | transaction | live | ✅ | S | ✅ | ✅ | names only (by design) |
| 50 | Rate / value evidence: floors | R+ | `ath.deal_preferences.minimum_rates` (5 floors) | athlete-set | athlete | — | ✅ `representation.floors` | S | ✅ | ✅ | ❌ |
| 51 | Rate / value evidence: third-party valuations | R~ (**MISPROJ**) | `snap.nil_valuation_mentions` (Mia: 5, mostly market stats, not her) | legacy | web | 09-03 | ❌ | S (labelled estimate) | ❌ | ❌ | ❌ |
| 52 | Rate card (computed) | made | `cur.rate_card` (v3.1, from v7.2 capitals; missing capital → 50) | nightly | model | 09-27 | ❌ | S (made) | ❌ | ❌ | ✅ |
| 53 | Brands wanted / never post | NR (asked only via fields) | `ass.brands_wanted`, `ass.never_post` (0 rows). `never_post` **would not match** the State regex | athlete | athlete | — | `brands_wanted` would (matches `want`). `never_post` ❌ | S | ❌ | ❌ | ❌ |
| 54 | Per-brand fit (audience / credibility / whitespace) | made | `brand_fit_narratives` 19 rows | on pitch | model | — | ❌ (deliberately) | C (per opportunity) | ❌ | ❌ | voice only |

## D. Judgment, intent, voice

| # | item | class | captured? where | once / continuous | source authority | freshness | reaches State? | should be | Brain | Planner | Studio |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 55 | Marketability dimensions (8) + reasons + citations | R+ | `MIA` findings / components / evidence | M.I.A. triggers | evaluator (web) | 09-21 | ✅ | S (as EVALUATED) | ✅ | ✅ | ❌ |
| 56 | M.I.A. summary / strengths / constraints / evaluation risks | R+ | `MIA.summary`, `MIA.notes.*` | M.I.A. | evaluator | 09-21 | ❌ **DISC** (only missingEvidence → materialGaps) | S (as EVALUATED) | ❌ | ❌ | ❌ |
| 57 | Score (/850) | **DUP** | v7.2 `cur.display_score` 672 (athlete sees). M.I.A. `MIA.score` 624 (neither the athlete nor the Brain sees it) | nightly / M.I.A. | model | 09-27 / 09-21 | ❌ both | S (one of them) | ❌ | ❌ | v7.2 ✅ |
| 58 | Onboarding goals | R+ | `ath.goal_archetype`, `secondary_goals` | once | athlete (fixed set) | 05-30 | ✅ labelled `ONBOARDING CHOICE` | S | ✅ | ✅ | ❌ |
| 59 | Athlete notes / said facts (note, position, class, hometown, cadence, hobbies, brands_causes) | **DISC** | `athlete_asserted` | athlete | athlete | — | ❌ (field-name regex `build.ts:533,556`) | S | ❌ | ❌ | ✅ asserted passed to Narrator |
| 60 | Constraints / availability (said) | NR (no asserted field matches `/availab\|constraint\|schedule\|eligib/`) | — | — | — | — | path exists, unreachable | S | ❌ | ❌ | ❌ |
| 61 | Brand voice | R~ (1 athlete) | `ath.brand_voice` | athlete | athlete | — | ❌ | S | ❌ | ❌ | ❌ (Mila profile/voice only) |
| 62 | Identity confidence / namesake separation | R~ | `MIA.identityConfidence` (Aditya HIGH for the wrong person). spec1 namesakes (cohort). `athlete_research_state` (cohort) | M.I.A. | evaluator | — | ❌ | S | ❌ | ❌ | ❌ |

## Counts (62 rows)

- Reaches State: 24 fully or partly (1, 6, 8, 10, 24 via M.I.A., 26, 27 partial, 28, 31, 32, 33, 35, 36, 40, 43, 44, 46
  (empty), 49, 50, 55, 58, plus M.I.A. prose carriers 4, 12, 22).
- Research-derived and **discarded** before State: 5, 7, 9, 11, 14, 16, 19, 25, 29, 30, 42, 51 (legacy) and 38 (first
  look).
- **Never requested** by production research, but requested by the frozen spec1 that production does not run: 3, 4,
  12, 15, 17, 18, 19, 20, 22, 23, 26, 27, 47.
- **Never captured anywhere:** 18, 20, 45 (rows), 47, 48, 60.
- **Incorrectly projected:** 10 (default rendered as fact), 22/42 (Yuwa as brand), 51 (market stats as her
  valuation), 19 (stale team after transfer).
- **Duplicated:** 14 (achievement dupes), 41 (Adidas in three stores, none canonical), 57 (two scores).
