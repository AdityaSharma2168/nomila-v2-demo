-- 0140_drop_retired_intelligence_tables.sql — the old intelligence layer's own tables (owner-approved clean-up,
-- 25 Oct 2026; the code that wrote them was removed in the PR before this one).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list.
--
-- ── WHAT THIS REMOVES ─────────────────────────────────────────────────────────────────────────────
-- recommendation_events  — the Brain's governance history of a Recommendation (0076). FK → recommendations.
-- recommendations        — the governed Recommendation (0076). FK → brain_runs (ON DELETE SET NULL).
-- brain_runs             — append-only audit of a Brain evaluation (0076).
-- intelligence_requests  — "what is waiting on her" (0077); its routes were never mounted in any environment.
-- outreach_plans         — the outreach planner's work items (0071); OUTREACH_PLANNER_ENABLED was off everywhere.
--
-- KEPT: objectives, objective_events and objective_proposal_sets (the objective store, read by the Goals work).
--
-- No other table points into these five (checked in shared/schema.ts before writing this); the only foreign keys
-- between them are recommendation_events → recommendations → brain_runs, all dropped in this one statement, so no
-- CASCADE is used: if a live table ever pointed into one of them, this statement fails rather than silently dropping
-- that constraint. Each was in the athlete-data manifest; those entries are removed in the same commit.
--
-- The CREATE files (0071_outreach_plans, 0076_brain_substrate, 0077_intelligence_requests) stay on the list: they are
-- IF NOT EXISTS, so a deploy re-creates the empty tables and this file drops them again (the 0043 → 0127 precedent).
--
-- DESTRUCTIVE: any rows are discarded (prod holds no real users' data in these; dev holds experiment rows). Re-runs as
-- a no-op. No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK, and
-- rehearse it on a clone of prod before the release. Nothing here names an athlete, sport, school or brand.

-- Dev only: an out-of-band experiment table (counterparty_research — in no migration and not in shared/schema.ts; absent
-- in prod) carries a foreign key into intelligence_requests, which made the first dev deploy of this file fail
-- (25 Oct 2026). Drop just that constraint, by name, when the table exists; the table and its rows are left alone.
ALTER TABLE IF EXISTS counterparty_research DROP CONSTRAINT IF EXISTS counterparty_research_request_id_intelligence_requests_id_fk;

DROP TABLE IF EXISTS recommendation_events, recommendations, brain_runs, intelligence_requests, outreach_plans;
