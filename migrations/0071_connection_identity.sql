-- 0071_connection_identity.sql — one connection row per (athlete, provider account), for life.
-- Plan: docs/plans/connection-identity-fix.md §3 (the invariant) and §5 (this migration).
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declarations (connected_at, connected_accounts_account_uq, connection_merge_log) ship in
-- ONE commit or the drift gate reds the deploy.
--
-- ── WHAT THIS DOES ────────────────────────────────────────────────────────────────────────────────
-- Until now every connect minted a NEW connected_accounts row, so one Gmail mailbox (or Instagram account)
-- could own several rows and its threads/messages kept pointing at old, revoked or under-scoped ones. This
-- file folds every account's rows into one survivor and then makes a second row impossible:
--
--   1. connection_merge_log            every move below is recorded (old row minus its tokens, the survivor,
--                                      how many rows of each referencing table moved) so any merge can be
--                                      reversed by hand.
--   2. fill platform_user_id           a row with no stable account id takes it from ANOTHER row of the SAME
--                                      athlete and platform with the same lower(platform_username) — only when
--                                      that username maps to exactly one id. The only place username matching is
--                                      ever used (plan §9.1), and never across athletes.
--   3. stale pending rows              pending for more than 1 day (§9.3) and referenced by nothing → deleted.
--   4. survivor per account            (athlete_id, platform, platform_user_id): the newest ACTIVE row, else the
--                                      newest row.
--   5. re-point                        inbox_threads, inbox_messages, gmail_dead_letters, social_identities,
--                                      social_sync_runs, social_analytics_snapshots, studio_publish_jobs move from
--                                      every non-survivor to its survivor. gmail_dead_letters is unique on
--                                      (connected_account_id, gmail_message_id): colliding rows are dropped first
--                                      (the one already on the survivor wins, else the newest).
--   6. delete non-survivors            only after asserting nothing points at them (the FKs are SET NULL / CASCADE,
--                                      so a missed reference would otherwise vanish silently). SQL only — no
--                                      provider revoke, so the survivor's grant is untouched.
--   7. connected_at + unique index     connected_at backfilled from created_at for every row that ever connected;
--                                      partial unique index on (athlete_id, platform, platform_user_id).
--   8. assertions                      no referencing row points at a missing connection; per athlete, the total
--                                      AND linked (connected_account_id IS NOT NULL) counts of threads, messages,
--                                      snapshots, sync runs, identities and publish jobs are unchanged; dead
--                                      letters dropped only by the step-5 dedupe. Any failure RAISEs.
--
-- ── SAFETY PROPERTIES ─────────────────────────────────────────────────────────────────────────────
-- • NO transaction control in this file (migrationsGuard.test.ts; the 11 Sep 2026 incident). Steps 2–8 are ONE
--   DO block, i.e. ONE statement: psql autocommits it as a unit, so a RAISE anywhere rolls back every step.
--   Wrapped in an outer BEGIN … ROLLBACK for a dry run it behaves the same and commits nothing.
-- • The DO block LOCKs connected_accounts (SHARE ROW EXCLUSIVE) first, so a connect landing mid-merge waits
--   instead of slipping a duplicate in before the unique index is built.
-- • Idempotent: a second run finds nothing to fill, nothing to merge, the column and index already there. On a
--   database that has no duplicates (prod) it is close to a no-op.
-- • RAISE NOTICE prints the merge plan and the step-8 counts, for the dry run.
-- • Nothing that holds content is deleted: only duplicate connection rows (after re-pointing), stale unreferenced
--   pending rows, and dead-letter rows that duplicate one on the survivor.

CREATE TABLE IF NOT EXISTS connection_merge_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  old_id      uuid NOT NULL,
  survivor_id uuid,
  athlete_id  uuid NOT NULL,
  platform    text NOT NULL,
  reason      text NOT NULL,
  repointed   jsonb,
  old_row     jsonb,
  merged_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connection_merge_log_reason_check CHECK (reason IN ('duplicate_account','stale_pending','filled_platform_user_id'))
);
CREATE INDEX IF NOT EXISTS idx_connection_merge_log_old ON connection_merge_log (old_id);
CREATE INDEX IF NOT EXISTS idx_connection_merge_log_survivor ON connection_merge_log (survivor_id);

ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS connected_at timestamptz;

DO $$
DECLARE
  r              record;
  n_filled       integer := 0;
  n_pending      integer := 0;
  n_merged       integer := 0;
  n_dl_dropped   integer := 0;
  n_dl_before    bigint;
  n_dl_after     bigint;
  n_bad          bigint;
BEGIN
  LOCK TABLE connected_accounts IN SHARE ROW EXCLUSIVE MODE;

  -- ── counts before (step 8 compares against these) ──────────────────────────────────────────────
  DROP TABLE IF EXISTS pg_temp._cif_counts_before;
  CREATE TEMP TABLE _cif_counts_before ON COMMIT DROP AS
    SELECT 'inbox_threads'::text AS tbl, athlete_id, count(*) AS total, count(connected_account_id) AS linked FROM inbox_threads GROUP BY athlete_id
    UNION ALL SELECT 'inbox_messages', athlete_id, count(*), count(connected_account_id) FROM inbox_messages GROUP BY athlete_id
    UNION ALL SELECT 'social_analytics_snapshots', athlete_id, count(*), count(connected_account_id) FROM social_analytics_snapshots GROUP BY athlete_id
    UNION ALL SELECT 'social_sync_runs', athlete_id, count(*), count(connected_account_id) FROM social_sync_runs GROUP BY athlete_id
    UNION ALL SELECT 'social_identities', athlete_id, count(*), count(connected_account_id) FROM social_identities GROUP BY athlete_id
    UNION ALL SELECT 'studio_publish_jobs', athlete_id, count(*), count(connected_account_id) FROM studio_publish_jobs GROUP BY athlete_id;
  SELECT count(*) INTO n_dl_before FROM gmail_dead_letters;

  -- ── step 2: fill a missing platform_user_id from the same athlete+platform+username ──────────────
  FOR r IN
    SELECT c.id, c.athlete_id, c.platform, src.platform_user_id, src.source_id
    FROM connected_accounts c
    JOIN LATERAL (
      SELECT min(s.platform_user_id) AS platform_user_id,
             (array_agg(s.id ORDER BY s.created_at DESC NULLS LAST, s.id DESC))[1] AS source_id
      FROM connected_accounts s
      WHERE s.athlete_id = c.athlete_id
        AND s.platform   = c.platform
        AND s.platform_user_id IS NOT NULL
        AND lower(s.platform_username) = lower(c.platform_username)
      HAVING count(DISTINCT s.platform_user_id) = 1
    ) src ON true
    WHERE c.platform_user_id IS NULL
      AND c.platform_username IS NOT NULL
  LOOP
    INSERT INTO connection_merge_log (old_id, survivor_id, athlete_id, platform, reason, old_row)
    SELECT r.id, r.source_id, r.athlete_id, r.platform, 'filled_platform_user_id',
           to_jsonb(c) - 'access_token' - 'refresh_token'
    FROM connected_accounts c WHERE c.id = r.id;
    UPDATE connected_accounts SET platform_user_id = r.platform_user_id WHERE id = r.id;
    n_filled := n_filled + 1;
    RAISE NOTICE 'fill  %  % athlete=% platform_user_id=% (from %)', r.id, r.platform, r.athlete_id, r.platform_user_id, r.source_id;
  END LOOP;

  -- ── step 3: stale pending rows (> 1 day, referenced by nothing) ──────────────────────────────────
  DROP TABLE IF EXISTS pg_temp._cif_stale;
  CREATE TEMP TABLE _cif_stale ON COMMIT DROP AS
    SELECT c.id FROM connected_accounts c
    WHERE c.status = 'pending'
      AND c.created_at < now() - interval '1 day'
      AND NOT EXISTS (SELECT 1 FROM inbox_threads              t WHERE t.connected_account_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM inbox_messages             t WHERE t.connected_account_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM gmail_dead_letters         t WHERE t.connected_account_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM social_identities          t WHERE t.connected_account_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM social_sync_runs           t WHERE t.connected_account_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM social_analytics_snapshots t WHERE t.connected_account_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM studio_publish_jobs        t WHERE t.connected_account_id = c.id);
  INSERT INTO connection_merge_log (old_id, survivor_id, athlete_id, platform, reason, old_row)
    SELECT c.id, NULL, c.athlete_id, c.platform, 'stale_pending', to_jsonb(c) - 'access_token' - 'refresh_token'
    FROM connected_accounts c JOIN _cif_stale s ON s.id = c.id;
  DELETE FROM connected_accounts c USING _cif_stale s WHERE c.id = s.id;
  GET DIAGNOSTICS n_pending = ROW_COUNT;

  -- ── step 4: one survivor per (athlete_id, platform, platform_user_id) ────────────────────────────
  DROP TABLE IF EXISTS pg_temp._cif_map;
  CREATE TEMP TABLE _cif_map ON COMMIT DROP AS
    SELECT id AS old_id, survivor_id, athlete_id, platform
    FROM (
      SELECT c.id, c.athlete_id, c.platform,
             first_value(c.id) OVER (
               PARTITION BY c.athlete_id, c.platform, c.platform_user_id
               ORDER BY (c.status = 'active') DESC, c.created_at DESC NULLS LAST, c.id DESC
             ) AS survivor_id
      FROM connected_accounts c
      WHERE c.platform_user_id IS NOT NULL
    ) ranked
    WHERE id <> survivor_id;

  -- ── step 5a: gmail_dead_letters — drop rows that would collide on (survivor, gmail_message_id) ───
  WITH t AS (
    SELECT d.id,
           row_number() OVER (
             PARTITION BY COALESCE(m.survivor_id, d.connected_account_id), d.gmail_message_id
             ORDER BY (m.old_id IS NULL) DESC, d.created_at DESC NULLS LAST, d.id DESC
           ) AS rn
    FROM gmail_dead_letters d
    LEFT JOIN _cif_map m ON m.old_id = d.connected_account_id
  )
  DELETE FROM gmail_dead_letters d USING t WHERE d.id = t.id AND t.rn > 1;
  GET DIAGNOSTICS n_dl_dropped = ROW_COUNT;

  -- ── step 5b: log every move with what it carries, then re-point all seven tables ────────────────
  INSERT INTO connection_merge_log (old_id, survivor_id, athlete_id, platform, reason, repointed, old_row)
    SELECT m.old_id, m.survivor_id, m.athlete_id, m.platform, 'duplicate_account',
           jsonb_build_object(
             'inbox_threads',              (SELECT count(*) FROM inbox_threads              t WHERE t.connected_account_id = m.old_id),
             'inbox_messages',             (SELECT count(*) FROM inbox_messages             t WHERE t.connected_account_id = m.old_id),
             'gmail_dead_letters',         (SELECT count(*) FROM gmail_dead_letters         t WHERE t.connected_account_id = m.old_id),
             'social_identities',          (SELECT count(*) FROM social_identities          t WHERE t.connected_account_id = m.old_id),
             'social_sync_runs',           (SELECT count(*) FROM social_sync_runs           t WHERE t.connected_account_id = m.old_id),
             'social_analytics_snapshots', (SELECT count(*) FROM social_analytics_snapshots t WHERE t.connected_account_id = m.old_id),
             'studio_publish_jobs',        (SELECT count(*) FROM studio_publish_jobs        t WHERE t.connected_account_id = m.old_id)
           ),
           to_jsonb(c) - 'access_token' - 'refresh_token'
    FROM _cif_map m JOIN connected_accounts c ON c.id = m.old_id;

  FOR r IN SELECT m.*, l.repointed FROM _cif_map m JOIN connection_merge_log l ON l.old_id = m.old_id AND l.reason = 'duplicate_account' AND l.survivor_id = m.survivor_id LOOP
    RAISE NOTICE 'merge %  →  %  % athlete=% moves=%', r.old_id, r.survivor_id, r.platform, r.athlete_id, r.repointed;
  END LOOP;

  UPDATE inbox_threads              t SET connected_account_id = m.survivor_id FROM _cif_map m WHERE t.connected_account_id = m.old_id;
  UPDATE inbox_messages             t SET connected_account_id = m.survivor_id FROM _cif_map m WHERE t.connected_account_id = m.old_id;
  UPDATE gmail_dead_letters         t SET connected_account_id = m.survivor_id FROM _cif_map m WHERE t.connected_account_id = m.old_id;
  UPDATE social_identities          t SET connected_account_id = m.survivor_id FROM _cif_map m WHERE t.connected_account_id = m.old_id;
  UPDATE social_sync_runs           t SET connected_account_id = m.survivor_id FROM _cif_map m WHERE t.connected_account_id = m.old_id;
  UPDATE social_analytics_snapshots t SET connected_account_id = m.survivor_id FROM _cif_map m WHERE t.connected_account_id = m.old_id;
  UPDATE studio_publish_jobs        t SET connected_account_id = m.survivor_id FROM _cif_map m WHERE t.connected_account_id = m.old_id;

  -- ── step 6: delete non-survivors — only once nothing points at them ─────────────────────────────
  SELECT (SELECT count(*) FROM inbox_threads              t JOIN _cif_map m ON t.connected_account_id = m.old_id)
       + (SELECT count(*) FROM inbox_messages             t JOIN _cif_map m ON t.connected_account_id = m.old_id)
       + (SELECT count(*) FROM gmail_dead_letters         t JOIN _cif_map m ON t.connected_account_id = m.old_id)
       + (SELECT count(*) FROM social_identities          t JOIN _cif_map m ON t.connected_account_id = m.old_id)
       + (SELECT count(*) FROM social_sync_runs           t JOIN _cif_map m ON t.connected_account_id = m.old_id)
       + (SELECT count(*) FROM social_analytics_snapshots t JOIN _cif_map m ON t.connected_account_id = m.old_id)
       + (SELECT count(*) FROM studio_publish_jobs        t JOIN _cif_map m ON t.connected_account_id = m.old_id)
    INTO n_bad;
  IF n_bad > 0 THEN
    RAISE EXCEPTION '0071: % referencing rows still point at a non-survivor after re-pointing — aborting', n_bad;
  END IF;
  DELETE FROM connected_accounts c USING _cif_map m WHERE c.id = m.old_id;
  GET DIAGNOSTICS n_merged = ROW_COUNT;

  -- ── step 7: connected_at backfill + the invariant ──────────────────────────────────────────────
  UPDATE connected_accounts SET connected_at = created_at
   WHERE connected_at IS NULL AND status IS DISTINCT FROM 'pending';
  CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_account_uq
    ON connected_accounts (athlete_id, platform, platform_user_id)
    WHERE platform_user_id IS NOT NULL;

  -- ── step 8: assertions ─────────────────────────────────────────────────────────────────────────
  SELECT (SELECT count(*) FROM inbox_threads              t WHERE t.connected_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM connected_accounts c WHERE c.id = t.connected_account_id))
       + (SELECT count(*) FROM inbox_messages             t WHERE t.connected_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM connected_accounts c WHERE c.id = t.connected_account_id))
       + (SELECT count(*) FROM gmail_dead_letters         t WHERE NOT EXISTS (SELECT 1 FROM connected_accounts c WHERE c.id = t.connected_account_id))
       + (SELECT count(*) FROM social_identities          t WHERE t.connected_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM connected_accounts c WHERE c.id = t.connected_account_id))
       + (SELECT count(*) FROM social_sync_runs           t WHERE t.connected_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM connected_accounts c WHERE c.id = t.connected_account_id))
       + (SELECT count(*) FROM social_analytics_snapshots t WHERE t.connected_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM connected_accounts c WHERE c.id = t.connected_account_id))
       + (SELECT count(*) FROM studio_publish_jobs        t WHERE t.connected_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM connected_accounts c WHERE c.id = t.connected_account_id))
    INTO n_bad;
  IF n_bad > 0 THEN
    RAISE EXCEPTION '0071: % referencing rows point at a connection that does not exist — aborting', n_bad;
  END IF;

  DROP TABLE IF EXISTS pg_temp._cif_counts_after;
  CREATE TEMP TABLE _cif_counts_after ON COMMIT DROP AS
    SELECT 'inbox_threads'::text AS tbl, athlete_id, count(*) AS total, count(connected_account_id) AS linked FROM inbox_threads GROUP BY athlete_id
    UNION ALL SELECT 'inbox_messages', athlete_id, count(*), count(connected_account_id) FROM inbox_messages GROUP BY athlete_id
    UNION ALL SELECT 'social_analytics_snapshots', athlete_id, count(*), count(connected_account_id) FROM social_analytics_snapshots GROUP BY athlete_id
    UNION ALL SELECT 'social_sync_runs', athlete_id, count(*), count(connected_account_id) FROM social_sync_runs GROUP BY athlete_id
    UNION ALL SELECT 'social_identities', athlete_id, count(*), count(connected_account_id) FROM social_identities GROUP BY athlete_id
    UNION ALL SELECT 'studio_publish_jobs', athlete_id, count(*), count(connected_account_id) FROM studio_publish_jobs GROUP BY athlete_id;

  SELECT count(*) INTO n_bad
  FROM _cif_counts_before b
  FULL JOIN _cif_counts_after a ON a.tbl = b.tbl AND a.athlete_id = b.athlete_id
  WHERE a.tbl IS NULL OR b.tbl IS NULL OR a.total <> b.total OR a.linked <> b.linked;
  IF n_bad > 0 THEN
    RAISE EXCEPTION '0071: % (table, athlete) counts changed during the merge — aborting', n_bad;
  END IF;

  SELECT count(*) INTO n_dl_after FROM gmail_dead_letters;
  IF n_dl_after <> n_dl_before - n_dl_dropped THEN
    RAISE EXCEPTION '0071: gmail_dead_letters went from % to % but only % were deduplicated — aborting', n_dl_before, n_dl_after, n_dl_dropped;
  END IF;

  SELECT count(*) INTO n_bad FROM (
    SELECT 1 FROM connected_accounts WHERE platform_user_id IS NOT NULL
    GROUP BY athlete_id, platform, platform_user_id HAVING count(*) > 1
  ) dup;
  IF n_bad > 0 THEN
    RAISE EXCEPTION '0071: % accounts still have more than one row — aborting', n_bad;
  END IF;

  RAISE NOTICE '0071 done: filled=% stale_pending_deleted=% merged_rows_deleted=% dead_letters_deduplicated=%',
    n_filled, n_pending, n_merged, n_dl_dropped;
END
$$;
