-- 0096_shop_her_picks.sql — Her picks: the athlete's product shelf (docs/design/shop-her-picks.md).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- shop_items       one pick on her shelf: HER link exactly as she gave it, what the page said about it, her own
--                  line (blurb), status draft|live|hidden, her order. `source`/`category` carry no CHECK on
--                  purpose (lists that grow; the route validates). `code` is the opaque /go/<code>.
-- shop_click_days  clicks per pick per day — the whole of the analytics. No IP, user agent or referrer column.
-- shop_settings    her self-declared answers that open the shelf (18+, international student, supplements
--                  opt-in, her school's apparel sponsor). One row per athlete.
--
-- Model A only: there is deliberately no commission, payout or affiliate-account table.
--
-- Additive: three new tables. Every statement re-runs as a no-op. Names and definitions are written exactly as a
-- shared/schema.ts push produces them. No transaction control here (migrationsGuard): dry-run this file ON ITS
-- OWN in BEGIN … ROLLBACK.

CREATE TABLE IF NOT EXISTS shop_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id          uuid NOT NULL,
  code                text NOT NULL,
  url                 text NOT NULL,
  url_host            text NOT NULL,
  source              text NOT NULL,
  network_tag         text,
  title               text NOT NULL,
  image_url           text,
  price_cents         integer,
  currency            text,
  merchant            text,
  category            text,
  blurb               text,
  blurb_suggestion    text,
  discount_code       text,
  status              text DEFAULT 'draft' NOT NULL,
  position            integer DEFAULT 0 NOT NULL,
  warnings_ack_at     timestamp with time zone,
  published_at        timestamp with time zone,
  metadata_fetched_at timestamp with time zone,
  created_at          timestamp with time zone DEFAULT now() NOT NULL,
  updated_at          timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT shop_items_status_check CHECK (status IN ('draft','live','hidden'))
);

CREATE TABLE IF NOT EXISTS shop_click_days (
  item_id uuid NOT NULL,
  day     date NOT NULL,
  clicks  integer DEFAULT 0 NOT NULL,
  CONSTRAINT shop_click_days_pk PRIMARY KEY (item_id, day)
);

CREATE TABLE IF NOT EXISTS shop_settings (
  athlete_id             uuid PRIMARY KEY NOT NULL,
  adult_confirmed_at     timestamp with time zone,
  international_student  boolean,
  international_ack_at   timestamp with time zone,
  supplements_opt_in_at  timestamp with time zone,
  school_apparel_sponsor text,
  created_at             timestamp with time zone DEFAULT now() NOT NULL,
  updated_at             timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE shop_items DROP CONSTRAINT IF EXISTS shop_items_athlete_id_athletes_id_fk;
ALTER TABLE shop_items ADD CONSTRAINT shop_items_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE shop_click_days DROP CONSTRAINT IF EXISTS shop_click_days_item_id_shop_items_id_fk;
ALTER TABLE shop_click_days ADD CONSTRAINT shop_click_days_item_id_shop_items_id_fk
  FOREIGN KEY (item_id) REFERENCES public.shop_items(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE shop_settings DROP CONSTRAINT IF EXISTS shop_settings_athlete_id_athletes_id_fk;
ALTER TABLE shop_settings ADD CONSTRAINT shop_settings_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS shop_items_code_uq ON shop_items USING btree (code);
CREATE UNIQUE INDEX IF NOT EXISTS shop_items_athlete_url_uq ON shop_items USING btree (athlete_id, url);
CREATE INDEX IF NOT EXISTS idx_shop_items_athlete ON shop_items USING btree (athlete_id, position);
