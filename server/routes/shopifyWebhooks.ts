/**
 * routes/shopifyWebhooks.ts — POST /api/shopify/webhooks, every webhook the catalog-only Shopify app receives
 * (docs/design/shop-her-picks.md §12). Mounted in server/index.ts BEFORE express.json, with its own raw-body parser:
 * the HMAC is over the exact bytes Shopify sent.
 *
 *   X-Shopify-Hmac-Sha256   base64 HMAC-SHA256 of the raw body under SHOPIFY_API_SECRET, compared in constant time.
 *                           Missing or wrong → 401 and nothing is read.
 *   X-Shopify-Topic         products/create|update|delete · app/uninstalled · customers/data_request ·
 *                           customers/redact · shop/redact (the mandatory compliance three)
 *   X-Shopify-Shop-Domain   <name>.myshopify.com
 *
 * A verified webhook always answers 200 (an ignored topic included), so Shopify doesn't retry what we chose to skip.
 */
import express, { Router } from "express";
import { createLogger } from "../logger";
import { shopifyConfig } from "../services/shopify/config";
import { verifyWebhookHmac } from "../services/shopify/hmac";
import { applyWebhook } from "../services/shopify/catalog";

const logger = createLogger("routes/shopify-webhooks");

export function shopifyWebhooksRouter(): Router {
  const router = Router();
  router.post("/", express.raw({ type: () => true, limit: "2mb" }), async (req, res) => {
    const cfg = shopifyConfig();
    if (!cfg) { res.status(503).end(); return; }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyWebhookHmac(raw, req.get("x-shopify-hmac-sha256"), cfg.apiSecret)) { res.status(401).end(); return; }
    const topic = String(req.get("x-shopify-topic") ?? "");
    const shop = String(req.get("x-shopify-shop-domain") ?? "");
    let payload: unknown = null;
    try { payload = raw.length ? JSON.parse(raw.toString("utf8")) : null; } catch { res.status(200).json({ ok: true, outcome: "ignored" }); return; }
    try {
      const outcome = await applyWebhook(topic, shop, payload);
      logger.info({ topic, shop, outcome }, "shopify webhook");
      res.status(200).json({ ok: true, outcome });
    } catch (err: any) {
      // A failure here is ours: 500 so Shopify retries (every write is an idempotent upsert / delete).
      logger.error({ topic, shop, error: err?.message?.slice(0, 160) }, "shopify webhook failed");
      res.status(500).end();
    }
  });
  return router;
}
