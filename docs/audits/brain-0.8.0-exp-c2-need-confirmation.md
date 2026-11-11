# Brain 0.8.0-exp — the one provider call: C2 emits a typed `need`, 26 Sep 2026

**Status:** one call, once, as approved; no rerun; nothing changed after it beyond the feed script's two flags (`--need-from-output`, `--until-payload`) that read the real output and stop before any workflow step. No athlete interaction, no `await_human` step created, no acquisition started, nothing materialised. Artifact: `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/arm-080/C2/C2.json`; feed: `slice/acquire-c2-080/`. Model `gemini-3.5-flash`; cost **USD 0.013**.

**Acceptance criterion — met on all seven clauses:** (1) exactly one valid typed need emitted; (2) it agrees with the proposition; (3) the proposition contains one information need; (4) both gates pass; (5) the Intelligence Request reconciles by decision + need with no prose-derived identity; (6) the resolver selects the mechanism from the typed request and capability facts; (7) no downstream code infers the need from prose.

## 1. The call

| item | result |
|---|---|
| decision · subject · question | the athlete's agent, through Mila · `deal[ctl-c-lumen-termsheet]` · "Should this negotiation be advanced, countered or accepted?" |
| decision type | **REQUEST_INTELLIGENCE** |
| proposition | "Cristiano Ronaldo has an established commercial rate card or minimum fee requirement for digital ambassador agreements." |
| why / materiality | "The commercial basis for Cristiano Ronaldo is not established, meaning we cannot perform an economic evaluation of the USD 5,000 offer…" · "Establishing a commercial basis will allow us to determine if the USD 5,000 term sheet is acceptable, requires a counter-offer, or should be declined." |
| `source_class` | `athlete` |
| **typed `need`** | **`athlete_commercial_basis`** — emitted by the provider, present in the raw JSON, a value of the closed enum |
| need agrees with the proposition | **yes**: a rate card or minimum fee for a deliverable type is exactly what the kind names; no other kind fits |
| exactly one information need | **yes**: one fact (a basis for digital ambassador agreements); no conjunction of independently establishable facts |
| citations | `deal[…].range` (NOT_ESTABLISHED), `deal[…].band` (NOT_ESTABLISHED), `commercialPosition.pricingEvidence` ("no pricing evidence recorded") |
| Gate 1 | **0 problems** (need present, single, valid; ids plain; conditional fields present under the `anyOf` schema) |
| Gate 2 | **0 problems** |
| invariant 1 (a basis is established or it is not) | **holds** — the basis is cited as NOT_ESTABLISHED and requested; no stature, fame or earnings anywhere in the reply |
| invariant 2 (the amount is not the Brain's) | **irrelevant and holds** — a REQUEST, no `what`, no figure beyond the cited USD 5,000 offer |
| usage | 12,467 prompt · 233 output · 3,591 thought tokens |

## 2. The deterministic feed of the real output

| item | result |
|---|---|
| request id · key | `req_a0be3b1b7b2ea481` · `1d836bb6a0a37db9` |
| identity | decision (source · `deal[ctl-c-lumen-termsheet]` · question) + `athlete_commercial_basis` — **the same key the fixture-annotated 0.6.1 run produced**, although the two propositions are worded differently ("A defined rate card or minimum floor price has been set by the athlete or agent…" vs "…has an established commercial rate card or minimum fee requirement…"): wording is not identity, in practice as in design (the run label in the feed script is a constant, so the id also coincides; the key is what matters) |
| current proposition · source class · need | the 0.8.0 wording · `athlete` · `athlete_commercial_basis`, all read from the output, none inferred |
| resolver mechanism | **`mila_question`** |
| chosenBecause | need establishable by `preferences_form · mila_question · document_request`; authority required `athlete`; all three available (no floor stated for the type, no connected source, no document); chosen by lowest athlete burden within the class |
| acquisition payload producible without interpreting the proposition | **yes** — `{ asks: intelligence_request, request_id, need: athlete_commercial_basis, question, fields: [amount, currency, per], why }`; the need field drives the mechanism map; the proposition travels only as the Brain's words |
| stopped | before any `await_human` step; no acquisition started; the request ledger written as a file with the request `open` |

## 3. Comparison with the prior C2 runs

| | #623 C2 (0.4.0) | 0.6.0 C2 | 0.6.1 C2 | **0.8.0 C2** |
|---|---|---|---|---|
| decision | RECOMMEND decline (fame) | RECOMMEND decline (earnings) | REQUEST (basis) | **REQUEST (basis)** |
| typed need | — | — | — (fixture-annotated in the dry slice) | **emitted: `athlete_commercial_basis`** |
| gates | refused (ids) | refused (omitted fields) | passed | **passed** |
| downstream | nothing | nothing | dry slice on a fixture need | **raise → resolve → payload on the real output** |

## 4. What the call proved that the tests could not

Only the question it was run for: the provider, under the 0.8.0 contract and schema, **emits a typed need that agrees with the proposition it says is missing, and states one need per proposition** — on a real REQUEST. Everything downstream ran deterministically on that output exactly as it had on the fixture.

## 5. Not done

No `await_human` step, no athlete interaction, no acquisition, no materialisation, no mounting, no Recommendation materialisation, no Deals / Rate / State / Campaign / Studio / brand-relationship change, no StartX1 backstop, no repeatability run. #608 and #570 untouched.
