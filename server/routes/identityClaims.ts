/**
 * routes/identityClaims.ts — "Is this you?" (Phase A Step 3b; plan §3b §9). Pre-link: requireFirebaseUser only.
 *
 *   POST /identity/claims/:id/confirm { claimSessionId }   the §3 matrix ⇒ { outcome, athleteId? }
 *   POST /identity/claims/session/:id/dismiss              "none of these" — the caller's proposed claims in that session expire
 *   GET  /identity/claims/mine                             open claims grouped by session (client resume)
 *
 * A claim id and a session id are the only handles; both are validated against the caller's user. No athlete id from the
 * client is ever authority. 404 for a claim that is not the caller's (no existence leak). Dark unless ATHLETE_INDEX_CLAIM.
 */

import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireFirebaseUser } from "../lib/auth";
import { createLogger } from "../logger";
import { confirmClaim, dismissSession, listMine } from "../services/intelligence/identity/claims";
// PR E2b (design record §5.4): claim-links converge on the lifecycle research trigger. No-op unless
// identityResolutionEnabled(); never fatal. Pinned by research/lifecycleHooks.test.ts (exhaustiveness guard).
import { enterLifecycleResearch } from "../services/intelligence/research/lifecycleHooks";
import { athleteIndexClaimEnabled } from "../services/intelligence/identity/config";

const logger = createLogger("routes/identity-claims");
const router = Router();
const limiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function gate(res: Response): boolean { if (!athleteIndexClaimEnabled()) { res.status(404).json({ error: "Not found" }); return false; } return true; }
const callerOf = (req: Request) => ({ uid: req.authUid!, email: req.authEmail ?? null, emailVerified: req.authEmailVerified === true });

router.post("/claims/:id/confirm", requireFirebaseUser, limiter, async (req: Request, res: Response): Promise<void> => {
  if (!gate(res)) return;
  const { id } = req.params; const body = (req.body ?? {}) as Record<string, unknown>;
  const claimSessionId = typeof body.claimSessionId === "string" && UUID.test(body.claimSessionId) ? body.claimSessionId : null;
  if (!UUID.test(id)) { res.status(404).json({ error: "Not found" }); return; }
  try {
    const r = await confirmClaim({ caller: callerOf(req), claimId: id, claimSessionId });
    if (r.outcome === "not_found") { res.status(404).json({ error: "Not found" }); return; }
    if (r.outcome === "expired") { res.status(410).json({ error: "claim_expired" }); return; }
    if (r.outcome === "linked") void enterLifecycleResearch(r.athleteId, "claim");   // PR E2b: "Is this you?" claim-link
    res.json(r);
  } catch (err: any) {
    logger.error({ error: err.message?.slice(0, 200) }, "claim confirm failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/claims/session/:id/dismiss", requireFirebaseUser, limiter, async (req: Request, res: Response): Promise<void> => {
  if (!gate(res)) return;
  const { id } = req.params;
  if (!UUID.test(id)) { res.status(404).json({ error: "Not found" }); return; }
  try { res.json({ expired: await dismissSession(callerOf(req), id) }); }
  catch (err: any) { logger.error({ error: err.message?.slice(0, 200) }, "claim dismiss failed"); res.status(500).json({ error: "Internal server error" }); }
});

router.get("/claims/mine", requireFirebaseUser, async (req: Request, res: Response): Promise<void> => {
  if (!gate(res)) return;
  try { res.json({ sessions: await listMine(callerOf(req)) }); }
  catch (err: any) { logger.error({ error: err.message?.slice(0, 200) }, "claims list failed"); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
