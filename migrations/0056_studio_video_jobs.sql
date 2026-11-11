-- 0056_studio_video_jobs.sql — the detached video execution model (A6.1).
--
-- Renumbered from 0040: that number was taken by 0040_weights_v7_1_no_story_arc_bonus while this work
-- sat unmerged on studio-video-foundation. A file is only ever applied because scripts/db-migrate.sh
-- names it in the step-3 list (:145-156) — there is no glob — so this file and that line and the
-- shared/schema.ts declarations ship in ONE commit, or the HARD drift gate reds the deploy that
-- merged half of them (studio-ddl-path).
--
-- ADDITIVE. No UPDATE, no DROP COLUMN, no data movement. Safe to re-run every deploy, and safe to
-- re-run CONCURRENTLY with a second copy of itself — see "the pair that broke two deploys" below.
--
-- WHY THIS EXISTS: image generation runs INLINE inside the request (~24-56s, fine). Veo video is ~63s
-- at the BEST case and studio/config.ts already permits polling for 600s — held open with no bytes
-- flowing, that is the shape Google's load balancer drops. So video is DETACHED: the request queues a
-- job and returns; a leased runner works it; the client polls. These columns are the lease and the
-- submit-once guard that make that safe to run on three Cloud Run instances.
--
-- ── THE PAIR THAT BROKE TWO DEPLOYS ──────────────────────────────────────────────────────────────
--
-- Widening a CHECK is a DROP + ADD pair, because Postgres has no ADD CONSTRAINT IF NOT EXISTS: the
-- DROP can be guarded and the ADD cannot. db-migrate.sh applies each file with `psql -f` and NO
-- --single-transaction, so every statement autocommits on its own and the gap between the two is
-- durable. That gap has cost this repo two outages:
--
--   1. THE INTERLEAVE. deploy-dev.yml:16-24 — PRs #140 + #141, two merges 14s apart on 2026-08-06,
--      ran the payments block concurrently. Run A dropped payments_status_check; run B's DROP then
--      reported "does not exist, skipping"; A re-added it; B's ADD died with "constraint already
--      exists", failing the deploy before the image was ever built.
--   2. THE MID-DDL DEATH. 9038d5d (#357) — agent_actions_action_check. A live row already held a
--      value the new list omitted, so the ADD failed on validation. The DROP had already committed,
--      so the constraint was left ABSENT IN PRODUCTION, and every later deploy died at the same ADD:
--      #353, #356 and #355 never shipped. Nothing caught it, because the step-5 drift gate
--      (server/scripts/checkSchemaDrift.ts) compares tables and columns and does not look at
--      constraints at all. A vanished CHECK is invisible to it.
--
-- The two failures need different fixes and BOTH are in place:
--
--   * The INTERLEAVE is handled by the workflow, not by this file: deploy-dev.yml and deploy-prod.yml
--     declare `concurrency: { cancel-in-progress: false }`, so two deploys against one database queue
--     instead of racing. That covers merge-triggered and dispatched runs. It does NOT cover a
--     hand-run — db-migrate.sh's own USAGE block documents one (:56-58), and
--     docs/plans/production-environment-split.md:193 prescribes one against PROD as a no-op
--     verification. So the DO block below is the second layer there, not the only one.
--   * The MID-DDL DEATH is handled HERE, and serialization structurally cannot help with it — a run
--     that dies between its own DROP and its own ADD is a single run. deploy-dev.yml:22-24 says as
--     much: cancel-in-progress is false precisely because cancelling "would kill a run mid-DDL,
--     between a DROP and its matching ADD, leaving the constraint missing in prod". That is a
--     mitigation, not a fix. The fix is to stop the gap from being durable.
--
-- HOW THE DO BLOCK FIXES IT: a DO block is ONE statement, so psql sends it as one implicit
-- transaction, and the DROP and the ADD commit together or not at all. ALTER TABLE takes
-- ACCESS EXCLUSIVE on generation_jobs and holds it to the end of that transaction, so the moment
-- where the constraint is absent is never observable by another session and never survives a crash.
-- If the ADD fails — the #357 case — the DROP rolls back with it and the OLD constraint is still
-- standing. The deploy still fails, loudly, which is correct; what it no longer does is leave the
-- table unguarded on its way out.

-- ── Lease: who is working this job, and until when ───────────────────────────────────────────────
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS lease_until   timestamptz;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS lease_holder  text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS attempts      integer NOT NULL DEFAULT 0;

-- ── Submit-once: the guard that makes a lease handoff free instead of double-billed ──────────────
-- submit_attempted_at is written BEFORE the provider call; provider_operation_name AFTER it.
-- A runner only submits when BOTH are NULL. With an operation name present it RESUMES POLLING that
-- operation — the Veo job is still running at Vertex, so re-submitting would buy a second copy of a
-- video we already own.
-- The pair (attempted, still no name) is the ORPHAN WINDOW and it FAILS CLOSED: never re-submitted.
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS submit_attempted_at     timestamptz;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS provider_operation_name text;

-- ── Poll bookkeeping (observability; nothing branches on these) ──────────────────────────────────
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS poll_count     integer NOT NULL DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS last_polled_at timestamptz;

-- ── 'queued' joins the status vocabulary ─────────────────────────────────────────────────────────
-- queued = the approval is spent and the job is owed, but no provider call has been made. It is the
-- state that lets POST /studio/generate return without blocking.
--
-- The guard is "does the vocabulary already admit 'queued'", NOT equality with the exact definition
-- this file writes. That is deliberate. db-migrate.sh re-runs EVERY file on EVERY deploy in numeric
-- order, so this file runs before any later one. Under strict equality, the day a 0060 widens the
-- status vocabulary again, this file would re-narrow it on every subsequent deploy and the two would
-- fight forever. Asking only for the value this file owns lets a later widening stand.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'generation_jobs'::regclass
       AND conname  = 'generation_jobs_status_check'
       AND pg_get_constraintdef(oid) LIKE '%queued%'
  ) THEN
    RETURN;   -- already widened: the re-run, and the loser of a race, both land here
  END IF;

  ALTER TABLE generation_jobs DROP CONSTRAINT IF EXISTS generation_jobs_status_check;
  ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_status_check
    CHECK (status IN ('pending','queued','running','succeeded','failed','canceled'));
END
$$;

-- ── One provider operation per job, enforced by the database ─────────────────────────────────────
-- The application guard is a conditional UPDATE (studio/videoJobs.ts recordOperationName); this is
-- the layer that still holds against a bug, a script, or code not yet written. Partial: every image
-- job leaves it NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_operation
  ON generation_jobs (provider_operation_name)
  WHERE provider_operation_name IS NOT NULL;

-- ── The claim query's index: queued rows, oldest first ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_generation_jobs_claim
  ON generation_jobs (status, created_at) WHERE status = 'queued';

-- ── The reaper's index: running rows whose lease has lapsed ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_generation_jobs_lease
  ON generation_jobs (lease_until) WHERE status = 'running';

-- ── Keep the existing status index covering the new state ────────────────────────────────────────
-- idx_generation_jobs_status is partial on ('pending','running') and would stop covering a queued
-- job — i.e. exactly the in-flight work it exists to find. It has to be REPLACED rather than left
-- half-useful, and a partial index's predicate cannot be altered in place.
--
-- Same DO treatment, for the same reason and one more: this pair is DROP-then-CREATE, so a run that
-- dies between them leaves the table with no status index at all until the next deploy. That is a
-- performance cliff on the claim path rather than a correctness hole, which is why it is the lesser
-- of the two — but it costs four lines to make it atomic, and it lets the ADDITIVE banner at the top
-- of this file be true rather than aspirational.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'idx_generation_jobs_status'
       AND indexdef LIKE '%queued%'
  ) THEN
    RETURN;
  END IF;

  DROP INDEX IF EXISTS idx_generation_jobs_status;
  CREATE INDEX idx_generation_jobs_status
    ON generation_jobs (status, created_at)
    WHERE status IN ('pending','queued','running');
END
$$;
