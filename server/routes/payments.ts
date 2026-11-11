/**
 * payments.ts — athlete-authed payment actions (requireAuth). Mounted at /api/v1/me.
 * The account-less brand side lives in routes/{pay,confirm,deposit}.ts (public, hosted).
 */

import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { deals, payments } from "../../shared/schema";
import type { Payment } from "../../shared/schema";
import { receiptOf, refundDealPayment } from "../services/payments/refund";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { requestDealPayment } from "../services/payments/escrow";
import { markDeliveredByAthlete } from "../services/payments/settle";
import { releaseDeposit } from "../services/payments/deposit";
import { depositLinkUrl } from "../services/payments/urls";

const logger = createLogger("routes/payments");
const router = Router();

/** Confirm a deal belongs to the caller; returns false + sends 404 if not. */
async function ownsDeal(req: Request, res: Response, dealId: string): Promise<boolean> {
  const [deal] = await db.select({ id: deals.id }).from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.athlete_id, req.athleteId!))).limit(1);
  if (!deal) { res.status(404).json({ error: "deal not found" }); return false; }
  return true;
}

// POST /api/v1/me/deals/:id/request-payment  { rail?: "card" | "bank" }
// Returns a hosted pay link to drop into the brand thread + the itemized quote.
router.post("/deals/:id/request-payment", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const rail = req.body?.rail === "bank" ? "bank" : "card";
  try {
    const r = await requestDealPayment(req.params.id, req.athleteId!, rail);
    // amount: the figure billed and its source (confirmed | thread | deal_row) — shown to her before she sends the link.
    res.json({ paymentId: r.paymentId, payUrl: r.payUrl, quote: r.quote, amount: r.amount });
  } catch (err: any) {
    switch (err.code) {
      case "DEAL_NOT_FOUND":       res.status(404).json({ error: "deal not found" }); return;
      case "DEAL_NOT_AGREED":      res.status(409).json({ error: "mark the deal agreed before requesting payment", code: "DEAL_NOT_AGREED", status: err.detail?.status ?? null }); return;
      case "INVALID_DEAL_AMOUNT":  res.status(400).json({ error: "deal amount is below the $50 floor or invalid", detail: err.detail }); return;
      case "PAYMENT_ALREADY_ACTIVE": res.status(409).json({ error: "a payment is already in progress for this deal", status: err.detail?.status }); return;
      default:
        logger.error({ dealId: req.params.id, athleteId: req.athleteId, error: err.message }, "request-payment failed");
        res.status(500).json({ error: "failed" });
    }
  }
});

// POST /api/v1/me/deals/:id/mark-delivered — athlete confirms the deliverable is done.
// Opens the brand's confirmation window and returns the hosted confirm link to send.
router.post("/deals/:id/mark-delivered", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const r = await markDeliveredByAthlete(req.params.id, req.athleteId!);
    res.json(r);
  } catch (err: any) {
    switch (err.code) {
      case "PAYMENT_NOT_FOUND": res.status(404).json({ error: "no funded payment for this deal" }); return;
      case "NOT_FUNDED":        res.status(409).json({ error: "payment isn't funded yet", status: err.detail?.status }); return;
      default:
        logger.error({ dealId: req.params.id, athleteId: req.athleteId, error: err.message }, "mark-delivered failed");
        res.status(500).json({ error: "failed" });
    }
  }
});

// POST /api/v1/me/deals/:id/deposit-link — the shareable seriousness-deposit link
// (auto-append into the brand thread / show on the public page).
router.post("/deals/:id/deposit-link", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!(await ownsDeal(req, res, req.params.id))) return;
  res.json({ depositUrl: depositLinkUrl(req.params.id) });
});

// POST /api/v1/me/deals/:id/deposit/release  { reason?: "accepted" | "declined" }
// Release the seriousness hold when the athlete accepts or declines (never captured).
router.post("/deals/:id/deposit/release", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!(await ownsDeal(req, res, req.params.id))) return;
  const reason = req.body?.reason === "declined" ? "declined" : "accepted";
  try {
    const released = await releaseDeposit(req.params.id, reason);
    res.json({ released });
  } catch (err: any) {
    logger.error({ dealId: req.params.id, error: err.message }, "deposit release failed");
    res.status(500).json({ error: "failed" });
  }
});

/** The caller's deal_payment for a deal (tenancy: athlete-scoped; null → 404). */
async function ownDealPayment(req: Request, dealId: string): Promise<Payment | null> {
  const [p] = await db.select().from(payments)
    .where(and(eq(payments.deal_id, dealId), eq(payments.athlete_id, req.athleteId!), eq(payments.kind, "deal_payment"))).limit(1);
  return p ?? null;
}

// GET /api/v1/me/deals/:id/payment — her payment's status + receipt (amounts, refund, chargeback). Read-only.
router.get("/deals/:id/payment", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const p = await ownDealPayment(req, req.params.id);
  if (!p) { res.status(404).json({ error: "no payment for this deal" }); return; }
  res.json({
    paymentId:        p.id,
    status:           p.status,
    currency:         p.currency,
    dealValueCents:   p.deal_value_cents,
    commissionCents:  p.commission_cents,
    processingCents:  p.processing_fee_cents,
    brandTotalCents:  p.brand_total_cents,
    deliveredAt:      p.athlete_confirmed_at?.toISOString() ?? null,
    brandConfirmedAt: p.brand_confirmed_at?.toISOString() ?? null,
    releaseBy:        p.delivery_window_ends_at?.toISOString() ?? null,
    releasedTransfer: p.stripe_transfer_id,
    refund:           p.refunded_cents ? receiptOf(p) : null,
    chargeback:       p.stripe_dispute_id ? { status: p.dispute_status } : null,
  });
});

// POST /api/v1/me/deals/:id/refund  { reason?: string }
// The athlete refunds the brand in full while the money is still held (before release).
// A payment action: only ever called from her explicit tap — never by Mila.
router.post("/deals/:id/refund", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const p = await ownDealPayment(req, req.params.id);
  if (!p) { res.status(404).json({ error: "no payment for this deal" }); return; }
  try {
    const receipt = await refundDealPayment({
      paymentId: p.id, actor: "athlete", athleteId: req.athleteId!,
      reason: typeof req.body?.reason === "string" ? req.body.reason : null,
    });
    res.json({ receipt });
  } catch (err: any) {
    switch (err.code) {
      case "PAYMENT_NOT_FOUND": res.status(404).json({ error: "no payment for this deal" }); return;
      case "ALREADY_RELEASED":  res.status(409).json({ error: "the payment was already released to you — contact support to refund" }); return;
      case "CHARGEBACK_OPEN":   res.status(409).json({ error: "the brand's bank has opened a dispute on this payment" }); return;
      case "NOT_REFUNDABLE":    res.status(409).json({ error: "this payment can't be refunded", status: err.detail?.status }); return;
      default:
        logger.error({ dealId: req.params.id, athleteId: req.athleteId, error: err.message }, "refund failed");
        res.status(502).json({ error: "refund failed" });
    }
  }
});

export default router;
