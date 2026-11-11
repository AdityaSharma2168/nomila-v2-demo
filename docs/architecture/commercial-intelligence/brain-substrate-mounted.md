# The BrainRun + Recommendation substrate, mounted — and adoption derived from durable records

**Status:** for review · branch `feat/brain-substrate`, stacked on #661 · **0 provider calls, no dev writes**
**Why now:** #661 found that production adoption can only ever be `unknown` while Recommendation persistence is absent. That single finding moved the substrate from "designed" (#648) to the thing blocking Measure → Learn.
**Scope discipline:** the #648 design was implemented, not redesigned. No outcome table, no calibration loop, no Campaign expansion, no deal door, no planner source, no Objective/Opportunity change, no Rate work.

---

## 1. `LedgerSubjectType` amendment

The vocabulary now lives in **one** place below both consumers: `contracts/subjects.ts`.

```ts
SUBJECT_KINDS           = objective · deal · brand · opportunity · campaign · brief · asset · athlete · outreach_plan
EXECUTION_SUBJECT_KINDS = thread · campaign_deliverable · creative_intent
LEDGER_SUBJECT_KINDS    = SUBJECT_KINDS + EXECUTION_SUBJECT_KINDS
```

`brain/contract.ts` imports and **re-exports** `SUBJECT_KINDS`, `SubjectKind`, `SubjectRef` and `subjectRefString` unchanged, so every existing Brain caller is byte-identical. `intelligenceLedger.ts` now defines `LedgerSubjectType = LedgerSubjectKind`. No second taxonomy exists, and the additions are only the three execution-side subjects the Brain never names: the inbox's `thread`, one obligation inside a campaign, one piece of requested creative work.

**Compatibility, pressure-tested.** `LedgerSubjectType` had exactly two users, both interfaces in its own file (`LedgerEntryBase.subjectType`, `OutcomeBase.subjectType`); the ledger's own tests use `"athlete"`, still legal; `intelligence_ledger.subject_type` is a bare text column with **no CHECK**, so no migration is needed and no stored row becomes invalid. The widening is additive in the strict sense: every previously legal value remains legal. `MeasuredOutcome` is otherwise untouched — same ten fields, same meanings.

**Consequence in the outcome module:** its local widening is gone. `AttributedOutcome` and `AttributedObservation` are now plain aliases of `MeasuredOutcome` and `CorrelationalObservation`.

## 2. `evidenceClass` frozen as derived — the rule, written down once

No field was added to `MeasuredOutcome`. The source → evidence-class rule, in one place (`evidenceOf` derives it, and this table is what a reader asserts by):

| Source kind | Evidence class | How |
|---|---|---|
| `observation:<id>` (social metric observation) | **its own `source_class`** — `connected_verified` · `platform_public` · `web_researched` · `inferred` · `imputed` | read from the row |
| `deal:<id>` / `payment:<id>` | **MEASURED** | a recorded commercial state; the class is the reader's rule, not a column |
| `campaign_confirmation:<deliverableId>` | **MEASURED** | an external party confirmed it, with actor and time on the row (0075) |
| `publish:<jobId>` / `campaign:<id>` | **MEASURED** | an authoritative record of something the system did |
| anything else | **must be declared at the source** | never silently defaulted; `evidenceOf` returns `recoverable: false` and names the unresolved sources |

Outcome records reference sources; they never duplicate the classification.

## 3. BrainRun — schema and writer

`brain_runs` (migration 0076): `id`, `athlete_id`, `as_of`, `spec_version`, `canonical_sha256`, `prompt_sha256`, `model`, `variant?`, `inputs` (the evidence **as seen**), `record` (usage, latency, gates, raw text), `output` (normalised decisions / deferred / requested), `created_at`. Unique on `(athlete_id, prompt_sha256, as_of)`.

**No lifecycle, no status, no reconciliation state** — exactly as #648 specified. The writer is `insertBrainRun` and there is **no update or delete path in the module by construction**, which the test asserts by inspecting the module's own exported names. Reads: `getBrainRun`, `listBrainRuns`.

## 4. Recommendation — schema and writer

`recommendations`: `id` (the `rec_…` key-derived identity) · `key` (the decision key) · `run_id` → `brain_runs` · `source`, `subject_kind`, `subject_id`, `question`, `objective_ids` · `value` (what, why, cites, execution shape, relation, advances, notSeen, intent, ends) · `versions`, `runs` · and **four independently transitioning jsonb columns**: `response`, `authz`, `execution`, `outcome`. `authz` is the contract's `authorization`, renamed because the word is reserved in SQL and mapped back in the row↔record converter. Plus `superseded_by`, `reconsiders`, `closed`, timestamps.

Asserted in the test: **no canonical subject state is copied** (the stored `value` contains no Objective body), and there is no planner, Campaign or Deals column.

The writer is thin on purpose. `substrate.ts` loads records into a `RecommendationLedger`, calls the **pure** contract, and writes back what it returns. Every semantic — keys, reaffirmation, rewording, superseding, withdrawal, reconsideration, the once-only outcome — stays in `recommendation.ts` and is unchanged by persistence.

## 5. Event persistence

`recommendation_events`: one append-only row per event — `recommendation_id`, `athlete_id`, `seq`, `at`, `event`, `actor`, `note` — unique on `(recommendation_id, seq)`. `writeRecord` appends only events beyond the highest stored `seq`, so re-writing a record is idempotent and no event is ever rewritten or removed. The test asserts a governed record's sequence is exactly `[1,2,3,4]` for `created · accept · prepare_authorized · reconsidered_by_run`.

## 6. Governance reconciliation behaviour

The invariant holds against durable records, and the test proves both sides in one run:

- A **governed** record (accepted and prepare-authorized) answered `NO_ACTION` by a later run: `closed` stays `false`, `value` and `response` are byte-identical to before, and a single `reconsidered_by_run` event is appended. Nothing is overwritten, nothing is withdrawn.
- An **ungoverned** record answered the same way: `withdrawn_by_run`, `closed: true`, and it disappears from the open ledger.

## 7. Execution-ref persistence

`recordRecommendationExecution` applies the pure `recordExecution` (which still requires `prepare_authorized`) and persists the `execution` column. Refs accumulate; the outcome does not clear them. After an outcome closed a record, its `execution.refs` still read `["camp-A"]` (asserted) — history survives closure.

## 8. Adoption derivation

Stated once, in `outcome/adoption.ts`, and derived from recorded governance plus execution lineage — never from resemblance:

> **FOLLOWED** = she accepted (or modified) the Recommendation, **and** preparation was authorized, **and** an execution reference on that record is the one this outcome came through.

| Value | What produces it |
|---|---|
| `recommended_and_followed` | all three conditions, with the linking reference named as proof |
| `recommended_and_not_followed` | a Recommendation reached her before the result and she **declined** it; the result happened anyway through a path it never authorized |
| `not_recommended` | no Recommendation on this subject reached her before the result |
| `unknown` | a named record is not on file, or governance is genuinely ambiguous — accepted but unauthorized, or accepted with no reference linking this result |

"Reached her before" is explicit: a response she gave at or before the observation, or a recorded `presented` event at or before it. Two paths find the judgment: the outcome's own lineage, and — when the lineage names none — the candidate Recommendations **on the same subject**, which is what makes `recommended_and_not_followed` reachable at all.

## 9. Results of the minimal attribution cases

All four ran against the database substrate with **no file-ledger injection**.

- **A · `recommended_and_followed`.** BrainRun → persisted Recommendation → accept → authorize → execution ref `campaign:camp-A` → a campaign outcome. Adoption derived: `recommended_and_followed`, `entryId` the record, `proof: ["campaign:camp-A"]`, with the reason naming the authorization. Then `recordOutcome` closed it.
- **B · `recommended_and_not_followed`.** A declined counter-Recommendation on a deal; the deal then reached `accepted` through her own path, with **no lineage pointing at the record**. Adoption found the candidate by subject and returned `recommended_and_not_followed`. Occurrence was not treated as compliance — and passing the declined record by lineage gives the same answer, never `followed`.
- **C · `not_recommended`.** A completed deal with no Recommendation that reached her first: `not_recommended`, `entryId: null`, no candidates.
- **D · `unknown`, four legitimate shapes** (not manufactured): accepted but never authorized; accepted and authorized but the result came through a *different* reference; a named record not on file; and by-subject, an accepted judgment with nothing linking the result.

## 10. Reconsideration bridge against durable records

A durable outcome (campaign expired, 0 of 2) was recorded on the Recommendation, then eligibility was computed from it. `eligible: true`, subjects `objective[…]`, `recommendation[…]`, `campaign[camp-R]`, citing the campaign reference. **Nothing mutated:** the `recommendations` row and the `objectives` row are byte-identical before and after (asserted by row comparison). A later BrainRun then cited the outcome id in its own `inputs` and is just another append-only record; the Recommendation remains closed by its outcome, not by the new run. No automatic learning exists anywhere on this path.

## 11. What remains file- or harness-only

- **The harness scripts still use the file ledger.** `brainRecommend.ts`, `brainRoute.ts` and the recorded artifacts under `docs/audits/artifacts/` read and write `recommendations.json`. Nothing in production writes the new tables yet: the substrate is schema plus store plus tests, with **no production caller**. Wiring the harness or a route to it is the next reviewed step, not this one.
- **The campaign origin writer's ledger write** stays isolated behind `executionRefFor` (#658 §3); with the substrate mounted, that caller can now be `recordRecommendationExecution`.
- **Outcome Intelligence** remains an unmounted module: no route, no job, no flag reads it.
- **Publish identities** fill only at publish time; the deterministic backfill from existing `studio_publish_jobs.ig_media_id` remains **available and unexecuted**, as instructed.

## 12. Is Measure → Learn semantically mountable in production now?

**Yes, semantically — with one empirical dependency left.** Of #661's three prerequisites:

1. *Publication identity exists* — mechanism built (0075); fills on the next publish or the backfill.
2. *Ingest observes the post* — unchanged and untested end to end; this is the only remaining empirical unknown, and it is someone else's pipeline doing what it already does.
3. *Durable Recommendation substrate resolves adoption* — **closed by this checkpoint.** Adoption now returns all four values from durable records, with `unknown` reserved for real ambiguity rather than for missing persistence.

So the loop is mountable as soon as a caller writes runs and Recommendations on the production path. Nothing about the semantics is open.

## 13. Is any outcome or calibration persistence needed next?

**No, and the substrate strengthens that answer.** Outcomes remain derivable and idempotent (`outcomeId` is a hash of subject, kind, `observedAt` and sources), and everything an outcome needs to attribute itself is now durable: the run, the judgment, its governance, its execution refs and its recorded outcome. The one thing that genuinely needed a home — `Recommendation.outcome` — has one. A calibration or outcome table buys only enumeration without re-derivation, and the first consumer that needs it is calibration over many pairs, which does not exist and is not being built. `CalibrationPair` stays an on-read analysis object; no calibration table, no parameter updater, no per-athlete weights, no prompt or model auto-selection.

## 14. Tests

`brain/substrate.test.ts` — 7 tests, PGlite, no provider: BrainRun append-only and complete with no mutation path; a run's decisions persisted with events, the run pointer, and no canonical state copied; governance reconciliation on both sides with the event sequence checked; the four attribution cases; `recordOutcome` persistence, once-only, with execution history preserved; the reconsideration bridge with before/after row equality. Regression after the shared-vocabulary amendment: intelligence (281), Studio creative/campaign/generate/agent, campaign governance, outreach, publish — all green.

---

## 15. Acceptance (27 September 2026)

Accepted. The core intelligence architecture is frozen; the next checkpoint was integration, not another semantic layer. S1 (no production caller) is closed by the durable loop — `docs/architecture/commercial-intelligence/durable-brain-loop.md`.
