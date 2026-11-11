-- 0033 — the prompt registry: where a prompt's live text comes from.
--
-- ── HOW THIS REACHES PROD ────────────────────────────────────────────────────
-- Not through this file. The executor is the idempotent psql block in
-- .github/workflows/deploy.yml, same as 0022, 0027 and 0032. This file records intent and is
-- the text to paste. NOTHING HERE HAS BEEN RUN.
--
-- Additive only: one new table, no column added to and no constraint changed on any existing
-- table. Nothing reads it until PROMPT_REGISTRY=true, which is absent from
-- gcp/cloud-run-v2.yaml, so applying this is inert in prod today.
--
-- ── WHY THE TABLE EXISTS ─────────────────────────────────────────────────────
-- Fourteen prompts live as module-level constants, which means changing one is a code change,
-- a review, a build and a deploy — and the person who most needs to change them is the founder,
-- who should not need any of those four things to reword a tagline instruction. It also means
-- a run recorded in Langfuse cannot be explained later, because the prompt it ran under has
-- since been edited in place and is gone.
--
-- So: one row per VERSION, never edited in place. A prompt that made a decision last week is
-- still readable this week.
--
-- ── WHAT THIS TABLE DELIBERATELY DOES NOT DECIDE ─────────────────────────────
-- Whether a prompt may be changed at runtime. The classifier, the scorer and the contract
-- extractor decide money and carry compliance weight, and they resolve to the reviewed
-- in-code constant no matter what is published here. That is enforced by LOCKED_PROMPTS in
-- server/lib/promptRegistry.ts — in CODE, before any query — because if lockedness lived in
-- this table then an unreachable database, or an edited row, would decide whether a money
-- prompt can be swapped.
--
-- There is deliberately NO `locked` column. Nothing would read it, and an inert flag that
-- looks authoritative is worse than no flag at all: someone sets it to false, expects that
-- prompt to become editable, and nothing changes.

CREATE TABLE IF NOT EXISTS prompts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable dotted identifier the code asks for, e.g. 'classify.system'. Never renamed: a
  -- rename silently detaches every historical version from its call site.
  key          text NOT NULL,
  version      integer NOT NULL,
  body         text NOT NULL,
  -- draft -> published -> archived. The resolver reads ONLY published rows, so a half-written
  -- draft can sit here with no chance of reaching a model.
  status       text NOT NULL DEFAULT 'draft',
  -- First 12 of sha1(body). Matches what evalClassifier.ts already computes for its cache key,
  -- so an eval result and a registry row line up by eye.
  hash         text NOT NULL,
  note         text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT prompts_status_check CHECK (status IN ('draft', 'published', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS prompts_key_version_uq ON prompts (key, version);

-- At most one published version per key, enforced by the DATABASE rather than by application
-- care. Two published rows would make resolution order arbitrary, and a prompt that changes
-- depending on row order is close to undebuggable. Same partial-unique shape as
-- idx_scoring_weights_active.
CREATE UNIQUE INDEX IF NOT EXISTS prompts_one_published_uq ON prompts (key) WHERE status = 'published';

-- Deliberately NO seed rows. An empty table is the correct initial state: the resolver falls
-- through to the in-code constants, which is exactly today's behaviour. Seeding copies of the
-- constants here would create two sources of truth on day one and guarantee they drift.
