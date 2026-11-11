-- 0077_intelligence_requests.sql — the durable Intelligence Request store (Checkpoint 1, slice 1;
-- docs/architecture/commercial-intelligence/checkpoint1-design-review.md §9). The one new table Checkpoint 1 adds.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- intelligence_requests — one row per request, holding the existing `IntelligenceRequest` shape
--   (brain/intelligenceRequest.ts, intelligence-request/0.2.0-exp) whole in `request`: decision identity, the one
--   need, proposition history, who raised it (a Brain run, or her governance with her exact words), the acquisition
--   and any artifacts she handed over, attributable evidence BY REFERENCE, reconsideration, events. The columns beside
--   it exist only so reads can find rows without opening the jsonb.
--
-- NO STATUS COLUMN. Status is derived from the request (open · acquiring · acquired · evidenced · obsolete) and is
-- never authored: storing it would let a writer claim "evidenced" without the evidence the rule requires.
--
-- Additive: one new table, no change to any existing table. Names and index order are written exactly as a
-- shared/schema.ts push produces them (intelligenceRequests.migration.test.ts pins that).

CREATE TABLE IF NOT EXISTS intelligence_requests (
  id            text PRIMARY KEY,
  athlete_id    uuid NOT NULL CONSTRAINT intelligence_requests_athlete_id_athletes_id_fk REFERENCES athletes(id) ON DELETE CASCADE,
  version       text NOT NULL,
  key           text NOT NULL,
  need          text NOT NULL,
  source_class  text NOT NULL,
  subject       text NOT NULL,
  raised_by     text NOT NULL,
  request       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intelligence_requests_athlete ON intelligence_requests (athlete_id, updated_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_intelligence_requests_key ON intelligence_requests (athlete_id, key);
