/**
 * brandIdentityRefresh.ts — "confirm the brand, then get its pictures", for every athlete (owner-approved 7 Oct 2026).
 *
 * ONE request seam and ONE job body. Whoever learns something about a brand's domain only ASKS:
 *   - ingest (dealDetector): a new email for the brand left it holding a domain — the direct sender's own domain,
 *     or the advertiser's domain literally present in the mail (classification.advertiser_domain);
 *   - her "Confirm this is [brand]" tap (services/brandConfirmation);
 *   - the catch-up script (scripts/brands/reextractBrandDomains) for mail that arrived before this existed;
 *   - a candidate read with nothing to offer (lookup: a name search proposes a domain for her to confirm).
 * The `brand_identity_refresh` workflow waits out a short debounce, then runs runBrandIdentityRefresh, which reads
 * the row as it is THEN and decides for itself:
 *
 *   1. domain   set it on the row when the row has none and no other row holds it (two rows on one domain is a
 *               merge question for review, never for a job);
 *   2. research re-run researchBrand under the identity gate, at most once per brand per BRAND_RESEARCH_CAP_DAYS for
 *               the same domain — unless an athlete's confirmation is newer than the last check;
 *   3. imagery  for a TRUSTED domain only (research confirmed it, or an athlete did): the logo and the homepage
 *               og:image from that domain alone (lib/ownSiteImagery), stored as source "own_site". An unconfirmed
 *               brand gets no imagery.
 *
 * Idempotent and bounded: the runner allows one active run per (athlete, brand); every step reads state rather than
 * the request, so a repeat request is a cheap no-op; nothing here re-requests itself (no onDone loop). No brand or
 * athlete is named anywhere. Off unless BRAND_IDENTITY_GATE is on (without the gate there is no identity to check).
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { inboxBrands } from "../../shared/schema";
import { createLogger } from "../logger";
import {
  brandDomainFromInput, brandIdentityGateEnabled, brandNeedsCandidateLookup, brandNeedsIdentityWork, identitySettled, ownSiteBasis, readAthleteConfirmed, readSystemConfirmed, readCandidateLookupAt,
  readIdentity, readOwnSite, type BrandCandidate, type OwnSiteImagery,
} from "../lib/brandIdentity";
import { isDeadLogoUrl } from "../lib/brandLogoSources";
import { assessLogo, logoCheckOf, type LogoAssessment } from "../lib/brandLogoCheck";
import type { OwnSiteResult } from "../lib/ownSiteImagery";

const logger = createLogger("services/brand-identity-refresh");

export const BRAND_IDENTITY_REFRESH_PROCESS = "brand_identity_refresh";
/** Long enough for ingest's own research of a new brand to land first, short enough to picture it the same session. */
export const BRAND_IDENTITY_DEBOUNCE_MS = 2 * 60_000;
/** One grounded research per brand per window for the same domain (an athlete's newer confirmation bypasses it). */
export const BRAND_RESEARCH_CAP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BrandIdentityRefreshInput {
  brandId: number;
  reason: string;
  /** Domain evidence the requester holds (an advertiser_domain, her confirmed domain). Filled by the rule above. */
  domain?: string | null;
  /** No domain anywhere: run a name search for a candidate she can confirm. */
  lookup?: boolean;
}

export const brandIdentityScope = (input: unknown): string =>
  `${BRAND_IDENTITY_REFRESH_PROCESS}:${Number((input as { brandId?: unknown } | null)?.brandId) || 0}`;

type BrandRow = typeof inboxBrands.$inferSelect;

async function loadBrand(brandId: number): Promise<BrandRow | null> {
  const [row] = await db.select().from(inboxBrands).where(eq(inboxBrands.id, brandId)).limit(1);
  return row ?? null;
}

export type FillResult = "set" | "already" | "different" | "held" | "invalid" | "no_brand";

/**
 * Give a domain-less row this domain — once, and only when no OTHER row holds it. One statement, so two writers
 * cannot both win. A row that already has a domain is never re-pointed ("different").
 */
export async function fillBrandDomain(brandId: number, rawDomain: string | null | undefined): Promise<FillResult> {
  const d = brandDomainFromInput(rawDomain ?? null);
  if (!d) return "invalid";
  const row = await loadBrand(brandId);
  if (!row) return "no_brand";
  const current = brandDomainFromInput(row.domain ?? null);
  if (current) return current === d ? "already" : "different";
  const updated = await db.update(inboxBrands).set({ domain: d })
    .where(and(eq(inboxBrands.id, brandId), sql`(${inboxBrands.domain} IS NULL OR ${inboxBrands.domain} = '')`,
      sql`NOT EXISTS (SELECT 1 FROM inbox_brands o WHERE o.domain = ${d} AND o.id <> ${brandId})`))
    .returning({ id: inboxBrands.id });
  if (updated.length) {
    logger.info({ brandId, domain: d }, "brand domain filled from evidence");
    return "set";
  }
  const [owner] = await db.select({ id: inboxBrands.id }).from(inboxBrands).where(and(eq(inboxBrands.domain, d), ne(inboxBrands.id, brandId))).limit(1);
  return owner ? "held" : "already";
}

/** Ask for the job. Never fatal: the caller's write already succeeded. Gate off ⇒ nothing is started. */
export async function requestBrandIdentityRefresh(
  athleteId: string,
  brandId: number,
  reason: string,
  opts: { domain?: string | null; lookup?: boolean } = {},
): Promise<{ runId: string; created: boolean } | null> {
  if (!brandIdentityGateEnabled() || !athleteId || !Number.isInteger(brandId) || brandId <= 0) return null;
  try {
    // Fill here as well as in the job: a request that joins an already-active run would otherwise lose its domain.
    if (opts.domain) await fillBrandDomain(brandId, opts.domain);
    const { startRun } = await import("../workflow/runner.js");
    const input: BrandIdentityRefreshInput = { brandId, reason: reason.slice(0, 120), ...(opts.domain ? { domain: brandDomainFromInput(opts.domain) } : {}), ...(opts.lookup ? { lookup: true } : {}) };
    const { run, created } = await startRun({ process: BRAND_IDENTITY_REFRESH_PROCESS, athleteId, input: input as any });
    return { runId: run.id, created };
  } catch (err: any) {
    logger.error({ athleteId, brandId, reason, error: err?.message }, "brand identity refresh request failed; the brand is re-checked on the next request");
    return null;
  }
}

/**
 * Ingest's hook: this email may have left the brand holding domain evidence — the sender's own domain the resolver
 * stored, or `advertiserDomain` (classification.advertiser_domain: literally in the mail, never the sender's). A row
 * with no domain takes the advertiser domain by the fill rule (the resolver only does so on agency mail; a direct
 * pitch from a free-mail address showing the brand's site is evidence too). Asks for the job only when the row then
 * has identity work outstanding (brandNeedsIdentityWork), so a brand already checked and pictured costs one SELECT.
 */
export async function noteBrandDomainEvidence(
  athleteId: string,
  brandId: number | null | undefined,
  reason: string,
  advertiserDomain?: string | null,
): Promise<{ runId: string; created: boolean } | null> {
  if (!brandIdentityGateEnabled() || !brandId) return null;
  try {
    let row = await loadBrand(brandId);
    if (row && !row.is_agency && advertiserDomain && !brandDomainFromInput(row.domain ?? null)) {
      if ((await fillBrandDomain(brandId, advertiserDomain)) === "set") row = await loadBrand(brandId);
    }
    if (!row) return null;
    // No domain anywhere (a free-mail sender, a third-party sending domain): search the brand's name now, so a new
    // email's brand is pictured by its logo without waiting for her to open the confirm sheet. Capped per brand.
    if (brandNeedsCandidateLookup(row, new Date(), BRAND_RESEARCH_CAP_DAYS)) {
      return await requestBrandIdentityRefresh(athleteId, brandId, reason, { lookup: true });
    }
    if (!brandNeedsIdentityWork(row)) return null;
    return await requestBrandIdentityRefresh(athleteId, brandId, reason);
  } catch (err: any) {
    logger.warn({ athleteId, brandId, error: err?.message }, "brand domain evidence check failed");
    return null;
  }
}

// ─── The job body ─────────────────────────────────────────────────────────────

export interface BrandIdentityRefreshDeps {
  research: (brandId: number, name: string, domain: string, opts: { force?: boolean; now?: Date }) => Promise<void>;
  ownSite: (domain: string) => Promise<OwnSiteResult | null>;
  searchSite: (name: string) => Promise<SiteSearchResult>;
  /** The best logo URL for a domain (Yoku when verified, else its favicon). */
  /** The logo good enough to show for a domain (lib/brandLogoCheck), or none with the reason. */
  logoFor: (domain: string, name?: string | null) => Promise<LogoAssessment>;
}

async function defaultDeps(): Promise<BrandIdentityRefreshDeps> {
  const [{ researchBrand }, { fetchOwnSiteImagery }] = await Promise.all([
    import("../skills/researchBrand.js"), import("../lib/ownSiteImagery.js"),
  ]);
  return { research: researchBrand, ownSite: (d) => fetchOwnSiteImagery(d), searchSite: liveSearchSite, logoFor: (d, name) => assessLogo(d, name) };
}

/** What a name search returns: the domain (or null), and — from the verified search — how it was checked and what it cost. */
export interface SiteSearchResult {
  domain: string | null;
  source?: BrandCandidate["source"];
  confidence?: BrandCandidate["confidence"];
  evidence?: string | null;
  costMicroUsd?: number;
}

/**
 * The live name search: the verified OpenAI web search (lib/brandSiteSearch) when OpenAI is configured; else the
 * earlier Gemini grounding search, which keeps its own "a grounding source sits on the domain" check.
 */
async function liveSearchSite(name: string): Promise<SiteSearchResult> {
  if (process.env.OPENAI_API_KEY) {
    const { findOfficialSite } = await import("./brandSiteSearchModel.js");
    try {
      const r = await findOfficialSite(name);
      if (!r.domain) logger.info({ name, evidence: r.evidence }, "brand site search: nothing verified");
      return { domain: r.domain, source: r.source, confidence: r.confidence, evidence: r.evidence, costMicroUsd: r.costMicroUsd };
    } catch (err: any) {
      logger.warn({ name, error: err?.message }, "brand site search failed; nothing proposed");
      return { domain: null, evidence: "search failed" };
    }
  }
  const { searchOfficialSite } = await import("../skills/researchBrand.js");
  const r = await searchOfficialSite(name);
  return { domain: r.domain, source: "name_search" };
}

export interface BrandIdentityRefreshOutcome {
  brandId: number;
  outcome: "done" | "no_brand" | "agency" | "gate_off" | "no_domain";
  domain: string | null;
  fill: FillResult | null;
  research: "ran" | "capped" | "none";
  identity: "confirmed" | "unconfirmed" | null;
  imagery: "stored" | "no_cover" | "recent" | "not_trusted" | "none";
  lookup: "found" | "not_found" | "recent" | "none";
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

/** Write own-site imagery: the own_site record always; the cover and logo only where the row has none (or a floor). */
async function storeOwnSite(row: BrandRow, r: OwnSiteResult, basis: OwnSiteImagery["basis"], now: Date): Promise<void> {
  const own: OwnSiteImagery = { source: "own_site", domain: r.domain, cover: r.cover, logo_url: r.logoUrl, basis, fetched_at: now.toISOString() };
  const set: Record<string, unknown> = {
    enrichment: sql`coalesce(${inboxBrands.enrichment}, '{}'::jsonb) || ${JSON.stringify({ own_site: own })}::jsonb`,
  };
  if (r.cover && !row.image_url) {
    set.image_url = r.cover;
    if (!Array.isArray(row.images) || !row.images.length) set.images = [r.cover];
  }
  // A real logo replaces the favicon floor; nothing replaces a logo that is already real.
  const floor = !row.logo_url || isDeadLogoUrl(row.logo_url) || /google\.com\/s2\/favicons/i.test(row.logo_url);
  if (floor && r.logoUrl !== row.logo_url && (r.logoSource === "yoku" || !row.logo_url || isDeadLogoUrl(row.logo_url))) set.logo_url = r.logoUrl;
  await db.update(inboxBrands).set(set as any).where(eq(inboxBrands.id, row.id));
}

/** The name search on its own (the backfill's entry; the job runs it for a domain-less row asked with `lookup`). */
export async function lookupBrandCandidate(
  brandId: number,
  opts: { now?: Date; deps?: BrandIdentityRefreshDeps; /** A one-off backfill may ignore the per-brand window. */ force?: boolean; onResult?: (r: SiteSearchResult) => void } = {},
): Promise<BrandIdentityRefreshOutcome["lookup"]> {
  const row = await loadBrand(brandId);
  if (!row || row.is_agency || brandDomainFromInput(row.domain ?? null)) return "none";
  return lookupCandidate(row, opts.deps ?? (await defaultDeps()), opts.now ?? new Date(), { force: opts.force, onResult: opts.onResult });
}

async function lookupCandidate(
  row: BrandRow, deps: BrandIdentityRefreshDeps, now: Date, opts: { force?: boolean; onResult?: (r: SiteSearchResult) => void } = {},
): Promise<BrandIdentityRefreshOutcome["lookup"]> {
  if (!opts.force && now.getTime() - ms(readCandidateLookupAt(row.enrichment)) < BRAND_RESEARCH_CAP_DAYS * DAY_MS) return "recent";
  const found = await deps.searchSite(row.name);
  opts.onResult?.(found);
  let domain = brandDomainFromInput(found.domain ?? null);
  if (domain) {
    // A domain another row holds is a merge question, not something to offer her.
    const [owner] = await db.select({ id: inboxBrands.id }).from(inboxBrands).where(and(eq(inboxBrands.domain, domain), ne(inboxBrands.id, row.id))).limit(1);
    if (owner) domain = null;
  }
  const patch: Record<string, unknown> = {
    candidate_lookup: { at: now.toISOString(), found: !!domain, ...(found.evidence ? { evidence: found.evidence.slice(0, 300) } : {}) },
  };
  if (domain) {
    const assessed: LogoAssessment = await deps.logoFor(domain, row.name).catch(() => ({ url: null, source: null, reason: "unreachable" }));
    const logo_url = assessed.url;
    patch.logo_check = logoCheckOf(domain, assessed, now);
    patch.candidate = {
      domain, name: row.name, source: found.source ?? "name_search", proposed_at: now.toISOString(), logo_url,
      ...(found.confidence ? { confidence: found.confidence } : {}), ...(found.evidence ? { evidence: found.evidence.slice(0, 200) } : {}),
    } satisfies BrandCandidate;
  }
  await db.update(inboxBrands).set({ enrichment: sql`coalesce(${inboxBrands.enrichment}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` } as any)
    .where(eq(inboxBrands.id, row.id));
  return domain ? "found" : "not_found";
}

export async function runBrandIdentityRefresh(
  input: BrandIdentityRefreshInput,
  opts: { now?: Date; deps?: BrandIdentityRefreshDeps } = {},
): Promise<BrandIdentityRefreshOutcome> {
  const now = opts.now ?? new Date();
  const base: BrandIdentityRefreshOutcome = { brandId: input.brandId, outcome: "done", domain: null, fill: null, research: "none", identity: null, imagery: "none", lookup: "none" };
  if (!brandIdentityGateEnabled()) return { ...base, outcome: "gate_off" };
  let row = await loadBrand(input.brandId);
  if (!row) return { ...base, outcome: "no_brand" };
  if (row.is_agency) return { ...base, outcome: "agency" };
  const deps = opts.deps ?? (await defaultDeps());

  if (input.domain) {
    base.fill = await fillBrandDomain(row.id, input.domain);
    row = (await loadBrand(row.id))!;
  }
  let d = brandDomainFromInput(row.domain ?? null);
  // Imported late: brandConfirmation imports this module (fillBrandDomain), so a top-level import would be a cycle.
  const settle = async (): Promise<boolean> => {
    const { autoConfirmBrand } = await import("./brandConfirmation");
    return (await autoConfirmBrand(row!.id, now).catch(() => null))?.confirmed === true;
  };
  if (!d) {
    const lookup = input.lookup ? await lookupCandidate(row, deps, now) : "none";
    // A verified site under the brand's own name settles who it is without asking her (the domain is filled); research
    // then runs on that domain in this same run. Anything weaker stays a candidate for her tap.
    // The stored candidate counts too (a lookup inside its cap window answers "recent", not "found").
    if (!(await settle())) return { ...base, outcome: "no_domain", lookup };
    row = (await loadBrand(row.id))!;
    d = brandDomainFromInput(row.domain ?? null);
    base.lookup = lookup;
    if (!d) return { ...base, outcome: "no_domain" };
  } else if (!identitySettled(row.enrichment)) {
    // A domain from the brand's own email settles who it is the same way (a no-op when the evidence is weak).
    if (await settle()) row = (await loadBrand(row.id))!;
  }
  base.domain = d;

  // 2. research, capped.
  const id = readIdentity(row.enrichment);
  const her = readAthleteConfirmed(row.enrichment);
  const sys = readSystemConfirmed(row.enrichment);
  // Confirmed since research last looked (by her tap or by the system): research runs again whatever the cap says.
  const newlyConfirmed = (!!her && her.domain === d && ms(her.at) > ms(id?.checked_at))
    || (!!sys && sys.domain === d && ms(sys.at) > ms(id?.checked_at));
  const searchedRecently = !!id && id.domain === d && id.basis !== "no_domain_evidence" && now.getTime() - ms(id.checked_at) < BRAND_RESEARCH_CAP_DAYS * DAY_MS;
  if (!searchedRecently || newlyConfirmed) {
    await deps.research(row.id, row.name, d, { force: true, now });
    base.research = "ran";
    row = (await loadBrand(row.id))!;
  } else {
    base.research = "capped";
  }
  base.identity = readIdentity(row.enrichment)?.status ?? null;

  // 3. own-site imagery, for a trusted domain only.
  const basis = ownSiteBasis(row);
  if (!basis) return { ...base, imagery: "not_trusted" };
  const own = readOwnSite(row.enrichment);
  if (own && own.domain === d && !newlyConfirmed && now.getTime() - ms(own.fetched_at) < BRAND_RESEARCH_CAP_DAYS * DAY_MS) return { ...base, imagery: "recent" };
  const got = await deps.ownSite(d);
  if (!got) return { ...base, imagery: "none" };
  await storeOwnSite(row, got, basis, now);
  return { ...base, imagery: got.cover ? "stored" : "no_cover" };
}
