-- 0121_public_page_stats.sql — the Front Door page's own counts (the athlete's metrics rail on /p/:handle: views · likes ·
-- requests · bookings · shop, last 30 days). Requests, bookings and shop clicks already have their tables
-- (partner_requests, bookings, shop_click_days); this adds the two that did not exist.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- public_page_view_days  page views per athlete per UTC day: one integer, no visitor data at all.
-- public_page_likes      one like per visitor per page: visitor_hash = HMAC(server secret, athlete id ‖ the visitor's own
--                        random token). No IP, user agent, cookie or account is stored; the hash cannot be linked to a
--                        person or to a like on another athlete's page. Taking a like back deletes the row.
--
-- Additive: two new tables, nothing existing changes. Every statement re-runs as a no-op (IF NOT EXISTS, or
-- DROP-then-ADD of a named constraint). Names and definitions are written exactly as a shared/schema.ts push produces
-- them. No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only
-- because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declarations
-- ship in ONE commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.
-- (0120 belongs to the atmosphere shared-library track; these tables touch none of its.)

CREATE TABLE IF NOT EXISTS public_page_view_days (
  athlete_id uuid NOT NULL,
  day        date NOT NULL,
  views      integer DEFAULT 0 NOT NULL,
  CONSTRAINT public_page_view_days_pk PRIMARY KEY (athlete_id, day)
);

CREATE TABLE IF NOT EXISTS public_page_likes (
  athlete_id   uuid NOT NULL,
  visitor_hash text NOT NULL,
  created_at   timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT public_page_likes_pk PRIMARY KEY (athlete_id, visitor_hash)
);

ALTER TABLE public_page_view_days DROP CONSTRAINT IF EXISTS public_page_view_days_views_check;
ALTER TABLE public_page_view_days ADD CONSTRAINT public_page_view_days_views_check CHECK (views >= 0);

ALTER TABLE public_page_view_days DROP CONSTRAINT IF EXISTS public_page_view_days_athlete_id_athletes_id_fk;
ALTER TABLE public_page_view_days ADD CONSTRAINT public_page_view_days_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE public_page_likes DROP CONSTRAINT IF EXISTS public_page_likes_athlete_id_athletes_id_fk;
ALTER TABLE public_page_likes ADD CONSTRAINT public_page_likes_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS idx_public_page_likes_athlete_created ON public_page_likes USING btree (athlete_id, created_at);
