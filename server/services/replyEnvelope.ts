/**
 * replyEnvelope.ts — who a reply goes to, and its subject line, without a stored copy.
 *
 * Under MAILBOX_ZERO_RETENTION a thread keeps no subject, and a sender who is not a
 * counterparty on an opportunity is kept only as a pseudonym (lib/mailbox/retention.ts).
 * The send path (threadReply) and the native-draft mirror (saveThreadDraft) still need a
 * real recipient and a "Re: …" subject, so they ask here: a stored value is used when there
 * is one (legacy rows, counterparties), otherwise the newest inbound message is read LIVE
 * from the mailbox, by its ids, and nothing it returns is written anywhere.
 */

import { readStoredMessageLive } from "./liveConversation";
import { isPseudonymousSender } from "../lib/mailbox/retention";
import type { StoredMessageIds } from "../lib/mailbox/refs";

export interface EnvelopeRow extends StoredMessageIds {
  sender_email: string | null;
}

export interface ReplyEnvelope {
  toEmail: string | null;
  subject: string | null;
}

/**
 * Recipient + subject for a reply. `inboundNewestFirst` are the thread's inbound rows,
 * newest first. Stored values win; the live read fills only what is missing, and only
 * under MAILBOX_LIVE_READS (readStoredMessageLive is null otherwise).
 */
export async function resolveReplyEnvelope(
  storedSubject: string | null | undefined,
  inboundNewestFirst: EnvelopeRow[],
): Promise<ReplyEnvelope> {
  // Exactly the old rule (newest inbound's stored sender, else any stored sender), except a
  // pseudonym is never an address.
  const usable = (s: string | null | undefined) => (s && !isPseudonymousSender(s) ? s : null);
  let toEmail = usable(inboundNewestFirst[0]?.sender_email)
    ?? inboundNewestFirst.map((m) => usable(m.sender_email)).find(Boolean)
    ?? null;
  let subject = storedSubject ?? null;
  if (toEmail && subject != null) return { toEmail, subject };

  const fetchable = inboundNewestFirst.find((m) => m.external_message_id && m.connected_account_id);
  if (!fetchable) return { toEmail, subject };
  const live = await readStoredMessageLive(fetchable);
  if (live && live.ok) {
    // The newest inbound row's own sender is the person being answered — prefer it over an
    // older stored address only when no stored address exists at all.
    toEmail = toEmail ?? live.message.fromEmail ?? null;
    subject = subject ?? (live.message.subject?.trim() ? live.message.subject : null);
  }
  return { toEmail, subject };
}
