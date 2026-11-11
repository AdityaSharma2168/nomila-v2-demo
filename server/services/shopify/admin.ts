/**
 * shopify/admin.ts — the only module that talks to Shopify. Every call goes to https://<shop>.myshopify.com (the shop
 * domain is checked before it becomes a host), at the pinned API version, with a 10 s budget. `fetchImpl` is the test
 * seam: no test reaches Shopify.
 *
 *   exchangeCode       OAuth: code → offline access token (+ the scopes Shopify actually granted)
 *   adminGraphql       one Admin GraphQL call
 *   shopInfo           the store's name and primary domain (for the brand link and product URLs)
 *   productsPage       one page of products (catalog fields only)
 *   registerWebhooks   the product + app/uninstalled subscriptions, pointed at our receiver
 */
import { isShopDomain, WEBHOOK_PATH, WEBHOOK_TOPICS, type ShopifyConfig } from "./config";

export type FetchImpl = typeof fetch;
const TIMEOUT_MS = 10_000;

export class ShopifyApiError extends Error {
  constructor(message: string, readonly status: number | null = null) { super(message); this.name = "ShopifyApiError"; }
}

function hostOf(shop: string): string {
  if (!isShopDomain(shop)) throw new ShopifyApiError("not a shop domain");
  return shop;
}

export async function exchangeCode(shop: string, code: string, cfg: ShopifyConfig, fetchImpl: FetchImpl = fetch): Promise<{ accessToken: string; scope: string }> {
  const res = await fetchImpl(`https://${hostOf(shop)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: cfg.apiKey, client_secret: cfg.apiSecret, code }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new ShopifyApiError("token exchange failed", res.status);
  const body: any = await res.json().catch(() => null);
  if (typeof body?.access_token !== "string" || !body.access_token) throw new ShopifyApiError("no access token");
  return { accessToken: body.access_token, scope: typeof body.scope === "string" ? body.scope : "" };
}

export async function adminGraphql<T = any>(shop: string, token: string, query: string, variables: Record<string, unknown>, cfg: ShopifyConfig, fetchImpl: FetchImpl = fetch): Promise<T> {
  const res = await fetchImpl(`https://${hostOf(shop)}/admin/api/${cfg.apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-shopify-access-token": token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new ShopifyApiError("admin api failed", res.status);
  const body: any = await res.json().catch(() => null);
  if (!body || body.errors) throw new ShopifyApiError("admin api returned errors", res.status);
  return body.data as T;
}

export async function shopInfo(shop: string, token: string, cfg: ShopifyConfig, fetchImpl?: FetchImpl): Promise<{ name: string | null; primaryHost: string | null }> {
  const d = await adminGraphql<{ shop?: { name?: string; primaryDomain?: { host?: string } } }>(shop, token, `query { shop { name primaryDomain { host } } }`, {}, cfg, fetchImpl);
  return { name: d.shop?.name ?? null, primaryHost: d.shop?.primaryDomain?.host?.toLowerCase() ?? null };
}

export interface ShopifyProductNode {
  legacyResourceId: string;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  featuredImage: { url: string } | null;
  priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string } } | null;
  variants: { nodes: Array<{ availableForSale: boolean }> };
}

const PRODUCTS = `query Products($after: String) {
  products(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId handle title vendor productType status
      featuredImage { url }
      priceRangeV2 { minVariantPrice { amount currencyCode } }
      variants(first: 10) { nodes { availableForSale } }
    }
  }
}`;

export async function productsPage(shop: string, token: string, after: string | null, cfg: ShopifyConfig, fetchImpl?: FetchImpl): Promise<{ nodes: ShopifyProductNode[]; next: string | null }> {
  const d = await adminGraphql<{ products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyProductNode[] } }>(shop, token, PRODUCTS, { after }, cfg, fetchImpl);
  return { nodes: d.products?.nodes ?? [], next: d.products?.pageInfo?.hasNextPage ? d.products.pageInfo.endCursor : null };
}

const SUBSCRIBE = `mutation Sub($topic: WebhookSubscriptionTopic!, $url: URL!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $url, format: JSON }) {
    userErrors { message }
  }
}`;

/** Registers each topic; a topic that is already registered comes back as a userError and is fine. */
export async function registerWebhooks(shop: string, token: string, cfg: ShopifyConfig, fetchImpl?: FetchImpl): Promise<number> {
  let ok = 0;
  for (const topic of WEBHOOK_TOPICS) {
    const d = await adminGraphql<{ webhookSubscriptionCreate?: { userErrors?: Array<{ message: string }> } }>(shop, token, SUBSCRIBE, { topic, url: `${cfg.appUrl}${WEBHOOK_PATH}` }, cfg, fetchImpl);
    if (!d.webhookSubscriptionCreate?.userErrors?.length) ok++;
  }
  return ok;
}
