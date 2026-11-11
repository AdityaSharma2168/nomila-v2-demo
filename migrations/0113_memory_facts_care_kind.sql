-- 0113_memory_facts_care_kind.sql — which KIND of care a care fact is (owner decision on PR #896, Oct 2026).
--
-- memory_facts.care_kind   NULL for every fact that is not care (sensitive = false), and for care facts written before
--                          this column existed. Otherwise:
--                            personal  an injury or availability, leave or pregnancy, family as the athlete presents it
--                                      → may inform M.I.A. MOMENTUM only
--                            conduct   a confirmed controversy or an official finding
--                                      → may inform M.I.A. brand_safety and momentum
--                          A care fact with no kind is read as personal (the stricter rule).
--
-- Additive and nullable: no existing row changes, nothing is backfilled. Re-runs as a no-op (IF NOT EXISTS, and
-- DROP-then-ADD of the named check). Names and definitions are written exactly as a shared/schema.ts push produces them.
-- No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts
-- declaration ship in ONE commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.

ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS care_kind text;
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_facts_care_kind_check;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_care_kind_check CHECK (care_kind IS NULL OR care_kind IN ('personal','conduct'));
