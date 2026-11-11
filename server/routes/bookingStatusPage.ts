/**
 * routes/bookingStatusPage.ts — the buyer's private booking page, GET /b/:token (Bookings v2, "Bookings, end to end" PR1).
 *
 * The page every booking email links to (common.ts buyerPageUrl). It is account-less: the token in the path finds the
 * booking, and everything past the first screen needs the access key an email code returns (the JSON API at
 * /api/v1/book, routes/bookingsPublic.ts — this file serves only the page). The page holds no booking data in its HTML:
 * its one nonce'd script reads the API and writes every value with textContent.
 *
 * At the root like /s/:token. Mounted only with BOOKINGS_ENABLED; a token for an athlete off the pilot list, or no
 * booking at all, gets the same plain "Link not found" page, so a link reveals nothing about whether it ever existed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { bookingPublicLimiter } from "../lib/rateLimit";
import { htmlEscape, makeCspNonce } from "../lib/securityHeaders";
import { createLogger } from "../logger";
import { BOOKINGS, bookingsEnabledFor } from "../services/bookings/config";
import { bookingByToken } from "../services/bookings/buyer";

const logger = createLogger("routes/bookingStatusPage");

export function setStatusPageCsp(res: Response, nonce: string): void {
  res.setHeader("Content-Security-Policy", [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    "font-src https://fonts.gstatic.com",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "));
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
}

let template: string | null = null;
function statusPage(nonce: string): string {
  // process.cwd(), as /s/ does: the bundle runs from server_dist, the page ships in server/public.
  template ??= readFileSync(path.join(process.cwd(), "server/public/booking-status.html"), "utf8");
  return template.replace(/__NONCE__/g, nonce);
}

function notFoundPage(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>Link not found</title><body style="font-family:system-ui,sans-serif;background:#15110D;color:#F3EDE3;margin:0;padding:32px 16px">`
    + `<main style="max-width:420px;margin:0 auto"><h1 style="font-size:24px;font-weight:600">Link not found</h1>`
    + `<p>This booking link isn't valid. Open your booking email for the right one.</p>`
    + `<p style="opacity:.7;font-size:13px;margin-top:32px">Questions? ${htmlEscape(BOOKINGS.supportEmail)}</p></main></body></html>`;
}

const router = Router();

router.get("/b/:token", bookingPublicLimiter, async (req: Request, res: Response) => {
  try {
    const b = await bookingByToken(req.params.token).catch(() => null);
    if (!b || !bookingsEnabledFor(b.athlete_id)) {
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.status(404).type("html").send(notFoundPage());
      return;
    }
    const nonce = makeCspNonce();
    setStatusPageCsp(res, nonce);
    res.type("html").send(statusPage(nonce));
  } catch (err: any) {
    logger.error({ error: err?.message }, "booking status page failed");
    res.status(500).type("text").send("Something went wrong. Try again in a moment.");
  }
});

export default router;
