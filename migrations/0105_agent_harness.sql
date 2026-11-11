-- 0105_agent_harness.sql — the agent harness core (agent build plan v2, Week 1 step 1; contract: shared/agent.ts).
-- Dark behind AGENT_V3 (off in dev and prod): nothing writes these tables until the flag is on.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy.
-- (0101–0104 and 0110–0112 belong to other tracks; these tables touch none of theirs and run in name order.)
--
-- CLEAN START: no data is migrated into any of these tables. The old intelligence tables are untouched here.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- agent_runs          one row per run of the agent: skill + version, trigger, the model actually used, status and
--                     stop reason, tokens / web searches / cost in micro-dollars, and the trace itself (steps, tools
--                     called, evidence read) as jsonb. The per-day cost cap sums cost_micro_usd since UTC midnight.
-- memory_facts        EVIDENCE: one sourced fact (subject, claim, said|found|measured|made, source url or ref, date,
--                     confidence 0–1, active|superseded|disputed). A fact with no source is refused by a CHECK.
-- memory_briefs       BRIEF: the current read of the athlete, versioned; at most one 'current' per athlete.
-- memory_decisions    DECISIONS + OUTCOMES: suggested, why, evidence refs, her response, what happened, and the
--                     approval item it became.
-- memory_preferences  PREFERENCES: voice, avoid, standing rules, style; said or inferred; active or retired.
--
-- CHANGES: pending_actions_kind_check widens to ('send_reply','agent_action'): an act-level agent tool call waits in
-- the existing approval queue as an 'agent_action' row. Existing rows are all 'send_reply', so the new check holds.
--
-- Additive apart from that widening. Every statement re-runs as a no-op (IF NOT EXISTS, or DROP-then-ADD of a named
-- constraint). Names and definitions are written exactly as a shared/schema.ts push produces them. No transaction
-- control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

CREATE TABLE IF NOT EXISTS agent_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id          uuid NOT NULL,
  skill_id            text NOT NULL,
  skill_version       text NOT NULL,
  trigger             text NOT NULL,
  provider            text NOT NULL,
  model               text NOT NULL,
  effort              text NOT NULL,
  status              text DEFAULT 'running' NOT NULL,
  stop_reason         text,
  conversation_id     uuid,
  input_tokens        integer DEFAULT 0 NOT NULL,
  cached_input_tokens integer DEFAULT 0 NOT NULL,
  output_tokens       integer DEFAULT 0 NOT NULL,
  reasoning_tokens    integer DEFAULT 0 NOT NULL,
  web_search_calls    integer DEFAULT 0 NOT NULL,
  cost_micro_usd      bigint DEFAULT 0 NOT NULL,
  steps               jsonb DEFAULT '[]'::jsonb NOT NULL,
  tools_called        jsonb DEFAULT '[]'::jsonb NOT NULL,
  evidence_read       jsonb DEFAULT '[]'::jsonb NOT NULL,
  error               text,
  started_at          timestamp with time zone DEFAULT now() NOT NULL,
  ended_at            timestamp with time zone,
  CONSTRAINT agent_runs_trigger_check CHECK (trigger IN ('chat','schedule','event','approval','test')),
  CONSTRAINT agent_runs_status_check CHECK (status IN ('running','completed','failed','stopped')),
  CONSTRAINT agent_runs_effort_check CHECK (effort IN ('minimal','low','medium','high')),
  CONSTRAINT agent_runs_stop_reason_check CHECK (stop_reason IS NULL OR stop_reason IN ('cost_cap_run','cost_cap_day','max_steps','policy','aborted','error')),
  CONSTRAINT agent_runs_ended_check CHECK ((status = 'running') = (ended_at IS NULL)),
  CONSTRAINT agent_runs_cost_check CHECK (cost_micro_usd >= 0)
);

CREATE TABLE IF NOT EXISTS memory_facts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id    uuid NOT NULL,
  subject_kind  text NOT NULL,
  subject_name  text NOT NULL,
  subject_id    text,
  claim         text NOT NULL,
  type          text NOT NULL,
  source_url    text,
  source_ref    text,
  source_title  text,
  observed_on   date,
  confidence    double precision NOT NULL,
  status        text DEFAULT 'active' NOT NULL,
  superseded_by uuid,
  run_id        uuid,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,
  updated_at    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT memory_facts_type_check CHECK (type IN ('said','found','measured','made')),
  CONSTRAINT memory_facts_status_check CHECK (status IN ('active','superseded','disputed')),
  CONSTRAINT memory_facts_subject_kind_check CHECK (subject_kind IN ('athlete','brand','organization','person','event','content','other')),
  CONSTRAINT memory_facts_source_check CHECK (source_url IS NOT NULL OR source_ref IS NOT NULL),
  CONSTRAINT memory_facts_confidence_check CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT memory_facts_claim_check CHECK (length(claim) BETWEEN 1 AND 2000)
);

CREATE TABLE IF NOT EXISTS memory_briefs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id uuid NOT NULL,
  version    integer NOT NULL,
  status     text DEFAULT 'current' NOT NULL,
  summary    text NOT NULL,
  sections   jsonb DEFAULT '[]'::jsonb NOT NULL,
  fact_ids   jsonb DEFAULT '[]'::jsonb NOT NULL,
  run_id     uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT memory_briefs_status_check CHECK (status IN ('current','superseded')),
  CONSTRAINT memory_briefs_version_check CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS memory_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id      uuid NOT NULL,
  run_id          uuid,
  skill_id        text NOT NULL,
  suggested       text NOT NULL,
  why             text NOT NULL,
  evidence        jsonb DEFAULT '[]'::jsonb NOT NULL,
  response        text DEFAULT 'pending' NOT NULL,
  response_reason text,
  responded_at    timestamp with time zone,
  outcome         text DEFAULT 'unknown' NOT NULL,
  outcome_note    text,
  outcome_at      timestamp with time zone,
  approval_id     uuid,
  created_at      timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT memory_decisions_response_check CHECK (response IN ('pending','accepted','edited','skipped','expired')),
  CONSTRAINT memory_decisions_outcome_check CHECK (outcome IN ('unknown','worked','mixed','did_not_work'))
);

CREATE TABLE IF NOT EXISTS memory_preferences (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id uuid NOT NULL,
  kind       text NOT NULL,
  statement  text NOT NULL,
  source     text NOT NULL,
  status     text DEFAULT 'active' NOT NULL,
  run_id     uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  retired_at timestamp with time zone,
  CONSTRAINT memory_preferences_kind_check CHECK (kind IN ('voice','avoid','standing_rule','style')),
  CONSTRAINT memory_preferences_source_check CHECK (source IN ('said','inferred')),
  CONSTRAINT memory_preferences_status_check CHECK (status IN ('active','retired')),
  CONSTRAINT memory_preferences_statement_check CHECK (length(statement) BETWEEN 1 AND 1000)
);

-- ── pending_actions: the approval queue gains the agent's kind ──
ALTER TABLE pending_actions DROP CONSTRAINT IF EXISTS pending_actions_kind_check;
ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_kind_check CHECK (kind IN ('send_reply','agent_action'));

-- ── foreign keys ──
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_athlete_id_athletes_id_fk;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_facts_athlete_id_athletes_id_fk;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_facts_superseded_by_memory_facts_id_fk;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_superseded_by_memory_facts_id_fk
  FOREIGN KEY (superseded_by) REFERENCES public.memory_facts(id) ON DELETE set null ON UPDATE no action;
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_facts_run_id_agent_runs_id_fk;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_run_id_agent_runs_id_fk
  FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE set null ON UPDATE no action;

ALTER TABLE memory_briefs DROP CONSTRAINT IF EXISTS memory_briefs_athlete_id_athletes_id_fk;
ALTER TABLE memory_briefs ADD CONSTRAINT memory_briefs_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;
ALTER TABLE memory_briefs DROP CONSTRAINT IF EXISTS memory_briefs_run_id_agent_runs_id_fk;
ALTER TABLE memory_briefs ADD CONSTRAINT memory_briefs_run_id_agent_runs_id_fk
  FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE set null ON UPDATE no action;

ALTER TABLE memory_decisions DROP CONSTRAINT IF EXISTS memory_decisions_athlete_id_athletes_id_fk;
ALTER TABLE memory_decisions ADD CONSTRAINT memory_decisions_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;
ALTER TABLE memory_decisions DROP CONSTRAINT IF EXISTS memory_decisions_run_id_agent_runs_id_fk;
ALTER TABLE memory_decisions ADD CONSTRAINT memory_decisions_run_id_agent_runs_id_fk
  FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE set null ON UPDATE no action;
ALTER TABLE memory_decisions DROP CONSTRAINT IF EXISTS memory_decisions_approval_id_pending_actions_id_fk;
ALTER TABLE memory_decisions ADD CONSTRAINT memory_decisions_approval_id_pending_actions_id_fk
  FOREIGN KEY (approval_id) REFERENCES public.pending_actions(id) ON DELETE set null ON UPDATE no action;

ALTER TABLE memory_preferences DROP CONSTRAINT IF EXISTS memory_preferences_athlete_id_athletes_id_fk;
ALTER TABLE memory_preferences ADD CONSTRAINT memory_preferences_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;
ALTER TABLE memory_preferences DROP CONSTRAINT IF EXISTS memory_preferences_run_id_agent_runs_id_fk;
ALTER TABLE memory_preferences ADD CONSTRAINT memory_preferences_run_id_agent_runs_id_fk
  FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE set null ON UPDATE no action;

-- ── indexes ──
CREATE INDEX IF NOT EXISTS idx_agent_runs_athlete_started ON agent_runs USING btree (athlete_id, started_at);
CREATE INDEX IF NOT EXISTS idx_memory_facts_athlete_status ON memory_facts USING btree (athlete_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS memory_briefs_athlete_version_uq ON memory_briefs USING btree (athlete_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS memory_briefs_one_current_uq ON memory_briefs USING btree (athlete_id) WHERE status = 'current';
CREATE INDEX IF NOT EXISTS idx_memory_decisions_athlete_created ON memory_decisions USING btree (athlete_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_preferences_athlete_status ON memory_preferences USING btree (athlete_id, status);
