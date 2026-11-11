-- 0075_outcome_observation_links.sql — the two observation dependencies of the Measure → Learn frontier
-- (campaign-lifecycle-close-and-measure-checkpoint.md §7 M1 and M4).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- published_asset_identities — the missing durable join between a Studio-published asset and the platform identity
--   that social_metric_observations are keyed by. One row per (asset, platform) publication, recorded at publish time
--   from the platform's OWN media id. `source` says how the identity was established, so a weaker association can
--   never be mistaken for the authoritative one. NO metric value is copied here and none ever will be:
--   social_metric_observations stays authoritative and is read through `platform_media_id`.
--   Deliberately NOT written into media_assets.source_media_id — that column belongs to ingest, and a generated asset
--   carrying one would read as a connected post.
-- campaign_deliverables — three nullable provenance columns so an external confirmation keeps who confirmed it, when,
--   and what it points at. An external confirmation IS an outcome observation; it needed provenance to be one.

CREATE TABLE IF NOT EXISTS published_asset_identities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id         uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  asset_id           uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  platform           text NOT NULL,
  /** The platform's own id for the published post — what observations are keyed by. NULL only for a weaker source. */
  platform_media_id  text,
  /** Canonical permalink, kept for audit; only an identity source when the platform id is unavailable AND unique. */
  permalink          text,
  publish_job_id     uuid REFERENCES studio_publish_jobs(id) ON DELETE SET NULL,
  source             text NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT published_asset_identities_source_check CHECK (source IN ('platform_media_id', 'provider_mapping', 'permalink')),
  CONSTRAINT published_asset_identities_has_identity CHECK (platform_media_id IS NOT NULL OR permalink IS NOT NULL)
);
-- one asset is published to a platform once; a re-publish updates the identity rather than forking it
CREATE UNIQUE INDEX IF NOT EXISTS published_asset_identities_asset_platform ON published_asset_identities (asset_id, platform);
-- a platform id belongs to exactly one asset
CREATE UNIQUE INDEX IF NOT EXISTS published_asset_identities_platform_media ON published_asset_identities (platform, platform_media_id) WHERE platform_media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_published_asset_identities_athlete ON published_asset_identities (athlete_id, recorded_at DESC);

ALTER TABLE campaign_deliverables ADD COLUMN IF NOT EXISTS confirmed_by text;
ALTER TABLE campaign_deliverables ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE campaign_deliverables ADD COLUMN IF NOT EXISTS confirmation_ref text;
