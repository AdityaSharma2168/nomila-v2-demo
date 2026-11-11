-- 0097_payments_brand_confirm_token.sql — the brand's own delivery-confirmation credential (payments PR 3).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- payments.brand_confirm_token_hash — nullable text, no default, no backfill. SHA-256 (hex) of a random token minted
--   when the athlete marks delivered and emailed ONLY to the brand (server/services/payments/brandToken.ts). The
--   brand's confirm / dispute on /confirm/:paymentId now requires that token; the payment id alone no longer
--   releases funds (the athlete could confirm on the brand's behalf). Legacy rows stay NULL: their old confirm
--   links stop working, and the athlete's next "mark delivered" emails the brand a new one; auto-release after the
--   window is unaffected.
--
-- Additive: one nullable column — a catalog-only change, no table rewrite. Re-runs as a no-op. No transaction
-- control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS brand_confirm_token_hash text;
