# C2 athlete-mediated acquisition slice — dry checkpoint (Brain 0.8.0-exp)

**Status:** implemented on the experimental harness and exercised **deterministically only**: fixture evidence, no provider call, no athlete asked, no DB write, nothing materialised (the request ledger is a JSON file under the artifacts). No mounting, no Recommendation materialisation, no Deals / Rate / State / Campaign / Studio / brand-relationship change, no repeatability run. #608 is the Context Intelligence control; #570 untouched.

**Decisions this rests on (26 Sep, #633 review):** Intelligence Request identity = decision + need; typed `need` emitted by the Brain and gated, closed, corpus-derived, experimental; ONE PROPOSITION, ONE NEED; `source_class` is restatable authority outside identity; `demonstrated_valuation` retained and provisional; the resolution invariant unchanged; StartX1 R1 open, no backstop applied yet.

**Forcing case:** the recorded 0.6.1 C2 run — the agent asks whether to advance, counter or accept Lumen's term sheet for Ronaldo; the Brain answers REQUEST_INTELLIGENCE, "a defined rate card or minimum floor price has been set by the athlete or agent for endorsement deliverables", `athlete`, citing `.range` and `.band` NOT_ESTABLISHED. Walkthrough and ledger: `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/acquire-c2/`.

---

## 1. The amended experimental contract

**Brain 0.8.0-exp** (ceremony followed; digest `ffe8cda2…`): every REQUEST_INTELLIGENCE — on a live Objective, a requested decision, or a deferred entry — carries one `need` from the closed list; a missing, unknown or multi-valued need is refused at Gate 1; a need on a non-request is refused; the response schema requires it on the REQUEST branches. The text adds ONE PROPOSITION, ONE NEED and the sentence that `demonstrated_valuation` is never a way to establish what an athlete "should command". Prose is never split by code: the Brain emits the separation; the gate checks the single value. Recorded artifacts (0.6.0 S1, 0.6.1 C2, 0.7.0 A3's deferred entry) now re-gate as refused for the missing need — the expected effect of the amendment on pre-0.8.0 output.

**Intelligence Request** (`brain/intelligenceRequest.ts`, `intelligence-request/0.1.0-exp`): `id · key · decision {source, subject, question} · need · proposition (current) · whyMaterial · sourceClass (current) · raisedBy {runId, spec, at} · runs[] · acquisition {mechanism, ref, chosenBecause, at, completedAt, producedEvidence} | null · evidenceRefs[] · reconsideredInRun · obsolete · events[]`. No `status` field exists on the record: status is a function (§9). Identity `key = sha(source, subject, question, need)`.

## 2. The need vocabulary, and 3. the provisional marking

`counterparty_terms · counterparty_profile · athlete_commercial_basis · existing_constraints · deal_obligations · deliverable_readiness · athlete_capability_intent · demonstrated_valuation` — `NEEDS` in `contract.ts`, with `PROVISIONAL_NEEDS = ["demonstrated_valuation"]` and the contract comment stating the A/B distinction: a legitimate question about what comparable commercial evidence exists, versus a disguised attempt to manufacture a basis from stature; if the corpus later shows the latter, it is retired or redefined by a versioned change. The resolver's mechanism map for it is deliberately narrow (`connected_read`, `contract_extraction` — her own history), never research.

## 4. Request reconciliation (A)

Raised once from the recorded run (the need is a **fixture annotation**, stated as such — the 0.6.1 run predates 0.8.0 and emitted none). Then, tested: a reworded proposition → `restated_by_run`, one request; a changed `source_class` (athlete → connected) → `restated_by_run`, one request; the same again → `reaffirmed_by_run`; a different need on the same decision (`existing_constraints`) → a second request; the same need on a different decision (the D3 question) → a third; two entries for a compound gap (`counterparty_terms` + `counterparty_profile`) → two requests, never one; an unknown need → refused, never filed under a guess.

## 5. Resolver input and output for C2 (B)

Input, from the probe's real facts: no connected accounts, no thread for the controlled subject, no contract document, a structured offer, **no floor stated for the type**, research runs exist (`researchBudgetAvailable: true`), no existing evidence.

Output: `mila_question`, with the plan recording why — the need can be established by `preferences_form · mila_question · document_request` (its corpus-derived mechanisms); authority required `athlete`; all three available; chosen by lowest athlete burden within the class (a question in her flow before a form she must navigate before a document she must supply). **`source_class: athlete` did not select the mechanism**: the same request with a floor already stated resolves to *no acquisition* ("already held"); the same need at `connected` authority with a connected thread resolves to `connected_read` before any question to her; a `counterparty_profile` need at `athlete` authority resolves to *none* because research cannot satisfy athlete authority. The ordering is experimental and every choice writes its reasons on the plan.

## 6. The existing Mila mechanism (C)

An `await_human` workflow step: born `waiting`, parked until completed through the one door (`POST /workflow/runs/:id/steps/:step/complete`, reached by the chat tool, the voice route, or a form), exactly as onboarding's `greet` step is today; its `complete` writes through `recordAssertions` → `athlete_asserted` with a reversible `profile_write` receipt. The request id rides in the step's free `input` (`StepCtx.input`) — **no column**.

## 7. The acquisition payload

```
{ asks: "intelligence_request", request_id: "req_a0be3b1b7b2ea481", need: "athlete_commercial_basis",
  question: "For an ambassador deal like Lumen's, what's the least you'd accept — and per what: per post, per month, or for the whole term?",
  fields: ["amount", "currency", "per"], why: <the Brain's why_material, verbatim> }
```

The smallest thing that asks: what is needed, why, and the fields the answer must carry. "Per what" is asked because the deferred unit item says a floor without a unit cannot be compared; asking it does not solve that item.

## 8. The simulated athlete answer, as the existing path would persist it (D)

```
athlete_asserted { id: aa-fixture-1, athlete_id: <Ronaldo>, field: "commercial_basis.ambassador",
  value: { amount: 25000, currency: "USD", per: "month" }, said: "For something like this I wouldn't go under twenty-five thousand a month.",
  source: "mila", mode: "chat", run_id: "wf-<runId>", agent_action_id: "<profile_write receipt, reversible>", created_at: 2026-09-27T10:12:00Z }
```

Provenance sufficient for the rule: the athlete supplied it (`source: mila`, `mode: chat`, the receipt); which acquisition produced it (`run_id` = the workflow run that carried the request id); when (`created_at`); what it asserts (`field`, `value`, `said`). The evidence reference the request records is `{store: athlete_asserted, id, at, sourceClass: athlete, need, attributedTo: <request id>, asserts}`. Nothing about Rate semantics is claimed solved.

## 9. The derived evidence rule, and 10. every negative control (E)

`deriveStatus(r)` = `obsolete` if marked; else `evidenced` iff some `evidenceRefs[]` entry is `attributedTo === r.id`, `need === r.need`, of authority ≥ `r.sourceClass`, and `at > r.raisedBy.at`; else `acquiring` if an acquisition is pending; else `open`. `informationAvailable(r)` = `evidenced`. **No writer exists**: the record has no status field (tested).

| control | counted? | reason recorded | status |
|---|---|---|---|
| a new inbound from Lumen on the same deal, not attributable | no | not attributable to this request's acquisition | acquiring |
| the same assertion, dated before the request | no | predates the request | acquiring |
| research evidence (external) about peers' rates, attributed to the request | no | class external below required athlete | acquiring |
| an attributable athlete assertion for a different need (`existing_constraints`) | no | attributable, but for a different need | acquiring |
| acquisition completed, nothing established | — | `acquisition_completed_without_evidence` recorded | open |
| **the fixture answer**, attributable, athlete class, after the request | **yes** | attributable, right class, after the request | **evidenced** |

The label is addressing; the evidence is proof: the rule checks attribution, class and time structurally and records what the evidence asserts; whether it *establishes* the need is the Brain's to judge on reconsideration — it may request again with the evidence citable.

## 11. Reconsideration eligibility (F)

`evidenced` → `eligibleForReconsideration` true. No Brain invoked, no decision created, no Recommendation. `attributeReconsideration(r, runId)` is the one-attribution bound: after one run is attributed, eligibility is false and a second attribution is refused; the request stays `evidenced` and its history stays. Eligibility is a state a run reads, never a trigger that calls one.

## 12. Duplicate prevention (G)

A restated request (new wording, class athlete → connected) on the same decision + need is the same request; starting an acquisition while one is pending is refused ("already pending"), and after evidence is refused ("already evidenced — never re-acquired"). The athlete is never asked twice.

## 13. Obsolescence (H)

The question parked, the brand withdraws: `markObsolete` records why, cancels the pending acquisition (`completedAt` set, `producedEvidence: false`), keeps every event. A late answer is still counted as evidence about her — it is real — but the status remains `obsolete`, eligibility is false, and no new acquisition may start: nothing resurrects the decision automatically.

## 14. New fields

**None on any table.** `need` on the Brain's REQUEST output (0.8.0). The request id rides in a workflow step's free input. The request ledger is a file.

## 15. Structures reused

`await_human` steps and their single completion door; `recordAssertions` / `athlete_asserted` provenance and receipts; the probe's capability facts; the eight-kind vocabulary from the corpus; the Recommendation reconciliation vocabulary (reaffirm / restate) for the request's history; the response schema and both gates.

## 16. Tests

`intelligenceRequest.test.ts` (10): identity and reconciliation incl. compound needs and the vocabulary refusal; the C2 resolver choice and its three counter-cases; the payload; open → acquiring → evidenced with `information_available` derived; the five negative controls; no status field; eligibility with the one-attribution bound; duplicates while pending and after evidence; obsolescence with a late answer. `evalSpec080.test.ts` (4): text, gate on all three request places incl. the multi-value refusal, non-request refusal, schema. Parity repinned. **12 suites, 271 tests, green; `tsc` clean.** Dry walk: `brainAcquire.ts` over the real 0.6.1 artifact and the real probe.

## 17. What remains unproved without a real provider, user or acquisition

1. **Does the Brain emit a `need` consistent with its proposition?** The same question as `intent`, answerable by one call on a REQUEST cell (C2 or S1) when approved.
2. **Does a real athlete answer, through the real `await_human` door, arrive with the provenance the fixture assumes?** The onboarding step proves the door; a step whose `complete` writes a `commercial_basis.*` assertion is not built. Needs one real parked step on dev with a tester, not a fixture.
3. **Does the reconsidering run cite the assertion and decide?** Depends on where the floor's unit lands (the deferred Rate item); one call after that is settled.
4. **Does the resolver's burden ordering hold on real cases** where a form, a document and a question are all available? Observational, once requests exist.

## 18. Not done

No provider call, no athlete interaction, no materialisation, no mounting, no Recommendation materialisation, no Deals / Rate / State / Campaign / Studio / brand-relationship change, no StartX1 backstop, no repeatability run. #608 and #570 untouched.
