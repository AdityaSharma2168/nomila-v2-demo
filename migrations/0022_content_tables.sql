-- 0022 — content relationship tables: brand-deal links on assets + M:N brands,
-- embed-by-reference, and publish records.
--
-- Additive only. Design: docs/opportunity-pitch-content-model.md (§5, §9 Stage 3).
--
-- ── HOW THIS REACHES PROD ────────────────────────────────────────────────────
-- Not through this file. The executor is the idempotent psql block in
-- .github/workflows/deploy.yml ("Applying content-tables DDL…"). This file records intent.
--
-- ── What it does ─────────────────────────────────────────────────────────────
-- media_assets gains (content is athlete-first — links are optional):
--   * deal_id         — the deal this content was ORIGINATED under (provenance, immutable;
--                       reuse under later deals is tracked via content_posts, not here).
--   * approval_status — gates embed/post for generated/brand content. NULL = ungated, so
--                       existing ingested IG posts are unaffected (no retroactive gating).
--   * deleted_at      — soft delete; a referenced asset is soft-deleted, never hard-deleted.
--
-- New tables:
--   * content_brands — M:N brand tags (O1): a piece can depict/serve more than one brand.
--                      Absence of a row = personal/unbranded. Embedding across brands is
--                      governed by clearance, not by these tags.
--   * kit_content    — embed-by-reference (D7): an asset placed into a media kit at a position.
--                      One asset → many kits; one kit → many assets. FK → media_kits(id), the
--                      surrogate PK added in Stage 2 (0021). Editing the asset propagates to the
--                      working kit; sent snapshots freeze separately (card_shares.snapshot_data).
--   * content_posts  — publish records (P4): one asset → many posts across platforms/reposts.
--                      Delivery-under-a-deal lives here, so content reused in a later campaign
--                      attributes correctly without mutating the asset.

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS deal_id         uuid REFERENCES deals(id);
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS approval_status text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS deleted_at      timestamptz;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_approval_check;
ALTER TABLE media_assets ADD  CONSTRAINT media_assets_approval_check
  CHECK (approval_status IS NULL OR approval_status IN ('draft','approved','rejected'));

CREATE TABLE IF NOT EXISTS content_brands (
  asset_id   uuid    NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  brand_id   integer NOT NULL REFERENCES inbox_brands(id) ON DELETE CASCADE,
  role       text,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (asset_id, brand_id),
  CONSTRAINT content_brands_role_check CHECK (role IS NULL OR role IN ('primary','featured'))
);

CREATE TABLE IF NOT EXISTS kit_content (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_kit_id uuid    NOT NULL REFERENCES media_kits(id)   ON DELETE CASCADE,
  asset_id     uuid    NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kit_content_kit_asset_uniq ON kit_content (media_kit_id, asset_id);

CREATE TABLE IF NOT EXISTS content_posts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id   uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  platform   text NOT NULL,
  permalink  text,
  insights   jsonb,
  deal_id    uuid REFERENCES deals(id),
  posted_at  timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_posts_asset ON content_posts (asset_id);
