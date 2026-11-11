-- 0102_bookings_flow.sql — Bookings v2, the flow PR: the 0099 gaps the request → hold → accept flow needs.
-- Dark behind BOOKINGS_ENABLED (off) and the pilot allowlist; nothing outside server/services/bookings reads these.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy. Needs 0099 (bookings, offers).
-- (0101 belongs to another track; the two touch unrelated tables and run in name order.)
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- bookings.proposed_times          request mode: the buyer's 1–3 suggested times [{start, tz}] (jsonb array).
--                                  starts_at is set when she picks one. (Public card v3 §7, gap 1.)
-- bookings.athlete_proposed_times  her counter-offer ("propose another time"): 1–3 times the buyer picks from.
-- bookings.minor_first_name        the child's first name when a parent books for a minor (her offer allows it).
-- offers.adult_attested_at         her own "I'm 18 or older" at first publish (Stripe also requires 18+).
-- offers.venue_confirmed_at        her tick "a public place or my usual venue, not my home" (in person only).
-- uq_bookings_live_slot            WIDENED to unverified + requested: a slot is protected from the moment a buyer
--                                  starts a request (the unverified hold lapses after BOOKING_UNVERIFIED_HOLD_MINUTES),
--                                  through her answer, to the end of the booking. (Public card v3 §7, gap 2.)
-- idx_bookings_status_respond      the respond_by sweeper's lookup.
--
-- The widened index is safe on existing data: no route has ever written a bookings row (0099 shipped schema only), so
-- there can be no two live rows on one slot. Every statement re-runs as a no-op (IF NOT EXISTS, or DROP-then-ADD of a
-- named constraint / index). Names and definitions are written exactly as a shared/schema.ts push produces them.
-- No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK, never chained.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS proposed_times jsonb;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS athlete_proposed_times jsonb;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS minor_first_name text;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS adult_attested_at timestamptz;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS venue_confirmed_at timestamptz;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_proposed_times_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_proposed_times_check CHECK (proposed_times IS NULL OR (jsonb_typeof(proposed_times) = 'array' AND jsonb_array_length(proposed_times) BETWEEN 1 AND 3));
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_athlete_proposed_times_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_athlete_proposed_times_check CHECK (athlete_proposed_times IS NULL OR (jsonb_typeof(athlete_proposed_times) = 'array' AND jsonb_array_length(athlete_proposed_times) BETWEEN 1 AND 3));
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_minor_name_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_minor_name_check CHECK (minor_first_name IS NULL OR minor_attendee);

DROP INDEX IF EXISTS uq_bookings_live_slot;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_live_slot ON bookings USING btree (slot_id)
  WHERE slot_id IS NOT NULL AND status IN ('unverified','requested','accepted','confirmed','in_review','issue_reported','disputed');
CREATE INDEX IF NOT EXISTS idx_bookings_status_respond ON bookings USING btree (status, respond_by);
