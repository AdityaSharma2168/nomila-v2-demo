-- 0041 · Athlete affiliations + career status.
--
-- Until now an athlete had ONE team: athletes.school (free text the research code itself
-- annotates "school OR club OR pro team"), and nothing said whether she still plays. This adds
--   • athlete_affiliations — teams as dated facts with provenance (current = ended_on IS NULL),
--     exactly one primary current row per athlete (partial unique index),
--   • athletes.career_status — a DECLARED status (default 'active'), never inferred from an
--     empty team list,
-- and backfills one said/primary row per athlete from the existing columns.
--
-- athletes.school / division / conference stay as a PROJECTION of the primary current row
-- (server/services/affiliations.ts writes both), so the 21 readers of `school` keep working.
--
-- Idempotent: every statement is IF NOT EXISTS / NOT EXISTS-guarded. Dry-run against prod
-- inside BEGIN … ROLLBACK before merging (see memory: migration-dry-run-rule).

CREATE TABLE IF NOT EXISTS athlete_affiliations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   uuid NOT NULL REFERENCES athletes(id),
  org_name     text NOT NULL,
  org_kind     text NOT NULL,
  level        text,
  conference   text,
  role         text,
  position     text,
  started_on   date,
  ended_on     date,
  is_primary   boolean NOT NULL DEFAULT false,
  kind         text NOT NULL DEFAULT 'said',
  source       text,
  asserted_id  uuid REFERENCES athlete_asserted(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT athlete_affiliations_org_kind_check CHECK (org_kind IN ('school','club','pro','national','olympic')),
  CONSTRAINT athlete_affiliations_kind_check     CHECK (kind IN ('said','found','proof'))
);

CREATE INDEX IF NOT EXISTS idx_affiliations_athlete_current
  ON athlete_affiliations (athlete_id, ended_on);

-- One primary CURRENT team per athlete. Created on an empty (or already-consistent) table, and
-- the backfill below inserts exactly one primary per athlete, so the index cannot be violated
-- by this migration. (0038's one-active-row index broke deploys because the INSERT ran before
-- the flip; here the guard and the insert agree by construction.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliations_one_primary_current
  ON athlete_affiliations (athlete_id) WHERE is_primary AND ended_on IS NULL;

ALTER TABLE athletes ADD COLUMN IF NOT EXISTS career_status text NOT NULL DEFAULT 'active';
ALTER TABLE athletes DROP CONSTRAINT IF EXISTS athletes_career_status_check;
ALTER TABLE athletes ADD CONSTRAINT athletes_career_status_check
  CHECK (career_status IN ('active','between_teams','out_this_season','retired'));

-- Backfill: one said, primary, current row per athlete that has a team and no rows yet.
-- org_kind from division: the college divisions → school; Pro → pro; Olympic or a national-team
-- name → national/olympic; anything else with a school name → school.
INSERT INTO athlete_affiliations (athlete_id, org_name, org_kind, level, conference, is_primary, kind, source)
SELECT a.id,
       a.school,
       CASE
         WHEN a.division = 'Pro' THEN 'pro'
         WHEN a.division = 'Olympic' OR a.school ILIKE '%olympic%' THEN 'olympic'
         WHEN a.school ILIKE '%national team%' OR a.school ILIKE '%team usa%' OR a.school ~* '\mU-?1[5-9]\M' THEN 'national'
         WHEN a.division IN ('Youth','Club','AAU') THEN 'club'
         ELSE 'school'
       END,
       a.division,
       a.conference,
       true,
       'said',
       'signup'
FROM athletes a
WHERE a.school IS NOT NULL AND btrim(a.school) <> ''
  AND NOT EXISTS (SELECT 1 FROM athlete_affiliations x WHERE x.athlete_id = a.id);
