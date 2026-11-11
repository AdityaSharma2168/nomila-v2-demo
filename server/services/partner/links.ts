/**
 * partner/links.ts — the visitor's private links and the per-thread reply-to address, and the one place partner
 * emails are rendered and handed to the email lib (server/lib/notify.ts sendEmail: Gmail when EMAIL_PROVIDER=gmail,
 * otherwise a logged "would send" and no throw).
 */
import { publicBaseUrl } from "../../lib/baseUrls";
import { sendTemplate, type EmailTemplate, type TemplateSendResult, type TemplateVars } from "../notify/templates";
import { PARTNER, partnerInboundMailEnabled } from "./config";
import { deriveToken } from "./tokens";

export const confirmUrl = (token: string): string => `${publicBaseUrl()}/partner/confirm/${encodeURIComponent(token)}`;
export const statusUrl = (token: string): string => `${publicBaseUrl()}/r/${encodeURIComponent(token)}`;
export const requestsUrl = (): string => `${publicBaseUrl()}/requests`;

/** The status link for a confirmed request, re-derived from its row (no token is stored). */
export function statusUrlFor(row: { id: string; token_nonce: string }): string {
  return statusUrl(deriveToken("status", row.id, row.token_nonce));
}

/** <local>+<token>@<domain> of the partner inbox (PARTNER_INBOX_ADDRESS), or null while email replies are off. */
export function replyAddressFor(row: { id: string; token_nonce: string }): string | null {
  if (!partnerInboundMailEnabled()) return null;
  const at = PARTNER.inboxAddress.lastIndexOf("@");
  if (at < 1) return null;
  return `${PARTNER.inboxAddress.slice(0, at)}+${deriveToken("reply", row.id, row.token_nonce)}${PARTNER.inboxAddress.slice(at)}`;
}

/** Render one of PARTNER_TEMPLATES and send it (the shared helper: "would send" with no provider; never throws). */
export function sendPartnerEmail(to: string, template: EmailTemplate, vars: TemplateVars, replyTo?: string | null): Promise<TemplateSendResult> {
  return sendTemplate(to, template, vars, { replyTo });
}
