-- 0037_athlete_asserted.sql — what the athlete told us, in their own words, one fact per row.
--
-- PR 3 (first entry). Onboarding is the one place Mila writes a profile fact without a Save tap:
-- the athlete corrects something she said in the greeting ("I'm a midfielder, not a forward")
-- and it lands here — attributed (mode, run), receipted (agent_actions kind 'profile_write'),
-- undoable (retracted_at, and the receipt's Undo restores the column it touched). Table, not
-- jsonb, because facts accumulate and get superseded one at a time; a document would be replaced
-- whole and lose who said what.

CREATE TABLE IF NOT EXISTS "athlete_asserted" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "athlete_id"       uuid NOT NULL REFERENCES "athletes"("id"),
  -- The fact's name from a fixed vocabulary (server/mila/onboarding.ts ASSERTED_FIELDS).
  "field"            text NOT NULL,
  -- The fact, as a small JSON value ({ "text": "midfielder" }); shape per field.
  "value"            jsonb NOT NULL,
  -- The athlete's own words the fact came from, when the conversation had them. Short.
  "said"             text,
  -- Which conversation wrote it.
  "source"           text NOT NULL DEFAULT 'onboarding',
  "mode"             text,
  -- The workflow run that recorded it (no FK: runs may be pruned; the fact outlives them).
  "run_id"           uuid,
  -- The receipt that lets the athlete undo it.
  "agent_action_id"  uuid REFERENCES "agent_actions"("id"),
  -- A newer assertion for the same field points back from here.
  "superseded_by"    uuid REFERENCES "athlete_asserted"("id"),
  -- Undo stamps this; the row stays as history.
  "retracted_at"     timestamptz,
  "created_at"       timestamptz DEFAULT now(),
  CONSTRAINT "athlete_asserted_source_check" CHECK ("source" IN ('onboarding','chat','voice')),
  CONSTRAINT "athlete_asserted_mode_check"   CHECK ("mode" IS NULL OR "mode" IN ('chat','voice','form'))
);

CREATE INDEX IF NOT EXISTS "idx_athlete_asserted_athlete_field"
  ON "athlete_asserted" ("athlete_id", "field", "created_at");

-- The receipt log learns one more verb: a profile fact Mila wrote from the athlete's words.
-- OWNED by 0094 since it widened the list (CHECK OWNERSHIP RULE, see 0063): re-running must never re-narrow it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_actions_action_check') THEN
    ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_action_check"
      CHECK ("action" IN ('file','auto_decline','reclassify','mute_sender','reopen','auto_archive','profile_write')) NOT VALID;
  END IF;
END $$;
