-- 0094_deals_signed_at.sql — "Signed" as her confirmed fact, and two new receipt verbs.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts change ship in ONE commit. Design: docs/design/brand-page-deals.md (D1, D2, D7).
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────
-- deals.signed_at     when SHE confirmed the deal is signed. NULL = not confirmed (never "unsigned").
-- deals.signed_source how: 'confirmed' (her "Yes, it's signed") or 'contract' (she saved a contract she
--                     marked signed). Set ONLY by those two taps; no model path writes either column.
--                     NULL exactly when signed_at is NULL.
-- agent_actions       two more verbs: 'confirm_signed' (her Yes: signed + opportunity closed as won) and
--                     'split_deal' ("This is a separate deal"). Both reversible receipts.
--
-- Deliberately NOT a new deals.status value: the status vocabulary stays as it is (owner, 7 Oct 2026).
--
-- Additive: two nullable columns, a CHECK every existing row passes (both NULL), and a CHECK swap that only
-- WIDENS the allowed verbs. Re-runs as a no-op. No transaction control here (migrationsGuard): dry-run this
-- file ON ITS OWN in BEGIN … ROLLBACK.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS signed_at timestamptz;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS signed_source text;

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_signed_check;
ALTER TABLE deals ADD CONSTRAINT deals_signed_check
  CHECK ((signed_at IS NULL AND signed_source IS NULL) OR (signed_at IS NOT NULL AND signed_source IS NOT NULL AND signed_source IN ('confirmed','contract')));

ALTER TABLE agent_actions DROP CONSTRAINT IF EXISTS agent_actions_action_check;
ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_action_check
  CHECK (action IN ('file','auto_decline','reclassify','mute_sender','reopen','auto_archive','profile_write','confirm_signed','split_deal'));
