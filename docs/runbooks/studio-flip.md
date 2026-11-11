# Studio flip: the runbook for Mia

**What this is.** Everything needed to turn Studio on in production, in order.

- Adi has done the dev half and the prep. The prod half is yours: the promotion and the flag lines.
- The record behind every line is `docs/probes/ship.md` (PR 20, "Ship"). Citations are `file:line` on main at `9dbef288` or later.
- Written 25 Sep 2026.

**How the switch works now (PR 20).**

- **One server line and one client line turn every Studio flag on:**
  - server `STUDIO_ALL_ON: "true"` (`server/studio/studioFlag.ts`)
  - client `EXPO_PUBLIC_STUDIO_ALL_ON: "true"` (`client/lib/flags.ts`)
- **An explicit `"false"` on a single flag still wins.** That is how one feature stays off under the master, and why a stale `"false"` line keeps Studio off.
- **Caps are never switched on by the master.** Each is its own line: `STUDIO_MAX_JOB_USD`, `STUDIO_MAX_DAY_USD`, `STUDIO_ENRICH_DAILY_CAP_USD`, `STUDIO_VIDEO_ENRICH_MAX_RUN_USD`.
- **Publishing is never switched on by it either:** `STUDIO_PUBLISH_MODE`, and `IG_REQUEST_PUBLISH_SCOPE`.

---

## 1 · Done by Adi

| What | When | Evidence |
|---|---|---|
| `OPENROUTER_API_KEY` mounted in both services (b-roll needs it) | **25 Sep 2026** (merged in #604) | `gcp/cloud-run-dev.yaml:188-196`, `gcp/cloud-run-prod.yaml:113-121`; IAM verified (secret version 2 enabled; the runtime account holds `secretAccessor` at project level) |
| Scheduler jobs, dev: `studio-video-tick`, `studio-edit-tick`, `studio-stitch-tick` | **25 Sep 2026** | 200 in the logs; the hand-made `studio-stitch-tick-dev` deleted |
| Scheduler jobs, prod: the same three `-prod`, **created then paused** | **25 Sep 2026** | prod's current image has no tick endpoints yet; **you resume them after the promotion (§4)** |
| `media-enrich-cron` on dev **paused** | **25 Sep 2026** | `studio-enrich-tick` is dev's one scheduled enrichment trigger |
| Music beds uploaded (`studio/beds/*.m4a`, `studio/tracks/*.m4a`) | before 25 Sep 2026 | the 11 objects, and the check for each, are in `docs/probes/ship.md` → "Beds" |
| Dev proof | **25 Sep 2026** | deployed dev with the master on. A smoke test on the 1.2.0 preview build: Create Anything priced, Board priced and made a held shot, Agent reached concepts, Read this clip priced. **The Instagram test:** @fightquant reconnected with the publish scope, the dry run read Meta's publishing quota, and one live reel posted (then deleted from the personal account). The proof is the recording plus its `studio_publish_jobs` row: `live`, `succeeded`, `ig_media_id` set. |
| Prod migrations: the **Studio** files 0054, 0056, 0057, 0058, 0059, 0060, 0061, 0062, 0064, 0066, 0067 | **25 Sep 2026** | by hand, per `docs/probes/ship.md` → "Step 9"; each proved safe under prod's current code. Backup taken first; no errors. The drift check after lists only your six tables (0055, 0063); the three clearance triggers are present and enabled. **0055, 0063, 0065 and 0068–0070 are yours**: your promotion applies them (§4). |

---

## 2 · Your decisions before you promote

1. **Launch timing.** With the lines in §3, every athlete on prod sees Studio: paid generation, video and edits. Is that the launch, and when?
2. **Caps** (per athlete; each is its own yaml line):
   - `STUDIO_MAX_JOB_USD`: prod has `"5"` today (`gcp/cloud-run-prod.yaml:340-341`).
   - `STUDIO_MAX_DAY_USD`: unset means the code default of $25 per rolling day.
   - `STUDIO_ENRICH_DAILY_CAP_USD`: **unset means no daily cap** on video enrichment. Dev runs `"5"`.
   - Two spends the day cap does not count, by design: `STUDIO_DIRECTION_MOMENTS` ($0.035 a search) and `STUDIO_AGENT_RETRY` (one re-roll of a content-filtered clip). If either worries you, add its own `"false"` line.
3. **Publish mode.** Recommended: leave `STUDIO_PUBLISH_MODE` and `IG_REQUEST_PUBLISH_SCOPE` **unset (off)** in prod until Meta approves advanced access (§7).
4. **Your migrations, applied by your promotion and not by Adi:**
   - **0055:** the Mia evaluator tables
   - **0063, 0065 and 0068–0070:** objectives

   They are additive and safe under prod's current code (`docs/probes/ship.md` → "Step 9"). They run in numeric order in `db-migrate.sh`: 0065 after 0063, and 0068–0070 after both. No Studio file depends on them. They're yours to OK before you promote.

## 3 · The flip: exact lines

Make these in one PR, then promote (§4).

**Server, `gcp/cloud-run-prod.yaml`:**
- **Delete lines 338-339**: `- name: STUDIO_ENABLED` / `value: "false"`. Under the master an explicit `"false"` still wins, so leaving it keeps Studio off in prod. (It was 329-330 before PR 20 added the key block above it. The dev yaml had the same line, removed in #604.)
- Add beside `STUDIO_MAX_JOB_USD` (`:340-341`):

```yaml
            - name: STUDIO_ALL_ON
              value: "true"
            - name: STUDIO_ENRICH_DAILY_CAP_USD
              value: "<your value>"          # dev runs "5"
            - name: STUDIO_MAX_DAY_USD
              value: "<your value>"          # optional; unset = $25
```

- Also update the comment block at `:334-337`, which still says "Studio: OFF at beta launch".

**Client, `eas.json` → `build.production.env`** (lines 33-37): add

```json
        "EXPO_PUBLIC_STUDIO_ALL_ON": "true"
```

- That one line reaches all three production bundles: the binary, the OTA, and the `app.nomila.co` web export.
- The deploy workflow reads the production profile for both the OTA and the web export (`scripts/eas-profile-env.cjs`, PR 20).
- **Keep the EAS dashboard's `production` environment empty.** A value there is a second source the repo can't see.

**Don't add** (until §7 is approved): `STUDIO_PUBLISH_MODE`, `IG_REQUEST_PUBLISH_SCOPE`.

## 4 · Promote, then resume the prod ticks

1. **Promote:** Actions → "Promote main to production" → Run → type `promote`.
   - `deploy-prod.yml` then takes a Cloud SQL backup, runs `scripts/db-migrate.sh` (the eleven Studio files are already applied, so they are no-ops; **your 0055, 0063, 0065 and 0068–0070 apply here**), deploys, smoke-tests `/health`, and ships the web and the OTA.
2. **Check the revision is live:**

   ```bash
   gcloud run services describe nomila-v2-prod --region=us-central1 --project=gamechanger-pocket-agent \
     --format='value(status.latestReadyRevisionName,spec.template.spec.containers[0].image)'
   ```

   The image tag must be the promoted commit's short SHA.
3. **Resume the three paused Studio ticks.** Only after step 2: the old image had no such endpoints.

   ```bash
   for j in studio-video-tick-prod studio-edit-tick-prod studio-stitch-tick-prod; do
     gcloud scheduler jobs resume "$j" --location=us-central1 --project=gamechanger-pocket-agent --format=none
   done
   gcloud scheduler jobs list --location=us-central1 --project=gamechanger-pocket-agent \
     --filter='name~studio-' --format='table(name.basename(),state,schedule)'
   ```

   - **Pass:** all three `-prod` jobs show `ENABLED`.
   - A tick whose flag is off returns `{skipped: true}` and spends nothing (D6, `server/studio/tickGate.ts`), so resuming them before the flip is harmless too.

**Scheduler notes (from what Adi hit on 25 Sep 2026):**

- **Content type.** The Studio tick jobs are declared with `Content-Type: application/octet-stream`. With `application/json` they returned 401 when created by hand. Nothing in the server reads the content type before the secret check, so the likeliest cause was the secret itself (next note). The question is still open, carded K-S13. Keep octet-stream.
- **Strip every secret read.** `INTERNAL_CRON_SECRET` is stored with a CRLF ending, and a `$(gcloud secrets versions access …)` read keeps the `\r`, so every call 401s. **Pipe every secret read through `tr -d '\r\n'`.** `scripts/provision-schedulers.sh` already strips.
- **Never let gcloud echo a job back.** `gcloud scheduler jobs create|update` prints the header in full. Always add `--format=none`; the script does.
- **Subset runs.** `ONLY=studio- … APPLY=1 bash scripts/provision-schedulers.sh` touches only those jobs. A full `APPLY=1` re-applies every job, and **creates `research-planner` on dev** (K-S12).

## 5 · Enrichment in prod: one trigger

- **Dev's choice:** `media-enrich-cron` **paused**, and `studio-enrich-tick` (one pass, `{"maxTicks":1}`, every 5 minutes at :02) the only scheduled trigger.
- **Why:** two triggers overlapping on two instances can read a clip twice (paid twice; the second write discarded) and tag a photo twice. The photo lane has no dollar cap.
- **Prod, checked by Adi on 25 Sep 2026:** exactly one trigger, `media-enrich-cron-prod`, **enabled** (up to 60 passes per call, every 15 minutes). There is no in-process media cron; the upload kick is per athlete and event-driven. The paused `nomila-enrichments-dev` targets `gamechanger-api-dev` and is unrelated.

**Your decision:**
- **(a)** Keep `media-enrich-cron-prod` as the only trigger. Nothing to do.
- **(b)** Match dev: create `studio-enrich-tick-prod`, then pause `media-enrich-cron-prod`.

To re-check before (b) (on 25 Sep 2026 it listed only `media-enrich-cron-prod`):

```bash
gcloud scheduler jobs list --location=us-central1 --project=gamechanger-pocket-agent \
  --filter='httpTarget.uri~media-enrich-cron' --format='table(name.basename(),state,schedule,httpTarget.uri)'
```

For (b):

```bash
SECRET="$(gcloud secrets versions access latest --secret=PROD_CRON_SECRET --project=gamechanger-pocket-agent | tr -d '\r\n')"
gcloud scheduler jobs create http studio-enrich-tick-prod --project=gamechanger-pocket-agent --location=us-central1 \
  --schedule="2-59/5 * * * *" --time-zone=UTC \
  --uri="https://nomila-v2-prod-241621020090.us-central1.run.app/api/internal/media-enrich-cron" \
  --http-method=POST --message-body='{"maxTicks":1}' --attempt-deadline=300s \
  --headers="x-cron-secret=${SECRET},Content-Type=application/octet-stream" --format=none
unset SECRET
gcloud scheduler jobs pause media-enrich-cron-prod --location=us-central1 --project=gamechanger-pocket-agent --format=none
```

- ⚠️ With `Content-Type: application/octet-stream`, `express.json()` does not parse the body. The route reads `req.body ?? {}` (`server/index.ts:859`), so `maxTicks` falls back to 60.
- For a one-pass tick, use `application/json` if the curl pair in K-S13 shows it passes; otherwise leave (a).
- Either way, **set `STUDIO_ENRICH_DAILY_CAP_USD`** (§3).

## 6 · iOS: build and submit (version 1.2.0)

`expo.version` is **1.2.0** since PR 20. `runtimeVersion` follows it, so only 1.2.0 binaries take OTAs from main. A 1.1.0 install keeps its last bundle and can no longer receive one that needs native modules it lacks.

```bash
cd <a checkout of the promoted commit>
eas build --profile production --platform ios
eas submit --profile production --platform ios --latest
eas build:list --platform ios --profile production --limit 2 --json --non-interactive \
  | jq '.[] | {appVersion, runtimeVersion, gitCommitHash, status}'
```

- `eas submit` uses `ascAppId 6762380524` and the App Store Connect API key at `./credentials/AuthKey_F2HCDC764D.p8` (`eas.json:40-49`).
- **That key file is gitignored.** It has to exist on the machine that runs `eas submit`.

## 7 · Instagram: requesting advanced access for `instagram_business_content_publish`

**What you have from 25 Sep 2026:**
- **Adi's screen recording, on the dev Meta app, with @fightquant as a tester.** It shows:
  1. connect → Meta's consent screen asking for content publishing
  2. back in the app, a reel stitched from his photos → **Post to Instagram** → the confirm, "This posts to @fightquant now" → Post
  3. the reel live on @fightquant
- The confirm step is the consent moment reviewers look for (`docs/proposals/instagram-publish-scope.md` §4).
- **A write-up of the use.** An athlete posts a video she made in Studio to her own Instagram business or creator account, one post per explicit confirm. There is no scheduled or automatic posting. A job can publish at most once, ever (`server/studio/publish/jobs.ts`, the submit-once pair).

**The button.**
- Meta's tooltip (your screenshot, App Review → Permissions and Features → `instagram_business_content_publish`) says the request unlocks after **a successful test API call**, and can take **up to 24 hours** after the first one.
- That row shows "Ready to use (N)". **We read N as the successful call count. Please confirm.**

**Which app?**
- Adi's calls went through the **dev** app. If you're submitting the **live** app, its button needs a call made **through the live app**.
- That means a connect through prod with the scope requested, then one publish call. The dry run's quota read is enough.
- **Steps for the live app** (after the promotion; short, and yours to time):
  1. Set `IG_REQUEST_PUBLISH_SCOPE: "true"` and `STUDIO_PUBLISH_MODE: "dry"` in `cloud-run-prod.yaml`. Promote.
  2. A **tester** account on the live app connects on `app.nomila.co`, stitches a still reel, and taps **Post to Instagram**. The server log shows `DRY RUN — nothing was sent to Instagram` with `quota` filled.
  3. Within 24 hours the live app's "Request advanced access" should activate. Submit with the recording and the write-up.
  4. Set both lines back to unset and promote again, **unless you have confirmed** what a **non-tester** athlete sees when the live app requests a permission it only has Standard access for. It is either "the permission is quietly not granted" or "the connect fails", and we couldn't verify which from code.

**Stored scopes are not proof.** A connection's `scopes` column can claim the permission without Meta granting it (K-S8 below). The dry run's quota read is the proof.

## 8 · Rollback

**Studio off, fast** (minutes):

```bash
gcloud run services update nomila-v2-prod --region=us-central1 --project=gamechanger-pocket-agent \
  --update-env-vars=STUDIO_ALL_ON=false --format=none
```

- Every Studio route answers 404, and every tick returns `skipped`.
- A job already submitted to a provider is resumed once the flag is back; nothing is lost.
- **Then make it stick.** The next promotion replaces the service from the yaml, so set `STUDIO_ALL_ON: "false"` there (or remove the line), and remove `EXPO_PUBLIC_STUDIO_ALL_ON` from `eas.json` production, in a PR. Until the next OTA the client shows Studio screens that answer "not released".
- Optionally pause the three `studio-*-prod` jobs (§4, with `pause`).

**A bad revision:**

```bash
gcloud run services update-traffic nomila-v2-prod --region=us-central1 --project=gamechanger-pocket-agent \
  --to-revisions=<previous revision>=100
```

Note the current revision before the promotion (§4 step 2).

**The database:** migrations 0054–0070 are additive and stay. Reversing any of them after the new code has written into it deletes rows (`docs/probes/ship.md` → "Step 9" → "Reversibility").

## 9 · Open items that are yours

| Card | What | Ask |
|---|---|---|
| **K-S8** | `server/lib/integrations/instagram.ts:188` stores the *requested* scopes when Meta returns none, so `connected_accounts.scopes` can claim `instagram_business_content_publish` for an account that declined it. Your proposal §2 (`docs/proposals/instagram-publish-scope.md`). It matters now that the scope can be requested. | Store only what Meta granted (an empty string when none). |
| **K-S10** | The dev `INTERNAL_CRON_SECRET` was printed in full by a scheduler update. Rotate it: a new version with no CRLF (`openssl rand -hex 32 \| tr -d '\r\n' \| gcloud secrets versions add INTERNAL_CRON_SECRET --data-file=-`), redeploy dev, update each dev job (`--format=none`), update local `.env` files. ⚠️ `SESSION_SECRET` is mounted nowhere, so dev signs OAuth state with this secret (`server/lib/oauthState.ts:36-40`). Rotating breaks any connect in flight, and the leaked value was that signing key too. | Adi; unblocked now that the Instagram reconnect is done. Consider mounting a real `SESSION_SECRET` in both yamls. |
| **K-S12** | `research-planner` (your commit `0cf9ae9f`, Phase A Step 2b) is declared for every environment in `scripts/provision-schedulers.sh`, but dev has never had it. A full `APPLY=1` on dev would create it. | Does it belong on dev? If not, the script needs a per-environment job list. |
| K-S13 | Why `Content-Type: application/json` returned 401 on the hand-made Studio tick jobs. From the code it can't (only the secret check returns 401). | Open; octet-stream works. |
| K-S11 | `studio-enrich-tick` (dev) is hand-made and not declared in `provision-schedulers.sh`, which needs a per-job body column to hold `{"maxTicks":1}`. | Open. |
