/**
 * agent/bookings/dbSource.ts — BookingsSource on the bookings services. READS ONLY: listBookings and bookingDetail are
 * the same reads her Bookings screens use (scoped to her, no buyer contact details). This file is allow-listed in
 * services/bookings/bookingsTapOnly.test.ts for exactly these two reads; any booking ACTION here fails that test.
 */
import { bookingDetail, listBookings } from "../../services/bookings/athlete";
import { bookingsEnabledFor } from "../../services/bookings/config";
import type { BookingsSource } from "./source";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dbBookingsSource: BookingsSource = {
  enabled: (athleteId) => bookingsEnabledFor(athleteId),
  list: (athleteId, view) => listBookings(athleteId, view),
  async get(athleteId, id) {
    if (!UUID.test(id)) return null;
    try {
      return await bookingDetail(athleteId, id);
    } catch (err: any) {
      if (err?.code === "NOT_FOUND") return null;
      throw err;
    }
  },
};
