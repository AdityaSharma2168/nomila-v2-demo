-- 0150_platform_spend_indexes.sql — the indexes behind the platform-wide day spend total (server/lib/platformSpend.ts).
--
-- platformSpend sums TODAY (since UTC midnight) across ALL athletes, re-read at most every 30 s per instance on every
-- paid call: agent_runs by started_at, generation_jobs by created_at (not cancelled), and voice transcript rows
-- (chat_messages, source = 'voice') by created_at. The existing indexes all lead with athlete_id, so each sum was a
-- full scan of an ever-growing table. Three time-leading indexes; the voice one is partial (voice rows only).
--
-- NON-TRANSACTIONAL on purpose: CREATE INDEX CONCURRENTLY does not lock writes on these hot tables, and it cannot run
-- inside a transaction. So this file has NO BEGIN/COMMIT, is listed in server/migrationsGuard.test.ts NON_TRANSACTIONAL,
-- and is run by scripts/db-migrate.sh with plain `psql -f` (each statement autocommits). Dry-run it PLAINLY against dev
-- (never inside BEGIN … ROLLBACK), then check with \d. IF NOT EXISTS: re-runs on every deploy are no-ops.
-- A CONCURRENTLY build that is interrupted leaves an INVALID index that IF NOT EXISTS would then skip: if \d shows
-- one INVALID, DROP INDEX CONCURRENTLY it and re-run this file.
-- Nothing here names an athlete, sport, school or brand.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_runs_started ON agent_runs USING btree (started_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_generation_jobs_created ON generation_jobs USING btree (created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_voice_created ON chat_messages USING btree (created_at) WHERE source = 'voice';
