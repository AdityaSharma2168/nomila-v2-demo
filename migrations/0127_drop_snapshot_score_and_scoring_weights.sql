-- 0127_drop_snapshot_score_and_scoring_weights.sql — legacy /850 score + v3 rates retirement, P3-2.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list. Deleting 0040 / 0042 (the scoring_weights
-- inserts db-migrate.sh re-ran on every deploy) ships in this same commit, or the next deploy fails on the missing table.
--
-- DEPLOY ORDER (deploy-window split): P2-4 → P2-5 → P3-0 (the shared/schema.ts removal and the manifest entry, NO
-- DDL) merged AND deployed first; then P3-1 (0126) and this file in a LATER deploy. Prod: backup first.
--
-- ── WHAT THIS REMOVES ─────────────────────────────────────────────────────────────────────────────
-- athlete_snapshots.score — the legacy v7.2 score result (jsonb). Written by the legacy research / connect / nightly
--   paths until P2-4; its only reader (the voice score-history route) was deleted in P2-5. The snapshot rows stay:
--   they still carry research, social, deals, sources and first_look.
-- scoring_weights — the v7.2 engine's versioned weights (and its active-row unique index + status check). Read only
--   by the deleted weightsService (P2-5). No foreign key points at it.
--
-- Catalog-only for the column; the table drop removes its rows. Re-runs as a no-op. No transaction control here
-- (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

ALTER TABLE athlete_snapshots DROP COLUMN IF EXISTS score;
DROP TABLE IF EXISTS scoring_weights;
