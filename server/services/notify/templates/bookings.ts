/**
 * notify/templates/bookings.ts — every Bookings v2 email, word for word (public card v3.2 "Hold copy", Bookings v2
 * "Emails and notifications", the booking screens' copy rules).
 *
 *   • A hold is an authorization: "temporary hold", "charged only if … accepts", "released". Never "not charged" alone,
 *     "we won't process", "free", or "refund" for a released hold.
 *   • One "Nomila service fee" line; never "card fee", "processing" or "surcharge" to buyers.
 *   • "Email ✓ / Phone ✓ / ID checked by Stripe"; never "verified", "safe" or "trusted".
 *   • Her name is {{first}} from her profile, never hard-coded. Buyers are first name + initial to her.
 *   • A notice of a new message never carries the message text. Contact details never appear.
 *   • Every email ends with the support line (BOOKINGS.supportEmail, from config). Email only for now (no SMS yet).
 */
import type { EmailTemplate } from "./render";

const SUPPORT = "Questions or safety concerns? {{support}}";
const t = (name: string, subject: string, paragraphs: string[], button?: EmailTemplate["button"]): EmailTemplate =>
  ({ name, subject, paragraphs, ...(button ? { button } : {}), footer: SUPPORT });
const OPEN = { label: "Open your booking", urlVar: "link" };

// ── To the buyer ──────────────────────────────────────────────────────────────────────────────────────────────────
export const BOOKING_TEMPLATES = {
  emailCode: t("booking.email_code", "Your Nomila code: {{code}}", [
    "Your code is {{code}}. It works for {{minutes}} minutes.",
    "If you didn't ask for this, you can ignore this email.",
  ]),
  requestSent: t("booking.request_sent", "Request sent to {{first}}", [
    "Request sent. A temporary hold of {{total}} is on your card. You'll only be charged if {{first}} accepts.",
    "{{title}}{{group}} · {{when}}. {{first}} has {{respondHours}} hours to respond (by {{respondBy}}). If not, the hold is released. Your bank may show it as pending.",
  ], OPEN),
  acceptedCharged: t("booking.accepted", "{{first}} accepted your request", [
    "{{first}} accepted. Your card was charged {{total}}.",
    "{{title}}{{group}} · {{when}}. {{where}}",
    "{{guestLine}}",
    "Cancel at least {{freeHours}} hours before for {{first}}'s price back ({{price}}); the Nomila service fee is non-refundable. After that, no refund.",
  ], OPEN),
  acceptedPayLink: t("booking.accepted_pay", "{{first}} accepted: pay to keep your time", [
    "{{first}} accepted, but your card's temporary hold had already ended, so nothing was charged.",
    "Pay {{total}} by {{payBy}} to keep {{when}}. After that the time is released.",
  ], { label: "Pay now", urlVar: "payLink" }),
  declined: t("booking.declined", "{{first}} can't do this one", [
    "{{first}} declined. The hold was released.",
    "{{title}} · {{when}}.",
  ]),
  expired: t("booking.expired", "No answer in time: the hold was released", [
    "No answer in {{respondHours}} hours. The hold was released.",
    "{{title}} with {{first}} · {{when}}.",
  ]),
  expiredUnpaid: t("booking.expired_unpaid", "Your time with {{first}} was released", [
    "The time to pay ran out, so the time was released. Nothing was charged.",
  ]),
  withdrawn: t("booking.withdrawn", "You withdrew your request", [
    "You withdrew your request to {{first}}. The hold was released.",
  ]),
  canceledByAthlete: t("booking.canceled_by_athlete", "{{first}} cancelled your booking", [
    "{{first}} can't make it and is sorry. You'll get all {{refund}} back, in 5–10 days.",
    "{{title}} · {{when}}.",
    "From {{first}}: {{reason}}",
  ]),
  canceledByBuyer: t("booking.canceled_by_buyer", "Your booking is cancelled", [
    "You cancelled {{title}} with {{first}} ({{when}}).",
    "{{refundLine}}",
  ]),
  newMessage: t("booking.new_message", "You have a new message from {{first}}", [
    "You have a new message from {{first}} about {{title}}.",
  ], { label: "Read it", urlVar: "link" }),
  sessionTomorrow: t("booking.tomorrow", "Tomorrow: {{title}} with {{first}}", [
    "{{title}} with {{first}} is {{when}}.",
    "Video calls open on your booking page 10 minutes before. Nomila doesn't record calls.",
  ], OPEN),
  timesProposed: t("booking.times_proposed", "{{first}} suggested other times", [
    "{{first}} can't do the time you asked for and suggested other times for {{title}}.",
    "Pick one and {{first}} will confirm. Your temporary hold of {{total}} stays in place; you're only charged if {{first}} accepts.",
  ], { label: "Pick a time", urlVar: "link" }),
  accessCode: t("booking.access_code", "Your Nomila code: {{code}}", [
    "Use {{code}} to open your booking. It works for {{minutes}} minutes.",
  ]),
  // 0153 group sessions. An open group confirms each spot by itself (her publishing it was her yes).
  groupJoined: t("booking.group_joined", "You're in: {{title}} with {{first}}", [
    "You're in: {{people}} of {{spots}} spots. Your card was charged {{total}}.",
    "{{title}} · Group session · {{when}}. {{where}}",
    "Other fans join the same call. They see you as \"Fan\", never your name or email.",
    "Cancel at least {{freeHours}} hours before for {{first}}'s price back ({{price}}); the Nomila service fee is non-refundable. After that, no refund.",
  ], OPEN),
  // To a friend a private-group booker added: their OWN link (never forward it). No money, no account.
  guestInvite: t("booking.guest_invite", "{{inviter}} invited you to {{title}} with {{first}}", [
    "{{inviter}} booked {{title}} with {{first}} for {{people}} people and added you.",
    "{{when}}. Join from your browser: no app or account needed. The call opens 10 minutes before. Nomila doesn't record calls.",
    "This link is just for you, so please don't forward it.",
  ], { label: "Join call", urlVar: "link" }),

  // ── To her (the athlete). No buyer contact details, ever; first name + initial only. ──────────────────────────
  athleteNewRequest: t("booking.athlete_new_request", "New booking request: {{title}}", [
    "{{buyer}} asked for {{title}}{{group}}. Email ✓{{phoneLine}}{{idLine}}.",
    "Open Nomila to accept or decline. You have {{respondHours}} hours. Nothing is booked until you tap Accept.",
  ]),
  athleteExpiring: t("booking.athlete_expiring", "A request expires soon: {{title}}", [
    "{{buyer}}'s request for {{title}} expires at {{respondBy}}. If you don't answer, the hold is released and nothing is booked.",
    "Open Nomila to accept or decline.",
  ]),
  athleteSessionTomorrow: t("booking.athlete_tomorrow", "Tomorrow: {{title}} with {{buyer}}", [
    "{{title}} with {{buyer}} is {{when}}.",
    "Video calls open in the app 10 minutes before. Nomila doesn't record calls.",
  ]),
  athleteCanceledByBuyer: t("booking.athlete_canceled_by_buyer", "{{buyer}} cancelled {{title}}", [
    "{{buyer}} cancelled {{title}}. {{payLine}}",
  ]),
  athleteWithdrawn: t("booking.athlete_withdrawn", "{{buyer}} withdrew a request", [
    "{{buyer}} withdrew their request for {{title}}. Nothing to do.",
  ]),
  athleteNewMessage: t("booking.athlete_new_message", "New message from {{buyer}}", [
    "{{buyer}} sent you a message about {{title}}. Open Nomila to read it.",
  ]),
  athletePickedTime: t("booking.athlete_picked_time", "{{buyer}} picked a time", [
    "{{buyer}} picked one of the times you suggested for {{title}}. Open Nomila to accept it.",
  ]),
  athleteGroupSignup: t("booking.athlete_group_signup", "{{buyer}} joined {{title}}", [
    "{{buyer}} booked a spot in {{title}} ({{when}}). {{taken}} of {{spots}} spots are taken.",
    "Nothing to do: your open session confirms each spot by itself. You receive {{price}} for this spot.",
  ]),
  athleteOffersPaused: t("booking.athlete_offers_paused", "Your offers are paused", [
    "Two sessions were missed, so new bookings are off while our support team takes a look. Your booked sessions still go ahead.",
  ]),

  // ── To support (the human review queue). A reference, a category and the text; no contact details. ──────────
  supportAlert: t("booking.support_alert", "[Bookings] {{what}} · {{ref}}", [
    "Booking {{ref}}: {{what}}.",
    "{{detail}}",
  ]),
} as const;

export type BookingTemplateName = keyof typeof BOOKING_TEMPLATES;
