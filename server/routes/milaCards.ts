/**
 * routes/milaCards.ts — the card system v2's taps (MILA_CARDS_V2, dev only; design "Mila card designs" v2.2, "What
 * every tap records"):
 *
 *   POST /api/v1/me/mila/cards/outcome   { card, ref, outcome, action?, choice?, reason?, lasting? } → { receipt }
 *                                         (card "content": ⋯ Not now / Not for me on a made post, with "Tell Mila why")
 *   GET  /api/v1/me/mila/cards/surface   → { briefing, capabilities }: the cards Home's briefing and Me's "What Mila can
 *                                         do" show (agent/milaCards/surface.ts)
 *
 * Records what the athlete tapped (accepted / edited / not now / never, or "seen" for the 7-day ignored rule) in the
 * existing memory_decisions columns, and for a One-time question saves the chosen rule as a memory_preferences row
 * (agent/milaCards/outcomes.ts). Nothing here sends, posts or pays. The athlete is the session's (requireAuth); `ref`
 * must be one of their own decision rows, else 404. With the flag off the route answers 404, as if it were not there.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { milaCardsV2Enabled } from "../agent/milaCards/config";
import { cardOutcomeBody, recordOutcome, type OutcomeDeps } from "../agent/milaCards/outcomes";
import type { AgentStore } from "../agent/research/store";
import type { CardMediaDeps } from "../agent/milaCards/media";

const logger = createLogger("routes/milaCards");

export function milaCardsRouter(deps: { store?: AgentStore; outcome?: OutcomeDeps; media?: CardMediaDeps } = {}): Router {
  const router = Router();
  router.post("/mila/cards/outcome", requireAuth, async (req: Request, res: Response): Promise<void> => {
    if (!milaCardsV2Enabled()) { res.status(404).json({ error: "Not found" }); return; }
    const body = cardOutcomeBody.safeParse(req.body ?? {});
    if (!body.success) { res.status(400).json({ error: "Invalid card outcome" }); return; }
    try {
      const store = deps.store ?? (await import("../agent/research/dbStore")).dbStore;
      const outcome: OutcomeDeps = deps.outcome ?? { addPreference: async (athleteId, p) => (await import("../agent/memory")).addPreference(athleteId, p) };
      const r = await recordOutcome(store, req.athleteId!, body.data, outcome);
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      res.json({ receipt: r.receipt });
    } catch (err) {
      logger.error({ err, card: body.data.card }, "mila card outcome failed");
      res.status(500).json({ error: "Could not save that" });
    }
  });
  router.get("/mila/cards/surface", requireAuth, async (req: Request, res: Response): Promise<void> => {
    if (!milaCardsV2Enabled()) { res.status(404).json({ error: "Not found" }); return; }
    try {
      const store = deps.store ?? (await import("../agent/research/dbStore")).dbStore;
      const { cardSurface } = await import("../agent/milaCards/surface");
      const media = deps.media ?? (await import("../agent/milaCards/media")).dbCardMediaDeps;
      res.json(await cardSurface(store, req.athleteId!, { media }));
    } catch (err) {
      logger.error({ err }, "mila card surface failed");
      res.status(500).json({ error: "Could not load cards" });
    }
  });
  return router;
}

export default milaCardsRouter();
