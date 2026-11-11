/**
 * meMiaPreview.ts — the M.I.A. PREVIEW (services/miaPreview/preview.ts), athlete-only.
 *
 *   GET  /me/mia-preview   the preview of record: score, the four groups, preliminary + label, confidence, which inputs
 *                          were public vs measured, what would sharpen it. SELECTs only, no provider call.
 *   POST /me/mia-preview   compute it from her memory now (or reuse the answer for unchanged evidence), then return it.
 *                          At most one evaluator call per distinct evidence state; concurrent requests share one.
 *
 * Tenancy: athleteId comes from the token only; no path, query or body parameter names an athlete.
 * 200 → MiaPreview · 401 → unauthenticated (requireAuth) · 500 → { error }.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { getMiaPreview, readMiaPreview } from "../services/miaPreview/preview";

const logger = createLogger("routes/meMiaPreview");
const router = Router();

router.get("/mia-preview", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await readMiaPreview(req.athleteId!));
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err?.message }, "mia preview read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/mia-preview", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await getMiaPreview(req.athleteId!, { trigger: "USER_REQUESTED_REFRESH", reason: "athlete opened the M.I.A. preview" }));
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err?.message }, "mia preview compute failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
