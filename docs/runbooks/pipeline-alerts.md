# Runbook — Gmail pipeline failure alerts

The inbox pipeline emits a structured log line on every failure it can't self-heal:

```json
{ "event": "pipeline_failure", "kind": "<kind>", ... }
```

`kind` is one of:

| kind | meaning | where |
|------|---------|-------|
| `token_refresh` | a Gmail connection's token refresh failed definitively; the connection was marked `expired` (user must reconnect) | `server/lib/integrations/gmail.ts` |
| `webhook_drop` | one or more push messages failed `detectDeal` and were dead-lettered for cron retry | `server/routes/webhooks.ts` |
| `dead_letter_exhausted` | a dead-lettered message failed its last retry and was given up on | `server/lib/integrations/gmail.ts` |
| `watch_renew` | a Gmail push watch failed to renew (realtime detection will lapse for that user) | `server/lib/gmailWatchRenew.ts` |
| `draft_stream_timeout` / `chat_stream_timeout` | a Vertex stream stalled and was aborted | `server/routes/deals.ts`, `chat.ts` |
| `draft_leak` | a negotiate draft leaked a confidential figure and was regenerated/refused | `server/routes/deals.ts` |
| `config` | a required/expected env var is unset (e.g. `GMAIL_PUBSUB_TOPIC`, `PUBSUB_PUSH_SA`) | `server/lib/envGuards.ts`, `gmail.ts` |

## Create a log-based metric + alert (Cloud Logging)

```bash
PROJECT=gamechanger-pocket-agent

# 1) Log-based counter metric on the structured failure event.
gcloud logging metrics create pipeline_failures \
  --project="$PROJECT" \
  --description="Count of inbox pipeline_failure events" \
  --log-filter='resource.type="cloud_run_revision" AND jsonPayload.event="pipeline_failure"'

# 2) Alert policy: any pipeline_failure in a 5-minute window.
#    (Wire a notification channel first: gcloud beta monitoring channels list)
gcloud alpha monitoring policies create \
  --project="$PROJECT" \
  --notification-channels="<CHANNEL_ID>" \
  --display-name="Inbox pipeline failures" \
  --condition-display-name="pipeline_failure > 0 (5m)" \
  --condition-filter='metric.type="logging.googleapis.com/user/pipeline_failures" AND resource.type="cloud_run_revision"' \
  --condition-threshold-value=0 \
  --condition-threshold-comparison=COMPARISON_GT \
  --condition-threshold-duration=300s \
  --combiner=OR
```

## Ad-hoc triage

```bash
# Recent failures, newest first, grouped by kind:
gcloud logging read \
  'resource.type="cloud_run_revision" AND jsonPayload.event="pipeline_failure"' \
  --project="$PROJECT" --limit=100 --format='table(timestamp, jsonPayload.kind, jsonPayload.connectionId, jsonPayload.athleteId)'
```

- Spike of `token_refresh` after a deploy → check the OAuth client secret / consent-screen status.
- Steady `webhook_drop` / `dead_letter_exhausted` → inspect the dead-lettered ids in `gmail_dead_letters` and the underlying `detectDeal` error.
- Any `config` in prod → an env var regressed in the Cloud Run revision; see `gcp/cloud-run-v2.yaml`.
