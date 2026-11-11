/**
 * routes/push.ts — her phone's notifications (mounted under /api/v1/me, requireAuth). services/push/push.ts does the work.
 *
 *   POST   /push/devices       { token, platform: ios|android|web, timeZone? } register this phone or browser (once she
 *                                                                         has allowed notifications)
 *   DELETE /push/devices       { token }                                   sign-out: this phone stops getting hers
 *   GET    /push/preferences                                              her choices (defaults when she made none)
 *   PATCH  /push/preferences   { enabled?, planReady?, brandReply?, waiting?, milaSuggestion?, quietHours?, quietStart?, quietEnd?,
 *                                showBrandNames? }
 *
 * Tenancy: the athlete is always req.athleteId (from the token and the selected-profile header, so a phone belongs to the
 * profile in use and moves on a switch); a body never picks an athlete. Registration is rate-limited (10/min per
 * athlete). Registering works while
 * PUSH_NOTIFICATIONS is off (nothing is sent until it is on), so phones are ready the day it is switched on.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { pushRegisterLimiter } from "../lib/rateLimit";
import { createLogger } from "../logger";
import { retryFailedSends, sweepWaiting } from "../services/push/events";
import { checkReceipts, pushEnabled, readPreferences, registerDevice, removeDevice, writePreferences } from "../services/push/push";

const logger = createLogger("routes/push");
const router = Router();
const body = (req: Request) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});

const fail = (res: Response, err: any, what: string, athleteId: string) => {
  logger.error({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, what);
  res.status(500).json({ error: "Internal server error" });
};

router.post("/push/devices", requireAuth, pushRegisterLimiter, async (req: Request, res: Response) => {
  try {
    const b = body(req);
    const ok = await registerDevice(req.athleteId!, { token: b.token, platform: b.platform, timeZone: b.timeZone });
    if (!ok) { res.status(400).json({ error: "a push token and a platform (ios, android or web) are needed", code: "invalid" }); return; }
    res.status(204).end();
  } catch (err) { fail(res, err, "push device register failed", req.athleteId!); }
});

router.delete("/push/devices", requireAuth, async (req: Request, res: Response) => {
  try { res.json({ removed: await removeDevice(req.athleteId!, body(req).token) }); } catch (err) { fail(res, err, "push device remove failed", req.athleteId!); }
});

router.get("/push/preferences", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await readPreferences(req.athleteId!)); } catch (err) { fail(res, err, "push preferences read failed", req.athleteId!); }
});

router.patch("/push/preferences", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await writePreferences(req.athleteId!, body(req))); } catch (err) { fail(res, err, "push preferences write failed", req.athleteId!); }
});

export default router;

/**
 * POST /api/internal/push-receipts-cron — Cloud Scheduler every 30 minutes (scripts/provision-schedulers.sh,
 * push-receipts-cron; declared, not yet provisioned): one pass of checkReceipts, then the one retry of failed
 * brand-reply and waiting sends (events.ts retryFailedSends). Answers {ok:true, enabled:false} and does nothing while
 * PUSH_NOTIFICATIONS is off. Protected by the CRON_SECRET header (`cronSecretValid` is the app's own).
 */
export function pushReceiptsCronRouter(cronSecretValid: (req: Request) => boolean, check: () => Promise<Record<string, unknown>> = async () => ({ ...(await checkReceipts()), ...(await retryFailedSends()), ...(await sweepWaiting()) })): Router {
  const r = Router();
  r.post("/api/internal/push-receipts-cron", async (req: Request, res: Response) => {
    if (!cronSecretValid(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!pushEnabled()) { res.json({ ok: true, enabled: false }); return; }
    try { res.json({ ok: true, enabled: true, ...(await check()) }); } catch (err: any) {
      logger.error({ error: String(err?.message ?? err).slice(0, 300) }, "push receipts check failed");
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return r;
}
