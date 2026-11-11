-- 0128_notification_type_drop_score_milestone.sql — legacy /850 score + v3 rates retirement, P3-3.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line, the shared/schema.ts
-- check and the legacy/03_additive.sql re-assertion of the same check ship in ONE commit (03_additive re-creates
-- notif_type_check on every deploy, so it must carry the same list or the two would flip-flop).
--
-- MERGE ORDER: after P3-2 (0127), i.e. after P2-4 + P2-5 are merged and deployed.
--
-- ── WHAT THIS CHANGES ─────────────────────────────────────────────────────────────────────────────
-- notification_log.notif_type_check loses 'score_milestone'. Nothing has ever produced that type (no writer in the
-- tree; 0 rows carry it on dev, 8 Oct 2026). If a row did carry it, ADD CONSTRAINT would fail and the deploy would
-- stop — deliberately: that would be a row to look at, not to overwrite.
--
-- Re-runs as a no-op (drop + re-add of the same check). No transaction control here (migrationsGuard): dry-run this
-- file ON ITS OWN in BEGIN … ROLLBACK.

ALTER TABLE notification_log DROP CONSTRAINT IF EXISTS notif_type_check;
ALTER TABLE notification_log ADD CONSTRAINT notif_type_check CHECK (type IN ('new_deal','weekly_brief','brand_match','promotion'));
