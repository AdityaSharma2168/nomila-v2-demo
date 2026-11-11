-- 0044_social_substrate.sql — Phase A, Step 1a: the social intelligence data layer.
--
-- Pure DDL, idempotent, additive. Six new tables and five nullable columns on media_assets.
-- Nothing in production reads any of it; writes happen only when SOCIAL_SUBSTRATE_WRITE=true,
-- beside the existing daily snapshot, which is unchanged. The spec is Commercial Intelligence
-- Beta.1 §22.3, §26, §28.3–28.10; the approved design is the Step 1 Social Substrate proposal
-- (decisions D1–D8, 10 Sep 2026).
--
-- Conventions shared by every table here:
--   athlete_id       the domain owner (ADR-015: never an auth user, never an organization)
--   source_class     connected_verified | platform_public | web_researched | inferred | imputed
--   source_method    the exact provider path (oauth_instagram_login, meta_business_discovery, …)
--   observed_at      the provider's instant when it gives one, else the fetch instant
--   window_start/end only for windowed metrics; point-in-time counts leave both NULL
--   definition_version / calculation_version
--                    which registry entry produced the row; a change adds rows, never rewrites
-- Uniqueness includes definition_version and the window bounds (NULLS NOT DISTINCT), so the same
-- historical evidence can be re-adapted under a later definition and both interpretations coexist.

-- ── social_identities ─────────────────────────────────────────────────────────
-- One row per platform account an athlete has, is or was linked to. Keyed by the platform's own
-- stable account id; a handle change updates `handle` and appends to handle_history. A different
-- account id on the same platform is a new row and supersedes the old one, whose observations stay.
-- Identity is distinct from credential state (D5): a revoked or expired connection does not
-- change this row; freshness decides whether its older evidence is still usable.
CREATE TABLE IF NOT EXISTS social_identities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id           uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  platform             text NOT NULL,
  account_id           text NOT NULL,
  account_id_kind      text NOT NULL DEFAULT 'platform_id',   -- 'platform_id' | 'handle' (legacy discovery rows that carried no id)
  handle               text,
  canonical_url        text,
  handle_history       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ handle, seenAt }]
  source_class         text NOT NULL,
  source_method        text NOT NULL,
  confidence           numeric(3,2) NOT NULL DEFAULT 1.00,
  status               text NOT NULL DEFAULT 'active',
  connected_account_id uuid REFERENCES connected_accounts(id) ON DELETE SET NULL,
  discovered_at        timestamptz NOT NULL DEFAULT now(),
  last_verified_at     timestamptz,
  evidence             jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_identities_platform_check CHECK (platform IN ('instagram','tiktok','youtube','x')),
  CONSTRAINT social_identities_kind_check     CHECK (account_id_kind IN ('platform_id','handle')),
  CONSTRAINT social_identities_source_check   CHECK (source_class IN ('connected_verified','platform_public','web_researched','inferred','imputed')),
  CONSTRAINT social_identities_status_check   CHECK (status IN ('active','superseded','unverified','rejected')),
  CONSTRAINT social_identities_account_uq     UNIQUE (athlete_id, platform, account_id)
);
CREATE INDEX IF NOT EXISTS social_identities_athlete_platform_idx ON social_identities (athlete_id, platform, status);

-- ── social_sync_runs ──────────────────────────────────────────────────────────
-- One row per provider sync of one identity through one endpoint family — the audit unit every
-- payload and observation points back to. pagination_state holds opaque cursors only, never a
-- paging URL (Graph paging URLs embed the access token).
CREATE TABLE IF NOT EXISTS social_sync_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id           uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  identity_id          uuid REFERENCES social_identities(id) ON DELETE SET NULL,
  platform             text NOT NULL,
  provider             text NOT NULL,
  endpoint_family      text NOT NULL,
  api_version          text,
  source_class         text NOT NULL,
  trigger              text NOT NULL,
  status               text NOT NULL DEFAULT 'running',
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  pages                integer NOT NULL DEFAULT 0,
  items                integer NOT NULL DEFAULT 0,
  pagination_state     jsonb,
  error                jsonb,
  connected_account_id uuid REFERENCES connected_accounts(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_sync_runs_source_check  CHECK (source_class IN ('connected_verified','platform_public','web_researched','inferred','imputed')),
  CONSTRAINT social_sync_runs_trigger_check CHECK (trigger IN ('connect','nightly','backfill','discovery','manual','fixture')),
  CONSTRAINT social_sync_runs_status_check  CHECK (status IN ('running','ok','partial','failed'))
);
CREATE INDEX IF NOT EXISTS social_sync_runs_athlete_idx  ON social_sync_runs (athlete_id, platform, started_at DESC);
CREATE INDEX IF NOT EXISTS social_sync_runs_identity_idx ON social_sync_runs (identity_id, endpoint_family, started_at DESC);

-- ── raw_source_payloads ───────────────────────────────────────────────────────
-- The sanitized provider response envelope, page by page (D3: full envelope). A payload cannot
-- outlive its run. retained_until is set from the versioned retention parameter (D2: 180 days
-- connected, 90 public); observations and features survive its deletion.
CREATE TABLE IF NOT EXISTS raw_source_payloads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id       uuid NOT NULL REFERENCES social_sync_runs(id) ON DELETE CASCADE,
  athlete_id        uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  platform          text NOT NULL,
  provider          text NOT NULL,
  endpoint_family   text NOT NULL,
  page_index        integer NOT NULL DEFAULT 0,
  source_class      text NOT NULL,
  request           jsonb,                 -- path + allow-listed params; never a token or key
  payload           jsonb NOT NULL,        -- after the sanitizer
  payload_hash      text NOT NULL,         -- sha256 of canonical JSON
  bytes             integer,
  sanitizer_version text NOT NULL,
  fetched_at        timestamptz NOT NULL,
  retained_until    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS raw_source_payloads_athlete_idx   ON raw_source_payloads (athlete_id, platform, fetched_at DESC);
CREATE INDEX IF NOT EXISTS raw_source_payloads_run_idx       ON raw_source_payloads (sync_run_id);
CREATE INDEX IF NOT EXISTS raw_source_payloads_retention_idx ON raw_source_payloads (retained_until) WHERE retained_until IS NOT NULL;

-- ── social_metric_observations ────────────────────────────────────────────────
-- The canonical fact table (§28.4): one row per metric per entity per observation instant per
-- source per definition. entity_time and entity_format are the content's posted_at and canonical
-- format, carried here so the feature calculator can window and segment without a join to a
-- media row that may not exist yet (or any more).
CREATE TABLE IF NOT EXISTS social_metric_observations (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  athlete_id         uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  platform           text NOT NULL,
  identity_id        uuid NOT NULL REFERENCES social_identities(id) ON DELETE CASCADE,
  entity_type        text NOT NULL,
  entity_id          text NOT NULL,
  entity_time        timestamptz,
  entity_format      text,
  asset_id           uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  metric_key         text NOT NULL,
  value              numeric NOT NULL,
  unit               text NOT NULL,
  source_class       text NOT NULL,
  source_method      text NOT NULL,
  provider           text NOT NULL,
  confidence         numeric(3,2) NOT NULL DEFAULT 1.00,
  observed_at        timestamptz NOT NULL,
  window_start       timestamptz,
  window_end         timestamptz,
  definition_version text NOT NULL,
  sync_run_id        uuid REFERENCES social_sync_runs(id) ON DELETE SET NULL,
  payload_id         uuid REFERENCES raw_source_payloads(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smo_entity_check CHECK (entity_type IN ('account','content','audience')),
  CONSTRAINT smo_source_check CHECK (source_class IN ('connected_verified','platform_public','web_researched','inferred','imputed')),
  CONSTRAINT smo_identity_uq  UNIQUE NULLS NOT DISTINCT (identity_id, entity_type, entity_id, metric_key, definition_version, source_method, observed_at, window_start, window_end)
);
CREATE INDEX IF NOT EXISTS smo_identity_metric_idx ON social_metric_observations (identity_id, metric_key, observed_at DESC);
CREATE INDEX IF NOT EXISTS smo_athlete_idx         ON social_metric_observations (athlete_id, platform, entity_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS smo_asset_idx           ON social_metric_observations (asset_id) WHERE asset_id IS NOT NULL;

-- ── social_audience_distributions ─────────────────────────────────────────────
-- Full breakdowns, never only the top bucket (§26.4). `basis` says what the percentages are of;
-- followers (IG follower_demographics), viewers (YouTube viewerPercentage) and views (YouTube
-- country / traffic / device) are not comparable and are never merged.
CREATE TABLE IF NOT EXISTS social_audience_distributions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  athlete_id         uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  platform           text NOT NULL,
  identity_id        uuid NOT NULL REFERENCES social_identities(id) ON DELETE CASCADE,
  dimension          text NOT NULL,
  bucket             text NOT NULL,
  value              numeric,
  pct                numeric,
  basis              text NOT NULL,
  source_class       text NOT NULL,
  source_method      text NOT NULL,
  provider           text NOT NULL,
  confidence         numeric(3,2) NOT NULL DEFAULT 1.00,
  observed_at        timestamptz NOT NULL,
  window_start       timestamptz,
  window_end         timestamptz,
  definition_version text NOT NULL,
  sync_run_id        uuid REFERENCES social_sync_runs(id) ON DELETE SET NULL,
  payload_id         uuid REFERENCES raw_source_payloads(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sad_dimension_check CHECK (dimension IN ('country','city','age','gender','age_gender','traffic_source','device')),
  CONSTRAINT sad_basis_check     CHECK (basis IN ('followers','viewers','views')),
  CONSTRAINT sad_source_check    CHECK (source_class IN ('connected_verified','platform_public','web_researched','inferred','imputed')),
  CONSTRAINT sad_identity_uq     UNIQUE NULLS NOT DISTINCT (identity_id, dimension, bucket, basis, definition_version, source_method, observed_at, window_start, window_end)
);
CREATE INDEX IF NOT EXISTS sad_identity_dimension_idx ON social_audience_distributions (identity_id, dimension, observed_at DESC);

-- ── social_features ───────────────────────────────────────────────────────────
-- Versioned derived numbers the engines read. Computed from observations and distributions
-- only. source_class is the LOWEST authority among the inputs (a conservative summary); `inputs`
-- carries the complete authority breakdown and the observation ids, so nobody may infer that
-- every input shared the row's class. A recompute under a new calculation_version adds rows.
-- input_access_class is privacy, not authority (ADR-016): includes_athlete_private whenever ANY
-- input is connected_verified evidence, even if the lowest-authority input is public.
CREATE TABLE IF NOT EXISTS social_features (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  athlete_id          uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  platform            text,                                  -- NULL = cross-platform
  identity_id         uuid REFERENCES social_identities(id) ON DELETE CASCADE,
  feature_key         text NOT NULL,
  value               numeric,                               -- NULL when the feature is structured (value_json)
  value_json          jsonb,
  unit                text NOT NULL,
  n                   integer,
  window_days         integer NOT NULL,
  as_of               timestamptz NOT NULL,
  source_class        text NOT NULL,
  confidence          numeric(3,2) NOT NULL,
  imputed             boolean NOT NULL DEFAULT false,
  input_access_class  text NOT NULL DEFAULT 'public_only',
  calculation_version text NOT NULL,
  inputs              jsonb NOT NULL,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sf_access_check CHECK (input_access_class IN ('public_only','includes_athlete_private')),
  CONSTRAINT sf_source_check CHECK (source_class IN ('connected_verified','platform_public','web_researched','inferred','imputed')),
  CONSTRAINT sf_feature_uq   UNIQUE NULLS NOT DISTINCT (athlete_id, platform, identity_id, feature_key, window_days, as_of, calculation_version)
);
CREATE INDEX IF NOT EXISTS sf_athlete_asof_idx ON social_features (athlete_id, as_of DESC);

-- ── media_assets: the durable social content entity (D1: reuse) ────────────────
-- native          platform-native immutable fields the adapter preserves (TikTok title,
--                 video_description, duration; Instagram media_product_type, is_shared_to_feed;
--                 YouTube title, description, duration, topics) — sanitized, no signed URLs
-- content_format  canonical: post | reel | story | carousel | carousel_frame | video | short | long_form
-- native_version  the adapter version that wrote `native`
-- like_count / comments_count / insights remain DISPLAY projections; history is in observations.
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS social_identity_id uuid REFERENCES social_identities(id) ON DELETE SET NULL;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS native             jsonb;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS content_format     text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS native_version     text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS first_seen_at      timestamptz;
CREATE INDEX IF NOT EXISTS media_assets_identity_idx ON media_assets (social_identity_id) WHERE social_identity_id IS NOT NULL;
