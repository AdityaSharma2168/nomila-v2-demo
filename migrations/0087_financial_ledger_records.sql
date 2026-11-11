-- 0087_financial_ledger_records.sql — a de-identified financial ledger kept after account deletion (#803).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- financial_ledger_records — when an athlete deletes her account, each of her payments in which money moved or was
--   held leaves one row here (server/lib/privacy/financialRecords.ts) and the payment itself is deleted. Amounts,
--   currency, status and the Stripe ids an accountant reconciles against Stripe. No athlete, deal, installment,
--   Connect account, brand email, metadata or failure reason, and NO foreign keys: nothing here leads back to her.
--   retention_category 'financial_record': purged after FINANCIAL_RECORD_RETENTION_DAYS (TBD pending
--   counsel/accountant confirmation) by server/scripts/privacy/purgeExpiredFinancialRecords.ts.
--
-- Additive: one new table. Every statement re-runs as a no-op. Names and definitions are written exactly as a
-- shared/schema.ts push produces them. No transaction control here (migrationsGuard): dry-run this file ON ITS
-- OWN in BEGIN … ROLLBACK.

CREATE TABLE IF NOT EXISTS financial_ledger_records (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                      text NOT NULL,
  status                    text NOT NULL,
  deal_value_cents          integer,
  commission_cents          integer,
  processing_fee_cents      integer,
  brand_total_cents         integer,
  currency                  text NOT NULL,
  stripe_payment_intent_id  text,
  stripe_charge_id          text,
  stripe_transfer_id        text,
  stripe_refund_id          text,
  payment_created_at        timestamptz,
  deidentified_at           timestamptz NOT NULL DEFAULT now(),
  retention_category        text NOT NULL DEFAULT 'financial_record'
);
