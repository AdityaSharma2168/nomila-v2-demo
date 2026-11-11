/**
 * partner/inboundMail.ts — a brand replies to a Nomila notice by email, and the reply lands in the request's thread
 * (design §7a). Provider: a dedicated Google Workspace mailbox (PARTNER_INBOX_ADDRESS, default partners@nomila.co),
 * read through the Gmail API and polled every few minutes (server/index.ts, PARTNER_INBOUND_MAIL only).
 *
 * Each notice's Reply-To is the mailbox's plus-address, <local>+<token>@<domain>; Gmail delivers it to the mailbox.
 *
 *   1. list the inbox messages not yet labelled PARTNER.inboxProcessedLabel (a small batch per poll);
 *   2. read ONLY the From / To / Cc / Delivered-To headers first. A message not addressed to a <local>+<token>
 *      plus-address is labelled and left alone — its body is never fetched;
 *   3. resolve the token to ONE confirmed request (token hash lookup);
 *   4. accept it only from the address the request came from;
 *   5. fetch the message, keep its plain text (HTML converted when there is no text part), strip the quoted history
 *      and signature-style tails, then hand the text to the relay as the visitor (moderated; held messages are never
 *      delivered). The Gmail message id is the message's external id, so seeing it again is a no-op;
 *   6. label the message as processed (outcome whatever it was). A failure before the label (database down) leaves it
 *      unlabelled, so the next poll retries it.
 * Nothing in the email beyond the new text is stored.
 *
 * Auth: keyless domain-wide delegation (lib/gmailSender.ts) — a token acting as the partner mailbox ONLY, for
 * gmail.modify ONLY (read + label). No other mailbox is ever impersonated with that scope. Tests replace the Gmail
 * boundary with setPartnerInbox.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { partnerRequests } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { GMAIL_MODIFY_SCOPE, getDelegatedGmailToken, getGmailSender, htmlToText } from "../../lib/gmailSender";
import { take } from "../../lib/publicRateCounters";
import { PARTNER } from "./config";
import { relayPartnerMessage } from "./threads";
import { normEmail, sha256 } from "./tokens";

const logger = createLogger("services/partner/inbound-mail");

/** "Name <a@b.example>" or "a@b.example" → "a@b.example". */
export function addressOf(raw: string): string | null {
  const m = /<([^<>@\s]+@[^<>\s]+)>/.exec(raw) ?? /([^\s<>"]+@[^\s<>"]+)/.exec(raw);
  return m ? normEmail(m[1]) : null;
}

/** Every address in a header value ("A <a@x.example>, b@y.example"), lower-cased. */
export function addressesIn(value: string): string[] {
  return (value.match(/[^\s<>",;:]+@[^\s<>",;:]+/g) ?? []).map(normEmail);
}

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reply token in <local>+<token>@<domain> of the partner inbox, from any recipient. */
export function replyTokenIn(recipients: string[], inbox: string = PARTNER.inboxAddress): string | null {
  const at = inbox.lastIndexOf("@");
  if (at < 1) return null;
  const re = new RegExp(`^${reEscape(inbox.slice(0, at).toLowerCase())}\\+([0-9a-f]{32})@${reEscape(inbox.slice(at + 1).toLowerCase())}$`);
  for (const r of recipients) {
    const a = addressOf(r);
    const m = a ? re.exec(a) : null;
    if (m) return m[1];
  }
  return null;
}

/** The new text of a reply: everything above the quoted history (">" lines, "On … wrote:", forwarded / original headers). */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const next = lines[i + 1] ?? "";
    if (/^\s*>/.test(l)) break;
    if (/^\s*On\b.*\bwrote:\s*$/i.test(l) || (/^\s*On\b/i.test(l) && /\bwrote:\s*$/i.test(next))) break;
    if (/^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(l)) break;
    if (/^\s*_{10,}\s*$/.test(l)) break;
    if (/^\s*From:\s.+/i.test(l) && /^\s*(Sent|Date|To):\s/i.test(next)) break;
    if (/^\s*-- \s*$/.test(l)) break;   // RFC 3676 signature separator
    out.push(l);
  }
  return out.join("\n").trim();
}

// ── Gmail message shapes ────────────────────────────────────────────────────────────────────────────────────────────

interface GmailHeader { name?: string; value?: string }
interface GmailPart { mimeType?: string; headers?: GmailHeader[]; body?: { data?: string; attachmentId?: string }; parts?: GmailPart[] }

const header = (headers: GmailHeader[] | undefined, name: string): string[] =>
  (headers ?? []).filter((h) => h.name?.toLowerCase() === name.toLowerCase()).map((h) => h.value ?? "");

/** The From address and every recipient (To, Cc, Delivered-To) from a message's headers. */
export function envelopeOf(headers: GmailHeader[] | undefined): { from: string; recipients: string[] } {
  return {
    from:       header(headers, "From")[0] ?? "",
    recipients: ["To", "Cc", "Delivered-To"].flatMap((n) => header(headers, n)).flatMap(addressesIn),
  };
}

const decode = (data: string): string => Buffer.from(data, "base64url").toString("utf8");

/** The message's plain text: the first inline text/plain part, else the first text/html part converted. Attachments skipped. */
export function textOfPayload(payload: GmailPart | undefined): string | null {
  const find = (p: GmailPart | undefined, mime: string): string | null => {
    if (!p) return null;
    if (p.mimeType?.toLowerCase() === mime && p.body?.data && !p.body.attachmentId) return decode(p.body.data);
    for (const c of p.parts ?? []) { const t = find(c, mime); if (t !== null) return t; }
    return null;
  };
  const plain = find(payload, "text/plain");
  if (plain !== null) return plain;
  const html = find(payload, "text/html");
  return html !== null ? htmlToText(html) : null;
}

// ── the Gmail boundary ──────────────────────────────────────────────────────────────────────────────────────────────

/** What the relay needs from a received email. */
export interface ReceivedEmail { id: string; from: string; to: string[]; text: string | null }

/** The partner mailbox, as the poller uses it. Tests replace it with setPartnerInbox. */
export interface PartnerInbox {
  /** Ids of inbox messages not yet labelled processed (Gmail's order, newest first), at most `max`. */
  unprocessed(max: number): Promise<string[]>;
  /** From + recipients only (format=metadata). Null when the message is gone. */
  envelope(id: string): Promise<{ from: string; recipients: string[] } | null>;
  /** The full message (format=full) reduced to what the relay needs. Null when the message is gone. */
  read(id: string): Promise<ReceivedEmail | null>;
  /** Add the processed label. */
  markProcessed(id: string): Promise<void>;
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The real mailbox: Gmail API as PARTNER.inboxAddress, gmail.modify scope only. */
export function gmailPartnerInbox(address: string = PARTNER.inboxAddress, labelName: string = PARTNER.inboxProcessedLabel): PartnerInbox {
  let labelId: string | null = null;

  async function call(path: string, init: RequestInit = {}): Promise<any> {
    const token = await getDelegatedGmailToken(address, GMAIL_MODIFY_SCOPE);
    const res = await fetch(`${GMAIL}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    if (res.status === 401) getGmailSender().dropToken(address, GMAIL_MODIFY_SCOPE);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gmail ${init.method ?? "GET"} ${path.split("?")[0].replace(/\/messages\/[^/]+/, "/messages/:id")} ${res.status}`);
    return res.json();
  }

  async function processedLabelId(): Promise<string> {
    if (labelId) return labelId;
    const find = async () => ((await call("/labels"))?.labels ?? []).find((l: any) => l.name === labelName)?.id as string | undefined;
    let id = await find();
    if (!id) {
      try {
        id = (await call("/labels", { method: "POST", body: JSON.stringify({ name: labelName, labelListVisibility: "labelShow", messageListVisibility: "show" }) }))?.id;
      } catch { id = await find(); }   // created concurrently by another instance
    }
    if (!id) throw new Error("gmail: could not find or create the processed label");
    labelId = id;
    return id;
  }

  return {
    async unprocessed(max) {
      const q = encodeURIComponent(`in:inbox -label:${labelName}`);
      const j = await call(`/messages?q=${q}&maxResults=${max}`);
      return ((j?.messages ?? []) as Array<{ id?: string }>).map((m) => m.id).filter((id): id is string => !!id);
    },
    async envelope(id) {
      const hs = ["From", "To", "Cc", "Delivered-To"].map((h) => `metadataHeaders=${h}`).join("&");
      const j = await call(`/messages/${encodeURIComponent(id)}?format=metadata&${hs}`);
      return j ? envelopeOf(j.payload?.headers) : null;
    },
    async read(id) {
      const j = await call(`/messages/${encodeURIComponent(id)}?format=full`);
      if (!j) return null;
      const env = envelopeOf(j.payload?.headers);
      return { id, from: env.from, to: env.recipients, text: textOfPayload(j.payload) };
    },
    async markProcessed(id) {
      await call(`/messages/${encodeURIComponent(id)}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: [await processedLabelId()] }) });
    },
  };
}

let inbox: PartnerInbox | null = null;
export function setPartnerInbox(i: PartnerInbox | null): void { inbox = i; }
const currentInbox = (): PartnerInbox => (inbox ??= gmailPartnerInbox());

// ── matching + storage ──────────────────────────────────────────────────────────────────────────────────────────────

export type InboundOutcome = "relayed" | "held" | "blocked" | "duplicate" | "ignored";

/** Handle one received email. Never throws for a bad email: it is "ignored" (logged with ids only). */
export async function handleInboundMail(mail: ReceivedEmail, now: Date = new Date()): Promise<{ outcome: InboundOutcome; reason?: string }> {
  const token = replyTokenIn(mail.to);
  if (!token) return { outcome: "ignored", reason: "not_a_reply_address" };
  const [row] = await db.select().from(partnerRequests)
    .where(and(eq(partnerRequests.reply_token_hash, sha256(token)), eq(partnerRequests.status, "confirmed"))).limit(1);
  if (!row) return { outcome: "ignored", reason: "unknown_thread" };
  if (!row.contact_email || addressOf(mail.from) !== normEmail(row.contact_email)) {
    logger.info({ requestId: row.id }, "inbound reply from another address — not relayed");
    return { outcome: "ignored", reason: "sender" };
  }
  if (row.outcome === "declined") return { outcome: "ignored", reason: "closed" };
  if (!(await take(["inbound", row.id], PARTNER.limits.inboundPerThreadHour, "hour", now))) return { outcome: "ignored", reason: "rate" };
  const body = stripQuoted(mail.text ?? "");
  if (!body) return { outcome: "ignored", reason: "empty" };
  const r = await relayPartnerMessage(row, "visitor", body.slice(0, 2_000), { externalId: `nomila:inbound:${mail.id}`, now });
  if (!r.ok) return { outcome: "ignored", reason: r.error };
  if (r.duplicate) return { outcome: "duplicate" };
  return { outcome: r.moderation === "clean" ? "relayed" : r.moderation };
}

/** One message: headers first, the body only for a reply address, then the processed label. */
async function processOne(box: PartnerInbox, id: string, now: Date): Promise<{ outcome: InboundOutcome; reason?: string }> {
  const env = await box.envelope(id);
  let r: { outcome: InboundOutcome; reason?: string };
  if (!env) r = { outcome: "ignored", reason: "unreadable" };
  else if (!replyTokenIn(env.recipients)) r = { outcome: "ignored", reason: "not_a_reply_address" };   // body never fetched
  else {
    const mail = await box.read(id);
    r = mail ? await handleInboundMail(mail, now) : { outcome: "ignored", reason: "unreadable" };
  }
  if (env) await box.markProcessed(id);
  return r;
}

/** One poll of the partner mailbox. A message that fails before its label stays unlabelled and is retried next poll. */
export async function pollPartnerInbox(now: Date = new Date(), box: PartnerInbox = currentInbox()): Promise<{ seen: number; failed: number; outcomes: Record<string, number> }> {
  const ids = await box.unprocessed(PARTNER.inboxBatch);
  const outcomes: Record<string, number> = {};
  let failed = 0;
  for (const id of ids) {
    try {
      const r = await processOne(box, id, now);
      const k = r.reason ? `${r.outcome}:${r.reason}` : r.outcome;
      outcomes[k] = (outcomes[k] ?? 0) + 1;
    } catch (err: any) {
      failed++;
      logger.error({ messageId: id, error: err?.message }, "partner inbox message failed — left for the next poll");
    }
  }
  if (ids.length) logger.info({ seen: ids.length, failed, outcomes }, "partner inbox polled");
  return { seen: ids.length, failed, outcomes };
}
