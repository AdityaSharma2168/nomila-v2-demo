# Captions + music for the stitch editor — ledger

Branch `studio/video-captions-music`, cut from main `599d127` (#539). One card, one PR, staggered
commits. Everything here is $0: a stitch is one ffmpeg call, captions are drawn on local CPU, and
nothing in this card reaches pricing, approval, or a provider. The runner's no-spend import-graph
walk (`stitchRunner.test.ts`) was green before and is green after, unchanged.

## What the brief asked for that the code would not take

| The brief                                  | What is true                                                                                                                                                                                                                                                                                         | What was built instead                                                                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Burn captions with `drawtext`/`subtitles`  | The ffmpeg on a developer Mac (Homebrew 9.0.1) is built without freetype/libass: **no `drawtext`, no `subtitles`, no `ass`.** `stitch.test.ts` drives the real binary, so a drawtext stitch reds the suite on the machine that runs it most. Her text in a filter graph is also an escaping problem. | The caption is drawn to a PNG (satori + sharp + Outfit, all already in `dependencies`) and ffmpeg gets `overlay` and an image path. Her words never reach an argv. |
| "Trigger the tab's re-preview / signature" | The stitch tab had none. The body is built from live state at tap time; the "preview" plays source clips.                                                                                                                                                                                            | The #538 class closed structurally (`TIMELINE_ITEM_FIELDS`), plus a signature for the one real gap: a finished result lingering under an edited timeline.          |
| "Keep the current default bed behaviour"   | There is none — absent means no music.                                                                                                                                                                                                                                                               | Track or None.                                                                                                                                                     |
| "Do not claim ducking works"               | It was already being claimed: `spec.ts`, `beds.ts` and the placeholder doc all said "ducked". Nothing has ever asked for ducking (D4).                                                                                                                                                               | All three corrected to FLAT, citing D4. A test pins that no `duck` is requested. D4 itself is untouched.                                                           |

## Decisions, with who made them

- **PNG overlay, not drawtext** — Adi, on the evidence above.
- **What a caption may say is what the font can draw.** Measured by rendering all 325 allowed code
  points in both weights: Latin with accents passes (Peña, Šarić, Łukasz); an emoji, CJK, and **29
  Latin Extended-A letters Outfit has no glyph for** draw as the same box. µ is refused because it
  uppercases to a Greek Μ the font lacks and one preset uppercases. The refusal says what IS allowed.
- **A split keeps the caption on BOTH halves** — Adi.
- **`bedLevel` low / medium / high** — Adi. A stated reversal of `spec.ts`'s "not a slider per
  stitch"; what survives is its point, no free number off the wire. Medium is never stored.
- **CC0-1.0 / PD only, per-track record with the date retrieved** — Adi.
- **The caption over the preview is the SERVER's band**, not a client `<Text>` — proposed during the
  build, accepted by Adi asking for it. The renderer shrinks text by measuring; a `<Text>` could not
  know the size it lands on.
- **Caption colours** (white / black / yellow / pink) — Adi, mid-build. Names, not hexes.
- **Drag-to-position — proposed, DROPPED** by Adi. Position stays top / middle / bottom.
- **Listening to a track before choosing it** — pulled INTO this card by Adi.

## "Matches what she saw" — exactly what is and is not claimed

- **Frozen spec → burned-in pixels: asserted.** The runner draws from the job row and nothing else;
  the bytes handed to ffmpeg equal the render of the stored caption (RC5).
- **Preview caption → burned-in caption: the same picture.** `POST /studio/stitch/caption-preview`
  returns the band from the function the runner uses; a route test asserts bytes and placement.
- **NOT claimed: pixel equality of the preview as a whole.** The player scales the source clip its
  own way. The caption is exact; the video under it is a preview.

## Defects the suite caught in this build's own work

1. Thirty W's ran to the last pixel column of the frame → long words now break.
2. The band is 3.6 fonts tall, so THREE lines fit it unclipped and four fill it edge to edge (ink on
   rows 4–255 of 256). The fit is now "two lines at this size", not "inside the band".
3. `indexOf("overlay=") < indexOf("xfade=")` passed with the overlay DELETED — `-1` is less than
   anything. Found by RC3.
4. The quote-matches-run fixture sat at `"bottom"`, the value the ignore-position mutation forces, so
   the mutation passed. Fixtures now sit off every default (top, boxed, yellow).
5. One revert-check run matched **0 tests** (two paths passed as one argument). Discarded, not
   counted as a pass.

## Revert checks — red BY NAME

| RC   | Mutation                                                       | Red                                                                                    |
| ---- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| RC1  | drop the caption-style allowlist check                         | 2 — `refuses an unknown caption style by name…`, `400s an unknown style or position…`  |
| RC2  | renderer ignores `style`                                       | 4 — three DIFFERENT pictures, boxed plate, uppercases, SHRINKS                         |
| RC2b | fit against the band's height instead of two lines             | 2 — SHRINKS, never clips the worst case                                                |
| RC3  | drop the overlay node                                          | 4 — INSIDE the band, fades WITH its clip, inputs AFTER the clips, BEFORE the join      |
| RC4  | drop the `settb` re-pin after overlay                          | **0 of 45 → the line was DELETED**, see below                                          |
| RC5a | `toStitchRequest` drops the overlay                            | 3 — incl. **`stitches the caption that was queued, not a live one`**                   |
| RC5b | no-band guard removed AND overlays omitted                     | 3 — same                                                                               |
| RC5c | runner ignores the stored position / style / text              | 2 / 1 / 1 — the named test every time                                                  |
| RC6  | list a bed with no provenance                                  | 3                                                                                      |
| RC7  | drop `bedLevel` at the request                                 | 1 — `reaches the engine as the gain its NAME stands for`                               |
| RC7b | move medium off 0.25                                           | 1 — `medium IS the engine's own default`                                               |
| RC8  | classify `caption` as a local field                            | 6 — `reaches the body as her words and two names` + five signature cases               |
| RC9  | renderer ignores colour / runner drops it / parser accepts any | 3 / 1 (the named quote-matches-run test) / 1                                           |
| RC10 | build the bed's object path from the request                   | 2 — `signs the product's OWN object…`, `404s anything that is not a NAME on the list…` |

Compile guard, demonstrated once: an unclassified field on `TimelineItem` is TS1360 under
`check:types` and TS2741 on the test's `Required<TimelineItem>` under `tsconfig.jest.json`.

## Known unknowns — read before the flip

- **ffmpeg 5.1 (the deployed Debian image) has never run the captioned graph.** RC4 removed a
  `settb` after `overlay` because nothing could tell it was there on 9.0.1. The guard is
  `stitch.test.ts` › _survives a cut FOLLOWED BY a crossfade, with a bed, every clip captioned_, and
  CI runs a different build from the Mac. **Dev acceptance, once deployed: a timeline with a cut
  then a crossfade, a caption on every clip, and a track.** If it fails there with a timebase
  error, the fix is one token in `plan.ts` and that test is its proof.
- **No full listen for sampled material is confirmed** for five of the SIX tracks (corrected — this
  line said "three", written before the second batch; `only-human` has Adi's listen on record); the record says so and
  the flip checklist gates the prod upload on it.
- **The licence text was read through a page-summarising fetch**, not raw HTML. Adi had each page
  open when downloading.
- **A bottom caption sits over Chrome's native video controls** in the preview. Left as is; the
  controls fade.
- **Track audition is at the track's own volume**, not the chosen level — deliberate.
- **D4 stands:** the bed is mixed flat. With silent clips that is inaudible; it is the first thing
  to fix if clip audio is turned on.

## Next card (Adi, 2026-09-20)

**Use the sound from one of her own videos as the bed** — replaces the "mood tags + larger library"
idea, which is dropped. Read of the code: it needs no schema change if the source is an existing
VIDEO asset (`bedAssetId` XOR `bed`; the athlete-scoped `resolveClips`; materialized like a clip;
ffmpeg takes its audio stream; `probeHasAudio` already refuses a silent file). A pure audio upload
is NOT possible in this lane: `UPLOAD_LIMITS` admits image and `video/mp4|quicktime` only and
`media_assets` has no AUDIO type — shared code. Open call for Adi and Mia: her own upload can carry
copyrighted music into a brand deliverable; at minimum the picker says "only use sound you have the
rights to."

Out of this branch by Adi's call: the storyboard uploads-strip fix (first page only) — its own PR.
