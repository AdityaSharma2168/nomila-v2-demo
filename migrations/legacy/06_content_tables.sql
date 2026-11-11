-- Content relationship tables (migrations/0022): content_brands, kit_content, content_posts.
--
-- Extracted VERBATIM from .github/workflows/deploy.yml on 2026-09-08 (PR B of the
-- environment split). This was the inline `psql -c` block that every deploy re-ran;
-- it is idempotent and now runs from this file, in the same order, via
-- scripts/db-migrate.sh — in dev and in prod alike. Nothing here is in the drizzle
-- journal; the re-baseline (docs/plans/production-environment-split.md, Track D)
-- folds it into 0000_baseline.
-- Content relationship tables (docs/opportunity-pitch-content-model.md §9 Stage 3 /
-- migrations/0022). Additive only. media_assets gains deal_id (originating provenance),
-- approval_status (gates embed/post; NULL = ungated), deleted_at (soft delete). Plus three
-- new tables: content_brands (M:N brand tags), kit_content (embed-by-reference into a kit),
-- content_posts (publish records — one asset -> many posts).

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS deal_id uuid REFERENCES deals(id);
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS approval_status text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_approval_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_approval_check CHECK (approval_status IS NULL OR approval_status IN ('draft','approved','rejected'));
CREATE TABLE IF NOT EXISTS content_brands (asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE, brand_id integer NOT NULL REFERENCES inbox_brands(id) ON DELETE CASCADE, role text, created_at timestamptz DEFAULT now(), PRIMARY KEY (asset_id, brand_id), CONSTRAINT content_brands_role_check CHECK (role IS NULL OR role IN ('primary','featured')));
CREATE TABLE IF NOT EXISTS kit_content (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), media_kit_id uuid NOT NULL REFERENCES media_kits(id) ON DELETE CASCADE, asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE, position integer NOT NULL DEFAULT 0, created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS kit_content_kit_asset_uniq ON kit_content (media_kit_id, asset_id);
CREATE TABLE IF NOT EXISTS content_posts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE, platform text NOT NULL, permalink text, insights jsonb, deal_id uuid REFERENCES deals(id), posted_at timestamptz, created_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_content_posts_asset ON content_posts (asset_id);
