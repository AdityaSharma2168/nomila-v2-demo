/**
 * voiceContextRoute.ts — the worker recording what a turn discussed.
 *
 * POST /athletes/:id/voice-context, mounted at /api/internal/voice.
 * Trusted infrastructure, secret-guarded, athlete-scoped by the path id.
 *
 * ── Why the worker writes this and not the answering route ───────────────────
 * `get_deal_brief` has everything needed and could write the artifact as a side
 * effect of answering. It deliberately does not. Answering a question is not the
 * same as HAVING DISCUSSED something: the model calls that endpoint to decide
 * what to say, and it may call it and then say nothing at all. Memory should
 * record the conversation, not the lookups behind it, so the record is written by
 * the side that knows a turn actually happened.
 *
 * The cost is one round trip per discussed brand, fire-and-forget from a live
 * call, which is why the worker never awaits it.
 *
 * ── This endpoint trusts nothing it is given ─────────────────────────────────
 * The body is passed to `recordVoiceContext` as-is, and the serializers there
 * decide field by field what survives — ids, closed enums, booleans, timestamps,
 * built key by key so nothing spreads through. That is the whole reason the
 * worker can hand over a raw tool result without inspecting it: this route adds
 * no validation of its own precisely so there is ONE place the invariant lives.
 */

import { Router, type Request, type Response } from "express";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { voiceAuthorized, sendVoiceRefusal, UUID_RE } from "./auth";
import { recordVoiceContext } from "./voiceContext";

const logger = createLogger("voice/voiceContextRoute");

const router = Router();

/** Bounds the write. Memory is never worth holding a live call's turn open. */
const WRITE_TIMEOUT_MS = 3_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

router.post(
  "/athletes/:id/voice-context",
  async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    const voiceAuth = await voiceAuthorized(req, req.params.id);
    if (!voiceAuth.ok) {
      sendVoiceRefusal(res, voiceAuth);
      return;
    }

    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid athlete id" });
      return;
    }

    const body = isRecord(req.body) ? req.body : {};
    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId : "";
    if (!UUID_RE.test(conversationId)) {
      res.status(400).json({ error: "Invalid conversation id" });
      return;
    }

    try {
      const stored = await withTimeout(
        recordVoiceContext(id, conversationId, {
          // Handed over raw on purpose — see the header.
          deals: asArray(body.deals),
          brands: asArray(body.brands),
          openThreads: asArray(body.openThreads),
          draftsOpened: asArray(body.draftsOpened),
        }),
        WRITE_TIMEOUT_MS,
        "voice context write",
      );

      logger.info({ athleteId: id, stored }, "Voice context recorded");
      res.json({ stored });
    } catch (err: any) {
      // Losing a memory entry must never surface as a failed turn. The worker
      // ignores this status; it is here for logs and tests.
      logger.error(
        { athleteId: id, error: err.message },
        "Voice context write failed",
      );
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
