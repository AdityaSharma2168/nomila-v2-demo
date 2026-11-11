# Card — a video with no poster was set down by enrichment for good

**Status (21 Sep 2026):** ROOT CAUSE MEASURED · the fix SHIPPED in #549 (`987cae0`, the enrichment
gate) · the ONE-TIME statement for existing rows was RUN the same day, 4 rows (below) · the
record-time poster is a separate card (below). Owned by Studio — this is no longer a hand-off to Mia.
Replaces card 1 of `docs/studio-agent-open-cards.md`, which framed it as an upload-only defect for
Mia to schedule and now points here.

---

## What happened

Enrichment reads `thumb ?? path` (`server/services/mediaEnrichment.ts`). A video lands with no poster
— `gcs_thumb_path` is null until the media-poster cron cuts one (`services/videoPoster.ts`, every
5 min, 3 rows a batch) — so for a posterless video `thumb ?? path` is the **mp4**. Neither the vision
tagger nor the image embedder can read it, so both halves failed on every pass.

The enrichment cron (`/api/internal/media-enrich-cron`, every 15 min on the quarter-hour) loops
`enrichNextChunk` up to **60 times inside one request**, stopping only when nothing remains or after
160 s, and each pass re-reads the candidate list. A row that fails deterministically therefore burns
attempts 1 → 10 in consecutive passes of **one request** and is set down (`abandoned_at`, reason
`attempts`) before that request returns. `tick` in that handler is a loop variable, not a cron
firing. From then on the row is skipped for good, including after its poster lands and it would
enrich perfectly.

**It is not only uploads.** Generated clips land posterless too — `writeGeneratedThumbnail` returns
null for VIDEO (`studio/thumbnail.ts`), and the poster cron covers origin `upload` AND `generated`.
Her library holds 33 video rows (31 generated, 2 uploads) and 4 are abandoned, so at least 2 of the 4
are clips made in Studio. Every clip the Board makes was racing this.

## Evidence

Read-only, one athlete, 2026-09-21. One row per abandoned video:

| upload → abandoned | window crosses a quarter-hour | abandoned, seconds past the quarter-hour | her uploads in the window |
| -----------------: | :---------------------------: | ---------------------------------------: | ------------------------: |
|               61 s |              no               |                                     64 s |                         0 |
|               61 s |              no               |                                     74 s |                         0 |
|              109 s |              yes              |                                     70 s |                         0 |
|              182 s |              yes              |                                     70 s |                         0 |

All 4 rows spent their 10 attempts 61–182 s after being written, and each was set down 64–74 s after
a quarter-hour mark, which is the enrichment cron's schedule. None of her uploads landed in any of
those windows. Ten separate cron firings would need at least 135 min, and the per-upload kick is
ruled out. It was one request's loop. Two rows were written 3 s and 13 s after the quarter-hour,
while that request was already running; each pass re-reads the candidates, so a row that lands
mid-request is taken by it.

(The coverage that preceded this: 364 stored images, 0 abandoned; 33 videos, 4 abandoned, all for
`attempts`; nothing oversize, nothing mid-backoff.)

## The fix, shipped in this PR — the enrichment gate

One clause on the candidate predicate (`UNENRICHED`): **a row whose stored bytes are a video and
which has no poster is not a candidate yet.**

```sql
AND (gcs_thumb_path IS NOT NULL OR coalesce(content_type, '') NOT LIKE 'video/%')
```

It is not tried, counts no attempt and is not in `remaining`. The first pass after the poster cron
cuts its poster enriches it from a real image. Attempts no longer burn on a missing poster, for
uploads and generated clips alike.

**Keyed on `content_type`, not `media_type` — deliberately.** The rule was that the gate may only
DEFER rows, never block anything that is a candidate today. A synced Instagram VIDEO/REELS row
stores its still in `gcs_path` with `gcs_thumb_path` null (`skills/rehostAthleteMedia.ts`), enriches
fine today, and the poster cron never visits origin `connected`. A
`media_type <> 'VIDEO' OR gcs_thumb_path IS NOT NULL` gate would have retired every one of those for
good; a test pins that it does not (and reds, by name, when the gate is written that way).

## Existing rows — the one-time statement

The gate stops new abandonments; it does not revive old ones. `docs/queries-video-enrichment-unabandon.sql`
does, for one athlete, on exactly this predicate:

```
abandoned_at IS NOT NULL  AND  media_type = 'VIDEO'  AND  gcs_thumb_path IS NOT NULL
```

It removes the whole `enrichment` bookkeeping key (attempts, abandoned_at and the rest) — what
`enrichRows` does itself when a row finally succeeds — and leaves `vision`/`embedding` alone. Two
runs: without `-v confirm` it prints the count and rolls back; with `-v confirm=<that count>` it
applies, and commits only if exactly that many rows changed. A row still without a poster stays
abandoned, and the same statement catches it after its poster lands.

**Run:** 2026-09-21, by Adi, by hand through the proxy. Dry count 4; applied with `confirm=4`;
`COMMITTED. Rows un-abandoned: 4`. The 4 are the abandoned videos in the evidence table — they now
have posters and are ordinary candidates again, enriched from the poster by the next cron pass.

## Carded, not built — a poster written when the clip is recorded

The idea: cut frame 1 in the recording path so a generated clip is enrichable and thumbnailed at
once, instead of waiting up to five minutes for the poster cron.

**Ordering — the race it was meant to close.** `recordGeneratedAsset` (`studio/jobs.ts`) calls
`writeGeneratedThumbnail` BEFORE its INSERT and writes the result into the row. A poster made there
would exist before the row does, so enrichment could never see the clip posterless: the race would
be closed by construction, and a failed extraction would fall back to the gate above. The ordering is
not the problem.

**Why it was stopped.** The poster cron does two more things for a generated clip, and it selects its
work on `gcs_thumb_path IS NULL`. A poster written at record time would make the cron skip the row,
silently dropping both:

1. **The measured duration.** The runner records only the provider's asserted `durationSeconds`
   (`studio/videoRunner.ts`); `duration_seconds_precise` — what the timeline does arithmetic with —
   comes from the cron's ffprobe (`videoPoster.ts`, step 0).
2. **The 1080p / faststart transcode** (step 2), which repoints `gcs_path`.

Doing it properly means carrying the ffprobe into the recording path and deciding whether a
generated clip needs the transcode, or changing the shared cron's selector. With the gate in place it
buys speed, not correctness — its own card.

Also true, and not changed by either path: a STITCHED output is published by
`publishStitchOutput` (`studio/video/materialize.ts`), not `recordGeneratedAsset`, so a record-time
poster would not have covered it. The gate does.

## Left for Mia — note only

Neither caller spaces attempts in time — not the cron's in-request loop, and not the per-upload kick
(`routes/media.ts`), which fires `enrichNextChunk` on every upload with no backoff. So 10
back-to-back attempts are legal for any failure cause. The gate removes the only cause observed;
time-based backoff is the general fix if a new failure mode appears.

The module's docstring still describes `reEmbed` as the way back for a row set down "for a reason
that later stops applying (a thumbnail arriving…)". No production path sets `reEmbed`, and it would
re-embed the whole library if one did. The one-time statement above is the way back.
