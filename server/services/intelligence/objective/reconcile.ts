/**
 * reconcile.ts — what a NEW proposal set does to the Objectives an athlete already has. `objective-reconciliation/2.0.0`.
 *
 * 1.0.0 identified a proposal by its wording. Experiment 1 showed that is the wrong axis: athlete governance changes
 * wording on purpose, and the evaluator rephrases itself between runs (one match in four). 2.0.0 reconciles by
 * STRATEGIC LINEAGE — the State evidence a proposal ultimately rests on — with wording demoted to a weak tie-breaker
 * (objectives-lineage-design.md §1).
 *
 * TWO THINGS THIS IS NOT.
 *   Lineage is not identity. Evidence lineage identifies candidate strategic continuity or relationship; the
 *   athlete-governed Objective entity remains the identity. A match says "stands on the same ground", nothing more.
 *   Reconciliation is not editing. Evaluator reruns may describe a different topology over the same territory; they
 *   cannot merge, split, reshape, replace, suppress or redefine athlete-governed live Objectives. A proposal across
 *   two live Objectives is `spans`; two proposals inside one is `splits`; both are relationships on the record, never
 *   rows and never edits. Athlete-created Objectives never match by lineage at all.
 *
 * PARAMETERS ARE VERSIONED STARTING HYPOTHESES. `lineageMin` was measured once, on experiment 1, where it separated
 * cleanly (1.00 / 0.83 / 1.00 / 1.00 against the right originals, ≤ 0.29 against the wrong, 0.60 on the one real
 * span). It must be re-measured on the first fresh Opportunity run, where opportunity keys change and only tier B
 * applies. Nothing here moves by a silent edit.
 */
import type { ObjectiveProposal } from "../contracts/objective";
import type { Objective, ObjectiveLineage } from "../contracts/objectiveEntity";
import type { OpportunityMap } from "../contracts/opportunity";
import { isLive } from "./entity";
import { jaccard } from "./grounding";

export const RECONCILIATION_PARAMS = {
  version: "objective-reconciliation/2.0.0",
  /** Jaccard over evidence paths at or above which a proposal is a lineage-relationship candidate (tier B). */
  lineageMin: 0.5,
  /** Wording Jaccard for the weak tie-breaker (tier C) — a finding, never a verdict. Unchanged from 1.0.0. */
  wordingTieBreak: 0.6,
  /** A decline younger than this is not re-surfaced; older, it is shown once with the date she said no. */
  declineWindowDays: 90,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Lineage
// ─────────────────────────────────────────────────────────────────────────────

/** `inbound[2]` → `inbound[]`: a positional index is a sort position, not an identity. Keyed selectors stay. */
export const normalisePath = (p: string): string => p.replace(/\[\d+\]/g, "[]");

/**
 * What a proposal rests on, computed once from the proposal and the map it was judged from: its own current-state
 * citations plus each cited opportunity's `restsOn`. Sorted and deduplicated so two signatures compare by content.
 */
export function lineageFor(p: ObjectiveProposal, map: OpportunityMap): ObjectiveLineage {
  const ev = new Set<string>(p.provenance.currentStateEvidence.map((c) => normalisePath(c.statePath)));
  const keys: string[] = [];
  for (const c of p.provenance.fromOpportunities) {
    keys.push(c.opportunityKey);
    const o = map.opportunities.find((x) => x.key === c.opportunityKey);
    for (const r of o?.restsOn ?? []) ev.add(normalisePath(r.statePath));
  }
  return {
    domain: p.domain,
    opportunityKeys: [...new Set(keys)].sort(),
    mapAsOf: map.asOf,
    evidencePaths: [...ev].sort(),
    intentPaths: [...new Set(p.provenance.fromAthleteIntent.map((c) => c.statePath))].sort(),
  };
}

const setJaccard = (a: readonly string[], b: readonly string[]): number => {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 0;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
};

export type Tier = "A" | "B" | "C";

/** One candidate relationship between a proposal and an existing Objective, with how it was found and how strong. */
export interface Candidate {
  objective: Objective;
  tier: Tier;
  /** Lineage relates across domains: the evaluator moves territory between domains when it consolidates. Recorded. */
  sameDomain: boolean;
  /** Tier A/B: evidence-path Jaccard. Tier C: wording Jaccard. */
  strength: number;
  evidenceJaccard: number;
  wordingJaccard: number;
  opportunityKeyOverlap: number;
}

/**
 * EVERY candidate for a proposal, strong or weak, so the report can show what was considered and not only what
 * was chosen. Athlete-created Objectives (no lineage) are considered for tier C only.
 *
 * LINEAGE IS NOT GATED ON DOMAIN. The design page said "same domain" for tier B; the implementation found that the
 * experiment's own span — the positioning proposal that folded the impact Objective — is CROSS-domain, because
 * consolidation moves territory between domains. Gating would miss exactly the case the relationship exists for.
 * The weak wording tie-breaker (tier C) stays domain-gated: wording alone across domains is noise. Recorded as a
 * deviation from objectives-lineage-design.md §1.3, for review.
 */
export function candidatesFor(p: ObjectiveProposal, lp: ObjectiveLineage, existing: Objective[]): Candidate[] {
  const out: Candidate[] = [];
  for (const o of existing) {
    const sameDomain = o.domain === p.domain;
    const words = [o.desiredState.value, o.modifiedFrom?.desiredState].filter((w): w is string => !!w);
    const wordingJaccard = Math.max(...words.map((w) => jaccard(w, p.desiredState.value)));
    const lo = o.lineage;
    const lineageComparable = !!lo && lo.evidencePaths.length > 0;
    const evidenceJaccard = lineageComparable ? setJaccard(lo!.evidencePaths, lp.evidencePaths) : 0;
    const keyOverlap = lineageComparable && lo!.mapAsOf === lp.mapAsOf ? lo!.opportunityKeys.filter((k) => lp.opportunityKeys.includes(k)).length : 0;
    let tier: Tier | null = null; let strength = 0;
    if (keyOverlap > 0) { tier = "A"; strength = evidenceJaccard; }
    else if (lineageComparable && evidenceJaccard >= RECONCILIATION_PARAMS.lineageMin) { tier = "B"; strength = evidenceJaccard; }
    else if (sameDomain && wordingJaccard >= RECONCILIATION_PARAMS.wordingTieBreak) { tier = "C"; strength = wordingJaccard; }
    if (tier) out.push({ objective: o, tier, sameDomain, strength, evidenceJaccard, wordingJaccard, opportunityKeyOverlap: keyOverlap });
  }
  return out.sort((x, y) => y.strength - x.strength);
}

// ─────────────────────────────────────────────────────────────────────────────
// Relationships and verdicts
// ─────────────────────────────────────────────────────────────────────────────

export type Relationship =
  | { kind: "new"; candidates: Candidate[] }
  /** One lineage match. What happens is decided by the match's governed state (below). */
  | { kind: "continues"; match: Candidate; candidates: Candidate[] }
  /** Lineage matches on two or more LIVE Objectives: the evaluator consolidated territory she keeps apart. */
  | { kind: "spans"; matches: Candidate[]; candidates: Candidate[] }
  /** Only a weak wording match: recorded on the Objective, and the proposal is otherwise treated as new. */
  | { kind: "may_relate"; match: Candidate; candidates: Candidate[] };

export function relate(p: ObjectiveProposal, lp: ObjectiveLineage, existing: Objective[]): Relationship {
  const candidates = candidatesFor(p, lp, existing);
  const lineageMatches = candidates.filter((c) => c.tier !== "C");
  const liveMatches = lineageMatches.filter((c) => isLive(c.objective));
  if (liveMatches.length >= 2) return { kind: "spans", matches: liveMatches, candidates };
  // One live match beats a stronger non-live one: her governed Objective on this ground takes precedence, and the
  // deferred or declined sibling stays visible in `candidates` rather than being re-surfaced past it.
  if (lineageMatches.length >= 1) return { kind: "continues", match: liveMatches[0] ?? lineageMatches[0]!, candidates };
  const weak = candidates.find((c) => c.tier === "C");
  if (weak) return { kind: "may_relate", match: weak, candidates };
  return { kind: "new", candidates };
}

/** What a `continues` relationship does, decided by the matched Objective's governed state. */
export type ContinuesVerdict =
  | { kind: "reaffirms" }
  | { kind: "repeats_decline"; declinedAt: string }
  | { kind: "re_surfaces"; because: "time_elapsed" }
  | { kind: "new_with_history" };

export function continuesVerdict(match: Objective, now: string): ContinuesVerdict {
  if (isLive(match)) return { kind: "reaffirms" };
  if (match.lifecycle === "proposed") {
    switch (match.disposition) {
      case "unreviewed": return { kind: "reaffirms" };
      // L2: the deferral's KIND decides. `information` (and any pre-L2 deferral, read conservatively as
      // information) never re-surfaces by a run — evidence change is a signal the store records, not a trigger.
      // `time` re-surfaces once its instant has passed. `athlete` only by her revisit.
      case "deferred": {
        const d = match.deferral;
        if (d?.kind === "time" && d.after && Date.parse(now) >= Date.parse(d.after)) return { kind: "re_surfaces", because: "time_elapsed" };
        return { kind: "reaffirms" };
      }
      case "declined": {
        const declinedAt = match.reviewedAt ?? match.createdAt;
        const ageDays = (Date.parse(now) - Date.parse(declinedAt)) / 86_400_000;
        return ageDays < RECONCILIATION_PARAMS.declineWindowDays ? { kind: "repeats_decline", declinedAt } : { kind: "new_with_history" };
      }
      case "accepted": case "modified": return { kind: "reaffirms" };
    }
  }
  return { kind: "new_with_history" };
}

/**
 * `splits`: two or more proposals in one set continue the SAME live Objective — the evaluator decomposed her
 * territory differently. Her Objective is unchanged; each proposal reaffirms; one finding names them all.
 */
export function splitsIn(relations: Array<{ proposalKey: string; relationship: Relationship }>): Array<{ objectiveId: string; proposalKeys: string[] }> {
  const byObjective = new Map<string, string[]>();
  for (const r of relations) {
    if (r.relationship.kind !== "continues" || !isLive(r.relationship.match.objective)) continue;
    const id = r.relationship.match.objective.id;
    byObjective.set(id, [...(byObjective.get(id) ?? []), r.proposalKey]);
  }
  return [...byObjective].filter(([, keys]) => keys.length >= 2).map(([objectiveId, proposalKeys]) => ({ objectiveId, proposalKeys }));
}
