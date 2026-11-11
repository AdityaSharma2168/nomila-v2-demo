-- 0045_social_sync_runs_trigger_stories — Phase A Step 1b (Instagram Stories).
--
-- The Story sweep and the Story last-look tick open sync runs with trigger = 'stories'. 0044 is
-- released and is not edited; this migration only widens its CHECK constraint. Mirrored in
-- shared/schema.ts (social_sync_runs_trigger_check) so the drift gate and the PGlite tests see
-- the same set. No table, column or index changes.

ALTER TABLE social_sync_runs DROP CONSTRAINT IF EXISTS social_sync_runs_trigger_check;
ALTER TABLE social_sync_runs ADD CONSTRAINT social_sync_runs_trigger_check
  CHECK (trigger IN ('connect','nightly','backfill','discovery','manual','fixture','stories'));
