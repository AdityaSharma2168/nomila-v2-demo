-- 0030 — deal_periods + deal_installments. A deal is a SCHEDULE, not one number.
--
-- Additive only. Hand-written; the executing copy is the idempotent psql block in
-- .github/workflows/deploy.yml (numbered .sql files are intent/review, not the applier —
-- the drizzle journal stops at 0011 and `drizzle-kit migrate` applies none of these).
--
-- ── What it is for ───────────────────────────────────────────────────────────
-- `deals` held one figure, which is right for an emailed one-off and wrong the moment a
-- contract runs longer than a campaign. Mia's adidas agreement pays $20,000, $20,000,
-- $15,000 and $10,000 across four NIL years, then a separate retainer schedule for the
-- professional years, plus $10,000/yr of product she keeps and $15,000/yr she directs to
-- charity and never receives. No single number answers every question asked of that:
-- $105,000 is wrong for "what does she earn this year", $30,000 is wrong for "how big is
-- this deal", and both are wrong for "what should escrow hold".
--
-- So the schedule is stored and every metric is DERIVED (server/services/dealValue.ts).
-- This codebase already paid for the alternative: `deals.amount` is a denormalized copy
-- that went stale badly enough that dealVoice now opens with "NEVER speak deals.amount —
-- we saw $200 on a deal whose live offer was $950". A schedule makes that failure worse,
-- not better, because any single stored figure is wrong on the day it is written.
--
-- ── Why TWO tables ───────────────────────────────────────────────────────────
-- A period is a unit of VALUE; an installment is money MOVING. They are not the same fact:
-- a product credit is value with no payment event at all, so installments alone cannot
-- hold it, and payment timing can be amended without the value changing. adidas pays each
-- annual amount in two installments, and so does gorjana — this is the normal shape.
--
-- ── INTEGER CENTS ────────────────────────────────────────────────────────────
-- Matching `payments`. `deals.amount` is legacy NUMERIC DOLLARS and payments/money.ts
-- already owns that boundary; a third representation would be strictly worse. bigint, and
-- read in JS as a number — a BigInt would make JSON.stringify throw on any API response
-- carrying a period.
--
-- ── product_directed_cents, not a second row ─────────────────────────────────
-- The charitable credit is real, worth showing, and must never be counted: summing it
-- would inflate the agreement by $60,000 across the term, and that figure would reach her
-- commercial capital and, through escrow, a brand's invoice. It is a COLUMN rather than a
-- second period row because adidas grants both credits in the SAME contract year — two
-- rows per year would stop `seq` meaning the contract year and would double-count that
-- year in any per-year average.
--
-- ── superseded_at ────────────────────────────────────────────────────────────
-- Amendments INSERT and stamp; they never UPDATE. Rewriting a period destroys what year 3
-- was worth when a score snapshot was taken, and this repo already carries the mirror of
-- that bug — offer tracking frozen on the first proposal. The unique index is therefore
-- PARTIAL: a superseded row keeps its seq, and uniqueness applies only to live rows.
--
-- ── Not enforced ─────────────────────────────────────────────────────────────
-- No CHECK that installments sum to their period's cash. The writer is a model reading a
-- PDF, and a misread would become a write failure that loses the whole upload. The
-- resolver REPORTS the disagreement (`reconciled`) instead of silently preferring a side —
-- same posture as 0026's absent amount check.
--
-- ── payments.installment_id ──────────────────────────────────────────────────
-- Nullable, indexed, and unused for now. `requestDealPayment` looks up payments by deal_id
-- LIMIT 1, so a second installment would collide with the first; that rework is deliberately
-- separate because it is live money. The column lands now so the migration does not have to
-- happen underneath it later. ON DELETE SET NULL, never cascade: payments is the ledger, and
-- editing a schedule must never take a money record with it.

CREATE TABLE IF NOT EXISTS deal_periods (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id                 uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  seq                     integer NOT NULL,
  label                   text,
  starts_on               date,
  ends_on                 date,
  cash_cents              bigint,
  product_cents           bigint,
  product_directed_cents  bigint,
  currency                text NOT NULL DEFAULT 'usd',
  guaranteed              boolean NOT NULL DEFAULT true,
  condition               text,
  source_quote            text,
  note                    text,
  superseded_at           timestamptz,
  created_at              timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS deal_periods_deal_seq_uniq
  ON deal_periods (deal_id, seq) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deal_periods_deal ON deal_periods (deal_id);

CREATE TABLE IF NOT EXISTS deal_installments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id    uuid NOT NULL REFERENCES deal_periods(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  amount_cents bigint,
  due_on       date,
  kind         text NOT NULL DEFAULT 'scheduled',
  derived      boolean NOT NULL DEFAULT false,
  note         text,
  created_at   timestamptz DEFAULT now(),
  CONSTRAINT deal_installments_kind_check CHECK (kind IN ('scheduled','bonus','reimbursement'))
);
CREATE UNIQUE INDEX IF NOT EXISTS deal_installments_period_seq_uniq
  ON deal_installments (period_id, seq);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS installment_id uuid
  REFERENCES deal_installments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_payments_installment ON payments (installment_id);

COMMENT ON COLUMN deal_periods.seq                    IS '1-based ordinal within the contract. The identity of a period — never its array index.';
COMMENT ON COLUMN deal_periods.guaranteed             IS 'FALSE = conditional (a retainer year, an "if applicable" year). Never summed into a guaranteed total.';
COMMENT ON COLUMN deal_periods.product_directed_cents IS 'Value she DIRECTS but never receives (charitable credit). Shown, never counted as compensation.';
COMMENT ON COLUMN deal_periods.superseded_at          IS 'Amendments insert new rows and stamp the old. Readers filter on NULL.';
COMMENT ON COLUMN deal_installments.derived           IS 'TRUE when we split an amount ("two equal installments"), not when the contract stated each.';
