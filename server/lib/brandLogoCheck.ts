/**
 * brandLogoCheck — is there a logo for this domain that is good enough to show?
 *
 * A blurry or wrong mark is worse than the brand's initial (phone review, 20 Oct 2026: a 16px favicon upscaled into
 * a card, and a site's default chain-link icon shown as the brand). So, in order:
 *   1. Yoku's full logo, when Yoku verifiably carries the domain — a real logo, trusted as is.
 *   2. The site's own icon through Google's larger favicon service, only when it is a real image at least
 *      MIN_ICON_PX square, not a tiny file, not Google's default globe, not on a shared site-builder host, and the
 *      site's homepage (when readable) names the brand.
 *   2b. When Google only has a tiny or no icon: the site's own declared icons (apple-touch, sized icons, the header
 *       logo), same size bar, only on a homepage that names the brand (23 Oct 2026: Remedy Organics, MUD\WTR).
 *   3. Nothing — the card draws the initial.
 * Never throws: a network failure is "nothing", recorded with its reason.
 */
import { createHash } from "crypto";
import sharp from "sharp";
import { yokuLogoUrl } from "./brandLogoSources";
import { SHARED_PLATFORM, fetchHomeIdentity, homeIdentityFromHtml, labelMatches, siteTextMatches, type HomeIdentity } from "./brandSiteSearch";

export const MIN_ICON_PX = 64;
export const MIN_ICON_BYTES = 500;
/** Placeholder icons served when a site has none (sha1 of the bytes): Google's default globe. */
export const DEFAULT_ICON_SHA1 = new Set(["2d7c9b60d1e2b4f4726141de2e4ab738110b9287"]);

/** Google's newer favicon service: the site's largest icon up to `size`, falling back to a 404 globe. */
export function googleFaviconV2Url(domain: string, size = 256): string {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${encodeURIComponent(d)}&size=${size}`;
}

/** PURE. Pixel size of a PNG, JPEG, GIF or ICO (largest entry); null when unreadable. */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length >= 6 && b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1) {
    let best = 0;
    for (let i = 0, n = b.readUInt16LE(4); i < n && 6 + i * 16 + 1 < b.length; i++) best = Math.max(best, b[6 + i * 16] || 256);
    return best ? { w: best, h: best } : null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xc3) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** PURE. Why an icon is not good enough to show, or null when it is. */
export function iconRejection(icon: { status: number; contentType: string; bytes: Buffer }): string | null {
  if (icon.status !== 200 || !icon.contentType.startsWith("image")) return "no icon";
  if (DEFAULT_ICON_SHA1.has(createHash("sha1").update(icon.bytes).digest("hex"))) return "default icon";
  if (icon.bytes.length < MIN_ICON_BYTES) return "icon too small";
  const size = imageSize(icon.bytes);
  if (!size) return "unreadable icon";
  if (Math.min(size.w, size.h) < MIN_ICON_PX) return `icon ${size.w}px`;
  return null;
}

/** PURE. Does the homepage belong to the brand? Unreadable homepage: the domain's own label must carry the name. */
export function homeBacksBrand(home: HomeIdentity | null, domain: string, name: string | null | undefined): boolean {
  if (!name) return true;
  if (!home || (!home.title && !home.siteName)) return labelMatches(domain, name);
  return siteTextMatches([home.title, home.siteName], name);
}

/**
 * `color`: the logo's own dominant colour, deepened so white type reads on it (Home's hero card draws an offer on its
 * brand's colour); null when the logo has none (black, white, grey) or could not be read: the card falls back to ink.
 */
export interface LogoAssessment { url: string | null; source: "yoku" | "favicon" | "site_icon" | null; reason: string; color?: string | null }

// ─── The logo's colour ────────────────────────────────────────────────────────────────────────────────────────────
//
// No model: the logo is shrunk, transparent and near-white pixels (its ground) are dropped, greys and black type too,
// the rest bucketed, and the most common bucket wins. A logo with no colour (black on white) answers null. The winner is
// deepened to a lightness white type reads on (at most HERO_MAX_LIGHTNESS), keeping its hue.

export const HERO_MAX_LIGHTNESS = 0.36;

type Rgb = [number, number, number];
const hexOf = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function fromHsl([h, s, l]: [number, number, number]): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** PURE. The dominant colour of RGBA pixels (4 bytes a pixel), deepened for white type; null when the mark has none. */
export function logoColorFromPixels(rgba: Uint8Array): string | null {
  const buckets = new Map<number, { n: number; sum: Rgb }>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;                                   // transparent: the ground
    const px: Rgb = [rgba[i], rgba[i + 1], rgba[i + 2]];
    const [, s, l] = toHsl(px);
    if (l > 0.9 || s < 0.25 || l < 0.08) continue;                     // white ground, greys, black type: no colour
    const key = ((px[0] >> 4) << 8) | ((px[1] >> 4) << 4) | (px[2] >> 4);
    const cur = buckets.get(key) ?? { n: 0, sum: [0, 0, 0] as Rgb };
    cur.n++; cur.sum[0] += px[0]; cur.sum[1] += px[1]; cur.sum[2] += px[2];
    buckets.set(key, cur);
  }
  let best: { n: number; sum: Rgb } | null = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  // A few stray coloured pixels (anti-aliasing) are not the brand's colour.
  if (!best || best.n < Math.max(4, (rgba.length / 4) * 0.01)) return null;
  const [h, s, l] = toHsl([best.sum[0] / best.n, best.sum[1] / best.n, best.sum[2] / best.n]);
  return hexOf(fromHsl([h, Math.min(s, 0.85), Math.min(l, HERO_MAX_LIGHTNESS)]));
}

/** The logo's colour from its file (PNG, JPEG, GIF, WebP, SVG); null when unreadable or colourless. Never throws. */
export async function logoColor(bytes: Buffer): Promise<string | null> {
  try {
    const { data } = await sharp(bytes, { density: 72 }).ensureAlpha().resize(64, 64, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
    return logoColorFromPixels(new Uint8Array(data));
  } catch {
    return null;
  }
}

export interface LogoCheckDeps {
  fetchImpl?: typeof fetch;
  home?: (domain: string) => Promise<HomeIdentity | null>;
}

/**
 * PURE. The icons a homepage declares for itself, best first: apple-touch icons and sized `<link rel=icon>`s (largest
 * first), the Windows tile image, then the first header/nav `<img>` whose class, id, alt or src says "logo". Absolute
 * URLs, at most `max`. SVG mask icons are skipped (one-colour masks, not the mark).
 */
export function declaredIconUrls(html: string, pageUrl: string, max = 4): string[] {
  const abs = (href: string | undefined): string | null => {
    if (!href) return null;
    try { const u = new URL(href.replace(/&amp;/g, "&").trim(), pageUrl); return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null; } catch { return null; }
  };
  const attr = (tag: string, name: string): string | undefined => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
  const ranked: Array<{ url: string; score: number }> = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    if (!/\b(apple-touch-icon(-precomposed)?|icon)\b/.test(rel) || /mask-icon/.test(rel)) continue;
    const url = abs(attr(tag, "href"));
    if (!url || /\.svg(\?|$)/i.test(url)) continue;
    const sizes = (attr(tag, "sizes") ?? "").match(/(\d+)x\d+/i);
    const px = sizes ? Number(sizes[1]) : rel.includes("apple-touch") ? 180 : 32;
    ranked.push({ url, score: px });
  }
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (/name\s*=\s*["']msapplication-TileImage["']/i.test(m[0])) { const url = abs(attr(m[0], "content")); if (url) ranked.push({ url, score: 144 }); }
  }
  ranked.sort((a, b) => b.score - a.score);
  const header = /<(header|nav)\b[\s\S]*?<\/\1>/i.exec(html)?.[0] ?? "";
  for (const m of header.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/logo/i.test(`${attr(tag, "class") ?? ""} ${attr(tag, "id") ?? ""} ${attr(tag, "alt") ?? ""} ${attr(tag, "src") ?? ""}`)) continue;
    const url = abs(attr(tag, "src"));
    if (url && !/\.svg(\?|$)/i.test(url)) { ranked.push({ url, score: 0 }); break; }
  }
  const out: string[] = [];
  for (const r of ranked) if (!out.includes(r.url)) out.push(r.url);
  return out.slice(0, max);
}

/** Pixel size via sharp (WebP and anything imageSize can't read), null when unreadable. */
async function sharpSize(bytes: Buffer): Promise<{ w: number; h: number } | null> {
  try { const m = await sharp(bytes).metadata(); return m.width && m.height ? { w: m.width, h: m.height } : null; } catch { return null; }
}

/**
 * When the favicon service only has a tiny icon, the site's own declared icons (apple-touch, sized icons, the header
 * logo) are often large and sharp. Only on a homepage that names the brand; the same size bar as the favicon.
 */
async function siteIcon(domain: string, name: string | null | undefined, f: typeof fetch): Promise<LogoAssessment | null> {
  let html = "", pageUrl = `https://${domain}/`;
  try {
    const res = await f(pageUrl, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "Mozilla/5.0 (compatible; NomilaBot/1.0; +https://nomila.co)", accept: "text/html" } });
    if (!res.ok) return null;
    html = (await res.text()).slice(0, 400_000);
    pageUrl = res.url || pageUrl;
  } catch { return null; }
  if (!homeBacksBrand({ finalDomain: domain, ...homeIdentityFromHtml(html) }, domain, name)) return null;
  for (const url of declaredIconUrls(html, pageUrl)) {
    try {
      const res = await f(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
      const bytes = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type") ?? "";
      if (res.status !== 200 || !ct.startsWith("image") || bytes.length < MIN_ICON_BYTES) continue;
      if (DEFAULT_ICON_SHA1.has(createHash("sha1").update(bytes).digest("hex"))) continue;
      const size = imageSize(bytes) ?? await sharpSize(bytes);
      if (!size || Math.min(size.w, size.h) < MIN_ICON_PX) continue;
      return { url, source: "site_icon", reason: "site icon", color: await logoColor(bytes) };
    } catch { /* next */ }
  }
  return null;
}

/** The logo to show for a domain (see the header), with the reason. Never throws. */
export async function assessLogo(domain: string, name?: string | null, deps: LogoCheckDeps = {}): Promise<LogoAssessment> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(yokuLogoUrl(domain, { verify: true }), { redirect: "follow", signal: AbortSignal.timeout(12_000) });
    if (res.ok && (res.headers.get("content-type") ?? "").startsWith("image")) {
      const color = await res.arrayBuffer().then((b) => logoColor(Buffer.from(b))).catch(() => null);
      return { url: yokuLogoUrl(domain), source: "yoku", reason: "logo", color };
    }
  } catch { /* try the icon */ }
  if (SHARED_PLATFORM.test(domain)) return { url: null, source: null, reason: "site-builder host" };
  try {
    const url = googleFaviconV2Url(domain);
    const res = await f(url, { redirect: "follow", signal: AbortSignal.timeout(12_000) });
    const bytes = Buffer.from(await res.arrayBuffer());
    const why = iconRejection({ status: res.status, contentType: res.headers.get("content-type") ?? "", bytes });
    if (why) {
      // Too small, missing or unreadable at Google's service: try the site's own declared icons before the initial.
      if (why !== "default icon") { const own = await siteIcon(domain, name, f); if (own) return own; }
      return { url: null, source: null, reason: why };
    }
    const home = await (deps.home ?? ((d: string) => fetchHomeIdentity(d, f)))(domain).catch(() => null);
    if (!homeBacksBrand(home, domain, name)) return { url: null, source: null, reason: "site does not name the brand" };
    return { url, source: "favicon", reason: "icon", color: await logoColor(bytes) };
  } catch {
    return { url: null, source: null, reason: "unreachable" };
  }
}

/** What a check leaves on the brand row's enrichment, so display never falls back to a raw favicon it rejected. */
export interface LogoCheck {
  at: string; domain: string; result: "ok" | "none"; source: LogoAssessment["source"]; reason: string;
  /** The logo's own colour, deepened for white type (Home's hero card); absent on checks made before it was read. */
  color?: string | null;
}

export function logoCheckOf(domain: string, a: LogoAssessment, now: Date): LogoCheck {
  return { at: now.toISOString(), domain, result: a.url ? "ok" : "none", source: a.source, reason: a.reason, color: a.url ? a.color ?? null : null };
}

/** PURE. The stored check for this domain, if any. */
export function readLogoCheck(enrichment: unknown, domain: string | null): LogoCheck | null {
  const c = (enrichment as { logo_check?: LogoCheck } | null)?.logo_check;
  return c && domain && c.domain === domain ? c : null;
}
