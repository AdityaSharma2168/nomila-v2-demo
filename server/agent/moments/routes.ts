/**
 * agent/moments/routes.ts — POST /api/internal/moments-scan-cron, called by Cloud Scheduler daily at 12:00 UTC
 * (scripts/provision-schedulers.sh, moments-scan-cron): the weekly moments scan's sweep — a scan for every athlete with a
 * current Brief and none in the last 7 days. It only starts moments_scan runs (the workflow tick runs them); it answers
 * {ok:true, enabled:false} and starts nothing unless AGENT_MOMENTS is "true". Protected by the CRON_SECRET header:
 * `cronSecretValid` is the app's own (server/index.ts passes it in), so this file adds no second copy of the check.
 */
import { Router, type Request, type Response } from "express";
import { createLogger } from "../../logger";
import { agentMomentsEnabled } from "./config";
import { sweepMomentsScan } from "./triggers";

const logger = createLogger("agent/moments/routes");

export function momentsCronRouter(cronSecretValid: (req: Request) => boolean, sweep: typeof sweepMomentsScan = sweepMomentsScan): Router {
  const r = Router();
  r.post("/api/internal/moments-scan-cron", async (req: Request, res: Response) => {
    if (!cronSecretValid(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
    try {
      res.json({ ok: true, enabled: agentMomentsEnabled(), ...(await sweep()) });
    } catch (err: any) {
      logger.error({ error: String(err?.message ?? err).slice(0, 300) }, "moments scan sweep failed");
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return r;
}
