# Campaign source into CreativeIntent — #570 C1, origin writer, approval, materialisation (mounted, unrouted)

**Status:** for review · branch `feat/campaign-source`, stacked on #657 · **0 provider calls**
**What is mounted:** the #570 tables as amended, the recommendation-door origin writer, versioned specs with approval, `CampaignSpec → CreativeIntent[]` on approval, the #570 §6 job lineage, a derived fulfilment reading, and the Existing Work projection. **No route, no caller, no flag reads it**: the writer is called by tests only; the router → writer wiring is the harness's and the ledger's (§3).
**Not in this PR, by rule:** no planner Commission source, no content planner, no deal door, no written executor, no Context reader, no confirmation clean-up, no Objective/Opportunity/Brain redesign, no Rate.

---

## 1. Campaign schema delta

`migrations/0073_campaigns.sql` (in the deploy list; Drizzle mirrors it):

- **`campaigns`** — `origin_door (recommendation|deal|athlete|observed)`, `purpose` (never rewritten), `recommendation_ids / objective_ids / deal_ids / brand_ids / participant_athlete_ids` (references), `period` jsonb `{startsOn, endsOn, endsWith, endsRef}` (the RESOLVED end, Amendment 1), `evidence`, `status (idea|planning|approved|active|ended)`, `ended_because`, `current_spec_version`, timestamps.
- **`campaign_specs`** — `campaign_id, version` (unique), `purpose`, `deliverable_ids` jsonb, `period`, `constraints`, `approval (draft|athlete|brand|contractual)`, `provenance`, `supersedes`, `approved_at/by`. Immutable: the only update a row ever receives is its approval.
- **`campaign_deliverables`** — `introduced_version`, `superseded_version`, `seq`, `intent` jsonb (#570 `DeliverableIntent`), `status (open|fulfilled|waived|cancelled)`, `deal_deliverable_id`, `superseded_at`. **Identity spans versions** (§13).
- **`generation_jobs`** — `source_spec_id`, `source_spec_version`, `campaign_deliverable_id` (nullable; audit/fulfilment only). `creative_intent_id` preserved.
- Not added: `deal_deliverables.campaign_id` (deal door), any campaign text on jobs.

## 2. Origin writer

`createCampaignFromOrigin(db, athleteId, proposal)` (`campaign/store.ts`) takes the router's validated `CampaignOriginProposal` and writes **one campaign at `planning`** and **one draft spec v1** carrying the origin's deliverables — none from a Recommendation, so none are invented. Refuses: a missing/empty `period.endsRef` or `endsWith` (#570 invariant 2), an empty purpose, a missing Recommendation id, any door but `recommendation` ("no writer in this slice"). The `idea` state has no writer here: the Recommendation record is the pre-campaign idea/governance object (recorded, §13).

## 3. Lifecycle and Recommendation lineage

`planning` (writer) → `approved` (first spec approval) → `active`/`ended` (not transitioned in this slice: `active` is "first deliverable enters work or startsOn passes", `ended` needs the end reading — both later). The campaign stores `recommendationIds: [id]` by reference. **The Recommendation ledger is not mounted on this production path** (it is the harness's file ledger), so the `execution.refs += campaign:<id>` write is **isolated**: `executionRefFor(campaign)` returns `{kind: "campaign", id}` for the caller that owns the ledger; no Recommendation state is copied onto the campaign. Router dedup semantics are untouched: once the ledger records the ref, the existing dedup on execution refs and on `for.recommendationId` (§10) applies.

## 4. CampaignSpec approval flow

`proposeSpecVersion(db, athleteId, campaignId, { keep, add, purpose?, constraints?, createdBy })` writes a new **draft** version: `keep` names existing deliverables carried into scope (identity preserved), `add` creates new deliverable rows introduced in this version; the previous version's row is untouched; `supersedes` set. `approveSpec(…, version, actor)`: only the latest version can be approved (an older draft is refused; an already-approved version returns `alreadyApproved` with no write); sets `approval: "athlete"`, `approved_at/by`; campaign `planning → approved`, `current_spec_version = version`; deliverables not in the new scope are marked `superseded_version/at` (status untouched, nothing deleted). **Approval is the trigger for creative materialisation and authorizes nothing else** (§11).

## 5. CampaignDeliverable model

A tracked obligation with an identity that spans spec versions: introduced in one version, optionally superseded by a later one, `seq` monotonic per campaign. `intent` is #570's `DeliverableIntent` (category axis `content | ugc | access | partnership | licence | other`, `contentFormat` only for content, `sourceQuote` verbatim, `quantity`, `dueOn`, `optional`, `brandId?`, `dealDeliverableId?`). Only `content` ever reaches creative intelligence; the rest is tracked with a status and never briefed (test 7: the appearance's words reach no intent).

## 6. CreativeIntent materialisation

`materializeCreativeIntents(db, athleteId, campaignId, version)` (`campaign/materialize.ts`) refuses a draft, then runs the **unchanged, forcing-tested `intentsFromCampaignSpec`** over the deliverables in scope and inserts each new intent with key `campaign:<campaignId>:<deliverableId>:<unit>`. Each campaign intent carries: `source.kind = campaign`, `lineage {campaignId, specVersion, campaignDeliverableId, dealDeliverableId?, unit}`, `brandId` only from the deliverable or a single-brand campaign, `format {class: contentFormat, quantity: 1, dueOn, fixedBy: "contract"}`, the spec's constraints, `purpose` = the deliverable's `sourceQuote` (else its words in the spec), `why` = the spec's purpose (one sentence — the only strategic text copied). No spec body, no period, no lifecycle on the intent (asserted).

## 7. Spec-version idempotency

Test 5/6/9: v2 approved with three content deliverables (one with quantity 2) → four intents (units 1,1,1,2). v3 keeps two, drops one, adds one → **exactly one** new intent (`specVersion 3`); the four earlier intents are byte-identical in lineage and keep `specVersion 2`; the dropped deliverable is `superseded_version: 3`, status still `open`, row kept; its intent — unproduced — is **withdrawn** (not deleted; an intent already in production would be left to Studio's own semantics). Re-approving an approved version and re-materialising create nothing (test 11).

## 8. Campaign job lineage

`BriefInput.campaignLineage {specId, specVersion, campaignDeliverableId}` is set by the preview route from the resolved intent (`resolve.ts` looks the spec id up by `(campaignId, specVersion)`), frozen onto `CreativeBrief.job`, and written by `createGenerationJob` into `source_spec_id / source_spec_version / campaign_deliverable_id` alongside `creative_intent_id`. No campaign purpose or Objective text reaches the job (asserted: the brief does not contain the campaign's purpose).

## 9. Fulfilment derivation — counts, no criterion invented

`deliverableProgress(db, athleteId, deliverable, intents)` walks the deliverable's intents by unit to Studio's records and reports, per unit, the derived state and, per **candidate** criterion, how many units meet it: `generated` (an asset), `cleared` (approved), `published` (posted). Test 8: quantity 2, one unit with an approved asset → `{of: 2, under: {generated: 1, cleared: 1, published: 0}}`, status still `open`. **The gap, recorded:** amended #570 fixes the deal door's criterion (read through from `deal_deliverables.status`) and says other doors' status is "owned here" — but names no completion criterion for a recommendation- or athlete-door content deliverable. So nothing writes `fulfilled`; `criterionGap: true` is on every reading. The Campaign checkpoint decides it.

## 10. Existing Work projection

`campaignWorkItem(view)` → one item under `campaign[<id>]` (an existing subject kind), `kind: activation`, statement `Campaign "<purpose>" · <status> · scope v<n> (<approval>): k content deliverable(s), m other obligation(s) · creative work underway: <n of m intent(s) | no> · ends with <endsWith> (<endsRef>).`, `termStart/termEnd` from the period, `deliverablesRecorded` = intents cleared/published, `for {recommendationId, objectiveIds}`. Ended campaigns are omitted. By reference throughout; nothing joins Athlete State. The Brain reads `· executing recommendation[<id>]`; the router deduplicates on `for`. The read that assembles `CampaignView`s for `existingWorkFrom(…, planned)` is the caller's (the harness's `brainRun` today), like the outreach projection.

## 11. Approval boundaries

Three acts, preserved and tested: (1) Recommendation acceptance + preparation authorization happen before the router hands off — the writer never sees an unaccepted move; (2) `approveSpec` is the athlete's approval of scope and **creates only intents** — test 10 asserts zero previews, jobs and assets after approval and materialisation, and the intent's derived state is `open`; (3) spend (priced preview consumed), clearance and publication remain Studio's gates on the unchanged path (test 8 of the route file runs them). Non-creative obligations get no execution path here at all.

## 12. Test results

- `campaign/campaign.test.ts` (7, PGlite): 1 writer creates campaign + draft only · 2 no end / no purpose / other door refused · 3 draft → zero intents · 4 one-asset → one intent · 5 multi-asset count · 6/9 v2 only new intents, history kept, dropped superseded · 7 mixed excludes non-content · 8 fulfilment counts, no `fulfilled` written · 10 approval touches nothing in Studio · 11 idempotent re-approval · 12 Existing Work projection.
- `routes/studio.campaign.test.ts` (1, HTTP, provider mocked): a campaign intent runs interpret → confirm → preview → generate on the **unchanged** path; the frozen brief is `inbound` with the contract's words as the untrusted ask; the job carries `creative_intent_id`, `source_spec_id`, `source_spec_version`, `campaign_deliverable_id`; the campaign's purpose is nowhere on the brief.
- Regression: creative slice (6), Studio generate/agent, creative, Brain, planner, outreach suites — all green.

## 13. Contradictions in #570 exposed by implementation

1. **Deliverable identity must span versions.** #570 §4.4 shapes `CampaignDeliverable` with `specVersion; seq` — one row per version — which would mint new deliverable ids on every revision and break the forcing-tested intent key. Implemented as `introduced_version / superseded_version` on one row; `campaign_specs.deliverable_ids` names the scope. Propose as Amendment 3.
2. **No completion criterion for non-deal content deliverables** (§9). Amendment 3 candidate: name it per door, or make it a `DeliverableIntent` field (`completesWhen: generated | cleared | published`).
3. **`idea` has no writer from the router** (already recorded; unchanged).
4. **Dropped scope and in-flight work**: #570 says a scope change is a new version and nothing about the fate of work under the dropped scope. Implemented narrowly: unproduced intents withdrawn, anything in production left to Studio; needs a sentence in #570.

## 14. Does the Campaign source work end to end through Studio?

**Yes.** The route test creates a campaign from a recommendation-door origin, proposes and approves a scope with one contract-worded clip, materialises one intent, and runs it through interpretation (mocked direction tool), confirmation, a real preview (200; brief `origin: inbound`, `objective: announce`, `deliverable: clip`, the intent id and the campaign lineage frozen) and a real generate (200, mocked provider) to a job row with all four lineage columns, derived state `in_production`/`produced`, intent untouched. No campaign-specific branch anywhere in Studio.

## 15. Exact next step after the Campaign source

1. **Mount the router → writer wiring on the harness** (`brainRoute.ts` gains `--campaign-writer` against a dev athlete) and record `execution.refs += campaign:<id>` on the file ledger — closing §3's isolated write experimentally before any production ledger exists.
2. **Campaign read for Existing Work** in `brainRun.ts` (assemble `CampaignView`s → `campaignWorkItems` → `existingWorkFrom(…, planned)`), so a later Brain run on the dev athlete sees the campaign — the last untested half of §10.
3. **#570 Amendment 3** with the four items of §13, at the Campaign checkpoint; then the `active`/`ended` transitions and the end reading.
4. After that, in order and each reviewed: the deal door (`deal_deliverables.campaign_id`, the projection), the planner Commission source (outreach un-frozen), and the athlete-facing surface for spec approval.

---

## 16. Acceptance (27 September 2026)

Accepted as the Campaign source implementation result: the Campaign source works end to end through the shared CreativeIntent / Studio path. The four contract gaps of §13 were resolved as #570 Amendment 3 before the Brain router was wired to the writer; the closed loop then ran on the harness — `docs/audits/campaign-closed-loop.md`.
