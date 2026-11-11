# PR 11 — Join row + verdict display — ledger

Worktree `join-row`, branch `studio/join-row` off origin/main **036cc1c6** (PR #577 merged). AUDIT2.md was pinned
at c8242e07; `git diff --stat c8242e07..HEAD` is 15 files, all objectives (PR3b-2, migration 0065) plus a
one-assertion change in `previews.migration.test.ts` and two objectives-only lines in `shared/schema.ts` at
:2794+ — **no cited line in this block moved.** Every cite below was re-read at the tip. Artifacts (none yet)
go under gitignored `probe-out/join-row/`. Phase R: read-only, $0, no jest, no server, no DB.

## Phase R — claims

| # | Claim (block) | Verdict | At the tip |
|---|---|---|---|
| C1a | costLog.ts:41-73 is the line shape; qualityTag always null :70 | **CONFIRMED** | `GenerationRecord` costLog.ts:39-71; `qualityTag: null` written unconditionally :119 (declared :70). No job/preview/batch/prompt/asset id on the line. |
| C1b | router.ts:145-171 is the recordGeneration call | **CONFIRMED** | router.ts:144-172, gated by `opts.noLog` :144; the router sees only `(task, inputs, opts)` — **no id of any kind is in scope inside it**; `opts.refIds` (types.ts:285) is the only caller-supplied identity today. Only caller of `recordGeneration` in the repo is router.ts:145. |
| C1c | callers: engine.ts:79, :565-573, and the generate/video paths | **PARTIAL** | Import engine.ts:79 ✓; call engine.ts:566-573 ✓ (`image.edit`). Every other product caller of router `generate()`: segment.ts:554 (`image.segment`), preview.ts:1640 (`runGeneration`, image + inline video) whose callers are generate.ts:837 (masked crops), generate.ts:1309 (native / whole-frame) and concept.ts:228. Scripts: studioGenerate, studioModelNativeProbe, studioKlingModeration, studioKlingFirstLast, studioVideoBakeoff. **The queued video path never enters the door**: videoRunner.ts:238 `resolve()` → `adapter.video.submit/poll` (:373), so every product video clip is unlogged in the JSONL. Not in the block; reported, not fixed here (component map excludes videoRunner). |
| C2a | recommend.ts:233-251 off-router; usage only :275-278 | **CONFIRMED** | `genai().models.generateContent` edit/recommend.ts:233-250; returns `usage{inputTokens,outputTokens,ms}` :275-279; error branch :302-307 also returns usage with nulls. Entered via `recommendMemoized` (routes.ts:37) → `recommendEdits` :211. |
| C2b | detection at quote time is off-router | **CONFIRMED** | autoMask.ts:661 `genai().models.generateContent` inside `detectRegions` :649; memo in front `detectRegionsMemoized` :782-799 (a HIT spends nothing). Callers: edit/engine.ts:202 (`quoteEdit` → `measuredSource`) and routes/studio.ts:666 (preview route), plus three scripts. engine.ts:40 is the import. |
| C2c | qa/cost.ts:17-21 documents QA off-router | **CONFIRMED** | qa/cost.ts:17-22. The actual call is qa/vision.ts:200 (`askVision`), metered by `SpendMeter` cost.ts:65-96; embeddings are a raw `fetch` to Vertex `:predict` qa/embed.ts:48,:85, priced flat :43. |
| C2d | any other `genai(` outside router.ts | **CONFIRMED, longer than the block assumes** | agent/plan.ts:817, interpret/transport.ts:97, enrich/videoTag.ts:337, direction/transport.ts:87, reference/transport.ts:75, lib/visionTag.ts:149 (PR 12's), and qa/embed.ts:85 (fetch, not genai). R-2 names three sites; **six others stay unlogged after this PR** → P-door as written cannot pass; see predictions. |
| C3a | studio_edit_previews keys schema.ts:2221-2249 | **CONFIRMED** | table :2222-2250: `batch_id` :2232 ("null for a single edit"), `preview_id` :2234, `job_id` :2236, `cost_quoted_usd` :2244, `cost_usd` :2245, `accepted_asset_id` :2247, `params` :2229. |
| C3b | generation_jobs brief/model/provider/cost_estimated_usd/cost_basis jobs.ts:71-88 | **CONFIRMED** | insert jobs.ts:71-88; columns schema.ts:1675-1710. |
| C3c | media_assets.generation_job_id :1520, derived_from_asset_id :1465 | **CONFIRMED** | :1520 and :1465-1466; both written by `recordGeneratedAsset` jobs.ts:226-… (`generation_job_id: input.jobId`, `derived_from_asset_id`). |
| C3d | promptVersion interpret.ts:173-174; studio_reference_analyses.prompt_version :2150 | **CONFIRMED** | interpret.ts:173 `promptVersion: PROMPT_VERSION` (= `"interpret/6"`, interpret/prompt.ts:68); schema.ts:2150. Four other prompt versions exist (summarize/2, research_moment/1, reference/1, propose_campaign/1). |
| C3e | which ids are in scope per call site when recordGeneration runs | **new fact** | Inside the router: none. At the callers: **engine.ts:566** has `row.id` (editPreviewId), `row.batch_id`, `row.preview_id`, `job.id`; **no assetId** (the media_assets row is created on accept, engine.ts:718-728) and **no promptVersion** (edit briefs are assembled at engine.ts:312 with no `interpretation` — brief.ts:431 is optional and nothing in `edit/` sets it). **preview.ts:1640** has neither a job nor a preview id in `runGeneration`'s signature; its callers do: generate.ts:1309 `job.id` (+ `brief.job.interpretation?.promptVersion` on interpreter jobs), generate.ts:837 `ctx.jobId`, concept.ts:228 `job.id`. **segment.ts:554**: per-crop mask probe; job id reach to be confirmed at B. So R-1's ids travel caller → router via a new optional `ProviderOpts` field; nulls where absent. |
| C4 | actual cost on the job: column? finish()? | **CONFIRMED (F15)** | `generation_jobs` has `cost_estimated_usd` + `cost_basis` only (schema.ts:1675-1710) — **no actual-cost column**. `finish()` jobs.ts:162-170 writes status / last_error / completed_at / updated_at only. `spentTodayUsd` sums estimates :131-147. Actual cost lands only on the EDIT row (`cost_usd`, engine.ts:594) and on the JSONL — which jobs.ts:138-140 itself calls "per-instance and ephemeral on Cloud Run". Writing actual cost to the job is DDL → Adi's call; this PR does not. |
| C5a | readVerdict's one caller is studioSweep2.ts:386 | **CONFIRMED** | record.ts:121-136; sole importer scripts/studioSweep2.ts:386. (`readVerdict` in mila/tools/getDeal.ts:40 and listDeals.ts:89 are unrelated local helpers on a deal score — not creative_qa.) |
| C5b | written record.ts:45,88-91 from inspect.ts:196,264 / inspectClip.ts:181 | **CONFIRMED** | `QA_METADATA_KEY` :45; update :87-95; `writeVerdict` calls inspect.ts:196 (generate branch), :264 (edit-chain branch), inspectClip.ts:180-181. |
| C5c | client reads none of it | **CONFIRMED** | `grep creative_qa client` → 0. |
| C5d | *(not in block)* who runs QA in product | **new fact — blocks half the UI check** | `inspectAsset` is called from exactly one product site, generate.ts:1426 (the Create-anything / native generate path), and `inspectClipAsset` from videoRunner.ts:475. **The PR-9 typed-edit path (edit/engine.ts `executeEdit`/`acceptEdit`, edit/batch.ts) never inspects.** No PR-9 edit asset has, or can have, a `creative_qa` verdict at the tip, flag on or off. Cost for an edit exists (`cost_usd`); a verdict does not. |
| C6 | card site: Made shelf; presentEdit engine.ts:786-822 has no label (F19) | **CONFIRMED, line moved** | `presentEdit` is engine.ts:797-822 at the tip (+11); still no label field; it does return `costUsd` :814 and `acceptedAssetId` :816. Render sites: **MadeShelf** client/screens/studio/MadeShelf.tsx (tile :240-256, state tag :255) fed by `useMadeShelf` (use-studio-pending.ts:66 `MadeItem` — no cost, no verdict, no job id) from `GET /studio/content` (routes/studio.ts:1706 → studio/content.ts:112); tap → `AssetViewer` (:36, bar props AssetViewer.tsx:70-87) or `MediaDetailScreen` (shared screen, reads `/api/v1/me/media/:id` — **out of lane**). For a generate, `GenerationResult.tsx` (:72-121) is the post-run card. For a PR-9 edit pre-accept, `EditSheet.tsx` preview step :259-280 (shows the picture, not the cost). |

## Predictions (pre-registered, falsifiable)

- **P-ids** (as written: "every id in R-1 non-null on a PR-9 edit run's cost line") — **will MISS by construction**, and the miss is pre-registered: on a PR-9 *single* edit the line has `jobId`, `previewId`, `editPreviewId` non-null; `batchId` **null** (single edit, schema.ts:2232; non-null only on an ad-carousel batch run); `promptVersion` **null** (C3e); `assetId` **null** (asset row is born on accept, after the line is written). Falsifier: any of the first three null, or `batchId` non-null on a single edit.
- **P-join** — the script prints one row for an existing accepted PR-9 asset from dev with zero writes: job ✓, asset ✓, edit row ✓, **verdict: none** (C5d), **cost lines: []** for any historic asset (lines written before this PR carry no ids and cannot join; the JSONL is per-machine). Falsifier: a pre-PR line joins, or the script writes.
- **P-door** (as written: "0 unlogged callers outside router.ts and visionTag.ts") — **will MISS**: exactly six stay (C2d). Narrowed, falsifiable form: after R-2, `recommendEdits`, `detectRegions` (miss path only) and `inspectAsset`/`inspectClipAsset` each write one line through `recordGeneration` with a task name; a memo HIT writes none. Falsifier: any of the three spends with no line, or a hit writes one.
- **P-display** — with `EXPO_PUBLIC_STUDIO_QA_DISPLAY=true` and a fixture verdict `overall: "flag"`, the chip renders flag-or-pass wording only; no rendered string matches a number followed by a threshold word or comparator; `identityObservation` is captioned as an observation. Off, the chip renders nothing and the route answers 404.
- **P-video** (new) — queued video jobs write **zero** cost lines today (C1c). Falsifier: a `video.generate` line from a product run. Reported, not fixed here.

## Mutations (Phase M, red-by-name) and where each lives

| Mutation | Test file |
|---|---|
| a cost line without a job id | server/studio/costLog.test.ts (line shape: every R-1 key present, null when absent) + the "router instrumentation" describe (ids passed via opts reach the line) |
| recommend spend unlogged | server/studio/edit/recommend.test.ts (mock `../../lib/models` genai + `../costLog`) |
| detection spend unlogged | server/studio/autoMask.test.ts (miss → one line; memo hit → none) |
| QA spend unlogged | server/studio/qa/inspect.test.ts (+ inspectClip's suite): one line, cost = `verdict.spend.usd`, basis estimated, assetId + jobId set |
| verdict shown as a score with a threshold | client/components/studio/QaChip.test.tsx (react-native jest project) |
| identity observation shown as pass/fail | client/components/studio/QaChip.test.tsx |
| verdict chip renders with STUDIO_QA_DISPLAY off | client/components/studio/QaChip.test.tsx (client flag) **and** server/studio/qa/routes.test.ts (server flag → 404) |
| join query invents a row when the job has no asset | server/studio/qa/join.test.ts (PGlite) |

Note on task names: `GenerationTask` (types.ts:26-30) is the router's closed union and qa/cost.ts:11-15 argues
against widening it. The cost line's `task` becomes a wider `LoggedTask` owned by costLog.ts
(`GenerationTask | "edit.recommend" | "image.detect" | "image.inspect" | "clip.inspect"`); `aggregate`/`formatReport`
already key on the string.

## Component map (every file Phase B would touch)

**Lane 1 — server**
- server/studio/costLog.ts, costLog.test.ts — R-1 fields, `LoggedTask`
- server/studio/types.ts — `ProviderOpts.attribution?` (the ids' carrier; ⚠️ shared studio file)
- server/studio/router.ts (+ router.test.ts if needed) — pass attribution through to the line
- server/studio/edit/engine.ts, engine.test.ts — engine.ts:566 passes row/job ids
- server/studio/preview.ts, generate.ts, concept.ts, segment.ts — `runGeneration`/segment carry job + preview + promptVersion (⚠️ hot files; clip-reads may be near generate.ts)
- server/studio/autoMask.ts, autoMask.test.ts — detection through the door (miss path)
- server/studio/edit/recommend.ts, recommend.test.ts — recommend through the door
- server/studio/qa/inspect.ts, inspectClip.ts, inspect.test.ts (+ inspectClip test) — QA spend through the door
- server/studio/qa/join.ts, join.test.ts (new) — R-3 query; server/scripts/studioJoinRow.ts (new) — prints it
- server/studio/qa/routes.ts, routes.test.ts (new) — `GET /studio/assets/:assetId/qa` via `readVerdict`, behind `STUDIO_QA_DISPLAY` (404 off); server/routes/studio.ts — one mount line beside `registerEditRoutes` :3255
- server/studio/config.ts — `qaDisplayEnabled()` documented beside `imageEditOpsEnabled` :1673 (⚠️ hot file, one block)
- **Not touched:** videoRunner.ts (video door gap → card), lib/visionTag.ts (PR 12), the six other genai callers, any schema/DDL, reroll.ts

**Lane 2 — client**
- client/lib/flags.ts — `STUDIO_QA_DISPLAY` beside `STUDIO_IMAGE_EDIT` :113
- client/hooks/use-studio-qa.ts (new), client/components/studio/QaChip.tsx + QaChip.test.tsx (new)
- client/screens/studio/MadeShelf.tsx (tile), client/components/studio/AssetViewer.tsx (bar), client/components/studio/EditSheet.tsx (preview step: cost line; verdict absent per C5d)
- **Not touched:** MediaDetailScreen / routes/media.ts (shared, out of lane)

Where the gates are documented: server/studio/config.ts doc comments + client/lib/flags.ts. `.env.development`
is **not on origin/main** (3a5ced1f is local); nothing to add there from this branch.

## Spend

- Phase R: $0.
- Phase B / M: $0 (jest, mocked models, PGlite).
- Live cells, each needing Adi's go per run:
  - P-ids: one PR-9 edit run = `0.00006 × tokensPerImage()` (config.ts:640-644, :500-507; default 1120 tokens) ≈ the quote the sheet shows, plus reference-image input tokens. Historic lines: ~$0.13 per edit.
  - Optional QA inspection of that asset (only if the C5d card is ruled in): `inputTokens × 0.3/M + outputTokens × 2.5/M + embedCalls × 0.0001` (qa/cost.ts:32-43); on the record it has been about a cent.
  - P-join, P-display: $0.

## Decisions needed from Adi (Phase R stop)

1. **C5d** — the UI check "one asset card showing its verdict and its cost" for a PR-9 edit is impossible at the tip: edits are never inspected. Options: (a) show verdict on a *generate* asset and cost-only on the edit, and card "inspect on accept" (new spend per accept, own ruling); (b) rule inspect-on-accept into this PR. Recommendation: (a).
2. **P-ids / P-door as written will miss** (pre-registered above). Keep the narrowed forms as the gate, or re-word the block.
3. **C1c** — the queued video runner is a second, unlogged door. Card, or fold into R-2 (touches videoRunner.ts, outside the map).
4. **C4** — actual cost on the job needs DDL; out of this PR unless ruled otherwise.

## Adi's Phase B rulings (2026-09-23, on the R-report)

1. Verdict display targets generate assets; edits show cost only. **Card:** "inspect on accept" — its own spend
   ruling, ~1¢ per accept (`inputTokens × 0.3/M + outputTokens × 2.5/M + embedCalls × 0.0001`). UI check amended:
   one generate asset's card with verdict + cost; one PR-9 edit's card with cost.
2. Narrowed P-ids and P-door are the gate; the pre-registered misses stay as misses. `assetId` null on the line is by
   construction — the join walks `editPreviewId → accepted_asset_id`. A prompt-version constant for the typed-op
   tier: one constant in edit/ops.ts, set in edit/engine.ts.
3. R-2 widened to videoRunner.ts: log at poll-complete only (jobId, clipId, model, price-table cost), zero
   behaviour change to submit/poll/lease. New mutation "a completed video clip writes no cost line". P-video
   becomes: one completed clip writes exactly one line. **Card:** the six remaining `genai(` callers, by file:line,
   beside the tagger card — agent/plan.ts:817, interpret/transport.ts:97, enrich/videoTag.ts:337,
   direction/transport.ts:87, reference/transport.ts:75, qa/embed.ts:85 (fetch), lib/visionTag.ts:149 (PR 12).
4. No DDL. **Card:** `cost_usd` on `generation_jobs`, to ride PR 13's migration.
5. presentEdit (engine.ts:797-822) is PR 10's; read cost off the edit row in the hook instead — done: `presentEdit`
   already returns `costUsd`, so EditSheet reads `edit.costUsd` and presentEdit is untouched.

## Phase B — what was built

**Lane 1 (server)**
- costLog.ts: `LoggedTask` (the router's union + `edit.recommend | image.detect | image.inspect | clip.inspect`);
  `GenerationRecord` carries the six keys (`jobId, previewId, editPreviewId, batchId, promptVersion, assetId`),
  null never omitted (`attributionFor`); pre-PR lines still read (keys absent, not an error).
- types.ts: `GenerationAttribution` + `ProviderOpts.attribution` (the carrier; the router holds no id itself).
- router.ts: passes `opts.attribution` onto the line. Callers: edit/engine.ts:566 (job, preview, edit row, batch,
  `OPS_PROMPT_VERSION = "typed-op/1"` from edit/ops.ts); generate.ts baseOpts (job, preview,
  `brief.job.interpretation?.promptVersion`); concept.ts (job, preview); segment.ts (job).
- videoRunner.ts: one line per stored clip at poll-complete — `video.generate`, the job's quote as
  `estimated`, `detail` says the poll result carries no billed figure, attribution {jobId, assetId}. Submit /
  poll / lease untouched.
- qa/cost.ts: `recordOffRouterSpend` — the one door for spend that is not a generation; provider `vertex`
  (genai() is the Vertex client); never throws. Routed through it: autoMask.ts `detectRegions` (miss path only;
  the memo fills `sourceAssetId` into `inputRefs`), edit/recommend.ts `recommendEdits` (memo fills the asset id),
  qa/inspect.ts both branches (`image.inspect`, {assetId, jobId}), qa/inspectClip.ts (`clip.inspect`; the row
  read gains `generation_job_id`).
- qa/join.ts: `joinRow(athleteId, {assetId|jobId|editPreviewId}, {logPath?})` → {job, asset, edit, verdict,
  costLines, costLinesFrom}; every predicate carries `athlete_id`; never invents a half.
  scripts/studioJoinRow.ts prints it (`--athlete --asset|--job|--edit [--log] [--json]`; the brief is omitted).
- qa/routes.ts: `GET /studio/assets/:assetId/qa` behind `STUDIO_QA_DISPLAY` (config.ts `qaDisplayEnabled`,
  documented beside `imageEditOpsEnabled`), mounted in routes/studio.ts beside `registerEditRoutes`. Wire:
  flag-or-pass wording + label, `unknownChecks`, identity captioned "Observation only, not a check" + caveat,
  `spendUsd`, and `cost` {usd, basis, source: edit_row | job_quote}. No check score, distance or threshold leaves
  the record; a `fail` reads as flagged.

**Lane 2 (client)**
- lib/flags.ts `STUDIO_QA_DISPLAY`; hooks/use-studio-qa.ts `useAssetQa` (disabled when the flag is off);
  components/studio/QaChip.tsx (flag decided before any hook mounts; no press handler).
- Sites: GenerationResult.tsx card meta row; AssetViewer.tsx bar (dark tone); EditSheet.tsx preview step shows
  "This edit cost $x.xx." off `edit.costUsd`, behind the flag.

## Mutations — red by name, then green (Phase M)

| Mutation | Test |
|---|---|
| a cost line without a job id | costLog.test.ts "a line written with no attribution still has every key, each null" |
| recommend spend unlogged | edit/recommend.test.ts "one call → one line, task edit.recommend…" |
| detection spend unlogged | autoMask.test.ts "one detection → one line, task image.detect…" |
| QA spend unlogged | qa/inspect.test.ts "a generate inspection writes one line…" + qa/inspectClip.test.ts "a stored verdict is followed by one line, task clip.inspect…" |
| a completed video clip writes no cost line | videoRunner.test.ts "a completed clip writes exactly one cost line…" |
| verdict shown as a score with a threshold | qa/routes.test.ts "carries NO check score, distance, mean or threshold…" + QaChip.test.tsx "puts NO score, count or threshold on screen…" |
| identity observation shown as pass/fail | qa/routes.test.ts "captions the identity observation as an observation…" + QaChip.test.tsx "captions the identity observation as an observation…" |
| verdict chip renders with STUDIO_QA_DISPLAY off | qa/routes.test.ts "answers 404 before reading anything…" + QaChip.test.tsx "renders nothing and mounts no query when the flag is off…" |
| join query invents a row when the job has no asset | qa/join.test.ts "a job with no asset → asset null, verdict null, edit null — not a placeholder" |

(red/green evidence recorded below once the jest slot clears)

## Things to know

- **P-ids / P-door as written: MISSED, as pre-registered.** The narrowed forms are what the tests assert.
- The "promptVersion on the edit brief" half of ruling 2 would have needed brief.ts (a third file) — it is on the
  cost LINE instead, which is what R-1 needs; the brief is unchanged. Carded if a stored version is wanted.
- The video line's cost is the job's quote, always `estimated`: the adapter's `poll` returns no billed figure
  (types.ts), so "billed when the adapter returns it" has nothing to return today; `detail` says so on every line.
- `recordOffRouterSpend` swallows everything. inspect.test's stubs return verdicts with no `spend`; the door must
  not turn a stub into a failed inspection, and in production the same rule keeps a logging failure from undoing a
  paid check.
- EditSheet.tsx:279 has a pre-existing `react/no-unescaped-entities` lint error ("photo's") on origin/main, not in
  my hunk; left as found.
- `server/scripts/calibration/runs/blind-eval/blind-eval-2026-09-14.zip` shows modified in the worktree (git's
  CRLF warning on a binary; 0 lines). Not mine, not staged.

## Phase M — red by name (2026-09-23, jest slot taken with clip-reads' clear)

Greens first, scoped (`npm test -- --filter …`, per-batch summaries): costLog 30/30 · edit/recommend 13/13 ·
autoMask 70/70 · qa/inspect + inspectClip 27/27 · videoRunner ×3 46/46 · qa/join 10/10 · qa/routes 10/10 ·
QaChip 10/10. Four first-run reds were test defects (an edit-mode job needs a source; delete order under the
source FK; the caveat's prose contains "failed"; an accessibility label doubled the `$` on the tree) and one was
a leaked `mockRejectedValue` on the framing observation from an earlier test — fixed in the tests, not the code.

| Mutation | Red (named test) | Restored |
|---|---|---|
| a cost line without a job id (drop `attributionFor`) | costLog "a line written with no attribution still has every key, each null" + 2 | cmp ✓ |
| recommend spend unlogged | recommend "one call → one line, task edit.recommend…" + memo test | cmp ✓ |
| detection spend unlogged | autoMask "one detection → one line, task image.detect…" + memo test | cmp ✓ |
| QA spend unlogged (both inspectors) | inspect ×2 + inspectClip "a stored verdict is followed by one line…" | cmp ✓ |
| a completed video clip writes no cost line | videoRunner "a completed clip writes exactly one cost line…" | cmp ✓ |
| verdict shown as a score with a threshold | routes "carries NO check score…" + QaChip "puts NO score, count or threshold…" | cmp ✓ |
| identity observation shown as pass/fail | routes "captions the identity observation…" + QaChip same | cmp ✓ |
| verdict chip renders with STUDIO_QA_DISPLAY off | routes "answers 404 before reading anything…" + QaChip "renders nothing and mounts no query…" | cmp ✓ |
| join query invents a row when the job has no asset | join "a job with no asset → asset null…" + tenancy test | cmp ✓ |

## Rebase onto PR 9.5 (ee357e11) — ADI'S, and the gate after it

`git rebase` is denied to this session (twice), so the rebase and the whole-suite gate on the rebased tip are
Adi's. Pre-work done read-only:

- `git merge-tree --write-tree origin/main HEAD` predicts exactly two conflicts, both additive:
  - `client/lib/flags.ts` — 9.5 appended `STUDIO_CLIP_READ` after `STUDIO_IMAGE_EDIT`; this branch appended
    `STUDIO_QA_DISPLAY` at the same place. **Keep both blocks**, either order.
  - `server/routes/studio.ts` — 9.5 added `registerClipReadRoutes(router, studioGate)` (+ its import at :148)
    after `registerEditRoutes`; this branch added `registerQaRoutes` there too. **Keep both mounts and both
    imports**; order does not matter (distinct paths).
- 9.5 touches none of the other files this branch edits; none of the ledger's file:line anchors moved
  except routes/studio.ts (+6 lines above the mount; the edit-routes mount is :3256 on the new main).
- The read route (`POST /studio/media/:id/read`, server/studio/enrich/routes.ts) accounts its spend as one
  clip's enrichment — it imports nothing from costLog and never calls the door. Out of scope, as ruled.
- The worktree shows `blind-eval-2026-09-14.zip` modified because `.gitattributes` marks it `text eol=lf`;
  `git checkout --` does not clear it. Not staged, not committed.

Gate on the rebased tip (Adi or a later session): `tsc -p tsconfig.jest.json`, `npm test` bare with every
per-batch summary read; the house flake (affiliationSync year-only) gets one isolated rerun.

## Rebased (2026-09-24): tip on base ee357e11 (PR 9.5 merged)

`git rebase origin/main` run by Adi from this session (`!`), after `git update-index --assume-unchanged` on the
attributes-dirty zip (unmarked again after). Conflicts: exactly the two forecast, both resolved keep-both in
main's order and shown before staging — `server/routes/studio.ts` (clip-read import + mount, then
`registerQaRoutes`) and `client/lib/flags.ts` (`STUDIO_CLIP_READ`, then `STUDIO_QA_DISPLAY`). No other file
conflicted. Against origin/main each of the two differs only by this branch's own lines.
`tsc -p tsconfig.jest.json` and `check:types` clean on the rebased tip. Moved anchor: the edit-routes mount is
routes/studio.ts:3256 on the new main and the QA mount follows the clip-read one at :3265-3269.

## P-join — the script's printed row (dev, read-only, run by Adi 2026-09-24)

`bash tools/join-row/print-row.sh 3811cedd-… --latest-edit` (her newest accepted typed edit; `--latest-edit`
and the wrapper were added for this run). Verbatim:

```
JOIN ROW  from editPreviewId=a2c672d4-565e-4da1-96e6-2cb86ec4e063

JOB
  id        50ecb687-40e1-41a5-9d94-7b230b4d3a5c
  status    succeeded   mode edit   deliverable post
  route     vertex / gemini-3-pro-image
  quoted    $0.2710  (estimated)
  created   2026-09-24T03:15:08.778Z   completed 2026-09-24T03:15:50.270Z

ASSET
  id        b610003b-0c47-45f6-bed4-d6b5956b6826
  type      IMAGE   approval draft
  job       50ecb687-40e1-41a5-9d94-7b230b4d3a5c
  derived   b33ceaf0-be25-4a8e-9c5d-4dfd6573b408
  created   2026-09-24T03:15:58.732Z

EDIT ROW
  id        a2c672d4-565e-4da1-96e6-2cb86ec4e063   op product   status accepted
  batch     — (single edit)   preview 5f041be9-ffa9-44d9-912a-89dc552225ce   job 50ecb687-40e1-41a5-9d94-7b230b4d3a5c
  source    b33ceaf0-be25-4a8e-9c5d-4dfd6573b408   accepted → b610003b-0c47-45f6-bed4-d6b5956b6826
  quoted    $0.2710   actual $0.2400

VERDICT   (none)

COST LINES  0 in studio-cost-log.jsonl
  (none — a line written before PR 11 carries no join key, and the log is per machine)
```

**P-join: as predicted.** One row, zero writes, every half present (job ↔ asset via `generation_job_id`,
asset ↔ edit via `accepted_asset_id`, edit ↔ job via `job_id`), verdict none (edits are never inspected,
C5d), cost lines none. Two reasons for the empty lines, both known: this edit ran at 03:15 under a server on
main (pre-PR lines carry no keys), and the script's default log path resolves in its cwd (the worktree), not
the dev server's checkout. A row with `jobId / editPreviewId / promptVersion=typed-op/1` on its lines needs
one edit run against a server on this branch — the P-ids cell, not run ($0 spent), Adi's go per run.
Note the row also shows what F15 said: the job carries only the quote ($0.2710); the actual ($0.2400) is on
the edit row alone.

## Rebased again (2026-09-24): base de3fc18b (PR 10 merged) — and the whole-suite gate

`git rebase origin/main` (Adi, `!`) applied all seven commits with no conflict; merge-tree had forecast none.
PR 10's `presentEdit` now returns `{url: null, expired: true}` on a stale row and this branch never touched
that function (the sheet reads `edit.costUsd`, which presentEdit still returns), so it merged clean — checked
on the tip. Moved anchors on the new main: routes/studio.ts mounts are edit :3270 · clip-read :3275 ·
`registerQaRoutes` :3280; config.ts `qaDisplayEnabled` :1685 beside `imageEditOpsEnabled` :1673.
`.env.development` (committed by PR 10, client flags only) gains `EXPO_PUBLIC_STUDIO_QA_DISPLAY=true` for
dev; the server-side `STUDIO_QA_DISPLAY` has no home in that file (it holds no server flags) and the code
default stays off on both sides.

**Gate on the rebased tip** — `tsc -p tsconfig.jest.json` clean, `check:types` clean, bare `npm test`, every
per-batch line as printed (jest slot taken with library-fields' clear, released after):

```
✓ client#1: 40 suite(s), 674 test(s), 0 failed, 9.6s
✓ client#2: 25 suite(s), 867 test(s), 0 failed, 3.3s
✓ scripts: 2 suite(s), 21 test(s), 0 failed, 1.6s
✓ server/(root): 2 suite(s), 68 test(s), 0 failed, 0.5s
✓ server/lib: 38 suite(s), 529 test(s), 0 failed, 9.4s
✓ server/mila: 27 suite(s), 381 test(s), 0 failed, 22.8s
✓ server/routes#1: 40 suite(s), 693 test(s), 0 failed, 59.3s
✓ server/routes#2: 1 suite(s), 3 test(s), 0 failed, 1.8s
✓ server/scripts: 4 suite(s), 23 test(s), 0 failed, 0.6s
✓ server/services#1: 40 suite(s), 634 test(s), 0 failed, 38.9s
✓ server/services#2: 40 suite(s), 350 test(s), 0 failed, 18.6s
✓ server/services#3: 22 suite(s), 315 test(s), 0 failed, 14.7s
✓ server/skills: 21 suite(s), 153 test(s), 0 failed, 27.8s
✓ server/studio#1: 40 suite(s), 1155 test(s), 0 failed, 52.2s
✓ server/studio#2: 40 suite(s), 871 test(s), 0 failed, 31.3s
✓ server/studio#3: 40 suite(s), 1034 test(s), 0 failed, 165.9s
✓ server/studio#4: 38 suite(s), 843 test(s), 0 failed, 104.8s
✓ server/voice: 29 suite(s), 703 test(s), 0 failed, 69.7s
✓ server/workflow: 5 suite(s), 45 test(s), 0 failed, 10.2s
npm test exit 0
```

19 batches, 9362 tests, 0 failed. No isolated rerun needed: the affiliationSync house flake did not fire.
