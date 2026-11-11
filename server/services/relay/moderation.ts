/**
 * relay/moderation.ts — the check every relayed message passes before it is delivered (design §7a).
 *
 * Shared by every Nomila relay home (partner-request threads on the opportunity today; booking_messages when Book
 * lands). Pure and deterministic: no model, no network, so a message is judged the same way every time and the
 * reason is auditable.
 *
 *   clean    delivered.
 *   held     NOT delivered; the sender sees "This message is being checked". Contact details (email addresses, phone
 *            numbers, social handles or "message me on …"), asks to pay or be paid off-platform, and links.
 *   blocked  NOT delivered, ever: the classic scam shapes (gift cards, crypto / wire-service payments, asks for
 *            passwords, bank logins or ID numbers).
 *
 * Why these: the relay exists so neither side needs the other's contact details and money only moves through Nomila
 * (tap-to-send, holds, refunds). A link is held because it is the usual way round both.
 */

export type ModerationState = "clean" | "held" | "blocked";
export type ModerationReason =
  | "contact_email" | "contact_phone" | "contact_handle" | "contact_offplatform"
  | "off_platform_payment" | "link" | "scam";

export interface ModerationVerdict {
  state: ModerationState;
  reasons: ModerationReason[];
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;
// "name at domain dot com", "name [at] domain [dot] com"
const EMAIL_SPELLED = /\b[a-z0-9._%+-]+\s*[([]?\s*(?:at|@)\s*[)\]]?\s*[a-z0-9-]+\s*[([]?\s*dot\s*[)\]]?\s*[a-z]{2,6}\b/i;
const HANDLE = /(?:^|[\s(:,;])@[a-z0-9_](?:[a-z0-9_.]{1,29})/i;
const OFFPLATFORM_CONTACT =
  /\b(?:(?:dm|message|text|call|ping|reach|contact|add|find|hit)\s+(?:me|us)\s+(?:on|at|via|over)\s+(?:insta(?:gram)?|ig|whats\s?app|telegram|snap(?:chat)?|signal|we\s?chat|tiktok|twitter|x|facebook|messenger|discord|linkedin|my\s+(?:phone|cell|number|email))|(?:my|our)\s+(?:whats\s?app|telegram|signal|cell|phone\s+number|personal\s+email)|whats\s?app\s+me|telegram\s+me)\b/i;
const LINK = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|co|io|me|ly|app|gg|tv|us|link|info|biz|xyz|site|shop|store)\b(?:\/\S*)?/i;
const OFF_PLATFORM_PAYMENT =
  /\b(?:venmo|cash\s?app|zelle|paypal|apple\s?pay|google\s?pay|bank\s+transfer|wire\s+(?:transfer|you|me|it|the)|direct\s+deposit|pay\s+(?:you|me|us)\s+(?:directly|outside|off[- ]?platform|privately|in\s+cash)|(?:outside|off)\s+(?:of\s+)?(?:nomila|the\s+platform|platform)|off[- ]platform|skip\s+(?:nomila|the\s+fees?|the\s+platform))\b/i;
const SCAM =
  /\b(?:gift\s?cards?|itunes\s+cards?|steam\s+cards?|bitcoin|btc|ethereum|usdt|crypto(?:currency)?\s+(?:wallet|payment|transfer)|western\s+union|moneygram|(?:send|give|share|tell)\s+(?:me|us)\s+(?:your\s+)?(?:password|passcode|login|bank\s+(?:login|details|account\s+number)|routing\s+number|ssn|social\s+security(?:\s+number)?|verification\s+code))\b/i;

/** A phone number: 10–15 digits, possibly with +, spaces, dots, dashes or brackets between them. */
function hasPhone(text: string): boolean {
  for (const m of text.matchAll(/\+?\(?\d[\d\s().-]{8,22}\d/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15) return true;
  }
  return false;
}

export function moderateMessage(body: string): ModerationVerdict {
  const text = body.normalize("NFKC");
  if (SCAM.test(text)) return { state: "blocked", reasons: ["scam"] };
  const reasons: ModerationReason[] = [];
  const emailHit = EMAIL.test(text) || EMAIL_SPELLED.test(text);
  if (emailHit) reasons.push("contact_email");
  if (hasPhone(text)) reasons.push("contact_phone");
  if (HANDLE.test(text)) reasons.push("contact_handle");
  if (OFFPLATFORM_CONTACT.test(text)) reasons.push("contact_offplatform");
  if (OFF_PLATFORM_PAYMENT.test(text)) reasons.push("off_platform_payment");
  // An email address also matches the bare-domain link shape; it is already held as contact.
  if (LINK.test(emailHit ? text.replace(new RegExp(EMAIL.source, "gi"), " ") : text)) reasons.push("link");
  return reasons.length ? { state: "held", reasons } : { state: "clean", reasons: [] };
}

/** The reasons as stored in a moderation_reason column. */
export const reasonText = (v: ModerationVerdict): string | null => (v.reasons.length ? v.reasons.join(",") : null);
