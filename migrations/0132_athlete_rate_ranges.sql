-- 0132_athlete_rate_ranges.sql — Mila's suggested rate range per athlete × rate type (deals design §5c "Your rates",
-- §8 "Suggested rates"; D9 approved 12 Oct 2026), behind RATES_V1.
--
-- One row per (athlete, rate type from shared/deals.ts RATE_TYPES). For launch the ranges are the ones onboarding
-- already produces and validates (agent/onboarding/turn.ts rate_ranges), saved when the card is shown; existing
-- athletes are backfilled from their stored onboarding cards (scripts/backfill-rate-ranges.ts, dry-run by default).
-- The rate-eval 2.0 model is NOT used. Readers: GET /me/rates, the deal read's Money line. Shown to her only.
-- Her own minimums stay where they are (athletes.deal_preferences.minimum_rates); nothing here is her floor.
--
-- Additive: one new table, its constraints; nothing existing changes. Idempotent (IF NOT EXISTS, or DROP-then-ADD of a
-- named constraint) — safe to re-run, which scripts/db-migrate.sh does on every deploy. Names and definitions are
-- written exactly as a shared/schema.ts push produces them. No transaction control here (migrationsGuard): dry-run this
-- file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names it in the step-3 list; this
-- file, that line and the shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy. Nothing
-- here names an athlete, sport, school or brand.

CREATE TABLE IF NOT EXISTS athlete_rate_ranges (
  athlete_id    uuid NOT NULL,
  rate_type     text NOT NULL,
  low           integer NOT NULL,
  high          integer NOT NULL,
  currency      text DEFAULT 'USD' NOT NULL,
  confidence    text NOT NULL,
  drivers       jsonb DEFAULT '[]'::jsonb NOT NULL,
  label         text NOT NULL,
  source        text DEFAULT 'onboarding' NOT NULL,
  source_run_id uuid,
  shown_at      timestamp with time zone DEFAULT now() NOT NULL,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,
  updated_at    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT athlete_rate_ranges_athlete_id_rate_type_pk PRIMARY KEY (athlete_id, rate_type)
);

ALTER TABLE athlete_rate_ranges DROP CONSTRAINT IF EXISTS athlete_rate_ranges_confidence_check;
ALTER TABLE athlete_rate_ranges ADD CONSTRAINT athlete_rate_ranges_confidence_check CHECK (confidence IN ('low','medium','high'));

ALTER TABLE athlete_rate_ranges DROP CONSTRAINT IF EXISTS athlete_rate_ranges_range_check;
ALTER TABLE athlete_rate_ranges ADD CONSTRAINT athlete_rate_ranges_range_check CHECK (low >= 0 AND high >= low);

ALTER TABLE athlete_rate_ranges DROP CONSTRAINT IF EXISTS athlete_rate_ranges_athlete_id_athletes_id_fk;
ALTER TABLE athlete_rate_ranges ADD CONSTRAINT athlete_rate_ranges_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;
