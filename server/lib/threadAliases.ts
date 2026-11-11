/**
 * threadAliases.ts — cross-mailbox Gmail thread → one inbox_threads row.
 *
 * Gmail's threadId is *per mailbox*. The same physical email delivered to
 * athlete@gmail.com and athlete@her-own-domain.com becomes two different
 * external_thread_ids. Message-ID echo (gate 1a′) skips the duplicate message,
 * but follow-ups only land on mailbox B with external thread id TB, which never
 * maps to the deal created from TA — so we mint a second deal card.
 *
 * Fix: keep `inbox_threads.alias_thread_ids` (text[]) of secondary Gmail thread
 * ids that resolve to the same logical conversation. On every Message-ID echo /
 * already_processed hit, register the *arriving* gmailThreadId as an alias of the
 * existing row. Lookups use external_thread_id OR alias.
 *
 * H1/H4: aliases live in a DEDICATED column, not the classification JSONB — a
 * follow-up/upgrade rewrites classification wholesale and used to clobber the
 * aliases (re-splitting the deal). Registration is a SINGLE atomic array UPDATE
 * (append + dedup in one statement), so concurrent registrations can't lose one.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { inboxThreads } from "../../shared/schema";
import { createLogger } from "../logger";

const logger = createLogger("lib/threadAliases");

export async function findThreadByExternalId(
  athleteId: string,
  gmailThreadId: string,
): Promise<{
  id: string;
  message_count: number | null;
  classification: unknown;
  deal_id: string | null;
} | null> {
  if (!gmailThreadId) return null;

  // Primary key: the unique (athlete, external_thread_id) row.
  const [primary] = await db
    .select({
      id:             inboxThreads.id,
      message_count:  inboxThreads.message_count,
      classification: inboxThreads.classification,
      deal_id:        inboxThreads.deal_id,
    })
    .from(inboxThreads)
    .where(and(
      eq(inboxThreads.athlete_id, athleteId),
      eq(inboxThreads.external_thread_id, gmailThreadId),
    ))
    .limit(1);
  if (primary) return primary;

  // Secondary: alias registered when the same conversation hit a different inbox.
  const [aliased] = await db
    .select({
      id:             inboxThreads.id,
      message_count:  inboxThreads.message_count,
      classification: inboxThreads.classification,
      deal_id:        inboxThreads.deal_id,
    })
    .from(inboxThreads)
    .where(and(
      eq(inboxThreads.athlete_id, athleteId),
      sql`${gmailThreadId} = ANY(${inboxThreads.alias_thread_ids})`,
    ))
    .limit(1);
  return aliased ?? null;
}

/**
 * Register `gmailThreadId` as an alias of `threadId` so later mail on that
 * Gmail conversation (from another connected inbox) lands on the same deal.
 * No-op when the id is already the primary external_thread_id or already listed.
 *
 * Atomic: one UPDATE that appends + dedups in a single statement (no
 * SELECT-then-UPDATE), so concurrent registrations can't drop an alias (H4).
 */
export async function registerThreadAlias(
  threadId: string,
  gmailThreadId: string | null | undefined,
): Promise<void> {
  if (!gmailThreadId) return;

  const res = await db
    .update(inboxThreads)
    .set({
      alias_thread_ids: sql`array_append(coalesce(${inboxThreads.alias_thread_ids}, '{}'), ${gmailThreadId})`,
    })
    .where(and(
      eq(inboxThreads.id, threadId),
      // Never alias the row's own primary id…
      sql`${inboxThreads.external_thread_id} IS DISTINCT FROM ${gmailThreadId}`,
      // …and only append when it isn't already present (idempotent, no dupes).
      sql`NOT (coalesce(${inboxThreads.alias_thread_ids}, '{}') @> ARRAY[${gmailThreadId}]::text[])`,
    ))
    .returning({ id: inboxThreads.id });

  if (res.length > 0) {
    logger.info({ threadId, gmailThreadId }, "Registered cross-mailbox thread alias");
  }
}
