-- 0130_push_notifications.sql — phone notifications (design "Goals tab post details + plan ready", PR D; owner 12 Oct
-- 2026: build push now). Sent through Expo's push service (server/services/push), behind PUSH_NOTIFICATIONS.
--
-- push_devices      one row per phone: the Expo push token her app registered on sign-in, which athlete it belongs to,
--                   the platform and the phone's time zone (quiet hours are read in it). A token is unique: the same
--                   phone signing in as someone else moves to them. Removed on sign-out, when Expo says the token is
--                   gone, and with the account (athleteDataManifest; ON DELETE CASCADE as a backstop).
-- push_preferences  her choices, one row per athlete, absent = the defaults: on, every kind on, quiet hours 22:00–08:00,
--                   brand names hidden on the lock screen (show_brand_names off).
-- push_sends        one row per notification Nomila decided to send: what kind, its dedupe key (a plan run, a message,
--                   an approval item — so one event is never pushed twice), whether it went out quietly (quiet hours),
--                   how many phones took it, Expo's error code when one failed, the attempt (one retry after a failed
--                   send), Expo's ticket ids until the receipts cron has read them. No message text is stored here.
--
-- Pure DDL, additive only: three new tables and their indexes; nothing existing is touched (notification_log and its
-- notif_type_check are left alone: #862 rewrites that check, and two DROP/ADD pairs on one constraint is the race that
-- broke deploys before). Idempotent (IF NOT EXISTS throughout), safe to re-run, which scripts/db-migrate.sh does on every
-- deploy. No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only
-- because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declarations
-- ship in ONE commit or the drift gate reds the deploy. (0126–0129 are taken by open PRs #860–#862 and #946.) Nothing
-- here names an athlete, sport, school or brand.

CREATE TABLE IF NOT EXISTS push_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  token        text NOT NULL,
  platform     text NOT NULL,
  time_zone    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS push_devices_token ON push_devices USING btree (token);
CREATE INDEX IF NOT EXISTS idx_push_devices_athlete ON push_devices USING btree (athlete_id);

CREATE TABLE IF NOT EXISTS push_preferences (
  athlete_id   uuid PRIMARY KEY REFERENCES athletes(id) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT true,
  plan_ready   boolean NOT NULL DEFAULT true,
  brand_reply  boolean NOT NULL DEFAULT true,
  waiting      boolean NOT NULL DEFAULT true,
  quiet_hours  boolean NOT NULL DEFAULT true,
  quiet_start  smallint NOT NULL DEFAULT 1320,
  quiet_end    smallint NOT NULL DEFAULT 480,
  show_brand_names boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_sends (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  dedupe_key  text NOT NULL,
  quiet       boolean NOT NULL DEFAULT false,
  devices     integer NOT NULL DEFAULT 0,
  error       text,
  attempts    smallint NOT NULL DEFAULT 1,
  tickets     jsonb,
  receipts_checked_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS push_sends_dedupe ON push_sends USING btree (athlete_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_push_sends_athlete ON push_sends USING btree (athlete_id, created_at);

-- Belt and braces: the columns added to these tables while 0130 was in review, for a database that somehow holds an
-- earlier draft of them (0130 has never been applied anywhere; on a fresh database these are no-ops).
ALTER TABLE push_preferences ADD COLUMN IF NOT EXISTS show_brand_names boolean NOT NULL DEFAULT false;
ALTER TABLE push_sends ADD COLUMN IF NOT EXISTS attempts smallint NOT NULL DEFAULT 1;
ALTER TABLE push_sends ADD COLUMN IF NOT EXISTS tickets jsonb;
ALTER TABLE push_sends ADD COLUMN IF NOT EXISTS receipts_checked_at timestamptz;
