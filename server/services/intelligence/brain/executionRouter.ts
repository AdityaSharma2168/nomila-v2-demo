/**
 * brain/executionRouter.ts — EXPERIMENTAL, pure: the deterministic router between a governed Recommendation and the
 * execution shape the Brain classified (recommendation-execution-path-boundary-checkpoint.md §8, substrate checkpoint
 * §9–§10). It VALIDATES the shape against its contract, DEDUPLICATES against execution already underway, and HANDS OFF
 * by reference. It refuses; it never repairs, never infers a shape from prose, never sends, spends or publishes, and
 * holds no state. Nothing here is mounted; the forcing experiment runs it offline on recorded runs.
 *
 * Shapes (the Brain's strategic classification, `value.executionPath`):
 *   direct_action     one existing capability owns the next work: requires `advances` naming an in-motion subject and,
 *                     for a commercial subject, a typed `intent`. Handoff = the Deals ExecutionIntent seam (0.7.0-exp).
 *   specialized_plan  coordinated work in one domain, no persistent activation: requires a domain derivable from the
 *                     subject / Objective domain. Handoff = a PlannerHandoff by reference — never an artefact choice.
 *   campaign          a persistent activation (#570 §1): requires a purpose in the Brain's own words and a reason to
 *                     end (`endsWith`) stated — refused, never downgraded, when either is absent. Handoff = a
 *                     CampaignOriginProposal in #570 §4.1's shape with only what the Recommendation established.
 */
import type { Objective } from "../contracts/objectiveEntity";
import { subjectRefString, type ExistingWork, type CampaignEnd } from "./contract";
import { executionIntentFrom, type ExecutionIntent } from "../../dealsExecutionSeam";
import { isGoverned, type RecommendationLedger, type RecommendationRecord } from "./recommendation";

export const EXECUTION_ROUTER_VERSION = "execution-router/0.2.0-exp";

export type PlannerDomain = "content" | "outreach" | "relationships" | "athletic" | "impact" | "career" | "commercial" | "owned_venture" | "positioning";

export interface PlannerHandoff {
  version: typeof EXECUTION_ROUTER_VERSION; shape: "specialized_plan"; recommendationId: string; domain: PlannerDomain;
  what: string; why: string; subject: string; objectiveIds: string[]; advances: string | null; intent: string | null; notSeen: string[];
  /** Evidence by reference: the run that judged it. The planner reads the evidence there; nothing is copied. */
  runId: string;
}

/** #570 §4.1, restricted to what a Recommendation can establish. Deliverables are deliberately absent: they are the planner's / the spec's, never the Brain's. */
export interface CampaignOriginProposal {
  version: typeof EXECUTION_ROUTER_VERSION; shape: "campaign"; door: "recommendation"; recommendationId: string;
  purpose: string; objectiveIds: string[]; dealIds: string[]; brandIds: number[];
  /** Resolved from the Recommendation's typed `ends` reference against the authoritative object — never from prose. */
  period: { startsOn: string | null; endsOn: string | null; endsWith: "deal_term" | "objective_horizon" | "athlete_stated"; endsRef: string };
  constraints: Array<{ text: string; source: "recommendation" }>;
  evidence: Array<{ ref: string; how: string }>;
}

export type Handoff =
  | { shape: "direct_action"; intent: ExecutionIntent }
  | PlannerHandoff
  | CampaignOriginProposal;

export type RouteResult =
  | { ok: true; handoff: Handoff; dedup: { attachedTo: string | null } }
  | { ok: false; refused: string; stage: "governance" | "shape" | "dedup" };

/**
 * R17: resolve the Brain's typed `ends` reference against the authoritative object. The router validates a STATED end
 * condition; it never infers one from `what` or `why`. Returns the resolved period, or the reason it cannot.
 */
export function resolveEnd(ends: CampaignEnd | null | undefined, ctx: EndSources): { ok: true; period: CampaignOriginProposal["period"] } | { ok: false; reason: string } {
  if (!ends) return { ok: false, reason: "campaign without a typed reason to end (`ends`) — refused, not downgraded (#570 invariant 2)" };
  const id = (kind: string) => { const m = new RegExp(`^${kind}\\[(.+)\\]$`).exec(ends.ref); return m ? m[1] : null; };
  switch (ends.source) {
    case "objective_horizon": {
      const oid = id("objective"); const o = oid ? ctx.objectives.find((x) => x.id === oid) : undefined;
      if (!o) return { ok: false, reason: `ends cites ${ends.ref}, which is not a live Objective` };
      if (!o.horizon) return { ok: false, reason: `ends cites ${ends.ref}, whose horizon is open — nothing there ends a campaign` };
      return { ok: true, period: { startsOn: null, endsOn: null, endsWith: "objective_horizon", endsRef: ends.ref } };
    }
    case "deal_term": {
      const did = id("deal"); const w = did ? ctx.work.items.find((x) => x.ref.kind === "deal" && x.ref.id === did) : undefined;
      if (!w) return { ok: false, reason: `ends cites ${ends.ref}, which is not rendered in EXISTING WORK` };
      if (!w.termEnd) return { ok: false, reason: `ends cites ${ends.ref}, which has no recorded term end` };
      return { ok: true, period: { startsOn: w.termStart ?? null, endsOn: w.termEnd, endsWith: "deal_term", endsRef: ends.ref } };
    }
    case "athlete_stated": {
      const a = ctx.assertions.find((x) => x.ref === ends.ref);
      if (!a) return { ok: false, reason: `ends cites ${ends.ref}, which is not a finish she has stated on record` };
      return { ok: true, period: { startsOn: null, endsOn: a.endsOn, endsWith: "athlete_stated", endsRef: ends.ref } };
    }
  }
  return { ok: false, reason: `ends.source unknown: ${String((ends as { source?: unknown }).source)}` };
}

/** The authoritative objects an end may be resolved against. Nothing here is prose. */
export interface EndSources {
  objectives: Array<Pick<Objective, "id" | "horizon">>;
  work: ExistingWork;
  /** Finishes the athlete has stated on record, by the reference the Brain saw them under. None exist in the harness yet. */
  assertions: Array<{ ref: string; endsOn: string | null }>;
}

/** The planning domain a Recommendation belongs to. Exported so the readiness projection reads the same derivation. */
export const plannerDomainFor = (r: RecommendationRecord, objectives: Pick<Objective, "id" | "domain">[]): PlannerDomain | null => {
  if (r.subject.kind === "deal" || r.subject.kind === "brand") return "commercial";
  const obj = objectives.find((o) => r.objectiveIds.includes(o.id));
  const d = obj?.domain as string | undefined;
  const map: Record<string, PlannerDomain> = { audience: "content", content: "content", positioning: "outreach", commercial: "commercial", impact: "impact", career: "career", relationships: "relationships", athletic: "athletic", owned_venture: "owned_venture" };
  return d && map[d] ? map[d] : null;
};

/**
 * Route one governed Recommendation. `objectives` are the run's live Objectives (for domain and horizon); `work` is the
 * Existing Work view the run saw; `ledger` is the Recommendation ledger (for execution refs on other records).
 */
export function route(r: RecommendationRecord, ctx: { objectives: Array<Pick<Objective, "id" | "domain" | "horizon">>; work: ExistingWork; ledger: RecommendationLedger; runId: string; assertions?: Array<{ ref: string; endsOn: string | null }> }): RouteResult {
  if (r.value.executionPath !== "campaign" && r.value.ends) return { ok: false, stage: "shape", refused: `ends on a ${r.value.executionPath} — only a campaign carries a reason to end` };
  // governance: only a prepare-authorized Recommendation may be handed to execution (the contract's own rule)
  if (r.authorization.state !== "prepare_authorized") return { ok: false, stage: "governance", refused: `preparation not authorized (response ${r.response.state}, authorization ${r.authorization.state})` };

  // dedup: is this Recommendation, or the same intended work, already in execution?
  if (r.execution.refs.length) return { ok: false, stage: "dedup", refused: `already in execution: ${r.execution.refs.map((x) => `${x.kind}:${x.id}`).join(", ")} — attach, do not create` };
  const mine = ctx.work.items.find((w) => w.for?.recommendationId === r.id);
  if (mine) return { ok: false, stage: "dedup", refused: `existing work ${subjectRefString(mine.ref)} is executing this Recommendation — attach, do not create` };
  const sameIntent = ctx.work.items.find((w) => w.for?.recommendationId && w.for.recommendationId !== r.id && (w.for.objectiveIds ?? []).some((o) => r.objectiveIds.includes(o)) && ctx.ledger.records.some((x) => x.id === w.for!.recommendationId && !x.closed && x.value.executionPath === r.value.executionPath));
  if (sameIntent) return { ok: false, stage: "dedup", refused: `existing work ${subjectRefString(sameIntent.ref)} executes recommendation ${sameIntent.for!.recommendationId} for the same Objective and shape — reconcile, do not create` };
  const governedSibling = ctx.ledger.records.find((x) => x.id !== r.id && !x.closed && isGoverned(x) && x.execution.refs.length && x.objectiveIds.some((o) => r.objectiveIds.includes(o)) && x.value.executionPath === r.value.executionPath && x.reconsiders !== r.id && r.reconsiders !== x.id);
  if (governedSibling) return { ok: false, stage: "dedup", refused: `recommendation ${governedSibling.id} on the same Objective and shape already has execution ${governedSibling.execution.refs.map((x) => `${x.kind}:${x.id}`).join(", ")}` };

  // shape
  switch (r.value.executionPath) {
    case "direct_action": {
      if (!r.value.advances) return { ok: false, stage: "shape", refused: "direct_action must advance an in-motion subject" };
      if (r.subject.kind === "deal" && !r.value.intent) return { ok: false, stage: "shape", refused: "direct_action on a commercial subject needs a typed intent" };
      if (r.subject.kind !== "deal") return { ok: false, stage: "shape", refused: `no execution capability owns a direct action on ${r.subject.kind}[…] today — Deals is the only one` };
      return { ok: true, handoff: { shape: "direct_action", intent: executionIntentFrom(r) }, dedup: { attachedTo: null } };
    }
    case "specialized_plan": {
      const domain = plannerDomainFor(r, ctx.objectives);
      if (!domain) return { ok: false, stage: "shape", refused: "no planning domain derivable from the subject or Objective" };
      return { ok: true, dedup: { attachedTo: null }, handoff: { version: EXECUTION_ROUTER_VERSION, shape: "specialized_plan", recommendationId: r.id, domain, what: r.value.what, why: r.value.why, subject: subjectRefString(r.subject), objectiveIds: r.objectiveIds, advances: r.value.advances, intent: r.value.intent, notSeen: r.value.notSeen, runId: ctx.runId } };
    }
    case "campaign": {
      const end = resolveEnd(r.value.ends ?? null, { objectives: ctx.objectives, work: ctx.work, assertions: ctx.assertions ?? [] });
      if (!end.ok) return { ok: false, stage: "shape", refused: end.reason };
      const period = end.period;
      if (!r.value.what.trim()) return { ok: false, stage: "shape", refused: "campaign without a purpose in the Brain's own words" };
      return { ok: true, dedup: { attachedTo: null }, handoff: { version: EXECUTION_ROUTER_VERSION, shape: "campaign", door: "recommendation", recommendationId: r.id, purpose: r.value.what, objectiveIds: r.objectiveIds, dealIds: r.subject.kind === "deal" ? [r.subject.id] : [], brandIds: [], period, constraints: r.value.notSeen.map((t) => ({ text: t, source: "recommendation" as const })), evidence: r.value.cites.map((c) => ({ ref: c.ref, how: c.how })) } };
    }
  }
  return { ok: false, stage: "shape", refused: `unknown shape ${String(r.value.executionPath)}` };
}
