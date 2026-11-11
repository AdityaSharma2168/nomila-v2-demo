/**
 * shop/config.ts — Her picks (docs/design/shop-her-picks.md): the flag and the small fixed vocabularies.
 *
 * SHOP_V1 gates everything: the /me/shop routes, the /go/:code redirect, the Mila tools and the capability line. It is
 * read at call time (not at import) so a test can flip it. Exactly "true" is on; anything else is off.
 */

export const shopEnabled = (): boolean => process.env.SHOP_V1 === "true";

/**
 * The categories she can put a pick in. Product vocabulary only — nothing athlete-, sport-, school- or brand-specific.
 * Stored as text with NO CHECK (0096): the list may grow, and the routes validate against this array.
 */
export const SHOP_CATEGORIES = ["apparel", "footwear", "equipment", "nutrition", "supplements", "beauty", "tech", "home", "other"] as const;
export type ShopCategory = (typeof SHOP_CATEGORIES)[number];
export const isShopCategory = (v: unknown): v is ShopCategory => typeof v === "string" && (SHOP_CATEGORIES as readonly string[]).includes(v);

/** Categories a school's apparel/footwear sponsor covers. */
export const SPONSOR_CATEGORIES: readonly ShopCategory[] = ["apparel", "footwear"];

/** Where a link came from — display only. No CHECK in the DB (the list grows). */
export const SHOP_SOURCES = ["amazon", "shopify", "ltk", "shopmy", "link"] as const;
export type ShopSource = (typeof SHOP_SOURCES)[number];

export const ITEM_STATUSES = ["draft", "live", "hidden"] as const;
export type ShopItemStatus = (typeof ITEM_STATUSES)[number];

/** Field limits (characters). */
export const LIMITS = { url: 2048, title: 160, blurb: 280, code: 40, merchant: 80, sponsor: 80, items: 60 } as const;

/** The disclosure on every pick, wherever it is drawn. FTC: "paid link" next to the link is adequate. */
export const DISCLOSURE = "Paid link";
/** Amazon's required statement, on any shelf that carries an Amazon link (Operating Agreement). */
export const AMAZON_STATEMENT = "As an Amazon Associate I earn from qualifying purchases.";
/** The NIL Go cumulative third-party threshold (CSC memo, 7 Apr 2026), in cents. */
export const NIL_GO_THRESHOLD_CENTS = 60_000;
export const NIL_GO_BUSINESS_DAYS = 5;
