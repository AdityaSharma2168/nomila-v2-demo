-- 0067_identity_profile.sql — one row per athlete: which of her photographs make up her identity
-- PACK, and what was MEASURED about that pack (Studio PR 17, R-1). 0066 is PR 13's (plan memory).
--
-- A file is only ever applied because scripts/db-migrate.sh names it in the step-3 list — there is
-- no glob — so this file, that line, and the shared/schema.ts declaration ship in ONE commit, or the
-- HARD drift gate (step 5, server/scripts/checkSchemaDrift.ts) reds the deploy that merged half of
-- them. The drift gate compares NAMES only; the type of each column is held by
-- server/studio/identity/identityProfile.migration.test.ts against a schema.ts push.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────
--
-- ONE table and nothing else. No column on any existing table, no backfill, no UPDATE, no DROP.
-- CREATE TABLE IF NOT EXISTS makes every re-run a no-op, because db-migrate.sh applies every listed
-- file on every deploy.
--
--   pack               [{assetId, faceSizeFrac, prominence, faceVisibility}] — asset IDS and the
--                      NUMBERS measured about each (face box size as a fraction of the long edge,
--                      the tagger's prominence) and the tagger's word for the face. ⚠️ NEVER an
--                      embedding, a face template, a crop or a box: computing and KEEPING a face
--                      template is the BIPA/CUBI trigger (qa/identity.ts, "Legal"), and nothing on
--                      this row may be one. Every embedding is made in memory and dropped.
--   band_min/max       her-vs-her cosine distances across the pack, min and max (R-4 i).
--   band_pairs         how many pairs the band was measured over — on the record, so a reader can
--                      weigh it, exactly as SAME_PERSON_BAND.pairs is.
--   band_measured_at   when.
--   control_passed     R-4 ii: true only if EVERY stranger distance landed above band_max; false
--                      when one did not; NULL until the control has run. The band is asserted for
--                      her (qa/identity.ts position()) ONLY when this is true.
--   control_measured_at when.
--   embedder           the instrument the numbers came from ("face-crop/multimodalembedding@001"),
--                      because a later run must know whether it can compare them (R-5).
--
-- ── WHAT DOES NOT CHANGE ────────────────────────────────────────────────────────────────────────
--
-- No existing table is touched. A pre-0067 image never names this table, so it is unaffected by its
-- existence, and the rollback story is "DROP TABLE identity_profiles" — the parity test holds that
-- the drop leaves the catalog exactly as it was.

CREATE TABLE IF NOT EXISTS identity_profiles (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- One row per athlete; her row goes with her.
  athlete_id           uuid NOT NULL,
  -- Ids and numbers only — see the header. Null until she has chosen a pack.
  pack                 jsonb,
  band_min             numeric,
  band_max             numeric,
  band_pairs           integer,
  band_measured_at     timestamptz,
  control_passed       boolean,
  control_measured_at  timestamptz,
  embedder             text,
  created_at           timestamptz DEFAULT now() NOT NULL,
  updated_at           timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT identity_profiles_athlete_id_athletes_id_fk
    FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE,
  CONSTRAINT identity_profiles_athlete_unique UNIQUE (athlete_id)
);
