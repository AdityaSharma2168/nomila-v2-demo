/**
 * context/coverage.ts — per-domain coverage and the aggregate sourceMode (design §3.2). Pure.
 *
 *   unavailable      the substrate has never covered the domain (no state row, or no fresh outcome and no rows)
 *   populated        last outcome `refreshed`: canonical rows only — the legacy adapter is NOT consulted
 *   confirmed_empty  last outcome `confirmed_empty`: EMPTY — the legacy adapter is NOT consulted
 *   disputed         a disputed canonical fact: canonical rows incl. the disputed ones — no legacy
 *
 * Legacy compatibility data is admissible ONLY for `unavailable`. `sourceMode` is the aggregate over
 * the domains a view needs; section-level provenance is preserved on every row.
 */

import { RESEARCH_DOMAINS, type ResearchDomain } from "../research/registries";
import type { Coverage, SourceMode } from "./contract";

export interface DomainStateEntry { status?: string | null; outcome?: string | null; lastResearchedAt?: string | null; staleAfter?: string | null; lastRunId?: string | null }

export function coverageFor(entry: DomainStateEntry | undefined, canonicalRows: number): Coverage {
  if (!entry) return canonicalRows > 0 ? "populated" : "unavailable";
  if (entry.status === "disputed") return "disputed";
  if (entry.outcome === "confirmed_empty" && canonicalRows === 0) return "confirmed_empty";
  if (entry.outcome === "refreshed" || canonicalRows > 0) return "populated";
  return "unavailable";
}

export function coverageMap(domains: Partial<Record<ResearchDomain, DomainStateEntry>> | null, rowsByDomain: Partial<Record<ResearchDomain, number>>): Record<ResearchDomain, Coverage> {
  const out = {} as Record<ResearchDomain, Coverage>;
  for (const d of RESEARCH_DOMAINS) out[d] = coverageFor(domains?.[d], rowsByDomain[d] ?? 0);
  return out;
}

/** May a section of this domain be served from the legacy adapter? Only when the substrate has not covered it. */
export const legacyAllowed = (c: Coverage): boolean => c === "unavailable";

export function aggregateSourceMode(coverage: Record<ResearchDomain, Coverage>, domains: ResearchDomain[]): SourceMode {
  const c = domains.map((d) => coverage[d]);
  if (!c.length) return "canonical";
  if (c.every((x) => x === "unavailable")) return "legacy";
  if (c.every((x) => x !== "unavailable")) return "canonical";
  return "mixed";
}
