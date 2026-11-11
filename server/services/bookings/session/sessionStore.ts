/**
 * sessionStore.ts — the session-time actions of a booking (BookingSessionPort, ./sessionPorts.ts), on the bookings
 * state machine: every STATUS change goes through stateMachine.transition() (row lock, the legal-move table, the
 * status event in the same transaction) and every other event through recordBookingEvent(). The only direct writes
 * here are non-status columns (buyer_confirmed_at, athlete_done_at, the no-show mark on a booking already in review).
 *
 *   attendance         booking_events kind 'attendance' (actor livekit; LiveKit's own time in data.occurredAt). Evidence
 *                      only: nothing that moves money reads it.
 *   "It happened"      buyer_confirmed_at, then releaseGate (the ONE path to her money).
 *   "Session done"     athlete_done_at + an email to the buyer. No status change, no money.
 *   "Report a problem" a booking_reports row + confirmed | in_review → issue_reported (transition, same transaction),
 *                      support emailed (SUPPORT_EMAIL), the buyer gets a receipt with a reply-by time.
 *   "Buyer didn't show" (her tap, after the grace) confirmed → in_review on the normal release clock. Her OWN no-show is
 *                      a reviewer's resolution (resolve.ts resolveBookingIssue 'refund_athlete_no_show' → pauseAfterNoShows).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../../db";
import { athletes, bookingEvents, bookingReports, bookings, offers } from "../../../../shared/schema";
import type { Booking } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import { publicBaseUrl } from "../../../lib/baseUrls";
import { BOOKINGS } from "../config";
import { buyerLabel } from "../common";
import { hasOpenReport } from "../charges";
import { noShowAvailableAt, releaseDueAt } from "../clocks";
import { LIVE_STATUSES, recordBookingEvent, transition, TransitionError } from "../stateMachine";
import { mintSessionLink } from "./sessionLink";
import { releaseIfAllowed } from "./releaseGate";
import * as notices from "./notices";
import {
  REPORT_CATEGORIES, SessionError,
  type AttendanceInput, type AttendanceSummary, type BookingForSession, type BookingSessionPort, type ItHappenedResult,
  type NoShowResult, type ReportCategory, type ReportResult, type SessionDoneResult,
} from "./sessionPorts";

const logger = createLogger("bookings/session");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_DETAILS = 2000;

/** Live states in which the session-time taps apply. */
const LIVE = ["confirmed", "in_review"] as const;
const REPORTABLE = new Set(["confirmed", "in_review", "issue_reported", "disputed", "released"]);
const isLive = (s: string) => (LIVE as readonly string[]).includes(s);

function toView(b: Booking, a: { first_name: string | null; full_name: string; email: string | null } | undefined, openReport: boolean, roomCapacity: number): BookingForSession & { buyerTimezone: string | null } {
  const redacted = !!b.buyer_redacted_at;
  return {
    id: b.id,
    athleteId: b.athlete_id,
    status: b.status,
    format: b.format,
    title: b.title,
    locationMode: b.location_mode as BookingForSession["locationMode"],
    meetingMode: (b.meeting_mode ?? null) as BookingForSession["meetingMode"],
    meetingLink: b.meeting_link ?? null,
    venue: b.venue ?? null,
    startsAt: b.starts_at ?? null,
    endsAt: b.ends_at ?? null,
    durationMinutes: b.duration_minutes,
    priceCents: b.price_cents,
    currency: b.currency,
    buyerDisplayName: redacted ? "Your buyer" : buyerLabel(b.buyer_name),
    athleteFirstName: a?.first_name?.trim() || a?.full_name?.trim().split(/\s+/)[0] || "Your athlete",
    buyerEmail: redacted ? null : b.buyer_email,
    athleteEmail: a?.email ?? null,
    buyerVerified: !redacted && !!b.email_verified_at,
    athleteDoneAt: b.athlete_done_at ?? null,
    buyerConfirmedAt: b.buyer_confirmed_at ?? null,
    releaseDueAt: b.release_due_at ?? null,
    releasedAt: b.released_at ?? null,
    noShowBy: (b.no_show_by ?? null) as BookingForSession["noShowBy"],
    noShowMarkedAt: b.no_show_marked_at ?? null,
    hasOpenReport: openReport,
    audience: (b.audience ?? "one") as BookingForSession["audience"],
    partySize: b.party_size ?? 1,
    slotId: b.slot_id ?? null,
    roomCapacity,
    buyerFirstName: redacted ? "Guest" : (b.buyer_name.trim().split(/\s+/)[0] || "Guest").slice(0, 40),
    buyerTimezone: b.buyer_timezone ?? null,
  };
}

/**
 * An open group's room size: the offer's spots now, never fewer than the people already holding spots in the time (a
 * spot sold before she lowered the size still fits). Otherwise the booking's own party.
 */
async function roomCapacityOf(b: Booking): Promise<number> {
  if (b.audience !== "open_group" || !b.slot_id) return b.party_size ?? 1;
  const [o] = await db.select({ max: offers.max_people }).from(offers).where(eq(offers.id, b.offer_id)).limit(1);
  const [r] = await db.select({ n: sql<number>`coalesce(sum(${bookings.party_size}), 0)::int` }).from(bookings)
    .where(and(eq(bookings.slot_id, b.slot_id), inArray(bookings.status, [...LIVE_STATUSES])));
  return Math.max(o?.max ?? 2, Number(r?.n ?? 0));
}

export async function getBookingForSession(bookingId: string): Promise<(BookingForSession & { buyerTimezone: string | null }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) return null;
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!b) return null;
  const [a] = await db.select({ first_name: athletes.first_name, full_name: athletes.full_name, email: athletes.email })
    .from(athletes).where(eq(athletes.id, b.athlete_id)).limit(1);
  return toView(b, a, await hasOpenReport(bookingId), await roomCapacityOf(b));
}

/** Her booking, or not_found — another athlete's booking is indistinguishable from a missing one. */
export async function getAthleteBooking(bookingId: string, athleteId: string) {
  const b = await getBookingForSession(bookingId);
  if (!b || b.athleteId !== athleteId) throw new SessionError("not_found");
  return b;
}

/** The buyer's session page URL for a booking (a fresh signed link each time). */
export function sessionUrlFor(b: Pick<BookingForSession, "id" | "endsAt" | "startsAt">, now: Date = new Date()): string {
  const end = b.endsAt ?? b.startsAt ?? now;
  const expires = new Date(Math.max(end.getTime(), now.getTime()) + BOOKINGS.releaseHours * HOUR + 14 * DAY);
  return `${publicBaseUrl()}/s/${mintSessionLink(b.id, "session", expires)}`;
}

/** A private-group friend's own call page (0153): signed for their booking_guests row, the same lifetime as the booker's. */
export function guestSessionUrlFor(guestId: string, b: Pick<BookingForSession, "endsAt" | "startsAt">, now: Date = new Date()): string {
  const end = b.endsAt ?? b.startsAt ?? now;
  const expires = new Date(Math.max(end.getTime(), now.getTime()) + BOOKINGS.releaseHours * HOUR + 14 * DAY);
  return `${publicBaseUrl()}/s/${mintSessionLink(guestId, "guest", expires)}`;
}

/** Who was taken out of a call by her (0153): "buyer", or "guest:<id>". A removed person gets no new join token. */
export type CallMember = "buyer" | `guest:${string}`;

export async function isRemovedFromCall(bookingId: string, who: CallMember): Promise<boolean> {
  return hasEvent(bookingId, "safety", "removed_from_call", who);
}

export async function markRemovedFromCall(bookingId: string, who: CallMember): Promise<void> {
  if (await isRemovedFromCall(bookingId, who)) return;
  await recordBookingEvent(bookingId, "safety", "athlete", { removed_from_call: who });
}

export function checkinUrlFor(b: Pick<BookingForSession, "id" | "endsAt" | "startsAt">, now: Date = new Date()): string {
  const end = b.endsAt ?? b.startsAt ?? now;
  const expires = new Date(Math.max(end.getTime(), now.getTime()) + DAY);
  return `${publicBaseUrl()}/ok/${mintSessionLink(b.id, "checkin", expires)}`;
}

/** True when an event of this kind already carries `data[key] = value` (the sweep's once-only ledger). Read-only. */
export async function hasEvent(bookingId: string, kind: "attendance" | "note" | "safety", key: string, value: string): Promise<boolean> {
  const rows = await db.select({ id: bookingEvents.id }).from(bookingEvents)
    .where(and(eq(bookingEvents.booking_id, bookingId), eq(bookingEvents.kind, kind), sql`${bookingEvents.data}->>${key} = ${value}`)).limit(1);
  return rows.length > 0;
}

/**
 * An open group (0153) is ONE session for her however many fans booked it: her copy of a per-booking notice goes out
 * once per time. True when another booking of the slot already claimed `notice` (so she has had it).
 */
export async function slotNoticeAlreadySent(slotId: string | null, notice: string, exceptBookingId: string): Promise<boolean> {
  if (!slotId) return false;
  const rows = await db.select({ id: bookingEvents.id }).from(bookingEvents)
    .innerJoin(bookings, eq(bookings.id, bookingEvents.booking_id))
    .where(and(eq(bookings.slot_id, slotId), sql`${bookings.id} <> ${exceptBookingId}`, eq(bookingEvents.kind, "note"), sql`${bookingEvents.data}->>'notice' = ${notice}`))
    .limit(1);
  return rows.length > 0;
}

/** A once-only notice for the sweep: records the 'note' event (actor system) and answers whether this call claimed it. */
export async function claimNotice(bookingId: string, notice: string): Promise<boolean> {
  if (await hasEvent(bookingId, "note", "notice", notice)) return false;
  await recordBookingEvent(bookingId, "note", "system", { notice });
  return true;
}

// ─── Attendance (evidence only) ──────────────────────────────────────────────────────────────────────────────────

export async function recordAttendance(input: AttendanceInput): Promise<{ recorded: boolean }> {
  if (input.dedupeKey && await hasEvent(input.bookingId, "attendance", "livekitEventId", input.dedupeKey)) return { recorded: false };
  await recordBookingEvent(input.bookingId, "attendance", "livekit", {
    event: input.kind, role: input.role, occurredAt: input.at.toISOString(),
    ...(input.guestId ? { guestId: input.guestId } : {}), ...(input.dedupeKey ? { livekitEventId: input.dedupeKey } : {}),
  });
  return { recorded: true };
}

/**
 * "join_tapped" (0154): a join token was minted for `identity` on these bookings — once per identity per booking
 * (kind 'attendance', actor system, data.join_tapped = the identity). Weak evidence only: attendanceSummary reads it as
 * "tapped", never as "joined", so it can stop a false "never showed" but no money decision rests on it.
 */
export async function recordJoinTapped(bookingIds: string[], role: "athlete" | "buyer" | "guest", identity: string, guestId?: string): Promise<number> {
  let n = 0;
  for (const id of bookingIds) {
    if (await hasEvent(id, "attendance", "join_tapped", identity)) continue;
    await recordBookingEvent(id, "attendance", "system", { join_tapped: identity, role, ...(guestId ? { guestId } : {}) });
    n++;
  }
  return n;
}

export async function attendanceSummary(bookingId: string): Promise<AttendanceSummary> {
  const taps = await db.select({ data: bookingEvents.data }).from(bookingEvents)
    .where(and(eq(bookingEvents.booking_id, bookingId), eq(bookingEvents.kind, "attendance"), eq(bookingEvents.actor, "system"), sql`${bookingEvents.data}->>'join_tapped' IS NOT NULL`));
  const tapRole = (r: string) => taps.filter((t) => (t.data as { role?: string } | null)?.role === r);
  const rows = await db.select({ data: bookingEvents.data, at: bookingEvents.at }).from(bookingEvents)
    .where(and(eq(bookingEvents.booking_id, bookingId), eq(bookingEvents.kind, "attendance"), eq(bookingEvents.actor, "livekit")));
  const when = (r: { data: unknown; at: Date }) => { const o = (r.data as { occurredAt?: string } | null)?.occurredAt; return o ? new Date(o) : r.at; };
  rows.sort((x, y) => when(x).getTime() - when(y).getTime());
  const s: AttendanceSummary = {
    athleteJoined: false, buyerJoined: false, athleteInRoom: false, buyerInRoom: false, firstAthleteJoinAt: null, firstBuyerJoinAt: null,
    guestsJoined: 0, guestsInRoom: 0, partyJoined: false,
    evidence: rows.length > 0, athleteTapped: tapRole("athlete").length > 0, buyerTapped: tapRole("buyer").length > 0,
    guestsTapped: tapRole("guest").length, partyTapped: false,
  };
  s.partyTapped = s.buyerTapped || s.guestsTapped > 0;
  const guestsEver = new Set<string>();
  const guestsNow = new Map<string, boolean>();
  for (const r of rows) {
    const d = (r.data ?? {}) as { event?: string; role?: string; guestId?: string };
    const joined = d.event === "joined";
    if (d.role === "guest" && d.guestId) {
      if (joined) guestsEver.add(d.guestId);
      guestsNow.set(d.guestId, joined);
      continue;
    }
    if (d.role === "athlete") {
      if (joined && !s.athleteJoined) s.firstAthleteJoinAt = when(r);
      s.athleteJoined ||= joined; s.athleteInRoom = joined;
    } else if (d.role === "buyer") {
      if (joined && !s.buyerJoined) s.firstBuyerJoinAt = when(r);
      s.buyerJoined ||= joined; s.buyerInRoom = joined;
    }
  }
  s.guestsJoined = guestsEver.size;
  s.guestsInRoom = [...guestsNow.values()].filter(Boolean).length;
  s.partyJoined = s.buyerJoined || s.guestsJoined > 0;
  return s;
}

// ─── The buyer's "It happened" ───────────────────────────────────────────────────────────────────────────────────

export async function markItHappened(bookingId: string, now: Date = new Date()): Promise<ItHappenedResult> {
  const b = await getBookingForSession(bookingId);
  if (!b) throw new SessionError("not_found");
  if (b.status === "released") return { outcome: "released" };
  if (b.hasOpenReport || b.status === "issue_reported" || b.status === "disputed") throw new SessionError("issue_open");
  if (!isLive(b.status)) throw new SessionError("wrong_state", { status: b.status });
  if (!b.startsAt || now < b.startsAt) throw new SessionError("too_early");

  if (!b.buyerConfirmedAt) {
    const set = await db.update(bookings).set({ buyer_confirmed_at: now, updated_at: now })
      .where(and(eq(bookings.id, bookingId), sql`${bookings.buyer_confirmed_at} IS NULL`)).returning({ id: bookings.id });
    if (set.length) await recordBookingEvent(bookingId, "note", "buyer", { it_happened: true });
  }
  const r = await releaseIfAllowed(bookingId, "buyer_confirmed", now);
  return r.outcome === "released" ? { outcome: "released" } : { outcome: r.outcome, reason: r.reason };
}

// ─── Her "Session done" (notifies only) ──────────────────────────────────────────────────────────────────────────

export async function markSessionDone(bookingId: string, athleteId: string, now: Date = new Date()): Promise<SessionDoneResult> {
  const b = await getAthleteBooking(bookingId, athleteId);
  if (!isLive(b.status)) throw new SessionError("wrong_state", { status: b.status });
  if (!b.startsAt || now < b.startsAt) throw new SessionError("too_early");
  if (b.athleteDoneAt) return { athleteDoneAt: b.athleteDoneAt.toISOString(), buyerNotified: false };

  const set = await db.update(bookings).set({ athlete_done_at: now, updated_at: now })
    .where(and(eq(bookings.id, bookingId), sql`${bookings.athlete_done_at} IS NULL`)).returning({ id: bookings.id });
  if (!set.length) return { athleteDoneAt: now.toISOString(), buyerNotified: false };
  await recordBookingEvent(bookingId, "note", "athlete", { session_done: true });
  const sent = await notices.sessionDoneToBuyer(b, sessionUrlFor(b, now));
  return { athleteDoneAt: now.toISOString(), buyerNotified: sent === true };
}

// ─── "Report a problem" (holds the money) ────────────────────────────────────────────────────────────────────────

export function isReportCategory(v: unknown): v is ReportCategory {
  return typeof v === "string" && (REPORT_CATEGORIES as readonly string[]).includes(v);
}

export async function reportProblem(input: { bookingId: string; by: "buyer" | "athlete"; category: ReportCategory; details?: string | null; now?: Date }): Promise<ReportResult> {
  const now = input.now ?? new Date();
  if (!isReportCategory(input.category)) throw new SessionError("bad_request", { field: "category" });
  const details = typeof input.details === "string" ? input.details.trim().slice(0, MAX_DETAILS) : null;

  const b = await getBookingForSession(input.bookingId);
  if (!b) throw new SessionError("not_found");
  if (!REPORTABLE.has(b.status)) throw new SessionError("wrong_state", { status: b.status });
  // "She didn't show" is a claim about the grace period: it cannot be made before the grace is over.
  if (input.category === "no_show" && b.startsAt && now < noShowAvailableAt(b.startsAt)) throw new SessionError("too_early");

  const replyBy = new Date(now.getTime() + (input.category === "safety" ? BOOKINGS.safetyAckHours : BOOKINGS.disputeFirstResponseHours) * HOUR);
  const { reportId, moneyHeld } = await db.transaction(async (tx) => {
    const [rep] = await tx.insert(bookingReports).values({
      booking_id: b.id, athlete_id: b.athleteId, reported_by: input.by, category: input.category, details, status: "open", opened_at: now,
    }).returning({ id: bookingReports.id });
    // The report and the status move commit together. releaseGate only releases a booking still confirmed /
    // in_review, so once this commits no release can complete (see releaseGate for the one race).
    let held = b.status !== "released";
    if (isLive(b.status)) {
      try {
        await transition({ bookingId: b.id, from: [...LIVE], to: "issue_reported", actor: input.by, data: { report_id: rep.id } }, tx);
      } catch (err) {
        // Released in the meantime: the report stands (for an admin reversal); the money has already gone.
        if (!(err instanceof TransitionError && err.code === "STALE_STATE")) throw err;
        held = err.current !== "released";
      }
    }
    await recordBookingEvent(b.id, "safety", input.by, { report_id: rep.id, category: input.category }, tx);
    return { reportId: rep.id, moneyHeld: held };
  });

  const supportNotified = await notices.reportToSupport(b, { reportId, by: input.by, category: input.category, details, replyBy }).catch(() => false);
  if (supportNotified) await db.update(bookingReports).set({ support_notified_at: new Date() }).where(eq(bookingReports.id, reportId));
  if (input.by === "buyer") await Promise.resolve(notices.reportReceivedToBuyer(b, replyBy)).catch(() => false);
  logger.warn({ bookingId: b.id, reportId, by: input.by, category: input.category, supportNotified }, "booking problem reported — release frozen");
  return { reportId, supportNotified, moneyHeld, replyBy: replyBy.toISOString() };
}

// ─── "Buyer didn't show" (her tap, after the grace) ──────────────────────────────────────────────────────────────

/**
 * She marks the BUYER as a no-show, after the grace. She is paid on the NORMAL clock (end + release hours); no money
 * moves now and the buyer can still report a problem. Her own no-show is never marked here: that is a reviewer's
 * resolution (resolve.ts), which refunds the buyer and counts toward the pause.
 */
export async function markBuyerNoShow(bookingId: string, athleteId: string, now: Date = new Date()): Promise<NoShowResult> {
  const b = await getAthleteBooking(bookingId, athleteId);
  if (b.noShowBy) throw new SessionError("already_marked", { noShowBy: b.noShowBy });
  if (!b.startsAt || now < noShowAvailableAt(b.startsAt)) throw new SessionError("too_early");
  if (!isLive(b.status)) throw new SessionError("wrong_state", { status: b.status });

  const releaseDue = b.releaseDueAt ?? (b.endsAt ? releaseDueAt(b.endsAt) : null);
  const patch = { no_show_by: "buyer", no_show_marked_at: now, release_due_at: releaseDue };
  if (b.status === "confirmed") {
    try {
      await transition({ bookingId: b.id, from: "confirmed", to: "in_review", actor: "athlete", athleteId, patch, data: { no_show_by: "buyer" } });
    } catch (err) {
      if (err instanceof TransitionError) throw new SessionError("wrong_state", { status: err.current });
      throw err;
    }
  } else {
    // Already in review (the session ended first): the mark is a non-status column write.
    const set = await db.update(bookings).set({ ...patch, updated_at: now })
      .where(and(eq(bookings.id, b.id), eq(bookings.status, "in_review"), sql`${bookings.no_show_by} IS NULL`)).returning({ id: bookings.id });
    if (!set.length) throw new SessionError("already_marked");
  }
  await recordBookingEvent(b.id, "no_show", "athlete", { no_show_by: "buyer" });
  await Promise.resolve(notices.buyerNoShowToBuyer({ ...b, releaseDueAt: releaseDue }, sessionUrlFor(b, now))).catch(() => false);
  return { noShowBy: "buyer", markedAt: now.toISOString() };
}

// ─── In-person safety check-in ("I'm OK") ────────────────────────────────────────────────────────────────────────

export async function checkIn(bookingId: string, athleteId: string, now: Date = new Date()): Promise<{ checkedInAt: string }> {
  const b = await getAthleteBooking(bookingId, athleteId);
  if (b.locationMode !== "in_person") throw new SessionError("not_in_person");
  if (!REPORTABLE.has(b.status)) throw new SessionError("wrong_state", { status: b.status });
  if (!b.startsAt || now < b.startsAt) throw new SessionError("too_early");
  const prior = await lastCheckIn(bookingId);
  if (prior) return { checkedInAt: prior.toISOString() };
  await recordBookingEvent(bookingId, "safety", "athlete", { checkin: "ok" });
  return { checkedInAt: (await lastCheckIn(bookingId))?.toISOString() ?? now.toISOString() };
}

export async function lastCheckIn(bookingId: string): Promise<Date | null> {
  const [r] = await db.select({ at: bookingEvents.at }).from(bookingEvents)
    .where(and(eq(bookingEvents.booking_id, bookingId), eq(bookingEvents.kind, "safety"), sql`${bookingEvents.data}->>'checkin' = 'ok'`))
    .orderBy(bookingEvents.at).limit(1);
  return r?.at ?? null;
}

/** The port, satisfied by this module (a type check that the interface and the implementation agree). */
export const sessionStore: BookingSessionPort = {
  getBookingForSession, recordAttendance, attendanceSummary, markItHappened, markSessionDone, reportProblem, markBuyerNoShow,
};
