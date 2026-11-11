-- 0076_brain_substrate.sql — the narrow BrainRun + Recommendation substrate designed in #648
-- (recommendation-substrate-checkpoint.md §2–§5), mounted because production adoption cannot be derived without it
-- (outcome-attribution-forcing.md §9, O3).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- brain_runs           — APPEND-ONLY audit of one Brain evaluation: identity and time, the spec version and both
--                        digests, the inputs AS SEEN, the raw record and the normalised output. No lifecycle, no
--                        status, no reconciliation state: a run is a thing that happened.
-- recommendations      — the governed Recommendation contract already established (recommendation/0.2.0-exp): a stable
--                        id and decision key, the run that produced it, objective lineage, the subject, the strategic
--                        what/why and execution shape in `value`, and FOUR independently transitioning jsonb columns —
--                        response · authz · execution · outcome. `authz` is the contract's `authorization` (the word is
--                        reserved in SQL). No canonical subject state is copied here; no planner, Campaign or Deals field.
-- recommendation_events — APPEND-ONLY governance history, one row per event, ordered by `seq` within a Recommendation.
--
-- The governance invariant is the pure contract's and is unchanged by persistence: a governed active Recommendation is
-- never overwritten or withdrawn by a later run — it takes a `reconsidered_by_run` event and keeps everything else.

CREATE TABLE IF NOT EXISTS brain_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id        uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  as_of             timestamptz NOT NULL,
  spec_version      text NOT NULL,
  canonical_sha256  text NOT NULL,
  prompt_sha256     text NOT NULL,
  model             text NOT NULL,
  variant           text,
  /** The evidence exactly as the evaluator saw it. */
  inputs            jsonb NOT NULL,
  /** The run record: usage, latency, gates, raw text. */
  record            jsonb NOT NULL,
  /** The normalised decisions / deferred / requested. */
  output            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brain_runs_athlete_as_of ON brain_runs (athlete_id, as_of DESC);
CREATE UNIQUE INDEX IF NOT EXISTS brain_runs_athlete_prompt ON brain_runs (athlete_id, prompt_sha256, as_of);

CREATE TABLE IF NOT EXISTS recommendations (
  id             text PRIMARY KEY,
  athlete_id     uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  version        text NOT NULL,
  /** The decision key: source · subject · question · shape · advances (+ intent on a deal). */
  key            text NOT NULL,
  run_id         uuid REFERENCES brain_runs(id) ON DELETE SET NULL,
  source         text NOT NULL,
  subject_kind   text NOT NULL,
  subject_id     text NOT NULL,
  question       text NOT NULL,
  objective_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
  /** what · why · cites · execution shape · relation · advances · notSeen · intent · ends. */
  value          jsonb NOT NULL,
  versions       jsonb NOT NULL,
  runs           jsonb NOT NULL DEFAULT '[]'::jsonb,
  response       jsonb NOT NULL DEFAULT '{"state":"none","at":null,"actor":null}'::jsonb,
  authz          jsonb NOT NULL DEFAULT '{"state":"none","at":null,"actor":null}'::jsonb,
  execution      jsonb NOT NULL DEFAULT '{"state":"none","refs":[]}'::jsonb,
  outcome        jsonb,
  superseded_by  text,
  reconsiders    text,
  closed         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recommendations_athlete_open ON recommendations (athlete_id, closed, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_key ON recommendations (athlete_id, key) WHERE closed = false;
CREATE INDEX IF NOT EXISTS idx_recommendations_subject ON recommendations (athlete_id, subject_kind, subject_id);

CREATE TABLE IF NOT EXISTS recommendation_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id  text NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  athlete_id         uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  seq                integer NOT NULL,
  at                 timestamptz NOT NULL,
  event              text NOT NULL,
  actor              text NOT NULL,
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recommendation_events_seq_unique UNIQUE (recommendation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_recommendation_events_rec ON recommendation_events (recommendation_id, seq);
