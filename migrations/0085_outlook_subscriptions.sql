-- 0085_outlook_subscriptions.sql — Microsoft Graph change notifications for Outlook (Outlook PR 1).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- outlook_subscriptions — one Graph subscription per Outlook connection, written only when OUTLOOK_PUSH is on.
--   A notification is a "sync now" signal: the webhook stamps sync_requested_at and a debounced worker runs the
--   EXISTING delta sync. connected_accounts.sync_cursor (the @odata.deltaLink) stays the sync position.
--   client_state_hash is sha256 of the clientState — the raw value is never stored.
--
-- Additive: one new table. Every statement re-runs as a no-op. Names and definitions are written exactly as a
-- shared/schema.ts push produces them (outlookSubscriptions.migration.test.ts pins that). No transaction control
-- here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

CREATE TABLE IF NOT EXISTS outlook_subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connected_account_id   uuid NOT NULL CONSTRAINT outlook_subscriptions_connected_account_id_connected_accounts_id_fk REFERENCES connected_accounts(id) ON DELETE CASCADE,
  graph_subscription_id  text NOT NULL,
  resource               text NOT NULL,
  expires_at             timestamptz NOT NULL,
  client_state_hash      text NOT NULL,
  status                 text NOT NULL DEFAULT 'active',
  last_notification_at   timestamptz,
  sync_requested_at      timestamptz,
  sync_started_at        timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outlook_subscriptions_status_check CHECK (status IN ('active','reauthorize_required','removed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS outlook_subscriptions_connection_uq ON outlook_subscriptions (connected_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS outlook_subscriptions_graph_id_uq ON outlook_subscriptions (graph_subscription_id);
CREATE INDEX IF NOT EXISTS outlook_subscriptions_expires_idx ON outlook_subscriptions (expires_at);
