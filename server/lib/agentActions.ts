/**
 * agentActions (lib) — the single writer for the WS5 receipt log (`agent_actions`).
 *
 * Lives in lib (not the route) so both the route layer AND skills (dealDetector's
 * auto-demote) can append receipts without a route→skill or skill→route import.
 * The route re-exports these for backward compatibility.
 *
 * Append-only: a row is never deleted and its identity/payload never mutates; the
 * only post-insert writes are the reversal stamps (`undone_at`, `result`).
 */

import { db } from "../db";
import { agentActions, type AgentAction } from "../../shared/schema";
import { createLogger } from "../logger";

const logger = createLogger("lib/agentActions");

// The actions Nomila can log — mirrors shared/schema.ts agent_actions_action_check.
export const VALID_AGENT_ACTIONS = ["file", "auto_decline", "reclassify", "mute_sender", "reopen", "auto_archive", "profile_write", "confirm_signed", "split_deal"] as const;
export type AgentActionKind = typeof VALID_AGENT_ACTIONS[number];

/**
 * Append one immutable receipt row and return it. A reversible filing MUST pass
 * `payload.{from_status,to_status}` so `/agent-actions/:id/undo` can flip the thread
 * back. This is the single writer — all auto-actions (file, auto-decline, reclassify,
 * mute) go through here. `dbx` lets a caller write the receipt inside its own transaction.
 */
export async function writeAgentAction(params: {
  athleteId:  string;
  action:     AgentActionKind;
  dealId?:    string | null;
  threadId?:  string | null;
  reason?:    string | null;
  reversible?: boolean;
  heldUntil?: Date | null;
  payload?:   Record<string, unknown> | null;
  result?:    Record<string, unknown> | null;
}, dbx: any = db): Promise<AgentAction> {
  const [row] = await dbx
    .insert(agentActions)
    .values({
      athlete_id: params.athleteId,
      action:     params.action,
      deal_id:    params.dealId   ?? null,
      thread_id:  params.threadId ?? null,
      reason:     params.reason   ?? null,
      reversible: params.reversible ?? false,
      held_until: params.heldUntil ?? null,
      payload:    params.payload  ?? null,
      result:     params.result   ?? null,
    })
    .returning();

  logger.info(
    { athleteId: params.athleteId, agentActionId: row.id, action: params.action, reversible: row.reversible },
    "Agent action recorded",
  );
  return row;
}
