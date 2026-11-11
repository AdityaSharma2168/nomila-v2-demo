-- One-time backfill: deals created via detectDeal's scoring-failed fallback
-- were inserted without the inbox_threads.deal_id back-link (the scored path
-- sets it; the fallback path didn't until the accompanying code fix). An
-- unlinked deal surfaces in the app with thread_id NULL, which disables the
-- in-app threaded reply and bounces the user to the external mail compose.
-- The thread id was always recorded in deals.raw_data — promote it to the
-- real link. Newest deal wins if several orphans point at the same thread.
-- Idempotent: only touches threads whose deal_id is still NULL.
UPDATE inbox_threads t
SET deal_id = d.deal_id
FROM (
  SELECT DISTINCT ON (raw_data->>'thread_id')
         raw_data->>'thread_id' AS tid,
         id                     AS deal_id
  FROM deals
  WHERE raw_data->>'thread_id' IS NOT NULL
  ORDER BY raw_data->>'thread_id', detected_at DESC NULLS LAST
) d
WHERE t.deal_id IS NULL
  AND d.tid = t.id::text;
