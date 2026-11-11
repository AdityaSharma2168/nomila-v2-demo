/**
 * agent/postKit/render/cleanupRoutes.ts — POST /api/internal/post-kit-preview-cleanup-cron, called by Cloud Scheduler
 * daily at 03:30 UTC (scripts/provision-schedulers.sh, post-kit-preview-cleanup-cron): one pass of render/cleanup.ts —
 * superseded preview rows soft-deleted after 24 h, their files deleted after 7 days. It answers {ok:true, enabled:false}
 * and does nothing unless AGENT_POST_KIT_PREVIEW_CLEANUP is "true". Protected by the CRON_SECRET header:
 * `cronSecretValid` is the app's own (server/index.ts passes it in).
 */
import { Router, type Request, type Response } from "express";
import { createLogger } from "../../../logger";
import { agentPostKitPreviewCleanupEnabled } from "../config";
import { sweepPreviewCleanup } from "./cleanup";

const logger = createLogger("agent/postKit/render/cleanupRoutes");

export function previewCleanupCronRouter(cronSecretValid: (req: Request) => boolean, sweep: () => ReturnType<typeof sweepPreviewCleanup> = () => sweepPreviewCleanup()): Router {
  const r = Router();
  r.post("/api/internal/post-kit-preview-cleanup-cron", async (req: Request, res: Response) => {
    if (!cronSecretValid(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!agentPostKitPreviewCleanupEnabled()) { res.json({ ok: true, enabled: false }); return; }
    try {
      res.json({ ok: true, enabled: true, ...(await sweep()) });
    } catch (err: any) {
      logger.error({ error: String(err?.message ?? err).slice(0, 300) }, "post-kit preview clean-up failed");
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return r;
}
