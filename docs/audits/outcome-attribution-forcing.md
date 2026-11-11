# Outcome attribution — the two observation dependencies and the seven forcing cases

**Status:** findings for review · branch `feat/outcome-attribution`, stacked on #660 · **0 provider calls, no dev writes**
**What is mounted:** the publish → observation join (migration 0075, written non-fatally by the publish runner) and external-confirmation provenance. Outcome Intelligence itself is an **experimental, unmounted module** (`server/services/intelligence/outcome/`) reached only by tests. No outcome table exists and the experiment did not need one (§7).
**Controls:** the existing ledger contracts (`MeasuredOutcome`, `CorrelationalObservation`, `CalibrationPair`, `ADOPTION`), the existing reconsideration bridge's vocabulary, `social_metric_observations` as the authoritative metric ledger, #570 as amended.

---

## 1. The publish → observation join

`published_asset_identities` — one row per (asset, platform) publication, recorded at publish time, holding the platform's **own** media id, a canonicalised permalink for audit, the publish job, and a `source` saying how the identity was established. Precedence is enforced in code, not by convention:

1. **`platform_media_id`** — the platform's own id for the post, which is exactly what `social_metric_observations.entity_id` is keyed by.
2. **`provider_mapping`** — admitted by the contract, no producer today.
3. **`permalink`** — only when no platform identity exists **and** the canonical permalink is unique among her other published assets, proven by a query before the row is written.

Nothing else. No caption, no timestamp proximity, no fuzzy content. An unidentifiable publication records **nothing** rather than a guess (`recordPublishedIdentity` returns null).

`observationsForAsset(db, athleteId, assetId)` answers the question the frontier needed — *which metric observations belong to this published Studio asset?* — by the recorded platform id, with `asset_id`-stamped observations as a second path, and reports `unidentified: true` when there is no identity at all. **No metric value is copied anywhere**: `social_metric_observations` stays authoritative, and the test asserts `media_assets.like_count` and `.insights` remain null on a published generated asset.

Deliberately **not** written into `media_assets.source_media_id`: that column belongs to ingest, and a generated asset carrying one would read as a connected post.

The writer sits in the publish runner beside `recordPost`, non-fatal and logged on failure — the `savePlan` precedent, since losing the post over its provenance would be worse than losing the link. Publish behaviour is otherwise byte-identical; the publish suites are green.

**Available and not run:** existing `studio_publish_jobs` rows that already carry `ig_media_id` can be backfilled into this table deterministically. That is a dev write and needs a named command.

## 2. External-confirmation provenance

`campaign_deliverables` gains `confirmed_by`, `confirmed_at`, `confirmation_ref` (all nullable). `confirmExternally(db, athleteId, deliverableId, by, now, ref)` now refuses an empty actor and records all three; `CampaignDeliverable` carries them. Still the single `fulfilled` write, still refusing a derived criterion and a deal-door row. No generic Campaign event model was introduced — an external confirmation is an observation, and it now has the provenance an observation needs.

## 3. The seven cases

| Case | Result |
|---|---|
| **1 · athlete-origin creative, no judgment** | Lineage resolved asset → job → intent with `source: athlete` and **no** recommendation id. Outcome attributed to the **creative intent**, `entryId: null`, `adoption: not_recommended`, sources the observation refs. Nothing forced it into a Recommendation outcome, and the record contains no recommendation reference at all. ✓ |
| **2 · campaign content, recommended and followed** | Lineage resolved upward through the intent to the campaign, its spec version, the deliverable and `rec_c2`; with the governed record in the ledger, `adoption: recommended_and_followed`. The outcome's `sourceIds` are observation references only — no metric copied. Fulfilment stayed the campaign's own reading and the reach figure appears nowhere in it (asserted): **a published deliverable fulfils the obligation and says nothing about performance** (the case ran with reach 180, deliberately poor). The Recommendation outcome was then recorded separately through the existing ledger hook. ✓ |
| **3 · commercial direct action + the paired negative** | A Recommendation-behind deal reaching `accepted`: outcome on subject `deal`, value read from the deal row, `sourceIds: [deal:<id>]`, `adoption: recommended_and_followed`. The negative — a deal that closed with nothing behind it — `entryId: null`, `adoption: not_recommended`. Also proved: a **declined** Recommendation whose result happened anyway → `recommended_and_not_followed`; and a lineage naming a Recommendation with **no ledger on the path** → `adoption: unknown`, honestly (this is production's state today). No commercial state is duplicated into the outcome. ✓ |
| **4 · ended but incomplete campaign** | An outcome exists because something happened: `endedBecause: expired`, `fulfilled 0 of 1`. Nothing in the record reads as success (asserted against /success|ok|achieved/). The completion reading stayed separate — the obligation is `waived` on its own row. **Outcome ≠ success.** ✓ |
| **5 · observation with no judgment** | A `CorrelationalObservation` with `observedQuantity`, an `entryId` pointing at the assessment it bears on, and **no `adoption` property at all** (asserted). No Recommendation lineage invented, no retrospective causation. The comparison came from a recorded earlier feature: reach median 1000 → 4000, delta +3000 (×3). ✓ |
| **6 · falsifier / reconsideration eligibility** | With a judgment's own falsifier satisfied: `eligible: true`, subjects `objective[obj-1]`, `recommendation[rec_c6]`, `campaign[camp-x]`, citing the observation. Nothing changed in State, the Objective or the Recommendation. With no recorded baseline: `eligible: false` because the comparison is unavailable. With a comparison but nothing falsified: `eligible: false`. ✓ |
| **7 · non-creative external outcome** | No asset. The confirmation carried actor, time and reference; lineage resolved through the deliverable to the campaign and `rec_c7`; the outcome attributed with `adoption: recommended_and_followed` and `sourceIds: [campaign_confirmation:<id>]`. The evidence stayed domain-native on the deliverable row. ✓ |

## 4. Pressure-testing `MeasuredOutcome`

Used the existing type first, field by field. **Nine of its ten fields carried every case unchanged**: `outcomeId`, `subjectId`, `value`, `observedAt`, `createdAt`, `sourceIds`, `kind`, `entryId`, `adoption`. `value` held a metric object, a deal status, and a campaign result without distortion; `sourceIds` held observation, deal, campaign and confirmation references; `entryId: null` carried "no judgment" exactly as the contract intended; `adoption` covered all four of its values across the cases.

**One field fails, and it is the subject.** `LedgerSubjectType` admits only `athlete | deal | thread | opportunity`. Of the six outcome subjects the cases produced, **two are legal** (a deal, the athlete) and **four are not**: a creative intent, a campaign deliverable (twice), a campaign. The rest of the system already has the wider vocabulary — the Brain's `SUBJECT_KINDS` (objective, deal, brand, opportunity, campaign, brief, asset, athlete, outreach_plan). The module therefore declares `OutcomeSubjectType = SubjectKind | "thread" | "campaign_deliverable" | "creative_intent"` locally and records the finding rather than editing the shared contract. **Proposed, for review:** align `LedgerSubjectType` on `SUBJECT_KINDS` plus `thread`, `campaign_deliverable` and `creative_intent`. Nothing else about the contract changes.

**Does `MeasuredOutcome` need an explicit `evidenceClass`?** Tested, and the answer is **no field, one written rule**. `evidenceOf(sources, observations)` derives it: a metric observation carries its own `source_class` on the row, so an outcome sourced only from observations is fully recoverable (`recoverable: true, classes: [connected_verified]`). A domain-state source carries none — a deal's status and an external confirmation are `MEASURED` **by the reader's rule**, not by a column — so the function returns `recoverable: false` and names which sources lack a class. Derivation is therefore reliable once each source kind's class is declared once, in one table, rather than copied onto every outcome. Preferring derivation, as asked; the rule to write down is: observation → its own `source_class`; deal / payment / campaign confirmation / publish record → `MEASURED`; anything else → assert at the source.

## 5. Baseline rule

Implemented with exactly two legal sources and no third: an Objective's `success.quantified.baseline`, and an earlier `social_features` row at an earlier `as_of` under the **same** `calculation_version`. Where neither exists, `comparisonForFeature` returns `{ available: false, because: "no earlier <feature> on record under this calculation version — comparison unavailable" }` and the observation is still reported. **No "before" is manufactured** — no synthetic zero, no first-observation-as-baseline, no timestamp-nearest guess. Case 6 shows the consequence: an outcome with no recorded comparison is explicitly **not** a reason to re-evaluate.

## 6. Reconsideration eligibility

Inspected the existing bridge first. It defines `Eligibility { eligible, status, because, blocks }` for an Intelligence Request. Two of its words are reused verbatim — `eligible` and `because` — and the differences are deliberate: `status` is a Request's derived state and has no analogue for an outcome, and `blocks` names the decision a missing fact blocks, whereas an outcome **blocks nothing** — it gives reason to re-evaluate named subjects. So:

```ts
ReconsiderationEligibility { eligible: boolean; because: string; subjects: string[]; citing: SourceRef[] }
```

Four keys, asserted in the test. It is not a Decision and not a Recommendation: no proposed action, no subject of its own, no lifecycle. The only path from eligibility to a changed judgment remains a Brain reconsideration citing the outcome, with the athlete governing the result.

## 7. Persistence decision — defer, and here is why

The experiment ran all seven cases **without an outcome table**, and not by working around one: every outcome was constructible from rows that already exist plus the two new links. Two properties make that durable rather than lucky:

- **Outcomes are derivable.** Every field comes from recorded rows: the value from observations or domain state, the attribution from lineage ids, the adoption from the ledger record, the comparison from a recorded baseline.
- **Outcomes are idempotent.** `outcomeId` is a hash of subject, kind, `observedAt` and sources, so recomputing the same outcome yields the same id. Nothing drifts if it is never stored.

**Decision: no outcome ledger yet.** Domain-local records plus derivation on read is sufficient for every case run. Persistence buys two things neither case needed: enumerating outcomes over time without re-deriving, and an append-only audit of *when Nomila noticed*. The first consumer that genuinely needs them is calibration over many pairs — build the table then, as an append-only index, and not before. The one thing that **does** need a home is already designed and has no table: `Recommendation.outcome`, which lands with the substrate whenever that mounts.

## 8. Calibration

One `CalibrationPair` built from the existing type: an `ESTIMATE` entry of USD 5,000 against an outcome of 4,000 → `error { absolute: 1000, relative: 0.25 }`, with the entry's `versions.evaluator` (`brain-eval-spec/0.11.0-exp`) preserved on the pair, so what the model judged, what happened, the difference and the spec lineage are all present. An `ASSESSMENT` cannot form a pair — refused at compile time by the signature and at runtime by the guard (asserted). **No parameter, prompt or model was tuned**, and nothing here can tune one: learning stays global and versioned.

## 9. What stands between this and running for real

Three honest dependencies, none of them code I should write unasked:

1. **Identities only fill when a publish actually happens.** The join is written at publish time, so on dev it fills after a real publish (`STUDIO_PUBLISH_MODE=live`) or after the backfill in §1, which needs a named command.
2. **Ingest must observe the published post.** Observations exist only for posts the ingest discovers. A Studio-published post enters that set through her connected account like any other, so the first real attribution depends on one ingest cycle after one publish — worth confirming empirically before anything is built on top.
3. **Adoption is `unknown` in production for anything recommended.** The Recommendation ledger is the harness's file ledger; `adoptionFor` returns `unknown` honestly when it cannot resolve a named Recommendation. Every case that classified adoption did so with a ledger supplied. This is the clearest argument yet for the substrate, and the cheapest test of it.

## 10. Tests

`outcome/forcing.test.ts` — 10 tests, PGlite, synthetic observations, no provider: the join's precedence and refusals plus "no metric copied"; the seven cases as above; `MeasuredOutcome` field by field with the illegal-subject assertion; evidence-class recoverability both ways; the calibration pair and the refused assessment. Regression: intelligence (277), publish suites, campaign governance, Studio campaign/creative/generate, outreach — all green.

---

## 11. Acceptance (27 September 2026)

Accepted; the Outcome Intelligence architecture is frozen. No outcome table, no calibration, no automatic learning. The §9 finding — adoption is `unknown` in production without Recommendation persistence — moved the #648 substrate to the front: mounted in `docs/architecture/commercial-intelligence/brain-substrate-mounted.md`, together with the `LedgerSubjectType` amendment (§4) and the evidence-class rule (§4) frozen as derived.
