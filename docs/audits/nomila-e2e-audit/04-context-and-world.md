# 04 — Context and the athlete's changing world (Agent D)

> Note (Nov 2026): voice web search no longer uses Tavily; it is one OpenAI web search (`voice/web-search` skill). The Tavily mentions below are as audited.

**Question:** Does Nomila know enough about the athlete's *changing world* to make genuinely timely Recommendations,
Plans and Campaigns? And how does the social-media-manager / weekly-plan work reconcile with Brain → planner →
Campaign → Creative Intelligence → Studio?

**Manifest:** main `9fff9b15`, stack `3f0139f6` (working tree), branch tips as pinned in `00-control.md`. Read-only.
Dev DB queries were SELECT-only (script deleted). The per-item inventory is in `12-context-inventory.md`.

State vs Context is kept apart throughout. **Athlete State** = durable facts about her (`server/services/intelligence/state/build.ts`).
**Context** = time-sensitive observations about her world (`ContextBlock`, `server/services/intelligence/brain/contract.ts:111-132`).
Nothing here recommends moving world items into State.

---

## 1. Summary

1. **Nomila has no acquisition, store or refresh for any time-sensitive world item.**
   - Missing: fixtures/schedule, season calendar/stage, team results, rankings-as-of-now, national-team windows,
     sport-wide events, holidays/awareness days, platform or category trends, peer activity.
   - No table exists for any of them on main, the stack or any of the ~452 remote tips. `shared/schema.ts` @ `9fff9b15`
     and @ `3f0139f6` have no fixture/schedule/season/event/trend/news table.
   - Dev DB: `information_schema.tables` has no `athlete_events`, `trend_observations` or fixtures table.
   - Status: **MISSING · —**.
2. **Every "timely" Brain decision on record used one hand-written file.** That file is
   `docs/audits/artifacts/brain-context-experiment-1/context-block.json` (`"assembledBy": "hand"`, `asOf 2026-09-26T02:40Z`,
   7 items including one control).
   - It was committed in `2034807d` (25 Sep): "the hand-assembled context fixture for 26 Sep – 16 Oct".
   - It was typed from gostanford.com, events.stanford.edu, NBC Sports, gorjana.com and formula1.com, following
     `context-block.template.json`.
   - It reaches the Brain only through a CLI flag: `--context <file>`, which is *required* for V3
     (`server/scripts/intelligence/brainLoopDurable.ts:47-48`, `brainRun.ts:8,31`).
   - `buildLiveBrainInputs` takes the file as an option; there is no collector behind it
     (`server/services/brainInputsBuilder.ts:35,109`).
   - Status: **EXPERIMENTAL · OPEN_PR (stack) · test-harness-only**.
3. **The "final live" durable Brain run fed the Brain that same 26 Sep file.**
   - The run was 27 Sep 23:11Z on 0.12.0-exp (`docs/audits/artifacts/brain-substrate-live/final-live.json`
     `inputs.context.asOf = 2026-09-26T02:40:00Z`).
   - By then `ctx[3]` (Stanford "Red Out", 26 Sep) was already in the past. Nothing re-checked the file.
   - None of the three live Recommendations cites any `ctx[n]`. The cites are
     `objective`, `findings[mia.narrative_power]`, `opportunity[...]` and `contentPerformance[tiktok]`.
   - The three Recommendations are timeless ("Target global brand and CSR partnerships…", "Target brand partnerships…
     EdTech…", "Reactivate her dormant TikTok channel…").
   - **Live output is not timely today.**
4. **The one place State can carry dates is empty for Mia.**
   - `State.dates[]` is built by `datesFrom` (`state/build.ts:491-514`) and has only three kinds:
     `deal_term_end`, `affiliation_started` and `inbound_deadline`.
   - It is empty in the live run (`final-live.json inputs.state.dates = []`). On dev, `term_end` is null on gorjana,
     `deal_deliverables` has 0 rows, and Mia's current affiliation has no `started_on`.
   - `constraints = []` by design: "Nomila does not today represent season windows, eligibility rules or exclusivity
     terms" (`build.ts:517-532`).
5. **What Nomila *does* hold about her world is static identity, and some of it is stale.**
   - Sport, school, D1 and ACC come from `athletes` and `athlete_affiliations`: "Stanford University", said at signup,
     `started_on null`, plus a found "U-17 USWNT" row (2022).
   - `career_status` is "active" for all 57 athletes.
   - Her research blob last changed **2026-09-03**. Since then, 25 daily `scheduled_refresh` snapshots re-carry the same
     `research` hash with `as_of 2026-09-03`.
   - `google_trends_score = 0` and `gdelt_article_count = 0` on every recent daily snapshot.
   - The monthly re-enrich cron runs `0 5 1 * *` (`server/index.ts:2231`).
   - Status: **BUILT · MAIN · deployed-dev** (identity) · **PARTIAL** (freshness).
6. **The research v2 substrate has typed keys that matter for timeliness, but none of it covers Mia.**
   - The keys are `ranking`, `season_statistic`, `award`, `national_team_participation`, `graduation_year` and
     `career_event` evidence (`research/factRegistry.ts:70-91`).
   - On dev, Mia has 0 `athlete_facts`, 0 `research_evidence` and no `athlete_research_state` row. The 35 athletes who do
     have facts are all unclaimed cohort athletes.
   - The planner is gated off: `RESEARCH_REFRESH_ENABLED=false` and `RESEARCH_SUBSTRATE_WRITE=false`
     (`gcp/cloud-run-dev.yaml:252-260`).
   - The facts are also retrospective, e.g. `ranking` "world cup overall standings 1995".
   - Status: **BUILT · MAIN · flag:RESEARCH_SUBSTRATE_WRITE=off, RESEARCH_REFRESH_ENABLED=off**.
7. **Controlled cases show the downstream chain can use a fixture. The acquisition half is missing.**
   - Controlled Objective overlay `ctl-obj-matchday-series`
     (`…/ci-boundary/slice/shape/objective-overlay-matchday.json`), with the hand `ctx[0]`/`ctx[1]` → Brain
     RECOMMEND `campaign`: "Launch a match-day content campaign across her channels to document every Stanford soccer
     match through the end of the season", citing `ctx[0]`, `ctx[1]` (`…/C23/C23.json`).
   - → router OK → the real Campaign writer created campaign `b18e8e39…` → a second run returned NO_ACTION, recognising the
     campaign in motion (`docs/audits/campaign-closed-loop.md:57-59`).
   - The content planner, handed the same move as a plan, escalated to `campaign`
     (`…/planner/E/E.json`, `specialized-plan-forcing.md:52-54`).
   - Status: **EXPERIMENTAL · OPEN_PR (stack) · test-harness-only**. The Objective is an overlay, not Mia's; the fixtures
     are hand-typed.
8. **"Season" has no calendar behind it.**
   - Objective horizon `this_season` and deferral `this_season` = **90 days hardcoded**
     (`contracts/objectiveEntity.ts:52`).
   - A campaign that "ends with objective_horizon" cannot be resolved to a real last match.
   - Status: **MISSING** (season-end knowledge).
9. **Studio has the only live, athlete-facing "moment" finder, and it is a separate, unstored path.**
   - It is `POST /studio/direction/research-moment` → `server/studio/direction/moment.ts:370` (one grounded Gemini
     Flash + Google Search call, "never dated by the model"; the date is "hers or nobody's").
   - It writes no research row, so Brain and planners never see what it found.
   - Studio's trend door `server/studio/direction/trend.ts` returns `available:false` by design.
   - Status: **BUILT · MAIN · flag:STUDIO_ALL_ON=on (dev) / STUDIO_ENABLED=false (prod)**.
10. **The client calendar is still a stub.**
    - `useFixtures()` returns `[]` with `isStub:true`, "SERVER: not built. No fixtures table."
      (`client/hooks/use-studio-pending.ts:294-297`, identical on main).
    - So Studio's posting-slot heuristic (`scheduleLogic.ts:121`, "3 h before kickoff") and fixture suggestions
      (`personalLogic.ts:32`) never fire.
    - Status: **DESIGNED/STUB · MAIN**.
11. **Weekly planning (#309) is still an unmerged pure function that reads posts and deals only.**
    - `deriveOccasions` is at `5dc4dcdc:server/skills/weeklyPlan.ts:118`. It emits 3 of 9 kinds.
    - `game_day`/`post_game` are blocked: "no athlete_events table (roadmap 3.2)" (`:27`).
    - `trend_observations` is a schema with no writer.
    - #608 recommends closing #309 with a pointer (`dce3cb0b:…/context-intelligence.md:142`).
    - Status: **PARTIAL · OPEN_PR #309 · no route/cron**.
12. **Peer Scout, Trend Miner, Analyst, Brief Composer and Outcome Loop were never implemented, on any branch.**
    - The social-media-manager plan's statement is **STILL TRUE**. Details in §4.
    - Status: **DESIGNED · DESIGN_DOC_ONLY**.
13. **Nomila has several un-joined "what should she make/do" paths:**
    - the Brain (stack)
    - #309 occasions (branch)
    - the Studio agent planner + Studio `CampaignBrief` (main)
    - Studio moment research (main)
    - Studio client fixture suggestions (stub)
    - the Nomi Card "activation plan"
    - the deal engine
    - Only the Brain is governed by Objectives. The others do not read Recommendations, and Recommendations do not reach
      them. Details in §5.
14. **World context has never changed a decision beyond timing.**
    - Across 56 gated runs (#638 corpus), all 30 `ctx` cites were the two schedule items plus one brand-absence item.
    - The recent result, campus occasion, USWNT window and control were never cited.
    - The Brain once converted a schedule gap into "a highly feasible operational window". This is now barred by an
      invariant (`brain/evalSpec.ts:29-30,114-118`).
    - Status: **EXPERIMENTAL**.
15. **Nomila can't do this today.** It can't detect an upcoming athlete moment by itself and turn it into a grounded
    Recommendation or Campaign. The first four links of the chain (acquire → store → interpret → render to the Brain)
    don't exist for any time-sensitive world item. The last links (recommend → route → Campaign) work in controlled
    runs with hand-typed context. See §6.

---

## 2. How the CONTEXT block was assembled (exactly)

| step | evidence |
|---|---|
| Design: "hand-assembled from real public sources… Assembled by hand once, committed with the artifacts, labelled as hand-assembled. Nothing from it enters State." Seven kinds, one of them a control. | `docs/architecture/commercial-intelligence/brain-context-experiment-1.md` §2.5 (lines 68-83) |
| Template with placeholders ("<next fixture: date, opponent, home/away — from the official schedule>") | `docs/audits/artifacts/brain-context-experiment-1/context-block.template.json` (commit `ae3434cb`) |
| Filled once from gostanford.com (schedule, SMU result, No. 6 ranking), events.stanford.edu (Red Out), NBC Sports (USWNT v Spain, 10 and 13 Oct), gorjana.com + Marketing Brew (brand activity, confidence MEDIUM) and formula1.com (control). Items carry `source.observedAt 2026-09-26`. | `context-block.json`, commit `2034807d` (2026-09-25) |
| Contract type: `CONTEXT_KINDS = schedule, recent_result, upcoming_occasion, sport_wide_hook, brand_activity, control`, `assembledBy: "hand"` ("Always 'hand' in experiment 1") | `brain/contract.ts:111-132` |
| Rendered as "Observations about the athlete's world… assembled by hand as of 2026-09-26T02:40:00Z… None is a verdict. Cite as ctx[<n>]." | `final-live.json record.rendered.contextBlock` |
| Loaded from disk by the operator scripts. No DB read, no provider call. | `brainLoopDurable.ts:47` (`JSON.parse(readFileSync(arg("--context")))`), `brainRun.ts --context`, `opportunityRun.ts:41` |
| Reused unchanged in the 27 Sep live substrate run. The manifest says "context 7". | `brain-reliability-0.12.0-checkpoint.md:204`; `final-live.json inputs.context` |

The same file is the Context input for all of these:
- the Stage 1 ablation (`arm-a/V3.json`)
- 1B / 1C
- the ci-boundary slice
- the match-day overlay runs
- the live run

For each of those runs, the item count below is the whole world Nomila's Brain has ever been shown about Mia:

| item | count |
|---|---|
| Stanford fixtures | 2 |
| team result | 1 |
| campus occasion | 1 |
| national-team hook | 1 |
| brand observation | 1 |
| control | 1 |

## 3. Existing work on the world, planning and context — classified

| work | what it actually is | classification | evidence |
|---|---|---|---|
| `feat/weekly-plan-spine` / PR #309 | `deriveOccasions` is pure code. It reads `media_assets`, `deals` and `inbox_threads.classification->>'deadline'` (`weeklyPlanInputs.ts:21`) and emits `cadence_gap` (14 d), `format_gap` (28 d) and `deal_deliverable`. Six kinds are blocked on data. It has no route, cron, Strategist or storage. Migration `0034_trend_observations` was never run; its number collides with the merged `0034_workflow_runner`. | **OPEN_PR · UNMERGED_BRANCH `5dc4dcdc`** | `5dc4dcdc:server/skills/weeklyPlan.ts:24-40,118,129,151,172`; `gh pr view 309` OPEN |
| `trend_observations` | Schema only (own_metric, own_format, peer_format, peer_theme, audio). No writer. | UNMERGED_BRANCH `5dc4dcdc` | migration 0034 on that SHA |
| `docs/plans/social-media-manager.md` | Plan: "Status: design, for review. Nothing implemented". It proposes `weeklyPlan.ts` (2 LLM calls), `researchSchedule` + `athlete_events` (§5.3), a `content_plan_items` hand-off to Studio, a compliance gate and an outcome loop. | **DESIGN_DOC_ONLY · MAIN** (arrived with squash #303, `9830e7ba`) | lines 3, 19, 354-437, 591-672, 842-866 |
| branch `claude/athlete-social-media-agent-8ff6ax` `f157b97b` | The code on it is Phase-1 infrastructure: prompt registry, tracing, `prompts` table. There is no social-agent code. | **MAIN** (squash PR #303, MERGED) | Agent-inventory check; `gh pr view 303` MERGED |
| `feat/schedule-as-form` `ce8c5167` | A contract *payment* schedule editor (`deal_periods` / `deal_installments`). **Not an athlete schedule.** | **MAIN** (squash PR #289, MERGED) | `ce8c5167:server/routes/dealContracts.ts:191-199,294` |
| Roadmap 3.2 `researchSchedule` + `athlete_events` | "resolve `school`… into a searchable competitive entity, grounded search, extraction, athlete confirmation". Blocks 3.3. | **DESIGN_DOC_ONLY · MAIN** | `docs/plans/00-roadmap.md:177` @ `9fff9b15` |
| Team resolution / school-team-sport mapping | `athlete_affiliations` (0041) with org_kind (school/club/pro/national/olympic), level, conference, position, started/ended. `athletes.school/division/conference` is a projection of it. Found teams come from research (`researchAthlete.ts:725`) and from `affiliationSync.ts:40` (substrate, off). State `competitionContextFrom` (`build.ts:571`). **No resolution to a schedulable competitive entity** ("Stanford women's soccer"). | **BUILT (identity) · MAIN**; schedulable-entity resolution **DESIGNED only** | `shared/schema.ts:2560` @ main; social-media-manager §5.3 |
| `career_status` | Column with values active / between_teams / out_this_season / retired (`factRegistry.ts:80`). Declared at onboarding. All 57 dev athletes are `active`. | **BUILT · MAIN** | dev: `select career_status, count(*) from athletes group by 1` → active 57 |
| Trends | Google Trends (`server/lib/trends.ts`) and GDELT (`server/lib/gdelt.ts`) are **per-athlete search-interest** signals feeding the score. They are not category, platform or cultural trends. Mia is 0/0. The Studio trend door returns `available:false`. | **BUILT (signal) · MAIN**; trends-as-context **MISSING** | dev snapshots; `studio/direction/trend.ts:15-20` |
| Holidays / awareness days / cultural moments | None stored. Only a narrator prompt mention of "holiday/gifting" (`services/narrator.ts:448`) and the Studio live moment search. | **MISSING** | Agent-inventory check |
| Relevant news | Legacy research `press_mentions` (Mia: 8, undated first item, e.g. ESPN "trailblazing South Asian-American in soccer"), with a monthly refresh; GDELT count 0. Mila chat web search is `MILA_WEB_SEARCH=false`; voice Tavily is `MILA_VOICE_WEB_SEARCH=true`. Neither search is stored. | **PARTIAL · MAIN** | dev `athlete_snapshots.research->'press_mentions'`; `gcp/cloud-run-dev.yaml:317-318,433-434` |
| Brand activity | `researchBrand.ts` → `inbox_brands.enrichment` (incl. `recent_campaigns`). It runs on first detection, is skipped if enriched in the last 90 days, and has a brand-refresh route with no scheduler. gorjana was enriched 2026-07-29. It does not reach the Brain except via the hand `ctx[5]`, and it reaches Studio via `getBrandContext`. | **BUILT · MAIN** (per-brand, stale-tolerant) | dev `inbox_brands` gorjana `enriched_at 2026-07-29` |
| Existing Campaigns | `campaigns`, `campaign_specs`, `campaign_deliverables` and `creative_intents` exist on the stack and on dev. **0 rows each on dev.** | **BUILT · OPEN_PR (stack) · deployed-dev (schema only)** | dev counts: campaigns 0, campaign_deliverables 0, creative_intents 0 |
| Obligations | `deal_deliverables` has 0 rows, and `term_end` is null on Mia's accepted gorjana deal. Rendered to the Brain as Existing Work with `deliverablesRecorded: 0`. | **BUILT (schema) · MAIN · empty** | dev counts; `final-live.json inputs.work` |
| Context Intelligence design, `docs/context-intelligence` `dce3cb0b` (#608) | Canonical principle: "Documentation only — nothing here is implemented". §8: "Out of scope now: any collector, any scheduler, any table for events". **Not on main or the stack.** | **DESIGN_DOC_ONLY · OPEN_PR #608** | `git cat-file -e` fails on both `9fff9b15` and `3f0139f6` |
| `context-opportunity-intelligence-checkpoint.md` (#638) | Evidence checkpoint. Keeps `context-block/0.1.0`, adds optional `occursAt`, `window` and `subject`, "no universal Context entity", "hand-assembled until then". | **DESIGN_DOC_ONLY · OPEN_PR #638 (on stack)** | lines 84-92, 135, 211 |
| `feat/ci-boundary-fixtures` `44b707a3` (#623) | "Fixtures" here means **test fixtures** (Mia, Ronaldo, Lilia commercial assessment), not sports fixtures. | **OPEN_PR #623** | Agent-inventory check |
| `brain-context-experiment-1.md` + artifacts | The hand block, Stage 1 V0–V3, 1B/1C, the ci-boundary slice | **EXPERIMENTAL · stack · test-harness-only** | §2 above |
| `adi/studio-athlete-context` `f49cd6df` | `getAthleteContext()` covers identity, score, capitals, research, achievements, causes and audience. **It has no schedule, season, trend or news field.** | **MAIN** (tip is an ancestor of main) | `f49cd6df:server/services/athleteContext.ts:88-151` |
| Studio `direction/moment.ts` (research_moment) | Live grounded search for "an upcoming or current fixture, milestone, event or cultural beat". The model's date is ignored and nothing is persisted. | **BUILT · MAIN · STUDIO_ALL_ON=true (dev), STUDIO_ENABLED=false (prod)** | `server/studio/direction/moment.ts:1-35,370` |
| Studio agent planner (`server/studio/agent/plan.ts`, `concepts.ts`) + `CampaignBrief` | The athlete's sentence + library → typed spend plan. Its "campaign" is a brand brief (`campaignBlock`, `plan.ts:372`), **not** the #570 Campaign entity. It reads sport only; no world context. | **BUILT · MAIN** | `9fff9b15:server/studio/agent/plan.ts:1-40,372-400` |
| Research refresh | Legacy monthly re-enrich (`index.ts:2231`, 1st of month, 05:00); Mia's last `research_refresh` workflow was 2026-09-03. The v2 planner (`research-planner` Scheduler job, `10 5 * * *`) is dry-run only (both flags off). | **BUILT · MAIN · flag:RESEARCH_REFRESH_ENABLED=off** | dev `workflow_runs`: research_refresh 3 done, last 2026-09-03 (all Mia) |
| Mila tools | 15 tools; **none** reads schedule, news or trends | **MAIN** | `ls server/mila/tools/` |
| Content planner | `planner-eval-spec/0.1.0-exp` exercised in forcing only; readiness reports "no planner owns the content domain today" | **EXPERIMENTAL · stack · deliberately not productionized** | `brain-reliability-0.12.0-checkpoint.md:227`; `brain/executionReadiness.ts:91` |

## 4. The five "agents": verification

- **The claim.** `docs/plans/social-media-manager.md:19` says: "Peer Scout, Trend Miner, Analyst, Brief Composer and Outcome
  Loop exist only in `docs/media-recommendation-engine-research.md`. Zero of them are in code."
  - The source doc is on main (`git cat-file -e 9fff9b15:docs/media-recommendation-engine-research.md` ✓).
  - The plan re-cast two of the five as non-agents: Brief Composer as "Deterministic assembly" (`:368`) and Outcome Loop as
    "A cron job + a SQL join. Not an agent" (`:369`).
- **The search.** Every remote tip, including all `studio/*`, `studio-video-v*` and `adi/*` branches, was grepped for
  `peer.?scout|trend.?miner|brief.?composer|outcome.?loop` over `server`, `client` and `shared`.
  - Only one false positive came back: `client/components/deals/brief/negotiateLogic.ts:18`, "Brief composer is a
    NEGOTIATE-only surface". That is the deal negotiation composer, on main.
  - Unmerged diffs were checked for athlete-world code. Every "fixtures" hit is a test fixture, and every "trending" hit is
    a comment or prompt. Example: `creativeBoundary.ts:7` "trending audio" names *out-of-scope* content.
- **Functional near-equivalents, none of them the named agent:**

  | named concept | nearest built thing | what it actually does | location |
  |---|---|---|---|
  | **Analyst** (own performance) | Social substrate: `social_features` feeding State `contentPerformance` / `audienceTrajectory`; also `refreshScores` | Performance analysis only. It isn't a content-recommendation analyst. | MAIN, deployed-dev (`SOCIAL_SUBSTRATE_WRITE` true on dev, false on prod) |
  | **Trend Miner** | `trend_observations` schema on #309 (no writer); Studio `trend.ts` | The Studio trend door returns `available:false` | #309 schema: UNMERGED; `trend.ts`: MAIN |
  | **Peer Scout** | Discovery collection of other athletes' public IG/YT (`collectDiscoveryAnalytics`) | Manual endpoint, not on a cron. Used for score and rate calibration only. | MAIN |
  | **Brief Composer** | Studio `assembleBrief` (`server/studio/brief.ts`) and the Studio agent planner | Both compose *creative* briefs from **athlete-chosen** objectives or sentences. Neither composes a brief from a Recommendation. | MAIN |
  | **Outcome Loop** | Stack outcome attribution ("as derivation, no outcome table", `00-control.md`); `content_posts` has 1 row on dev | — | stack |
- **Verdict: STILL TRUE.** None of the five was implemented as an agent on any branch.

## 5. How the social-media / weekly-plan work relates to Brain → planner → Campaign → Creative → Studio

Overlaps and duplications found. This is not a design.

1. **"Occasions" versus Context.**
   - #309's `deriveOccasions` emits `because`-provenanced *reasons to post*, e.g. `cadence_gap` and `deal_deliverable`.
   - #608 §7 already maps "occasion derivation" onto **continuous Context** and "plan-item shaping" onto **a specialized
     (content) planner**, and supersedes "#309 as the Brain's spine" (`dce3cb0b:…/context-intelligence.md:129-142`).
   - Two occasion kinds already exist elsewhere in the stack:
     - `cadence_gap` duplicates State `contentPerformance` (days since last post; "555 days since a TikTok post" drove the
       audience decisions).
     - `deal_deliverable` duplicates Existing Work plus `State.dates.deal_term_end`/`inbound_deadline`.
   - Merged as-is, #309 would be a second derivation of the same facts.
2. **Two planners claim the same job.**
   - social-media-manager §3 proposes a *Strategist* LLM step that "ranks and shapes a slate" of occasions. That is a WHAT
     decision.
   - The Brain owns WHAT/WHY ("You own WHAT and WHY. You do not own HOW", `brain/evalSpec.ts:73`).
   - The content planner (experimental) owns HOW for the content domain.
   - A weekly Strategist that picks which occasions to act on would be a **second recommendation system**: it is not governed
     by Objectives, and it ranks where the Brain is barred from ranking (`FORBIDDEN_DECISION_FIELDS` includes `rank`,
     `priority`, `evalSpec.ts:449`).
3. **Studio has three self-contained "what to make" paths, all athlete-initiated:**
   - the agent planner (her sentence → concepts → plan)
   - `research_moment` (live moment → `BriefProposal`)
   - fixture suggestions (stub)
   - None of them reads a Recommendation, Objective, CreativeIntent or #570 Campaign.
   - Studio's `CampaignBrief` shares the word "campaign" with the #570 Campaign but is a different object.
   - This agrees with the control: Studio is **creative execution**, not Creative Intelligence. The overlap is naming, plus
     the moment finder doing a context-acquisition job outside Context.
4. **Two moment/news acquirers with no shared store:**
   - Studio `research_moment` (Gemini + Search, not stored)
   - Mila voice/chat web search (Tavily / Gemini, not stored)
   - The legacy research `press_mentions` (monthly) is a third source. The Brain's context is a fourth, hand-typed.
   - Any collector would find none of these reusable as a store. #638 §10 ("no universal Context entity… the first source
     that will need a new identity is the schedule item") agrees.
5. **What does line up without duplication.** The chain Brain RECOMMEND(`campaign`) → router → #570 Campaign writer →
   `CampaignSpec → CreativeIntent[]` was exercised end to end on the match-day overlay (§1 item 7), with context cited by
   reference. social-media-manager's `researchSchedule` → `athlete_events` (propose, then athlete confirms) is the only
   written design for the missing **acquire → store** links. Its "unconfirmed event may shape a suggestion, never a claim"
   rule matches #638's "observation, never a verdict".

## 6. Can Nomila TODAY detect a meaningful upcoming athlete moment and turn it into a grounded Recommendation or Campaign?

**No.**

**Best actual examples:**

| example | what it shows | source |
|---|---|---|
| Stage 1 V3 | The audience recommendation was re-timed to "her upcoming mid-season home-game schedule gap", citing hand `ctx[0]`/`ctx[1]`. This is the only live-Objective decision context ever changed. | `docs/audits/brain-context-experiment-1-stage1.md:223,254` |
| Controlled match-day chain | → Campaign `b18e8e39…` (planning, 0 deliverables) → NO_ACTION on rerun. The Objective was a controlled overlay; the fixtures were hand-typed. | `campaign-closed-loop.md:57-59`, `recommendation-execution-shape-forcing.md:79-91` |
| Mia's real schedule | **No Nomila store holds it.** The only Stanford fixtures anywhere in Nomila are the two hand-typed lines in `context-block.json`: Syracuse 8 Oct away; Cal 16 Oct home. Dev has no schedule table. | `context-block.json` |
| Live run, 27 Sep | Zero `ctx` citations, three timeless Recommendations, all readiness `unavailable` | `final-live.json`; `brain-reliability-0.12.0-checkpoint.md:217-227` |

**Missing links, precisely:**

| link | status today | evidence |
|---|---|---|
| **Acquire** | Missing for fixtures, results, season stage, national windows, sport-wide events, holidays, trends and peers. Partial for brand (per-brand, 90-day), news (monthly `press_mentions`) and search interest (Trends/GDELT = 0 for Mia). The v2 research planner is off; Mia isn't in the substrate at all. Studio's live moment search is not a store. | §1 items 1, 5, 6, 9 |
| **Resolve identity** | "Stanford University · D1 · ACC" is not resolved to a schedulable entity ("Stanford women's soccer"). Designed in social-media-manager §5.3; not built. | §3 |
| **Store** | No `athlete_events`, fixture or context store. `State.dates[]` has 3 kinds and is empty for Mia. `trend_observations` exists only on #309 and has no writer. | `build.ts:491-514`; dev tables |
| **Interpret** | No Context → Opportunity path (`strategyIntelligence` null; "Context → Opportunity is design-supported and empirically unproven", #638 §18). Brain-side interpretation exists, with the invariant "schedule gap ≠ capacity" (`evalSpec.ts:29-30,114-118`). No materiality or relevance filter exists beyond the Brain's own reading. | #638 §12, §18 |
| **Render to Brain** | `renderContextBlock` exists, and `buildLiveBrainInputs` accepts `context`. But the only producer is a file on disk, the operator *requires* it (`brainLoopDurable.ts:48`), and no freshness check exists (a 26 Sep file was used on 27 Sep). | §2 |
| **Recommend** | Works in experiments (0.12.0-exp); `BRAIN_SUBSTRATE_LOOP` is off. `FORBIDDEN_DECISION_FIELDS` bans `date`/`schedule`, so a Recommendation carries timing only in prose. | `evalSpec.ts:449` |
| **Plan / Campaign** | The content planner is not productionized ("no planner owns the content domain today"). The Campaign writer works under simulated governance only. Campaign "ends with objective_horizon" has no real season end (`this_season` = 90 days hardcoded). Studio does not consume a CreativeIntent in production (see Agent G / E). | `executionReadiness.ts:91`; `objectiveEntity.ts:52` |

---

## 7. Prior findings re-verified

| prior finding | source | verdict | evidence |
|---|---|---|---|
| "There is no game, season, fixture or league data anywhere in the repo" | social-media-manager.md §0 (main @ `7df4aa7`) | **PARTIALLY SUPERSEDED** | League/conference now exists as identity (`athlete_affiliations.conference/level`, 0041). Game, season and fixture data: STILL TRUE on main, the stack and all tips. |
| Peer Scout, Trend Miner, Analyst, Brief Composer, Outcome Loop: "Zero of them are in code" | social-media-manager.md:19 | **STILL TRUE** | §4 |
| `school` holds the team; a schedulable-entity resolution is needed | social-media-manager.md §5.3 | **PARTIALLY SUPERSEDED** | `athlete_affiliations` replaced the text overload (the projection is still on `athletes.school`); schedulable resolution: STILL MISSING |
| Studio fixtures hook is a stub returning [] | recommendation-system-map.html §5, §6 | **STILL TRUE** | `use-studio-pending.ts:294-297` @ main and stack |
| PR #309 open, unmerged; 3 kinds fire; migration 0034 collides | recommendation-system-map.html §6, §13 | **STILL TRUE** | `gh pr view 309` OPEN; `5dc4dcdc:weeklyPlan.ts:24-31` |
| `trend_observations` proposed (0034), no writer | recommendation-system-map.html §1 | **STILL TRUE** | Not in the dev DB; no writer on any tip |
| "Weekly plans and schedules — Not built" | recommendation-system-map.html | **STILL TRUE** | — |
| `State.dates[]` empty for every athlete | context-intelligence.md (#608) §4 / #638 §2 | **STILL TRUE for Mia** at the live run (`final-live.json`); other athletes not re-checked (UNKNOWN) | — |
| `research_evidence` signal rows "read by nothing" (Mia 0) | #608:38-39; #638 §3 | **PARTIALLY SUPERSEDED** | On dev today there are **no** `signal`-kind rows at all (kinds listed; none is `signal`), and Mia has 0 `research_evidence` rows. Trends/GDELT live in `athlete_snapshots` columns instead. |
| Context block is a hand-assembled experimental envelope, not a contract | brain-context-experiment-1.md §2.5 | **STILL TRUE** | Still `assembledBy:"hand"` in the live run |
| Only athlete-proximate schedule context was ever cited; world context never | brain-context-experiment-1-stage1.md §8; #638 §2 (30 ctx cites) | **STILL TRUE** through 0.12.0; the live run cited no ctx at all | — |
| Schedule gap → capacity inference (R4) lacked an invariant | #638 §4, §15 | **SUPERSEDED** | Invariant now in the spec (`brain/evalSpec.ts:29-30,114-118`); not re-measured by a provider run (UNKNOWN whether it holds) |
| Context → Opportunity is design-only (`strategyIntelligence` null) | #638 §12 | **STILL TRUE** | Opportunity spec "You perform NO external research" (`opportunity/evalSpec.ts:159`) |
| "Hand-assembled until [stores exist]"; no collector | #638 §5, §15 | **STILL TRUE** | — |
| gorjana: no term dates, no deliverables | brain-context-experiment-1.md §2.4 | **STILL TRUE** | dev: `term_end` null; `deal_deliverables` 0 |
| "league/team calendar for scheduling" belongs to Plan/Campaign, not Objectives | targeted-intelligence-audit.md §4 | **STILL TRUE as design**; nothing in Plan/Campaign acquires it either | — |
| Targeted research as Opportunity pass 2 | targeted-intelligence-audit.md §1 | **PARTIALLY SUPERSEDED** by #638 A1 (the Intelligence Request is the targeted mechanism) | Only the `mila_question` mechanism is implemented, dev-harness only (`intelligenceAcquisition.ts`, stack) |
| Mila web search on in prod | `server/mila/proseSanitizer.ts:5` comment | **CONTRADICTED** | `MILA_WEB_SEARCH` is `"false"` in `gcp/cloud-run-dev.yaml:433-434` (and prod yaml per the inventory check) |

## 8. UNKNOWNs

- **Whether a store-projected context block would read the same to the Brain as the hand block.** Settle it with a collector
  plus one run (#638 §15).
- **Whether the "schedule gap ≠ capacity" invariant holds.** No provider run since it was added reused `ctx[0]`/`ctx[1]` on the
  audience decision. The live run didn't cite ctx at all. Settle it with the §16 R4 run (#638).
- **Mia's actual Stanford schedule after 26 Sep, and her personal role (starter, minutes).** Nomila holds none of it.
  `ctx[2]` says "the athlete's own part… is not reported".
- **Whether `State.dates[]` is non-empty for any other athlete.** Settle it with a State build per athlete (not run).
- **Whether the 1 Oct monthly re-enrich will run for Mia and change anything.** It runs with `NODE_ENV=production` per the
  inventory check. Settle it with the next `workflow_runs` / `athlete_snapshots` read after 1 Oct.
- **Whether Studio `research_moment` has ever been called for Mia on dev.** No persistence exists to query. Settle it with
  Cloud Run logs (Studio cost line).

## 9. Open questions for the founder

1. **Acquire first or govern first?** The first collector #608/#638 point at is the schedule item. Should it be built
   (roadmap 3.2 `researchSchedule` + `athlete_events`, athlete-confirmed) before any more Brain contract work? Everything
   downstream of "render to Brain" already works on hand-typed input.
2. **What to do with PR #309 and the social-media-manager plan now.**
   - #608 says close #309 with a pointer.
   - The plan's Strategist overlaps the Brain.
   - Keep `researchSchedule` + confirmation as the Context-acquisition design, and retire the rest?
3. **Should Studio's live moment finder and Mila's web searches write what they find as Context evidence?** The alternative
   is they stay ephemeral, athlete-initiated tools.
4. **Naming.** Studio's `CampaignBrief` and the #570 Campaign are different objects. Is one to be renamed before both are
   athlete-visible?
5. **Season end.** Is a season's end athlete-asserted, or researched? Today `this_season` is a hardcoded 90 days.
