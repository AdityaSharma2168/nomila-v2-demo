# V7 layer 4 — three display fixes: predictions

Written before the diff. Three problems, and the recon's headline is that they have **three
different causes** rather than the one shared cause the symptoms suggested.

---

## What recon established

| symptom                        | actual cause                                                                                                                                       | file                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| result/preview player enormous | `width: "100%"` + `aspectRatio`, no ceiling. 9:16 in a 358 pt column is 358 × 636                                                                  | `ClipPlayer.tsx`                    |
| blank filmstrip tiles          | `gcs_thumb_path` NULL — the poster cron is **not registered in-process at all**, and every in-process cron is gated on `NODE_ENV === "production"` | `server/index.ts`, `videoPoster.ts` |
| library video unwatchable      | `MediaDetailScreen` **has no player**. The play glyph is a `<View>` with no `onPress`; zero `VideoView` / `useVideoPlayer` in the file             | `MediaDetailScreen.tsx`             |
| "Processing" badge             | `!item.enriched`, i.e. `metadata.vision` is null — **the vision agent, not the poster**                                                            | `MediaLibraryView.tsx:264`          |

The last one is left alone: accurate, outside the Studio surface, and not this task.

---

## Fix 2 — the first-frame fallback, and why it is not only a local workaround

Framing it as "the cron does not run on a laptop" undersells it. **The same gap exists in
production**: `gcs_thumb_path` is NULL from the moment an upload lands until the poster cron next
fires, which is minutes. Every freshly-uploaded clip is a blank tile in that window, on every
device. A client-side first frame closes the window everywhere; locally it simply never closes on
its own.

**Scoped to the Studio clips strip and the MediaDetail preview. NOT the library grid.** A grid
decodes one video per tile across a long list, which is the exact cost a poster exists to avoid.
The grid stays poster-reliant: blank locally, postered in production. That is honest rather than
uniform, and uniformity here would be the expensive kind.

### Predictions

1. **A paused player is not a still, and the difference will show.** `expo-video` renders nothing
   until the first frame is decoded, so a poster-less tile is blank-then-frame, not instant. I
   predict the fallback needs its own placeholder underneath for that gap, and that the placeholder
   is what most tiles show on a cold library.
2. **It must never autoplay and never make noise.** Muted at construction, paused, `nativeControls`
   off. A strip of ten tiles that all start playing is worse than ten blank ones.
3. **The choice must be made on `thumb_url`, not on `media_type`.** An Instagram clip arrives with
   a stored still and needs no decode; only a poster-less video does. Keying on "is a video" would
   decode tiles that already have an image.
4. **`ClipPoster` and `ClipPlayer` must stay separate components.** They look similar and are
   opposites: one is a still that must not play, the other is a player that must. Merging them
   behind a flag is how the strip ends up autoplaying.

## Fix 3 — the media-library player

Reuse `ClipPlayer` with the new cap. The play button becomes real; the poster stays as the still
until it is pressed.

5. **Press-to-play rather than an inline player**, because the preview box is also the IMAGE
   preview and a player mounted for every asset would decode a video on a screen that is usually
   showing a photo.
6. **The revert check is the `onPress`.** A mutation removing it must red — which means the test
   cannot assert on rendering alone, since the decorative button rendered identically for months.
   I predict the pressable and its state transition have to be reachable from a test, so the
   "should this be a player" decision moves into a pure seam the screen calls.
7. **`video_url` is the source, not `url`.** `routes/media.ts` sets `video_url` only when we hold
   real mp4 bytes; `url` for a video may be a still. Playing `url` would hand the player an image.

---

## The `duration_seconds` NULL question — REAL, not cosmetic, and NOT fixed here

Asked whether an unknown duration can miscount the 3:00 cap. **It can, and it under-counts, which
is the dangerous direction.**

`effectiveSeconds` charges an unknown duration at `bytes ÷ videoBytesPerSecond()` — dividing SOURCE
bytes by the OUTPUT bitrate (2 MiB/s). Those are not the same quantity, and for any source encoded
below the output rate the result is too small:

> A 200 MB upload at 3 Mbps — an ordinary re-encoded clip — is **555 seconds** long.
> It is counted as 200 ÷ 2 = **100 seconds**, so it passes the 180 s cap as a single clip.
> Its output is ≈ 555 × 2 MiB = **1.1 GiB**, against a 360 MiB reservation in a 1 GiB workspace.

One clip is enough. The file's own comment claims "over-estimating is the safe direction", which is
true of the byte budget and false of this line.

**Two candidate fixes, and the better one is out of this task's fence:**

- **Exact, in the runner.** Every clip is already probed by ffprobe after download; summing the
  real durations before the encode is exact, local and $0. The door's estimate stays as a cheap
  pre-filter. This is the right fix and it lands in `stitchRunner.ts`, which this task fences off.
- **Conservative, in the estimate.** Divide by an assumed SOURCE floor (~0.25 MiB/s) instead of the
  output rate, so an unknown duration over-estimates. One constant, one divisor — but it refuses
  large unknown-duration clips outright, including ones that would have been fine.

Not built either way: both are server changes to the stitch pipeline, and the brief for this round
is client rendering. Flagged for a decision rather than actioned.
