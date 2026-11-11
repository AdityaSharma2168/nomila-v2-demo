-- 0137_offers_time_zone.sql — Bookings PR3 ("Bookings, end to end"): the athlete's own time zone on each offer, so her
-- notices and reminders read her clock (the buyer's notices keep the buyer's zone, bookings.buyer_timezone).
--
-- Additive: one nullable column, no default, no rewrite; a NULL zone falls back to her phone's zone, then UTC. Idempotent
-- (ADD COLUMN IF NOT EXISTS), safe to re-run, which scripts/db-migrate.sh does on every deploy. No transaction control
-- here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh
-- names it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in ONE commit or the drift
-- gate reds the deploy. Nothing here names an athlete, sport, school or brand.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS time_zone text;
