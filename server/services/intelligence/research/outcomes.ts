/**
 * research/outcomes.ts — when a planned domain becomes fresh (Step 2b design §3.1). Pure.
 *
 * "Touched" is not enough. A planned domain reaches exactly one outcome per run and only
 * `refreshed` and `confirmed_empty` advance lastResearchedAt / staleAfter:
 *   refreshed        evidence-only domain: accepted (cited, not suspect) domain evidence or inference;
 *                    fact-bearing domain: accepted domain evidence AND a fact of the domain accepted,
 *                    corroborated or re-confirmed by the resolver. Evidence alone NEVER refreshes a
 *                    fact-bearing domain (review of PR #400).
 *   confirmed_empty  every query of the domain completed without a provider error, ≥ 1 chunk was reviewed,
 *                    and the extractor returned an explicit `none_found` for that domain
 *   no_relevant      queries completed but nothing relevant was accepted and no `none_found` was asserted
 *   failed           a query failed / was cut by a cap, or extraction failed
 */

import type { DomainOutcome, ResearchDomain } from "./registries";
import { EVIDENCE_ONLY_DOMAINS } from "./registries";

export interface DomainQueryStatus {
  /** Every query the plan assigned to the domain completed without a provider error (and was not cut by a cap). */
  completed: boolean;
  /** Grounded chunks the extractor could review for this domain. */
  chunksReviewed: number;
}
export interface DomainAcceptance {
  /** Accepted (cited, non-suspect) evidence rows whose domain is this one, incl. signal rows and inferences for narrative. */
  evidence: number;
  /** Of those, fact-bearing claims (a registered factKey). */
  factBearing: number;
  /** Facts of this domain inserted, corroborated or re-confirmed by the resolver. */
  facts: number;
}
export interface ExtractionDomainOutcome { status: "found" | "none_found"; reviewedChunkIds: string[] }

export function domainOutcome(
  domain: ResearchDomain,
  query: DomainQueryStatus | undefined,
  extraction: ExtractionDomainOutcome | undefined,
  accepted: DomainAcceptance,
  opts: { extractionFailed: boolean; llmDomain: boolean },
): DomainOutcome {
  if (!query) return "failed";
  const evidenceOnly = EVIDENCE_ONLY_DOMAINS.includes(domain);
  if (accepted.evidence > 0 && (evidenceOnly || accepted.facts > 0)) return "refreshed";
  if (!query.completed) return "failed";
  if (opts.llmDomain && opts.extractionFailed) return "failed";
  if (query.completed && query.chunksReviewed > 0 && extraction?.status === "none_found") return "confirmed_empty";
  return "no_relevant";
}

export const FRESH_OUTCOMES: DomainOutcome[] = ["refreshed", "confirmed_empty"];
export const isFreshOutcome = (o: DomainOutcome | undefined): boolean => !!o && FRESH_OUTCOMES.includes(o);
