-- 0148_workflow_step_lease.sql — who holds a workflow step's lease, and how often it was reclaimed (workflow_steps).
--
-- The runner (server/workflow/runner.ts) booked a lapsed lease as a failed attempt, so a step declared with
-- retry.maxAttempts: 1 failed its whole run on one crash or one revision replacement, and a runner whose lease had been
-- reclaimed could still mark the row done over the new holder. Three columns:
--   lease_owner     text  — the instance that claimed the row (revision + a random id), for release at SIGTERM and ops.
--   lease_token     uuid  — fresh per claim; completion, failure and the heartbeat are compare-and-set on owner + token.
--   lease_reclaims  int   — times this attempt's lease lapsed and the row went back to ready. Not an attempt; bounded on
--                           its own (runner.ts MAX_LEASE_RECLAIMS).
--
-- Pure DDL, additive only (expand): two nullable columns and one NOT NULL DEFAULT 0 (a constant default, so no table
-- rewrite on Postgres 11+). Existing rows read NULL / NULL / 0, which the runner treats as "no holder, never reclaimed".
-- Idempotent, safe to re-run, which scripts/db-migrate.sh does on every deploy. No transaction control here
-- (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names
-- it in the step-3 list; this file, that line and the shared/schemaWorkflow.ts declaration ship in ONE commit or the
-- drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.

ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS lease_reclaims integer NOT NULL DEFAULT 0;
