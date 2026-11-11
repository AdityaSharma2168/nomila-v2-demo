-- 0011 — gmail_dead_letters: messages the Gmail webhook dropped (detectDeal threw)
-- after advancing the cursor past them. The inbox cron retries these so a dropped
-- read/older message isn't lost forever. Idempotent.

CREATE TABLE IF NOT EXISTS "gmail_dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connected_account_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"last_attempt_at" timestamp with time zone,
	CONSTRAINT "gmail_dead_letters_conn_msg_uniq" UNIQUE("connected_account_id","gmail_message_id")
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "gmail_dead_letters" ADD CONSTRAINT "gmail_dead_letters_connected_account_id_connected_accounts_id_fk" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "gmail_dead_letters" ADD CONSTRAINT "gmail_dead_letters_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
