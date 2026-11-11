/**
 * brandConfirmation.ts — "Confirm this is [brand]" (the PR 4 tap), as services. HER act about a brand on one of
 * HER opportunities; nothing here accepts a brand outside that scope.
 *
 *   getBrandCandidate      what research proposes (name, domain, logo) — read-only, plus, when there is nothing to
 *                          offer and no domain anywhere, a background name-search lookup (capped per brand)
 *   confirmBrand           her tap: a governed assertion (athlete_asserted, field "brand_identity", verdict confirmed,
 *                          with provenance), the domain set on the row by the fill rule, her confirmation recorded on
 *                          the row (enrichment.athlete_confirmed), and the brand_identity_refresh job requested
 *   rejectBrandCandidate   "not this": the same assertion with verdict not_this; that domain is never offered to her
 *                          again for that brand, and a confirmation she made of it is withdrawn
 *
 * A statement supersedes her earlier live statements about the same brand and domain (and a confirmation supersedes
 * any earlier confirmation of the brand: one confirmed domain per brand). Her statement is never a fact about HER:
 * the field is outside ASSERTED_FIELDS, so My Story, the record and Mila's prompt facts do not read it, and State
 * types it `none`.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { athleteAsserted, inboxBrands, inboxThreads, opportunities } from "../../shared/schema";
import { createLogger } from "../logger";
import {
  brandDomainFromInput, brandIdentityGateEnabled, identitySettled, readAthleteConfirmed, readCandidate, readCandidateLookupAt, readIdentity,
  readOwnSite, readSystemConfirmed, strongSiteMatch, type SystemConfirmed,
} from "../lib/brandIdentity";
import { googleFaviconUrl } from "../lib/brandLogoSources";
import { BRAND_RESEARCH_CAP_DAYS, fillBrandDomain, requestBrandIdentityRefresh } from "./brandIdentityRefresh";

const logger = createLogger("services/brand-confirmation");

export const BRAND_IDENTITY_FIELD = "brand_identity";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BrandStatementValue {
  brand_id: number;
  domain: string;
  verdict: "confirmed" | "not_this";
  /** What she was shown when she answered: where the domain came from. */
  provenance: { surface: "confirm_brand"; candidate_basis: CandidateBasis | "her_entry" };
}

export type CandidateBasis = "research_confirmed" | "mail_evidence" | "name_search";

type BrandRow = typeof inboxBrands.$inferSelect;

/** The brand row, only when it is the brand of one of HER opportunities. */
export async function herBrand(athleteId: string, brandId: number): Promise<BrandRow | null> {
  if (!Number.isInteger(brandId) || brandId <= 0) return null;
  const [opp] = await db.select({ id: opportunities.id }).from(opportunities)
    .where(and(eq(opportunities.athlete_id, athleteId), eq(opportunities.brand_id, brandId))).limit(1);
  if (!opp) return null;
  const [row] = await db.select().from(inboxBrands).where(eq(inboxBrands.id, brandId)).limit(1);
  return row ?? null;
}

interface Statement { id: string; value: BrandStatementValue; created_at: Date | null }

async function liveStatements(athleteId: string, brandId: number): Promise<Statement[]> {
  const rows = await db.select({ id: athleteAsserted.id, value: athleteAsserted.value, created_at: athleteAsserted.created_at }).from(athleteAsserted)
    .where(and(eq(athleteAsserted.athlete_id, athleteId), eq(athleteAsserted.field, BRAND_IDENTITY_FIELD),
      isNull(athleteAsserted.retracted_at), isNull(athleteAsserted.superseded_by),
      sql`${athleteAsserted.value}->>'brand_id' = ${String(brandId)}`))
    .orderBy(desc(athleteAsserted.created_at));
  return rows as Statement[];
}

export interface CandidateView {
  brandId: number;
  name: string;
  /** confirmed_by_you: she already answered; candidate: something to confirm; none: nothing yet. */
  status: "confirmed_by_you" | "candidate" | "none";
  candidate: { name: string; domain: string; logoUrl: string; basis: CandidateBasis } | null;
  confirmed: { domain: string; at: string | null } | null;
  /** The research identity verdict for the row's own domain, as stored. */
  researchIdentity: "confirmed" | "unconfirmed" | null;
  /** started: a background lookup was asked for now; recent: one ran inside the cap; not_needed: nothing to look up. */
  lookup: "started" | "recent" | "not_needed" | "off";
}

export async function getBrandCandidate(athleteId: string, brandId: number, now: Date = new Date()): Promise<CandidateView | null> {
  const row = await herBrand(athleteId, brandId);
  if (!row) return null;
  const statements = await liveStatements(athleteId, brandId);
  const confirmedSt = statements.find((s) => s.value?.verdict === "confirmed");
  const rejected = new Set(statements.filter((s) => s.value?.verdict === "not_this").map((s) => s.value.domain));
  const identity = readIdentity(row.enrichment);
  const base = { brandId: row.id, name: row.name, researchIdentity: identity?.status ?? null } as const;
  if (confirmedSt) {
    return { ...base, status: "confirmed_by_you", candidate: null, confirmed: { domain: confirmedSt.value.domain, at: confirmedSt.created_at?.toISOString() ?? null }, lookup: "not_needed" };
  }

  const rowDomain = brandDomainFromInput(row.domain ?? null);
  const options: { domain: string; basis: CandidateBasis }[] = [];
  if (rowDomain) options.push({ domain: rowDomain, basis: identity?.status === "confirmed" && identity.domain === rowDomain ? "research_confirmed" : "mail_evidence" });
  const proposed = readCandidate(row.enrichment);
  const proposedDomain = brandDomainFromInput(proposed?.domain ?? null);
  if (proposedDomain && !rowDomain) options.push({ domain: proposedDomain, basis: "name_search" });
  const pick = options.find((o) => !rejected.has(o.domain)) ?? null;
  if (pick) {
    const logoUrl = pick.domain === rowDomain && row.logo_url ? row.logo_url : googleFaviconUrl(pick.domain);
    return { ...base, status: "candidate", candidate: { name: row.name, domain: pick.domain, logoUrl, basis: pick.basis }, confirmed: null, lookup: "not_needed" };
  }

  // Nothing to offer. A row with no domain can ask a name search for one — once per cap window.
  let lookup: CandidateView["lookup"] = "not_needed";
  if (!rowDomain && !row.is_agency) {
    if (!brandIdentityGateEnabled()) lookup = "off";
    else if (now.getTime() - (Date.parse(readCandidateLookupAt(row.enrichment) ?? "") || 0) < BRAND_RESEARCH_CAP_DAYS * DAY_MS) lookup = "recent";
    else lookup = (await requestBrandIdentityRefresh(athleteId, row.id, "candidate lookup", { lookup: true })) ? "started" : "off";
  }
  return { ...base, status: "none", candidate: null, confirmed: null, lookup };
}

export type StatementResult =
  | { ok: true; assertedId: string; domain: string; runId: string | null }
  | { ok: false; reason: "not_your_brand" | "invalid_domain" | "agency" | "domain_mismatch" | "domain_held" };

/** Insert her statement and supersede what it replaces. Returns the new row id and the ids it superseded. */
async function writeStatement(athleteId: string, value: BrandStatementValue): Promise<{ id: string; superseded: string[] }> {
  const prior = await liveStatements(athleteId, value.brand_id);
  const replaced = prior.filter((s) => s.value?.domain === value.domain || (value.verdict === "confirmed" && s.value?.verdict === "confirmed"));
  const [row] = await db.insert(athleteAsserted).values({
    athlete_id: athleteId, field: BRAND_IDENTITY_FIELD, value: value as any, said: null, source: "settings", mode: "form",
  }).returning({ id: athleteAsserted.id });
  if (replaced.length) await db.update(athleteAsserted).set({ superseded_by: row.id }).where(inArray(athleteAsserted.id, replaced.map((s) => s.id)));
  return { id: row.id, superseded: replaced.map((s) => s.id) };
}

async function candidateBasisFor(row: BrandRow, domain: string): Promise<CandidateBasis | "her_entry"> {
  const rowDomain = brandDomainFromInput(row.domain ?? null);
  const identity = readIdentity(row.enrichment);
  if (rowDomain === domain) return identity?.status === "confirmed" && identity.domain === domain ? "research_confirmed" : "mail_evidence";
  if (brandDomainFromInput(readCandidate(row.enrichment)?.domain ?? null) === domain) return "name_search";
  return "her_entry";
}

export async function confirmBrand(athleteId: string, brandId: number, rawDomain: unknown, now: Date = new Date()): Promise<StatementResult> {
  const domain = typeof rawDomain === "string" ? brandDomainFromInput(rawDomain) : null;
  if (!domain) return { ok: false, reason: "invalid_domain" };
  const row = await herBrand(athleteId, brandId);
  if (!row) return { ok: false, reason: "not_your_brand" };
  if (row.is_agency) return { ok: false, reason: "agency" };
  const rowDomain = brandDomainFromInput(row.domain ?? null);
  if (rowDomain && rowDomain !== domain) return { ok: false, reason: "domain_mismatch" };
  if (!rowDomain) {
    const [owner] = await db.select({ id: inboxBrands.id }).from(inboxBrands).where(eq(inboxBrands.domain, domain)).limit(1);
    if (owner && owner.id !== row.id) return { ok: false, reason: "domain_held" };
  }

  const basis = await candidateBasisFor(row, domain);
  const stmt = await writeStatement(athleteId, { brand_id: row.id, domain, verdict: "confirmed", provenance: { surface: "confirm_brand", candidate_basis: basis } });
  if (!rowDomain) {
    const fill = await fillBrandDomain(row.id, domain);
    if (fill !== "set" && fill !== "already") {
      // Lost a race for the domain: her statement is withdrawn so a refusal leaves nothing behind.
      await db.update(athleteAsserted).set({ retracted_at: now }).where(eq(athleteAsserted.id, stmt.id));
      if (stmt.superseded.length) await db.update(athleteAsserted).set({ superseded_by: null }).where(inArray(athleteAsserted.id, stmt.superseded));
      return { ok: false, reason: "domain_held" };
    }
  }
  const confirmed = { domain, assertion_id: stmt.id, at: now.toISOString() };
  await db.update(inboxBrands).set({ enrichment: sql`coalesce(${inboxBrands.enrichment}, '{}'::jsonb) || ${JSON.stringify({ athlete_confirmed: confirmed })}::jsonb` } as any)
    .where(eq(inboxBrands.id, row.id));
  const run = await requestBrandIdentityRefresh(athleteId, row.id, "athlete confirmed the brand", { domain });
  logger.info({ athleteId, brandId: row.id, domain, basis, assertedId: stmt.id, runId: run?.runId ?? null }, "brand confirmed by the athlete");
  return { ok: true, assertedId: stmt.id, domain, runId: run?.runId ?? null };
}

export type AutoConfirmOutcome =
  | { confirmed: true; domain: string; basis: SystemConfirmed["basis"]; filled: boolean }
  | { confirmed: false; reason: "no_brand" | "agency" | "already_settled" | "weak_evidence" | "unverifiable_sender" | "rejected_by_athlete" | "domain_held" };

/** PURE. What strong evidence settles who this brand is, if any (the row's own fields only). */
export function strongIdentityEvidence(row: Pick<BrandRow, "name" | "domain" | "enrichment">):
  { domain: string; basis: SystemConfirmed["basis"]; evidence: string | null } | null {
  const rowDomain = brandDomainFromInput(row.domain ?? null);
  const candidate = readCandidate(row.enrichment);
  const candDomain = brandDomainFromInput(candidate?.domain ?? null);
  // The verified official-site search found the brand's own site under its own name.
  if (candDomain && (!rowDomain || rowDomain === candDomain) && strongSiteMatch(row.name, candidate)) {
    return { domain: candDomain, basis: "verified_official_site", evidence: candidate?.evidence ?? null };
  }
  // The row's domain came from the brand's own email (free mail and sending platforms never become a brand domain),
  // and no name search proposed a different site.
  if (rowDomain && (!candDomain || candDomain === rowDomain)) {
    return { domain: rowDomain, basis: "sender_domain", evidence: `domain from the brand's email: ${rowDomain}` };
  }
  return null;
}

/**
 * Settle WHO a brand is without asking the athlete, when the evidence is strong (strongIdentityEvidence). Records
 * enrichment.system_confirmed with its evidence, fills the row's domain from a verified candidate, and never acts on a
 * domain any athlete has said is "not this". The refresh run on that domain then decides research, as for her tap.
 */
export async function autoConfirmBrand(brandId: number, now: Date = new Date()): Promise<AutoConfirmOutcome> {
  const [row] = await db.select().from(inboxBrands).where(eq(inboxBrands.id, brandId)).limit(1);
  if (!row) return { confirmed: false, reason: "no_brand" };
  if (row.is_agency) return { confirmed: false, reason: "agency" };
  if (identitySettled(row.enrichment)) return { confirmed: false, reason: "already_settled" };
  const strong = strongIdentityEvidence(row);
  if (!strong) return { confirmed: false, reason: "weak_evidence" };
  const [said] = await db.select({ id: athleteAsserted.id }).from(athleteAsserted)
    .where(and(eq(athleteAsserted.field, BRAND_IDENTITY_FIELD), isNull(athleteAsserted.retracted_at), isNull(athleteAsserted.superseded_by),
      sql`${athleteAsserted.value}->>'brand_id' = ${String(brandId)}`, sql`${athleteAsserted.value}->>'domain' = ${strong.domain}`,
      sql`${athleteAsserted.value}->>'verdict' = 'not_this'`))
    .limit(1);
  if (said) return { confirmed: false, reason: "rejected_by_athlete" };
  // A sender we could not verify (possible impersonation) never settles a brand on its own: she is asked.
  const [unverifiable] = await db.select({ id: inboxThreads.id }).from(inboxThreads)
    .where(and(eq(inboxThreads.brand_id, row.id), sql`${inboxThreads.classification}->>'channel' = 'unverifiable'`)).limit(1);
  if (unverifiable) return { confirmed: false, reason: "unverifiable_sender" };
  let filled = false;
  if (!brandDomainFromInput(row.domain ?? null)) {
    const fill = await fillBrandDomain(row.id, strong.domain);
    if (fill !== "set" && fill !== "already") return { confirmed: false, reason: "domain_held" };
    filled = fill === "set";
  }
  const record: SystemConfirmed = { domain: strong.domain, basis: strong.basis, evidence: strong.evidence, at: now.toISOString() };
  await db.update(inboxBrands).set({ enrichment: sql`coalesce(${inboxBrands.enrichment}, '{}'::jsonb) || ${JSON.stringify({ system_confirmed: record })}::jsonb` } as any)
    .where(eq(inboxBrands.id, row.id));
  logger.info({ brandId: row.id, domain: strong.domain, basis: strong.basis, filled }, "brand identity settled by the system");
  return { confirmed: true, domain: strong.domain, basis: strong.basis, filled };
}

export async function rejectBrandCandidate(athleteId: string, brandId: number, rawDomain: unknown): Promise<StatementResult> {
  const domain = typeof rawDomain === "string" ? brandDomainFromInput(rawDomain) : null;
  if (!domain) return { ok: false, reason: "invalid_domain" };
  const row = await herBrand(athleteId, brandId);
  if (!row) return { ok: false, reason: "not_your_brand" };
  const basis = await candidateBasisFor(row, domain);
  const stmt = await writeStatement(athleteId, { brand_id: row.id, domain, verdict: "not_this", provenance: { surface: "confirm_brand", candidate_basis: basis } });
  // A confirmation she made of this domain is withdrawn from the row as well (imagery then follows the research verdict).
  const her = readAthleteConfirmed(row.enrichment);
  if (her && stmt.superseded.includes(her.assertion_id)) {
    // Imagery that stood only on her word goes with it; imagery research confirmed stays.
    const own = readOwnSite(row.enrichment);
    const id = readIdentity(row.enrichment);
    const dropOwn = !!own && own.basis === "athlete_confirmed" && !(id?.status === "confirmed" && id.domain === own.domain);
    const dropCover = dropOwn && !!own!.cover && row.image_url === own!.cover;
    await db.update(inboxBrands).set({
      enrichment: dropOwn ? sql`${inboxBrands.enrichment} - 'athlete_confirmed' - 'own_site'` : sql`${inboxBrands.enrichment} - 'athlete_confirmed'`,
      ...(dropCover ? { image_url: null, images: null } : {}),
    } as any).where(eq(inboxBrands.id, row.id));
  }
  // A system settlement of this domain is withdrawn too ("Not this brand" undoes it); a domain the system filled from a
  // search candidate goes with it, so the card asks her again.
  const sys = readSystemConfirmed(row.enrichment);
  if (sys && sys.domain === domain) {
    const clearDomain = sys.basis === "verified_official_site" && brandDomainFromInput(row.domain ?? null) === domain;
    // Imagery that stood only on the system's settlement goes with it; imagery research confirmed stays.
    const own = readOwnSite(row.enrichment);
    const id = readIdentity(row.enrichment);
    const dropOwn = !!own && own.basis === "system_confirmed" && !(id?.status === "confirmed" && id.domain === own.domain);
    const dropCover = dropOwn && !!own!.cover && row.image_url === own!.cover;
    await db.update(inboxBrands).set({
      enrichment: dropOwn ? sql`${inboxBrands.enrichment} - 'system_confirmed' - 'own_site'` : sql`${inboxBrands.enrichment} - 'system_confirmed'`,
      ...(clearDomain ? { domain: null } : {}),
      ...(dropCover ? { image_url: null, images: null } : {}),
    } as any).where(eq(inboxBrands.id, row.id));
  }
  // The name search's candidate she rejected is not shown as the brand's logo any more (the search is not re-run
  // inside its cap window: candidate_lookup stays).
  if (readCandidate(row.enrichment)?.domain === domain) {
    await db.update(inboxBrands).set({ enrichment: sql`${inboxBrands.enrichment} - 'candidate'` } as any).where(eq(inboxBrands.id, row.id));
  }
  logger.info({ athleteId, brandId: row.id, domain, assertedId: stmt.id }, "brand candidate rejected by the athlete");
  return { ok: true, assertedId: stmt.id, domain, runId: null };
}
