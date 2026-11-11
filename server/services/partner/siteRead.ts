/**
 * partner/siteRead.ts — the light read of the homepage a brand typed (design §6 step 2), before any email.
 *
 * ONE request to that homepage through safeFetch (https only, private/metadata/loopback refused at every hop, DNS
 * pinned, at most 5 redirects), robots.txt respected (the shop link reader's RFC 9309 parser and cache), a 6-second
 * budget and a 512 KB body cap. It reads ONLY <title>, the meta description, og:title, og:description, og:site_name and
 * og:image (kept for logo matching later, never shown). No crawling, no other page, no search, no research provider.
 *
 * Cached per registrable domain for 7 days (brand_site_previews), so a second visitor from the same brand costs nothing.
 * Every string is one-lined and clipped; nothing read here is an instruction to anyone (the fit model sees it only inside
 * <external_content>).
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { brandSitePreviews } from "../../../shared/schema";
import { safeFetch } from "../../lib/safeFetch";
import { brandDomainFromInput } from "../../lib/brandIdentity";
import { fetchBounded, mayFetch, oneLine, parseMeta, readCapped, httpsImage, MAX_HTML_BYTES, type Fetcher } from "../shop/linkMeta";
import { PARTNER } from "./config";

export interface SiteMeta {
  title: string | null;
  description: string | null;
  siteName: string | null;
  /** Kept for logo matching after confirmation; never shown to anyone. */
  image: string | null;
}

export interface SiteRead {
  domain: string;
  readable: boolean;
  meta: SiteMeta | null;
  cached: boolean;
}

const defaultFetcher: Fetcher = (url, init) => safeFetch(url, init);

/** The brand's registrable domain from what they typed ("www.Brand.com/about" → "brand.com"), or null. */
export function websiteDomain(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  return brandDomainFromInput(raw);
}

/** Read (or reuse) the homepage of `domain`. Never throws for a page problem: an unreadable site is `readable: false`. */
export async function readBrandSite(domain: string, deps: { fetcher?: Fetcher; now?: Date } = {}): Promise<SiteRead> {
  const now = deps.now ?? new Date();
  const [hit] = await db.select().from(brandSitePreviews).where(eq(brandSitePreviews.domain, domain)).limit(1);
  if (hit && now.getTime() - new Date(hit.fetched_at).getTime() < PARTNER.cacheTtlMs) {
    return { domain, readable: hit.readable, meta: (hit.site_meta as SiteMeta | null) ?? null, cached: true };
  }

  const fetcher = deps.fetcher ?? defaultFetcher;
  const home = `https://${domain}/`;
  let meta: SiteMeta | null = null;
  if (await mayFetch(home, fetcher, now.getTime())) {
    const res = await fetchBounded(home, fetcher, "text/html,application/xhtml+xml");
    if (res && res.ok && /html/i.test(res.headers.get("content-type") ?? "text/html")) {
      const { meta: m, title } = parseMeta(await readCapped(res, MAX_HTML_BYTES));
      const read: SiteMeta = {
        title:       oneLine(m.get("og:title") ?? title, 160),
        description: oneLine(m.get("og:description") ?? m.get("description"), 400),
        siteName:    oneLine(m.get("og:site_name"), 120),
        image:       httpsImage(m.get("og:image:secure_url") ?? m.get("og:image") ?? null, res.url || home),
      };
      if (read.title || read.description || read.siteName) meta = read;
    } else await res?.body?.cancel().catch(() => {});
  }

  const readable = meta != null;
  await db.insert(brandSitePreviews).values({ domain, readable, site_meta: meta, fetched_at: now })
    .onConflictDoUpdate({ target: brandSitePreviews.domain, set: { readable, site_meta: meta, fetched_at: now } });
  return { domain, readable, meta, cached: false };
}
