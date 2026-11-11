-- 0139_athlete_signup_flags.sql — the anti-fake plan (owner, 24 Oct 2026): admin flags on a new account, stored at
-- creation (lib/signupFlags.ts) and shown as chips in the admin list. A flag is a SIGNAL for a human, never a block.
-- Keys: disposable_email, same_network_burst, no_athlete_footprint; each value { at, ...detail }. No IP, raw or hashed.
--
-- Additive: one nullable column, no default, no rewrite; NULL means no flags, so every existing row reads as unflagged.
-- Idempotent (ADD COLUMN IF NOT EXISTS), safe to re-run, which scripts/db-migrate.sh does on every deploy. No
-- transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because
-- scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in
-- ONE commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.

ALTER TABLE athletes ADD COLUMN IF NOT EXISTS signup_flags jsonb;
