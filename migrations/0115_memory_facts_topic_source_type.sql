-- 0115_memory_facts_topic_source_type.sql — what a fact is about, and what kind of outlet its source is (owner, Oct 2026:
-- the first real run of research 1.7.0 showed both are needed to group a Scouting report by topic and to show outlet
-- type; until now they lived only in the research run's output).
--
-- memory_facts.topic         the research topic the fact was filed under (career, sponsor, media, …; the list is
--                            research/schemas.ts FACT_TOPICS and may grow, so it is not constrained here). NULL where
--                            there is no research topic (said, measured, made) and for facts written before 0115.
-- memory_facts.source_type   the outlet type of the fact's source: official | major_media | trade | local | social |
--                            other. NULL where it does not apply (said, measured, made) and for facts written before 0115.
--
-- Written by research and merge (skills research 1.8.0 / research/merge 1.8.0). Additive and nullable: no existing row
-- changes, nothing is backfilled. Re-runs as a no-op (IF NOT EXISTS, and DROP-then-ADD of the named check). Names and
-- definitions are written exactly as a shared/schema.ts push produces them. No transaction control here
-- (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names
-- it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in ONE commit or the drift gate
-- reds the deploy. Nothing here names an athlete, sport, school or brand.

ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS topic text;
ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_facts_source_type_check;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_source_type_check CHECK (source_type IS NULL OR source_type IN ('official','major_media','trade','local','social','other'));
