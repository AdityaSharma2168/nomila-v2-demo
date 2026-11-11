/**
 * shopifyApp.test.ts — the catalog-only Shopify app (docs/design/shop-her-picks.md §12) against PGlite. Shopify, Cloud
 * KMS and the model are all fakes: no test reaches a provider.
 *
 *   S1 signatures: Shopify's query HMAC, the webhook HMAC (raw body), our state/session tokens — tampering fails
 *   S2 install: an unsigned launch is refused; a signed one goes to the read_products grant with a signed state; the
 *      callback checks state + HMAC, refuses broader scopes, seals the token (kms1:, never plaintext), links the brand,
 *      registers webhooks and syncs the catalog; without KMS there is no install at all
 *   S3 webhooks: a bad HMAC is refused; products upsert / delete; the compliance three; app/uninstalled deletes the
 *      token and the catalog (her pick keeps its link); shop/redact deletes the store
 *   S4 brand control + tenancy: a store that isn't one of her brands doesn't exist for her; the catalog is visible only
 *      after the brand approves her (from its signed session, with a CSRF token); her pick carries her code; another
 *      athlete can neither list nor add
 */
process.env.SHOP_V1 = "true";
process.env.SHOP_SHOPIFY_APP = "true";
process.env.SHOPIFY_API_KEY = "test-key";
process.env.SHOPIFY_API_SECRET = "test-secret";
process.env.SHOPIFY_APP_URL = "https://api.nomila.test";
process.env.KMS_TOKEN_KEY = "projects/p/locations/l/keyRings/r/cryptoKeys/k";
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({ requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); } }));
jest.mock("../lib/models", () => ({
  ...jest.requireActual("../lib/models"),
  genai: () => ({ models: { generateContent: async () => ({ text: JSON.stringify({ category: "apparel", brands: [], sponsor: null }) }) } }),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { __setKmsForTests } from "../lib/tokenCrypto";
import { deals, inboxBrands, shopBrandApprovals, shopCatalogProducts, shopItems, shopifyShops } from "../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { shopifyAppRouter, shopifyAppDeps } from "./shopifyApp";
import { shopifyWebhooksRouter } from "./shopifyWebhooks";
import shopBrandsRouter from "./shopBrands";
import { signToken, verifyQueryHmac, verifyToken, verifyWebhookHmac } from "../services/shopify/hmac";

const SECRET = "test-secret";
const SHOP = "oak-brand.myshopify.com";
const sign = (q: Record<string, string>) => {
  const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join("&");
  return { ...q, hmac: createHmac("sha256", SECRET).update(msg).digest("hex") };
};
const qs = (q: Record<string, string>) => new URLSearchParams(q).toString();
const now = () => String(Math.floor(Date.now() / 1000));

// ─── fakes ──────────────────────────────────────────────────────────────────────────────────────────────────────
const shopifyCalls: string[] = [];
let grantedScope = "read_products";
const product = (id: number, title: string, handle: string, price = "48.00") => ({
  legacyResourceId: String(id), handle, title, vendor: "Oak", productType: "Tee", status: "ACTIVE",
  featuredImage: { url: `https://cdn.shopify.test/${handle}.jpg` }, priceRangeV2: { minVariantPrice: { amount: price, currencyCode: "USD" } },
  variants: { nodes: [{ availableForSale: true }] },
});
const fakeShopify: typeof fetch = (async (input: any, init?: any) => {
  const url = String(input);
  shopifyCalls.push(url);
  if (url.endsWith("/admin/oauth/access_token")) return new Response(JSON.stringify({ access_token: "shpat_SECRET_TOKEN", scope: grantedScope }), { status: 200 });
  const body = JSON.parse(init?.body ?? "{}");
  if (String(body.query).includes("primaryDomain")) return new Response(JSON.stringify({ data: { shop: { name: "Oak Brand", primaryDomain: { host: "oakbrand.com" } } } }), { status: 200 });
  if (String(body.query).includes("webhookSubscriptionCreate")) return new Response(JSON.stringify({ data: { webhookSubscriptionCreate: { userErrors: [] } } }), { status: 200 });
  if (String(body.query).includes("products(")) return new Response(JSON.stringify({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [product(1, "Oak Tee", "oak-tee"), product(2, "Oak Hoodie", "oak-hoodie", "90.00")] } } }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as any;
const fakeKms = { wrap: async (_k: string, dek: Buffer) => Buffer.from(dek).toString("base64"), unwrap: async (_k: string, w: string) => Buffer.from(w, "base64") };

let server: Server; let base: string; let brandId: number; let a1: string; let a2: string;
const g = globalThis as any;
const as = (id: string) => { g.__TEST_ATHLETE_ID = id; };
const me = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/api/v1/me${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};
const hook = (topic: string, payload: unknown, opts: { badHmac?: boolean; shop?: string } = {}) => {
  const raw = JSON.stringify(payload);
  const hmac = createHmac("sha256", opts.badHmac ? "wrong" : SECRET).update(raw).digest("base64");
  return fetch(`${base}/api/shopify/webhooks`, { method: "POST", headers: { "content-type": "application/json", "x-shopify-hmac-sha256": hmac, "x-shopify-topic": topic, "x-shopify-shop-domain": opts.shop ?? SHOP }, body: raw });
};

beforeAll(async () => {
  await initTestDb();
  __setKmsForTests(fakeKms);
  shopifyAppDeps.fetchImpl = fakeShopify;
  shopifyAppDeps.resolveBrand = async (p) => (p.domain === "oakbrand.com" ? { brand_id: brandId } : null);
  [{ id: brandId }] = await db.insert(inboxBrands).values({ name: "Oak Brand", normalized_name: "oak brand", domain: "oakbrand.com" } as any).returning({ id: inboxBrands.id });
  a1 = await seedAthlete("Oak Athlete");
  a2 = await seedAthlete("Not Oak");
  await db.insert(deals).values({ athlete_id: a1, brand_name: "Oak Brand", brand_id: brandId, status: "accepted" } as any);
  const app = express();
  app.use("/api/shopify/webhooks", shopifyWebhooksRouter());
  app.use(express.json());
  app.use("/api/v1/me", shopBrandsRouter);
  app.use(shopifyAppRouter());
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { __setKmsForTests(null); server?.close(); await closeTestDb(); });

describe("S1 signatures", () => {
  it("Shopify's query HMAC, the webhook HMAC and our tokens all fail when tampered", () => {
    const q = sign({ shop: SHOP, timestamp: now() });
    expect(verifyQueryHmac(q, SECRET)).toBe(true);
    expect(verifyQueryHmac({ ...q, shop: "evil.myshopify.com" }, SECRET)).toBe(false);
    expect(verifyQueryHmac({ shop: SHOP }, SECRET)).toBe(false);
    const raw = Buffer.from('{"id":1}');
    expect(verifyWebhookHmac(raw, createHmac("sha256", SECRET).update(raw).digest("base64"), SECRET)).toBe(true);
    expect(verifyWebhookHmac(Buffer.from('{"id":2}'), createHmac("sha256", SECRET).update(raw).digest("base64"), SECRET)).toBe(false);
    const t = signToken({ shop: SHOP }, SECRET, 1000);
    expect(verifyToken(t, SECRET)).toMatchObject({ shop: SHOP });
    expect(verifyToken(t, "other")).toBeNull();
    expect(verifyToken(t.replace(/^./, "x"), SECRET)).toBeNull();
    expect(verifyToken(signToken({ shop: SHOP }, SECRET, -1), SECRET)).toBeNull();
  });
});

describe("S2 install", () => {
  it("an unsigned or stale launch is refused; a signed one goes to the read_products grant with a signed state", async () => {
    expect((await fetch(`${base}/shopify/app?${qs({ shop: SHOP, timestamp: now() })}`, { redirect: "manual" })).status).toBe(401);
    expect((await fetch(`${base}/shopify/app?${qs(sign({ shop: SHOP, timestamp: String(Math.floor(Date.now() / 1000) - 3600) }))}`, { redirect: "manual" })).status).toBe(401);
    const r = await fetch(`${base}/shopify/app?${qs(sign({ shop: SHOP, timestamp: now() }))}`, { redirect: "manual" });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin).toBe(`https://${SHOP}`);
    expect(loc.searchParams.get("scope")).toBe("read_products");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://api.nomila.test/shopify/callback");
    expect(verifyToken(loc.searchParams.get("state"), SECRET)).toMatchObject({ shop: SHOP, kind: "state" });
  });

  it("a callback with a forged state, or broader scopes, installs nothing", async () => {
    const forged = signToken({ shop: "other.myshopify.com", kind: "state" }, SECRET, 60_000);
    expect((await fetch(`${base}/shopify/callback?${qs(sign({ shop: SHOP, timestamp: now(), code: "c", state: forged }))}`)).status).toBe(401);
    grantedScope = "read_products,read_orders";
    const state = signToken({ shop: SHOP, kind: "state" }, SECRET, 60_000);
    expect((await fetch(`${base}/shopify/callback?${qs(sign({ shop: SHOP, timestamp: now(), code: "c", state }))}`)).status).toBe(400);
    grantedScope = "read_products";
    expect(await db.select().from(shopifyShops)).toEqual([]);
  });

  it("without KMS configured there is no install (never a plaintext token)", async () => {
    const key = process.env.KMS_TOKEN_KEY; delete process.env.KMS_TOKEN_KEY;
    const state = signToken({ shop: SHOP, kind: "state" }, SECRET, 60_000);
    expect((await fetch(`${base}/shopify/callback?${qs(sign({ shop: SHOP, timestamp: now(), code: "c", state }))}`)).status).toBe(500);
    expect(await db.select().from(shopifyShops)).toEqual([]);
    process.env.KMS_TOKEN_KEY = key;
  });

  it("the callback seals the token, links the brand, registers webhooks, syncs the catalog and opens the brand page", async () => {
    shopifyCalls.length = 0;
    const state = signToken({ shop: SHOP, kind: "state" }, SECRET, 60_000);
    const r = await fetch(`${base}/shopify/callback?${qs(sign({ shop: SHOP, timestamp: now(), code: "c", state }))}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("No requests yet");
    expect(r.headers.get("set-cookie")).toMatch(/nomila_shopify=.*HttpOnly/i);
    const [shop] = await db.select().from(shopifyShops);
    expect(shop).toMatchObject({ shop_domain: SHOP, primary_domain: "oakbrand.com", brand_id: brandId, status: "installed", scopes: "read_products" });
    expect(shop.access_token).toMatch(/^kms1:/);
    expect(JSON.stringify(shop)).not.toContain("shpat_SECRET_TOKEN");
    expect(shopifyCalls.filter((u) => u.endsWith("/graphql.json")).length).toBe(6); // shop info, 4 webhooks, 1 product page
    expect((await db.select().from(shopCatalogProducts)).map((p) => p.product_url).sort()).toEqual(["https://oakbrand.com/products/oak-hoodie", "https://oakbrand.com/products/oak-tee"]);
  });
});

describe("S4 brand control and tenancy", () => {
  it("only her brands; catalog after approval; her code on her pick; nobody else", async () => {
    as(a2);
    expect((await me("GET", "/shop/brands")).body.brands).toEqual([]);
    const [shop] = await db.select().from(shopifyShops);
    expect((await me("POST", `/shop/brands/${shop.id}/request`)).status).toBe(404);

    as(a1);
    expect((await me("GET", "/shop/brands")).body.brands).toEqual([{ shopId: shop.id, name: "Oak Brand", domain: "oakbrand.com", state: "none", code: null }]);
    expect((await me("GET", `/shop/brands/${shop.id}/products`)).status).toBe(403);
    expect((await me("POST", `/shop/brands/${shop.id}/request`)).body.brand.state).toBe("pending");

    // The brand, from its signed session: no CSRF token → refused; with it → approved with her code.
    const launch = await fetch(`${base}/shopify/app?${qs(sign({ shop: SHOP, timestamp: now() }))}`);
    const html = await launch.text();
    expect(html).toContain("Oak Athlete");
    expect(html).not.toContain("Not Oak");
    const cookie = launch.headers.get("set-cookie")!.split(";")[0];
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const [approval] = await db.select().from(shopBrandApprovals);
    const post = (fields: Record<string, string>) => fetch(`${base}/shopify/brand/decide`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: qs(fields) });
    expect((await post({ id: approval.id, action: "approve", code: "OAK10" })).status).toBe(401);
    expect((await post({ csrf, id: approval.id, action: "approve", code: "OAK10" })).status).toBe(303);
    expect((await fetch(`${base}/shopify/brand/decide`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: qs({ csrf, id: approval.id, action: "revoke" }) })).status).toBe(401);

    const products = (await me("GET", `/shop/brands/${shop.id}/products?q=tee`)).body.products;
    expect(products.map((p: any) => p.title)).toEqual(["Oak Tee"]);
    const added = await me("POST", `/shop/brands/products/${products[0].id}/add`);
    expect(added.status).toBe(201);
    expect(added.body.item).toMatchObject({ url: "https://oakbrand.com/discount/OAK10?redirect=%2Fproducts%2Foak-tee", source: "shopify", discountCode: "OAK10", status: "draft", title: "Oak Tee" });

    as(a2);
    expect((await me("GET", `/shop/brands/${shop.id}/products`)).status).toBe(404);
    expect((await me("POST", `/shop/brands/products/${products[0].id}/add`)).status).toBe(404);
  });
});

describe("S3 webhooks", () => {
  it("a bad HMAC is refused; products upsert and delete; the compliance three answer", async () => {
    expect((await hook("products/update", { id: 1 }, { badHmac: true })).status).toBe(401);
    const up = await hook("products/update", { id: 1, handle: "oak-tee", title: "Oak Tee v2", status: "active", variants: [{ price: "50.00", inventory_quantity: 3 }], image: { src: "https://cdn.shopify.test/v2.jpg" } });
    expect(await up.json()).toMatchObject({ outcome: "upserted" });
    const [tee] = await db.select().from(shopCatalogProducts).where(eq(shopCatalogProducts.shopify_product_id, "1"));
    expect(tee).toMatchObject({ title: "Oak Tee v2", price_cents: 5000, currency: "USD" });   // currency kept from the sync
    expect(await (await hook("products/delete", { id: 2 })).json()).toMatchObject({ outcome: "deleted" });
    for (const t of ["customers/data_request", "customers/redact"]) expect(await (await hook(t, { shop_domain: SHOP })).json()).toMatchObject({ outcome: "acknowledged" });
  });

  it("app/uninstalled deletes the token and the catalog; her pick keeps its link; shop/redact deletes the store", async () => {
    expect(await (await hook("app/uninstalled", { id: 1 })).json()).toMatchObject({ outcome: "uninstalled" });
    const [shop] = await db.select().from(shopifyShops);
    expect(shop).toMatchObject({ status: "uninstalled", access_token: null });
    expect(await db.select().from(shopCatalogProducts)).toEqual([]);
    const [pick] = await db.select().from(shopItems).where(eq(shopItems.athlete_id, a1));
    expect(pick).toMatchObject({ url: "https://oakbrand.com/discount/OAK10?redirect=%2Fproducts%2Foak-tee", catalog_product_id: null });
    expect(await (await hook("shop/redact", { shop_domain: SHOP })).json()).toMatchObject({ outcome: "redacted" });
    expect(await db.select().from(shopifyShops)).toEqual([]);
    expect(await db.select().from(shopBrandApprovals)).toEqual([]);
  });
});
