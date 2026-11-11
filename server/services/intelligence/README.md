# server/services/intelligence

The Commercial Intelligence stack, built module by module against the Nomila Product &
Intelligence Architecture Blueprint V1 / Commercial Intelligence Beta.1 specification. The
spec is the source of truth; this directory is the code that implements it.

## What is here

| File | What it is |
|---|---|
| `types.ts` | The canonical contracts, types only: `SourceClass`, `NormalizedSignal`, `DimensionScore`, `MarketabilityResult`, `SocialMetricObservation`, `RateEstimate`, `EarningsPotential`, the eight `MarketabilityDimension`s, the `DeliverableType` taxonomy, the `ParamFamily` list. (Step 0) |
| `params.ts` | The versioned parameter store over `model_params` (migration 0043): `getActiveParams`, `listParams`, `insertDraftParams`, `activateParams`, `hashConfig`. (Step 0) |
| `boundary.test.ts` | The CI rule: nothing in this directory imports a provider module. |
| `social/` | The social substrate (Step 1a, migration 0044): `metrics.ts` the metric and feature registries; `native.ts` the per-platform envelope shapes; `sanitize.ts` the secret-sanitization contract; `adapters/*` native → canonical rows (Instagram, TikTok, YouTube, discovery, legacy); `resolve.ts` source precedence at the metric level; `features.ts` the pure calculator; `ingest.ts` the only writer of the substrate tables; `substrate.ts` the flag-gated pipeline; `retention.ts` raw TTL deletion; `config.ts` the flag and parameters; `legacyBundle.ts` the in-memory assembly of existing rows through the legacy adapters and the deterministic identity resolvers (`adapters/legacy.ts`); `testUtils/syntheticLegacy.ts` the seeded synthetic athlete CI pins. |

The athlete's score is the M.I.A. (the marketability ledger). The legacy /850 engine (`scoringService` +
`scoring_weights`) and the v3 rate card (`rateService` + `rateModelConfig`) are retired (8 Oct 2026) and
deleted; her own floor (`deal_preferences.minimum_rates`) is the only rate she has. The substrate writes only
when `SOCIAL_SUBSTRATE_WRITE=true`.

## Vocabulary

**Authority is not access.** `source_class` says how trustworthy evidence is. `social_features.input_access_class`
(`public_only` | `includes_athlete_private`) says whether any input was the athlete's private connected
evidence; it is derived from the full lineage and must be read by any future authorizer (ADR-016).

**SourceClass** (authority order, spec §28.9): `connected_verified` > `platform_public` >
`web_researched` > `imputed`. `inferred` is a derived interpretation (a Nomila heuristic or a
bounded AI classification) that must reference the evidence it came from; it is not evidence
provenance and never outranks the evidence behind it. Unknown is never zero: an imputed value
carries `imputed: true` and lower confidence.

**Two versions on every parameter row.** `version` is the parameter set (`v1.0-beta.1`, which
numbers). `schema_version` is the shape of `config` (`marketability-config/1`, how to read it).
They change independently.

**Parameter status.** `draft` is review-only and never returned by the active lookup;
`active` is exactly one per family, enforced by a partial unique index; `inactive` is
superseded and kept so historical runs can be reproduced; `archived` is retired. Rows are
never edited in place. Activation is an explicit act (`activateParams`), never implicit.

**Snapshot lineage.** `athlete_snapshots.as_of` is the instant the evidence set is current at
(NULL reads as `created_at`). `athlete_snapshots.engine_version` names the primary engine
result of the snapshot, e.g. `marketability=v1.0-beta.1`; NULL marks a row written by the retired
v7 engine (its `scoring_weights` table is dropped by the legacy retirement). Multi-engine lineage belongs inside the structured result.

## The boundary (LOCKED)

Scoring consumes canonical, versioned signals and features and must not import
provider-specific types. `boundary.test.ts` fails CI if any file here imports from
`server/lib/integrations/`, the discovery or web resolvers, Trends, GDELT, or a model client.

## Seeding parameters

`server/scripts/seedModelParams.ts` inserts reviewed DRAFT rows by hand. Migrations stay pure
DDL. A draft becomes active only through a reviewed activation (`activateParams`): one active row per
family, swapped in one transaction. A (family, version) is immutable: re-seeding it
with a different config or schema version is refused; change the version instead.
