-- 0039_asserted_source_settings.sql — the record's screen writes to the same ledger.
--
-- PR A (The Athlete Record). Every fact the athlete states goes through athlete_asserted, whichever
-- door it came in by: the first entry (onboarding), a chat or voice turn, or now the Brand tab's
-- Facts screen and the profile confirm cards ('settings'). Widening the check is the whole change;
-- no row is touched. Idempotent: DROP IF EXISTS + ADD.

ALTER TABLE "athlete_asserted" DROP CONSTRAINT IF EXISTS "athlete_asserted_source_check";
ALTER TABLE "athlete_asserted" ADD CONSTRAINT "athlete_asserted_source_check"
  CHECK ("source" IN ('onboarding','chat','voice','settings'));
