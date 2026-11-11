-- 0152_mila_voice_settings.sql — Mila's voice and language, per athlete (owner decisions 10 Nov 2026; design "Mila's voice
-- and language"). Read and written by server/services/milaVoice/settings.ts behind GET/PUT /api/v1/me/mila/voice-language.
--
--   mila_voice_settings  one row per athlete, absent = the defaults:
--     voice                  a catalogue id (server/services/milaVoice/catalogue.ts), NULL = Mila's default voice. Not a
--                            provider voice name, and not CHECKed here: the API validates it against the catalogue, so a
--                            catalogue change never needs a migration.
--     conversation_language  'auto' (talk in the language the athlete uses) or a supported BCP-47 tag ('en', 'es').
--     post_languages         the "post in" languages for captions (at most two), stored now, read by nothing yet.
--
-- Pure DDL, additive only: one new table; nothing existing is touched. Idempotent (IF NOT EXISTS), safe to re-run, which
-- scripts/db-migrate.sh does on every deploy. No transaction control here (migrationsGuard): dry-run this file ON ITS OWN
-- in BEGIN … ROLLBACK. Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and
-- the shared/schema.ts declaration ship in ONE commit or the drift gate reds the deploy. (0151 is taken by open PR
-- #1247.) Nothing here names an athlete, sport, school or brand.

CREATE TABLE IF NOT EXISTS mila_voice_settings (
  athlete_id            uuid PRIMARY KEY REFERENCES athletes(id) ON DELETE CASCADE,
  voice                 text,
  conversation_language text NOT NULL DEFAULT 'auto',
  post_languages        text[] NOT NULL DEFAULT '{}'::text[],
  updated_at            timestamptz NOT NULL DEFAULT now()
);
