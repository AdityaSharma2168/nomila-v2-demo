/**
 * sessionSweep.ts — the session-time sweep, every 5 minutes (Cloud Scheduler → /api/internal/booking-session-cron,
 * plus an in-process copy in production; both under one advisory lock). A no-op while BOOKINGS_ENABLED is off.
 *
 *   1. JOIN NOTICE      from start − 10 min: the buyer gets the join link (/s/:token), she gets "open the app". Once.
 *   2. GRACE CHECK      at start + BOOKING_NO_SHOW_GRACE_MINUTES on a Nomila video call: records who had joined
 *                       (booking_events attendance, actor system) and tells the side that is waiting. It RECORDS and
 *                       NOTIFIES only; it never marks a no-show and never moves money. Once. With NO LiveKit
 *                       attendance at all on the booking (0154) it records result "attendance_unknown" and tells
 *                       nobody anything; a side that tapped Join (join_tapped) is never reported as absent.
 *   3. AFTER THE END    confirmed → in_review, release_due_at = end + BOOKING_RELEASE_HOURS, and the buyer gets
 *                       "How did it go?" (unless they already said it happened). Once.
 *   4. CHECK-IN NUDGE   in person, 30 min after the end with no "I'm OK": a nudge to HER (a reminder, not
 *                       monitoring). Once.
 *   5. RELEASE          in_review (or confirmed with the buyer's "It happened" whose transfer failed earlier) where the
 *                       buyer confirmed or release_due_at has passed (end + 48h, or NOW after a reviewer's "release"
 *                       in resolve.ts), and a late buyer cancel at its release_due_at → releaseGate, which re-checks
 *                       everything (nothing open, she was not the no-show) and nets owed card fees. Retried every run.
 *
 * Status moves go through the state machine's transition(); events through recordBookingEvent().
 * "Once" is the booking_events ledger: each notice writes a 'note' event naming it BEFORE sending, so an overlapping
 * run (or a crash after the send) never sends twice. A failed send is logged and not retried (it is a reminder).
 */

import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../../db";
import { bookingEvents, bookings } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import { BOOKINGS } from "../config";
import { releaseDueAt } from "../clocks";
import { recordBookingEvent, transition, TransitionError } from "../stateMachine";
import { releaseIfAllowed } from "./releaseGate";
import { usesLivekit } from "./sessionRoom";
import * as notices from "./notices";
import {
  attendanceSummary, claimNotice, getBookingForSession, guestSessionUrlFor, hasEvent, lastCheckIn, sessionUrlFor, slotNoticeAlreadySent,
} from "./sessionStore";
import { pushBooking } from "../push";
import { liveGuests } from "../guests";

const logger = createLogger("bookings/sessionSweep");
const MIN = 60_000;
const HOUR = 60 * MIN;
const BATCH = 200;

export interface SessionSweepResult {
  skipped?:      boolean;
  joinNotices:   number;
  graceChecks:   number;
  /** 0154: grace checks that found no attendance evidence at all (nobody told anyone "didn't show"). */
  attendanceUnknown: number;
  movedToReview: number;
  checkinNudges: number;
  released:      number;
  releasePending: number;
}

export async function runBookingSessionSweep(now: Date = new Date()): Promise<SessionSweepResult> {
  const r: SessionSweepResult = { joinNotices: 0, graceChecks: 0, attendanceUnknown: 0, movedToReview: 0, checkinNudges: 0, released: 0, releasePending: 0 };
  if (!BOOKINGS.enabled) return { ...r, skipped: true };

  // 1. Join notice: the window has opened and the session hasn't ended.
  const opening = await db.select({ id: bookings.id }).from(bookings).where(and(
    eq(bookings.status, "confirmed"), eq(bookings.location_mode, "virtual"),
    lte(bookings.starts_at, new Date(now.getTime() + BOOKINGS.videoJoinEarlyMinutes * MIN)), gt(bookings.ends_at, now),
  )).limit(BATCH);
  for (const { id } of opening) {
    try {
      if (!(await claimNotice(id, "join_link"))) continue;
      const b = await getBookingForSession(id);
      if (!b) continue;
      await notices.joinLinkToBuyer(b, sessionUrlFor(b, now));
      // A private group's friends get the same reminder with their own links (0153).
      if (b.audience === "private_group") {
        for (const g of await liveGuests(b.id)) await notices.joinLinkToGuest(b, g.email, guestSessionUrlFor(g.id, b, now));
      }
      // An open group is one session for her: her reminder and push go out once per time, not once per fan.
      if (b.audience !== "open_group" || !(await slotNoticeAlreadySent(b.slotId, "join_link", b.id))) {
        await notices.joinOpensToAthlete(b);
        pushBooking({ id: b.id, athlete_id: b.athleteId, title: b.title, buyer_name: b.buyerDisplayName }, "join_now");
      }
      r.joinNotices++;
    } catch (err: any) { logger.warn({ bookingId: id, error: err.message }, "join notice failed"); }
  }

  // 2. Grace check on Nomila video calls (a pasted link or in person leaves no attendance to read).
  const graceCutoff = new Date(now.getTime() - BOOKINGS.noShowGraceMinutes * MIN);
  const started = await db.select({ id: bookings.id }).from(bookings).where(and(
    inArray(bookings.status, ["confirmed", "in_review", "issue_reported"]), eq(bookings.location_mode, "virtual"),
    lte(bookings.starts_at, graceCutoff), gt(bookings.ends_at, new Date(now.getTime() - HOUR)),
    or(isNull(bookings.meeting_mode), eq(bookings.meeting_mode, "livekit")),
  )).limit(BATCH);
  for (const { id } of started) {
    try {
      if (await hasEvent(id, "attendance", "check", "grace_elapsed")) continue;
      const b = await getBookingForSession(id);
      if (!b || !usesLivekit(b)) continue;
      const a = await attendanceSummary(id);
      // 0154: NO LiveKit attendance at all on this booking (nobody's joined / left reached us) is not evidence that
      // anyone stayed away — the webhook may simply not have arrived. Record "attendance_unknown" and tell neither side
      // the other didn't show. A side that tapped Join (join_tapped, weak evidence) is never told about as absent.
      const unknown = !a.evidence;
      await recordBookingEvent(id, "attendance", "system", {
        check: "grace_elapsed", result: unknown ? "attendance_unknown" : "seen",
        athleteJoined: a.athleteJoined, buyerJoined: a.buyerJoined, athleteTapped: a.athleteTapped, partyTapped: a.partyTapped,
        ...(b.audience === "private_group" ? { guestsJoined: a.guestsJoined, partyJoined: a.partyJoined } : {}),
      });
      r.graceChecks++;
      if (unknown) { r.attendanceUnknown++; continue; }
      if (!a.athleteJoined && !a.athleteTapped) await notices.athleteNotJoinedToBuyer(b, sessionUrlFor(b, now));
      // A private group showed up if the booker OR any friend joined. One fan missing from an open group is not worth
      // an email to her (the others are there); "Buyer didn't show" is still on that fan's booking.
      if (!a.partyJoined && !a.partyTapped && b.audience !== "open_group") await notices.buyerNotJoinedToAthlete(b);
    } catch (err: any) { logger.warn({ bookingId: id, error: err.message }, "grace check failed"); }
  }

  // 3. After the end: into review on the release clock, and "How did it go?".
  const ended = await db.select({ id: bookings.id, status: bookings.status, endsAt: bookings.ends_at, releaseDueAt: bookings.release_due_at }).from(bookings).where(and(
    inArray(bookings.status, ["confirmed", "in_review", "issue_reported"]), lte(bookings.ends_at, now),
    or(eq(bookings.status, "confirmed"), isNull(bookings.release_due_at)),
  )).limit(BATCH);
  for (const row of ended) {
    try {
      const due = row.releaseDueAt ?? releaseDueAt(row.endsAt!);
      if (row.status === "confirmed") {
        try {
          await transition({ bookingId: row.id, from: "confirmed", to: "in_review", actor: "system", patch: { release_due_at: due }, data: { release_due_at: due.toISOString() } });
          r.movedToReview++;
        } catch (err) {
          if (!(err instanceof TransitionError)) throw err;   // moved by a tap in the meantime: nothing to do
        }
      } else {
        // issue_reported with no clock yet: the clock is a non-status column (a reviewer's "no action" resumes it).
        await db.update(bookings).set({ release_due_at: due, updated_at: now }).where(and(eq(bookings.id, row.id), isNull(bookings.release_due_at)));
      }
      const b = await getBookingForSession(row.id);
      if (b && !b.buyerConfirmedAt && b.status !== "issue_reported" && (await claimNotice(row.id, "how_did_it_go"))) {
        await notices.howDidItGoToBuyer(b, sessionUrlFor(b, now));
      }
    } catch (err: any) { logger.warn({ bookingId: row.id, error: err.message }, "after-session step failed"); }
  }

  // 4. In-person check-in nudge.
  const inPerson = await db.select({ id: bookings.id }).from(bookings).where(and(
    inArray(bookings.status, ["confirmed", "in_review", "issue_reported", "released"]), eq(bookings.location_mode, "in_person"),
    lte(bookings.ends_at, new Date(now.getTime() - 30 * MIN)), gt(bookings.ends_at, new Date(now.getTime() - 24 * HOUR)),
  )).limit(BATCH);
  for (const { id } of inPerson) {
    try {
      if (await lastCheckIn(id)) continue;
      if (!(await claimNotice(id, "checkin_nudge"))) continue;
      const b = await getBookingForSession(id);
      if (b) { await notices.checkinNudgeToAthlete(b); r.checkinNudges++; }
    } catch (err: any) { logger.warn({ bookingId: id, error: err.message }, "check-in nudge failed"); }
  }

  // 5. Release: the buyer said it happened, or the window passed with nothing open (incl. a reviewer's "release",
  //    which makes it due now, and a late buyer cancel, which is still paid on the clock). The gate re-checks it all.
  const due = await db.select({ id: bookings.id, status: bookings.status, confirmed: bookings.buyer_confirmed_at }).from(bookings).where(and(
    or(
      and(eq(bookings.status, "in_review"), or(isNotNull(bookings.buyer_confirmed_at), lte(bookings.release_due_at, now))),
      and(eq(bookings.status, "confirmed"), isNotNull(bookings.buyer_confirmed_at)),
      and(eq(bookings.status, "canceled"), eq(bookings.canceled_by, "buyer"), eq(bookings.refund_outcome, "none"),
        isNull(bookings.released_at), lte(bookings.release_due_at, now)),
    ),
    sql`${bookings.no_show_by} IS DISTINCT FROM 'athlete'`,
    sql`NOT EXISTS (SELECT 1 FROM booking_reports br WHERE br.booking_id = ${bookings.id} AND br.status IN ('open','in_review'))`,
  )).limit(BATCH);
  for (const row of due) {
    const cause = row.confirmed && row.status !== "canceled" ? "buyer_confirmed" : "release_window";
    const g = await releaseIfAllowed(row.id, cause, now).catch((err: any) => {
      logger.warn({ bookingId: row.id, error: err.message }, "release gate threw");
      return { outcome: "release_pending" as const };
    });
    if (g.outcome === "released") r.released++;
    else if (g.outcome === "release_pending") r.releasePending++;
  }

  logger.info({ ...r }, "booking session sweep complete");
  return r;
}

/** Exposed for tests: the attendance + notice events of one booking, oldest first. */
export async function sessionEvents(bookingId: string) {
  return db.select().from(bookingEvents).where(eq(bookingEvents.booking_id, bookingId)).orderBy(bookingEvents.at);
}
