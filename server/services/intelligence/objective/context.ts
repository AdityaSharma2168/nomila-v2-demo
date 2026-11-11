/**
 * context.ts — what the review surface shows beside a queued Objective. PR3b-3, rebuilt on structured evidence (L0).
 *
 * The surface is partly an instrument: we need to see what the athlete is reacting to, so the proposal's own
 * reasoning and provenance travel with it, unsimplified. Everything here is RESOLVED against the structured State
 * snapshot and Opportunity Map persisted with the proposal set — the exact objects the evaluator was shown — through
 * the same path grammar the grounding gate uses. Nothing is recomputed, re-evaluated, or parsed out of rendered
 * prose. A citation that does not resolve is reported as such, not invented.
 */
import type { AthleteState } from "../contracts/athleteState";
import type { Objective } from "../contracts/objectiveEntity";
import type { OpportunityMap } from "../contracts/opportunity";
import { resolveStatePath } from "../opportunity/grounding";

export interface ReviewContext {
  /** The evaluator's own rationale for the outcome, verbatim. */
  rationale: string | null;
  /** The openings this came from: the citation's `how`, and the opportunity as the evaluator saw it. */
  opportunities: Array<{ key: string; how: string; statement: string | null; kind: string | null }>;
  /** What Nomila knows: each cited State path with the value it resolved to, described. */
  evidence: Array<{ statePath: string; how: string; line: string | null }>;
  /** What she told us: the intent citations, resolved the same way. */
  intent: Array<{ statePath: string; how: string; line: string | null }>;
}

export interface EvidenceAsSeen {
  state: AthleteState;
  map: OpportunityMap;
}

const NOT_IN_RECORD = null;

/** One line for a resolved State value, in the vocabulary the State block uses. Deterministic, no judgement. */
export function describeStateValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v !== "object") return String(v);
  const o = v as any;
  if (o.evidenceClass === "MISSING") return `not known (${o.reason ?? "no reason recorded"})`;
  if (o.evidenceClass === "MEASURED" && "value" in o) return `${JSON.stringify(o.value)}  [measured · ${o.confidence} confidence]`;
  if (typeof o.direction === "string" && o.basis) {
    const score = o.basis.evidenceClass === "MEASURED" ? String(o.basis.value) : "not scored";
    const imp = o.imputedShare ? ` · ${o.imputedShare.imputed}/${o.imputedShare.total} signals imputed` : "";
    return `${String(o.direction).toUpperCase()} · score ${score}${imp}`;
  }
  if (typeof o.stance === "string" && typeof o.subject === "string") {
    const rec = o.recordedAs?.method === "onboarding_v1_choice" ? `  [ONBOARDING CHOICE${o.recordedAs.at ? ` · ${String(o.recordedAs.at).slice(0, 10)}` : ""}]` : "";
    return `${o.stance}${o.note ? ` — "${o.note}"` : ""}${rec}`;
  }
  if (typeof o.category === "string" && "counterparty" in o) return `${o.category} · ${o.counterparty ?? "counterparty unknown"} · ${String(o.lastMessageAt ?? "").slice(0, 10)}`;
  if (typeof o.platform === "string" && "followers" in o) return `${o.platform} · followers ${describeStateValue(o.followers)}`;
  if (typeof o.platform === "string" && ("postsPerWeek" in o || "daysSinceLastPost" in o)) {
    return [o.postsPerWeek !== undefined ? `${o.postsPerWeek} posts/week` : null, o.daysSinceLastPost !== undefined ? `${o.daysSinceLastPost} days since last post` : null].filter(Boolean).join(" · ");
  }
  if (typeof o.kind === "string" && typeof o.date === "string") return `${o.date} ${String(o.kind).replace(/_/g, " ")} — ${o.subject ?? ""}`;
  return JSON.stringify(v);
}

function lineFor(state: AthleteState | null, statePath: string): string | null {
  if (!state) return NOT_IN_RECORD;
  const r = resolveStatePath(state, statePath);
  return r.ok ? describeStateValue(r.value) : NOT_IN_RECORD;
}

function opportunityFor(map: OpportunityMap | null, key: string): { statement: string | null; kind: string | null } {
  const o = map?.opportunities.find((x) => x.key === key);
  return o ? { statement: o.statement.value, kind: o.kind } : { statement: null, kind: null };
}

export function reviewContextFor(o: Objective, seen: EvidenceAsSeen | null): ReviewContext {
  const state = seen?.state ?? null, map = seen?.map ?? null;
  const rationale = o.desiredState.evidenceClass === "EVALUATED" ? o.desiredState.rationale : null;
  return {
    rationale: rationale || null,
    opportunities: o.provenance.fromOpportunities.map((c) => ({ key: c.opportunityKey, how: c.how, ...opportunityFor(map, c.opportunityKey) })),
    evidence: o.provenance.currentStateEvidence.map((c) => ({ statePath: c.statePath, how: c.how, line: lineFor(state, c.statePath) })),
    intent: o.provenance.fromAthleteIntent.map((c) => ({ statePath: c.statePath, how: c.how, line: lineFor(state, c.statePath) })),
  };
}
