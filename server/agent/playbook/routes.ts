/**
 * agent/playbook/routes.ts — POST /api/internal/playbook-refresh-cron, called by Cloud Scheduler monthly
 * (scripts/provision-schedulers.sh, playbook-refresh-cron): the shared content playbook's sweep — refresh every
 * (sport, stage, platform) key in the live roster whose active row is missing or stale. It answers
 * {ok:true, enabled:false} and does nothing unless AGENT_PLAYBOOK is "true". Protected by the CRON_SECRET header:
 * `cronSecretValid` is the app's own (server/index.ts passes it in), so this file adds no second copy of the check.
 */
import { Router, type Request, type Response } from "express";
import { createLogger } from "../../logger";
import { agentPlaybookEnabled } from "./config";
import { sweepPlaybookRefresh } from "./triggers";

const logger = createLogger("agent/playbook/routes");

export function playbookCronRouter(cronSecretValid: (req: Request) => boolean, sweep: typeof sweepPlaybookRefresh = sweepPlaybookRefresh): Router {
  const r = Router();
  r.post("/api/internal/playbook-refresh-cron", async (req: Request, res: Response) => {
    if (!cronSecretValid(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
    try {
      const { outcomes, ...rest } = await sweep();
      res.json({ ok: true, enabled: agentPlaybookEnabled(), ...rest });
    } catch (err: any) {
      logger.error({ error: String(err?.message ?? err).slice(0, 300) }, "playbook refresh sweep failed");
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return r;
}
