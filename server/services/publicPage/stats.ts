/**
 * publicPage/stats.ts — the Front Door page's own counts (0121), and the athlete's metrics rail.
 *
 *   recordView(handle)                   one page view of a PUBLISHED page, counted per UTC day. No visitor data.
 *   setLike(handle, token, liked)        a visitor's like, once per visitor (taking it back deletes it). The visitor holds
 *                                        a random token (kept by the page in its own storage); only HMAC(secret,
 *                                        athlete id ‖ token) is stored, so the like links to no person, IP or device,
 *                                        and not to a like on another athlete's page.
 *   pageMetrics(athleteId, now)          her rail, last 30 days: views · likes · requests · bookings · shop
 *
 * The athlete is resolved from the handle on the server, and only for a published page (public_cards.status). The
 * counts read tables that already exist for requests (partner_requests that reached her: confirmed), bookings (every
 * booking past the buyer's email check) and shop clicks (shop_click_days). Visitors never see a count.
 * Nothing here names an athlete, sport, school or brand.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { visitorKey } from "../askMila/config";
import { PUBLIC_PAGE_METRICS_DAYS, type PublicPageMetrics } from "../../../shared/publicPageStats";

type Db = typeof defaultDb;

/** A visitor token: the page makes it from 16 random bytes (base64url); anything else is refused. */
export const VISITOR_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** UTC day, YYYY-MM-DD. */
const dayOf = (now: Date) => now.toISOString().slice(0, 10);

/** The stored key for one visitor's like on one athlete's page. */
export function likeHash(athleteId: string, token: string): string {
  return crypto.createHmac("sha256", visitorKey()).update(`page-like|${athleteId}|${token}`).digest("base64url").slice(0, 43);
}

const rowsOf = (r: unknown): any[] => ((r as { rows?: any[] })?.rows ?? (Array.isArray(r) ? r : []));

/** Counts one view of a published page. A handle that is not published counts nothing. Never throws to the page. */
export async function recordView(handle: string, now: Date = new Date(), db: Db = defaultDb): Promise<boolean> {
  const r = await db.execute(sql`
    INSERT INTO public_page_view_days (athlete_id, day, views)
    SELECT athlete_id, ${dayOf(now)}::date, 1 FROM public_cards WHERE handle = ${handle} AND status = 'published'
    ON CONFLICT (athlete_id, day) DO UPDATE SET views = public_page_view_days.views + 1
    RETURNING athlete_id`);
  return rowsOf(r).length > 0;
}

export type LikeResult = { status: "ok"; liked: boolean } | { status: "not_found" };

/** Sets this visitor's like on a published page (idempotent: liking twice is one like; unliking an unliked page is a no-op). */
export async function setLike(handle: string, token: string, liked: boolean, db: Db = defaultDb): Promise<LikeResult> {
  const found = rowsOf(await db.execute(sql`SELECT athlete_id FROM public_cards WHERE handle = ${handle} AND status = 'published' LIMIT 1`));
  const athleteId: string | undefined = found[0]?.athlete_id;
  if (!athleteId) return { status: "not_found" };
  const hash = likeHash(athleteId, token);
  if (liked) {
    await db.execute(sql`INSERT INTO public_page_likes (athlete_id, visitor_hash) VALUES (${athleteId}, ${hash}) ON CONFLICT (athlete_id, visitor_hash) DO NOTHING`);
  } else {
    await db.execute(sql`DELETE FROM public_page_likes WHERE athlete_id = ${athleteId} AND visitor_hash = ${hash}`);
  }
  return { status: "ok", liked };
}

const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);

/** Her metrics rail: the last 30 days (today included), every count from what is stored. */
export async function pageMetrics(athleteId: string, now: Date = new Date(), db: Db = defaultDb): Promise<PublicPageMetrics> {
  const since = new Date(now.getTime() - (PUBLIC_PAGE_METRICS_DAYS - 1) * 86_400_000);
  const sinceDay = dayOf(since);
  const sinceTs = `${sinceDay}T00:00:00.000Z`;
  const [row] = rowsOf(await db.execute(sql`
    SELECT
      (SELECT COALESCE(SUM(views), 0) FROM public_page_view_days WHERE athlete_id = ${athleteId} AND day >= ${sinceDay}::date) AS views,
      (SELECT COUNT(*) FROM public_page_likes WHERE athlete_id = ${athleteId} AND created_at >= ${sinceTs}::timestamptz) AS likes,
      (SELECT COUNT(*) FROM partner_requests WHERE athlete_id = ${athleteId} AND confirmed_at >= ${sinceTs}::timestamptz) AS requests,
      (SELECT COUNT(*) FROM bookings WHERE athlete_id = ${athleteId} AND status <> 'unverified' AND created_at >= ${sinceTs}::timestamptz) AS bookings,
      (SELECT COALESCE(SUM(d.clicks), 0) FROM shop_click_days d JOIN shop_items i ON i.id = d.item_id
         WHERE i.athlete_id = ${athleteId} AND d.day >= ${sinceDay}::date) AS shop`));
  return {
    windowDays: PUBLIC_PAGE_METRICS_DAYS,
    since: sinceDay,
    views: num(row?.views), likes: num(row?.likes), requests: num(row?.requests), bookings: num(row?.bookings), shop: num(row?.shop),
  };
}
