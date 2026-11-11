# CreativeIntent — the offline seam forcing experiment

**Status:** findings for review · branch `feat/creative-intent-forcing`, stacked on #655 · **0 provider calls · no DB · no Studio mutation**
**What ran:** the six cases of `campaign-creative-seam-checkpoint.md` §18 as deterministic tests (`server/services/intelligence/creative/forcing.test.ts`, 12 tests, all green on the first run) over an experimental, unmounted module: `creative/contract.ts` (`creative-intent/0.1.0-exp`), `creative/intents.ts` (the three source adapters, derived state, fulfilment), `creative/toBriefInput.ts` (the last adapter, test-only). Types are imported from Studio (`BriefInput`, `BriefDeliverable`, `BriefObjective`, `JobCampaign`) — read, never changed.
**Controls:** #570 as amended (Amendment 1 `94579d0f`, Amendment 2 `495a6cc2`); `Commission`; the recorded #649 Case 5 direct-door `BriefInput`; the #652 Case A material as the planner's Commission.

---

## 0. #570 Amendment 2 — applied

On `docs/campaign-slice-design`, commit `495a6cc2`, narrowly: §5 is now **`CampaignSpec → CreativeIntent[]`** for content deliverables only, one intent per unit of quantity, keyed `(campaignId, campaignDeliverableId, unit)` so a new spec version yields intents only for deliverables without one; the field table maps the spec onto the intent; `BriefSeed` is retired as an object and its idea survives only as the last adapter into `BriefInput`; the §2 diagram, invariant 7, the C2 row and invariant-table row 2 reworded. Recorded and not solved: the `idea` state has no writer from the recommendation door (the router hands off only accepted-and-authorized Recommendations, so a router-created campaign starts at `planning`; the Recommendation record is the "idea").

## 1. The six cases

| Case | Input | Result | Acceptance |
|---|---|---|---|
| **1 · planner Commission** | the #652 Case A material ("a piece that introduces her programme with Yuwa to the CSR departments she will approach") as a `Commission`: audience "CSR decision-makers", `written`, timing "before the first approach", two constraints, why | one intent, `source planner`, `lineage {outreachPlanId, recommendationId}`, `format {class: written, fixedBy: planner}`, constraints `source: planner` | purpose/why/audience/constraints cross ✓ · no concept/hook/caption/treatment/reference key anywhere in the intent ✓ · no objective ✓ · the adapter refuses without a confirmed interpretation ✓ · with one, `objective` comes from it (`announce`), never from the Commission ✓. **Mismatch found:** a `written` piece has no Studio deliverable — the adapter refuses honestly (§9). Re-run with `carousel`: a full `BriefInput` with the plan's carrier. |
| **2 · direct athlete** | "Make a post about today's win", moment `ctx[0]` | one intent, `source athlete`, `purpose` = her words, `ask.verbatim` = her words, `ask.moment` by reference, `format {class: post, quantity: 1, fixedBy: athlete}`, `why null`, `brandId null`, `lineage {}` | verbatim ✓ · moment by reference ✓ · format fixed only because she said post (an ask with no deliverable word → `class null`) ✓ · no campaign/recommendation/planner/brand ✓ · no objective ✓ · the recorded #649 `BriefInput` (`system · recap · post · generate · brand null`) is reproduced **only** after a confirmed interpretation whose goal is `recap` ✓ · the `BriefOrigin` gap is emitted as an explicit note ✓. Limit recorded: whole-word matching reads "post-game" as naming a post. |
| **3 · single-asset campaign** | #570's gorjana-style deal door: spec v1, one `reel`, `sourceQuote` "one hero video for the spring launch", brand 42, due date | exactly one intent, `fixedBy: contract`, `brandId 42`, `lineage {campaignId, specVersion 1, campaignDeliverableId d1, dealDeliverableId dd-d1, unit 1}`; `why` = the spec's purpose | contractual format stays fixed ✓ · lineage preserved ✓ · the brief is `inbound` with the contract's words as the `ask` (Studio's own rule for text it did not write) ✓ · with a job and an approved asset, `deriveIntentState = cleared` and `fulfilmentOf = 1 of 1`, derived from the asset through the intent — **no campaign state copied into Studio** ✓ |
| **4 · multi-asset, then v2** | spec v1: post, reel, story; spec v2 adds a clip; a quantity-2 deliverable | three intents, one campaign id, three distinct keys, each with `specVersion 1` and its deliverable id; v2 → **exactly one** new intent (`specVersion 2`); the three earlier are returned unchanged (`kept`); quantity 2 → units 1 and 2 | ✓ all. Shared interpretation: one carrier (from the first confirmed plan) reused by all three briefs — three briefs, one concept, three intents, three deliverables — without collapsing the intents (§5). |
| **5 · mixed campaign** | two content deliverables + one `access` obligation ("one appearance at the spring launch") | two intents; the appearance yields none and its words appear nowhere in what creative intelligence would see | only content becomes intents ✓ · the obligation stays a campaign deliverable ✓ · CI never receives the campaign's execution problem ✓ |
| **6 · revision** | A: a rejected proposal then a confirmed one; B: plan p2 with `parent p1, version 2`; C: asset rejected, regeneration running | states `confirmed → confirmed → produced`; `intent.id` and `specVersion` constant throughout; the key `campaign:camp-1:d1:1` unchanged | each revision is visible at its own stage ✓ · nothing upstream reopens ✓ |

## 2. Does `CreativeIntent` survive unchanged? — one field removed, nothing added

The field set of #655 §5 sufficed for all six cases with **one change: `status` is gone** (§3). No field carried creative solution (asserted structurally: none of concept/hook/angle/caption/treatment/tone/shot/edit/references/look/music/storyboard appears in any intent, and none of objective/what/recommendation/execution_path either). No upstream strategic text is copied beyond one sentence: `why` (the spec's purpose or the Commission's why); the Objective, the Recommendation's `what`, the spec's deliverables/period/constraints body and the evidence are reached by reference. `source + lineage` was sufficient for provenance in every case (§7). One addition inside `lineage`, not a new field: `unit` (which unit of a quantity-n deliverable), needed for the idempotency key.

## 3. Status verdict — no lifecycle on the intent

Pressure-tested as asked. Every question a status would answer is answered by downstream records through `creative_intent_id`: *interpreted* = a proposal exists for the intent; *confirmed* = a confirmed proposal or a plan; *in_production* = a job pending/queued/running; *produced* = an asset; *cleared* = an approved asset; *published* = `posted_at`. `deriveIntentState` computes these from `{proposals, plans, jobs, assets}` and Case 6 shows a mutable copy would have to be rewritten at every revision — it would only drift. The one fact nothing downstream can express is that the intent was **withdrawn** regardless of production, so `withdrawnAt` is the intent's only mutable field (and it wins over any downstream state). `open` is the absence of everything. Decision: **drop `status`; keep `withdrawnAt`.** Fewer states, no duplication of Studio.

## 4. BriefSeed retirement — clean

`CampaignSpec → CreativeIntent[]` did everything the seed adapter promised (Case 3, 4, 5) and one thing it could not: idempotency across spec versions by key. The "partial `BriefInput`" idea reappears exactly once, at the end (`briefInputFrom`), and there it is the *only* place `objective` is ever set. No object now means "creative work requested" except `CreativeIntent`; `Commission` is its authoring shape on the planner side (`intentFromCommission` is a field-for-field carry).

## 5. Campaign-level BriefProposal — not persisted independently; the alternative works

Case 4 needed a shared interpretation and got it **without** a `scope: campaign | intent` object: the first confirmed plan's carrier (`JobCampaign`, produced by Studio's own `carrierFromPlan`) was handed to each intent's adapter, so three briefs carried one concept. That is today's mechanism — each `studio_plans` row freezes its own `brief`, and a plan under a campaign starts from the shared brief. What it costs: the shared `CampaignBrief` is copied into each plan's `brief` (Studio's deliberate rule: a later change never silently rewrites a frozen scope). What it lacks: a *reference* from the later plans to the first, so "which interpretation did these three share" is reconstructible only by comparing briefs. Verdict: **do not add campaign-scoped persistence now.** If a reference is wanted later, the smallest form is a nullable `shared_from_plan_id` on `studio_plans`, not a new object.

## 6. `BriefInput` adapter — works, with two honest limits

Consumes the intent, the confirmed proposal's goal and the plan's carrier; invents nothing. Verified: `objective` from the confirmed interpretation ✓; `deliverable` from `format.class` ✓; `brandId` from the intent ✓; campaign lineage and direction/references through the existing `JobCampaign` carrier ✓ (concept, tone, style, references ride it as Studio already expects); a contract's words as an `inbound` ask ✓; **athlete-origin gap recorded explicitly** — `BriefOrigin` has no `athlete` value, so her own ask travels as `system` and the adapter says so in its notes ✓. Limits: (a) it refuses a `written` or `other` format class — Studio has no such job, and a planner commissioning a written piece needs a different executor (§9); (b) it needs a format class — an athlete ask with no deliverable word cannot become a brief until the confirmed interpretation fixes one, which is correct and means the confirmation step must be allowed to fix `format.class` (not tested here; an implementation note).

## 7. Lineage verdict

The chain `source → creative_intent → studio_plan → preview → job → asset → publish` resolved in Cases 3, 4 and 6 with exactly the ids proposed: `creative_intent_id` on `studio_plans` and on `generation_jobs`; everything upstream (Recommendation, Objective, campaign, deliverable) resolves *upward* through the intent's `lineage`, and nothing strategic sits on jobs or assets. **`studio_plan_id` on the job is not needed:** the plan id already reaches the job inside the frozen brief as `campaign.planId` (`JobCampaign`), which is what the adapter carries; a column would duplicate a value the job already holds.

## 8. Additional ids truly required

None beyond the checkpoint's: a `creative_intents` record, `studio_plans.creative_intent_id`, `generation_jobs.creative_intent_id`, and #570 §6's three job columns for the campaign deliverable (`source_spec_id`, `source_spec_version`, `campaign_deliverable_id`) — the last three are reachable through the intent too, so they are a denormalisation #570 already chose, not a new requirement. Not required: `studio_plan_id` on jobs, a campaign-scoped proposal id, a `brief_id` column.

## 9. Studio contract mismatches found

1. **`BriefOrigin` lacks `athlete`** (known; now emitted as a note by the adapter).
2. **A written or other creative piece has no Studio deliverable.** The planner's most natural commission (a pitch document) is not something Studio produces; `FormatClass` on the intent admits `written | other`, and the adapter refuses them. Executor for those is undefined — record, do not invent.
3. **A contract's words as `inbound` ask** — correct by Studio's rule, but it means a deal-door brief carries `InboundAsk`, whose `featuredPieces` are for brand text; harmless, noted.
4. **"post-game" reads as "post"** in the athlete-ask format detection (whole-word match); the confirmation step must be able to correct `format.class`.

## 10. Direct athlete intent — works cleanly

Case 2: one object, her words untouched, the moment by reference, nothing manufactured above it, the objective chosen only at confirmation, the recorded #649 brief reproduced from the confirmed goal. The only friction is Studio's origin enum.

## 11. `CampaignSpec → CreativeIntent[]` — works cleanly

Cases 3–6: correct count, fixed format, brand from the deliverable or the single-brand campaign, lineage complete, idempotent across versions, non-content excluded, fulfilment derivable. One design confirmation: the `why` copied onto each intent is the spec's purpose sentence — one sentence, the only strategic text carried.

## 12. Exact minimal implementation sequence

1. **`creative_intents` table** (narrow: the contract of §2 with `withdrawn_at`; unique on the intent key) + the two additive nullable columns `studio_plans.creative_intent_id`, `generation_jobs.creative_intent_id`. One migration, additive, nothing reads it yet.
2. **`intentFromAthleteAsk` behind the direct door** — the smallest real door: a Mila tool that creates the intent from her words (today no tool creates briefs), with the moment by Context reference. No Campaign, no planner involved.
3. **Confirmation as a read stage**: persist the `BriefProposal` with `intent_id` and `confirmed_at` (today the confirm flags are stored on the plan and consumed by nothing), and let the confirmed interpretation fix `format.class` when the intent has none.
4. **`briefInputFrom` on the preview path** — the adapter emits `BriefInput` into the existing `POST /studio/preview` assembly; `creative_intent_id` written onto the plan and the job. Studio's stages 2–4 unchanged.
5. **`intentsFromCampaignSpec`** with the Campaign origin writer (#570 C1/C2) — second source, separately reviewed.
6. **`intentFromCommission`** when the outreach planner is un-frozen — third source; the `written` executor question decided then.
Not in sequence: any `AssetSpec`, campaign-scoped proposal persistence, `studio_plan_id` on jobs, a `BriefOrigin` change (Studio's to make, when step 2 lands).

---

## 13. Acceptance (27 September 2026)

Accepted by the user: the CreativeIntent seam is sufficiently pressure-tested; architecture iteration on it stopped. Implemented next as the first real vertical slice (athlete intent → CreativeIntent → interpretation → confirmation → the existing Studio preview/generation path), `creative-intent-slice.md`, with Campaign kept separate.
