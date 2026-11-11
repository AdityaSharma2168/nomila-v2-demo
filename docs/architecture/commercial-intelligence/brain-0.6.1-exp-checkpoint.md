# Brain 0.6.1-exp — schema fidelity, invariant 1 amended, an invariant-1 backstop: checkpoint

**Status:** applied to the experimental harness; **no provider call**; nothing mounted. Offline regression only. No Rate, Deals, State, Campaign/Studio change; no brand-relationship work; no Deals' read experiment; #608 and #570 untouched.

**Decisions recorded from the #628 review:** Decision Subject boundary accepted at the experimental level (typed reference; Existing Work a lens; identity = source + subject + question; no further subject experiments now). Commercial Intelligence → Brain interface accepted at the experimental level (not mounted, not frozen). Invariant 2 accepted as is. Invariant 1: direction accepted, enforcement incomplete — this checkpoint. S1's floor-as-threshold recorded; Rates stay paused. StartX1 recorded in the reliability backlog (R1) as no longer incidental.

---

## A. The response schema, corrected

The 0.5.0 schema kept `required` minimal and the provider omitted conditional fields in two of five sets. 0.6.1 expresses the contract structurally: **one schema branch per decision value (`anyOf`), each requiring the fields the contract makes conditional on that value.**

| entry | branch | required |
|---|---|---|
| decisions / requested | `NO_ACTION` | id, decision, why, cites |
| | `RECOMMEND` | + `what`, `execution_path` (enum), `relation_to_existing_work` (enum); `advances` nullable, `not_seen` optional |
| | `REQUEST_INTELLIGENCE` | + `proposition`, `why_material`, `source_class` (enum) |
| deferred | `REQUEST_INTELLIGENCE` | + proposition, why_material, source_class |
| | `CONDITION_APPEARS_RESOLVED` · `NO_REQUEST` | id, decision, why, cites |

Identifiers stay enums of the run's own ids in every branch. The structural gate is unchanged and still runs on the reply; nothing was weakened. **Offline confirmation** (`server/scripts/intelligence/brainSchemaCheck.ts`, a validator for the schema subset used, run over the five recorded 0.6.0 replies):

```
C2   would have been REQUIRED to change: requested[0].execution_path, .relation_to_existing_work missing
G1   would have been REQUIRED to change: decisions[0].execution_path, .relation_to_existing_work; requested[0].source_class; deferred[0].source_class missing
S0 · S1 · G0   conform to the corrected schema
```

That is exactly the set the gate refused under 0.6.0 for missing fields, and nothing else. Whether Vertex accepts `anyOf` in `responseSchema` on this model is the one thing offline cannot show; Studio's 14 Sep 400 was on `responseJsonSchema`, a different field. A live confirmation, if wanted, is one call.

## B. Invariant 1, amended (exact text)

Version `brain-eval-spec/0.6.1-exp`; ceremony followed (amend → bump → unpin → parity → this exact-text review → repin `78b67221…`). The paragraph now reads, verbatim:

```
A COMMERCIAL BASIS IS ESTABLISHED OR IT IS NOT. Whether a decision depends on pricing is decided by its reasoning,
not by its verb: a decline, an accept, a counter or a NO_ACTION whose rationale judges an offer high, low, adequate,
inadequate, acceptable, unacceptable, worth taking or worth refusing — any economic comparison — depends on a
commercial basis. Where the commercial evidence you were shown says the relevant basis is NOT_ESTABLISHED, you do not
manufacture, infer or substitute one — not from an unrelated State value, not from public fame or earnings, not
from a rate for another type, not from another deal, and not from a floor whose unit is not established. Evidence
of stature or earnings is evidence; it is not a price basis. You REQUEST_INTELLIGENCE for the missing basis, or you
make a decision whose reasoning genuinely does not depend on an economic comparison — an exclusivity conflict, a
category the athlete avoids, an obligation already owed — and say which.
```

Nothing else in the canonical text changed. Not Ronaldo-specific; `findings[…]` is not forbidden evidence; the `work[…]` read alias is untouched (its removal is 0.7.0's, and this change is deliberately narrow).

## C. The invariant-1 backstop — what is general, and where it stops

**Is a safe, general backstop possible?** Partly, and the part that is possible is worth having. The violation has a structural half and a semantic half. The structural half is checkable exactly: *the answer is a RECOMMEND about a subject whose attached commercial assessment says `basis` or `band` is NOT_ESTABLISHED.* That precondition is read from the block, not from prose, and it encodes no athlete, no fixture and no evidence source. The semantic half — *the rationale makes an economic comparison* — is not checkable structurally; it is checkable lexically for the explicit vocabulary of comparison and not for comparison phrased without it.

**Built** (`grounding.ts`, `substitutesBasis`, run inside Gate 2 because it needs the attached assessment): refuse, never repair, when all of: the entry is a RECOMMEND; the commercial attachment for the cited subject carries a `basis` or `band` line beginning `NOT_ESTABLISHED`; the entry cites that subject or one of its lines; and `what` + `why` contain a word from a closed comparison list (inadequate/adequate, undervalued/overvalued, underpriced/overpriced, lowball, below/above market, "too low/high/little", "far/well/significantly/extremely below/above/under/over", "not worth", "worth accepting/declining", "insufficient/inadequate compensation", "commands far more", "the fee/offer/compensation is low/high/…"). Refusal text: *an economic comparison ("…") on a subject whose commercial basis is NOT_ESTABLISHED — request the basis or decide on reasoning that does not depend on one.*

**What it cannot see, stated plainly:** a comparison phrased without any listed word ("this is beneath him"); a comparison against a basis that *is* established but irrelevant (the wrong rate type — the S1 floor-as-threshold class); a REQUEST_INTELLIGENCE whose proposition embeds a comparison (by design out of scope: requesting is the sanctioned move). Those remain the prose's to govern, and the checkpoint does not pretend otherwise. The list is a backstop for the explicit case the two C2 runs actually produced, not the definition of the rule.

## D. Offline regression (recorded artifacts only; no provider call)

`brainRegate.ts` now re-runs both gates over recorded artifacts (older shapes backfilled read-only: `subjects`, item `ref`s, typed `about`, `subjectRef`).

| requirement | result |
|---|---|
| **C2** may no longer make an inadequacy judgment from public earnings when the basis is NOT_ESTABLISHED | **refused, both instances**: #623 C2 (`"undervaluation"`) and 0.6.0 C2 (`"inadequate"`) — grounding 0 → 1 each |
| **S1** may still REQUEST_INTELLIGENCE and cite evidence without constructing an amount | **unchanged**: 0.6.0 S1 structural 0 → 0, grounding 0 → 0 (a REQUEST is never the backstop's) |
| legitimate non-pricing declines remain possible | **yes** — test: a decline for an exclusivity conflict on the same NOT_ESTABLISHED subject passes both gates; a RECOMMEND that does not cite the subject is never examined |
| previous invariant-2 artifacts unchanged | **yes** — the same 15 refusals as under 0.5.0/0.6.0 (A1, A2, A3 ×3, A4, A5, B1, #625 S1, 1C K2–K4, 1C.1 K3), no additions, no removals; every other artifact 0 → 0 on both gates |
| corrected schema would have prevented the G1/C2 missing-field refusals | **yes** (§A) |

Tests: `grounding.test.ts` (backstop: C2 class refused; exclusivity decline passes; REQUEST passes; established basis untouched; other-subject untouched), `evalSpec050.test.ts` (amended text present at 0.6.1; schema branches and required lists), `evalSpec.test.ts` parity at `78b67221…`. **7 suites, 230 tests, green; `tsc` clean.**

## E. Where this leaves the Brain contract

| invariant | semantic rule | backstop | live evidence |
|---|---|---|---|
| a commercial basis is established or it is not | 0.6.1 text (reasoning, not verb) | Gate 2, structural precondition + closed comparison list | held on INIU (S1); would now refuse both Ronaldo answers |
| the amount is not the Brain's | 0.5.0 text | Gate 1, figure/opening-position in `what` on a work-citing RECOMMEND | held 5 of 5 under 0.6.0 |
| decision subjects | 0.6.0 text + lenses | Gate 2, `advances` must be in motion | held 5 of 5 |
| identifiers | — | provider schema + structural gate | 0 of 5 wrapped; conditional fields now required per branch |

## F. Not done

No provider call; no mounting; no Rate/floor/basis-typing work; no Deals, State, Campaign/Studio change; no brand-relationship work; no Deals' read experiment; the `work[…]` alias kept until 0.7.0; StartX1 (backlog R1) untouched by design. #608 and #570 untouched.

**Open for the next decision, not pre-committed:** whether one live call is warranted to confirm the `anyOf` schema is accepted and the amended invariant binds on the Ronaldo cell; and which architectural boundary follows, chosen from the evidence.
