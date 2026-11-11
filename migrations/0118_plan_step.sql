-- 0118_plan_step.sql — the plan step (design "The plan step", 9 Oct 2026): one model call writes recommended goals, a
-- game plan per goal and this week's actions; they are stored as decisions and on the goals the athlete holds.
--
-- memory_decisions.kind                what the decision is about: goal (a recommended goal, or a goal change the
--                                      athlete asked for) | action (one of this week's actions toward a goal) | other
--                                      (every row written before 0118, and anything else). Existing rows read 'other'.
-- memory_decisions.detail              the structured detail of a goal or action decision (shared/plan.ts
--                                      GoalDecisionDetail / ActionDecisionDetail / GoalChangeDetail). '{}' otherwise.
-- memory_decisions.parent_decision_id  an action held for a RECOMMENDED goal points at that goal's decision until the
--                                      athlete keeps it (then goal_id is set). SET NULL keeps the child's history.
-- memory_goals.horizon                 now (this month) | next (this season / quarter) | later (the year ahead);
--                                      NULL = nobody has said (every goal before 0118).
-- memory_goals.game_plan_by            mila (a plan run may rewrite the game plan) | athlete (only the athlete changes
--                                      it). Existing goals read 'mila'.
--
-- "Set aside" is the existing memory_goals.status 'paused': no new status. Additive only: nothing is renamed, dropped
-- or backfilled. Re-runs as a no-op (IF NOT EXISTS, and DROP-then-ADD of each named constraint). Names and definitions
-- are written exactly as a shared/schema.ts push produces them. No transaction control here (migrationsGuard): dry-run
-- this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names it in the step-3 list;
-- this file, that line and the shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
-- Nothing here names an athlete, sport, school or brand.

ALTER TABLE memory_decisions ADD COLUMN IF NOT EXISTS kind text DEFAULT 'other' NOT NULL;
ALTER TABLE memory_decisions ADD COLUMN IF NOT EXISTS detail jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE memory_decisions ADD COLUMN IF NOT EXISTS parent_decision_id uuid;
ALTER TABLE memory_decisions DROP CONSTRAINT IF EXISTS memory_decisions_kind_check;
ALTER TABLE memory_decisions ADD CONSTRAINT memory_decisions_kind_check CHECK (kind IN ('goal','action','other'));
ALTER TABLE memory_decisions DROP CONSTRAINT IF EXISTS memory_decisions_parent_decision_id_memory_decisions_id_fk;
ALTER TABLE memory_decisions ADD CONSTRAINT memory_decisions_parent_decision_id_memory_decisions_id_fk
  FOREIGN KEY (parent_decision_id) REFERENCES public.memory_decisions(id) ON DELETE set null ON UPDATE no action;
CREATE INDEX IF NOT EXISTS idx_memory_decisions_parent ON memory_decisions USING btree (parent_decision_id);

ALTER TABLE memory_goals ADD COLUMN IF NOT EXISTS horizon text;
ALTER TABLE memory_goals ADD COLUMN IF NOT EXISTS game_plan_by text DEFAULT 'mila' NOT NULL;
ALTER TABLE memory_goals DROP CONSTRAINT IF EXISTS memory_goals_horizon_check;
ALTER TABLE memory_goals ADD CONSTRAINT memory_goals_horizon_check CHECK (horizon IS NULL OR horizon IN ('now','next','later'));
ALTER TABLE memory_goals DROP CONSTRAINT IF EXISTS memory_goals_game_plan_by_check;
ALTER TABLE memory_goals ADD CONSTRAINT memory_goals_game_plan_by_check CHECK (game_plan_by IN ('mila','athlete'));
