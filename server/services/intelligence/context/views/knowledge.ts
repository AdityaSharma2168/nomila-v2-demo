/**
 * views/knowledge.ts — "What Nomila Knows" and the Me identity header (Concept 0.4 Slice 1; knowledge/3 = Concept 0.4 PR 4).
 *
 * A pure projection over the Canonical Athlete Context (buildCanonicalContext), read DIRECTLY — it does not go through
 * CANONICAL_CONTEXT_READERS, so the legacy Record screen and every other reader are untouched.
 *
 * Rules this view keeps (approved decisions, 30 Sep 2026):
 *   - No "verified" flag and no parallel verification system. Every entry carries an athlete-facing SOURCE LABEL derived
 *     from the canonical provenance fields (Fact.origin / sourceClass / authorityTier / status; AffiliationRow.kindOfFact;
 *     Evidence.lineage). The mapping is `sourceOf` / `evidenceSourceOf` below and is the only place it lives.
 *   - Counts are "things Nomila knows": present entries whose status is current. Never "verified facts".
 *   - Legacy compatibility data is NOT shown: Facts with origin `legacy_blob`, Evidence with lineage `legacy`, story_arc,
 *     athletes_current (score, capitals, rate card, follower projection). A domain whose only value is legacy reads as
 *     not_yet_computed.
 *   - Identity is factual only: "<team> <sport>" from the current affiliation + sport fact. No interpretive words
 *     (builder, founder, …) — no producer exists for them yet, so nothing is manufactured.
 *   - Corrections reuse PUT /me/record/:field: an entry names the asserted field that corrects it, or none.
 * Missing data: present | unknown (looked / asked, nothing on record) | unavailable (no source can answer today) |
 * not_yet_computed (a producer exists but has not produced a canonical value for her).
 *
 * knowledge/3 (Concept 0.4 PR 4, contract Part A "What Nomila Knows" + API plan):
 *   - At a glance: name · school/team · sport · position · hometown · nationality · class ("Senior · 2026 season").
 *     graduation_year leaves the at-a-glance row (its meaning is ambiguous); it stays in the Profile section.
 *   - Every present entry carries `tier` (established | reported | unconfirmed) from the EXISTING admissibility policy
 *     (whatever version identityIntelligence/ carries) — `tierOf*` below call identityIntelligence/claims.ts (import only), never a new scale.
 *   - `logoDomain` on teams, schools, leagues and brands: PRESENTATION ONLY (the client turns it into a logo). It never
 *     feeds tier, source, counts or order.
 *   - Teams come from canonical facts + her said/proof rows; a legacy `found` ledger row with no fact_id is not shown.
 *   - Academics: `education` facts (registry v3) + academic awards (evidence category `academic`); unavailable without.
 *   - National-team participation sits in the athletic career (Teams), not in Honours.
 *   - "This isn't right": an entry she disputed (POST /me/knowledge/disputes) carries `yourDispute` and reads unconfirmed.
 */

import { ASSERTED_FIELDS, type AssertedField, type AssertedShape } from "../../../../mila/onboarding";
import { careerStatusLabel } from "../../../../../shared/goals";
import { compact, schoolShort, titleCase } from "../../../athleteContext";
import { displayTeam } from "../../../affiliations";
import { AUTHORITATIVE_TIER, isCitedLineage, type ResearchDomain } from "../../research/registries";
// The admissibility policy (Concept 0.4 Part B) — imported, never copied: the Knows tier IS the Identity Intelligence tier.
import { assessClaim, sourceTierOfEvidence, sourceTierOfFact, type AthleteVerdicts } from "../../identityIntelligence/claims";
import { refKey, type BasisItem, type BasisRef, type Tier } from "../../identityIntelligence/contract";
import type { BuiltContext } from "../build";
import type { AffiliationRow, AssertionRecord, CanonicalAthleteContext, Evidence, Fact } from "../contract";
import type { MyIntelligenceEntry } from "../../views/myIntelligence";

export const KNOWLEDGE_VIEW_VERSION = "knowledge/3" as const;

// ─── source labels ────────────────────────────────────────────────────────────

export type SourceKey = "you" | "proof" | "inbox" | "connected" | "official" | "researched" | "inferred";
export interface KnowledgeSource {
  key: SourceKey;
  /** Athlete-facing label. */
  label: string;
  /** One more line when the provenance carries it (signup, source domain, "earlier research"). */
  detail: string | null;
}

export const SOURCE_LABELS: Record<SourceKey, string> = {
  you: "Confirmed by you",
  proof: "From your deals",
  inbox: "From your inbox",
  connected: "Connected account",
  official: "Official source",
  researched: "Researched",
  inferred: "Inferred",
};
const src = (key: SourceKey, detail: string | null = null): KnowledgeSource => ({ key, label: SOURCE_LABELS[key], detail });

/**
 * The ONE mapping from canonical provenance to an athlete-facing label. Returns null for legacy compatibility data
 * (origin legacy_blob), which this view never shows.
 *
 *   athlete_asserted                               → you         "Confirmed by you"
 *   legacy_row (the athletes row: signup entry)    → you         "Confirmed by you" · "at signup"
 *   athlete_proof                                  → proof       "From your deals"
 *   connection                                     → connected   "Connected account"
 *   research|backfill, sourceClass inferred|imputed→ inferred    "Inferred"
 *   research|backfill, authorityTier ≤ 2 (AUTHORITATIVE_TIER: governing body, team/school) → official "Official source"
 *   research|backfill, any other tier / no tier    → researched  "Researched" (backfill adds "earlier research")
 *   legacy_blob                                    → null (not shown)
 * Deals are not Facts; their label comes from deals.source (see the partnerships section of knowledgeView):
 *   contract_upload | self_reported, status accepted|completed → proof  "From your deals"  (ctx.commercial.confirmedPartners)
 *   inbox_scan, status accepted|completed                      → inbox  "From your inbox"  (KnowledgeExtras.inboxPartners)
 *   a brand with both                                          → proof  (the stronger, athlete-confirmed one; listed once)
 */
export function sourceOf(f: Pick<Fact, "origin" | "sourceClass" | "authorityTier"> | null): KnowledgeSource | null {
  if (!f) return null;
  switch (f.origin) {
    case "athlete_asserted": return src("you");
    case "legacy_row": return src("you", "at signup");
    case "athlete_proof": return src("proof");
    case "connection": return src("connected");
    case "research": case "backfill": {
      const detail = f.origin === "backfill" ? "earlier research" : null;
      if (f.sourceClass === "inferred" || f.sourceClass === "imputed") return src("inferred", detail);
      if (f.authorityTier != null && f.authorityTier <= AUTHORITATIVE_TIER) return src("official", detail);
      return src("researched", detail);
    }
    case "legacy_blob": return null;
  }
}

/** An affiliation row's source: the ledger's kindOfFact (said / proof / found). Found rows carry no tier → researched. */
export function affiliationSourceOf(a: AffiliationRow): KnowledgeSource {
  if (a.kindOfFact === "proof") return src("proof");
  if (a.kindOfFact === "said") return src("you", a.source === "signup" ? "at signup" : null);
  return src("researched");
}

/** The detail a native_retrieved entry carries: the site was retrieved, the cited page itself was not (#706 `site_only`). */
export const SITE_ONLY_DETAIL = "page not confirmed";

/**
 * Research evidence → its label. Accepted lineage is CITED_LINEAGES (research/registries.ts), the same set the canonical
 * context loads press / brand mentions with (context/build.ts):
 *   cited | native_supported | source_read → researched  "Researched" · <domain>
 *   native_retrieved         → researched  "Researched" · <domain> · "page not confirmed" (weaker lineage, still sourced)
 *   connected_verified class → connected   (any accepted lineage)
 *   legacy                   → null (not shown; counted as omitted legacy)
 * Any other lineage (uncited, conflicting, asserted_only) never reaches the context; if one did, it is not shown —
 * but it is NOT legacy, so the caller must not count it as such.
 */
export function evidenceSourceOf(e: Pick<Evidence, "lineage" | "sourceClass" | "sourceDomain">): KnowledgeSource | null {
  if (!isCitedLineage(e.lineage)) return null;
  if (e.sourceClass === "connected_verified") return src("connected");
  if (e.lineage === "native_retrieved") return src("researched", [e.sourceDomain, SITE_ONLY_DETAIL].filter(Boolean).join(" · "));
  return src("researched", e.sourceDomain ?? null);
}

// ─── tiers (the admissibility policy — import only) ──────────────────────────

/**
 * knowledge/3: how firmly Nomila holds an entry, in the EXISTING admissibility policy's words (Concept 0.4 Part B,
 * "Confidence tiers"; services/intelligence/identityIntelligence/claims.ts). Not a new scoring or banding system:
 *   fact           sourceTierOfFact(status)            current | historical → established; disputed → unconfirmed
 *   evidence       sourceTierOfEvidence(lineage, type)  native_supported from an official/major/reference source → established;
 *                                                      a retrieved reputable or first-party source → reported; else unconfirmed
 *   athlete authority (her word, her deals, her signup, her connected accounts) → established (Part B: athlete authority,
 *                  connected measurements, earned commercial records)
 *   her verdicts   assessClaim(): her confirmation → established; her denial → excluded, which this view shows as
 *                  `unconfirmed` + `yourDispute` (her own record keeps both — it is never hidden from her)
 * The `excluded` tier never reaches the client; `salience` never applies to an entry.
 */
export type KnowledgeTier = "established" | "reported" | "unconfirmed";

export interface DisputeNote { said: string | null; at: string | null }
/** Her verdicts as the Knows view needs them: the claims.ts sets plus the words of each dispute. */
export interface KnowledgeVerdicts extends AthleteVerdicts {
  /** refKey (fact:… / evidence:…) → her dispute, for disputes that named a fact or evidence row. */
  refDisputes: ReadonlyMap<string, DisputeNote>;
  /** Knows entry id → her dispute, for entries with no fact/evidence behind them (a deal, a handle, …). */
  entryDisputes: ReadonlyMap<string, DisputeNote>;
}
export const NO_KNOWLEDGE_VERDICTS: KnowledgeVerdicts = { denied: new Set(), confirmed: new Set(), refDisputes: new Map(), entryDisputes: new Map() };

/** The fact / evidence row behind an entry — what a dispute names, so Identity Intelligence reads the same denial. */
export type KnowledgeRef = { kind: "fact"; id: string } | { kind: "evidence"; id: string };

const basisItem = (ref: KnowledgeRef, sourceTier: Tier, source?: BasisItem["source"]): BasisItem =>
  ({ key: refKey(ref), ref, text: "", sourceTier, tier: sourceTier, claimKey: null, source, athleteAuthority: false, athleticIdentity: false, asOf: null, salience: 0 });

/** Excluded (her denial) stays visible on her own record as unconfirmed; salience is never an entry's tier. */
const visibleTier = (t: Tier | "salience"): KnowledgeTier => (t === "established" || t === "reported" ? t : "unconfirmed");

/** A canonical fact's tier: claims.ts sourceTierOfFact, then her verdicts through assessClaim. */
export function tierOfFact(f: Pick<Fact, "status" | "factId">, v: AthleteVerdicts = NO_KNOWLEDGE_VERDICTS): KnowledgeTier {
  const own = sourceTierOfFact(f.status);
  if (!f.factId) return visibleTier(own);
  return visibleTier(assessClaim([basisItem({ kind: "fact", id: f.factId }, own, { status: f.status })], v).tier);
}

/** A research evidence row's tier: claims.ts sourceTierOfEvidence (lineage + source type), then her verdicts. */
export function tierOfEvidence(e: Pick<Evidence, "lineage" | "sourceType" | "sourceDomain" | "evidenceId">, v: AthleteVerdicts = NO_KNOWLEDGE_VERDICTS): KnowledgeTier {
  const own = sourceTierOfEvidence({ lineage: e.lineage, sourceType: e.sourceType ?? "" });
  if (!e.evidenceId) return visibleTier(own);
  return visibleTier(assessClaim([basisItem({ kind: "evidence", id: e.evidenceId }, own, { type: e.sourceType, domain: e.sourceDomain ?? null, lineage: e.lineage })], v).tier);
}

// ─── shapes ───────────────────────────────────────────────────────────────────

export type EntryState = "present" | "unknown" | "unavailable" | "not_yet_computed";

export interface KnowledgeCorrection {
  /** The asserted field PUT /me/record/:field writes. */
  field: AssertedField;
  shape: AssertedShape;
  label: string;
  /** The typed value for the existing editors (teams: { index, teams }). */
  raw?: unknown;
}

/** knowledge/3: structured parts the screen lays out (career timeline, honours years). Display only. */
export interface KnowledgeMeta {
  org?: string | null;
  orgKind?: string | null;
  /** "2023 – present", "2022", "since 2024". */
  span?: string | null;
  /** Her role on the team when the fact carries it (e.g. Captain), with the season when stated. */
  role?: string | null;
  year?: number | null;
}

export interface KnowledgeEntry {
  id: string;
  label: string;
  value: string | null;
  state: EntryState;
  source: KnowledgeSource | null;
  /** Fact status when the entry is a fact; null otherwise. */
  status: "current" | "historical" | "disputed" | null;
  stale: boolean;
  at: string | null;
  /** Public-web citations behind the entry (cited research evidence only). */
  evidence: Array<{ url: string; domain: string | null }>;
  correct: KnowledgeCorrection | null;
  /** knowledge/3: the admissibility tier (see `tierOfFact`); null on an entry with nothing present. */
  tier: KnowledgeTier | null;
  /** knowledge/3: a domain for the org / brand logo. PRESENTATION ONLY — never authority, tier or order. */
  logoDomain: string | null;
  /** A brand's stored logo (inbox_brands.logo_url, set by brand research). PRESENTATION ONLY; additive, null elsewhere. */
  logoUrl: string | null;
  /** knowledge/3: the fact / evidence row behind the entry, when there is one. */
  ref: KnowledgeRef | null;
  /** knowledge/3: she said "This isn't right" (her words when she gave them). */
  yourDispute: DisputeNote | null;
  meta: KnowledgeMeta | null;
  /**
   * (Density pass, Oct 2026) A brand entry's inbox_brands row and its research, for the brand deck in What Nomila Knows.
   * PRESENTATION ONLY and ADDITIVE: present only on a brand entry whose brand is in inbox_brands; never authority, tier,
   * counts or order. An older server leaves both out.
   */
  brandId?: number | null;
  brandProfile?: BrandProfile | null;
}

/**
 * What inbox_brands' research says about a brand, as stored (nothing rewritten): the deck's pages are built per field
 * that exists — identity (category) · about (description) · athletes they work with · their audience + sports — and
 * its images (the chosen cover first, then the ranked set). No fit here: fit ratings come from deal analysis.
 */
export interface BrandProfile {
  category: string | null;
  description: string | null;
  audienceSummary: string | null;
  sportCategories: string[];
  knownAthletePartnerships: string[];
  coverUrl: string | null;
  images: string[];
  /** The pages brand research's web search saw (enrichment.sources), shown as links beside the profile. */
  sources: Array<{ url: string; title: string | null }>;
}

export const BRAND_PROFILE_LIMITS = { athletes: 12, sports: 8, images: 6, sources: 5 } as const;
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const texts = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.map(text).filter((x): x is string => !!x).filter((x, i, all) => all.indexOf(x) === i).slice(0, max) : []);
const httpUrl = (v: unknown): string | null => { const s = text(v); return s && /^https?:\/\//i.test(s) ? s : null; };

/** An inbox_brands row → its profile, as stored; null when it carries nothing a deck page could show. */
/** enrichment.sources as stored → only http(s) links, de-duplicated, capped. */
export function brandSourcesFrom(v: unknown): Array<{ url: string; title: string | null }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ url: string; title: string | null }> = [];
  for (const s of v) {
    const url = httpUrl((s as { url?: unknown } | null)?.url);
    if (!url || out.some((o) => o.url === url)) continue;
    out.push({ url, title: text((s as { title?: unknown }).title) });
    if (out.length >= BRAND_PROFILE_LIMITS.sources) break;
  }
  return out;
}

export function brandProfileFrom(row: { category?: unknown; description?: unknown; audience_summary?: unknown; sport_categories?: unknown; known_athlete_partnerships?: unknown; image_url?: unknown; images?: unknown; sources?: unknown }): BrandProfile | null {
  const cover = httpUrl(row.image_url);
  const images = texts(row.images, BRAND_PROFILE_LIMITS.images + 1).map(httpUrl).filter((u): u is string => !!u && u !== cover).slice(0, BRAND_PROFILE_LIMITS.images);
  const p: BrandProfile = {
    category: text(row.category), description: text(row.description), audienceSummary: text(row.audience_summary),
    sportCategories: texts(row.sport_categories, BRAND_PROFILE_LIMITS.sports), knownAthletePartnerships: texts(row.known_athlete_partnerships, BRAND_PROFILE_LIMITS.athletes),
    coverUrl: cover, images, sources: brandSourcesFrom(row.sources),
  };
  const any = p.category || p.description || p.audienceSummary || p.sportCategories.length || p.knownAthletePartnerships.length || p.coverUrl || p.images.length;
  return any ? p : null;
}

export interface KnowledgeSection { key: string; title: string; entries: KnowledgeEntry[] }

export type CategoryKey = "athletics" | "partnerships" | "media" | "interests" | "academics" | "business";
export interface KnowledgeCategory {
  key: CategoryKey;
  title: string;
  blurb: string;
  /** present when it holds ≥1 present entry; unavailable when no source can answer it yet. */
  state: "present" | "unknown" | "unavailable";
  /** Present entries with status current (and not disputed by her). Null when unavailable. */
  count: number | null;
  bySource: Partial<Record<SourceKey, number>>;
  sections: KnowledgeSection[];
}

export interface AthleteKnowledge {
  version: typeof KNOWLEDGE_VIEW_VERSION;
  athleteId: string;
  builtAt: string;
  /** When research last successfully refreshed something this view shows (see `knowledgeResearchAsOf`); null = never. */
  researchAsOf: string | null;
  identity: MeIdentity;
  /** At a glance: name · school/team · sport · position · hometown · nationality · class. */
  keyFacts: KnowledgeEntry[];
  categories: KnowledgeCategory[];
  total: number;
  bySource: Partial<Record<SourceKey, number>>;
  /** Values held but deliberately not shown (legacy compatibility data, legacy found affiliations). */
  omitted: { legacyValues: number };
}

export interface MeIdentity {
  /** What she is called: "Goes by" ⇒ first name ⇒ first word of the full name. */
  displayName: string;
  fullName: string;
  photoUrl: string | null;
  /** "<team short> <sport>" from the current affiliation + sport; sport alone without a team; null with neither. */
  primary: { label: string; org: string | null; orgKind: string | null; sport: string | null; source: KnowledgeSource | null } | null;
  /** Further FACTUAL identity parts (position, class year) — never interpretive words. */
  facts: string[];
  /** knowledge/2.1: her nationality from the canonical `nationality` fact(s) (current, sourced); null when none. */
  nationality: string | null;
  /** knowledge/2.1: her role on the current primary affiliation (the affiliation fact's `role`, e.g. captain); null when absent. */
  role: string | null;
}

export interface MeOverview {
  version: typeof KNOWLEDGE_VIEW_VERSION;
  athleteId: string;
  identity: MeIdentity;
  knows: { total: number; categories: Array<{ key: CategoryKey; title: string; count: number | null; state: KnowledgeCategory["state"] }> };
  /**
   * Slice 2 (O-10): the entry point into My Intelligence — pageState, score and evidenceAsOf from the SAME state
   * function as GET /me/intelligence, so Me can never show a score the page withholds. Never legacy. (knowledge/2)
   */
  intelligence: MyIntelligenceEntry;
  /** Slice 3. */
  story: { status: "coming" };
}

/** A cited research evidence row behind a fact (research_evidence, cited lineage, not suspect). */
export interface EvidenceLink { url: string; domain: string | null; sourceType?: string | null; category?: string | null }

/** knowledge/3: the canonical affiliation fact a `found` ledger row was synced from (athlete_affiliations.fact_id). */
export interface AffiliationFactInfo { factId: string; org: string; status: Fact["status"]; authorityTier: number | null; evidenceIds: string[]; domains: string[]; roleSeason: number | null }

export interface KnowledgeExtras {
  /** research_evidence id → public URL, for Fact.evidenceIds (cited, non-suspect only). knowledge/3 adds source type + category. */
  evidenceUrls: Map<string, EvidenceLink>;
  /** Latest connected follower count per platform (social_analytics_snapshots, source=connected). */
  followers: Array<{ platform: string; followers: number | null; day: string | null }>;
  /** Brands with an accepted/completed deal the inbox pipeline found (deals.source = inbox_scan) — names only, never amounts. */
  inboxPartners: string[];
  /** knowledge/3: ledger row id → the affiliation fact it was synced from. A `found` row absent here is legacy and not shown. */
  affiliationFacts?: Map<string, AffiliationFactInfo>;
  /** knowledge/3: lower-cased brand name → its known domain (inbox_brands), for logos only. */
  brandDomains?: Map<string, string>;
  /** lower-cased brand name → its stored logo_url (inbox_brands), for logos only. */
  brandLogoUrls?: Map<string, string>;
  /** (Density pass) lower-cased brand name → the inbox_brands row id and its research, for the brand deck only. */
  brandProfiles?: Map<string, { brandId: number; profile: BrandProfile | null }>;
  /** knowledge/3: her disputes / confirmations (athlete_asserted `dispute` · `claim_confirmation`). */
  verdicts?: KnowledgeVerdicts;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const correction = (field: AssertedField, raw?: unknown): KnowledgeCorrection => {
  const spec = ASSERTED_FIELDS[field];
  return { field, shape: spec.shape, label: spec.label, ...(raw !== undefined ? { raw } : {}) };
};

function missingFor(ctx: CanonicalAthleteContext, domain: ResearchDomain | null): EntryState {
  if (!domain) return "unknown";
  return ctx.coverage[domain] === "unavailable" ? "not_yet_computed" : "unknown";
}

type Core = Omit<KnowledgeEntry, "tier" | "logoDomain" | "logoUrl" | "ref" | "yourDispute" | "meta">;
/** An entry with the knowledge/3 parts defaulted (no tier until something is present). */
const entry = (e: Core & Partial<Pick<KnowledgeEntry, "tier" | "logoDomain" | "logoUrl" | "ref" | "meta">>): KnowledgeEntry =>
  ({ ...e, tier: e.state === "present" ? e.tier ?? null : null, logoDomain: e.logoDomain ?? null, logoUrl: e.logoUrl ?? null, ref: e.ref ?? null, yourDispute: null, meta: e.meta ?? null });

const blank = (id: string, label: string, state: EntryState, correct: KnowledgeCorrection | null = null): KnowledgeEntry =>
  entry({ id, label, value: null, state, source: null, status: null, stale: false, at: null, evidence: [], correct });

/** Source types that speak for the team / school / governing body itself (research/registries tier ≤ 2). */
const OFFICIAL_SOURCE_TYPES = new Set(["official_governing_body", "official_team_or_school"]);
const linksOf = (ids: string[], x: KnowledgeExtras) => ids.map((e) => x.evidenceUrls.get(e)).filter((e): e is EvidenceLink => !!e);
const publicLinks = (links: EvidenceLink[]) => links.slice(0, 3).map((l) => ({ url: l.url, domain: l.domain }));
/** PRESENTATION ONLY: the official site behind a fact (its first team/school/governing-body source). Never authority. */
const officialDomainOf = (links: EvidenceLink[]): string | null => links.find((l) => l.domain && OFFICIAL_SOURCE_TYPES.has(l.sourceType ?? ""))?.domain ?? null;

function factEntry<T>(id: string, label: string, f: Fact<T> | null, render: (v: T) => string | null, x: KnowledgeExtras, ctx: CanonicalAthleteContext, domain: ResearchDomain | null, correct: KnowledgeCorrection | null, omit: { n: number }, more: { logo?: boolean; meta?: (v: T) => KnowledgeMeta | null } = {}): KnowledgeEntry {
  const source = sourceOf(f);
  if (f && !source) omit.n++;
  const value = f && source ? render(f.value) : null;
  if (!f || !source || !value) return blank(id, label, missingFor(ctx, domain), correct);
  const links = linksOf(f.evidenceIds, x);
  return entry({
    id, label, value, state: "present", source, status: f.status, stale: f.freshness === "stale", at: f.retrievedAt,
    evidence: publicLinks(links), correct,
    tier: tierOfFact(f, x.verdicts), ref: f.factId ? { kind: "fact", id: f.factId } : null,
    logoDomain: more.logo ? officialDomainOf(links) : null, meta: more.meta ? more.meta(f.value) : null,
  });
}

/** Said wins for display (the same precedence the Record keeps): an assertion, else the canonical fact. */
function saidOrFact<T>(said: Map<string, AssertionRecord>, field: AssertedField, id: string, label: string, f: Fact<T> | null, render: (v: T) => string | null, x: KnowledgeExtras, ctx: CanonicalAthleteContext, domain: ResearchDomain | null, omit: { n: number }): KnowledgeEntry {
  const s = said.get(field);
  if (s && s.value) return entry({ id, label, value: s.value, state: "present", source: src("you", s.mode === "voice" || s.source === "onboarding" ? "told Mila" : null), status: "current", stale: false, at: s.at, evidence: [], correct: correction(field, s.raw), tier: "established" });
  return factEntry(id, label, f, render, x, ctx, domain, correction(field), omit);
}

const year4 = (d: string | null) => (d ? d.slice(0, 4) : null);
const span = (a: AffiliationRow) => (a.to ? `${a.from ? a.from.slice(0, 4) + "–" : ""}${a.to.slice(0, 4)}` : a.from ? `since ${a.from.slice(0, 4)}` : null);
/** The career timeline's span: "2023 – present" for a current row with a start; "2021 – 2023"; "2024"; null. */
const timelineSpan = (a: AffiliationRow): string | null => {
  const from = year4(a.from), to = year4(a.to);
  if (a.current) return from ? `${from} – present` : null;
  return from && to && from !== to ? `${from} – ${to}` : to ?? from;
};

/** Counted = present, current and not disputed by her. */
function tally(entries: KnowledgeEntry[]): { count: number; bySource: Partial<Record<SourceKey, number>> } {
  const counted = entries.filter((e) => e.state === "present" && e.status === "current" && e.source && !e.yourDispute);
  const bySource: Partial<Record<SourceKey, number>> = {};
  for (const e of counted) bySource[e.source!.key] = (bySource[e.source!.key] ?? 0) + 1;
  return { count: counted.length, bySource };
}

/** Her verdicts on the entries (in place): a denial or a dispute reads unconfirmed and carries her words. */
function applyVerdicts(entries: KnowledgeEntry[], v: KnowledgeVerdicts): void {
  for (const e of entries) {
    if (e.state !== "present") continue;
    const key = e.ref ? refKey(e.ref) : null;
    const note = (key ? v.refDisputes.get(key) : undefined) ?? v.entryDisputes.get(e.id) ?? (key && v.denied.has(key) ? { said: null, at: null } : undefined);
    if (note) { e.yourDispute = note; e.tier = "unconfirmed"; }
  }
}

// ─── research freshness ────────────────────────────────────────────────────────

/** Research domains whose results this view shows. `signals` and `narrative` are not shown, so they cannot date it. */
export const KNOWLEDGE_DOMAINS: readonly ResearchDomain[] = ["identity", "profile", "affiliations", "achievements", "press", "brand_mentions", "social_handles"];

/**
 * The newest per-domain lastResearchedAt across the domains shown. A domain's date advances ONLY on a fresh outcome
 * (`refreshed` | `confirmed_empty`, research/outcomes.ts), so a failed or no_relevant attempt never moves it. The
 * athlete-wide `last_researched_at` (ctx.freshness.researchAsOf) is not used: any fresh domain advances it, including
 * `signals`, and it falls back to the legacy blob's date, which this view does not show. Null when nothing shown has
 * ever refreshed — the truthful unknown.
 */
export function knowledgeResearchAsOf(ctx: CanonicalAthleteContext): string | null {
  let best: string | null = null;
  for (const d of KNOWLEDGE_DOMAINS) {
    const at = ctx.freshness.byDomain[d]?.lastResearchedAt ?? null;
    if (at && !Number.isNaN(Date.parse(at)) && (!best || Date.parse(at) > Date.parse(best))) best = at;
  }
  return best;
}

// ─── identity ─────────────────────────────────────────────────────────────────

/**
 * knowledge/3: the teams Nomila may show — canonical facts + her said / proof rows. A legacy `found` ledger row (no live
 * affiliation fact behind it, i.e. absent from `affiliationFacts`) is hidden (suggestion J). The ONE rule for both the
 * Knows career and the Me header, so they never disagree. `current` = the primary current shown row, else the first
 * current one (the builder's own rule, applied to the shown rows).
 */
export function shownAffiliations(ctx: CanonicalAthleteContext, affiliationFacts?: ReadonlyMap<string, unknown>): { shown: AffiliationRow[]; current: AffiliationRow | null; hidden: number } {
  const facts = affiliationFacts ?? new Map<string, unknown>();
  const shown = ctx.affiliations.all.filter((a) => a.kindOfFact !== "found" || facts.has(a.id));
  return { shown, current: shown.find((a) => a.current && a.primary) ?? shown.find((a) => a.current) ?? null, hidden: ctx.affiliations.all.length - shown.length };
}

export function identityOf(ctx: CanonicalAthleteContext, affiliationFacts?: ReadonlyMap<string, unknown>): MeIdentity {
  const said = new Map(ctx.assertions.map((a) => [a.field, a]));
  const full = ctx.identity.name.value.full;
  const displayName = said.get("nickname")?.value?.trim() || ctx.identity.firstName?.trim() || full.split(/\s+/)[0] || full;
  const sport = said.get("sport")?.value?.trim() || (sourceOf(ctx.identity.sport) ? ctx.identity.sport?.value.sport ?? null : null);
  const cur = shownAffiliations(ctx, affiliationFacts).current;
  const org = cur ? (cur.kind === "school" ? schoolShort(cur.org) : cur.org) : null;
  const label = [org, sport ? titleCase(sport) : null].filter(Boolean).join(" ");
  const primary = label
    ? { label, org: cur?.org ?? null, orgKind: cur?.kind ?? null, sport: sport ? titleCase(sport) : null, source: cur ? affiliationSourceOf(cur) : said.get("sport") ? src("you") : sourceOf(ctx.identity.sport) }
    : null;
  const position = said.get("position")?.value || (sourceOf(ctx.profile.position) ? ctx.profile.position?.value.text : null) || null;
  const classYear = said.get("class_year")?.value || (sourceOf(ctx.profile.classYear) ? ctx.profile.classYear?.value.label : null) || null;
  // Nationality is a multi fact: every current, sourced value once, in the order the builder holds them.
  const countries = ctx.identity.nationality
    .filter((f) => sourceOf(f))
    .map((f) => { const v = f.value as { country?: string | null; text?: string | null }; return (v.country ?? v.text ?? "").trim(); })
    .filter((v, i, all) => !!v && all.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i);
  const nationality = countries.length ? countries.join(" · ") : null;
  const role = cur?.role?.trim() ? titleCase(cur.role.trim()) : null;
  return { displayName, fullName: full, photoUrl: ctx.identity.photoUrl, primary, facts: [position, classYear].filter((v): v is string => !!v), nationality, role };
}

// ─── the view ─────────────────────────────────────────────────────────────────

/** Org name → the grouping form used to match a team row to the affiliation fact that carries its logo domain. */
export const orgKey = (org: string | null | undefined): string => String(org ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** An age group as written in a team or level ("U-17", "U17", "u 20") → "U-17"; null when there is none. Generic: no sport or country. */
export const ageGroupOf = (...texts: Array<string | null | undefined>): string | null => {
  for (const t of texts) { const m = String(t ?? "").match(/\bU\s?-?\s?(\d{2})\b/i); if (m) return `U-${m[1]}`; }
  return null;
};

/**
 * (Oct 2026) ONE entry per real-world item. Research runs restate the same item in different words, so facts whose
 * STRUCTURED identity matches (the caller's key: e.g. age group + year, or season + metric + value) collapse into one:
 * the strongest-tier fact is shown, carrying every source behind the group. Never a text-similarity guess — a null key
 * never merges — and a fact she disputed is left on its own so her verdict stays on the entry she named. Display only:
 * the facts themselves are untouched.
 */
export function collapseSameFacts<T>(facts: Fact<T>[], keyOf: (v: T) => string | null, v: KnowledgeVerdicts): Fact<T>[] {
  const out: Fact<T>[] = [];
  const at = new Map<string, number>();
  for (const f of facts) {
    const ref = f.factId ? `fact:${f.factId}` : null;
    const k = keyOf(f.value);
    if (!k || (ref && (v.denied.has(ref) || v.refDisputes.has(ref)))) { out.push(f); continue; }
    const i = at.get(k);
    if (i === undefined) { at.set(k, out.length); out.push(f); continue; }
    const prev = out[i];
    // Strongest tier first; on a tie, the fact that states more (e.g. carries the role).
    const filled = (x: Fact<T>) => Object.values((x.value ?? {}) as Record<string, unknown>).filter((y) => y != null && y !== "").length;
    const dt = TIER_RANK[tierOfFact(f, v)] - TIER_RANK[tierOfFact(prev, v)];
    const better = dt < 0 || (dt === 0 && filled(f) > filled(prev));
    const keep = better ? f : prev;
    out[i] = { ...keep, evidenceIds: [...new Set([...keep.evidenceIds, ...(better ? prev : f).evidenceIds])] };
  }
  return out;
}

const classYearText = (v: { label: string; season?: number | null }) => [titleCase(v.label), v.season ? `${v.season} season` : null].filter(Boolean).join(" · ") || null;

export function knowledgeView(b: BuiltContext, x0: KnowledgeExtras): AthleteKnowledge {
  const { ctx } = b;
  const v = x0.verdicts ?? NO_KNOWLEDGE_VERDICTS;
  const x: KnowledgeExtras = { ...x0, verdicts: v };
  const said = new Map(ctx.assertions.map((a) => [a.field, a]));
  const omit = { n: 0 };
  const reg = ctx.registryFacts ?? { rankings: [], nationalTeam: [], seasonStatistics: [], endorsements: [] };
  // (Oct 2026) a found team whose fact she denied (she removed it from her teams) no longer backs its row, so it is
  // hidden like any untraceable found row — removing a team removes it, here and in the Me header. The fact and its
  // evidence stay as research history.
  const affFacts = new Map([...(x.affiliationFacts ?? new Map<string, AffiliationFactInfo>())].filter(([, f]) => !v.denied.has(`fact:${f.factId}`)));
  const brandLogo = (brand: string) => x.brandDomains?.get(brand.trim().toLowerCase()) ?? null;
  const brandLogoUrl = (brand: string) => x.brandLogoUrls?.get(brand.trim().toLowerCase()) ?? null;
  // (Density pass) the brand's inbox_brands id and research ride its entry — keys present only when the brand is known,
  // so a view without profiles is byte-for-byte what it was.
  const brandBits = (brand: string): Pick<KnowledgeEntry, "brandId" | "brandProfile"> => {
    const p = x.brandProfiles?.get(brand.trim().toLowerCase());
    return p ? { brandId: p.brandId, brandProfile: p.profile } : {};
  };
  // The Me header reads the same shown teams as the career below (shownAffiliations).
  const identity = identityOf(ctx, affFacts);

  // ── teams: canonical facts + her said / proof rows. A legacy `found` row (no fact_id) is not shown (suggestion J). ──
  const { shown, current: cur, hidden } = shownAffiliations(ctx, affFacts);
  omit.n += hidden;
  // PRESENTATION ONLY: an org's logo domain = the official source of any affiliation fact for that org (said rows included).
  const orgLogo = new Map<string, string>();
  for (const info of affFacts.values()) {
    const d = officialDomainOf(linksOf(info.evidenceIds, x)) ?? (info.authorityTier != null && info.authorityTier <= AUTHORITATIVE_TIER ? info.domains[0] ?? null : null);
    if (d && info.org && !orgLogo.has(orgKey(info.org))) orgLogo.set(orgKey(info.org), d);
  }
  const teamTier = (a: AffiliationRow): KnowledgeTier => { const f = affFacts.get(a.id); return a.kindOfFact === "found" && f ? tierOfFact({ status: f.status, factId: f.factId }, v) : "established"; };
  const teamRef = (a: AffiliationRow): KnowledgeRef | null => { const f = a.kindOfFact === "found" ? affFacts.get(a.id) : undefined; return f ? { kind: "fact", id: f.factId } : null; };
  const teamEvidence = (a: AffiliationRow) => { const f = a.kindOfFact === "found" ? affFacts.get(a.id) : undefined; return f ? publicLinks(linksOf(f.evidenceIds, x)) : []; };
  const roleOf = (a: AffiliationRow): string | null => {
    if (!a.role?.trim()) return null;
    const season = affFacts.get(a.id)?.roleSeason;
    return `${titleCase(a.role.trim())}${season ? ` (${season})` : ""}`;
  };

  // ── key facts (at a glance) ──
  const teamList = shown.map((t) => ({ org: t.org, kind: t.kind, level: t.level, conference: t.conference, role: t.role, position: t.position, from: t.from, to: t.to, primary: t.primary, fact: t.kindOfFact }));
  const teamsCorrection = (index: number | null) => correction("affiliations", { index, teams: teamList });
  const teamEntry = (t: AffiliationRow, i: number, label: string, value: string): KnowledgeEntry => entry({
    id: `team_${t.id}`, label, value, state: "present", source: affiliationSourceOf(t), status: t.current ? "current" : "historical", stale: false, at: t.recordedAt,
    evidence: teamEvidence(t), correct: teamsCorrection(i), tier: teamTier(t), ref: teamRef(t), logoDomain: orgLogo.get(orgKey(t.org)) ?? null,
    meta: { org: t.org, orgKind: t.kind, span: timelineSpan(t), role: roleOf(t), year: null },
  });
  const name: KnowledgeEntry = entry({ id: "name", label: "Name", value: ctx.identity.name.value.full, state: "present", source: src("you", "at signup"), status: "current", stale: false, at: ctx.identity.name.retrievedAt, evidence: [], correct: null, tier: "established" });
  const school: KnowledgeEntry = cur
    ? teamEntry(cur, shown.indexOf(cur), cur.kind === "school" ? "School" : "Team", cur.org)
    : blank("school", "School", missingFor(ctx, "affiliations"), teamsCorrection(null));
  const sportEntry = saidOrFact(said, "sport", "sport", "Sport", ctx.identity.sport, (s) => titleCase(s.sport), x, ctx, "identity", omit);
  const position = saidOrFact(said, "position", "position", "Position", ctx.profile.position, (p) => p.text, x, ctx, "profile", omit);
  const hometown = saidOrFact(said, "hometown", "hometown", "Hometown", ctx.identity.hometown, (h) => [h.city, h.region, h.country].filter(Boolean).join(", ") || null, x, ctx, "identity", omit);
  const graduation = factEntry("graduation_year", "Graduation", ctx.profile.graduationYear, (g) => String(g.year), x, ctx, "profile", null, omit);
  const classYear = saidOrFact(said, "class_year", "class_year", "Class", ctx.profile.classYear, classYearText, x, ctx, "profile", omit);
  // Nationality is a multi fact: every current, sourced value once (the same rule as identityOf).
  const natFacts = ctx.identity.nationality.filter((f) => sourceOf(f));
  omit.n += ctx.identity.nationality.length - natFacts.length;
  const countryOf = (f: Fact<any>) => String(f.value?.country ?? f.value?.text ?? "").trim();
  const countries = natFacts.map(countryOf).filter((c, i, all) => !!c && all.findIndex((y) => y.toLowerCase() === c.toLowerCase()) === i);
  const nationality: KnowledgeEntry = countries.length
    ? entry({
      id: "nationality", label: "Nationality", value: countries.join(" · "), state: "present", source: sourceOf(natFacts[0]), status: "current", stale: natFacts.some((f) => f.freshness === "stale"),
      at: natFacts[0].retrievedAt, evidence: publicLinks(natFacts.flatMap((f) => linksOf(f.evidenceIds, x))), correct: null,
      // Several values: the weakest of them, so the line never reads firmer than any part of it.
      tier: natFacts.map((f) => tierOfFact(f, v)).sort((a, z) => TIER_RANK[z] - TIER_RANK[a])[0], ref: natFacts[0].factId ? { kind: "fact", id: natFacts[0].factId } : null,
    })
    : blank("nationality", "Nationality", missingFor(ctx, "identity"));
  // The school key fact IS the current-team entry (same id), so the total counts that affiliation once.
  const keyFacts = [name, school, sportEntry, position, hometown, nationality, classYear];

  // ── athletics ──
  const lv = ctx.affiliations.level;
  const levelValue = [lv.division, lv.conference].filter(Boolean).join(" · ") || null;
  const level: KnowledgeEntry = levelValue && cur
    ? entry({ id: "level", label: "Level", value: levelValue, state: "present", source: affiliationSourceOf(cur), status: "current", stale: false, at: cur.recordedAt, evidence: [], correct: null, tier: teamTier(cur), ref: teamRef(cur), logoDomain: null })
    : blank("level", "Level", missingFor(ctx, "affiliations"));
  const careerSaid = said.get("career_status");
  const careerValue = careerSaid?.value || careerStatusLabel(ctx.identity.careerStatus.value.status) || null;
  const career: KnowledgeEntry = careerValue
    ? entry({ id: "career_status", label: "Career", value: careerValue, state: "present", source: careerSaid ? src("you") : src("you", "at signup"), status: "current", stale: false, at: careerSaid?.at ?? ctx.identity.careerStatus.retrievedAt, evidence: [], correct: correction("career_status", careerSaid?.raw), tier: "established" })
    : entry({ id: "career_status", label: "Career", value: null, state: "unknown", source: null, status: "current", stale: false, at: careerSaid?.at ?? ctx.identity.careerStatus.retrievedAt, evidence: [], correct: correction("career_status", careerSaid?.raw) });
  const profile: KnowledgeSection = { key: "profile", title: "Profile", entries: [sportEntry, position, classYear, graduation, level, career] };

  // (Oct 2026) a national-team entry names its age group (U-17 2022 and U-19 2024 are different teams), and research's
  // restatements of the same age group + year collapse into one entry.
  const ageNotInTeam = (n: { team?: string | null; level: string }) => { const ag = ageGroupOf(n.level, n.team); return ag && n.team && !ageGroupOf(n.team) ? ag : null; };
  const nationalTeam = collapseSameFacts(reg.nationalTeam, (n) => { const ag = ageGroupOf(n.level, n.team); return ag && n.year ? `${ag}|${n.year}` : null; }, v).map((f, i) => factEntry(`national_${f.factId ?? i}`, "National team", f,
    (n) => [n.team ?? `${titleCase(n.level)} national team`, ageNotInTeam(n), n.event, n.result, `(${n.year})`].filter(Boolean).join(" · ").replace(" · (", " ("), x, ctx, "achievements", null, omit,
    { logo: true, meta: (n) => ({ org: [n.team ?? `${titleCase(n.level)} national team`, ageNotInTeam(n)].filter(Boolean).join(" · "), orgKind: "national", span: String(n.year), role: n.role ? titleCase(n.role) : null, year: n.year }) })).filter((e) => e.state === "present");
  const teams: KnowledgeSection = {
    key: "teams", title: "Athletic career",
    entries: [
      ...shown.map((t, i) => teamEntry(t, i, t.current ? (t.primary ? "Current team" : "Also plays for") : "Past team",
        [displayTeam(t as any), [t.role, t.position, span(t)].filter(Boolean).join(" · ") || null].filter(Boolean).join(" — "))),
      ...nationalTeam,
    ],
  };
  if (!teams.entries.length) teams.entries.push(blank("teams", "Teams", missingFor(ctx, "affiliations"), teamsCorrection(null)));

  // Academic honours (evidence category `academic`, item-mapping academic_honors) move to Academics.
  const isAcademic = (f: Fact<any>) => linksOf(f.evidenceIds, x).some((l) => l.category === "academic");
  const honourOf = (f: CanonicalAthleteContext["achievements"][number], i: number, label: string) => factEntry(`achievement_${f.factId ?? i}`, label, f,
    (h) => (h.year ? `${h.name} (${h.year})` : h.name), x, ctx, "achievements", null, omit, { meta: (h) => ({ year: h.year != null ? Number(h.year) || null : null }) });
  // (Oct 2026) the same honour stated twice (same name, case and punctuation aside, same year) is one entry.
  const named = collapseSameFacts(ctx.achievements.filter((f) => f.value.name), (h) => `${orgKey(h.name)}|${h.year ?? ""}`, v);
  const honours: KnowledgeEntry[] = [
    ...named.filter((f) => !isAcademic(f)).map((f, i) => honourOf(f, i, f.value.key === "award" ? "Award" : "Achievement")),
    ...collapseSameFacts(reg.rankings, (r) => `${orgKey(r.body)}|${r.rank}|${r.year}`, v).map((f, i) => factEntry(`ranking_${f.factId ?? i}`, "Ranking", f, (r) => `#${r.rank} ${r.scope} — ${r.body} (${r.year})`, x, ctx, "achievements", null, omit, { meta: (r) => ({ year: r.year }) })),
  ].filter((e) => e.state === "present");
  const honoursSection: KnowledgeSection = { key: "honours", title: "Recognition & honours", entries: honours.length ? honours : [blank("honours", "Honours", missingFor(ctx, "achievements"))] };
  // (Oct 2026) one season's metric with one value is one statistic, whatever competition label each source gave it.
  const stats = collapseSameFacts(reg.seasonStatistics, (s) => `${s.season}|${orgKey(s.metric)}|${s.value}`, v).map((f, i) => factEntry(`stat_${f.factId ?? i}`, `${f.value.season} ${f.value.competition ?? "season"}`, f, (s) => `${s.metric}: ${s.value}`, x, ctx, "achievements", null, omit, { meta: (s) => ({ year: s.season }) })).filter((e) => e.state === "present");
  const athletics: KnowledgeSection[] = [profile, teams, honoursSection, ...(stats.length ? [{ key: "statistics", title: "Statistics", entries: stats }] : [])];

  // ── academics: education facts (registry v3) + academic honours ──
  const education = (reg.education ?? []).map((f, i) => factEntry(`education_${f.factId ?? i}`, f.value.status === "completed" ? "Degree" : "Studies", f,
    (e) => [e.degree ?? e.program ?? null, e.institution].filter(Boolean).join(" · ") || null, x, ctx, "profile", null, omit,
    { logo: true, meta: (e) => ({ org: e.institution, orgKind: "school", span: e.startYear && e.endYear && e.startYear !== e.endYear ? `${e.startYear} – ${e.endYear}` : e.endYear ? String(e.endYear) : e.startYear ? `since ${e.startYear}` : null, year: e.endYear ?? null }) }))
    .filter((e) => e.state === "present");
  // An institution she also plays for shares the team's logo (presentation only).
  for (const e of education) if (!e.logoDomain && e.meta?.org) e.logoDomain = orgLogo.get(orgKey(e.meta.org)) ?? null;
  const academicHonours = named.filter(isAcademic).map((f, i) => honourOf(f, i, "Academic honour")).filter((e) => e.state === "present");
  const academics: KnowledgeSection[] = [
    ...(education.length ? [{ key: "education", title: "Education", entries: education }] : []),
    ...(academicHonours.length ? [{ key: "academic_honours", title: "Academic honours", entries: academicHonours }] : []),
  ];

  // ── partnerships ──
  const confirmed = ctx.commercial.confirmedPartners.map((brand, i): KnowledgeEntry => ({ ...entry({ id: `partner_${i}`, label: "Partner", value: brand, state: "present", source: src("proof"), status: "current", stale: false, at: null, evidence: [], correct: null, tier: "established", logoDomain: brandLogo(brand), logoUrl: brandLogoUrl(brand) }), ...brandBits(brand) }));
  // Inbox-accepted deals: a model read a signature in her email, she did not confirm it — so "From your inbox", never
  // "From your deals". A brand she also confirmed keeps the confirmed entry only (one brand, one entry, counted once).
  // Tier: an accepted/completed deal is an earned commercial record (Part B, earnedDealStatuses) → established.
  const partnerKeys = new Set(ctx.commercial.confirmedPartners.map((brand) => brand.trim().toLowerCase()));
  const fromInbox = x.inboxPartners.filter((brand) => { const k = brand.trim().toLowerCase(); if (!k || partnerKeys.has(k)) return false; partnerKeys.add(k); return true; })
    .map((brand, i): KnowledgeEntry => ({ ...entry({ id: `partner_inbox_${i}`, label: "Partner", value: brand.trim(), state: "present", source: src("inbox"), status: "current", stale: false, at: null, evidence: [], correct: null, tier: "established", logoDomain: brandLogo(brand), logoUrl: brandLogoUrl(brand) }), ...brandBits(brand) }));
  const yours = [...confirmed, ...fromInbox];
  const endorsements = reg.endorsements.map((f, i) => factEntry(`endorsement_${f.factId ?? i}`, titleCase(f.value.dealType.replace(/_/g, " ")), f, (e) => [e.brand, e.campaign, e.startDate ? e.startDate.slice(0, 4) : null].filter(Boolean).join(" · "), x, ctx, "brand_mentions", null, omit,
    { meta: (e) => ({ org: e.brand, year: e.startDate ? Number(e.startDate.slice(0, 4)) || null : null }) }))
    .filter((e) => e.state === "present");
  for (const e of endorsements) { e.logoDomain = e.meta?.org ? brandLogo(e.meta.org) : null; e.logoUrl = e.meta?.org ? brandLogoUrl(e.meta.org) : null; if (e.meta?.org) Object.assign(e, brandBits(e.meta.org)); }
  const seenWith = dedupeBrands(ctx.brandMentions).map((e, i): KnowledgeEntry | null => {
    const source = evidenceSourceOf(e);
    if (!source) { if (e.lineage === "legacy") omit.n++; return null; }
    return { ...entry({ id: `brand_seen_${e.evidenceId ?? i}`, label: "Seen with", value: e.value.brand, state: "present", source, status: "current", stale: false, at: e.publishedAt ?? e.retrievedAt, evidence: e.sourceUrl ? [{ url: e.sourceUrl, domain: e.sourceDomain ?? null }] : [], correct: null,
      tier: tierOfEvidence(e, v), ref: e.evidenceId ? { kind: "evidence", id: e.evidenceId } : null, logoDomain: brandLogo(e.value.brand), logoUrl: brandLogoUrl(e.value.brand), meta: { org: e.value.brand } }), ...brandBits(e.value.brand) };
  }).filter((e): e is KnowledgeEntry => !!e);
  const partnerships: KnowledgeSection[] = [
    { key: "confirmed", title: "Your partnerships", entries: yours.length ? yours : [blank("confirmed", "Your partnerships", "unknown")] },
    ...(endorsements.length ? [{ key: "reported", title: "Reported partnerships", entries: endorsements }] : []),
    { key: "seen", title: "Brands seen with you", entries: seenWith.length ? seenWith : [blank("seen", "Brands seen with you", missingFor(ctx, "brand_mentions"))] },
  ];

  // ── media & audience ──
  const press = ctx.press.map((e, i): KnowledgeEntry | null => {
    const source = evidenceSourceOf(e);
    if (!source) { if (e.lineage === "legacy") omit.n++; return null; }
    return entry({ id: `press_${e.evidenceId ?? i}`, label: e.value.outlet ?? e.sourceDomain ?? "Press", value: e.value.headline ?? e.value.outlet ?? null, state: "present", source, status: "current", stale: false, at: e.publishedAt ?? e.retrievedAt, evidence: e.sourceUrl ? [{ url: e.sourceUrl, domain: e.sourceDomain ?? null }] : [], correct: null,
      tier: tierOfEvidence(e, v), ref: e.evidenceId ? { kind: "evidence", id: e.evidenceId } : null });
  }).filter((e): e is KnowledgeEntry => !!e && !!e.value);
  // Handles: connected, typed by her, or read from the platform itself → established (athlete authority / connected
  // measurement, Part B); a handle research found has no reputable source of its own → unconfirmed; inferred → unconfirmed.
  const handles = Object.entries(ctx.social.handles).filter(([, h]) => h.origin !== "legacy_blob").map(([p, h]): KnowledgeEntry => entry({
    id: `handle_${p}`, label: p === "x" ? "X" : titleCase(p), value: `@${h.handle}`, state: "present",
    source: h.connected ? src("connected") : h.sourceClass === "entered" ? src("you") : h.sourceClass === "inferred" || h.sourceClass === "imputed" ? src("inferred") : src("researched"),
    status: "current", stale: false, at: null, evidence: [], correct: null,
    tier: h.connected || h.sourceClass === "entered" || h.sourceClass === "platform_public" ? "established" : "unconfirmed",
  }));
  const followers = x.followers.filter((f) => f.followers != null).map((f): KnowledgeEntry => entry({ id: `followers_${f.platform}`, label: `${f.platform === "x" ? "X" : titleCase(f.platform)} followers`, value: compact(Number(f.followers)), state: "present", source: src("connected"), status: "current", stale: false, at: f.day, evidence: [], correct: null, tier: "established" }));
  const au = ctx.audience;
  const audienceValue = au.connected ? [au.gender ? (au.gender === "F" ? "Mostly women" : au.gender === "M" ? "Mostly men" : au.gender) : null, au.ageRange, au.topCity].filter(Boolean).join(" · ") || null : null;
  const audience: KnowledgeEntry = audienceValue
    ? entry({ id: "audience", label: "Audience", value: audienceValue, state: "present", source: src("connected", au.platform ? titleCase(au.platform) : null), status: "current", stale: false, at: au.asOf, evidence: [], correct: null, tier: "established" })
    : blank("audience", "Audience", "unavailable");
  const media: KnowledgeSection[] = [
    { key: "press", title: "Press", entries: press.length ? press : [blank("press", "Press", missingFor(ctx, "press"))] },
    { key: "social", title: "Social", entries: [...handles, ...followers, audience] },
  ];

  // ── interests (her own words) ──
  const listEntry = (field: "hobbies" | "brands_causes", label: string): KnowledgeEntry => {
    const s = said.get(field);
    return s?.value
      ? entry({ id: field, label, value: s.value, state: "present", source: src("you"), status: "current", stale: false, at: s.at, evidence: [], correct: correction(field, s.raw), tier: "established" })
      : blank(field, label, "unknown", correction(field));
  };
  const interests: KnowledgeSection[] = [{ key: "interests", title: "In your words", entries: [listEntry("hobbies", "Off the field"), listEntry("brands_causes", "Brands & causes")] }];

  // Her "This isn't right" verdicts, before anything is counted.
  const all = [...keyFacts, ...[...athletics, ...academics, ...partnerships, ...media, ...interests].flatMap((s) => s.entries)];
  applyVerdicts([...new Set(all)], v);

  const category = (key: CategoryKey, title: string, blurb: string, sections: KnowledgeSection[]): KnowledgeCategory => {
    const t = tally(sections.flatMap((s) => s.entries));
    return { key, title, blurb, state: t.count > 0 ? "present" : "unknown", count: t.count, bySource: t.bySource, sections };
  };
  const unavailable = (key: CategoryKey, title: string, blurb: string): KnowledgeCategory => ({ key, title, blurb, state: "unavailable", count: null, bySource: {}, sections: [] });

  const categories: KnowledgeCategory[] = [
    category("athletics", "Athletics", "Your sport, teams, level and honours.", athletics),
    category("partnerships", "Partnerships", "Brands you've worked with, and brands seen with you.", partnerships),
    category("media", "Media & audience", "Press, your accounts and who follows you.", media),
    category("interests", "Interests", "What you care about, in your words.", interests),
    // knowledge/3: present with an education fact or an academic honour; otherwise the invite (no source has answered yet).
    academics.length
      ? category("academics", "Academics", "Your studies and academic honours.", academics)
      : unavailable("academics", "Academics", "Nothing on record about your studies yet."),
    // Ventures are evidence-only (no registry key): the invite state.
    unavailable("business", "Business", "Nomila doesn't track ventures yet."),
  ];
  const everything = [...keyFacts, ...categories.flatMap((c) => c.sections.flatMap((s) => s.entries))];
  const seen = new Set<string>();
  const unique = everything.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  const t = tally(unique);
  return {
    version: KNOWLEDGE_VIEW_VERSION, athleteId: ctx.athleteId, builtAt: ctx.builtAt, researchAsOf: knowledgeResearchAsOf(ctx),
    identity, keyFacts, categories, total: t.count, bySource: t.bySource, omitted: { legacyValues: omit.n },
  };
}

const TIER_RANK: Record<KnowledgeTier, number> = { established: 0, reported: 1, unconfirmed: 2 };

function dedupeBrands<T extends { value: { brand: string } }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((e) => { const k = e.value.brand.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

/** Every entry of a knowledge view (at a glance + every section), each once — what the dispute route looks an id up in. */
export function knowledgeEntries(k: AthleteKnowledge): KnowledgeEntry[] {
  const seen = new Set<string>();
  return [...k.keyFacts, ...k.categories.flatMap((c) => c.sections.flatMap((s) => s.entries))].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

export function meOverview(k: AthleteKnowledge, intelligence: MyIntelligenceEntry): MeOverview {
  return {
    version: KNOWLEDGE_VIEW_VERSION, athleteId: k.athleteId, identity: k.identity,
    knows: { total: k.total, categories: k.categories.map((c) => ({ key: c.key, title: c.title, count: c.count, state: c.state })) },
    intelligence, story: { status: "coming" },
  };
}
