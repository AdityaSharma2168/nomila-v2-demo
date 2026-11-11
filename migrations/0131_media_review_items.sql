-- 0131_media_review_items.sql — the camera-roll intake's scored previews (design "Media Intake Plan", 12 Oct 2026, option
-- c), behind CAMERA_ROLL_INTAKE.
--
-- One row per small preview the phone sent for scoring in a review session: what the content check, the tagger, the
-- embedding and the "is it her" check said about it. Two readers:
--   • IMPORT. When she ticks an item and taps Import, its row is what the imported photo carries over (tags + embedding)
--     instead of being tagged and embedded a second time — and it is the SERVER's own record, never anything the phone
--     sends back. Then the row is scrubbed: tags, embedding, likeness and moderation set NULL (scrubbed_at), so nothing
--     about the photos she did not pick stays behind.
--   • THE DAILY CAP. Rows made today per athlete are the preview count the review is capped on (scrubbed rows still
--     count).
-- Rows are deleted two days after they are made (the review route purges hers on every call; the media-enrich cron
-- purges everyone's), matching the previews themselves (1-day bucket lifecycle on `.review.jpg`). Nothing full-size is
-- here: a preview's description, never the photo.
--
-- Additive: one new table, its constraints and indexes; nothing existing changes. Idempotent (IF NOT EXISTS, or
-- DROP-then-ADD of a named constraint) — safe to re-run, which scripts/db-migrate.sh does on every deploy. Names and
-- definitions are written exactly as a shared/schema.ts push produces them. No transaction control here
-- (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names
-- it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in ONE commit or the drift gate
-- reds the deploy. Numbered 0131 because 0130 is taken by an open PR (#954, push notifications). Nothing here names an
-- athlete, sport, school or brand.

CREATE TABLE IF NOT EXISTS media_review_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id  uuid NOT NULL,
  session_id  text NOT NULL,
  item_id     text NOT NULL,
  kind        text NOT NULL,
  tags        jsonb,
  embedding   jsonb,
  likeness    double precision,
  moderation  jsonb,
  fit         double precision,
  created_at  timestamp with time zone DEFAULT now() NOT NULL,
  scrubbed_at timestamp with time zone
);

ALTER TABLE media_review_items DROP CONSTRAINT IF EXISTS media_review_items_kind_check;
ALTER TABLE media_review_items ADD CONSTRAINT media_review_items_kind_check CHECK (kind IN ('photo','video'));

ALTER TABLE media_review_items DROP CONSTRAINT IF EXISTS media_review_items_athlete_id_athletes_id_fk;
ALTER TABLE media_review_items ADD CONSTRAINT media_review_items_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_review_items_item ON media_review_items USING btree (athlete_id, session_id, item_id);
CREATE INDEX IF NOT EXISTS idx_media_review_items_athlete_created ON media_review_items USING btree (athlete_id, created_at);
CREATE INDEX IF NOT EXISTS idx_media_review_items_created ON media_review_items USING btree (created_at);
