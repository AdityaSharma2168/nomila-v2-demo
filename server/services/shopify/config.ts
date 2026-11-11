/**
 * shopify/config.ts — the catalog-only Shopify app (docs/design/shop-her-picks.md §12): flag, credentials, constants.
 *
 * SHOP_SHOPIFY_APP gates every Shopify route, the webhook receiver, the reconcile cron and the athlete's "From your
 * brands" routes; it needs SHOP_V1 too. Credentials come from the environment only (Secret Manager → env):
 *   SHOPIFY_API_KEY, SHOPIFY_API_SECRET   the app's client id / secret (Partner dashboard)
 *   SHOPIFY_APP_URL                       this API's public origin, e.g. https://<api host> (redirects + webhooks)
 *   SHOPIFY_API_VERSION                   the Admin API version pinned for every call (default below)
 * Missing credentials ⇒ the routes answer 503; nothing falls back to a default.
 */
import { shopEnabled } from "../shop/config";

export const shopifyAppEnabled = (): boolean => shopEnabled() && process.env.SHOP_SHOPIFY_APP === "true";

/** read_products ONLY: no orders, no customers, no protected customer data. */
export const SHOPIFY_SCOPES = "read_products";
export const DEFAULT_API_VERSION = "2026-07";

export interface ShopifyConfig { apiKey: string; apiSecret: string; appUrl: string; apiVersion: string }

export function shopifyConfig(): ShopifyConfig | null {
  const apiKey = process.env.SHOPIFY_API_KEY?.trim();
  const apiSecret = process.env.SHOPIFY_API_SECRET?.trim();
  const appUrl = process.env.SHOPIFY_APP_URL?.trim().replace(/\/+$/, "");
  if (!apiKey || !apiSecret || !appUrl || !/^https:\/\//.test(appUrl)) return null;
  const apiVersion = process.env.SHOPIFY_API_VERSION?.trim() || DEFAULT_API_VERSION;
  return { apiKey, apiSecret, appUrl, apiVersion: /^\d{4}-\d{2}$/.test(apiVersion) ? apiVersion : DEFAULT_API_VERSION };
}

/** Shopify's own store id: <name>.myshopify.com, and nothing else (it becomes a host we call). */
export const isShopDomain = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/.test(s);

/** The webhooks the app registers on install (GraphQL topic names). The compliance three are set in the app config. */
export const WEBHOOK_TOPICS = ["PRODUCTS_CREATE", "PRODUCTS_UPDATE", "PRODUCTS_DELETE", "APP_UNINSTALLED"] as const;

export const WEBHOOK_PATH = "/api/shopify/webhooks";
export const CALLBACK_PATH = "/shopify/callback";
export const APP_PATH = "/shopify/app";
