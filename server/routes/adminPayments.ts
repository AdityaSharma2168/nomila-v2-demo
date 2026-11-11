/**
 * adminPayments.ts — admin payment actions (requireAdmin). Mounted at /api/v1/admin/payments.
 *
 * Every route here moves money and is reached only by an admin's explicit call (a human tap
 * in an admin tool) — never by Mila, a pending action or a cron (paymentsTapOnly.test.ts).
 *
 *   POST /:paymentId/refund            { reason? }                 full refund; reverses the transfer first if released
 *   POST /:paymentId/refund-duplicate  { paymentIntentId }         refund a duplicate charge flagged by PR 2
 *   POST /:paymentId/resolve-dispute   { outcome: release|refund, note? }   the brand's DELIVERY dispute
 *   POST /:paymentId/reverse-transfer                              recover the deal value after a lost chargeback
 */

import { Router, type Request, type Response } from "express";
import { requireAdmin } from "../lib/auth";
import { createLogger } from "../logger";
import { refundDealPayment, refundDuplicateCharge, resolveDeliveryDispute, reverseSettlementTransfer } from "../services/payments/refund";

const router = Router();
const logger = createLogger("routes/adminPayments");
router.use(requireAdmin);

const CONFLICT = new Set(["NOT_REFUNDABLE", "CHARGEBACK_OPEN", "NOT_DISPUTED", "NOT_A_DUPLICATE", "NO_TRANSFER"]);
const NOT_FOUND = new Set(["PAYMENT_NOT_FOUND", "DUPLICATE_NOT_FOUND"]);

function fail(res: Response, err: any, what: string, paymentId: string): void {
  if (NOT_FOUND.has(err.code)) { res.status(404).json({ error: err.code }); return; }
  if (CONFLICT.has(err.code)) { res.status(409).json({ error: err.code, detail: err.detail ?? null }); return; }
  logger.error({ paymentId, error: err.message }, `${what} failed`);
  res.status(502).json({ error: `${what} failed` });
}

router.post("/:paymentId/refund", async (req: Request, res: Response): Promise<void> => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
    res.json({ receipt: await refundDealPayment({ paymentId: req.params.paymentId, actor: "admin", reason }) });
  } catch (err: any) { fail(res, err, "refund", req.params.paymentId); }
});

router.post("/:paymentId/refund-duplicate", async (req: Request, res: Response): Promise<void> => {
  const pi = req.body?.paymentIntentId;
  if (typeof pi !== "string" || !pi.startsWith("pi_")) { res.status(400).json({ error: "paymentIntentId required" }); return; }
  try { res.json(await refundDuplicateCharge(req.params.paymentId, pi)); }
  catch (err: any) { fail(res, err, "duplicate refund", req.params.paymentId); }
});

router.post("/:paymentId/resolve-dispute", async (req: Request, res: Response): Promise<void> => {
  const outcome = req.body?.outcome;
  if (outcome !== "release" && outcome !== "refund") { res.status(400).json({ error: "outcome must be release or refund" }); return; }
  try {
    const note = typeof req.body?.note === "string" ? req.body.note : null;
    res.json(await resolveDeliveryDispute(req.params.paymentId, outcome, note));
  } catch (err: any) { fail(res, err, "resolve dispute", req.params.paymentId); }
});

router.post("/:paymentId/reverse-transfer", async (req: Request, res: Response): Promise<void> => {
  try { res.json(await reverseSettlementTransfer(req.params.paymentId)); }
  catch (err: any) { fail(res, err, "transfer reversal", req.params.paymentId); }
});

export default router;
