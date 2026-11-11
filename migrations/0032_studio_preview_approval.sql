-- 0032 — Studio U2: the persisted pre-generation check, and the spend it authorizes.
--
-- ── HOW THIS REACHES PROD ────────────────────────────────────────────────────
-- Not through this file. The executor is the idempotent psql block in
-- .github/workflows/deploy.yml, same as 0022 and 0027. This file records intent and is the
-- text to paste. NOTHING HERE HAS BEEN RUN.
--
-- Additive only: one new table, no column added to and no constraint changed on any existing
-- table. Nothing reads or writes it until STUDIO_ENABLED=true, which is absent from
-- gcp/cloud-run-v2.yaml, so applying this is inert in prod today.
--
-- ── WHY THE TABLE EXISTS ─────────────────────────────────────────────────────
-- Generation is gated on `quoted cost <= the ceiling the athlete approved`. Before U2 that ceiling
-- was a bare function argument. Any route that read it from a request body would make the CLIENT
-- the authority on what the athlete agreed to — a body carrying `approvedCostUsd: 999` would
-- authorize a spend she never saw. (Note the direction: a low figure fails safe and refuses the
-- job; an inflated one is the forgery that costs money.)
--
-- So the ceiling is never sent. The generate request carries `{ previewId }` and no number at all,
-- and the server reads the figure back off the row written by the preview she actually looked at.
-- There is nothing in the request to forge.
--
-- `consumed_at` is the idempotency mechanism. Claiming a preview is ONE atomic guarded UPDATE
-- (SET consumed_at WHERE consumed_at IS NULL), so a double-tapped Generate — or two requests
-- landing on two of the three Cloud Run instances (gcp/cloud-run-v2.yaml maxScale: 3) — resolves
-- to exactly one winner; the loser returns the winner's job id. No advisory lock, no leasing.
-- Contrast generation_jobs, where every call INSERTs: two taps there are two jobs and two charges.

CREATE TABLE IF NOT EXISTS studio_generation_previews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id         uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,

  -- The frozen CreativeBrief this preview was rendered from. Generation re-assembles from THIS,
  -- never from the request, so the job that runs is the job that was quoted.
  brief              jsonb NOT NULL,
  -- The resolved route as shown. Advisory: re-derived at generate time, never trusted from here.
  plan               jsonb,

  -- What she was SHOWN. cost_basis is carried, never recomputed — a preview holds an estimate and
  -- must never be read back as a billed figure.
  cost_usd           numeric,
  cost_basis         text,
  -- true => no price configured for that model. Generation REFUSES rather than spending as if $0.
  unpriced           boolean NOT NULL DEFAULT false,
  status             text NOT NULL,

  consumed_at        timestamptz,
  consumed_by_job_id uuid REFERENCES generation_jobs(id),

  created_at         timestamptz DEFAULT now(),
  expires_at         timestamptz NOT NULL,

  CONSTRAINT studio_previews_status_check CHECK (status IN ('ready','blocked'))
);

-- Tenancy first, like generation_jobs: every read is "this athlete's previews, newest first".
CREATE INDEX IF NOT EXISTS idx_studio_previews_athlete
  ON studio_generation_previews (athlete_id, created_at DESC);

-- The sweep for expired, never-consumed rows.
CREATE INDEX IF NOT EXISTS idx_studio_previews_expiry
  ON studio_generation_previews (expires_at) WHERE consumed_at IS NULL;
