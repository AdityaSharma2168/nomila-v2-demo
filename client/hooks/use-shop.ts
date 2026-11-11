// use-shop — Her picks (docs/design/shop-her-picks.md §5), the athlete's own shelf.
//
//   POST /api/v1/me/shop/items   → useAddShopItem()   { url, suggested_blurb? } → a DRAFT (Mila's card, My Picks' Add)
//
// Every route answers only for the signed-in athlete; nothing here sends an athlete id.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";

export const SHOP_KEY = ["me", "shop"] as const;

export interface ShopWarning { code: string; text: string; brand?: string; scope?: string | null; sponsor?: string }

export interface ShopItem {
  id: string;
  url: string;
  host: string;
  source: string;
  networkTag: string | null;
  title: string;
  imageUrl: string | null;
  priceCents: number | null;
  currency: string | null;
  merchant: string | null;
  category: string | null;
  blurb: string | null;
  blurbSuggestion: string | null;
  discountCode: string | null;
  status: "draft" | "live" | "hidden";
  position: number;
  publishedAt: string | null;
  clicks7d: number;
  clicks30d: number;
}

async function json<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await apiRequest(method, route, body);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Add a pick from her link: always a draft. The same link again answers the pick she already has. */
export function useAddShopItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { url: string; suggested_blurb?: string | null }) =>
      json<{ item: ShopItem; existing: boolean; warnings: ShopWarning[] }>("POST", "/api/v1/me/shop/items", { url: body.url, ...(body.suggested_blurb ? { suggested_blurb: body.suggested_blurb } : {}) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: SHOP_KEY }); },
  });
}

// ─── My Picks (PR 3) ────────────────────────────────────────────────────────────────────────────────────────────
//
//   GET    /api/v1/me/shop                → useShop()              her answers, her picks, the NIL Go reminder
//   PUT    /api/v1/me/shop/settings       → useShopSettings()      18+, international, supplements, school sponsor
//   PATCH  /api/v1/me/shop/items/:id      → useUpdateShopItem()    her edits; status live runs the gates (409s below)
//   POST   /api/v1/me/shop/items/order    → useReorderShopItems()
//   DELETE /api/v1/me/shop/items/:id      → useDeleteShopItem()

export type ShopNeed = "minor" | "adult_confirmation" | "international_answer" | "international_ack";

export interface ShopSettings {
  eligible: boolean;
  needs: ShopNeed[];
  adultConfirmed: boolean;
  internationalStudent: boolean | null;
  internationalAcknowledged: boolean;
  supplementsOn: boolean;
  schoolApparelSponsor: string | null;
}

export interface NilGoReminder {
  applies: boolean;
  thresholdCents: number;
  brands: Array<{ brand: string; totalCents: number; deals: number; reportable: boolean; reportBy: string | null }>;
  copy: { title: string; rule: string; notFiling: string; affiliateNote: string };
}

export interface ShopResponse {
  settings: ShopSettings;
  items: ShopItem[];
  nilGo: NilGoReminder;
  categories: string[];
}

export type { ShopRefusal } from "../lib/shopLogic";
export { shopRefusal } from "../lib/shopLogic";

export function useShop(enabled = true) {
  return useQuery<ShopResponse>({
    queryKey: SHOP_KEY,
    queryFn: () => json<ShopResponse>("GET", "/api/v1/me/shop"),
    enabled,
    staleTime: 10_000,
  });
}

export function useShopSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<{ adult_confirmed: boolean; international_student: boolean; international_ack: boolean; supplements_opt_in: boolean; school_apparel_sponsor: string | null }>) =>
      json<{ settings: ShopSettings }>("PUT", "/api/v1/me/shop/settings", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: SHOP_KEY }); },
  });
}

export interface ShopItemPatch { title?: string; blurb?: string | null; category?: string | null; discount_code?: string | null; status?: "draft" | "live" | "hidden"; confirm_warnings?: boolean }

export function useUpdateShopItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ShopItemPatch }) => json<{ item: ShopItem; warnings: ShopWarning[] }>("PATCH", `/api/v1/me/shop/items/${id}`, patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: SHOP_KEY }); },
  });
}

export function useReorderShopItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => json<{ items: ShopItem[] }>("POST", "/api/v1/me/shop/items/order", { ids }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: SHOP_KEY }); },
  });
}

export function useDeleteShopItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => json<void>("DELETE", `/api/v1/me/shop/items/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: SHOP_KEY }); },
  });
}

// ─── From your brands (PR 4, the catalog-only Shopify app) ────────────────────────────────────────────────────────
//
//   GET  /api/v1/me/shop/brands                          → useShopBrands()
//   POST /api/v1/me/shop/brands/:shopId/request          → useRequestBrand()
//   GET  /api/v1/me/shop/brands/:shopId/products?q=      → useBrandCatalog()   (only once the brand approved her)
//   POST /api/v1/me/shop/brands/products/:productId/add  → useAddFromCatalog() (a draft, with her code)

export interface ShopBrand { shopId: string; name: string; domain: string; state: "none" | "pending" | "approved" | "declined" | "revoked"; code: string | null }
export interface CatalogProduct { id: string; title: string; vendor: string | null; imageUrl: string | null; priceCents: number | null; currency: string | null; available: boolean }

export const SHOP_BRANDS_KEY = ["me", "shop", "brands"] as const;

export function useShopBrands(enabled = true) {
  return useQuery<{ brands: ShopBrand[] }>({
    queryKey: SHOP_BRANDS_KEY,
    queryFn: () => json<{ brands: ShopBrand[] }>("GET", "/api/v1/me/shop/brands"),
    enabled,
    staleTime: 30_000,
  });
}

export function useRequestBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shopId: string) => json<{ brand: ShopBrand }>("POST", `/api/v1/me/shop/brands/${shopId}/request`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: SHOP_BRANDS_KEY }); },
  });
}

export function useBrandCatalog(shopId: string | null, q: string) {
  return useQuery<{ products: CatalogProduct[] }>({
    queryKey: ["me", "shop", "brands", shopId, "products", q],
    queryFn: () => json<{ products: CatalogProduct[] }>("GET", `/api/v1/me/shop/brands/${shopId}/products${q ? `?q=${encodeURIComponent(q)}` : ""}`),
    enabled: !!shopId,
    staleTime: 30_000,
  });
}

export function useAddFromCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (productId: string) => json<{ item: ShopItem; existing: boolean }>("POST", `/api/v1/me/shop/brands/products/${productId}/add`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: SHOP_KEY }); },
  });
}
