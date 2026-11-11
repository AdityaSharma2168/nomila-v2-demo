# Brain Decision-Set Semantics — design checkpoint

**Owner:** Mia
**Date:** 2026-09-26
**Status:** core architecture approved 26 Sep 2026; §5–§8 are now **experimentally supported design semantics — not yet a production contract** (1C.1, `docs/audits/brain-experiment-1c1.md`, accepted: the semantics alone produced coherent standing/requested coordination under the joint criterion, one run per configuration). **Not production wording, not a contract, not an implementation.** This is the primary moving design page; the experiment pages are historical records. Next boundary: §13.
**Evidence base:** the individual-decision series (`brain-findings-individual-decision-series.md`) and Experiment 1C (`docs/audits/brain-experiment-1c.md`, accepted and closed). Nineteen calls plus four; nothing materialised; StartX1 never read.
**The result this checkpoint designs from:** *the existing output surface is sufficient to observe ownership and coordination, but the frozen Brain semantics do not determine a consistent relationship between standing decisions and requested decisions.* K3 proved deferral is reachable and legible. K4 proved it is not governed.

---

## 0. In plain words

Nomila's Brain will be asked several things at once: its own standing pass over what Mia has decided to pursue, her agent asking what to do with a term sheet, Mia asking whether she should post this week. Those questions can land on the same next move. The Brain must answer each question it was asked, and the set of answers must not tell two different parts of Nomila to do the same thing twice, or contradict each other, or fall silent on something unrelated just because a lot is happening. Two people may ask about the same deal and both get an answer; there is still one deal to act on. This page says what a decision is, how several of them live in one evaluation, which thing must not be duplicated, and where a check on that could sit without becoming a second decision-maker.

## 1. What constitutes a decision entering the Brain

> **A decision identifies who poses it, what it concerns, and the question to be answered. The Brain answers it against the shared evidence available in that evaluation.**

A **decision** has three parts:

| part | what it is | today |
|---|---|---|
| **source** | who poses it | the standing Objective loop · her agent (through Mila or an execution path) · the athlete (through Mila) · later: an event or a material evidence change |
| **subject** | what it concerns | a live Objective · a work item · later: a relationship, a deliverable |
| **question** | the decision, verbatim, as posed | the loop's fixed question, *"what should Nomila do about this Objective now?"* · a request's own words |

**Evidence is not part of the decision's identity.** A decision is answered against the **shared** evidence set of the evaluation it enters — State, the Opportunity map, existing work, context, research — never against per-decision evidence; that rule is unchanged. But the same decision can be reconsidered as evidence changes: *"Should I accept Northlight?"* posed before and after a revised contract arrives is recognisably the same decision, in the same lineage, evaluated twice. Separating decision identity from evaluation context is what lets a decision be re-asked, deferred and revisited without becoming a new decision each time. No schema for lineage is added here.

Who poses a decision is not where its evidence comes from (Finding 2). A decision's identity — the posed question — is distinct from its subject's identity and from the identity of any step its answer proposes (§4).

Every decision entering an evaluation receives **exactly one answer** from the same three — NO_ACTION, REQUEST_INTELLIGENCE, RECOMMEND — under the same threshold (Finding 1: material relative to *this* decision) and the same decision hierarchy (evidence sufficient? → intervention warranted? → at what scale).

## 2. Standing Objective decisions versus explicit Decision Requests

| | standing decision | Decision Request |
|---|---|---|
| source | the Objective loop, always | a named party |
| subject | one live Objective, every live Objective, every evaluation | what the party named |
| question | fixed: what should Nomila do about this Objective now? | the party's words |
| what it decides | whether **additional work toward the Objective** is warranted, and at what scale | the question actually posed — which may be about a step, a deal, a relationship, a post |
| role of existing work | read before deciding: work in flight can cover the need | the subject may itself be a work item |

They are the same kind of thing — a decision — differing in source, subject and question. Neither is privileged. The series showed the loop cannot pose the decisions a work item, an agent or the athlete pose (Finding 2), and 1C showed the loop's own answer beside a request is the thing that needs governing.

## 3. How several decisions coexist in one evaluation

- One evaluation sees the **whole decision set** — every standing decision and every request — against one shared evidence set. Nothing is answered in isolation from the others (K3's deferral cited the request; K4's duplicate did not see it).
- Each decision is answered once. Answers may **refer to one another** by reference (`request[<id>]`, `objective[<id>]`) when one accounts for another.
- The set is judged **as a set** (§5, §9): coherent answers, not merely individually plausible ones. This is the difference between 1C's question and the series' question.
- A request does not remove its subject from the standing loop's view, and does not decide what strategic reasoning the loop may perform (§6, §7). The **door** that admits a request identifies source, subject and question; it carries no policy.

## 4. Three identities that must not be conflated

| identity | what it names | example from 1C | observable today from |
|---|---|---|---|
| **decision identity** | a posed question | `request[K2a]`, `request[K2b]`, the standing positioning decision | `request_id`, `objective_id` |
| **work-item identity** | a thing already in motion | `work[ctl-r2-northlight-termsheet]` | `advances`, `work[…]` citations |
| **execution-step identity** | the underlying next move an answer **proposes** — in these experiments nothing was executed, so every step is a *proposed* execution step | *counter the term sheet* · *accept it* · *post about gorjana this week* | `what` + `advances` / cited work + the Objective it serves — reconstructed, not declared |

Two decisions may share a subject (K2: agent and athlete on one term sheet). Two work items may advance one Objective without being one step (K3: the series and the term sheet). One proposed step may answer two questions (K2: "accept" twice, one proposed acceptance — proposed, not executed). **Decision multiplicity ≠ execution multiplicity.** The invariant in §5 is stated at the execution-step layer and nowhere else. No execution-step id exists today; 1C showed the step can be reconstructed from the emitted fields, so no field is added merely to name it (§9).

## 5. The non-duplication invariant — experimentally supported design semantics, not a production invariant

> **Within one Brain evaluation, two decisions must not independently propose or advance the same underlying next execution step.**

*Independently* is the operative word: an answer that accounts for another (cites it and defers, or converges on one step while saying so) is not independent. *Propose* is the empirical word: the experiments materialised nothing, so what the Brain emitted were proposed steps. K4 violated the invariant — the standing positioning decision and the request each proposed the same counter with the same arithmetic and neither referred to the other. K2 did not: two answers, one proposed acceptance, one step.

What the invariant does **not** say: that one work item may carry only one decision (K2); that a requested decision wins (K1); that separate work advancing one Objective is one step (K3); that the standing loop stops reasoning when a request exists (§7).

## 6. When a standing decision accounts for a requested decision — experimentally supported design semantics

> **When an explicit Decision Request and a standing Objective decision concern the same underlying next step, the requested decision answers the explicitly posed question. The standing decision may account for that decision when determining whether additional work toward the Objective is warranted, but must not independently recreate or advance the same step.**

Read against 1C:

- **K3 — the reachable, legible form.** The standing decision said the step "is currently being addressed under the agent's decision request, making further intervention on this objective duplicate", cited `request[K3a]`, and answered NO_ACTION. That is *accounting for* the request: the standing question ("is additional work warranted?") was still answered, on its own terms, with the request as part of the evidence.
- **K2 — accounting need not mean silence.** The standing decision planned outreach to *other* partners "while she is currently negotiating". The rule permits additional work toward the Objective when the evidence grounds it; what it forbids is recreating the step. Whether that particular plan was warranted is judged by the existing principle that incomplete work does not by itself justify more work — not by this rule.
- **K4 — the ungoverned form.** The same step twice, no reference. The rule's whole content is that this must not happen.
- **D2k / K1 — the loop owns the step when nobody else asks.** With no request on the term sheet (K1), the standing decision was right to act on it directly. Deferral is a consequence of a request existing, not a property of the Objective.

"Account for" is deliberately broad: cite and stand down; cite and add grounded work that is not the same step; cite and request intelligence the standing question turns on. What it excludes is only the independent recreation of the step.

## 7. Why unrelated requests must not suppress standing reasoning

K1: a request about gorjana beside a pending term sheet; K4: two Objectives with work in flight beside a request. In both, every standing decision was decided on its own evidence — Yuwa stood down because *its* outreach was in flight, not because the evaluation was busy; audience planned in K4 because nothing covered it. The rule in §6 is scoped to *the same underlying step*. A request on another subject is not evidence about an Objective and confers nothing on it. "A lot is happening" is not a ground; a standing decision that goes NO_ACTION citing an unrelated request, or with a rationale that changed because of one, is a **suppression failure** — coherence bought the wrong way. Prioritisation among Objectives is a different question and needs real evidence of competing demand; it is not inferred from the presence of requests.

## 8. Why several requests can be answered separately and converge on one step

K2: her agent and the athlete asked about the same term sheet in their own words. Each is entitled to an answer to the question they asked; the Brain gave two, in the register of each asker, and both were "accept". One acceptance results. The two answers should be **consistent** (they were) and should ideally **acknowledge convergence** (they did not — legible by outcome, not by statement). No single canonical "decision owner" is introduced from this: *authority* to approve or execute on the athlete's behalf is a governance and permissions matter (the tap-to-send rule, Objective governance), separate from which decisions were posed and answered, and is not inferred from 1C.

## 9. Where coherence validation could sit — without a second decision-maker

```
decision sources / requests  ──▶  the shared Brain
                                     sees: the decision set + shared evidence + existing work
                                     emits: one coherent answer set
                                        │
                                        ▼
                                  coherence verification (a gate, like gates 1 and 2)
                                     may REFUSE an incoherent set · never authors a repaired one
                                        │
                                        ▼
                                  Recommendation / execution paths
```

- **The rule lives in the Brain's decision-set semantics** (§5, §6, §7, §8), as sentences the Brain reasons under — the only place a coordination behaviour can be produced rather than imposed.
- **The door carries no policy.** It admits a decision with a source, a subject and a question. It does not scope what the standing loop may see or reason about.
- **A validator may verify, never repair.** It could refuse a set that contains two RECOMMENDs independently advancing one step, or a standing NO_ACTION whose only cited ground is an unrelated request. Refusal records the set and the reason, exactly as gates 1 and 2 do today; the Brain re-evaluates or the run is recorded as refused. A component that chooses which recommendation survives would be a second decision-maker after the shared Brain, and is ruled out.
- **What such a gate could check from the existing surface**, if it were ever built: two RECOMMENDs with `advances` naming the same work item, neither citing the other's decision (K4); a NO_ACTION citing only a `request[…]` about another subject. Whether that needs a declared execution-step identity is a later question, raised only if a validator cannot do its job from the reconstructed step. **Not built now.**

## 10. What remains unresolved, and therefore still needs empirical testing

1. **Whether sentences suffice — answered (1C.1, accepted).** §5–§8 as one spec block produced coherent accounting under the joint criterion with no predeclared overcorrection failure. Closed at the experimental architecture level.
2. **Repeatability.** Every 0.4.0 configuration ran once. Stability across repeats is a requirement **before any production freeze** and is deliberately not spent now; the K1–K4 repeat is the test to run when the production Brain contract is being prepared.
3. **Cross-advancement.** Not surfaced in K1 or K3 even when available (the four Instagram posts; a gorjana post). Recorded; not forced into the coordination rule.
4. **Commercial and rate semantics — elevated to an upstream architecture pressure point (see §13).** The same Northlight terms were accepted (D2k, K2) and countered (K3, K4) because the Brain read the floors separately in one run and additively, or against gorjana's cash and her USD 14,000 high, in another. The Brain receives several commercial reference values — floors by deliverable type, demonstrated economics, past deal values — without structured meaning about which are comparable, additive, historical, product-specific or governing. Not prompt-tuned. Belongs to the rate / commercial State contracts.
5. **Information conditions.** `CONDITION_APPEARS_RESOLVED` on unchanged evidence, twice (D1, K2). The invariant stands: *Brain judgment alone must never satisfy an information condition*; a future `information_available` writer depends on persisted evidence-as-seen that answers the proposition. No writer exists and none is built here.
6. **Events as a source.** A reply arriving, a deliverable coming due — not yet posed as decisions; the door's fourth source is untested.
7. **The athlete's own question when it is the standing question.** "What should I do next?" is the loop's question posed by a different source; whether it is one decision or many, and how it relates to the prohibition on ranking, is unresolved.
8. **Execution-step identity.** Reconstructed today; declared only if a validator or the execution path needs it. Not before.
9. **Prioritisation.** Requires real scarcity evidence (capacity, mutually exclusive actions, deadlines, budget, an explicit athlete priority). Nothing in the series supplies it; the schedule-gap finding (closed) is what inventing it looks like.
10. **The Recommendation boundary.** What an answer carries to the execution path so that Campaign / Creative planning does not invent intent (#570's adapter) — kept abstract here; the shape is decided by the Brain contract, after these semantics.

## 13. The next semantic boundary — commercial / rate meaning (elevated 26 Sep)

Across D2k, K2, K3, K4 and 1C.1's K2, K3, K4, the same Northlight term sheet against the same State produced *accept* in some runs and *counter* in others, because the Brain received several commercial reference values — floors by deliverable type, gorjana's cash component, a demonstrated high of USD 14,000 — with no structured meaning about which governs which deliverable, whether components are additive or inclusive, which historical economics are comparable, whether a demonstrated high is a benchmark, a floor or an observation, or how term, rights, exclusivity and the deliverable bundle affect comparability. It recurred enough to be treated as a genuine upstream pressure point rather than a Brain-coordination issue, and it is **not** to be solved in Brain prompt prose.

> **Commercial / rate intelligence must supply the Brain with structured commercial meaning, not merely reference numbers that the Brain has to reconcile itself.**

This is the candidate next semantic boundary before a production Brain contract is frozen. It belongs to the rate / commercial State contracts (specialized intelligence, shared contracts), not to the decision-set semantics. Not started.

## 11. Mapped onto the canonical loop

```
OBSERVE            athlete · commercial · external evidence  ──▶  evidence-as-seen
UNDERSTAND         M.I.A. · Opportunity · Context · rate         (specialized intelligence supplies evidence — and
                                                                 the commercial-semantics pressure of §10.4 lives here)
OBJECTIVES         governed by the athlete; the standing loop's subjects
BRAIN              one evaluation · the decision set: standing decisions + Decision Requests (sources: loop, agent,
                   athlete, event) · one shared evidence set · one coherent answer set (§5–§8)
                   ◀── REQUEST INTELLIGENCE ──▶ targeted research ──▶ evidence-as-seen ──▶ reconsider
COHERENCE GATE     verifies the set; refuses, never repairs (§9)
RECOMMENDATION     what and why, to an execution path
EXECUTION PATHS    NO ACTION · direct action · specialized plan · campaign — own HOW
                   (Campaign / Creative · Studio · execution · outcome · learn — abstract here)
```

**One brain.** Every decision, from every source, is answered by the same evaluator over the same evidence; the door is a source, the gate is a check, neither decides. **Specialized intelligence.** M.I.A., Opportunity, Context and rate intelligence supply evidence with provenance; they do not decide, and the meaning of a commercial reference value is theirs to make structured. **Shared contracts.** State, Objective, Opportunity, evidence-as-seen today; a Decision Request would join them as a contract for *posing* a decision, carrying source, subject and question and nothing else. **Independent execution.** The Brain owns WHAT and WHY; paths own HOW; coherence is established in the Brain and verified before execution, never repaired after it.

## 12. Not done

No experimental spec change, no provider call, no production Brain contract, no coherence gate, no coordination or relationship field, no execution-step schema, no Stage-2 research, no StartX1 read, no `information_available` writer, no Campaign / Studio integration.

---

**Approved (26 Sep):** the definition of a decision as source, subject and question (§1); the three identities with *proposed* execution step (§4); §5–§8 as experimentally supported design semantics (1C.1); placement in the Brain, the door without policy, verification as a refusing gate not built (§9); no structural machinery on current evidence. **Next boundary to choose deliberately:** §13 (commercial / rate meaning) among the unresolved items in §10.
