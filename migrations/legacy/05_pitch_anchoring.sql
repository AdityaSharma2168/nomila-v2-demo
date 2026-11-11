-- Pitch anchoring (migrations/0021): media_kits surrogate id + opportunity anchor.
--
-- Extracted VERBATIM from .github/workflows/deploy.yml on 2026-09-08 (PR B of the
-- environment split). This was the inline `psql -c` block that every deploy re-ran;
-- it is idempotent and now runs from this file, in the same order, via
-- scripts/db-migrate.sh — in dev and in prod alike. Nothing here is in the drizzle
-- journal; the re-baseline (docs/plans/production-environment-split.md, Track D)
-- folds it into 0000_baseline.
-- Pitch anchoring (docs/opportunity-pitch-content-model.md §9 Stage 2 / migrations/0021).
-- Replaces media_kits' composite PK (athlete_id, brand_id) with a surrogate id, adds an
-- opportunity anchor, and enforces pitch identity via two PARTIAL unique indexes: many
-- opportunity-scoped pitches per brand, but exactly one general (opportunity NULL) pitch.
-- The PK swap is GUARDED so it runs once — only while the PK still includes brand_id — so
-- re-running every deploy is a no-op afterward.

ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS opportunity_id uuid REFERENCES deals(id);
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) WHERE c.conrelid = 'media_kits'::regclass AND c.contype = 'p' AND a.attname = 'brand_id') THEN ALTER TABLE media_kits DROP CONSTRAINT media_kits_pkey; ALTER TABLE media_kits ADD CONSTRAINT media_kits_pkey PRIMARY KEY (id); END IF; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS media_kits_brand_opportunity_uniq ON media_kits (athlete_id, brand_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS media_kits_brand_general_uniq ON media_kits (athlete_id, brand_id) WHERE opportunity_id IS NULL;
