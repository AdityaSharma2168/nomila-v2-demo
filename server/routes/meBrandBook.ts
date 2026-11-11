/**
 * meBrandBook.ts — the athlete's brand book (services/brandBook; BRAND_BOOK_V1 retired 2 Nov 2026). HER book, so
 * athlete-authenticated (requireAuth); the athlete is the token's, never the client's.
 *
 *   GET  /me/brand-book          the book as the app shows it (signed images), or status "none"
 *   POST /me/brand-book          her tap: write (or rewrite) it — runs in the background, 202 { status: "building" }
 *   POST /me/brand-book/line     { page, slot, index } → that slot shows another of its stored options (no model)
 *   POST /me/brand-book/reel     her tap: make the motion version — runs in the background, 202 { reel }
 *
 * 404 when the flag is off (the feature does not exist yet). 409 no_book when a line or reel is asked of no book.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { chooseLine, readBrandBook, startBookReel, startBrandBook } from "../services/brandBook";

const logger = createLogger("routes/me-brand-book");
const router = Router();

const fail = (req: Request, res: Response, err: any, what: string) => {
  logger.error({ athleteId: req.athleteId, error: String(err?.message ?? err).slice(0, 200) }, what);
  res.status(500).json({ error: "Internal server error" });
};

router.get("/brand-book", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try { res.json(await readBrandBook(req.athleteId!)); } catch (err) { fail(req, res, err, "brand book read failed"); }
});

router.post("/brand-book", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try { res.status(202).json(await startBrandBook(req.athleteId!)); } catch (err) { fail(req, res, err, "brand book start failed"); }
});

router.post("/brand-book/line", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { page, slot, index } = (req.body ?? {}) as { page?: unknown; slot?: unknown; index?: unknown };
  if (typeof page !== "string" || typeof slot !== "string" || !Number.isInteger(index)) {
    res.status(400).json({ error: "page, slot and index are required" });
    return;
  }
  try {
    const ok = await chooseLine(req.athleteId!, page, slot, index as number);
    if (!ok) { res.status(409).json({ error: "no_such_line" }); return; }
    res.json(await readBrandBook(req.athleteId!));
  } catch (err) { fail(req, res, err, "brand book line failed"); }
});

router.post("/brand-book/reel", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const reel = await startBookReel(req.athleteId!);
    if (!reel) { res.status(409).json({ error: "no_book" }); return; }
    res.status(202).json({ reel });
  } catch (err) { fail(req, res, err, "brand book reel failed"); }
});

export default router;
