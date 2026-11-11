-- 0086_inbox_messages_body_sha256.sql — a fingerprint of each stored message's text (email privacy, step B).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- inbox_messages.body_sha256 — nullable text, no default, no backfill. Lowercase hex SHA-256 of the message
--   text's UTF-8 bytes after trimming (server/lib/inboxBodyFingerprint.ts, over shared/bodyHash.ts). Written by
--   every insert (Gmail / Outlook / Instagram ingest and the in-app reply). The self-sender echo gate in
--   dealDetector matches an app-sent twin on this fingerprint, so the gate no longer needs the stored body to
--   recognise its own send. Legacy rows stay NULL and keep the old body comparison.
--
-- Additive: one nullable column — a catalog-only change, no table rewrite. Re-runs as a no-op. No transaction
-- control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS body_sha256 text;
