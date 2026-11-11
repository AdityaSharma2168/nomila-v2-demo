/**
 * adminRelay.ts — the review queue for relayed messages the moderation check held (requireAdmin). Mounted at
 * /api/v1/admin/relay, only while PUBLIC_CARD and PARTNER_INTAKE are both "true".
 *
 *   GET  /held                   held + blocked partner-thread messages, oldest first (with the held text, for review)
 *   POST /messages/:id/release   deliver a held message exactly as if it had been clean (notices included)
 *   POST /messages/:id/block     never deliver it
 * A held message is otherwise never delivered: without this queue, a legitimate message with a link would wait forever.
 */
import { Router, type Request, type Response } from "express";
import { requireAdmin } from "../lib/auth";
import { createLogger } from "../logger";
import { decideHeldMessage, listHeldMessages } from "../services/partner/threads";

const logger = createLogger("routes/adminRelay");
export const adminRelayRouter = Router();
adminRelayRouter.use(requireAdmin);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

adminRelayRouter.get("/held", async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ messages: await listHeldMessages(Number(req.query.limit) || 100) });
});

for (const decision of ["release", "block"] as const) {
  adminRelayRouter.post(`/messages/:id/${decision}`, async (req: Request, res: Response): Promise<void> => {
    if (!UUID.test(req.params.id)) { res.status(404).json({ error: "not found" }); return; }
    const ok = await decideHeldMessage(req.params.id, decision);
    if (!ok) { res.status(404).json({ error: "not a held message" }); return; }
    logger.info({ messageId: req.params.id, decision }, "held relay message reviewed");
    res.json({ ok: true, decision });
  });
}
