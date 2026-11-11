/**
 * routes/shortLink.ts — the short link `{host}/{handle}` → the athlete's public page `/p/{handle}` (302).
 *
 * Answers ONLY on the hosts listed in SHORT_LINK_HOSTS (comma-separated, e.g. "api-dev.nomila.co" on dev). On every
 * other host, and for anything that isn't a published handle, it passes on (next()), so it can never shadow another
 * route: it is mounted last, after every other top-level route. Off (no hosts listed) on prod until the hosting change
 * in its PR description is made.
 *
 * A 302 (not 301): a handle can change or be unpublished, and a permanent redirect would be cached by browsers forever.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { HANDLE_RE } from "./publicPage";
import { RESERVED_HANDLES } from "../services/publicCard/config";
import { publicCardLimiter } from "../lib/rateLimit";

export function shortLinkHosts(): Set<string> {
  return new Set(
    (process.env.SHORT_LINK_HOSTS ?? "")
      .split(",")
      .map((h: string) => h.trim().toLowerCase())
      .filter((h: string) => h.length > 0),
  );
}

export interface ShortLinkOptions {
  /** True when the handle has a published page. Defaults to the public card reader. */
  isPublished?: (handle: string) => Promise<boolean>;
  hosts?: () => Set<string>;
}

export function createShortLinkRouter(opts: ShortLinkOptions = {}): Router {
  const hosts = opts.hosts ?? shortLinkHosts;
  const isPublished =
    opts.isPublished ??
    (async (handle: string) => {
      const { publicCardReader } = await import("../services/publicCard/publicCardReader");
      const r = await publicCardReader.read(handle);
      return r.status === "ok";
    });
  const router = Router();
  router.get("/:handle", (req: Request, res: Response, next: NextFunction) => {
    const allowed = hosts();
    if (!allowed.size || !allowed.has((req.hostname ?? "").toLowerCase())) return next();
    const handle = String(req.params.handle ?? "").toLowerCase();
    if (!HANDLE_RE.test(handle) || RESERVED_HANDLES.has(handle)) return next();
    publicCardLimiter(req, res, async () => {
      try {
        if (!(await isPublished(handle))) return next();
      } catch {
        return next();
      }
      res.setHeader("Cache-Control", "public, max-age=300");
      res.redirect(302, `/p/${encodeURIComponent(handle)}`);
    });
  });
  return router;
}
