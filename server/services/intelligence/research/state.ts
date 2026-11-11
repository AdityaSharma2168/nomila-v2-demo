/**
 * research/state.ts — domain statuses and the research lifecycle state (design §5.1, R2, R7).
 *
 * Pure. Connection status is NOT an input: connection is orthogonal to research and is derived
 * elsewhere at read time. Only blocking domains (identity, affiliations) hold an athlete at
 * research_partial when disputed; a disputed non-blocking domain is reported, not blocking.
 */

import { BLOCKING_DOMAINS, DOMAIN_FRESHNESS, REQUIRED_DOMAINS, type DomainStatus, type FreshnessFamily, type ResearchDomain, type ResearchState } from "./registries";

const DAY = 86_400_000;

export interface DomainEvidenceSummary {
  domain: ResearchDomain;
  lastResearchedAt: string | null;
  /** current/historical facts (or evidence, for evidence-only domains) with cited lineage */
  cited: number;
  /** rows that exist only with uncited lineage */
  uncited: number;
  /** a disputed fact on a blocking key in this domain */
  disputedBlocking: boolean;
  /** a disputed fact on a non-blocking key in this domain */
  disputedNonBlocking: boolean;
}

export function domainStatus(d: DomainEvidenceSummary, ttlDays: Partial<Record<FreshnessFamily, number | null>>, asOf: Date): DomainStatus {
  if (!d.lastResearchedAt && d.cited === 0 && d.uncited === 0) return "missing";
  if (d.disputedBlocking || d.disputedNonBlocking) return "disputed";
  if (d.cited === 0) return d.uncited > 0 ? "partial" : "missing";
  const ttl = ttlDays[DOMAIN_FRESHNESS[d.domain]];
  if (ttl != null && d.lastResearchedAt && asOf.getTime() - new Date(d.lastResearchedAt).getTime() > ttl * DAY) return "stale";
  return "complete";
}

export interface StateInput {
  identityResolved: boolean;
  domains: Partial<Record<ResearchDomain, DomainStatus>>;
  /** Domains where a BLOCKING key is disputed. A domain marked `disputed` only through non-blocking keys never blocks (R7). */
  blockingDisputes?: ResearchDomain[];
}

export interface DerivedState { status: ResearchState; disputedDomains: ResearchDomain[]; blockingIssues: ResearchDomain[] }

export function deriveResearchState(i: StateInput): DerivedState {
  const statuses = i.domains;
  const anyResearch = Object.values(statuses).some((s) => s && s !== "missing");
  const disputedDomains = (Object.keys(statuses) as ResearchDomain[]).filter((d) => statuses[d] === "disputed");
  if (!anyResearch) return { status: i.identityResolved ? "identity_resolved" : "seed_only", disputedDomains: [], blockingIssues: [] };
  const blockingDisputes = new Set(i.blockingDisputes ?? []);
  const blockingIssues = BLOCKING_DOMAINS.filter((d) => { const s = statuses[d] ?? "missing"; return s === "missing" || s === "partial" || blockingDisputes.has(d); });
  if (blockingIssues.length) return { status: "research_partial", disputedDomains, blockingIssues };
  const requiredGaps = REQUIRED_DOMAINS.filter((d) => { const s = statuses[d] ?? "missing"; return s === "missing" || s === "partial"; });
  if (requiredGaps.length) return { status: "research_partial", disputedDomains, blockingIssues: [] };
  if (REQUIRED_DOMAINS.some((d) => statuses[d] === "stale")) return { status: "research_stale", disputedDomains, blockingIssues: [] };
  return { status: "research_complete", disputedDomains, blockingIssues: [] };
}
