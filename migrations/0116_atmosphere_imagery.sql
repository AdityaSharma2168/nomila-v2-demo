-- 0116_atmosphere_imagery.sql — atmosphere images (DESIGN.md §9, owner decision 10 Oct 2026: the app must not look like
-- the athlete's photo gallery). Everything not about the athlete (section headers, empty states, goal, suggestion and
-- pitch backgrounds, thin profiles) gets an atmosphere image: venues, surfaces, equipment, light and texture, never a
-- person, a logo or text. Behind ATMOSPHERE_IMAGERY, off in dev and prod (server/services/atmosphere).
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- atmosphere_images      every candidate the image check looked at, per athlete: accepted rows are our stored copy
--                        (gcs_path, under athletes/<id>/atmosphere/) with credit line, licence, source URL, query,
--                        purpose and the check's answers; rejected rows keep the reason and no copy, so a candidate is
--                        never downloaded or checked twice for that athlete.
-- atmosphere_placements  which image each (athlete, screen, slot) shows: chosen once and kept; an image at most once
--                        per screen.
-- atmosphere_spend_days  spend per athlete per UTC day (micro-dollars) and what it bought; the cost caps sum it.
--
-- Additive: three new tables, nothing existing changes. Every statement re-runs as a no-op (IF NOT EXISTS, or
-- DROP-then-ADD of a named constraint). Names and definitions are written exactly as a shared/schema.ts push produces
-- them. No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only
-- because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declarations
-- ship in ONE commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.
-- (0107–0112 belong to other tracks; these tables touch none of theirs.)

CREATE TABLE IF NOT EXISTS atmosphere_images (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id     uuid NOT NULL,
  source         text NOT NULL,
  source_id      text,
  source_url     text,
  status         text NOT NULL,
  gcs_path       text,
  content_type   text,
  width          integer,
  height         integer,
  bytes          integer,
  credit         text NOT NULL,
  licence        text NOT NULL,
  query          text NOT NULL,
  slot_type      text NOT NULL,
  purpose        text NOT NULL,
  purpose_key    text NOT NULL,
  check_result   jsonb NOT NULL,
  reject_reason  text,
  cost_micro_usd bigint DEFAULT 0 NOT NULL,
  created_at     timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS atmosphere_placements (
  athlete_id uuid NOT NULL,
  screen     text NOT NULL,
  slot_key   text NOT NULL,
  image_id   uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT atmosphere_placements_pk PRIMARY KEY (athlete_id, screen, slot_key)
);

CREATE TABLE IF NOT EXISTS atmosphere_spend_days (
  athlete_id    uuid NOT NULL,
  day           date NOT NULL,
  micro_usd     bigint DEFAULT 0 NOT NULL,
  model_calls   integer DEFAULT 0 NOT NULL,
  pixabay_calls integer DEFAULT 0 NOT NULL,
  generations   integer DEFAULT 0 NOT NULL,
  updated_at    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT atmosphere_spend_days_pk PRIMARY KEY (athlete_id, day)
);

ALTER TABLE atmosphere_images DROP CONSTRAINT IF EXISTS atmosphere_images_source_check;
ALTER TABLE atmosphere_images ADD CONSTRAINT atmosphere_images_source_check CHECK (source IN ('pixabay','generated'));
ALTER TABLE atmosphere_images DROP CONSTRAINT IF EXISTS atmosphere_images_status_check;
ALTER TABLE atmosphere_images ADD CONSTRAINT atmosphere_images_status_check CHECK (status IN ('accepted','rejected'));
ALTER TABLE atmosphere_images DROP CONSTRAINT IF EXISTS atmosphere_images_stored_check;
ALTER TABLE atmosphere_images ADD CONSTRAINT atmosphere_images_stored_check CHECK ((status = 'accepted') = (gcs_path IS NOT NULL) AND (status = 'accepted') = (reject_reason IS NULL));
ALTER TABLE atmosphere_images DROP CONSTRAINT IF EXISTS atmosphere_images_cost_check;
ALTER TABLE atmosphere_images ADD CONSTRAINT atmosphere_images_cost_check CHECK (cost_micro_usd >= 0);

ALTER TABLE atmosphere_images DROP CONSTRAINT IF EXISTS atmosphere_images_athlete_id_athletes_id_fk;
ALTER TABLE atmosphere_images ADD CONSTRAINT atmosphere_images_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE atmosphere_placements DROP CONSTRAINT IF EXISTS atmosphere_placements_athlete_id_athletes_id_fk;
ALTER TABLE atmosphere_placements ADD CONSTRAINT atmosphere_placements_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE atmosphere_placements DROP CONSTRAINT IF EXISTS atmosphere_placements_image_id_atmosphere_images_id_fk;
ALTER TABLE atmosphere_placements ADD CONSTRAINT atmosphere_placements_image_id_atmosphere_images_id_fk
  FOREIGN KEY (image_id) REFERENCES public.atmosphere_images(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE atmosphere_spend_days DROP CONSTRAINT IF EXISTS atmosphere_spend_days_athlete_id_athletes_id_fk;
ALTER TABLE atmosphere_spend_days ADD CONSTRAINT atmosphere_spend_days_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS idx_atmosphere_images_athlete_purpose ON atmosphere_images USING btree (athlete_id, purpose_key, status);
CREATE UNIQUE INDEX IF NOT EXISTS atmosphere_images_athlete_source_uq ON atmosphere_images USING btree (athlete_id, source, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS atmosphere_placements_screen_image_uq ON atmosphere_placements USING btree (athlete_id, screen, image_id);
