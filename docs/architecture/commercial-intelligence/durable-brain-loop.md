# One durable Brain loop — mounted on the substrate, no file ledger on the path

**Status:** for review · branch `feat/durable-brain-loop`, stacked on #662 · **0 provider calls, no dev writes** (two read-only dev queries, §12)
**What this is:** the integration checkpoint. One controlled path now runs the architecture we designed through durable records: BrainRun → Recommendation → governance → router → Campaign → Existing Work → a later run → reconsideration → outcome → adoption → eligibility. Behind `BRAIN_SUBSTRATE_LOOP`, off everywhere.
**Frozen, and not touched:** State, Opportunity, Objective, the Decision taxonomy, Recommendation semantics and governance, the execution-shape taxonomy, the Specialized Plan seam, Campaign/CampaignSpec, CreativeIntent, the Creative Intelligence seam, Studio lineage, `MeasuredOutcome`, reconsideration eligibility, adoption semantics, the substrate. **No semantic contract changed** (§11).

---

## 1. The caller mounted to the substrate

`server/services/brainLoopDurable.ts` — a thin orchestrator outside `services/intelligence` (it may call the provider; the LOCKED rule holds), exposing four functions and adding no semantics: `evaluateAndPersist` (steps 1–4), `governedRecommendations` (5), `routeGoverned` (6–7), `existingWorkForRun` (8). The evaluator, the decision mapping, the reconciliation contract, the router, the Campaign writer and the projections are all used unchanged.

Operator surface: `server/scripts/intelligence/brainLoopDurable.ts`, refusing to run unless `BRAIN_SUBSTRATE_LOOP=true`. It takes an artifact for its inputs, replays the recorded reply by default or re-evaluates with `--live`, optionally simulates her two governance acts (`--govern`, labelled as simulated), routes (`--route`), and **exports** the audit ledger from the database (`--export`). No smaller boundary was needed: one flag and one script.

One extraction, to prevent drift rather than to add anything: the run-output → `DecisionInRun` mapping now lives once in `brain/decisions.ts`, and the file-ledger harness (`brainRecommend.ts`) was pointed at it. Verified by re-reconciling a recorded run through the harness afterwards — same result.

## 2. BrainRun persistence flow

`evaluateAndPersist`, in this order, deliberately:

1. **Evaluate.** If `record.output` is null the gates refused it, and the loop throws `BrainLoopRefused` — a refused set is not a judgment, and **nothing** is persisted (no run, no Recommendation).
2. **Write the run first**, with the spec version, both digests, the model, the variant, the **inputs as seen**, the raw record and the normalised output. If that write fails the loop fails with "the BrainRun could not be persisted; no Recommendation was created".
3. **Only then** reconcile decisions, each pointing at the durable `run_id`.

Both boundaries are tested: a refused reply leaves the run count unchanged, and a database whose `brain_runs` insert throws leaves the Recommendation count unchanged.

## 3. Recommendation reconciliation flow

`persistRunDecisions` loads the durable ledger, calls the **pure** `reconcileRun`, and writes back what it returns. The loop reports what happened from the store's own answer (`created`, `reconsidered`, `withdrawn`), never by indexing into the ledger — the mistake that would silently attach governance to the wrong record. On the recorded first run: four decisions, four records created, each with `run_id` set and its `created` event.

## 4. Governance persistence

Hers, and not performed by the loop: the caller calls `respondToRecommendation` and `authorizeRecommendationPrepare` on the store. `governedRecommendations` then reads the durable ledger for records that are accepted-or-modified **and** prepare-authorized. In the test it returns `[]` before her acts and exactly the one record after them. The event sequence on that record ends up `created · accept · prepare_authorized · execution_proposed · reconsidered_by_run · outcome_recorded`, append-only with unique sequence numbers.

## 5. Campaign execution-ref write

The isolated handoff is gone. `routeGoverned` routes the governed record and, for a campaign handoff, calls `createCampaignFromOrigin` and then `recordRecommendationExecution` — **the Recommendation store writes the Recommendation**. The separation is asserted rather than asserted-in-prose: the Campaign writer touches no Recommendation table, and the campaign row's own `recommendation_ids` is how the Campaign points back. `executionRefFor` survives as the pure reference builder it always was.

## 6. Existing Work, read from the database

`existingWorkForRun` composes `existingWorkFrom(deals, counts, reviewQueue, now, planned)` where `planned` is `persistedExecutionWork` — campaigns (with their approved scope, whether creative work is underway, and the end condition) plus outreach planning work, assembled from durable rows. It is an **input projection**: nothing is written, and no campaign or plan row reaches Athlete State.

Before routing, `planned` is empty. After routing, it contains `campaign[<id>]` as an `activation` with `for.recommendationId` pointing at the Recommendation and a statement reading `· planning ·`.

## 7. Second-run behaviour

The second run is handed inputs whose `work` came from that database read — the test captures what the evaluator received and asserts the campaign item is in it, with the right `for.recommendationId`. No handcrafted fixture is involved. The recorded second reply answers `NO_ACTION` on that Objective, and reconciliation records `reconsidered_by_run` on the governed record: `closed` stays false, `value` is byte-identical to before, and the run count is 2.

## 8. Dedup behaviour

Routing the same governed Recommendation again is refused at the dedup stage, and the campaign count stays 1. Both layers remain: the Brain declined to re-recommend (run 2), and the router refuses independently of the Brain's judgment.

## 9. Outcome and adoption

Exercised, because the controlled scenario produces one. The campaign was ended (`cancelled`, remaining obligations cancelled), which returned the Recommendation outcome for the ledger's owner. Then:

- `adoptionFromSubstrate` derived **`recommended_and_followed`** from durable records, with `proof: ["campaign:<id>"]` — the linking execution reference.
- `recordRecommendationOutcome` persisted it once, closed the record, and the execution refs **survive closure** (asserted).
- Eligibility was computed afterwards and mutated nothing: the recommendation row is byte-identical before and after. With no recorded baseline it is `eligible: false` with the reason stated, which is the baseline rule doing its job.
- Later reconsideration remains possible: the closed record leaves the router's dedup, so a new governed judgment on that decision can open new work.

No outcome table was added.

## 10. File-ledger classification and remaining uses

| Script | Classification | Why |
|---|---|---|
| `brainRecommend.ts` | **historical audit fixture** | reconciles recorded artifacts into `recommendations.json` for the recorded experiments; now shares the durable path's decision mapping so the two cannot drift |
| `brainRoute.ts` | **historical audit fixture** | the routing/closed-loop experiments and their artifacts; its `--persist` writes the file ledger, which is authoritative *only* for those recorded experiments |
| `brainResurfaceOffline.ts`, `brainR1Fixture.ts` | **historical audit fixture** | recorded reconsideration and R1 experiments |
| `brain/ledgerExport.ts` | **compatibility / export (new)** | generates the `RecommendationLedger` JSON **from the database** so audit tools keep working without dual-writing |
| none | obsolete | nothing was deleted |

On the mounted path the database is authoritative and no file is written; the audit artifact is generated on demand. Dual sources of truth are avoided by construction: the durable loop imports no `node:fs` at all, which the test asserts against the module source.

## 11. Failure and transaction boundaries, and whether any contract changed

- **Gates refuse** → nothing persisted.
- **Run write fails** → the operation fails; no Recommendation, no execution state, no orphan.
- **Reconciliation** writes record-by-record and appends only events beyond the stored sequence, so a re-run is idempotent rather than duplicating history.
- **Campaign creation then execution ref** are two writes and are *not* wrapped in one transaction: a campaign without its ref is recoverable (the ref can be recorded later from the campaign's own `recommendation_ids`), whereas a ref pointing at a campaign that does not exist is not. Recorded as a deliberate ordering choice, and the one place a single transaction would be an improvement when a route becomes a product surface.
- **No semantic contract had to change.** The only shared-code edits were the mapping extraction (§1) and the earlier vocabulary amendment already accepted in #662. Nothing in the frozen list moved.

## 12. The Measure → Learn empirical question, answered with dev data

Two read-only queries against dev (no writes, no publish, no backfill):

| Fact | Value |
|---|---|
| publish jobs | 2 · **one** with a platform media id, `succeeded`, `mode: live`, with a permalink |
| that id's shape | 17-digit numeric |
| ingested content observation keys | **the same shape** — 12,630 observations on 17-digit numeric ids (plus 7,908 on 19-digit) |
| observations for the published id | **0** |
| last content ingest | 2026-09-27 04:30Z |
| that publish | 2026-09-25 10:15Z |
| `media_assets.origin='generated' AND posted_at NOT NULL` | 0 |
| `published_asset_identities` on dev | does not exist yet (0075 undeployed) |

So: one real live-published Studio post exists, the join is shaped correctly (identical key space), ingest ran **two days after** the publish — and there is still no observation for it. **The gap is coverage, not timing, and not the contract.** Ingest does not pick that post up; why (a different connected identity, the media list's scope, or a container-vs-published id distinction in the Graph reply) is a pipeline question for whoever owns ingest. Also worth noting: the publish path records `posted_at` only on `content_posts`, never on the asset, so the `asset_id` second path cannot rescue a generated post either.

**Consequently the attribution could not be demonstrated against real data**, and I did not publish live or run the backfill. The backfill remains available and unexecuted; it would create exactly one identity row, which would still have zero observations to join.

## 13. Is the durable loop ready for controlled product activation?

**Yes, on one path, with two caveats that are operational rather than architectural.** Every step runs through durable records with no file ledger; the failure boundaries refuse rather than orphan; governance, dedup and reconsideration behave as designed on the database. The caveats: (a) the loop's input assembly still comes from an artifact's `inputs` in the operator script, so a product activation needs the live assembly path (`brainRun.ts`'s builders) wired to `evaluateAndPersist`; (b) the campaign-then-ref ordering deserves one transaction when a route calls it.

## 14. The smallest next product-facing activation step

**Wire the live input assembly to `evaluateAndPersist` behind the same flag, for one dev athlete, and run it once.** Concretely: lift the input builders out of `brainRun.ts` into a function both it and the durable script call, then run the durable script with `--live` for the dev test athlete. That is one refactor with no new semantics, and it makes the loop end-to-end real rather than artifact-seeded. Everything after it — a route that presents governed Recommendations to her, the campaign approval surface already built, outcome recording on a schedule — is a product decision, not an architectural one.

## 15. Tests

`brainLoopDurable.test.ts` — 3 tests: the whole twelve-step loop through the database using the two recorded runs as injected replies; the two failure boundaries (gates refused, run write failed); and an assertion that the loop module reads and writes no ledger file. Regression: intelligence (282), Studio creative/campaign/generate/agent, campaign governance, outreach, publish — all green.
