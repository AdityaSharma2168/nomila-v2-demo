# PR 9.5 — Clip reads: videos usable with the planner — ledger

Branch `studio/clip-reads` · worktree `/Users/adi/nomila-v2-worktrees/clip-reads` · base `origin/main`
Tip at worktree creation: **036cc1c6** (Merge PR #577, feat/objectives-3b-2). AUDIT2 pinned at c8242e07;
`git diff --stat c8242e07..HEAD` = 15 files, all objectives/migrations (0065, objectives.ts, objective/\*,
previews.migration.test.ts, schema.ts +5). None of the F22 cited files moved. Every cite below is
re-verdicted at 036cc1c6 regardless.

Source of truth for the seams: AUDIT2 F22 (B1–B5). Rulings R-1…R-6 as given in the card.

Phase R: read-only, $0, no jest, no server, no DB writes. Held for Adi's go after the R-report.

---

## 1 · Claims table (Phase R)

Verdicts: CONFIRMED / STALE (fact holds, line moved) / WRONG / PARTIAL / UNVERIFIABLE.

| #   | Claim                                                                                     | Expected evidence                                                     | Verdict at 036cc1c6                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1a | `VideoEnrichOpts` has no `assetId`                                                        | `enrich/videoEnrichment.ts:136-153`                                   | **CONFIRMED** `:136-152` — `athleteId?, chunk?, transport?, loadBytes?, statBytes?, probeContainer?, budget?, dailyCapUsd?, now?`. No `assetId`.                                                                                                                                                                                              |
| R1b | `conds()` is athlete + untagged + leave-out only                                          | `:186-196`                                                            | **STALE→CONFIRMED** `:185-195` (one line up). `status='stored'`, `parent_media_id IS NULL`, `VIDEO_UNTAGGED` (`:88-94`), `athlete_id` when given, `notInArray(athlete_id, leaveOut)`.                                                                                                                                                       |
| R1c | The chunk select                                                                          | `:334-346`                                                            | **STALE→CONFIRMED** `:332-346`; `.where(conds(opts.athleteId, [...atCap])).limit(chunk)` `:345-346`. The `remaining` count re-uses `conds(opts.athleteId)` at `:512`.                                                                                                                                                                       |
| R1d | Sole entry `enrichNextChunk({athleteId?, chunk?})`                                        | `services/mediaEnrichment.ts:233-236, :255-258`                       | **CONFIRMED** `:233-237` (chain wrapper), `:255-259` (`enrichVideoChunk({ athleteId: opts.athleteId })` at `:257`). Only `athleteId` is forwarded; no `chunk`, no asset.                                                                                                                                                                     |
| R1e | Callers: cron, post-upload, poster kick, backfill                                         | `index.ts:852`, `routes/media.ts:417`, `videoPoster.ts:62-64`, `mediaBackfill.ts:137` | **STALE→CONFIRMED** cron `index.ts:855`; the other three exact (`media.ts:417`, `videoPoster.ts:62-64`, `mediaBackfill.ts:137`).                                                                                                                                                                                                        |
| R1f | No POST route matches enrich/reread/analyze                                               | grep                                                                  | **CONFIRMED** — `router.post` in `routes/media.ts`, `routes/studio.ts`, `studio/*/routes.ts` → no enrich/reread/analyze/read.                                                                                                                                                                                                                 |
| R2a | Per-read cost derivable from `enrich/config.ts:47-99`                                     | price tables                                                          | **CONFIRMED** rates `:87-95` ($1.50/M in, $9/M out, env-overridable), `VIDEO_TOKENS_PER_SECOND=132 :103`, `VIDEO_PROMPT_TOKENS=700 :105`, `VIDEO_OUTPUT_TOKENS_FLAT=400 :107`, `_PER_SECOND=40 :108`, `VIDEO_ASSUMED_SECONDS=60 :114`; `estimateVideoTokens` + `usdOf` in `videoCost.ts:43-63`. Timeout `videoEnrichTimeoutMs` 120 s `:47-48`. |
| R2b | Measured per-clip latency exists in docs/probes                                           | a ledger line                                                         | **WRONG (none exists)** — grep latency/elapsed/took/wall/p50 across `docs/probes/*.md`, `docs/plans/*.md`: only `c3-doctrine2.md:25` (ffmpeg frame grab 0.43–0.56 s) and `enrich-eval.md:510` (ffmpeg 1–2 s). No model-call timing for a clip read anywhere. `probe-out/runs.jsonl` holds 30 image rows, no enrichment rows.                    |
| R3a | `resignItems` re-signs URLs only                                                          | `agent/plans.ts:116-146`                                              | **CONFIRMED** `:116-146`; `loadCastable` `:122`; returns `{...item, thumbUrl, videoUrl}` `:139-143`. No beats read, no beats written.                                                                                                                                                                                                         |
| R3b | GET plan returns `row.plan` resigned                                                      | `routes/studio.ts:2480-2512`                                          | **CONFIRMED** `:2480-2512`; `items: await resignItems(athleteId, body.items)` `:2503`.                                                                                                                                                                                                                                                       |
| R3c | Beats reach a plan only via cast→library→fresh POST                                       | `cast.ts:458,478-488 → :401-444 → :379-398 → library.ts:459-467`     | **CONFIRMED** `beatsOf :379-398`, `toCastable :401-446` (`beats:` at `:444`), `loadCastable :458`, `listClips :478-500`, `library.ts:459-467`.                                                                                                                                                                                              |
| R3d | A plan item carries the asset id                                                          | `CastItem`                                                            | **CONFIRMED** `cast.ts:636-…` — cast branch has `assetId, mediaType, trim, durationSeconds, videoUrl, provenance, editNote`. **No `beats` field on a stored item.** The merge is a NEW read-time field, never a stored one.                                                                                                                  |
| R4a | AgentScreen surfaces                                                                      | `:630-634, :652, :673-679`                                            | **CONFIRMED** hint `:630-634`, `cut: r.beats > 0` `:652`, chips only when `v.beats > 0` `:673-679`. Tray state is inline: `useState<PickedVideo[]>` `:149`, `toggleVideo :476-484`, `setCut :485-486`.                                                                                                                                       |
| R4b | Beat count plumbing                                                                       | `mediaPickerLogic.ts:42-43,152 ← mediaList.ts:163-165,246-247,276`   | **CONFIRMED** all five. `MEDIA_COLUMNS.beats` is `jsonb_array_length(metadata->'vision'->'beats')` else 0 (`mediaList.ts:165`).                                                                                                                                                                                                              |
| R4c | MediaDetail "Analyzed" keyed on `vision`                                                  | `MediaDetailScreen.tsx:44, :91, :231-233`                             | **CONFIRMED** `:44` `v = detail?.vision`, `:91` `analyzed={!!v}`, `StatusStrip :231-233`.                                                                                                                                                                                                                                                    |
| R4d | Server detail sends the whole vision object                                               | `routes/media.ts:193-206`                                             | **CONFIRMED** `:206` `vision: meta.vision ?? null`. ⇒ **`vision.beats` is ALREADY in the detail payload**; B4 needs no server change to key `analyzed` (see Decisions D3).                                                                                                                                                                  |
| R4e | A poster-tagged video has `vision`, no `beats`                                            | `mediaEnrichment.ts:242-246`                                          | **PARTIAL** — `:242-246` is the comment; the tagging itself is `enrichRows` on `img = thumb ?? path` (`:262`), i.e. the photo lane tags a video from its poster. `clipStillOwed :93-96` documents the "vision but no beats" state by name.                                                                                                     |
| R5a | Spend is booked on the row, against the per-athlete UTC-day cap                          | `videoEnrichment.ts`                                                  | **CONFIRMED** `spentToday :210-225`, `bookSpend :227-236` (`metadata.enrich_spend = {day, usd}`), `book` closure `:326-329`, booked at `:451` (settled usage) and `:466` (estimate on throw). Cap read `enrichDailyCapUsd` `config.ts:66-71`. Per-clip cap check `:377-395` (fenced ⚠️ MUTATION). At-cap → `continue`, counted in `dailyCapped`. |
| R5b | A single-asset call reuses the path unchanged                                            | —                                                                     | **CONFIRMED** — everything hangs off `enrichVideoChunk`; with `assetId` in `conds()` the same loop books, caps, CAS-writes (`writeVision :262-296` `WHERE beats IS NULL`) and logs.                                                                                                                                                            |
| R6a | No `STUDIO_CLIP_READ`                                                                     | grep                                                                  | **CONFIRMED** — 0 hits in server/, client/, docs/.                                                                                                                                                                                                                                                                                            |
| R6b | `STUDIO_VIDEO_ENRICH` on in dev `.env` (F17 line 68)                                      | `.env:68`                                                             | **UNVERIFIABLE** — `.env` and `.env.development` are deny-listed for this session (read blocked). Docs say the two Cloud Run yamls have it OFF (`flip-checklist.md:292`); `gcp/`, `.github/` grep → 0 hits for either var. Adi confirms the local line.                                                                                     |
| R6c | Where the pair goes / twin's read site                                                    | `config.ts`, `flags.ts`                                               | **CONFIRMED** server gates cluster `server/studio/config.ts:1156` (`agentEnabled`) … `:1673-1674` (`imageEditOpsEnabled`, the documented 404 shape); client twins `client/lib/flags.ts:84` (`STUDIO_AGENT`) … `:113-114` (`STUDIO_IMAGE_EDIT`). Route-off shape `edit/routes.ts:141-147`; mount `routes/studio.ts:3255`.                     |
| R6d | Async precedent                                                                           | `batch.ts:339,344-348`                                                | **CONFIRMED** `if (input.kick !== false) kickEditTick()` `:339`; `kickEditTick` `:343-348` (`void editTick().catch(log)`).                                                                                                                                                                                                                   |

---

## 2 · The quote formula and the sync/async call

**Quote (R-3), from `enrich/config.ts` + `videoCost.ts`, Flash defaults:**

```
s   = duration_seconds_precise ?? (duration_seconds > 0 ? duration_seconds : 60)
in  = ceil(132·s + 700)          tokens
out = ceil(400 + 40·s)           tokens
usd = in × 1.5e-6 + out × 9e-6
```

| s (sec) | in tokens | out tokens | quote    |
| ------- | --------- | ---------- | -------- |
| 4       | 1228      | 560        | $0.0069  |
| 6       | 1492      | 640        | $0.0080  |
| 14.5    | 2614      | 980        | $0.0127  |
| 51.5    | 7498      | 2460       | $0.0334  |
| 60 (unknown duration) | 8620 | 2800  | $0.0381  |

The estimator is a ceiling: `enrich-eval.md:245` measured it ≈1.5× over Flash's invoice on the 51 s clip.
The button shows the quote; the row books what Vertex reports (`:451`), the estimate only on a throw (`:466`).

**Sync vs async (R-6): ASYNC.** The rule was "sync only if the evidenced p50 < 8 s". There is no evidenced
p50 at all (R2b). What is evidenced: the call is bounded at 120 s (`config.ts:47-48`); the whole mp4 (up to
100 MB, `:81-84`) is base64'd inline into one `generateContent` (`videoTag.ts:344`), so the bytes sit in
process memory for the call's duration either way; the model samples at 1 fps (`SAMPLED_FPS=1`, `:86`) and
emits ~40 output tokens per clip-second. A 51 s clip is ~7.5k input + ~2.5k output tokens plus a
multi-MB upload; nothing about that shape lands under 8 s. Async per R-6: in-process kick, read state in
`metadata.clip_read` (jsonb_set on one key, no DDL), the client polls the existing GET.

---

## 3 · Pre-registered predictions

| #      | Prediction (falsifiable)                                                                                                                                                                                                                                                                                                                             | Outcome |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| P1 conds       | Adding `if (assetId) c.push(eq(mediaAssets.id, assetId))` to `conds()` and passing `{assetId, chunk: 1}` makes `enrichVideoChunk` select exactly one row for that id when it is untagged, and zero rows when it is already read (beats present), abandoned, deleted, or another athlete's — with `athleteId` also required. PGlite test: 5 rows seeded, 1 selected.       | —       |
| P2 idempotent (restated by Adi at the go) | The GET answer's items are byte-identical to today's resign of the stored plan when no asset gained beats (no `beats` key appears), and differ ONLY in a `beats` field on the clip item when one did. Both halves tested. The stored `plan` jsonb is never written by `resignItems`. | —       |
| P3 state       | On MediaDetail a video row with `vision` present and `vision.beats` absent renders the strip's first pill as pending ("Reading…"/unread), not "Analyzed"; an image row with `vision` renders "Analyzed" unchanged; a video with `vision.beats` (array, any length incl. 0) renders "Analyzed".                                                                            | —       |
| P4 cap         | With `dailyCapUsd` = today's booked spend (i.e. at cap), POST read answers `{status:"at_cap", reason, quotedUsd}`, the transport is never called, the row's `vision` is unchanged; a subsequent POST /studio/agent/plan with that clip in `videos` (cut:false) saves a plan with the clip as a whole-clip row at the end.                                                 | —       |
| P5 failure     | A transport throw on the read leaves the row unread (`beats` absent, `enrichment.attempts` +1, `clip_read.state="failed"` with a reason); the plan POST still saves with the clip appended as-is; the tray keeps the video with `cut:false`.                                                                                                                             | —       |
| P6 latency     | The first live read of the 51.5 s clip takes between 15 s and 60 s wall (route accept → `clip_read.state="done"`). Under 8 s would falsify the async call; over 120 s hits the timeout.                                                                                                                                                                                 | —       |
| P7 flag        | With `STUDIO_CLIP_READ` unset, POST /studio/media/:id/read → 404 `{error:"Not found"}` before any row read; with it on but `STUDIO_VIDEO_ENRICH` off → 404 as well; the client twin off → no button on either surface, the passive hint at `AgentScreen.tsx:631-634` unchanged.                                                                                          | —       |
| P9 seam (registered at the go) | An end-to-end read on a fresh upload via POST /studio/media/:id/read completes inside P6's bound (15–60 s wall) and the Agent tray's beat count and "Cut it · N beats" chip update without a re-plan. | —       |
| P8 replay      | Per clip, of the interior beat boundaries the model emits (beats−1), how many land within 0.5 s of a moment Adi accepts. **d076a790** (51.5 s camera): 6 beats, 5 boundaries, **4 hit**. **e055746a** (camera, field): 3 beats, 2 boundaries, **1 hit**. **f2338ddc** (generated, static pose): 4 beats (phantom split), 3 boundaries, **0 hit**. **943bfc9e** (generated 6 s, CGI ball then still): 2 beats, 1 boundary, **1 hit**. Totals: 11 boundaries, 6 hits. | —       |

Misses are honored and reported, never patched.

---

## 4 · Mutations (Phase M) — red-by-name, test file per row

| Mutation                                                | Guard removed                                                                              | Test file                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| "clip read runs unquoted"                               | the route's `quotedUsd` computation / its presence on every answer                         | `server/studio/enrich/clipRead.test.ts`                      |
| "read spend not counted against the day cap"            | `await book(c, …)` at `videoEnrichment.ts:451`                                             | `server/studio/enrich/clipRead.test.ts` (asserts `spentToday`) |
| "read at cap runs anyway"                               | the per-clip cap check `videoEnrichment.ts:377-395` (already ⚠️-fenced)                     | `server/studio/enrich/clipRead.test.ts`                      |
| "unread clip cut without a read"                        | `cut: r.beats > 0` (moved into a pure `pickVideo`/`setCut` guard)                          | `client/screens/studio/agentLogic.test.ts`                   |
| "read failure blocks the plan"                          | the tray's failure handler keeping the video with `cut:false`; server: plan POST unaware   | `client/screens/studio/agentLogic.test.ts` + `server/routes/studio.agent.test.ts` |
| "saved plan ignores a later read"                       | the `beats` merge in `resignItems`                                                         | `server/studio/agent/plans.test.ts` (or `studio.agent.test.ts` if plans has no suite) |
| "poster-only video shows Analyzed"                      | `analyzedOf(detail)` keying on `vision.beats` for a video                                  | `client/screens/mediaDetailLogic.test.ts` (new pure module)  |
| "Read this clip renders with STUDIO_CLIP_READ off"      | the `STUDIO_CLIP_READ` read in the affordance's `show` logic                               | `client/screens/studio/clipReadLogic.test.ts` (new)          |
| "a dead read stays reading forever"                     | the R-7 staleness rule in `clipReadStateOf` (reading older than 2 × 120 s → failed "read didn't finish", new read allowed) | `server/studio/enrich/clipRead.test.ts`                      |
| "image asset gets a read affordance"                    | the video-only check (server route 409 + client `show` logic)                              | `server/studio/enrich/clipRead.test.ts` + `clipReadLogic.test.ts` |

---

## 5 · Component map (Phase B, after the go)

**Lane 1 — server**
- `server/studio/enrich/videoEnrichment.ts` — B1: `assetId?` on `VideoEnrichOpts`; `conds(athleteId, leaveOut, assetId)`; the `remaining` count at `:512` also scoped by asset. Nothing else moves.
- `server/studio/enrich/config.ts` — `clipReadEnabled()` (`STUDIO_CLIP_READ`), documented like `videoEnrichEnabled`.
- `server/studio/enrich/clipRead.ts` (new) — `quoteClipRead(row)`, `startClipRead({athleteId, assetId})`: ownership + video check (`herClip` predicate from `mediaList.ts`), quote, `jsonb_set(metadata,'{clip_read}', {state:"reading", startedAt, quotedUsd})`, the in-process kick → `enrichVideoChunk({athleteId, assetId, chunk:1})` through the enrichment chain, then `clip_read` → `done`/`failed(reason)`/`at_cap(reason)`. No DDL.
- `server/studio/enrich/routes.ts` (new) — `registerClipReadRoutes(router, studioGate)`: `POST /studio/media/:id/read` behind `studioGate` + `STUDIO_CLIP_READ` + `STUDIO_VIDEO_ENRICH` (404 shape of `edit/routes.ts:141-147`). Answers `{status: "reading"|"done"|"at_cap"|"failed"|"already_read", quotedUsd, beats?, reason?}`; never throws to the client.
- `server/routes/studio.ts` — one mount line beside `:3255`.
- `server/services/mediaEnrichment.ts` — a chain-sharing `enrichOneClip` export so a user read never overlaps a cron pass in-process (the `chain` at `:231-237`).
- `server/studio/mediaList.ts` — `readQuoteUsd` and `readState` on a clip row (`shapeMediaRow`), so the tray quotes before the tap and shows reading/failed.
- `server/routes/media.ts` — B4: the detail answer adds `read: {state, quotedUsd, beats: number|null}` for videos (spec's B4; `vision.beats` already rides in `vision`).
- `server/studio/agent/plans.ts` — B3: `resignItems` merges `beats: row.beats.length` for `mediaType === "clip"`; `CastItem` gains an optional read-time `beats?: number` (cast.ts type only).
- Tests: `enrich/clipRead.test.ts` (PGlite), `agent/plans` merge test, route test in `routes/studio.media.test.ts` pattern.

**Lane 2 — client**
- `client/lib/flags.ts` — `STUDIO_CLIP_READ` twin, documented like `STUDIO_IMAGE_EDIT`.
- `client/hooks/use-studio-media.ts` — `useReadClip()` mutation + poll of the existing GET until `read.state` leaves "reading"; invalidates `STUDIO_MEDIA_KEY`.
- `client/screens/studio/clipReadLogic.ts` (new, pure) + test — `affordanceState(row, flags)` → unread(quote) · reading · read(N) · failed(reason) · at-cap(reason) · none.
- `client/screens/studio/AgentScreen.tsx` — the tray's per-video "Read this clip · $0.0X" pill and states; after done, the entry's `beats` and `cut` update in place (no re-plan).
- `client/screens/studio/agentLogic.ts` — `setCut` refuses `cut:true` at beats 0; `readDone(assetId, beats)` / `readFailed(assetId)` reducers.
- `client/screens/mediaDetailLogic.ts` (new, pure) + test — `analyzedOf(detail)`; `MediaDetailScreen.tsx` keys `analyzed` on it and gets the same pill under the strip.

**Not touched:** `agent/plan.ts`, `interpret/`, `classify.ts`, `edit/`, `compile/`, any replan route, `.github/`, `gcp/`, migrations.

---

## 6 · Replay quote (Phase A, needs Adi's go per run)

Athlete: 3811cedd. Adi ran the SELECT at the go (2026-09-23): **96 video rows, 12 unread** (all `generated`: 4a8eaf6c 53.6 s, e2a3b713 26.5 s, 7f711411 25.2 s, e3292d0f 12 s, 4ecafec0 / b87273ef / c922aaba / c10477bd / d20824c7 / cff227ba 4 s, d03afb9c / 7496dafa 2 s). The enrich ledger's "all 66 read" was true of an older library. The four replay clips are all READ (beats on record), so replay (a) runs on stored beats at $0. e055746a and 64c9bf0d have NULL precise duration and `duration_seconds` 0 → the quote formula assumes 60 s for them.

`STUDIO_ENRICH_DAILY_CAP_USD=0` semantics, from code (`config.ts:66-71`, `videoEnrichment.ts:377-395`): 0 is a finite number ≥ 0, so it is a CAP OF ZERO — every clip's estimate exceeds what the day has left and every clip is refused ("wait for tomorrow"). It is not "unlimited"; unlimited is UNSET or empty. The walk's "cap to 0" therefore refuses, as intended.

Fresh-clip read quotes at the R2 formula: a 4 s clip $0.0069, 6 s $0.0080, 12 s $0.0115, 25 s $0.0182, 54 s $0.0348; 3–4 phone clips of 10–30 s quote at **$0.04–0.08 total**.

| clip       | provenance          | duration        | beats on record | quote    |
| ---------- | ------------------- | --------------- | --------------- | -------- |
| d076a790   | camera upload       | 51.5 s          | 6 (owner truth) | $0.0334  |
| e055746a   | camera upload       | unknown to me   | 3               | ≤ $0.0381 (60 s ceiling) |
| f2338ddc   | generated, static   | unknown to me   | 4 (phantom)     | ≤ $0.0381 |
| 943bfc9e   | generated           | 6 s             | ?               | $0.0080  |
| **total**  |                     |                 |                 | **≤ $0.118 quoted** |

⚠️ Two things Adi decides before the go:
1. **Beats-absent clips may not exist in her library.** I could not query (env files deny-listed; no DATABASE_URL). The SQL for Adi to run, scoped to her row: `SELECT id, duration_seconds_precise, duration_seconds, origin, (metadata->'vision'->'beats') IS NOT NULL AS read FROM media_assets WHERE athlete_id = '<her id>' AND content_type LIKE 'video/%' AND deleted_at IS NULL AND status='stored' AND parent_media_id IS NULL ORDER BY duration_seconds_precise DESC NULLS LAST;`
2. If none are unread, the replay runs `tagVideo` in-process on the bytes (same transport, same quote, **no DB write**, spend recorded by hand on this ledger) — or Adi uploads 3–4 fresh clips and the route reads them end-to-end. The second is the real seam; the first is the same model call.

Spend lines (quoted vs billed, never summed together):

| run | quoted | billed | notes |
| --- | ------ | ------ | ----- |
| —   | —      | —      | nothing run in Phase R |

---

## 7 · Decisions

- **D1 Async** (R-6, §2): no evidenced p50; 120 s bound; bytes inline. In-process kick, `metadata.clip_read` state, poll the existing GET.
- **D2 One cap guard, the chunk's (ratified by Adi at the go).** The route does not duplicate the per-clip cap check; the chunk's at-cap refusal string is exported and passed through as the answer's `reason`. The mutation "read at cap runs anyway" asserts THAT string, not a generic failure, and targets `videoEnrichment.ts:377-395`, the existing fenced guard.
- **R-7 (Adi's ruling at the go).** `metadata.clip_read` carries `startedAt`; a `reading` state older than 2 × the 120 s bound renders as failed ("read didn't finish") and a new read is allowed.
- **D1 split (Adi at the go).** Replay (a): $0, frames at each STORED beat start/end for d076a790, e055746a, f2338ddc, 943bfc9e via ffmpeg, contact sheets to `probe-out/clip-reads/`, P8 judged by Adi's eyes. Replay (b): seam test on fresh uploads after the build, on Adi's go — first confirm what `STUDIO_ENRICH_DAILY_CAP_USD=0` means (refuse vs unlimited), then the walk script: cap to 0, restart, upload 3–4 clips, verify unread, restore cap, tap Read. P9 registered.
- **D3 B4 is client-keyable today.** `routes/media.ts:206` already ships the whole `vision` object, so `analyzed` can key on `vision.beats` with zero server change. The server half of B4 adds `read: {state, quotedUsd}` for the pill, not for the strip.
- **D4 The beats merge is read-time, not stored** (R-2): `resignItems` adds `beats` to the answered item; the `studio_plans.plan` jsonb is never rewritten (rows are never edited, `schema.ts:2170-2175`).
- **D5 The read goes through the enrichment chain** (`mediaEnrichment.ts:231-237`) so a user tap and a cron pass never read the same clip twice in one process; across instances the CAS in `writeVision` still decides.

## 8 · Build (Phase B) — 2026-09-23

Base 036cc1c6. Commits (unpushed):

| sha      | lane | seams |
| -------- | ---- | ----- |
| 66771055 | 1 server | B1 `assetId` + per-row outcomes + exported `DAILY_CAP_REFUSAL`; B2 `enrich/clipRead.ts`, `enrich/readState.ts`, `enrich/routes.ts` (POST /studio/media/:id/read), `clipReadEnabled`, `clipReadStaleMs` (R-7), `enrichOneClip` through the worker's one door; B3 `resignItems` beats merge + `CastItem.beats?`; B4 `read` on GET /studio/media clip rows and GET /media/:id |
| 05a2a045 | 2 client | `STUDIO_CLIP_READ` twin; `clipReadLogic.ts` (affordance, pickVideo/setCutOn/readDone/readNotDone/withRead); `useClipRead` (POST + poll GET /media/:id every 3 s, ≤ 240 s, then STUDIO_MEDIA_KEY invalidated); the tray pill on AgentScreen; the plan-card "Read since · N beats — plan it again" line; `mediaDetailLogic.analyzedOf` + the pill on MediaDetail; `read` threaded through the picker wire, `PickedVideo`, `AgentPlanItem`, `MediaDetail` |

Deviations from the R-report's component map: no `enrichment/` changes beyond the two named; `routes/media.ts` gained `read` (B4) as the spec asked, though the client keys `analyzed` on `read` when served and on `vision.beats` otherwise, so an older server still renders right. The route waits a 1.5 s grace (`CLIP_READ_GRACE_MS`) so at-cap / oversize / not-ready refusals come back in the tap's answer instead of one poll later; a real read answers `reading` and the client polls.

Gates on the tip: `tsc -p tsconfig.json` 0 errors · `tsc -p tsconfig.jest.json` 0 errors · eslint on every touched file 0 errors (warnings pre-existing: import/first in tests, one import/no-duplicates in videoEnrichment.ts on main) · prettier: `mediaList.ts`, `AgentScreen.tsx`, `mediaPickerLogic.test.ts` were clean on main and my edits kept/restored them clean; `mediaEnrichment.ts`, `routes/studio.ts`, `routes/media.ts`, `MediaDetailScreen.tsx`, `use-media-library.ts` were dirty on main and were NOT formatted (hunks only).

Scoped suites, green: clipRead.test.ts 19 · plans.resign.test.ts 3 · videoEnrichment.test.ts (existing) all · clipReadLogic.test.ts 11 · mediaDetailLogic.test.ts 4 · agentLogic / mediaPickerLogic / storyboardLogic existing (+1 wire test) all — 57 server + 162 client in the two scoped runs.

## 9 · Mutations (Phase M) — each guard removed, its test red BY NAME, guard restored from backup

| # | mutation | guard removed (file) | red test(s) | restored |
| - | -------- | -------------------- | ----------- | -------- |
| M1 | "clip read runs unquoted" | `quoteClipReadUsd` skipped, `clipRead.ts` | 2 red: *quotes before it runs and the quote is on the answer and on the row — 'clip read runs unquoted' reds here*; route *answers the outcome with the quote* | yes |
| M2 | "read spend not counted against the day cap" | `await book(c, …)` dropped, `videoEnrichment.ts:451` | 1 red: *books what the model reported against her UTC day — … reds here* | yes |
| M3 | "read at cap runs anyway" | per-clip cap check disabled, `videoEnrichment.ts:377` | 2 red: *at the day cap it refuses with the chunk's own refusal string … (P4)*; route *at cap, the answer is the refusal* — both assert `DAILY_CAP_REFUSAL` verbatim (D2) | yes |
| M4 | "unread clip cut without a read" | `pickVideo` cut:true regardless, `clipReadLogic.ts` | 2 red: *picking an unread clip adds it as-is …*; *a poll's intermediate state …* | yes |
| M4b | (same rule, second door) | `setCutOn` drops the beats guard | 1 red: *setCut cannot switch an unread clip to CUT …* | yes |
| M5 | "read failure blocks the plan" | `readNotDone` drops the video from the tray | 1 red: *a read that did not finish KEEPS the video on the tray … (P5)* | yes |
| M6 | "saved plan ignores a later read" | beats merge disabled, `plans.ts resignItems` | 1 red: *the asset gained beats: the answer differs ONLY in `beats: N` …* | yes |
| M7 | "poster-only video shows Analyzed" | `analyzedOf` keys a video on `vision` | 1 red: *a poster-tagged VIDEO — vision present, no beats — is NOT analyzed …* | yes |
| M8 | "Read this clip renders with STUDIO_CLIP_READ off" | `readAffordance` ignores `on` | 1 red: *renders NOTHING with the flag off …* | yes |
| M9a | "image asset gets a read affordance" (client) | `readAffordance` drops the kind check | 1 red: *renders nothing for a photo …* | yes |
| M9b | "image asset gets a read affordance" (server) | `clipRead.ts` drops the content-type check | 2 red: *an image is refused … (server half)*; route *… 409 for an image* | yes |
| M10 | "a dead read stays reading forever" (R-7) | `readState.ts` drops the age check | 2 red: *a `reading` mark older than 2× the call bound reads as failed …*; *a new read is allowed over a dead mark …* | yes |
| M11 | "another athlete's clip is not found" (tenancy) | `clipRead.ts herRow` drops the athlete predicate | 2 red: *another athlete's clip is not found, before any model call …*; route *404 for … another athlete's clip* | yes |
| M12 | "the read route is there with the flag off" (P7) | `routes.ts` drops both flags | 1 red: *is not there with STUDIO_CLIP_READ off, nor with STUDIO_VIDEO_ENRICH off …* | yes |

Green after every restore: the suites re-ran green before the gate (§10). Runner: scratchpad `mut/mutate.py` (backup → patch → jest → restore from the backup file, never `git checkout`).

## 10 · Whole-suite gate — `npm test` bare, 2026-09-23, on 02990ae8 (then client re-run on 47b5ebe5)

Every per-batch summary, as the runner printed it:

```
✗ client#1: 40 suite(s), 689 test(s), 0 failed, 13.2s      ← one suite FAILED TO RUN (below)
✓ client#2: 23 suite(s), 823 test(s), 0 failed, 2.9s
✓ scripts: 2 suite(s), 21 test(s), 0 failed, 2.1s
✓ server/(root): 2 suite(s), 68 test(s), 0 failed, 0.7s
✓ server/lib: 38 suite(s), 529 test(s), 0 failed, 12.3s
✓ server/mila: 27 suite(s), 381 test(s), 0 failed, 23.6s
✓ server/routes: 40 suite(s), 693 test(s), 0 failed, 78.6s
✓ server/scripts: 4 suite(s), 23 test(s), 0 failed, 0.7s
✓ server/services#1: 40 suite(s), 634 test(s), 0 failed, 48.1s
✓ server/services#2: 40 suite(s), 350 test(s), 0 failed, 32.5s
✓ server/services#3: 22 suite(s), 315 test(s), 0 failed, 18.8s
✓ server/skills: 21 suite(s), 153 test(s), 0 failed, 30.9s
✓ server/studio#1: 40 suite(s), 1143 test(s), 0 failed, 79.9s
✓ server/studio#2: 40 suite(s), 868 test(s), 0 failed, 56.7s
✓ server/studio#3: 40 suite(s), 1044 test(s), 0 failed, 117.8s
✓ server/studio#4: 36 suite(s), 800 test(s), 0 failed, 123.9s
✓ server/voice: 29 suite(s), 703 test(s), 0 failed, 65.8s
✓ server/workflow: 5 suite(s), 45 test(s), 0 failed, 6.7s
FINAL: Batches run: 18 · Suites: 489 · Tests: 9282 · Failed tests: 0 · Failing suites (1): [client#1] client/screens/MediaDetailScreen.test.tsx — "Test suite failed to run" · exit 1
```

The one red was MINE and real: importing `use-studio-media` into MediaDetailScreen pulled `query-client` → AsyncStorage into a render test that had mocked only `use-media-library`. Fix 47b5ebe5: the test mocks `useClipRead`, and gained four render cases (poster-only video → "Not read yet", read video → "Analyzed", image unchanged, no pill with the client flag off) — 11/11. Client area re-run on the tip:

```
✓ client#1: 40 suite(s), 700 test(s), 0 failed, 5.9s
✓ client#2: 23 suite(s), 823 test(s), 0 failed, 2.9s
Suites: 63  Tests: 1523  Failed tests: 0
```

The affiliationSync house flake did not fire this run. `tsc -p tsconfig.jest.json` 0 on the tip.

⚠️ Deviation: the single-suite re-run of MediaDetailScreen.test.tsx (pure RN, 11 tests, ~3 s) overlapped the gate's server/services batch. House rule says never overlap jest runs; the gate's batches all passed regardless, and the client area was re-run alone afterwards. Recorded, not excused.

## 11 · Replay (a) — $0, stored beats → frames → contact sheets (Adi runs)

```bash
cd /Users/adi/nomila-v2-worktrees/clip-reads
npx tsx --require dotenv/config tools/clip-reads/replay-frames.ts \
  d076a790-8610-4cc1-86b5-d9c3095d6ba1 \
  e055746a-e9b0-4340-922c-fd3f7d6bacb5 \
  f2338ddc-d189-4f9a-bdd1-56c7295cc13b \
  943bfc9e-a48e-4260-99f5-75f4636b15a6
```

Writes `probe-out/clip-reads/<id8>.json` (beats as stored), `<id8>/beat-NN-{start,end}.jpg`, `<id8>-sheet.jpg` (tiles in order, `[i] start|end t.tts` burned in). No model call, no DB write. Criteria are P8's counts; Adi grades against frames; misses stand.

| clip | P8 predicted (hits / interior boundaries) | Adi's count | verdict |
| ---- | --------------------------------------- | ----------- | ------- |
| d076a790 | 4 / 5 | — | — |
| e055746a | 1 / 2 | — | — |
| f2338ddc | 0 / 3 | — | — |
| 943bfc9e | 1 / 1 | — | — |

## 12 · Replay (b) — the seam on fresh uploads (after Adi's go; model spend, quoted)

`STUDIO_ENRICH_DAILY_CAP_USD=0` is a **cap of zero → every read refused** (`config.ts:66-71` accepts any finite ≥ 0; `videoEnrichment.ts:377-395` then finds `0 + est > 0` for every clip). Unlimited is UNSET/empty. So the walk's "cap to 0" holds uploads unread as intended.

Walk (Adi's terminals; nothing here is run by Claude):
1. In `.env`: `STUDIO_CLIP_READ=true`, `STUDIO_VIDEO_ENRICH=true`, `STUDIO_ENRICH_DAILY_CAP_USD=0`; `EXPO_PUBLIC_STUDIO_CLIP_READ=true` for Metro. Restart the API server and Metro.
2. Upload 3–4 phone clips (10–30 s) from the Agent tray's "Add this video". The post-upload kick runs the batch at cap 0 → each clip is left unread (`dailyCapped`), the tray shows "At today's reading limit" once the poster lands (the poster cron must have run — locally, run the poster tick once, or wait for it).
3. Verify unread: the SELECT from §6 (`read = f` for the new ids) — or the tray pill.
4. Restore the cap (`STUDIO_ENRICH_DAILY_CAP_USD` to its real value, or unset), restart the API server.
5. Tap "Read this clip · $0.0X" on one. Note the wall time from tap to "Read · N beats" (P6: 15–60 s) and that "Cut it · N beats" appears on the same tray entry with no re-plan (P9).
6. Plan it; the plan should cut INTO the clip (trimmed items). Open the saved plan (GET) — a whole-clip item made before the read now says "Read since · N beats".
7. MediaDetail on a poster-only video: "Not read yet", the pill; after a read: "Analyzed".

Quoted: a 12 s clip $0.0115, 25 s $0.0182, 30 s $0.0211; 3–4 clips **$0.04–0.08**. Spend line to be filled from the rows' `enrich_spend` after the walk (billed), never summed with the quote.

## 13 · Misses

- **R-report cite R2b** predicted no latency evidence and found none — not a miss, but P6 stays unmeasured until replay (b).
- **The enrich ledger's "all 66 read"** was stale: 96 rows, 12 unread today. Recorded in §6.
- **`.env` line 68** could not be verified by Claude (deny rule); Adi's paste at the go was empty. Still open.
- (P1–P9 outcomes: P1, P2, P3, P4, P5, P7 held in tests — see §9/§10; P6, P8, P9 await Adi's replays.)
