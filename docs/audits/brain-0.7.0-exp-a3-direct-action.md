# Brain 0.7.0-exp — the one provider call: A3 (the Northlight term sheet) through the direct-action seam, 26 Sep 2026

**Status:** one call, once, as approved; no rerun; nothing changed after it except two harness plumbing fixes that touch no semantics (§5). **The Deals draft route was not called; no pending action was created; the Recommendation was not materialised** — the seam was exercised to the rendered payload and stopped. Artifact: `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/arm-070/A3/A3.json`; ledger: `slice/recommend-070/recommendations.json` (a file). Model `gemini-3.5-flash`; cost **USD 0.031**.

**Acceptance criterion:** a commercial RECOMMEND whose typed intent agrees with its strategic reasoning; reconciliation creates or reaffirms the correct Recommendation; the resulting Deals payload expresses the instruction without prose reinterpretation, without an amount from the Brain, without subject reconstruction, and without moving HOW upstream. **Met on every clause.**

## 1. The record

| item | result |
|---|---|
| decision (request `D2k`, her agent through Mila) | **RECOMMEND** |
| subject | `deal[ctl-r2-northlight-termsheet]` — the request's `about`, unchanged |
| `what` | "Counter the Northlight Learning ambassador term sheet to bring the commercial compensation in line with her established per-deliverable floor." |
| `why` | "The Northlight Learning ambassador term sheet offers a per-deliverable value of USD 1,250, which is below Mia's established ambassador floor of USD 3,602. A counter is required to align the terms with her financial requirements." |
| execution path · relation · advances | `direct_action` · `advances_existing_work` · `deal[ctl-r2-northlight-termsheet]` (the item is in EXISTING WORK as a negotiating overlay — allowed) |
| **typed intent** | **`counter`** — emitted by the provider, present in the raw JSON, a value of the closed enum |
| intent consistent with `what` / `why` | **yes**: the sentence is a counter, the rationale is a below-range reading, the intent is `counter`; no other value fits |
| citations | `deal[…].basis` (USD 1,250 per deliverable), `representation.floors[ambassador]` (USD 3,602), `deal[…].band` (below her range) |
| Gate 1 | **0 problems** (the intent rule satisfied; no amount in `what`; ids plain; all conditional fields present under the `anyOf` schema) |
| Gate 2 | **0 problems** (all cites resolve; `advances` names an in-motion item; the invariant-1 backstop has nothing to refuse — the basis is established in this cell) |
| amount leaking from the Brain | **none in `what`**; `why` cites USD 1,250 and USD 3,602 as evidence (the block's own figures), which is what 0.5.0 permits; no counter figure, no opening position |
| reconciliation | **created** `rec_94b6d20dee8c9b5a` (fresh ledger; key = source · subject · question · direct_action · advances; `intent counter`); the two standing plans created as non-commercial records; the positioning NO_ACTION created nothing |
| Recommendation record | subject `{kind: deal, id: ctl-r2-northlight-termsheet}`, value with `intent: "counter"`, response/authorization/execution all `none`, outcome null, `reconsiders` null |
| **Deals `ExecutionIntent`** | `subject deal[ctl-r2-northlight-termsheet] · dealId ctl-r2-northlight-termsheet · intent counter · considerations [] · constraints [] · objectiveIds []`; `carries no amount: true` |
| Deals would receive | `POST /api/v1/me/deals/ctl-r2-northlight-termsheet/draft` `{ reply_intent: "negotiate", selected_terms: [], style: "friendly", voice: "athlete", include_media_kit: false }` — **not called** |
| then propose | `{ kind: "send_reply", payload: { body: <Deals' draft>, recommendation_id: "rec_94b6d20dee8c9b5a", subject: "deal[ctl-r2-northlight-termsheet]" } }` — **not created** |
| subject survives unchanged | yes: request `about` → Recommendation `subject` → intent `subject` → route `:id` → payload `subject`, all the same string |
| would Deals need to reinterpret Brain prose | **no** — the reply intent is read from the typed `intent` through Deals' own map (`counter → negotiate`); `what` and `why` travel only as explanation |
| would any Deals logic need to move upstream | **no** — the figure, the terms, the draft, the lint, the tap and the send all remain behind the draft route and the pending action; the Brain supplied none of them |
| cost · usage | USD 0.031 · 17,858 prompt · 1,129 output · 9,301 thought tokens |

Standing decisions, for completeness: Yuwa and audience RECOMMEND · specialized_plan · new_work with no intent (correct: not commercial); positioning NO_ACTION deferring to the request, citing `deal[…]` and `request[D2k]`; StartX1 REQUEST_INTELLIGENCE (no flip this run).

## 2. Two things worth noting, neither a failure of the criterion

- **`considerations` came back empty.** The seam collects cited `.absent / .unknown / .exclusivity / .risk / .thread` lines and `not_seen`; this answer cited only `.basis`, `.band` and the floor, and listed nothing unseen. So Deals would receive no "terms to raise" from the Brain and would fall back to its own `negotiate_terms`, which is the design (the considerations are an offer, never a requirement). Under 0.6.0 S1 the same Brain named usage rights and product value; here it did not need to. Decision-relative, not a defect.
- **The `why` still reads the producer's per-deliverable basis as the floor's basis** ("per-deliverable value of USD 1,250 … below her ambassador floor of USD 3,602"). That is the deferred S1 comparability class and the recorded producer-semantic issue (the floor has no unit; the block says so); the Brain consumed the block's own reading, which is the boundary behaving as closed. Not tuned.

## 3. What the call proved that the tests could not

Only the question the review reduced it to: the provider, given the amended contract and the `anyOf` schema, **emits a typed intent that agrees with its reasoning** on a real commercial RECOMMEND. Everything downstream — reconciliation, the record, the seam payload, the route inputs, the payload lineage — ran deterministically on that output exactly as it had on the synthetic and recorded cases.

## 4. Comparison with the same cell before 0.7.0

| | #623 A3 ×3 (0.4.0) | 0.7.0 A3 |
|---|---|---|
| decision | counter ×3 | counter |
| how Deals would learn the instruction | by reading "Counter … to align the fee with her ambassador floor of USD 3,602 per deliverable" | `intent: counter` |
| amount in `what` | "USD 3,602 per deliverable" (now refused by the 0.5.0 backstop) | none |
| gates | 2 of 3 refused on ids | both passed |
| downstream | nothing | Recommendation created; Deals payload rendered; nothing called |

## 5. Harness fixes made after the call (plumbing, no semantics; recorded for honesty)

The first reconciliation of the artifact reported "no intent" although the raw reply carried `intent: "counter"`: the orchestrator's normalized `output` did not carry the new field, and the reconciler read the normalized output instead of the gated raw JSON. Two fixes: `output` now carries `intent` on RECOMMENDs, and `brainRecommend.ts` reconciles from `record.parsed` — the exact JSON the gates validated. The artifact itself is untouched; the ledger was re-derived from it. No call was repeated.

## 6. Not done

No draft-route call, no pending action, no materialisation, no mounting. No Rate, Deals, State, Campaign/Studio, StartX1 or brand-relationship work; no repeatability matrix. #608 and #570 untouched.
