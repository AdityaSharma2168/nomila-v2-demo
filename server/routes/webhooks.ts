/**
 * webhooks.ts — Platform webhook handlers.
 *
 * POST /api/webhooks/gmail
 *   Google Pub/Sub push for new Gmail messages.
 *   Body: { message: { data: "<base64>", messageId, publishTime }, subscription }
 *   Decoded data: { emailAddress: "user@gmail.com", historyId: "12345" }
 *
 *   Flow:
 *     1. Decode notification → emailAddress + historyId
 *     2. Look up connected account by platform_username = emailAddress
 *     3. fetchMessagesByHistoryId() → full message bodies
 *     4. detectDeal() per message → classify → score → store
 *
 * GET  /api/webhooks/instagram  — Meta webhook verification handshake (hub.challenge).
 * POST /api/webhooks/instagram  — Instagram Messaging events (real-time DMs).
 *   Verified via X-Hub-Signature-256 (HMAC-SHA256 of the raw body, keyed by the app secret).
 *   Each inbound message → detectDeal(), routed to the connection that owns the IG account.
 *
 * NOTE: this router is mounted with express.raw() (server/index.ts), so req.body is the
 * raw Buffer — required for both Gmail's base64 envelope and Instagram's HMAC signature.
 */

import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { db } from "../db";
import { connectedAccounts, gmailDeadLetters } from "../../shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createLogger } from "../logger";
import { constructWebhookEvent } from "../lib/stripe";
import { processStripeEvent } from "../services/payments/webhook";
import { messageGate } from "../lib/llm";
import { mailboxZeroRetentionEnabled } from "../lib/mailbox/retention";
import type { InboxAttachment } from "../../shared/schema";
import { describeIgMessage, type IgWebhookMessage, type IgMessageShape } from "../lib/integrations/instagramAttachments";

const logger = createLogger("webhooks");
const router = Router();

const IG_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();
// Under Instagram Login the `instagram` webhook is signed with the Instagram app secret;
// fall back to the Facebook app secret so verification still works before the new secret
// is provisioned (during the migration window).
const IG_APP_SECRET   = process.env.INSTAGRAM_LOGIN_APP_SECRET?.trim() ?? process.env.INSTAGRAM_APP_SECRET?.trim();

// Pub/Sub push OIDC verification (N1). When PUBSUB_PUSH_SA is set, every /gmail push
// must carry a Google-signed ID token for that service account, else it's rejected —
// otherwise anyone who finds the URL could forge a historyId and advance the cursor
// past real mail. Unset (dev/test) leaves it open.
const PUBSUB_PUSH_SA       = process.env.PUBSUB_PUSH_SA?.trim();
const PUBSUB_PUSH_AUDIENCE = process.env.PUBSUB_PUSH_AUDIENCE?.trim();
const oidcClient = new OAuth2Client();

async function verifyPubSubPush(req: Request): Promise<boolean> {
  if (!PUBSUB_PUSH_SA) return true; // not configured — don't block (dev/test)
  const header = req.header("authorization") ?? "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  try {
    const ticket  = await oidcClient.verifyIdToken({ idToken: token, audience: PUBSUB_PUSH_AUDIENCE || undefined });
    const payload = ticket.getPayload();
    return payload?.email === PUBSUB_PUSH_SA && payload?.email_verified === true;
  } catch (err: any) {
    logger.warn({ err: err.message }, "Gmail webhook: OIDC verification failed");
    return false;
  }
}

// ─── POST /api/webhooks/gmail ─────────────────────────────────────────────────

router.post("/gmail", async (req: Request, res: Response): Promise<void> => {
  // Verify the push is really from our Pub/Sub SA BEFORE acking or doing any work.
  if (!(await verifyPubSubPush(req))) {
    logger.warn("Gmail webhook: rejected unauthenticated push");
    res.status(403).end();
    return;
  }

  // Acknowledge immediately — Pub/Sub retries on non-2xx within ~30s
  res.status(200).json({ ok: true });

  try {
    const raw      = req.body instanceof Buffer ? req.body.toString("utf-8") : JSON.stringify(req.body);
    const envelope = JSON.parse(raw) as any;
    const dataB64  = envelope?.message?.data as string | undefined;
    if (!dataB64) {
      logger.warn("Gmail webhook: empty message.data");
      return;
    }

    const notification = JSON.parse(
      Buffer.from(dataB64, "base64").toString("utf-8"),
    ) as { emailAddress?: string; historyId?: string };

    const { emailAddress, historyId } = notification;
    if (!emailAddress || !historyId) {
      logger.warn({ notification }, "Gmail webhook: missing emailAddress or historyId");
      return;
    }

    logger.info({ emailAddress, historyId }, "Gmail Pub/Sub notification received");

    // Every active Gmail row on this mailbox, each advancing its own cursor. With one row per account
    // (0071) that is one row per athlete — but two athletes (test accounts) can share a mailbox, and the old
    // `.limit(1)` with no ordering handed the notification to an arbitrary one of them. Case-insensitive:
    // Google's emailAddress and the stored userinfo email can differ in case.
    const accounts = await db
      .select({
        id:               connectedAccounts.id,
        athlete_id:       connectedAccounts.athlete_id,
        gmail_history_id: connectedAccounts.gmail_history_id,
      })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.platform, "gmail"),
          eq(connectedAccounts.status,   "active"),
          sql`lower(${connectedAccounts.platform_username}) = lower(${emailAddress})`,
        ),
      )
      .orderBy(connectedAccounts.created_at, connectedAccounts.id);

    if (accounts.length === 0) {
      logger.warn({ emailAddress }, "Gmail webhook: no active connected account found");
      return;
    }

    // Sequential: each row's processing already fans out per message (messageGate), and the rows are few.
    for (const account of accounts) {
      await processGmailPushForAccount(account, emailAddress, historyId).catch((err: any) =>
        logger.error({ emailAddress, connectionId: account.id, error: err.message }, "Gmail webhook: account processing threw"),
      );
    }
  } catch (err: any) {
    logger.error({ error: err.message }, "Gmail webhook handler threw");
  }
});

/**
 * One Gmail push, for ONE connected row: fetch history since that row's own cursor, run detectDeal, dead-letter
 * failures, advance that row's cursor. Called for every active row on the notified mailbox.
 */
async function processGmailPushForAccount(
  account: { id: string; athlete_id: string; gmail_history_id: string | null },
  emailAddress: string,
  historyId: string,
): Promise<void> {
  const { id: connectionId, athlete_id: athleteId, gmail_history_id: storedHistoryId } = account;
  logger.info({ emailAddress, athleteId, connectionId, storedHistoryId, incomingHistoryId: historyId }, "Gmail webhook: routing to account");

  if (!storedHistoryId) {
    // No cursor yet — store the incoming historyId and wait for the next notification
    await db.update(connectedAccounts)
      .set({ gmail_history_id: historyId })
      .where(eq(connectedAccounts.id, connectionId));
    logger.warn({ emailAddress }, "Gmail webhook: no stored historyId — bootstrapping cursor, no messages fetched");
    return;
  }

  // Fetch messages added since the last stored cursor
  const { fetchMessagesByHistoryId, recoverHistoryGap } = await import("../lib/integrations/gmail.js");

  // to: where the next push starts. The push's historyId, unless the read stopped at its page bound
  // (resumeHistoryId) — then the last record read, so the rest is read next time, not skipped.
  let cursorTo = historyId;
  const advanceCursor = () =>
    db.update(connectedAccounts)
      .set({ gmail_history_id: cursorTo })
      .where(eq(connectedAccounts.id, connectionId));

  let messages: Awaited<ReturnType<typeof fetchMessagesByHistoryId>>;
  try {
    messages = await fetchMessagesByHistoryId(connectionId, storedHistoryId);
  } catch (err) {
    if ((err as Error)?.name !== "HistoryExpiredError") throw err; // cursor stays put; the next push retries
    // The stored cursor is older than Gmail keeps: read the gap by date (read and unread, inbox
    // and sent), then move the cursor to this push. Without this every later push failed the same
    // way until the watch renewal skipped the gap.
    //
    // ONE recovery per expired cursor: claim it first with a compare-and-set (the cursor moves from the
    // expired value to this push's only if no other push already moved it). Concurrent pushes on the same
    // expired cursor used to each run the 14-day recovery. The recovery is idempotent and dead-letters
    // anything it cannot judge, so claiming before recovering loses nothing.
    const claimed = await db.update(connectedAccounts)
      .set({ gmail_history_id: historyId })
      .where(and(eq(connectedAccounts.id, connectionId), eq(connectedAccounts.gmail_history_id, storedHistoryId)))
      .returning({ id: connectedAccounts.id });
    if (!claimed.length) {
      logger.info({ connectionId }, "Gmail webhook: expired cursor already being recovered by another push — skip");
      return;
    }
    try {
      await recoverHistoryGap(connectionId, athleteId);
    } catch (recoverErr) {
      // The gap could not be read (e.g. the Gmail list failed): hand the claim back so the next push recovers it,
      // rather than leaving the cursor past a gap nobody read. Only if no later push has moved it since.
      await db.update(connectedAccounts)
        .set({ gmail_history_id: storedHistoryId })
        .where(and(eq(connectedAccounts.id, connectionId), eq(connectedAccounts.gmail_history_id, historyId)));
      throw recoverErr;
    }
    return;
  }

  if (messages.resumeHistoryId) cursorTo = messages.resumeHistoryId;

  // Listed but not fetched (a transient Gmail error on that one message): dead-letter it so the
  // cron retries it, rather than advancing the cursor past it.
  const unfetched = messages.failedIds ?? [];
  if (unfetched.length) {
    await db.insert(gmailDeadLetters)
      .values(unfetched.map((id) => ({
        connected_account_id: connectionId,
        athlete_id:           athleteId,
        gmail_message_id:     id,
        error:                "fetch failed",
      })))
      .onConflictDoNothing()
      .catch((err: any) => logger.error({ err: err.message }, "Failed to write gmail dead letters (fetch)"));
    logger.warn({ emailAddress, athleteId, count: unfetched.length }, "Gmail webhook: dead-lettered messages that could not be fetched");
  }

  if (messages.length === 0) {
    // Nothing fetched (anything unfetchable is dead-lettered above) → safe to advance now.
    await advanceCursor();
    logger.debug({ emailAddress, historyId }, "Gmail webhook: no new INBOX messages in history");
    return;
  }

  logger.info({ emailAddress, athleteId, count: messages.length }, "Processing new messages");

  // Run deal detection for each message — fire-and-forget per message so one
  // failure doesn't abort the rest, and Pub/Sub already got its 200.
  const { detectDeal } = await import("../skills/dealDetector.js");
  // Bounded, not serial. `allSettled` still sees one promise per message and still resolves
  // in input order, so the index-based result mapping below is untouched — the gate only
  // decides how many run at once. Unbounded, a large history delta started every message
  // together, and each in-flight detectDeal holds database connections for the length of its
  // model calls; the pool is 20 per instance, so the burst hit Postgres before it hit Vertex.
  const results = await Promise.allSettled(
    messages.map((message) => messageGate.run(() => detectDeal({ athleteId, connectionId, message }))),
  );

  let detected = 0, skipped = 0, errored = 0;
  const dropped: { gmailMessageId: string; error: string }[] = [];
  results.forEach((r, i) => {
    const mid = (messages[i] as any)?.gmailMessageId;
    if (r.status === "rejected") {
      errored++;
      if (mid) dropped.push({ gmailMessageId: mid, error: (r.reason as Error)?.message ?? "unknown" });
      logger.error({ error: (r.reason as Error)?.message }, "detectDeal threw");
    } else if (r.value.retryable) {
      // A transient skip (e.g. classifier LLM error) — dead-letter for retry
      // rather than count it as processed and lose it.
      errored++;
      if (mid) dropped.push({ gmailMessageId: mid, error: r.value.reason });
    } else if (r.value.skipped) {
      skipped++;
    } else {
      detected++;
    }
  });

  // Advance the cursor ONLY AFTER processing — a pre-advance loses messages if
  // the instance is reclaimed post-ack (the durability bug this fixes). Pragmatic
  // partial-batch: advance even on per-message failures so a poison message can't
  // freeze the cursor — but dead-letter the dropped ids so the inbox cron can retry
  // them instead of relying only on the unread-2d poll (which misses read/older mail).
  if (dropped.length) {
    await db.insert(gmailDeadLetters)
      .values(dropped.map((d) => ({
        connected_account_id: connectionId,
        athlete_id:           athleteId,
        gmail_message_id:     d.gmailMessageId,
        error:                d.error.slice(0, 500),
      })))
      .onConflictDoNothing()
      .catch((err: any) => logger.error({ err: err.message }, "Failed to write gmail dead letters"));
    logger.error(
      { event: "pipeline_failure", kind: "webhook_drop", emailAddress, athleteId, droppedCount: dropped.length, droppedIds: dropped.map((d) => d.gmailMessageId) },
      "Gmail webhook: dead-lettered messages that failed detectDeal",
    );
  }
  await advanceCursor();

  logger.info(
    { emailAddress, athleteId, detected, skipped, errored, total: messages.length },
    "Gmail webhook processing complete",
  );
}

// ─── GET /api/webhooks/instagram — verification handshake ─────────────────────
// Meta calls this once when you save the callback URL in the App Dashboard. Echo back
// hub.challenge iff hub.verify_token matches the token we configured there.

router.get("/instagram", (req: Request, res: Response): void => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!IG_VERIFY_TOKEN) {
    logger.error("Instagram webhook GET: META_WEBHOOK_VERIFY_TOKEN not configured");
    res.sendStatus(500);
    return;
  }
  if (mode === "subscribe" && token === IG_VERIFY_TOKEN) {
    logger.info("Instagram webhook verified");
    res.status(200).type("text/plain").send(String(challenge ?? ""));
    return;
  }
  logger.warn({ mode }, "Instagram webhook verification failed (bad mode/token)");
  res.sendStatus(403);
});

// Validate Meta's X-Hub-Signature-256 over the raw request body. Returns true iff the
// HMAC-SHA256 (keyed by the app secret) matches — protects against spoofed POSTs.
function validIgSignature(req: Request): boolean {
  if (!IG_APP_SECRET) {
    logger.error("Instagram webhook POST: no Instagram app secret configured (INSTAGRAM_LOGIN_APP_SECRET / INSTAGRAM_APP_SECRET)");
    return false;
  }
  const header = req.header("x-hub-signature-256");
  if (!header?.startsWith("sha256=")) return false;
  const raw      = req.body instanceof Buffer ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
  const expected = "sha256=" + crypto.createHmac("sha256", IG_APP_SECRET).update(raw).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface IgMessagingEvent {
  sender?:    { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?:   IgWebhookMessage;
}
interface IgWebhookEntry {
  id?:        string;            // the Instagram account id (matches connected_accounts.platform_user_id)
  time?:      number;
  messaging?: IgMessagingEvent[];
}

// ─── POST /api/webhooks/instagram — messaging events ──────────────────────────

router.post("/instagram", async (req: Request, res: Response): Promise<void> => {
  if (!validIgSignature(req)) {
    // TEMP DIAG (remove with the payload log below): a rejected POST here would mean a
    // delivery signed by a different app secret (e.g. the old Facebook app's webhook config).
    logger.warn(
      { hasSignature: !!req.header("x-hub-signature-256"), bytes: (req.body as Buffer)?.length },
      "Instagram webhook: signature validation failed — rejected",
    );
    res.sendStatus(403);
    return;
  }
  // Ack within Meta's retry window, then process out of band.
  res.status(200).send("EVENT_RECEIVED");

  try {
    const raw     = req.body instanceof Buffer ? req.body.toString("utf-8") : JSON.stringify(req.body);
    // TEMP DIAG (remove after the DM-ingestion investigation): log every verified payload
    // verbatim so we can see exactly what Meta delivers (echo vs message vs read receipt).
    // MAILBOX_ZERO_RETENTION: the DM text never goes into the logs (a copy like any other).
    if (mailboxZeroRetentionEnabled()) {
      logger.info({ bytes: raw.length }, "Instagram webhook payload received");
    } else {
      // Attachment urls are signed Graph CDN links (signature= / oh= in the query): never logged.
      logger.info({ payload: raw.slice(0, 4000).replace(/("url"\s*:\s*")[^"]*"/g, '$1[redacted]"') }, "Instagram webhook raw payload");
    }
    const payload = JSON.parse(raw) as { object?: string; entry?: IgWebhookEntry[] };
    const entries = payload.entry ?? [];

    // Collect every inbound message + the account ids it could map to. A message with text goes to deal
    // detection; one holding only an attachment is recorded on its thread with a placeholder ("[Photo]") and
    // never classified; one we cannot read is dead-lettered (lib/integrations/instagramAttachments). Events with
    // no `message` (reactions, read receipts) are not messages and are skipped as before.
    const inbound: Array<{ accountIds: string[]; senderId: string; mid: string; shape: Exclude<IgMessageShape, { kind: "deleted" }>; ts: number }> = [];
    for (const entry of entries) {
      for (const ev of entry.messaging ?? []) {
        const senderId = ev.sender?.id;
        const mid      = ev.message?.mid;
        if (!ev.message || ev.message.is_echo) continue;   // not a message / our own outbound — skip
        if (!senderId || !mid) {
          logger.warn({ hasSender: !!senderId, hasMid: !!mid }, "Instagram webhook: message event without sender or mid — skipped");
          continue;
        }
        const shape = describeIgMessage(ev.message);
        if (shape.kind === "deleted") {
          logger.info({ mid }, "Instagram webhook: message unsent by the sender — nothing to record");
          continue;
        }
        const accountIds = [entry.id, ev.recipient?.id].filter((x): x is string => !!x);
        inbound.push({ accountIds, senderId, mid, shape, ts: ev.timestamp ?? entry.time ?? Date.now() });
      }
    }

    if (inbound.length === 0) {
      logger.debug({ object: payload.object }, "Instagram webhook: no inbound messages (reactions / read receipts / echoes)");
      return;
    }

    // Map each candidate account id → the connection that owns it. Under Instagram Login
    // the webhook's entry.id is the IG account id, which we store as platform_user_id.
    const candidateIds = [...new Set(inbound.flatMap(m => m.accountIds))];
    const conns = await db
      .select({
        id:               connectedAccounts.id,
        athlete_id:       connectedAccounts.athlete_id,
        platform_user_id: connectedAccounts.platform_user_id,
      })
      .from(connectedAccounts)
      .where(and(
        eq(connectedAccounts.platform, "instagram"),
        eq(connectedAccounts.status,   "active"),
        inArray(connectedAccounts.platform_user_id, candidateIds),
      ));

    const byAccountId = new Map<string, { id: string; athleteId: string }>();
    for (const c of conns) {
      if (c.platform_user_id) byAccountId.set(c.platform_user_id, { id: c.id, athleteId: c.athlete_id });
    }

    const { detectDeal }      = await import("../skills/dealDetector.js");
    const { resolveDmContext } = await import("../lib/integrations/instagram.js");
    const { recordIgPlaceholderMessage, deadLetterIgMessage } = await import("../lib/integrations/instagramAttachments.js");

    let detected = 0, skipped = 0, errored = 0, unrouted = 0, placeholders = 0, deadLettered = 0;
    for (const m of inbound) {
      const conn = m.accountIds.map(id => byAccountId.get(id)).find(Boolean);
      if (!conn) {
        unrouted++;
        if (m.shape.kind !== "text") logger.warn({ mid: m.mid, kind: m.shape.kind }, "Instagram webhook: non-text DM for no connected account — not recorded");
        continue;
      }

      try {
        if (m.shape.kind === "unknown") {
          await deadLetterIgMessage({ athleteId: conn.athleteId, connectionId: conn.id, messageId: m.mid, reason: m.shape.reason });
          deadLettered++;
          continue;
        }
        // Resolve conversation id + sender name so this lands on the same thread the
        // backfill path creates (keyed by IG conversation id).
        const ctx  = await resolveDmContext(conn.id, m.senderId);
        const name = ctx.senderName ?? m.senderId;
        if (m.shape.kind === "placeholder") {
          // Attachment only: on the thread, never through deal detection ("[Photo]" is not text a brand wrote).
          await recordIgPlaceholderMessage({
            athleteId:      conn.athleteId,
            connectionId:   conn.id,
            threadKey:      ctx.conversationId ?? `ig:${m.senderId}`,
            messageId:      m.mid,
            senderIgUserId: m.senderId,
            senderName:     name,
            placeholder:    m.shape.placeholder,
            attachments:    m.shape.attachments,
            at:             new Date(m.ts),
          });
          placeholders++;
          continue;
        }
        const attachments: InboxAttachment[] = m.shape.attachments;
        const r = await detectDeal({
          athleteId:    conn.athleteId,
          connectionId: conn.id,
          message: {
            gmailMessageId:  m.mid,
            gmailThreadId:   ctx.conversationId ?? `ig:${m.senderId}`,
            subject:         `DM from ${name}`,
            from:            name,
            body:            m.shape.text,
            date:            new Date(m.ts).toISOString(),
            platform:        "instagram",
            senderIgUserId:  m.senderId,
            messageIdHeader: null,
            ...(attachments.length ? { attachments } : {}),
          },
        });
        if (r.skipped) skipped++; else detected++;
      } catch (err: any) {
        errored++;
        logger.error({ connectionId: conn.id, error: err.message }, "Instagram webhook detectDeal threw");
      }
    }

    logger.info({ total: inbound.length, detected, skipped, errored, unrouted, placeholders, deadLettered }, "Instagram webhook processing complete");
  } catch (err: any) {
    logger.error({ error: err.message }, "Instagram webhook handler threw");
  }
});

// ─── POST /api/webhooks/stripe (+ /stripe/connect) — commission-engine payment events ──
// Signature-verified over the RAW body (this router is mounted with express.raw, so
// req.body is the Buffer). Two Stripe endpoints with their own signing secrets:
//   /stripe          STRIPE_WEBHOOK_SECRET          platform events (Checkout, PIs, charges, transfers, refunds, disputes)
//   /stripe/connect  STRIPE_CONNECT_WEBHOOK_SECRET  connected-account events (account.updated)
// Both feed the same idempotent dispatch in server/services/payments/webhook.ts (event
// ids are globally unique, so one ledger serves both).

function stripeWebhookHandler(endpoint: "platform" | "connect") {
  return async (req: Request, res: Response): Promise<void> => {
    const signature = req.header("stripe-signature");
    if (!signature) {
      res.status(400).json({ error: "missing stripe-signature header" });
      return;
    }

    let event;
    try {
      const raw = req.body instanceof Buffer ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
      event = constructWebhookEvent(raw, signature, endpoint);
    } catch (err: any) {
      logger.warn({ endpoint, error: err.message?.slice(0, 120) }, "Stripe webhook signature verification failed");
      res.status(400).json({ error: "invalid signature" });
      return;
    }

    try {
      const { duplicate } = await processStripeEvent(event);
      res.status(200).json({ received: true, duplicate });
    } catch (err: any) {
      // 500 → Stripe redelivers. The event stays unprocessed in the ledger, so the retry
      // reprocesses it (only a PROCESSED event id is treated as a duplicate).
      logger.error({ endpoint, eventId: event.id, type: event.type, error: err.message }, "Stripe webhook processing failed");
      res.status(500).json({ error: "processing failed" });
    }
  };
}

router.post("/stripe", stripeWebhookHandler("platform"));
router.post("/stripe/connect", stripeWebhookHandler("connect"));

export default router;
