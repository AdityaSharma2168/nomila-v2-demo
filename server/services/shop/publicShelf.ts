/**
 * shop/publicShelf.ts — THE read for the public page (designed in a separate session) and the /go/:code redirect
 * (docs/design/shop-her-picks.md §5.1, §5.4).
 *
 * publicShelf(athleteId)   her LIVE picks, in her order, only while SHOP_V1 is on and her shelf is open (eligible).
 *                          Each carries the "Paid link" disclosure as data, and the shelf carries Amazon's required
 *                          statement whenever an Amazon pick is live. Her own line (`blurb`) is the only words shown —
 *                          never Mila's suggestion. The href is /go/<code>: her link itself is never handed to the page.
 * resolveClick(code)       the redirect: a live pick of an open shelf → her link, and +1 on today's count. Anything
 *                          else → null (the route answers the same 404 for every miss). Nothing about the fan is read
 *                          or stored.
 */
import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { shopClickDays, shopItems } from "../../../shared/schema";
import { publicBaseUrl } from "../../lib/baseUrls";
import { AMAZON_STATEMENT, DISCLOSURE, shopEnabled } from "./config";
import { eligibility } from "./checks";
import { CODE_PATTERN } from "./items";

type Db = typeof defaultDb;

export interface PublicPick {
  title: string;
  imageUrl: string | null;
  merchant: string | null;
  priceCents: number | null;
  currency: string | null;
  /** Her own words, or null. */
  blurb: string | null;
  discountCode: string | null;
  href: string;
  /** Always "Paid link". The card component draws it too and has no way to hide it. */
  disclosure: typeof DISCLOSURE;
  /** An Amazon link (the page then carries Amazon's statement next to it). */
  amazon: boolean;
}

export interface PublicShelf {
  picks: PublicPick[];
  /** Amazon's statement, when any live pick is an Amazon link; else null. */
  amazonStatement: string | null;
}

const EMPTY: PublicShelf = { picks: [], amazonStatement: null };

export async function publicShelf(athleteId: string, db: Db = defaultDb): Promise<PublicShelf> {
  if (!shopEnabled()) return EMPTY;
  if (!(await eligibility(athleteId, { db })).eligible) return EMPTY;
  const rows = await db.select().from(shopItems)
    .where(and(eq(shopItems.athlete_id, athleteId), eq(shopItems.status, "live")))
    .orderBy(shopItems.position, shopItems.created_at);
  const base = publicBaseUrl();
  return {
    picks: rows.map((r) => ({
      title: r.title, imageUrl: r.image_url, merchant: r.merchant, priceCents: r.price_cents, currency: r.currency,
      blurb: r.blurb, discountCode: r.discount_code, href: `${base}/go/${r.code}`, disclosure: DISCLOSURE,
      amazon: r.source === "amazon",
    })),
    amazonStatement: rows.some((r) => r.source === "amazon") ? AMAZON_STATEMENT : null,
  };
}

/** Her link for a live pick of an open shelf (and one more click today), or null. */
export async function resolveClick(code: string, opts: { db?: Db; now?: Date } = {}): Promise<string | null> {
  const db = opts.db ?? defaultDb;
  if (!shopEnabled() || !CODE_PATTERN.test(code)) return null;
  const [row] = await db.select({ id: shopItems.id, url: shopItems.url, athlete_id: shopItems.athlete_id }).from(shopItems)
    .where(and(eq(shopItems.code, code), eq(shopItems.status, "live"))).limit(1);
  if (!row) return null;
  if (!(await eligibility(row.athlete_id, { db, now: opts.now })).eligible) return null;
  const day = (opts.now ?? new Date()).toISOString().slice(0, 10);
  await db.insert(shopClickDays).values({ item_id: row.id, day, clicks: 1 })
    .onConflictDoUpdate({ target: [shopClickDays.item_id, shopClickDays.day], set: { clicks: sql`${shopClickDays.clicks} + 1` } });
  return row.url;
}
