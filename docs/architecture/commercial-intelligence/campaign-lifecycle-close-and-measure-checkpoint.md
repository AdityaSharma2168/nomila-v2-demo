# Campaign lifecycle close, the athlete's governance surface, and the Measure → Learn checkpoint

**Status:** for review · branch `feat/campaign-lifecycle-close`, stacked on #659 · **0 provider calls**
**What is mounted:** the narrow end reading and `ended` decision, and the athlete's Campaign governance surface behind `STUDIO_CAMPAIGN_GOVERNANCE` (off everywhere). **Campaign execution is frozen after this** (§6). Deliverables 7–9 are the next frontier's checkpoint and contain no code.
**Not done, by rule:** no deal door, no planner Commission source, no observed door, no further Campaign automation, no Rate, no Objective/Opportunity redesign, no new Campaign source, no Measure/Learn implementation.

---

## 0. Recorded, not reopened

- **Campaign R13 residual.** The campaign-shaped `what` in the closed-loop Run 1 named channels ("across her Instagram and TikTok channels"). Recorded in the backlog as the Campaign-shape residual of R13, with the controlling principle: the Brain may define the strategic activation; Campaign planning and Creative Intelligence own downstream channel and execution decisions unless the channel is itself strategically constitutive of the Decision. No Brain patch. Watch on the next Campaign exercise.
- **Lifecycle wording.** The Brain called a `planning` campaign with an empty draft scope "active" in its NO_ACTION rationale. Recorded as a semantic rendering/reasoning reliability item. The Existing Work projection is authoritative and was correct; future Brain guidance should prefer the lifecycle terms actually rendered rather than synonyms. No lifecycle change, no provider rerun.

---

## 1. End-condition reading

`endEligibility(db, athleteId, campaign, now)` (`campaign/lifecycle.ts`) answers one deterministic question — **has the authoritative end condition occurred?** — from the campaign's own resolved period and the object `endsRef` names. Never from prose, never guessed.

| Source | Resolution | Answer |
|---|---|---|
| any source with `period.endsOn` resolved | the date | `reached` when `endsOn ≤ today`, else `not_reached`; basis `period.endsOn <date>` |
| `objective_horizon`, Objective live with a period horizon and no date | the Objective | **`unknown`** — "the Objective is live and its horizon is a period (this_season) with no date on record" |
| `objective_horizon`, Objective `achieved` / `abandoned` / `superseded` | the Objective | `reached` — "its horizon has closed by decision" |
| `objective_horizon`, Objective not on record | — | `unknown` |
| `deal_term` with no term end resolved onto the period | — | `unknown` — "no term end was resolved onto the period" |
| `athlete_stated` with no date | — | `unknown` — "no stated finish is on record" |

Every answer carries `{ eligibility, source, ref, basis }`, so the reason is legible wherever it is shown. Tested across all six rows.

## 2. `ended` transition semantics

Reaching the end **does not end anything** — it makes the campaign eligible to end. `ended` is written only by `endCampaign(db, athleteId, campaignId, { because, actor, remaining?, override? })`:

- **`fulfilled`** requires every non-optional in-scope deliverable to be `fulfilled` by its declared `completesWhen` or `waived`. It never consults the clock (tested: a campaign whose eligibility is `unknown` still ends as fulfilled when the obligations are met). Refused otherwise: "cannot end as fulfilled: n non-optional obligation(s) neither fulfilled by their declared criterion nor waived".
- **`expired`** requires `eligibility: "reached"` **or** an explicit `override.reason` — "the end condition is unknown (…) — state an override reason or wait". Time alone never writes `fulfilled`.
- **`cancelled`** is hers at any time.
- Any reason with obligations still open requires `remaining: "waive" | "cancel"` — closure never silently resolves an obligation.
- Idempotent: ending an ended campaign returns it unchanged with its original reason.

`endedBecause` keeps #570's vocabulary (`fulfilled | expired | cancelled`) — implementation proved it sufficient; nothing was added.

## 3. Remaining-obligation handling

Open obligations at closure become `waived` or `cancelled` per the stated disposition, one row each, reported back as `obligations[{deliverableId, before, after}]`. Creative intents that have produced nothing (`open | interpreted | confirmed`) are withdrawn and listed. **Work already executing is never touched**: a job `running` against an intent stays running and its intent keeps `withdrawn_at: null` (asserted) — stopping it is the executing system's own cancellation with its own authorization. Deliverable rows, plans, jobs and assets all remain queryable.

`endCampaign` also returns `recommendationOutcome` — `{ recommendationId, followed: true, result { campaignId, endedBecause, fulfilled, of } }` — for the ledger's owner to record. It is **not written here**: the Recommendation ledger is still the harness's file ledger. The ledger gained the writer this PR: `recordOutcome(record, {followed, result}, at)` (`brain/recommendation.ts`) requires an execution to be the outcome of, is once-only, emits the pre-existing `outcome_recorded` event, and **closes** the record. Closing matters: a closed record leaves the router's dedup, so a later governed judgment on the same decision can open new work (tested end to end).

## 4. Existing Work after ending

An ended campaign yields **no** Existing Work item (`campaignWorkItem` returns null — tested), so a later Brain run does not see it as execution underway; a `planning` or `approved` campaign does appear, which is what the closed loop depends on. History stays intact: the campaign, its spec versions, its deliverables with their final statuses, the intents and every Studio record remain queryable, and the Recommendation keeps its execution refs and its recorded outcome.

## 5. Athlete CampaignSpec approval surface

`server/routes/campaignGovernance.ts`, behind `STUDIO_CAMPAIGN_GOVERNANCE` (off ⇒ 404), gated by auth + athlete only — it is hers, not a Studio surface. Five narrow routes:

| Route | What it does |
|---|---|
| `GET /campaigns` | her campaigns: id, purpose, status, origin door, current version, period, `endedBecause` |
| `GET /campaigns/:id` | purpose, period, **end eligibility with its basis**, the current scope (version, approval, purpose, period, constraints, each deliverable with its `completesWhen` and derived progress), the approved version, and **exactly what the Brain sees in Existing Work** (null once ended) |
| `POST /campaigns/:id/specs/:version/approve` | **the second act**: approves the current draft, then materialises creative intents. Returns what was created, kept, withdrawn and dropped. An older draft is refused (409); re-approval is idempotent |
| `POST /campaigns/:id/deliverables/:did/confirm` | external confirmation of an `externally_confirmed` obligation; refuses a derived criterion or a deal-door row |
| `POST /campaigns/:id/end` | ending with `because`, optional `remaining` and `overrideReason` |

Preserved and asserted: approval created **zero** previews, jobs and assets; it is not spend, publish or external-execution authorization. Decline / request-revision is deliberately absent — under #570 a draft simply stays draft and a revision is a new version, so no route pretends there is a fourth act. No universal approval control exists.

## 6. Campaign execution is frozen

Confirmed. Mounted and reachable only behind flags that are off: the creative intent slice (`STUDIO_CREATIVE_INTENTS`) and this governance surface (`STUDIO_CAMPAIGN_GOVERNANCE`). No caller wires the Brain router to the origin writer in production — that path exists only in the harness. **Recorded as later doors, not built:** the deal door (with `deal_deliverables.campaign_id` and the `externally_confirmed` read-through), the planner Commission source, the observed door, and any Campaign automation (auto-approval, auto-ending, scheduled materialisation).

---

## 7. Inventory of existing outcome / measurement contracts

Audited read-only across schema, services and docs. **What exists is more than expected on the observation side and almost nothing on the attribution side.**

**Observation substrate (rich, already versioned).**
- `social_metric_observations` is the authoritative metric ledger: keyed by identity + `entity_type (account|content|audience)` + `entity_id` (the platform's own media id) + `metric_key` + `definition_version` + `source_method` + `observed_at` + window, carrying `value`, `unit`, `source_class (connected_verified | platform_public | web_researched | inferred | imputed)`, `confidence`, `provider`, `sync_run_id`, and a nullable `asset_id`. Its metric vocabulary is a frozen registry (`social/metrics.ts`, `definition_version v1`) covering per-post reach, views, saves, shares, watch time and the Story keys.
- `social_features` is the derived layer (`calculation_version v3`): posting cadence, days since last post, format mix, reach medians by format, breakout rate, performance variance, follower growth absolute and percentage, non-follower reach share.
- `social_analytics_snapshots` is the day-grain account rollup, with an explicit source precedence (connected over provider over discovery over research).
- `media_assets.like_count / comments_count / insights` are documented **display projections only**; the feature calculator never reads them.
- One rule already holds and is worth keeping: the intelligence State reads `contentPerformance[...]` **only** from `social_features`, never from a per-post row.

**Commercial result.** `deals.status (detected | pending | negotiating | accepted | completed | rejected)`, orthogonal `payment_status` and `deposit_status`, `payments.status` with dual-confirm timestamps, and `deal_deliverables.status (open | fulfilled | waived | cancelled)`. There is **no outcome or result column on deals**; what counts as a commercial result today is the State builder's `EARNED_STATUSES = [accepted, completed]` feeding closed-deal counts, demonstrated economics and pipeline counts as `MEASURED` facts.

**The shared outcome contract already exists, unwritten.** `contracts/intelligenceLedger.ts` defines `OutcomeBase { outcomeId, subjectType, subjectId, value, observedAt, createdAt, sourceIds }`, `MeasuredOutcome extends OutcomeBase { kind, entryId: string | null, adoption }`, `CorrelationalObservation` (deliberately not an outcome), and `CalibrationPair { entry, outcome, error }`. `ADOPTION = recommended_and_followed | recommended_and_not_followed | not_recommended | unknown`, and the file already argues the anti-self-confirmation rule: adoption must be recorded for outcomes that happened anyway, so `not_recommended` matters as much as `recommended_and_followed`. `entryId: null` is explicitly allowed — "an outcome occurred with no preceding judgment — itself a finding worth keeping". **These types have no writers and no readers.**

**Judgment-side hooks that already exist.** `Recommendation.outcome {at, followed, result}` with the `outcome_recorded` event (writer added this PR, §3; no production caller). `EvaluatedValue.falsifiedBy` — "the observable outcome that would validate or falsify this judgment" — on every evaluated value. `ObjectiveSuccess.quantified.baseline {value, asOf}` read from State at normalisation, which is the **only stored baseline notion** in the system. `objective_events` has a 13-value action vocabulary with **no** measurement action (`achieve` is a lifecycle transition, not a measurement). `brain_runs` and a `recommendations` table are designed in #648 and not built.

**Provenance vocabulary an observation would need.** `EvidenceClass = MEASURED | EVALUATED | ASSUMED | MISSING` (with `DERIVED` deliberately a method, not a class), `CONFIDENCE_LEVELS`, per-owner emission rules (`athlete_state` may emit only MEASURED or MISSING; `objectives` only EVALUATED), and the standing policy that Opportunity's quantities stay ASSUMED "until outcomes give a basis for estimating them".

**Campaign completion.** `deliverableProgress` is derived and writes nothing; `confirmExternally` is the single `fulfilled` write and currently **discards who confirmed and when** — recorded as a gap, because an external confirmation is itself an outcome observation and belongs in the Measure design rather than being patched here.

**What does not exist.** No outcome table of any kind. No writer for `MeasuredOutcome`, `adoption` or `CalibrationPair`. **No join between a published Studio asset and its ingested metrics** — the publish runner writes `content_posts {asset_id, platform, permalink, posted_at}` and never sets `media_assets.source_media_id` from `ig_media_id`, while observations are keyed by the ingested platform id, so a Studio-published post acquires observations only if ingest happens to rediscover it as its own row. No per-post or per-campaign baseline or expected value. No event kind anywhere expresses "a result was observed". `deal_deliverables` still has zero rows.

One correction to note: the creative lineage **is** closed in schema as of #657/#658 — `creative_intent_id` exists on both `studio_plans` and `generation_jobs`, alongside `source_spec_id`, `source_spec_version` and `campaign_deliverable_id`. The chain `media_assets.generation_job_id → generation_jobs.creative_intent_id → creative_intents.lineage` resolves today.

## 8. Proposed Measure → Learn boundary

Three layers, and the boundary is the point.

**Observation (exists).** Facts with provenance: metric observations, deal and payment statuses, publish jobs, campaign deliverable statuses, external confirmations. Nobody interprets here. This layer keeps `source_class` and `observed_at` and nothing else.

**Outcome Intelligence (the new layer, thin).** For an observation it answers the six questions and stops: what happened; what observable result occurred; **which execution, Recommendation, Objective or campaign obligation it relates to** (by reference, through the lineage that now resolves); what evidence class the observation carries; what changed versus the recorded baseline; and whether that is enough to *reconsider*. It emits the existing `MeasuredOutcome` — an `outcomeId`, the subject, the value, `observedAt`, `sourceIds` pointing at the observations, the `entryId` it attributes to (or null), and the `adoption` classification — plus a reconsideration **eligibility**. It never proposes a next move, never writes State, never edits an Objective.

**One shared envelope, domain-native readings.** The envelope is `MeasuredOutcome` as already defined, and it should stay that thin: references, attribution, adoption, evidence class. The *readings* stay where they already live — content performance in `social_features` under its calculation version, commercial result in deals and payments, campaign fulfilment in the derived deliverable progress, athlete action in the existing event vocabularies. The outcome record carries pointers and the attribution, never a copy of a metric series. `CorrelationalObservation` stays separate for anything observed without a judgment behind it, which is what keeps the loop from measuring its own influence.

**Learning is the Brain's, gated.** The pattern already exists and should be reused verbatim: the reconsideration bridge (`brain/reconsideration.ts`) turns evidence into *eligibility*, and only a gated decision citing that evidence changes anything. So an outcome makes a Recommendation, an Objective or an Opportunity **eligible for reconsideration**; the Brain reconsiders in its own run, on the record, and the athlete governs the result. `EvaluatedValue.falsifiedBy` is the natural trigger: an outcome that satisfies a judgment's own falsifier is the strongest eligibility signal the system can have.

**The principle, restated as a rule to test:** State projects facts; Outcome Intelligence observes and interprets results; the Brain learns later. No outcome ever authors State or Objective semantics, and no parameter changes per athlete — only global versioned parameters, as the standing rule requires.

**The first thing to build is not an entity.** It is the missing join: publish → observation (`ig_media_id` / permalink → the platform id observations are keyed by). Without it no creative outcome can be attributed at all, and every other case is already reachable through lineage that exists.

## 9. Minimum forcing cases for outcome attribution

Designed, not run; all offline except where a real ingested post is needed.

1. **Athlete-origin creative, no judgment.** Her own request → intent → asset → published → the post's observations arrive. Expect: an outcome attributed to the creative intent, `entryId: null`, `adoption: not_recommended`. Proves the anti-self-confirmation path and the publish→observation join.
2. **Campaign content deliverable, followed.** Approved scope → intent → asset → published → observations. Expect: the deliverable satisfied by its declared `published` criterion, campaign fulfilment `n of m`, one outcome on the governed Recommendation with `adoption: recommended_and_followed`, and the ledger record closed by `recordOutcome`.
3. **Direct action, commercial.** A counter sent through Deals → `deals.status: accepted`. Expect: an outcome attributed to the Recommendation by `recommendation_id`, `followed: true`, the result read from the deal and payment statuses — and the paired negative case, a deal that closed with no Recommendation behind it, recorded as `not_recommended`.
4. **Ended, incomplete.** A campaign ended `expired` with obligations waived. Expect: an outcome with `followed: true` and `fulfilled 0 of 2` — proving an outcome is not a success measure and that `ended` never implies fulfilment.
5. **Observation with no judgment.** A post she made herself performs above her recorded baseline. Expect: a `CorrelationalObservation`, not an outcome, and no attribution invented.
6. **Reconsideration eligibility, gated.** An outcome that satisfies an Objective's own `falsifiedBy` condition. Expect: eligibility recorded, nothing rewritten; the Objective changes only through a gated Brain decision citing that outcome, governed by her.
7. **Non-creative obligation.** An appearance confirmed externally. Expect: an outcome with no asset, sourced from the confirmation — and the confirmation itself carrying who and when, which is the gap §7 records.

---

## 10. Test results

- `campaign/lifecycle.test.ts` (3): the six eligibility rows; ending refused and permitted per reason with dispositions; unproduced intents withdrawn and executing work untouched; the ended campaign leaving Existing Work with history intact; the ledger outcome closing the record so the router's dedup releases, with a fresh judgment then routable.
- `routes/campaignGovernance.test.ts` (1, HTTP over PGlite): flag off 404; hers only; the view's purpose, period, eligibility with basis, draft scope with per-deliverable criteria and progress, and the Existing Work projection; approval materialising intents while creating zero previews, jobs and assets; re-approval idempotent and an older draft refused; external confirmation allowed for an access obligation and refused for a content one; ending validated and the projection then null.
- Regression: campaign (8), creative (25), Brain, planner, outreach, Studio creative/campaign/generate/agent — all green.

---

## 11. Acceptance (27 September 2026)

Accepted. Campaign execution is frozen — no deal door, planner Commission source, observed door or Campaign automation. The accepted Measure → Learn boundary (observation · Outcome Intelligence · learning through the existing reconsideration bridge) was then exercised: the two observation dependencies were built and the seven cases run — `docs/audits/outcome-attribution-forcing.md`.
