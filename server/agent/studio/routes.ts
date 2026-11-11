/**
 * agent/studio/routes.ts — the Studio library's own route (mounted under /api/v1/me, requireAuth), dark behind
 * AGENT_V3: while it is off the client's listStudioItems 404s and falls back to the pitches list, exactly as before.
 *
 *   GET /agent/studio/items   { items: StudioItemWire[] } — today's decks + every built post kit (design §9/§12)
 *
 * Tenancy: the athlete id is always req.athleteId (from the token).
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../lib/auth";
import { createLogger } from "../../logger";
import { agentV3Enabled } from "../config";

const logger = createLogger("agent/studio/routes");

export { agentV3Enabled };

export const agentStudioRouter = Router();

agentStudioRouter.get("/agent/studio/items", requireAuth, async (req: Request, res: Response) => {
  try {
    const [{ listStudioItems }, { dbStudioItemsDeps }] = await Promise.all([import("./items"), import("./deps")]);
    res.json({ items: await listStudioItems(req.athleteId!, dbStudioItemsDeps()) });
  } catch (err: any) {
    logger.error({ error: String(err?.message ?? err).slice(0, 300) }, "studio items read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});
