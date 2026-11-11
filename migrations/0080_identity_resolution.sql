-- 0080_identity_resolution.sql — athlete-level identity resolution (research-acquisition arch §9.4 (ii); PR E1).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- WHAT THIS CHANGES: two nullable columns on athlete_research_state. No default, no UPDATE, no backfill:
-- every existing row stays NULL = "no determination recorded" (historical; NOT pending).
-- identity_confidence / identity_resolved_at are NOT touched: they carry the legacy ACCOUNT signal.
-- OWNER of athlete_research_state_identity_resolution_check and ..._identity_detail_check (CHECK OWNERSHIP RULE, 0063).

ALTER TABLE athlete_research_state ADD COLUMN IF NOT EXISTS identity_resolution text;
ALTER TABLE athlete_research_state ADD COLUMN IF NOT EXISTS identity_resolution_detail jsonb;

ALTER TABLE athlete_research_state DROP CONSTRAINT IF EXISTS athlete_research_state_identity_resolution_check;
ALTER TABLE athlete_research_state ADD CONSTRAINT athlete_research_state_identity_resolution_check
  CHECK (identity_resolution IS NULL OR identity_resolution IN ('pending','resolved','ambiguous','failed'));

-- A determination never exists without its provenance, and provenance never exists without a determination.
ALTER TABLE athlete_research_state DROP CONSTRAINT IF EXISTS athlete_research_state_identity_detail_check;
ALTER TABLE athlete_research_state ADD CONSTRAINT athlete_research_state_identity_detail_check
  CHECK ((identity_resolution IS NULL) = (identity_resolution_detail IS NULL));
