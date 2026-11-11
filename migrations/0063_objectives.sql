-- 0063_objectives.sql — the live Objective and its event log (PR3b-1).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy.
--
-- Numbered 0063: 0059–0062 exist on main and this branch trails it. If another 0063 lands first, renumber
-- here, in the script list, and in the schema comment — the content does not change.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- Three NEW tables, nothing else. No ALTER of existing tables, no UPDATE, no backfill. Pre-0063 code does
-- not read them.
--
--   objective_proposal_sets   the evaluator's ObjectiveProposalSet per run, immutable, with its run record
--   objectives                the durable Objective. Immutable fields written once; mutable fields are a
--                             projection of objective_events. created_snapshot keeps the row as created so
--                             the projection can be rebuilt and checked.
--   objective_events          append-only. The athlete's decisions, her words verbatim, and the delta.
--
-- The one constraint worth naming: objectives_active_needs_yes. A row cannot be lifecycle 'active' unless
-- disposition is 'accepted' or 'modified'. A proposal cannot become her goal by sitting unread — enforced
-- by the database, not only by code.

CREATE TABLE IF NOT EXISTS objective_proposal_sets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id            uuid NOT NULL REFERENCES athletes(id),
  as_of                 timestamptz NOT NULL,
  spec_version          text NOT NULL,
  canonical_sha256      text NOT NULL,
  state_as_of           timestamptz NOT NULL,
  opportunity_map_as_of timestamptz NOT NULL,
  set                   jsonb NOT NULL,
  record                jsonb NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS objective_proposal_sets_athlete_idx ON objective_proposal_sets (athlete_id, as_of);

CREATE TABLE IF NOT EXISTS objectives (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id       uuid NOT NULL REFERENCES athletes(id),
  version          text NOT NULL,
  origin           text NOT NULL,
  domain           text NOT NULL,
  desired_state    jsonb NOT NULL,
  current_state    jsonb,
  provenance       jsonb NOT NULL,
  success          jsonb NOT NULL,
  horizon          jsonb,
  athlete_stance   jsonb,
  confidence       text NOT NULL,
  disposition      text NOT NULL,
  lifecycle        text NOT NULL,
  modified_from    jsonb,
  from_proposal    jsonb,
  proposal_set_id  uuid REFERENCES objective_proposal_sets(id),
  proposal_key     text,
  superseded_by    uuid REFERENCES objectives(id),
  created_snapshot jsonb NOT NULL,
  created_at       timestamptz NOT NULL,
  reviewed_at      timestamptz,
  activated_at     timestamptz,
  closed_at        timestamptz
);
ALTER TABLE objectives DROP CONSTRAINT IF EXISTS objectives_origin_check;
ALTER TABLE objectives ADD CONSTRAINT objectives_origin_check CHECK (origin IN ('athlete','nomila','joint'));
ALTER TABLE objectives DROP CONSTRAINT IF EXISTS objectives_disposition_check;
ALTER TABLE objectives ADD CONSTRAINT objectives_disposition_check CHECK (disposition IN ('unreviewed','accepted','declined','deferred','modified'));
ALTER TABLE objectives DROP CONSTRAINT IF EXISTS objectives_lifecycle_check;
ALTER TABLE objectives ADD CONSTRAINT objectives_lifecycle_check CHECK (lifecycle IN ('proposed','active','achieved','abandoned','superseded'));
ALTER TABLE objectives DROP CONSTRAINT IF EXISTS objectives_active_needs_yes;
ALTER TABLE objectives ADD CONSTRAINT objectives_active_needs_yes CHECK (lifecycle <> 'active' OR disposition IN ('accepted','modified'));
CREATE INDEX IF NOT EXISTS objectives_athlete_live_idx ON objectives (athlete_id, lifecycle, disposition);
CREATE UNIQUE INDEX IF NOT EXISTS objectives_one_per_proposal ON objectives (proposal_set_id, proposal_key) WHERE proposal_set_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS objective_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id   uuid NOT NULL REFERENCES objectives(id),
  athlete_id     uuid NOT NULL REFERENCES athletes(id),
  at             timestamptz NOT NULL,
  actor_user_id  uuid REFERENCES users(id),
  actor_role     text NOT NULL,
  action         text NOT NULL,
  said           text,
  delta          jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE objective_events DROP CONSTRAINT IF EXISTS objective_events_role_check;
ALTER TABLE objective_events ADD CONSTRAINT objective_events_role_check CHECK (actor_role IN ('athlete','admin','system'));
-- ── CHECK OWNERSHIP RULE (learned 25 Sep 2026, deploy 36094301919) ──────────────────────────────
-- Every hand migration re-runs on every deploy. A migration that DROPs and re-ADDs a CHECK that a LATER migration
-- widened re-narrows it on the next deploy and fails on rows the wider set admitted. So: the LATEST migration that
-- widens objective_events_action_check owns it (DROP + ADD, validated); every earlier one adds it only if absent,
-- NOT VALID, so it never judges rows written under a later definition. When a future migration widens it again,
-- the previous owner must be edited to this guarded form.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'objective_events_action_check') THEN
    ALTER TABLE objective_events ADD CONSTRAINT objective_events_action_check CHECK (action IN ('presented','created','accept','modify','decline','defer','abandon','achieve','supersede')) NOT VALID;
  END IF;
END $$;
ALTER TABLE objective_events DROP CONSTRAINT IF EXISTS objective_events_system_has_no_user;
ALTER TABLE objective_events ADD CONSTRAINT objective_events_system_has_no_user CHECK ((actor_role = 'system') = (actor_user_id IS NULL));
CREATE INDEX IF NOT EXISTS objective_events_objective_idx ON objective_events (objective_id, at);
