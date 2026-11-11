# Decision-relative materiality (1B.3) — audit (D1, D2, D3, D2k under spec 0.3.0-exp)

**Owner:** Mia
**Date:** 2026-09-26
**Design:** `docs/architecture/commercial-intelligence/brain-decision-relative-materiality.md` (approved with the isolation change; "this opportunity" → "this negotiation" in D2/D3/D2k before the run).
**What ran:** `brain-eval-spec/0.3.0-exp` (digest `537d2a97…`), four calls once each, no tuning or rerun. The only substantive new variable is the `DECISION REQUESTED` block. Overlays byte-identical to 1B (R3 for D1–D3, R2 for D2k); context, State discipline, map, model, renderers unchanged; no `unknowns[]`, no new gate. Artifacts: `docs/audits/artifacts/brain-context-experiment-1/1b3/arm/D1..D2k.json`; prior artifacts untouched. **Nothing materialised. StartX1 untouched. No Stage-2 research, no connected read.**

**Headline.** Identical evidence under different explicit questions produced different decision-relevant information, and the differences track the question. Under the portfolio question (D1) the negotiation's existence was sufficient and no commercial fact was treated as needed. Under the agent's question (D2) the Brain asked for compensation, contract length and deliverables, and did not mention exclusivity. Under the athlete's question (D3) it asked for exclusivity — including a real, grounded conflict candidate, her Adidas contract — and did not mention compensation. With the terms present (D2k) it recommended accepting, connecting the offer to two of her floors from State by arithmetic, and requested nothing. **That is decision-relative materiality, observed from the emitted rationale, propositions and citations alone.** The standing per-Objective loop produced NO_ACTION on positioning in all four runs, as it had in S3 twice: the decisions D2 and D3 surfaced are ones the loop never posed in fifteen runs. **One unsupported flip to record:** in D1 the deferred StartX1 entry became `CONDITION_APPEARS_RESOLVED` with no new evidence.

---

## 1. Gates, usage, cost

| run | request | overlay | tokens in / out / thought | latency | cost | gate 1 | gate 2 | output |
|---|---|---|---|---|---|---|---|---|
| D1 | the portfolio loop · objective[positioning] | R3 | 12,666 / 1,885 / 6,221 | 37.9 s | $0.024 | pass | pass | accepted |
| D2 | her agent, through Mila · work[northlight-open] | R3 | 12,642 / 1,607 / 7,513 | 43.8 s | $0.027 | pass | pass | accepted |
| D3 | the athlete, through Mila · work[northlight-open] | R3 | 12,641 / 1,677 / 7,928 | 45.7 s | $0.028 | pass | pass | accepted |
| D2k | her agent, through Mila · work[northlight-termsheet] | R2 | 12,704 / 1,947 / 8,142 | 49.4 s | $0.029 | pass | pass | accepted |
| **total** | | | | | **$0.108** | | | |

Prompts 51,258–51,364 chars; the request block is 289–309 chars. Digest identical in all four. No format refusals.

## 2. The requested decisions, preserved

| run | decision | as emitted |
|---|---|---|
| **D1** | **NO_ACTION** | "Active negotiation with EdTech company Northlight Learning has been in flight since September 19, 2026. Because this active negotiation directly covers the desired tech/academic partnership positioning, initiating redundant additional work is not warranted now." · cites `request[D1]`, `work[ctl-r3-northlight-open]`, `opportunity[grow-academic-tech-partnerships]` |
| **D2** | **REQUEST_INTELLIGENCE** · `connected` | proposition: "The proposed compensation, contract length, and specific deliverables for the Northlight Learning offer have been provided." · why_material: "Without these terms, we cannot evaluate the offer against her representation floors or market value to make a sound decision on whether to accept, counter, or advance." · cites `work[ctl-r3-northlight-open]` ("amount, terms, and deliverables are not recorded"), `request[D2]` |
| **D3** | **REQUEST_INTELLIGENCE** · `connected` | proposition: "The athlete's existing contract with Adidas and her other active negotiations do not contain exclusivity clauses that conflict with a partnership with Northlight Learning." · why_material: "Confirming the absence of exclusivity conflicts is necessary before advising if the Northlight Learning negotiation can safely proceed alongside her other relationships." · cites `request[D3]`, `materialGaps[0]` (Adidas terms confidential), `findings[mia.commercial_proof]` (the Adidas NIL contract), `work[ctl-r3-northlight-open]` ("exclusivity terms… not recorded") |
| **D2k** | **RECOMMEND** · `direct_action` · `advances_existing_work` → `work[ctl-r2-northlight-termsheet]` | "Accept the term sheet from Northlight Learning to secure her first partnership in the academic and EdTech space." · why: the USD 5,000 offer "exceeds both her ambassador floor of USD 3,602 and her individual social post floor of USD 1,000" (cited `representation.floors[socialPost]`: "equates to USD 4,000 for 4 posts, making the USD 5,000 package favorable"), "features no category exclusivity" · `not_seen`: "any verbal feedback or informal communication between her agent and Northlight Learning regarding offer flexibility" |

## 3. The observational materiality matrix

Built from what the Brain emitted — rationale, `not_seen`, propositions, citations — not from any forced enumeration. "—" means the fact was not mentioned at all.

| absent (D1–D3) or present (D2k) fact | D1 · add work toward the Objective? | D2 · advance / counter / accept? | D3 · alongside her other relationships? | D2k · same as D2, terms known |
|---|---|---|---|---|
| compensation | — | **material** — requested, "against her representation floors" | — | present; used against two floors, with arithmetic |
| contract length / term | — | **material** — requested | — | present (2026–27 academic year); used |
| deliverables | — | **material** — requested | — | present (four posts); used |
| exclusivity / category | — | — | **material** — requested, with the Adidas contract named as the conflict candidate from State | present ("no category exclusivity"); used — "preserving her ability to secure other tech sponsorships" |
| that the negotiation exists and is active | **sufficient** for the answer | the premise | the premise | the premise |
| informal signals from the counterparty | — | — | — | `not_seen`, not requested |

**Reading.** The same absent facts were treated differently under each question, and the treatment matches what each question turns on: compensation, term and deliverables under "accept or counter"; exclusivity under "alongside her other relationships"; neither under "should Nomila add work". D2 and D3 are complementary rather than overlapping — neither request asked for the other's facts. D2k shows the same commercial decision proceeding once the facts are present, with no information-seeking for its own sake (its one unknown stayed in `not_seen`). Two observations at the margin: D2 did not mention exclusivity, which an "accept" decision arguably also turns on — the Brain scoped its request to the axis the question named; and D2's `why_material` refers to her floors without citing them, whereas D2k cites both floors and computes with them.

## 4. Cross-contamination — the standing per-Objective decisions across the four runs

| standing Objective | D1 | D2 | D3 | D2k |
|---|---|---|---|---|
| **Positioning** | NO_ACTION — negotiation covers it | NO_ACTION | NO_ACTION | NO_ACTION — **cites `request[D2k]`**: "the next strategic step for this objective is covered by the decision on the associated term sheet in request[D2k], meaning no separate intervention is needed here" |
| Yuwa | RECOMMEND · specialized_plan · new_work; **cites `ctx[0]`** "providing operational capacity" | RECOMMEND · specialized_plan · new_work | RECOMMEND · specialized_plan · new_work | RECOMMEND · specialized_plan · new_work |
| Audience | RECOMMEND · specialized_plan · new_work; **cites `ctx[1]`** "a perfect window to establish new content workflows" | RECOMMEND · specialized_plan · new_work | RECOMMEND · specialized_plan · new_work | RECOMMEND · specialized_plan · new_work |

Recorded, not classified as correct or incorrect: decision type, execution path and relation of the standing decisions did not change across D1–D2k. One rationale change is material: in D2k the standing positioning NO_ACTION **defers to the requested decision** — the loop noticed the request and delegated the step to it. Whether a requested decision should participate in portfolio reasoning that way, or stay separately scoped, is exactly the question this check was added to inform. The schedule-gap conversion appeared in D1 only (Yuwa "operational capacity", Audience "perfect window"), the run whose request was NO_ACTION-shaped; absent from D2, D3, D2k. Logged.

## 5. StartX1 across the four runs — one unsupported flip

D2, D3 and D2k: REQUEST_INTELLIGENCE, `connected`, as in every prior run (fourteen of fourteen before this). **D1: `CONDITION_APPEARS_RESOLVED`** — "Since early September 2026, StartX1 has initiated three distinct, highly motivated inbound inquiries in her pipeline, resolving the information gap and providing the material details needed to proceed." The evidence is identical to every other run: three `deal_detected` rows carrying no terms. Nothing was retrieved, nothing new was shown, and the entry asserts that details have been provided. This is the first `CONDITION_APPEARS_RESOLVED` in fifteen runs, and it is unsupported. It changed nothing — no writer exists for `information_available`, and the design says the Brain's observation changes nothing — but it is the concrete case for the recorded invariant: **a future `information_available` writer must not fire on the Brain's say-so; it fires on evidence-as-seen that the condition's question was answered.** Recorded as a reliability finding alongside the 1B format refusals.

## 6. The architectural evidence

- **Identical evidence, different explicit questions → different decision-relevant information surfaced,** in the direction each question turns on. This supports **decision-relative materiality** as a principle, observed without a forced materiality step.
- **D2 and D3 exposed decisions the standing loop does not pose.** In all four runs — and in S3 twice before — the per-Objective loop answered NO_ACTION on positioning, correctly for its own question. The requests for terms and for exclusivity checks came only when those questions were asked. This supports a **decision-request door** into the same Brain for decisions originating from work items, the athlete through Mila, her agent, and eventually events. It is evidence for 1C, not a design of it.
- **The observational surface was sufficient.** The matrix in §3 was built from rationale, `not_seen`, propositions and citations; a structured `unknowns[]` was not needed to audit this run.
- **The control held.** D2k: a bounded action, floors connected by arithmetic from real State, exclusivity read from the term sheet, nothing requested.
- **Within-run controls held on the stable fields** (type, path, relation of Yuwa and Audience unchanged), with one recorded rationale interaction (D2k's standing decision deferring to the request).

## 7. Other observations

- D3's proposition is grounded in real State: `materialGaps[0]` and `findings[mia.commercial_proof]` establish the Adidas contract and that its terms are confidential; the conflict candidate is not invented.
- D2's request is grounded only in the work item and the question; the floors it refers to are not cited.
- D2k cites and uses `representation.floors[socialPost]` for the first time, with a computation (4 × USD 1,000).
- Schedule-gap conversion: two instances, both in D1; logged under the standing finding, no tuning.

## 8. Not done

No tuning, repair or rerun. No spec change beyond 0.3.0-exp as inspected. No Stage-2 research, no StartX1 connected read, no 1C design, no production Brain. What follows is Mia's call: the reading of §6 as the basis for a decision-request door in 1C, and the D1 StartX1 flip as a constraint on any `information_available` writer.
