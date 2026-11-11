/**
 * mailbox/types.ts — the one contract Nomila reads correspondence through.
 *
 * "Mailbox Owns Correspondence" (design note, 6 Oct 2026): the mailbox keeps the mail,
 * Nomila keeps the deal. Every reader that used to re-read a stored inbox_messages body
 * asks a MailboxAdapter instead, and the deal logic never learns which provider answered.
 *
 * Provider-neutral on purpose. Gmail is the first adapter; Outlook (Microsoft Graph) is
 * next, and nothing here may assume Gmail:
 *   - refs are OPAQUE strings tagged with their provider. A consumer never parses one.
 *     (Outlook ids change on folder moves unless the adapter asks for ImmutableId, so
 *     "stable" is the adapter's job, not a property any consumer may rely on.)
 *   - a conversation is "the provider's grouping" (Gmail threadId, Outlook conversationId),
 *     returned oldest-first by sent time; consumers never read provider thread metadata.
 *   - direction comes from the account's own address vs `from`, never from labels/folders.
 *   - bodies arrive as normalised `text`; consumers see nothing else.
 *   - an attachment may be a cloud link that cannot be downloaded (Outlook
 *     referenceAttachment), so fetchAttachment can answer `not_downloadable`.
 *   - search takes a structured query; each adapter translates it.
 *   - every adapter throws the same four typed errors.
 *
 * Send is NOT here yet: it stays on the governed #771 path. Notifications/cursors are out
 * of Phase 1 scope and are deliberately absent from these shared types.
 */

export type MailboxProvider = "gmail" | "outlook";

/** Durable, provider-tagged pointer to one message. Every string is opaque. */
export interface MailboxMessageRef {
  provider:          MailboxProvider;
  /** connected_accounts.id of the mailbox that holds the message. */
  accountId:         string;
  /**
   * The provider's message id. Opaque. Gmail: the message id. Outlook: the DEFAULT Graph
   * id ingest stored (delta sync is on default ids; see outlookAdapter.ts for why the
   * adapter does not switch to ImmutableId) — it survives everything but a folder move.
   */
  messageRef:        string;
  /** The provider's grouping (Gmail threadId; Outlook conversationId). Opaque. */
  conversationRef:   string | null;
  /** RFC 5322 Message-ID, when the provider exposes it — the cross-provider dedupe key. */
  internetMessageId?: string | null;
}

export interface MailboxAttachmentMeta {
  /** Opaque; meaningful only to the adapter that produced it. */
  attachmentRef: string;
  filename:      string;
  mimeType:      string;
  size:          number | null;
  /** "link" = a cloud reference (e.g. OneDrive) with no downloadable bytes. */
  kind:          "file" | "link";
}

export interface MailboxMessage {
  ref:        MailboxMessageRef;
  /** Raw From header value ("Name <addr>") — UNTRUSTED. */
  from:       string;
  fromEmail:  string | null;
  fromName:   string | null;
  subject:    string;
  /** ISO timestamp of when the provider says the message was sent/received. */
  sentAt:     string;
  /** Decided from the account's own address vs `from`. */
  direction:  "inbound" | "outbound";
  /** Normalised plain text (quoted history stripped). UNTRUSTED. */
  text:       string;
  attachments: MailboxAttachmentMeta[];
}

export type MailboxAttachmentResult =
  | { kind: "bytes"; bytes: Buffer; filename: string; mimeType: string }
  | { kind: "not_downloadable"; reason: "link" | "too_large" };

/** Structured search. Adapters translate it (Gmail `q`, Outlook KQL `$search`). */
export interface MailboxSearchQuery {
  text?:          string;
  from?:          string;
  after?:         Date;
  before?:        Date;
  hasAttachment?: boolean;
  limit:          number;
}

export interface MailboxSearchHit {
  ref:          MailboxMessageRef;
  senderDomain: string | null;
  sentAt:       string | null;
  /** The provider's own snippet. UNTRUSTED. */
  snippet:      string;
}

export interface MailboxAdapter {
  readonly provider: MailboxProvider;
  fetchMessage(accountId: string, messageRef: string): Promise<MailboxMessage>;
  /** Every message in the provider's grouping, oldest first by sentAt. */
  fetchConversation(accountId: string, conversationRef: string): Promise<MailboxMessage[]>;
  /** `maxBytes` is the caller's cap; over it the adapter answers not_downloadable/too_large. */
  fetchAttachment(
    accountId: string,
    messageRef: string,
    attachmentRef: string,
    opts: { maxBytes: number },
  ): Promise<MailboxAttachmentResult>;
  search(accountId: string, query: MailboxSearchQuery): Promise<MailboxSearchHit[]>;
}

/**
 * The same four failures for every provider.
 *   disconnected — the grant is revoked/expired or the account is not active
 *   not_found    — the message/conversation was deleted in the mailbox
 *   rate_limited — the provider throttled us (retryable with backoff)
 *   transient    — network / 5xx (retryable with backoff)
 */
export type MailboxErrorKind = "disconnected" | "not_found" | "rate_limited" | "transient";

export class MailboxError extends Error {
  /**
   * `retryAfterMs` — how long the provider asked us to wait (an HTTP Retry-After), when it
   * said. withMailboxRetry honours it instead of its own backoff.
   */
  constructor(public readonly kind: MailboxErrorKind, message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = "MailboxError";
  }
}

export function isMailboxError(err: unknown): err is MailboxError {
  return err instanceof MailboxError;
}
