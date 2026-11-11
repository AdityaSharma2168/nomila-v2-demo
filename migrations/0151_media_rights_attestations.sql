-- 0151_media_rights_attestations.sql — the athlete's word that they may post their media (content engine step 2,
-- owner decision 9 Nov 2026: "rights attestation once per source asset, remembered, revocable, own posts only; a
-- sponsored post keeps a per-deal confirmation"; server/agent/ready/rights.ts).
--
--   media_rights_attestations   one row per word given on "Post it":
--     own_posts   once per SOURCE ASSET (asset_id, plus asset_ref / asset_kind naming it): "these are my own photos and
--                 clips" — covers their own posts only
--     sponsored   once per DEAL (deal_key: the matching deal / gift / affiliate record, "deal:<id>" or "shop:<id>"; only
--                 with no record, "brand:<name>"): the rights to use them in a sponsored post for that partner
--   Revoking sets revoked_at (the row stays: what was said and when); a new word is a new row. At most one live row per
--   (athlete, asset) and per (athlete, deal): two partial unique indexes. `words` is the exact line shown, at
--   `words_version`. Deleted with the athlete (ON DELETE CASCADE; athleteDataManifest lists it). KEPT when the photo or
--   clip is deleted (owner decision 10 Nov 2026): asset_id becomes NULL (ON DELETE SET NULL) and asset_ref / asset_kind
--   still say which asset it was. A NULL asset_id confirms nothing: the live-asset index and every lookup read asset_id.
--
-- Used only while CONTENT_READY_QUEUE is on (off in both Cloud Run yamls): with it off nothing reads or writes this
-- table. Pure DDL, additive only (expand): one new table, its constraints and indexes; nothing renamed, dropped,
-- altered or backfilled, and NO rows are written. Idempotent (IF NOT EXISTS throughout; the FKs are inline), safe to
-- re-run, which scripts/db-migrate.sh does on every deploy. No transaction control here (migrationsGuard): dry-run this
-- file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names it in the step-3 list; this
-- file, that line and the shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy. Nothing
-- here names an athlete, sport, school or brand.

CREATE TABLE IF NOT EXISTS media_rights_attestations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    uuid NOT NULL CONSTRAINT media_rights_attestations_athlete_id_athletes_id_fk REFERENCES athletes(id) ON DELETE CASCADE,
  scope         text NOT NULL,
  asset_id      uuid CONSTRAINT media_rights_attestations_asset_id_media_assets_id_fk REFERENCES media_assets(id) ON DELETE SET NULL,
  asset_ref     text,
  asset_kind    text,
  deal_key      text,
  brand         text,
  item_id       uuid,
  words         text NOT NULL,
  words_version text NOT NULL,
  attested_at   timestamptz DEFAULT now() NOT NULL,
  revoked_at    timestamptz,
  CONSTRAINT media_rights_attestations_scope_check CHECK ((scope = 'own_posts' AND asset_ref IS NOT NULL AND deal_key IS NULL) OR (scope = 'sponsored' AND deal_key IS NOT NULL AND asset_id IS NULL AND asset_ref IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_rights_live_asset ON media_rights_attestations USING btree (athlete_id, asset_id) WHERE scope = 'own_posts' AND revoked_at IS NULL AND asset_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_rights_live_deal ON media_rights_attestations USING btree (athlete_id, deal_key) WHERE scope = 'sponsored' AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_media_rights_athlete ON media_rights_attestations USING btree (athlete_id, attested_at);
