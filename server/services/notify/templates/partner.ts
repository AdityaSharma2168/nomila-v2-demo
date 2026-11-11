/**
 * notify/templates/partner.ts — every email a brand or press visitor gets about a request sent from a public profile,
 * on the shared helper (render.ts renderTemplate / send.ts sendTemplate).
 *
 * CONTENT-FREE by rule (design §7a): no message text ever leaves in an email, only that something happened and the
 * private link to look. Amounts appear only in the money notices (hold placed / counted / released). Visitor copy never
 * says "brief". {{first}} is the first name her published card showed the visitor, never hard-coded.
 */
import type { EmailTemplate } from "./render";

const RELAY = "Messages go through Nomila and are checked. Nomila never shares your email or phone number with her, or hers with you.";
const REF = "Reference {{ref}}";
const OPEN = { label: "Open your request", urlVar: "link" };
const t = (name: string, subject: string, paragraphs: string[], button?: EmailTemplate["button"], footer = REF): EmailTemplate =>
  ({ name, subject, paragraphs, ...(button ? { button } : {}), footer });

const CONFIRM_LEAD = "{{first}} reviews every request personally. Open the link below and tap Send to pass it to {{first}}.";
const CONFIRM_TAIL = "If you didn't ask for this, ignore this email and nothing is sent. The link works for 72 hours.";
const REVIEW = { label: "Review and send", urlVar: "link" };
const RELEASED = "Your hold of {{amount}} was released. You were not charged. Your bank may take a few days to remove the pending amount.";

export const PARTNER_TEMPLATES = {
  /** Step 4: the email confirm. The request reaches her only after this link is opened and "Send" is tapped. */
  confirm: t("partner.confirm", "Confirm your request to {{first}}", [CONFIRM_LEAD, CONFIRM_TAIL], REVIEW),
  /** The same, after a Serious offer hold was placed. Vars: hold. */
  confirmWithHold: t("partner.confirm_hold", "Confirm your request to {{first}}", [
    CONFIRM_LEAD,
    "Your temporary hold of {{hold}} stays a hold. It counts toward your first payment only if you and {{first}} agree a deal; otherwise it is released.",
    CONFIRM_TAIL,
  ], REVIEW),
  /** Confirmed: it is with her. Carries the private status link. */
  received: t("partner.received", "Your request is with {{first}}", [
    "{{first}} reviews every request personally. You can see where it stands and write to {{first}} on your private request page.",
    "Keep this email: the link is how you get back to your request. If someone else opens it, they will need a code sent to this address to read or write messages.",
  ], OPEN, `${REF} · ${RELAY}`),
  /** A new message from her. Never the message itself. */
  newMessage: t("partner.new_message", "You have a new message from {{first}}", [
    "Open your request page to read it and reply. You can also reply to this email; your reply goes through Nomila to {{first}}.",
  ], { label: "Read the message", urlVar: "link" }, `${REF} · ${RELAY}`),
  /** A status change with nothing more to say (she agreed, no hold). */
  statusUpdate: t("partner.status_update", "An update on your request to {{first}}", ["Open your request page to see it."], OPEN),
  /** Her Decline tap. The only way a visitor hears a no. */
  declined: t("partner.declined", "An update on your request to {{first}}", [
    "{{first}} has passed on this one.", "Thank you for thinking of {{first}}.",
  ], OPEN),
  /** Her Decline tap, with a Serious offer hold. Vars: amount. */
  declinedReleased: t("partner.declined_released", "An update on your request to {{first}}", [
    "{{first}} has passed on this one.", "Thank you for thinking of {{first}}.",
    "Declined: your hold of {{amount}} was released. You were not charged.",
  ], OPEN),
  /** Her Agree tap with a Serious offer hold: captured, counts toward the first payment. Vars: amount. */
  agreed: t("partner.agreed", "{{first}} agreed: your hold counts toward your first payment", [
    "Accepted: your card was charged {{amount}}, the hold you placed. It counts toward your first payment for this deal, so your first payment request will be {{amount}} less.",
  ], OPEN),
  /** Released by its window. Vars: amount (+ link once confirmed). */
  holdReleasedUnconfirmed: t("partner.hold_released_unconfirmed", "Your hold of {{amount}} was released", [
    "The request was not confirmed within 72 hours, so it was not sent.", RELEASED,
  ]),
  holdReleasedNoReply: t("partner.hold_released_no_reply", "Your hold of {{amount}} was released", [
    "{{first}} didn't reply within 6 days.", RELEASED,
  ], OPEN),
  holdReleasedNoDeal: t("partner.hold_released_no_deal", "Your hold of {{amount}} was released", [
    "No deal was agreed within the hold's window.", RELEASED,
  ], OPEN),
  /** "Your requests" and the forwarded-link re-check. */
  visitorCode: t("partner.visitor_code", "Your Nomila code: {{code}}", [
    "Your code is {{code}}. Enter it to see your requests. It works for 15 minutes.",
    "If you didn't ask for it, you can ignore this email.",
  ], undefined, "Nomila"),
} satisfies Record<string, EmailTemplate>;

export const usd = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
