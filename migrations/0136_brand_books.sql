-- 0136_brand_books.sql — the athlete's brand book (BRAND_BOOK_V1, 20 Oct 2026): ten pages written to her as "you",
-- built from her current memory by server/services/brandBook. One row per athlete; a regenerate bumps `version`.
--
-- Additive: one new table, nothing existing changes. Idempotent (IF NOT EXISTS, and each constraint dropped-if-exists then
-- added), safe to re-run, which scripts/db-migrate.sh does on every deploy. No transaction control here (migrationsGuard):
-- dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names it in the step-3
-- list; this file, that line and the shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
-- Numbered 0136: 0134 is taken by an open PR. Nothing here names an athlete, sport, school or brand.

CREATE TABLE IF NOT EXISTS brand_books (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id   uuid NOT NULL,
  version      integer DEFAULT 0 NOT NULL,
  status       text DEFAULT 'building' NOT NULL,
  data         jsonb,
  reel         jsonb,
  error        text,
  generated_at timestamp with time zone,
  updated_at   timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE brand_books DROP CONSTRAINT IF EXISTS brand_books_status_check;
ALTER TABLE brand_books ADD CONSTRAINT brand_books_status_check CHECK (status IN ('building','ready','failed'));

ALTER TABLE brand_books DROP CONSTRAINT IF EXISTS brand_books_athlete_id_athletes_id_fk;
ALTER TABLE brand_books ADD CONSTRAINT brand_books_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS brand_books_athlete_uniq ON brand_books USING btree (athlete_id);
