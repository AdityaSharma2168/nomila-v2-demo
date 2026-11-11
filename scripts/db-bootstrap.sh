#!/usr/bin/env bash
#
# db-bootstrap.sh — build a database from another database's SCHEMA plus its reference rows.
#
# This is how production was created on 2026-09-08 (docs/plans/production-environment-split.md,
# B1): a schema-only dump of dev, plus the handful of rows the app cannot run without
# (the drizzle journal so `drizzle-kit migrate` knows what
# is already applied), imported SERVER-SIDE through Cloud Storage. No athlete data moves.
#
# Why `gcloud sql import` and not `psql -f`: a 3,000-line restore over the Auth Proxy from
# a laptop kept losing its connection mid-file (stalls, then "connection reset by peer").
# The import runs inside Cloud SQL and does not depend on the client staying up.
#
# After this, run scripts/db-migrate.sh against the new database (it must be a no-op with a
# clean drift gate), then a scoring smoke test. The migration script is the proof that the
# schema is complete; this script only gets you there faster than replaying history.
#
# Usage:
#   SOURCE_URL=postgresql://postgres:...@localhost:5440/nomila_v2 \
#   TARGET_INSTANCE=nomila-prod-db TARGET_DB=nomila TARGET_USER=nomila_app \
#   bash scripts/db-bootstrap.sh
#
#   Optional: DUMP_BUCKET (default gs://nomila-db-dumps), REFERENCE_TABLES
#   (default "__drizzle_migrations"; scoring_weights was dropped by 0127), PROJECT_ID.
#
# Requires: pg_dump (any recent client), gcloud with Cloud SQL admin + bucket IAM rights.
# TARGET_USER must already exist on TARGET_INSTANCE (a user created with `gcloud sql users
# create` carries cloudsqlsuperuser, which CREATE EXTENSION needs) and owns what is created.

set -euo pipefail

: "${SOURCE_URL:?SOURCE_URL (TCP URL of the source database, e.g. via the Auth Proxy)}"
: "${TARGET_INSTANCE:?TARGET_INSTANCE (Cloud SQL instance name)}"
: "${TARGET_DB:?TARGET_DB (database name on the target instance)}"
: "${TARGET_USER:?TARGET_USER (database user the import runs as)}"
PROJECT_ID="${PROJECT_ID:-gamechanger-pocket-agent}"
DUMP_BUCKET="${DUMP_BUCKET:-gs://nomila-db-dumps}"
REFERENCE_TABLES="${REFERENCE_TABLES:-__drizzle_migrations}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# pg_dump 17+ emits `SET transaction_timeout` (unknown to PG 15) and psql-only
# `\restrict` / `\unrestrict` meta-commands; the server-side importer accepts neither.
sanitize() { grep -vE '^SET (transaction_timeout|idle_in_transaction_session_timeout)|^\\(un)?restrict '; }

echo "1/5  schema-only dump of the source"
pg_dump "${SOURCE_URL}" --schema-only --no-owner --no-privileges | sanitize > "${WORK}/schema.sql"
echo "     $(grep -cE '^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER|FUNCTION|EXTENSION)' "${WORK}/schema.sql") objects"

echo "2/5  reference rows: ${REFERENCE_TABLES}"
TABLE_ARGS=()
for t in ${REFERENCE_TABLES}; do TABLE_ARGS+=(--table="${t}"); done
pg_dump "${SOURCE_URL}" --data-only --no-owner --no-privileges "${TABLE_ARGS[@]}" | sanitize > "${WORK}/reference.sql"
echo "     $(grep -c '^COPY ' "${WORK}/reference.sql") tables"

echo "3/5  upload to ${DUMP_BUCKET}/${TARGET_INSTANCE}/${STAMP}/"
gcloud storage cp "${WORK}/schema.sql" "${WORK}/reference.sql" "${DUMP_BUCKET}/${TARGET_INSTANCE}/${STAMP}/" --project="${PROJECT_ID}" --quiet
# The instance reads the object as its own service account; grant is idempotent.
INSTANCE_SA="$(gcloud sql instances describe "${TARGET_INSTANCE}" --project="${PROJECT_ID}" --format='value(serviceAccountEmailAddress)')"
gcloud storage buckets add-iam-policy-binding "${DUMP_BUCKET}" \
  --member="serviceAccount:${INSTANCE_SA}" --role=roles/storage.objectViewer --project="${PROJECT_ID}" >/dev/null

echo "4/5  import schema into ${TARGET_INSTANCE}/${TARGET_DB} as ${TARGET_USER} (server-side)"
gcloud sql import sql "${TARGET_INSTANCE}" "${DUMP_BUCKET}/${TARGET_INSTANCE}/${STAMP}/schema.sql" \
  --database="${TARGET_DB}" --user="${TARGET_USER}" --project="${PROJECT_ID}" --quiet

echo "5/5  import reference rows"
gcloud sql import sql "${TARGET_INSTANCE}" "${DUMP_BUCKET}/${TARGET_INSTANCE}/${STAMP}/reference.sql" \
  --database="${TARGET_DB}" --user="${TARGET_USER}" --project="${PROJECT_ID}" --quiet

echo
echo "Bootstrapped ${TARGET_INSTANCE}/${TARGET_DB}. Now prove it:"
echo "  CLOUD_SQL_INSTANCE=${PROJECT_ID}:us-central1:${TARGET_INSTANCE} DB_URL_SECRET=<secret> bash scripts/db-migrate.sh"
echo "  (must end with '✅ No drift' and 'Schema migration succeeded'; a second run must change nothing)"
