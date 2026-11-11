-- 0095_payments_checkout_expires_at.sql — one live Stripe Checkout session per payment (payments PR 2).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- payments.checkout_expires_at — nullable timestamptz, no default, no backfill. When the Checkout session in
--   payments.stripe_checkout_session_id lapses (Checkout is now created with an explicit expires_at). The pay link
--   reuses that session while it is open instead of minting a new one on every visit (the double-charge bug), and
--   a re-quote expires it. Legacy rows stay NULL; the pay link then checks the stored session with Stripe.
--
-- Additive: one nullable column — a catalog-only change, no table rewrite. Re-runs as a no-op. No transaction
-- control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS checkout_expires_at timestamptz;
