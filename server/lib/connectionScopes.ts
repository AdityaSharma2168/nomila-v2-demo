/**
 * connectionScopes.ts — which stored OAuth scopes let a Gmail (or Outlook) connection send or draft.
 *
 * ONE place for these, because four readers must agree: GET /connections (can_send /
 * can_draft for Settings), draft save, send, and the thread `inbox` block. When they
 * disagreed the app said "connected" while the server refused.
 *
 * gmail.send authorises sending only — the Gmail API rejects drafts.create on a
 * send-only grant — so drafting needs a DIFFERENT, narrower set than sending.
 */

/** Scopes that let a Gmail grant send mail. */
export const GMAIL_SEND_SCOPE = /gmail\.send|gmail\.modify|gmail\.compose|mail\.google\.com/;

/**
 * The scope that lets an Outlook grant reply through Microsoft Graph (`/me/messages/{id}/reply`).
 * Mail.Send exactly: Mail.Send.Shared (send as another mailbox) is a different permission and does
 * not count. Microsoft may report it bare or as a resource URL ("https://graph.microsoft.com/Mail.Send").
 */
export const OUTLOOK_SEND_SCOPE = /(^|[\s/])Mail\.Send(?=\s|$)/i;

/** Scopes that let a Gmail grant create/update Drafts. */
export const GMAIL_DRAFT_SCOPE = /gmail\.compose|gmail\.modify|mail\.google\.com/;

/**
 * Google's refusal when a token lacks the scope for the call — e.g. drafts.create on a
 * grant issued before gmail.compose was requested. Matched on the message because the
 * integrations surface Google's error text, not the status.
 */
export const INSUFFICIENT_SCOPE_ERROR =
  /insufficient (authentication )?scopes?|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i;
