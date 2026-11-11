-- 0025 — cross-thread deal grouping: deals.deal_group_id.
--
-- Additive only. Hand-written; the executing copy is the idempotent psql block in
-- .github/workflows/deploy.yml (numbered .sql files are intent/review, not the applier).
--
-- ── What it is for ───────────────────────────────────────────────────────────
-- One conversation = one thread = one deal (upsertDealForThread). But the SAME underlying
-- deal can arrive as several separate email threads — e.g. gorjana's contract-signature
-- request, the executed-agreement notification, and a gifting note are 3-4 distinct Gmail
-- threads, hence today 3-4 separate deal rows. deal_group_id lets those rows share one group
-- so the Opportunities list shows a single brand card and the linked terms/one-liner fill in.
--
-- NULL = ungrouped (the deal is its own group). Grouping is assigned deliberately by
-- server/scripts/groupDeals.ts (dry-run first) and rolled up read-side in loadRankedDeals —
-- there is no auto-merge in the live deal-minting path yet.
--
-- ── Safe on the live table ───────────────────────────────────────────────────
-- ADD COLUMN with no default is catalogue-only on PG 11+ — no rewrite, existing rows read NULL.

ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "deal_group_id" uuid;
CREATE INDEX IF NOT EXISTS "idx_deals_group" ON "deals" ("deal_group_id");
