# Brain — the acquisition seam: acquisition payload → real mechanism → real provenance-bearing evidence → attribution, 27 Sep 2026

**What the athlete would experience.** Mila asks one question only she can answer. She answers in words, by voice or on a form. The answer is saved as something she said, with a receipt she can undo. Nothing else happens: no negotiation, no reply to a brand, no deal, no plan.

**What happens underneath, and what this slice proved on the dev database with a test account.** A typed Intelligence Request became one real parked workflow step whose input carries the request id and the need. The step was completed through the runner's completion door. The existing assertion path wrote an `athlete_asserted` row with the run id, the mode, her words and a reversible receipt. The step's output names the request id beside the asserted row id. Reading that back produced an evidence reference attributable to the request, and the existing rule derived `evidenced`. Duplicate completion wrote nothing. An obsolete request's run was cancelled and a late completion was refused. No new table, no new column.

**Status:** experimental, dev only. Nothing in production starts the process. No provider call. No real athlete. No Brain reconsideration. Branch `feat/brain-acquisition-seam`, stacked on 0.8.1-exp.

---

## 1. Repo trace — the real path, checked against the dry checkpoint's assumptions

| piece | where | what it actually does | dry-checkpoint assumption |
|---|---|---|---|
| step kinds, `StepCtx.input` | `server/workflow/types.ts:26-39, 57` | `input: Json` (= `unknown`), free; stored verbatim in `workflow_steps.input jsonb` (`shared/schemaWorkflow.ts:80`); 8 KB cap only (`runner.ts:92-100`) | held |
| creating a parked step | `runner.ts:187-211` (`openGroup`) | the only writer of `status:'waiting'`; stores the definition's `payload(ctx)` return verbatim; run → `waiting`, `current_step` = the step | held |
| definitions using it | `definitions/onboarding.ts:162-181` | only onboarding `greet` and `doors` (v2, inherited by v3) | held |
| completion door | `server/workflow/routes.ts:60-72` → `POST /api/v1/me/workflow/runs/:id/steps/:step/complete`, mounted `server/index.ts:216` | `requireAuth` (Firebase ID token, `lib/auth.ts:74`); body `{fields, mode ∈ chat\|voice\|form}`; delegates to `completeStep` | held |
| ownership | `runner.ts:445` | `run.athlete_id !== req.athleteId` → 404 `not_found`; never from the body | held |
| what completion does | `runner.ts:441-470` | find the waiting row → pinned definition → `assertPayload` → `step.complete(ctx, fields)` → step row `done` + `output` + `mode` + `finished_at` → `advance` → `kick` | held |
| duplicate completion | `runner.ts:447-451` | already `done` → **200 `alreadyDone:true`, `complete()` not re-run, no write**; any other non-waiting state → **409 `not_waiting`** | held |
| other doors | Mila tool `mila/tools/completeOnboardingStep.ts:75` (chat); voice `voice/onboardingRoute.ts:63` (voice, secret-gated, onboarding steps only); form widget `client/components/mila/MilaOnboardingWidget.tsx:69-73` | all call the same `completeStep`; **Mila and voice are onboarding-specific** (`activeRunFor(…, "onboarding")`, `ONBOARDING_STEPS` whitelist) — no generic exposure of an `await_human` step | **not held**: the dry note said "reached by the chat tool, the voice route, or a form" — true of the door, not of any exposure for a new step |
| `recordAssertions` | `server/mila/onboarding.ts:248-305` | insert `athlete_asserted` {field, value jsonb, said, `source`, `mode`, `run_id`} → `profile_write` receipt (reversible, payload with before/after, run_id, mode, source) → back-patch `agent_action_id` → supersede the previous current row → project a column when the field has one; **not transactional** (five awaits) | held, except: |
| `source` vocabulary | `shared/schema.ts:2549` check `IN ('onboarding','chat','voice','settings')` | **`source: "mila"` (the dry fixture) would be rejected by the DB** | **not held**; corrected: `chat`/`voice` by mode; the acquisition is identified by `run_id`, not by `source` |
| `athlete_asserted` provenance | `shared/schema.ts:2534-2551` | `source, mode, run_id (no FK, deliberate), agent_action_id, said, created_at, superseded_by, retracted_at`; **no request/objective/step id column; no unique index** | held (no column; the request id must ride elsewhere) |
| reversible receipt | `lib/agentActions.ts:28-59`, undo `routes/agentActions.ts:147-193` → `undoProfileWrite` (`onboarding.ts:313-335`) | retracts the row, repairs the supersede chain, restores the column, stamps `undone_at`; history via `GET /me/record/history/:field` | held |
| cancellation | `runner.ts:491-500` (`cancelRun`), admin-only route `routes.ts:117-124` | `ready/waiting` rows → `skipped`, run → `canceled`; a completion then hits 409 `not_waiting`; **nothing calls it automatically** | held (no automatic path) |
| idempotency | run: `idempotency_key` partial unique + one-active-run `(athlete_id, active_scope)` (`schemaWorkflow.ts:53-63`, `startRun` `runner.ts:264-279`); claim: `FOR UPDATE SKIP LOCKED` (`runner.ts:297-306`); **completion: read-then-write, no lock, no transaction, no conditional UPDATE, no unique on `(run_id, step)`** | serial duplicates are safe; **concurrent duplicates are not prevented** | recorded below (§10) |
| `await_human` runner tests | `server/workflow/runner.test.ts:104-136, 305-320` | park / complete / repeat no-op / tenancy / cancel-then-complete | — |
| HTTP-level test of the athlete route | none existed (`supertest` unused; the voice twin `voice/onboardingRoute.test.ts` mounts its router on an ephemeral server) | added in this slice for the athlete route | — |

## 2. Forcing case and account

- **Need: `athlete_capability_intent`, answered into the existing asserted field `cadence`** ("posts a week you keep", text, no `athletes` column, not keyed on by any State regex). Chosen over `athlete_commercial_basis` because a floor needs a new field with an amount/currency/per shape — Rate semantics this slice must not touch. The resolver already maps this need to `mila_question` alone, so the mechanism under test is exactly the one the C2 slice selected, without the coupling.
- **Account: `Paytest Athlete` (`dd1a8a80-…`, `@nomila.dev`)** — a dev test account with no `auth_id` (it cannot be logged into), no prior runs, no prior assertions. Nothing it records can reach anyone.
- **Tester:** this session, with plainly test-shaped values (`"3 a week in season (test value)"`; said `"Test answer: …"`). The user did not supply values; the same door accepts theirs.
- What this proves: **the tester said X, with provenance.** Not that X is commercially comparable, applicable or correct.

## 3. Exact code touched

| file | what |
|---|---|
| `server/workflow/definitions/intelligenceAcquisition.ts` (new) | process `intelligence_acquisition` v1, one `await_human` step `ask`; `ASSERTED_FIELD_FOR_NEED = { athlete_capability_intent: "cadence" }`; `acquisitionInput` / `parseAcquisitionInput` (the definition trusts nothing it did not write); `activeScope = intelligence_acquisition:<request_id>`; `complete()` → `recordAssertions` → output `{asks, request_id, need, field, evidence:[{store, id, agent_action_id}]}`; bad answers → `WorkflowError bad_fields 400`, step stays waiting |
| `server/workflow/definitions/index.ts` | registers it (comment: experimental, nothing starts it) |
| `server/services/intelligenceAcquisition.ts` (new) | `startAcquisitionRun` (refuses evidenced/obsolete; idempotency key = process:request id); `parkedStepFor`; `evidenceFromAcquisitionRun` → `EvidenceRef[]` + lineage, every row checked (`run_id` = this run, athlete = the run's, field = the answer field); partial attribution never returned |
| `server/workflow/definitions/intelligenceAcquisition.test.ts` (new) | 4 tests, PGlite, real runner, real router (§11) |
| `server/scripts/intelligence/brainAcquireLive.ts` (new) | the dev-DB phases park / complete / obsolete / status |
| `server/services/intelligence/brain/*` | **untouched** — the request rule, `receiveEvidence`, `deriveStatus` ran as they are |

No schema change. No migration. No flag (nothing to gate: no production caller exists).

## 4. The acquisition payload (the parked step's `input`, verbatim from dev)

```
{ "asks": "intelligence_request", "request_id": "req_41d994ca3ee36669", "need": "athlete_capability_intent",
  "field": "cadence", "question": "How many posts a week can you keep up in season?",
  "why": "A partnership's deliverables must fit what she will actually post; only she can say what that is." }
```

## 5. The parked-step record (dev, `slice/acquire-live/park.parked.json`)

| | |
|---|---|
| request | `req_41d994ca3ee36669` · key `66e8cc373a820cd2` · need `athlete_capability_intent` · class `athlete` · resolver → `mila_question` ("available, authority athlete ≥ athlete, lowest athlete burden among the available") |
| run | `67658745-0950-4c94-90b9-d9a799607603` · `intelligence_acquisition` v1 · `waiting` · `current_step ask` · `active_scope intelligence_acquisition:req_41d994ca3ee36669` · `idempotency_key` the same · `created_by brain-acquisition-seam` · `input` = §4 |
| step | `c0aaaece-c21e-45c9-b665-10d90125078b` · `ask` · `await_human` · `waiting` · attempt 1 · ordinal 0 · `input` = §4 |
| ledger | request `acquiring`, `acquisition.ref = workflow_step:c0aaaece…` |

## 6. Completion request / result (dev, `complete.result.json`)

| call | result |
|---|---|
| `completeStep({runId: 67658745…, step: "ask", fields: {value, said, mode: "chat"}, mode: "chat", athleteId: dd1a8a80…})` — the function the athlete route calls after `requireAuth`, with its tenancy check | `alreadyDone: false` · run `done` · step `done`, `mode chat`, `finished_at 2026-09-27T01:51:39.326Z` |
| the same again (duplicate, different value) | `alreadyDone: true` · nothing written |
| the same with another athlete id | refused `not_found` 404 |

## 7. Assertion / evidence record (dev, read back independently from the tables)

```
athlete_asserted { id: aac861dd-7ca6-4298-a517-33643991d3b5, athlete_id: dd1a8a80-…, field: cadence,
  value: {text: "3 a week in season (test value)"}, said: "Test answer: I can keep three a week during the season, more in the off-season.",
  source: chat, mode: chat, run_id: 67658745-…, agent_action_id: e5a1f290-a5fb-4a1e-9bff-72c1cc247f42,
  superseded_by: null, retracted_at: null, created_at: 2026-09-27T01:51:38.852Z }
agent_actions { id: e5a1f290-…, action: profile_write, reversible: true, undone_at: null,
  reason: "You told Mila your posts a week you keep is “3 a week in season (test value)”",
  payload: { asserted_id: aac861dd-…, field: cadence, column: null, from: null, to: "3 a week in season (test value)", run_id: 67658745-…, mode: chat, source: chat } }
workflow_steps.output { asks: intelligence_request, request_id: req_41d994ca3ee36669, need: athlete_capability_intent, field: cadence,
  evidence: [{ store: athlete_asserted, id: aac861dd-…, agent_action_id: e5a1f290-… }] }
```
The `athletes` row is untouched (`cadence` projects to no column).

## 8. Provenance chain — every hop explicit, none inferred

```
Decision identity {source: "the athlete's agent, through Mila", subject: athlete[dd1a8a80…], question}  + need athlete_capability_intent
  → request key 66e8cc373a820cd2 → request id req_41d994ca3ee36669            (requestKey: sha of decision + need; no prose)
  → acquisition plan mila_question                                              (resolver, on the typed need)
  → workflow run 67658745…   input.request_id = req_41d99…  idempotency_key/active_scope = intelligence_acquisition:req_41d99…
  → parked step c0aaaece…    input.request_id = req_41d99…                      (the payload IS the input)
  → completion               mode chat, finished_at, tenancy-checked
  → athlete_asserted aac861dd… run_id = 67658745… + receipt e5a1f290… (reversible; payload carries run_id, mode, source, before/after)
  → step output              request_id = req_41d99… + evidence[].id = aac861dd…   (written by complete(), from the same input)
  → EvidenceRef { store: athlete_asserted, id: aac861dd…, at: 2026-09-27T01:51:38.852Z, sourceClass: athlete,
                  need: athlete_capability_intent, attributedTo: req_41d99…, asserts: "cadence: 3 a week … — she said …" }
  → request.evidenceRefs[0]  → deriveStatus = evidenced
```
What the evidence establishes: who supplied it (`athlete_id`, the run's athlete); source/mechanism (`source chat` + the run's process/definition = the Mila question); mode (`chat`); workflow run (`run_id`); acquisition/request id (step input and output); timestamp (`created_at`); assertion/value (`field`, `value`, `said`); reversible receipt (`agent_action_id` → `profile_write`); authority/class (`athlete`).

## 9. Request attribution — the rule as it ran

`receiveEvidence` on the reference above: **"attributable, right class, after the request" → counted → `evidenced`**; `acquisition.completedAt` set, `producedEvidence: true`. `evidenceFromAcquisitionRun` reads only the row ids the step output names and refuses any row whose `run_id`, athlete or field disagree — attribution is by ids the completing step wrote, never by athlete + field, never by matching text. **`evidenced` = responsive qualifying evidence arrived.** The proposition ("she can sustain a stated number of posts a week in season") is not thereby proven; no status field was written; the ledger stays a file in the harness.

## 10. Idempotency

| case | where enforced | result |
|---|---|---|
| one parked step per request | `workflow_runs_one_active (athlete_id, active_scope)` with scope = process:request id; `idempotency_key` partial unique; `startRun` returns the existing run on the unique violation | second `startAcquisitionRun` for an acquiring request → `created: false`, same run, one step (test) |
| one valid completion | `completeStep` guard `runner.ts:447-451` | `alreadyDone: false`, one row, one receipt |
| duplicate completion (serial) | the same guard: a `done` row → no-op | `alreadyDone: true`; still one row, one receipt (dev + test) |
| repeated UI submission | the route permits it (no client token); serially it is the case above | 200 `alreadyDone: true` (HTTP test) |
| acquisition already pending | the scope + `startAcquisition`'s own guard ("never started twice") | existing run returned; ledger throws if asked to start twice |
| request already evidenced | `startAcquisitionRun` refuses before touching the runner | `{started: false, refused: "request is evidenced — nothing to acquire"}` (dev + test) |
| **concurrent duplicate completion** | **not enforced**: `completeStep` is read-then-write with no row lock, no transaction, no `AND status='waiting'`, and `workflow_steps` has no unique on `(run_id, step)` | two simultaneous completions could both run `complete()` → two assertions. Pre-existing runner gap (affects onboarding `greet` identically); recorded, not fixed here |

## 11. Cancellation / obsolescence (dev, `obsolete.result.json`)

Second request `req_b7b35676175152b3` (different question, same need) → parked run `ff9b2d16…` step `c7a4afa6…` → `markObsolete` (ledger) → `cancelRun` (the admin-only function; **no automatic link exists from request obsolescence to the run — the consumer must cancel**) → run `canceled`, step `skipped` → late completion **refused 409 `not_waiting`**, nothing written → `startAcquisitionRun` for the obsolete request refused. The established rule holds by construction: a late answer that did land (before the cancel) would be an `athlete_asserted` row about her, valid as such; `receiveEvidence` on an obsolete request records the event but `deriveStatus` stays `obsolete` — it cannot resurrect the Decision. **Gap recorded:** the runner has no "obsolete but still answerable" state; only cancel (refuse) or leave waiting (accept). Not invented here.

## 12. Authorization boundary

Creating or answering this step is evidence acquisition only. Verified against the code, not asserted: `complete()` calls `recordAssertions` and returns ids — it touches no `deals`, `inbox`, `pending_actions`, `recommendation`, `objectives`, Rate or Campaign code; the run has one step, so `advance` marks it `done` and `kick` runs nothing; the receipt is `profile_write` (an athlete-record write, undoable), not an execution or negotiation receipt. Nothing in the slice reads or writes a Recommendation response, an execution intent, a Deals draft or a brand thread.

## 13. Tests (`server/workflow/definitions/intelligenceAcquisition.test.ts`, PGlite, real runner, 4 tests)

1. The whole chain: park → scope/idempotency key carry the request id → already-pending returns the same run → tenancy 404 → bad answers 400 and the step stays waiting → one completion → step output carries request id + asserted id → row provenance (`source chat`, `mode chat`, `run_id`, `said`, receipt reversible with `run_id` in payload; `athletes` row untouched) → duplicate completion no-op (one row, one receipt) → attribution → `receiveEvidence` counted → `evidenced` → already-evidenced refused → a later settings answer supersedes the ledger's current value but not the attribution (the reference still points at what she said then; lineage shows `superseded_by`).
2. Obsolescence: obsolete → cancel → step `skipped` → late completion 409, nothing written → obsolete request refused → no evidence read.
3. The definition refuses inputs it did not write and a need without an answer field (`athlete_commercial_basis`).
4. **The athlete HTTP door**: the real `workflowAthleteRouter` on an ephemeral server, the real `requireAuth` (bearer parse, athlete lookup by `auth_id`), only `firebase-admin`'s `verifyIdToken` stubbed: 401 no token · 404 another athlete's token · 400 no mode · 400 `bad_fields` · 200 once (`mode form`) · 200 `alreadyDone` on repeat · one row · attributable.

Regression: `server/workflow` (all suites), `server/services/intelligence/brain` (13 suites), `server/mila/onboarding.test.ts`, `server/voice/onboardingRoute.test.ts` — all green.

## 14. Schema / vocabulary pressure (recorded, nothing changed)

- `athlete_asserted.source` has no value for "an acquisition Mila asked for": `chat`/`voice` is the door, `run_id` is the acquisition. A reader wanting "which requests produced this row" must go row → run → step input/output. Sufficient for the seam; pressure if request-driven rows become common.
- `athlete_asserted` has no `asOf`/`observed_at`: `created_at` is the only time, so "after the request" is by write time.
- `recordAssertions` is not transactional (row, receipt, back-patch, supersede, projection are separate awaits); the acquisition inherits that.
- `completeStep` concurrency (§10, last row).
- No `intelligence_requests` table: the ledger remains a harness file; `information_available` still has no writer (by design, not yet).
- The RESEARCH envelope naming pressure from R1 stands as recorded; unrelated to this seam (the evidence here projects as `athlete_asserted`, not through `research[…]`).

## 15. Acceptance criteria

| # | criterion | result |
|---|---|---|
| 1 | a typed request creates one real parked acquisition step | **met** (dev run `67658745…`, step `c0aaaece…`) |
| 2 | request identity survives explicitly into the workflow | **met** (run input, step input, idempotency key, active scope, step output) |
| 3 | a tester completes it through the real production completion door | **met at the function and route-contract levels**: dev completion through `completeStep` (the function the route delegates to, tenancy-checked); the HTTP route itself exercised end to end in the PGlite test with only Firebase token verification stubbed. **Not done: a human completing over HTTPS with a real Firebase token** — the test account has no login, and minting a token for it would mean signing in through an identity provider, which this session does not do |
| 4 | the existing evidence/assertion path writes provenance-bearing evidence | **met** (§7) |
| 5 | attributable back to the request without prose matching | **met** (§8–9) |
| 6 | duplicate completion does not duplicate evidence | **met serially** (dev + tests); concurrent duplicates unguarded (pre-existing, §10) |
| 7 | the request derives `evidenced` from the real evidence | **met** |
| 8 | no strategic/execution authorization implied | **met** (§12) |
| 9 | no new database schema required | **met** — none added, none needed |

## 16. What remains unproved

- A real person's completion over the network with a real token (criterion 3's last mile). The door is the same function; the untested layer is the token and the device.
- Any exposure of this step in Mila, voice or the app: none exists (the Mila tool and voice route are onboarding-only). The real Mila acquisition path is not built, per the brief.
- Concurrent duplicate completion (runner-wide gap).
- Obsolescence → cancellation as an automatic link.
- Anything about the value's commercial meaning.

## 17. Not done

No provider call. No real athlete. No Brain reconsideration; nothing projected into StartX1. No `information_available` writer. No Objective re-surfacing. No Recommendation materialisation. No Deals, Rate (beyond the test-shaped `cadence` value), State, Campaign/Studio or brand-relationship change. No repeatability matrix. #608 remains the Context Intelligence control. #570 untouched.

---

**Closure record (27 Sep 2026).** Reviewed and accepted: **acquisition mechanism → real provenance-bearing evidence is closed at the experimental architecture level.** Criterion 3 is treated as sufficient for this closure (real router, real auth middleware, real athlete lookup and tenancy, real completion function; only Firebase token verification stubbed); the network/device/token last mile is **integration coverage**, not an open architecture question. The concurrent-completion issue is promoted to the engineering reliability backlog (R8); the other pressures are kept as recorded (R9). Next boundary: evidenced Intelligence Request → derived availability → reconsideration eligibility → the Objective's existing governance transition (`brain-evidence-reconsideration-checkpoint.md`).
