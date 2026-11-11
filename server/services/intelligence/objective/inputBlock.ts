/**
 * inputBlock.ts — render the Opportunity Map for the Objective evaluator.
 *
 * Evidence, not methodology: excluded from the canonical digest. The state half is rendered by
 * `../opportunity/stateBlock.ts`, unchanged, so the evaluator sees the athlete exactly as Opportunity did.
 *
 * EVERY OPPORTUNITY SHOWS ITS KEY, because the evaluator must account for every one of them by key — carried into a
 * proposal's provenance or noted with a reason. Asking it to account for keys it cannot see would manufacture
 * accounting failures that are ours.
 *
 * The opportunity's own citations are shown too, so a proposal that consolidates two openings can see that they
 * rest on the same findings, which is the honest basis for consolidation.
 */
import type { OpportunityMap } from "../contracts/opportunity";

export function renderOpportunityBlock(m: OpportunityMap): string {
  const L: string[] = [];
  L.push(`Strategic openings identified as of ${m.asOf} (${m.specVersion}), judged from the athlete state as of ${m.stateAsOf}.`);
  L.push(`Overall confidence in this map: ${m.overallConfidence}.`);
  L.push("");
  L.push("Cite an opportunity by the key shown at its left. Every key below must appear exactly once in your output —");
  L.push("in a proposal's from_opportunities, or in notes as consolidated (into a named proposal) or not_carried.");
  L.push("");
  if (!m.opportunities.length) {
    L.push("    (the map is empty — no opening was identified. Proposals may still arise from recorded athlete intent.)");
  }
  for (const o of m.opportunities) {
    L.push(`    ${o.key}`);
    L.push(`        ${o.kind} · ${o.domain} · confidence ${o.confidence}`);
    L.push(`        ${o.statement.value}`);
    L.push(`        impact(${o.impact.level}): ${o.impact.claim}`);
    L.push(`        feasibility(${o.feasibility.level}): ${o.feasibility.claim}`);
    if (o.urgency) L.push(`        urgency(${o.urgency.level}): ${o.urgency.claim}`);
    if (o.athleteStance) L.push(`        athlete stance: ${o.athleteStance.stance.toUpperCase()} — ${o.athleteStance.subject}`);
    L.push(`        rests on: ${o.restsOn.map((r) => r.statePath).join(", ")}`);
    L.push("");
  }
  if (m.notes.length) {
    L.push("Why other domains yielded nothing, per the Opportunity evaluator:");
    for (const n of m.notes) L.push(`    - ${n}`);
  }
  return L.join("\n");
}
