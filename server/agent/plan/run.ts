/**
 * agent/plan/run.ts — one plan refresh: read → (guards) → one model call → code checks → write.
 *
 *   1. No current Brief → skipped (the plan reads the Brief; Understand's writeBrief starts the first run).
 *   2. The input block (input.ts). Its digest unchanged since the last completed plan this week → reused, no model call.
 *   3. Budget: the athlete's spend today (every run; AGENT_DAY_COST_CAP_USD) and on plan runs in the last 7 days
 *      (AGENT_PLAN_WEEK_CAP_USD, default $1) must leave room for one run's worst case; else skipped and the last plan
 *      stays.
 *   4. runSkill: skill plan, reasoning tier, no tools, PLAN_SCHEMA, max_output_tokens 12,000. A retried workflow step
 *      with the same parent ref reuses the finished run (never pays twice).
 *   5. The idea-bank keys the model was shown and the digest go on the run first (a retry after a partial apply reads
 *      them back instead of rebuilding them); then validatePlan, then applyPlan; the validated plan, what was held and
 *      why, the digest and what was written go on the run's output (agent_runs.output) beside the model's own JSON.
 */
import type { RunTrigger } from "../../../shared/agent";
import type { ValidatedPlan } from "../../../shared/plan";
import { createLogger } from "../../logger";
import { CostCapError, runSkill } from "../research/runSkill";
import { PLAN_SCHEMA } from "../research/schemas";
import { athleteDaySpendMicroUsd, type AgentStore, type StoredRun } from "../research/store";
import { persistBankKeys, restoreBankKeys, type PersistedBankKeys } from "../ideaBank/bank";
import { applyPlan, type ApplyResult } from "./apply";
import { PLAN, PLAN_SKILL_ID } from "./config";
import { buildPlanInput, type PlanSources } from "./input";
import { validatePlan } from "./validate";

const logger = createLogger("agent/plan");

export interface PlanRunRequest {
  store: AgentStore;
  sources: PlanSources;
  athleteId: string;
  trigger: Extract<RunTrigger, "event" | "schedule" | "chat">;
  /** What started it, in a few words (logged and shown to the model). */
  reason?: string | null;
  /** The goal an event is about (add, keep), when there is one. */
  goalId?: string | null;
  /** "workflow:<run id>:plan" — a retried step reuses the finished run. */
  parentRef: string | null;
  now?: Date;
}

export type PlanRunOutcome =
  | { status: "planned"; runId: string; recommended: number; actions: number; held: number; expired: number; costMicroUsd: number }
  | { status: "reused"; runId: string; why: "unchanged_input" | "retried_step" }
  | { status: "skipped"; reason: "no_brief" | "day_cap" | "week_cap" };

/** What a plan run's output holds (agent_runs.output), beside runSkill's own fields. */
export interface PlanRunOutput {
  json?: unknown;
  digest?: string;
  plan?: ValidatedPlan;
  held?: Array<{ what: string; reason: string }>;
  applied?: ApplyResult;
  reason?: string | null;
  /** plan 1.3.0: the idea-bank keys the model was shown (agent/ideaBank/bank.ts persistBankKeys), kept before the write. */
  bankKeys?: PersistedBankKeys;
}

const DAY = 86_400_000;
const sum = (runs: StoredRun[]) => runs.reduce((n, r) => n + (r.cost?.microUsd ?? 0), 0);

/** The latest completed plan run that carries a plan, if any (within `sinceMs`). */
export async function latestPlanRun(store: AgentStore, athleteId: string, now: Date, sinceMs = 30 * DAY): Promise<StoredRun | null> {
  const runs = await store.listRunsSince(athleteId, { since: new Date(now.getTime() - sinceMs).toISOString(), skillId: PLAN_SKILL_ID });
  return [...runs].reverse().find((r) => r.status === "completed" && !!(r.output as PlanRunOutput | null)?.plan) ?? null;
}

export async function runPlan(req: PlanRunRequest): Promise<PlanRunOutcome> {
  const { store, athleteId } = req;
  const now = req.now ?? new Date();

  // A retried step: the finished run is the answer (and is applied if a crash came between the call and the write).
  if (req.parentRef) {
    const done = await store.findCompletedRun(athleteId, req.parentRef);
    const out = (done?.output ?? null) as PlanRunOutput | null;
    if (done && out?.applied) return { status: "reused", runId: done.id, why: "retried_step" };
  }

  if (!(await store.currentBrief(athleteId))) return { status: "skipped", reason: "no_brief" };
  const built = await buildPlanInput(store, req.sources, athleteId, now, { reason: req.reason ?? null, focusGoalId: req.goalId ?? null });

  // Unchanged input (same week): the last plan stands, no model call.
  const last = await latestPlanRun(store, athleteId, now, PLAN.REUSE_MAX_AGE_MS);
  if (last && (last.output as PlanRunOutput).digest === built.digest && !(req.parentRef && last.parentRef === req.parentRef)) {
    logger.info({ athleteId, runId: last.id, trigger: req.trigger }, "plan input unchanged: last plan reused");
    return { status: "reused", runId: last.id, why: "unchanged_input" };
  }

  // Budget: room for one more run's worst case today and this week.
  const today = await athleteDaySpendMicroUsd(store, athleteId, now);
  if (today + PLAN.RUN_RESERVE_MICRO_USD > PLAN.DAY_CAP_MICRO_USD) {
    logger.warn({ athleteId, spentMicroUsd: today }, "plan skipped: the day's cap would be passed");
    return { status: "skipped", reason: "day_cap" };
  }
  const week = sum(await store.listRunsSince(athleteId, { since: new Date(now.getTime() - 7 * DAY).toISOString(), skillId: PLAN_SKILL_ID }));
  if (week + PLAN.RUN_RESERVE_MICRO_USD > PLAN.WEEK_CAP_MICRO_USD) {
    logger.warn({ athleteId, spentMicroUsd: week }, "plan skipped: the week's plan cap would be passed");
    return { status: "skipped", reason: "week_cap" };
  }

  let r;
  try {
    r = await runSkill({
      store, athleteId, skillId: PLAN_SKILL_ID, trigger: req.trigger, parentRef: req.parentRef,
      input: built.input, schemaName: "plan", schema: PLAN_SCHEMA, maxOutputTokens: PLAN.MAX_OUTPUT_TOKENS,
      evidenceRead: built.evidence, budget: { spentMicroUsd: week, capMicroUsd: PLAN.WEEK_CAP_MICRO_USD },
    });
  } catch (err) {
    if (err instanceof CostCapError) return { status: "skipped", reason: "week_cap" };
    throw err;
  }

  // The idea bank's keys (and the digest) the model was shown are kept on the run BEFORE anything is written: a retry
  // after a partial apply resolves the cached answer's refs against them, never against a rebuilt input whose keys moved
  // (the partial apply itself changed the bank).
  const before = ((await store.getRun(athleteId, r.runId))?.output ?? {}) as PlanRunOutput & Record<string, unknown>;
  let check = built.check;
  let digest = built.digest;
  if (before.bankKeys) {
    check = { ...built.check, bank: await restoreBankKeys(store, athleteId, before.bankKeys) };
    digest = before.digest ?? built.digest;
  } else {
    await store.setRunOutput(athleteId, r.runId, { ...before, bankKeys: persistBankKeys(built.check.bank), digest: built.digest });
  }

  const { plan, held } = validatePlan(r.json, check);
  const applied = await applyPlan(store, athleteId, r.runId, plan);
  const prior = ((await store.getRun(athleteId, r.runId))?.output ?? {}) as Record<string, unknown>;
  const output: PlanRunOutput = { ...prior, digest, plan, held, applied, reason: req.reason ?? null };
  await store.setRunOutput(athleteId, r.runId, output);
  logger.info({
    athleteId, runId: r.runId, trigger: req.trigger, recommended: plan.recommendedGoals.length, actions: plan.actions.length,
    held: held.length, expired: applied.expired.length, costUsd: r.cost.microUsd / 1e6,
  }, "plan written");
  return { status: "planned", runId: r.runId, recommended: plan.recommendedGoals.length, actions: plan.actions.length, held: held.length, expired: applied.expired.length, costMicroUsd: r.cost.microUsd };
}
