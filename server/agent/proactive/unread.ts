/**
 * agent/proactive/unread.ts — unread state for messages Mila started (design "Mila on watch", step 4).
 *
 *   unreadMila   how many Mila-started messages the athlete has not seen, and the newest one (the Mila tab's dot, and
 *                where a tap on the dot lands). Zero while MILA_PROACTIVE is off (nothing is ever marked Mila-started).
 *   markSeen     the athlete opened a conversation: its Mila-started messages are seen (only theirs, only unseen ones).
 *
 * Both are scoped to the athlete; a conversation id is client-minted and never a tenancy control.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { chatMessages } from "../../../shared/schema";

export interface UnreadMila { count: number; latest: { conversationId: string; messageId: string } | null }

const unseen = (athleteId: string) =>
  and(eq(chatMessages.athlete_id, athleteId), eq(chatMessages.mila_started, true), isNull(chatMessages.seen_at));

export async function unreadMila(athleteId: string): Promise<UnreadMila> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(chatMessages).where(unseen(athleteId));
  if (!n) return { count: 0, latest: null };
  const [r] = await db.select({ id: chatMessages.id, conversationId: chatMessages.conversation_id }).from(chatMessages)
    .where(unseen(athleteId)).orderBy(desc(chatMessages.created_at)).limit(1);
  return { count: n, latest: r?.conversationId ? { conversationId: r.conversationId, messageId: r.id } : null };
}

/** Mark a conversation's Mila-started messages seen. Returns how many changed. */
export async function markSeen(athleteId: string, conversationId: string, now: Date = new Date()): Promise<number> {
  const rows = await db.update(chatMessages).set({ seen_at: now })
    .where(and(unseen(athleteId), eq(chatMessages.conversation_id, conversationId)))
    .returning({ id: chatMessages.id });
  return rows.length;
}
