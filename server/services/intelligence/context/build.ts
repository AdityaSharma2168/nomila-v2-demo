/**
 * context/build.ts — buildCanonicalContext (design §2.1–2.2, §3). Provider-free; never writes.
 *
 * Canonical sources first (athlete_facts, research_evidence, athlete_inferences, social_identities,
 * athlete_affiliations, athlete_research_state, connected_accounts, assertions, deals); the legacy
 * adapter ONLY for domains whose coverage is `unavailable` (§3.2). A `populated` or `confirmed_empty`
 * domain never consults the blob, whatever it still holds.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../../db";
import { athleteFacts, athleteInferences, athleteResearchState, connectedAccounts, researchEvidence, socialAnalyticsSnapshots, socialIdentities } from "../../../../shared/schema";
import { listAffiliations, levelRecordFor, teamsLineFor } from "../../affiliations";
import { latestAssertions } from "../../../mila/onboarding";
import { confirmedPartnersFor } from "../../snapshotDeals";
import { countryName } from "../../athleteContext";
import { getFactDefinition, isRegisteredKey } from "../research/factRegistry";
import { CITED_LINEAGES, RESEARCH_DOMAINS, type ResearchDomain } from "../research/registries";
import { getResearchPolicy } from "../research/config";
import type { SourceClass } from "../types";
import { CONTEXT_CONTRACT_VERSION, type AffiliationRow, type CanonicalAthleteContext, type Coverage, type Evidence, type Fact, type Freshness, type HandleRecord, type Inference } from "./contract";
import { aggregateSourceMode, coverageMap, legacyAllowed, type DomainStateEntry } from "./coverage";
import { readLegacyBlob, readLegacyRow, type LegacyBlob, type LegacyRow } from "./legacyAdapter";

const DAY = 86_400_000;
const CLASS_RANK: Record<string, number> = { connected_verified: 0, platform_public: 1, web_researched: 2, inferred: 3, imputed: 4 };
const ACHIEVEMENT_KEYS = ["achievement", "award", "ranking", "national_team_participation"];

export interface BuildOptions { asOf?: Date }

/** The full context plus the legacy bits the views need for parity (never exposed by the contract itself). */
export interface BuiltContext { ctx: CanonicalAthleteContext; legacy: { row: LegacyRow; blob: LegacyBlob } }

export async function buildCanonicalContext(athleteId: string, opts: BuildOptions = {}): Promise<BuiltContext | null> {
  const asOf = opts.asOf ?? new Date();
  const row = await readLegacyRow(athleteId);
  if (!row) return null;
  const [policy, state, facts, evidence, inferences, identities, conns, affs, level, teamsLine, assertions, confirmedPartners, audience] = await Promise.all([
    getResearchPolicy(),
    db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId)).limit(1).then((r) => r[0] ?? null),
    db.select().from(athleteFacts).where(and(eq(athleteFacts.athlete_id, athleteId), inArray(athleteFacts.status, ["current", "historical", "disputed"]))),
    db.select().from(researchEvidence).where(and(eq(researchEvidence.athlete_id, athleteId), eq(researchEvidence.suspect, false), inArray(researchEvidence.kind, ["press_mention", "brand_mention", "media_asset"]), inArray(researchEvidence.lineage_status, [...CITED_LINEAGES]), isNull(researchEvidence.superseded_by))),
    db.select().from(athleteInferences).where(and(eq(athleteInferences.athlete_id, athleteId), isNull(athleteInferences.superseded_by))),
    db.select().from(socialIdentities).where(and(eq(socialIdentities.athlete_id, athleteId), eq(socialIdentities.status, "active"))),
    db.select({ platform: connectedAccounts.platform, username: connectedAccounts.platform_username, status: connectedAccounts.status }).from(connectedAccounts).where(eq(connectedAccounts.athlete_id, athleteId)),
    listAffiliations(athleteId).catch(() => []),
    levelRecordFor(athleteId, { division: row.division, conference: row.conference, segment: row.segment }).catch(() => ({ org: null, kind: null, division: row.division, conference: row.conference, segment: row.segment, alsoNational: false })),
    teamsLineFor(athleteId).catch(() => null),
    latestAssertions(athleteId),
    confirmedPartnersFor(athleteId).catch(() => [] as string[]),
    readAudience(athleteId),
  ]);

  // ── coverage (§3.2) ──
  const domainState = (state?.domains ?? null) as Partial<Record<ResearchDomain, DomainStateEntry>> | null;
  const rowsByDomain: Partial<Record<ResearchDomain, number>> = {};
  const bump = (d: ResearchDomain) => { rowsByDomain[d] = (rowsByDomain[d] ?? 0) + 1; };
  for (const f of facts) if (isRegisteredKey(f.fact_key)) bump(getFactDefinition(f.fact_key).domain);
  for (const e of evidence) bump(e.kind === "brand_mention" ? "brand_mentions" : "press");
  for (const i of inferences) if (i.inference_key === "story_arc" || i.inference_key === "sentiment") bump("narrative");
  for (const s of identities) if (s.source_class === "web_researched") bump("social_handles");
  const hasState = !!state && state.research_status !== "seed_only";
  const coverage = hasState ? coverageMap(domainState, rowsByDomain) : coverageMap(null, {});
  if (!hasState) for (const d of RESEARCH_DOMAINS) coverage[d] = rowsByDomain[d] ? "populated" : "unavailable";
  const needsLegacy = RESEARCH_DOMAINS.some((d) => legacyAllowed(coverage[d]));
  const blob: LegacyBlob = needsLegacy ? await readLegacyBlob(athleteId) : { present: false, asOf: null, snapshotCreatedAt: null, achievements: [], press: [], brandMentions: [], position: null, classYear: null, hometown: null, storyArc: null, sentiment: null, socialHandles: {}, raw: null };
  // The story arc shown today comes from athletes_current even when the blob is absent; keep that for parity.
  const blobForNarrative = needsLegacy ? blob : await readLegacyBlob(athleteId);

  // ── facts → sections ──
  const freshnessOf = (f: typeof facts[number]): Freshness => {
    const fam = isRegisteredKey(f.fact_key) ? getFactDefinition(f.fact_key).freshnessFamily : null;
    const ttl = fam ? policy.ttlDays[fam] : null;
    if (ttl == null) return "fresh";
    return asOf.getTime() - f.retrieved_at.getTime() > ttl * DAY ? "stale" : "fresh";
  };
  const toFact = <T>(f: typeof facts[number]): Fact<T> => ({ value: f.value as T, origin: f.origin as Fact["origin"], sourceClass: (f.source_class as SourceClass | null) ?? null, authorityTier: f.authority_tier, status: f.status as Fact["status"], retrievedAt: f.retrieved_at.toISOString(), validFrom: f.valid_from, validTo: f.valid_to, evidenceIds: ((f.provenance as any)?.evidenceIds ?? []) as string[], freshness: freshnessOf(f), factId: f.id, factKey: f.fact_key });
  const byKey = (key: string) => facts.filter((f) => f.fact_key === key && f.status !== "superseded");
  const currentSingle = (key: string) => byKey(key).filter((f) => f.status === "current").sort((a, b) => originRank(a.origin) - originRank(b.origin) || b.retrieved_at.getTime() - a.retrieved_at.getTime())[0] ?? null;

  const use = (d: ResearchDomain) => ({ canonical: !legacyAllowed(coverage[d]), legacy: legacyAllowed(coverage[d]) && blob.present });

  const idUse = use("identity"), prUse = use("profile"), acUse = use("achievements"), psUse = use("press"), bmUse = use("brand_mentions"), naUse = use("narrative"), shUse = use("social_handles");
  const sportFact = currentSingle("sport");
  const identity: CanonicalAthleteContext["identity"] = {
    name: { value: { full: row.fullName, first: row.firstName, last: row.lastName }, origin: "legacy_row", sourceClass: null, authorityTier: null, status: "current", retrievedAt: row.createdAt, evidenceIds: [], freshness: "unknown", factKey: "name" },
    aliases: idUse.canonical ? byKey("alias").filter((f) => f.status === "current").map((f) => toFact(f)) : [],
    sport: sportFact ? toFact(sportFact) : row.sport ? { value: { sport: row.sport }, origin: "legacy_row", sourceClass: null, authorityTier: null, status: "current", retrievedAt: row.createdAt, evidenceIds: [], freshness: "unknown", factKey: "sport" } : null,
    hometown: idUse.canonical ? (currentSingle("hometown") ? toFact(currentSingle("hometown")!) : null) : (idUse.legacy ? blob.hometown : null),
    nationality: idUse.canonical ? byKey("nationality").filter((f) => f.status === "current").map((f) => toFact(f)) : [],
    careerStatus: { value: { status: row.careerStatus }, origin: "athlete_asserted", sourceClass: null, authorityTier: null, status: "current", retrievedAt: row.createdAt, evidenceIds: [], freshness: "fresh", factKey: "career_status" },
    identityConfidence: Number(state?.identity_confidence ?? 0), researchStatus: state?.research_status ?? "seed_only",
    firstName: row.firstName, photoUrl: row.photoUrl, createdAt: row.createdAt,
  };
  const affRows: AffiliationRow[] = affs.map((a: any) => ({ id: a.id, org: a.org, kind: a.kind, level: a.level ?? null, conference: a.conference ?? null, role: a.role ?? null, position: a.position ?? null, from: a.from ?? null, to: a.to ?? null, primary: !!a.primary, current: !!a.current, kindOfFact: a.kindOfFact, source: a.source ?? null, recordedAt: a.recordedAt ?? null }));
  const affiliations: CanonicalAthleteContext["affiliations"] = { current: affRows.find((a) => a.current && a.primary) ?? affRows.find((a) => a.current) ?? null, all: affRows, level: level as any, teamsLine };
  const profile: CanonicalAthleteContext["profile"] = {
    position: prUse.canonical ? (currentSingle("position") ? toFact(currentSingle("position")!) : null) : (prUse.legacy ? blob.position : null),
    classYear: prUse.canonical ? (currentSingle("class_year") ? toFact(currentSingle("class_year")!) : null) : (prUse.legacy ? blob.classYear : null),
    graduationYear: prUse.canonical ? (currentSingle("graduation_year") ? toFact(currentSingle("graduation_year")!) : null) : null,
    event: prUse.canonical ? byKey("event").filter((f) => f.status === "current").map((f) => toFact(f)) : [],
  };
  const achievements = acUse.canonical
    ? facts.filter((f) => ACHIEVEMENT_KEYS.includes(f.fact_key) && f.status !== "disputed").sort((a, b) => b.retrieved_at.getTime() - a.retrieved_at.getTime()).map((f) => { const v = f.value as any; return { ...toFact<any>(f), value: { name: String(v.name ?? v.text ?? ""), year: v.year ?? v.season ?? null, level: v.level ?? null, key: f.fact_key } }; })
    : acUse.legacy ? blob.achievements : [];
  const toEvidence = <T>(e: typeof evidence[number], value: T): Evidence<T> => ({ value, sourceClass: e.source_class as SourceClass, sourceType: e.source_type, sourceUrl: e.source_url, sourceDomain: e.source_domain, retrievedAt: e.retrieved_at.toISOString(), publishedAt: e.published_at?.toISOString() ?? null, evidenceId: e.id, lineage: e.lineage_status as Evidence["lineage"] });
  const press = psUse.canonical ? evidence.filter((e) => e.kind === "press_mention").map((e) => { const c = e.claim as any; return toEvidence(e, { outlet: c.outlet ?? null, headline: c.headline ?? null, url: e.source_url }); }) : psUse.legacy ? blob.press : [];
  const brandMentions = bmUse.canonical ? evidence.filter((e) => e.kind === "brand_mention").map((e) => { const c = e.claim as any; return toEvidence(e, { brand: String(c.brand ?? ""), type: c.type ?? null, confidence: e.confidence != null ? Number(e.confidence) : null }); }) : bmUse.legacy ? blob.brandMentions : [];
  const nilMentions = bmUse.canonical ? byKey("nil_mention").map((f) => toFact(f)) : [];
  // Additive (Concept 0.4 Slice 1): registry facts no section above carries. Canonical coverage only; never the blob.
  const dated = (key: string) => byKey(key).sort((a, b) => b.retrieved_at.getTime() - a.retrieved_at.getTime()).map((f) => toFact<any>(f));
  const registryFacts: CanonicalAthleteContext["registryFacts"] = {
    rankings: acUse.canonical ? dated("ranking") : [],
    nationalTeam: acUse.canonical ? dated("national_team_participation") : [],
    seasonStatistics: acUse.canonical ? dated("season_statistic") : [],
    endorsements: bmUse.canonical ? dated("endorsement") : [],
    education: prUse.canonical ? dated("education").filter((f) => f.status === "current") : [],
  };
  const storyInf = inferences.find((i) => i.inference_key === "story_arc");
  const sentInf = inferences.find((i) => i.inference_key === "sentiment");
  // brand_fit_tags is consumed ONLY when versioned: a row without a non-empty taxonomy_version is treated as absent
  const fitInf = inferences.find((i) => i.inference_key === "brand_fit_tags" && !!i.taxonomy_version?.trim() && Array.isArray(i.value));
  const toInf = <T>(i: typeof inferences[number]): Inference<T> => ({ value: i.value as T, producer: i.producer, taxonomyVersion: i.taxonomy_version?.trim() || null, computedAt: i.computed_at?.toISOString() ?? null, lineage: { runId: (i.lineage as any)?.runId ?? null, evidenceIds: ((i.lineage as any)?.evidenceIds ?? []) as string[] }, legacy: false, inferenceId: i.id });
  const inferencesOut = {
    storyArc: naUse.canonical ? (storyInf ? toInf<string>(storyInf) : null) : (blobForNarrative.storyArc ?? null),
    sentiment: naUse.canonical ? (sentInf ? toInf(sentInf) : null) : (naUse.legacy ? blob.sentiment : null),
    // D6: read only — a canonical, versioned inference or nothing; never derived here, never from the blob
    brandFitTags: fitInf ? toInf<string[]>(fitInf) : null,
  };

  // ── social handles by authority (§2.2): identities > connected accounts > entered; blob handles last ──
  const handles: Record<string, HandleRecord> = {};
  const consider = (platform: string, rec: HandleRecord) => {
    const p = platform === "twitter" ? "x" : platform;
    const cur = handles[p];
    if (!cur || rank(rec) < rank(cur)) handles[p] = rec;
  };
  for (const s of identities) if (s.handle && (s.source_class !== "web_researched" || shUse.canonical)) consider(s.platform, { handle: s.handle.replace(/^@/, ""), sourceClass: s.source_class as SourceClass, connected: s.source_class === "connected_verified", confidence: s.confidence != null ? Number(s.confidence) : null, origin: "social_identity" });
  for (const c of conns) if (c.status === "active" && c.username && ["instagram", "tiktok", "youtube", "x"].includes(c.platform)) consider(c.platform, { handle: c.username.replace(/^@/, ""), sourceClass: "connected_verified", connected: true, confidence: 1, origin: "connected_account" });
  for (const [k, v] of Object.entries(row.socials)) if (["instagram", "tiktok", "youtube", "twitter", "x"].includes(k)) consider(k, { handle: v.replace(/^@/, ""), sourceClass: "entered", connected: false, confidence: null, origin: "entered" });
  if (shUse.legacy) for (const [k, v] of Object.entries(blob.socialHandles)) consider(k, { handle: v, sourceClass: null, connected: false, confidence: null, origin: "legacy_blob" });
  const connectionStatus: CanonicalAthleteContext["social"]["connectionStatus"] = conns.some((c) => c.status === "active") ? "active" : conns.some((c) => c.status === "expired") ? "expired" : conns.some((c) => c.status === "revoked") ? "revoked" : "none";

  const byDomain: CanonicalAthleteContext["freshness"]["byDomain"] = {};
  if (domainState) for (const d of RESEARCH_DOMAINS) { const e = domainState[d]; if (e) byDomain[d] = { status: e.status ?? null, outcome: e.outcome ?? null, lastResearchedAt: e.lastResearchedAt ?? null, staleAfter: e.staleAfter ?? null }; }
  const ctx: CanonicalAthleteContext = {
    contractVersion: CONTEXT_CONTRACT_VERSION, athleteId, builtAt: asOf.toISOString(),
    sourceMode: aggregateSourceMode(coverage, ["identity", "profile", "achievements", "press", "brand_mentions", "narrative", "social_handles"]), coverage,
    identity, affiliations, profile, achievements, press, brandMentions, nilMentions, registryFacts, inferences: inferencesOut,
    social: { handles, connectionStatus, connectedPlatforms: [...new Set(conns.filter((c) => c.status === "active").map((c) => c.platform))] },
    assertions: assertions.map((a) => ({ field: a.field, label: a.label, value: a.value, raw: a.raw, said: a.said ?? null, at: a.at ? new Date(a.at).toISOString() : null, source: a.source ?? null, mode: a.mode ?? null })),
    freshness: { byDomain, researchAsOf: state?.last_researched_at?.toISOString() ?? blob.asOf ?? blobForNarrative.asOf ?? null },
    commercial: { confirmedPartners, commercialState: confirmedPartners.length ? "active" : "none" },   // D7 locked: confirmed deals only
    audience,
    provenanceSummary: { canonicalFacts: facts.length, legacyFacts: countLegacy(identity, profile, achievements, press, brandMentions), assertions: assertions.length },
  };
  return { ctx, legacy: { row, blob: needsLegacy ? blob : blobForNarrative } };
}

const originRank = (o: string) => ({ athlete_proof: 0, athlete_asserted: 1, connection: 2, research: 3, backfill: 4 } as Record<string, number>)[o] ?? 9;
const rank = (h: HandleRecord) => (h.sourceClass === "entered" ? 5 : h.sourceClass == null ? 6 : CLASS_RANK[h.sourceClass] ?? 6);
function countLegacy(...sections: unknown[]): number {
  let n = 0;
  const walk = (v: unknown) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if ((v as any).origin === "legacy_blob" || (v as any).lineage === "legacy") n++; else Object.values(v as any).forEach(walk); } };
  sections.forEach(walk);
  return n;
}

/** D8: audience demographics stay on the connected analytics snapshots in 2d (Step 4 moves them to social_features). */
async function readAudience(athleteId: string): Promise<CanonicalAthleteContext["audience"]> {
  const demos = await db.select({ platform: socialAnalyticsSnapshots.platform, gender: socialAnalyticsSnapshots.top_audience_gender, age: socialAnalyticsSnapshots.top_audience_age_range, city: socialAnalyticsSnapshots.top_audience_city, day: socialAnalyticsSnapshots.snapshot_date })
    .from(socialAnalyticsSnapshots).where(and(eq(socialAnalyticsSnapshots.athlete_id, athleteId), eq(socialAnalyticsSnapshots.source, "connected"))).orderBy(desc(socialAnalyticsSnapshots.snapshot_date)).limit(6);
  const ig = demos.find((d) => d.platform === "instagram") ?? demos[0];
  const [igRaw] = await db.select({ raw: socialAnalyticsSnapshots.raw_metrics }).from(socialAnalyticsSnapshots)
    .where(and(eq(socialAnalyticsSnapshots.athlete_id, athleteId), eq(socialAnalyticsSnapshots.platform, "instagram"), eq(socialAnalyticsSnapshots.source, "connected"))).orderBy(desc(socialAnalyticsSnapshots.snapshot_date)).limit(1);
  const geoCountry = (((igRaw?.raw as any)?.demographics?.country ?? []) as Array<{ key: string; pct: number }>).slice(0, 4).map((c) => ({ ...c, key: countryName(c.key) }));
  const genderDemo = (((igRaw?.raw as any)?.demographics?.gender ?? []) as Array<{ key: string; pct: number }>);
  const share = genderDemo.find((g) => g.key === ig?.gender)?.pct ?? genderDemo[0]?.pct ?? null;
  return { gender: ig?.gender ?? null, ageRange: ig?.age ?? null, topCity: ig?.city ?? null, geoCountry, share, sourceClass: "connected_verified", asOf: ig?.day ? String(ig.day) : null, connected: !!ig, platform: ig?.platform ?? null };
}
