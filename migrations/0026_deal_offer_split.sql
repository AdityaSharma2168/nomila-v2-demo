-- 0026 — deals: the offer split. amount_cash, amount_product, commission_pct.
--
-- Additive only. Hand-written; the executing copy is the idempotent psql block in
-- .github/workflows/deploy.yml (numbered .sql files are intent/review, not the applier).
--
-- ── What it is for ───────────────────────────────────────────────────────────
-- deals.amount now carries the deal's TOTAL guaranteed value — cash plus stated product —
-- because every consumer of that column (Mila's getDeal/listDeals, chat, search, askTerms)
-- is answering "how big is this deal", and $7,500 was the wrong answer for a $14,000
-- agreement.
--
-- But a total alone loses the distinction that matters most, and the loss is not
-- hypothetical. A Korean pain clinic offered "complimentary examinations and personalized
-- treatments (worth approximately USD 2,000)" in exchange for a visit the athlete would
-- have to fly to Korea to make. Stored as a total, that reads as a $2,000 deal in every
-- surface that shows a number — indistinguishable from $2,000 in cash. It is not: the
-- value is contingent on travel she may never make, non-transferable, consumed rather
-- than kept, and priced by the clinic itself.
--
-- With the split, nothing has to conflate them. Mila can say "$2,000 in treatments, no
-- cash"; search and ranking can use amount_cash where hard money is what matters; the
-- total stays available for the cases where product genuinely is compensation, such as
-- gorjana's $6,500 jewellery credit alongside $7,500 cash.
--
-- ── Why these three and not a JSON blob ──────────────────────────────────────
-- They mirror the summarizer's offer_struct exactly (amount, product_value,
-- commission_pct), which is the single source of truth. All four columns are written in
-- the same statement from that one object, so there is no second extractor and no
-- derivation that can drift. commission_pct earns a column of its own because it is the
-- one component that matters at PAYMENT time, when actual sales are known — it is
-- deliberately excluded from amount, since scoring a percentage of sales that have not
-- happened would be inventing a number.
--
-- ── Not enforced ─────────────────────────────────────────────────────────────
-- No CHECK that amount = amount_cash + amount_product. Legacy rows predate the split and
-- would fail it, and a constraint here would turn a summarizer gap into a write failure
-- on ingest. The invariant is held by the single writer, not by the database.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS amount_cash    numeric;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS amount_product numeric;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS commission_pct numeric;

COMMENT ON COLUMN deals.amount         IS 'TOTAL guaranteed value: amount_cash + amount_product. Excludes commission.';
COMMENT ON COLUMN deals.amount_cash    IS 'Guaranteed cash only.';
COMMENT ON COLUMN deals.amount_product IS 'Value the brand STATED for a product/gifting/service component. A ceiling, not an assessment.';
COMMENT ON COLUMN deals.commission_pct IS 'Percentage of sales, if offered. Contingent — never counted in amount; matters at payment.';
