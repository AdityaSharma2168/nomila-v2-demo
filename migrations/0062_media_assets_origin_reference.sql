-- 0062_media_assets_origin_reference.sql — a picture she POINTED AT is an asset with its own origin
-- (Studio PR 7, Lane C: the direction engine's URL door).
--
-- A file is only ever applied because scripts/db-migrate.sh names it in the step-3 list — there is
-- no glob — so this file, that line, and the shared/schema.ts declaration ship in ONE commit, or
-- the HARD drift gate (step 5, server/scripts/checkSchemaDrift.ts) reds the deploy that merged half
-- of them. DDL cleared by Adi (his lane), 23 Sep 2026: "reference rows are runtime-created rows,
-- that's what DDL is for".
--
-- ── WHAT THIS CHANGES ───────────────────────────────────────────────────────────────────────────
--
-- ONE CHECK constraint widened by ONE value: media_assets_origin_check gains 'reference'. No new
-- table, no column, no index, no UPDATE, no backfill. Nothing on the pre-0062 image writes
-- 'reference', so that image is unaffected by the wider list, and the rollback story is "do
-- nothing" — a narrower re-add is the only thing that could refuse a row this file let in, and no
-- file does one.
--
-- ── WHAT 'reference' MEANS ──────────────────────────────────────────────────────────────────────
--
-- A link she gave the direction engine (POST /studio/direction/decompose-reference, kind "url"):
-- fetched through safeFetch, stored under her prefix, ONE media_assets row under her athlete_id —
-- so a plan row can name it and the reference engine can read it by id. It is NOT her footage.
-- Every reader of her library excludes it: studio/photoPredicate.ts (herPhoto / herClip — the
-- planner's caster, the picker, the stitch), services/mediaSearch.ts (the planner's search and the
-- visible-brands scan), services/mediaEnrichment.ts (never tagged, never embedded) and
-- routes/media.ts (the gallery, its counts, its top row). 'upload' would have made it a photo of
-- her; 'generated' would have poisoned provenance queries. A value of its own is the honest row.
--
-- ── WHY A DO BLOCK ──────────────────────────────────────────────────────────────────────────────
--
-- Widening a CHECK is a DROP + ADD pair — Postgres has no ADD CONSTRAINT IF NOT EXISTS — and
-- db-migrate.sh applies each file with `psql -f` and NO --single-transaction, so two bare
-- statements would autocommit alone with a durable gap between them (0056's lesson: the INTERLEAVE
-- and the MID-DDL DEATH outages). Inside the block the pair is one transaction, and the guard makes
-- the file a no-op once the constraint already lists 'reference': the re-run and the loser of a
-- race both land on RETURN. server/studio/direction/referenceOrigin.migration.test.ts holds all of
-- it against PGlite: refused before, accepted after, still refusing an off-list value, idempotent,
-- and the same vocabulary as schema.ts.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'media_assets'::regclass
       AND conname  = 'media_assets_origin_check'
       AND pg_get_constraintdef(oid) LIKE '%reference%'
  ) THEN
    RETURN;   -- already widened: the re-run, and the loser of a race, both land here
  END IF;

  ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_origin_check;
  ALTER TABLE media_assets ADD CONSTRAINT media_assets_origin_check
    CHECK (origin IN ('connected','discovery','upload','generated','reference'));
END
$$;
