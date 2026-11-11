/**
 * meStory.ts — Concept 0.4 "My Story" (athlete-only read; no write path).
 *
 *   GET /me/story   IdentityIntelligenceView (identity-intelligence/0.2), built by
 *                   services/intelligence/identityIntelligence/view.ts. This route only serialises.
 *
 * Tenancy: athleteId comes from the token only. Read-only: no writes, no provider call. Behind
 * IDENTITY_INTELLIGENCE_ENABLED: off ⇒ 200 { pageState: "unavailable" }.
 * 200 → IdentityIntelligenceView · 401 → unauthenticated · 500 → { error }.
 */

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { buildIdentityIntelligenceView } from "../services/intelligence/identityIntelligence/view";

const logger = createLogger("routes/meStory");
const router = Router();

router.get("/story", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await buildIdentityIntelligenceView(req.athleteId!));
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err.message }, "my story read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
