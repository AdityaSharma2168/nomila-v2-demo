-- 0020 — brand-deal spine: promote inbox_brands in place + give deals a real brand FK.
--
-- Additive only. Design: docs/opportunity-pitch-content-model.md (§5, §9 Stage 1).
--
-- ── HOW THIS REACHES PROD ────────────────────────────────────────────────────
-- Not through this file. _journal.json stops at 0011, so drizzle-kit skips every
-- migration from 0012 on. The executing copy is the idempotent psql block in
-- .github/workflows/deploy.yml ("Applying brand-deal spine DDL…"), which runs
-- BEFORE the image is replaced with ON_ERROR_STOP=1. This file records intent.
--
-- ── What it does ─────────────────────────────────────────────────────────────
-- 1. inbox_brands.origin — the table is already a general brand-identity catalog
--    (name/domain/logo/category/tier/audience/enrichment), not inbox-scoped. This
--    promotes it IN PLACE so outbound/self-added brands live here too. No physical
--    rename: it collides with in-flight voice/deal work (doc §11).
-- 2. deals.brand_id — the ADVERTISER, a real FK. Nullable during transition; legacy
--    rows keep brand_name as the display fallback. This is what lets deals, pitches,
--    and content all cross-reference the same brand identity (doc D10).
-- 3. deals.broker_brand_id — the agency/MCN brokering the deal, if any (doc P1). Kept
--    separate so brand_id always means the advertiser, never the broker.
-- 4. deals.direction — 'inbound' | 'outbound'. Static provenance, orthogonal to
--    status/source; drives the two-on-ramp status machine (doc §6.1).
-- 5. deals_source_check widened with 'public_profile','outbound_agent' (the new hub
--    origins). Superset of the old set, so every existing row stays valid.
-- 6. Backfill brand_id by normalized-name match; unmatched deals keep brand_name.
--
-- Deliberately NOT here: the status-vocabulary change (detected→new, +active/…). It
-- ripples into teammates' test fixtures and lands as its own coordinated PR (doc §10).

ALTER TABLE inbox_brands ADD COLUMN IF NOT EXISTS origin text DEFAULT 'detected';

ALTER TABLE deals ADD COLUMN IF NOT EXISTS brand_id        integer REFERENCES inbox_brands(id);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS broker_brand_id integer REFERENCES inbox_brands(id);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS direction       text;

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_direction_check;
ALTER TABLE deals ADD  CONSTRAINT deals_direction_check
  CHECK (direction IS NULL OR direction IN ('inbound','outbound'));

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_source_check;
ALTER TABLE deals ADD  CONSTRAINT deals_source_check
  CHECK (source IN ('inbox_scan','self_reported','contract_upload','api','public_profile','outbound_agent'));

-- Backfill: match on normalized advertiser name; unmatched rows stay on brand_name.
UPDATE deals d
   SET brand_id = b.id
  FROM inbox_brands b
 WHERE d.brand_id IS NULL
   AND lower(trim(d.brand_name)) = lower(b.normalized_name);
