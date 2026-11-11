-- 0155_offer_availability.sql — Bookings v2 flexible hours (owner request, Nov 2026): an athlete picks whatever hours she
-- wants, different on different days (e.g. Mon 6:00–9:00 pm, Tue 7:00–8:15 am and 5:30–8:00 pm), instead of fixed
-- presets. The app turns her hours into open times (offer_slots, unchanged); this column keeps the hours themselves so
-- the editor can reopen them and "Edit hours" knows what she chose.
--
--   offers.availability   jsonb, nullable: { version: 1, preset, blocks: [{ day 0–6, start, end }] } — minutes after
--                         midnight in offers.time_zone, 15-minute steps; shape validated in
--                         server/services/bookings/availability.ts. NULL = request mode or an offer from before 0155.
--   offers_availability_check  NULL or a JSON object (every existing row is NULL, so it holds at once)
--
-- (0154 is left for the concurrent sessions-safety branch.)
--
-- Additive (expand): one nullable column, no default, no rewrite; a check every existing row already satisfies.
-- Idempotent (ADD COLUMN IF NOT EXISTS / a guarded DO block), safe to re-run, which scripts/db-migrate.sh does on every
-- deploy. No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only
-- because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declaration
-- ship in ONE commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS availability jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offers_availability_check') THEN
    ALTER TABLE offers ADD CONSTRAINT offers_availability_check CHECK (availability IS NULL OR jsonb_typeof(availability) = 'object');
  END IF;
END $$;
