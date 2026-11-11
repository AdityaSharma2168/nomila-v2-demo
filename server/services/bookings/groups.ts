/**
 * bookings/groups.ts — her side of an OPEN group session (0153): one time, many fans, ONE item in her app.
 *
 * Each fan's spot is its own booking (its own payment, refund, release and no-show, exactly as a 1:1), so the money
 * stays per booking. What she sees and does is per TIME (the slot):
 *
 *   list / detail   the time with its people: count, spots left, first names, who is in the call (LiveKit identity so
 *                   her app can label tiles and remove someone). Never contact details.
 *   join            ONE room for the time (sessionRoom.slotRoomNameFor), her one identity in it.
 *   cancel          her one tap cancels and refunds EVERY booking in the time (each fan gets everything back; she covers
 *                   Stripe's actual card fee per refund, her first ever is free), releases the hold of anyone mid-checkout,
 *                   and withdraws the time so nobody else books it.
 *   session done    marks every live booking of the time done (each fan gets "Did it happen?").
 *   remove          takes one participant out of the call (and refuses them a new join token).
 *
 * Always scoped to her athlete id: another athlete's time is NOT_FOUND.
 */
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../../db";
import { bookings, offerSlots, offers } from "../../../shared/schema";
import type { Booking, BookingGuest, Offer, OfferSlot } from "../../../shared/schema";
import type { GroupAttendeeView, GroupCancelPreviewView, GroupCancelResultView, GroupSessionListItemView, GroupSessionView } from "../../../shared/bookingsApi";
import { BOOKINGS } from "./config";
import { coded } from "./common";
import { estimateProcessingCents } from "./money";
import { notices } from "./notices";
import { FUNDED_STATUSES, LIVE_STATUSES, recordBookingEvent, transition, TransitionError, type BookingStatus } from "./stateMachine";
import { cancelQuote } from "./clocks";
import { cancelHold, firstCancelStillFree, paymentFor, recordAthleteRefundCost, refundBookingPayment } from "./charges";
import { nomilaLine } from "./relay";
import { attendanceSummary, getBookingForSession, isRemovedFromCall, markRemovedFromCall, markSessionDone, type CallMember } from "./session/sessionStore";
import { guestIdentityFor, identityFor, JOINABLE_STATUSES, roomFor, slotAthleteIdentityFor } from "./session/sessionRoom";
import { videoFor, type CallParticipantView } from "./session/sessionView";
import { muteInRoom, removeFromRoom, type MuteOutcome } from "./session/roomAdmin";
import { liveGuests } from "./guests";
import { getOwnedBooking } from "./athlete";
import { isFanBlocked } from "../fanSafety/fanBlocks";
import type { BookingForSession } from "./session/sessionPorts";

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Spots that count as booked for her (paid, or past it): what she sees as people. */
const BOOKED: readonly BookingStatus[] = ["confirmed", "in_review", "issue_reported", "disputed", "released"];
const firstName = (name: string) => (name.trim().split(/\s+/)[0] || "Fan").slice(0, 40);

interface Group { slot: OfferSlot; offer: Offer; rows: Booking[] }

/** Her open-group time, with every booking ever made in it. NOT_FOUND when it isn't hers or isn't an open group. */
async function loadGroup(athleteId: string, slotId: string): Promise<Group> {
  if (typeof slotId !== "string" || !UUID.test(slotId)) throw coded("NOT_FOUND");
  const [r] = await db.select({ slot: offerSlots, offer: offers }).from(offerSlots).innerJoin(offers, eq(offers.id, offerSlots.offer_id))
    .where(and(eq(offerSlots.id, slotId), eq(offerSlots.athlete_id, athleteId))).limit(1);
  if (!r || r.offer.audience !== "open_group") throw coded("NOT_FOUND");
  const rows = await db.select().from(bookings).where(and(eq(bookings.slot_id, slotId), ne(bookings.status, "unverified"))).orderBy(asc(bookings.created_at));
  return { slot: r.slot, offer: r.offer, rows };
}

function phaseOf(g: Group, now: Date): GroupSessionListItemView["phase"] {
  if (!g.rows.some((b) => BOOKED.includes(b.status as BookingStatus) || (LIVE_STATUSES as readonly string[]).includes(b.status))) {
    if (g.rows.length) return "canceled";
  }
  if (now < g.slot.starts_at) return "booked";
  if (now < g.slot.ends_at) return "happening";
  return "finished";
}

async function liveSpots(slotId: string): Promise<number> {
  const rows = await db.select({ n: bookings.party_size }).from(bookings)
    .where(and(eq(bookings.slot_id, slotId), inArray(bookings.status, [...LIVE_STATUSES])));
  return rows.reduce((s, r) => s + r.n, 0);
}

async function itemOf(g: Group, now: Date): Promise<GroupSessionListItemView> {
  const taken = await liveSpots(g.slot.id);
  const booked = g.rows.filter((b) => BOOKED.includes(b.status as BookingStatus));
  const paidOut = booked.filter((b) => b.status !== "refunded");
  return {
    slotId: g.slot.id, offerId: g.offer.id, title: g.offer.title, format: g.offer.format as GroupSessionListItemView["format"],
    locationMode: g.offer.location_mode as GroupSessionListItemView["locationMode"],
    startsAt: g.slot.starts_at.toISOString(), endsAt: g.slot.ends_at.toISOString(),
    capacity: g.offer.max_people, spotsTaken: taken, spotsLeft: Math.max(0, g.offer.max_people - taken),
    phase: phaseOf(g, now),
    receiveCents: paidOut.reduce((s, b) => s + b.price_cents, 0),
    unitPriceCents: g.offer.price_cents,
    firstNames: booked.map((b) => (b.buyer_redacted_at ? "Fan" : firstName(b.buyer_name))),
  };
}

export type GroupListView = "upcoming" | "past";

/**
 * Her open-group times that someone booked: upcoming (not yet ended, with at least one live spot) or past (ended, or
 * every spot cancelled), soonest first / newest first.
 */
export async function listGroupSessions(athleteId: string, view: GroupListView, now = new Date()): Promise<GroupSessionListItemView[]> {
  const slots = await db.selectDistinct({ id: bookings.slot_id }).from(bookings)
    .where(and(eq(bookings.athlete_id, athleteId), eq(bookings.audience, "open_group"), ne(bookings.status, "unverified")));
  const out: GroupSessionListItemView[] = [];
  for (const { id } of slots) {
    if (!id) continue;
    const g = await loadGroup(athleteId, id).catch(() => null);
    if (!g) continue;
    const item = await itemOf(g, now);
    const upcoming = item.phase === "booked" || item.phase === "happening";
    if ((view === "upcoming") === upcoming) out.push(item);
  }
  out.sort((a, b) => (view === "upcoming" ? 1 : -1) * (Date.parse(a.startsAt) - Date.parse(b.startsAt)));
  return view === "past" ? out.slice(0, 50) : out;
}

/** The booking whose session view stands for the whole time (her join, the window): any spot that can be joined. */
async function representative(g: Group): Promise<BookingForSession | null> {
  const r = g.rows.find((b) => JOINABLE_STATUSES.has(b.status)) ?? g.rows[0];
  return r ? getBookingForSession(r.id) : null;
}

export async function groupSessionDetail(athleteId: string, slotId: string, now = new Date()): Promise<GroupSessionView> {
  const g = await loadGroup(athleteId, slotId);
  const item = await itemOf(g, now);
  const rep = await representative(g);
  const attendees: GroupAttendeeView[] = [];
  for (const b of g.rows.filter((x) => BOOKED.includes(x.status as BookingStatus))) {
    const a = await attendanceSummary(b.id);
    attendees.push({
      bookingId: b.id, firstName: b.buyer_redacted_at ? "Fan" : firstName(b.buyer_name), status: b.status as GroupAttendeeView["status"],
      partySize: b.party_size, identity: identityFor(b.id, "buyer"), joined: a.buyerJoined, inRoom: a.buyerInRoom,
      blocked: await isFanBlocked(athleteId, { emailHash: b.buyer_email_hash, phoneHash: b.buyer_phone_hash }),
    });
  }
  const video = rep ? videoFor(rep, "athlete", now) : { mode: "none" as const, joinOpensAt: null, joinClosesAt: null, joinState: "unavailable" as const, fallbackLink: null };
  const live = g.rows.some((b) => b.status === "confirmed");
  const started = now >= g.slot.starts_at;
  return {
    ...item, attendees, video,
    actions: {
      join: video.mode === "livekit" && video.joinState === "open",
      cancel: live && !started,
      sessionDone: started && g.rows.some((b) => (b.status === "confirmed" || b.status === "in_review") && !b.athlete_done_at),
      removeParticipant: video.mode === "livekit" && video.joinState === "open",
    },
    freeCancelHours: g.offer.free_cancel_hours,
    firstCancelFree: await firstCancelStillFree(athleteId),
    supportEmail: BOOKINGS.supportEmail,
    serverNow: now.toISOString(),
  };
}

/** Every spot of a time that can be joined now (her join in the time's ONE room counts for each of them). */
export async function slotJoinableBookingIds(slotId: string): Promise<string[]> {
  const rows = await db.select({ id: bookings.id }).from(bookings)
    .where(and(eq(bookings.slot_id, slotId), inArray(bookings.status, [...JOINABLE_STATUSES])));
  return rows.map((r) => r.id);
}

/** The session view her join token is minted from: the time's room, her one identity (sessionRoom). */
export async function groupSessionForJoin(athleteId: string, slotId: string): Promise<BookingForSession> {
  const g = await loadGroup(athleteId, slotId);
  const rep = await representative(g);
  if (!rep) throw coded("NOT_FOUND");
  return rep;
}

export async function groupCancelPreview(athleteId: string, slotId: string, now = new Date()): Promise<GroupCancelPreviewView> {
  const g = await loadGroup(athleteId, slotId);
  if (now >= g.slot.starts_at) throw coded("STARTED");
  const paid = g.rows.filter((b) => b.status === "confirmed");
  const pending = (await db.select({ id: bookings.id }).from(bookings)
    .where(and(eq(bookings.slot_id, slotId), inArray(bookings.status, ["unverified", "requested", "accepted"])))).length;
  const people = paid.reduce((s, b) => s + b.party_size, 0);
  const refund = paid.reduce((s, b) => s + cancelQuote(b, "athlete", now).refundCents, 0);
  const free = await firstCancelStillFree(athleteId);
  const fees = paid.map((b) => estimateProcessingCents(b.buyer_total_cents, BOOKINGS.processingPercent, BOOKINGS.processingFixedCents));
  const est = fees.reduce((s, f) => s + f, 0) - (free && fees.length ? Math.max(...fees) : 0);
  return { bookings: paid.length, people, pending, buyerRefundCents: refund, firstCancelFree: free, estCardFeeCents: Math.max(0, est) };
}

/**
 * Her one tap: cancel the whole time. Every paid spot is cancelled and refunded in full (the refund is retried by the
 * sweeper if Stripe fails); anyone mid-checkout has their hold released; the time is withdrawn from her card.
 */
export async function cancelGroupSession(athleteId: string, slotId: string, body: { reason?: unknown }, now = new Date()): Promise<GroupCancelResultView> {
  const g = await loadGroup(athleteId, slotId);
  if (now >= g.slot.starts_at) throw coded("STARTED");
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  // Nobody new from here: the time comes off her card first.
  await db.update(offerSlots).set({ withdrawn_at: now }).where(and(eq(offerSlots.id, slotId), isNull(offerSlots.withdrawn_at)));
  let canceled = 0, released = 0, refundedCents = 0;
  const all = await db.select().from(bookings).where(and(eq(bookings.slot_id, slotId), inArray(bookings.status, [...LIVE_STATUSES])));
  for (const b of all) {
    try {
      if (b.status === "confirmed") {
        const q = cancelQuote(b, "athlete", now);
        const row = await transition({
          bookingId: b.id, from: "confirmed", to: "canceled", actor: "athlete", athleteId,
          patch: { canceled_at: now, canceled_by: "athlete", refund_outcome: q.outcome }, data: { refund_cents: q.refundCents, group_cancel: true },
        });
        const p = await paymentFor(b.id);
        if (p) {
          try {
            await refundBookingPayment(p, q.refundCents, "athlete", reason || "athlete cancelled the group session");
            await recordAthleteRefundCost(row, (await paymentFor(b.id))!);
          } catch { /* recorded on the payment; the sweeper retries the refund */ }
        }
        if (reason) await nomilaLine(b.id, `Cancelled by her: ${reason}`);
        await notices.canceledByAthlete(row, q.refundCents, reason);
        canceled++; refundedCents += q.refundCents;
      } else if (!(FUNDED_STATUSES as readonly string[]).includes(b.status)) {
        // Mid-checkout (unverified / requested / accepted): nothing was charged; the hold is released.
        const row = await transition({ bookingId: b.id, from: b.status as BookingStatus, to: "expired", actor: "system", data: { group_cancel: true } });
        const p = await paymentFor(b.id);
        if (p) await cancelHold(p, "group_canceled", "canceled");
        if (b.status !== "unverified") await notices.expired(row);
        released++;
      }
    } catch (err) {
      if (!(err instanceof TransitionError)) throw err;   // moved by someone else meanwhile (a fan cancelled first)
    }
  }
  return { canceled, released, refundedCents, group: await groupSessionDetail(athleteId, slotId, now) };
}

/** "Session done" for the whole time: every live spot (each fan gets "Did it happen?"). Never moves money. */
export async function markGroupSessionDone(athleteId: string, slotId: string, now = new Date()): Promise<GroupSessionView> {
  const g = await loadGroup(athleteId, slotId);
  if (now < g.slot.starts_at) throw coded("TOO_EARLY");
  for (const b of g.rows.filter((x) => (x.status === "confirmed" || x.status === "in_review") && !x.athlete_done_at)) {
    await markSessionDone(b.id, athleteId, now).catch(() => undefined);
  }
  return groupSessionDetail(athleteId, slotId, now);
}

/**
 * The people on the other side of a 1:1 or private-group call, as her session view shows them (sessionView
 * CallParticipantView): the booker, then each friend still invited, with the identity they join with and whether she
 * already took them out. First names only. An open group's people are its time's attendees (groupSessionDetail).
 */
export async function callParticipants(b: Pick<BookingForSession, "id" | "audience" | "buyerFirstName">): Promise<CallParticipantView[]> {
  if (b.audience === "open_group") return [];
  const out: CallParticipantView[] = [
    { identity: identityFor(b.id, "buyer"), firstName: b.buyerFirstName, role: "buyer", removed: await isRemovedFromCall(b.id, "buyer") },
  ];
  if (b.audience === "private_group") {
    for (const g of await liveGuests(b.id)) {
      out.push({
        identity: guestIdentityFor(g.id), firstName: g.name?.trim() ? firstName(g.name) : "Guest", role: "guest",
        removed: await isRemovedFromCall(b.id, `guest:${g.id}`),
      });
    }
  }
  return out;
}

/**
 * One person on the other side of HER call, from the identity her app holds for a tile (0154; the same identity rules
 * the remove routes always had): the booker or one of their invited friends on a 1:1 / private-group booking, or one
 * fan's own booking in an open group's time. `booking` is the booking that person belongs to (the one whose events
 * record what she did); `room` is the call's room. Her own identity is never a member. Always scoped to her athlete id.
 */
export interface CallMemberRef {
  booking: Booking;
  who: CallMember;
  identity: string;
  room: string;
  guest: BookingGuest | null;
  /** The first name she sees on the tile. */
  firstName: string;
}

const badIdentity = () => coded("INVALID", [{ field: "identity", problem: "a participant in this call" }]);

/** The member of a 1:1 / private-group call (an open group's booking is handed to its time). */
export async function bookingCallMember(athleteId: string, bookingId: string, identity: unknown): Promise<CallMemberRef> {
  const b = await getOwnedBooking(athleteId, bookingId);
  if (b.audience === "open_group" && b.slot_id) return groupCallMember(athleteId, b.slot_id, identity);
  if (typeof identity !== "string") throw badIdentity();
  const room = roomFor({ id: b.id, audience: b.audience as "one", slotId: b.slot_id });
  if (identity === identityFor(b.id, "buyer")) {
    return { booking: b, who: "buyer", identity, room, guest: null, firstName: b.buyer_redacted_at ? "Fan" : firstName(b.buyer_name) };
  }
  const g = (await liveGuests(b.id)).find((x) => guestIdentityFor(x.id) === identity);
  if (!g) throw coded("NOT_FOUND");
  return { booking: b, who: `guest:${g.id}`, identity, room, guest: g, firstName: g.name?.trim() ? firstName(g.name) : "Guest" };
}

/** One fan in an open group's time, by the identity they joined with. */
export async function groupCallMember(athleteId: string, slotId: string, identity: unknown): Promise<CallMemberRef> {
  const g = await loadGroup(athleteId, slotId);
  if (typeof identity !== "string" || identity === slotAthleteIdentityFor(slotId)) throw badIdentity();
  const b = g.rows.find((x) => identityFor(x.id, "buyer") === identity);
  if (!b) throw coded("NOT_FOUND");
  return {
    booking: b, who: "buyer", identity, room: roomFor({ id: b.id, audience: "open_group", slotId }), guest: null,
    firstName: b.buyer_redacted_at ? "Fan" : firstName(b.buyer_name),
  };
}

/** Which call: a booking's (1:1, private group, or an open-group spot) or an open group's time. */
export type CallRef = { bookingId: string } | { slotId: string };

export function callMember(athleteId: string, call: CallRef, identity: unknown): Promise<CallMemberRef> {
  return "slotId" in call ? groupCallMember(athleteId, call.slotId, identity) : bookingCallMember(athleteId, call.bookingId, identity);
}

/** Take a resolved member out of the call: no new join token for them, and LiveKit drops the connection they have. */
export async function removeMember(m: CallMemberRef): Promise<boolean> {
  await markRemovedFromCall(m.booking.id, m.who);
  return removeFromRoom(m.room, m.identity);
}

/**
 * Take one person out of a 1:1 or private-group call (her tap): the booker, or one of their invited friends. They can't
 * rejoin with their link; the booking is unchanged (she can still cancel it, or report a problem). An open group's
 * booking is handed to its time (removeFromGroupCall).
 */
export async function removeFromBookingCall(athleteId: string, bookingId: string, identity: unknown): Promise<{ removed: boolean }> {
  return { removed: await removeMember(await bookingCallMember(athleteId, bookingId, identity)) };
}

/** Take one fan out of the group call (her tap). They can't rejoin with their link; their booking is unchanged. */
export async function removeFromGroupCall(athleteId: string, slotId: string, identity: unknown): Promise<{ removed: boolean }> {
  return { removed: await removeMember(await groupCallMember(athleteId, slotId, identity)) };
}

export type ModerationTrack = "microphone" | "camera";

/**
 * Her "Mute" / "Turn off camera" on a tile (0154): LiveKit mutes that person's microphone or camera track now. They can
 * turn it back on themselves. Each tap is recorded on the member's booking (kind 'safety', moderation mute_mic /
 * camera_off, by athlete). `outcome` says whether LiveKit did it (muted), they weren't in the call (not_in_call), or
 * LiveKit couldn't be reached (unreachable; the tap is still recorded).
 */
export async function muteCallMember(athleteId: string, call: CallRef, identity: unknown, track: unknown): Promise<{ outcome: MuteOutcome }> {
  if (track !== "microphone" && track !== "camera") throw coded("INVALID", [{ field: "track", problem: "microphone or camera" }]);
  const m = await callMember(athleteId, call, identity);
  const outcome = await muteInRoom(m.room, m.identity, track);
  await recordBookingEvent(m.booking.id, "safety", "athlete", { moderation: track === "microphone" ? "mute_mic" : "camera_off", who: m.who, outcome });
  return { outcome };
}
