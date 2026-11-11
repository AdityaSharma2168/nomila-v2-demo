/**
 * gmailAdapter.ts — the Gmail implementation of MailboxAdapter.
 *
 * Sits over integrations/gmail.ts: the token (and its refresh / mark-expired rules)
 * comes from refreshTokenIfNeeded, the text from the shared extractEmailBody. Nothing
 * here writes Nomila state except what refreshTokenIfNeeded already does (caching a
 * fresh access token, or flipping a dead grant to expired).
 *
 * Gmail-isms stay inside this file:
 *   - DRAFT / SPAM messages are dropped from a conversation and TRASH reads as deleted;
 *   - an attachment's ref is its MIME partId, re-resolved to Gmail's attachmentId at
 *     fetch time (attachmentId is not a stable key);
 *   - the structured search becomes a `q` string.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { connectedAccounts } from "../../../shared/schema";
import { extractEmailBody } from "../emailBody";
import { refreshTokenIfNeeded } from "../integrations/gmail";
import {
  MailboxError,
  type MailboxAdapter,
  type MailboxAttachmentMeta,
  type MailboxAttachmentResult,
  type MailboxMessage,
  type MailboxSearchHit,
  type MailboxSearchQuery,
} from "./types";
import { addressOf, directionFor, displayNameOf } from "./index";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const FETCH_TIMEOUT_MS = Number(process.env.MAILBOX_FETCH_TIMEOUT_MS ?? 15_000);
const MAX_SEARCH = 25;

interface Account { id: string; email: string | null }

/** The account, active, or a typed `disconnected`. */
async function activeAccount(accountId: string): Promise<Account> {
  const [row] = await db
    .select({ id: connectedAccounts.id, platform: connectedAccounts.platform, status: connectedAccounts.status, email: connectedAccounts.platform_username })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, accountId))
    .limit(1);
  if (!row || row.platform !== "gmail" || row.status !== "active") {
    throw new MailboxError("disconnected", "Gmail account is not connected");
  }
  return { id: row.id, email: row.email?.toLowerCase() ?? null };
}

async function tokenFor(accountId: string): Promise<string> {
  try {
    return await refreshTokenIfNeeded(accountId);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/invalid_grant|must reconnect|token not found|refresh token|expired or revoked/i.test(msg)) {
      throw new MailboxError("disconnected", "Gmail grant is no longer valid");
    }
    throw new MailboxError("transient", `Gmail token refresh failed: ${msg.slice(0, 120)}`);
  }
}

/** One Gmail API GET, mapped onto the shared error kinds. */
async function gmailGet(token: string, path: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  } catch (err: any) {
    throw new MailboxError("transient", `Gmail request failed: ${String(err?.message ?? err).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return res.json();

  const body: any = await res.json().catch(() => ({}));
  const reason = String(body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? "");
  if (res.status === 429 || /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/i.test(reason)) {
    throw new MailboxError("rate_limited", "Gmail rate limit");
  }
  if (res.status === 401 || res.status === 403) throw new MailboxError("disconnected", `Gmail refused access (${res.status})`);
  // Gmail answers 400 "Invalid id value" for an id it no longer knows as well as 404.
  if (res.status === 404 || res.status === 400) throw new MailboxError("not_found", "Gmail message not found");
  throw new MailboxError("transient", `Gmail error ${res.status}`);
}

function headersOf(payload: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of payload?.headers ?? []) out[String(h.name).toLowerCase()] = h.value;
  return out;
}

/** Every part that carries a named file, keyed by its MIME partId. */
function attachmentParts(payload: any): { part: any; meta: MailboxAttachmentMeta }[] {
  const out: { part: any; meta: MailboxAttachmentMeta }[] = [];
  const walk = (part: any) => {
    if (!part) return;
    const filename = String(part.filename ?? "");
    if (filename && (part.body?.attachmentId || part.body?.data) && part.partId != null) {
      out.push({
        part,
        meta: {
          attachmentRef: String(part.partId),
          filename,
          mimeType: String(part.mimeType ?? "application/octet-stream").toLowerCase(),
          size: typeof part.body?.size === "number" ? part.body.size : null,
          kind: "file",
        },
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

function toMessage(raw: any, account: Account): MailboxMessage {
  const h = headersOf(raw.payload);
  const from = h.from ?? "";
  const fromEmail = addressOf(from);
  return {
    ref: {
      provider: "gmail",
      accountId: account.id,
      messageRef: String(raw.id),
      conversationRef: raw.threadId ? String(raw.threadId) : null,
      internetMessageId: h["message-id"] ?? null,
    },
    from,
    fromEmail,
    fromName: displayNameOf(from),
    subject: h.subject ?? "",
    // internalDate is Gmail's own receive time; the Date header is sender-controlled.
    sentAt: new Date(raw.internalDate ? Number(raw.internalDate) : Date.parse(h.date ?? "") || 0).toISOString(),
    direction: directionFor(fromEmail, account.email ? [account.email] : []),
    text: extractEmailBody(raw.payload),
    attachments: attachmentParts(raw.payload).map((a) => a.meta),
  };
}

const labelsOf = (raw: any): string[] => (Array.isArray(raw?.labelIds) ? raw.labelIds : []);

function gmailQuery(q: MailboxSearchQuery): string {
  const parts: string[] = [];
  const day = (d: Date) => `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  if (q.text?.trim()) parts.push(`"${q.text.trim().replace(/"/g, "")}"`);
  if (q.from?.trim()) parts.push(`from:${q.from.trim().replace(/\s+/g, "")}`);
  if (q.after) parts.push(`after:${day(q.after)}`);
  if (q.before) parts.push(`before:${day(q.before)}`);
  if (q.hasAttachment) parts.push("has:attachment");
  return parts.join(" ");
}

export const gmailAdapter: MailboxAdapter = {
  provider: "gmail",

  async fetchMessage(accountId, messageRef) {
    const account = await activeAccount(accountId);
    const token = await tokenFor(accountId);
    const raw = await gmailGet(token, `/messages/${encodeURIComponent(messageRef)}?format=full`);
    if (labelsOf(raw).includes("TRASH")) throw new MailboxError("not_found", "Gmail message is in the trash");
    return toMessage(raw, account);
  },

  async fetchConversation(accountId, conversationRef) {
    const account = await activeAccount(accountId);
    const token = await tokenFor(accountId);
    const raw = await gmailGet(token, `/threads/${encodeURIComponent(conversationRef)}?format=full`);
    const msgs = (raw?.messages ?? [])
      .filter((m: any) => !labelsOf(m).some((l) => l === "DRAFT" || l === "SPAM" || l === "TRASH"))
      .map((m: any) => toMessage(m, account));
    if (msgs.length === 0) throw new MailboxError("not_found", "Gmail conversation has no messages");
    return msgs.sort((a: MailboxMessage, b: MailboxMessage) => a.sentAt.localeCompare(b.sentAt));
  },

  async fetchAttachment(accountId, messageRef, attachmentRef, opts): Promise<MailboxAttachmentResult> {
    await activeAccount(accountId);
    const token = await tokenFor(accountId);
    const raw = await gmailGet(token, `/messages/${encodeURIComponent(messageRef)}?format=full`);
    const hit = attachmentParts(raw.payload).find((a) => a.meta.attachmentRef === attachmentRef);
    if (!hit) throw new MailboxError("not_found", "Attachment not found on the Gmail message");
    if ((hit.meta.size ?? 0) > opts.maxBytes) return { kind: "not_downloadable", reason: "too_large" };

    let data: string | undefined = hit.part.body?.data;
    if (!data) {
      const att = await gmailGet(
        token,
        `/messages/${encodeURIComponent(messageRef)}/attachments/${encodeURIComponent(hit.part.body.attachmentId)}`,
      );
      data = att?.data;
    }
    if (!data) throw new MailboxError("not_found", "Attachment has no data");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > opts.maxBytes) return { kind: "not_downloadable", reason: "too_large" };
    return { kind: "bytes", bytes, filename: hit.meta.filename, mimeType: hit.meta.mimeType };
  },

  async search(accountId, query): Promise<MailboxSearchHit[]> {
    await activeAccount(accountId);
    const token = await tokenFor(accountId);
    const limit = Math.max(1, Math.min(MAX_SEARCH, query.limit));
    const list = await gmailGet(token, `/messages?maxResults=${limit}&q=${encodeURIComponent(gmailQuery(query))}`);
    const hits: MailboxSearchHit[] = [];
    for (const m of (list?.messages ?? []).slice(0, limit)) {
      const raw = await gmailGet(
        token,
        `/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Message-ID`,
      );
      const h = headersOf(raw.payload);
      const email = addressOf(h.from);
      hits.push({
        ref: {
          provider: "gmail",
          accountId,
          messageRef: String(raw.id),
          conversationRef: raw.threadId ? String(raw.threadId) : null,
          internetMessageId: h["message-id"] ?? null,
        },
        senderDomain: email ? email.split("@")[1] ?? null : null,
        sentAt: raw.internalDate ? new Date(Number(raw.internalDate)).toISOString() : null,
        snippet: String(raw.snippet ?? ""),
      });
    }
    return hits;
  },
};
