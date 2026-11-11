-- 0072_creative_intents.sql — the CreativeIntent persistence spine (campaign-creative-seam-checkpoint.md §5/§16,
-- creative-intent-forcing.md §12 step 1).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- creative_intents — one row per creative work requested, BEFORE conception: her words / a campaign deliverable /
--   a planner commission, with why, constraints and lineage. NO mutable status: every lifecycle question is derived
--   from downstream records (interpretations, studio_plans, generation_jobs, media_assets) through creative_intent_id.
--   `withdrawn_at` is the only mutable column. `intent_key` is the idempotency identity (athlete ask ref; later
--   campaign:deliverable:unit; later planner:plan:index).
-- creative_interpretations — Creative Intelligence's output for one intent: the existing BriefProposal shape
--   (brief + extras) and its InferenceFlags, versioned per intent (`supersedes`), confirmed by the athlete
--   (`confirmed_at`, `confirmed_concept`, `confirmed_format_class` — the one thing a confirmation may establish that the
--   ask did not). Nothing strategic is copied here; it is reachable through the intent.
-- Two additive NULLABLE lineage columns: studio_plans.creative_intent_id, generation_jobs.creative_intent_id.
-- No status enum, no AssetSpec, no campaign-scoped table, no studio_plan_id on jobs (the plan id already rides the
-- frozen brief as campaign.planId).

CREATE TABLE IF NOT EXISTS creative_intents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id        uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  version           text NOT NULL,
  intent_key        text NOT NULL,
  source_kind       text NOT NULL,
  source_ref        text NOT NULL,
  purpose           text NOT NULL,
  why               text,
  audience_role     text,
  brand_id          integer,
  format            jsonb NOT NULL DEFAULT '{"class":null,"quantity":null,"dueOn":null,"fixedBy":null}'::jsonb,
  channel           text,
  timing            text,
  constraints       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ask               jsonb,
  lineage           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  withdrawn_at      timestamptz,
  CONSTRAINT creative_intents_source_kind_check CHECK (source_kind IN ('planner', 'campaign', 'athlete'))
);
CREATE UNIQUE INDEX IF NOT EXISTS creative_intents_athlete_key ON creative_intents (athlete_id, intent_key);
CREATE INDEX IF NOT EXISTS idx_creative_intents_athlete_created ON creative_intents (athlete_id, created_at DESC);

CREATE TABLE IF NOT EXISTS creative_interpretations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id              uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  creative_intent_id      uuid NOT NULL REFERENCES creative_intents(id) ON DELETE CASCADE,
  version                 integer NOT NULL DEFAULT 1,
  supersedes              uuid REFERENCES creative_interpretations(id) ON DELETE SET NULL,
  source_tool             text NOT NULL,
  proposal                jsonb NOT NULL,
  flags                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  confirmed_at            timestamptz,
  confirmed_concept       jsonb,
  confirmed_format_class  text,
  confirmed_flags         jsonb
);
CREATE INDEX IF NOT EXISTS idx_creative_interpretations_intent ON creative_interpretations (creative_intent_id, version DESC);

ALTER TABLE studio_plans    ADD COLUMN IF NOT EXISTS creative_intent_id uuid REFERENCES creative_intents(id) ON DELETE SET NULL;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS creative_intent_id uuid REFERENCES creative_intents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_studio_plans_creative_intent ON studio_plans (creative_intent_id) WHERE creative_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generation_jobs_creative_intent ON generation_jobs (creative_intent_id) WHERE creative_intent_id IS NOT NULL;

-- BriefOrigin gains `athlete` (athlete-authored request; `inbound` stays external/untrusted text, `system` stays Nomila-originated).
ALTER TABLE generation_jobs DROP CONSTRAINT IF EXISTS generation_jobs_origin_check;
ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_origin_check CHECK (origin IN ('system','inbound','athlete'));
