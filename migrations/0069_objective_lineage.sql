-- 0069_objective_lineage.sql — strategic lineage on the Objective, and the three relationship findings
-- (objectives-lineage-design.md §1, L1).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS CHANGES ─────────────────────────────────────────────────────────────────────────────
--   objectives.lineage  jsonb, nullable — computed once at creation from the proposal and the map it was judged
--                       from; immutable. Nullable only for rows created before 0069 (one hand-run backfill).
--   objective_events_action_check widened with reconciliation 2.0's findings: spans_live, splits_live,
--                       may_relate. A superset, so a pre-0069 image is unaffected in the DROP/ADD gap.
-- No data changes here.

ALTER TABLE objectives ADD COLUMN IF NOT EXISTS lineage jsonb;

-- Ownership of objective_events_action_check moved to 0079 (see the rule in 0063): this file now adds its fifteen
-- actions only when no CHECK exists, NOT VALID, so re-running it never re-narrows the owner's wider definition.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'objective_events_action_check') THEN
    ALTER TABLE objective_events ADD CONSTRAINT objective_events_action_check CHECK (action IN (
      'presented','created','accept','modify','decline','defer','abandon','achieve','supersede',
      'reaffirmed_by_run','re_proposed_while_declined','re_surfaced',
      'spans_live','splits_live','may_relate'
    )) NOT VALID;
  END IF;
END $$;
