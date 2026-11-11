/**
 * brandSiteSearch.ts — find a brand's OWN website from its name, and check it before trusting it (19 Oct 2026).
 *
 * The name search behind a domain-less brand's logo (services/brandIdentityRefresh lookupCandidate). The first version
 * asked Gemini grounding for a domain and kept it only when a grounding source sat on that domain, so real brands whose
 * grounding cited retailers or press (a stylised name like "MUD\WTR", "Remedy Organics") found nothing. This one:
 *
 *   1. normalises the name (slashes and backslashes, legal suffixes, a leading "The"),
 *   2. asks ONE OpenAI web search (skill brand/official-site; web search stays on OpenAI by the provider rule) for the
 *      brand's own site, and takes the sources it consulted as further candidates,
 *   3. VERIFIES a candidate in code before accepting it: never a marketplace / social / news / retailer / directory
 *      domain; the domain's own homepage title or og:site_name carries the brand's name (high confidence when the
 *      domain label agrees too); a homepage that cannot be read is accepted only when the domain label IS the name and
 *      the search cited that domain (medium).
 *
 * A wrong logo is worse than none: anything short of that is "not found". Generic — no brand is named here.
 */
import type { RunCost } from "../../shared/agent";
import { brandDomainOf, isNonBrandSender } from "./senderProfile";

export type SiteConfidence = "high" | "medium";

export interface VerifiedSite {
  domain: string | null;
  source: "web_search_verified";
  confidence: SiteConfidence | null;
  /** What the check saw on the domain (the homepage title / site name), or why nothing was accepted. */
  evidence: string;
  costMicroUsd: number;
}

/** Hosts that are never a brand's own site: social, link pages, marketplaces and retailers, news and wires, directories. */
export const NOT_A_BRAND_SITE = new RegExp(
  "(^|\\.)(" + [
    // social, link pages, video, app stores
    "instagram\\.com", "tiktok\\.com", "youtube\\.com", "youtu\\.be", "x\\.com", "twitter\\.com", "facebook\\.com", "fb\\.com",
    "linkedin\\.com", "threads\\.net", "pinterest\\.com", "reddit\\.com", "snapchat\\.com", "linktr\\.ee", "beacons\\.ai",
    "apps\\.apple\\.com", "play\\.google\\.com", "apple\\.com", "google\\.com",
    // marketplaces and retailers
    "amazon\\.[a-z.]+", "walmart\\.com", "target\\.com", "ebay\\.[a-z.]+", "etsy\\.com", "costco\\.com", "kroger\\.com",
    "wholefoodsmarket\\.com", "cvs\\.com", "walgreens\\.com", "iherb\\.com", "thrivemarket\\.com", "vitaminshoppe\\.com",
    "gnc\\.com", "ulta\\.com", "sephora\\.com", "nordstrom\\.com", "macys\\.com", "bestbuy\\.com", "dickssportinggoods\\.com",
    "faire\\.com", "shopify\\.com", "myshopify\\.com", "aliexpress\\.com", "alibaba\\.com", "temu\\.com", "instacart\\.com",
    // news, wires, publishing
    "wikipedia\\.org", "wikimedia\\.org", "medium\\.com", "substack\\.com", "forbes\\.com", "nytimes\\.com", "bloomberg\\.com",
    "reuters\\.com", "cnbc\\.com", "businessinsider\\.com", "techcrunch\\.com", "prnewswire\\.com", "businesswire\\.com",
    "globenewswire\\.com", "yahoo\\.com",
    // directories and reviews
    "crunchbase\\.com", "zoominfo\\.com", "pitchbook\\.com", "glassdoor\\.com", "indeed\\.com", "yelp\\.com", "bbb\\.org",
    "trustpilot\\.com", "dnb\\.com", "opencorporates\\.com", "rocketreach\\.co", "apollo\\.io",
  ].join("|") + ")$",
  "i",
);

/**
 * Shared platforms: a brand's page on one of these (a help desk, a site builder's subdomain, a shop builder) carries the
 * PLATFORM's logo, not the brand's, so it is never accepted.
 */
export const SHARED_PLATFORM = /(^|\.)(zendesk\.com|freshdesk\.com|helpscoutdocs\.com|intercom\.help|hubspotpagebuilder\.com|hs-sites\.com|wixsite\.com|squarespace\.com|webflow\.io|framer\.(website|app)|carrd\.co|base44\.app|vercel\.app|netlify\.app|github\.io|gitbook\.io|wordpress\.com|blogspot\.com|notion\.site|super\.site|typeform\.com|google\.com|bit\.ly)$/i;

const TWO_LABEL_SUFFIX = /\.(co|com|org|net|ac|or|ne|go|gov|edu)\.[a-z]{2}$/i;

/** PURE. The registrable root of a host (shop.brand.com → brand.com; en.brand.co.kr → brand.co.kr). */
export function rootDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  const keep = TWO_LABEL_SUFFIX.test(`.${parts.slice(-2).join(".")}`) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

const LEGAL_SUFFIX = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|gmbh|plc|pbc|s\.?a|ag|bv|pty)\.?$/i;

/** PURE. The name people know: stray punctuation (slashes, backslashes, pipes) as spaces, legal suffixes and a leading "The" dropped. */
export function normaliseBrandName(raw: string | null | undefined): string {
  let s = String(raw ?? "").normalize("NFKC").replace(/[\\/|_]+/g, " ").replace(/[“”"'’]+/g, "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/[,\s]+$/, "").replace(LEGAL_SUFFIX, "").replace(/[,\s]+$/, "").trim();
    if (next === s) break;
    s = next;
  }
  return s.replace(/^the\s+/i, "").trim();
}

/** PURE. Letters and digits only, lower case, accents folded, "&" read as "and": the form names are compared in. */
export function compactName(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
}

/** PURE. The registrable domain's first label (mudwtr.com → "mudwtr"). */
export function domainLabel(domain: string): string {
  return compactName(rootDomain(domain).split(".")[0]);
}

/** PURE. Is this host never a brand's own site (a non-brand site, a page on a shared platform, or a sending service / creator platform)? */
export function isNotABrandSite(domain: string): boolean {
  return NOT_A_BRAND_SITE.test(domain) || SHARED_PLATFORM.test(domain) || isNonBrandSender(domain);
}

/** PURE. Does the domain's label agree with the name (equal, or one contains the other with ≥ 4 letters on the short side)? */
export function labelMatches(domain: string, name: string): boolean {
  const label = domainLabel(domain), key = compactName(normaliseBrandName(name));
  if (!label || !key) return false;
  if (label === key) return true;
  const short = label.length < key.length ? label : key;
  return short.length >= 4 && (label.includes(key) || key.includes(label));
}

/** PURE. Does the homepage text (title, og:site_name) carry the brand's name anywhere? */
export function siteTextMatches(texts: Array<string | null | undefined>, name: string): boolean {
  const key = compactName(normaliseBrandName(name));
  if (key.length < 3) return false;
  return texts.some((t) => compactName(t).includes(key));
}

/**
 * PURE. Does the homepage NAME itself as the brand: the site name is the brand, or one segment of the title (split on
 * | – — - : · •) is exactly the brand? "MUD\WTR | A coffee alternative" names itself; a title that merely mentions the
 * words ("Character — the home improvement brand") does not.
 */
export function siteNamesItself(home: { title: string | null; siteName: string | null }, name: string): boolean {
  const key = compactName(normaliseBrandName(name));
  if (key.length < 3) return false;
  if (compactName(home.siteName) === key) return true;
  return String(home.title ?? "").split(/\s[|–—\-:·•]\s|\s?[|–—·•]\s?/).some((seg) => compactName(seg) === key);
}

export interface HomeIdentity {
  /** The registrable domain the homepage finally loaded from (after redirects). */
  finalDomain: string | null;
  title: string | null;
  siteName: string | null;
}

/** PURE. The title and og:site_name / og:title / application-name from a homepage's HTML. */
export function homeIdentityFromHtml(html: string): { title: string | null; siteName: string | null } {
  const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const meta = (key: string): string | null => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
    const tag = re.exec(html)?.[0];
    const content = tag ? /content=["']([^"']*)["']/i.exec(tag)?.[1] : null;
    return content ? decode(content) : null;
  };
  const siteName = meta("og:site_name") ?? meta("application-name") ?? meta("og:title");
  return { title: title ? decode(title).slice(0, 200) : null, siteName: siteName ? siteName.slice(0, 200) : null };
}

/** Read a domain's homepage identity. Never throws: an unreadable site returns nulls. */
export async function fetchHomeIdentity(domain: string, fetchImpl: typeof fetch = fetch): Promise<HomeIdentity | null> {
  try {
    const res = await fetchImpl(`https://${domain}/`, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; NomilaBot/1.0; +https://nomila.co)", accept: "text/html" },
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 400_000);
    let finalDomain: string | null = domain;
    try { finalDomain = brandDomainOf(new URL(res.url || `https://${domain}/`).hostname) ?? null; } catch { /* keep the asked domain */ }
    return { finalDomain, ...homeIdentityFromHtml(html) };
  } catch {
    return null;
  }
}

export interface SiteSearchAnswer {
  /** The model's answer, as written. */
  domain: string | null;
  /** Sources the search consulted, in order. */
  sources: Array<{ url: string; title?: string }>;
  cost: Pick<RunCost, "microUsd">;
}

export interface SiteSearchDeps {
  search: (name: string, rawName: string) => Promise<SiteSearchAnswer>;
  home: (domain: string) => Promise<HomeIdentity | null>;
}

/** PURE. Candidate domains to check: the model's answer first, then the hosts of the sources it consulted, deduped. */
export function candidateDomains(answer: Pick<SiteSearchAnswer, "domain" | "sources">): { domain: string; cited: boolean }[] {
  const hostOf = (u: string): string | null => { try { return brandDomainOf(new URL(u).hostname); } catch { return null; } };
  const cited = new Set(answer.sources.map((s) => hostOf(s.url)).filter((d): d is string => !!d));
  const out: { domain: string; cited: boolean }[] = [];
  const add = (d: string | null) => { if (d && !isNotABrandSite(d) && !out.some((o) => o.domain === d)) out.push({ domain: d, cited: cited.has(d) || cited.has(rootDomain(d)) }); };
  add(brandDomainOf(String(answer.domain ?? "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "")));
  for (const s of answer.sources) add(hostOf(s.url));
  return out;
}

/** Up to this many candidates have their homepage read. */
export const MAX_HOME_CHECKS = 3;

/**
 * One search, then the code check. Returns the first candidate that passes, or domain null with what was seen.
 * The search's own failure is "not found" (logged by the caller), never a guess.
 */
export async function findVerifiedOfficialSite(rawName: string, deps: SiteSearchDeps): Promise<VerifiedSite> {
  const name = normaliseBrandName(rawName);
  const none = (evidence: string, costMicroUsd = 0): VerifiedSite => ({ domain: null, source: "web_search_verified", confidence: null, evidence, costMicroUsd });
  if (compactName(name).length < 2) return none("no usable name");
  const answer = await deps.search(name, rawName);
  const cost = answer.cost.microUsd ?? 0;
  const candidates = candidateDomains(answer).slice(0, MAX_HOME_CHECKS);
  if (!candidates.length) return none(answer.domain ? `only non-brand sites (${answer.domain})` : "search found no site", cost);
  const seen: string[] = [];
  for (const c of candidates) {
    const home = await deps.home(c.domain);
    if (home) {
      const host = home.finalDomain && !isNotABrandSite(home.finalDomain) ? home.finalDomain : null;
      const domain = host ? rootDomain(host) : null;
      // The site names itself as the brand, or mentions the name AND its domain spells it. Mentioning the words alone
      // is not enough (a generic name appears in many titles).
      const names = !!host && siteNamesItself(home, name);
      const label = !!host && (labelMatches(domain!, name) || labelMatches(host, name) || labelMatches(c.domain, name));
      if (domain && !isNotABrandSite(domain) && (names || (label && siteTextMatches([home.title, home.siteName], name)))) {
        const confidence: SiteConfidence = names && label ? "high" : "medium";
        return { domain, source: "web_search_verified", confidence, evidence: `homepage: ${home.siteName ?? home.title}`.slice(0, 200), costMicroUsd: cost };
      }
      seen.push(`${c.domain}: "${(home.siteName ?? home.title ?? "no title").slice(0, 60)}"`);
      continue;
    }
    // Unreadable homepage (blocked, timed out): only the strictest agreement passes.
    if (c.cited && domainLabel(rootDomain(c.domain)) === compactName(name)) {
      return { domain: rootDomain(c.domain), source: "web_search_verified", confidence: "medium", evidence: "domain is the name and the search cited it (homepage unreadable)", costMicroUsd: cost };
    }
    seen.push(`${c.domain}: unreadable`);
  }
  return none(`no candidate carried the name (${seen.join("; ")})`.slice(0, 300), cost);
}
