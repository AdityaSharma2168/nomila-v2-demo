/**
 * threadReply.ts — the single send path for an outbound reply on an inbox thread.
 *
 * Extracted verbatim from the POST /inbox/threads/:id/reply handler so there is ONE
 * source of send truth: the route calls it, and the co-pilot `pending_action` approve
 * endpoint (WS3 §3.6) calls the SAME function — an approved action executes exactly the
 * reply the athlete would have sent by hand, through the inbox that received the deal.
 *
 * It returns a discriminated result instead of writing to `res`, so any caller (an
 * Express route, an action executor, a future job) can map it. Behavior — inbox
 * routing, threading recovery, reconnect/scope flagging, mechanical turn-flip + re-summarize —
 * is unchanged from the original route; the reply-route tests still exercise all of it.
 *
 * Per-platform sending is dispatched through the ONE reply-platform table (lib/replyPlatforms.ts),
 * the same table the card's send gate derives from — a platform with no sender there, or whose
 * switch is off (Outlook without OUTLOOK_SEND), is refused here exactly as the card says.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { inboxThreads, inboxMessages, connectedAccounts } from "../../shared/schema";
import { createLogger } from "../logger";
import { inboxBodyFingerprint } from "../lib/inboxBodyFingerprint";
import { INSUFFICIENT_SCOPE_ERROR } from "../lib/connectionScopes";
import { resolveThreadInbox, toInboxRef, type InboxRef } from "./threadInbox";
import { resolveReplyEnvelope } from "./replyEnvelope";
import { mailboxZeroRetentionEnabled, retainsMessageContent } from "../lib/mailbox/retention";
import { replyPlatform } from "../lib/replyPlatforms";
import { reconnectRequired, scopeMissing, type MailboxSendContext } from "./replySenders";

const logger = createLogger("services/threadReply");

// Upper bound on an outbound reply. `express.json()`'s 100kb default already caps the
// request, but that's an accident of transport rather than a rule about replies — this
// makes the limit explicit and rejects with a usable message instead of a parser error.
// A real reply is a few hundred to a few thousand characters; 25k is far above any
// legitimate email while still bounding what we hand to Gmail.
const MAX_REPLY_CHARS = 25_000;

export type ThreadReplyResult =
  | {
      ok: true;
      /**
       * The RFC 5322 Message-ID the provider gave the sent reply, when it said (Gmail). Kept on
       * the approved pending action as the audit pointer to the mailbox's Sent copy.
       */
      sentMessageId?: string | null;
    }
  | {
      ok: false;
      status: number;
      error: string;
      /**
       * RECONNECT_REQUIRED (401) — the thread's inbox is revoked, expired or gone.
       * SCOPE_MISSING (403)      — the inbox is connected but its grant can't send.
       */
      code?: string;
      /**
       * Set alongside RECONNECT_REQUIRED to the code clients before PR C matched on
       * (`code === "REAUTH_REQUIRED"`), so an old build still shows its reconnect hint.
       */
      legacy_code?: string;
      /** The inbox the failure is about, so the app can name and reconnect it. */
      inbox?: InboxRef;
    };

/**
 * Send `rawBody` as an outbound reply on `threadId`, owned by `athleteId`.
 *
 * Never throws for expected failure modes (bad input, missing connection, dead grant,
 * unrecoverable threading) — those come back as `{ ok: false, status, error, code? }`
 * so the caller can decide how to surface them. Records the outbound message and flips
 * the thread's turn state on success.
 */
export async function sendThreadReply(
  athleteId: string,
  threadId: string,
  rawBody: string,
): Promise<ThreadReplyResult> {
  if (!rawBody?.trim()) {
    return { ok: false, status: 400, error: "body is required" };
  }
  if (rawBody.length > MAX_REPLY_CHARS) {
    return { ok: false, status: 400, error: `Reply is too long (max ${MAX_REPLY_CHARS.toLocaleString()} characters)` };
  }
  const body = rawBody;

  // Zero retention never reads a stored subject (the envelope reads it live instead).
  const [thread] = await db
    .select({
      id:           inboxThreads.id,
      subject:      mailboxZeroRetentionEnabled() ? sql<string | null>`NULL` : inboxThreads.subject,
      latest_draft: inboxThreads.latest_draft,
    })
    .from(inboxThreads)
    .where(and(eq(inboxThreads.id, threadId), eq(inboxThreads.athlete_id, athleteId)))
    .limit(1);

  if (!thread) {
    return { ok: false, status: 404, error: "Thread not found" };
  }

  // All inbound messages, newest first. We reply to the most recent one (the
  // person we're responding to), but pull threading metadata from the most
  // recent message that actually has it — older ingestion runs and duplicate
  // rows can lack the Message-ID header / thread id.
  // Ids and routing columns only — no stored text is loaded.
  const inboundMsgs = await db
    .select({
      id:                      inboxMessages.id,
      sender_email:            inboxMessages.sender_email,
      sender_ig_user_id:       inboxMessages.sender_ig_user_id,
      platform:                inboxMessages.platform,
      external_message_id:     inboxMessages.external_message_id,
      gmail_thread_id:         inboxMessages.gmail_thread_id,
      gmail_message_id_header: inboxMessages.gmail_message_id_header,
      connected_account_id:    inboxMessages.connected_account_id,
      received_at:             inboxMessages.received_at,
    })
    .from(inboxMessages)
    .where(and(eq(inboxMessages.thread_id, threadId), eq(inboxMessages.direction, "inbound")))
    .orderBy(desc(inboxMessages.received_at));

  const lastInbound = inboundMsgs[0];

  if (!lastInbound) {
    return { ok: false, status: 400, error: "No inbound messages to reply to" };
  }

  const platform = lastInbound.platform ?? "gmail";

  // The one table both the send gate and this path read. Off or unknown ⇒ refused, before any lookup.
  const entry = replyPlatform(platform);
  if (!entry || !entry.enabled()) {
    return { ok: false, status: 400, error: `Unsupported platform: ${platform}` };
  }

  // A request from her public card: her reply goes through Nomila's relay (moderated, sent from Nomila's address with
  // a content-free notice), never through her own mailbox — services/partner/threads.ts.
  if (entry.sender.kind === "relay") return entry.sender.send(athleteId, threadId, body);
  const sendMailbox = entry.sender.send;

  // The inbox that received this thread, when ingest recorded it (newest inbound message
  // with a connection, else the thread's) — the same rule draft save and the thread
  // payload use, via resolveThreadInbox. Older rows predate the connected_account_id
  // column and resolve lazily in the Gmail/Instagram senders.
  const storedInbox = await resolveThreadInbox(athleteId, threadId);

  const now = new Date();
  // Filled by the platform's sender: the connection it sent through (also what the catch flags on a
  // dead grant), the inbox every failure names, and the thread / Message-ID the outbound row stores.
  const out: MailboxSendContext["out"] = {
    accountId:               null,
    inboxRef:                toInboxRef(storedInbox),
    outboundThreadId:        lastInbound.gmail_thread_id ?? null,
    outboundMessageIdHeader: null,
  };

  try {
    // Recipient + subject. A stored address / subject is used when there is one; under
    // MAILBOX_ZERO_RETENTION the thread has no subject and a non-counterparty sender is only a
    // pseudonym, so the newest inbound message is read live for them (nothing is stored).
    // Only Gmail builds its own envelope; Instagram has none, and Graph's /reply addresses itself.
    const envelope = platform === "gmail"
      ? await resolveReplyEnvelope(mailboxZeroRetentionEnabled() ? null : thread.subject, inboundMsgs)
      : { toEmail: null, subject: thread.subject ?? null };

    const failed = await sendMailbox({
      athleteId, threadId, body: body.trim(), inboundMsgs, storedInbox, envelope, out,
    });
    if (failed) return failed;
    const { accountId, outboundThreadId, outboundMessageIdHeader } = out;

    // Store outbound message. Persist the thread id and the Message-ID Gmail gave
    // our reply so the next reply in this thread can chain its References off it.
    //
    // onConflictDoNothing is REQUIRED, not defensive. The email is already sent by
    // this point, so a throw here 500s a reply that actually went out — leaving the
    // draft on screen for the athlete to send a second time. Gmail's Pub/Sub can fire
    // for the SENT copy during the readback above (a multi-second window: messages.get
    // plus PDF re-hosting), and that webhook's self-sender gate inserts an outbound row
    // with this very Message-ID. Under the unique index on (athlete_id,
    // gmail_message_id_header) whichever insert loses must lose quietly.
    // Zero retention: the sent copy lives in the mailbox's Sent folder; Nomila keeps the
    // fingerprint (the echo gate's key) and the ids, not the text.
    const keepContent = retainsMessageContent(platform);
    await db.insert(inboxMessages).values({
      thread_id:    threadId,
      athlete_id:   athleteId,
      sender_email: null,
      sender_name:  null,
      direction:    "outbound",
      subject:      keepContent ? (thread.subject ?? null) : null,
      body:         keepContent ? body.trim() : null,
      body_sha256:  inboxBodyFingerprint(body),
      received_at:  now,
      platform,
      gmail_thread_id:         outboundThreadId,
      gmail_message_id_header: outboundMessageIdHeader,
      connected_account_id:    accountId,
    }).onConflictDoNothing().returning({ id: inboxMessages.id });

    // Update thread — clear in-app draft; drop mirrored Gmail draft if present.
    const prevDraft = (thread.latest_draft && typeof thread.latest_draft === "object")
      ? (thread.latest_draft as Record<string, unknown>)
      : null;
    const gmailDraftId = typeof prevDraft?.gmail_draft_id === "string" ? prevDraft.gmail_draft_id : null;

    // Delete the mirrored Gmail draft FIRST — awaited, with retry (#164 M1). If we null
    // latest_draft/gmail_draft_id before the draft is gone and the delete then fails, the
    // orphaned Gmail draft can be sent by hand → a duplicate outbound. Keep the id until
    // the delete is confirmed; only clear the pointer once it is gone.
    let draftCleared = true;
    if (gmailDraftId && accountId && platform === "gmail") {
      const { deleteGmailDraft } = await import("../lib/integrations/gmail.js");
      draftCleared = false;
      for (let attempt = 1; attempt <= 3 && !draftCleared; attempt++) {
        draftCleared = await deleteGmailDraft(accountId, gmailDraftId);
        if (!draftCleared && attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt));
      }
      if (!draftCleared) {
        logger.error({ athleteId, threadId, gmailDraftId }, "Could not delete mirrored Gmail draft after retries — keeping the pointer");
      }
    }

    // message_count counts rows, so it may only move when a row was actually added — the
    // webhook that beat us here already bumped it. Recomputed rather than incremented so
    // the two paths cannot double-count under the same race.
    await db.update(inboxThreads).set({
      last_message_at: now,
      message_count:   sql`(SELECT count(*) FROM ${inboxMessages} WHERE ${inboxMessages.thread_id} = ${threadId})`,
      // Only clear the in-app draft once the Gmail draft is confirmed gone. If the delete
      // failed we keep latest_draft (incl. gmail_draft_id) so a later retry still knows
      // which draft to remove, rather than orphaning it.
      ...(draftCleared ? { latest_draft: null } : {}),
    }).where(eq(inboxThreads.id, threadId));

    // Flip the turn state BEFORE responding — the client invalidates the deals
    // list on success, and that refetch must already see awaiting "brand".
    // Mechanical (no LLM), so awaiting it costs one small UPDATE.
    const { summarizeThread, updateMechanicalThreadState } = await import("../skills/threadSummarizer.js");
    await updateMechanicalThreadState(threadId).catch((err: any) =>
      logger.warn({ threadId, err: err.message }, "Mechanical thread-state update failed (outbound reply)"),
    );

    // Re-summarize so the judgment fields (offer/ask/summary) refresh too.
    // Fire-and-forget — the send already succeeded.
    summarizeThread(threadId).catch((err: any) =>
      logger.warn({ threadId, err: err.message }, "threadSummarizer threw (outbound reply)"),
    );

    logger.info({ athleteId, threadId, platform }, "Reply sent");
    return { ok: true, sentMessageId: outboundMessageIdHeader };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // A dead/revoked OAuth grant can't be refreshed. Flag the connection so the
    // UI prompts a reconnect, and return a clear error instead of throwing — an
    // unhandled throw yields a 503 with no CORS headers, which the browser
    // mislabels as a "CORS policy" failure.
    if (/invalid_grant|expired or revoked|has been (expired|revoked)|must reconnect|no .*refresh token/i.test(msg)) {
      if (out.accountId) {
        await db.update(connectedAccounts)
          .set({ status: "revoked" })
          .where(eq(connectedAccounts.id, out.accountId))
          .catch(() => {});
      }
      logger.warn({ athleteId, threadId, platform }, "Reply failed: connection needs reauth");
      const who = out.inboxRef?.email ? ` (${out.inboxRef.email})` : "";
      return reconnectRequired(
        `Your ${entry.label} connection${who} has expired. Please reconnect it in Settings and try again.`,
        out.inboxRef,
      );
    }
    // Google refuses a send the grant isn't scoped for with a 403 "insufficient
    // authentication scopes". That is not transient — "try again" would never work — so
    // it maps to SCOPE_MISSING and names the inbox to reconnect.
    if (platform === "gmail" && INSUFFICIENT_SCOPE_ERROR.test(msg)) {
      logger.warn({ athleteId, threadId, connectionId: out.accountId }, "Reply failed: Gmail grant lacks send scope");
      return scopeMissing("gmail", out.inboxRef);
    }
    logger.error({ athleteId, threadId, platform, err: msg }, "Reply send failed");
    return { ok: false, status: 502, error: "Couldn't send your reply. Please try again." };
  }
}
