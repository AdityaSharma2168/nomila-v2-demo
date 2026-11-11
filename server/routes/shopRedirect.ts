/**
 * routes/shopRedirect.ts — GET /go/:code, the public click redirect for her picks (docs/design/shop-her-picks.md §5.1).
 *
 * At the ROOT, like /c/:shareId — never under /api/v1/me (nothing about it is authenticated). Per-IP limiter kept in
 * memory only. A live pick of an open shelf → 302 to HER link and one more click on today's count. Every miss (unknown,
 * hidden, draft, a closed shelf, the flag off, a malformed code) is the same plain 404, so codes can't be probed. The
 * response carries nothing but the redirect. Nothing about the fan — IP, user agent, referrer — is stored.
 */
import { Router, type Request, type Response } from "express";
import { shopRedirectLimiter } from "../lib/rateLimit";
import { createLogger } from "../logger";
import { resolveClick } from "../services/shop/publicShelf";

const logger = createLogger("routes/shop-redirect");
const router = Router();

router.get("/go/:code", shopRedirectLimiter, async (req: Request, res: Response): Promise<void> => {
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex, nofollow");
  try {
    const url = await resolveClick(String(req.params.code ?? ""));
    if (!url) { res.status(404).type("text/plain").send("Not found"); return; }
    res.redirect(302, url);
  } catch (err: any) {
    logger.warn({ error: err?.message?.slice(0, 120) }, "shop redirect failed");
    res.status(404).type("text/plain").send("Not found");
  }
});

export default router;
