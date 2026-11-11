/**
 * replyThread.ts — the ONE answer to "which thread does a reply on this deal go to?".
 *
 * What the athlete gets: the reply she reads is the reply that is sent, to the conversation it
 * quotes. Before this, three steps picked the thread three ways — the draft took any linked thread
 * (no order, no athlete scope), Mila's draft tool took the most recent one, and propose took any —
 * so on a deal linked to two threads a draft could quote thread A and go out on thread B.
 *
 * The rule, shared by draft, propose and send:
 *   · a thread the caller names must be hers AND linked to this deal, or it is refused;
 *   · otherwise, the deal's thread with the most recent INBOUND message (the one the brand last
 *     wrote on, which is what sendThreadReply answers), then the most recent activity.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { inboxThreads } from "../../shared/schema";

export type ReplyThreadResult =
  | { ok: true; threadId: string | null }
  | { ok: false; reason: "thread_not_found" };

type Db = typeof defaultDb;

export async function resolveReplyThread(
  athleteId: string,
  dealId: string,
  requestedThreadId?: string | null,
  db: Db = defaultDb,
): Promise<ReplyThreadResult> {
  if (requestedThreadId) {
    const [t] = await db
      .select({ id: inboxThreads.id })
      .from(inboxThreads)
      .where(and(
        eq(inboxThreads.id, requestedThreadId),
        eq(inboxThreads.athlete_id, athleteId),
        eq(inboxThreads.deal_id, dealId),
      ))
      .limit(1);
    return t ? { ok: true, threadId: t.id } : { ok: false, reason: "thread_not_found" };
  }

  const latestInbound = sql`(
    SELECT max(m.received_at) FROM inbox_messages m
    WHERE m.thread_id = ${inboxThreads.id} AND m.direction = 'inbound'
  )`;
  const [t] = await db
    .select({ id: inboxThreads.id })
    .from(inboxThreads)
    .where(and(eq(inboxThreads.deal_id, dealId), eq(inboxThreads.athlete_id, athleteId)))
    .orderBy(sql`${latestInbound} DESC NULLS LAST`, sql`${inboxThreads.last_message_at} DESC NULLS LAST`, desc(inboxThreads.id))
    .limit(1);
  return { ok: true, threadId: t?.id ?? null };
}

/**
 * The deal's thread whose saved draft (latest_draft.body) is exactly this body, or null. A body the
 * athlete approves unedited came from a draft written for ONE thread; propose sends on that thread,
 * whatever thread id a screen passes, so the reply goes out on the conversation it quotes.
 */
export async function threadHoldingDraft(
  athleteId: string,
  dealId: string,
  body: string,
  db: Db = defaultDb,
): Promise<string | null> {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const rows = await db
    .select({ id: inboxThreads.id })
    .from(inboxThreads)
    .where(and(
      eq(inboxThreads.deal_id, dealId),
      eq(inboxThreads.athlete_id, athleteId),
      sql`btrim(${inboxThreads.latest_draft} ->> 'body') = ${trimmed}`,
    ))
    .limit(2);
  return rows.length === 1 ? rows[0].id : null;
}
