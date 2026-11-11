/**
 * agent/bookings/prompts.ts — each bookings tool's description, as the model reads it. Registered verbatim in the
 * Prompt Register ("Mila bookings toolset"). The area's rules are the bookings playbook (mila/skills/bookings/SKILL.md),
 * which replaced the toolset preamble on 3 Nov 2026.
 */

export const BOOKINGS_TOOLSET_ID = "bookings";

export const BOOKINGS_LIST_DESCRIPTION =
  "Their bookings: view requests (waiting on their answer or on the buyer), upcoming (accepted or paid, not yet happened) or past (done, declined, canceled, refunded). Each has who, what, when, the money and where it stands. " +
  "Use for \"any bookings?\", \"what's coming up?\", \"who booked me last month?\". Don't use for deals with brands (deals_find).";

export const BOOKINGS_GET_DESCRIPTION =
  "One booking in full: who, what, when, the money (what they receive, held until the session), its status, whether the buyer's checks passed, what the buyer wrote, and which answers are open to them. Shows the booking card.";

export const BOOKINGS_WAITING_DESCRIPTION =
  "Requests waiting for their answer, soonest deadline first, each shown as a booking card with Accept and Decline (their tap). " +
  "Use for \"anything I need to answer?\" about bookings.";

export const BOOKINGS_RESPOND_DESCRIPTION =
  "Put one request in front of them to answer, with your suggestion (accept or decline) leading the card. NOTHING happens from this call: the card's Accept and Decline are their taps on the existing booking confirm, and only those answer the buyer or capture the payment. " +
  "Use when they ask you to accept or decline a request, or ask what you'd do. Don't use for anything but a request waiting for their answer.";
