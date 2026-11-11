/**
 * bookings/sweeper.ts — the bookings clock (POST /api/internal/bookings-cron, every 5 minutes; Cloud Scheduler job
 * `bookings-cron`, scripts/provision-schedulers.sh). Answers { skipped: true } while BOOKINGS_ENABLED is off, so the job
 * is inert until the flag flips.
 *
 *   1  unverified past its 15-minute hold      → expired; any open hold Checkout closed (the slot reopens)
 *   2  never-verified requests older than 24h  → deleted (no payment row) or the buyer's data redacted (it was never real)
 *   3  requested past respond_by (72h)         → expired; the card hold RELEASED; the buyer told
 *      accepted, capture still pending, past respond_by → expired; the hold released
 *   4  accepted (pay link) past pay_by         → expired; the pay link closed
 *   7  retries: holds left on closed bookings are released; failed refunds are retried
 *   8  an issue still open 80 days after the charge alerts support (the platform hold limit is 90)
 *
 * The session's own clock — the join notice, session end → in_review + "How did it go?", and the release with nothing
 * open — is the session sweep of #868 (session/sessionSweep.ts → releaseGate.ts), the ONE release path. This sweep never
 * moves money to her. Attendance never moves money anywhere. Every step is status-guarded (the state machine), so a run that overlaps a tap or
 * another instance changes nothing twice.
 */
import { and, eq, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { bookingEvents, bookingGuests, bookingMessages, bookings, payments } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { BOOKINGS } from "./config";
import { notices } from "./notices";
import { claimNotice, slotNoticeAlreadySent } from "./session/sessionStore";
import { transition, TransitionError, TERMINAL_STATUSES, type BookingStatus } from "./stateMachine";
import { cancelQuote, daysSince } from "./clocks";
import { autoConfirmOpenGroup, cancelHold, paymentFor, recordAthleteRefundCost, refundBookingPayment } from "./charges";
import { redactGuests } from "./guests";

const logger = createLogger("bookings/sweeper");
const MIN = 60_000, HOUR = 3_600_000;

export interface BookingsCronResult {
  skipped?:    boolean;
  lapsed:      number;
  purged:      number;
  expired:     number;
  holdsReleased: number;
  refundsRetried: number;
  alerts:      number;
  /** Bookings PR3: "expires in about 12 hours" to her, and "tomorrow" to both sides — each once per booking. */
  reminders?:  number;
  /** 0153: open-group spots confirmed on a retry of their capture. */
  groupConfirmed?: number;
  errors:      number;
}

async function step<T>(label: string, rows: T[], f: (r: T) => Promise<boolean>, res: BookingsCronResult, key: keyof BookingsCronResult): Promise<void> {
  for (const r of rows) {
    try { if (await f(r)) (res[key] as number)++; }
    catch (err: any) {
      if (err instanceof TransitionError) continue;   // someone else moved it first — correct
      res.errors++;
      logger.warn({ step: label, error: err.message }, "bookings sweep step failed — retried next run");
    }
  }
}

export async function runBookingsCron(now: Date = new Date()): Promise<BookingsCronResult> {
  const res: BookingsCronResult = { lapsed: 0, purged: 0, expired: 0, holdsReleased: 0, refundsRetried: 0, alerts: 0, errors: 0 };
  if (!BOOKINGS.enabled) return { ...res, skipped: true };

  // 1 — the unverified hold lapsed.
  const lapsed = await db.select().from(bookings).where(and(
    eq(bookings.status, "unverified"), lte(bookings.created_at, new Date(now.getTime() - BOOKINGS.unverifiedHoldMinutes * MIN))));
  await step("lapse", lapsed, async (b) => {
    const open = await paymentFor(b.id);
    if (open?.status === "pending" && open.checkout_expires_at && open.checkout_expires_at > now) return false;   // on Stripe's page right now
    await transition({ bookingId: b.id, from: "unverified", to: "expired", actor: "system", data: { lapsed: "unverified_hold" } });
    const p = await paymentFor(b.id);
    if (p) await cancelHold(p, "unverified_lapsed", "expired");
    return true;
  }, res, "lapsed");

  // 2 — never-verified requests are not kept.
  const stale = await db.select({ id: bookings.id }).from(bookings).where(and(
    eq(bookings.status, "expired"), isNull(bookings.respond_by), isNull(bookings.buyer_redacted_at),
    lte(bookings.created_at, new Date(now.getTime() - BOOKINGS.unverifiedPurgeHours * HOUR))));
  await step("purge", stale, async ({ id }) => {
    const p = await paymentFor(id);
    if (!p) {
      await db.transaction(async (tx) => {
        await tx.delete(bookingEvents).where(eq(bookingEvents.booking_id, id));
        await tx.delete(bookingGuests).where(eq(bookingGuests.booking_id, id));
        await tx.delete(bookingMessages).where(eq(bookingMessages.booking_id, id));
        await tx.delete(bookings).where(eq(bookings.id, id));
      });
    } else {
      await db.update(bookings).set({
        buyer_name: "Removed", buyer_email: "removed@invalid", buyer_phone: null, buyer_message: null, proposed_note: null,
        minor_first_name: null, otp_hash: null, buyer_redacted_at: now, updated_at: now,
      }).where(eq(bookings.id, id));
      await redactGuests(id, now);
    }
    return true;
  }, res, "purged");

  // 2b — an open group spot whose capture Stripe didn't answer (0153): try again (until respond_by, step 3).
  const pendingSpots = await db.select({ id: bookings.id }).from(bookings).where(and(
    eq(bookings.status, "requested"), eq(bookings.audience, "open_group"), eq(bookings.approve_each_spot, false),
    sql`${bookings.respond_by} > ${now.toISOString()}::timestamptz`));
  res.groupConfirmed = 0;
  await step("open_group_confirm", pendingSpots, async ({ id }) => (await autoConfirmOpenGroup(id, now)) === "confirmed", res, "groupConfirmed");

  // 3 — her answer didn't come: the hold is released.
  const unanswered = await db.select().from(bookings).where(and(inArray(bookings.status, ["requested", "accepted"]), lte(bookings.respond_by, now)));
  await step("respond_by", unanswered, async (b) => {
    const p = await paymentFor(b.id);
    if (b.status === "accepted" && p?.status !== "authorized") return false;   // a pay-link wait has its own clock (4)
    const row = await transition({ bookingId: b.id, from: b.status as BookingStatus, to: "expired", actor: "system", data: { lapsed: "respond_by" } });
    if (p) await cancelHold(p, "respond_by", "expired");
    await notices.expired(row);
    return true;
  }, res, "expired");

  // 4 — the pay link after a failed capture ran out.
  const unpaid = await db.select().from(bookings).where(and(eq(bookings.status, "accepted"), lte(bookings.pay_by, now)));
  await step("pay_by", unpaid, async (b) => {
    const p = await paymentFor(b.id);
    if (p?.status === "authorized") return false;
    const row = await transition({ bookingId: b.id, from: "accepted", to: "expired", actor: "system", data: { lapsed: "pay_by" } });
    if (p) await cancelHold(p, "pay_by", "expired");
    await notices.expiredUnpaid(row);
    return true;
  }, res, "expired");

  // 7a — a hold or an open hold Checkout left on a closed booking.
  const orphans = await db.select({ p: payments, status: bookings.status }).from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.booking_id))
    .where(and(eq(payments.kind, "booking_payment"), inArray(payments.status, ["authorized", "pending"]), inArray(bookings.status, [...TERMINAL_STATUSES])));
  await step("orphan_hold", orphans, async ({ p }) => cancelHold(p, "closed_booking"), res, "holdsReleased");

  // 7b — a refund Stripe refused earlier (the booking is canceled with a refund owed, the payment still funded).
  const owedRefunds = await db.select({ b: bookings, p: payments }).from(bookings)
    .innerJoin(payments, eq(payments.booking_id, bookings.id))
    .where(and(eq(bookings.status, "canceled"), inArray(bookings.refund_outcome, ["full", "price_only"]), eq(payments.status, "funded")));
  await step("refund_retry", owedRefunds, async ({ b, p }) => {
    const q = cancelQuote(b, b.canceled_by === "athlete" ? "athlete" : "buyer", b.canceled_at ?? now);
    const amount = b.refund_outcome === "full" ? b.buyer_total_cents : b.price_cents;
    await refundBookingPayment(p, amount || q.refundCents, b.canceled_by === "athlete" ? "athlete" : "buyer", "retry");
    if (b.canceled_by === "athlete") await recordAthleteRefundCost(b, (await paymentFor(b.id))!);
    return true;
  }, res, "refundsRetried");

  // 8 — an issue still open near the platform hold limit.
  const held = await db.select({ b: bookings, p: payments }).from(bookings)
    .innerJoin(payments, eq(payments.booking_id, bookings.id))
    .where(and(inArray(bookings.status, ["issue_reported", "disputed"]), notInArray(payments.status, ["settled", "refunded", "charged_back"])));
  await step("alert_80d", held, async ({ b, p }) => {
    const chargedAt = b.confirmed_at ?? p.created_at ?? now;
    if (daysSince(chargedAt, now) < BOOKINGS.releaseAlertDays || (p.metadata as any)?.alerted_hold_limit) return false;
    logger.error({ alert: "BOOKING_HOLD_LIMIT", bookingId: b.id }, "a booking issue is still open near Stripe's platform hold limit");
    await notices.supportAlert(b, "Issue open near the 90-day hold limit", "Resolve it (release or refund) before day 90.");
    await db.update(payments).set({ metadata: sql`coalesce(${payments.metadata}, '{}'::jsonb) || '{"alerted_hold_limit": true}'::jsonb` }).where(eq(payments.id, p.id));
    return true;
  }, res, "alerts");

  // 9 — reminders (Bookings PR3): a request about to expire, and a session tomorrow. Once each (claimNotice).
  res.reminders = 0;
  const expiring = await db.select().from(bookings).where(and(eq(bookings.status, "requested"), sql`(${bookings.audience} <> 'open_group' OR ${bookings.approve_each_spot})`,
    sql`${bookings.respond_by} > ${now.toISOString()}::timestamptz AND ${bookings.respond_by} <= ${new Date(now.getTime() + 12 * HOUR).toISOString()}::timestamptz`));
  await step("remind_expiring", expiring, async (b) => {
    if (!(await claimNotice(b.id, "expiry_reminder"))) return false;
    await notices.expiringToAthlete(b);
    return true;
  }, res, "reminders");
  const tomorrow = await db.select().from(bookings).where(and(eq(bookings.status, "confirmed"),
    sql`${bookings.starts_at} > ${new Date(now.getTime() + 2 * HOUR).toISOString()}::timestamptz AND ${bookings.starts_at} <= ${new Date(now.getTime() + 24 * HOUR).toISOString()}::timestamptz`));
  await step("remind_tomorrow", tomorrow, async (b) => {
    if (!(await claimNotice(b.id, "tomorrow_reminder"))) return false;
    const herCopy = b.audience !== "open_group" || !(await slotNoticeAlreadySent(b.slot_id, "tomorrow_reminder", b.id));
    await notices.tomorrow(b, { athlete: herCopy });
    return true;
  }, res, "reminders");

  logger.info({ ...res }, "bookings sweep complete");
  return res;
}
