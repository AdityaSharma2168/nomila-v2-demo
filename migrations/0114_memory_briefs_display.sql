-- 0114_memory_briefs_display.sql — the Brief's structured display fields (owner decision, 10 Oct 2026).
--
-- memory_briefs.display   the stage { label, band, confidence, why, factIds } and the positioning { from, to,
--                         statement, pillars, factIds } exactly as Understand (skill understand 1.7.0) returned them,
--                         keys stripped from prose and refs mapped to fact ids. Until now the stage band and
--                         confidence lived only in the internal read and the positioning was flattened into lines; the
--                         Scouting report hero shows positioning.statement over "<stage label> · <band>". Shown to the
--                         athlete (unlike memory_briefs.internal). NULL for every brief written before this column.
--
-- Additive and nullable: no existing row changes, nothing is backfilled. Re-runs as a no-op (IF NOT EXISTS). Written
-- exactly as a shared/schema.ts push produces it. No transaction control here (migrationsGuard): dry-run this file ON
-- ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that
-- line and the shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy. Nothing here names
-- an athlete, sport, school or brand.

ALTER TABLE memory_briefs ADD COLUMN IF NOT EXISTS display jsonb;
