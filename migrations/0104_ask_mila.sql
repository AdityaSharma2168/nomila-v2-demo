-- 0104_ask_mila.sql — Ask Mila on the public card, PR 5: public Mila mode's transcripts and limits
-- (design-public-card-v3 §4 "Ask Mila", §15 PR 5). Dark behind ASK_MILA_PUBLIC (+ PUBLIC_CARD), both off in dev and prod.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts declarations ship in ONE commit or the drift gate reds the deploy. Needs 0101 only in spirit (the
-- public card); the tables reference athletes and each other, nothing else.
-- (0101–0103 and 0110–0112 belong to other tracks; these tables touch none of theirs and run in name order.)
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- ask_mila_sessions      one visitor chat on her card: the snapshot version it opened on, the intent (ask | partner |
--                        book | shop), the sha256 of the session token the visitor holds, turns taken (≤ 20), open or
--                        ended (idle after 15 minutes, or the turn limit). No IP, no user agent, no visitor identity.
-- ask_mila_turns         the transcript: what the visitor typed and what the visitor was SHOWN (Mila's answer after
--                        the output gate), the chapter it came from, a structured card, the gate verdict. A blocked
--                        draft is never stored. She reads these under "Chats on your card" and can delete them.
-- ask_mila_visitor_days  turns per visitor per day, keyed by a DAILY-SALTED IP hash (unlinkable across days): 30/day.
-- ask_mila_athlete_days  turns per athlete per day, every visitor together: 400/day.
-- ask_mila_spend_days    the global daily spend of public Mila in micro-dollars (the spend cap). No athlete column.
--
-- Additive: five new tables, nothing existing changes. Every statement re-runs as a no-op (IF NOT EXISTS, or
-- DROP-then-ADD of a named constraint). Names and definitions are written exactly as a shared/schema.ts push produces
-- them. No transaction control here (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

CREATE TABLE IF NOT EXISTS ask_mila_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  athlete_id       uuid NOT NULL,
  snapshot_version integer NOT NULL,
  intent           text DEFAULT 'ask' NOT NULL,
  token_sha256     text NOT NULL,
  turn_count       integer DEFAULT 0 NOT NULL,
  status           text DEFAULT 'open' NOT NULL,
  ended_reason     text,
  started_at       timestamp with time zone DEFAULT now() NOT NULL,
  last_turn_at     timestamp with time zone DEFAULT now() NOT NULL,
  ended_at         timestamp with time zone,
  CONSTRAINT ask_mila_sessions_intent_check CHECK (intent IN ('ask','partner','book','shop')),
  CONSTRAINT ask_mila_sessions_status_check CHECK (status IN ('open','ended')),
  CONSTRAINT ask_mila_sessions_ended_check CHECK ((status = 'ended') = (ended_at IS NOT NULL) AND (ended_reason IS NULL OR ended_reason IN ('idle','turn_limit'))),
  CONSTRAINT ask_mila_sessions_turns_check CHECK (turn_count >= 0)
);

CREATE TABLE IF NOT EXISTS ask_mila_turns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  session_id uuid NOT NULL,
  athlete_id uuid NOT NULL,
  seq        integer NOT NULL,
  role       text NOT NULL,
  text       text NOT NULL,
  chapter    text,
  widget     jsonb,
  gate       text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ask_mila_turns_role_check CHECK (role IN ('visitor','mila')),
  CONSTRAINT ask_mila_turns_text_check CHECK (length(text) BETWEEN 1 AND 2000)
);

CREATE TABLE IF NOT EXISTS ask_mila_visitor_days (
  day          date NOT NULL,
  visitor_hash text NOT NULL,
  turns        integer DEFAULT 0 NOT NULL,
  CONSTRAINT ask_mila_visitor_days_pk PRIMARY KEY (day, visitor_hash)
);

CREATE TABLE IF NOT EXISTS ask_mila_athlete_days (
  athlete_id uuid NOT NULL,
  day        date NOT NULL,
  turns      integer DEFAULT 0 NOT NULL,
  CONSTRAINT ask_mila_athlete_days_pk PRIMARY KEY (athlete_id, day)
);

CREATE TABLE IF NOT EXISTS ask_mila_spend_days (
  day        date PRIMARY KEY NOT NULL,
  turns      integer DEFAULT 0 NOT NULL,
  micro_usd  bigint DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ask_mila_sessions DROP CONSTRAINT IF EXISTS ask_mila_sessions_athlete_id_athletes_id_fk;
ALTER TABLE ask_mila_sessions ADD CONSTRAINT ask_mila_sessions_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE ask_mila_turns DROP CONSTRAINT IF EXISTS ask_mila_turns_session_id_ask_mila_sessions_id_fk;
ALTER TABLE ask_mila_turns ADD CONSTRAINT ask_mila_turns_session_id_ask_mila_sessions_id_fk
  FOREIGN KEY (session_id) REFERENCES public.ask_mila_sessions(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE ask_mila_turns DROP CONSTRAINT IF EXISTS ask_mila_turns_athlete_id_athletes_id_fk;
ALTER TABLE ask_mila_turns ADD CONSTRAINT ask_mila_turns_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE ask_mila_athlete_days DROP CONSTRAINT IF EXISTS ask_mila_athlete_days_athlete_id_athletes_id_fk;
ALTER TABLE ask_mila_athlete_days ADD CONSTRAINT ask_mila_athlete_days_athlete_id_athletes_id_fk
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS idx_ask_mila_sessions_athlete_started ON ask_mila_sessions USING btree (athlete_id, started_at);
CREATE INDEX IF NOT EXISTS idx_ask_mila_sessions_started ON ask_mila_sessions USING btree (started_at);
CREATE UNIQUE INDEX IF NOT EXISTS ask_mila_turns_session_seq_uq ON ask_mila_turns USING btree (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_ask_mila_turns_athlete_created ON ask_mila_turns USING btree (athlete_id, created_at);
