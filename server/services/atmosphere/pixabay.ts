/**
 * atmosphere/pixabay.ts — Pixabay image search, rate-limited and cached, and the download of one hit.
 *
 * Terms this follows (https://pixabay.com/api/docs/, read 10 Oct 2026):
 *   - "By default, you can make up to 100 requests per 60 seconds. Requests are associated with the API key."
 *     → a rolling-window limiter per process (ATMOSPHERE_PIXABAY_MAX_REQUESTS per ATMOSPHERE_PIXABAY_WINDOW_MS,
 *       default 30 per 60 s, so three Cloud Run instances stay under 100). Over the limit a search is refused
 *       (PixabayRateLimited), never queued, so a burst cannot hold a request open.
 *   - "Requests must be cached for 24 hours." → every answer is kept 24 h, keyed by query + orientation + page size.
 *   - "Permanent hotlinking of images … is not allowed. If you intend to use the images, please download them to your
 *     server first." → the picker downloads the hit and stores its own copy; no Pixabay URL ever reaches a screen.
 *   - "Systematic mass downloads are not allowed." → only the hits the picker actually checks are downloaded, a few
 *     per slot (ATMOSPHERE_MAX_CHECKS_PER_SLOT), and only when no stored image already fits.
 *   - Show where images come from → the credit line stored with each image.
 *
 * The key is read from PIXABAY_API_KEY (Secret Manager) at call time and never logged: the request URL carrying it is
 * never written anywhere.
 */
import { createLogger } from "../../logger";
import { safeFetch } from "../../lib/safeFetch";
import { ATMOSPHERE, PIXABAY_KEY_ENV } from "./config";

const logger = createLogger("atmosphere/pixabay");

export interface PixabayHit {
  id: number;
  pageURL: string;
  tags: string;
  largeImageURL: string;
  webformatURL: string;
  imageWidth: number;
  imageHeight: number;
  user: string;
  user_id: number;
}

export class PixabayRateLimited extends Error {}
export class PixabayNotConfigured extends Error {}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer> }>;

let fetchImpl: FetchLike | null = null;
/** Tests swap the HTTP layer. Pass null to restore the real one (safeFetch: https only, no internal addresses). */
export function setPixabayFetch(f: FetchLike | null): void { fetchImpl = f; }
const doFetch: FetchLike = (url, init) => (fetchImpl ? fetchImpl(url, init) : (safeFetch(url, init ?? {}) as any));

const cache = new Map<string, { at: number; hits: PixabayHit[] }>();
let window: number[] = [];

/** Tests: forget the cache and the limiter. */
export function resetPixabayState(): void { cache.clear(); window = []; }

export function pixabayConfigured(): boolean {
  return !!process.env[PIXABAY_KEY_ENV]?.trim();
}

function takeSlot(now: number): boolean {
  const since = now - ATMOSPHERE.PIXABAY_WINDOW_MS;
  window = window.filter((t) => t > since);
  if (window.length >= ATMOSPHERE.PIXABAY_MAX_REQUESTS) return false;
  window.push(now);
  return true;
}

export interface SearchResult {
  hits: PixabayHit[];
  /** True when the answer came from the 24 h cache (no request was made). */
  cached: boolean;
}

/** Search photos. safesearch on, photos only (no illustrations or vectors), at least 1280 px wide. */
export async function searchPixabay(query: string, orientation: "horizontal" | "vertical"): Promise<SearchResult> {
  const q = query.trim().slice(0, 100);
  const perPage = ATMOSPHERE.PIXABAY_PER_PAGE;
  const key = `${q.toLowerCase()}|${orientation}|${perPage}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ATMOSPHERE.PIXABAY_CACHE_MS) return { hits: hit.hits, cached: true };

  const apiKey = process.env[PIXABAY_KEY_ENV]?.trim();
  if (!apiKey) throw new PixabayNotConfigured(`${PIXABAY_KEY_ENV} is not set`);
  if (!takeSlot(now)) throw new PixabayRateLimited("Pixabay request limit reached for this window");

  const params = new URLSearchParams({
    key: apiKey, q, image_type: "photo", orientation, safesearch: "true", per_page: String(perPage),
    min_width: "1280", order: "popular",
  });
  const res = await doFetch(`https://pixabay.com/api/?${params.toString()}`);
  if (res.status === 429) throw new PixabayRateLimited("Pixabay answered 429");
  if (!res.ok) {
    // The status only: the URL carries the key.
    logger.warn({ status: res.status }, "pixabay search failed");
    throw new Error(`Pixabay search failed (${res.status})`);
  }
  const body = await res.json();
  const hits: PixabayHit[] = (Array.isArray(body?.hits) ? body.hits : []).filter(
    (h: any) => typeof h?.id === "number" && typeof h?.largeImageURL === "string" && typeof h?.pageURL === "string",
  );
  cache.set(key, { at: now, hits });
  return { hits, cached: false };
}

/** Download one hit's large image (≤ 1280 px), the copy we check and store. */
export async function downloadHit(h: PixabayHit, maxBytes = 8 * 1024 * 1024): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const res = await doFetch(h.largeImageURL);
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(contentType)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.byteLength || buf.byteLength > maxBytes) return null;
    return { bytes: buf, contentType };
  } catch (err: any) {
    logger.warn({ pixabayId: h.id, error: String(err?.message ?? err).slice(0, 120) }, "pixabay download failed");
    return null;
  }
}
