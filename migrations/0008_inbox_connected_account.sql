-- Record which connected inbox received each thread/message so replies route
-- through that same connection. A Gmail threadId (and the message itself) only
-- exists inside the mailbox that received it, so sending a reply through an
-- arbitrary active Gmail connection breaks threading and sends from the wrong
-- address when a user has multiple inboxes connected.
-- Rows ingested before this migration stay NULL — the reply path resolves the
-- receiving inbox lazily (Gmail messages.get probe) and writes the id back.
-- ON DELETE SET NULL: disconnecting an inbox hard-deletes its connected_accounts
-- row (routes/connections.ts); the inbox rows must survive that.
-- Idempotent (matches migrations/0006_instagram_page_id.sql style).
ALTER TABLE "inbox_threads" ADD COLUMN IF NOT EXISTS "connected_account_id" uuid;
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "connected_account_id" uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inbox_threads_connected_account_id_connected_accounts_id_fk') THEN
    ALTER TABLE "inbox_threads" ADD CONSTRAINT "inbox_threads_connected_account_id_connected_accounts_id_fk"
      FOREIGN KEY ("connected_account_id") REFERENCES "connected_accounts"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inbox_messages_connected_account_id_connected_accounts_id_fk') THEN
    ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_connected_account_id_connected_accounts_id_fk"
      FOREIGN KEY ("connected_account_id") REFERENCES "connected_accounts"("id") ON DELETE SET NULL;
  END IF;
END $$;
