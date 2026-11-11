/**
 * askMilaChats.ts — HER side of public Mila: "Chats on your card" (design-public-card-v3 §4 "Transcripts", §12).
 * Mounted under /api/v1/me; every route is requireAuth and reads ONLY her own chats (the athlete id from her token).
 * Behind PUBLIC_CARD (off → 404). Not behind ASK_MILA_PUBLIC: if Mila is switched off later she can still read and
 * delete what visitors already said.
 *
 *   GET    /api/v1/me/public-card/chats?before=<iso>   her chats, newest first (30 a page): when, how it opened, turns,
 *                                                      the visitor's first message
 *   GET    /api/v1/me/public-card/chats/:id            one chat: every message as the visitor typed it and as Mila's
 *                                                      answer was shown (after the output gate)
 *   DELETE /api/v1/me/public-card/chats/:id            deletes that chat for good (204); another athlete's id is a 404
 *
 * No visitor identity exists to show: chats carry no IP, user agent or contact detail.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { publicCardEnabled } from "../services/publicCard/flag";
import { deleteChat, getChat, listChats } from "../services/askMila/store";
import { createLogger } from "../logger";

const logger = createLogger("routes/askMilaChats");
const router = Router();

const gate = (_req: Request, _res: Response, next: NextFunction) => (publicCardEnabled() ? next() : next("router"));
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
  fn(req, res).catch((err) => {
    logger.error({ error: (err as Error).message }, "chats on your card failed");
    if (!res.headersSent) res.status(500).json({ error: "Couldn't load the chats." });
  });
};

router.get("/public-card/chats", gate, requireAuth, wrap(async (req, res) => {
  const before = typeof req.query.before === "string" && !isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
  const chats = await listChats(req.athleteId!, { limit: 30, before });
  res.json({ chats, next: chats.length === 30 ? chats[chats.length - 1].startedAt : null });
}));

router.get("/public-card/chats/:id", gate, requireAuth, wrap(async (req, res) => {
  const chat = await getChat(req.athleteId!, req.params.id);
  if (!chat) { res.status(404).json({ error: "Not found." }); return; }
  res.json({ chat });
}));

router.delete("/public-card/chats/:id", gate, requireAuth, wrap(async (req, res) => {
  const ok = await deleteChat(req.athleteId!, req.params.id);
  if (!ok) { res.status(404).json({ error: "Not found." }); return; }
  res.status(204).end();
}));

export default router;
