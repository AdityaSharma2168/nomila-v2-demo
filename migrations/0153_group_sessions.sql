-- 0153_group_sessions.sql — Bookings v2 group sessions (owner request, Nov 2026): a session can be for one person (as
-- today), a PRIVATE group (one fan books the whole time for themselves + friends) or an OPEN group (strangers each book
-- and pay for their own spot until it's full).
--
--   offers.audience          one | private_group | open_group (default 'one': every existing offer stays 1:1)
--   offers.max_people        1 for one; 2..20 for a group. An open group always uses set times (scheduling_mode 'slots').
--   bookings.audience        the offer's audience, snapshotted at booking time
--   bookings.party_size      how many people this booking covers (1 unless private_group)
--   bookings.unit_price_cents her per-person price at booking time; price_cents (what she receives) = unit × party.
--                            NULL on pre-0153 rows (party 1, unit = price_cents) — nothing is backfilled.
--   uq_bookings_live_slot    REBUILT to exclude open groups: one live booking per slot for one / private_group; an open
--                            group's capacity (sum of live party sizes ≤ max_people) is enforced in code under a row lock
--                            on the slot (server/services/bookings/buyer.ts). Rebuilt only while its definition does not
--                            yet name open_group, inside one DO block, so a re-run never drops it.
--   idx_bookings_slot        a slot's live spots, now that the unique index no longer covers every slot
--   booking_guests           the friends a private-group booker invites (each with their own signed call link, minted
--                            from the row id and never stored); revoked_at ends a link
--
-- Additive (expand): new columns with constant defaults (no table rewrite on Postgres 11+), new checks that every
-- existing row already satisfies (audience 'one', max_people 1, party_size 1, unit price NULL), one new table, and the
-- slot index rebuilt with one more condition. Idempotent (IF NOT EXISTS / guarded DO blocks), safe to re-run, which
-- scripts/db-migrate.sh does on every deploy. No transaction control here (migrationsGuard): dry-run this file ON ITS OWN
-- in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and
-- the shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy. Nothing here names an athlete,
-- sport, school or brand.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS audience text DEFAULT 'one' NOT NULL;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS max_people integer DEFAULT 1 NOT NULL;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS audience text DEFAULT 'one' NOT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS party_size integer DEFAULT 1 NOT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS unit_price_cents integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offers_audience_check') THEN
    ALTER TABLE offers ADD CONSTRAINT offers_audience_check CHECK (audience IN ('one','private_group','open_group'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offers_max_people_check') THEN
    ALTER TABLE offers ADD CONSTRAINT offers_max_people_check
      CHECK ((audience = 'one' AND max_people = 1) OR (audience <> 'one' AND max_people BETWEEN 2 AND 20));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offers_open_group_slots_check') THEN
    ALTER TABLE offers ADD CONSTRAINT offers_open_group_slots_check CHECK (audience <> 'open_group' OR scheduling_mode = 'slots');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_audience_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_audience_check CHECK (audience IN ('one','private_group','open_group'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_party_size_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_party_size_check
      CHECK (party_size BETWEEN 1 AND 20 AND (audience = 'private_group' OR party_size = 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_unit_price_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_unit_price_check
      CHECK (unit_price_cents IS NULL OR (unit_price_cents > 0 AND price_cents = unit_price_cents * party_size));
  END IF;
END $$;

-- One live booking per slot, except open groups (many fans per slot; capacity is enforced in code).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_bookings_live_slot' AND indexdef LIKE '%open_group%') THEN
    DROP INDEX IF EXISTS uq_bookings_live_slot;
    CREATE UNIQUE INDEX uq_bookings_live_slot ON bookings USING btree (slot_id)
      WHERE slot_id IS NOT NULL
        AND status IN ('unverified','requested','accepted','confirmed','in_review','issue_reported','disputed')
        AND audience <> 'open_group';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings USING btree (slot_id) WHERE slot_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS booking_guests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  booking_id  uuid NOT NULL CONSTRAINT booking_guests_booking_id_bookings_id_fk REFERENCES bookings(id),
  name        text,
  email       text NOT NULL,
  email_hash  text NOT NULL,
  invited_at  timestamp with time zone,
  revoked_at  timestamp with time zone,
  created_at  timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_booking_guests_booking ON booking_guests USING btree (booking_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_guests_live_email ON booking_guests USING btree (booking_id, email_hash) WHERE revoked_at IS NULL;
