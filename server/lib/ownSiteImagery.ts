/**
 * ownSiteImagery.ts — a brand's pictures, taken ONLY from the brand's own domain (Oct 2026, owner-approved).
 *
 * Called only for a domain Nomila already trusts as the brand's (research confirmed it under BRAND_IDENTITY_GATE,
 * or an athlete confirmed it), so what comes back is the right company's by construction:
 *
 *   logo   the pipeline every brand uses (lib/brandLogoSources): Yoku's real logo when Yoku verifies it carries
 *          that domain, else Google's favicon for it.
 *   cover  the homepage's og:image / twitter:image, kept only when
 *            - the page was fetched over https from the domain itself (www. or bare), every redirect hop staying
 *              on the same registrable domain (safeFetch allowHop; a hop elsewhere refuses the fetch),
 *            - the image URL itself is on that domain (a CDN on another domain is not taken),
 *            - the image answers 200 as jpeg/png/webp/gif within the size bounds, again without leaving the domain.
 *
 * Never throws: any failure is "nothing found". safeFetch keeps its SSRF guarantees (https only, no internal
 * address, every hop re-checked and pinned). No model call.
 */
import { parse } from "node-html-parser";
import { safeFetch, type Resolver } from "./safeFetch";
import { brandDomainFromInput, onDomain } from "./brandIdentity";
import { googleFaviconUrl, yokuLogoUrl } from "./brandLogoSources";
import { createLogger } from "../logger";

const logger = createLogger("lib/ownSiteImagery");

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const OWN_SITE_TIMEOUT_MS = 10_000;
const HEAD_HTML_BYTES = 512 * 1024;
export const COVER_MIN_BYTES = 8 * 1024;          // smaller is an icon or a tracking pixel, not a cover
export const COVER_MAX_BYTES = 8 * 1024 * 1024;
const COVER_MIN_DECLARED_PX = 200;                // og:image:width / height, when the page declares them
const IMAGE_MIME = /^image\/(jpe?g|png|webp|gif)$/i;

export interface OwnSiteResult {
  domain: string;
  cover: string | null;
  logoUrl: string;
  logoSource: "yoku" | "favicon";
  /** Why no cover, when none — for logs and the catch-up report. */
  coverMiss: string | null;
}

export interface OwnSiteDeps {
  /** Passed to safeFetch (tests inject a resolver and a fetch; production resolves and pins). */
  resolve?: Resolver;
  fetchImpl?: typeof fetch;
  /** Does Yoku carry a real logo for this domain? Defaults to the verify-form request. */
  hasYokuLogo?: (domain: string) => Promise<boolean>;
}

async function defaultHasYokuLogo(domain: string): Promise<boolean> {
  try {
    const res = await fetch(yokuLogoUrl(domain, { verify: true }), { redirect: "follow", signal: AbortSignal.timeout(OWN_SITE_TIMEOUT_MS) });
    return res.ok && (res.headers.get("content-type") ?? "").startsWith("image");
  } catch {
    return false;
  }
}

/** PURE. The og:image / twitter:image refs a page declares, absolute, plus any declared size. */
export function metaImageRefs(html: string, baseUrl: string): { url: string; width: number | null; height: number | null }[] {
  let root;
  try { root = parse(html); } catch { return []; }
  const metas = root.querySelectorAll("meta").map((el) => ({
    key: (el.getAttribute("property") || el.getAttribute("name") || "").toLowerCase().trim(),
    content: (el.getAttribute("content") || "").trim(),
  }));
  const num = (k: string): number | null => {
    const v = Number(metas.find((m) => m.key === k)?.content);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const width = num("og:image:width"), height = num("og:image:height");
  const out: { url: string; width: number | null; height: number | null }[] = [];
  for (const key of ["og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src"]) {
    for (const m of metas) {
      if (m.key !== key || !m.content) continue;
      try {
        const url = new URL(m.content, baseUrl).toString();
        if (!out.some((o) => o.url === url)) out.push({ url, width: key.startsWith("og:") ? width : null, height: key.startsWith("og:") ? height : null });
      } catch { /* not a URL */ }
    }
  }
  return out;
}

/** PURE. The first ref that is https, on the brand's own domain, and not declared too small. */
export function pickOwnSiteCover(refs: ReturnType<typeof metaImageRefs>, domain: string): string | null {
  for (const r of refs) {
    let u: URL;
    try { u = new URL(r.url); } catch { continue; }
    if (u.protocol !== "https:" || !onDomain(u.hostname, domain)) continue;
    if ((r.width && r.width < COVER_MIN_DECLARED_PX) || (r.height && r.height < COVER_MIN_DECLARED_PX)) continue;
    return u.toString();
  }
  return null;
}

/** The image answers as a real picture of sane size, without leaving the domain. */
async function imageOk(url: string, domain: string, deps: OwnSiteDeps): Promise<string | null> {
  try {
    const res = await safeFetch(url, { signal: AbortSignal.timeout(OWN_SITE_TIMEOUT_MS), headers: { "User-Agent": USER_AGENT } },
      { resolve: deps.resolve, fetchImpl: deps.fetchImpl, allowHop: (u) => onDomain(u.hostname, domain) });
    if (!res.ok) return `image ${res.status}`;
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!IMAGE_MIME.test(mime)) return `image type ${mime || "?"}`;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > COVER_MAX_BYTES) { await res.body?.cancel().catch(() => {}); return "image too large"; }
    const bytes = (await res.arrayBuffer()).byteLength;
    if (bytes < COVER_MIN_BYTES) return "image too small";
    if (bytes > COVER_MAX_BYTES) return "image too large";
    return null;
  } catch (err: any) {
    return err?.reason ? `image refused: ${err.reason}` : "image unreachable";
  }
}

export async function fetchOwnSiteImagery(rawDomain: string, deps: OwnSiteDeps = {}): Promise<OwnSiteResult | null> {
  const domain = brandDomainFromInput(rawDomain);
  if (!domain) return null;
  const yoku = await (deps.hasYokuLogo ?? defaultHasYokuLogo)(domain).catch(() => false);
  const out: OwnSiteResult = {
    domain, cover: null, coverMiss: null,
    logoUrl: yoku ? yokuLogoUrl(domain) : googleFaviconUrl(domain), logoSource: yoku ? "yoku" : "favicon",
  };
  const misses: string[] = [];
  for (const page of [`https://www.${domain}/`, `https://${domain}/`]) {
    try {
      const res = await safeFetch(page, { signal: AbortSignal.timeout(OWN_SITE_TIMEOUT_MS), headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" } },
        { resolve: deps.resolve, fetchImpl: deps.fetchImpl, allowHop: (u) => onDomain(u.hostname, domain) });
      if (!res.ok) { misses.push(`page ${res.status}`); continue; }
      const html = (await res.text()).slice(0, HEAD_HTML_BYTES);
      const refs = metaImageRefs(html, res.url || page);
      if (!refs.length) { misses.push("no og:image"); continue; }
      const cover = pickOwnSiteCover(refs, domain);
      if (!cover) { misses.push("og:image not on the domain"); continue; }
      const bad = await imageOk(cover, domain, deps);
      if (bad) { misses.push(bad); continue; }
      out.cover = cover;
      break;
    } catch (err: any) {
      misses.push(err?.reason ? `page refused: ${err.reason}` : "page unreachable");
    }
  }
  if (!out.cover) out.coverMiss = [...new Set(misses)].join("; ") || "nothing found";
  logger.info({ domain, cover: !!out.cover, logo: out.logoSource, miss: out.coverMiss }, "own-site imagery");
  return out;
}
