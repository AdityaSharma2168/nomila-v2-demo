/**
 * Gmail direct integration — Google OAuth 2.0 + Gmail API.
 * Same Google OAuth client as YouTube, different scopes.
 * Access token: 1hr. Refresh token: indefinite.
 *
 * For WS3 deal detection: setupPushNotifications() registers a Google
 * pub/sub watch so new emails trigger our webhook instead of polling.
 */

import { db } from "../../db";
import { connectedAccounts, gmailDeadLetters } from "../../../shared/schema";
import { and, eq, lt, sql } from "drizzle-orm";
import { createLogger } from "../../logger";
import { apiBaseUrl } from "../baseUrls";
import { signOAuthState } from "../oauthState";
import { extractEmailBody } from "../emailBody";
import { extractPdfText } from "../pdfExtract";
import { calendarSignalFromGmailPayload, type CalendarSignal } from "../calendarInvite";
import { attachmentObjectPath, putAttachment, MAX_ATTACHMENT_BYTES } from "../inboxAttachmentStore";
import type { InboxAttachment } from "../../../shared/schema";
import { createHash } from "node:crypto";
import { mailboxLiveReadsEnabled } from "../mailbox";
import { claimDeadLetter, dueSql } from "../deadLetterClaim";
import { openTokenFields, sealTokenFields } from "../tokenCrypto";
import { activateConnection, MissingAccountIdError } from "./activateConnection";
import type { ActivatedConnection } from "./types";

const logger = createLogger("integrations/gmail");

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID?.trim();
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET_WEB?.trim();
const API_BASE      = apiBaseUrl();
const REDIRECT      = process.env.GMAIL_REDIRECT_URI ?? `${API_BASE}/api/v1/auth/callback/gmail`;
const TOKEN_URL     = "https://oauth2.googleapis.com/token";
/** Do not even fetch an attachment larger than this — the parse cap cannot help by then. */
const PDF_MAX_FETCH_BYTES  = 5 * 1024 * 1024;
/** A stalled attachment must not hold a request, a DB connection and a batch slot open. */
const PDF_FETCH_TIMEOUT_MS = Number(process.env.PDF_FETCH_TIMEOUT_MS ?? 20_000);

const GMAIL_API     = "https://gmail.googleapis.com/gmail/v1/users/me";

// gmail.send is a RESTRICTED scope. While the OAuth consent screen is in
// "Testing" mode it works for added test users without Google verification
// (users click past an "unverified app" warning). Before going to production
// with external users, this scope requires Google's app verification / CASA
// security assessment, or the OAuth flow will be blocked:
// https://support.google.com/cloud/answer/13463073
//
// NOTE: the scope must also be added to the OAuth consent screen in Google
// Cloud Console, and existing users must re-connect Gmail (prompt=consent
// below forces a fresh grant) before their token carries send/compose permission.
//
// gmail.compose is needed so "Save draft" writes a native Gmail Draft the athlete
// can finish on mobile/web — readonly + send alone cannot create drafts.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "email",
  "profile",
].join(" ");

// OAuth refresh errors that mean the user's grant is gone and only reconnecting
// fixes it (revoked access, password change, prolonged inactivity). Deliberately
// does NOT include invalid_client / unauthorized_client: those are app-config
// faults that affect every user at once and a reconnect can't fix, so flipping a
// connection to "expired" on them would mislead users into a pointless reconnect.
const REAUTH_REQUIRED_CODES = new Set(["invalid_grant"]);

class GoogleRefreshError extends Error {
  constructor(public readonly code: string | undefined, message: string) {
    super(message);
    this.name = "GoogleRefreshError";
  }
}

async function googleRefresh(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google credentials not configured");
  const res  = await fetch(TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
  });
  const data = await res.json() as any;
  if (!res.ok || data.error) {
    throw new GoogleRefreshError(data.error, `Google token refresh failed: ${data.error_description ?? data.error}`);
  }
  return data;
}

// Flip a Gmail connection to "expired" so the UI can prompt a reconnect. The
// pipeline queries all filter status='active', so this also stops the webhook,
// cron, and watch-renewal from burning work on a dead connection.
async function markGmailExpired(connectionId: string, reason: string): Promise<void> {
  await db.update(connectedAccounts).set({ status: "expired" }).where(eq(connectedAccounts.id, connectionId));
  logger.error(
    { event: "pipeline_failure", kind: "token_refresh", connectionId, reason },
    "Gmail connection marked expired — reconnect required",
  );
}

export function getAuthUrl(athleteId: string, alias?: string, loginHint?: string, clientPlatform?: string): string {
  if (!CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID not set");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id",     CLIENT_ID);
  url.searchParams.set("redirect_uri",  REDIRECT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope",         SCOPES);
  url.searchParams.set("access_type",   "offline");
  url.searchParams.set("prompt",        "consent");
  // Signed, expiring state (CSRF protection). See server/lib/oauthState.ts.
  url.searchParams.set("state", signOAuthState(athleteId, alias, clientPlatform));
  // login_hint bypasses the account picker and binds the session to a specific account,
  // preventing authuser=unknown on iOS Chrome when multiple Google accounts are signed in.
  if (loginHint) url.searchParams.set("login_hint", loginHint);
  return url.toString();
}

export async function handleCallback(code: string, athleteId: string, alias?: string): Promise<ActivatedConnection> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google credentials not configured");

  const res  = await fetch(TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: REDIRECT }).toString(),
  });
  const data = await res.json() as any;
  if (!res.ok || data.error) throw new Error(`Gmail token exchange failed: ${data.error_description ?? data.error}`);

  // The Google account's stable id (sub) is the connection's identity — without it we cannot tell a
  // reconnect from a new mailbox, so the connect fails instead of writing a row with a null id.
  const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  const profile = await profileRes.json().catch(() => ({})) as any;
  if (!profileRes.ok || !profile?.sub) {
    logger.error({ athleteId, status: profileRes.status }, "Gmail connect: userinfo fetch failed — no account id");
    throw new MissingAccountIdError("gmail");
  }

  const activated = await activateConnection({
    athleteId,
    platform:         "gmail",
    alias,
    platformUserId:   String(profile.sub),
    platformUsername: profile.email ?? null,
    accessToken:      data.access_token,
    refreshToken:     data.refresh_token ?? null,
    tokenExpiresAt:   data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    // What Google GRANTED (a user can untick gmail.compose on the consent screen), not what we asked for.
    scopes:           typeof data.scope === "string" && data.scope.trim() ? data.scope : SCOPES,
  });

  logger.info({ athleteId, email: profile.email, alias, connectionId: activated.connectionId, reactivated: activated.reactivated }, "Gmail connected");
  return activated;
}

export async function refreshTokenIfNeeded(connectionId: string): Promise<string> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) throw new Error("Gmail token not found");

  if (row.token_expires_at && (row.token_expires_at.getTime() - Date.now()) > 5 * 60_000) {
    return row.access_token;
  }
  if (!row.refresh_token) {
    await markGmailExpired(connectionId, "missing_refresh_token");
    throw new Error("No Gmail refresh token — user must reconnect");
  }

  let fresh;
  try {
    fresh = await googleRefresh(row.refresh_token);
  } catch (err) {
    // Only a definitive re-auth-required error flips the connection to expired;
    // transient/network failures rethrow with status left untouched so a blip
    // doesn't force every user to reconnect.
    if (err instanceof GoogleRefreshError && err.code && REAUTH_REQUIRED_CODES.has(err.code)) {
      await markGmailExpired(connectionId, err.code);
    }
    throw err;
  }

  await db.update(connectedAccounts).set(await sealTokenFields({
    access_token:     fresh.access_token,
    token_expires_at: new Date(Date.now() + fresh.expires_in * 1000),
  })).where(eq(connectedAccounts.id, connectionId));

  return fresh.access_token;
}

export interface GmailMessage {
  id:              string;
  threadId:        string; // Gmail thread ID — same as id for single-message threads
  subject:         string;
  from:            string;
  body:            string;
  date:            string;
  messageIdHeader: string | null;
  labelIds:        string[];
  inReplyToHeader: string | null;
  attachmentText:  string; // plain text extracted from PDF attachments (deal briefs)
  attachments:     InboxAttachment[]; // the same PDFs, rehosted to GCS (empty when none/not rehosted)
  calendar:        CalendarSignal | null; // a calendar invite part (text/calendar / .ics), in memory only
}

// Gmail labels that mean "this is not mail that happened". A DRAFT is the one
// that bites: Gmail mints a NEW message id on every autosave, so a single reply
// being composed surfaces as a stream of near-identical messages, and each one
// that reaches detectDeal becomes its own inbox_messages row. Mia's gorjana
// thread carried nine such rows from one 90-second compose (07-31 13:42–13:44),
// which is what put half-written text in "view full conversation" as if it had
// been sent — the self-sender gate files athlete-addressed mail as OUTBOUND.
//
// This lived inline in fetchMessagesByHistoryId only, so the webhook path was
// clean while the POLLING path (fetchRecentMessages/fetchBackfillMessages) had
// no filter at all. Shared here so every ingestion path is covered by one rule,
// and re-asserted in detectDeal so a future fetch path can't reopen the hole.
const NON_INGESTABLE_LABELS = ["DRAFT", "TRASH", "SPAM"];

export function isIngestableMessage(labelIds: string[] | null | undefined): boolean {
  const labels = labelIds ?? [];
  return !NON_INGESTABLE_LABELS.some((l) => labels.includes(l));
}

// Exported for _reextractBodies.ts (re-runs stored junk bodies through the
// current extraction pipeline). Everything else should use the higher-level
// fetch functions.
export async function fetchFullMessage(token: string, id: string, athleteId?: string): Promise<GmailMessage | null> {
  try {
    const msgRes = await fetch(`${GMAIL_API}/messages/${id}?format=full`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const msg = await msgRes.json() as any;
    if (!msgRes.ok) return null;

    const headers: Record<string, string> = {};
    for (const h of msg.payload?.headers ?? []) headers[(h.name as string).toLowerCase()] = h.value;

    const body = extractEmailBody(msg.payload);
    const labelIds = Array.isArray(msg.labelIds) ? msg.labelIds as string[] : [];

    // Re-hosting runs BEFORE the callers' label filter, so a draft carrying a PDF used
    // to upload it to GCS on every autosave — objects no inbox_messages row would ever
    // reference and nothing cleans up. Skip the download entirely for mail we will drop.
    const pdf = isIngestableMessage(labelIds)
      ? await extractPdfAttachments(token, id, msg.payload, athleteId)
      : { text: "", attachments: [] as InboxAttachment[] };

    return {
      id,
      threadId:        msg.threadId ?? id,
      subject:         headers.subject      ?? "(no subject)",
      from:            headers.from         ?? "",
      body,
      // internalDate is Gmail's own receive timestamp (epoch ms). The Date
      // header is sender-controlled and misorders threads when it lies.
      date:            msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : (headers.date ?? ""),
      messageIdHeader: headers["message-id"] ?? null,
      labelIds,
      inReplyToHeader: headers["in-reply-to"] ?? null,
      attachmentText: pdf.text,
      attachments:    pdf.attachments,
      calendar:       calendarSignalFromGmailPayload(msg.payload),
    };
  } catch {
    return null;
  }
}

/**
 * Walk the MIME tree for PDF parts, download via attachments.get, extract text AND
 * rehost the file so the deal card can link to it.
 *
 * Only `application/pdf` parts (or a .pdf filename) are ever downloaded — logos,
 * screenshots and signature images are not touched.
 *
 * Storage is independent of parsing: a PDF over the parse cap is still kept, flagged
 * `parsed: false`, so the attachment is clickable even when we couldn't read it.
 * `athleteId` is optional — without it we extract text but skip rehosting, so the
 * text-only callers keep working unchanged.
 */
async function extractPdfAttachments(
  token: string,
  messageId: string,
  payload: any,
  athleteId?: string,
): Promise<{ text: string; attachments: InboxAttachment[] }> {
  // Size gate applied to Gmail's reported part size, before any download.
  const pdfParts: { attachmentId: string; filename: string; size?: number; partId?: string }[] = [];

  const walk = (part: any) => {
    if (!part) return;
    const mime = String(part.mimeType ?? "").toLowerCase();
    const name = String(part.filename ?? "");
    const isPdf = mime === "application/pdf" || /\.pdf$/i.test(name);
    if (isPdf && part.body?.attachmentId) {
      pdfParts.push({ attachmentId: part.body.attachmentId, filename: name || "brief.pdf", size: part.body?.size, partId: part.partId });
    }
    // Some clients inline small PDFs as base64 on the part body.
    if (isPdf && part.body?.data && !part.body.attachmentId) {
      pdfParts.push({ attachmentId: "", filename: name || "brief.pdf", partId: part.partId });
      // Stash raw data under a synthetic key on the part so download can use it.
      (pdfParts[pdfParts.length - 1] as any).inlineData = part.body.data;
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);

  if (pdfParts.length === 0) return { text: "", attachments: [] };

  const texts: string[] = [];
  const attachments: InboxAttachment[] = [];
  // Cap at 2 PDFs / message so a bulk dump can't blow latency or token budget.
  for (const part of pdfParts.slice(0, 2)) {
    try {
      let buf: Buffer;
      if ((part as any).inlineData) {
        buf = Buffer.from((part as any).inlineData, "base64");
      } else {
        // Gate on the size Gmail already told us, BEFORE spending the download. The cap
        // below only helps once the bytes are here, so a 40 MB deck was fetched in full
        // just to be skipped — bandwidth, memory and latency for nothing.
        if ((part.size ?? 0) > PDF_MAX_FETCH_BYTES) continue;

        // Bound the download. Without a timeout a slow or stalled attachment holds a
        // request, a database connection and a batch slot for as long as Gmail keeps the
        // socket open — one bad attachment becomes a stuck pipeline.
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PDF_FETCH_TIMEOUT_MS);
        let att: any;
        try {
          const attRes = await fetch(
            `${GMAIL_API}/messages/${messageId}/attachments/${part.attachmentId}`,
            { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal },
          );
          if (!attRes.ok) continue;
          att = await attRes.json();
        } finally {
          clearTimeout(timer);
        }
        if (!att?.data) continue;
        buf = Buffer.from(att.data, "base64");
      }

      // Parsing is capped well below storage: we only need brief terms, and a 20 MB
      // deck costs real CPU to parse. Over the cap it is stored but not read.
      const parsed = buf.length <= 5 * 1024 * 1024;
      if (parsed) {
        const text = await extractPdfText(buf);
        if (text) texts.push(text);
      }

      // MAILBOX_LIVE_READS: the mailbox keeps the file. Record a ref (the MIME partId,
      // which the mailbox adapter re-resolves) instead of copying the bytes; a contract
      // is stored only when the athlete saves it.
      if (mailboxLiveReadsEnabled()) {
        if (part.partId != null) {
          attachments.push({
            filename:       part.filename,
            content_type:   "application/pdf",
            bytes:          buf.length,
            attachment_ref: String(part.partId),
            parsed,
          });
        }
        continue;
      }

      // Rehost so the file outlives the Gmail access token that fetched it.
      // Content-addressed: the same deck forwarded twice in a thread stores once.
      if (athleteId && buf.length <= MAX_ATTACHMENT_BYTES) {
        const hash    = createHash("sha256").update(buf).digest("hex").slice(0, 16);
        const gcsPath = attachmentObjectPath(athleteId, hash, part.filename);
        if (await putAttachment(gcsPath, buf)) {
          attachments.push({
            filename:     part.filename,
            content_type: "application/pdf",
            bytes:        buf.length,
            gcs_path:     gcsPath,
            parsed,
          });
        }
      }
    } catch (err: any) {
      logger.warn({ messageId, filename: part.filename, err: err?.message }, "PDF attachment fetch failed");
    }
  }
  return { text: texts.join("\n\n").slice(0, 8000), attachments };
}

/**
 * Athlete that owns a connection — attachment object paths are namespaced per athlete,
 * and the fetchers only carry a connectionId. One lookup per batch, not per message.
 */
async function connectionAthleteId(connectionId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ athlete_id: connectedAccounts.athlete_id })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, connectionId))
    .limit(1);
  return row?.athlete_id ?? undefined;
}

export async function fetchRecentMessages(
  connectionId: string,
  query = "is:unread newer_than:7d",
  maxResults = 20,
): Promise<GmailMessage[]> {
  const token     = await refreshTokenIfNeeded(connectionId);
  const athleteId = await connectionAthleteId(connectionId);

  const listRes  = await fetch(`${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listJson = await listRes.json() as any;
  if (!listRes.ok) throw new Error(`Gmail list failed: ${listJson.error?.message}`);

  const messages: GmailMessage[] = [];
  for (const { id } of listJson.messages ?? []) {
    const msg = await fetchFullMessage(token, id, athleteId);
    // Drafts match `is:unread` — this is the path that ingested compose autosave.
    if (msg && isIngestableMessage(msg.labelIds)) messages.push(msg);
  }

  return messages;
}

// Paginated backfill fetch — used for initial 90-day scan after connection.
// Query format: "in:inbox category:primary after:{unix_seconds}"
export async function fetchBackfillMessages(
  connectionId: string,
  afterUnixSeconds: number,
  maxMessages = 1000,
  opts: { folder?: "inbox" | "sent" } = {},
): Promise<GmailMessage[]> {
  const token     = await refreshTokenIfNeeded(connectionId);
  const athleteId = await connectionAthleteId(connectionId);
  // folder "sent": her own replies, so threads she already answered outside the app read "their move".
  // Inbox and sent are listed separately, each with its own cap, so a busy Sent folder can never crowd
  // brand mail out of the window (the backfill merges them and runs them oldest-first).
  const query     = opts.folder === "sent"
    ? `in:sent after:${afterUnixSeconds}`
    : `in:inbox after:${afterUnixSeconds}`;

  const all: GmailMessage[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${GMAIL_API}/messages`);
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    // Retry a failed page a few times before aborting — a transient Gmail 5xx
    // used to abandon the whole backfill (the "new user permanently empty" bug).
    let listJson: any;
    for (let attempt = 1; ; attempt++) {
      const listRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      listJson = await listRes.json() as any;
      if (listRes.ok) break;
      if (attempt >= 3) throw new Error(`Gmail backfill list failed: ${listJson.error?.message}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }

    for (const { id } of listJson.messages ?? []) {
      if (all.length >= maxMessages) break;
      const msg = await fetchFullMessage(token, id, athleteId);
      if (msg && isIngestableMessage(msg.labelIds)) all.push(msg);
    }

    pageToken = listJson.nextPageToken as string | undefined;
  } while (pageToken && all.length < maxMessages);

  return all;
}

// ─── History-based message fetch (used by Pub/Sub webhook) ──────────────────
// Gmail Pub/Sub sends a historyId, not a message ID. We call history.list()
// to find what changed, then fetch each new message in full.

export interface HistoryMessage {
  gmailMessageId:  string;
  gmailThreadId:   string;
  subject:         string;
  from:            string;
  body:            string;
  date:            string;
  messageIdHeader: string | null; // Message-ID header value — required for RFC 2822 reply threading
  labelIds:        string[];
  inReplyToHeader: string | null;
  attachmentText:  string;
  attachments:     InboxAttachment[];
  calendar?:       CalendarSignal | null;
}

/** The stored history cursor is too old for Gmail (history.list 404). */
export class HistoryExpiredError extends Error {
  constructor(public readonly startHistoryId: string) {
    super(`Gmail history cursor ${startHistoryId} has expired`);
    this.name = "HistoryExpiredError";
  }
}

/** How far back a gap is recovered by date when the history cursor has expired. */
const GAP_RECOVERY_QUERY = "newer_than:14d -in:drafts -in:spam -in:trash";
const GAP_RECOVERY_MAX = 300;

/**
 * Recover mail missed while the history cursor was unusable: list read AND unread mail, inbox and
 * sent, from the last two weeks, and run each through detectDeal (idempotent — already-recorded
 * messages are skipped by their ids). A retryable failure is dead-lettered. The caller then moves
 * the cursor to the push's historyId.
 */
export async function recoverHistoryGap(connectionId: string, athleteId: string): Promise<{ processed: number; deadLettered: number }> {
  const { detectDeal } = await import("../../skills/dealDetector.js");
  const msgs = await fetchRecentMessages(connectionId, GAP_RECOVERY_QUERY, GAP_RECOVERY_MAX);
  let processed = 0, deadLettered = 0;
  for (const msg of msgs) {
    let failed: string | null = null;
    try {
      const r = await detectDeal({ athleteId, connectionId, message: toDetectMessage(msg) });
      if (r.retryable) failed = r.reason ?? "retryable";
      else processed++;
    } catch (err: any) {
      failed = String(err?.message ?? "threw");
    }
    if (failed) {
      deadLettered++;
      await db.insert(gmailDeadLetters)
        .values({ connected_account_id: connectionId, athlete_id: athleteId, gmail_message_id: msg.id, error: failed.slice(0, 500) })
        .onConflictDoNothing();
    }
  }
  logger.warn({ event: "pipeline_failure", kind: "history_gap_recovered", connectionId, athleteId, processed, deadLettered }, "Gmail history cursor expired — gap recovered by date");
  return { processed, deadLettered };
}

/** A fetched Gmail message as detectDeal takes it. */
function toDetectMessage(msg: GmailMessage) {
  return {
    gmailMessageId:  msg.id,
    gmailThreadId:   msg.threadId,
    subject:         msg.subject,
    from:            msg.from,
    body:            msg.body,
    date:            msg.date,
    messageIdHeader: msg.messageIdHeader,
    labelIds:        msg.labelIds,
    inReplyToHeader: msg.inReplyToHeader,
    attachmentText:  msg.attachmentText,
    attachments:     msg.attachments,
    calendar:        msg.calendar ?? null,
  };
}

/**
 * History messages, plus the ids that were listed but could not be fetched (dead-letter them).
 * resumeHistoryId: set only when the read stopped at the page bound — the id of the last history
 * record read. The caller moves its cursor THERE (not to the push's historyId), so the next push
 * resumes after what was read: nothing skipped, and no cursor stuck re-reading the same pages.
 */
export type HistoryBatch = HistoryMessage[] & { failedIds: string[]; resumeHistoryId?: string };

export async function fetchMessagesByHistoryId(
  connectionId: string,
  startHistoryId: string,
): Promise<HistoryBatch> {
  const token     = await refreshTokenIfNeeded(connectionId);
  const athleteId = await connectionAthleteId(connectionId);

  // Watch covers INBOX + SENT (see setupPushNotifications). Do NOT filter history
  // by labelId=INBOX: that dropped native-Gmail replies living only under SENT,
  // so the deal card never moved to "Their turn" and the thread was incomplete.
  //
  // EVERY page. The caller advances the cursor to the push's historyId once this returns, so a
  // burst past one page (~100 records) used to be lost for good — only unread mail from the last
  // two days came back through the cron poll. A page that fails throws, and the cursor stays put.
  const messageIds = new Set<string>();
  let pageToken: string | undefined;
  let pages = 0;
  let lastRecordId: string | undefined;
  do {
    const url = new URL(`${GMAIL_API}/history`);
    url.searchParams.set("startHistoryId", startHistoryId);
    url.searchParams.set("historyTypes", "messageAdded");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const historyRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const historyJson = await historyRes.json() as any;
    // 404 = the cursor is older than Gmail keeps history for. Every later push would fail the same
    // way, so the caller recovers the gap by date instead (recoverHistoryGap).
    if (historyRes.status === 404) throw new HistoryExpiredError(startHistoryId);
    if (!historyRes.ok) throw new Error(`Gmail history.list failed: ${historyJson.error?.message ?? historyRes.status}`);
    for (const record of historyJson.history ?? []) {
      if (record.id != null) lastRecordId = String(record.id);
      for (const added of record.messagesAdded ?? []) {
        if (added.message?.id) messageIds.add(added.message.id);
      }
    }
    pageToken = historyJson.nextPageToken as string | undefined;
    pages++;
  } while (pageToken && pages < MAX_HISTORY_PAGES);
  // Past the bound: process what was read and hand back where to resume (the last record read).
  // Throwing here instead kept the cursor put, so every later push re-read the same 20 pages and
  // threw again — the cursor was stuck until Gmail expired it.
  let resumeHistoryId: string | undefined;
  if (pageToken) {
    if (!lastRecordId) throw new Error(`Gmail history.list: ${MAX_HISTORY_PAGES} pages since ${startHistoryId} with no record ids — not advancing`);
    resumeHistoryId = lastRecordId;
    logger.warn({ connectionId, startHistoryId, resumeHistoryId, pages }, "Gmail history.list: page bound reached — resuming from the last record read");
  }

  const failedIds: string[] = [];
  if (messageIds.size === 0) return Object.assign([] as HistoryMessage[], { failedIds, resumeHistoryId });

  const messages: HistoryMessage[] = [];
  for (const id of messageIds) {
    try {
      const full = await fetchFullMessage(token, id, athleteId);
      // null = Gmail would not return it (a 5xx / 429, or deleted since). Dead-letter it rather than
      // advance past it: the retry re-fetches, and a message that is really gone is dropped there.
      if (!full) { failedIds.push(id); continue; }

      // Skip DRAFTS / TRASH / SPAM so compose autosave and junk never mint deals.
      const labels = full.labelIds;
      if (!isIngestableMessage(labels)) continue;
      // Only process mailbox-relevant mail: inbox deliveries or athlete-sent.
      const isInbox = labels.includes("INBOX") || labels.length === 0;
      const isSent  = labels.includes("SENT");
      if (!isInbox && !isSent) continue;

      messages.push({
        gmailMessageId:  id,
        gmailThreadId:   full.threadId,
        subject:         full.subject,
        from:            full.from,
        body:            full.body,
        date:            full.date,
        messageIdHeader: full.messageIdHeader,
        labelIds:        full.labelIds,
        inReplyToHeader: full.inReplyToHeader,
        attachmentText:  full.attachmentText,
        attachments:     full.attachments,
        calendar:        full.calendar,
      });
    } catch {
      // Don't abort the whole batch — but a message we could not fetch is reported back, so the
      // caller dead-letters it for retry instead of advancing past it and losing it.
      failedIds.push(id);
    }
  }

  return Object.assign(messages, { failedIds, resumeHistoryId });
}

/** history.list pages read per push before refusing to advance (each page ≈ 100 records). */
const MAX_HISTORY_PAGES = 20;

// Fetch the threading metadata (thread id + Message-ID header) for a single
// Gmail message. Used to recover threading data for inbox messages that were
// ingested before we captured these fields, so replies still nest correctly.
export async function fetchMessageThreadingInfo(
  connectionId:  string,
  gmailMessageId: string,
): Promise<{ gmailThreadId: string; messageIdHeader: string | null } | null> {
  const token = await refreshTokenIfNeeded(connectionId);
  const msg = await fetchFullMessage(token, gmailMessageId);
  if (!msg) return null;
  return { gmailThreadId: msg.threadId, messageIdHeader: msg.messageIdHeader };
}

// Send a reply email into an existing Gmail thread.
// messageIdHeader: the Message-ID header of the message we're replying to (the In-Reply-To parent).
// references:      the full RFC 2822 References chain (all prior Message-IDs in the thread, oldest first)
//                  so the reply nests in every mail client, not just Gmail. Falls back to messageIdHeader.
// Returns the Message-ID Gmail assigned to our sent reply (so multi-turn replies can chain off it), or null.
export async function sendGmailReply(params: {
  connectionId:    string;
  toEmail:         string;
  subject:         string;
  body:            string;
  gmailThreadId:   string;
  messageIdHeader: string | null;
  references?:     string[];
}): Promise<string | null> {
  const { connectionId, toEmail, subject, body, gmailThreadId, messageIdHeader, references } = params;
  const token = await refreshTokenIfNeeded(connectionId);

  // RFC 2822 raw email
  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const lines: string[] = [
    `To: ${toEmail}`,
    `Subject: ${replySubject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
  ];
  if (messageIdHeader) {
    lines.push(`In-Reply-To: ${messageIdHeader}`);
    const refChain = references && references.length ? references.join(" ") : messageIdHeader;
    lines.push(`References: ${refChain}`);
  }
  lines.push("", body);

  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");

  const doSend = (withThreadId: boolean) =>
    fetch(`${GMAIL_API}/messages/send`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify(withThreadId ? { raw, threadId: gmailThreadId } : { raw }),
    });

  let sendRes  = await doSend(true);
  let sendJson = await sendRes.json() as any;

  // A gmailThreadId only exists in the mailbox that received the email. If this
  // athlete reconnected Gmail as a *different* account (e.g. switched from a
  // Workspace address to a personal one), the stored threadId isn't in the
  // current mailbox and Gmail returns "Requested entity was not found". Retry
  // without the threadId: the In-Reply-To/References headers still thread the
  // reply in the recipient's client — we just can't group it in our own mailbox.
  if (!sendRes.ok && /not found|notFound|failedPrecondition|invalid.*thread/i.test(sendJson.error?.message ?? "")) {
    logger.warn({ connectionId, gmailThreadId, to: toEmail }, "Gmail threadId not in mailbox — retrying send without threadId");
    sendRes  = await doSend(false);
    sendJson = await sendRes.json() as any;
  }

  if (!sendRes.ok) throw new Error(`Gmail send failed: ${sendJson.error?.message ?? sendRes.status}`);

  logger.info({ connectionId, gmailThreadId, to: toEmail }, "Gmail reply sent");

  // Gmail rewrites the Message-ID on send, so read it back from the stored message.
  // Best-effort: a failure here doesn't affect the reply that already went out.
  let sentMessageIdHeader: string | null = null;
  if (sendJson.id) {
    const sent = await fetchFullMessage(token, sendJson.id);
    sentMessageIdHeader = sent?.messageIdHeader ?? null;
  }
  return sentMessageIdHeader;
}

// WS3: Register Google push notifications so new emails hit our webhook.
// Call this once per connection after handleCallback.
// Returns true if the watch was actually registered. The renewal job relies on
// this — previously it swallowed failures internally and always counted "renewed",
// so a dead token looked healthy (N3).
//
// No labelIds filter: Gmail only keeps one watch, and INBOX-only watches never
// surface native-client replies in SENT. We filter DRAFT/TRASH/SPAM downstream
// in fetchMessagesByHistoryId.
export async function setupPushNotifications(connectionId: string): Promise<boolean> {
  const PUBSUB_TOPIC = process.env.GMAIL_PUBSUB_TOPIC;
  if (!PUBSUB_TOPIC) {
    // Missing topic silently disables realtime detection — warn, don't hide it.
    logger.warn({ event: "pipeline_failure", kind: "config", connectionId }, "GMAIL_PUBSUB_TOPIC not set — skipping watch registration; detection degrades to polling");
    return false;
  }

  try {
    const token  = await refreshTokenIfNeeded(connectionId);
    const watchRes = await fetch(`${GMAIL_API}/watch`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ topicName: PUBSUB_TOPIC }),
    });
    const watchJson = await watchRes.json() as any;
    if (!watchRes.ok) throw new Error(watchJson.error?.message ?? `Watch failed: ${watchRes.status}`);

    // Seed the cursor ONLY when there is none — the webhook needs it as startHistoryId when Pub/Sub
    // fires. The daily renewal used to OVERWRITE it with "now", so if pushes had been failing, the
    // renewal jumped the cursor over every message in the gap and they were never read (only unread
    // mail from the last two days came back through the cron). Keeping the stored cursor means the
    // next push reads the gap; one too old for Gmail is recovered by the webhook (recoverHistoryGap).
    if (watchJson.historyId) {
      await db.update(connectedAccounts)
        .set({ gmail_history_id: sql`coalesce(${connectedAccounts.gmail_history_id}, ${String(watchJson.historyId)})` })
        .where(eq(connectedAccounts.id, connectionId));
    }

    logger.info({ connectionId, historyId: watchJson.historyId }, "Gmail push watch registered");
    return true;
  } catch (err: any) {
    logger.warn({ connectionId, error: err.message }, "Gmail watch registration failed — will fall back to polling");
    return false;
  }
}

// ─── Gmail Drafts (app Save draft ↔ native Drafts) ───────────────────────────

function buildRawRfc2822(params: {
  toEmail: string;
  subject: string;
  body: string;
  messageIdHeader?: string | null;
  references?: string[];
}): string {
  const { toEmail, subject, body, messageIdHeader, references } = params;
  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const lines: string[] = [
    `To: ${toEmail}`,
    `Subject: ${replySubject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
  ];
  if (messageIdHeader) {
    lines.push(`In-Reply-To: ${messageIdHeader}`);
    const refChain = references && references.length ? references.join(" ") : messageIdHeader;
    lines.push(`References: ${refChain}`);
  }
  lines.push("", body);
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

/** Create or update a Gmail Draft nested in the deal thread. Returns Gmail draft id or null. */
export async function upsertGmailDraft(params: {
  connectionId:     string;
  toEmail:          string;
  subject:          string;
  body:             string;
  gmailThreadId:    string | null;
  messageIdHeader:  string | null;
  references?:      string[];
  existingDraftId?: string | null;
  /**
   * Told WHY no draft came back (Google's status + message, or the thrown error), so the
   * caller can tell a missing gmail.compose scope from any other failure. The return
   * value is unchanged: still null on failure.
   */
  onFailure?:       (failure: { status: number | null; message: string }) => void;
}): Promise<string | null> {
  const {
    connectionId, toEmail, subject, body, gmailThreadId,
    messageIdHeader, references, existingDraftId, onFailure,
  } = params;
  try {
    const token = await refreshTokenIfNeeded(connectionId);
    const raw = buildRawRfc2822({ toEmail, subject, body, messageIdHeader, references });
    const message: Record<string, unknown> = { raw };
    if (gmailThreadId) message.threadId = gmailThreadId;

    if (existingDraftId) {
      const updRes = await fetch(`${GMAIL_API}/drafts/${existingDraftId}`, {
        method:  "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ id: existingDraftId, message }),
      });
      const updJson = await updRes.json() as any;
      if (updRes.ok) return updJson.id ?? existingDraftId;
      // Stale/deleted draft — fall through to create.
      logger.warn({ connectionId, existingDraftId, err: updJson.error?.message }, "Gmail draft update failed — creating new");
    }

    const createRes = await fetch(`${GMAIL_API}/drafts`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ message }),
    });
    const createJson = await createRes.json() as any;
    if (!createRes.ok) {
      logger.warn({ connectionId, err: createJson.error?.message }, "Gmail draft create failed");
      onFailure?.({ status: createRes.status, message: String(createJson.error?.message ?? "") });
      return null;
    }
    return createJson.id ?? null;
  } catch (err: any) {
    logger.warn({ connectionId, err: err?.message }, "upsertGmailDraft threw");
    onFailure?.({ status: null, message: String(err?.message ?? err) });
    return null;
  }
}

/**
 * Delete a mirrored Gmail draft. Returns whether it is GONE (#164 M1).
 *
 * It used to return void and swallow the failure, so the caller had no way to know whether
 * the draft still existed — and threadReply cleared its pointer regardless, orphaning a draft
 * in her real mailbox that could then be sent by hand as a duplicate. The caller retries on
 * false and keeps the pointer if the draft survives.
 *
 * A 404 counts as success: the draft is gone, which is what was asked for.
 */
export async function deleteGmailDraft(connectionId: string, draftId: string): Promise<boolean> {
  try {
    const token = await refreshTokenIfNeeded(connectionId);
    const res = await fetch(`${GMAIL_API}/drafts/${draftId}`, {
      method:  "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok || res.status === 404;
  } catch (err: any) {
    logger.warn({ connectionId, draftId, err: err?.message }, "deleteGmailDraft failed");
    return false;
  }
}

// ─── InboxProvider contract ──────────────────────────────────────────────────

// Post-connect setup: register the Pub/Sub watch and scan the last 90 days so
// existing brand emails appear immediately. Called fire-and-forget from oauthCallback.
export async function onConnected(connectionId: string, athleteId: string): Promise<void> {
  await setupPushNotifications(connectionId).catch((err: any) =>
    logger.error({ athleteId, connectionId, error: err.message }, "Gmail push setup threw"),
  );
  // Dynamic import avoids a circular dep (gmailBackfill imports from this module).
  const { runGmailBackfill } = await import("../../skills/gmailBackfill.js");
  await runGmailBackfill({ connectionId, athleteId }).catch((err: any) =>
    logger.error({ athleteId, connectionId, error: err.message }, "Gmail backfill threw"),
  );
}

const MAX_DEAD_LETTER_ATTEMPTS = 5;

// Retry messages the webhook dead-lettered. Re-fetch each in full and re-run
// detectDeal; drop on success, bump attempts on failure, give up after N tries.
async function retryDeadLetters(connectionId: string, athleteId: string): Promise<void> {
  const rows = await db
    .select()
    .from(gmailDeadLetters)
    .where(and(
      eq(gmailDeadLetters.connected_account_id, connectionId),
      lt(gmailDeadLetters.attempts, MAX_DEAD_LETTER_ATTEMPTS),
      dueSql(new Date()),          // backoff: 15 min × 2^attempts since the last attempt
    ))
    .limit(25);
  if (rows.length === 0) return;

  const token = await refreshTokenIfNeeded(connectionId);
  const { detectDeal } = await import("../../skills/dealDetector.js");

  for (const dl of rows) {
    // One retrier per row: a concurrent push-triggered sync and the cron poll can't both retry it.
    if (!(await claimDeadLetter(dl))) continue;
    try {
      const msg = await fetchFullMessage(token, dl.gmail_message_id, athleteId);
      if (!msg) {
        // No longer fetchable (deleted/purged) — stop tracking it.
        await db.delete(gmailDeadLetters).where(eq(gmailDeadLetters.id, dl.id));
        continue;
      }
      const r = await detectDeal({ athleteId, connectionId, message: toDetectMessage(msg) });
      // A retryable result (e.g. the classifier errored again) is a FAILED retry, not a success:
      // keep the dead letter and count the attempt. It used to be deleted here after one retry,
      // so a second classifier hiccup lost the deal for good.
      if (r.retryable) throw new Error(`retryable: ${r.reason ?? "unknown"}`);
      await db.delete(gmailDeadLetters).where(eq(gmailDeadLetters.id, dl.id));
    } catch (err: any) {
      const attempts = dl.attempts + 1;
      await db.update(gmailDeadLetters)
        .set({ attempts, last_attempt_at: new Date(), error: String(err.message).slice(0, 500) })
        .where(eq(gmailDeadLetters.id, dl.id));
      if (attempts >= MAX_DEAD_LETTER_ATTEMPTS) {
        logger.error({ event: "pipeline_failure", kind: "dead_letter_exhausted", connectionId, gmailMessageId: dl.gmail_message_id }, "dead-lettered message exhausted retries");
      }
    }
  }
}

// Polling fallback for one connection — catches any Pub/Sub gaps. detectDeal
// deduplicates by (thread_id, external_message_id) so re-processing is safe.
export async function syncRecent(connectionId: string, athleteId: string): Promise<{ detected: number; skipped: number }> {
  // If the initial backfill never completed (last_fetched_at is NULL — it threw
  // mid-scan and was swallowed), re-run the full 90-day scan instead of the 2-day
  // poll, so an existing/read brand email isn't invisible forever (A8).
  const [conn] = await db
    .select({ last_fetched_at: connectedAccounts.last_fetched_at })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, connectionId))
    .limit(1);
  if (conn && !conn.last_fetched_at) {
    logger.info({ connectionId, athleteId }, "Gmail syncRecent: no completed backfill — running full backfill");
    const { runGmailBackfill } = await import("../../skills/gmailBackfill.js");
    const r = await runGmailBackfill({ connectionId, athleteId }); // sets last_fetched_at on success
    return { detected: r.detected, skipped: r.skipped };
  }

  const { detectDeal } = await import("../../skills/dealDetector.js");
  const messages = await fetchRecentMessages(connectionId, "is:unread newer_than:2d", 50);

  let detected = 0, skipped = 0;
  for (const msg of messages) {
    try {
      const r = await detectDeal({ athleteId, connectionId, message: toDetectMessage(msg) });
      if (r.retryable) {
        // The classifier could not judge it (e.g. a 429): queue it for the dead-letter retry
        // rather than count it as handled. The poll window is only two days of unread mail.
        await db.insert(gmailDeadLetters)
          .values({ connected_account_id: connectionId, athlete_id: athleteId, gmail_message_id: msg.id, error: String(r.reason ?? "retryable").slice(0, 500) })
          .onConflictDoNothing();
        skipped++;
      } else if (r.skipped) skipped++; else detected++;
    } catch (err: any) {
      // pipeline_failure, not warn: a throw here means a message was classified and
      // then dropped on the floor — the athlete never sees it. This was logged as a
      // bare warn while a schema drift broke every deal insert for four days, so the
      // alert never fired and the pipeline looked healthy. Match the webhook path,
      // which already dead-letters + emits pipeline_failure for the same failure.
      logger.error(
        { event: "pipeline_failure", kind: "detect_deal_threw", connectionId, athleteId, messageId: msg.id, error: err.message },
        "Gmail syncRecent: detectDeal threw",
      );
    }
  }

  // Retry anything the webhook dead-lettered for this connection.
  await retryDeadLetters(connectionId, athleteId).catch((err: any) =>
    logger.warn({ connectionId, error: err.message }, "Gmail syncRecent: dead-letter retry failed"),
  );

  await db.update(connectedAccounts)
    .set({ last_fetched_at: new Date() })
    .where(eq(connectedAccounts.id, connectionId));

  logger.debug({ connectionId, messages: messages.length, detected, skipped }, "Gmail syncRecent complete");
  return { detected, skipped };
}
