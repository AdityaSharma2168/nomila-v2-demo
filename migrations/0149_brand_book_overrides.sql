-- 0149_brand_book_overrides.sql — the athlete's choices in her brand book, kept beside the engine's book (brand_books).
--
-- A rebuild replaced brand_books.data wholesale, so a line she picked (chooseLine) or wrote with Mila (writeLine) was
-- lost. Her choices now live in their own column, the Nomi Card editor's pattern (card_overrides.data): the engine's
-- book is the base, and server/services/brandBook/overrides.ts lays her choices on top at read and render time.
--   overrides  jsonb  — { copy: { "<pageId>.<slot>": { text, pick? } } }. NULL = no choices.
--
-- One nullable column (expand), then a one-time carry of the choices already stored inside `data`: the copywriter shows
-- the first option of every slot (copy.ts), so a line whose text is not its first option is one she picked or wrote.
-- The carry runs only where overrides IS NULL, and leaves {"copy":{}} behind, so a re-run (db-migrate.sh runs this on
-- every deploy) never touches a row twice; a book built after this change has nothing to carry (its choices are never
-- written into `data`). Idempotent. No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in
-- BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and
-- the shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy.
-- Nothing here names an athlete, sport, school or brand.

ALTER TABLE brand_books ADD COLUMN IF NOT EXISTS overrides jsonb;

UPDATE brand_books b
SET overrides = jsonb_build_object('copy', coalesce((
  SELECT jsonb_object_agg((p.value->>'id') || '.' || l.key, jsonb_build_object('text', l.value->>'text'))
  FROM jsonb_array_elements(b.data->'pages') AS p(value),
       jsonb_each(CASE WHEN jsonb_typeof(p.value->'lines') = 'object' THEN p.value->'lines' ELSE '{}'::jsonb END) AS l(key, value)
  WHERE coalesce(p.value->>'id', '') <> ''
    AND coalesce(btrim(l.value->>'text'), '') <> ''
    AND (l.value->>'text') IS DISTINCT FROM (l.value->'options'->>0)
), '{}'::jsonb))
WHERE b.overrides IS NULL
  AND jsonb_typeof(b.data->'pages') = 'array';
