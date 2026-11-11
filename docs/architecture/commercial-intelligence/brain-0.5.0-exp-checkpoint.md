# Brain 0.5.0-exp — the two commercial invariants, structured identifiers, zero-record rendering: checkpoint

**Status:** applied to the experimental Brain and its harness; **nothing mounted**; no provider call made under 0.5.0. No Rate change, no Deals production behaviour change, no State change, no Campaign/Studio change. #608 and #570 untouched. The thin-slice question is closed at the experimental architecture level per the 26 Sep review of the acceptance audit.

**Ceremony followed:** amend → bump (`brain-eval-spec/0.4.0-exp` → `0.5.0-exp`) → unpin → parity → exact-text review (this page, §1) → repin (`765cb220…`).

---

## 1. Exact Brain spec changes

Two paragraphs added to `BRAIN_DECISION_BLOCK`, between the REQUEST_INTELLIGENCE materiality text and "FOR EACH REQUESTED DECISION". Nothing else in the canonical text changed. Verbatim:

```
A COMMERCIAL BASIS IS ESTABLISHED OR IT IS NOT. Where a commercial decision depends on a pricing, rate or economic
basis and the commercial evidence you were shown says that basis is NOT_ESTABLISHED, you do not manufacture,
infer or substitute one — not from an unrelated State value, not from public fame or earnings, not from a rate for
another type, not from another deal, and not from a floor whose unit is not established. You REQUEST_INTELLIGENCE
for the missing basis, or you make a decision that does not depend on pricing.

THE AMOUNT IS NOT YOURS. You may decide that Nomila should accept, counter, negotiate, ask, wait or decline, and say
why. You do not construct, select or propose the fee, rate, counter or ask amount used to execute that decision:
no arithmetic, no multiplication or addition of floors or rates, no floor chosen as the opening ask, no card value
chosen as the counter, no "counter at", no "starting at". The execution path determines the amount from whatever
commercial semantics are current when it acts. You may cite an existing amount as evidence — "the offer is USD
5,000"; "her recorded floor is USD 1,000, unit not established" — and you may not turn that evidence into a figure
to execute.
```

Digest: `BRAIN_CANONICAL_SHA256 = 765cb220f503fa8027503dd78c71828ad038466cc7f5f0ec006a3d7fa6aacbda` (was `ffb97cd4…`). `BRAIN_EXPERIMENT_VERSION = "brain-eval-spec/0.5.0-exp"` in `contract.ts`. Evidence behind each: the first — #623 C2 (Ronaldo priced from researched earnings with no basis) and #625 S1 (INIU priced from an unit-less social-post floor with `basis NOT_ESTABLISHED`); the second — #623 A1 (7,602), A2/A3/A4 ("3,602 per deliverable"), A5 (14,408) and #625 S1 ("starting at her $1,000 … floor").

**Gate-1 backstop** (`evalSpec.ts`, `constructsAmount` inside `validateDecision`, inherited by `validateRequestedDecision`): a RECOMMEND whose `cites` include a `work[…]` reference and whose `what` carries a currency figure (`USD 3,602`, `$1,000`, `7,602 dollars`) or an opening-position phrase ("counter at her floor", "starting at the rate card mid") is refused with `what constructs the execution amount ("…") — the amount is not the Brain's`. Refuse, never repair. Deliberately narrow: only `what` is gated (an amount cited in `why` or in a cite is evidence and passes); a RECOMMEND that cites no work item is not the commercial backstop's to refuse; a figure-free adoption of a floor as the ask ("meets or exceeds her established ambassador floor", #623 A3-3) is **not** caught by the backstop and is governed by the prose alone. The regex is a backstop, not the semantic definition, as the review directed.

## 2. Exact structural / schema change for identifiers

`brainResponseSchema(ctx)` in `evalSpec.ts` (a plain object, no SDK import — `intelligence/` may not import providers) builds the provider's OpenAPI-style schema from the run's own ids; `brainExperimentOrchestrator.ts` sends it as `config.responseSchema` with `responseMimeType: "application/json"`. For the S1 cell the exact schema is recorded at `ci-boundary/slice/dry-050/S1/S1.responseSchema.json`; its identifier fields:

```
decisions[].objective_id   { type: STRING, enum: [b1c799e3-…, c0f587e4-…, feb62891-…] }      the live ids
requested[].request_id     { type: STRING, enum: [S-agent] }                                  the request ids
deferred[].objective_id    { type: STRING, enum: [2d199757-…] }                               the deferred ids
decision / execution_path / relation_to_existing_work / source_class   enums of the contract's values
what · why · proposition · why_material · cites[].ref · cites[].how · not_seen[]              free strings
required: decisions; per entry: id, decision, why, cites
```

The structural gate is unchanged and still runs on the reply: an answer for a decision nobody requested, a decision missing for a live Objective, forbidden fields, production verbs, and the new amount backstop are all still the gate's to refuse. Where a run has no requests, `request_id` is a free string (the gate refuses any unrequested answer). Two things to record before the first live call under 0.5.0: Studio's `interpret/1` got `400 INVALID_ARGUMENT` from Vertex when it sent `responseJsonSchema` on 14 Sep, so this uses the older `responseSchema` shape the SDK types as `Schema`; and a schema may change sampling, so the first live runs are read for decision-content drift against the #623 A3 pattern, per the review ("record whether the schema affects output behavior").

## 3. Exact evidence-rendering correction

`inputBlock.ts` — new `deliverablesLine(n)`, used by the existing-work renderer and by the projection's `.thread` line:

| before | after |
|---|---|
| `deliverables recorded: 0` | `Nomila holds no deliverable records for this deal; actual deliverable obligations are NOT_ESTABLISHED` |
| `deliverables recorded: 2` | `Nomila holds 2 deliverable records for this deal` |
| header: "`deliverables recorded: 0` means Nomila holds no deliverable for it — not that there are none." | "Where Nomila holds no deliverable records for an item, its actual deliverable obligations are NOT_ESTABLISHED — zero records is not zero obligations." |

Rendered in `dry-050/G1/G1.prompt.txt` on the gorjana item and in the projection's `.thread`. The general rule stated on the block: **zero records observed by Nomila ≠ zero things in the world.** Other count-as-fact lines already carry it (`.observed`: "A count of Nomila's records is not a count of real-world history"; `.contract`: "a missing record, not a missing contract"). Left as they are, recorded, because they are State: `commercialPosition.closedDeals 0 [measured · HIGH]` and `activeRelationships []` (the §0.1.2 defect of the boundary checkpoint) — a State correctness item, not touched here by instruction.

## 4. Tests proving the invariants

`server/services/intelligence/brain/evalSpec050.test.ts` (5 cases): both invariants present in the canonical text at 0.5.0; the backstop refuses the four recorded figure-bearing `what`s (A5, A1, S1, and "Counter, starting at her floor.") on both the standing and the requested path; figure-free decisions pass and amounts cited in `why` are never refused; a figure in a plan RECOMMEND that cites no work item is not the backstop's to refuse; the schema enumerates ids and contract values and leaves free text free. `evalSpec.test.ts` parity now pins `765cb220…` and asserts the 0.5.0 version. `existingWork.test.ts` reads the version constant. Result: **7 suites, 228 tests, green** (Brain, boundary lock, projection, commercial-assessment envelope); `tsc` clean.

## 5. Recorded experimental artifacts that now intentionally fail

`server/scripts/intelligence/brainRegate.ts` re-runs the current gates over recorded artifacts offline (no provider). Under 0.5.0:

| artifact | recorded → now | new refusal |
|---|---|---|
| #623 A1, A2, A3-1, A3-2, A3-3, A4, A5, B1 | +1 each | `what constructs the execution amount` ("USD 7,602" in A1; "USD 3,602" in the rest) |
| #625 S1 | 4 → 5 | `"$1,000"` |
| 1C K2 (both answers), K3, K4 | 0 → 2 / 1 / 1 | "USD 7,602" ×3; "USD 5,000" (K3's accept restated the offer amount in `what`) |
| 1C.1 K3 | 0 → 1 | "USD 7,500" (gorjana's cash restated in `what`) |
| everything else (A0, B0, C0, C2, D0, D2, G0, G1, S0, 1C K1, 1C.1 K1/K2/K4) | unchanged | — |

All of these are the intended effect. Two are worth a note: 1C K3 and 1C.1 K3 are refused for *restating an existing amount in `what`* ("accept the USD 5,000 term sheet"), which the prose permits as evidence — the backstop gates `what` only, so a figure belongs in `why`; that is the price of a narrow backstop and is recorded rather than tuned. (1B.3's D-series artifacts predate the `requests` field on inputs and re-gate spuriously as "unrequested"; a tooling artefact of the older artifact shape, not a spec effect.)

## 6. What remains before the first real Commercial Intelligence → Brain integration can be mounted

Not started, in the order they block:

1. **A subject for a commercial opportunity that is not yet work.** The `inbound` kind stays an isolated experimental door (the review's finding: *Brain decision subjects are broader than Existing Work*); it contaminated one answer with `advances_existing_work`. The durable subject (Commercial Opportunity, Opportunity, work, or another reference) is a decision-subject / event-architecture question. Blocking for any production request about an inbound.
2. **The producer's home and trigger.** `projectDealAssessment` runs from rows on demand in the harness; production needs to say when it is assembled (on request, on thread change), where its output is cited from, and that it never writes. A projection over existing columns; no schema freeze implied.
3. **Two things the first live 0.5.0 runs must show** before anything mounts: that Vertex accepts `responseSchema` on this model and that the schema does not move decision content; and that the two invariants hold on S1 and C2 (the two recorded failures they were written for). A small acceptance run, not a matrix — proposed as the next approval, on the same S0/S1/G0/G1 cells plus C2.
4. **Unit-typed basis and floors** stay a requirement on Commercial Intelligence / Rate, logged and paused. 0.5.0 makes the Brain safe *without* them (NOT_ESTABLISHED → request or decide without pricing); it does not make them unnecessary.
5. **Where a Brain decision goes.** Nothing consumes a Brain output today. Mila's proposal surface, the inbox card beside Deals' read, or nowhere yet — the integration checkpoint proper.
6. **The State count-as-fact defect** (§3) before public athletes are evaluated in production.

## 7. Where this leaves us in the canonical architecture, and the next boundary

```
OBSERVE → UNDERSTAND → STATE → OPPORTUNITY → OBJECTIVE → RECOMMEND / SHARED BRAIN → EXECUTION PATH → EXECUTE → MEASURE → LEARN
              │                                                    │
              ├ Athlete Intelligence                               ├ Direct Action  ─▶ Deals execution (the amount is decided HERE)
              ├ Commercial Intelligence  = the Deals producers,    ├ Specialized Plan
              │   exposed as a read-only, citable assessment of    └ Campaign …
              │   a commercial subject (experimental projection);
              │   Rate underneath, replaceable, paused
              └ Context / Opportunity Intelligence
```

Settled at the experimental level: Commercial Intelligence understands the deal and exposes decision-useful meaning as cited lines; the Brain decides WHAT/WHY across the athlete's whole business and, as of 0.5.0, neither manufactures a basis nor sets an amount; Deals executes HOW including the figure. Decision-relative consumption is the norm (G1). Deals' read rides as labelled evidence, untested until a case where it should diverge arises naturally.

**The next highest-value semantic boundary is the decision subject.** Every experiment since 1B.3 has posed a Decision Request *about* something, and the set of things a request can be about is the envelope's weakest contract: an Objective or a work item, with detections, opportunities from the map, brand relationships and events all outside it. The review's finding names it: *a detected commercial opportunity must be addressable by a Decision Request before it becomes work in motion; therefore Brain decision subjects are broader than Existing Work.* It is the boundary that blocks mounting (§6.1), it is where the inbound contamination came from, and it is shared by Campaign and Studio, whose subjects (a brief, a content series, a moment) are no more addressable today than an inbound. Recommended as the next checkpoint: the decision-subject / event architecture — what may be the subject of a Decision Request, how a subject is referenced and cited, and how it relates to Existing Work, Opportunity, and the athlete's relationships — designed, not experimented, first.

Second, not blocking: Deals' read divergence, to be observed when a real case arrives; and the State count-as-fact correction.

## 8. Not done

No provider call. No mounting. No change to `existingWorkFrom`, the inbound taxonomy, Deals, Rate/floors, State, Campaign/Studio. #608 and #570 untouched.

---

**Requested decisions:** (1) accept 0.5.0-exp as rendered; (2) approve the small acceptance run named in §6.3 (S0, S1, G0, G1, C2 under 0.5.0 with the response schema) as the next step, or defer it behind the decision-subject checkpoint; (3) take the decision-subject / event architecture as the next design checkpoint.
