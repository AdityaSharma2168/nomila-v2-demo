-- 0106_agent_onboarding.sql — the Research / Understand skills and the new onboarding (agent build plan v2, Week 1).
-- Builds on 0105_agent_harness (agent_runs + the memory_* tables). Dark behind AGENT_ONBOARDING (off in dev and prod):
-- nothing writes these tables or columns until the flag is on.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy. Runs after 0105 (name order).
--
-- CLEAN START: no data is migrated. Nothing here names an athlete, sport, school or brand.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- agent_runs.output          a run's structured result (a skill's JSON output: the facts a search pass found, the
--                            brief Understand wrote, the cards onboarding composed)
-- agent_runs.parent_ref      what started the run ("workflow:<run id>:<step>"), so a retried workflow step reuses the
--                            finished run instead of paying for the model twice
-- memory_facts.disputes      status = disputed → the fact it conflicts with (neither is overwritten)
-- memory_facts.also_seen_at  the other sources that say the same thing (dual-pass research keeps every source)
-- memory_facts.sensitive     private-life detail the athlete told us themselves; never used in anything meant for
--                            content (policy family_privacy). Research never stores such facts at all
-- memory_facts status        widens to include 'removed' (the athlete removed it; kept, never used again)
-- memory_briefs.internal     the internal read (scored criteria with evidence and confidence, commercial readiness,
--                            rate notes). Never returned by an athlete-facing route.
-- memory_fact_reviews        each confirm / correct / remove the athlete made, and the "said" fact a correction became
-- memory_goals               the Goals screen: goals in the athlete's words, typed (said) or a proposal they accepted
--                            or edited (proposed_accepted); status active | paused | done | dropped, priority, game plan
-- memory_decisions.goal_id   the goal a decision (and the action it becomes) serves
-- agent_onboarding_checkpoints  the adaptive onboarding's required checkpoints (name+sport, reveal, facts review,
--                            connect offers, a goal, capabilities, consent), one row each per onboarding run: the
--                            model picks the order and the words, code holds this state (resumable, never nagging)
--
-- Additive apart from the status widening (every existing row is active | superseded | disputed, so the new check
-- holds). Every statement re-runs as a no-op (IF NOT EXISTS, or DROP-then-ADD of a named constraint). Names and
-- definitions are written exactly as a shared/schema.ts push produces them. No transaction control here
-- (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS output jsonb;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS parent_ref text;

ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS disputes uuid;
ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS also_seen_at jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS sensitive boolean DEFAULT false NOT NULL;
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_facts_status_check;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_status_check CHECK (status IN ('active','superseded','disputed','removed'));

ALTER TABLE memory_briefs ADD COLUMN IF NOT EXISTS internal jsonb;

CREATE TABLE IF NOT EXISTS memory_fact_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id          uuid NOT NULL,
  fact_id             uuid NOT NULL,
  action              text NOT NULL,
  correction          text,
  replacement_fact_id uuid,
  note                text,
  created_at          timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT memory_fact_reviews_action_check CHECK (action IN ('confirm','correct','remove')),
  CONSTRAINT memory_fact_reviews_correction_check CHECK ((action = 'correct') = (correction IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS memory_goals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id  uuid NOT NULL,
  text        text NOT NULL,
  source      text NOT NULL,
  status      text DEFAULT 'active' NOT NULL,
  priority    integer,
  game_plan   text,
  decision_id uuid,
  created_at  timestamp with time zone DEFAULT now() NOT NULL,
  updated_at  timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT memory_goals_source_check CHECK (source IN ('said','proposed_accepted')),
  CONSTRAINT memory_goals_status_check CHECK (status IN ('active','paused','done','dropped')),
  CONSTRAINT memory_goals_text_check CHECK (length(text) BETWEEN 1 AND 500),
  CONSTRAINT memory_goals_priority_check CHECK (priority IS NULL OR priority >= 1)
);

-- Decisions (and the actions they become) point at the goal they serve.
ALTER TABLE memory_decisions ADD COLUMN IF NOT EXISTS goal_id uuid;

-- ── foreign keys ──
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_facts_disputes_memory_facts_id_fk;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_disputes_memory_facts_id_fk
  FOREIGN KEY (disputes) REFERENCES public.memory_facts(id) ON DELETE set null ON UPDATE no action;

ALTER TABLE memory_fact_reviews DROP CONSTRAINT IF EXISTS memory_fact_reviews_athlete_id_athletes_id_fk;
ALTER TABLE memory_fact_reviews ADD CONSTRAINT memory_fact_reviews_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;
ALTER TABLE memory_fact_reviews DROP CONSTRAINT IF EXISTS memory_fact_reviews_fact_id_memory_facts_id_fk;
ALTER TABLE memory_fact_reviews ADD CONSTRAINT memory_fact_reviews_fact_id_memory_facts_id_fk
  FOREIGN KEY (fact_id) REFERENCES public.memory_facts(id) ON DELETE cascade ON UPDATE no action;
ALTER TABLE memory_fact_reviews DROP CONSTRAINT IF EXISTS memory_fact_reviews_replacement_fact_id_memory_facts_id_fk;
ALTER TABLE memory_fact_reviews ADD CONSTRAINT memory_fact_reviews_replacement_fact_id_memory_facts_id_fk
  FOREIGN KEY (replacement_fact_id) REFERENCES public.memory_facts(id) ON DELETE set null ON UPDATE no action;

ALTER TABLE memory_goals DROP CONSTRAINT IF EXISTS memory_goals_athlete_id_athletes_id_fk;
ALTER TABLE memory_goals ADD CONSTRAINT memory_goals_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;
ALTER TABLE memory_decisions DROP CONSTRAINT IF EXISTS memory_decisions_goal_id_memory_goals_id_fk;
ALTER TABLE memory_decisions ADD CONSTRAINT memory_decisions_goal_id_memory_goals_id_fk
  FOREIGN KEY (goal_id) REFERENCES public.memory_goals(id) ON DELETE set null ON UPDATE no action;
ALTER TABLE memory_goals DROP CONSTRAINT IF EXISTS memory_goals_decision_id_memory_decisions_id_fk;
ALTER TABLE memory_goals ADD CONSTRAINT memory_goals_decision_id_memory_decisions_id_fk
  FOREIGN KEY (decision_id) REFERENCES public.memory_decisions(id) ON DELETE set null ON UPDATE no action;

-- ── indexes ──
CREATE INDEX IF NOT EXISTS idx_agent_runs_parent_ref ON agent_runs USING btree (parent_ref);
CREATE INDEX IF NOT EXISTS idx_memory_fact_reviews_athlete_fact ON memory_fact_reviews USING btree (athlete_id, fact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_goals_athlete_status ON memory_goals USING btree (athlete_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_decisions_goal ON memory_decisions USING btree (goal_id);

-- ── the onboarding conversation's required checkpoints (one row per checkpoint per onboarding run) ──
CREATE TABLE IF NOT EXISTS agent_onboarding_checkpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id      uuid NOT NULL,
  workflow_run_id uuid NOT NULL,
  checkpoint      text NOT NULL,
  status          text DEFAULT 'pending' NOT NULL,
  offers          integer DEFAULT 0 NOT NULL,
  last_turn       integer,
  detail          jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_at      timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT agent_onboarding_checkpoints_checkpoint_check CHECK (checkpoint IN ('name_sport','reveal','facts_review','connect_offers','goal','capabilities','consent')),
  CONSTRAINT agent_onboarding_checkpoints_status_check CHECK (status IN ('pending','offered','done','declined')),
  CONSTRAINT agent_onboarding_checkpoints_offers_check CHECK (offers >= 0)
);
ALTER TABLE agent_onboarding_checkpoints DROP CONSTRAINT IF EXISTS agent_onboarding_checkpoints_athlete_id_athletes_id_fk;
ALTER TABLE agent_onboarding_checkpoints ADD CONSTRAINT agent_onboarding_checkpoints_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX IF NOT EXISTS agent_onboarding_checkpoints_run_checkpoint_uq ON agent_onboarding_checkpoints USING btree (workflow_run_id, checkpoint);
CREATE INDEX IF NOT EXISTS idx_agent_onboarding_checkpoints_athlete ON agent_onboarding_checkpoints USING btree (athlete_id);
