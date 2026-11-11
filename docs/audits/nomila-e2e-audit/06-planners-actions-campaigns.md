# 06 — Specialized planning, Actions/work, and Campaigns (Agent F)

Scope: planners (outreach, content, commercial, weekly/social, Studio's shot planner — noted only), the actual planner
outputs recorded, what an athlete is actually asked to do and what Nomila can do for her, and Campaign (#570 +
Amendments 1–3) against what exists. Read-only. Working tree = `3f0139f6` (#665 tip); `origin/main` = `9fff9b15`.
Dev DB queried read-only through the Cloud SQL proxy (SQL quoted inline); the query script was deleted afterwards.
Companion tables: `13-planner-action-campaign-inventory.md`.

---

## 1. Summary

1. **Mia's three live Recommendations have never been passed to any planner.** Dev holds three
   `specialized_plan` Recommendations from run `f9e00c6f…` (0.12.0-exp), all `response.state = none`,
   `authz.state = none`, `execution.refs = []` (`select … from recommendations`). Dev has 0 `outreach_plans`, 0
   `campaigns`, 0 `creative_intents` rows. The planner outputs that exist were made from **older, recorded** R15
   Recommendations (`rec_9feaeb54…`, `rec_bb66435c…`, 0.10.0-exp), not from the live ones (`rec_2507ecb0…`,
   `rec_40c8ca0b…`, `rec_454fd683…`). · Recommendations `BUILT · OPEN_PR · deployed-dev`; the planner step for
   them is `MISSING` (never run).
2. **The chain stops at the router's `PlannerHandoff`.** `routeGoverned` (`server/services/brainLoopDurable.ts:93`)
   acts only on a `campaign` handoff; a `specialized_plan` handoff goes nowhere. `prepareOutreach` has **no caller**
   anywhere in `server/`, `client/` or `scripts/` (grep). · outreach planner `BUILT · OPEN_PR (#654) ·
   flag:OUTREACH_PLANNER_ENABLED=off · test-harness-only`.
3. **What the planners actually produced is concrete and mostly sensible preparation, not execution** (4 provider
   calls, USD 0.062, `planner-eval-spec/0.1.0-exp`): Yuwa → 3 target classes (only named candidate "Adidas"), 3
   research questions, 6-step sequence ending in a `tap_to_send`; EdTech → 3 target classes with **StartX1** as the
   one named candidate and a 7-step sequence that acted on StartX1; TikTok → a cross-posting system (3/week, 2
   commissions); match-day (CONTROLLED) → escalated to Campaign. Artifacts under
   `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/shape/planner/`. · `EXPERIMENTAL ·
   HISTORICAL_ARTIFACT`.
4. **The StartX1 failure is real and now caught offline only.** Case B made StartX1 — the subject of an Objective
   Mia **deferred** ("When u know more about this", dev `objectives.deferral`) and an in-motion inbound thread — its
   first warm lead. Re-gated under the 0.2.0 exclusions it yields **12 refusals** (`B/B.regated.json`). The new gates
   have never seen a live provider reply. · exclusions/ownership `BUILT · OPEN_PR (#653) · test-harness-only`.
5. **Nothing the planners proposed is executable today.** No `pending_actions` kind exists for an outbound approach
   (`pending_actions_kind_check IN ('send_reply')`, `shared/schema.ts:2479`); the Yuwa pitch deck commission maps to a
   `written`/`other` creative class with no Studio executor (backlog C2/F4); cross-posting to TikTok has no publisher
   for TikTok (`docs/plans/social-media-manager.md` §1.1, on `origin/claude/athlete-social-media-agent-8ff6ax`). ·
   `MISSING`.
6. **Readiness says the Yuwa Recommendation has no planner at all — contradicting the forcing experiment.** The
   router maps `impact → impact` (`executionRouter.ts:94`); `mountedCapabilities()` gives the outreach planner only
   `["outreach","commercial"]` (`executionReadiness.ts:63`). So Yuwa reads "no planner owns the impact domain today",
   while Case A ran the outreach planner on that exact impact handoff and the seam checkpoint (§9) said "treat as
   outreach with an impact lane". `prepareOutreach` itself does not check domain. · `PARTIAL · OPEN_PR`.
7. **The content planner is deliberately not productionised**; its one real output (Case C) was built on a leaked
   mechanic ("by cross-posting…") and crossed into Creative Intelligence in prose ("trending audio hooks, caption
   styling"). The live TikTok Recommendation is now rejected by the 0.12.0 whole-value gate if phrased that way, and
   the current live one is outcome-only: "Reactivate her dormant TikTok channel to engage short-form video audiences
   and expand her platform reach." · `EXPERIMENTAL · HISTORICAL_ARTIFACT`.
8. **What Mia is actually asked to do in the product today is Deals work, not Brain work.** On dev she has 51
   `pending` + 1 `approved` `send_reply` pending actions, all `reply_intent = request_terms` (Ask-for-terms batch,
   dated 2026-07-28 / 08-10), 10 deals in motion (7 negotiating, 1 accepted), 2149 `file` + 126 `auto_archive` agent
   actions done for her. None of this is linked to an Objective or Recommendation. · Deals `BUILT · MAIN ·
   deployed-dev`.
9. **No surface lets her respond to a Recommendation.** `respondToRecommendation` / `authorizeRecommendationPrepare`
   (`brain/substrate.ts:98,100`) are called only from scripts (`server/scripts/intelligence/brainRoute.ts`,
   `brainLoopDurable.ts`). Objectives have a route (`POST /objectives/:id/decision`, `server/routes/objectives.ts:59`).
   · Recommendation governance `BUILT (store) · OPEN_PR · no route`.
10. **Campaign exists end to end only on controlled inputs.** Recommendation → Campaign → CampaignSpec →
    CreativeIntent → Studio job was proven with the **CONTROLLED** match-day Objective `ctl-obj-matchday-series`, in an
    ephemeral PGlite store ("no dev record", `loop/L1/routed.json`) and one mocked-provider route test. Dev has 0
    campaigns. · `BUILT · OPEN_PR (#658–#660) · test-harness-only`.
11. **A recommendation-door Campaign is born with zero deliverables and nothing can add any.** `proposeSpecVersion`
    (`campaign/store.ts:81`) has no route and no caller; the governance surface can only approve an existing draft.
    The one campaign ever created (`b18e8e39…`, controlled) has `deliverableIds: []`. · `PARTIAL`.
12. **Contradiction with the control file: two of the "off" flags read ON on dev.** Live dev Cloud Run (rev
    `nomila-v2-00757-gs2`, image `nomila-v2:202771d3`) has `STUDIO_ALL_ON=true` and no `STUDIO_CAMPAIGN_GOVERNANCE` /
    `STUDIO_CREATIVE_INTENTS` lines (read via `gcloud run services describe`, read-only). Both flags read through
    `studioFlag` (`server/studio/config.ts:1080,1082`), which returns on under the master unless the flag is exactly
    `"false"` (`server/studio/studioFlag.ts`). So on dev the Campaign governance routes answer and Mila's
    `request_creative` tool is offered (`server/mila/loop.ts:198`, `MILA_AGENT_V2=true` in
    `gcp/cloud-run-dev.yaml:299`). `executionReadiness` reads the same flag with `=== "true"`
    (`executionReadiness.ts:56`) and reports Campaign governance as unavailable, so the two disagree. No rows exist
    yet, so nothing has been exercised. · `BUILT · OPEN_PR · deployed-dev · flag effectively on via STUDIO_ALL_ON`.
13. **Weekly/social planning is a pure occasion-finder on an open 2026-09 PR, never merged.** `deriveOccasions`
    (3 of 9 occasion kinds) on `feat/weekly-plan-spine` (#309, OPEN); not on main or on the #665 stack. It is a
    separate lineage from the Brain/planner stack and has no link to Objectives or Recommendations. ·
    `PARTIAL · OPEN_PR`.
14. **"Campaign" names two unrelated things in the repo.** #570 Campaign (`campaigns` tables, `intelligence/campaign/`)
    vs Studio's `JobCampaign` brief carrier and `CampaignWorkspaceScreen` on main (`server/studio/campaign/carrier.ts`,
    `client/screens/CampaignWorkspaceScreen.tsx`), which is a studio_plans → brief road, not a bounded effort. Agent G
    owns the Studio side.

---

## 2. Planner inventory

Full table in `13-…` §A. Key rows:

| Planner | Input | Output | Persistence | Status · Location |
|---|---|---|---|---|
| Outreach (production-shaped) | unchanged `PlannerHandoff` + named live Objectives + deferred/declined Objectives + Existing Work + state names + run's rendered blocks (`outreachPlannerOrchestrator.ts:32-43`) | thin envelope + `OutreachPlan` {targetClasses, researchNeeded, sequence{gate}, materials, commissions, omitted, attachments} (`outreach-planner-checkpoint.md` §6) | `outreach_plans` (0071), statuses `prepared·reviewed·complete·attached·escalated·refused·superseded`, no "sent" | `BUILT · OPEN_PR #654 · flag:OUTREACH_PLANNER_ENABLED=off · no caller · 0 rows on dev · 0 provider calls ever at 0.2.0` |
| Outreach/content (forcing) | same handoff, run artifact | as above (outreach) / system·channels·cadence·sequence·commissions (content) | none (files) | `EXPERIMENTAL · HISTORICAL_ARTIFACT (#652)` |
| Content (production) | — | — | would be `studio_plans` (no `recommendation_id` column; cols: …`creative_intent_id`) | `MISSING` by decision (`specialized-plan-forcing.md` §6) |
| Commercial | — | — | Deals' own objects | `MISSING` as a planner; readiness assigns `commercial` to the outreach planner (`executionReadiness.ts:63`) though the seam checkpoint §9 calls it a distinct semantic |
| Impact | — | — | — | `MISSING`; routed to its own domain, no owner (L3) |
| Weekly/social (`deriveOccasions`) | posts, live deals, week (`weeklyPlan.ts` @ `5dc4dcdc`) | occasions {kind, because, window, confidence, rationale, facts} | migration `0034_trend_observations` on branch only | `PARTIAL · OPEN_PR #309 · not on main` |
| Studio agent planner | her sentence + library | N typed items (i2v/broll/product) | `studio_plans` (93 rows on dev, all athlete `3811cedd…`, 0 for Mia) | `BUILT · MAIN` — Agent G |

Execution capability of every planner output: **none**. The orchestrator "has no send path" (asserted by test on the
module source, `outreach-planner-checkpoint.md` §9); `sequence[].gate = tap_to_send` names a gate that has no
implementation for outreach.

How planned work appears in Existing Work: `outreachWorkItem` (`planner/outreach/projection.ts`) → one
`activation` under `outreach_plan[<id>]`, statement "Outreach planned toward <classes>: n step(s), m commission(s),
none sent." Read into the Brain only when `includePersistedExecution` is set (`brainInputsBuilder.ts:44,91`). Existing
Work does **not** include `pending_actions`, `studio_plans`, direct-door creative intents, generation jobs or
publishes (`brain/existingWork.ts:31-46`).

---

## 3. What the planners actually produced — reproduced

All from `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/shape/planner/`, model `gemini-3.5-flash`,
`planner-eval-spec/0.1.0-exp`. Governance on the handoffs was **simulated** (`governance.simulated:
["accept","prepare_authorized"]` in the loop artifacts); Mia never accepted these.

### Chain A — Yuwa / CSR (real Objective `b1c799e3…`, impact)

- **Recommendation (R15, not the live one):** `rec_9feaeb54fb19c6b1` — "Initiate outreach to global brand CSR
  departments to secure partnerships co-funding her work with the Yuwa girls empowerment program." notSeen: "Budget
  parameters and alignment criteria of target corporate social responsibility funds" (`A/A.json` `handoff`).
- **Targets:** "Global Sports & Athletic Brands" (candidates `["Adidas"]`); "Education Technology & Youth Development
  Corporations" (none); "Multinational Technology & Consulting Firms with South Asian Initiatives" (none).
- **Research:** CSR budget/criteria → `external`; "precise current funding needs … at the Yuwa girls empowerment
  program" → `athlete`; NIL/conference rules on CSR funds → `connected`.
- **Sequence:** 1 research (none) → 2 "Coordinate with Mia and Yuwa leadership" (none) → 3 "Commission the creation
  of a high-impact, professional pitch deck" (none) → 4 present targets + deck (`athlete_approval`) → 5 "Draft
  customized outreach email templates and professional LinkedIn sequences" (none) → 6 "Initiate outreach to selected
  corporate social responsibility departments" (`tap_to_send`).
- **Materials:** "Yuwa Partnership Pitch Deck" (`commissions: content`); "Tailored CSR Outreach Sequences" (none).
- **Completion:** "…Mia has approved the final tailored pitch deck and target brand list." does_not_imply "…any
  corporate sponsorships or CSR co-funding agreements have been finalized".
- **Gate history:** 2 refusals originally (nouns "pitch deck", "email templates" read as sends) → 0 after the verb
  correction (`A/A.regated.json` `problemsBefore`).
- **Actions that would exist:** athlete approval of targets+deck (no surface); a deck commission (no executor for
  `written`/`other`); outreach sends (no `pending_actions` kind). **Executable today: nothing.**
- **Live equivalent:** `rec_2507ecb0723f9dd8` "Target global brand and corporate social responsibility partnerships
  that align with her philanthropic leadership at the Yuwa girls empowerment program." — never planned; readiness
  `unavailable — no planner owns the impact domain today` (`brain-reliability-0.12.0-checkpoint.md` §8 l.217).

### Chain B — EdTech / tech (real Objective `c0f587e4…`, positioning → outreach)

- **Recommendation (R15):** `rec_bb66435c91ced059` — "Target premium brand partnerships and ambassador roles within
  the EdTech, STEM, and technology venture capital sectors."
- **Targets:** "Stanford-affiliated Tech Startups and Accelerators" (candidates `["StartX1"]`, why: "the multiple
  inbound signals from StartX1"); "Premium STEM & Educational Technology Platforms"; "Technology Venture Capital
  Firms".
- **Research:** partnership structures/compliance → `external`; "Mia's specific boundaries regarding …
  speculative technology sectors (e.g., specific AI subfields or cryptocurrency)" → `athlete`.
- **Sequence (7):** research → "Review the context of the three StartX1 inbound signals" → positioning narrative →
  `athlete_approval` ("specific StartX1 follow-up strategy") → one-pager/deck → "Draft custom outreach and follow-up
  templates for StartX1 and selected EdTech/STEM prospects" → "Queue and prepare final outreach messages"
  (`tap_to_send`). Materials both `commissions: none`.
- **Exclusion failure:** StartX1 = deferred Objective `2d199757…` ("When u know more about this") and an in-motion
  inbound (`deal_detected`). Re-gated: 12 problems — candidate, three `commercialPosition.inbound[3|6|9]`
  dependencies, steps 2/4/6 ×2 (deferred + in-motion) (`B/B.regated.json`). Recorded plan would now be **refused**.
- **Actions that would exist:** StartX1 replies (Deals' `send_reply`, owned by Deals, refused for the planner);
  outbound approaches (no kind). **Executable today: nothing from the plan**; Deals could already draft a StartX1
  reply independently.
- **Live equivalent:** `rec_40c8ca0b0d70dc72` — "Target brand partnerships and ambassador roles within the EdTech,
  STEM, and technology venture sectors that align with her academic positioning." Readiness `unavailable — the
  outreach planner is mounted but frozen off`. Never planned.

### Chain C — audience / TikTok (real Objective `feb62891…`, audience → content)

- **Recommendation (A3-era, 0.7.0 wording kept on purpose):** `rec_764257cd61ef9777` — "Create a specialized plan to
  reactivate her dormant TikTok channel by cross-posting existing video formats like Reels and carousels."
- **Planner output:** system "Reactivate the dormant TikTok channel and build organic consistency through the
  adaptation of Instagram media assets."; cadence "3 cross-posts per week"; phases: audit 6 months of IG
  (`athlete_approval`) → "adapt them to TikTok specs (aspect ratios, trending audio hooks, caption styling)" (none) →
  "Queue the adapted content … and schedule" (`tap_to_send`); commissions: Reels → TikTok clips "2 clips per week";
  carousels → vertical clips "1 clip per week" (`C/C.json`).
- **Projection:** `planning_result[content:rec_764257cd61ef9777]` "Content system planned — … : 2 commission(s),
  nothing produced yet."
- **Case D (same handoff, CONTROLLED overlay `ctl-r1-tiktok-series`):** `attached`, plan nothing (`D/D.json`).
- **Where it stops:** no content planner in production, no `studio_plans` materialisation, no TikTok publish.
  Live equivalent `rec_454fd683b5faeac4` readiness `unavailable — no planner owns the content domain today`.

### Chain E — match-day (CONTROLLED)

`ctl-rec-matchday-as-plan` on `objective[ctl-obj-matchday-series]` (fabricated overlay). Planner returned
`result: escalated`, `ends {source: objective_horizon, ref: objective[ctl-obj-matchday-series]}`, no plan
(`E/E.json`). Nothing created.

---

## 4. Actions — what is Mia asked to do, and what can Nomila do?

Full category table in `13-…` §B. Headline: **the only athlete-facing "do this" loops that work today are Deals
(draft → `pending_actions` → tap to send, ask-for-terms batch, dispositions), payments (request/mark-delivered/
deposit), Objective decisions, and Studio's own create/approve/publish.** Everything the Brain/planner stack would ask
of her — respond to a Recommendation, authorize preparation, review an outreach scope, approve a CampaignSpec, send an
outbound approach — has either no route (Recommendations, outreach review), a store function only (spec proposal), or
a route that is reachable on dev only because of `STUDIO_ALL_ON` (Campaign governance) with no data behind it.

Existing action-like concepts (none is universal, and none should be invented): `pending_actions` (one kind,
`send_reply`), `agent_actions` (autonomous, receipted: `file, auto_decline, reclassify, mute_sender, reopen,
auto_archive, profile_write`, `schema.ts:2528`), `tasks` (background jobs: `research, deal_enrich, media_kit,
brand_stories, delta_refresh`, `schema.ts:663`), `notification_log` (2 unsent `promotion` rows on dev),
`workflow_runs/steps` (onboarding, first_look, research_refresh, social_sync, mia_evaluation,
intelligence_acquisition), `objective_events`, `recommendation_events`, `outreach_plans.sequence`,
`campaign_deliverables`, `deal_deliverables` (0 rows on dev), `creative_intents`, `generation_jobs`,
`studio_publish_jobs`, `payments`.

---

## 5. Campaigns — #570 + Amendments 1–3 vs what exists

#570 is `OPEN` (docs branch `origin/docs/campaign-slice-design`, Amendments at `94579d0f`, `495a6cc2`, `59741979`,
`f0579af6`). Implementation stack #658/#659/#660 all `OPEN`. Migrations 0073/0074 applied on dev; tables empty.

| Handoff | Status · Location · flag | Evidence / artifact |
|---|---|---|
| Recommendation (campaign shape, typed `ends`) | `BUILT · OPEN_PR · deployed-dev` (0.11/0.12 spec) | L1 run produced one `campaign` RECOMMEND — on the CONTROLLED Objective only (`campaign-closed-loop.md` §8). Mia's live run: 0 campaign-shaped. |
| Router → `CampaignOriginProposal` | `BUILT · OPEN_PR` | resolves `ends` against Objective horizon / deal term / assertion; `athlete_stated` refuses (no carrier) (`specialized-plan-seam-checkpoint.md` §3) |
| Campaign origin writer (recommendation door) | `BUILT · OPEN_PR · flag:BRAIN_SUBSTRATE_LOOP=off · script-only caller` | `routeGoverned` in one transaction (L1 closed); created `b18e8e39…` (CONTROLLED) in ephemeral PGlite: purpose "Execute a match-day content campaign across her Instagram and TikTok channels for every Stanford women's soccer match through the end of the season." status `planning`, spec v1 `draft`, `deliverableIds: []` (`loop/L1/routed.json`) |
| CampaignSpec proposal (deliverables enter) | `PARTIAL` — store function only, no route/caller (`campaign/store.ts:81`) | tests only |
| Spec approval (second act) | `BUILT · OPEN_PR · flag:STUDIO_CAMPAIGN_GOVERNANCE (reads ON on dev via STUDIO_ALL_ON)` | `POST /campaigns/:id/specs/:version/approve` (`routes/campaignGovernance.ts:53`); no client screen found |
| CampaignSpec → CreativeIntent[] | `BUILT · OPEN_PR · test-harness-only` | `materializeCreativeIntents`; content only; key `campaign:<id>:<deliverable>:<unit>` |
| CreativeIntent → Studio job | `BUILT · OPEN_PR · test-harness-only (mocked provider)` | `routes/studio.campaign.test.ts` — job carries `creative_intent_id, source_spec_id, source_spec_version, campaign_deliverable_id` (`campaign-source.md` §14) |
| Fulfilment (`completesWhen`) | `BUILT · OPEN_PR` derived; `confirmExternally` the only write | Amendment 3 |
| Ending (`fulfilled/expired/cancelled`) | `BUILT · OPEN_PR` | `endCampaign`; `objective_horizon` period horizons read `unknown` (no date) — Mia's live horizons are `multi_year`, `next_12_months`, null (dev `objectives.horizon`) |
| Outcome → Recommendation | `BUILT (writer) · OPEN_PR · no production caller` | `recordOutcome`; exercised in the durable loop on the CONTROLLED scenario, `recommended_and_followed` (`durable-brain-loop.md` l.55-57) |

Doors: **recommendation** — built, harness/script only. **deal** — intentionally unbuilt (no
`deal_deliverables.campaign_id`; `deal_deliverables` 0 rows on dev). **athlete** — unbuilt (writer throws `door "…" has
no writer in this slice`, `campaign/store.ts:37`). **observed** — unbuilt. **planner Commission source** —
intentionally unbuilt; pure `intentFromCommission` exists with no caller (`creative/intents.ts:15`). All recorded as
"later doors, not built" (`campaign-lifecycle-close-and-measure-checkpoint.md` §6). Architecture not reopened.

---

## 6. Prior findings re-verified

| Prior finding | Source | Verdict | Evidence |
|---|---|---|---|
| Outreach planner has no caller; flag off everywhere | outreach-planner-checkpoint §14 | STILL TRUE | grep `prepareOutreach` → definition only; dev env has no `OUTREACH_PLANNER_ENABLED` |
| `outreach_plans` created empty on next dev deploy | same §0 | STILL TRUE | dev `count(*) = 0` |
| StartX1 control: 12 refusals on B | same §2 | STILL TRUE | `B/B.regated.json` problems (12 + version) |
| `reviewed` act has no surface | same §14 | STILL TRUE | `markOutreachReviewed` store-only |
| Handoff sufficient unchanged | specialized-plan-seam §5–6 | STILL TRUE (at 0.1.0) | four handoffs byte-for-byte (`specialized-plan-forcing.md` Q1) |
| `impact` = outreach with impact lane | seam §9 | PARTIALLY SUPERSEDED | readiness excludes `impact` from outreach (`executionReadiness.ts:63`); orchestrator doesn't check |
| Generic Plan entity unnecessary | seam §11 | STILL TRUE | no such table in `shared/schema.ts` |
| P1 deferred subjects not in planner view | forcing §4 | SUPERSEDED (closed offline) | `planner/exclusions.ts`; but the orchestrator passes `ledger: null` (`outreachPlannerOrchestrator.ts:68`), so deferred/declined **Recommendations** are not excluded on the production path — only Objectives |
| P2 counterpart in motion → Deals | forcing §4 | SUPERSEDED (closed) | `planner/ownership.ts` |
| P3 CI edge crossed in prose | forcing §4 | SUPERSEDED for outreach (typed `Commission`); STILL TRUE for content | content planner not built |
| P4 `planning_result`/`studio_plan` ref kinds | forcing §4 | PARTIALLY | `outreach_plan` added; `studio_plan` not |
| P5 residual mechanic binds planners | forcing §4 | STILL TRUE, mitigated upstream | R20 closed at 0.12.0; live TikTok `what` is outcome-only |
| Case 3 campaign selected unprompted | recommendation-execution-shape-forcing | STILL TRUE but CONTROLLED only | only `ctl-obj-matchday-series` ever yields `campaign` |
| Shape unstable across runs (R16) | same / backlog | CANNOT VERIFY at this manifest | one live run only |
| K1–K4 closed by Amendment 3 | backlog | STILL TRUE | migration 0074; store validates `completesWhen` |
| L1 (campaign + ref not one txn) closed | backlog | STILL TRUE | `brainLoopDurable.ts:97` `db.transaction` |
| L3 nothing live is executable | backlog | STILL TRUE | dev recs: 3× `specialized_plan`, refs `[]`; readiness 3× unavailable |
| Campaign governance "off everywhere" | lifecycle checkpoint §6 | **SUPERSEDED on dev** | `STUDIO_ALL_ON=true` live; `studioFlag` semantics |
| S2 substrate not on dev | backlog | SUPERSEDED | tables present, 1 brain_run, 3 recs |
| M5 ingest misses the live-published post | backlog | CANNOT VERIFY here (not re-queried) | Measure owned elsewhere |

---

## 7. UNKNOWNs

- Whether the outreach planner at `planner-eval-spec/0.2.0-exp` produces acceptable plans at all: **0 provider calls
  ever at 0.2.0**. Settle: one approved call on the live EdTech handoff with exclusions rendered.
- Whether a client surface exists for Campaign governance or creative intents on the #665 stack: grep found no client
  caller of `/campaigns`; confirm with Agent G / a client search on Studio branches.
- Whether Mila has actually offered `request_creative` to Mia on dev: `creative_intents` has 0 rows, so either never
  offered/used or never invoked. Settle: Mila tool-call logs / traces on dev.
- Which planner owns `impact`: product decision, not settled in code (see §8).
- What StartX1 and Adidas look like in Deals right now (thread states) relative to planner exclusions: not re-queried.

## 8. Open questions for the founder

1. Should the Yuwa (impact) Recommendation be prepared by the outreach planner (as the forcing experiment did), or
   stay "no owner" as readiness says today?
2. When a recommendation-door Campaign is created with zero deliverables, who is meant to propose its deliverables —
   the athlete, a campaign planner, or Creative Intelligence? Today nobody can.
3. Should `STUDIO_ALL_ON` be allowed to switch on the Campaign governance and creative-intent surfaces on dev, or
   should those two get explicit `"false"` lines until they are meant to be seen?
4. Is the first athlete-facing act "respond to a Recommendation" (no route exists), given every live Recommendation is
   unavailable for preparation?
