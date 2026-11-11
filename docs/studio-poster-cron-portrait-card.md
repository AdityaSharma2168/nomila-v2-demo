# Card — the poster cron squashes every portrait upload to 608×1080

**Status:** REAL, **measured**, unfixed. **Shared code** (`server/services/videoPoster.ts`), so it is
**Mia's**; Adi is flagging it to her directly. Found 21 Sep 2026 during the still-clips recon.
Nothing here was changed.

## What happens

The media-poster cron (every 5 min, 3 rows per batch) makes a poster for each posterless uploaded
**or generated** VIDEO row. It then tries a best-effort "1080p" transcode and, if that succeeds,
**repoints `gcs_path` at the transcode** (`videoPoster.ts:146-153`).

The downscale decision is written for landscape (`videoPoster.ts:133-135`):

```ts
const needsDownscale = (row.width ?? 0) > 1920 || (row.height ?? 0) > 1080;
const vf = needsDownscale ? ["-vf", "scale=1920:1080:force_original_aspect_ratio=decrease"] : [];
```

- A **portrait** 1080×1920 upload has `height` 1920 > 1080, so it is "downscaled" into a 1920×1080
  box.
- `force_original_aspect_ratio=decrease` fits it to that box's **height**, giving **608×1080**.
- The row's `width`/`height` come from the client's picker at upload
  (`routes/media.ts:394-395`), so every phone upload of a vertical video has them.

## Measured (21 Sep 2026, ffmpeg 9.0.1, $0)

`videoPoster.ts:136-141`'s exact argv, on a 1080×1920 source:

```
ffmpeg -i portrait.mp4 -vf scale=1920:1080:force_original_aspect_ratio=decrease \
  -c:v libx264 -crf 23 -preset veryfast -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 128k -f mp4 out.mp4
→ exit 0, out.mp4 is 608×1080
```

It is not an error: it succeeds, so the row is repointed at a file with **31% of the pixels** of the
original.

## Why it matters

- **Every portrait video she uploads is her main upload shape**, and after the cron runs each one is
  608×1080 in her library.
- **Every stitch then upscales it 1.78×** back to 1080×1920 (the engine conforms to the target,
  `server/studio/video/plan.ts` videoNormalizeChain), so each portrait clip in every stitched video is
  visibly soft. The stitch cannot tell: it only sees the repointed file.
- **The row lies.** `width`/`height` still say 1080×1920 — the transcode's UPDATE sets `gcs_path`,
  `content_type`, `bytes` and `metadata`, never the dimensions.
- **Generated clips escape** only because the video adapters record no width/height
  (`videoRunner.ts:421-422` passes `asset.width ?? null`). `needsDownscale` is false, so they are
  re-encoded at native size.

## The fix is small — for Mia to make and verify

1. **Decide by the long and short edges, not by landscape axes:** downscale only when
   `max(w, h) > 1920 || min(w, h) > 1080`.
2. **Fit into a box that keeps orientation:**
   `scale=1920:1920:force_original_aspect_ratio=decrease:force_divisible_by=2`.
   - 3840×2160 → 1920×1080.
   - 2160×3840 → 1080×1920.
   - 1080×1920 is untouched (and with the edge test in step 1 it is not re-scaled at all).

   The flag names are ffmpeg's. They need checking on prod's Debian ffmpeg 5.1 before shipping.
3. **Write the transcode's real dimensions** onto the row in the same UPDATE.

## The damage is recoverable

The original is **kept**. The UPDATE stores it as `metadata.original_gcs_path`, and nothing in
`processOneVideo` deletes it. A backfill can repoint each squashed row at its original, or
re-transcode from it once the fix is in.

A read-only count, **one athlete** (hers), aggregate only — for Adi to run, not Claude:

```sql
SELECT count(*) AS squashed
FROM media_assets
WHERE athlete_id = :athlete_id
  AND media_type = 'VIDEO'
  AND metadata ? 'original_gcs_path'
  AND height > width
  AND height > 1080;
```

It counts rows the cron repointed whose recorded shape is portrait and taller than 1080 — every one
of which was squashed.
