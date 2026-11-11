# Phase A · Step 2b — Research Lifecycle / Domain Refresh Planner (DESIGN + MIGRATION MAP, no code)

**Status:** APPROVED and FROZEN (11 Sep 2026) after design review rounds 1–2 plus two documentation corrections. The Step 2b implementation PR is built exactly against this document; no further design review unless implementation reveals a material architectural conflict. Nothing here is implemented. Step 2a (#397, migration 0046) is merged and live on dev with `RESEARCH_SUBSTRATE_WRITE=false`, zero substrate rows and the backfill unapplied.
**Spec:** Blueprint V1 / Commercial Intelligence Beta.1 §4 (research ladder: seed → identity → full research once, capped calls), §6 (as-of dates, freshness per signal family), §21.1 (evidence timestamps), §28.9 (source authority). Approved Step 2 design: `step2-research-canonical-profile-design.md` §5 (lifecycle), §5.3 (domains), §6 (freshness), §11 (2b row).
**Out of scope (by instruction):** Athlete Index (2c); claim/identity UI and the Athlete/User split (Step 3); reader migration and Context Builder (2d); MIA Signal Engine and scoring (Step 4); affiliation projection changes; backfill apply; enabling substrate writes in prod.

## Revision log (review round 2)

| Review point | Where it landed |
|---|---|
| One execution gate: `researchPlannerExecutionEnabled = RESEARCH_REFRESH_ENABLED && RESEARCH_SUBSTRATE_WRITE`; either flag false ⇒ dry-run, telemetry row only, legacy behaviour active | §4.1 gate definition and modes, §4.2, §4.3 manual, §4.4 step 1, §7, §8.3 (`config.ts`, `reEnrichAthletes.ts`, `admin.ts`, script), §9, G4 |
| Atomic nightly LLM cap under concurrent workers: `reserveLlmCall()` as an atomic check-and-reserve on a UTC-day ledger row before every Gemini/Kimi attempt, retries included; no reservation ⇒ no call | §5.1 ledger row + reservation, §4.4 step 4, §6, §8.1 (`research_budget_days`), §8.3 (`ledger.ts`), test F |
| LLM attempts separated from non-LLM calls: `maxLlmCallsPerNight` counts Gemini/Kimi only; Trends/GDELT in the signals lane; discovery and other API calls separately counted, never on the LLM counter | §5, §5.1, §8.1 columns, test G |
| Concurrency acceptance: two workers race for the last LLM slot, exactly one succeeds | §8.4 test F, G9 |

## Revision log (review round 1)

| Review point | Where it landed |
|---|---|
| Dry-run must be non-mutating; state transitions only in enqueue/apply mode | §4.1 modes, §4.2 `evaluate` vs `applyStateTransitions`, §2 events, §9 step 3, G4, test A |
| Domain refresh success defined strictly (accepted/corroborated evidence, or an explicit "searched, nothing new" outcome; failures, irrelevant evidence, dropped claims, incomplete queries leave the domain stale/missing) | §3.1 domain outcomes, §4.4 step 5–6, §8.3 `persist.ts`/`kimiExtract.ts`, tests B, C |
| D1 approved (signup byte-for-byte; seed-only signup deferred) | §1.1 T1/T2, §11 |
| D2 approved (monthly sweep no-op on dev only once execution is enabled; prod unchanged) | §8.3 `reEnrichAthletes.ts`, §9, §11 |
| D3 call caps authoritative; USD model provisional | §5 |
| D4 approved (duplicate grounded call in the adapter; `researchAthlete.ts` untouched) | §8.3, §11 |
| D5 approved (season/spike/assertion triggers deferred) | §4.3, §11 |
| D6 revised: explicit `social_handles` freshness family, 365 d | §3, §8.2 (`research_freshness v0.2-alpha`), §11 |
| D7 approved (one run row per merged execution, domain outcomes and call counts in `summary`) | §3.1, §4.4, §11 |
| D8 approved (athlete-facing route unchanged) | §11 |
| D9 revised: Cloud Scheduler → internal authenticated route + advisory lock is the target; no in-process cron for the planner | §4.1, §8.3, §9, §11 |
| Budget accounting from actual executed calls/cost + reservations for queued/in-flight runs; retries count | §5.1 ledger, §4.2 admission, §4.4 step 4, test E |
| Monotonic freshness under out-of-order runs | §3.2, §6, test D |
| Five acceptance tests | §8.4 A–E, §10 |

## What the athlete experiences, and what happens underneath

Today an athlete is researched in full when she signs up with a sport, and then the whole roster is researched again in full on the first of every month, whether or not anything changed. In between, every nightly re-score copies the old research forward with today's date, so a June fact carries a September timestamp. There is no budget: the monthly sweep runs five Gemini searches and five Kimi extractions per athlete, for every athlete, on every Cloud Run instance that happens to be up.

After 2b, each part of an athlete's profile has its own shelf life. Press goes stale after 30 days, a team after a season, a name after a year, an award never. Every night a planner looks at what has gone stale, what an event has asked for (a new connection, an operator's re-research), and what the night's budget allows, and refreshes only those parts for only those athletes. A part counts as refreshed only when the refresh actually found and accepted something about it, or searched properly and can say nothing new exists. A stale fact stays visible and marked stale until it is refreshed or the athlete asserts otherwise. Nothing is researched for an athlete whose identity is not yet resolved, so no money is spent on a bare name. Every refresh is a recorded run with calls, tokens, cost and a per-domain outcome, and every night's plan is a recorded planner run that says what it considered, what it admitted, what it deferred and why.

For the athlete nothing changes visibly in 2b: readers still read the legacy blob until 2d, and the planner is off on dev and absent on prod until each flag is flipped deliberately.

## 1. Current lifecycle and refresh paths (audit, 11 Sep 2026)

### 1.1 Everything that triggers research today

| # | Path | Trigger value | Guard / cadence | Cost control | Verdict for 2b |
|---|---|---|---|---|---|
| T1 | `onboarding` v1 step `research` (`workflow/definitions/onboarding.ts:66`) | `signup` | started by waitlist post with a sport (`routes/waitlist.ts:264`), app signup (`routes/auth.ts:184`), admin promote (`routes/admin.ts:227`); key `onboarding:<athleteId>` | none | **KEEP byte-for-byte** (D1 approved; seed-only signup deferred to the identity/reader transition) |
| T2 | `onboarding` v2 step `research` (`onboarding.ts:135`) | `signup` | skipped when a snapshot with research is younger than `RESEARCH_FRESH_DAYS = 7` (`onboarding.ts:88,122-127`) | none | **KEEP byte-for-byte** (D1) |
| T3 | `research_refresh` v1 (`definitions/researchRefresh.ts`) | `manual` | admin promote with `reresearch:true` and an existing onboarding run (`admin.ts:221-232`); no `idempotencyKey`, no `activeScope` | `retry.maxAttempts 2`, lease 3 min | **KEEP v1 for the admin path; ADD v2** driven by the planner (§8) |
| T4 | `POST /api/v1/athletes/:id/research` (`index.ts:271-299`) | `manual` | self-only, synchronous 60–120 s | none | **KEEP unchanged** (D8 approved); bypasses the budget, noted |
| T5 | monthly `reEnrichAllAthletes` (`skills/reEnrichAthletes.ts`) | `re_enrich` | node-cron `0 5 1 * *` (`index.ts:2034`), production only, **on every instance, no advisory lock, not in Cloud Scheduler**; selects every `enriched/claimed/active` athlete unconditionally; passes no `handles` (D7 of Step 2) | concurrency 2 | **REPLACE on dev only** once planner execution is enabled; **prod unchanged through 2b** (D2 approved) |
| T6 | `POST /api/internal/re-enrich-cron` (`index.ts:1612`) | `re_enrich` | cron secret, fire-and-forget | none | same as T5 |
| — | `first_look` on connect (`routes/oauthCallback.ts:219`) | — | key `connect:<connectionId>` | — | not research; becomes an **event source** for the planner (§4.3) |
| — | MIA tools, voice | — | none call research | — | — |

### 1.2 Freshness mechanisms that exist today

| Mechanism | Where | Value | 2b |
|---|---|---|---|
| onboarding v2 skip | `onboarding.ts:88` | 7 days | unchanged |
| connected analytics counted "fresh" inside research | `researchAthlete.ts:653` | 45 days | unchanged |
| `athletes.enriched_at` | overwritten on every run (`researchAthlete.ts:748`) | — | unchanged; not a freshness input |
| `athletes_current.research_updated_at` | `athletesCurrentWriter.ts:75` | — | unchanged; legacy readers only |
| carry-forward re-stamps stale research | `refreshScores.ts:253`, `fetchSocialData.ts:288,311` | — | unchanged until 2d (D1 of Step 2) |
| substrate domain TTL | `research/state.ts:31`, `policy.ts:24` defaults | identity 365 · affiliations 180 · achievements ∞ · press 30 · brand_mentions 180 · narrative 180 · social_handles 365 · signals 30 | **activated from `research_freshness`** (§3) |
| `athlete_research_state.next_due_at` / `domains[d].staleAfter` | written by `persist.ts:258-262` | **read by nothing** | the planner's input (§4) |
| `touchedDomains` marks every domain of a full run as researched | `persist.ts:277-284` | — | **replaced** by per-domain outcomes (§3.1) |

### 1.3 Cost controls today

There is no budget, daily cap, per-athlete cap or cost accounting. `kimi_usage.total_cost_usd` is hard-coded 0 (`researchAthlete.ts:694`). The only throttles are provider concurrency gates (`lib/llm.ts`: Gemini 8, Kimi 8, Moonshot 4), Gemini `MAX_RETRY = 5` per query (up to 25 attempts per run), a 60 s Kimi timeout and the re-enrich batch of 2. Fan-out per full run: 5 Gemini grounded queries + Trends + GDELT + 5 Kimi extractions + platform discovery, plus one Kimi cited extraction when the substrate flag is on. `research_runs.estimated_cost_usd` and `athlete_research_state.total_cost_usd` are recorded by 2a but never checked.

### 1.4 What 2a already provides and what is missing for a lifecycle

| Present (2a) | Missing (2b builds) |
|---|---|
| five states with CHECK; `deriveResearchState` and `domainStatus` (pure) | state is recomputed **only when a run persists**; nothing moves `complete → stale` on its own |
| `domains` jsonb with `staleAfter`, `next_due_at` | nothing reads them; no planner; no event requests |
| `research_runs` triggers `ttl`, `event` in the CHECK | never written; no per-domain runs; `domain` column has no CHECK; the run row is created only at persist time, so calls are not visible while a run executes |
| `research_refresh` workflow, runner with leases, retry, one-active-run index, idempotency keys, `schedule` step kind | v1 runs the full legacy procedure; no domain input; no idempotency key from its caller |
| `research_policy` / `research_freshness` drafts, `getResearchPolicy()` reads **active** rows only | neither activated; no planner or budget keys in the policy; `RESEARCH_REFRESH_ENABLED` exists only in the design text |
| cost telemetry columns on `research_runs` | no cost model; no budget enforcement; no ledger of the night's actual calls |
| Gemini/Kimi/Trends/GDELT adapters (`lib/research/providers/*`) | the grounded search **call** still lives inside `researchAthlete.ts` (`runGemini`, module-private); the adapter only converts its raw output |
| freshness updated by "touched" | no per-domain outcome; a run that found nothing relevant still marks the domain fresh; an older run finishing later overwrites a newer run's dates |

## 2. Target state machine

States are unchanged from the approved design (`seed_only`, `identity_resolved`, `research_partial`, `research_complete`, `research_stale`); connection status remains derived and unstored (R2). 2b adds the **transitions**, who fires them, and when. Transitions fired by the planner (E0, E1, E4) are written **only in enqueue mode** (`applyStateTransitions`, §4.1); in dry-run mode they are computed and reported, never written.

```
                 ┌──────────────────────── E1 identity signal ───────────────────────┐
                 │                                                                   ▼
 [athlete row] ──► seed_only ──(E1)──► identity_resolved ──(E2 full run)──► research_partial ◄──┐
                     ▲                                                          │      ▲          │
                     │ (never: identity is not withdrawn by research)            │(E3)  │(E5)      │(E5)
                     │                                                          ▼      │          │
                     │                                              research_complete ─(E4 TTL pass)─► research_stale
                     │                                                          ▲                      │
                     │                                                          └───── (E6 refresh) ────┘
```

| Event | From → to | Guard | Fired by | Writes |
|---|---|---|---|---|
| **E0 materialise** | (no row) → `seed_only` | athlete row exists | planner **enqueue mode** (insert … on conflict do nothing); any persist | state row |
| **E1 identity signal** | `seed_only` → `identity_resolved` | any of: active connection in `connected_accounts`; `athletes.claimed_at` or `auth_id` set (today's dual-write rule); rule-7 evidence (name + sport + current affiliation at tier ≤ 2, `resolve.ts`) | planner **enqueue mode** (reads connections/claim), persist (rule 7) | `identity_confidence` 1.0 for claim/connection, 0.8 for rule 7; `identity_resolved_at` |
| **E2 first full run** | `identity_resolved` → `research_partial` / `research_complete` | planner admits a `full` plan (trigger `identity_confirmed`) or an operator runs `manual` | refresh run → `persist` → `deriveResearchState` | domains with a fresh outcome (§3.1) |
| **E3 gap closed** | `research_partial` → `research_complete` | no blocking domain missing/partial/blocking-disputed and no required domain missing/partial | persist after a refresh, or an assertion (Step 3) | — |
| **E4 TTL pass** | `research_complete` → `research_stale` | any required domain's `staleAfter ≤ now` | planner **enqueue mode** (pure re-derivation from stored `staleAfter`; no fact reads) | `domains[d].status = stale`, `research_status` |
| **E5 blocking dispute** | any researched state → `research_partial` | a `disputed` fact on `name`, `sport` or `affiliation` | persist | `disputed_domains` |
| **E6 domain refresh** | `research_stale` → `research_complete` (or `research_partial`) | the stale required domains reached a fresh outcome (`refreshed` or `confirmed_empty`, §3.1) | refresh run → persist | those domains: `lastRunId`, `lastResearchedAt`, `staleAfter` |
| **E7 event request** | no state change | connect, operator re-research, (Step 3: assertion change) | `requestRefresh()` (§4.3) | `pending` list on the state row; `next_due_at = now` |

Rules the machine enforces, all of which are already true of `deriveResearchState` except the pass that fires E4:

- A non-blocking dispute never blocks (`hometown` disputed ⇒ `research_complete`, `disputed_domains = ['identity']`).
- `research_stale` is only reachable from `research_complete`; a partial athlete with a stale non-blocking domain stays `research_partial` (the gap outranks the staleness).
- Identity is never withdrawn by research. Only Step 3 (a rejected claim) may move an athlete back to `seed_only`; 2b defines no such transition.
- `seed_only` athletes are **never planned** (spec §4: no full research from a bare name). The signup path (T1/T2) still researches them today through the legacy procedure, unchanged in 2b (D1).

## 3. Domain TTL matrix and refresh semantics

TTLs come from `research_freshness v0.2-alpha` (the v0.1-alpha draft plus an explicit `social_handles` family, D6), activated in 2b after review, mapped to the substrate families by `config.ts`. Two cadences are distinct: **TTL** (when current facts stop counting as current) and **rescan** (when to look for *new* dated items in a domain whose facts never expire). Rescan and dispute re-check cadences are new `research_policy` keys (§5), not freshness changes.

| Domain | Freshness family | TTL | Rescan | Refresh unit (what one refresh run does) | Providers | Est. calls |
|---|---|---|---|---|---|---|
| identity | `identity` | 365 d | — | query Q1 (profile: name, hometown, class year, teams) → cited extraction restricted to identity keys | Gemini ×1, Kimi ×1 | 2 |
| profile | `competition_level` (shares the affiliations family; no own family) | 180 d | — | refreshed together with `affiliations` (same Q1) | shared | 0 extra |
| affiliations | `competition_level` | 180 d | — | Q1 + rule-7 resolution; season boundary trigger deferred (D5) | Gemini ×1, Kimi ×1 | 2 |
| achievements | `achievements` | never | **90 d** | Q3 (performance + press) → new dated items only; existing facts untouched | Gemini ×1, Kimi ×1 | 2 |
| press | `press_mentions` | 30 d (history 90 d) | — | Q3 shared with achievements when both are due; otherwise Q3 alone | Gemini ×1, Kimi ×1 | 2 |
| brand_mentions | `brand_mentions` | 180 d | — | Q2 (commercial + brand) | Gemini ×1, Kimi ×1 | 2 |
| narrative | `narrative` | 180 d | or on any refresh | no query of its own: `story_arc` / sentiment inferences are re-derived by the extraction of whatever run touches the athlete; a narrative-only refresh re-runs extraction over the **stored** latest payloads (no search) | Kimi ×1 | 1 |
| social_handles | **`social_handles`** (new family, D6) | **365 d** initial | — | Q5 (handles) + platform discovery; superseded by a connection whenever one exists | Gemini ×1, discovery | 1–2 |
| signals | `search_interest` | 30 d | — | Trends + GDELT numbers; no LLM | Trends, GDELT | 0 LLM |

Q1–Q5 are the five legacy queries in `researchAthlete.ts buildQueries` (Profile + Social, Commercial + Brand, Performance + Press, Media Assets, Social Handles), reused verbatim so that dev evidence is comparable with today's runs. Q4 (media assets) is not a research domain and is not planned. When several domains are due for one athlete on one night the planner **merges** them into one run: the union of their queries runs once, one Kimi cited extraction runs over the union of envelopes, and `persist` records one `research_runs` row (`domain = 'refresh'`) with a per-domain outcome and call count in `summary.domains` (D7). A full run is the union of Q1, Q2, Q3, Q5 + signals (4 Gemini + 1 Kimi + 2 signal calls; today's legacy full run is 5 + 5 + 2).

Refresh semantics, per the approved §6: evidence is never deleted; a refresh **adds** evidence (deduped by `dedupe_key`) and re-resolves facts under the authority policy; a stale fact stays `current` and visible, its domain marked `stale`, until the refresh produces a cited replacement or corroboration, or the athlete asserts. Raw payloads keep the 90-day retention.

### 3.1 When a domain becomes fresh (domain outcomes)

"Touched" is not enough. A planned domain reaches exactly one outcome per run, recorded in `research_runs.summary.domains[d]`, and only the first two outcomes move `lastResearchedAt`, `staleAfter` and `lastRunId`:

| Outcome | Definition | Effect on the domain |
|---|---|---|
| `refreshed` | at least one **domain-relevant** evidence row was accepted (cited lineage, not suspect, of an evidence kind that maps to the domain) **and** the resolver accepted, corroborated or re-confirmed at least one fact of the domain (a new `current` fact, a corroboration of an existing current fact by a new independent evidence row, or a dated item added); for evidence-only domains (press, signals, narrative, social_handles) at least one accepted evidence row or inference of the domain suffices | `lastResearchedAt = run.asOf`, `staleAfter = asOf + TTL`, status re-derived (`complete`, or `disputed` if a blocking/non-blocking dispute arose) |
| `confirmed_empty` | every query in the domain's plan **completed** without a provider error, at least one grounded chunk was reviewed, and the extractor returned an explicit per-domain `none_found` outcome ("searched, no new information about <domain> for this athlete") with the reviewed chunk ids | same as `refreshed` (the search was done and found nothing new); recorded as `confirmed_empty` so the build record can measure how often "nothing new" is claimed |
| `no_relevant` | the queries completed but every claim for the domain was dropped (uncited, out of plan, suspect, injected, failed registry validation, resolver-rejected) or the evidence was irrelevant to this athlete/domain, and the extractor did **not** assert `none_found` | **no change**: the domain stays `stale` / `missing`; counted as a non-successful attempt (§7 back-off) |
| `failed` | any query of the domain's plan failed after its retry cap, was cut by `maxCallsPerRun` or the nightly budget, timed out, or the extraction/parse for the run failed | **no change**; failure counter increments (§7) |
| `not_planned` | domain not in the plan | no change |

Rules:

- `none_found` is only trusted when the extractor was **asked** about that domain (the restricted prompt lists the planned domains) and the run's queries for that domain all completed. An extractor that says `none_found` for a domain whose query failed yields `failed`, not `confirmed_empty`.
- A run may be `ok` overall with some domains `no_relevant` or `failed`; the run status stays `partial` in that case (2a vocabulary), and the planner sees the unchanged domains as still due.
- The same rule applies to full runs (`identity_confirmed`, and the legacy `dual_write` mirror while the substrate flag is on): a domain of a full run becomes fresh only by outcome. This replaces the 2a `touchedDomains` inference ("a full run touches every domain"), which is the one 2a behaviour 2b changes; the 2a persist tests that assert domain dates after a full run are updated accordingly and listed in §8.4.
- Fact-level freshness is unchanged: facts carry `retrieved_at`; the domain date is a summary for planning, not a fact attribute.

### 3.2 Monotonic freshness under out-of-order runs

A legacy run (signup, admin v1, athlete route) and a planner run can finish in either order, and a retried step can persist after a newer run. Every persist carries the run's own `asOf` (the provider `retrievedAt` captured when its searches ran, not the commit time), and domain freshness is **monotonic in `asOf`**:

- `domains[d]` is updated only if the run's outcome for `d` is `refreshed` or `confirmed_empty` **and** `run.asOf ≥ domains[d].lastResearchedAt`. An older run finishing later cannot move `lastResearchedAt`, `staleAfter`, `lastRunId` or the status of a domain backwards; its skipped updates are recorded in `summary.domains[d].freshnessSkipped = 'older_than_current'`. Its evidence and facts are still persisted (they are dated by their own `retrieved_at`, and the resolver's recency rule already prefers newer evidence).
- `research_status` is re-derived from the merged `domains` after the guard, so an older run cannot regress `research_complete` to `research_stale` either.
- The state row is read with `SELECT … FOR UPDATE` inside the persist transaction, so two persists for the same athlete serialise and both see the other's committed dates.
- The planner's E4 pass uses the stored `staleAfter` only; it never sets dates.

## 4. Planner

### 4.1 When, where and in which mode it runs

- **Cadence:** nightly at `10 5 * * *` UTC (after the 04:30 social collect → discovery → re-score chain; clear of the Stories sweep at :20 every 8 h and the last-look tick at :40).
- **Target mechanism (D9 revised):** a **Cloud Scheduler** job `research-planner | 10 5 * * * | POST /api/internal/research-planner-cron | deadline 600s` declared in `scripts/provision-schedulers.sh` and applied with `APPLY=1` as a rollout step (§9), calling the **internal authenticated route** (`cronSecretValid`, the `x-cron-secret` header) which takes the **advisory lock** `LOCK_RESEARCH_PLANNER` (declared in `lib/pgAdvisoryLock.ts`) and runs one pass. The planner endpoint bounds its own wall clock (`budgetMs` under the Scheduler deadline) so it stops cleanly rather than being cut off. **No in-process `cron.schedule` is added for the planner**: Cloud Run instances are not a durable scheduler (the monthly re-enrich shows the failure mode: every instance fires, no lock). The script `server/scripts/researchPlanner.ts --dry-run | --apply [--athlete <id>] [--as-of <iso>]` calls the same function for dev evidence and takes the same lock.
- **One execution gate (review round 2).** Every behaviour change in 2b hangs off a single derived predicate in `research/config.ts`:

```ts
export function researchPlannerExecutionEnabled(): boolean {
  return process.env.RESEARCH_REFRESH_ENABLED === "true" && researchSubstrateWriteEnabled();
}
```

  It gates, with no other flag reads anywhere in 2b code: the planner's `enqueue` mode, `applyStateTransitions`, workflow enqueue, `pending` consumption and `last_planned_at`, the refresh step's provider calls, the connect-callback and admin `requestRefresh` writes, the dev monthly re-enrich suppression, the admin v1 → planner routing, and the script's `--apply`. The intermediate state `RESEARCH_REFRESH_ENABLED=true / RESEARCH_SUBSTRATE_WRITE=false` is therefore inert: the planner stays dry-run, the monthly sweep keeps running, admin re-research keeps starting v1, and no lifecycle row changes while canonical refresh execution cannot run.

  **Invariant:** *if either execution flag is false, planner execution is non-mutating and legacy behaviour remains active.*

- **Modes and mutation contract:**

| Mode | When | Reads | Writes |
|---|---|---|---|
| `dry_run` | `researchPlannerExecutionEnabled() = false` (default: either flag false), or `?dryRun=true`, or the script without `--apply` | state rows, connections, claims, today's budget ledger | **only** a `research_planner_runs` row (`mode = 'dry_run'`) carrying the proposed transitions and the proposed plan. **Zero writes to `athlete_research_state`, `workflow_runs`, `research_runs`, `research_budget_days`**: no materialisation (E0), no identity transitions (E1), no stale transitions (E4), no `pending` consumption, no `last_planned_at`. Virtual rows for athletes without a state row are computed in memory and reported as `wouldMaterialize`. |
| `enqueue` | `researchPlannerExecutionEnabled() = true` and not `dryRun`, or the script with `--apply` (which refuses unless the gate is true) | same | `applyStateTransitions` (E0, E1, E4, `last_planned_at`, `pending` consumption for admitted domains) **then** `startRun` per admitted plan, then the planner row |

- **No spend without a canonical writer** follows from the gate: a refresh run refuses every provider call unless `researchPlannerExecutionEnabled()` is true, which includes the substrate write flag.

### 4.2 Algorithm

```
runResearchPlanner({ asOf = now, mode }):                       // mode = enqueue only if researchPlannerExecutionEnabled() (§4.1), else dry_run
  lock LOCK_RESEARCH_PLANNER or return { status: "skipped" }
  policy  = getResearchPolicy()                                  // active research_policy + research_freshness over defaults
  ledger  = nightlyLedger(asOf)                                  // §5.1: actual calls/cost executed today + reservations
  planner = insert research_planner_runs { status: running, mode, as_of, policy_version }

  ── evaluate (PURE: no writes in either mode) ─────────────────────────────────────
  rows      = state rows ∪ virtual seed_only rows for athletes (raw/enriched/claimed/active) without one   // E0 proposal
  proposed  = []
  for each row s:
    identity = active connection exists(s.athlete_id) or athletes.claimed_at/auth_id set
    s' = clone(s)
    if s'.research_status = 'seed_only' and identity: s'.research_status ← identity_resolved (1.0)   // E1 proposal
    for d in domains: if s'.domains[d].staleAfter <= asOf and status = 'complete': status ← 'stale'  // E4 input
    s'.research_status ← deriveResearchState(identity, s'.domains, blockingDisputes(s'))              // E4 proposal
    if s' ≠ s: proposed += (s, s')

  candidates = []
  for each s' with research_status in (identity_resolved, research_partial, research_complete, research_stale):
    if activeRunFor(athlete, 'research_refresh') or ledger.queuedFor(athlete): skip (reason active_run)
    due = {}
    if research_status = 'identity_resolved' and no domain has lastResearchedAt: due = FULL (trigger identity_confirmed)
    else:
      for d in PLANNABLE_DOMAINS:                                      // all but 'profile' (rides with affiliations)
        st = s'.domains[d]
        if st.status in ('missing','stale'):                                                  due += d (trigger ttl)
        if TTL[d] = null and st.lastResearchedAt + rescanDays[d] <= asOf:                     due += d (trigger ttl)
        if st.status = 'disputed' and st.lastResearchedAt + disputeRecheckDays <= asOf
           and s'.refresh_failures[d].disputeRechecks < maxDisputeRechecks:                   due += d (trigger ttl)
      for p in s'.pending: due += p.domain (trigger event / manual, reason p.reason)
      due -= { d : s'.refresh_failures[d].deferredUntil > asOf }                              // failure back-off (§7)
    if due is empty: continue
    candidates += { athlete, domains: due, trigger: max-priority trigger, queries: union(Q for due),
                    reserveCalls: min(estCalls(due) + retryAllowance, maxCallsPerRun), estUsd }

  priority (stable sort, highest first):
    1. pending manual/event requests
    2. athletes with an active connection or status active/claimed (real users) over raw
    3. plans containing a blocking domain that is missing/partial (identity, affiliations)
    4. most overdue first: max over due domains of (asOf − staleAfter)
    5. cheaper plan first on ties

  admission (against the ledger, §5.1):
    remaining = { runs: maxRunsPerNight − ledger.runsToday,
                  calls: maxLlmCallsPerNight − ledger.callsExecutedToday − ledger.callsReserved,
                  usd:   maxUsdPerNight − ledger.usdExecutedToday − ledger.usdReserved }
    for plan in candidates:
      if plan.estUsd > maxUsdPerRun:                       deferred += (plan, 'run_over_cap'); continue
      if plan.reserveCalls > remaining.calls or remaining.runs < 1 or plan.estUsd > remaining.usd:
                                                           deferred += (plan, 'budget'); continue
      admitted += plan; remaining −= plan                  // signals-only plans draw on the signals lane instead

  ── apply (ENQUEUE MODE ONLY: researchPlannerExecutionEnabled() = true) ──────────
  if mode = enqueue:
    applyStateTransitions(proposed)                        // E0 inserts (on conflict do nothing), E1/E4 updates,
                                                           // guarded: UPDATE … WHERE updated_at = s.updated_at (no clobber)
    for plan in admitted:
      startRun({ process: 'research_refresh', version: 2, athleteId, createdBy: 'schedule',
                 idempotencyKey: `research_refresh:${athleteId}:${asOf.date}`,
                 input: { domains, trigger, reason, plannerRunId, reserveCalls, estUsd, policyVersion } })
      consume s.pending for the admitted domains; s.last_planned_at = asOf

  finish planner row { status: ok, mode, evaluated, transitions: counts(proposed) [+ applied: true|false],
                       wouldMaterialize, candidates, admitted, deferred (by reason),
                       budget { limit, executedToday, reserved, planned }, plans[≤200] }
```

The signals lane (Trends + GDELT, no LLM) is admitted under its own counter (`maxSignalRunsPerNight`) so that a tight LLM budget never starves the free refresh, and a signals-only plan never consumes the LLM budget.

### 4.3 Triggers

| Trigger (`research_runs.trigger`) | Source | 2b behaviour |
|---|---|---|
| `ttl` | planner: stale/missing domain, rescan due, dispute re-check | planned nightly under budget |
| `identity_confirmed` | planner: first full plan for an `identity_resolved` athlete with no research | planned nightly under budget; **the only path to a full run in the substrate** besides today's dual-write |
| `event` | `requestRefresh(athleteId, domains, 'event', reason)` from the connect callback (`oauthCallback.ts`, next to the `first_look` start): domains `identity`, `social_handles` | only when `researchPlannerExecutionEnabled()`: request written to `state.pending`, `next_due_at = now`; executed by the next planner pass (never immediately, so the budget holds). Gate false ⇒ no write |
| `manual` | `requestRefresh(…, 'manual', 'admin re-research')` from the admin promote route when `reresearch:true` **and** `researchPlannerExecutionEnabled()`; the script with `--athlete` | same queue, top priority. With the gate false (either flag), admin re-research keeps starting `research_refresh` v1 exactly as today |
| `dual_write` | unchanged (legacy signup/monthly run mirrored into the substrate while the substrate flag is on); freshness by outcome (§3.1) | unchanged trigger |
| `signup`, `backfill` | unchanged (backfill script, not applied) | unchanged |
| season boundary, GDELT count spike, assertion change | — | **deferred** (D5 approved); policy keys reserved, no code |

### 4.4 The refresh run (`research_refresh` v2)

One workflow step, kind `model`, lease 5 min, `retry.maxAttempts 2`, `activeScope` default (one active refresh per athlete):

1. Refuse (fail fast, no provider call) unless `researchPlannerExecutionEnabled()` (both flags).
2. If `research_runs` already has a row with `workflow_run_id = ctx.runId` and status `ok|partial`, return it (at-least-once safety, §6).
3. **Open the run row first**: insert `research_runs { status: running, domain: 'refresh', trigger, workflow_run_id, started_at, summary: { plan } }` before any provider call, so the night's ledger (§5.1) sees the run and its calls while it executes. Build hints exactly as `researchDualWrite.hintsFor`; collect the sanitiser secrets.
4. Run the plan's queries through the adapter's grounded search. **Before every Gemini or Kimi attempt, retries included,** the step calls `reserveLlmCall(runId)` (§5.1): one atomic check-and-reserve against the UTC-day ledger row (`maxLlmCallsPerNight`) and the run's own counter (`maxCallsPerRun`). **If the reservation fails, no provider call occurs**; the step stops issuing LLM calls, marks the remaining LLM-backed domains `failed (budget)` and continues to persist what it has. A reservation is consumed whether the attempt succeeds or fails, so **retries count against the same nightly cap**. Trends/GDELT for `signals` and platform discovery for `social_handles` go through `recordNonLlmCall(runId, lane)` (signals lane counter, or `other_calls`), never through the LLM reservation.
5. One `extractWithCitations` over the envelopes with the extraction prompt restricted to the planned domains' evidence kinds and **asking for a per-domain outcome** (`found` with claims, or `none_found` with the reviewed chunk ids). Claims outside the plan are dropped before persist and counted in `summary.droppedOutOfPlan`.
6. `persistResearchRun({ runId, asOf: retrievedAt, plan, domainOutcomes, … })`: the existing transactional persist, extended to compute the outcome per domain (§3.1) after resolution, apply the monotonic guard (§3.2), and write `summary.domains[d] = { outcome, calls, accepted, dropped, freshnessSkipped? }`.
7. Record `refresh_failures[d]` (reset on `refreshed`/`confirmed_empty`, increment on `failed`/`no_relevant`); return `{ researchRunId, status, outcomes }` (references only, under the 8 KB step payload cap).

The legacy blob (`athlete_snapshots.research`) is **not** written by a planner run. Legacy readers keep the last legacy research until 2d (D2).

## 5. Cost and call-budget policy

`research_policy v0.2-alpha` (draft in `seedModelParams.ts`, schema `research-policy-config/2`; activation is a separate reviewed act). New keys, with the initial dev guardrails proposed for review (D3):

```jsonc
{
  // … v0.1-alpha keys unchanged: rawRetentionDays, uncitedConfidenceCap, minCorroboration, domains, sourceTypeTiers …
  "planner": {
    "maxRunsPerNight": 25,           // dev roster is 101 athletes; a full cycle of a 30-day domain takes ≤ 4 nights
    "maxLlmCallsPerNight": 150,      // AUTHORITATIVE: Gemini + Kimi ATTEMPTS only, retries included; atomic reservation (§5.1)
    "maxCallsPerRun": 8,             // AUTHORITATIVE: LLM attempts per run (full = 4 Gemini + 1 Kimi + retry head-room); non-LLM calls are not counted here
    "geminiRetryMax": 2,             // AUTHORITATIVE for planner runs; the legacy path keeps MAX_RETRY 5
    "retryAllowancePerRun": 2,       // reservation head-room for retries when a plan is admitted
    "maxUsdPerNight": 5.00,          // PROVISIONAL (cost model, §5.2)
    "maxUsdPerRun": 0.60,            // PROVISIONAL
    "maxRunsPerAthletePerDay": 1,
    "maxSignalRunsPerNight": 200,    // signals lane (Trends/GDELT); no LLM
    "maxOtherCallsPerNight": 400,    // discovery and other non-LLM API calls: observable and capped separately, never on the LLM counter
    "rescanDays": { "achievements": 90 },
    "disputeRecheckDays": 30,
    "maxDisputeRechecks": 3,         // then the dispute waits for an assertion (Step 3)
    "failureDeferDays": 7,           // after maxConsecutiveFailures on a domain
    "maxConsecutiveFailures": 3
  },
  "costModel": {                     // PROVISIONAL estimates; replaced by measured medians after two weeks on dev (G6)
    "gemini_grounded": { "perCallUsd": 0.035, "perMTokInUsd": 0.30, "perMTokOutUsd": 2.50 },
    "kimi_extract":    { "perMTokInUsd": 0.60, "perMTokOutUsd": 2.50 },
    "google_trends":   { "perCallUsd": 0 },
    "gdelt":           { "perCallUsd": 0 }
  }
}
```

**Call caps are the safety controls (D3).** `maxLlmCallsPerNight`, `maxCallsPerRun` and `geminiRetryMax` are enforced from counted attempts and do not depend on any price assumption; until measured token and cost data exist on dev they are the authoritative limits. The USD caps and the cost model are provisional: they inform admission ordering and `estimated_cost_usd`, and a wrong model cannot let the night exceed the call caps.

### 5.1 The nightly ledger: a UTC-day row with atomic reservation

The budget day is the UTC date. The authoritative LLM counter lives in one row per day, `research_budget_days` (§8.1), and every Gemini/Kimi attempt reserves its slot **atomically** before the call:

```sql
-- reserveLlmCall(runId): one statement, no read-then-write. Returns a row only if a slot was reserved.
INSERT INTO research_budget_days (day) VALUES ($day) ON CONFLICT DO NOTHING;      -- first caller of the day creates the row
UPDATE research_budget_days
   SET llm_attempts = llm_attempts + 1, updated_at = now()
 WHERE day = $day AND llm_attempts < $maxLlmCallsPerNight
RETURNING llm_attempts;
-- then, only if a row came back:
UPDATE research_runs SET llm_attempts = llm_attempts + 1
 WHERE id = $runId AND llm_attempts < $maxCallsPerRun
RETURNING llm_attempts;
-- if the per-run update returns nothing, the day slot is released (llm_attempts - 1) and the reservation fails.
```

The conditional `UPDATE … WHERE llm_attempts < cap` is serialised by Postgres row locking, so under any number of concurrent workflow workers at most `maxLlmCallsPerNight` reservations succeed per day; there is no window in which two workers both see the last slot. A failed reservation returns `false` and **no provider call is made**. Reservations are consumed on attempt, not on success, so retries count. The same shape is used for the two non-LLM lanes, which are observable and capped separately and never touch the LLM counter:

| Counter (day row · run row) | Counts | Cap | Reserved by |
|---|---|---|---|
| `llm_attempts` | Gemini grounded and Kimi attempts, retries included | `maxLlmCallsPerNight` · `maxCallsPerRun` | `reserveLlmCall(runId)` before every attempt |
| `signal_calls` | Google Trends, GDELT | `maxSignalRunsPerNight` (lane), no per-run cap | `recordNonLlmCall(runId, 'signals')` |
| `other_calls` | platform discovery and any other non-LLM API call | `maxOtherCallsPerNight` | `recordNonLlmCall(runId, 'other')` |

`nightlyLedger(asOf)` for planner admission reads the day row (actual attempts and calls executed today, retries included) plus reservations for runs that have not started calling:

| Component | Source | Counted as |
|---|---|---|
| `llmExecutedToday`, `signalsToday`, `otherToday` | `research_budget_days` row for the day | actual attempts/calls, retries included |
| `usdExecutedToday` | `research_runs` with `started_at` in the day (any status incl. `running`) | provisional cost |
| `runsToday` | `research_runs` rows with `trigger IN ('ttl','identity_confirmed','event','manual')` and `workflow_run_id IS NOT NULL` | runs against `maxRunsPerNight` |
| `llmReserved`, `usdReserved` | `workflow_runs` of process `research_refresh` v2 with status `running`/`waiting` whose research run row has **not** opened yet: `input.reserveCalls` and `input.estUsd` | planning reservation, released the moment the run row opens (its atomic reservations take over) |
| `queuedFor(athlete)` | the same queued runs, by athlete | skip re-planning |

Admission (§4.2) subtracts executed and reserved from the caps. A planner re-run the same night therefore admits only what the actuals and reservations leave. The planner's estimate is advisory; the day row is the authority at call time, so an under-estimated plan cannot push the night past the cap. Persist computes `estimated_cost_usd` from the cost model and the measured usage and adds it to `total_cost_usd`. In dry-run mode the day row is read, never written.

### 5.2 Expected steady-state load (provisional, from the TTL matrix)

Dev roster of 101 athletes, all `identity_resolved` or beyond after their first full run:

| Domain | Cadence | Runs / athlete / month | Gemini calls / athlete / month |
|---|---|---|---|
| press (+ achievements when both due) | 30 d | 1 | 1 |
| signals | 30 d | 1 (no LLM) | 0 |
| achievements rescan | 90 d | ⅓ | ⅓ |
| affiliations + profile | 180 d | ⅙ | ⅙ |
| brand_mentions | 180 d | ⅙ | ⅙ |
| narrative | 180 d or piggy-back | 0 extra | 0 |
| identity, social_handles | 365 d | ¹⁄₁₂ each | ¹⁄₁₂ each |
| **total** | | ≈ 1.8 (merged into ≈ 1.3 runs) | **≈ 1.8** vs **5 + up to 20 retries** today |

Kimi extractions fall from 5 per athlete-month to ≈ 1.3. The first full run per athlete (once, 4 Gemini + 1 Kimi) is the only step-change, spread over ≈ 4 nights by `maxRunsPerNight`. Domains that end `no_relevant` or `failed` come back the next night and raise the real load above this table; the build record reports the measured outcome mix per domain.

## 6. Idempotency and concurrency

| Concern | Mechanism |
|---|---|
| Two planner passes at once (Scheduler retry, a manual route call, the script) | `withAdvisoryLock(LOCK_RESEARCH_PLANNER)`; the loser records `skipped` |
| The same night planned twice (planner crash after partial enqueue, then a Scheduler retry) | `idempotencyKey = research_refresh:<athleteId>:<YYYY-MM-DD>` on `startRun` (existing unique index `workflow_runs_idempotency`), and admission subtracts today's actuals and reservations from the ledger (§5.1) |
| State transitions applied twice or over a concurrent persist | `applyStateTransitions` uses guarded updates (`WHERE updated_at = <read value>`); a row changed underneath is skipped and counted, never overwritten |
| Two refresh runs for one athlete | existing `workflow_runs_one_active (athlete_id, active_scope)`; the planner also checks `activeRunFor` and the ledger's queued set |
| A step executed twice (at-least-once runner; retry after a crash post-commit) | `research_runs.workflow_run_id` + partial unique index `WHERE status IN ('ok','partial')`; the step returns the existing successful run instead of re-calling providers. A retry after a crash mid-run finds the `running` row, closes it `failed (abandoned)` and opens a new one, so the abandoned attempt's calls stay in the ledger |
| Planner run and a legacy run on the same athlete finishing out of order | monotonic freshness by `asOf` (§3.2); state row `SELECT … FOR UPDATE` in each persist transaction; authority-based resolution and `dedupe_key` make arrival order irrelevant for facts |
| Several workflow workers calling providers at once | the nightly LLM cap is enforced by the atomic conditional update on the day row (§5.1), not by a read-check-increment; the per-run cap by the same pattern on the run row; the last slot goes to exactly one worker |
| Refresh execution rate | the runner's `workflow-tick` (Cloud Scheduler, every minute, batch 20) drains the night's runs; provider concurrency gates (Gemini 8, Kimi 8) bound the burst; `maxRunsPerNight` and the day row bound the total |
| Policy change mid-night | `getResearchPolicy()` is cached 60 s; each planner row and run records the `policy_version` it used |

## 7. Failure and retry policy

| Failure | Handling | Visible where |
|---|---|---|
| A provider call fails inside a run | retried up to `geminiRetryMax` (each attempt counted and ledger-checked); the domain ends `failed`; the run continues with the remaining queries and closes `partial`; the failed domain stays `stale`/`missing` and is due again tomorrow | `research_runs.error.subCalls`, `summary.domains[d]` |
| The run produced only irrelevant or dropped evidence for a domain | outcome `no_relevant`; no freshness change; counted as a non-successful attempt | `summary.domains[d]` |
| The step throws | runner retries once after back-off (1 min × jitter), then the run fails; the `running` research run row is closed `failed (abandoned)` by the retry or by the planner's next pass (rows `running` older than the lease); the day's idempotency key stops a same-day re-plan | `workflow_runs.last_error` (redacted), `research_runs.status = failed` |
| Consecutive non-successful attempts on one domain (`failed` or `no_relevant`) | `refresh_failures[d].count` increments; at `maxConsecutiveFailures` the domain gets `deferredUntil = +failureDeferDays` and is not planned until then; the counter resets on `refreshed`/`confirmed_empty` | state row; planner `deferred.by_reason.failure_backoff` |
| Sanitizer leak (`SanitizerLeakError`) | the whole canonical transaction rolls back (2a); the run closes `failed` with reason `sanitizer_leak`; counted as a failure **and** surfaced separately as `leakRefusals` on the planner row because it needs a human look | planner row, run row |
| Budget exhausted at planning | remaining candidates are `deferred` with reason `budget`; they keep their priority tomorrow | planner row |
| Budget exhausted mid-run | the step stops issuing calls; remaining domains `failed (budget)`; what was gathered is persisted | `summary.domains[d]`, run `partial` |
| Planner throws mid-pass | planner row `failed` with a redacted error; the lock releases with the session; in enqueue mode, runs already enqueued still execute; the next pass is safe by construction (§6) | planner row |
| Policy rows missing or wrong schema | `getResearchPolicy()` warns and uses the code defaults (2a behaviour); the planner records `policy_version = 'defaults'` | planner row, logs |
| Either execution flag off (`researchPlannerExecutionEnabled() = false`) | planner runs in dry-run and writes nothing but its own row; a refresh step fails fast with reason `execution_disabled` and no provider call; the monthly sweep, admin v1 and signup paths behave exactly as today | planner row `mode = dry_run` |
| LLM reservation refused (day or run cap reached) | no provider call; remaining LLM-backed domains `failed (budget)`; the run persists what it has as `partial` | `summary.domains[d]`, `research_budget_days` |

## 8. Proposed schema and code changes

### 8.1 Migration `0047_research_planner.sql` (IF NOT EXISTS throughout; mirrored in `shared/schema.ts` and the deploy CHECK list)

```sql
-- research_planner_runs: one row per pass (Scheduler, route or script; dry_run or enqueue)
CREATE TABLE IF NOT EXISTS research_planner_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text NOT NULL DEFAULT 'running',       -- running | ok | failed | skipped
  mode             text NOT NULL,                         -- dry_run | enqueue
  as_of            timestamptz NOT NULL,
  policy_version   text NOT NULL,                         -- research_policy version or 'defaults'
  evaluated        integer NOT NULL DEFAULT 0,
  would_materialize integer NOT NULL DEFAULT 0,           -- athletes without a state row (virtual in dry_run)
  transitions      jsonb NOT NULL DEFAULT '{}'::jsonb,    -- {"seed_only>identity_resolved": n, "research_complete>research_stale": n, …, "applied": bool}
  candidates       integer NOT NULL DEFAULT 0,
  admitted         integer NOT NULL DEFAULT 0,
  deferred         jsonb NOT NULL DEFAULT '{}'::jsonb,    -- by reason: budget | run_over_cap | failure_backoff | active_run
  budget           jsonb NOT NULL DEFAULT '{}'::jsonb,    -- {limit:{…}, executedToday:{calls,usd,runs}, reserved:{calls,usd}, planned:{…}}
  plans            jsonb NOT NULL DEFAULT '[]'::jsonb,    -- [{athleteId, domains, trigger, reserveCalls, estUsd, workflowRunId?}], capped at 200
  leak_refusals    integer NOT NULL DEFAULT 0,
  error            jsonb,
  CONSTRAINT research_planner_runs_status_check CHECK (status IN ('running','ok','failed','skipped')),
  CONSTRAINT research_planner_runs_mode_check   CHECK (mode IN ('dry_run','enqueue'))
);
CREATE INDEX IF NOT EXISTS research_planner_runs_started_idx ON research_planner_runs (started_at DESC);

-- athlete_research_state: event queue, failure back-off, planning marks
ALTER TABLE athlete_research_state
  ADD COLUMN IF NOT EXISTS pending          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{domain, trigger, reason, requestedAt}]
  ADD COLUMN IF NOT EXISTS refresh_failures jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {domain: {count, lastOutcome, lastError, deferredUntil, disputeRechecks}}
  ADD COLUMN IF NOT EXISTS last_planned_at  timestamptz;
CREATE INDEX IF NOT EXISTS athlete_research_state_due_idx ON athlete_research_state (next_due_at) WHERE next_due_at IS NOT NULL;

-- research_budget_days: the authoritative per-UTC-day counters, reserved atomically (§5.1)
CREATE TABLE IF NOT EXISTS research_budget_days (
  day           date PRIMARY KEY,
  llm_attempts  integer NOT NULL DEFAULT 0,   -- Gemini + Kimi attempts, retries included (maxLlmCallsPerNight)
  signal_calls  integer NOT NULL DEFAULT 0,   -- Trends + GDELT (signals lane)
  other_calls   integer NOT NULL DEFAULT 0,   -- discovery and other non-LLM API calls (maxOtherCallsPerNight)
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- research_runs: workflow link (one successful canonical run per workflow run); as-of; per-run counters by lane; ledger index; domain vocabulary
ALTER TABLE research_runs
  ADD COLUMN IF NOT EXISTS workflow_run_id uuid,
  ADD COLUMN IF NOT EXISTS as_of           timestamptz,                            -- the run's retrievedAt, the monotonic key (§3.2)
  ADD COLUMN IF NOT EXISTS llm_attempts    integer NOT NULL DEFAULT 0,             -- reserved per attempt (maxCallsPerRun)
  ADD COLUMN IF NOT EXISTS signal_calls    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_calls     integer NOT NULL DEFAULT 0;             -- `calls` (2a) stays the total of all three
CREATE UNIQUE INDEX IF NOT EXISTS research_runs_workflow_success ON research_runs (workflow_run_id)
  WHERE workflow_run_id IS NOT NULL AND status IN ('ok','partial');
CREATE INDEX IF NOT EXISTS research_runs_started_idx ON research_runs (started_at);   -- the nightly ledger scan
ALTER TABLE research_runs DROP CONSTRAINT IF EXISTS research_runs_domain_check;
ALTER TABLE research_runs ADD CONSTRAINT research_runs_domain_check
  CHECK (domain IN ('identity','profile','affiliations','achievements','press','brand_mentions','narrative','social_handles','signals','full','refresh'));
```

No column is dropped, renamed or retyped; every statement is additive and re-runnable; existing rows (none on dev) satisfy the new CHECK because 2a only writes `full`. Objects added by 0047: two tables, eight columns (three on the state row, five on `research_runs`), four indexes, one CHECK. `domains[d]` in the state jsonb gains `outcome` and `lastOutcomeRunId` (jsonb, no DDL). The drift gate reports the new table and columns as missing until the deploy applies 0047, as it did for 0046. Migration dry run (BEGIN … ROLLBACK against dev) and the deploy CHECK-list mirror are gates (G2, G3).

### 8.2 Model params (drafts inserted by `seedModelParams.ts --apply`; activation separate)

- `research_freshness v0.2-alpha` (schema unchanged, `research-freshness-config/1`): v0.1-alpha plus an explicit family `social_handles: { currentDays: 365, note: "public handles; superseded by a connection; identity cadence initially" }` (D6). `config.ts` maps `social_handles → social_handles` instead of `social_public`. All other values equal the code defaults, so activation changes no TTL and proves the read path.
- `research_policy v0.2-alpha` (schema `research-policy-config/2`): the §5 `planner` and `costModel` blocks. `config.ts` accepts `/2` and keeps accepting `/1` (the new blocks fall back to code defaults). Activate after the numbers are reviewed.

### 8.3 Code (all under the two flags; no behaviour change with both off)

| File | Change |
|---|---|
| `server/services/intelligence/research/planner.ts` | pure `evaluateNight(rows, connections, policy, ledger, asOf) → { proposed, candidates, admitted, deferred }`; `applyStateTransitions(tx, proposed)` (enqueue mode only, guarded updates); `runResearchPlanner({ mode, asOf, budgetMs })` orchestrator (lock, ledger, evaluate, apply, enqueue, planner row) |
| `research/ledger.ts` | `reserveLlmCall(runId)` (atomic conditional update on `research_budget_days` + the run row; `false` ⇒ no call), `recordNonLlmCall(runId, lane)`, `nightlyLedger(asOf)` (§5.1) |
| `research/plans.ts` | `DOMAIN_PLANS`: domain → query names, evidence kinds allowed, providers, estimated calls; `mergePlans(domains)`; `estimateCost(plan, policy.costModel)` |
| `research/refresh.ts` | `refreshAthlete({ athleteId, domains, trigger, reason, workflowRunId, reserveCalls })`: flags check, idempotent return, open the run row, hints, ledger-checked provider calls, restricted extraction with per-domain outcomes, `persistResearchRun(… runId, asOf, plan, domainOutcomes …)`, failure bookkeeping |
| `research/outcomes.ts` | pure `domainOutcome(plan, queryResults, extractionOutcome, acceptedByDomain) → refreshed \| confirmed_empty \| no_relevant \| failed` (§3.1) |
| `research/triggers.ts` | `requestRefresh(athleteId, domains, trigger, reason)` (append to `pending`, set `next_due_at = now`); no execution; **no-op unless `researchPlannerExecutionEnabled()`** |
| `research/persist.ts` | accept an already-open `runId`, `asOf`, `plan`, `domainOutcomes`, `workflowRunId`; compute outcomes after resolution; monotonic domain update (§3.2) with `SELECT … FOR UPDATE` on the state row; `summary.domains`; `refresh_failures` bookkeeping; cost from `costModel`. **Replaces `touchedDomains`** for full runs too (§3.1). No change to the sanitize → assert → persist path |
| `research/policy.ts`, `config.ts`, `types.ts` | `researchPlannerExecutionEnabled()` (the one gate, §4.1); `planner` and `costModel` defaults; schema `/2` reader with `/1` fallback; `social_handles` family mapping; `research_planner_runs` / `research_budget_days` types |
| `lib/research/providers/geminiGrounded.ts` | `groundedSearch(query, { queryName, retryMax, reserve })`: the grounded call **copied** from `researchAthlete.ts` (same client, model, nonce and empty-result handling) with a retry cap; `reserve()` is awaited before every attempt and a `false` result ends the query without calling; `researchAthlete.ts` is not modified (D4 approved). The duplicate is removed in 2d |
| `lib/research/providers/kimiExtract.ts` | `extractWithCitations(envelopes, hints, id, { allowedKinds, domains })`: restricted prompt that also asks for `domainOutcomes: { <domain>: { status: "found" \| "none_found", reviewedChunkIds } }` (schema `cited-claims/2`, parsed leniently; a missing block means "no assertion", never `none_found`) |
| `workflow/definitions/researchRefresh.ts` | `RESEARCH_REFRESH_V2` (version 2): input `{ domains, trigger, reason, plannerRunId, reserveCalls, estUsd }`, calls `refreshAthlete`; v1 kept unchanged for the admin path while the planner flag is off |
| `skills/reEnrichAthletes.ts` | first line: `if (researchPlannerExecutionEnabled()) { log "superseded by the research planner"; return { skipped: true } }`; nothing else changes. Suppression needs both flags; prod never sets either in 2b, so prod is unchanged (D2 approved) |
| `routes/oauthCallback.ts` | after the `first_look` start: `requestRefresh(athleteId, ['identity','social_handles'], 'event', 'connect:<platform>')` guarded by `researchPlannerExecutionEnabled()` (a queued request; no call). With the gate false a social connection must not add `pending`, change `next_due_at` or otherwise mutate the 2b lifecycle substrate through this path; `requestRefresh` itself checks the gate and is a no-op when it is false |
| `routes/admin.ts` | when `reresearch:true` and `researchPlannerExecutionEnabled()`: `requestRefresh(…, 'manual', 'admin re-research')` instead of starting v1; with the gate false, byte-for-byte today's path |
| `server/index.ts` | `POST /api/internal/research-planner-cron[?dryRun=true]` guarded by `cronSecretValid`, with `budgetMs` under the Scheduler deadline. **No in-process cron for the planner** (D9 revised) |
| `scripts/provision-schedulers.sh` | job line `research-planner|10 5 * * *|/api/internal/research-planner-cron|600s` (applied on dev as a rollout step; prod suffix not applied in 2b) |
| `lib/pgAdvisoryLock.ts` | `export const LOCK_RESEARCH_PLANNER = 4_913_207_002n;` |
| `gcp/cloud-run-{dev,prod}.yaml` | `RESEARCH_REFRESH_ENABLED: "false"` |
| `server/scripts/researchPlanner.ts` | `--dry-run` (default) / `--apply` / `--athlete <id>` / `--as-of <iso>`; prints the plan table, the transitions it would apply and the ledger line; `--apply` refuses unless `researchPlannerExecutionEnabled()` |
| `server/scripts/seedModelParams.ts` | `research_freshness v0.2-alpha` and `research_policy v0.2-alpha` drafts |
| `scripts/db-migrate.sh`, `.github/workflows/deploy-dev.yml` | 0047 in the hand-listed migrations; CHECK mirror |
| docs | `step2b-research-lifecycle.md` build record with dev evidence |

Not touched: `researchAthlete.ts`, `researchMerge.ts`, `athletesCurrentWriter.ts`, `refreshScores.ts`, `fetchSocialData.ts`, scoring, rates, MIA, affiliation projection, the athlete-facing research route, onboarding definitions.

### 8.4 Tests (PGlite, `--runInBand`, added to the CI `checks` list)

Acceptance tests named in the review:

- **A. Dry-run makes zero state mutations.** Seed athletes without state rows, a `seed_only` athlete with a connection, and a `research_complete` athlete with an expired `staleAfter`; run the planner in `dry_run`; assert `athlete_research_state`, `workflow_runs` and `research_runs` are byte-for-byte unchanged (row snapshots before/after), and the planner row reports `wouldMaterialize`, the proposed E1 and E4 transitions and the plan. Then run in `enqueue`: the same proposals are applied and the runs exist.
- **B. Irrelevant or dropped evidence leaves a domain stale.** A stale `press` domain; the mocked extractor returns only uncited/out-of-plan/suspect claims and no `none_found`; assert outcome `no_relevant`, `lastResearchedAt`/`staleAfter`/status unchanged, run `partial`, `refresh_failures.press.count = 1`, and the planner plans it again the next night.
- **C. Explicit "no new information" refreshes a domain.** Same setup; the mocked extractor returns `domainOutcomes.press = none_found` with reviewed chunk ids and every press query completed; assert outcome `confirmed_empty`, dates advanced to the run's `asOf`, status `complete`. Negative twin: `none_found` with a failed press query ⇒ `failed`, no date change.
- **D. An older run finishing later cannot regress freshness.** Persist run N (asOf T2) then run M (asOf T1 < T2) for the same athlete and domain, both with `refreshed`; assert `lastResearchedAt = T2`, `lastRunId = N`, `staleAfter = T2 + TTL`, `research_status` unchanged, and M's `summary.domains[d].freshnessSkipped = 'older_than_current'` while M's evidence rows exist.
- **E. Retries consume the nightly call budget.** Policy `maxLlmCallsPerNight = 6`, `geminiRetryMax = 2`; one run whose first query fails twice before succeeding (3 attempts) and a second query (1 attempt); assert `research_budget_days.llm_attempts = 4` and `research_runs.llm_attempts = 4` during and after the run, the ledger reports 4 executed, and the next plan admits only what 2 remaining calls allow (a second run is deferred with reason `budget`); a run that hits the nightly cap mid-way stops calling and marks the remaining domains `failed (budget)`.
- **F. Two workers race for the last LLM slot; exactly one succeeds.** Day row at `llm_attempts = maxLlmCallsPerNight − 1`; two refresh runs on two athletes call `reserveLlmCall` concurrently (`Promise.all`, real PGlite transactions); assert exactly one reservation returns `true`, exactly one mocked provider call happens, the day row ends at the cap, the loser's domain is `failed (budget)` with no call, and the same holds for the per-run cap on one run with two concurrent query tasks.
- **G. Non-LLM calls never touch the LLM counter.** A signals-only run and a social_handles run with discovery: assert `llm_attempts` unchanged by Trends/GDELT/discovery, `signal_calls` and `other_calls` incremented on both the day row and the run row, `maxOtherCallsPerNight` refuses discovery when reached without affecting LLM reservations, and a run cannot bypass `reserveLlmCall` (the adapter has no code path to Gemini/Kimi without a reservation: the mocked provider asserts it is only ever called after a successful reservation).
- **H. The execution gate.** With `RESEARCH_REFRESH_ENABLED=true` and `RESEARCH_SUBSTRATE_WRITE=false` (and the reverse): the planner runs `dry_run` and writes only its row; `reEnrichAllAthletes` runs its legacy body (mocked `researchAthlete` called); admin re-research starts v1; the script `--apply` refuses; a refresh step fails fast with `execution_disabled` and zero provider calls; **the connect callback's `requestRefresh` writes nothing** (`pending` stays `[]`, `next_due_at` unchanged, no state row created). With both true: enqueue mode, suppression, routing, the connect request and `--apply` all engage.

Also:

- planner pure: E1 from connection and from claim; E4 from stored `staleAfter`; `research_partial` never becomes `research_stale`; dispute re-check cadence and `maxDisputeRechecks`; rescan for null-TTL domains; pending requests outrank TTL; priority order; admission against executed + reserved; reservation released when the run row opens; signals lane independent of the LLM budget; failure back-off exclusion; `seed_only` never planned; guarded `applyStateTransitions` skips a row changed underneath.
- planner orchestration: enqueue mode creates one `research_refresh` v2 run per admitted athlete with the day key; a second pass the same night admits nothing beyond the ledger; the advisory lock skips; the route honours `?dryRun=true` and the gate.
- refresh run: fails fast with no provider call when either flag is off (mocked adapters assert zero calls); idempotent return on an existing successful `workflow_run_id`; abandoned `running` row closed on retry; `maxCallsPerRun` stops calls; restricted extraction drops out-of-plan claims; outcome per domain for `refreshed` (fact accepted, fact corroborated, evidence-only domain); cost computed from the cost model; sanitizer leak still rolls back (existing 2a tests unchanged).
- 2a persist tests updated: a full run's domain dates now follow outcomes, not "touched" (the fixtures already produce cited evidence per domain, so the expected states are unchanged; the assertions gain the outcome field).
- legacy: `reEnrichAllAthletes` is a no-op when the planner flag is on and unchanged when off; admin re-research path unchanged with the flag off; byte-for-byte check on the untouched files.

## 9. Migration and rollout sequence

| # | Step | Who | Flags after | Evidence |
|---|---|---|---|---|
| 0 | this design PR (docs only) → review | user | — | — |
| 1 | 2b implementation PR (0047, planner, ledger, refresh v2, outcomes, triggers, route, flags false, drafts, tests) → **code review, never merge on CI alone** | me → user | substrate false, refresh false | CI, migration dry run, drift gate report, byte-for-byte |
| 2 | merge → normal dev deploy applies 0047 | deploy | unchanged | 0047 in the log, table + columns + indexes exist, drift clean, 0 planner rows |
| 3 | planner **dry-run** on dev via the script (flags off): the proposed transitions and plan for the 101-athlete roster, cost estimate | me | unchanged | one `research_planner_runs` row `mode = dry_run`; **state, workflow and run tables unchanged** (row counts and checksums before/after in the build record). With no facts on dev (backfill unapplied) every athlete is a virtual `seed_only`/`identity_resolved`; the plan is the first-full-run wave, sized by `maxRunsPerNight` |
| 4 | activate `research_freshness v0.2-alpha` and `research_policy v0.2-alpha` on dev after the numbers are reviewed | user's word, then me | unchanged | `getResearchPolicy()` reports the row versions; dry-run re-run identical (freshness values equal the defaults) |
| 5 | (already pending from 2a, the user's call) flip `RESEARCH_SUBSTRATE_WRITE=true` on dev; run the backfill `--apply` or not | user | substrate true | as recorded in the 2a build record |
| 6 | provision the Cloud Scheduler job on dev (`APPLY=1 bash scripts/provision-schedulers.sh`, dev suffix only) | user approves, then me | unchanged | job listed; its first firings produce `dry_run` planner rows nightly (flag still false) |
| 7 | flip `RESEARCH_REFRESH_ENABLED=true` on dev by a one-line YAML PR (with step 5 done, the gate becomes true; if step 5 is not done, the flag is inert and the planner stays dry-run) | user approves | refresh true (+ substrate true ⇒ gate true) | first night: planner row `mode = enqueue`, transitions applied, ≤ 25 runs, `research_runs` with `trigger` in (`identity_confirmed`, `ttl`), outcome mix and lane counters per run, `research_budget_days.llm_attempts ≤ maxLlmCallsPerNight`, zero legacy writes from planner runs; the monthly cron logs "superseded" on the 1st (dev only) |
| 8 | two weeks of nightly evidence; Mia domain-refresh dry run (`--athlete`) reviewed with the user; cost model corrected from measured medians | me → user | unchanged | build record §4 |
| — | prod | nothing in 2b; prod has neither flag and no Scheduler job; the monthly re-enrich keeps running there through 2b (D2) | — | — |

**Invariant through every step: if either execution flag is false, planner execution is non-mutating and legacy behaviour remains active.** Rollback at any step is a flip of either flag back to `false`: the gate turns false, the planner returns to dry-run (writing only its own rows), refresh runs fail fast, admin re-research starts v1 again and the monthly cron resumes on dev. 0047 is additive and needs no down migration. The Scheduler job can stay: with the gate false it produces dry-run rows only.

## 10. Gates and acceptance criteria

| Gate | Criterion |
|---|---|
| G1 tests | the §8.4 suites green in CI `--runInBand`, including acceptance tests A–H; the 2a suites green (updated where §3.1 changes a full run's domain bookkeeping) |
| G2 migration | 0047 dry run on dev (BEGIN … ROLLBACK) creates two tables, eight columns, four indexes and the CHECK; nothing remains after rollback; nothing applied by hand |
| G3 drift | drift gate reports exactly the 0047 objects as missing before the deploy and clean after |
| G4 execution gate | **If either execution flag is false, planner execution is non-mutating and legacy behaviour remains active**: zero provider calls from planner code paths (mocked adapters in tests; on dev zero `research_runs` rows with `trigger IN ('ttl','identity_confirmed','event')`), zero planner rows with `mode = enqueue`, **zero changes to `athlete_research_state`, `workflow_runs`, `research_runs` and `research_budget_days`** across a dry-run pass (checksums before/after), the monthly re-enrich body still runs, admin re-research still starts v1, `--apply` refuses. Verified for both single-flag-true states (test H) and on dev before step 7 |
| G5 legacy | byte-for-byte: no diff on the "not touched" list; the monthly cron unchanged with the flag off and on prod; admin re-research unchanged with the flag off; signup research unchanged |
| G6 cost | first night on dev within the call caps (authoritative) and the provisional USD cap; measured median calls, tokens and cost per run per domain recorded; the cost model corrected within ±30 % or the policy revised |
| G7 lifecycle | after the first full-run wave, every `identity_resolved` athlete on dev reaches `research_partial` or `research_complete`; no `seed_only` athlete has a run; `complete → stale` transitions appear on enqueue-mode planner rows as TTLs expire; a disputed non-blocking domain stays `research_complete`; a domain with outcome `no_relevant` or `failed` keeps its previous dates and is planned again |
| G8 telemetry | every pass has a planner row with executed/reserved/planned budget; every refresh run has `workflow_run_id`, `as_of`, calls (incremented per attempt), tokens, cost, status and per-domain outcomes; failed runs carry redacted errors only (2a leak tests) |
| G9 concurrency | two simultaneous planner invocations on dev (route + script) produce one `ok` and one `skipped` row and no duplicate workflow runs; a legacy run and a planner run persisted out of order on dev leave the newer `asOf` in place; test F passes (two workers, last LLM slot, exactly one call) and on dev `research_budget_days.llm_attempts` never exceeds the cap on any night |

## 11. Decisions (resolved in review round 1) and risks

| # | Decision / risk | Resolution |
|---|---|---|
| **D1** | Signup research and the approved "signup → `seed_only`" row | **Approved: keep signup research byte-for-byte in 2b.** Seed-only signup behaviour is deferred to the identity/reader transition. The planner never plans `seed_only` athletes. |
| **D2** | Monthly full re-enrich | **Approved: no-op on dev only once planner execution is enabled; prod unchanged through 2b.** |
| **D3** | Budget caps and cost model | **Resolved: keep the proposed dev caps as initial guardrails; call caps are the authoritative safety controls until measured token/cost data exist; the USD model is provisional.** (§5) |
| **D4** | Grounded Gemini call | **Approved: duplicate into the adapter temporarily; `researchAthlete.ts` untouched.** |
| **D5** | Season-boundary, GDELT-spike and assertion-change triggers | **Approved: deferred.** Policy keys reserved, no code. |
| **D6** | Handles freshness | **Revised: explicit `social_handles` family, 365 d initial TTL**, in `research_freshness v0.2-alpha`; no semantic mapping to identity. |
| **D7** | Merged multi-domain run rows | **Approved: one `research_runs` row per merged execution, with domain-level outcomes and call counts in `summary`.** |
| **D8** | Athlete-facing synchronous route | **Approved: unchanged in 2b.** |
| **D9** | Scheduling mechanism | **Revised: Cloud Scheduler → internal authenticated route + advisory lock is the target nightly mechanism.** No in-process Cloud Run cron for the planner; the script and the route share the lock. |
| R1 | Narrow domain queries may ground less than the broad legacy queries, lowering the cited share and raising the `no_relevant` rate. | Queries are the legacy ones verbatim; the build record reports cited share and outcome mix per domain; tuning is a policy/prompt change, not a schema change. |
| R2 | The extractor over-claims `none_found`. | Only trusted with completed queries and reviewed chunk ids; recorded as `confirmed_empty` distinctly so its rate is visible; a domain confirmed empty is still re-planned at its TTL/rescan. |
| R3 | Planner and legacy runs on the same athlete interleave. | Monotonic freshness by `asOf`, row lock in persist, authority-based resolution and dedupe; the paths converge in 2d/Step 3. |
| R4 | A cost model that is wrong in the cheap direction. | Call caps are enforced from counted attempts and are independent of the model; the USD cap is a second line. |
| R5 | The ledger scan grows with `research_runs`. | Index on `started_at`; one budget day per scan; ≤ hundreds of rows per night at the dev roster. |
| R6 | An abandoned `running` run row (crash before close) blocks or distorts the ledger. | Its reservations are real spend and stay counted on the day row; the retry or the next planner pass closes rows `running` past their lease as `failed (abandoned)`. |
| R7 | A reservation succeeds but the process dies before the provider call. | The slot is consumed (conservative: the cap can under-spend by the number of such crashes, never over-spend). |
| R8 | The intermediate flag state `refresh=true / substrate=false` is deployed by mistake. | Inert by construction (one gate, §4.1); test H and G4 prove it. |
