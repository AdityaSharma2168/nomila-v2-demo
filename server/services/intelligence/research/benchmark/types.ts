/**
 * research/benchmark/types.ts — the research provider benchmark's own records (Step 4 calibration).
 *
 * Pure types. An ArmRun is what one provider produced for one athlete on one as-of date (search
 * envelopes + the cited-claims/3 extraction); everything else is DERIVED from it in memory by the
 * same rules the substrate applies when it persists a run (lineage validation, suspect screening,
 * source-type tiers, the resolver) plus the ResearchSpec v1 item coverage — nothing here touches a
 * database. Provider names are provenance strings only; no metric is provider-specific.
 */

import type { ExtractionEnvelope, SearchEnvelope } from "../providers";
import type { LineageStatus, ResearchDomain, SourceType } from "../registries";
import type { NewFact } from "../resolve";
import type { EvidenceKindV3, ExtractedClaimV3, ReportedSectionOutcome, SectionCoverage, SectionId } from "../spec/researchSpecV1";
import type { AcceptancePolicy, DirectClaimLineage, ProvenanceLevel } from "../spec/directEvidenceV1";

export type CohortGroup = "high_data" | "medium_data" | "niche" | "sparse";

/** One athlete of the development cohort. `anchor` is the identity text BOTH providers receive verbatim. */
export interface BenchmarkAthlete {
  key: string;
  fullName: string;
  sport: string;
  group: CohortGroup;
  /** Identity anchor given to the providers (identical in every arm). Minimal by design for the identity-resolution stress tests. */
  anchor: string;
  aliases?: string[];
  currentAffiliation?: string | null;
  hometown?: string | null;
  /** S9 omitted, minor request line added, stricter evidence-storage policy on the artifact. */
  isMinor?: boolean;
}

/** Evaluation-only identity truth. NEVER passed to a provider: negative anchors would contaminate the experiment. */
export interface GoldIdentity {
  key: string;
  confirmed: Partial<Record<"sport" | "affiliation" | "hometown" | "nationality" | "career_status" | "national_team_participation", string[]>>;
  negativeAnchors: string[];
}

export interface ArmQueryRecord { id: string; name: string; sections: SectionId[]; query: string; attempts: number; completed: boolean; refused: boolean; chunks: number; latencyMs: number | null }

export interface ArmUsage { searchCalls: number; extractCalls: number; promptTokens: number; completionTokens: number; cachedTokens: number; latencyMs: number }

export interface PartitionRecord { queryId: string; queryName: string; sections: SectionId[]; envelopeIds: string[]; chunks: number; status: "ok" | "failed" | "degenerate" | "skipped"; reason: string | null; latencyMs: number | null; promptTokens: number | null; completionTokens: number | null; claims: number; raw: string | null; error: string | null }
export interface ArmExtraction extends Omit<ExtractionEnvelope, "claims"> {
  claims: ExtractedClaimV3[];
  sectionOutcomes?: Partial<Record<SectionId, ReportedSectionOutcome>>;
  /** single = one call over every envelope (original attempts); partitioned = one call per ResearchSpec query (since 13 Sep 2026); provider_direct = the research provider returned direct-evidence/1 itself (path B, no Kimi). */
  extractionMode?: "single" | "partitioned" | "provider_direct";
  /** Path B: per-query identity block as returned by the provider. */
  identityByQuery?: Record<string, { anchorMatch: string | null; confidence: number | null; namesakes: number }>;
  partitions?: PartitionRecord[];
  degenerate?: { degenerate: boolean; reason: string | null };
}

/** `search_failed`, `extraction_failed` and `extraction_degenerate` are infrastructure states; only a `complete` arm can carry a semantic abstention. */
export type ArmStatus = "complete" | "extraction_failed" | "extraction_degenerate" | "search_failed";
export interface ExtractionAttempt {
  at: string;
  /** single = original one-call attempt; recovery = one-call re-extraction from saved envelopes; partitioned = per-query extraction from saved envelopes; direct = the provider itself (path B). */
  mode: "single" | "recovery" | "partitioned" | "direct";
  outcome: "ok" | "failed" | "degenerate";
  error: string | null;
  latencyMs: number | null; promptTokens: number | null; completionTokens: number | null;
  claims: number;
  partitions: Array<{ queryId: string; sections: SectionId[]; chunks: number; status: "ok" | "failed" | "degenerate" | "skipped"; latencyMs: number | null; claims: number; reason: string | null }> | null;
}

export interface ArmRun {
  athleteKey: string;
  provider: string;
  /** kimi = provider search → Kimi cited-claims/3 (path A); direct = provider search + direct-evidence/1 (path B). Absent on early artifacts ⇒ kimi. */
  path?: "kimi" | "direct";
  model: string | null;
  extractor: string | null;
  specVersion: string;
  asOf: string;
  startedAt: string;
  finishedAt: string;
  queries: ArmQueryRecord[];
  search: SearchEnvelope[];
  extraction: ArmExtraction | null;
  /** Derived by recovery.armStatus; absent only on artifacts written before the recovery path (normalized on load). */
  status?: ArmStatus;
  /** Every extraction attempt over this arm's saved evidence, oldest first. */
  extractionHistory?: ExtractionAttempt[];
  /** true when the extraction layer was rebuilt from the saved envelopes after a failure. */
  extractionRetried?: boolean;
  usage: ArmUsage;
  /** `complete` is false when any attempt lacked a usage record (retry usage unavailable): the total is then a lower bound, never presented as actual cost. */
  estimatedCostUsd: { search: number; extract: number; total: number; complete: boolean };
  minorRedacted: boolean;
}

export interface EvidenceRecord {
  id: string;
  kind: EvidenceKindV3;
  /** The fact key the extractor claimed (may be a v3 key such as birth_year). */
  claimedFactKey: string | null;
  /** The REGISTERED fact key (resolver input); null for v3 keys and evidence-only kinds. */
  factKey: string | null;
  claim: Record<string, unknown>;
  valueText: string;
  section: SectionId | null;
  domain: ResearchDomain;
  /** claim-canonicalization/2 provenance: raw value, canonical value and the rules applied (null for evidence-only kinds). */
  canonicalization: { version: string; applied: string[]; rawValue: unknown; canonicalValue: unknown } | null;
  /** Strict registry outcome for the (canonicalized) value; not_applicable for evidence-only kinds and unregistered keys. */
  registry: { status: "accepted" | "accepted_canonicalized" | "refused" | "not_applicable"; reason: string | null };
  /** Path B provenance level from the deterministic native-lineage validator (null on path A, whose lineage is the citation check). */
  provenanceLevel: ProvenanceLevel | null;
  provenanceMatch: DirectClaimLineage["match"] | null;
  /** Path B: the acceptance policy under which `lineage` was computed. */
  acceptancePolicy: AcceptancePolicy | null;
  lineage: LineageStatus;
  lineageReason: string | null;
  suspect: boolean;
  sourceUrl: string | null;
  sourceDomain: string | null;
  /** Assigned downstream by Nomila's policy from the cited domain — never by the provider. */
  sourceType: SourceType;
  tier: number;
  confidence: number;
  publishedAt: string | null;
  quote: string | null;
  quoteKind: string | null;
  queryName: string | null;
}

/** A follower-count statement found by regex in provider text (cross-check for social_metric_claim extraction). Evidence only. */
export interface FollowerMention { chunkId: string; url: string | null; domain: string | null; platform: string | null; count: number; quote: string }

export interface DerivedArm {
  provider: string;
  evidence: EvidenceRecord[];
  facts: NewFact[];
  refused: Array<{ factKey: string; reason: string }>;
  proposals: number;
  disputedKeys: string[];
  followerMentions: FollowerMention[];
  sectionOutcomes: Partial<Record<SectionId, ReportedSectionOutcome>>;
  coverage: SectionCoverage[];
  registry: { accepted: number; acceptedCanonicalized: number; refused: number; notApplicable: number; rulesApplied: Record<string, number>; refusalReasons: Record<string, number> };
  aboutIdentityConfidence: number | null;
  /** true for failed AND degenerate extractions: neither can carry a semantic abstention. */
  extractionFailed: boolean;
}

export interface IdentityFidelity {
  aboutIdentityConfidence: number | null;
  anchorAgreement: { checked: number; agree: number; disagree: number; details: Array<{ field: string; valueText: string; agree: boolean }> };
  conflictingIdentity: Array<{ factKey: string; values: string[] }>;
  conflated: Array<{ evidenceId: string; matched: string }>;
  unsupported: { count: number; share: number | null };
  /** Namesakes the extractor reported (S1 `namesakes`), a sign of disambiguation work rather than conflation. */
  namesakesReported: number;
  /** `abstained` is a research result and is only ever true on a complete arm; an infrastructure failure leaves it false and is reported via ArmMetrics.status. */
  abstention: { sectionsNotFound: SectionId[]; itemsNotFound: number; itemsNotApplicable: number; explicitNotFound: number; claims: number; abstained: boolean };
}

export interface ArmMetrics {
  provider: string;
  model: string | null;
  specVersion: string;
  path: "kimi" | "direct";
  status: ArmStatus;
  statusReason: string | null;
  extractionAttempts: number;
  /** Provenance distribution over all claims (path B); path A reports lineage via evidence.cited/uncited. */
  provenance: Record<ProvenanceLevel, number> | null;
  /** Registry/fact outcomes under both acceptance policies (identical on path A). */
  policies: Record<AcceptancePolicy, { cited: number; factsAccepted: number; registryAccepted: number; registryCanonicalized: number; registryRefused: number; itemsFound: number }>;
  /** Provider cost, Kimi cost (0 on path B), end to end. */
  costs: { providerUsd: number; kimiUsd: number; totalUsd: number };
  /** Information survival: what the provider found → what survived extraction (A) or provenance validation (B) → what the registry accepted. */
  survival: { providerEvidence: number; afterExtractionOrProvenance: number; afterRegistry: number; note: string };
  failureRecovery: { extractionAttempts: number; searchRetries: number; failedPartitions: number; degeneratePartitions: number };
  /** Path B identity block (Q1) as the provider reported it. */
  directIdentity: { anchorMatch: string | null; confidence: number | null; namesakes: number } | null;
  extractionMode: "single" | "partitioned" | "provider_direct" | null;
  partitions: Array<{ queryId: string; sections: SectionId[]; chunks: number; status: string; latencyMs: number | null; claims: number; reason: string | null }> | null;
  registry: DerivedArm["registry"];
  minor: { policy: string | null; trigger: "cohort_flag" | "cited_birth_year" | null; birthYear: number | null } | null;
  evidence: { claims: number; cited: number; uncited: number; conflicting: number; suspect: number; citedShare: number | null; byKind: Record<string, number> };
  citations: { supports: number; citedUrls: number; uniqueDomains: number; domains: string[]; sourceTypes: Record<string, number>; meanTier: number | null; tier1to3Share: number | null };
  freshness: { withPublishedAt: number; share: number | null; medianAgeDays: number | null };
  facts: { count: number; keys: string[]; registryCoverage: number; disputed: number; refused: number; meanConfidence: number | null };
  /** ResearchSpec v1 item coverage: per section and overall (found items / requested items), plus reported-vs-derived agreement. */
  coverage: { sections: SectionCoverage[]; itemsFound: number; itemsRequested: number; overall: number; reportedDerivedAgreement: number | null; sectionsFoundCited: number; sectionsConflicting: number };
  reputation: { reported_allegation: number; official_finding_or_action: number; resolution_or_outcome: number };
  subSignals: { covered: string[]; coverage: number; total: number };
  confidence: { meanClaim: number | null; meanFact: number | null };
  socialMetricClaims: number;
  followerMentionsInText: number;
  latencyMs: number;
  calls: { search: number; extract: number };
  costUsd: number;
  costComplete: boolean;
  identity: IdentityFidelity;
  beta1: { normalizedSignals: null; dimensionScores: null; mia: null; blockedReason: string };
}

export interface LedgerArmEntry { found: boolean; lineage: LineageStatus | null; confidence: number | null; sourceUrl: string | null; sourceDomain: string | null; sourceType: SourceType | null; tier: number | null; publishedAt: string | null; quote: string | null; evidenceId: string | null }

export interface LedgerRow {
  athleteKey: string;
  matchKey: string;
  kind: EvidenceKindV3;
  factKey: string | null;
  claimedFactKey: string | null;
  valueText: string;
  section: SectionId | null;
  domain: ResearchDomain;
  arms: Record<string, LedgerArmEntry>;
  agreement: string;
  conflict: Array<{ provider: string; valueText: string; lineage: LineageStatus }> | null;
  /** Providers whose reported section outcome was not_found while another arm found this row. */
  abstained: string[];
}

export interface AthleteComparison {
  athleteKey: string;
  group: CohortGroup;
  asOf: string;
  /** Frozen calibration target from the evaluation-only targets file; set by the report builder, never by the harness. */
  targetScore?: number | null;
  arms: Record<string, ArmMetrics>;
  ledger: LedgerRow[];
  summary: { both: number; only: Record<string, number>; conflicts: number; abstentions: Record<string, number> };
  deltas: { confidence: number | null; coverage: number | null; costUsd: number | null; latencyMs: number | null; mia: null };
}

export interface Aggregate {
  asOf: string;
  athletes: number;
  providers: string[];
  perProvider: Record<string, {
    avgClaims: number; avgCited: number; avgCitedShare: number | null; avgTier1to3Share: number | null; avgUniqueDomains: number;
    avgClaimConfidence: number | null; avgFactConfidence: number | null; avgRegistryCoverage: number; avgItemCoverage: number; avgSectionCoverage: Record<SectionId, number | null>; avgSubSignalCoverage: number;
    avgIdentityConfidence: number | null; unsupportedShare: number | null; conflatedTotal: number; abstentions: number; incompleteArms: number; reportedDerivedAgreement: number | null;
    costPerAthlete: number; latencyPerAthleteMs: number;
    path: "kimi" | "direct"; avgProviderUsd: number; avgKimiUsd: number;
    provenance: Record<ProvenanceLevel, number> | null;
    policies: Record<AcceptancePolicy, { factsAccepted: number; cited: number; itemsFound: number }>;
    survival: { providerEvidence: number; afterExtractionOrProvenance: number; afterRegistry: number };
    failures: { failedPartitions: number; degeneratePartitions: number; searchRetries: number; extractionAttempts: number };
  }>;
  agreement: { both: number; only: Record<string, number>; conflicts: number };
  byGroup: Record<string, { athletes: number; perProvider: Record<string, { avgClaims: number; avgCited: number; avgItemCoverage: number; abstentions: number; avgIdentityConfidence: number | null }> }>;
  mia: { avgAbsDiff: null; dimensionVariance: null; blockedReason: string };
}
