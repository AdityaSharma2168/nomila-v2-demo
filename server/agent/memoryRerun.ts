/**
 * agent/memoryRerun.ts — the re-run rule: when you change a fact in What Nomila knows, re-run only what used it.
 *
 *   understand (the Brief / Scouting report)   only if the Brief cites a changed fact
 *   M.I.A.                                     only if a changed fact was in the last M.I.A. read's input
 *   plan                                       if either of the two re-runs
 *
 * Edits are batched: the first edit starts a memory_changed run (workflow/definitions/memoryChanged.ts) whose first step
 * waits a 30-minute quiet window; every edit inside it joins that run (one active run per athlete), and `decide` reads
 * every edit up to the moment it runs. An edit that lands after `decide` starts a follow-up run when this one is done.
 *
 * Daily caps per athlete: the Brief at most 2 re-runs a day, the M.I.A. at most 1. Past a cap, that part waits for the
 * next day (UTC) instead of being dropped, and the plan waits with it.
 *
 * What runs today: the M.I.A. goes through the existing gated path (requestEvaluation → the mia_evaluation workflow,
 * whose digest check makes unchanged evidence free). Understand and the plan have no stand-alone workflow trigger yet,
 * so their re-run is RECORDED as pending on the run's step output ({ status: "pending", since }) and read back by
 * pendingRerunsFor(); nothing calls a model for them here.
 *
 * Confirming a fact never re-runs anything. Nothing here names an athlete, sport, school or brand.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { memoryBriefs, memoryFactReviews, workflowRuns, workflowSteps } from "../../shared/schema";
import type { FactHistoryAction } from "../../shared/agent";
import type { RerunNotice } from "../../shared/meScouting";

export const MEMORY_CHANGED_PROCESS = "memory_changed" as const;
/** Edits are batched: nothing re-runs until 30 minutes after the first edit of a batch. */
export const QUIET_WINDOW_MS = 30 * 60_000;
/** Per athlete, per UTC day. */
export const RERUN_DAILY_CAPS = { understand: 2, mia: 1 } as const;
/** The history actions that change what Nomila uses (a confirm changes nothing). */
export const RERUN_ACTIONS: readonly FactHistoryAction[] = ["correct", "remove", "restore", "dispute"];

export type RerunPart = "understand" | "mia" | "plan";

export interface RerunDecision {
  understand: boolean;
  mia: boolean;
  plan: boolean;
  /** Changed facts the Brief cites / the M.I.A. read used (the why, kept with the run). */
  cited: string[];
  inMia: string[];
}

/** Pure: what re-runs for a set of changed facts. */
export function decideReruns(i: { changedFactIds: readonly string[]; briefFactIds: readonly string[]; miaInputFactIds: readonly string[] }): RerunDecision {
  const changed = new Set(i.changedFactIds);
  const cited = [...new Set(i.briefFactIds)].filter((id) => changed.has(id));
  const inMia = [...new Set(i.miaInputFactIds)].filter((id) => changed.has(id));
  const understand = cited.length > 0;
  const mia = inMia.length > 0;
  return { understand, mia, plan: understand || mia, cited, inMia };
}

/** Pure: which wanted parts run now and which wait for tomorrow, given what already ran today. */
export function applyCaps(d: Pick<RerunDecision, RerunPart>, usedToday: { understand: number; mia: number }): { now: RerunPart[]; deferred: RerunPart[] } {
  const now: RerunPart[] = []; const deferred: RerunPart[] = [];
  for (const part of ["understand", "mia"] as const) {
    if (!d[part]) continue;
    (usedToday[part] < RERUN_DAILY_CAPS[part] ? now : deferred).push(part);
  }
  // The plan follows what it reads: it waits if either input is waiting.
  if (d.plan) (deferred.length ? deferred : now).push("plan");
  return { now, deferred };
}

/** The start of the next UTC day. */
export function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

// ─── the run's reads ──────────────────────────────────────────────────────────────────────────────────────────────

export interface DecideOutput {
  /** The newest edit this decision covered (ISO); the next run reads edits after it. */
  cutoff: string;
  changedFactIds: string[];
  decision: RerunDecision;
  now: RerunPart[];
  deferred: RerunPart[];
}

export interface ActOutput {
  ran: Partial<Record<RerunPart, { status: "requested"; runId: string } | { status: "pending"; since: string }>>;
}

/** The cutoff of this athlete's last finished decision, or null when none ran yet. */
async function lastCutoff(athleteId: string, exceptRunId: string): Promise<string | null> {
  const rows = await db.select({ output: workflowSteps.output, runId: workflowSteps.run_id }).from(workflowSteps)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowSteps.run_id))
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, MEMORY_CHANGED_PROCESS), eq(workflowSteps.step, "decide"), eq(workflowSteps.status, "done")))
    .orderBy(desc(workflowSteps.finished_at)).limit(5);
  const out = rows.find((r) => r.runId !== exceptRunId)?.output as DecideOutput | undefined;
  return out?.cutoff ?? null;
}

/** The edits that change what Nomila uses: after `after` (exclusive), or from `from` (inclusive) when there is no `after`. */
export async function changesSince(athleteId: string, bound: { after: string | null; from: string }): Promise<{ factIds: string[]; cutoff: string | null }> {
  // The cutoff is compared in SQL at the database's own (microsecond) precision: a JavaScript Date would round it down
  // to the millisecond, and the newest edit would then read as newer than itself.
  const where = and(
    eq(memoryFactReviews.athlete_id, athleteId),
    inArray(memoryFactReviews.action, [...RERUN_ACTIONS]),
    bound.after ? sql`${memoryFactReviews.created_at} > ${bound.after}::timestamptz` : sql`${memoryFactReviews.created_at} >= ${bound.from}::timestamptz`,
  );
  const rows = await db.select({ factId: memoryFactReviews.fact_id, replacement: memoryFactReviews.replacement_fact_id }).from(memoryFactReviews).where(where);
  if (!rows.length) return { factIds: [], cutoff: null };
  const [last] = await db.select({ at: sql<string>`max(${memoryFactReviews.created_at})::text` }).from(memoryFactReviews).where(where);
  const factIds = [...new Set(rows.flatMap((r) => [r.factId, r.replacement]).filter((x): x is string => !!x))];
  return { factIds, cutoff: last?.at ?? null };
}

/** The facts the current Brief cites. */
async function briefFactIds(athleteId: string): Promise<string[]> {
  const [row] = await db.select({ ids: memoryBriefs.fact_ids }).from(memoryBriefs)
    .where(and(eq(memoryBriefs.athlete_id, athleteId), eq(memoryBriefs.status, "current"))).limit(1);
  return Array.isArray(row?.ids) ? (row!.ids as unknown[]).map(String) : [];
}

/** The memory facts the last M.I.A. read used (its public and measured inputs). SELECTs only. */
async function miaInputFactIds(athleteId: string): Promise<string[]> {
  const { readMiaPreview } = await import("../services/miaPreview/preview");
  const p = await readMiaPreview(athleteId);
  return [...p.inputs.public, ...p.inputs.measured].map((i) => i.factId).filter((x): x is string => !!x);
}

/** How many understand / M.I.A. re-runs this athlete's memory_changed runs already made today (UTC). */
export async function rerunsToday(athleteId: string, now: Date): Promise<{ understand: number; mia: number }> {
  const rows = await db.select({ output: workflowSteps.output }).from(workflowSteps)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowSteps.run_id))
    .where(and(
      eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, MEMORY_CHANGED_PROCESS),
      inArray(workflowSteps.step, ["act", "act_deferred"]), eq(workflowSteps.status, "done"), gte(workflowSteps.finished_at, startOfUtcDay(now)),
    ));
  const used = { understand: 0, mia: 0 };
  for (const r of rows) {
    const ran = (r.output as ActOutput | null)?.ran ?? {};
    if (ran.understand) used.understand++;
    if (ran.mia) used.mia++;
  }
  return used;
}

/** The `decide` step: read the batch's edits, decide what re-runs, apply the daily caps. */
export async function decideStep(athleteId: string, runId: string, runInput: { since?: string } | null, now: Date): Promise<DecideOutput> {
  const after = await lastCutoff(athleteId, runId);
  const from = runInput?.since ?? now.toISOString();
  const changes = await changesSince(athleteId, { after, from });
  const [cited, inMia] = await Promise.all([briefFactIds(athleteId), changes.factIds.length ? miaInputFactIds(athleteId) : Promise.resolve([])]);
  const decision = decideReruns({ changedFactIds: changes.factIds, briefFactIds: cited, miaInputFactIds: inMia });
  const { now: runNow, deferred } = applyCaps(decision, await rerunsToday(athleteId, now));
  return { cutoff: changes.cutoff ?? after ?? from, changedFactIds: changes.factIds, decision, now: runNow, deferred };
}

/** The `act` steps: run (M.I.A.) or record as pending (understand, plan) each part. */
export async function actStep(athleteId: string, parts: readonly RerunPart[], now: Date): Promise<ActOutput> {
  const ran: ActOutput["ran"] = {};
  for (const part of parts) {
    if (part === "mia") {
      const { requestEvaluation } = await import("../services/marketabilityBeta1Orchestrator");
      const r = await requestEvaluation({ athleteId, trigger: "USER_REQUESTED_REFRESH", reason: "you changed a fact the M.I.A. used", createdBy: MEMORY_CHANGED_PROCESS });
      ran.mia = { status: "requested", runId: r.runId };
    } else {
      ran[part] = { status: "pending", since: now.toISOString() };
    }
  }
  return { ran };
}

/**
 * The re-runs recorded as pending and not yet picked up: understand and plan, each with the time it was first asked
 * for. The read a future understand / plan trigger starts from; null when nothing is waiting.
 */
export async function pendingRerunsFor(athleteId: string): Promise<{ understand: string | null; plan: string | null }> {
  const rows = await db.select({ output: workflowSteps.output }).from(workflowSteps)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowSteps.run_id))
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, MEMORY_CHANGED_PROCESS), inArray(workflowSteps.step, ["act", "act_deferred"]), eq(workflowSteps.status, "done")))
    .orderBy(workflowSteps.finished_at);
  const out: { understand: string | null; plan: string | null } = { understand: null, plan: null };
  for (const r of rows) {
    const ran = (r.output as ActOutput | null)?.ran ?? {};
    for (const part of ["understand", "plan"] as const) {
      const x = ran[part];
      if (x && x.status === "pending" && !out[part]) out[part] = x.since;
    }
  }
  return out;
}

/**
 * Ask for a re-run after an edit: start the athlete's memory_changed run, or join the one in its quiet window.
 * `since` is the edit's own time (its history row), so the run reads that edit and every later one.
 */
export async function requestMemoryRerun(athleteId: string, since: Date): Promise<RerunNotice> {
  const { startRun } = await import("../workflow/runner");
  const { run } = await startRun({ process: MEMORY_CHANGED_PROCESS, athleteId, input: { since: since.toISOString() }, createdBy: "knows_edit" });
  const [quiet] = await db.select({ readyAt: workflowSteps.ready_at, status: workflowSteps.status }).from(workflowSteps)
    .where(and(eq(workflowSteps.run_id, run.id), eq(workflowSteps.step, "quiet"))).limit(1);
  return { runId: run.id, after: quiet && quiet.status !== "done" ? quiet.readyAt.toISOString() : null };
}
