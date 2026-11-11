/**
 * livekitWebhook.ts — LiveKit's participant_joined / participant_left for a booking room, recorded as attendance.
 *
 * VERIFIED FIRST. LiveKit signs every webhook: the Authorization header is a JWT signed with our API secret whose
 * `sha256` claim is the base64 SHA-256 of the exact body. WebhookReceiver (livekit-server-sdk) checks both, so the
 * route hands it the RAW body string. Anything that fails verification is a 401 and writes nothing.
 *
 * EVIDENCE ONLY. The one write is a booking_events row (kind 'attendance', actor 'livekit'). Nothing here reads money,
 * changes a status or marks a no-show; the reviewer reads these rows, and so would a chargeback response.
 *
 * Mapping an event back to its booking(s): room names are keyed pseudonyms (./sessionRoom.ts roomFor), which cannot be
 * reversed, so the candidates are the few video bookings whose session is near the event time, and those whose derived
 * room matches win: ONE booking for a 1:1 or a private group, every booking of the time for an open group (one room per
 * slot, 0153). The participant identity must then be one the room knows:
 *   her identity            1:1 / private group: that booking's athlete identity → recorded on it.
 *                           open group: the slot's athlete identity → recorded on EVERY live booking of the time, so
 *                           each fan's booking carries the evidence that she was there.
 *   a booker / a fan        the buyer identity of exactly one matched booking → recorded on that booking only.
 *   a private-group friend  a live (not revoked) booking_guests row of the booking → role 'guest' + its guestId.
 * Anything else (a Mila voice room, an unknown or revoked identity) is acknowledged and ignored.
 */

import { WebhookReceiver } from "livekit-server-sdk";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../../../db";
import { bookingGuests, bookings } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import { JOINABLE_STATUSES, guestIdentityFor, identityFor, isBookingRoomName, roomFor, slotAthleteIdentityFor } from "./sessionRoom";
import { recordAttendance } from "./sessionStore";
import type { BookingForSession, SessionRole } from "./sessionPorts";

const logger = createLogger("bookings/livekitWebhook");
const MIN = 60_000;

export class WebhookAuthError extends Error { constructor() { super("unauthorized"); } }

export type WebhookOutcome =
  | { handled: true; bookingId: string; bookingIds: string[]; role: SessionRole; guestId?: string; kind: "joined" | "left"; recorded: boolean }
  | { handled: false; reason: string };

interface Candidate { id: string; audience: BookingForSession["audience"]; slotId: string | null; status: string }

/** Verify and process one webhook delivery. Throws WebhookAuthError on a bad signature or a missing secret. */
export async function handleLivekitWebhook(rawBody: string, authHeader: string | undefined, now: Date = new Date()): Promise<WebhookOutcome> {
  const key = process.env.LIVEKIT_API_KEY?.trim();
  const secret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!key || !secret || !authHeader) throw new WebhookAuthError();
  let event;
  try {
    event = await new WebhookReceiver(key, secret).receive(rawBody, authHeader);
  } catch {
    throw new WebhookAuthError();
  }

  const kind = event.event === "participant_joined" ? "joined" : event.event === "participant_left" ? "left" : null;
  if (!kind) return { handled: false, reason: `ignored_${event.event || "unknown"}` };
  const room = event.room?.name ?? "";
  const identity = event.participant?.identity ?? "";
  if (!isBookingRoomName(room)) return { handled: false, reason: "not_a_booking_room" };

  const at = event.createdAt ? new Date(Number(event.createdAt) * 1000) : now;
  const matched = await bookingsForRoom(room, at);
  if (!matched.length) {
    logger.warn({ room }, "LiveKit event for a booking room with no matching booking — ignored");
    return { handled: false, reason: "unknown_room" };
  }
  const who = await whoIs(identity, matched);
  if (!who) {
    logger.warn({ bookings: matched.length }, "LiveKit participant identity is not one this room knows — ignored");
    return { handled: false, reason: "unknown_identity" };
  }
  let recorded = false;
  for (const bookingId of who.bookingIds) {
    // One LiveKit event can land on several bookings (her join in an open group): the dedupe is per booking.
    const r = await recordAttendance({ bookingId, role: who.role, guestId: who.guestId, kind, at, dedupeKey: event.id || undefined });
    recorded ||= r.recorded;
  }
  return { handled: true, bookingId: who.bookingIds[0], bookingIds: who.bookingIds, role: who.role, ...(who.guestId ? { guestId: who.guestId } : {}), kind, recorded };
}

/** Who an identity is in this room, and which booking(s) the event belongs to. */
async function whoIs(identity: string, matched: Candidate[]): Promise<{ role: SessionRole; bookingIds: string[]; guestId?: string } | null> {
  const slotId = matched[0].audience === "open_group" ? matched[0].slotId : null;
  if (identity.startsWith("a_")) {
    if (slotId) {
      if (identity !== slotAthleteIdentityFor(slotId)) return null;
      const live = matched.filter((m) => JOINABLE_STATUSES.has(m.status));
      return live.length ? { role: "athlete", bookingIds: live.map((m) => m.id) } : null;
    }
    const m = matched.find((c) => identity === identityFor(c.id, "athlete"));
    return m ? { role: "athlete", bookingIds: [m.id] } : null;
  }
  if (identity.startsWith("b_")) {
    const m = matched.find((c) => identity === identityFor(c.id, "buyer"));
    return m ? { role: "buyer", bookingIds: [m.id] } : null;
  }
  if (identity.startsWith("g_") && !slotId) {
    const guests = await db.select({ id: bookingGuests.id, booking: bookingGuests.booking_id }).from(bookingGuests)
      .where(and(inArray(bookingGuests.booking_id, matched.map((m) => m.id)), isNull(bookingGuests.revoked_at)));
    const g = guests.find((x) => guestIdentityFor(x.id) === identity);
    return g ? { role: "guest", bookingIds: [g.booking], guestId: g.id } : null;
  }
  return null;
}

/** The bookings whose derived room is `room`, among video bookings whose session is near `at`. */
async function bookingsForRoom(room: string, at: Date): Promise<Candidate[]> {
  const rows = await db.select({ id: bookings.id, audience: bookings.audience, slotId: bookings.slot_id, status: bookings.status }).from(bookings).where(and(
    eq(bookings.location_mode, "virtual"),
    lte(bookings.starts_at, new Date(at.getTime() + 30 * MIN)),
    gte(bookings.ends_at, new Date(at.getTime() - 12 * 60 * MIN)),
  )).limit(500);
  return rows
    .map((r) => ({ ...r, audience: r.audience as Candidate["audience"] }))
    .filter((c) => roomFor(c) === room);
}
