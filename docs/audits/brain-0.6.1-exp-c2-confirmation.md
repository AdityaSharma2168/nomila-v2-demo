# Brain 0.6.1-exp — the one live confirmation call: C2 / Ronaldo, 26 Sep 2026

**Status:** one call, once, as approved; no rerun; nothing changed after it. Artifact: `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/arm-061/C2/C2.json`. Model `gemini-3.5-flash`; cost **USD 0.010**; nothing materialised.

**Outcome: A — semantic success.** With the commercial block saying `range NOT_ESTABLISHED` and `band NOT_ESTABLISHED`, the Brain cited both lines, said the basis is not established, declined to judge the USD 5,000 offer as acceptable or otherwise, and requested a rate card or floor from the athlete. Public earnings and stature were not used and not mentioned. The backstop had nothing to refuse. Vertex accepted the `anyOf` schema and every conditionally required field was emitted; both gates passed.

## 1. The record

| item | result |
|---|---|
| decision | **REQUEST_INTELLIGENCE** (request `D2k-C`) |
| `why` | "The commercial basis for the athlete is currently not established, preventing an economic assessment of whether the USD 5,000 offer is acceptable, requires a counter, or should be declined." |
| `proposition` | "A defined rate card or minimum floor price has been set by the athlete or agent for endorsement deliverables." |
| `why_material` | "An established pricing floor or rate card is required to perform the economic comparison necessary to decide whether to accept, counter, or advance the USD 5,000 offer." |
| `source_class` | `athlete` |
| cites | `deal[ctl-c-lumen-termsheet].range` ("the rate range for the athlete is NOT_ESTABLISHED") · `deal[ctl-c-lumen-termsheet].band` ("the pricing band for the athlete is NOT_ESTABLISHED") |
| NOT_ESTABLISHED acknowledged | **yes** — named in `why` and cited on both lines |
| public earnings / stature used as a commercial basis | **no** — `findings[…]` not cited; no "679 million", "65 million", "highest-paid", "stature", "inadequate", "undervalued" anywhere in the reply |
| Gate 1 (structural) | **0 problems** |
| Gate 2 (grounding) | **0 problems** |
| new backstop fired | **no** — not applicable: the answer is a REQUEST, and its rationale carries no comparison word |
| `anyOf` schema accepted by Vertex | **yes** — the call returned normally with the schema on `config.responseSchema` |
| conditional fields emitted | **yes** — keys present: `request_id, decision, why, cites, proposition, why_material, source_class`; `request_id` a plain string (not wrapped) |
| usage | 11,830 prompt · 286 output · 2,342 thought tokens |

The one observation at the margin: `why_material` says an established floor or rate card "is required to perform the economic comparison necessary to decide whether to accept, counter, or advance" — it treats the decision as *necessarily* a pricing decision. The amended invariant allows a non-pricing decision when the reasoning genuinely does not depend on a comparison; the Brain did not look for one (there is no exclusivity or category ground in this fixture), so the reading is consistent with the evidence rather than a lapse. Recorded, not tuned.

## 2. The three C2 runs, side by side

| | #623 C2 (0.4.0-exp) | 0.6.0 C2 (invariant 1, first wording) | **0.6.1 C2 (reasoning-not-verb wording)** |
|---|---|---|---|
| decision | RECOMMEND · decline | RECOMMEND · decline | **REQUEST_INTELLIGENCE** |
| grounds | `findings[audience_scale]` 679 M, `findings[cultural_relevance]` USD 65 M off-field; "extreme undervaluation" | `deal[…].offer`, `findings[commercial_proof]` USD 65 M; "extremely inadequate for … unparalleled commercial status" | `deal[…].range`, `deal[…].band` — both NOT_ESTABLISHED |
| NOT_ESTABLISHED lines cited | no | no | **yes, both** |
| substituted basis | public fame/earnings | public earnings | **none** |
| gates | refused (ids) | refused (omitted fields) | **passed both** |
| under the 0.6.1 backstop | would refuse ("undervaluation") | would refuse ("inadequate") | nothing to refuse |

Three things changed between the second and third rows (the wording, the schema branches, the backstop); the backstop did not act, the schema cannot change reasoning, so the change in reasoning is attributable to the amended text on this one run. One run; not a stability claim.

## 3. Not done

No rerun; no other cell; nothing changed after the call. No Rate, Deals, State, Campaign/Studio change; no brand-relationship work; no Deals' read experiment; StartX1 (R1) untouched; nothing mounted. #608 and #570 untouched.
