-- 0071_outreach_plans.sql — outreach planning work, the first production planner record (preparation only).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- ONE narrow table. Outreach has no native persisted object, so its planning result IS the work item: one active
-- record per (athlete, recommendation). The handoff is stored verbatim (small; it is the lineage); evidence stays by
-- run reference inside it. `result` is the planner's envelope with the outreach-native payload. Planning completion
-- (`planning_completed_at`) is separate from any Recommendation outcome and never implies one. No column can hold a
-- sent message; no status means "sent". This is not a generic plan table: nothing but outreach reads `result`.
-- No route, no cron, no flag reads it yet (OUTREACH_PLANNER_ENABLED is off everywhere).

CREATE TABLE IF NOT EXISTS outreach_plans (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id             uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  version                text NOT NULL,
  recommendation_id      text NOT NULL,
  objective_ids          jsonb NOT NULL DEFAULT '[]'::jsonb,
  handoff                jsonb NOT NULL,
  planner_spec           text NOT NULL,
  planner_digest         text NOT NULL,
  context_sha256         text NOT NULL,
  status                 text NOT NULL,
  result                 jsonb NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  reviewed_at            timestamptz,
  planning_completed_at  timestamptz,
  superseded_by          uuid REFERENCES outreach_plans(id) ON DELETE SET NULL
);

-- one ACTIVE planning record per Recommendation: idempotency at the seam
CREATE UNIQUE INDEX IF NOT EXISTS outreach_plans_active_per_recommendation
  ON outreach_plans (athlete_id, recommendation_id)
  WHERE status IN ('prepared', 'reviewed', 'complete', 'attached', 'escalated');

CREATE INDEX IF NOT EXISTS idx_outreach_plans_athlete_created ON outreach_plans (athlete_id, created_at DESC);
