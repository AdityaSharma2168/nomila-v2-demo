/**
 * replySenders.ts — one sender per mailbox platform, dispatched by `sendThreadReply` through the
 * reply-platform table (lib/replyPlatforms.ts).
 *
 * The Gmail and Instagram bodies are the branches that used to sit inline in `sendThreadReply`,
 * moved here unchanged. Each picks the exact connection that received the thread, sends, and
 * records what the shared tail of `sendThreadReply` needs on `ctx.out` (the connection, and the
 * thread / Message-ID the outbound row stores). Storing the row, clearing the draft and flipping
 * the turn stay in `sendThreadReply`, shared by every platform.
 *
 * Callers: `sendThreadReply` only, reached only from an approved pending action (her tap, the
 * approved-body hash, claim-once). Nothing else may import a sender.
 */

import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { inboxThreads, inboxMessages, connectedAccounts } from "../../shared/schema";
import { createLogger } from "../logger";
import { replyPlatform } from "../lib/replyPlatforms";
import type { ThreadReplyResult } from "./threadReply";
import type { InboxRef, ThreadInbox } from "./threadInbox";
import type { ReplyEnvelope } from "./replyEnvelope";

const logger = createLogger("services/replySenders");

export type MailboxSendFailure = Extract<ThreadReplyResult, { ok: false }>;

/** The inbound rows `sendThreadReply` loads (ids and routing columns only — no stored text). */
export interface InboundRow {
  id:                      string;
  sender_email:            string | null;
  sender_ig_user_id:       string | null;
  platform:                string | null;
  external_message_id:     string | null;
  gmail_thread_id:         string | null;
  gmail_message_id_header: string | null;
  connected_account_id:    string | null;
  received_at:             Date | null;
}

export interface MailboxSendContext {
  athleteId:   string;
  threadId:    string;
  /** The reply text, already trimmed — exactly what is sent and fingerprinted. */
  body:        string;
  /** Newest first. `inboundMsgs[0]` is the message being answered. */
  inboundMsgs: InboundRow[];
  /** The inbox that received the thread (threadInbox.ts), or null for a legacy row. */
  storedInbox: ThreadInbox | null;
  /** Recipient + subject, resolved by `sendThreadReply` for platforms that need it (Gmail). */
  envelope:    ReplyEnvelope;
  /** Filled by the sender; read by `sendThreadReply`'s shared tail and its catch. */
  out: {
    accountId:               string | null;
    inboxRef:                InboxRef | null;
    outboundThreadId:        string | null;
    outboundMessageIdHeader: string | null;
  };
}

export function reconnectRequired(error: string, inbox: InboxRef | null): MailboxSendFailure {
  return {
    ok: false,
    status: 401,
    error,
    code: "RECONNECT_REQUIRED",
    legacy_code: "REAUTH_REQUIRED",
    ...(inbox ? { inbox } : {}),
  };
}

/** The connection is fine but its grant can't send — reconnecting (and allowing sending) fixes it. */
export function scopeMissing(platform: string, inbox: InboxRef | null): MailboxSendFailure {
  const label = replyPlatform(platform)?.label ?? platform;
  const who = inbox?.email ? ` (${inbox.email})` : "";
  const error = platform === "outlook"
    ? `Reconnect Outlook to allow sending: the Outlook inbox that received this email${who} hasn't given Nomila permission to send. Nothing was sent. You can reply in Outlook in the meantime.`
    : `The ${label} inbox that received this email${who} hasn't given Nomila permission to send. Please reconnect it in Settings and try again.`;
  return { ok: false, status: 403, error, code: "SCOPE_MISSING", ...(inbox ? { inbox } : {}) };
}

// ─── Gmail ───────────────────────────────────────────────────────────────────

export async function gmailSender(ctx: MailboxSendContext): Promise<MailboxSendFailure | null> {
  const { athleteId, threadId, inboundMsgs, storedInbox, envelope, out } = ctx;
  const recipient = envelope.toEmail;
  if (!recipient) {
    return { ok: false, status: 400, error: "Cannot reply: no sender email on inbound message" };
  }

  const { fetchMessageThreadingInfo } = await import("../lib/integrations/gmail.js");

  // ── Pick the sending inbox. The Gmail threadId — and the received message
  // itself — only exist inside the mailbox that received it, so the reply must
  // go out through that exact connection, not an arbitrary active Gmail account.
  // Threading data recovered live while resolving a legacy row's account.
  let recovered: { gmailThreadId: string; messageIdHeader: string | null } | null = null;

  if (storedInbox) {
    // Exactly the stored row — never another account, even an active one.
    if (storedInbox.status !== "active") {
      const who = storedInbox.email ? ` (${storedInbox.email})` : "";
      return reconnectRequired(
        `The Gmail inbox that received this email${who} is no longer connected. Please reconnect it in Settings and try again.`,
        out.inboxRef,
      );
    }
    if (!storedInbox.can_send) return scopeMissing("gmail", out.inboxRef);
    out.accountId = storedInbox.connection_id;
  } else {
    // Legacy thread — ingested before connected_account_id existed.
    const gmailAccounts = await db
      .select({ id: connectedAccounts.id, email: connectedAccounts.platform_username })
      .from(connectedAccounts)
      .where(and(
        eq(connectedAccounts.athlete_id, athleteId),
        eq(connectedAccounts.platform, "gmail"),
        eq(connectedAccounts.status, "active"),
      ));

    if (gmailAccounts.length === 0) {
      return { ok: false, status: 400, error: "No active gmail connection" };
    }
    if (gmailAccounts.length === 1) {
      out.accountId = gmailAccounts[0].id;
      out.inboxRef = { connection_id: gmailAccounts[0].id, email: gmailAccounts[0].email ?? null };
    } else {
      // Multiple inboxes: probe each with messages.get — the Gmail message id
      // only resolves in the mailbox that received it, so the first hit is the
      // receiving account (and hands us the threading data for free).
      const fetchable = inboundMsgs.find((m) => m.external_message_id);
      if (fetchable?.external_message_id) {
        for (const cand of gmailAccounts) {
          const info = await fetchMessageThreadingInfo(cand.id, fetchable.external_message_id).catch(() => null);
          if (info) {
            out.accountId = cand.id;
            out.inboxRef = { connection_id: cand.id, email: cand.email ?? null };
            recovered = info;
            break;
          }
        }
      }
      if (!out.accountId) {
        return { ok: false, status: 422, error: "Cannot determine which Gmail inbox received this email. Try reconnecting Gmail." };
      }
    }
    // Write the resolved inbox back so this is a one-time lookup per thread.
    await db.update(inboxThreads)
      .set({ connected_account_id: out.accountId })
      .where(eq(inboxThreads.id, threadId));
  }
  const accountId = out.accountId!;

  // ── Threading metadata. Stored columns are a cache; recover live from Gmail
  // when they're missing (rows ingested before we captured these fields).
  let src = inboundMsgs.find((m) => m.gmail_message_id_header && m.gmail_thread_id) ?? null;

  if (!src) {
    const fetchable = inboundMsgs.find((m) => m.external_message_id);
    if (fetchable?.external_message_id) {
      const info = recovered ?? await fetchMessageThreadingInfo(accountId, fetchable.external_message_id);
      if (info?.messageIdHeader && info.gmailThreadId) {
        // Caching this is an optimisation, so it must never be what stops a reply.
        // ON CONFLICT does not cover UPDATEs: if another row for this athlete already
        // carries the recovered Message-ID (the same mail ingested through a second
        // mailbox), the unique index rejects the write. `src` below only needs the
        // values in memory, so a failed cache write is genuinely inconsequential.
        await db.update(inboxMessages).set({
          gmail_message_id_header: info.messageIdHeader,
          gmail_thread_id:         info.gmailThreadId,
          connected_account_id:    accountId,
        }).where(eq(inboxMessages.id, fetchable.id)).catch((err: any) =>
          logger.warn({ threadId, err: err.message }, "Threading-metadata cache write skipped"),
        );
        src = { ...fetchable, gmail_message_id_header: info.messageIdHeader, gmail_thread_id: info.gmailThreadId };
      }
    }
  }

  if (!src?.gmail_thread_id || !src.gmail_message_id_header) {
    // Fail loudly rather than silently sending an un-threaded "new" email.
    return { ok: false, status: 422, error: "Cannot thread reply: original message metadata is unavailable. Try reconnecting Gmail." };
  }

  // Build the full References chain (every prior Message-ID, oldest first) so the
  // reply nests in the recipient's client too, not just in our own Gmail thread.
  const headerRows = await db
    .select({ h: inboxMessages.gmail_message_id_header })
    .from(inboxMessages)
    .where(and(
      eq(inboxMessages.thread_id, threadId),
      isNotNull(inboxMessages.gmail_message_id_header),
    ))
    .orderBy(asc(inboxMessages.received_at));
  const references = headerRows.map((r) => r.h!).filter(Boolean);
  if (!references.includes(src.gmail_message_id_header)) references.push(src.gmail_message_id_header);

  out.outboundThreadId = src.gmail_thread_id;

  const { sendGmailReply } = await import("../lib/integrations/gmail.js");
  out.outboundMessageIdHeader = await sendGmailReply({
    connectionId:    accountId,
    toEmail:         recipient,
    subject:         envelope.subject ?? "",
    body:            ctx.body,
    gmailThreadId:   src.gmail_thread_id,
    messageIdHeader: src.gmail_message_id_header,
    references,
  });
  return null;
}

// ─── Instagram ───────────────────────────────────────────────────────────────

export async function instagramSender(ctx: MailboxSendContext): Promise<MailboxSendFailure | null> {
  const { athleteId, inboundMsgs, storedInbox, out } = ctx;
  const lastInbound = inboundMsgs[0];
  if (!lastInbound.sender_ig_user_id) {
    return { ok: false, status: 400, error: "Cannot reply: no Instagram user ID on inbound message" };
  }
  // Answer ONLY from the account that received the DM. An athlete can have two
  // Instagram accounts (a personal one and a brand one); falling back to "any active
  // Instagram connection" could reply from the wrong one.
  if (storedInbox) {
    if (storedInbox.status !== "active" || storedInbox.platform !== "instagram") {
      const who = storedInbox.email ? ` (@${storedInbox.email})` : "";
      return reconnectRequired(
        `The Instagram account that received this message${who} is no longer connected. Please reconnect it in Settings and try again.`,
        out.inboxRef,
      );
    }
    out.accountId = storedInbox.connection_id;
  } else {
    // Legacy row with no stored connection: only safe when there is exactly one.
    const igAccounts = await db
      .select({ id: connectedAccounts.id, email: connectedAccounts.platform_username })
      .from(connectedAccounts)
      .where(and(
        eq(connectedAccounts.athlete_id, athleteId),
        eq(connectedAccounts.platform, "instagram"),
        eq(connectedAccounts.status, "active"),
      ));
    if (igAccounts.length === 0) {
      return { ok: false, status: 400, error: "No active instagram connection" };
    }
    if (igAccounts.length > 1) {
      return {
        ok: false,
        status: 422,
        error: "Cannot tell which of your Instagram accounts received this message, so it wasn't sent. Reply from the Instagram app.",
      };
    }
    out.accountId = igAccounts[0].id;
    out.inboxRef = { connection_id: igAccounts[0].id, email: igAccounts[0].email ?? null };
  }
  const { sendInstagramDM } = await import("../lib/integrations/instagram.js");
  await sendInstagramDM({
    connectionId:       out.accountId,
    recipientIgUserId:  lastInbound.sender_ig_user_id,
    message:            ctx.body,
  });
  return null;
}

// ─── Outlook (OUTLOOK_SEND) ──────────────────────────────────────────────────

/**
 * An Outlook reply through Microsoft Graph, in the same conversation, from the exact mailbox that
 * received it. Refuses — before any Graph call — when the stored grant lacks Mail.Send, with an
 * error that says to reconnect Outlook. `sendThreadReply` only reaches this while OUTLOOK_SEND is on.
 */
export async function outlookSender(ctx: MailboxSendContext): Promise<MailboxSendFailure | null> {
  const { threadId, inboundMsgs, storedInbox, out } = ctx;
  const lastInbound = inboundMsgs[0];

  // Never guess the mailbox: Outlook threads have recorded their connection since ingest began.
  if (!storedInbox) {
    return {
      ok: false,
      status: 422,
      error: "Cannot tell which Outlook inbox received this email, so it wasn't sent. Reply in Outlook.",
    };
  }
  if (storedInbox.status !== "active" || storedInbox.platform !== "outlook") {
    const who = storedInbox.email ? ` (${storedInbox.email})` : "";
    return reconnectRequired(
      `The Outlook inbox that received this email${who} is no longer connected. Please reconnect it in Settings and try again.`,
      out.inboxRef,
    );
  }
  if (!storedInbox.can_send) return scopeMissing("outlook", out.inboxRef);
  out.accountId = storedInbox.connection_id;

  // Graph replies to a message by ITS id — the newest inbound from this mailbox.
  const target = inboundMsgs.find((m) => m.external_message_id && (m.connected_account_id ?? storedInbox.connection_id) === storedInbox.connection_id);
  if (!target?.external_message_id) {
    return { ok: false, status: 422, error: "Cannot thread reply: the original Outlook message can't be found. Reply in Outlook." };
  }
  out.outboundThreadId = target.gmail_thread_id ?? lastInbound.gmail_thread_id ?? null;   // Graph conversationId

  const { sendOutlookReply } = await import("../lib/integrations/outlook.js");
  const sent = await sendOutlookReply({ connectionId: out.accountId, messageId: target.external_message_id, body: ctx.body });
  if (sent.ok) {
    // Graph's /reply returns 202 with no id: there is no sent Message-ID to store.
    out.outboundMessageIdHeader = null;
    return null;
  }
  if (sent.reason === "scope") {
    logger.warn({ threadId, connectionId: out.accountId, status: sent.status }, "Reply failed: Outlook grant lacks Mail.Send");
    return scopeMissing("outlook", out.inboxRef);
  }
  if (sent.reason === "gone") {
    return { ok: false, status: 422, error: "That email isn't in your Outlook inbox any more (moved or deleted), so nothing was sent. Reply in Outlook." };
  }
  logger.error({ threadId, connectionId: out.accountId, status: sent.status, err: sent.message }, "Outlook reply send failed");
  return { ok: false, status: 502, error: "Couldn't send your reply. Please try again." };
}
