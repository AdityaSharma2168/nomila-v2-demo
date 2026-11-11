// Bookings v2 — how anything reaches her booking screens (see bookingsRoutes.tsx for where they are mounted).
//
//   openBookings(nav, tab?)            Bookings (tabs Requests · Booked · Offers)
//   openBookingDetail(nav, id)         one request / booking, across its life
//   openOfferEditor(nav, id | null)    a new offer, or one of hers
//   openOfferTimes(nav, id)            her times for a slots offer
//   openGroupSession(nav, slotId)      one open-group time with its people (0153)
//   openBlockedFans(nav)               her Blocked fans, with Unblock (0154)
//   fromMe(nav, …)                     the same, from the Me door (Me lives on another stack)
//   sessionDoors(nav)                  the session PR's screens (#868: BookingSession, BookingAfter) and Financials —
//                                      returned only when that route is registered, so a door is never a dead tap
import { leaveMeTo } from "./meNav";

export type BookingsTab = "requests" | "booked" | "offers";

export type BookingsStackParamList = {
  Bookings:      { tab?: BookingsTab; back?: string } | undefined;
  BookingDetail: { bookingId: string };
  BookingOffer:  { offerId: string | null };
  BookingTimes:  { offerId: string };
  BookingGroup:  { slotId: string };
  BookingBlocks: undefined;
};

type Nav = { navigate: (...args: any[]) => void; getParent?: () => any; getState?: () => any };

export const openBookings      = (nav: Nav, tab?: BookingsTab) => nav.navigate("Bookings", tab ? { tab } : undefined);
export const openBookingDetail = (nav: Nav, bookingId: string) => nav.navigate("BookingDetail", { bookingId });
export const openOfferEditor   = (nav: Nav, offerId: string | null) => nav.navigate("BookingOffer", { offerId });
export const openOfferTimes    = (nav: Nav, offerId: string) => nav.navigate("BookingTimes", { offerId });
export const openGroupSession  = (nav: Nav, slotId: string) => nav.navigate("BookingGroup", { slotId });
export const openBlockedFans   = (nav: Nav) => nav.navigate("BookingBlocks");

/** From Me (another stack, in either shell): to a booking screen on the Opportunities tab. */
export function fromMe(nav: Nav, screen: keyof BookingsStackParamList, params?: object): void {
  leaveMeTo(nav, "Opportunities", screen, params);
}

/** True when some navigator up the chain registers `name`. */
export function routeRegistered(nav: Nav, name: string): boolean {
  let n: any = nav;
  for (let i = 0; n && i < 8; i++, n = n.getParent?.()) {
    const names: unknown = n.getState?.()?.routeNames;
    if (Array.isArray(names) && names.includes(name)) return true;
  }
  return false;
}

/**
 * The doors to screens other PRs own, only when they exist in this build: the call and the after-session taps (#868's
 * BookingSession / BookingAfter, root stack) and the Financials screen (the app-layout track). Once those land they are
 * plain navigates; before, the door is simply not drawn.
 */
export function sessionDoors(nav: Nav) {
  return {
    join:       routeRegistered(nav, "BookingSession") ? (bookingId: string) => nav.navigate("BookingSession", { bookingId }) : null,
    /** An open group's ONE call (0153): the same call screen, on the time's room. */
    groupJoin:  routeRegistered(nav, "BookingSession") ? (slotId: string) => nav.navigate("BookingSession", { slotId }) : null,
    after:      routeRegistered(nav, "BookingAfter") ? (bookingId: string) => nav.navigate("BookingAfter", { bookingId }) : null,
    financials: routeRegistered(nav, "Financials") ? () => nav.navigate("Financials") : null,
  };
}
