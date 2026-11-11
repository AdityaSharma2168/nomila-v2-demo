-- Additive DDL: columns, tables and check constraints accumulated 2026-07 → 2026-09.
--
-- Extracted VERBATIM from .github/workflows/deploy.yml on 2026-09-08 (PR B of the
-- environment split). This was the inline `psql -c` block that every deploy re-ran;
-- it is idempotent and now runs from this file, in the same order, via
-- scripts/db-migrate.sh — in dev and in prod alike. Nothing here is in the drizzle
-- journal; the re-baseline (docs/plans/production-environment-split.md, Track D)
-- folds it into 0000_baseline.
-- Apply additive DDL directly — drizzle-kit push blocks on unique constraints
-- in non-TTY environments (Ink requires TTY for its interactive prompts).
-- These statements are idempotent and safe on existing data.

ALTER TABLE inbox_threads ADD COLUMN IF NOT EXISTS conversation_state jsonb;
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS external_message_id text;
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS attachments jsonb;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inbox_messages_thread_external_uniq') THEN ALTER TABLE inbox_messages ADD CONSTRAINT inbox_messages_thread_external_uniq UNIQUE (thread_id, external_message_id); END IF; END $$;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS photo_url text;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS socials jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS referral_code text;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS saved boolean DEFAULT false;
ALTER TABLE card_shares ADD COLUMN IF NOT EXISTS custom_html text;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'none';
ALTER TABLE deals ADD COLUMN IF NOT EXISTS deposit_status text DEFAULT 'none';
ALTER TABLE deals ADD COLUMN IF NOT EXISTS deal_group_id uuid;
CREATE INDEX IF NOT EXISTS idx_deals_group ON deals (deal_group_id);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS amount_cash numeric;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS amount_product numeric;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS commission_pct numeric;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS term_start date;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS term_end date;
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_payment_status_check;
ALTER TABLE deals ADD CONSTRAINT deals_payment_status_check CHECK (payment_status IN ('none','payment_requested','funded','delivered_pending_confirmation','settled','refunded','disputed'));
-- deals_deposit_status_check is OWNED by 0103 (CHECK OWNERSHIP RULE, see 0063): only add it if absent, NOT VALID.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deals_deposit_status_check') THEN ALTER TABLE deals ADD CONSTRAINT deals_deposit_status_check CHECK (deposit_status IN ('none','held','released','expired','credited')) NOT VALID; END IF; END $$;
ALTER TABLE inbox_brands ADD COLUMN IF NOT EXISTS is_agency boolean DEFAULT false;
ALTER TABLE inbox_brands ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE inbox_brands ADD COLUMN IF NOT EXISTS images jsonb;
ALTER TABLE social_analytics_snapshots ADD COLUMN IF NOT EXISTS posts_last_30d integer;
ALTER TABLE social_analytics_snapshots ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'connected';
ALTER TABLE social_analytics_snapshots ALTER COLUMN connected_account_id DROP NOT NULL;
ALTER TABLE social_analytics_snapshots DROP CONSTRAINT IF EXISTS sas_source_check;
ALTER TABLE social_analytics_snapshots ADD CONSTRAINT sas_source_check CHECK (source IN ('connected','discovery','research','provider'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_sas_athlete_platform_day ON social_analytics_snapshots (athlete_id, platform, snapshot_day);
ALTER TABLE golden_athletes ADD COLUMN IF NOT EXISTS ground_truth_source text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_golden_athletes_athlete ON golden_athletes (athlete_id);
-- (athletes_current.rate_card was added here; dropped by 0126 — legacy retirement — so no longer re-added.)
CREATE TABLE IF NOT EXISTS media_assets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), athlete_id uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE, platform text NOT NULL, origin text NOT NULL, source_media_id text, parent_media_id text, derived_from_asset_id uuid, media_type text NOT NULL, permalink text, caption text, posted_at timestamptz, like_count integer, comments_count integer, insights jsonb, gcs_path text, gcs_thumb_path text, content_type text, bytes bigint, width integer, height integer, status text NOT NULL, metadata jsonb, ingested_at timestamptz, metadata_updated_at timestamptz, created_at timestamptz DEFAULT now(), CONSTRAINT media_assets_status_check CHECK (status IN ('stored','failed','skipped_size')));
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_assets_source ON media_assets (athlete_id, platform, source_media_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_athlete ON media_assets (athlete_id, posted_at DESC);
CREATE TABLE IF NOT EXISTS media_backfill_state (athlete_id uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE, platform text NOT NULL, cursor text, status text NOT NULL DEFAULT 'pending', items_seen integer NOT NULL DEFAULT 0, last_error text, updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(), PRIMARY KEY (athlete_id, platform));
CREATE TABLE IF NOT EXISTS pending_actions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), athlete_id uuid NOT NULL REFERENCES athletes(id), deal_id uuid REFERENCES deals(id), thread_id uuid REFERENCES inbox_threads(id), kind text NOT NULL, status text NOT NULL DEFAULT 'pending', payload jsonb NOT NULL, result jsonb, error text, created_at timestamptz DEFAULT now(), expires_at timestamptz, approved_at timestamptz, dismissed_at timestamptz, executed_at timestamptz, CONSTRAINT pending_actions_kind_check CHECK (kind IN ('send_reply')), CONSTRAINT pending_actions_status_check CHECK (status IN ('pending','approved','dismissed','failed')));
CREATE INDEX IF NOT EXISTS idx_pending_actions_athlete_status ON pending_actions (athlete_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_pending_actions_deal ON pending_actions (deal_id);
CREATE TABLE IF NOT EXISTS agent_actions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), athlete_id uuid NOT NULL REFERENCES athletes(id), action text NOT NULL, deal_id uuid REFERENCES deals(id), thread_id uuid REFERENCES inbox_threads(id), reason text, reversible boolean NOT NULL DEFAULT false, held_until timestamptz, undone_at timestamptz, payload jsonb, result jsonb, created_at timestamptz DEFAULT now(), CONSTRAINT agent_actions_action_check CHECK (action IN ('file','auto_decline','reclassify','mute_sender','reopen','auto_archive','profile_write')));
CREATE INDEX IF NOT EXISTS idx_agent_actions_athlete_created ON agent_actions (athlete_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_actions_deal ON agent_actions (deal_id);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS conversation_id uuid;
CREATE INDEX IF NOT EXISTS idx_chat_conversation ON chat_messages (athlete_id, conversation_id, created_at);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS source text;
CREATE TABLE IF NOT EXISTS voice_context (conversation_id uuid PRIMARY KEY, athlete_id uuid NOT NULL REFERENCES athletes(id), deals_discussed jsonb NOT NULL DEFAULT '[]'::jsonb, brands_discussed jsonb NOT NULL DEFAULT '[]'::jsonb, open_threads jsonb NOT NULL DEFAULT '[]'::jsonb, last_voice_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_voice_context_athlete ON voice_context (athlete_id, last_voice_at);
ALTER TABLE voice_context ADD COLUMN IF NOT EXISTS drafts_opened jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS brand_fit_narratives (athlete_id uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE, brand_id integer NOT NULL REFERENCES inbox_brands(id) ON DELETE CASCADE, audience text NOT NULL, credibility text NOT NULL, whitespace text NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), PRIMARY KEY (athlete_id, brand_id));
CREATE TABLE IF NOT EXISTS conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), athlete_id uuid NOT NULL REFERENCES athletes(id), title text, summary text, summary_through_message_id uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_conversations_athlete_updated ON conversations (athlete_id, updated_at);
-- agent_actions_action_check is OWNED by 0094 (CHECK OWNERSHIP RULE, see 0063): only add it if absent, NOT VALID.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_actions_action_check') THEN ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_action_check CHECK (action IN ('file','auto_decline','reclassify','mute_sender','reopen','auto_archive','profile_write','confirm_signed','split_deal')) NOT VALID; END IF; END $$;
ALTER TABLE athletes DROP CONSTRAINT IF EXISTS athletes_status_check;
ALTER TABLE athletes ADD CONSTRAINT athletes_status_check CHECK (status IN ('waitlisted','raw','enriched','claimed','active'));
ALTER TABLE account_roles DROP CONSTRAINT IF EXISTS account_roles_role_check;
ALTER TABLE account_roles ADD CONSTRAINT account_roles_role_check CHECK (role IN ('athlete','fan','brand','school_admin','admin'));
ALTER TABLE notification_log DROP CONSTRAINT IF EXISTS notif_type_check;
ALTER TABLE notification_log ADD CONSTRAINT notif_type_check CHECK (type IN ('new_deal','weekly_brief','brand_match','promotion'));
