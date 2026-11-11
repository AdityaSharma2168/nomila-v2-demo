-- 0047_research_planner — Phase A Step 2b: research lifecycle / domain refresh planner
-- (design docs/architecture/phase-a/step2b-research-lifecycle-design.md §8.1, frozen 11 Sep 2026).
--
-- Additive only: two tables, eight columns, four indexes, one CHECK. IF NOT EXISTS throughout;
-- nothing dropped, renamed or retyped. Existing research_runs rows (none on dev) satisfy the new
-- CHECK because Step 2a only ever writes domain = 'full'. Nothing here runs unless BOTH
-- RESEARCH_REFRESH_ENABLED and RESEARCH_SUBSTRATE_WRITE are true (the one execution gate).

-- ── research_planner_runs ─────────────────────────────────────────────────────
-- One row per planner pass (Cloud Scheduler, the internal route or the script; dry_run or
-- enqueue). In dry_run this is the ONLY table the planner writes.
CREATE TABLE IF NOT EXISTS research_planner_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  status            text NOT NULL DEFAULT 'running',       -- running | ok | failed | skipped
  mode              text NOT NULL,                         -- dry_run | enqueue
  as_of             timestamptz NOT NULL,
  policy_version    text NOT NULL,                         -- research_policy version or 'defaults'
  evaluated         integer NOT NULL DEFAULT 0,
  would_materialize integer NOT NULL DEFAULT 0,            -- athletes without a state row (virtual in dry_run)
  transitions       jsonb NOT NULL DEFAULT '{}'::jsonb,    -- {"seed_only>identity_resolved": n, …, "applied": bool}
  candidates        integer NOT NULL DEFAULT 0,
  admitted          integer NOT NULL DEFAULT 0,
  deferred          jsonb NOT NULL DEFAULT '{}'::jsonb,    -- by reason: budget | run_over_cap | failure_backoff | active_run
  budget            jsonb NOT NULL DEFAULT '{}'::jsonb,    -- {limit, executedToday, reserved, planned}
  plans             jsonb NOT NULL DEFAULT '[]'::jsonb,    -- admitted [{athleteId, domains, trigger, reserveCalls, estUsd, workflowRunId?}], capped at 200
  leak_refusals     integer NOT NULL DEFAULT 0,
  error             jsonb,
  CONSTRAINT research_planner_runs_status_check CHECK (status IN ('running','ok','failed','skipped')),
  CONSTRAINT research_planner_runs_mode_check   CHECK (mode IN ('dry_run','enqueue'))
);
CREATE INDEX IF NOT EXISTS research_planner_runs_started_idx ON research_planner_runs (started_at DESC);

-- ── research_budget_days ──────────────────────────────────────────────────────
-- The authoritative per-UTC-day counters, reserved ATOMICALLY (one conditional UPDATE) before
-- every Gemini/Kimi attempt, retries included (§5.1). Non-LLM lanes are counted separately and
-- never touch llm_attempts.
CREATE TABLE IF NOT EXISTS research_budget_days (
  day               date PRIMARY KEY,
  llm_attempts      integer NOT NULL DEFAULT 0,            -- Gemini + Kimi attempts, retries included (maxLlmCallsPerNight)
  signal_calls      integer NOT NULL DEFAULT 0,            -- Trends + GDELT (signals lane)
  other_calls       integer NOT NULL DEFAULT 0,            -- discovery and other non-LLM API calls (maxOtherCallsPerNight)
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── athlete_research_state: event queue, failure back-off, planning marks ─────
ALTER TABLE athlete_research_state
  ADD COLUMN IF NOT EXISTS pending          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{domain, trigger, reason, requestedAt}]
  ADD COLUMN IF NOT EXISTS refresh_failures jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {domain: {count, lastOutcome, lastError, deferredUntil, disputeRechecks}}
  ADD COLUMN IF NOT EXISTS last_planned_at  timestamptz;
-- (athlete_research_state_due_idx already exists from 0046)

-- ── research_runs: workflow link, as-of, per-run lane counters, ledger index, domain vocabulary ──
ALTER TABLE research_runs
  ADD COLUMN IF NOT EXISTS workflow_run_id uuid,
  ADD COLUMN IF NOT EXISTS as_of           timestamptz,                            -- the run's retrievedAt: the monotonic freshness key (§3.2)
  ADD COLUMN IF NOT EXISTS llm_attempts    integer NOT NULL DEFAULT 0,             -- reserved per attempt against maxCallsPerRun
  ADD COLUMN IF NOT EXISTS signal_calls    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_calls     integer NOT NULL DEFAULT 0;             -- `calls` (Step 2a) stays the total
-- At most ONE successful canonical run per workflow run (at-least-once step safety, §6).
CREATE UNIQUE INDEX IF NOT EXISTS research_runs_workflow_success ON research_runs (workflow_run_id)
  WHERE workflow_run_id IS NOT NULL AND status IN ('ok','partial');
CREATE INDEX IF NOT EXISTS research_runs_started_idx ON research_runs (started_at);
ALTER TABLE research_runs DROP CONSTRAINT IF EXISTS research_runs_domain_check;
ALTER TABLE research_runs ADD CONSTRAINT research_runs_domain_check
  CHECK (domain IN ('identity','profile','affiliations','achievements','press','brand_mentions','narrative','social_handles','signals','full','refresh'));
