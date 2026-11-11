-- 0154_sessions_safety.sql — Bookings v2 sessions safety (owner-approved, Nov 2026).
--
--   fan_blocks                  the fans SHE blocked: one row per person, keyed by keyed hashes of their email (and phone
--                               when known), never the raw value. A live row (removed_at NULL) stops that person
--                               booking or requesting her, being invited as a friend to her sessions, and getting a join
--                               token for her calls. Not session-specific (source booking | guest | live), so the later
--                               Live feature reuses it. booking_id is history only (ON DELETE SET NULL, so the sweeper's
--                               purge of never-verified requests is never blocked by it). Platform bans stay in
--                               safety_blocks.
--   offers.approve_each_spot    open groups only: her "Approve each spot" (default false = today's auto-confirm).
--   bookings.approve_each_spot  the offer's setting snapshotted when the spot was taken.
--
-- Additive (expand): two boolean columns with a constant default (no table rewrite on Postgres 11+) and one new table.
-- Idempotent (IF NOT EXISTS / guarded DO block), safe to re-run, which scripts/db-migrate.sh does on every deploy. No
-- transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because
-- scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in ONE
-- commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS approve_each_spot boolean DEFAULT false NOT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS approve_each_spot boolean DEFAULT false NOT NULL;

CREATE TABLE IF NOT EXISTS fan_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id  uuid NOT NULL CONSTRAINT fan_blocks_athlete_id_athletes_id_fk REFERENCES athletes(id),
  email_hash  text NOT NULL,
  phone_hash  text,
  first_name  text,
  reason      text,
  source      text DEFAULT 'booking' NOT NULL,
  booking_id  uuid CONSTRAINT fan_blocks_booking_id_bookings_id_fk REFERENCES bookings(id) ON DELETE SET NULL,
  created_at  timestamp with time zone DEFAULT now() NOT NULL,
  removed_at  timestamp with time zone
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fan_blocks_source_check') THEN
    ALTER TABLE fan_blocks ADD CONSTRAINT fan_blocks_source_check CHECK (source IN ('booking','guest','live'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fan_blocks_athlete ON fan_blocks USING btree (athlete_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fan_blocks_live_email ON fan_blocks USING btree (athlete_id, email_hash) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fan_blocks_live_phone ON fan_blocks USING btree (athlete_id, phone_hash) WHERE phone_hash IS NOT NULL AND removed_at IS NULL;
