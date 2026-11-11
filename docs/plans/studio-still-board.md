# Studio — stills on the Board and in Agent plans (PR C1b): plan, rulings and ledger

Branch `studio/still-board`, off `35a6ca2` (#554, the media picker). Written 21 Sep 2026. The Board
gains a **still** row — one of her photos, held for N seconds at **$0**: no request, no quote, no
admission, no day-cap interaction — and the Agent planner's reserved `image` kind is un-refused, so a
plan can hold "product close-up · 2s · $0" at beat 3. Both halves in this PR: un-refusing without
Board still rows would show plan items the Board cannot hold.

C1 (`docs/plans/studio-still-clips.md`, #552) is the stitch path and the Video tab; this is the
Board/Agent half it deferred, gated on flip checklist §11.

---

## Gate zero — flip checklist §11, PASSED (21 Sep 2026)

The still encode was never measured on production's ffmpeg. Run as the checklist's own step:
`node:20-slim` + the Dockerfile's apt `ffmpeg` + `npm ci` + a Linux `npm rebuild sharp`, then
`server/studio/video/still.test.ts` inside the container, twice.

|        | aarch64 (native)              | linux/amd64 (emulated, prod's arch) |
| ------ | ----------------------------- | ----------------------------------- |
| ffmpeg | 5.1.9-0+deb12u1, Debian 12.13 | 5.1.9-0+deb12u1                     |
| sharp  | 0.34.5 / libvips 8.17.3       | same                                |
| suite  | **7 / 7**                     | **7 / 7**                           |

What those seven pin: the argv (`-loop 1`, `-t`, `scale…out_color_matrix=bt709:out_range=tv`,
`-color_range tv`, `-an`); the frame fitted inside the target and never enlarged; an EXIF-6 photo
upright by pixel (red block top-right at 1080×1440-in-1080×1920, not top-left at 1080×810) — sharp
`.rotate()` runs before ffmpeg and drops the tag, so the build cannot matter; the clip's profile
1080×1920, SAR 1:1, 30 fps, yuv420p, `color_range` tv, BT.709, 75 frames for 2.5 s; `planStitch`'s
six normalization flags all false; a still beside an untagged sounding clip on a 0.5 s fade leaves
the whole output limited-range at 3.5 s with silence synthesized. No fix to `still.ts` was needed.

## Rulings (Adi, 21 Sep 2026)

| #   | Ruling                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Two signatures, on purpose.** `stillSec` (and a Cut beside a still) stay OUT of `rowSignature` — no request reads them, a re-quote would refetch the same previews — and go INTO `boardWorkSignature`, which is what "Back to the plan" compares: a hold change is work she would mind losing. Each carries a comment naming why; do not unify. |
| 2   | Bridges: no bridge touches a still (`bridgeable`, `setBridge`, `normalizeBoard`); the join pill beside a still cycles Cut ↔ Fade only.                                                                                                                                                                                                           |
| 3   | Quote: a still is a $0 line, not a missing quote. An all-still board is $0.00, skips admission entirely (no requests → the tab never calls admit; `runBoardPieces` still refuses an empty list), and its CTA is the stitch panel — "Make the board" and the price panel are hidden. A mixed board admits its generating pieces whole, as before.  |
| 4   | Stitch gate: "anything to stitch" (settled-or-no-pieces, and a clip or a still). Stills slot by row order and always exist; a failed neighbour is named, the still stays; passthrough videos append last; all three kinds count against the 12-clip cap.                                                                                          |
| 5   | Planner: `image` requires a `ref` (a still IS a photo — rule 1 applies fully), may name any photo with or without her, never has sound, takes a slot against `MAX_PLAN_ITEMS`; the client seeds it as a still at the server's `defaultStillSec`.                                                                                                  |
| 6   | The design: `still` is in the `ShotKind` UNION so every `Record<ShotKind, …>` has to say what it does with one — the compiler found `ROLE_FOR` and the tab's refusal map on the first build.                                                                                                                                                      |

## The 15 sites → the commits

| Site                      | What                                                                                                | Commit |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| 1 row kind                | `ShotKind` gains `still`; `stillSec`, `cutIn`; `heldPhotoRow`, `setStillSec`, `isStillRow`          | 1, 4   |
| 2 request builder         | `boardRequests` skips a still; `clipRequestFor` throws on one; `roleFor` narrows                    | 1      |
| 3 bridges                 | kind-gated `bridgeable`; `setBridge`; `normalizeBoard`; `bridgeRequestFor` guard                    | 1      |
| 4 quote                   | `boardQuote`: `held` line, never missing; all-still $0.00                                           | 2      |
| 5 estimate                | same call, same shape; the plan line "HELD PHOTO · $0 · HELD 2S"                                    | 2, 7   |
| 6 admission               | never for a still; PR A's byte-equality fixture recorded from main                                  | 3      |
| 7 rowSignature            | untouched; `boardWorkSignature` is where the hold lives; the stitch reads the rows                  | 1, 5   |
| 8 runBoard                | sees no piece for a still                                                                           | 1, 3   |
| 9 day cap                 | no interaction — no preview exists to be unpriced                                                   | 3      |
| 10/11 stitch gate + order | `boardStitch(rows, …)` walks rows; Cut/Fade; fade-rule mirror via `timelineRefusal`; the tab's gate | 4      |
| 12 gaps + MAX_ROWS        | no line asked of a still; counts toward the cap                                                     | 1      |
| 13 row UI                 | thumbnail + hold chips + reorder/delete; Cut ↔ Fade pill; Hold mode on the strip; hidden CTA       | 5      |
| 14 planner                | `image` offered, ref required, rule 1, silent, `fitsKind` any photo                                 | 6      |
| 15 client agent           | `AgentItemKind`, `KIND_LABEL`, `seedRowsFrom(…, stillSec)`, `holdRefusal`, cap count                | 7      |

## Commits

1. `4b1c276` — the row (sites 1, 2, 3, 12). RC-C1b-1…4.
2. `f1db955` — the quote (site 4). RC-C1b-5.
3. `c4c4613` — admission (sites 6, 8, 9) + PR A's promise as a test. RC-C1b-6…8.
4. `be43b8c` — the stitch (sites 10, 11). RC-C1b-9…12.
5. `ddf9fe3` — the surface (site 13, site 7's answer). No renderer suite; tsc + lint; device pass is Adi's.
6. `f9fb9e1` — the planner (site 14). RC-C1b-13, 14; three tripwires re-pinned by name.
7. `5c6e5f9` — the Agent client (site 15). RC-C1b-15…17.
8. `eed6398` — docs (this ledger).
9. `6953b14` — the planner's ceiling, 120 s (found on device 1).
10. `803bde6` — a ref on b-roll refuses the plan (found on device 2, parser half). RC-C1b-18.
11. `6ef2ec1` — "Your product" is its own Board kind (found on device 2, Board half). RC-C1b-19, 20.
12. this docs update.

Every revert check is red by name in its commit message, measured with `--json`, one mutation at a
time, the file restored after each.

## A hardening gain independent of stills

PR A promised that the admission body is the preview ids of `boardRequests`, in order, admitted whole
before the first spend. Until commit 3 that was true by construction only. It is now a test:
`storyboardRun.test.ts` "a board without stills asks for exactly what it asked for before stills
existed" pins the requests JSON and the admit-then-spend log to bytes recorded from main at
`35a6ca2` by running main's own code on the same board.

## What the current tree fought (and where it was answered)

`boardRequests` unconditional (1) · `boardQuote` counting a still as missing (2) · `boardGaps`'s
prompt gap and `rowActionView` reusing it (1, 3) · asset-based `bridgeable` (1) · `boardStitch`
over pieces with `boardMade === 0` and the `settled && hasClips` gate (4) · `runBoardPieces`
refusing an empty list — kept; the CTA hides instead (5) · `seedRowsFrom` dropping photo-less
non-broll items — the ref requirement keeps `image` out of that branch (6, 7) · the `image` doc
comment claiming a stitch cannot join a still — rewritten, history kept (6) · `holdsWork` on the
quote key (5, ruling 1) · no admission byte-equality test (3).

## Found on device (22 Sep 2026) — three fixes riding this PR, one infra finding

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Commit                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1   | Two "Plan it" taps aborted at the planner's 30 s ceiling; a bare call to the same Gemini Pro model answered in 3.6 s. The b-roll flip set 30 s as "a ceiling, not a prediction" and asked the first real plans to measure it — they did. Default is 120 s now.                                                                                                                                                                                                                                                                                                                                                                             | `6953b14`                                                         |
| 2   | Shot 4 read "B-roll" with the earrings photo attached. The job row: one `object` reference to seedance i2v — a PRODUCT pick seeded by PR B's product → `broll` mapping, never reconciled with b-roll-t2v. A `broll` plan item can never carry a photo (parser + cast.test). Fix: the parser hard-refuses a ref on b-roll (`4ad6d31`/`803bde6`), and "Your product" is its own Board kind with the same bytes on the wire (`6ef2ec1`).                                                                                                                                                                                                      | 10, 11                                                            |
| 3   | Shot 2, a photo-less t2v b-roll with sound on, failed. Hypothesis was seedance t2v + audio. The job rows say otherwise: both seedance jobs of that run (one with an audio ask, one without) and two from three hours earlier all failed `OpenRouter /videos failed (403): Key limit exceeded (total limit)`. The adapter sends `generate_audio` only on seedance and only when sound is on, and seedance's token price is the same with or without audio, so the quote cannot move. No audio-stripping fix is justified by this evidence; whether seedance t2v honours `generate_audio: true` stays unmeasured until the key has headroom. | none — **the OpenRouter key's total limit needs raising** (infra) |

## Not in this PR

- A hold change after a stitch does not reset the stitched result on screen; the plan underneath is
  rebuilt live — the same as a prompt edit after a stitch today.
- The still's `direction` from the planner stays on the Agent screen; it does not ride the row
  (nothing is directed).
- No DDL, no new flag: the client rides the Studio flag, the planner half rides STUDIO_AGENT.

## Device check (Adi)

Board and Agent, iOS Simulator **and** phone-width Chrome, against a server built from this branch:

1. **Seed a plan with an image item.** Ask for something with a product close-up; the plan shows
   "HELD PHOTO · $0 · HELD 2S" with its beat; the estimate is the shots' sum; "Put it on the board"
   seeds a still row at 2 s.
2. **Hold chips on the Board.** 1·2·3·5·8 s on the still row; the head reads "PHOTO N · HELD Ns · $0";
   no line, pills, camera, sound or redo on it.
3. **All-still board stitches.** Strip → "Hold it as it is · $0" → tap two photos: no price panel, no
   "Make the board"; the stitch panel shows "Stitch these 2 clips" at once; the result plays each
   photo for its hold.
4. **Mixed board with a failed piece keeps the still.** A shot that fails is named "didn't make it";
   the still is in the video at its position.
5. **Hold-change triggers the back-to-plan confirm.** From a seeded board, change only a hold, tap
   "‹ Back to the plan": the inline confirm appears (untouched, it goes straight back).
6. **Redo on a generating row beside a still.** "Redo this shot" prices and runs that shot alone; the
   still row shows no button.
7. **Cut ↔ Fade beside a still.** The pill cycles; a 1 s still with fades both sides shows the server's
   sentence and Stitch is disabled; Cut on one side clears it.
