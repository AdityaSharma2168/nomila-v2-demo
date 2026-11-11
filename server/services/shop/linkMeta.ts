/**
 * shop/linkMeta.ts — read the public preview of a link she gave us (docs/design/shop-her-picks.md §4).
 *
 * Her link is stored EXACTLY as she gave it; this module only reads what the page says about itself so the pick has a
 * title, a picture and a price. It never rewrites, tags or "converts" the link: Nomila holds no affiliate account.
 *
 * What it fetches, and nothing else:
 *   1. a Shopify store's PUBLIC product JSON (https://<host>/products/<handle>.json — no auth), when the path is a
 *      /products/<handle> page. A valid product payload is the fingerprint → source "shopify";
 *   2. otherwise the page itself, for its Open Graph tags (og:title / <title>, og:image, og:site_name, price);
 *   3. robots.txt for the host, once an hour, and ONLY what it allows is fetched (RFC 9309).
 *
 * Bounds: safeFetch (https only — an http: link is read over https; private / link-local / metadata / loopback refused
 * at every redirect hop; DNS pinned), a 6 s budget per request, bodies capped (HTML 512 KB, JSON 1 MB, robots 64 KB).
 * A link that can't be read is not an error: the pick is still made and she types the title herself.
 *
 * Network detection is DISPLAY ONLY: Amazon (her `tag`), LTK, ShopMy, Shopify, anything else "link".
 * Nothing read here is an instruction to anyone: every string is one-lined and clipped, and Mila only ever sees it
 * inside <external_content>.
 */
import { safeFetch, UnsafeUrlError } from "../../lib/safeFetch";
import { createLogger } from "../../logger";
import { LIMITS, type ShopSource } from "./config";

const logger = createLogger("services/shop/link-meta");

export const FETCH_TIMEOUT_MS = 6_000;
export const MAX_HTML_BYTES = 512 * 1024;
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_ROBOTS_BYTES = 64 * 1024;
const USER_AGENT = "Mozilla/5.0 (compatible; NomilaLinkPreview/1.0; +https://nomila.app)";
/** The token our robots.txt group is matched by (besides "*"). */
const ROBOTS_TOKEN = "nomilalinkpreview";

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
const defaultFetcher: Fetcher = (url, init) => safeFetch(url, init);

// ─── Her link: accepted or refused ─────────────────────────────────────────────────────────────────────────────

export type LinkCheck = { ok: true; url: string; parsed: URL; host: string } | { ok: false; error: string };

/** Accept http/https only, ≤ 2048 chars, a real host, no credentials. The string she gave is kept as-is (trimmed). */
export function checkLink(raw: unknown): LinkCheck {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "paste a link" };
  const url = raw.trim();
  if (url.length > LIMITS.url) return { ok: false, error: "that link is too long" };
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, error: "that doesn't look like a link" }; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, error: "only http and https links can be added" };
  if (parsed.username || parsed.password) return { ok: false, error: "a link with a password in it can't be added" };
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || /\s/.test(url)) return { ok: false, error: "that doesn't look like a link" };
  return { ok: true, url, parsed, host };
}

// ─── Networks (display only) ───────────────────────────────────────────────────────────────────────────────────

const AMAZON_HOST = /(^|\.)amazon\.(com|ca|com\.mx|com\.br|co\.uk|de|fr|it|es|nl|se|pl|com\.be|ie|co\.jp|in|com\.au|sg|ae|sa|com\.tr|eg)$/;
const AMAZON_SHORT = new Set(["amzn.to", "amzn.com", "a.co", "amzn.eu", "amzn.asia"]);
const LTK_HOSTS = ["liketk.it", "shopltk.com", "ltk.app", "rstyle.me"];
const SHOPMY_HOSTS = ["shopmy.us", "shop-links.co"];
const endsWithHost = (host: string, base: string) => host === base || host.endsWith(`.${base}`);

export const isAmazonHost = (host: string): boolean => AMAZON_HOST.test(host) || AMAZON_SHORT.has(host);

/** Which network a link belongs to, by host (Shopify is detected by its product JSON, not here). */
export function networkOf(host: string): Exclude<ShopSource, "shopify"> {
  if (isAmazonHost(host)) return "amazon";
  if (LTK_HOSTS.some((h) => endsWithHost(host, h))) return "ltk";
  if (SHOPMY_HOSTS.some((h) => endsWithHost(host, h))) return "shopmy";
  return "link";
}

/** Her Amazon Associates tag from a link, when it carries one. Display only. */
export function amazonTag(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const t = new URL(url).searchParams.get("tag");
    return t && /^[A-Za-z0-9_-]{2,64}$/.test(t) ? t : null;
  } catch { return null; }
}

// ─── Shopify ───────────────────────────────────────────────────────────────────────────────────────────────────

const SHOPIFY_PRODUCT_PATH = /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?\/products\/([^/?#]+?)\/?$/i;

/** The public product-JSON URL for a /products/<handle> page, or null when the path is not one. */
export function shopifyJsonUrl(parsed: URL): string | null {
  const m = SHOPIFY_PRODUCT_PATH.exec(parsed.pathname);
  if (!m) return null;
  const handle = m[1].replace(/\.(json|js|xml|atom)$/i, "");
  if (!/^[\w%.-]{1,255}$/.test(handle)) return null;
  return `https://${parsed.host}/products/${handle}.json`;
}

// ─── Small helpers ─────────────────────────────────────────────────────────────────────────────────────────────

// C0 controls, DEL, zero-width marks and the two Unicode line/paragraph separators (built from code points so the
// source holds no invisible characters).
const CONTROL_CHARS = new RegExp("[" + ["\u0000-\u001F", "\u007F", "\u200B-\u200F", "\u2028", "\u2029"].join("") + "]+", "g");

/** One line, no control characters, clipped. */
export function oneLine(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** An absolute https image URL, or null. */
export function httpsImage(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const s = u.toString();
    return s.length <= LIMITS.url ? s : null;
  } catch { return null; }
}

/** "29.00" / 29 → 2900; anything odd → null. */
export function priceToCents(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "").trim()) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return null;
  return Math.round(n * 100);
}

const currencyOf = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : null);

/** Read at most `max` bytes of a body, then stop reading (the rest is never downloaded into memory). */
export async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = max - total;
      chunks.push(room < value.byteLength ? value.subarray(0, room) : value);
      total += Math.min(room, value.byteLength);
      if (total >= max) { await reader.cancel().catch(() => {}); break; }
    }
  } finally { reader.releaseLock?.(); }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export async function fetchBounded(url: string, fetcher: Fetcher, accept: string): Promise<Response | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetcher(url, { signal: ac.signal, headers: { "user-agent": USER_AGENT, accept } });
  } catch (err) {
    if (!(err instanceof UnsafeUrlError)) logger.info({ host: safeHost(url), error: (err as Error)?.message?.slice(0, 120) }, "link read failed");
    return null;
  } finally { clearTimeout(timer); }
}
const safeHost = (u: string) => { try { return new URL(u).host; } catch { return "?"; } };

// ─── robots.txt (RFC 9309) ─────────────────────────────────────────────────────────────────────────────────────

interface RobotsRule { allow: boolean; pattern: string }
type Robots = { kind: "rules"; rules: RobotsRule[] } | { kind: "allow_all" } | { kind: "disallow_all" };

/** The rules that apply to us: our own token's group(s) if any, else the "*" group(s). */
export function parseRobots(text: string): RobotsRule[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const ours = groups.filter((g) => g.agents.some((a) => a !== "*" && ROBOTS_TOKEN.includes(a.replace(/\/.*$/, ""))));
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

/** Longest match wins; on a tie, allow wins; nothing matches → allowed. */
export function robotsAllows(rules: RobotsRule[], pathAndQuery: string): boolean {
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!patternMatches(r.pattern, pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
  }
  return best ? best.allow : true;
}

const ROBOTS_TTL_MS = 60 * 60 * 1000;
const robotsCache = new Map<string, { at: number; robots: Robots }>();
export const _clearRobotsCache = () => robotsCache.clear();

async function robotsFor(origin: string, fetcher: Fetcher, now: number): Promise<Robots> {
  const hit = robotsCache.get(origin);
  if (hit && now - hit.at < ROBOTS_TTL_MS) return hit.robots;
  const res = await fetchBounded(`${origin}/robots.txt`, fetcher, "text/plain");
  let robots: Robots;
  if (!res) robots = { kind: "disallow_all" };                                   // unreachable → assume disallowed (RFC 9309 §2.3.1.4)
  else if (res.status >= 500) { robots = { kind: "disallow_all" }; await res.body?.cancel().catch(() => {}); }
  else if (res.status >= 400) { robots = { kind: "allow_all" }; await res.body?.cancel().catch(() => {}); }   // 4xx → allowed (§2.3.1.3)
  else robots = { kind: "rules", rules: parseRobots(await readCapped(res, MAX_ROBOTS_BYTES)) };
  if (robotsCache.size > 500) robotsCache.clear();
  robotsCache.set(origin, { at: now, robots });
  return robots;
}

export async function mayFetch(url: string, fetcher: Fetcher, now: number): Promise<boolean> {
  const u = new URL(url);
  const robots = await robotsFor(u.origin, fetcher, now);
  if (robots.kind === "allow_all") return true;
  if (robots.kind === "disallow_all") return false;
  return robotsAllows(robots.rules, `${u.pathname}${u.search}`);
}

// ─── Open Graph ────────────────────────────────────────────────────────────────────────────────────────────────

/** The meta tags of a page as { property-or-name → content } (first wins), plus the <title>. */
export function parseMeta(html: string): { meta: Map<string, string>; title: string | null } {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs.set(m[1].toLowerCase(), m[3] ?? m[4] ?? m[5] ?? "");
    const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, decodeEntities(content));
  }
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return { meta, title: t ? decodeEntities(t[1]) : null };
}

// ─── The read ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface LinkRead {
  /** Her link, exactly as given (trimmed). */
  url: string;
  host: string;
  source: ShopSource;
  /** Her Amazon tag, when the link (or where it lands) carries one. */
  networkTag: string | null;
  title: string | null;
  imageUrl: string | null;
  priceCents: number | null;
  currency: string | null;
  merchant: string | null;
  /** What happened, for the screen: "read" | "robots" | "unreadable"; plus "amazon_no_tag". */
  notes: string[];
}

export interface ReadDeps { fetcher?: Fetcher; now?: number }

/** Read the public preview of her link. Never throws for a page problem; `notes` says what happened. */
export async function readLink(link: { url: string; parsed: URL; host: string }, deps: ReadDeps = {}): Promise<LinkRead> {
  const fetcher = deps.fetcher ?? defaultFetcher;
  const now = deps.now ?? Date.now();
  const out: LinkRead = { url: link.url, host: link.host, source: networkOf(link.host), networkTag: null, title: null, imageUrl: null, priceCents: null, currency: null, merchant: null, notes: [] };
  // Read over https always; the stored link keeps whatever scheme she gave.
  const https = new URL(link.url); https.protocol = "https:";
  let finalUrl = https.toString();

  // 1. Shopify product JSON
  const jsonUrl = out.source === "link" ? shopifyJsonUrl(https) : null;
  let read = false;
  let blocked = false;
  if (jsonUrl) {
    if (await mayFetch(jsonUrl, fetcher, now)) {
      const res = await fetchBounded(jsonUrl, fetcher, "application/json");
      if (res && res.ok && /json/i.test(res.headers.get("content-type") ?? "")) {
        try {
          const p = JSON.parse(await readCapped(res, MAX_JSON_BYTES))?.product;
          if (p && typeof p.title === "string" && Array.isArray(p.variants)) {
            const v = p.variants[0] ?? {};
            const presentment = Array.isArray(v.presentment_prices) ? v.presentment_prices[0]?.price : null;
            out.source = "shopify";
            out.title = oneLine(p.title, LIMITS.title);
            out.merchant = oneLine(p.vendor, LIMITS.merchant);
            out.imageUrl = httpsImage(p.image?.src ?? p.images?.[0]?.src ?? null, jsonUrl);
            out.priceCents = priceToCents(presentment?.amount ?? v.price);
            out.currency = currencyOf(presentment?.currency_code ?? v.price_currency);
            read = true;
          }
        } catch { /* not a product payload: fall through to the page */ }
      } else await res?.body?.cancel().catch(() => {});
    } else blocked = true;
  }

  // 2. Open Graph on the page itself
  if (!read) {
    if (await mayFetch(finalUrl, fetcher, now)) {
      const res = await fetchBounded(finalUrl, fetcher, "text/html,application/xhtml+xml");
      if (res) {
        finalUrl = res.url || finalUrl;
        if (res.ok && /html/i.test(res.headers.get("content-type") ?? "text/html")) {
          const { meta, title } = parseMeta(await readCapped(res, MAX_HTML_BYTES));
          out.title = oneLine(meta.get("og:title") ?? meta.get("twitter:title") ?? title, LIMITS.title);
          out.imageUrl = httpsImage(meta.get("og:image:secure_url") ?? meta.get("og:image") ?? meta.get("twitter:image") ?? null, finalUrl);
          out.merchant = oneLine(meta.get("og:site_name"), LIMITS.merchant);
          out.priceCents = priceToCents(meta.get("product:price:amount") ?? meta.get("og:price:amount") ?? meta.get("price"));
          out.currency = currencyOf(meta.get("product:price:currency") ?? meta.get("og:price:currency") ?? meta.get("pricecurrency"));
          read = !!(out.title || out.imageUrl);
        } else await res.body?.cancel().catch(() => {});
      }
    } else blocked = true;
  }

  // A short link (amzn.to) says which store it is only where it lands.
  if (out.source === "link") {
    try { const landed = new URL(finalUrl).hostname.toLowerCase(); if (networkOf(landed) !== "link") out.source = networkOf(landed); } catch { /* keep */ }
  }
  if (out.source === "amazon") {
    out.networkTag = amazonTag(link.url) ?? amazonTag(finalUrl);
    if (!out.networkTag) out.notes.push("amazon_no_tag");
  }
  out.notes.push(read ? "read" : blocked ? "robots" : "unreadable");
  return out;
}
