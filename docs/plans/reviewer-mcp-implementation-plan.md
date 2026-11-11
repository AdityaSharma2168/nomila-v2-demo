# Reviewer MCP — implementation plan (dev only, read-only)

> **Status:** plan, for approval. Nothing applied. Written 10 Sep 2026 against the live dev
> database and project. Supersedes the access section of [`../reviewer-access-brief.md`](../reviewer-access-brief.md)
> where the two differ.
> **Contains no credentials, connection strings or secret values.**

## 0. What was approved, and the constraints this plan honours

| Constraint | How it is met |
|---|---|
| Cloud Run read-only MCP; no credentials issued or exported | The MCP server runs on Cloud Run as its own keyless service account. The external reviewer never holds a GCP identity, key, token or connection string. It holds an OAuth session to the MCP endpoint that a named operator opens by signing in with Google. |
| Dev only | Every resource the server can touch is named in its config: `nomila-v2-db` / `nomila_v2`, Cloud Run service `nomila-v2`, the seven dev scheduler jobs, one log view, one Artifact Registry repository. Nothing prod-named is reachable. |
| No generic project-wide GCP browsing | No tool lists services, jobs, instances, secrets or buckets. IAM is bound at resource level (service, repository, log view, single secret) or with `resource.name` conditions, never a bare project-wide viewer role. |
| No Secret Manager access initially | The reviewer gets no Secret Manager tool and no Secret Manager role. The server's own service account gets `secretAccessor` on exactly two secrets that belong to the server (its DB password and its OAuth signing key), bound per secret, never at project level. |
| DB via `review.*` views only; nothing on `public` | A dedicated Postgres role owns no objects, has `USAGE` on schema `review` only, `SELECT` on its views only, and is explicitly `REVOKE`d from `public`. |
| `raw_source_payloads.payload` not exposed | The view carries lineage metadata only (§2.3, view 14). A sanitized-preview tool is specified but **not built** in this plan (§3.4). |
| DB hardening preserved | `default_transaction_read_only=on`, `statement_timeout='30s'`, `CONNECTION LIMIT 2`, `NOCREATEDB NOCREATEROLE NOINHERIT NOSUPERUSER NOREPLICATION`. |
| No IAM DB auth, no dev restart during Step 1b | The role is a built-in Postgres role with a generated password held in Secret Manager. Creating a role and a schema does not restart Cloud SQL. IAM DB auth is a later swap (§7). `pgaudit` (needs a flag → restart) is replaced by per-role `log_statement` (no restart). |

---

## 1. Identities and trust boundaries

```
ChatGPT connector ──OAuth 2.1 (PKCE)──▶ nomila-review-mcp (Cloud Run, app-layer auth)
                                            │ runs as nomila-review-mcp@ (no key)
                                            ├─▶ Cloud SQL connector ──▶ nomila-v2-db / nomila_v2  as role review_reader  (review.* only)
                                            ├─▶ Cloud Run Admin API   ──▶ service nomila-v2 (get, revisions.list)
                                            ├─▶ Cloud Logging         ──▶ log view nomila-v2-dev (entries.list)
                                            ├─▶ Cloud Scheduler       ──▶ 7 named dev jobs (get)
                                            └─▶ Artifact Registry     ──▶ repo gamechanger, image nomila-v2 (tags)
```

| Identity | Kind | Holds | Never holds |
|---|---|---|---|
| **External reviewer** (ChatGPT) | OAuth client of the MCP server | A short-lived access token to the MCP endpoint, obtained after a named operator signs in with Google | Any GCP IAM role, service-account key, DB password, or Secret Manager access |
| **Operator** (Mia, optionally Aaron) | Google account on an allow-list | The ability to open a reviewer session by signing in | Nothing new; existing project roles unchanged |
| `nomila-review-mcp@gamechanger-pocket-agent.iam.gserviceaccount.com` | Service account, **no keys** | The resource-scoped roles in §4 | Project-wide viewer, Secret Manager beyond its two secrets, any write role |
| `review_reader` | Postgres role on `nomila-v2-db` | `USAGE` on `review`, `SELECT` on `review.*` | Anything on `public`; DDL; write; login from anywhere but the connector |

---

## 2. Database: schema `review`, role `review_reader`

Applied by a human as `postgres` over the Auth Proxy. File: `migrations/review/001_review_schema.sql`
(kept outside `migrations/` proper so `db-migrate.sh` and the drift gate — which reads
`information_schema.columns where table_schema='public'` only — never see it). Idempotent
(`CREATE OR REPLACE VIEW`, `DO $$ … IF NOT EXISTS` for the role). No instance restart.

### 2.1 Role

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'review_reader') THEN
    CREATE ROLE review_reader LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 2
      PASSWORD '<generated at apply time, 32 bytes base64, stored only in Secret Manager NOMILA_REVIEW_DB_PASSWORD>';
  END IF;
END $$;

ALTER ROLE review_reader SET default_transaction_read_only = on;
ALTER ROLE review_reader SET statement_timeout = '30s';
ALTER ROLE review_reader SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE review_reader SET search_path = review;
ALTER ROLE review_reader SET log_statement = 'all';        -- audit without pgaudit / restart

-- Nothing on public, explicitly.
REVOKE ALL ON SCHEMA public FROM review_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM review_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM review_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM review_reader;
-- The default PUBLIC grant of CREATE/USAGE on schema public is already removed in PG15 for
-- CREATE; USAGE remains for PUBLIC. review_reader is NOINHERIT and gets no table grants, so
-- USAGE on public alone reveals nothing. Verified in §6 dry run.
```

### 2.2 Schema and grants

```sql
CREATE SCHEMA IF NOT EXISTS review AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA review TO review_reader;
-- views are created below, then:
GRANT SELECT ON ALL TABLES IN SCHEMA review TO review_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA review GRANT SELECT ON TABLES TO review_reader;
```

Views are plain (not `SECURITY DEFINER`); Postgres checks the view owner's (`postgres`) rights on
the base tables, which is what lets the role read through the view and nothing else.

### 2.3 The views — exact columns

Column names are the live dev columns as of 10 Sep 2026 (`information_schema`). **Excluded**
columns are listed so the omission is a decision, not an accident.

| # | View | Columns exposed | Excluded (and why) |
|---|---|---|---|
| 1 | `review.migrations` ← `__drizzle_migrations` | `id, hash, created_at` | — |
| 2 | `review.athletes` ← `athletes` | `id, status, sport, school, division, conference, plan, segment, goal_archetype, career_status, created_at, claimed_at, enriched_at, media_rights_ack_at` | `full_name, first_name, last_name, email, auth_provider, auth_id, stripe_customer_id, photo_url, socials, referral_code, brand_voice, secondary_goals, deal_preferences` (identity, auth, payment, free text) |
| 3 | `review.athletes_current` ← `athletes_current` | `athlete_id, latest_snapshot_id, display_score, tier, internal_score, capitals, pav, deal_type_rates, rate_card, ig_followers, tk_followers, x_followers, yt_subscribers, spotify_listeners, achievements_count, press_count, brand_mentions_count, score_updated_at, social_updated_at, research_updated_at, updated_at` | `story_arc, brand_stories, insights` (generated narrative text) |
| 4 | `review.athlete_affiliations` ← `athlete_affiliations` | all: `id, athlete_id, org_name, org_kind, level, conference, role, position, started_on, ended_on, is_primary, kind, source, asserted_id, created_at, updated_at` | — (`asserted_id` is an id only) |
| 5 | `review.athlete_snapshots` ← `athlete_snapshots` | `id, athlete_id, created_at, trigger, google_trends_score, gdelt_article_count, score, sources, as_of, engine_version` | `research, social, deals, first_look` (free text, provider blobs, model output) |
| 6 | `review.scoring_weights` ← `scoring_weights` | all: `id, version, status, config, created_at` | — |
| 7 | `review.golden_athletes` ← `golden_athletes` | `id, athlete_id, ground_truth_pav, ground_truth_source, active` | `notes` |
| 8 | `review.model_params` ← `model_params` | all: `id, family, version, schema_version, status, config, hash, note, created_by, created_at, activated_at` | — |
| 9 | `review.social_identities` ← `social_identities` | `id, athlete_id, platform, account_id, account_id_kind, handle, canonical_url, handle_history, source_class, source_method, confidence, status, connected_account_id, discovered_at, last_verified_at, created_at` | `evidence` (may embed scraped page text) |
| 10 | `review.social_sync_runs` ← `social_sync_runs` | `id, athlete_id, identity_id, platform, provider, endpoint_family, api_version, source_class, trigger, status, started_at, finished_at, pages, items, connected_account_id, created_at, error_code := error->>'code', error_message := left(error->>'message', 200)` | `pagination_state` (opaque provider cursors), raw `error` (may embed response bodies) |
| 11 | `review.social_metric_observations` ← `social_metric_observations` | all 23 columns (`id … payload_id, created_at`) | — (numeric and ids only) |
| 12 | `review.social_features` ← `social_features` | all 18 columns including `inputs` (lineage references) | — |
| 13 | `review.social_audience_distributions` ← `social_audience_distributions` | all 20 columns | — |
| 14 | `review.raw_source_payloads` ← `raw_source_payloads` | `id, sync_run_id, athlete_id, platform, provider, endpoint_family, page_index, source_class, payload_hash, bytes, sanitizer_version, fetched_at, retained_until, created_at` | **`payload`** (the approved exclusion), **`request`** (URLs and headers) |
| 15 | `review.social_analytics_snapshots` ← `social_analytics_snapshots` | all except one: `id, athlete_id, connected_account_id, platform, snapshot_date, snapshot_day, followers, following, post_count, total_likes, total_channel_views, is_verified, reach, impressions, profile_views, avg_engagement_rate, avg_reach_per_post, avg_views_per_post, avg_shares_per_post, avg_saves_per_post, avg_watch_time_sec, content_frequency, top_audience_country, top_audience_city, top_audience_age_range, top_audience_gender, posts_last_30d, source, created_at` | `raw_metrics` |
| 16 | `review.workflow_runs` ← `workflow_runs` | `id, athlete_id, process, definition_version, status, current_step, started_at, finished_at, created_by, idempotency_key, active_scope, last_error := left(last_error, 300)` | `input` (free-form JSON) |
| 17 | `review.workflow_steps` ← `workflow_steps` | `id, run_id, step, ordinal, attempt, kind, status, mode, trace_id, ready_at, lease_until, started_at, finished_at, created_at, error := left(error, 300)` | `input, output` |
| 18 | `review.prompts` ← `prompts` | `id, key, version, status, hash, note, created_by, created_at, published_at` | `body` (prompt IP; can be added later as its own view) |
| 19 | `review.deals` ← `deals` | `id, athlete_id, brand_id, broker_brand_id, brand_name, deal_type, status, source, direction, deal_group_id, saved, payment_status, deposit_status, detected_at, created_at` | `amount, amount_cash, amount_product, commission_pct, term_start, term_end, raw_data, negotiation_state, pending_action` (money and negotiation content) |
| 20 | `review.inbox_brands` ← `inbox_brands` | `id, name, normalized_name, domain, category, brand_tier, is_agency, origin, created_at, enriched_at` | `description, audience_summary, sport_categories, known_athlete_partnerships, enrichment, logo_url, image_url, images` |
| 21 | `review.generation_jobs` ← `generation_jobs` | `id, athlete_id, brand_id, origin, mode, objective, deliverable, status, provider, model, cost_estimated_usd, cost_basis, created_at, started_at, completed_at, updated_at, last_error := left(last_error, 300)` | `brief, source_asset_id` |

Not in the schema at all, and therefore unreachable: `connected_accounts`, `inbox_messages`,
`inbox_threads`, `inbox_senders`, `pending_actions`, `chat_messages`, `conversations`,
`voice_context`, `athlete_asserted`, `notification_log`, `media_assets`, `media_kits`,
`brand_fit_narratives`, `card_shares`, `card_share_views`, `payments*`, `agent_actions`,
`studio_generation_previews`, and every other `public` table.

### 2.4 Verification queries (run as `review_reader` in the §6 dry run)

```sql
SELECT count(*) FROM review.athletes;                       -- works
SELECT * FROM public.athletes LIMIT 1;                      -- permission denied
SELECT * FROM athletes LIMIT 1;                             -- resolves to review.athletes via search_path
SELECT payload FROM review.raw_source_payloads LIMIT 1;     -- column does not exist
CREATE TABLE review.x (a int);                              -- permission denied
INSERT INTO review.scoring_weights VALUES (…);              -- cannot execute INSERT in a read-only transaction
SELECT pg_sleep(60);                                        -- canceled by statement_timeout
```

---

## 3. The MCP server

### 3.1 Shape

- Path in repo: `tools/review-mcp/` (own `package.json`, own Dockerfile). Node 20, TypeScript,
  `@modelcontextprotocol/sdk` (Streamable HTTP transport), `pg`, `googleapis`, `pgsql-parser`
  (libpg_query bindings, for SELECT-only validation). No dependency on `server/`.
- Cloud Run service `nomila-review-mcp`, `us-central1`, min 0 / max 2, 1 vCPU / 512 MiB, request
  timeout 60 s, ingress `all`, invoker `allUsers` (authentication is the OAuth layer in §5; Cloud
  Run IAM cannot be used because the reviewer has no Google identity). Runs as
  `nomila-review-mcp@`. Annotation `run.googleapis.com/cloudsql-instances: gamechanger-pocket-agent:us-central1:nomila-v2-db`.
- Env: `DB_SOCKET_DIR=/cloudsql`, `DB_INSTANCE=gamechanger-pocket-agent:us-central1:nomila-v2-db`,
  `DB_NAME=nomila_v2`, `DB_USER=review_reader`, `DB_PASSWORD` ← secret `NOMILA_REVIEW_DB_PASSWORD`,
  `OAUTH_SIGNING_KEY` ← secret `NOMILA_REVIEW_OAUTH_SIGNING_KEY`, `OAUTH_GOOGLE_CLIENT_ID`,
  `OAUTH_GOOGLE_CLIENT_SECRET` ← secret (the Google sign-in client for operators), `ALLOWED_OPERATORS`
  (comma-separated emails), `RUN_SERVICE=nomila-v2`, `LOG_VIEW=projects/gamechanger-pocket-agent/locations/global/buckets/_Default/views/nomila-v2-dev`,
  `SCHEDULER_JOBS=inbox-cron-sync,gmail-watch-renew,media-poster-cron,ig-token-refresh,media-enrich-cron,archive-stale-cron,workflow-tick`,
  `AR_REPO=projects/gamechanger-pocket-agent/locations/us-central1/repositories/gamechanger`, `AR_IMAGE=nomila-v2`.
  Every GCP resource the server can name is an env value; there is no discovery code path.

### 3.2 Guardrails applied to every tool

| Guardrail | Value |
|---|---|
| Rows per result | ≤ 500 (server appends/enforces `LIMIT`) |
| Response size | ≤ 256 KB, truncated with a marker |
| Statement timeout | 30 s (role) and 25 s (client `statement_timeout` on the connection) |
| Concurrency | pool size 2, matching `CONNECTION LIMIT 2` |
| Rate | 60 tool calls per minute per session, 600 per hour |
| Redaction on text output | regex pass over log lines and error strings: emails → `<email>`, `Bearer …`/`ya29.…`/`sk-…`/`EAAB…` → `<token>` |
| Audit | one structured log line per call: `{tool, params, operator_email, session_id, rows, ms, ok}` to stdout → Cloud Logging. DB side: `log_statement=all` on the role. |
| Denied by construction | any non-SELECT SQL, any relation outside `review`, any tool not listed below |

### 3.3 Tools — exact list

**Database (all against `review.*`)**

| Tool | Params | Returns | Notes |
|---|---|---|---|
| `db_list_views` | — | view name, columns, types (from `information_schema.columns where table_schema='review'`) | Discovery is limited to the review schema. |
| `db_query` | `sql` (string), `limit` (≤500, default 100) | rows | Validated before execution: parsed with `pgsql-parser`; must be exactly one `SelectStmt` (CTEs allowed); every `RangeVar` must resolve to schema `review` (unqualified names are resolved via the role's `search_path=review`); rejects `INTO`, `FOR UPDATE/SHARE`, `LOCK`, function calls from a deny-list (`pg_sleep`, `pg_read_file`, `lo_*`, `dblink*`, `set_config`, `current_setting`). The role's privileges are the real guard; the parser is defense in depth and a better error message. |
| `db_table_counts` | — | row count per review view | Fixed query. |
| `db_migrations` | — | `review.migrations` rows plus the list of `migrations/*.sql` file names baked into the image at build time | Lets the reviewer compare journal to files without repo access. |
| `db_athlete_scores` | `athlete_id` (uuid) | `athletes_current` row + latest `athlete_snapshots.score` + active `scoring_weights.version` + active `model_params` rows | Fixed parameterised joins. |
| `db_feature_lineage` | `feature_id` (bigint) | the `social_features` row, its `inputs`, the referenced `social_metric_observations`, their `social_sync_runs`, and `raw_source_payloads` **metadata** rows | Fixed parameterised joins; the payload column is not in the view so cannot leak. |
| `db_sync_run` | `sync_run_id` (uuid) | the run, its observation count, distribution count, payload metadata rows | Fixed. |

**GCP (named dev resources only)**

| Tool | Params | Returns | IAM used |
|---|---|---|---|
| `run_describe_service` | — | for `nomila-v2`: latest ready revision, traffic split, image URI, scaling, env var **names**; plain values shown only for names matching the flag allow-list (`MILA_*, STUDIO_*, LANGFUSE_TRACING, PROMPT_REGISTRY, SOCIAL_*, ENABLE_TEST_PAGE, ADMIN_OPEN_ACCESS, LOG_LEVEL, NODE_ENV, *_URL, *_ORIGINS, *_BUCKET, *_TOPIC`); `secretKeyRef` rendered as `secret:<name>` | `run.services.get` on the service |
| `run_list_revisions` | `limit` (≤20) | revision name, created, image tag, ready condition, traffic % | `run.revisions.list` scoped to the service |
| `run_read_logs` | `minutes` (≤1440), `min_severity`, `contains` (substring), `limit` (≤200) | log entries from the log view, redacted | `logging.logEntries.list` with `resourceNames=[LOG_VIEW]` |
| `scheduler_list_jobs` | — | for the seven named jobs: schedule, state, last attempt time and status code, target path (headers stripped) | `cloudscheduler.jobs.get` ×7 |
| `artifacts_image_tags` | `limit` (≤20) | tags and digests for `nomila-v2` newest first | `artifactregistry.tags.list` on the repo |
| `health_check` | — | GET `https://api-dev.nomila.co/health` body and latency | none (public endpoint) |

No tool: lists services, jobs, instances, buckets, secrets; reads any secret; describes Cloud SQL
(would need project-wide `cloudsql.viewer`; deferred, see §8); touches anything with `prod` in
its name.

### 3.4 Specified but not built: `db_payload_preview`

If the reviewer later needs to see the *shape* of a raw payload: a `SECURITY DEFINER` function
`review.payload_preview(payload_id uuid)` owned by `postgres` that returns, for one row, the
top-level JSON keys, per-key value types, array lengths and total bytes — never values. Exposed as
one tool with a per-session cap of 50 calls. Requires a separate approval; nothing in this plan
grants `review_reader` execute on it.

---

## 4. IAM: exact grants and conditions

All bindings target `serviceAccount:nomila-review-mcp@gamechanger-pocket-agent.iam.gserviceaccount.com`.
Order matters only for the log view (create before binding).

| # | Role | Scope | Command (dry-run form) | Why |
|---|---|---|---|---|
| 1 | — | create SA, no key | `gcloud iam service-accounts create nomila-review-mcp --display-name="Review MCP (read-only, dev)"` | Identity for the server. Never run `keys create`. |
| 2 | `roles/cloudsql.client` | project | `gcloud projects add-iam-policy-binding … --role=roles/cloudsql.client` | Required by the Cloud SQL connector. Cloud SQL has no resource-level IAM and does not support conditions; this permits *connecting* to any instance in the project, but every connection still needs a database password, and the server only holds `review_reader`'s. Accepted and documented. |
| 3 | `roles/run.viewer` | **service `nomila-v2`** | `gcloud run services add-iam-policy-binding nomila-v2 --region=us-central1 --member=… --role=roles/run.viewer` | Service-level binding; nothing else in Cloud Run is visible. **Dry run must confirm `revisions.list` works under a service-level binding**; fallback is a project-level binding with condition `resource.name.startsWith("projects/gamechanger-pocket-agent/locations/us-central1/services/nomila-v2")`. |
| 4 | — | create log view | `gcloud logging views create nomila-v2-dev --bucket=_Default --location=global --log-filter='resource.type="cloud_run_revision" AND resource.labels.service_name="nomila-v2"'` | A view is the narrowest logging boundary available. |
| 5 | `roles/logging.viewAccessor` | **that view only** (project binding with condition) | `gcloud projects add-iam-policy-binding … --role=roles/logging.viewAccessor --condition='title=nomila-v2-dev-view-only,expression=resource.name == "projects/gamechanger-pocket-agent/locations/global/buckets/_Default/views/nomila-v2-dev"'` | Reads dev service logs and nothing else; prod logs, audit logs, other services excluded. |
| 6 | `roles/cloudscheduler.viewer` | project binding with condition on the 7 job names | `--condition='title=dev-jobs-only,expression=resource.name.startsWith("projects/gamechanger-pocket-agent/locations/us-central1/jobs/") && !resource.name.endsWith("-prod") && !resource.name.endsWith("-dev")'` (excludes the `-prod` set and the five legacy `-dev` jobs) | **Dry run must confirm Scheduler honours `resource.name` conditions on `jobs.get`**; fallback is to drop `scheduler_list_jobs` from v1. |
| 7 | `roles/artifactregistry.reader` | **repository `gamechanger`** | `gcloud artifacts repositories add-iam-policy-binding gamechanger --location=us-central1 --member=… --role=roles/artifactregistry.reader` | Repo-level; sees tags, cannot push. |
| 8 | `roles/secretmanager.secretAccessor` | **secret `NOMILA_REVIEW_DB_PASSWORD` only** | `gcloud secrets add-iam-policy-binding NOMILA_REVIEW_DB_PASSWORD --member=… --role=roles/secretmanager.secretAccessor` | The server's own DB password, mounted via `secretKeyRef`. |
| 9 | `roles/secretmanager.secretAccessor` | **secret `NOMILA_REVIEW_OAUTH_SIGNING_KEY` only**, and `NOMILA_REVIEW_OAUTH_GOOGLE_CLIENT_SECRET` only | same form | The server's token-signing key and its Google sign-in client secret. |
| 10 | `roles/run.invoker` | service `nomila-review-mcp`, member `allUsers` | `gcloud run services add-iam-policy-binding nomila-review-mcp --member=allUsers --role=roles/run.invoker` | The endpoint is reachable; §5 authenticates. |
| 11 | deploy | reuse `gamechanger-deployer@` via existing WIF in a manual `deploy-review-mcp.yml` | — | No new deploy identity. Deployer already holds `run.admin` and `artifactregistry.writer`. |

**Not granted, deliberately:** `roles/viewer`, `roles/logging.viewer`, `roles/run.viewer` at project
level, `roles/cloudsql.viewer`, any `secretmanager.*` at project level, `roles/monitoring.viewer`
(no tool needs it in v1), `roles/iam.securityReviewer`.

Recommended alongside (not required): project-level org policy
`constraints/iam.disableServiceAccountKeyCreation` so no one can later mint a key for this SA.

---

## 5. Authentication flow

The server is an MCP **resource server** and, for simplicity, its own **authorization server**,
following the MCP authorization specification (OAuth 2.1, PKCE, protected-resource metadata).
Upstream identity is Google sign-in restricted to `ALLOWED_OPERATORS`.

1. **Registration (once, by the operator).** The ChatGPT connector is configured with the MCP
   URL `https://nomila-review-mcp-<hash>-uc.a.run.app/mcp`. If the connector form asks for a
   client id and secret, a pre-registered client is used: the client id is public and the client
   secret lives in `NOMILA_REVIEW_OAUTH_CLIENT_SECRET` (server-side); the operator pastes it into
   the connector once. This secret grants nothing by itself — a session still requires step 3. If
   the connector supports Dynamic Client Registration, the server accepts it and no secret is
   pasted anywhere. **Verify which mode the ChatGPT connector offers at setup time; both are
   implemented.**
2. **Discovery.** Unauthenticated requests get `401` with `WWW-Authenticate` pointing at
   `/.well-known/oauth-protected-resource`, which points at `/.well-known/oauth-authorization-server`
   on the same host.
3. **Authorization.** ChatGPT opens `/oauth/authorize` (PKCE). The server redirects to Google
   sign-in (OIDC, `openid email`). On return it checks the email against `ALLOWED_OPERATORS`, then
   issues an authorization code bound to the PKCE challenge.
4. **Tokens.** `/oauth/token` exchanges the code for an access token (JWT, HS256 with
   `OAUTH_SIGNING_KEY`, **60 minutes**, audience = this server, claims: operator email, session id)
   and a rotating refresh token (**24 hours**, single-use, replay detected → session revoked).
   Nothing is stored server-side except a small in-memory map of outstanding codes and refresh
   token hashes; a restart simply forces re-consent.
5. **Calls.** Every MCP request carries `Authorization: Bearer <access token>`. The server
   verifies signature, expiry and audience, then runs the tool as `nomila-review-mcp@` / `review_reader`.
   The operator email is stamped on every audit line.
6. **Revocation.** Remove the email from `ALLOWED_OPERATORS` and redeploy (refresh stops
   working within 24 h; access within 60 min), or rotate `NOMILA_REVIEW_OAUTH_SIGNING_KEY` to
   revoke everything immediately.

What the reviewer ends up holding: a 60-minute bearer to one endpoint, refreshed as long as the
operator stays on the allow-list. No GCP token, no key, no DB credential ever leaves the project.

---

## 6. Rollout: dry run, apply, verify, roll back

Every step is reversible and none restarts Cloud SQL.

| Step | Action | Verify | Roll back |
|---|---|---|---|
| A | Create secrets `NOMILA_REVIEW_DB_PASSWORD`, `NOMILA_REVIEW_OAUTH_SIGNING_KEY`, `NOMILA_REVIEW_OAUTH_GOOGLE_CLIENT_SECRET` (values generated locally, never printed) | `gcloud secrets versions list` shows one version each | delete secrets |
| B | Apply `migrations/review/001_review_schema.sql` as `postgres` over the Auth Proxy (`BEGIN … ROLLBACK` first, per the migration dry-run rule) | §2.4 queries as `review_reader` over the proxy; `\dn+ review`, `\dp review.*` | `DROP SCHEMA review CASCADE; DROP ROLE review_reader;` |
| C | Create SA + bindings 2–9 | `gcloud projects get-iam-policy … --filter="bindings.members:nomila-review-mcp"` shows only the listed roles; `gcloud iam service-accounts keys list` shows none | remove bindings, delete SA |
| D | Build and deploy `nomila-review-mcp` with min 0 and **`ALLOWED_OPERATORS` empty** | service boots; `/health` 200; `/mcp` returns 401 | delete service |
| E | Dry-run the GCP tools with a one-off `gcloud auth print-access-token --impersonate-service-account=nomila-review-mcp@` from an owner's laptop (never exported) against the API paths the tools use — this is where bindings 3 and 6 are confirmed or their fallbacks chosen | `run_describe_service`, `run_list_revisions`, `run_read_logs`, `scheduler_list_jobs`, `artifacts_image_tags` all succeed; the same calls against `nomila-v2-prod`, a `-prod` job and prod logs all `403` | adjust bindings |
| F | Set `ALLOWED_OPERATORS` to one email, connect from ChatGPT, run each tool once | audit lines appear in Cloud Logging with the operator email; Postgres log shows statements as `review_reader` | empty the allow-list |
| G | Hand over | reviewer runs its first validation | — |

---

## 7. Later, once Step 1b acceptance is done

- **Swap to IAM database authentication**: set `cloudsql.iam_authentication=on` (restart, off-hours),
  add `nomila-review-mcp@` as an IAM DB user, move `review_reader`'s grants to that principal, drop
  the password secret and binding 8. Nothing else changes.
- **Prod**: same server image, second service `nomila-review-mcp-prod` with prod-named config, a
  smaller view list (no `deals`, no `generation_jobs` initially), separate approval.
- **`db_payload_preview`** (§3.4) if asked for.
- **Cloud SQL metadata tool** if wanted, which would need project-wide `roles/cloudsql.viewer` and is
  therefore a separate decision.

---

## 8. Open items to confirm during the dry run

1. `roles/run.viewer` bound at service level covers `revisions.list` (expected yes; fallback in §4 row 3).
2. Cloud Scheduler honours `resource.name` IAM conditions on `jobs.get` (fallback: drop the tool).
3. Which OAuth mode the ChatGPT connector uses (pre-registered client vs Dynamic Client Registration).
4. `pgsql-parser` builds on the Node 20 slim image (native module); fallback is the pure-JS
   `pg-query-emscripten` or a stricter allow-list of prepared statements only.
5. `REVOKE ALL ON SCHEMA public` leaves PUBLIC's default `USAGE`; confirm `\dp public.*` shows no
   grant to `review_reader` and the §2.4 denial holds.
