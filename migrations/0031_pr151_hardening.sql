-- 0031 — PR #151 hardening: first-class thread aliases.
--
-- Additive and idempotent. Hand-written; applied by `psql -f` from the deploy workflow,
-- because the hand-written migrations are not in the drizzle journal (it stops at 0011).
--
-- ── What this is for ─────────────────────────────────────────────────────────
-- One physical email delivered to two connected inboxes creates two Gmail thread ids. The
-- second must join the first thread rather than mint a rival one, so the extra ids are
-- recorded as ALIASES.
--
-- They used to live inside `inbox_threads.classification` (JSONB). That is the bug: a
-- re-classification rewrites that column wholesale, so the aliases vanished and the deal
-- re-split into two. A first-class column cannot be clobbered by a write that is about
-- something else, and `array_append` makes registering one a single atomic statement rather
-- than a read-modify-write two webhooks can interleave.
--
-- ── What this migration NO LONGER does, and why ───────────────────────────────
-- As originally written (as 0016, in August) it also created a partial UNIQUE index on
-- (athlete_id, gmail_message_id_header) and DELETED legacy header-duplicate rows so that
-- index could be created.
--
-- Both were removed before merge, because both had already happened by other means:
--
--   · the index is in production as `inbox_messages_athlete_msgid_uniq`, landed separately.
--     Creating a second identical index under a different name is pure redundancy.
--   · the duplicate rows are gone — verified zero before this merge, which follows from the
--     index existing at all, since its creation would have failed otherwise.
--
-- That matters beyond tidiness. The DELETE was the one part of this PR that touched data
-- rather than schema, and the reason it asked for a database backup and a second reviewer.
-- Running it now would be risk with nothing to gain: it would scan for duplicates it cannot
-- find, on a table it has no other business writing to.

-- The alias list. GIN because the lookup is "which thread claims this external id".
ALTER TABLE inbox_threads ADD COLUMN IF NOT EXISTS alias_thread_ids text[];
CREATE INDEX IF NOT EXISTS idx_threads_alias_ids ON inbox_threads USING GIN (alias_thread_ids);

-- One-time move of aliases already recorded in the JSONB, so nothing registered before this
-- column existed is lost. Idempotent: rows whose aliases are already in the column are
-- skipped, and the JSONB key is left in place rather than stripped — reading it costs
-- nothing, and a failed deploy that reverted the code would still find it there.
UPDATE inbox_threads
   SET alias_thread_ids = ARRAY(
         SELECT DISTINCT jsonb_array_elements_text(classification -> 'alias_thread_ids')
       )
 WHERE classification ? 'alias_thread_ids'
   AND jsonb_typeof(classification -> 'alias_thread_ids') = 'array'
   AND (alias_thread_ids IS NULL OR cardinality(alias_thread_ids) = 0);

COMMENT ON COLUMN inbox_threads.alias_thread_ids IS
  'Additional external thread ids that resolve to this thread (one email, two mailboxes). First-class so a re-classification cannot clobber it.';
