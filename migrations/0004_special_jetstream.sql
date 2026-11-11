-- One-table, auth-first waitlist: landing signups now create an `athletes` row
-- with status='waitlisted' instead of living in a separate `waitlist` table.
-- All statements are idempotent (IF [NOT] EXISTS) to stay safe on databases
-- already synced via db:push (matches .github/workflows/deploy.yml).
ALTER TABLE "athletes" ADD COLUMN IF NOT EXISTS "first_name" text;--> statement-breakpoint
ALTER TABLE "athletes" ADD COLUMN IF NOT EXISTS "last_name" text;--> statement-breakpoint
ALTER TABLE "athletes" ADD COLUMN IF NOT EXISTS "photo_url" text;--> statement-breakpoint
ALTER TABLE "athletes" ADD COLUMN IF NOT EXISTS "socials" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "athletes" ADD COLUMN IF NOT EXISTS "referral_code" text;--> statement-breakpoint
ALTER TABLE "athletes" DROP CONSTRAINT IF EXISTS "athletes_status_check";--> statement-breakpoint
ALTER TABLE "athletes" ADD CONSTRAINT "athletes_status_check" CHECK ("athletes"."status" IN ('waitlisted','raw','enriched','claimed','active'));--> statement-breakpoint
-- Fold any existing standalone `waitlist` rows into athletes as un-authenticated
-- waitlisted profiles (auth_id NULL — claimed on first sign-in by email match),
-- then drop the table. Guarded so it's a no-op where the table never existed and
-- skips emails that already have an athlete row.
DO $$
BEGIN
  IF to_regclass('public.waitlist') IS NOT NULL THEN
    INSERT INTO athletes (full_name, first_name, last_name, sport, school, email, socials, referral_code, status)
    SELECT
      COALESCE(w.full_name, NULLIF(TRIM(CONCAT_WS(' ', w.first_name, w.last_name)), ''), split_part(w.email, '@', 1)),
      w.first_name, w.last_name, w.sport, w.school, w.email,
      COALESCE(w.socials, '{}'::jsonb), w.referral_code, 'waitlisted'
    FROM waitlist w
    WHERE w.email IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM athletes a WHERE lower(a.email) = lower(w.email));
    DROP TABLE waitlist;
  END IF;
END $$;
