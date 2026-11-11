-- 0083_identity_intelligence_attempts.sql — every model answer of an Identity Intelligence recompute, with the validator's
-- errors (identity-validation/1).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- identity_intelligence_attempts — one row per model answer (attempt 0, and the repair if there was one), passed or
--   rejected, with the raw response and the validator's errors. The Identity Intelligence ledger row stays atomic: a
--   rejected run writes no ledger row, and before this table it left nothing to inspect. `prompt` is stored on attempt 0
--   only (its numbered items give the cited ids their meaning). Diagnostic history: nothing reads it to decide anything.
--
-- Additive: one new table, no change to any existing table. Names and index order are written exactly as a
-- shared/schema.ts push produces them (identityIntelligenceAttempts.migration.test.ts pins that).

CREATE TABLE IF NOT EXISTS identity_intelligence_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL,
  athlete_id          uuid NOT NULL CONSTRAINT identity_intelligence_attempts_athlete_id_athletes_id_fk REFERENCES athletes(id) ON DELETE CASCADE,
  attempt             integer NOT NULL,
  input_version       text NOT NULL,
  prompt_version      text NOT NULL,
  validation_version  text NOT NULL,
  model               text,
  finish_reason       text,
  prompt              text,
  response            text NOT NULL,
  errors              jsonb NOT NULL DEFAULT '[]'::jsonb,
  passed              boolean NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_intelligence_attempts_athlete_idx ON identity_intelligence_attempts (athlete_id, created_at);
CREATE INDEX IF NOT EXISTS identity_intelligence_attempts_run_idx ON identity_intelligence_attempts (run_id);
