/**
 * pgAdvisoryLock.ts — cross-instance mutual exclusion for jobs that must run once.
 *
 * WHY THIS EXISTS: Cloud Run runs this service at minScale 1 / maxScale 3
 * (gcp/cloud-run-dev.yaml). The in-process node-cron schedules in server/index.ts fire
 * on EVERY instance, so a job registered there can run up to 3× concurrently. Add a
 * Cloud Scheduler trigger for the same job and that becomes 4 overlapping runs. For the
 * inbox poll that means the same Gmail messages fetched and pushed through detectDeal
 * several times at once — wasted model spend, and racing writes on the same thread rows.
 *
 * Postgres advisory locks are the right primitive: no table, no cleanup job, and the
 * lock dies with the connection, so an instance that is killed mid-job never wedges it.
 *
 * IMPORTANT — the lock is SESSION-scoped, which means it lives on ONE connection. It
 * cannot go through `db.execute()`: drizzle hands that back to the pool between
 * statements, so the unlock would very likely land on a different connection than the
 * lock and silently do nothing. We check a client out of the pool and pin it for the
 * whole critical section.
 *
 * Usage:
 *   const r = await withAdvisoryLock(LOCK_INBOX_SYNC, () => runInboxCronSync());
 *   if (!r.ran) logger.info("another instance holds the inbox lock — skipped");
 */

import { pool } from "../db";
import { createLogger } from "../logger";

const logger = createLogger("lib/pgAdvisoryLock");

/**
 * Lock keys. Advisory locks are keyed by a bigint in a single global namespace, so
 * every key in the app must be declared here — two jobs that collide on a number would
 * silently serialise against each other. Pick a new arbitrary constant per job.
 */
export const LOCK_INBOX_SYNC = 4_913_207_001n;
/** Phase A Step 2b: the nightly research planner pass (Cloud Scheduler → internal route; the script shares it). */
export const LOCK_RESEARCH_PLANNER = 4_913_207_002n;
/** Outlook push: the 12-hourly subscription renewal (Cloud Scheduler → /api/internal/outlook-subscriptions-cron). */
export const LOCK_OUTLOOK_SUBSCRIPTIONS = 4_913_207_003n;
/** Bookings v2: the 5-minute session sweep (Cloud Scheduler → /api/internal/booking-session-cron, and the in-process copy). */
export const LOCK_BOOKING_SESSION = 4_913_207_004n;
/** Partner email replies: the 2-minute poll of the partner Workspace mailbox (in-process cron, PARTNER_INBOUND_MAIL). */
export const LOCK_PARTNER_INBOX = 4_913_207_005n;
/** The shared content playbook's daily refresh sweep (Cloud Scheduler → /api/internal/playbook-refresh-cron). */
export const LOCK_PLAYBOOK_REFRESH = 4_913_207_006n;
/** The daily sign-up research cap's admit / release (agent/onboarding/dailyCap.ts): a TRANSACTION lock (pg_advisory_xact_lock). */
export const LOCK_SIGNUP_RESEARCH_CAP = 4_913_207_007n;

export interface LockOutcome<T> {
  /** False when another holder had the lock — `fn` was never called. */
  ran:    boolean;
  result: T | undefined;
}

/**
 * Run `fn` while holding advisory lock `key`, or return `{ ran: false }` immediately if
 * someone else holds it. Never waits: a skipped tick is correct for periodic jobs, where
 * queueing would just pile up duplicate work behind a slow run.
 *
 * The lock is always released — including when `fn` throws, in which case the error
 * propagates to the caller after the unlock.
 */
export async function withAdvisoryLock<T>(
  key: bigint,
  fn: () => Promise<T>,
): Promise<LockOutcome<T>> {
  const client = await pool.connect();
  let acquired = false;
  try {
    // pg returns bigint as a string; node-postgres sends the bigint param as text and
    // Postgres coerces it to int8, which is what pg_try_advisory_lock expects.
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [key.toString()],
    );
    acquired = res.rows[0]?.locked === true;
    if (!acquired) {
      logger.info({ key: key.toString() }, "Advisory lock held elsewhere — skipping this run");
      return { ran: false, result: undefined };
    }

    const result = await fn();
    return { ran: true, result };
  } finally {
    if (acquired) {
      // Best-effort: a failed unlock must not mask the real error from `fn`, and the
      // lock would be dropped anyway when the connection closes.
      await client
        .query("SELECT pg_advisory_unlock($1)", [key.toString()])
        .catch((err: any) =>
          logger.warn({ key: key.toString(), err: err.message }, "Advisory unlock failed"),
        );
    }
    client.release();
  }
}
