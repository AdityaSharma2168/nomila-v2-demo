# Decision-relative materiality — experiment design (1B.3)

**Owner:** Mia
**Date:** 2026-09-26
**Status:** approved 26 Sep 2026 with the experimental-isolation change in §3 (no `unknowns[]`, no new gate). Spec 0.3.0-exp implemented through the ceremony; the four blocks rendered for inspection; **no call until inspected**.
**Follows:** `docs/audits/brain-decision-experiment-1b2.md` (S3 under 0.2.1-exp, reclassified below as *ambiguous — premise not established*).
**Principle this experiment tests, recorded here and not yet in any production contract:**

> **Materiality is relative to the decision being made. A fact is not globally material merely because it is commercially important.**

---

## 0. In plain words

Twice now the Brain looked at an EdTech negotiation with no recorded terms and said "leave it, work is already under way". We read that as a failure to ask for the terms. It may instead have been the right answer to the only question the Brain is ever asked — *should Nomila add work toward this Objective?* — a question under which the terms do not matter. Other questions about the same negotiation would make some of those facts matter and others not: *should Northlight be advanced or accepted?* turns on compensation and deliverables; *can Northlight sit alongside her other relationships?* turns on exclusivity and category, not on money. This experiment poses each question explicitly, says who is asking, keeps the evidence identical, and watches whether the Brain names *which* unknown facts matter for *that* decision. It is not trying to make REQUEST_INTELLIGENCE fire.

## 1. Reinterpreting S3, and what is withdrawn

S3's controlled overlay says an EdTech negotiation toward the positioning Objective has been open since 19 September with amount, terms and exclusivity unrecorded. Under both 0.2.0-exp and 0.2.1-exp the Brain answered NO_ACTION: relevant work is under way, her team is handling it. The expectation that this "necessarily had to produce REQUEST_INTELLIGENCE" is **withdrawn**. S3 is **reclassified: ambiguous — premise not established.** We never established that the missing facts were material to the decision the Brain believed it was making, and the outputs are consistent with the Brain answering the per-Objective question the spec poses.

Three decisions the same evidence could serve, and what is plausibly material to each:

| decision | plausibly material | plausibly not |
|---|---|---|
| Q1 · should Nomila initiate additional work toward the positioning Objective now? | that an aligned negotiation exists and is active | its compensation, deliverables, exclusivity |
| Q2 · should the open Northlight opportunity be advanced, countered or accepted? | compensation, deliverables, term, usage, exclusivity — against her floors and the Objective | — |
| Q3 · can Northlight proceed safely alongside her other relationships? | exclusivity, category, term — against gorjana and the seven negotiations whose categories are unrecorded | compensation |

"Appropriate work in flight" is itself ambiguous — progress toward the Objective, commercially attractive, exclusivity-safe, portfolio-aligned, fit to accept — which is why the proposed general-form sentence ("work whose appropriateness you cannot judge…") is **not added**: it would license requesting deal details whenever in-flight work appears, whatever the decision.

## 2. Where the decision question comes from — the thing this experiment makes explicit

In Stage 1, 1B and 1B.1 the Brain was asked one thing, *for each live Objective, what now?*, and silently chose which decision it was solving. That must stop being silent. In Nomila's architecture a decision can be posed to the Brain from four places, and each condition below names one:

| source | what it looks like | condition |
|---|---|---|
| **the portfolio loop** | the Brain's own per-Objective pass — the question the spec already asks, now written out | D1 |
| **her agent, through Mila or the execution path** | "Northlight sent terms / is waiting — what do we do with it?" | D2, D2k |
| **the athlete, through Mila** | "can I take Northlight alongside my other deals?" | D3 |
| **an event** | a reply arrives; a deliverable comes due | not in this experiment |

The question is supplied as a new **experimental input block**, `DECISION REQUESTED`, rendered with: who asked, the question verbatim, and what it is about (`objective[<id>]` or `work[<id>]`). **The block contains the question and nothing else** — no list of facts, no hint of which facts matter, no word like "terms", "exclusivity" or "material". The fixture encodes the decision, never the answer.

## 3. The exact changes relative to 0.2.1-exp — the question is the only substantive new variable

**Experimental-isolation change (Mia, 26 Sep):** the earlier draft proposed a mandatory `unknowns[{fact, material, why}]` in the answer and a gate refusing a REQUEST_INTELLIGENCE without a material unknown. **Both are removed.** A mandatory materiality-analysis step could itself cause a D2/D3 shift toward REQUEST_INTELLIGENCE, and a new gate changes another part of the system at the same time. 1B.3 is the cleanest causal comparison: **same evidence + same Brain decision semantics + same gates + explicit decision question.** Materiality is audited observationally from what the Brain emits — decision, rationale, `not_seen`, any proposition / why_material / source_class, citations. If those prove insufficient to audit decision-relative materiality, that is itself a result, and a structured `unknowns[]` surface is tested separately later.

1. **Spec, `0.3.0-exp`** (a new input mode, so a minor bump): the `request[<id>]` reference; one INPUTS paragraph — *"WHEN A DECISION IS REQUESTED. The DECISION REQUESTED block, where present, is a question posed to you by a named party about a named thing. Answer that question — not a different one, and not the per-Objective question in its place. The same three decisions, the same rules and the same threshold apply to the answer. The per-Objective decisions are still required alongside it."*; one DECISION sentence — *"FOR A REQUESTED DECISION, where one was posed: exactly one answer, from the same three — NO_ACTION, RECOMMEND or REQUEST_INTELLIGENCE — carrying the same fields as a decision on a live Objective, keyed by the request."*; the output contract gains `requested: [{ request_id, decision, why, cites, …the same optional fields }]`. **The 0.2.1 materiality text, the NO_ACTION definition, the per-Objective loop, the schedule sentence: unchanged.** No new decision type. No `unknowns[]`.
2. **Gates:** gate 1 checks only that each posed decision has exactly one answer, under exactly the live-Objective rules (the same validator, keyed by `request_id`), and that nothing is answered that nobody asked. Gate 2 resolves `request[<id>]` and treats a RECOMMEND cited only to the question (or the Objective) as restated, which is the existing rule applied consistently. **No gate on REQUEST_INTELLIGENCE.**
3. **Renderer:** a `DECISION REQUESTED` section after OBJECTIVES — who asked, what it is about, the question verbatim, nothing else.
4. **Run script:** `--decision <file.json>` = `{ id, askedBy, question, about }`, validated to name a live Objective or a work item in the block.
5. **Nothing else.** Objective/State/Opportunity contracts untouched; existing-work envelope as 1B; overlays byte-identical; context unchanged.

## 4. The matrix — four calls, one evidence set, four questions

Every run: Mia's three live Objectives, State, map, the real existing work, the seven-item context, the **R3 overlay** (Northlight negotiating since 19 Sep, amount / terms / exclusivity not recorded) — except D2k, which uses the **R2 overlay** (term sheet known). The per-Objective `decisions[]` still run in every call (within-run controls).

| run | decision requested (verbatim) | asked by | about | overlay | what a decision-relative Brain would plausibly do | what would show materiality is not decision-relative |
|---|---|---|---|---|---|---|
| **D1** | "Should Nomila initiate additional work toward this Objective now?" | the portfolio loop | `objective[positioning]` | R3 | NO_ACTION or `no_new_work`; unknowns listed with compensation / terms marked **not** material to this question (or none listed) | REQUEST_INTELLIGENCE for the terms — the Q1 over-trigger; or terms marked material with no reason tied to *this* decision |
| **D2** | "Should this negotiation be advanced, countered or accepted?" | her agent, through Mila | `work[ctl-r3-northlight-open]` | R3 | REQUEST_INTELLIGENCE with compensation / deliverables / term / exclusivity marked material, source `connected` or `athlete`; or a bounded direct action to obtain them | RECOMMEND accept/advance with the terms unknown; or NO_ACTION "work in flight" — the Q2 under-trigger |
| **D3** | "Can this negotiation proceed alongside her other relationships?" | the athlete, through Mila | `work[ctl-r3-northlight-open]` | R3 | exclusivity / category / term marked material, **compensation marked not material**; a request scoped to those, or a NO_ACTION grounded in the real work block if it can be | compensation requested; or every unknown marked material; or a yes/no asserted without exclusivity known |
| **D2k** (control) | as D2 | her agent, through Mila | `work[ctl-r2-northlight-termsheet]` | R2 | RECOMMEND `direct_action` (respond / accept / counter) with the floor connected from State; unknowns, if any, marked not material | REQUEST_INTELLIGENCE despite the term sheet — the rule requesting for its own sake |

D1 doubles as the comparison with S3 without rerunning S3: same evidence, the implicit question made explicit. If D1 reproduces S3's NO_ACTION and reasoning, S3 was answering Q1. D2 and D2k are the known / unknown pair under the same question. D2 and D3 are the same unknown evidence under two questions — the core of the test: **does compensation flip from material (D2) to not material (D3), and exclusivity stay material in both?**

## 5. What is read

Per run: the request answer (decision, why, cites); the `unknowns[]` list — which facts, which marked material, the reasons; whether a request, if any, is scoped to material unknowns only; the per-Objective decisions (should not move in type across D1–D3, and D1's positioning decision should agree with its request answer); StartX1 (unchanged); gates; tokens and cost; the schedule-gap scan, logged only.

**The materiality matrix**, built observationally from what the Brain emits (rationale, `not_seen`, any proposition, citations) — not from a forced enumeration:

| fact | D1 | D2 | D3 | D2k |
|---|---|---|---|---|
| compensation | | | | |
| deliverables / usage | | | | |
| term | | | | |
| exclusivity / category | | | | |
| (others the Brain names) | | | | |

**Decision-relative** reads as: the same absent fact treated differently across D1/D2/D3 with reasons tied to the question (D1 deciding against duplicate work without needing commercial detail; D2 surfacing the commercial facts the reply needs; D3 surfacing category / exclusivity / term while not necessarily caring about compensation); D2k proceeding differently because the information is present. **Not decision-relative** reads as: the same treatment of the unknowns under every question; requests that include facts the question does not turn on; D1 asking for terms; D2 acting without them. These are hypotheses, not outputs encoded anywhere in the prompt or fixture. Success is not defined as particular decision types.

**The architectural reading**, which the audit answers with the data and does not assume: if D2 and D3 surface decisions and material facts that the per-Objective loop (D1, S3) structurally cannot, then *"for each live Objective, what now?"* is underspecified as the Brain's only question, and decisions arising from work items, athlete questions and events need a door of their own. That is a 1C question, not a sentence to add to the prompt.

## 6. Cost, calls, rules

Four calls at ≈ 12.5k input tokens: **≈ $0.12**. Nothing materialised; no table; StartX1 untouched; no Stage-2 research; no connected read; no production Brain. Overlays byte-identical; the decision blocks are committed as fixtures beside them.

## 7. The schedule-gap finding — closed as logged, not escalated

Under 0.2.x the conversion of a competition gap into capacity appeared in S5 twice and in the 0.2.1 S3 once ("ideal competitive lull"), the last in the same decision that lists production capacity as unknown. With the 1B instances this is a **repeated unsupported-inference problem**. The current rule stays; no further prompt emphasis. Remaining failures are logged in each audit's schedule-gap scan. Where it is eventually addressed — stronger evidence semantics, grounding that checks entailment rather than resolution, Context Intelligence typing of schedule facts, or another mechanism — is decided later.

## 8. Not done

No spec change, no provider call, no S3 rerun, no general-form sentence, no Stage-2, no StartX1 read, no 1C, no production Brain.

---

**Approved (26 Sep)** with the isolation change and one wording change — "this opportunity" → "this negotiation" in D2, D3, D2k, to remove the collision with the `opportunity[…]` namespace; not a semantic change. **Awaiting inspection before any call:** the four rendered DECISION REQUESTED blocks and the minimal 0.3 diff (`docs/audits/brain-decision-relative-materiality.md` §0 once run; until then the dry-render in the PR).
