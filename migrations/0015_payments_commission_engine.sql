-- Payments commission engine — bring `payments` up to the current generation and
-- create the two tables that never existed: connect_accounts + payment_events.
--
-- See docs/plans/payments-commission-engine.md. Money is INTEGER CENTS.
--
-- WHY THIS EXISTS: shared/schema.ts has carried the commission-engine shape since the
-- escrow work, but prod still held the PREVIOUS Connect design — account_id, amount_cents,
-- offer_id, application_fee_cents — and connect_accounts / payment_events were never
-- created at all. Because Drizzle names every column of a table in its generated SQL,
-- that drift breaks every insert and every bare select on `payments`; the hourly
-- payments sweep has been throwing on its first query:
--
--   select id from payments where kind='deal_payment' and status='funded'
--     and athlete_confirmed_at is not null;
--   → ERROR: column "athlete_confirmed_at" does not exist
--
-- DELIBERATELY ADDITIVE, NOT A REBUILD. `payments` is empty in prod today and nothing
-- references it, so a DROP + CREATE would be equivalent *right now* — but these same
-- statements live in the deploy workflow's DDL block, which re-runs on EVERY deploy.
-- A drop there would silently destroy real payment records the first time it ran after
-- the feature went live. Everything below is idempotent and non-destructive instead:
-- re-running it on a populated table is a no-op.
--
-- Legacy columns (account_id, amount_cents, offer_id, application_fee_cents,
-- attempt_count, next_retry_at) are LEFT IN PLACE — Drizzle never names them, so they
-- are inert. The two that were NOT NULL are relaxed, because the current code never
-- writes them and the constraint would reject every insert. Dropping them, and the
-- now-unused payment_offers table, is a separate cleanup.

-- ── connect_accounts (new) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "connect_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL REFERENCES "athletes"("id"),
	"stripe_account_id" text NOT NULL,
	"account_kind" text DEFAULT 'classic' NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"transfers_active" boolean DEFAULT false NOT NULL,
	"requirements_due" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "connect_accounts_athlete_id_unique" UNIQUE ("athlete_id"),
	CONSTRAINT "connect_accounts_stripe_account_id_unique" UNIQUE ("stripe_account_id"),
	CONSTRAINT "connect_accounts_kind_check" CHECK ("account_kind" IN ('v2_recipient','classic'))
);--> statement-breakpoint

-- ── payment_events (new) — Stripe webhook idempotency + audit ledger ─────────
CREATE TABLE IF NOT EXISTS "payment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now(),
	"processed_at" timestamp with time zone
);--> statement-breakpoint

-- ── payments — add the current-generation columns ────────────────────────────
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "athlete_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "rail" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "deal_value_cents" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "commission_cents" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "processing_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "brand_total_cents" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "stripe_charge_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "stripe_transfer_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "stripe_refund_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "brand_email" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "reauth_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "reauth_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "athlete_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "brand_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "delivery_window_ends_at" timestamp with time zone;--> statement-breakpoint

-- destination_account_id changed meaning: it was a uuid FK to athletes (the payee row),
-- it is now the athlete's Stripe Connect account id (text, e.g. acct_...). Guarded on the
-- current type so a re-run is a no-op. Drop the stale FK first or the retype fails.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'destination_account_id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_destination_account_id_athletes_id_fk";
    ALTER TABLE "payments" ALTER COLUMN "destination_account_id" TYPE text USING "destination_account_id"::text;
  END IF;
END $$;--> statement-breakpoint

-- Legacy NOT NULLs the current code never writes — they would reject every insert.
ALTER TABLE "payments" ALTER COLUMN "account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "amount_cents" DROP NOT NULL;--> statement-breakpoint

-- Tighten the new columns to NOT NULL only when the data actually allows it. On the
-- empty prod table this applies; on a populated one it is skipped rather than failing
-- the deploy (the app always supplies both, so nullable is merely looser than schema.ts).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "payments" WHERE "athlete_id" IS NULL) THEN
    ALTER TABLE "payments" ALTER COLUMN "athlete_id" SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "payments" WHERE "deal_id" IS NULL) THEN
    ALTER TABLE "payments" ALTER COLUMN "deal_id" SET NOT NULL;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_athlete_id_athletes_id_fk') THEN
    ALTER TABLE "payments" ADD CONSTRAINT "payments_athlete_id_athletes_id_fk"
      FOREIGN KEY ("athlete_id") REFERENCES "athletes"("id");
  END IF;
END $$;--> statement-breakpoint

-- kind/status enums both changed generation: kind was one_time|deposit_hold|deal_charge,
-- status had no funded/settled/released/expired/disputed states.
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_kind_check";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_kind_check" CHECK ("kind" IN ('deposit','deal_payment'));--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_rail_check";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_rail_check" CHECK ("rail" IS NULL OR "rail" IN ('card','bank'));--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_status_check";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_status_check" CHECK ("status" IN ('pending','requires_action','authorized','reauthorized','funded','settled','released','expired','refunded','canceled','failed','disputed'));--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_payments_deal" ON "payments" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payments_athlete" ON "payments" USING btree ("athlete_id");
