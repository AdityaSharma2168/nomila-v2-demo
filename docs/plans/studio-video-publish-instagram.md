# Studio · posting a stitched video to Instagram

Branch `studio/video-publish-instagram` on `d3ef80d`. One PR, nine commits, **merge with `--merge`,
never squash** — commit 6 (the edit-list flags) and commit 3 (the compare-and-set) are each the only
behaviourally meaningful revert for what they hold.

**What ships dark.** `STUDIO_PUBLISH_MODE` is unset ⇒ `off`: the three routes 404, the client draws
no pill, and the tick makes no call to Meta. Commit 6 is the one change live on merge — every new
stitch is written without edit lists (measured: same bytes, same frames, both streams at 0.000).

## The guarantee, and where it is held

**Instagram's publish is called at most once per job row, ever.** Held by one statement —
`recordPublishAttempt` in `server/studio/publish/jobs.ts`, a compare-and-set that returns true once
in the life of a row (and only for a row whose `mode = 'live'`). Not by the tick's lock, the reaper's
order, or the runner's care: two runners holding the same stale row post once (RC-W1).

Anything other than an explicit, recognised refusal from `publish` is "it may have posted": the
container is **read** — `PUBLISHED` ⇒ succeeded, with no permalink because no container field returns
the media id — and otherwise she is told exactly that. Never re-sent. Her retry is a new row.

## Changes from the plan I gave, each in its commit message

| #   | Plan                                       | Built                                                  | Why                                                                                                                 |
| --- | ------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 3   | reaper fails an orphan first, like video's | reaper **requeues** it; the runner reads the container | a Veo handle cannot be asked about; a container can. Same guarantee, one level lower, fewer false "may have posted" |
| 6   | `-use_editlist 0`                          | `-use_editlist 0` **and** `+negative_cts_offsets`      | the ratified flag alone delays video 67 ms behind audio (measured table in `plan.ts`)                               |
| 6   | "stitch arg assertions move"               | 0 moved                                                | nothing pins the arg tail                                                                                           |
| 8   | —                                          | refuse > 25 Mbps average                               | CRF has no rate ceiling; Meta's refusal would become a re-stitch loop                                               |

## Ledger — settled, and still open

|     | Item                                         | State                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | "no edit lists" vs ffmpeg's defaults         | **SETTLED by measurement.** Default writes 2 `edts`; the two-flag fix writes 0 with both streams at 0.000. Named tests `INSTAGRAM: …` in `stitch.test.ts`. **Open:** does Meta's parser accept a version-1 `ctts`? Predicted yes (ISO BMFF; iOS writes them). Fallback `-bf 0` (+19 % bytes). Settled by the test-app post. |
| b   | does Meta's fetcher accept a signed GCS URL? | **OPEN** — cannot be dry-run (needs the container POST). Signal on failure: job ends `fetch_failed` (Meta 9004/2207052 or 2207003). Better fallback than a public object: Meta's **resumable upload** (`rupload.facebook.com/ig-api-upload/<container>`), which never exposes her file.                                     |
| c   | 25 Mbps                                      | **MITIGATED, cure open.** Measured crf 23 @1080×1920: 5.8 / 11.3 Mbps coherent, 80 / 193 pathological. Route refuses on average rate. **Adi's call:** `-maxrate 20M -bufsize 40M` at `plan.ts` — touches every stitch.                                                                                                      |
| d   | `Authorization: Bearer` on the GETs          | **OPEN, settled by dry-run.** Meta's examples show Bearer on POSTs only. If GETs reject it, dry-run's publishing-limit read fails as `reconnect` — a FALSE reconnect. That is the thing to look for in step 3 below.                                                                                                        |
| e   | `content_publishing_limit` host              | docs example shows `graph.facebook.com`; we call `graph.instagram.com` like every other call. Same dry-run read settles it.                                                                                                                                                                                                 |
| f   | recovered orphan has no permalink            | by design: no container field returns the media id. `content_posts.permalink` is NULL for those rows.                                                                                                                                                                                                                       |
| g   | caption length                               | counted in UTF-16 units — the larger count — so we never exceed Meta's 2,200 however Meta counts.                                                                                                                                                                                                                           |

## Runbook — Adi's parts, in order

**0. Push and PR** (I never push):

```bash
cd /Users/adi/nomila-v2-worktrees/video-publish-instagram
git log --oneline d3ef80d..HEAD          # nine commits, tip as reported
git push -u origin studio/video-publish-instagram
gh pr create --base main --title "Studio: post a stitched video to Instagram (dark, STUDIO_PUBLISH_MODE=off)" --body-file docs/plans/studio-video-publish-instagram.md
```

**1. Migration 0059** — additive, one new table, re-runnable, nothing altered. Against dev:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0059_studio_publish_jobs.sql
```

(deploy-dev applies it anyway via `db-migrate.sh` step 3; the drift gate needs file + list line +
schema.ts together, and they are one commit.)

**2. Scheduler line** — add to `JOBS=(…)` in `scripts/provision-schedulers.sh`, then apply:

```
"studio-publish-tick|* * * * *|/api/internal/studio-publish-tick|120s"
```

Safe to create before the flip: with the mode off the tick only closes waiting jobs and never calls
Meta. Locally no scheduler is needed — the route kicks a tick, and a job still waiting on Instagram
is re-looked-at by the next kick or by `curl -X POST -H "x-cron-secret: …" :8080/api/internal/studio-publish-tick`.

**3. Dry run** — server on this branch with `STUDIO_PUBLISH_MODE=dry`. Needs a token holding
`instagram_business_content_publish` (Mia's line, or your local never-pushed copy of it, then
reconnect on the #530 test app). Stitch → Post to Instagram → confirm. Expect in the server log one
`DRY RUN — nothing was sent to Instagram` line with both bodies and `video_url` redacted to
`…?<redacted: X-Goog-…>`. **Read `quota`**: numbers ⇒ Bearer-on-GET, the host and the scope are all
good (ledger d, e). A `reconnect` failure here with a freshly granted scope ⇒ ledger d, not her token.

**4. First live send — only on your explicit go in conversation.** `STUDIO_PUBLISH_MODE=live`, one
post, test app. It settles ledger a (ctts v1) and b (signed URL). Then read the row:

```sql
SELECT status, error_code, container_id IS NOT NULL AS had_container,
       publish_attempted_at IS NOT NULL AS attempted, ig_media_id IS NOT NULL AS has_media, permalink
  FROM studio_publish_jobs WHERE athlete_id = '<yours>' ORDER BY created_at DESC LIMIT 1;
```

**5. Device pass — OWED, not done by me.** Phone-width Chrome and the iOS Simulator, in `dry`.
Nothing in commit 7 has been seen on a screen.

## Review — the seven checks

1. **Scope.** Outside `server/studio/publish/**` and the client publish files: `shared/schema.ts`
   (+1 table), `scripts/db-migrate.sh` (+1 line), `server/routes/studio.ts` (+2 lines),
   `server/index.ts` (+tick, mirrors V7), `server/studio/video/plan.ts` (output flags),
   `TimelineBuilder.tsx` (+mount). Imports, unmodified: `refreshTokenIfNeeded`, `signedUrl`,
   `setApprovalStatus`, `isUniqueViolation`. **Shared integration untouched** — see the proposal.
2. **Tenancy.** Every route lookup carries `req.athleteId`; the runner uses the claimed row's own
   `athlete_id`; the claim and the reaper are the documented system consumers. RC-E1, E2, R4, J11.
3. **Destructive surface.** One migration (yours to run). No script, deploy or send. A live send
   needs the process AND the row to say `live`, and the variable defaults to off.
4. **Untrusted content.** None enters a prompt — no model is called. Meta's error text goes to the
   log only; she reads our sentences.
5. **Secrets.** Tokens travel as `Authorization: Bearer`, never in a URL; fetch errors are not
   chained as `cause`; dry-run redacts the signed URL. RC-A..F, W7. Fixtures are synthetic.
6. **Gates.** See the PR body for the final-tip numbers.
7. **Reversibility.** Safe live with the flag off. Revert = revert the merge; the table can stay.

**Unsure about:** ledger a(ctts), b, d, e — all need Meta, by design. And whether `currentInstagramAccount`
(newest active row) matches what the rest of the app treats as "her account" when she holds two.
