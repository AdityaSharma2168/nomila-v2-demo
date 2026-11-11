# Prod promote readiness check (2 Nov 2026)

Owner-approved check (2 Nov 2026). **Nothing in prod was changed.** It was read-only against the prod service, the prod database and Cloud Scheduler. The only things created were one temporary Cloud SQL clone, which has been **deleted** (see section 2), and local Docker work. deploy-prod / promote were not run.

**Verdict:** the server-only promote is **ready**. The one condition, the Node 22 image check, **passed** remotely in Cloud Build `8d461f4c` (section 3): node v22.22.3, sharp, ffmpeg 5.1.9, and a boot that stops at the config guard with no module errors. The migrations rehearsed cleanly on a clone of prod. The flag guard passes. The OTA cannot reach the 1.2.0 phones. Mastra in prod needs a connection-budget change first: that is PR #1181 (section 4).

---

## 1. What ships

### Prod today
| | |
|---|---|
| Service | `nomila-v2-prod`, revision `nomila-v2-prod-00022-4t2` (100% traffic), minScale 1, maxScale 4, 2 CPU / 2 GiB, concurrency 80 |
| Image | `…/gamechanger/nomila-v2:d3d37fa2` |
| Git SHA | `d3d37fa2` (#1127). deploy-prod run 40361780538, 26 Oct 16:43 UTC, success. `origin/production` = `d3d37fa2`. |
| Note | The live template carries a label `secrets-refreshed: 20261030-202300`, so someone refreshed the secret revision on 30 Oct outside a promote. `services replace` drops that label. It is harmless: secrets are `latest`. |

### main ahead of prod
Checked at `a9594b21` (#1174, Expo SDK 57): **138 commits (82 non-merge), 342 files, +45,617 / −11,925.** While this check ran, main moved to `752fd1a5` (146 commits). The extra commits are #1176 (gitignore), #1177 (server/agent/skills → jobs, byte-identical prompts) and #1179 (delete the unreachable old chat loop). They add **no migrations and no prod YAML change**. The only Dockerfile change is the `COPY` of `server/agent/jobs` instead of `skills`. `production` is an ancestor of main, so a fast-forward works.

By area (merged PRs since `d3d37fa2`):
- **Mila engine and chat:** Mila on TrueForge chat (#1139, MILA_TF_CHAT), MCP tool server (#1130/#1133/#1134/#1144, NOMILA_MCP_ENABLED), tool status lines (#1154/#1159), **Mastra engine** (#1167, MILA_ENGINE) and its cost guards (#1175), **chat v2 server** (#1173, MILA_CHAT_V2), one Mila definition (#1168, #1121), get_playbook fix (#1166, #1138).
- **Proactive Mila:** server (#1152, MILA_PROACTIVE) and client (#1153), plus the SPEAK/SILENT/DEFER decision fix (#1161).
- **Research and scoring:** lean sign-up research v4 (#1137, LEAN_SIGNUP_RESEARCH), quick score (#1131, QUICK_SCORE_*), lean conflicts fix (#1142), audience facts restore (#1143), and the waitlist preliminary→full score with "Is this you?" (#1140).
- **Waitlist and landing:** Mila-hosted waitlist (#1148, MILA_TF_WAITLIST), scripted status lines dropped (#1149), WebFrame hero backdrop (#1141, **no runtime switch**: live on app.nomila.co with the promote).
- **Privacy and agent runs:** two-phase account deletion (#1164), approval states on agent_runs (#1162), deleting TF sessions on account deletion (#1145), verified model price registry (#1160).
- **Release tooling:** kill-switch guard, prod monitoring script and release checklist (#1146).
- **App platform:** **Expo SDK 57 / RN 0.86** (#1174), app version 1.2.0 → **1.3.0**, unused native deps removed (#1172).
- **Runtime:** Docker `node:20-slim` → **`node:22.22-bookworm-slim`** and `pg` 8.21 → 8.23.1 (with #1167).
- **Dev-only config:** #1147, #1150, #1156/#1158/#1163, #1170.
- **Docs and evals:** #1125, #1129, #1169.

### Migrations between prod and main
Prod's applied state: there is no hand-migration ledger. Drizzle's journal table is `public.__drizzle_migrations` (the drizzle config sets that schema), and the hand files are not tracked. The state was therefore read from the clone itself before any migration ran. **None** of the objects from 0141–0147 existed: no `mila_tf_sessions`, `mila_tf_turn_items`, `athlete_events` or `account_deletion_items`; no `mastra` schema; no `agent_runs.approval_state`, `chat_messages.mila_started` or `athletes.deletion_requested_at`. That matches `d3d37fa2`'s `db-migrate.sh`, which ends at `0140`.

New in `scripts/db-migrate.sh` (no numbers 0142/0146: they were never used):

| File | What it does | Lock exposure |
|---|---|---|
| `0141_mila_tf_chat` | 2 new tables + 3 indexes | none on existing tables (new FKs take SHARE ROW EXCLUSIVE on `athletes`/`agent_runs`, briefly) |
| `0143_mila_proactive` | new `athlete_events` + 2 indexes; `chat_messages` + `mila_started bool NOT NULL DEFAULT false`, + `seen_at` | ACCESS EXCLUSIVE on `chat_messages`, metadata-only on PG15 (constant default, no rewrite) |
| `0144_agent_run_approval_state` | `agent_runs.approval_state` + CHECK (validated) | ACCESS EXCLUSIVE on `agent_runs`; the CHECK scans the table, but every row is NULL and the table is ~0.5 MB |
| `0145_account_deletion_two_phase` | `athletes.deletion_requested_at`; new `account_deletion_items` | metadata-only on `athletes` |
| `0147_mastra_engine` | `CREATE SCHEMA mastra`, 53 tables + indexes + 1 trigger (pinned `@mastra/pg` 1.32.0 DDL); `mila_tf_sessions` + 3 columns; `DROP SCHEMA IF EXISTS mastra_poc` (no-op in prod) | none on existing hot tables |

None of them contains `BEGIN`/`COMMIT`/`ROLLBACK`, so the 11 Sep rule is not engaged. All are additive and `IF NOT EXISTS`-guarded, so the old `d3d37fa2` image runs on the new schema (rollback-safe).

### Env flags: `gcp/cloud-run-prod.yaml` (main) vs live `nomila-v2-prod`
Only nine differences, all **keys missing from live that the YAML adds at their safe value**:

| Flag | YAML | Live |
|---|---|---|
| `NOMILA_MCP_ENABLED` | `"false"` | unset |
| `MILA_TF_CHAT` | `"false"` | unset |
| `MILA_TF_WAITLIST` | `"false"` | unset |
| `MILA_PROACTIVE` | `"false"` | unset |
| `MILA_ENGINE` | `"trueforge"` | unset (the code reads unset as trueforge) |
| `MILA_CHAT_V2` | `"false"` | unset |
| `LEAN_SIGNUP_RESEARCH` | `"false"` | unset |
| `QUICK_SCORE_ONE_CALL` | `"false"` | unset |
| `QUICK_SCORE_STORE_GROUNDED` | `"false"` | unset |

Every other env var, every secret reference, the resources, the concurrency and the scale annotations match. There are no new secret references, so no secret has to be created before the promote.

### The guard
`npx tsx scripts/prod-flag-guard.ts gcp/cloud-run-prod.yaml <live.json>` → **exit 0**: "OK, no guarded flag turns on". It would only refuse once #1171 (YAML LEAN/QUICK_SCORE = "true") merges **before** the live flip. That is why the order in section 6 matters.

---

## 2. Migration rehearsal on a prod clone

| | |
|---|---|
| Clone | `nomila-prod-rehearsal-1102`, from `nomila-prod-db` at 17:19 UTC. Ready in about 7 min (created 17:20:01). |
| Tier | `db-g1-small`. `gcloud sql instances clone` takes no tier, so the clone keeps the source's, which is already the smallest shared-core tier above micro. Same 10 GB SSD. |
| Cost | It ran about 81 min (17:20 → 18:41 UTC). At db-g1-small list price (about $0.035/h) plus 10 GB SSD, that is **about $0.05 to $0.10**. |
| Clone facts | Postgres 15.18, `max_connections=50`, `superuser_reserved_connections=3`, database 24 MB. `agent_runs` is about 0.5 MB, `athletes` and `chat_messages` are tiny. |
| How | My own `cloud-sql-proxy` (port 5447), then the same `bash scripts/db-migrate.sh` (direct `DATABASE_URL` path; the CI path only downloads a Linux proxy) from the worktree at `a9594b21`, with the prod secret's credentials loaded silently. A guard in the script refused any target other than the clone. |

**Run 1 (aborted, network):** steps 1 and 2 and hand files 0031–0036 applied, then the TCP link from this machine to the clone dropped. The proxy logged `wsarecv … connected party did not properly respond`. This was the workstation's network (the same resets hit `git fetch`, `docker build` apt and `gcloud builds submit`), not the database. It left a partial state, which is exactly the "restored or partly migrated" case the script is meant to converge.

**Run 2 (full recipe): PASS.** `db-migrate.sh` exit 0, 1,547 s end to end, with no SQL error.
- Step 1 (legacy DDL): 201 s. Step 2 (drizzle journal): 10 s.
- `0141`: 7.6 s. `0143`: 8.6 s. `0144`: 5.1 s. `0145`: 6.3 s. `0147`: 99.7 s (about 600 statements; each round trip is roughly 0.8 s from here, so in CI next to the instance it will be far faster).
- Drift gate: "✅ No drift — every table and column in shared/schema.ts exists in the database. Schema migration succeeded."
- After: all four new tables exist, schema `mastra` has 53 tables, and `agent_runs_approval_state_check` is present.

**Run 3 (idempotency): PASS on every migration; drift gate re-run separately.** Every legacy file, the journal and every hand file 0031–0147 re-applied with **zero ERROR lines**: only `NOTICE … already exists, skipping`. Timings were `0141` 8.4 s, `0143` 8.4 s, `0144` 5.0 s, `0145` 6.9 s and `0147` 134 s. The final drift-gate step lost its connection (`Connection terminated due to connection timeout`, the same network), so the script exited 1 at that last step. Re-running the drift gate on its own against the clone straight after printed **"✅ No drift"**. I also tried a schema-fingerprint comparison before and after re-applying 0141–0147, but it could not finish over the dropping link, so it is not counted.

**Locks:** there was no traffic on the clone, so there was no contention to observe. From the DDL itself (table above), the only ACCESS EXCLUSIVE locks are on `chat_messages`, `agent_runs` and `athletes`, and each is metadata-only or covers a tiny table. Each statement runs in its own autocommit, so a lock is held for milliseconds. A long-running query on those tables during the promote would make the `ALTER` wait, and new queries would queue behind it. Promote at a quiet hour.

**Clone deleted:** `gcloud sql instances patch … --no-deletion-protection`, then `gcloud sql instances delete nomila-prod-rehearsal-1102` printed "Deleted" at 18:41 UTC. `gcloud sql instances list` now shows only `nomila-prod-db`, `gamechanger-db`, `gamechanger-db-dev` and `nomila-v2-db`. Both of my proxies (PIDs 2169/3426/9917/15913 across the runs) stopped with their scripts. None is left running.

---

## 3. Node 22 image check

**Goal:** confirm the Node 22 image builds from main, boots to "fails only for missing DB/config", and that ffmpeg, sharp and the prod deps are present.

| Attempt | Result |
|---|---|
| Local `docker build` from a clean `git archive a9594b21` | **Failed at `apt-get install ffmpeg`**. deb.debian.org timed out (`Connection failed [IP: 146.75.78.132 80]`) from this machine's network. The builder stage (`npm install`, esbuild bundle) finished. This is not a Dockerfile defect: the same Dockerfile built in CI. |
| `gcloud builds submit` (config with no `images:` and no push; build, then `docker run` checks and two ffmpeg test suites in the image) | The source upload hung for about 55 min on the same network and was stopped (my PID only). **No build was created.** |
| `docker pull` of the dev-built `nomila-v2:a9594b21` | Timed out after 15 min (same network). Not completed. |

**What is already proven elsewhere** (from the cutover doc's HARD GATE: the Node 22 image builds, dev boots on it, and one Studio ffmpeg job completes on dev):
- **Builds:** deploy-dev built and pushed `nomila-v2:a9594b21` (run success 2 Nov 17:02 UTC). Every main commit since #1167 (31 Oct) has built on Node 22. Dev now runs `nomila-v2:4eba1458` (revision `nomila-v2-01158-5np`).
- **Dev boots and serves on Node 22:** deploy-dev's startup probe on `/health` gates traffic, and it succeeded on each of those SHAs.
- **ffmpeg on dev under Node 22:** a read-only query on the dev DB found **4 `studio_stitch_jobs` `succeeded`** since 31 Oct 14:00 UTC, the latest at 2 Nov 04:32 UTC. Stitch is ffmpeg concat and encode, so ffmpeg, sharp and the native modules work in that image.
- **Same Debian:** `node:22.22-bookworm-slim` keeps bookworm, so ffmpeg is still 5.1.x, as before.

**Remaining to close before promote (owner or engineer, about 10 min, needs normal network):**
```bash
IMG=us-central1-docker.pkg.dev/gamechanger-pocket-agent/gamechanger/nomila-v2:<sha-to-promote>
docker pull $IMG
docker run --rm --entrypoint sh $IMG -c 'node -v; ffmpeg -version | head -1; node -e "console.log(require(\"sharp\").versions)"; node -e "require(\"@mastra/core/package.json\"); require(\"pg\"); require(\"node-cron\"); console.log(\"modules ok\")"'
docker run --rm -e PORT=8080 -e DATABASE_URL=postgresql://x:x@127.0.0.1:1/x -e SESSION_SECRET=dummy $IMG timeout 30 node server_dist/index.cjs 2>&1 | grep -iE "Cannot find module|MODULE_NOT_FOUND|ERR_DLOPEN" && echo FAIL || echo "no module errors"
```
Optional: run the in-image Studio render suite with `npm ci --ignore-scripts && npm test -- server/agent/postKit/render/worker.ffmpeg.test.ts server/studio/stitchRunner.structure.test.ts` inside a container from the same image.

**Addendum: the pull did not finish.** `docker pull …/nomila-v2:a9594b21` ran into its 15-minute timeout on the same network, so the image was not available locally. Section 3's condition is therefore still **open**. It is not a known failure: there is just no local proof yet.

**Result, remote (2 Nov, later): PASS. The condition is closed.** Cloud Build `8d461f4c-5179-4e23-8cc3-d4a48bb60df1` (us-central1) built the Dockerfile from an archive of `752fd1a5` (origin/main). It pushed only a temporary tag, `nomila-v2:readiness-752fd1a5`, and ran each check with `docker run --rm` on that image:

| Check | Result |
|---|---|
| 1. `node -v` | `v22.22.3` |
| 2. `require('sharp')` + a 1×1 → 2×2 resize | ok (2×2 PNG, 97 B) |
| 3. `ffmpeg -version` | `5.1.9-0+deb12u1` (ffprobe too) |
| 4. `@mastra/core`, `@mastra/pg`, `pg`, `node-cron`, `drizzle-orm` and `express` load; then the CMD (`node server_dist/index.cjs`) with a dummy DB | modules ok. The routers load ("studio router ready"), then it exits 1 on `Unsafe production config: WEB_APP_URL / API_BASE_URL must be set`, which is the expected config guard. No `MODULE_NOT_FOUND` or `ERR_DLOPEN`. |
| 5. `worker.ffmpeg.test.ts` inside the image (`npm ci`, jest, cloud edges mocked by the suite) | **18 of 19 pass**. I1–I8 render on real ffmpeg and sharp. **I2b fails**: ffmpeg 5.1 does not accept `ebur128=…:framelog=quiet` (`Unable to parse option value "quiet"`). See section 5. |

The temporary tag was deleted afterwards (`gcloud artifacts docker tags delete …:readiness-752fd1a5`, then confirmed absent). No other tag pointed at that digest, and the AR cleanup policy removes untagged digests. No prod tag was touched. The local network problem turned out to be `gcloud storage` uploads hanging, so the source was uploaded with curl through the GCS JSON API (3.6 s).

---

## 4. Prod connection budget

`nomila-prod-db` is db-g1-small with **no database flags**, so `max_connections=50` (read on the clone), `superuser_reserved_connections=3`, and **about 47 usable** by the app user.

| Consumer | Today (TrueForge) | With Mastra on |
|---|---|---|
| App pool `DB_POOL_MAX=10` × maxScale 4 | 40 | 40 |
| Workflow runner, in-process crons, minute ticks | 0 extra (they share the app pool in-process) | 0 extra |
| Mastra store pool (`max: 4`, built lazily only when `MILA_ENGINE=mastra`) × 4 | 0 | 16 |
| Deploy-time proxy (psql, drizzle-kit and the drift check run one after another) | about 1–2 during the migrate step | about 1–2 |
| **Steady peak** | **about 40–42 of 47** | **about 56–58 of 47: over** |

Revision rollover is extra risk. During `services replace`, the old revision (minScale 1, up to 4) keeps its pools while the new one starts. Peak demand can briefly exceed 47 today if prod is scaled out at deploy time. Prod normally sits at 1–2 instances, so this is low risk now, but it is not zero.

**Before Mastra goes on in prod**, pick one:
- (a) Lower `DB_POOL_MAX` to 7. 4 × (7 + 4) = 44. A YAML PR, no restart.
- (b) Set the flag `max_connections=100` on `nomila-prod-db`. This **restarts the instance** (a few minutes of downtime). Pick a quiet window, and remember that `--database-flags` replaces the whole flag list.

I recommend (a) now and (b) only if pool waits show up.

**(a) is PR #1181** (`chore/db-pool-budget`, CI green, not merged). It sets prod `DB_POOL_MAX=7` and makes Mastra's pool configurable as `MILA_MASTRA_POOL_MAX=4` (it was hard-coded). It also adds `server/lib/dbPoolBudget.test.ts`, which fails CI if maxScale × (DB_POOL_MAX + MILA_MASTRA_POOL_MAX) is over 45 for prod (4 × (7 + 4) = 44) or 95 for dev (3 × (5 + 4) = 27 against `max_connections=100`). Those are the only two pg pools in the server: the workflow runner, the crons and the advisory locks borrow from the app pool. The PR ships with whichever promote follows its merge. It is not a guarded flag, so merging it before promote 1 is fine.

---

## 5. Other risks

- **In-process crons on Node 22.** `node-cron` ^4.2.1 runs only when `NODE_ENV=production`, and it is a backup to Cloud Scheduler (23 `*-prod` jobs enabled, unchanged by this check). They are not version-sensitive, and on dev they have run under Node 22 since 31 Oct. Main adds one new endpoint, `/api/internal/agent-spend-cron`. Its Scheduler job (`agent-spend-cron-prod`) is created by `scripts/monitoring/prod-release-monitoring.sh` (`APPLY=1 SCHEDULER=1`), which has **not** been run for prod: the job and the 12 log metrics and 10 alerts it creates do not exist yet. Proactive Mila needs no Scheduler job (it is event-driven).
- **Expo 57 OTA (mobile job).** The runtime policy is `appVersion`. Main is `1.3.0`, so `eas update --branch production --environment production` publishes for **runtime 1.3.0 only**. The production binaries are iOS `1.2.0` (built 24 Oct, the only `production` channel build). There is **no 1.3.0 production binary**, and Android has no production build at all. So the OTA **cannot reach the 1.2.0 phones**: they stay on the last 1.2.0 update (from `d3d37fa2`). The flip side is that **none of the client work since 26 Oct reaches prod phones** until a 1.3.0 production binary ships through TestFlight. That includes the proactive client (#1153, `EXPO_PUBLIC_MILA_PROACTIVE` is in preview only, not production). A 1.3.0 production build would pick up the latest 1.3.0 OTA from the production branch, so publish an OTA after the build, not only before it.
- **`eas-profile-env.cjs production`** works on main and emits 12 `EXPO_PUBLIC_*` keys. The production profile is unchanged except for `SHARP_IGNORE_GLOBAL_LIBVIPS`, a build-time env var. `EXPO_PUBLIC_MILA_PROACTIVE` was added to preview only. Because `eas update` needs `--environment` from SDK 55, deploy-prod already passes `production`.
- **Firebase web (part of every promote, the `web` job).** app.nomila.co is rebuilt from main with **Expo 57's web export** and the production profile's flags, plus `EXPO_PUBLIC_WEB_V2=true`. The WebFrame backdrop (#1141) goes live with it, and there is **no runtime switch**. Rollback is in Hosting (`firebase hosting:clone nomila-app:@<prev> nomila-app:live`). The landing (nomila.co) ships main's `landing/`, including the #1140 / #1149 changes. deploy-web-dev was green on `a9594b21`, so the Expo 57 web export builds. Do one sign-in on app.nomila.co and one landing load right after the promote.
- **The Node 22 + `pg` 8.23.1 driver change reaches every prod request**, whatever the flags say. It has run on dev since 31 Oct with green deploys. The rollback is a traffic switch to `nomila-v2-prod-00022-4t2` (section 6).
- **Main is a moving target.** Dev must have built the exact SHA you promote (deploy-prod does not build). Check it with `gh run list --workflow deploy-dev.yml --branch main -L 1`, where `headSha` must equal `git rev-parse origin/main`. If a new migration lands before the promote, rehearse again (`git diff --name-status origin/production origin/main -- migrations/`).
- **Live `CANONICAL_CONTEXT_READERS`** is set to an empty value, and the YAML matches.
- **ffmpeg 5.1 rejects `ebur128=framelog=quiet` (found by section 3's in-image run).** Production code uses the same filter string in two places: `server/studio/video/finishing.ts` `measureLoudness` (bed loudness under STUDIO_FINISHING) and `server/studio/video/signals.ts` (the clip loudness signal). On the Debian 5.1 image both catch the error and return null. So a bed is mixed without its −14 LUFS normalisation and `loudness_lufs` is null, but nothing fails. This is **not new and not caused by Node 22**: node:20-slim was also bookworm with ffmpeg 5.1, and CI's Ubuntu ffmpeg 6.x hides the problem. **It does not block promote 1.** Fix it separately by dropping `:framelog=quiet` (the summary is still printed) or by using `framelog=info`.

---

## 6. Recommended promote plan

### Promote 1: server, web and OTA with prod flags unchanged (TrueForge, every Mila surface off, chat v2 off)

Preconditions:
1. Section 3's image check passes on the SHA to promote. It passed on `752fd1a5`; if main has moved on and the Dockerfile or package-lock changed, re-run it.
2. #1171 is **not** merged. Otherwise the guard refuses, which is safe but blocks the promote.
3. Dev deploy is green on that SHA.
4. `git merge-base --is-ancestor origin/production origin/main`.
5. A quiet hour.

Owner or promoter runs:
```bash
gh workflow run promote.yml --ref main -f confirm=promote      # promoter: miabhuta-code or aaronsongnguyen
gh run watch                                                   # guard → prod-* tag → backup "pre-promote <sha>" → db-migrate → replace → /health
curl -fsS https://api.nomila.co/health
```
Expected result: the guard prints OK, the migrate adds 0141–0147 (about 2–4 min from CI), and the 9 safe-value keys appear on the service. Then do one sign-in on app.nomila.co and one landing load.

**Rollback:**
- API: `gcloud run services update-traffic nomila-v2-prod --region=us-central1 --project=gamechanger-pocket-agent --to-revisions=nomila-v2-prod-00022-4t2=100`. The schema is additive, so the old image runs on it, and no DB restore is needed.
- If a restore were ever needed: `gcloud sql backups list --instance=nomila-prod-db` and restore the "pre-promote <sha>" backup (destructive, owner only).
- Web: `firebase hosting:clone nomila-app:@<prev> nomila-app:live` (and the same on `nomila`).
- OTA: it reaches no binary (runtime 1.3.0), so it needs no rollback.

Afterwards, apply monitoring once: `APPLY=1 SCHEDULER=1 bash scripts/monitoring/prod-release-monitoring.sh`.

### Then switch on, one step at a time, with at least a day between steps

**Step A: lean research (#1171).** Owner's dev sign-up test is signed off. `QUICK_SCORE_STORE_GROUNDED` waits for the lawyer (`TODO(lawyer)` in `server/services/quickScore/config.ts`).
```bash
gcloud run services update nomila-v2-prod --region=us-central1 --project=gamechanger-pocket-agent \
  --update-env-vars LEAN_SIGNUP_RESEARCH=true,QUICK_SCORE_ONE_CALL=true   # add QUICK_SCORE_STORE_GROUNDED=true only after legal clears
```
Then merge #1171, trimmed to the flags actually flipped, so the YAML matches the live service.
Rollback: `--update-env-vars LEAN_SIGNUP_RESEARCH=false,QUICK_SCORE_ONE_CALL=false`, then a YAML PR.

**Step B: Mastra cutover.** Preconditions: cutover doc steps 3–4 (5-day dev soak and the owner's phone check) are signed off, and the connection budget is fixed (`DB_POOL_MAX=7` via a YAML PR and a promote, or `max_connections=100`). `OPENAI_API_KEY_PROD` is already mounted. Prod has no TrueForge, so Mila surfaces in prod would run on Mastra from the start. The engine and the surface flags go on together, in this order:
```bash
gcloud run services update nomila-v2-prod --region=us-central1 --project=gamechanger-pocket-agent --update-env-vars MILA_ENGINE=mastra
gcloud run services update nomila-v2-prod --region=us-central1 --project=gamechanger-pocket-agent --update-env-vars MILA_TF_CHAT=true   # see the note below
```
Note: `milaTfChatEnabled()` today is `MILA_TF_CHAT === "true" && mcpEnabled()`, so prod chat would also need `NOMILA_MCP_ENABLED=true` even on Mastra, which opens `/mcp`. Confirm with the code owner whether the chat route on Mastra should still depend on the MCP flag before flipping. If it should not, that needs a small code PR first. The proactive flag (`MILA_PROACTIVE`) and the waitlist flag (`MILA_TF_WAITLIST`) are separate later flips.
Rollback: `--update-env-vars MILA_ENGINE=trueforge` (read per turn, no deploy). With no prod TrueForge, also turn the surface flag off: `MILA_TF_CHAT=false`, then 5 min later `NOMILA_MCP_ENABLED=false`. Then a YAML PR.

**Step C: chat v2.** Preconditions: B is stable, and the chat v2 client is in a 1.3.0 production binary (or the web).
```bash
gcloud run services update nomila-v2-prod --region=us-central1 --project=gamechanger-pocket-agent --update-env-vars MILA_CHAT_V2=true
```
The route mounts **at startup**, so the flip creates a new revision. Rollback: `MILA_CHAT_V2=false` (another new revision), then a YAML PR.

After each flip that is meant to stay, open the one-line YAML PR so `gcp/cloud-run-prod.yaml` matches the live service before the next promote.

### Blockers and conditions (summary)
1. **Condition for promote 1:** the Node 22 image check on the promoted SHA (section 3). It could not finish from this workstation.
2. **Blocker for Mastra:** the connection budget (56 > 47). Fix it via `DB_POOL_MAX=7` or `max_connections=100`.
3. **Blocker for Mastra chat in prod:** the `MILA_TF_CHAT` + `NOMILA_MCP_ENABLED` coupling. Decide on it first.
4. **Not a blocker, but expected:** no prod phone gets any of this client work until a 1.3.0 production binary ships.
5. Prod monitoring (spend cron, alerts) is not applied yet. Apply it before step A.
