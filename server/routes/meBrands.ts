/**
 * meBrands.ts — "Confirm this is [brand]" (PR 4's tap), thin wrappers over services/brandConfirmation.ts. HER act,
 * so athlete-authenticated (requireAuth); the athlete is the token's, never the client's, and every brand must be
 * the brand of one of HER opportunities (404 otherwise — another athlete's brand is indistinguishable from none).
 *
 *   GET  /me/brands/:brandId/candidate   read-only: what research proposes { name, domain, logoUrl, basis }, or her
 *                                        earlier answer, or nothing (then a capped background lookup may start)
 *   POST /me/brands/:brandId/confirm     { domain } → her governed assertion, domain set, identity + imagery job
 *   POST /me/brands/:brandId/not_this    { domain } → her rejection; that candidate is not offered to her again
 *
 * 200 · 400 invalid_domain · 404 not_your_brand · 409 agency / domain_mismatch / domain_held.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { confirmBrand, getBrandCandidate, rejectBrandCandidate, type StatementResult } from "../services/brandConfirmation";

const logger = createLogger("routes/me-brands");
const router = Router();

const STATUS: Record<string, number> = { invalid_domain: 400, not_your_brand: 404, agency: 409, domain_mismatch: 409, domain_held: 409 };
const brandIdOf = (req: Request): number | null => {
  const n = Number(req.params.brandId);
  return Number.isInteger(n) && n > 0 ? n : null;
};
function send(res: Response, r: StatementResult): void {
  if (r.ok) { res.status(200).json(r); return; }
  res.status(STATUS[r.reason] ?? 409).json(r);
}

router.get("/brands/:brandId/candidate", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const brandId = brandIdOf(req);
  if (!brandId) { res.status(404).json({ ok: false, reason: "not_your_brand" }); return; }
  try {
    const view = await getBrandCandidate(req.athleteId!, brandId);
    if (!view) { res.status(404).json({ ok: false, reason: "not_your_brand" }); return; }
    res.json(view);
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, brandId, error: err?.message }, "brand candidate read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

for (const [path, act] of [["confirm", confirmBrand], ["not_this", rejectBrandCandidate]] as const) {
  router.post(`/brands/:brandId/${path}`, requireAuth, async (req: Request, res: Response): Promise<void> => {
    const brandId = brandIdOf(req);
    if (!brandId) { res.status(404).json({ ok: false, reason: "not_your_brand" }); return; }
    try {
      send(res, await act(req.athleteId!, brandId, (req.body ?? {}).domain));
    } catch (err: any) {
      logger.error({ athleteId: req.athleteId, brandId, action: path, error: err?.message }, "brand statement failed");
      res.status(500).json({ error: "Internal server error" });
    }
  });
}

export default router;
