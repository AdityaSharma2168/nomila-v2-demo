/**
 * liveConversation.ts — read a thread's correspondence from the mailbox, keep nothing.
 *
 * The one place the conversation readers (thread view, summarizer, drafter, ask-terms,
 * voice, re-qualification) go when MAILBOX_LIVE_READS is on. It resolves WHICH mailbox
 * and WHICH provider grouping from the stored ids only — never a body — and returns
 * either the live messages or a typed reason they are unavailable.
 *
 * Rules every caller inherits:
 *   - A failed read changes no state. These functions only SELECT ids; the adapter's
 *     sole side effect is the token cache refreshTokenIfNeeded already keeps.
 *   - Transient / rate-limited failures retry with backoff (withMailboxRetry), then
 *     surface as unavailable. Nothing falls back to writing, or to stored bodies.
 *   - `null` from resolveLiveSource means "no live reader applies" (flag off, or a
 *     provider without a mailbox adapter, e.g. Instagram DMs): the
 *     caller keeps its stored path, unchanged.
 */

import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { inboxMessages, inboxThreads } from "../../shared/schema";
import {
  getMailboxAdapter,
  isMailboxError,
  mailboxLiveReadsEnabled,
  mailboxProviderOf,
  withMailboxRetry,
  type MailboxAdapter,
  type MailboxErrorKind,
  type MailboxMessage,
  type MailboxProvider,
} from "../lib/mailbox";
import { conversationRefOf, internetMessageIdOf, messageRefOf, type StoredMessageIds } from "../lib/mailbox/refs";
import { extractPdfText, mergeBodyWithAttachments } from "../lib/pdfExtract";
import { resolveThreadInbox } from "./threadInbox";
import { createLogger } from "../logger";

const logger = createLogger("services/liveConversation");

/** Largest PDF a live reader will pull to read a brief (same cap ingest parses at). */
export const LIVE_PDF_MAX_BYTES = 5 * 1024 * 1024;
const MAX_PDFS_PER_MESSAGE = 2;

export interface LiveSource {
  provider:        MailboxProvider;
  adapter:         MailboxAdapter;
  accountId:       string | null;
  accountActive:   boolean;
  conversationRef: string | null;
}

export interface LiveMessage extends MailboxMessage {
  /** inbox_messages.id when Nomila indexed this message, else null. */
  rowId: string | null;
}

export type LiveUnavailable = {
  ok:       false;
  reason:   MailboxErrorKind;
  provider: MailboxProvider;
  /** Athlete-facing, provider-named copy ("Conversation unavailable — reconnect Gmail"). */
  message:  string;
};

export type LiveConversationResult =
  | { ok: true; provider: MailboxProvider; accountId: string; messages: LiveMessage[] }
  | LiveUnavailable;

const PROVIDER_LABEL: Record<MailboxProvider, string> = { gmail: "Gmail", outlook: "Outlook" };

export function unavailableMessage(reason: MailboxErrorKind, provider: MailboxProvider): string {
  const p = PROVIDER_LABEL[provider];
  if (reason === "disconnected") return `Conversation unavailable — reconnect ${p}`;
  if (reason === "not_found") return `This email was deleted in ${p}`;
  return `Couldn't reach ${p} just now — try again`;
}

function unavailable(reason: MailboxErrorKind, provider: MailboxProvider): LiveUnavailable {
  return { ok: false, reason, provider, message: unavailableMessage(reason, provider) };
}

function toUnavailable(err: unknown, provider: MailboxProvider, ctx: Record<string, unknown>): LiveUnavailable {
  const reason: MailboxErrorKind = isMailboxError(err) ? err.kind : "transient";
  // Ids and the reason only — never content.
  logger.warn({ ...ctx, provider, reason }, "Live mailbox read unavailable");
  return unavailable(reason, provider);
}

/**
 * Which mailbox holds this thread, and its provider grouping — from stored ids only.
 * null = no live reader applies; the caller keeps its stored path.
 */
export async function resolveLiveSource(athleteId: string, threadId: string): Promise<LiveSource | null> {
  if (!mailboxLiveReadsEnabled()) return null;

  const [newest] = await db
    .select({ platform: inboxMessages.platform })
    .from(inboxMessages)
    .where(eq(inboxMessages.thread_id, threadId))
    .orderBy(desc(inboxMessages.received_at))
    .limit(1);
  const inbox = await resolveThreadInbox(athleteId, threadId);
  const provider = mailboxProviderOf(inbox?.platform ?? newest?.platform ?? null);
  if (!provider) return null;
  const adapter = await getMailboxAdapter(provider);
  if (!adapter) return null;

  const accountId = inbox?.connection_id ?? null;
  let conversationRef: string | null = null;
  if (accountId) {
    const [row] = await db
      .select({ gmail_thread_id: inboxMessages.gmail_thread_id })
      .from(inboxMessages)
      .where(and(
        eq(inboxMessages.thread_id, threadId),
        eq(inboxMessages.connected_account_id, accountId),
        isNotNull(inboxMessages.gmail_thread_id),
      ))
      .orderBy(desc(inboxMessages.received_at))
      .limit(1);
    conversationRef = row ? conversationRefOf(row) : null;
  }
  if (!conversationRef) {
    const [t] = await db
      .select({ external_thread_id: inboxThreads.external_thread_id })
      .from(inboxThreads)
      .where(and(eq(inboxThreads.id, threadId), eq(inboxThreads.athlete_id, athleteId)))
      .limit(1);
    conversationRef = t?.external_thread_id ?? null;
  }

  return { provider, adapter, accountId, accountActive: inbox?.status === "active", conversationRef };
}

/** Fetch the whole conversation for a resolved source. */
export async function readLiveConversation(
  threadId: string,
  source: LiveSource,
): Promise<LiveConversationResult> {
  const { provider, adapter, accountId, conversationRef } = source;
  if (!accountId || !source.accountActive) return unavailable("disconnected", provider);
  if (!conversationRef) return unavailable("not_found", provider);

  let messages: MailboxMessage[];
  try {
    messages = await withMailboxRetry(() => adapter.fetchConversation(accountId, conversationRef));
  } catch (err) {
    return toUnavailable(err, provider, { threadId, accountId });
  }

  const rows = await db
    .select({
      id:                      inboxMessages.id,
      external_message_id:     inboxMessages.external_message_id,
      gmail_message_id_header: inboxMessages.gmail_message_id_header,
    })
    .from(inboxMessages)
    .where(eq(inboxMessages.thread_id, threadId));
  const rowByRef = new Map(rows.filter((r) => r.external_message_id).map((r) => [r.external_message_id!, r.id]));
  // A provider id can change under us (an Outlook default id changes when the message is
  // moved between folders); the RFC Message-ID does not, so it is the fallback match.
  const rowByMessageId = new Map(
    rows.filter((r) => internetMessageIdOf(r)).map((r) => [internetMessageIdOf(r)!, r.id]),
  );

  return {
    ok: true,
    provider,
    accountId,
    messages: messages.map((m) => ({
      ...m,
      rowId: rowByRef.get(m.ref.messageRef)
        ?? (m.ref.internetMessageId ? rowByMessageId.get(m.ref.internetMessageId) : undefined)
        ?? null,
    })),
  };
}

/** Convenience: resolve + read. null = no live reader applies (use the stored path). */
export async function readThreadConversation(
  athleteId: string,
  threadId: string,
): Promise<LiveConversationResult | null> {
  const source = await resolveLiveSource(athleteId, threadId);
  if (!source) return null;
  return readLiveConversation(threadId, source);
}

/**
 * Read ONE stored message live, by its ids. null = no live reader applies.
 * The row must carry platform / connected_account_id / external_message_id.
 */
export async function readStoredMessageLive(
  row: StoredMessageIds,
): Promise<{ ok: true; message: MailboxMessage } | LiveUnavailable | null> {
  if (!mailboxLiveReadsEnabled()) return null;
  const provider = mailboxProviderOf(row.platform ?? "gmail");
  if (!provider) return null;
  const adapter = await getMailboxAdapter(provider);
  if (!adapter) return null;
  const ref = messageRefOf(row);
  if (!ref) return unavailable(row.connected_account_id ? "not_found" : "disconnected", provider);
  try {
    const message = await withMailboxRetry(() => adapter.fetchMessage(ref.accountId, ref.messageRef));
    return { ok: true, message };
  } catch (err) {
    return toUnavailable(err, provider, { accountId: ref.accountId });
  }
}

/**
 * The message's text with any PDF brief appended — the same merged shape ingest used to
 * store, read live and held only in memory. A PDF that can't be fetched is skipped.
 */
export async function textWithBrief(source: { adapter: MailboxAdapter }, m: MailboxMessage): Promise<string> {
  const pdfs = m.attachments
    .filter((a) => a.kind === "file" && (a.mimeType === "application/pdf" || /\.pdf$/i.test(a.filename)))
    .slice(0, MAX_PDFS_PER_MESSAGE);
  if (pdfs.length === 0) return m.text;
  const texts: string[] = [];
  for (const a of pdfs) {
    try {
      const got = await withMailboxRetry(() =>
        source.adapter.fetchAttachment(m.ref.accountId, m.ref.messageRef, a.attachmentRef, { maxBytes: LIVE_PDF_MAX_BYTES }),
      );
      if (got.kind !== "bytes") continue;
      const t = await extractPdfText(got.bytes);
      if (t) texts.push(t);
    } catch (err) {
      logger.warn({ messageRef: m.ref.messageRef, reason: isMailboxError(err) ? err.kind : "error" }, "Live PDF brief read skipped");
    }
  }
  return mergeBodyWithAttachments(m.text, texts.join("\n\n").slice(0, 8000));
}

/** True when a message carries at least one PDF file attachment. */
export function hasPdfAttachment(m: MailboxMessage): boolean {
  return m.attachments.some((a) => a.kind === "file" && (a.mimeType === "application/pdf" || /\.pdf$/i.test(a.filename)));
}
