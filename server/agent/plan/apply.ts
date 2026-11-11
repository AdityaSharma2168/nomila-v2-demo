/**
 * agent/plan/apply.ts — write a validated plan to memory (design "What it writes").
 *
 *   memory_decisions · goal    one per recommended goal: suggested = goal, why = why now, evidence = its facts,
 *                              response pending, kind goal, detail {key, horizon, domain, value, value confidence, next
 *                              decision, game plan, repeats (plan 1.5.0: once, or what brings it a fresh action)}.
 *                              A recommendation still waiting from an earlier run with the same words KEEPS its
 *                              decision (refreshed), so a card the athlete is looking at keeps its id.
 *   memory_decisions · action  one per action: kind action, goal_id (an active goal) or parent_decision_id (a
 *                              recommended goal: held until kept), detail {kind, what, button, due_on, event,
 *                              deliverable, state to_start}. A waiting action for the same goal with the same words is
 *                              refreshed (its state, what was prepared and its approval are kept).
 *   memory_goals               game_plan for active goals, unless the athlete wrote it (game_plan_by = athlete); domain
 *                              for an active goal that has none yet (a domain once set is never relabelled by a run).
 *   expiry                     pending plan decisions this run did not repeat → expired. An action already in the
 *                              approval queue (approval_id set), or already prepared (state made), is never expired by
 *                              a refresh — except a post prepared before Keep (C1) for a recommendation this run does
 *                              not repeat: that recommendation expires, and its held actions with it; and except an
 *                              UNTOUCHED prepared post (its kit never swapped, re-captioned or re-scored by the athlete,
 *                              not in the approval queue) whose goal or recommendation this run gave a post again: the
 *                              new post replaces it in that slot, so Studio does not show both drafts. Expired, never
 *                              deleted: the row and its kit stay as history.
 *   the idea bank (plan 1.3.0) a post action with a source files its idea (agent/ideaBank/bank.ts filePostIdea): a bank
 *                              idea is marked used by it, a missed one adapted to its event, a fresh evergreen one
 *                              written as used; the action's detail.idea names the bank row and the pillar it serves.
 *                              Filing runs after every action is written, so an action that rewords or replaces one
 *                              this run expires may take that action's idea; it is idempotent per action (a retried
 *                              apply finds what it filed). A refreshed action keeps the idea it already rests on. The
 *                              plan's idea moves (skip, adapt) are applied; an expired action hands its idea back to
 *                              the bank (used → new).
 *                              Nothing here runs unless validate.ts gave a source or a move (the idea bank; AGENT_IDEA_BANK retired 2 Nov 2026).
 */
import type { Decision, EvidenceRef } from "../../../shared/agent";
import type { ActionDecisionDetail, GoalDecisionDetail, PlanAction, PlanGoalRef, ValidatedPlan } from "../../../shared/plan";
import { createLogger } from "../../logger";
import { applyIdeaMoves, emptyBankApplied, filePostIdea, handBackIdeas, type BankApplied } from "../ideaBank/bank";
import type { AgentStore } from "../research/store";
import { PLAN_SKILL_ID } from "./config";
import { sameGoal } from "./validate";

export interface ApplyResult {
  recommended: Array<{ key: string; decisionId: string; refreshed: boolean }>;
  actions: Array<{ decisionId: string; refreshed: boolean }>;
  gamePlansWritten: string[];
  expired: string[];
  /** plan 1.3.0: what was used, written, adapted, skipped and handed back in the idea bank. */
  ideas: BankApplied;
}

const logger = createLogger("agent/plan/apply");
const evidenceOf = (ids: string[]): EvidenceRef[] => ids.map((factId) => ({ kind: "fact", factId }));
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** The slot a post fills: its goal, or the recommendation it is held under. */
function slotOf(t: { goalId?: string | null; parentDecisionId?: string | null }): string | null {
  return t.goalId ? `goal:${t.goalId}` : t.parentDecisionId ? `rec:${t.parentDecisionId}` : null;
}

/**
 * A prepared post the athlete has not worked on: a built kit never swapped, re-captioned or re-scored (every such edit
 * moves the kit's updatedAt past builtAt; a caption edit also sets caption.edited). A kit she touched is never replaced.
 */
export function isUntouchedPost(d: Decision): boolean {
  const det = (d.detail ?? {}) as Partial<ActionDecisionDetail>;
  if (det.kind !== "post" || d.response !== "pending" || d.approvalId) return false;
  const kit = det.prepared?.postKit as { builtAt?: string; updatedAt?: string; caption?: { edited?: boolean } } | undefined;
  if (!kit || typeof kit !== "object") return true;
  return !!kit.builtAt && kit.updatedAt === kit.builtAt && !kit.caption?.edited;
}

export async function applyPlan(store: AgentStore, athleteId: string, runId: string, plan: ValidatedPlan): Promise<ApplyResult> {
  const pending = await store.listDecisions(athleteId, { skillId: PLAN_SKILL_ID, kinds: ["goal", "action"], responses: ["pending"] });
  const touched = new Set<string>();
  const result: ApplyResult = { recommended: [], actions: [], gamePlansWritten: [], expired: [], ideas: emptyBankApplied() };

  // Recommended goals.
  const recDecision = new Map<string, string>();
  for (const r of plan.recommendedGoals) {
    const lines = plan.gamePlans.find((p) => p.goalRef.kind === "recommended" && p.goalRef.key === r.key)?.lines ?? [];
    const detail: GoalDecisionDetail = { key: r.key, horizon: r.horizon, domain: r.domain, value: r.value, valueConfidence: r.valueConfidence, nextDecision: r.nextDecision, gamePlan: lines, repeats: r.repeats };
    const same = pending.find((d) => d.kind === "goal" && !touched.has(d.id) && sameGoal(d.suggested, r.goal));
    if (same) {
      await store.updateDecision(athleteId, same.id, { suggested: r.goal, why: r.whyNow, evidence: evidenceOf(r.factIds), detail: detail as unknown as Record<string, unknown>, runId });
      touched.add(same.id);
      recDecision.set(r.key, same.id);
      result.recommended.push({ key: r.key, decisionId: same.id, refreshed: true });
    } else {
      const d = await store.insertDecision(athleteId, { runId, skillId: PLAN_SKILL_ID, kind: "goal", suggested: r.goal, why: r.whyNow, evidence: evidenceOf(r.factIds), detail: detail as unknown as Record<string, unknown> });
      touched.add(d.id);
      recDecision.set(r.key, d.id);
      result.recommended.push({ key: r.key, decisionId: d.id, refreshed: false });
    }
  }

  // Game plans for active goals (never over the athlete's own), and a domain for a goal that has none yet.
  for (const p of plan.gamePlans) {
    if (p.goalRef.kind !== "goal") continue;
    const goal = await store.getGoal(athleteId, p.goalRef.goalId);
    if (!goal || goal.status !== "active") continue;
    if (p.domain && !goal.domain) await store.updateGoal(athleteId, goal.id, { domain: p.domain });
    if (p.keptAthleteText || goal.gamePlanBy === "athlete") continue;
    const text = p.lines.join("\n");
    if (text && text !== goal.gamePlan) {
      await store.updateGoal(athleteId, goal.id, { gamePlan: text, gamePlanBy: "mila" });
      result.gamePlansWritten.push(goal.id);
    }
  }

  // Actions.
  const toFile: Array<{ a: PlanAction; decisionId: string }> = [];
  const target = (ref: PlanGoalRef): { goalId: string | null; parentDecisionId: string | null } =>
    ref.kind === "goal" ? { goalId: ref.goalId, parentDecisionId: null } : { goalId: null, parentDecisionId: recDecision.get(ref.key) ?? null };
  for (const a of plan.actions) {
    const t = target(a.goalRef);
    if (!t.goalId && !t.parentDecisionId) continue;
    const same = pending.find((d: Decision) => d.kind === "action" && !touched.has(d.id)
      && (t.goalId ? d.goalId === t.goalId : d.parentDecisionId === t.parentDecisionId) && norm(d.suggested) === norm(a.what));
    const prior = (same?.detail ?? {}) as Partial<ActionDecisionDetail>;
    // A refreshed action keeps the idea it already rests on (the same post); a new one files its own below.
    const keepIdea = !!prior.idea?.ideaId;
    const detail: ActionDecisionDetail = {
      kind: a.kind, what: a.what, button: a.button, dueOn: a.dueOn, event: a.event, deliverable: a.deliverable,
      state: prior.state ?? "to_start", ...(prior.prepared ? { prepared: prior.prepared } : {}),
      ...(a.post || prior.post ? { post: a.post ?? prior.post } : {}),
      ...(keepIdea ? { idea: prior.idea } : a.source ? { idea: { ideaId: null, pillar: a.source.pillar } } : {}),
    };
    let decisionId: string;
    if (same) {
      // Something already prepared keeps its deliverable: Track E made it from that text.
      const keep = prior.state === "made" && prior.deliverable ? { deliverable: prior.deliverable } : {};
      await store.updateDecision(athleteId, same.id, { why: a.why, evidence: evidenceOf(a.factIds), detail: { ...detail, ...keep } as unknown as Record<string, unknown>, runId });
      touched.add(same.id);
      result.actions.push({ decisionId: same.id, refreshed: true });
      decisionId = same.id;
    } else {
      const d = await store.insertDecision(athleteId, {
        runId, skillId: PLAN_SKILL_ID, kind: "action", suggested: a.what, why: a.why, evidence: evidenceOf(a.factIds),
        detail: detail as unknown as Record<string, unknown>, goalId: t.goalId, parentDecisionId: t.parentDecisionId,
      });
      touched.add(d.id);
      result.actions.push({ decisionId: d.id, refreshed: false });
      decisionId = d.id;
    }
    if (a.source && !keepIdea) toFile.push({ a, decisionId });
  }

  // What this run will expire: the pending decisions it did not repeat (never one in the approval queue, never one
  // already prepared).
  // A post prepared before Keep (C1) for a recommendation this run does not repeat goes with it: nobody kept it.
  // An untouched prepared post whose goal (or recommendation) this run gave a post again is replaced in that slot.
  const expiringGoals = new Set(pending.filter((d) => d.kind === "goal" && !touched.has(d.id)).map((d) => d.id));
  const refilled = new Set(plan.actions.filter((a) => a.kind === "post").map((a) => slotOf(target(a.goalRef))).filter((k): k is string => !!k));
  const expiring = pending.filter((d) => !touched.has(d.id) && !d.approvalId
    && ((d.detail as Partial<ActionDecisionDetail> | undefined)?.state !== "made"
      || (!!d.parentDecisionId && expiringGoals.has(d.parentDecisionId))
      || (isUntouchedPost(d) && refilled.has(slotOf(d) ?? ""))));
  // The idea bank: each new post's idea is filed now that every action has an id — an idea held by an action this run
  // expires may be taken by the action that rewords or replaces it — then the bank row is named on the action
  // (written only while the action is still what was read).
  const reclaimable = new Set(expiring.map((d) => d.id));
  for (const { a, decisionId } of toFile) {
    const ideaId = await filePostIdea(store, athleteId, runId, a, decisionId, result.ideas, reclaimable);
    const fresh = await store.getDecision(athleteId, decisionId);
    if (!fresh) continue;
    const det = fresh.detail as unknown as ActionDecisionDetail;
    const idea = ideaId ? { ideaId, pillar: a.source!.pillar } : null;
    const done = await store.updateDecision(athleteId, decisionId, {
      detail: { ...det, idea } as unknown as Record<string, unknown>, ifUnchanged: { detail: fresh.detail ?? {}, response: fresh.response },
    });
    if (!done) logger.warn({ athleteId, decisionId, ideaId }, "action changed while its idea was filed: the bank row is not named on it");
  }
  await applyIdeaMoves(store, athleteId, runId, plan.ideaMoves ?? [], result.ideas);

  // Expiry: what this run did not repeat. The approval queue is never touched by a refresh.
  const expired: Decision[] = [];
  for (const d of expiring) {
    await store.respondDecision(athleteId, d.id, "expired", "not repeated by a later plan");
    result.expired.push(d.id);
    expired.push(d);
  }
  // An expired post was never made: its idea goes back to the bank.
  await handBackIdeas(store, athleteId, expired, result.ideas);
  return result;
}
