# Checkpoint 0 — the merge train and the road of 0071–0076 to production

**Status: PLAN for the founder's explicit approval. Nothing in here has been run.**
Read-only investigation, 27 Sep 2026. No branch was switched, nothing was merged, pushed, deployed or migrated, and
production was not contacted. All facts come from `origin/*` refs, `gh` and the repo files at the stack tip
`origin/docs/nomila-e2e-audit` (b5f4cc6c).

## 0. In plain words

- The accepted Brain/intelligence work is **one linear stack of 43 PRs**: it starts at **#622** (the only one based on
  `main`) and runs up to **#666**. Merging it to `main` redeploys **dev** at once. It does **not** touch production.
- Production changes only when a promoter runs **`promote.yml`**. That workflow promotes **all of `main`**, not only
  this train. Production is at **db76dc2f (14 Sep)**, 1,149 commits behind `main` before this train lands.
- Migrations 0071–0076 reach production **only on that promotion**, as part of one `scripts/db-migrate.sh` run. The
  same run applies **every numbered file after 0053**. The prod copy of the script stops at 0053, so the run also
  applies **0055, 0063, 0065, 0068, 0069 and 0070**, which prod has never had. It also re-runs 0054–0067, which were
  applied to prod by hand on 25 Sep.
- **Blocker before any merge.** No PR in the stack has ever had CI, because CI runs only on PRs whose base is `main`.
  One known test failure is recorded (F6: 0061's parity test against 0072's new column), so CI on the full train is
  expected to be **red** until that is fixed.

---

## 1. Stack inventory

Repo settings: `delete_branch_on_merge: false`, and merge, squash and rebase are all allowed. `main` protection needs
the status check **`checks`** and **0** approving reviews. A ruleset on `production` blocks deletion and force-push.
`reviewDecision` is empty on every PR below, so no GitHub review has been recorded. "Accepted" is the founder's call,
not GitHub state.

### 1a. The accepted train, from main upward (all MERGEABLE/CLEAN against their current base)

| # | PR | head branch | head SHA | base | checks | adds migration |
|---|---|---|---|---|---|---|
| 1 | #622 | docs/commercial-intelligence-boundary-checkpoint | 299258dd | **main** | all green (base is main) | |
| 2 | #623 | feat/ci-boundary-fixtures | 44b707a3 | #622 | **none** | |
| 3 | #625 | feat/ci-boundary-thin-slice | d31cce77 | #623 | none | |
| 4 | #626 | feat/brain-0.5.0-exp | aa8dd6cf | #625 | none | |
| 5 | #628 | feat/brain-0.6.0-exp | 31dd1a57 | #626 | none | |
| 6 | #629 | feat/brain-0.6.1-exp | 337e67a1 | #628 | none | |
| 7 | #631 | feat/brain-0.7.0-exp | 14d25def | #629 | none | |
| 8 | #634 | feat/brain-0.8.0-exp | cd31eb63 | #631 | none | |
| 9 | #635 | feat/brain-0.8.1-exp | 3a34c478 | #634 | none | |
| 10 | #636 | feat/brain-acquisition-seam | 25a3ca75 | #635 | none | |
| 11 | #637 | feat/brain-evidence-reconsideration | 8a4c4c83 | #636 | none | |
| 12 | #638 | docs/context-opportunity-intelligence-checkpoint | bf7ea197 | #637 | none | |
| 13 | #639 | docs/opportunity-pass-2-checkpoint | 858d9fa0 | #638 | none | |
| 14 | #640 | feat/opportunity-1.1.0-pass-2 | 87157d9c | #639 | none | |
| 15 | #641 | docs/opportunity-p6-knowledge-boundary | 7173bf64 | #640 | none | |
| 16 | #642 | feat/opportunity-1.2.0-knowledge-boundary | 67254190 | #641 | none | |
| 17 | #643 | docs/status-map-and-objective-1.0.3 | f6322fd0 | #642 | none | |
| 18 | #644 | feat/objective-1.0.3-baseline | 34ac90c5 | #643 | none | |
| 19 | #645 | docs/objective-1.0.4-epistemic-contrast | 96ce1a79 | #644 | none | |
| 20 | #646 | feat/objective-1.0.4-epistemic-contrast | f1c9d2ab | #645 | none | |
| 21 | #647 | docs/recommendation-execution-path-boundary | 92ee0dc0 | #646 | none | |
| 22 | #648 | docs/recommendation-substrate | 465ac0c9 | #647 | none | |
| 23 | #649 | feat/brain-0.9.0-exp-execution-shape | ada17186 | #648 | none | |
| 24 | #650 | feat/brain-0.10.0-exp-r15-r17 | cd7cd1c2 | #649 | none | |
| 25 | #651 | feat/brain-0.11.0-exp-r17-ends | 547540ed | #650 | none | |
| 26 | #652 | feat/planner-forcing-experiment | 669b8914 | #651 | none | |
| 27 | #653 | feat/planner-preconditions | 6e811559 | #652 | none | |
| 28 | #654 | feat/outreach-planner | 15318fa0 | #653 | none | **0071** |
| 29 | #655 | docs/campaign-creative-seam | c4e6ba27 | #654 | none | |
| 30 | #656 | feat/creative-intent-forcing | 5bada0d1 | #655 | none | |
| 31 | #657 | feat/creative-intent-slice | 20cfd173 | #656 | none | **0072** (ce4ee940) |
| 32 | #658 | feat/campaign-source | e69cc7d8 | #657 | none | **0073** |
| 33 | #659 | feat/campaign-amendment3-loop | 2dead32e | #658 | none | **0074** |
| 34 | #660 | feat/campaign-lifecycle-close | a057cd14 | #659 | none | |
| 35 | #661 | feat/outcome-attribution | f5b2b9f3 | #660 | none | **0075** |
| 36 | #662 | feat/brain-substrate | 799d457c | #661 | none | **0076** |
| 37 | #663 | feat/durable-brain-loop | 2db9a86f | #662 | none | |
| 38 | #664 | feat/brain-live-activation | **3f0139f6** | #663 | none | |
| 39 | #665 | feat/brain-reliability-0-12 | **3f0139f6** | `base/brain-live-activation-accepted` (fa001d09) | none | |
| 40 | #666 | docs/nomila-e2e-audit | b5f4cc6c | #665's branch | none | |

Verified: `origin/main` (9fff9b15) is an ancestor of the tip, and so is every branch above. The tip is 70 commits
ahead of `main`. Against `main`, the train changes only `migrations/0071–0076`, `scripts/db-migrate.sh` (+6 list
lines) and `shared/schema.ts` in the schema path. It changes nothing under `.github/`, `gcp/`, `eas.json` or
`app.json`.

**#623 is in the train.** It is an ancestor of #626, not a separate PR.

### 1b. Not in the train (not ancestors of the tip; each separate)

| PR | base | state | file overlap with the train |
|---|---|---|---|
| #608 docs/context-intelligence (dce3cb0b) | main | CLEAN, green | none (#638 cites it as a *control*, doesn't contain it) |
| #627 docs/brain-decision-subject-checkpoint (8814a63c) | main | CLEAN, green | none |
| #630 docs/brain-recommendation-execution-path (6f637874) | main | CLEAN, green | none |
| #632 docs/brain-request-intelligence-resolution (5a96b0e5) | main | CLEAN, green | none |
| #633 docs/brain-request-proposition-identity (987682dc) | main | CLEAN, green | none |
| #621 docs/deals-intelligence-audit, #624 docs/deals-brain-leverage-checkpoint | main | CLEAN, green | none |
| #570 docs/campaign-slice-design | main | CLEAN, green | none (the train records #570 amendments in its own files) |
| #309 feat/weekly-plan-spine (5dc4dcdc) | main | **CONFLICTING/DIRTY** | `shared/schema.ts` |

These docs PRs can merge before, during or after the train without conflicts. They are docs only, so they do not
change the schema path. Merging any of them before the train turns the train's final merge from a possible
fast-forward into a true merge. That is harmless with merge commits. #309 is out of scope and stays open.

## 2. Merge sequence, overlap and method

### 2a. The #664 / #665 / #666 overlap

- `feat/brain-live-activation` (#664) and `feat/brain-reliability-0-12` (#665) point at **the same commit, 3f0139f6**.
  #664 = b68b9771 + fa001d09 + 202771d3 + 3f0139f6 on top of #663. #665 = 202771d3 + 3f0139f6 on top of the marker
  branch `base/brain-live-activation-accepted` (fa001d09, which is inside #664).
- **Merging #664 lands every commit of #665.** After that, #665 adds nothing. Its only role was to review 0.12.0 as a
  separate diff.
- #666 (1 commit, b5f4cc6c) sits on top of 3f0139f6. It can be pointed at `feat/brain-live-activation` with an
  identical 1-commit diff.

### 2b. Method: merge commits, never squash

`main` history uses real merge commits for PRs, including the earlier Brain stack: #612, #613, #614, #615, #616,
#617, #618 and #620 are all "Merge pull request …". **Squash is ruled out.** Squashing any PR in a stack makes new
SHAs on the base. Every PR above it then still carries the original commits, shows them again as a diff, and can
conflict with the squashed copy. Rebase merging has the same effect. Use **"Create a merge commit"** throughout.

`delete_branch_on_merge` is **false**. So GitHub will **not** auto-retarget a child PR when its base merges. Every
retarget is manual (`gh pr edit <n> --base <branch>`). Also, retargeting does **not** fire CI: `pull_request`
defaults to opened/synchronize/reopened, and a retarget is `edited`.

### 2c. Recommended: top-down collapse, then one merge to main

The train is merged into itself from the top down. Each PR merges into its own base branch, so every PR is recorded
as merged. Only the last step pushes `main`. As a result:
- dev deploys **once**, at a SHA that holds the whole train. No partial train is ever deployed or promotable.
- CI runs on the **whole train** before `main` moves. Each top-down merge pushes to #622's head branch
  eventually, #622 targets `main`, and the `synchronize` event re-runs `ci-checks.yml`. The required `checks` context
  must then pass before #622 can merge.

| step | action | effect |
|---|---|---|
| 0 | **Precondition:** fix F6 and any other red on the tip, as a commit on the top of the stack (e.g. on #666's branch or a new PR above it) | CI can go green |
| 1 | `gh pr edit 666 --base feat/brain-live-activation`, then merge #666 (merge commit) | audit doc joins #664's branch |
| 2 | Close #665 with the comment "landed via #664, same head 3f0139f6; 0.12.0 reviewed here" | the marker `base/brain-live-activation-accepted` becomes deletable |
| 3 | merge #664 → `feat/durable-brain-loop` | |
| 4…39 | merge #663 → #662's branch, then #662 → #661's, … down to #623 → `docs/commercial-intelligence-boundary-checkpoint` (one merge per PR, strictly in reverse table order) | each PR "Merged" into its base |
| 40 | wait for CI on #622, which now carries the whole train: all 21 jobs green | the one real gate |
| 41 | merge #622 → `main` (merge commit) | **push to main → deploy-dev + CI on push** |
| 42 | after deploy-dev is green, delete the 40 stack branches and the marker branch | tidy |

Alternative (bottom-up, the conventional one). Merge #622 into main. Then run `gh pr edit 623 --base main` and push
an empty commit or close+reopen to get CI, and merge. Repeat for 40 PRs. Cost: 40 main pushes = 40 queued dev
deploys (concurrency `deploy-cloud-run-main`, cancel-in-progress **false**, so they all run in turn). Dev code goes
**backwards** from today's branch image to each partial state until the top lands. Every partial SHA gets an image
and becomes promotable. Not recommended.

Step 41 is where #665's retarget question would matter. Under the recommended path #665 is closed at step 2, so the
question never comes up.

## 3. What a merge to main does, and the only path to production

Quoted triggers, from `origin/main`:

- `deploy-dev.yml`: `on: push: branches: [main]` + `workflow_dispatch`. It runs `bash scripts/db-migrate.sh` against
  `gamechanger-pocket-agent:us-central1:nomila-v2-db` (`DB_URL_SECRET=NOMILA_V2_DATABASE_URL`). Then it builds and
  pushes the image tagged `${GITHUB_SHA:0:8}` and runs `gcloud run services replace gcp/cloud-run-dev.yaml`.
  **Yes: every push to main deploys dev.**
- `ci-checks.yml`: `on: pull_request: branches: [main]` and `push: branches: [main]`. It deploys nothing.
- `deploy-prod.yml`: **`on: workflow_dispatch` only.** It has "deliberately no `push` trigger", refuses any ref other
  than `refs/heads/production`, and allows only the promoters `miabhuta-code` and `aaronsongnguyen` (as the actor,
  or as the `promoter` input when the actor is `github-actions[bot]`).
- `promote.yml`: **`on: workflow_dispatch`**, input `confirm` must equal `promote`, and only a listed promoter may
  run it. It fast-forwards `production` to `origin/main` (and refuses if not a fast-forward). It tags
  `v1.2.0-<date>` (a `-<sha8>` suffix is added if the tag exists). Then it runs
  `gh workflow run deploy-prod.yml --ref production -f reason=… -f promoter=<actor>`.

**Nothing deploys production on a push to main.** Production is reached only through `promote.yml` → `deploy-prod.yml`.

The prod job `api` ("Migrate and deploy the API"), environment `production`, runs these steps in order:
1. refuse a non-`production` ref, then check the promoter;
2. **resolve the image `…/gamechanger/nomila-v2:<sha8>` that dev built for this exact commit**, and stop before any DB
   work if that image is missing. This is why the train must deploy dev from `main` before promotion;
3. `gcloud sql backups create --instance=nomila-prod-db --description="pre-promote <sha8>"`;
4. **step "Run schema migration via Cloud SQL Auth Proxy"**, with `CLOUD_SQL_INSTANCE=gamechanger-pocket-agent:us-central1:nomila-prod-db`
   and `DB_URL_SECRET=NOMILA_PROD_DATABASE_URL`, running `bash scripts/db-migrate.sh`. **This is the step that applies
   0071–0076 to production;**
5. `gcloud run services replace gcp/cloud-run-prod.yaml` (service `nomila-v2-prod`), then the allUsers invoker, then
   smoke tests of `/health` on the run.app URL and on `https://api.nomila.co/health`;
6. then the jobs `web` (Firebase: `app.nomila.co` and the **landing page nomila.co**) and `mobile` (**`eas update --branch production`**, the OTA to every installed production build).

**Approvals.** The only gate is the promoter allow-list. The file says so directly: GitHub "required reviewers" on
Environments needs Enterprise, so the `production` environment "only records deployments". promote.yml's comment
"waits for the required reviewer" is **stale**, because there is no pause. The deploy starts the moment promote
dispatches it.

## 4. Migrations 0071–0076, file by file (inspected, not executed)

None of the six files contains `BEGIN`, `COMMIT`, `ROLLBACK`, `START TRANSACTION` or a `DO` block. Every
`CREATE TABLE` / `CREATE INDEX` / `ADD COLUMN` is `IF NOT EXISTS`, and every CHECK re-add is `DROP … IF EXISTS` then
`ADD`. None of them `ADD COLUMN … DEFAULT` on an existing table, so there is no table rewrite. Within db-migrate.sh
each file runs with `psql -v ON_ERROR_STOP=1 -f` (autocommit per statement). A failure mid-file therefore leaves the
statements before it committed, and the file is safe to re-run.

| file | statements | idempotent | locks and cost on existing tables | FK targets (source) |
|---|---|---|---|---|
| **0071_outreach_plans** | CREATE TABLE outreach_plans (self-FK superseded_by); CREATE UNIQUE INDEX outreach_plans_active_per_recommendation (partial); CREATE INDEX idx_outreach_plans_athlete_created | yes | none (new table only) | athletes |
| **0072_creative_intents** | CREATE TABLE creative_intents (+CHECK source_kind), 2 indexes; CREATE TABLE creative_interpretations, 1 index; ALTER studio_plans ADD COLUMN creative_intent_id uuid FK; ALTER generation_jobs ADD COLUMN creative_intent_id uuid FK; 2 partial indexes; **DROP + ADD generation_jobs_origin_check** ('system','inbound','athlete') | yes | ADD COLUMN nullable, no default: catalog-only, brief ACCESS EXCLUSIVE. Non-concurrent CREATE INDEX on studio_plans/generation_jobs blocks writes while it builds. **The CHECK drop+add re-runs on every deploy**: ACCESS EXCLUSIVE plus a full validation scan of generation_jobs each time (pre-existing pattern, cf. 0062) | athletes; studio_plans (**0061**); generation_jobs (legacy/08, 0027) |
| **0073_campaigns** | CREATE TABLE campaigns (3 CHECKs; the status CHECK here is the pre-Amendment-3 five-state list), campaign_specs (CHECK approval, UNIQUE campaign_id+version), campaign_deliverables (CHECK status), 2 indexes; ALTER generation_jobs ADD COLUMN source_spec_id, source_spec_version, campaign_deliverable_id (nullable, **no FK**); 1 partial index | yes | same catalog-only ADD COLUMN plus non-concurrent partial index on generation_jobs | athletes; campaigns (same file) |
| **0074_campaign_lifecycle_amendment3** | DROP + ADD campaigns_status_check ('planning','approved','ended') | yes (re-runs every deploy) | ACCESS EXCLUSIVE on campaigns (new, empty on prod). **Would fail if any row held 'idea' or 'active'**. **Depends on 0073.** | — |
| **0075_outcome_observation_links** | CREATE TABLE published_asset_identities (2 CHECKs), 2 unique indexes and 1 index; ALTER campaign_deliverables ADD COLUMN confirmed_by, confirmed_at, confirmation_ref | yes | new tables only | athletes; media_assets (legacy); studio_publish_jobs (**0059**); **depends on 0073** (campaign_deliverables) |
| **0076_brain_substrate** | CREATE TABLE brain_runs (+2 indexes incl. UNIQUE athlete+prompt_sha256+as_of), recommendations (text PK, 3 indexes), recommendation_events (UNIQUE recommendation_id+seq, 1 index) | yes | none | athletes; brain_runs and recommendations (same file) |

Idempotency caveat: `CREATE TABLE IF NOT EXISTS` does not reconcile a same-named table of a different shape, and
`CREATE INDEX IF NOT EXISTS` keeps a same-named index of a different definition. **Precondition: none of these table
or index names may already exist on prod** (see §5).

### CHECK lists versus shared/schema.ts (at the tip)

| constraint | re-created each deploy by | list in SQL | schema.ts | match |
|---|---|---|---|---|
| generation_jobs_origin_check | 0072 (DROP+ADD) | system, inbound, athlete | :1756 same | ✔ |
| campaigns_status_check | 0074 (DROP+ADD) | planning, approved, ended | :3048 same | ✔ |
| campaigns_origin_door_check / ended_because_check | 0073 inline (created once) | recommendation, deal, athlete, observed / fulfilled, expired, cancelled | :3047 / :3049 | ✔ |
| campaign_specs_approval_check | 0073 inline | draft, athlete, brand, contractual | :3071 | ✔ |
| campaign_deliverables_status_check | 0073 inline | open, fulfilled, waived, cancelled | :3095 | ✔ |
| creative_intents_source_kind_check | 0072 inline | planner, campaign, athlete | :2999 | ✔ |
| published_asset_identities_* | 0075 inline | platform_media_id, provider_mapping, permalink / has_identity | :3117–3118 | ✔ |
| media_assets_origin_check (touched in step 1) | legacy/08 DROP+ADD every deploy | … reference | :1556 | ✔ |

`legacy/08_studio_generation.sql` still declares `generation_jobs_origin_check` with only ('system','inbound'). It
does so only inside `CREATE TABLE IF NOT EXISTS`, so on an existing database it is a no-op. On a fresh database 0072
widens it later in the same run. **No step narrows it back, so the 7-Sep "two paths fighting" failure does not recur
here.** Watch item: if anyone ever turns that legacy line into a DROP+ADD, it would break the first deploy after an
`athlete` job exists (the same pattern as 23 Sep, `media_assets`).

`outreach_plans.status`, `recommendations` and `brain_runs` have no CHECK constraints, and none are declared in
schema.ts either, so they are consistent.

## 5. Production state: what is known, what is not, and what to verify

What the repo records:
- **Last prod deploy:** `deploy-prod` run on `production` at **db76dc2f, 2026-09-14** (success). `production` has not
  moved since. **The prod copy of `db-migrate.sh` lists files only up to 0053_research_evidence_v2.**
- **0044–0050 incident (11 Sep):** a chained dry-run inside an outer BEGIN…ROLLBACK was committed by the inner
  `COMMIT` in 0040/0042 (`docs/architecture/phase-a/README.md:39`, `step2d-canonical-context.md:263`). Schema only,
  "never recorded as applied". **0040 and 0042 still contain `BEGIN; … COMMIT;`**.
- **Studio hand-apply (25 Sep):** `docs/probes/ship.md` (ADI-S20-STEP9, around line 985). "Applied to prod
  (`nomila-prod-db`), each file alone, in step-3 order, no errors: 0054, 0056, 0057, 0058, 0059, 0060, 0061, 0062,
  0064, 0066, 0067." Drift afterwards listed only "Mia's six tables" as missing: `intelligence_ledger`,
  `mia_evaluation_runs`, `mia_evidence_snapshots` (0055) and `objective_events`, `objective_proposal_sets`,
  `objectives` (0063; 0068–0070 add columns to these). The audit (`docs/audits/nomila-e2e-audit/07-studio.md:110,
  :343`) marks this **CANNOT VERIFY**.
- There is **no ledger** for hand-written files on any environment. Schema present does not mean recorded as applied.
- On dev, 0071–0076 were applied through the normal path. `deploy-dev.yml` was dispatched on the **branch**
  `feat/brain-live-activation` @ 202771d3 (run 36356955934, 27 Sep, green;
  `brain-reliability-0.12.0-checkpoint.md` §7). So **dev Cloud Run currently runs a branch image, not `main`**. The
  first push to `main` replaces it.

So on promotion, prod's db-migrate run will, for the first time, **apply 0055, 0063, 0065, 0068, 0069, 0070 and
0071–0076**. It will **re-run** 0031–0067 (including the hand-applied Studio set), legacy 01–09,
`generationGuards.sql`, the drizzle journal, `createTriggers.ts`, the **HARD drift gate**
(`checkSchemaDrift.ts`) and `backfillBrandIdentityWrite.ts`.

### Proposed read-only checks on prod (for approval; to run through the proxy on 5441, one SELECT at a time)

```sql
-- P1. Dependencies exist; the new names do NOT
SELECT t, to_regclass('public.'||t) IS NOT NULL AS present FROM unnest(ARRAY[
  'athletes','studio_plans','generation_jobs','media_assets','studio_publish_jobs',          -- must be TRUE
  'intelligence_ledger','mia_evaluation_runs','mia_evidence_snapshots',
  'objectives','objective_events','objective_proposal_sets',                                  -- expected FALSE (0055/0063)
  'outreach_plans','creative_intents','creative_interpretations','campaigns','campaign_specs',
  'campaign_deliverables','published_asset_identities','brain_runs','recommendations',
  'recommendation_events'                                                                     -- must be FALSE
]) AS t;

-- P2. None of the new columns already exist
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema='public'
   AND (table_name, column_name) IN (('studio_plans','creative_intent_id'),('generation_jobs','creative_intent_id'),
        ('generation_jobs','source_spec_id'),('generation_jobs','source_spec_version'),('generation_jobs','campaign_deliverable_id'));

-- P3. Index / constraint name collisions
SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN (
 'outreach_plans_active_per_recommendation','idx_outreach_plans_athlete_created','creative_intents_athlete_key',
 'idx_creative_intents_athlete_created','idx_creative_interpretations_intent','idx_studio_plans_creative_intent',
 'idx_generation_jobs_creative_intent','idx_campaigns_athlete_created','idx_campaign_deliverables_campaign',
 'idx_generation_jobs_campaign_deliverable','published_asset_identities_asset_platform',
 'published_asset_identities_platform_media','idx_published_asset_identities_athlete','idx_brain_runs_athlete_as_of',
 'brain_runs_athlete_prompt','idx_recommendations_athlete_open','idx_recommendations_key','idx_recommendations_subject',
 'idx_recommendation_events_rec');

-- P4. The CHECKs that get DROP+ADDed: current definitions and the rows they must admit
SELECT conrelid::regclass, conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conname IN ('generation_jobs_origin_check','media_assets_origin_check','campaigns_status_check');
SELECT origin, count(*) FROM generation_jobs GROUP BY 1;
SELECT origin, count(*) FROM media_assets GROUP BY 1;

-- P5. Size of the tables that take an ACCESS EXCLUSIVE lock / index build
SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid))
  FROM pg_stat_user_tables WHERE relname IN ('generation_jobs','studio_plans','media_assets','athletes');

-- P6. The hand-applied Studio set really is there (spot-check one object per file)
SELECT t, to_regclass('public.'||t) IS NOT NULL FROM unnest(ARRAY['studio_sessions','studio_publish_jobs',
  'studio_brand_profiles','studio_reference_analyses','studio_plans','studio_edit_previews']) t;

-- P7. Journal position and live activity (nothing long-running that would block DDL)
SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 3;
SELECT pid, state, xact_start, left(query,80) FROM pg_stat_activity
 WHERE datname = current_database() AND state <> 'idle' ORDER BY xact_start;

-- P8. Athlete rows on prod (the "prod has 0 athletes" statement is from 11 Sep)
SELECT count(*) FROM athletes;
```

Plus, read-only against GCP: `gcloud sql instances describe nomila-prod-db --project=gamechanger-pocket-agent
--format="value(settings.backupConfiguration)"`, to confirm automated backups are on. The workflow's manual backup
covers this promotion either way.

## 6. Deliverables

### (a) Merge sequence: §2c table (top-down collapse, merge commits, one push to main)

### (b) The exact production action that applies 0071–0076

Precondition: `main` holds the train, and **deploy-dev for that exact `main` SHA is green**, so the image
`us-central1-docker.pkg.dev/gamechanger-pocket-agent/gamechanger/nomila-v2:<sha8>` exists.

```bash
# run by a listed promoter only (miabhuta-code or aaronsongnguyen) — founder's explicit, named approval required
gh workflow run promote.yml --repo nomila-co/nomila-v2 --ref main -f confirm=promote
```

Consequences, in order:
1. `production` fast-forwards from **db76dc2f to `main`**. That is **~1,149 pre-train commits plus the train**: all
   Studio, objectives, identity, research and rates work since 14 Sep, not only 0071–0076. It is tagged
   `v1.2.0-<UTC date>`.
2. deploy-prod starts at once, with no reviewer pause. It takes the pre-promote Cloud SQL backup, then runs
   **db-migrate.sh on `nomila-prod-db`**. New to prod: tables `intelligence_ledger`, `mia_evaluation_runs`,
   `mia_evidence_snapshots` (0055), `objectives`, `objective_events`, `objective_proposal_sets` (+0065/0068–0070
   columns and constraints), then **0071** `outreach_plans`; **0072** `creative_intents`, `creative_interpretations`,
   `studio_plans.creative_intent_id`, `generation_jobs.creative_intent_id`, widened `generation_jobs_origin_check`;
   **0073** `campaigns`, `campaign_specs`, `campaign_deliverables`, `generation_jobs.source_spec_id /
   source_spec_version / campaign_deliverable_id`; **0074** the 3-state `campaigns_status_check`; **0075**
   `published_asset_identities` + 3 `campaign_deliverables` columns; **0076** `brain_runs`, `recommendations`,
   `recommendation_events`. After that come the triggers, the **hard drift gate**, and the brand backfill.
3. `nomila-v2-prod` is replaced with the dev-built image. The `gcp/cloud-run-prod.yaml` changes since 14 Sep also
   ship: **maxScale 10 → 4**, `DB_POOL_MAX=10` and `OPENROUTER_API_KEY` secret.
4. The web app is published to `app.nomila.co` and the landing page to `nomila.co`, and an **EAS OTA goes to the
   `production` channel**.

**Flags on prod** (`gcp/cloud-run-prod.yaml`, unchanged by the train):
- `BRAIN_SUBSTRATE_LOOP`, `OUTREACH_PLANNER_ENABLED`, `STUDIO_CREATIVE_INTENTS`, `STUDIO_CAMPAIGN_GOVERNANCE`,
  `OBJECTIVES_V1`, `STUDIO_ALL_ON`: **absent**. `STUDIO_ENABLED="false"` and `MILA_AGENT_V2="true"` are set.
- The readers are `=== "true"` (`brainLoopDurable.ts:31`, `outreachPlannerOrchestrator.ts:29`) and `studioFlag()`,
  which is true only for `"true"` or for STUDIO_ALL_ON when the value is not `"false"`. So **every new surface is off
  on prod**, and the new tables stay empty until a flag is set in the yaml (a yaml change is needed: hand-set vars are
  wiped on the next deploy).

If the founder wants 0071–0076 on prod **without** everything else in `main`, there is no workflow for that.
promote is fast-forward-only from `main`. Anything narrower would be a hand-apply. That was rejected for dev (no
ledger), and the standing rule forbids it without an explicit named command.

### (c) Per-file dry-run procedure (never chain files; refuse any file with its own transaction control)

Where it can run: a **clone of prod** is the only place where the whole sequence can be rehearsed faithfully. The
reason is that 0074 and 0075 depend on 0073's tables, and a per-file ROLLBACK removes them. The proposal (approval
needed; creates a billable instance and touches no prod data):
`gcloud sql instances clone nomila-prod-db nomila-prod-rehearsal-0927 --project=gamechanger-pocket-agent`.
Then run `DATABASE_URL=<clone via proxy> bash scripts/db-migrate.sh` **for real** on the clone. That exercises the
exact prod recipe, including the drift gate and the files prod has never seen. Delete the clone afterwards.

Directly on prod (only with an explicit named command), a per-file BEGIN…ROLLBACK is meaningful only for files whose
dependencies already exist there: **0071, 0072, 0073, 0076**. 0074 and 0075 cannot be dry-run standalone on prod.

```bash
# one file per invocation; never a loop that shares a session; never --single-transaction over several files
f=migrations/0071_outreach_plans.sql
# refuse: any top-level transaction control (a DO-block "BEGIN" has no semicolon and is allowed)
if grep -nEi '^\s*(COMMIT|ROLLBACK|END|BEGIN|START\s+TRANSACTION|SAVEPOINT|RELEASE)\b\s*(WORK|TRANSACTION)?\s*;' "$f"; then
  echo "REFUSE: $f carries its own transaction control"; exit 1; fi
grep -nEi '^\s*(COMMIT|ROLLBACK)\b' "$f" && { echo "REFUSE: $f"; exit 1; }   # belt and braces
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "BEGIN" \
  -c "SET LOCAL lock_timeout = '3s'" -c "SET LOCAL statement_timeout = '60s'" \
  -f "$f" \
  -c "SELECT 'reached end of $f'" \
  -c "ROLLBACK"
# afterwards, prove nothing stuck:  SELECT to_regclass('public.outreach_plans');  -- must be NULL
```

Then repeat separately for 0072, 0073 and 0076, with a P1/P2 re-check after each. **0040 and 0042 would be refused
by this guard** (they contain `BEGIN; … COMMIT;`), and that is intended.

### (d) Risks and preconditions (all must hold before approval)

1. **CI has never run on 42 of the 43 PRs.** A known red exists: F6, where
   `server/studio/agent/plans.migration.test.ts` "0061 matches schema.ts" fails because 0072 adds
   `studio_plans.creative_intent_id` (`brain-reliability-backlog.md` F6). It must be fixed at the top of the stack
   and the whole train must be green on #622 before `main` moves. Per the standing rule, never merge on CI alone.
2. **The promotion is broad.** It is not "0071–0076". It includes 1,149 other commits, 12 new-to-prod migration files
   (0055, 0063, 0065, 0068–0076), a web/landing release, an OTA to production users, and a Cloud Run scaling change.
   Each needs its own sign-off, or the founder accepts the bundle explicitly.
3. **The hand-applied state is unverified**: 0044–0050 (incident) and the 0054–0067 Studio set. The drift gate is
   hard, so a missing object fails the deploy **after** earlier files have committed. Run P1–P8 and preferably the
   clone rehearsal first.
4. **No reviewer pause** in deploy-prod, despite promote.yml's comment. Once promote is pressed, DDL runs within
   minutes.
5. **Partial application on failure.** Autocommit per statement means a mid-run failure leaves prod half-migrated
   while the **old image keeps serving**. All six new files are additive, so the old image is unaffected. Recovery is
   to fix and re-run (idempotent), or to restore from the pre-promote backup.
6. **Locks on live tables.** 0072 and 0073 take brief ACCESS EXCLUSIVE locks and build non-concurrent indexes on
   `generation_jobs` and `studio_plans`. 0072's CHECK re-validates `generation_jobs` **on every future deploy**.
   This is small on prod (Studio off), but P5 should confirm.
7. **0074's narrowed CHECK** fails any future deploy if an `idea` or `active` campaign row is ever written. The
   current writer only uses the three states.
8. **Dev regression window.** Dev currently runs a branch image. It is replaced by `main`'s image on the train's merge
   (top-down path: once), or on every partial merge (bottom-up path).
9. **The #665 close must reference #664.** The marker branch `base/brain-live-activation-accepted` should be deleted
   only after #665 is closed.
10. **Flags stay off on prod.** Any activation is a separate `gcp/cloud-run-prod.yaml` change plus another promotion.
