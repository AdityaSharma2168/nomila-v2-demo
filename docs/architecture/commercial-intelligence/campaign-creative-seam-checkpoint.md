# Campaign → CampaignSpec → Creative Intelligence → Studio — seam checkpoint

**Status:** design/evidence checkpoint for review · branch `docs/campaign-creative-seam`, stacked on #654 · **no code, no provider calls**
**Controls:** the canonical architecture; **#570 as amended** (Amendment 1 applied on its branch, commit `94579d0f`); `execution-router/0.2.0-exp` (`CampaignOriginProposal`); `Commission` (`planner/creativeBoundary.ts`); the direct door mapping from #649 Case 5.
**Method:** a read-only audit of the Studio code as it is today (§15), then every contract below written from what the consumer needs and checked against what already exists — nothing is renamed, and nothing Studio already has is duplicated.
**Not done, by rule:** no Campaign execution, no Creative Intelligence implementation, no Studio change, no content-planner productionisation, no Deals, Rate, Objective, Opportunity or Brain change, no generic Plan or Action abstraction.

---

## 1. Applied #570 amendment

Applied on `docs/campaign-slice-design` (commit `94579d0f`), exactly the three corrections recorded in `campaign-slice-design-amendment-1.md`, eight text sites, no other redesign:

1. `CampaignOrigin.period` is `{ startsOn, endsOn, endsWith: deal_term | objective_horizon | athlete_stated, endsRef }` — a resolved fact with its source, never recovered from prose; invariant 2 now refuses an origin without a resolvable `endsRef`; A6's Brain-authored condition is not admitted.
2. `deliverables` optional at origin (empty for the athlete and recommendation doors; they enter at `planning` through the CampaignSpec).
3. Three-act approval at the doors table, row A3 and the `idea`/`approved` note: Recommendation acceptance · CampaignSpec approval (`planning → approved`) · per-action execution authorization; the "Still open" note resolved.

Amended #570 is the Campaign control from here. One consequence for #570 recorded below and **not** applied: §5's `BriefSeed` is subsumed by the single creative-intent contract (§4) — a proposed Amendment 2 for the Campaign checkpoint.

## 2. Campaign origin contract — the minimum writer

`createCampaignFromOrigin(db, origin: CampaignOrigin, actor)` — one function, consumer-owned, taking the router's validated `CampaignOriginProposal` (recommendation door) or a deal/athlete origin, and writing **one `campaigns` row and one `campaign_specs` row (version 1, `approval: "draft"`)**.

| Field | From | Rule |
|---|---|---|
| identity | `campaigns.id` (uuid) | minted here; stable for the life of the activation; every downstream object points at it, never at a spec |
| lineage | `origin.door`, `recommendationIds: [proposal.recommendationId]`, `dealIds`, `objectiveIds`, `athleteId` | copied as references only; the Recommendation, deal and Objective stay where they are |
| purpose | `proposal.purpose` (= the Brain's `what`) | the origin's sentence, never rewritten by Nomila (#570 §7) |
| brand / deal refs | `brandIds`, `dealIds` | empty on the recommendation door unless the subject named them (#649: they were empty, honestly) |
| end | `period { endsWith, endsRef, endsOn, startsOn }` | already resolved by the router (`resolveEnd`); the writer **re-resolves nothing and reads no prose**; refuses if `endsRef` is absent |
| initial lifecycle | recommendation door: **`planning`** — the router only hands off a Recommendation that is accepted *and* prepare-authorized, so both acts of Amendment 3 are already done; deal door: `planning`; athlete door: `planning` | `idea` has **no writer from the router**: the Recommendation record itself is the "idea" (an accepted-but-unauthorized campaign move is a Recommendation, not a campaign). `idea` stays in the enum for a future affordance that shows a proposed campaign before acceptance; recorded as a contradiction to resolve at the Campaign checkpoint |
| scope state | `currentSpecVersion: 1`, spec v1 `{ purpose, deliverables: origin.deliverables (empty on the recommendation door), period, constraints, approval: "draft", provenance { origin, supersedes: null, createdBy } }` | Amendment 2: an empty draft scope is valid; `approved` needs a spec version with content the athlete approves |
| constraints | `proposal.constraints` (`notSeen`, `source: "recommendation"`); deal door: contract terms verbatim | never normalised |
| evidence | `proposal.evidence` (`{ref, how}`) | by reference; the run artifact holds the rest |

Excluded on purpose: any creative deliverable not known at origin, any Studio field (objective, format beyond a contractual one, references, shot), any rank or plan. The writer emits no event outside the campaign; the Recommendation's `execution.refs += campaign:<id>` is the caller's act on the ledger (as with `outreach_plan`), so the router's dedup and the Brain's Existing Work view see it.

## 3. Campaign vs CampaignSpec — distinct, and necessary

Tested against the five pressures; every one needs the split:

| Pressure | Without a spec | With `Campaign` + versioned `CampaignSpec` |
|---|---|---|
| scope revision | mutate the campaign → the approved scope is lost | new version, `supersedes`, old version immutable |
| added/removed deliverables | same loss | a version change; `campaign_deliverables` rows carry `specVersion` |
| athlete approval | approval of what? the whole mutable row | `approval` attaches to a version: she approves *this* scope |
| multiple creative waves | one blob | wave = either several deliverables in one version or successive versions; the campaign's purpose and end do not move |
| stable identity while execution changes | id survives only by convention | `campaigns.id` is the lineage anchor; specs and deliverables hang off it |

Decision: **keep both, exactly as #570 §4.2/§4.3**, with Amendment 2's empty draft v1. No third object. `CampaignSpec` stays minimal (purpose, deliverables, period, constraints, approval, provenance, two context refs) and carries **no creative content** — that is the next layer's.

## 4. BriefSeed vs Commission — one canonical creative-intent contract

The question: can one contract serve planner-originated, campaign-originated and athlete-originated creative work?

| | Planner `Commission` | #570 `BriefSeed` | Direct athlete ask |
|---|---|---|---|
| what it says | purpose, audienceRole, channelOrFormatClass, timing, constraints, why | athleteId, brandId, origin, ask?, deliverable (contract format), mode, lineage {campaign, spec, deliverable} | her words verbatim (+ the moment) |
| what fixes the format | nothing (a class at most) | the contract line ("2 Instagram Reels") | her words ("a post") |
| lineage | outreachPlanId, recommendationId | campaignId, specVersion, campaignDeliverableId | none |
| has an objective? | no | deliberately no | sometimes, in her words |

They are the same semantic — *creative work requested, with why and constraints, before conception* — differing only in **which optional slots are filled and what fixed them**. Campaign needs no field the others lack; it needs lineage slots and a "format fixed by contract" marker, both optional. **Decision: B — one canonical `CreativeIntent`.** `Commission` is retained unchanged as the planner's *authoring shape* (it is `CreativeIntent` with `source.kind = "planner"` and no lineage beyond the plan); `BriefSeed` is retired as an object — #570 §5's adapter becomes `CampaignSpec → CreativeIntent[]` (one per content deliverable per unit of quantity, as today), and BriefSeed's real idea — "a partial `BriefInput` Studio opens pre-filled" — survives as the **last adapter** `CreativeIntent → BriefInput` (§8), not as a stored object. No two objects mean "creative work requested".

## 5. Canonical creative-intent contract

```ts
interface CreativeIntent {
  id: string; athleteId: string;
  source: { kind: "planner" | "campaign" | "athlete"; ref: string };      // outreach_plan[<id>] | campaign[<id>] | athlete
  purpose: string;                       // planner: Commission.purpose · campaign: the deliverable's intent line · athlete: her ask, verbatim
  why: string | null;                    // planner: Commission.why · campaign: the spec's purpose · athlete: null
  audienceRole: string | null;
  brandId: number | null;                // campaign/deal only; never inferred
  format: { class: BriefDeliverable | "written" | "other" | null; quantity: number | null; dueOn: string | null; fixedBy: "contract" | "planner" | "athlete" | null };
  channel: string | null; timing: string | null;
  constraints: Array<{ text: string; source: "contract" | "athlete" | "recommendation" | "planner" }>;
  ask: { verbatim: string; moment: { asOf: string; ref: string } | null } | null;   // athlete door only; the moment by reference (Context)
  lineage: { recommendationId?: string; outreachPlanId?: string; campaignId?: string; specVersion?: number; campaignDeliverableId?: string; dealDeliverableId?: string };
  status: "open" | "interpreted" | "confirmed" | "in_production" | "fulfilled" | "withdrawn";
  createdAt: string;
}
```

What it has no field for, structurally (the `Commission` rule, kept): concept, hook, angle, caption, treatment, tone execution, shot, edit, references, look, music. Where those live is §7.

## 6. Creative Intelligence — responsibility boundary

**Given a `CreativeIntent` plus the athlete's record, the moment (Context) and the campaign's constraints, determine the creative solution.**

It decides: concept and narrative angle; creative direction (tone, style, energy — the existing `creative_direction`); the **asset mix within one intent** (one reel plus stills for one purpose is its call; *how many intents exist* is the planner's or the spec's); format-specific interpretation inside a fixed format; references from her library; hooks, lines, copy direction; visual treatment; shot and edit requirements.

It does not decide: the Objective; whether the Campaign exists or ends; commercial terms; campaign lifecycle or scope (which deliverables, how many, by when — the spec's); a contractual format (fixed; it interprets within it); athlete authorization of anything; and it does not override Studio's gates (likeness/identity pack, spend caps, clearance, publish) — it proposes references and assets, the gates decide.

Pressure points found: (i) *asset mix* sits on the line — resolved above by "within one intent"; (ii) *the moment* — `research_moment` already exists as a direction tool; CI reads it, it does not create Context; (iii) *copy for a caption* is CI's direction, but the caption **as published** passes Studio's publish gate as content, not as CI's authority.

## 7. First Creative Intelligence output — and the objects that already exist

The audit settles this. Studio already has a creative interpretation with provenance: **`BriefProposal` = `{ brief: CampaignBrief, flags: InferenceFlag[], sourceTool, extras { concept {angle, feeling, line}, constraints, notes, moment } }`** (`studio/direction/envelope.ts:103`), produced by the direction tools (`propose_campaign`, `research_moment`, `decompose_reference`, …), and every inferred leaf is flagged `literal | inferred` with a quote or a reason.

- **First CI output = `BriefProposal`, unchanged in shape, attached to a `CreativeIntent` by id.** Rename nothing. Add one lineage field (`intentId`) when it is persisted.
- **`BriefProposal` is the right concept.** It is already "an interpretation the athlete confirms, with what was inferred marked".
- **Confirmation is of the interpretation *including* the chosen concept**, and it happens **before** asset planning: today concept (`A|B|C`) and the confirmed flags arrive together on `POST /studio/agent/plan` and are stored on `studio_plans.concept` / `.confirm` (the confirm is record-only, "consumed by nothing"). So the order is: intent → proposal (concepts) → **athlete confirms concept + flags** → plan.
- **What becomes `AssetSpec`: nothing new.** `PlanItem` (`agent/types.ts:273`: kind `i2v|broll|image|product|clip`, beat, direction, ref, sound, segment, window, motion, focus, capabilities, reason) inside `studio_plans.plan.items` **is** the asset-level spec. `AssetSpec` does not exist in code and is not needed.
- **`ShotSpec` exists** (`studio/types.ts:213`: framing, movement, lighting, environment, composition, motion; closed sets) and is derived per item from capabilities (`toShotSpec`) and normalised at preview. **Necessary at preview/generation time only.** `EditSpec` does not exist; edit intent is `FrozenEditIntent` / `StudioEditOp` and is only needed in `edit` mode. Neither is a CI output object; both are Studio's compile-time reading of the plan.
- **`studio_plans` sits as CI's persisted output for the content channel**: interpretation (`brief`, `concept`, `confirm`) + asset mix (`plan.items`, `look`, `music`), versioned by `parent_plan_id`. It needs one additive column, `creative_intent_id` (§16). It is **not** a generic plan: nothing outside Studio reads it, and the outreach record deliberately does not reuse it.

## 8. Relationship to the existing `BriefInput`

`BriefInput` (`studio/brief.ts:292`) is Studio's **job order**: athleteId, brandId?, origin `system|inbound`, objective (mandatory, creative), deliverable, mode, source/ask/lastFrame, shot?, direction?, references?, campaign? (the `JobCampaign` carrier). It is assembled at `POST /studio/preview`, frozen into the preview and the job, and read by generation. It is **reusable as-is** as the final step. The adapter `CreativeIntent + confirmed BriefProposal/plan → BriefInput` is the old BriefSeed idea done at the right moment: `objective` from the confirmed interpretation (never from the intent or the contract — #570's rule stands), `deliverable` from `format.class`, `brandId` from the intent, `origin: "system"` for planner/campaign, references and direction from the plan via the existing `carrierFromPlan`. One enum gap, recorded and not fixed: `BriefOrigin` has no `athlete` value; her own ask is today `system` (not `inbound`, which means untrusted brand text).

## 9. Relationship to `studio_plans`

`studio_plans` = the persisted **interpretation + asset mix** for one creative intent in the content channel (§7). One intent → one plan lineage (regenerations chain by `parent_plan_id`, version increments). A campaign with several content deliverables → several intents → several plans, which may share a **campaign-level interpretation** (§14 B). Additive need: `creative_intent_id`. Nothing else changes.

## 10. `AssetSpec` role

None as a new object. The role is filled by `PlanItem`. Recording this closes the canonical diagram's `AssetSpec` box onto an existing type; #570 §4.3 already declined to introduce `AssetSpec` ("Departure: v1 uses DeliverableIntent … and does not introduce AssetSpec"), and the audit confirms nothing needs it.

## 11. `ShotSpec` / `EditSpec` role

`ShotSpec`: an existing Studio compile-time reading of a plan item, normalised at preview, needed only when a job is priced and run. `EditSpec`: does not exist; `edit` mode carries `FrozenEditIntent` + `StudioEditOp` params. Neither crosses the seam from Creative Intelligence as a contract; both are below the brief. The canonical `ShotSpec/EditSpec → ExecutionPlan` step maps to `GenerationPlan` / `AgentPlan` (existing), not to a new object.

## 12. Approval / confirmation sequence

Only the stages that exist and are distinct:

| Stage | Exists as | Distinct because |
|---|---|---|
| (0) intent exists | planner scope review (`outreach_plans.reviewed`), CampaignSpec approval, or her own ask | **not a creative gate** — it is the upstream act that made the intent legitimate |
| (1) interpretation confirmed | concept chosen + `confirm` flags on `POST /studio/agent/plan` (`studio_plans.concept/.confirm`) | she accepts what was inferred before anything is planned |
| (2) spend approved | priced preview consumed once (`studio_generation_previews.consumed_at`), caps (`spendCaps.ts`) | money |
| (3) asset cleared | `media_assets.approval_status draft→approved` (`studio/approval.ts`) | the produced thing, not the plan |
| (4) publish authorized | `resolvePostableAsset` requires `approved` + `mode: live` + `STUDIO_PUBLISH_MODE=live` | outward |

No stage is invented. **Recommendation acceptance authorizes none of these**: nothing in Studio reads a Recommendation, and the only path from a Recommendation to Studio passes through a planner's `reviewed` scope or a CampaignSpec's `approved` version, then stages 1–4 in Studio's own hands.

## 13. Direct athlete creative path

"Make a post about today's win." → **a `CreativeIntent` with `source.kind = "athlete"`**: `purpose` = her words, `ask.verbatim` = her words, `ask.moment` = today's match by Context reference when one exists, `format.class = "post"` because she said post (`fixedBy: "athlete"`), `brandId: null`, no lineage, `why: null`. That is the minimum object, and it exists **before** Studio so that lineage and later attribution hold. Not a `BriefInput` directly (it demands an objective she has not chosen), not a Commission (no planner), not a BriefSeed (no campaign). Then Creative Intelligence: `research_moment` + `propose_campaign` → `BriefProposal` → she confirms → plan → the adapter emits `BriefInput { origin: "system", objective: <from the confirmed interpretation, e.g. recap>, deliverable: "post" }` → Studio's stages 2–4. **No Campaign is manufactured**; the asset may be attached to a campaign later (#570 §3 freeform attach). Which capability creates the intent today: none — no Mila tool creates briefs (#649 Case 5); the door is the missing piece, not the object.

## 14. Campaign creative path — three shapes

**A. One-asset campaign** (a contractual hero video, or an activation whose whole execution is one piece). Campaign + spec v1 with one `content` deliverable → one `CreativeIntent` (`fixedBy: "contract"`, `dueOn`) → one `BriefProposal` → one plan → one job → one asset → clearance → publish. Still a Campaign: purpose, end (`deal_term`), aggregate outcome (fulfilled 1 of 1) come from the activation, not from the asset.

**B. Multi-asset campaign** (n deliverables, or waves). Spec v1 with n `content` deliverables → n intents. Creative Intelligence may produce **one campaign-level interpretation** (a `BriefProposal` whose `CampaignBrief.creative_direction` and concept are shared) that each intent's plan cites, so the look holds across pieces; per-intent interpretation stays possible. Waves = successive spec versions (v2 adds deliverables; earlier intents keep their version). Minimum representation: `BriefProposal` persisted with `scope: "campaign" | "intent"` and `intentId | campaignId` — a small addition when it is persisted; today it lives only inside `studio_plans.brief`.

**C. Campaign with non-creative work** (outreach/event/coordination + creative deliverables). The spec's `DeliverableIntent` category axis already separates `content` from the rest (#570 §5: "every other category stays an obligation to track and is never briefed"). Only `content` deliverables become `CreativeIntent`s; appearance/coordination/outreach obligations stay `campaign_deliverables` with a status. **Creative Intelligence receives only the creative intents, never the campaign's execution problem.** Gap recorded: a Campaign's non-creative work has no planner entry (the outreach planner takes a `PlannerHandoff` from a Recommendation, not a campaign obligation); for v1 that work is tracked, not planned, which is #570's position. Not needed for the seam.

## 15. Existing Studio contract audit

| Contract | Where | Classification | Why |
|---|---|---|---|
| `BriefInput` / `CreativeBrief` | `studio/brief.ts` | **reusable as-is** | the job order; the adapter targets it; `objective` mandatory and creative, as it should be |
| `BriefOrigin` enum `system\|inbound` | `brief.ts:62` | **needs adaptation** (later) | no `athlete` value for her own ask |
| `CampaignBrief` (`campaign-brief/1`) | `studio/campaign/brief.ts` | **reusable as-is** | the interpretation's body; explicitly carries no campaign id — right, lineage is the intent's |
| `BriefProposal` + `InferenceFlag` | `studio/direction/envelope.ts` | **reusable as-is** | the first CI output; add `intentId` when persisted |
| direction tools (`propose_campaign`, `research_moment`, `decompose_reference`, `summarize_brief`, `echo`) | `studio/direction/*` | **reusable as-is** | they *are* Creative Intelligence's first capabilities; behind `brandProfilesEnabled()` |
| `studio_plans` (+ `PlanItem`, `PlanLook`, `PlanMusic`, `concept`, `confirm`) | `schema.ts:2180`, `agent/types.ts` | **needs adaptation** | one additive column `creative_intent_id`; `confirm` becomes a read stage (today record-only) |
| `carrierFromPlan` → `JobCampaign` | `studio/campaign/carrier.ts` | **reusable as-is** | how the plan's interpretation reaches the prompt |
| `studio_generation_previews` (priced, single-consume) | `schema.ts:1805` | **reusable as-is** | stage 2; the spend gate |
| `generation_jobs` | `schema.ts:1675` | **needs adaptation** | additive lineage: `creative_intent_id` (+ #570 §6's `source_spec_id/version`, `campaign_deliverable_id`); no FK to `studio_plans` exists today |
| `media_assets` (generated, `approval_status`, `deal_deliverable_id` unwritten) | `schema.ts:1454` | **reusable as-is** | clearance state machine correct; `deal_deliverable_id` writer arrives with the campaign deliverable link |
| `studio_publish_jobs` + `resolvePostableAsset` | `schema.ts:2038`, `publish/eligibility.ts` | **reusable as-is** | stage 4 |
| spend caps, `hasBeenScored`, `nativeRecheck`, likeness gate, identity pack gate | `spendCaps.ts`, `routes/studio.ts`, `referenceGate.ts`, `identity/packGate.ts` | **separate execution concern** | Studio's gates; CI proposes, they decide |
| reference selection (`library.ts`, `cast.ts`, `refOrder.ts`, `studio_reference_analyses`) | `studio/agent/*`, `studio/reference/*` | **reusable as-is** | "never generate from scratch" is a degraded gap, not a block — correct for CI to inherit |
| identity: band measurement, masked compositing, SAM-3 | `studio/identity/*`, `composite.ts`, `segment.ts` | **separate execution concern** | no LoRA/VTO in v2 (none exists); CI never touches it |
| model/provider routing | `studio/config.ts` | **separate execution concern** | below the brief |
| `ShotSpec` | `studio/types.ts:213` | **reusable as-is**, compile-time | §11 |
| `AssetSpec`, `EditSpec`, `ExecutionPlan`, `campaigns` table, `BriefSeed` | — | **do not exist** | §10, §11, §2, §4 |
| `deal_deliverables` (read-only in Studio; zero writer) | `schema.ts:384`, `studio/dealDeliverables.ts` | **needs a writer** (Campaign checkpoint, deal door) | unchanged here |
| client `storyboard`, media-kit `shotList` | client, `services/shotList.ts` | **obsolete for this seam** | not Studio's generation path |

## 16. Lineage chain and the minimum ids

```
source ─────────────────────────┐
  outreach_plans.id (planner)   │
  campaigns.id + spec version   ├─→ creative_intents.id ─→ studio_plans.id ─→ studio_generation_previews.id ─→ generation_jobs.id ─→ media_assets.id ─→ studio_publish_jobs / content_posts
  + campaign_deliverable_id     │        (new, narrow)      (+creative_intent_id)   (consumed_by_job_id ✓)        (+creative_intent_id)   (generation_job_id ✓)   (asset_id ✓, ig_media_id/permalink ✓)
  athlete ask (verbatim)        │
recommendation_id ──────────────┘ (on the intent's lineage, by reference — never copied downstream)
```

Minimum additive ids: (a) a `creative_intents` record (§5) — the only new table this seam needs; (b) `studio_plans.creative_intent_id`; (c) `generation_jobs.creative_intent_id` — because today **no FK joins a job to its plan** (the plan reaches the job only as the jsonb `JobCampaign` carrier), so the intent id on the job is the join that closes the chain; (d) #570 §6's three job columns for the campaign deliverable. Everything upstream of the intent (Recommendation, Objective, Campaign purpose, evidence) is reached by reference from the intent's `lineage`; nothing strategic is copied into plans, previews, jobs or assets.

## 17. Minimum Measure/Learn-compatible provenance

Not built; only the ids that later attribution needs, all present once §16 lands: **which Recommendation / Campaign / Commission led to which asset** = `media_assets.generation_job_id → generation_jobs.creative_intent_id → creative_intents.lineage {recommendationId | campaignId+specVersion+campaignDeliverableId | outreachPlanId}`; **what was published** = `studio_publish_jobs.asset_id → ig_media_id / permalink`, `media_assets.posted_at`; **what outcome** = the existing content-performance read keyed by permalink/asset. One gap for later: outcomes of *non-creative* campaign work (appearances) have no asset and attach to `campaign_deliverables.status` only.

## 18. Forcing cases (design; offline; no provider until the contracts are frozen)

1. **Planner Commission → creative work.** Take #652 Case A's commission ("Yuwa partnership pitch deck", `commissions: content`) as a `Commission`; map to a `CreativeIntent` (source planner, lineage `outreachPlanId`, `format.class: "written"`, `fixedBy: "planner"`); assert nothing conceptual crosses; hand-write the expected `BriefProposal` shape and the `BriefInput` the adapter would emit. Pass: intent carries purpose/why/audience/constraints only; objective absent until interpretation.
2. **Direct athlete request → creative work.** "Make a post about today's win" → intent (§13) → the recorded #649 Case 5 `BriefInput` reproduced by the adapter from a *confirmed* interpretation, not from the ask. Pass: no Campaign, no Recommendation, `brandId null`, objective chosen at confirmation.
3. **Single-asset Campaign.** A deal-door `CampaignOrigin` with one content deliverable (`fixedBy: "contract"`, `dueOn`) → writer creates campaign + spec v1 → adapter emits exactly one intent → the chain to one asset with `campaign_deliverable_id` on the job. Pass: `fulfilled 1 of 1` derivable from the asset.
4. **Multi-asset Campaign.** Spec v1 with three content deliverables → three intents; one campaign-scoped `BriefProposal`; spec v2 adds one → one more intent; earlier intents keep `specVersion: 1`. Pass: campaign id stable; waves are versions.
5. **Mixed campaign.** Spec with two content deliverables and one appearance → two intents; the appearance is a `campaign_deliverable` with status only; Creative Intelligence sees two, not three. Pass: no non-creative work reaches the seam.
6. **Creative revision after athlete feedback.** She rejects the interpretation (or the asset): a new `BriefProposal` for the same intent (status back to `interpreted`) / a regenerated plan (`parent_plan_id`, version 2) / a rejected asset (`rejected → draft` reopen) — each at its own stage, none reopening the intent's lineage or the campaign's scope. Pass: the intent id is constant across revisions; the spec version does not change.

Fixtures for all six can be built from the recorded #649/#652 artifacts and #570's gorjana example; none needs a provider.

## 19. What to implement first after this checkpoint

**The `CreativeIntent` record with the two lineage columns and the `CreativeIntent → BriefInput` adapter** — the spine of §16, serving all three sources, and the smallest real door (the athlete's) needs nothing else. Then, in parallel and separately reviewed: the **Campaign origin writer + spec v1** (#570's C1, now unblocked by Amendment 1), which is the second source. Creative Intelligence itself needs no new engine to start: the direction tools already produce `BriefProposal`; the first "implementation" is wiring intent → proposal → confirmation as a read stage. Not first: the content planner (waits for this seam to be exercised), the deal-door `deal_deliverables` writer, any AssetSpec.

**#570 follow-ups recorded for the Campaign checkpoint, not applied:** Amendment 2 — retire `BriefSeed` in favour of `CreativeIntent` (§5 adapter becomes `CampaignSpec → CreativeIntent[]`); resolve the `idea` state's writer (§2).

---

## 20. Acceptance (27 September 2026)

Accepted by the user as the Campaign → Creative Intelligence seam checkpoint, with the major decisions confirmed: Campaign and CampaignSpec distinct; one canonical `CreativeIntent` for planner, campaign and athlete sources; `Commission` an authoring shape; `BriefSeed` retired; `BriefProposal` the first CI output; no `AssetSpec`; `PlanItem` as the asset-level spec; `ShotSpec` compile-time; no `EditSpec`; CI on existing direction capabilities; lineage through `creative_intent_id`. Before mounting: #570 Amendment 2 (applied, `495a6cc2`) and the six offline forcing cases — `docs/audits/creative-intent-forcing.md`.
