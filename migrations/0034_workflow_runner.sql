-- 0034_workflow_runner.sql — the durable process layer (PR 1 of the onboarding workflow).
-- See shared/schemaWorkflow.ts for the column-by-column rationale.
--
-- Two tables. workflow_runs is one row per process instance; workflow_steps is APPEND-ONLY,
-- one row per step attempt, and doubles as the work queue (status='ready' rows) and the audit
-- trail. Payloads are references only; the runner enforces an 8 KB cap.

CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "athlete_id"         uuid REFERENCES "athletes"("id") ON DELETE CASCADE,
  "process"            text NOT NULL,
  "definition_version" integer NOT NULL,
  "status"             text NOT NULL,
  "current_step"       text,
  "input"              jsonb NOT NULL DEFAULT '{}'::jsonb,
  "started_at"         timestamptz NOT NULL DEFAULT now(),
  "finished_at"        timestamptz,
  "last_error"         text,
  "created_by"         text,
  "idempotency_key"    text,
  CONSTRAINT "workflow_runs_status_check"
    CHECK ("status" IN ('running','waiting','failed','done','canceled'))
);

-- One active run per athlete per process. A second start() returns the first run.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_runs_one_active"
  ON "workflow_runs" ("athlete_id", "process") WHERE status IN ('running','waiting');
-- A repeated trigger with the same key returns the same run (any status).
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_runs_idempotency"
  ON "workflow_runs" ("process", "idempotency_key") WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS "workflow_runs_status_started" ON "workflow_runs" ("status", "started_at");
CREATE INDEX IF NOT EXISTS "workflow_runs_athlete"        ON "workflow_runs" ("athlete_id", "process");

CREATE TABLE IF NOT EXISTS "workflow_steps" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id"      uuid NOT NULL REFERENCES "workflow_runs"("id") ON DELETE CASCADE,
  "step"        text NOT NULL,
  "ordinal"     integer NOT NULL,
  "attempt"     integer NOT NULL DEFAULT 1,
  "kind"        text NOT NULL,
  "status"      text NOT NULL,
  "ready_at"    timestamptz NOT NULL DEFAULT now(),
  "lease_until" timestamptz,
  "input"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "output"      jsonb,
  "mode"        text,
  "trace_id"    text,
  "error"       text,
  "started_at"  timestamptz,
  "finished_at" timestamptz,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workflow_steps_kind_check"
    CHECK ("kind" IN ('code','model','await_human','schedule')),
  CONSTRAINT "workflow_steps_status_check"
    CHECK ("status" IN ('ready','running','waiting','done','failed','skipped')),
  CONSTRAINT "workflow_steps_mode_check"
    CHECK ("mode" IS NULL OR "mode" IN ('chat','voice','form'))
);

-- The claim query's index: ready rows, oldest due first.
CREATE INDEX IF NOT EXISTS "workflow_steps_claim" ON "workflow_steps" ("status", "ready_at") WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS "workflow_steps_run"   ON "workflow_steps" ("run_id", "ordinal", "attempt");
