-- 0038 — deal_deliverables. What she OWES, as against what a deal is worth and what it pays.
--
-- Additive only. Hand-written; the executing copy is the idempotent psql block in
-- .github/workflows/deploy.yml (numbered .sql files are intent/review, not the applier —
-- the drizzle journal stops at 0011 and `drizzle-kit migrate` applies none of these).
--
-- ── The third leg ────────────────────────────────────────────────────────────
-- 0030 split a deal into what it is WORTH (deal_periods) and money MOVING
-- (deal_installments). Neither says what she has to MAKE. Nothing did: `deals` has no
-- deliverable column, and `generation_jobs.deliverable` is a format string describing a
-- single render — no quantity, no due date, no deal behind it. So "what do I owe gorjana"
-- had no answer at all, and the Now feed's OWED rows, the calendar's DUE entries and the
-- Made shelf's "Ad 2 of 3" were all blocked on the same missing table.
--
-- `deals.term_end` already draws the line this table depends on: the TERM is when the
-- engagement runs, not when a deliverable is due. A contract with six posts has six of
-- these and one expiry, and only the expiry says whether the deal is still live.
--
-- ── format AND kind ──────────────────────────────────────────────────────────
-- `format` is the contract's own words and is what she is shown: "Reel · 9:16", "1x static
-- IG post". `kind` is our normalized vocabulary, matching generation_jobs.deliverable, and
-- exists so a future auto-match has something stable to join on. Showing the normalized
-- value would put words in the brand's mouth; matching on the free text would not work.
--
-- ── quantity, not N rows ─────────────────────────────────────────────────────
-- "Three posts" is ONE obligation with a count. Three rows would stop `seq` meaning the
-- commitment, and would leave "2 of 3" with no denominator to count against.
--
-- ── superseded_at ────────────────────────────────────────────────────────────
-- 0030's amendment pattern, held to for the same reason. A brand moving "3 posts" to "5"
-- INSERTs and stamps; it never UPDATEs. Rewriting the row destroys what she was measured
-- against, and a delivered count or a score snapshot taken while 3 was true stops being
-- explicable. The unique index is therefore PARTIAL: a superseded row keeps its seq, and
-- uniqueness applies only to live rows.
--
-- ── Not enforced ─────────────────────────────────────────────────────────────
-- No CHECK reconciling deliverables against anything on the deal. The writer will be a
-- model reading a contract PDF, and a misread would become a write failure that loses the
-- whole upload — the same posture 0030 takes on installments summing to their period.
--
-- ── media_assets.deal_deliverable_id ─────────────────────────────────────────
-- NOTHING WRITES IT YET, deliberately, and it is NULL on every row in the table.
-- recordGeneratedAsset() does not set it, nothing publishes Studio output into
-- content_posts, and the Studio client has never held a deal id. `delivered` is DERIVED by
-- counting assets that point here, so it comes out 0 — which is true, not a stub: nothing
-- has been attributed to an obligation yet. A stored counter instead of the join would be
-- `deals.amount` all over again, the denormalized copy that went stale badly enough that
-- dealVoice now opens with "NEVER speak deals.amount".
--
-- The column lands now so the migration does not have to happen underneath a populated
-- table later — the argument 0030 makes for payments.installment_id, which shipped
-- nullable, indexed and unused for exactly this reason. ON DELETE SET NULL, never cascade:
-- editing a deal's schedule must never take her work with it.

CREATE TABLE IF NOT EXISTS deal_deliverables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  campaign      text,
  format        text NOT NULL,
  kind          text NOT NULL DEFAULT 'other',
  quantity      integer NOT NULL DEFAULT 1,
  due_on        date,
  optional      boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'open',
  source_quote  text,
  note          text,
  superseded_at timestamptz,
  created_at    timestamptz DEFAULT now(),
  CONSTRAINT deal_deliverables_kind_check   CHECK (kind IN ('post','story','reel','carousel','ad','clip','appearance','other')),
  CONSTRAINT deal_deliverables_status_check CHECK (status IN ('open','fulfilled','waived','cancelled')),
  CONSTRAINT deal_deliverables_qty_check    CHECK (quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS deal_deliverables_deal_seq_uniq
  ON deal_deliverables (deal_id, seq) WHERE superseded_at IS NULL;

-- ONE composite rather than two: deal_id is the leftmost prefix so it serves the lookup,
-- and due_on serves the ordering the Now feed and the calendar both ask for.
CREATE INDEX IF NOT EXISTS idx_deal_deliverables_deal_due
  ON deal_deliverables (deal_id, due_on) WHERE superseded_at IS NULL;

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS deal_deliverable_id uuid
  REFERENCES deal_deliverables(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_media_assets_deliverable
  ON media_assets (deal_deliverable_id) WHERE deal_deliverable_id IS NOT NULL;

COMMENT ON COLUMN deal_deliverables.seq           IS '1-based ordinal within the contract. The identity of an obligation — never its array index.';
COMMENT ON COLUMN deal_deliverables.format        IS 'The contract''s OWN words, rendered verbatim to the athlete. Never our vocabulary.';
COMMENT ON COLUMN deal_deliverables.kind          IS 'OURS, for matching. Mirrors generation_jobs.deliverable plus the non-content obligations.';
COMMENT ON COLUMN deal_deliverables.quantity      IS 'How many of `format` are owed. The denominator in "2 of 3".';
COMMENT ON COLUMN deal_deliverables.due_on        IS 'POST-BY calendar day, not an instant. Never parse as UTC midnight — it renders as the previous day west of Greenwich.';
COMMENT ON COLUMN deal_deliverables.optional      IS 'Nice-to-have. Never gets a countdown — a deadline nobody is waiting on is manufactured pressure.';
COMMENT ON COLUMN deal_deliverables.superseded_at IS 'Amendments insert new rows and stamp the old. Readers filter on NULL.';
COMMENT ON COLUMN media_assets.deal_deliverable_id IS 'NOTHING WRITES THIS YET — NULL on every row. Populating it is a separate PR; until then `delivered` derives to 0, which is correct. See migrations/0038.';
