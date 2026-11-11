-- Extensions the schema depends on (pgvector for embeddings, pg_trgm for search).
--
-- Extracted VERBATIM from .github/workflows/deploy.yml on 2026-09-08 (PR B of the
-- environment split). This was the inline `psql -c` block that every deploy re-ran;
-- it is idempotent and now runs from this file, in the same order, via
-- scripts/db-migrate.sh — in dev and in prod alike. Nothing here is in the drizzle
-- journal; the re-baseline (docs/plans/production-environment-split.md, Track D)
-- folds it into 0000_baseline.

CREATE EXTENSION IF NOT EXISTS vector;
-- pg_trgm is used by the search indexes (migrations/0003) and existed in dev only
-- because a hand-run created it; a fresh database needs it here.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
