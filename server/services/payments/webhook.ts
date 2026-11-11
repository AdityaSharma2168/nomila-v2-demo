/**
 * webhook.ts — Stripe webhook dispatch + idempotency ledger.
 *
 * Signature is verified by the route (server/routes/webhooks.ts) before we get
 * here. Every delivery is CLAIMED in payment_events, and the claim only counts as
 * done once the handler succeeded (processed_at is set last):
 *
 *   - a new event id inserts a row and is processed;
 *   - a redelivery of an event that was PROCESSED is a no-op (duplicate);
 *   - a redelivery of an event whose earlier attempt threw (processed_at still NULL)
 *     is reclaimed and processed again — so a handler failure → 500 → Stripe retry
 *     actually reprocesses instead of being acknowledged as a duplicate.
 *
 * Handlers must therefore be idempotent: every state change is status-guarded and
 * every Stripe write carries an idempotency key.
 */

import type Stripe from "stripe";
import { eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { paymentEvents } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { syncConnectAccountFromStripe } from "./connect";
import {
  handleCheckoutSessionCompleted,
  handleCheckoutAsyncPaymentFailed,
  handleCheckoutSessionExpired,
  handleDealPaymentSucceeded,
  handleDealPaymentFailed,
  handleDealPaymentCanceled,
  handleDealChargeSucceeded,
} from "./escrow";
import { handleTransferCreated, releaseDuePayments } from "./settle";
import { handleDepositCheckoutCompleted, handleDepositCanceled } from "./deposit";
import {
  handleBookingCheckoutCompleted,
  handleBookingDisputeClosed,
  handleBookingDisputeCreated,
  handleBookingPaymentIntentCanceled,
} from "../bookings/charges";
import { handleIdentityEvent } from "../bookings/identity";
import {
  handleChargeRefunded,
  handleDisputeCreated,
  handleDisputeUpdated,
  handleDisputeClosed,
  handleTransferReversed,
} from "./refund";

const logger = createLogger("payments/webhook");

export async function processStripeEvent(event: Stripe.Event): Promise<{ duplicate: boolean }> {
  // Claim the event id. A conflicting row is reclaimed only while it is still
  // unprocessed (an earlier attempt threw); a processed row returns nothing → duplicate.
  const payload = event as unknown as Record<string, unknown>;
  const claimed = await db
    .insert(paymentEvents)
    .values({ id: event.id, type: event.type, payload })
    .onConflictDoUpdate({
      target:   paymentEvents.id,
      set:      { payload },
      setWhere: isNull(paymentEvents.processed_at),
    })
    .returning({ id: paymentEvents.id });

  if (claimed.length === 0) {
    logger.debug({ eventId: event.id, type: event.type }, "duplicate Stripe event (already processed) — ignored");
    return { duplicate: true };
  }

  switch (event.type) {
    case "account.updated": {
      const synced = await syncConnectAccountFromStripe(event.data.object as Stripe.Account);
      // Onboarding just completed → release anything that was waiting on her payout account.
      // A release failure is recorded on the payment and retried by the sweep; it must not
      // fail (and endlessly redeliver) the account event.
      if (synced?.payoutReady) {
        await releaseDuePayments(new Date(), synced.athleteId).catch((err: any) =>
          logger.warn({ athleteId: synced.athleteId, error: err.message }, "release after account.updated failed — sweep will retry"));
      }
      break;
    }

    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.metadata?.kind === "deposit") await handleDepositCheckoutCompleted(s);
      else if (s.metadata?.kind === "booking_payment") await handleBookingCheckoutCompleted(s);   // Bookings v2: hold placed / pay link paid
      else await handleCheckoutSessionCompleted(s);
      break;
    }
    case "checkout.session.expired":
      await handleCheckoutSessionExpired(event.data.object as Stripe.Checkout.Session);
      break;
    case "checkout.session.async_payment_failed":
      await handleCheckoutAsyncPaymentFailed(event.data.object as Stripe.Checkout.Session);
      break;

    case "payment_intent.succeeded":
      await handleDealPaymentSucceeded(event.data.object as Stripe.PaymentIntent);
      break;
    case "payment_intent.payment_failed":
      await handleDealPaymentFailed(event.data.object as Stripe.PaymentIntent);
      break;
    case "payment_intent.canceled": {
      const pi = event.data.object as Stripe.PaymentIntent;
      if (pi.metadata?.kind === "deposit") await handleDepositCanceled(pi);
      else if (pi.metadata?.kind === "booking_payment") await handleBookingPaymentIntentCanceled(pi);
      else await handleDealPaymentCanceled(pi);
      break;
    }
    case "charge.succeeded":
      await handleDealChargeSucceeded(event.data.object as Stripe.Charge);
      break;

    case "transfer.created":
      await handleTransferCreated(event.data.object as Stripe.Transfer);
      break;
    case "transfer.reversed":
      await handleTransferReversed(event.data.object as Stripe.Transfer);
      break;

    // Refunds + chargebacks: recorded only — money moved by Stripe or by a tapped action.
    case "charge.refunded":
      await handleChargeRefunded(event.data.object as Stripe.Charge);
      break;
    case "charge.dispute.created":
      await handleDisputeCreated(event.data.object as Stripe.Dispute);
      await handleBookingDisputeCreated(event.data.object as Stripe.Dispute);   // no-op unless the charge is a booking's
      break;
    case "charge.dispute.updated":
      await handleDisputeUpdated(event.data.object as Stripe.Dispute);
      break;
    case "charge.dispute.closed":
      await handleDisputeClosed(event.data.object as Stripe.Dispute);
      await handleBookingDisputeClosed(event.data.object as Stripe.Dispute);
      break;

    // Bookings v2: the buyer's ID + selfie check (Stripe Identity) for in-person bookings.
    case "identity.verification_session.verified":
    case "identity.verification_session.requires_input":
    case "identity.verification_session.canceled":
      await handleIdentityEvent(event.data.object as Stripe.Identity.VerificationSession);
      break;

    default:
      logger.info({ eventId: event.id, type: event.type }, "Stripe event received (no handler)");
  }

  // Only now is the event done — a throw above leaves processed_at NULL so the retry reprocesses.
  await db
    .update(paymentEvents)
    .set({ processed_at: new Date() })
    .where(eq(paymentEvents.id, event.id));

  return { duplicate: false };
}
