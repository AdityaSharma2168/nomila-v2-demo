/**
 * mailbox/refs.ts — neutral accessors over the legacy, Gmail-named inbox columns.
 *
 * inbox_messages predates the mailbox contract: the provider's grouping lives in
 * `gmail_thread_id` (Outlook already writes its conversationId there), the RFC 5322
 * Message-ID in `gmail_message_id_header`, the provider message id in
 * `external_message_id`. The columns stay for back-compat; NEW code reads them only
 * through these accessors, so a later rename touches one file.
 */

import { mailboxProviderOf } from "./index";
import type { MailboxMessageRef } from "./types";

export interface StoredMessageIds {
  platform:                string | null;
  connected_account_id:    string | null;
  external_message_id:     string | null;
  gmail_thread_id?:        string | null;
  gmail_message_id_header?: string | null;
}

/** The provider grouping a stored message belongs to (Gmail threadId / Outlook conversationId). */
export function conversationRefOf(row: Pick<StoredMessageIds, "gmail_thread_id">): string | null {
  return row.gmail_thread_id ?? null;
}

/** RFC 5322 Message-ID of a stored message, when ingest captured it. */
export function internetMessageIdOf(row: Pick<StoredMessageIds, "gmail_message_id_header">): string | null {
  return row.gmail_message_id_header ?? null;
}

/** The full mailbox ref for a stored message, or null when it is not mailbox mail / lacks ids. */
export function messageRefOf(row: StoredMessageIds): MailboxMessageRef | null {
  const provider = mailboxProviderOf(row.platform ?? "gmail");
  if (!provider || !row.connected_account_id || !row.external_message_id) return null;
  return {
    provider,
    accountId: row.connected_account_id,
    messageRef: row.external_message_id,
    conversationRef: conversationRefOf(row),
    internetMessageId: internetMessageIdOf(row),
  };
}
