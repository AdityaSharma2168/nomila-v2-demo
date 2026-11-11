/**
 * agent/research/dbStore.ts — the AgentStore over Postgres: agent_runs and the memory_* tables (0105), plus 0106's
 * columns and tables (run output / parent ref, fact disputes / also-seen / sensitive, brief internal, fact reviews,
 * goals, onboarding checkpoints). Every query filters by athlete_id: tenancy is a property of each statement.
 */
import { and, asc, desc, eq, gte, inArray, like, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  agentOnboardingCheckpoints, agentRuns, memoryBriefs, memoryDecisions, memoryFactReviews, memoryFacts, memoryGoals,
} from "../../../shared/schema";
import { FACT_SOURCE_TYPES, type Decision, type FactStatus, type Goal, type MemoryFact, type RunCost } from "../../../shared/agent";
import { emptyCheckpoints, factExtrasOf, refreshedFields, type AgentStore, type BriefDisplay, type BriefInternal, type StoredBrief, type StoredRun } from "./store";
import { checkFactSource } from "../policy";
import { cleanNewFact } from "../factHygiene";
import { voiceSpendTodayMicroUsd } from "../../voice/voiceMinutes";

const iso = (d: Date | string | null | undefined) => (d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const day = (d: Date | string | null | undefined) => (d == null ? null : String(d instanceof Date ? d.toISOString() : d).slice(0, 10));

type FactRow = typeof memoryFacts.$inferSelect;
export function factFromRow(r: FactRow): MemoryFact {
  return {
    id: r.id, athleteId: r.athlete_id, subject: { kind: r.subject_kind as MemoryFact["subject"]["kind"], name: r.subject_name, ...(r.subject_id ? { id: r.subject_id } : {}) },
    claim: r.claim, type: r.type as MemoryFact["type"],
    source: { ...(r.source_url ? { url: r.source_url } : {}), ...(r.source_ref ? { ref: r.source_ref } : {}), ...(r.source_title ? { title: r.source_title } : {}) },
    date: day(r.observed_on), confidence: Number(r.confidence), status: r.status as FactStatus, supersededBy: r.superseded_by,
    runId: r.run_id, createdAt: iso(r.created_at)!, disputes: r.disputes ?? null, alsoSeenAt: (r.also_seen_at as any) ?? [], sensitive: r.sensitive,
    careKind: (r.care_kind as MemoryFact["careKind"]) ?? null,
    topic: r.topic ?? null, sourceType: (r.source_type as MemoryFact["sourceType"]) ?? null,
    datePrecision: (r.date_precision as MemoryFact["datePrecision"]) ?? null,
    field: (r.field as MemoryFact["field"]) ?? null, fieldValue: r.field_value ?? null,
  };
}

type RunRow = typeof agentRuns.$inferSelect;
function runFromRow(r: RunRow): StoredRun {
  const cost: RunCost = { inputTokens: r.input_tokens, cachedInputTokens: r.cached_input_tokens, outputTokens: r.output_tokens, reasoningTokens: r.reasoning_tokens, webSearchCalls: r.web_search_calls, microUsd: Number(r.cost_micro_usd) };
  return {
    id: r.id, athleteId: r.athlete_id, skillId: r.skill_id, skillVersion: r.skill_version, trigger: r.trigger as StoredRun["trigger"],
    model: { provider: r.provider as any, model: r.model, effort: r.effort as any }, status: r.status as any, stopReason: (r.stop_reason as any) ?? null,
    cost, steps: (r.steps as any) ?? [], evidenceRead: (r.evidence_read as any) ?? [], output: r.output ?? null, parentRef: r.parent_ref ?? null,
    error: r.error ?? null, startedAt: iso(r.started_at)!, endedAt: iso(r.ended_at),
  };
}

type DecisionRow = typeof memoryDecisions.$inferSelect;
function decisionFromRow(r: DecisionRow): Decision {
  return {
    id: r.id, athleteId: r.athlete_id, runId: r.run_id, skillId: r.skill_id, suggested: r.suggested, why: r.why, evidence: (r.evidence as any) ?? [],
    response: r.response as any, responseReason: r.response_reason, respondedAt: iso(r.responded_at), outcome: r.outcome as any,
    outcomeNote: r.outcome_note, outcomeAt: iso(r.outcome_at), approvalId: r.approval_id, createdAt: iso(r.created_at)!, goalId: r.goal_id ?? null,
    kind: (r.kind as Decision["kind"]) ?? "other", detail: (r.detail as Record<string, unknown> | null) ?? {}, parentDecisionId: r.parent_decision_id ?? null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BriefRow = typeof memoryBriefs.$inferSelect;
const briefFromRow = (r: BriefRow): StoredBrief => ({
  id: r.id, athleteId: r.athlete_id, version: r.version, status: r.status as any, summary: r.summary, sections: (r.sections as any) ?? [],
  factIds: (r.fact_ids as any) ?? [], display: (r.display as BriefDisplay | null) ?? null, runId: r.run_id, createdAt: iso(r.created_at)!,
});

const goalFromRow = (r: typeof memoryGoals.$inferSelect): Goal => ({
  id: r.id, athleteId: r.athlete_id, text: r.text, source: r.source as any, status: r.status as any, priority: r.priority ?? null,
  gamePlan: r.game_plan ?? null, decisionId: r.decision_id, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  horizon: (r.horizon as Goal["horizon"]) ?? null, gamePlanBy: (r.game_plan_by as Goal["gamePlanBy"]) ?? "mila",
  domain: (r.domain as Goal["domain"]) ?? null,
});

export const dbStore: AgentStore = {
  async startRun(r) {
    const [row] = await db.insert(agentRuns).values({
      athlete_id: r.athleteId, skill_id: r.skillId, skill_version: r.skillVersion, trigger: r.trigger, provider: r.model.provider,
      model: r.model.model, effort: r.model.effort, status: "running", parent_ref: r.parentRef,
    }).returning({ id: agentRuns.id });
    return row.id;
  },
  async finishRun(athleteId, runId, f) {
    await db.update(agentRuns).set({
      status: f.status, stop_reason: f.stopReason, input_tokens: f.cost.inputTokens, cached_input_tokens: f.cost.cachedInputTokens,
      output_tokens: f.cost.outputTokens, reasoning_tokens: f.cost.reasoningTokens, web_search_calls: f.cost.webSearchCalls,
      cost_micro_usd: f.cost.microUsd, steps: f.steps as any, evidence_read: f.evidenceRead as any, output: f.output as any, error: f.error, ended_at: new Date(),
    }).where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId)));
  },
  async getRun(athleteId, runId) {
    const [r] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId))).limit(1);
    return r ? runFromRow(r) : null;
  },
  async findCompletedRun(athleteId, parentRef) {
    const [r] = await db.select().from(agentRuns)
      .where(and(eq(agentRuns.athlete_id, athleteId), eq(agentRuns.parent_ref, parentRef), eq(agentRuns.status, "completed")))
      .orderBy(desc(agentRuns.started_at)).limit(1);
    return r ? runFromRow(r) : null;
  },
  async costByParentPrefix(athleteId, prefix) {
    const [r] = await db.select({
      i: sql<number>`coalesce(sum(${agentRuns.input_tokens}),0)::int`, c: sql<number>`coalesce(sum(${agentRuns.cached_input_tokens}),0)::int`,
      o: sql<number>`coalesce(sum(${agentRuns.output_tokens}),0)::int`, rz: sql<number>`coalesce(sum(${agentRuns.reasoning_tokens}),0)::int`,
      w: sql<number>`coalesce(sum(${agentRuns.web_search_calls}),0)::int`, m: sql<string>`coalesce(sum(${agentRuns.cost_micro_usd}),0)::text`,
    }).from(agentRuns).where(and(eq(agentRuns.athlete_id, athleteId), like(agentRuns.parent_ref, `${prefix.replace(/[%_\\]/g, "\\$&")}%`)));
    return { inputTokens: Number(r.i), cachedInputTokens: Number(r.c), outputTokens: Number(r.o), reasoningTokens: Number(r.rz), webSearchCalls: Number(r.w), microUsd: Number(r.m) };
  },
  async listRunsByPrefix(athleteId, prefix) {
    const rows = await db.select().from(agentRuns)
      .where(and(eq(agentRuns.athlete_id, athleteId), like(agentRuns.parent_ref, `${prefix.replace(/[%_\\]/g, "\\$&")}%`)))
      .orderBy(asc(agentRuns.started_at));
    return rows.map(runFromRow);
  },
  async setRunOutput(athleteId, runId, output) {
    await db.update(agentRuns).set({ output: output as any }).where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId)));
  },
  async listRunsSince(athleteId, opts) {
    const rows = await db.select().from(agentRuns)
      .where(and(eq(agentRuns.athlete_id, athleteId), gte(agentRuns.started_at, new Date(opts.since)), opts.skillId ? eq(agentRuns.skill_id, opts.skillId) : undefined))
      .orderBy(asc(agentRuns.started_at));
    return rows.map(runFromRow);
  },
  voiceSpendTodayMicroUsd: (athleteId, now) => voiceSpendTodayMicroUsd(athleteId, now),
  async getCheckpoints(athleteId, scope) {
    const state = emptyCheckpoints();
    const rows = await db.select().from(agentOnboardingCheckpoints)
      .where(and(eq(agentOnboardingCheckpoints.athlete_id, athleteId), eq(agentOnboardingCheckpoints.workflow_run_id, scope)));
    for (const r of rows) (state as any)[r.checkpoint] = { status: r.status, offers: r.offers, lastTurn: r.last_turn, detail: (r.detail as any) ?? {} };
    return state;
  },
  async setCheckpoint(athleteId, scope, checkpoint, patch) {
    await db.insert(agentOnboardingCheckpoints).values({
      athlete_id: athleteId, workflow_run_id: scope, checkpoint, status: patch.status ?? "pending", offers: patch.offersInc ?? 0,
      last_turn: patch.lastTurn ?? null, detail: (patch.detail ?? {}) as any,
    }).onConflictDoUpdate({
      target: [agentOnboardingCheckpoints.workflow_run_id, agentOnboardingCheckpoints.checkpoint],
      set: {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.offersInc ? { offers: sql`${agentOnboardingCheckpoints.offers} + ${patch.offersInc}` } : {}),
        ...(patch.lastTurn !== undefined ? { last_turn: patch.lastTurn } : {}),
        ...(patch.detail ? { detail: patch.detail as any } : {}),
        updated_at: new Date(),
      },
      // Tenancy: a scope belongs to one athlete; never update another athlete's row.
      setWhere: eq(agentOnboardingCheckpoints.athlete_id, athleteId),
    });
  },
  async listFacts(athleteId, statuses) {
    const rows = await db.select().from(memoryFacts)
      .where(and(eq(memoryFacts.athlete_id, athleteId), statuses?.length ? inArray(memoryFacts.status, statuses) : undefined))
      .orderBy(asc(memoryFacts.created_at));
    return rows.map(factFromRow);
  },
  async getFacts(athleteId, ids) {
    if (!ids.length) return [];
    const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!valid.length) return [];
    const rows = await db.select().from(memoryFacts).where(and(eq(memoryFacts.athlete_id, athleteId), inArray(memoryFacts.id, valid)));
    return rows.map(factFromRow);
  },
  async insertFacts(athleteId, raw) {
    if (!raw.length) return [];
    // Every writer's facts go through the same formatting rules (agent/factHygiene.ts): inline markdown citations out
    // of the claim, source URLs validated and normalised (a junk URL falls back to an also-seen URL or the ref).
    const list = raw.map(cleanNewFact);
    for (const n of list) {
      const p = checkFactSource(n.source);
      if (p.decision !== "allow") throw new Error(`${p.rule}: ${p.reason}`);
    }
    const rows = await db.insert(memoryFacts).values(list.map((n) => ({
      athlete_id: athleteId, subject_kind: n.subject.kind, subject_name: n.subject.name.slice(0, 300), subject_id: n.subject.id ?? null,
      claim: n.claim, type: n.type, source_url: n.source.url ?? null, source_ref: n.source.ref ?? null, source_title: n.source.title?.slice(0, 300) ?? null,
      observed_on: n.date, confidence: n.confidence, status: n.status ?? "active", run_id: n.runId, disputes: n.disputes ?? null,
      also_seen_at: (n.alsoSeenAt ?? []) as any, sensitive: n.sensitive ?? false,
      care_kind: n.sensitive ? n.careKind ?? null : null,
      topic: n.topic?.trim().slice(0, 60) || null,
      source_type: n.sourceType && (FACT_SOURCE_TYPES as readonly string[]).includes(n.sourceType) ? n.sourceType : null,
      ...((x) => ({ date_precision: x.datePrecision, field: x.field, field_value: x.fieldValue }))(factExtrasOf(n)),
    }))).returning();
    return rows.map(factFromRow);
  },
  async setFactStatus(athleteId, factId, status, links) {
    await db.update(memoryFacts).set({
      status, updated_at: new Date(),
      ...(links?.disputes !== undefined ? { disputes: links.disputes } : {}),
      ...(links?.supersededBy !== undefined ? { superseded_by: links.supersededBy } : {}),
    }).where(and(eq(memoryFacts.id, factId), eq(memoryFacts.athlete_id, athleteId)));
  },
  async refreshFact(athleteId, factId, patch) {
    const [prevRow] = await db.select().from(memoryFacts)
      .where(and(eq(memoryFacts.id, factId), eq(memoryFacts.athlete_id, athleteId), inArray(memoryFacts.status, ["active", "disputed"]))).limit(1);
    if (!prevRow) return null;
    const r = refreshedFields(factFromRow(prevRow), patch);
    const p = checkFactSource(r.source);
    if (p.decision !== "allow") throw new Error(`${p.rule}: ${p.reason}`);
    const [row] = await db.update(memoryFacts).set({
      ...(patch.subjectName?.trim() ? { subject_name: patch.subjectName.trim().slice(0, 300) } : {}),
      claim: r.claim, source_url: r.source.url ?? null, source_ref: r.source.ref ?? null, source_title: r.source.title?.slice(0, 300) ?? null,
      also_seen_at: r.alsoSeenAt as any, observed_on: patch.date, confidence: patch.confidence, run_id: patch.runId, updated_at: new Date(),
      date_precision: patch.date && patch.datePrecision ? patch.datePrecision : null,
      ...(patch.sensitive ? { sensitive: true, care_kind: prevRow.care_kind ?? "personal" } : {}),
      ...(patch.sourceType !== undefined ? { source_type: patch.sourceType && (FACT_SOURCE_TYPES as readonly string[]).includes(patch.sourceType) ? patch.sourceType : null } : {}),
    }).where(and(eq(memoryFacts.id, factId), eq(memoryFacts.athlete_id, athleteId), inArray(memoryFacts.status, ["active", "disputed"]))).returning();
    return row ? factFromRow(row) : null;
  },
  async writeBrief(athleteId, b) {
    return db.transaction(async (tx) => {
      const [last] = await tx.select({ v: sql<number>`coalesce(max(${memoryBriefs.version}),0)::int` }).from(memoryBriefs).where(eq(memoryBriefs.athlete_id, athleteId));
      await tx.update(memoryBriefs).set({ status: "superseded" }).where(and(eq(memoryBriefs.athlete_id, athleteId), eq(memoryBriefs.status, "current")));
      const [row] = await tx.insert(memoryBriefs).values({
        athlete_id: athleteId, version: Number(last?.v ?? 0) + 1, status: "current", summary: b.summary, sections: b.sections as any,
        fact_ids: b.factIds as any, internal: b.internal as any, display: (b.display ?? null) as any, run_id: b.runId,
      }).returning();
      return briefFromRow(row);
    });
  },
  async currentBrief(athleteId) {
    const [r] = await db.select().from(memoryBriefs).where(and(eq(memoryBriefs.athlete_id, athleteId), eq(memoryBriefs.status, "current"))).limit(1);
    return r ? briefFromRow(r) : null;
  },
  async currentBriefInternal(athleteId) {
    const [r] = await db.select({ internal: memoryBriefs.internal }).from(memoryBriefs).where(and(eq(memoryBriefs.athlete_id, athleteId), eq(memoryBriefs.status, "current"))).limit(1);
    return (r?.internal as BriefInternal | null) ?? null;
  },
  async insertDecision(athleteId, d) {
    const answered = d.response && d.response !== "pending";
    const [row] = await db.insert(memoryDecisions).values({
      athlete_id: athleteId, run_id: d.runId, skill_id: d.skillId, suggested: d.suggested, why: d.why || "-", evidence: d.evidence as any,
      kind: d.kind ?? "other", detail: (d.detail ?? {}) as any, parent_decision_id: d.parentDecisionId ?? null,
      ...(d.response ? { response: d.response } : {}), ...(answered ? { responded_at: new Date() } : {}),
      // goal_id only when the goal is the athlete's (checked in the statement below, as linkDecisionToGoal does).
    }).returning();
    if (d.goalId) {
      await dbStore.linkDecisionToGoal(athleteId, row.id, d.goalId);
      return (await dbStore.getDecision(athleteId, row.id))!;
    }
    return decisionFromRow(row);
  },
  async listDecisions(athleteId, filter) {
    const rows = await db.select().from(memoryDecisions).where(and(
      eq(memoryDecisions.athlete_id, athleteId),
      filter.runId ? eq(memoryDecisions.run_id, filter.runId) : undefined,
      filter.skillId ? eq(memoryDecisions.skill_id, filter.skillId) : undefined,
      filter.kinds?.length ? inArray(memoryDecisions.kind, filter.kinds) : undefined,
      filter.responses?.length ? inArray(memoryDecisions.response, filter.responses) : undefined,
      filter.since ? gte(memoryDecisions.created_at, new Date(filter.since)) : undefined,
      filter.goalId ? (UUID_RE.test(filter.goalId) ? eq(memoryDecisions.goal_id, filter.goalId) : sql`false`) : undefined,
      filter.parentDecisionId ? (UUID_RE.test(filter.parentDecisionId) ? eq(memoryDecisions.parent_decision_id, filter.parentDecisionId) : sql`false`) : undefined,
    )).orderBy(asc(memoryDecisions.created_at));
    return rows.map(decisionFromRow);
  },
  async getDecision(athleteId, decisionId) {
    if (!UUID_RE.test(decisionId)) return null;
    const [row] = await db.select().from(memoryDecisions).where(and(eq(memoryDecisions.id, decisionId), eq(memoryDecisions.athlete_id, athleteId))).limit(1);
    return row ? decisionFromRow(row) : null;
  },
  async updateDecision(athleteId, decisionId, p) {
    if (!UUID_RE.test(decisionId)) return null;
    const set: Record<string, unknown> = {};
    if (p.suggested !== undefined) set.suggested = p.suggested;
    if (p.why !== undefined) set.why = p.why || "-";
    if (p.evidence !== undefined) set.evidence = p.evidence;
    if (p.detail !== undefined) set.detail = p.detail;
    if (p.runId !== undefined) set.run_id = p.runId;
    if (p.parentDecisionId !== undefined) set.parent_decision_id = p.parentDecisionId;
    if (p.response !== undefined) { set.response = p.response; set.responded_at = p.response === "pending" ? null : new Date(); }
    if (p.responseReason !== undefined) set.response_reason = p.responseReason;
    // A goal link must point at one of the athlete's goals (the check is in the statement).
    if (p.goalId !== undefined) set.goal_id = p.goalId === null ? null : sql`(SELECT g.id FROM memory_goals g WHERE g.id = ${p.goalId} AND g.athlete_id = ${athleteId})`;
    if (!Object.keys(set).length) return dbStore.getDecision(athleteId, decisionId);
    // A conditional write (DecisionPatch.ifUnchanged): only while the row still holds what the writer read (jsonb
    // equality ignores key order), in the same statement, so nothing can slip in between the check and the write.
    const unchanged = p.ifUnchanged
      ? [sql`${memoryDecisions.detail} = ${JSON.stringify(p.ifUnchanged.detail)}::jsonb`, eq(memoryDecisions.response, p.ifUnchanged.response)]
      : [];
    const [row] = await db.update(memoryDecisions).set(set as any)
      .where(and(eq(memoryDecisions.id, decisionId), eq(memoryDecisions.athlete_id, athleteId), ...unchanged)).returning();
    return row ? decisionFromRow(row) : null;
  },
  async respondDecision(athleteId, decisionId, response, reason) {
    if (!/^[0-9a-f-]{36}$/i.test(decisionId)) return null;
    const [row] = await db.update(memoryDecisions).set({ response, response_reason: reason, responded_at: new Date() })
      .where(and(eq(memoryDecisions.id, decisionId), eq(memoryDecisions.athlete_id, athleteId))).returning();
    return row ? decisionFromRow(row) : null;
  },
  async insertGoal(athleteId, g) {
    const [row] = await db.insert(memoryGoals).values({
      athlete_id: athleteId, text: g.text, source: g.source, decision_id: g.decisionId, priority: g.priority ?? null, game_plan: g.gamePlan ?? null,
      horizon: g.horizon ?? null, game_plan_by: g.gamePlanBy ?? "mila", domain: g.domain ?? null,
    }).returning();
    return goalFromRow(row);
  },
  async listGoals(athleteId, opts) {
    const rows = await db.select().from(memoryGoals).where(and(eq(memoryGoals.athlete_id, athleteId), opts?.includeDropped ? undefined : ne(memoryGoals.status, "dropped")))
      .orderBy(sql`${memoryGoals.priority} ASC NULLS LAST`, asc(memoryGoals.created_at));
    return rows.map(goalFromRow);
  },
  async getGoal(athleteId, goalId) {
    if (!UUID_RE.test(goalId)) return null;
    const [row] = await db.select().from(memoryGoals).where(and(eq(memoryGoals.id, goalId), eq(memoryGoals.athlete_id, athleteId))).limit(1);
    return row ? goalFromRow(row) : null;
  },
  async updateGoal(athleteId, goalId, p) {
    if (!UUID_RE.test(goalId)) return null;
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (p.text !== undefined) set.text = p.text;
    if (p.status !== undefined) set.status = p.status;
    if (p.horizon !== undefined) set.horizon = p.horizon;
    if (p.gamePlan !== undefined) set.game_plan = p.gamePlan;
    if (p.gamePlanBy !== undefined) set.game_plan_by = p.gamePlanBy;
    if (p.priority !== undefined) set.priority = p.priority;
    if (p.domain !== undefined) set.domain = p.domain;
    const [row] = await db.update(memoryGoals).set(set as any).where(and(eq(memoryGoals.id, goalId), eq(memoryGoals.athlete_id, athleteId))).returning();
    return row ? goalFromRow(row) : null;
  },
  async deleteGoal(athleteId, goalId) {
    if (!UUID_RE.test(goalId)) return false;
    const rows = await db.delete(memoryGoals).where(and(eq(memoryGoals.id, goalId), eq(memoryGoals.athlete_id, athleteId))).returning({ id: memoryGoals.id });
    return rows.length > 0;
  },
  async linkDecisionToGoal(athleteId, decisionId, goalId) {
    // Both rows must be the athlete's: the goal check is in the statement.
    await db.update(memoryDecisions).set({ goal_id: goalId }).where(and(
      eq(memoryDecisions.id, decisionId), eq(memoryDecisions.athlete_id, athleteId),
      sql`EXISTS (SELECT 1 FROM memory_goals g WHERE g.id = ${goalId} AND g.athlete_id = ${athleteId})`,
    ));
  },
  async insertReview(athleteId, r) {
    const [row] = await db.insert(memoryFactReviews).values({
      athlete_id: athleteId, fact_id: r.factId, action: r.action, correction: r.correction, replacement_fact_id: r.replacementFactId, note: r.note,
    }).returning({ id: memoryFactReviews.id });
    return row.id;
  },
  async confirmedFactIds(athleteId) {
    // Each fact's latest review (newest first per fact); kept when that review is a confirm.
    const rows = await db.selectDistinctOn([memoryFactReviews.fact_id], { factId: memoryFactReviews.fact_id, action: memoryFactReviews.action })
      .from(memoryFactReviews).where(eq(memoryFactReviews.athlete_id, athleteId))
      .orderBy(memoryFactReviews.fact_id, desc(memoryFactReviews.created_at), desc(memoryFactReviews.id));
    return new Set(rows.filter((r) => r.action === "confirm").map((r) => r.factId));
  },
};
