-- 0090_drop_onboarding_sessions_brand_api_keys.sql — drop two dead v1 tables.
--
-- Applied only because scripts/db-migrate.sh names it in the step-3 list; this file, that line and the
-- shared/schema.ts removal ship in ONE commit.
--
-- ── WHAT THIS REMOVES ─────────────────────────────────────────────────────────────────────────────
-- onboarding_sessions — the v1 onboarding-agent session table ('onboarding' / 'brand_story' agents). v2
--   onboarding runs on the workflow runner and Mila; no code reads or writes this table (the only reference
--   was the account-delete list, now athleteDataManifest.ts, which drops its entry in the same commit).
--   0 rows on dev.
-- brand_api_keys — a "Phase 2" placeholder for brand-side API access that was never built. No code
--   references it. 0 rows on dev.
--
-- Neither table has a foreign key pointing INTO it and no view reads either, so no CASCADE is needed (and none
-- is used). Their own indexes and constraints go with them.
--
-- DESTRUCTIVE in principle, empty in practice. Re-runs as a no-op. No transaction control here
-- (migrationsGuard): dry-run this file ON ITS OWN in BEGIN … ROLLBACK.

DROP TABLE IF EXISTS onboarding_sessions;
DROP TABLE IF EXISTS brand_api_keys;
