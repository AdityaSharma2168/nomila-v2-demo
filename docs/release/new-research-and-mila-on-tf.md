# Release checklist: new research + scoring, waitlist screen, Mila on TrueForge

Owner-approved prep, 26 Oct 2026. Nothing here has been applied to prod. **Owner** = the person who decides and flips
flags. **Promoter** = `miabhuta-code` or `aaronsongnguyen` (the only logins promote.yml / deploy-prod.yml accept).
**Engineer** = whoever is on call for the first hour (reads logs, opens fix PRs, never flips prod without the owner).

## 0. Facts this plan rests on

- **What prod runs now:** `production` = `d3d37fa2` (deploy-prod run 26 Oct 16:43 UTC, success). `main` is 42 commits ahead
  and `production` is an ancestor of `main`, so a fast-forward promotion works.
- **New migrations since prod:** one, `migrations/0141_mila_tf_chat.sql`. It adds two tables (`mila_tf_sessions`,
  `mila_tf_turn_items`) and their indexes. It is additive, uses `IF NOT EXISTS` throughout and has no transaction
  control. #1140 adds no migration. Prod gets two empty tables. Nothing reads them while `MILA_TF_CHAT` is off.
- **A promotion ships all of `main`.** That means every merged commit, the web app (app.nomila.co), the landing
  (nomila.co) and an OTA to the production channel. Stages are separated by **flags**, not by promotions.
- **What ships with the next promotion no matter which flags are set:**
  - the WebFrame backdrop (#1141). deploy-prod forces `EXPO_PUBLIC_WEB_V2=true` for the web export, so it goes live on
    app.nomila.co with the promotion. It has no separate switch.
  - the landing as it is on `main` at that moment.
- **Kill switches are Cloud Run env vars.** A flip takes seconds and creates a new revision with 100% of traffic. The
  revision that was serving keeps its in-flight requests until they finish. deploy-prod applies the whole YAML
  (`services replace`), so an emergency flip would normally be undone by the next promotion. **This PR adds a guard
  for that:** deploy-prod now refuses to switch a guarded flag ON (`scripts/prod-flag-guard.ts`). Two rules follow:
  - Turn a flag **on** with `gcloud`, then set the YAML to `"true"` in a PR.
  - Turn a flag **off** with `gcloud`, then set the YAML to `"false"` in a PR.

## 1. Kill switches (each one is a single command; no deploy needed)

```bash
gcloud run services update nomila-v2-prod --region=us-central1 --project=gamechanger-pocket-agent \
  --update-env-vars=FLAG=false        # docs: https://cloud.google.com/run/docs/configuring/services/environment-variables
```

| Flag | What happens when it is turned off, including work already running |
|---|---|
| `LEAN_SIGNUP_RESEARCH` | New sign-ups pin v3, or v2 if the quick score is off. Runs already on v4 finish on v4: their version is pinned, and the per-run cap `AGENT_ONBOARDING_COST_CAP_USD` bounds what they can still spend. Each athlete's score source follows the version of her own run, so nothing mixes. The "Is this you?" handles disappear (`/api/v1/me/handles` returns 404, `/waitlist` returns `handles: []`). Mila's `refresh_research` tool is no longer offered, and refreshes already running finish. To stop a v4 run immediately, cancel it: `POST /api/v1/admin/workflow/runs/<id>/cancel` (admin). |
| `QUICK_SCORE_ONE_CALL` | Takes effect at once. The `quick_score` step answers `off` and makes no call, including on v3/v4 runs that have not reached that step yet. The full score is unaffected. |
| `QUICK_SCORE_STORE_GROUNDED` | Legal kill switch. No grounded call is made, and the landing stops showing quick scores that are already stored (they are filtered when read). |
| `MILA_TF_CHAT` | The next message goes to the harness (`AGENT_V3`, on in prod). It keeps the conversation history from `chat_messages`, and approvals tapped from TrueForge cards still run through the shared pending-actions path. |
| `NOMILA_MCP_ENABLED` | `/mcp` returns 404. It also turns Mila on TrueForge off, because the route treats the two flags as one switch. **Turn `MILA_TF_CHAT` off first and wait 5 minutes before this one.** A turn still finishing on the old revision calls `/mcp` on the new one, and its tools would fail. |
| `MILA_TF_WAITLIST` | Not built yet. It is already on the guard list. Its PR must ship it as `"false"` in both YAMLs, pin it in a test, and fall back to today's join flow when it is off. |

These flags are **build-time or static**. Turning them off means rolling back a deploy:

- **App web (app.nomila.co), including the WebFrame backdrop:** Firebase console → Hosting → site `nomila-app` →
  Release history → Roll back. Or run `firebase hosting:clone nomila-app:@<VERSION_ID> nomila-app:live`
  ([docs](https://firebase.google.com/docs/hosting/manage-hosting-resources)).
- **Landing (nomila.co), including the #1140 screen:** the same steps on site `nomila`. The landing's new behaviour
  depends on the server flags above, so turning those off usually reverts what athletes see without a web rollback.
- **Native OTA:** `eas update:rollback` (interactive) on branch `production`
  ([docs](https://docs.expo.dev/eas-update/rollbacks/)). None of these features depend on an `EXPO_PUBLIC_*` flag on
  native.
- **Whole API revision:** `gcloud run services update-traffic nomila-v2-prod --region=us-central1 --to-revisions=<previous-revision>=100`
  ([docs](https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)). 0141 is additive, so the
  previous image runs on the new schema.

## 2. Before the first promotion (one time)

1. **Rehearse the migration on a prod clone.** The rule is never a chained dry run against prod. Run these from
   Cloud Shell (Linux, `gcloud` already signed in), at the commit you will promote:
   ```bash
   P=gamechanger-pocket-agent; C=nomila-prod-rehearsal-$(date -u +%m%d)
   grep -nEi '^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b' migrations/0141_mila_tf_chat.sql && echo REFUSE   # expect nothing
   gcloud sql instances clone nomila-prod-db "$C" --project=$P            # https://cloud.google.com/sql/docs/postgres/clone-instance
   git checkout <sha-to-promote> && npm ci --ignore-scripts --legacy-peer-deps
   CLOUD_SQL_INSTANCE=$P:us-central1:$C DB_URL_SECRET=NOMILA_PROD_DATABASE_URL PROXY_PORT=5441 bash scripts/db-migrate.sh   # the exact prod recipe + drift gate
   CLOUD_SQL_INSTANCE=$P:us-central1:$C DB_URL_SECRET=NOMILA_PROD_DATABASE_URL PROXY_PORT=5441 bash scripts/db-migrate.sh   # again: proves it is idempotent
   ```
   Pass means: both runs print `Schema migration succeeded`, and `SELECT to_regclass('mila_tf_sessions'), to_regclass('mila_tf_turn_items');`
   on the clone returns both table names. Then **delete the clone the same day**. Prod has deletion protection, and the
   clone copies it:
   ```bash
   gcloud sql instances patch "$C" --no-deletion-protection --project=$P
   gcloud sql instances delete "$C" --project=$P --quiet                  # https://cloud.google.com/sql/docs/postgres/delete-instance
   gcloud sql instances list --project=$P --format='value(name)'          # the clone must be gone
   ```
   If a later PR adds a migration before the promotion, rehearse again. To find new migrations, run
   `git diff --name-status origin/production origin/main -- migrations/`.
2. **Monitoring:** run `bash scripts/monitoring/prod-release-monitoring.sh` first. It is a dry run that prints every
   command and file. Adding `VALIDATE=1` also tests each filter against dev logs. Then run
   `APPLY=1 SCHEDULER=1 bash scripts/monitoring/prod-release-monitoring.sh`. That creates 12 log-based metrics, 10 alert
   policies emailing "Nomila pipeline alerts", and the hourly `agent-spend-cron-prod` job. The spend threshold is
   `AGENT_SPEND_ALERT_USD` per provider per UTC day, default $50. Set it with the kill-switch command shown in
   section 1.

## 3. The promotion (every stage that needs new code)

1. `main` must be green, and **dev must have built this exact SHA**. Check with
   `gh run list --workflow deploy-dev.yml --branch main -L 1`: it must show success with `headSha` equal to
   `git rev-parse origin/main`. deploy-prod does not build an image; it stops if the dev image is missing.
2. **`production` must have no commits that are missing from `main`.** Check with
   `git fetch && git merge-base --is-ancestor origin/production origin/main && echo ok`. A hotfix made directly on
   `production` has to be merged back first.
3. `gh workflow run promote.yml --ref main -f confirm=promote` (promoter only). There is **no pause**: the backup and
   the DDL run within minutes. Watch with `gh run watch`. The flag guard refuses the deploy if the YAML would switch a
   guarded flag on.
4. Smoke checks: `curl -fsS https://api.nomila.co/health`, one sign-in on app.nomila.co, and one landing load.

## 4. Stages

| | 1 · Research + scoring | 2 · Waitlist score screen (#1140) | 3 · Mila on TrueForge | 4 · Mila-hosted waitlist |
|---|---|---|---|---|
| **Prerequisites** | Lean research compared on dev and signed off by the owner. Promotion done (code is dark). Monitoring applied. | #1140 merged, with the scripted-lines change below. Dev deploy green. Promotion done. Stage 1 on. | (a) A prod TrueForge and a prod agent (dev uses `trueforge-dev` / `mila-dev`). (b) Prod secrets `NOMILA_MCP_CALLER_SECRET`, `NOMILA_MCP_PASS_KEY`, and the TF API key, with prod values. (c) A YAML PR adding `TRUEFORGE_*` and those secret refs to `cloud-run-prod.yaml`, flags still `"false"`, with `tfFlag.test.ts` updated; then promote. (d) **Account deletion must delete her TrueForge sessions** (athleteDataManifest marks this as required before any non-dev use). The runtime SA already has tokenCreator on `nomila-tf-caller@`. | The `MILA_TF_WAITLIST` PR is built and passes all the rules in section 1. Stage 3 has been stable for a week. |
| **Flip (owner)** | `LEAN_SIGNUP_RESEARCH=true`. Add `QUICK_SCORE_ONE_CALL=true,QUICK_SCORE_STORE_GROUNDED=true` **only after the lawyer clears** storing grounded results (TODO(lawyer) in `services/quickScore/config.ts`; with the store flag off, no call is made). | No flag. The landing ships with the promotion. Its new behaviour shows only on v4 runs (`research.live`) and quick scores. | `NOMILA_MCP_ENABLED=true`, check `/mcp` with one TrueForge call, then `MILA_TF_CHAT=true`. | `MILA_TF_WAITLIST=true` |
| **Scripted lines** | On today's landing, v4 runs still show the rotating checklist lines. | **Owner decision: drop them in prod.** #1140 removes them only on v4 runs (rows that carry `research.live`). Runs started before the flip, and every run after a LEAN kill switch, are v2/v3 and keep them. So flipping LEAN is **not enough**: a one-line change in `landing/index.html` `paintChecklist` is needed, either folded into #1140 before merge or as a follow-up. Replace `: x.status === 'running' ? c.lines[(beat + n) % c.lines.length]` with `: x.status === 'running' ? ''`. The `lines:` arrays in `CHK` are then unused and can be deleted. | | |
| **First hour (engineer)** | Alerts "Lean research: failures / p95", "Quick score: failures", "Spend". Logs: `jsonPayload.msg="lean research"` (outcome, ms, cost). Two or three real sign-ups: the score arrives and the email is sent. Admin: no runs stuck in `lean_research` for more than 20 minutes. | Join on nomila.co with a test account. Live status words appear, and the preliminary score is replaced by the full one in place. No console errors. | "Mila on TF" errors, p95 and IAP alerts, plus the three `/mcp` alerts. A few real turns: cards and approvals work, `agent_runs.provider='trueforge'` cost is recorded. | Join through Mila end to end. All earlier alerts stay quiet. |
| **Rollback** | `LEAN_SIGNUP_RESEARCH=false` (and the quick-score flags), then a YAML PR. | Hosting rollback of site `nomila`. Or switch stage 1 off: v2 runs render exactly as they do on today's landing. | `MILA_TF_CHAT=false`, then 5 minutes later `NOMILA_MCP_ENABLED=false`, then a YAML PR. | `MILA_TF_WAITLIST=false`, then a YAML PR. |

After every flip that is meant to stay, open a one-line YAML PR so `gcp/cloud-run-prod.yaml` matches the live service.
Do this before the next promotion. The guard blocks any deploy that would switch a guarded flag ON, but it lets a
deploy switch one OFF. So if you flip a flag on in prod and leave the YAML at `"false"`, the next promotion silently
turns the feature off again.

## 5. Known gaps (not fixed by this PR)

- The WebFrame backdrop has no runtime switch. Its only rollback is a web rollback.
- Stage 3 needs a prod TrueForge, prod secrets and TF session deletion. None of these exist yet.
- Alert thresholds (TF p95 60 s, lean p95 10 min, $50 per provider per day) are first guesses. Dev logged too few
  `tf chat turn` and `lean research` lines in the last 7 days to calibrate them. Tune them after week one.
- Log-based metrics only count from the moment they are created, so apply the monitoring before stage 1.
