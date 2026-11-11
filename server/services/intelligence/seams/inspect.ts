/**
 * seams/inspect.ts — the dev/admin INSPECT seam: everything the modern intelligence pipeline holds for ONE athlete, in
 * one read, so an operator can follow resolve → research → M.I.A. without SQL. Behind GET
 * /api/v1/admin/intelligence/athletes/:athleteId (requireAdmin) and read by the cohort runner.
 *
 * READ-ONLY: SELECTs only, no provider, no write (pinned by seams.test.ts, which compares the touched tables before and
 * after). Athlete-general: nothing here knows a sport, school or person.
 *
 *   account         does she have a Nomila account (an active self membership)? A deliberately promoted public athlete
 *                   has none.
 *   identity        Axis 2 as stored (identity_resolution + its provenance detail), read even while the boundary is off
 *                   (the operator sees what is dormant); `boundaryOn` says whether it is in force.
 *   researchStatus  E3's read contract (readResearchStatus), verbatim: both axes, per-domain lifecycle/outcome/status.
 *   researchRuns    the athlete's latest research_refresh workflow runs with a per-step summary (ran / skipped and why /
 *                   completed / budget-refused), so "capped" is visible without opening the steps.
 *   knowledge       canonical facts (athlete_facts, current) by origin and key, and research_evidence by kind.
 *   budget          today's research budget day against the effective caps (headroom for the next run).
 *   mia             the M.I.A. read of record through the my-intelligence/0.1 view (pageState, score, State's readState)
 *                   plus the latest mia_evaluation run (blocked by the identity gate or recorded).
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../../db";
import { athleteFacts, athletes, researchBudgetDays, researchEvidence, researchRuns, workflowRuns, workflowSteps } from "../../../../shared/schema";
import { selfMembershipFor } from "../identity/users";
import { getResearchPolicy, identityResolutionEnabled, researchPlannerExecutionEnabled } from "../research/config";
import { readIdentityState } from "../research/identityResolution";
import { budgetDay } from "../research/ledger";
import { readResearchStatus, type ResearchStatus } from "../research/status";
import { buildMyIntelligence } from "../views/myIntelligence";

export const INTELLIGENCE_INSPECT_CONTRACT = "intelligence-inspect/0.1";

export interface StepSummary { step: string; status: string; attempt: number; skipped: string | null; ran: boolean | null; completed: boolean | null; refused: boolean; researchRunId: string | null; error: string | null }
export interface ResearchRunSummary { workflowRunId: string; version: number; status: string; createdBy: string | null; idempotencyKey: string | null; startedAt: string; finishedAt: string | null; reason: string | null; queries: string[] | null; domains: string[] | null; steps: StepSummary[]; capped: boolean; llmAttempts: number; estimatedCostUsd: number }

export interface MiaRunSummary { runId: string; status: string; startedAt: string; trigger: string | null; force: boolean; createdBy: string | null; blocked: string | null; evaluate: string | null; recorded: boolean | null }

export interface IntelligenceInspection {
  contract: typeof INTELLIGENCE_INSPECT_CONTRACT;
  athleteId: string;
  asOf: string;
  athlete: { fullName: string; sport: string | null; status: string };
  account: { hasSelfMembership: boolean };
  flags: { identityResolutionEnabled: boolean; researchExecutionEnabled: boolean };
  identity: { value: string | null; detail: unknown; boundaryOn: boolean };
  researchStatus: ResearchStatus;
  researchRuns: ResearchRunSummary[];
  knowledge: { currentFacts: number; factsByOrigin: Record<string, number>; factsByKey: Record<string, number>; evidence: number; evidenceByKind: Record<string, number> };
  budget: { day: string; llmAttempts: number; maxLlmCallsPerNight: number; maxCallsPerRun: number; headroom: number; policyVersion: string };
  mia: {
    pageState: string | null; score: number | null; readState: string | null; inProgress: boolean | null; entryId: string | null; evidenceAsOf: string | null;
    /** The latest mia_evaluation runs, newest first (since H2 a resolution also requests a debounced IDENTITY_RESOLVED run). */
    runs: MiaRunSummary[];
    latestRun: MiaRunSummary | null;
    error?: string;
  };
}

const countBy = <T>(rows: T[], key: (r: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) { const k = key(r); out[k] = (out[k] ?? 0) + 1; }
  return out;
};

function summarizeStep(s: { step: string; status: string; attempt: number; output: unknown; error: string | null }): StepSummary {
  const o = (s.output ?? {}) as Record<string, any>;
  return {
    step: s.step, status: s.status, attempt: s.attempt,
    skipped: typeof o.skipped === "string" ? o.skipped : null,
    ran: typeof o.ran === "boolean" ? o.ran : null,
    completed: typeof o.completed === "boolean" ? o.completed : null,
    refused: o.record?.refused === true || o.status === "refused",
    researchRunId: typeof o.researchRunId === "string" ? o.researchRunId : null,
    error: s.error ? String(s.error).slice(0, 200) : typeof o.error === "string" ? o.error.slice(0, 200) : null,
  };
}

/** The latest research_refresh workflow runs of an athlete with their step summaries (latest attempt per step). */
export async function readResearchRuns(athleteId: string, limit = 5): Promise<ResearchRunSummary[]> {
  const runs = await db.select().from(workflowRuns)
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, "research_refresh")))
    .orderBy(desc(workflowRuns.started_at)).limit(limit);
  if (!runs.length) return [];
  const ids = runs.map((r) => r.id);
  const steps = await db.select({ runId: workflowSteps.run_id, step: workflowSteps.step, ordinal: workflowSteps.ordinal, attempt: workflowSteps.attempt, status: workflowSteps.status, output: workflowSteps.output, error: workflowSteps.error })
    .from(workflowSteps).where(inArray(workflowSteps.run_id, ids));
  const rr = await db.select({ wf: researchRuns.workflow_run_id, llm: researchRuns.llm_attempts, usd: researchRuns.estimated_cost_usd }).from(researchRuns).where(inArray(researchRuns.workflow_run_id, ids));
  return runs.map((r) => {
    const latest = new Map<string, (typeof steps)[number]>();
    for (const s of steps.filter((x) => x.runId === r.id)) { const p = latest.get(s.step); if (!p || s.attempt > p.attempt) latest.set(s.step, s); }
    const summaries = [...latest.values()].sort((a, b) => a.ordinal - b.ordinal).map(summarizeStep);
    const input = (r.input ?? {}) as Record<string, any>;
    const mine = rr.filter((x) => x.wf === r.id);
    return {
      workflowRunId: r.id, version: r.definition_version, status: r.status, createdBy: r.created_by, idempotencyKey: r.idempotency_key,
      startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
      reason: typeof input.reason === "string" ? input.reason : null,
      queries: Array.isArray(input.queries) ? input.queries : null, domains: Array.isArray(input.domains) ? input.domains : null,
      steps: summaries, capped: summaries.some((s) => s.refused),
      llmAttempts: mine.reduce((a, x) => a + (x.llm ?? 0), 0),
      estimatedCostUsd: Math.round(mine.reduce((a, x) => a + Number(x.usd ?? 0), 0) * 10_000) / 10_000,
    };
  });
}

/** Today's budget day against the effective caps. Read-only: a missing day row reads as zero (nothing is inserted). */
export async function readBudgetHeadroom(asOf: Date): Promise<IntelligenceInspection["budget"]> {
  const policy = await getResearchPolicy();
  const day = budgetDay(asOf);
  const [row] = await db.select({ llm: researchBudgetDays.llm_attempts }).from(researchBudgetDays).where(eq(researchBudgetDays.day, day)).limit(1);
  const llmAttempts = row?.llm ?? 0;
  return { day, llmAttempts, maxLlmCallsPerNight: policy.planner.maxLlmCallsPerNight, maxCallsPerRun: policy.planner.maxCallsPerRun, headroom: Math.max(0, policy.planner.maxLlmCallsPerNight - llmAttempts), policyVersion: policy.version ?? "defaults" };
}

async function readMia(athleteId: string): Promise<IntelligenceInspection["mia"]> {
  const rows = await db.select({ id: workflowRuns.id, status: workflowRuns.status, startedAt: workflowRuns.started_at, input: workflowRuns.input, createdBy: workflowRuns.created_by }).from(workflowRuns)
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, "mia_evaluation"))).orderBy(desc(workflowRuns.started_at)).limit(5);
  const steps = rows.length ? await db.select({ runId: workflowSteps.run_id, step: workflowSteps.step, attempt: workflowSteps.attempt, output: workflowSteps.output }).from(workflowSteps).where(inArray(workflowSteps.run_id, rows.map((r) => r.id))) : [];
  const runs: MiaRunSummary[] = rows.map((run) => {
    const out = (name: string) => steps.filter((s) => s.runId === run.id && s.step === name).sort((a, b) => b.attempt - a.attempt)[0]?.output as Record<string, any> | undefined;
    const snap = out("snapshot"); const ev = out("evaluate"); const score = out("score");
    const input = (run.input ?? {}) as Record<string, any>;
    return { runId: run.id, status: run.status, startedAt: run.startedAt.toISOString(), trigger: typeof input.trigger === "string" ? input.trigger : null, force: input.force === true, createdBy: run.createdBy,
      blocked: typeof snap?.blocked === "string" ? snap.blocked : null, evaluate: typeof ev?.status === "string" ? ev.status : null, recorded: typeof score?.recorded === "boolean" ? score.recorded : null };
  });
  const latestRun = runs[0] ?? null;
  try {
    const v = await buildMyIntelligence(athleteId);
    return { pageState: v.pageState, score: v.assessment?.score ?? null, readState: v.assessment?.readState ?? null, inProgress: v.inProgress, entryId: v.assessment?.entryId ?? null, evidenceAsOf: v.assessment?.evidenceAsOf ?? null, runs, latestRun };
  } catch (err: any) {
    return { pageState: null, score: null, readState: null, inProgress: null, entryId: null, evidenceAsOf: null, runs, latestRun, error: String(err?.message ?? err).slice(0, 200) };
  }
}

/** One athlete, read-only. null when the athlete does not exist. */
export async function inspectAthleteIntelligence(athleteId: string, opts: { asOf?: Date } = {}): Promise<IntelligenceInspection | null> {
  const asOf = opts.asOf ?? new Date();
  const [a] = await db.select({ id: athletes.id, fullName: athletes.full_name, sport: athletes.sport, status: athletes.status }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!a) return null;
  const [membership, identity, researchStatus, researchRunsList, facts, evidence, budget, mia] = await Promise.all([
    selfMembershipFor(athleteId),
    readIdentityState(athleteId),
    readResearchStatus(athleteId, { asOf }),
    readResearchRuns(athleteId),
    db.select({ key: athleteFacts.fact_key, origin: athleteFacts.origin }).from(athleteFacts).where(and(eq(athleteFacts.athlete_id, athleteId), eq(athleteFacts.status, "current"))),
    db.select({ kind: researchEvidence.kind, n: sql<number>`count(*)::int` }).from(researchEvidence).where(eq(researchEvidence.athlete_id, athleteId)).groupBy(researchEvidence.kind),
    readBudgetHeadroom(asOf),
    readMia(athleteId),
  ]);
  const evidenceByKind = Object.fromEntries(evidence.map((e) => [e.kind, Number(e.n)]));
  return {
    contract: INTELLIGENCE_INSPECT_CONTRACT,
    athleteId, asOf: asOf.toISOString(),
    athlete: { fullName: a.fullName, sport: a.sport ?? null, status: a.status },
    account: { hasSelfMembership: !!membership },
    flags: { identityResolutionEnabled: identityResolutionEnabled(), researchExecutionEnabled: researchPlannerExecutionEnabled() },
    identity: { value: identity?.value ?? null, detail: identity?.detail ?? null, boundaryOn: identityResolutionEnabled() },
    researchStatus,
    researchRuns: researchRunsList,
    knowledge: {
      currentFacts: facts.length, factsByOrigin: countBy(facts, (f) => f.origin), factsByKey: countBy(facts, (f) => f.key),
      evidence: Object.values(evidenceByKind).reduce((x, y) => x + y, 0), evidenceByKind,
    },
    budget,
    mia,
  };
}
