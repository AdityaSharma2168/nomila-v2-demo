# STUDIO VIDEO — THE FLIP CHECKLIST

> Drafted 2026-09-20, against main `990a67d` (#538). **A draft, written by reading the repo — no
> command in here has been run.** `gcloud` is denied to the author, so nothing about the LIVE project
> was checked: every "verify" step is the check, not a report that it passed. Names that come from a
> file are cited; names that are inferred say so.
>
> The order is load-bearing. Each item lists what it depends on, the exact step, and what proves it
> worked. Do them in order; do not start item N+1 on an unverified item N.

## What "the flip" is

`STUDIO_VIDEO_ENABLED=true` on a deployed service. Today it is absent from both
`gcp/cloud-run-dev.yaml` and `gcp/cloud-run-prod.yaml`, which the server reads as OFF
(`server/studio/config.ts`). Nothing below is needed while it stays off; everything below is needed
before it goes on, because a clip on the product path is QUEUED, worked by a runner, billed by a
provider whose key is not mounted, and stitched with a bed that does not exist.

Already closed, and why they are not on this list: a clip's duration reaches the run (#533, #535);
the first frame is cut to the clip's shape (#534); a chip tap re-quotes the board (#538).

---

## 0 · Before anything — the rollback you will want

|            |                                                                                                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Step**   | Note the current revision of each service, so "roll back" is a name and not a search. `gcloud run revisions list --service=<svc> --region=us-central1 --limit=3` for dev and prod.                         |
| **Verify** | Two revision names written down. The flag is an env var in the yaml, so the real rollback for the FLIP is: set it back to `"false"` and redeploy. A revision rollback is for a bad deploy, not a bad flag. |

---

## 1 · The OpenRouter key — Secret Manager, then BOTH yamls

B-roll (seedance) and bridges (Kling) run through `server/studio/adapters/openrouter.ts`, which reads
`process.env.OPENROUTER_API_KEY`. **That variable is in neither yaml today** (checked:
`grep OPENROUTER gcp/*.yaml` → nothing). With the flag on and no key, identity clips (Vertex) work and
every b-roll and bridge fails at submit — after the approval is consumed.

|                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1a · Create the secret**      | `printf '%s' "$KEY" \| gcloud secrets create OPENROUTER_API_KEY --data-file=- --replication-policy=automatic --project=gamechanger-pocket-agent` — `printf '%s'`, NOT `echo`: `provision-schedulers.sh` documents a secret stored with a trailing `\r` that cost two jobs months of 401s. If the probes already created this secret (the bake-off read one by this name), ADD A VERSION instead: `gcloud secrets versions add OPENROUTER_API_KEY --data-file=-`. |
| **Verify 1a**                   | `gcloud secrets versions access latest --secret=OPENROUTER_API_KEY \| wc -c` equals the key's exact length — no +1.                                                                                                                                                                                                                                                                                                                                              |
| **1b · Decide: one key or two** | Dev and prod sharing one key means a dev mistake spends prod's credit and the two cannot be capped separately. Every other prod secret in the yaml is its own (`PROD_CRON_SECRET`, `NOMILA_PROD_DATABASE_URL`). **Recommended: `PROD_OPENROUTER_API_KEY`, a second OpenRouter key with its own credit limit.** A decision, not a step.                                                                                                                           |
| **1c · Mount it, both yamls**   | In each of `gcp/cloud-run-dev.yaml` and `gcp/cloud-run-prod.yaml`, beside the existing `CRON_SECRET` block, the same shape that block uses: `- name: OPENROUTER_API_KEY` / `valueFrom:` / `secretKeyRef:` / `name: OPENROUTER_API_KEY` (prod: the prod secret's name) / `key: latest`. ⚠️ `gcp/**` ships to prod and is out of Claude's lane — this edit is Adi's or Mia's.                                                                                      |
| **Verify 1c**                   | After the next deploy: `gcloud run services describe <svc> --region=us-central1 --format='value(spec.template.spec.containers[0].env)' \| tr ';' '\n' \| grep OPENROUTER` shows a `secretKeyRef`, never a literal value.                                                                                                                                                                                                                                         |

## 2 · Secret Accessor on the runtime service account

Both yamls run as `gamechanger-runtime@gamechanger-pocket-agent.iam.gserviceaccount.com`
(`serviceAccountName`, dev :21, prod :41). A `secretKeyRef` to a secret that account cannot read does
not fail quietly: **the revision fails to start**, and the deploy rolls nothing forward.

|                |                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Step**       | Per new secret: `gcloud secrets add-iam-policy-binding OPENROUTER_API_KEY --member=serviceAccount:gamechanger-runtime@gamechanger-pocket-agent.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --project=gamechanger-pocket-agent` (and again for the prod-named secret if 1b chose two). Do this BEFORE the deploy that mounts it. |
| **Verify**     | `gcloud secrets get-iam-policy OPENROUTER_API_KEY` lists that member under `secretAccessor`. Then, after deploy, the new revision is `Ready` — a missing binding shows up there and nowhere earlier.                                                                                                                                                  |
| **Depends on** | 1a.                                                                                                                                                                                                                                                                                                                                                   |

## 3 · Rotations — the cron secret and the Postgres password

⚠️ **The author does not know WHY these are on the list** — the ask named them without a reason
(exposure in a log? a laptop? routine?). The reason decides urgency and whether old versions must be
DESTROYED rather than disabled. Write it here before doing them.

### 3a · Cron secret

Every scheduler job authenticates with `x-cron-secret`; the server compares against `CRON_SECRET`
(`server/index.ts:126`, trimmed). Dev mounts `INTERNAL_CRON_SECRET`; prod mounts `PROD_CRON_SECRET`.

|                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Step**       | (1) `openssl rand -hex 32 \| tr -d '\n' \| gcloud secrets versions add INTERNAL_CRON_SECRET --data-file=-` — 64 hex chars, which is the length `provision-schedulers.sh` REFUSES to proceed without. (2) Redeploy the service so it reads the new version (`key: latest` resolves at revision start, not live). (3) Re-run the scheduler script so every job's header carries the new value: `APPLY=1 bash scripts/provision-schedulers.sh` — it is idempotent and repairs headers on existing jobs. Prod: the same with `SERVICE_URL=… JOB_SUFFIX=-prod CRON_SECRET_NAME=PROD_CRON_SECRET`. |
| **The window** | Between (2) and (3) every scheduled job 401s. It is minutes; do (3) immediately. Doing (3) before (2) inverts it — same window. There is no zero-downtime order with one secret.                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Verify**     | `gcloud scheduler jobs run workflow-tick --location=us-central1` then `gcloud scheduler jobs describe workflow-tick --location=us-central1 --format='value(status.code)'` — empty/0 is success; `16` is UNAUTHENTICATED, i.e. the header and the service disagree.                                                                                                                                                                                                                                                                                                                           |

### 3b · Postgres password

`DATABASE_URL` is a whole URL in one secret (`NOMILA_V2_DATABASE_URL` dev, `NOMILA_PROD_DATABASE_URL`
prod), so a password rotation is TWO writes that must agree: the database user, and the URL.

|                |                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Step**       | (1) `gcloud sql users set-password postgres --instance=<instance> --prompt-for-password`. (2) Immediately add a new version of the URL secret carrying the new password — URL-ENCODE it; a `@` or `/` in a raw password silently produces a URL that parses to the wrong host. (3) Redeploy. Instances: dev `nomila-v2-db`; prod is `nomila-prod-db` (from session memory, not from a file read today — confirm). |
| **The window** | From (1) until the new revision is serving, the running revision's pool holds open connections (they survive) but every NEW connection fails. Do it at low traffic and do (2)+(3) within the minute.                                                                                                                                                                                                              |
| **Verify**     | `/health` on the new revision is 200, and the server log has no `password authentication failed`. Then update the local `.env` (`scripts/setup-dev-env.sh` rebuilds it — and also widens the Cloud SQL allowlist, which is why it is never run unprompted).                                                                                                                                                       |

## 4 · The video-tick schedulers — and the D6 decision, which comes FIRST

A queued clip is worked by `POST /api/internal/studio-video-tick` (`server/index.ts`). **No scheduler
calls it on dev or prod** (Adi listed them 2026-09-20; only `studio-stitch-tick-dev` exists). Locally
the route kicks a tick inline on generate, which is why clips run on a laptop; on Cloud Run that
inline kick still happens, but a job that outlives one tick's poll window is only ever resumed by
the NEXT tick. Without a scheduler a slow clip is paid for and never collected.

### 4a · ⚠️ DECISION TO MAKE — D6: what does the tick do while the flag is off?

The endpoint checks the cron secret and nothing else; it does not read `STUDIO_VIDEO_ENABLED`
(ledger D6). Once a scheduler exists, that relationship stops being an accident and has to be chosen:

|                      | refuse while off                                                                                                                          | drain regardless                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Means**            | The tick returns early when the flag is off.                                                                                              | The tick always works the queue.                                                                                                                                         |
| **For**              | A scheduler created ahead of the flip is inert. "Off" means off: nothing spends.                                                          | A job queued before a ROLLBACK still completes. Its approval is already consumed and, if submitted, the provider is already paid — refusing strands a clip she paid for. |
| **Against**          | Turning the flag off mid-flight abandons in-flight jobs until it is turned back on (their leases lapse; they are not lost, just stalled). | "Off" does not stop spend that is already queued. A runaway queue cannot be stopped with the flag.                                                                       |
| **Shape of the fix** | One guard at the top of the endpoint.                                                                                                     | No code; a written sentence on this page and in the ledger.                                                                                                              |

A middle option exists and is probably right: **never SUBMIT while off, always POLL-AND-COLLECT** —
no new money leaves, and nothing already paid for is stranded. It is the most code (the runner's
submit-once decision is where the guard goes) and needs its own revert check. **Owner: Adi + Mia.
Not decided. Do not create the schedulers until it is.**

### 4b · Create them

Schedulers are declared in `scripts/provision-schedulers.sh` (`JOBS=(…)`, format
`name|cron|path|deadline`) — not created by hand; the script's header is the story of what hand-made
jobs cost. `studio-stitch-tick-dev` is NOT in that array today, so it was hand-made: add it in the
same edit so the record is whole.

|                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Step**       | Add `"studio-video-tick\|* * * * *\|/api/internal/studio-video-tick\|120s"` (every minute, matching `workflow-tick`; the deadline must exceed one tick's poll window, `STUDIO_VIDEO_TICK_POLL_MS`). Dry run: `bash scripts/provision-schedulers.sh`. Apply dev: `APPLY=1 bash scripts/provision-schedulers.sh`. Prod: with `SERVICE_URL=https://nomila-v2-prod-241621020090.us-central1.run.app JOB_SUFFIX=-prod CRON_SECRET_NAME=PROD_CRON_SECRET`. ⚠️ `scripts/` edits that touch live infra are Adi's to apply. |
| **Verify**     | `gcloud scheduler jobs list --location=us-central1 \| grep video-tick` shows both. `gcloud scheduler jobs run studio-video-tick --location=us-central1`, then the service log shows the tick's JSON (`claimed`, `reaped`, …) and no 401. With an empty queue `claimed: 0` IS the pass.                                                                                                                                                                                                                             |
| **Depends on** | 3a (or the jobs are created with a secret about to change), 4a.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 5 · Prod deploy, with migrations 0056–0058

`0056_studio_video_jobs`, `0057_studio_stitch_jobs`, `0058_media_assets_duration_precise` are listed
in `scripts/db-migrate.sh` step 3 (`:158-160`). Dev has them if deploy-dev has run since they merged;
**prod has whatever the last promotion carried** — check, do not assume.

|                         |                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Step**                | Production moves one way: run the **Promote main to production** workflow (`.github/workflows/promote.yml`, `workflow_dispatch`, allow-listed promoters). It fast-forwards `production` to `main`, tags, and dispatches `deploy-prod.yml`, which takes a manual Cloud SQL backup, runs `bash scripts/db-migrate.sh` through the Auth Proxy, deploys, and smokes `/health`. The database changes FIRST, by design. |
| **Verify**              | (1) The deploy run's migration step prints the three files applied and ends with the drift gate's "No drift" — note the gate compares NAMES ONLY, so it proves the columns exist, not their types. (2) `/health` 200. (3) The backup step's restore point is listed: `gcloud sql backups list --instance=nomila-prod-db --limit=1`.                                                                               |
| **Why before the flag** | With the flag on and 0056 absent, the first clip fails inserting into a lease column that does not exist — after the approval is claimed.                                                                                                                                                                                                                                                                         |
| **Depends on**          | 1c + 2 for prod (or the revision will not start).                                                                                                                                                                                                                                                                                                                                                                 |

## 6 · The music bed

`bedsReady()` is `STUDIO_STITCH_BEDS_READY === "true"` (`server/studio/video/beds.ts`). Until then the
picker says no music is available and the route 400s a bed by name — nothing fails. The allowlist has
one entry: `placeholder` → `studio/beds/placeholder-loop.m4a`.

**Changed by the captions + music card:** the placeholder is now **unlisted** (still a valid name, no
longer offered), so with the flag on and no real track listed the picker is honestly empty. Real
tracks are added one at a time; each needs its block in `server/studio/video/BEDS-LICENSES.md`
(licence shown, track page, artist, **date retrieved**, SHA-256 of the download, who listened) and
`beds.test.ts` fails a listed bed without one. The flag is still all-or-nothing, so **every listed
track must be uploaded before it is turned on.** She can also pick how loud the bed sits
(`bedLevel`: low / medium / high) — a name, never a number.

**Six tracks are listed and live on DEV** (2026-09-20): `walking-away`, `doodles`, `tokyo-sunset`,
`hope-on-repeat`, `we-drove-all-night`, `only-human` (⚠️ the page marks that one "Instrumental: No";
Aditya listened and heard no vocals — see its block), all
HoliznaCC0 / CC0-1.0, uploaded to `gs://nomila-v2-athlete-media/studio/beds/`. Before the **prod**
upload: (1) someone listens to each one start to finish for sampled vocals or recognisable
recordings and fills that line in `BEDS-LICENSES.md` — it is recorded there as NOT yet confirmed;
(2) the same six objects go to the prod bucket under the same names; (3) only then the flag.

**PR 8 adds four licensed tracks under the same switch** (2026-09-22): `walking-around`, `status`,
`with-your-hands`, `save` — Artlist, `server/studio/music/tracks.ts`, uploaded and MD5-verified to
`gs://nomila-v2-athlete-media/studio/tracks/` only. `STUDIO_STITCH_BEDS_READY` gates BOTH catalogues
(`beds.ts` joins them), so in prod it must not go on until the tracks are in prod's bucket too — 6d.

|                                    |                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **6a · The file**                  | The placeholder is a generated sine loop — CC0 by construction, because we made it (`docs/probes/video-v7-bed-placeholder.md` has the ffmpeg recipe). ⚠️ It is a PLACEHOLDER: a 220 Hz tone under a highlight reel is not shippable to athletes. A real bed needs a real licence — CC0 or owned outright, with the source URL and licence text committed beside the allowlist entry. **A decision and a sourcing task, not a command.** |
| **6b · Upload**                    | `gsutil cp <file> gs://nomila-v2-athlete-media/studio/beds/<name>.m4a` (bucket and path from the placeholder doc). Prod DOES use a different bucket — `nomila-prod-athlete-media` (`gcp/cloud-run-prod.yaml`, `MEDIA_BUCKET`; read 2026-09-22) — so prod is a second upload: 6d.                                                                                                                                                                                                                        |
| **6c · The env var — IN THE YAML** | The placeholder doc's step is `gcloud run services update … --update-env-vars STUDIO_STITCH_BEDS_READY=true`. ⚠️ That is overwritten by the next deploy, because the yaml is the source of truth and does not carry it. Put `STUDIO_STITCH_BEDS_READY: "true"` in the yaml(s) instead.                                                                                                                                                  |
| **6d · PROD upload — beds AND tracks, BEFORE the switch** | Keyed on `STUDIO_STITCH_BEDS_READY`: it must NOT be `"true"` in `cloud-run-prod.yaml` until every listed bed AND every track in `tracks.ts` exists in `nomila-prod-athlete-media` at the same path. Copy bucket-to-bucket, so prod gets the bytes that were verified on dev: `gsutil cp gs://nomila-v2-athlete-media/studio/tracks/<id>.m4a gs://nomila-prod-athlete-media/studio/tracks/<id>.m4a` for each of walking-around, status, with-your-hands, save; and `…/studio/beds/<name>.m4a` for each listed bed. |
| **6d · Hash verify**               | `gsutil ls -L gs://nomila-prod-athlete-media/studio/tracks/ \| grep -E "gs://\|Hash \(md5\)"` — each MD5 must equal that track's `md5Base64` in `server/studio/music/tracks.manifest.json`. Beds: each prod MD5 equals `gsutil ls -L` of the same object in `nomila-v2-athlete-media`. Any mismatch or missing object: the switch stays off. |
| **6e · Free music library — its OWN switch** | The 83 free-library tracks (`server/studio/music/library.manifest.json`, post-kit music choices) are gated by `STUDIO_MUSIC_LIBRARY_READY`, NOT by `STUDIO_STITCH_BEDS_READY`. Before it is `"true"` in an environment's yaml: copy bucket-to-bucket (`gsutil -m cp gs://nomila-v2-athlete-media/studio/tracks/free/*.m4a gs://<that bucket>/studio/tracks/free/`), then **`python scripts/music/verify_bucket.py <that bucket>` must print `OK 83/83`** (every manifest id present, every MD5 equal to its `md5Base64`; it exits non-zero otherwise). Any miss: the switch stays off. Dev bucket verified 83/83 on 2026-10-12. Also needed for kits to use it: `AGENT_POST_KIT_MUSIC_CHOICES=true`. |
| **Verify**                         | `gsutil ls -l gs://nomila-v2-athlete-media/studio/beds/`; then a stitch with `bed: "placeholder"` succeeds and the manifest reports the bed mixed.                                                                                                                                                                                                                                                                                      |
| **⚠️ Known, recorded**             | Ledger **D4**: the stitch runner passes `{ source }` only, so the bed is mixed FLAT at 0.25, never ducked. Inaudible while every clip is silent — which they are: audio is parked. Must be fixed before clip audio is ever turned on.                                                                                                                                                                                                   |

## 7 · Day-cap reconciliation

`STUDIO_MAX_DAY_USD` (default 25, `config.ts:867`) counts QUOTES, banked when the job row is
inserted — never invoices. That is the safe direction (it cannot read $0 while money leaves) and it
is also not the truth: video runs slightly over quote (token SKUs bill `fps × N + 1` frames), and
Vertex video has no invoice at all — its "cost" is the estimate (`adapters/vertex.ts`, basis
`estimated`).

|                                 |                                                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Decide the numbers**          | Prod `STUDIO_MAX_JOB_USD` is `"5"` (yaml :323); dev `"30"`. `STUDIO_MAX_DAY_USD` is in NEITHER yaml, so both run the code default of $25/athlete/day. With 8s identity clips at $1.60, that is 15 clips. Choose prod's number on purpose and write it in the yaml.       |
| **The reconciliation itself**   | Not built. What it is: a daily job comparing the sum of quotes banked against (a) OpenRouter's reported usage for the key and (b) the GCP billing export for Vertex, alerting past a tolerance. **Its own card.** Until it exists, the manual version is the step below. |
| **Verify (manual, first week)** | Daily: `select sum(cost_estimated_usd) from generation_jobs where created_at > now() - interval '1 day' and mode = 'generate' and deliverable in ('clip','reel');` against the OpenRouter dashboard's day total. A gap over ~5% is a finding.                            |

## 8 · The flips — dev first, then prod, never together

|               |                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **8a · Dev**  | In `gcp/cloud-run-dev.yaml`: `STUDIO_ENABLED: "true"` if not already, and ADD `STUDIO_VIDEO_ENABLED: "true"` beside it (it is absent today, which reads as off). Merge → deploy-dev. The client needs `EXPO_PUBLIC_STUDIO_ENABLED` baked into a build (the yaml's own comment says so); there is NO client-side video flag — the server's preview decides whether a clip has a plan. |
| **Verify 8a** | On the dev web build: a storyboard row → a quote appears → Make the board → the clip arrives. Then the job row, not the clip: `brief->'job'` carries `durationSeconds` and any `shot` she set, `provider`/`model` match the quote, and the log shows `first frame checked against the clip's aspect before send`. A clip that LOOKS right is not the evidence (#538's lesson).       |
| **Soak**      | Dev stays on for a stated period — suggest a week and at least 20 real clips — with item 7's manual check run daily.                                                                                                                                                                                                                                                                 |
| **8b · Prod** | The same yaml edit in `gcp/cloud-run-prod.yaml`, then Promote. Only after: 1–7 verified ON PROD, the dev soak clean, and the first-frame probe (`docs/probes/video-first-frame-crop-probe.md`) read.                                                                                                                                                                                 |
| **Verify 8b** | The same end-to-end check on prod with Adi's own athlete, one clip, before anyone is told.                                                                                                                                                                                                                                                                                           |
| **Rollback**  | Set `STUDIO_VIDEO_ENABLED` back to `"false"` and redeploy. What happens to in-flight jobs is exactly the D6 decision (4a) — which is why 4a is not optional.                                                                                                                                                                                                                         |

---

## 9 · Posting to Instagram — ITS OWN SWITCH, not part of this flip

`STUDIO_PUBLISH_MODE` = `off` | `dry` | `live`. **Unset means `off`, and it stays `off` in prod at
flip time.** Publishing goes live by its own decision, not with `STUDIO_VIDEO_ENABLED`: the video
flag spends money, this one makes public posts on real people's accounts, and neither should be able
to turn the other on. One variable, three values — there is no second flag for it to disagree with,
and anything that is not exactly `dry` or `live` (a typo, `Live`, `true`) reads as `off`.

|                |                                                                                                                                                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Blocked on** | (1) `instagram_business_content_publish` in the shared `SCOPES` — Mia's, see `docs/proposals/instagram-publish-scope.md`. (2) Meta App Review for that permission on the PROD app. Until both, `live` in prod can post for nobody.                                                                          |
| **Step**       | Migration 0059 (applied by `db-migrate.sh` step 3). Scheduler: add `"studio-publish-tick\|* * * * *\|/api/internal/studio-publish-tick\|120s"` to `JOBS=(…)` in `scripts/provision-schedulers.sh` and apply — safe ahead of time, the tick calls Meta only in `live`. Then dev: `dry` first, `live` second. |
| **Verify**     | `dry`: one `DRY RUN — nothing was sent to Instagram` log line per post, `video_url` redacted, `quota` populated. `live`: `studio_publish_jobs` row `succeeded` with a permalink, and exactly one post on the account.                                                                                       |
| **Rollback**   | Set it to `off`. Waiting jobs are FAILED, not drained — nothing here has been paid for, and the safe state of an unposted video is unposted. A job already past its publish attempt still resolves truthfully (posted, or "may have posted").                                                               |

Runbook, ledger and the open items Meta alone can settle: `docs/plans/studio-video-publish-instagram.md`.

## 10 · The Agent and the filtered-clip retry — TWO switches, and the retry stays off

| Flag                       | Side                   | Default | What it switches                                                                                                                               |
| -------------------------- | ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `STUDIO_AGENT`             | server                 | off     | `POST /studio/agent/plan`. Off is a 404 before anything is loaded or called — **the real gate**.                                               |
| `EXPO_PUBLIC_STUDIO_AGENT` | client, **build-time** | off     | Whether the Board draws "or let the agent build this for you". A build with it on against a server with it off gets "Not found", never a plan. |
| `STUDIO_AGENT_RETRY`       | server                 | off     | The one re-roll of a filtered clip — below. No client half.                                                                                    |

⚠️ **`EXPO_PUBLIC_*` IS BAKED INTO THE BUNDLE, AND WHERE IS NOT VERIFIED.** Client flags are inlined at
build time, and this repo sets them in four places: the `eas.json` build profiles,
`.github/workflows/deploy-prod.yml`, `deploy-web-dev.yml` and `eas-update-preview.yml`. **None of them
sets any `EXPO_PUBLIC_STUDIO_*` today** — `EXPO_PUBLIC_STUDIO_ENABLED` included, which is why Studio
is off in every build. Which of the four produced the build on a given device is not checked here,
so turning a client flag on is a new bundle from the right one, not a config change — and
`.github/workflows/**` is out of Claude's lane.

`STUDIO_AGENT` is the Agent tab — the surface. `STUDIO_AGENT_RETRY` is the one re-roll of a clip the
video model made and then withheld on a content check (`content_filtered`, studio/refusal.ts). **They
are separate on purpose, and `STUDIO_AGENT_RETRY` stays unset in every environment at flip time.**
Turning the Agent on for a demo must not buy anything the day cap cannot see; a test pins that
`STUDIO_AGENT=true` alone never re-rolls.

|                  |                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Why it's off** | A filtered clip was already generated and BILLED. A re-roll buys a second one on the SAME `generation_jobs` row, and `spentTodayUsd` sums per row — so the second clip is off the day ledger. Fine at "occasionally", not at "often", and nobody has measured which.                                                                      |
| **Blocked on**   | The rate. Count failed video jobs whose `last_error` begins `The video model made this and then held it back on a content check` (the runner's `video job failed` log line carries `code: "content_filtered"` too), against all video jobs over the same window. Read-only, one athlete, the way the other counts in this repo are taken. |
| **Step**         | Only with that number in hand: set `STUDIO_AGENT_RETRY: "true"` beside the other Studio flags in the dev yaml, then prod as its own decision. `STUDIO_AGENT` does not need it and does not imply it.                                                                                                                                      |
| **Verify**       | A filtered job shows two submits and the second operation's handle on the row; an input refusal (`content_blocked`) still shows one.                                                                                                                                                                                                      |
| **Rollback**     | Unset it. The runner goes back to submit-once-and-fail on any refusal, byte for byte.                                                                                                                                                                                                                                                     |

## 11 · Stills — the encode on prod's ffmpeg 5.1 (gates C1b) — PASSED 21 Sep 2026

**Result:** the step below was run as written, in `node:20-slim` with apt ffmpeg 5.1.9-0+deb12u1
(Debian 12.13) and a Linux sharp 0.34.5, natively (aarch64) and under `--platform linux/amd64`:
**7/7 both times**, including "a photo flagged sideways comes out upright", "arrives in the engine's
own profile" and "does not turn the whole stitch full-range". No change to `still.ts` was needed.
C1b was started on it (`docs/plans/studio-still-board.md`).

A held photo (`stillSec`, PR C1) is turned into a clip by `server/studio/video/still.ts` before the
stitch engine runs. **Every measurement behind its flags was taken on ffmpeg 9.0.1** (the laptop);
production runs Debian's ffmpeg 5.1 (`Dockerfile:30`, `node:20-slim`), and CI runs Ubuntu's. Two
behaviours were measured to depend on context: a looped JPEG's colour RANGE (a full-range still turned
a whole stitch full-range) and EXIF orientation (ffmpeg 9 rotates on its own). The encode is written
not to depend on either — sharp bakes orientation, the scale converts to limited range and BT.709 —
but "written not to depend" is a claim, and this is its check.

|                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Depends on** | C1 merged and deployed to dev. Not on the flag: the stitch route is not gated on `STUDIO_VIDEO_ENABLED`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Step**       | The runtime image has no jest (`npm install --omit=dev`), so match its base instead: `docker run --rm -v "$PWD":/src node:20-slim sh -c 'apt-get update && apt-get install -y --no-install-recommends ffmpeg && cp -r /src /app && cd /app && rm -rf node_modules && npm ci --ignore-scripts --legacy-peer-deps && npm rebuild sharp && npx jest server/studio/video/still.test.ts --runInBand'` — Debian bookworm, the same apt ffmpeg the Dockerfile installs, and a Linux sharp. Or, on dev: stitch one timeline of an untagged clip with sound, then a still of a photo flagged EXIF 6, joined on a 0.5 s fade, and ffprobe the result. |
| **Verify**     | The suite is green on 5.1 — in particular "a photo flagged sideways comes out upright", "a still arrives in the clips' range and colour matrix" and "a still does not turn the whole stitch full-range". Or, on dev, the stitched file is `yuv420p` with `color_range` not `pc`, the photo is upright, and the length is 2 + hold − 0.5.                                                                                                                                                                                                                                                                                                    |
| **Gates**      | **C1b** (Board still rows and the planner's `image` kind) does not start until this passes. The Video tab's stills do not wait on it — Adi's device check covers them — but a red here is a C1 fix-before-flip.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Rollback**   | None needed for the check. A failure is fixed in `still.ts`'s argv, which the suite pins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 12 · The enrich tick — a bounded batch, a daily cap per athlete (PR 4, C1)

**Code (built, PR 4):** `STUDIO_ENRICH_DAILY_CAP_USD` — per athlete per UTC day, across every run;
every clip call books its settled cost on its row (`metadata.enrich_spend`), a pass leaves an
athlete at the cap for tomorrow (untouched, no attempt), and the day key rolling at 00:00 UTC is the
resume. Unset = no daily cap. `STUDIO_VIDEO_ENRICH_CHUNK` — clips per pass, default 8.

**Why a separate job, not an edit of `media-enrich-cron`:** the route (`server/index.ts:799`) loops
up to `maxTicks` passes per request (default 60) and each pass makes a fresh $2 run budget, so one
request is not one batch. The route reads `maxTicks` from the body — `{"maxTicks":1}` makes a
request one pass. But `provision-schedulers.sh` sends `--message-body="{}"` and rewrites every
listed job on each run, so a hand edit of `media-enrich-cron` would be silently undone. Its own job,
two minutes after a poster tick (the poster runs `*/5`):

| | |
| --- | --- |
| **Step (dev)** | `SECRET="$(gcloud secrets versions access latest --secret=INTERNAL_CRON_SECRET --project=gamechanger-pocket-agent \| tr -d '[:space:]')" && gcloud scheduler jobs create http studio-enrich-tick --project=gamechanger-pocket-agent --location=us-central1 --schedule="2-59/5 * * * *" --time-zone=UTC --uri="https://nomila-v2-241621020090.us-central1.run.app/api/internal/media-enrich-cron" --http-method=POST --message-body='{"maxTicks":1}' --attempt-deadline=300s --headers="x-cron-secret=${SECRET},Content-Type=application/json"` — `tr -d '[:space:]'` is the 401 fix the provisioning script documents. |
| **Step (prod)** | The same with `studio-enrich-tick-prod`, `--secret=PROD_CRON_SECRET`, and `--uri=https://nomila-v2-prod-241621020090.us-central1.run.app/api/internal/media-enrich-cron`. |
| **Before either** | Set `STUDIO_ENRICH_DAILY_CAP_USD` in the service's yaml (`gcp/**`, Adi's or Mia's). With `STUDIO_VIDEO_ENRICH` off (both yamls today) the tick only tags photos and the cap never engages. |
| **Record it** | Add the job to `provision-schedulers.sh` — which needs a per-job body column first (today every job gets `{}`). Shared tooling: a card, not this PR. |
| **Then decide** | Whether `media-enrich-cron` keeps `maxTicks` 60 once the tick exists. The daily cap bounds a day either way; `maxTicks` bounds one request. |
| **Verify** | `gcloud scheduler jobs list --location=us-central1 --project=gamechanger-pocket-agent --format='table(ID.basename(),schedule,state,lastAttemptTime,status.code)'` — `studio-enrich-tick` ENABLED with a recent attempt and no error code; and on the service log `video enrichment chunk done` carries `dailyCapped`. (This read was denied to Claude on 22 Sep 2026 — run it and paste the table into the PR 4 ledger; it also answers C1's "the scheduler ticks".) |

**The startup line (built, PR 4):** the Studio router logs `studio router ready` with `revision`
(`K_REVISION` on Cloud Run, the checkout's short SHA locally) — grep it before trusting an
acceptance run.

## 13 · The client flags in the deploy builds — a card for Adi (PR 4, C2)

**The list is derived, not remembered:** `bash tools/expo-flags/list-expo-flags.sh` prints every
`EXPO_PUBLIC_*` the client reads (9 on 22 Sep 2026: API_URL, IDENTITY_CLAIM, MICROSOFT_CLIENT_ID,
MILA_VOICE_NATIVE, and five STUDIO_* — AGENT, ENABLED, INTERPRETER, SERVER_ROUTING, SESSIONS). There
is **no `EXPO_PUBLIC_STUDIO_BRAND_PROFILES`** — `STUDIO_BRAND_PROFILES` is server-only
(`server/studio/config.ts`). `--script` regenerates the local `expo-dev.sh` with every STUDIO_* on.

**The dev web build** (`.github/workflows/deploy-web-dev.yml`, step "Build Expo web export") sets
`EXPO_PUBLIC_API_URL` alone. At 8a, the step's `env:` gains, beside it:

```yaml
          EXPO_PUBLIC_STUDIO_ENABLED: "true"
          EXPO_PUBLIC_STUDIO_SERVER_ROUTING: "true"
          EXPO_PUBLIC_STUDIO_INTERPRETER: "true"
          EXPO_PUBLIC_STUDIO_SESSIONS: "true"
          EXPO_PUBLIC_STUDIO_AGENT: "true"
```

Prod (`deploy-prod.yml`, "Build Expo web export (production API)", and the OTA step) takes the same
lines at 8b, not before — each is off in prod until its server half is on (a client flag on against
a server flag off is a 404, rendered as "not released", never an error). `eas.json` and
`eas-update-preview.yml` likewise, per profile. **Check after each build:** the list above against
the step's `env:` — a name the script prints that the step does not set is off in that bundle.

## Open decisions, gathered

1. **One OpenRouter key or two** (1b). Recommended: two.
2. **Why the rotations are on this list** (3) — decides urgency and destroy-vs-disable.
3. **D6: refuse / drain / submit-never-collect-always** (4a). Blocks the schedulers.
4. **A real, licensed music bed** (6a). The placeholder is not shippable.
5. **Prod's day cap** (7), and whether reconciliation must exist before 8b or only before scale.
6. **When `STUDIO_AGENT_RETRY` may go on** (10) — only with the measured `content_filtered` rate.
7. **The still encode on ffmpeg 5.1** (11) — a check, not a decision, but C1b waits on it.
8. **The enrich tick** (12) — the daily cap's value, and whether `media-enrich-cron` keeps `maxTicks` 60.

## Parked, and NOT part of the flip

Per-model prompt phrasing (ledger D1 — env drift first) · the runner dropping reference slots (D2) ·
Veo audio (decision memo in the ledger; parked behind D4) · a text check that can fail b-roll signage
(D5).
