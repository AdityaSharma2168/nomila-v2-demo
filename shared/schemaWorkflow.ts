/**
 * schemaWorkflow.ts — the durable process layer: workflow_runs + workflow_steps.
 *
 * Design: docs/plans/workflow-runner.md (and the Workflow Runner Note). One run per
 * (athlete, process) at a time; steps are APPEND-ONLY, one row per attempt, so the table is
 * the audit trail as well as the queue. Inputs and outputs hold REFERENCES (ids), never
 * documents — Langfuse holds prompts and responses, the step holds the trace id. The runner
 * enforces an 8 KB cap on both so the rule is a guard, not a convention.
 *
 * Kept in its own file and re-exported from shared/schema.ts so the runner's tables are easy
 * to find and the (large) main schema file only grows by one line.
 */

import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, jsonb, timestamp, index, uniqueIndex, check,
} from "drizzle-orm/pg-core";
import { athletes } from "./schema";

export const WORKFLOW_RUN_STATUSES  = ["running", "waiting", "failed", "done", "canceled"] as const;
export const WORKFLOW_STEP_KINDS    = ["code", "model", "await_human", "schedule"] as const;
export const WORKFLOW_STEP_STATUSES = ["ready", "running", "waiting", "done", "failed", "skipped"] as const;
export const WORKFLOW_STEP_MODES    = ["chat", "voice", "form"] as const;

export type WorkflowRunStatus  = (typeof WORKFLOW_RUN_STATUSES)[number];
export type WorkflowStepKind   = (typeof WORKFLOW_STEP_KINDS)[number];
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];
export type WorkflowStepMode   = (typeof WORKFLOW_STEP_MODES)[number];

export const workflowRuns = pgTable("workflow_runs", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  // Null for shared runs that belong to no athlete (a sport-wide calendar refresh).
  athlete_id:         uuid("athlete_id").references(() => athletes.id, { onDelete: "cascade" }),
  // 'onboarding' | 'studio_generate' | 'weekly_plan' | 'refresh' | … — the registry owns the list.
  process:            text("process").notNull(),
  // A run pins the definition version it started on; in-flight runs never see a new version.
  definition_version: integer("definition_version").notNull(),
  // The "one active run per athlete" scope. Defaults to the process name; a definition may
  // derive a finer key from the input (first_look → 'first_look:instagram'), so an athlete can
  // have one first look per platform in flight, never two of the same.
  active_scope:       text("active_scope").notNull(),
  status:             text("status").notNull(),
  current_step:       text("current_step"),
  // References only, ≤ 8 KB. What the run was started with.
  input:              jsonb("input").notNull().default(sql`'{}'::jsonb`),
  started_at:         timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finished_at:        timestamp("finished_at", { withTimezone: true }),
  last_error:         text("last_error"),
  // 'signup' | 'connect' | 'admin' | 'schedule' | 'release' — who or what started it.
  created_by:         text("created_by"),
  // Caller-supplied key that makes start() idempotent — e.g. connect:<connected_account_id>.
  // Borrowed from Trigger.dev's idempotencyKey: a repeated trigger returns the same run.
  idempotency_key:    text("idempotency_key"),
}, (t) => [
  check("workflow_runs_status_check", sql`${t.status} IN ('running','waiting','failed','done','canceled')`),
  // One active run per athlete per scope, enforced by the database. A second start returns
  // the first run instead of racing it.
  uniqueIndex("workflow_runs_one_active").on(t.athlete_id, t.active_scope)
    .where(sql`status IN ('running','waiting')`),
  index("workflow_runs_status_started").on(t.status, t.started_at),
  index("workflow_runs_athlete").on(t.athlete_id, t.process),
  uniqueIndex("workflow_runs_idempotency").on(t.process, t.idempotency_key)
    .where(sql`idempotency_key IS NOT NULL`),
]);

export const workflowSteps = pgTable("workflow_steps", {
  id:          uuid("id").primaryKey().defaultRandom(),
  run_id:      uuid("run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  step:        text("step").notNull(),
  // Position in the definition. Parallel siblings share an ordinal; the run advances when
  // every row at the current ordinal is done.
  ordinal:     integer("ordinal").notNull(),
  attempt:     integer("attempt").notNull().default(1),
  kind:        text("kind").notNull(),
  status:      text("status").notNull(),
  // Schedule steps and retry backoff set this forward; the claim query ignores rows not yet due.
  ready_at:    timestamp("ready_at", { withTimezone: true }).notNull().defaultNow(),
  lease_until: timestamp("lease_until", { withTimezone: true }),
  // Who holds the lease (0148): the instance that claimed the row, and a fresh token per claim. Completion, failure and
  // the heartbeat are compare-and-set on both, so a runner whose lease was reclaimed can never overwrite the new holder.
  lease_owner: text("lease_owner"),
  lease_token: uuid("lease_token"),
  // Times this attempt's lease lapsed (a crash or a replaced revision) and the row went back to ready. A reclaim is not
  // an attempt; it has its own bound (runner.ts MAX_LEASE_RECLAIMS), after which the run fails with that reason.
  lease_reclaims: integer("lease_reclaims").notNull().default(0),
  // References only, ≤ 8 KB. For await_human, the payload the client renders.
  input:       jsonb("input").notNull().default(sql`'{}'::jsonb`),
  output:      jsonb("output"),
  // How an await_human step was completed — so we learn which door people use.
  mode:        text("mode"),
  trace_id:    text("trace_id"),
  error:       text("error"),
  started_at:  timestamp("started_at", { withTimezone: true }),
  finished_at: timestamp("finished_at", { withTimezone: true }),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("workflow_steps_kind_check",   sql`${t.kind} IN ('code','model','await_human','schedule')`),
  check("workflow_steps_status_check", sql`${t.status} IN ('ready','running','waiting','done','failed','skipped')`),
  check("workflow_steps_mode_check",   sql`${t.mode} IS NULL OR ${t.mode} IN ('chat','voice','form')`),
  // The claim query: ready rows, oldest due first.
  index("workflow_steps_claim").on(t.status, t.ready_at).where(sql`status = 'ready'`),
  index("workflow_steps_run").on(t.run_id, t.ordinal, t.attempt),
]);

export type WorkflowRun     = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun  = typeof workflowRuns.$inferInsert;
export type WorkflowStep    = typeof workflowSteps.$inferSelect;
export type NewWorkflowStep = typeof workflowSteps.$inferInsert;
