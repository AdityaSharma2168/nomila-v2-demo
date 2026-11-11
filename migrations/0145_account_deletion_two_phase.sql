-- 0145_account_deletion_two_phase.sql — account deletion in two phases (28 Oct 2026; server/services/privacy/
-- deleteAthleteAccount.ts, server/workflow/definitions/accountDeletion.ts).
--
-- Why: the old delete ran every manifest table in ONE transaction. With a Mila turn in flight (the turn writes
-- agent_runs / chat_messages for the same athlete) it deadlocked and rolled back, and the turn then wrote new rows.
-- Now phase 1 is one small transaction that marks the athlete as deleting; phase 2 is a workflow run that purges in
-- batches outside any long transaction and reconciles the external clean-up.
--   athletes.deletion_requested_at  set by phase 1. requireAuth refuses the athlete from then on, no workflow run
--                                   starts for them and no Mila turn writes for them. NULL for every live account.
--   account_deletion_items          the reconciliation ledger of one deletion run: one row per external thing to
--                                   clean up (TrueForge session, storage prefix / object, sign-in user, Langfuse
--                                   traces, provider grant) or manifest table purged (rows counted), with its status
--                                   (pending / confirmed / failed / skipped). Opaque ids and paths only; no athlete
--                                   column, no foreign key. Rows are removed when the deletion is verified complete.
--
-- Pure DDL, additive only (expand): one nullable column (no default, so no table rewrite), one new table and its
-- index; nothing renamed, dropped or backfilled. Idempotent (IF NOT EXISTS throughout), safe to re-run, which
-- scripts/db-migrate.sh does on every deploy. No transaction control here (migrationsGuard): dry-run this file ON ITS
-- OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that
-- line and the shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy. Nothing here names
-- an athlete, sport, school or brand.

ALTER TABLE athletes ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;

CREATE TABLE IF NOT EXISTS account_deletion_items (
  id         serial PRIMARY KEY,
  run_id     uuid NOT NULL,
  system     text NOT NULL,
  ref        text NOT NULL,
  status     text NOT NULL DEFAULT 'pending',
  outcome    text,
  rows       integer NOT NULL DEFAULT 0,
  attempts   integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_deletion_items_status_check CHECK (status IN ('pending', 'confirmed', 'failed', 'skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_account_deletion_items_ref ON account_deletion_items USING btree (run_id, system, ref);
