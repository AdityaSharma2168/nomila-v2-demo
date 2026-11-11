/**
 * routes/index.ts — Phase A Step 2c: the Athlete Index candidates endpoint (design §6, §8).
 *
 *   POST /api/v1/index/candidates   body: { name, sport?, teamOrSchool?, classYear?, handles? }
 *
 * Pre-link: guarded by requireFirebaseUser (the identity-provider token only — the caller may not
 * have an athlete row yet, so req.athleteId is never required). Rate-limited per uid. Returns the
 * view's PUBLIC columns plus match score / tier; the body may not carry email or auth keys (400).
 * Dark in 2c: nothing in the app calls it until the Step 3 "Is this you?" UI. Mutates nothing.
 */

import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireFirebaseUser } from "../lib/auth";
import { getIdentityPolicy } from "../services/intelligence/identity/config";
import { findCandidates, publicCandidate } from "../services/intelligence/identity/index";
import { createLogger } from "../logger";

const logger = createLogger("routes/index");
export const indexRouter = Router();

const candidatesLimiter = rateLimit({ windowMs: 60_000, limit: 20, keyGenerator: (req: Request) => req.authUid ?? "unknown", standardHeaders: true, legacyHeaders: false, message: { error: "Too many lookups — give it a moment and try again." } });

const FORBIDDEN_KEYS = ["email", "authId", "auth_id", "uid"];
const PLATFORMS = ["instagram", "tiktok", "youtube", "x", "twitter"];

indexRouter.post("/candidates", requireFirebaseUser, candidatesLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const bad = FORBIDDEN_KEYS.find((k) => k in body);
  if (bad) { res.status(400).json({ error: `${bad} is not an accepted lookup key` }); return; }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  const str = (v: unknown, max = 160) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const handles: Record<string, string> = {};
  if (body.handles && typeof body.handles === "object") for (const p of PLATFORMS) { const h = str((body.handles as any)[p], 64); if (h) handles[p] = h; }
  const classYear = typeof body.classYear === "number" && Number.isInteger(body.classYear) ? body.classYear : null;
  try {
    const policy = await getIdentityPolicy();
    const r = await findCandidates({ name, sport: str(body.sport, 80), teamOrSchool: str(body.teamOrSchool), classYear, handles }, { policy, limit: 5 });
    res.json({ tier: r.tier, ambiguousIdentifier: r.ambiguousIdentifier, candidates: r.candidates.map(publicCandidate) });
  } catch (err: any) {
    logger.error({ error: err.message?.slice(0, 200) }, "index candidates failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default indexRouter;
