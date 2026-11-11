-- 0082_research_identity_sources.sql — research v3 identity sources: the targeted source read (PR A of the minimal identity
-- evidence plan).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy.
--
-- WHAT THIS CHANGES: three CHECK constraints, widened (supersets; no table, column, index or data change).
--   research_evidence_kind_check     + athlete_statement  the athlete's own verbatim words, extracted only by the targeted
--                                                         source read from the page or public video the model read
--   research_evidence_lineage_check  + source_read        the model directly read the source (URL context / native video
--                                                         input) and extracted the item from it; source_url = the URL read
--   research_runs_query_id_check     + READ               the research_runs row of a v3 run's targeted-read step
--
-- CHECK OWNERSHIP RULE (0063): this file is now the OWNER of all three (DROP + ADD, validated). Their previous owners
-- (0053 for the two research_evidence CHECKs, 0081 for research_runs_query_id_check) were edited in the same commit to the
-- guarded "add only if absent, NOT VALID" form, so a re-run of an earlier file never re-narrows them over rows written
-- under this set. A later migration that widens one again must edit this file to that guarded form.
-- Every statement re-runs on every deploy and autocommits on its own under psql -f; the new sets are supersets, so an image
-- that writes only the older values is unaffected in the gap between a DROP and its ADD. No transaction control here
-- (migrationsGuard).

ALTER TABLE research_evidence DROP CONSTRAINT IF EXISTS research_evidence_kind_check;
ALTER TABLE research_evidence ADD CONSTRAINT research_evidence_kind_check
  CHECK (kind IN ('achievement','press_mention','brand_mention','affiliation','profile_attribute','social_handle','nil_mention','sentiment','media_asset','identity_signal','signal','career_event','reputation_event','social_metric_claim','representation','venture','crossover_appearance','narrative_claim','research_finding','athlete_statement'));

ALTER TABLE research_evidence DROP CONSTRAINT IF EXISTS research_evidence_lineage_check;
ALTER TABLE research_evidence ADD CONSTRAINT research_evidence_lineage_check
  CHECK (lineage_status IN ('cited','uncited','conflicting','native_supported','native_retrieved','asserted_only','source_read'));

ALTER TABLE research_runs DROP CONSTRAINT IF EXISTS research_runs_query_id_check;
ALTER TABLE research_runs ADD CONSTRAINT research_runs_query_id_check
  CHECK (query_id IS NULL OR query_id IN ('Q1','Q2','Q3','Q4','Q5','Q6','READ'));
