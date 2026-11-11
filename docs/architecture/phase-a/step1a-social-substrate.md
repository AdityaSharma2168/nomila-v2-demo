# Phase A · Step 1a — Social substrate (build record)

**Status:** built on `feat/phase-a-step1a-social-substrate` (PR #388); review changes 1–8 of 10 Sep 2026 applied; awaiting merge approval.
**Spec:** Nomila Product & Intelligence Architecture Blueprint V1 / Commercial Intelligence Beta.1, §28.9 (source classes), §31 (reproducibility).
**Design:** Step 1 social data-layer design, approved 10 Sep 2026 with decisions D1–D8.
**Migration:** `migrations/0044_social_substrate.sql` (pure DDL, `IF NOT EXISTS` throughout).
**Flag:** `SOCIAL_SUBSTRATE_WRITE` — `true` in `gcp/cloud-run-dev.yaml` (shadow write on dev), `false` in prod.

## What the athlete experiences

Nothing changes. The Growth tab, the score, the rate card, the deck and Mila all read the same
rows they read yesterday (`social_analytics_snapshots`, `media_assets`, `athletes_current`).
The display projection of every connected fetch is byte-for-byte what it was (§6).

## What happens underneath

When the flag is on, each nightly connected fetch, each discovery fetch, each media backfill
page and each top-post enrichment ALSO writes beside its existing row:

1. **`social_identities`** — one row per (athlete, platform, account). Owned by `athlete_id`
   (ADR-015); no user or organization column (ADR-016). A disconnect never deletes it (D5).
2. **`social_sync_runs`** — one row per fetch with trigger, status, pages, items. `error` and
   `pagination_state` are normalized shapes (`{reason, message, code?, subCalls?}` and
   `{cursor, pageIndex?}`) that pass the same sanitize → assertNoSecrets gate as payloads, with
   the live secrets; anything still secret-like is withheld, never persisted.
3. **`raw_source_payloads`** — the full sanitized provider envelope, one row per sub-response
   (D3), with `payload_hash`, `bytes`, `sanitizer_version`, `retained_until` (D2: 180 d
   connected, 90 d public; deleted nightly).
4. **`social_metric_observations`** — canonical `(entity, metric, value, source_class,
   source_method, observed_at, window)` rows. Never updated or deleted. Unique on the full key
   including `definition_version` and window bounds (NULLS NOT DISTINCT). `payload_id` is the
   sub-response that actually produced the row (adapters tag every row with its
   `payloadFamily`); a row whose family was not stored keeps `payload_id` NULL and is linked by
   `sync_run_id` — never another family's payload.
5. **`social_audience_distributions`** — demographics by dimension/bucket with `basis`.
6. **`social_features`** — the calculated vector. Two independent classifications on every row:
   `source_class` = lowest AUTHORITY among inputs; `input_access_class` = PRIVACY of the inputs
   (`includes_athlete_private` whenever any input is connected evidence, else `public_only`),
   derived from the complete `inputs.byClass` breakdown. `inputs` carries `observationIds`,
   `byClass`, `byMethod`, and for follower-based ratios and the inferred non-follower rule the
   `denominatorObservationIds` that were divided by.
7. **`media_assets`** gains `social_identity_id`, `native`, `native_version`, `content_format`,
   `first_seen_at`; existing rows are updated, never created (D1).

Nothing reads any of this in production (§8). The engines move onto `social_features` in Step 4.

## 1. Files

| Area | Files |
|---|---|
| Schema | `shared/schema.ts` §18b (six tables, five `media_assets` columns, `input_access_class`); `migrations/0044_social_substrate.sql`; `scripts/db-migrate.sh` lists 0044 |
| Contracts | `server/services/intelligence/social/{metrics,native,sanitize}.ts` |
| Adapters | `.../social/adapters/{types,instagram,tiktok,youtube,discovery,legacy}.ts` — every row names its `payloadFamily`; `legacy.ts` also holds the deterministic identity resolvers |
| Calculation | `.../social/{resolve,features}.ts` (pure; no I/O); `legacyBundle.ts` (existing rows → calculator input, in memory) |
| Writers | `.../social/{ingest,substrate,retention,config}.ts` — `ingest.ts` is the only writer |
| Providers | `server/lib/integrations/{instagram,tiktok,youtube,discovery,types}.ts`: `fetchAnalytics = project(fetchNative)`, old arithmetic unchanged |
| Skills | `collectSocialAnalytics.ts`, `collectDiscoveryAnalytics.ts`, `enrichTopPostInsights.ts`, `mediaBackfill.ts` dual-write after their existing writes, flag-gated, never throwing into the caller |
| Cron | `server/index.ts` nightly: `runSubstrateNightlyPass()` |
| Params | `seedModelParams.ts` adds the `signals v0.1-alpha` DRAFT; `insertDraftParams` now refuses a re-seed of an existing (family, version) with a different config hash or schema version (a version is immutable) |
| Scripts | `server/scripts/backfillSocialSubstrate.ts` (dry-run by default; reports every skipped row), `server/scripts/socialFeatureVector.ts` (RAW → OBSERVATIONS → FEATURES; modes: substrate tables, `--from legacy` real rows in memory, `--synthetic`, `--fixtures <dir>` local only) |
| Tests | `sanitize`, `adapters/adapters`, `features`, `ingest` (PGlite), `syntheticFixture` (seeded synthetic athlete), plus Step 0 `params`, `boundary`, `weightsService` |
| CI | `.github/workflows/ci-checks.yml` runs the intelligence + substrate Jest suites (PGlite) after typecheck and rules-of-hooks, inside the same required `checks` job |
| Fixture | `testUtils/syntheticLegacy.ts` — a seeded generator, structurally the shape of `social_analytics_snapshots.raw_metrics` and `media_assets` rows, with generated ids, handle and numbers. No real athlete data is committed; `__fixtures__/` is git-ignored |
| Config | `gcp/cloud-run-dev.yaml` `SOCIAL_SUBSTRATE_WRITE=true`, `gcp/cloud-run-prod.yaml` `false` |

## 2. Decisions as built

| Decision | Built as |
|---|---|
| D1 durable content | `media_assets` reused; `attachContentNative` updates existing rows only |
| D2 raw retention | 180 d connected / 90 d public, from `signals` params (defaults in code), `retained_until` stamped at write, deleted nightly |
| D3 raw envelope | full sanitized response per sub-response; auth headers, tokens and signed query params never stored; `request` is an allow-listed record |
| D4 Stories | not built (Step 1b) |
| D5 disconnect history | identities and observations never deleted on revoke; a re-connect upgrades the identity in place and appends `handle_history` |
| D6 windows | 30/90 generally; 7/30/90 for cadence and follower growth |
| D7 secret remediation | shipped separately (PR #386) |
| D8 flag | one flag, `SOCIAL_SUBSTRATE_WRITE`; off = the pre-Step-1a path exactly |
| Review 1 authority ≠ access | `input_access_class` on `social_features`, derived from lineage; ADR-016 amended |
| Review 2 sync-run close | normalized error/pagination shapes through sanitize → assertNoSecrets with live secrets; a leak is withheld with a marker |
| Review 3 payload lineage | `payloadFamily` on every adapted row; `payload_id` by exact family or NULL |
| Review 4 legacy identity | resolvers: exact account id → connection linkage (`connected_account_id`) → unique handle match → new identity; media rows only when the platform has one candidate; else reported and skipped |
| Review 5 denominators | follower observations join the lineage, authority, access class and confidence of every follower-based ratio and of `non_follower_reach_share` |
| Review 6 CI | Jest suites in `ci-checks.yml` |
| Review 7 fixture | real fixture removed from git; seeded synthetic generator; Mia stays the dev acceptance run |
| Review 8 params | `(family, version)` immutable |

## 3. Tests (10 Sep 2026, after the review changes)

`npm test -- --runInBand server/services/intelligence server/services/weightsService.test.ts`

| Suite | Tests |
|---|---|
| `social/sanitize.test.ts` | 11 |
| `social/adapters/adapters.test.ts` | 14 (adds: every Instagram, TikTok, YouTube and discovery row names a stored sub-response) |
| `social/features.test.ts` | 16 (adds: public follower count under connected content → `source_class platform_public`, `input_access_class includes_athlete_private`, denominators in lineage, lower confidence; public-only inputs → `public_only`) |
| `social/ingest.test.ts` (PGlite) | 9 (adds: sync-run close persists only the normalized shapes, redacts with the live secret, withholds a leak; `payload_id` by family or NULL; `input_access_class` persisted) |
| `social/syntheticFixture.test.ts` | 7 (determinism, no secrets, deterministic identity resolution incl. the app-scoped-id alias and an ambiguous two-account case, complete lineage, denominators, pinned vector) |
| `params.test.ts` | immutability: same config re-seed is a no-op, different config or schema version is refused |
| `boundary.test.ts`, `weightsService.test.ts` | unchanged |
| **Total** | 8 suites, 93 tests passed; `tsc --noEmit` clean |

## 4. Migration dry run (dev, `BEGIN … ROLLBACK`)

0044 creates 6 tables and 5 columns inside the transaction; none exist after rollback. The
drift gate reports the new schema as missing until the deploy applies 0044 through
`scripts/db-migrate.sh`. Nothing applied by hand. `input_access_class` was added to 0044 itself
because the migration is unreleased.

## 5. Storage today, backfill plan, projection

| | |
|---|---|
| `social_analytics_snapshots` | 218 rows, 2.0 MB raw_metrics (IG connected 24 KB/row/day, TikTok 4 KB) |
| `media_assets` social rows | 561 rows, insights+metadata 1.5 MB |
| Athletes with any snapshot | 9 |

Backfill dry run (all athletes, no writes): 13 identities, 15 808 observations, 7 220
distributions. Resolution report: 141 snapshot rows by exact account id, 63 by connection
linkage, 10 new identities, 2 media groups by sole identity. **Skipped, not guessed:** 12 rows
for one athlete with no connected account — 4 snapshots carrying neither an account id nor a
handle, and 8 media rows with no identity on their platform.

Mia alone: 3 identities (Instagram, TikTok, YouTube), 151 snapshots, 553 media rows, nothing
skipped. Her 63 Instagram snapshot rows that report the app-scoped id `344…` (Instagram Login's
second id for the same account) resolve through their `connected_account_id` to the identity
keyed on `178…`. Without that rule her 461 Instagram media rows were ambiguous and were
refused, which is the behaviour the review asked for.

Projection per connected athlete: raw ≈ 30 KB/day IG + 5 KB/day TikTok → ≈ 6 MB steady state at
180 d; observations ≈ 215/day → ≈ 80 K rows/year; 56–120 feature rows per nightly recompute.

## 6. Byte-for-byte display verification (re-run after the review changes)

Old `fetchAnalytics` (main, separate worktree) vs new projection, Mia's live Instagram and
TikTok, run old → new → old (19:34:40 / 19:34:47 / 19:35:01 UTC, 10 Sep 2026); a leaf that
differs between the two OLD runs is provider drift.

| Platform | Leaves | Differ old→new | Explained by old→old drift | Remaining | Remaining that are signed CDN image URLs | Non-URL diffs |
|---|---|---|---|---|---|---|
| Instagram | 842 | 62 | 62 | 0 | 0 | none |
| TikTok | 251 | 11 | 6 | 5 | 5 | none |

No metric, count, date, handle or insight leaf differs.

## 7. Feature vectors (as_of 2026-09-09T00:00:00Z)

**Synthetic athlete** (`--synthetic`, seed 7, 45 days; what CI pins): 92 payloads → 9 383
observations + 1 305 distributions → 117 features; identities resolve 85 rows by account id, 5
by connection linkage (the app-scoped-id days), 2 by handle match; nothing skipped; every row
`includes_athlete_private` with complete lineage.

**Mia on dev** (`--athlete … --from legacy`; her real rows through the same adapters and
resolvers, nothing written): 151 payloads → 15 591 observations + 7 200 distributions → 56
features, 3 identities, nothing skipped.

| Platform | Feature | Window | Value | n | source_class | input_access_class |
|---|---|---|---|---|---|---|
| instagram | followers_latest | — | 22 114 | 1 | connected_verified | includes_athlete_private |
| instagram | followers_growth_abs / pct | 30 d | −338 / −1.51 % | 2 | connected_verified | includes_athlete_private |
| instagram | content_n | 30 d / 90 d | 1 / 4 | | connected_verified | includes_athlete_private |
| instagram | reach_median / p75 / p90 | 90 d | 14 697 / 22 802 / 29 379 | 4 | connected_verified | includes_athlete_private |
| instagram | engagement_per_follower_median | 90 d | 0.0556 (25 inputs, 1 denominator obs) | 4 | connected_verified | includes_athlete_private |
| instagram | reach_per_follower_median | 90 d | 0.6646 (25 inputs, 1 denominator obs) | 4 | connected_verified | includes_athlete_private |
| instagram | non_follower_reach_share | 90 d | 0 (rule reach ≥ 2× followers; 25 inputs incl. denominator) | 4 | inferred | includes_athlete_private |
| instagram | posts_per_week | 30 d / 90 d | 0.23 / 0.31 | | connected_verified | includes_athlete_private |
| instagram | days_since_last_post | — | 14.9 | 1 | connected_verified | includes_athlete_private |
| instagram | audience_top_country_share / geo_concentration | — | 69 % (US) / 0.484 | 45 | connected_verified | includes_athlete_private |
| instagram | audience_gender_share / age_distribution | — | F 38 · U 35 · M 27 / 7 buckets | | connected_verified | includes_athlete_private |
| tiktok | followers_latest | — | 15 531 | 1 | connected_verified | includes_athlete_private |
| tiktok | days_since_last_post | — | 539.1 | 1 | connected_verified | includes_athlete_private |
| cross | effective_reach_cross_platform / platform_breadth | 30 d | 5 653 / 1 | 1 | connected_verified | includes_athlete_private |

Readings unchanged from the first run: TikTok content windows are empty (her stored TikTok
media ends 539 days before as_of) so cadence and reach features are absent, not zero; the
non-follower rule is an alpha proxy labelled `inferred`; the confidence formula is alpha.

## 8. No production readers

`grep` across `server/`, `client/` and `shared/` for the six table names and their Drizzle
symbols finds only `shared/schema.ts`, `server/services/intelligence/social/*`, the two scripts
and the drift check.

## 9. Not in this step

Stories (Step 1b, own flag, 8-hour cadence); MIA cutover (Step 4); activation of the `signals`
parameter row; the `--apply` backfill on dev after the deploy, then reviewed against this record.
An identity alias column (Instagram's two ids for one account) is not added: the linkage rule
covers the backfill and the live path always keys on the connection's `platform_user_id`.
