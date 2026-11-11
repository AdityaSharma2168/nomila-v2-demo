-- 0117_memory_fact_reviews_history_actions.sql — a fact's history records every athlete edit from What Nomila knows
-- (Me on the agent memory, Oct 2026).
--
-- memory_fact_reviews.action   gains 'restore' (undo a hide: removed → active) and 'dispute' ("this isn't right": the
--                              fact becomes disputed and Mila asks what's true), beside confirm | correct | remove.
--
-- Widening only: every existing row already satisfies the new check, nothing is rewritten or backfilled. Re-runs as a
-- no-op (DROP-then-ADD of the named check). Written exactly as a shared/schema.ts push produces it. No transaction
-- control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because
-- scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in
-- ONE commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.

ALTER TABLE memory_fact_reviews DROP CONSTRAINT IF EXISTS memory_fact_reviews_action_check;
ALTER TABLE memory_fact_reviews ADD CONSTRAINT memory_fact_reviews_action_check CHECK (action IN ('confirm','correct','remove','restore','dispute'));
