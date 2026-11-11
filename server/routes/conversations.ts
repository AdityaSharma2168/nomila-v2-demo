/**
 * conversations.ts — saved Ask Mila chats (Phase-2 memory, read side).
 *
 * Endpoints (mounted at /api/v1/me):
 *   GET /conversations        — this athlete's saved chats, most-recent first
 *   GET /conversations/:id     — one conversation's replayable turns, for reopen
 *   DELETE /conversations/:id  — delete one chat (messages, summary, voice state)
 *   DELETE /conversations      — delete every chat this athlete has
 *   GET /mila/unread           — Mila-started messages not seen yet (MILA_PROACTIVE; 0 with it off)
 *   POST /conversations/:id/seen — the athlete opened that chat: its Mila-started messages are seen
 *
 * All endpoints are athlete-scoped in the access layer
 * (server/mila/conversations.ts) — the :id is a client-minted uuid, never a
 * tenancy control.
 */

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import {
  listConversations,
  getConversationMessages,
  deleteConversation,
  deleteAllConversations,
} from "../mila/conversations";
import { markSeen, unreadMila } from "../agent/proactive/unread";

const logger = createLogger("routes/conversations");
const router = Router();

// Same guard shape as the chat route: a client-minted id must be a well-formed
// uuid before it touches the uuid column (a bad cast would 500 the request).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── GET /api/v1/me/conversations ─────────────────────────────────────────────

router.get(
  "/conversations",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId!;
    try {
      const conversations = await listConversations(athleteId);
      res.json({ conversations });
    } catch (err) {
      logger.error(
        { athleteId, error: (err as Error).message },
        "Failed to list conversations",
      );
      res.status(500).json({ error: "Could not load your chats" });
    }
  },
);

// ─── GET /api/v1/me/conversations/:id ─────────────────────────────────────────

router.get(
  "/conversations/:id",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId!;
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "invalid conversation id" });
      return;
    }
    try {
      const messages = await getConversationMessages(athleteId, id);
      res.json({ messages });
    } catch (err) {
      logger.error(
        { athleteId, error: (err as Error).message },
        "Failed to load conversation",
      );
      res.status(500).json({ error: "Could not load this chat" });
    }
  },
);

// ─── Mila-started messages: unread count and seen (MILA_PROACTIVE) ────────────
// GET  /api/v1/me/mila/unread              → { count, latest: { conversationId, messageId } | null }
// POST /api/v1/me/conversations/:id/seen   → { ok, seen } — the athlete opened that chat
// Both answer normally with the flag off (count 0, nothing to mark): nothing is ever marked Mila-started then.

router.get(
  "/mila/unread",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId!;
    try {
      res.json(await unreadMila(athleteId));
    } catch (err) {
      logger.error({ athleteId, error: (err as Error).message }, "Failed to count unread Mila messages");
      res.status(500).json({ error: "Could not check for new messages" });
    }
  },
);

router.post(
  "/conversations/:id/seen",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId!;
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "invalid conversation id" });
      return;
    }
    try {
      res.json({ ok: true, seen: await markSeen(athleteId, id) });
    } catch (err) {
      logger.error({ athleteId, error: (err as Error).message }, "Failed to mark messages seen");
      res.status(500).json({ error: "Could not update this chat" });
    }
  },
);

// ─── DELETE /api/v1/me/conversations/:id ──────────────────────────────────────

router.delete(
  "/conversations/:id",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId!;
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "invalid conversation id" });
      return;
    }
    try {
      // Idempotent: a repeat (or another athlete's id) removes nothing and still
      // answers ok, so the response never says whether an id exists elsewhere.
      const deleted = await deleteConversation(athleteId, id);
      res.json({ ok: true, deleted });
    } catch (err) {
      logger.error(
        { athleteId, error: (err as Error).message },
        "Failed to delete conversation",
      );
      res.status(500).json({ error: "Could not delete this chat" });
    }
  },
);

// ─── DELETE /api/v1/me/conversations ──────────────────────────────────────────

router.delete(
  "/conversations",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId!;
    try {
      const deleted = await deleteAllConversations(athleteId);
      res.json({ ok: true, deleted });
    } catch (err) {
      logger.error(
        { athleteId, error: (err as Error).message },
        "Failed to delete all conversations",
      );
      res.status(500).json({ error: "Could not delete your chats" });
    }
  },
);

export default router;
