CREATE TABLE "social_analytics_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"connected_account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"snapshot_date" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot_day" date NOT NULL,
	"followers" integer,
	"following" integer,
	"post_count" integer,
	"total_likes" integer,
	"total_channel_views" integer,
	"is_verified" boolean DEFAULT false,
	"reach" integer,
	"impressions" integer,
	"profile_views" integer,
	"avg_engagement_rate" double precision,
	"avg_reach_per_post" integer,
	"avg_views_per_post" integer,
	"avg_shares_per_post" integer,
	"avg_saves_per_post" integer,
	"avg_watch_time_sec" double precision,
	"content_frequency" double precision,
	"top_audience_country" text,
	"top_audience_city" text,
	"top_audience_age_range" text,
	"top_audience_gender" text,
	"raw_metrics" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "sas_platform_check" CHECK ("social_analytics_snapshots"."platform" IN ('instagram','tiktok','youtube'))
);
--> statement-breakpoint
ALTER TABLE "social_analytics_snapshots" ADD CONSTRAINT "social_analytics_snapshots_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_analytics_snapshots" ADD CONSTRAINT "social_analytics_snapshots_connected_account_id_connected_accounts_id_fk" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sas_athlete_platform_date" ON "social_analytics_snapshots" USING btree ("athlete_id","platform","snapshot_date" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sas_account_day" ON "social_analytics_snapshots" USING btree ("connected_account_id","snapshot_day");
