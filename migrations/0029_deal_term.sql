-- 0029 — deals: the contract TERM. term_start, term_end.
--
-- Additive only. Hand-written; the executing copy is the idempotent psql block in
-- .github/workflows/deploy.yml (numbered .sql files are intent/review, not the applier).
--
-- ── What it is for ───────────────────────────────────────────────────────────
-- A deal has a life, and nothing in this schema recorded it. `deals` knew when a deal was
-- detected and what it was worth, but not when the engagement starts or when it ends —
-- so an agreement that ran out in March looked exactly like one running through next
-- season. The only dates we held were the summarizer's flat `deadlines[]`, which are
-- DELIVERABLE dates ("post by the 14th") scraped from conversation. A deliverable date is
-- not a term: a contract with six posts has six of them and one expiry, and the expiry is
-- the one that decides whether the relationship is still live.
--
-- This is the field the athlete needs first when she uploads a contract herself, because
-- the term is written plainly in it — "the Term shall commence on 1 March 2026 and
-- continue for twelve (12) months" — and it is the single fact the inbox can almost never
-- infer. Email negotiates price; the paper carries the dates.
--
-- ── Why `date` and not `timestamptz` ─────────────────────────────────────────
-- A contract term is a calendar date, not an instant. "Through 31 December 2026" is true
-- in every timezone; storing it as a timestamp forces a moment onto it, and midnight UTC
-- renders as 30 December for an athlete on the US west coast — the term appearing to end
-- a day early, in her own timezone, on her own contract. social_analytics_snapshots
-- already splits `snapshot_date` (timestamptz, a capture instant) from `snapshot_day`
-- (date, a calendar day) for exactly this reason. A term is only ever the second kind.
--
-- ── Nullable, and mostly null ────────────────────────────────────────────────
-- Most rows in this table are inbound email that never became an agreement, and they have
-- no term because there is nothing to have one. Null means "no term recorded", never
-- "perpetual" and never "expired" — no consumer may read absence as either.
--
-- ── Not enforced ─────────────────────────────────────────────────────────────
-- No CHECK that term_end >= term_start. The two arrive from an extractor reading a PDF,
-- and a misread date should degrade to a wrong date the athlete can correct, not to a
-- write failure that loses the whole upload. Same posture as 0026's absent amount check:
-- the invariant belongs to the writer, not the database.
--
-- ── Deliberately NOT here ────────────────────────────────────────────────────
-- No `expired` status, and no job that sets one. A passed term_end is a fact to READ, not
-- a state to write: deals.status is a forward-only machine advanced by the summarizer and
-- by the athlete, and having a cron push rows into a terminal state behind her would put
-- a second writer on that column. Surfaces can compare term_end to today themselves.
-- Auto-archive is already safe here — archiveStaleDeals skips negotiating/accepted/
-- completed outright, so a signed twelve-month deal is never archived for being quiet.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS term_start date;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS term_end   date;

COMMENT ON COLUMN deals.term_start IS 'Calendar date the engagement begins, per the contract. NULL = not recorded.';
COMMENT ON COLUMN deals.term_end   IS 'Calendar date the engagement ends/expires, per the contract. NULL = not recorded, NOT perpetual.';
