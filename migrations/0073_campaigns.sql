-- 0073_campaigns.sql — #570 C1 as amended (Amendments 1 & 2): campaigns, campaign_specs, campaign_deliverables, and the
-- campaign lineage on generation_jobs (#570 §6).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- campaigns            — the durable activation: origin door, purpose (never rewritten), strategic lineage by reference,
--                        the RESOLVED reason to end (endsWith + endsRef, Amendment 1), lifecycle, current spec version.
-- campaign_specs       — immutable versioned scope: purpose, deliverables (by deliverable id), period, constraints,
--                        approval, provenance/supersession. Approval is the trigger for creative materialisation.
-- campaign_deliverables — tracked obligations with an identity that SPANS spec versions (introduced in one version,
--                        superseded by a later one), so the forcing-tested intent key campaign:<id>:<deliverable>:<unit>
--                        stays stable across revisions. Only category `content` ever reaches creative intelligence.
-- generation_jobs      — source_spec_id, source_spec_version, campaign_deliverable_id (nullable, audit/fulfilment only).
-- Nothing here reads a flag yet; no route; no caller. deal_deliverables.campaign_id (deal door) is NOT added in this slice.

CREATE TABLE IF NOT EXISTS campaigns (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id              uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  version                 text NOT NULL,
  origin_door             text NOT NULL,
  purpose                 text NOT NULL,
  recommendation_ids      jsonb NOT NULL DEFAULT '[]'::jsonb,
  objective_ids           jsonb NOT NULL DEFAULT '[]'::jsonb,
  deal_ids                jsonb NOT NULL DEFAULT '[]'::jsonb,
  brand_ids               jsonb NOT NULL DEFAULT '[]'::jsonb,
  participant_athlete_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  period                  jsonb NOT NULL,
  evidence                jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                  text NOT NULL,
  ended_because           text,
  current_spec_version    integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  started_at              timestamptz,
  ended_at                timestamptz,
  CONSTRAINT campaigns_origin_door_check CHECK (origin_door IN ('recommendation', 'deal', 'athlete', 'observed')),
  CONSTRAINT campaigns_status_check CHECK (status IN ('idea', 'planning', 'approved', 'active', 'ended')),
  CONSTRAINT campaigns_ended_because_check CHECK (ended_because IS NULL OR ended_because IN ('fulfilled', 'expired', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_campaigns_athlete_created ON campaigns (athlete_id, created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_specs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  athlete_id    uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  purpose       text NOT NULL,
  deliverable_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  period        jsonb NOT NULL,
  constraints   jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval      text NOT NULL DEFAULT 'draft',
  provenance    jsonb NOT NULL,
  supersedes    integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_at   timestamptz,
  approved_by   text,
  CONSTRAINT campaign_specs_approval_check CHECK (approval IN ('draft', 'athlete', 'brand', 'contractual')),
  CONSTRAINT campaign_specs_campaign_version_unique UNIQUE (campaign_id, version)
);

CREATE TABLE IF NOT EXISTS campaign_deliverables (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id          uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  athlete_id           uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  introduced_version   integer NOT NULL,
  superseded_version   integer,
  seq                  integer NOT NULL,
  intent               jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'open',
  deal_deliverable_id  uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  superseded_at        timestamptz,
  CONSTRAINT campaign_deliverables_status_check CHECK (status IN ('open', 'fulfilled', 'waived', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_campaign_deliverables_campaign ON campaign_deliverables (campaign_id, introduced_version, seq);

ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS source_spec_id uuid;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS source_spec_version integer;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS campaign_deliverable_id uuid;
CREATE INDEX IF NOT EXISTS idx_generation_jobs_campaign_deliverable ON generation_jobs (campaign_deliverable_id) WHERE campaign_deliverable_id IS NOT NULL;
