-- Escrow/commission columns on `deals` — payment_status + deposit_status.
--
-- Renumbered 0014 -> 0017: #140 was cut before 0014_chat_conversation_id merged, so
-- both landed on main as 0014_*. 0015 is the payments migration, 0016 is reserved for
-- PR #164. The DDL itself ships in the deploy.yml psql block — the hand-written
-- migrations are not in the drizzle journal, so this file is never applied on its own.
--
-- Additive only. Hand-written (not `drizzle-kit generate`) on purpose, same reason
-- as 0010/0012/0013: this branch's schema.ts has drifted ahead of the migration
-- snapshot, so a generated diff would try to (re)create / alter everything that
-- already exists live. This file touches ONLY the two new columns.
--
-- WHY THIS EXISTS (incident, 2026-07-25 → 2026-07-29):
-- shared/schema.ts declared these two columns with the escrow/commission work, but
-- no DDL ever reached prod. Drizzle names EVERY column of a table in the SQL it
-- generates — an insert lists all columns (absent ones get the literal `default`),
-- and a bare `db.select()` lists all columns too. So a column that exists in
-- schema.ts but not in the database breaks reads AND writes for the whole table:
--
--   insert into "deals" (..., "payment_status", "deposit_status", ...) values (...)
--   select ..., "payment_status", "deposit_status", ... from "deals"
--
--   → error: column "payment_status" of relation "deals" does not exist
--
-- Net effect in prod: every inbound deal email since 2026-07-25 classified,
-- summarized and brand-enriched fine, then died at the final insert — no deals row,
-- thread.deal_id left NULL, status never flipped to deal_detected. The same drift
-- broke GET /deals/:id and POST /deals/:id/draft (both bare selects), which is why
-- reply drafts failed to generate.
--
-- Idempotent so it is safe whether the deploy DDL block, a manual psql run, or
-- drizzle-kit gets here first.

ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "payment_status" text DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "deposit_status" text DEFAULT 'none';--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deals_payment_status_check') THEN
    ALTER TABLE "deals" ADD CONSTRAINT "deals_payment_status_check"
      CHECK ("payment_status" IN ('none','payment_requested','funded','delivered_pending_confirmation','settled','refunded','disputed'));
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deals_deposit_status_check') THEN
    ALTER TABLE "deals" ADD CONSTRAINT "deals_deposit_status_check"
      CHECK ("deposit_status" IN ('none','held','released','expired'));
  END IF;
END $$;
