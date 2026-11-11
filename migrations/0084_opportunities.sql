-- 0084_opportunities.sql — one opportunity per brand (Opportunities PR 2).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- opportunities — a thin row above deals: every email about one brand lands under one opportunity. No value
--   fields (money stays on deals; the stage is derived from the member deals). One OPEN row per (athlete, brand)
--   is enforced in code under pg_advisory_xact_lock, so the lookup index below is deliberately NOT unique.
-- deals.opportunity_id — nullable, no default, no backfill here (server/scripts/opps/backfillOpportunities.ts
--   is a separate, deliberate run). ON DELETE SET NULL.
--
-- Additive: one new table, one nullable column, non-unique indexes. Every statement re-runs as a no-op. Names
-- and definitions are written exactly as a shared/schema.ts push produces them (opportunities.migration.test.ts
-- pins that). No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

CREATE TABLE IF NOT EXISTS opportunities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id        uuid NOT NULL CONSTRAINT opportunities_athlete_id_athletes_id_fk REFERENCES athletes(id) ON DELETE CASCADE,
  brand_id          integer CONSTRAINT opportunities_brand_id_inbox_brands_id_fk REFERENCES inbox_brands(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'open',
  close_reason      text,
  closed_at         timestamptz,
  opened_at         timestamptz NOT NULL,
  last_activity_at  timestamptz NOT NULL,
  lead_thread_id    uuid CONSTRAINT opportunities_lead_thread_id_inbox_threads_id_fk REFERENCES inbox_threads(id) ON DELETE SET NULL,
  going_quiet_at    timestamptz,
  CONSTRAINT opportunities_status_check CHECK (status IN ('open','closed')),
  CONSTRAINT opportunities_close_reason_check CHECK (close_reason IS NULL OR close_reason IN ('won','declined','expired','not_relevant')),
  CONSTRAINT opportunities_closed_check CHECK (
    (status = 'open' AND closed_at IS NULL AND close_reason IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL AND close_reason IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS opportunities_open_brand_idx ON opportunities (athlete_id, brand_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS opportunities_sweep_idx ON opportunities (status, last_activity_at);

ALTER TABLE deals ADD COLUMN IF NOT EXISTS opportunity_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deals_opportunity_id_opportunities_id_fk') THEN
    ALTER TABLE deals ADD CONSTRAINT deals_opportunity_id_opportunities_id_fk
      FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_deals_opportunity ON deals (opportunity_id);
