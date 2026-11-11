/**
 * agent/factHygiene.ts — the formatting rules every memory_facts writer goes through (the store layer applies them, so
 * no writer can skip them: research, merge, the weekly moments scan, onboarding and the core tools).
 *
 *   cleanClaim          strips inline markdown citations a model leaves in prose — "… ([site.com](https://…))",
 *                       "[label](https://…)" and bare "(https://…)" — and tidies the spacing they leave. The source
 *                       lives in the fact's source fields, never in its claim.
 *   normalizeSourceUrl  validates and normalises a source URL: http(s) only, a real host, no credentials, no
 *                       whitespace or markdown residue, tracking parameters (utm_*, trk) and the fragment removed, and
 *                       never a page asset (an image, stylesheet, script or font path), which is never the page a claim
 *                       comes from. Returns null for a URL that is not a usable source.
 *   cleanNewFact        both, for one fact about to be written: a junk primary URL falls back to the first usable
 *                       also-seen URL, else to the source ref; with neither it is rejected (source_required).
 *
 * Pure: no database. Nothing here names an athlete, sport, school or brand.
 */

/** "(" + one or more markdown links separated by , ; or spaces + ")" — a citation parenthetical, removed whole. */
const CITATION_PAREN = /\s*\(\s*\[[^\]\n]*\]\(\s*[^)\s]+\s*\)(?:\s*[,;]?\s*\[[^\]\n]*\]\(\s*[^)\s]+\s*\))*\s*\)/g;
/** A markdown link outside a citation parenthetical: keep its label, drop the URL. */
const MD_LINK = /\[([^\]\n]+)\]\(\s*https?:\/\/[^)\s]+\s*\)/g;
/** A bare URL in brackets. */
const BARE_URL_PAREN = /\s*[(\[]\s*https?:\/\/[^)\]\s]+\s*[)\]]/g;

/** A claim with its inline markdown citations removed and its spacing tidied. Never adds words. */
export function cleanClaim(raw: string): string {
  return String(raw ?? "")
    .replace(CITATION_PAREN, "")
    .replace(MD_LINK, "$1")
    .replace(BARE_URL_PAREN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/** A path ending in a page asset: never the page a fact comes from. */
const ASSET_PATH = /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif|heic|css|js|mjs|map|woff2?|ttf|otf|eot)$/i;
const TRACKING_PARAM = /^(utm_[a-z_]+|trk|fbclid|gclid|mc_cid|mc_eid|igshid)$/i;

/** A usable, normalised source URL, or null when the URL is not one. */
export function normalizeSourceUrl(raw: string | null | undefined): string | null {
  // Trailing punctuation and markdown residue a model leaves around a URL ("https://x.org/a).", "<https://…>").
  const s = String(raw ?? "").trim().replace(/^<+/, "").replace(/[>)\].,;:'"!?]+$/, "");
  if (!s || /\s/.test(s) || /[\[\]<>"]/.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".") || /^[\d.]+$/.test(host)) return null;
  if (ASSET_PATH.test(decodeURIComponentSafe(u.pathname))) return null;
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  u.hash = "";
  u.hostname = host;
  return u.toString();
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** The fields of a fact this module cleans (both NewFact shapes in agent/ share them). */
export interface CleanableFact {
  claim: string;
  source: { url?: string | null; ref?: string | null; title?: string | null };
  alsoSeenAt?: Array<{ url: string; title?: string }>;
}

export class FactHygieneError extends Error {
  constructor(readonly rule: "claim_required" | "source_required", message: string) {
    super(`${rule}: ${message}`);
  }
}

/**
 * One fact, cleaned for storage: claim without inline citations; source URL validated and normalised (a junk one falls
 * back to the first usable also-seen URL, else is dropped in favour of the source ref); also-seen URLs validated,
 * normalised and de-duplicated. Throws FactHygieneError when the claim is empty after cleaning or no usable source
 * (URL or ref) remains — the writer drops such a fact before it reaches the store.
 */
export function cleanNewFact<T extends CleanableFact>(f: T): T {
  const claim = cleanClaim(f.claim);
  if (!claim) throw new FactHygieneError("claim_required", "the claim is empty once its inline citations are removed");
  const also: Array<{ url: string; title?: string }> = [];
  const seen = new Set<string>();
  const primaryRaw = f.source.url?.trim() ? f.source.url : null;
  const primary = normalizeSourceUrl(primaryRaw);
  if (primary) seen.add(primary);
  for (const a of f.alsoSeenAt ?? []) {
    const url = normalizeSourceUrl(a?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    also.push({ url, ...(a.title ? { title: a.title } : {}) });
  }
  let url = primary;
  let title = f.source.title ?? null;
  if (!url && primaryRaw && also.length) {
    // The primary URL was junk: the first usable also-seen source takes its place.
    const next = also.shift()!;
    url = next.url;
    title = next.title ?? title;
  }
  const ref = f.source.ref?.trim() || null;
  if (!url && !ref) throw new FactHygieneError("source_required", primaryRaw ? `the source url is not usable (${String(primaryRaw).slice(0, 120)})` : "a fact needs a source url or ref");
  const source: T["source"] = { ...(url ? { url } : {}), ...(ref ? { ref } : {}), ...(title ? { title } : {}) } as T["source"];
  return { ...f, claim, source, ...(f.alsoSeenAt ? { alsoSeenAt: also } : {}) };
}
