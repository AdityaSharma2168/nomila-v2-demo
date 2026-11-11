# Phase A · Step 1b — Instagram Stories (build record)

**Status:** implemented against the approved design (`step1b-stories-design.md`); awaiting code review. Both Story flags OFF at merge. No live acceptance yet (§4 is filled after the dev flag flip and one Story life).
**Design:** `docs/architecture/phase-a/step1b-stories-design.md` (approved 10 Sep 2026, decisions O1–O9, R1–R3).
**Migration:** `migrations/0045_social_sync_runs_trigger_stories.sql` — widens `social_sync_runs_trigger_check` with `stories`. 0044 untouched. Applied only by the deploy.
**Flags:** `SOCIAL_STORIES_WRITE` `"false"` in `gcp/cloud-run-dev.yaml` and `gcp/cloud-run-prod.yaml`.

## What the athlete experiences

Nothing. Nothing reads Story data: no MIA, Rate, Strategy, UI or production reader.

## What happens underneath (when the flag is on)

Every 8 hours (`20 */8 * * *`) the sweep lists each connected, active Instagram account's live
Stories and reads each one's insights; every hour (`40 * * * *`) the last-look tick re-reads
Stories aged 22–24 h that have no successful insight reading since 22 h. Rows land only in the
Step 1a substrate: identity → sync run (`trigger = stories`) → sanitized raw payload per
sub-response → canonical observations (`entity_type content`, `entity_format story`,
`asset_id NULL`). Never a `media_assets` row.

## 1. Files

| Area | Files |
|---|---|
| Migration | `migrations/0045_social_sync_runs_trigger_stories.sql`; `scripts/db-migrate.sh` (0031–0045); `shared/schema.ts` CHECK mirrored |
| Provider | `server/lib/integrations/instagram.ts` + `fetchInstagramStoriesNative`, `fetchStoryInsightsNative` → `instagramStoryInsights.ts` `readStoryInsights` (pure, injected call): core metrics always; conditional `link_clicks`, `reposts`, `facebook_views` cached as unsupported ONLY when rejected by name or by an individual probe, never by an unnamed rejection; probes are capability checks only (their responses never become the Story's raw payload or observations); a failed `/stories` call writes no `listed` row and no synthetic `{data: []}`, only the provider's actual error envelope under `stories_list_error`; a core error 10 (media-level per Meta) stops the read without spending the navigation / profile-activity calls; `server/lib/integrations/metaErrors.ts` `classifyMetaError` (by Meta error code) |
| Substrate | `server/services/intelligence/social/stories.ts` (`ingestStorySweep`, `ingestStoryLastLook`, `selectStoriesDueForLastLook`, one anti-join query with `NOT EXISTS`), re-exported from `substrate.ts`; `storiesSchedule.ts` (pure rule + §5 model); `native.ts` Story types + `igBreakdown`; `metrics.ts` Story keys; `adapters/instagram.ts` `adaptStories`, `adaptStoryInsights`; `config.ts` `storiesWriteEnabled`, `stories` params |
| Skill / cron | `server/skills/collectInstagramStories.ts` (`runStorySweep`, `runStoryLastLookTick`); `server/index.ts` two in-process crons and `POST /api/internal/stories-sweep`, `/stories-last-look` (cron secret) |
| Scripts | `socialFeatureVector.ts --stories` ledger; `seedModelParams.ts` signals draft gains `stories` |
| Tests | `stories.schedule.test.ts`, `metaErrors.test.ts`, `instagramStoryInsights.test.ts` (CI paths added), Story cases in `adapters.test.ts`, `ingest.test.ts`, `sanitize.test.ts` |

## 2. Gates, as built

| Gate | Where |
|---|---|
| 0045 only via the normal path; 0044 untouched | migration file + `db-migrate.sh`; dry-run BEGIN … ROLLBACK on dev before the PR |
| Both Story flags OFF at merge | both YAMLs `"false"`; `storiesWriteEnabled()` returns false → sweeps, ticks and endpoints write nothing and call nothing |
| No readers | grep: the six substrate tables and the Story modules are read only by the substrate, the scripts and the drift check |
| No Story rows in `media_assets` | `adaptStories` returns `content: []`; `ingestStorySweep` never calls `attachContentNative`; test asserts zero rows |
| `entity_format = story` | adapters; `CONTENT_FORMATS` unchanged |
| `listed` never satisfies the last look | `STORY_SUCCESS_METRICS = [reach, view_count]` in `selectStoriesDueForLastLook` and `lastLookDue`; tests |
| Only Meta 190/102 expires a connection | `classifyMetaError` → `auth` only for 190/102; `collectInstagramStories.ts` expires only on `authFailure`; nightly regex not reused; tests incl. a bare 403 |
| Tests in required CI | `ci-checks.yml` `checks` job |
| Prod OFF | `gcp/cloud-run-prod.yaml` |

## 3. Tests and pre-review evidence

`npm test -- --runInBand server/services/intelligence server/services/weightsService.test.ts server/lib/integrations/metaErrors.test.ts`
→ 10 suites, 119 tests passed; `tsc --noEmit` clean. 0045 dry run on dev (BEGIN … ROLLBACK): the
constraint gains `stories` inside the transaction and is unchanged after rollback. The §5 tail
table is reproduced by `tailShare` in `stories.schedule.test.ts`. The provider file diff is an
import line plus appended Story functions; `fetchAnalytics` and the projection are untouched.

## 4. Live acceptance on dev (after the dev flag flip; one Story life)

_To be appended: listing dry run, stored rows per family, sweep and last-look runs with ages,
the Story ledger, unchanged display/score/rates/MIA outputs, call count against the rate-limit
headers._
