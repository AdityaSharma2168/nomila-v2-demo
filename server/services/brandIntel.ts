/**
 * brandIntel.ts — the shared Brand Intelligence acquisition layer (Spec 9).
 *
 * ONE dedup/reuse entry point for a brand profile so it is researched ONCE and
 * consumed many times (deal scoring · per-brand card tailoring · the Opportunities
 * bridge all read the SAME `inbox_brands` row). Nothing here re-implements deal
 * ingestion — it wraps `resolveBrand`-style lookup + `researchBrand` enrichment
 * behind a single call and adds SELECTIVITY (only real advertisers) and FRESHNESS
 * (a staleness window + a bounded refresh cron for pipeline brands only).
 *
 * Two callers converge here:
 *   (a) the deal path — a deal arrives → reuse if we already hold it, research if new;
 *   (b) the card path — an athlete picks a brand we don't have → create + research.
 * Never research a brand we already hold fresh; never research junk/agency/person rows.
 */

import { db } from "../db";
import { inboxBrands, inboxThreads, inboxSenders } from "../../shared/schema";
import { and, eq, or, isNull, isNotNull, lt, inArray } from "drizzle-orm";
import { normalizeBrand } from "../lib/brandResolver";
import { googleFaviconUrl } from "../lib/brandLogoSources";
import { researchBrand } from "../skills/researchBrand";
import { createLogger } from "../logger";
import { brandIdentityGateEnabled, identityNeedsCheck } from "../lib/brandIdentity";

const logger = createLogger("services/brandIntel");

/**
 * Staleness window for a brand profile. Shorter than researchBrand's own 90-day
 * self-guard on purpose: brands shift (new campaigns, focus) faster than we want
 * to leave a card tailored on stale intel. This module OWNS the freshness call and
 * passes force:true into researchBrand once it has decided a row is stale.
 */
export const STALE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The shared brand profile row — the single source of truth every consumer reads. */
export type BrandProfile = typeof inboxBrands.$inferSelect;

export interface GetOrResearchOptions {
  /**
   * The brand was EXPLICITLY picked by an athlete (card-tailoring path). Explicit
   * demand overrides the "must have a domain or a pipeline link" selectivity gate —
   * but never overrides the is_agency exclusion.
   */
  athletePicked?: boolean;
  /** Force a re-research even if the row is still fresh (rarely needed). */
  force?: boolean;
}

function isStale(profile: Pick<BrandProfile, "enriched_at" | "domain" | "enrichment">): boolean {
  if (!profile.enriched_at) return true;
  // BRAND_IDENTITY_GATE: a profile never identity-checked, or checked against a domain we no longer
  // hold, is re-researched the next time it is touched — that is how stored research gets re-checked.
  if (brandIdentityGateEnabled() && identityNeedsCheck(profile)) return true;
  return Date.now() - new Date(profile.enriched_at).getTime() > STALE_DAYS * DAY_MS;
}

/** Does this brand have a real pipeline link (a thread or a sender attributed to it)? */
async function hasPipelineLink(brandId: number): Promise<boolean> {
  const [thread] = await db
    .select({ id: inboxThreads.id })
    .from(inboxThreads)
    .where(eq(inboxThreads.brand_id, brandId))
    .limit(1);
  if (thread) return true;
  const [sender] = await db
    .select({ id: inboxSenders.id })
    .from(inboxSenders)
    .where(eq(inboxSenders.brand_id, brandId))
    .limit(1);
  return !!sender;
}

/**
 * SELECTIVITY gate (Spec 9): research is demand-driven, never a blanket scan.
 * Enrich only (a) real advertisers — is_agency=false AND (has a domain OR a real
 * deal/thread) — OR (b) an explicitly athlete-picked brand. Agency/junk/person rows
 * (no domain, no pipeline, not picked) are never auto-researched.
 */
async function isResearchable(profile: BrandProfile, opts: GetOrResearchOptions): Promise<boolean> {
  if (profile.is_agency) return false;              // agencies are never advertisers
  if (opts.athletePicked) return true;              // explicit demand
  if (profile.domain) return true;                  // real advertiser with a domain
  return hasPipelineLink(profile.id);               // else needs a real deal/thread
}

async function findByNormalizedName(normalized: string): Promise<BrandProfile | null> {
  if (!normalized) return null;
  const [row] = await db
    .select()
    .from(inboxBrands)
    .where(eq(inboxBrands.normalized_name, normalized))
    .limit(1);
  return row ?? null;
}

async function findByDomain(domain: string): Promise<BrandProfile | null> {
  const [row] = await db
    .select()
    .from(inboxBrands)
    .where(eq(inboxBrands.domain, domain))
    .limit(1);
  return row ?? null;
}

async function reload(brandId: number): Promise<BrandProfile | null> {
  const [row] = await db.select().from(inboxBrands).where(eq(inboxBrands.id, brandId)).limit(1);
  return row ?? null;
}

/**
 * getOrResearchBrand — the single dedup/reuse entry point for a brand profile.
 *
 * - Normalizes the name (shared `normalizeBrand` key) and looks the brand up by
 *   normalized_name and/or domain.
 * - Fresh + enriched hit  → returns it, NO research.
 * - Exists but stale/never-enriched → re-researches (if researchable), returns fresh.
 * - New → inserts the row, then researches (if researchable).
 * - Junk (agency / no domain / no pipeline / not picked) → row is returned as-is,
 *   never researched.
 *
 * @returns `{ brandId, profile }`, or `null` if there was nothing to key on.
 */
export async function getOrResearchBrand(
  name: string,
  domain?: string | null,
  opts: GetOrResearchOptions = {},
): Promise<{ brandId: number; profile: BrandProfile } | null> {
  const cleanName = name?.trim() || null;
  const cleanDomain = domain?.toLowerCase().trim() || null;
  if (!cleanName && !cleanDomain) return null;

  const normalized = normalizeBrand(cleanName ?? cleanDomain!);

  // ── 1. Dedup lookup — domain first (canonical), then normalized name ────────
  let profile =
    (cleanDomain ? await findByDomain(cleanDomain) : null) ??
    (normalized ? await findByNormalizedName(normalized) : null);

  // ── 2. New brand → insert a minimal row (mirrors resolveBrand strategy 4) ───
  if (!profile) {
    const insertName = cleanName ?? cleanDomain!;
    // The favicon floor (lib/brandLogoSources): Clearbit is dead, and backfillBrandLogos upgrades a row to Yoku later.
    const logoUrl = cleanDomain ? googleFaviconUrl(cleanDomain) : null;
    try {
      const [inserted] = await db
        .insert(inboxBrands)
        .values({ normalized_name: normalized, domain: cleanDomain, name: insertName, logo_url: logoUrl })
        .onConflictDoUpdate({
          target: inboxBrands.normalized_name,
          set: { name: insertName, ...(cleanDomain ? { domain: cleanDomain } : {}) },
        })
        .returning();
      profile = inserted;
    } catch (err: any) {
      logger.error({ err: err.message, name: insertName, domain: cleanDomain }, "brand insert failed");
      return null;
    }
  }

  // ── 3. Reuse if fresh — the whole point: never re-research a brand we hold ──
  if (!opts.force && profile.enriched_at && !isStale(profile)) {
    logger.debug({ brandId: profile.id, name: profile.name }, "brand fresh — reusing profile");
    return { brandId: profile.id, profile };
  }

  // ── 4. Selectivity gate — only research real, demanded advertisers ──────────
  if (!(await isResearchable(profile, opts))) {
    logger.debug({ brandId: profile.id, name: profile.name, is_agency: profile.is_agency }, "brand not researchable — returning as-is");
    return { brandId: profile.id, profile };
  }

  // ── 5. Research (new / stale) — force so researchBrand's own guard defers to us
  logger.info({ brandId: profile.id, name: profile.name, stale: isStale(profile) }, "researching brand");
  try {
    await researchBrand(profile.id, profile.name, profile.domain ?? "", { force: true });
  } catch (err: any) {
    logger.warn({ brandId: profile.id, err: err.message }, "researchBrand threw");
  }

  const refreshed = await reload(profile.id);
  return { brandId: profile.id, profile: refreshed ?? profile };
}

/**
 * Bounded re-research of STALE + PIPELINE brands only (the brand-refresh cron worker).
 * Pipeline = has an attributed thread or sender; is_agency rows are skipped. Junk
 * inbox brands (no pipeline link) are never touched. Ordered/limited so a single
 * cron tick is bounded; the next tick picks up the rest.
 */
export async function refreshStaleBrands(
  opts: { limit?: number; staleDays?: number } = {},
): Promise<{ scanned: number; refreshed: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 200));
  const staleDays = opts.staleDays ?? STALE_DAYS;
  const cutoff = new Date(Date.now() - staleDays * DAY_MS);

  // Pipeline brand ids = those referenced by a thread OR a sender.
  const [threadRows, senderRows] = await Promise.all([
    db.selectDistinct({ id: inboxThreads.brand_id }).from(inboxThreads).where(isNotNull(inboxThreads.brand_id)),
    db.selectDistinct({ id: inboxSenders.brand_id }).from(inboxSenders).where(isNotNull(inboxSenders.brand_id)),
  ]);
  const pipelineIds = [
    ...new Set([...threadRows, ...senderRows].map((r) => r.id).filter((x): x is number => x != null)),
  ];
  if (pipelineIds.length === 0) return { scanned: 0, refreshed: 0 };

  const candidates = await db
    .select()
    .from(inboxBrands)
    .where(
      and(
        inArray(inboxBrands.id, pipelineIds),
        or(eq(inboxBrands.is_agency, false), isNull(inboxBrands.is_agency)),      // skip agencies
        or(isNull(inboxBrands.enriched_at), lt(inboxBrands.enriched_at, cutoff)),  // stale / never enriched
      ),
    )
    .limit(limit);

  let refreshed = 0;
  for (const b of candidates) {
    try {
      await researchBrand(b.id, b.name, b.domain ?? "", { force: true });
      refreshed++;
    } catch (err: any) {
      logger.warn({ brandId: b.id, err: err.message }, "brand-refresh: researchBrand threw");
    }
  }
  logger.info({ scanned: candidates.length, refreshed, pipeline: pipelineIds.length }, "brand-refresh cron complete");
  return { scanned: candidates.length, refreshed };
}
