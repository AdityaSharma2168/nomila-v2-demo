# Thin slice: RECOMMEND → direct_action → Deals — dry design/implementation checkpoint (Brain 0.7.0-exp)

**Status:** implemented on the experimental harness and exercised **offline only** (recorded runs, deterministic tests). **No provider call. Nothing materialised** — the Recommendation ledger is a JSON file under the artifacts directory. No mounting; no Deals production behaviour change; no State change; no Campaign/Studio implementation; nothing on the deferred list touched. #608 and #570 untouched.

**Decisions this rests on (26 Sep):** Brain Decision ≠ Recommendation; lifecycle by reuse without copying Objective disposition semantics; Execution Path is routing; the Direct Action seam is WHAT/WHY → HOW with the subject unchanged; the typed intent is an experimental seam vocabulary, not an Action taxonomy; the REQUEST resolver is deferred; NO_ACTION creates nothing; presentation ≠ authorization; lineage through existing metadata before any column.

---

## 1. The typed commercial intent (exact vocabulary for this slice)

`accept | counter | ask_terms | decline | wait` — `COMMERCIAL_INTENTS` in `brain/contract.ts`. It is the *strategic instruction* the Brain hands the commercial execution path for a `deal[<id>]` subject. It is not derived from what Deals can do (Deals has accept / negotiate / request_terms / decline as *reply* intents and a separate delete/auto-file path); it is not a universal Action vocabulary; it is documented as experimental until exercised on real cases. `wait` exists because the Brain has repeatedly and correctly said "the next event is theirs" (1B R2/S4) and that instruction must be sendable without producing a draft.

## 2. The Brain response amendment (0.7.0-exp, by ceremony; digest `a387e12a…`)

Added to the RECOMMEND field list in `BRAIN_DECISION_BLOCK` and to the output contract, verbatim:

```
intent            where the subject of the decision is a commercial subject (deal[<id>]), the
                  strategic instruction you are handing to the commercial execution path:
                  accept | counter | ask_terms | decline | wait. The instruction only — never
                  the mechanics and never the amount, which are the execution path's. A
                  RECOMMEND about a deal without an intent, or an intent on any other
                  subject, will be refused.
```

**Gate 1** (`validateDecision`, inherited by requested decisions, which now keep their `request_id` when borrowing the live rules): a RECOMMEND is *commercial* when its request's subject kind is `deal` (the gate context now carries `requestSubjectKinds`) or when its `advances` names a `deal[…]`; a commercial RECOMMEND without a valid intent is refused (`without a typed intent (missing|<value>)`); an intent on any other RECOMMEND is refused. The Brain emits it; code never infers it from `what`. **Schema:** the RECOMMEND branch carries `intent` as a nullable enum; it is not in `required` because the schema cannot see the subject — the gate decides. **`work[…]` alias removed** from the resolver at this bump, as promised at 0.6 (fixture *parsing* of the string form remains, input-only).

## 3. Brain Decision → reconciliation → Recommendation

`brain/recommendation.ts` (pure). A run's gated output becomes `DecisionInRun[]` — source (the request's `askedBy`, or "the Objective loop"), subject (`SubjectRef`), question, objective ids, the decision, the body — and `reconcileRun(ledger, run, decisions)` returns a new ledger and, per decision, what happened:

| decision | ledger effect |
|---|---|
| RECOMMEND, no open Recommendation on its key | **created** |
| RECOMMEND, same judgment as an open one | **reaffirmed_by_run** (runs appended; no row) — or **reworded_by_run** when only the words changed (the record keeps the latest wording; no row) |
| RECOMMEND, different judgment on the same decision | **superseded** (old closed, `supersededBy`) + **created** |
| NO_ACTION / REQUEST_INTELLIGENCE | **withdrawn_by_run** on any open Recommendation for that decision; otherwise **nothing** |

**Judgment identity** = the decision (source · subject · question) plus the routing (`execution_path`, `advances`) plus, for a commercial subject, the typed `intent`. **Wording is not identity** — the offline run below is what forced that: 1B established that `what` drifts freely between identical runs while type, path and relation hold, and a first version keyed on the sentence superseded every standing decision every run. **Evidence is not identity** (a different cite set reaffirms). Pre-0.7.0 records carry no intent; for a commercial subject without one the wording is the only signal and is used, flagged — which is why the provider experiment is needed (§16).

## 4. The Recommendation record

Mirrors an `intelligence_ledger` RECOMMENDATION entry so materialising later is a write, not a redesign: `id`, `key`, `source`, `subject: SubjectRef` (→ `subject_type/subject_id`), `question`, `objectiveIds`, `value {what, why, cites, executionPath, relationToExistingWork, advances, notSeen, intent}`, `versions {spec, runId, runAt}` (→ `evaluation_run_id`), `runs[]`, `supersededBy`, `closed`, append-only `events[]`. Persistence in this slice: `ci-boundary/slice/recommend/recommendations.json`. Not written to the database; that is a separate, deliberate decision (the first materialisation in this series).

## 5. Response versus execution authorization — four fields, never one state for another

| field | states | who moves it | what it is not |
|---|---|---|---|
| `response` | none · accepted · modified · declined · deferred | the athlete (`respond`) | not authorization: `accept` leaves `authorization` at `none` (tested) |
| `authorization` | none · prepare_authorized · revoked | an explicit event (`authorizePrepare`), refused unless the response is accepted/modified | never a send/post/pay authorization — those stay on the execution record (`pending_actions.approve`) |
| `execution` | none · proposed · executed · failed, with `refs[]` by kind and id | the consumer (`recordExecution`), refused before preparation is authorized | never a copy of the execution record's content |
| `outcome` | null until MEASURE writes it | later | — |

Objective *disposition* is not reused; only the actor model, append-only events and the reconciliation vocabulary are. `decline` closes the record; `defer` does not.

## 5a. The withdrawal rule — exact, and the smallest that preserves history (added 26 Sep)

A Recommendation is **ungoverned** while nothing but the Brain has touched it: `response none`, `authorization none`, `execution none`. It is **governed** the moment any of those is not `none` — an athlete response (accept, modify, defer; decline closes it outright), a preparation authorization, or an execution record.

| a later Brain run says… | on an **ungoverned** open Recommendation | on a **governed** open Recommendation |
|---|---|---|
| the same judgment | `reaffirmed_by_run` / `reworded_by_run` (no row) | the same (no row) |
| a different RECOMMEND | `superseded` (closed, `supersededBy`) + new record | `reconsidered_by_run` recorded on it; **nothing closed, nothing rewritten**; the new record carries `reconsiders: <old id>` |
| NO_ACTION or REQUEST_INTELLIGENCE | `withdrawn_by_run` (closed) | `reconsidered_by_run` recorded on it; open, history intact |

Only a Recommendation the Brain alone has produced can be undone by the Brain alone. Once governance or execution has occurred, a later evaluation **records a new strategic relationship** on the governed record and, if it recommends differently, creates a new record that reconsiders it — the athlete's response, the authorization and the execution history are never rewritten, and nothing in motion is closed by intelligence. Reconsideration of the intelligence does not rewrite governed history, the same lesson as Objectives. Implemented as `isGoverned()` and the branch in `reconcileRun`; tested for the five cases the review named (proposed → NO_ACTION withdrawn; accepted → NO_ACTION reconsidered; prepare-authorized → REQUEST reconsidered; execution proposed → NO_ACTION reconsidered; executed → contrary RECOMMEND reconsidered with a new record that reconsiders it) plus the same-judgment case on a governed record. No lifecycle machinery beyond one predicate and one event.

## 6. Direct-action routing

`execution_path` is read off the Recommendation; for `direct_action` on a `deal` subject the consumer is Deals. No entity, no table; `executionIntentFrom` refuses any other path or subject kind.

## 7–8. The exact payload crossing into Deals, and the existing surface that consumes it

`server/services/dealsExecutionSeam.ts` (outside `intelligence/`):

```
ExecutionIntent (execution-intent/0.1.0-exp)
  recommendationId   rec_…
  subject            deal[<id>]           ← exactly as the Brain cited it; Deals reads the id from it and never re-derives the subject
  dealId             <id>
  intent             accept | counter | ask_terms | decline | wait
  why                the Brain's rationale, verbatim — for Mila to explain, not an instruction to Deals
  considerations     the cited lines that bear on the terms: deal[<id>].absent · .unknown · .exclusivity · .risk · .thread, and not_seen[] — what to raise, never what to demand or for how much
  constraints        cited constraints[…]
  objectiveIds
```

Deals consumes it through the route that already exists, `POST /api/v1/me/deals/:id/draft`, with the body the seam derives — `reply_intent` (Deals' own map: counter→`negotiate`, ask_terms→`request_terms`, accept, decline; `wait`→ no draft), `selected_terms` (the considerations, for negotiate/request_terms), `style`, `voice`, `include_media_kit`. Inside that route Deals does everything it does today: `draftPrompt` computes the only figure the model may state (`max(floor, mid)`, gated), scrubs the floor from the score's terms, lints, regenerates or refuses; `generateDealDraft` writes the draft. **No amount crosses** (`seamCarriesNoAmount`, tested); the map from strategic intent to reply intent lives in Deals' seam module, not in the Brain.

## 9. The pending-action / approval path

Unchanged: Deals proposes `send_reply` (propose-at-tap, `pending` → `approve` executes once → `sendThreadReply` behind `sendGate`, `expires_at`, `result`/`error`). The seam supplies the proposal body: `{ kind: "send_reply", payload: { body: <draft>, recommendation_id, subject } }`. Only `payload.body` is read at execution (`routes/pendingActions.ts`), so the lineage keys ride in the free jsonb **with no column**, which answers decision 9 for this slice.

## 10. Idempotency / duplicate prevention

Three layers, none new: the judgment key + `sameJudgment` (a rerun reaffirms or rewords, never re-creates); the consumer's own guarantee (`pending_actions` executes once from `pending`; a second proposal for the same Recommendation is visible through `execution.refs`); and EXISTING WORK, through which a later Brain run sees a negotiation in motion and does not recommend the same step twice (1B/1C).

## 11. Subject-reference preservation

`deal[<id>]` is the request's `about`, the Recommendation's `subject`, the intent's `subject`, the route's `:id`, and the pending action's `payload.subject`. Tested end to end in the seam tests; the reconciliation test asserts the subject survives supersession.

## 12. Lineage

`recommendationId` → `pending_actions.payload.recommendation_id` → the sent reply → `deals.status` / dispositions / payments. The Recommendation's `execution.refs` holds `{kind: "pending_action", id}`. MEASURE/LEARN can pair judgment with outcome by that key; nothing else is added.

## 13. New fields actually required

**None on any table.** The Brain output gains `intent` (0.7.0). The pending-action payload gains two keys inside existing jsonb. The Recommendation ledger is a file.

## 14. Existing structures reused

The draft route and `draftPrompt`; `pending_actions` and `sendGate`; the `intelligence_ledger` RECOMMENDATION shape; the Objective ledger's actor/event/reconciliation vocabulary; `SubjectRef`; the response schema; the two gates.

## 15. Tests

`recommendation.test.ts` (4): create → reaffirm; NO_ACTION/REQUEST create nothing and withdraw an open one; different intent supersedes with the subject preserved; evidence and wording are not identity (reaffirm / reword / supersede on routing change); response ≠ authorization ≠ execution, in order, with refusals. `dealsExecutionSeam.test.ts` (4): subject unchanged, considerations and constraints, no amount; the draft-route mapping is total and `wait` yields no draft; lineage in the payload; refusals (non-direct, non-deal, no intent). `evalSpec070.test.ts` (4): text, gate on requested and standing decisions, schema branch. Grounding tests updated for the alias removal; parity repinned. **10 suites, 245 tests, green; `tsc` clean.**

**Offline reconciliation over six recorded runs** (`brainRecommend.ts`; A0 → A3-2 → A3-3 → 0.6.0 S1 → 0.6.1 C2 → 0.6.0 G0): 6 records, 4 open. A0's *accept* → A3-2's *counter* superseded (different judgment); A3-2 → A3-3 also superseded, **because pre-0.7.0 runs carry no intent and the wording is the only signal** — the exact gap the intent field closes; the three standing plans reworded on every run, never duplicated; every NO_ACTION and REQUEST created nothing; S1's and C2's requests created nothing. The one open commercial record (A3-3, pre-0.7.0) is **refused at the seam** — "no typed intent on a commercial RECOMMEND; Deals does not reinterpret prose" — which is the slice behaving as designed on old data. **Regate under 0.7.0:** 0.6.x artifacts unchanged except 0.6.0 C2, which now also fails the intent rule (a RECOMMEND on a deal without one); pre-0.6 artifacts fail grounding on their `work[…]` cites, the promised effect of closing the alias.

## 16. What one provider experiment would prove that deterministic tests cannot

Exactly one thing: **whether the Brain emits a typed `intent` consistent with its `what` and `why`** (the review's question 1). Everything else in questions 2–10 is now shown offline: one Recommendation per reconciled judgment (2), the subject preserved (3), routing (4), consumption without prose reinterpretation (5), all HOW including the amount in Deals (6), propose → authorize → execute-once (7), no duplicates on rerun (8), lineage without a column (9), nothing moved upstream (10). The proposed experiment, when approved: the existing A3 cell (the R2 term sheet, D2k question) and the 0.6 S1 cell under 0.7.0, once each, reading `intent` against `what`/`why` and against the gates; then the reconciliation of those two real 0.7.0 outputs into the file ledger and the seam payload each would produce. No draft call in that experiment; Deals' HOW is exercised only as far as the route inputs, which is what §17.3 of the previous checkpoint needs to be decided separately.

## 17. Not done

No provider call. No materialisation. No mounting. No Deals / State / Campaign / Studio change. Nothing on the deferred list.
