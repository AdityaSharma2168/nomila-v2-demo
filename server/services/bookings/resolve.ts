/**
 * bookings/resolve.ts — a person at Nomila resolves an open report (the trust-and-safety queue, booking_reports).
 * Reached only from the admin route (requireAdmin). Never from Mila, never from a sweep.
 *
 *   release              nothing wrong: the report closes and her payment is due NOW — the one release path (#868's
 *                        session sweep → releaseGate) sends it on its next run; this file never transfers
 *   no_action            close the report; the booking goes back on its own release clock
 *   refund_athlete_no_show  she didn't show: the buyer gets everything back, she covers Stripe's actual fee (first free),
 *                        and at BOOKING_NO_SHOW_PAUSE_THRESHOLD (2) no-shows her published offers pause for review
 *   refund_full          the buyer gets everything back (Nomila's decision; no card fee on her)
 */
import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { bookingReports, bookings, offers } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { BOOKINGS } from "./config";
import { coded } from "./common";
import { notices } from "./notices";
import { recordBookingEvent, transition } from "./stateMachine";
import { paymentFor, recordAthleteRefundCost, refundBookingPayment } from "./charges";

const logger = createLogger("bookings/resolve");

export type Resolution = "release" | "no_action" | "refund_athlete_no_show" | "refund_full";
export const RESOLUTIONS: readonly Resolution[] = ["release", "no_action", "refund_athlete_no_show", "refund_full"];

export async function resolveBookingIssue(bookingId: string, resolution: Resolution, note: string | null, now = new Date()): Promise<{ status: string; paused?: boolean }> {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!b) throw coded("NOT_FOUND");
  if (b.status !== "issue_reported") throw coded("WRONG_STATE", { status: b.status });
  const reportResolution = resolution === "release" ? "release" : resolution === "no_action" ? "no_action" : "refund";
  await db.update(bookingReports).set({ status: "resolved", resolution: reportResolution, resolution_note: note?.slice(0, 1_000) ?? null, resolved_at: now })
    .where(and(eq(bookingReports.booking_id, bookingId), inArray(bookingReports.status, ["open", "in_review"])));

  if (resolution === "release" || resolution === "no_action") {
    const due = resolution === "release" ? now : (b.release_due_at && b.release_due_at > now ? b.release_due_at : now);
    const row = await transition({ bookingId, from: "issue_reported", to: "in_review", actor: "admin", patch: { release_due_at: due }, data: { resolution } });
    return { status: row.status };
  }

  const p = await paymentFor(bookingId);
  if (!p) throw coded("NO_PAYMENT");
  await refundBookingPayment(p, b.buyer_total_cents, "admin", note ?? resolution);
  let paused = false;
  if (resolution === "refund_athlete_no_show") {
    await recordAthleteRefundCost(b, (await paymentFor(bookingId))!);
    await transition({
      bookingId, from: "issue_reported", to: "refunded", actor: "admin",
      patch: { no_show_by: "athlete", no_show_marked_at: now, refund_outcome: "full", canceled_by: "admin", canceled_at: now },
      data: { resolution },
    });
    await recordBookingEvent(bookingId, "no_show", "admin", { by: "athlete" });
    paused = await pauseAfterNoShows(b.athlete_id);
  } else {
    await transition({ bookingId, from: "issue_reported", to: "refunded", actor: "admin", patch: { refund_outcome: "full", canceled_by: "admin", canceled_at: now }, data: { resolution } });
  }
  return { status: "refunded", paused };
}

/** At the threshold of athlete no-shows, every published offer pauses for support review ('no_show_review'). */
export async function pauseAfterNoShows(athleteId: string): Promise<boolean> {
  const [r] = await db.select({ n: count() }).from(bookings).where(and(eq(bookings.athlete_id, athleteId), eq(bookings.no_show_by, "athlete")));
  if ((r?.n ?? 0) < BOOKINGS.noShowPauseThreshold) return false;
  const changed = await db.update(offers).set({ status: "paused", paused_reason: "no_show_review", updated_at: new Date() })
    .where(and(eq(offers.athlete_id, athleteId), inArray(offers.status, ["published", "paused"]))).returning({ id: offers.id });
  if (changed.length) {
    logger.warn({ athleteId, offers: changed.length }, "offers paused after missed sessions — support review");
    await notices.offersPaused(athleteId);
  }
  return changed.length > 0;
}
