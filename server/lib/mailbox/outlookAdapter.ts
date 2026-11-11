/**
 * outlookAdapter.ts — the Outlook (Microsoft Graph) implementation of MailboxAdapter.
 *
 * Sits over integrations/outlook.ts: the token (and its refresh / rotation rules) comes
 * from getAccessToken. Nothing here writes Nomila state except what getAccessToken already
 * does (caching a fresh access token and the rotated refresh token).
 *
 * Graph-isms stay inside this file:
 *   - bodies are asked for as plain text (`Prefer: outlook.body-content-type="text"`);
 *     `uniqueBody` (the part new to this message) is preferred over the full body, and
 *     quoted history is stripped as a backstop;
 *   - a conversation is a FILTER over /me/messages by conversationId, sorted HERE (Graph
 *     refuses $orderby on a property that is not also in $filter);
 *   - drafts, Junk and Deleted Items are dropped from a conversation, and a message in
 *     Deleted Items reads as deleted (Gmail's DRAFT/SPAM/TRASH rule);
 *   - a referenceAttachment (OneDrive/SharePoint link) is kind "link" and never downloaded
 *     (Graph answers 405 on its /$value); a file is gated on Graph's `size` before any bytes;
 *   - the structured search becomes a KQL `$search`.
 *
 * IDS — why this adapter reads with DEFAULT ids, not ImmutableId:
 *   Every Outlook id Nomila holds (inbox_messages.external_message_id, attachment refs) was
 *   minted by delta sync, which deliberately stays on default ids — detectDeal dedupes on
 *   (thread_id, external_message_id), so switching ingest to ImmutableId would re-ingest
 *   every message the next time it changes. If this adapter asked for ImmutableId, every
 *   id it returned would differ from the stored one: live rows would not match their
 *   inbox_messages row and ingest/live would disagree about identity. So it sends no IdType
 *   preference, and a stored default id is resolved as-is at read time. The cost is bounded
 *   and safe: a message the athlete MOVED to another folder gets a new default id, so a
 *   direct fetch of the old one answers 404 → `not_found` (degrades to "unavailable", writes
 *   nothing). Conversation reads are keyed on conversationId, which survives moves, and the
 *   live-to-stored row match falls back to the RFC Message-ID. Converting stored ids
 *   (translateExchangeIds) is only safe together with switching delta to ImmutableId in the
 *   same change — a separate, later migration.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { connectedAccounts } from "../../../shared/schema";
import { htmlToText, stripQuotedHistory } from "../emailBody";
import { getAccessToken } from "../integrations/outlook";
import {
  MailboxError,
  type MailboxAdapter,
  type MailboxAttachmentMeta,
  type MailboxAttachmentResult,
  type MailboxMessage,
  type MailboxSearchHit,
  type MailboxSearchQuery,
} from "./types";
import { directionFor } from "./index";

const GRAPH = "https://graph.microsoft.com/v1.0";
const FETCH_TIMEOUT_MS = Number(process.env.MAILBOX_FETCH_TIMEOUT_MS ?? 15_000);
const MAX_SEARCH = 25;
/** A conversation longer than this is cut (oldest-first order is still kept for what we read). */
const MAX_CONVERSATION = 200;
const MAX_BODY_LEN = 4000;
/** Account facts (own addresses, hidden folder ids) are re-read at most this often. */
const ACCOUNT_INFO_TTL_MS = 60 * 60_000;

const MSG_SELECT = [
  "id", "subject", "from", "receivedDateTime", "sentDateTime", "body", "uniqueBody",
  "conversationId", "internetMessageId", "hasAttachments", "isDraft", "parentFolderId",
].join(",");
const ATTACHMENT_SELECT = "id,name,contentType,size,isInline";
const REFERENCE_ATTACHMENT = "#microsoft.graph.referenceAttachment";

interface Account { id: string; email: string | null }

/** The account, active, or a typed `disconnected`. */
async function activeAccount(accountId: string): Promise<Account> {
  const [row] = await db
    .select({ id: connectedAccounts.id, platform: connectedAccounts.platform, status: connectedAccounts.status, email: connectedAccounts.platform_username })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, accountId))
    .limit(1);
  if (!row || row.platform !== "outlook" || row.status !== "active") {
    throw new MailboxError("disconnected", "Outlook account is not connected");
  }
  return { id: row.id, email: row.email?.toLowerCase() ?? null };
}

async function tokenFor(accountId: string): Promise<string> {
  try {
    return await getAccessToken(accountId);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/invalid_grant|interaction_required|must reconnect|token not found|refresh token|expired or revoked/i.test(msg)) {
      throw new MailboxError("disconnected", "Outlook grant is no longer valid");
    }
    throw new MailboxError("transient", `Outlook token refresh failed: ${msg.slice(0, 120)}`);
  }
}

/** Retry-After as milliseconds (delta-seconds or an HTTP date), or undefined. */
export function retryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * One Graph GET, mapped onto the shared error kinds. Returns the Response when it is OK
 * or its status is in `pass` (the caller handles those itself).
 */
async function graphFetch(token: string, path: string, opts: { pass?: number[] } = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path.startsWith("https://") ? path : `${GRAPH}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        // Plain text bodies. No IdType preference: see IDS in the header comment.
        Prefer: 'outlook.body-content-type="text"',
      },
      signal: ctrl.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    throw new MailboxError("transient", `Outlook request failed: ${String(err?.message ?? err).slice(0, 120)}`);
  }
  clearTimeout(timer);
  if (res.ok || opts.pass?.includes(res.status)) return res;

  const body: any = await res.json().catch(() => ({}));
  const code = String(body?.error?.code ?? "");
  const wait = retryAfterMs(res.headers?.get?.("retry-after"));
  if (res.status === 429 || /throttl|TooManyRequests|ApplicationThrottled|MailboxConcurrency/i.test(code)) {
    throw new MailboxError("rate_limited", "Outlook rate limit", wait);
  }
  if (res.status === 401 || /InvalidAuthenticationToken|invalid_grant/i.test(code)) {
    throw new MailboxError("disconnected", `Outlook refused the grant (${res.status})`);
  }
  if (res.status === 403) throw new MailboxError("disconnected", `Outlook refused access (${res.status})`);
  // Graph answers 400 ErrorInvalidIdMalformed for an id it can no longer resolve, as well as 404.
  if (res.status === 404 || res.status === 410 || /ErrorItemNotFound|ErrorInvalidIdMalformed/i.test(code)) {
    throw new MailboxError("not_found", "Outlook message not found");
  }
  throw new MailboxError("transient", `Outlook error ${res.status}${code ? ` ${code}` : ""}`, wait);
}

async function graphGet(token: string, path: string): Promise<any> {
  const res = await graphFetch(token, path);
  return res.json();
}

const enc = encodeURIComponent;

// ─── Account facts ───────────────────────────────────────────────────────────

interface AccountInfo { own: string[]; deletedItems: string | null; junk: string | null; at: number }
const accountInfo = new Map<string, AccountInfo>();

/**
 * The account's own addresses (for direction) and the ids of the folders a conversation
 * read hides (Deleted Items, Junk). Best effort: a failed lookup falls back to the stored
 * address and no folder filter, and is not cached.
 */
async function infoFor(token: string, account: Account): Promise<AccountInfo> {
  const hit = accountInfo.get(account.id);
  if (hit && Date.now() - hit.at < ACCOUNT_INFO_TTL_MS) return hit;
  const [me, deleted, junk] = await Promise.allSettled([
    graphGet(token, "/me?$select=mail,userPrincipalName"),
    graphGet(token, "/me/mailFolders/deleteditems?$select=id"),
    graphGet(token, "/me/mailFolders/junkemail?$select=id"),
  ]);
  const own = new Set<string>();
  if (account.email) own.add(account.email);
  if (me.status === "fulfilled") {
    for (const a of [me.value?.mail, me.value?.userPrincipalName]) if (typeof a === "string" && a.includes("@")) own.add(a.toLowerCase());
  }
  const idOf = (f: PromiseSettledResult<any>) => (f.status === "fulfilled" && f.value?.id ? String(f.value.id) : null);
  const info = { own: [...own], deletedItems: idOf(deleted), junk: idOf(junk), at: Date.now() };
  if (me.status === "fulfilled" && deleted.status === "fulfilled" && junk.status === "fulfilled") accountInfo.set(account.id, info);
  return info;
}

/** Test seam: forget cached account facts. */
export function clearOutlookAccountCacheForTests(): void {
  accountInfo.clear();
}

// ─── Attachments ─────────────────────────────────────────────────────────────

export interface GraphAttachmentMeta extends MailboxAttachmentMeta {
  isInline: boolean;
}

function toAttachmentMeta(a: any): GraphAttachmentMeta {
  const link = a?.["@odata.type"] === REFERENCE_ATTACHMENT;
  return {
    attachmentRef: String(a.id),
    filename: String(a.name ?? ""),
    mimeType: String(a.contentType ?? "application/octet-stream").toLowerCase(),
    size: typeof a.size === "number" ? a.size : null,
    kind: link ? "link" : "file",
    isInline: a.isInline === true,
  };
}

/** A message's attachments, metadata only ($select keeps contentBytes out of the response). */
export async function listAttachments(token: string, messageRef: string): Promise<GraphAttachmentMeta[]> {
  const raw = await graphGet(token, `/me/messages/${enc(messageRef)}/attachments?$select=${ATTACHMENT_SELECT}`);
  return (raw?.value ?? []).map(toAttachmentMeta);
}

/**
 * One attachment's bytes, gated on Graph's reported size BEFORE the download and on the
 * real length after. A cloud link is never downloaded.
 */
export async function downloadAttachment(
  token: string,
  messageRef: string,
  attachmentRef: string,
  maxBytes: number,
): Promise<MailboxAttachmentResult> {
  const meta = (await listAttachments(token, messageRef)).find((a) => a.attachmentRef === attachmentRef);
  if (!meta) throw new MailboxError("not_found", "Attachment not found on the Outlook message");
  if (meta.kind === "link") return { kind: "not_downloadable", reason: "link" };
  if ((meta.size ?? 0) > maxBytes) return { kind: "not_downloadable", reason: "too_large" };

  const res = await graphFetch(token, `/me/messages/${enc(messageRef)}/attachments/${enc(attachmentRef)}/$value`, { pass: [405] });
  // 405: Graph has no raw bytes for this attachment (a reference that slipped the type check).
  if (res.status === 405) return { kind: "not_downloadable", reason: "link" };
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) return { kind: "not_downloadable", reason: "too_large" };
  return { kind: "bytes", bytes, filename: meta.filename, mimeType: meta.mimeType };
}

// ─── Messages ────────────────────────────────────────────────────────────────

function bodyText(raw: any): string {
  const part = raw?.uniqueBody?.content ? raw.uniqueBody : raw?.body;
  let text = String(part?.content ?? "").replace(/\r\n/g, "\n");
  // Prefer: text is honoured by Graph, but guard against a server that ignores it.
  if (String(part?.contentType ?? "").toLowerCase() === "html") text = htmlToText(text);
  return stripQuotedHistory(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_BODY_LEN);
}

function fromOf(raw: any): { from: string; fromEmail: string | null; fromName: string | null } {
  const addr = String(raw?.from?.emailAddress?.address ?? "").trim();
  const name = String(raw?.from?.emailAddress?.name ?? "").trim();
  const fromEmail = addr.includes("@") ? addr.toLowerCase() : null;
  return {
    from: name && addr ? `${name} <${addr}>` : addr || name,
    fromEmail,
    fromName: name && name.toLowerCase() !== fromEmail ? name : null,
  };
}

function sentAtOf(raw: any): string {
  // receivedDateTime is the mailbox's own timestamp (what ingest stored as the message date).
  const t = Date.parse(raw?.receivedDateTime ?? raw?.sentDateTime ?? "");
  return new Date(Number.isFinite(t) ? t : 0).toISOString();
}

async function toMessage(raw: any, account: Account, info: AccountInfo, token: string): Promise<MailboxMessage> {
  const f = fromOf(raw);
  // hasAttachments is false for a message whose only attachments are inline images; that
  // is the case we want to skip the extra call for.
  const attachments = raw?.hasAttachments === false
    ? []
    : (await listAttachments(token, String(raw.id))).map(({ isInline: _inline, ...m }) => m);
  return {
    ref: {
      provider: "outlook",
      accountId: account.id,
      messageRef: String(raw.id),
      conversationRef: raw.conversationId ? String(raw.conversationId) : null,
      internetMessageId: raw.internetMessageId ?? null,
    },
    ...f,
    subject: String(raw.subject ?? ""),
    sentAt: sentAtOf(raw),
    direction: directionFor(f.fromEmail, info.own),
    text: bodyText(raw),
    attachments,
  };
}

// ─── Search ──────────────────────────────────────────────────────────────────

/** KQL for Graph `$search`. Free text is reduced to plain words so it cannot inject syntax. */
export function outlookKql(q: MailboxSearchQuery): string {
  const parts: string[] = [];
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const words = (q.text ?? "").replace(/["\\():<>=]/g, " ").replace(/\s+/g, " ").trim();
  if (words) parts.push(words);
  const from = (q.from ?? "").replace(/["\\()\s]/g, "");
  if (from) parts.push(`from:${from}`);
  if (q.after) parts.push(`received>=${day(q.after)}`);
  if (q.before) parts.push(`received<${day(q.before)}`);
  if (q.hasAttachment) parts.push("hasAttachments:true");
  return parts.join(" ");
}

/** Deleted Items and Junk are dropped from a conversation (Gmail's TRASH / SPAM). */
function isHidden(folderId: unknown, info: AccountInfo): boolean {
  return typeof folderId === "string" && (folderId === info.deletedItems || folderId === info.junk);
}

// ─── The adapter ─────────────────────────────────────────────────────────────

export const outlookAdapter: MailboxAdapter = {
  provider: "outlook",

  async fetchMessage(accountId, messageRef) {
    const account = await activeAccount(accountId);
    const token = await tokenFor(accountId);
    const info = await infoFor(token, account);
    const raw = await graphGet(token, `/me/messages/${enc(messageRef)}?$select=${MSG_SELECT}`);
    if (info.deletedItems && raw?.parentFolderId === info.deletedItems) {
      throw new MailboxError("not_found", "Outlook message is in Deleted Items");
    }
    return toMessage(raw, account, info, token);
  },

  async fetchConversation(accountId, conversationRef) {
    const account = await activeAccount(accountId);
    const token = await tokenFor(accountId);
    const info = await infoFor(token, account);
    const filter = `conversationId eq '${conversationRef.replace(/'/g, "''")}'`;
    let url: string | undefined = `/me/messages?$filter=${enc(filter)}&$select=${MSG_SELECT}&$top=50`;
    const raws: any[] = [];
    while (url && raws.length < MAX_CONVERSATION) {
      const page: any = await graphGet(token, url);
      raws.push(...(page?.value ?? []));
      url = page?.["@odata.nextLink"];
    }
    const kept = raws
      .slice(0, MAX_CONVERSATION)
      .filter((m) => m?.isDraft !== true && !isHidden(m?.parentFolderId, info));
    if (kept.length === 0) throw new MailboxError("not_found", "Outlook conversation has no messages");
    const msgs: MailboxMessage[] = [];
    for (const m of kept) msgs.push(await toMessage(m, account, info, token));
    return msgs.sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.ref.messageRef.localeCompare(b.ref.messageRef));
  },

  async fetchAttachment(accountId, messageRef, attachmentRef, opts): Promise<MailboxAttachmentResult> {
    await activeAccount(accountId);
    const token = await tokenFor(accountId);
    return downloadAttachment(token, messageRef, attachmentRef, opts.maxBytes);
  },

  async search(accountId, query): Promise<MailboxSearchHit[]> {
    await activeAccount(accountId);
    const token = await tokenFor(accountId);
    const limit = Math.max(1, Math.min(MAX_SEARCH, query.limit));
    const kql = outlookKql(query);
    // $search cannot be combined with $orderby; Graph ranks by relevance and caps at 1000.
    const raw = await graphGet(
      token,
      `/me/messages?$search=${enc(`"${kql}"`)}&$top=${limit}` +
        `&$select=id,conversationId,internetMessageId,from,receivedDateTime,bodyPreview`,
    );
    return (raw?.value ?? []).slice(0, limit).map((m: any): MailboxSearchHit => {
      const email = fromOf(m).fromEmail;
      return {
        ref: {
          provider: "outlook",
          accountId,
          messageRef: String(m.id),
          conversationRef: m.conversationId ? String(m.conversationId) : null,
          internetMessageId: m.internetMessageId ?? null,
        },
        senderDomain: email ? email.split("@")[1] ?? null : null,
        sentAt: m.receivedDateTime ? sentAtOf(m) : null,
        snippet: String(m.bodyPreview ?? ""),
      };
    });
  },
};
