-- 0043_intelligence_foundations.sql — Phase A, Step 0: the parameter store and the as-of columns.
--
-- Pure DDL. No data rows. Nothing in production reads or writes any of this until a later
-- Phase A step: the live score still reads scoring_weights, the writers still leave the two
-- new snapshot columns NULL. Idempotent — safe to re-run, which scripts/db-migrate.sh does on
-- every deploy.
--
-- ── model_params ─────────────────────────────────────────────────────────────
-- One versioned parameter store for every engine family the Commercial Intelligence spec
-- names (§15: "all model changes are versioned and benchmarked"): marketability weights and
-- sub-weights, signal lookup tables, priors, cohort tables, research freshness TTLs, the
-- commercial-proof source policy, rate benchmarks, opportunity and earnings mixes.
--
-- It generalises the one-active-row pattern scoring_weights already uses. scoring_weights is
-- deliberately untouched: the v7 engine keeps reading it until it is retired, and the two
-- tables coexist during the migration.
--
-- Two versions live on every row and must not be conflated:
--   version         the PARAMETER SET, e.g. 'v1.0-beta.1' — which numbers these are
--   schema_version  the CONFIG SHAPE, e.g. 'marketability-config/1' — how to read `config`
-- A reader checks schema_version before trusting the shape of config; a parameter set can be
-- re-issued under a new version without the shape changing, and the shape can change without
-- the numbers changing.
--
-- `family` carries no CHECK constraint on purpose — the closed list lives in code
-- (server/services/intelligence/types.ts, ParamFamily) for the same reason LOCKED_PROMPTS does
-- (see 0033): a list a migration has to know about is one more copy to keep in step.
--
-- Status machine: draft (review only, never returned by the active lookup) → active (exactly
-- one per family, enforced by the partial unique index) → inactive (superseded, kept so
-- historical runs can be reproduced) → archived (retired). Rows are never edited in place.

CREATE TABLE IF NOT EXISTS model_params (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family         text NOT NULL,
  version        text NOT NULL,
  schema_version text NOT NULL,
  status         text NOT NULL DEFAULT 'draft',
  config         jsonb NOT NULL,
  -- First 12 of sha1(canonical JSON of config), so a run's trace and a row line up by eye.
  hash           text NOT NULL,
  note           text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  activated_at   timestamptz,
  CONSTRAINT model_params_status_check CHECK (status IN ('draft','active','inactive','archived')),
  CONSTRAINT model_params_family_version_uq UNIQUE (family, version)
);

-- One live version per family, enforced by the database — the same device scoring_weights
-- (idx_scoring_weights_active) and prompts (prompts_one_published_uq) already rely on.
CREATE UNIQUE INDEX IF NOT EXISTS model_params_one_active_uq ON model_params (family) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS model_params_family_created_idx ON model_params (family, created_at);

-- ── athlete_snapshots: as-of and engine lineage ───────────────────────────────
-- as_of          the instant the evidence set behind this snapshot is "current at" (spec
--                §21.1). NULL on every existing row and on rows the current writers insert;
--                a reader treats NULL as created_at, so no backfill is needed.
-- engine_version the PRIMARY engine/result associated with this snapshot, e.g.
--                'marketability=v1.0-beta.1'. NULL means "the scoring_weights row that was
--                active at the time" (the v7 engine). Multi-engine lineage — which rate,
--                opportunity or earnings versions also ran — belongs inside the structured
--                result metadata, not in this column.
ALTER TABLE athlete_snapshots ADD COLUMN IF NOT EXISTS as_of          timestamptz;
ALTER TABLE athlete_snapshots ADD COLUMN IF NOT EXISTS engine_version text;
