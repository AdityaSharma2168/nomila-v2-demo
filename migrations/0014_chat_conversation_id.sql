-- 0014 — conversation memory (Phase 1): group chat_messages into conversations.
--
-- Additive only. Hand-written (not `drizzle-kit generate`) on purpose, same reason
-- as 0010/0013: schema.ts has drifted ahead of the migration snapshot, so a
-- generated diff would try to alter existing live objects. This adds ONLY the new
-- nullable column + its index, so it applies cleanly against the current DB.
--
-- conversation_id groups a continuing Ask Mila conversation. NULLABLE: existing
-- rows and the v1/flag-off chat path leave it NULL, untouched. The index backs
-- loadHistory's per-conversation load (athlete_id, conversation_id, created_at).

ALTER TABLE "chat_messages" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_chat_conversation" ON "chat_messages" USING btree ("athlete_id","conversation_id","created_at");
