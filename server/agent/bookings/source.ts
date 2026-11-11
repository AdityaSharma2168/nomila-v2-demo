/**
 * agent/bookings/source.ts — what Mila's booking tools READ, as one port. Reads only: nothing here (or anywhere under
 * server/agent) can accept, decline, propose, cancel, message or move money — those are her taps on the existing
 * /me/bookings/:id/* routes (services/bookings/bookingsTapOnly.test.ts holds that line).
 *
 * The database adapter is the ONE file under server/agent allowed to import the bookings read functions
 * (listBookings, bookingDetail); the tap-only test allow-lists it for reads and still refuses any action call in it.
 */
import type { BookingDetailView, BookingListItemView } from "../../../shared/bookingsApi";

export const BOOKING_VIEWS = ["requests", "upcoming", "past"] as const;
export type BookingView = (typeof BOOKING_VIEWS)[number];

export interface BookingsSource {
  /** Bookings are set up and on for her (BOOKINGS_ENABLED + the pilot list). */
  enabled(athleteId: string): boolean;
  list(athleteId: string, view: BookingView): Promise<BookingListItemView[]>;
  /** Null when it isn't hers (or she can't see it yet). */
  get(athleteId: string, id: string): Promise<BookingDetailView | null>;
}
