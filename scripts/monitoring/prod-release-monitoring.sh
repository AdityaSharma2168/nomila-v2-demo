#!/usr/bin/env bash
#
# prod-release-monitoring.sh — log-based metrics + alert policies for the new research / quick score / Mila (on Mastra)
# release (docs/release/new-research-and-mila-on-tf.md; Mila runs on Mastra only since Nov 2026). OWNER-RUN. Dry run
# by default: it prints every command and writes the metric / policy files to a temp dir, and changes nothing. APPLY=1
# creates or updates for real.
#
#   bash scripts/monitoring/prod-release-monitoring.sh                 # dry run (prints commands + files)
#   VALIDATE=1 bash scripts/monitoring/prod-release-monitoring.sh      # + read-only: run each filter against the last
#                                                                      #   7 days of DEV logs, print the match count
#   APPLY=1 bash scripts/monitoring/prod-release-monitoring.sh         # create/update metrics + policies on prod
#   APPLY=1 SCHEDULER=1 bash ...                                       # + the hourly agent-spend-cron job for prod
#
# What it reads: the pino JSON lines the API already writes (Cloud Run stdout → jsonPayload; pino's numeric `level`,
# NOT `severity`, so filters match jsonPayload.msg / fields), Cloud Run's own request log (httpRequest.*), and the
# hourly spend lines from server/agent/spendCron.ts (agent_runs, by provider). Every metric is scoped to SERVICE.
#
# Google docs for each command:
#   gcloud logging metrics create/update  https://cloud.google.com/sdk/gcloud/reference/logging/metrics/create
#   counter metrics (labels)              https://cloud.google.com/logging/docs/logs-based-metrics/counter-metrics
#   distribution metrics (value extractor, buckets) https://cloud.google.com/logging/docs/logs-based-metrics/distribution-metrics
#   metric config file schema (LogMetric) https://cloud.google.com/logging/docs/reference/v2/rest/v2/projects.metrics
#   query language (filters)              https://cloud.google.com/logging/docs/view/logging-query-language
#   gcloud monitoring policies create/update  https://cloud.google.com/sdk/gcloud/reference/monitoring/policies/create
#   alert policy JSON (conditionThreshold, aggregations) https://cloud.google.com/monitoring/alerts/policies-in-json
#   alignment period / retest window      https://cloud.google.com/monitoring/alerts/concepts-indepth
#   alerting on log-based metrics         https://cloud.google.com/logging/docs/logs-based-metrics/charts-and-alerts
#   Cloud Scheduler HTTP job              https://cloud.google.com/scheduler/docs/creating (via scripts/provision-schedulers.sh)
#
# Notification channel: the existing email channel "Nomila pipeline alerts" (the one the prod 5xx and /health alerts
# use). Override with CHANNEL=projects/<p>/notificationChannels/<id>. Never prints a secret.

set -euo pipefail

PROJECT="${PROJECT:-gamechanger-pocket-agent}"
SERVICE="${SERVICE:-nomila-v2-prod}"
DEV_SERVICE="${DEV_SERVICE:-nomila-v2}"
PROD_URL="${PROD_URL:-https://nomila-v2-prod-241621020090.us-central1.run.app}"
CHANNEL="${CHANNEL:-projects/${PROJECT}/notificationChannels/14855661728889788241}"
APPLY="${APPLY:-0}"
VALIDATE="${VALIDATE:-0}"
SCHEDULER="${SCHEDULER:-0}"
# Thresholds (alert when the value is ABOVE these). Tune after the first week of real traffic.
MILA_P95_MS="${MILA_P95_MS:-60000}"             # Mila (Mastra) turn p95 over 15 min (turn timeout is 240 s)
LEAN_P95_MS="${LEAN_P95_MS:-600000}"            # lean_research p95 over 1 h (step lease is 20 min)
PREFIX="${PREFIX:-release_}"                    # metric name prefix, so these sit together in Metrics Explorer

OUT="$(mktemp -d)"
echo "Project ${PROJECT} · service ${SERVICE} · APPLY=${APPLY} VALIDATE=${VALIDATE} SCHEDULER=${SCHEDULER} · files in ${OUT}"
echo

run() {
  if [ "${APPLY}" = "1" ]; then "$@"; else printf '  WOULD RUN: %s\n' "$*"; fi
}
# A shell string as a JSON string literal (node is on every machine that runs this repo).
json_str() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))'; }

APP="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\""
REQ="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND log_id(\"run.googleapis.com/requests\")"

# ── metric(name, description, filter, [kind], [value_field], [labels-json]) ─────────────────────────────────────────
#   kind counter (default) | distribution (value_field = the jsonPayload / httpRequest field to extract)
metric() {
  local name="${PREFIX}$1" desc="$2" filter="$3" kind="${4:-counter}" value="${5:-}" labels="${6:-}"
  local f="${OUT}/metric-${name}.json"
  local labelDescs="[]" labelExtractors="{}"
  if [ -n "${labels}" ]; then
    # labels: "key=FIELD;key2=FIELD2"
    labelDescs="["; labelExtractors="{"; local first=1
    IFS=';' read -ra pairs <<< "${labels}"
    for p in "${pairs[@]}"; do
      local k="${p%%=*}" v="${p#*=}"
      [ "${first}" = 1 ] || { labelDescs+=","; labelExtractors+=","; }
      labelDescs+="{\"key\":\"${k}\",\"valueType\":\"STRING\"}"
      labelExtractors+="\"${k}\":\"EXTRACT(${v})\""
      first=0
    done
    labelDescs+="]"; labelExtractors+="}"
  fi
  local filterJson; filterJson="$(printf '%s' "${filter}" | json_str)"
  # Distributions: durations in ms (100 ms … ~ hours), spend in USD (1 cent … ~ $100k).
  local unit="ms" scale=100
  case "${value}" in *usd*) unit="USD"; scale=0.01 ;; esac
  if [ "${kind}" = "distribution" ]; then
    cat > "${f}" <<EOF
{
  "name": "${name}",
  "description": "${desc}",
  "filter": ${filterJson},
  "valueExtractor": "EXTRACT(${value})",
  "labelExtractors": ${labelExtractors},
  "metricDescriptor": { "metricKind": "DELTA", "valueType": "DISTRIBUTION", "unit": "${unit}", "labels": ${labelDescs} },
  "bucketOptions": { "exponentialBuckets": { "numFiniteBuckets": 64, "growthFactor": 1.2, "scale": ${scale} } }
}
EOF
  else
    cat > "${f}" <<EOF
{
  "name": "${name}",
  "description": "${desc}",
  "filter": ${filterJson},
  "labelExtractors": ${labelExtractors},
  "metricDescriptor": { "metricKind": "DELTA", "valueType": "INT64", "unit": "1", "labels": ${labelDescs} }
}
EOF
  fi
  echo "metric ${name}: ${desc}"
  if [ "${VALIDATE}" = "1" ]; then
    local devFilter="${filter//service_name=\"${SERVICE}\"/service_name=\"${DEV_SERVICE}\"}"
    local n; n="$(gcloud logging read "${devFilter}" --project="${PROJECT}" --freshness=7d --limit=200 --format='value(insertId)' 2>/dev/null | wc -l | tr -d ' ')"
    echo "  dev matches (7d, max 200): ${n}"
  fi
  if gcloud logging metrics describe "${name}" --project="${PROJECT}" >/dev/null 2>&1; then
    run gcloud logging metrics update "${name}" --project="${PROJECT}" --config-from-file="${f}"
  else
    run gcloud logging metrics create "${name}" --project="${PROJECT}" --config-from-file="${f}"
  fi
}

# ── policy(display, doc, metric, aligner, reducer, window_s, comparison, threshold) ─────────────────────────────────
policy() {
  local display="$1" doc="$2" m="${PREFIX}$3" aligner="$4" reducer="$5" window="$6" threshold="$7"
  local slug; slug="$(printf '%s' "${display}" | tr -c 'A-Za-z0-9' '-' | tr 'A-Z' 'a-z')"
  local f="${OUT}/policy-${slug}.json"
  local docJson; docJson="$(printf '%s' "${doc}" | json_str)"
  local reduce=""
  [ "${reducer}" = "-" ] || reduce=", \"crossSeriesReducer\": \"${reducer}\""
  cat > "${f}" <<EOF
{
  "displayName": "${display}",
  "documentation": { "content": ${docJson}, "mimeType": "text/markdown" },
  "combiner": "OR",
  "conditions": [{
    "displayName": "${display}",
    "conditionThreshold": {
      "filter": "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${m}\"",
      "aggregations": [{ "alignmentPeriod": "${window}s", "perSeriesAligner": "${aligner}"${reduce} }],
      "comparison": "COMPARISON_GT",
      "thresholdValue": ${threshold},
      "duration": "0s",
      "trigger": { "count": 1 }
    }
  }],
  "alertStrategy": { "autoClose": "86400s" },
  "notificationChannels": ["${CHANNEL}"],
  "enabled": true
}
EOF
  echo "policy \"${display}\""
  local existing; existing="$(gcloud monitoring policies list --project="${PROJECT}" --filter="displayName=\"${display}\"" --format='value(name)' 2>/dev/null | head -1)"
  if [ -n "${existing}" ]; then
    run gcloud monitoring policies update "${existing}" --project="${PROJECT}" --policy-from-file="${f}"
  else
    run gcloud monitoring policies create --project="${PROJECT}" --policy-from-file="${f}"
  fi
}

RB="Release checklist: docs/release/new-research-and-mila-on-tf.md"

# Mila runs on Mastra only (TrueForge and the /mcp server retired 9 Nov 2026; their tf_* / mcp_* metrics and policies
# left this script with them: delete any already created by hand). Every Mila turn (chat, chat v2, proactive, waitlist,
# onboarding) runs agent/engine/mastra/turn.ts runMilaTurn, logger module "agent/engine/mastra": one "mastra turn" line
# per turn (status, ms, microUsd, tools, toolErrors) once the turn has run. A failed turn ends status="failed" on that
# line, whether the model call threw (also logged "mastra turn failed") or the stream sent an error chunk (logged on
# that line only), so mila_turn_errors counts the line, not "mastra turn failed". A throw out of runMilaTurn itself
# (before the turn runs: session, pass, admission) writes no "mastra turn" line; it is logged by the caller: "Mila chat
# turn failed" (routes/chat.ts), "chat v2 turn failed" (routes/chatV2.ts), "waitlist Mila turn failed"
# (routes/waitlistMila.ts), all counted. NOT counted: such a throw on proactive (warn "proactive: turn could not run",
# dispatcher.ts; the source's fixed-copy push goes out instead) or onboarding (warn "onboarding: Mila turn did not
# answer…", onboarding/milaTurn.ts; today's turn answers instead): both fall back, so the athlete still gets a reply.
# Tool calls run under the athlete pass (engine/tools/pass.ts); a refused
# pass logs "mastra tool: athlete pass refused" (engine/mastra/tools.ts). There is no engine switch to fall back to:
# rollback is the previous revision, or the surface's own flag (MILA_CHAT_V2, MILA_PROACTIVE, MILA_TF_WAITLIST).
echo "── Mila (Mastra) ──"
metric mila_turn_errors "Mila turns that failed (agent/engine/mastra 'mastra turn' status=failed; 'Mila chat turn failed', 'chat v2 turn failed', 'waitlist Mila turn failed' from the routes), by module" \
  "${APP} AND ((jsonPayload.module=\"agent/engine/mastra\" AND jsonPayload.msg=\"mastra turn\" AND jsonPayload.status=\"failed\") OR jsonPayload.msg=(\"Mila chat turn failed\" OR \"chat v2 turn failed\" OR \"waitlist Mila turn failed\"))" counter "" "module=jsonPayload.module"
metric mila_turn_ms "Mila turn duration, ms (agent/engine/mastra 'mastra turn')" \
  "${APP} AND jsonPayload.module=\"agent/engine/mastra\" AND jsonPayload.msg=\"mastra turn\"" distribution "jsonPayload.ms" "status=jsonPayload.status"
metric mila_pass_failures "Mila tool calls refused for a bad athlete pass (agent/engine/mastra/tools.ts), by code" \
  "${APP} AND jsonPayload.msg=\"mastra tool: athlete pass refused\"" counter "" "code=jsonPayload.code"
policy "Mila: turn errors" "More than 2 failed Mila turns in 10 min: any surface's turn that ran and ended failed (chat, chat v2, proactive, waitlist, onboarding), plus a turn that could not start on chat, chat v2 or the waitlist. One that could not start on proactive or onboarding is not counted here (each falls back: the fixed-copy push, or today's onboarding turn; see their warn lines). No engine switch: roll back to the previous revision, or turn the surface's own flag off. ${RB}" \
  mila_turn_errors ALIGN_SUM REDUCE_SUM 600 2
policy "Mila: turn p95 latency" "p95 of Mila turns over ${MILA_P95_MS} ms for 15 min (the turn timeout is 240 s). ${RB}" \
  mila_turn_ms ALIGN_PERCENTILE_95 - 900 "${MILA_P95_MS}"
policy "Mila: athlete pass failures" "More than 3 refused athlete passes in 10 min: every tool call in those turns fails (NOMILA_MCP_PASS_KEY missing or rotated mid-turn, clock skew, or a forged pass). ${RB}" \
  mila_pass_failures ALIGN_SUM REDUCE_SUM 600 3

echo; echo "── Lean research (LEAN_SIGNUP_RESEARCH) ──"
metric lean_research_failures "lean_research step failures (workflow runner: retry scheduled or run FAILED)" \
  "${APP} AND jsonPayload.module=\"workflow/runner\" AND jsonPayload.step=\"lean_research\" AND jsonPayload.level>=40"
metric lean_research_ms "lean_research duration, ms (agent/lean-research 'lean research')" \
  "${APP} AND jsonPayload.msg=\"lean research\"" distribution "jsonPayload.ms" "outcome=jsonPayload.outcome"
policy "Lean research: failures" "More than 1 lean_research step failure in 30 min. Kill switch: LEAN_SIGNUP_RESEARCH=false (new sign-ups go back to v3/v2; runs already on v4 finish). ${RB}" \
  lean_research_failures ALIGN_SUM REDUCE_SUM 1800 1
policy "Lean research: p95 duration" "p95 of lean_research over ${LEAN_P95_MS} ms over 1 h. ${RB}" \
  lean_research_ms ALIGN_PERCENTILE_95 - 3600 "${LEAN_P95_MS}"

echo; echo "── Quick score (QUICK_SCORE_ONE_CALL) ──"
metric quick_score_failures "quick_score step failures (services/quickScore/step.ts, or the runner)" \
  "${APP} AND (jsonPayload.msg:\"quick score failed\" OR (jsonPayload.module=\"workflow/runner\" AND jsonPayload.step=\"quick_score\" AND jsonPayload.level>=40))"
metric quick_score_results "quick_score outcomes, by status (ready / fallback / …)" \
  "${APP} AND jsonPayload.msg=\"quick score\"" counter "" "status=jsonPayload.status"
policy "Quick score: failures" "More than 2 quick score failures in 30 min (the full score still arrives). Kill switch: QUICK_SCORE_ONE_CALL=false. ${RB}" \
  quick_score_failures ALIGN_SUM REDUCE_SUM 1800 2

echo; echo "── Spend (agent_runs, hourly from /api/internal/agent-spend-cron) ──"
metric agent_spend_over_threshold "A provider's agent_runs spend today (UTC) is at/over AGENT_SPEND_ALERT_USD (server/agent/spendCron.ts)" \
  "${APP} AND jsonPayload.event=\"agent_spend_over_threshold\"" counter "" "provider=jsonPayload.provider"
metric agent_spend_usd "agent_runs spend today (UTC) per provider, USD, hourly sample (for charts)" \
  "${APP} AND jsonPayload.event=\"agent_spend\"" distribution "jsonPayload.usd" "provider=jsonPayload.provider"
policy "Spend: provider over daily threshold" "A provider's model spend today (UTC, from agent_runs) passed AGENT_SPEND_ALERT_USD (default \$50; change with gcloud run services update ${SERVICE} --update-env-vars AGENT_SPEND_ALERT_USD=<n>). Per-athlete caps still hold (AGENT_DAY_COST_CAP_USD, the sign-up daily cap). ${RB}" \
  agent_spend_over_threshold ALIGN_SUM REDUCE_SUM 3600 0

echo; echo "── Sign-up research held (queued) by the caps ──"
metric signup_research_held_long "Sign-up research runs held (queued) longer than HELD_TOO_LONG_DAYS (agent/onboarding/dailyCap.ts, logged at most hourly)" \
  "${APP} AND jsonPayload.event=\"signup_research_held_long\"" counter "" ""
metric signup_research_platform_holds "Sign-up research steps held by the platform day cap instead of failing (workflow/runner.ts holdStep)" \
  "${APP} AND jsonPayload.msg=\"Workflow step HELD by the platform day cap (queued, not failed)\"" counter "" ""
policy "Sign-up research: held over 2 days" "Sign-up research has been queued for more than 2 days: the daily research cap (DAILY_RESEARCH_CAP_USD) or the platform day cap (PLATFORM_DAY_COST_CAP_USD) has had no room for it. Those athletes are on the waitlist with no score yet. Raise the cap that binds, or check platform_spend_cap_reached. ${RB}" \
  signup_research_held_long ALIGN_SUM REDUCE_SUM 3600 0

if [ "${SCHEDULER}" = "1" ]; then
  echo; echo "── Cloud Scheduler: agent-spend-cron-prod (hourly) ──"
  # Same script that declares every job; ONLY= limits it to this one. It strips the secret's CR and never prints it.
  if [ "${APPLY}" = "1" ]; then
    ONLY=agent-spend-cron SERVICE_URL="${PROD_URL}" JOB_SUFFIX=-prod CRON_SECRET_NAME=PROD_CRON_SECRET APPLY=1 \
      bash "$(dirname "$0")/../provision-schedulers.sh"
  else
    echo "  WOULD RUN: ONLY=agent-spend-cron SERVICE_URL=${PROD_URL} JOB_SUFFIX=-prod CRON_SECRET_NAME=PROD_CRON_SECRET APPLY=1 bash scripts/provision-schedulers.sh"
  fi
fi

echo
if [ "${APPLY}" = "1" ]; then
  echo "Done. Metrics count from now on (log-based metrics are not retroactive). Check: Monitoring → Alerting, and"
  echo "  gcloud logging metrics list --project=${PROJECT} --filter='name:${PREFIX}'"
else
  echo "Dry run only (files in ${OUT}). Re-run with APPLY=1 to create/update; add SCHEDULER=1 for the spend job."
fi
