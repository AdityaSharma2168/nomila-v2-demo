/**
 * sessionRoom.ts — one private LiveKit room per paid video booking, and the join token for each side.
 *
 * Same LiveKit Cloud project and token pattern as Mila voice (server/voice/webTokenRoute.ts), with the differences a
 * PERSON-TO-PERSON call needs:
 *
 *   NO WORKER     there is no RoomAgentDispatch in the token: nobody but her and the buyer is ever in the room.
 *   NO RECORDING  egress is opt-in in LiveKit (StartEgress, or auto-egress in the room config). We never call the
 *                 former and the room config below carries no egress, and neither grant has roomRecord / roomAdmin.
 *   NO UUIDs      LiveKit Cloud keeps room names and participant identities in logs Nomila cannot delete, so neither
 *                 is a booking or athlete id. The room is `booking_<HMAC(booking id)>` and each identity is
 *                 `<a|b>_<HMAC(booking id, role)>`, keyed with LIVEKIT_API_SECRET (as voiceIdentityFor is): stable, so
 *                 the webhook can map an event back to its booking and side, and meaningless without the secret.
 *                 Derived from the booking id, so no migration stores them.
 *   WHO FITS      1:1: maxParticipants 2. Group sessions (0153): a PRIVATE group's room is still per booking and holds
 *                 the party + her (party_size + 1; the booker and each invited friend have their own identity and
 *                 link); an OPEN group has ONE room per time slot (`booking_<HMAC(slot id)>`, the same no-raw-ids rule)
 *                 holding every spot + her (max_people + 1), each fan joining with the identity of their own booking.
 *                 Camera + microphone only (no screen share at MVP); no data channel.
 *   NAMES         the participant name is what the others see on a tile: her first name; in a 1:1 or private group
 *                 the booker's / friend's first name; in an OPEN group every fan is "Fan" (strangers never see each
 *                 other's names). No email ever reaches LiveKit.
 *
 * THE JOIN WINDOW (BOOKING_VIDEO_JOIN_EARLY_MINUTES before the start until BOOKING_VIDEO_JOIN_LATE_MINUTES after the
 * scheduled end) is checked on every mint, and the token's TTL ends with the window, so a token minted at the last
 * minute cannot be held and replayed later. Only a paid video booking in a live state can be joined, and only by her
 * (requireAuth, her own booking) or by the verified buyer (a signed session link for THIS booking).
 */

import { createHmac } from "node:crypto";
import { AccessToken, RoomConfiguration, TrackSource } from "livekit-server-sdk";
import { BOOKINGS } from "../config";
import type { BookingForSession, SessionRole } from "./sessionPorts";

const ROOM_PREFIX = "booking_";
/** How long LiveKit keeps the room open when nobody has joined, and after the last person leaves (seconds). */
const EMPTY_TIMEOUT_S = 10 * 60;
const DEPARTURE_TIMEOUT_S = 2 * 60;

/** Booking states a session can be joined in (still bounded by the window). Everything else never mints. */
export const JOINABLE_STATUSES = new Set(["confirmed", "in_review", "issue_reported", "disputed", "released"]);

const REQUIRED_ENV = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] as const;

/** Env var NAMES that are missing (never values). */
export function missingLivekitEnv(): string[] {
  return REQUIRED_ENV.filter((k) => !process.env[k]?.trim());
}

function keyed(label: string): string {
  const key = process.env.LIVEKIT_API_SECRET?.trim() ?? "";
  return createHmac("sha256", key).update(label).digest("hex");
}

export function roomNameFor(bookingId: string): string {
  return ROOM_PREFIX + keyed(`booking-room:${bookingId.toLowerCase()}`).slice(0, 24);
}

/** An open group's ONE room for the whole time (0153): keyed on the slot id, never the raw id. */
export function slotRoomNameFor(slotId: string): string {
  return ROOM_PREFIX + keyed(`slot-room:${slotId.toLowerCase()}`).slice(0, 24);
}

/** The athlete's or the booker's identity on a booking (1:1, private group, and each open-group fan's own booking). */
export function identityFor(bookingId: string, role: Exclude<SessionRole, "guest">): string {
  return (role === "athlete" ? "a_" : "b_") + keyed(`booking-identity:${bookingId.toLowerCase()}:${role}`).slice(0, 24);
}

/** A private-group friend's identity, from their booking_guests row. */
export function guestIdentityFor(guestId: string): string {
  return "g_" + keyed(`booking-guest-identity:${guestId.toLowerCase()}`).slice(0, 24);
}

/** Her identity in an open group's slot room (one for the whole time, whichever booking she opened it from). */
export function slotAthleteIdentityFor(slotId: string): string {
  return "a_" + keyed(`slot-identity:${slotId.toLowerCase()}:athlete`).slice(0, 24);
}

type RoomKey = Pick<BookingForSession, "id" | "audience" | "slotId">;

const isOpenGroup = (b: RoomKey): b is RoomKey & { slotId: string } => b.audience === "open_group" && !!b.slotId;

/** The room a booking's call happens in: per slot for an open group, per booking otherwise. */
export function roomFor(b: RoomKey): string {
  return isOpenGroup(b) ? slotRoomNameFor(b.slotId) : roomNameFor(b.id);
}

/** The identity this side joins with. role "guest" needs the guest id. */
export function participantIdentity(b: RoomKey, role: SessionRole, guestId?: string): string {
  if (role === "guest") {
    if (!guestId) throw new Error("participantIdentity: a guest needs its guest id");
    return guestIdentityFor(guestId);
  }
  if (role === "athlete" && isOpenGroup(b)) return slotAthleteIdentityFor(b.slotId);
  return identityFor(b.id, role);
}

/** The room's size: 2 for a 1:1; the party + her for a private group; every spot + her for an open group. */
export function maxParticipantsFor(b: Pick<BookingForSession, "audience" | "partySize" | "roomCapacity">): number {
  if (b.audience === "open_group") return Math.max(2, b.roomCapacity) + 1;
  if (b.audience === "private_group") return Math.max(1, b.partySize) + 1;
  return 2;
}

/** The name on this person's tile, as the others in the room see it. Never an email; "Fan" between strangers. */
export function displayNameFor(b: Pick<BookingForSession, "audience" | "athleteFirstName" | "buyerFirstName">, role: SessionRole, guestName?: string | null): string {
  if (role === "athlete") return b.athleteFirstName;
  if (role === "guest") return guestName?.trim().split(/\s+/)[0]?.slice(0, 40) || "Guest";
  return b.audience === "open_group" ? "Fan" : b.buyerFirstName;
}

export function isBookingRoomName(room: string): boolean {
  return room.startsWith(ROOM_PREFIX);
}

/** True when this booking is a call on Nomila's own video (not a pasted link, not in person). */
export function usesLivekit(b: Pick<BookingForSession, "locationMode" | "meetingMode">): boolean {
  return b.locationMode === "virtual" && (b.meetingMode === "livekit" || b.meetingMode === null);
}

export interface JoinWindow { opensAt: Date; closesAt: Date }

export function joinWindow(b: Pick<BookingForSession, "startsAt" | "endsAt">): JoinWindow | null {
  if (!b.startsAt || !b.endsAt) return null;
  return {
    opensAt:  new Date(b.startsAt.getTime() - BOOKINGS.videoJoinEarlyMinutes * 60_000),
    closesAt: new Date(b.endsAt.getTime() + BOOKINGS.videoJoinLateMinutes * 60_000),
  };
}

export type JoinRefusal = "not_video" | "not_joinable" | "not_yet_open" | "closed" | "buyer_not_verified";

/** Why this side may not join now, or null when it may. */
export function joinRefusal(b: BookingForSession, role: SessionRole, now: Date): JoinRefusal | null {
  if (!usesLivekit(b)) return "not_video";
  if (!JOINABLE_STATUSES.has(b.status)) return "not_joinable";
  if (role !== "athlete" && !b.buyerVerified) return "buyer_not_verified";
  const w = joinWindow(b);
  if (!w) return "not_joinable";
  if (now < w.opensAt) return "not_yet_open";
  if (now > w.closesAt) return "closed";
  return null;
}

export interface JoinToken {
  wsUrl:     string;
  room:      string;
  identity:  string;
  token:     string;
  expiresAt: string;
}

/**
 * Mint the join token. The caller has already checked joinRefusal() (and the routes re-check it right here, so a
 * caller that forgot cannot mint outside the window). Throws on a refusal; never on a missing env (the routes report
 * that by name first).
 */
export async function mintJoinToken(b: BookingForSession, role: SessionRole, now: Date, guest?: { id: string; name: string | null }): Promise<JoinToken> {
  const refusal = joinRefusal(b, role, now);
  if (refusal) throw Object.assign(new Error(refusal), { code: refusal });
  const w = joinWindow(b)!;
  const ttlSeconds = Math.max(60, Math.floor((w.closesAt.getTime() - now.getTime()) / 1000));
  const room = roomFor(b);
  const identity = participantIdentity(b, role, guest?.id);
  const name = displayNameFor(b, role, guest?.name);

  const at = new AccessToken(process.env.LIVEKIT_API_KEY!.trim(), process.env.LIVEKIT_API_SECRET!.trim(), { identity, name, ttl: ttlSeconds });
  // The narrowest grant a two-way video call needs: this one room; camera + mic; subscribe; nothing else.
  at.addGrant({
    roomJoin:             true,
    room,
    canPublish:           true,
    canPublishSources:    [TrackSource.CAMERA, TrackSource.MICROPHONE],
    canSubscribe:         true,
    canPublishData:       false,
    canUpdateOwnMetadata: false,
  });
  // Applied when the first join creates the room: who fits (maxParticipantsFor), a short empty timeout, and NO egress
  // and NO agents.
  at.roomConfig = new RoomConfiguration({
    emptyTimeout:     EMPTY_TIMEOUT_S,
    departureTimeout: DEPARTURE_TIMEOUT_S,
    maxParticipants:  maxParticipantsFor(b),
  });
  return {
    wsUrl: process.env.LIVEKIT_URL!.trim(),
    room,
    identity,
    token: await at.toJwt(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
}
