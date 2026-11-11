-- Studio generation (migrations/0027): generation_jobs, lineage, indexes.
--
-- Extracted VERBATIM from .github/workflows/deploy.yml on 2026-09-08 (PR B of the
-- environment split). This was the inline `psql -c` block that every deploy re-ran;
-- it is idempotent and now runs from this file, in the same order, via
-- scripts/db-migrate.sh — in dev and in prod alike. Nothing here is in the drizzle
-- journal; the re-baseline (docs/plans/production-environment-split.md, Track D)
-- folds it into 0000_baseline.
-- Studio generation: job records, lineage, and the publish gate
-- (docs/plans/studio-a25-a31-plan.md §5 / migrations/0027). ADDITIVE ONLY — no UPDATE, no
-- DELETE, no DROP COLUMN, no backfill. Every ADD COLUMN is nullable with no default. Every
-- statement is IF NOT EXISTS / DROP-then-ADD guarded, so this re-runs safely each deploy.
-- 0027 is already applied to prod by hand, so this block is a no-op today; it exists so a
-- rebuilt or restored database converges to the same shape.
-- ORDER: generation_jobs and media_assets.generation_job_id must precede the group-6 FK and
-- trigger, which reference both. Group 6 is applied via -f from the same file 0027 and the
-- PGlite suite use, so there is no third copy of the trigger DDL to drift.

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_derived_from_fkey;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_derived_from_fkey FOREIGN KEY (derived_from_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_media_assets_derived_from ON media_assets (derived_from_asset_id) WHERE derived_from_asset_id IS NOT NULL;
-- ⚠️ THIS LIST MUST MATCH shared/schema.ts AND THE LATEST WIDENING (0062 added 'reference'). Step 1 re-runs
-- this DROP + ADD on every deploy BEFORE the numbered files, so a list narrower than the rows already in
-- the table fails the whole deploy — as it did on 2026-09-23 ("violated by some row") the first deploy
-- after a 'reference' row existed. referenceOrigin.migration.test.ts pins this line to the schema.
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_origin_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_origin_check CHECK (origin IN ('connected','discovery','upload','generated','reference'));
CREATE TABLE IF NOT EXISTS generation_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), athlete_id uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE, brand_id integer REFERENCES inbox_brands(id), origin text NOT NULL, mode text NOT NULL, objective text NOT NULL, deliverable text NOT NULL, brief jsonb NOT NULL, source_asset_id uuid REFERENCES media_assets(id), status text NOT NULL DEFAULT 'pending', last_error text, provider text, model text, cost_estimated_usd numeric, cost_basis text, created_at timestamptz DEFAULT now(), started_at timestamptz, completed_at timestamptz, updated_at timestamptz DEFAULT now(), CONSTRAINT generation_jobs_origin_check CHECK (origin IN ('system','inbound')), CONSTRAINT generation_jobs_mode_check CHECK (mode IN ('edit','generate')), CONSTRAINT generation_jobs_status_check CHECK (status IN ('pending','running','succeeded','failed','canceled')), CONSTRAINT generation_jobs_edit_needs_source CHECK ((mode = 'edit' AND source_asset_id IS NOT NULL) OR (mode = 'generate' AND source_asset_id IS NULL)));
CREATE INDEX IF NOT EXISTS idx_generation_jobs_athlete ON generation_jobs (athlete_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_status ON generation_jobs (status, created_at) WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_generation_jobs_source ON generation_jobs (source_asset_id) WHERE source_asset_id IS NOT NULL;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS generation_job_id uuid;
CREATE INDEX IF NOT EXISTS idx_media_assets_generation_job ON media_assets (generation_job_id) WHERE generation_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_content_posts_deal ON content_posts (deal_id) WHERE deal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS content_posts_platform_permalink_uniq ON content_posts (platform, permalink) WHERE permalink IS NOT NULL;
