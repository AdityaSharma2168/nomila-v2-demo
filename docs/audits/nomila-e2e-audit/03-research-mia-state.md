# 03 — Research, M.I.A. / marketability intelligence, and Athlete State (Agent C)

Scope: *does Nomila understand WHY this athlete is commercially interesting, or merely store facts?* and *are we
asking providers to research deeply enough for the product we are building?* Read-only. Working tree = `3f0139f6`
(#665 tip). Main = `9fff9b15`. Dev DB queried read-only through the Cloud SQL proxy (`SET default_transaction_read_only
= on`); queries are quoted in brief beside each claim. The athlete-level data inventory is in
`11-data-research-inventory.md`.

---

## 1. Summary

1. **Two research pipelines exist, and they don't share anything.** (a) The *legacy* `researchAthlete` pipeline
   (5 Gemini-grounded queries, then Kimi extraction) feeds `athlete_snapshots.research`, the v7.2 /850 score, the
   athlete's own Record, and Studio/deck. (b) The *M.I.A. Beta.1 evaluator* does its **own** grounded research from
   **name + sport + a social block only**, and feeds `intelligence_ledger`, which feeds Athlete State and the Brain.
   Neither reads the other. `research_refresh` v2 says so explicitly: *"The M.I.A. evaluator performs its OWN
   grounded research and never reads Nomila's research substrate"* (`server/workflow/definitions/researchRefresh.ts:66-74`).
   **BUILT · MAIN · deployed-dev** (both).
2. **Athlete State reads no research at all.** `buildAthleteState` reads `athletes`, the current M.I.A. ledger row,
   `athlete_affiliations`, `athlete_asserted`, `deals`, `inbox_threads`, `social_audience_distributions` and
   `social_features`. It never reads `athlete_snapshots.research`, `athlete_facts`, `research_evidence` or
   `athletes_current` (`server/services/intelligence/state/build.ts:129-177`). Everything the Brain "knows" about her
   athletic record, story, press, causes and brand history arrives only as **M.I.A.'s prose and citations**.
   **BUILT · MAIN** (`athlete-state/1.2.0`; `build.ts` identical on `9fff9b15` and `3f0139f6`).
3. **The spec-grade research contract is not the production path.** `research-spec/1` (9 sections, 55 items,
   including injuries, transfers, milestones, representation, ventures, causes, reputation) is frozen
   (`server/services/intelligence/research/spec/researchSpecV1.ts:45-119`). But `runDirectResearch` is called only by
   a calibration CLI (`server/scripts/calibration/runDirectResearch.ts:52`). Production signup, admin re-research and
   the monthly sweep all call legacy `researchAthlete` (`onboarding.ts:70,146`, `researchRefresh.ts:38`,
   `reEnrichAthletes.ts:60`). **Spec: BUILT · MAIN · test-harness-only. Production: legacy.**
4. **The research substrate is a frozen calibration artefact, and no product athlete is in it.** It holds 72
   `research_runs`, 3,530 `research_evidence` rows and 883 `athlete_facts`, **all** from 13–14 Sep, provider
   `gemini_direct`, across 35 cohort athletes. It has **0 rows for any enriched/active athlete (Mia included)**
   (`select count(*) from research_evidence where athlete_id in (… status in ('enriched','active','claimed'))` → 0).
   588 of the 883 facts (67%) are `disputed`. Both flags are off on dev (`RESEARCH_SUBSTRATE_WRITE=false`,
   `RESEARCH_REFRESH_ENABLED=false`, confirmed with `gcloud run services describe`, rev `nomila-v2-00757-gs2`).
   **EXPERIMENTAL · MAIN · flag:RESEARCH_SUBSTRATE_WRITE=off · HISTORICAL_ARTIFACT (data).**
5. **Legacy research asks narrow, college/NIL-shaped questions.** It has no request for injuries, transfers,
   career status, representation, ventures, causes/values, interests, graduation/draft, reputation or schedule
   (`server/skills/researchAthlete.ts:186-218`, schema `:61-89`). Asking is not the same as getting: fields that
   *are* requested come back noisy. Mia's `nil_valuation_mentions` include market statistics that are not about her
   (*"73.5% of all D1 NIL compensation goes to male athletes"*). Her nonprofit Yuwa is extracted **twice as a brand
   `partnership`**. All 8 press mentions have `date: null`. Her 33 achievements contain duplicates ("ACC Champion"
   ×2, "College Cup" ×5 variants).
6. **M.I.A. identifies an athlete from name + sport alone, and can be confidently wrong.** The evaluator prompt
   carries `Name`, `Sport` and the social block, with no school, team or anchor
   (`server/services/marketabilityBeta1EvaluatorSpec.ts:432-435`). On dev, "Aditya Sharma / soccer" was evaluated as
   *"an active professional goalkeeper playing for Calangute Association in the Goa Professional League"* with
   `identityConfidence: HIGH` (ledger, current row). Legacy research for the same account found a *different*
   namesake (Malvern Prep defensive midfielder). His own onboarding assertion says sport = *Basketball*.
   **BUILT · MAIN · deployed-dev.**
7. **M.I.A. reasoning mostly survives into State, but not all of it.** Per-dimension prose, confidence reasons, cited
   evidence (URLs) and component scores reach the Brain's state block (`build.ts:266-300`; rendered in
   `docs/audits/artifacts/brain-substrate-live/final-live.json` → `record.rendered.stateBlock`). Four things are dropped:
   the **summary**, `notes.strengths`, `notes.constraints` (including *"High academic load … may limit her availability
   for extensive commercial activations"*, a real constraint) and `notes.evaluationRisks`. Only
   `importantMissingData` becomes `materialGaps` (`build.ts:202-204`). The M.I.A. /850 score itself (Mia **624**) is
   not in State either.
8. **Two scores, two stories.** The athlete sees v7.2 **672 / Established** with capitals audience 100 · athletic 91
   (`athletes_current`; Record `views/record.ts:193-194`). The Brain reasons from M.I.A. 624 with `audience_scale 41 (GAP)`.
   v7.2's audience capital reaches **100** at 8k–37k followers (Aditya 100 on 45 IG / 8,000 TT; Lara 100; Matt 100;
   Mia 100) (`select … capitals from athletes_current`). No route serves the M.I.A. ledger to the athlete (only
   intelligence code reads `intelligence_ledger`). **v7.2: BUILT · MAIN · deployed-dev (live score). M.I.A.: BUILT ·
   MAIN · deployed-dev (feeds State only).**
9. **What the athlete says mostly doesn't reach State.** Mia's only assertion, *"Personal contract with Adidas; Nike
   is Stanford-affiliated"* (field `note`), is not projected. State reads assertions only when the field name matches
   `/prefer|want|avoid|refus|wont|won_t|interest|goal/` or `/availab|constraint|schedule|eligib/`
   (`build.ts:533,556`). Of the 15 `ASSERTED_FIELDS` (`server/mila/onboarding.ts:67-90`), `note`, `never_post` (a
   refusal), `cadence`, `brands_causes`, `hobbies`, `brand_voice`, `position`, `class_year` and `hometown` never reach
   State. No asserted field can ever produce a State *constraint*. The Brain acquisition seam writes `cadence`, and its
   own header admits *"no State reader keys on it"* (`server/workflow/definitions/intelligenceAcquisition.ts:30-32`).
10. **Adidas, her marquee commercial relationship, is prose everywhere and a fact nowhere.** State
    `commercialPosition.activeRelationships = ["gorjana"]` (final-live stateBlock). Adidas appears only as M.I.A.
    evidence E4 and in the legacy `brand_mentions`. `deals` has no Adidas row. `deal_deliverables`/`deal_periods`/
    `deal_installments` = 0/0/0 rows. `deals` has no category or exclusivity column
    (`information_schema.columns` for `deals`).
11. **Things research knows get discarded, even when the athlete's reality changed.** Lara Somfai's legacy research
    and her M.I.A. summary both say she transferred **Stanford → TCU**. Her only affiliation row is the signup "said"
    *Stanford University · D1*. Research may never write school (`researchAthlete.ts:759-760`), and no found TCU
    affiliation was proposed (`teams` = 0 in her research). State would render the wrong team. Research also knows
    position, class year, hometown, achievements, press and story arc. All of it stops at the snapshot, the Record and
    Studio.
12. **Research freshness is weaker than it looks.** True research for product athletes ran on 1 Sep (monthly sweep)
    or 3 Sep (Mia, manual). The nightly `scheduled_refresh` re-inserts the research blob with a fresh `created_at` (247
    such rows). Onboarding v2 treats research younger than 7 days as fresh, and on the unlisted-reader path it dates
    research by `created_at` (`onboarding.ts:93,135`, `CANONICAL_CONTEXT_READERS=""`). So carried-forward research
    reads as fresh indefinitely. M.I.A. is never re-run on research, deals or inbox changes. Its triggers are signup,
    social-block change, admin and user refresh only (`marketabilityBeta1Snapshot.ts:31-36`; callers `auth.ts:153`,
    `socialSync.ts:144`, `admin.ts:327`).
13. **The social substrate is the richest real input, and State carries a thin slice of it.** Mia has 38 platform×feature keys
    and 8,900 audience-distribution rows. There are ≈20.5k content-level observations (IG 12.6k, TikTok 7.9k).
    State carries followers, top country/age/gender for **Instagram only**, and 6 content keys. TikTok per-video
    views/likes/shares (1,892 each) are never turned into features, so State shows TikTok as only *"557.3 days since
    last post"*. Engagement-per-follower, non-follower reach, saves/shares, `performance_cv` and city are not in State.
    **Stories: 0 observations.** Social features exist for only 3 athletes.
14. **Studio/deck and the Brain see different athletes.** Studio's `getAthleteContext` reads legacy research
    (achievements, `brand_mentions` as "undisclosed" partners, story arc), v7.2 score and assertions
    (`server/services/athleteContext.ts:205-225,272-317`). It never reads M.I.A. or State. Its `causes` field reads
    `research.values ?? research.causes`, which **no snapshot has ever contained** (`… where research ? 'values' or
    research ? 'causes'` → 0). So Yuwa reaches Studio only as a "brand partner".
15. **Verdict on the two questions.** *Why is she commercially interesting?* The **M.I.A. evaluator** does
    understand. Its prose for Mia is specific and cited (first player of Indian descent for a US FIFA team, 2.5-year
    Symbolic Systems degree, Yuwa, Adidas campaign). That understanding reaches the Brain, but as an evaluator's
    opinion, and some of it is ungrounded or contradicts other data (see §4.3). Everything else Nomila "knows" is stored
    facts that the strategy layer never sees. *Are we asking deeply enough?* The frozen `research-spec/1` asks deeply
    enough for the athlete half of the product. Production does not run it, and nothing downstream would read it if it
    did.

---

## 2. Research — what actually runs

### 2.1 Production path: legacy `researchAthlete` (BUILT · MAIN · deployed-dev · deployed-prod UNKNOWN)

| aspect | evidence |
|---|---|
| Entry points | signup: onboarding v1/v2 `research` step (`server/workflow/definitions/onboarding.ts:70,146`). Admin re-research: `research_refresh` v1 (`researchRefresh.ts:22-43`). Monthly sweep: `reEnrichAllAthletes`, cron `0 5 1 * *` under `NODE_ENV=production` (`server/index.ts:1991,2230-2240`; `reEnrichAthletes.ts:60`). Admin endpoint (`server/index.ts:311`). |
| Search provider/model | Gemini `GEMINI.flash` (= `gemini-3.5-flash` unless overridden, `server/lib/models.ts:121`), `googleSearch` tool, temperature 1.0, `thinkingBudget: 256`, up to 5 retries on empty (`researchAthlete.ts:226-294`). 5 queries run in parallel. The file header still says "4 parallel searches" (`:4`). |
| System prompt (quote) | *"You are a sports research analyst compiling a verified athlete dossier. … Search multiple distinct facets: profile and background, social media accounts, local and national press, conference and league awards, statistics and records, brand partnerships, and media assets."* (`:42-48`) |
| The 5 queries | "Profile + Social" (name, hometown, class year, position, conference, roster bio, personal background, current/past teams). "Commercial + Brand" (NIL deals, partnerships, **NIL valuation 2024-2026, On3, Opendorse**). "Performance + Press" (All-American, all-conference, stats, records, awards, academic honors, press). "Media Assets" (highlight videos, Getty photos, podcasts). "Social Handles". All at `:186-218`. |
| Extraction | Kimi `kimiInstant`, JSON schema `:61-89`. Fields: `profile{sport, school, hometown, class_year, position, conference, division}`, `social_handles{ig, tiktok, x, youtube}`, `achievements[]`, `teams[]`, `press_mentions[]`, `brand_deals[]`, `nil_valuation_mentions[]`, `media_assets{images, videos, audio}`, `story_arc` ("2-3 sentence narrative summary"), `sentiment{positive, negative}`. |
| Side inputs | Google Trends interest score + GDELT 30-day articles/tone, appended as text to each Kimi prompt (`:535-575`). Platform discovery for public IG/YouTube (`:611-618`). Connected analytics win over discovery (`:656-660`). |
| Merge | Profile/handles: first non-null wins (`:363-377`). Lists: union with dedup, then `unionResearch` with the last 5 research snapshots, so "research never forgets" (`:594-600`). Known handles override extracted ones (`:608-610`). |
| Persists | `athlete_snapshots.research` jsonb (achievements, press_mentions, brand_mentions, story_arc, teams, sentiment, social_handles, profile, nil_valuation_mentions, media_assets). Also `social`, `deals`, `score`, `sources`, `as_of` (`:634-650,706-718`). Found teams go to `athlete_affiliations` as `found` rows, never primary (`:725-734`). `athletes_current` gets score/rate card/counts/`story_arc` (`:740-751`). `athletes.sport` only when null. **Research never writes school/conference/division** (`:758-760`). |
| Dual-write to substrate | only if `RESEARCH_SUBSTRATE_WRITE=true` (`:768-771`). Off on dev. |
| Canonicalization | none on this path. The only structure is the Kimi JSON. `athlete_facts` is fed only by the substrate. |

### 2.2 Spec-grade path: `research-spec/1` + `direct-research/1` (BUILT · MAIN · test-harness-only)

- Asks for 9 sections, 55 items, each with a FOUND / NOT FOUND / CONFLICTING / NOT APPLICABLE status. S1 identity +
  namesakes. S2 affiliations, past teams with years, position/role, class/degree/graduation, national-team programme.
  **S3 career status, transfers, injuries, milestones, retirement/comeback (last 12 months)**. S4 results, records,
  stats, rankings, awards, international results, academic honours. S5 national/regional/sport/mainstream coverage,
  viral moments, crossover appearances, social conversation. **S6 storylines, values/causes, foundations, brand
  themes**. **S7 partnerships, categories, dates, renewals, campaigns, published values, representation, ventures,
  third-party valuations**. S8 accounts, verification, follower counts as stated, content formats, authenticity
  concerns. S9 reputation, with allegation / finding / resolution kept apart (`researchSpecV1.ts:45-119`, queries
  `:211-269`). The system instruction forbids rating (*"Describe, do not rate"*, `:195`).
- Runner: Gemini direct adapter, six queries, then deterministic item mapping, then `persistResearchRun` into the
  registry v2 resolver. `career_status` is derived deterministically, never asked (`directResearch.ts:1-14,141`).
  Only `native_supported`/`native_retrieved` lineage reaches the resolver (`:36-37`). In the stored evidence,
  2,353 of 3,530 rows are `asserted_only`, so about two-thirds never become facts (`select lineage_status, count(*)
  from research_evidence`).
- Caller: `server/scripts/calibration/runDirectResearch.ts` only. Planner/refresh v2 (`RESEARCH_REFRESH_V2`) uses the
  legacy 4 query texts verbatim (`research/plans.ts:1-8,303-322`) and is gated off.
- Provider benchmark harness (`research/benchmark/*`, `marketabilityBeta1Benchmark.ts`): benchmark infrastructure only.
  OpenAI adapters exist (`server/lib/research/providers/openaiDirect.ts`, `openaiWebSearch.ts`). Whether an
  `OPENAI_API_KEY` exists on dev is not in `cloud-run-dev.yaml` (UNKNOWN; see §7).

### 2.3 Refresh, TTL and decay

| mechanism | status | evidence |
|---|---|---|
| Monthly unconditional re-research of every enriched/claimed/active athlete | **live** (runs 1st of month) | `index.ts:2230`. Dev DB: 10 `re_enrich` snapshots, latest 2026-09-01 |
| Onboarding skip-if-fresh (7 days) | live. **Dated by carried-forward `created_at`** on the unlisted path | `onboarding.ts:93,135`. `CANONICAL_CONTEXT_READERS=""` (dev yaml `:272-273`) |
| Nightly `scheduled_refresh` | live. Re-scores and **carries the research blob forward** (not new research) | 247 rows. `research/snapshotAsOf.ts:13` |
| Planner-driven domain refresh with TTLs (identity 365 d, affiliations 180, achievements never, press 30, brand_mentions 180, narrative 180, handles 365, signals 30) | designed + built, **off** | `research/policy.ts:72`. `config.ts:44-46`. Flags false |
| Anything decaying out of State | **none**. State reads no research, so research TTL cannot matter to it. M.I.A. evidence has `asOf` only | `build.ts` |

### 2.4 Actual outputs on dev — population quality per field

Latest *true* research snapshot per athlete (`select distinct on (full_name) … where research is not null and
trigger <> 'scheduled_refresh' order by full_name, as_of desc`):

| athlete | as_of | ach | press | brands | teams | nil | handles found | quality notes |
|---|---|---|---|---|---|---|---|---|
| Mia Bhuta | 09-03 (manual) | 33 | 8 | 4 | 0 | 5 | ig, tt, x | Duplicate achievements. Yuwa ×2 as brand "partnership". Nike as `team_apparel`. **nil = market stats, not her**. Press all undated. Story arc: *"secured premium NIL deals … one of the most valuable women's soccer athletes in the NIL market"* (evaluative, uncited). *"undergraduate degree in just two years"* vs M.I.A. *"2.5 years"* |
| Lilia Bhuta (minor) | 09-03 (signup) | 14 | 4 | 1 | 0 | 3 | ig, x | `class_year: 2029` but story arc says "Class of 2028". `school` = Mt. Lebanon HS while affiliation = Century United |
| Lara Somfai | 09-01 | 22 | 20 | 4 | 0 | 2 | ig, x, yt | profile.school = **TCU**, transfer in story arc. Affiliation/State still Stanford |
| Matt Rose | 09-01 | 10 | 14 | 5 | 0 | 4 | ig, x | coherent |
| Chisom Okpara | 09-01 | 22 | 15 | 0 | 0 | 3 | x | coherent (Harvard→Stanford transfer in arc only) |
| Anthony Batson Jr. | 09-01 | 9 | 13 | 3 | 0 | 2 | ig, x | coherent |
| Aditya Sharma | 09-21 (signup) | 2 | 6 | 0 | 8 | 0 | none | Arc: *"found no record of an elite … player named Aditya Sharma"*, yet 8 teams extracted and 5 written as **found affiliations** (Solon HS, Malvern Prep, Lionville SC, Fritz-Soccer-Team). Namesake pollution |
| Aaron Charles-Song Nguyen | 09-01 | 0 | 1 | 0 | 0 | 0 | none | identity not found; still v7.2 **296** |
| Paytest Athlete (test) | 09-01 | 0 | **7** | 0 | 0 | 0 | none | Arc: *"does not correspond to any real-world athlete"*, yet 7 press mentions stored and v7.2 commercial capital **50** |

Field-level verdicts: **identity/sport/school** reliable for real college athletes. **position/hometown** usually
populated. **class_year** populated but free-text and inconsistent. **achievements** populated but duplicated and
un-canonical. **press** populated but dates null (Mia 8/8). **brand_deals** mixes nonprofits, team apparel and real
endorsements under one `partnership` label. **nil_valuation_mentions** mostly market-level noise. **teams** = 0 for 8
of 9 (populated only for the namesake case). **media_assets** 0–6. **story_arc** carries evaluative claims.
**sentiment** is a count with no referent. No identity gate: research ran and wrote for unresolved identities
(`ONBOARDING_V3=false`, the identity-guard definition, is off).

---

## 3. What each downstream consumer receives

| consumer | reads | does NOT read | evidence |
|---|---|---|---|
| **v7.2 score (/850, 4 capitals, 5 tiers)** | research blob (achievements, press, brand_mentions, story_arc, sentiment), Trends, GDELT, social, snapshot deals, affiliations level | M.I.A. | `scoringService.ts:432-511`. storyArcBonus now 0 (`weightsService.ts:108,394`). Active weights `v7.2.0` |
| **M.I.A. Beta.1 evaluator** | athlete name + sport + authoritative social block (connected/discovered accounts, cited handles) | research blob, substrate facts (except `social_handle` evidence for the block), deals, inbox, affiliations, assertions | `marketabilityBeta1EvaluatorSpec.ts:7-9,432-435`. `marketabilityBeta1SocialBlock.ts:82-83`. `marketabilityBeta1Snapshot.ts` |
| **M.I.A. canonical service (`scoreAthleteBeta1`)** | canonical context + facts + evidence + social features | — | shadow-only, calibration script caller (`marketabilityBeta1Service.ts:1-14`. Only `server/scripts/calibration/scoreBeta1.ts`) |
| **Athlete State 1.2** | M.I.A. ledger row, affiliations, regex-matched assertions, deals, inbox (cap 12), audience top buckets, content features, deal_preferences, onboarding goals | research, facts, athletes_current, v7.2 score, brand_fit_narratives, first_look, brand_voice, Trends/GDELT, M.I.A. summary/notes/score | `build.ts:129-215`. `contracts/athleteState.ts:52-61` ("Deliberately NOT projected: brand_fit_narratives … and athlete_facts (67% disputed; shelved)") |
| **Brain 0.12.0-exp** | rendered State + Objectives + Opportunity map + Work + hand-assembled Context. `research` block = Brain intelligence-request answers (empty in the live run) | Nomila research | `brain/evalSpec.ts:405-430`. final-live `record.blocks.research = 0` |
| **Outreach planner** (`OUTREACH_PLANNER_ENABLED=off`) | the same `stateBlock` as the Brain | same gaps | `planner/evalSpec.ts:91-101` |
| **Studio / deck (`getAthleteContext`)** | athletes_current (v7.2 score, story_arc, counts), latest research blob (achievements, brand_mentions, `values/causes`), affiliations, assertions, IG media insights | M.I.A., State | `athleteContext.ts:205-225,272-317` |
| **Creative Intelligence → Studio brief** | CreativeIntent + confirmed interpretation. No athlete knowledge added | — | `creative/toBriefInput.ts:1-45` |
| **Athlete-facing Record (`GET /me/record`)** | assertions, affiliations, research blob (position/class/hometown/achievements/press/brands seen), first_look themes, story_arc, v7.2 score + capitals, rate card | M.I.A., State | `server/services/athleteRecord.ts:146-321`. `intelligence/context/views/record.ts:115-205` |

---

## 4. M.I.A. / marketability

### 4.1 Pipeline map

```
trigger (IDENTITY_RESOLVED @signup · SOCIAL_BLOCK_CHANGED @social_sync · ADMIN/USER refresh)
  → mia_evaluation workflow: wait (debounce) → snapshot (name, sport, social block; digest) → evaluate only if digest changed
  → Gemini + Google Search grounding, default thinking, temp 1.0, frozen blind-eval-spec/0.2.1 (44 sub-signals, 8 dims)
  → frozen params/normalizer → 8 dimension scores → composite → /850
  → intelligence_ledger ASSESSMENT (score, dimensions, findings{rationale, confidenceReason, components, citedEvidence},
     evidence[], notes{strengths, constraints, evaluationRisks, missingEvidence}, summary, headline)
  → buildAthleteState.findingsFromMia → State findings (+ materialGaps) → Brain / planner state block
```
Citations: `workflow/definitions/miaEvaluation.ts:50-108`, `marketabilityBeta1Evaluator.ts:1-25`,
`marketabilityBeta1Orchestrator.ts:264-330`, `marketabilityLedgerMapping.ts:78-140`, `state/build.ts:229-309`.
**BUILT · MAIN · deployed-dev.** Evaluator validated on a 37-athlete development cohort, Spearman 0.889
(`EvaluatorSpec.ts:13`). The 4 capitals and 5 tiers belong to **v7.2**, not M.I.A. M.I.A. has 8 dimensions and
reports /850 (`headline.key = "mia_score"`).

Dev ledger: 59 ASSESSMENT rows, 44 current, 44 subjects, created 16–25 Sep. Snapshot triggers: ADMIN 52 · USER 7 ·
SOCIAL_BLOCK_CHANGED 3 (`select trigger_reason, count(*) from mia_evidence_snapshots`). IDENTITY_RESOLVED 0.
`drivers` is `[]` on Mia's row. `build.ts:12-16` already records that it is empty for every athlete.

### 4.2 Mia's actual M.I.A. output vs what State carries

Current row `b4099ac8…`, evidence_as_of 2026-09-21: score **624**, composite 67.93, `overallConfidence HIGH`,
`identityConfidence HIGH`, 5 evidence items.

| M.I.A. output element | in ledger | in State / Brain block |
|---|---|---|
| 8 dimension scores + direction band | ✅ | ✅ (athletic 80 STRENGTH, audience 41 GAP, engagement 67 NEUTRAL, cultural 59.65 NEUTRAL, narrative 88.9 STRENGTH, brand_fit 83.6 STRENGTH, commercial 71.5 NEUTRAL, momentum 57.7 NEUTRAL) |
| per-dimension prose + confidence reason | ✅ | ✅ |
| 44 components with evidence class | ✅ | ✅ (COMPONENTS line) |
| cited evidence (E1–E5, URL, type, date) | ✅ | ✅ per finding |
| per-component rationale | ✅ (`components[].rationale`) | ✅ in State JSON (`build.ts:292-298`). **Not rendered** in the block (the block prints `key=value [CLASS]` only) |
| **summary** (150–250 words) | ✅ | ❌ |
| **notes.strengths** (5) | ✅ | ❌ |
| **notes.constraints** (3, incl. academic-load availability) | ✅ | ❌. State `constraints` = "(none recorded)" |
| **notes.evaluationRisks** | ✅ | ❌ |
| notes.missingEvidence | ✅ | ✅ as `materialGaps` |
| M.I.A. score /850, composite | ✅ | ❌ |
| overallConfidence HIGH | ✅ | folded. State prints MEDIUM (the weakest of M.I.A. overall and all finding confidences, `build.ts:205-209`) |

### 4.3 Quality of M.I.A. reasoning (Mia and diverse athletes)

- **Mia:** specific and athlete-agnostic in form. But some statements go beyond their citations. The cultural
  relevance prose says *"first Indian-American to play **and score** at a FIFA World Cup"*, while its cited E2 says
  *"first player of Indian descent … to play for the United States at any FIFA World Cup"*. Momentum says she is
  *"continuing to play key minutes for a top-10 national contender in 2026"*, which is not in E1–E5 (UNKNOWN whether
  true; see §7). Brand fit says *"premium, highly educated audience"* with no audience-education evidence. The
  Brain's rendered block labels all of this *"M.I.A.'s evaluation, not established fact"* (final-live stateBlock
  header).
- **Aditya Sharma:** wrong person, `identityConfidence HIGH` (see §1 item 6).
- **Riya Mehta:** identity uncertain, `identityConfidence LOW`, score 262. This is the honest failure mode.
- **Lilia (minor):** 504. Class of 2029 / born 2011 / #1 PA 2029. Consistent with her research.
- **Lara Somfai:** 614. Correctly knows the TCU transfer that State will not carry.
- **LeBron:** 778. *"transitions to the Philadelphia 76ers for the 2026–27 season"* (UNKNOWN; not verifiable from the
  repo).
- **Hannah Yu:** 468, 0 evidence items stored (`jsonb_array_length(value->'evidence') = 0`), so none of her findings
  can carry citations.

### 4.4 v7.2 vs M.I.A. side by side (dev)

(`select … display_score, tier, capitals … , value->>'score' from athletes_current … join intelligence_ledger`)

| athlete | v7.2 | tier | capitals A/Ath/B/C | M.I.A. |
|---|---|---|---|---|
| Mia | 672 | Established | 100/91/34/70 | 624 |
| Lara Somfai | 608 | Established | 100/94/42/0 | 614 |
| Matt Rose | 563 | Established | 100/68/39/0 | 555 |
| Anthony Batson Jr. | 551 | Established | 98/65/37/0 | 412 |
| Chisom Okpara | 506 | Rising | 0/77/43/0 | 553 |
| Lilia | 359 | Local | 39/42/13/0 | 504 |
| Aditya Sharma | 481 | Rising | **100**/7/13/56 | 412 (wrong person) |
| Paytest Athlete | 359 | Local | 0/20/23/**50** | — |

Rates still default a missing capital to 50 (`rateService.ts:84`, `(caps as any)[cap] ?? 50`).

### 4.5 Live vs experimental

| component | status |
|---|---|
| v7.2 `computeScore` + `athletes_current` + rate card | BUILT · MAIN · deployed-dev. The athlete-visible score |
| M.I.A. evaluator + orchestrator + ledger + mia_evaluation workflow | BUILT · MAIN · deployed-dev. Feeds State only |
| M.I.A. canonical/normalization/service path (`marketabilityBeta1Canonical/Normalization/Service`) | EXPERIMENTAL · MAIN · test-harness-only (shadow) |
| research substrate, planner, direct research | EXPERIMENTAL · MAIN · flag:RESEARCH_SUBSTRATE_WRITE=off, RESEARCH_REFRESH_ENABLED=off |
| State 1.2 | BUILT · MAIN · deployed-dev (read by Brain/Opportunity/Objective harnesses) |
| Brain 0.12 | EXPERIMENTAL · OPEN_PR (#665 stack) · deployed-dev · flag:BRAIN_SUBSTRATE_LOOP=off |

### 4.6 "What Nomila knows about you": the knowledge objects and where they live today (no UI)

| knowledge object | lives in | athlete sees it today? |
|---|---|---|
| Identity & teams (said/found) | `athletes`, `athlete_affiliations`, `athlete_asserted` | yes, Record "Who you are" / "Your teams" |
| Athletic record (achievements, press) | `athlete_snapshots.research` (legacy) | yes, Record "What we found" (top 5 / counts) |
| Story arc | `athletes_current.story_arc` | yes, Record "Story" ("written from research") |
| Content themes & tone | `athlete_snapshots.first_look` | yes, Record first-look rows |
| Audience composition & performance | `social_features`, `social_audience_distributions` | partly, Record "Your numbers" + Growth |
| Commercial relationships (confirmed) | `deals`, contracts | yes, Record "Confirmed relationships" |
| Brands seen with you (inferred) | research `brand_mentions` | yes, Record "Brands seen with you" |
| Marketability judgment: 8 dimensions, reasons, citations, strengths, constraints, gaps | `intelligence_ledger` (M.I.A.) | **no** (no route serves it) |
| Score | v7.2 in `athletes_current` / M.I.A. in ledger | v7.2 only |
| Brand fit per brand (audience/credibility/whitespace) | `brand_fit_narratives` (19 rows) | via Mila voice only (`server/voice/brandFitStore.ts`) |
| Brand layer objects (positioning, pillars, narrative, voice, direction) | `athletes.brand_voice` (1 athlete). `athlete_narratives` / `brand_relationships` **do not exist** as tables (information_schema) | voice only |
| Canonical researched facts | `athlete_facts` (cohort only) | no |

---

## 5. Social substrate (Step 1a / 1b)

| item | exists | State receives |
|---|---|---|
| connected account metrics (IG, TikTok, YouTube) | `social_metric_observations`. Mia: IG content 12.6k obs, TikTok 7.9k, account-level daily | followers only (`followers_latest`) |
| computed features (38 platform×key combos for Mia, 3 athletes total) | `social_features` (`select count(distinct athlete_id) from social_features` → 3) | posts/week, days since post, format_mix, reach_median_by_format, top_decile_share, breakout_rate, followers_growth_pct (→ `audienceTrajectory` "cooling") |
| engagement / reach / saves / shares medians, non-follower reach, performance_cv, watch time | features exist (IG) | ❌ (reaches M.I.A. via the social block, not State) |
| audience composition | `social_audience_distributions` IG age/gender/country/city, 8,900 rows | top country, top age, gender for IG. City ❌ |
| TikTok content performance | raw per-video observations only. No TikTok content features computed | ❌ (only days since last post) |
| YouTube | 12 account obs + 30-day aggregates | ❌ (no content features) |
| Stories (Step 1b) | `SOCIAL_STORIES_WRITE=true` on dev. **0 story observations** for Mia (entity types: content video/reel/carousel/post, account) | ❌ |
| content themes / tone | `first_look` (Gemini over captions) | ❌ |
| public (non-connected) social | platform discovery into `snapshot.social` (legacy) | ❌ (State reads only substrate) |
| content posts / brand tagging | `content_posts` (no athlete column), `content_brands` 0 rows, `media_assets` 2 rows | ❌ |

**Implementation:** BUILT · MAIN · flag:SOCIAL_SUBSTRATE_WRITE=on, SOCIAL_STORIES_WRITE=on (dev). Prod: control file says
untouched by the stack. Step 1a/1b are on main (UNKNOWN whether prod flags were flipped since; not checked).

---

## 6. Prior findings re-verified

| prior finding | source | status | evidence |
|---|---|---|---|
| Intent (`goal_archetype`, `secondary_goals`) dropped by State | strategic-sufficiency-audit §1 | **SUPERSEDED** | `build.ts:378-394`. final-live `preferences[onboarding_goal.*]` |
| 227 inbox threads / 200 detected deals dropped | same | **SUPERSEDED (partially)** | pipeline counts + inbound cap 12 now in State (`build.ts:336-419`). Advertisers beyond 12, `inbox_brands` (180) and contact graph still unread |
| Floors / representation dropped | same | **SUPERSEDED** | `representationFrom` (`build.ts:479-489`) rendered in final-live |
| Audience composition / content performance dropped | same #3/#4 | **PARTIALLY SUPERSEDED** | IG top buckets + 6 content keys now in State. Engagement/reach/saves/shares, TikTok/YouTube content, city still dropped |
| `brand_fit_narratives` whitespace dropped | same #5/#20 | **STILL TRUE (deliberate)** | `contracts/athleteState.ts:60` |
| Adidas only in M.I.A. prose, no canonical fact | same #6 | **STILL TRUE**, and worse: her own assertion about it is also dropped | final-live `activeRelationships ["gorjana"]`. `athlete_asserted.note` |
| Deal structure tables schema-only, 0 rows | same #7 | **STILL TRUE** | 0/0/0 |
| `brand_relationships` designed, not built | same #8 | **STILL TRUE** | not in information_schema |
| Mia 0 `research_evidence` / `athlete_facts` | same #1, #16, §4.3 | **STILL TRUE** | 0 rows for any product athlete |
| 67% of `athlete_facts` disputed | same §4.3 | **STILL TRUE** | 588/883 |
| Trends/GDELT signals read by nothing downstream | same #16 | **STILL TRUE** for State/Brain. v7.2 still consumes Trends/GDELT counts | `scoringService.ts:457-489` |
| No calendar / milestones / dates | same #15, State 1.2 audit §6 | **STILL TRUE** for State (`dates` "(none recorded)" for Mia). A hand-assembled Context block now carries fixtures (final-live `contextBlock`, "assembled by hand") | Agent D owns Context |
| No gap → question/research path | same #27 | **PARTIALLY SUPERSEDED** | Brain intelligence requests + acquisition workflow (EXPERIMENTAL, "Nothing in production starts this process", `intelligenceAcquisition.ts:11`). Answers land in `athlete_asserted` fields that State does not read (`:30-32`) |
| Targeted audit: "answers flow through State, never directly into an evaluator" | targeted-intelligence-audit §5 | **PARTIALLY TRUE** | they are written to `athlete_asserted`, but State's regex drops most fields (§1 item 9) |
| State 1.2: `audience[instagram]` rendered, never cited | state-1.2-frozen-four-audit §6 | **CANNOT VERIFY at this manifest** (needs citation counts from the 0.12 live run) | — |
| State 1.2: dates empty for all four | same §1 | **STILL TRUE** for Mia | final-live |
| Score-engine audit: rates default missing capitals to 50 | memory: score-engine-audit | **STILL TRUE** | `rateService.ts:84` |
| Brand Layer: story_arc has invented claims and a +10 score bonus | memory: brand-layer-analysis | **PARTIALLY SUPERSEDED**. Bonus now 0 (`weightsService.ts:108,394`, active v7.2.0 `storyArcBonus 0`). Invented/evaluative claims still present (Mia arc "one of the most valuable … in the NIL market"). Arcs for unresolved identities ("no record found") still stored and shown as "Story" | dev snapshots |
| Brand Layer: `brand_voice` unread | memory | **PARTIALLY TRUE** | read by Mila profile/voice/Record. Not by State/Brain/M.I.A./Studio. 1 athlete has it |
| Step 2: research readers unlisted, flags off | memory step2-research-design | **STILL TRUE** | `CANONICAL_CONTEXT_READERS=""`, both research flags false (gcloud describe) |
| Step 4 simplification: "research once → reuse everywhere" target | `docs/architecture/phase-a/step4-research-architecture-simplification.md` §1 | **DESIGNED, not realised** | M.I.A. researches independently. Legacy still production |
| Step 1b: waiting for a Story | memory step1b | **STILL TRUE** | 0 story observations |

---

## 7. UNKNOWNs

- **Production state** of every flag/score path in this file. Prod was not touched. Settle with a read-only `gcloud
  run services describe` on the prod service.
- **Whether M.I.A.'s uncited statements are true** (Mia "play and score", "2026 key minutes"; LeBron "76ers").
  Settle by the founder confirming, or by a cited source.
- **Mia's current education/eligibility stage.** Research: "Senior (2026 season)". M.I.A.: master's in progress.
  Mia to state.
- **Aditya Sharma's asserted sport "Basketball" vs `athletes.sport = soccer`.** The assertion should update the column
  (`onboarding.ts:25-26`). Settle by reading `agent_actions` profile_write receipts for that athlete.
- **Whether `OPENAI_API_KEY` exists** for the benchmark. It is not in `cloud-run-dev.yaml`. Settle via Secret Manager
  listing.
- **Whether the planner/Studio would read State on a real run.** The planner is flag-off and has no dev rows. Studio
  has no State reader in this tree. Agent G owns Studio tips.

## 8. Open questions for the founder

1. **Which research should be the athlete's canonical research:** the M.I.A. evaluator's own grounded pass, the
   legacy dossier, or `research-spec/1`? Today three exist and none feeds the others. Deciding this also decides
   whether M.I.A. should receive an identity anchor (school/team/handles) and not just name + sport.
2. **Which score is "her score"?** 672 (v7.2, shown to her) or 624 (M.I.A., used by the Brain)?
3. **Should athlete-said facts (`note`, `never_post`, `brands_causes`, `hobbies`, `cadence`) be State?** Today State
   drops them by field-name regex.
4. **Should M.I.A.'s strengths/constraints/summary reach State**, given they are evaluator opinion (e.g. "academic
   load may limit availability")?
