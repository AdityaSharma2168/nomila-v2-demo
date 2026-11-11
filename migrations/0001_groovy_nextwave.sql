-- Transition migration: switches from drizzle-kit push to versioned migrate.
-- IF NOT EXISTS guards make every statement safe to re-run on DBs where
-- push already applied some of these columns.
ALTER TABLE "athletes" ADD COLUMN IF NOT EXISTS "deal_preferences" jsonb;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN IF NOT EXISTS "sync_cursor" text;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "platform" text DEFAULT 'gmail';--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "gmail_thread_id" text;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "gmail_message_id_header" text;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "sender_ig_user_id" text;--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD COLUMN IF NOT EXISTS "external_thread_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_threads_external_thread_id" ON "inbox_threads" USING btree ("external_thread_id");