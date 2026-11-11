/**
 * agent/bookings/memorySource.ts — BookingsSource in memory, for tests and the chat eval. Made-up bookings only.
 */
import type { BookingDetailView, BookingPhase } from "../../../shared/bookingsApi";
import { memoryDealId } from "../deals/memorySource";
import type { BookingsSource, BookingView } from "./source";

export interface MemoryBooking {
  key: string;
  buyer: string;
  title: string;
  format: "video_call" | "appearance" | "clinic" | "custom";
  phase: BookingPhase;
  startsAt?: string | null;
  respondBy?: string | null;
  receiveCents: number;
  /** What the buyer wrote (may hold an injection attempt). */
  message?: string | null;
}

const VIEW_OF: Record<BookingView, BookingPhase[]> = {
  requests: ["request", "waiting_buyer", "waiting_payment"],
  upcoming: ["booked", "happening", "finished", "on_hold"],
  past: ["paid", "declined", "withdrawn", "expired", "canceled", "refunded"],
};

export const memoryBookingId = (key: string) => memoryDealId(`booking:${key}`);

export function createMemoryBookingsSource(seed: MemoryBooking[], opts: { enabled?: boolean } = {}): BookingsSource & { bookings: MemoryBooking[] } {
  const view = (b: MemoryBooking): BookingDetailView => ({
    id: memoryBookingId(b.key), status: b.phase === "request" ? "requested" : "confirmed", phase: b.phase, buyerLabel: b.buyer, title: b.title,
    format: b.format, locationMode: b.format === "video_call" ? "virtual" : "in_person", startsAt: b.startsAt ?? null, endsAt: null,
    proposedTimes: [], respondBy: b.respondBy ?? null, receiveCents: b.receiveCents,
    checks: { email: true, phone: true, idChecked: false, adult: true, parent: false }, createdAt: "2026-10-09T12:00:00.000Z", unreadMessages: 0,
    buyerMessage: b.message ?? null, minorFirstName: null, proposedNote: null, athleteProposedTimes: [], meetingMode: null, meetingLink: null,
    venue: null, freeCancelHours: 24, buyerTotalCents: b.receiveCents, payBy: null, athleteDoneAt: null, noShowBy: null, canceledBy: null,
    firstCancelFree: true,
    actions: { accept: b.phase === "request", decline: b.phase === "request", propose: b.phase === "request", cancel: b.phase === "booked" } as BookingDetailView["actions"],
    payout: null as unknown as BookingDetailView["payout"], timeline: [], supportEmail: "support@example.com",
    audience: "one", partySize: 1, unitPriceCents: b.receiveCents, slotId: null, guests: [], fanBlocked: false,
  } as BookingDetailView);
  return {
    bookings: seed,
    enabled: () => opts.enabled ?? true,
    async list(_a, v) { return seed.filter((b) => VIEW_OF[v].includes(b.phase)).map(view); },
    async get(_a, id) { const b = seed.find((x) => memoryBookingId(x.key) === id); return b ? view(b) : null; },
  };
}
