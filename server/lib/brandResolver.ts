/**
 * brandResolver.ts — brand entity resolution for inbox emails.
 *
 * Resolves a sender domain + brand name to a row in inbox_brands, creating
 * one if no match is found.
 *
 * "Same name or same domain, otherwise a new row" (Opportunities PR 2):
 *   Strategy 1: Exact domain match  — inbox_brands.domain = the brand's registrable domain
 *   Strategy 2: Same name           — the same normalized name (legal suffixes, case,
 *                                     punctuation and spacing ignored)
 *   Strategy 3: Create new entry    — insert domain + name, return is_new: true
 *
 * Look-alikes never merge. The old domain-root prefix match and the Levenshtein /
 * containment match ("startx" inside "startx1" scored 0.86) merged distinct brands
 * into one row; their best candidate is now only logged, for review. A free-mail
 * domain is never a brand's identity (brandDomainOf returns null for it), so it is
 * neither matched nor stored.
 *
 * Returns null only when both domain and brandName are null/empty.
 *
 * Cache: all brands are loaded once per TTL (5 min) to avoid per-email DB scans.
 * Invalidated on insert so newly-created brands are immediately discoverable.
 */

import { db } from "../db";
import { inboxBrands } from "../../shared/schema";
import { eq, sql } from "drizzle-orm";
import { createLogger } from "../logger";
import { googleFaviconUrl } from "./brandLogoSources";
import { assessLogo, logoCheckOf, type LogoAssessment } from "./brandLogoCheck";
import { brandDomainOf } from "./senderProfile";
import { normalizeBrand, sameBrandName, sameNameKey } from "./brandName";
import { brandIdentityGateEnabled } from "./brandIdentity";

const logger = createLogger("lib/brandResolver");

const FUZZY_THRESHOLD = 0.75; // similarity at which a look-alike is LOGGED as a candidate (never merged)

// ─── Agency / aggregator registry (brand-identity-foundation §3 seed) ──────────
// Sender domains that are agencies / MCNs / influencer platforms / distributors
// emailing ON BEHALF OF a brand. Registry membership is the ONLY trigger for
// automatic re-attribution — a raw name-in-domain mismatch is a *candidate* for
// review, never an auto-action (protects false positives like visitbrasil.com.br).
export const AGENCY_DOMAINS = new Set<string>([
  "eezycollab.com", "makewondermcn.com", "accelerationpartners.com", "megfluence.com",
  "theinfluenceagency.com", "launchpointugc.com", "partnerboost.com", "crankcreative.com",
  "breakr.social", "fluencify.site", "noonwake.ai", "sproutsocial-mail.com", "mcwcontent.com.br",
  "kglowing.com", "kglowingusa.com", "kglowingamerica.com", "kglowing.ai", "kglowing.co.kr",
  "kglowingusa.co.kr",
  // Added 2026-08-18 from the §6 registry-candidate review. Each was confirmed by its deal
  // history to broker OTHER brands' campaigns, which is the agency tell — not by the
  // name-in-domain mismatch alone (that flagged xAI @ x.ai and San Jose Earthquakes @
  // fanmail.sjearthquakes.com, both direct brands, so mismatch stays review-only).
  "crevasse.ai",       // AEGISLAB — NEEDLY, LUDIENT, KAHI, et al.
  "agency-eight.com",  // Agency Eight — Magna electrolytes, World Cup jersey kits, gifting
  "corp.netease.com",  // Youdao Ads — "join our creator network" platform invitations
]);

// Case C — agency *self-pitches* that arrive from generic senders (e.g. gmail.com),
// so the domain registry can't catch them. Matched on normalized brand name.
export const AGENCY_NAMES = new Set<string>([
  "metropolitan sports agency", "metropolitan sports",
  "metro influencers marketing agency", "metro influencers",
]);

// Human label for a known agency domain (for the "via [agency]" provenance line).
const AGENCY_LABELS: Record<string, string> = {
  "eezycollab.com": "EezyCollab", "makewondermcn.com": "Make Wonder MCN",
  "accelerationpartners.com": "Acceleration Partners", "megfluence.com": "Megfluence",
  "theinfluenceagency.com": "The Influence Agency", "launchpointugc.com": "LaunchPoint UGC",
  "partnerboost.com": "PartnerBoost", "crankcreative.com": "Crank Creative",
  "breakr.social": "Breakr", "fluencify.site": "Fluencify", "noonwake.ai": "Noonwake",
  "sproutsocial-mail.com": "Sprout Social",
  "kglowing.com": "Kglowing", "kglowingusa.com": "Kglowing", "kglowingamerica.com": "Kglowing",
  "kglowing.ai": "Kglowing", "kglowing.co.kr": "Kglowing",
  // The label must equal the captured brand name for these, or brandIsAgency won't match and
  // the row resolves as a direct advertiser instead of an agency.
  "crevasse.ai": "AEGISLAB", "agency-eight.com": "Agency Eight", "corp.netease.com": "Youdao Ads",
};

function agencyLabel(domain: string): string {
  return AGENCY_LABELS[domain] ?? domain;
}

// normalizeBrand / sameNameKey live in ./brandName (pure, import-free); re-exported for callers.
export { normalizeBrand } from "./brandName";

// ─── Self-validating brand aliases ────────────────────────────────────────────
// Candidate variant→canonical merges. NOT applied blindly: an alias only fires when
// the canonical target row exists AND the variant shares a domain with it in the
// actual data (e.g. "get brick"→"brick" only if both appear under getbrick.com).
// Unvalidated candidates are skipped and flagged — no dev-only hardcoded merge.
export const ALIAS_CANDIDATES: [string, string][] = [
  ["get brick", "brick"],
  ["fazit beauty", "fazit"],
];

export interface AliasValidation {
  validated: Map<string, string>; // variantNorm → canonicalNorm (only data-confirmed)
  skipped:   { variant: string; target: string; reason: string }[];
}

/**
 * Validate alias candidates against real data. `evidence` = every brand row and
 * thread as { normalized, domain }. An alias is accepted only if the target has a
 * row with a domain AND the variant shares one of those domains.
 */
export function validateAliases(evidence: { normalized: string; domain: string | null }[]): AliasValidation {
  const validated = new Map<string, string>();
  const skipped: AliasValidation["skipped"] = [];
  for (const [variant, target] of ALIAS_CANDIDATES) {
    const targetDomains = new Set(evidence.filter((e) => e.normalized === target && e.domain).map((e) => e.domain!));
    if (targetDomains.size === 0) { skipped.push({ variant, target, reason: "no target row with a domain" }); continue; }
    const shares = evidence.some((e) => e.normalized === variant && e.domain && targetDomains.has(e.domain));
    if (shares) validated.set(variant, target);
    else skipped.push({ variant, target, reason: `variant does not share target domain (${[...targetDomains].join("/")})` });
  }
  return { validated, skipped };
}

// ─── Advertiser identity (brand-identity-foundation §2 decision rule) ──────────

export interface AdvertiserIdentity {
  advertiser:         string | null;  // resolved end-brand name; null = unresolved
  via_agency:         boolean;
  agency_name:        string | null;
  agency_domain:      string | null;
  is_agency:          boolean;        // the captured "brand" IS an agency (exclude from identity)
  unresolved:         boolean;        // via agency, agency captured as brand, no end brand named
  registry_candidate: boolean;        // name-in-domain mismatch NOT in registry → flag for review only
}

/**
 * Pure decision rule (no DB). Shared by the live resolver and the backfill.
 * Registry-first: only a known agency domain (or a classifier "on behalf of"
 * signal, or a known agency name) triggers re-attribution. LOCKED behaviour —
 * when the agency is captured as the brand and no end advertiser is named, the
 * advertiser is left UNRESOLVED; we never credit the agency as the brand.
 */
export function resolveAdvertiserIdentity(p: {
  brandName:    string | null;
  senderDomain: string | null;
  advertiser?:  string | null;  // classifier body extraction (live path); undefined for backfill
  agencyName?:  string | null;
  viaAgency?:   boolean;
}): AdvertiserIdentity {
  const domain = p.senderDomain?.toLowerCase().trim() || null;
  const brand  = p.brandName?.trim() || null;
  const normBrand = normalizeBrand(brand);

  const registryAgency = !!domain && AGENCY_DOMAINS.has(domain);
  const nameAgency     = AGENCY_NAMES.has(normBrand);
  const classifierAgency = p.viaAgency === true;

  // name-in-domain mismatch — candidate signal only (never auto-acts off-registry)
  const token = normBrand.split(" ")[0] ?? "";
  const mismatch = !!brand && !!domain && token.length >= 3 && !domain.includes(token);

  // Case C — agency self-pitch captured as a "brand" (gmail senders). No end advertiser.
  if (nameAgency) {
    return {
      advertiser: null, via_agency: true,
      agency_name: brand, agency_domain: domain,
      is_agency: true, unresolved: true, registry_candidate: false,
    };
  }

  const viaAgency = registryAgency || classifierAgency;
  if (!viaAgency) {
    // Direct. An unknown mismatch is flagged for registry review but treated as direct.
    return {
      advertiser: p.advertiser?.trim() || brand,
      via_agency: false, agency_name: null, agency_domain: null,
      is_agency: false, unresolved: false, registry_candidate: mismatch,
    };
  }

  const agencyName = p.agencyName?.trim() || (registryAgency ? agencyLabel(domain!) : null);
  const bodyAdv    = p.advertiser?.trim() || null;
  const domRoot    = domain ? domainRoot(domain) : "";

  // brand_name captured AS the agency itself (e.g. "Megfluence" @ megfluence.com)
  const brandIsAgency = !!brand && (
    (agencyName && normBrand === normalizeBrand(agencyName)) ||
    (domRoot.length >= 3 && normBrand.replace(/ /g, "") === domRoot)
  );

  if (bodyAdv && (!agencyName || normalizeBrand(bodyAdv) !== normalizeBrand(agencyName))) {
    return { advertiser: bodyAdv, via_agency: true, agency_name: agencyName, agency_domain: domain,
             is_agency: false, unresolved: false, registry_candidate: false };
  }
  if (brand && !brandIsAgency) {
    // brand_name IS the advertiser (UGREEN, Snackbeast, Meitu) — only the domain was the agency's.
    return { advertiser: brand, via_agency: true, agency_name: agencyName, agency_domain: domain,
             is_agency: false, unresolved: false, registry_candidate: false };
  }
  // Agency captured as brand, no end advertiser named → unresolved (LOCKED: never credit agency).
  return { advertiser: null, via_agency: true, agency_name: agencyName ?? brand, agency_domain: domain,
           is_agency: true, unresolved: true, registry_candidate: false };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BrandResolution {
  brand_id:     number;
  brand_name:   string;
  brand_domain: string | null;   // nullable under model A (agency-only advertisers have no domain)
  logo_url:     string | null;
  is_new:       boolean;
  // §2 provenance — set when the sender was an agency emailing for this advertiser.
  via_agency?:   boolean;
  agency_name?:  string | null;
  agency_domain?: string | null;
  unresolved?:   boolean;  // via agency but end advertiser unknown → "via [agency] · advertiser unknown"
}

// ─── In-memory brand cache ────────────────────────────────────────────────────

interface CachedBrand {
  id:         number;
  name:       string;
  domain:     string | null;
  logo_url:   string | null;
  normalized: string; // lowercase, punctuation stripped — computed once on load
}

let _cache: CachedBrand[] | null = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

/**
 * brandLogoUrl — the logo minted when a brand row is created.
 *
 * Uses the keyless favicon, which always resolves, so minting never depends on a network
 * check in the hot path. backfillBrandLogos upgrades the row to a real Yoku logo once it
 * has verified Yoku actually carries that brand. Sources and their history are documented
 * in server/lib/brandLogoSources.ts.
 */
function brandLogoUrl(domain: string): string {
  return googleFaviconUrl(domain);
}

async function getBrands(): Promise<CachedBrand[]> {
  if (_cache && Date.now() < _cacheExpiry) return _cache;
  const rows = await db.select({ id: inboxBrands.id, name: inboxBrands.name, domain: inboxBrands.domain, logo_url: inboxBrands.logo_url }).from(inboxBrands);
  _cache = rows.map((r) => ({ ...r, normalized: normalize(r.name) }));
  _cacheExpiry = Date.now() + CACHE_TTL_MS;
  return _cache;
}

/**
 * Store a logo check on a brand row: the logo good enough to show (or none) plus the check itself, so display never
 * falls back to a favicon the check rejected. Only touches the logo when the row still holds `domain`.
 */
export async function storeLogoCheck(id: number, domain: string, a: LogoAssessment, now: Date = new Date()): Promise<void> {
  const check = logoCheckOf(domain, a, now);
  await db.update(inboxBrands)
    .set({ logo_url: a.url, enrichment: sql`coalesce(${inboxBrands.enrichment}, '{}'::jsonb) || ${JSON.stringify({ logo_check: check })}::jsonb` } as any)
    .where(sql`${inboxBrands.id} = ${id} AND ${inboxBrands.domain} = ${domain}`);
  if (_cache) { const e = _cache.find((b) => b.id === id); if (e) e.logo_url = a.url; }
}

/** Fire-and-forget after a brand row is created: swap the minted favicon for the checked logo. Never throws. */
function checkLogoLater(id: number, domain: string, name: string): void {
  if (process.env.NODE_ENV === "test") return;   // tests never reach the network
  void assessLogo(domain, name).then((a) => storeLogoCheck(id, domain, a)).catch((err) => logger.warn({ err: err?.message, id }, "logo check failed"));
}

function invalidateCache(): void {
  _cache = null;
  _cacheExpiry = 0;
}

// Backfill logo_url on existing brands that were created before this logic.
// Fire-and-forget: updates DB and cache in place; never throws to caller.
async function ensureLogo(id: number, domain: string | null, existing: string | null): Promise<string | null> {
  if (existing) return existing;
  if (!domain) return null;
  const url = brandLogoUrl(domain);
  try {
    await db.update(inboxBrands).set({ logo_url: url }).where(eq(inboxBrands.id, id));
    if (_cache) {
      const entry = _cache.find((b) => b.id === id);
      if (entry) entry.logo_url = url;
    }
  } catch {
    // Non-fatal — logo is cosmetic
  }
  return url;
}

// ─── Main resolver ────────────────────────────────────────────────────────────

export async function resolveBrand(params: {
  domain:    string | null;
  brandName: string | null;
}): Promise<BrandResolution | null> {
  const { domain, brandName } = params;
  // Reduced to the registrable domain, and nulled for ESPs. Brands send from marketing
  // subdomains (email.jellycat.com, mkt.pacsun.com), and storing the sending host as the
  // brand's identity is what left every logo lookup failing. One chokepoint, so every path
  // in — live ingest, the backfills, fuzzy match — gets the same answer.
  const cleanDomain = brandDomainOf(domain);
  const cleanName   = brandName?.trim() || null;

  if (!cleanDomain && !cleanName) return null;

  // ── Strategy 1: Exact domain match ────────────────────────────────────────
  if (cleanDomain) {
    const [row] = await db
      .select({ id: inboxBrands.id, name: inboxBrands.name, domain: inboxBrands.domain, logo_url: inboxBrands.logo_url })
      .from(inboxBrands)
      .where(eq(inboxBrands.domain, cleanDomain))
      .limit(1);

    if (row) {
      const logo_url = await ensureLogo(row.id, row.domain, row.logo_url);
      logger.debug({ domain: cleanDomain, brandId: row.id }, "Brand resolved: exact domain");
      return { brand_id: row.id, brand_name: row.name, brand_domain: row.domain, logo_url, is_new: false };
    }
  }

  // ── Strategy 2: Same name ─────────────────────────────────────────────────
  if (cleanName) {
    const match = await findBySameName(cleanName);
    if (match) {
      const logo_url = await ensureLogo(match.id, match.domain, match.logo_url);
      logger.debug({ brandName: cleanName, brandId: match.id }, "Brand resolved: same name");
      return { brand_id: match.id, brand_name: match.name, brand_domain: match.domain, logo_url, is_new: false };
    }
  }

  // Look-alikes are candidates for review, never a merge.
  await logLookAlike(cleanName, cleanDomain);

  // ── Strategy 3: Create new brand entry ────────────────────────────────────
  // Model A: identity = normalized_name (UNIQUE). Domain is nullable — only set
  // when we have a real sender domain; NEVER fabricated for name-only advertisers.
  if (!cleanDomain && !cleanName) return null;
  const newName    = cleanName ?? cleanDomain!;
  const normName   = normalizeBrand(newName);
  const newDomain  = cleanDomain ?? null;
  const newLogoUrl = cleanDomain ? brandLogoUrl(cleanDomain) : null;

  try {
    const [inserted] = await db
      .insert(inboxBrands)
      .values({ domain: newDomain, name: newName, normalized_name: normName, logo_url: newLogoUrl })
      .onConflictDoUpdate({ target: inboxBrands.normalized_name, set: { name: newName, ...(newDomain ? { domain: newDomain } : {}), logo_url: newLogoUrl } })
      .returning({ id: inboxBrands.id, name: inboxBrands.name, domain: inboxBrands.domain, logo_url: inboxBrands.logo_url });

    invalidateCache();
    logger.info({ domain: newDomain, name: newName, brandId: inserted.id }, "Brand created (new)");
    if (inserted.domain) checkLogoLater(inserted.id, inserted.domain, inserted.name);
    return { brand_id: inserted.id, brand_name: inserted.name, brand_domain: inserted.domain, logo_url: inserted.logo_url, is_new: true };
  } catch (err: any) {
    logger.error({ err: err.message, domain: newDomain, name: newName }, "Brand insert failed");
    return null;
  }
}

// ─── Identity-aware resolver (re-attribution + provenance) ─────────────────────

/** The existing row with the SAME name, if any. Look-alikes do not count. */
async function findBySameName(name: string): Promise<CachedBrand | null> {
  const key = sameNameKey(name);
  if (!key) return null;
  const brands = await getBrands();
  // The exact name first; then the same company under its legal-entity name ("adidas America Inc." → "adidas").
  return brands.find((b) => sameNameKey(b.name) === key) ?? brands.find((b) => sameBrandName(b.name, name)) ?? null;
}

/**
 * Log the closest look-alike of a brand that is about to get its own row — the containment,
 * Levenshtein and domain-root signals that used to MERGE. Review material only; never acts.
 */
async function logLookAlike(name: string | null, domain: string | null): Promise<void> {
  const brands = await getBrands();
  const norm = name ? normalize(name) : "";
  const root = domain ? domainRoot(domain) : "";
  let best: CachedBrand | null = null, bestScore = 0;
  for (const b of brands) {
    let score = norm ? similarity(norm, b.normalized) : 0;
    if (norm && (b.normalized.includes(norm) || norm.includes(b.normalized))) {
      score = Math.max(score, Math.min(b.normalized.length, norm.length) / Math.max(b.normalized.length, norm.length, 1));
    }
    if (root.length >= 3 && (b.normalized.startsWith(root) || root.startsWith(b.normalized))) score = Math.max(score, FUZZY_THRESHOLD);
    if (score > bestScore) { bestScore = score; best = b; }
  }
  if (best && bestScore >= FUZZY_THRESHOLD) {
    logger.info({ brandName: name, domain, candidate: best.name, candidateId: best.id, score: bestScore.toFixed(2) }, "Brand look-alike candidate (not merged)");
  }
}

/**
 * Give a domain-less advertiser row the domain its mail literally showed — once, and only when no other
 * row already holds that domain (two rows on one domain is a merge question for review, not for ingest).
 */
async function fillAdvertiserDomain(row: CachedBrand, domain: string): Promise<string | null> {
  try {
    const [owner] = await db.select({ id: inboxBrands.id }).from(inboxBrands).where(eq(inboxBrands.domain, domain)).limit(1);
    if (owner && owner.id !== row.id) {
      logger.info({ brandId: row.id, brandName: row.name, domain, ownerId: owner.id }, "Advertiser domain held by another brand row — not filled (review)");
      return null;
    }
    await db.update(inboxBrands).set({ domain }).where(eq(inboxBrands.id, row.id));
    row.domain = domain;
    logger.info({ brandId: row.id, brandName: row.name, domain }, "Advertiser domain filled from the mail");
    return domain;
  } catch (err: any) {
    logger.warn({ brandId: row.id, err: err?.message }, "Advertiser domain fill failed");
    return null;
  }
}

/** Match an advertiser NAME to an existing brand row (no create, no domain guess). Same name only. */
async function resolveExistingByName(name: string): Promise<CachedBrand | null> {
  return findBySameName(name);
}

/**
 * Resolve a thread to its ADVERTISER identity, applying the §2 decision rule:
 * registry-first re-attribution, unresolved-over-wrong, canonical-domain-no-guessing.
 * Wraps the 4-strategy resolveBrand and attaches agency provenance. Leaves the
 * existing direct path untouched.
 *
 * NOTE: when an agency-only advertiser has no existing direct row and no literal
 * domain, we still resolve on (sender domain + advertiser NAME) so the row carries
 * the correct name + provenance — assigning a canonical domain for such brand-new
 * agency-only advertisers is a backfill/identity decision (see §6 dry-run), not a
 * place to fabricate a domain.
 */
export async function resolveBrandIdentity(params: {
  domain:     string | null;
  brandName:  string | null;
  advertiser?: string | null;
  agencyName?: string | null;
  viaAgency?:  boolean;
  /** The advertiser's own domain, literally present in the mail (classification.advertiser_domain). */
  advertiserDomain?: string | null;
}): Promise<BrandResolution | null> {
  const identity = resolveAdvertiserIdentity({
    brandName:    params.brandName,
    senderDomain: params.domain,
    advertiser:   params.advertiser,
    agencyName:   params.agencyName,
    viaAgency:    params.viaAgency,
  });

  const provenance = identity.via_agency
    ? { via_agency: true, agency_name: identity.agency_name, agency_domain: identity.agency_domain, unresolved: identity.unresolved }
    : {};

  // via agency + a known advertiser → prefer collapsing onto an existing brand row by name
  // BRAND_IDENTITY_GATE: the advertiser's own domain, when the mail literally shows it, is identity
  // evidence — never the agency's (literalAdvertiserDomain already refuses the sender's domain).
  const advertiserDomain = brandIdentityGateEnabled() ? brandDomainOf(params.advertiserDomain ?? null) : null;

  if (identity.via_agency && identity.advertiser) {
    const existing = await resolveExistingByName(identity.advertiser);
    if (existing) {
      const domain = existing.domain ?? (advertiserDomain ? await fillAdvertiserDomain(existing, advertiserDomain) : null);
      const logo_url = await ensureLogo(existing.id, domain, existing.logo_url);
      return { brand_id: existing.id, brand_name: existing.name, brand_domain: domain, logo_url, is_new: false, ...provenance };
    }
    // No existing advertiser row — resolve by NAME, plus the advertiser's own domain when the mail
    // showed it. Never pass the agency domain (its exact-domain match would re-strand the advertiser
    // onto the agency row, e.g. Snackbeast → Megfluence).
    const res = await resolveBrand({ domain: advertiserDomain, brandName: identity.advertiser });
    return res ? { ...res, ...provenance } : null;
  }

  // unresolved (agency captured as brand) or agency self-pitch → resolve sender row, flag is_agency
  const res = await resolveBrand({ domain: params.domain, brandName: params.brandName });
  if (res && identity.is_agency) {
    try { await db.update(inboxBrands).set({ is_agency: true }).where(eq(inboxBrands.id, res.brand_id)); } catch { /* non-fatal */ }
  }
  return res ? { ...res, ...provenance } : res;
}

// ─── String helpers ───────────────────────────────────────────────────────────

/** Strip TLD and separators to get a root token: "nikemarketing.com" → "nikemarketing" */
function domainRoot(domain: string): string {
  // Remove TLD (.com, .co.uk, etc.) — take the penultimate label
  const parts = domain.split(".");
  const root  = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  // Strip common suffixes like "marketing", "partnerships", "sports", "global"
  return root.replace(/(marketing|partnership|sport|global|media|brand|official|pr|press)s?$/i, "").toLowerCase();
}

/** Normalize a brand name for comparison: lowercase, alphanumeric only */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

// ─── Levenshtein distance + similarity ───────────────────────────────────────

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}
