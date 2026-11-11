-- ONE-TIME, AND IT WRITES. Run by hand, through the Cloud SQL proxy — never by Claude, never by a
-- deploy, never from a cron. Card: docs/studio-video-enrichment-card.md.
--
-- Un-abandons VIDEO rows that enrichment set down while they had no poster, and that HAVE one now,
-- so the ordinary enrichment cron picks them up and reads the poster. One athlete, resolved by
-- email — the same scoping as docs/queries-agent-library-coverage.sql.
--
-- THE PREDICATE, exactly:
--   abandoned_at IS NOT NULL  AND  media_type = 'VIDEO'  AND  gcs_thumb_path IS NOT NULL
-- A row still without a poster is left abandoned; running this again after its poster lands
-- catches it. (It cannot be re-abandoned for posterlessness: since the enrichment gate, a video
-- with no poster is not a candidate at all.)
--
-- WHAT "RESET" MEANS: `metadata - 'enrichment'`. The whole bookkeeping key goes — attempts,
-- last_attempt_at, abandoned_at, abandoned_missing, abandoned_reason — which is exactly what
-- enrichRows does itself the moment a row finally succeeds. vision and embedding are untouched.
--
-- TWO RUNS, BOTH NON-INTERACTIVE:
--   1. Without -v confirm: prints the count and rolls back. Nothing is written.
--   2. With -v confirm=<that count>: applies, and COMMITS only if exactly that many rows changed.
--      A different number, or a count that moved in between, rolls back and writes nothing.

\set ON_ERROR_STOP on

SELECT count(*) AS athletes_matched
FROM athletes
WHERE email = 'aditya.sharma2168@gmail.com';

BEGIN;

SELECT count(*) AS n
FROM media_assets
WHERE athlete_id = (SELECT id FROM athletes WHERE email = 'aditya.sharma2168@gmail.com' LIMIT 1)
  AND (metadata -> 'enrichment' ->> 'abandoned_at') IS NOT NULL
  AND media_type = 'VIDEO'
  AND gcs_thumb_path IS NOT NULL
\gset

\echo
\echo 'Rows that would be un-abandoned:' :n

\if :{?confirm}
  SELECT (:'confirm' = :'n') AS go \gset
  \if :go
    WITH u AS (
      UPDATE media_assets
         SET metadata = metadata - 'enrichment',
             metadata_updated_at = now()
       WHERE athlete_id = (SELECT id FROM athletes WHERE email = 'aditya.sharma2168@gmail.com' LIMIT 1)
         AND (metadata -> 'enrichment' ->> 'abandoned_at') IS NOT NULL
         AND media_type = 'VIDEO'
         AND gcs_thumb_path IS NOT NULL
      RETURNING 1
    )
    SELECT count(*) AS updated FROM u
    \gset
    SELECT (:updated = :n) AS same \gset
    \if :same
      COMMIT;
      \echo 'COMMITTED. Rows un-abandoned:' :updated
    \else
      ROLLBACK;
      \echo 'ROLLED BACK — the update touched' :updated 'rows, not' :n '. Nothing was written.'
    \endif
  \else
    ROLLBACK;
    \echo 'ROLLED BACK — confirm=' :confirm 'does not match the count' :n '. Nothing was written.'
  \endif
\else
  ROLLBACK;
  \echo 'Dry run — nothing was written. To apply, run again with: -v confirm=' :n
\endif
