/**
 * atmosphere/library.ts — the shared atmosphere library (0120; DESIGN.md §9; owner decisions 10 Oct 2026): one
 * set of stored photos reused by every athlete, hand-picked from Unsplash OR Pexels. This file is what the two import
 * scripts share:
 *
 *   scripts/fill-atmosphere-library.ts    a JSON list of hand-picked photo pages → the library (resumable)
 *   scripts/import-atmosphere-image.ts    one hand-picked photo page → the library
 *
 * For each photo: Unsplash — the page's normal download URL (unsplash.com/photos/<id>/download) is resolved to its
 * file on images.unsplash.com (a redirect to plus.unsplash.com means Unsplash+, which is paid: refused); Pexels — the
 * id from the page URL (pexels.com/photo/<slug>-<id>/) downloads directly from the keyless image CDN
 * (images.pexels.com/photos/<id>/pexels-photo-<id>.jpeg), no API key. Either way the file is downloaded, resized to
 * 1600 px on the long edge and encoded as WebP (aimed at 150–250 KB), checked (the atmosphere/check vision skill, or a
 * named person's review), stored once at atmosphere/shared/<sport|general|signin>/<id>.webp in the media bucket, and
 * recorded in atmosphere_library with its page, photographer (our records only: neither licence needs attribution and
 * the app shows none), licence, tags and purposes.
 *
 * No Unsplash or Pexels API beyond that one keyless CDN fetch, no search, no hotlinking: the app only ever loads our
 * stored copy. Nothing here names an athlete, sport or brand: the sport ids come from the one sport list
 * (shared/sports.ts), the photos from the list.
 */
import sharp from "sharp";
import { OTHER_SPORT, SPORTS, type Sport } from "../../../shared/sports";
import { z } from "zod";

// ─── Vocabulary ───────────────────────────────────────────────────────────────────────────────────────────────────

export const LIBRARY_CATEGORIES = ["sport", "general", "signin"] as const;
export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number];

/**
 * What a photo suits (the picker matches a slot's purpose / category against these):
 *   - the five goal and recommendation domains (DESIGN.md §9 category defaults), for sport photos;
 *   - the general themes the owner listed, for general photos;
 *   - `signin` for the sign-in hero.
 */
export const LIBRARY_PURPOSES = [
  "performance", "audience", "commercial", "impact", "positioning",
  "empty_state", "training", "travel", "studio", "stadium", "texture",
  "signin",
] as const;
export type LibraryPurpose = (typeof LIBRARY_PURPOSES)[number];

/** The two sources the list may pick photos from. */
export const LIBRARY_SOURCES = ["unsplash", "pexels"] as const;
export type LibrarySource = (typeof LIBRARY_SOURCES)[number];

export const UNSPLASH_LICENCE = "Unsplash License";
export const PEXELS_LICENCE = "Pexels License";
/** The exact licence string each source's page must show; an entry's `licence` must match its source. */
export const LICENCE_BY_SOURCE: Record<LibrarySource, string> = { unsplash: UNSPLASH_LICENCE, pexels: PEXELS_LICENCE };
export const LONG_EDGE = 1600;
export const TARGET_MAX_BYTES = 250 * 1024;

/** The sport a photo is filed under when the athlete's sport is not in the grid. */
export { OTHER_SPORT };

/**
 * The sport ids of the onboarding sport grid — THE one sport list (shared/sports.ts, which the app's grid and the landing
 * page's generated landing/sports.js also read) — plus "other". `list` is for tests.
 */
export function sportGrid(list: ReadonlyArray<Pick<Sport, "id" | "label">> = SPORTS): Array<{ id: string; label: string }> {
  if (!list.length) throw new Error("shared/sports.ts: the sport list is empty");
  return [...list.map((s) => ({ id: s.id, label: s.label })), { id: OTHER_SPORT, label: "Other" }];
}

// ─── One list entry ───────────────────────────────────────────────────────────────────────────────────────────────

const UNSPLASH_PAGE_RE = /^https:\/\/unsplash\.com\/photos\/(?:[a-z0-9-]*-)?([A-Za-z0-9_-]{11})\/?$/;
const PEXELS_PAGE_RE = /^https:\/\/(?:www\.)?pexels\.com\/photo\/[a-z0-9-]*-(\d+)\/?$/i;

/** The Unsplash photo id from its page URL (the last 11-character segment of the slug). */
export function unsplashIdOf(page: string): string | null {
  return UNSPLASH_PAGE_RE.exec(page.trim())?.[1] ?? null;
}

/** The Pexels photo id from its page URL (pexels.com/photo/<slug>-<id>/ — the trailing digits). */
export function pexelsIdOf(page: string): string | null {
  return PEXELS_PAGE_RE.exec(page.trim())?.[1] ?? null;
}

/** Which source a page URL belongs to, or null if it matches neither. */
export function sourceOf(page: string): LibrarySource | null {
  if (unsplashIdOf(page) !== null) return "unsplash";
  if (pexelsIdOf(page) !== null) return "pexels";
  return null;
}

/** The photo id from either an Unsplash or a Pexels page URL. */
export function photoIdOf(page: string): string | null {
  return unsplashIdOf(page) ?? pexelsIdOf(page);
}

export const LibraryEntrySchema = z.object({
  page: z.string().refine((p) => sourceOf(p) !== null, "page must be an https://unsplash.com/photos/<slug> or https://www.pexels.com/photo/<slug>-<id> URL"),
  /** The page's source. Optional (derived from `page` when absent); if given it must agree with the page URL. */
  source: z.enum(LIBRARY_SOURCES).optional(),
  category: z.enum(LIBRARY_CATEGORIES),
  sport: z.string().regex(/^[a-z0-9_]+$/).nullable().optional(),
  purposes: z.array(z.enum(LIBRARY_PURPOSES)).min(1).max(6),
  tags: z.array(z.string().min(1).max(40)).max(12).default([]),
  photographer: z.string().max(120).nullable().optional(),
  photographerUrl: z.string().regex(/^https:\/\/(?:unsplash\.com|(?:www\.)?pexels\.com)\/@[A-Za-z0-9_.-]+\/?$/).nullable().optional(),
  /** What the page itself says; the import refuses anything but the source's standard licence. */
  licence: z.enum([UNSPLASH_LICENCE, PEXELS_LICENCE]),
  /** A short description of what is in the photo (the page's alt text), for the contact sheet and the check. */
  title: z.string().max(300).optional(),
  /** false = a reviewed candidate the list keeps for the record but never imports (no repeats; one active pick per sport). */
  active: z.boolean().default(true),
  /** Why a retired candidate is inactive — kept for the record; the import scripts never read it. */
  retiredReason: z.string().max(500).optional(),
  /** A reviewer's note (e.g. a visible-logo flag) — kept for the record; the import scripts never read it. */
  reviewNote: z.string().max(500).optional(),
}).strict(); // every field a list entry can carry is named above; a typo (e.g. "actve") fails loudly instead of being silently dropped
export type LibraryEntry = Omit<z.infer<typeof LibraryEntrySchema>, "source"> & { source: LibrarySource };

/** Validate a list entry against the vocabulary and the sport grid. Throws with every problem named. */
export function parseEntry(raw: unknown, sports: ReadonlySet<string>): LibraryEntry {
  const e = LibraryEntrySchema.parse(raw);
  const problems: string[] = [];
  const src = sourceOf(e.page)!; // the page refine already guarantees this
  if (e.source && e.source !== src) problems.push(`page is a ${src} URL but source says "${e.source}"`);
  if (e.licence !== LICENCE_BY_SOURCE[src]) problems.push(`a ${src} photo needs the licence "${LICENCE_BY_SOURCE[src]}"`);
  if (e.category === "sport") {
    if (!e.sport) problems.push("a sport photo needs `sport`");
    else if (!sports.has(e.sport)) problems.push(`sport "${e.sport}" is not in the onboarding grid (or "other")`);
  } else if (e.sport) problems.push(`a ${e.category} photo has no sport`);
  if (problems.length) throw new Error(`${e.page}: ${problems.join("; ")}`);
  return { ...e, source: src, sport: e.category === "sport" ? e.sport! : null, tags: e.tags.map((t) => t.toLowerCase().trim()) };
}

/** Where the stored copy lives (saveBuffer adds ".webp"). */
export function objectBase(e: Pick<LibraryEntry, "category" | "sport">, id: string): string {
  const group = e.category === "sport" ? e.sport! : e.category;
  return `atmosphere/shared/${group}/${id}`;
}

// ─── Download ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: { redirect?: "manual" | "follow"; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; headers: { get(n: string): string | null }; arrayBuffer(): Promise<ArrayBuffer>;
}>;

export class UnsplashPlusError extends Error {}

const UA = "Mozilla/5.0 (compatible; NomilaAtmosphereImport/1.0)";

/**
 * Resolve the page's normal download URL to its file and download it. The file must be on images.unsplash.com; a
 * redirect to plus.unsplash.com (Unsplash+, paid) is refused. The file is requested at 2400 px wide (Unsplash's own
 * resize), enough for a 1600 px copy without pulling a 20 MB original.
 */
/** Each request (the redirect, then the file) gives up after this long, so a stalled connection fails one photo, not the run. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

export async function downloadUnsplashPhoto(id: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, maxBytes = 25 * 1024 * 1024, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<{ bytes: Buffer; fileUrl: string }> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error(`not an Unsplash photo id: ${id}`);
  const res = await fetchImpl(`https://unsplash.com/photos/${id}/download?force=true`, { redirect: "manual", headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location) throw new Error(`${id}: the download URL did not redirect to a file (${res.status})`);
  // Unsplash's bot check answers with a relative redirect to its challenge page: back off and run again later.
  if (location.startsWith("/")) throw new Error(`${id}: Unsplash asked for a bot check (${location.split("?")[0]}); wait and run again`);
  const file = new URL(location);
  if (file.hostname === "plus.unsplash.com") throw new UnsplashPlusError(`${id}: Unsplash+ (paid licence) — not imported`);
  if (file.protocol !== "https:" || file.hostname !== "images.unsplash.com") throw new Error(`${id}: unexpected file host ${file.hostname}`);
  file.searchParams.set("w", "2400");
  file.searchParams.set("fm", "jpg");
  file.searchParams.delete("dl");
  const img = await fetchImpl(file.toString(), { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!img.ok) throw new Error(`${id}: the file download failed (${img.status})`);
  const ct = (img.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!/^image\/(jpeg|png|webp)$/.test(ct)) throw new Error(`${id}: not an image (${ct || "no content type"})`);
  const bytes = Buffer.from(await img.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new Error(`${id}: the file is empty or too large`);
  return { bytes, fileUrl: `${file.origin}${file.pathname}` };
}

/**
 * Download a Pexels photo straight from its keyless image CDN — no page scrape, no redirect to resolve, no API key.
 * Requested at a 2400 px wide rendition (Pexels' own resize via query params), enough for a 1600 px copy.
 */
export async function downloadPexelsPhoto(id: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, maxBytes = 25 * 1024 * 1024, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<{ bytes: Buffer; fileUrl: string }> {
  if (!/^[0-9]+$/.test(id)) throw new Error(`not a Pexels photo id: ${id}`);
  const url = `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=2400`;
  // No redirect is expected from this CDN URL (unlike Unsplash's /download, a redirect IS the mechanism); manual mode
  // + refusing any 3xx stops a response silently sending us to download from an unverified host.
  const img = await fetchImpl(url, { redirect: "manual", headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (img.status >= 300 && img.status < 400) throw new Error(`${id}: unexpected redirect from the Pexels CDN (${img.status})`);
  if (!img.ok) throw new Error(`${id}: the file download failed (${img.status})`);
  const ct = (img.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!/^image\/(jpeg|png|webp)$/.test(ct)) throw new Error(`${id}: not an image (${ct || "no content type"})`);
  const bytes = Buffer.from(await img.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new Error(`${id}: the file is empty or too large`);
  return { bytes, fileUrl: url };
}

// ─── Resize + encode ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * 1600 px on the long edge (never enlarged), EXIF orientation applied and stripped, WebP. Quality steps down from 80
 * to 60 until the file is at most 250 KB; a very busy texture that is still larger is then made smaller (1400, 1200,
 * 1000 px on the long edge) at quality 60 rather than blurred further.
 */
export async function toLibraryWebp(input: Buffer): Promise<{ bytes: Buffer; width: number; height: number; quality: number }> {
  const encode = (edge: number, quality: number) => sharp(input).rotate()
    .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
    .webp({ quality, effort: 5 })
    .toBuffer({ resolveWithObject: true });
  const tries: Array<[number, number]> = [[LONG_EDGE, 80], [LONG_EDGE, 75], [LONG_EDGE, 70], [LONG_EDGE, 65], [LONG_EDGE, 60], [1400, 60], [1200, 60], [1000, 60]];
  let out: { data: Buffer; info: sharp.OutputInfo } | null = null;
  let quality = 80;
  for (const [edge, q] of tries) {
    out = await encode(edge, q); quality = q;
    if (out.data.byteLength <= TARGET_MAX_BYTES) break;
  }
  return { bytes: out!.data, width: out!.info.width, height: out!.info.height, quality };
}

// ─── Check ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The atmosphere/check answers (the vision skill's six fields), as the import records them. */
export interface CheckAnswers {
  person: boolean; face: boolean; logo: boolean; text: boolean; watermark: boolean; fits_purpose: boolean; reason: string;
}

/**
 * The library's verdict from the check's answers. Atmosphere photos (sport, general) must show no person, face, logo,
 * text or watermark. Sign-in photos may show people (sign-in is marketing, DESIGN.md §9) but no logo, text or
 * watermark; a visible face is allowed there and only noted (the list prefers photos without prominent faces).
 */
export function libraryVerdict(category: LibraryCategory, a: CheckAnswers): { accepted: boolean; reasons: string[] } {
  const flags: Array<keyof CheckAnswers> = category === "signin" ? ["logo", "text", "watermark"] : ["person", "face", "logo", "text", "watermark"];
  const reasons: string[] = flags.filter((f) => a[f] !== false).map(String);
  if (a.fits_purpose !== true) reasons.push("off_purpose");
  return { accepted: reasons.length === 0, reasons };
}
