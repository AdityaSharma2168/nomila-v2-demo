-- Instagram messaging is page-scoped: the DM/conversations + send + webhook
-- subscription APIs all key off the Facebook Page backing the IG Business account,
-- not the IG user id. Persist that Page ID per connection so the backfill/sync path
-- can call /{page-id}/conversations?platform=instagram and the webhook receiver can
-- route incoming events back to the right connection.
-- Idempotent (ADD COLUMN IF NOT EXISTS) to stay safe on databases already synced via
-- the deploy.yml hand-DDL block (matches migrations/0005_promotion_admin_roles.sql style).
ALTER TABLE "connected_accounts" ADD COLUMN IF NOT EXISTS "ig_page_id" text;
