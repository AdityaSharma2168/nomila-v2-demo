/**
 * publicPageLike.ts — the visitor's heart on the Front Door page (/p/:handle). Behind PUBLIC_CARD (read per request):
 * off → the route falls through to the app's 404.
 *
 *   POST /p/:handle/like   { visitor, liked } → 200 { liked }   one like per visitor; tap again to take it back
 *                          400 bad body · 403 cross-site or missing header · 404 no published page · 415 not JSON · 429
 *
 * The visitor holds a random token (the page keeps it in its own storage; no cookie, no account). Only a keyed hash of
 * it is stored, with the athlete id (services/publicPage/stats.ts), so a like links to no person, IP or device. Visitors
 * never see a count. CSRF as on the page's other POSTs (lib/publicPost.ts): JSON only, the custom X-Nomila-Like: 1
 * header (a CORS preflight the app never allows), and same-site when the browser says where the request came from.
 * Plus a per-IP burst limiter. Who the athlete is comes only from the handle, resolved on the server.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { publicLikeLimiter } from "../lib/rateLimit";
import { sameSite } from "../lib/publicPost";
import { publicCardEnabled } from "../services/publicCard/flag";
import { setLike, VISITOR_TOKEN_RE, type LikeResult } from "../services/publicPage/stats";
import { LIKE_HEADER } from "../../shared/publicPageStats";
import { HANDLE_RE } from "./publicPage";
import { createLogger } from "../logger";

const logger = createLogger("routes/publicPageLike");

const gate = (_req: Request, _res: Response, next: NextFunction) => (publicCardEnabled() ? next() : next("router"));

function csrf(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Vary", "Origin");
  if (!req.is("application/json")) { res.status(415).json({ error: "JSON only." }); return; }
  if (req.get(LIKE_HEADER) !== "1" || !sameSite(req)) { res.status(403).json({ error: "Not allowed." }); return; }
  if (!HANDLE_RE.test(req.params.handle ?? "")) { res.status(404).json({ error: "Not found." }); return; }
  next();
}

export type SetLike = (handle: string, token: string, liked: boolean) => Promise<LikeResult>;

/** The router; tests may pass their own store (the app uses the real one). */
export function createPublicPageLikeRouter(opts: { setLike?: SetLike } = {}): Router {
  const write: SetLike = opts.setLike ?? ((h, t, l) => setLike(h, t, l));
  const router = Router();
  router.post("/p/:handle/like", gate, publicLikeLimiter, csrf, async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.visitor !== "string" || !VISITOR_TOKEN_RE.test(b.visitor) || typeof b.liked !== "boolean") {
      res.status(400).json({ error: "Bad request." }); return;
    }
    try {
      const r = await write(req.params.handle, b.visitor, b.liked);
      if (r.status === "not_found") { res.status(404).json({ error: "Not found." }); return; }
      res.json({ liked: r.liked });
    } catch (err) {
      logger.error({ error: String((err as Error)?.message ?? err).slice(0, 200) }, "page like failed");
      res.status(500).json({ error: "That didn't go through. Try again." });
    }
  });
  return router;
}

export default createPublicPageLikeRouter();
