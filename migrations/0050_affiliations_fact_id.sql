-- 0050_affiliations_fact_id — Phase A Step 2d-6 (design step2d §3.5, D11 decision in §9).
--
-- The ONE additive column of Step 2d: a found affiliation synced from the research substrate carries the
-- athlete_facts row it came from, so syncAffiliationsFromFacts is idempotent (same fact ⇒ same row; a re-confirmed
-- fact re-points the row; never a duplicate). NULL for the athlete's own said/proof rows and for legacy found rows
-- (source='research', written from the blob until Step 4). ON DELETE SET NULL: deleting a fact never deletes ledger
-- history. No data change; idempotent.

ALTER TABLE athlete_affiliations ADD COLUMN IF NOT EXISTS fact_id uuid NULL REFERENCES athlete_facts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_affiliations_fact ON athlete_affiliations (fact_id) WHERE fact_id IS NOT NULL;
