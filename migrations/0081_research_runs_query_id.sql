-- 0081_research_runs_query_id.sql — one successful research run per (workflow run, research-spec/1 query) (PR E2a;
-- design record docs/architecture/phase-a/pr-e-identity-resolution-design.md §4.3, D10).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- WHAT THIS CHANGES: research_refresh v3 persists each query (Q1–Q6) as its own research_runs row under ONE workflow
-- run, which 0047's research_runs_workflow_success (one ok/partial row per workflow run) refuses on the second query.
--   - research_runs.query_id: nullable, no default, no backfill. Legacy, v2 and direct-CLI rows stay NULL and keep
--     exactly today's one-per-workflow-run rule; in a v3 run the signals step's row is the single NULL slot.
--   - the unique index keeps its NAME and widens its key to (workflow_run_id, COALESCE(query_id, '')).
-- research_runs_query_id_check (CHECK OWNERSHIP RULE, 0063): 0082_research_identity_sources widened it (+ READ) and OWNS it
-- now, so this file adds it only if absent, NOT VALID — a re-run never re-narrows it over READ rows.
-- Every statement re-runs on every deploy: ADD COLUMN IF NOT EXISTS; the guarded CHECK; the index is replaced
-- only while the live definition is still 0047's (0047 re-runs first with CREATE … IF NOT EXISTS, a no-op on the
-- widened index), so it is never rebuilt on an ordinary deploy. No transaction control here (migrationsGuard).

ALTER TABLE research_runs ADD COLUMN IF NOT EXISTS query_id text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'research_runs_query_id_check') THEN
    ALTER TABLE research_runs ADD CONSTRAINT research_runs_query_id_check
      CHECK (query_id IS NULL OR query_id IN ('Q1','Q2','Q3','Q4','Q5','Q6')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'research_runs_workflow_success' AND indexdef LIKE '%query_id%') THEN
    DROP INDEX IF EXISTS research_runs_workflow_success;
    CREATE UNIQUE INDEX research_runs_workflow_success ON research_runs (workflow_run_id, COALESCE(query_id, ''))
      WHERE workflow_run_id IS NOT NULL AND status IN ('ok','partial');
  END IF;
END $$;
