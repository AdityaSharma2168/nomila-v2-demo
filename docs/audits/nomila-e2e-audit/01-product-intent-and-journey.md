# 01 — Product intent, athlete surfaces, golden journey (Agent A)

Audited at the working tree `3f0139f6` (= #665 stack tip) unless a line says `main@9fff9b15` or another SHA. Client
code is **identical** on `main@9fff9b15` and `3f0139f6` (`git diff --stat 9fff9b15 HEAD -- client` → empty), so
every client surface below is `MAIN`. Dev DB reads are SELECT-only via `.env` DATABASE_URL (proxy 127.0.0.1:5440);
throwaway scripts deleted. Dev Cloud Run env read with `gcloud run services describe nomila-v2` (read-only):
latest ready revision `nomila-v2-00757-gs2`, created 2026-09-27T23:00:54Z.

---

## 1. Summary

1. **The intended product is an "AI management team" for the athlete, run through Mila as chief of staff**
   (Blueprint v1 §1, §4, §29). The spine is *Profile → Marketability/Social/Commercial → State → Opportunity →
   Objectives → Strategy → Actions → Deals/Studio/Mila → Results → Learning* (Blueprint §9). DESIGNED · DESIGN_DOC_ONLY
   for the whole loop; parts built as below.
2. **ARRIVE and the execution systems are real; the middle of the loop has no athlete surface.** Sign-in → index
   "Is this you?" → onboarding run → Mila greet → door is BUILT · MAIN · deployed-dev (claim flag on in preview build
   and dev). Deals/Inbox, Deck/Nomi Card, Studio, Mila chat/voice are BUILT · MAIN · deployed-dev.
3. **Only the Objective review queue reaches the app.** `ObjectivesReviewScreen` is BUILT · MAIN · flag:OBJECTIVES_V1
   (on in `eas.json` preview + dev Cloud Run). It shows **only the proposal queue** — live Objectives are not shown
   anywhere once decided (`ObjectivesReviewScreen.tsx:9`, door hidden when `toReview == 0`, `BrandTabScreen.tsx:138`).
4. **There is no Home, Plan, Recommendations, Actions or Campaigns screen.** Tabs are Brand · Opportunities(=Deals) ·
   Mila (center) · Studio · Profile(=Settings) (`MainTabNavigator.tsx:539-543`). MISSING · — for each.
5. **Opportunity map, Objective proposal, Brain and the outreach planner run only from scripts.** No HTTP route or
   cron imports `opportunityBeta1Orchestrator`, `objectiveBeta1Orchestrator`, `brainExperimentOrchestrator`,
   `brainLoopDurable` or `outreachPlannerOrchestrator` (importers are all `server/scripts/intelligence/*` — grep
   below). EXPERIMENTAL · OPEN_PR (Brain/planner) / MAIN (Opportunity/Objective eval code) · test-harness/script-only.
6. **Dev holds three live Recommendations for Mia; none is executable.** All three `executionPath = specialized_plan`,
   response/authz `none` (dev DB). Checkpoint: "Ready to SHOW, not ready to ACT"
   (`brain-reliability-0.12.0-checkpoint.md:255`). Contract works · output plausibly useful · product cannot execute.
7. **Mila — the intended coordinator — cannot see Objectives, Opportunities or Recommendations.** Her tools are
   score/profile/deals/rate card/tasks/analytics/draft/navigate/help/brand/brand-fit (`server/mila/registry.ts:28-40`);
   no file under `server/mila` or `server/voice` reads `recommendations`/`objectives` tables (grep). MISSING.
8. **CONTRADICTS CONTROL: `STUDIO_CREATIVE_INTENTS` and `STUDIO_CAMPAIGN_GOVERNANCE` read ON on dev.** Both read through
   `studioFlag()` (`server/studio/config.ts:1080-1082`), which turns every unset Studio flag on when `STUDIO_ALL_ON=true`
   (`server/studio/studioFlag.ts`, last line). Deployed dev env has `STUDIO_ALL_ON=true` and neither variable set
   (gcloud describe; `gcp/cloud-run-dev.yaml:425`). So `/studio/creative/intents*` and `/campaigns*` answer on dev
   (`server/routes/studio.ts:3638-3640`), and Mila is offered `request_creative` on every v2 turn
   (`server/mila/loop.ts:198`, `registry.ts:52`). Meanwhile the Brain's readiness reads the same flag with strict
   `=== "true"` (`brain/executionReadiness.ts:56,69`) → "campaign governance … frozen off". Two readings of one flag.
   No client calls these routes (client unchanged from main). 0 rows in `campaigns`/`creative_intents` on dev.
9. **The athlete sees the legacy score, not M.I.A. Beta.1.** `GET /api/v1/athletes/:id/score` returns
   `athletes_current.display_score` (`server/index.ts:324-358`): Mia **672**. Beta.1 ledger ASSESSMENT for Mia is
   **624** (dev `intelligence_ledger`, 2026-09-22). Beta.1 is computed at signup/connect (`routes/auth.ts:152`,
   `workflow/definitions/miaEvaluation.ts`) but has no athlete-facing reader.
10. **Publishing to Instagram exists and has run once live on dev.** `studio_publish_jobs`: 1 `dry` + 1 `live`
    succeeded 2026-09-25; `content_posts` 1 row (dev DB). BUILT · MAIN · `STUDIO_PUBLISH_MODE` unset on the current
    dev revision (default `off`, `server/studio/publish/config.ts:4`). TikTok/YouTube publish MISSING (no upload call).
11. **Measure/Learn is derivation only.** `outcome/attribution.ts` header: "experimental and unmounted"; no importer
    outside `outcome/` (grep). `deal_deliverables` 0 rows, `published_asset_identities` 0 rows (dev DB).
12. **Goals captured at arrival reach the stack but not the product.** Goal slugs are read by the deal scorer prompt
    (`server/skills/dealDetector.ts:1296`) and now by `contracts/athleteState.ts` / context views on the stack — not by
    any athlete surface's recommendation.
13. **Notifications: none to the athlete.** Only an email "you're in" path that no-ops without `RESEND_API_KEY`
    (`server/lib/notify.ts:1-12`; key absent from dev env); `TODO(notify)` on escrow/deposit
    (`server/services/payments/escrow.ts:137`, `deposit.ts:104`). No push integration found (grep `expo-server-sdk|exp.host`).

---

## 2. Intended product (recovered, quoted briefly)

### 2.1 Value proposition
- "Nomila is the intelligence and agentic operating layer for the business of athletes." — LOCKED
  (`product-intelligence-blueprint-v1.md`, Core thesis / §1).
- Athlete promise: "An AI management team for my brand, business and opportunities." (Blueprint §1 Packaging).
- Brand meaning: "*Nom* — the identity you claim — and *Mila* — a beloved essence" (`docs/brand-story.md` §The name).
- Principles that shape the journey (Blueprint §3): "Know before asking"; "Recommend before asking for goals";
  "Every action traces to an objective"; "Execution systems are downstream — Deals and Studio execute strategy";
  "Outcomes are first-class".

### 2.2 Business/user flow + intelligence flow, together

| Stage | What the athlete is meant to experience (source) | Intelligence responsibility (source) |
|---|---|---|
| Arrive | Auth → name → "Is this you?" / "Which one is you?" → claim; else sport → cheap resolve → confirm (Blueprint §10) | Athlete index before paid research; identity states seed_only→…→connected (§10.1) |
| Research | Nomila already knows her when she lands ("know before asking", §3) | Research builds evidence; "should not calculate MIA or rates itself" (§11) |
| Connect | OAuth "raises measurement confidence; score/rates may rise or fall" (§3) | Collection ladder web → public API → OAuth (§15) |
| Understand | Marketability + confidence + explanations (§4) | M.I.A. Beta.1: eight dimensions, 0–850 (§14, LOCKED); Athlete State = "where the athlete is today" (§22) |
| Correct/add | Confirm, correct or add what Nomila cannot know (§3) | Facts ≠ inferences ≠ decisions (§13, LOCKED) |
| Decide | "Nomila recommends → athlete accepts / modifies / rejects → ACTIVE OBJECTIVES" (§25) | Opportunity FIX/GROW/UNLOCK/AMPLIFY/MAINTAIN (§23); goal taxonomy of 7 pillars (§24, LOCKED) |
| Manage | Mila: "Three things need your attention today." (§29); "Weekly prioritized action plan" (§4) | Strategy Orchestrator + strategists (§26, §30); Action model, "Weekly Plan is a prioritized/scheduled action queue" (§27, LOCKED) |
| Create/Execute | Deals: triage→value→recommend→draft→approve→execute (§31); Studio: "Strategy decides what to make and why; Creative Director decides how; Studio executes" (§32, LOCKED) | Content Strategist → CreativeSpec/ShotSpec → router → evaluation (§32–35) |
| Measure/Learn | (implicit) results change what Mila proposes | Structured outcomes first (§36); learning = evaluation + version promotion (§37) |

Superseding control: the audit control's loop OBSERVE → … → EXECUTION PATH (direct_action | specialized_plan |
campaign) → EXECUTE → MEASURE → LEARN (`00-control.md`) replaces the Blueprint's "Strategy Orchestrator + three
strategists" with Brain (WHAT/WHY) + specialized planners (HOW) + Campaign. Blueprint corrections live in
`SUPERSEDED.md` (S-1…); none of them removes an athlete-facing stage.

### 2.3 Other intent documents
- **Mila** — "There is **one** conversational agent … Everything else … is a tool" (`docs/mila-agent-architecture.md`
  on `origin/docs/mila-agent-architecture` @ `ed535ee4`; UNMERGED_BRANCH, absent from main and the stack).
- **Opportunities tab** — "turns it into an **agent surface**: Mila states a short list of recommended actions …
  co-pilot first" (`docs/opportunities-redesign/00-overview.md`). Built as Brief + Explore All
  (`client/screens/OpportunitiesScreen.tsx:41-48`). Scope is deals, not strategic Opportunity 1.2.0 — same word,
  different object (also noted in `mia-vertical-slice-map.md` MODIFY §1).
- **Social media manager** — weekly content plan items handed to publish; "A 'weekly social media manager' that does
  not know she plays Saturday is a content analyst" (`docs/plans/social-media-manager.md` §0). DESIGNED ·
  DESIGN_DOC_ONLY; spine `deriveOccasions` only on `origin/feat/weekly-plan-spine@5dc4dcdc` (`server/skills/weeklyPlan.ts`,
  UNMERGED_BRANCH).
- **Onboarding v2/v3** — research → context_ready → greet (await reaction/corrections) → doors (`profile|deals`) →
  wrap (`server/workflow/definitions/onboarding.ts:122-194`; `server/mila/onboarding.ts:110`); v3 prepends
  `identity_confirmed` (`onboarding.ts:204-220`), opt-in via `ONBOARDING_V3` (false on dev).

---

## 3. Athlete-facing surfaces — intended vs present

Navigation: `client/App.tsx:99-121` (Waitlist / Onboarding gate / IsThisYou / ChooseProfile / Main tabs);
`client/navigation/MainTabNavigator.tsx:539-543` (5 tabs). Build flags: `eas.json` preview sets `IDENTITY_CLAIM`,
`OBJECTIVES_V1`, `STUDIO_ALL_ON` true; production profile sets none of them.

| Surface | Intended purpose (source) | Present in client | Implementation · Location |
|---|---|---|---|
| Home / "today" | Mila prioritisation "Three things need your attention today" (Blueprint §29) | none; default tab is Brand (`MainTabNavigator.tsx:489-496`) | MISSING · — |
| Mila | Chief of staff: explain, coordinate, approve (§29) | `MilaSearchOverlay` from center tab; full-screen `OnboardingScreen` on first entry (`App.tsx:101`) | BUILT · MAIN · deployed-dev · flag:MILA_AGENT_V2=on (dev) |
| Profile / public profile (Nomi Card, deck) | Athlete brand card, shareable | Brand › Card tab, `DeckScreen`, `CardEditorScreen`, share sheet | BUILT · MAIN · deployed-dev (9 `media_kits` rows) |
| Brand layer (Story) | positioning, pillars, narrative, voice ("PR C") | `StoryTab.tsx:1-3` "Until it exists, this tab shows the raw material" | DESIGNED · MAIN (placeholder) |
| Facts / "what Nomila knows" | confirm/correct/add (§3) | Brand › Facts, `GET/PUT /me/record` (`server/routes/record.ts:4-6`) | BUILT · MAIN · deployed-dev |
| Marketability / intelligence | score + confidence + explanations (§4, §14) | Brand › Score screen reads legacy `athletes_current` (`server/index.ts:324`) | PARTIAL · MAIN — shows v7.2 legacy, not Beta.1 |
| Rates | rate intelligence + floors (§17) | Brand › Rates (`RatesScreen.tsx`), v3.1 rate card + floors | BUILT (legacy) · MAIN; Beta.1 Rate script-only |
| Growth / analytics | social intelligence | Brand › Growth = `AnalyticsTab` (`BrandTabScreen.tsx:177`) | BUILT · MAIN |
| Opportunities (strategic) | Opportunity map (§23) | none — the tab named Opportunities is Deals | MISSING (surface) |
| Objectives | accept/modify/defer/decline (§25) | `ObjectivesReviewScreen` (queue only) | BUILT · MAIN · flag:OBJECTIVES_V1=on (preview+dev) |
| Recommendations | explainable recommendation (§3) | none | MISSING · — (no route either) |
| Plan / weekly plan | prioritised action queue (§27) | none | MISSING (spine on UNMERGED_BRANCH) |
| Actions | owner, due, status (§27) | none (receipts exist as `agent_actions`, deal-scoped) | MISSING |
| Campaigns | bounded multi-deliverable effort (#570) | none. `CampaignWorkspaceScreen` is Studio's generation workspace (`MainTabNavigator.tsx:183-195` comment) — naming collision | MISSING (client); server routes on stack |
| Studio | creative execution (§32) | Studio tab: `StudioHomeScreen` (flag) or legacy `StudioScreen`; Pitches, Media Library, Agent, Create Anything, Make it | BUILT · MAIN · flag:STUDIO_ENABLED via STUDIO_ALL_ON (preview on; production build off) |
| Deals / Inbox | Deal Desk (§31) | Opportunities tab: Brief + Explore All, Thread, DealDetail | BUILT · MAIN · deployed-dev |
| Settings / connections | connect my world | Profile tab = `SettingsScreen` (connections, OAuth) | BUILT · MAIN |

---

## 4. Golden athlete journey (the spine)

Cells: **I** = Implementation, **L** = Location. Last three columns: contract works / useful output / executable.

| Stage · step | Intended experience | Status (I · L · flag/deploy) | Pointer | Contract works | Useful output | Executable |
|---|---|---|---|---|---|---|
| **ARRIVE** · find/confirm me | Sign in, "Is this you?", claim, never silently created | BUILT · MAIN · deployed-dev · flag:ATHLETE_INDEX_CLAIM=on (dev), EXPO IDENTITY_CLAIM=on (preview) | `routes/auth.ts:120` `resolveIdentity`; `App.tsx:118-119`; `IsThisYouScreen.tsx` | Y | Y (9 `athlete_index_matches`, 0 `identity_claims` on dev) | Y |
| ARRIVE · research me | Nomila already knows her | BUILT · MAIN · deployed-dev; substrate write off (`RESEARCH_SUBSTRATE_WRITE=false`, dev env) | onboarding step `research` (`onboarding.ts:126-146`); `researchAthlete` | Y | Partly — legacy research snapshot; substrate rows exist (3530 `research_evidence`) | n/a |
| ARRIVE · M.I.A. at arrival | first assessment at signup | BUILT · MAIN · deployed-dev | `routes/auth.ts:152-153`; `workflow/definitions/miaEvaluation.ts` | Y | Not shown to athlete | n/a |
| ARRIVE · connect my world | IG/TikTok/YouTube/Gmail/Outlook OAuth | BUILT · MAIN · deployed-dev | `SettingsScreen.tsx:21,125`; `workflow/definitions/{firstLook,socialSync}.ts` | Y | Y (Mia: gmail, IG, TikTok, YouTube active; outlook pending — dev `connected_accounts`) | n/a |
| **UNDERSTAND** · show what you know | Mila greets with what she found | BUILT · MAIN · deployed-dev · ONBOARDING_V3=off (v2 runs) | greet step `onboarding.ts:163-175`; `mila/onboarding.ts` | Y | UNKNOWN quality (see agents on Mila) | n/a |
| UNDERSTAND · correct/add | Correct in words or on Facts, reversible | BUILT · MAIN · deployed-dev | `recordAssertions` (greet); `routes/record.ts`; `athlete_asserted` 3 rows | Y | Y (low volume) | Y |
| UNDERSTAND · marketability/identity | Score + why + confidence | PARTIAL · MAIN — legacy v7.2 shown; Beta.1 EXPERIMENTAL frozen contract, no reader | `index.ts:324-358`; ledger ASSESSMENT 624 vs shown 672 | Y (both) | Two numbers, athlete sees the legacy one | n/a |
| UNDERSTAND · Athlete State | derived "where she is today" | EXPERIMENTAL · MAIN (`state/build.ts`) · script-only | importers: `scripts/intelligence/{brainRun,opportunityRun}.ts`, `services/brainInputsBuilder.ts` | Y | UNKNOWN to athlete (never surfaced) | n/a |
| **DECIDE** · understand what I want | goals at landing + Mila | BUILT · MAIN (capture) | `routes/waitlist.ts`, `routes/profile.ts:16`, `mila/profileExtraction.ts` | Y | Read by one prompt line (`dealDetector.ts:1296`) + State contract (stack) | n/a |
| DECIDE · identify opportunities | where upside lies (FIX/GROW/…) | EXPERIMENTAL · MAIN code / frozen `opportunity-eval-spec/1.2.0` on stack · script-only | `services/opportunityBeta1Orchestrator.ts` ← `scripts/intelligence/opportunityRun.ts` only | Y (forcing artifacts) | Not surfaced | n/a |
| DECIDE · establish Objectives | proposed → accept/modify/defer/decline | BUILT (governance) · MAIN · flag:OBJECTIVES_V1=on dev+preview; proposal generation script-only | `routes/objectives.ts:49-85`; `ObjectivesReviewScreen.tsx`; dev: 3 active (modified) + 1 deferred + 1 declined for Mia | Y | Y — Mia rewrote all three live ones (`disposition=modified`) | Only as input to Brain |
| **MANAGE ME** · Recommendations | explainable "do this now" | EXPERIMENTAL · OPEN_PR (#664/#665) · deployed-dev (migrations) · flag:BRAIN_SUBSTRATE_LOOP unset=off · script-only | `services/brainLoopDurable.ts:31`; `scripts/intelligence/brainLoopDurable.ts`; dev 1 `brain_runs`, 3 `recommendations` | Y | Plausible: e.g. "Reactivate her dormant TikTok channel to engage short-form video audiences and expand her platform reach." | N — all `unavailable` |
| MANAGE ME · Plans | HOW for a Recommendation | EXPERIMENTAL · OPEN_PR · flag:OUTREACH_PLANNER_ENABLED=off; content planner not productionized | `services/outreachPlannerOrchestrator.ts:29,57`; 0 `outreach_plans` | Y (forcing) | UNKNOWN in product | N |
| MANAGE ME · Actions | queue with owner/due/status | MISSING (Blueprint §27 only); deal-scoped `pending_actions` exist | `pending_actions` 58 (53 pending) dev | — | — | Deal actions only |
| MANAGE ME · Campaigns | athlete-approved bounded effort | EXPERIMENTAL · OPEN_PR · routes reachable on dev (see Summary 8); no client | `routes/campaignGovernance.ts`; `services/intelligence/campaign/*`; 0 rows | Y (closed-loop harness) | none yet | N (no client) |
| MANAGE ME · Mila coordination | Mila explains/coordinates recommendations | MISSING — Mila has no Objective/Recommendation tool | `mila/registry.ts:28-52` | — | — | — |
| **CREATE/EXECUTE** · outreach/deals | triage, draft, tap-to-send | BUILT · MAIN · deployed-dev | Opportunities tab; `skills/dealDetector.ts`; `pending_actions`; `agent_actions` 4578 (filing) | Y | Y | Y (tap-to-send) |
| CREATE/EXECUTE · proactive outreach (pitches) | brand pitch builder | BUILT · MAIN | `PitchesListScreen`, `PitchDetailScreen`, `components/pitch/CreatePitchFlow.tsx` | Y | UNKNOWN | Partial (UNKNOWN send path) |
| CREATE/EXECUTE · Creative Intelligence | what to make and why, tied to Objective | EXPERIMENTAL · OPEN_PR · effectively ON on dev via STUDIO_ALL_ON | `studio/creative/routes.ts`; `services/intelligence/creative/*`; 0 `creative_intents` | Y (forcing) | none yet | Handoff to Studio brief exists (`creative/toBriefInput.ts`) |
| CREATE/EXECUTE · Studio | generate/edit/QA from her media | BUILT · MAIN · flag:STUDIO_ALL_ON (dev+preview) | `server/studio/**`, `client/screens/studio/**`; 548 `generation_jobs`, 93 `studio_plans` | Y | Y (volume) — quality: other agents | Y |
| CREATE/EXECUTE · publishing | post on her behalf | BUILT (IG only) · MAIN · STUDIO_PUBLISH_MODE unset=off now | `studio/publish/{runner,instagram}.ts`; 1 live publish 2026-09-25 | Y | Y (1 post) | IG only |
| CREATE/EXECUTE · commercial execution (payments) | escrow/deposit | PARTIAL · MAIN | `services/payments/*`; 2 `payments` pending; `TODO(notify)` | Y | UNKNOWN | Partial |
| **MEASURE/LEARN** · outcomes | what happened vs baseline | EXPERIMENTAL · OPEN_PR · unmounted | `services/intelligence/outcome/attribution.ts:1-7` | Y (forcing) | — | — |
| MEASURE/LEARN · reconsideration | evidence re-opens a decision | EXPERIMENTAL · OPEN_PR · script/offline | `brain/reconsideration.ts`; status map "offline transition on a ledger copy" | Y | — | — |
| MEASURE/LEARN · updated recommendations | next run reflects outcomes | MISSING (no scheduled Brain run, no outcome writer) | no cron imports `brainLoopDurable` | — | — | — |

---

## 5. Prior findings re-verified

| Prior finding | Source | Verdict | Evidence |
|---|---|---|---|
| Campaign "concept/design — no table" | `architecture-status-map.md` EXECUTE / EXECUTION PATH | SUPERSEDED | tables `campaigns`, `campaign_specs`, `campaign_deliverables` exist on dev (0 rows); routes `routes/campaignGovernance.ts` on stack |
| Recommendation "not materialised"; run persistence "deferred/open" | status map RECOMMEND | SUPERSEDED | dev `brain_runs`=1, `recommendations`=3, `recommendation_events`=3 |
| specialized_plan "concept/design" | status map EXECUTION PATH | SUPERSEDED | `services/intelligence/planner/*`, `outreachPlannerOrchestrator.ts` (flag off) on stack |
| Creative Intelligence "concept/design" | status map EXECUTE | PARTIALLY SUPERSEDED | `creative_intents`/`creative_interpretations` tables + routes on stack; 0 rows |
| Outcome "deferred/open; deal_deliverables 0 rows" | status map MEASURE | PARTIALLY SUPERSEDED | `deal_deliverables` still 0 (dev); attribution derivation now exists, unmounted |
| Mila/Inbox/Deals mounted | status map EXECUTE | STILL TRUE | tabs + routes present; deals 279 rows dev |
| Objective ledger/governance mounted | status map OBJECTIVE | STILL TRUE | `routes/objectives.ts`; 5 objectives, 21 events dev |
| M.I.A. Beta.1 frozen contract, no downstream reader for athlete | status map UNDERSTAND | STILL TRUE | score route reads `athletes_current` (`index.ts:324`) |
| "Mia currently 638/850" | `mia-vertical-slice-map.md` KEEP | SUPERSEDED | latest un-superseded ledger ASSESSMENT = 624 (dev, 2026-09-22) |
| "`AthleteState` / `OpportunityMap` / `Objective` no matches anywhere" | slice map | SUPERSEDED | `contracts/athleteState.ts`, `state/build.ts`, `opportunity/*`, `objective/*` exist |
| "`weeklyPlan.ts` does not exist" in tree | slice map | STILL TRUE (stack + main) | absent under `server/skills`; exists only at `5dc4dcdc` |
| "Beta.1 Rate has zero production consumers" | slice map MODIFY §3 | STILL TRUE | Beta.1 rate reachable from `server/scripts/rate/` only; app reads v3.1 `rate_card` (`index.ts:352`) |
| "One engine: the inbox deal engine" recommends | `docs/recommendation-system-map.html` | PARTIALLY SUPERSEDED | still the only one wired to the product; Brain exists but is script-only |
| Goals read by exactly one consumer (scorer prompt) | recommendation-system-map | PARTIALLY SUPERSEDED | scorer still reads it (`dealDetector.ts:1296`); stack adds `contracts/athleteState.ts`, context views |
| Weekly plan not built; spine is PR #309 | recommendation-system-map | STILL TRUE | see above |
| `prompts` table empty | recommendation-system-map | STILL TRUE | dev `SELECT count(*) FROM prompts` = 0 (though `PROMPT_REGISTRY=true` in dev yaml) |
| "No platform can publish today" | `social-media-manager.md` §1.1 | SUPERSEDED (IG) / STILL TRUE (TikTok, YouTube, X) | `studio/publish/instagram.ts`; 1 live publish dev; no `video.upload`/`youtube.upload` |
| `content_posts` "never written" | social-media-manager §1.1 | SUPERSEDED on dev | 1 row, IG, 2026-09-25 |
| Surface audit (7 Sep) scorecard | memory-only artifact; not in repo (`grep -ril "surface audit" docs` → none) | CANNOT VERIFY at this manifest | settle by reading the artifact link |

---

## 6. UNKNOWNs

- **What code production (`nomila-v2-prod`, revision `-00003-dhd`) runs** and whether real athletes use it: the
  production EAS profile points to `https://api.nomila.co` (`eas.json`), which a memory note says is still legacy v1.
  Settle: `gcloud run revisions describe nomila-v2-prod-00003-dhd` image digest vs a main build; DNS of api.nomila.co.
- **Which SHA the dev image `sha256:273948bf…` was built from** — accepted from control (#665 stack). Settle: deploy run
  36356955934 logs.
- **Whether `STUDIO_PUBLISH_MODE=live` was set on the revision that published on 2026-09-25**, or the publish ran via
  a script. Settle: revision history env for that date.
- **Quality of the greet / first-look content** Mia actually receives — not assessed here.
- **Pitch send path** (does a pitch go out to a brand from the app?). Settle: trace `use-pitches.ts` → server route.

## 7. Open questions for the founder

1. Where should Recommendations and live Objectives live for the athlete — a Home/"today" surface, the Brand tab, or
   inside Mila? No surface is designed for them (`brain-reliability-0.12.0-checkpoint.md` §8: "No UI here").
2. Should `STUDIO_ALL_ON` on dev cover the non-Studio intelligence flags (`STUDIO_CREATIVE_INTENTS`,
   `STUDIO_CAMPAIGN_GOVERNANCE`)? Today it does, contrary to "all four flags off", and disagrees with the Brain's
   readiness reading.
3. Which number is Mia's score — 672 (shown) or 624 (Beta.1)? The cutover is undecided.
