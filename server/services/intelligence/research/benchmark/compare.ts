/**
 * research/benchmark/compare.ts — per-arm metrics, the cross-provider fact ledger and the aggregate.
 *
 * "More evidence" and "better evidence" are kept apart: counts (claims, domains, mentions) sit next
 * to acceptance (cited share, tier assigned downstream, resolver outcome, ResearchSpec item coverage,
 * identity fidelity, abstention). The ledger carries, for EVERY fact, enough provenance to tell
 * provider, source, citation, confidence, freshness, whether both providers found it independently,
 * whether they conflict, and whether one abstained (decision 12 Sep 2026). Pure; provider ids are labels.
 */

import { getFactDefinition, FACT_REGISTRY } from "../factRegistry";
import { norm } from "../lineage";
import type { ResearchPolicy } from "../policy";
import type { LineageStatus, ResearchDomain } from "../registries";
import { SECTION_IDS, type EvidenceKindV3, type SectionId } from "../spec/researchSpecV1";
import { identityFidelity } from "./identity";
import { armStatus, extractionDegenerate } from "./recovery";
import { deriveArm as deriveDefault } from "./evidence";
import { PROVENANCE_LEVELS, type AcceptancePolicy, type ProvenanceLevel } from "../spec/directEvidenceV1";
import { coveredSubSignals, RESEARCH_INFORMABLE_SUBSIGNALS } from "./subSignalCoverage";
import type { Aggregate, ArmMetrics, ArmRun, AthleteComparison, BenchmarkAthlete, DerivedArm, EvidenceRecord, GoldIdentity, LedgerArmEntry, LedgerRow } from "./types";

export const BETA1_BLOCKED_REASON = "Beta.1 inputs unavailable: no frozen cohort/prior/lookup bundle and no research→signal channel yet (reported at the 12 Sep 2026 checkpoint); columns stay null, never zero";

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r3 = (x: number | null): number | null => (x == null ? null : Math.round(x * 1000) / 1000);

export function armMetrics(arm: ArmRun, derived: DerivedArm, gold: GoldIdentity | null, minor: ArmMetrics["minor"] = null, policyFn?: (acceptance: AcceptancePolicy) => DerivedArm): ArmMetrics {
  const ev = derived.evidence;
  const direct = arm.extraction?.extractionMode === "provider_direct";
  const provenance = direct ? (Object.fromEntries(PROVENANCE_LEVELS.map((l) => [l, ev.filter((e) => e.provenanceLevel === l).length])) as Record<ProvenanceLevel, number>) : null;
  const policyOf = (acceptance: AcceptancePolicy) => {
    const d = direct && policyFn ? policyFn(acceptance) : derived;
    const cited = d.evidence.filter((e) => e.lineage === "cited" && !e.suspect);
    return { cited: cited.length, factsAccepted: d.facts.length, registryAccepted: cited.filter((e) => e.registry.status === "accepted").length, registryCanonicalized: cited.filter((e) => e.registry.status === "accepted_canonicalized").length, registryRefused: cited.filter((e) => e.registry.status === "refused").length, itemsFound: d.coverage.reduce((a, c) => a + c.found, 0) };
  };
  const policies = { strict: policyOf("strict"), retrieved: policyOf("retrieved") };
  const providerUsd = direct ? arm.estimatedCostUsd.total : arm.estimatedCostUsd.search;
  const kimiUsd = direct ? 0 : arm.estimatedCostUsd.extract;
  const searchRetries = arm.queries.reduce((a, q) => a + Math.max(0, q.attempts - 1), 0);
  const parts = arm.extraction?.partitions ?? [];
  const providerEvidence = direct ? ev.length : arm.search.reduce((a, e) => a + e.chunks.length, 0);
  const afterExtractionOrProvenance = direct ? ev.filter((e) => e.lineage === "cited" && !e.suspect).length : ev.filter((e) => e.lineage === "cited" && !e.suspect).length;
  const afterRegistry = ev.filter((e) => e.lineage === "cited" && !e.suspect && (e.registry.status === "accepted" || e.registry.status === "accepted_canonicalized")).length;
  const idq = arm.extraction?.identityByQuery?.Q1 ?? null;
  const cited = ev.filter((e) => e.lineage === "cited");
  const citedClean = cited.filter((e) => !e.suspect);
  const sourceTypes: Record<string, number> = {};
  for (const e of citedClean) sourceTypes[e.sourceType] = (sourceTypes[e.sourceType] ?? 0) + 1;
  const byKind: Record<string, number> = {};
  for (const e of ev) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  const domains = [...new Set(citedClean.map((e) => e.sourceDomain).filter(Boolean) as string[])].sort();
  const asOfMs = Date.parse(arm.asOf);
  const ages = ev.filter((e) => e.publishedAt).map((e) => (asOfMs - Date.parse(e.publishedAt!)) / 86_400_000).filter((d) => Number.isFinite(d) && d >= 0);
  const factKeys = [...new Set(derived.facts.map((f) => f.factKey))].sort();
  const covered = coveredSubSignals(ev);
  const itemsFound = derived.coverage.reduce((a, c) => a + c.found, 0);
  const itemsRequested = derived.coverage.reduce((a, c) => a + c.requested, 0);
  const agreeItems = derived.coverage.flatMap((c) => c.items).filter((i) => i.agree != null);
  const reputation = { reported_allegation: 0, official_finding_or_action: 0, resolution_or_outcome: 0 };
  for (const e of citedClean) if (e.kind === "reputation_event") { const st = String(e.claim.stage) as keyof typeof reputation; if (st in reputation) reputation[st]++; }
  return {
    provider: arm.provider, model: arm.model, specVersion: arm.specVersion,
    path: direct ? "direct" : "kimi", provenance, policies, costs: { providerUsd, kimiUsd, totalUsd: arm.estimatedCostUsd.total },
    survival: { providerEvidence, afterExtractionOrProvenance, afterRegistry, note: direct ? "claims returned → claims whose native lineage is accepted (retrieved policy) → registry accepted" : "cited provider chunks → Kimi claims cited and non-suspect → registry accepted" },
    failureRecovery: { extractionAttempts: arm.extractionHistory?.length ?? (arm.extraction ? 1 : 0), searchRetries, failedPartitions: parts.filter((p) => p.status === "failed").length, degeneratePartitions: parts.filter((p) => p.status === "degenerate").length },
    directIdentity: idq ? { anchorMatch: idq.anchorMatch, confidence: idq.confidence, namesakes: idq.namesakes } : null,
    status: arm.status ?? armStatus(arm), statusReason: arm.extraction?.errors.length ? arm.extraction.errors.map((e) => e.message).join("; ") : extractionDegenerate(arm).reason,
    extractionAttempts: arm.extractionHistory?.length ?? (arm.extraction ? 1 : 0), extractionMode: arm.extraction?.extractionMode ?? (arm.extraction ? "single" : null),
    partitions: arm.extraction?.partitions?.map((p) => ({ queryId: p.queryId, sections: p.sections, chunks: p.chunks, status: p.status, latencyMs: p.latencyMs, claims: p.claims, reason: p.reason ?? p.error ?? null })) ?? null,
    registry: derived.registry, minor,
    evidence: { claims: ev.length, cited: cited.length, uncited: ev.filter((e) => e.lineage === "uncited").length, conflicting: ev.filter((e) => e.lineage === "conflicting").length, suspect: ev.filter((e) => e.suspect).length, citedShare: r3(ev.length ? cited.length / ev.length : null), byKind },
    citations: {
      supports: arm.search.reduce((a, e) => a + e.supports.length, 0),
      citedUrls: new Set(arm.search.flatMap((e) => e.chunks.map((c) => c.url).filter(Boolean))).size,
      uniqueDomains: domains.length, domains, sourceTypes,
      meanTier: r3(mean(citedClean.map((e) => e.tier))), tier1to3Share: r3(citedClean.length ? citedClean.filter((e) => e.tier <= 3).length / citedClean.length : null),
    },
    freshness: { withPublishedAt: ev.filter((e) => e.publishedAt).length, share: r3(ev.length ? ev.filter((e) => e.publishedAt).length / ev.length : null), medianAgeDays: r3(median(ages)) },
    facts: { count: derived.facts.length, keys: factKeys, registryCoverage: r3(factKeys.length / Object.keys(FACT_REGISTRY).length)!, disputed: derived.disputedKeys.length, refused: derived.refused.length, meanConfidence: r3(mean(derived.facts.map((f) => f.confidence))) },
    coverage: {
      sections: derived.coverage, itemsFound, itemsRequested, overall: r3(itemsRequested ? itemsFound / itemsRequested : 0)!,
      reportedDerivedAgreement: r3(agreeItems.length ? agreeItems.filter((i) => i.agree).length / agreeItems.length : null),
      sectionsFoundCited: derived.coverage.filter((c) => c.derivedStatus === "found_cited").length, sectionsConflicting: derived.coverage.filter((c) => c.derivedStatus === "conflicting").length,
    },
    reputation,
    subSignals: { covered, coverage: r3(covered.length / RESEARCH_INFORMABLE_SUBSIGNALS.length)!, total: RESEARCH_INFORMABLE_SUBSIGNALS.length },
    confidence: { meanClaim: r3(mean(ev.map((e) => e.confidence))), meanFact: r3(mean(derived.facts.map((f) => f.confidence))) },
    socialMetricClaims: ev.filter((e) => e.kind === "social_metric_claim").length,
    followerMentionsInText: derived.followerMentions.length,
    latencyMs: arm.usage.latencyMs,
    calls: { search: arm.usage.searchCalls, extract: arm.usage.extractCalls },
    costUsd: arm.estimatedCostUsd.total,
    costComplete: arm.estimatedCostUsd.complete,
    identity: identityFidelity(derived, gold, arm.search),
    beta1: { normalizedSignals: null, dimensionScores: null, mia: null, blockedReason: BETA1_BLOCKED_REASON },
  };
}

function matchKey(e: EvidenceRecord): string { return `${e.claimedFactKey ?? e.kind}|${norm(e.valueText)}`; }

/** Prefer cited over not, lower tier, then higher confidence. */
function better(a: EvidenceRecord, b: EvidenceRecord): EvidenceRecord {
  const ca = a.lineage === "cited" && !a.suspect, cb = b.lineage === "cited" && !b.suspect;
  if (ca !== cb) return ca ? a : b;
  if (a.tier !== b.tier) return a.tier < b.tier ? a : b;
  return a.confidence >= b.confidence ? a : b;
}

const entryOf = (e: EvidenceRecord | undefined): LedgerArmEntry => e
  ? { found: true, lineage: e.lineage, confidence: e.confidence, sourceUrl: e.sourceUrl, sourceDomain: e.sourceDomain, sourceType: e.sourceType, tier: e.tier, publishedAt: e.publishedAt, quote: e.quote, evidenceId: e.id }
  : { found: false, lineage: null, confidence: null, sourceUrl: null, sourceDomain: null, sourceType: null, tier: null, publishedAt: null, quote: null, evidenceId: null };

const isSingle = (factKey: string | null) => !!factKey && factKey in FACT_REGISTRY && getFactDefinition(factKey).cardinality === "single";

export function buildLedger(athleteKey: string, arms: Record<string, DerivedArm>): LedgerRow[] {
  const providers = Object.keys(arms);
  const best: Record<string, Map<string, EvidenceRecord>> = {};
  for (const p of providers) {
    const m = new Map<string, EvidenceRecord>();
    for (const e of arms[p].evidence) { const k = matchKey(e); m.set(k, m.has(k) ? better(m.get(k)!, e) : e); }
    best[p] = m;
  }
  const keys = [...new Set(providers.flatMap((p) => [...best[p].keys()]))].sort();
  const rows: LedgerRow[] = keys.map((k) => {
    const sample = providers.map((p) => best[p].get(k)).find(Boolean)!;
    const found = providers.filter((p) => best[p].has(k));
    const armEntries: Record<string, LedgerArmEntry> = {};
    for (const p of providers) armEntries[p] = entryOf(best[p].get(k));
    const section = sample.section;
    const abstained = providers.filter((p) => !best[p].has(k) && section != null && arms[p].sectionOutcomes[section]?.status === "not_found");
    return { athleteKey, matchKey: k, kind: sample.kind as EvidenceKindV3, factKey: sample.factKey, claimedFactKey: sample.claimedFactKey, valueText: sample.valueText, section, domain: sample.domain as ResearchDomain, arms: armEntries, agreement: found.length === providers.length ? (providers.length > 2 ? "all" : "both") : `only:${found.join("+")}`, conflict: null, abstained };
  });
  // Conflicts: same single-cardinality fact key (birth_year counts as single), different values across arms — on BOTH rows, with each side's lineage.
  for (const row of rows) {
    const single = isSingle(row.factKey) || row.claimedFactKey === "birth_year";
    if (!row.claimedFactKey || !single) continue;
    const others: Array<{ provider: string; valueText: string; lineage: LineageStatus }> = [];
    for (const p of providers) for (const e of best[p].values()) if (e.claimedFactKey === row.claimedFactKey && norm(e.valueText) !== norm(row.valueText) && !row.arms[p].found) others.push({ provider: p, valueText: e.valueText, lineage: e.lineage });
    if (others.length) row.conflict = others;
  }
  return rows;
}

export function compareAthlete(athlete: BenchmarkAthlete, runs: ArmRun[], gold: GoldIdentity | null, policy: ResearchPolicy, derive: (arm: ArmRun, policy: ResearchPolicy, isMinor: boolean) => DerivedArm, minorByProvider: Record<string, ArmMetrics["minor"]> = {}): AthleteComparison {
  const derived: Record<string, DerivedArm> = {};
  const arms: Record<string, ArmMetrics> = {};
  for (const run of runs) { derived[run.provider] = derive(run, policy, !!athlete.isMinor); arms[run.provider] = armMetrics(run, derived[run.provider], gold, minorByProvider[run.provider] ?? null, run.extraction?.extractionMode === "provider_direct" ? (acc) => deriveDefault(run, policy, !!athlete.isMinor, acc) : undefined); }
  const ledger = buildLedger(athlete.key, derived);
  const providers = Object.keys(arms);
  const only: Record<string, number> = {}; const abstentions: Record<string, number> = {};
  for (const p of providers) { only[p] = ledger.filter((r) => r.agreement === `only:${p}`).length; abstentions[p] = ledger.filter((r) => r.abstained.includes(p)).length; }
  const [a, b] = providers;
  const d = (f: (m: ArmMetrics) => number | null): number | null => (a && b && f(arms[a]) != null && f(arms[b]) != null ? r3(f(arms[a])! - f(arms[b])!) : null);
  return {
    athleteKey: athlete.key, group: athlete.group, asOf: runs[0]?.asOf ?? "",
    arms, ledger,
    summary: { both: ledger.filter((r) => r.agreement === "both" || r.agreement === "all").length, only, conflicts: ledger.filter((r) => r.conflict).length, abstentions },
    deltas: { confidence: d((m) => m.confidence.meanClaim), coverage: d((m) => m.coverage.overall), costUsd: d((m) => m.costUsd), latencyMs: d((m) => m.latencyMs), mia: null },
  };
}

export function aggregate(comparisons: AthleteComparison[], asOf: string): Aggregate {
  const providers = [...new Set(comparisons.flatMap((c) => Object.keys(c.arms)))];
  const perProvider: Aggregate["perProvider"] = {};
  for (const p of providers) {
    const ms = comparisons.map((c) => c.arms[p]).filter(Boolean);
    const num = (f: (m: ArmMetrics) => number | null) => mean(ms.map(f).filter((x): x is number => x != null));
    const unsupported = ms.reduce((a, m) => a + m.identity.unsupported.count, 0), claims = ms.reduce((a, m) => a + m.evidence.claims, 0);
    const avgSectionCoverage = {} as Record<SectionId, number | null>;
    for (const sid of SECTION_IDS) avgSectionCoverage[sid] = r3(mean(ms.flatMap((m) => m.coverage.sections.filter((s) => s.section === sid).map((s) => s.coverage))));
    perProvider[p] = {
      avgClaims: r3(num((m) => m.evidence.claims))!, avgCited: r3(num((m) => m.evidence.cited))!, avgCitedShare: r3(num((m) => m.evidence.citedShare)), avgTier1to3Share: r3(num((m) => m.citations.tier1to3Share)), avgUniqueDomains: r3(num((m) => m.citations.uniqueDomains))!,
      avgClaimConfidence: r3(num((m) => m.confidence.meanClaim)), avgFactConfidence: r3(num((m) => m.confidence.meanFact)), avgRegistryCoverage: r3(num((m) => m.facts.registryCoverage))!, avgItemCoverage: r3(num((m) => m.coverage.overall))!, avgSectionCoverage, avgSubSignalCoverage: r3(num((m) => m.subSignals.coverage))!,
      avgIdentityConfidence: r3(num((m) => m.identity.aboutIdentityConfidence)), unsupportedShare: r3(claims ? unsupported / claims : null), conflatedTotal: ms.reduce((a, m) => a + m.identity.conflated.length, 0), abstentions: ms.filter((m) => m.status === "complete" && m.identity.abstention.abstained).length, incompleteArms: ms.filter((m) => m.status !== "complete").length, reportedDerivedAgreement: r3(num((m) => m.coverage.reportedDerivedAgreement)),
      costPerAthlete: r3(num((m) => m.costUsd))!, latencyPerAthleteMs: Math.round(num((m) => m.latencyMs) ?? 0),
      path: ms[0]?.path ?? "kimi", avgProviderUsd: r3(num((m) => m.costs.providerUsd))!, avgKimiUsd: r3(num((m) => m.costs.kimiUsd))!,
      provenance: ms.some((m) => m.provenance) ? (Object.fromEntries(PROVENANCE_LEVELS.map((l) => [l, ms.reduce((a, m) => a + (m.provenance?.[l] ?? 0), 0)])) as Record<ProvenanceLevel, number>) : null,
      policies: { strict: { factsAccepted: ms.reduce((a, m) => a + m.policies.strict.factsAccepted, 0), cited: ms.reduce((a, m) => a + m.policies.strict.cited, 0), itemsFound: ms.reduce((a, m) => a + m.policies.strict.itemsFound, 0) }, retrieved: { factsAccepted: ms.reduce((a, m) => a + m.policies.retrieved.factsAccepted, 0), cited: ms.reduce((a, m) => a + m.policies.retrieved.cited, 0), itemsFound: ms.reduce((a, m) => a + m.policies.retrieved.itemsFound, 0) } },
      survival: { providerEvidence: ms.reduce((a, m) => a + m.survival.providerEvidence, 0), afterExtractionOrProvenance: ms.reduce((a, m) => a + m.survival.afterExtractionOrProvenance, 0), afterRegistry: ms.reduce((a, m) => a + m.survival.afterRegistry, 0) },
      failures: { failedPartitions: ms.reduce((a, m) => a + m.failureRecovery.failedPartitions, 0), degeneratePartitions: ms.reduce((a, m) => a + m.failureRecovery.degeneratePartitions, 0), searchRetries: ms.reduce((a, m) => a + m.failureRecovery.searchRetries, 0), extractionAttempts: ms.reduce((a, m) => a + m.failureRecovery.extractionAttempts, 0) },
    };
  }
  const only: Record<string, number> = {};
  for (const p of providers) only[p] = comparisons.reduce((a, c) => a + (c.summary.only[p] ?? 0), 0);
  const byGroup: Aggregate["byGroup"] = {};
  for (const g of [...new Set(comparisons.map((c) => c.group))]) {
    const cs = comparisons.filter((c) => c.group === g);
    const pp: Aggregate["byGroup"][string]["perProvider"] = {};
    for (const p of providers) {
      const ms = cs.map((c) => c.arms[p]).filter(Boolean);
      pp[p] = { avgClaims: r3(mean(ms.map((m) => m.evidence.claims)))!, avgCited: r3(mean(ms.map((m) => m.evidence.cited)))!, avgItemCoverage: r3(mean(ms.map((m) => m.coverage.overall)))!, abstentions: ms.filter((m) => m.identity.abstention.abstained).length, avgIdentityConfidence: r3(mean(ms.map((m) => m.identity.aboutIdentityConfidence).filter((x): x is number => x != null))) };
    }
    byGroup[g] = { athletes: cs.length, perProvider: pp };
  }
  return {
    asOf, athletes: comparisons.length, providers, perProvider,
    agreement: { both: comparisons.reduce((a, c) => a + c.summary.both, 0), only, conflicts: comparisons.reduce((a, c) => a + c.summary.conflicts, 0) },
    byGroup,
    mia: { avgAbsDiff: null, dimensionVariance: null, blockedReason: BETA1_BLOCKED_REASON },
  };
}
