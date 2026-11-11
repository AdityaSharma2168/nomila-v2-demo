-- 0024 — brand images: capture real homepage images (og:image + product shots) per brand.
--
-- Additive only. Hand-written for the same reason as 0018/0023: `migrations/meta/_journal.json`
-- stops at 0011, so everything from 0012 on is unjournaled and `drizzle-kit migrate` skips it.
-- The executing copy of this DDL is the idempotent psql block in .github/workflows/deploy.yml.
-- This file records intent and review; it is not the delivery mechanism. Do NOT `db:push` it.
--
-- ── What it is for ───────────────────────────────────────────────────────────
-- inbox_brands.logo_url is a square Clearbit logo — fine for a favicon, thin for a brand card.
--   * image_url — the CHOSEN cover: a real homepage image (Open Graph og:image or a real
--     product/lifestyle <img>), picked best-first by a Gemini vision rank.
--   * images    — the ranked SET (best-first, source URLs) behind the deal-detail brand-deck
--     hero, so a detail screen can swipe several representative shots.
-- Both are captured best-effort during brand enrichment
-- (server/skills/researchBrand.ts via server/lib/brandImage.ts).
--
-- Like logo_url, this stores SOURCE URLs, not the binary. Rehosting the bytes in GCS is the
-- durable upgrade (a third-party URL can rot or hotlink-block); the columns are unchanged by it.
--
-- ── Safe on the live table ───────────────────────────────────────────────────
-- ADD COLUMN with no default is a catalogue-only change on PG 11+ — no table rewrite, existing
-- rows read NULL until backfilled (server/scripts/backfillBrandImages.ts).

ALTER TABLE "inbox_brands" ADD COLUMN IF NOT EXISTS "image_url" text;
ALTER TABLE "inbox_brands" ADD COLUMN IF NOT EXISTS "images" jsonb;
