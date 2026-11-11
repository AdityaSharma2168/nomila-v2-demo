#!/bin/bash
# Populates .env from GCP Secret Manager for local development.
#
# Requires: gcloud CLI authenticated to the gamechanger-pocket-agent project.
# Safe to re-run: it MERGES, so running it twice is a no-op and running it after you have
# added a key by hand does not take that key away.
#
# ── WHY THIS WAS REWRITTEN (2026-09-02) ──────────────────────────────────────
# The previous version had three faults, two of them silent:
#
#   1. It could not run at all. It looked for NOMILA_V2_DATABASE_URL_TCP or
#      NOMILA_V2_DB_PASSWORD; neither is in Secret Manager. Only NOMILA_V2_DATABASE_URL
#      is — the socket-form URL Cloud Run uses — so the script exited 1 before writing
#      anything, for everyone.
#
#   2. It DESTROYED hand-added keys. It ended with `} > "$ENV_FILE"`, which truncates.
#      Anything not in its fetch list vanished. On the machine this was found on that was
#      four keys, two of which — WAVESPEED_API_KEY and YOKU_API_KEY — exist nowhere else
#      and would have been gone for good. Nothing in the old header warned about this;
#      it read as "refresh your .env", not "replace it".
#
#   3. It PATCHED PRODUCTION on every run, adding the machine's current public IP to the
#      Cloud SQL authorized-networks list and never removing one. Every laptop, café and
#      hotel it was ever run from is still an opening to a database holding signed
#      contracts. That is now opt-in (--authorize-ip) rather than a side effect of asking
#      for environment variables.
#
# ── THE DATABASE URL ─────────────────────────────────────────────────────────
# The stored secret is the SOCKET form, which only works inside Cloud Run:
#   postgresql://postgres:PASS@/nomila_v2?host=/cloudsql/PROJECT:REGION:INSTANCE
# Local development reaches the same instance through the Cloud SQL Auth Proxy, so the
# credentials are reused and only the host is rewritten:
#   postgresql://postgres:PASS@127.0.0.1:5440/nomila_v2
#
# The proxy is the intended path and authenticates by IAM identity, which is why the
# authorized-networks patching is no longer automatic: with the proxy running, no IP needs
# to be on that list at all. Start it first, in another terminal:
#
#   npm run dev:proxy
#
# Override the address with DB_PROXY_HOSTPORT if you run the proxy on another port.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

DB_PROXY_HOSTPORT="${DB_PROXY_HOSTPORT:-127.0.0.1:5440}"
AUTHORIZE_IP=0
[ "${1:-}" = "--authorize-ip" ] && AUTHORIZE_IP=1

fetch() {
  gcloud secrets versions access latest --secret="$1" 2>/dev/null
}

echo "Fetching secrets from Secret Manager..."

# ── The database URL: reuse the stored credentials, rewrite the host ──────────
DB_SOCKET_URL="$(fetch NOMILA_V2_DATABASE_URL)"
if [ -z "$DB_SOCKET_URL" ]; then
  echo "ERROR: NOMILA_V2_DATABASE_URL is not in Secret Manager (or you lack access)." >&2
  echo "       Check: gcloud secrets versions access latest --secret=NOMILA_V2_DATABASE_URL" >&2
  exit 1
fi

# Parsed with shell expansion rather than python3, which is not present on every machine
# this runs on (Git Bash on Windows has none). Input shape is fixed and produced by us.
_rest="${DB_SOCKET_URL#postgresql://}"     # postgres:PASS@/nomila_v2?host=/cloudsql/...
_userinfo="${_rest%%@*}"                   # postgres:PASS
_after="${_rest#*@}"                       # /nomila_v2?host=/cloudsql/...
DB_USER="${_userinfo%%:*}"
DB_PASS="${_userinfo#*:}"
_path="${_after#*/}"                       # nomila_v2?host=/cloudsql/...
DB_NAME="${_path%%\?*}"                    # nomila_v2

if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then
  echo "ERROR: could not parse NOMILA_V2_DATABASE_URL into user/database." >&2
  echo "       Expected postgresql://USER:PASS@/DB?host=/cloudsql/... " >&2
  exit 1
fi

DB_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_PROXY_HOSTPORT}/${DB_NAME}"

# ── Optional: authorize this machine's IP for a DIRECT connection ─────────────
# Only with --authorize-ip, and only when you cannot use the proxy. This widens access to
# a production database permanently — the list is never pruned — so it should be a
# decision, not a side effect. Prefer `npm run dev:proxy`.
if [ "$AUTHORIZE_IP" = "1" ]; then
  CURRENT_IP="$(curl -sf https://api.ipify.org || true)"
  if [ -n "$CURRENT_IP" ]; then
    EXISTING="$(gcloud sql instances describe nomila-v2-db \
      --format="value(settings.ipConfiguration.authorizedNetworks[].value)" 2>/dev/null | tr ';' ',')"
    if echo "$EXISTING" | grep -q "$CURRENT_IP"; then
      echo "IP $CURRENT_IP already authorized."
    else
      echo "Adding $CURRENT_IP to Cloud SQL authorized networks (permanent until pruned by hand)..."
      gcloud sql instances patch nomila-v2-db \
        --authorized-networks="${EXISTING:+$EXISTING,}${CURRENT_IP}/32" --quiet
    fi
  fi
fi

# ── The keys this script owns ────────────────────────────────────────────────
# Secret Manager is the source of truth for these and they are overwritten on every run.
# Anything in .env that is NOT listed here is preserved untouched — see the merge below.
MANAGED_KEYS=(
  EXPO_PUBLIC_API_URL DATABASE_URL API_BASE_URL WEB_APP_URL
  GOOGLE_SERVICE_ACCOUNT_JSON SESSION_SECRET GEMINI_API_KEY
  GOOGLE_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET_WEB INTERNAL_CRON_SECRET
  MICROSOFT_CLIENT_ID MICROSOFT_CLIENT_SECRET MICROSOFT_REDIRECT_URI
  MOONSHOT_API_KEY ANTHROPIC_API_KEY
  LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_BASE_URL
  INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET INSTAGRAM_LOGIN_APP_ID INSTAGRAM_LOGIN_APP_SECRET
  META_WEBHOOK_VERIFY_TOKEN DISCOVERY_IG_TOKEN DISCOVERY_IG_BUSINESS_ID
  IG_PAGE_ACCESS_TOKEN IG_BUSINESS_ACCOUNT_ID
  TIKTOK_CLIENT_KEY TIKTOK_CLIENT_SECRET
  VERTEX_AI_PROJECT VERTEX_AI_LOCATION YOUTUBE_DATA_API_KEY
  LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET
  NOMILA_MCP_PASS_KEY
)

MANAGED_FILE="$(mktemp)"
PRESERVED_FILE="$(mktemp)"
OUT_FILE="$(mktemp)"
trap 'rm -f "$MANAGED_FILE" "$PRESERVED_FILE" "$OUT_FILE"' EXIT

{
  echo "EXPO_PUBLIC_API_URL=http://localhost:8080"
  # The server has no dev-host fallback (server/lib/baseUrls.ts): without these a local
  # boot warns and uses localhost, and a production boot refuses to start. Local values
  # point at this machine so a laptop never talks to Cloud Run by accident.
  echo "API_BASE_URL=http://localhost:8080"
  echo "WEB_APP_URL=http://localhost:8081"
  echo "DATABASE_URL=${DB_URL}"
  # GOOGLE_SERVICE_ACCOUNT_JSON is one line by contract — newlines would break .env parsing.
  #
  # SINGLE-QUOTED, and that is not cosmetic. Unquoted, dotenv stops the value at the first
  # whitespace, so this blob arrives as the single character "{" and every consumer that
  # JSON.parses it dies at startup — mediaStore.ts:22 is the one that actually kills
  # `npm run server:dev`. Quoting is safe here because service-account JSON contains double
  # quotes but never a single one.
  printf "GOOGLE_SERVICE_ACCOUNT_JSON='%s'\n" "$(fetch GOOGLE_SERVICE_ACCOUNT_JSON | tr -d '\n')"
  for key in "${MANAGED_KEYS[@]}"; do
    case "$key" in
      EXPO_PUBLIC_API_URL|DATABASE_URL|API_BASE_URL|WEB_APP_URL|GOOGLE_SERVICE_ACCOUNT_JSON) continue ;;
    esac
    printf '%s=%s\n' "$key" "$(fetch "$key")"
  done
} > "$MANAGED_FILE"

# ── Merge: keep every key this script does not own ───────────────────────────
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    [ "$key" = "$line" ] && continue          # not a KEY=VALUE line
    keep=1
    for managed in "${MANAGED_KEYS[@]}"; do
      [ "$key" = "$managed" ] && { keep=0; break; }
    done
    [ "$keep" = "1" ] && printf '%s\n' "$line" >> "$PRESERVED_FILE"
  done < "$ENV_FILE"
fi

cat "$MANAGED_FILE" > "$OUT_FILE"
if [ -s "$PRESERVED_FILE" ]; then
  {
    echo ""
    echo "# ── Not managed by setup-dev-env.sh — preserved from your existing .env ──"
    echo "# These are not in Secret Manager. If one matters to anyone but you, put it"
    echo "# there and add it to MANAGED_KEYS, or it exists only on this machine."
    cat "$PRESERVED_FILE"
  } >> "$OUT_FILE"
fi

# Written atomically: a failure above leaves the previous .env exactly as it was, rather
# than half-rewritten. This is why the whole file is built in a temp first.
mv "$OUT_FILE" "$ENV_FILE"
trap 'rm -f "$MANAGED_FILE" "$PRESERVED_FILE"' EXIT

MANAGED_COUNT="$(wc -l < "$MANAGED_FILE" | tr -d ' ')"
PRESERVED_COUNT="$([ -s "$PRESERVED_FILE" ] && wc -l < "$PRESERVED_FILE" | tr -d ' ' || echo 0)"
echo "Done — .env written: ${MANAGED_COUNT} managed, ${PRESERVED_COUNT} preserved."
echo "Database goes through the Cloud SQL Auth Proxy at ${DB_PROXY_HOSTPORT} — start it with: npm run dev:proxy"
