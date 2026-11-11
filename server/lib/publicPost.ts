/**
 * publicPost.ts — the same-site check every visitor POST on /p/:handle runs (public Mila's turns and taps, the page's
 * like). The page is cookieless and these routes act on no ambient credential, so CSRF there is about keeping other
 * sites from driving a visitor's (or an athlete's) limits and counts: each route also requires JSON and its own custom
 * header, which forces a CORS preflight the app's CORS layer never allows.
 */
import type { Request } from "express";

/** The request's own origin, and the public card's (the page may be served under either). */
export function sameSite(req: Request): boolean {
  const site = req.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = req.get("origin");
  if (!origin) return true; // not a browser cross-site request (a browser always sends Origin on a cross-site POST)
  const own = `${req.protocol}://${req.get("host")}`;
  const pub = (process.env.PUBLIC_CARD_BASE_URL ?? "").replace(/\/+$/, "");
  return origin === own || (!!pub && origin === pub);
}
