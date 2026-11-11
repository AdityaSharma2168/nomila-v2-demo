/**
 * routes/shopifyApp.ts — the catalog-only Shopify app's own pages (docs/design/shop-her-picks.md §12). Mounted at the
 * root only while SHOP_SHOPIFY_APP (and SHOP_V1) are on.
 *
 *   GET  /shopify/app        the App URL Shopify opens from the store admin. Shopify signs the query (HMAC + timestamp):
 *                            not signed / stale → 401. Not installed → the OAuth grant (read_products only), with a
 *                            signed 10-minute `state` bound to the shop. Installed → a 30-minute session for THAT shop
 *                            (HttpOnly, Secure, SameSite=Lax, HMAC-signed) and the brand page.
 *   GET  /shopify/callback   OAuth return: HMAC, timestamp, shop domain and `state` all checked; the code exchanged;
 *                            the scopes Shopify granted must be exactly read_products; installShop seals the token.
 *   GET  /shopify/brand      the brand page (needs the session): only the athletes who ASKED, Approve / Decline / Revoke
 *                            and a per-athlete code. Nothing else about any athlete is shown.
 *   POST /shopify/brand/decide  the page's form: the session's shop + a CSRF token derived from the session.
 *
 * Why this and not an embedded admin or approve-by-email: Shopify's own signature authenticates the brand; there is no
 * App Bridge script and no email infrastructure; and no athlete directory is ever shown to a brand.
 */
import express, { Router, type Request, type Response } from "express";
import { createHmac, randomBytes } from "node:crypto";
import { createLogger } from "../logger";
import { APP_PATH, CALLBACK_PATH, SHOPIFY_SCOPES, isShopDomain, shopifyConfig, type ShopifyConfig } from "../services/shopify/config";
import { freshTimestamp, signToken, verifyQueryHmac, verifyToken } from "../services/shopify/hmac";
import { exchangeCode, type FetchImpl } from "../services/shopify/admin";
import { installShop, loadShop, type Deps } from "../services/shopify/catalog";
import { decide, requestsFor } from "../services/shopify/approvals";

const logger = createLogger("routes/shopify-app");
const SESSION_COOKIE = "nomila_shopify";
const SESSION_MS = 30 * 60_000;
const STATE_MS = 10 * 60_000;

/** Test seam: the Shopify fetch and the brand resolver. Production leaves both unset. */
export const shopifyAppDeps: { fetchImpl?: FetchImpl; resolveBrand?: Deps["resolveBrand"] } = {};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const plain = (res: Response, status: number, msg: string) => res.status(status).type("text/plain").send(msg);
const csrfFor = (session: string, cfg: ShopifyConfig) => createHmac("sha256", cfg.apiSecret).update(`csrf|${session}`).digest("base64url");

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function setSession(res: Response, shop: string, cfg: ShopifyConfig): string {
  const token = signToken({ shop, kind: "session" }, cfg.apiSecret, SESSION_MS);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", maxAge: SESSION_MS, path: "/shopify" });
  return token;
}

function sessionShop(req: Request, cfg: ShopifyConfig): { shop: string; token: string } | null {
  const token = cookieValue(req, SESSION_COOKIE);
  const p = verifyToken<{ shop?: string; kind?: string }>(token, cfg.apiSecret);
  return p?.kind === "session" && isShopDomain(p.shop) && token ? { shop: p.shop, token } : null;
}

const signedLaunch = (req: Request, cfg: ShopifyConfig): string | null => {
  const q = req.query as Record<string, unknown>;
  if (!verifyQueryHmac(q, cfg.apiSecret) || !freshTimestamp(q.timestamp) || !isShopDomain(q.shop)) return null;
  return q.shop as string;
};

async function brandPage(res: Response, shop: string, session: string, cfg: ShopifyConfig): Promise<void> {
  const row = await loadShop(shop);
  if (!row || row.status !== "installed") { plain(res, 404, "This store hasn't installed the app."); return; }
  const requests = await requestsFor(row.id);
  const nonce = randomBytes(16).toString("base64");
  const csrf = csrfFor(session, cfg);
  res.set("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
  res.set("Cache-Control", "no-store");
  const rows = requests.map((r) => `
    <li><div class="who">${esc(r.athleteName)}<span class="st">${esc(r.status)}</span></div>
      <form method="post" action="/shopify/brand/decide">
        <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="id" value="${esc(r.id)}">
        <input name="code" placeholder="Her code (optional)" value="${esc(r.code ?? "")}" maxlength="40">
        <button name="action" value="approve">Approve</button>
        ${r.status === "approved" ? `<button name="action" value="revoke">Revoke</button>` : `<button name="action" value="decline">Decline</button>`}
      </form></li>`).join("");
  res.type("html").send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Nomila</title>
<style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;color:#0E0E0E}h1{font-size:20px;text-transform:uppercase}p{color:#3A3A3A;line-height:1.45}ul{list-style:none;padding:0}li{border:1px solid #E4E4E2;border-radius:6px;padding:12px;margin:10px 0}.who{font-weight:700;margin-bottom:8px}.st{font-weight:500;color:#6B6B6B;margin-left:8px;text-transform:uppercase;font-size:11px}input{height:36px;border:1px solid #E4E4E2;border-radius:4px;padding:0 8px}button{height:36px;margin-left:6px;border:2px solid #0E0E0E;background:#fff;border-radius:4px;font-weight:800}</style>
<h1>${esc(row.name ?? shop)} on Nomila</h1>
<p>Athletes who asked to feature your products on their Nomila picks. Approve the ones you work with; you can give each a code. Nomila reads your product list only — no orders, no customers — and takes nothing.</p>
${requests.length ? `<ul>${rows}</ul>` : "<p>No requests yet.</p>"}`);
}

export function shopifyAppRouter(): Router {
  const router = Router();

  router.get(APP_PATH, async (req, res) => {
    const cfg = shopifyConfig();
    if (!cfg) { plain(res, 503, "Not configured."); return; }
    const shop = signedLaunch(req, cfg);
    if (!shop) { plain(res, 401, "Open the app from your Shopify admin."); return; }
    try {
      const row = await loadShop(shop);
      if (row?.status === "installed" && row.access_token) {
        const session = setSession(res, shop, cfg);
        await brandPage(res, shop, session, cfg);
        return;
      }
      const state = signToken({ shop, kind: "state" }, cfg.apiSecret, STATE_MS);
      const url = new URL(`https://${shop}/admin/oauth/authorize`);
      url.searchParams.set("client_id", cfg.apiKey);
      url.searchParams.set("scope", SHOPIFY_SCOPES);
      url.searchParams.set("redirect_uri", `${cfg.appUrl}${CALLBACK_PATH}`);
      url.searchParams.set("state", state);
      res.redirect(302, url.toString());
    } catch (err: any) {
      logger.error({ shop, error: err?.message?.slice(0, 160) }, "shopify app launch failed");
      plain(res, 500, "Something went wrong.");
    }
  });

  router.get(CALLBACK_PATH, async (req, res) => {
    const cfg = shopifyConfig();
    if (!cfg) { plain(res, 503, "Not configured."); return; }
    const shop = signedLaunch(req, cfg);
    const state = verifyToken<{ shop?: string; kind?: string }>(req.query.state, cfg.apiSecret);
    if (!shop || state?.kind !== "state" || state.shop !== shop || typeof req.query.code !== "string") { plain(res, 401, "This install link is not valid. Start again from your Shopify admin."); return; }
    try {
      const { accessToken, scope } = await exchangeCode(shop, req.query.code, cfg, shopifyAppDeps.fetchImpl);
      const granted = scope.split(",").map((s) => s.trim()).filter(Boolean);
      if (granted.length !== 1 || granted[0] !== SHOPIFY_SCOPES) { plain(res, 400, "The app may only read products."); return; }
      await installShop(shop, accessToken, scope, cfg, { fetchImpl: shopifyAppDeps.fetchImpl, resolveBrand: shopifyAppDeps.resolveBrand });
      const session = setSession(res, shop, cfg);
      await brandPage(res, shop, session, cfg);
    } catch (err: any) {
      logger.error({ shop, error: err?.message?.slice(0, 160) }, "shopify install failed");
      plain(res, 500, "The install didn't finish. Try again from your Shopify admin.");
    }
  });

  router.get("/shopify/brand", async (req, res) => {
    const cfg = shopifyConfig();
    if (!cfg) { plain(res, 503, "Not configured."); return; }
    const s = sessionShop(req, cfg);
    if (!s) { plain(res, 401, "Open the app from your Shopify admin."); return; }
    try { await brandPage(res, s.shop, s.token, cfg); } catch { plain(res, 500, "Something went wrong."); }
  });

  router.post("/shopify/brand/decide", express.urlencoded({ extended: false, limit: "10kb" }), async (req, res) => {
    const cfg = shopifyConfig();
    if (!cfg) { plain(res, 503, "Not configured."); return; }
    const s = sessionShop(req, cfg);
    if (!s || req.body?.csrf !== csrfFor(s.token, cfg)) { plain(res, 401, "Open the app from your Shopify admin."); return; }
    try {
      const row = await loadShop(s.shop);
      if (!row || row.status !== "installed") { plain(res, 404, "This store hasn't installed the app."); return; }
      await decide(row.id, req.body?.id, req.body?.action, req.body?.code);
      res.redirect(303, "/shopify/brand");
    } catch { plain(res, 500, "Something went wrong."); }
  });

  return router;
}
