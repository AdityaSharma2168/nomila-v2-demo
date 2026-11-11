# Canonical architecture — status map, 27 Sep 2026

**Control:** the canonical loop — OBSERVE → UNDERSTAND → STATE → OPPORTUNITY → OBJECTIVE → RECOMMEND → EXECUTION PATH → EXECUTE → MEASURE → LEARN. This page is a status map, not a redesign: for every major box and interface it marks **only** one of five statuses, with the artefact that establishes it. No percentages, no maturity scores.

Status vocabulary: **concept/design** (a page, no code) · **experimentally supported** (a recorded experiment behind a gate, closed at the experimental architecture level) · **frozen experimental contract** (a versioned, digest-pinned spec or contract, exercised experimentally, not mounted) · **mounted/production** (on the production path or dev-deployed with a flag) · **deferred/open** (deliberately not taken).

## OBSERVE

| box / interface | status | established by |
|---|---|---|
| social substrate (identities, observations, features) | **mounted/production** (dev flag on; prod off) | Phase A Step 1a/1b |
| research substrate (`research_evidence`, `athlete_facts`, `athlete_inferences`, research state) | **mounted/production** (dev; flags off) | Phase A Step 2 (closed on dev) |
| inbox / deals ingestion (`inbox_threads`, `inbox_messages`, `deals`) | **mounted/production** | the Deals product; Deals audit (#621) |
| athlete assertions (`athlete_asserted`, reversible receipts) | **mounted/production** | onboarding v2/v3, Athlete Record |
| continuous context (schedules, occasions, hooks, brand activity, news) | **concept/design** — no collector, no store; hand-assembled block (`context-block/0.1.0`) | #608, #638 |
| acquisition door (`intelligence_acquisition` workflow → `athlete_asserted`) | **experimentally supported** (dev, test account) | acquisition-seam checkpoint (#636) |

## UNDERSTAND

| box / interface | status | established by |
|---|---|---|
| Athlete Intelligence / M.I.A. (`marketability` Beta.1, four capitals, intelligence ledger) | **frozen experimental contract** (digest-pinned; normalisation layer ships no values) | Step 4 M.I.A. Beta.1 (#439–441) |
| Commercial Intelligence → Brain (commercial projection on subjects; invariants "a basis is established or it is not", "the amount is not yours") | **experimentally supported** — boundary closed | #622–#630 (`commercial-intelligence-brain-closure`) |
| Rate | **deferred/open** (paused; no floor/unit/comparability work) | Rate v0 design, paused by decision |
| Context Intelligence (State-vs-Context rule; context is evidence, not inference; targeted mode = Intelligence Request) | **experimentally supported** (design/repo/evidence checkpoint accepted; #608 amendments adopted, not yet applied to #608's text) | #638 |
| Opportunity Intelligence pass 2 (Context as support) | **experimentally supported** | #639, #640 |
| Deals intelligence (existing) | **mounted/production** (read by the Brain via Existing Work; no Deals changes) | Deals audit (#621), leverage checkpoint (#624) |

## ATHLETE STATE

| box / interface | status | established by |
|---|---|---|
| `athlete-state/1.2.0` (compose, cite, never copy; `dates[]` three kinds; inbound signals; constraints/preferences by assertion) | **frozen experimental contract** (assembled live from dev stores by the harness; not mounted as a service) | State 1.2 frozen-four audit |
| State inclusion rule vs Context (durable facts of her business vs situational evidence; placement ≠ meaning; one row, several projections) | **experimentally supported** | #638 |

## OPPORTUNITY

| box / interface | status | established by |
|---|---|---|
| `opportunity-eval-spec/1.2.0` + `opportunity-map/1.2.0` (State grounds; Context/responsive support; no `evidence` domain; knowledge boundary; two-condition proof rule; both gates) | **frozen experimental contract** (digest `7416ff47…`) | #642 |
| the map as a snapshot; conservative key stabilization (continuity, not identity); no lifecycle | **experimentally supported** | #639–#642 |
| Context → Opportunity (`strategyIntelligence` slot as shared world knowledge; pass-2 "validation" via responsive evidence) | **deferred/open** (slot reserved; unexercised) | #638 §12, #639 §11 |

## OBJECTIVE

| box / interface | status | established by |
|---|---|---|
| `objective-eval-spec/1.0.4` (1.0.2's knowledge boundary + the evidenced-baseline role of `current_state`; UNKNOWN MAY QUALIFY, IT MAY NOT JUSTIFY) + `objective-proposal/1.0.0` | **frozen experimental contract** — accepted 27 Sep; 1.0.2 and 1.0.3 preserved historically | objective-knowledge-boundary checkpoint (10 of 10); 1.0.4 cohort evaluation (14 of 14 A/B/C) |
| Objective ledger / governance (`objective/1.1.0` rows, events, deferral kinds, `re_surfaced`, athlete decisions, review queue) | **mounted/production** (routes + client review screen; deferral L2; dev has real rows) | PR3b, L2 |
| reconciliation 2.0.0 (lineage tiers) | **mounted/production** (in the materialise path) | reconciliation experiment 1 rerun |
| manufactured deficiency / epistemic contrast (1.0.3 failed; 1.0.4 passed) | **experimentally supported** — Objective iteration closed by decision; State → Opportunity → Objective frozen for now | `objective-1.0.3-…`, `objective-1.0.4-…` checkpoints; #644, #646 |

## RECOMMEND / SHARED BRAIN

| box / interface | status | established by |
|---|---|---|
| Brain `brain-eval-spec/0.8.1-exp` (decision-set semantics; seven lenses; RECOMMEND / NO_ACTION / REQUEST_INTELLIGENCE with typed need; deferred: REQUEST / CONDITION_APPEARS_RESOLVED / NO_REQUEST; Gate 1 + Gate 2; response schema) | **frozen experimental contract** (digest `468d8790…`) | #626–#635 |
| Decision Request / Decision Subject (`SubjectRef {kind,id}`; DECISION SUBJECTS lens; decision identity = source + subject + question) | **experimentally supported** | #627, #628 |
| Recommendation (`recommendation/0.1.0-exp`; identity = decision + routing + intent; withdrawal rule; response/authorization/execution kept separate) | **experimentally supported** (reconciled from recorded runs; **not materialised**) | #630, #631 |
| Intelligence Request (`intelligence-request/0.1.0-exp`; identity = decision + typed need; ONE PROPOSITION, ONE NEED; derived status; `evidenced` ≠ proven) | **experimentally supported** (ledger is a harness file) | #632–#634 |
| resolver / acquisition (need × capability facts → mechanism; burden ordering; `mila_question` → real parked step) | **experimentally supported** (dev, test account) | #634, #636 |
| evidence → reconsideration (eligibility generic; Objective consumer on gated `CONDITION_APPEARS_RESOLVED`; option B; lineage on the event delta) | **experimentally supported** (offline transition on a ledger copy; one live confirmation) | #637 |
| the missing-information loop end to end (DON'T KNOW → … → governance consequence) | **experimentally supported** — closed as a slice | #637 closure |
| Brain run persistence / request store / `information_available` writer | **deferred/open** | reliability backlog R9; #637 §4a |

## EXECUTION PATH

| box / interface | status | established by |
|---|---|---|
| `execution-intent/0.1.0-exp` (RECOMMEND intent accept / counter / ask_terms / decline / wait) | **frozen experimental contract** | #631 |
| direct_action → Deals handoff (`dealsExecutionSeam.ts`: draft request / pending-action proposal; seam carries no amount) | **experimentally supported** (dry seam + one A3 call; **not mounted**) | #631 |
| specialized_plan (content planner behind a Recommendation) | **concept/design** | #608 §7 |
| campaign | **concept/design** — Campaign slice design (#570) untouched | #570 |

## EXECUTE

| box / interface | status | established by |
|---|---|---|
| Mila (conversation, tools, voice) · Inbox · Deals (draft replies, pending actions, tap-to-send) | **mounted/production** | the product |
| Campaign (`campaign_*` stores, observed door) | **concept/design** (no table; a Subject kind with nothing behind it) | #570 |
| Creative Intelligence (briefs, deliverables, series) | **concept/design** | #608 §3.1, Campaign slice design |
| Studio / Generation (VTO, ads, storyboard pipelines) | **mounted/production** in parts (Studio plans/briefs) | Studio work; not integrated with the Brain |

## MEASURE / LEARN

| box / interface | status | established by |
|---|---|---|
| Outcome Intelligence / Measure (deal outcomes, campaign performance, `deal_deliverables` persistence) | **deferred/open** (`deal_deliverables` 0 rows; extraction exists, persistence does not) | Deals audit, #608 §2.1 |
| Learn (feeding outcomes back into State / M.I.A. / parameters) | **concept/design** (global versioned parameters only, by rule) | intelligence principles |
| repeatability matrix (any evaluator) | **deferred/open** by decision | every checkpoint since #623 |

## Cross-cutting rules in force

Design-before-code · small reviewed PRs · flags off · dev path only, production never touched · targets/cohort/calibration words never sent to providers · no per-athlete tuning · no provider calls without approval · frozen evaluators move only by ceremony · nothing under `server/services/intelligence/` imports a provider · athlete answers never flow directly into an evaluator · validators sit on the execution path · no test asserts an outcome for a named athlete · migration files never chained in a transaction.

## What this map does not say

Nothing here is a maturity score. "Experimentally supported" means one or a few gated runs on Mia's real data or controlled fixtures answered a specific architectural question; it does not mean repeatable, robust or mounted. "Frozen experimental contract" means the text is pinned and can be reasoned about; it does not mean it is right. The open items are open by decision, in the order the checkpoints recorded.
