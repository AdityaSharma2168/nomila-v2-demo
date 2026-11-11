/**
 * research/benchmark/report.ts — Markdown rendering of the provider comparison. Pure.
 */

import { SECTION_IDS } from "../spec/researchSpecV1";
import type { Aggregate, AthleteComparison, LedgerRow } from "./types";

const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const num = (x: number | null | undefined, d = 2) => (x == null ? "—" : x.toFixed(d));
const usd = (x: number | null | undefined) => (x == null ? "—" : `$${x.toFixed(3)}`);
const secs = (ms: number | null | undefined) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);

export function renderAthlete(c: AthleteComparison): string {
  const ps = Object.keys(c.arms);
  const row = (label: string, f: (p: string) => string) => `| ${label} | ${ps.map(f).join(" | ")} |`;
  const lines: string[] = [];
  lines.push(`### ${c.athleteKey} (${c.group})${c.targetScore != null ? ` — frozen target ${c.targetScore} (evaluation only)` : ""}`, "", `| metric | ${ps.join(" | ")} |`, `|---|${ps.map(() => "---").join("|")}|`);
  lines.push(row("model / spec", (p) => `${c.arms[p].model ?? "—"} / ${c.arms[p].specVersion}`));
  lines.push(row("path", (p) => c.arms[p].path === "direct" ? "direct (provider → Nomila)" : "search → Kimi → Nomila"));
  lines.push(row("provenance: native_supported / native_retrieved / asserted_only / unsupported", (p) => { const v = c.arms[p].provenance; return v ? `${v.native_supported} / ${v.native_retrieved} / ${v.asserted_only} / ${v.unsupported}` : "— (path A: citation check)"; }));
  lines.push(row("facts accepted: strict policy / retrieved-source policy", (p) => `${c.arms[p].policies.strict.factsAccepted} / ${c.arms[p].policies.retrieved.factsAccepted}`));
  lines.push(row("items found: strict / retrieved", (p) => `${c.arms[p].policies.strict.itemsFound} / ${c.arms[p].policies.retrieved.itemsFound}`));
  lines.push(row("survival: provider evidence → after extraction/provenance → after registry", (p) => `${c.arms[p].survival.providerEvidence} → ${c.arms[p].survival.afterExtractionOrProvenance} → ${c.arms[p].survival.afterRegistry}`));
  lines.push(row("failure/recovery: extraction attempts / search retries / failed / degenerate partitions", (p) => `${c.arms[p].failureRecovery.extractionAttempts} / ${c.arms[p].failureRecovery.searchRetries} / ${c.arms[p].failureRecovery.failedPartitions} / ${c.arms[p].failureRecovery.degeneratePartitions}`));
  lines.push(row("cost: provider / Kimi / total", (p) => `${usd(c.arms[p].costs.providerUsd)} / ${usd(c.arms[p].costs.kimiUsd)} / ${c.arms[p].costComplete ? "" : "≥ "}${usd(c.arms[p].costs.totalUsd)}`));
  lines.push(row("direct identity (Q1): anchor match / confidence / namesakes", (p) => { const d = c.arms[p].directIdentity; return d ? `${d.anchorMatch ?? "—"} / ${num(d.confidence)} / ${d.namesakes}` : "—"; }));
  lines.push(row("arm status / extraction attempts / mode", (p) => `${c.arms[p].status}${c.arms[p].statusReason ? ` (${c.arms[p].statusReason.slice(0, 60)})` : ""} / ${c.arms[p].extractionAttempts} / ${c.arms[p].extractionMode ?? "—"}`));
  lines.push(row("partitions (query: status claims time)", (p) => (c.arms[p].partitions ?? []).map((x) => `${x.queryId}:${x.status} ${x.claims}c ${x.latencyMs == null ? "—" : `${Math.round(x.latencyMs / 1000)}s`}`).join(" · ") || "—"));
  lines.push(row("registry: accepted / canonicalized / refused", (p) => `${c.arms[p].registry.accepted} / ${c.arms[p].registry.acceptedCanonicalized} / ${c.arms[p].registry.refused}`));
  lines.push(row("minor policy", (p) => c.arms[p].minor ? `${c.arms[p].minor!.policy} (${c.arms[p].minor!.trigger}${c.arms[p].minor!.birthYear ? `, birth year ${c.arms[p].minor!.birthYear}` : ""})` : "—"));
  lines.push(row("claims / cited / cited share", (p) => `${c.arms[p].evidence.claims} / ${c.arms[p].evidence.cited} / ${pct(c.arms[p].evidence.citedShare)}`));
  lines.push(row("unsupported (uncited+conflicting+suspect)", (p) => `${c.arms[p].identity.unsupported.count} (${pct(c.arms[p].identity.unsupported.share)})`));
  lines.push(row("item coverage (found / requested)", (p) => `${c.arms[p].coverage.itemsFound} / ${c.arms[p].coverage.itemsRequested} (${pct(c.arms[p].coverage.overall)})`));
  for (const sid of SECTION_IDS) {
    const any = ps.some((p) => c.arms[p].coverage.sections.some((s) => s.section === sid));
    if (!any) continue;
    lines.push(row(`  ${sid} items found / status (reported→derived)`, (p) => { const s = c.arms[p].coverage.sections.find((x) => x.section === sid); return s ? `${s.found}/${s.requested} · ${s.reportedStatus ?? "—"}→${s.derivedStatus}` : "—"; }));
  }
  lines.push(row("reported vs derived item agreement", (p) => pct(c.arms[p].coverage.reportedDerivedAgreement)));
  lines.push(row("cited URLs / unique domains", (p) => `${c.arms[p].citations.citedUrls} / ${c.arms[p].citations.uniqueDomains}`));
  lines.push(row("citation quality (Nomila tiers): mean tier / tier≤3 share", (p) => `${num(c.arms[p].citations.meanTier, 1)} / ${pct(c.arms[p].citations.tier1to3Share)}`));
  lines.push(row("freshness: dated share / median age (days)", (p) => `${pct(c.arms[p].freshness.share)} / ${num(c.arms[p].freshness.medianAgeDays, 0)}`));
  lines.push(row("facts accepted / registry coverage / disputed", (p) => `${c.arms[p].facts.count} / ${pct(c.arms[p].facts.registryCoverage)} / ${c.arms[p].facts.disputed}`));
  lines.push(row("sub-signal evidence coverage", (p) => `${c.arms[p].subSignals.covered.length}/${c.arms[p].subSignals.total} (${pct(c.arms[p].subSignals.coverage)})`));
  lines.push(row("confidence: claims / facts", (p) => `${num(c.arms[p].confidence.meanClaim)} / ${num(c.arms[p].confidence.meanFact)}`));
  lines.push(row("identity: extractor confidence / namesakes reported", (p) => `${num(c.arms[p].identity.aboutIdentityConfidence)} / ${c.arms[p].identity.namesakesReported}`));
  lines.push(row("identity: anchor agree / disagree", (p) => `${c.arms[p].identity.anchorAgreement.agree} / ${c.arms[p].identity.anchorAgreement.disagree}`));
  lines.push(row("identity: internal conflicts / conflated", (p) => `${c.arms[p].identity.conflictingIdentity.length} / ${c.arms[p].identity.conflated.length}`));
  lines.push(row("abstention: sections not_found / items not_found / n/a / not-found statements / abstained", (p) => { const a = c.arms[p].identity.abstention; return `${a.sectionsNotFound.length} / ${a.itemsNotFound} / ${a.itemsNotApplicable} / ${a.explicitNotFound} / ${a.abstained ? "yes" : "no"}`; }));
  lines.push(row("reputation (cited): allegations / findings-actions / resolutions", (p) => `${c.arms[p].reputation.reported_allegation} / ${c.arms[p].reputation.official_finding_or_action} / ${c.arms[p].reputation.resolution_or_outcome}`));
  lines.push(row("social metric claims (evidence only) / follower mentions in text", (p) => `${c.arms[p].socialMetricClaims} / ${c.arms[p].followerMentionsInText}`));
  lines.push(row("calls search / extract", (p) => `${c.arms[p].calls.search} / ${c.arms[p].calls.extract}`));
  lines.push(row("latency", (p) => secs(c.arms[p].latencyMs)));
  lines.push(row("cost (estimate)", (p) => `${c.arms[p].costComplete ? "" : "≥ "}${usd(c.arms[p].costUsd)}${c.arms[p].costComplete ? "" : " (retry usage unavailable)"}`));
  lines.push(row("Beta.1 dimensions / M.I.A.", () => "blocked (no parameter bundle)"));
  lines.push("", `Ledger: ${c.summary.both} found by ${ps.length > 2 ? "all arms" : "both"}, ${ps.map((p) => `${c.summary.only[p]} only ${p}`).join(", ")}, ${c.summary.conflicts} conflicts, abstentions ${ps.map((p) => `${p}: ${c.summary.abstentions[p]}`).join(", ")}.`);
  const disagreements = c.ledger.filter((r) => r.conflict);
  if (disagreements.length) {
    lines.push("", "Factual disagreements:");
    for (const r of disagreements) lines.push(`- ${r.claimedFactKey}: ${ps.map((p) => `${p} → ${r.arms[p].found ? `${r.valueText} [${r.arms[p].lineage}]` : (r.conflict!.filter((x) => x.provider === p).map((x) => `${x.valueText} [${x.lineage}]`).join(" / ") || "—")}`).join(" vs ")}`);
  }
  const missing = c.ledger.filter((r) => r.agreement !== "both" && r.claimedFactKey);
  if (missing.length) {
    lines.push("", "Missing / extra facts (fact keys found by one arm only):");
    for (const r of missing.slice(0, 40)) lines.push(`- ${r.agreement.replace("only:", "only ")}: ${r.claimedFactKey} = ${r.valueText}${r.abstained.length ? ` (abstained: ${r.abstained.join(", ")})` : ""}`);
    if (missing.length > 40) lines.push(`- … ${missing.length - 40} more in the ledger JSON`);
  }
  return lines.join("\n");
}

export function renderAggregate(a: Aggregate): string {
  const ps = a.providers;
  const row = (label: string, f: (p: string) => string) => `| ${label} | ${ps.map(f).join(" | ")} |`;
  const lines = [`## Aggregate — ${a.athletes} athletes, as of ${a.asOf}`, "", `| metric | ${ps.join(" | ")} |`, `|---|${ps.map(() => "---").join("|")}|`];
  lines.push(row("avg claims / cited", (p) => `${num(a.perProvider[p].avgClaims, 1)} / ${num(a.perProvider[p].avgCited, 1)}`));
  lines.push(row("avg cited share (evidence acceptance)", (p) => pct(a.perProvider[p].avgCitedShare)));
  lines.push(row("avg item coverage (ResearchSpec v1)", (p) => pct(a.perProvider[p].avgItemCoverage)));
  for (const sid of SECTION_IDS) lines.push(row(`  avg ${sid} coverage`, (p) => pct(a.perProvider[p].avgSectionCoverage[sid])));
  lines.push(row("reported vs derived item agreement", (p) => pct(a.perProvider[p].reportedDerivedAgreement)));
  lines.push(row("avg citation quality (Nomila tier≤3 share)", (p) => pct(a.perProvider[p].avgTier1to3Share)));
  lines.push(row("avg unique source domains", (p) => num(a.perProvider[p].avgUniqueDomains, 1)));
  lines.push(row("avg confidence: claims / facts", (p) => `${num(a.perProvider[p].avgClaimConfidence)} / ${num(a.perProvider[p].avgFactConfidence)}`));
  lines.push(row("avg registry coverage / sub-signal coverage", (p) => `${pct(a.perProvider[p].avgRegistryCoverage)} / ${pct(a.perProvider[p].avgSubSignalCoverage)}`));
  lines.push(row("avg identity confidence", (p) => num(a.perProvider[p].avgIdentityConfidence)));
  lines.push(row("unsupported share / conflated total / abstentions (complete arms) / incomplete arms", (p) => `${pct(a.perProvider[p].unsupportedShare)} / ${a.perProvider[p].conflatedTotal} / ${a.perProvider[p].abstentions} / ${a.perProvider[p].incompleteArms}`));
  lines.push(row("path", (p) => a.perProvider[p].path === "direct" ? "direct (provider → Nomila)" : "search → Kimi → Nomila"));
  lines.push(row("provenance totals: supported / retrieved / asserted / unsupported", (p) => { const v = a.perProvider[p].provenance; return v ? `${v.native_supported} / ${v.native_retrieved} / ${v.asserted_only} / ${v.unsupported}` : "— (citation check)"; }));
  lines.push(row("facts accepted (4 athletes): strict / retrieved-source", (p) => `${a.perProvider[p].policies.strict.factsAccepted} / ${a.perProvider[p].policies.retrieved.factsAccepted}`));
  lines.push(row("survival totals: provider → extraction/provenance → registry", (p) => `${a.perProvider[p].survival.providerEvidence} → ${a.perProvider[p].survival.afterExtractionOrProvenance} → ${a.perProvider[p].survival.afterRegistry}`));
  lines.push(row("failures: failed / degenerate partitions / search retries", (p) => `${a.perProvider[p].failures.failedPartitions} / ${a.perProvider[p].failures.degeneratePartitions} / ${a.perProvider[p].failures.searchRetries}`));
  lines.push(row("cost per athlete: provider / Kimi / total; latency", (p) => `${usd(a.perProvider[p].avgProviderUsd)} / ${usd(a.perProvider[p].avgKimiUsd)} / ${usd(a.perProvider[p].costPerAthlete)}; ${secs(a.perProvider[p].latencyPerAthleteMs)}`));
  lines.push(row("avg |ΔM.I.A.| / dimension variance", () => "blocked (no parameter bundle)"));
  lines.push("", `Fact agreement: ${a.agreement.both} found by ${ps.length > 2 ? "all arms" : "both"}, ${ps.map((p) => `${a.agreement.only[p]} only ${p}`).join(", ")}, ${a.agreement.conflicts} conflicts.`, "", "By cohort group:", "", `| group | athletes | ${ps.map((p) => `${p} claims/cited/coverage/abstained/identity`).join(" | ")} |`, `|---|---|${ps.map(() => "---").join("|")}|`);
  for (const [g, v] of Object.entries(a.byGroup)) lines.push(`| ${g} | ${v.athletes} | ${ps.map((p) => `${num(v.perProvider[p].avgClaims, 1)} / ${num(v.perProvider[p].avgCited, 1)} / ${pct(v.perProvider[p].avgItemCoverage)} / ${v.perProvider[p].abstentions} / ${num(v.perProvider[p].avgIdentityConfidence)}`).join(" | ")} |`);
  lines.push("", `Beta.1 columns: ${a.mia.blockedReason}.`);
  return lines.join("\n");
}

export function ledgerCsv(rows: LedgerRow[], providers: string[]): string {
  const head = ["athlete", "section", "kind", "factKey", "valueText", "domain", "agreement", "conflict", "abstained", ...providers.flatMap((p) => [`${p}.found`, `${p}.lineage`, `${p}.confidence`, `${p}.sourceDomain`, `${p}.sourceType`, `${p}.tier`, `${p}.publishedAt`, `${p}.sourceUrl`])];
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [head.join(",")];
  for (const r of rows) lines.push([r.athleteKey, r.section ?? "", r.kind, r.claimedFactKey ?? "", r.valueText, r.domain, r.agreement, r.conflict ? r.conflict.map((c) => `${c.provider}:${c.valueText}[${c.lineage}]`).join(";") : "", r.abstained.join(";"), ...providers.flatMap((p) => { const a = r.arms[p]; return [a.found, a.lineage, a.confidence, a.sourceDomain, a.sourceType, a.tier, a.publishedAt, a.sourceUrl]; })].map(esc).join(","));
  return lines.join("\n");
}
