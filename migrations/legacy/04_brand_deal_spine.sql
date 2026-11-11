-- Brand-deal spine (migrations/0020): inbox_brands as catalog, deals.brand_id + direction.
--
-- Extracted VERBATIM from .github/workflows/deploy.yml on 2026-09-08 (PR B of the
-- environment split). This was the inline `psql -c` block that every deploy re-ran;
-- it is idempotent and now runs from this file, in the same order, via
-- scripts/db-migrate.sh — in dev and in prod alike. Nothing here is in the drizzle
-- journal; the re-baseline (docs/plans/production-environment-split.md, Track D)
-- folds it into 0000_baseline.
-- Brand-deal spine (docs/opportunity-pitch-content-model.md §9 Stage 1 / migrations/0020).
-- ADDITIVE ONLY. Promotes inbox_brands to a general catalog (origin) and gives deals a real
-- brand FK (advertiser + optional broker) plus inbound/outbound direction. The backfill
-- matches deals.brand_name -> inbox_brands by normalized name; unmatched deals keep
-- brand_name as the display fallback. No table rename (doc §11). Re-runs safely each deploy.

ALTER TABLE inbox_brands ADD COLUMN IF NOT EXISTS origin text DEFAULT 'detected';
ALTER TABLE deals ADD COLUMN IF NOT EXISTS brand_id integer REFERENCES inbox_brands(id);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS broker_brand_id integer REFERENCES inbox_brands(id);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS direction text;
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_direction_check;
ALTER TABLE deals ADD CONSTRAINT deals_direction_check CHECK (direction IS NULL OR direction IN ('inbound','outbound'));
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_source_check;
ALTER TABLE deals ADD CONSTRAINT deals_source_check CHECK (source IN ('inbox_scan','self_reported','contract_upload','api','public_profile','outbound_agent'));
UPDATE deals d SET brand_id = b.id FROM inbox_brands b WHERE d.brand_id IS NULL AND lower(trim(d.brand_name)) = lower(b.normalized_name);
