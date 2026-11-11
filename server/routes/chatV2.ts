/**
 * routes/chatV2.ts — Mila's chat v2 (MILA_CHAT_V2, dev only; docs/design/mila-chat-v2.md): the Mastra turn streamed in
 * the AI SDK v7 UI message stream format, for the next app build's chat (assistant-ui). The v1 route (routes/chat.ts)
 * is unchanged.
 *
 *   POST /api/v1/me/chat/v2                  { conversationId?, message: { id?, text, attachments? } } → the UI message stream
 *   GET  /api/v1/me/chat/v2/runs/:runId      → { runId, status: running|completed|stopped|failed, stopReason?, messageIds, conversationId }
 *   POST /api/v1/me/chat/v2/runs/:runId/stop → 202 { status: "stopping" } | 409 (already ended) | 404
 *
 * Mounted only when MILA_CHAT_V2 is "true" at startup (mountChatV2); prod ships "false" and the prod flag guard refuses
 * a deploy that would switch it on. Only the new turn is read: its text and, when she attached something with the
 * composer's ＋, the ids of media she already uploaded (message.attachments: up to 4 of { asset_id, role }, the shape
 * and the checks of POST /me/chat: parsed strictly, then resolved against HER library — an id that is not hers refuses
 * the whole turn). An attachment-only turn reads "Take a look at this.", as on v1. The ids and roles go with the
 * turn: the Mastra turn re-checks them and shows Mila the library's analysis and the pixels
 * (agent/engine/mastra/attachments.ts). Any history, message ids, state, tools or context the client
 * sends are ignored (the server picks every id; Mastra memory holds the thread). Mastra's handleChatStream /
 * chatRoute are NOT used (they trust client history and approvals). The turn is runMilaTurn's Mastra turn, with every
 * guard of #1167 (tenant checks, the deletion fence, the cost caps, one turn per conversation).
 *
 * The client leaving stops the WRITING only (res.on("close")): the turn finishes and is saved (decision 4). The phone
 * catches up with GET /me/conversations/:id and the run status above. Approvals: the turn finishes with the card; the
 * tap is the existing POST /api/v1/pending-actions/:id/approve (decision 3).
 */
import { Router, type Express, type Request, type Response } from "express";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { agentRuns, chatMessages } from "../../shared/schema";
import type { MilaRunStatus } from "../../shared/milaCards";
import { db } from "../db";
import { requireAuth } from "../lib/auth";
import { chatLimiter } from "../lib/rateLimit";
import type { SSEStream } from "../lib/sse";
import { createLogger } from "../logger";
import { MILA_TURN, runMilaTurn } from "../agent/engine";
import { CHAT_RATE_LIMIT_PER_HOUR, MAX_CHAT_MESSAGE_CHARS, overChatHourlyCap } from "./chat";
import { ATTACHMENT_ONLY_MESSAGE, AttachmentError, attachmentRequestSchema, loadAttachments, type MilaAttachment } from "../mila/attachments";

const logger = createLogger("chatV2");

export function chatV2Enabled(): boolean {
  return process.env.MILA_CHAT_V2?.trim() === "true";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The body: only `message.text` and `message.attachments` are used; every other key (history, ids, tools, state) is
 *  stripped. Attachments are checked on their own below, so a bad one gets v1's own answer. */
const bodySchema = z.object({
  conversationId: z.string().regex(UUID_RE).optional(),
  message: z.object({ id: z.string().max(200).optional(), text: z.string(), attachments: z.unknown().optional() }),
});

/** The turn writes nothing to the v1 wire on this route: chat v2 reads it through the tap. */
function silentSse(isClosed: () => boolean = () => false): SSEStream {
  const noop = () => undefined;
  return {
    status: noop, token: noop, done: noop, suggestions: noop, profileUpdates: noop, error: noop, close: noop, abort: noop,
    signal: new AbortController().signal,
    // Whether the phone stopped listening: the turn reads it at its end (a "your reply is ready" push when it had).
    get closed() { return isClosed(); },
  };
}

const RUN_STATUSES = new Set(["completed", "stopped", "failed"]);

export function createChatV2Router(): Router {
  const router = Router();

  router.post("/chat/v2", requireAuth, chatLimiter, async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId!;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "body must be { conversationId?: uuid, message: { text } }" }); return; }
    const typed = parsed.data.message.text;
    if (typed.length > MAX_CHAT_MESSAGE_CHARS) {
      res.status(400).json({ error: "message_too_long", message: `That message is too long. Please keep it under ${MAX_CHAT_MESSAGE_CHARS.toLocaleString("en-US")} characters.`, maxChars: MAX_CHAT_MESSAGE_CHARS });
      return;
    }
    // Attachments (the composer's ＋): ids of media_assets rows she already owns, exactly as POST /me/chat takes them.
    let attachments: MilaAttachment[] = [];
    const rawAttachments = parsed.data.message.attachments;
    if (rawAttachments !== undefined) {
      const att = attachmentRequestSchema.safeParse(rawAttachments);
      if (!att.success) { res.status(400).json({ error: "attachments must be up to 4 of { asset_id, role: photo|video|product }" }); return; }
      try {
        attachments = await loadAttachments(athleteId, att.data);
      } catch (err) {
        if (err instanceof AttachmentError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    }
    const text = typed.trim() ? typed : attachments.length ? ATTACHMENT_ONLY_MESSAGE : "";
    if (!text.trim()) { res.status(400).json({ error: "message is required" }); return; }
    if (await overChatHourlyCap(athleteId)) {
      res.status(429).json({ error: `Rate limit reached — ${CHAT_RATE_LIMIT_PER_HOUR} messages per hour. Try again later.` });
      return;
    }

    const { createChatV2Stream, SSE_DONE, UI_MESSAGE_STREAM_HEADERS, sseFrame } = await import("../agent/engine/mastra/chatV2Stream");
    res.status(200);
    for (const [k, v] of Object.entries(UI_MESSAGE_STREAM_HEADERS)) res.setHeader(k, v);
    res.flushHeaders();
    let closed = false;
    const keepalive = setInterval(() => { if (!closed) res.write(": keepalive\n\n"); }, 15_000);
    // The client left (or the response ended): stop writing. The turn carries on and is saved (decision 4).
    res.on("close", () => { closed = true; clearInterval(keepalive); });
    const write = (chunk: string) => { if (!closed && !res.writableEnded) res.write(chunk); };

    const stream = await createChatV2Stream((part) => write(sseFrame(part)));
    let runId: string | null = null;
    try {
      const result = await runMilaTurn({ athleteId, message: text, conversationId: parsed.data.conversationId, sse: silentSse(() => closed), tap: stream.tap, attachments: attachments.map((a) => ({ asset_id: a.assetId, role: a.role })) });
      runId = result.runId;
      const messageIds = runId ? await savedMessageIds(athleteId, runId) : [];
      await stream.end({ runId, status: result.status, stopReason: result.stopReason ?? null, cards: result.cards }, messageIds);
    } catch (err: any) {
      logger.error({ athleteId, runId, error: err?.message }, "chat v2 turn failed");
      await stream.end({ runId, status: "failed", stopReason: "error", error: true }, []).catch(() => undefined);
    } finally {
      clearInterval(keepalive);
      write(SSE_DONE);
      if (!res.writableEnded) res.end();
    }
  });

  router.get("/chat/v2/runs/:runId", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId!;
    const runId = req.params.runId;
    if (!UUID_RE.test(runId)) { res.status(404).json({ error: "run not found" }); return; }
    const [run] = await db.select({ status: agentRuns.status, stopReason: agentRuns.stop_reason, started: agentRuns.started_at, ended: agentRuns.ended_at, conversationId: agentRuns.conversation_id })
      .from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId))).limit(1);
    if (!run) { res.status(404).json({ error: "run not found" }); return; }
    const status: MilaRunStatus["status"] = !run.ended ? "running" : RUN_STATUSES.has(run.status) ? (run.status as MilaRunStatus["status"]) : "failed";
    const body: MilaRunStatus = {
      runId, status, ...(run.stopReason ? { stopReason: run.stopReason } : {}),
      messageIds: await savedMessageIds(athleteId, runId), conversationId: run.conversationId ?? null,
      // How long the phone keeps waiting: the engine's own turn timeout, and how far into it this run already is
      // (server-measured, so the phone's clock does not matter).
      turnTimeoutMs: MILA_TURN.timeoutMs,
      ...(status === "running" && run.started ? { runningForMs: Math.max(0, Date.now() - run.started.getTime()) } : {}),
    };
    res.json(body);
  });

  router.post("/chat/v2/runs/:runId/stop", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId!;
    const runId = req.params.runId;
    if (!UUID_RE.test(runId)) { res.status(404).json({ error: "run not found" }); return; }
    const { stopMastraRun } = await import("../agent/engine/mastra/turn");
    const r = await stopMastraRun(athleteId, runId);
    if (r === "not_found") { res.status(404).json({ error: "run not found" }); return; }
    if (r === "ended") { res.status(409).json({ error: "run already ended" }); return; }
    res.status(202).json({ status: "stopping" });
  });

  return router;
}

/** The chat rows a run saved (its assistant reply), oldest first. */
async function savedMessageIds(athleteId: string, runId: string): Promise<string[]> {
  const rows = await db.select({ id: chatMessages.id }).from(chatMessages)
    .where(and(eq(chatMessages.athlete_id, athleteId), eq(chatMessages.agent_run_id, runId)))
    .orderBy(asc(chatMessages.created_at));
  return rows.map((r) => String(r.id));
}

/** Mounts chat v2 when MILA_CHAT_V2 is on; off, nothing is mounted (the paths 404). */
export function mountChatV2(app: Pick<Express, "use">): boolean {
  if (!chatV2Enabled()) return false;
  app.use("/api/v1/me", createChatV2Router());
  return true;
}
