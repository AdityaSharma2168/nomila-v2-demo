-- 0054_studio_sessions — Create Anything threads persist (session persistence plan v2 §2, D1–D11 approved 2026-09-14).
--
-- Additive and idempotent; NO transaction control (server/migrationsGuard.test.ts). Applied through scripts/db-migrate.sh only.
-- Nothing reads these tables with STUDIO_SESSIONS off, and no image before this one reads them at all, so applying it
-- DB-first (deploy-prod) is backward-compatible. Rollback is the switch; there is never a DROP.
--   studio_sessions         one thread: whose, its title (her first prompt, one line), archived, last touched
--   studio_session_entries  what was said, in order: her prompt, Mila's plan (the preview she was shown), Mila's ask.
--                           Ids and closed codes only in `payload`. The OUTPUT is not an entry: it is derived at read,
--                           plan → preview → consumed_by_job_id → job → assets, so the spend path writes nothing here.
--   studio_session_entries_session_fk   composite (session_id, athlete_id): an entry cannot land in another athlete's thread
--   uq_studio_session_entries_preview   one entry per preview: a retried or double-mounted plan append is a no-op
--
-- No CHECK on `kind` (prompt | plan | ask, writer-enforced): widening a CHECK is a DROP + ADD pair, and that pair raced
-- and broke two deploys on chat_messages.source.

CREATE TABLE IF NOT EXISTS studio_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  title       text,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_sessions_id_athlete_uniq UNIQUE (id, athlete_id)
);
-- NULLS LAST is Drizzle's spelling of `.desc()`, so this index is byte-for-byte the one every PGlite suite builds
-- (sessions.migration.test.ts); updated_at is NOT NULL, and the list query orders by exactly this.
CREATE INDEX IF NOT EXISTS idx_studio_sessions_athlete_updated ON studio_sessions (athlete_id, updated_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS studio_session_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         bigint GENERATED ALWAYS AS IDENTITY,
  session_id  uuid NOT NULL,
  athlete_id  uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  text        text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  preview_id  uuid REFERENCES studio_generation_previews(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_session_entries_session_fk FOREIGN KEY (session_id, athlete_id)
    REFERENCES studio_sessions (id, athlete_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_studio_session_entries_session ON studio_session_entries (session_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_session_entries_preview ON studio_session_entries (preview_id)
  WHERE preview_id IS NOT NULL;

-- The standing constraint, on the column it is about (plan v2 §2, Retention).
COMMENT ON COLUMN studio_session_entries.preview_id IS
  'A thread references this preview. A future sweep of studio_generation_previews must spare previews an entry '
  'references, or accept that the thread shows "That check is no longer available" (ON DELETE SET NULL).';
