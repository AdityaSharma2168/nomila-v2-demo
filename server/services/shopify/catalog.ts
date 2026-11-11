/**
 * shopify/catalog.ts — install, sync, webhooks, uninstall, redact (docs/design/shop-her-picks.md §12).
 *
 *   installShop        after OAuth: seal the token with the KMS envelope (ALWAYS — refused if KMS isn't configured; never
 *                      plaintext), store the shop, link it to inbox_brands by its primary domain (the existing resolver
 *                      and logo pipeline), register webhooks, run the first sync
 *   syncShop           every product page → shop_catalog_products; products the store no longer has are removed
 *   applyProductWebhook products/create|update → upsert one product; products/delete → remove it
 *   uninstallShop      app/uninstalled: the token is deleted, the shop marked uninstalled, its catalog removed (her picks
 *                      keep their plain links; catalog_product_id goes NULL)
 *   redactShop         shop/redact: every row about the shop is deleted
 *   reconcileAll       the daily cron: syncShop for every installed store
 *
 * Nothing here reads orders or customers, and nothing moves money.
 */
import { and, eq, notInArray } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { shopCatalogProducts, shopifyShops } from "../../../shared/schema";
import { decryptToken, encodeEnvelope, encryptToken } from "../../lib/tokenCrypto";
import { createLogger } from "../../logger";
import { productsPage, registerWebhooks, shopInfo, type FetchImpl, type ShopifyProductNode } from "./admin";
import { isShopDomain, type ShopifyConfig } from "./config";

const logger = createLogger("services/shopify/catalog");
type Db = typeof defaultDb;
export type ShopRow = typeof shopifyShops.$inferSelect;
export type CatalogRow = typeof shopCatalogProducts.$inferInsert;

export interface Deps {
  db?: Db;
  fetchImpl?: FetchImpl;
  /** The brand link: the existing resolver (server/lib/brandResolver). Injected so tests never fetch a logo. */
  resolveBrand?: (p: { domain: string | null; brandName: string | null }) => Promise<{ brand_id: number } | null>;
  now?: Date;
}

const clip = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, n) : null);
const cents = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 1_000_000 ? Math.round(n * 100) : null; };
const httpsUrl = (v: unknown): string | null => { try { const u = new URL(String(v)); return u.protocol === "https:" ? u.toString() : null; } catch { return null; } };
const handleOk = (h: unknown): h is string => typeof h === "string" && /^[\w%.-]{1,255}$/.test(h);

/** The product page on the brand's own domain (its primary domain when known). */
export const productUrl = (shop: Pick<ShopRow, "primary_domain" | "shop_domain">, handle: string) => `https://${shop.primary_domain ?? shop.shop_domain}/products/${handle}`;

export function rowFromNode(shop: ShopRow, n: ShopifyProductNode, now: Date): CatalogRow | null {
  if (!handleOk(n.handle) || !clip(n.title, 160) || !/^\d+$/.test(String(n.legacyResourceId))) return null;
  return {
    shop_id: shop.id, shopify_product_id: String(n.legacyResourceId), handle: n.handle, title: clip(n.title, 160)!,
    vendor: clip(n.vendor, 80), product_type: clip(n.productType, 80), product_url: productUrl(shop, n.handle),
    image_url: httpsUrl(n.featuredImage?.url), price_cents: cents(n.priceRangeV2?.minVariantPrice?.amount),
    currency: /^[A-Z]{3}$/.test(n.priceRangeV2?.minVariantPrice?.currencyCode ?? "") ? n.priceRangeV2!.minVariantPrice.currencyCode : null,
    available: (n.variants?.nodes ?? []).some((v) => v.availableForSale), product_status: clip(n.status, 20)?.toLowerCase() ?? null, synced_at: now,
  };
}

/** A REST webhook payload (products/create|update) as a catalog row. Currency isn't in the payload: kept from the last sync. */
export function rowFromWebhook(shop: ShopRow, p: any, now: Date): CatalogRow | null {
  if (!p || !/^\d+$/.test(String(p.id)) || !handleOk(p.handle) || !clip(p.title, 160)) return null;
  const variants: any[] = Array.isArray(p.variants) ? p.variants : [];
  const prices = variants.map((v) => cents(v?.price)).filter((c): c is number => c != null);
  return {
    shop_id: shop.id, shopify_product_id: String(p.id), handle: p.handle, title: clip(p.title, 160)!, vendor: clip(p.vendor, 80),
    product_type: clip(p.product_type, 80), product_url: productUrl(shop, p.handle),
    image_url: httpsUrl(p.image?.src ?? p.images?.[0]?.src), price_cents: prices.length ? Math.min(...prices) : null,
    available: variants.length ? variants.some((v) => v?.inventory_policy === "continue" || v?.inventory_quantity == null || Number(v.inventory_quantity) > 0) : true,
    product_status: clip(p.status, 20)?.toLowerCase() ?? null, synced_at: now,
  };
}

async function upsert(db: Db, row: CatalogRow): Promise<void> {
  const { shop_id: _s, shopify_product_id: _p, ...rest } = row;
  const set = { ...rest } as Partial<CatalogRow>;
  if (set.currency == null) delete set.currency; // a webhook carries no currency: keep the synced one
  await db.insert(shopCatalogProducts).values(row).onConflictDoUpdate({ target: [shopCatalogProducts.shop_id, shopCatalogProducts.shopify_product_id], set });
}

export async function loadShop(shopDomain: string, db: Db = defaultDb): Promise<ShopRow | null> {
  if (!isShopDomain(shopDomain)) return null;
  const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop_domain, shopDomain)).limit(1);
  return row ?? null;
}

export async function installShop(shopDomain: string, accessToken: string, scopes: string, cfg: ShopifyConfig, deps: Deps = {}): Promise<ShopRow> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  // Never plaintext: the envelope or no install at all (tokenCrypto throws when KMS_TOKEN_KEY is missing).
  const sealed = encodeEnvelope(await encryptToken(accessToken));
  const info = await shopInfo(shopDomain, accessToken, cfg, deps.fetchImpl);
  const resolve = deps.resolveBrand ?? (async (p) => (await import("../../lib/brandResolver")).resolveBrand(p));
  let brandId: number | null = null;
  try { brandId = (await resolve({ domain: info.primaryHost, brandName: info.name }))?.brand_id ?? null; }
  catch (err: any) { logger.warn({ shop: shopDomain, error: err?.message?.slice(0, 120) }, "shop not linked to a brand"); }
  const values = { shop_domain: shopDomain, primary_domain: info.primaryHost, name: clip(info.name, 120), brand_id: brandId, access_token: sealed, scopes: scopes.slice(0, 200), status: "installed", installed_at: now, uninstalled_at: null, updated_at: now };
  const [row] = await db.insert(shopifyShops).values(values).onConflictDoUpdate({ target: shopifyShops.shop_domain, set: values }).returning();
  await registerWebhooks(shopDomain, accessToken, cfg, deps.fetchImpl);
  await syncShop(row, cfg, { ...deps, token: accessToken });
  return row;
}

export async function syncShop(shop: ShopRow, cfg: ShopifyConfig, deps: Deps & { token?: string } = {}): Promise<{ products: number; removed: number }> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  if (shop.status !== "installed" || !shop.access_token) return { products: 0, removed: 0 };
  const token = deps.token ?? (await decryptToken(shop.access_token));
  const seen: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 100; page++) {
    const { nodes, next } = await productsPage(shop.shop_domain, token, after, cfg, deps.fetchImpl);
    for (const n of nodes) {
      const row = rowFromNode(shop, n, now);
      if (!row) continue;
      await upsert(db, row);
      seen.push(row.shopify_product_id);
    }
    if (!next) break;
    after = next;
  }
  const removed = await db.delete(shopCatalogProducts)
    .where(seen.length ? and(eq(shopCatalogProducts.shop_id, shop.id), notInArray(shopCatalogProducts.shopify_product_id, seen)) : eq(shopCatalogProducts.shop_id, shop.id))
    .returning({ id: shopCatalogProducts.id });
  await db.update(shopifyShops).set({ last_synced_at: now, updated_at: now }).where(eq(shopifyShops.id, shop.id));
  return { products: seen.length, removed: removed.length };
}

export type WebhookOutcome = "upserted" | "deleted" | "uninstalled" | "redacted" | "acknowledged" | "ignored";

/** One verified webhook. The caller has already checked the HMAC. */
export async function applyWebhook(topic: string, shopDomain: string, payload: any, deps: Deps = {}): Promise<WebhookOutcome> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  // Compliance: Nomila holds no customer data at all (read_products only) — nothing to return or delete.
  if (topic === "customers/data_request" || topic === "customers/redact") return "acknowledged";
  const shop = await loadShop(shopDomain, db);
  if (!shop) return "ignored";
  if (topic === "shop/redact") {
    await db.delete(shopifyShops).where(eq(shopifyShops.id, shop.id));
    return "redacted";
  }
  if (topic === "app/uninstalled") {
    await db.update(shopifyShops).set({ access_token: null, status: "uninstalled", uninstalled_at: now, updated_at: now }).where(eq(shopifyShops.id, shop.id));
    await db.delete(shopCatalogProducts).where(eq(shopCatalogProducts.shop_id, shop.id));
    return "uninstalled";
  }
  if (shop.status !== "installed") return "ignored";
  if (topic === "products/delete") {
    if (!/^\d+$/.test(String(payload?.id))) return "ignored";
    await db.delete(shopCatalogProducts).where(and(eq(shopCatalogProducts.shop_id, shop.id), eq(shopCatalogProducts.shopify_product_id, String(payload.id))));
    return "deleted";
  }
  if (topic === "products/create" || topic === "products/update") {
    const row = rowFromWebhook(shop, payload, now);
    if (!row) return "ignored";
    await upsert(db, row);
    return "upserted";
  }
  return "ignored";
}

/** The daily reconcile: a full sync of every installed store. One store's failure never stops the rest. */
export async function reconcileAll(cfg: ShopifyConfig, deps: Deps = {}): Promise<{ shops: number; failed: number; products: number }> {
  const db = deps.db ?? defaultDb;
  const shops = await db.select().from(shopifyShops).where(eq(shopifyShops.status, "installed"));
  let failed = 0; let products = 0;
  for (const s of shops) {
    try { products += (await syncShop(s, cfg, deps)).products; }
    catch (err: any) { failed++; logger.warn({ shop: s.shop_domain, error: err?.message?.slice(0, 120) }, "shopify reconcile failed for a shop"); }
  }
  return { shops: shops.length, failed, products };
}
