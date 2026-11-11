-- 0060_studio_brand_profiles.sql — her brand profiles, and the reference analyses under them
-- (Studio PR 3; spec docs/specs/creative-architecture.md §5–§7).
--
-- A file is only ever applied because scripts/db-migrate.sh names it in the step-3 list — there is
-- no glob — so this file, that line, and the shared/schema.ts declarations ship in ONE commit, or
-- the HARD drift gate (step 5, server/scripts/checkSchemaDrift.ts) reds the deploy that merged half
-- of them.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────
--
-- TWO new tables and nothing else. No ALTER of an existing table, no DROP, no UPDATE, no data
-- movement, no backfill. Nothing on main reads or writes either table, so the pre-0060 image is
-- completely unaffected by their existence and the rollback story is "do nothing".
--
--   studio_brand_profiles       one row per brand SHE keeps a profile for
--   studio_reference_analyses   one row per reference decomposed (spec §7): one image of hers, or
--                               one pasted brief. Immutable — a re-analysis is a new row.
--
-- A "reference set" is not a table: it is the analyses that share a brand_profile_id.
-- The spec's versioned CreativeSpec (§5) is NOT here. It lands with the planner wiring that first
-- writes it, so its shape is tested against a real writer.
--
-- ── TENANCY IS PER ATHLETE, AND THE DATABASE HOLDS THE LINE ─────────────────────────────────────
--
-- inbox_brands is GLOBAL. A profile built from one athlete's screenshots is her material; keyed by
-- brand alone, her uploads would steer every other athlete's generations for that brand. So both
-- tables carry athlete_id NOT NULL, and an analysis can only hang under a profile OF THE SAME
-- ATHLETE: the profile FK is composite, (brand_profile_id, athlete_id) → (id, athlete_id), backed
-- by the UNIQUE (id, athlete_id) on the profile table. Code checks this too; the FK is the part a
-- bug in code cannot get past.
--
-- ── DELETION ────────────────────────────────────────────────────────────────────────────────────
--
--   athlete deleted        → both tables CASCADE.
--   profile deleted        → its analyses CASCADE. The set belongs to the profile.
--   brand row deleted      → brand_id SET NULL. Her profile, and its name, outlive a catalog merge.
--   source image deleted   → the analysis CASCADES. It is derived from her photo; when she deletes
--                            the photo, what we read out of it goes too.
--
-- ── THE ONE CHECK, AND THE CHECKS THAT ARE MISSING ON PURPOSE ───────────────────────────────────
--
-- `studio_reference_analyses_one_source_check`: exactly one of (source_asset_id, source_text). A
-- future URL input fetches to bytes and stores an ASSET, so it does not widen this.
--
-- NO CHECK on source_kind or role. Both vocabularies will grow (url, video; the §6 roles), and
-- widening a CHECK is the DROP + ADD pair 0056 documents as two production outages. The closed
-- lists live in server/studio/reference/.
--
-- Every constraint is INLINE in its CREATE TABLE, so it is created with the table or not at all.
-- db-migrate.sh applies each file with `psql -f` and NO --single-transaction, so every statement
-- autocommits alone. server/studio/reference/brandProfiles.migration.test.ts reproduces that.
--
-- ── SPEND ───────────────────────────────────────────────────────────────────────────────────────
--
-- An analysis records what its one model call was QUOTED (cost_estimated_usd, cost_basis
-- 'estimated'). studio/jobs.ts spentTodayUsd sums generation_jobs only, so nothing here moves the
-- day cap. That is deliberate, and matches the interpreter's and creative QA's vision calls.

CREATE TABLE IF NOT EXISTS studio_brand_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id  uuid NOT NULL,
  -- The catalog brand, when there is one. Nullable: "Adidas-style" names a brand we may hold no
  -- row for, and a catalog merge must not take her profile with it.
  brand_id    integer,
  name        text NOT NULL,
  -- Spec §5 brand.brand_attributes: short words ("premium", "athletic"). A JSON array of strings.
  attributes  jsonb DEFAULT '[]'::jsonb NOT NULL,
  created_at  timestamptz DEFAULT now() NOT NULL,
  updated_at  timestamptz DEFAULT now() NOT NULL,

  CONSTRAINT studio_brand_profiles_athlete_id_athletes_id_fk
    FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE,
  CONSTRAINT studio_brand_profiles_brand_id_inbox_brands_id_fk
    FOREIGN KEY (brand_id) REFERENCES inbox_brands(id) ON DELETE SET NULL,
  -- The target of the analyses' composite FK. id is already unique; this pair is what lets the
  -- database refuse an analysis filed under ANOTHER athlete's profile.
  CONSTRAINT studio_brand_profiles_id_athlete_unique UNIQUE (id, athlete_id)
);

-- Tenancy first: every read is "her profiles, newest first".
CREATE INDEX IF NOT EXISTS idx_studio_brand_profiles_athlete
  ON studio_brand_profiles (athlete_id, created_at DESC NULLS LAST);

-- One profile per catalog brand, per athlete. A brand-less profile is not held to it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_brand_profiles_brand
  ON studio_brand_profiles (athlete_id, brand_id) WHERE brand_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS studio_reference_analyses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id          uuid NOT NULL,
  -- Nullable: "something like this" can be decomposed without filing it under a brand.
  brand_profile_id    uuid,

  -- 'image' | 'brief' today (closed list in code). No CHECK — see the header.
  source_kind         text NOT NULL,
  -- Exactly one of these two. An ID, never a path: resolved against athlete_id when it is read.
  source_asset_id     uuid,
  source_text         text,

  -- Spec §6: 'style_reference' | 'composition_reference' today. No CHECK — see the header.
  role                text NOT NULL,
  -- The §7 decomposition, as server/studio/reference/schema.ts validated it.
  decomposition       jsonb NOT NULL,

  prompt_version      text NOT NULL,
  model               text NOT NULL,
  -- What the one call was quoted. Null only when the provider reported no usage.
  cost_estimated_usd  numeric,
  cost_basis          text,

  created_at          timestamptz DEFAULT now() NOT NULL,

  CONSTRAINT studio_reference_analyses_athlete_id_athletes_id_fk
    FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE,
  -- Named by hand: the generated name would be long and says less.
  CONSTRAINT studio_reference_analyses_profile_fk
    FOREIGN KEY (brand_profile_id, athlete_id)
    REFERENCES studio_brand_profiles(id, athlete_id) ON DELETE CASCADE,
  CONSTRAINT studio_reference_analyses_source_asset_id_media_assets_id_fk
    FOREIGN KEY (source_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE,
  CONSTRAINT studio_reference_analyses_one_source_check
    CHECK (num_nonnulls(source_asset_id, source_text) = 1)
);

-- Tenancy first: "her analyses, newest first".
CREATE INDEX IF NOT EXISTS idx_studio_reference_analyses_athlete
  ON studio_reference_analyses (athlete_id, created_at DESC NULLS LAST);

-- A profile's set, and the index the profile cascade walks.
CREATE INDEX IF NOT EXISTS idx_studio_reference_analyses_profile
  ON studio_reference_analyses (brand_profile_id);
