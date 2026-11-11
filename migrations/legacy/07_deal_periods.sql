-- Deal periods + installments (migrations/0030).
--
-- Extracted VERBATIM from .github/workflows/deploy.yml on 2026-09-08 (PR B of the
-- environment split). This was the inline `psql -c` block that every deploy re-ran;
-- it is idempotent and now runs from this file, in the same order, via
-- scripts/db-migrate.sh — in dev and in prod alike. Nothing here is in the drizzle
-- journal; the re-baseline (docs/plans/production-environment-split.md, Track D)
-- folds it into 0000_baseline.
-- Deal periods + installments (migrations/0030). A deal is a SCHEDULE, not one
-- number: value per contract year, and separately when money moves. Additive —
-- nothing reads these until the resolver does, and no existing row has any.

CREATE TABLE IF NOT EXISTS deal_periods (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE, seq integer NOT NULL, label text, starts_on date, ends_on date, cash_cents bigint, product_cents bigint, product_directed_cents bigint, currency text NOT NULL DEFAULT 'usd', guaranteed boolean NOT NULL DEFAULT true, condition text, source_quote text, note text, superseded_at timestamptz, created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS deal_periods_deal_seq_uniq ON deal_periods (deal_id, seq) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deal_periods_deal ON deal_periods (deal_id);
CREATE TABLE IF NOT EXISTS deal_installments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), period_id uuid NOT NULL REFERENCES deal_periods(id) ON DELETE CASCADE, seq integer NOT NULL, amount_cents bigint, due_on date, kind text NOT NULL DEFAULT 'scheduled', derived boolean NOT NULL DEFAULT false, note text, created_at timestamptz DEFAULT now(), CONSTRAINT deal_installments_kind_check CHECK (kind IN ('scheduled','bonus','reimbursement')));
CREATE UNIQUE INDEX IF NOT EXISTS deal_installments_period_seq_uniq ON deal_installments (period_id, seq);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS installment_id uuid REFERENCES deal_installments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_payments_installment ON payments (installment_id);
