# Brain Experiment 1C.1 — are the decision-set semantics sufficient? (design)

**Owner:** Mia
**Date:** 2026-09-26
**Status:** approved 26 Sep 2026 with one wording correction to the block's final paragraph (several requests may concern the same subject or step and need not converge; only a shared *proposed execution step* must not be independently duplicated). Run 26 Sep 2026 after the chain merged. Audit: `docs/audits/brain-experiment-1c1.md`.
**Follows:** `brain-decision-set-semantics.md` (checkpoint, core architecture approved) · `docs/audits/brain-experiment-1c.md` (1C closed: legible, not governed).
**Question (checkpoint §10.1):** *are the proposed decision-set semantics sufficient to produce coherent accounting without structural machinery?* — and, as important, **do they fix duplication without overcorrecting?**

---

## 0. In plain words

1C showed the Brain can read a request and stand down from a step it owns (K3) and can also, on the same evidence, propose that step a second time itself (K4). Nothing in the Brain's text says which. 1C.1 adds the sentences the checkpoint proposes — one set of answers, no step proposed twice, the standing decision accounts for a request on the same step, an unrelated request changes nothing — and reruns the identical four situations. The test is not whether K4 stops duplicating. It is whether it stops duplicating while K1 is not silenced by an unrelated question, K2 still gets both its answers, and K3 still keeps two pieces of work separate.

## 1. The intervention — semantic only

**One block added to `brain-eval-spec/0.3.1-exp` → `0.4.0-exp`.** Nothing removed. No coordination field, no execution-step id, no ownership schema, no repairing validator, no renderer structure beyond what 1C already uses, no gate change. Overlays, request fixtures, context, State discipline, map, model: byte-identical to 1C.

Placed in the DECISION block, immediately after *"FOR EACH REQUESTED DECISION, where any were posed: exactly one answer…"* and before *"FOR EACH DEFERRED OBJECTIVE"*:

```
THE ANSWERS ARE ONE SET. Every decision in this evaluation — each live Objective's standing decision and each
requested decision — is answered against the same evidence, and the answers are read together as one set.

  Within one evaluation, two decisions must not independently propose or advance the same underlying next
  execution step.

  Where a requested decision and a standing Objective decision concern the same next step, the requested decision
  answers the question that was posed. The standing decision may account for that answer — citing it — when
  deciding whether additional work toward the Objective is warranted, and does not propose or advance the same
  step on its own.

  A request about another subject confers nothing on an Objective. It is not a reason for NO_ACTION on that
  Objective and not a reason to change its standing decision.

  Several requests may concern the same subject or next step. Each receives its own answer. If their answers
  propose or advance the same underlying next execution step, they account for that shared step rather than
  independently proposing it twice.
```

Four sentences carry the four semantics of checkpoint §5–§8. What the block deliberately does **not** say: that a requested decision wins; that a standing decision must be NO_ACTION when a request exists; that one work item takes one decision; that several requests must converge (two requests may concern the same subject, ask different questions and reach different decisions — only a shared proposed step must not be independently duplicated); anything about priority, capacity, or which decision is more important.

**Diff, in one view (0.3.1 → 0.4.0):** the version line; the block above. Every other line identical. Digest computed and pinned at implementation, after this text is agreed; parity tests assert the four sentences and the survival of every prior passage.

## 2. What stays frozen

The 0.2.1 materiality text, the 0.2.0 NO_ACTION definition and schedule sentence, the 0.3.x request paragraph, the three decisions, gates 1 and 2, renderers, the existing-work envelope, `1b/overlays/R1|R2|R4.json`, `1c/decisions/K1a|K2a|K2b|K3a|K4a.json`, the seven-item context, `gemini-3.5-flash` at the same temperature. The 1C artifacts are the before; `1c1/arm/` is the after.

## 3. The matrix — the frozen 1C matrix, rerun once

| run | overlays | requests | before (1C, 0.3.1) | reading that says the semantics landed | reading that says they overcorrected | reading that says they did not land |
|---|---|---|---|---|---|---|
| **K1** | R2 | K1a (athlete: gorjana post?) | no suppression; gorjana → REQUEST_INTELLIGENCE; positioning owned the term-sheet step | the same: standing decisions decided on their own evidence; positioning still acts on the term sheet (no request concerns it); gorjana still asks | **suppression**: any standing decision NO_ACTION or changed because a request exists on another subject; positioning standing down "because there is a request" | — |
| **K2** | R2 | K2a (agent) + K2b (athlete), same item | two answers, one proposed step (accept ×2); standing positioning planned other outreach | **both answers present**, consistent, converging on one proposed step; the standing decision accounts for it (cites a request) or stands on its own grounded reasoning about *additional* work | **collapsed multiplicity**: one request unanswered, refused, or answered "see the other"; or the standing decision NO_ACTION with no ground but the requests | the standing decision proposes the accept/counter step itself, uncited |
| **K3** | R2 + R1 | K3a (agent) | series and term sheet separate; audience NO_ACTION on the series; positioning **deferred** citing the request | the same: deferral kept and cited; audience still NO_ACTION on its own work; **no false deduplication** (the series is not treated as covering the term sheet, nor the reverse) | the audience decision changes because of the request (it concerns a different step); or the two work items merged | positioning proposes the counter independently |
| **K4** | R2 + R4 | K4a (agent) | Yuwa NO_ACTION on its outreach; audience planned; **positioning duplicated the request's counter** | positioning accounts for the request (cites `request[K4a]`) and does not propose the counter itself — NO_ACTION, `no_new_work`, or grounded *additional* work that is not the step; Yuwa still NO_ACTION on its own work; audience still decided on its own evidence | Yuwa or audience suppressed with the request as the only ground; positioning NO_ACTION **without** citing the request (silent suppression rather than accounting) | **the same counter proposed twice again** |

**The pass condition is joint:** K4's duplicate gone **and** K1 unsuppressed **and** K2's two answers kept **and** K3's separate work still separate. Any one of the overcorrection column entries fails the test even if K4 improves.

## 4. What is read, and how

The same audit vocabulary as 1C, from the existing output: which decision claims a proposed next step; on which work item; which Objective(s) it advances; whether another decision claims the same step; whether two work items merely advance one Objective; whether a standing decision manufactures work already covered by a request; whether a request suppresses an unrelated standing decision; contradictions. The ownership table per run; the before/after against 1C on the stable fields (type, path, relation, `request[…]` citations); the four predeclared readings (coherent and legible · coherent by suppression · incoherent · illegible), with **coherent by suppression** now the named overcorrection outcome.

**Kept outside this test, recorded only if they recur:** rate/floor semantics (accept vs counter); the StartX1 information condition; schedule-gap grounding; cross-advancement; prioritisation; events; the Recommendation boundary. None is a pass/fail criterion here.

## 5. Cost, calls, rules

Four calls at ≈ 13k input tokens: **≈ $0.14**. Nothing materialised; StartX1 untouched and unread; no `information_available` writer; no coherence gate; no production contract; no Campaign/Studio integration.

## 6. Not done

No spec change (the block above is proposed text), no provider call, no rerun of 1C, no gate, no field, no schema.

---

**Approved (26 Sep):** the block in §1 with the corrected final paragraph; the joint pass condition and overcorrection column in §3; the four calls, to run once after the chain is merged.
