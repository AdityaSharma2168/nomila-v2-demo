-- 0138_oauth_connect_states.sql — OAuth connect state bound to the browser and single-use (security review, 24 Oct 2026).
--
-- One row per connect started at POST /api/v1/me/connect/:platform. The OAuth callback accepts a signed state only if
-- its row exists, is unused, unexpired, and matches the athlete and platform; a browser connect also needs the HttpOnly
-- cookie set on the connect response (binding_hash = sha256 of it). nonce_hash is sha256 of the state's nonce: nothing
-- usable is stored. 10-minute life; rows are pruned a day after expiry (server/lib/oauthConnectState.ts). Deleted with
-- the athlete (ON DELETE CASCADE; athleteDataManifest lists it).
--
-- Pure DDL, additive only (expand): one new table and its indexes; nothing else is touched. Idempotent (IF NOT EXISTS
-- throughout), safe to re-run, which scripts/db-migrate.sh does on every deploy. No transaction control here
-- (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names
-- it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in ONE commit or the drift gate
-- reds the deploy. Nothing here names an athlete, sport, school or brand.

CREATE TABLE IF NOT EXISTS oauth_connect_states (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce_hash   text NOT NULL,
  athlete_id   uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  platform     text NOT NULL,
  binding_hash text,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_connect_states_nonce ON oauth_connect_states USING btree (nonce_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_connect_states_athlete ON oauth_connect_states USING btree (athlete_id);
CREATE INDEX IF NOT EXISTS idx_oauth_connect_states_expires ON oauth_connect_states USING btree (expires_at);
