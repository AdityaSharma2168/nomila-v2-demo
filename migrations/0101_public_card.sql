-- 0101_public_card.sql — the public Nomi Card, PR 1: the snapshot schema (design-public-card-v3 §10–§11, §15 PR 1).
-- Schema only; the service that writes these tables is dark behind PUBLIC_CARD (off in dev and prod), and no public
-- route exists yet.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- public_cards                  one row per athlete: her handle (+ when she last changed it: once per 30 days),
--                               publish state (draft | published | unpublished), the version the URL serves, the
--                               highest version ever written (versions never repeat), her draft decisions (never
--                               public), her door switches (partner · book · shop · create · ask_mila), show_mia
--                               (default OFF) and indexable (default OFF: noindex).
-- public_card_snapshots         immutable, versioned copies of exactly what is public (content) plus the manifest of
--                               where every item came from (sources; never served) and the media map (opaque media key
--                               → stored object, read one entry at a time by the media proxy). kind full | numbers_only
--                               | removal.
-- public_card_handle_redirects  her old handles: each redirects to her current one for 90 days and is closed to
--                               everyone else until it expires.
--
-- Additive: three new tables, nothing existing changes. Every statement re-runs as a no-op (IF NOT EXISTS, or
-- DROP-then-ADD of a named constraint). Names and definitions are written exactly as a shared/schema.ts push produces
-- them. No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

CREATE TABLE IF NOT EXISTS public_cards (
  athlete_id        uuid PRIMARY KEY NOT NULL,
  handle            text,
  handle_changed_at timestamp with time zone,
  status            text DEFAULT 'draft' NOT NULL,
  published_version integer,
  last_version      integer DEFAULT 0 NOT NULL,
  draft             jsonb DEFAULT '{}'::jsonb NOT NULL,
  door_partner      boolean DEFAULT true NOT NULL,
  door_book         boolean DEFAULT false NOT NULL,
  door_shop         boolean DEFAULT false NOT NULL,
  door_create       boolean DEFAULT true NOT NULL,
  door_ask_mila     boolean DEFAULT true NOT NULL,
  show_mia          boolean DEFAULT false NOT NULL,
  indexable         boolean DEFAULT false NOT NULL,
  published_at      timestamp with time zone,
  unpublished_at    timestamp with time zone,
  created_at        timestamp with time zone DEFAULT now() NOT NULL,
  updated_at        timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT public_cards_handle_unique UNIQUE (handle),
  CONSTRAINT public_cards_status_check CHECK (status IN ('draft','published','unpublished')),
  CONSTRAINT public_cards_handle_check CHECK (handle IS NULL OR handle ~ '^[a-z0-9](-?[a-z0-9])+$' AND length(handle) BETWEEN 3 AND 30),
  CONSTRAINT public_cards_published_check CHECK ((status = 'published') = (published_version IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public_card_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id          uuid NOT NULL,
  version             integer NOT NULL,
  kind                text DEFAULT 'full' NOT NULL,
  content             jsonb NOT NULL,
  sources             jsonb NOT NULL,
  media               jsonb DEFAULT '{}'::jsonb NOT NULL,
  content_sha256      text NOT NULL,
  note                text,
  approved_by_user_id uuid,
  published_at        timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT public_card_snapshots_kind_check CHECK (kind IN ('full','numbers_only','removal')),
  CONSTRAINT public_card_snapshots_version_check CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS public_card_handle_redirects (
  handle     text PRIMARY KEY NOT NULL,
  athlete_id uuid NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public_cards DROP CONSTRAINT IF EXISTS public_cards_athlete_id_athletes_id_fk;
ALTER TABLE public_cards ADD CONSTRAINT public_cards_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE public_card_snapshots DROP CONSTRAINT IF EXISTS public_card_snapshots_athlete_id_athletes_id_fk;
ALTER TABLE public_card_snapshots ADD CONSTRAINT public_card_snapshots_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE public_card_snapshots DROP CONSTRAINT IF EXISTS public_card_snapshots_approved_by_user_id_users_id_fk;
ALTER TABLE public_card_snapshots ADD CONSTRAINT public_card_snapshots_approved_by_user_id_users_id_fk
  FOREIGN KEY (approved_by_user_id) REFERENCES public.users(id) ON DELETE set null ON UPDATE no action;

ALTER TABLE public_card_handle_redirects DROP CONSTRAINT IF EXISTS public_card_handle_redirects_athlete_id_athletes_id_fk;
ALTER TABLE public_card_handle_redirects ADD CONSTRAINT public_card_handle_redirects_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS public_card_snapshots_athlete_version_uq ON public_card_snapshots USING btree (athlete_id, version);
CREATE INDEX IF NOT EXISTS idx_public_card_handle_redirects_athlete ON public_card_handle_redirects USING btree (athlete_id);
