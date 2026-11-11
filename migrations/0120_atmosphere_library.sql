-- 0120_atmosphere_library.sql — ONE shared atmosphere library reused by every athlete (DESIGN.md §9; owner decisions
-- 10 Oct 2026: no per-athlete search, no ongoing spend, no generation, no API, no hotlinking). Individual Unsplash
-- (Unsplash License) or Pexels (Pexels License) photos are downloaded once, resized to WebP and stored in our media
-- bucket under atmosphere/shared/<sport|general|signin>/<id>.webp by scripts/fill-atmosphere-library.ts; the picker
-- chooses from them by the athlete's sport and the slot's purpose. Behind ATMOSPHERE_IMAGERY (off in dev and prod).
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- atmosphere_library             one row per stored photo, shared (no athlete column, NOT athlete data): source page,
--                                photographer (our records only; no credit is shown), licence, category, sport,
--                                purpose and descriptive tags, the stored copy, who or what checked it, and the
--                                `curated` (a person approved it) / `active` (false = retired) flags.
-- atmosphere_library_placements  which library photo each (athlete, screen, slot) shows: chosen once and kept; a photo
--                                at most once per screen. Athlete data (in the deletion / export manifest).
--
-- Additive: two new tables; nothing existing changes. 0116's per-athlete tables stay (empty; superseded). Every statement
-- re-runs as a no-op (IF NOT EXISTS, or DROP-then-ADD of a named constraint). Names and definitions are written exactly
-- as a shared/schema.ts push produces them. No transaction control here (migrationsGuard): dry-run this file ON ITS OWN
-- in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and
-- the shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy. Nothing here names an athlete,
-- sport, school or brand.

CREATE TABLE IF NOT EXISTS atmosphere_library (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  source           text NOT NULL,
  source_id        text NOT NULL,
  source_url       text NOT NULL,
  photographer     text,
  photographer_url text,
  licence          text NOT NULL,
  category         text NOT NULL,
  sport            text,
  purposes         text[] DEFAULT '{}'::text[] NOT NULL,
  tags             text[] DEFAULT '{}'::text[] NOT NULL,
  gcs_path         text NOT NULL,
  content_type     text NOT NULL,
  width            integer NOT NULL,
  height           integer NOT NULL,
  bytes            integer NOT NULL,
  check_result     jsonb NOT NULL,
  curated          boolean DEFAULT false NOT NULL,
  active           boolean DEFAULT true NOT NULL,
  created_at       timestamp with time zone DEFAULT now() NOT NULL,
  updated_at       timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS atmosphere_library_placements (
  athlete_id uuid NOT NULL,
  screen     text NOT NULL,
  slot_key   text NOT NULL,
  library_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT atmosphere_library_placements_pk PRIMARY KEY (athlete_id, screen, slot_key)
);

-- Widened to also allow 'pexels' (owner decision 10 Oct 2026): db-migrate.sh re-runs every file on every deploy, so a
-- narrower list here than shared/schema.ts would drop and re-add this constraint against existing Pexels rows and
-- fail every deploy (the same shape as the 7 Sep incident). Keep this list in sync with shared/schema.ts.
ALTER TABLE atmosphere_library DROP CONSTRAINT IF EXISTS atmosphere_library_source_check;
ALTER TABLE atmosphere_library ADD CONSTRAINT atmosphere_library_source_check CHECK (source IN ('unsplash','pexels'));
ALTER TABLE atmosphere_library DROP CONSTRAINT IF EXISTS atmosphere_library_category_check;
ALTER TABLE atmosphere_library ADD CONSTRAINT atmosphere_library_category_check CHECK (category IN ('sport','general','signin'));
ALTER TABLE atmosphere_library DROP CONSTRAINT IF EXISTS atmosphere_library_sport_check;
ALTER TABLE atmosphere_library ADD CONSTRAINT atmosphere_library_sport_check CHECK ((category = 'sport') = (sport IS NOT NULL));

ALTER TABLE atmosphere_library_placements DROP CONSTRAINT IF EXISTS atmosphere_library_placements_athlete_id_athletes_id_fk;
ALTER TABLE atmosphere_library_placements ADD CONSTRAINT atmosphere_library_placements_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE atmosphere_library_placements DROP CONSTRAINT IF EXISTS atmosphere_library_placements_library_fk;
ALTER TABLE atmosphere_library_placements ADD CONSTRAINT atmosphere_library_placements_library_fk
  FOREIGN KEY (library_id) REFERENCES public.atmosphere_library(id) ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS atmosphere_library_source_uq ON atmosphere_library USING btree (source, source_id);
CREATE INDEX IF NOT EXISTS idx_atmosphere_library_pool ON atmosphere_library USING btree (category, sport, active);
CREATE UNIQUE INDEX IF NOT EXISTS atmosphere_library_placements_screen_image_uq ON atmosphere_library_placements USING btree (athlete_id, screen, library_id);
