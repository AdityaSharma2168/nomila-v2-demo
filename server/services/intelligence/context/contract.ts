/**
 * context/contract.ts — CanonicalAthleteContext v1 (Phase A Step 2d design §2.2, frozen 11 Sep 2026).
 *
 * ONE contract for every downstream reader. Facts, inferences, assertions and provenance stay
 * distinct; every value says where it came from, how authoritative it is, when it was retrieved and
 * whether it is fresh. Source authority: connected_verified > platform_public > web_researched >
 * inferred > imputed; legacy compatibility data (origin legacy_*) carries NO source class or tier
 * and ranks below every canonical tier. Types only — no database, no provider.
 */

import type { SourceClass } from "../types";
import type { ResearchDomain } from "../research/registries";

export const CONTEXT_CONTRACT_VERSION = "v1" as const;

export type FactOrigin = "athlete_asserted" | "athlete_proof" | "connection" | "research" | "backfill" | "legacy_row" | "legacy_blob";
/** Evidence lineage: research_evidence.lineage_status as loaded (only CITED_LINEAGES reach the context), or `legacy` (blob). */
export type Lineage = "cited" | "uncited" | "legacy" | "native_supported" | "native_retrieved" | "source_read";
export type Freshness = "fresh" | "stale" | "unknown";
export type SourceMode = "canonical" | "legacy" | "mixed";
/** Per research domain: where a section may come from (design §3.2). */
export type Coverage = "unavailable" | "populated" | "confirmed_empty" | "disputed";
export type ConnectionStatus = "none" | "active" | "expired" | "revoked";

export interface Fact<T = unknown> {
  value: T;
  origin: FactOrigin;
  /** null for assertions/proof (authority above evidence) and for legacy compatibility data (no provenance). */
  sourceClass: SourceClass | null;
  /** 1 (governing body) … 8 (unknown); null for assertions and legacy data. */
  authorityTier: number | null;
  status: "current" | "historical" | "disputed";
  retrievedAt: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  evidenceIds: string[];
  freshness: Freshness;
  factId?: string;
  factKey?: string;
}

export interface Evidence<T = unknown> {
  value: T;
  sourceClass: SourceClass | null;
  sourceType: string | null;
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  retrievedAt: string | null;
  publishedAt?: string | null;
  evidenceId?: string;
  lineage: Lineage;
}

export interface Inference<T = unknown> {
  value: T;
  producer: string;
  /** athlete_inferences.taxonomy_version; null when the producer wrote none (legacy inferences are always null). */
  taxonomyVersion: string | null;
  computedAt: string | null;
  lineage: { runId?: string | null; evidenceIds: string[] };
  legacy: boolean;
  inferenceId?: string;
}

export interface AffiliationRow {
  id: string;
  org: string;
  kind: "school" | "club" | "pro" | "national" | "olympic";
  level: string | null;
  conference: string | null;
  role: string | null;
  position: string | null;
  from: string | null;
  to: string | null;
  primary: boolean;
  current: boolean;
  kindOfFact: "said" | "found" | "proof";
  source: string | null;
  /** When the ledger row was recorded (ISO); null when unknown. */
  recordedAt: string | null;
}

export interface LevelRecord { org: string | null; kind: string | null; division: string | null; conference: string | null; segment: string | null; alsoNational: boolean }

export interface HandleRecord {
  handle: string;
  /** connected_verified (connection) > platform_public > web_researched > inferred > imputed; 'entered' = typed by the athlete (no class). */
  sourceClass: SourceClass | "entered" | null;
  connected: boolean;
  confidence: number | null;
  origin: "social_identity" | "connected_account" | "entered" | "legacy_blob";
}

/** What the athlete told us (athlete_asserted): the display line, the typed value and their own words. */
export interface AssertionRecord { field: string; label: string; value: string; raw: unknown; said: string | null; at: string | null; source: string | null; mode: string | null }

export interface DomainFreshness { status: string | null; outcome: string | null; lastResearchedAt: string | null; staleAfter: string | null }

export interface CanonicalAthleteContext {
  contractVersion: typeof CONTEXT_CONTRACT_VERSION;
  athleteId: string;
  builtAt: string;
  /** The AGGREGATE of `coverage` over the research domains — never silent. */
  sourceMode: SourceMode;
  coverage: Record<ResearchDomain, Coverage>;
  identity: {
    name: Fact<{ full: string; first: string | null; last: string | null }>;
    aliases: Fact<{ text: string; kind: string }>[];
    sport: Fact<{ sport: string; discipline?: string | null }> | null;
    hometown: Fact<{ city?: string | null; region?: string | null; country?: string | null }> | null;
    nationality: Fact<{ text: string }>[];
    careerStatus: Fact<{ status: string }>;
    identityConfidence: number;
    researchStatus: string;
    /** Legacy row bits readers still need until Step 3 (photo, goals, voice); origin legacy_row. */
    firstName: string | null;
    photoUrl: string | null;
    createdAt: string | null;
  };
  affiliations: {
    current: AffiliationRow | null;
    all: AffiliationRow[];
    level: LevelRecord;
    teamsLine: string | null;
  };
  profile: {
    position: Fact<{ text: string }> | null;
    classYear: Fact<{ label: string; season: number }> | null;
    graduationYear: Fact<{ year: number }> | null;
    event: Fact<{ text: string }>[];
  };
  achievements: Fact<{ name: string; year: string | number | null; level: string | null; key: string }>[];
  press: Evidence<{ outlet: string | null; headline: string | null; url?: string | null }>[];
  brandMentions: Evidence<{ brand: string; type: string | null; confidence: number | null }>[];
  nilMentions: Fact<unknown>[];
  /** Registry facts the sections above do not carry (Concept 0.4 Slice 1, additive + optional): rankings and national-team
   *  participation (their values have no `name`, so `achievements` cannot hold them), season statistics and researched
   *  endorsements, each with its own Fact provenance. Canonical only — never read from the legacy blob. */
  registryFacts?: {
    rankings: Fact<{ body: string; rank: number; year: number; scope: string }>[];
    nationalTeam: Fact<{ team?: string | null; level: string; year: number; role?: string | null; event?: string | null; result?: string | null }>[];
    seasonStatistics: Fact<{ metric: string; value: string; season: number; competition?: string | null }>[];
    endorsements: Fact<{ brand: string; dealType: string; category?: string | null; startDate?: string | null; endDate?: string | null; campaign?: string | null }>[];
    /** Registry v3 `education` (profile coverage): current rows only, newest first. Optional so older builders stay valid. */
    education?: Fact<{ institution: string; program?: string | null; degree?: string | null; level?: string | null; status?: string | null; startYear?: number | null; endYear?: number | null }>[];
  };
  /** Inferences, each with producer + lineage. `brandFitTags` exists ONLY as the versioned inference `brand_fit_tags`
   *  (athlete_inferences); the context never manufactures it (D6). Null until a producer writes one. */
  inferences: { storyArc: Inference<string> | null; sentiment: Inference<unknown> | null; brandFitTags: Inference<string[]> | null };
  social: { handles: Record<string, HandleRecord>; connectionStatus: ConnectionStatus; connectedPlatforms: string[] };
  assertions: AssertionRecord[];
  freshness: { byDomain: Partial<Record<ResearchDomain, DomainFreshness>>; researchAsOf: string | null };
  commercial: { confirmedPartners: string[]; commercialState: "active" | "none" };
  audience: { gender: string | null; ageRange: string | null; topCity: string | null; geoCountry: Array<{ key: string; pct: number }>; share: number | null; sourceClass: "connected_verified"; asOf: string | null; connected: boolean; platform: string | null };
  provenanceSummary: { canonicalFacts: number; legacyFacts: number; assertions: number };
}

/** Which contract section each research domain feeds (design §3.2). */
export const DOMAIN_SECTIONS: Record<ResearchDomain, string[]> = {
  identity: ["identity.aliases", "identity.sport", "identity.hometown", "identity.nationality"],
  profile: ["profile"],
  affiliations: ["affiliations (ledger; facts synced in 2d-6)"],
  achievements: ["achievements"],
  press: ["press"],
  brand_mentions: ["brandMentions", "nilMentions"],
  narrative: ["inferences.storyArc", "inferences.sentiment"],
  social_handles: ["social.handles (web_researched entries)"],
  signals: ["(not in the contract)"],
};
