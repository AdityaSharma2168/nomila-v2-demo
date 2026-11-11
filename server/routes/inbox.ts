/**
 * inbox.ts — Inbox thread endpoints.
 *
 * GET /api/v1/me/inbox/threads     — list threads (filters: status, is_deal, category)
 * GET /api/v1/me/inbox/threads/:id — thread detail with messages and brand
 */

import { Router, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { deliveredOnly } from "../services/relay/delivered";
import { db } from "../db";
import { inboxThreads, inboxMessages, inboxBrands, agentActions } from "../../shared/schema";
import { requireAuth } from "../lib/auth";
import { writeAgentAction } from "../lib/agentActions";
import { resolveThreadInbox, toInboxPayload } from "../services/threadInbox";
import { readThreadConversation, type LiveMessage } from "../services/liveConversation";
import { reclassifyThread } from "../services/reclassifyThread";
import { mailboxZeroRetentionEnabled } from "../lib/mailbox/retention";
import { presentThread, threadColumns } from "../lib/threadTitle";
import { createLogger } from "../logger";
import { isFooterOnly } from "../../shared/emailFooter";

const logger = createLogger("routes/inbox");
const router = Router();

// The status allowlist for a thread. `archived` IS the "filed" disposition Files
// (WS5 5A) reads — there is no separate `filed` value: the DB check constraint
// (inbox_threads_status_check) allows this exact set, and `archived` already lives
// in it, so filing needs no schema change. "Pull it back" PATCHes a filed thread
// to `deal_detected` (a deal) or `read` (non-deal) to re-surface it in the Brief.
const VALID_THREAD_STATUSES = ["unread", "read", "starred", "archived", "deal_detected"] as const;

// ─── GET /api/v1/me/inbox/threads ────────────────────────────────────────────

router.get("/inbox/threads", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { status, is_deal, category } = req.query as Record<string, string>;

  const filters = [eq(inboxThreads.athlete_id, athleteId)];

  if (status && VALID_THREAD_STATUSES.includes(status as typeof VALID_THREAD_STATUSES[number])) {
    filters.push(eq(inboxThreads.status, status));
  }
  if (is_deal === "true") {
    filters.push(eq(inboxThreads.status, "deal_detected"));
  }

  const rows = await db
    .select({
      id:              inboxThreads.id,
      // Zero retention: the stored subject is not read (presentThread adds the derived title).
      subject:         mailboxZeroRetentionEnabled() ? sql<string | null>`NULL` : inboxThreads.subject,
      summary:         inboxThreads.summary,
      status:          inboxThreads.status,
      classification:  inboxThreads.classification,
      last_message_at: inboxThreads.last_message_at,
      message_count:   inboxThreads.message_count,
      deal_id:         inboxThreads.deal_id,
      brand_name:      inboxBrands.name,
      brand_logo:      inboxBrands.logo_url,
      brand_category:  inboxBrands.category,
    })
    .from(inboxThreads)
    .leftJoin(inboxBrands, eq(inboxBrands.id, inboxThreads.brand_id))
    .where(and(...filters))
    .orderBy(desc(inboxThreads.last_message_at))
    .limit(100);

  // Filter by email classification category (PAID, MEDIA, FAN, etc.) stored in classification JSONB
  const filtered = category
    ? rows.filter((r) => (r.classification as any)?.category?.toUpperCase() === category.toUpperCase())
    : rows;

  logger.debug({ athleteId, count: filtered.length, status, is_deal, category }, "Inbox threads listed");
  // Zero retention: no stored subject goes out; a Nomila-written title does.
  res.json(filtered.map((r) => presentThread(r, r.brand_name)));
});

// ─── GET /api/v1/me/inbox/threads/:id ────────────────────────────────────────

router.get("/inbox/threads/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const threadId  = req.params.id;

  const [thread] = await db
    .select(threadColumns())
    .from(inboxThreads)
    .where(and(eq(inboxThreads.id, threadId), eq(inboxThreads.athlete_id, athleteId)))
    .limit(1);

  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  // MAILBOX_LIVE_READS: the conversation comes from the mailbox, is sent once with
  // no-store, and is kept nowhere. A failed read degrades to an explained empty view —
  // the thread, its deal and its summary are untouched. null = no live reader for this
  // provider (flag off, Instagram, Outlook until its adapter lands): stored path below.
  const live = await readThreadConversation(athleteId, threadId);
  let messages: unknown[];
  let conversation: { available: boolean; reason?: string; message?: string } | undefined;
  if (live) {
    res.setHeader("Cache-Control", "no-store");
    if (live.ok) {
      messages = live.messages.slice(-THREAD_WINDOW).map((m) => liveThreadMessage(m, live.provider));
      conversation = { available: true };
    } else {
      messages = [];
      conversation = { available: false, reason: live.reason, message: live.message };
    }
  } else {
    // Newest window, flipped back to chronological — asc+limit anchored to the
    // OLDEST 30 and silently dropped new replies once a thread outgrew it.
    messages = (await db
      .select()
      .from(inboxMessages)
      // A relayed message the moderation check held or blocked was never delivered: not shown (and its held text,
      // kept in held_body, never leaves the server on this route).
      .where(and(eq(inboxMessages.thread_id, threadId), deliveredOnly()))
      .orderBy(desc(inboxMessages.received_at))
      .limit(THREAD_WINDOW)).reverse()
      // Attachments as names and types only: the object path and mailbox ref never leave the server.
      .map((m: any) => withAttachmentMeta(m, (m.attachments ?? []).map((a: any) => ({ filename: a.filename, content_type: a.content_type }))));
  }

  const brand = thread.brand_id
    ? await db
        .select()
        .from(inboxBrands)
        .where(eq(inboxBrands.id, thread.brand_id))
        .limit(1)
        .then((r) => r[0] ?? null)
    : null;

  // The inbox THIS thread answers through and what it can do (not "any Gmail row"), so
  // the app can offer draft/send — or name the account to reconnect — per thread.
  const inbox = toInboxPayload(await resolveThreadInbox(athleteId, threadId));

  res.json({ thread: presentThread(thread, brand?.name ?? null), messages, brand, inbox, ...(conversation ? { conversation } : {}) });
});

const THREAD_WINDOW = 50;

/** A live mailbox message in the shape the app's ThreadMessage already reads. */
function liveThreadMessage(m: LiveMessage, provider: string) {
  return withAttachmentMeta({
    id:           m.rowId ?? m.ref.messageRef,
    direction:    m.direction,
    sender_name:  m.direction === "outbound" ? (m.fromName ?? "You") : m.fromName,
    sender_email: m.fromEmail,
    subject:      m.subject,
    body:         m.text,
    received_at:  m.sentAt,
    platform:     provider,
  }, m.attachments.filter((a) => a.kind === "file").map((a) => ({ filename: a.filename, content_type: a.mimeType })));
}

/**
 * The message with its attachments' names and types, and `footer_only` when its text is only a legal notice and it
 * carries a file: the content is in the attachment, so the app shows that instead of the notice as the message.
 */
function withAttachmentMeta<T extends { body?: string | null }>(message: T, attachments: Array<{ filename: string; content_type: string }>) {
  return { ...message, attachments, footer_only: attachments.length > 0 && isFooterOnly(message.body) };
}

// ─── PATCH /api/v1/me/inbox/threads/:id ──────────────────────────────────────
// The archive/file write path (WS5 5A). Sets a thread's status (validated against
// the allowlist + ownership). Filing = `status: "archived"`; "Pull it back" =
// PATCH to `deal_detected` / `read`. Returns the updated thread.

router.patch("/inbox/threads/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const threadId  = req.params.id;
  const { status } = req.body as { status?: string };

  if (!status || !VALID_THREAD_STATUSES.includes(status as typeof VALID_THREAD_STATUSES[number])) {
    res.status(400).json({ error: `status must be one of: ${VALID_THREAD_STATUSES.join(", ")}` });
    return;
  }

  // Ownership: only the thread's owner may change its status.
  const [owned] = await db
    .select({ id: inboxThreads.id })
    .from(inboxThreads)
    .where(and(eq(inboxThreads.id, threadId), eq(inboxThreads.athlete_id, athleteId)))
    .limit(1);
  if (!owned) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const [updated] = await db
    .update(inboxThreads)
    .set({ status })
    .where(and(eq(inboxThreads.id, threadId), eq(inboxThreads.athlete_id, athleteId)))
    .returning(threadColumns());

  logger.info({ athleteId, threadId, status }, "Thread status patched");
  res.json(presentThread(updated));
});

// ─── POST /api/v1/me/inbox/threads/:id/reclassify ────────────────────────────
// One-shot re-run of classify for a thread (WS5 5C Couldn't-read + 5E
// From People): turn a mis-piled item into a deal. Re-classifies off the thread's
// most-recent inbound message and
// writes it back to the thread (mirrors detectDeal's write). When it becomes a
// deal it flips status → deal_detected so it enters the Brief/Files pipeline.

router.post("/inbox/threads/:id/reclassify", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const r = await reclassifyThread(req.athleteId!, req.params.id);
  if (!r.ok) {
    res.status(r.status).json({ error: r.error, ...(r.code ? { code: r.code, reason: r.reason } : {}) });
    return;
  }
  // `score` stays in the response as null for app builds that still read it; the deal score is gone (0088).
  res.json({ thread: presentThread(r.thread), classification: r.classification, score: null, outcome: r.outcome });
});

// ─── POST /api/v1/me/inbox/threads/:id/reply ─────────────────────────────────
// RETIRED (12 Oct 2026). This was a direct send: no proposal, no approved-body hash, no
// proof of her tap. Every app build since 6 Oct proposes a `send_reply` pending action and
// approves it with body_sha256 (routes/pendingActions.ts) — the one governed send path.
// Nothing is sent from here any more; an old caller is told where to go instead.

router.post("/inbox/threads/:id/reply", requireAuth, (_req: Request, res: Response): void => {
  res.status(410).json({
    error: "Update the app to send replies. Nothing was sent.",
    code:  "ROUTE_RETIRED",
  });
});

// ─── POST /api/v1/me/inbox/senders/mute ──────────────────────────────────────
// The server-side sender mute, replacing the device-local AsyncStorage store in
// client/components/deals/people/muteStore.ts — whose own TODO says "server mute
// endpoint (WS5 follow-up) ... so mutes sync across devices instead of being
// device-local".
//
// A mute is stored as an agent_actions row, not a new table, because senderMemory
// already reads that log and the receipt gives undo and an audit trail for free.
// It is REVERSIBLE: unmuting deletes the row, and the implicit count-based rules in
// senderMemory keep working either way.
//
// Body: { email: string, muted?: boolean }   (muted defaults to true)
router.post("/inbox/senders/mute", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { email, muted } = req.body as { email?: string; muted?: boolean };
  const addr = (email ?? "").toLowerCase().trim();

  if (!addr || !addr.includes("@") || addr.length > 320) {
    res.status(400).json({ error: "email must be a valid address" });
    return;
  }
  const on = muted !== false;

  if (on) {
    await writeAgentAction({
      athleteId,
      action:     "mute_sender",
      reversible: true,
      reason:     `Muted ${addr} — future mail from this sender is filed automatically`,
      payload:    { sender_email: addr, source: "athlete" },
    });
  } else {
    await db
      .delete(agentActions)
      .where(and(
        eq(agentActions.athlete_id, athleteId),
        eq(agentActions.action, "mute_sender"),
        sql`${agentActions.payload} ->> 'sender_email' = ${addr}`,
      ));
  }

  logger.info({ athleteId, addr, muted: on }, "Sender mute updated");
  res.json({ ok: true, email: addr, muted: on });
});

export default router;
