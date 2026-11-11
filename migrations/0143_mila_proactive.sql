-- 0143_mila_proactive.sql — Mila starts the conversation, phase 1 (design "Mila on watch", 27 Oct 2026;
-- server/agent/proactive).
--
-- Used only while MILA_PROACTIVE is on (dev, and off there too until the owner switches it on). With the flag off
-- nothing reads or writes the new table or columns: production gets one empty table, two columns at their defaults and
-- one small partial index on its next deploy, and nothing else.
--   athlete_events            one row per app event Mila may act on (a deal email, a booking request, a payment …),
--                             unique per (athlete, dedupe_key) so a repeated source never logs the same news twice;
--                             payload holds ids and short labels only, never email text. The dispatcher records when
--                             it decided, its outcome, and where Mila's message went.
--   chat_messages.mila_started  true on a message Mila started from an app event (not a reply to the athlete).
--   chat_messages.seen_at       when the athlete saw it; NULL = unread (the Mila tab's dot).
-- athlete_events is deleted with the athlete (ON DELETE CASCADE; athleteDataManifest lists it).
--
-- Pure DDL, additive only (expand): one new table and its indexes, two new columns (a constant default, so no table
-- rewrite on Postgres 11+), one partial index; nothing renamed, dropped or backfilled. Idempotent (IF NOT EXISTS
-- throughout), safe to re-run, which scripts/db-migrate.sh does on every deploy. No transaction control here
-- (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names
-- it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in ONE commit or the drift gate
-- reds the deploy. Nothing here names an athlete, sport, school or brand.

CREATE TABLE IF NOT EXISTS athlete_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  dedupe_key      text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz,
  outcome         text,
  conversation_id uuid,
  message_id      uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_athlete_events_dedupe ON athlete_events USING btree (athlete_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_athlete_events_athlete ON athlete_events USING btree (athlete_id, created_at);

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS mila_started boolean DEFAULT false NOT NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS seen_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_chat_mila_unread ON chat_messages USING btree (athlete_id) WHERE (mila_started AND seen_at IS NULL);
