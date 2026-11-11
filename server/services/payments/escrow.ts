/**
 * escrow.ts — the deal-payment (escrow) flow.
 *
 * Separate Charges & Transfers: the brand pays the grossed-up total via hosted
 * Checkout; funds are CAPTURED to Nomila's platform balance (escrow held) and
 * transferred to the athlete only on delivery confirmation (Phase 4 — settle.ts).
 * There is NO transfer_data / application_fee on this charge (that would pay the
 * athlete immediately and defeat delivery-gating — plan §2.2).
 *
 * Rail is fixed per pay-link so the brand sees an accurate itemized total: card by
 * default, bank (ACH, 0.8% capped at $5) for large deals. Money is INTEGER CENTS.
 */

import type Stripe from "stripe";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { deals, inboxThreads, payments } from "../../../shared/schema";
import { pickLatestOffer, type OfferSource } from "../../lib/latestOffer";
import { getStripe } from "../../lib/stripe";
import { createLogger } from "../../logger";
import { PAYMENTS } from "./config";
import { quoteDealCharge, dealAmountToCents, isChargeableDealSize, type DealChargeQuote, type Rail } from "./money";
import { assertDealPayment, requireDealId } from "./dealPayment";
import { brandCheckoutCancelUrl, brandCheckoutReturnUrl, payLinkUrl } from "./urls";
import { refundHoldExcess, uncreditedHold } from "./seriousOffer";

const logger = createLogger("payments/escrow");

export interface PaymentRequestResult {
  paymentId: string;
  payUrl:    string;
  /**
   * brandTotalCents is what the brand is asked to pay NOW: the quote's total less creditCents, a captured Serious-offer
   * hold that already counts toward this first payment (0 when there is none).
   */
  quote:     DealChargeQuote & { creditCents: number };
  /**
   * The figure billed and where it came from, so the screen can show both BEFORE her tap:
   * "confirmed" (a contract she saved / a deal she entered), "thread" (the latest offer the summariser read from the
   * brand's emails — a model's reading, so she confirms it), or "deal_row" (the detection snapshot, nothing newer).
   */
  amount:    { value: number; source: OfferSource };
}

/** A payment can be requested only on a deal she has agreed (accepted) or completed — her own status, never a model's read. */
const PAYABLE_STATUSES = new Set(["accepted", "completed"]);

/** Athlete/Mila requests payment on an agreed deal → a pending deal_payment + a hosted pay link. */
export async function requestDealPayment(dealId: string, athleteId: string, rail: Rail = "card"): Promise<PaymentRequestResult> {
  const [deal] = await db.select().from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId))).limit(1);
  if (!deal) throw coded("DEAL_NOT_FOUND");
  if (!PAYABLE_STATUSES.has(String(deal.status ?? ""))) throw coded("DEAL_NOT_AGREED", { status: deal.status });

  // Bill the figure that was agreed: the one she confirmed, else the LATEST offer on the thread —
  // never the detection-time snapshot in deals.amount, which on a negotiated deal is the opening
  // number (lib/latestOffer).
  const threads = await db.select({ conversation_state: inboxThreads.conversation_state, last_message_at: inboxThreads.last_message_at })
    .from(inboxThreads)
    .where(and(eq(inboxThreads.deal_id, dealId), eq(inboxThreads.athlete_id, athleteId)));
  const latest = pickLatestOffer(deal, threads);
  const dealValueCents = dealAmountToCents(latest?.amount ?? null);
  if (dealValueCents == null || !isChargeableDealSize(dealValueCents)) {
    throw coded("INVALID_DEAL_AMOUNT", { dealValueCents, minCents: PAYMENTS.minDealCents });
  }
  const quote = quoteDealCharge(dealValueCents, rail);

  // Idempotent: reuse an existing un-funded deal_payment for this deal; never create a
  // second charge once one is funded/settled.
  const [existing] = await db.select().from(payments)
    .where(and(eq(payments.deal_id, dealId), eq(payments.kind, "deal_payment"))).limit(1);

  // A Serious-offer hold the brand placed with its public request, captured when she agreed: it counts toward this
  // (first) payment. At most the deal value; anything above that is refunded to the brand now (seriousOffer.ts).
  const creditHold = existing?.credit_payment_id
    ? (await db.select().from(payments).where(eq(payments.id, existing.credit_payment_id)).limit(1))[0] ?? null
    : await uncreditedHold(dealId);
  const creditCents = creditHold ? Math.min(creditHold.brand_total_cents ?? 0, quote.dealValueCents) : 0;
  if (creditHold) await refundHoldExcess(creditHold, creditCents);

  const amounts = {
    rail,
    deal_value_cents:     quote.dealValueCents,
    commission_cents:     quote.commissionCents,
    processing_fee_cents: quote.processingFeeCents,
    brand_total_cents:    quote.brandTotalCents - creditCents,
    currency:             PAYMENTS.currency,
    credit_cents:         creditCents > 0 ? creditCents : null,
    credit_payment_id:    creditCents > 0 ? creditHold!.id : null,
  };

  let paymentId: string;
  if (existing && ["pending", "requires_action", "failed"].includes(existing.status)) {
    paymentId = existing.id;
    // A re-quote (new amount or rail) must not leave the old-amount session payable.
    const requoted = existing.brand_total_cents !== amounts.brand_total_cents || existing.rail !== rail;
    if (requoted) await retireCheckoutSession(existing);
    await db.update(payments).set({
      ...amounts,
      status: "pending",
      ...(requoted ? { stripe_checkout_session_id: null, checkout_expires_at: null } : {}),
      updated_at: new Date(),
    }).where(eq(payments.id, existing.id));
  } else if (existing) {
    throw coded("PAYMENT_ALREADY_ACTIVE", { status: existing.status });
  } else {
    const [row] = await db.insert(payments)
      .values({ deal_id: dealId, athlete_id: athleteId, kind: "deal_payment", status: "pending", ...amounts })
      .returning({ id: payments.id });
    paymentId = row.id;
  }

  await db.update(deals).set({ payment_status: "payment_requested" }).where(eq(deals.id, dealId));
  logger.info({ dealId, athleteId, paymentId, rail, brandTotalCents: amounts.brand_total_cents, creditCents }, "deal payment requested");
  return {
    paymentId, payUrl: payLinkUrl(paymentId),
    quote: { ...quote, brandTotalCents: amounts.brand_total_cents, creditCents },
    amount: { value: latest!.amount, source: latest!.source },
  };
}

/**
 * Expire the payment's Checkout session if it is still open (re-quote). A session that
 * already COMPLETED means the brand has paid or a bank debit is in flight — refuse.
 */
async function retireCheckoutSession(p: { id: string; stripe_checkout_session_id: string | null }): Promise<void> {
  if (!p.stripe_checkout_session_id) return;
  const s = await getStripe().checkout.sessions.retrieve(p.stripe_checkout_session_id);
  if (s.status === "complete") throw coded("PAYMENT_ALREADY_ACTIVE", { status: "processing" });
  if (s.status === "open") {
    await getStripe().checkout.sessions.expire(s.id);
    logger.info({ paymentId: p.id, sessionId: s.id }, "re-quote — expired the open Checkout session");
  }
}

/** Statuses where the brand has paid: the pay link must never open another Checkout. */
const PAID_STATUSES = ["funded", "settled", "disputed", "refunded"];

/** An open session this close to lapsing is replaced rather than handed to the brand. */
const REUSE_MIN_REMAINING_MS = 10 * 60_000;

export type CheckoutLinkResult = { url: string; reused: boolean } | { error: "not found" | "already paid" | "processing" | "payment not quoted" | "checkout unavailable" };

/**
 * The account-less Stripe Checkout for a pay link. ONE live session per payment: the open
 * session is reused on every visit (and from concurrent tabs — the row is locked while we
 * decide), a completed session means the payment is processing, and a new session is only
 * created when none is open. Every session carries an explicit expires_at.
 */
export async function createDealCheckoutSession(paymentId: string): Promise<CheckoutLinkResult> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update").limit(1);
    if (!p || p.kind !== "deal_payment") return { error: "not found" } as const;
    assertDealPayment(p);
    if (PAID_STATUSES.includes(p.status)) return { error: "already paid" } as const;
    if (p.deal_value_cents == null || p.commission_cents == null || p.processing_fee_cents == null || p.brand_total_cents == null) {
      return { error: "payment not quoted" } as const;
    }
    // A bank debit in flight (Checkout completed "unpaid", PaymentIntent recorded): never open a second payment.
    if (["pending", "requires_action"].includes(p.status) && p.stripe_payment_intent_id) return { error: "processing" } as const;

    const stripe = getStripe();
    if (p.stripe_checkout_session_id) {
      const s = await stripe.checkout.sessions.retrieve(p.stripe_checkout_session_id);
      if (s.status === "complete") return { error: "processing" } as const; // paid; the webhook will fund the row
      if (s.status === "open") {
        const remainingMs = (s.expires_at ?? 0) * 1000 - Date.now();
        if (s.amount_total === p.brand_total_cents && s.url && remainingMs > REUSE_MIN_REMAINING_MS) {
          return { url: s.url, reused: true } as const;
        }
        await stripe.checkout.sessions.expire(s.id); // stale amount or about to lapse — replace it
      }
    }

    const [deal] = await tx.select({ brand_name: deals.brand_name }).from(deals).where(eq(deals.id, p.deal_id)).limit(1);
    const brand = deal?.brand_name ?? "brand";
    const rail: Rail = p.rail === "bank" ? "bank" : "card";
    const methodTypes: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] =
      rail === "bank" ? ["us_bank_account"] : ["card"];
    const expiresAt = Math.floor(Date.now() / 1000) + PAYMENTS.checkoutSessionHours * 3600;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      expires_at: expiresAt,
      payment_method_types: methodTypes,
      // Itemized so the brand always sees deal + platform fee + processing (plan §4).
      // A credited Serious-offer hold is already paid: the deal line shows it, and a fully covered deal line is left out.
      line_items: [
        ...(p.deal_value_cents - (p.credit_cents ?? 0) > 0
          ? [{ price_data: { currency: p.currency, product_data: { name: p.credit_cents ? `Deal payment — ${brand} (less your $${(p.credit_cents / 100).toFixed(2)} hold, already paid)` : `Deal payment — ${brand}` }, unit_amount: p.deal_value_cents - (p.credit_cents ?? 0) }, quantity: 1 }]
          : []),
        { price_data: { currency: p.currency, product_data: { name: "Nomila platform fee (10%)" }, unit_amount: p.commission_cents },    quantity: 1 },
        { price_data: { currency: p.currency, product_data: { name: "Payment processing" },        unit_amount: p.processing_fee_cents }, quantity: 1 },
      ],
      // SCT: charge to the PLATFORM balance — no transfer_data / application_fee here.
      payment_intent_data: { metadata: { kind: "deal_payment", payment_id: p.id, deal_id: p.deal_id } },
      metadata:            { kind: "deal_payment", payment_id: p.id, deal_id: p.deal_id },
      success_url: brandCheckoutReturnUrl(p.deal_id),
      cancel_url:  brandCheckoutCancelUrl(p.id),
    });

    await tx.update(payments)
      .set({ stripe_checkout_session_id: session.id, checkout_expires_at: new Date(expiresAt * 1000), updated_at: new Date() })
      .where(eq(payments.id, p.id));

    if (!session.url) return { error: "checkout unavailable" } as const;
    return { url: session.url, reused: false } as const;
  });
}

/** Webhook: checkout.session.expired — the stored session lapsed; the next visit mints a fresh one. */
export async function handleCheckoutSessionExpired(session: Stripe.Checkout.Session): Promise<void> {
  if (session.metadata?.kind !== "deal_payment" || !session.metadata.payment_id) return;
  await db.update(payments)
    .set({ checkout_expires_at: new Date(), updated_at: new Date() })
    .where(and(eq(payments.id, session.metadata.payment_id), eq(payments.stripe_checkout_session_id, session.id)));
}

/**
 * A second successful payment on a payment that is already funded (should be impossible
 * with one live session, but money that arrives must never be silently lost). Recorded on
 * payments.metadata.duplicate_charges for a tap-gated refund, and alerted at error level.
 * Never auto-refunded: a refund moves money and needs a human tap.
 */
async function flagDuplicateCharge(paymentId: string, info: { piId: string; chargeId?: string | null }): Promise<void> {
  const [row] = await db.select({ metadata: payments.metadata, dealId: payments.deal_id, athleteId: payments.athlete_id })
    .from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!row) return;
  const meta = (row.metadata ?? {}) as { duplicate_charges?: Array<Record<string, unknown>> };
  const list = meta.duplicate_charges ?? [];
  const existing = list.find((d) => d.payment_intent === info.piId);
  if (existing) {
    if (!existing.charge && info.chargeId) existing.charge = info.chargeId;
    else return;
  } else {
    list.push({ payment_intent: info.piId, charge: info.chargeId ?? null, detected_at: new Date().toISOString(), refund_status: "needs_refund" });
  }
  await db.update(payments).set({ metadata: { ...meta, duplicate_charges: list }, updated_at: new Date() }).where(eq(payments.id, paymentId));
  logger.error(
    { alert: "PAYMENT_DUPLICATE_CHARGE", paymentId, dealId: row.dealId, athleteId: row.athleteId, paymentIntent: info.piId, chargeId: info.chargeId ?? null },
    "second successful payment on an already-funded deal payment — flagged for refund",
  );
}

/**
 * Statuses a deal_payment may move to `funded` from. Money captured by Stripe is the
 * truth: a declined first attempt inside the same Checkout (payment_intent.payment_failed
 * → `failed`) or an out-of-order cancel/expiry must never make a later success be ignored.
 */
const FUNDABLE_STATUSES = ["pending", "requires_action", "failed", "canceled", "expired"];

/** Atomically flip a deal_payment to funded (escrow held). Idempotent + single-charge. */
async function markDealPaymentFunded(
  paymentId: string,
  info: { piId?: string | null; brandEmail?: string | null; chargeId?: string | null },
): Promise<void> {
  const updated = await db.update(payments)
    .set({
      status:                   "funded",
      stripe_payment_intent_id: info.piId ?? undefined,
      // A charge id recorded for a DIFFERENT PaymentIntent (e.g. an earlier bank debit still in
      // flight) is not this funding's charge — drop it rather than source a transfer from it.
      stripe_charge_id:         info.chargeId
        ?? (info.piId ? sql`CASE WHEN ${payments.stripe_payment_intent_id} = ${info.piId} THEN ${payments.stripe_charge_id} ELSE NULL END` : undefined),
      brand_email:              info.brandEmail ?? undefined,
      failure_reason:           null,
      updated_at:               new Date(),
    })
    .where(and(eq(payments.id, paymentId), eq(payments.kind, "deal_payment"), inArray(payments.status, FUNDABLE_STATUSES)))
    .returning({ id: payments.id, deal_id: payments.deal_id, athlete_id: payments.athlete_id });

  if (updated.length === 0) {
    // Already funded/settled (or the event raced). A DIFFERENT PaymentIntent succeeding on a
    // paid row is a duplicate charge — flag it. Otherwise backfill what this event knows that
    // the row does not: the charge id in particular, whichever event carried it.
    const [row] = await db.select({ status: payments.status, pi: payments.stripe_payment_intent_id })
      .from(payments).where(and(eq(payments.id, paymentId), eq(payments.kind, "deal_payment"))).limit(1);
    if (row && info.piId && row.pi && row.pi !== info.piId && PAID_STATUSES.includes(row.status)) {
      await flagDuplicateCharge(paymentId, { piId: info.piId, chargeId: info.chargeId });
      return;
    }
    await backfillStripeIds(paymentId, info);
    logger.info({ paymentId }, "deal payment already funded/settled — idempotent no-op");
    return;
  }
  const p = updated[0];
  await db.update(deals).set({ payment_status: "funded" }).where(eq(deals.id, requireDealId(p.deal_id, p.id)));
  // TODO(notify): tell the athlete funds are in escrow and it's safe to begin work (§6 step 6).
  logger.info({ paymentId, dealId: p.deal_id, athleteId: p.athlete_id }, "deal payment funded — escrow held on platform");
}

/**
 * Fill stripe_charge_id / stripe_payment_intent_id / brand_email on a row that lacks them,
 * without touching status. Only for the payment's OWN PaymentIntent (or a row with none
 * recorded yet), so a stray second charge can never overwrite the first.
 */
async function backfillStripeIds(
  paymentId: string,
  info: { piId?: string | null; brandEmail?: string | null; chargeId?: string | null },
): Promise<void> {
  const [row] = await db.select({
    pi: payments.stripe_payment_intent_id, charge: payments.stripe_charge_id, email: payments.brand_email,
  }).from(payments).where(and(eq(payments.id, paymentId), eq(payments.kind, "deal_payment"))).limit(1);
  if (!row) return;
  if (row.pi && info.piId && row.pi !== info.piId) return; // a different PaymentIntent — not this row's charge

  const set: Partial<typeof payments.$inferInsert> = {};
  if (!row.pi && info.piId) set.stripe_payment_intent_id = info.piId;
  if (!row.charge && info.chargeId) set.stripe_charge_id = info.chargeId;
  if (!row.email && info.brandEmail) set.brand_email = info.brandEmail;
  if (Object.keys(set).length === 0) return;
  await db.update(payments).set({ ...set, updated_at: new Date() }).where(eq(payments.id, paymentId));
}

/**
 * Webhook: checkout.session.completed / checkout.session.async_payment_succeeded.
 * For card, funds are captured at completion; ACH completes "unpaid" and funds later.
 */
export async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  if (session.metadata?.kind !== "deal_payment") return; // deposits are dispatched separately
  const paymentId = session.metadata.payment_id;
  if (!paymentId) return;
  const piId       = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
  const brandEmail = session.customer_details?.email ?? null;

  if (session.payment_status === "paid") {
    await markDealPaymentFunded(paymentId, { piId, brandEmail });
  } else {
    // ACH/bank: "funded pending" until the bank debit settles — record the ids, wait for
    // payment_intent.succeeded / async_payment_succeeded to fund (plan §4).
    await db.update(payments)
      .set({ stripe_payment_intent_id: piId ?? undefined, brand_email: brandEmail ?? undefined, updated_at: new Date() })
      .where(and(eq(payments.id, paymentId), inArray(payments.status, ["pending", "requires_action"])));
    logger.info({ paymentId, paymentStatus: session.payment_status }, "deal payment pending settlement (bank rail)");
  }
}

/** Webhook: checkout.session.async_payment_failed — the ACH debit failed after Checkout completed. */
export async function handleCheckoutAsyncPaymentFailed(session: Stripe.Checkout.Session): Promise<void> {
  if (session.metadata?.kind !== "deal_payment") return;
  const paymentId = session.metadata.payment_id;
  if (!paymentId) return;
  await db.update(payments)
    .set({ status: "failed", failure_reason: "async_payment_failed", updated_at: new Date() })
    .where(and(eq(payments.id, paymentId), inArray(payments.status, ["pending", "requires_action"])));
  logger.warn({ paymentId }, "deal payment async (bank) payment failed");
}

/** Webhook: payment_intent.succeeded — funds the deal_payment (ACH) and always records the charge id. */
export async function handleDealPaymentSucceeded(pi: Stripe.PaymentIntent): Promise<void> {
  if (pi.metadata?.kind !== "deal_payment") return;
  const paymentId = pi.metadata.payment_id;
  if (!paymentId) return;
  const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
  await markDealPaymentFunded(paymentId, { piId: pi.id, chargeId });
}

/**
 * Webhook: charge.succeeded — records the charge id whatever order the funding events
 * arrive in. Charges do not inherit PaymentIntent metadata, so match on the PaymentIntent
 * id (or the payment id when the metadata is present).
 */
export async function handleDealChargeSucceeded(charge: Stripe.Charge): Promise<void> {
  if (charge.status !== "succeeded") return;
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null;
  let paymentId = charge.metadata?.kind === "deal_payment" ? charge.metadata.payment_id ?? null : null;
  if (!paymentId && piId) {
    const [row] = await db.select({ id: payments.id }).from(payments)
      .where(and(eq(payments.stripe_payment_intent_id, piId), eq(payments.kind, "deal_payment"))).limit(1);
    paymentId = row?.id ?? null;
  }
  if (!paymentId) return; // not ours, or the PI is not recorded yet — settle fetches it from Stripe if needed
  await backfillStripeIds(paymentId, { piId, chargeId: charge.id });
}

/** Webhook: payment_intent.payment_failed for a deal_payment. A later success still funds it. */
export async function handleDealPaymentFailed(pi: Stripe.PaymentIntent): Promise<void> {
  if (pi.metadata?.kind !== "deal_payment") return;
  const paymentId = pi.metadata.payment_id;
  if (!paymentId) return;
  await db.update(payments)
    .set({ status: "failed", failure_reason: pi.last_payment_error?.message?.slice(0, 200) ?? "payment_failed", updated_at: new Date() })
    .where(and(eq(payments.id, paymentId), inArray(payments.status, ["pending", "requires_action"])));
  logger.warn({ paymentId }, "deal payment attempt failed");
}

/** Webhook: payment_intent.canceled for a deal_payment. */
export async function handleDealPaymentCanceled(pi: Stripe.PaymentIntent): Promise<void> {
  if (pi.metadata?.kind !== "deal_payment") return;
  const paymentId = pi.metadata.payment_id;
  if (!paymentId) return;
  await db.update(payments)
    .set({ status: "canceled", updated_at: new Date() })
    .where(and(eq(payments.id, paymentId), inArray(payments.status, ["pending", "requires_action", "failed"])));
  logger.info({ paymentId }, "deal payment canceled");
}

/**
 * The charge id a transfer must be sourced from. Read from the row; if no funding event
 * carried it (event order), fetch the PaymentIntent from Stripe and persist it.
 */
export async function resolveDealChargeId(paymentId: string): Promise<string | null> {
  const [p] = await db.select({ charge: payments.stripe_charge_id, pi: payments.stripe_payment_intent_id })
    .from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!p) return null;
  if (p.charge) return p.charge;
  if (!p.pi) return null;
  const pi = await getStripe().paymentIntents.retrieve(p.pi);
  const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
  if (chargeId) {
    await db.update(payments).set({ stripe_charge_id: chargeId, updated_at: new Date() })
      .where(and(eq(payments.id, paymentId), isNull(payments.stripe_charge_id)));
    logger.info({ paymentId, chargeId }, "charge id fetched from Stripe at settle time");
  }
  return chargeId;
}

function coded(code: string, detail?: unknown): Error & { code: string; detail?: unknown } {
  const err = new Error(code) as Error & { code: string; detail?: unknown };
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}
