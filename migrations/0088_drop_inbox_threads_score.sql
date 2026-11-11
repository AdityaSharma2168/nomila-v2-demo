-- 0088_drop_inbox_threads_score.sql — drop the retired 1–10 deal score (inbox_threads.score).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts removal ship in ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS REMOVES ─────────────────────────────────────────────────────────────────────────────
-- inbox_threads.score — the jsonb the deal scorer wrote (scoreNumeric, verdict, recommendation, fit and
--   brand analysis, negotiate_terms, draft_points, economicsState, …). The scorer and every writer were
--   deleted in #791 (owner decision 6 Oct 2026: no scoring; the deterministic opportunity board orders
--   the work). This commit removes the last readers, so nothing reads or writes the column. No index,
--   view or constraint references it. The deal score never had a history table of its own.
--
--   NOT touched: the athlete marketability score (athlete_snapshots.score, athletes_current.display_score
--   / internal_score / score_updated_at, the M.I.A. ledger) — a different thing that is still live.
--
-- DESTRUCTIVE: the stored per-thread score history is discarded. A catalog-only change (no table
-- rewrite). Re-runs as a no-op. No transaction control here (migrationsGuard): dry-run this file ON ITS
-- OWN in BEGIN … ROLLBACK.

ALTER TABLE inbox_threads DROP COLUMN IF EXISTS score;
