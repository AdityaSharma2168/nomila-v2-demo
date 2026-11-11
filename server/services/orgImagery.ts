/**
 * orgImagery.ts — the logo of an organisation or team a recommendation is about (Brain PR B, owner-approved 7 Oct 2026).
 *
 * A move `about` an organisation (a cause or programme she is part of) or a team shows that org's LOGO, through the
 * same keyless pipeline brands use (lib/brandLogoSources: Google's favicon at runtime), keyed on the org's OFFICIAL
 * domain. The domain comes only from data Nomila already holds, in this order:
 *
 *   1. a verified affiliation / research fact that names the org (athlete_facts value.org …, current or historical,
 *      the row athlete_affiliations' found rows are synced from) whose cited evidence was retrieved from an OFFICIAL
 *      source (research_evidence.source_type official_team_or_school | official_governing_body) — that source's domain;
 *      or such an official evidence row whose own claim names the org. Suspect and superseded evidence never counts.
 *   2. a domain she wrote herself, in an assertion (athlete_asserted, live rows) that also names the org.
 *
 * NEVER a domain guessed from the name: no domain held ⇒ no logo ⇒ the card's typographic fallback. No cover is
 * offered — Nomila holds no confidently-known org cover today. Read-only: no provider call, no write, no migration.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { athleteAsserted, athleteFacts, researchEvidence } from "../../shared/schema";
import { sameNameKey } from "../lib/brandName";
import { brandDomainOf } from "../lib/senderProfile";
import { googleFaviconUrl } from "../lib/brandLogoSources";

type Db = PgDatabase<any, any, any>;

export interface OrgLogo { name: string; domain: string; logoUrl: string; source: "official_research" | "her_words" }
export interface OfficialEvidence { id: string; claim: unknown; source_domain: string | null; source_type: string; suspect: boolean; superseded_by: string | null }
export interface OrgFact { value: unknown; status: string; provenance: unknown }

/** Source types that speak for the team, school or governing body itself (research/registries tier ≤ 2). */
export const OFFICIAL_SOURCE_TYPES = ["official_team_or_school", "official_governing_body"] as const;
/** A social, link or reference host is never an org's own site, whatever page names it. */
const NOT_AN_ORG_SITE = new Set(["instagram.com", "tiktok.com", "youtube.com", "youtu.be", "x.com", "twitter.com", "facebook.com", "linkedin.com", "linktr.ee", "threads.net", "wikipedia.org"]);
const FACT_STATUSES = new Set(["current", "historical"]);

const orgDomain = (raw: string | null | undefined): string | null => {
  const d = brandDomainOf((raw ?? "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#\s]/)[0]);
  return d && !NOT_AN_ORG_SITE.has(d) ? d : null;
};

/** The names a claim or fact value gives its organisation, wherever its schema puts it. */
function namesIn(x: unknown): string[] {
  const c = (x ?? {}) as Record<string, any>;
  const v = (c.value && typeof c.value === "object" ? c.value : c) as Record<string, unknown>;
  return ["org", "organization", "organisation", "team", "school", "program", "programme", "name"].map((k) => v[k]).filter((s): s is string => typeof s === "string" && !!s.trim());
}

const official = (e: OfficialEvidence | undefined): e is OfficialEvidence =>
  !!e && !e.suspect && !e.superseded_by && (OFFICIAL_SOURCE_TYPES as readonly string[]).includes(e.source_type);

/** Step 1, pure: the official domain behind a fact or an evidence row that names this org. */
export function orgDomainFromResearch(orgName: string, facts: ReadonlyArray<OrgFact>, evidence: ReadonlyArray<OfficialEvidence>): string | null {
  const key = sameNameKey(orgName);
  if (!key) return null;
  const byId = new Map(evidence.map((e) => [e.id, e]));
  for (const f of facts) {
    if (!FACT_STATUSES.has(f.status) || !namesIn(f.value).some((n) => sameNameKey(n) === key)) continue;
    const ids = ((f.provenance as { evidenceIds?: unknown } | null)?.evidenceIds ?? []) as unknown[];
    for (const id of ids) {
      const e = byId.get(String(id));
      const d = official(e) ? orgDomain(e.source_domain) : null;
      if (d) return d;
    }
  }
  for (const e of evidence) {
    if (!official(e) || !namesIn(e.claim).some((n) => sameNameKey(n) === key)) continue;
    const d = orgDomain(e.source_domain);
    if (d) return d;
  }
  return null;
}

const DOMAIN_TOKEN = /(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?![a-z0-9-])/gi;

/** Step 2, pure: an assertion of hers that names the org AND writes a domain → that domain. Never inferred. */
export function orgDomainFromAssertions(orgName: string, rows: ReadonlyArray<{ value: unknown; said: string | null }>): string | null {
  const key = sameNameKey(orgName);
  if (!key) return null;
  for (const r of rows) {
    const text = `${r.said ?? ""} ${typeof r.value === "string" ? r.value : JSON.stringify(r.value ?? "")}`;
    if (!sameNameKey(text).includes(key)) continue;
    for (const m of text.matchAll(DOMAIN_TOKEN)) {
      if (text.charAt((m.index ?? 0) - 1) === "@") continue;   // an email address is not her org's site
      const d = orgDomain(m[1]);
      if (d) return d;
    }
  }
  return null;
}

/** The logo for each org name, keyed by sameNameKey. Names with no domain held are absent. Reads only. */
export async function orgLogos(db: Db, athleteId: string, names: string[]): Promise<Map<string, OrgLogo>> {
  const out = new Map<string, OrgLogo>();
  const wanted = [...new Set(names.filter((n) => sameNameKey(n)))];
  if (!wanted.length) return out;
  const evidence = (await db.select({ id: researchEvidence.id, claim: researchEvidence.claim, source_domain: researchEvidence.source_domain, source_type: researchEvidence.source_type, suspect: researchEvidence.suspect, superseded_by: researchEvidence.superseded_by, retrieved_at: researchEvidence.retrieved_at })
    .from(researchEvidence)
    .where(and(eq(researchEvidence.athlete_id, athleteId), inArray(researchEvidence.source_type, [...OFFICIAL_SOURCE_TYPES]), eq(researchEvidence.suspect, false), isNull(researchEvidence.superseded_by))) as any[])
    .sort((a, b) => new Date(b.retrieved_at).getTime() - new Date(a.retrieved_at).getTime());
  const facts = evidence.length
    ? (await db.select({ value: athleteFacts.value, status: athleteFacts.status, provenance: athleteFacts.provenance }).from(athleteFacts)
        .where(and(eq(athleteFacts.athlete_id, athleteId), inArray(athleteFacts.status, [...FACT_STATUSES])))) as OrgFact[]
    : [];
  let said: Array<{ value: unknown; said: string | null }> | null = null;
  for (const name of wanted) {
    let domain = orgDomainFromResearch(name, facts, evidence);
    let source: OrgLogo["source"] = "official_research";
    if (!domain) {
      said ??= await db.select({ value: athleteAsserted.value, said: athleteAsserted.said }).from(athleteAsserted)
        .where(and(eq(athleteAsserted.athlete_id, athleteId), isNull(athleteAsserted.superseded_by), isNull(athleteAsserted.retracted_at)));
      domain = orgDomainFromAssertions(name, said);
      source = "her_words";
    }
    if (domain) out.set(sameNameKey(name), { name, domain, logoUrl: googleFaviconUrl(domain), source });
  }
  return out;
}
