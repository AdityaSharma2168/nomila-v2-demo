/**
 * research/ledger.ts — the nightly budget ledger (Step 2b design §5.1, review round 2).
 *
 * The authoritative LLM counter lives in ONE row per UTC day (research_budget_days). Every Gemini
 * or Kimi attempt — retries included — calls reserveLlmCall() BEFORE the provider call: a single
 * conditional UPDATE (`llm_attempts < cap … RETURNING`) that Postgres row locking serialises, so
 * under any number of concurrent workflow workers at most `maxLlmCallsPerNight` reservations
 * succeed per day and the last slot goes to exactly one worker. No returned row ⇒ NO provider call.
 * The per-run cap uses the same pattern on research_runs; a per-run refusal rolls the day slot back.
 *
 * Non-LLM lanes (Trends/GDELT = signals, discovery and other APIs = other) are counted separately
 * on the same rows and never touch llm_attempts. nightlyLedger() reads actuals (the day row) plus
 * reservations for queued runs that have not started calling, for planner admission.
 */

import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../../../db";
import { researchBudgetDays, researchRuns, workflowRuns } from "../../../../shared/schema";
import type { ResearchPolicy } from "./policy";
import type { CallLane } from "./registries";

const DAY = 86_400_000;

/** The UTC budget day for a moment, as YYYY-MM-DD. */
export function budgetDay(asOf: Date): string { return asOf.toISOString().slice(0, 10); }
export function budgetDayBounds(asOf: Date): { start: Date; end: Date } {
  const start = new Date(`${budgetDay(asOf)}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + DAY) };
}

class ReservationRefused extends Error { constructor(public readonly where: "day" | "run") { super(`reservation refused (${where})`); } }

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);

/**
 * What the per-run cap (maxCallsPerRun) counts. Absent: the one research_runs row (v2, unchanged). research_refresh v3
 * persists one row per query, so ONE logical run spans several rows (PR E2a): the cap then counts llm_attempts summed
 * over every row of the same workflow run, or — for the calibration loop, which has no workflow run — over the rows of
 * that one invocation. Same limit, same counted attempts (reservations incl. retries and timed-out attempts); only the
 * rows that make up "the run" change.
 */
export type RunCapGroup = { workflowRunId: string } | { runIds: readonly string[] };

/**
 * Atomically reserve ONE LLM attempt for `runId` against the day cap and the per-run cap.
 * Returns false (and makes no change) when either cap is reached. Never call a provider without a true.
 */
export async function reserveLlmCall(runId: string, opts: { policy: ResearchPolicy; asOf?: Date; capGroup?: RunCapGroup }): Promise<boolean> {
  const day = budgetDay(opts.asOf ?? new Date());
  const dayCap = opts.policy.planner.maxLlmCallsPerNight;
  const runCap = opts.policy.planner.maxCallsPerRun;
  const g = opts.capGroup;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO research_budget_days (day) VALUES (${day}::date) ON CONFLICT (day) DO NOTHING`);
      const dayRes = await tx.execute(sql`UPDATE research_budget_days SET llm_attempts = llm_attempts + 1, updated_at = now() WHERE day = ${day}::date AND llm_attempts < ${dayCap} RETURNING llm_attempts`);
      if (!rowsOf(dayRes).length) throw new ReservationRefused("day");
      let runRes: unknown;
      if (!g) runRes = await tx.execute(sql`UPDATE research_runs SET llm_attempts = llm_attempts + 1, calls = calls + 1 WHERE id = ${runId}::uuid AND llm_attempts < ${runCap} RETURNING llm_attempts`);
      else if ("workflowRunId" in g) {
        // Serialise the reservations of one workflow run on its workflow_runs row, then cap the SUM over its research rows.
        await tx.execute(sql`SELECT id FROM workflow_runs WHERE id = ${g.workflowRunId}::uuid FOR UPDATE`);
        runRes = await tx.execute(sql`UPDATE research_runs SET llm_attempts = llm_attempts + 1, calls = calls + 1 WHERE id = ${runId}::uuid
          AND (SELECT COALESCE(sum(r.llm_attempts), 0) FROM research_runs r WHERE r.workflow_run_id = ${g.workflowRunId}::uuid) < ${runCap} RETURNING llm_attempts`);
      } else {
        const ids = [...new Set([runId, ...g.runIds])];
        runRes = await tx.execute(sql`UPDATE research_runs SET llm_attempts = llm_attempts + 1, calls = calls + 1 WHERE id = ${runId}::uuid
          AND (SELECT COALESCE(sum(r.llm_attempts), 0) FROM research_runs r WHERE r.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})) < ${runCap} RETURNING llm_attempts`);
      }
      if (!rowsOf(runRes).length) throw new ReservationRefused("run");   // rolls the day slot back
      return true;
    });
  } catch (err) {
    if (err instanceof ReservationRefused) return false;
    throw err;
  }
}

/**
 * Record ONE non-LLM provider call on its lane (day row + run row). The `other` lane is capped by
 * maxOtherCallsPerNight (false = refused, no call); the signals lane is counted and capped per run
 * count by the planner (maxSignalRunsPerNight), not per call. Never touches llm_attempts.
 */
export async function recordNonLlmCall(runId: string, lane: Exclude<CallLane, "llm">, opts: { policy: ResearchPolicy; asOf?: Date }): Promise<boolean> {
  const day = budgetDay(opts.asOf ?? new Date());
  const col = lane === "signals" ? sql.raw("signal_calls") : sql.raw("other_calls");
  const cap = lane === "other" ? opts.policy.planner.maxOtherCallsPerNight : 2_147_483_647;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO research_budget_days (day) VALUES (${day}::date) ON CONFLICT (day) DO NOTHING`);
      const dayRes = await tx.execute(sql`UPDATE research_budget_days SET ${col} = ${col} + 1, updated_at = now() WHERE day = ${day}::date AND ${col} < ${cap} RETURNING ${col}`);
      if (!rowsOf(dayRes).length) throw new ReservationRefused("day");
      await tx.execute(sql`UPDATE research_runs SET ${col} = ${col} + 1, calls = calls + 1 WHERE id = ${runId}::uuid`);
      return true;
    });
  } catch (err) {
    if (err instanceof ReservationRefused) return false;
    throw err;
  }
}

export interface NightlyLedger {
  day: string;
  /** Actuals from the day row (retries included). */
  llmExecutedToday: number;
  signalsToday: number;
  otherToday: number;
  /** Provisional cost of every run started today (any status). */
  usdExecutedToday: number;
  /** Planner-triggered runs started today (against maxRunsPerNight). */
  runsToday: number;
  signalRunsToday: number;
  /** Reservations for research_refresh v2/v3 workflow runs that are queued/in flight but have NOT opened a run row yet. */
  llmReserved: number;
  usdReserved: number;
  queuedAthleteIds: Set<string>;
  /** Athletes with a planner-triggered run today (maxRunsPerAthletePerDay). */
  athletesRunToday: Set<string>;
}

export async function nightlyLedger(asOf: Date): Promise<NightlyLedger> {
  const day = budgetDay(asOf);
  const { start, end } = budgetDayBounds(asOf);
  const [dayRow] = await db.select().from(researchBudgetDays).where(eq(researchBudgetDays.day, day)).limit(1);
  const runs = await db.select({ athleteId: researchRuns.athlete_id, trigger: researchRuns.trigger, workflowRunId: researchRuns.workflow_run_id, usd: researchRuns.estimated_cost_usd, llm: researchRuns.llm_attempts, sig: researchRuns.signal_calls, domain: researchRuns.domain })
    .from(researchRuns).where(and(gte(researchRuns.started_at, start), lt(researchRuns.started_at, end)));
  // ONE logical run per workflow run: v2 writes one research_runs row per workflow run; research_refresh v3 (PR E2a)
  // writes one per query plus its signals row. Rows are folded per workflow_run_id so a v3 run counts exactly as a v2
  // run does (once against maxRunsPerNight, its summed attempts/calls for the signals-only rule). v2: identical.
  const byWorkflow = new Map<string, { athleteId: string; trigger: string; llm: number; sig: number; domains: Set<string> }>();
  for (const r of runs) {
    if (!r.workflowRunId) continue;
    const g = byWorkflow.get(r.workflowRunId) ?? { athleteId: r.athleteId, trigger: r.trigger, llm: 0, sig: 0, domains: new Set<string>() };
    g.llm += r.llm; g.sig += r.sig; g.domains.add(r.domain);
    byWorkflow.set(r.workflowRunId, g);
  }
  const plannerRuns = [...byWorkflow.values()].filter((g) => ["ttl", "identity_confirmed", "event", "manual"].includes(g.trigger));
  const opened = new Set(runs.map((r) => r.workflowRunId).filter((x): x is string => !!x));
  const queued = await db.select({ id: workflowRuns.id, athleteId: workflowRuns.athlete_id, input: workflowRuns.input })
    .from(workflowRuns).where(and(eq(workflowRuns.process, "research_refresh"), inArray(workflowRuns.definition_version, [2, 3]), inArray(workflowRuns.status, ["running", "waiting"]), isNotNull(workflowRuns.athlete_id)));
  let llmReserved = 0, usdReserved = 0;
  const queuedAthleteIds = new Set<string>();
  for (const q of queued) {
    queuedAthleteIds.add(q.athleteId!);
    if (opened.has(q.id)) continue;                      // its actuals are on the run row already
    const inp = (q.input ?? {}) as { reserveCalls?: number; estUsd?: number };
    llmReserved += Number(inp.reserveCalls ?? 0); usdReserved += Number(inp.estUsd ?? 0);
  }
  return {
    day,
    llmExecutedToday: dayRow?.llm_attempts ?? 0, signalsToday: dayRow?.signal_calls ?? 0, otherToday: dayRow?.other_calls ?? 0,
    usdExecutedToday: runs.reduce((a, r) => a + Number(r.usd ?? 0), 0),
    runsToday: plannerRuns.length,
    // signals-only: no LLM attempt and ≥ 1 signals call (v2: its one `refresh` row; v3: its query rows + `signals` row)
    signalRunsToday: plannerRuns.filter((g) => [...g.domains].every((d) => d === "refresh" || d === "signals") && g.llm === 0 && g.sig > 0).length,
    llmReserved, usdReserved, queuedAthleteIds,
    athletesRunToday: new Set(plannerRuns.map((r) => r.athleteId)),
  };
}
