/**
 * agent/plan/tellDb.ts — the tell step's database side: the chats that asked (chat_messages.agent_cards, 0123) and the
 * plan/ready model call. Every statement is athlete-scoped first; the athlete id comes from the workflow run.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { chatMessages } from "../../../shared/schema";
import type { ChatCard } from "../../../shared/agent";
import { dbStore } from "../research/dbStore";
import { planReadyWriter, type PlanReadyWriter, type TellChats } from "./tell";

const containsCard = (card: Record<string, unknown>) => sql`${chatMessages.agent_cards} @> ${JSON.stringify([card])}::jsonb`;

export const dbTellChats: TellChats = {
  async asking(athleteId, planRunId) {
    const rows = await db.select({ id: chatMessages.id, conversationId: chatMessages.conversation_id, cards: chatMessages.agent_cards })
      .from(chatMessages)
      .where(and(eq(chatMessages.athlete_id, athleteId), eq(chatMessages.role, "assistant"), containsCard({ kind: "progress", payload: { planRunId } })))
      .orderBy(desc(chatMessages.created_at));
    const seen = new Set<string>();
    const out: Array<{ rowId: string; conversationId: string; cards: ChatCard[] }> = [];
    for (const r of rows) {
      if (!r.conversationId || seen.has(r.conversationId) || !Array.isArray(r.cards)) continue;
      seen.add(r.conversationId);
      out.push({ rowId: r.id, conversationId: r.conversationId, cards: r.cards as ChatCard[] });
    }
    return out;
  },
  async hasCard(athleteId, conversationId, cardId) {
    const [hit] = await db.select({ id: chatMessages.id }).from(chatMessages)
      .where(and(eq(chatMessages.athlete_id, athleteId), eq(chatMessages.conversation_id, conversationId), containsCard({ id: cardId }))).limit(1);
    return !!hit;
  },
  async setCards(athleteId, rowId, cards) {
    await db.update(chatMessages).set({ agent_cards: cards }).where(and(eq(chatMessages.athlete_id, athleteId), eq(chatMessages.id, rowId)));
  },
  async insert(athleteId, conversationId, row) {
    await db.insert(chatMessages).values({
      athlete_id: athleteId, role: "assistant", content: row.content, conversation_id: conversationId,
      agent_cards: row.cards, agent_run_id: row.agentRunId,
    });
  },
};

/** The plan/ready call for a workflow run, on the database store (parent ref "workflow:<run>:tell"). */
export function dbPlanReadyWriter(athleteId: string, workflowRunId: string): PlanReadyWriter {
  return planReadyWriter(dbStore, athleteId, `workflow:${workflowRunId}:tell`);
}
