/**
 * research/registries.ts — the closed vocabularies of the research substrate (Step 2a).
 *
 * Types and constants only. Evidence kinds, research domains, lifecycle states, fact origins,
 * the source-type authority tiers (design §4.3) and the lineage statuses (§3.2). The Fact
 * Registry (factRegistry.ts) references these; nothing here imports a provider.
 */

export const RESEARCH_REGISTRY_VERSION = "v1";

// ── evidence ──────────────────────────────────────────────────────────────────
export const EVIDENCE_KINDS = [
  "achievement", "press_mention", "brand_mention", "affiliation", "profile_attribute",
  "social_handle", "nil_mention", "sentiment", "media_asset", "identity_signal", "signal",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
/**
 * Evidence kinds the substrate PERSISTS since migration 0053 (Phase A Step 4, Slice 1): the base kinds, the seven
 * research-spec/1 kinds, and `research_finding` (a sourced finding with no registry key). Mirrors the DB CHECK.
 * 0082 adds `athlete_statement`: the athlete's own verbatim words, extracted ONLY by the targeted source read from the
 * page or public video the model read (lineage `source_read`). A quote seen through search grounding is never one.
 */
export const EVIDENCE_KINDS_V2 = [...EVIDENCE_KINDS, "career_event", "reputation_event", "social_metric_claim", "representation", "venture", "crossover_appearance", "narrative_claim", "research_finding", "athlete_statement"] as const;
export type EvidenceKindV2 = (typeof EVIDENCE_KINDS_V2)[number];

/**
 * Citation-validated statuses (Kimi path) plus the provider-native lineage levels (direct path). Mirrors the DB CHECK (0053; 0082
 * adds `source_read`: the model directly read the underlying page (URL context) or public video (native video input) and
 * extracted the item from THAT source; the row's source_url is the URL read).
 */
export const LINEAGE_STATUSES = ["cited", "uncited", "conflicting", "native_supported", "native_retrieved", "asserted_only", "source_read"] as const;
export type LineageStatus = (typeof LINEAGE_STATUSES)[number];
/** Statuses that count as sourced evidence for acceptance, freshness and context readers. */
export const CITED_LINEAGES: readonly LineageStatus[] = ["cited", "native_supported", "native_retrieved", "source_read"];
export const isCitedLineage = (s: string): boolean => (CITED_LINEAGES as readonly string[]).includes(s);
/** The resolver's three-way view of a stored lineage status (rules 1–7 are unchanged; native levels map onto them). */
export type ResolverLineage = "cited" | "uncited" | "conflicting";
export const resolverLineageOf = (s: LineageStatus): ResolverLineage => (s === "conflicting" ? "conflicting" : isCitedLineage(s) ? "cited" : "uncited");

// ── source-type authority (design §4.3, versioned with research_policy) ────────
export const SOURCE_TYPES = [
  "official_governing_body", "official_team_or_school", "major_news", "reference",
  "regional_news", "athlete_authored_public", "aggregator_or_blog", "unknown",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SOURCE_TYPE_TIER: Record<SourceType, number> = {
  official_governing_body: 1, official_team_or_school: 2, major_news: 3, reference: 4,
  regional_news: 5, athlete_authored_public: 6, aggregator_or_blog: 7, unknown: 8,
};
/** A tier at or above which a single source may establish a current affiliation or displace a lower tier (rule 4, rule 7). */
export const AUTHORITATIVE_TIER = 2;
/** The tier a corroborated pair of independent sources must reach to establish an affiliation (rule 7). */
export const CORROBORATING_TIER = 3;

// ── domains and lifecycle ─────────────────────────────────────────────────────
export const RESEARCH_DOMAINS = ["identity", "profile", "affiliations", "achievements", "press", "brand_mentions", "narrative", "social_handles", "signals"] as const;
export type ResearchDomain = (typeof RESEARCH_DOMAINS)[number];
/** Domains that must be complete for research_complete. */
export const REQUIRED_DOMAINS: ResearchDomain[] = ["identity", "profile", "affiliations", "achievements", "press"];
/** Domains whose dispute or absence holds the athlete at research_partial (R7). */
export const BLOCKING_DOMAINS: ResearchDomain[] = ["identity", "affiliations"];

export const DOMAIN_STATUSES = ["missing", "partial", "complete", "stale", "disputed"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export const RESEARCH_STATES = ["seed_only", "identity_resolved", "research_partial", "research_complete", "research_stale"] as const;
export type ResearchState = (typeof RESEARCH_STATES)[number];

/**
 * PR E1 (0080): athlete-level public-identity resolution — WHO the research concerns (arch §9.4 Axis 2). The single
 * TypeScript source of the athlete_research_state_identity_resolution_check value list (a test pins the SQL to it).
 * A NULL column is NOT one of these: it means no determination has ever been recorded (historical), never `pending`.
 * Unrelated to RESEARCH_STATES' `identity_resolved`, which is the legacy ACCOUNT-ownership signal.
 */
export const IDENTITY_RESOLUTIONS = ["pending", "resolved", "ambiguous", "failed"] as const;
export type IdentityResolution = (typeof IDENTITY_RESOLUTIONS)[number];

export const RESEARCH_TRIGGERS = ["signup", "identity_confirmed", "ttl", "event", "manual", "backfill", "dual_write"] as const;
export type ResearchTrigger = (typeof RESEARCH_TRIGGERS)[number];

export const RUN_STATUSES = ["running", "ok", "partial", "failed"] as const;

// ── facts ─────────────────────────────────────────────────────────────────────
export const FACT_ORIGINS = ["athlete_asserted", "athlete_proof", "connection", "research", "backfill"] as const;
export type FactOrigin = (typeof FACT_ORIGINS)[number];

/** Canonical SourceClass values a fact may carry. `inferred` and `imputed` are barred by CHECK and by the resolver (R1). */
export const FACT_SOURCE_CLASSES = ["connected_verified", "platform_public", "web_researched"] as const;
export type FactSourceClass = (typeof FACT_SOURCE_CLASSES)[number];

export const FACT_STATUSES = ["current", "historical", "superseded", "retracted", "disputed"] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const FRESHNESS_FAMILIES = ["identity", "affiliations", "achievements", "press", "brand_mentions", "narrative", "social_handles", "signals"] as const;
export type FreshnessFamily = (typeof FRESHNESS_FAMILIES)[number];

/** Which research domain each evidence kind belongs to (persist + the benchmark share it; pure). */
export const KIND_DOMAIN: Record<EvidenceKind, ResearchDomain> = { achievement: "achievements", press_mention: "press", brand_mention: "brand_mentions", affiliation: "affiliations", profile_attribute: "profile", social_handle: "social_handles", nil_mention: "brand_mentions", sentiment: "narrative", media_asset: "press", identity_signal: "identity", signal: "signals" };

/** Domains of the seven research-spec/1 kinds; `research_finding` takes the domain of its spec section (SECTION_DOMAIN). */
export const KIND_DOMAIN_V2: Record<EvidenceKindV2, ResearchDomain> = {
  ...KIND_DOMAIN,
  career_event: "profile", reputation_event: "press", social_metric_claim: "social_handles", representation: "brand_mentions", venture: "brand_mentions", crossover_appearance: "press", narrative_claim: "narrative",
  research_finding: "profile",
  athlete_statement: "narrative",
};
/** research-spec/1 section → research domain (for `research_finding` rows, which carry `claim.section`). */
export const SECTION_DOMAIN: Record<string, ResearchDomain> = { S1: "identity", S2: "affiliations", S3: "profile", S4: "achievements", S5: "press", S6: "narrative", S7: "brand_mentions", S8: "social_handles", S9: "press" };
export function domainOfEvidence(kind: string, claim: Record<string, unknown> | null | undefined): ResearchDomain | undefined {
  if (kind === "research_finding") { const s = typeof claim?.section === "string" ? SECTION_DOMAIN[claim.section] : undefined; return s ?? KIND_DOMAIN_V2.research_finding; }
  return (KIND_DOMAIN_V2 as Record<string, ResearchDomain>)[kind];
}

/** Which freshness family each domain refreshes under. */
export const DOMAIN_FRESHNESS: Record<ResearchDomain, FreshnessFamily> = {
  identity: "identity", profile: "affiliations", affiliations: "affiliations", achievements: "achievements", press: "press",
  brand_mentions: "brand_mentions", narrative: "narrative", social_handles: "social_handles", signals: "signals",
};

/** Origin precedence, highest first (design §3.1). */
export const ORIGIN_RANK: Record<FactOrigin, number> = { athlete_proof: 0, athlete_asserted: 1, connection: 2, research: 3, backfill: 4 };

// ── Step 2b: planner vocabularies (design §3.1, §4) ───────────────────────────
/** Domains the planner may plan on their own. `profile` rides with `affiliations` (same query, same freshness family). */
export const PLANNABLE_DOMAINS: ResearchDomain[] = ["identity", "affiliations", "achievements", "press", "brand_mentions", "narrative", "social_handles", "signals"];
/**
 * PR E2b (design record pr-e-identity-resolution-design.md §3, D11): under the DIRECT binding (research_refresh v3) `profile`
 * is plannable on its own — v3 has no profile ↔ affiliations companion; profile due → Q1 + Q6, affiliations due → Q1.
 * The kimi binding (v2, mergePlan's companion) keeps PLANNABLE_DOMAINS exactly as it is.
 */
export const PLANNABLE_DOMAINS_DIRECT: ResearchDomain[] = RESEARCH_DOMAINS.filter((d) => d === "profile" || PLANNABLE_DOMAINS.includes(d));
/** The domains the planner (and requestRefresh) may plan under a provider binding: kimi → PLANNABLE_DOMAINS; direct → + profile. */
export function plannableDomainsFor(binding: "kimi" | "direct"): ResearchDomain[] {
  return binding === "direct" ? PLANNABLE_DOMAINS_DIRECT : PLANNABLE_DOMAINS;
}
/** Domains that have no fact key in the registry: evidence or inference alone makes them fresh. */
export const EVIDENCE_ONLY_DOMAINS: ResearchDomain[] = ["press", "narrative", "social_handles", "signals"];
/** Per-domain outcome of one run. Only `refreshed` and `confirmed_empty` advance freshness. */
export const DOMAIN_OUTCOMES = ["refreshed", "confirmed_empty", "no_relevant", "failed", "not_planned"] as const;
export type DomainOutcome = (typeof DOMAIN_OUTCOMES)[number];
export const PLANNER_MODES = ["dry_run", "enqueue"] as const;
export type PlannerMode = (typeof PLANNER_MODES)[number];
export const PLANNER_STATUSES = ["running", "ok", "failed", "skipped"] as const;
/** research_runs.domain vocabulary (0047 CHECK): a domain, a legacy/dual-write full run, or a merged planner refresh. */
export const RUN_DOMAIN_VALUES = [...RESEARCH_DOMAINS, "full", "refresh"] as const;
export type RunDomain = (typeof RUN_DOMAIN_VALUES)[number];
export const LLM_LANES = ["llm", "signals", "other"] as const;
export type CallLane = (typeof LLM_LANES)[number];
