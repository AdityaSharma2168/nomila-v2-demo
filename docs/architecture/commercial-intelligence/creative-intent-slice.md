# CreativeIntent — the athlete vertical slice (mounted, flag off)

**Status:** for review · branch `feat/creative-intent-slice`, stacked on #656 · **0 provider calls**
**What is mounted:** athlete creative intent → `CreativeIntent` → Creative Intelligence interpretation (existing direction tools) → athlete confirmation → the existing Studio preview/generation path, with `creative_intent_id` on the plan and the job. Behind `STUDIO_CREATIVE_INTENTS` (off everywhere): the Mila tool is not declared, the routes are 404, `creativeIntentId` is an unknown field on preview and plan.
**Not in this PR, by rule:** no Campaign (origin writer, spec adapter, deal door, planner source), no content planner, no Deals, Rate, Objective, Opportunity or Brain change.

---

## 1. Migration / schema delta

`migrations/0072_creative_intents.sql` (in the deploy list; `db-migrate.sh` header bumped):

- **`creative_intents`** — `id, athlete_id, version, intent_key, source_kind (CHECK planner|campaign|athlete), source_ref, purpose, why, audience_role, brand_id, format jsonb, channel, timing, constraints jsonb, ask jsonb, lineage jsonb, created_at, withdrawn_at`. Unique `(athlete_id, intent_key)` — the idempotency identity; for a campaign later, `campaign:<id>:<deliverable>:<unit>`. **No `status` column.**
- **`creative_interpretations`** — `id, athlete_id, creative_intent_id (FK), version, supersedes, source_tool, proposal jsonb, flags jsonb, created_at, confirmed_at, confirmed_concept jsonb, confirmed_format_class, confirmed_flags jsonb`. One row per interpretation version; confirmation is columns on the row, not a status.
- **Additive, nullable:** `studio_plans.creative_intent_id`, `generation_jobs.creative_intent_id` (FK, `ON DELETE SET NULL`, partial indexes).
- **`generation_jobs_origin_check`** widened to `('system','inbound','athlete')` (DROP/ADD, the 0072 precedent). Drizzle mirrors all of it.
- Not added: `studio_plan_id` on jobs, any campaign-scoped proposal table, `AssetSpec`, a generic workflow table.

## 2. CreativeIntent store / API

`server/services/intelligence/creative/store.ts` (pure DB, no provider): `createCreativeIntent(db, intent, intentKey)` → `{record, created}` (idempotent), `getCreativeIntent`, `withdrawCreativeIntent`, `addInterpretation` (versions, `supersedes`; refused on a withdrawn intent), `latestInterpretation`, `confirmedInterpretation`, `confirmInterpretation` (refuses a superseded version and a withdrawn intent; may set `confirmed_format_class`), `downstreamOf`, `creativeIntentState` (read-only derivation). The contract (`creative/contract.ts`) is #656's with `status` removed and `withdrawnAt` kept; `lineage.unit` preserved for campaign idempotency.

HTTP (`server/studio/creative/routes.ts`, gate = Studio's + the flag): `POST /studio/creative/intents` (her words), `GET /studio/creative/intents/:id` (intent, derived state, latest interpretation, downstream), `POST …/:id/interpret`, `POST …/:id/confirm`, `POST …/:id/withdraw`. Athlete-scoped everywhere; another athlete gets 404.

## 3. Athlete direct-door tool

`server/mila/tools/requestCreative.ts` — `request_creative { ask, requestKey?, brandId? }`, declared to the model **only while the flag is on** (`creativeTools()` in `mila/registry.ts`, merged in `mila/loop.ts` like the onboarding tools). It calls the same `requestCreative` as the HTTP door (`studio/creative/door.ts`): her words verbatim, `source.kind = athlete`, no Recommendation/Campaign/planner, no objective, brand null unless the caller resolved one, and the format fixed **only** when her words plainly name a Studio deliverable as a thing she wants ("a post", "two reels"); "post-game", "storyline" and an ask with no deliverable word leave it unset for confirmation. Idempotency: the caller's `requestKey` (the message id), else the same words on the same day. The moment is a `{asOf, ref}` Context reference when the caller has one — **today no server-side Context reader yields fixtures**, so the tool passes `null`; recorded, not invented.

## 4. BriefOrigin change

`server/studio/brief.ts`: `BriefOrigin = "system" | "inbound" | "athlete"` — `inbound` external/untrusted text, `system` Nomila-originated, `athlete` her own request. Only the preview route sets it (`creative?.origin ?? "system"`); `directionFor` treats `athlete` as `chosen`/trusted like `system`; the `inbound`-needs-an-ask rule is untouched. DB CHECK widened (§1). The experimental adapter and its forcing test updated (the recorded #649 mapping's `system` is asserted as the pre-fix value).

## 5. Proposal persistence / confirmation flow

`server/studio/creative/interpret.ts` — **no new engine**: `proposeCampaign(athleteId, { objective: intent.purpose, brand: null, occasion })` (the existing direction tool; `research_moment` first when `STUDIO_DIRECTION_MOMENTS` is on and the intent has an ask), persisted as one `creative_interpretations` version: `proposal = { proposals: BriefProposal[], model, promptVersion, notes, moment }`, `flags` = the proposals' `InferenceFlag`s with their proposal index. Nothing strategic is copied; the intent is the reference. Refusals surface the tool's own reasons (`disabled` when `STUDIO_BRAND_PROFILES` is off).

**Confirmation is load-bearing** (`POST …/confirm { interpretationId, proposalIndex, flags, formatClass? }`): only the current version can be confirmed; it records the chosen proposal and its concept, the flags she accepts, and — when her ask fixed no format or the wrong one — the format class. The verbatim ask is never mutated; the confirmed interpretation is a separate row from the intent. Before confirmation the preview path refuses (409, "Confirm how it should be read first").

## 6. BriefInput adapter

`server/studio/creative/resolve.ts` + the preview route: with `creativeIntentId` in the body, `objective` = the **confirmed proposal's `brief.objective.goal`** (never the ask, never the Commission), `deliverable` = `confirmed_format_class ?? intent.format.class`, `brandId` from the intent, `origin` from the source (`athlete` / `inbound` for a contract-worded campaign intent / `system`), `direction` = her verbatim ask when the body gives none, `intent` (image/video.generate) derived from the deliverable. The body **may not** carry `objective`, `deliverable`, `brandId` or `origin` alongside an intent (400). References and direction still ride the existing carriers (`planId → carrierFromPlan`) — nothing creative invented. Refusals: 404 not hers · 409 withdrawn / unconfirmed / no format · 422 unsupported executor.

## 7. Plan / job lineage

`savePlan` writes `creative_intent_id` (`POST /studio/agent/plan` accepts `creativeIntentId`: flag, UUID, hers, not withdrawn — checked before the planner runs). The preview freezes `creativeIntentId` onto `CreativeBrief.job`; `createGenerationJob` writes `creative_intent_id` from the frozen brief, so the spend leg's replay carries it too. No `studio_plan_id` on jobs — the plan id already rides the brief as `campaign.planId`.

## 8. Derived-state implementation

`deriveIntentState(intent, downstream)` (pure) + `downstreamOf(db, …)` (read): `withdrawn` (overrides everything) → `published` (an asset with `posted_at`) → `cleared` (approved asset) → `produced` (any asset) → `in_production` (a job pending/queued/running) → `confirmed` (a confirmed interpretation or a plan) → `interpreted` (any interpretation) → `open`. Nothing writes to the intent. Test 8 proves the row is byte-identical across the whole chain; the store test replays #656's revision case (rejected asset, regeneration) with no drift.

## 9. Withdrawal semantics

`withdrawnAt` = the intent is no longer active as an instruction. After it: no new interpretation, no confirmation, no brief (preview 409), no plan (plan route 409), and the derived state reads `withdrawn` whatever is downstream. Already-created plans, previews, jobs and assets are **not** deleted or rewritten; an in-flight job keeps Studio's own cancellation semantics. Tested.

## 10. Unsupported executor behaviour

A confirmed format of `written` or `other` — the intent contract admits them because a planner may commission them — is refused at the preview path with **422 `unsupported executor: Studio has no job for a "written" piece`**. Never mapped to a fake Studio format; the written executor is not solved here.

## 11. Tests

- `server/routes/studio.creative.test.ts` (6 tests, HTTP over PGlite, provider mocked): 1 one intent from her ask · 2 idempotent retry · 3 no objective before interpretation · 4 unconfirmed → no brief · 5 confirmation fixes an unset format, ask untouched · 6 `origin: athlete` on the frozen brief · 7 `creative_intent_id` on plan and job · 8 derived state moves, intent row identical · 9 withdrawal blocks preview/plan/interpret, deletes nothing · 10 written → 422 · 11 nothing above the intent · 12 gates unchanged (body override 400, flag off 400, scored-profile 409).
- `creative/store.test.ts` (3) and `creative/forcing.test.ts` (12, the six #656 invariants carried forward).
- Regression: Studio generate/agent, direction, Mila, Brain suites (see the PR).

## 12. Does the direct athlete path work end to end through preview?

**Yes.** Test 7 runs it: `request_creative` → interpret (mocked direction tool) → confirm → `POST /studio/preview { creativeIntentId }` (200, brief frozen with `origin: athlete`, `objective: recap`, the intent id) → `POST /studio/generate` (200, mocked provider) → a `generation_jobs` row with `creative_intent_id` and `origin: athlete` → derived state `in_production`/`produced`. Spend, scored-profile, clearance and publish gates are the same code paths as before.

## 13. Studio contracts that resisted the seam

- **The preview body is objective-first.** `parsePreviewBody` requires `objective`/`deliverable`/`intent`; the adapter had to pre-resolve the intent and inject them before parsing rather than extend the parser. Correct, but it means the route now has two entry shapes.
- **`BriefOrigin` was a two-value enum with a DB CHECK** — widened here; the `inbound` semantics (ask required, untrusted) stayed intact.
- **`proposeCampaign` wants an `objective` string** — her verbatim ask serves as it (the tool interprets), which is exactly the intended order; no adapter needed, but the name is misleading and recorded.
- **The confirm flags on `studio_plans.confirm` are still record-only**; confirmation now lives on `creative_interpretations`. Two places hold "what she confirmed" until the plan route learns to read the interpretation — a follow-up, not a conflict.
- **No Context reader for the moment** — the tool cannot cite today's match; `moment` is null until Context exposes fixtures.

## 14. Exact next step for the Campaign source

1. Apply #570 C1 (contracts + tables `campaigns`, `campaign_specs`, `campaign_deliverables`) with the **origin writer** of #655 §2 (campaign + draft spec v1 at `planning`), recommendation door first (the router's validated `CampaignOriginProposal`), and `execution.refs += campaign:<id>` on the Recommendation when the ledger mounts.
2. Mount `intentsFromCampaignSpec` (already written and forcing-tested) as the adapter run on spec approval: one `creative_intents` row per content unit with `intent_key = campaign:<id>:<deliverable>:<unit>`, `origin: inbound` when the deliverable carries a contract quote.
3. The same interpret → confirm → preview path serves them unchanged; `campaign_deliverable_id` (+ spec id/version) on the job per #570 §6 is the only additional lineage.
4. Deal door and planner Commission source after that, each separately reviewed.

---

## 15. Acceptance (27 September 2026)

Accepted as the first mounted CreativeIntent vertical slice; architecturally accepted with everything in §1–§10 preserved; `STUDIO_CREATIVE_INTENTS` stays off and rollout is not widened. Follow-ups recorded, not solved: (1) `studio_plans.confirm` duplicates confirmation that now lives on `creative_interpretations`; (2) no server-side Context reader supplies the athlete moment; (3) `proposeCampaign` serves Creative Intelligence interpretation despite its name; (4) written/other creative work has no executor. Next: the Campaign source — `campaign-source.md`.
