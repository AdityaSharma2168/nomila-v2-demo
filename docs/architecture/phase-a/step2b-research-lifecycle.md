# Phase A · Step 2b — Research Lifecycle / Domain Refresh Planner (BUILD RECORD)

**Design (frozen 11 Sep 2026):** `step2b-research-lifecycle-design.md` (PR #399). This record is the implementation against it: what was built, the gates as run, and the dev evidence as it accumulates. Both execution flags are `false` in both environments at merge; the backfill is unapplied; no policy row is activated; no Cloud Scheduler job is provisioned.

## 1. What was built (design §8)

### 1.1 Migration `0047_research_planner.sql` (design §8.1)
Additive only: two tables (`research_planner_runs`, `research_budget_days`), eight columns (`athlete_research_state.pending / refresh_failures / last_planned_at`; `research_runs.workflow_run_id / as_of / llm_attempts / signal_calls / other_calls`), four indexes (`research_planner_runs_started_idx`, `research_runs_workflow_success` partial unique, `research_runs_started_idx`, `athlete_research_state_due_idx` re-asserted), one CHECK (`research_runs_domain_check`, adds `full` and `refresh`). Mirrored in `shared/schema.ts` and listed in `scripts/db-migrate.sh` (0031–0047).

### 1.2 The one execution gate (design §4.1, review round 2)
`research/config.ts` → `researchPlannerExecutionEnabled() = RESEARCH_REFRESH_ENABLED && RESEARCH_SUBSTRATE_WRITE`. It is the only flag predicate 2b code reads. It gates: planner enqueue mode, `applyStateTransitions`, workflow enqueue, `pending` consumption / `last_planned_at`, the refresh step's provider calls, `requestRefresh` (connect callback, admin), the dev monthly re-enrich suppression, admin v1 → planner routing, the script's `--apply`. **Invariant: if either flag is false, planner execution is non-mutating and legacy behaviour remains active** (test H).

### 1.3 Modules
| File | Role |
|---|---|
| `research/planner.ts` | `evaluateNight` (pure: E0/E1/E4 proposals, due domains, priority, admission against the ledger), `applyStateTransitions` (enqueue only, guarded updates), `runResearchPlanner` (advisory lock → ledger → evaluate → apply + `startRun` → planner row) |
| `research/ledger.ts` | `reserveLlmCall` (one conditional `UPDATE … WHERE llm_attempts < cap RETURNING` on the UTC-day row + the run row; refusal rolls the day slot back), `recordNonLlmCall` (signals / other lanes), `nightlyLedger` (actuals + reservations) |
| `research/outcomes.ts` | `domainOutcome`: refreshed \| confirmed_empty \| no_relevant \| failed (§3.1) |
| `research/plans.ts` | the five legacy queries verbatim (copied, D4), domain → plan, `mergePlan`, provisional cost estimates |
| `research/refresh.ts` | `refreshAthlete(input, providers)`: gate → at-least-once reuse / abandoned close → open the run row → reserved grounded queries → signals lane → restricted extraction with per-domain outcomes → `persistResearchRun` with the plan. Provider calls are INJECTED (`RefreshProviders`) so the intelligence boundary (boundary.test.ts) holds |
| `skills/researchRefresh.ts` | binds the real adapters (`groundedSearch`, `extractWithCitations`, Trends/GDELT envelopes) → `runResearchRefresh`, called by the workflow definition |
| `research/triggers.ts` | `requestRefresh` (queued request on `pending`; no-op unless the gate is true) |
| `research/persist.ts` | accepts an open run row, `asOf`, the plan; drops out-of-plan claims before any write; computes outcomes after resolution; monotonic domain freshness under `SELECT … FOR UPDATE` (§3.2); failure back-off bookkeeping; cost from the cost model. **Replaces the Step 2a "touched" rule for full runs too** |
| `lib/research/providers/geminiGrounded.ts` | `groundedSearch`: the grounded call copied from `researchAthlete.ts` with a policy retry cap and a reservation awaited before every attempt; no path to Gemini without a reservation |
| `lib/research/providers/kimiExtract.ts` | schema `cited-claims/2`: scope (domains, allowed kinds) in the prompt and `domain_outcomes` parsed leniently (a missing block is never `none_found`); reservation before the call |
| `workflow/definitions/researchRefresh.ts` | `research_refresh` v2 (`refresh` step → `refreshAthlete`); v1 unchanged, pinned by the admin path while the gate is false |
| `skills/reEnrichAthletes.ts` | first line: no-op when the gate is true; unchanged otherwise |
| `routes/oauthCallback.ts`, `routes/admin.ts` | queued `requestRefresh` (connect event; admin manual when the gate is true, else v1 pinned) |
| `server/index.ts` | `POST /api/internal/research-planner-cron[?dryRun=true]` (cron secret; no in-process cron) |
| `scripts/provision-schedulers.sh` | job line `research-planner\|10 5 * * *\|…\|600s` (not applied) |
| `lib/pgAdvisoryLock.ts` | `LOCK_RESEARCH_PLANNER` |
| `server/scripts/researchPlanner.ts` | `--dry-run` (default) / `--apply` (refuses unless the gate) / `--athlete` / `--as-of` |
| `server/scripts/seedModelParams.ts` | drafts `research_freshness v0.2-alpha` (explicit `social_handles` family, D6) and `research_policy v0.2-alpha` (planner caps, provisional cost model, D3). Not seeded, not activated |
| `gcp/cloud-run-{dev,prod}.yaml` | `RESEARCH_REFRESH_ENABLED: "false"` |

### 1.4 Scoped deviations from the design text (for the reviewer)
- **Platform discovery is not called by planner runs.** The design's `social_handles` row lists "Q5 + platform discovery". `runPlatformDiscovery` takes known handles and returns *social metrics* (followers, engagement), which belong to the Step 1a social substrate, not to research evidence; it does not find handles. The `social_handles` refresh is therefore Q5 + extraction (`social_handle` claims). The `other` lane (`recordNonLlmCall(runId, "other")`, `maxOtherCallsPerNight`) is implemented and tested for future non-LLM calls. Raising for confirmation; no architectural conflict.
- **Run status for full runs.** A planned run is `partial` when any planned domain is not fresh (§3.1). A full legacy/dual-write run keeps the Step 2a rule (sub-calls, conflicting or suspect items), because almost every full run has at least one domain with nothing new; its domain outcomes are still recorded and still govern freshness.

### 1.5 Code review (PR #400) fixes
- `outcomes.ts`: a fact-bearing domain is `refreshed` only with accepted domain evidence AND a fact accepted, corroborated or re-confirmed by the resolver; evidence alone never refreshes it (the non-fact-evidence bypass is removed). Evidence-only domains (press, narrative, social_handles, signals) refresh on accepted evidence/inference. Regression tests: `outcomes.test.ts` (pure) and `freshness.test.ts` ("fact-bearing domains").
- `triggers.ts`: `requestRefresh` merges `pending` inside one transaction (insert on conflict do nothing → `SELECT … FOR UPDATE` → merge with de-dupe by domain and the 50-entry bound → update), so concurrent triggers cannot lose a request. Test: `triggers.test.ts` (two simultaneous requests for different domains both pending).
- `persist.ts`: only evidence-backed facts (origin `research` / `backfill`) count toward a domain outcome; an athlete's assertion or proof is authority, not research acceptance. A domain's `lastResearchedAt` moves ONLY on a fresh outcome; the Step 2a fallback that inferred a date from the presence of evidence is removed (it would have re-introduced "touched" through the back door).
- Scoped deviations (§1.4) approved in review.

## 2. Gates as run (design §10)

| Gate | Result |
|---|---|
| G1 tests | see §3 |
| G2 migration | 0047 dry run on dev (BEGIN … ROLLBACK, 11 Sep 2026): both tables, all eight columns, the four indexes and the CHECK created in-transaction; after rollback 0 tables and 0 columns remain. Nothing applied by hand |
| G3 drift | before the deploy the drift gate reports exactly the 0047 objects: `research_planner_runs` and `research_budget_days` missing, `athlete_research_state` missing `pending, refresh_failures, last_planned_at`, `research_runs` missing `workflow_run_id, as_of, llm_attempts, signal_calls, other_calls` |
| G4 execution gate | test H (both single-flag-true states): planner `dry_run`, zero mutations (row snapshots equal), `requestRefresh` writes nothing, the monthly sweep runs its legacy body; refresh step refuses with zero provider calls |
| G5 legacy | byte-for-byte no diff vs `main` on `researchAthlete.ts`, `researchMerge.ts`, `athletesCurrentWriter.ts`, `refreshScores.ts`, `fetchSocialData.ts`, `scoringService.ts`, `rateService.ts`, `snapshotAdapter.ts`, `affiliations.ts`, `definitions/onboarding.ts`; the athlete-facing research route untouched |
| G6 cost | after the first night on dev (pending) |
| G7 lifecycle | after the first full-run wave on dev (pending) |
| G8 telemetry | every planner pass writes a row; every refresh run carries `workflow_run_id`, `as_of`, lane counters, per-domain outcomes (tests) |
| G9 concurrency | test F (two workers race for the last slot: exactly one call); dev route + script simultaneous invocation (pending) |

## 3. Tests (all PGlite, `--runInBand`; the research directory is already in the CI `checks` list)

| Suite | Covers |
|---|---|
| `ledger.test.ts` | **E** retries consume the nightly budget; **F** last-slot race, day cap and per-run cap; **G** non-LLM lanes never touch the LLM counter, `other` lane cap, no path to the provider without a reservation |
| `freshness.test.ts` | **B** irrelevant/dropped evidence leaves the domain stale, out-of-plan claims dropped before any write; **C** trusted `none_found` refreshes, refused with a failed query; failure back-off deferral; **D** an older run cannot regress freshness; full runs: dates by outcome, Step 2a status rule kept |
| `planner.test.ts` | pure `evaluateNight` (E1, E4, seed_only never planned, first full run, rescan, dispute re-check cadence and cap, failure back-off, pending priority, admission against executed + reserved, signals lane, active/queued/daily-cap skips); **A** dry-run zero mutations; **H** single-flag-true states inert incl. the connect request path and the legacy sweep; enqueue mode (transitions applied, v2 runs keyed by day, pending consumed, nothing executes, second pass adds nothing) |
| `refresh.test.ts` | gate refusal with zero calls; run row opened with workflow link / `as_of`; reservations per query and extraction; extraction scope; at-least-once reuse; abandoned row closed; out-of-plan drop; refused reservation ⇒ `failed`, run `partial`; signals-only lane; incomplete query beats `none_found` |
| `researchRefreshV2.test.ts` | v2 registered as latest, v1 kept; a v2 run passes the plan and returns references; a refused refresh fails the step |
| `persist.test.ts`, `state.test.ts` (Step 2a) | unchanged and green under the outcome-based freshness |

## 4. Dev evidence (appended as the rollout proceeds; design §9)

| Step | Status | Evidence |
|---|---|---|
| 2 deploy applies 0047 | **done 11 Sep 2026** | merge 0cf9ae9 (#400, reviewed head 80dc8ee); deploy run 34558420494 applied `0047_research_planner` in the hand-written migrations step; drift gate "No drift"; dev revision `nomila-v2-00563-6fg` (image 0cf9ae9f). On dev: both tables, all 8 columns, all 4 indexes, `research_runs_domain_check` present; `RESEARCH_REFRESH_ENABLED=false`, `RESEARCH_SUBSTRATE_WRITE=false`; prod revision `nomila-v2-prod-00001-zcv` unchanged (neither flag); no `research_policy` / `research_freshness` rows at all (v0.2 not seeded, nothing active); no `research-planner` Scheduler job; 0 `research_runs` (no backfill); health 200; 0 error-level log lines on the revision |
| 3 planner dry-run on dev (flags off) | **done 11 Sep 2026** | two passes via `POST /api/internal/research-planner-cron` on the deployed revision (one default, one `?dryRun=true`; an unauthenticated call → 401): `mode=dry_run`, `status=ok`, evaluated 20 (raw/enriched/claimed/active roster), wouldMaterialize 20, proposed transitions `materialize 20, seed_only>identity_resolved 10, applied=false`, candidates 10, admitted 10 (all FULL first runs, trigger `identity_confirmed`, reserve 7 LLM attempts and est $0.16 each: planned 70 of 150 attempts, $1.60 of $5.00), enqueued 0. Checksums of `athlete_research_state`, `workflow_runs`, `research_runs`, `research_budget_days`, `athlete_facts`, `social_features`, `athlete_snapshots` identical before/after; the only writes were the two `research_planner_runs` rows (`policy_version=defaults`). Legacy behaviour with the gate false: `re-enrich-cron?dryRun=true` ran the legacy body (`reEnrichAllAthletes start count=8 dryRun=true` + 8 "would re-enrich" lines, no "superseded"); Step 1 substrate unchanged (social_metric_observations 15808, social_audience_distributions 7220, social_features 101, social_sync_runs 217, social_identities 13); Step 2a tables all 0 |
| 4 activate freshness v0.2-alpha + policy v0.2-alpha | pending (user's word) | |
| 5 substrate flag / backfill | pending (user's word) | |
| 6 Cloud Scheduler job on dev | pending (user's word) | |
| 7 `RESEARCH_REFRESH_ENABLED=true` on dev | pending (user's word) | |
| 8 two weeks of nightly evidence, Mia domain-refresh dry run, cost model correction | pending | |
