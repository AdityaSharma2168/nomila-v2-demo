-- 0125_content_playbooks.sql — the shared content playbook (design "Moments → post kits" §5, v2): lasting
-- best-practice guidance for authentic growth (formats, hooks, ideal length, default cadence, cross-platform reuse),
-- one row per (sport, stage, platform) key that actually exists in the roster, refreshed monthly by
-- server/agent/playbook, behind AGENT_PLAYBOOK (off in both Cloud Run yamls until the owner turns it on).
--
-- Pure DDL, additive only. Nothing reads or writes this table until AGENT_PLAYBOOK is "true": the read API
-- (server/agent/playbook/read.ts getPlaybook) and the monthly refresh (server/agent/playbook/refresh.ts) are built in
-- the same PR but dark by default.
--
-- Copies model_params' one-active-row pattern (migration 0043) with a composite key instead of a single `family`:
-- a row is never edited in place (a changed config is a new version); `draft` rows are review-only and are never
-- returned by the active lookup; exactly one `active` row per (sport, stage, platform), enforced by the database.
--
-- `sport` and `platform` carry no CHECK on purpose (same reasoning as model_params.family): `sport` is free text as
-- the athlete gave it, and the platform list grows with the connectors in server/lib/integrations/registry.ts without
-- a migration. `stage` DOES carry a CHECK — the Brief's own small, closed band vocabulary (shared/plan.ts
-- PLAN_STAGE_BANDS) minus "unclear" (shared/playbook.ts PLAYBOOK_STAGES): an athlete whose stage is not yet known is
-- in no playbook key.
--
-- Idempotent (IF NOT EXISTS throughout) — safe to re-run, which scripts/db-migrate.sh does on every deploy. No
-- transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because
-- scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declaration ship
-- in ONE commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school, league or brand.

CREATE TABLE IF NOT EXISTS content_playbooks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport        text NOT NULL,
  stage        text NOT NULL,
  platform     text NOT NULL,
  version      text NOT NULL,
  status       text NOT NULL DEFAULT 'draft',
  config       jsonb NOT NULL,
  -- First 12 of sha1(canonical JSON of config), so a run's trace and a row line up by eye (the same convention
  -- model_params.hash and prompts.hash already use).
  hash         text NOT NULL,
  note         text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CONSTRAINT content_playbooks_status_check CHECK (status IN ('draft','active','archived')),
  CONSTRAINT content_playbooks_stage_check CHECK (stage IN ('early','developing','established','elite','retired')),
  CONSTRAINT content_playbooks_key_version_uq UNIQUE (sport, stage, platform, version)
);

-- One live version per key, enforced by the database — the same device model_params.family already relies on.
CREATE UNIQUE INDEX IF NOT EXISTS content_playbooks_one_active_uq ON content_playbooks (sport, stage, platform) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS content_playbooks_key_created_idx ON content_playbooks (sport, stage, platform, created_at);
