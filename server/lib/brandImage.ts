/**
 * brandImage.ts — best-effort brand image discovery from a domain's homepage.
 *
 * Two layers:
 *  1. `fetchBrandImageUrl(domain)` — the original single-image capture: the Open Graph
 *     `og:image` (also `og:image:secure_url` / `twitter:image`), falling back to a large
 *     `apple-touch-icon`. Cheap, no network beyond the homepage. Kept for incidental callers.
 *  2. `fetchBrandImages(domain)` — collects MANY homepage images (og:image + real product/
 *     lifestyle `<img>`s), then picks the representative set with a Gemini VISION rank
 *     (same inline-base64 pattern as server/lib/visionTag.ts). Returns { cover, images[] }
 *     — the cover for the card, the ranked list for the deal-detail brand-deck hero.
 *
 * Like brandResolver's logo_url (Clearbit), we store SOURCE URLs, not the binary — cheap and
 * correct for a card. GCS-rehosting the bytes is the durable upgrade (a third-party URL can
 * rot, redirect, or hotlink-block); the columns are unchanged by that future move.
 *
 * Contract: NEVER throws. Any failure (DNS, timeout, non-2xx, no tag, vision down) degrades —
 * `fetchBrandImageUrl` → null, `fetchBrandImages` → the heuristic order (or empty).
 */

import { parse } from "node-html-parser";
import { registrableDomain } from "./senderProfile";
import { genai, GEMINI } from "./models";
import { createLogger } from "../logger";
import { safeFetch } from "./safeFetch";

const logger = createLogger("lib/brandImage");

// Real-browser UA — some CDNs/edge WAFs serve an empty/blocked page to bare fetch UAs.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const TIMEOUT_MS = 15_000;
const HEAD_HTML_BYTES = 512 * 1024;   // og:image lives in <head> — cap the cheap path
const FULL_HTML_BYTES = 1_500 * 1024; // product <img>s live in <body> — read more for the multi path
const MAX_CANDIDATES = 12;            // homepage images to consider before vision
const VISION_MAX = 6;                 // how many to actually vision-score (cost/latency bound)
const SEARCH_PAGES_MAX = 5;           // pages from the cover search read for candidate images
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const VISION_CONCURRENCY = 3;

export interface BrandImages {
  /** Best single image for a brand card (ranked #1), or null. */
  cover: string | null;
  /** Representative images, best-first (includes the cover). Source URLs. */
  images: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single best brand image URL, or null. Cheap: homepage `og:image` / apple-touch-icon only,
 * no image bytes fetched, no vision. Kept for callers that just want one image.
 */
/**
 * candidateDomains — where a brand's homepage might actually live.
 *
 * Two gaps kept real brands imageless:
 *
 *  1. NO DOMAIN AT ALL. An advertiser named inside an agency's email (POPMART via Tec-Do,
 *     Celsius, DJI, Kalshi) gets a brand row, but the sending domain belongs to the
 *     AGENCY, so the advertiser's row has none. Guessing "<name>.com" recovers most of
 *     them — and costs nothing when wrong, because we only ever store an image we
 *     actually fetched.
 *  2. EMAIL-SENDING SUBDOMAINS. "e.lululemon.com", "us.mail.shein.com",
 *     "emails.fleetfeet.com" host no marketing page and carry no og:image. The
 *     registrable domain underneath does.
 *
 * Returns ordered candidates, best first, deduped.
 */
export function candidateDomains(name: string | null, domain: string | null): string[] {
  const out: string[] = [];
  const push = (d: string | null | undefined) => {
    const v = (d ?? "").toLowerCase().trim().replace(/^www\./, "");
    if (v && v.includes(".") && !out.includes(v)) out.push(v);
  };

  push(domain);

  // The peeled domain, from the one implementation in senderProfile. The prefix list and
  // this logic started here; they moved so brand RESOLUTION could share them rather than
  // grow a second copy that drifts. Fixing the two-part-suffix case came with the move —
  // this used to fall back to the last two labels regardless, offering "co.uk" as a
  // candidate for creatorlab.campfire.co.uk.
  push(registrableDomain(domain));

  // Guess from the brand name when we have nothing usable.
  const slug = (name ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  if (slug.length >= 3 && slug.length <= 24) {
    push(`${slug}.com`);
  }

  return out;
}

export async function fetchBrandImageUrl(domain: string): Promise<string | null> {
  const clean = cleanDomain(domain);
  if (!clean) return null;
  for (const base of [`https://www.${clean}`, `https://${clean}`]) {
    const found = await tryOne(base);
    if (found) return found;
  }
  return null;
}

/**
 * Collect several homepage images and rank the representative ones with a Gemini vision pass.
 * Never throws: on any failure returns the heuristic order (product-first, banner-last), or
 * empty. `opts.rank=false` skips the vision pass (heuristic order only).
 */
export async function fetchBrandImages(
  domain: string,
  opts: { rank?: boolean; max?: number } = {},
): Promise<BrandImages> {
  const clean = cleanDomain(domain);
  if (!clean) return { cover: null, images: [] };

  let candidates: string[] = [];
  for (const base of [`https://www.${clean}`, `https://${clean}`]) {
    candidates = await collectFromPage(base);
    if (candidates.length) break;
  }
  if (!candidates.length) return { cover: null, images: [] };

  candidates = dedupe(candidates).slice(0, MAX_CANDIDATES);
  const max = opts.max ?? 8;
  const rank = opts.rank ?? true;

  if (!rank) {
    return { cover: candidates[0] ?? null, images: candidates.slice(0, max) };
  }

  const ranked = await rankByVision(candidates.slice(0, VISION_MAX));
  // Vision winners first; append any un-scored heuristic candidates so we still return a full set.
  const merged = dedupe([...ranked, ...candidates]).slice(0, max);
  logger.debug({ domain: clean, considered: candidates.length, kept: merged.length }, "Brand images ranked");
  return { cover: merged[0] ?? null, images: merged };
}

/**
 * fetchBrandImagesViaSearch — brand imagery for the sites we cannot read ourselves.
 *
 * The brands still missing a cover are the LARGE ones, and they are missing for a reason
 * that no better domain guess can fix: gatorade.com, asics.com, shein.com, fanatics.com
 * and macys.com all return 403 to our scraper (Akamai/Cloudflare), and lululemon.com
 * returns 400. There is no homepage HTML to parse, so there are no candidates to rank.
 *
 * Web search sees what we cannot, so it supplies the PAGES instead: ONE OpenAI web search
 * (skill brand/cover-search, services/brandCoverSearchModel.ts; all web search goes through
 * OpenAI) lists public pages that show the brand's products or campaigns (press, lookbooks,
 * retailers), we read each page's images the same way as a homepage, and the SAME Gemini
 * vision rank picks the cover, so a searched image is held to exactly the same bar as a
 * scraped one. Every URL is fetched and checked before it can win, which drops the
 * ephemeral crawler links search sometimes returns (Instagram/Facebook `lookaside` URLs
 * expire and would render as a broken card).
 *
 * Needs OPENAI_API_KEY. Never throws: no key, a failed search, or zero usable images all
 * degrade to an empty result and the caller keeps its gradient.
 */
export async function fetchBrandImagesViaSearch(
  brandName: string,
  opts: { max?: number; searchPages?: (brandName: string) => Promise<string[]> } = {},
): Promise<BrandImages> {
  const name = (brandName ?? "").trim();
  if (name.length < 2) return { cover: null, images: [] };
  if (!opts.searchPages && !process.env.OPENAI_API_KEY?.trim()) return { cover: null, images: [] };

  try {
    const search = opts.searchPages ?? (await import("../services/brandCoverSearchModel.js")).searchBrandCoverPages;
    const pages = (await search(name)).filter((u) => /^https:\/\//i.test(u)).slice(0, SEARCH_PAGES_MAX);
    const raw: string[] = [];
    for (const page of pages) {
      raw.push(...(await collectFromPage(page)));
      if (raw.length >= MAX_CANDIDATES) break;
    }

    // Drop hosts whose URLs are short-lived crawler artefacts rather than real assets.
    const usable = dedupe(raw).filter((u) => !/lookaside\.(fbsbx|instagram)\.com/i.test(u));
    if (!usable.length) return { cover: null, images: [] };

    // Only keep what actually loads as an image right now.
    const live: string[] = [];
    for (const u of usable.slice(0, VISION_MAX)) {
      const got = await fetchImageBytes(u);
      if (got) live.push(u);
    }
    if (!live.length) return { cover: null, images: [] };

    const ranked = await rankByVision(live);
    const merged = dedupe([...ranked, ...live]).slice(0, opts.max ?? 8);
    logger.debug({ brand: name, pages: pages.length, found: raw.length, live: live.length }, "Brand images via search");
    return { cover: merged[0] ?? null, images: merged };
  } catch {
    return { cover: null, images: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Homepage fetch + candidate collection
// ─────────────────────────────────────────────────────────────────────────────

function cleanDomain(domain: string | undefined): string | null {
  const clean = domain?.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return clean || null;
}

async function tryOne(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetchPage(pageUrl, HEAD_HTML_BYTES);
    if (!res) return null;
    const raw = extractImageRef(res.html);
    if (!raw) return null;
    return toAbsolute(raw, res.baseUrl);
  } catch (err: any) {
    logger.debug({ pageUrl, err: err?.message }, "Brand image fetch failed");
    return null;
  }
}

async function collectFromPage(pageUrl: string): Promise<string[]> {
  try {
    const res = await fetchPage(pageUrl, FULL_HTML_BYTES);
    if (!res) return [];
    return collectImageRefs(res.html, res.baseUrl);
  } catch (err: any) {
    logger.debug({ pageUrl, err: err?.message }, "Brand image collect failed");
    return [];
  }
}

async function fetchPage(pageUrl: string, cap: number): Promise<{ html: string; baseUrl: string } | null> {
  // safeFetch: https only, never an internal address, every redirect hop re-checked (PR 4 C4).
  const res = await safeFetch(pageUrl, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
  });
  if (!res.ok) return null;
  const html = (await res.text()).slice(0, cap);
  return { html, baseUrl: res.url || pageUrl };
}

// A share/social/banner/logo/icon image is a poor brand-card cover — push it to the back.
const BANNER_RE = /share|social|og[-_]?image|banner|hero[-_]?banner|logo|favicon|sprite|placeholder|1x1|pixel/i;

/** Single best ref for the cheap path: og:image wins, icon links fall back. */
function extractImageRef(html: string): string | null {
  let root;
  try { root = parse(html); } catch { return null; }

  const metaProps = ["og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src"];
  for (const prop of metaProps) {
    for (const el of root.querySelectorAll("meta")) {
      const key = el.getAttribute("property") || el.getAttribute("name");
      if (key?.toLowerCase() === prop) {
        const content = el.getAttribute("content")?.trim();
        if (content) return content;
      }
    }
  }

  let best: { href: string; size: number } | null = null;
  for (const el of root.querySelectorAll("link")) {
    const rel = (el.getAttribute("rel") || "").toLowerCase();
    if (!/(apple-touch-icon|(^|\s)icon(\s|$)|shortcut icon)/.test(rel)) continue;
    const href = el.getAttribute("href")?.trim();
    if (!href) continue;
    const size = parseSizeAttr(el.getAttribute("sizes"));
    const effective = size || (rel.includes("apple-touch-icon") ? 180 : 32);
    if (!best || effective > best.size) best = { href, size: effective };
  }
  return best?.href ?? null;
}

/**
 * Collect many candidate images from the homepage: real product/lifestyle `<img>`s first
 * (best covers), then the og:image/banner last. Absolute URLs, deduped, banners deprioritized.
 */
function collectImageRefs(html: string, baseUrl: string): string[] {
  let root;
  try { root = parse(html); } catch { return []; }

  const content: string[] = [];
  const banners: string[] = [];

  // Content <img> — the real product/lifestyle shots.
  for (const el of root.querySelectorAll("img")) {
    const src = el.getAttribute("src")?.trim();
    if (src && /\.(jpe?g|png|webp)(\?|#|$)/i.test(src)) push(src);
    // srcset: take the largest declared candidate (last entry).
    const srcset = el.getAttribute("srcset")?.trim();
    if (srcset) {
      const last = srcset.split(",").pop()?.trim().split(/\s+/)[0];
      if (last) push(last);
    }
  }

  // og:image / twitter:image — treated as a banner (deprioritized, but a real fallback).
  for (const el of root.querySelectorAll("meta")) {
    const key = (el.getAttribute("property") || el.getAttribute("name") || "").toLowerCase();
    if (key === "og:image" || key === "og:image:secure_url" || key === "twitter:image") {
      const content2 = el.getAttribute("content")?.trim();
      if (content2) pushInto(banners, content2);
    }
  }

  function push(ref: string) {
    (BANNER_RE.test(ref) ? banners : content).push(ref);
  }
  function pushInto(arr: string[], ref: string) {
    arr.push(ref);
  }

  const abs = (refs: string[]) =>
    refs.map((r) => toAbsolute(r, baseUrl)).filter((u): u is string => !!u);

  // Product/lifestyle first, banners/og last.
  return [...abs(content), ...abs(banners)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Vision ranking (Gemini) — pick the images that best REPRESENT the brand
// ─────────────────────────────────────────────────────────────────────────────

const VISION_PROMPT = `You are curating the HERO image for a brand's card in a premium app. Assess THIS image for that use. A great brand image is a real product or lifestyle photo that communicates what the brand sells and its aesthetic. A poor one is a bare logo, a text/promo banner, a screenshot, a UI element, a payment/social-icon strip, or a low-quality/tiny graphic. Respond with STRICT JSON only, no prose:
{"is_brand_photo":true|false,"has_heavy_text":true|false,"representativeness":0.0-1.0,"quality":0.0-1.0,"reason":"one short sentence"}`;

interface BrandImageTags {
  is_brand_photo: boolean;
  has_heavy_text: boolean;
  representativeness: number;
  quality: number;
  reason: string;
}

/** Rank candidate URLs best-first via vision; falls back to the input order on any failure. */
async function rankByVision(urls: string[]): Promise<string[]> {
  const scored = await mapLimit(urls, VISION_CONCURRENCY, async (url, i) => {
    const img = await fetchImageBytes(url);
    if (!img) return { url, score: -1, order: i };
    const tags = await scoreBrandImage(img.buf, img.mime);
    return { url, score: tags ? brandImageScore(tags) : -1, order: i };
  });

  const usable = scored.filter((s) => s.score >= 0);
  if (!usable.length) return urls; // vision unavailable → keep heuristic order
  // Higher score first; stable tiebreak on original (product-first) order.
  usable.sort((a, b) => b.score - a.score || a.order - b.order);
  return usable.map((s) => s.url);
}

function brandImageScore(t: BrandImageTags): number {
  if (!t.is_brand_photo) return 0.02;
  const base = 0.6 * clamp01(t.representativeness) + 0.4 * clamp01(t.quality);
  return t.has_heavy_text ? base * 0.5 : base;
}

async function scoreBrandImage(buf: Buffer, mime: string): Promise<BrandImageTags | null> {
  try {
    const res = await genai().models.generateContent({
      model: GEMINI.flash,
      contents: [{ role: "user", parts: [
        { inlineData: { mimeType: mime, data: buf.toString("base64") } },
        { text: VISION_PROMPT },
      ] }],
      config: { responseMimeType: "application/json", temperature: 0.2 },
    });
    const txt = (res.text ?? "").trim();
    return JSON.parse(txt) as BrandImageTags;
  } catch {
    return null; // best-effort: a scoring failure just drops the image from the ranked set
  }
}

async function fetchImageBytes(url: string): Promise<{ buf: Buffer; mime: string } | null> {
  try {
    // The page chose this URL — safeFetch, as the page itself was (PR 4 C4).
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!/^image\/(jpe?g|png|webp)$/i.test(mime)) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength < 3_000 || ab.byteLength > MAX_IMAGE_BYTES) return null; // skip tiny icons / huge files
    return { buf: Buffer.from(ab), mime };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseSizeAttr(sizes: string | undefined): number {
  if (!sizes) return 0;
  let max = 0;
  for (const tok of sizes.split(/\s+/)) {
    const m = /^(\d+)x(\d+)$/i.exec(tok.trim());
    if (m) max = Math.max(max, parseInt(m[1], 10), parseInt(m[2], 10));
  }
  return max;
}

function toAbsolute(ref: string, baseUrl: string): string | null {
  try {
    return new URL(ref, baseUrl).toString();
  } catch {
    return null;
  }
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
