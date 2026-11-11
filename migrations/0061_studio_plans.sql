-- 0061_studio_plans.sql — a plan is a stored, versioned object (Studio PR 6, lane 6a3).
--
-- A file is only ever applied because scripts/db-migrate.sh names it in the step-3 list — there is
-- no glob — so this file, that line, and the shared/schema.ts declaration ship in ONE commit, or the
-- HARD drift gate (step 5, server/scripts/checkSchemaDrift.ts) reds the deploy that merged half of
-- them. DDL cleared by Adi (his lane) on the PR 6 opening report, deal_deliverable_id in.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────
--
-- ONE new table and nothing else. No ALTER of an existing table, no DROP, no UPDATE, no backfill.
-- Only POST/GET /studio/agent/plan… read or write it, behind STUDIO_AGENT (a 404 when off), so the
-- pre-0061 image is unaffected by its existence and the rollback story is "do nothing".
--
--   studio_plans   one row per plan the planner produced: the brief it was planned from (a
--                  CampaignBrief, when there was one), the brief file she uploaded (for PR 7 to read),
--                  the concept she picked, the plan itself — items with their reasons, gaps, look,
--                  music — and its place in a lineage: a regenerate writes a CHILD row, version + 1,
--                  parent_plan_id the row it came from. Rows are never edited.
--
-- ── TENANCY IS PER ATHLETE, AND THE DATABASE HOLDS THE LINE ─────────────────────────────────────
--
-- athlete_id NOT NULL on every row. The parent FK is composite, (parent_plan_id, athlete_id) →
-- (id, athlete_id), backed by UNIQUE (id, athlete_id): a child can only descend from a plan OF THE
-- SAME ATHLETE. Code checks it too; the FK is the part a bug in code cannot get past.
--
-- ── DELETION ────────────────────────────────────────────────────────────────────────────────────
--
--   athlete deleted             → her plans CASCADE, all in one statement.
--   parent plan deleted alone   → REFUSED while a child points at it (NO ACTION). Nothing deletes a
--                                 single plan today. The drafted `ON DELETE SET NULL
--                                 (parent_plan_id)` runs on PGlite and Postgres 15, but Drizzle 0.39
--                                 cannot declare a column list, so the parity test against schema.ts
--                                 (studioPlans.migration.test.ts) could not hold it — and a bare SET
--                                 NULL on this composite key would null athlete_id too. NO ACTION is
--                                 the fallback Adi approved; the athlete cascade is tested to pass.
--   deal deliverable deleted    → deal_deliverable_id SET NULL. Her plan outlives the deal row.
--
-- NO CHECK on anything jsonb: the shapes are validated in code (studio/campaign/brief.ts, the
-- planner's parser). Every constraint is INLINE in its CREATE TABLE, so it is created with the table
-- or not at all. db-migrate.sh applies each file with `psql -f` and NO --single-transaction, so every
-- statement autocommits alone; the migration test reproduces that.

CREATE TABLE IF NOT EXISTS studio_plans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id           uuid NOT NULL,
  -- The row this one was regenerated from, or null for a first plan.
  parent_plan_id       uuid,
  -- 1 for a first plan; the parent's + 1 for a regenerate. Written by code from the parent it read.
  version              integer DEFAULT 1 NOT NULL,
  -- The CampaignBrief it was planned from (studio/campaign/brief.ts, zod-validated), or null.
  brief                jsonb,
  -- Her uploaded brief, as an object path under studio-briefs/<athleteId>/ — PR 7 reads it. Or null.
  brief_file_path      text,
  -- The concept she picked (lane 6c), or null.
  concept              jsonb,
  -- The plan as the route answered it: items (reasons folded in), gaps, look, music.
  plan                 jsonb NOT NULL,
  -- The deal deliverable this plan is for, or null. Optional for Mia; SET NULL on the deal side.
  deal_deliverable_id  uuid,
  created_at           timestamptz DEFAULT now() NOT NULL,

  CONSTRAINT studio_plans_athlete_id_athletes_id_fk
    FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE,
  CONSTRAINT studio_plans_deal_deliverable_id_deal_deliverables_id_fk
    FOREIGN KEY (deal_deliverable_id) REFERENCES deal_deliverables(id) ON DELETE SET NULL,
  -- The target of the parent FK. id is already unique; this pair is what lets the database refuse
  -- a child filed under ANOTHER athlete's plan.
  CONSTRAINT studio_plans_id_athlete_unique UNIQUE (id, athlete_id),
  -- Named by hand: the generated name would be long and says less.
  CONSTRAINT studio_plans_parent_fk
    FOREIGN KEY (parent_plan_id, athlete_id) REFERENCES studio_plans(id, athlete_id)
);

-- Tenancy first: every read is "her plans, newest first".
CREATE INDEX IF NOT EXISTS idx_studio_plans_athlete_created
  ON studio_plans (athlete_id, created_at DESC NULLS LAST);

-- A plan's children (as drafted and cleared: partial — a first plan has no parent to look up).
CREATE INDEX IF NOT EXISTS studio_plans_parent_idx
  ON studio_plans (parent_plan_id) WHERE parent_plan_id IS NOT NULL;
