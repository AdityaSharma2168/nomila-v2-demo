# 12 — Context inventory: the athlete's world, item by item (Agent D)

> Note (Nov 2026): voice web search no longer uses Tavily; it is one OpenAI web search (`voice/web-search` skill). The Tavily mentions below are as audited.

There is one row per world item. The narrative and evidence are in `04-context-and-world.md`. Manifest: main `9fff9b15`,
stack `3f0139f6`. Dev DB reads were SELECT-only.

**Class** marks whether each item is an Athlete State fact (S) or Context (C). S means durable facts about her. C means
time-sensitive observations about her world, read only via `ctx[n]`. Where a row says "Brain: hand ctx", the only way
the item has ever reached the Brain is the hand-typed file `docs/audits/artifacts/brain-context-experiment-1/context-block.json`
(asOf 2026-09-26, passed with `--context`). That file was reused unchanged in the 27 Sep live run, `final-live.json`.

## Column key

| column | meaning |
|---|---|
| Known? | Does Nomila know this item for Mia today? (Y / Partial / N) |
| How | Code path and provider |
| Freshness | How fresh the data is and how often it refreshes |
| Stored | Where it is stored |
| Interprets | Who interprets it |
| Brain | Whether the Brain sees it |
| Planner | Whether the content or outreach planner sees it |
| Studio | Whether Studio / Creative sees it |
| Cause? | Whether it can cause a Recommendation or Campaign |
| Status · Location | Implementation status · where the code lives |

## Inventory

| # | Item | Known? | How | Freshness | Stored | Interprets | Brain | Planner | Studio | Cause? | Status · Location |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Sport (S) | **Y** ("soccer") | Onboarding assertion (`mila/tools/completeOnboardingStep.ts:30`); legacy research fills it only if null (`researchAthlete.ts:758`, Gemini+Kimi); v2 fact `sport` | Declared once. Research is monthly (`index.ts:2231`) | `athletes.sport`; `athlete_facts` (not for Mia) | State builder | Y: `state.identity.sport` | Via the handoff/State only | Y: `getAthleteContext`, Studio agent `campaignBlock` (sport) | Indirectly (grounds findings) | BUILT · MAIN · deployed-dev |
| 2 | Discipline / position / event (S) | **N** for Mia (the affiliation `position` is null) | Affiliation `position`; v2 facts `position`/`event` (`factRegistry.ts:74-75`) | Affiliations TTL 180 d (v2, off) | `athlete_affiliations.position`, `athlete_facts` | — | **N**: not in State | N | N | N | PARTIAL · MAIN · flag:RESEARCH_SUBSTRATE_WRITE=off |
| 3 | Team / club / school, current affiliation (S) | **Y** ("Stanford University · D1 · ACC", said at signup, `started_on` null; found "U-17 USWNT" 2022, ended) | `athlete_affiliations` (0041); research found teams (`researchAthlete.ts:725`); `affiliationSync.ts:40` (off) | Signup / research; last research 2026-09-03 | `athlete_affiliations`; projection `athletes.school/division/conference` | `competitionContextFrom` (`state/build.ts:571`) | Y: `identity.competitionContext` "Stanford University · D1" | Only as State | Y: athleteContext org/division/conference | Indirectly | BUILT · MAIN · deployed-dev |
| 3b | Team roster / teammates | **N** | None | — | — | — | N | N | N (the Studio planner explicitly bars inventing teammates, `plan.ts:149-155`) | N | MISSING |
| 4 | League / conference / federation / governing body (S) | **Partial** (conference "ACC" only; no federation) | Affiliation `conference/level`; research spec S2 `league_level_division` | As #3 | `athlete_affiliations.conference` | State shows org·level only (conference not rendered) | Partial | N | Y (conference) | N | PARTIAL · MAIN |
| 5 | Season calendar and stage (C) | **N** | None. `constraintsFrom` says season windows are not represented (`build.ts:517-532`). `this_season` = 90 days hardcoded (`contracts/objectiveEntity.ts:52`) | — | — | — | N | N | N | N (a Campaign "ends with objective_horizon" can't be resolved to a real season end) | MISSING |
| 6 | Schedule / fixtures (C) | **N in any store**. Only 2 hand-typed items: away at Syracuse 8 Oct; home v Cal 16 Oct | Hand from gostanford.com. #309 `game_day` blocked (`5dc4dcdc:weeklyPlan.ts:27`). Client `useFixtures()` stub [] (`use-studio-pending.ts:294`). Studio `research_moment` may *mention* one live, unstored and undated (`studio/direction/moment.ts`) | Hand, once (26 Sep); never refreshed | `context-block.json` only | Brain (Decision-relative); invariant "schedule gap ≠ capacity" (`evalSpec.ts:29-30,114-118`) | Hand ctx[0], ctx[1]: the only ctx ever cited (re-timed the Stage 1 V3 audience rec; grounded the controlled match-day campaign) | Controlled only (planner E escalated the match-day move to campaign) | N (the stub never fires) | **Yes in controlled runs only** | EXPERIMENTAL · OPEN_PR stack · test-harness-only; store MISSING; `researchSchedule`/`athlete_events` DESIGN_DOC_ONLY (roadmap 3.2, social-media-manager §5.3) |
| 7 | Opponents / rivalries (C) | **N** (opponent names appear in the hand ctx prose only) | Hand ctx | Once | ctx file | Brain | Hand ctx (prose) | N | N | N | MISSING |
| 8 | Competitions / tournaments / postseason (C) | **N** (forward-looking); past only via achievements | Legacy research achievements; v2 `achievement`/`award` facts (not for Mia) | Monthly (legacy) | `athlete_snapshots.research.achievements` | MIA findings → State `findings` | Only as past findings | N | Y (achievements, marquee via athleteContext) | N (for timing) | PARTIAL (history) · MAIN; forward MISSING |
| 9a | Results / performance, athlete (S/C) | **Partial**: historical achievements; current-season stats N. The hand ctx says "the athlete's own part in the SMU match is not reported" | Legacy research; v2 `season_statistic`/`ranking` facts (cohort only, retrospective, e.g. "world cup overall standings 1995") | Monthly; Mia's research `as_of` 2026-09-03 | snapshot research; `athlete_facts` | MIA → State findings | Past only | N | Y (achievements) | N | PARTIAL · MAIN · flag:RESEARCH_REFRESH_ENABLED=off |
| 9b | Results / rankings, team (C) | **Hand only** ("0–0 at SMU… 8-2-2… ranked No. 6") | Hand ctx[2] | Once | ctx file | Brain | Hand ctx[2]; never cited in 56 runs (#638 §2) | N | N | N | EXPERIMENTAL · test-harness-only |
| 10 | National-team windows / call-ups (C) | **N** forward. The found "U-17 USWNT" 2022 row is historical. USWNT v Spain (10, 13 Oct) appears as hand ctx[4] | Research affiliation (org_kind national); v2 `national_team_participation` fact; hand ctx | Research monthly; hand once | `athlete_affiliations`; ctx file | State `competitionContext` = primary only (the national row is not primary) | Hand ctx[4]; never cited | N | athleteContext `alsoNational` | N | PARTIAL (history) · MAIN; windows MISSING |
| 11 | Draft / transfer / graduation / contract milestones (S) | **Partial**: graduation/class year and career events via research (not for Mia in the substrate); contract milestones N (`term_end` null on gorjana); draft N | v2 `graduation_year`/`class_year`/`career_event` evidence; `deals.term_end` → `State.dates.deal_term_end` | Research; deals when recorded | `athlete_facts`, `research_evidence`, `deals` | `datesFrom` (`state/build.ts:491-514`) | Only via `dates` (empty for Mia) | N | N | Would, via `dates`, if populated | PARTIAL · MAIN; empty for Mia |
| 12 | Awards (S) | **Partial** (legacy research achievements) | Legacy research; v2 `award` fact | Monthly | snapshot research | MIA findings | As findings (past) | N | Y (achievements) | N (for timing) | PARTIAL · MAIN |
| 13 | Major sport-wide events (C) | **N** (hand ctx[4] only) | Hand | Once | ctx file | Brain | Hand; never cited | N | Studio `research_moment` live, unstored | N | MISSING (store); EXPERIMENTAL (hand) |
| 14 | Athlete milestones (birthday, anniversaries, follower milestones) (S/C) | **N**. `birth_year` exists for minor policy only; #309 `milestone` blocked on analytics deltas | — | — | — | — | N | N | N | N | MISSING; #309 kind DESIGNED · OPEN_PR |
| 15 | Team moments (senior day, home opener, rivalry week) (C) | **N** (hand ctx[3] "Red Out" was a football campus event, already past at the 27 Sep live run) | Hand | Once | ctx file | Brain | Hand; never cited | N | N | N | MISSING |
| 16 | Relevant news / press (C) | **Partial**: 8 `press_mentions` (first item undated, "ESPN… trailblazing South Asian-American in soccer"); GDELT 0 | Legacy research "Performance + Press" + GDELT (`lib/gdelt.ts`); Mila voice Tavily (`MILA_VOICE_WEB_SEARCH=true`, not stored); Mila chat grounding `MILA_WEB_SEARCH=false` | Monthly; research `as_of` 2026-09-03; daily snapshots re-carry it | `athlete_snapshots.research.press_mentions`, `gdelt_article_count` | MIA findings (narrative) | Not as news; only via State findings | N | Via athleteContext research | N | PARTIAL · MAIN |
| 17 | Brand activity / campaigns (C) | **Partial**: per-brand enrichment (gorjana enriched 2026-07-29, incl. `recent_campaigns`); hand ctx[5] "No dated drop, campaign or event is announced" | `researchBrand.ts` (3 Gemini grounded + Kimi) → `inbox_brands.enrichment` | On first detection; skip if <90 d; refresh route has no scheduler | `inbox_brands`, `brand_fit_narratives` | Brand intelligence projection (Decision Subject `brand`) | Hand ctx[5] (cited once as absence); brand projection on subjects | Outreach planner (off) via subjects | Y: `getBrandContext` → Studio brief (`studio/brief.ts:958`) | Not observed | BUILT · MAIN (per-brand, stale-tolerant) |
| 18 | Category trends (C) | **N** | None (brand `industry` only) | — | — | — | N | N | N | N | MISSING |
| 19 | Cultural / calendar moments: holidays, awareness days, school moments, local/community events (C) | **N** | None stored. Narrator prompt mentions "holiday/gifting" (`services/narrator.ts:448`); Studio `research_moment` live search (unstored, undated by design) | — | — | — | N | N | Live search only, when she asks | N | MISSING (store); Studio search BUILT · MAIN · STUDIO_ALL_ON=true dev / STUDIO_ENABLED=false prod |
| 20 | Causes (S) | **Y** (Yuwa) | Legacy research values/causes; onboarding "brands & causes" (`mila/onboarding.ts:88`); athlete assertions | Research monthly; assertions when made | snapshot research; `athlete_asserted` | MIA findings; Objective `b1c799e3` (impact) | Y: `findings[mia.narrative_power]`, live Objective | Would (impact planner: none exists) | Y: athleteContext `causes` | **Yes** (live Rec on Yuwa, timeless) | BUILT · MAIN |
| 21 | Audience / content performance and trends (S) | **Y** (TikTok idle 557 d; IG cooling; 0.23 posts/wk) | IG/TikTok/YT analytics, daily `30 4 * * *`; IG Stories `20 */8`; social substrate | Daily (Mia `social_features` as_of 2026-09-27) | `social_features`, `social_analytics_snapshots`, `social_audience_distributions` | State `contentPerformance` / `audienceTrajectory` | **Y** (drives the audience Rec) | Content planner (experimental) via handoff | Y (athleteContext audience) | **Yes** (live Rec "Reactivate her dormant TikTok channel…") | BUILT · MAIN · deployed-dev (`SOCIAL_SUBSTRATE_WRITE` dev=true, prod=false) |
| 22 | Platform trends (formats, audio, what's working) (C) | **N** | Studio `direction/trend.ts` returns `available:false` by design; #309 `trend_observations` schema, no writer; `creativeBoundary.ts:7` names "trending audio" as out of scope | — | — | — | N | N | N (door says unavailable) | N | MISSING; schema UNMERGED_BRANCH `5dc4dcdc` |
| 23 | Peer / competitor athlete activity (C) | **N** (for timing) | Discovery collection of other athletes' public IG/YT (manual endpoint, no cron) for score/rate calibration | Manual | `social_analytics_snapshots` source='discovery' | Scoring / rate | N | N | N | N | PARTIAL (calibration only) · MAIN; "Peer Scout" DESIGN_DOC_ONLY |
| 24 | Search interest (Google Trends / GDELT) (S-signal) | **Y but zero** (0 / 0 on every recent Mia snapshot) | `lib/trends.ts`, `lib/gdelt.ts` inside legacy research | Monthly; carried daily | `athlete_snapshots.google_trends_score`, `gdelt_article_count` | Score engine | N (not in State) | N | N | N | BUILT · MAIN |
| 25 | Existing obligations / deliverables (S, via Existing Work) | **N** (gorjana accepted; 0 deliverables; `term_end` null) | Contract extraction → `deal_deliverables`/`deal_periods` | When a contract is uploaded | `deal_deliverables` (0 rows on dev) | Existing Work assembler | Y as absence (`deliverablesRecorded: 0`) | Outreach planner exclusions | Studio "owed" row (`listOutstandingDeliverables`, 0) | Would | BUILT (schema) · MAIN · empty |
| 26 | Existing Campaigns (Existing Work) | **N** (0 `campaigns` rows on dev) | #570 Campaign writer (stack); Studio `CampaignBrief` is a different object | — | `campaigns`, `campaign_specs`, `campaign_deliverables` | Existing Work projection | Y when present (controlled L2 → NO_ACTION) | — | Not wired to the #570 Campaign | Yes (controlled) | BUILT · OPEN_PR stack · deployed-dev (schema only) |

## Roll-up

| status | rows |
|---|---|
| Known and fresh | #1 sport, #3 affiliation (identity), #20 causes, #21 audience/content |
| Known but stale or partial | #4, #8, #9a, #11, #12, #16, #17, #23, #24 |
| Hand-typed only (experimental envelope, never refreshed) | #6, #7, #9b, #10 (window), #13, #15 |
| Not known at all | #2 (for Mia), #3b, #5, #14, #18, #19, #22, #25, #26 (none exist) |

The items that are *time-sensitive by nature* are #5–#10, #13–#19, #22 and #23. For every one of them, Nomila has
no store and no refresh, and the Brain has never seen them except by hand.
