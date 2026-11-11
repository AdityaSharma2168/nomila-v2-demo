/**
 * releaseGate.ts — the ONE place that decides whether a booking's money may go to her, and the only caller of the
 * booking transfer (payments/bookingRelease.ts; paymentsTapOnly.test.ts holds that).
 *
 * The rule (owner, 7 Oct 2026), all of it, nothing else:
 *   - the BUYER tapped "It happened" (cause 'buyer_confirmed'): confirmed | in_review → released, now; or
 *   - release_due_at has passed (cause 'release_window'): in_review → released (actor system). release_due_at is end +
 *     BOOKING_RELEASE_HOURS, or NOW after a reviewer's "release" resolution (resolve.ts closes the report and moves the
 *     booking back to in_review due now; the session sweep then sends it); or
 *   - a LATE BUYER CANCEL (status canceled by the buyer, refund_outcome 'none', no refund): she is still paid on the
 *     clock, so at release_due_at the money goes to her; the status stays canceled (a terminal state) and released_at
 *     records the payout;
 *   - AND always: no booking_reports row open or in review, and she was not found to be the no-show.
 * Attendance never appears here. Her "Session done" never appears here.
 *
 * What is sent: her price less any card fees she owes from an earlier athlete-caused refund (charges.ts
 * nettingForRelease), and those fees are marked recovered against this payment after the transfer
 * (markCardFeesRecovered). The status move goes through the state machine's transition().
 *
 * Ordering: the checks, then the (idempotent, adopt-if-exists) transfer, then the status move, which applies only if
 * the booking is still where it was read. No transaction is held across the Stripe call. The one race left — a report
 * filed in the milliseconds between the check and the transfer — ends with the money released and the booking
 * issue_reported; that is logged loudly and recorded as a payment event, and the reviewer resolves it with the admin
 * transfer reversal. A transfer that cannot happen yet (no payout account, a Stripe error) leaves the booking as it
 * was; the session sweep retries it.
 */

import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { bookings } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import { releaseBookingPayment } from "../../payments/bookingRelease";
import { hasOpenReport, markCardFeesRecovered, nettingForRelease } from "../charges";
import { recordBookingEvent, transition, TransitionError, type BookingStatus } from "../stateMachine";
import { pushBooking } from "../push";

const logger = createLogger("bookings/releaseGate");

export type ReleaseCause = "buyer_confirmed" | "release_window";
export interface GateResult { outcome: "released" | "release_pending" | "blocked"; reason?: string; transferId?: string | null }

type Check = { reason: string } | { reason: null; status: BookingStatus; lateCancel: boolean };

async function check(bookingId: string, cause: ReleaseCause, now: Date): Promise<Check> {
  const [b] = await db.select({
    status: bookings.status, buyerConfirmedAt: bookings.buyer_confirmed_at, releaseDueAt: bookings.release_due_at,
    releasedAt: bookings.released_at, noShowBy: bookings.no_show_by, canceledBy: bookings.canceled_by, refundOutcome: bookings.refund_outcome,
  }).from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!b) return { reason: "not_found" };
  if (b.status === "released" || b.releasedAt) return { reason: "already_released" };
  const lateCancel = b.status === "canceled" && b.canceledBy === "buyer" && b.refundOutcome === "none";
  if (b.status !== "confirmed" && b.status !== "in_review" && !lateCancel) return { reason: `status_${b.status}` };
  if (b.noShowBy === "athlete") return { reason: "athlete_no_show" };
  if (await hasOpenReport(bookingId)) return { reason: "issue_open" };
  if (cause === "buyer_confirmed" && (lateCancel || !b.buyerConfirmedAt)) return { reason: "not_confirmed" };
  if (cause === "release_window") {
    if (b.status === "confirmed") return { reason: "not_in_review" };      // the sweep moves it to in_review at the end first
    if (!b.releaseDueAt || b.releaseDueAt > now) return { reason: "not_due" };
  }
  return { reason: null, status: b.status as BookingStatus, lateCancel };
}

/** "You've been paid" on her phone, once the transfer went (best-effort, never undoes the release). */
async function pushPaid(bookingId: string, amountCents: number): Promise<void> {
  try {
    const [b] = await db.select({ id: bookings.id, athlete_id: bookings.athlete_id, title: bookings.title, buyer_name: bookings.buyer_name })
      .from(bookings).where(eq(bookings.id, bookingId)).limit(1);
    if (b) pushBooking(b, "paid", { amountCents });
  } catch { /* a notification never undoes a release */ }
}

export async function releaseIfAllowed(bookingId: string, cause: ReleaseCause, now: Date = new Date()): Promise<GateResult> {
  const c = await check(bookingId, cause, now);
  if (c.reason === "already_released") return { outcome: "released" };
  if (c.reason !== null) return { outcome: "blocked", reason: c.reason };

  const netting = await nettingForRelease(bookingId);
  if (!netting) return { outcome: "blocked", reason: "not_found" };

  let paymentId: string, transferId: string | null;
  try {
    ({ paymentId, transferId } = await releaseBookingPayment(bookingId, netting.netCents));
  } catch (err: any) {
    logger.warn({ bookingId, cause, code: err.code, error: err.message }, "booking release not possible yet — the session sweep will retry");
    return { outcome: "release_pending", reason: String(err.code ?? "error") };
  }
  await markCardFeesRecovered(netting, paymentId);
  await recordBookingEvent(bookingId, "payment", "system", {
    released: true, cause, transfer_id: transferId, amount_cents: netting.netCents, card_fees_cents: netting.feeCents,
  });

  if (c.lateCancel) {
    // canceled is terminal: no status move; released_at records that her payout went.
    await db.update(bookings).set({ released_at: now, updated_at: now }).where(eq(bookings.id, bookingId));
    logger.info({ bookingId, transferId }, "late buyer cancel — paid on the clock");
    await pushPaid(bookingId, netting.netCents);
    return { outcome: "released", transferId };
  }
  try {
    await transition({
      bookingId, from: c.status, to: "released", actor: cause === "buyer_confirmed" ? "buyer" : "system",
      patch: { released_at: now }, data: { cause },
    });
  } catch (err) {
    if (!(err instanceof TransitionError)) throw err;
    logger.error({ bookingId, transferId, current: err.current }, "booking money released while a report was being filed — needs review (admin reversal)");
    return { outcome: "released", transferId, reason: "raced_report" };
  }
  logger.info({ bookingId, cause, transferId }, "booking released");
  await pushPaid(bookingId, netting.netCents);
  return { outcome: "released", transferId };
}
