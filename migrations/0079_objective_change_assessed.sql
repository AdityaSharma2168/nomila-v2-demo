-- 0079_objective_change_assessed.sql — the saved change assessment of an athlete's Objective edit
-- (slice3-b-design.md §1, §6).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS CHANGES ─────────────────────────────────────────────────────────────────────────────
--   objective_events_action_check widened with ONE system action: change_assessed — appended after her wording edit
--                       with the 0.2.0-exp assessment (or `unassessed`) in `delta`. A superset, so a pre-0079 image is
--                       unaffected in the DROP/ADD gap. The event never changes the Objective (the fold ignores it).
--   and ONE athlete action: success_confirmed — she kept her success line, reviewed against her current wording
--                       (Slice 3 A). Added here, not in a new file, because 0079 was verified unapplied everywhere
--                       (slice3-a-design.md, pre-implementation checks).
-- No table, column, index or data changes. (0078 is taken by feat/slice2-startx1's counterparty research.)

-- OWNER of objective_events_action_check (see the rule in 0063): DROP + ADD, validated. 0069, the previous owner,
-- is converted to the guarded add-if-absent form in the same commit. A later widening must take ownership and
-- convert this file the same way.
ALTER TABLE objective_events DROP CONSTRAINT IF EXISTS objective_events_action_check;
ALTER TABLE objective_events ADD CONSTRAINT objective_events_action_check CHECK (action IN (
  'presented','created','accept','modify','decline','defer','abandon','achieve','supersede',
  'reaffirmed_by_run','re_proposed_while_declined','re_surfaced',
  'spans_live','splits_live','may_relate',
  'change_assessed','success_confirmed'
));
