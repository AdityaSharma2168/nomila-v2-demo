-- 0126_drop_athletes_current_legacy_score_columns.sql — legacy /850 score + v3 rates retirement, P3-1.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list.
--
-- DEPLOY ORDER (deploy-window split): P2-4 → P2-5 → P3-0 (the shared/schema.ts removal, NO DDL) merged AND
-- deployed first, so no running revision still names these columns in its inserts or selects; only then this
-- DDL, in a LATER deploy. Prod: take a backup / snapshot first.
--
-- ── WHAT THIS REMOVES ─────────────────────────────────────────────────────────────────────────────
-- The legacy v7.2 score:          display_score, tier, internal_score, capitals
-- The v3 rate card:               pav, deal_type_rates, rate_card
-- Copies with a real source now:  ig_followers, tk_followers, x_followers, yt_subscribers (the social substrate,
--                                 services/followers.ts); achievements_count, press_count, brand_mentions_count
--                                 (derived from the research by every reader)
-- Bookkeeping of the above:       latest_snapshot_id (and its FK to athlete_snapshots), score_updated_at,
--                                 social_updated_at, spotify_listeners (never written non-null)
--   No reader is left (P2-3's legacyScoreGuard.test.ts; P2-4's writer touches only story_arc, research_updated_at,
--   updated_at). No index, view or other constraint references any of them (checked on dev, 8 Oct 2026). The data
--   export walks the drizzle table, so the columns simply leave it.
--
--   KEPT: athlete_id, story_arc, research_updated_at, updated_at.
--
-- A catalog-only change (no table rewrite). Re-runs as a no-op. No transaction control here (migrationsGuard):
-- dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

ALTER TABLE athletes_current DROP COLUMN IF EXISTS display_score;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS tier;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS internal_score;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS capitals;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS pav;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS deal_type_rates;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS rate_card;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS ig_followers;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS tk_followers;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS x_followers;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS yt_subscribers;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS spotify_listeners;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS achievements_count;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS press_count;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS brand_mentions_count;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS latest_snapshot_id;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS score_updated_at;
ALTER TABLE athletes_current DROP COLUMN IF EXISTS social_updated_at;
