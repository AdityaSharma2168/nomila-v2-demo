# External reviewer access brief — dev database and GCP runtime

> **Status:** observation and proposal, 10 Sep 2026. Nothing in this document has been
> applied: no IAM binding, database role, instance flag or view was created.
> **This document contains no credentials, connection strings, secret values or keys, by design.**
> Companion: [`plans/production-environment-split.md`](./plans/production-environment-split.md).

Purpose: give an external, read-only reviewer (an AI assistant working through an MCP-style
connector) enough visibility into Nomila's **dev** database and GCP runtime to validate
implementation and deployments independently, without the ability to deploy, mutate, or read
secrets. Prod is out of scope for the first cut and gets the same mechanism later with a smaller
allow-list.

---

## 1. Database

| Question | Answer |
|---|---|
| Provider | Google Cloud SQL for PostgreSQL. No Neon or Supabase in use (a legacy `NEON_ROLLBACK_URL` secret exists and nothing reads it). |
| PostgreSQL version | 15 on every instance. |
| Dev and prod separate? | **Yes, since 8 Sep 2026.** Two instances in the same project: `nomila-v2-db` (dev, database `nomila_v2`) and `nomila-prod-db` (prod, database `nomila`). Prod was bootstrapped from a schema-only dump of dev plus reference rows (scoring weights, migration journal) and holds no user data. Two legacy v1 instances (`gamechanger-db`, `gamechanger-db-dev`) still run and are slated for deletion. |
| How applications connect | Cloud Run reaches both instances through the built-in Cloud SQL connector (Unix socket, annotation `run.googleapis.com/cloudsql-instances`), authenticating with the runtime service account plus a database password held in Secret Manager. GitHub Actions runs migrations through the Cloud SQL Auth Proxy with the same secret. Developers reach dev over its public IP from allow-listed addresses, or through the Auth Proxy. |
| Read-only user exists? | **No.** Dev has one role, the built-in `postgres` superuser, and every connection uses it. Prod has `postgres` and the application user `nomila_app`. No reporting or read-only role exists anywhere. |
| Private networking? | **No.** Neither instance has a private IP or VPC attachment. Dev: public IP, six allow-listed addresses, SSL optional. Prod: public IP, zero allow-listed addresses, SSL required (`ENCRYPTED_ONLY`), so only the connector and the Auth Proxy can reach it. Both have automated backups, point-in-time recovery and deletion protection on. |
| Size and shape | 63 tables in dev, about 30 MB. Migrations: Drizzle journal 0000–0011, then hand-written SQL files 0031–0045 applied by one script (`scripts/db-migrate.sh`), which also carries the legacy inline DDL as `migrations/legacy/01`–`09`. A hard drift gate compares `shared/schema.ts` to the live database on every deploy. |

### 1.1 Sensitive tables and columns — exclude from any external reader

Scanned on dev, 10 Sep 2026. Treat this as a deny-list a reviewer never sees; everything else is
allow-listed explicitly (§3.1), never by wildcard.

| Table / column | Why |
|---|---|
| `connected_accounts.access_token`, `.refresh_token` | Live OAuth tokens for athletes' Gmail, Instagram, TikTok, YouTube, Outlook. The most dangerous data in the database. |
| `card_shares.recipient_token`, `card_share_views.viewer_token` | Bearer tokens that open share cards without login. |
| `inbox_messages.body`, `inbox_threads`, `inbox_senders.email`, `pending_actions.payload` | Brand negotiation email bodies, draft replies, third-party addresses. |
| `chat_messages`, `conversations`, `voice_context`, `athlete_asserted` | Chat and voice transcripts and the athlete's verbatim words. |
| `athletes.email`, `notification_log.body` | Athlete identity and outbound email content. |
| `deals.raw_data`, `media_kits`, `brand_fit_narratives` | Extracted contract and offer text, generated narratives. |
| `payments`, `payment_offers`, `payment_events`, money columns on `deals` | Financial records and Stripe identifiers. |
| `social_analytics_snapshots.raw_metrics` | Provider payloads. Secret-like strings were found in 82 rows and scrubbed on 10 Sep (PR #386); keep it excluded regardless. |
| `media_assets.gcs_path`, `.gcs_thumb_path` | Paths to athlete photos. A reviewer needs counts and statuses, not locations. |
| `workflow_steps.payload` | Designed to hold ids only (8 KB cap) but free-form JSON. Expose `workflow_runs` fully and `workflow_steps` without `payload`. |

---

## 2. GCP

| Area | Current state |
|---|---|
| Project structure | **One project for both environments:** `gamechanger-pocket-agent` (number 241621020090, display name "Nomila"). Dev and prod are separated by resource naming, not by project. Two other projects in the account are unrelated: `gen-lang-client-0922649984` (Gemini default) and `upbeat-airfoil-486622-q2` (OpenClaw). |
| Region | `us-central1` for everything. Multi-region `US` only for the legacy Cloud Build bucket. |
| Cloud Run services | `nomila-v2` (dev, `api-dev.nomila.co`, min 1 / max 3). `nomila-v2-prod` (prod, revision 00001, public, min 1 / max 10, no custom domain yet). Legacy v1: `gamechanger-api-dev`, `gamechanger-api-prod` (still mapped to `api.nomila.co`), `gamechanger-mcp`. Both nomila services run as `gamechanger-runtime@…`, 2 vCPU / 2 GiB, CPU always allocated, 3600 s request timeout. |
| Cloud SQL | `nomila-v2-db` (dev), `nomila-prod-db` (prod), plus the two legacy instances. See §1. |
| Deployment architecture | **GitHub Actions only; no Cloud Build triggers.** `ci-checks` (type-check + hooks lint on PRs). `deploy-dev` (every push to `main`: build the image tagged by commit SHA into Artifact Registry repo `gamechanger`, run `db-migrate.sh` against dev, `gcloud run services replace` from `gcp/cloud-run-dev.yaml`). `deploy-web-dev` (Expo web export to Firebase Hosting site `nomila-dev` plus the landing site). `eas-update-preview` (OTA to the preview channel). `promote` (manual: fast-forward a `production` branch to `main`, tag, dispatch). `deploy-prod` (from the `production` branch: reuse the SHA-tagged image dev built, manual Cloud SQL backup, migrate prod, replace from `cloud-run-prod.yaml`, smoke `/health`, then web and EAS production channel). Prod deploy is meant to gate on a GitHub Environment named `production`; **that environment, the `production` branch and `main` branch protection do not exist yet.** |
| Cloud Scheduler | Seven jobs per environment, HTTP POST with a shared-secret header: inbox sync, Gmail watch renewal, media poster, Instagram token refresh, media enrichment, stale-deal archive, and a one-a-minute workflow tick. Prod jobs carry a `-prod` suffix and are enabled. Five legacy `-dev` jobs still fire at v1. |
| Async plumbing | Pub/Sub topics `nomila-gmail-notifications` and `-prod` with OIDC-authenticated push subscriptions. Cloud Tasks queues `nomila-v2-tasks`, `nomila-prod-tasks`, legacy `nomila-tasks`. Buckets: `nomila-v2-athlete-media`, `nomila-v2-inbox-attachments`, `nomila-v2-media` (dev); `nomila-prod-athlete-media`, `nomila-prod-inbox-attachments` (prod); `nomila-db-dumps` (bootstrap dumps). |
| Logging / monitoring | Cloud Logging default buckets only; no sinks or exports. The server logs structured JSON (pino) with a `pipeline_failure` taxonomy. Monitoring: one uptime check on prod `/health`; three alert policies (prod 5xx rate, prod health failing, inbox pipeline failures) to one email channel. LLM traces go to Langfuse Cloud — on in dev, off in prod pending a data-residency decision. No Error Reporting, no BigQuery export. |
| Secret Manager | About 60 secrets, by category: database URLs and passwords (dev, prod, legacy); cron and voice-service shared secrets (dev/prod pairs); OAuth app credentials (Google, Microsoft, TikTok, Instagram/Meta); Instagram page tokens; model API keys (Anthropic, Moonshot, Gemini, OpenRouter, xAI; a `TAVILY_API_KEY` secret is still stored but no code reads it since web search moved to OpenAI in Nov 2026); LiveKit; Langfuse; Stripe (test); Composio; the Expo token; a Google service-account JSON; a session secret. The runtime service account reads them at deploy time through `secretKeyRef` in the service YAML. |
| IAM / service accounts | `gamechanger-deployer@` (CI): run.admin, cloudsql.admin, artifactregistry.writer, firebase.admin, firebasehosting.admin, iam.serviceAccountUser, cloudbuild.builds.editor, logging.viewer. `gamechanger-runtime@` (both services): aiplatform.user, cloudsql.client, firebaseauth.admin, firebasehosting.admin, secretmanager.secretAccessor, storage.objectAdmin. `gmail-push@` signs Pub/Sub OIDC pushes. Also present: `claude-code-dev@`, `firebase-adminsdk-fbsvc@`, `vertex-express@`, `gamechanger@`, default compute. Humans: one owner; two developers with project-wide editor plus Cloud SQL and Secret Manager roles; one pending owner invitation. |
| Workload Identity Federation | **Yes.** Pool `github-pool`, provider `github-provider`, attribute condition limiting it to `nomila-co/nomila-v2` and `nomila-co/gamechanger`, impersonating `gamechanger-deployer@`. GitHub holds no service-account key. |

---

## 3. Recommended read-only access

Three principles:

1. **Dev only for now.** Prod gets the same mechanism later with a smaller allow-list.
2. **Allow-list by view.** Never grant on base tables; a `review` schema of views projects only safe columns.
3. **No long-lived credential anywhere.** The reviewer authenticates as a service account that has no key.

### 3.1 Database — a `review` schema of views and one IAM-authenticated role

1. **Enable IAM database authentication** on `nomila-v2-db` (flag `cloudsql.iam_authentication=on`;
   setting it **restarts the instance**, so do it off-hours). Create a Google service account, e.g.
   `external-reviewer@gamechanger-pocket-agent.iam.gserviceaccount.com`, with **no key**, and add
   it as a Cloud SQL IAM user on the instance. Connections then use one-hour OAuth tokens minted by
   Google, never a password.
2. **Create a `review` schema** owned by `postgres` containing views over the allow-listed tables,
   projecting only safe columns. The role gets `USAGE` on that schema and `SELECT` on its views, and
   nothing on `public`. Future views inherit through `ALTER DEFAULT PRIVILEGES`.
3. **Harden the role:** `default_transaction_read_only = on`, `statement_timeout = '30s'`,
   `CONNECTION LIMIT 2`, `NOCREATEDB NOCREATEROLE NOINHERIT`.

Allow-list, mapped to the reviewer's goals:

| Goal | Views to expose (safe columns only) |
|---|---|
| Migrations | `__drizzle_migrations`. `information_schema` and `pg_catalog` are readable by any role, so table and column definitions come for free. |
| Intelligence substrate and lineage | `model_params`, `social_identities`, `social_sync_runs`, `social_metric_observations`, `social_features`, `social_audience_distributions`, `social_analytics_snapshots` minus `raw_metrics`, `athlete_snapshots` minus free-text columns. |
| Feature outputs, scores, rates | `scoring_weights`, `athletes_current` (score, capitals, tier, rate card), `golden_athletes`, `athletes` minus `email` and free text (id, status, sport, career_status, created_at), `athlete_affiliations`. |
| Workflow health | `workflow_runs`; `workflow_steps` minus `payload`; `prompts` (key, version, status, hash, timestamps; body optional). |
| Deal pipeline shape, not content | `deals` limited to id, athlete_id, brand_id, status, category, source, direction, created_at, scored_at. `inbox_brands` limited to id, normalized_name, origin. `generation_jobs` limited to id, status, model, cost columns, timestamps. |

Sketch (run as `postgres` on the dev database; column names illustrative — confirm against
`shared/schema.ts` when the views are written):

```sql
CREATE SCHEMA review;

CREATE VIEW review.athletes AS
  SELECT id, status, sport, career_status, created_at FROM public.athletes;

CREATE VIEW review.workflow_steps AS
  SELECT id, run_id, step, status, attempt, started_at, finished_at, error
  FROM public.workflow_steps;

-- ... one view per allow-listed table ...

GRANT USAGE ON SCHEMA review TO "external-reviewer@gamechanger-pocket-agent.iam";
GRANT SELECT ON ALL TABLES IN SCHEMA review TO "external-reviewer@gamechanger-pocket-agent.iam";
ALTER DEFAULT PRIVILEGES IN SCHEMA review
  GRANT SELECT ON TABLES TO "external-reviewer@gamechanger-pocket-agent.iam";

ALTER ROLE "external-reviewer@gamechanger-pocket-agent.iam"
  SET default_transaction_read_only = on;
ALTER ROLE "external-reviewer@gamechanger-pocket-agent.iam"
  SET statement_timeout = '30s';
ALTER ROLE "external-reviewer@gamechanger-pocket-agent.iam" CONNECTION LIMIT 2;
```

### 3.2 GCP — predefined viewer roles on the same keyless service account

Grant these to `external-reviewer@`. None can deploy, change configuration, read a secret value, or
write to a bucket. **Avoid the basic `roles/viewer`:** it includes object read on every bucket,
which is athlete photos and inbox attachments.

| Role | Allows | Does not allow |
|---|---|---|
| `roles/run.viewer` | Services, revisions, traffic split, YAML including plain env values and secret *names*. | Deploy, update, or resolve a `secretKeyRef`. |
| `roles/logging.viewer` | Request and application logs for both services. | Data-access audit logs (`privateLogViewer` is not granted). |
| `roles/monitoring.viewer` | Uptime checks, alert policies, metrics. | Edit or silence alerts. |
| `roles/cloudscheduler.viewer` | Job schedules, targets, last-run status. Header *names* only. | Run, pause or edit a job. |
| `roles/cloudsql.viewer` | Instance settings, flags, backup history, user list. | Connect (that is the IAM DB user above), change flags, export. |
| `roles/artifactregistry.reader` | Which image tags exist, so a revision can be matched to a commit. | Push or delete images. |
| `roles/secretmanager.viewer` | Secret names, versions, timestamps. | Any secret value. **Never grant `secretAccessor`.** |
| `roles/iam.securityReviewer` | Read IAM policies and service accounts, to audit who can deploy. | Change any binding. |
| `roles/serviceusage.serviceUsageConsumer` | Bill API calls to the project (several APIs require it). | Enable or disable APIs. |

Because dev and prod share the project, these roles see prod's Cloud Run configuration and logs
too, read-only. If that is not acceptable, attach an IAM condition on the Cloud Run and Scheduler
bindings restricting `resource.name` to the dev service and dev jobs (both services honour
conditions), or keep the reviewer off the project until prod moves to its own project.

### 3.3 Connecting an external AI reviewer without long-lived credentials

The service account above holds no key. The question is how a reviewer outside Google acts as it.
Three options, in order of preference:

1. **Host a read-only MCP server on Cloud Run that runs as the reviewer service account.** The
   container receives short-lived tokens from the metadata server automatically, so no credential
   is ever exported. Two ready pieces: Google's open-source **MCP Toolbox for Databases** for the
   SQL side, configured with a Cloud SQL Postgres source using IAM authentication and a fixed set
   of parameterised read-only tools against the `review` schema; and a small companion MCP exposing
   a handful of gcloud reads (describe service, list revisions, read logs with a bounded window,
   list scheduler jobs). Put the server behind Cloud Run's own authentication plus an OAuth flow the
   AI product can complete, or at minimum a per-session token you rotate. This is the only option
   where the reviewer can query on its own and nothing durable leaves the project.
2. **Short-lived impersonation tokens, minted by a human.** Grant a person
   `roles/iam.serviceAccountTokenCreator` on the reviewer account only. They run
   `gcloud auth print-access-token --impersonate-service-account=external-reviewer@…`, which
   yields a one-hour token, and hand it to the reviewer for a session. Simple, auditable, expires on
   its own. Good for one-off deep checks, tedious for daily use.
3. **Periodic read-only exports.** A scheduled job dumps the `review` views and a Cloud Run
   description to a bucket the reviewer reads through a signed URL. No live access at all. Weakest
   for validation work, strongest isolation.

**Whatever the path, log it.** Turn on Data Access audit logs for Cloud SQL and Cloud Run for the
reviewer principal, and enable `pgaudit` (or at least `log_statement=all`) for the reviewer role on
dev. The point of a read-only reviewer is trust; the audit trail is what lets you keep it.

---

## 4. Not done in this brief

No IAM binding, database role, flag, or view was created. Everything above is observation and
proposal. The two prerequisites with side effects are the Cloud SQL flag change (restarts the dev
instance) and the choice of connection path (decides whether anything gets hosted).
