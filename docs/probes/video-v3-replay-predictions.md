# V3 replay — predictions, written before the replay

Base `8bf1ec9`. Foundation `466f437`, branch point `9038d5d`. Migration landed separately as `fb76994`.

Written FIRST. Each row is what I expect to happen when the hunk meets main. Anything that turns out
otherwise stops and goes to Adi rather than being absorbed.

## A. The four that should apply verbatim (main never touched them)

| file | prediction |
|---|---|
| `server/studio/videoJobs.ts` (265) | New file. Applies clean. Depends on `generationJobs` columns from 0056 — already landed. |
| `server/studio/videoJobs.test.ts` (346) | New file, PGlite-backed. Green without edits. |
| `server/studio/videoRunner.ts` (220) | New file. Imports `submitVideoOperation` / `pollVideoOperation` from the vertex split below, so it is green only after that hunk lands. |
| `server/studio/videoRunner.test.ts` (253) | New file. Same dependency. |
| `server/studio/adapters/vertex.ts` (+34/-1) | `generateVideo` split into `submitVideoOperation` + `pollVideoOperation`, composed. `git diff --numstat` says main is UNTOUCHED here, so it applies clean. The combined `generateVideo` stays, so `vertexAdapter` and every existing caller are unchanged. |
| `server/services/videoPoster.ts` (+11/-5) | `origin` filter widens `"upload"` → `["upload","generated"]`, twice. Main untouched. Applies clean. |

## B. The six main rewrote — hand-replay, per-file

### B1. `server/studio/config.ts` — MOSTLY ALREADY THERE
Prediction: **most of this hunk is redundant.** `maxJobUsd`, `supportedDurationsFor` and
`maxClipSeconds` are already on main (V2's spend-caps work replayed them). Only **`maxVideoBytes`
and `videoBytesPerSecond` are missing** — grep says 0 occurrences of each.
→ Replay reduces to adding those two exports. If main's `maxJobUsd` is not 10, or its
`supportedDurationsFor` disagrees with foundation's lists, that is a divergence I stop on rather
than reconcile.

### B2. `server/routes/studio.ts` — HALF ALREADY THERE
Prediction: the `MAX_CLIP_SECONDS` → `maxClip()` half is already on main, and **improved** — main
has a `HARD_MAX_CLIP_SECONDS` (60) clamp foundation never had. Do not touch it; do not walk it back.
Remaining to replay: the three-outcome status fork at `studio.ts:1787`
(`out.spent ? "succeeded" : "already_running"` → `queued | succeeded | already_running`), the
unawaited runner kick after the response, and the `GET /studio/jobs/:jobId` header comment.

### B3. `server/studio/preview.ts` — APPLIES IN FULL
Prediction: none of `durationBlockers`, `sizeBlockers`, `maxVideoBytes`, `videoBytesPerSecond`
appear on main (grep: 0 hits). The whole hunk is new. Main moved 580+/207- in this file so the
import list and the `blockers` array will not match context — expect a hand-merge of the import
statement and the one `blockers` spread, not a patch application.
Depends on B1 landing first (`maxVideoBytes`, `videoBytesPerSecond`).

### B4. `server/studio/generate.ts` — THE ONE THAT CHANGES BEHAVIOUR
Prediction: applies structurally (the anchors `assertRunnableInline` at :129/:1106, `claimJob` at
:1170 all exist), and `storeAsset`'s cap argument works because `mediaStore.saveBuffer` and
`rehostFromUrl` ALREADY take a `maxBytes` 4th/3rd parameter (verified: `mediaStore.ts:37,59`).
**But it deletes the video hold**, and that is not a mechanical change — see "The one thing I will
not decide" below.

### B5. `server/studio/generate.test.ts` — WILL NOT APPLY, MUST BE REWRITTEN
Prediction: this is the hunk that breaks. Main's copy moved +817/-4 and asserts the OPPOSITE of what
foundation asserts: six call sites expect `rejects.toThrow(VIDEO_NOT_INLINE_YET)`. Foundation deletes
that export. Expect to hand-write the replacement assertions (a clip QUEUES rather than throws)
rather than port foundation's, because main's suite around them is 800 lines newer.

### B6. `server/index.ts` — APPLIES, SMALLEST OF THE SIX
Prediction: clean. All three dependencies verified present on main —
`withAdvisoryLock as withWorkflowTickLock` (`index.ts:28`), `cronSecretValid` (`:130`), and the
`media-poster-cron` route the hunk inserts after. Only the line number moves.

## C. Blast radius beyond the fifteen files — NOT in foundation's diff

Deleting `VIDEO_NOT_INLINE_YET` / `assertRunnableInline` reaches **8 files main added after the
branch point**, none of which foundation could have known about:

- `server/studio/spendCaps.ts:11,22,25` — cites `generate.ts:1106 assertRunnableInline` by line, and
  says "⚠️ THIS FILE DOES NOT ENABLE VIDEO AND MUST NOT BE READ AS DOING SO"
- `server/studio/spendCaps.test.ts:7,15` — "`assertRunnableInline` is untouched and still refuses a clip"
- `server/studio/adapters/vertex.test.ts:314`, `adapters/openrouter.test.ts:18` — same disclaimer
- `server/routes/studio.ts:54,1048`, `server/routes/studio.interpret.test.ts:706` — same
- `server/studio/generate.test.ts` — the six live assertions in B5

Prediction: these are comments in 6 of the 8 and live assertions in 2. The comments become FALSE the
moment B4 lands. Correcting a stale comment that names a symbol I deleted is in scope; rewriting
those files' behaviour is not.

## The one thing I will not decide

Foundation's B4 **removes the hold that keeps video unreachable**. After the replay, a
`video.generate` with `STUDIO_ENABLED=true` queues and a runner spends real money on Veo.

Foundation's own plan said commit 1 ships dark *because `assertRunnableInline` still refuses video*,
and commits 2-3 sit behind `STUDIO_ENABLED`. Main has since built a whole spend-caps layer whose
files say in capitals that they do not enable video. So "replay the server half" and "ship dark" are
in tension here in a way they were not on the foundation branch.

I am not resolving that by choosing. I will build the replay with the fork in place and report the
exact flag surface, and Adi decides whether V3 lands with video reachable under `STUDIO_ENABLED` or
behind a further default-off gate.
