/**
 * types.ts — the step contract every workflow definition is written against.
 *
 * A definition is code: a version-stamped, ordered list of steps. Its CONFIG (prompts,
 * thresholds, question lists) belongs in the prompt registry, not here. A run pins the
 * definition version it started on, so changing a definition is always a new version and
 * in-flight runs never see the change.
 *
 * Step kinds:
 *   code         — deterministic work. `run(ctx)` returns the output (references only).
 *   model        — a code step that calls a model. Same runtime treatment; the kind exists so
 *                  the runs page and Langfuse can filter on it.
 *   await_human  — the run parks. `payload(ctx)` renders what the client needs to show the
 *                  step; `complete(ctx, fields)` validates and writes when a person answers.
 *   schedule     — a step that becomes ready at a future time (`readyAt(ctx)`).
 *
 * The contract every step honours:
 *   • Idempotent. A step may run twice (at-least-once). Check before writing, or key writes
 *     so a repeat is a no-op.
 *   • References out, references in. Return { snapshot_id }, never the snapshot.
 *   • Never swallow. Throw on failure; the runner records the error and schedules the retry.
 */

export type Json = unknown;

export interface StepCtx {
  runId: string;
  athleteId: string | null;
  process: string;
  definitionVersion: number;
  step: string;
  attempt: number;
  /** This step's input (references). For await_human, the rendered payload. */
  input: Json;
  /** Outputs of every completed earlier step in this run, by step name. */
  outputs: Record<string, Json>;
  /** The run's own input, as started. */
  runInput: Json;
}

/**
 * Retry policy — exponential backoff with jitter. Shape borrowed from Trigger.dev's
 * `retry` options (Apache-2.0): maxAttempts, factor, minTimeoutMs, maxTimeoutMs, randomize.
 * Delay for attempt n (1-based, the attempt that just failed) is
 *   min(maxTimeoutMs, minTimeoutMs * factor^(n-1)) × (randomize ? U[0.5, 1.5) : 1).
 */
export interface RetryPolicy {
  maxAttempts: number;
  factor: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  randomize: boolean;
}

export interface StepDef {
  name: string;
  kind: "code" | "model" | "await_human" | "schedule";
  /** code | model */
  run?: (ctx: StepCtx) => Promise<Json>;
  /** await_human: what the client needs to render this step. Stored as the step's input. */
  payload?: (ctx: StepCtx) => Promise<Json>;
  /** await_human: validate + write when a person answers. Returns the step output. */
  complete?: (ctx: StepCtx, fields: Json) => Promise<Json>;
  /** schedule: when the step becomes claimable. */
  readyAt?: (ctx: StepCtx) => Promise<Date> | Date;
  /**
   * The lease: how long the step's process may go silent (no heartbeat) before another instance reclaims the row. A
   * running step's heartbeat extends it every third, so it is NOT a cap on how long the step may run.
   */
  leaseMs?: number;
  /**
   * The hard cap on one execution, after which the attempt fails as an error (and retries). Default: leaseMs ×
   * WORKFLOW_STEP_DEADLINE_LEASES (3). Set it on a step whose legitimate runtime can exceed that (a long render, a
   * research pass with an unbounded provider loop) rather than raising the lease, which would slow crash recovery.
   */
  deadlineMs?: number;
  retry?: Partial<RetryPolicy>;
  /**
   * Runs alongside the PREVIOUS step in the list (same ordinal). The run advances when every
   * step at that ordinal is done; one failing fails the run.
   */
  parallel?: boolean;
}

export interface WorkflowDef {
  process: string;
  version: number;
  steps: StepDef[];
  /**
   * The "one active run per athlete" scope, derived from the run input. Defaults to the
   * process name. first_look returns `first_look:<platform>` so one athlete can have a look
   * per platform in flight, never two of the same. Must be deterministic for a given input.
   */
  activeScope?: (input: Json) => string;
  /**
   * Called once, right AFTER the run is marked `done` (so it no longer holds its active scope): a definition may start
   * a follow-up run of its own process here, which a step could not — from inside a step the run is still active and a
   * same-scope start would only join it. Errors are logged and never change the finished run.
   */
  onDone?: (run: DoneRun) => Promise<void> | void;
}

export interface DoneRun { runId: string; athleteId: string | null; input: Json; outputs: Record<string, Json> }

/** A definition after the registry has assigned ordinals. */
export interface CompiledStep extends StepDef {
  ordinal: number;
}

export interface CompiledWorkflow {
  process: string;
  version: number;
  steps: CompiledStep[];
  /** ordinal → the steps at that position */
  groups: CompiledStep[][];
  activeScope?: (input: Json) => string;
  onDone?: (run: DoneRun) => Promise<void> | void;
}
