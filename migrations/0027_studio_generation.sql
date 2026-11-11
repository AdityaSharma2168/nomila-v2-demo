-- 0027 — Studio generation: job records, lineage, and the publish/embed gates.
--
-- A3.2 amendment: the embedded generationGuards.sql block below gained TWO more guards, closing
-- the deck-embed path from both directions —
--   §3 "nothing embeds from draft"  on kit_content: an unapproved asset cannot enter a deck.
--   §4 "an embed locks clearance"   on media_assets: clearance cannot be withdrawn out from under a
--      live embed. It REFUSES rather than cascading a delete — see the rationale in the block.
-- Both additive and idempotent like the rest; kit_content is empty in prod and no media_assets row
-- is generated-and-embedded, so both validate instantly and neither can fail on existing data. The
-- block is still the same file the PGlite suite applies, and the containment test enforces that.
--
-- Additive only. Design: docs/plans/studio-a25-a31-plan.md (§5).
--
-- ── HOW THIS REACHES PROD ────────────────────────────────────────────────────
-- Not through this file. The executor is the idempotent psql block in
-- .github/workflows/deploy.yml, same as 0022. This file records intent and is the
-- text to paste. NOTHING HERE HAS BEEN RUN.
--
-- ── Verified against the live DB before writing (read-only) ──────────────────
-- media_assets: 564 rows — origin is only 'connected' (561) and 'upload' (3);
--   approval_status is NULL on all 564; derived_from_asset_id, deleted_at and
--   deal_id are 0 non-null. content_posts / content_brands / kit_content exist
--   and are EMPTY. So every constraint below validates instantly and none of
--   them can fail on existing data.
--
-- ── Blast radius ─────────────────────────────────────────────────────────────
-- No UPDATE, no DELETE, no DROP COLUMN, no TRUNCATE, no backfill. Every existing
-- row is untouched. ADD COLUMN is nullable with no default (metadata-only, no
-- table rewrite). CREATE INDEX at 564 rows takes a sub-millisecond lock, so
-- CONCURRENTLY is not used — it would add an invalid-index failure mode for no
-- benefit.

-- ── 1. Lineage: make derived_from_asset_id a real relationship ───────────────
-- ON DELETE SET NULL, not RESTRICT (which would break the athlete-level cascade
-- on offboarding) and not CASCADE (which would let one delete take out a whole
-- lineage tree).
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_derived_from_fkey;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_derived_from_fkey
  FOREIGN KEY (derived_from_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_media_assets_derived_from
  ON media_assets (derived_from_asset_id) WHERE derived_from_asset_id IS NOT NULL;

-- ── 2. Constrain the origin vocabulary ───────────────────────────────────────
-- Documented in a comment since day one, enforced by nothing until now.
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_origin_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_origin_check
  CHECK (origin IN ('connected','discovery','upload','generated'));

-- ── 3. The job record ────────────────────────────────────────────────────────
-- NO LEASING BY DESIGN (single-runner). If Studio ever runs on more than one
-- instance, leasing must be added BEFORE that happens: two runners polling
-- status='pending' will both call the model and both bill real money.
CREATE TABLE IF NOT EXISTS generation_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id         uuid    NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  brand_id           integer          REFERENCES inbox_brands(id),

  origin             text    NOT NULL,
  mode               text    NOT NULL,
  objective          text    NOT NULL,
  deliverable        text    NOT NULL,

  brief              jsonb   NOT NULL,
  source_asset_id    uuid             REFERENCES media_assets(id),

  status             text    NOT NULL DEFAULT 'pending',
  last_error         text,

  provider           text,
  model              text,
  cost_estimated_usd numeric,
  cost_basis         text,

  created_at         timestamptz DEFAULT now(),
  started_at         timestamptz,
  completed_at       timestamptz,
  updated_at         timestamptz DEFAULT now(),

  CONSTRAINT generation_jobs_origin_check CHECK (origin IN ('system','inbound')),
  CONSTRAINT generation_jobs_mode_check   CHECK (mode   IN ('edit','generate')),
  CONSTRAINT generation_jobs_status_check CHECK (status IN ('pending','running','succeeded','failed','canceled')),
  -- The edit/generate fork, enforced by the database and not only by assembleBrief.
  CONSTRAINT generation_jobs_edit_needs_source CHECK (
    (mode = 'edit'     AND source_asset_id IS NOT NULL) OR
    (mode = 'generate' AND source_asset_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_athlete ON generation_jobs (athlete_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_status  ON generation_jobs (status, created_at)
  WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_generation_jobs_source  ON generation_jobs (source_asset_id)
  WHERE source_asset_id IS NOT NULL;

-- ── 4. Asset → the job that made it ──────────────────────────────────────────
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS generation_job_id uuid;
CREATE INDEX IF NOT EXISTS idx_media_assets_generation_job
  ON media_assets (generation_job_id) WHERE generation_job_id IS NOT NULL;

-- ── 5. Publish records: deal lookup + dedup ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_content_posts_deal
  ON content_posts (deal_id) WHERE deal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS content_posts_platform_permalink_uniq
  ON content_posts (platform, permalink) WHERE permalink IS NOT NULL;

-- ── 6. Guards Drizzle cannot express ─────────────────────────────────────────
-- Everything below is server/studio/sql/generationGuards.sql, verbatim. The PGlite
-- suite applies that same file, and generationGuards.test.ts asserts this section
-- still matches it character-for-character, so the two cannot drift.
-- >>> BEGIN generationGuards.sql
-- generationGuards.sql — the DDL Drizzle cannot express.
--
-- ONE SOURCE, TWO CONSUMERS: migrations/0027_studio_generation.sql (prod) embeds this file's
-- statements verbatim, and server/studio/approval.test.ts applies this file to PGlite. A test
-- asserts 0027 still contains it character-for-character, so the two cannot drift apart silently.

-- ── 1. media_assets.generation_job_id → generation_jobs.id ────────────────────────────────────
-- Lives here rather than in shared/schema.ts because the two tables reference each other and
-- Drizzle cannot order a cycle. ON DELETE SET NULL: deleting a job record must never delete the
-- content it produced.
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_generation_job_fkey;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_generation_job_fkey
  FOREIGN KEY (generation_job_id) REFERENCES generation_jobs(id) ON DELETE SET NULL;

-- ── 2. "Nothing publishes from draft" ─────────────────────────────────────────────────────────
-- A database guarantee, not a convention: this holds against a raw INSERT from psql, a script, or
-- code that has not been written yet. Application code refusing is the first layer; this is the one
-- that cannot be bypassed.
--
-- Scoped to origin='generated' deliberately. The 561 ingested rows carry approval_status NULL by
-- design (migration 0022: "NULL = ungated, so existing ingested IG posts are unaffected"), and a
-- publish record for one of those is legitimate. Gating them would be retroactive gating, which 0022
-- explicitly rejects.
CREATE OR REPLACE FUNCTION content_posts_require_approval() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM media_assets a
    WHERE a.id = NEW.asset_id
      AND a.origin = 'generated'
      AND a.approval_status IS DISTINCT FROM 'approved'
  ) THEN
    RAISE EXCEPTION 'asset % is generated and not approved - cannot record a publish', NEW.asset_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_content_posts_require_approval ON content_posts;
CREATE TRIGGER trg_content_posts_require_approval
  BEFORE INSERT OR UPDATE ON content_posts
  FOR EACH ROW EXECUTE FUNCTION content_posts_require_approval();

-- ── 3. "Nothing embeds from draft" ────────────────────────────────────────────────────────────
-- The same guarantee as §2, one verb over. A pitch deck is sent to a brand, so an unapproved
-- generated asset embedded in one has already reached the outside — embedding is a publish with a
-- different name, and leaving it ungated while content_posts is gated is an inconsistent safety
-- story rather than a smaller one.
--
-- Fires on UPDATE as well as INSERT so a re-embed (kit_content's unique index makes the application
-- upsert) is re-checked rather than waved through: an asset that was approved when it was first
-- embedded and has since been rejected cannot be re-embedded.
--
-- Scoped to origin='generated' for exactly the reason §2 is: ingested rows carry approval_status
-- NULL by design (migration 0022), and embedding one of those is legitimate.
CREATE OR REPLACE FUNCTION kit_content_require_approval() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM media_assets a
    WHERE a.id = NEW.asset_id
      AND a.origin = 'generated'
      AND a.approval_status IS DISTINCT FROM 'approved'
  ) THEN
    RAISE EXCEPTION 'asset % is generated and not approved - cannot embed it in a kit', NEW.asset_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kit_content_require_approval ON kit_content;
CREATE TRIGGER trg_kit_content_require_approval
  BEFORE INSERT OR UPDATE ON kit_content
  FOR EACH ROW EXECUTE FUNCTION kit_content_require_approval();

-- ── 4. "Clearance cannot be withdrawn out from under a live embed" ────────────────────────────
-- §3 stops an unapproved asset being embedded. This stops the same bad state being reached from
-- the other direction: embed while approved, then reject, and the deck goes on rendering content
-- whose clearance was withdrawn.
--
-- REFUSES, rather than cascading a DELETE, for three reasons:
--   * A cascade could only reach kit_content. The half that actually RENDERS is a gcs_path buried
--     in card_overrides.data->'images', keyed by (athlete_id, brand_id) — a brand_id this trigger
--     does not have. Deleting the record while the picture keeps rendering is the worse failure.
--   * "The row stays; content is never deleted to express a decision" (studio/approval.ts). A
--     cascade destroys the evidence the asset was embedded, and the position the athlete chose.
--   * A trigger that silently edits another table's jsonb is an invisible blast radius.
-- So withdrawal becomes explicitly ordered: un-embed, THEN reject. studio/concept.ts's
-- unembedConceptFromDeck does both writes, picture first.
--
-- Deliberately NOT extended to content_posts: a publish record is a historical fact about something
-- that already happened in the world, and rejecting content afterwards is exactly what SHOULD be
-- possible. An embed is a LIVE placement. Only the live one blocks.
CREATE OR REPLACE FUNCTION media_assets_embed_locks_approval() RETURNS trigger AS $$
BEGIN
  IF NEW.origin = 'generated'
     AND NEW.approval_status IS DISTINCT FROM 'approved'
     AND EXISTS (SELECT 1 FROM kit_content k WHERE k.asset_id = NEW.id)
  THEN
    RAISE EXCEPTION 'asset % is embedded in a pitch deck - remove it from the deck before changing its approval to %', NEW.id, coalesce(NEW.approval_status, 'ungated')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_media_assets_embed_locks_approval ON media_assets;
CREATE TRIGGER trg_media_assets_embed_locks_approval
  BEFORE UPDATE ON media_assets
  FOR EACH ROW
  -- Only when clearance itself changes. Every other UPDATE on an embedded asset is untouched.
  WHEN (OLD.approval_status IS DISTINCT FROM NEW.approval_status)
  EXECUTE FUNCTION media_assets_embed_locks_approval();
-- <<< END generationGuards.sql
