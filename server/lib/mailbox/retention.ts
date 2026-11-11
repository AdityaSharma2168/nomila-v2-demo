/**
 * mailbox/retention.ts — zero raw retention ("Mailbox Owns Correspondence", step 2).
 *
 * MAILBOX_ZERO_RETENTION — when on, ingest processes a message in memory and stores only
 * ids, direction, time, body_sha256 and the derived fields: NO body, NO subject, and the
 * sender's full address only for a counterparty on an opportunity (approved decision 3;
 * everyone else is kept as a domain + SHA-256 pseudonym, see pseudonymousSender).
 *
 * It only takes effect TOGETHER with MAILBOX_LIVE_READS. Every reader that used to re-read a
 * stored body reads the mailbox live under that flag; without it, a row with no body would
 * leave the summarizer, drafter and thread view with nothing to read. So zero retention on
 * its own is refused (logged once) and ingest keeps storing exactly as before.
 *
 * Instagram DMs are the one deliberate exception: content stays stored for platform
 * 'instagram' even with both flags on. Meta's Instagram-Login Conversations API only returns
 * details for the 20 most recent messages of a conversation ("If you query a message that is
 * older than the last 20, you will see an error that the message has been deleted"), and that
 * the webhook `mid` is the id GET /<MESSAGE_ID> accepts is not documented — so there is no
 * reliable live re-read for an older DM yet. See the PR for the sources.
 */

import { createHash } from "node:crypto";
import { mailboxLiveReadsEnabled } from "./index";
import { createLogger } from "../../logger";

const logger = createLogger("lib/mailbox/retention");

let warnedWithoutLiveReads = false;

/** True when MAILBOX_ZERO_RETENTION is requested AND live reads are on (see module note). */
export function mailboxZeroRetentionEnabled(): boolean {
  const asked = process.env.MAILBOX_ZERO_RETENTION?.trim().toLowerCase() === "true";
  if (!asked) return false;
  if (!mailboxLiveReadsEnabled()) {
    if (!warnedWithoutLiveReads) {
      warnedWithoutLiveReads = true;
      logger.warn("MAILBOX_ZERO_RETENTION is on but MAILBOX_LIVE_READS is off — content is still stored");
    }
    return false;
  }
  return true;
}

/**
 * Platforms whose content is still stored under zero retention:
 *   instagram — no reliable live re-read (see the module note);
 *   nomila    — Nomila's OWN relay record (partner requests from her public card, design §7a): not mailbox content,
 *               there is no mailbox to re-read it from, and the stored row IS the conversation both sides read. It
 *               was written by Nomila and moderated before delivery; services/partner/threads.ts is its only reader.
 */
export const ZERO_RETENTION_EXCEPTIONS: ReadonlySet<string> = new Set(["instagram", "nomila"]);

/**
 * Should ingest keep the body / subject / sender name of a message on this platform?
 * true = store as before; false = zero retention applies.
 */
export function retainsMessageContent(platform: string | null | undefined): boolean {
  if (!mailboxZeroRetentionEnabled()) return true;
  return ZERO_RETENTION_EXCEPTIONS.has(platform ?? "gmail");
}

const PSEUDO_PREFIX = "sha256-";
const PSEUDO_RE = /^sha256-[0-9a-f]{64}@/;

/**
 * The stored form of a sender who is NOT a counterparty on an opportunity: the SHA-256 of
 * the lower-cased address, kept at its domain — `sha256-<hex>@<domain>`.
 *
 * Kept in the existing sender_email column on purpose (no migration): sender memory compares
 * addresses by equality and domains with split_part(sender, '@', 2), and both keep working on
 * this form — a repeat sender hashes to the same value, and the domain is still the domain.
 * It is not an address: nothing may send to it (isPseudonymousSender guards the reply paths).
 */
export function pseudonymousSender(email: string | null | undefined): string | null {
  const addr = (email ?? "").trim().toLowerCase();
  if (!addr || !addr.includes("@")) return null;
  if (PSEUDO_RE.test(addr)) return addr;
  const domain = addr.slice(addr.lastIndexOf("@") + 1);
  const hex = createHash("sha256").update(addr, "utf8").digest("hex");
  return `${PSEUDO_PREFIX}${hex}@${domain}`;
}

/** True for a stored sender written by pseudonymousSender — never an address to send to. */
export function isPseudonymousSender(stored: string | null | undefined): boolean {
  return !!stored && PSEUDO_RE.test(stored.trim().toLowerCase());
}

/** A stored sender that is a real, sendable address (not a pseudonym, has an @). */
export function sendableAddress(stored: string | null | undefined): string | null {
  const s = (stored ?? "").trim();
  if (!s || !s.includes("@") || isPseudonymousSender(s)) return null;
  return s;
}

/**
 * The inbox_messages content columns for one ingested message, under the retention rule.
 *
 *   counterparty — the message is on a thread that is (or is about to become) a deal under an
 *                  opportunity: its sender is the person the deal is with, and the reply
 *                  recipient. Their full address is commercial contact data (decision 3).
 */
export function storedMessageContent(input: {
  platform:     string | null | undefined;
  senderEmail:  string | null;
  senderName:   string | null;
  subject:      string | null;
  body:         string | null;
  counterparty: boolean;
}): { sender_email: string | null; sender_name: string | null; subject: string | null; body: string | null } {
  if (retainsMessageContent(input.platform)) {
    return { sender_email: input.senderEmail, sender_name: input.senderName, subject: input.subject, body: input.body };
  }
  return {
    sender_email: input.counterparty ? input.senderEmail : pseudonymousSender(input.senderEmail),
    sender_name:  null,
    subject:      null,
    body:         null,
  };
}
