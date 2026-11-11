-- 0010 — dedup duplicate inbox_threads, then add the (athlete_id, external_thread_id)
-- unique index that prevents the connect-time backfill-vs-webhook race from ever
-- creating two threads (and two deals) for one email again. Also indexes the
-- idempotency gate's lookup (athlete_id, external_message_id).
--
-- Idempotent + re-runnable: after the first pass there are no dupes and the indexes
-- already exist, so every statement becomes a no-op.

DROP TABLE IF EXISTS _thread_dupes;--> statement-breakpoint

-- Keeper = oldest thread per (athlete_id, external_thread_id); everything else is a dupe.
CREATE TEMP TABLE _thread_dupes AS
SELECT t.id AS dupe_id, t.deal_id AS dupe_deal_id, k.keeper_id
FROM inbox_threads t
JOIN (
  SELECT DISTINCT ON (athlete_id, external_thread_id)
         id AS keeper_id, athlete_id, external_thread_id
  FROM inbox_threads
  WHERE external_thread_id IS NOT NULL
  ORDER BY athlete_id, external_thread_id, created_at ASC NULLS LAST, id
) k ON k.athlete_id = t.athlete_id AND k.external_thread_id = t.external_thread_id
WHERE t.external_thread_id IS NOT NULL AND t.id <> k.keeper_id;--> statement-breakpoint

-- Collapse messages that will share a keeper: keep the earliest row per
-- external_message_id (across the keeper + all its dupes), delete the rest — so the
-- repoint below can't violate the (thread_id, external_message_id) unique.
DELETE FROM inbox_messages m
USING (
  SELECT m2.id,
         row_number() OVER (
           PARTITION BY COALESCE(d.keeper_id, m2.thread_id), m2.external_message_id
           ORDER BY m2.received_at ASC NULLS LAST, m2.created_at ASC NULLS LAST, m2.id
         ) AS rn
  FROM inbox_messages m2
  LEFT JOIN _thread_dupes d ON d.dupe_id = m2.thread_id
  WHERE m2.external_message_id IS NOT NULL
    AND (d.dupe_id IS NOT NULL OR m2.thread_id IN (SELECT keeper_id FROM _thread_dupes))
) ranked
WHERE m.id = ranked.id AND ranked.rn > 1;--> statement-breakpoint

-- Repoint the surviving dupe-thread messages onto the keeper.
UPDATE inbox_messages m SET thread_id = d.keeper_id
FROM _thread_dupes d WHERE m.thread_id = d.dupe_id;--> statement-breakpoint

-- If the keeper has no deal but one of its dupes did, adopt that deal onto the keeper.
UPDATE inbox_threads t SET deal_id = sub.dupe_deal_id
FROM (
  SELECT DISTINCT ON (keeper_id) keeper_id, dupe_deal_id
  FROM _thread_dupes
  WHERE dupe_deal_id IS NOT NULL
  ORDER BY keeper_id, dupe_deal_id
) sub
WHERE t.id = sub.keeper_id AND t.deal_id IS NULL;--> statement-breakpoint

-- Delete the now message-free dupe threads (drops their deal_id references).
DELETE FROM inbox_threads WHERE id IN (SELECT dupe_id FROM _thread_dupes);--> statement-breakpoint

-- Delete dupe deals that ended up linked to no thread (keeper already had its own).
DELETE FROM deals dl
WHERE dl.id IN (SELECT dupe_deal_id FROM _thread_dupes WHERE dupe_deal_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM inbox_threads t WHERE t.deal_id = dl.id);--> statement-breakpoint

-- Recompute keeper counters from the real message rows.
UPDATE inbox_threads t
SET message_count = c.n, last_message_at = c.latest
FROM (SELECT thread_id, count(*) n, max(received_at) latest FROM inbox_messages GROUP BY thread_id) c
WHERE c.thread_id = t.id AND t.id IN (SELECT keeper_id FROM _thread_dupes);--> statement-breakpoint

DROP TABLE IF EXISTS _thread_dupes;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_messages_athlete_external" ON "inbox_messages" USING btree ("athlete_id","external_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_threads_athlete_external" ON "inbox_threads" USING btree ("athlete_id","external_thread_id");
