/**
 * shop/items.ts — her shelf: read, add, edit, order, publish, hide, delete (docs/design/shop-her-picks.md §5–6).
 *
 * Every function takes the athlete id first and filters every query by it: an id that is not hers is "not found",
 * never someone else's row. The routes and the Mila tools both call these; neither writes SQL of its own.
 *
 * HER WORDS ONLY: `blurb` is set only by `updateItem` (her edit). Mila's suggestion goes to `blurb_suggestion`, which
 * no public read returns.
 */
import { randomBytes } from "node:crypto";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { shopClickDays, shopItems, shopSettings } from "../../../shared/schema";
import { LIMITS, isShopCategory, type ShopCategory, type ShopItemStatus } from "./config";
import { checkLink, oneLine, readLink, type LinkRead, type ReadDeps } from "./linkMeta";
import { NEEDS_CONFIRMATION, eligibility, warningsFor, type Eligibility, type Judge, type ShopWarning } from "./checks";

type Db = typeof defaultDb;
export type ShopItemRow = typeof shopItems.$inferSelect;

export class ShopError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** An opaque 12-character code for /go/<code>: random, never derived from an id. */
export function newCode(): string {
  const bytes = randomBytes(24);
  let out = "";
  for (const b of bytes) { if (b < 248) out += BASE62[b % 62]; if (out.length === 12) break; }
  return out.length === 12 ? out : newCode();
}
export const CODE_PATTERN = /^[0-9A-Za-z]{12}$/;

export interface ShopItemView {
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
  status: ShopItemStatus;
  position: number;
  publishedAt: string | null;
  clicks7d: number;
  clicks30d: number;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
export function toView(r: ShopItemRow, clicks?: { d7: number; d30: number }): ShopItemView {
  return {
    id: r.id, url: r.url, host: r.url_host, source: r.source, networkTag: r.network_tag, title: r.title, imageUrl: r.image_url,
    priceCents: r.price_cents, currency: r.currency, merchant: r.merchant, category: r.category, blurb: r.blurb,
    blurbSuggestion: r.blurb_suggestion, discountCode: r.discount_code, status: r.status as ShopItemStatus, position: r.position,
    publishedAt: iso(r.published_at), clicks7d: clicks?.d7 ?? 0, clicks30d: clicks?.d30 ?? 0,
  };
}

const dayMinus = (now: Date, n: number) => new Date(now.getTime() - n * 86_400_000).toISOString().slice(0, 10);

/** Click totals per item for the last 7 and 30 days (today included). */
export async function clickTotals(itemIds: string[], now: Date = new Date(), db: Db = defaultDb): Promise<Map<string, { d7: number; d30: number }>> {
  const out = new Map<string, { d7: number; d30: number }>();
  if (!itemIds.length) return out;
  const since7 = dayMinus(now, 6);
  const rows = await db.select({ item: shopClickDays.item_id, day: shopClickDays.day, clicks: shopClickDays.clicks }).from(shopClickDays)
    .where(and(inArray(shopClickDays.item_id, itemIds), gte(shopClickDays.day, dayMinus(now, 29))));
  for (const r of rows) {
    const cur = out.get(r.item) ?? { d7: 0, d30: 0 };
    cur.d30 += r.clicks;
    if (String(r.day) >= since7) cur.d7 += r.clicks;
    out.set(r.item, cur);
  }
  return out;
}

export async function listItems(athleteId: string, opts: { db?: Db; now?: Date } = {}): Promise<ShopItemView[]> {
  const db = opts.db ?? defaultDb;
  const rows = await db.select().from(shopItems).where(eq(shopItems.athlete_id, athleteId)).orderBy(asc(shopItems.position), asc(shopItems.created_at));
  const clicks = await clickTotals(rows.map((r) => r.id), opts.now, db);
  return rows.map((r) => toView(r, clicks.get(r.id)));
}

async function ownItem(athleteId: string, id: string, db: Db): Promise<ShopItemRow> {
  const [row] = await db.select().from(shopItems).where(and(eq(shopItems.id, id), eq(shopItems.athlete_id, athleteId))).limit(1);
  if (!row) throw new ShopError(404, "not_found", "pick not found");
  return row;
}

// ─── Preview (writes nothing) ──────────────────────────────────────────────────────────────────────────────────

export interface Preview { read: LinkRead; category: ShopCategory | null; warnings: ShopWarning[]; eligibility: Eligibility }

export async function previewLink(athleteId: string, rawUrl: unknown, deps: { db?: Db; read?: ReadDeps; judge?: Judge } = {}): Promise<Preview> {
  const db = deps.db ?? defaultDb;
  const link = checkLink(rawUrl);
  if (!link.ok) throw new ShopError(400, "bad_url", link.error);
  const [read, elig] = await Promise.all([readLink(link, deps.read), eligibility(athleteId, { db })]);
  const checked = await warningsFor(athleteId, { title: read.title ?? link.host, merchant: read.merchant, host: link.host, url: link.url, category: null }, { db, judge: deps.judge, elig });
  return { read, category: checked.category, warnings: checked.warnings, eligibility: elig };
}

// ─── Add (a draft, always) ─────────────────────────────────────────────────────────────────────────────────────

export async function addItem(athleteId: string, body: { url: unknown; suggested_blurb?: unknown }, deps: { db?: Db; read?: ReadDeps; judge?: Judge } = {}): Promise<{ item: ShopItemView; existing: boolean; warnings: ShopWarning[] }> {
  const db = deps.db ?? defaultDb;
  const link = checkLink(body.url);
  if (!link.ok) throw new ShopError(400, "bad_url", link.error);
  const [dupe] = await db.select().from(shopItems).where(and(eq(shopItems.athlete_id, athleteId), eq(shopItems.url, link.url))).limit(1);
  if (dupe) return { item: toView(dupe), existing: true, warnings: [] };
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(shopItems).where(eq(shopItems.athlete_id, athleteId));
  if (n >= LIMITS.items) throw new ShopError(409, "too_many", `a shelf holds up to ${LIMITS.items} picks`);

  const read = await readLink(link, deps.read);
  const checked = await warningsFor(athleteId, { title: read.title ?? link.host, merchant: read.merchant, host: link.host, url: link.url, category: null }, { db, judge: deps.judge });
  const [{ maxPos }] = await db.select({ maxPos: sql<number>`coalesce(max(${shopItems.position}), -1)::int` }).from(shopItems).where(eq(shopItems.athlete_id, athleteId));
  const [row] = await db.insert(shopItems).values({
    athlete_id: athleteId, code: newCode(), url: link.url, url_host: link.host, source: read.source, network_tag: read.networkTag,
    title: read.title ?? link.host, image_url: read.imageUrl, price_cents: read.priceCents, currency: read.currency, merchant: read.merchant,
    category: checked.category, blurb_suggestion: oneLine(body.suggested_blurb, LIMITS.blurb), status: "draft", position: maxPos + 1,
    metadata_fetched_at: read.notes.includes("read") ? new Date() : null,
  }).onConflictDoNothing().returning();
  if (!row) { // a concurrent add of the same link won
    const [again] = await db.select().from(shopItems).where(and(eq(shopItems.athlete_id, athleteId), eq(shopItems.url, link.url))).limit(1);
    return { item: toView(again), existing: true, warnings: [] };
  }
  return { item: toView(row), existing: false, warnings: checked.warnings };
}

// ─── Edit / publish / hide ─────────────────────────────────────────────────────────────────────────────────────

export interface ItemPatch { title?: unknown; blurb?: unknown; category?: unknown; discount_code?: unknown; status?: unknown; confirm_warnings?: unknown }

const optText = (v: unknown, max: number, field: string): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new ShopError(400, "bad_field", `${field} must be text`);
  const t = oneLine(v, max + 1);
  if (t && t.length > max) throw new ShopError(400, "too_long", `${field} is limited to ${max} characters`);
  return t;
};

export async function updateItem(athleteId: string, id: string, patch: ItemPatch, deps: { db?: Db; judge?: Judge; now?: Date } = {}): Promise<{ item: ShopItemView; warnings: ShopWarning[] }> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  const row = await ownItem(athleteId, id, db);
  const set: Partial<typeof shopItems.$inferInsert> = {};
  const title = optText(patch.title, LIMITS.title, "title");
  if (title === null) throw new ShopError(400, "bad_field", "a pick needs a title");
  if (title !== undefined) set.title = title;
  const blurb = optText(patch.blurb, LIMITS.blurb, "your line");
  if (blurb !== undefined) set.blurb = blurb;
  const code = optText(patch.discount_code, LIMITS.code, "discount code");
  if (code !== undefined) set.discount_code = code;
  if (patch.category !== undefined) {
    if (patch.category !== null && !isShopCategory(patch.category)) throw new ShopError(400, "bad_field", "unknown category");
    set.category = patch.category as ShopCategory | null;
  }
  let warnings: ShopWarning[] = [];
  if (patch.status !== undefined) {
    if (patch.status !== "live" && patch.status !== "hidden" && patch.status !== "draft") throw new ShopError(400, "bad_field", "status must be live, hidden or draft");
    if (patch.status === "live" && row.status !== "live") {
      const next = { ...row, ...set } as ShopItemRow;
      const elig = await eligibility(athleteId, { db, now });
      if (!elig.eligible) throw new ShopError(409, "not_eligible", "your shelf isn't open yet", { needs: elig.needs });
      const checked = await warningsFor(athleteId, { title: next.title, merchant: next.merchant, host: next.url_host, url: next.url, category: (next.category as ShopCategory | null) ?? null }, { db, judge: deps.judge, elig });
      if (!next.category) {
        if (!checked.category) throw new ShopError(409, "needs_category", "pick a category first");
        set.category = checked.category;
      }
      warnings = checked.warnings;
      const blocking = warnings.find((w) => w.code === "supplements_off");
      if (blocking) throw new ShopError(409, "supplements_off", blocking.text, { warnings });
      const toConfirm = warnings.filter((w) => NEEDS_CONFIRMATION.has(w.code));
      if (toConfirm.length && patch.confirm_warnings !== true) throw new ShopError(409, "needs_confirmation", "check these before you publish", { warnings: toConfirm });
      if (toConfirm.length) set.warnings_ack_at = now;
      if (!row.published_at) set.published_at = now;
    }
    set.status = patch.status;
  }
  if (!Object.keys(set).length) return { item: toView(row), warnings };
  set.updated_at = now;
  const [updated] = await db.update(shopItems).set(set).where(and(eq(shopItems.id, id), eq(shopItems.athlete_id, athleteId))).returning();
  return { item: toView(updated), warnings };
}

/** Her order: `ids` must be exactly her picks (any order). */
export async function reorderItems(athleteId: string, ids: unknown, db: Db = defaultDb): Promise<ShopItemView[]> {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new ShopError(400, "bad_field", "ids must be a list of pick ids");
  const mine = await db.select({ id: shopItems.id }).from(shopItems).where(eq(shopItems.athlete_id, athleteId));
  const set = new Set(mine.map((m) => m.id));
  if (ids.length !== set.size || new Set(ids).size !== ids.length || ids.some((x) => !set.has(x as string))) throw new ShopError(400, "bad_order", "send every one of your picks, once");
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) await tx.update(shopItems).set({ position: i }).where(and(eq(shopItems.id, ids[i] as string), eq(shopItems.athlete_id, athleteId)));
  });
  return listItems(athleteId, { db });
}

export async function deleteItem(athleteId: string, id: string, db: Db = defaultDb): Promise<void> {
  const gone = await db.delete(shopItems).where(and(eq(shopItems.id, id), eq(shopItems.athlete_id, athleteId))).returning({ id: shopItems.id });
  if (!gone.length) throw new ShopError(404, "not_found", "pick not found");
}

// ─── Her answers ───────────────────────────────────────────────────────────────────────────────────────────────

export interface SettingsPatch { adult_confirmed?: unknown; international_student?: unknown; international_ack?: unknown; supplements_opt_in?: unknown; school_apparel_sponsor?: unknown }

export async function updateSettings(athleteId: string, p: SettingsPatch, deps: { db?: Db; now?: Date } = {}): Promise<Eligibility> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  const set: Partial<typeof shopSettings.$inferInsert> = {};
  const bool = (v: unknown, f: string) => { if (typeof v !== "boolean") throw new ShopError(400, "bad_field", `${f} must be true or false`); return v; };
  if (p.adult_confirmed !== undefined) set.adult_confirmed_at = bool(p.adult_confirmed, "adult_confirmed") ? now : null;
  if (p.international_student !== undefined) {
    set.international_student = bool(p.international_student, "international_student");
    set.international_ack_at = null; // a changed answer needs a fresh acknowledgement
  }
  if (p.international_ack !== undefined) set.international_ack_at = bool(p.international_ack, "international_ack") ? now : null;
  if (p.supplements_opt_in !== undefined) set.supplements_opt_in_at = bool(p.supplements_opt_in, "supplements_opt_in") ? now : null;
  if (p.school_apparel_sponsor !== undefined) set.school_apparel_sponsor = optText(p.school_apparel_sponsor, LIMITS.sponsor, "school apparel sponsor") ?? null;
  if (Object.keys(set).length) {
    await db.insert(shopSettings).values({ athlete_id: athleteId, ...set, updated_at: now })
      .onConflictDoUpdate({ target: shopSettings.athlete_id, set: { ...set, updated_at: now } });
  }
  // An acknowledgement only counts for a "yes": a "no" leaves nothing to acknowledge.
  return eligibility(athleteId, { db, now });
}
