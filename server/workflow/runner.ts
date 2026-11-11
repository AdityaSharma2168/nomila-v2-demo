/**
 * runner.ts — the durable process layer, in Postgres.
 *
 * Ready step rows ARE the queue; the tick is the consumer; SKIP LOCKED is the mutex. There is
 * no worker process, no broker and no framework. A step runs inside the minute tick (or the
 * inline "kick" right after a start/complete, so onboarding never waits for the clock), is
 * traced as one Langfuse unit, and is recorded as one append-only row per attempt.
 *
 *   start(process, athleteId, input)  → run + first step(s) ready → kick
 *   tick()                            → expire leases · claim ≤ N ready · run them concurrently (≤ parallelism) · advance
 *   kick(runId)                       → run this run's ready steps now, bounded
 *   complete(runId, step, fields)     → the one door for await_human (landing page, Mila, voice)
 *   retry / cancel                    → operator controls
 *
 * Guarantees this file keeps (and the tests pin):
 *   • at-least-once execution; a step is never claimed twice for the same attempt
 *   • a run that dies mid-step resumes from that step after its lease expires. A lapsed lease (a crash, a replaced
 *     revision) is NOT an attempt: the row goes back to ready, at most MAX_LEASE_RECLAIMS times, then the run fails
 *     saying so. Only an error the step throws (or its deadline) spends an attempt.
 *   • a running step's lease is extended by a heartbeat, so a healthy long step is never reclaimed; its deadline
 *     (step.deadlineMs, else leaseMs × stepDeadlineLeases) still ends a hung one. Rows claimed in a batch and still
 *     waiting for a worker slot are kept alive too, so queueing never spends crash budget.
 *   • only the lease holder (owner + token, compare-and-set) can finish a row: a runner whose lease was reclaimed has
 *     its result discarded and logged
 *   • on SIGTERM the runner stops claiming, gives in-flight steps a short grace, then releases their leases
 *   • lease times are the database's now(), so instances never compare their own clocks (tests inject a clock).
 *     ready_at is written and compared on the app clock (claim, backoff, schedule steps): Cloud Run clocks are
 *     NTP-synced, so instance skew delays a due row by at most that skew (milliseconds), never indefinitely.
 *
 * WHAT THE COMPARE-AND-SET DOES NOT STOP — read this before writing a step. A runner that lost its lease (a stalled
 * process whose lease lapsed, a step past its deadline, a step still running when SIGTERM released it) is NOT
 * interrupted: JavaScript cannot cancel a promise. That "zombie" keeps running until its run() returns, and only its
 * final write to workflow_steps is refused. Everything it writes elsewhere on the way (snapshots, rows, provider calls,
 * emails, pushes) still happens, possibly at the same time as the re-run that replaced it. So every step must be safe to
 * run twice, concurrently:
 *   – key every side-effecting write by (ctx.runId, ctx.step) — a unique index + ON CONFLICT DO NOTHING, or an upsert —
 *     NOT by ctx.attempt (a reclaim re-runs the SAME attempt; a deadline retry is a new one while the old may live on);
 *   – before an external, non-idempotent effect (send, post, charge), check for the record of an earlier one under that
 *     key and pass it to the provider as its idempotency key where it takes one (services/quickScore/step.ts is the
 *     pattern: a step that already called never calls again);
 *   – put the irreversible effect last, after everything that can throw.
 * Steps that need the human tap (tap-to-send) never send from a step at all.
 *   • a failed step retries with exponential backoff + jitter, then fails the run loudly
 *   • one active run per (athlete, process); a repeat start returns the existing run
 *   • payloads ≤ 8 KB, references only — enforced, not advised
 *   • a run keeps the definition version it started on
 *   • parallel siblings (one ordinal) run at the same time, and the next ordinal opens exactly once
 *
 * Design decisions borrowed from Trigger.dev (Apache-2.0): idempotency keys on start, the
 * retry policy shape (maxAttempts/factor/min/max/randomize), the run/attempt status words.
 * Their run engine itself (Redis + Lua + a container supervisor) is what we chose NOT to run.
 */

import { randomUUID } from "node:crypto";
import { runsBackgroundWork } from "../lib/backgroundHost";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { workflowRuns, workflowSteps, type WorkflowRun, type WorkflowStep } from "../../shared/schema";
import { traceUnit } from "../lib/tracing";
import { isAthleteDeleting } from "../lib/privacy/deletionFence";
import { createLogger } from "../logger";
import { getDefinition } from "./registry";
import type { CompiledStep, CompiledWorkflow, Json, RetryPolicy, StepCtx } from "./types";

const logger = createLogger("workflow/runner");

// ─── Config (env-overridable; tests tighten it) ───────────────────────────────

export interface RunnerConfig {
  payloadCapBytes: number;
  defaultLeaseMs: number;
  tickBatch: number;
  kickBatch: number;
  /** Claimed steps executed at once in one tick or kick pass (parallel siblings overlap instead of queueing). */
  parallelism: number;
  retry: RetryPolicy;
  /** Heartbeat period. Unset: a third of the step's lease (a lease survives two missed beats). Tests shorten it. */
  heartbeatMs?: number;
  /**
   * A step's default hard deadline, in leases: past leaseMs × this the heartbeat stops and the attempt fails as an error.
   * A step whose legitimate runtime can exceed it declares its own deadlineMs (types.ts). Env: WORKFLOW_STEP_DEADLINE_LEASES.
   */
  stepDeadlineLeases: number;
  /** SIGTERM: how long in-flight steps may finish before their leases are released (Cloud Run allows 10 s in all). */
  shutdownGraceMs: number;
}

/** Lapsed leases one attempt may survive (crash, replaced revision); the next lapse fails the run with that reason. */
export const MAX_LEASE_RECLAIMS = 3;
const LEASE_EXPIRED = "lease expired";

const DEFAULTS: RunnerConfig = {
  payloadCapBytes: 8 * 1024,
  defaultLeaseMs:  5 * 60_000,
  tickBatch:       Number(process.env.WORKFLOW_TICK_BATCH ?? 20),
  kickBatch:       5,
  parallelism:     Math.max(1, Number(process.env.WORKFLOW_PARALLELISM ?? 4)),
  // 1 min → 5 min → 25 min (×jitter). Three attempts, then the run fails loudly.
  retry: { maxAttempts: 3, factor: 5, minTimeoutMs: 60_000, maxTimeoutMs: 30 * 60_000, randomize: true },
  // 3: on DEV (Nov 2026) the slowest step observed ran 1.2× its lease (onboarding research, 217 s on a 3 min lease).
  stepDeadlineLeases: positiveOr(process.env.WORKFLOW_STEP_DEADLINE_LEASES, 3),
  shutdownGraceMs: 6_000,
};

function positiveOr(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** The hard cap on one execution of `step` (see RunnerConfig.stepDeadlineLeases). */
export function stepDeadlineMs(step: Pick<CompiledStep, "leaseMs" | "deadlineMs">): number {
  return step.deadlineMs ?? (step.leaseMs ?? config.defaultLeaseMs) * config.stepDeadlineLeases;
}

let config: RunnerConfig = { ...DEFAULTS, retry: { ...DEFAULTS.retry } };
let clock: () => Date = () => new Date();
/** True once a test injected a clock: lease SQL then uses it instead of the database's now(). */
let clockInjected = false;

/** Tests only. Partial override; `retry` merges. */
export function configureRunner(partial: Partial<Omit<RunnerConfig, "retry">> & { retry?: Partial<RetryPolicy> }, now?: () => Date): void {
  config = { ...config, ...partial, retry: { ...config.retry, ...(partial.retry ?? {}) } };
  if (now) { clock = now; clockInjected = true; }
}

/**
 * "Now" for lease SQL. Leases are written by one instance and judged by another, so both read the database clock;
 * an injected test clock replaces it so leases stay testable without sleeping.
 */
function dbNow() {
  return clockInjected ? sql`${clock().toISOString()}::timestamptz` : sql`now()`;
}
const plusMs = (ms: number) => sql`(${dbNow()} + ${Math.round(ms)} * interval '1 millisecond')`;

/** This process, as a lease owner: the Cloud Run revision (when there is one) and a random id per process. */
export const INSTANCE_ID = `${process.env.K_REVISION ?? "local"}:${randomUUID().slice(0, 8)}`;
/**
 * The runner's clock, for definitions that schedule their own work.
 *
 * A `schedule` step that reaches for Date.now() directly opts out of configureRunner's clock, which is the one thing
 * that makes scheduled work testable — and the one thing that would have to change if the runner ever had to reason
 * about skew. One clock per runner, read through here.
 */
export function runnerNow(): Date {
  return clock();
}

export function resetRunnerConfig(): void {
  config = { ...DEFAULTS, retry: { ...DEFAULTS.retry } };
  clock = () => new Date();
  clockInjected = false;
  draining = false;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class WorkflowError extends Error {
  constructor(message: string, public readonly code: string, public readonly status = 400) {
    super(message);
    this.name = "WorkflowError";
  }
}

/** The code of a ResearchCapError (callers match on the literal: some tests mock the runner module). */
export const RESEARCH_CAP_CODE = "daily_research_cap";

/** A new research run refused by the daily research cap (agent/onboarding/dailyCap.ts researchCapRefusal). */
export class ResearchCapError extends WorkflowError {
  constructor(public readonly reason: "daily_cap" | "cap_unreadable", public readonly nextAllowedAt: string) {
    super(reason === "daily_cap" ? "Today's research budget is spent" : "Today's research budget could not be read", RESEARCH_CAP_CODE, 429);
    this.name = "ResearchCapError";
  }
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function assertPayload(value: Json, what: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (bytes > config.payloadCapBytes) {
    throw new WorkflowError(
      `${what} is ${bytes} bytes; the cap is ${config.payloadCapBytes}. Store the document in its own table and pass its id.`,
      "payload_too_large", 413,
    );
  }
}

function retryPolicyFor(step: CompiledStep): RetryPolicy {
  return { ...config.retry, ...(step.retry ?? {}) };
}

/** Delay before attempt n+1, given attempt n just failed. */
export function backoffMs(policy: RetryPolicy, failedAttempt: number, rand: () => number = Math.random): number {
  const base = Math.min(policy.maxTimeoutMs, policy.minTimeoutMs * Math.pow(policy.factor, Math.max(0, failedAttempt - 1)));
  return Math.round(policy.randomize ? base * (0.5 + rand()) : base);
}

async function currentTraceId(): Promise<string | null> {
  try {
    const api = await import("@opentelemetry/api");
    const span = api.trace.getActiveSpan();
    return span?.spanContext().traceId ?? null;
  } catch {
    return null;
  }
}

function isUniqueViolation(err: any): boolean {
  return err?.code === "23505" || /unique|duplicate key/i.test(String(err?.message ?? ""));
}

/**
 * Run `fn` over `items`, at most `limit` at a time; never rejects (each item settles on its own), so one step's
 * failure cannot strand its siblings' bookkeeping.
 */
async function settleAll<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { status: "fulfilled", value: await fn(items[i]) }; }
      catch (reason) { results[i] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

/**
 * Advance is serialised per run within this process. Parallel siblings now finish concurrently, and two of them
 * each seeing "my group is complete" would open the next group twice. Chaining every advance of one run on the
 * previous one keeps "open the next ordinal" exactly-once here, as it was when siblings ran one after another.
 */
const advanceChains = new Map<string, Promise<void>>();
function serialAdvance(runId: string): Promise<void> {
  const prev = advanceChains.get(runId) ?? Promise.resolve();
  const next = prev.then(() => advanceInner(runId));
  const tail = next.catch(() => {});
  advanceChains.set(runId, tail);
  void tail.then(() => { if (advanceChains.get(runId) === tail) advanceChains.delete(runId); });
  return next;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getRun(runId: string): Promise<{ run: WorkflowRun; steps: WorkflowStep[] } | null> {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  if (!run) return null;
  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.run_id, runId))
    .orderBy(asc(workflowSteps.ordinal), asc(workflowSteps.attempt), asc(workflowSteps.created_at));
  return { run, steps };
}

export interface ListRunsFilter { process?: string; status?: string; athleteId?: string; limit?: number }

export async function listRuns(f: ListRunsFilter = {}): Promise<WorkflowRun[]> {
  const conds = [];
  if (f.process)   conds.push(eq(workflowRuns.process, f.process));
  if (f.status)    conds.push(eq(workflowRuns.status, f.status));
  if (f.athleteId) conds.push(eq(workflowRuns.athlete_id, f.athleteId));
  const q = db.select().from(workflowRuns);
  const rows = conds.length ? await q.where(and(...conds)).orderBy(desc(workflowRuns.started_at)).limit(f.limit ?? 100)
                            : await q.orderBy(desc(workflowRuns.started_at)).limit(f.limit ?? 100);
  return rows;
}

/**
 * The athlete's active run for a process (optionally one scope of it), with the step currently
 * waiting on them (if any). Without a scope, any active run of the process is returned.
 */
export async function activeRunFor(athleteId: string, process: string, scope?: string): Promise<{ run: WorkflowRun; waiting: WorkflowStep | null } | null> {
  const conds = [eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, process), inArray(workflowRuns.status, ["running", "waiting"])];
  if (scope) conds.push(eq(workflowRuns.active_scope, scope));
  const [run] = await db.select().from(workflowRuns).where(and(...conds)).orderBy(desc(workflowRuns.started_at)).limit(1);
  if (!run) return null;
  const [waiting] = await db.select().from(workflowSteps)
    .where(and(eq(workflowSteps.run_id, run.id), eq(workflowSteps.status, "waiting"))).limit(1);
  return { run, waiting: waiting ?? null };
}

async function outputsFor(runId: string): Promise<Record<string, Json>> {
  const done = await db.select({ step: workflowSteps.step, output: workflowSteps.output, finished_at: workflowSteps.finished_at })
    .from(workflowSteps)
    .where(and(eq(workflowSteps.run_id, runId), eq(workflowSteps.status, "done")))
    .orderBy(asc(workflowSteps.finished_at));
  const out: Record<string, Json> = {};
  for (const d of done) out[d.step] = d.output;
  return out;
}

async function buildCtx(run: WorkflowRun, step: CompiledStep, row: Pick<WorkflowStep, "attempt" | "input">): Promise<StepCtx> {
  return {
    runId: run.id, athleteId: run.athlete_id, process: run.process, definitionVersion: run.definition_version,
    step: step.name, attempt: row.attempt, input: row.input, outputs: await outputsFor(run.id), runInput: run.input,
  };
}

// ─── Creating step rows for an ordinal group ──────────────────────────────────

/**
 * Materialise the rows for one ordinal. await_human rows are born `waiting` with their
 * rendered payload; schedule rows are `ready` with a future ready_at; everything else `ready`.
 * Returns whether the run should now be `waiting`.
 */
async function openGroup(run: WorkflowRun, def: CompiledWorkflow, ordinal: number, holdUntil?: Date): Promise<boolean> {
  const group = def.groups[ordinal];
  let anyWaiting = false;
  for (const step of group) {
    const base = { run_id: run.id, step: step.name, ordinal, attempt: 1, kind: step.kind, input: {} as Json };
    if (step.kind === "await_human") {
      const ctx = await buildCtx(run, step, { attempt: 1, input: {} });
      const payload = await step.payload!(ctx);
      assertPayload(payload, `Payload of step "${step.name}"`);
      await db.insert(workflowSteps).values({ ...base, status: "waiting", input: payload as any });
      anyWaiting = true;
    } else if (step.kind === "schedule") {
      const ctx = await buildCtx(run, step, { attempt: 1, input: {} });
      const at = await step.readyAt!(ctx);
      await db.insert(workflowSteps).values({ ...base, status: "ready", ready_at: at });
    } else {
      await db.insert(workflowSteps).values({ ...base, status: "ready", ready_at: holdUntil ?? clock() });
    }
  }
  await db.update(workflowRuns).set({
    current_step: group.map((s) => s.name).join("+"),
    status: anyWaiting ? "waiting" : "running",
  }).where(eq(workflowRuns.id, run.id));
  return anyWaiting;
}

/** After a step finished: if its ordinal is complete, open the next one or finish the run. */
function advance(runId: string): Promise<void> {
  return serialAdvance(runId);
}

async function advanceInner(runId: string): Promise<void> {
  const found = await getRun(runId);
  if (!found) return;
  const { run, steps } = found;
  if (run.status === "canceled" || run.status === "failed" || run.status === "done") return;
  const def = getDefinition(run.process, run.definition_version);

  // Highest ordinal that has rows is the current one.
  const current = Math.max(...steps.map((s) => s.ordinal));
  const group = def.groups[current];
  const doneNames = new Set(steps.filter((s) => s.ordinal === current && s.status === "done").map((s) => s.step));
  if (group.some((s) => !doneNames.has(s.name))) return; // siblings still running or waiting

  if (current + 1 >= def.groups.length) {
    const finished = await db.update(workflowRuns).set({ status: "done", finished_at: clock(), current_step: null })
      .where(and(eq(workflowRuns.id, run.id), ne(workflowRuns.status, "done"))).returning({ id: workflowRuns.id });
    logger.info({ runId, process: run.process }, "Workflow run done");
    if (def.onDone && finished.length) {   // exactly once: only the caller that moved the run to done
      // After the status write, so the run no longer holds its active scope. Never fails the finished run.
      const outputs: Record<string, any> = {};
      for (const s of [...steps].sort((a, b) => a.attempt - b.attempt)) if (s.status === "done") outputs[s.step] = s.output;
      try { await def.onDone({ runId, athleteId: run.athlete_id, input: run.input as any, outputs }); }
      catch (err: any) { logger.error({ runId, process: run.process, error: err?.message }, "onDone hook failed; the run stays done"); }
    }
    return;
  }
  await openGroup(run, def, current + 1);
}

// ─── Start ────────────────────────────────────────────────────────────────────

export interface StartInput {
  process: string;
  athleteId: string | null;
  input?: Json;
  createdBy?: string;
  idempotencyKey?: string;
  /** Default true. Tests and batch callers may defer to the tick. */
  kick?: boolean;
  /** Pin a definition version. Default: the latest registered. Tests use it to exercise an older version. */
  version?: number;
  /**
   * Start the run HELD: its first steps are born `ready` with this ready_at (HELD_READY_AT: never, until something sets
   * ready_at to now), so no tick claims them and the start does not kick. The run exists (one active run per athlete
   * holds, its input is recorded) but does no work until released. Used by the daily research cap
   * (agent/onboarding/dailyCap.ts) to queue a sign-up's research.
   */
  holdUntil?: Date;
}

/** A ready_at no clock reaches: a step born with it waits until a caller moves its ready_at to now. */
export const HELD_READY_AT = new Date("9999-01-01T00:00:00Z");

/**
 * Insert the run and open ordinal 0. If an active run already exists for (athlete, process),
 * or a run with the same idempotency key, return it with `created: false` — never a second run.
 */
export async function startRun(opts: StartInput): Promise<{ run: WorkflowRun; created: boolean }> {
  const def = getDefinition(opts.process, opts.version);
  const input = opts.input ?? {};
  assertPayload(input, "Run input");
  // Account deletion phase 1 fenced this athlete: no new work starts for them (lib/privacy/deletionFence.ts).
  if (opts.athleteId && await isAthleteDeleting(opts.athleteId)) {
    throw new WorkflowError("The athlete's account is being deleted", "athlete_deleting", 409);
  }
  // The daily research cap is a hard stop (dailyCap.ts researchCapRefusal): a new research run that is not created held
  // is refused while today's budget is spent or unreadable. A held run (sign-up research) is admitted under the cap's
  // lock and released by the minute tick instead. An existing run with this key is still returned (nothing new starts).
  if (!opts.holdUntil) {
    const { CAPPED_RESEARCH_PROCESSES, researchCapRefusal } = await import("../agent/onboarding/dailyCap");
    const refusal = CAPPED_RESEARCH_PROCESSES.has(opts.process) ? await researchCapRefusal(clock()) : null;
    if (refusal) {
      const [existing] = opts.idempotencyKey
        ? await db.select().from(workflowRuns).where(and(eq(workflowRuns.process, opts.process), eq(workflowRuns.idempotency_key, opts.idempotencyKey))).limit(1)
        : [];
      if (existing) return { run: existing, created: false };
      throw new ResearchCapError(refusal.reason, refusal.nextAllowedAt);
    }
  }

  // "One active run per athlete" is scoped by the definition: the process name by default, or
  // a finer key it derives from the input (first_look uses the platform, so an athlete can
  // have an Instagram and a TikTok first look in flight at once, but never two of the same).
  const activeScope = def.activeScope ? def.activeScope(input) : opts.process;

  let run: WorkflowRun;
  try {
    [run] = await db.insert(workflowRuns).values({
      athlete_id: opts.athleteId, process: opts.process, definition_version: def.version, active_scope: activeScope,
      status: "running", input: input as any, created_by: opts.createdBy ?? null,
      idempotency_key: opts.idempotencyKey ?? null, started_at: clock(),
    }).returning();
  } catch (err: any) {
    if (!isUniqueViolation(err)) throw err;
    const existing = opts.idempotencyKey
      ? (await db.select().from(workflowRuns)
          .where(and(eq(workflowRuns.process, opts.process), eq(workflowRuns.idempotency_key, opts.idempotencyKey))).limit(1))[0]
      : null;
    const active = existing ?? (opts.athleteId ? (await activeRunFor(opts.athleteId, opts.process, activeScope))?.run : undefined);
    if (!active) throw err;
    return { run: active, created: false };
  }

  await openGroup(run, def, 0, opts.holdUntil);
  if (opts.kick !== false && !opts.holdUntil) await kick(run.id);
  const [fresh] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)).limit(1);
  return { run: fresh, created: true };
}

// ─── Claim + execute ──────────────────────────────────────────────────────────

/** Steps this process is running now, by row id: what SIGTERM waits for, and then releases. */
const inFlight = new Map<string, { token: string; settled: Promise<void>; stopHeartbeat: () => void }>();
/**
 * Rows this process claimed in a batch that are still waiting for a worker slot (tick claims up to tickBatch, runs at
 * most `parallelism` at once). Not started, so not in `inFlight`: kept alive by runClaimed, released first at SIGTERM.
 */
const queued = new Map<string, WorkflowStep>();
/** Set by SIGTERM (drainRunner): this process claims nothing new. */
let draining = false;

/**
 * Run a claimed batch, at most `parallelism` at once. While a row waits for its slot its claim-time lease is renewed
 * (it has no heartbeat of its own yet): otherwise a batch queued behind long steps would lapse, and another instance
 * would reclaim healthy rows, spending their crash budget and running them out of order.
 */
async function runClaimed<R>(rows: WorkflowStep[], fn: (row: WorkflowStep) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  for (const r of rows) queued.set(r.id, r);
  let busy = false;
  const timer = setInterval(() => {
    const waiting = rows.filter((r) => queued.has(r.id));
    if (busy || !waiting.length) return;
    busy = true;
    Promise.all(waiting.map((r) => renewLease(r, config.defaultLeaseMs).catch(() => false)))
      .finally(() => { busy = false; });
  }, Math.max(1, Math.round(config.heartbeatMs ?? config.defaultLeaseMs / 3)));
  timer.unref?.();
  try {
    return await settleAll(rows, config.parallelism, (row) => { queued.delete(row.id); return fn(row); });
  } finally {
    clearInterval(timer);
    for (const r of rows) queued.delete(r.id);
  }
}

/**
 * Atomically move up to `limit` due `ready` rows to `running` with a lease. SKIP LOCKED means
 * three instances ticking at once never claim the same row. Optionally scoped to one run.
 * Each claim gets this process as its owner and a fresh token; only that pair can finish the row.
 * `ready_at` is compared with the runner clock that wrote it; the lease is written in database time.
 */
async function claim(limit: number, runId?: string): Promise<WorkflowStep[]> {
  if (draining) return [];
  const now = clock();
  const scope = runId ? sql` AND run_id = ${runId}` : sql``;
  const res: any = await db.execute(sql`
    UPDATE workflow_steps
       SET status = 'running', started_at = ${now}, lease_until = ${plusMs(config.defaultLeaseMs)},
           lease_owner = ${INSTANCE_ID}, lease_token = gen_random_uuid()
    WHERE id IN (
      SELECT id FROM workflow_steps
      WHERE status = 'ready' AND ready_at <= ${now}${scope}
      ORDER BY ready_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`);
  const ids: string[] = (res.rows ?? res).map((r: any) => r.id);
  if (!ids.length) return [];
  // In claim order (oldest due first), so a batch run at `parallelism` at a time starts the longest-waiting rows first.
  return db.select().from(workflowSteps).where(inArray(workflowSteps.id, ids)).orderBy(asc(workflowSteps.ready_at), asc(workflowSteps.created_at));
}

/** The compare-and-set every write by the claiming runner goes through: the row is still running under OUR claim. */
function heldBy(row: WorkflowStep) {
  return and(
    eq(workflowSteps.id, row.id), eq(workflowSteps.status, "running"),
    eq(workflowSteps.lease_owner, row.lease_owner ?? ""), eq(workflowSteps.lease_token, row.lease_token ?? "00000000-0000-0000-0000-000000000000"),
  );
}

function logLost(row: WorkflowStep, what: string): void {
  logger.warn({ runId: row.run_id, step: row.step, attempt: row.attempt, owner: INSTANCE_ID },
    `Workflow step lost its lease before it finished; its ${what} is discarded (the runner that reclaimed it owns the step now)`);
}

/** Extend our lease to now + leaseMs. False when the lease is no longer ours (reclaimed, released or finished). */
async function renewLease(row: WorkflowStep, leaseMs: number): Promise<boolean> {
  const res = await db.update(workflowSteps).set({ lease_until: sql`${plusMs(leaseMs)}` as any })
    .where(heldBy(row)).returning({ id: workflowSteps.id });
  return res.length > 0;
}

/**
 * Keep a running step's lease alive: every third of the lease (two missed beats still leave it held). Stops on
 * completion, error, abort, or the first beat that finds the lease gone. A beat that errors (a database blip) is logged
 * and the next one tries again. Beats never overlap.
 */
function startHeartbeat(row: WorkflowStep, leaseMs: number): () => void {
  const every = Math.max(1, Math.round(config.heartbeatMs ?? leaseMs / 3));
  let stopped = false, busy = false;
  const timer = setInterval(() => {
    if (stopped || busy) return;
    busy = true;
    renewLease(row, leaseMs)
      .then((held) => {
        if (!held && !stopped) { stop(); logLost(row, "next heartbeat"); }
      })
      .catch((err: any) => logger.warn({ runId: row.run_id, step: row.step, error: String(err?.message ?? err).slice(0, 200) }, "Workflow lease heartbeat failed; the next beat retries"))
      .finally(() => { busy = false; });
  }, every);
  timer.unref?.();
  const stop = () => { stopped = true; clearInterval(timer); };
  return stop;
}

/** The step's own promise, or an error once its deadline passes (the heartbeat would otherwise hold a hung step forever). */
function withDeadline<T>(work: Promise<T>, ms: number, step: Pick<CompiledStep, "name" | "deadlineMs">): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const why = step.deadlineMs !== undefined ? "its declared deadlineMs" : `its deadline is ${config.stepDeadlineLeases} × its lease`;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `step "${step.name}" did not finish within ${ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`} (${why})`,
    )), ms);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Fail the run (an active run only: a canceled or finished one keeps its status). */
async function failRun(run: WorkflowRun, stepName: string, error: string, attempts: number): Promise<void> {
  await db.update(workflowRuns).set({ status: "failed", last_error: `${stepName}: ${error}`.slice(0, 2000), current_step: stepName, finished_at: clock() })
    .where(and(eq(workflowRuns.id, run.id), inArray(workflowRuns.status, ["running", "waiting"])));
  logger.error({ runId: run.id, process: run.process, step: stepName, attempts, error }, "Workflow run FAILED");
}

/**
 * An error the step threw (or its deadline): one attempt spent. Retries with backoff, or fails the run. A no-op that
 * returns false when we no longer hold the lease: the runner that reclaimed the row decides its fate.
 */
async function failStep(row: WorkflowStep, run: WorkflowRun, step: CompiledStep, error: string): Promise<boolean> {
  const now = clock();
  const policy = retryPolicyFor(step);
  const retry = row.attempt < policy.maxAttempts;
  const delay = retry ? backoffMs(policy, row.attempt) : 0;
  // One transaction: the failed row and its next attempt land together, so a crash between them cannot strand the run.
  const won = await db.transaction(async (tx) => {
    const res = await tx.update(workflowSteps).set({ status: "failed", error: error.slice(0, 2000), finished_at: now })
      .where(heldBy(row)).returning({ id: workflowSteps.id });
    if (!res.length) return false;
    if (retry) {
      await tx.insert(workflowSteps).values({
        run_id: run.id, step: step.name, ordinal: row.ordinal, attempt: row.attempt + 1, kind: step.kind,
        status: "ready", ready_at: new Date(now.getTime() + delay), input: row.input as any,
      });
    }
    return true;
  });
  if (!won) { logLost(row, "error"); return false; }
  if (retry) {
    logger.warn({ runId: run.id, step: step.name, attempt: row.attempt, delayMs: delay, error }, "Workflow step failed — retry scheduled");
    return true;
  }
  await failRun(run, step.name, error, row.attempt);
  return true;
}

/**
 * Hold a claimed step instead of failing it: back to `ready` at HELD_READY_AT, the SAME attempt (a refusal is not the
 * step's error, so it spends none), the lease cleared, the reason noted. The run stays running and is queued like a run
 * created held; the sign-up research release (agent/onboarding/dailyCap.ts) moves its ready_at to now when there is
 * room. Compare-and-set on our lease: false when the row is no longer ours.
 */
async function holdStep(row: WorkflowStep, run: WorkflowRun, reason: string): Promise<boolean> {
  const res = await db.update(workflowSteps).set({
    status: "ready", ready_at: HELD_READY_AT, lease_until: null, lease_owner: null, lease_token: null,
    error: `held, not an attempt: ${reason}`.slice(0, 2000),
  }).where(heldBy(row)).returning({ id: workflowSteps.id });
  if (!res.length) { logLost(row, "hold"); return false; }
  logger.warn({ runId: run.id, process: run.process, step: row.step, attempt: row.attempt }, "Workflow step HELD by the platform day cap (queued, not failed)");
  return true;
}

async function execute(row: WorkflowStep): Promise<"done" | "failed" | "lost"> {
  // Claimed in the same moment SIGTERM arrived: hand it straight back rather than start work this process will not finish.
  if (draining) { await releaseRows([[row.id, row.lease_token ?? ""]]); return "lost"; }
  let settle!: () => void;
  const entry = { token: row.lease_token ?? "", settled: new Promise<void>((r) => { settle = r; }), stopHeartbeat: () => {} };
  inFlight.set(row.id, entry);
  try {
    return await executeHeld(row, entry);
  } finally {
    entry.stopHeartbeat();
    inFlight.delete(row.id);
    settle();
  }
}

async function executeHeld(row: WorkflowStep, entry: { stopHeartbeat: () => void }): Promise<"done" | "failed" | "lost"> {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, row.run_id)).limit(1);
  if (!run) return "failed";
  const def = getDefinition(run.process, run.definition_version);
  const step = def.steps.find((s) => s.name === row.step);
  if (!step) {
    const won = await failStep(row, run, { name: row.step, kind: "code", ordinal: row.ordinal }, `step "${row.step}" not in definition v${run.definition_version}`);
    return won ? "failed" : "lost";
  }
  // Per-step lease, now that we know the definition, counted from the moment the step starts.
  const leaseMs = step.leaseMs ?? config.defaultLeaseMs;
  if (!(await renewLease(row, leaseMs))) { logLost(row, "run"); return "lost"; }
  if (run.status === "canceled") {
    await db.update(workflowSteps).set({ status: "skipped", finished_at: clock() }).where(heldBy(row));
    return "failed";
  }
  // The checkpoint for account deletion: a claimed step of an athlete whose account is being deleted does not run, and
  // the run is canceled (phase 1 cancels the runs it can see; this catches a step claimed in the same moment).
  if (run.athlete_id && await isAthleteDeleting(run.athlete_id)) {
    await db.update(workflowSteps).set({ status: "skipped", finished_at: clock() }).where(heldBy(row));
    await db.update(workflowSteps).set({ status: "skipped", finished_at: clock() })
      .where(and(eq(workflowSteps.run_id, run.id), inArray(workflowSteps.status, ["ready", "waiting"])));
    await db.update(workflowRuns).set({ status: "canceled", finished_at: clock(), last_error: "account deletion" }).where(eq(workflowRuns.id, run.id));
    return "failed";
  }

  const ctx = await buildCtx(run, step, row);
  let output: Json;
  let traceId: string | null = null;
  entry.stopHeartbeat = startHeartbeat(row, leaseMs);
  try {
    output = await withDeadline(traceUnit(
      `workflow.${run.process}.${step.name}`,
      { runId: run.id, athleteId: run.athlete_id, attempt: row.attempt, kind: step.kind },
      async () => {
        traceId = await currentTraceId();
        if (step.kind === "schedule") return { ready_at: row.ready_at };
        return step.run!(ctx);
      },
    ), stepDeadlineMs(step), step);
    entry.stopHeartbeat();
    assertPayload(output ?? null, `Output of step "${step.name}"`);
  } catch (err: any) {
    entry.stopHeartbeat();
    // Sign-up research refused by the platform day cap QUEUES, never fails (agent/onboarding/dailyCap.ts
    // holdsOnPlatformCap; research and score steps only): the step is held, and the minute tick's release starts it again once both caps have room.
    const { holdsOnPlatformCap } = await import("../agent/onboarding/dailyCap");
    if (holdsOnPlatformCap(err, run, step.name)) return (await holdStep(row, run, err?.message ?? String(err))) ? "failed" : "lost";
    return (await failStep(row, run, step, err?.message ?? String(err))) ? "failed" : "lost";
  }
  // Compare-and-set: only the holder of this claim marks it done. A runner whose lease lapsed and was reclaimed
  // discards its result here; the step is the reclaiming runner's now (steps are idempotent, so nothing is lost).
  const won = await db.update(workflowSteps)
    .set({ status: "done", output: (output ?? null) as any, finished_at: clock(), trace_id: traceId, error: null })
    .where(heldBy(row)).returning({ id: workflowSteps.id });
  if (!won.length) { logLost(row, "result"); return "lost"; }
  await advance(run.id);
  return "done";
}

// ─── Leases ───────────────────────────────────────────────────────────────────

/**
 * A `running` row past its lease died with its process (a crash, or a revision replaced past its grace). That is not
 * the step's error, so it spends no attempt: the row goes back to `ready` (same attempt, no backoff) and is claimed
 * again. Each attempt survives at most MAX_LEASE_RECLAIMS lapses; the next one fails the run saying so, so a step that
 * takes its process down every time cannot loop forever. Both writes are single conditional UPDATEs: two runners
 * expiring at once, or an expiry racing the holder's own completion, serialise on the row and exactly one wins.
 */
export async function expireLeases(): Promise<number> {
  const reclaimed: any = await db.execute(sql`
    UPDATE workflow_steps
       SET status = 'ready', ready_at = ${clock()}, lease_until = NULL, lease_owner = NULL, lease_token = NULL,
           lease_reclaims = lease_reclaims + 1,
           error = format('${sql.raw(LEASE_EXPIRED)} (reclaim %s of %s); not an attempt', lease_reclaims + 1, ${sql.raw(String(MAX_LEASE_RECLAIMS))})
     WHERE status = 'running' AND lease_until < ${dbNow()} AND lease_reclaims < ${MAX_LEASE_RECLAIMS}
     RETURNING id, run_id, step, attempt, lease_reclaims`);
  const back = (reclaimed.rows ?? reclaimed) as Array<{ run_id: string; step: string; attempt: number; lease_reclaims: number }>;
  for (const r of back) {
    logger.warn({ runId: r.run_id, step: r.step, attempt: r.attempt, reclaims: r.lease_reclaims, max: MAX_LEASE_RECLAIMS },
      "Workflow step lease expired — the step is ready again (not counted as an attempt)");
  }

  const reason = `${LEASE_EXPIRED} ${MAX_LEASE_RECLAIMS + 1} times: the process running this step stopped before finishing each time (a crash or a replaced revision); the crash-recovery budget (${MAX_LEASE_RECLAIMS} reclaims) is spent`;
  // The step and its run fail in ONE statement (a crash between two would leave a failed step under a running run).
  const finishedAt = clock();
  const spent: any = await db.execute(sql`
    WITH dead AS (
      UPDATE workflow_steps
         SET status = 'failed', finished_at = ${finishedAt}, lease_until = NULL, lease_owner = NULL, lease_token = NULL,
             error = ${reason}
       WHERE status = 'running' AND lease_until < ${dbNow()} AND lease_reclaims >= ${MAX_LEASE_RECLAIMS}
       RETURNING run_id, step, attempt
    ), failed AS (
      UPDATE workflow_runs r
         SET status = 'failed', last_error = left(d.step || ': ' || ${reason}, 2000), current_step = d.step, finished_at = ${finishedAt}
        FROM dead d
       WHERE r.id = d.run_id AND r.status IN ('running', 'waiting')
       RETURNING r.id, r.process
    )
    SELECT d.run_id, d.step, d.attempt, f.process FROM dead d LEFT JOIN failed f ON f.id = d.run_id`);
  const dead = (spent.rows ?? spent) as Array<{ run_id: string; step: string; attempt: number; process: string | null }>;
  for (const r of dead) {
    logger.error({ runId: r.run_id, process: r.process, step: r.step, attempts: r.attempt, error: reason }, "Workflow run FAILED");
  }
  return back.length + dead.length;
}

// ─── Shutdown (SIGTERM) ───────────────────────────────────────────────────────

/**
 * Cloud Run sends SIGTERM before it replaces or removes an instance, then kills it 10 s later. Stop claiming, give the
 * steps in flight `graceMs` to finish, then hand the rest back: their rows go to `ready` at once (not an attempt, not a
 * reclaim), so another instance picks them up on its next tick instead of waiting out the lease. A step that finishes
 * after its release is discarded by the completion compare-and-set.
 */
export async function drainRunner(graceMs = config.shutdownGraceMs): Promise<{ inFlight: number; released: number; queued: number }> {
  draining = true;
  // Claimed but not started (waiting for a worker slot): nothing to wait for, so hand them back first.
  const waiting = [...queued.values()];
  queued.clear();
  const releasedQueued = await releaseRows(waiting.map((r) => [r.id, r.lease_token ?? ""]));
  const atStart = inFlight.size;
  if (atStart) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...inFlight.values()].map((f) => f.settled)),
      new Promise<void>((r) => { timer = setTimeout(r, graceMs); }),
    ]);
    clearTimeout(timer);
  }
  const still = [...inFlight.entries()];
  for (const [, f] of still) f.stopHeartbeat();
  const released = releasedQueued + await releaseRows(still.map(([id, f]) => [id, f.token]));
  logger.info({ owner: INSTANCE_ID, inFlight: atStart, queued: waiting.length, released }, "Workflow runner drained for shutdown");
  return { inFlight: atStart, released, queued: waiting.length };
}

/** Hand rows this process holds back to `ready` at once: not an attempt, not a reclaim. Returns how many were still ours. */
async function releaseRows(rows: Array<[id: string, token: string]>): Promise<number> {
  const held = rows.filter(([, token]) => token);
  if (!held.length) return 0;
  const res = await db.update(workflowSteps).set({
    status: "ready", ready_at: clock(), lease_until: null, lease_owner: null, lease_token: null,
    error: "lease released at shutdown (instance replaced); not an attempt",
  }).where(and(
    inArray(workflowSteps.id, held.map(([id]) => id)), eq(workflowSteps.status, "running"),
    eq(workflowSteps.lease_owner, INSTANCE_ID), inArray(workflowSteps.lease_token, held.map(([, token]) => token)),
  )).returning({ id: workflowSteps.id });
  return res.length;
}

/** SIGTERM → exit, at the latest: inside Cloud Run's 10 s, leaving room for the release UPDATE and the exit itself. */
export const SHUTDOWN_HARD_MS = 9_000;

export interface ShutdownOptions {
  exit?: (code: number) => void;
  /**
   * Stop accepting HTTP connections and resolve once the open requests have finished (server.close). Awaited alongside
   * the drain, so a request in flight at SIGTERM (a chat turn, an upload) is not cut off the moment the runner is idle.
   */
  closeHttp?: () => Promise<void>;
  /** Tests shorten it. */
  hardMs?: number;
}

let shutdownInstalled = false;
/**
 * Install the SIGTERM handler once (server start; a second call is a no-op, so several callers are safe). It drains the
 * runner and closes the HTTP server in parallel, then exits once both are done or SHUTDOWN_HARD_MS has passed,
 * whichever is first. (A SIGTERM listener replaces Node's default exit, so the exit here is required.)
 */
export function installRunnerShutdown(opts: ShutdownOptions = {}): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  process.once("SIGTERM", () => { void shutdownSequence(opts); });
}

/** What SIGTERM runs (exported for tests): drain ∥ close HTTP, bounded by the hard limit, then exit(0). */
export async function shutdownSequence(opts: ShutdownOptions = {}): Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  logger.info({ owner: INSTANCE_ID, inFlight: inFlight.size, queued: queued.size }, "SIGTERM: draining the workflow runner and closing HTTP");
  const drained = drainRunner()
    .catch((err: any) => logger.error({ error: String(err?.message ?? err).slice(0, 200) }, "Workflow runner drain failed; leases will expire instead"));
  const closed = Promise.resolve().then(() => opts.closeHttp?.())
    .catch((err: any) => logger.warn({ error: String(err?.message ?? err).slice(0, 200) }, "HTTP server close failed"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hard = new Promise<void>((r) => { timer = setTimeout(() => { logger.warn("Shutdown hard limit reached; exiting with work still open"); r(); }, opts.hardMs ?? SHUTDOWN_HARD_MS); });
  try { await Promise.race([Promise.all([drained, closed]), hard]); }
  finally { clearTimeout(timer); exit(0); }
}

// ─── Tick + kick ──────────────────────────────────────────────────────────────

export interface TickResult {
  expired: number;   // running rows whose lease had lapsed → ready again, or failed once the reclaim budget is spent
  claimed: number;   // ready rows this pass picked up
  done: number;      // of those, finished
  failed: number;    // of those, failed (retry scheduled or run failed)
  kicked: number;    // successor steps run inline after a claimed step finished
  lost: number;      // of those, lost their lease before finishing; their result was discarded
}

/** One consumer pass. Call under the advisory lock (see index.ts). */
export async function tick(limit = config.tickBatch): Promise<TickResult> {
  const expired = await expireLeases();
  const rows = await claim(limit);
  let done = 0, failed = 0, kicked = 0, lost = 0;
  // Claimed rows run concurrently (capped): parallel siblings overlap instead of waiting on each other.
  await runClaimed(rows, async (row) => {
    const outcome = await execute(row);
    if (outcome === "done") {
      done++;
      // A finished step opens its successor as ready; run it now rather than next minute,
      // so a run driven by the tick alone still moves at step speed, not clock speed.
      kicked += await kick(row.run_id);
    } else if (outcome === "lost") {
      lost++;
    } else {
      failed++;
    }
  }).then((results) => { for (const r of results) if (r.status === "rejected") failed++; });
  return { expired, claimed: rows.length, done, failed, kicked, lost };
}

/**
 * Run this run's ready steps now, so a start or a completion advances without waiting for
 * the minute tick. Bounded: at most `kickBatch` claims per pass, at most 10 passes.
 */
export async function kick(runId: string): Promise<number> {
  // A local server against the shared dev database leaves the work to the cloud's minute tick (lib/backgroundHost).
  if (!runsBackgroundWork()) return 0;
  let ran = 0;
  for (let pass = 0; pass < 10; pass++) {
    const rows = await claim(config.kickBatch, runId);
    if (!rows.length) break;
    // Concurrent, like tick: a run's parallel siblings are claimed together and now also run together.
    await runClaimed(rows, async (row) => { await execute(row); });
    ran += rows.length;
  }
  return ran;
}

// ─── Complete (the one door for await_human) ──────────────────────────────────

export interface CompleteInput {
  runId: string;
  step: string;
  fields: Json;
  mode: "chat" | "voice" | "form";
  /** When set, the run must belong to this athlete (tenancy). Admin calls pass null. */
  athleteId: string | null;
}

export async function completeStep(opts: CompleteInput): Promise<{ run: WorkflowRun; alreadyDone: boolean }> {
  const found = await getRun(opts.runId);
  if (!found) throw new WorkflowError("Run not found", "not_found", 404);
  const { run, steps } = found;
  if (opts.athleteId !== null && run.athlete_id !== opts.athleteId) throw new WorkflowError("Run not found", "not_found", 404);

  const waiting = steps.find((s) => s.step === opts.step && s.status === "waiting");
  if (!waiting) {
    if (steps.some((s) => s.step === opts.step && s.status === "done")) return { run, alreadyDone: true };
    throw new WorkflowError(`Step "${opts.step}" is not waiting on input`, "not_waiting", 409);
  }
  const def = getDefinition(run.process, run.definition_version);
  const step = def.steps.find((s) => s.name === opts.step)!;
  assertPayload(opts.fields, `Fields for step "${opts.step}"`);

  const ctx = await buildCtx(run, step, waiting);
  const output = await traceUnit(
    `workflow.${run.process}.${step.name}`,
    { runId: run.id, athleteId: run.athlete_id, mode: opts.mode, kind: "await_human" },
    () => step.complete!(ctx, opts.fields),
  );
  assertPayload(output ?? null, `Output of step "${step.name}"`);
  await db.update(workflowSteps).set({
    status: "done", output: (output ?? null) as any, mode: opts.mode, finished_at: clock(), trace_id: await currentTraceId(),
  }).where(eq(workflowSteps.id, waiting.id));
  await advance(run.id);
  await kick(run.id);
  const [fresh] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)).limit(1);
  return { run: fresh, alreadyDone: false };
}

// ─── Operator controls ────────────────────────────────────────────────────────

export async function retryRun(runId: string): Promise<WorkflowRun> {
  const found = await getRun(runId);
  if (!found) throw new WorkflowError("Run not found", "not_found", 404);
  const { run, steps } = found;
  if (run.status !== "failed") throw new WorkflowError(`Run is ${run.status}, not failed`, "not_failed", 409);
  const failed = [...steps].reverse().find((s) => s.status === "failed");
  if (!failed) throw new WorkflowError("No failed step to retry", "not_failed", 409);
  await db.insert(workflowSteps).values({
    run_id: run.id, step: failed.step, ordinal: failed.ordinal, attempt: failed.attempt + 1, kind: failed.kind,
    status: "ready", ready_at: clock(), input: failed.input as any,
  });
  await db.update(workflowRuns).set({ status: "running", finished_at: null, last_error: null }).where(eq(workflowRuns.id, run.id));
  await kick(run.id);
  const [fresh] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)).limit(1);
  return fresh;
}

export async function cancelRun(runId: string): Promise<WorkflowRun> {
  const found = await getRun(runId);
  if (!found) throw new WorkflowError("Run not found", "not_found", 404);
  if (found.run.status === "done") throw new WorkflowError("Run is already done", "already_done", 409);
  await db.update(workflowSteps).set({ status: "skipped", finished_at: clock() })
    .where(and(eq(workflowSteps.run_id, runId), inArray(workflowSteps.status, ["ready", "waiting"])));
  await db.update(workflowRuns).set({ status: "canceled", finished_at: clock() }).where(eq(workflowRuns.id, runId));
  const [fresh] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  return fresh;
}
