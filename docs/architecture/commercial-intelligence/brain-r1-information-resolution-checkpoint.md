# R1 — deferred information conditions obey the evidence discipline: design/reliability checkpoint (Brain 0.8.1-exp)

**Status:** designed from the repo and the recorded runs; the generic Gate-2 rule and the positive-control projection are implemented on the experimental harness and exercised **offline only**. No provider call, no athlete interaction, no materialisation, no mounting, no Recommendation materialisation, no Deals / Rate / State / Campaign / Studio / brand-relationship change, no repeatability run. #608 is the Context Intelligence control; #570 untouched. **No StartX1-specific rule exists anywhere in the change.**

**The task:** make deferred information conditions obey the same evidence discipline as Intelligence Requests — Brain names a missing need → attributable acquisition → qualifying evidence → `evidenced` → reconsideration eligibility — without retroactively turning historical deferrals into requests.

---

## 1. Reconstruction of every recorded false resolution

The backlog counted four; the artifacts hold **five** (the fourth and fifth were #623 A1 *and* A2, listed together). All five are the same deferral: StartX1, kind `information`, her words "When u know more about this", proposal "She has an active, fully executed commercial partnership with StartX1."

| run · spec | gated? | research blocks supplied | what the Brain cited for `CONDITION_APPEARS_RESOLVED` | anything new? | any acquisition? | attributable evidence under 0.8 semantics? |
|---|---|---|---|---|---|---|
| 1B.3 D1 · 0.3.0 | yes | 0 | `deferred[…]`, `commercialPosition.inbound[3]`, `[6]`, `[9]` (StartX1 inbounds of 14, 4 and 2 Sep), `opportunity[amplify-inbound-startx1-interest]` | no — the three signals predate the deferral and are identical in every run | none | none — nothing carried a request; no research block; no assertion |
| 1C K2 · 0.3.1 | yes | 0 | `inbound[3]`, `[6]`, `[9]`, the opening | no | none | none |
| #623 A1 · 0.4.0 | no (ids) | 0 | `deferred[…]`, `inbound[3]`, `[6]`, `[9]` | no | none | none |
| #623 A2 · 0.4.0 | yes | 0 | `inbound[3]`, `[6]`, `[9]`, the opening | no | none | none |
| 0.6.0 S1 · 0.6.0 | yes | 0 | `deferred[…]`, `inbound[3]`, `[6]`, `[9]` | no | none | none |

The other 41 deferred entries across the same runs answered REQUEST_INTELLIGENCE (39) or were structurally refused; none of them is affected by anything below.

## 2. The current deferred-condition semantics, traced

| piece | where | what it does today |
|---|---|---|
| the condition | `objectives.deferral {kind: information \| time \| athlete, said, after?}` (`objectiveEntity.ts` L2); rows deferred before L2 carry none and are read as `information` | stored on the Objective; her words verbatim |
| the resurface rule | `RESURFACE_REASONS = [time_elapsed, athlete, information_available]`; `applyRunEvent("re_surfaced")` refuses `evidence_changed`; **`information_available` has no writer** | nothing re-surfaces an information deferral automatically |
| the signal | `reaffirmed_by_run` may carry `evidenceChanged: true` on an information deferral and "moves nothing" | evidence change is a signal, never a trigger |
| the Brain's output | `BRAIN_DECISION_BLOCK` FOR EACH DEFERRED OBJECTIVE: REQUEST_INTELLIGENCE · CONDITION_APPEARS_RESOLVED ("your observation only. It changes nothing") · NO_REQUEST | vocabulary only |
| Gate 1 | `validateDeferredDecision`: enum, `why`, cites, the REQUEST fields | nothing about what a resolution must cite |
| Gate 2 | `check(deferred[i], allowDeferredRef: true, mustCiteBeyondObjective: false)` | every cite must resolve; **no rule about which evidence can ground a resolution** |
| reconciliation | `objective/reconcile.ts` reconciles *proposals*; no Brain output is written to the Objective ledger by the harness | the flag has no consumer |

**The defect is two things, and the artifacts show which.** *Prompt semantics:* "what you were shown appears to answer her condition" invited the Brain to read three old inbound signals as an answer to "I don't know enough about StartX1". *Missing grounding rule:* Gate 2 accepted any resolving cites. Attribution was not missing because it was not yet defined for deferrals — that definition is what 0.8 supplied for requests and this checkpoint extends. Not stale vocabulary: the three deferral kinds and the three resurface reasons are right; the writer for `information_available` was deliberately left absent until this discipline existed. The flag has been harmless so far only because nothing consumes it; the first writer would have re-surfaced StartX1 five times.

## 3. One generic failure model

> The Brain treated **evidence about the same subject** as **evidence responsive to the missing information**, with no acquisition, no attribution, and nothing newer than the deferral.

## 4. The invariant

> **A deferred condition whose reason is missing information cannot appear resolved merely because new evidence exists about the same subject. Resolution requires evidence responsive to the missing information need — attributable to an acquisition raised for that condition.** For a post-0.8 request that is the Intelligence Request's `evidenced` state; for a deferral the Brain reads, it is a RESEARCH entry requested for that Objective. Nothing else counts.

## 5. Three concepts, kept apart

| concept | what it is | where it lives | can it resolve an information condition? |
|---|---|---|---|
| **new evidence exists** | anything newer in State, a thread, a signal, an opening | State, lenses, context | **never** — a signal, never a trigger (L2's rule, unchanged) |
| **responsive evidence is available** | attributable, right-class evidence produced by an acquisition for this need, after the request | `IntelligenceRequest.evidenceRefs` → `evidenced`; projected as `research[<n>]` with `requestedBy.objectiveId` | **yes** — it makes the condition eligible (§11); it is what the Brain may cite |
| **the proposition is established** | the Brain's judgment on reconsideration, with the evidence citable | a Brain run; it may request again | not a state; never authored; never inferred from a label |

StartX1 used the first as a proxy for the second. 0.8's terminology caution already forbids using the second as a proxy for the third.

## 6. The fate of `CONDITION_APPEARS_RESOLVED`

Evaluated: **A — keep it, with Gate 2 requiring responsive evidence — adopted.** B (retie its semantics to request evidence) is what A does in practice: the only admissible cite *is* an evidenced request or a targeted-research answer. C (allow only for non-information deferrals) would silence the one legitimate case — the positive control — and leaves `athlete` deferrals wrongly callable. D: a smaller option exists for a later bump — drop the value from the vocabulary altogether, since `information_available` is now *derived* from an evidenced request and the Brain's observation is redundant; not done now, to avoid contract churn while the rule is exercised. No new state machine.

## 7. Legacy compatibility

Pre-0.8 information deferrals have no typed `need`, no request id, no evidence refs. Under the rule they **stay deferred**: nothing about them is inferred from their words. They return through the paths that already exist — her `revisit`; a later Brain run emitting a typed REQUEST_INTELLIGENCE on the deferred entry (0.8 requires a `need` there too), which raises an Intelligence Request whose evidence, once `evidenced`, projects into RESEARCH for that Objective and makes `information_available` derivable; or time, for `time` deferrals. No historical `need` or request id is fabricated from prose. Safety over auto-resolution, as required.

## 8. The Gate-2 backstop, exactly (`grounding.ts`, `resolutionProblem`; 0.8.1-exp)

- **Preconditions:** a `deferred[]` entry with `decision: CONDITION_APPEARS_RESOLVED` whose `objective_id` is a rendered deferral.
- **Kind `athlete`:** refused — "only her revisit brings it back".
- **Kind `time`:** untouched (the passage of time is the system's to observe; the entry stays prose-governed).
- **Kind `information`, or no deferral recorded** (read as information): admissible only if at least one cite is `research[<n>]` and `inputs.research[n].requestedBy.objectiveId === objective_id`. Everything else — the deferral itself, `commercialPosition.inbound[…]`, any State path, `opportunity[…]`, `deal[…]`, `ctx[…]`, a research block requested for another Objective — is refused with the reason listing what was cited.
- **What it permits:** a resolution grounded in a targeted-research answer requested for that Objective (the existing `targeted-research/0.1.0` shape) or an evidenced Intelligence Request projected into that shape (`evidencedRequestAsResearchBlock`).
- **False-positive risks:** a legitimate answer that reached State (an athlete assertion written by the acquisition) but was not projected into RESEARCH would be refused — the projection is therefore part of the reconsideration contract, not optional; a `time` deferral the Brain calls resolved early is not caught (prose); a research block requested for the Objective whose *content* does not establish the proposition passes the gate — by design, establishment is the Brain's (§5).
- **Refuses, never repairs.** Recorded on the run's grounding problems like every other Gate-2 refusal.

**Offline regression:** four of the five recorded flips (D1, K2, A2, S1) are refused by this rule ("CONDITION_APPEARS_RESOLVED on an information deferral without responsive evidence — it cites commercialPosition.inbound[3], …"). The fifth, #623 A1, was a set Gate 1 had already refused for wrapped identifiers, so its deferred id matches no rendered deferral and the rule does not run on it; with its id read plain, the same entry — identical cites — is refused by the rule (verified offline). The 41 REQUEST/NO_REQUEST deferred entries across the same artifacts gain no resolution refusal; every 0.6.0+ artifact is otherwise unchanged (the pre-0.7 artifacts also show the expected `work[…]` alias-closure refusals, unrelated).

## 9. The positive control

`intelligenceRequest.ts` → `evidencedRequestAsResearchBlock(request, objectiveId, run)`: an **evidenced** request (attributable, right class, after the request — the 0.8 rule) projects into the existing RESEARCH-block shape with `requestedBy.objectiveId` carrying the attribution; an unevidenced request projects nothing. Test: a `counterparty_terms` request on the StartX1 deferral, resolved to `ask_for_terms`, the brand's reply arriving as an attributable `inbox_messages` reference → `evidenced` → projected → a `CONDITION_APPEARS_RESOLVED` citing `research[0]` **passes both gates**. A wrong-class reply (external research for a connected request) never becomes evidenced, projects nothing, and so never reaches the gate.

## 9a. `research[…]` is the responsive-evidence projection, not a provenance claim (recorded 26 Sep)

In this boundary the RESEARCH block functions as the **Brain-visible responsive-evidence projection**. The positive control originates as *brand reply → attributable `inbox_messages` evidence (connected) → evidenced Intelligence Request → projection into the existing `targeted-research/0.1.0` shape*. The envelope is reused because it already carries `requestedBy.objectiveId`, which is exactly the attribution the Gate-2 rule checks. The brand reply does **not** thereby become "research" in provenance: the projected block names each reference's store, id, class and time, and the underlying evidence keeps its own provenance. Not renamed or redesigned now; recorded as naming/schema pressure if non-research evidence classes routinely project through it.

**Reviewed after the paired experiment (27 Sep):** the provider read the envelope name as provenance once (P cell, a controlled inbox reply described as "research"). Naming/schema pressure confirmed; not enough to rename. Standing rule: `research[...]` never erases or rewrites the underlying provenance (`inbox_messages`, athlete assertions, connected data, documents); each projected reference keeps its store, id, class and time. If this repeats across evidence classes, a neutral Brain-visible evidence projection may be considered. No change now.

## 10. Non-information deferrals

The vocabulary already separates the three things a deferral can be: `information` ("I don't know enough"), `time` ("later", with `after`), `athlete` ("I'll come back to it"). "Waiting for counterparty action" and "waiting for work completion" are not deferral kinds — they are NO_ACTION grounds on a *live* Objective (0.2.0's widened NO_ACTION: work in flight, waiting on an external response), which is where the Brain has correctly put them since 1B. No waiting ontology is needed; the rule applies to `information` only, refuses `athlete`, and leaves `time` alone.

## 11. Reconciliation — what a legitimate resolution does

Nothing by itself. The admissible `CONDITION_APPEARS_RESOLVED` remains "observation only". What *moves* is derived: an evidenced Intelligence Request for the deferral's decision makes `information_available` true (0.8, derived), which is the one system reason the Objective ledger already admits for `re_surfaced` — the deferral is removed, the Objective returns to `unreviewed`, **the athlete reviews it**; the deferral's events and her words survive on the ledger. No Objective is created, no Recommendation is created, the strategic answer is not implied. Checked against the three models: Objectives (re-surface → her review), Recommendations (a later RECOMMEND on that decision reconciles under the withdrawal rule), Intelligence Requests (one attribution per evidenced request).

**Correction (27 Sep, evidence→reconsideration checkpoint):** the sentence above overstated what the derived status moves. An evidenced request makes the blocked decision *eligible for reconsideration*; the Objective returns to her review only when a gated reconsidering run observes `CONDITION_APPEARS_RESOLVED` citing that request's projection (option B). `information_available` remains the reason on the event; the judgment remains the Brain's; the decision remains hers. See `brain-evidence-reconsideration-checkpoint.md` §4–5. Option D in §6 (drop the value) is withdrawn.

## 12. Tests

`resolution.test.ts` (6): the recorded failure class refused (and the legacy no-deferral row read as information, refused); unrelated new evidence and a research block for a different Objective refused; wrong authority never reaches the gate (unevidenced → no projection); the positive control allowed; `athlete` refused and `time` untouched; REQUEST and NO_REQUEST on the deferral unaffected, history untouched by the gate. Parity repinned (`468d8790…`). **13 suites, 278 tests, green; `tsc` clean.** Plus the offline regate over the five flips and the surrounding artifacts (§8).

## 13. The contract amendment (0.8.1-exp, by ceremony)

One paragraph added to the DEFERRED block, verbatim: *"For an information deferral it is admissible only when you cite RESEARCH that was requested for that Objective — evidence responsive to what she said she needed to know. New evidence about the same subject (an inbound, a signal, an opening) is not responsive evidence, and a deferral she marked as her own to revisit is never yours to call resolved."* No vocabulary change, no new field, no new state.

## 14. Structures reused

The Objective deferral kinds and `RESURFACE_REASONS` (L2, unchanged); the `targeted-research/0.1.0` block and `requestedBy.objectiveId`; the Intelligence Request `evidenced` derivation; Gate 2's existing `check`; the Objective ledger's `re_surfaced` with `information_available`.

## 15. What remains empirical / provider-dependent

1. Whether the Brain, given a projected responsive research block on the StartX1 deferral, emits `CONDITION_APPEARS_RESOLVED` citing it (the positive control on a live call) — one call, when approved.
2. Whether it still emits the flip on unchanged evidence under the amended text, or now emits REQUEST_INTELLIGENCE with a `need` (the negative case live) — the same call answers it.
3. The first real writer of `information_available` — the acquisition path (the deferred real-`await_human` boundary), not this checkpoint.

## 16. Not done

No provider call, no athlete interaction, no materialisation, no mounting, no writer for `information_available` built, no StartX1-specific rule, no Deals / Rate / State / Campaign / Studio / brand-relationship change. #608 and #570 untouched.

---

**Closure record (27 Sep 2026).** The paired live experiment was run once per cell under 0.8.1-exp — `docs/audits/brain-0.8.1-exp-r1-paired.md`. N (historical evidence only): REQUEST_INTELLIGENCE, need `counterparty_profile`, no false resolution, both gates 0. P (responsive projected block for the same Objective): CONDITION_APPEARS_RESOLVED citing `research[0]` and nothing incidental, Gate 2 admits it. **R1 / deferred-information evidence discipline is closed at the experimental level.** The `information_available` writer and the real acquisition path remain unbuilt.
