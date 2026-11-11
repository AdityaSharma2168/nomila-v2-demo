import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { db } from "../db";
import { chatMessages } from "../../shared/schema";
import { eq, and, gt, count } from "drizzle-orm";
import { chatLimiter } from "../lib/rateLimit";
import { createLogger } from "../logger";
import { openSSEStream } from "../lib/sse";
import { ATTACHMENT_ONLY_MESSAGE, AttachmentError, attachmentRequestSchema, loadAttachments, type MilaAttachment } from "../mila/attachments";
import { runMilaTurn } from "../agent/engine";

const router = Router();
const logger = createLogger("chat");

// Per-athlete cap on user messages per rolling hour. Env-overridable (not a secret),
// so prod can be tuned via Cloud Run config without a deploy. Default 60 = ~1/min sustained.
// Any missing/blank/invalid/non-positive value falls back to 60 — a bad env value must not
// resolve to 0 (which would block every athlete) or NaN (which would disable the limit).
const CHAT_RATE_LIMIT_PER_HOUR = (() => {
  const parsed = Number(process.env.CHAT_RATE_LIMIT_PER_HOUR);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
})();

// A client-minted conversation id must be a uuid before it can touch the uuid
// column (same guard shape as get_deal's deal_id). Not a tenancy control — the
// turn still scopes history by req.athleteId.
const CONVERSATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SAFEGUARD 1: has the athlete sent CHAT_RATE_LIMIT_PER_HOUR messages in the last hour? (chat and chat v2) */
export async function overChatHourlyCap(athleteId: string): Promise<boolean> {
  const [{ value: recentCount }] = await db
    .select({ value: count() })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.athlete_id, athleteId),
      eq(chatMessages.role, "user"),
      gt(chatMessages.created_at, new Date(Date.now() - 3_600_000)),
    ));
  return Number(recentCount) >= CHAT_RATE_LIMIT_PER_HOUR;
}

export { CHAT_RATE_LIMIT_PER_HOUR };

/** The longest chat message a turn accepts (characters). */
export const MAX_CHAT_MESSAGE_CHARS = 8_000;

/**
 * POST /api/v1/me/chat/stop { conversation_id } — the app's Stop. The client leaving does not stop a Mastra turn
 * (decision 4, docs/design/mila-chat-v2.md), so Stop asks the server: every chat turn of THIS athlete still running in
 * that conversation stops (agent/engine/mastra/turn.ts stopMastraConversation).
 */
router.post("/chat/stop", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const conversationId = (req.body as { conversation_id?: unknown } | undefined)?.conversation_id;
  if (typeof conversationId !== "string" || !CONVERSATION_ID_RE.test(conversationId)) {
    res.status(400).json({ error: "conversation_id must be a uuid" });
    return;
  }
  const { stopMastraConversation } = await import("../agent/engine/mastra/turn");
  res.status(202).json({ stopped: await stopMastraConversation(req.athleteId!, conversationId) });
});

router.post("/chat", requireAuth, chatLimiter, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { message: rawMessage, context, conversation_id, attachments: rawAttachments } = req.body as {
    message?: string;
    context?: { type: string; id?: string };
    conversation_id?: string;
    attachments?: unknown;
  };

  // A typed turn is at most MAX_CHAT_MESSAGE_CHARS (a model call per turn: an unbounded paste is unbounded spend).
  // Checked before anything is read or loaded; a non-string message is refused the same way.
  if (rawMessage !== undefined && rawMessage !== null && typeof rawMessage !== "string") { res.status(400).json({ error: "message must be text" }); return; }
  if (typeof rawMessage === "string" && rawMessage.length > MAX_CHAT_MESSAGE_CHARS) {
    res.status(400).json({ error: "message_too_long", message: `That message is too long. Please keep it under ${MAX_CHAT_MESSAGE_CHARS.toLocaleString("en-US")} characters.`, maxChars: MAX_CHAT_MESSAGE_CHARS });
    return;
  }

  // Attachments (the composer's ＋): ids of media_assets rows the athlete already owns. Parsed
  // strictly, then resolved against THEIR library — an id that is not theirs is a 404 for the whole
  // turn. A turn may be attachments-only; it then reads as "Take a look at this."
  let attachments: MilaAttachment[] = [];
  if (rawAttachments !== undefined) {
    const parsed = attachmentRequestSchema.safeParse(rawAttachments);
    if (!parsed.success) { res.status(400).json({ error: "attachments must be up to 4 of { asset_id, role: photo|video|product }" }); return; }
    try {
      attachments = await loadAttachments(athleteId, parsed.data);
    } catch (err) {
      if (err instanceof AttachmentError) { res.status(err.status).json({ error: err.message }); return; }
      throw err;
    }
  }
  const message = rawMessage?.trim() ? rawMessage : attachments.length ? ATTACHMENT_ONLY_MESSAGE : "";

  if (!message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  // Phase-1 conversation memory: the client mints a uuid per conversation. Accept
  // it ONLY if it's a well-formed uuid — a malformed id must never reach the uuid
  // column (a Postgres cast error would 500 the turn). Anything else → undefined,
  // and the turn runs statelessly (no history, NULL conversation_id).
  const conversationId =
    typeof conversation_id === "string" && CONVERSATION_ID_RE.test(conversation_id)
      ? conversation_id
      : undefined;

  // SAFEGUARD 1: Rate limit — CHAT_RATE_LIMIT_PER_HOUR user messages per hour
  if (await overChatHourlyCap(athleteId)) {
    res.status(429).json({ error: `Rate limit reached — ${CHAT_RATE_LIMIT_PER_HOUR} messages per hour. Try again later.` });
    return;
  }

  // Open SSE stream
  const sse = openSSEStream(res, req);
  sse.status("Thinking…", "thinking");

  // ── Mila's chat turn on Mastra (agent/engine). Attachments (ids and roles, checked above) go with the turn: Mastra
  //    shows them to Mila (agent/engine/mastra/attachments.ts re-checks them at turn time). The old v1 loop
  //    (server/mila/loop.ts) is not used by this route, but it is NOT deleted: it still serves public Ask Mila
  //    (services/askMila/turn.ts, /p/:handle, behind ASK_MILA_PUBLIC). ──
  try {
    await runMilaTurn({ athleteId, message, conversationId, sse, context, attachments: attachments.map((a) => ({ asset_id: a.assetId, role: a.role })) });
  } catch (err: any) {
    if (err?.name === "AbortError") return;
    logger.error({ athleteId, engine: "mastra", error: err?.message }, "Mila chat turn failed");
    sse.error("Mila is unavailable right now — try again in a moment.");
  } finally {
    sse.close();
  }
});

export default router;
