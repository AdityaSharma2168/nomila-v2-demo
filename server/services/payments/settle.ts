/**
 * settle.ts — dual delivery confirmation + escrow release (transfer to athlete).
 *
 * Release happens only when BOTH the athlete (in-app) and the brand (hosted link)
 * confirm delivery — or, if the brand goes silent, the payments cron auto-releases to
 * the athlete after the confirmation window (plan §7). A brand can raise a dispute
 * before the window closes, which blocks auto-release.
 *
 * The brand's confirm/dispute needs the brand-only token (brandToken.ts) that is
 * emailed to the brand when the athlete marks delivered. The athlete never sees it:
 * she cannot confirm on the brand's behalf and release her own funds.
 *
 * Release = a Stripe transfer of exactly the deal value to the athlete's connected
 * account; the commission remains on the platform balance. Release is retry-safe:
 * a failed release (no payout account yet, Stripe error) leaves the row `funded` with
 * the reason in failure_reason, and the payments sweep retries every due row. The
 * transfer carries an idempotency key, and an existing transfer for the payment is
 * adopted rather than duplicated (the key alone expires after 24h).
 */

import type Stripe from "stripe";
import { and, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { athletes, deals, payments } from "../../../shared/schema";
import { getStripe } from "../../lib/stripe";
import { createLogger } from "../../logger";
import { sendEmail } from "../../lib/notify";
import { htmlEscape } from "../../lib/securityHeaders";
import { PAYMENTS } from "./config";
import { assertPayoutReady } from "./connect";
import { confirmLinkUrl } from "./urls";
import { assertDealPayment, requireDealId } from "./dealPayment";
import { resolveDealChargeId } from "./escrow";
import { brandConfirmTokenMatches, mintBrandConfirmToken } from "./brandToken";

const logger = createLogger("payments/settle");

const DAY_MS = 86_400_000;

export interface MarkDeliveredResult {
  settled:       boolean;
  /** True when the brand was emailed its confirm link. The link itself is never returned to the athlete. */
  brandNotified: boolean;
  windowEndsAt:  string | null;
}

/**
 * Athlete marks the deliverable done → opens the brand's confirmation window and emails
 * the brand (only) a fresh confirm link. Calling it again re-sends a new link (the old
 * one stops working).
 */
export async function markDeliveredByAthlete(dealId: string, athleteId: string): Promise<MarkDeliveredResult> {
  const [p] = await db.select().from(payments)
    .where(and(eq(payments.deal_id, dealId), eq(payments.athlete_id, athleteId), eq(payments.kind, "deal_payment"))).limit(1);
  if (!p) throw coded("PAYMENT_NOT_FOUND");
  if (p.status === "settled") return { settled: true, brandNotified: false, windowEndsAt: p.delivery_window_ends_at?.toISOString() ?? null };
  if (p.status !== "funded") throw coded("NOT_FUNDED", { status: p.status });

  const windowEnds = p.delivery_window_ends_at ?? new Date(Date.now() + PAYMENTS.confirmationWindowDays * DAY_MS);
  const { token, hash } = mintBrandConfirmToken();
  await db.update(payments).set({
    athlete_confirmed_at:     p.athlete_confirmed_at ?? new Date(),
    delivery_window_ends_at:  windowEnds,
    brand_confirm_token_hash: hash,
    updated_at:               new Date(),
  }).where(eq(payments.id, p.id));
  await db.update(deals).set({ payment_status: "delivered_pending_confirmation" }).where(eq(deals.id, dealId));

  // If the brand somehow already confirmed, release now (a failure is retried by the sweep).
  if (p.brand_confirmed_at) {
    const settled = await trySettle(p.id);
    return { settled, brandNotified: false, windowEndsAt: windowEnds.toISOString() };
  }

  const brandNotified = await emailBrandConfirmLink(p.id, dealId, athleteId, p.brand_email, token, windowEnds, p.deal_value_cents);
  logger.info({ dealId, paymentId: p.id, brandNotified }, "athlete marked delivered — awaiting brand confirmation");
  return { settled: false, brandNotified, windowEndsAt: windowEnds.toISOString() };
}

async function emailBrandConfirmLink(
  paymentId: string, dealId: string, athleteId: string, brandEmail: string | null,
  token: string, windowEnds: Date, amountCents: number | null,
): Promise<boolean> {
  if (!brandEmail) {
    logger.warn({ paymentId }, "no brand email captured at Checkout — confirm link not sent (auto-release still applies)");
    return false;
  }
  const [a] = await db.select({ name: athletes.full_name }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  const [d] = await db.select({ brand: deals.brand_name }).from(deals).where(eq(deals.id, dealId)).limit(1);
  const athleteName = a?.name?.trim() || "The athlete";
  const usd = ((amountCents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const by = windowEnds.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const url = confirmLinkUrl(paymentId, token);
  const subject = `${athleteName} marked your ${d?.brand ?? "deal"} work as delivered`;
  const text = `${athleteName} marked the agreed work as delivered. Confirm delivery or raise an issue here: ${url}\n\n`
    + `If we don't hear from you by ${by}, the ${usd} deal payment is released to ${athleteName} automatically.`;
  const html = `<p>${htmlEscape(athleteName)} marked the agreed work${d?.brand ? ` for ${htmlEscape(d.brand)}` : ""} as delivered.</p>`
    + `<p><a href="${htmlEscape(url)}">Confirm delivery or raise an issue</a></p>`
    + `<p>If we don't hear from you by ${htmlEscape(by)}, the ${htmlEscape(usd)} deal payment is released to ${htmlEscape(athleteName)} automatically.</p>`;
  const r = await sendEmail({ to: brandEmail, subject, html, text });
  return r.sent;
}

export type BrandConfirmResult = { ok: boolean; settled: boolean; message: "released" | "confirmed" | "already released" | "not found" | "not payable" };

/**
 * Brand confirms delivery via the hosted link. Requires the brand-only token. Releases
 * if the athlete already confirmed; a release that cannot happen yet (payout account not
 * ready, Stripe error) is still a recorded confirmation and is retried by the sweep.
 */
export async function confirmDeliveryByBrand(paymentId: string, token: unknown): Promise<BrandConfirmResult> {
  const [p] = await db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.kind, "deal_payment"))).limit(1);
  if (!p || !brandConfirmTokenMatches(token, p.brand_confirm_token_hash)) return { ok: false, settled: false, message: "not found" };
  if (p.status === "settled") return { ok: true, settled: true, message: "already released" };
  if (p.status !== "funded") return { ok: false, settled: false, message: "not payable" };

  await db.update(payments).set({ brand_confirmed_at: p.brand_confirmed_at ?? new Date(), updated_at: new Date() }).where(eq(payments.id, p.id));

  if (p.athlete_confirmed_at) {
    const settled = await trySettle(p.id);
    return { ok: true, settled, message: settled ? "released" : "confirmed" };
  }
  return { ok: true, settled: false, message: "confirmed" };
}

/** Brand raises an issue instead of confirming — flags a dispute and blocks auto-release. Requires the brand-only token. */
export async function disputeDeliveryByBrand(paymentId: string, token: unknown): Promise<{ ok: boolean }> {
  const [p] = await db.select({ hash: payments.brand_confirm_token_hash }).from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.kind, "deal_payment"))).limit(1);
  if (!p || !brandConfirmTokenMatches(token, p.hash)) return { ok: false };
  const claimed = await db.update(payments).set({
    status: "disputed",
    // Marks the BRAND's delivery dispute (vs a card chargeback, stripe_dispute_id) so a won chargeback can't erase it.
    metadata: sql`coalesce(${payments.metadata}, '{}'::jsonb) || jsonb_build_object('delivery_disputed_at', now())`,
    updated_at: new Date(),
  })
    .where(and(eq(payments.id, paymentId), eq(payments.kind, "deal_payment"), eq(payments.status, "funded")))
    .returning({ dealId: payments.deal_id });
  if (claimed.length === 0) return { ok: false };
  await db.update(deals).set({ payment_status: "disputed" }).where(eq(deals.id, requireDealId(claimed[0].dealId, paymentId)));
  logger.warn({ paymentId, dealId: claimed[0].dealId }, "brand disputed delivery — auto-release blocked");
  return { ok: true };
}

/** Is a payment the brand can see on its confirm page (valid token)? Used by the hosted page. */
export async function loadBrandConfirmView(paymentId: string, token: unknown): Promise<null | { status: string; brand: string | null; amountCents: number }> {
  const [p] = await db.select({ status: payments.status, dealId: payments.deal_id, amount: payments.deal_value_cents, hash: payments.brand_confirm_token_hash })
    .from(payments).where(and(eq(payments.id, paymentId), eq(payments.kind, "deal_payment"))).limit(1);
  if (!p || !brandConfirmTokenMatches(token, p.hash)) return null;
  const [d] = await db.select({ brand: deals.brand_name }).from(deals).where(eq(deals.id, requireDealId(p.dealId, paymentId))).limit(1);
  return { status: p.status, brand: d?.brand ?? null, amountCents: p.amount ?? 0 };
}

/** Settle, recording (not throwing) a failure so the sweep retries it. */
async function trySettle(paymentId: string): Promise<boolean> {
  try {
    return await settleDealPayment(paymentId);
  } catch (err: any) {
    const reason = `settle_failed:${err.code ?? "ERROR"}`;
    await db.update(payments).set({ failure_reason: reason, updated_at: new Date() })
      .where(and(eq(payments.id, paymentId), eq(payments.status, "funded")));
    logger.warn({ paymentId, code: err.code, error: err.message }, "release not possible yet — the payments sweep will retry");
    return false;
  }
}

/**
 * Due for release: funded deal payments the athlete marked delivered, where the brand
 * confirmed OR the confirmation window elapsed with the brand silent. `disputed` rows are
 * excluded by status.
 */
function dueForRelease(now: Date) {
  return and(
    eq(payments.kind, "deal_payment"),
    eq(payments.status, "funded"),
    isNotNull(payments.athlete_confirmed_at),
    or(
      isNotNull(payments.brand_confirmed_at),
      and(isNotNull(payments.delivery_window_ends_at), lte(payments.delivery_window_ends_at, now)),
    ),
  );
}

/** Sweep: retry every due release. Each failure is recorded and retried next run. */
export async function releaseDuePayments(now: Date = new Date(), athleteId?: string): Promise<{ released: number; failed: number }> {
  const where = athleteId ? and(dueForRelease(now), eq(payments.athlete_id, athleteId)) : dueForRelease(now);
  const due = await db.select({ id: payments.id }).from(payments).where(where);
  let released = 0, failed = 0;
  for (const row of due) (await trySettle(row.id)) ? released++ : failed++;
  return { released, failed };
}

/**
 * Release escrow to the athlete: transfer the deal value; keep the commission.
 * Idempotent + payout-gated. Throws CONNECT_REQUIRED if the athlete hasn't finished
 * onboarding (after a fresh status check with Stripe) — the deal stays funded so a
 * retry settles once she does.
 */
export async function settleDealPayment(paymentId: string): Promise<boolean> {
  const [p] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!p || p.kind !== "deal_payment") return false;
  assertDealPayment(p);
  if (p.status === "settled") return true;
  if (p.status !== "funded") { logger.info({ paymentId, status: p.status }, "settle: not funded — no-op"); return false; }
  if (p.deal_value_cents == null) return false;

  const acct = await assertPayoutReady(p.athlete_id); // throws CONNECT_REQUIRED if not payout-ready

  // Always source the transfer from the brand's charge, so it never draws on the
  // platform's *available* balance while card/ACH funds are still pending. The charge id
  // may not have been on any funding event we saw (event order) — fetch it if missing.
  const chargeId = await resolveDealChargeId(p.id);
  if (!chargeId) throw coded("CHARGE_UNKNOWN", { paymentId: p.id });

  const stripe = getStripe();
  // A transfer from an earlier attempt whose DB write failed (the idempotency key alone
  // only protects for 24h): adopt it instead of paying twice.
  const since = p.created_at ? Math.floor(p.created_at.getTime() / 1000) - 60 : undefined;
  const prior = await stripe.transfers.list({ destination: acct.stripe_account_id, limit: 100, ...(since ? { created: { gte: since } } : {}) });
  const existing = prior.data.find((t) => t.metadata?.payment_id === p.id && t.metadata?.kind === "deal_settlement");

  // A credited Serious-offer hold (seriousOffer.ts) paid part of this deal with its OWN charge: she receives that part
  // from that charge and the rest from this one, so each transfer stays within the charge it is sourced from.
  const credit = p.credit_cents && p.credit_payment_id
    ? (await db.select().from(payments).where(eq(payments.id, p.credit_payment_id)).limit(1))[0] ?? null
    : null;
  const creditCents = credit ? (p.credit_cents ?? 0) : 0;
  if (credit && !credit.stripe_charge_id) throw coded("CHARGE_UNKNOWN", { paymentId: credit.id });
  const mainCents = p.deal_value_cents - creditCents;

  const transfer = existing ?? (mainCents > 0 ? await stripe.transfers.create(
    {
      amount:             mainCents,
      currency:           p.currency,
      destination:        acct.stripe_account_id,
      source_transaction: chargeId,
      metadata:           { kind: "deal_settlement", payment_id: p.id, deal_id: p.deal_id },
    },
    { idempotencyKey: `settle_${p.id}` },
  ) : null);

  if (credit && credit.status !== "settled") {
    const priorCredit = prior.data.find((t) => t.metadata?.payment_id === credit.id && t.metadata?.kind === "deal_settlement_credit");
    const creditTransfer = priorCredit ?? await stripe.transfers.create(
      {
        amount:             creditCents,
        currency:           p.currency,
        destination:        acct.stripe_account_id,
        source_transaction: credit.stripe_charge_id!,
        metadata:           { kind: "deal_settlement_credit", payment_id: credit.id, deal_payment_id: p.id, deal_id: p.deal_id },
      },
      { idempotencyKey: `settle_credit_${credit.id}` },
    );
    await db.update(payments).set({ status: "settled", stripe_transfer_id: creditTransfer.id, destination_account_id: acct.stripe_account_id, updated_at: new Date() })
      .where(eq(payments.id, credit.id));
  }

  await db.update(payments).set({
    status:                 "settled",
    stripe_transfer_id:     transfer?.id ?? null,
    destination_account_id: acct.stripe_account_id,
    failure_reason:         null,
    updated_at:             new Date(),
  }).where(eq(payments.id, p.id));
  await db.update(deals).set({ payment_status: "settled" }).where(eq(deals.id, p.deal_id));

  logger.info({ paymentId, dealId: p.deal_id, transferId: transfer?.id ?? null, amount: p.deal_value_cents, creditCents, adopted: !!existing }, "escrow released to athlete");
  return true;
}

/** Webhook backstop: transfer.created — the DB is already updated by settleDealPayment; log to confirm. */
export async function handleTransferCreated(transfer: Stripe.Transfer): Promise<void> {
  if (transfer.metadata?.kind !== "deal_settlement") return;
  logger.info({ transferId: transfer.id, paymentId: transfer.metadata.payment_id }, "transfer.created — settlement confirmed by Stripe");
}

function coded(code: string, detail?: unknown): Error & { code: string; detail?: unknown } {
  const err = new Error(code) as Error & { code: string; detail?: unknown };
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}
