# A video's real length — migration 0058 and the probes that fill it

Video V8, server side. The client half (the timeline editor, its own decoder) is a separate
checkpoint and is not described here.

## The problem

`media_assets.duration_seconds` is an `integer`, and it was only ever populated when the OS upload
picker sent one. Two consequences, both silent:

- **Most video rows had no duration at all.** Anything that did not arrive through the picker —
  Studio output, a stitch, an Instagram top-performer mp4 — had `NULL`. `video/materialize.ts`
  then charged those clips at `bytes ÷ output-bitrate`, which under-counts by whatever the source
  bitrate happens to be: a 200 MB upload at 3 Mbps is 555 s of video counted as 100.
- **The fraction that did arrive was thrown away.** The client sends `asset.duration / 1000`, a
  real fraction. `routes/media.ts` rounded it on the way in because the column could hold nothing
  else.

## The shape of the fix

A second column, `duration_seconds_precise double precision` (migration 0058), rather than widening
`duration_seconds` in place. 0058's own header carries the full argument; the short version is that
`checkSchemaDrift.ts` compares **names only** and never looks at a type, so a failed `ALTER … TYPE`
would pass the deploy gate clean and then round every fraction written to it — whereas a missing
additive column fails the gate loudly, which is exactly what that gate is for.

**One provenance per column, and they are never backfilled from each other.**

| Column | Means | Written by |
|---|---|---|
| `duration_seconds` (int) | what the picker **asserted**, rounded | `routes/media.ts`, `publishStitchOutput` — unchanged by this work |
| `duration_seconds_precise` (float8) | what ffprobe **measured** | the upload probe, the stitch write-back, the poster-cron rider |

"Measured beats asserted" is honoured on the **read** side, not by overwriting the old column:
`resolveClips` returns `row.duration_seconds_precise ?? row.duration_seconds`, and `GET /media`
serves both keys so the client can tell the two apart.

## Where the measurement comes from

Three writers, no backfill script — the probeable backlog was **8 rows / 15 MB**, which the riders
drain on their own.

1. **Upload** (`routes/media.ts`) — ffprobe range-reads the container header over the signed URL; it
   does not download the clip. **Fails open**, which is deliberately the opposite of the image
   branch beside it: a photo that cannot be straightened is *refused* because storing it is the bug
   that code prevents, whereas a clip whose length cannot be read is a perfectly good clip missing a
   number.
2. **Stitch** (`publishStitchOutput`) — free. The exact figure was already being handed in and
   rounded away; it now also lands unrounded.
3. **Poster cron** (`services/videoPoster.ts`) — nearly free, on a URL already signed. Runs *first
   and isolated* so a probe failure never costs the poster, and **omits** the key on failure so a
   cron pass can never erase a value the upload probe got right.

## NULL is a real answer

`NULL` means **not measured** — never zero. `GET /media` serves `null` rather than substituting the
integer, precisely so a client can distinguish "measured 5.0" from "asserted 5, never measured".

**~208 Instagram video rows will be NULL permanently.** `rehostAthleteMedia.pixelFor` stores the
*poster thumbnail* for IG `VIDEO`/`REELS`, so `gcs_path` holds a JPEG and there are no video bytes
on our side to probe. Only the top-8-by-views per athlete ever become real mp4s
(`fetchTopVideoFiles`). Those rows are not a gap to be closed server-side; a client-side decoder is
the only thing that can ever answer for them.

Because NULL survives, **both memory guards stay exactly as load-bearing as before**:
`effectiveSeconds`'s byte-implied estimate at the door, and `assertProbedTimelineFits`'s ffprobe
pass in the runner. 0058 makes the guess *rarer*, not impossible.

## Known-benign residue

**`studio/jobs.ts:247` (`recordGeneratedAsset`) still hands a raw float to `duration_seconds` with
no rounding.** Postgres's `float8 → int4` assignment cast rounds **half to even**, while
`Math.round` in `publishStitchOutput` rounds **half up** — so at an exact `.5` tie the two writers
disagree, and 12.5 becomes 12 on one path and 13 on the other.

This is left alone deliberately:

- it is **moot for every precision reader**, which take `duration_seconds_precise`;
- the integer column's remaining job is the library grid's `fmtDur`, where a one-second difference
  at a half-second tie is invisible;
- `jobs.ts` is outside this card, and changing a rounding rule on a shared column to fix a cosmetic
  tie is a worse trade than recording it here.

Worth knowing before anyone reads a `.5` disagreement between two generated rows as a bug.

## What guards this

- `server/studio/mediaDuration.migration.test.ts` — 0058's revert check. Beyond the obvious, two
  pins worth keeping: the column's `attnum` must not move (a re-run that dropped and re-added it
  would destroy the values), and `pg_class.relfilenode` must not move (proof the table is never
  rewritten — it reds even on a rewrite that leaves every catalog column identical).
- `server/routes/media.duration.test.ts` — the probe's fail-open posture, and that `GET /media`
  serves both keys with `null` intact.
- `server/services/videoPoster.duration.test.ts` — the two orderings: the probe cannot cost the
  poster, and a failed probe cannot erase a good value.
- `server/studio/video/materialize.test.ts` — prefer-precise / fall-back-to-integer, and that an
  explicit trim still outranks both.
