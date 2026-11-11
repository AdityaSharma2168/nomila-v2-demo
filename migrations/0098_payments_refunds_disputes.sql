-- 0098_payments_refunds_disputes.sql — refunds, chargebacks and transfer reversals (payments PR 4).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- payments — seven nullable columns, no defaults, no backfill:
--   refunded_cents, refunded_at, refund_reason, refund_requested_by (athlete | admin | stripe) — written by the
--     tap-gated refund action (server/services/payments/refund.ts) and by charge.refunded (dashboard refunds).
--   stripe_transfer_reversal_id — money pulled back from the athlete's connected account after release.
--   stripe_dispute_id, dispute_status — a card-network chargeback (charge.dispute.*), distinct from the brand's
--     delivery dispute on the confirm page.
-- payments_status_check gains 'charged_back' (a chargeback the platform lost: terminal, the money is gone).
-- financial_ledger_records — refunded_cents, stripe_transfer_reversal_id, stripe_dispute_id, so the de-identified
--   ledger an account deletion leaves (#803) still reconciles refunds and chargebacks against Stripe.
--
-- Additive: new nullable columns plus a WIDER status check (every existing value stays valid). Re-runs as a no-op.
-- No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_cents integer;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_reason text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_requested_by text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_transfer_reversal_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_dispute_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS dispute_status text;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending','requires_action','authorized','reauthorized','funded','settled','released','expired','refunded','canceled','failed','disputed','charged_back'));

ALTER TABLE financial_ledger_records ADD COLUMN IF NOT EXISTS refunded_cents integer;
ALTER TABLE financial_ledger_records ADD COLUMN IF NOT EXISTS stripe_transfer_reversal_id text;
ALTER TABLE financial_ledger_records ADD COLUMN IF NOT EXISTS stripe_dispute_id text;
