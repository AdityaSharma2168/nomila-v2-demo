# Card — C2, video intelligence (Half A: enrichment learns video)

**Status (22 Sep 2026):** BOTH HALVES BUILT on `studio/c2-video-intelligence`, unpushed. Half A
(enrichment reads a clip as a clip) is behind `STUDIO_VIDEO_ENRICH`, default off, and RAN LIVE on
the measured library (below). Half B (the planner learns clips, the capability vocabulary, and
provenance labels) rides the existing `STUDIO_AGENT` flag — it changes what the planner is shown
and may propose, and nothing it adds spends. One PR, two halves, an independent revert seam: Half A
is commits 1–3 (the worker branch plus `server/studio/enrich/**`); Half B is commits 4–7 (the
planner, the caster, the route's library, the Board and the Agent screen) and touches none of Half
A's files. Reverting Half B leaves beats on the rows and nothing reading them; reverting Half A
leaves a planner that shows CLIP lines for clips that carry no beats (whole-clip only, and its
line says so).

---

## What was wrong

Enrichment (`services/mediaEnrichment.ts`) tags a video from its **poster** — one frame standing in
for the clip — and marks the row done. The planner then sees a description of a frame, not a clip,
and can only cast the clip whole. `metadata.vision` on every video row was a photo tag of its poster.

## Ground truth, measured 22 Sep 2026 (read-only aggregate, one athlete)

| origin    | clips |        total s | avg s | max s | poster | vision (poster-derived) |
| --------- | ----: | -------------: | ----: | ----: | -----: | ----------------------: |
| generated |    65 |          436.7 |   6.7 |  18.0 |    all |                     all |
| upload    |     2 | 0 (unmeasured) |       |       |    all |                     all |

No `connected` video row at all: her synced Instagram footage either never landed as a video row or
is not on this athlete. The "33 videos" in the Agent-tab cards was the 21 Sep count of the same
rows; 34 clips were generated between. Flagged to Mia, not chased here: the poster cron never
visits `origin='connected'`, so a synced reel could never become a candidate for this path either.
**Consequence Half B must encode:** every clip the planner can cast today is generated or uploaded,
so provenance labels matter from day one, and the doctrine PR's "real footage first" has no material
to prefer until uploads/sync are fixed.

## What Half A does

`server/studio/enrich/videoEnrichment.ts` runs FIRST inside `enrichNextChunk` when the flag is on,
on this candidate, exactly:

```
stored · top-level · deleted_at IS NULL · gcs_path IS NOT NULL
AND coalesce(content_type,'') LIKE 'video/%'        -- the bytes ARE a video (a synced reel's still is not)
AND gcs_thumb_path IS NOT NULL                       -- the poster cron has been: duration measured, transcode done
AND metadata -> 'vision' -> 'beats' IS NULL          -- not yet read as a clip; vision PRESENT is not a skip
AND metadata -> 'enrichment' ->> 'abandoned_at' IS NULL
```

It reads the mp4 from GCS, sends it inline to Gemini (native video, 1 fps, audio included) and
writes `metadata.vision` with `jsonb_set` on that one key — not the worker's whole-jsonb
read-modify-write, for the race `studio/qa/record.ts` documents. The write:

- **overwrites the whole-clip fields** (the exact `AssetTags` shape — every existing reader stays
  untouched), because a description of one frame is strictly worse than one of the clip;
- **adds `beats`** — ordered, clamped to `[0, duration]`, each carrying the same tag fields plus
  freeform `camera` / `motion` (Half B closes those into the §8 enums);
- **adds `video`** — `{ source: "clip", model, sampled_fps, duration_s, tagged_at }`, the eval's key;
- **stashes the replaced object under `vision.prev`** (one level; `null` when there was none), so the
  enrichment eval can diff poster-derived against clip-derived on the same rows;
- **clears `enrichment`** on success, as the worker does.

The photo path then finds `vision` present and only embeds the poster — a fresh clip costs one
clip read and one embed, never a poster tag as well.

### Beat schema

```ts
vision.beats: Array<{
  start_s: number; end_s: number;                 // seconds from the clip's start; MM:SS accepted and converted
  description: string; shot_type: string;         // portrait | action | lifestyle | group | text_graphic | other
  athlete_present: boolean; athlete_prominence: number;
  setting: string; attire: string; vibe: string;
  brands_visible: string[]; aesthetic_quality: number;
  camera: string; motion: string;                 // freeform in Half A
  hero_suitability: number;
}>
```

Safety is whole-clip: `content_flags` on the clip, and the photo tagger's hard override applies
(hateful / sexual / self-harm → `reject`, `brand_safe: false`), whatever the model said.

### Flag, model, money — `server/studio/enrich/config.ts`

| knob                                                        | default        | what                                                                |
| ----------------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| `STUDIO_VIDEO_ENRICH`                                       | off            | the module is not even loaded; the worker behaves as before         |
| `STUDIO_ENRICH_VIDEO_MODEL`                                 | `GEMINI.flash` | the registry identifier, never a string at a call site              |
| `STUDIO_VIDEO_ENRICH_MAX_RUN_USD`                           | 2              | per `enrichNextChunk` call (one cron pass or one post-upload kick)  |
| `STUDIO_VIDEO_ENRICH_MAX_BYTES`                             | 100 MB         | the inline ceiling; above it the row is set down, reason `oversize` |
| `STUDIO_VIDEO_ENRICH_TIMEOUT_MS`                            | 120 000        | one clip's call                                                     |
| `STUDIO_VIDEO_ENRICH_USD_PER_INPUT_TOKEN` / `_OUTPUT_TOKEN` | 1.5e-6 / 9e-6  | Flash list price 22 Sep 2026; set to 2e-6 / 12e-6 for a Pro cell    |

**The cap is a budget, not a verdict.** The estimate (duration × 132 tokens/s + prompt; output
400 + 40/s) is banked BEFORE the call and settled to what Vertex reported after. When the next clip
would pass the cap the run stops with the named refusal `VideoEnrichCapExceeded`
(`code: "video_enrich_cap"`), logged once; the clip is left exactly as found — no attempt, no write
— and the next pass resumes. An unknown duration (the two uploads) is estimated as 60 s, so it can
only make a run stop early, never let the cap be passed.

**Failures.** Oversize by the `bytes` column is deterministic and set down on sight without a
download (`abandoned_reason: "oversize"`, `abandoned_missing: ["beats"]`); the poster tags stay and
the row stays castable. Everything else is one consecutive attempt under the worker's own
`metadata.enrichment` budget (10), abandoned at the cap with reason `attempts`.

### Cost table (accepted 22 Sep 2026)

From the measured 437 s across 67 clips; Flash $1.50/M in, $9/M out; Pro preview $2/M in, $12/M
out; video ~100 tokens/s at default resolution (~300 at high) + 32/s audio; ~500 prompt and ~800
output tokens a clip.

| cell               | input tokens | output tokens | estimate |
| ------------------ | -----------: | ------------: | -------: |
| Flash, default res |          91k |           54k |    $0.62 |
| Flash, high res    |         179k |           54k |    $0.75 |
| Pro, default res   |          91k |           54k |    $0.83 |
| Pro, high res      |         179k |           54k |    $1.00 |

Output tokens dominate at these clip lengths, so Flash vs Pro is a 34% gap, not a 10× one. Flash is
the default on economics. **The enrichment eval card gains a planned Pro cell:** a 10-clip sample
(~$0.13) re-tagged with `STUDIO_ENRICH_VIDEO_MODEL` set to the Pro identifier, judged blind against
the Flash tags on the same rows via `vision.prev` — so the model choice becomes evidence.

**The enrichment eval PR opens with the clobber-victim sweep** (22 Sep 2026). The 51 s upload
(d076a790) was found by luck: the poster worker's transcode write replaced its whole `metadata`
from a stale read and erased the clip lane's marker, and a later pass then dressed one poster frame
as the row's analysis. Before the eval reads any row, count the others — video rows whose
`metadata_updated_at` sits inside a transcode-era write and whose `vision` is null or photo-shaped
(no `beats`, no `video`): `content_type LIKE 'video/%' AND gcs_thumb_path IS NOT NULL AND
metadata ? 'original_gcs_path' AND (metadata -> 'vision' IS NULL OR metadata -> 'vision' -> 'beats'
IS NULL)`, grouped by athlete, ids and counts only. Every hit is a row the eval must not score as
"poster-derived" — it is a row the clip lane never got to keep. Both write paths are fixed on
`studio/enrich-51s-bug`; the sweep is what says how many rows the fix arrived too late for.

**The doctrine eval's camera-first libraries are stale** (22 Sep 2026): the recorded sets carried
two camera clips for athlete 3811cedd; the third (d076a790) now has 6 beats from a single-asset
rerun, so `listClips` offers it. Doctrine round 2 re-records its libraries before any re-run; the
existing recordings stay as they are, because the merged eval's numbers were measured on them.

## Ingestion — both paths, no backfill statement

- **Ongoing.** The upload route (`routes/media.ts`, after the insert) fires `enrichNextChunk`; the
  15-minute cron (`POST /api/internal/media-enrich-cron`, `server/index.ts`) sweeps; a fresh
  platform backfill (`skills/mediaBackfill.ts`) kicks it. All three reach the video path through the
  one flag check inside `enrichNextChunk`. A new clip is a candidate the moment the poster cron
  (every 5 min) sets its poster.
- **Existing rows.** Flag on + the cron drains them: 67 clips at ~$0.01 each against a $2 run cap
  is one pass, or two if the cap trips. No statement writes anything.
  `docs/queries-video-beats-count.sql` (read-only) gives the before/after count: `candidates`
  should go 67 → 0 and `read_as_clip` 0 → 67, `with_prev` = `read_as_clip`.

## Shared-code touches — for Mia's review

Two files, both inert with the flag off:

1. `server/services/mediaEnrichment.ts` — one flag check at the top of `enrichNextChunk`, a dynamic
   import of the video module behind it, and `remaining` summed across both paths.
2. `server/lib/visionTag.ts` — `mimeFor` exported and taught `.mp4` → `video/mp4`, `.mov` →
   `video/quicktime`. It returned `image/jpeg` for both before; latent, because no mp4 reached it in
   production, but a caller passing a clip must not have it labelled a JPEG. Pinned by a test.

## First live pass — 22 Sep 2026, Adi, flag on in dev, one athlete

Read from the server log (`video enrichment chunk done` lines), not from the DB.

| figure                  | value                                                         |
| ----------------------- | ------------------------------------------------------------- |
| candidates at start     | 67                                                            |
| clip reads billed       | 76 (10 chunks of up to 8)                                     |
| reads that parsed       | 76; 2 transient failures in the middle, both retried and read |
| estimated spend, summed | $0.6206 (predicted $0.62)                                     |
| tokens, summed          | 99,348 in · 52,412 out                                        |
| per read                | ~1,300 in · ~690 out (estimate assumed 1,400 · 800)           |
| cap trips               | 0                                                             |
| rows abandoned          | 0                                                             |

**Two defects found, both fixed in the second commit:**

1. **Nine rows were read twice.** 76 reads landed on 67 rows: two cron requests were in flight at
   once, both selected the same candidates, and the later write replaced the earlier one — putting
   the CLIP read under `prev` and losing the poster-derived object for those nine rows. The write is
   now compare-and-set (`… AND metadata -> 'vision' -> 'beats' IS NULL RETURNING id`): the loser's
   read is discarded, counted as `raced`, never an attempt. The second read's money is still spent;
   a claim before the call would save it and is not built. `docs/queries-video-beats-count.sql` now
   reports `double_read` (prev carrying a `video` record) so the nine can be found; their `prev` is
   a clip read, so the eval must skip them or the poster tag must be re-derived from the poster.
2. **Each cron request did exactly one chunk.** The cron loop breaks on `total === 0`, and the
   worker's `total` was the photo path's alone — 0 while 59 clips waited. The video path's `total`,
   `tagged` and `failed` now join the worker's result. In production this would have drained 8 clips
   per 15 minutes; now one request drains up to its 160 s budget.

**After the pass — `docs/queries-video-beats-count.sql`, 22 Sep 2026:** 65 generated + 2 upload,
`candidates` 0, `read_as_clip` 67, `with_prev` 67, `double_read` 8 (the log's 9 extra reads on 8
rows: one row was read three times), `abandoned` 0, model `gemini-3.5-flash`, 2.06 beats a clip.

**Eval decisions (Adi, 22 Sep 2026):**

- **The eight double-read rows stay as they are.** Re-deriving their poster tags would spend money
  to rebuild data whose only purpose was a before/after diff; 59 of 67 carry a clean poster-derived
  `prev`, enough for the eval. The eval card records the eight as **excluded, reason
  `double_read`** — the column finds them. And their `prev` is a valid second Flash read of the same
  clip, so they are a free same-model repeatability sample if the eval ever wants one.
- **The unclaimed read window is accepted at this scale.** Two overlapping requests can still both
  bill a read and discard one; the compare-and-set protects the data and `raced` is on the log line.
  "Claim before the call" goes on the far-bank list, not built. **Flip checklist:** in prod the
  15-minute scheduler and any manual or deploy-time cron fire can overlap the same way — a
  `raced > 0` line is that, not a mystery double-spend. Within one instance they no longer overlap
  at all: `enrichNextChunk` is one door, and a call that arrives mid-run waits its turn (the 51 s
  upload fix, 22 Sep 2026); `abandoned` and `raced` are now on the cron response as well as the line.
- **A clip is not tagged? `grep <asset id>` the server log.** Every non-tagged row is one
  `video not tagged` warn with `assetId` and a `reason` (oversize_column, oversize_object,
  missing_object, unreadable_object, unparseable, transport_error; `raced` at info). Before this the
  first upload over the inline ceiling left no line at all. **Flip checklist:** the dev server's
  stdout must tee to a file — it was a bare tty on 22 Sep 2026 and the only record of two passes
  was terminal scrollback. And the poster worker now kicks enrichment when a poster lands (after
  the transcode, so the read is the 1080p re-encode), because the upload-time kick fires minutes
  before the poster exists and nothing else asked until the next scheduled cron.
- **A capability value outside the closed lists is nulled, and every null is logged** with a
  distinct code and the offending string (Half B), so the plan eval can see how often the planner
  steps outside the vocabulary. A high null rate on Pro is a doctrine-PR finding.

## Verification

- `server/studio/enrich/videoTag.test.ts` (parse, clamp, MM:SS, hard override, MIME),
  `videoCost.test.ts` (estimate, bank/settle/release, the named refusal),
  `videoEnrichment.test.ts` (PGlite: predicate, jsonb_set write, prev, oversize, attempts, cap,
  flag off / on / on-and-capped through the real worker).
- Nine mutations, each red by name: flag check removed · content_type clause dropped · prev not
  stripped · cap trip writes an attempt · whole-jsonb write · oversize column unchecked · video path
  never runs with the flag on · compare-and-set WHERE dropped · cron total not summed across paths.
- Verified live: the pass above. Still owed: the count statement after the pass (`read_as_clip` 67,
  `double_read` 9 expected), and a look at a few beat lists by eye.

## Half B — motivation to carry forward

The C1b device pass showed b-roll beats come back generic and unmoored from the brief: an "adidas
ad" got a stock spinning-ball scene — competent, irrelevant. Relevance/doctrine is deliberately NOT
this PR. But the capability enums (architecture doc §8: closed camera / lighting / motion /
composition in the planner prompt and plan schema) and the provenance labels (camera / made-here /
synced on every library line) are its prerequisites: the doctrine PR ranks on them, so they land
here, labels and enums only, no ranking.

---

# Half B — the planner learns clips, the vocabulary, and where a photo came from

## Why (carried from the C1b device pass)

B-roll beats came back generic and unmoored from the brief: an "adidas ad" got a stock
spinning-ball scene — competent, irrelevant. Relevance/doctrine is deliberately NOT this PR. But
the doctrine PR ranks on two things that did not exist: a closed vocabulary for what a shot asks
of the camera and the light, and a label on every library line saying where the footage came
from. Both land here, labels and enums only, no ranking — and with them the one thing the
doctrine PR most wants to prefer: her real footage, as a `clip` kind the planner can name.

## (3) Provenance labels — commit 4

`media_assets.origin` folded into three words, exactly as the picker folds it
(`studio/mediaList.ts` `MEDIA_ORIGINS`; pinned equal by test): `upload` → **her camera**,
`generated` → **made here**, `connected`/`discovery` → **synced from her accounts**. The caster
loads `origin`, the row and `LibraryEntry` carry `provenance`, and every fenced library line gains
one `from:` token. No prompt rule mentions it; the caster does not rank on it. On the measured
library every clip is made-here or her camera; there is no synced video row at all — which is why
the label has to exist before "real footage first" can mean anything.

## (2) The capability vocabulary — commit 5 (`server/studio/agent/capabilities.ts`)

Mia's architecture doc §8, verbatim, in snake_case, five axes: **camera** (11), **movement** (11),
**lighting** (11), **composition** (7), **motion** (8). Environment and the commercial styles are
§8's too and are left out — outside the brief's four axes, the doctrine PR's if it wants them.

- `PlanItem.capabilities` — an object with any of the five keys, each one member. The prompt lists
  every axis and every member (a test walks the lists against the prompt).
- **A value outside its list is NULLED, and every null is logged** under
  `capability_outside_vocabulary` with the axis and the model's word (Adi, 22 Sep 2026): the kind
  decides the money and refuses whole; an adjective colours the direction and is dropped — but never
  silently, because the plan eval needs the rate. `AgentPlan.nulled` carries them; `derivePlan` logs
  one line each and the `plan derived` line carries the count.
- **Compile maps only where a Board slot exists** (`toShotSpec`): `wide`/`medium`/`medium_wide`
  → framing, `close_up`/`extreme_close_up`/`macro` → close, the four shared movements, `golden_hour`
  and `stadium`. The cast item carries `shot`; the Agent screen seeds it onto the row, keeping only
  the slots the row may carry (`slotsAllowed`: a photo row movement only, a photo-less b-roll row
  all four, a held row none). Everything else — a low angle, a rim light, a rule of thirds —
  travels as a short clause on the direction (`capabilityProse`), which is where freeform camera
  language lived before.
- **Where §8 and the tree disagree**, recorded, not resolved: the Board's `ShotSpec` has `overcast`
  and `warm-lamp` lightings §8 lacks; §8 has seven lightings the Board lacks; §8 mixes shot size and
  angle in one camera list where the Board has three framings; composition and motion have no
  Board axis. No slot was added to `ShotSpec` — that is the compiler's and the doctrine PR's.
- **Half A's beat words stay freeform.** `nearestCapability` folds a beat's `camera`/`motion` onto
  the lists deterministically at library assembly — a member spelled as words first, then a short
  alias table, longest first, else null. No model, no spend, no re-tag.

## (1) The `clip` kind — commits 6 (server) and 7 (client)

One of her own videos, used as it is or cut to one of Half A's beats. $0 like a held photo: no
preview, no admission, no spend; priced only by the stitch's own rules. Three names, one thing, as
with the still: plan kind `clip` → Board kind `clip` → an ordinary video position on the stitch
wire with `trimStartSec`/`trimEndSec` (which already existed end to end) and `muted` unless she
kept its sound. **Trim-to-beat is supported**, because Half A's tags carry `start_s`/`end_s`.

**Server.** The planner is shown her newest tagged clips (`listClips`, newest first, at most 8, in
their own room beside photos of her and scenes — a clip earns none of searchMedia's hero score and
would never be seen among photos) under `CLIP` lines: length, the usual tags, `from:`, and
`beats: [0] 0-3s wide/static/running: she sprints; …`. A clip item names one by `ref` and
optionally a beat by `segment`. The parser refuses, whole, like an unknown ref: a segment the clip
does not have, a fractional or string one, a clip item on a photo line, a photo kind on a CLIP
line. A clip's `sound` is its own — true keeps it, false mutes it, free either way. The caster
loads photos and clips through one door (`herPhotoOrClip`: `herPhoto OR herClip`, nothing looser —
a poster-only Instagram video is still not a clip), fits a clip only to a clip (`fitsKind`), trims
to the named beat, swaps only to a clip she picked, and **never searches for a clip** — searchMedia
ranks by a hero score a clip never earns, and footage found by description is footage the
direction was not written about — so an unusable clip item is left out by name
(`UNCAST_CLIP_LINE`). A clip in the products tray is a 400 before any model. The cast item carries
`mediaType`, `trim` and `durationSeconds`.

**Client, the 15 sites.** `clip` is in the `ShotKind` union for the still's reason (ruling 6): the
compiler found the run builder's role map and the tab's refusal map. A clip row carries `clipTrim`
and `clipSec`, never a line, a kind pill or a camera; `heldClipRow` makes one, `clearClipTrim` is
"Use the whole clip". Its window and its own sound are EDITS — out of `rowSignature`, in
`boardWorkSignature` (ruling 1: no request reads them; the stitch does). It is not a piece, not a
bridge (`bridgeable`, `bridgeRequestFor`), never admitted, has no action; beside it the join is
Cut or Fade. The quote shows it as "$0 · Ns of yours" (`QuotedRow.own`) and never a missing quote;
a clip-only board prices at $0.00. `boardStitch` places it at its row with its trims and `muted`
unless kept, on the free fade unless she cut it; it counts against the clip cap like every kind.
The Agent screen shows `YOUR CLIP · $0 · 3–6.5S · ITS SOUND` and seeds it with no hold to wait
for. The Board row: its window, "Use the whole clip", and an "Its sound: on/off" pill.

**Out of scope, on purpose:** adding a clip from the Board's own picker (the picker is photos on
the Board; her videos still join at the end as passthrough), a trim editor on the row beyond
whole-vs-beat, and any ranking of clips against photos.

## Half B verification

- Suites: `server/studio/agent/{plan,cast,capabilities}.test.ts`, `server/routes/studio.agent.test.ts`,
  `client/screens/studio/{storyboardLogic,storyboardRun,boardStitch,agentLogic}.test.ts`. The C1b
  byte-equality suite ("a board without stills asks for exactly what it asked for before stills
  existed") is green and untouched: a board without clips asks for exactly what it did.
- Seventeen mutations, each red by name and by nothing else: the `from:` token dropped · the fold
  mislabels an upload · a value outside the list refuses the plan · nulled values not logged ·
  unslotted capabilities dropped instead of travelling as prose · `push_in` mapped onto the wrong
  slot · a segment past the clip's beats accepted · kind/media-type mismatch not refused · the
  beat's window not applied · `fitsKind` lets a clip into a photo kind · a clip searched for on the
  fallback · a clip item seeded as a motion shot · the window dropped from the stitch position · a
  clip's sound put into the quote key · a clip counted as a missing quote · `boardRequests` builds
  a request for a clip · the planner's slots seeded unfiltered.
- Not verified: a plan on the real library with the flag on, and the Board's clip row on a device.
  Both are Adi's; the Agent tab's existing flag gates the whole of Half B.
