# Brain spec 0.2.0-exp and the targeted 1B.1 rerun — design for review

**Owner:** Mia
**Date:** 2026-09-26
**Status:** approved 26 Sep 2026 with one wording refinement to 1a (the materiality threshold: "could materially change whether the action should occur or materially change how it should occur"; "a fact that would merely improve the decision belongs in not_seen; a fact the decision materially depends on warrants REQUEST_INTELLIGENCE"). Four calls approved. Audit: `docs/audits/brain-decision-experiment-1b1.md`.
**Follows:** `docs/audits/brain-decision-experiment-1b.md` (1B accepted). 1B moved the conclusion: the Brain discriminates execution shape when existing work intersects the Objective; the remaining failures are narrower and look like decision-spec semantics.

---

## 0. In plain words

Three sentences of principle are added to the experimental Brain, nothing is removed, no new output type exists. Then three or four of the 1B conditions are rerun under the new text, with everything else identical, so the before-and-after can be read side by side: does the Brain now ask when a decision turns on a fact it lacks (R3); can it stand down when work is in flight and nothing else is warranted (R4); does it still plan when planning is right (R5); and does it stop turning a quiet fixture list into spare time. Prior artifacts stay exactly as they are.

## 1. The three principles, and where each goes — the smallest revision

The revision touches two blocks of `brain-eval-spec/0.1.0-exp` and adds text only. Every sentence of 0.1.0-exp survives unchanged except the two-line NO_ACTION definition, which is widened. No field-specific missingness heuristic; no output type; no gate change; no renderer change; no contract change.

### 1a. Decision-material missingness — in the DECISION block, under REQUEST_INTELLIGENCE

After the existing sentence *"Where missing obligations affect whether a recommendation is appropriate, asking is preferable to guessing."*, add:

```
                       Before recommending execution, ask whether any fact you do not have could materially change
                       whether the action should occur or materially change how it should occur. If so, prefer
                       REQUEST_INTELLIGENCE over proceeding on an assumption. A fact that would merely improve the
                       decision belongs in not_seen; a fact the decision materially depends on warrants
                       REQUEST_INTELLIGENCE. A declared information condition is one way to learn that a fact is
                       missing; your own reading of the decision is the other.
```

What this does: `not_seen` stops being a disclosure made after the decision and becomes the residue of a step taken before it. What it does not do: name any field, count anything, or make every unknown a request.

### 1b. Work in flight — in the DECISION block, the NO_ACTION definition

Before (0.1.0-exp):

```
  NO_ACTION            this Objective is best served by monitoring now. Say why, citing what you read. This is a
                       complete and correct answer, not a failure. A quiet fortnight is a quiet fortnight.
```

After (0.2.0-exp):

```
  NO_ACTION            no further intervention is warranted now. This is a complete and correct answer, not a
                       failure. It is the right answer when existing work already covers the need; when appropriate
                       work is in flight; when the next event is an external response you are waiting on; or when
                       there is otherwise no grounded reason for another intervention now. Incomplete existing work
                       does not by itself justify creating additional work. Say why, citing what you read. A quiet
                       fortnight is a quiet fortnight.
```

No WAIT type. Waiting is one of the things NO_ACTION means.

### 1c. Schedule gap ≠ capacity — in the INPUTS block, after the observation sentence

After *"An observation is not a verdict: a fixture on Saturday is a fact, not a reason to post."*, add:

```
A gap in the competition schedule is a fact about the schedule. It may inform timing.
It is not evidence of the athlete's availability, capacity or readiness, and you do not convert it into spare time
unless availability or capacity is itself evidenced in what you were shown.
```

The Brain may still reason about timing from a schedule fact. It may not manufacture capacity from one. The shipped sentence says "It may inform timing." explicitly (Mia, 26 Sep).

### 1d. The diff, in one view

| block | 0.1.0-exp | 0.2.0-exp |
|---|---|---|
| TASK | unchanged | unchanged |
| INPUTS | — | + the schedule-gap sentence (1c), after "not a reason to post" |
| DECISION · NO_ACTION | two-line definition | widened definition (1b) |
| DECISION · REQUEST_INTELLIGENCE | ends at "asking is preferable to guessing" | + the decision-material paragraph (1a) |
| DISCIPLINE | unchanged | unchanged |
| OUTPUT CONTRACT | unchanged — same fields, same three decisions, same deferred decisions | unchanged |

## 2. Version and digest plan

- `BRAIN_EVAL_SPEC_VERSION` → `brain-eval-spec/0.2.0-exp`. A version comment records the three principles and the two 1B findings each answers, and that 1B's citation-format refusals are logged, not addressed.
- Ceremony as for every frozen spec: amend → bump → unpin (`BRAIN_CANONICAL_SHA256 = "UNPINNED"`) → parity tests for the three new passages and for the survival of every 0.1.0-exp passage still asserted → exact-text review of the rendered canonical text → repin. The 0.1.0-exp digest `d470d089…` stays in the record and in every Stage-1 and 1B artifact.
- Parity tests added (as shipped): "could materially change whether the action should occur or materially change how it should occur"; "a fact the decision materially depends on warrants REQUEST_INTELLIGENCE"; "A fact that would merely improve the decision belongs in not_seen"; "when appropriate work is in flight; when the next event is an external response you are waiting on"; "Incomplete existing work does not by itself justify creating additional work"; "A gap in the competition schedule is a fact about the schedule. It may inform timing."; "It is not evidence of the athlete's availability, capacity or readiness"; and no `WAIT` type. The digest test asserts `0.2.0-exp`. **Pinned digest `0a589ba6…`.**
- Gates, `validateBrainResponse`, grounding, renderers, the existing-work envelope (`0.2.0-exp` as 1B used it), the run script: unchanged. **The R1/R3 citation-format refusals stay logged as experimental reliability findings; no format normalisation is added.**
- Artifacts for 1B.1 go to `docs/audits/artifacts/brain-context-experiment-1/1b1/arm/`, each asserting the 0.2.0-exp digest. `1b/arm/` and `arm-a/` are not touched.

## 3. The 1B.1 matrix — targeted, four calls

Everything frozen as in 1B except the spec text: same State snapshot discipline, same map, same live Objectives, same approved seven-item context in every run, same overlays byte-for-byte from `1b/overlays/`.

| run | repeats | overlay | what is being tested | before (1B) | reading that says the principle landed | reading that says it did not |
|---|---|---|---|---|---|---|
| **S3** | R3 | Northlight negotiating, nothing recorded | decision-material missingness (1a) | RECOMMEND · direct_action · advances; terms in `not_seen`; no request | REQUEST_INTELLIGENCE on positioning naming the terms / exclusivity, source `connected` or `athlete`, `why_material` saying how they change the action | RECOMMEND again with the terms in `not_seen` |
| **S4** | R4 | CSR proposal sent to six brands, no reply | work in flight (1b) | RECOMMEND · specialized_plan · advances; supporting work manufactured | NO_ACTION on Yuwa citing `work[ctl-r4-csr-outreach]`, why naming the proposals in flight / awaiting replies | more work attached to the outreach |
| **S5** | R5 | none | control: planning still appropriate (against suppression) | RECOMMEND · specialized_plan · new_work | the same | NO_ACTION or REQUEST_INTELLIGENCE on positioning where nothing is in flight and nothing material is missing — over-suppression |
| **S2** (recommended, strikeable) | R2 | Northlight term sheet, no response sent | control: the missingness rule must not over-trigger | RECOMMEND · direct_action · advances; `not_seen`: marketing timeline, deliverable detail | the same — those unknowns are not decision-material | REQUEST_INTELLIGENCE for a fact the reply does not turn on — over-trigger |

S2 is the counterpart to S3: same brand, terms known versus unknown. Without it, S3 alone cannot distinguish "asks when it should" from "asks whenever anything is unknown". Recommended kept; ≈ $0.03.

**The schedule-gap check runs inside every call.** The context fixture is present in S2–S5, unchanged, with `ctx[0]` and `ctx[1]` describing the fixture gap. Read every decision, target and non-target, for any conversion of the gap into capacity ("window", "lull", "dedicated time", "ideal moment", "minimal friction" tied to the schedule). Under 1B this appeared in R0 (all three Objectives), R3 and R4 (audience), R1 (reinforcing NO_ACTION); not in R5 or R2. The principle landed if it appears nowhere in S2–S5; a schedule fact cited for *timing* without a capacity claim is not a violation and is recorded as such.

**Within-run controls** as before: the two non-target Objectives per run should not move in type. **Noise floor** carries over from 1B: type, path and relation were stable across identical runs; wording and context citation were not.

Cost: four calls ≈ $0.11. No Stage-2 research, no StartX1 connected read, no 1C, no production Brain.

## 4. What the audit brings back

Per run: raw output; both gate results (format refusals logged as in 1B, content read as refused sets); resolved citations; decision per live Objective; target change against its 1B counterpart; non-target behaviour; whether the controlled item was cited; relation; observational execution shape; StartX1 behaviour (expected: still REQUEST_INTELLIGENCE in the deferred block, untouched); token and cost data; the schedule-gap check per decision. A before/after table R2–R5 → S2–S5 on the stable fields.

## 5. Not done

No output type. No field checklist. No change to the Objective, State or Opportunity contracts. No existing-work change beyond 1B's experimental envelope. No gate or citation-format change. No portfolio-level 1C. No Stage-2 research. No StartX1 read. No production Brain.

---

**Awaiting review on:** the exact wording of 1a, 1b and 1c; the version and digest plan (§2); the four-run matrix with S2 as the over-trigger control (§3); the ≈ $0.11 of calls, not made until approved.

---

## 6. 0.2.1-exp — the materiality test generalised to not acting; S3-only rerun (approved 26 Sep)

**What S3 exposed** (1B.1 audit §3): the widened NO_ACTION created a path around the materiality rule — material facts absent → avoid recommending execution → classify the open negotiation as appropriate work in flight → NO_ACTION — because the materiality check was scoped to "before recommending execution" and never evaluated whether the premise of NO_ACTION was itself grounded.

**The revision — one paragraph appended, nothing else touched.** In the DECISION block, immediately after "…your own reading of the decision is the other.":

```
                       The same test governs not acting. A decision cannot avoid material uncertainty by choosing
                       NO_ACTION: if the justification for NO_ACTION depends on a fact that is materially unknown,
                       prefer REQUEST_INTELLIGENCE rather than assuming the condition for NO_ACTION is satisfied.
                       Before concluding that existing work covers the need or is appropriately in flight, ask
                       whether any fact you do not have could materially change that judgment; if so, request the
                       material information rather than treating the work as sufficient or appropriate by
                       assumption. Material uncertainty applies to the justification for acting and to the
                       justification for deliberately not acting.
```

Preserved: the threshold (merely useful → `not_seen`; decision-material → REQUEST_INTELLIGENCE); the NO_ACTION definition and S4's work-in-flight / waiting semantics; no checklist; no special case for commercial terms; no output type; gates, renderers, envelope, script, context, overlays unchanged.

| block | 0.2.0-exp | 0.2.1-exp |
|---|---|---|
| INPUTS (incl. the schedule sentence) | unchanged | unchanged |
| DECISION · NO_ACTION | unchanged | unchanged |
| DECISION · REQUEST_INTELLIGENCE | ends at "your own reading of the decision is the other" | + the not-acting paragraph |
| everything else | unchanged | unchanged |

**Version and digest.** `0.2.0-exp` → `0.2.1-exp` (the smallest step: one principle generalised, nothing new). Ceremony: amend → bump → unpin → parity (four new phrases plus S4's semantics asserted to survive) → exact-text review → repin. `0a589ba6…` stays in every 1B.1 artifact.

**Rerun: S3 only**, byte-identical overlay (`1b/overlays/R3.json`), context, State discipline, map, model, gates, renderers; only the spec text differs. Artifact: `…/1b2/arm/S3.json`. S2, S4 and S5 are not rerun; their 0.2.0-exp results stand as the controls. **Discriminating outcomes:** REQUEST_INTELLIGENCE naming the materially missing information → landed; NO_ACTION relying on the negotiation being appropriate or sufficient → still bypassed; RECOMMEND execution despite the uncertainty → materiality still not governing. Also read: is the requested information actually material to the decision, rather than every absent field.

**Schedule-gap finding: not strengthened.** S5's "a flexible window to prepare materials" and "time on campus for content batching" are kept as unsupported-inference findings: a competition gap may inform timing; it does not establish spare capacity, availability or physical presence on campus. No tuning from two instances.
