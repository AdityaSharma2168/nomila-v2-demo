-- 0146_mila_choices.sql — what each athlete chose for each Mila capability (design "Mila welcome flow" §4 + §12,
-- owner-approved 28 Oct 2026; server/agent/welcome).
--
-- Used only while MILA_WELCOME is on (off in both Cloud Run yamls). With the flag off nothing reads or writes these
-- tables: production gets two empty tables and their indexes on its next deploy, and nothing else.
--   mila_choices          the canonical preference and consent record, one row per (athlete, capability, account)
--                         the athlete has answered; no row = unset. Unique on (athlete_id, capability,
--                         coalesce(account_ref, '')) so an athlete-wide choice (account_ref NULL) is one row too.
--                         account_ref = connected_accounts.id for a per-account capability, so a yes for one mailbox
--                         is never a yes for another. consent = the copy of what the yes covers, at consent_version.
--   mila_choice_history   append-only: every change to a choice, with the row as it became (version-ordered, unique
--                         per (choice, version)), so consent changes are reconstructable.
-- Both are deleted with the athlete (ON DELETE CASCADE; athleteDataManifest lists them). No email content, no tokens.
--
-- Pure DDL, additive only (expand): two new tables and their indexes; nothing renamed, dropped, altered or
-- backfilled, and NO rows are written (no legacy or migrated choices: every optional capability starts unset).
-- Idempotent (IF NOT EXISTS throughout), safe to re-run, which scripts/db-migrate.sh does on every deploy. No
-- transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK. Applied only because
-- scripts/db-migrate.sh names it in the step-3 list; this file, that line and the shared/schema.ts declaration ship in
-- ONE commit or the drift gate reds the deploy. Nothing here names an athlete, sport, school or brand.

CREATE TABLE IF NOT EXISTS mila_choices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      uuid NOT NULL CONSTRAINT mila_choices_athlete_id_athletes_id_fk REFERENCES athletes(id) ON DELETE CASCADE,
  capability      text NOT NULL,
  account_ref     text,
  scope           text NOT NULL,
  state           text NOT NULL,
  via             text NOT NULL,
  consent_version text,
  consent         jsonb,
  not_now_count   smallint DEFAULT 0 NOT NULL,
  cooldown_until  timestamptz,
  version         integer DEFAULT 1 NOT NULL,
  decided_at      timestamptz DEFAULT now() NOT NULL,
  created_at      timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT mila_choices_state_check CHECK (state IN ('enabled','not_now','never','paused','revoked')),
  CONSTRAINT mila_choices_via_check CHECK (via IN ('card','chat','me','settings')),
  CONSTRAINT mila_choices_scope_check CHECK ((scope = 'athlete' AND account_ref IS NULL) OR (scope = 'per_account' AND account_ref IS NOT NULL)),
  CONSTRAINT mila_choices_enabled_consent_check CHECK (state <> 'enabled' OR (consent_version IS NOT NULL AND consent IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mila_choices_key ON mila_choices USING btree (athlete_id, capability, coalesce(account_ref, ''));

CREATE TABLE IF NOT EXISTS mila_choice_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  choice_id       uuid NOT NULL CONSTRAINT mila_choice_history_choice_id_mila_choices_id_fk REFERENCES mila_choices(id) ON DELETE CASCADE,
  athlete_id      uuid NOT NULL CONSTRAINT mila_choice_history_athlete_id_athletes_id_fk REFERENCES athletes(id) ON DELETE CASCADE,
  capability      text NOT NULL,
  account_ref     text,
  version         integer NOT NULL,
  from_state      text,
  to_state        text NOT NULL,
  via             text NOT NULL,
  consent_version text,
  consent         jsonb,
  not_now_count   smallint NOT NULL,
  cooldown_until  timestamptz,
  created_at      timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mila_choice_history_version ON mila_choice_history USING btree (choice_id, version);
CREATE INDEX IF NOT EXISTS idx_mila_choice_history_athlete ON mila_choice_history USING btree (athlete_id, created_at);
