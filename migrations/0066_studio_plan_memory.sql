-- 0066_studio_plan_memory.sql — a plan row remembers what it was planned FROM (Studio PR 13, the
-- canonical object, part 1), and a generation job remembers what it actually cost (the rider from
-- PR 11). 0065 is the objectives PR's (objective_events CHECK).
--
-- A file is only ever applied because scripts/db-migrate.sh names it in the step-3 list — there is
-- no glob — so this file, that line, and the shared/schema.ts declaration ship in ONE commit, or the
-- HARD drift gate (step 5, server/scripts/checkSchemaDrift.ts) reds the deploy that merged half of
-- them. The drift gate compares NAMES only; the type of each column is held by
-- server/studio/agent/planMemory.migration.test.ts against a schema.ts push.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────
--
-- FIVE nullable columns and nothing else. No table, no index, no constraint, no DROP, no UPDATE, no
-- backfill. ADD COLUMN of a nullable column with no default is a catalog-only change in Postgres — no
-- table rewrite, no ACCESS EXCLUSIVE held for longer than the catalog write — and IF NOT EXISTS makes
-- every re-run a no-op, because db-migrate.sh applies every listed file on every deploy.
--
--   studio_plans.prompt        her words, as the route validated them (studio/agent/plans.ts savePlan).
--   studio_plans.aesthetic     her feel line, or null when she gave none.
--   studio_plans.objective     the purpose the plan was made for (one of the route's OBJECTIVES).
--   studio_plans.confirm       the confirm step's flags — which brief lines were literal and which
--                              inferred, with their quotes and becauses (studio/direction/envelope.ts
--                              inferenceFlagSchema) — or null on a plan with no confirmed brief.
--   generation_jobs.cost_usd   what the provider's result said the job cost, written ONCE at succeed
--                              (studio/jobs.ts). cost_estimated_usd and cost_basis are untouched:
--                              spentTodayUsd keeps summing the quote, and cost_basis is what tells a
--                              reported figure from an estimated one on the join.
--
-- ── WHAT DOES NOT CHANGE ────────────────────────────────────────────────────────────────────────
--
-- Rows are never edited (schema.ts, studio_plans header): the four plan columns are written once, at
-- savePlan, and a pre-0066 row keeps every one of them null forever — no backfill. Such a row is
-- re-planned exactly as before this file: the client rebuilds the ask from the stored brief. The
-- pre-0066 image never names these columns, so it is unaffected by their existence, and the rollback
-- story is "do nothing".

ALTER TABLE studio_plans ADD COLUMN IF NOT EXISTS prompt text;
ALTER TABLE studio_plans ADD COLUMN IF NOT EXISTS aesthetic text;
ALTER TABLE studio_plans ADD COLUMN IF NOT EXISTS objective text;
ALTER TABLE studio_plans ADD COLUMN IF NOT EXISTS confirm jsonb;

ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS cost_usd numeric;
