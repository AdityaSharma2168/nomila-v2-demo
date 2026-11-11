-- 0057_studio_stitch_jobs.sql — the detached STITCH execution model (video V7).
--
-- A file is only ever applied because scripts/db-migrate.sh names it in the step-3 list — there is
-- no glob — so this file, that line, and the shared/schema.ts declaration ship in ONE commit, or
-- the HARD drift gate (step 5, server/scripts/checkSchemaDrift.ts) reds the deploy that merged half
-- of them.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────
--
-- ONE new table and nothing else. No ALTER of an existing table, no DROP, no UPDATE, no data
-- movement, no backfill. The pre-0057 image does not read this table and is completely unaffected
-- by its existence, which makes the rollback story "do nothing".
--
-- The assembly UI queues a stitch; a leased runner works it; one ffmpeg call joins the clips
-- (server/studio/video/stitch.ts, merged in V6) and writes one file. Detached for the same reason
-- video generation is: the work outlives a request, and a request held open with no bytes flowing
-- is the shape Google's load balancer drops.
--
-- ── WHY 0056's RACE CANNOT HAPPEN HERE ──────────────────────────────────────────────────────────
--
-- 0056 needed DO-block guards because WIDENING A CHECK is a DROP + ADD pair: Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS, db-migrate.sh applies each file with `psql -f` and NO
-- --single-transaction, so every statement autocommits alone and the gap between the two is
-- durable. That gap cost this repo two outages — the INTERLEAVE (PRs #140 + #141, two deploys 14s
-- apart) and the MID-DDL DEATH (9038d5d/#357, which left agent_actions with no CHECK at all in
-- production and killed three later deploys at the same ADD).
--
-- THIS FILE WRITES NO SUCH PAIR. Every constraint — the primary key, both foreign keys and the
-- status CHECK — is declared INLINE in the CREATE TABLE, so it is created with the table or not at
-- all. There is no intermediate state in which the table exists half-guarded, and therefore nothing
-- for a concurrent run or a mid-DDL death to catch. Re-running is a no-op by the table's own
-- existence (IF NOT EXISTS) rather than by a guard that has to be written correctly.
--
-- Two consequences worth stating, because they are what the revert suite asserts:
--   * the table's OID is UNCHANGED across every re-run — the file never drops and re-creates it;
--   * there is no `DROP CONSTRAINT`, no `DROP INDEX` and no bare `ADD CONSTRAINT` anywhere below,
--     and server/studio/stitchJobs.migration.test.ts fails if one is ever added.
--
-- ── WHY IT IS NOT A ROW IN generation_jobs ──────────────────────────────────────────────────────
--
-- The full argument is on the table in shared/schema.ts. The one-line version, because it is the
-- reason this migration exists at all rather than being three ALTERs:
--
--   studio/videoJobs.ts claimVideoJobs claims `WHERE status = 'queued'` over generation_jobs with
--   NO discriminator. A queued stitch row in that table would be claimed by the VIDEO runner and
--   handed to submitVideoOperation — a paid Vertex call for a job with no brief.
--
-- ── NO SPEND SURFACE ────────────────────────────────────────────────────────────────────────────
--
-- There is deliberately no provider, no model, no cost_estimated_usd, no cost_basis, and no
-- submit-once pair (submit_attempted_at / provider_operation_name). A stitch spends nothing, so
-- this table cannot express a spend, and studio/jobs.ts spentTodayUsd — which sums
-- generation_jobs.cost_estimated_usd — cannot be moved by anything here.
--
-- It is also NOT gated on STUDIO_VIDEO_ENABLED. That flag guards exactly one seam
-- (studio/generate.ts, task === 'video.generate'); assembly is reachable with generation dark.

CREATE TABLE IF NOT EXISTS studio_stitch_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id       uuid NOT NULL,

  -- THE FROZEN TIMELINE: { clips: [{ assetId, trimStartSec?, trimEndSec?, transitionIn? }], bed?, target }.
  -- ASSET IDS, NEVER PATHS — the runner resolves each id against athlete_id at claim time, so a
  -- client-supplied path is never stored and never reaches ffmpeg.
  spec             jsonb NOT NULL,

  -- Born 'queued'. There is no inline path for a stitch, so 'pending' has no meaning here.
  status           text NOT NULL DEFAULT 'queued',
  last_error       text,

  -- The lease. Same mechanism as 0056, opposite failure posture: a stitch is idempotently
  -- retryable, so a lapsed lease goes straight back to the queue and there is no orphan window.
  lease_until      timestamptz,
  lease_holder     text,
  attempts         integer NOT NULL DEFAULT 0,

  -- The single file this job produced. One stitch → exactly one output, which is why the pointer
  -- lives here rather than on media_assets (a generation is one job → many assets, hence
  -- media_assets.generation_job_id). SET NULL: a swept asset must not delete the record of the run.
  output_asset_id  uuid,

  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT studio_stitch_jobs_athlete_id_athletes_id_fk
    FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE,
  CONSTRAINT studio_stitch_jobs_output_asset_id_media_assets_id_fk
    FOREIGN KEY (output_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL,
  CONSTRAINT studio_stitch_jobs_status_check
    CHECK (status IN ('queued','running','succeeded','failed','canceled'))
);

-- Tenancy first: every read is "this athlete's stitches, newest first".
CREATE INDEX IF NOT EXISTS idx_studio_stitch_jobs_athlete
  ON studio_stitch_jobs (athlete_id, created_at DESC NULLS LAST);

-- The claim query's index: queued rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_studio_stitch_jobs_claim
  ON studio_stitch_jobs (status, created_at) WHERE status = 'queued';

-- The reaper's index: running rows whose lease has lapsed.
CREATE INDEX IF NOT EXISTS idx_studio_stitch_jobs_lease
  ON studio_stitch_jobs (lease_until) WHERE status = 'running';
