/**
 * bookingRelease.ts — release a booking's held payment to her: the booking twin of settleDealPayment (settle.ts), on
 * the same Separate Charges & Transfers path.
 *
 * The buyer's all-in total sits in the platform balance (payments.kind 'booking_payment', status 'funded'). Release
 * transfers HER PRICE (bookings.price_cents; she receives 100% of it, less only card fees she owes) to her
 * Connect account, sourced from the buyer's charge so it never draws on the available balance while funds are still
 * pending. The service fee stays on the platform balance.
 *
 * Same safety as the deal path: payout-gated (assertPayoutReady throws CONNECT_REQUIRED and the payment stays funded
 * for the sweep to retry), an idempotency key, and an earlier transfer for this payment is ADOPTED instead of paying
 * twice (the key alone only protects for 24h). A failure is recorded in payments.failure_reason, never swallowed.
 *
 * WHO MAY CALL THIS: only services/bookings/session/releaseGate.ts, which decides WHETHER a booking may be released
 * (the buyer's "It happened", or end + 48h with nothing open). paymentsTapOnly.test.ts enforces that.
 *
 * The netting of owed card fees is decided by the gate (bookings/charges.ts nettingForRelease / markCardFeesRecovered).
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { payments } from "../../../shared/schema";
import { getStripe } from "../../lib/stripe";
import { createLogger } from "../../logger";
import { assertPayoutReady } from "./connect";

const logger = createLogger("payments/bookingRelease");

export interface BookingReleaseResult { paymentId: string; transferId: string | null; adopted: boolean; amountCents: number }

/**
 * Transfer `amountCents` for one booking: her price, less any card fees she owes (the gate computes it with
 * bookings/charges.ts nettingForRelease). Idempotent: a payment already settled answers with its transfer. When the
 * fees take the whole payout (0), the payment is settled with no transfer. Throws a coded error when the money cannot
 * move yet (NO_PAYMENT, NOT_FUNDED, CHARGE_UNKNOWN, CONNECT_REQUIRED, or Stripe's own).
 */
export async function releaseBookingPayment(bookingId: string, amountCents: number): Promise<BookingReleaseResult> {
  if (!Number.isInteger(amountCents) || amountCents < 0) throw coded("BAD_AMOUNT");
  const [p] = await db.select().from(payments)
    .where(and(eq(payments.booking_id, bookingId), eq(payments.kind, "booking_payment"))).limit(1);
  if (!p) throw coded("NO_PAYMENT");
  if (p.status === "settled") return { paymentId: p.id, transferId: p.stripe_transfer_id ?? null, adopted: true, amountCents };
  if (p.status !== "funded") throw coded("NOT_FUNDED", { status: p.status });

  if (amountCents === 0) {
    await db.update(payments).set({ status: "settled", failure_reason: null, updated_at: new Date() })
      .where(and(eq(payments.id, p.id), eq(payments.status, "funded")));
    logger.info({ bookingId, paymentId: p.id }, "booking payment settled with no transfer (card fees owed took the payout)");
    return { paymentId: p.id, transferId: null, adopted: false, amountCents: 0 };
  }

  try {
    const acct = await assertPayoutReady(p.athlete_id);
    const stripe = getStripe();
    let chargeId = p.stripe_charge_id;
    if (!chargeId && p.stripe_payment_intent_id) {
      const pi = await stripe.paymentIntents.retrieve(p.stripe_payment_intent_id);
      chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
      if (chargeId) await db.update(payments).set({ stripe_charge_id: chargeId, updated_at: new Date() }).where(eq(payments.id, p.id));
    }
    if (!chargeId) throw coded("CHARGE_UNKNOWN");

    const since = p.created_at ? Math.floor(p.created_at.getTime() / 1000) - 60 : undefined;
    const prior = await stripe.transfers.list({ destination: acct.stripe_account_id, limit: 100, ...(since ? { created: { gte: since } } : {}) });
    const existing = prior.data.find((t) => t.metadata?.payment_id === p.id && t.metadata?.kind === "booking_release");
    const transfer = existing ?? await stripe.transfers.create(
      {
        amount:             amountCents,
        currency:           p.currency,
        destination:        acct.stripe_account_id,
        source_transaction: chargeId,
        metadata:           { kind: "booking_release", payment_id: p.id, booking_id: bookingId },
      },
      { idempotencyKey: `booking_release_${p.id}` },
    );

    await db.update(payments).set({
      status:                 "settled",
      stripe_transfer_id:     transfer.id,
      destination_account_id: acct.stripe_account_id,
      failure_reason:         null,
      updated_at:             new Date(),
    }).where(and(eq(payments.id, p.id), eq(payments.status, "funded")));
    logger.info({ bookingId, paymentId: p.id, transferId: transfer.id, amount: amountCents, adopted: !!existing }, "booking payment released to athlete");
    return { paymentId: p.id, transferId: transfer.id, adopted: !!existing, amountCents };
  } catch (err: any) {
    await db.update(payments).set({ failure_reason: `release_failed:${err.code ?? "ERROR"}`, updated_at: new Date() })
      .where(and(eq(payments.id, p.id), eq(payments.status, "funded")));
    throw err;
  }
}

function coded(code: string, detail?: unknown): Error & { code: string; detail?: unknown } {
  const err = new Error(code) as Error & { code: string; detail?: unknown };
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}
