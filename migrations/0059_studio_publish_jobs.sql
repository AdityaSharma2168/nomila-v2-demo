-- 0059_studio_publish_jobs.sql — the queue behind "Post to Instagram" (video, publishing).
--
-- A file is only ever applied because scripts/db-migrate.sh names it in the step-3 list — there is
-- no glob — so this file, that line, and the shared/schema.ts declaration ship in ONE commit, or
-- the HARD drift gate (step 5, server/scripts/checkSchemaDrift.ts) reds the deploy that merged half
-- of them.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────
--
-- ONE new table and nothing else. No ALTER of an existing table, no DROP, no UPDATE, no data
-- movement, no backfill. The pre-0059 image does not read this table and is completely unaffected
-- by its existence, which makes the rollback story "do nothing".
--
-- content_posts is NOT touched. It stays what its own comment says it is — the record of a post
-- that exists — and the runner writes one row there when a post really went out. This table is the
-- queue in front of it: one row per time she pressed "post", including the ones that never posted.
--
-- ── IT HAS 0057's SHAPE AND 0056's POSTURE, AND THAT IS THE POINT ───────────────────────────────
--
-- The lease columns are copied from studio_stitch_jobs. The failure posture is NOT. A stitch is
-- idempotently retryable, so 0057's reaper requeues a lapsed job always. A publish is the opposite:
-- an instance that dies between Instagram accepting the publish and us storing the handle, requeued,
-- POSTS THE SAME VIDEO TO HER REAL ACCOUNT TWICE. So this table carries the submit-once pair 0056
-- gave generation_jobs, under its own names:
--
--   publish_attempted_at   written BEFORE the publish call
--   ig_media_id            written AFTER it
--
-- and the runner's rule is that the publish call is made AT MOST ONCE PER ROW, EVER. A row found
-- (attempted, no media id) is read back from Instagram — the container says PUBLISHED when the post
-- exists — and if that cannot settle it the job fails closed and is never re-sent. The full
-- argument is on the table in shared/schema.ts.
--
-- ── WHY 0056's RACE CANNOT HAPPEN HERE ──────────────────────────────────────────────────────────
--
-- Same as 0057: every constraint — the primary key, all three foreign keys and both CHECKs — is
-- declared INLINE in the CREATE TABLE, so it is created with the table or not at all. db-migrate.sh
-- applies each file with `psql -f` and NO --single-transaction, so every statement autocommits
-- alone; there is no DROP + ADD pair below for a concurrent run or a mid-DDL death to land between.
-- server/studio/publish/jobs.migration.test.ts fails if one is ever added.
--
-- There is deliberately NO CHECK on `platform`. It is the one vocabulary here certain to grow, and
-- widening a CHECK is exactly that DROP + ADD pair. The route accepts a closed list; the runner
-- refuses a platform it has no publisher for.
--
-- ── NOT A SPEND SURFACE ─────────────────────────────────────────────────────────────────────────
--
-- Posting costs nothing. There is no provider, no model and no cost column, so studio/jobs.ts
-- spentTodayUsd — which sums generation_jobs.cost_estimated_usd — cannot be moved by anything here.
-- What it guards is not money. It is a public post on a real person's account.

CREATE TABLE IF NOT EXISTS studio_publish_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id            uuid NOT NULL,

  -- The video being posted. AN ID, NEVER A PATH — the runner resolves it against athlete_id at
  -- claim time, so a client-supplied path is never stored and never signed.
  -- Nullable ONLY because the foreign key is SET NULL (see below). The route always writes it.
  asset_id              uuid,

  -- THE ACCOUNT SHE CONFIRMED. The confirm step says "this posts to @handle now" and an athlete may
  -- hold more than one Instagram row, so the route pins the one she saw and the runner never picks.
  connected_account_id  uuid,

  platform              text NOT NULL,
  caption               text NOT NULL DEFAULT '',

  -- 'dry' | 'live', frozen from STUDIO_PUBLISH_MODE at the tap. A live send needs THIS to say live
  -- AND the process to say live, so a dry row can never go out because the variable was flipped
  -- while it waited.
  mode                  text NOT NULL,

  -- Born 'queued'. There is no inline path for a publish, so 'pending' has no meaning here.
  status                text NOT NULL DEFAULT 'queued',
  last_error            text,
  -- A closed code beside the sentence, so the client can offer the right next step.
  error_code            text,

  -- The resume handle, NOT a guard: an unpublished container is invisible and expires in 24h, so a
  -- duplicate costs nothing. A runner that finds one resumes it instead of starting again.
  container_id          text,
  container_created_at  timestamptz,
  poll_count            integer NOT NULL DEFAULT 0,

  -- THE SUBMIT-ONCE PAIR. The order of these two writes is the whole guarantee.
  publish_attempted_at  timestamptz,
  ig_media_id           text,
  permalink             text,

  -- The lease. Same mechanism as 0056/0057.
  lease_until           timestamptz,
  lease_holder          text,
  attempts              integer NOT NULL DEFAULT 0,

  created_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  completed_at          timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT studio_publish_jobs_athlete_id_athletes_id_fk
    FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE,
  -- SET NULL, never cascade, on both of these: "we posted this to her Instagram" has to outlive the
  -- asset being swept and the account being disconnected. It is the only record on our side that a
  -- public post came from here.
  CONSTRAINT studio_publish_jobs_asset_id_media_assets_id_fk
    FOREIGN KEY (asset_id) REFERENCES media_assets(id) ON DELETE SET NULL,
  -- Named by hand: the generated name is 65 characters and Postgres truncates at 63.
  CONSTRAINT studio_publish_jobs_connected_account_fk
    FOREIGN KEY (connected_account_id) REFERENCES connected_accounts(id) ON DELETE SET NULL,
  CONSTRAINT studio_publish_jobs_status_check
    CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  CONSTRAINT studio_publish_jobs_mode_check
    CHECK (mode IN ('dry','live'))
);

-- Tenancy first: every read is "this athlete's posts, newest first".
CREATE INDEX IF NOT EXISTS idx_studio_publish_jobs_athlete
  ON studio_publish_jobs (athlete_id, created_at DESC NULLS LAST);

-- The claim query's index: queued rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_studio_publish_jobs_claim
  ON studio_publish_jobs (status, created_at) WHERE status = 'queued';

-- The reaper's index: running rows whose lease has lapsed.
CREATE INDEX IF NOT EXISTS idx_studio_publish_jobs_lease
  ON studio_publish_jobs (lease_until) WHERE status = 'running';

-- THE DOUBLE-TAP GUARD. One live job per video per platform: two taps are one post, enforced where
-- a race between two requests cannot get past it. A finished row does not hold the slot, so posting
-- the same video again later stays possible and stays her decision.
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_publish_jobs_live
  ON studio_publish_jobs (asset_id, platform) WHERE status IN ('queued','running');
