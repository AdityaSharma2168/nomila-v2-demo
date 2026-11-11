/**
 * seriousOffer.ts — the Serious offer (design-public-card-v3 §6a, owner decision 8 Oct 2026, FINAL): a refundable card
 * HOLD a brand can add to a request from her public card. Built on the seriousness deposit (deposit.ts): the same
 * manual-capture Stripe Checkout with a Customer + saved card, the same ~day-6 off-session re-auth (paymentsCron), the
 * same payments row kind 'deposit' — keyed to the REQUEST (payments.partner_request_id) until it is confirmed, then to
 * its deal as well.
 *
 * Its clock (payments.expires_at, released by the payments sweep):
 *   placed            → the request's own 72h confirm window (never confirmed ⇒ released, nothing sent)
 *   confirmed         → 6 days for her to reply (no reply ⇒ released)
 *   she replied       → the deposit window, 14 days from placement (no deal by then ⇒ released)
 * Her taps:
 *   agree             → CAPTURED (the one capture path in the deposit code) and counted toward the brand's first
 *                       payment: requestDealPayment credits it, settlement pays her the credited part from this charge
 *   decline           → released at once
 * The brand never pays the hold by itself, and the amount is never shown on the public card.
 *
 * Money moves only on a tap (paymentsTapOnly): the visitor's hold tap, her agree / decline taps (routes), the sweep's
 * window release, and Stripe's own events. Nothing here is reachable from Mila or a job.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { deals, partnerRequests, partnerSettings, payments, type Payment } from "../../../shared/schema";
import { getStripe } from "../../lib/stripe";
import { publicBaseUrl } from "../../lib/baseUrls";
import { createLogger } from "../../logger";
import { PAYMENTS } from "./config";
import { releaseDepositPayment } from "./deposit";

const logger = createLogger("payments/serious-offer");
const DAY_MS = 86_400_000;
export const REPLY_WINDOW_MS = 6 * DAY_MS;
const HOLDING = ["authorized", "reauthorized"];

export function holdDoneUrl(requestId: string, handle: string): string {
  return `${publicBaseUrl()}/partner/hold/${requestId}/done?h=${encodeURIComponent(handle)}`;
}
export function holdCanceledUrl(requestId: string, handle: string): string {
  return `${publicBaseUrl()}/partner/hold/${requestId}/canceled?h=${encodeURIComponent(handle)}`;
}

export async function holdForRequest(requestId: string): Promise<Payment | null> {
  const [p] = await db.select().from(payments).where(and(eq(payments.partner_request_id, requestId), eq(payments.kind, "deposit"))).limit(1);
  return p ?? null;
}

/** The amount actually held for a request, or null when there is no live hold. */
export async function heldCentsForRequest(requestId: string): Promise<number | null> {
  const p = await holdForRequest(requestId);
  return p && HOLDING.includes(p.status) ? p.brand_total_cents : null;
}

export type HoldCheckout = { url: string } | { error: "not_available" | "already_placed" | "checkout_unavailable" };

/**
 * The visitor's "Add $X hold · send" tap, while the request is still a draft. The amount is HER setting at this moment
 * (on by default, $50). Opens the manual-capture Checkout; the webhook marks it held and sends the confirm email.
 */
export async function createSeriousOfferCheckout(requestId: string, handle: string, now: Date = new Date()): Promise<HoldCheckout> {
  const [r] = await db.select().from(partnerRequests).where(eq(partnerRequests.id, requestId)).limit(1);
  if (!r || r.status !== "drafting" || r.kind === "press" || new Date(r.expires_at).getTime() <= now.getTime()) return { error: "not_available" };
  const [s] = await db.select().from(partnerSettings).where(eq(partnerSettings.athlete_id, r.athlete_id)).limit(1);
  if (s && !s.serious_offer_enabled) return { error: "not_available" };
  const amount = s?.serious_offer_cents ?? 5_000;

  const existing = await holdForRequest(requestId);
  if (existing && HOLDING.includes(existing.status)) return { error: "already_placed" };
  let paymentId: string;
  if (existing) {
    paymentId = existing.id;
    await db.update(payments).set({ status: "pending", brand_total_cents: amount, currency: PAYMENTS.currency, expires_at: r.expires_at, reauth_count: 0, updated_at: now })
      .where(eq(payments.id, existing.id));
  } else {
    const [row] = await db.insert(payments).values({
      partner_request_id: requestId, athlete_id: r.athlete_id, kind: "deposit", status: "pending",
      brand_total_cents: amount, currency: PAYMENTS.currency, expires_at: r.expires_at,
    }).returning({ id: payments.id });
    paymentId = row.id;
  }

  const meta = { kind: "deposit", payment_id: paymentId, partner_request_id: requestId };
  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_creation: "always",
    line_items: [{ price_data: { currency: PAYMENTS.currency, product_data: { name: `Serious offer hold — request to ${r.display_name}` }, unit_amount: amount }, quantity: 1 }],
    payment_intent_data: {
      capture_method: "manual",              // a HOLD: captured only if a deal is agreed
      setup_future_usage: "off_session",     // the saved card lets the sweep re-authorize at ~day 6
      description: `Refundable hold · ref ${r.public_ref}`,
      metadata: meta,
    },
    metadata: meta,
    success_url: holdDoneUrl(requestId, handle),
    cancel_url: holdCanceledUrl(requestId, handle),
  });
  await db.update(payments).set({ stripe_checkout_session_id: session.id, updated_at: now }).where(eq(payments.id, paymentId));
  if (!session.url) return { error: "checkout_unavailable" };
  return { url: session.url };
}

/**
 * The request was confirmed: the hold now also belongs to her deal (the "Verified · $X held" badge reads
 * deals.deposit_status) and its clock becomes her 6-day reply window. Idempotent.
 */
export async function linkHoldToDeal(requestId: string, dealId: string, now: Date = new Date()): Promise<void> {
  const p = await holdForRequest(requestId);
  if (!p) return;
  const held = HOLDING.includes(p.status);
  await db.update(payments).set({
    deal_id: dealId,
    ...(held && !p.deal_id ? { expires_at: new Date(now.getTime() + REPLY_WINDOW_MS) } : {}),
    updated_at: now,
  }).where(eq(payments.id, p.id));
  if (held) await db.update(deals).set({ deposit_status: "held" }).where(eq(deals.id, dealId));
}

/**
 * Sweep step: she replied (first_reply_at) and has not decided → the hold lives to the deposit window (14 days from
 * placement). Runs BEFORE the expiry step, so a reply in the last hour still stops the 6-day clock.
 */
export async function extendRepliedHolds(now: Date = new Date()): Promise<number> {
  const rows = await db.execute(sql`
    UPDATE payments p SET expires_at = p.created_at + make_interval(days => ${PAYMENTS.depositWindowDays}), updated_at = ${now}
      FROM partner_requests r
     WHERE p.partner_request_id = r.id AND p.kind = 'deposit' AND p.status IN ('authorized','reauthorized')
       AND r.first_reply_at IS NOT NULL AND r.outcome IS NULL
       AND p.expires_at < p.created_at + make_interval(days => ${PAYMENTS.depositWindowDays})
    RETURNING p.id`);
  return ((rows as any).rows ?? rows).length;
}

/**
 * Her Agree tap: capture the hold. It then counts toward the brand's first payment (requestDealPayment reads it).
 * Returns the captured amount, or null when there was no live hold or the capture failed (the deal still stands; the
 * failure is recorded and the brand simply pays in full).
 */
export async function captureSeriousOffer(requestId: string, now: Date = new Date()): Promise<number | null> {
  const p = await holdForRequest(requestId);
  if (!p || !HOLDING.includes(p.status) || !p.stripe_payment_intent_id) return null;
  try {
    const pi = await getStripe().paymentIntents.capture(p.stripe_payment_intent_id, {}, { idempotencyKey: `serious_capture_${p.id}` });
    const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
    await db.update(payments).set({ status: "funded", stripe_charge_id: chargeId, failure_reason: null, updated_at: now }).where(eq(payments.id, p.id));
    if (p.deal_id) await db.update(deals).set({ deposit_status: "credited" }).where(eq(deals.id, p.deal_id));
    logger.info({ paymentId: p.id, requestId }, "serious offer hold captured — counts toward the first payment");
    return p.brand_total_cents;
  } catch (err: any) {
    logger.warn({ paymentId: p.id, requestId, error: err?.message }, "serious offer capture failed — the hold is released instead");
    await db.update(payments).set({ failure_reason: `capture failed: ${String(err?.message ?? "").slice(0, 200)}`, updated_at: now }).where(eq(payments.id, p.id));
    await releaseDepositPayment(p.id, "canceled");
    return null;
  }
}

/** Her Decline tap: release the hold now. Returns the released amount, or null when there was none. */
export async function releaseSeriousOffer(requestId: string): Promise<number | null> {
  const p = await holdForRequest(requestId);
  if (!p || !HOLDING.includes(p.status)) return null;
  return (await releaseDepositPayment(p.id, "declined")) ? p.brand_total_cents : null;
}

/** A captured Serious-offer hold on this deal not yet credited to any payment: the credit for the first payment. */
export async function uncreditedHold(dealId: string): Promise<Payment | null> {
  const [p] = await db.select().from(payments).where(and(
    eq(payments.deal_id, dealId), eq(payments.kind, "deposit"), eq(payments.status, "funded"),
    sql`${payments.partner_request_id} IS NOT NULL`,
    sql`NOT EXISTS (SELECT 1 FROM payments dp WHERE dp.credit_payment_id = ${payments.id})`,
  )).limit(1);
  return p ?? null;
}

/**
 * Refund a credited hold with the deal payment it was credited to (a refund of the deal payment is a refund of
 * everything the brand paid for it). Reverses her credit transfer first when it was released. Idempotent.
 */
export async function refundCreditedHold(holdPaymentId: string, actor: string, reason: string | null): Promise<void> {
  const [h] = await db.select().from(payments).where(eq(payments.id, holdPaymentId)).limit(1);
  if (!h || h.status === "refunded" || !h.stripe_payment_intent_id) return;
  const stripe = getStripe();
  let reversalId = h.stripe_transfer_reversal_id;
  if (h.status === "settled" && h.stripe_transfer_id && !reversalId) {
    const rev = await stripe.transfers.createReversal(h.stripe_transfer_id, { metadata: { kind: "deal_refund_reversal", payment_id: h.id } }, { idempotencyKey: `reverse_${h.id}` });
    reversalId = rev.id;
  }
  const refund = await stripe.refunds.create(
    { payment_intent: h.stripe_payment_intent_id, reason: "requested_by_customer", metadata: { kind: "deal_refund", payment_id: h.id, deal_id: h.deal_id, requested_by: actor } },
    { idempotencyKey: `refund_${h.id}` },
  );
  const now = new Date();
  await db.update(payments).set({
    status: "refunded", stripe_refund_id: refund.id, refunded_cents: refund.amount ?? h.brand_total_cents, refunded_at: now,
    refund_reason: reason, refund_requested_by: actor, stripe_transfer_reversal_id: reversalId ?? null, updated_at: now,
  }).where(eq(payments.id, h.id));
}


/**
 * A hold larger than the deal it is credited to (a $250 hold on a $100 deal): the part above the credit is refunded to
 * the brand at once — it never pays more than the deal. Idempotent (refunded_cents records it).
 */
export async function refundHoldExcess(hold: Payment, creditCents: number): Promise<void> {
  const excess = (hold.brand_total_cents ?? 0) - creditCents;
  if (excess <= 0 || (hold.refunded_cents ?? 0) >= excess || !hold.stripe_payment_intent_id || hold.status !== "funded") return;
  const refund = await getStripe().refunds.create(
    { payment_intent: hold.stripe_payment_intent_id, amount: excess, reason: "requested_by_customer", metadata: { kind: "serious_offer_excess", payment_id: hold.id } },
    { idempotencyKey: `serious_excess_${hold.id}` },
  );
  await db.update(payments).set({ refunded_cents: refund.amount ?? excess, refunded_at: new Date(), refund_reason: "hold above the deal value", refund_requested_by: "athlete", updated_at: new Date() })
    .where(eq(payments.id, hold.id));
}
