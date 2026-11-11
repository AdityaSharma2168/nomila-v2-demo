# Phase A · Step 0 — Foundations

Build record. The design it implements was reviewed and approved on 10 Sep 2026; the target
architecture is the Nomila Product & Intelligence Architecture Blueprint V1 / Commercial
Intelligence Beta.1 specification.

## Purpose and scope

Lay the parameter store, the canonical types and the snapshot lineage columns that every later
Phase A step builds on, with no production behaviour change. Additive only. Nothing in
production reads or writes any of it: the live score still runs on `scoringService` +
`scoring_weights`, the rate card on `rateService` + `rateModelConfig`.

## PR and commit

- PR #383 `feat/phase-a-step0-foundations`, squash-merged to `main` as `8371b26`
  (branch base `246a98c`).
- 11 files, +808 / −6.

## Schema and types introduced

**Migration `0043_intelligence_foundations.sql`** (pure DDL, idempotent, listed in
`scripts/db-migrate.sh` step 3):

- `model_params` — the versioned parameter store: `id`, `family`, `version` (the parameter
  set), `schema_version` (the config shape; kept separate from `version` on purpose), `status`
  (`draft | active | inactive | archived`), `config jsonb`, `hash` (first 12 of sha1 over
  key-order-insensitive JSON), `note`, `created_by`, `created_at`, `activated_at`.
  `UNIQUE (family, version)`; partial unique index `model_params_one_active_uq` on `family`
  where `status = 'active'`; index on `(family, created_at)`. `family` carries no CHECK; the
  closed list lives in code.
- `athlete_snapshots.as_of timestamptz NULL` — the instant the evidence set is current at.
  NULL reads as `created_at`; no backfill.
- `athlete_snapshots.engine_version text NULL` — the primary engine/result of the snapshot,
  e.g. `marketability=v1.0-beta.1`. NULL means the `scoring_weights` row active at the time.
  Multi-engine lineage belongs in the structured result, not in this column.

**`server/services/intelligence/types.ts`** (types only): `PARAM_FAMILIES` / `ParamFamily`,
`ParamStatus`, `SourceClass` = `connected_verified | platform_public | web_researched |
inferred | imputed`, `EvidenceRef`, `MARKETABILITY_DIMENSIONS` (eight), `MarketabilityTier`
(open string), `NormalizedSignal` (with `imputed` flag), `DimensionScore`, `Driver`,
`MarketabilityResult` (`score` 0–850, `composite`, `potential: number | null`, `confidence`,
`dimensions`, `drivers`, `version`, `asOf`), `MetricEntityType`, `SocialMetricObservation`,
`DELIVERABLE_TYPES` / `DeliverableType` (§11 taxonomy plus `licensing` carried from v3),
`RateAddOn`, `RateEstimate`, `OpportunityRange`, `EarningsPotential`.

**`server/services/intelligence/params.ts`**: `getActiveParams(family)` (active rows only),
`listParams(family)`, `insertDraftParams` (idempotent on family + version; a version is
immutable), `activateParams(family, version)` (one transaction; refuses archived and unknown),
`hashConfig`, `canonicalJson`.

**`server/scripts/seedModelParams.ts`**: hand-run only, inserts DRAFT rows for
`marketability v1.0-beta.1` (frozen §7 weights, §9 mapping marked alpha),
`research_freshness v0.1-alpha`, `commercial_proof v0.1-alpha`. Not run by any deploy; never
activates. Not yet applied to any environment.

**`server/services/weightsService.ts`**: the unconditional sort of the dead
`rateEstimation.brackets` block is guarded so a weights row without the block loads.

## Architecture decisions implemented

- Parameter-set version and config-schema version are separate columns (decision 1).
- `SourceClass` has five values; `inferred` is a derived interpretation that must reference
  underlying evidence and is not evidence provenance (decision 2).
- `as_of` and `engine_version` are nullable with no backfill; `engine_version` names the primary
  engine only (decision 3).
- Research freshness TTLs and the commercial-proof source policy exist only as draft parameter
  rows via the seed script, never as migration inserts; the press family uses a 30-day current
  window with ~90-day history; commercial-proof caps are deferred to Step 4 and not represented
  as numbers (decisions 4, 5, 6).
- Provider independence is enforced in CI: `boundary.test.ts` fails if any file under
  `server/services/intelligence/` imports an integration, discovery, web-resolver, Trends,
  GDELT or model-client module (decision 7, LOCKED §19 / §28.10).
- `MarketabilityTier` left open and `potential` nullable; no methodology or display policy
  invented (decision 8).

## Verification and CI

- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `npm test -- --runInBand server/services/intelligence server/services/weightsService.test.ts`:
  3 suites, 14 tests, 0 failures.
- GitHub `checks` on PR #383: pass (1m42s).
- Migration applied twice inside `BEGIN … ROLLBACK` against the dev database: clean; no trace
  after rollback.
- Drift gate (`checkSchemaDrift.ts`) with the branch schema: reported exactly `model_params`
  and the two columns before the migration; `No drift` after.
- Byte-for-byte: `refreshAllScores({ dryRun: true })` over every athlete, run with main's
  schema and then with the branch, produced identical results (5 unchanged, 4 skipped for no
  prior snapshot, 0 failures). `athletes_current` exported before and after was byte-identical.
  `model_params` held 0 rows; no snapshot carried `as_of` or `engine_version`.
- Process note: for this validation only, 0043 was applied to the **dev** database by hand
  (the exact file, via psql) before merge; the deploy's `db-migrate.sh` re-run is a no-op.
  Approved as a one-off; from Step 1 on, the normal migration/deploy path is the verification
  path.

## Non-goals and deferred work

- No writer sets `as_of` or `engine_version` (Step 1 and 2 writers).
- No reader of `model_params`; the v7 engine and `scoring_weights` are untouched.
- No social observation or feature tables (Step 1).
- No commercial-proof caps (Step 4, after cohort normalization).
- `MarketabilityTier` vocabulary, low-confidence display policy and the meaning of
  `potential` are undecided.
- `licensing` has no home in the §11 deliverable taxonomy (Step 5).
- PR #309's `0034_trend_observations.sql` still needs renumbering; untouched here.
