/**
 * athleteKnowledge.ts — the Concept 0.4 Slice 1 read models: "What Nomila Knows" and the Me identity header.
 *
 * Reads the Canonical Athlete Context builder DIRECTLY (not through CANONICAL_CONTEXT_READERS), so no existing reader or
 * screen changes. Small extra reads: the public URLs behind Fact.evidenceIds (cited, non-suspect
 * research_evidence), the latest CONNECTED follower counts, and the brands of inbox-accepted deals (names only). Never athletes_current, never story_arc, never the ledger's
 * legacy score. The Me header's M.I.A. slot comes from the My Intelligence read model (Slice 2).
 *
 * knowledge/3 (Concept 0.4 PR 4) adds: the affiliation facts behind `found` ledger rows (a row without one is legacy and
 * not shown), her disputes / confirmations (tier + "This isn't right"), the source type and category of cited evidence
 * (academic honours; logo domains), and brand domains for logos (presentation only). The ONE write here is her dispute
 * (`disputeKnowledgeEntry`), through the existing assertion writer.
 */

import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { athleteAffiliations, athleteAsserted, athleteFacts, deals, inboxBrands, researchEvidence, socialAnalyticsSnapshots } from "../../shared/schema";
import { buildCanonicalContext, type BuiltContext } from "./intelligence/context";
import { CITED_LINEAGES } from "./intelligence/research/registries";
import { EARNED_STATUSES } from "./snapshotDeals";
import { buildMyIntelligence, myIntelligenceEntry } from "./intelligence/views/myIntelligence";
import { fromLedgerValue, recordAssertions } from "../mila/onboarding";
import { parseBasisRef, refKey } from "./intelligence/identityIntelligence/contract";
import {
  brandProfileFrom, knowledgeEntries, knowledgeView, meOverview,
  type AffiliationFactInfo, type AthleteKnowledge, type BrandProfile, type DisputeNote, type EvidenceLink, type KnowledgeExtras, type KnowledgeVerdicts, type MeOverview,
} from "./intelligence/context/views/knowledge";

/** Where the inbox pipeline records a deal it mined from her email (dealDetector writes `source: "inbox_scan"`). */
export const INBOX_SOURCE = "inbox_scan" as const;

/**
 * Brands with an accepted/completed deal the INBOX pipeline found — names only, never amounts. Concept 0.4 only:
 * `status` reached 'accepted' because threadSummarizer read a signature in a thread, not because she confirmed it,
 * so this list is shown to HER labelled "From your inbox" and never feeds the deck (confirmedPartnersFor is untouched).
 * One name per brand (trimmed, case-insensitive), in the spelling of the first row seen; the view drops brands she
 * also confirmed.
 */
export async function inboxAcceptedPartnersFor(athleteId: string): Promise<string[]> {
  try {
    const rows = await db.select({ brand: deals.brand_name }).from(deals)
      .where(and(eq(deals.athlete_id, athleteId), inArray(deals.status, EARNED_STATUSES as unknown as string[]), eq(deals.source, INBOX_SOURCE)))
      .orderBy(sql`${deals.amount} DESC NULLS LAST`, deals.created_at);   // biggest first, for order only
    const seen = new Map<string, string>();
    for (const r of rows) { const name = (r.brand ?? "").trim(); const k = name.toLowerCase(); if (name && !seen.has(k)) seen.set(k, name); }
    return [...seen.values()];
  } catch {
    return [];
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * knowledge/3: the affiliation facts behind her `found` ledger rows (athlete_affiliations.fact_id, the 2d-6 sync). A found
 * row with no live fact is legacy and the view drops it. Read here because listAffiliations deliberately selects no sync
 * bookkeeping, and every other reader of it stays unchanged.
 */
export async function affiliationFactsFor(athleteId: string): Promise<Map<string, AffiliationFactInfo>> {
  const rows = await db.select({ rowId: athleteAffiliations.id, factId: athleteAffiliations.fact_id }).from(athleteAffiliations)
    .where(and(eq(athleteAffiliations.athlete_id, athleteId), eq(athleteAffiliations.kind, "found"), isNotNull(athleteAffiliations.fact_id)));
  const factIds = [...new Set(rows.map((r) => r.factId).filter((x): x is string => !!x))];
  if (!factIds.length) return new Map();
  const facts = await db.select({ id: athleteFacts.id, value: athleteFacts.value, status: athleteFacts.status, tier: athleteFacts.authority_tier, provenance: athleteFacts.provenance }).from(athleteFacts)
    .where(and(eq(athleteFacts.athlete_id, athleteId), inArray(athleteFacts.id, factIds)));
  const byId = new Map(facts.map((f) => [f.id, f]));
  const out = new Map<string, AffiliationFactInfo>();
  for (const r of rows) {
    const f = r.factId ? byId.get(r.factId) : undefined;
    // A fact since superseded no longer backs the row: the row is then as untraceable as a legacy one.
    if (!f || !["current", "historical", "disputed"].includes(f.status)) continue;
    const v = (f.value ?? {}) as { org?: unknown; roleSeason?: unknown };
    const p = (f.provenance ?? {}) as { evidenceIds?: unknown[]; domains?: unknown[] };
    out.set(r.rowId, {
      factId: f.id, org: typeof v.org === "string" ? v.org : "", status: f.status as AffiliationFactInfo["status"], authorityTier: f.tier ?? null,
      evidenceIds: (p.evidenceIds ?? []).filter((x): x is string => typeof x === "string"), domains: (p.domains ?? []).filter((x): x is string => typeof x === "string"),
      roleSeason: typeof v.roleSeason === "number" ? v.roleSeason : null,
    });
  }
  return out;
}

/** knowledge/3: her live "This isn't right" disputes and claim confirmations (athlete_asserted governance rows). */
export async function knowledgeVerdictsFor(athleteId: string): Promise<KnowledgeVerdicts> {
  const rows = await db.select({ field: athleteAsserted.field, value: athleteAsserted.value, said: athleteAsserted.said, at: athleteAsserted.created_at }).from(athleteAsserted)
    .where(and(eq(athleteAsserted.athlete_id, athleteId), inArray(athleteAsserted.field, ["dispute", "claim_confirmation"]), isNull(athleteAsserted.retracted_at), isNull(athleteAsserted.superseded_by)))
    .orderBy(desc(athleteAsserted.created_at));
  const denied = new Set<string>(), confirmed = new Set<string>();
  const refDisputes = new Map<string, DisputeNote>(), entryDisputes = new Map<string, DisputeNote>();
  for (const r of rows) {
    const v = fromLedgerValue(r.field as "dispute" | "claim_confirmation", r.value) as unknown as Record<string, unknown> | null;
    if (!v) continue;
    const note: DisputeNote = { said: (typeof v.said === "string" && v.said) || r.said || null, at: r.at ? r.at.toISOString() : null };
    if (r.field === "claim_confirmation") {
      const ref = parseBasisRef(v.ref);
      if (ref) (v.answer === "no" ? denied : confirmed).add(refKey(ref));
      continue;
    }
    if (typeof v.entryRef === "string") { if (!entryDisputes.has(v.entryRef)) entryDisputes.set(v.entryRef, note); continue; }
    const ref = parseBasisRef(v.entryRef);
    if (ref) { const k = refKey(ref); denied.add(k); if (!refDisputes.has(k)) refDisputes.set(k, note); }
  }
  for (const k of denied) confirmed.delete(k);   // denial outranks confirmation (Part B precedence)
  return { denied, confirmed, refDisputes, entryDisputes };
}

/**
 * knowledge/3, PRESENTATION ONLY: what inbox_brands knows about the brands this view names, for their logos — the domain
 * (→ a favicon on the client) and the stored logo_url brand research set (Yoku when verified, else the favicon; a dead
 * Clearbit URL is still served and rejected on the client). Never authority, tier or order.
 *
 * (Density pass, Oct 2026) ADDITIVELY, `profiles`: the row's id and its brand research (category, description, audience,
 * sports, known athlete partnerships, cover + images), as stored, for the brand deck in What Nomila Knows. The row filter
 * is widened to any matching row so a brand with research but no logo still carries its profile; `domains` and
 * `logoUrls` are unchanged (only set from non-null columns, as before).
 */
export async function brandDomainsFor(names: string[]): Promise<{ domains: Map<string, string>; logoUrls: Map<string, string>; profiles: Map<string, { brandId: number; profile: BrandProfile | null }> }> {
  const keys = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))].slice(0, 200);
  const domains = new Map<string, string>(); const logoUrls = new Map<string, string>();
  const profiles = new Map<string, { brandId: number; profile: BrandProfile | null }>();
  if (!keys.length) return { domains, logoUrls, profiles };
  try {
    const list = sql.join(keys.map((k) => sql`${k}`), sql`, `);
    const rows = await db.select({
      id: inboxBrands.id, name: inboxBrands.name, normalized: inboxBrands.normalized_name, domain: inboxBrands.domain, logoUrl: inboxBrands.logo_url,
      category: inboxBrands.category, description: inboxBrands.description, audience_summary: inboxBrands.audience_summary, sport_categories: inboxBrands.sport_categories,
      known_athlete_partnerships: inboxBrands.known_athlete_partnerships, image_url: inboxBrands.image_url, images: inboxBrands.images,
      sources: sql<unknown>`${inboxBrands.enrichment}->'sources'`,
    }).from(inboxBrands)
      .where(sql`(lower(${inboxBrands.name}) IN (${list}) OR lower(${inboxBrands.normalized_name}) IN (${list}))`);
    for (const r of rows) {
      for (const k of [r.name?.trim().toLowerCase(), r.normalized?.trim().toLowerCase()]) {
        if (!k) continue;
        if (r.domain && !domains.has(k)) domains.set(k, r.domain);
        if (r.logoUrl && !logoUrls.has(k)) logoUrls.set(k, r.logoUrl);
        if (!profiles.has(k)) profiles.set(k, { brandId: r.id, profile: brandProfileFrom(r) });
      }
    }
    return { domains, logoUrls, profiles };
  } catch {
    return { domains, logoUrls, profiles };
  }
}

export async function readKnowledgeExtras(b: BuiltContext): Promise<KnowledgeExtras> {
  const { ctx } = b;
  const reg = ctx.registryFacts;
  const [affiliationFacts, verdicts] = await Promise.all([affiliationFactsFor(ctx.athleteId), knowledgeVerdictsFor(ctx.athleteId)]);
  const facts = [ctx.identity.sport, ctx.identity.hometown, ctx.profile.position, ctx.profile.classYear, ctx.profile.graduationYear, ...ctx.identity.nationality, ...ctx.achievements,
    ...(reg ? [...reg.rankings, ...reg.nationalTeam, ...reg.seasonStatistics, ...reg.endorsements, ...(reg.education ?? [])] : [])];
  const ids = [...new Set([...facts.flatMap((f) => f?.evidenceIds ?? []), ...[...affiliationFacts.values()].flatMap((a) => a.evidenceIds)])].filter((id) => UUID.test(id)).slice(0, 300);
  const brands = [...ctx.commercial.confirmedPartners, ...ctx.brandMentions.map((m) => m.value.brand), ...(reg?.endorsements ?? []).map((e) => e.value.brand)];
  const [ev, snaps, inboxPartners] = await Promise.all([
    ids.length
      ? db.select({ id: researchEvidence.id, url: researchEvidence.source_url, domain: researchEvidence.source_domain, sourceType: researchEvidence.source_type, category: sql<string | null>`${researchEvidence.claim}->>'category'` }).from(researchEvidence)
        .where(and(eq(researchEvidence.athlete_id, ctx.athleteId), inArray(researchEvidence.id, ids), eq(researchEvidence.suspect, false), inArray(researchEvidence.lineage_status, [...CITED_LINEAGES])))
      : Promise.resolve([] as Array<{ id: string; url: string | null; domain: string | null; sourceType: string | null; category: string | null }>),
    db.select({ platform: socialAnalyticsSnapshots.platform, followers: socialAnalyticsSnapshots.followers, day: socialAnalyticsSnapshots.snapshot_date }).from(socialAnalyticsSnapshots)
      .where(and(eq(socialAnalyticsSnapshots.athlete_id, ctx.athleteId), eq(socialAnalyticsSnapshots.source, "connected")))
      .orderBy(desc(socialAnalyticsSnapshots.snapshot_date)).limit(12),
    inboxAcceptedPartnersFor(ctx.athleteId),
  ]);
  const evidenceUrls = new Map<string, EvidenceLink>();
  for (const e of ev) if (e.url && /^https?:\/\//i.test(e.url)) evidenceUrls.set(e.id, { url: e.url, domain: e.domain ?? null, sourceType: e.sourceType ?? null, category: e.category ?? null });
  const latest = new Map<string, { platform: string; followers: number | null; day: string | null }>();
  for (const s of snaps) if (!latest.has(s.platform)) latest.set(s.platform, { platform: s.platform, followers: s.followers ?? null, day: s.day ? String(s.day) : null });
  const brandLogos = await brandDomainsFor([...brands, ...inboxPartners]);
  return { evidenceUrls, followers: [...latest.values()], inboxPartners, affiliationFacts, brandDomains: brandLogos.domains, brandLogoUrls: brandLogos.logoUrls, brandProfiles: brandLogos.profiles, verdicts };
}

export async function getAthleteKnowledge(athleteId: string): Promise<AthleteKnowledge | null> {
  const built = await buildCanonicalContext(athleteId);
  if (!built) return null;
  return knowledgeView(built, await readKnowledgeExtras(built));
}

/**
 * The Me header. Its `intelligence` slot (Concept 0.4 Slice 2, O-10) is myIntelligenceEntry() over the SAME
 * buildMyIntelligence() the My Intelligence page serves, so Me can never show a score the page withholds (O-6).
 */
export async function getMeOverview(athleteId: string): Promise<MeOverview | null> {
  const k = await getAthleteKnowledge(athleteId);
  if (!k) return null;
  return meOverview(k, myIntelligenceEntry(await buildMyIntelligence(athleteId)));
}

// ─── "This isn't right" (POST /me/knowledge/disputes) ──────────────────────────

export type DisputeOutcome =
  | { ok: true; entryId: string; assertedId: string; target: string }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Her dispute of one knowledge entry, written as an athlete_asserted `dispute` row through the EXISTING assertion writer
 * (recordAssertions → sanitizeDispute; one live row per target; a reversible receipt). The entry is looked up in HER
 * knowledge view — 404 otherwise, so tenancy and existence are one check. Its target is the fact / evidence row behind
 * the entry when there is one (so Identity Intelligence's envelope reads the same denial), else the entry id. No
 * intelligence recompute here.
 */
export async function disputeKnowledgeEntry(athleteId: string, entryId: string, said?: string | null): Promise<DisputeOutcome> {
  const k = await getAthleteKnowledge(athleteId);
  if (!k) return { ok: false, status: 404, error: "Athlete not found" };
  const e = knowledgeEntries(k).find((x) => x.id === entryId);
  if (!e) return { ok: false, status: 404, error: "Entry not found" };
  if (e.state !== "present") return { ok: false, status: 409, error: "Nothing on record to dispute" };
  const words = typeof said === "string" ? said.replace(/\s+/g, " ").trim().slice(0, 280) : "";
  const entryRef = e.ref ?? e.id;
  const [saved] = await recordAssertions({
    athleteId, runId: null, mode: "form", source: "settings",
    corrections: [{ field: "dispute", value: { entryRef, ...(words ? { said: words } : {}) } as any, ...(words ? { said: words } : {}) }],
  });
  return { ok: true, entryId, assertedId: saved.asserted_id, target: typeof entryRef === "string" ? `entry:${entryRef}` : refKey(entryRef) };
}
