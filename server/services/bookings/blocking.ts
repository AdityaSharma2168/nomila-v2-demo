/**
 * bookings/blocking.ts — her "Block" on a booking (0154): from the booking detail (the booker), from an open group's
 * attendee (that fan's own booking), or from a call tile (the booker, an invited friend, or one fan in an open group's
 * time — the same identity rules as Remove, groups.ts callMember). The block itself is fanSafety/fanBlocks.ts (athlete ×
 * keyed email / phone hash), so it holds everywhere that person could reach her, today and in a later Live.
 *
 * Blocking, in one tap on a confirm sheet (the preview says exactly what will happen):
 *   1. the block is recorded (idempotent; blocking someone already blocked changes nothing)
 *   2. they are taken out of the call they are in (no new join token for them on this booking, LiveKit drops them)
 *   3. every UPCOMING paid booking they have with her is cancelled with a FULL refund — her own cancel
 *      (athlete.ts cancelByAthlete: the fan gets everything back, she covers the card fee, her first one free). The fan
 *      gets the usual "cancelled" email, never a word about a block.
 *   4. anything still pending is ended the way her decline ends it (the hold released): a request is declined, an
 *      accepted booking waiting on a pay link expires, an unverified request expires
 *   5. the friend invites of theirs on her other upcoming sessions are revoked (their link stops working)
 *
 * A session that has STARTED is never cancelled here (it's happening or over: her "Report a problem" is the door for
 * that, and the money follows the review). Recorded on the booking (kind 'safety', blocked).
 */
import { and, eq, gt, inArray, isNull, or, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { bookingGuests, bookings } from "../../../shared/schema";
import type { Booking, BookingGuest } from "../../../shared/schema";
import type { BlockPreviewView, BlockResultView } from "../../../shared/bookingsApi";
import { createLogger } from "../../logger";
import { coded } from "./common";
import { notices } from "./notices";
import { cancelQuote } from "./clocks";
import { cancelHold, paymentFor } from "./charges";
import { recordBookingEvent, transition, TransitionError, type BookingStatus } from "./stateMachine";
import { cancelByAthlete, getOwnedBooking } from "./athlete";
import { callMember, removeMember, type CallMemberRef, type CallRef } from "./groups";
import { identityFor, guestIdentityFor, roomFor } from "./session/sessionRoom";
import { markRemovedFromCall } from "./session/sessionStore";
import { removeFromRoom } from "./session/roomAdmin";
import type { BookingForSession } from "./session/sessionPorts";
import { blockFan, fanBlockView, isFanBlocked, type FanKey } from "../fanSafety/fanBlocks";

const logger = createLogger("bookings/blocking");

/** Is the person a join token is about to be minted for blocked by her? (the booker, or an invited friend) */
export async function callerIsBlocked(b: Pick<BookingForSession, "id" | "athleteId">, guest?: Pick<BookingGuest, "email_hash"> | null): Promise<boolean> {
  if (guest) return isFanBlocked(b.athleteId, { emailHash: guest.email_hash });
  const [r] = await db.select({ e: bookings.buyer_email_hash, p: bookings.buyer_phone_hash }).from(bookings).where(eq(bookings.id, b.id)).limit(1);
  return !!r && isFanBlocked(b.athleteId, { emailHash: r.e, phoneHash: r.p });
}

interface Target { member: CallMemberRef; key: FanKey }

/**
 * Who she is blocking. A booking with no identity = its booker (the booking detail, an open-group attendee row); an
 * identity = that person in the call (a tile). An open group's time needs the identity.
 */
async function targetOf(athleteId: string, call: CallRef, identity: unknown): Promise<Target> {
  let id = identity;
  if (id === undefined || id === null || id === "") {
    if (!("bookingId" in call)) throw coded("INVALID", [{ field: "identity", problem: "a participant in this call" }]);
    id = identityFor((await getOwnedBooking(athleteId, call.bookingId)).id, "buyer");
  }
  const member = await callMember(athleteId, call, id);
  const key: FanKey = member.guest
    ? { emailHash: member.guest.email_hash }
    : { emailHash: member.booking.buyer_email_hash, phoneHash: member.booking.buyer_phone_hash };
  return { member, key };
}

/** Her bookings with this person as the booker (by email hash, or phone hash when known). */
async function theirBookings(athleteId: string, key: FanKey, statuses: BookingStatus[], extra?: SQL): Promise<Booking[]> {
  const who = key.phoneHash ? or(eq(bookings.buyer_email_hash, key.emailHash), eq(bookings.buyer_phone_hash, key.phoneHash)) : eq(bookings.buyer_email_hash, key.emailHash);
  return db.select().from(bookings).where(and(eq(bookings.athlete_id, athleteId), inArray(bookings.status, statuses), who, ...(extra ? [extra] : [])));
}

const PENDING: BookingStatus[] = ["unverified", "requested", "accepted"];

/** What the confirm sheet says before she blocks: who, and which upcoming bookings are cancelled and refunded. */
export async function blockPreview(athleteId: string, call: CallRef, body: { identity?: unknown }, now = new Date()): Promise<BlockPreviewView> {
  const { member, key } = await targetOf(athleteId, call, body.identity);
  const upcoming = await theirBookings(athleteId, key, ["confirmed"], gt(bookings.starts_at, now));
  const pending = await theirBookings(athleteId, key, PENDING);
  return {
    firstName: member.firstName,
    role: member.guest ? "guest" : "buyer",
    alreadyBlocked: await isFanBlocked(athleteId, key),
    cancels: upcoming.map((b) => ({ bookingId: b.id, title: b.title, startsAt: b.starts_at!.toISOString(), refundCents: cancelQuote(b, "athlete", now).refundCents })),
    pendingRequests: pending.filter((b) => b.status !== "unverified").length,
  };
}

/** Her Block (one tap, after the confirm sheet). See the header for every step. */
export async function blockFromCall(athleteId: string, call: CallRef, body: { identity?: unknown; reason?: unknown }, now = new Date()): Promise<BlockResultView> {
  const { member, key } = await targetOf(athleteId, call, body.identity);
  const { block, created } = await blockFan(athleteId, {
    ...key, firstName: member.firstName, reason: typeof body.reason === "string" ? body.reason : null,
    source: member.guest ? "guest" : "booking", bookingId: member.booking.id,
  }, now);
  await recordBookingEvent(member.booking.id, "safety", "athlete", { blocked: block.id, who: member.who, created });

  // 2 — out of the call they're in now.
  const removedFromCall = await removeMember(member).catch(() => false);

  // 3 — every upcoming paid booking of theirs with her: her cancel, a full refund.
  let canceled = 0, refundedCents = 0;
  for (const b of await theirBookings(athleteId, key, ["confirmed"], gt(bookings.starts_at, now))) {
    try {
      const q = cancelQuote(b, "athlete", now);
      await cancelByAthlete(athleteId, b.id, { reason: "" }, now);
      canceled++; refundedCents += q.refundCents;
    } catch (err: any) {
      if (!(err instanceof TransitionError) && err?.code !== "WRONG_STATE" && err?.code !== "STARTED") throw err;
    }
  }

  // 4 — anything still pending ends the way her decline ends it (no charge; the hold released).
  let requestsEnded = 0;
  for (const b of await theirBookings(athleteId, key, PENDING)) {
    try {
      const to: BookingStatus = b.status === "requested" ? "declined" : "expired";
      const row = await transition({
        bookingId: b.id, from: b.status as BookingStatus, to, actor: to === "declined" ? "athlete" : "system", athleteId, data: { blocked: true },
      });
      const p = await paymentFor(b.id);
      if (p) await cancelHold(p, "blocked", to === "declined" ? "canceled" : "expired");
      if (b.status === "requested") await notices.declined(row);
      else if (b.status === "accepted") await notices.expired(row);
      if (b.status !== "unverified") requestsEnded++;
    } catch (err) {
      if (!(err instanceof TransitionError)) throw err;   // moved meanwhile
    }
  }

  // 5 — their friend invites on her other upcoming sessions.
  const invites = await db.select({ g: bookingGuests, b: bookings }).from(bookingGuests).innerJoin(bookings, eq(bookings.id, bookingGuests.booking_id))
    .where(and(eq(bookings.athlete_id, athleteId), eq(bookingGuests.email_hash, key.emailHash), isNull(bookingGuests.revoked_at),
      inArray(bookings.status, ["confirmed", "in_review"])));
  for (const { g, b } of invites) {
    if (b.ends_at && b.ends_at <= now) continue;
    await db.update(bookingGuests).set({ revoked_at: now }).where(eq(bookingGuests.id, g.id));
    await markRemovedFromCall(b.id, `guest:${g.id}`);
    await removeFromRoom(roomFor({ id: b.id, audience: b.audience as "private_group", slotId: b.slot_id }), guestIdentityFor(g.id)).catch(() => false);
  }

  logger.info({ athleteId, bookingId: member.booking.id, canceled, requestsEnded, created }, "fan blocked");
  return { block: fanBlockView(block), canceled, refundedCents, requestsEnded, removedFromCall };
}
