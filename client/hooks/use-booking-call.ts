// use-booking-call — React state over the booked-call controller (components/bookings/bookingCall). One controller per
// screen; leaving the screen leaves the call. The call is a booking's (1:1 or a private group: its own room) or an open
// group's time (0153: one room for every spot, its own token route).
import { useEffect, useMemo, useRef, useState } from "react";
import { createBookingCall, INITIAL_CALL, type BookingCall, type CallSnapshot } from "../components/bookings/bookingCall";
import { fetchGroupJoinToken, fetchJoinToken, type CallTarget } from "./use-booking-session";

export function useBookingCall(target: string | CallTarget): { call: CallSnapshot; actions: BookingCall & { join: () => Promise<void> } } {
  const t: CallTarget = typeof target === "string" ? { bookingId: target } : target;
  const key = "slotId" in t ? `slot:${t.slotId}` : `booking:${t.bookingId}`;
  const [call, setCall] = useState<CallSnapshot>(INITIAL_CALL);
  const ctl = useRef<BookingCall | null>(null);
  if (!ctl.current) ctl.current = createBookingCall(setCall);
  useEffect(() => () => { void ctl.current?.leave(); }, []);
  const actions = useMemo(() => {
    const c = ctl.current!;
    return { ...c, join: () => c.start(() => ("slotId" in t ? fetchGroupJoinToken(t.slotId) : fetchJoinToken(t.bookingId))) };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { call, actions };
}
