-- 0035_first_look.sql — the first look (what an athlete's own posts say about them), stored as a
-- document on the snapshot row the connect produced. Outside scoring's inputs by design.
-- Also admits the 'first_look' snapshot trigger; 'signup' was already allowed.

ALTER TABLE "athlete_snapshots" ADD COLUMN IF NOT EXISTS "first_look" jsonb;

ALTER TABLE "athlete_snapshots" DROP CONSTRAINT IF EXISTS "snapshots_trigger_check";
ALTER TABLE "athlete_snapshots" ADD CONSTRAINT "snapshots_trigger_check"
  CHECK ("trigger" IN ('signup','social_connect','inbox_connect','scheduled_refresh','manual','re_enrich','first_look'));
