/**
 * shopify/approvals.ts — who may feature a brand's products, and "From your brands" (docs/design/shop-her-picks.md §12).
 *
 * ATHLETE SIDE (every function takes her id first; every query filters by it):
 *   myBrands(athleteId)                  installed stores whose brand is one of HERS (a deal or an opportunity), with
 *                                        her approval state. A store that isn't one of her brands is never listed.
 *   requestFeature(athleteId, shopId)    she asks: a pending row. Only for one of her brands; a decline or revoke stands
 *                                        (asking again doesn't reopen it — the brand can).
 *   catalogFor(athleteId, shopId, q)     the store's products — ONLY when the brand approved her.
 *   addFromCatalog(athleteId, productId) a DRAFT pick whose link is the product page with her code applied
 *                                        (/discount/<code>?redirect=/products/<handle>), or the plain page without one.
 *
 * BRAND SIDE (the shop id comes from a Shopify-signed session, never from a form):
 *   requestsFor(shopId)                  only the athletes who asked: her name and the state, nothing else about her
 *   decide(shopId, approvalId, action, code)  approve (with an optional code) · decline · revoke
 */
import { and, asc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { athletes, deals, opportunities, shopBrandApprovals, shopCatalogProducts, shopItems, shopifyShops } from "../../../shared/schema";
import { LIMITS } from "../shop/config";
import { ShopError, newCode, toView, type ShopItemView } from "../shop/items";
import { warningsFor, type Judge } from "../shop/checks";

type Db = typeof defaultDb;

export type ApprovalState = "none" | "pending" | "approved" | "declined" | "revoked";

export interface MyBrand { shopId: string; name: string; domain: string; state: ApprovalState; code: string | null }

async function herBrandIds(athleteId: string, db: Db): Promise<number[]> {
  const fromDeals = await db.selectDistinct({ id: deals.brand_id }).from(deals).where(and(eq(deals.athlete_id, athleteId), isNotNull(deals.brand_id)));
  const fromOpps = await db.selectDistinct({ id: opportunities.brand_id }).from(opportunities).where(and(eq(opportunities.athlete_id, athleteId), isNotNull(opportunities.brand_id)));
  return [...new Set([...fromDeals, ...fromOpps].map((r) => r.id).filter((x): x is number => x != null))];
}

export async function myBrands(athleteId: string, db: Db = defaultDb): Promise<MyBrand[]> {
  const ids = await herBrandIds(athleteId, db);
  if (!ids.length) return [];
  const rows = await db.select({
    shopId: shopifyShops.id, name: shopifyShops.name, primary: shopifyShops.primary_domain, shop: shopifyShops.shop_domain,
    status: shopBrandApprovals.status, code: shopBrandApprovals.code,
  }).from(shopifyShops)
    .leftJoin(shopBrandApprovals, and(eq(shopBrandApprovals.shop_id, shopifyShops.id), eq(shopBrandApprovals.athlete_id, athleteId)))
    .where(and(eq(shopifyShops.status, "installed"), inArray(shopifyShops.brand_id, ids)))
    .orderBy(asc(shopifyShops.name));
  return rows.map((r) => ({
    shopId: r.shopId, name: r.name ?? r.primary ?? r.shop, domain: r.primary ?? r.shop,
    state: (r.status ?? "none") as ApprovalState, code: r.status === "approved" ? r.code : null,
  }));
}

async function myBrand(athleteId: string, shopId: string, db: Db): Promise<MyBrand> {
  const b = (await myBrands(athleteId, db)).find((x) => x.shopId === shopId);
  if (!b) throw new ShopError(404, "not_found", "brand not found");
  return b;
}

export async function requestFeature(athleteId: string, shopId: string, db: Db = defaultDb): Promise<MyBrand> {
  await myBrand(athleteId, shopId, db);
  await db.insert(shopBrandApprovals).values({ shop_id: shopId, athlete_id: athleteId, status: "pending" }).onConflictDoNothing();
  return myBrand(athleteId, shopId, db);
}

export interface CatalogProductView { id: string; title: string; vendor: string | null; imageUrl: string | null; priceCents: number | null; currency: string | null; available: boolean }

export async function catalogFor(athleteId: string, shopId: string, q: unknown, db: Db = defaultDb): Promise<CatalogProductView[]> {
  const b = await myBrand(athleteId, shopId, db);
  if (b.state !== "approved") throw new ShopError(403, "not_approved", "this brand hasn't approved you yet");
  const term = typeof q === "string" ? q.trim().slice(0, 80) : "";
  const rows = await db.select().from(shopCatalogProducts)
    .where(and(eq(shopCatalogProducts.shop_id, shopId), or(sql`${shopCatalogProducts.product_status} IS NULL`, eq(shopCatalogProducts.product_status, "active")), term ? ilike(shopCatalogProducts.title, `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`) : undefined))
    .orderBy(asc(shopCatalogProducts.title)).limit(60);
  return rows.map((r) => ({ id: r.id, title: r.title, vendor: r.vendor, imageUrl: r.image_url, priceCents: r.price_cents, currency: r.currency, available: r.available }));
}

/** Her link for a catalog product: the product page, with her code applied when the brand gave her one. */
export function linkWithCode(productUrl: string, handle: string, code: string | null): string {
  if (!code) return productUrl;
  const origin = new URL(productUrl).origin;
  return `${origin}/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(`/products/${handle}`)}`;
}

export async function addFromCatalog(athleteId: string, productId: unknown, deps: { db?: Db; judge?: Judge } = {}): Promise<{ item: ShopItemView; existing: boolean }> {
  const db = deps.db ?? defaultDb;
  if (typeof productId !== "string" || !/^[0-9a-f-]{36}$/i.test(productId)) throw new ShopError(404, "not_found", "product not found");
  const [p] = await db.select().from(shopCatalogProducts).where(eq(shopCatalogProducts.id, productId)).limit(1);
  if (!p) throw new ShopError(404, "not_found", "product not found");
  const b = (await myBrands(athleteId, db)).find((x) => x.shopId === p.shop_id);
  // Not hers, or not approved: the same "not found" — a catalog id never proves anything to someone else.
  if (!b || b.state !== "approved") throw new ShopError(404, "not_found", "product not found");
  const url = linkWithCode(p.product_url, p.handle, b.code);
  const [dupe] = await db.select().from(shopItems).where(and(eq(shopItems.athlete_id, athleteId), eq(shopItems.url, url))).limit(1);
  if (dupe) return { item: toView(dupe), existing: true };
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(shopItems).where(eq(shopItems.athlete_id, athleteId));
  if (n >= LIMITS.items) throw new ShopError(409, "too_many", `a shelf holds up to ${LIMITS.items} picks`);
  const host = new URL(url).hostname.toLowerCase();
  const checked = await warningsFor(athleteId, { title: p.title, merchant: b.name, host, url, category: null }, { db, judge: deps.judge });
  const [{ maxPos }] = await db.select({ maxPos: sql<number>`coalesce(max(${shopItems.position}), -1)::int` }).from(shopItems).where(eq(shopItems.athlete_id, athleteId));
  const [row] = await db.insert(shopItems).values({
    athlete_id: athleteId, code: newCode(), url, url_host: host, source: "shopify", title: p.title, image_url: p.image_url,
    price_cents: p.price_cents, currency: p.currency, merchant: b.name, category: checked.category, discount_code: b.code,
    status: "draft", position: maxPos + 1, catalog_product_id: p.id, metadata_fetched_at: p.synced_at,
  }).onConflictDoNothing().returning();
  if (!row) {
    const [again] = await db.select().from(shopItems).where(and(eq(shopItems.athlete_id, athleteId), eq(shopItems.url, url))).limit(1);
    return { item: toView(again), existing: true };
  }
  return { item: toView(row), existing: false };
}

// ─── Brand side ────────────────────────────────────────────────────────────────────────────────────────────────

export interface BrandRequest { id: string; athleteName: string; status: Exclude<ApprovalState, "none">; code: string | null; requestedAt: string }

export async function requestsFor(shopId: string, db: Db = defaultDb): Promise<BrandRequest[]> {
  const rows = await db.select({ id: shopBrandApprovals.id, name: athletes.full_name, status: shopBrandApprovals.status, code: shopBrandApprovals.code, at: shopBrandApprovals.requested_at })
    .from(shopBrandApprovals).innerJoin(athletes, eq(athletes.id, shopBrandApprovals.athlete_id))
    .where(eq(shopBrandApprovals.shop_id, shopId)).orderBy(asc(shopBrandApprovals.requested_at));
  return rows.map((r) => ({ id: r.id, athleteName: r.name, status: r.status as BrandRequest["status"], code: r.code, requestedAt: new Date(r.at).toISOString() }));
}

const DECISIONS = { approve: "approved", decline: "declined", revoke: "revoked" } as const;

export async function decide(shopId: string, approvalId: unknown, action: unknown, code: unknown, deps: { db?: Db; now?: Date } = {}): Promise<boolean> {
  const db = deps.db ?? defaultDb;
  if (typeof approvalId !== "string" || !/^[0-9a-f-]{36}$/i.test(approvalId)) return false;
  const status = DECISIONS[action as keyof typeof DECISIONS];
  if (!status) return false;
  const c = typeof code === "string" ? code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, LIMITS.code) : "";
  const done = await db.update(shopBrandApprovals)
    .set({ status, decided_at: deps.now ?? new Date(), ...(status === "approved" ? { code: c || null } : {}) })
    .where(and(eq(shopBrandApprovals.id, approvalId), eq(shopBrandApprovals.shop_id, shopId)))
    .returning({ id: shopBrandApprovals.id });
  return done.length > 0;
}
