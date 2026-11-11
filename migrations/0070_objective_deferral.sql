-- 0070_objective_deferral.sql — a deferral carries its kind (objectives-lineage-design.md §2, L2).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- ONE nullable jsonb column on objectives: `deferral` { kind: information | time | athlete, after?, said }.
-- A projection of the latest defer event, cleared when the row leaves `deferred`. NULL on rows deferred before
-- L2 is read as `information` — the conservative kind — by the reader, not by a backfill. No data changes.

ALTER TABLE objectives ADD COLUMN IF NOT EXISTS deferral jsonb;
