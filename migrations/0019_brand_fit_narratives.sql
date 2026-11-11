-- 0019 — durable storage for precomputed brand-fit narratives.
--
-- Additive only. Hand-written for the same reason as 0014/0018: schema.ts has
-- drifted ahead of the migration snapshot, so a generated diff would try to alter
-- live objects. Nothing here alters or drops anything.
--
-- ── HOW THIS REACHES PROD ────────────────────────────────────────────────────
-- Not through this file. _journal.json stops at 0011, so drizzle-kit skips every
-- migration from 0012 on. The executing copy is the idempotent psql block in
-- .github/workflows/deploy.yml, which runs BEFORE the image is replaced and with
-- ON_ERROR_STOP=1 — so a failed DDL aborts the deploy rather than shipping code
-- that would serve against a missing table. This file records intent.
--
-- ── What it replaces ─────────────────────────────────────────────────────────
-- A gitignored JSON file at the repo root. That was deliberate scaffolding — it
-- proved the precomputed call path before anyone paid for a migration — and it
-- cannot work in production: Cloud Run's filesystem is ephemeral and per-instance
-- and the file is not in the image, so every brand brief would be cold forever
-- and every one would spend a Gemini Pro call.
--
-- ── Shape ────────────────────────────────────────────────────────────────────
-- The composite (athlete_id, brand_id) IS the identity — a narrative is written
-- FROM one athlete's sport and audience FOR one brand and is meaningless without
-- both halves — so it is the primary key rather than a surrogate. That also gives
-- the upsert its conflict target for free, and no secondary index is needed
-- because every access is by the full key.
--
-- The three angles are NOT NULL: all three or none. A partial fit rationale read
-- aloud is worse than the honest short answer, and this puts that rule in the
-- schema instead of relying on the writer to hold it.
--
-- Deliberately NO `model` or `stale_at` column. Staleness invalidation and lazy
-- re-fill are a separate change with their own policy; guessing the column shape
-- now would mean either working around it or migrating twice. `updated_at`
-- records when a narrative was produced and is enough to build any policy on.

CREATE TABLE IF NOT EXISTS "brand_fit_narratives" (
  "athlete_id"  uuid    NOT NULL REFERENCES "athletes"("id") ON DELETE CASCADE,
  "brand_id"    integer NOT NULL REFERENCES "inbox_brands"("id") ON DELETE CASCADE,
  "audience"    text    NOT NULL,
  "credibility" text    NOT NULL,
  "whitespace"  text    NOT NULL,
  "created_at"  timestamptz DEFAULT now(),
  "updated_at"  timestamptz DEFAULT now(),
  PRIMARY KEY ("athlete_id", "brand_id")
);
