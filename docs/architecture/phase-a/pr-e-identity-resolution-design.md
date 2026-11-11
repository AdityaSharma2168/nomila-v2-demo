# PR E design note: research_refresh v3, the Q1 identity gate, `identity_resolution`, the research status contract

**Status: DESIGN APPROVED (1 Oct 2026) — implementation follows E1 → E2a → E2b, then E3/H per dependencies; migrations
0080 and 0081 stay separate files.** Decisions: §9.

Design only. No code, migration file, commit, provider call or DB write accompanies this note.
Base: `origin/main` 8c4a1b0b (includes #700, #710, #711, #712, #715, #716). Read in the clean worktree `nomila-v2-archinv`.
"Arch" = `docs/architecture/phase-a/research-acquisition-architecture.md`.

## In plain words first

**What changes for an athlete.** Nothing yet: every flag stays off. Once dev turns the direct binding on, a new
athlete's research starts as soon as her account exists. The first query asks one question: which public person
does this name, sport and team describe? Only when that answer is clear does Nomila research her achievements,
press, brands, socials and recent news. Each answer is saved as it arrives, rather than all at the end.
- If the web shows several people with her name and Nomila cannot tell which one is her, it stops there and does
  not spend more. It waits for something new, such as her confirming which person is her, or a changed name or team.
- If the web shows nobody who matches, it records that and does not invent anyone.

**What happens underneath.**
- `athlete_research_state` gets one new athlete-level field, `identity_resolution`, plus one small provenance
  field. All existing rows stay NULL, which means "no determination recorded".
- `research_refresh` gets a v3 definition: one runner step per research-spec/1 query (Q1–Q6), each persisting its
  own results. Q1 is the gate.
- A read function returns two independent axes: per-domain research status, and athlete identity resolution.
- Everything sits behind one predicate. The PR H identity invariant reuses that same predicate.

**Five findings from reading the code change what the arch doc assumed.** They are explained where they apply.
1. The existing `identity_confidence` / `identity_resolved_at` and `research_status='identity_resolved'` are
   **account-ownership signals, not public identity.** They are written from claimed/auth/self-membership/active
   connection:
   - `refresh.ts:57-63`, `:159-163`
   - `directResearch.ts:176-179`
   - `identity/state.ts:56`, `:61`
   - `planner.ts:75`
   - `backfillResearchSubstrate.ts:79` (writes 0.5 for unclaimed rows)

   They are overwritten on every persist (`persist.ts:350`). They therefore cannot carry the new axis (§4).
2. `research_runs` allows **one** successful row per workflow run (`schema.ts:1295`, `0047:62-63`). Per-query
   persist under one workflow run collides on the second query. So arch (i)'s "no schema change" does not hold (§5.2).
3. Persist drops claims whose domain is outside the plan (`persist.ts:165`, `:180`). One query lands evidence in
   several domains (Q1 → identity, affiliations, profile), so per-query persist needs an *acceptance* set separate
   from the *settle* set (§3, §5.2).
4. The deploy workflows no longer hold DDL: `deploy-dev.yml` / `deploy-prod.yml` contain 0 `CHECK`s.
   `scripts/db-migrate.sh` (step 3, `:134-188`) is the only schema path. The hand-kept CHECK hazard now lives in the
   migration files themselves: every file re-runs on every deploy, which is the CHECK OWNERSHIP RULE in
   `0063_objectives.sql:88-93`. `athlete_research_state` is not in `migrations/legacy/`.
5. The `signals` domain has no research-spec/1 query (`plans.ts:107`, `SPEC_V1_DOMAIN_QUERIES.signals = []`), so
   the direct stage alone would leave it with no producer. **Decided (D13): v3 carries v2's existing Trends/GDELT
   signals lane** (`refresh.ts:133-143`) unchanged, as its own step after the identity gate (§5.1, §5.3).

---

## 1. State-transition semantics for `identity_resolution`

### 1.1 Meanings (the column is a pure identity record)

| Value | Meaning | Not |
|---|---|---|
| `NULL` | **Historical: no determination has ever been recorded** for this athlete. All existing rows. Seeded/calibration athletes stay here: they are outside governed identity state unless a particular record is later deliberately promoted for a different purpose. | NOT pending. Not "unresolved and queued". Nothing is owed. |
| `pending` | The athlete has entered governed identity resolution (a lifecycle event or a deliberate operator act), and **no determination is in force**. | Not "Q1 is queued/running". Queued, running and attempts live in `workflow_runs`/`workflow_steps`/`research_runs`. |
| `resolved` | The public person the research concerns is anchored, by a Q1 result (§2) or by athlete confirmation on top of Q1 evidence. | Never from account ownership, OAuth or existing research/facts. |
| `ambiguous` | A completed determination found an anchor conflict, or namesakes it could not separate. | Not a retry state. |
| `failed` | A completed determination found **no public person matching the anchor** (approved meaning; D2). | Not "the call failed": operational failures record nothing here (§1.4). |

**Workflow facts never enter the column or its provenance field:** attempt counts, next-retry time, queued/running,
lease and budget refusals. They stay in:
- `workflow_steps` (status/attempt);
- `research_runs` (status/error);
- `athlete_research_state.refresh_failures.identity` (back-off, `persist.ts:334-345`);
- `pending` (queued requests).

### 1.2 Transition table

`anchor` = the identity anchor used by Q1: name + sport + current said/proof/primary affiliation + known handles,
as built by `searchInputsFor` (`context/searchInputs.ts`). `anchorHash` is its hash, recorded in provenance so a
re-entry can tell whether the inputs changed.

| # | From → to | Caused by (code path) | Preconditions | Recorded alongside |
|---|---|---|---|---|
| T1 | NULL → pending | (a) **lifecycle start**, a new `startLifecycleResearch()` called from the signup sites (`auth.ts:139` created branch, `:255` legacy branch, `:125` claim-link branch); (b) **admin "resolve identity"** (deliberate; this is how Mia and the wanted testers are entered. Seeded/calibration athletes are not entered: they stay NULL, outside governed identity state, unless a particular record is later deliberately promoted for a different purpose) | `identityResolutionEnabled()` (§5.7); athlete row exists; lifecycle: the request just created/linked the self-membership. **Never** a planner/backfill/calibration path, and never inferred from rows. | `detail = {at, trigger: signup\|claim\|admin, by, anchorHash}`; confidence null |
| T2 | pending → resolved | **v3 Q1 step** (classifier §2) | Q1 completed + classifier = resolved; compare-and-set on `pending`; anchorHash of the Q1 request = current anchorHash | `detail = {at, basis: "q1", researchRunId, workflowRunId, queryId: "Q1", anchorMatch, confidence, namesakes: n, namesakeEvidenceIds[], anchorHash}` |
| T3 | pending → ambiguous | v3 Q1 step | classifier = ambiguous; CAS on `pending` | as T2, plus `reason` (`uncertain` / `namesakes_unseparated` / `namesakes_uncorroborated` (T-e) / `conflicts_athlete_statement`) |
| T4 | pending → failed | v3 Q1 step | classifier = failed (`not_resolved`, zero namesakes); CAS | as T2, plus `reason: "no_public_match"` |
| T5 | pending → pending (no write) | v3 Q1 step, operational failure | Q1 did not complete (timeout, provider error, budget refusal, unparseable, degenerate, `anchorMatch` null) | **nothing in the column.** `research_runs` row failed; identity/affiliations/profile outcome `failed` → `refresh_failures` back-off |
| T6 | ambiguous → resolved | **athlete confirmation service** (new function; its UI is a Concept 0.4/Mila handoff) | She confirms one Q1 candidate/evidence set as herself, or a verified proof affiliation separates the namesakes (§2.3); CAS on `ambiguous` | `detail = {at, basis: "athlete_confirmed", assertedId, evidenceIds[], q1ResearchRunId, by: selfMemberUserId}` (the statement itself is an `athlete_asserted` row; see §2.3) |
| T7 | ambiguous \| failed → pending | (a) **anchor change**: name/sport edit, a new said/proof affiliation, a new known handle (anchorHash differs); (b) **identity TTL** due (365 d, `policy.ts:82`), via the planner; (c) admin re-resolve | CAS on the from-value | `detail = {at, trigger: anchor_changed\|ttl\|admin, anchorHash, previous: {value, at, basis, reason}}` |
| T8 | resolved → ambiguous | athlete rejection ("that is not me") via the confirmation service | CAS on `resolved` | `basis: "athlete_rejected"`, assertedId, `previous` |
| T9 | resolved → pending | anchor change of **name or sport** | CAS | `trigger: anchor_changed`, `previous` |
| T10 | resolved → resolved (refresh provenance) | identity-TTL Q1 re-run that classifies resolved | basis was `q1` | provenance updated to the new run; an `athlete_confirmed` basis is kept |
| — | resolved, then a TTL re-run is *not* resolved | no transition (D7) | — | recorded in the run's summary only; becomes a review signal |
| — | any → NULL | **never** | — | — |

**Provenance is "current plus one".** Only the in-force determination and its immediate predecessor (`previous`) sit
in the row. The full history is already preserved elsewhere:
- every Q1 `research_runs` row with its identity block (`summary.identity`, §5.2);
- `workflow_steps.output`;
- the `athlete_asserted` rows, which have supersede/retract (`schema.ts:2585-2603`).

This follows the standing rule "preserve what happened and why" without adding a table.

**Concurrency.** Every write is `UPDATE … SET identity_resolution=$to, identity_resolution_detail=$d WHERE
athlete_id=$a AND identity_resolution IS NOT DISTINCT FROM $from`. A late Q1 result therefore never overwrites an
athlete's confirmation. A lost CAS is recorded in the step output and is not an error.

### 1.3 Diagram

```
                 lifecycle start / admin (T1)
   NULL ────────────────────────────────────────▶ pending ◀──────────────────────┐
 (historical,                                      │   ▲  ▲                       │
  no determination;                Q1 op. failure  │   │  │ anchor change / TTL /  │
  never written back)              (T5: no write)──┘   │  │ admin (T7)             │
                                                       │  │                        │
                        Q1 classifier (T2/T3/T4)       │  │                        │
              ┌───────────────┬────────────────────────┘  │                        │
              ▼               ▼                           │                        │
          resolved        ambiguous ──────────────────────┤                        │
           │  ▲  ▲            │  ▲                         │                        │
           │  │  └──── athlete confirms (T6)              │                        │
           │  │               │  │                        │                        │
           │  │               │  └── athlete rejects (T8) ┘ (from resolved)        │
           │  └── TTL re-run resolved (T10)                                        │
           └──────────── name/sport change (T9) ───────────────────────────────────┘
                      failed ──── anchor change / TTL / admin (T7) ──▶ pending
```

### 1.4 Retries (approved, per state)

- **Operational failure (column stays `pending`).** The runner retries the step (`retry.maxAttempts 2`). Inside
  each attempt `geminiDirect` makes 1 + `geminiRetryMax` (2) calls, with a 60 s per-call timeout
  (`policy.ts:60-71`). After that the failure is recorded in `refresh_failures.identity`, and the planner re-plans
  Q1 on a later night. After `maxConsecutiveFailures` 3 it defers by `failureDeferDays` 7 (`policy.ts:71`). These
  are the existing values; there is no new back-off machinery and no total maximum.
- **ambiguous.** No automatic re-run with an unchanged anchor: same inputs give the same answer, and each attempt
  costs about $0.07 (provisional). Re-entry (T7) happens only on an anchor change, an athlete confirmation (T6,
  which resolves directly), the identity TTL, or admin action.
- **failed** (no public match). Same rule: re-entry on an anchor change, the identity TTL or admin action. No earlier re-check (D6).
  Whether new accounts deserve one, because a young athlete's footprint grows, is still open (§9); no data supports a
  number today.
- **resolved.** Sticky against automation (**D7**): an automated re-run that does not match is recorded as a review
  signal and changes nothing. It reverts only by athlete rejection (T8) or a name/sport change (T9).
  - **Known limitation.** Q2–Q6 facts persisted under a later-rejected identity are *not* cleaned up by E. They
    carry `runId` lineage, so a later cleanup can find them. This is the "zero new namesake contaminations" input to
    gate G1.

### 1.5 What belongs to the runner, not the column

| Concern | Lives in |
|---|---|
| Q1 queued / running | `workflow_runs` + `workflow_steps` of the active v3 run; `pending` |
| Attempts, lease, step retry | `workflow_steps` (`types.ts:17-21`, `runner.ts:373-385`) |
| Provider failure, timeout, budget refusal | `research_runs.status/error`, ledger |
| Back-off, deferral | `athlete_research_state.refresh_failures.identity` |
| Identity-domain *research* outcome (Axis 1) | `domains.identity.outcome` (Q1 persists it like any domain) |
| Who the research concerns (Axis 2) | **`identity_resolution` + `identity_resolution_detail` only** |

Q1's persisted identity-domain outcome (`refreshed`, `failed`, …) and the identity *determination* are two separate
writes. Neither is derived from the other (arch :870-877).

---

## 2. What counts as resolved, ambiguous or failed

### 2.1 Signals the code already computes

- **Per-query identity block.** `anchor_match ∈ matched | uncertain | not_resolved`, `confidence` (number),
  `namesakes[]`.
  - Contract: `directEvidenceV2.ts:102`. Parse: `:156`, `:186`.
  - Recorded per query: `directResearch.ts:142-143`, into `extraction.raw.identityByQuery` (`:169`).
  - The provider is already told that a confidence-less match means not_resolved, with no findings (`:111`, `:113`).
- **Namesake evidence.** S1 item `namesakes` (`researchSpecV1.ts:52`) maps to an `identity_signal` evidence row with
  `topic: "namesake"` (`itemMapping.ts:66`).
- **Completion.** `completed` = parsed v2 with no parse error and the hybrid marker found (`geminiDirect.ts:120`).
- **Degenerate answers.** `directDegenerateV2` (`directEvidenceV2.ts:191-200`): malformed, no item reported,
  template echo, or "matched but zero findings with sources retrieved". **Today only the benchmark uses it**
  (`providerBenchmark.ts:132`). E applies it to Q1.
- **Accepted lineage.** `native_supported` / `native_retrieved` (`directResearch.ts:38-39`).
- **Conflict with the athlete's own statements.** Persist runs the resolver against `assertionsFor` and
  `hasAssertedAffiliations` (`directResearch.ts:179`). A contrary finding on a blocking key leaves
  `blockingDispute` on the identity/affiliations domains (`persist.ts:347`, `registries.ts:55`).

**There is no measured distribution of `confidence` in the repo.** No doc or report holds dev37
`identityByQuery` values. Any numeric floor would therefore be invented (D3).

### 2.2 Classifier (thresholds T-a … T-e APPROVED; T-e as tightened)

Q1 is evaluated after it persists, from its own result only:

| Result | Rule |
|---|---|
| **no determination** (T5) | Q1 not `completed`, **or** `directDegenerateV2(...).degenerate`, **or** `anchorMatch == null` (T-a) |
| **resolved** | `anchorMatch == "matched"` **and** ≥ 1 accepted (native-lineage) S1/S2 finding (T-b) **and** no `blockingDispute` raised on identity/affiliations by this run against an `athlete_asserted`/`athlete_proof` value (T-c). `confidence` is recorded, **not thresholded** in v0 (T-d). **And**, when Q1 reports ≥ 1 namesake, the anchor is corroborated beyond name/sport (T-e). |
| **ambiguous** | `anchorMatch == "uncertain"`; **or** `not_resolved` with ≥ 1 namesake; **or** `matched` but T-c fails (it conflicts with what she said); **or** `matched` with ≥ 1 namesake and no corroborated discriminator (T-e) |
| **failed** | `anchorMatch == "not_resolved"` and zero namesakes: no public person matched the anchor |

The thresholds (APPROVED 1 Oct 2026):
- **T-a.** Degenerate or unparseable counts as no determination, not failed.
- **T-b.** "Matched" needs at least one accepted S1/S2 finding.
- **T-c.** A matched result that conflicts with her own said/proof affiliation is ambiguous.
- **T-d.** No numeric confidence floor in v0. Optionally, set one after a read-only pass over dev37
  `identityByQuery` (D3).
- **T-e (tightened).** If Q1 reports one or more namesakes, `matched` may become `resolved` only when accepted
  native-lineage evidence corroborates at least one supplied discriminator beyond name/sport — a current
  team/affiliation or known handle. Otherwise the result is `ambiguous`.
  - **Why.** It guards against an observed failure: the model picks a person even though it has acknowledged
    namesakes. The model's own `matched` is then not enough; a supplied fact the sources independently confirm is.
  - **Deterministic, existing data only, no confidence threshold.** It reads only Q1's accepted findings and their
    source URLs, plus the anchor that was supplied.
  - **How "corroborates" is checked.** Team: an accepted (`native_supported`/`native_retrieved`) S2
    `current_affiliation` finding whose `org`, normalized with the registry's `normalizeText` (`factRegistry.ts:53-55`),
    **equals** the normalized anchor team. Handle: an accepted S1/S2 finding cites a source URL on that platform's host
    (instagram.com, tiktok.com, x.com/twitter.com, youtube.com) whose first path segment, normalized with
    `normalizeHandle` (`identity/policy.ts:41-44`), **equals** a known handle. Exact match after normalization only;
    no fuzzy or substring match, so "Stanford" vs "Stanford University" does not corroborate and the result stays
    `ambiguous`, the safe side.
  - The handle discriminator is the handle string the anchor supplied. A connected account adds it to the anchor,
    but only the public source citing it corroborates. Account ownership itself still resolves nothing (§2.3).

### 2.3 Athlete confirmation, said and proof (account ownership is not public identity)

- **Never resolves identity:**
  - a self-membership or claim, `auth_id`/`claimed_at`, or an active OAuth connection (`identity/state.ts:56-61`).
    These prove who owns the *account*, not which public person the web describes (arch R16, :791-794);
  - existing research or facts;
  - the legacy `identity_resolved_at` and `research_status`.
- **An athlete's said affiliation does not resolve identity by itself.** It feeds the anchor and the T-c conflict
  check. Q1 stays necessary for namesake detection (arch :756).
- **Athlete confirmation resolves only from `ambiguous`, and only against Q1 evidence (T6).** She picks or confirms
  the candidate or evidence that is her. Stored as:
  - an `athlete_asserted` row (`field: "public_identity"`, value `{confirms, evidenceIds, q1ResearchRunId}`) — an
    existing table, a free-text field with no CHECK, with supersede/retract;
  - the provenance field, which points at that row.
- **A proof affiliation** (`athlete_proof`, a verified public source) can break a namesake tie in the same way. It
  cannot stand in for Q1 from `pending`.
- **From `failed`,** her statement cannot create a public identity. Her said facts still flow as said facts.
- **Seeded/calibration athletes** never reach T1: there is no lifecycle event for them, and admin resolution is for
  Mia and the wanted testers, not for them. They stay NULL, outside governed identity state, unless a particular
  record is later deliberately promoted for a different purpose. The Q5 filter (§5.5) has no connected platforms to
  defer to for them.

---

## 3. Q1 / profile–affiliations: the companion rule (#715 flag)

**Today.** `mergePlan` always plans `profile` and `affiliations` together (`plans.ts:66-69`), and `profile` is not
independently plannable (`registries.ts:108-109`). In the research-spec/1 table, affiliations → Q1, and
profile → Q1 + Q6 (`plans.ts:102-119`). `specV1QueriesFor` deliberately has no companion (`plans.ts:132-140`). Both
share the `affiliations` freshness family, TTL 180 d (`registries.ts:100`, `policy.ts:82`).

| Option | Cost | Freshness | Coverage |
|---|---|---|---|
| **A. Keep the companion** (affiliations due → Q1 + Q6) | +1 query (Q6, ≈ $0.07 provisional) on every event-driven affiliations/identity refresh | profile always settles with affiliations | Q6 (career status, recent developments) is refreshed every time |
| **B. Drop the companion; make `profile` plannable** (affiliations due → Q1; profile due → Q1 + Q6) | saves Q6 on event-driven refreshes, e.g. a connect, a told-us team or an identity re-entry. No steady-state difference: both expire together under one family, and the lifecycle run executes all six | profile settles **only when all its covering queries completed in the run**. After a Q1-only run, profile honestly stays as it was (it may show stale) | Q1's profile-attribute findings (hometown, position, class year) are still **accepted**, via the acceptance set; only the profile *freshness* waits for Q6 |
| C. Drop the companion and let Q1 alone settle profile | cheapest | profile marked fresh without Q6's S3 career status: **hides staleness** | rejected |

**Approved: B (D11).** It needs two rules in E2:
- **acceptance set** = every domain the executed query covers. This stops `persist.ts:180` from dropping Q1's
  profile evidence.
- **settle set** = the domains whose covering queries in *this run* have all completed. Only those get an outcome,
  which drives freshness and `refresh_failures` (`outcomes.ts:5-13`).

`profile` joins `PLANNABLE_DOMAINS` **for the direct binding only**. v2's `mergePlan` stays byte-identical.

---

## 4. Migration SQL (shown, not committed)

### 4.1 Provenance: options

| Option | Columns | Problem |
|---|---|---|
| P1. Reuse `identity_confidence` / `identity_resolved_at` | +1 (`identity_resolution`) | Both already hold account-signal values (finding 1). `persist.ts:350` and `planner.ts:177`/`:182` overwrite them on every persist or plan. Keeping them would need rewriting three writers and reinterpreting existing non-null rows, against "existing rows stay as they are" and "no inferred resolution". |
| **P2. `identity_resolution` + `identity_resolution_detail jsonb`** | +2 | none. The legacy columns are left untouched and documented as *account-signal, legacy*; the status contract never reads them as identity. |
| P3. Column only; provenance looked up from the Q1 `research_runs` row | +1 | athlete confirmation and anchor-change re-entry have no run to point at |

**Approved: P2** (D1). This is the minimum honest set.

### 4.2 `migrations/0080_identity_resolution.sql`

Numbering:
- 0079 is the latest on main.
- 0078 is taken by `origin/feat/slice2-startx1` (`0078_counterparty_research.sql`, unmerged; noted in
  `0079_objective_change_assessed.sql:14`).
- So the next free number is 0080. Re-check at PR time.

```sql
-- 0080_identity_resolution.sql — athlete-level identity resolution (research-acquisition arch §9.4 (ii); PR E1).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- WHAT THIS CHANGES: two nullable columns on athlete_research_state. No default, no UPDATE, no backfill:
-- every existing row stays NULL = "no determination recorded" (historical; NOT pending).
-- identity_confidence / identity_resolved_at are NOT touched: they carry the legacy ACCOUNT signal.
-- OWNER of athlete_research_state_identity_resolution_check and ..._identity_detail_check (CHECK OWNERSHIP RULE, 0063).

ALTER TABLE athlete_research_state ADD COLUMN IF NOT EXISTS identity_resolution text;
ALTER TABLE athlete_research_state ADD COLUMN IF NOT EXISTS identity_resolution_detail jsonb;

ALTER TABLE athlete_research_state DROP CONSTRAINT IF EXISTS athlete_research_state_identity_resolution_check;
ALTER TABLE athlete_research_state ADD CONSTRAINT athlete_research_state_identity_resolution_check
  CHECK (identity_resolution IS NULL OR identity_resolution IN ('pending','resolved','ambiguous','failed'));

-- A determination never exists without its provenance, and provenance never exists without a determination.
ALTER TABLE athlete_research_state DROP CONSTRAINT IF EXISTS athlete_research_state_identity_detail_check;
ALTER TABLE athlete_research_state ADD CONSTRAINT athlete_research_state_identity_detail_check
  CHECK ((identity_resolution IS NULL) = (identity_resolution_detail IS NULL));
```

The `shared/schema.ts` mirror goes in `athleteResearchState` (`schema.ts:1393-1411`):
- `identity_resolution: text("identity_resolution")`;
- `identity_resolution_detail: jsonb("identity_resolution_detail")`;
- two `check(...)` entries with the **same value list** as the SQL.

Add `IDENTITY_RESOLUTIONS = ["pending","resolved","ambiguous","failed"] as const` to `registries.ts` as the single
TypeScript source. A unit test asserts that the CHECK text in the SQL file equals that list, so any hand-kept list
that drifts fails CI.

### 4.3 `migrations/0081_research_runs_query_id.sql` (E2, separate file)

Needed for per-query persist (finding 2; D10):

```sql
-- 0081_research_runs_query_id.sql — one successful research run per (workflow run, research-spec/1 query) (PR E2).
ALTER TABLE research_runs ADD COLUMN IF NOT EXISTS query_id text;
ALTER TABLE research_runs DROP CONSTRAINT IF EXISTS research_runs_query_id_check;
ALTER TABLE research_runs ADD CONSTRAINT research_runs_query_id_check
  CHECK (query_id IS NULL OR query_id IN ('Q1','Q2','Q3','Q4','Q5','Q6'));
-- Same index NAME, wider key: 0047 re-runs every deploy with CREATE ... IF NOT EXISTS, which then is a no-op.
-- Replaced only when the live definition is still the 0047 one (no rebuild on every deploy).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'research_runs_workflow_success' AND indexdef LIKE '%query_id%') THEN
    DROP INDEX IF EXISTS research_runs_workflow_success;
    CREATE UNIQUE INDEX research_runs_workflow_success ON research_runs (workflow_run_id, COALESCE(query_id, ''))
      WHERE workflow_run_id IS NOT NULL AND status IN ('ok','partial');
  END IF;
END $$;
```

Legacy and v2 rows have `query_id` NULL and keep exactly today's one-per-workflow-run rule. In a v3 run, the
signals step's row (D13) is the run's single `query_id` NULL row. `research_runs.domain`
for a per-query row is `refresh`; the covered domains go in `summary.plan` (as v2 does, `refresh.ts:110`). The
`trigger` for the lifecycle run is the existing `signup` (`schema.ts:1289`). Neither change needs a migration.

### 4.4 Dry-run plan (the migration rule)

1. **Static check.** The files have no `BEGIN`/`COMMIT`, no `CONCURRENTLY` and no `ALTER TYPE … ADD VALUE`, so
   `server/migrationsGuard.test.ts` passes without an allow-list entry. 0081's `DO` block is transactional.
2. **One file at a time, dev first, through the proxy.** Use `./cloud-sql-proxy.exe --port 5440`, with
   `psql -v ON_ERROR_STOP=1`:
   ```
   BEGIN;
   \i migrations/0080_identity_resolution.sql
   \d athlete_research_state
   SELECT count(*) FILTER (WHERE identity_resolution IS NOT NULL), count(*) FROM athlete_research_state;   -- expect 0, N
   ROLLBACK;
   ```
   Run it twice in one transaction to prove the re-run is idempotent, then roll back. Do the same for 0081 on its
   own, never in the same transaction as 0080. Check `\d research_runs` for the existing partial index and the
   duplicate-run state: `SELECT workflow_run_id, count(*) … status IN ('ok','partial') GROUP BY 1 HAVING count(*)>1`
   should return 0 rows.
3. **One commit per file:** the SQL, the `db-migrate.sh` list line and `schema.ts`. After the merge, **watch
   deploy-dev to green**, including the step-5 drift gate.
4. **Prod** only at rollout step 5, with explicit approval naming the exact command. Never chain files inside an
   outer transaction (11 Sep incident).

---

## 5. Step structure for research_refresh v3

### 5.1 The definition

- `RESEARCH_REFRESH_V3 = defineWorkflow({ process: "research_refresh", version: 3, steps: [q1 … q6, signals] }, { optIn: true })`.
  - Opt-in (`registry.ts:45-62`), so callers that omit the version keep getting v2.
  - The planner pins its version by binding: `direct` → 3, otherwise 2 (`planner.ts:224` pins 2 today).
  - Admin keeps v1 until it is rerouted (E2b).
- Steps are **static and sequential**, kind `model`, `leaseMs: 5 min`, `retry: { maxAttempts: 2 }`.
  - The runner opens steps lazily, one ordinal at a time (`runner.ts:213-231`).
  - There is no conditional branching. A step that must not run therefore **completes with an output**
    `{ skipped: "not_planned" | "identity_gate" }`. It never cancels the run (`cancelRun` means operator cancel,
    `runner.ts:491-497`).
  - Running Q2–Q6 in parallel is possible (`parallel`, `types.ts:69-73`) but deferred (D16): the ledger ordering and
    the rule that one failing sibling fails the run argue for sequential steps in v0.
- **What a step is.** A step is one research-spec/1 query, its persist, and (Q1 only) the identity classification
  and transition. Run input (references only):
  `{ queries: QueryId[], signals: boolean, domains, trigger, reason, governIdentity: boolean, plannerRunId? }`.
- **The signals step (D13, approved).** A seventh step, `signals` (kind `code`, no LLM), runs **last, after the
  gate**. It carries v2's Trends/GDELT lane **unchanged**:
  - the same providers (`skills/researchRefresh.ts:21-22`);
  - the same non-LLM lane accounting (`recordNonLlmCall(runId, "signals")`, `refresh.ts:138-139`);
  - the same completion rule (both fetches returned, `refresh.ts:142`, `:152`);
  - the same `signals` domain outcome and TTL (30 d, `policy.ts:82`).

  It plans when `signals` is due, as `mergePlan` decides today (`plans.ts:76`). It persists its own `research_runs`
  row (`domain 'signals'`, `query_id` NULL). It is subordinate to the identity gate exactly like Q2–Q6: Trends and
  GDELT are fetched by name, so a namesake would contaminate them. Nothing about the signals themselves is
  redesigned.
- **Lease fit.** The worst case for one query is 3 attempts × 60 s + ≈ 4 s back-off ≈ 184 s, under the 5-min lease
  (`policy.ts:60-66`).
  - A lease lapse re-claims the step. Reuse is keyed on `(workflow_run_id, query_id)`: an ok/partial row is
    returned, and a still-`running` row is closed failed. This is the `directResearch.ts:101-106` pattern, per query.
  - Caveat (approved with #711): a client abort does not mean the provider did not bill.
- **Provider trouble never throws.** It is carried by the outcome vocabulary, as `refresh.ts:13` does. A Q2 failure
  therefore does not fail Q3–Q6. Programming errors throw, and the runner retries them.
- **Budget.** `reserveLlmCall` caps per `research_runs` row (`ledger.ts:39-48`). With one row per query, the
  per-run cap becomes per query, and the nightly cap is the real bound. A workflow-level cap is **PR F** (D17).

### 5.2 Per-step body (adaptation 3)

```
step qN(ctx):
  if qN ∉ runInput.queries                      → return { skipped: "not_planned" }
  if qN ≠ Q1 and runInput.governIdentity and identity_resolution ≠ 'resolved'   (column read fresh, every step)
                                                → re-queue qN's domains in `pending` (reason "identity_gate"); no row, no call
                                                → return { skipped: "identity_gate", identity: <value> }
  reuse (workflow_run_id, query_id=qN)          → if ok/partial: return its summary (and, for Q1, re-apply the
                                                  idempotent transition from summary.identity)
  open research_runs row (domain 'refresh', query_id qN, trigger) BEFORE the call
  call injected provider (geminiDirect via skills binding) for qN only; Q5 post-filter (§5.5)
  persistResearchRun({ runId, plan: { acceptance: domainsOf(qN), settle: domains whose covering queries in this
                       run have all completed, queryStatus }, summaryExtra: { queryId, identity: parsedV2.identity } })
  if qN == Q1 and runInput.governIdentity: classify (§2.2) → applyIdentityTransition (CAS from 'pending')
  return { research_run_id, status, outcomes, identity? }

step signals(ctx):                               (after q6; same not_planned / identity_gate checks as Q2–Q6)
  reuse (workflow_run_id, query_id IS NULL, domain 'signals')
  open research_runs row (domain 'signals'); trends + gdelt exactly as refresh.ts:133-143
  persistResearchRun({ runId, search: [], extraction: null, signals, plan: { acceptance: ["signals"],
                       settle: ["signals"], queryStatus: { signals: { completed: t && g, chunksReviewed: n } } } })
```

`persistResearchRun` gains exactly two things:
- the acceptance/settle split, defaulting to today's behaviour when absent (§3);
- a pass-through of `query_id` and the Q1 identity block into `research_runs`.

`identityResolved`/`identityConfidence` keep their legacy account meaning (D1) and are never fed from Q1.

### 5.3 Q1 first as the gate

| Q1 yields | Q2–Q6 and the signals step in this run | Recorded |
|---|---|---|
| resolved (T2) | run, each persisting | transition T2 |
| ambiguous (T3) / failed (T4) | each step completes as `skipped: identity_gate`. No `research_runs` row, no provider call, no outcome; freshness and failure counts untouched. Its domains are re-queued in `pending` (reason `identity_gate`) | transition; step outputs |
| no determination (T5) | as above (the gate reads `pending`) | Q1 run failed; `refresh_failures.identity` |

The re-queue is the "deferral and coalescing" that arch :130-131 leaves to implementation. While identity is not
resolved, the planner (E2b) never admits identity-dependent `pending` entries; it admits only the `identity` domain
(Q1) when T7 conditions hold. Once T2/T6 lands, the next planner pass runs the held domains once. **NULL rows are
never planned by the v3 planner**; they enter only through T1.

**Calibration (D9).** The CLI runs the same stage with `governIdentity: false`:
- the cohort allow-list, the `ensureAthleteRow` behaviour and the claimed skip are kept (`runDirectResearch.ts:28-31`, `:48-49`);
- **no identity write**: calibration athletes stay NULL, outside governed identity state (§1.1);
- the gate is **observed, not enforced**: the step output records `wouldGate: true` and Q2–Q6 still run, so gate
  G5's false-stop rate can be measured.

Recorded limitation, not redesigned here: the calibration script matches athletes by name+sport.

### 5.4 Lifecycle trigger (adaptation 5)

- **Where.** A new `startLifecycleResearch(athleteId, trigger)` in `server/services/intelligence/research/lifecycle.ts`.
  It does T1, then `startRun({ process: "research_refresh", version: 3, input: {queries: Q1..Q6, governIdentity: true, trigger: "signup"}, idempotencyKey: research_refresh:<athlete>:<UTC day> })`.
  This is the same key as the planner (`planner.ts:224`), and `startRun` returns an existing run rather than
  creating a second one (`runner.ts:251-274`). One active run per athlete comes from the default `activeScope`
  (`0034` partial unique index).
- **Called from** `auth.ts` next to the onboarding `startRun` sites (`:139`, `:255`) and the claim-link branch
  (`:125`), not awaited and never fatal, exactly like those sites. It is not called from the onboarding workflow:
  research must not encode an onboarding sequence (arch §9.4).
  - The legacy onboarding `research` step (`onboarding.ts:57-70`) keeps running `researchAthlete` during the shadow
    period (rollout step 2). The two coexist.
- **Guard.** No-op unless `identityResolutionEnabled()`.

### 5.5 Q5 narrowing to unconnected platforms

Changing Q5's frozen request text would be a research-spec revision (`researchSpecV1.ts:267`). **Approved
(D12): a deterministic post-filter.**
- Before mapping, drop Q5 findings (S8 handle, follower-count and verification items) for platforms with an
  **active** `connected_accounts` row, read as in `refresh.ts:69`.
- Record `droppedConnected: {platform: n}` in the run summary.
- Skip Q5 entirely when every platform Q5 asks about is connected.

Connected data stays authoritative, as `ORIGIN_RANK` already orders it (`registries.ts:105`). Seeded athletes have
no connections, so nothing is filtered and no platform authority is inferred.

### 5.6 In-flight lifecycle for the status contract (derived, never stored)

For domain `d`, with `Q(d) = SPEC_V1_DOMAIN_QUERIES[d]`, the precedence is running > queued > settled > not_requested:
- `running`: the athlete's active v3 run has a `workflow_steps` row with status `running` for a query in `Q(d)`.
- `queued`: `d` is in `pending` (including `identity_gate` holds), **or** the active v3 run plans a query in `Q(d)`
  whose step is not yet opened or is `ready`.
- `settled`: `domains[d].outcome` is non-null.
- `not_requested`: none of the above.

### 5.7 Flags and one boundary

```ts
// config.ts — THE identity-resolution boundary (PR E and PR H read only this)
export function identityResolutionEnabled(): boolean {
  return researchPlannerExecutionEnabled() && researchRefreshProviderBinding() === "direct";
}
```

- `RESEARCH_REFRESH_PROVIDER=direct` is the switch that makes v3 exist. `skills/researchRefresh.ts:25-31` gains a
  `direct` binding in place of today's fail-closed throw. It still requires the one execution gate.
- With it false:
  - no lifecycle start;
  - no column write: `applyIdentityTransition` refuses before writing;
  - the planner stays on v2;
  - the status contract reports `identity: null`.
- **PR H** enforces the invariant on every identity-dependent M.I.A. trigger behind the **same** predicate, as the
  approved brief requires. With the predicate false, Beta.1 behaviour is unchanged. With it true, evaluation is
  blocked for NULL/pending/ambiguous/failed and allowed for resolved. Q1 itself is never blocked.
- `gcp/cloud-run-{dev,prod}.yaml` stay as they are: `RESEARCH_SUBSTRATE_WRITE=false`, `RESEARCH_REFRESH_ENABLED=false`,
  `RESEARCH_REFRESH_PROVIDER=kimi` (`cloud-run-dev.yaml:252-268`).

### 5.8 Acquisition registry (#716)

The v3 provider stage gets its own entry with owner, purpose, KEEP, §11 `research_refresh` v3 and allowed importers.
- `geminiDirect`'s allowed importers become:
  - `server/skills/researchRefresh.ts` (the direct binding);
  - `providerBenchmark.ts`.
  `directResearch.ts` moves to the stage module, and the provider is injected, keeping
  `services/intelligence` provider-free (`boundary.test.ts`).
- `direct-research-runner` (CONSOLIDATE, `acquisitionRegistry.ts:53-64`) reaches its exit criterion once the
  calibration CLI runs the stage. Delete `runDirectResearch` then, or keep it as a thin loop and update the entry in
  the same PR. The registry test fails on stale entries.
- `attention-signals` (Trends/GDELT, `acquisitionRegistry.ts:177-190`) already allows `server/skills/researchRefresh.ts`.
  The v3 binding lives in that same file, so only the entry's `why` text changes to cover v3. No new importer.
- Add one importer allow-list for `applyIdentityTransition`: the v3 Q1 step, `lifecycle.ts` and the confirmation
  service only. Calibration, backfill and the planner can then never write identity, and CI enforces it.

---

## 6. Research status contract: read shape

**Location:** `server/services/intelligence/research/status.ts`.
- A pure `deriveResearchStatus(state, activeRun, steps, config)`.
- A thin `readResearchStatus(athleteId)`.
- No route and no Concept 0.4 wiring; that is the 2b handoff.

```ts
export const RESEARCH_STATUS_CONTRACT = "research-status/1";

// Axis 1 — per research domain: what happened when the domain was researched
export type DomainLifecycle = "not_requested" | "queued" | "running" | "settled";           // derived (§5.6)
export interface DomainResearchStatus {
  domain: ResearchDomain;
  lifecycle: DomainLifecycle;
  outcome: Exclude<DomainOutcome, "not_planned"> | null;   // existing (outcomes.ts:5-13); null = never settled
  status: DomainStatus;                                     // existing (registries.ts:57)
  lastResearchedAt: string | null; staleAfter: string | null;
  failures: { count: number; deferredUntil: string | null } | null;   // existing refresh_failures
  heldBy: "identity_gate" | null;                           // the pending entry's reason; a cause, not a lifecycle value
  producer: "available" | "unavailable";                    // from configuration, never from a run
}

// Axis 2 — athlete-level: who the research concerns. Read beside Axis 1, never folded into it.
export interface IdentityResolutionStatus {
  value: "pending" | "resolved" | "ambiguous" | "failed" | null;   // null = no determination recorded (NOT pending)
  basis: "q1" | "athlete_confirmed" | "athlete_rejected" | null;
  reason: string | null;                  // e.g. no_public_match, namesakes_unseparated
  confidence: number | null;              // from identity_resolution_detail ONLY (never the legacy column)
  determinedAt: string | null;
  researchRunId: string | null;
}

export interface ResearchStatus {
  contract: typeof RESEARCH_STATUS_CONTRACT;
  athleteId: string; asOf: string;
  identity: IdentityResolutionStatus;
  domains: Record<ResearchDomain, DomainResearchStatus>;
}
```

The contract never reads `research_status`, `identity_confidence` or `identity_resolved_at` as identity.
`heldBy` explains a `queued` domain without making identity a domain value.

---

## 7. PR slicing and order

| PR | Contents | Depends on |
|---|---|---|
| **E1** | 0080 + `schema.ts` + `db-migrate.sh` line; `registries.ts` `IDENTITY_RESOLUTIONS`; `research/identityResolution.ts`: pure transition table, Q1 classifier (§2.2), CAS writer `applyIdentityTransition`, anchor hash; `identityResolutionEnabled()`; writer-importer allow-list test. **No callers.** | — |
| **E2a** | 0081 (its own commit); the v3 provider stage, provider injected; the `direct` binding; `RESEARCH_REFRESH_V3` (opt-in) with q1–q6 steps plus the gated signals step (v2 lane unchanged), per-query reuse/persist, acceptance/settle split, Q1 gate, Q5 post-filter; calibration CLI on the stage (`governIdentity:false`); registry entries | E1 |
| **E2b** | `lifecycle.ts` + `auth.ts` call sites; planner: version by binding, identity-aware admission (NULL never planned, `identity_gate` holds, profile plannable for direct, T7 re-entry by TTL/anchor change); admin "resolve identity" / v3 re-research routing; athlete confirmation service function (T6/T8; no UI) | E2a |
| **E3** | `research/status.ts` contract + tests (read-only) | E1; E2a (step names) |
| **H** | the identity invariant on every identity-dependent M.I.A. trigger (`auth.ts:152-153`, `socialSync.ts:144`, admin, future), behind `identityResolutionEnabled()`; R-a: account-creation evaluation requested on T2/T6 instead of at signup | E1 (predicate + column); the R-a part after E2a |
| F | cost constants (separate; O3) | — |

E3 and H can proceed in parallel with E2b.

---

## 8. Tests (provider-free) and what not to do

**Tests.** Every provider call is injected or mocked: `geminiDirect` is never imported in a test path. Suites run
sequentially with `npm test --`, never bare `npx jest`.
- E1:
  - the exhaustive transition table: every from × event, allowed or refused;
  - T-e: matched + namesakes resolves only with an exact normalized team or handle corroboration; a near-miss
    ("Stanford" vs "Stanford University") or an uncited handle stays `ambiguous`;
  - the classifier over `ParsedDirectV2` fixtures: matched / uncertain / not_resolved ± namesakes; degenerate;
    null; matched + blocking dispute; matched with zero accepted findings;
  - CAS: a late Q1 never overwrites an athlete confirmation (PGlite);
  - flag off → zero column writes;
  - SQL CHECK list = `IDENTITY_RESOLUTIONS`;
  - `migrationsGuard` passes.
- **NULL guarantees:**
  - a row with research, facts, `identity_resolved_at` set or `research_status='identity_resolved'`, plus a claimed
    account and an active connection, still reads `identity: null` and is never planned;
  - the calibration CLI and `persistResearchRun` never write the column.
- E2a, with a fake provider:
  - Q1 resolved → Q2–Q6 each persist one `research_runs` row with `query_id`;
  - Q1 ambiguous/failed/no-determination → Q2–Q6 complete `skipped: identity_gate` with **zero** provider calls and
    zero rows, and their domains are in `pending`;
  - step retry reuses `(workflow_run_id, query_id)`;
  - an abandoned row is closed;
  - a timeout is counted and the run continues;
  - profile is accepted from Q1 but settles only after Q6;
  - the Q5 post-filter drops connected-platform findings;
  - the signals step runs only after the gate passes (zero Trends/GDELT calls when it does not) and produces the
    same `signals` outcome and lane counters as v2 for the same fake fetches;
  - v2/kimi behaviour is byte-identical (extend `flagDecoupling.test.ts`, `researchRefreshV2.test.ts`);
  - the registry test is updated.
- E2b:
  - lifecycle start is a no-op with the flag off;
  - same-day idempotency with the planner;
  - T7 by anchor change/TTL;
  - the planner never admits held domains until resolved.
- E3: the §5.6 precedence; `null ≠ pending`; `heldBy`; `producer` from configuration.

**Do not:**
- backfill, UPDATE or default existing rows;
- derive identity from `identity_resolved_at`, `identity_confidence`, `research_status`, `hasIdentitySignal`,
  claimed/auth/self-membership, OAuth connections or existing research/facts;
- store identity in `domains.identity` or in `research_status`;
- put queued/running/attempts/next-retry in the column or its provenance field;
- add a tester/real-user flag or persistence, or lean on the planner's existing `realUser` priority heuristic
  (`planner.ts:159`) for any identity rule;
- change the research-spec/1 query text;
- flip any yaml flag or touch prod;
- chain migration files in one transaction, or put two migrations in one commit;
- wire Concept 0.4;
- give calibration or seeded athletes identity writes or connected-platform authority;
- call a provider in a test.

---

## 9. Decisions (APPROVED 1 Oct 2026)

All decisions below are approved. D1–D3, D5–D12 and D14–D18 are approved as proposed. D4 is approved as tightened
(T-e). D13 is approved: the signals lane is carried into v3. Thresholds T-a … T-e (§2.2) are approved, with T-e as
tightened.

| # | Decision | Approved |
|---|---|---|
| D1 | Provenance storage | new `identity_resolution_detail jsonb` (P2). The legacy `identity_confidence` / `identity_resolved_at` are untouched: they are account signals and are overwritten by `persist.ts:350` |
| D2 | Meaning of `failed` | "a completed Q1 found no public match". Operational failures leave `pending`, with the workflow carrying them. This refines arch :910's "could not complete" |
| D3 | Numeric confidence floor for `resolved` | none in v0 (T-d); confidence is recorded |
| D4 | Namesakes reported with `matched` | **as tightened (T-e):** `resolved` only when accepted native-lineage evidence corroborates at least one supplied discriminator beyond name/sport (current team/affiliation or known handle), by exact normalized match; otherwise `ambiguous` |
| D5 | `matched` that conflicts with her said/proof affiliation | `ambiguous` (T-c) |
| D6 | Re-check cadence for `ambiguous`/`failed` | only on anchor change, athlete confirmation, identity TTL (365 d) or admin |
| D7 | Can automation downgrade `resolved`? | no: sticky; reverts only by athlete rejection or a name/sport change |
| D8 | Athlete confirmation authority | resolves only from `ambiguous`, against Q1 evidence (proof may break a tie), stored as an `athlete_asserted` row; never from pending/failed, never from account ownership |
| D9 | Calibration under the gate | observed, not enforced; no identity write; calibration athletes stay NULL |
| D10 | Per-query persist storage | `research_runs.query_id` + widened unique index (0081, its own file) |
| D11 | Profile–affiliations companion in v3 | dropped; profile plannable (direct only); acceptance/settle split (option B) |
| D12 | Q5 narrowing | deterministic post-filter, not a spec text change |
| D13 | `signals` under `direct` | **carry v2's Trends/GDELT lane into v3 unchanged**, as a gated step after the identity gate (§5.1–§5.3); no redesign of the signals |
| D14 | Lifecycle trigger site | `auth.ts` signup + claim-link sites, not the onboarding workflow |
| D15 | Where R-a (M.I.A. after Q1) lands | in H, behind the same predicate |
| D16 | Q2–Q6 sequential or parallel | sequential in v0 |
| D17 | Workflow-level LLM cap across per-query rows | deferred to PR F; the nightly cap bounds spend meanwhile |
| D18 | Gate-held domains | re-queued in `pending` (`heldBy: identity_gate`), so they run once identity resolves |

**Still open, and none of it blocks E1–E3/H:**
- **An earlier re-check for `failed`.** Young athletes' public footprint grows, which could justify checking sooner
  than the identity TTL. Not adopted, because there is no data. Revisit with measured G5 results.
- **A numeric confidence floor (D3).** Only after a read-only pass over dev37 `identityByQuery` shows a
  distribution that would justify one.
- **The workflow-level LLM cap value (D17).** Belongs to PR F, after the O3 pricing verification.
