/**
 * brandLogoSources — where a brand logo image comes from.
 *
 * One place, because this has now moved twice and the call sites should not have to care:
 *
 *   Clearbit  — DEAD. HubSpot shut the free Logo API down; logo.clearbit.com does not
 *               resolve (ENOTFOUND), so every URL minted through it is a broken image.
 *   Yoku CDN  — real logos, no API key. Does not cover every brand, but `fallback/404`
 *               makes it admit that instead of silently returning a lettermark.
 *   Google    — favicon service. Keyless, and it answers for the enterprise sites that
 *               403 our own scraper, because Google already crawled them. Small (a
 *               favicon, 128px) so it is the floor, not the goal.
 *
 * Runtime minting uses the favicon, which always resolves; backfillBrandLogos upgrades a
 * row to Yoku once it has verified Yoku actually has that brand.
 */

/** Yoku CDN logo. `verify: true` returns the 404-on-miss form, for checking coverage. */
export function yokuLogoUrl(domain: string, opts: { verify?: boolean; size?: number } = {}): string {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const size = opts.size ?? 256;
  // fallback/404 => "do you actually have this brand?"; without it Yoku invents a
  // lettermark, which would be indistinguishable from a real logo once stored.
  const fallback = opts.verify ? "404" : "lettermark";
  return `https://cdn.yoku.app/${encodeURIComponent(d)}/type/logo/w/${size}/format/png/fallback/${fallback}`;
}

/** Google's favicon service — keyless, universal, small. The dependable floor. */
export function googleFaviconUrl(domain: string, size = 128): string {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=${size}`;
}

/** True for a logo URL that can no longer load, so callers can treat it as absent. */
export function isDeadLogoUrl(url: string | null | undefined): boolean {
  return !!url && /(^|\/\/)logo\.clearbit\.com\//i.test(url);
}

/** The best logo URL for a domain: Yoku when it verifiably has the brand, else the favicon floor. Never throws. */
export async function bestLogoUrl(domain: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetchImpl(yokuLogoUrl(domain, { verify: true }), { redirect: "follow", signal: AbortSignal.timeout(12_000) });
    if (res.ok && (res.headers.get("content-type") ?? "").startsWith("image")) return yokuLogoUrl(domain);
  } catch { /* the floor below */ }
  return googleFaviconUrl(domain);
}
