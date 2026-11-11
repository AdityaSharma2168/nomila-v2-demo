/**
 * refund.ts — refunds, chargebacks (card disputes) and transfer reversals for deal payments.
 *
 * MONEY MOVES ONLY ON A HUMAN TAP. Every function here that calls Stripe to move money
 * (refundDealPayment, refundDuplicateCharge, reverseSettlementTransfer, resolveDeliveryDispute)
 * is reached only from an explicit REST call: the athlete's own route (requireAuth, tenancy-
 * checked) or an admin route (requireAdmin). No Mila tool, pending action or cron calls them
 * (guarded by paymentsTapOnly.test.ts). The webhook handlers below only RECORD what Stripe
 * already did (a dashboard refund, a chargeback, a reversal).
 *
 * Who may refund what:
 *   - the athlete: her own payment while the money is still held (funded, or the brand's
 *     delivery dispute) — giving the brand its money back before release;
 *   - an admin: also after release (settled) — the transfer to the athlete is reversed first,
 *     then the brand is refunded; and a duplicate charge flagged by PR 2.
 * A charge with an open chargeback can't be refunded (Stripe refuses; the dispute decides).
 *
 * The brand is refunded the full amount it paid (deal + commission + processing). Stripe
 * does not return its processing fee on a refund — the platform absorbs it (policy note in
 * the PR; revisit with the commission decision).
 */

import type Stripe from "stripe";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { deals, payments } from "../../../shared/schema";
import type { Payment } from "../../../shared/schema";
import { getStripe } from "../../lib/stripe";
import { createLogger } from "../../logger";
import { sendEmail } from "../../lib/notify";
import { htmlEscape } from "../../lib/securityHeaders";
import { settleDealPayment } from "./settle";
import { requireDealId } from "./dealPayment";
import { refundCreditedHold } from "./seriousOffer";

const logger = createLogger("payments/refund");

export type RefundActor = "athlete" | "admin";

export interface RefundReceipt {
  paymentId:          string;
  status:             string;
  refundId:           string | null;
  refundedCents:      number;
  currency:           string;
  refundedAt:         string | null;
  transferReversalId: string | null;
  requestedBy:        string | null;
  reason:             string | null;
}

const HELD_STATUSES     = ["funded", "disputed"];          // money still on the platform
const REFUNDABLE_ADMIN  = ["funded", "disputed", "settled"];

/**
 * Refund the brand in full. `athleteId` is REQUIRED for the athlete actor and must own the
 * payment (tenancy). Idempotent: Stripe idempotency keys per payment, and an already
 * refunded payment returns its receipt.
 */
export async function refundDealPayment(input: {
  paymentId: string; actor: RefundActor; athleteId?: string; reason?: string | null;
}): Promise<RefundReceipt> {
  const [p] = await db.select().from(payments).where(and(eq(payments.id, input.paymentId), eq(payments.kind, "deal_payment"))).limit(1);
  if (!p) throw coded("PAYMENT_NOT_FOUND");
  if (input.actor === "athlete" && (!input.athleteId || p.athlete_id !== input.athleteId)) throw coded("PAYMENT_NOT_FOUND"); // tenancy: 404, never 403
  if (p.status === "refunded") return receiptOf(p);
  if (p.stripe_dispute_id && p.status === "disputed") throw coded("CHARGEBACK_OPEN", { disputeStatus: p.dispute_status });

  const allowed = input.actor === "admin" ? REFUNDABLE_ADMIN : HELD_STATUSES;
  if (!allowed.includes(p.status)) {
    throw coded(input.actor === "athlete" && p.status === "settled" ? "ALREADY_RELEASED" : "NOT_REFUNDABLE", { status: p.status });
  }
  if (!p.stripe_payment_intent_id) throw coded("NOT_REFUNDABLE", { status: p.status, reason: "no payment intent" });

  const stripe = getStripe();
  const reason = input.reason?.trim().slice(0, 300) || null;

  // After release: pull the athlete's transfer back first; if that fails, nothing is refunded.
  let reversalId = p.stripe_transfer_reversal_id;
  if (p.status === "settled" && p.stripe_transfer_id && !reversalId) {
    const reversal = await stripe.transfers.createReversal(
      p.stripe_transfer_id,
      // This charge's transfer carried the deal value less any credited Serious-offer hold (reversed with that hold below).
      { amount: p.deal_value_cents != null ? p.deal_value_cents - (p.credit_cents ?? 0) : undefined, metadata: { kind: "deal_refund_reversal", payment_id: p.id } },
      { idempotencyKey: `reverse_${p.id}` },
    );
    reversalId = reversal.id;
    await db.update(payments).set({ stripe_transfer_reversal_id: reversalId, updated_at: new Date() }).where(eq(payments.id, p.id));
  }

  const refund = await stripe.refunds.create(
    {
      payment_intent: p.stripe_payment_intent_id,
      reason:         "requested_by_customer",
      metadata:       { kind: "deal_refund", payment_id: p.id, deal_id: p.deal_id, requested_by: input.actor },
    },
    { idempotencyKey: `refund_${p.id}` },
  );

  const now = new Date();
  const [after] = await db.update(payments).set({
    status:                      "refunded",
    stripe_refund_id:            refund.id,
    refunded_cents:              refund.amount ?? p.brand_total_cents,
    refunded_at:                 now,
    refund_reason:               reason,
    refund_requested_by:         input.actor,
    stripe_transfer_reversal_id: reversalId ?? null,
    updated_at:                  now,
  }).where(eq(payments.id, p.id)).returning();
  await db.update(deals).set({ payment_status: "refunded" }).where(eq(deals.id, requireDealId(p.deal_id, p.id)));
  // The brand also paid part of this deal with its Serious-offer hold: a full refund includes it.
  if (p.credit_payment_id) await refundCreditedHold(p.credit_payment_id, input.actor, reason);

  logger.info({ paymentId: p.id, dealId: p.deal_id, actor: input.actor, refundId: refund.id, reversalId }, "deal payment refunded");
  await emailBrandRefundReceipt(after).catch((err: any) => logger.warn({ paymentId: p.id, error: err.message }, "refund receipt email failed"));
  return receiptOf(after);
}

/**
 * Admin: refund a DUPLICATE charge flagged on payments.metadata.duplicate_charges (PR 2) —
 * a second payment the brand should never have made. The payment's own charge is untouched.
 */
export async function refundDuplicateCharge(paymentId: string, paymentIntentId: string): Promise<{ refundId: string }> {
  const [p] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  const dups = ((p?.metadata ?? {}) as { duplicate_charges?: Array<Record<string, unknown>> }).duplicate_charges ?? [];
  const dup = dups.find((d) => d.payment_intent === paymentIntentId);
  if (!p || !dup) throw coded("DUPLICATE_NOT_FOUND");
  if (paymentIntentId === p.stripe_payment_intent_id) throw coded("NOT_A_DUPLICATE");
  if (dup.refund_status === "refunded" && typeof dup.refund_id === "string") return { refundId: dup.refund_id };

  const refund = await getStripe().refunds.create(
    { payment_intent: paymentIntentId, reason: "duplicate", metadata: { kind: "deal_duplicate_refund", payment_id: p.id } },
    { idempotencyKey: `refund_dup_${paymentIntentId}` },
  );
  await markDuplicateRefunded(p.id, paymentIntentId, refund.id);
  logger.info({ paymentId, paymentIntentId, refundId: refund.id }, "duplicate charge refunded");
  return { refundId: refund.id };
}

async function markDuplicateRefunded(paymentId: string, paymentIntentId: string, refundId: string | null): Promise<void> {
  const [p] = await db.select({ metadata: payments.metadata }).from(payments).where(eq(payments.id, paymentId)).limit(1);
  const meta = (p?.metadata ?? {}) as { duplicate_charges?: Array<Record<string, unknown>> };
  const list = (meta.duplicate_charges ?? []).map((d) =>
    d.payment_intent === paymentIntentId ? { ...d, refund_status: "refunded", refund_id: refundId ?? d.refund_id ?? null } : d);
  await db.update(payments).set({ metadata: { ...meta, duplicate_charges: list }, updated_at: new Date() }).where(eq(payments.id, paymentId));
}

/**
 * Admin: settle the brand's DELIVERY dispute (raised on the confirm page): release to the
 * athlete, or refund the brand.
 */
export async function resolveDeliveryDispute(paymentId: string, outcome: "release" | "refund", note?: string | null): Promise<{ status: string }> {
  const [p] = await db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.kind, "deal_payment"))).limit(1);
  if (!p) throw coded("PAYMENT_NOT_FOUND");
  if (p.status !== "disputed") throw coded("NOT_DISPUTED", { status: p.status });
  if (p.stripe_dispute_id) throw coded("CHARGEBACK_OPEN", { disputeStatus: p.dispute_status }); // the card network decides that one

  if (outcome === "refund") {
    const r = await refundDealPayment({ paymentId, actor: "admin", reason: note ?? "delivery dispute resolved for the brand" });
    return { status: r.status };
  }
  await db.update(payments).set({
    status: "funded",
    brand_confirmed_at: p.brand_confirmed_at ?? new Date(), // the admin's decision stands in for the brand's confirmation
    metadata: sql`coalesce(${payments.metadata}, '{}'::jsonb) - 'delivery_disputed_at'`,
    updated_at: new Date(),
  }).where(and(eq(payments.id, paymentId), eq(payments.status, "disputed")));
  await db.update(deals).set({ payment_status: "delivered_pending_confirmation" }).where(eq(deals.id, requireDealId(p.deal_id, p.id)));
  let settled = false;
  try { settled = await settleDealPayment(paymentId); }
  catch (err: any) { logger.warn({ paymentId, code: err.code }, "release after dispute resolution failed — the sweep will retry"); }
  return { status: settled ? "settled" : "funded" };
}

/**
 * Admin: after a LOST chargeback on a released payment, recover the deal value from the
 * athlete's connected account (the platform is liable for the loss until it does).
 */
export async function reverseSettlementTransfer(paymentId: string): Promise<{ reversalId: string }> {
  const [p] = await db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.kind, "deal_payment"))).limit(1);
  if (!p || !p.stripe_transfer_id) throw coded("NO_TRANSFER");
  if (p.stripe_transfer_reversal_id) return { reversalId: p.stripe_transfer_reversal_id };
  const reversal = await getStripe().transfers.createReversal(
    p.stripe_transfer_id,
    { amount: p.deal_value_cents ?? undefined, metadata: { kind: "deal_chargeback_reversal", payment_id: p.id } },
    { idempotencyKey: `reverse_${p.id}` },
  );
  await db.update(payments).set({ stripe_transfer_reversal_id: reversal.id, updated_at: new Date() }).where(eq(payments.id, p.id));
  logger.info({ paymentId, reversalId: reversal.id }, "settlement transfer reversed");
  return { reversalId: reversal.id };
}

// ── Webhooks: record what Stripe did ─────────────────────────────────────────

async function findByCharge(chargeId: string | null, piId: string | null): Promise<Payment | null> {
  const conds = [
    ...(chargeId ? [eq(payments.stripe_charge_id, chargeId)] : []),
    ...(piId ? [eq(payments.stripe_payment_intent_id, piId)] : []),
  ];
  if (!conds.length) return null;
  for (const c of conds) {
    const [p] = await db.select().from(payments).where(and(c, eq(payments.kind, "deal_payment"))).limit(1);
    if (p) return p;
  }
  return null;
}

const idOf = (x: string | { id: string } | null | undefined): string | null => (typeof x === "string" ? x : x?.id ?? null);

/** Webhook: charge.refunded — a refund from our action, the dashboard, or a duplicate charge. */
export async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
  const piId = idOf(charge.payment_intent as any);
  const latestRefundId = charge.refunds?.data?.[0]?.id ?? null;
  const p = await findByCharge(charge.id, piId);

  if (!p) {
    // A flagged duplicate charge (PR 2) refunded — mark it on the owning payment.
    if (!piId) return;
    const [owner] = await db.select({ id: payments.id }).from(payments)
      .where(sql`${payments.metadata} -> 'duplicate_charges' @> ${JSON.stringify([{ payment_intent: piId }])}::jsonb`).limit(1);
    if (owner && charge.amount_refunded >= charge.amount) await markDuplicateRefunded(owner.id, piId, latestRefundId);
    return;
  }

  const full = charge.amount_refunded >= charge.amount;
  const toRefunded = full && ["funded", "settled", "disputed"].includes(p.status) && !(p.status === "disputed" && p.stripe_dispute_id);
  await db.update(payments).set({
    refunded_cents:      charge.amount_refunded,
    refunded_at:         p.refunded_at ?? new Date(),
    stripe_refund_id:    p.stripe_refund_id ?? latestRefundId,
    refund_requested_by: p.refund_requested_by ?? "stripe",
    ...(toRefunded ? { status: "refunded" } : {}),
    updated_at:          new Date(),
  }).where(eq(payments.id, p.id));
  if (toRefunded) await db.update(deals).set({ payment_status: "refunded" }).where(eq(deals.id, requireDealId(p.deal_id, p.id)));

  if (p.status === "settled" && !p.stripe_transfer_reversal_id) {
    logger.error({ alert: "PAYMENT_REFUNDED_AFTER_RELEASE", paymentId: p.id, chargeId: charge.id },
      "brand refunded after the athlete was paid, with no transfer reversal — admin decision needed");
  }
  logger.info({ paymentId: p.id, refundedCents: charge.amount_refunded, full }, "charge.refunded recorded");
}

/** Webhook: charge.dispute.created — a chargeback. Blocks release; alerts. */
export async function handleDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
  const p = await findByCharge(idOf(dispute.charge as any), idOf(dispute.payment_intent as any));
  if (!p) return;
  await db.update(payments).set({
    stripe_dispute_id: dispute.id,
    dispute_status:    dispute.status,
    ...(["funded", "settled", "disputed"].includes(p.status) ? { status: "disputed" } : {}),
    updated_at:        new Date(),
  }).where(eq(payments.id, p.id));
  await db.update(deals).set({ payment_status: "disputed" }).where(eq(deals.id, requireDealId(p.deal_id, p.id)));
  logger.error(
    { alert: "PAYMENT_CHARGEBACK", paymentId: p.id, disputeId: dispute.id, reason: dispute.reason, amount: dispute.amount, released: !!p.stripe_transfer_id },
    "chargeback opened on a deal payment — release blocked; respond in the Stripe dashboard",
  );
}

/** Webhook: charge.dispute.updated — mirror the status. */
export async function handleDisputeUpdated(dispute: Stripe.Dispute): Promise<void> {
  // Mirrors the status on whichever payment (deal or booking) carries this chargeback.
  await db.update(payments).set({ dispute_status: dispute.status, updated_at: new Date() })
    .where(eq(payments.stripe_dispute_id, dispute.id));
}

/**
 * Webhook: charge.dispute.closed. Lost → `charged_back` (terminal; the money went back to
 * the card holder). Won / warning closed → back to where it was: settled if the athlete was
 * paid, still `disputed` if the brand's delivery dispute is open, else funded.
 */
export async function handleDisputeClosed(dispute: Stripe.Dispute): Promise<void> {
  // Deal payments only: a booking's chargeback is closed by bookings/charges.ts handleBookingDisputeClosed.
  const [p] = await db.select().from(payments).where(and(eq(payments.stripe_dispute_id, dispute.id), eq(payments.kind, "deal_payment"))).limit(1);
  if (!p) return;
  if (dispute.status === "lost") {
    await db.update(payments).set({ status: "charged_back", dispute_status: dispute.status, updated_at: new Date() }).where(eq(payments.id, p.id));
    await db.update(deals).set({ payment_status: "refunded" }).where(eq(deals.id, requireDealId(p.deal_id, p.id)));
    logger.error({ alert: "PAYMENT_CHARGEBACK_LOST", paymentId: p.id, released: !!p.stripe_transfer_id },
      p.stripe_transfer_id ? "chargeback lost after release — consider reversing the transfer (admin)" : "chargeback lost before release");
    return;
  }
  const deliveryDisputeOpen = !!(p.metadata as any)?.delivery_disputed_at;
  const status = p.stripe_transfer_id ? "settled" : deliveryDisputeOpen ? "disputed" : "funded";
  const dealStatus = status === "settled" ? "settled" : status === "disputed" ? "disputed" : p.athlete_confirmed_at ? "delivered_pending_confirmation" : "funded";
  await db.update(payments).set({ status, dispute_status: dispute.status, updated_at: new Date() })
    .where(and(eq(payments.id, p.id), inArray(payments.status, ["disputed"])));
  await db.update(deals).set({ payment_status: dealStatus }).where(eq(deals.id, requireDealId(p.deal_id, p.id)));
  logger.info({ paymentId: p.id, disputeStatus: dispute.status, status }, "chargeback closed in the platform's favour");
}

/** Webhook: transfer.reversed — record a reversal made from the dashboard (ours are recorded at call time). */
export async function handleTransferReversed(transfer: Stripe.Transfer): Promise<void> {
  const reversalId = transfer.reversals?.data?.[0]?.id ?? null;
  if (!reversalId) return;
  await db.update(payments).set({ stripe_transfer_reversal_id: reversalId, updated_at: new Date() })
    .where(and(eq(payments.stripe_transfer_id, transfer.id), sql`${payments.stripe_transfer_reversal_id} IS NULL`));
  logger.info({ transferId: transfer.id, reversalId, amountReversed: transfer.amount_reversed }, "transfer.reversed recorded");
}

// ── Receipts ─────────────────────────────────────────────────────────────────

export function receiptOf(p: Payment): RefundReceipt {
  return {
    paymentId:          p.id,
    status:             p.status,
    refundId:           p.stripe_refund_id,
    refundedCents:      p.refunded_cents ?? 0,
    currency:           p.currency,
    refundedAt:         p.refunded_at?.toISOString() ?? null,
    transferReversalId: p.stripe_transfer_reversal_id,
    requestedBy:        p.refund_requested_by,
    reason:             p.refund_reason,
  };
}

async function emailBrandRefundReceipt(p: Payment): Promise<void> {
  if (!p.brand_email || !p.refunded_cents) return;
  const [d] = await db.select({ brand: deals.brand_name }).from(deals).where(eq(deals.id, requireDealId(p.deal_id, p.id))).limit(1);
  const usd = (p.refunded_cents / 100).toLocaleString("en-US", { style: "currency", currency: p.currency.toUpperCase() });
  const what = d?.brand ? `your ${d.brand} deal payment` : "your deal payment";
  const text = `We've refunded ${usd} for ${what} to your original payment method. Reference: ${p.stripe_refund_id}. `
    + "Refunds usually appear within 5–10 business days.";
  await sendEmail({
    to: p.brand_email,
    subject: `Refund of ${usd} issued`,
    text,
    html: `<p>We've refunded ${htmlEscape(usd)} for ${htmlEscape(what)} to your original payment method.</p>`
      + `<p>Reference: ${htmlEscape(p.stripe_refund_id)}</p><p>Refunds usually appear within 5–10 business days.</p>`,
  });
}

function coded(code: string, detail?: unknown): Error & { code: string; detail?: unknown } {
  const err = new Error(code) as Error & { code: string; detail?: unknown };
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}
