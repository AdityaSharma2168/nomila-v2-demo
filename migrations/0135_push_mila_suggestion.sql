-- 0135_push_mila_suggestion.sql — "Mila's suggestions" (the agent research refresh, 12 Oct 2026): her own switch for the
-- one push Nomila sends when a research refresh suggests a change to her strategy (push kind mila_suggestion). Default
-- on, like every other kind; quiet hours and the daily cap apply as to every push.
--
-- Additive: one new column with a constant default (no table rewrite on Postgres 11+); nothing existing changes.
-- Idempotent (ADD COLUMN IF NOT EXISTS), safe to re-run, which scripts/db-migrate.sh does on every deploy. No transaction
-- control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because
-- scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in
-- ONE commit or the drift gate reds the deploy. Numbered 0135: 0132, 0133 and 0134 are taken by open PRs (#978, #980, #988). Nothing here
-- names an athlete, sport, school or brand.

ALTER TABLE push_preferences ADD COLUMN IF NOT EXISTS mila_suggestion boolean DEFAULT true NOT NULL;
