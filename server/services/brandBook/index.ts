/**
 * brandBook — the athlete's brand book (BRAND_BOOK_V1 retired 2 Nov 2026: always on): ten chapters written to her as "you", built from her own records
 * (shared/brandBook.ts for the chapters). Chapter 9's rates are re-read on every read; chapter 10's goals are read live
 * by the app.
 *
 *   startBrandBook   her tap ("Write my brand book" / "Rewrite it"): the row goes to building and the build runs in the
 *                    background (about a minute: one Fable call, one editor call, image reads). A build already running
 *                    is not started twice.
 *   readBrandBook    the book as the app shows it, every image and the reel signed for an hour
 *   chooseLine       her swap: a page's slot takes another of its stored options — no model, no cost
 *   writeLine        her own words for one slot (Mila writes them at her request in the chat) — no model, no cost
 *   mergedBook       the engine's book with her choices on top — what the app, Mila and the reel all read
 *
 * Her choices (chooseLine / writeLine) are stored as overrides beside the engine's book, never in it (overrides.ts, the
 * Nomi Card editor's pattern), so a rebuild replaces `data` and every line she picked or wrote still shows.
 *   startBookReel    her tap ("Make it a reel"): the motion version renders in the background (reel.ts)
 *
 * Nothing here names an athlete, sport, school or brand.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { brandBooks } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { signedUrl } from "../../lib/mediaStore";
import { listPreferences } from "../../agent/memory";
import { neverTermsFrom } from "../../agent/neverTerms";
import { loadCopyCtx } from "../copywriter";
import { getAthleteContext } from "../athleteContext";
import { readRates } from "../rates";
import {
  BRAND_BOOK_CONTRACT, type BookPage, type BookRate, type BrandBookData, type BrandBookReel, type BrandBookResponse,
} from "../../../shared/brandBook";
import { restateLines, writeBookCopy } from "./copy";
import { assemblePages, bookBriefs, chipFactsFor, readLines, withRestated } from "./pages";
import { readBookSources } from "./sources";
import { applyBookOverrides, lineKey, type BookOverrides } from "./overrides";

const logger = createLogger("brandBook");

/** A build older than this is treated as dead (the instance went away mid-build) and may start again. */
const STALE_MS = 10 * 60_000;

type Row = typeof brandBooks.$inferSelect;
async function rowOf(athleteId: string): Promise<Row | null> {
  const [row] = await db.select().from(brandBooks).where(eq(brandBooks.athlete_id, athleteId)).limit(1);
  return row ?? null;
}

/** The book she sees: the engine's book with her choices on top (overrides.ts). Null when there is none in the current shape. */
export function mergedBook(row: Pick<Row, "data" | "overrides"> | null): BrandBookData | null {
  const data = row?.data as BrandBookData | null;
  if (!row || !data || data.contract !== BRAND_BOOK_CONTRACT) return null;
  return applyBookOverrides(data, row.overrides as BookOverrides | null).book;
}

/**
 * Store one line's choice in her overrides (one atomic jsonb write; the engine's book is not touched). Choosing the
 * engine's own line for that slot clears her override instead, so the slot follows the engine again on later rebuilds.
 */
async function saveLineChoice(
  athleteId: string, row: Row | null, pageId: string, slot: string, choice: { text: string; pick?: number },
): Promise<void> {
  const key = lineKey(pageId, slot);
  const engine = (row?.data as BrandBookData | null)?.pages.find((p) => p.id === pageId)?.lines[slot]?.text;
  const overrides = choice.text === engine
    ? sql`CASE WHEN ${brandBooks.overrides} IS NULL THEN NULL ELSE ${brandBooks.overrides} #- ARRAY['copy', ${key}::text] END`
    : sql`jsonb_set(coalesce(${brandBooks.overrides}, '{}'::jsonb), '{copy}', coalesce(${brandBooks.overrides}->'copy', '{}'::jsonb) || ${JSON.stringify({ [key]: choice })}::jsonb)`;
  await db.update(brandBooks).set({ overrides, updated_at: new Date() }).where(eq(brandBooks.athlete_id, athleteId));
}

/** Build the book now (the background body). Exported for the script that runs it for one athlete. */
export async function buildBrandBook(athleteId: string, version: number): Promise<BrandBookData> {
  const a = await getAthleteContext(athleteId);
  const ctx = await loadCopyCtx(athleteId);
  const voice = ctx.voice ? { tone: ctx.voice.tone, phrases: ctx.voice.phrases, avoid: ctx.voice.avoid } : null;
  const read = await readBookSources(athleteId, { firstName: a.firstName || a.name, brief: ctx.brief ?? null, voice });
  // The read lines speak to her as "you" too (research writes them in the third person).
  const sources = withRestated(read, await restateLines(read.firstName, readLines(read)));
  const neverTerms = neverTermsFrom(await listPreferences(athleteId).catch(() => []));
  const copy = await writeBookCopy(ctx, bookBriefs(sources), sources.captions, { neverTerms, chipFacts: chipFactsFor(sources) });
  if (!copy) throw new Error("the copywriter could not write the book");
  return {
    contract: BRAND_BOOK_CONTRACT, version, generatedAt: new Date().toISOString(), firstName: sources.firstName,
    pages: assemblePages(sources, copy.lines),
  };
}

/**
 * Mark the book as building (a new version), unless a build is already running. Returns the version, whether this call
 * started it, and whether a book was there before (a failed rebuild keeps showing the old one).
 */
export async function markBrandBookBuilding(athleteId: string): Promise<{ version: number; started: boolean; hadData: boolean }> {
  const cur = await rowOf(athleteId);
  if (cur?.status === "building" && Date.now() - new Date(cur.updated_at).getTime() < STALE_MS) {
    return { version: cur.version, started: false, hadData: !!cur.data };
  }
  const version = (cur?.version ?? 0) + 1;
  await db.insert(brandBooks).values({ athlete_id: athleteId, version, status: "building", updated_at: new Date() })
    .onConflictDoUpdate({ target: brandBooks.athlete_id, set: { version, status: "building", error: null, updated_at: new Date() } });
  return { version, started: true, hadData: !!cur?.data };
}

/**
 * Write the book for a version marked building, and record ready or failed. Never throws: true when the book is ready.
 * startBrandBook runs it in the background; the documents workflow (Mila in the chat) awaits it.
 */
export async function completeBrandBook(athleteId: string, version: number, hadData: boolean): Promise<boolean> {
  try {
    const data = await buildBrandBook(athleteId, version);
    // Only `data` is replaced: her choices (overrides) stay and are applied over the new book when it is read.
    const [saved] = await db.update(brandBooks).set({ status: "ready", data, generated_at: new Date(), updated_at: new Date(), error: null })
      .where(sql`${brandBooks.athlete_id} = ${athleteId} AND ${brandBooks.version} = ${version}`)
      .returning({ overrides: brandBooks.overrides });
    const { orphans } = applyBookOverrides(data, saved?.overrides as BookOverrides | null);
    logger.info({ athleteId, version, pages: data.pages.length }, "brand book ready");
    // A line she chose whose slot this build no longer has: kept (never deleted), not shown, noted here.
    if (orphans.length) logger.info({ athleteId, version, orphans }, "brand book: her choices kept but not shown (their lines are not in this build)");
    return true;
  } catch (err: any) {
    logger.warn({ athleteId, version, error: String(err?.message ?? err).slice(0, 200) }, "brand book failed");
    await db.update(brandBooks).set({ status: hadData ? "ready" : "failed", error: "Mila couldn't finish your brand book this time. Try again in a minute.", updated_at: new Date() })
      .where(sql`${brandBooks.athlete_id} = ${athleteId} AND ${brandBooks.version} = ${version}`).catch(() => {});
    return false;
  }
}

/** Her tap: start (or restart) the book. Returns the status she sees now. */
export async function startBrandBook(athleteId: string): Promise<{ status: "building"; version: number; started: boolean }> {
  const m = await markBrandBookBuilding(athleteId);
  if (m.started) void completeBrandBook(athleteId, m.version, m.hadData);
  return { status: "building", version: m.version, started: m.started };
}

const sign = async (p: string | null | undefined): Promise<string | null> => (p ? signedUrl(p).catch(() => null) : null);

/** Her rates as the rates screen holds them: a suggested range and/or her own minimum, content and time rows. */
export async function bookRates(athleteId: string): Promise<BookRate[]> {
  const view = await readRates(athleteId).catch(() => null);
  return (view?.rows ?? [])
    // Mila's suggested ranges, and any minimum she set herself on the rates screen (an older blanket minimum alone is not
    // a position worth a row).
    .filter((r) => r.group !== "booking" && (r.suggested || r.minimum?.source === "set"))
    .map((r) => ({
      rateType: r.rate_type, label: r.label,
      low: r.suggested?.low ?? null, high: r.suggested?.high ?? null, currency: r.suggested?.currency ?? "USD",
      // Only a minimum SHE set on Your rates. An older per-kind floor ("earlier") is a computed figure, never shown as hers.
      minimum: r.minimum?.source === "set" ? r.minimum.value : null,
    }))
    .slice(0, 6);
}

/** The book with every path signed and chapter 9's rates read now. */
/** The current read of record's score, date and dimensions — or null (withheld / none), when the stored ones stay. */
async function liveFound(athleteId: string): Promise<{ score: number | null; asOf: string | null; dimensions: Array<{ key: string; score: number | null }> } | null> {
  const { buildMyIntelligence } = await import("../intelligence/views/myIntelligence");
  const a = (await buildMyIntelligence(athleteId).catch(() => null))?.assessment ?? null;
  if (!a || typeof a.score !== "number") return null;
  return { score: a.score, asOf: a.evidenceAsOf ?? null, dimensions: a.dimensions.map((d) => ({ key: d.key, score: d.score })) };
}

async function signedBook(athleteId: string, data: BrandBookData): Promise<BrandBookData> {
  const rates = data.pages.some((p) => p.id === "commercial") ? await bookRates(athleteId) : [];
  // The M.I.A. number and dimensions are read LIVE from the read of record (buildMyIntelligence, the one function Me,
  // My Intelligence and the Nomi Card read), never frozen at build time — a newer evaluation shows everywhere at once.
  const live = data.pages.some((p) => p.extra?.found) ? await liveFound(athleteId) : null;
  const pages: BookPage[] = await Promise.all(data.pages.map(async (p) => ({
    ...p,
    // Pillars keep their positions (image i belongs to pillar i; "" = that pillar is type-led); other pages drop gaps.
    images: p.id === "pillars"
      ? await Promise.all(p.images.map(async (x) => (x ? (await sign(x)) ?? "" : "")))
      : (await Promise.all(p.images.filter(Boolean).map(sign))).filter((u): u is string => !!u),
    // (imageTiers rides along unchanged: parallel to the stored images; a failed signature is rare and only shortens images.)
    ...(p.backdrop ? { backdrop: (await sign(p.backdrop)) ?? undefined } : {}),
    ...(p.extra ? {
      extra: {
        ...p.extra,
        ...(p.extra.listening ? { listening: {
          ...p.extra.listening,
          posts: (await Promise.all(p.extra.listening.posts.map(async (x) => ({ ...x, image: (await sign(x.image)) ?? "" })))).filter((x) => x.image),
        } } : {}),
        ...(p.extra.commercial ? { commercial: { ...p.extra.commercial, rates } } : {}),
        ...(p.extra.found && live ? { found: { ...p.extra.found, ...live } } : {}),
      },
    } : {}),
  })));
  return { ...data, pages };
}

export async function readBrandBook(athleteId: string): Promise<BrandBookResponse> {
  const row = await rowOf(athleteId);
  if (!row) return { contract: BRAND_BOOK_CONTRACT, status: "none", version: 0, book: null, reel: null, error: null };
  const stored = row.data as BrandBookData | null;
  // A book written in an older shape is not sent: she rewrites it (the app offers "Rewrite it").
  const oldShape = !!stored && stored.contract !== BRAND_BOOK_CONTRACT;
  // Her chosen and written lines over the engine's book (overrides.ts).
  const data = mergedBook(row);
  const stale = row.status === "building" && Date.now() - new Date(row.updated_at).getTime() >= STALE_MS;
  const reel = row.reel as BrandBookReel | null;
  return {
    contract: BRAND_BOOK_CONTRACT,
    status: oldShape && row.status !== "building" ? "none" : stale ? (data ? "ready" : "failed") : (row.status as BrandBookResponse["status"]),
    version: row.version,
    book: data ? await signedBook(athleteId, data) : null,
    reel: reel ? { ...reel, url: await sign(reel.gcsPath), posterUrl: await sign(reel.posterPath), gcsPath: undefined, posterPath: undefined } : null,
    error: row.error ?? null,
    ...(oldShape ? { stale: true } : {}),
  };
}

/** Her swap: page `pageId`, slot `slot`, option `index`. False when there is no such page, slot or option. */
export async function chooseLine(athleteId: string, pageId: string, slot: string, index: number): Promise<boolean> {
  // The options are the ones she sees (her own earlier words included); the choice goes to her overrides.
  const row = await rowOf(athleteId);
  const line = mergedBook(row)?.pages.find((p) => p.id === pageId)?.lines[slot];
  if (!line || !Number.isInteger(index) || index < 0 || index >= line.options.length) return false;
  await saveLineChoice(athleteId, row, pageId, slot, { text: line.options[index], pick: index });
  return true;
}

/**
 * Her own words for one line (Mila wrote them at her request in the chat): the slot shows `text`, and it joins the slot's
 * options so the app's swap still offers the earlier ones. False when there is no such page or slot. No model, no cost.
 */
export async function writeLine(athleteId: string, pageId: string, slot: string, text: string): Promise<boolean> {
  const row = await rowOf(athleteId);
  const line = mergedBook(row)?.pages.find((p) => p.id === pageId)?.lines[slot];
  const clean = text.replace(/\s+/g, " ").trim();
  if (!line || !clean) return false;
  // Her words go to her overrides; the merged view shows them and adds them to the slot's options.
  await saveLineChoice(athleteId, row, pageId, slot, { text: clean });
  return true;
}

export { startBookReel } from "./reel";
