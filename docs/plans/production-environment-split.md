# Production environment split — execution plan

Status: executing · plan reviewed 7 Sep 2026, execution started 8 Sep · branch `infra/prod-environment-split` (worktree `~/dev/nomila-v2-main`, off `origin/main` @ 49b236d, PR #366)
Source: `nomila-environment-split.pdf` (infra audit, 2 Sep, updated 5 and 7 Sep).
Priority per Mia: **production live first, dev hygiene after.** This plan resequences the audit's phases around that.

## Status — 8 Sep 2026

| Done | Pending | Needs a repo/project admin (Mia) |
|---|---|---|
| **B0** dev DB: PITR + deletion protection on | First promotion through the pipeline (promote.yml → deploy-prod.yml) | Protect `main` — done 12 Sep |
| **PR A** merged (#370) | **B3** done 11 Sep by Mia: `api.nomila.co` → `nomila-v2-prod`, `/health` ok | Environment `production` exists; reviewers not possible on the Team plan → promoter allow-list instead — done 12 Sep |
| **PR B** committed on top: `infra/schema-script` (rehearsed twice on a scratch DB, clean drift gate both runs) | **B4** first deploy of `nomila-v2-prod` (waits for B1's migrate proof) | Ruleset on the `production` branch (Actions bot only) |
| **PR C** committed on top: `infra/promotion-pipeline` | **B5** Firebase site `nomila-app` + `app.nomila.co` (needs decision 6, DNS) | `roles/pubsub.publisher` for `gmail-api-push@system.gserviceaccount.com` on topic `nomila-gmail-notifications-prod` (Aaron lacks topic IAM) |
| **B1** `nomila-prod-db` created (PITR, deletion protection, SSL-only, zero authorized networks); db `nomila`, user `nomila_app`; **bootstrapped from dev's schema, migrate script ran clean twice, structure identical to dev (1006-line fingerprint), active weights v7.2.0 load through the app's own service** | **B4 half done**: `nomila-v2-prod` deployed (revision 00001, image `nomila-v2:49b236de`, boots clean against the prod DB); uptime check on `/health` created. **Not yet public**: the `allUsers` invoker binding needs `run.services.setIamPolicy`. The 7 `-prod` schedulers exist but are **paused** until then | `gcloud run services add-iam-policy-binding nomila-v2-prod --member=allUsers --role=roles/run.invoker --region=us-central1` — needs `run.admin`. **Aaron has a pending Owner invitation on the project** (`roles/resourcemanager.projectOwnerInvitee`): accepting it in the console unblocks this and the topic IAM below |
| **B2** secrets `NOMILA_PROD_DATABASE_URL`, `PROD_CRON_SECRET`, `VOICE_SERVICE_SECRET_PROD`, `META_WEBHOOK_VERIFY_TOKEN`, `NOMILA_PROD_DB_POSTGRES_PASSWORD`; buckets `nomila-prod-athlete-media` (CORS for app/nomila.co, review-image lifecycle) + `nomila-prod-inbox-attachments`; queue `nomila-prod-tasks`; topic `nomila-gmail-notifications-prod` + push subscription `nomila-gmail-push-prod`; bucket `nomila-db-dumps` | After the service is public: `gcloud scheduler jobs resume <job>-prod` ×7; then Track C console work (unchanged) | Billing budget + Vertex alerts (Billing Budgets API + billing-account permission) |

Branches are stacked A → B → C in the worktree `~/dev/nomila-v2-main`; open them as three PRs, B based on A, C on B
(GitHub retargets each when its base merges). They are not pushed yet.

Two corrections learned while executing: `scripts/grant-admin.ts` needs an existing athlete row, so on an empty
production database the order is deploy → sign up on prod → grant admin, not grant-before-deploy. And a long
`psql -f` restore over the Auth Proxy from a laptop kept dying, so the bootstrap is server-side
(`scripts/db-bootstrap.sh`: dump → Cloud Storage → `gcloud sql import`), which is also the better recipe.

## 0. The call

The audit's decision stands and every claim in it checked out against the live project today (§1). Today's stack
becomes **dev** unchanged; **prod** is built beside it in the same GCP project with `-prod` names.

Three places where this plan departs from the audit's ordering, all to get prod up sooner:

1. **Sidestep the migration re-baseline.** Prod's schema is bootstrapped from a schema-only dump of dev plus
   reference rows. The re-baseline (one `0000_baseline`, reset journal, delete inline DDL) is the riskiest
   item and needs a quiet window; it moves to after launch (Track D). What ships instead now is *one shared
   schema script* both environments run (PR B), so the two paths cannot fight each other again.
2. **Launch prod with Langfuse tracing off** (`LANGFUSE_TRACING=false`, `PROMPT_REGISTRY=false`) until D1 is
   decided. Nothing in the app needs tracing to serve users; this removes D1 from the critical path.
3. **v1 is unmapped and scaled to zero, not deleted, on the critical path.** Only the `api.nomila.co` domain
   mapping has to move before prod can answer. Full deletion is Track D.

## 1. Verified on 7 Sep (live project, `main` @ #366)

| Audit claim | Verified | Detail |
|---|---|---|
| Journal ends at 0011; files reach 0042 | ✅ | 12 journal entries, 42 files; DB has 13 `__drizzle_migrations` rows (row 11, `created_at` 1784078211053, matches no file — harmless, `migrate` keys on the max timestamp) |
| Deploy carries ~100 inline DDL statements | ✅ | 155 `CREATE`/`ALTER` lines in `deploy.yml`; hand-listed files: 0031, 0032, 0037, 0038-weights, 0039, 0041, 0042; **not listed anywhere: 0033, 0034, 0035, 0036, 0038-deliverables** (all five are IF-NOT-EXISTS idempotent) |
| Two files numbered 0038, no 0040, #309 reuses 0034 | ✅ | `0038_deal_deliverables.sql` + `0038_weights_v7_1…sql`; #309 still carries `0034_trend_observations.sql` |
| Dev DB: backups on, PITR/deletion-protection/SSL off, 6 authorized networks | ✅ | `12.17.209.203, 73.183.50.21, 166.199.148.91, 142.93.194.98, 172.245.96.212, 205.182.133.63` |
| Dev DB extras a dump must carry | ✅ | extensions `vector`, `pg_trgm`; 5 triggers (`task_update_trigger`, 3 studio approval guards, `workflow_runs_default_scope`); 56 tables; `scoring_weights` 4 rows, active **v7.2.0**; `prompts` empty |
| Main unprotected, no environments, no `production` branch | ✅ | org `nomila-co` is on the **Team** plan, so protection + required reviewers are available on this private repo |
| `api.nomila.co` → `gamechanger-api-prod` (v1) | ✅ | v1: 3 Cloud Run services (min 1), 2 SQL instances, 5 schedulers hitting `gamechanger-api-dev`; last deploys Mar/Jun |
| Scheduler script hard-codes dev URL; 7 jobs incl. `workflow-tick` | ✅ | |
| Hostname fallbacks in 6 integration modules + notify/oauthCallback/payments | ✅ | plus `admin/index.html`, `admin/runs.html`, `landing/index.html`, CORS set in `server/index.ts` |
| Bucket names default to dev | ✅ | code references only `-athlete-media` and `-inbox-attachments`; `nomila-v2-media` is not referenced in server code |
| Stripe secrets exist but are not mounted | ✅ | and they are **test-mode** keys (`sk_test_`, `pk_test_`) — prod needs new live secrets |
| `.firebaserc` prod target → `nomila-dev` | ✅ | Firebase sites: `nomila`, `nomila-dev` (+3 legacy gamechanger sites) |
| Voice worker is one hand-deployed LiveKit agent | ✅ | `mila-voice` repo has **no CI workflows**; `livekit.toml` agent `CA_XhcYeRfk9T3C` |
| Billing budget | ⚠️ | `billingbudgets` API not enabled and Aaron's account lacks billing-account permission — Mia's action |
| DNS | ℹ️ | `nomila.co` is **not** in this project's Cloud DNS (nameservers are `ns-cloud-d*.googledomains.com`). `api.nomila.co` and `api-dev.nomila.co` already CNAME to `ghs.googlehosted.com`; `app.nomila.co` and `www` have no records. Whoever holds the registrar/Cloud DNS account adds `app.nomila.co` |

Also relevant: PR #360 (prettier on every file, 752 files) is open and will conflict with every PR below — merge it
first or last, not in between.

## 2. Critical path

What actually gates first prod traffic, in dependency order. Everything else is parallel or after.

1. Code can target two environments — **PR A**
2. One schema script both environments run — **PR B**
3. Prod database exists with schema + reference rows — **B1**
4. Prod plumbing (secrets, buckets, Pub/Sub, Tasks, schedulers) — **B2**
5. `api.nomila.co` freed from v1 and mapped to `nomila-v2-prod` — **B3**
6. First deploy, admin grant, uptime check — **B4**
7. Providers know the prod hosts — **Track C** (console work; starts today, no code dependency)
8. Promotion pipeline with an approval gate — **PR C** (needed before the *second* deploy, not the first)

## 3. Track A — code (three PRs off `main`, dev behaviour unchanged)

### PR A — environment-aware config

- `gcp/cloud-run-v2.yaml` → `gcp/cloud-run-dev.yaml` (same values) + new `gcp/cloud-run-prod.yaml` (§5).
  `deploy.yml` points at the dev file.
- Write every knob prod needs into the **dev** YAML at today's effective value, so nothing changes and the
  full set is visible in one file: `MEDIA_BUCKET`, `INBOX_ATTACHMENT_BUCKET`, `STUDIO_ENABLED`,
  `STUDIO_MAX_JOB_USD`, `CHAT_RATE_LIMIT_PER_HOUR` (code default 60), `MILA_WEB_SEARCH`, `MILA_FUZZY_BRAND`,
  `PUBLIC_BASE_URL`, `PUBLIC_CARD_BASE_URL`, `ALLOWED_ORIGINS`, Stripe test secrets (`STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`), `META_WEBHOOK_VERIFY_TOKEN` as a `secretKeyRef` (secret created in B2 first —
  a YAML that names a missing secret fails the whole deploy, revision 00232 lesson).
- `scripts/provision-schedulers.sh`: `SERVICE_URL`, `JOB_SUFFIX`, `CRON_SECRET_NAME` become env parameters
  defaulting to today's dev values. Prod: `SERVICE_URL=https://api.nomila.co JOB_SUFFIX=-prod
  CRON_SECRET_NAME=PROD_CRON_SECRET`.
- Delete the hostname fallbacks in `server/lib/integrations/{gmail,outlook,instagram,tiktok,youtube,spotify}.ts`,
  `server/lib/notify.ts`, `server/routes/oauthCallback.ts`, `server/services/payments/urls.ts`.
  `envGuards.ts`: `API_BASE_URL` joins `WEB_APP_URL` as fatal-if-missing under `NODE_ENV=production`;
  in development a missing value logs a warning and uses `http://localhost:8080`. `setup-dev-env.sh`
  writes both into `.env`.
- `server/index.ts`: CORS origins from `ALLOWED_ORIGINS` (comma list); today's literal set stays as the
  non-production default.
- `admin/index.html`, `admin/runs.html`, `landing/index.html`: API host derived from `location.hostname`
  (`nomila-dev.web.app` → `api-dev.nomila.co`; `app.nomila.co` / `nomila.co` → `api.nomila.co`; localhost → 8080).
- `.firebaserc`: `prod` → `nomila-app`. `firebase.json`: add a `landing` rewrite variable is not possible in
  Firebase config, so the `/c/**` → `nomila-v2-prod` flip is a one-line edit that lands **with B4**, not before.
- `eas.json`: `production` profile `EXPO_PUBLIC_API_URL=https://api.nomila.co`; `preview`/`development` unchanged.
- Move `server/scripts/triggerBackfill.ts`'s literal to `API_BASE_URL`.

Dev impact: none if every default equals today's value (the PR's test is `diff` of the rendered env between
old and new dev YAML). A local server without the two URLs now warns instead of silently calling Cloud Run.

### PR B — one schema path both environments run

- New `scripts/db-migrate.sh`, parameterised by `CLOUD_SQL_INSTANCE` and `DB_URL_SECRET`, doing exactly what
  the "Run schema migration" step in `deploy.yml` does today, in the same order: proxy up → `CREATE EXTENSION
  vector` (+ `pg_trgm`, which the deploy never creates) → the inline DDL, moved **verbatim** into
  `migrations/legacy/*.sql` files applied with `psql -f` → `drizzle-kit migrate` → the hand-listed files
  **plus the five missing ones** (`0033`, `0034`, `0035`, `0036`, `0038_deal_deliverables`) → `createTriggers.ts`
  → drift gate → brand-identity backfill.
- Renumber `0038_weights_v7_1_no_story_arc_bonus.sql` → `0040_…` (the empty slot; only the script references it
  by name). Ask #309 to renumber `0034_trend_observations.sql` → `0043_…` before merge.
- `deploy.yml`'s step body becomes one line calling the script.
- Proof before merge: restore a scratch database from a dev schema dump, run the script against it twice —
  second run must be a no-op and the drift gate must exit 0.
- This is **not** the re-baseline. It removes the "two schema paths fighting" failure (three failed deploys
  on 7 Sep) and gives prod the identical recipe. The re-baseline later replaces the script body with
  `drizzle-kit migrate` alone.

### PR C — promotion pipeline

- Rename `deploy.yml` → `deploy-dev.yml`, `deploy-web.yml` → `deploy-web-dev.yml` (triggers unchanged;
  `eas-update-preview.yml` already says what it is).
- `promote.yml` (`workflow_dispatch`, input `confirm: "promote"`): fast-forwards `production` to `main`
  (refuses a non-fast-forward), tags `v<app.json version>-<YYYY-MM-DD>`. Same pattern as the v1 repo's
  `promote.yml`.
- `deploy-prod.yml` on `push: branches: [production]`, `environment: production` (required reviewer), concurrency
  group `deploy-cloud-run-prod`:
  1. Resolve the image `…/nomila-v2:<sha8>` that `deploy-dev` built for this commit — **fail if absent**
     ("never ran in dev"). Prod never builds.
  2. `gcloud sql backups create --instance nomila-prod-db` (manual restore point per promotion, until trusted).
  3. `scripts/db-migrate.sh` with `CLOUD_SQL_INSTANCE=…:nomila-prod-db DB_URL_SECRET=NOMILA_PROD_DATABASE_URL`.
  4. `gcloud run services replace gcp/cloud-run-prod.yaml` with the image substituted. The startup probe on
     `/health` already refuses to shift traffic to a revision that will not boot; add a `curl -f
     https://api.nomila.co/health` after. (A `--no-traffic` canary with manual shift is a later upgrade.)
  5. Web: `expo export` with `EXPO_PUBLIC_API_URL=https://api.nomila.co` → `hosting:prod` (`nomila-app`) +
     `hosting:landing`.
  6. `eas update --branch production` with the prod public env.
- Repo settings (applied 12 Sep, once Aaron had repo admin): `main` protected (PR + the `checks` status required, no
  force-push or deletion); ruleset on `production` (no deletion, no force-push); Environment `production` exists
  but **GitHub's required-reviewer rule needs the Enterprise plan for a private repo** (the API refuses it on
  Team), so the approval gate is a **promoter allow-list** in `promote.yml` and `deploy-prod.yml`
  (`PROMOTERS: miabhuta-code aaronsongnguyen`), and `deploy-prod.yml` runs by dispatch only — a stray push to
  `production` deploys nothing.

## 4. Track B — infrastructure (gcloud; each step needs Aaron's go before it runs)

### B0 — today, no team impact (~10 min)

```bash
# Dev DB: deletion protection + PITR. SSL deliberately NOT yet (breaks any direct-IP client; Track D).
# Enabling PITR on Postgres may restart the instance — run off-hours.
gcloud sql instances patch nomila-v2-db --project gamechanger-pocket-agent \
  --enable-point-in-time-recovery --retained-transaction-log-days=7 \
  --retained-backups-count=7 --deletion-protection

# main branch protection (PR + CI required). Reviewer count per decision 1.
gh api -X PUT repos/nomila-co/nomila-v2/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":false,"contexts":["checks"]},
 "enforce_admins":false,
 "required_pull_request_reviews":{"required_approving_review_count":0},
 "restrictions":null,"allow_force_pushes":false,"allow_deletions":false}
JSON
```
Billing budget: Mia enables `billingbudgets.googleapis.com` and creates the budget (Aaron's account has no
billing-account permission).

### B1 — production database

```bash
P=gamechanger-pocket-agent
gcloud sql instances create nomila-prod-db --project $P \
  --database-version=POSTGRES_15 --tier=db-g1-small --region=us-central1 --availability-type=ZONAL \
  --backup-start-time=08:00 --enable-point-in-time-recovery \
  --retained-backups-count=7 --retained-transaction-log-days=7 \
  --deletion-protection --ssl-mode=ENCRYPTED_ONLY
# Public IP stays (Cloud Run's connector and the Auth Proxy need no authorized networks); the list stays EMPTY.
gcloud sql databases create nomila --instance nomila-prod-db --project $P
gcloud sql users create nomila_app --instance nomila-prod-db --project $P --password "$(openssl rand -base64 30)"
```
Bootstrap — server-side, one command (`scripts/db-bootstrap.sh`: schema-only dump of dev + the reference rows
`scoring_weights` and `__drizzle_migrations` → `gs://nomila-db-dumps` → `gcloud sql import`, run as `nomila_app` so
it owns everything; extensions, triggers and functions ride along in the dump):
```bash
SOURCE_URL="$DEV_URL" TARGET_INSTANCE=nomila-prod-db TARGET_DB=nomila TARGET_USER=nomila_app bash scripts/db-bootstrap.sh
CLOUD_SQL_INSTANCE=$P:us-central1:nomila-prod-db DB_URL_SECRET=NOMILA_PROD_DATABASE_URL bash scripts/db-migrate.sh   # must be a no-op ending in "✅ No drift"
# scoring smoke: reloadWeights() against prod resolves the active v7.2.0 row (weightsService throws with none)
```
Secrets (runtime SA `gamechanger-runtime@…` gets `secretAccessor` on each):
`NOMILA_PROD_DATABASE_URL` (socket form, same shape as the dev secret so the script's URL parser works),
`PROD_CRON_SECRET` (`openssl rand -hex 32`, exactly 64 chars, **no trailing newline** — the dev one has a `\r`),
`META_WEBHOOK_VERIFY_TOKEN`, `VOICE_SERVICE_SECRET_PROD`, `STRIPE_SECRET_KEY_LIVE`, `STRIPE_WEBHOOK_SECRET_LIVE`
(the last two from Mia's Stripe dashboard; Langfuse prod keys only after D1).

### B2 — production plumbing

- Buckets: `nomila-prod-athlete-media`, `nomila-prod-inbox-attachments` (copy CORS/lifecycle from the dev pair);
  `nomila-prod-media` only if something outside server code uses `nomila-v2-media`.
- Tasks queue `nomila-prod-tasks` (same rate/retry settings as `nomila-v2-tasks`).
- Pub/Sub: topic `nomila-gmail-notifications-prod`, `gmail-api-push@system.gserviceaccount.com` as publisher,
  push subscription `nomila-gmail-push-prod` → the raw `nomila-v2-prod` run.app URL `/api/webhooks/gmail`, OIDC SA
  `gmail-push@…`, audience = that same raw URL (must equal `PUBSUB_PUSH_AUDIENCE` in the prod YAML; raw URL so the pair
  survives a domain-mapping move, exactly as dev does).
- Schedulers: `SERVICE_URL=https://api.nomila.co JOB_SUFFIX=-prod CRON_SECRET_NAME=PROD_CRON_SECRET APPLY=1
  bash scripts/provision-schedulers.sh` → 7 jobs incl. `workflow-tick-prod`.

### B3 — reclaim `api.nomila.co` (needs decision 2)

```bash
gcloud sql export sql gamechanger-db gs://gamechanger-assets/v1-export/gamechanger-db-$(date +%F).sql.gz --database=<name> --offload
gcloud beta run domain-mappings delete --domain api.nomila.co --region us-central1 --project $P
gcloud beta run domain-mappings create --domain api.nomila.co --service nomila-v2-prod --region us-central1 --project $P
# DNS already CNAMEs to ghs.googlehosted.com — no registrar change. Cert re-issue: minutes to an hour.
gcloud run services update gamechanger-api-prod gamechanger-api-dev gamechanger-mcp --min-instances=0 …   # scale to zero, do not delete yet
gcloud scheduler jobs pause nomila-{ai-insights,research-refresh,proactive-agent,social-snapshots,enrichments}-dev
```
The mapping create must follow the first `services replace` of `nomila-v2-prod` (B4), so B3 and B4 interleave.

### B4 — first deploy

`gcloud run services replace gcp/cloud-run-prod.yaml` with the image tag `deploy-dev` most recently built
(`nomila-v2:<sha8>`, not `:latest`); `add-iam-policy-binding allUsers roles/run.invoker`; then B3's mapping.
`npx tsx scripts/grant-admin.ts <mia> / <aaron>` with `DATABASE_URL` = prod (the admin gate is fail-closed).
Uptime check on `https://api.nomila.co/health` + alert on 5xx ratio (Monitoring API is enabled).
Flip the landing `/c/**` rewrite to `nomila-v2-prod` in the same change.

### B5 — web app host

Firebase site `nomila-app`; custom domain `app.nomila.co` (TXT verification + A records at the registrar —
decision 6); first `hosting:prod` deploy from PR C's workflow or by hand with `API_URL=https://api.nomila.co`.

## 5. Prod YAML — what differs from dev

| Key | Dev (`cloud-run-dev.yaml`) | Prod (`cloud-run-prod.yaml`) |
|---|---|---|
| `metadata.name` / SQL instance | `nomila-v2` / `nomila-v2-db` | `nomila-v2-prod` / `nomila-prod-db` |
| scale | min 1 / max 3 | min 1 / max 4 — bounded by nomila-prod-db max_connections, see `DB_POOL_MAX` (timeout 3600 s, CPU always on — workflow runner needs both) |
| `API_BASE_URL` / `WEB_APP_URL` | api-dev / nomila-dev.web.app | `https://api.nomila.co` / `https://app.nomila.co` |
| `ALLOWED_ORIGINS` | today's list | `https://app.nomila.co,https://nomila.co,https://www.nomila.co` |
| `PUBLIC_BASE_URL` / `PUBLIC_CARD_BASE_URL` | api-dev / api-dev (nomila.co/c/** is rewritten to prod) | `https://api.nomila.co` / `https://nomila.co` |
| `GMAIL_PUBSUB_TOPIC` / `PUBSUB_PUSH_AUDIENCE` | `…notifications` / raw run.app URL | `…notifications-prod` / raw `nomila-v2-prod` run.app URL (same pattern as dev, survives a domain-mapping move) |
| `DATABASE_URL` / `CRON_SECRET` | `NOMILA_V2_DATABASE_URL` / `INTERNAL_CRON_SECRET` | `NOMILA_PROD_DATABASE_URL` / `PROD_CRON_SECRET` |
| `MEDIA_BUCKET` / `INBOX_ATTACHMENT_BUCKET` | `nomila-v2-athlete-media` / `nomila-v2-inbox-attachments` | `nomila-prod-athlete-media` / `nomila-prod-inbox-attachments` |
| `MILA_VOICE_WEB` / `MILA_VOICE_WEB_SEARCH` | true / true | **false until the prod worker exists** / true |
| `MILA_VOICE_AGENT_NAME` / `VOICE_SERVICE_SECRET` | unset / `VOICE_SERVICE_SECRET` | prod agent name / `VOICE_SERVICE_SECRET_PROD` |
| `STUDIO_ENABLED` / `STUDIO_MAX_JOB_USD` | false (was absent; developers run it via `.env`) / 30 | **false / 5** |
| `CHAT_RATE_LIMIT_PER_HOUR` | 60 (explicit) | 60 (explicit) |
| `MILA_WEB_SEARCH` / `MILA_FUZZY_BRAND` | today's effective values | same, written down |
| `LANGFUSE_TRACING` / `PROMPT_REGISTRY` | true / true | **false / false** until D1; then prod keys |
| Stripe | `STRIPE_SECRET_KEY` (test) | `STRIPE_SECRET_KEY_LIVE` / `STRIPE_WEBHOOK_SECRET_LIVE` (decision 7) |
| `INSTAGRAM_*`, `GOOGLE_*`, `MICROSOFT_*`, `TIKTOK_*`, `LIVEKIT_*`, model keys | shared | shared (Meta: prod keeps the live app's creds that dev uses today; dev moves to test-app creds in Track C) |
| `ENABLE_TEST_PAGE` / `ADMIN_OPEN_ACCESS` | false / false | false / false |

## 6. Track C — provider consoles (Mia; can start today)

- **Google OAuth client** (same client, more URIs): redirect `https://api.nomila.co/api/v1/auth/callback/gmail`
  and `…/youtube`; authorized origin `https://app.nomila.co`. Verification pack homepage → `nomila.co`.
- **Firebase Auth** authorized domains: `app.nomila.co` (audit says already present — confirm).
- **Meta**: live app → prod (callback `…/callback/instagram`, webhook `https://api.nomila.co/api/webhooks/instagram`,
  verify token = the new secret). Create a **test app** for dev with the dev callback/webhook; dev's
  `INSTAGRAM_LOGIN_APP_*` / `INSTAGRAM_APP_*` secrets move to the test app's credentials (decision 4).
- **Microsoft**: add `https://api.nomila.co/api/v1/auth/callback/outlook`. **TikTok**: `…/callback/tiktok`.
- **Stripe**: live webhook endpoint `https://api.nomila.co/api/webhooks/stripe`; live keys into the two secrets.
- **LiveKit**: second agent from `mila-voice` with `NOMILA_API_URL=https://api.nomila.co` and
  `VOICE_SERVICE_SECRET_PROD`; its name goes into `MILA_VOICE_AGENT_NAME` on prod only. Add a deploy workflow to
  `mila-voice` (it has none) so the worker promotes like the API.
- **Langfuse** (D1): paid tier + DPA with a separate prod project, or self-host. Prod tracing stays off until then.
- **App stores**: `eas build --profile production` from current `main` (native module + iOS permission strings
  changed 7 Sep, so a binary is due regardless) → TestFlight + Play internal. Bump `runtimeVersion` so old
  binaries do not pull incompatible JS.

## 7. Track D — after prod is live

Re-baseline migrations · require SSL on dev + prune authorized networks (ask who owns `142.93.194.98`,
`172.245.96.212`, `205.182.133.63`, `166.199.148.91`, `12.17.209.203`; `73.183.50.21` is Aaron) · delete v1
(3 services, 2 instances, 5 schedulers, 3 hosting sites) · narrow IAM (`run.developer` + `cloudsql.client` +
`secretAccessor`) · dev bundle id `co.nomila.app.dev` · per-athlete daily voice cap · Studio cost log →
`generation_jobs` · dev min instances → 0 · drop unused `MICROSOFT_REDIRECT_URI`, `SESSION_SECRET` ·
`workflow_steps` retention.

## 8. Sequence

| When | What |
|---|---|
| Day 0 (Mon 7 Sep) | Plan review · decisions 1–8 · **B0** · Track C console work starts |
| Day 1–2 | **PR A**, **PR B** merged (dev unchanged) · **B1**, **B2** |
| Day 2–3 | **B3 + B4** — prod answers at `api.nomila.co` · **PR C** merged, environment created |
| Day 3–5 | **B5** (`app.nomila.co`) · LiveKit prod agent · Stripe live · `eas build --profile production` |
| Week 2 | First promotion through the pipeline · TestFlight / Play internal invites · beta |
| Week 3+ | Track D, starting with the re-baseline in a quiet window |

## 9. Decisions needed

1. **Promotion approver(s)** on the `production` environment: Mia alone, or Mia + Aaron. And PR approvals on
   `main`: 0 (PR + CI only) or 1.
2. **OK to unmap `api.nomila.co` from v1?** Does anything still call `gamechanger-api-prod` or use
   `gamechanger-prod.web.app`? Scale v1 to zero now, delete in Track D (recommended).
3. **Launch prod with Langfuse tracing off** until D1 (recommended), or decide D1 first.
4. **Meta**: live app → prod, new test app → dev (recommended; dev loses IG webhooks until the test app exists).
5. **Launch flags**: Mila v2 + voice on, Studio off, `STUDIO_MAX_JOB_USD=5`, `CHAT_RATE_LIMIT_PER_HOUR=60`,
   min 1 / max 10. Confirm or change.
6. **Who holds DNS for `nomila.co`** (registrar / Cloud DNS in another project) — needed for `app.nomila.co`.
7. **Stripe live at launch**, or leave payments unmounted in prod until Connect is ready?
8. **Promotion cadence** during beta (weekly + hotfixes recommended).

## 10. Risks

- PR #360 (prettier, 752 files) conflicts with PRs A–C: agree an order before either merges.
- PR #309's `0034_trend_observations.sql` collides once `0034_workflow_runner.sql` enters the ordered list.
- Enabling PITR may restart the dev instance: off-hours.
- A prod YAML that references a secret that does not exist fails the whole deploy: every prod secret exists
  before the first `services replace`.
- Domain-mapping swap has a certificate re-issue gap (minutes): do it when nobody is demoing v1.
- Dev keeps the live Meta app until the test app exists; the moment prod takes the live app's webhook, dev
  stops receiving IG webhooks.
