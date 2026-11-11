#!/usr/bin/env bash
#
# provision-schedulers.sh — declare every Cloud Scheduler job this service needs.
#
# WHY THIS EXISTS
#
# The scheduler jobs were created by hand, one gcloud invocation at a time, with no
# record in the repo. Two consequences showed up on 2026-08-09:
#
#   1. There was NO job for the inbox poll. The in-process node-cron in server/index.ts
#      was the only ingestion trigger — and with minScale 1 / maxScale 3 it fired on
#      every instance, so a tick meant up to three concurrent syncs.
#
#   2. `gmail-watch-renew` and `media-enrich-cron` had been returning 401 UNAUTHENTICATED
#      on every run. Their x-cron-secret header was 65 characters: the value in Secret
#      Manager has a trailing carriage return, and whoever created those two jobs passed
#      it through unstripped. The server trims its own copy
#      (server/index.ts, CRON_SECRET), so the two never matched. gmail-watch-renew is the
#      job that keeps Gmail push alive past the 7-day watch expiry, so it failing silently
#      is exactly the "ingestion has no reliable trigger" problem, one layer down.
#
# This script is the record of what should exist, and it is idempotent: run it any time
# to converge. It strips whitespace from the secret (the fix for #2) and repairs the
# header on jobs that already exist.
#
# Usage:
#   bash scripts/provision-schedulers.sh            # show what would change (dev)
#   APPLY=1 bash scripts/provision-schedulers.sh    # create/update for real (dev)
#   ONLY=studio- bash scripts/provision-schedulers.sh   # just the jobs whose NAME starts with the prefix (PR 20,
#                                                        # ADI-S20-SCHED) — every other job is left alone, not re-applied
#
# gcloud's create/update echo the job back, x-cron-secret header included; every call here runs with
# --format=none so a secret never reaches a terminal or a CI log (ADI-S20-SCHED: one update printed it in full).
#
# Production runs the same seven jobs against its own service, with its own cron secret
# and a name suffix so the two sets sit side by side in one project:
#   SERVICE_URL=https://nomila-v2-prod-241621020090.us-central1.run.app \
#   JOB_SUFFIX=-prod CRON_SECRET_NAME=PROD_CRON_SECRET APPLY=1 \
#   bash scripts/provision-schedulers.sh
#
# Requires gcloud authenticated to the project with Cloud Scheduler admin.

set -euo pipefail

PROJECT="${PROJECT:-gamechanger-pocket-agent}"
LOCATION="${LOCATION:-us-central1}"
# The service the jobs call. Dev by default. Use the raw Cloud Run URL rather than the
# custom domain so the jobs keep firing if a domain mapping is ever moved.
SERVICE_URL="${SERVICE_URL:-https://nomila-v2-241621020090.us-central1.run.app}"
# Appended to every job name: "" for dev (today's names), "-prod" for production.
JOB_SUFFIX="${JOB_SUFFIX:-}"
# The Secret Manager secret holding the x-cron-secret value the target service checks.
CRON_SECRET_NAME="${CRON_SECRET_NAME:-INTERNAL_CRON_SECRET}"
APPLY="${APPLY:-0}"

# `tr -d '[:space:]'` is the whole fix for the 401s. Do not remove it: the Secret Manager
# value itself still ends in \r, so anything that interpolates it raw re-creates the bug.
SECRET="$(gcloud secrets versions access latest \
  --secret="${CRON_SECRET_NAME}" --project="${PROJECT}" | tr -d '[:space:]')"

if [ "${#SECRET}" -ne 64 ]; then
  echo "ERROR: expected a 64-char cron secret, got ${#SECRET}. Refusing to provision." >&2
  exit 1
fi

# job_name | schedule (UTC) | endpoint path | attempt deadline [| content type, default application/json]
#
# The deadline must exceed the endpoint's own wall-clock budget, so the endpoint stops
# itself cleanly instead of being cut off mid-work by Scheduler.
JOBS=(
  "inbox-cron-sync|0 */6 * * *|/api/internal/gmail-cron-sync|1800s"
  "gmail-watch-renew|0 9 * * *|/api/internal/gmail-watch-renew|300s"
  "media-poster-cron|*/5 * * * *|/api/internal/media-poster-cron|300s"
  "ig-token-refresh|0 3 1 */2 *|/api/internal/ig-token-refresh|300s"
  "media-enrich-cron|*/15 * * * *|/api/internal/media-enrich-cron|300s"
  "archive-stale-cron|15 4 * * *|/api/internal/archive-stale-cron|300s"
  # Her picks (docs/design/shop-her-picks.md §12): the catalog-only Shopify app's daily full sync. Answers
  # {skipped:true} while SHOP_SHOPIFY_APP is off, so the job is inert until the flag flips.
  "shopify-reconcile-cron|40 4 * * *|/api/internal/shopify-reconcile-cron|600s"
  # Bookings v2 (server/services/bookings/sweeper.ts): lapsed unverified holds (15 min), her 72h respond_by (releases the
  # buyer's card hold), session end → review, and the 48h release with nothing open. Every 5 minutes because the
  # unverified hold is 15 minutes. Answers {skipped:true} while BOOKINGS_ENABLED is off, so the job is inert until it flips.
  "bookings-cron|*/5 * * * *|/api/internal/bookings-cron|300s"
  # Partner door (public brand + press requests): expire unconfirmed requests, redact old contacts, prune counters.
  # Answers {skipped:true} while PUBLIC_CARD / PARTNER_INTAKE are off, so the job is inert until the flags flip.
  "partner-intake-cron|25 * * * *|/api/internal/partner-intake-cron|120s"
  # Sign in with an email code (server/routes/authEmailCode.ts): delete codes past their 48 h keep window. Hourly; /start
  # also purges after each send. Harmless with EMAIL_CODE_SIGNIN off (nothing to delete). In JOBS, so the next run creates it.
  "email-code-purge-cron|35 * * * *|/api/internal/email-code-purge-cron|60s"
  "workflow-tick|* * * * *|/api/internal/workflow-tick|120s"
  # The plan step (server/agent/plan/triggers.ts): daily sweep — a weekly plan refresh per athlete with a current Brief
  # (none in the last 7 days), and an event refresh when a dated event is 3–14 days out with nothing due before it.
  # Only starts plan_refresh runs (the tick runs them). Answers {enabled:false} and starts nothing while AGENT_PLAN is
  # off, so the job is inert until the flag flips. The weekly day is "7 days since the last scheduled run".
  "plan-refresh-cron|0 14 * * *|/api/internal/plan-refresh-cron|300s"
  # The daily order is moments 12:00 → post ideas 13:00 → plan 14:00 UTC: each step reads what the one before wrote.
  # The weekly moments scan (server/agent/moments/triggers.ts): daily sweep at 12:00 UTC that ENQUEUES a moments_scan run
  # (kick false; the tick runs it) for every athlete with a current Brief and no scan in the last 7 days, so fresh moments
  # are in the store before the ideas pass and the plan read them. Answers {enabled:false} and starts nothing while
  # AGENT_MOMENTS is off, so the job is inert until the flag flips.
  "moments-scan-cron|0 12 * * *|/api/internal/moments-scan-cron|300s"
  # The agent research refresh's daily sweep (server/agent/researchRefresh/sweep.ts): at 10:00 UTC, ahead of the moments
  # scan, it ENQUEUES (kick false; the tick runs it) at most 5 refreshes — athletes with no agent research in 30 days,
  # or whose name, sport or team changed — under a daily cost cap. Answers {enabled/cohort:false} and starts nothing
  # unless BOTH AGENT_RESEARCH_REFRESH and AGENT_RESEARCH_REFRESH_COHORT are on, so the job is inert until the cohort flag
  # flips (owner, 12 Oct 2026: Mia first, by hand).
  "agent-research-refresh-cron|0 10 * * *|/api/internal/agent-research-refresh-cron|300s"
  # The post-kit builder's reverse pass (server/agent/postKit/ideas.ts): daily at 13:00 UTC, for athletes with a current
  # Brief and new tagged media, one cheap-tier call proposes post ideas from new, unused assets into the idea bank. After
  # the moments scan and ahead of the plan sweep, so a fresh idea is there when plan runs. Answers {enabled:false} and
  # does nothing while AGENT_POST_KITS is off, so the job is inert until the flag flips.
  "post-ideas-cron|0 13 * * *|/api/internal/post-ideas-cron|300s"
  # The shared content playbook's DAILY check (server/agent/playbook/triggers.ts): refreshes every
  # (sport, stage, platform) key found in the live roster whose active row is missing or STALE — one fast-tier +
  # web_search call per stale key, shared across every athlete at that key, never per-athlete work. Each key is
  # actually refreshed only roughly once a month (triggers.ts isStale: 28+ days old, or activated in an earlier UTC
  # calendar month) — review fix (PR #929): a monthly cron checked once on the 1st against a flat 30-day threshold
  # silently skipped a key forever on any 30-day-or-shorter month (Sep 1 → Oct 1 is 30 days; the key's own activation
  # a few minutes after 11:00 made it read as "under 30 days old" every single month). Running the check daily and
  # pairing the age test with a calendar-month test is what actually guarantees "at least once a month, every month".
  # Scheduled ahead of the daily moments → post ideas → plan chain so a fresh default is on file before any of them
  # might read it (none does yet this PR). Answers {ok:true, enabled:false} and does nothing while AGENT_PLAYBOOK is
  # off, so the job is inert until the flag flips. A longer deadline than the other daily jobs: stale keys are
  # refreshed one at a time, serially, up to AGENT_PLAYBOOK_MAX_KEYS_PER_RUN of them or AGENT_PLAYBOOK_RUN_BUDGET_MS
  # (default 25 minutes) of wall-clock time, whichever comes first — a key not reached this call waits for
  # tomorrow's, never for "next month's".
  "playbook-refresh-cron|0 11 * * *|/api/internal/playbook-refresh-cron|1800s"
  # Superseded post-kit preview renders (server/agent/postKit/render/cleanup.ts): daily at 03:30 UTC, a preview row whose
  # key is no longer its kit's is soft-deleted after 24 h and its files are deleted from storage 7 days later — preview
  # rows only, per athlete. Answers {ok:true, enabled:false} and does nothing while AGENT_POST_KIT_PREVIEW_CLEANUP is
  # off, so the job is inert until the flag flips. Declared here; not yet provisioned.
  "post-kit-preview-cleanup-cron|30 3 * * *|/api/internal/post-kit-preview-cleanup-cron|300s"
  # Phone notifications (server/routes/push.ts, services/push/push.ts checkReceipts): every 30 minutes, Expo's delivery
  # receipts for pushes 15 minutes to 24 hours old — a token Expo no longer knows (DeviceNotRegistered) is removed, any
  # other error code (InvalidCredentials, …) is recorded on its push_sends row; then a brand reply or waiting item whose
  # send failed outright gets its one retry (under an hour old, within the daily cap); then a reply draft still waiting
  # on her tap after 10 minutes is pushed once, and anything waiting gets one reminder the day before it expires. Answers {ok:true, enabled:false} and does
  # nothing while PUSH_NOTIFICATIONS is off, so the job is inert until the flag flips. Declared here; not yet provisioned.
  "push-receipts-cron|*/30 * * * *|/api/internal/push-receipts-cron|120s"
  # Model spend (server/agent/spendCron.ts): hourly, today's (UTC) agent_runs spend by provider as log lines — the spend
  # metric and its alert read them (scripts/monitoring/prod-release-monitoring.sh). Read-only, $0, no flag. Declared here;
  # prod is provisioned by that monitoring script (ONLY=agent-spend-cron, JOB_SUFFIX=-prod).
  "agent-spend-cron|5 * * * *|/api/internal/agent-spend-cron|120s"
  # Bookings v2 (server/routes/bookingSession.ts): the session sweep every 5 minutes — join notices, the no-show grace
  # check (records + notifies only), "How did it go?", the in-person check-in nudge, and release (the buyer's "It
  # happened", or end + 48h with nothing open). Answers {skipped:true} while BOOKINGS_ENABLED is off, so the job is
  # inert until the flag flips. Overlapping runs skip on the advisory lock.
  "booking-session-cron|*/5 * * * *|/api/internal/booking-session-cron|240s"
  # Phase A Step 2b: the nightly research planner (design §4.1, D9). Dry-run (telemetry only)
  # until BOTH RESEARCH_REFRESH_ENABLED and RESEARCH_SUBSTRATE_WRITE are true on the service.
  # 05:10 UTC: after the 04:30 social collect → discovery → re-score chain.
  "research-planner|10 5 * * *|/api/internal/research-planner-cron|600s"
  # PR 20 (docs/probes/ship.md item 4): the Studio ticks, every minute. D6 (server/studio/tickGate.ts) makes each one a
  # no-op that returns {skipped:true} while its flag is off — no lock, no claim, no provider call — so a job here is
  # inert until the flag flips, on dev and prod alike. Overlapping runs skip on the advisory lock. Deadlines: the video
  # tick polls a clip for up to STUDIO_VIDEO_TICK_POLL_MS (default STUDIO_VIDEO_MAX_POLL_MS, 600 s) per claimed job and
  # claims up to 2; the edit tick runs up to 4 edits in turn; both get Scheduler's 1800 s maximum. The stitch tick starts
  # ffmpeg detached and returns at once. The publish tick is not declared here (ADI-S20-GO).
  # ⚠️ Dev already has a HAND-MADE `studio-stitch-tick-dev` (docs/plans/studio-video-flip-checklist.md:90-91). This
  # creates `studio-stitch-tick` beside it; delete the hand-made one once this one authenticates.
  # Content type application/octet-stream on the three, as created by hand on 25 Sep 2026 (ADI-S20-SCHED): with
  # application/json they returned 401 there and with octet-stream 200. Nothing in server/index.ts reads the content
  # type before cronSecretValid (docs/probes/ship.md), so this is kept as-created until the curl pair settles it.
  "studio-video-tick|* * * * *|/api/internal/studio-video-tick|1800s|application/octet-stream"
  "studio-edit-tick|* * * * *|/api/internal/studio-edit-tick|1800s|application/octet-stream"
  "studio-stitch-tick|* * * * *|/api/internal/studio-stitch-tick|120s|application/octet-stream"
)

run() {
  if [ "${APPLY}" = "1" ]; then
    "$@"
  else
    # Never echo the secret into a dry-run log. Substitute the value wherever it appears
    # rather than matching a whole flag — create and update spell the header flag
    # differently, and a rename must not silently start leaking the secret.
    printf '  WOULD RUN: '
    for a in "$@"; do
      printf '%s ' "${a//${SECRET}/<redacted>}"
    done
    printf '\n'
  fi
}

echo "Project ${PROJECT} / ${LOCATION} → ${SERVICE_URL} (jobs *${JOB_SUFFIX:-<no suffix>}, secret ${CRON_SECRET_NAME}) — APPLY=${APPLY}"
echo

for spec in "${JOBS[@]}"; do
  IFS='|' read -r NAME SCHEDULE PATH_ DEADLINE CTYPE <<< "${spec}"
  CTYPE="${CTYPE:-application/json}"
  # ONLY=<prefix>: a subset run. A job outside it is not described, not updated, not created.
  if [ -n "${ONLY:-}" ] && [ "${NAME#"${ONLY}"}" = "${NAME}" ]; then continue; fi
  NAME="${NAME}${JOB_SUFFIX}"
  URI="${SERVICE_URL}${PATH_}"

  COMMON=(
    --project="${PROJECT}"
    --location="${LOCATION}"
    # Quote the schedule: unquoted, the `*` in a cron expression globs against the
    # working directory and gcloud receives a directory listing.
    --schedule="${SCHEDULE}"
    --time-zone=UTC
    --uri="${URI}"
    --http-method=POST
    --message-body="{}"
    --attempt-deadline="${DEADLINE}"
  )

  # The ONLY flag that differs between the two verbs: `create` takes --headers,
  # `update` takes --update-headers (a bare --headers there is "unrecognized arguments").
  HEADERS="x-cron-secret=${SECRET},Content-Type=${CTYPE}"

  if gcloud scheduler jobs describe "${NAME}" \
       --project="${PROJECT}" --location="${LOCATION}" >/dev/null 2>&1; then
    # Update unconditionally — this is what repairs the two jobs whose header still
    # carries the trailing \r, and it keeps schedule/URI/deadline in sync with this file.
    echo "${NAME}: exists → update"
    run gcloud scheduler jobs update http "${NAME}" "${COMMON[@]}" --update-headers="${HEADERS}" --format=none
  else
    echo "${NAME}: missing → create"
    run gcloud scheduler jobs create http "${NAME}" "${COMMON[@]}" --headers="${HEADERS}" --format=none
  fi
done

echo
if [ "${APPLY}" = "1" ]; then
  echo "Done. Verify each job authenticates (a 401 here means the header is wrong again):"
  echo "  gcloud logging read 'resource.type=\"cloud_scheduler_job\" AND httpRequest.status!=200' \\"
  echo "    --project=${PROJECT} --freshness=1h --limit=10"
else
  echo "Dry run only. Re-run with APPLY=1 to converge."
fi
