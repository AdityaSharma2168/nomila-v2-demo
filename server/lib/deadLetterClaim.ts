/**
 * deadLetterClaim.ts — one retry of a queued message at a time, with backoff (gmail_dead_letters, Gmail and Outlook).
 *
 * The cron poll and a push-triggered sync can both run a mailbox's dead-letter retry at the same moment; without a
 * claim both re-fetched and re-classified the same message (two model calls, two attempt bumps). And a message that
 * kept failing was retried on every poll. Now:
 *   · a row is retried only once its backoff has passed: 15 min × 2^attempts since its last attempt (15m, 30m, 1h, 2h,
 *     4h), immediately when it has never been tried;
 *   · a retrier CLAIMS the row first with a compare-and-set on (attempts, last_attempt_at) — stamping last_attempt_at —
 *     so a concurrent retrier finds it not yet due and skips it.
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { gmailDeadLetters } from "../../shared/schema";

export const DEAD_LETTER_BASE_BACKOFF_MS = 15 * 60 * 1000;

/** How long after its last attempt a row with `attempts` failures is due again. */
export function backoffMs(attempts: number): number {
  return DEAD_LETTER_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts);
}

/** SQL: the row is due — never tried, or its backoff has passed. */
export function dueSql(now: Date) {
  return or(
    isNull(gmailDeadLetters.last_attempt_at),
    sql`${gmailDeadLetters.last_attempt_at} < ${now.toISOString()}::timestamptz - (${DEAD_LETTER_BASE_BACKOFF_MS} * power(2, ${gmailDeadLetters.attempts})) * interval '1 millisecond'`,
  );
}

type Db = typeof defaultDb;

/** Claim one row for a retry. true = this caller owns the attempt; false = not due, or another retrier has it. */
export async function claimDeadLetter(
  row: { id: string; attempts: number; last_attempt_at: Date | null },
  now: Date = new Date(),
  db: Db = defaultDb,
): Promise<boolean> {
  const claimed = await db
    .update(gmailDeadLetters)
    .set({ last_attempt_at: now })
    .where(and(
      eq(gmailDeadLetters.id, row.id),
      eq(gmailDeadLetters.attempts, row.attempts),
      row.last_attempt_at ? eq(gmailDeadLetters.last_attempt_at, row.last_attempt_at) : isNull(gmailDeadLetters.last_attempt_at),
      dueSql(now),
    ))
    .returning({ id: gmailDeadLetters.id });
  return claimed.length > 0;
}

