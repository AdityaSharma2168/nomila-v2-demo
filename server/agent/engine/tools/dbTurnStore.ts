/**
 * agent/engine/tools/dbTurnStore.ts (moved from agent/mcp/, 5 Nov 2026) — the durable TurnStore (0141), so a turn's tool calls can land on any API instance.
 *
 *   state   mila_tf_sessions.tool_state, read by the pass's `sid` AND `sub` (a pass names one athlete; a session id from
 *           another athlete reads as no session). Saved compare-and-set on state_version. A `sid` that is not one of
 *           our sessions (a smoke script's made-up id) gets a fresh, unsaved state: tools still work, nothing persists.
 *   items   mila_tf_turn_items, one row per card / approval / evidence ref / tool-call record, inserted only when the
 *           pass's `rid` is an agent_runs row of the pass's athlete (INSERT … SELECT … WHERE EXISTS): a pass can never
 *           leave items on another athlete's run. take() deletes and returns them in call order, in one statement.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../db";
import { milaTfSessions, milaTfTurnItems } from "../../../../shared/schema";
import type { ApprovalItem, ChatCard, EvidenceRef, ToolCallRecord } from "../../../../shared/agent";
import { createLogger } from "../../../logger";
import { fromStored, isUuid, toStored, type StoredToolState, type TurnKey, type TurnRecord, type TurnStore } from "./turnStore";

const logger = createLogger("agent/engine/tools/dbTurnStore");

type ItemKind = "card" | "approval" | "evidence" | "tool";

async function insertItems(key: TurnKey, items: Array<{ kind: ItemKind; payload: unknown }>): Promise<void> {
  if (!items.length || !isUuid(key.runId) || !isUuid(key.athleteId)) return;
  const values = sql.join(items.map((i) => sql`(${i.kind}, ${JSON.stringify(i.payload)}::jsonb)`), sql`, `);
  const res = await db.execute(sql`
    INSERT INTO mila_tf_turn_items (athlete_id, run_id, kind, payload)
    SELECT ${key.athleteId}::uuid, ${key.runId}::uuid, v.kind, v.payload
    FROM (VALUES ${values}) AS v(kind, payload)
    WHERE EXISTS (SELECT 1 FROM agent_runs r WHERE r.id = ${key.runId}::uuid AND r.athlete_id = ${key.athleteId}::uuid)`);
  const inserted = Number((res as { rowCount?: number; affectedRows?: number }).rowCount ?? (res as { affectedRows?: number }).affectedRows ?? items.length);
  if (inserted === 0) logger.warn({ athleteId: key.athleteId, runId: key.runId }, "turn items dropped: the pass's run is not this athlete's agent run");
}

export const dbTurnStore: TurnStore = {
  async loadState(key) {
    const now = new Date();
    if (!isUuid(key.sessionId)) return { turn: fromStored(null, { conversationId: null, now }), version: null };
    const [row] = await db.select({ state: milaTfSessions.tool_state, version: milaTfSessions.state_version, conversationId: milaTfSessions.conversation_id })
      .from(milaTfSessions)
      .where(and(eq(milaTfSessions.id, key.sessionId), eq(milaTfSessions.athlete_id, key.athleteId)))
      .limit(1);
    if (!row) return { turn: fromStored(null, { conversationId: null, now }), version: null };
    return { turn: fromStored(row.state as StoredToolState, { conversationId: row.conversationId ?? null, now }), version: row.version };
  },

  async saveState(key, turn, version) {
    if (version === null || !isUuid(key.sessionId)) return true;
    const rows = await db.update(milaTfSessions)
      // Merged, not replaced: keys the tools do not own (engine/sessions.ts chatSeen, the chat gap cursor) stay.
      .set({ tool_state: sql`COALESCE(${milaTfSessions.tool_state}, '{}'::jsonb) || ${JSON.stringify(toStored(turn))}::jsonb`, state_version: sql`${milaTfSessions.state_version} + 1` })
      .where(and(eq(milaTfSessions.id, key.sessionId), eq(milaTfSessions.athlete_id, key.athleteId), eq(milaTfSessions.state_version, version)))
      .returning({ id: milaTfSessions.id });
    return rows.length > 0;
  },

  async addOk(key, cards: ChatCard[], evidence: EvidenceRef[]) {
    await insertItems(key, [...cards.map((c) => ({ kind: "card" as const, payload: c })), ...evidence.map((e) => ({ kind: "evidence" as const, payload: e }))]);
  },
  async addApproval(key, item: ApprovalItem) { await insertItems(key, [{ kind: "approval", payload: item }]); },
  async addTool(key, record: ToolCallRecord) { await insertItems(key, [{ kind: "tool", payload: record }]); },

  async take(key) {
    if (!isUuid(key.runId) || !isUuid(key.athleteId)) return null;
    const rows = await db.delete(milaTfTurnItems)
      .where(and(eq(milaTfTurnItems.run_id, key.runId), eq(milaTfTurnItems.athlete_id, key.athleteId)))
      .returning({ id: milaTfTurnItems.id, kind: milaTfTurnItems.kind, payload: milaTfTurnItems.payload });
    if (!rows.length) return null;
    rows.sort((a, b) => a.id - b.id);
    const rec: TurnRecord = { cards: [], approvals: [], evidence: [], tools: [] };
    for (const r of rows) {
      if (r.kind === "card") rec.cards.push(r.payload as ChatCard);
      else if (r.kind === "approval") rec.approvals.push(r.payload as ApprovalItem);
      else if (r.kind === "evidence") rec.evidence.push(r.payload as EvidenceRef);
      else if (r.kind === "tool") rec.tools.push(r.payload as ToolCallRecord);
    }
    return rec;
  },
};
