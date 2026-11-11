#!/usr/bin/env bash
#
# db-migrate.sh — THE schema path. Development and production both run this, and
# nothing else touches the schema.
#
# WHY THIS EXISTS
#
# Until 2026-09-08 the schema reached the database three different ways: a ~150-statement
# inline `psql -c` block in deploy.yml, a handful of migration files listed by hand in the
# same workflow, and files applied from a laptop that no deploy ever repeated. Three
# deploys failed on 7 Sep because the inline block re-created a check constraint without
# the value a hand-applied file had added — the two paths were fighting. A production
# environment built from that recipe would have been missing tables (prompts,
# workflow_runs, workflow_steps) and failed its own drift gate.
#
# This script is one ordered recipe. Every step is idempotent, so it converges a fresh
# database, a restored one, and a current one to the same shape. Order matters and is
# explicit — no globs.
#
#   1. migrations/legacy/*.sql   the former inline DDL, extracted verbatim, in its old order
#   2. drizzle-kit migrate       the journal (0000–0011)
#   3. migrations/00NN_*.sql     hand-written files that are NOT in the journal (0031–0103),
#                                in numeric order — including the five that no deploy step
#                                ever ran before (0033–0036, 0038_deal_deliverables)
#   4. checkSchemaDrift.ts       HARD GATE: a schema.ts column missing from the DB breaks
#                                every insert and bare select on that table
#
# (A former step 4, createTriggers.ts, re-installed the v1 `tasks` LISTEN/NOTIFY trigger on
# every deploy; 0089_drop_v1_tasks drops the table, the trigger and its function, and the
# step is gone.)
#
# (A former step 6, backfillBrandIdentityWrite.ts, re-ran a one-time, marker-guarded brand
# backfill on every deploy and created the inbox_brands_bak / threads_brand_bak /
# deals_brand_bak rollback snapshots; 0093_drop_brand_backfill_bak_tables drops those and the
# step is gone. The brand_identity_backfill_marker table it wrote is left in place.)
#
# The re-baseline (docs/plans/production-environment-split.md, Track D) will collapse
# steps 1 and 3 into one generated 0000_baseline and leave step 2 alone here.
#
# USAGE
#
#   Direct (a local proxy, a scratch database, a restore rehearsal):
#     DATABASE_URL=postgresql://user:pass@localhost:5440/nomila_v2 bash scripts/db-migrate.sh
#
#   CI (starts the Cloud SQL Auth Proxy, reads the socket-form URL from Secret Manager):
#     CLOUD_SQL_INSTANCE=gamechanger-pocket-agent:us-central1:nomila-v2-db \
#     DB_URL_SECRET=NOMILA_V2_DATABASE_URL bash scripts/db-migrate.sh
#
#   Production is the same call with nomila-prod-db and NOMILA_PROD_DATABASE_URL.
#
# The GitHub workflow that calls this must keep its `run:` block free of ${{ }}
# expressions: a single expression anywhere in a large run block makes GitHub compile the
# whole block as one expression and trip the 21000-char limit (0 jobs, no error).

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="${PROJECT_ID:-gamechanger-pocket-agent}"
PROXY_PORT="${PROXY_PORT:-5432}"
PROXY_VERSION="${PROXY_VERSION:-2.14.1}"
PROXY_PID=""

cleanup() {
  if [ -n "${PROXY_PID}" ]; then
    echo "Stopping Cloud SQL Auth Proxy..."
    kill "${PROXY_PID}" 2>/dev/null || true
    wait "${PROXY_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── Connection ──────────────────────────────────────────────────────────────────
if [ -z "${DATABASE_URL:-}" ]; then
  : "${CLOUD_SQL_INSTANCE:?set DATABASE_URL directly, or CLOUD_SQL_INSTANCE + DB_URL_SECRET for the proxy path}"
  : "${DB_URL_SECRET:?set DB_URL_SECRET (the Secret Manager name of the socket-form DATABASE_URL)}"

  PROXY_BIN="${PROXY_BIN:-./cloud-sql-proxy}"
  if [ ! -x "${PROXY_BIN}" ]; then
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64)  PLATFORM=linux.amd64 ;;
      Darwin-arm64)  PLATFORM=darwin.arm64 ;;
      Darwin-x86_64) PLATFORM=darwin.amd64 ;;
      *) echo "ERROR: no Cloud SQL Auth Proxy build known for $(uname -s)-$(uname -m); set PROXY_BIN" >&2; exit 1 ;;
    esac
    PROXY_URL="https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v${PROXY_VERSION}/cloud-sql-proxy.${PLATFORM}"
    echo "Downloading Cloud SQL Auth Proxy v${PROXY_VERSION} (${PLATFORM})..."
    curl -fsSL "${PROXY_URL}" -o "${PROXY_BIN}"
    chmod +x "${PROXY_BIN}"
  fi

  echo "Starting Cloud SQL Auth Proxy for ${CLOUD_SQL_INSTANCE} on :${PROXY_PORT}..."
  "${PROXY_BIN}" "${CLOUD_SQL_INSTANCE}" --port="${PROXY_PORT}" &
  PROXY_PID=$!
  for i in $(seq 1 15); do
    if nc -z localhost "${PROXY_PORT}" 2>/dev/null; then echo "Proxy ready after ${i}s"; break; fi
    sleep 1
  done
  nc -z localhost "${PROXY_PORT}" || { echo "ERROR: proxy did not become ready in 15s" >&2; exit 1; }

  echo "Fetching ${DB_URL_SECRET} from Secret Manager..."
  SOCKET_URL="$(gcloud secrets versions access latest --secret="${DB_URL_SECRET}" --project="${PROJECT_ID}")"
  # The secret holds the Cloud Run socket form (postgresql://u:p@/db?host=/cloudsql/...);
  # rebuild it as a TCP URL against the proxy.
  DATABASE_URL="$(python3 -c "import urllib.parse,sys; u=urllib.parse.urlparse(sys.argv[1]); db=u.path.lstrip('/') or 'postgres'; pwd=urllib.parse.quote(u.password or '',safe=''); print('postgresql://'+u.username+':'+pwd+'@localhost:'+sys.argv[2]+'/'+db)" "${SOCKET_URL}" "${PROXY_PORT}")"
fi
export DATABASE_URL

run_sql() {   # run_sql [psql flags] -f file
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 "$@"
}

# ── 1. Legacy DDL (the former inline block), in its original order ───────────────
echo "── 1/4 legacy DDL (idempotent, pre-journal) ──"
run_sql -f migrations/legacy/01_extensions.sql
# The dedup DELETE and the unique index it makes room for must commit together; the
# old code (still live while this runs) could otherwise land a duplicate in between.
run_sql --single-transaction -f migrations/legacy/02_inbox_dedup.sql
run_sql -f migrations/legacy/03_additive.sql
run_sql -f migrations/legacy/04_brand_deal_spine.sql
run_sql -f migrations/legacy/05_pitch_anchoring.sql
run_sql -f migrations/legacy/06_content_tables.sql
run_sql -f migrations/legacy/07_deal_periods.sql
run_sql -f migrations/legacy/08_studio_generation.sql
# The media_assets <-> generation_jobs FK cycle + publish-gate triggers, applied from the
# same file the PGlite suite uses so there is no second copy to drift.
run_sql -f server/studio/sql/generationGuards.sql
run_sql -f migrations/legacy/09_payments.sql

# ── 2. The journal ───────────────────────────────────────────────────────────────
echo "── 2/4 drizzle-kit migrate (journal 0000–0011) ──"
npm run db:migrate

# ── 3. Hand-written migrations outside the journal, numeric order ────────────────
# Each file is IF NOT EXISTS / DROP-then-ADD / NOT EXISTS-guarded and re-runs safely.
# 0038_deal_deliverables used to be duplicated as an inline block; the file is now the
# only copy. 0040 was 0038_weights_v7_1 (renumbered: two files carried 0038; 0040 and 0042 — the scoring_weights
# v7.1/v7.2 inserts — were deleted with the table by 0127, legacy retirement), and
# 0056_studio_video_jobs was 0040 on studio-video-foundation (renumbered: 0040 was taken).
# Two files carry 0071 (0071_connection_identity from main, 0071_outreach_plans from the Brain stack; both
# already applied on dev when they met). They touch unrelated tables, so both keep their names and the list
# runs them in name order.
echo "── 3/4 hand-written migrations 0031–0103 ──"
for f in \
  0031_pr151_hardening \
  0032_studio_preview_approval \
  0033_prompt_registry \
  0034_workflow_runner \
  0035_first_look \
  0036_workflow_active_scope \
  0037_athlete_asserted \
  0038_deal_deliverables \
  0039_asserted_source_settings \
  0041_athlete_affiliations \
  0043_intelligence_foundations \
  0044_social_substrate \
  0045_social_sync_runs_trigger_stories \
  0046_research_substrate \
  0047_research_planner \
  0048_athlete_index \
  0049_athletes_auth_id_unique \
  0050_affiliations_fact_id \
  0051_identity_users \
  0052_identity_claim_sessions \
  0053_research_evidence_v2 \
  0054_studio_sessions \
  0055_mia_evaluator_service \
  0056_studio_video_jobs \
  0057_studio_stitch_jobs \
  0058_media_assets_duration_precise \
  0059_studio_publish_jobs \
  0060_studio_brand_profiles \
  0061_studio_plans \
  0062_media_assets_origin_reference \
  0063_objectives \
  0064_studio_edit_previews \
  0065_objective_run_events \
  0066_studio_plan_memory \
  0067_identity_profile \
  0068_objective_evidence_as_seen \
  0069_objective_lineage \
  0070_objective_deferral \
  0071_connection_identity \
  0071_outreach_plans \
  0072_creative_intents \
  0073_campaigns \
  0074_campaign_lifecycle_amendment3 \
  0075_outcome_observation_links \
  0076_brain_substrate \
  0077_intelligence_requests \
  0079_objective_change_assessed \
  0080_identity_resolution \
  0081_research_runs_query_id \
  0082_research_identity_sources \
  0083_identity_intelligence_attempts \
  0084_opportunities \
  0085_outlook_subscriptions \
  0086_inbox_messages_body_sha256 \
  0087_financial_ledger_records \
  0088_drop_inbox_threads_score \
  0089_drop_v1_tasks \
  0090_drop_onboarding_sessions_brand_api_keys \
  0091_drop_athletes_current_brand_stories_insights \
  0092_drop_v1_orphan_tables \
  0093_drop_brand_backfill_bak_tables \
  0094_deals_signed_at \
  0095_payments_checkout_expires_at \
  0096_shop_her_picks \
  0097_payments_brand_confirm_token \
  0098_payments_refunds_disputes \
  0099_bookings \
  0100_shop_shopify_catalog \
  0101_public_card \
  0102_bookings_flow \
  0103_partner_intake \
  0104_ask_mila \
  0105_agent_harness \
  0106_agent_onboarding \
  0113_memory_facts_care_kind \
  0114_memory_briefs_display \
  0115_memory_facts_topic_source_type \
  0116_atmosphere_imagery \
  0117_memory_fact_reviews_history_actions \
  0118_plan_step \
  0119_memory_display_gaps \
  0120_atmosphere_library \
  0121_public_page_stats \
  0122_athlete_other_sports \
  0123_chat_messages_agent_cards \
  0124_athlete_agent_onboarding_required \
  0125_content_playbooks \
  0126_drop_athletes_current_legacy_score_columns \
  0127_drop_snapshot_score_and_scoring_weights \
  0128_notification_type_drop_score_milestone \
  0129_email_signin_codes \
  0130_push_notifications \
  0131_media_review_items \
  0132_athlete_rate_ranges \
  0133_deal_reads \
  0135_push_mila_suggestion \
  0136_brand_books \
  0137_offers_time_zone \
  0138_oauth_connect_states \
  0139_athlete_signup_flags \
  0140_drop_retired_intelligence_tables \
  0141_mila_tf_chat \
  0143_mila_proactive \
  0144_agent_run_approval_state \
  0145_account_deletion_two_phase \
  0146_mila_choices \
  0147_mastra_engine \
  0148_workflow_step_lease \
  0149_brand_book_overrides \
  0150_platform_spend_indexes \
  0151_media_rights_attestations \
  0152_mila_voice_settings \
  0153_group_sessions \
  0154_sessions_safety \
  0155_offer_availability \
; do
  echo "   ${f}"
  run_sql -f "migrations/${f}.sql"
done

# ── 4. Drift gate — HARD ─────────────────────────────────────────────────────────
# Fails ONLY on breaking drift (a table or column in schema.ts missing from the DB).
# Stale DB-only columns still exit 0 (STRICT stays unset).
echo "── 4/4 schema drift gate (HARD — breaking drift fails the deploy) ──"
npx tsx server/scripts/checkSchemaDrift.ts

echo "Schema migration succeeded"
