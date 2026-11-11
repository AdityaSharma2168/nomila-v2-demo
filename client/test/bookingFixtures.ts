// Typed fixtures for the Bookings screen tests: built from the shared wire types (shared/bookingsApi.ts), so a screen
// test renders exactly the shape the server sends. Test data only — imported by *.test.tsx files, never by the app.
import type {
  BookingDetailView, BookingListItemView, BookingMessageView, BookingPayoutsView, BookingsSummaryView, GroupSessionListItemView,
  GroupSessionView, OfferView, SlotView,
} from "../lib/bookingsTypes";

/** An open-group time as one item (GET /bookings/groups). */
export function groupItemFixture(over: Partial<GroupSessionListItemView> = {}): GroupSessionListItemView {
  return {
    slotId: "slot1", offerId: "o2", title: "Group clinic · 60 min", format: "clinic", locationMode: "virtual", startsAt: inHours(72), endsAt: inHours(73),
    capacity: 10, spotsTaken: 4, spotsLeft: 6, phase: "booked", receiveCents: 10_000, unitPriceCents: 2_500,
    firstNames: ["Jordan", "Sam", "Alex", "Riley"], ...over,
  };
}

/** One open-group time with its people (GET /bookings/groups/:slotId). */
export function groupFixture(over: Partial<GroupSessionView> = {}): GroupSessionView {
  return {
    ...groupItemFixture(),
    attendees: [
      { bookingId: "gb1", firstName: "Jordan", status: "confirmed", partySize: 1, identity: "b_jordan", joined: true, inRoom: true, blocked: false },
      { bookingId: "gb2", firstName: "Sam", status: "confirmed", partySize: 1, identity: "b_sam", joined: false, inRoom: false, blocked: false },
    ],
    video: { mode: "livekit", joinOpensAt: inHours(71.8), joinClosesAt: inHours(73.5), joinState: "not_yet_open", fallbackLink: null },
    actions: { join: false, cancel: true, sessionDone: false, removeParticipant: false },
    freeCancelHours: 24, firstCancelFree: true, supportEmail: "support@nomila.co", serverNow: new Date().toISOString(), ...over,
  };
}

const H = 3_600_000;
export const inHours = (h: number) => new Date(Date.now() + h * H).toISOString();

export function summaryFixture(over: Partial<BookingsSummaryView> = {}): BookingsSummaryView {
  return {
    payouts: { hasAccount: true, ready: true, requirementsDue: [] },
    offers: { published: 1, draft: 0, paused: 0 }, pausedByNomila: false, requests: 1, nextRespondBy: inHours(18), upcoming: 1,
    showSection: true,
    limits: { minPriceCents: 2_500, maxPriceCents: 500_000, durationOptions: [15, 30, 45, 60], freeCancelHoursOptions: [24, 48, 168], freeCancelHoursDefault: 24, maxProposedTimes: 3 },
    respondHours: 72, supportEmail: "support@nomila.co", ...over,
  };
}

export function listItemFixture(over: Partial<BookingListItemView> = {}): BookingListItemView {
  return {
    id: "b1", status: "requested", phase: "request", buyerLabel: "Jordan P.", title: "1:1 video call", format: "video_call",
    locationMode: "virtual", startsAt: inHours(48), endsAt: inHours(48.5), proposedTimes: [], respondBy: inHours(18),
    receiveCents: 15_000, checks: { email: true, phone: true, idChecked: false, adult: true, parent: false },
    createdAt: inHours(-2), unreadMessages: 0, audience: "one", partySize: 1, unitPriceCents: 15_000, slotId: null, ...over,
  };
}

export function detailFixture(over: Partial<BookingDetailView> = {}): BookingDetailView {
  return {
    ...listItemFixture(),
    buyerMessage: "How did you handle recruiting?", minorFirstName: null, proposedNote: null, athleteProposedTimes: [],
    meetingMode: null, meetingLink: null, venue: null, freeCancelHours: 24, buyerTotalCents: 17_796, payBy: null,
    athleteDoneAt: null, noShowBy: null, canceledBy: null, firstCancelFree: true,
    actions: { accept: true, decline: true, propose: true, cancel: false, noShow: false, noShowAt: null, sessionDone: false, message: true, block: true },
    payout: { receiveCents: 15_000, state: "none", releaseDueAt: null, paidAt: null, cardFeeCents: 0 },
    timeline: [{ at: inHours(-2), kind: "requested", by: "buyer" }], guests: [], fanBlocked: false, supportEmail: "support@nomila.co", ...over,
  };
}

export function offerFixture(over: Partial<OfferView> = {}): OfferView {
  return {
    id: "o1", publicId: "pub1", format: "video_call", title: "1:1 video call", description: "30 minutes on anything.", priceCents: 15_000,
    durationMinutes: 30, locationMode: "virtual", videoMode: "livekit", venue: null, venueConfirmed: false, requireIdVerification: false,
    allowMinorAttendees: false, returningBuyersOnly: false, schedulingMode: "slots", availableFrom: null, availableUntil: null,
    freeCancelHours: 24, status: "published", pausedReason: null, adultAttested: true, audience: "one", maxPeople: 1, approveEachSpot: false, availability: null,
    quote: { priceCents: 15_000, serviceFeeCents: 2_796, buyerTotalCents: 17_796, athleteReceivesCents: 15_000, currency: "usd" },
    openSlots: 6, liveBookings: 0, updatedAt: inHours(-1), ...over,
  };
}

export const slotFixture = (over: Partial<SlotView> = {}): SlotView => ({ id: "s1", startsAt: inHours(30), endsAt: inHours(30.5), taken: false, capacity: 1, spotsTaken: 0, spotsLeft: 1, ...over });

export const messageFixture = (over: Partial<BookingMessageView> = {}): BookingMessageView =>
  ({ id: "m1", from: "them", body: "Thanks so much!", held: false, heldReason: null, at: inHours(-1), ...over });

export function payoutsFixture(over: Partial<BookingPayoutsView> = {}): BookingPayoutsView {
  return {
    payouts: { hasAccount: true, ready: true, requirementsDue: [] }, comingCents: 15_000, paidCents: 14_469,
    items: [
      { bookingId: "b9", title: "Video call", buyerLabel: "Jordan P.", state: "held", amountCents: 15_000, cardFeeCents: 0, dueAt: inHours(40) },
      { bookingId: "b8", title: "Video call", buyerLabel: "Casey L.", state: "paid", amountCents: 14_469, cardFeeCents: 531, dueAt: inHours(-30) },
    ],
    cardFees: [{ bookingId: "b7", title: "Video call", amountCents: 531, status: "recovered", at: inHours(-100) }],
    ...over,
  };
}
