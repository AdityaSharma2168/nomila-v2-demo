/**
 * sessionPorts.ts — the session's view of a booking and the session-time actions, as one interface.
 *
 * Implemented by ./sessionStore.ts ON the bookings state machine (services/bookings/stateMachine.ts): every status
 * move goes through transition() and every other event through recordBookingEvent(); the clocks come from clocks.ts,
 * the open-report check and the card-fee netting from charges.ts, and her own no-show (refund + the pause) is the
 * reviewer's resolution in resolve.ts. The moves made here are the ones TRANSITIONS allows for the same actor:
 * confirmed → in_review (system at the end; her "Buyer didn't show"), confirmed | in_review → released (the buyer),
 * in_review → released (the system clock), confirmed | in_review → issue_reported (buyer or athlete).
 *
 * Rules this interface carries (owner decisions, 7–8 Oct 2026):
 *   - Attendance is EVIDENCE ONLY. recordAttendance writes booking_events and nothing else; no money decision reads it.
 *   - markItHappened (the BUYER's tap) is the only tap that releases money. markSessionDone (HER tap) only notifies.
 *   - reportProblem holds the money (an open booking_reports row freezes release) and emails support.
 *   - markBuyerNoShow: she marks the BUYER after the grace and is paid on the normal clock.
 */

/**
 * Who is in the call. "buyer" is the person who booked (and paid for) the booking; "guest" is a friend a private-group
 * booker invited (0153: their own signed link, never paying). In an open group every fan is the buyer of their own
 * booking, and she joins ONE room for the whole time.
 */
export type SessionRole = "athlete" | "buyer" | "guest";

export type ReportCategory = "safety" | "no_show" | "not_as_described" | "harassment" | "fraud" | "payment" | "other";
export const REPORT_CATEGORIES: readonly ReportCategory[] = ["safety", "no_show", "not_as_described", "harassment", "fraud", "payment", "other"];

/** What the session needs to know about one booking. Server-side only: buyerEmail never leaves the server. */
export interface BookingForSession {
  id:                string;
  athleteId:         string;
  status:            string;
  format:            string;
  title:             string;
  locationMode:      "virtual" | "in_person";
  meetingMode:       "livekit" | "link" | "in_person" | null;
  /** Her pasted Zoom / Meet link: the fallback for a LiveKit call, or the call itself in link mode. */
  meetingLink:       string | null;
  venue:             string | null;
  startsAt:          Date | null;
  endsAt:            Date | null;
  durationMinutes:   number;
  priceCents:        number;
  currency:          string;
  /** "Jordan P." — the buyer's first name and last initial, as she sees it. */
  buyerDisplayName:  string;
  /** Her first name from her profile, as the buyer sees it. */
  athleteFirstName:  string;
  buyerEmail:        string | null;
  athleteEmail:      string | null;
  /** The buyer verified their email (and the booking was not redacted). Only a verified buyer can join. */
  buyerVerified:     boolean;
  athleteDoneAt:     Date | null;
  buyerConfirmedAt:  Date | null;
  releaseDueAt:      Date | null;
  releasedAt:        Date | null;
  noShowBy:          "buyer" | "athlete" | null;
  noShowMarkedAt:    Date | null;
  /** A booking_reports row in open | in_review: release is frozen. */
  hasOpenReport:     boolean;
  /** 0153: who it was for, the people this booking covers, the time it holds (an open group's room is per slot). */
  audience:          "one" | "private_group" | "open_group";
  partySize:         number;
  slotId:            string | null;
  /** Open group: the spots in the time (the room holds them + her). Otherwise the party size. */
  roomCapacity:      number;
  /** The booker's first name only (what a private group's friends see in the call). */
  buyerFirstName:    string;
}

export type AttendanceKind = "joined" | "left";

export interface AttendanceInput {
  bookingId: string;
  role:      SessionRole;
  /** role "guest": which friend (booking_guests.id). */
  guestId?:  string;
  kind:      AttendanceKind;
  at:        Date;
  /** The LiveKit webhook event id: a redelivered webhook records nothing twice. */
  dedupeKey?: string;
}

export interface AttendanceSummary {
  athleteJoined:   boolean;
  buyerJoined:     boolean;
  athleteInRoom:   boolean;
  buyerInRoom:     boolean;
  firstAthleteJoinAt: Date | null;
  firstBuyerJoinAt:   Date | null;
  /** Private group: how many of the invited friends joined at some point, and how many are in the room now. */
  guestsJoined:    number;
  guestsInRoom:    number;
  /** The booker or any of their friends joined (the party showed up). */
  partyJoined:     boolean;
  /**
   * 0154: is there ANY LiveKit attendance row on this booking (anyone's joined / left)? false = we have no attendance
   * evidence at all (the webhook never reached us, or nobody joined): nobody is told the other side "didn't show".
   */
  evidence:        boolean;
  /**
   * 0154: "join_tapped" — a join token was minted for this side (weak evidence of presence: it can stop a false "never
   * showed", it never proves attendance for a money decision).
   */
  athleteTapped:   boolean;
  buyerTapped:     boolean;
  guestsTapped:    number;
  /** The booker or any friend tapped Join. */
  partyTapped:     boolean;
}

export type ReleaseOutcome = "released" | "release_pending" | "blocked";

export interface ItHappenedResult { outcome: ReleaseOutcome; reason?: string }
export interface SessionDoneResult { athleteDoneAt: string; buyerNotified: boolean }
export interface ReportResult { reportId: string; supportNotified: boolean; moneyHeld: boolean; replyBy: string }
export interface NoShowResult { noShowBy: "buyer"; markedAt: string }

export interface BookingSessionPort {
  getBookingForSession(bookingId: string): Promise<BookingForSession | null>;
  recordAttendance(input: AttendanceInput): Promise<{ recorded: boolean }>;
  attendanceSummary(bookingId: string): Promise<AttendanceSummary>;
  markItHappened(bookingId: string, now?: Date): Promise<ItHappenedResult>;
  markSessionDone(bookingId: string, athleteId: string, now?: Date): Promise<SessionDoneResult>;
  reportProblem(input: { bookingId: string; by: "buyer" | "athlete"; category: ReportCategory; details?: string | null; now?: Date }): Promise<ReportResult>;
  markBuyerNoShow(bookingId: string, athleteId: string, now?: Date): Promise<NoShowResult>;
}

/** A refusal with a stable code; routes map it to a status (sessionErrors.httpStatusFor). */
export class SessionError extends Error {
  constructor(public readonly code: SessionErrorCode, public readonly detail?: Record<string, unknown>) { super(code); }
}

export type SessionErrorCode =
  | "not_found" | "wrong_state" | "too_early" | "issue_open" | "already_marked" | "not_in_person" | "bad_request";

export function httpStatusFor(code: SessionErrorCode): number {
  switch (code) {
    case "not_found":   return 404;
    case "bad_request": return 400;
    default:            return 409;
  }
}
