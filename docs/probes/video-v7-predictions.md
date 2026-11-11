# V7 — predictions, written before the diff

Written before any of it was built, so the misses are legible afterwards. One section per layer;
each layer is proven before the next is started.

---

## Layer 1 — migration 0057 (`studio_stitch_jobs`)

### What the file does

Creates ONE new table. Touches nothing that exists: no `ALTER`, no `DROP`, no `UPDATE`, no data
movement, and in particular **no `DROP CONSTRAINT` / `ADD CONSTRAINT` pair anywhere**. Every
constraint is declared inline in the `CREATE TABLE IF NOT EXISTS`, so a re-run is a no-op by the
table's own existence rather than by a guard that has to be got right.

### The prediction that matters: 0056's race is structurally impossible here

0056 needed its DO blocks because widening a CHECK is DROP + ADD, `psql -f` runs without
`--single-transaction`, and the gap between the two autocommits — the gap that cost this repo two
outages (#140/#141 interleaved, #357 died mid-DDL). 0057 writes no such pair. **I predict the
mid-DDL-death test that 0056 needed cannot even be written against this file**, because there is no
intermediate state in which the table is half-guarded: `CREATE TABLE` either commits with all its
constraints or does not create the table at all.

That is a claim about the file's shape, so the suite proves it structurally: it asserts the file
contains no `DROP CONSTRAINT`, no `DROP INDEX`, and no bare `ADD CONSTRAINT`, and it asserts the
table's OID is unchanged across three applications.

### Specific predictions

1. **OID-stable re-run.** Applying the file 2× and 3× to the same database leaves
   `'studio_stitch_jobs'::regclass::oid` unchanged. Mutating `IF NOT EXISTS` away turns run 2 into
   an error (`relation already exists`), not a silent re-create — so the revert check asserts the
   _error_ as well as the OID. I predict the mutation reds on the error assertion first.
2. **Fresh DB and existing DB converge.** Both a database that has never seen the table and one
   that already has it end with identical columns, indexes and constraints — and identical to what
   a `drizzle-kit` push of `shared/schema.ts` produces. I predict the parity test is the one most
   likely to red on the first run, on constraint _naming_: drizzle emits
   `studio_stitch_jobs_athlete_id_athletes_id_fk`, and a hand-written FK with any other name passes
   a columns-and-indexes comparison while leaving real drift. So the suite compares **all**
   constraints by name and definition, not just columns and indexes.
3. **Rollback is total.** The pre-0057 image never reads this table, so every `generation_jobs`
   write it makes still works after 0057 applies. I predict this test is trivially green and is
   worth having anyway: it is the assertion that makes "additive" checkable rather than aspirational.
4. **Spend isolation, at the schema layer.** `spentTodayUsd` sums `generation_jobs.cost_estimated_usd`.
   A stitch job cannot move it because it is not in that table — but a test that merely asserts
   "unchanged" would also pass if stitch rows were in `generation_jobs` with a NULL cost (SQL `SUM`
   ignores NULLs). So the check is mutated the way that actually distinguishes it: **insert the
   stitch row into `generation_jobs` with a non-null cost** and require the figure to move. I
   predict the un-mutated test is green and the mutated one reds by a dollar amount.
5. **The video claim cannot see a stitch job.** `claimVideoJobs` is
   `WHERE status='queued'` over `generation_jobs` with no discriminator. With the row in its own
   table the claim returns zero. Mutated — the same row inserted into `generation_jobs` — the claim
   returns it. I predict this is the clearest red of the set, and it is the one that proves the
   table decision rather than restating it.
6. **No transaction control.** `migrationsGuard.test.ts` already enforces this repo-wide; 0057 stays
   off `OWN_TRANSACTION` and the suite asserts it locally too, so the rule travels with the file.

### What I am NOT claiming

- **The concurrent interleave is not tested, and cannot be here.** PGlite is one in-process
  connection whose `query()`/`transaction()` share a mutex, so two runners cannot be made to
  interleave. For 0057 this matters less than it did for 0056: two concurrent
  `CREATE TABLE IF NOT EXISTS` of the same table take `ACCESS EXCLUSIVE`, and the loser finds the
  table present and skips. That is Postgres semantics, argued not measured.
- **Nothing about real Postgres.** PGlite is Postgres, but the deploy-dev migration step against
  Cloud SQL is the only thing that proves the file applies there. That is watched on CI, not here.

---

## Layer 2 — the asset ↔ local-path bridge

`materialize.ts`: athlete-scoped asset id → temp file, and back. Written before the code, after
reading the GCS wrapper and the poster worker.

### The prediction that turned out to matter before I wrote a line

Recon changed this section. The build order said "temp file via `mediaStore.readObject`", and
`readObject` **cannot do this job**: it caps at `MEDIA_MAX_BYTES` (25 MB, mediaStore.ts:17) and
returns `null` above it, and it buffers the whole object with `file.download()`. Uploaded clips are
allowed up to **200 MB** (`UPLOAD_LIMITS.video.max`). So I predict a `readObject` bridge would
return `null` for ordinary clips and read as "asset missing" — a wrong diagnosis for a file that is
present and simply large.

Worse, `services/videoPoster.ts:13-16` states the deeper constraint: **on Cloud Run `/tmp` is RAM**,
which is why that worker never downloads at all — ffmpeg reads straight from a signed GCS URL and
only small outputs touch `/tmp`. V6 refuses URLs for a reason that does not apply to a signed one
(it says "nowhere to carry a bearer token"; a signed URL carries its auth in the query string).

So I predict the memory ceiling, not correctness, is what bounds a timeline, and that the arithmetic
is: clips × up to 200 MB each against a 2 GiB instance shared with Node and ffmpeg. I am NOT
predicting a measured number — macOS `/tmp` is disk, so the tmpfs behaviour cannot be measured here.

### Specific predictions

1. **Cleanup on the throw path is the interesting failure**, not the happy path. The test drives a
   failure mid-download and asserts the temp directory is gone. I predict `dispose()` must be
   idempotent, because the runner will call it in a `finally` that can run after a successful
   dispose on the error path.
2. **Tenancy resolves here, not in the route.** The runner resolves ids at claim time, when no
   request and no `req.athleteId` exist. I predict the resolve has to be ONE query over all ids with
   a completeness check — resolving id-by-id would download the valid clips before discovering the
   foreign one, which spends bandwidth and writes files on behalf of a request that must fail.
3. **A spec naming another athlete's asset fails closed, before any download.** Mutating the query
   to drop the `athlete_id` predicate must red.
4. **Duplicate ids are legal and must download once.** The same clip twice in a timeline is an
   ordinary edit. I predict dedupe falls out of resolving unique ids and mapping back, and that a
   test asserting "two timeline entries, one download" is the one that catches a naive `map`.
5. **A non-video asset is refused here** rather than deep inside ffmpeg. An IMAGE in a stitch spec
   is a caller bug and should read as one.
6. **The output asset cannot reuse `recordGeneratedAsset`.** Its `jobId` is non-null and writes
   `generation_job_id`, which carries a real FK to `generation_jobs` — a stitch job id violates it.
   I predict I write the insert locally rather than widening that function, and that nothing is lost
   by doing so: `writeGeneratedThumbnail` returns `null` for VIDEO by design (thumbnail.ts:77), so
   the only thing reuse would have bought does not apply.
7. **The poster arrives for free.** `videoPoster.ts` selects
   `origin IN ('upload','generated') AND media_type='VIDEO' AND status='stored' AND gcs_thumb_path IS NULL`,
   so an output written that way is picked up by the existing cron with no new code.

## Layer 3 — the job kind, the runner, the two routes and the tick

Written before the diff. Layer 2's shape is now fixed and committed (38f2bed), so this section
predicts against real code rather than against a build order.

### The two things recon changed before a line was written

**1. CPU IS ALWAYS ALLOCATED, so detached work is not a fiction.** `gcp/cloud-run-dev.yaml:12` and
`gcp/cloud-run-prod.yaml` both set `run.googleapis.com/cpu-throttling: "false"`. That is what makes
"the tick claims and returns without blocking on ffmpeg" a real design rather than a way to abandon
an encode: work started after the response keeps its CPU. (The note on
`/api/internal/media-poster-cron` — "fire-and-forget wouldn't finish on Cloud Run" — predates that
annotation and is now stale. It is not mine to fix; V3's video kick already relies on the newer
behaviour.) I predict the tick test can therefore assert something strong: make `stitch()` hang
forever and the tick still resolves.

**2. THE BUDGET IS PER INSTANCE, AND NOTHING IN LAYER 2 KNOWS THAT.** `containerConcurrency: 80`,
`maxScale: 3`. Two ticks landing on one instance — the Cloud Scheduler tick and the inline kick from
the route — each claim a _different_ queued row, because SKIP LOCKED and `status='queued'` stop them
claiming the _same_ row and nothing stops them claiming two. Two workspaces then sit in one
instance's tmpfs at once and the 1 GiB budget is 2 GiB. **I predict this is the layer's real defect
and that no lease, lock or SKIP LOCKED closes it**: the advisory lock is released the moment a fast
tick returns, which is precisely what we are asking it to do. It needs an in-process capacity guard —
a count of stitches in flight _in this process_, claimed against before the claim. The revert check
is: two ticks back to back with the first still running claims once, not twice.

### The memory ceiling, made concrete — "up to N clips / M MB"

Layer 2 refused an over-budget timeline but never said what the budget _was_ in a user's units, and
it charged the output at zero. Both are fixed here, from constants that already exist:

| quantity                        | value       | where it comes from                                                                                |
| ------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| instance memory                 | 2 GiB       | `gcp/cloud-run-{dev,prod}.yaml` `memory: 2Gi`                                                      |
| workspace budget (tmpfs, = RAM) | 1 GiB       | `workspaceMaxBytes()`, layer 2 — half the instance, the other half for Node + ffmpeg               |
| output bytes per second         | 2 MiB/s     | `config.ts videoBytesPerSecond()` — measured at 0.74 MB/s on a 720p Veo clip, rounded up to ~1080p |
| **max timeline**                | **180 s**   | product cap for the demo; the output allowance follows from it                                     |
| output allowance                | 360 MiB     | 180 s × 2 MiB/s                                                                                    |
| **max source bytes**            | **664 MiB** | 1 GiB − 360 MiB. Derived, never typed as a magic number                                            |
| **max clips**                   | **12**      | ffmpeg's per-input working set — see below                                                         |
| per clip                        | 200 MiB     | `clipMaxBytes()` = `UPLOAD_LIMITS.video.max`, unchanged                                            |

So the answer to "what is the cap" is **12 clips · 664 MB · 3:00**, and all three are stated in the
refusal and returned on the status route so the UI can say it before she hits it.

Which cap binds depends on what she is joining, and I predict both are reachable, which is the test
that they are not decoration:

- **Generated clips** (8 s Veo, ~16 MiB): 12 clips is 192 MiB and 96 s. **The count binds first.**
- **Uploaded clips** (up to 200 MiB): 4 of them is 800 MiB. **The bytes bind first, at four clips.**

`maxClips = 12` is the one number here that is **a budget and not a derivation**, and I want to say
so plainly. Each input in a single filter graph carries its own decoder and, across an `xfade`, held
frames; at 1080p that is on the order of 25 MB each, so 12 is ~300 MB of ffmpeg working set inside
the GiB this arithmetic reserves for it. There is no measurement of that in this repo and there
cannot be one on a laptop, because macOS `/tmp` is disk. **It is the single number I most want
measured on a real instance before the flag flips**, and it is env-overridable so measuring it does
not need a deploy.

### Specific predictions

1. **The reaper is materially simpler than V3's, and that is the honest consequence of $0.** No
   orphan arm, because there is no paid call to have been orphaned: `lapsed → queued`, always. I
   predict the test that matters is the _negative_ one — a lapsed stitch job whose lease expired
   mid-ffmpeg comes back `queued` and **never** `failed` — because failing closed is the reflex V3
   trained and it is wrong here. Mutating the reaper to copy V3's orphan arm must red.
2. **`attempts` still bounds the loop.** $0 does not mean infinite: a timeline that kills its
   instance every time would be handed round forever. Exhausted → `failed`, same as V3.
3. **Re-running a stitch publishes a SECOND asset row, and layer 2 cannot stop it.** This falls
   directly out of (1): "requeue always" means re-runs are the ordinary case, and
   `publishStitchOutput` inserts unconditionally. The GCS path is deterministic so the _file_ is
   overwritten, but `media_assets` gets a second row and the first is orphaned in her library with
   nothing pointing at it. **I predict this is a real defect in approved layer-2 code that only
   layer 3's reaper makes reachable**, and that the fix is an upsert on the deterministic path
   rather than anything in the runner. Revert check: requeue a succeeded job, re-run it, assert
   exactly one asset row and a stable asset id.
4. **The lease must exceed the ffmpeg timeout, and V6's default makes that untenable.**
   `defaultTimeoutMs(180)` is 30 s + 180×15 s = **45.5 minutes**. A lease shorter than the timeout
   lets the reaper requeue a job that is still encoding, so two runners stitch it at once; a lease
   longer than it strands a dead instance's job for 45 minutes. I predict I pass an explicit
   `timeoutMs` (10 min) rather than inherit the per-second scaling, and derive the lease from it the
   way `leaseMs()` derives from `httpTimeoutMs()` — so raising one cannot silently invalidate the
   other. 10 min against a 180 s timeline is ~3× realtime headroom on 2 vCPUs; a budget, labelled.
5. **A spec resolves asset ids against the CLAIMED ROW's athlete, and a cross-athlete id fails
   closed before any download.** Layer 2 owns this; layer 3's job is not to acquire a second way in.
   I predict the runner passes `job.athlete_id` and never anything else, and that the route's
   pre-flight uses **the same `resolveClips`** rather than a second query — a parallel validation is
   a second source of truth and would be the thing that drifts.
6. **The route refuses an over-cap timeline before a row exists.** Queue-then-fail is honest but
   useless: she waits for a runner to tell her something the request already knew. I predict the
   pre-flight is worth the extra query and that the same limits function serves both doors, with the
   runner re-checking because the library can change between queue and claim.
7. **No target comes off the wire.** `target.videoCodec` / `preset` / `pixFmt` reach an ffmpeg argv.
   `execFile` means no shell and therefore no injection, but a client-chosen encoder is still a
   client-chosen encoder. I predict a named allowlist (`portrait` / `square` / `landscape`) and that
   the stored spec holds the _name_, so a preset can be corrected later without rewriting frozen rows.
8. **The tick is not the money path and must not be reachable from it.** Its own endpoint, its own
   advisory-lock key, its own runner module. I predict the strongest available check is structural —
   walk the stitch runner's import graph and assert no provider adapter, no `previewStore`, no
   `spentTodayUsd` — the posture `studioSessions.test.ts` already takes.

### What I am NOT claiming

- **Not that 1 GiB is right.** It is half of an instance, chosen because the other half must hold
  Node's RSS, ffmpeg and up to 79 other concurrent requests. Unmeasured, and the whole table above
  moves if it turns out to be wrong.
- **Not that the in-process guard bounds the fleet.** It bounds ONE instance, which is what the
  2 GiB limit is. Three instances stitching one timeline each is fine and is the point of maxScale.
- **Nothing about real tmpfs.** As at layer 2: macOS `/tmp` is disk. Every memory figure here is
  arithmetic on constants, and none of it is an observation.

## Before the flag flips — MEASURE THESE ON A REAL INSTANCE

Two numbers in layer 3 are **budgets, not measurements**, and neither can be measured on a laptop
(macOS `/tmp` is disk, so the tmpfs behaviour that makes them matter does not exist here). Both
fail SAFE — too low refuses early and recoverably; too high is an OOM or a killed encode — so
neither blocks the build. Both need a real number before production relies on them.

| #   | number                      | where                  | what it is                                                                                                                                       | how to measure                                                                                                                                                                                         |
| --- | --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **`maxClips` = 12**         | `video/materialize.ts` | ffmpeg's per-input working set in one filter graph — ~25 MB per 1080p input is the estimate, so 12 is ~300 MB. Nothing in this repo measures it. | On a dev instance with the flag on: stitch 4, 8, 12, 16 clips and read peak container memory off Cloud Run's metrics. Env: `STUDIO_STITCH_MAX_CLIPS`.                                                  |
| 2   | **ffmpeg timeout = 10 min** | `studio/stitchJobs.ts` | ~3× realtime for a 180 s timeline on 2 vCPUs. V6's own default would have been 45.5 min and would have forced a lease longer than that.          | Read `manifest.ffmpeg.durationMs` — already logged per run — over a handful of real timelines and take p95 against the 180 s cap. Env: `STUDIO_STITCH_TIMEOUT_MS`; `leaseMs` follows it automatically. |

A third figure is arithmetic rather than a guess and is listed only so it is not mistaken for one:
the **1 GiB workspace budget** is half a 2 GiB instance, chosen because the other half must hold
Node's RSS, ffmpeg and up to 79 other concurrent requests. If (1) is measured, this is the number
it will move.

---

## Layer 4 — the timeline UI

Written before the diff. Scope: Pipeline 1 functional, Pipeline 2 as a shell, `WatchKind` gains
`"stitch"`, and the audio bed wired end to end.

The two pipelines are not my names for them — `videoEntryLogic.ts:11` named them when V4 decided an
entry is a VIDEO and not a generation result: **upload → stitch → music** (Pipeline 1, what V7
builds) and **generate-from-keyframes** (Pipeline 2). That decision is the one this layer tests.

### The claim V4 made, and how I intend to falsify it

V4 predicted `videoEntryLogic.ts` needs NO change for a second pipeline. I predict the same, and
the mechanism is that the stitch read is normalised to `JobRead` AT THE FETCH BOUNDARY rather than
downstream — `{ status, startedAt, asset }` becomes `{ status, startedAt, assets: asset ? [asset] : [] }`
— after which `pollOutcome`, `pollProgress` and `videoEntryFromJob` work untouched, because
studio_stitch_jobs shares the status vocabulary exactly (`queued` / `running` / `succeeded` /
`failed` / `canceled`; 0057's CHECK, verified against `pollOutcome`'s branches).

**If that file has to change, V4's source-agnostic claim was wrong and I will say so rather than
patch it.** That is the falsifiable half of this layer.

### The prediction recon already settled: no new route for the picker

Pipeline 1 starts from HER UPLOADS, and `GET /studio/content` cannot feed it — `studio/content.ts`
filters `origin = 'generated'`, because the Made shelf is Studio's own output. Widening it would put
uploads on the Made shelf, which is a behaviour change to a shared surface and is not ours.

**`GET /media?type=videos` already does the job**: athlete-scoped, `status='stored'`, returns
`asset_id`, `video_url`, `duration_seconds` and an `origin` badge, and takes `source=upload`. So I
predict layer 4 adds NO server route for the picker, and that the temptation to add one is the
thing to resist.

### Specific predictions

1. **`WatchKind` decides two things now, not one.** Today it decides only `watchLimitMs`. Adding
   `"stitch"` also decides WHICH URL `readJob` hits, which is the first time that type has carried
   routing. I predict the honest shape is for the kind to select a reader function, not for
   `readJob` to grow an `if`.
2. **The stitch watch reuses the video clock, and `unknown` is the right word when it runs out.**
   Server worst case is `maxAttempts` (3) × `leaseMs` (20 min) = 60 minutes; the video clock is 30.
   So a stitch on its third attempt outlives the client's clock WHILE STILL ALIVE. That is exactly
   what `VideoEntryPhase.unknown` was defined for — "nothing says it went wrong, only that we
   stopped being able to tell" — so I predict reuse rather than a third constant, and that the
   temptation to show `failed` there is the bug.
3. **⚠️ `ClipPlayer` is `muted = true` by default, which makes the MUSIC step unverifiable.** It is
   the right default for an observation surface that autoplays and loops, and it is the wrong one
   for the output of a pipeline whose last stage is audio. `nativeControls` means she CAN unmute,
   but a bed nobody hears is a bed nobody can review. I predict a `muted` prop defaulted to today's
   value, so every existing caller is byte-identical and only the stitch result opts out.
4. **The bed is NOT one of her assets, and that is forced rather than chosen.** `media_assets.media_type`
   is IMAGE | VIDEO | REELS | CAROUSEL\_\*; there is no AUDIO, and `materialize.ts` resolves only the
   video ones. So a bed cannot be an asset id without a shared-schema change, which is not ours to
   make. I predict a server-side ALLOWLIST keyed by name — the same argument as target names, for
   the same reason — with the stored spec holding the name, so a bed can be replaced without
   rewriting frozen rows.
5. **The bed's BYTES are the one thing I cannot finish.** Putting a file in the media bucket is a
   live-infra write and is Adi's to run. I predict I build the allowlist, the parser, the
   materialization and the tests against a locally generated fixture, and hand over one command
   plus an ffmpeg recipe for a placeholder loop that is CC0 by construction because we made it.
   The alternative — committing a binary — cuts against this repo's own convention: V6's
   `testFixtures.ts` generates every clip from lavfi precisely so no binary assets live in git.
6. **The bed changes the memory arithmetic, and the budget must learn about it.** It is another file
   downloaded into the same tmpfs, and `assertTimelineFits` currently counts only clips. A looped
   bed is small, but "small" is not a number and layer 3's whole lesson was that an uncounted file
   is charged at zero. I predict the bed is charged at its own ceiling against the same source
   budget.
7. **Pipeline 2 is a shell and must be obviously one.** A placeholder that looks functional is worse
   than none: it invites a bug report about a feature that does not exist. I predict it renders its
   name, says plainly that it is not built, and wires to nothing — no route, no flag, no state.
8. **It all lives in the provisional `VideoTab`.** V4 built that tab explicitly to be deleted
   ("Nothing here may be load-bearing"), and the timeline builder is exactly the kind of thing that
   should not touch Now or Made before it has been used once. I predict zero diff to MadeShelf,
   ThreadCards or `StudioHomeScreen` beyond mounting.

### What I am NOT claiming

- **Not that the UI has been seen.** `STUDIO_ENABLED` is off, so this merges dark and neither
  surface can be reached without a flag flip; the iOS-simulator and phone-width-Chrome checks
  CLAUDE.local.md asks for are Adi's, after the flip.
- **Not that the bed sounds right.** A generated placeholder loop proves the PATH — that a bed is
  fetched, ducked under the programme and present in the output — and says nothing about music.
- **Nothing about real tmpfs**, as at every layer above.
