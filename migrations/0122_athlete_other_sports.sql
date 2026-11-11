-- 0122_athlete_other_sports.sql — the athlete's sports: the main one plus any others (the onboarding sport grid, 10 Oct 2026).
--
-- athletes.other_sports   the athlete's OTHER sports, in the order they picked them. athletes.sport stays the MAIN sport
--                         for every existing reader and is never repeated here. Empty = one sport, or nobody has said.
--                         Written by the agent onboarding's start (server/agent/onboarding/service.ts), which also records
--                         every sport as a "said" fact.
--
-- Additive only: one column with a constant default (a metadata-only change on Postgres 11+, no table rewrite), nothing
-- renamed, dropped or backfilled. Re-runs as a no-op (IF NOT EXISTS). Written exactly as a shared/schema.ts push produces
-- it. No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only
-- because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declaration
-- ship in ONE commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.

ALTER TABLE athletes ADD COLUMN IF NOT EXISTS other_sports text[] DEFAULT '{}'::text[] NOT NULL;
