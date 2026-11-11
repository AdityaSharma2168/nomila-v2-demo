# Brain 0.8.1-exp — one live confirmation of the evidence → reconsideration → Objective-resurfacing bridge, 27 Sep 2026

**Status:** one provider call, once, no rerun; the #637 bridge applied to an **in-memory copy** of the dev Objective; the dev Objective and its events verified unchanged afterwards (row still `deferred`, five events, none appended). Artifacts: `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/r1-bridge/{PB/PB.json, requests.json, P-startx1.research.json, bridge/resurface.offline.json, dry/}`. Spec `brain-eval-spec/0.8.1-exp`, digest `468d8790…`, model `gemini-3.5-flash`, cost **USD 0.041**.

**Result: all eight acceptance conditions met. "Evidence → reconsideration judgment → Objective resurfacing" is closed at the experimental architecture level.**

## 1. Inputs — the controlled R1 P condition, unchanged

Same information-deferred StartX1 Objective (`2d199757…`, "When u know more about this"), the same evidenced Intelligence Request built deterministically (need `counterparty_terms`, class `connected`, the controlled inbox reply), the same projection, the same surrounding evidence (the three StartX1 inbounds, the opening, Mia's live Objectives, work, context). The only difference from the R1 P cell: the projection now carries `requestedBy.requestId` — **unrendered**; the RESEARCH section of the prompt is byte-identical to P (checked on the dry render). Nothing was acquired again.

## 2. Brain

| item | result |
|---|---|
| deferred decision | **CONDITION_APPEARS_RESOLVED** |
| rationale (`why`) | "The athlete deferred this proposed partnership until more was known about the terms. StartX1 has now provided detailed proposed terms, including compensation, term length, content deliverables, and appearance obligations, resolving her information deferral." |
| cites | `deferred[2d199757…]` (her deferral) · **`research[0]`** ("documents StartX1's proposed terms, including a 3-month term, USD 6,000 compensation, three Instagram posts, and one campus event appearance") |
| Gate 1 / Gate 2 / re-gate | 0 / 0 / 0→0 |
| responsive projection cited | **yes**, the only evidence cited beyond the deferral |
| incidental evidence used | **no** — `inbound[3]`, `[6]`, `[9]` and the opening are uncited, although present |
| usage | 17,280 prompt · 1,571 output · 12,575 thought tokens |
| live Objectives (not the subject) | RECOMMEND / REQUEST_INTELLIGENCE / RECOMMEND — the middle one differs from the P cell (a request on the positioning Objective); run-to-run variation on the live set, outside this experiment's question |

## 3. Request — before the run

| item | result |
|---|---|
| id · need | `req_4759de11f5f15e0f` · `counterparty_terms` |
| derived status | `evidenced` (one ref: `inbox_messages:msg-controlled-startx1-reply`, connected, 2026-09-27T14:05Z, attributed to the request) |
| eligibility before the run | **eligible** — "responsive, attributable evidence arrived and no run has reconsidered with it" |
| Decision identity | `source: "the Objective loop"` · `subject: objective[2d199757…]` · `question: "information condition"` |
| explicit Objective relationship | `blockedDecisionOf` → `{kind: deferred_objective, objectiveId: 2d199757…}` — read from the identity |
| projection attribution | `research[0].requestedBy = {run: R1-P, objectiveId: 2d199757…, requestId: req_4759de11f5f15e0f}` |
| **transition by itself** | **none** — eligibility is a state on the request; the Objective was untouched until the bridge ran on the gated observation |

## 4. Bridge

Every Objective-consumer precondition satisfied, in order: eligible · blocks a deferred Objective · this Objective · `allowed(re_surfaced)` on `proposed · deferred` · deferral kind `information` · both gates 0 · entry is `CONDITION_APPEARS_RESOLVED` · cites `research[0]` whose `requestedBy.objectiveId` and `requestedBy.requestId` match. **Nothing inferred from prose**: the Objective from the request's identity, the block from the cite index, the request from the block's `requestId`. Verdict `apply: true, citedBlock: 0`.

## 5. Objective transition — offline copy only

| | before | after |
|---|---|---|
| disposition · lifecycle | `deferred · proposed` | **`unreviewed · proposed`** |
| deferral on the row | `{kind: information, said: "When u know more about this"}` | absent (the ledger's rule) |
| queue eligibility | no | **yes** (`proposed · unreviewed`) |
| appended event | — | `re_surfaced` · actor `{userId: null, role: system}` · `said: null` · `delta: { because: information_available, requestId: req_4759de11f5f15e0f, observedInRun: 25d7d68a…, evidenceRefs: [{inbox_messages, msg-controlled-startx1-reply, 2026-09-27T14:05:00Z}], rationale: <the Brain's why, verbatim> }` |
| original `defer` event | preserved: 2026-09-25T15:19:52Z, athlete actor, `said: "When u know more about this"`, `delta.deferral.said` the same | unchanged |
| request | `reconsideredInRun: null` | `reconsideredInRun: 25d7d68a…` |
| anything active / Recommendation / execution / follow-on run | none | none |

Expected `deferred → re_surfaced(information_available) → unreviewed` with lifecycle `proposed`: **exactly what occurred.** Dev after the run: row `deferred`, five events (`presented → defer → re_surfaced → defer → reaffirmed_by_run`), nothing written (`wrote_to_db: false`; verified by a separate read).

## 6. Idempotency — the same observation applied again to the resulting ledger

Refused: **"already reconsidered in run 25d7d68a… — one attribution per evidenced request"** (the request guard, first in line). The ledger guard would refuse independently: `allowed(objective, "re_surfaced")` → "only a deferred objective is re-surfaced". Both recorded.

## 7. Acceptance

| # | condition | result |
|---|---|---|
| 1 | evidenced request creates eligibility but no transition by itself | met (§3) |
| 2 | Brain emits a gated resolved observation citing the request's responsive projection | met (§2) |
| 3 | bridge attribution entirely explicit | met (§4) |
| 4 | Objective transition only after that observation | met (§5) |
| 5 | athlete governance intact | met — `unreviewed · proposed`, back in her queue, nothing active |
| 6 | lineage survives onto the event | met (§5, the delta) |
| 7 | repeated application cannot resurface twice | met (§6) |
| 8 | nothing else triggered | met |

## 8. Observations

- The Brain's rationale names *her* condition ("until more was known about the terms") and what arrived; that is the judgment B places with it, and it is now on the event as `rationale` for the governance surface to show.
- The dev ledger holds an earlier system `re_surfaced` (25 Sep 03:29) with no `because` — a pre-L2 materialisation event, before reasons existed. Not this slice's concern; noted for the governance-surface work.
- The provider variation on the live set (a REQUEST where P had a RECOMMEND) is unrelated to the deferral and is not scored here.

## 9. Not done

No real athlete. No acquisition. No mutable `information_available` field. No dev Objective re-surfaced. No production mounting. No Recommendation materialisation. No Deals / Rate / State / Campaign / Studio / brand-relationship change. No repeatability matrix. #608 remains the Context Intelligence control. #570 untouched.
