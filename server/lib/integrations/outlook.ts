/**
 * Outlook direct integration — Microsoft identity platform OAuth 2.0 + Microsoft Graph.
 * Multi-tenant + personal accounts (authority "common"): work M365 and @outlook/@hotmail.
 * Access token: ~1hr. Refresh token: long-lived but ROTATES on every refresh (must re-store).
 *
 * Sync strategy: delta query. The Inbox delta endpoint returns only changed messages since
 * the last call; we persist the @odata.deltaLink in connected_accounts.sync_cursor and replay
 * it on the next sync. The 6h inboxCronSync drives it. With OUTLOOK_PUSH on, Graph change
 * notifications (outlookPush.ts) trigger this same syncRecent within seconds of new mail and the
 * poll becomes a daily backstop per connection — the deltaLink is still the only cursor.
 *
 * Delta stays on DEFAULT (mutable) message ids, deliberately: `Prefer: IdType="ImmutableId"`
 * returns different ids for the same message, and detectDeal dedupes on
 * (thread_id, external_message_id) — switching would re-ingest every existing message the
 * next time it changes. Only the push subscription asks for immutable ids (its resource paths
 * are never read).
 *
 * Scope today is Mail.Read. Reply sending (`sendOutlookReply`, behind OUTLOOK_SEND) needs Mail.Send,
 * which the live OAuth request does NOT ask for yet: docs/plans/outlook-send-azure-checklist.md.
 */

import { db } from "../../db";
import { connectedAccounts, gmailDeadLetters } from "../../../shared/schema";
import { claimDeadLetter, dueSql } from "../deadLetterClaim";
import { and, eq, lt } from "drizzle-orm";
import { createLogger } from "../../logger";
import { apiBaseUrl } from "../baseUrls";
import { signOAuthState } from "../oauthState";
import { extractPdfText } from "../pdfExtract";
import { mailboxLiveReadsEnabled } from "../mailbox";
import type { InboxAttachment } from "../../../shared/schema";
import { openTokenFields, sealTokenFields } from "../tokenCrypto";
import { activateConnection, MissingAccountIdError } from "./activateConnection";
import type { ActivatedConnection } from "./types";
import { OUTLOOK_SEND_SCOPE } from "../connectionScopes";

const logger = createLogger("integrations/outlook");

const CLIENT_ID     = process.env.MICROSOFT_CLIENT_ID?.trim();
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET?.trim();
const TENANT        = process.env.MICROSOFT_TENANT?.trim() || "common";
const API_BASE      = apiBaseUrl();
const REDIRECT      = `${API_BASE}/api/v1/auth/callback/outlook`;
const AUTHORIZE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL     = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH         = "https://graph.microsoft.com/v1.0";

// offline_access → refresh token; User.Read → /me profile; Mail.Read → read inbox.
const SCOPES = ["openid", "profile", "email", "offline_access", "User.Read", "Mail.Read"].join(" ");

// Fields pulled per message. conversationId/internetMessageId reserved for reply threading later.
// hasAttachments only spares MAILBOX_LIVE_READS an attachment-list call on plain mail.
const SELECT = "id,subject,from,receivedDateTime,body,bodyPreview,conversationId,internetMessageId,isRead,hasAttachments";
const BACKFILL_DAYS  = 90;
const BACKFILL_MAX   = 1000;
/** Her sent mail read at connect (newest first within the window, then processed oldest-first). */
const SENT_BACKFILL_MAX = 500;
/** Sent Items are read from the last poll minus this, so a reply sent mid-poll is not missed. */
const SENT_OVERLAP_MS = 60 * 60 * 1000;
/** MAILBOX_LIVE_READS: a PDF brief over this (Graph's reported size) is not even fetched — Gmail's cap. */
const PDF_MAX_FETCH_BYTES = 5 * 1024 * 1024;

interface MsTokenResponse {
  access_token:  string;
  refresh_token?: string;
  expires_in:    number;
  scope?:        string;
  error?:        string;
  error_description?: string;
}

interface GraphMessage {
  id:                string;
  subject?:          string;
  from?:             { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  body?:             { contentType?: string; content?: string };
  bodyPreview?:      string;
  conversationId?:   string;
  internetMessageId?: string;
  hasAttachments?:   boolean;
  /** Graph annotates derived types: "#microsoft.graph.eventMessageRequest" / …Response / eventMessage (cancellations). */
  ["@odata.type"]?:  string;
  ["@removed"]?:     unknown; // delta tombstone for deleted/moved messages
}

interface DeltaPage {
  value?:              GraphMessage[];
  ["@odata.nextLink"]?:  string;
  ["@odata.deltaLink"]?: string;
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

export function getAuthUrl(athleteId: string, alias?: string, _loginHint?: string, clientPlatform?: string): string {
  if (!CLIENT_ID) throw new Error("MICROSOFT_CLIENT_ID not set");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id",     CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri",  REDIRECT);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope",         SCOPES);
  // Signed, expiring state (CSRF protection). See server/lib/oauthState.ts. Same
  // decode path as Gmail so web-initiated flows still get a direct 302.
  url.searchParams.set("state", signOAuthState(athleteId, alias, clientPlatform));
  return url.toString();
}

export async function handleCallback(code: string, athleteId: string, alias?: string): Promise<ActivatedConnection> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Microsoft credentials not configured");

  const res = await fetch(TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type:    "authorization_code",
      redirect_uri:  REDIRECT,
      scope:         SCOPES,
    }).toString(),
  });
  const data = await res.json() as MsTokenResponse;
  if (!res.ok || data.error) throw new Error(`Outlook token exchange failed: ${data.error_description ?? data.error}`);

  // Resolve the account: its stable Microsoft id is the connection's identity, the email is platform_username.
  const meRes  = await fetch(`${GRAPH}/me`, { headers: { Authorization: `Bearer ${data.access_token}` } });
  const me     = await meRes.json().catch(() => ({})) as { id?: string; mail?: string; userPrincipalName?: string };
  if (!meRes.ok || !me?.id) {
    logger.error({ athleteId, status: meRes.status }, "Outlook connect: /me fetch failed — no account id");
    throw new MissingAccountIdError("outlook");
  }
  const username = me.mail ?? me.userPrincipalName ?? null;

  const activated = await activateConnection({
    athleteId,
    platform:         "outlook",
    alias,
    platformUserId:   me.id,
    platformUsername: username,
    accessToken:      data.access_token,
    refreshToken:     data.refresh_token ?? null,
    tokenExpiresAt:   data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    scopes:           typeof data.scope === "string" && data.scope.trim() ? data.scope : SCOPES,   // granted, not requested
  });

  logger.info({ athleteId, email: username, alias, connectionId: activated.connectionId, reactivated: activated.reactivated }, "Outlook connected");
  return activated;
}

/**
 * The scopes a refresh asks for: the read-only set every grant has, plus Mail.Send ONLY when this
 * connection's stored grant already carries it. A refresh must never ask for more than the user
 * consented to (that fails with AADSTS65001 and stops ingest), and a grant that can send must keep
 * Mail.Send in its new access token. Every connection today stores a read-only grant, so its refresh
 * request is byte-identical to before.
 */
export function refreshScopesFor(grantedScopes: string | null | undefined): string {
  return OUTLOOK_SEND_SCOPE.test(grantedScopes ?? "") ? `${SCOPES} Mail.Send` : SCOPES;
}

async function msRefresh(refreshToken: string, grantedScopes: string | null | undefined): Promise<MsTokenResponse> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Microsoft credentials not configured");
  const res = await fetch(TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
      scope:         refreshScopesFor(grantedScopes),
    }).toString(),
  });
  const data = await res.json() as MsTokenResponse;
  // The OAuth error code leads (e.g. "invalid_grant"), so callers that recognise a dead grant by it —
  // the reply path's reconnect mapping in threadReply.ts, the mailbox adapter — see it; Microsoft's
  // description ("AADSTS700082: The refresh token has expired…") alone doesn't always say so.
  if (!res.ok || data.error) {
    const detail = [data.error, data.error_description].filter(Boolean).join(": ");
    throw new Error(`Outlook token refresh failed: ${detail || `HTTP ${res.status}`}`);
  }
  return data;
}

// Returns a valid access token, refreshing if it expires within 5 minutes.
// Microsoft rotates the refresh token on every refresh — persist the new one.
export async function getAccessToken(connectionId: string): Promise<string> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) throw new Error("Outlook token not found");

  if (row.token_expires_at && (row.token_expires_at.getTime() - Date.now()) > 5 * 60_000) {
    return row.access_token;
  }
  if (!row.refresh_token) throw new Error("No Outlook refresh token — user must reconnect");

  const fresh = await msRefresh(row.refresh_token, row.scopes);
  await db.update(connectedAccounts).set(await sealTokenFields({
    access_token:     fresh.access_token,
    refresh_token:    fresh.refresh_token ?? row.refresh_token, // rotation: keep new if present
    token_expires_at: new Date(Date.now() + fresh.expires_in * 1000),
  })).where(eq(connectedAccounts.id, connectionId));

  return fresh.access_token;
}

// ─── Graph helpers ───────────────────────────────────────────────────────────

class GraphError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function graphGet<T>(token: string, url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // text body (skip HTML parsing) + bounded page size for delta/list.
      Prefer: 'outlook.body-content-type="text", odata.maxpagesize=50',
    },
  });
  const json = await res.json() as any;
  if (!res.ok) throw new GraphError(json?.error?.message ?? `Graph ${res.status}`, res.status);
  return json as T;
}

/** How an Outlook reply ended. Never throws for these; a token failure still throws (the caller maps it). */
export type OutlookReplyOutcome =
  | { ok: true }
  | { ok: false; reason: "scope"; status: number; message: string }   // the grant can't send (no Mail.Send)
  | { ok: false; reason: "gone"; status: number; message: string }    // the message isn't in her mailbox any more
  | { ok: false; reason: "error"; status: number; message: string };

/**
 * Reply to one received message, in its own conversation, with exactly `body` as plain text.
 *
 * `POST /me/messages/{id}/reply` with `message.body` (not `comment`):
 *   - needs Mail.Send only (createReply + send would need Mail.ReadWrite and a native draft);
 *   - Graph sets In-Reply-To / References and keeps the conversationId, so it threads for both sides;
 *   - recipients are the original sender (or its Reply-To), as Graph documents;
 *   - with `message.body` set, the body IS ours — no quoted history is appended (that is `comment`'s
 *     behaviour, and the two together are a 400);
 *   - it is saved to Sent Items and returns 202 with NO id, so there is no sent Message-ID to keep.
 *     The Sent copy comes back through the Sent Items sync, where the body-fingerprint echo gate
 *     adopts it onto the row the send path wrote.
 *
 * ONLY the Outlook sender in services/replySenders.ts may call this — it is reached only from an approved
 * pending action. A guard test (routes/pendingActions.outlook.test.ts) fails if anything else references it.
 */
export async function sendOutlookReply(params: {
  connectionId: string;
  /** The Graph id of the message being answered (inbox_messages.external_message_id). */
  messageId:    string;
  body:         string;
}): Promise<OutlookReplyOutcome> {
  const token = await getAccessToken(params.connectionId);
  const res = await fetch(`${GRAPH}/me/messages/${encodeURIComponent(params.messageId)}/reply`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body:    JSON.stringify({ message: { body: { contentType: "Text", content: params.body } } }),
  });
  if (res.status === 202 || res.ok) return { ok: true };
  const json = await res.json().catch(() => null) as any;
  const code = String(json?.error?.code ?? "");
  const message = String(json?.error?.message ?? `Graph ${res.status}`);
  if (res.status === 403 || /ErrorAccessDenied|Authorization_RequestDenied|insufficient privileges/i.test(code + " " + message)) {
    return { ok: false, reason: "scope", status: res.status, message };
  }
  if (res.status === 404 || /ErrorItemNotFound/i.test(code)) {
    return { ok: false, reason: "gone", status: res.status, message };
  }
  return { ok: false, reason: "error", status: res.status, message };
}

function extractBody(msg: GraphMessage): string {
  const content = msg.body?.content ?? msg.bodyPreview ?? "";
  // With Prefer text the body is already plain; guard against HTML if a server ignores it.
  const text = msg.body?.contentType === "html"
    ? content.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    : content;
  return text.slice(0, 4000);
}

/**
 * MAILBOX_LIVE_READS: a message's PDF briefs, read in memory for their text and recorded
 * as attachment REFS (the Graph attachment id, which the mailbox adapter reads live) —
 * never copied to the bucket. Mirrors Gmail's ingest under the same flag: PDFs only, at
 * most 2, gated on Graph's reported size before any download, and a contract is stored
 * only when the athlete saves it. With the flag off this is never called and Outlook
 * ingest is unchanged (no attachments). A failure skips the file, never the message.
 */
async function livePdfAttachments(
  token: string,
  msg: GraphMessage,
): Promise<{ attachmentText?: string; attachments?: InboxAttachment[] }> {
  if (msg.hasAttachments === false) return {};
  const { listAttachments, downloadAttachment } = await import("../mailbox/outlookAdapter.js");
  let pdfs: Awaited<ReturnType<typeof listAttachments>>;
  try {
    pdfs = (await listAttachments(token, msg.id))
      .filter((a) => a.kind === "file" && !a.isInline && (a.mimeType === "application/pdf" || /\.pdf$/i.test(a.filename)));
  } catch (err: any) {
    logger.warn({ messageId: msg.id, err: err?.message }, "Outlook attachment list failed");
    return {};
  }

  const texts: string[] = [];
  const attachments: InboxAttachment[] = [];
  for (const a of pdfs.slice(0, 2)) {
    try {
      const got = await downloadAttachment(token, msg.id, a.attachmentRef, PDF_MAX_FETCH_BYTES);
      if (got.kind !== "bytes") continue;
      const parsed = got.bytes.length <= PDF_MAX_FETCH_BYTES;
      if (parsed) {
        const text = await extractPdfText(got.bytes);
        if (text) texts.push(text);
      }
      attachments.push({
        filename:       a.filename || "brief.pdf",
        content_type:   "application/pdf",
        bytes:          got.bytes.length,
        attachment_ref: a.attachmentRef,
        parsed,
      });
    } catch (err: any) {
      logger.warn({ messageId: msg.id, err: err?.message }, "Outlook PDF attachment fetch failed");
    }
  }
  return {
    ...(texts.length ? { attachmentText: texts.join("\n\n").slice(0, 8000) } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

/** The detectDeal message for a Graph message — plus its live PDF refs under MAILBOX_LIVE_READS. */
async function incomingFor(token: string, msg: GraphMessage, opts: { sent?: boolean } = {}) {
  const base = toIncoming(msg, opts);
  return mailboxLiveReadsEnabled() ? { ...base, ...(await livePdfAttachments(token, msg)) } : base;
}

// Normalize a Graph message into the detectDeal IncomingMessage shape.
// gmail* field names are historical/generic: gmailMessageId = external id,
// gmailThreadId = conversation id, messageIdHeader = RFC Message-ID.
function toIncoming(msg: GraphMessage, opts: { sent?: boolean } = {}) {
  const addr = msg.from?.emailAddress?.address ?? "";
  const name = msg.from?.emailAddress?.name ?? "";
  return {
    // Her Sent Items carry the Gmail-style SENT label, so dealDetector records them as HER
    // outbound reply on a known thread (and skips an orphan without a model call).
    ...(opts.sent ? { labelIds: ["SENT"] } : {}),
    gmailMessageId:  msg.id,
    gmailThreadId:   msg.conversationId ?? msg.id,
    subject:         msg.subject ?? "(no subject)",
    from:            name ? `${name} <${addr}>` : addr,
    body:            extractBody(msg),
    date:            msg.receivedDateTime ?? new Date().toISOString(),
    messageIdHeader: msg.internetMessageId ?? null,
    platform:        "outlook" as const,
    // A meeting request / response / cancellation is a calendar invite, never a deal (skills/meetings).
    calendar:        /eventMessage/i.test(msg["@odata.type"] ?? "") ? { part: false, outlookEvent: true } : null,
  };
}

// Walk a delta chain (following @odata.nextLink) starting at `startUrl`, running
// detectDeal per message. Returns the final @odata.deltaLink (cursor for next sync).
async function drainDelta(
  token: string,
  startUrl: string,
  onMessage: (msg: GraphMessage) => Promise<void>,
): Promise<string | undefined> {
  let url: string | undefined = startUrl;
  let deltaLink: string | undefined;

  while (url) {
    const page: DeltaPage = await graphGet<DeltaPage>(token, url);
    for (const msg of page.value ?? []) {
      if (msg["@removed"]) continue; // skip deletions/moves
      await onMessage(msg);
    }
    if (page["@odata.nextLink"]) { url = page["@odata.nextLink"]; continue; }
    deltaLink = page["@odata.deltaLink"];
    break;
  }
  return deltaLink;
}

// Fetch a deltaLink representing the CURRENT mailbox state without enumerating
// history ($deltatoken=latest). Used to seed the cursor after a bounded backfill,
// so syncRecent only ever returns mail that arrives after connection.
async function seedCursorToLatest(connectionId: string, token: string): Promise<void> {
  const startUrl = `${GRAPH}/me/mailFolders/Inbox/messages/delta?$select=${SELECT}&$deltatoken=latest`;
  const deltaLink = await drainDelta(token, startUrl, async () => { /* no-op: just want the cursor */ });
  await db.update(connectedAccounts)
    .set({ sync_cursor: deltaLink ?? null })
    .where(eq(connectedAccounts.id, connectionId));
}

// ─── InboxProvider contract ──────────────────────────────────────────────────

// Post-connect: backfill the last 90 days (regular list — delta can't $filter by date),
// then seed the delta cursor to "now" so incremental sync starts clean.
export async function onConnected(connectionId: string, athleteId: string): Promise<void> {
  const { detectDeal } = await import("../../skills/dealDetector.js");
  const token = await getAccessToken(connectionId);

  const sinceIso = new Date(Date.now() - BACKFILL_DAYS * 864e5).toISOString();

  // Her inbox AND her Sent Items, processed OLDEST FIRST: a pitch creates its thread before the
  // replies on it (hers included) arrive, so "whose turn" is right for threads she already
  // answered outside the app. Inbox-only, newest-first left those reading "your move".
  const listed: Array<{ msg: GraphMessage; sent: boolean; at: string }> = [];
  const listFolder = async (folder: "Inbox" | "SentItems", dateField: "receivedDateTime" | "sentDateTime", max: number) => {
    let url: string | undefined =
      `${GRAPH}/me/mailFolders/${folder}/messages` +
      `?$select=${folder === "SentItems" ? `${SELECT},sentDateTime` : SELECT}` +
      `&$filter=${encodeURIComponent(`${dateField} ge ${sinceIso}`)}` +
      `&$orderby=${dateField} desc&$top=50`;
    let n = 0;
    while (url && n < max) {
      const page: DeltaPage = await graphGet<DeltaPage>(token, url);
      for (const msg of page.value ?? []) {
        if (n >= max) break;
        n++;
        listed.push({ msg, sent: folder === "SentItems", at: (msg as any)[dateField] ?? msg.receivedDateTime ?? "" });
      }
      url = page["@odata.nextLink"];
    }
  };
  try {
    await listFolder("Inbox", "receivedDateTime", BACKFILL_MAX);
  } catch (err: any) {
    logger.warn({ connectionId, error: err.message }, "Outlook backfill: inbox list failed — processing what was listed");
  }
  await listFolder("SentItems", "sentDateTime", SENT_BACKFILL_MAX).catch((err: any) =>
    logger.warn({ connectionId, error: err.message }, "Outlook backfill: Sent Items list failed — inbox only"),
  );
  listed.sort((a, b) => Date.parse(a.at || "0") - Date.parse(b.at || "0"));

  let count = 0;
  const retry: typeof listed = [];
  for (const item of listed) {
    count++;
    if (!(await detectOnce(detectDeal, athleteId, connectionId, token, item))) retry.push(item);
  }
  // A message the classifier could not judge (or that threw) gets one more pass at the end
  // instead of being counted as skipped and lost; anything still failing is reported loudly.
  const lost: string[] = [];
  for (const item of retry) {
    if (!(await detectOnce(detectDeal, athleteId, connectionId, token, item))) lost.push(item.msg.id);
  }
  if (lost.length) {
    logger.error({ event: "pipeline_failure", kind: "outlook_backfill_unjudged", connectionId, athleteId, count: lost.length }, "Outlook backfill: messages still unjudged after a retry");
  }

  await seedCursorToLatest(connectionId, token).catch((err: any) =>
    logger.error({ connectionId, error: err.message }, "Outlook cursor seed failed — syncRecent will bootstrap"),
  );

  logger.info({ connectionId, athleteId, backfilled: count }, "Outlook backfill + cursor seed complete");

  // Push (OUTLOOK_PUSH): subscribe AFTER the cursor is seeded, so the first notification's delta
  // starts from it. A no-op with the flag off; a failure leaves the 6h poll in charge.
  const { outlookPushEnabled, ensureSubscription } = await import("./outlookPush.js");
  if (outlookPushEnabled()) {
    await ensureSubscription(connectionId).catch((err: any) =>
      logger.error({ connectionId, error: err.message }, "Outlook push subscription failed — poll stays in charge"),
    );
  }
}

// Incremental delta sync — the primary mechanism (no webhooks in v1). Replays the
// stored deltaLink; detectDeal dedups by (thread_id, external_message_id) so a
// message that merely changed state (e.g. marked read) is harmlessly skipped.
export async function syncRecent(connectionId: string, athleteId: string): Promise<{ detected: number; skipped: number }> {
  const { detectDeal } = await import("../../skills/dealDetector.js");
  const token = await getAccessToken(connectionId);

  const [row] = await db
    .select({ sync_cursor: connectedAccounts.sync_cursor, last_fetched_at: connectedAccounts.last_fetched_at })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, connectionId))
    .limit(1);

  // No cursor yet (e.g. onConnected seeding failed): establish one and exit — the
  // next run picks up new mail. Avoids enumerating the whole folder on a fresh delta.
  if (!row?.sync_cursor) {
    await seedCursorToLatest(connectionId, token);
    await db.update(connectedAccounts).set({ last_fetched_at: new Date() }).where(eq(connectedAccounts.id, connectionId));
    logger.debug({ connectionId }, "Outlook syncRecent: cursor bootstrapped, no messages processed");
    return { detected: 0, skipped: 0 };
  }

  let detected = 0, skipped = 0;
  let deltaLink: string | undefined;
  // A message the classifier could not judge (retryable) or that threw is queued PER MESSAGE for the
  // dead-letter retry below, and the cursor moves on. (Keeping the cursor instead let one poison
  // message freeze the whole mailbox's sync.)
  const unjudged: Array<{ id: string; error: string }> = [];

  // Retry what earlier polls could not judge, bounded per message (MAX_DEAD_LETTER_ATTEMPTS).
  await retryOutlookDeadLetters(detectDeal, athleteId, connectionId, token).catch((err: any) =>
    logger.warn({ connectionId, error: err.message }, "Outlook syncRecent: dead-letter retry failed"),
  );

  try {
    deltaLink = await drainDelta(token, row.sync_cursor, async (msg) => {
      try {
        const r = await detectDeal({ athleteId, connectionId, message: await incomingFor(token, msg) });
        if (r.retryable) unjudged.push({ id: msg.id, error: String((r as any).reason ?? "retryable") });
        else if (r.skipped) skipped++; else detected++;
      } catch (err: any) {
        unjudged.push({ id: msg.id, error: String(err?.message ?? "threw") });
        logger.warn({ connectionId, messageId: msg.id, error: err.message }, "Outlook syncRecent: detectDeal threw");
      }
    });
  } catch (err: any) {
    // 410 Gone = deltaLink expired (links live ~30 days). Re-seed to current state.
    if (err instanceof GraphError && err.status === 410) {
      logger.warn({ connectionId }, "Outlook delta cursor expired (410) — re-seeding to latest");
      await seedCursorToLatest(connectionId, token);
      await db.update(connectedAccounts).set({ last_fetched_at: new Date() }).where(eq(connectedAccounts.id, connectionId));
      return { detected, skipped };
    }
    throw err;
  }

  // Her sent replies since the last poll (Sent Items is not in the Inbox delta). Read by date with
  // an overlap; detectDeal records each as HER outbound on its thread, idempotently.
  const sentSince = new Date((row.last_fetched_at?.getTime() ?? Date.now() - 864e5) - SENT_OVERLAP_MS).toISOString();
  await syncSentItems(detectDeal, athleteId, connectionId, token, sentSince).catch((err: any) =>
    logger.warn({ connectionId, error: err.message }, "Outlook syncRecent: Sent Items read failed"),
  );

  if (unjudged.length) {
    await db.insert(gmailDeadLetters)
      .values(unjudged.map((u) => ({ connected_account_id: connectionId, athlete_id: athleteId, gmail_message_id: u.id, error: u.error.slice(0, 500) })))
      .onConflictDoNothing();
    logger.warn({ connectionId, unjudged: unjudged.length }, "Outlook syncRecent: messages unjudged — queued for retry");
  }
  await db.update(connectedAccounts).set({
    sync_cursor:     deltaLink ?? row.sync_cursor,
    last_fetched_at: new Date(),
  }).where(eq(connectedAccounts.id, connectionId));

  logger.debug({ connectionId, detected, skipped }, "Outlook syncRecent complete");
  return { detected, skipped };
}

type DetectFn = (p: { athleteId: string; connectionId: string; message: any }) => Promise<{ skipped?: boolean; retryable?: boolean }>;

/** detectDeal once; false when it could not judge the message (retryable) or threw. */
async function detectOnce(
  detectDeal: DetectFn, athleteId: string, connectionId: string, token: string,
  item: { msg: GraphMessage; sent: boolean },
): Promise<boolean> {
  try {
    const r = await detectDeal({ athleteId, connectionId, message: await incomingFor(token, item.msg, { sent: item.sent }) });
    return !r.retryable;
  } catch (err: any) {
    logger.warn({ connectionId, messageId: item.msg.id, error: err.message }, "Outlook: detectDeal threw");
    return false;
  }
}

/** Her Sent Items since `sinceIso`, oldest first, each recorded as her outbound reply on its thread. */
async function syncSentItems(detectDeal: DetectFn, athleteId: string, connectionId: string, token: string, sinceIso: string): Promise<void> {
  let url: string | undefined =
    `${GRAPH}/me/mailFolders/SentItems/messages` +
    `?$select=${SELECT},sentDateTime` +
    `&$filter=${encodeURIComponent(`sentDateTime ge ${sinceIso}`)}` +
    `&$orderby=sentDateTime asc&$top=50`;
  let pages = 0;
  while (url && pages < 10) {
    const page: DeltaPage = await graphGet<DeltaPage>(token, url);
    for (const msg of page.value ?? []) await detectOnce(detectDeal, athleteId, connectionId, token, { msg, sent: true });
    url = page["@odata.nextLink"];
    pages++;
  }
}

/** Attempts per queued message before it is reported as lost (same bound as Gmail's). */
const MAX_DEAD_LETTER_ATTEMPTS = 5;

/**
 * Retry Outlook messages a poll could not judge. They share the dead-letter table with Gmail (gmail_dead_letters is keyed
 * by connection + provider message id; the column name is historical). Each is re-fetched from Graph by id and run through
 * detectDeal: dropped on success or when Graph no longer has it, otherwise its attempts are counted, up to the bound.
 */
export async function retryOutlookDeadLetters(detectDeal: DetectFn, athleteId: string, connectionId: string, token: string): Promise<void> {
  const rows = await db.select().from(gmailDeadLetters)
    .where(and(
      eq(gmailDeadLetters.connected_account_id, connectionId),
      lt(gmailDeadLetters.attempts, MAX_DEAD_LETTER_ATTEMPTS),
      dueSql(new Date()),          // backoff: 15 min × 2^attempts since the last attempt
    ))
    .limit(25);
  for (const dl of rows) {
    // One retrier per row: the push-triggered sync and the 6-hour poll can't both retry it.
    if (!(await claimDeadLetter(dl))) continue;
    let msg: GraphMessage | null = null;
    try {
      msg = await graphGet<GraphMessage>(token, `${GRAPH}/me/messages/${encodeURIComponent(dl.gmail_message_id)}?$select=${SELECT}`);
    } catch (err: any) {
      if (err instanceof GraphError && err.status === 404) {
        await db.delete(gmailDeadLetters).where(eq(gmailDeadLetters.id, dl.id));   // gone from the mailbox
        continue;
      }
    }
    let ok = false;
    if (msg) ok = await detectOnce(detectDeal, athleteId, connectionId, token, { msg, sent: false });
    if (ok) {
      await db.delete(gmailDeadLetters).where(eq(gmailDeadLetters.id, dl.id));
      continue;
    }
    const attempts = dl.attempts + 1;
    await db.update(gmailDeadLetters).set({ attempts, last_attempt_at: new Date() }).where(eq(gmailDeadLetters.id, dl.id));
    if (attempts >= MAX_DEAD_LETTER_ATTEMPTS) {
      logger.error({ event: "pipeline_failure", kind: "dead_letter_exhausted", connectionId, messageId: dl.gmail_message_id }, "Outlook: queued message exhausted retries");
    }
  }
}
