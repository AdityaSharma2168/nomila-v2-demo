# Her own sound, the sound lane, and muting — ledger

Branch `studio/video-bed-from-video`, on main `1ceabee` (#540, captions + music). One card, one PR.
Everything here is $0 and nothing reaches pricing, approval or a provider; the runner's no-spend
import-graph walk is green and unchanged. Baseline: main `1ceabee` is tree-identical to the tip gated
for #540 — 386 suites / 7315 tests / 0 red.

## What she gets

- **The sound from one of her own videos** under a stitch, instead of a curated track — picked from
  her library or uploaded on the spot (the app's own upload, rights acknowledgment included).
- **A sound lane** under the clip track showing what plays underneath. Drag it sideways to choose
  where in the sound the video starts.
- **The music is audible in the preview**, not only in the finished video.
- **Mute** a clip's own sound, or the music (kept and cropped, but left out).

## Decisions, with who made them

- **Separate PR from captions + music** — Adi. One PR per card.
- **`bedAssetId` XOR `bed`**, both is a 400 — the plan Adi approved.
- **A video with no sound FAILS the job with a sentence; a curated track going missing still
  downgrades silently** — Adi ("go" on the plan that asked). Hers is a pick; ours is our fault.
- **Rights line, verbatim** — Adi: "Use sound you own or have permission to use — music from other
  artists can get posts taken down."
- **The lane + cropping** — added by Adi mid-card. The only crop is the START: a bed always ends
  with the video and loops if shorter.
- **Music in the preview, and muting** — asked for by Adi from the device pass.
- **Mood tags and a larger track library — DROPPED** by Adi in favour of this card.

## Three things I said that were wrong, and what is true

1. **"Input `-ss` on a looped bed loops only the tail."** True straight to an encoder; FALSE inside
   the engine's filter graph on ffmpeg 9.0.1, where `-ss` and `atrim` sound identical (both wrap to
   the top). Found by revert check: the forms were swapped and the real-ffmpeg test stayed green.
   `atrim` is kept because its meaning is defined by the filter, not by how a demuxer combines a seek
   with a loop — a behaviour that already differs by context on one build is not one to bet on
   across builds. `plan.test.ts` holds the FORM; `stitch.test.ts` holds the BEHAVIOUR.
2. **"A clip used as the sound will only double if clip audio is ever turned on."** Clip audio IS
   on: `plan.ts` mixes a clip's own audio whenever its file has an audio track, and her UPLOADS do.
   Only Studio-generated clips are silent. A video that is both on the timeline and the sound plays
   its audio twice today. Muting the clip is the fix, and is why mute shipped in this card.
3. **"440 Hz is silent under a bed."** The 220 Hz fixture bed's second harmonic sits at 440 Hz
   (−42.5 dB measured). The assertion is now a comparison of the same stitch muted and unmuted.

## Defects revert checks caught in this build's own tests

- The quote-matches-run test seeded the timeline's clip and the first sound video from the SAME
  fixture, so handing ffmpeg the clip's file as the sound had the right bytes and passed. Three
  distinct files now, plus an assertion that the sound is not the clip's path. (Second time this
  card family: a fixture must never sit at the value a mutation forces.)
- An assertion carried a `.replace()` that did nothing. Removed.

## Revert checks — red BY NAME

| RC   | Mutation                                            | Red                                                                                               |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| RC1  | drop the `bed` + `bedAssetId` both-set check        | `refuses a track AND a video's sound together, rather than picking one`                           |
| RC1b | drop the throw when her sound has no file           | `THROWS when the engine's request is built without her sound — never a silent downgrade`          |
| RC2  | charge her video at the curated bed's 25 MB ceiling | `charges her video its REAL bytes, not the curated bed's 25 MB ceiling`                           |
| RC2b | her sound video never resolved                      | 6 — incl. both tenancy tests (runner and route)                                                   |
| RC3  | hand ffmpeg a different file                        | **`lays the sound from the video on the job row, not a live one`** (after the fixture fix)        |
| RC3b | skip the audio probe                                | `fails with a sentence when the video has no sound — never a quiet stitch without it`             |
| RC4  | listen route looks the video up WITHOUT the athlete | `404s another athlete's video exactly as it 404s one that does not exist, and signs nothing` (+1) |
| RC5  | swap `atrim` for input `-ss`                        | 1 — the planner test only; the real-ffmpeg test stays green, see above                            |
| RC5b | drop `bedStartSec` at the request                   | `reaches the engine for a curated track AND for her own video`                                    |
| RC6  | stop emitting `bedAssetId`                          | 2                                                                                                 |
| RC7  | flip the drag's sign                                | 4 — first among them `starts it LATER when dragged left`                                          |
| RC8  | drop the wrap in `soundOffsetAt`                    | `WRAPS TO THE TOP when the sound runs out — the rule the stitch itself follows`                   |
| RC9  | engine ignores `muted`                              | 4 — incl. the real-ffmpeg `drops THAT clip's sound and keeps its picture…`                        |

Compile guard, exercised for real this time: adding `muted` to `TimelineItem` without classifying it
in `TIMELINE_ITEM_FIELDS` failed with TS1360 until it was marked `"wire"`.

## Tenancy, in one place

Her sound video is the only new thing here that reads her data. It goes through `resolveTimeline` →
`resolveClips` with the athlete off the REQUEST at both routes (queue, listen) and OFF THE CLAIMED
ROW in the runner. Another athlete's video and one that does not exist get one answer at all three.
Nothing is signed that did not come off her own row. The log says `bed: "own-video"` — never which.

## Known unknowns

- **The preview's music is a preview of WHICH sound and WHERE in it, not of the mix.** It plays at
  the player's volume rather than the Quiet/Medium/Loud gain, and syncs when playback starts rather
  than sample-locking.
- **Not verified by me by ear or eye** — all UI here was confirmed by Adi on phone-width Chrome.
- **Her own upload can carry copyrighted music into a brand deliverable.** The rights line is shown
  where the choice is made and the app's one-time rights acknowledgment gates the upload; whether
  that is enough is a product/legal call for Adi and Mia.
- **Pre-existing, not changed here:** the queue route calls `assertTimelineFits` without `withBed`,
  so a CURATED bed's 25 MB is budgeted only in the runner. Harmless in practice (the runner
  re-checks before any bytes move); worth a line in a future card.
- **D4 stands:** the bed is mixed flat. With muting, she now has a manual answer to "the music
  fights my clip's sound"; ducking is still not built.
- **Still open from #540:** the deployed image's ffmpeg 5.1 has never run these graphs.

## Not in this card

- **Bare audio upload (.mp3/.m4a):** not possible in this lane — `UPLOAD_LIMITS` admits image and
  `video/mp4|quicktime` only and `media_assets` has no AUDIO type. Shared code; a proposal for Mia.
- **An end point or fade-out for the sound.** The bed ends with the video by construction.
- **Posting to Instagram / TikTok, and saving a timeline draft** — reconned 2026-09-20, separate
  cards. Short version: `content_posts` and the cron rails exist; nothing writes the table, there is
  no publishing code, and neither platform's PUBLISH scope is requested.
