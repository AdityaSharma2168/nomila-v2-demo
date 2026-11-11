-- 0089_drop_v1_tasks.sql — drop the v1 `tasks` table and its LISTEN/NOTIFY trigger.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line, the removal of
-- db-migrate step 4 (server/scripts/createTriggers.ts, which re-installed the trigger on every deploy) and the
-- shared/schema.ts removal ship in ONE commit, or step 4 would fail on the missing table.
--
-- ── WHAT THIS REMOVES ─────────────────────────────────────────────────────────────────────────────
-- tasks                              — the v1 background-job progress table (research / media_kit / brand_stories
--                                      …). Nothing in v2 inserts into it (the workflow runner's workflow_runs /
--                                      workflow_steps replaced it); the last readers — the task half of Mila's
--                                      list_tasks_threads tool and the admin roster's research pill — are removed
--                                      in the same commit. No table has a foreign key into it; no view reads it.
-- task_update_trigger ON tasks       — fired pg_notify('task_progress', id) on every insert/update. Nothing
--                                      LISTENs on 'task_progress'.
-- notify_task_update()               — the trigger's function. Dropped after the trigger (it depends on it),
--                                      before the table.
--
-- DESTRUCTIVE: the stale v1 task rows (5 on dev, last written 2026-07-24) are discarded. Re-runs as a no-op
-- (the trigger drop is guarded on the table existing, since DROP TRIGGER … ON needs the table). No transaction
-- control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

DO $$
BEGIN
  IF to_regclass('public.tasks') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS task_update_trigger ON tasks;
  END IF;
END $$;
DROP FUNCTION IF EXISTS notify_task_update();
DROP TABLE IF EXISTS tasks;
