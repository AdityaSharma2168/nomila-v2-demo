/**
 * deposit.ts — the seriousness deposit (plan §5): a card AUTH HOLD (never captured — except a Serious-offer hold on a
 * public request, which seriousOffer.ts captures on her Agree tap)
 * a brand places to signal intent. It's independent of the deal payment — a pure
 * trust signal that boosts the deal's inbox ranking + "✓ Verified serious" badge
 * (deals.deposit_status = 'held'), released the moment the athlete accepts/declines
 * or the window expires.
 *
 * Card auths lapse ~7 days, so the hold is re-authorized once at ~day 6 to cover the
 * ~14-day window. Re-auth needs the saved card, so the deposit Checkout creates a
 * Stripe Customer + saves the PM off-session (the brand stays account-less in Nomila —
 * a Stripe Customer object is not a Nomila login).
 */

import type Stripe from "stripe";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { deals, payments } from "../../../shared/schema";
import { getStripe } from "../../lib/stripe";
import { createLogger } from "../../logger";
import { PAYMENTS } from "./config";
import { depositCancelUrl, depositReturnUrl } from "./urls";

const logger = createLogger("payments/deposit");
const DAY_MS = 86_400_000;

interface DepositMeta { customer_id?: string | null; payment_method_id?: string | null }

/** Find-or-create the pending deposit for a deal, then open a manual-capture Checkout (card-only hold). */
export async function createDepositCheckoutSession(dealId: string): Promise<{ url: string } | { error: string; status?: string }> {
  const [deal] = await db.select({ id: deals.id, brand: deals.brand_name, athleteId: deals.athlete_id })
    .from(deals).where(eq(deals.id, dealId)).limit(1);
  if (!deal) return { error: "not found" };

  const [existing] = await db.select().from(payments).where(and(eq(payments.deal_id, dealId), eq(payments.kind, "deposit"))).limit(1);
  if (existing && ["authorized", "reauthorized"].includes(existing.status)) return { error: "already placed", status: existing.status };

  const expiresAt = new Date(Date.now() + PAYMENTS.depositWindowDays * DAY_MS);
  let paymentId: string;
  if (existing) {
    paymentId = existing.id;
    await db.update(payments)
      .set({ status: "pending", brand_total_cents: PAYMENTS.depositHoldCents, currency: PAYMENTS.currency, expires_at: expiresAt, reauth_count: 0, updated_at: new Date() })
      .where(eq(payments.id, existing.id));
  } else {
    const [row] = await db.insert(payments).values({
      deal_id: dealId, athlete_id: deal.athleteId, kind: "deposit", status: "pending",
      brand_total_cents: PAYMENTS.depositHoldCents, currency: PAYMENTS.currency, expires_at: expiresAt,
    }).returning({ id: payments.id });
    paymentId = row.id;
  }

  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],           // holds are card-only
    customer_creation: "always",              // Customer + saved PM enables the day-6 re-auth
    line_items: [{ price_data: { currency: PAYMENTS.currency, product_data: { name: `Seriousness deposit — ${deal.brand}` }, unit_amount: PAYMENTS.depositHoldCents }, quantity: 1 }],
    payment_intent_data: {
      capture_method:     "manual",           // AUTH HOLD — never captured
      setup_future_usage: "off_session",      // save the PM so the hold can be re-authorized
      metadata:           { kind: "deposit", payment_id: paymentId, deal_id: dealId },
    },
    metadata:    { kind: "deposit", payment_id: paymentId, deal_id: dealId },
    success_url: depositReturnUrl(dealId),
    cancel_url:  depositCancelUrl(dealId),
  });

  await db.update(payments).set({ stripe_checkout_session_id: session.id, updated_at: new Date() }).where(eq(payments.id, paymentId));
  if (!session.url) return { error: "checkout unavailable" };
  return { url: session.url };
}

/** Webhook: checkout.session.completed for a deposit — the hold is placed (badge + ranking boost). */
export async function handleDepositCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  if (session.metadata?.kind !== "deposit") return;
  const paymentId = session.metadata.payment_id;
  if (!paymentId) return;

  const piId       = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  const brandEmail = session.customer_details?.email ?? null;

  // Retrieve the PI to capture the saved payment method (needed for the day-6 re-auth).
  let pmId: string | null = null;
  if (piId) {
    try {
      const pi = await getStripe().paymentIntents.retrieve(piId);
      pmId = typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id ?? null;
    } catch (err: any) {
      logger.warn({ paymentId, error: err.message }, "deposit PI retrieve failed — re-auth may be unavailable");
    }
  }

  const updated = await db.update(payments).set({
    status:                   "authorized",
    stripe_payment_intent_id: piId ?? undefined,
    brand_email:              brandEmail ?? undefined,
    metadata:                 { customer_id: customerId, payment_method_id: pmId } satisfies DepositMeta,
    updated_at:               new Date(),
  }).where(and(eq(payments.id, paymentId), eq(payments.status, "pending")))
    .returning({ dealId: payments.deal_id, requestId: payments.partner_request_id, amount: payments.brand_total_cents });

  if (updated.length === 0) { logger.info({ paymentId }, "deposit already processed — no-op"); return; }
  const { dealId, requestId, amount } = updated[0];
  if (dealId) await db.update(deals).set({ deposit_status: "held" }).where(eq(deals.id, dealId));
  // A Serious-offer hold on a request still being drafted: the visitor's "Add hold · send" tap — ask them to confirm by
  // email now (the request reaches her only after that link is opened). No deal exists yet.
  if (requestId) {
    const { sendHeldRequestForConfirmation } = await import("../partner/requests.js");
    await sendHeldRequestForConfirmation(requestId, amount ?? null);
  }
  logger.info({ paymentId, dealId, requestId }, "seriousness deposit held — ranking boost active");
}

type ReleaseReason = "accepted" | "declined" | "expired" | "canceled";

/** Release the hold (cancel the auth — never captured). Called on accept/decline/expiry. */
export async function releaseDeposit(dealId: string, reason: ReleaseReason): Promise<boolean> {
  const [p] = await db.select({ id: payments.id }).from(payments).where(and(eq(payments.deal_id, dealId), eq(payments.kind, "deposit"))).limit(1);
  return p ? releaseDepositPayment(p.id, reason) : false;
}

/**
 * Release one deposit hold by its payment id — a deal's seriousness deposit, or a Serious-offer hold on a public
 * request that may have no deal yet (payments.partner_request_id). Only a live hold is released; returns whether it was.
 */
export async function releaseDepositPayment(paymentId: string, reason: ReleaseReason): Promise<boolean> {
  const [p] = await db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.kind, "deposit"))).limit(1);
  if (!p || !["authorized", "reauthorized"].includes(p.status)) return false;

  if (p.stripe_payment_intent_id) {
    try { await getStripe().paymentIntents.cancel(p.stripe_payment_intent_id); }
    catch (err: any) { logger.warn({ paymentId, error: err.message }, "deposit PI cancel failed (may already be released)"); }
  }
  const terminal = reason === "expired" ? "expired" : "released";
  const released = await db.update(payments).set({ status: terminal, updated_at: new Date() })
    .where(and(eq(payments.id, p.id), inArray(payments.status, ["authorized", "reauthorized"]))).returning({ id: payments.id });
  if (!released.length) return false;
  if (p.deal_id) await db.update(deals).set({ deposit_status: terminal }).where(eq(deals.id, p.deal_id));
  logger.info({ paymentId, dealId: p.deal_id, requestId: p.partner_request_id, reason }, "seriousness deposit released");
  return true;
}

/** Day-6 re-auth: a fresh off-session manual-capture hold on the saved card, cancel the old one. */
export async function reauthorizeDeposit(paymentId: string): Promise<boolean> {
  const [p] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!p || p.kind !== "deposit" || p.status !== "authorized" || p.reauth_count > 0) return false;

  const meta = (p.metadata as DepositMeta | null) ?? {};
  if (!meta.customer_id || !meta.payment_method_id) { logger.warn({ paymentId }, "deposit re-auth: no saved PM/customer"); return false; }

  const pi = await getStripe().paymentIntents.create(
    {
      amount:         p.brand_total_cents ?? PAYMENTS.depositHoldCents,
      currency:       p.currency,
      customer:       meta.customer_id,
      payment_method: meta.payment_method_id,
      capture_method: "manual",
      confirm:        true,
      off_session:    true,
      metadata:       { kind: "deposit", payment_id: p.id, deal_id: p.deal_id, partner_request_id: p.partner_request_id },
    },
    { idempotencyKey: `reauth_${p.id}` },
  );

  const oldPi = p.stripe_payment_intent_id;
  await db.update(payments)
    .set({ status: "reauthorized", stripe_payment_intent_id: pi.id, reauth_count: 1, reauth_at: new Date(), updated_at: new Date() })
    .where(eq(payments.id, p.id));
  if (oldPi && oldPi !== pi.id) { try { await getStripe().paymentIntents.cancel(oldPi); } catch { /* old auth may have lapsed */ } }
  logger.info({ paymentId, newPi: pi.id }, "seriousness deposit re-authorized (day-6)");
  return true;
}

/** Webhook: payment_intent.canceled for the CURRENT deposit PI — keep the row in sync. */
export async function handleDepositCanceled(pi: Stripe.PaymentIntent): Promise<void> {
  if (pi.metadata?.kind !== "deposit") return;
  const paymentId = pi.metadata.payment_id;
  if (!paymentId) return;
  const [p] = await db.select({ id: payments.id, deal_id: payments.deal_id }).from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.stripe_payment_intent_id, pi.id), inArray(payments.status, ["authorized", "reauthorized"]))).limit(1);
  if (!p) return; // stale (e.g. the old PI we canceled during re-auth) — ignore
  await db.update(payments).set({ status: "released", updated_at: new Date() }).where(eq(payments.id, p.id));
  // A Serious-offer hold on an unconfirmed request has no deal yet.
  if (p.deal_id) await db.update(deals).set({ deposit_status: "released" }).where(eq(deals.id, p.deal_id));
}
