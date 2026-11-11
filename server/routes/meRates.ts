/**
 * meRates.ts — "Your rates" on Me (deals design §5c; D9 approved 12 Oct 2026; RATES_V1 retired 2 Nov 2026: always on).
 * Her own data only (requireAuth; the athlete is the token's).
 *
 *   GET /me/rates   one row per rate type: Mila's suggested range (onboarding's, stored), her private deal minimum,
 *                   her public booking price, and the guard when a public price sits under her deal minimum
 *   PUT /me/rates   { minimums?: { <rate type>: dollars | null }, prices?: { <booking rate type>: cents } }
 *                   → the same view. 400 { problems } when any field is invalid (nothing is written).
 *
 * Minimums are private: this is the only route that returns them as numbers, to her. A price change writes her live
 * offer of that format, through the offer editor's own validation; it applies to new requests only.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { RatesWriteError, readRates, writeRates } from "../services/rates";

const logger = createLogger("routes/me-rates");
const router = Router();

router.get("/rates", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await readRates(req.athleteId!));
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err?.message }, "rates read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/rates", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await writeRates(req.athleteId!, req.body ?? {}));
  } catch (err: any) {
    if (err instanceof RatesWriteError) { res.status(400).json({ error: "check the highlighted rows", problems: err.problems }); return; }
    logger.error({ athleteId: req.athleteId, error: err?.message }, "rates write failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
