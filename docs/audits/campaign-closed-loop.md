# #570 Amendment 3 and the Brain → Campaign closed loop

**Status:** for review · branch `feat/campaign-amendment3-loop`, stacked on #658 · **2 provider calls, USD 0.065** (Run 1 0.028 · Run 2 0.037); everything else offline
**Controls:** #570 as amended through Amendment 3 (`59741979`, `+` A3 row alignment); `brain-eval-spec/0.11.0-exp`; `execution-router/0.2.0-exp`; the real origin writer (`campaign/store.ts`) against an ephemeral PGlite store built from `shared/schema.ts` — the campaign tables are not on dev until these PRs deploy, and no dev record was touched. Nothing mounted: no production BrainRun or Recommendation persistence; the file ledger carries the execution ref.
**Artifacts:** `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/shape/loop/` — `L1/` (run, `routed.json` with the campaign made), `campaign-work-overlay.json` (the projection Run 2 saw), `L2/` (run, `routed.json`), `ledger/` (the persisted governance and execution ref).

---

## 1. Amendment 3 — exact text (applied to #570, commit `59741979`)

**§4.1 `DeliverableIntent`, new field:**
> `completesWhen: "cleared" | "published" | "externally_confirmed";` — "WHAT CLOSES THE OBLIGATION. Declared when the deliverable is introduced — by the contract's read-through on the deal door, by the athlete on the athlete and recommendation doors — never defaulted and never inferred from the category or the door. `cleared` = an approved asset exists for every unit; `published` = every unit is posted; `externally_confirmed` = a party outside Studio confirms it (the deal door: `deal_deliverables.status`, read through; an appearance: the athlete or the counterpart). Content and ugc may declare any of the three; access, partnership, licence and other may declare only `externally_confirmed` (they produce no asset). Progress under every observable stage is always readable; only the declared criterion closes the obligation."

**§4.2 `Campaign.status`:** `"planning" | "approved" | "ended"` — "`idea` removed, `active` is a derived reading — see §7".

**§4.4 `CampaignDeliverable`:** "A DURABLE OBLIGATION IDENTITY within a campaign. Introduced by one spec version, included in zero or more later approved scopes (`CampaignSpec.deliverableIds`), optionally superseded by a later version — and never re-minted because the spec version changed: the id, and the unit identity beneath it (`campaign:<id>:<deliverable>:<unit>`, the CreativeIntent key), are stable across revisions. `campaign + specVersion + seq` is NOT an identity." Fields `introducedVersion`, `supersededVersion | null`, `seq` (ordering only), `intent`, `status` ("`fulfilled` only when `intent.completesWhen` is satisfied: derived from Studio's records for `cleared` and `published`; written by the confirming party for `externally_confirmed` … `waived` / `cancelled` are declared by the athlete"), `dealDeliverableId`, `supersededAt`. `assetIds` removed: assets are reached through the intents.

**§7 lifecycle table:** `— → planning` (deal door on acceptance; recommendation door "the execution router hands off — the Recommendation is already accepted **and** prepare-authorized"; athlete door on declaration) · `planning → approved` (the athlete approves a CampaignSpec version; a later version approved keeps `approved`) · `approved → (reads as active)` "**derived, not stored:** at least one obligation has entered execution (a job opened against one of its CreativeIntents, or an external confirmation recorded) or `period.startsOn` has passed. Nothing transitions; the reading is computed from the intents and the period, exactly as a CreativeIntent's state is" · `planning/approved → ended·fulfilled` (every non-optional in-scope deliverable `fulfilled` by its declared `completesWhen`, or `waived`) · `→ ended·expired` · `any → ended·cancelled` · `ended` terminal.

**§7, replacing the `idea` paragraph:** "**`idea` is removed.** On the recommendation door the governed pre-campaign object is the Recommendation itself (accepted, then prepare-authorized) — a campaign row before those acts would duplicate its governance. The deal door starts at `planning` on acceptance; the athlete door on her declaration. The observed door, when built, records an activation Nomila learned about *as it is* (already in motion: `planning`/`approved` with what is known, or `ended`) and proposes nothing — a proposal to start something is the Brain's, as a Recommendation. No door needs a persisted proposal-campaign, so no lifecycle state exists without a writer."

**§7, dropped scope:** "When an approved version no longer includes a deliverable: the durable deliverable is marked `supersededVersion`/`supersededAt`; its row and every record beneath it stay; no new work is prepared for it; a CreativeIntent of its that has produced nothing (open, interpreted or confirmed) is withdrawn; work already executing is **not** deleted, cancelled or rewritten — stopping it is the executing system's own cancellation, with its own authorization. A scope revision is never an execution cancellation."

**§8 invariants 14–16:** deliverable id stable across versions; `fulfilled` only by the declared criterion; removal supersedes and withdraws unproduced intents, never touches executing work. The Amendment-1 A3 row aligned ("`planning` on hand-off … no `idea` row").

## 2. Final CampaignDeliverable identity semantics

As implemented in #658 and now in #570: one row per obligation, `introduced_version` / `superseded_version`, `seq` monotonic per campaign for ordering only; `campaign_specs.deliverable_ids` names each version's scope; the unit identity beneath it is the CreativeIntent key. Tested: v3 keeping two of three and adding one → one new intent, the earlier four unchanged, the dropped one superseded with its row kept.

## 3. Completion-criterion decision

`completesWhen ∈ { cleared, published, externally_confirmed }`, **required at introduction**, validated per category (content/ugc: any; access/partnership/licence/other: `externally_confirmed` only), never defaulted or inferred. `generated` was considered and rejected: a draft never closes an obligation; it stays a progress stage. Pressure-tested: contractual content → the contract's words decide, and on the deal door it is `externally_confirmed` read through from `deal_deliverables.status` (invariant 6 preserved; `confirmExternally` refuses a deal-door deliverable); athlete-origin content (a match-day series) → `published` is what her purpose means, declared by her; recommendation-origin content → declared at scope proposal, since the Brain's `what` never fixes it; non-content obligations → `externally_confirmed` only; deal deliverables → their own semantics referenced, never duplicated. **Invariant:** `status = fulfilled` only when the declared criterion is satisfied — derived for `cleared`/`published` (`deliverableProgress.satisfied`, no write), written only through `confirmExternally` for `externally_confirmed`. Tested (a `published` criterion is not satisfied by clearance; a content obligation cannot be confirmed by hand; a missing or disallowed criterion is refused).

## 4. `idea` lifecycle decision

Removed. Recommendation door: the Recommendation is the governed idea; the router hands off after both acts; the campaign starts at `planning`. Deal door: `planning` on acceptance. Athlete door: `planning` on declaration. Observed door: records what exists, proposes nothing (a proposal is a Recommendation). No door needs a persisted proposal-campaign. Migration `0074` narrows the CHECK to `planning | approved | ended`; the enum and the store no longer know `idea`.

## 5. Dropped-scope semantics

As §1's paragraph, implemented in #658 and unchanged: `approveSpec` marks the dropped deliverable `superseded_version/at`; `materializeCreativeIntents` withdraws its unproduced intents (open/interpreted/confirmed) and leaves anything in production to Studio's cancellation; nothing is deleted. Tested.

## 6. #658 code changes required by Amendment 3

- `campaign/contract.ts`: `CAMPAIGN_STATUSES = planning | approved | ended`; `COMPLETION_CRITERIA`, `allowedCriteria(category)`; `DeliverableIntent.completesWhen` (required); `CampaignPhase` (status | derived `active`).
- `campaign/store.ts`: `validateDeliverable` on the origin writer and `proposeSpecVersion`; approval transition without `idea`; `confirmExternally` (the only `fulfilled` write; refuses non-external criteria and deal-door deliverables).
- `campaign/fulfilment.ts`: reports progress under every stage plus `criterion`, `satisfied`, and the derived `status`; the earlier `criterionGap` is gone.
- `campaign/existingWork.ts`: `active` read from the intents and `startsOn`, shown in the statement; never stored.
- `migrations/0074_campaign_lifecycle_amendment3.sql` + `shared/schema.ts`: status CHECK narrowed. Tests updated (campaign 7, route 1).
- Nothing broadened: no deal door, no athlete UI, no `ended` transition.

## 7. Campaign lifecycle verdict

`planning` = a campaign with scope proposed and none approved. `approved` = the current CampaignSpec approved. `active` = **not a stored status**: it is `approved` read together with "work has begun" (an intent in production or beyond, or an external confirmation) or `startsOn` passed. `approved` and `active` are distinct *facts* — scope agreed versus work begun — but keeping both as stored transitions would duplicate what the intents already say, the same drift CreativeIntent's status verdict removed. `ended` (with `endedBecause`) stays stored because it is a decision, not a reading; its transitions are not implemented in this slice.

## 8. Closed-loop harness result

**Run 1** (`L1`, `brain-eval-spec/0.11.0-exp`, the match-day Objective overlay + Context): the Brain returned four RECOMMENDs — three `specialized_plan` on her live Objectives and one **`campaign`** on the match-day Objective with a typed `ends { source: objective_horizon, ref: objective[ctl-obj-matchday-series] }`; 0 structural, 0 grounding problems. Reconciled into the loop ledger (a new record, `rec_c373ce1d5f9cbfb8`). `brainRoute --campaign-writer`: governance simulated (accept + prepare_authorized, labelled), the router validated the campaign shape and resolved the end against the Objective's horizon, and the **real origin writer** created campaign `b18e8e39…` at `planning` with a draft spec v1 and no deliverables; the campaign projected into one Existing Work item under `campaign[b18e8e39…]` with `for {recommendationId: rec_c373ce1d5f9cbfb8, objectiveIds: [ctl-obj-matchday-series]}`.

**Run 2** (`L2`, same inputs plus that projection as Existing Work): the Brain returned **NO_ACTION** on the match-day Objective — "An active match-day campaign (campaign[b18e8e39…]) is currently in motion … covering the objective" — citing the campaign by reference, and RECOMMENDed nothing else for that work: **no duplicate campaign, no parallel specialized_plan for the same intended work** (the three plan-shaped decisions are on the other three Objectives, as in Run 1). 0 structural, 0 grounding problems.

Two observations, recorded: (i) the Brain's `what` in Run 1 named channels ("across her Instagram and TikTok channels") — the R13 residual on the campaign shape; (ii) the Brain's NO_ACTION called a `planning` campaign with a draft, empty scope "active … fully covering" — the projection statement carried the true state; the Brain inflated it in its paraphrase. Dedup was right; the wording was not. A Brain-side reading discipline, not a projection change.

## 9. Recommendation execution-ref behaviour

On the file ledger (`loop/ledger/recommendations.json`, persisted): after the writer ran, `rec_c373ce1d5f9cbfb8.execution = { state: "proposed", refs: [{ kind: "campaign", id: "b18e8e39…" }] }` via the existing `recordExecution` (requires `prepare_authorized`; it was). After Run 2's NO_ACTION, `brainRecommend` recorded `reconsidered_by_run` on that governed record — **not withdrawn** (the withdrawal rule: a governed Recommendation is never superseded by a later run). The write is the same `executionRefFor` the production caller will make when the ledger mounts; nothing was copied from the Recommendation into the campaign beyond its id.

## 10. Existing Work behaviour on the second Brain run

The Brain saw one `activation` item: `Campaign "<purpose>" · planning · scope v1 (draft): 0 content deliverable(s) · creative work underway: no · ends with objective_horizon (objective[ctl-obj-matchday-series]).`, rendered with `· executing recommendation[rec_c373ce1d5f9cbfb8] · for objective[ctl-obj-matchday-series]`. Identity, purpose, linked Recommendation and Objective, lifecycle, current scope, creative work underway and the end condition were all in view, by reference; nothing joined Athlete State.

## 11. Duplicate campaign prevention — both layers held

**Brain layer:** NO_ACTION, citing the campaign (Run 2). **Router layer:** re-routing the governed record against Run 2's inputs → `REFUSED (dedup): already in execution: campaign:b18e8e39… — attach, do not create`. The second backstop is real and independent of the Brain's judgment; had the Brain re-recommended, the ledger would have reaffirmed the same key (no new record) and the router would still have refused.

## 12. Exact next step after the closed loop

1. **`ended` and the end reading** (narrow): `endedBecause: fulfilled` when every non-optional in-scope deliverable is `fulfilled` by its declared criterion or `waived`; `expired` when the resolved end arrives (`objective_horizon` → the Objective's horizon date/period end, `deal_term` → `endsOn`, `athlete_stated` → her assertion); `cancelled` by her act. Design at the Campaign checkpoint; implement as a derived reading plus one decision write.
2. **The athlete's spec-approval surface** — the second act has a store function and no door; the first athlete-facing Campaign step, small.
3. **Deal door** (`deal_deliverables.campaign_id`, the projection, `externally_confirmed` read-through) — the door with real contracts behind it.
4. Then the planner Commission source when the outreach arc is un-frozen. Not before any of these: mounting production BrainRun/Recommendation persistence — the closed loop ran faithfully on the file ledger and an ephemeral store, which is the evidence the substrate decision needs.

---

## 13. Acceptance (27 September 2026)

Accepted: the Recommendation → Campaign → CreativeIntent → Studio closed loop is experimentally supported, and its architecture is frozen after one final narrow Campaign lifecycle checkpoint. The two observations of §8 are recorded as watch items and not reopened — the Campaign-shape residual of R13, and the Brain's lifecycle wording (the Existing Work projection is authoritative). Continued in `campaign-lifecycle-close-and-measure-checkpoint.md`.
