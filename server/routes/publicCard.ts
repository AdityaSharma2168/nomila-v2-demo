/**
 * routes/publicCard.ts — the public card's JSON read and media proxy (design-public-card-v3 §11).
 *
 *   GET /api/public/cards/:handle   the published card as JSON (PublicCardPage, shared/publicCard.ts) — for the app's
 *                                   share preview and any client that wants data rather than the /p/:handle page
 *   GET /p/:handle/m/:key           302 to a short-lived signed URL of one published photo or video
 *
 * A PUBLIC SURFACE: it reads only through publicCardReader (publicCard.boundary.test.ts B3 fails the build if this file
 * imports the schema or the db). Mounted only while PUBLIC_CARD is on (server/index.ts), and the reader re-checks the
 * flag on every call.
 *
 *   200  { status: "ok", handle, version, etag, publishedAt, indexable, content }   ETag = the version; max-age=60
 *   304  If-None-Match matches the published version
 *   301  { status: "redirect", to }   an old handle inside its 90 days; Location is the new handle's URL
 *   404  { status: "not_found" }      unknown, unpublished, deleted, malformed or flag off — always the same answer
 *
 * noindex unless she turned on "Let search engines find my card". Per-IP limiter in memory only (no IP is stored).
 */
import { Router, type Request, type Response } from "express";
import { publicCardLimiter } from "../lib/rateLimit";
import { createLogger } from "../logger";
import { signedUrl } from "../lib/mediaStore";
import { mediaObject, read, toPage } from "../services/publicCard/publicCardReader";

const logger = createLogger("routes/public-card");
const router = Router();
const NOT_FOUND = { status: "not_found" } as const;
/** Signed media URLs live 10 minutes; the redirect itself is cached 5. */
const MEDIA_URL_TTL_MS = 10 * 60_000;

router.get("/api/public/cards/:handle", publicCardLimiter, async (req: Request, res: Response): Promise<void> => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  try {
    const r = await read(String(req.params.handle ?? ""));
    if (r.status === "not_found") { res.set("Cache-Control", "no-store"); res.status(404).json(NOT_FOUND); return; }
    if (r.status === "redirect") {
      res.set("Cache-Control", "public, max-age=60");
      res.location(`/api/public/cards/${encodeURIComponent(r.to)}`).status(301).json(r);
      return;
    }
    res.set("Cache-Control", "public, max-age=60");
    res.set("ETag", r.etag);
    if (r.indexable) res.removeHeader("X-Robots-Tag");
    if (req.headers["if-none-match"] === r.etag) { res.status(304).end(); return; }
    res.json(toPage(r));
  } catch (err: any) {
    logger.warn({ error: String(err?.message ?? err).slice(0, 120) }, "public card read failed");
    res.set("Cache-Control", "no-store");
    res.status(404).json(NOT_FOUND);
  }
});

/**
 * GET /p/:handle/m/:key — the media proxy (§11 "Media"). The key must be in the PUBLISHED version of this handle;
 * then a 302 to a short-lived signed URL of the stored object. Every miss is the same plain 404. The object path never
 * reaches the page, and nothing about the visitor is stored.
 */
router.get("/p/:handle/m/:key", publicCardLimiter, async (req: Request, res: Response): Promise<void> => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  try {
    const obj = await mediaObject(String(req.params.handle ?? ""), String(req.params.key ?? ""));
    if (!obj) { res.set("Cache-Control", "no-store"); res.status(404).type("text/plain").send("Not found"); return; }
    const url = await signedUrl(obj.path, MEDIA_URL_TTL_MS);
    res.set("Cache-Control", "private, max-age=300");
    res.redirect(302, url);
  } catch (err: any) {
    logger.warn({ error: String(err?.message ?? err).slice(0, 120) }, "public card media failed");
    res.set("Cache-Control", "no-store");
    res.status(404).type("text/plain").send("Not found");
  }
});

export default router;
