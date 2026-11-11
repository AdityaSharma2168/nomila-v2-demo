/**
 * routes/whatMattersNext.ts — GET /api/v1/me/what-matters-next (app layout B): the candidates for Home's ranked
 * "What matters next", gathered across Opportunities, bookings, money and Mila (services/whatMattersNext.ts).
 * Read-only and owner-scoped: the athlete is `req.athleteId`, never the body or the query. The client ranks and words.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { readWhatMattersNext } from "../services/whatMattersNext";

const logger = createLogger("routes/whatMattersNext");
const router = Router();

router.get("/what-matters-next", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await readWhatMattersNext(req.athleteId!, new Date()));
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err?.message }, "what matters next read failed");
    res.status(500).json({ error: "what matters next read failed" });
  }
});

export default router;
