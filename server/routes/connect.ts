/**
 * connect.ts — athlete Stripe Connect onboarding + status (all requireAuth).
 * Mounted at /api/v1/me. Payout is hard-gated on onboarding (plan §2.3).
 */

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { createOnboardingLink, getConnectStatus } from "../services/payments/connect";

const logger = createLogger("routes/connect");
const router = Router();

// POST /api/v1/me/connect/onboard — get-or-create the athlete's payout account and
// return a hosted Stripe onboarding URL. The client opens it; account.updated syncs status.
router.post("/connect/onboard", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { url } = await createOnboardingLink(req.athleteId!);
    res.json({ url });
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err.message }, "connect onboard failed");
    res.status(502).json({ error: "could not start onboarding" });
  }
});

// GET /api/v1/me/connect/status — payout capability flags for the onboarding banner.
router.get("/connect/status", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await getConnectStatus(req.athleteId!));
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err.message }, "connect status failed");
    res.status(500).json({ error: "failed" });
  }
});

export default router;
