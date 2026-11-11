-- 0123_chat_messages_agent_cards.sql — Mila's chat skill (AGENT_V3; off in dev and prod), 10 Oct 2026.
--
-- chat_messages.agent_cards    the cards an assistant turn showed (shared/agent.ts ChatCard[]: goal changes, "Want me to
--                              save that?", connect, quick question, open screen, How I got this), built by code from
--                              what its tools did. The next turn reads them so Mila knows what was shown. NULL on every
--                              other row (user rows, the old loop, voice).
-- chat_messages.agent_run_id   the agent_runs row that produced the turn. A plain uuid, no foreign key (like
--                              conversation_id): deleting runs never blocks on chat rows.
--
-- Additive only: two nullable columns, nothing renamed, dropped or backfilled, no constraint and no index. Re-runs as a
-- no-op (IF NOT EXISTS). Names and types are written exactly as a shared/schema.ts push produces them. No transaction
-- control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because
-- scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in
-- ONE commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS agent_cards jsonb;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS agent_run_id uuid;
