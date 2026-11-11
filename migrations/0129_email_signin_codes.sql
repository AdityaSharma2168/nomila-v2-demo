-- 0129_email_signin_codes.sql — sign in with a 6-digit email code (design "Sign in with email", 12 Oct 2026), behind
-- EMAIL_CODE_SIGNIN (on in the dev Cloud Run yaml, off in prod).
--
-- One row per code sent by POST /api/v1/auth/email-code/start. Nothing is stored in the clear: email_hmac, code_hmac
-- and ip_hmac are HMAC-SHA256 values keyed with EMAIL_CODE_SECRET (server/lib/emailCode.ts), so the table names no one
-- and holds no usable code. The same rows are the per-email and per-IP rate counters (Cloud Run instances share no
-- memory). Only the newest row for an email can be used; a code lives 10 minutes, takes 5 tries, and is spent once
-- (consumed_at). Rows are purged two days after they are made (hourly cron). No athlete column (athleteDataManifest NOT_ATHLETE_DATA).
--
-- Pure DDL, additive only: one new table, its two lockout columns (ADD COLUMN IF NOT EXISTS) and its indexes; nothing
-- else is touched. Idempotent (IF NOT EXISTS
-- throughout), safe to re-run, which scripts/db-migrate.sh does on every deploy. No transaction control here
-- (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names
-- it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in ONE commit or the drift gate
-- reds the deploy. (It runs after 0128, the last legacy-retirement migration.)

CREATE TABLE IF NOT EXISTS email_signin_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hmac  text NOT NULL,
  code_hmac   text NOT NULL,
  ip_hmac     text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  -- When the 5th wrong try locked this code, and the HMAC of the IP that made it (the targeted lockout and the backoff).
  locked_at      timestamptz,
  locked_ip_hmac text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A table created by an earlier draft of this file (before the lockout columns) still gets them.
ALTER TABLE email_signin_codes ADD COLUMN IF NOT EXISTS locked_at timestamptz, ADD COLUMN IF NOT EXISTS locked_ip_hmac text;

CREATE INDEX IF NOT EXISTS idx_email_signin_codes_email ON email_signin_codes USING btree (email_hmac, created_at);
CREATE INDEX IF NOT EXISTS idx_email_signin_codes_ip ON email_signin_codes USING btree (ip_hmac, created_at);
CREATE INDEX IF NOT EXISTS idx_email_signin_codes_created ON email_signin_codes USING btree (created_at);
