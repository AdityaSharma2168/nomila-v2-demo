# Brain findings — the individual-decision experiment series (closed 26 Sep 2026)

**Owner:** Mia
**Status:** architecture-level findings, empirically supported. **Not a frozen production contract.** The experimental Brain (`brain-eval-spec/0.3.0-exp`, unmounted) stays as it is; nothing here is implemented in production.
**Series closed:** Stage 1 (`0.1.0-exp`, `d470d089…`) · 1B (`0.1.0-exp`) · 1B.1 (`0.2.0-exp`, `0a589ba6…`) · 1B.2 (`0.2.1-exp`, `1a0e52f5…`) · 1B.3 (`0.3.0-exp`, `537d2a97…`). Nineteen provider calls, ≈ $0.62, nothing materialised, StartX1 never read, no rerun of any accepted run. Audits under `docs/audits/brain-*.md`; artifacts under `docs/audits/artifacts/brain-context-experiment-1/`.

---

## Finding 1 — information is material relative to a decision, not globally

Identical evidence (an EdTech negotiation toward the positioning Objective, amount / terms / exclusivity unrecorded) under four explicit questions:

| question | what became material |
|---|---|
| should Nomila add work toward the Objective? (D1) | the negotiation's existence was sufficient; no commercial term surfaced |
| advance, counter or accept? (D2) | compensation, contract length, deliverables, her representation floors |
| alongside her other relationships? (D3) | exclusivity and the Adidas relationship; compensation not mentioned |
| advance, counter or accept, terms known (D2k) | none requested; a bounded direct action, floors connected by arithmetic |

Established from the emitted rationale, propositions, `not_seen` and citations alone. **No `unknowns[]` surface is added from this series.** Two margins recorded, not tuned around: D2 did not mention exclusivity, which an "accept" arguably turns on; D2 referred to her floors without citing them.

The earlier readings of S3 (1B, 1B.1, 1B.2) as a failure of the materiality rule are withdrawn: under the per-Objective question the terms were not material, and the Brain's NO_ACTION was an answer to that question.

## Finding 2 — the Objective loop is one Brain entrance, not the only one

Across fifteen runs the standing per-Objective loop never posed the D2/D3 decisions; explicit requests did, and the loop's own answer on positioning stayed NO_ACTION beside them. **Decision Request** is promoted to an architectural concept:

> A specific decision posed to the shared Brain by a known source about a known subject.

Sources include the strategic Objective loop; a work item or execution path; the athlete through Mila; an agent; eventually an event or a material evidence change. **Not a production schema yet.**

Two principles carried with it:

- **One Brain.** It answers decisions originating from multiple surfaces and processes. No separate "deal brain", "campaign brain" or similar.
- **Who poses a decision is not where the evidence comes from.** A decision requested by the athlete or an agent may need State, contract, inbox, relationship, context and other evidence to answer.

## An emerging decision hierarchy — conceptual model, empirically supported, not a contract

```
decision context
  → is decision-material evidence sufficient?
      no  → REQUEST_INTELLIGENCE
      yes → is intervention warranted?
              no  → NO_ACTION   (covered by existing work · appropriately in flight · waiting on an external
                                 response · no grounded reason for another intervention)
              yes → select the appropriate intervention / execution scale
```

The output contract is not redesigned around this.

## Invariants recorded by the series

1. **Satisfying an information condition does not itself reactivate an Objective.** (Stage 1)
2. **Brain judgment alone must never satisfy an information condition.** In 1B.3 D1 the deferred StartX1 entry became `CONDITION_APPEARS_RESOLVED` on evidence identical to fourteen prior runs — three detected rows with no terms — claiming the details had been provided. A future `information_available` writer depends on persisted evidence-as-seen that answers the requested proposition, never on the Brain's assertion. The current no-writer state is kept.
3. **A gap in the competition schedule is a schedule fact.** It may inform timing; it is not evidence of availability, capacity, readiness or presence on campus. The rule stays as written in 0.2.0-exp; the repeated unsupported-inference instances (R0, R1, R3, R4, S5 ×2, S3-0.2.1, D1 ×2) are **closed for this series** and kept for later work on evidence semantics, grounding that checks entailment, or Context Intelligence typing. No further prompt emphasis.
4. **Incomplete existing work does not by itself justify creating additional work; waiting on an external response is a NO_ACTION.** (1B.1 S4)

## Also logged, not acted on

- Two of six 1B sets refused by the gates on citation / id formatting under an unchanged prompt; content intact; no normalisation added.
- A resolving but semantically irrelevant citation (1B.1 S3, the Adidas evidence opening); gate 2 is resolution, not entailment.
- D2k's standing positioning decision deferred to the requested decision ("covered by request[D2k]") — the interaction 1C is designed around.

## The open question the series hands to 1C

**How should standing strategic decisions and explicit Decision Requests coexist in the same Brain without duplicate, conflicting or unnecessary work?** — `brain-experiment-1c.md`.
