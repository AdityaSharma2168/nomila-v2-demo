-- WS5 §5B — agent_actions: the receipt log.
--
-- Additive only. Hand-written (not `drizzle-kit generate`) on purpose, same reason
-- as 0010: this branch's schema.ts has drifted ahead of the migration snapshot
-- (recent tables were applied to the live DB via `db:push`, not captured in
-- migrations/meta). A generated diff would try to (re)create / alter everything
-- that already exists live, which would be destructive. This file creates ONLY the
-- new table so it applies cleanly against the current dev DB — the same net effect
-- `db:push` produces for a single new table.
--
-- Append-only receipt of actions Nomila took on the athlete's behalf (The Week /
-- co-pilot trail). Rows are never deleted; the only post-insert writes are the
-- reversal stamps (undone_at, result). `held_until` is the 24h auto-decline hold.

CREATE TABLE "agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"action" text NOT NULL,
	"deal_id" uuid,
	"thread_id" uuid,
	"reason" text,
	"reversible" boolean DEFAULT false NOT NULL,
	"held_until" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"payload" jsonb,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "agent_actions_action_check" CHECK ("agent_actions"."action" IN ('file','auto_decline','reclassify','mute_sender','reopen'))
);
--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_thread_id_inbox_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."inbox_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_actions_athlete_created" ON "agent_actions" USING btree ("athlete_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_actions_deal" ON "agent_actions" USING btree ("deal_id");
