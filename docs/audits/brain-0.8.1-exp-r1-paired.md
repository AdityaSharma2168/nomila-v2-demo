# Brain 0.8.1-exp — the paired R1 experiment: one StartX1 information deferral, two evidence conditions, 27 Sep 2026

**Status:** two provider calls, one per cell, run back to back with **no prompt, schema or gate change between them**; neither rerun. Artifacts: `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/r1/{N,P}/`; the P projection `slice/r1/P-startx1.research.json` (built by `server/scripts/intelligence/brainR1Fixture.ts`, deterministic, no provider, no DB); the dry renders `slice/r1/dry/{N,P}` record the prompt difference. Spec `brain-eval-spec/0.8.1-exp`, digest `468d8790…`, model `gemini-3.5-flash`. Cost **USD 0.050** (N 0.026 · P 0.024).

**Result: R1 / deferred-information evidence discipline is closed at the experimental level.** N produced no false resolution — a REQUEST_INTELLIGENCE with a valid typed need. P produced `CONDITION_APPEARS_RESOLVED` citing the responsive `research[0]` and nothing incidental, and Gate 2 passed it. Both cells: Gate 1 0 problems, Gate 2 0 problems, re-gated 0→0.

## 1. What differed between the cells — exactly one thing

| | N (historical evidence only) | P (positive control) |
|---|---|---|
| deferral | StartX1 `2d199757…`, kind `information`, "When u know more about this" | same |
| State inbound signals | `commercialPosition.inbound[3]`, `[6]`, `[9]` (StartX1, 14 / 4 / 2 Sep) — the same three every flip cited | same |
| opening | `opportunity[amplify-inbound-startx1-interest]` | same |
| live Objectives, work, context, map | Mia's three live Objectives · 8 work items · the 7-item context block · 6 openings | same |
| RESEARCH block | **none** (0 chars) | **one block, 830 chars**: proposition "StartX1's proposed commercial terms … are documented.", `requestedBy {run: R1-P, objectiveId: 2d199757…}`, class `connected`, one reference `inbox_messages:msg-controlled-startx1-reply` |
| prompt | 57,099 chars · sha `3f0bb84c…` | 58,043 chars · sha `3d978ba7…` (+944 = the block and its header) |

**The P evidence is controlled, not real.** The reply it describes (three-month ambassador engagement, USD 6,000 flat plus product, three posts and one campus appearance, no category exclusivity, own-channel usage for the term) exists only in the fixture. It reached the block the way real evidence would: raise (need `counterparty_terms`, class `connected`) → resolver `connected_read` → acquisition started → attributable `inbox_messages` reference received → `evidenced` → `evidencedRequestAsResearchBlock`. No athlete interaction, no real acquisition, nothing written anywhere.

## 2. Cell N — historical evidence, no responsive block

| item | result |
|---|---|
| raw deferred decision | **REQUEST_INTELLIGENCE** |
| proposition | "StartX1 is a reputable business with commercial alignment and values that support Mia Bhuta's academic and ethical standards." |
| typed `need` · source class | **`counterparty_profile`** · `external` |
| why | "Mia deferred the proposed StartX1 commercial partnership explicitly to wait until more is known about the company. Gathering an objective business profile is necessary to resolve her information condition." |
| citations | `deferred[2d199757…]` (her reason) · `commercialPosition.inbound[3]` ("repeated direct inbound interest … motivated counterparties") |
| Gate 1 | 0 problems — need present, single, valid; proposition and materiality present |
| Gate 2 | 0 problems — the rule does not touch a REQUEST |
| responsive evidence cited | none exists; none claimed |
| incidental StartX1 evidence used as resolution support | **no** — `inbound[3]` is cited as motivation for the request (the counterparty is real and interested), not as an answer to her condition |
| three-way distinction | **respected**: new evidence about the subject exists (the inbounds), the Brain treats it as exactly that and asks for what would be responsive |
| need agrees with the proposition | yes — "who are they, are they aligned" is a profile question; the class `external` is the right authority for it |
| one proposition, one need | acceptable — one fact-class (the counterparty's profile), though the wording bundles reputation, alignment and values; recorded, not a defect under the identity rule (need is identity, wording is not) |
| NO_REQUEST | not emitted; not needed |

The five flips all answered this exact input with `CONDITION_APPEARS_RESOLVED` citing `inbound[3]`, `[6]`, `[9]` and the opening. Under 0.8.1 the same inputs produced a request. Had the flip recurred, Gate 2 would have refused it (offline, `resolution.test.ts`, and the five re-gated historical artifacts in #635).

## 3. Cell P — the positive control

| item | result |
|---|---|
| raw deferred decision | **CONDITION_APPEARS_RESOLVED** |
| why | "The athlete's information condition for deferring the StartX1 partnership is satisfied, as research has successfully retrieved and documented the exact proposed terms, including compensation, term, and deliverables." |
| citations | `deferred[2d199757…]` (her condition) · **`research[0]`** ("Details the proposed commercial terms from StartX1, including the three-month term, USD 6,000 flat fee, and specific deliverables.") |
| Gate 1 | 0 problems |
| Gate 2 | **0 problems** — `research[0].requestedBy.objectiveId === 2d199757…`; the rule admits it |
| responsive evidence cited | **yes**, and it is the only evidence cited beyond the deferral itself |
| incidental StartX1 evidence used as resolution support | **no** — `inbound[3]`, `[6]`, `[9]` and the opening are not cited anywhere in the P output, although they were present and identical to N |
| three-way distinction | (1) new evidence exists → not used; (2) responsive evidence available → cited; (3) proposition established → the Brain judged it so. **The 2→3 step was made as a judgment, not by reflex**: her words were "know more about this", the responsive block documents the terms, and the Brain's `why` names what it now knows. It did not request further intelligence; that is a legitimate reading of an open-ended condition and is recorded, not scored |
| a REQUEST for further intelligence | not emitted (would not have been a failure) |
| invariant 2 (the amount is not the Brain's) | holds — the USD 6,000 appears only as the counterparty's stated figure, quoted from the block; no construction, no recommendation on the deferral |

## 4. The naming pressure, observed once

The P `why` says "research has successfully retrieved and documented the exact proposed terms". The evidence was a (controlled) brand reply in `inbox_messages`, projected through the RESEARCH envelope because that envelope already carries `requestedBy.objectiveId` — the clarification recorded in the R1 checkpoint §9a before this call. The provider read the envelope's name as provenance. One observation, no consequence for the gate (attribution is checked on the block, not on the prose); recorded as the first instance of the naming/schema pressure the checkpoint anticipated. Not renamed.

## 5. What the pair proves that the tests could not

Offline, the rule refuses the recorded failure class and admits an attributable block. Live, under the 0.8.1 text: (a) shown only subject-adjacent evidence, the provider **did not** call the condition resolved and asked for a typed, valid need instead; (b) shown responsive, attributable evidence for the same Objective, the provider **did** call it resolved, citing that evidence and not the incidental signals. Same prompt otherwise, same session, one call each. The deferred decision was moved by the responsive block and by nothing else that differed.

## 6. Closure

**R1 / deferred-information evidence discipline — closed at the experimental level.** Both acceptance conditions met. What remains outside the closure: `information_available` still has no writer; the real Mila acquisition path is not built; whether a documented set of terms "establishes" an open-ended "know more" condition remains the reconsidering Brain's judgment and was exercised once.

## 7. Not done

No athlete interaction; no materialisation; no mounting; no Recommendation materialisation; no `information_available` writer; no Mila acquisition path; no Deals / Rate / State / Campaign / Studio / brand-relationship change; no repeatability matrix. #608 remains the Context Intelligence control. #570 untouched.
