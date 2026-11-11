-- 0021 — pitch anchoring: media_kits gets a surrogate PK + opportunity anchor.
--
-- NOT purely additive (replaces the primary key), but isolated to the pitch/kit system:
-- nothing FK-references media_kits, and only kitCache.ts upserts it. Design:
-- docs/opportunity-pitch-content-model.md (§5 O4, §9 Stage 2).
--
-- ── HOW THIS REACHES PROD ────────────────────────────────────────────────────
-- Not through this file. The executor is the idempotent psql block in
-- .github/workflows/deploy.yml ("Applying pitch-anchoring DDL…"). This file records intent.
--
-- ── What it does ─────────────────────────────────────────────────────────────
-- Today media_kits is PRIMARY KEY (athlete_id, brand_id) — one kit per brand. To let a
-- pitch anchor to a specific opportunity (deal/campaign) we need (athlete, brand,
-- opportunity?) as the identity, but a nullable opportunity_id can't sit in a PK. So:
--   1. add a surrogate `id` PK,
--   2. add `opportunity_id` (nullable; NULL = the general pitch / public card),
--   3. enforce identity with two PARTIAL unique indexes:
--        - (athlete_id, brand_id, opportunity_id) WHERE opportunity_id IS NOT NULL
--          → many opportunity-scoped pitches per brand,
--        - (athlete_id, brand_id)                 WHERE opportunity_id IS NULL
--          → exactly one general pitch per brand (NULL bucket collapses to a singleton).
--
-- The PK swap is GUARDED (runs only while the PK still includes brand_id), so the deploy
-- block is a no-op on every subsequent run. All existing rows have opportunity_id NULL, so
-- the general partial index still holds one-row-per-(athlete,brand) and builds without dups.
--
-- kitCache.ts's upsert conflict target is retargeted to the general partial index
-- (targetWhere: opportunity_id IS NULL) in the same PR.

ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS opportunity_id uuid REFERENCES deals(id);

-- Swap composite PK → surrogate PK, once (only while the PK still includes brand_id).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'media_kits'::regclass AND c.contype = 'p' AND a.attname = 'brand_id'
  ) THEN
    ALTER TABLE media_kits DROP CONSTRAINT media_kits_pkey;
    ALTER TABLE media_kits ADD  CONSTRAINT media_kits_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS media_kits_brand_opportunity_uniq
  ON media_kits (athlete_id, brand_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS media_kits_brand_general_uniq
  ON media_kits (athlete_id, brand_id) WHERE opportunity_id IS NULL;
