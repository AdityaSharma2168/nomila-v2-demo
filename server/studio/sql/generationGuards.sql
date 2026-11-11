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
