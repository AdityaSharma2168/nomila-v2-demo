-- Payments commission engine (migrations/0015): connect_accounts, payment_events, payments columns.
--
-- Extracted VERBATIM from .github/workflows/deploy.yml on 2026-09-08 (PR B of the
-- environment split). This was the inline `psql -c` block that every deploy re-ran;
-- it is idempotent and now runs from this file, in the same order, via
-- scripts/db-migrate.sh — in dev and in prod alike. Nothing here is in the drizzle
-- journal; the re-baseline (docs/plans/production-environment-split.md, Track D)
-- folds it into 0000_baseline.
-- Payments commission engine (migrations/0015). Kept as its own block for
-- readability. ADDITIVE for the current generation of columns — this block
-- re-runs on EVERY deploy, so a DROP + CREATE of the table would destroy live
-- payment records the moment there are any.
--
-- The six columns of the PREVIOUS Connect design are dropped below:
-- account_id, amount_cents, offer_id, application_fee_cents, attempt_count,
-- next_retry_at. They are superseded by deal_value_cents / commission_cents /
-- destination_account_id, absent from schema.ts, and referenced by no code.
-- Verified before dropping: payments has 0 rows (as do connect_accounts), no
-- view depends on the table, and the indexes/FKs that go with them
-- (idx_payments_account, idx_payments_offer, idx_payments_retry;
-- account_id→athletes, offer_id→payment_offers) are not recreated anywhere.
--
-- This REPLACES two `ALTER COLUMN … DROP NOT NULL` statements that used to sit
-- here for account_id and amount_cents. Those existed only to stop the old
-- NOT NULLs from breaking every Drizzle insert (Drizzle never names a column
-- absent from schema.ts). Keeping them alongside the drops would fail the
-- deploy: ALTER COLUMN has no IF EXISTS form, so it errors on a dropped column
-- and this block runs under ON_ERROR_STOP=1.
--
-- Leaving the columns in place was the cheaper call while the drift gate ran
-- with `|| true`. Now that the gate is hard (below), a permanent known-stale
-- flag on every run is what trains people to stop reading it.

CREATE TABLE IF NOT EXISTS connect_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), athlete_id uuid NOT NULL REFERENCES athletes(id), stripe_account_id text NOT NULL, account_kind text NOT NULL DEFAULT 'classic', details_submitted boolean NOT NULL DEFAULT false, charges_enabled boolean NOT NULL DEFAULT false, payouts_enabled boolean NOT NULL DEFAULT false, transfers_active boolean NOT NULL DEFAULT false, requirements_due jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), CONSTRAINT connect_accounts_athlete_id_unique UNIQUE (athlete_id), CONSTRAINT connect_accounts_stripe_account_id_unique UNIQUE (stripe_account_id), CONSTRAINT connect_accounts_kind_check CHECK (account_kind IN ('v2_recipient','classic')));
CREATE TABLE IF NOT EXISTS payment_events (id text PRIMARY KEY, type text NOT NULL, payload jsonb, received_at timestamptz DEFAULT now(), processed_at timestamptz);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS athlete_id uuid;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS rail text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS deal_value_cents integer;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS commission_cents integer;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS processing_fee_cents integer;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS brand_total_cents integer;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_charge_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_transfer_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_refund_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS brand_email text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reauth_count integer NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reauth_at timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS athlete_confirmed_at timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS brand_confirmed_at timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS delivery_window_ends_at timestamptz;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='destination_account_id' AND data_type='uuid') THEN ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_destination_account_id_athletes_id_fk; ALTER TABLE payments ALTER COLUMN destination_account_id TYPE text USING destination_account_id::text; END IF; END $$;
ALTER TABLE payments DROP COLUMN IF EXISTS account_id;
ALTER TABLE payments DROP COLUMN IF EXISTS amount_cents;
ALTER TABLE payments DROP COLUMN IF EXISTS offer_id;
ALTER TABLE payments DROP COLUMN IF EXISTS application_fee_cents;
ALTER TABLE payments DROP COLUMN IF EXISTS attempt_count;
ALTER TABLE payments DROP COLUMN IF EXISTS next_retry_at;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM payments WHERE athlete_id IS NULL) THEN ALTER TABLE payments ALTER COLUMN athlete_id SET NOT NULL; END IF; IF NOT EXISTS (SELECT 1 FROM payments WHERE deal_id IS NULL) THEN ALTER TABLE payments ALTER COLUMN deal_id SET NOT NULL; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payments_athlete_id_athletes_id_fk') THEN ALTER TABLE payments ADD CONSTRAINT payments_athlete_id_athletes_id_fk FOREIGN KEY (athlete_id) REFERENCES athletes(id); END IF; END $$;
-- payments_kind_check is OWNED by 0099 (CHECK OWNERSHIP RULE, see 0063): only add it if absent, NOT VALID. Re-narrowing
-- it here on every deploy failed the dev deploy of 10 Nov 2026 once the first booking_payment rows existed.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_kind_check') THEN ALTER TABLE payments ADD CONSTRAINT payments_kind_check CHECK (kind IN ('deposit','deal_payment','booking_payment')) NOT VALID; END IF; END $$;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_rail_check;
ALTER TABLE payments ADD CONSTRAINT payments_rail_check CHECK (rail IS NULL OR rail IN ('card','bank'));
-- payments_status_check is OWNED by 0098 (CHECK OWNERSHIP RULE, see 0063): only add it if absent, NOT VALID.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_status_check') THEN ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN ('pending','requires_action','authorized','reauthorized','funded','settled','released','expired','refunded','canceled','failed','disputed','charged_back')) NOT VALID; END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_payments_deal ON payments (deal_id);
CREATE INDEX IF NOT EXISTS idx_payments_athlete ON payments (athlete_id);
