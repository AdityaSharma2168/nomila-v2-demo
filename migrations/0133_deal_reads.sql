-- 0133_deal_reads.sql — the model half of a deal's four-line read (deals design §5 "The read"), behind DEALS_READ_MODEL.
--
-- Money and Risk are worked out in code on every read and are not stored. Fit ("why this brand fits you", confirmed
-- research only) and Goal ("helps your goal: …") come from one small OpenAI call (skill deal-read) and are stored here
-- once per athlete + deal. inputs_key digests what the call read (the brand's research and identity verdict, her goals,
-- the deal's ask): a change to any of them makes the row stale, so it is not served and is refilled.
--
-- Additive: one new table, its constraints and one index; nothing existing changes. Idempotent (IF NOT EXISTS, or
-- DROP-then-ADD of a named constraint) — safe to re-run, which scripts/db-migrate.sh does on every deploy. Names and
-- definitions are written exactly as a shared/schema.ts push produces them. No transaction control here
-- (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names
-- it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in ONE commit or the drift gate
-- reds the deploy. Numbered 0133 after 0132 (athlete_rate_ranges, the PR this one stacks on). Nothing here names an
-- athlete, sport, school or brand.

CREATE TABLE IF NOT EXISTS deal_reads (
  athlete_id    uuid NOT NULL,
  deal_id       uuid NOT NULL,
  brand_id      integer,
  fit_line      text,
  goal_id       uuid,
  goal_line     text,
  inputs_key    text NOT NULL,
  skill_version text,
  run_id        uuid,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,
  updated_at    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT deal_reads_athlete_id_deal_id_pk PRIMARY KEY (athlete_id, deal_id)
);

ALTER TABLE deal_reads DROP CONSTRAINT IF EXISTS deal_reads_athlete_id_athletes_id_fk;
ALTER TABLE deal_reads ADD CONSTRAINT deal_reads_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE deal_reads DROP CONSTRAINT IF EXISTS deal_reads_deal_id_deals_id_fk;
ALTER TABLE deal_reads ADD CONSTRAINT deal_reads_deal_id_deals_id_fk
  FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE deal_reads DROP CONSTRAINT IF EXISTS deal_reads_brand_id_inbox_brands_id_fk;
ALTER TABLE deal_reads ADD CONSTRAINT deal_reads_brand_id_inbox_brands_id_fk
  FOREIGN KEY (brand_id) REFERENCES public.inbox_brands(id) ON DELETE set null ON UPDATE no action;

CREATE INDEX IF NOT EXISTS idx_deal_reads_brand ON deal_reads USING btree (brand_id);
