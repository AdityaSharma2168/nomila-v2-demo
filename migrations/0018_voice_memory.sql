-- 0018 — voice memory: tag the channel on chat turns, and hold structured
-- per-conversation voice state.
--
-- Additive only. Hand-written (not `drizzle-kit generate`) for the same reason as
-- 0010/0013/0014: schema.ts has drifted ahead of the migration snapshot, so a
-- generated diff would try to alter existing live objects. Nothing here alters or
-- drops anything that already exists.
--
-- ── HOW THIS ACTUALLY REACHES PROD ───────────────────────────────────────────
-- Not through this file. `migrations/meta/_journal.json` stops at 0011, so every
-- migration from 0012 on is unjournaled and `drizzle-kit migrate` skips it. The
-- executing copy of this DDL is the idempotent psql block in
-- .github/workflows/deploy.yml, exactly as `chat_messages.conversation_id` and the
-- `conversations` table were shipped. This file records intent and review; it is
-- not the delivery mechanism. Do NOT `db:push` it.
--
-- ── chat_messages.source ─────────────────────────────────────────────────────
-- Which channel produced the turn: 'voice' for turns transcribed from a spoken
-- session, NULL for everything that came before and for the text path. Voice and
-- text share one conversation_id so the athlete reads one unified transcript.
--
-- NULLABLE and NO CHECK CONSTRAINT, both deliberate. Nullable leaves every
-- existing row untouched. The missing constraint is the more considered choice:
-- a CHECK would have to be replaced by a DROP + ADD pair the first time a third
-- channel appears, and that pair is precisely what broke the deploy twice (see
-- the concurrency note at the top of deploy.yml — two merges 14s apart raced a
-- DROP against its own ADD). The set of valid values is enforced by the writer
-- instead, which can change without touching live constraints.
--
-- `role` is NOT touched: a voice turn is still 'user' or 'assistant', so
-- chat_role_check keeps its current definition and needs no DROP/ADD.
--
-- ── voice_context ────────────────────────────────────────────────────────────
-- One row per conversation, holding what was DISCUSSED and DECIDED by voice, so a
-- later session can be seeded without replaying transcript prose. That distinction
-- is the whole design: chat_messages contains brand- and email-derived text, and
-- anything seeded into a voice session is read aloud by a TTS layer, so the seed
-- is rebuilt from structure rather than quoted from history.
--
-- A NEW TABLE rather than columns on `conversations` for three reasons: the state
-- is lists, not scalars; `conversations` is already co-written by the summarizer
-- and the saved-chats list, and voice mutating the same row invites contention;
-- and a separate table makes the flag-off story a DROP TABLE that leaves text
-- memory completely untouched.
--
-- The three jsonb columns are read whole, are bounded by one conversation, and are
-- never queried into — so child tables would buy nothing and cost three more
-- objects. THE TRADE-OFF, stated plainly: jsonb is untyped, so the SCHEMA CANNOT
-- ENFORCE what goes in. These columns must contain ONLY ids, closed-vocabulary
-- enums and timestamps — never prose, never a brand-authored string, never a model
-- sentence. That rule lives in the writer (server/voice/**) and its tests, because
-- nothing here can hold the line for it.

ALTER TABLE "chat_messages" ADD COLUMN "source" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "voice_context" (
  "conversation_id"  uuid PRIMARY KEY,
  "athlete_id"       uuid NOT NULL REFERENCES "athletes"("id"),
  -- [{ dealId, brand_id, recommendationGiven, spokenAt }] — ids + enums only.
  "deals_discussed"  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ brandId, hadDeal, spokenAt }] — ids + booleans only.
  "brands_discussed" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ topic, dealId }] — topic is a closed vocabulary, never free text.
  "open_threads"     jsonb NOT NULL DEFAULT '[]'::jsonb,
  "last_voice_at"    timestamptz,
  "created_at"       timestamptz DEFAULT now(),
  "updated_at"       timestamptz DEFAULT now()
);--> statement-breakpoint

-- Backs "has this athlete spoken to Mila recently, and about what" without a
-- conversation id in hand.
CREATE INDEX "idx_voice_context_athlete" ON "voice_context" USING btree ("athlete_id","last_voice_at");
