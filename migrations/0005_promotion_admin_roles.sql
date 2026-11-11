-- Promotion mechanism support:
--   1. Allow an 'admin' account role (gates the admin dashboard / promote endpoint).
--   2. Allow a 'promotion' notification type (the "you're in" notification logged on promote).
-- Idempotent (DROP IF EXISTS + re-ADD) to stay safe on databases already synced via
-- the deploy.yml hand-DDL block (matches migrations/0004_special_jetstream.sql style).
ALTER TABLE "account_roles" DROP CONSTRAINT IF EXISTS "account_roles_role_check";--> statement-breakpoint
ALTER TABLE "account_roles" ADD CONSTRAINT "account_roles_role_check" CHECK ("account_roles"."role" IN ('athlete','fan','brand','school_admin','admin'));--> statement-breakpoint
ALTER TABLE "notification_log" DROP CONSTRAINT IF EXISTS "notif_type_check";--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notif_type_check" CHECK ("notification_log"."type" IN ('score_milestone','new_deal','weekly_brief','brand_match','promotion'));
