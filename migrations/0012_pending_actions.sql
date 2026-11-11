-- WS3 §3.6 — pending_actions: the co-pilot spine.
--
-- Additive only. Hand-written (not `drizzle-kit generate`) on purpose: this branch's
-- schema.ts has drifted ahead of the migration snapshot (recent tables — card_shares,
-- media_assets, social_analytics changes — were applied to the live DB via `db:push`,
-- not captured in migrations/meta). A generated diff therefore tries to (re)create /
-- alter everything that already exists live, which would be destructive. This file
-- creates ONLY the new table so it applies cleanly against the current dev DB, the
-- same net effect `db:push` produces for a single new table.

CREATE TABLE "pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"deal_id" uuid,
	"thread_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	CONSTRAINT "pending_actions_kind_check" CHECK ("pending_actions"."kind" IN ('send_reply')),
	CONSTRAINT "pending_actions_status_check" CHECK ("pending_actions"."status" IN ('pending','approved','dismissed','failed'))
);
--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_thread_id_inbox_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."inbox_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pending_actions_athlete_status" ON "pending_actions" USING btree ("athlete_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_pending_actions_deal" ON "pending_actions" USING btree ("deal_id");
