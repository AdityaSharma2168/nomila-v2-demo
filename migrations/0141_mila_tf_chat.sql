-- 0141_mila_tf_chat.sql — Mila's chat on TrueForge, step 2 (docs/design/mila-on-trueforge-step2.md §4).
--
-- Two tables, used only while MILA_TF_CHAT is on (dev). With the flag off nothing reads or writes them: production gets
-- two empty tables on its next deploy and nothing else.
--   mila_tf_sessions    one row per app conversation: its TrueForge session, the tools' shared state across turns (fact
--                       keys, connectors offered, her own words) with a compare-and-set counter, and app events Mila
--                       has not been told yet (an approval tapped or declined).
--   mila_tf_turn_items  what one turn's tool calls left for the app (cards, approvals, evidence, the tool-call record),
--                       written by the MCP server, taken and deleted by the chat endpoint when the turn ends.
-- Both are deleted with the athlete (ON DELETE CASCADE; athleteDataManifest lists them); a turn's items go with its
-- agent_runs row.
--
-- Pure DDL, additive only (expand): two new tables and their indexes; nothing else is touched. Idempotent (IF NOT
-- EXISTS throughout), safe to re-run, which scripts/db-migrate.sh does on every deploy. No transaction control here
-- (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names
-- it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in ONE commit or the drift gate
-- reds the deploy. Nothing here names an athlete, sport, school or brand.

CREATE TABLE IF NOT EXISTS mila_tf_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  conversation_id uuid,
  tf_session_id   text NOT NULL,
  tool_state      jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_version   integer NOT NULL DEFAULT 0,
  pending_events  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mila_tf_sessions_conversation ON mila_tf_sessions USING btree (athlete_id, conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mila_tf_sessions_tf_session ON mila_tf_sessions USING btree (tf_session_id);

CREATE TABLE IF NOT EXISTS mila_tf_turn_items (
  id         serial PRIMARY KEY,
  athlete_id uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  run_id     uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  payload    jsonb NOT NULL,
  CONSTRAINT mila_tf_turn_items_kind_check CHECK (kind IN ('card','approval','evidence','tool'))
);

CREATE INDEX IF NOT EXISTS idx_mila_tf_turn_items_run ON mila_tf_turn_items USING btree (run_id, id);
