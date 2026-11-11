/**
 * bookings/push.ts — the athlete's phone notifications for Bookings v2 (Bookings PR3, "Bookings, end to end").
 *
 * The launch set, athlete side only (buyers are account-less and get email): a new request, a request about to expire,
 * the buyer cancelled, a new message, the call opens, a session tomorrow, you've been paid. One push per event (the
 * dedupe key), messages coalesced to one per 10 minutes per booking. Lock-screen words never name the buyer; the named
 * variant (first name + initial) shows only when she turned names on. Quiet hours and the daily cap are the push
 * service's own (her phone's zone, 22:00–08:00 by default): a booking push in quiet hours still arrives, silently.
 *
 * Fire-and-forget like every push: a notification that can't go out never undoes the action (pushSoon never throws).
 */
import { pushSoon, type PushEvent } from "../push/push";
import { routeToMila } from "../../agent/proactive/events";
import { buyerLabel, usd } from "./common";

export type BookingPushWhat = "new_request" | "expiring" | "buyer_canceled" | "new_message" | "join_now" | "tomorrow" | "paid" | "group_signup";

interface B { id: string; athlete_id: string; title: string; buyer_name: string }

/** The event for one booking moment (pure, so it's unit-tested). */
export function bookingPushEvent(b: B, what: BookingPushWhat, extra: { amountCents?: number; messageId?: string } = {}): PushEvent {
  const who = buyerLabel(b.buyer_name);
  const target = { screen: "booking" as const, id: b.id };
  const base = { kind: "booking" as const, target };
  switch (what) {
    case "new_request":
      return { ...base, dedupeKey: `booking:new_request:${b.id}`, title: "New booking request", body: `Someone asked for ${b.title}. Accept or decline in Nomila.`,
        named: { title: `${who} wants to book you`, body: `${b.title}. Accept or decline in Nomila.` } };
    case "expiring":
      return { ...base, dedupeKey: `booking:expiring:${b.id}`, title: "A booking request expires soon", body: `About 12 hours left to answer a request for ${b.title}.`,
        named: { title: `${who}'s request expires soon`, body: `About 12 hours left to answer.` } };
    case "buyer_canceled":
      return { ...base, dedupeKey: `booking:buyer_canceled:${b.id}`, title: "A booking was cancelled", body: `${b.title} was cancelled. Open the booking for the details.`,
        named: { title: `${who} cancelled`, body: `${b.title}. Open the booking for the details.` } };
    case "new_message":
      return { ...base, dedupeKey: `booking:new_message:${b.id}:${extra.messageId ?? "x"}`, title: "New message about a booking", body: `Open the booking in Nomila to read it.`,
        named: { title: `New message from ${who}` }, coalesce: { prefix: `booking:new_message:${b.id}:`, withinMs: 10 * 60_000 } };
    case "join_now":
      return { ...base, dedupeKey: `booking:join_now:${b.id}`, title: "Your call opens now", body: `${b.title}. Tap to join.`,
        named: { title: `Your call with ${who} opens now`, body: `${b.title}. Tap to join.` } };
    case "tomorrow":
      return { ...base, dedupeKey: `booking:tomorrow:${b.id}`, title: "You have a session tomorrow", body: `${b.title}. Open the booking for the time and details.`,
        named: { title: `Session with ${who} tomorrow`, body: `${b.title}. Open the booking for the details.` } };
    case "group_signup":   // 0153: an open group confirms each spot by itself; she hears about it, nothing to do
      return { ...base, dedupeKey: `booking:group_signup:${b.id}`, title: "Someone joined your group session", body: `A spot in ${b.title} was booked.`,
        named: { title: `${who} joined your group session`, body: `${b.title}. Nothing to do.` } };
    case "paid":
      return { ...base, dedupeKey: `booking:paid:${b.id}`, title: "You've been paid",
        body: extra.amountCents ? `${usd(extra.amountCents)} for ${b.title} is on its way to your bank.` : `Your pay for ${b.title} is on its way to your bank.` };
  }
}

export function pushBooking(b: B, what: BookingPushWhat, extra: { amountCents?: number; messageId?: string } = {}): void {
  try {
    const event = bookingPushEvent(b, what, extra);
    // MILA_PROACTIVE: a new request goes to Mila, who prepares the answer as a card; this push is the fallback
    // (agent/proactive). The other booking moments keep their fixed-copy push.
    if (what === "new_request" && routeToMila({ athleteId: b.athlete_id, kind: "booking_request", dedupeKey: `booking_request:${b.id}`, payload: { bookingId: b.id, fallbackPush: event } })) return;
    pushSoon(b.athlete_id, event);
  } catch { /* never undoes the action */ }
}
