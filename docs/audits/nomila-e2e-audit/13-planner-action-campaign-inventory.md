# 13 — Planner · Action · Campaign inventory (Agent F, tables)

Companion to `06-planners-actions-campaigns.md`. Working tree `3f0139f6`; main `9fff9b15`. Dev DB read-only via the
Cloud SQL proxy; Mia = athlete `dc8f37f1-deff-43f8-8c02-e37a5cc20d4f`. "Dev rows" columns are counts from
`select … count(*)` on 2026-09-27.

## A. Planners and planner experiments

| # | Planner | Input contract | Evidence/context available | Output shape | Persistence | Actions it yields | In Existing Work | Execution capability | Status · Location | Quality of actual examples |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | Outreach planner (production-shaped) — `server/services/outreachPlannerOrchestrator.ts` + `intelligence/planner/**` | `PlannerHandoff {version, shape, recommendationId, domain, what, why, subject, objectiveIds, advances, intent, notSeen, runId}` + `OutreachPlannerInputs` (`orchestrator.ts:32-43`) | named live Objectives; deferred/declined **Objectives** as exclusions (Recommendation ledger passed as `null`, l.68); in-motion counterparts (`ownership.ts`); run's rendered state/work blocks | envelope {result, rationale, dependencies, completion, escalation, attachedTo} + `OutreachPlan` {targetClasses, researchNeeded, sequence{step,does,dependsOn,gate}, materials, commissions: `Commission[]`, omitted, attachments} | `outreach_plans` (0071), one active per rec; statuses prepared/reviewed/complete/attached/escalated/refused/superseded — **no "sent"** | none executable: `tap_to_send` steps name a gate with no outreach kind in `pending_actions` | `outreach_plan[<id>]` activation "…none sent." (`planner/outreach/projection.ts`), only with `includePersistedExecution` | none (no send path by construction) | `BUILT · OPEN_PR #654 (+#653) · flag:OUTREACH_PLANNER_ENABLED=off · no caller · dev rows 0` | none at 0.2.0 (0 provider calls) |
| A2 | Outreach planner — forcing (Cases A, B) | same handoff (0.1.0-exp router) | state block + Objectives; **no** deferred/declined view (the P1 cause) | as A1 minus commissions/omitted/attachments | files only | see 06 §3 | projected `planning_result[…]` in harness | none | `EXPERIMENTAL · HISTORICAL_ARTIFACT (#652)` | A: coherent, generic target classes, one named candidate (Adidas); B: coherent but targeted **StartX1**, a deferred + in-motion counterpart (12 refusals under current gates) |
| A3 | Content planner — forcing (Cases C, D) | same | state incl. `contentPerformance[tiktok|instagram]` | system, channels, cadence, sequence{phase,gate}, commissions{purpose, format_class, count_or_cadence, channel} | files only | 2 clip commissions/week streams | projected (C) / attached (D, CONTROLLED overlay) | none (no TikTok publish; no production content planner) | `EXPERIMENTAL · HISTORICAL_ARTIFACT` — deliberately not productionised | inherited the Brain's "cross-posting" mechanic; crossed CI edge in prose ("trending audio hooks, caption styling") |
| A4 | Escalation case (E) | CONTROLLED handoff `ctl-rec-matchday-as-plan` | same | `escalated`, `ends {objective_horizon, objective[ctl-obj-matchday-series]}` | files only | none | none | none (no planner→Campaign path, by design) | `EXPERIMENTAL · HISTORICAL_ARTIFACT` | correct behaviour; completion text narrates "a campaign charter" (not its work) |
| A5 | Commercial planner | — | — | — | Deals' own objects | — | — | Deals direct actions exist separately | `MISSING`; readiness maps `commercial` to the outreach planner (`executionReadiness.ts:63`) | — |
| A6 | Impact planner | — | — | — | — | — | — | — | `MISSING`; router `impact → impact` (`executionRouter.ts:94`); readiness "no planner owns the impact domain" | forcing ran it through outreach (Case A) |
| A7 | Weekly/social planner spine — `server/skills/weeklyPlan.ts` `deriveOccasions` | `PlanInputs {weekOf, posts, liveDeals}` | `media_assets` posts, live deals | `Occasion {kind (9-value vocab, 3 derived: cadence_gap, format_gap, deal_deliverable), because, window, confidence, rationale, facts}` | migration `0034_trend_observations` (branch only) | none (Strategist LLM step unbuilt) | none | none | `PARTIAL · OPEN_PR #309 @ 5dc4dcdc · not on main/stack` | UNKNOWN — no recorded output artifact found |
| A8 | Social-media-manager design | — | — | deterministic weekly pipeline, two LLM steps (design) | — | — | — | notes no platform can publish (read-only scopes) | `DESIGNED · DESIGN_DOC_ONLY` (`docs/plans/social-media-manager.md`, branch `f157b97b`) | — |
| A9 | Studio agent planner — `server/studio/agent/plan.ts`; doctrine `docs/plans/studio-plan-doctrine.md` | her sentence + library + objective code | her media library | N typed items (i2v/broll/product) | `studio_plans` (93 rows, all athlete `3811cedd…`; 0 for Mia; no `recommendation_id`) | Studio spend/generate | not in Existing Work | Studio generation | `BUILT · MAIN` — **Agent G owns** | — |
| A10 | Other things named "planner"/"Strategist" (not execution planners) | research refresh planner (`research_planner_runs`), deck Strategist `deriveDeckPlan` | — | — | — | — | — | — | out of scope; noted to avoid confusion | — |

## B. Work categories — what is she asked to do, what can Nomila do

| Category | Represented today? | Where | Who performs | Status · Location |
|---|---|---|---|---|
| Athlete decision — Objective | yes | `POST /objectives/:id/decision` (`routes/objectives.ts:59`); `objective_events`; dev: 3 active (disposition `modified`), 1 `deferred` (StartX1 `2d199757…`), 1 `declined` (`ca4976d6…`, evidence) | Mia | `BUILT · OPEN_PR/MAIN (Objective stack) · deployed-dev` |
| Athlete decision — Recommendation respond / authorize prepare | store only | `respondToRecommendation`, `authorizeRecommendationPrepare` (`brain/substrate.ts:98,100`); callers: scripts only | would be Mia | `BUILT (store) · OPEN_PR · no route` — all 3 live recs `none/none` |
| Athlete decision — deal | yes | reply intents `accept · negotiate · request_terms · decline` (`lib/draftPrompt.ts:15`); dispositions `not_a_deal · not_interested · expired` (`routes/deals.ts:892`) | Mia (tap) | `BUILT · MAIN · deployed-dev` |
| Athlete information request | partial | onboarding `ask` workflow step; intelligence_acquisition workflow (1 done, 1 canceled on dev); planner `researchNeeded{source_class: athlete}` (A1, no surface) | Mia via Mila chat | `PARTIAL` |
| Nomila research | yes (profile-level); no (planner research) | `tasks.type research`, `research_refresh` workflow (3 done), research substrate; planner research questions unexecuted | system | `BUILT · MAIN` / planner research `MISSING` |
| Outreach preparation | experimental only | `outreach_plans` (0 rows) | planner (off) | `BUILT · OPEN_PR · flag off` |
| Send / contact — inbound reply | yes | `pending_actions` kind `send_reply` → `/pending-actions/:id/approve` (`routes/pendingActions.ts:161`); Mila `draft_reply` drafts only; ask-terms batch (`routes/askTerms.ts`). Dev Mia: 51 pending + 1 approved, all `request_terms` | Mila/Nomila drafts, Mia taps | `BUILT · MAIN · deployed-dev` |
| Send / contact — outbound approach | no | no `pending_actions` kind (`schema.ts:2479`) | — | `MISSING` |
| Negotiation | yes (single reply) | `reply_intent negotiate` with leak linter (`services/dealDraft.ts:371`); Brain `direct_action intent: counter` only on CONTROLLED Northlight term sheet | Deals + Mia tap | `BUILT · MAIN`; Brain→Deals handoff `EXPERIMENTAL` |
| Content creation | yes (Studio) | `generation_jobs` (492 succeeded on dev, other athlete), Mila `request_creative` → `creative_intents` (0 rows) | Studio (spend gate) / Mia | Studio `BUILT · MAIN` (Agent G); direct door `BUILT · OPEN_PR · flag:STUDIO_CREATIVE_INTENTS reads ON on dev via STUDIO_ALL_ON` |
| Content approval | yes (Studio) | `/studio/assets/:id/approve|reject` (`routes/studio.ts:3546,3576`); creative interpretation confirm/reject | Mia | `BUILT · MAIN` (Agent G) |
| Publish | yes (Studio, IG) | `studio_publish_jobs` (2 succeeded on dev) | Mia tap | `BUILT · MAIN` (Agent G); TikTok/X/YT publish `MISSING` |
| Campaign obligation | schema + store | `campaign_deliverables` (0), `deal_deliverables` (0), `confirmExternally`, `completesWhen` | campaign owner / external party | `BUILT · OPEN_PR · test-harness-only` |
| Campaign approval (spec) | route | `POST /campaigns/:id/specs/:version/approve` | Mia | `BUILT · OPEN_PR · reachable on dev via STUDIO_ALL_ON · no data · no client found` |
| Follow-up | no object | only as planner `sequence` prose ("follow-up templates"); no reminder/follow-up entity (grep) | — | `MISSING` |
| Measurement / review | partial | `social_metric_observations`, `social_features`, `published_asset_identities` (0 rows on dev), `recordOutcome` (no production caller), `outreach_plans.reviewed` (no surface) | system | `PARTIAL · OPEN_PR` |
| Payments | yes | `/deals/:id/request-payment`, `/mark-delivered`, `/deposit-link`, `/deposit/release` (`routes/payments.ts`), `/:paymentId/confirm|dispute` (`routes/confirm.ts`); dev: 2 `pending` | Mia / brand | `BUILT · MAIN` |
| Autonomous agent actions (done for her, undoable) | yes | `agent_actions` (`schema.ts:2528`); Mia on dev: 2149 file, 126 auto_archive, 53 reclassify, 1 profile_write; `/agent-actions/:id/undo|wrong` | system; Mia can undo | `BUILT · MAIN · deployed-dev` |
| Background tasks | yes | `tasks` (research, deal_enrich, media_kit, brand_stories, delta_refresh); Mila `list_tasks_threads` | system | `BUILT · MAIN` |
| Notifications | minimal | `notification_log` types `score_milestone, new_deal, weekly_brief, brand_match, promotion`; dev: 2 unsent `promotion` | system | `PARTIAL · MAIN` |

## C. Chains: Recommendation → planner → work → executable?

| Chain | Recommendation (source) | Planner output | Proposed work | Actions that would exist | Executable today | Where it stops |
|---|---|---|---|---|---|---|
| Yuwa (live) | `rec_2507ecb0723f9dd8` (dev, 0.12.0) | none | none | none | no | readiness: no planner owns `impact`; no respond route |
| Yuwa (recorded) | `rec_9feaeb54fb19c6b1` (R15) | Case A plan | research → coordinate → deck → approval → templates → send | approval, deck commission, outbound sends | no | no outbound kind; deck = `written`/`other`, no executor |
| EdTech (live) | `rec_40c8ca0b0d70dc72` | none | none | none | no | outreach planner off, no caller |
| EdTech (recorded) | `rec_bb66435c91ced059` | Case B plan (StartX1) | as 06 §3 | StartX1 replies (Deals-owned), outbound sends | no | would be refused by current gates (12 problems) |
| TikTok (live) | `rec_454fd683b5faeac4` | none | none | none | no | no content planner (by decision) |
| TikTok (recorded) | `rec_764257cd61ef9777` | Case C system | 3 cross-posts/week | clip commissions, scheduling | no | no production content planner; no TikTok publish |
| Match-day (CONTROLLED) | `rec_c373ce1d5f9cbfb8` / `ctl-rec-matchday-as-plan` | Case E escalation / L1 campaign | campaign `b18e8e39…` planning, 0 deliverables | spec approval, (no deliverables to materialise) | no | ephemeral PGlite; no deliverable proposer |

## D. Campaign doors

| Door | Status · Location | Evidence |
|---|---|---|
| Recommendation | `BUILT · OPEN_PR · flag:BRAIN_SUBSTRATE_LOOP=off · script-only` | `routeGoverned` (`services/brainLoopDurable.ts:93-103`) |
| Deal | `DESIGNED` — intentionally unbuilt | no `deal_deliverables.campaign_id`; `campaign-lifecycle-close-and-measure-checkpoint.md` §6 |
| Athlete | `DESIGNED` — unbuilt | writer refuses non-recommendation doors (`campaign/store.ts:37`) |
| Observed | `DESIGNED` — unbuilt | Amendment 3 §7 text only |
| Planner Commission source | `DESIGNED` — intentionally unbuilt; pure mapper exists | `intentFromCommission` (`creative/intents.ts:15`), no caller |

## E. Flags relevant here (dev, live env read 2026-09-27)

| Flag | Read by | Dev value | Effective on dev |
|---|---|---|---|
| `OUTREACH_PLANNER_ENABLED` | `=== "true"` (`outreachPlannerOrchestrator.ts:29`) | unset | off |
| `BRAIN_SUBSTRATE_LOOP` | `=== "true"` (`brainLoopDurable.ts:31`) | unset | off |
| `STUDIO_CAMPAIGN_GOVERNANCE` | `studioFlag` (`studio/config.ts:1082`) | unset, `STUDIO_ALL_ON=true` | **on** (routes answer); readiness (`=== "true"`) says off |
| `STUDIO_CREATIVE_INTENTS` | `studioFlag` (`studio/config.ts:1080`) | unset, `STUDIO_ALL_ON=true` | **on** (Mila `request_creative` offered; creative routes answer) |
| `MILA_AGENT_V2` | — | `true` (`gcp/cloud-run-dev.yaml:299`) | on |
