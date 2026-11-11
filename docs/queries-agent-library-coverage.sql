-- READ ONLY. Aggregate counts only, one athlete (resolved by email), no rows, no names, no paths.
-- Question: of the assets the planner could cast from, how many are actually castable
-- (vision + embedding present) and how many were set down by enrichment?

\set ON_ERROR_STOP on

-- 0. Did the athlete resolve at all? `athletes.email` is nullable, so a query that silently
--    matched nobody would return a tidy row of zeros and read exactly like "nothing is abandoned".
--    This says which it is, and prints no name, no id and no address.
SELECT
  count(*)                                        AS athletes_matched,
  CASE WHEN count(*) = 1 THEN 'ok — the numbers below are yours'
       WHEN count(*) = 0 THEN 'NO MATCH — athletes.email is not set for you; pass your athlete id instead'
       ELSE 'MORE THAN ONE MATCH — the numbers below are only the first'
  END                                             AS resolution
FROM athletes
WHERE email = 'aditya.sharma2168@gmail.com';

WITH me AS (
  SELECT id FROM athletes WHERE email = 'aditya.sharma2168@gmail.com' LIMIT 1
),
lib AS (
  SELECT
    media_type,
    origin,
    (metadata -> 'vision') IS NOT NULL AS has_vision,
    (jsonb_typeof(metadata -> 'embedding') = 'array'
      AND jsonb_array_length(metadata -> 'embedding') > 0) AS has_embedding,
    (metadata -> 'enrichment' ->> 'abandoned_at') IS NOT NULL AS abandoned,
    (metadata -> 'enrichment' ->> 'abandoned_reason') AS abandoned_reason,
    COALESCE((metadata -> 'enrichment' ->> 'attempts')::int, 0) AS attempts
  FROM media_assets
  WHERE athlete_id = (SELECT id FROM me)
    AND status = 'stored'
    AND parent_media_id IS NULL
    AND deleted_at IS NULL
)
SELECT
  count(*)                                                      AS stored_top_level,
  count(*) FILTER (WHERE has_vision AND has_embedding)          AS castable,
  count(*) FILTER (WHERE NOT (has_vision AND has_embedding))    AS not_castable,
  count(*) FILTER (WHERE abandoned)                             AS abandoned,
  count(*) FILTER (WHERE abandoned_reason = 'attempts')         AS abandoned_attempts,
  count(*) FILTER (WHERE abandoned_reason = 'oversize')         AS abandoned_oversize,
  count(*) FILTER (WHERE NOT abandoned AND attempts > 0)        AS failing_not_yet_set_down,
  round(100.0 * count(*) FILTER (WHERE has_vision AND has_embedding)
        / NULLIF(count(*), 0), 1)                               AS castable_pct
FROM lib;

-- The same split by what it is and where it came from, because the picker shows
-- origin='upload' photos while the planner casts across everything.
WITH me AS (
  SELECT id FROM athletes WHERE email = 'aditya.sharma2168@gmail.com' LIMIT 1
)
SELECT
  media_type,
  origin,
  count(*)                                                                  AS n,
  count(*) FILTER (
    WHERE (metadata -> 'vision') IS NOT NULL
      AND jsonb_typeof(metadata -> 'embedding') = 'array'
      AND jsonb_array_length(metadata -> 'embedding') > 0)                  AS castable,
  count(*) FILTER (
    WHERE (metadata -> 'enrichment' ->> 'abandoned_at') IS NOT NULL)        AS abandoned
FROM media_assets
WHERE athlete_id = (SELECT id FROM me)
  AND status = 'stored'
  AND parent_media_id IS NULL
  AND deleted_at IS NULL
GROUP BY 1, 2
ORDER BY 1, 2;
