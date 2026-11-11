/**
 * securityHeaders.ts — CASA Tier 2 / OWASP-ASVS HTTP response headers.
 *
 * Applied as the FIRST middleware in server/index.ts so every response (JSON,
 * OAuth-callback HTML, webhooks, 404s) carries the headers a DAST scan and
 * securityheaders.com check for.
 *
 * TLS itself (1.2+, cipher suites, HTTP→HTTPS redirect) is terminated by Google's
 * front end in front of Cloud Run and is not the app's responsibility — but HSTS,
 * CSP, CORP and friends are, and were previously absent.
 *
 * The API is almost entirely JSON. The only HTML it serves is the two OAuth
 * callback pages (server/routes/oauthCallback.ts), which need a per-response CSP
 * with a nonce for their inline <script>/<style> — see `oauthCallbackCsp()`.
 */

import crypto from "crypto";
import helmet from "helmet";
import type { Request, Response, NextFunction } from "express";

// Global, API-wide headers. The CSP here is a JSON-API lockdown: nothing is
// allowed to load, embed, or be framed. Requests that return HTML override the
// CSP per-response via oauthCallbackCsp().
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      "default-src": ["'none'"],
      "frame-ancestors": ["'none'"],
      "base-uri": ["'none'"],
      "form-action": ["'none'"],
      "upgrade-insecure-requests": [],
    },
  },
  // Cross-Origin-Resource-Policy — the finding most commonly flagged as missing.
  // Safe for a fetch/XHR-consumed JSON API: CORP governs no-cors subresource
  // embedding, not CORS-governed fetch(), so first-party web/native clients are
  // unaffected.
  crossOriginResourcePolicy: { policy: "same-origin" },
  crossOriginOpenerPolicy: { policy: "same-origin" },
  referrerPolicy: { policy: "no-referrer" },
  // HSTS: 2 years, include subdomains, preload. Set on api-dev.nomila.co it only
  // binds that host and below — never the apex nomila.co.
  hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
  // X-Frame-Options: DENY (belt-and-suspenders alongside frame-ancestors 'none').
  xFrameOptions: { action: "deny" },
  // X-Content-Type-Options: nosniff and X-Powered-By removal are on by default.
});

/**
 * Per-response CSP for the OAuth callback HTML pages. Those pages carry an inline
 * redirect <script> and inline <style>; instead of 'unsafe-inline' we bind them to
 * a fresh nonce so the CSP stays strict ("no unsafe-inline where avoidable").
 *
 * Call with a nonce, then render the HTML with matching nonce attributes.
 */
export function makeCspNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

export function setOauthCallbackCsp(res: Response, nonce: string): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "img-src 'self' data:",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  );
}

/**
 * Per-response CSP for the Nomi Card HTML (/card, /c). This is a self-contained, server-rendered
 * page whose interpolated data is HTML-escaped — it needs inline <style> + inline <script> (the swipe
 * deck), signed GCS images, an autoplaying video, the brand logo, and the Google-Fonts stylesheet.
 * The global `default-src 'none'` blocks all of that (blank/unstyled card in a WebView), so relax it
 * here. Inline uses 'unsafe-inline' rather than a nonce because the renderer emits large generated
 * <style>/<script> blocks; the page carries no unescaped user input.
 */
export function setCardCsp(res: Response): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "style-src 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com data:",
      "img-src 'self' data: https: blob:",
      "media-src 'self' https: blob:",
      "script-src 'unsafe-inline'",
      "connect-src 'self' https:",   // the share page's dwell-beacon fetch
      "base-uri 'none'",
      "form-action 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  );
}

/**
 * Per-response CSP for the PUBLIC athlete page (/p/:handle and its door pages). Strict: no inline script and no inline
 * style at all. One first-party script bundle (script-src 'self'), our own stylesheet plus the Outfit webfont, images
 * and media from this origin (the media proxy) or the signed-URL bucket it redirects to, and fetches to this origin
 * only (the later Mila and counter endpoints). Forms post only to this origin (the Partner no-script form).
 */
export function setPublicPageCsp(res: Response): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: https://storage.googleapis.com",
      "media-src 'self' https://storage.googleapis.com",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  );
}

/**
 * Per-response CSP for the account-less money pages (/pay messages, /confirm). No script
 * at all — the confirm page is plain HTML forms that POST back to this origin — so even an
 * escaping slip cannot execute. Inline style attributes only; no referrer, so the brand's
 * confirm token in the URL never leaks to another origin.
 */
export function setHostedFormCsp(res: Response): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

/** HTML-escape untrusted values before interpolating into a served HTML page. */
export function htmlEscape(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Final Express error handler + 404. Mount AFTER all routes. Returns a generic
 * message (never err.message / stack / internal paths) to the client while the
 * full error is logged server-side with a request id the caller can quote.
 */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found" });
}
