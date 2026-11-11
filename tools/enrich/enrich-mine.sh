#!/usr/bin/env bash
# enrich-mine.sh — read ONE athlete's whole library (photos and videos) through her LOCAL server, and nobody else's
# (PR 20, docs/probes/ship.md item 7, ADI-S20-GO). Local only: it touches no shared code and runs nothing in the cloud.
#
#   bash tools/enrich/enrich-mine.sh --email you@example.com --dry-run   # counts, quote and cap; sends nothing
#   bash tools/enrich/enrich-mine.sh --email you@example.com             # then asks "Proceed? (y/N)" and loops
#   bash tools/enrich/enrich-mine.sh --athlete <uuid>                    # skip the email lookup
#
# What it guarantees:
#   * ONE athlete. Her id comes from a read-only lookup by her login email (or --athlete); no id, no run. Every request
#     body carries that athleteId — the endpoint without one would read EVERY athlete's rows on the shared dev database.
#   * LOCAL ONLY. The server URL must be http://localhost or http://127.0.0.1 (default http://localhost:8080). The cloud
#     services run their own 15-minute cron; this is for a laptop.
#   * NO SECRET PRINTED. The cron secret (CRON_SECRET, else INTERNAL_CRON_SECRET, as server/index.ts reads them) and
#     DATABASE_URL are read from .env into variables; the secret reaches curl through a 0600 header file, never argv.
#   * READ-ONLY LOOKUPS. The id and the counts run under default_transaction_read_only.
#   * BOUNDED CALLS. Each POST is {athleteId, maxTicks: 1} — one pass: up to 20 photos (services/mediaEnrichment.ts), and,
#     with STUDIO_VIDEO_ENRICH on in the server, up to 8 clips under STUDIO_VIDEO_ENRICH_MAX_RUN_USD (default $2).
#   * STOPS on any error, and on a pass that makes no progress while rows remain — which is what the daily cap
#     (STUDIO_ENRICH_DAILY_CAP_USD) or the run cap looks like from outside; the server log names which.
#
# The quote (printed before anything is sent) uses the code's own figures, pinned by scripts/enrichMine.test.ts:
#   a photo  ≈ one Flash tag $0.0048 (studio/enrich/retag.ts RETAG_USD_PER_ROW) + one embed $0.0001 (studio/qa/cost.ts)
#   a clip   ≈ (700 + 132·s) input tokens × $1.5/M + (400 + 40·s) output tokens × $9/M (studio/enrich/config.ts);
#            a clip with no measured duration is quoted at 60 s, as the code quotes it.
#
# For tests (scripts/enrichMine.test.ts, with a fixture env file and stub psql / curl first on PATH):
#   ENV_FILE=<path>        the env file to read instead of ./.env
#   ENRICH_MINE_TRACE=1    set -x. A trace prints every variable — the cron secret included — so it is REFUSED
#                          against the real ./.env and only runs with an ENV_FILE pointing somewhere else.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT}/.env}"
if [ "${ENRICH_MINE_TRACE:-}" = "1" ]; then
  if [ "${ENV_FILE}" = "${ROOT}/.env" ]; then
    echo "enrich-mine: refusing to trace against ${ENV_FILE} — a trace prints the secret" >&2
    exit 1
  fi
  set -x
fi

PHOTO_USD="0.0049"          # 0.0048 tag + 0.0001 embed
CLIP_FIXED_USD="0.00465"    # 700 × 1.5e-6 + 400 × 9e-6
CLIP_PER_SEC_USD="0.000558" # 132 × 1.5e-6 + 40 × 9e-6
UNKNOWN_CLIP_SECONDS=60

die() { echo "enrich-mine: $*" >&2; exit 1; }

EMAIL="" ATHLETE="" DRY=0 URL="http://localhost:8080"
while [ $# -gt 0 ]; do
  case "$1" in
    --email)   EMAIL="${2:-}"; shift 2 ;;
    --athlete) ATHLETE="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --url)     URL="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (use --email <login email> or --athlete <uuid>, optionally --dry-run)" ;;
  esac
done

[ -n "${EMAIL}${ATHLETE}" ] || die "refusing to run without one athlete: pass --email <login email> or --athlete <uuid>"
[ -z "${EMAIL}" ] || [ -z "${ATHLETE}" ] || die "pass --email OR --athlete, not both"
if ! printf '%s' "${URL}" | grep -Eq '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?/?$'; then
  die "refusing a non-local server URL (${URL}) — this runs against your laptop's server only"
fi
URL="${URL%/}"
[ -f "${ENV_FILE}" ] || die "no .env at ${ENV_FILE}"

# One value from .env, quotes and surrounding whitespace stripped, and any CR/LF deleted — a value saved with a CRLF
# ending sends "\r" inside the header and every call 401s (ADI-S20-SCHED, INTERNAL_CRON_SECRET). Never echoed.
# `|| true` because an ABSENT key is an answer here, not an error: under `set -e -o pipefail` a grep that matched
# nothing failed the whole assignment and ended the script with no message (the first test run, 25 Sep 2026).
env_value() {
  { grep -E "^[[:space:]]*$1=" "${ENV_FILE}" || true; } | tail -1 | cut -d= -f2- | tr -d '\r\n' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
SECRET="$(env_value CRON_SECRET)"
[ -n "${SECRET}" ] || SECRET="$(env_value INTERNAL_CRON_SECRET)"
[ -n "${SECRET}" ] || die "neither CRON_SECRET nor INTERNAL_CRON_SECRET is in ${ENV_FILE}"
DB_URL="${DATABASE_URL:-$(env_value DATABASE_URL)}"
[ -n "${DB_URL}" ] || die "no DATABASE_URL in the environment or ${ENV_FILE}"
CAP="$(env_value STUDIO_ENRICH_DAILY_CAP_USD)"

# Read-only SQL, variables bound by psql (stdin, so :'var' is interpolated).
ro_sql() {
  PGOPTIONS='-c default_transaction_read_only=on' psql "${DB_URL}" -X -q -At -v ON_ERROR_STOP=1 \
    -v UNKNOWN="${UNKNOWN_CLIP_SECONDS}" "$@"
}

if [ -n "${EMAIL}" ]; then
  IDS="$(ro_sql -v email="${EMAIL}" <<'SQL'
select id from athletes where lower(email) = lower(:'email');
SQL
)" || die "the athlete lookup failed (is the Cloud SQL proxy running?)"
  N="$(printf '%s' "${IDS}" | grep -c . || true)"
  [ "${N}" = "1" ] || die "expected exactly one athlete with that email, found ${N} — nothing sent"
  ATHLETE="${IDS}"
fi
printf '%s' "${ATHLETE}" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
  || die "not an athlete id: ${ATHLETE}"

# The three counts, her rows only — the photo lane's candidates (mediaEnrichment.ts UNENRICHED + the chunk's clauses),
# the video lane's (videoEnrichment.ts VIDEO_UNTAGGED + conds, with seconds for the quote), and the rows set down.
counts() {
  ro_sql -F '|' -v me="${ATHLETE}" <<'SQL'
select
  (select count(*) from media_assets
    where athlete_id = :'me' and status = 'stored' and parent_media_id is null and origin <> 'reference'
      and (metadata->'vision' is null or metadata->'embedding' is null)
      and metadata->'enrichment'->>'abandoned_at' is null
      and (gcs_thumb_path is not null or coalesce(content_type,'') not like 'video/%')),
  (select count(*) from media_assets
    where athlete_id = :'me' and status = 'stored' and parent_media_id is null and origin <> 'reference'
      and coalesce(content_type,'') like 'video/%' and gcs_thumb_path is not null and gcs_path is not null
      and deleted_at is null and metadata->'vision'->'beats' is null
      and metadata->'enrichment'->>'abandoned_at' is null),
  (select coalesce(sum(coalesce(duration_seconds_precise, duration_seconds, :UNKNOWN)), 0) from media_assets
    where athlete_id = :'me' and status = 'stored' and parent_media_id is null and origin <> 'reference'
      and coalesce(content_type,'') like 'video/%' and gcs_thumb_path is not null and gcs_path is not null
      and deleted_at is null and metadata->'vision'->'beats' is null
      and metadata->'enrichment'->>'abandoned_at' is null),
  (select count(*) from media_assets
    where athlete_id = :'me' and metadata->'enrichment'->>'abandoned_at' is not null);
SQL
}
ROW="$(counts)" || die "the count query failed"
# CLIP_SECS, never bash's SECONDS: that variable keeps counting up from whatever is assigned to it, so a quote printed
# a second later read one clip-second more (CI, 25 Sep 2026: "10 s" printed as "11 s").
IFS='|' read -r PHOTOS CLIPS CLIP_SECS SETDOWN <<EOF
${ROW}
EOF

QUOTE="$(python3 -c "print(f'{$PHOTOS*$PHOTO_USD + $CLIPS*$CLIP_FIXED_USD + $CLIP_SECS*$CLIP_PER_SEC_USD:.4f}')")"
echo "athlete        ${ATHLETE}"
echo "photos left    ${PHOTOS}      (≈ \$${PHOTO_USD} each — the photo lane has NO dollar cap)"
echo "clips left     ${CLIPS}      (${CLIP_SECS} s; ≈ \$${CLIP_FIXED_USD} each + \$${CLIP_PER_SEC_USD}/s — needs STUDIO_VIDEO_ENRICH on in the server)"
echo "set down       ${SETDOWN}      (never retried by either lane)"
echo "quote          ≈ \$${QUOTE}"
if [ -n "${CAP}" ]; then
  echo "daily cap      STUDIO_ENRICH_DAILY_CAP_USD=${CAP} (per athlete per UTC day, video lane; as .env sets it — the server must have been started with this .env)"
else
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "!!  STUDIO_ENRICH_DAILY_CAP_USD IS NOT SET in ${ENV_FILE}: the video lane has NO daily cap."
  echo "!!  Set it (dev uses 5) and restart the server before running without --dry-run."
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
fi

if [ "${DRY}" = "1" ]; then
  echo "dry run — nothing sent."
  exit 0
fi

printf 'Proceed? (y/N) '
read -r ANSWER || ANSWER=""
case "${ANSWER}" in y|Y) ;; *) echo "nothing sent."; exit 0 ;; esac

HDR="$(mktemp)"
trap 'rm -f "${HDR}"' EXIT
chmod 600 "${HDR}"
printf 'x-cron-secret: %s\ncontent-type: application/json\n' "${SECRET}" > "${HDR}"
BODY="{\"athleteId\":\"${ATHLETE}\",\"maxTicks\":1}"

PREV=""
PASS=0
while :; do
  PASS=$((PASS + 1))
  OUT="$(curl -sS -X POST -H @"${HDR}" -w '\n%{http_code}' --data "${BODY}" "${URL}/api/internal/media-enrich-cron")" \
    || die "pass ${PASS}: the request failed (is the server running at ${URL}?)"
  CODE="$(printf '%s' "${OUT}" | tail -1)"
  JSON="$(printf '%s' "${OUT}" | sed '$d')"
  [ "${CODE}" = "200" ] || die "pass ${PASS}: HTTP ${CODE} — stopping"
  read -r OK REMAINING TAGGED EMBEDDED FAILED <<EOF
$(printf '%s' "${JSON}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("ok"), d.get("remaining"), d.get("tagged",0), d.get("embedded",0), d.get("failed",0))')
EOF
  [ "${OK}" = "True" ] || die "pass ${PASS}: the server did not answer ok — stopping"
  echo "pass ${PASS}: tagged ${TAGGED}, embedded ${EMBEDDED}, failed ${FAILED}, remaining ${REMAINING}"
  [ "${FAILED}" = "0" ] || die "pass ${PASS}: ${FAILED} failed — stopping (the server log names each asset and reason)"
  [ "${REMAINING}" = "0" ] && { echo "done — nothing left for this athlete."; exit 0; }
  if [ "${TAGGED}" = "0" ] && [ "${EMBEDDED}" = "0" ] && [ "${REMAINING}" = "${PREV}" ]; then
    die "pass ${PASS}: no progress with ${REMAINING} left — the daily cap or the run cap (the server log says which). Stopping."
  fi
  PREV="${REMAINING}"
done
