/**
 * transcriptRoute.ts — voice turns land in the SAME thread as the text chat.
 *
 * POST /athletes/:id/transcript, mounted at /api/internal/voice (server/index.ts).
 * The caller is TRUSTED INFRASTRUCTURE: no session, no `req.athleteId`. Besides
 * the shared guard (./auth), the write is bound to the session grant: a grant for
 * another athlete or conversation is 403, and an athlete turn (role user) needs a
 * valid grant (401). Body `turnId` (optional): the worker's id of this spoken turn,
 * which a one-Mila call's spoken "send it" is matched by (./oneMila/confirm.ts).
 *
 * ── One transcript, not two ──────────────────────────────────────────────────
 * Voice is entered from inside an existing Ask Mila chat and writes into that
 * chat's `conversation_id`, so text and speech interleave in one `chat_messages`
 * thread. The athlete scrolls one history; `loadHistory` needs no change; and the
 * saved-chats list keeps working because the same `upsertConversationOnMessage`
 * that the text path calls is reused here rather than reimplemented.
 *
 * `source: 'voice'` marks the channel. `role` is UNCHANGED — a voice turn is
 * still 'user' or 'assistant' — so `chat_role_check` needs no DROP/ADD, which is
 * the constraint dance that broke the deploy twice (see deploy.yml's header).
 *
 * ── Writing is NOT the same as seeding ───────────────────────────────────────
 * This route makes the transcript unified. It deliberately does not make it
 * READABLE by a future voice session: `chat_messages` holds brand- and
 * email-derived prose, and replaying it into a session that speaks aloud is the
 * boundary the whole memory design exists to hold. A new voice session is seeded
 * from ./voiceContext + ./voiceSeed — structure, rebuilt into our own copy —
 * never from these rows. Write unified, read structured.
 *
 * ── What is stored ───────────────────────────────────────────────────────────
 * The turn's text, as transcribed. That is athlete speech and Mila's own speech,
 * which is exactly what a transcript is for; it is stored, never re-spoken from
 * here. The seed is what a later session hears, and it does not come from here.
 *
 * Bounded: an over-long body is TRUNCATED rather than rejected, because losing a
 * turn from the transcript is worse than storing a clipped one, and a runaway
 * body is a bug rather than an athlete.
 */

import { Router, type Request, type Response } from "express";
import { db } from "../db";
import { chatMessages } from "../../shared/schema";
import { upsertConversationOnMessage } from "../mila/conversations";
import { chatMinimalEnabled, trimQuotes } from "../mila/chatMinimal";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { voiceAuthorized, sendVoiceRefusal, UUID_RE, verifyVoiceGrant, VOICE_GRANT_HEADER } from "./auth";
import { MILA } from "../mila/config";
import { callKeyOf, recordHeard, TURN_ID_RE, voiceSessionRow } from "./oneMila/state";

const logger = createLogger("voice/transcript");

const router = Router();

/** Bounds the write. A stalled pool must not hold a live call's turn open. */
const WRITE_TIMEOUT_MS = 3_000;

/** Longest turn stored. Generous — a spoken turn is short; this is a bug guard. */
const CONTENT_MAX = 8_000;

/** Only the two roles a spoken turn can have. `system`/`tool` never come from voice. */
const VOICE_ROLES = ["user", "assistant"] as const;
type VoiceRole = (typeof VOICE_ROLES)[number];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const roleOf = (v: unknown): VoiceRole | null =>
  typeof v === "string" && VOICE_ROLES.some((r) => r === v)
    ? (v as VoiceRole)
    : null;

// POST /athletes/:id/transcript — append one spoken turn to the chat thread.
router.post("/athletes/:id/transcript", async (req: Request, res: Response) => {
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

  // The conversation is chosen by the SESSION, not by a model — it arrives from
  // the worker's userData, which Track B will populate from the chat that
  // launched voice. Validated for shape so bad input cannot reach the DB.
  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId : "";
  if (!UUID_RE.test(conversationId)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }

  const role = roleOf(body.role);
  if (!role) {
    res.status(400).json({ error: "Invalid role" });
    return;
  }

  // Bound to the grant (10 Nov 2026, security review of #1251), whatever VOICE_GRANT_ENFORCE says: a valid grant must
  // name THIS athlete and THIS conversation (403 otherwise), and the athlete's own words (role user) are written only
  // with one (401 without). A secret holder alone can no longer put words in her mouth, or into another conversation.
  // Residual trust: a worker holding the secret and a live grant still writes whatever it transcribed.
  const verdict = verifyVoiceGrant(req.headers[VOICE_GRANT_HEADER]);
  if (verdict.ok && (verdict.claims.athleteId !== id || verdict.claims.conversationId !== conversationId)) {
    logger.warn({ athleteId: id, role }, "Voice transcript refused: the grant is for another athlete or conversation");
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (role === "user" && !verdict.ok) {
    logger.warn({ athleteId: id, reason: verdict.reason }, "Voice transcript refused: an athlete turn needs the session grant");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // The worker's turn id for this spoken turn (ONE MILA FOR VOICE): what confirm_by_voice matches her answer by.
  const turnId = typeof body.turnId === "string" && TURN_ID_RE.test(body.turnId) ? body.turnId : null;

  const raw = typeof body.content === "string" ? body.content.trim() : "";
  if (!raw) {
    // An empty turn is not an error — the realtime model emits items with no
    // text (a tool-call-only turn). Nothing to store, nothing to complain about.
    res.json({ stored: false });
    return;
  }
  const capped = raw.length > CONTENT_MAX ? raw.slice(0, CONTENT_MAX) : raw;
  // MILA_CHAT_MINIMAL (decision 9): Mila's spoken turns follow the text rule —
  // a long quote is kept as a short excerpt. The athlete's own words are untouched.
  const content =
    role === "assistant" && chatMinimalEnabled() ? trimQuotes(capped) : capped;

  try {
    await withTimeout(
      (async () => {
        // Same upsert the text path uses, so the saved-chats list and its
        // recency ordering behave identically whichever channel spoke. It is
        // internally athlete-scoped and swallows its own failures.
        await upsertConversationOnMessage(id, conversationId, content);

        const [row] = await db.insert(chatMessages).values({
          athlete_id: id,
          conversation_id: conversationId,
          role,
          content,
          source: "voice",
        }).returning({ id: chatMessages.id });
        // Her turn in a one-Mila call, with its turn id, on the call's record (oneMila/state.ts recordHeard): only
        // this grant-bound route writes it, and confirm_by_voice reads only what it wrote.
        if (role === "user" && turnId && verdict.ok && MILA.VOICE_ONE && row) {
          const session = await voiceSessionRow(id, conversationId);
          if (session) await recordHeard(session, row.id, callKeyOf(req.headers[VOICE_GRANT_HEADER] as string), turnId);
        }
      })(),
      WRITE_TIMEOUT_MS,
      "voice transcript write",
    );

    // Never log the content: it is athlete speech, and it may quote a brand.
    logger.info(
      { athleteId: id, role, chars: content.length },
      "Voice turn stored",
    );
    res.json({ stored: true });
  } catch (err: any) {
    // A failed transcript write must NOT fail the call. The worker treats this
    // as fire-and-forget, so the status is for logs and tests; the athlete keeps
    // talking either way.
    logger.error(
      { athleteId: id, role, error: err.message },
      "Voice transcript write failed",
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
