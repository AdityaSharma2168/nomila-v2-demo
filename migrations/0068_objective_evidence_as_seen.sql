-- 0068_objective_evidence_as_seen.sql — the structured State and Opportunity Map an Objective evaluator run
-- actually saw (objectives-lineage-design.md §3, L0).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- TWO nullable jsonb columns on objective_proposal_sets and nothing else. No ALTER of an existing column,
-- no UPDATE, no backfill here (the one-time backfill of the one presented set is a script, run by hand,
-- asserting asOf equality before it writes).
--
--   state_snapshot    the AthleteState object passed to the evaluator, byte for byte
--   opportunity_map   the OpportunityMap object passed to the evaluator
--
-- Invariants held by the writer, not the database: state_snapshot.asOf = state_as_of;
-- opportunity_map.stateAsOf = state_as_of; opportunity_map.asOf = opportunity_map_as_of.
-- The rendered blocks in `record` stay: they are what was sent, byte for byte; these are what it was
-- rendered from. Provenance, review and audit resolve citations against these, not by parsing prose.

ALTER TABLE objective_proposal_sets ADD COLUMN IF NOT EXISTS state_snapshot jsonb;
ALTER TABLE objective_proposal_sets ADD COLUMN IF NOT EXISTS opportunity_map jsonb;
