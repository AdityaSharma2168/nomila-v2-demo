// Brand logos everywhere — one place that resolves a brand's (or a platform's) logo image.
// Prefer the stored logo_url; fall back to a logo derived from the domain BEFORE any
// monogram/initials. Every brand avatar/row should route through this (components/ui/LogoMark)
// so the rule holds app-wide (see the "brand-logos-everywhere" note).
//
// The fallback WAS logo.clearbit.com, which HubSpot shut down — the host no longer
// resolves, so those URLs are dead images. Google's favicon service is the replacement:
// free, no key, and it answers even for sites that block our own scraper. A stored
// clearbit URL is treated as absent for the same reason, since many rows still carry one.
// Nothing here guesses a domain from a brand's name: no domain ⇒ null ⇒ the caller's initials.

const DEAD_LOGO_HOST = /(^|\/\/)logo\.clearbit\.com\//i;

export function brandLogoUri(logo?: string | null, domain?: string | null): string | null {
  if (logo && logo.trim() && !DEAD_LOGO_HOST.test(logo)) return logo;
  const d = domain?.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (d) return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128`;
  return null;
}

/**
 * Every source to try for a mark, in order, for a view that can step down when an image fails to load (ui/LogoMark):
 *
 *   1. the stored logo — a Yoku logo asked for in its `fallback/404` form, so a brand Yoku does not (or no longer)
 *      cover(s) FAILS instead of answering with Yoku's invented lettermark (a letter tile indistinguishable from our own
 *      initials, and not her brand's logo);
 *   2. Google's favicon for the brand's domain — the given domain, else the one the stored logo's URL names;
 *   3. (the caller's initials when the list runs out).
 *
 * Without step 2 a stored Yoku logo that failed on the device went straight to initials, although the favicon for the
 * same domain was a tap away — that is how a confirmed brand ended up as a letter on the Opportunities board.
 */
export function brandLogoChain(logo?: string | null, domain?: string | null): string[] {
  const kept = logo && logo.trim() && !DEAD_LOGO_HOST.test(logo) ? logo.trim() : null;
  const stored = kept && YOKU_HOST.test(kept) ? kept.replace(YOKU_LETTERMARK, "/fallback/404") : kept;
  const site = domain?.trim() || domainFromLogoUrl(logo);
  const favicon = brandLogoUri(null, site);
  return [stored, favicon].filter((u, i, all): u is string => !!u && all.indexOf(u) === i);
}

const YOKU_HOST = /(^|\/\/)cdn\.yoku\.app\//i;
const YOKU_LETTERMARK = /\/fallback\/lettermark(?=$|[?#])/i;

/**
 * The brand's domain, recovered from a stored logo URL of any source Nomila has minted: Yoku
 * (`cdn.yoku.app/<domain>/…`), Google's favicon service (`…/s2/favicons?domain=<domain>`) or the old
 * Clearbit form (`logo.clearbit.com/<domain>`). Anything else ⇒ null. Older screens read the domain this
 * way; they used to parse Clearbit only, so a row upgraded to Yoku or minted as a favicon lost its logo.
 */
export function domainFromLogoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/cdn\.yoku\.app\/([^/?#]+)/i)
    ?? url.match(/\/s2\/favicons\?(?:[^#]*&)?domain=([^&#]+)/i)
    ?? url.match(/logo\.clearbit\.com\/([^/?#]+)/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
}

/** The site each connected platform's mark comes from. A platform not listed takes `<platform>.com`. */
const PLATFORM_DOMAIN: Record<string, string> = {
  gmail:     "gmail.com",
  outlook:   "outlook.com",
  instagram: "instagram.com",
  youtube:   "youtube.com",
  tiktok:    "tiktok.com",
  spotify:   "spotify.com",
  x:         "x.com",
  twitter:   "x.com",
};

export function platformDomain(platform: string | null | undefined): string | null {
  const p = platform?.trim().toLowerCase();
  if (!p) return null;
  return PLATFORM_DOMAIN[p] ?? `${p.replace(/[^a-z0-9-]/g, "")}.com`;
}
