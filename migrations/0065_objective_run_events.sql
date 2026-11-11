-- 0065_objective_run_events.sql — reconciliation's three system events on objective_events (PR3b-2).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS CHANGES ─────────────────────────────────────────────────────────────────────────────
-- ONE CHECK constraint, widened. objective_events_action_check gains three actions the design names
-- for reconciliation (objectives-pr3b-design.md §7) and 0063 did not carry:
--
--   reaffirmed_by_run           a later run proposed the same outcome while it is live or still queued
--   re_proposed_while_declined  a later run proposed it again inside the decline window
--   re_surfaced                 she deferred it and a later run proposed it again; it returns to the queue
--
-- No table, column, index or data changes. The DROP + ADD pair is the only way to widen a CHECK in
-- Postgres; both statements autocommit separately under psql -f, and a pre-0065 image writing the nine
-- original actions is unaffected in the gap because the new set is a superset.

-- ── CHECK OWNERSHIP RULE (learned 25 Sep 2026, deploy 36094301919) ──────────────────────────────
-- Every hand migration re-runs on every deploy. A migration that DROPs and re-ADDs a CHECK that a LATER migration
-- widened re-narrows it on the next deploy and fails on rows the wider set admitted. So: the LATEST migration that
-- widens objective_events_action_check owns it (DROP + ADD, validated); every earlier one adds it only if absent,
-- NOT VALID, so it never judges rows written under a later definition. When a future migration widens it again,
-- the previous owner must be edited to this guarded form.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'objective_events_action_check') THEN
    ALTER TABLE objective_events ADD CONSTRAINT objective_events_action_check CHECK (action IN (
      'presented','created','accept','modify','decline','defer','abandon','achieve','supersede',
      'reaffirmed_by_run','re_proposed_while_declined','re_surfaced'
    )) NOT VALID;
  END IF;
END $$;
