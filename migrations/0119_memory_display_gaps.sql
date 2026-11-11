-- 0119_memory_display_gaps.sql — the memory display gaps (follow-up to Scouting / Goals on the agent memory, 10 Oct 2026).
--
-- memory_goals.domain            what the goal is about, from the closed goal-domain list the app draws (audience |
--                                content | positioning | athletic | commercial | relationships | owned_venture | impact |
--                                career). The plan writes it; NULL = nobody has said (every goal before 0119, and goals
--                                typed or added in the chat until a plan run labels them).
-- memory_facts.date_precision    how precise observed_on is: day | month | year. Research stores "2026-12" as the 1st of
--                                the month; this keeps that it was a month. NULL = a full date (day), or a fact written
--                                before 0119.
-- memory_facts.field             which identity field an identity fact about the athlete states (sport | team | position |
--                                level | class_year | school | league), as the merge model labelled it. NULL otherwise.
-- memory_facts.field_value       that field's value in a few words, as the sources say it ("Junior", the team's name).
--                                Written with field, never alone.
--
-- Additive only: nothing is renamed, dropped or backfilled. Re-runs as a no-op (IF NOT EXISTS, and DROP-then-ADD of each
-- named constraint). Names and definitions are written exactly as a shared/schema.ts push produces them. No transaction
-- control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because
-- scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in
-- ONE commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.

ALTER TABLE memory_goals ADD COLUMN IF NOT EXISTS domain text;
ALTER TABLE memory_goals DROP CONSTRAINT IF EXISTS memory_goals_domain_check;
ALTER TABLE memory_goals ADD CONSTRAINT memory_goals_domain_check CHECK (domain IS NULL OR domain IN ('audience','content','positioning','athletic','commercial','relationships','owned_venture','impact','career'));

ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS date_precision text;
ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS field text;
ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS field_value text;
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_facts_date_precision_check;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_date_precision_check CHECK (date_precision IS NULL OR date_precision IN ('day','month','year'));
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_facts_field_check;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_field_check CHECK (field IS NULL OR field IN ('sport','team','position','level','class_year','school','league'));
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_facts_field_value_check;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_field_value_check CHECK ((field IS NULL) = (field_value IS NULL));
CREATE INDEX IF NOT EXISTS idx_memory_facts_athlete_field ON memory_facts USING btree (athlete_id,field) WHERE field IS NOT NULL;
