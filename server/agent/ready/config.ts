/**
 * agent/ready/config.ts — the "Ready for you" queue's flag (content engine build step 2).
 *
 * CONTENT_READY_QUEUE — GET /api/v1/me/engine/items and POST /api/v1/me/engine/items/:id/posted are mounted. Off unless
 * exactly "true", and only ever together with AGENT_POST_KITS (the queue lists post kits). Set in neither Cloud Run
 * yaml yet: it is switched on in dev when Studio's Ready screen and Home's top card are built on it.
 */
import { agentPostKitsEnabled } from "../postKit/config";

export function contentReadyQueueEnabled(): boolean {
  return agentPostKitsEnabled() && process.env.CONTENT_READY_QUEUE === "true";
}
