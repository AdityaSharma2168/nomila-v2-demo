-- 0091_drop_athletes_current_brand_stories_insights.sql — drop two dead v1 columns from athletes_current.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts removal ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS REMOVES ─────────────────────────────────────────────────────────────────────────────
-- athletes_current.brand_stories — v1 generated brand stories ([{ title, tagline, values[], … }]).
-- athletes_current.insights      — v1 { narrative, signals[] } capital insights.
--   Neither is written or read by any v2 code (server, client, scripts, Mila context, the data export — which
--   walks the drizzle table, so the columns simply leave it). 0 non-null values on dev (10 rows). No index, view
--   or constraint references either column.
--
--   NOT touched: story_arc, the score / rate-card columns, or `insights` on media_assets / content_posts (a
--   different, live thing with the same name).
--
-- A catalog-only change (no table rewrite). Re-runs as a no-op. No transaction control here (migrationsGuard):
-- dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

ALTER TABLE athletes_current DROP COLUMN IF EXISTS brand_stories;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS insights;
