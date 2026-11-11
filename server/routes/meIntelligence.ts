/**
 * meIntelligence.ts — Concept 0.4 Slice 2 (athlete-only read; no write path).
 *
 *   GET /me/intelligence   "My Intelligence": the `my-intelligence/0.1` read model (FROZEN; D-1..D-3), built by
 *                          services/intelligence/views/myIntelligence.ts. This route only serialises.
 *
 * Tenancy: athleteId comes from the token only; no path or query parameters. Read-only: no writes, no provider call.
 * 200 → MyIntelligenceView · 401 → unauthenticated (requireAuth) · 500 → { error } (the client keeps its last good data).
 */

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { buildMyIntelligence } from "../services/intelligence/views/myIntelligence";

const logger = createLogger("routes/meIntelligence");
const router = Router();

router.get("/intelligence", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await buildMyIntelligence(req.athleteId!));
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err.message }, "my intelligence read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
