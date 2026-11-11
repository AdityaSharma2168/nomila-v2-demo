-- 0144_agent_run_approval_state.sql — where a run's approval cards stand (agent_runs.approval_state).
--
-- A turn that ends with a card waiting on the athlete's tap (a drafted reply, "Want me to save that?") was recorded as
-- status 'completed', often with no text, and nothing on the run said it was waiting. `status` keeps meaning how the
-- model turn itself ended (the cost cap, workflow reuse and plan readers rely on 'completed'); this column says where the
-- run's cards stand: NULL (none queued) | awaiting_approval | resumed | completed | cancelled | failed. Written by
-- agent/tf/chat.ts and agent/trace.ts when a turn queued cards, and by agent/approvals.ts on every approve / decline tap.
--
-- Pure DDL, additive only (expand): one nullable column (no default, so no table rewrite) and its CHECK, added once
-- (a DO block checks pg_constraint, so a re-run neither drops nor re-validates anything). Nothing backfilled: runs from
-- before this read NULL. Idempotent, safe to re-run, which scripts/db-migrate.sh does on every deploy. No transaction
-- control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because
-- scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in
-- ONE commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS approval_state text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_approval_state_check' AND conrelid = 'agent_runs'::regclass) THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_approval_state_check
      CHECK (approval_state IS NULL OR approval_state IN ('awaiting_approval','resumed','completed','cancelled','failed'));
  END IF;
END $$;
