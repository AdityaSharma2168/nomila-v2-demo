# Studio — stills in videos (PR C1): plan, decisions and ledger

Branch `studio/still-clips`, off `f8e8a25` (#551). Written 21 Sep 2026. A photo can be placed in a
video as a **held still** ("show this for N seconds") at **$0**: no preview row, no quote, no
admission, no day-cap interaction. The stitch route stays spend-free.

This PR is the stitch path and the Video tab. The Board/Agent half is **C1b**, a fast-follow PR, and
it is gated on the prod-ffmpeg check (flip checklist §11). *(21 Sep 2026: §11 passed and C1b is built —
`docs/plans/studio-still-board.md`.)*

---

## Decisions (Adi, 21 Sep 2026)

| # | Decision | Why |
|---|---|---|
| 1 | The wire is `{ assetId, stillSec }` on the existing position, not `{ imageAssetId, durationS }` | A flag on the position inherits the clip cap, the timeline cap, captions, crossfades, the #538 field table and the stale-result signature, on both sides, for nothing. `Sec` is the house suffix. |
| 2 | The picker is a new `GET /studio/stitch/stills`, not `useMyMedia` | Reusing `/me/media` inherits three defects: the page of 24 nobody advances (open-cards card 3), NULLS-LAST ordering that sinks photos made in Studio, and HEIC offered then refused. |
| 3 | The Board/Agent still rows are **C1b**, a separate PR | 15 sites assume "a row makes a preview"; items 4/5/6/10/11 rewrite the quote → approve → admit path PRs A and B hardened. That earns the independent-revert exception to one-PR-per-card. |
| 4 | Bounds are 1–8 s, default 2 s; the fades on either side of a still must add up to less than its hold; all validated in `parseStitchSpec`; served through `stitchLimits()` | The fade rule answers the engine's "does not fit" throw at the door with a sentence, instead of the runner's generic failure. |
| 5 | The t2v b-roll probe is cancelled — Adi ran it himself | See `docs/studio-broll-t2v-decision.md`. The follow-up is its own small PR, after C1 and before C1b (`docs/studio-broll-t2v-card.md`). |

## Design

**Server.** A position with `stillSec` resolves through `studio/photoPredicate.ts` (extracted
verbatim from the caster: hers · stored · not deleted · top-level · a photograph), plus
`STILL_CONTENT_TYPES` (jpeg/png/webp). The photo and video predicates are disjoint by media type, so
a photo is never joined as a clip, and a video is never held as a still.

- **Charged:** the hold, exactly, in both time bounds. The photo's bytes, or the image cap when the
  size is unknown. Per position, `stillWorkBytes` (the prepared frame plus the encoded clip), in the
  source budget at the door and again in the download re-check.
- **The runner** (`studio/video/still.ts`) turns each still position into an mp4 before the engine
  runs:
  - sharp bakes EXIF orientation and fits the photo inside the target (never enlarging);
  - one ffmpeg `-loop 1` encode follows, for exactly the hold, at the target's size and rate, with
    limited range, BT.709 and no audio track.
- **The engine is unchanged.** It gets one more local mp4 at that position. The encodes spend from the
  engine's own ffmpeg budget, because the lease is exactly ffmpeg plus two transfers, with no slack.

**Client.**
- `TimelineItem.stillSec` is classified "wire" in the #538 table.
- `addStill` and `setStillSec` exist; the latter is clamped to the served bounds.
- A still is never trimmed, split, muted or bridged. The setters refuse each of those and `normalize`
  strips them.
- `timelineRefusal` mirrors the fade rule.
- The Video tab gains a photo strip, stills on the track at their hold, hold chips (1·2·3·5·8 s) and a
  Cut ↔ Fade join beside a still.
- The preview shows the held photo on the player's dark inset instead of loading a JPEG as a video.

## Measured — ffmpeg 9.0.1 on the laptop, $0, 21 Sep 2026, through the real `stitch()`

| Finding | Number | Consequence |
|---|---|---|
| The engine conforms every input in one graph (no concat demuxer) | `plan.ts` videoNormalizeChain | Size, SAR, fps and pixel format cannot glitch a join. |
| A looped JPEG encodes **full-range** (`yuvj420p`, pc) even with `format=yuv420p -pix_fmt yuv420p` | — | — |
| Placed after an untagged clip, that one still flipped the **whole stitched output** full-range | every segment | Encode with `out_range=tv` and `-color_range tv`. |
| Colour matrix: a default BT.601 still next to BT.709 clips | off by up to 6/255; explicit BT.709 ≤ 3 | Encode with `out_color_matrix=bt709` and the tags. |
| ffmpeg 9.0.1 applies JPEG EXIF orientation itself; prod is Debian 5.1, **not measured** | — | sharp `.rotate()` bakes it in, so the build does not matter. |
| A 24 MP photo looped for 8 s | 35 s to encode; fitted to 1080×1920 first, 1.9 s | The fit is load-bearing (12 stills would approach the 10-min budget). |
| The encoded still: 1080×1920, SAR 1, 30 fps, yuv420p, tv, BT.709, exact duration (2.5 s = 75 frames) | 7 KB–776 KB, 0.14–1.98 s | The engine's manifest shows all normalization flags false. |
| A still with no audio beside a clip that sounds | the engine synthesizes silence | No silent track is needed. |
| Mixed stitch: 720p/24 fps clip with audio, landscape still, 24 MP still, 1080p clip, cuts and crossfades | expected 15.5 s = actual 15.5 s | — |
| sharp 0.34.5's HEIF input | `.avif` only | HEIC is refused by name at the door. |

## Commits

1. `9dd3acd` — the photo predicate, extracted into a module that cannot spend.
2. `dbe9282` — `stillSec` in the spec: bounds, refusals, the fade rule, served limits.
3. `3cf670f` — stills resolved through the predicate and charged what they will write.
4. `a76069e` — the runner encodes each still; the encodes share the engine's budget.
5. `dc3ad67` — `GET /studio/stitch/stills` + `useStitchStills`.
6. `d7e7e59` — client logic: the wire field, setters, refusals, the fade mirror.
7. `8e3f5ac` — the Video tab UI.
8. this docs commit.

Every behavioural commit carries its revert checks, red by name, in its message.

## Found while building — carded, not fixed here

- **The poster cron squashes portrait uploads to 608×1080.** See `docs/studio-poster-cron-portrait-card.md`.
  Shared code (`services/videoPoster.ts`), so it is Mia's; Adi is flagging it directly.
- **A bridge beside a photo-less Board row stalls the Board's price forever.** `setBridge` does not
  check `assetId`, so no bridge request is built, no quote arrives, and `boardQuote` counts it as
  missing. Studio code, but outside this PR. It rides the b-roll-t2v PR, which makes photo-less rows
  common (`docs/studio-broll-t2v-card.md` §4).
- **HEIC photos cannot be stills.** The door refuses them by name. The durable fix is converting HEIC
  at ingest (`routes/media.ts`, shared) or a HEIF-capable sharp build — a dependency decision. Its own
  card, if anyone asks for it.
- **The quote and the run re-derive the route separately** (`generate.ts` calls `previewGeneration`
  again). An env change between them can run a cheaper or equal model than the one quoted; the stored
  `routedModel` decides nothing. It is pre-existing and noted in the t2v card.

## Device check (Adi)

Video tab, iOS Simulator **and** phone-width Chrome, against a server built from this branch:

1. **Add a still:** "Your photos" lists her photos, newest first, including one made in Studio. A tap
   puts it on the track at 2 s, shows the photo in the preview (not a black player), and the row says
   "Photo · 2s".
2. **Hold chips:** select the still. 1·2·3·5·8 s chips appear; each tap changes the tile's width and
   the totals line; there are no trim handles on the tile.
3. **Caption on a still:** type a caption with the still selected. The band draws over the photo in the
   preview and is burned into the stitched video.
4. **Crossfade in and out:** the join pill beside a still cycles Cut → Fade → Cut, never Bridge. A 1 s
   still with fades on both sides shows the refusal sentence and Stitch is disabled; at 2 s it clears.
5. **Trim and split refused:** Split is disabled with the still selected; no mute icon on its row.
6. **One mixed stitch with a real clip:** a real clip with sound, a still with a fade in, another real
   clip. The result plays through the still without a colour or level jump, the clip audio is intact,
   and the still is silent (or has the music under it).
