/**
 * routes/financials.ts — her money and her bookings at a glance, read-only (app layout B). Mounted at /api/v1/me.
 *
 *   GET /financials          the Opportunities money strip + the Financials screen (services/moneySummary.ts):
 *                            payouts upcoming / paid, holds in progress, refunds, the payout account's state
 *   GET /bookings/summary    whether the Bookings section shows (a published offer) + her requests and upcoming
 *                            bookings (services/bookings/summary.ts); the empty summary while BOOKINGS_ENABLED is off
 *
 * Nothing here moves money or calls Stripe. requireAuth → the athlete is `req.athleteId`; every query filters it.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { readFinancialSummary } from "../services/moneySummary";
import { readBookingsSummary } from "../services/bookings/summary";

const logger = createLogger("routes/financials");
const router = Router();

router.get("/financials", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await readFinancialSummary(req.athleteId!, new Date()));
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err?.message }, "financials read failed");
    res.status(500).json({ error: "financials read failed" });
  }
});

router.get("/bookings/summary", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await readBookingsSummary(req.athleteId!));
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err?.message }, "bookings summary read failed");
    res.status(500).json({ error: "bookings summary read failed" });
  }
});

export default router;
