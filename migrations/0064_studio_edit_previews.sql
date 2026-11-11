-- 0064_studio_edit_previews.sql — an edit's result is held as a PREVIEW, never as a library row,
-- until she accepts it (Studio PR 9, Lane 1). 0062 is PR 7's (media_assets.origin gains 'reference');
-- 0063 is the objectives PR's (#573) — this file was 0063 until 23 Sep 2026 and was applied to dev under
-- that number; the table is the same, and the file is a no-op where it already ran.
--
-- A file is only ever applied because scripts/db-migrate.sh names it in the step-3 list — there is
-- no glob — so this file, that line, and the shared/schema.ts declaration ship in ONE commit, or the
-- HARD drift gate (step 5, server/scripts/checkSchemaDrift.ts) reds the deploy that merged half of
-- them. DDL cleared by Adi (his lane) on the PR 9 opening report: its own table, NOT a media_assets
-- row with a special status — "a mutation you can't name cleanly is a law you can't enforce".
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────
--
-- ONE new table and nothing else. No ALTER of an existing table, no DROP, no UPDATE, no backfill.
-- Only the edit routes (server/studio/edit/routes.ts) read or write it, behind STUDIO_IMAGE_EDIT_OPS
-- (a 404 when off), so the pre-0064 image is unaffected by its existence and the rollback story is
-- "do nothing".
--
--   studio_edit_previews   one row per typed edit she asked for on one of her photos: the op and its
--                          params, the quote it was priced under (a studio_generation_previews row —
--                          the same quote machine every generation uses), the job that ran it, and
--                          WHERE THE RESULT BYTES SIT while she decides: an object under
--                          athletes/<id>/studio/edit-previews/, not her library. `status` is the
--                          whole story: quoted → running → ready → accepted | discarded, or failed.
--                          Accept is the ONE step that writes media_assets (origin 'generated',
--                          derived_from_asset_id = the source); `accepted_asset_id` records it.
--                          Discard deletes the object. `batch_id` groups the candidates one quote
--                          bought from one source (the ad carousel, Lane 4).
--
-- ── TENANCY IS PER ATHLETE, AND THE DATABASE HOLDS THE LINE ─────────────────────────────────────
--
-- athlete_id NOT NULL on every row, and every read in code filters by the athlete the route
-- resolved. The source is her row (code checks it through herPhoto before a quote exists).
--
-- ── DELETION ────────────────────────────────────────────────────────────────────────────────────
--
--   athlete deleted        → her edit previews CASCADE.
--   source asset deleted   → CASCADE. A preview of a photo that is gone has nothing to be accepted
--                            onto; the object under edit-previews/ is swept by code, not by the DB.
--   quote row deleted      → preview_id SET NULL. The quote's ttl is the quote's; the result outlives it.
--   job deleted            → job_id SET NULL.
--   accepted asset deleted → accepted_asset_id SET NULL. The record that she accepted stays.
--
-- NO CHECK on params jsonb: the shape is validated in code (server/studio/edit/ops.ts, zod per op).
-- op and status ARE checked: a value outside the closed list is a bug caught at the write. Every
-- constraint is INLINE in its CREATE TABLE, so it is created with the table or not at all.
-- db-migrate.sh applies each file with `psql -f` and NO --single-transaction, so every statement
-- autocommits alone; the migration test reproduces that.

CREATE TABLE IF NOT EXISTS studio_edit_previews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id          uuid NOT NULL,
  -- The photo the op transforms. Hers (herPhoto), verified before the quote (the source gate).
  source_asset_id     uuid NOT NULL,
  -- The typed op. The five of PR 9; a sixth is a migration, on purpose.
  op                  text NOT NULL,
  -- The op's params, validated in code per op.
  params              jsonb DEFAULT '{}'::jsonb NOT NULL,
  -- The candidates one quote bought from one source (Lane 4), or null for a single edit.
  batch_id            uuid,
  -- The quote (studio_generation_previews) this row was priced under, or null once that row is gone.
  preview_id          uuid,
  -- The generation job that ran it, or null before the run / once the job row is gone.
  job_id              uuid,
  status              text DEFAULT 'quoted' NOT NULL,
  -- The result bytes, under athletes/<id>/studio/edit-previews/ — NEVER a library path.
  gcs_path            text,
  content_type        text,
  bytes               integer,
  width               integer,
  height              integer,
  -- What she was quoted, and what the provider reported once it ran.
  cost_quoted_usd     numeric,
  cost_usd            numeric,
  -- The media_assets row accept wrote, or null.
  accepted_asset_id   uuid,
  error               text,
  created_at          timestamptz DEFAULT now() NOT NULL,
  ran_at              timestamptz,
  decided_at          timestamptz,
  expires_at          timestamptz NOT NULL,

  CONSTRAINT studio_edit_previews_athlete_id_athletes_id_fk
    FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE,
  CONSTRAINT studio_edit_previews_source_asset_id_media_assets_id_fk
    FOREIGN KEY (source_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE,
  CONSTRAINT studio_edit_previews_preview_fk
    FOREIGN KEY (preview_id) REFERENCES studio_generation_previews(id) ON DELETE SET NULL,
  CONSTRAINT studio_edit_previews_job_id_generation_jobs_id_fk
    FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE SET NULL,
  CONSTRAINT studio_edit_previews_accepted_asset_id_media_assets_id_fk
    FOREIGN KEY (accepted_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL,
  CONSTRAINT studio_edit_previews_op_check
    CHECK (op IN ('recolour', 'garment', 'product', 'background_clean', 'ad')),
  CONSTRAINT studio_edit_previews_status_check
    CHECK (status IN ('quoted', 'running', 'ready', 'accepted', 'discarded', 'failed'))
);

-- Tenancy first: every read is "her edit previews, newest first".
CREATE INDEX IF NOT EXISTS idx_studio_edit_previews_athlete_created
  ON studio_edit_previews (athlete_id, created_at DESC NULLS LAST);

-- A batch's candidates (partial: a single edit has no batch to look up).
CREATE INDEX IF NOT EXISTS studio_edit_previews_batch_idx
  ON studio_edit_previews (batch_id) WHERE batch_id IS NOT NULL;
