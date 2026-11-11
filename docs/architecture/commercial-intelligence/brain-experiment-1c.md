# Brain Experiment 1C — standing decisions and Decision Requests in one Brain

**Owner:** Mia
**Date:** 2026-09-26
**Status:** run and **accepted; experiment closed 26 Sep 2026**. Audit: `docs/audits/brain-experiment-1c.md`. No 1D. Next: `brain-decision-set-semantics.md` (design checkpoint).
**Follows:** `brain-findings-individual-decision-series.md` (the series is closed). The question 1C inherits, exposed by D2k's standing decision deferring to the request: **how should standing strategic decisions and explicit Decision Requests coexist in the same Brain without creating duplicate, conflicting or unnecessary work?**
**Not a portfolio planner, and not a prioritisation experiment.** None of K1–K4 supplies a scarcity constraint — limited capacity, mutually exclusive actions, a deadline collision, a budget, an explicit athlete priority — so any prioritisation the Brain performed would be invented. 1C tests **decision-set coherence, ownership, coverage and non-duplication**. Prioritisation is a later experiment, with real evidence of competing demand.

---

## 0. In plain words

Until now every run posed at most one question beside the Brain's own three. Real use will pose several at once: the Brain's standing pass over her Objectives, her agent asking what to do with a term sheet, Mia asking whether she should post about a brand this week — all against the same picture, some of them about the same next step. 1C puts a few of those together and reads the whole answer set as one thing: does anything get done twice, does anything contradict, does one answer already carry another's next step, does an unrelated question wrongly silence an Objective, and does the Brain notice when separate work happens to serve the same goal without treating it as the same work. Nothing tells it how to coordinate.

## 1. Hypothesis

**H1C.** Given standing Objective decisions and one or more explicit Decision Requests in one call, with existing work that already serves an Objective and next steps that may be claimed by more than one decision, the Brain produces a **coherent decision set** — no duplicate ownership of a next step, no contradiction, no work manufactured that a request's answer already covers, no unrelated Objective suppressed — and the relationship between requested and standing decisions can be read from the outputs. The candidate relationships, none of them encoded anywhere the Brain can see:

| relationship | what it would look like in the outputs |
|---|---|
| **independent** | the request is answered on its own; the standing decision on the same Objective neither cites it nor changes |
| **participating** | the standing decision changes in substance because of the request (type, path, relation, or a rationale that uses the request's answer) |
| **deferring** | the standing decision is NO_ACTION or `no_new_work` and cites the request as owning the next step (D2k's pattern) |
| **other** | anything else — recorded as found |

**Null.** With overlap present, the set contains a duplicate, a contradiction, a manufactured step, or a suppression.

## 2. What stays frozen from 0.3.0-exp

Everything except one input generalisation: the spec's materiality text (0.2.1), the NO_ACTION definition, the schedule sentence, the per-Objective loop, the three decisions, both gates, renderers, the context fixture, the existing-work envelope, model and temperature, the R1/R2/R4 overlays byte-for-byte.

**The one change, `0.3.1-exp`:** a call may carry **more than one** Decision Request. The block already renders one; it renders each, in the order given. The spec's INPUTS paragraph says "a question posed to you" → "one or more questions posed to you… answer each"; the output contract's "exactly one entry in requested per decision requested" already covers it; gate 1 already checks one answer per request id. The renderer and the run script (`--decision a.json,b.json`) generalise from one to many. Nothing else moves. **No new output field.**

## 3. Is any new experimental output necessary? — No

Coherence is derived from what the current shape already emits: for every standing decision and every request answer — `decision`, `what`, `execution_path`, `relation_to_existing_work`, `advances`, `not_seen`, `cites` (including `request[…]` and `work[…]`), `proposition`. From those the audit builds an **ownership table** per call (which decision claims which next step, on which work item, citing what) and reads the six coherence properties (§5) mechanically where the fields allow and by reading where they do not. Adding a "relates to" field or a coordination instruction would tell the Brain the coordination behaviour is expected and would confound the reading. If the emitted surface proves insufficient to attribute ownership, that is a result and a later experiment tests a structured surface.

## 4. The matrix — four calls, ≈ $0.12

All runs: Mia's three live Objectives, State, map, the real existing work, the seven-item context. Overlays and request fixtures are the approved ones plus two new request fixtures below. **Baselines, not rerun:** D2k (one request, R2: standing positioning deferred to the request); R1 (audience NO_ACTION with the series in production); S4 (Yuwa NO_ACTION with outreach in flight).

| run | overlays | decision requests (verbatim) | what interaction it creates | coherence readings |
|---|---|---|---|---|
| **K1** — unrelated request must not suppress | R2 (Northlight term sheet, terms known) | `K1a` · the athlete, through Mila · about `work[<gorjana accepted deal>]` · "Should I post about gorjana this week?" | a request about a different subject (the real gorjana deal, deliverables and term dates unrecorded) beside a pending term sheet the loop already defers to | does positioning / Yuwa / audience change because of an unrelated request? does the gorjana answer treat the unrecorded deliverables as material to *posting*? does it note that a gorjana post would advance the audience Objective (cross-advancement)? does the standing audience decision manufacture content work the request's answer already covers? |
| **K2** — two decisions on the same next step | R2 | `K2a` · her agent, through Mila · about `work[ctl-r2-northlight-termsheet]` · "Should this negotiation be advanced, countered or accepted?" **and** `K2b` · the athlete, through Mila · about the same item · "Should I take this?" | two parties asking about one step | do both answers own "accept"? do they agree? does one defer to the other or cite it? does the standing positioning decision defer to one, both, or neither? |
| **K3** — cross-advancement without false deduplication | R2 **+** R1 (TikTok series in production, eight videos) | `K3a` · her agent · about `work[ctl-r2-northlight-termsheet]` · "Should this negotiation be advanced, countered or accepted?" | two **separate** work items — the term sheet (which, in the approved R2 overlay verbatim, carries "four Instagram posts") and the series in production — that may both advance the audience Objective. Shared Objective advancement is not execution duplication | does any decision say that accepting Northlight would also advance the audience Objective (cross-advancement)? does the standing audience decision stay NO_ACTION (R1) or change because of the four posts? does the Brain keep the two items **separate** — no merging, no treating one as covering the other (false deduplication), no duplicate content work? recorded in two columns: *same Objective* vs *same execution step* |
| **K4** — coherence by suppression | R2 **+** R4 (CSR proposals sent, awaiting replies) | `K4a` · her agent · about `work[ctl-r2-northlight-termsheet]` · "Should this negotiation be advanced, countered or accepted?" | positioning has relevant work and a request; Yuwa has work in flight; audience has nothing in flight. "A lot is happening" is not a reason to silence the third | does the Brain recognise coverage / in-flight work for positioning and Yuwa **while still deciding the audience Objective on its own evidence**? does Yuwa stay NO_ACTION (S4) beside an unrelated request? does positioning defer to the request? any suppression, duplication or contradiction across the four decisions? no decision type is expected |

K2 needs the multi-request input; K1, K3 and K4 pose one request each. **K2's audit distinguishes *two requested decisions were answered* from *two execution steps were created*: several questions about one underlying next move must not imply several pieces of work.** K1 also reads whether the gorjana answer is forced into action when the deal's obligations are not known (deliverables recorded: 0). The three "advance, counter or accept" requests are the approved D2k wording. The two new request fixtures: **K1a** — `{ askedBy: "the athlete, through Mila", about: "work[<gorjana id>]", question: "Should I post about gorjana this week?" }` — and **K2b** — `{ askedBy: "the athlete, through Mila", about: "work[ctl-r2-northlight-termsheet]", question: "Should I take this?" }`. Both carry the question and nothing else. Neither fixture, overlay or block mentions coordination, ownership, priority or the other decisions.

**What is real and what is controlled.** Real: Objectives, State, map, gorjana and the seven negotiations, context. Controlled and previously approved: R1, R2, R4. New and controlled: two questions. The gorjana item in K1a is the real accepted deal with its real gaps (deliverables recorded: 0; term dates not recorded).

## 5. How coherence is audited without telling the Brain

Per call, an **ownership table**:

| decision (standing × 3 + each request) | type | next step (`what`) | on which work (`advances` / cited `work[…]`) | cites another decision? (`request[…]`) | relation |

Then the six properties, each answered from the table and the rationales:

1. **Duplicate work** — two decisions whose `what` names the same step, or whose `advances` / cited work is the same item with `new_work` on one of them; a standing RECOMMEND `new_work` toward an Objective while a request answer already carries a step toward it.
2. **Contradiction** — NO_ACTION or "wait" on a subject in one decision and RECOMMEND acting on it in another; incompatible answers to K2's two requests.
3. **Two decisions owning one next step** — both claim the accept / counter / reply on the term sheet without either deferring.
4. **A standing Objective manufacturing work already covered by a request** — the S4 pattern, but with the covering step in a request answer.
5. **Improper suppression** — a standing Objective goes NO_ACTION citing a request about an unrelated subject, or its rationale changes because of it, with no grounded link (K1 is the direct test).
6. **Cross-advancement, kept apart from overlap** — any decision states that an action or a work item also advances another Objective (K3's four posts; K1's gorjana post), with citations. Recorded in two separate columns: *same Objective / cross-advancement* and *same execution step / true overlap*. Separate work items that advance the same Objective are not duplicates, and treating them as one is **false deduplication**, itself a failure.

**Audit vocabulary, per call, from the existing output:** which decision or request claims a next step · which work item that step belongs to · which Objective(s) it advances · whether another decision claims the same underlying step · whether two separate work items merely advance the same Objective · whether a standing decision manufactures work already covered by a requested decision · whether requested decisions suppress unrelated standing decisions · contradictions between requested and standing decisions.

Plus the standing readings from the series: materiality of the unrecorded gorjana deliverables under a posting question (K1); the requested/standing relationship per run (§1 table); the within-run controls on the stable fields against D2k / R1 / S4; StartX1 (unchanged, untouched); the schedule-gap scan, logged; gates; tokens and cost.

**Nothing in the prompt, fixtures or blocks names coordination.** The spec's only relevant sentences are the ones already frozen: existing work is read before recommending; a request is answered as asked; the per-Objective decisions are still required.

## 6. Readings

- **Coherent and legible:** no property 1–5 violated; the relationship in §1 identifiable per run and consistent across runs; K3 or K1 shows cross-advancement with citations.
- **Coherent by suppression:** no duplicates, but unrelated Objectives silenced by requests (property 5) — coherence bought the wrong way.
- **Incoherent:** duplicates or double ownership (K2, K3), or manufactured work beside a covering request (K4).
- **Illegible:** coherent by outcome but the relationship cannot be attributed from the emitted fields — the case for a structured relationship surface, tested later.

The result feeds the design of the decision-request door and of whether requested decisions participate in, defer from, or stay independent of standing reasoning. It is not encoded in advance.

## 7. Cost, calls, rules

Four calls at ≈ 12.7k input tokens: **≈ $0.12**. Nothing materialised; StartX1 untouched and unread; no `information_available` writer; no production contract; no Campaign / Studio integration. Overlays byte-identical; the two new request fixtures and the 0.3.1 diff are shown before any call.

## 8. Not done

No spec change yet (the 0.3.1 generalisation is proposed here), no provider call, no rerun of D1–D2k, no Stage-2 research, no StartX1 read, no production Brain.

---

**Awaiting review on:** H1C and the four relationships (§1); the single input generalisation as the only change (§2) and "no new output" (§3); the four-run matrix and the two new request fixtures (§4); the ownership-table audit (§5); ≈ $0.12 of calls, not made until approved.
