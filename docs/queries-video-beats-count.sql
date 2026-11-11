-- READ-ONLY. Counts, for one athlete, how many of her clips have been read AS clips (C2 Half A:
-- `metadata.vision.beats` present) against how many are candidates for it. Run by hand, through
-- the Cloud SQL proxy, before the flag flips and again after the cron has drained — the two
-- numbers should swap. Card: docs/studio-video-intelligence-card.md.
--
-- One athlete, resolved by email — the same scoping as docs/queries-video-enrichment-unabandon.sql.
-- Nothing here writes; there is no confirm form because there is nothing to confirm.

\set ON_ERROR_STOP on

SELECT count(*) AS athletes_matched
FROM athletes
WHERE email = 'aditya.sharma2168@gmail.com';

-- The candidate predicate, exactly as studio/enrich/videoEnrichment.ts writes it (VIDEO_UNTAGGED),
-- plus the worker's own stored / top-level conditions.
WITH clips AS (
  SELECT
    origin,
    (gcs_thumb_path IS NOT NULL)                                   AS has_poster,
    (metadata -> 'vision' IS NOT NULL)                             AS has_vision,
    (metadata -> 'vision' -> 'beats' IS NOT NULL)                  AS has_beats,
    (metadata -> 'vision' -> 'prev' IS NOT NULL)                   AS has_prev,
    -- prev carrying a `video` record means the row was read as a clip TWICE (two runs in flight,
    -- before the compare-and-set write) and the poster-derived object is gone for the eval.
    (metadata -> 'vision' -> 'prev' -> 'video' IS NOT NULL)        AS double_read,
    (metadata -> 'enrichment' ->> 'abandoned_at' IS NOT NULL)      AS abandoned,
    metadata -> 'enrichment' ->> 'abandoned_reason'                AS abandoned_reason,
    metadata -> 'vision' -> 'video' ->> 'model'                    AS model,
    jsonb_array_length(coalesce(metadata -> 'vision' -> 'beats', '[]'::jsonb)) AS beats
  FROM media_assets
  WHERE athlete_id = (SELECT id FROM athletes WHERE email = 'aditya.sharma2168@gmail.com' LIMIT 1)
    AND status = 'stored'
    AND parent_media_id IS NULL
    AND deleted_at IS NULL
    AND gcs_path IS NOT NULL
    AND coalesce(content_type, '') LIKE 'video/%'
)
SELECT
  origin,
  count(*)                                                        AS clips,
  count(*) FILTER (WHERE has_poster AND NOT has_beats AND NOT abandoned) AS candidates,
  count(*) FILTER (WHERE has_beats)                               AS read_as_clip,
  count(*) FILTER (WHERE has_beats AND has_prev)                  AS with_prev,
  count(*) FILTER (WHERE double_read)                             AS double_read,
  count(*) FILTER (WHERE abandoned)                               AS abandoned,
  string_agg(DISTINCT abandoned_reason, ',')                      AS abandoned_reasons,
  string_agg(DISTINCT model, ',')                                 AS models,
  round(avg(beats) FILTER (WHERE has_beats), 2)                   AS avg_beats
FROM clips
GROUP BY origin
ORDER BY origin;
