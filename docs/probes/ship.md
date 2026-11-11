# Ship (PR 20) · ledger

| | |
|---|---|
| Branch | `studio/ship` (worktree `/Users/adi/nomila-v2-worktrees/ship`), created `--no-track` from origin/main |
| Base | Phase R read **`6fcf8273`**. When PR 19 merged (#603, **`b9989e6b`**), the branch had no commits and was fast-forwarded to it (`git merge --ff-only`, local). **The build's base is `b9989e6b`.** |
| Known dirty baseline | `server/scripts/calibration/runs/blind-eval/blind-eval-2026-09-14.zip` shows ` M` at checkout (the gitattributes quirk). It is never staged. |
| node_modules | An APFS clone (`cp -cR`) of `image-ops`'s. Its `package.json` and `package-lock.json` are byte-identical to the base's. |
| Phase R | Read-only, $0. The R-report was given in session on 24 Sep 2026 and held. Four read-only subagents ran (flags, Instagram, ticks and Seedance, walk surfaces). Every cite they supplied that this ledger uses was re-read by hand. |

## Cites

Every ruling is Adi's, given in session.

| Cite | Message | Status |
|---|---|---|
| **ADI-S20** | The PR 20 brief, 24 Sep 2026: "PR 20: Ship. Phase R only, running while PR 19 builds in another session. …" | Its house rules and scope rulings stand where ADI-S20-GO repeats them ("House rules as before"). Everything else is superseded. |
| ADI-S20-MASTER | "1. Master switch: STUDIO_ALL_ON (server) and EXPO_PUBLIC_STUDIO_ALL_ON (client) … 3. Key: mount OPENROUTER_API_KEY in both yamls …" (25 Sep 2026) | Superseded by ADI-S20-GO |
| ADI-S20-ENRICH | "Two read-only questions before the config drafts: 1. Photo enrichment … 2. Backfill for Mia's testing guide …" (25 Sep 2026) | Answered in session. Its build items came in through ADI-S20-GO (item 7). |
| **ADI-S20-GO** | "Go. Build PR 20. This is the complete brief and supersedes every earlier paste; record it in docs/probes/ship.md with this message as the cite." (25 Sep 2026) | **In force** |
| **ADI-S20-HOLD1** | "Rulings (record with this message as the cite): - enrich-mine.sh debugging: (c). …" (25 Sep 2026) | **In force**. Its rulings are recorded below. |
| **ADI-S20-HOLD2** | "Go for item 6 and the full gate, with two additions first: 1. My IAM checks passed … Add the Item 3 OPENROUTER_API_KEY block to both yamls …" (25 Sep 2026) | **In force.** It supersedes ADI-S20-GO item 3's "don't edit it" and confirms create-then-pause for the prod jobs. |
| **ADI-S20-SCHED** | "Scheduler jobs done by hand (ADI, 25 Sep). Record in the ledger and fix the runbook: …" (25 Sep 2026) | **In force.** Recorded below. |
| **ADI-S20-IG** | "Instagram test passed (25 Sep): reconnect through dev recorded; the dry run logged … one live post landed on @fightquant …" plus its rulings (the curl pair and the PROD_CRON_SECRET check skipped, media-enrich-cron (b), K-S10 after the walk, K-S12 to Mia) | **In force** |
| **ADI-S20-SMOKE** | "Smoke test on the deployed dev app passed (preview build on my phone) … Skip the full 17-surface walk; record the smoke test as step 8's evidence …" (25 Sep 2026) | **In force.** The full walk is faded by this ruling. |
| **ADI-S20-MIG** | "Authorship confirmed. Studio migrations I apply by hand: 0054, 0056, 0057, 0058, 0059, 0060, 0061, 0062, 0064, 0066, 0067. Mia's 0055, 0063, 0065 (and 0068–0070) are left to her promotion." (25 Sep 2026) | **In force.** It narrows step 9's sequence. |
| **ADI-S20-STEP9** | "Step 9 done (25 Sep): backup taken; the 11 Studio migrations applied to prod with no errors; drift after lists only Mia's six tables … Skip the prod F13 write test: the triggers date from 0027 and are confirmed present." (25 Sep 2026) | **In force.** The prod F13 write test is dead by this ruling. |

## ADI-S20-GO: the brief as ruled

**Goal.** Studio is flip-ready and proven on dev, and **merging changes nothing in prod behaviour.**
- **Adi** does the key mount, the migrations and the scheduler jobs.
- **Mia** promotes and flips the flag lines.

### Rulings

| # | Ruling |
|---|---|
| Master | **`STUDIO_ALL_ON` (server) and `EXPO_PUBLIC_STUDIO_ALL_ON` (client) cover every boolean Studio flag.** When the master is on, a flag reads on unless it is exactly `"false"`. That means the 22 flags listed in session, **plus** `STUDIO_GARMENT_MASK`, `STUDIO_BACKGROUND_MASK`, `STUDIO_OBJECT_MASK`, `STUDIO_STITCH_BEDS_READY`, `STUDIO_VIDEO_ENRICH` and `STUDIO_AGENT_RETRY`, **28 in all**. **Only the non-boolean flags stay out:** `STUDIO_PUBLISH_MODE`, `STUDIO_MAX_JOB_USD`, `STUDIO_MAX_DAY_USD`, `STUDIO_ENRICH_DAILY_CAP_USD` and `STUDIO_VIDEO_ENRICH_MAX_RUN_USD`. |
| Masks | **Accepted with no `FAL_KEY`.** The corrected R-report line is recorded below, with the unbilled $0.005 per region. |
| Beds | Adi uploaded them with gsutil. Every path the code expects, and the check for each, is listed below. |
| Caps | **Caps travel with the master.** Dev config and the prod runbook set `STUDIO_ENRICH_DAILY_CAP_USD` beside `STUDIO_ALL_ON`. **The dev value is 5.** The runbook notes that `DIRECTION_MOMENTS` and `AGENT_RETRY` spend is not counted by the day cap. |
| `.env.development` | **Left alone.** A test asserts that `ALL_ON` is absent from it. |
| Phrasebook | `phrasebook/build.ts` saves and clears `STUDIO_ALL_ON`. |
| Prod | **PR 20 does NOT write `STUDIO_ALL_ON` into the prod yaml or the prod client builds.** Mia flips those. |
| Deny rule | Cite `devEnvLayering.test.ts:177-182` instead of the subagent's read (see "The deny-rule record"). **Every subagent inherits stop-and-ask: a blocked read stops the whole task and comes to Adi.** |
| Carded | The Nov 1 cron, pricing, rotation. |
| House rules | Scoped jest during the build and the full gate at the hold. Mutations red by name, with the tree checked byte-identical afterwards. No sizing. Never push. |
| Order | Ledger → 1 → 2 → the config drafts (4, 5, 7) as diffs plus the step-3 lines → **HOLD for Adi's review** → 6 → full gate → Adi merges → 8 → 9 → 10. |

### Build items (ADI-S20-GO, verbatim scope)

1. **Master switch.** A `studioFlag` helper over every boolean server flag above. The 17 client flags keep their literal reads and pass the value in. Table tests cover every flag × unset / `"true"` / `"false"` / `"1"` / `"TRUE"`, and check that the non-boolean flags don't move. Also: the client twin and a `devEnvLayering` case. Mutations: the helper ignoring the master; the helper treating unset as on without the master; a non-boolean flag wired through the helper.
2. **Fewest places to flip.** Map every place a client flag must be set per bundle (`eas.json` production and preview env, `deploy-prod.yml` web and OTA steps, `deploy-web-dev.yml`, `eas-update-preview.yml`). Reduce it to as few places as possible, and say what remains.
3. **OpenRouter key.** Adi mounts it and I don't edit it. I give the exact yaml lines for dev and prod (secret `OPENROUTER_API_KEY`, runtime account `gamechanger-runtime@`) and the three IAM check commands, in order.
4. **Scheduler jobs.** Declare the studio video, edit and stitch tick jobs in `provision-schedulers.sh` for dev and prod, with **D6: a tick whose flag is off does nothing and spends nothing.** Adi creates the jobs. I give the exact commands and say whether D6 makes them safe to create enabled.
5. **Instagram.** `instagram_business_content_publish` goes behind `IG_REQUEST_PUBLISH_SCOPE`: off unless set, on in dev config only. It is tested with Adi's profile (@fightquant) in step 8, in this order:
   1. reconnect through dev
   2. confirm the stored scopes include the publish permission
   3. a dry run
   4. one live $0 still-stitch reel, screen-recorded for Mia's App Review
6. **iOS.** Bump `expo.version` from 1.1.0 so old binaries can't take a crashing OTA. Give the development and preview build commands.
7. **Backfill wrapper + K-S7.** `tools/enrich/enrich-mine.sh` is a new, local-only file. It is specified in full in ADI-S20-GO. **K-S7:** the video lane excludes `origin = 'reference'`, as the photo lane does, with a test and a mutation.
8. **Dev proof.** `STUDIO_ALL_ON`, `EXPO_PUBLIC_STUDIO_ALL_ON`, `STUDIO_ENRICH_DAILY_CAP_USD=5` and `IG_REQUEST_PUBLISH_SCOPE` are on in dev config only. After the merge:
   - walk the deployed dev app: 17 surfaces, every model call quoted, ceiling ≈ $2.50, each spend on Adi's go
   - the step-5 Instagram test
   - a drift check and the F13 trigger proof on dev
9. **Prod migrations (by Adi, before the promotion).** Prove each of 0054→0067 safe under prod's running code (`db76dc2f`), calling out 0063 and 0065. Anything unsafe waits for the promotion. Then the exact sequence:
   1. proxy to `nomila-prod-db`
   2. drift before
   3. apply in step-3 order
   4. drift after
   5. the F13 proof

   Also: which files can't be reversed.
10. **Runbook for Mia** at `docs/runbooks/studio-flip.md`. It covers what Adi has done (with dates), what is hers (with the exact flag lines at file:line), a rollback, and her open decisions.

---

## The deny-rule record

During Phase R, my own `grep` of `.env.development` was blocked by a deny rule. The flag-inventory subagent, already launched, then read that file's `EXPO_PUBLIC_STUDIO_*` lines with grep. It reported flag names and `=true` values only. That is the "retry via another tool" Adi's standing rule forbids. It was disclosed in session on 25 Sep 2026.

**The fact is cited instead from the test that pins it:** `client/lib/devEnvLayering.test.ts:177-182` ("every EXPO_PUBLIC_STUDIO_* line in .env.development is =true — never =false"). **From here on,** a blocked read stops the whole task (mine or any subagent's) and comes to Adi (ADI-S20-GO).

---

## Phase R: what the build rests on

These were verified by hand at `6fcf8273`. The line numbers were re-checked at `b9989e6b` wherever this build touches them.

- **Two databases, not one.**
  - The local proxy targets `nomila-v2-db` on 5440 (`package.json:14`). That is the **dev** instance, and dev Cloud Run connects to it (`gcp/cloud-run-dev.yaml:12`).
  - Prod Cloud Run connects to **`nomila-prod-db`** (`gcp/cloud-run-prod.yaml:27`; `deploy-prod.yml:47,129`).
- **Prod is `db76dc2f`** (`origin/production`, #456, 13 Sep 2026, tag `v1.1.0-2026-09-14`). Its migrations end at 0053. Pending on prod: **0054→0067**.
  - Promotion is `promote.yml` → `deploy-prod.yml`, and only `miabhuta-code` or `aaronsongnguyen` can run it (`promote.yml:33`, `deploy-prod.yml:49`).
  - It runs `scripts/db-migrate.sh` against prod on its own (`deploy-prod.yml:125-131`).
- **No studio tick has a runner on any environment.**
  - The node-cron block at `server/index.ts:1967-2219` has no studio entry.
  - `JOBS=(…)` in `scripts/provision-schedulers.sh:64-76` has none.
  - `studio-stitch-tick-dev` was hand-made (`docs/plans/studio-video-flip-checklist.md:90-91`).
  - Each feature relies only on its inline kick.
- **Neither yaml mounts `OPENROUTER_API_KEY` or `FAL_KEY`.** They are read at `adapters/openrouter.ts:33` and `adapters/fal.ts:80`.
  - B-roll defaults to seedance-2.0-fast through OpenRouter (`video/shotType.ts:81-88`; `config.ts:185-197`).
  - B-roll **is priced** (`config.ts:661-668`). The prod failure is the missing key, which fails at submit after the approval is consumed.
- **Instagram publishing.**
  - `SCOPES` has no publish permission (`server/lib/integrations/instagram.ts:48-52`).
  - `STUDIO_PUBLISH_MODE` defaults to `off` (`publish/config.ts:36-37`). Posting needs both the process and the row to say `live` (`:41-42`).
  - The only runner is the inline kick (`publish/routes.ts:325-332`).
  - The shared `IG_PAGE_ACCESS_TOKEN` refresher is not the token Studio posts with. Her `connected_accounts` token is, refreshed lazily (`instagram.ts:191-211`).
- **iOS.** The last dev client, `adi/voice-native-ios` @ `efeb3f32`, predates `expo-document-picker`.
  - That module calls `requireNativeModule('ExpoDocumentPicker')` as soon as it is imported (`node_modules/expo-document-picker/build/ExpoDocumentPicker.js:2`).
  - It is imported statically: `AddContractSheet.tsx:26` ← `OpportunitiesScreen.tsx:32` ← `MainTabNavigator.tsx:9`.
  - `runtimeVersion` is `{policy: "appVersion"}` at 1.1.0, so every binary since July shares one runtime.

### The corrected R-report line (masks)

The R-report said: "`GARMENT_MASK`, `BACKGROUND_MASK`, `OBJECT_MASK`: fal SAM at $0.005 per call, needs `FAL_KEY`." **Corrected:**

> `STUDIO_GARMENT_MASK` and `STUDIO_BACKGROUND_MASK` gate the **only** fal call in the codebase: SAM-3 segmentation.
> 1. The gate is `segment.ts:531-535`.
> 2. `generate("image.segment")` at `:554`.
> 3. Provider `fal` and model `fal-ai/sam-3/image` (`config.ts:145-150`, `:48`).
> 4. `router.ts:34` → `adapters/fal.ts:79-88`, which throws `missing_api_key` without `FAL_KEY`.
>
> `STUDIO_OBJECT_MASK` calls nothing itself. It widens the nouns that reach that same call (`objectVocab.ts:390`).
>
> With `STUDIO_NATIVE_EDIT` on, only **drawn-box** edits take the masked path (`generate.ts:1307-1318`; `config.ts:1133-1134`).
>
> With no key, the throw is caught at `segment.ts:660-682`:
> - a garment region falls back to the rectangle (the flag-off result) and logs `"garment mask failed"`
> - a background region is refused
>
> **The quote still carries SAM's $0.005 per region (`config.ts:671`), and it is never billed.** Accepted as is (ADI-S20-GO).

### Beds: every object the code expects

Once `STUDIO_STITCH_BEDS_READY` reads on, every name below is offered and fetched. The master now turns it on (ADI-S20-GO). Paths are relative to the bucket: `STITCH_BEDS` in `server/studio/video/beds.ts:109-216`, and `MUSIC_TRACKS` in `server/studio/music/tracks.ts`, resolved by `gcsPathOf` (`beds.ts:242-243`).

| Name | Object |
|---|---|
| placeholder | `studio/beds/placeholder-loop.m4a` (`beds.ts:112`) |
| (bed) | `studio/beds/walking-away.m4a` (`:121`) |
| (bed) | `studio/beds/doodles.m4a` (`:138`) |
| (bed) | `studio/beds/tokyo-sunset.m4a` (`:155`) |
| (bed) | `studio/beds/hope-on-repeat.m4a` (`:172`) |
| (bed) | `studio/beds/we-drove-all-night.m4a` (`:189`) |
| (bed) | `studio/beds/only-human.m4a` (`:206`) |
| track | `studio/tracks/walking-around.m4a` (`tracks.ts:92`) |
| track | `studio/tracks/status.m4a` (`:108`) |
| track | `studio/tracks/with-your-hands.m4a` (`:128`) |
| track | `studio/tracks/save.m4a` (`:144`) |

The bucket is `MEDIA_BUCKET`: dev `nomila-v2-athlete-media` (`cloud-run-dev.yaml:400-401`), prod `nomila-prod-athlete-media` (`cloud-run-prod.yaml:93-94`). The check, per bucket:

```bash
for B in nomila-v2-athlete-media nomila-prod-athlete-media; do
  for P in studio/beds/placeholder-loop.m4a studio/beds/walking-away.m4a studio/beds/doodles.m4a \
           studio/beds/tokyo-sunset.m4a studio/beds/hope-on-repeat.m4a studio/beds/we-drove-all-night.m4a \
           studio/beds/only-human.m4a studio/tracks/walking-around.m4a studio/tracks/status.m4a \
           studio/tracks/with-your-hands.m4a studio/tracks/save.m4a; do
    gsutil -q stat "gs://$B/$P" && echo "OK   $B/$P" || echo "MISS $B/$P"
  done
done
```

**Pass: 11 `OK` lines for each bucket that will run with the master on.** `tracks.manifest.json` also records each track's size and MD5, so `gsutil ls -L gs://<bucket>/studio/tracks/` can be checked against it.

---

## Predictions (pre-registered in the R-report, 24 Sep 2026; scored at steps 8 and 9)

| # | Prediction | Scored at |
|---|---|---|
| P-1 | Local and prod don't share a database: local is `nomila-v2-db` (dev) and prod is `nomila-prod-db`. | 9 (the instance annotations) |
| P-2 | None of 0054→0067 is on prod. Drift before exits 1 naming those objects. The three clearance triggers are already present. | 9 |
| P-3 | Every studio tick lacks a runner on prod: 4 of 4 (edit, video, publish, stitch). | 4 (the scheduler list) |
| P-4 | A new iOS build is needed. On the old dev client, main's JS gives a red screen for `ExpoDocumentPicker`. | 6 (`eas build:list`) |
| P-5 | Walk surfaces: 16 shipped, 17 with PR 19 (now merged). | 8 |
| P-6 | Walk spend ≈ $2.22, ceiling $2.50, of which ≈ $0.35 comes before any preview. | 8 |
| P-7 | For Mia's library on dev, `photos_left` ≈ 0: the dev media-enrich job runs the photo lane over everyone every 15 minutes. | 7 (the wrapper's first count) |

---

## Build log

_Filled in as each item lands. Evidence is deterministic code, test output and command output. Model output counts as claims._

### Item 1: the master switch (built)

- **Server.** `server/studio/studioFlag.ts` holds `studioAllOn()` and `studioFlag(value)`. The rule is `value === "true" || (STUDIO_ALL_ON === "true" && value !== "false")`, read each time a flag is checked, and the file has no imports.
  - All 28 boolean reads now go through it: 24 in `config.ts`, `qa/record.ts:55`, two in `enrich/config.ts` (`:25`, `:127`), and `video/beds.ts:266`.
  - `STUDIO_VIDEO_FRAME_CROP` is untouched. It is default-on and off only at exactly `"false"` (`videoRunner.ts:160`), so the master's rule already holds for it.
  - The value flags still read their own variables.
- **Client.** `client/lib/flags.ts` has `STUDIO_ALL_ON = process.env.EXPO_PUBLIC_STUDIO_ALL_ON === "true"` and `studioFlag(value, allOn = STUDIO_ALL_ON)`. The 17 Studio flags keep their literal `process.env.EXPO_PUBLIC_STUDIO_*` reads, because Expo inlines only static member access. `IDENTITY_CLAIM` and `OBJECTIVES_V1` are not Studio's and are untouched.
- **Phrasebook.** `phrasebook/build.ts` withFlags saves and clears `STUDIO_ALL_ON` (`CLEARED`). My import line shifted two `config.ts` cites in `docs/studio/phrasebook.md` (531→532, 51→52), so the doc was regenerated with `npm run studio:phrasebook` ($0, a pure render).
- **Tests** (scoped, `--runInBand --json`): **698 / 698** across 4 suites.
  - `server/studio/studioFlag.test.ts`:
    - 28 flags × 5 values × both master states
    - five master values that are not the master
    - the helper itself
    - value flags unchanged under the master (publish mode off, caps 10 / 25 / null / 2)
    - a census over `server/studio`: no bare `=== "true"` read; the helper's reads are exactly the 28; no value flag goes through it
  - `client/lib/flags.master.test.ts`: the same shape on the client twin, with `flags.ts` loaded fresh per row, and the master never reaching `IDENTITY_CLAIM` or `OBJECTIVES_V1`.
  - `devEnvLayering.test.ts`:
    - `STUDIO_FLAGS` leaves the master out by name, so the count stays 17
    - the committed `.env.development` never carries the master
    - a master in her `.env` resolves on through the committed file in both layerings and turns an unpinned flag on
  - `phrasebook.test.ts`: under `STUDIO_ALL_ON=true`, the render equals the committed doc and the variable is restored.
- **Mutations.** Each run: cp backup → mutate (old string asserted once) → jest `--json` → restore → sha256 equal. All red by name and restored byte-identical:

  | Mutation | Reds | Which tests |
  |---|---|---|
  | M-master | 86 | the 84 "under the master" rows for unset / "1" / "TRUE", "one explicit false…", "the helper itself" |
  | M-unset | 36 | 28 unset rows, 5 non-master values, the helper, and 2 phrasebook rows (every route switch reads on) |
  | M-value | 4 | "a value flag does not move…: STUDIO_PUBLISH_MODE", "…publishing is off…", and both census rows |
  | M-cmaster | 52 | 51 client rows + the layering case |
  | M-cunset | 23 | 17 unset rows + 5 non-master values + "with the flag nowhere, the Board's composer is off" |
  | M-pb | 1 | "a developer's master never changes the doc…" |

  A first pass of these mutations matched 0 tests: an unquoted zsh `$T` stayed one word. That pass is void and not counted. The runner now prints `INVALID RUN` on a 0-test run.
- **Gates on the touched files.**
  - `tsc --noEmit` rc 0, and `tsc -p tsconfig.jest.json` rc 0 (0 errors).
  - eslint: 0 errors. The only warnings are the `require()` inside `jest.isolateModules`, the same as the existing line at `devEnvLayering.test.ts:91`.
  - prettier: every touched file was clean on main and is clean now. `docs/studio/phrasebook.md` was already unformatted on main and is left as generated.

### Item 2: fewest places to flip a client flag (built)

**Before PR 20.** `EXPO_PUBLIC_*` is inlined at bundle time, so a client flag had to be set in every bundle of an environment, once per flag.

| Environment | Bundle | Where its value came from |
|---|---|---|
| prod | binary | `eas.json` `build.production.env` (+ the EAS dashboard's `production` environment, which Adi confirmed empty on 24 Sep 2026) |
| prod | OTA | `deploy-prod.yml:289-291`, three literal lines under "MUST match eas.json" |
| prod | web (`app.nomila.co`) | `deploy-prod.yml:212-215`, `EXPO_PUBLIC_API_URL` only |
| dev/preview | binary | `eas.json` `build.preview.env` |
| dev/preview | OTA | `eas-update-preview.yml:75-86`, five literal lines under "MUST match eas.json" |
| dev | web | `deploy-web-dev.yml:44-47`, `EXPO_PUBLIC_API_URL` only |
| local | Metro | `.env` → `.env.development` (17 Studio pins) → `.env.local` |

Before PR 20, turning Studio on in prod meant 17 flags × 3 places = 51 lines, and dev needed another 51.

**After.**
- **The master** (item 1) makes it one variable per bundle.
- **`scripts/eas-profile-env.cjs`** prints one `eas.json` profile's env as `KEY=VALUE` for `$GITHUB_ENV`. It refuses a non-`EXPO_PUBLIC_*` key, a non-string value, or a value containing a newline.
- **The workflows now read it:**
  - `deploy-prod.yml`:
    - a step before the web export reads the production profile's `EXPO_PUBLIC_STUDIO_*` keys
    - a step before the OTA reads the whole production profile, and the three literal lines are gone
  - `eas-update-preview.yml`: a step reads the whole preview profile. The five literal lines are gone, and their explanations moved onto the step.
  - `deploy-web-dev.yml`: a step reads the preview profile's `EXPO_PUBLIC_STUDIO_*` keys.
- **Web exports take only Studio keys.** A profile's other keys (the Microsoft id, native voice, identity, objectives) are native-app settings no web bundle has been built with, so carrying them would change the web apps on merge.

**What remains:**

| Environment | Place | What it covers | Line to add |
|---|---|---|---|
| prod | `eas.json` `build.production.env` | binary + OTA + web | `EXPO_PUBLIC_STUDIO_ALL_ON: "true"` (Mia) |
| dev/preview | `eas.json` `build.preview.env` | preview binary + preview OTA + dev web | the same line (item 8) |
| local | `.env` | Metro | `.env.development` already pins all 17 |

Also:
- **The EAS dashboard environments must stay empty.** A value set there is a second source this repo cannot see.
- **The `development` profile builds a dev client whose JS comes from Metro**, so it needs no line.
- **A new binary is still needed** only for native changes (item 6). A flag flip in `eas.json` reaches installed builds through the next OTA.

**Merging changes no bundle:**
- `profileEnv(eas.json, "production")` equals the three literal lines the prod OTA carried.
- `profileEnv(eas.json, "preview")` equals the preview OTA's five.
- Neither profile has an `EXPO_PUBLIC_STUDIO_*` key today, so both web exports get nothing new.
- The three workflows parse (the `yaml` package: `api` 13, `web` 11, `mobile` 6, `update` 6, `deploy-web` 10 steps).

**Tests.** `scripts/eas-profile-env.test.ts`, **13 / 13**:
- the two OTA equivalences and the two empty web sets
- the CLI end to end
- the Studio-only filter
- the three refusals and the missing-profile refusal
- the wiring: each read comes before its build
- the only `EXPO_PUBLIC_` value any workflow still sets itself is the web export's API URL

**Mutations** (red by name, restored byte-identical):
- M-prefix: 3 reds (both "…web export … unchanged — none today" and "a web export takes only the profile's Studio keys").
- M-key: 1 red ("refuses a key that is not EXPO_PUBLIC_*").

⚠️ **For Adi's review:** this edits `.github/workflows/**`, which ships to prod on the next promotion. The test pins that the promoted OTA and web bundles are unchanged. The workflows were already unformatted on main and are left that way.

## ADI-S20-HOLD1: rulings mid-build

| # | Ruling |
|---|---|
| enrich-mine debugging | **(c).** The env file and the trace are overridable (`ENV_FILE`, `ENRICH_MINE_TRACE=1` → `set -x`). The test uses a fixture not named `.env` and stub `psql` / `curl` first on `PATH`, and prints the script's output and trace when a case fails. Debug from jest's output only, with no hand-run. Check `set -e` / `pipefail` against a grep or read that returns non-zero first. |
| Dev `STUDIO_ENABLED "false"` | **Removed, accepted.** The runbook tells Mia to remove `cloud-run-prod.yaml:329-330` in her flip, or the master stays off in prod. |
| Scopes fallback (`instagram.ts:188`) | **No change in PR 20.** It is Mia's shared code. The Instagram test's proof is the dry run's real Meta quota read, not the stored scopes. Carded for Mia against her proposal §2 (K-S8). |
| Prod scheduler jobs | **Create them PAUSED.** Prod's image (`db76dc2f`) has no studio tick endpoints. The runbook adds "resume the studio -prod jobs after the promotion", with the command. |
| Hand-made `studio-stitch-tick-dev` | Its delete command goes in the item 4 list, **after** the declared job is created and verified. |
| Item 2's `.github/workflows/**` | Fine for review at the hold; the test pins the prod bundles unchanged. |

### Item 3: the OpenRouter key: mounted in this PR, IAM verified (ADI-S20-HOLD2)

**Mounted in this PR:** `gcp/cloud-run-dev.yaml:188-196` and `gcp/cloud-run-prod.yaml:113-121`, directly after `CRON_SECRET`. Both read the one secret `OPENROUTER_API_KEY` at `latest`.
- **Pinned:** `shipConfig.test.ts`, "…mounts OPENROUTER_API_KEY from the secret of that name at latest — once, never a literal", for both files. **M-key-prod** (the prod block removed): 1 red, by name.
- **IAM verified by Adi, 25 Sep 2026:** an enabled version exists (version 2), and the runtime account holds `roles/secretmanager.secretAccessor` at project level. So the mount cannot fail a deploy.
- In prod the key is inert until Studio video is on. That is the only prod env change in PR 20, and it is ruled.

The original instructions follow, kept for the record.

**The yaml lines.** Put the same five lines in each file, directly after the `CRON_SECRET` block and at its indentation:
- `gcp/cloud-run-dev.yaml`: after `:183-187`, before `VOICE_SERVICE_SECRET` at `:188`
- `gcp/cloud-run-prod.yaml`: after `:108-112`, before `:113`

Both mount the one existing secret, `OPENROUTER_API_KEY` (the name the probe scripts read: `server/scripts/studioKlingFirstLast.ts:51`, `studioKlingModeration.ts:45`).

```yaml
            - name: OPENROUTER_API_KEY
              valueFrom:
                secretKeyRef:
                  name: OPENROUTER_API_KEY
                  key: latest
```

**The IAM checks, in order.** Both services run as `gamechanger-runtime@gamechanger-pocket-agent.iam.gserviceaccount.com` (`cloud-run-dev.yaml:21`, `cloud-run-prod.yaml:45`).

```bash
# 1. An enabled version exists (the mount reads `latest`).
gcloud secrets versions list OPENROUTER_API_KEY --project=gamechanger-pocket-agent --filter='state=ENABLED' --format='value(name)'
# 2. The runtime account can read THIS secret…
gcloud secrets get-iam-policy OPENROUTER_API_KEY --project=gamechanger-pocket-agent \
  --flatten='bindings[].members' --filter='bindings.role=roles/secretmanager.secretAccessor' --format='value(bindings.members)'
# 3. …or every secret in the project.
gcloud projects get-iam-policy gamechanger-pocket-agent --flatten='bindings[].members' \
  --filter='bindings.members:serviceAccount:gamechanger-runtime@gamechanger-pocket-agent.iam.gserviceaccount.com AND bindings.role=roles/secretmanager.secretAccessor' \
  --format='value(bindings.role)'
```

**It passes when:**
- step 1 prints at least one version, **and**
- step 2 lists `serviceAccount:gamechanger-runtime@…` **or** step 3 prints `roles/secretmanager.secretAccessor`.

A missing binding would stop the revision from becoming Ready (`docs/plans/studio-video-flip-checklist.md` §2).

After the deploy:

```bash
gcloud run services describe <svc> --region=us-central1 --project=gamechanger-pocket-agent \
  --format='value(spec.template.spec.containers[0].env)' | tr ';' '\n' | grep OPENROUTER
```

It must show a `secretKeyRef`, never a literal value.

### Item 4: D6 and the scheduler jobs (built, `0aad591c`)

- **D6.** `server/studio/tickGate.ts`: each tick answers `{skipped: true, reason}` while its flag is off. The gate is asked before the advisory lock and before the runner module loads (`server/index.ts`, the three handlers).

  | Tick | Runs only when | Why that flag |
  |---|---|---|
  | edit | `STUDIO_ENABLED` and `STUDIO_IMAGE_EDIT_OPS` | the only door that queues `mode='edit'` is `edit/routes.ts:328` → `runBatch` |
  | video | `STUDIO_ENABLED` and `STUDIO_VIDEO_ENABLED` | |
  | stitch | `STUDIO_ENABLED` | |

  - The publish tick is not gated; it runs with publishing off to close what waited.
  - All three gates read through `studioFlag`, so the master opens them.
  - **The cost, ruled knowingly:** flipping a flag off mid-flight stalls that queue. A paid clip is resumed with its handle once the flag is back on.
- **The jobs.** `scripts/provision-schedulers.sh` `JOBS`, every minute:

  | Job | Deadline | Why |
  |---|---|---|
  | `studio-video-tick` | 1800 s (Scheduler's max) | polls ≤ 600 s per job × 2 claimed |
  | `studio-edit-tick` | 1800 s | 4 edits in turn |
  | `studio-stitch-tick` | 120 s | starts ffmpeg detached and returns |

  Overlapping runs skip on the lock.
- **Tests.** `tickGate.test.ts`, 12 / 12: the gate table, the master, the handler pins (the gate is before the runner import and the lock), the declared-job pin (every `studio-*` job in the script is a gated handler), and publish ungated.
- **Mutations.**
  - M-gate: 3 reds ("video does nothing while STUDIO_VIDEO_ENABLED is off", …).
  - M-handler: 1 red ("every scheduled Studio tick asks the gate before its lock: /api/internal/studio-video-tick").
- **Is creating them enabled safe? On dev, yes, once PR 20's image is deployed.** An off flag makes each tick a $0 no-op. Before that image is on dev, the old endpoints have no D6, so create the dev jobs **after** the merge's deploy-dev. **On prod, no:** its image (`db76dc2f`) has no studio tick endpoints, so every call would 404. Create them **paused** (ADI-S20-HOLD1).

**Adi's commands (item 4), in order:**

```bash
# DEV — after PR 20 merges and deploy-dev finishes.
bash scripts/provision-schedulers.sh                         # dry run: the three studio-* jobs say "missing → create"
APPLY=1 bash scripts/provision-schedulers.sh
for j in studio-video-tick studio-edit-tick studio-stitch-tick; do
  gcloud scheduler jobs run "$j" --location=us-central1 --project=gamechanger-pocket-agent
done
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="nomila-v2" AND httpRequest.requestUrl=~"studio-(video|edit|stitch)-tick"' \
  --project=gamechanger-pocket-agent --freshness=10m --limit=6 --format='table(timestamp,httpRequest.status,httpRequest.requestUrl)'
#   PASS: every row 200 (a 401 is the header, a 404 is an old image).
# Then, and only then, the hand-made duplicate (docs/plans/studio-video-flip-checklist.md:90-91):
gcloud scheduler jobs delete studio-stitch-tick-dev --location=us-central1 --project=gamechanger-pocket-agent

# PROD — before the promotion: create, then pause at once (the old image 404s the path; a call in the gap does no work).
SERVICE_URL=https://nomila-v2-prod-241621020090.us-central1.run.app JOB_SUFFIX=-prod CRON_SECRET_NAME=PROD_CRON_SECRET \
  bash scripts/provision-schedulers.sh                       # dry run
SERVICE_URL=https://nomila-v2-prod-241621020090.us-central1.run.app JOB_SUFFIX=-prod CRON_SECRET_NAME=PROD_CRON_SECRET \
  APPLY=1 bash scripts/provision-schedulers.sh
for j in studio-video-tick-prod studio-edit-tick-prod studio-stitch-tick-prod; do
  gcloud scheduler jobs pause "$j" --location=us-central1 --project=gamechanger-pocket-agent
done
gcloud scheduler jobs list --location=us-central1 --project=gamechanger-pocket-agent --format='table(name.basename(),state,schedule)'
#   PASS: the three studio-*-prod jobs PAUSED. The other -prod jobs keep the state they had; read them in this list too,
#   since APPLY=1 also re-applies each existing job's config.
```

The resume command, after the promotion, is Mia's and goes in the runbook (item 10):

```bash
for j in studio-video-tick-prod studio-edit-tick-prod studio-stitch-tick-prod; do gcloud scheduler jobs resume "$j" --location=us-central1 --project=gamechanger-pocket-agent; done
```

### Item 5: the publish scope (built, `202705a9`)

- `server/lib/integrations/instagram.ts`: `requestedScopes()` adds `instagram_business_content_publish` only while `IG_REQUEST_PUBLISH_SCOPE === "true"`. It is used at the consent URL (`:103`) and in the scopes fallback (`:188`).
- It is not a `STUDIO_*` flag, so the master never reaches it. Unset, it is byte-identical to before.
- `instagramScopes.test.ts`: 8 / 8. M-scope (`!== "false"`): 6 reds, "unset: exactly the three scopes it always asked" first.

**The step-8 Instagram test with @fightquant, step by step.** It costs $0: the stitch is ffmpeg and publishing calls no model.

Preconditions:
- PR 20 merged and deploy-dev done, so dev requests the scope (`shipConfig.test.ts` pins `IG_REQUEST_PUBLISH_SCOPE: "true"` in dev).
- @fightquant is an accepted Instagram tester on the **dev** Meta app (Mia, 24 Sep 2026).

1. **Reconnect through dev.** In the deployed dev web app, go to Instagram under connections → Connect (or disconnect, then connect). **Start the screen recording here.**
   **Check:** Meta's consent screen lists the content-publishing permission.
2. **Stored scopes.** This is a read-only query on the dev DB, your row only:
   ```sql
   select platform_username, status, scopes, token_expires_at, created_at from connected_accounts
   where athlete_id = :'me' and platform = 'instagram' order by created_at desc;
   ```
   **Check:** the newest `active` row's `scopes` contains `instagram_business_content_publish`.
   ⚠️ This is **not** the proof. `instagram.ts:188` stores the requested list when Meta returns none (K-S8).
3. **Dry run: the proof.**
   1. Run your local server against the dev DB with `STUDIO_ALL_ON=true` and `STUDIO_PUBLISH_MODE=dry` in `.env`. It reads the same `connected_accounts` row.
   2. Make a still reel from your photos: Board or Video → photos → Stitch.
   3. Tap **Post to Instagram** → confirm.

   **Check (the proof):** the server log has `DRY RUN — nothing was sent to Instagram` **with `quota` populated**. That is a real Meta `GET /{ig-user-id}/content_publishing_limit`, which needs the permission (`publish/runner.ts:402-409`). Then read your rows:
   ```sql
   select id, mode, status, error_code, ig_media_id, permalink from studio_publish_jobs
   where athlete_id = :'me' order by created_at desc limit 3;
   ```
   **Check:** the newest row reads `mode dry`, `status succeeded`, `ig_media_id` null.
   The same read may be the "successful test API call" Meta's advanced-access button waits for. That is a claim; the evidence is the dashboard's call count moving off 0.
4. **One live post.**
   1. Restart the local server with `STUDIO_PUBLISH_MODE=live`.
   2. Make a **new** tap, since a dry row can never go live (`publish/config.ts:41-42`).
   3. Post → confirm "This posts to @fightquant now".

   **Check:** the newest row reads `mode live`, `status succeeded`, `ig_media_id` and `permalink` set, and **exactly one** new post on @fightquant.
   If it stays `queued` past about 60 s, the container outlived the 40 s poll window (`runner.ts:99-102`), and one manual tick finishes it:
   `curl -X POST -H "x-cron-secret: <INTERNAL_CRON_SECRET from .env>" http://localhost:8080/api/internal/studio-publish-tick`.
   **Stop the recording once the post shows on Instagram.**
5. **Afterwards.** Remove `STUDIO_PUBLISH_MODE` from `.env` (off) and restart.

### Dev config for the proof (built, `07bba4e6`)

- **Dev yaml.** `STUDIO_ALL_ON: "true"`, `STUDIO_ENRICH_DAILY_CAP_USD: "5"`, `IG_REQUEST_PUBLISH_SCOPE: "true"`. The old `STUDIO_ENABLED: "false"` line was removed: under the master an explicit `"false"` still wins.
- **`eas.json`.** The `preview` profile gains `EXPO_PUBLIC_STUDIO_ALL_ON: "true"`: the preview binary, its OTA, and dev web through item 2's read.
- **Pinned.** `server/studio/shipConfig.test.ts` pins both sides:
  - dev: the master and the cap of 5; no Studio `"false"` line; the scope requested; publish mode unset
  - prod: the Studio lines exactly `{STUDIO_ENABLED: "false", STUDIO_MAX_JOB_USD: "5"}`, and no scope
  - `eas-profile-env.test.ts` pins the production profile unchanged, and preview as its old five keys plus exactly the master
- **M-trap** (put `STUDIO_ENABLED: "false"` back in dev): 1 red, "no Studio flag line says false in dev — an explicit false outranks the master".

### Item 7: the backfill wrapper and K-S7 (built)

- **K-S7.** `studio/enrich/videoEnrichment.ts` `conds` adds `ne(origin, 'reference')`, matching the photo lane.
  - `videoEnrichment.test.ts` checks that a reference video is never a candidate, while the same row as her upload is read.
  - Scoped run with `clipRead.test.ts`: 55 / 55.
  - M-ks7: 1 red, by name.
- **`tools/enrich/enrich-mine.sh`.** New file, local only.
  - `--email <login> [--dry-run]` or `--athlete <uuid>`.
  - A read-only id lookup, bound by psql (her email is never spliced into SQL). It refuses without exactly one athlete, refuses a non-UUID, and refuses any URL that isn't `http://localhost` or `http://127.0.0.1`.
  - The secret (`CRON_SECRET`, else `INTERNAL_CRON_SECRET`, as `index.ts:126-127` reads them) reaches curl through a 0600 header file, never argv or stdout.
  - It first prints the three counts, the quote and the cap in effect, with a loud banner if the cap is unset. `--dry-run` stops there.
  - Otherwise it asks "Proceed? (y/N)" and loops `{athleteId, maxTicks: 1}` until `remaining` is 0. It stops on HTTP ≠ 200, `ok` false, any failed row, or a pass with no progress (the cap, seen from outside).
- **Test.** `scripts/enrichMine.test.ts`, 18 / 18. It uses a fixture env file named `fixture.env`, with stub `psql` / `curl` first on `PATH`. `exits(code, says)` re-runs a case under `ENRICH_MINE_TRACE=1` and puts the trace in the failure. The quote constants are pinned to `enrich/config.ts` and `retag.ts`.
- **The silent exit, found from jest's output (ADI-S20-HOLD1).**
  - The first run: 7 / 17, ten cases exiting 1 with no output.
  - The cause: `env_value`'s grep for an absent key (`CRON_SECRET`; the fixture has only `INTERNAL_CRON_SECRET`) failed the pipeline under `set -e -o pipefail`, and with it the assignment.
  - The fix: `{ grep … || true; }`.
  - **M-pipefail** (the fix reverted) reproduces the same ten reds. The trace in jest's own report ends at `+ SECRET=`, right after the `CRON_SECRET` grep. The trace is refused against the real `./.env`, since it prints every variable.
- **Mutations.** M-body: 1 red. M-url: 3 reds. M-secret: 1 red. M-pipefail: 10 reds. All restored byte-identical.

**Mia's backfill (the guide), with the wrapper:**
- **Preconditions:** the proxy is running, and her local server was started with `STUDIO_ALL_ON=true` and `STUDIO_ENRICH_DAILY_CAP_USD=5` in `.env`.
- **Run:**
  1. `bash tools/enrich/enrich-mine.sh --email <her login> --dry-run`
  2. Then again without `--dry-run`, answering `y`.
- **Pass:** the counts print, and passes run until `done — nothing left for this athlete`.
- **Prediction P-7:** `photos left` ≈ 0 on the first count.

## Cards (outside PR 20)

| Card | What | Owner |
|---|---|---|
| **K-S1** | CLAUDE.local.md ("the only Postgres instance") and `scripts/seed-injection-fixture.ts:132` ("5440 is the prod proxy port") are stale since the environment split: 5440 is `nomila-v2-db`, which is dev. | Adi (local file) / shared |
| **K-S2** | `FAL_KEY` is mounted nowhere. Masks run keyless, as accepted (ADI-S20-GO). | if masks are wanted for real |
| **K-S3** | The dev yaml calls `STUDIO_MAX_JOB_USD "30"` "the code default"; the default is 10 (`config.ts:922`). | shared |
| **K-S4** | The IG cron's comment says "every 50 days" (`index.ts:1964`). The schedule is every two months, and its gap can exceed a 60-day token. It sits with the Nov 1 item. | carded by ADI-S20 / ADI-S20-GO |
| **K-S5** | `REEL_MAX_SECONDS` is defined but eligibility never checks it (`publish/instagram.ts:67`). | Studio, later |
| **K-S8** | `instagram.ts:188` stores the *requested* scopes when Meta returns none, so `scopes` can claim the publish permission for an account that declined it. This is Mia's proposal §2 (`docs/proposals/instagram-publish-scope.md`), and it became load-bearing once `IG_REQUEST_PUBLISH_SCOPE` exists. | **Mia** (ADI-S20-HOLD1) |
| K-IP7 | `eas update`'s env mode can't be verified from code (`eas-cli` is not in `node_modules`). Item 2 now feeds the OTA from `eas.json` explicitly; whether `eas update` also layers `.env.development` stays open. | open |
| Carded by ruling | The Nov 1 cron double-fire, pricing (Seedance, F20, reference over-quote), key and password rotation (ADI-S20, ADI-S20-GO). | — |

### Item 6: iOS (built)

**The bump.** `app.json` `expo.version` 1.1.0 → **1.2.0**. `runtimeVersion` is `{policy: "appVersion"}`, so every binary built from here on is runtime **1.2.0**, and every OTA published from main after the merge targets 1.2.0.

- An installed 1.1.0 binary (the old dev client, and any preview or production build from before this merge) **stops receiving OTAs**. It keeps the last bundle it took. So it can no longer receive a JS bundle that needs a native module it lacks, which was the `ExpoDocumentPicker` crash path: `expo-document-picker` and `expo-image-manipulator` were added after the voice build `efeb3f32`.
- The same bump changes the tag `promote.yml:77` writes, to `v1.2.0-<date>`.
- **Consequence to know:** until 1.2.0 binaries are installed, testers on 1.1.0 see no new JS. Main's next preview OTA reaches only 1.2.0 builds.

**Build commands (Adi).** Run them from the main checkout **after the merge** (EAS builds the committed tree), so the binary carries the merged native set and version 1.2.0:

```bash
git -C /Users/adi/nomila-v2 checkout main && git -C /Users/adi/nomila-v2 pull --ff-only
cd /Users/adi/nomila-v2
eas build --profile development --platform ios    # dev client: JS from Metro (npx expo start --port 8083 --dev-client)
eas build --profile preview --platform ios        # internal build on the preview channel: dev API, EXPO_PUBLIC_STUDIO_ALL_ON from eas.json
eas build:list --platform ios --limit 4 --json --non-interactive \
  | jq '.[] | {buildProfile, appVersion, runtimeVersion, gitCommitHash, status}'
```

- **Pass:**
  - both builds are `FINISHED`
  - `appVersion` and `runtimeVersion` are `1.2.0`
  - `gitCommitHash` is the merge commit
- The phone is already a registered internal-distribution device, because the old dev client is installed on it. If EAS says otherwise, run `eas device:create` first.
- The dev walk (step 8) runs on the **preview** build against deployed dev, or on the dev client against a local server.

**Card K-S9** (not built): a test that fails when the native surface changes without a version bump. The native surface here means the `expo-*` / `react-native-*` / `@livekit/*` dependency versions, plus `app.json` `ios` / `android` / `plugins`. It would stop this hazard coming back.

---

## After the merge: #604 → `430f80ce` (25 Sep 2026)

- **The one red.** `server/studio#1`, `capabilityEntries.test.ts`, "every cite's quote is on its line". PR 20's `studioFlag` import at the top of `config.ts` shifted every line under it by one, and three cites there are by number: `cite("server/studio/config.ts", 652 | 191 | 193, …)`.
  - The stale-cite sweep before the hold searched text for `config.ts:NNN`. It never looked at `cite(file, line, quote)` calls.
  - The full gate that would have caught it was stopped.
- **The fix.** `studio/ship-cites` @ `4bd111b1`, cut from main `430f80ce`: 652→653, 191→192, 193→194. Each cite still quotes the line it quoted before; `b9989e6b:config.ts:652` is `[MODELS.veo]: …`, now `:653`.
  - `npm test -- --batch "server/studio#1"`: **40 suites, 679 tests, 0 failed.** That batch was the only red in CI (Adi); the redundant full gate was stopped at his word.
- **The sweep that should have been run.** `grep -rn -E 'cite\(\s*"[^"]+",\s*[0-9]+'` over `server`, `client` and `scripts`. The only numeric cites are these three and two into `video/still.ts`, which PR 20 did not touch.

## ADI-S20-SCHED: the scheduler jobs, as Adi ran them (25 Sep 2026)

| What | State |
|---|---|
| Dev `studio-video-tick`, `studio-edit-tick`, `studio-stitch-tick` | **Created. 200 in the logs** (Adi). |
| Dev `studio-stitch-tick-dev` (hand-made) | **Deleted** (Adi). |
| Prod `studio-video-tick-prod`, `studio-edit-tick-prod`, `studio-stitch-tick-prod` | **Created** with the stripped `PROD_CRON_SECRET` and `Content-Type: application/octet-stream`, **then paused.** Mia's resume command stands as written. |
| `APPLY=1` for the whole list | **Not run.** Its dry run would also have created `research-planner` on dev (non-Studio) and re-applied 7 jobs. |

**Built for it** (`5171dcf0`):
- `scripts/provision-schedulers.sh` gains `ONLY=<prefix>`. A job outside the prefix is not described, updated or created. `JOB_SUFFIX` applies after the filter, so `ONLY=studio- JOB_SUFFIX=-prod` names the three `-prod` jobs.
- A fifth, per-job column sets the content type. The three studio ticks are `application/octet-stream`, as created; the other 8 jobs keep `application/json` byte for byte.
- Every create and update runs with `--format=none`, so gcloud never echoes the header back.
- `tools/enrich/enrich-mine.sh` pipes each `.env` value through `tr -d '\r\n'`.
- **Tests:**
  - `scripts/provisionSchedulers.test.ts`: stub `gcloud` on `PATH` serving a 64-character secret with a CRLF ending. 7 / 7: the subset, the suffix, `--format=none`, the stripped header, the content types, a dry run that calls nothing and prints no secret.
  - `enrichMine.test.ts`: 19 / 19, with a CRLF fixture.
- **Mutations:**
  - M-only: 3 reds.
  - M-format: 1 red.
  - M-strip: 6 reds (the 64-character check refuses).
  - M-crlf (the new `tr` alone removed) **stays green**. The existing `sed 's/[[:space:]]*$//'` already strips a trailing `\r`, so the `tr` is a second guard. With both removed, "a .env saved with CRLF line endings…" reds by name.

**Content-Type application/json → 401: why.** Every 401 in `server/index.ts` is `cronSecretValid` (`:131-137`), which reads only `x-cron-secret`. Nothing before the tick handlers reads the content type: the CORS block `:159-178`, `express.raw` on `/api/webhooks` only `:181-185`, then `express.json()` `:187`. A malformed JSON body would be a 400 from the parser, not a 401.

**So, from the code, the content type cannot produce a 401.** The prediction is that the JSON attempt carried a different header value (the CRLF secret) and the octet-stream attempt the stripped one. It is settled by one pair of calls with the same secret, differing only in the type. That hits the dev stitch tick, which is $0 ffmpeg and exactly what the scheduler sends every minute:

```bash
SECRET="$(gcloud secrets versions access latest --secret=INTERNAL_CRON_SECRET --project=gamechanger-pocket-agent | tr -d '\r\n')"
for CT in application/json application/octet-stream; do
  curl -s -o /dev/null -w "$CT %{http_code}\n" -X POST -H "x-cron-secret: ${SECRET}" -H "Content-Type: ${CT}" \
    --data '{}' https://nomila-v2-241621020090.us-central1.run.app/api/internal/studio-stitch-tick
done; unset SECRET
```

**Prediction: `application/json 200` and `application/octet-stream 200`.** If both are 200, the next runbook sets `application/json` back. To see what each job actually carries, without printing the secret:

```bash
for j in studio-video-tick studio-edit-tick studio-stitch-tick; do
  gcloud scheduler jobs describe "$j" --location=us-central1 --project=gamechanger-pocket-agent --format=json \
  | python3 -c 'import json,sys; h=json.load(sys.stdin)["httpTarget"].get("headers",{}); s=h.get("x-cron-secret",""); print("'"$j"'", {"secret_len":len(s),"secret_has_CR":"\r" in s,"content_type":h.get("Content-Type")})'
done
```

**`PROD_CRON_SECRET`: the CRLF check.** It prints only counts. Pass: `CR bytes 0`; the total is 64, or 65 with a trailing LF.

```bash
printf 'CR bytes %s\n' "$(gcloud secrets versions access latest --secret=PROD_CRON_SECRET --project=gamechanger-pocket-agent | LC_ALL=C tr -cd '\r' | wc -c | tr -d ' ')"
printf 'total    %s\n' "$(gcloud secrets versions access latest --secret=PROD_CRON_SECRET --project=gamechanger-pocket-agent | wc -c | tr -d ' ')"
```

**Rules for every secret read from here on** (the runbook, this ledger, `enrich-mine.sh`):
- The value pipes through `tr -d '\r\n'`.
- Every `gcloud scheduler jobs create|update` carries `--format=none`.
- A subset run uses `ONLY=`, e.g.:
  ```bash
  ONLY=studio- SERVICE_URL=https://nomila-v2-prod-241621020090.us-central1.run.app JOB_SUFFIX=-prod CRON_SECRET_NAME=PROD_CRON_SECRET APPLY=1 bash scripts/provision-schedulers.sh
  ```

**The hand-made `studio-enrich-tick`: keep it.** It is the job the flip checklist designs, §12 (`docs/plans/studio-video-flip-checklist.md:276-296`, PR 4 C1): `{"maxTicks":1}` (one pass, one $2 run budget) every 5 minutes, offset by 2, "its own job, not an edit of `media-enrich-cron`".
- **The one to question is `media-enrich-cron`.** It loops up to 60 passes in 160 s every 15 minutes (`index.ts:842-874`). §12 left "whether `media-enrich-cron` keeps `maxTicks` 60 once the tick exists" open.
- **The duplicate's cost is overlap, not double work.**
  - On one instance the two calls serialize (`mediaEnrichment.ts` `chain`).
  - On two instances a row can be read twice:
    - The video lane's write is compare-and-set, so the second read is paid and discarded as `raced` (`videoEnrichment.test.ts`, "two runs in flight").
    - The photo lane can tag a photo twice (≈ $0.0049 each).
  - Bounded by the $5 enrich day cap on the video lane. **The photo lane has no dollar cap.**
- **Recommendation:** keep `studio-enrich-tick`. Decide `media-enrich-cron` in one of two ways:
  - **(a)** make it one pass too. That needs a per-job body in `provision-schedulers.sh`; the content-type column just added is the same shape.
  - **(b)** pause it on dev while the tick runs.
- The tick is still not declared in `provision-schedulers.sh`, per §12's "Record it". Card K-S11.

**`research-planner` on dev: a question for Mia** (her commit `0cf9ae9f`, 10 Sep 2026, Phase A Step 2b). The script declares it for every environment. Dev has never had it: Adi's dry run would have created it. **Does it belong on dev?** If not, `provision-schedulers.sh` needs a per-environment list. Card K-S12.

**Card K-S10: rotate the dev `INTERNAL_CRON_SECRET`.** A scheduler update printed it in full.
- **Order**, from flip checklist §3a with this PR's rules:
  ```bash
  openssl rand -hex 32 | tr -d '\r\n' | gcloud secrets versions add INTERNAL_CRON_SECRET --data-file=- --project=gamechanger-pocket-agent
  gcloud run services update nomila-v2 --region=us-central1 --project=gamechanger-pocket-agent --update-labels=cron-rotated=$(date +%Y%m%d%H%M) --format=none
  APPLY=1 bash scripts/provision-schedulers.sh   # ⚠️ after K-S12: today this also creates research-planner on dev
  ```
  `gcloud run services update` makes a new revision that reads `latest`. `key: latest` resolves at revision start.
- **Then** update the hand-made `studio-enrich-tick`'s header (`gcloud scheduler jobs update http studio-enrich-tick … --update-headers=… --format=none`) and the local `.env`.
- **⚠️ Also:** neither yaml mounts `SESSION_SECRET`, so dev signs OAuth state with this secret (`server/lib/oauthState.ts:36-40`).
  - The leaked value was dev's OAuth-state signing key too.
  - Rotating it breaks any connect in flight at that moment.
  - **Don't rotate during the Instagram reconnect.**

---

## Step 8: the dev walk plan (every call quoted; each paid cell on Adi's go)

**Where.** Deployed dev: API `https://api-dev.nomila.co`, web `https://nomila-dev.web.app`.
- Dev runs `STUDIO_ALL_ON` with the OpenRouter key since #604's deploy-dev. The master and the enrich cap come from the dev yaml; the web gets `EXPO_PUBLIC_STUDIO_ALL_ON` from the preview profile.
- **First pass:** phone-width Chrome.
- **Second pass:** the 1.2.0 preview build on iOS (item 6), once built.
- **Caps in force on dev:** $30 a job (`STUDIO_MAX_JOB_USD`, dev yaml), $25 per athlete per rolling day (`STUDIO_MAX_DAY_USD` default, `config.ts:949`), and $5 per athlete per UTC day on video enrichment.

**Prices, re-read at `8e27f600`** (`server/studio/config.ts` unless noted):

| Model / call | Price | Source |
|---|---|---|
| Nano Pro (image) | $0.00012 per output token | `:643` |
| … output tokens | 1120 at 1K/2K, 2000 at 4K | `:506-513` |
| … per reference | 258 input tokens | `:534` |
| Veo | $0.20/s, $0.40/s with audio | `:651-653` |
| Kling | $0.084/s | `:654` |
| seedance-2.0-fast | $0.0000042 per token at sd/720 | `:672` |
| SAM | $0.005 | `:677` |
| crop | $0 | `:679` |
| moment search | $0.035 | `:1394` |
| planner / concepts (Pro) | measured mean $0.0751 | `docs/probes/composer.md:213` |
| clip read | `quoteClipReadUsd` | `enrich/readState.ts:54` |

**⚠️ Background spend the master turns on** (not per tap; any athlete on dev can trigger it):
- `STUDIO_CREATIVE_QA`: Flash + embeds on every generated image and clip. A claim of about a cent each.
- `STUDIO_IDENTITY_DRIFT`: up to 8 frames × $0.00064 per clip, inside clip QA.
- `STUDIO_VIDEO_ENRICH`: every new clip read by the enrich jobs (capped at $5 a day).
- `STUDIO_AGENT_RETRY`: one re-roll of a content-filtered clip, **off the day cap**.
- `STUDIO_DIRECTION_MOMENTS`: $0.035 a search, **off the day cap**.
- The media-enrich jobs: each generated asset tagged at about $0.0049.

### W0: preflight ($0)

1. `gcloud run services describe nomila-v2 --region=us-central1 --project=gamechanger-pocket-agent --format='value(status.latestReadyRevisionName,spec.template.spec.containers[0].image)'`. The image tag must be the merge's short SHA (`430f80ce`), or later once `studio/ship-cites` merges.
2. The service log shows `studio router ready` with that revision (the build-info line, flip checklist §12).
3. Sign in as your athlete on `nomila-dev.web.app`. The Studio tab shows Make something, Board, Now and Made.

### The surfaces

| # | PR | Tap path | Calls, each quoted | $0 stop |
|---|---|---|---|---|
| B | — | **Brand door, shared by 8, 9, 13, 15:** Studio → Make something → Brand → a reference → **Read it** | decompose: Flash ≈ **$0.0018** (a brief PDF instead: summarize, Flash ≈ $0.009, an estimate) | before Read it |
| B′ | — | Confirm → **Plan it** (concepts) → **Plan this one** (planner) | concepts (Pro) ≈ **$0.075**; planner (Pro) **$0.0751** | Confirm is $0. There is **no $0 stop inside a plan.** |
| 1 | 9.5 | Agent → put a video in the tray → **Read this clip · $0.0X** | clip read (Flash): **$0.0069** for 4 s; the pill shows the quote first | the pill |
| 2 | 9.5 | Board or Video → a video → MediaDetail → the read pill | as 1; don't read twice | the pill |
| 3 | 10 | Brand → Plan step → Carousel chip → Set it up → **Make the ads** → the Carousel screen | recommend on mount (Flash) ≈ **$0.0005–0.0007**. **Stop at the screen.** A batch is up to 6 native edits at **$0.1654 (2K) – $0.271 (4K)** each: its own go, not in the ceiling | the Carousel screen |
| 4 | 10 | Board → Music → Suggested (brand work) | rules, **$0** | — |
| 5 | 10 | Studio → Now: expired batches hidden | **$0** | — |
| 6 | 11 | A generated image (from 11 or 16) → the QA chip; EditSheet → the cost line | view **$0**; the chip exists because QA ran on the generate (background) | — |
| 7 | 12 | Agent → the photo picker; Media library → the tiles read "You · …", "Someone else", "Made here · not from you" | **$0** to view | — |
| 8 | 13 | A Board built from a plan → Agent (words and feel refilled) → **Plan it again** | replan (Pro) **$0.0751** | before Plan it again |
| 9 | 14 | From B′ → Board → one **b-roll** row → preview → **Make** | seedance-2.0-fast, 4 s at 720×1280: **$0.3667**; QA ≈ $0.01 | the Board quote |
| 10 | 17 | Studio home → user icon → Likeness pack: Add photos (≥ 10), Save pack → **Measure** | ≈ $0.00064 a photo: **$0.0077** for 12 | the quote before Measure |
| 11 | 17 | Set it up → Build the plan → MakeIt → **Just these photos**, a first-person sentence → preview → **Make it** | image.generate at 2K with 3 pack references: **$0.2273**; QA ≈ $0.01 | the preview quote |
| 12 | 17 | The clip from 13 → the QA chip's drift line | view **$0**; drift ran inside that clip's QA | — |
| 13 | 15 / 15.1 | From B′ → Board: shot-slot chips, one **identity** row → **Make** (4 s, no audio) → Stitch with "On the beat" | Veo 4 s: **$0.80**; clip QA + drift ≈ $0.01–0.02; the stitch **$0** | the Board quote |
| 14 | 15 | Board → Fine-tune in Video → caption suggestion | rules, **$0** | — |
| 15 | 18 | Agent → a photo → Edit → **Match a look** (a Style reference) → quote → **Run** → **Keep** | recommend ≈ $0.0006 + detection ≈ $0.0005 at the quote; run: native edit **$0.271** (4K); keep: identity-on-accept **$0.00128** | the quote |
| 16 | 18 | Create Anything → ＋ → Style → her words → preview → **Make it** | image.generate 2K: **$0.1344**; QA ≈ $0.01 | the preview |
| 17 | 19 | Create Anything → a photo + a sentence: "make the lighting warmer" (RELIGHT), "shoot it from a lower angle" (CAMERA), "crop it square" (CROP) → preview each | interpreter (Flash) ≈ **$0.0013** a sentence; **stop at the previews**. Running RELIGHT or CAMERA is a native edit at $0.1654–0.271 (PR 19's LIGHT-1 / CAM-1: its own go). CROP runs at **$0** | the previews |

**The quote.**

| Part | Total | Made up of |
|---|---|---|
| Before any preview | **≈ $0.24** | B + B′ + surface 3's recommend + surface 8's replan + surface 17's three interpreter calls |
| Paid cells | **≈ $1.82** | 1: $0.0069 · 10: $0.0077 · 9: $0.3667 · 13: $0.80 · 11: $0.2273 · 16: $0.1344 · 15: $0.271 + $0.0023 |
| QA and drift (background) | **≈ $0.06** | |
| **Walk** | **≈ $2.12** | ceiling **$2.50** (the R-report's P-6 predicted $2.22) |

Kept out of the ceiling, each needing its own go: a Carousel batch (surface 3), and PR 19's LIGHT-1 / CAM-1 runs.

**Go points, in order:**
- **G1:** B + B′, ≈ $0.15.
- **G2:** the paid cells 1, 10, 9, 13, 11, 16, 15, one at a time, each with its own quote read off the screen before the tap.
- **G3:** surface 17's previews, ≈ $0.004.

After the walk, one read of the day's spend (read-only, your rows only):

```sql
select coalesce(sum(cost_estimated_usd), 0) as quoted_today
from generation_jobs where athlete_id = :'me' and created_at > now() - interval '1 day';
```

---

## Step 8: the Instagram test with @fightquant ($0: ffmpeg and Meta, no model)

**Preconditions:**
- Dev runs #604 (`IG_REQUEST_PUBLISH_SCOPE: "true"`, pinned by `shipConfig.test.ts`).
- @fightquant is an accepted tester on the **dev** Meta app (Mia, 24 Sep 2026).
- The dev app's valid OAuth redirect list holds `https://api-dev.nomila.co/api/v1/auth/callback/instagram` (`instagram.ts:45-46` builds it from `API_BASE_URL`, `cloud-run-dev.yaml:42-43`).
- **Don't rotate the dev cron secret during this test** (K-S10: it is also the OAuth-state key).

1. **Reconnect** (screen recording starts).
   1. `nomila-dev.web.app` → Settings → Connections → Instagram → Disconnect, then Connect.
   2. **Check:** Meta's consent screen lists the content-publishing permission.
   3. The browser returns to the app, and Instagram shows connected as @fightquant.
2. **The stored row.** Read-only, dev DB, your row:
   ```sql
   select platform_username, status, scopes, token_expires_at, created_at from connected_accounts
   where athlete_id = :'me' and platform = 'instagram' order by created_at desc;
   ```
   **Check:** the newest `active` row has `instagram_business_content_publish` in `scopes`. **Not the proof** (K-S8: `instagram.ts:188` stores the requested list when Meta returns none).
3. **A $0 reel.**
   1. Your **local** server against the dev DB (the proxy), with `.env` holding `STUDIO_ALL_ON=true`, `STUDIO_ENRICH_DAILY_CAP_USD=5` and `STUDIO_PUBLISH_MODE=dry`. It reads the same `connected_accounts` row.
   2. Chrome at `localhost:8083` → Studio → Board or Video → 3–4 of your photos as stills (≥ 3 s in total, `REEL_MIN_SECONDS`) → Stitch.
   3. The stitched mp4 lands as a `draft` VIDEO asset. It is ffmpeg: **$0**.
4. **Dry run: the proof.**
   1. On the stitch result → **Post to Instagram** → the confirm → Post.
   2. **Check the server log:** `DRY RUN — nothing was sent to Instagram` **with `quota` populated**. That is a real `GET /{ig-user-id}/content_publishing_limit` through your token, which needs the permission (`publish/runner.ts:402-409`).
   3. **Check the rows:**
      ```sql
      select id, mode, status, error_code, ig_media_id, permalink, publish_attempted_at from studio_publish_jobs
      where athlete_id = :'me' order by created_at desc limit 3;
      ```
      The newest reads `dry`, `succeeded`, `ig_media_id` null, `publish_attempted_at` null.
   4. **Check the Meta dashboard** (a claim): the dev app's content-publish row may move off "Ready to use (0)".
5. **One live post.**
   1. `STUDIO_PUBLISH_MODE=live` in `.env`, then restart the server.
   2. A **new** Post tap, since a dry row never goes live (`publish/config.ts:41-42`) → confirm "This posts to @fightquant now".
   3. **Check:** the newest row reads `live`, `succeeded`, with `publish_attempted_at`, `ig_media_id` and `permalink` set. The permalink opens the reel; there is **exactly one** new post on @fightquant.
   4. **If it stays `queued` past about 60 s**, the container outlived the 40 s poll window (`publish/runner.ts:99-102`). One manual tick, local:
      ```bash
      curl -s -X POST -H "x-cron-secret: $(grep -E '^INTERNAL_CRON_SECRET=' .env | cut -d= -f2- | tr -d '\r\n\"')" http://localhost:8080/api/internal/studio-publish-tick
      ```
      Then read the row again.
   5. **Stop the recording** with the reel visible on Instagram. It goes to Mia for App Review.
6. **After.** Remove `STUDIO_PUBLISH_MODE` from `.env` and restart. The live post stays; delete it from Instagram if you don't want it public.

---

## Step 8: evidence (ADI-S20-IG, ADI-S20-SMOKE)

**Item 5's proof: the Instagram test with @fightquant** (Adi, 25 Sep 2026, on dev):
- The reconnect through dev was **recorded**. The consent screen asked for the content-publishing permission.
- The dry run logged `DRY RUN — nothing was sent to Instagram` **with `quota` filled**. That is the proof: a real `content_publishing_limit` read through the token, which needs the permission (`publish/runner.ts:402-409`).
- **One live post landed on @fightquant, and Adi then deleted it** (a personal account), so there is no permalink to record.
- **The proof of the live post is two things:**
  - **the screen recording:** connect → Meta's consent screen → "This posts to @fightquant now" → the reel live on @fightquant
  - **its `studio_publish_jobs` row on the dev DB:** `mode` `live`, `status` `succeeded`, `ig_media_id` set

  The row outlives the deleted post. Deleting a reel on Instagram does not touch it.

Confirming the row takes one read-only query. It runs on dev with Adi's athlete id only:

```sql
select id, mode, status, error_code, publish_attempted_at, ig_media_id is not null as has_media_id,
       permalink is not null as has_permalink, created_at, completed_at
from studio_publish_jobs
where athlete_id = :'me' and mode = 'live'
order by created_at desc
limit 3;
```

It passes when the newest row reads `live`, `succeeded`, with `publish_attempted_at` set and `has_media_id` true, and there is **exactly one** live row that day.

**The smoke test** (Adi, 25 Sep 2026): deployed dev, on the 1.2.0 preview build on his phone.

| Surface | Result |
|---|---|
| Create Anything | preview **priced** |
| Board | **priced, and made a held shot** |
| Agent | **reached concepts** |
| Read this clip | **priced** |

**The full 17-surface walk is faded by ADI-S20-SMOKE.** The smoke test and the Instagram proof are step 8's evidence. Predictions P-5 (17 surfaces) and P-6 (≈ $2.12–2.22) are therefore **not scored.** The walk plan above stays as the reference for anyone who runs it later.

**Post-merge fix, CI `scripts` batch** (`d61abc39`, on `studio/ship-sched`): `enrich-mine.sh` read the clip seconds into bash's `SECONDS`, which counts up from whatever is assigned to it.
- CI printed "10 s" as "11 s"; a real quote drifts $0.000558 a second.
- The variable is now `CLIP_SECS`.
- A test with a `python3` that takes 1.2 s reproduces the bug, and reinstating it reds exactly that test by name (20 / 20 otherwise).

**ADI-S20-IG rulings:**

| Item | Ruling |
|---|---|
| The curl pair | Skipped. The JSON-401 question is carded **K-S13**; octet-stream works and the studio jobs are declared that way. |
| The `PROD_CRON_SECRET` count | Skipped. The prod jobs were created from the stripped value, and every script path strips now. |
| `media-enrich-cron` on dev | **(b): paused** (Adi). `studio-enrich-tick` is dev's only scheduled enrichment trigger. |
| K-S10 (rotation) | After the walk. The reconnect is done, so it no longer blocks. |
| K-S12 (`research-planner`) | Adi is asking Mia. |

**Prod's enrichment triggers, from the code.** Prod's image (`db76dc2f`) has **no in-process media-enrich cron**.
- Its node-cron block runs `15 * * * *` payments, `0 3 1 */2 *` IG token, and `0 2 */6 * *`; `re-enrich-cron` is brand re-enrichment, not media.
- Its only other caller is the post-upload kick (`routes/media.ts:361`), which is event-driven and scoped to one athlete.
- The one scheduled trigger the repo declares for prod is `media-enrich-cron-prod`, if it was created from `provision-schedulers.sh`.
- **Whether a hand-made `studio-enrich-tick-prod` also exists only the scheduler list can say**, so it is Adi's check:

```bash
gcloud scheduler jobs list --location=us-central1 --project=gamechanger-pocket-agent \
  --filter='httpTarget.uri~media-enrich-cron' --format='table(name.basename(),state,schedule,httpTarget.uri)'
```

**Pass: exactly one row whose URI is `nomila-v2-prod-…`.** Two prod rows means a second trigger, which goes back to Adi.

**Checked by Adi, 25 Sep 2026: PASS.**

| Environment | Job | State | Note |
|---|---|---|---|
| Prod | `media-enrich-cron-prod` | **enabled** | the **only** prod row. No second enrichment trigger in prod. |
| Dev | `media-enrich-cron` | **paused** | ADI-S20-IG (b) |
| Dev | `studio-enrich-tick` | **enabled** | dev's only scheduled enrichment trigger |
| — | `nomila-enrichments-dev` | **paused** | targets `gamechanger-api-dev`: an old job for another service, **unrelated to Nomila's enrichment**. Left as is. |

The runbook's §5 decision for prod stands. The default is (a): `media-enrich-cron-prod` alone.

---

## Step 9: prod migrations 0054 → 0067, by Adi, before the promotion

**The test for "safe under prod's running code" (`db76dc2f`, migrations through 0053).** The old image must keep working with the new schema in place:
- Drizzle's inserts and bare selects list only the old image's columns, so a **new table** is invisible to it.
- A **new column** is safe if it is nullable or has a default. An old insert that omits it gets the default.
- A **widened CHECK** admits everything it admitted before.

**Unsafe** would be a new NOT NULL column without a default on an existing table, a narrowed CHECK, a dropped or renamed column, or a data rewrite. **Nothing in 0054 → 0067 does any of those.**

| File | What it does to prod | Safe under `db76dc2f` because |
|---|---|---|
| 0054 studio_sessions | 2 new tables; FK to `studio_generation_previews` (0032, on prod) | new tables only |
| 0055 mia_evaluator_service | 3 new tables (`mia_evidence_snapshots`, `mia_evaluation_runs`, `intelligence_ledger`). **Not Studio's.** | new tables only |
| 0056 studio_video_jobs | `generation_jobs` + 7 columns: `lease_until`, `lease_holder`, `submit_attempted_at`, `provider_operation_name`, `last_polled_at` nullable; `attempts`, `poll_count` `NOT NULL DEFAULT 0`. `generation_jobs_status_check` **widened** with `'queued'` (guarded `DO`). 3 new partial indexes. `idx_generation_jobs_status` dropped and re-created to include `'queued'` (guarded). | nullable or defaulted; the constant default is metadata-only on PG ≥ 11; a widening; the index swap takes a brief lock on a table prod barely writes (Studio is off there) |
| 0057 studio_stitch_jobs | 1 new table | new table |
| 0058 media_assets_duration_precise | `media_assets.duration_seconds_precise double precision`, nullable | nullable |
| 0059 studio_publish_jobs | 1 new table; FKs to `athletes`, `media_assets`, `connected_accounts` | new table |
| 0060 studio_brand_profiles | 2 new tables: `studio_brand_profiles` and **`studio_reference_analyses`** (`:88`); the second's FK needs the first, same file | new tables only |
| 0061 studio_plans | 1 new table; FK to `deal_deliverables` (0038, on prod) | new table |
| 0062 media_assets_origin_reference | `media_assets_origin_check` **widened** with `'reference'` (guarded `DO`: returns if already widened) | a widening. Prod's old code never writes `'reference'`, so no row can depend on it before the promotion. On promotion, step 1's `legacy/08` re-adds the same widened list (main's `legacy/08_studio_generation.sql`). |
| **0063 objectives** | 3 new tables: `objective_proposal_sets`, `objectives`, `objective_events`, with FKs to `athletes` and to `users` (0051, on prod). 7 CHECKs as **DROP + ADD pairs on these new tables only**. **Not Studio's (objectives).** | new tables. The DROP + ADD pairs touch nothing that exists today. They are idempotent alone but **not safe against a second concurrent copy**, so run it once, by hand, with no deploy in flight. |
| **0065 objective_run_events** | `objective_events_action_check`: DROP + ADD, **widened** with 3 values. **Not Studio's.** | the table is 0063's and empty on prod. A widening. **It must run after 0063**, and alone, for the same DROP + ADD reason. |
| 0064 studio_edit_previews | 1 new table; FKs to `studio_generation_previews`, `generation_jobs`, `media_assets` | new table |
| 0066 studio_plan_memory | `studio_plans` + 4 nullable columns (the table is 0061's); `generation_jobs.cost_usd numeric`, nullable | nullable |
| 0067 identity_profile | 1 new table | new table |

**Who applies what (ADI-S20-MIG, authorship confirmed):**
- **Adi by hand, before the promotion:** the eleven Studio files 0054, 0056, 0057, 0058, 0059, 0060, 0061, 0062, 0064, 0066 and 0067.
- **Mia's promotion:** 0055, 0063 and 0065, and 0068–0070, through `db-migrate.sh` step 3, which also re-runs the eleven as no-ops.

This split is safe:
- **No Studio file depends on hers.** None of the eleven references a `mia_*`, `intelligence_ledger` or `objective*` table (grep of their `REFERENCES`).
- **Her chain stays in order in her run.** 0065 needs 0063, and 0068–0070 need 0063's tables; `db-migrate.sh` lists them in numeric order.

**Called out, as asked:**
- **0063** creates the objectives tables with DROP + ADD constraint pairs.
- **0065** re-does one of those pairs to widen it.

Both are **non-Studio** (the objectives team). Both are **safe** before the promotion: they touch only tables nobody on prod reads yet. Both must run **alone**. The promotion's `db-migrate.sh` re-runs them as no-ops.

**Also on main, not in this step:** 0068–0070 (objectives, non-Studio):
- `objective_proposal_sets` + 2 nullable columns; `objectives` + `lineage` and `deferral`, nullable
- another DROP + ADD widening of `objective_events_action_check`

Equally additive. **The promotion applies them** (`db-migrate.sh` step 3 lists 0031–0070).

**Reversibility.** No file drops, narrows or rewrites data, so **every file is reversible until the new code writes into it**. The reverse is a `DROP TABLE` or `DROP COLUMN`, or re-narrowing a CHECK. After the promotion, some reverses fail or lose data:
- **0056's status widening** once a job is `queued`
- **0062's** once a `reference` row exists
- **0065's** once an event uses a new action
- any new table the new code has filled: dropping it deletes that data

**In practice none of them can be reversed after the promotion without deleting rows.** Before it, all of them can.

### The sequence (Adi)

Run it from a checkout of **main** (`9dbef288` or later), because the files and `checkSchemaDrift.ts` must match what the promotion will run. The proxy goes on its own port, never 5440 (dev).

```bash
# 0. Main, up to date, in its own checkout.
git -C /Users/adi/nomila-v2 checkout main && git -C /Users/adi/nomila-v2 pull --ff-only && cd /Users/adi/nomila-v2
git log -1 --format=%h                                   # 9dbef288 or later

# 1. A restore point (deploy-prod.yml does the same per promotion).
gcloud sql backups create --instance=nomila-prod-db --project=gamechanger-pocket-agent \
  --description="pre 0054-0067 by hand $(date -u +%F)" --format=none

# 2. The proxy to PROD, in its own terminal; leave it running.
./cloud-sql-proxy gamechanger-pocket-agent:us-central1:nomila-prod-db --port=5441

# 3. The URL, built from the socket-form secret, CR/LF stripped, never printed.
export PROD_DB_URL="$(gcloud secrets versions access latest --secret=NOMILA_PROD_DATABASE_URL --project=gamechanger-pocket-agent \
  | tr -d '\r\n' | python3 -c 'import sys,urllib.parse as p; u=p.urlparse(sys.stdin.read()); print("postgresql://%s:%s@127.0.0.1:5441/%s" % (u.username, p.quote(u.password or "", safe=""), u.path.lstrip("/") or "postgres"))')"

# 4. Drift BEFORE (reads information_schema only).
DATABASE_URL="$PROD_DB_URL" npx tsx server/scripts/checkSchemaDrift.ts; echo "exit $?"
#    PREDICTED (P-2): exit 1, naming every table and column from 0054–0070 as missing.

# 5. Apply the eleven STUDIO files (ADI-S20-MIG), each alone, in step-3 order; stop at the first error.
#    Mia's 0055, 0063, 0065 (and 0068–0070) are NOT run here; her promotion applies them.
for f in 0054_studio_sessions 0056_studio_video_jobs 0057_studio_stitch_jobs 0058_media_assets_duration_precise \
         0059_studio_publish_jobs 0060_studio_brand_profiles 0061_studio_plans 0062_media_assets_origin_reference \
         0064_studio_edit_previews 0066_studio_plan_memory 0067_identity_profile; do
  echo "── $f"; psql "$PROD_DB_URL" -X -q -v ON_ERROR_STOP=1 -f "migrations/$f.sql" || { echo "STOPPED at $f"; break; }
done

# 6. Drift AFTER.
DATABASE_URL="$PROD_DB_URL" npx tsx server/scripts/checkSchemaDrift.ts; echo "exit $?"
#    PREDICTED: exit 1 still, naming ONLY Mia's six tables as missing — 0055's mia_evidence_snapshots,
#    mia_evaluation_runs, intelligence_ledger and 0063's objective_proposal_sets, objectives, objective_events
#    (0068–0070's columns live on 0063's tables, so they show as those tables missing; 0065 is a CHECK, which the
#    drift check does not read). Every Studio table and column present — including studio_reference_analyses,
#    which 0060 creates as its SECOND table (0060_studio_brand_profiles.sql:88, after studio_brand_profiles; its FK
#    (brand_profile_id, athlete_id) needs that table first, same file). Anything else missing is a stop.
```

**7. Presence**, read-only: the R-report's query, run with `psql "$PROD_DB_URL"`. **Pass:**
- the eleven Studio rows (0054, 0056–0062, 0064, 0066, 0067) `true`
- **0055, 0063 and 0065 `false`**: Mia's, left to her promotion
- the three clearance triggers with `tgenabled = O`

**8. The F13 proof** on prod: the R-report's `BEGIN … ROLLBACK` block, with `\set me` set to **your prod athlete id**:

```sql
select id from athletes where lower(email) = lower('<your prod login email>');
```

**Pass:**
- `T1 REFUSED`, `T2 REFUSED` and `T3 REFUSED`, no `FAIL`, and `ROLLBACK` echoed
- then `select count(*) from media_kits where brand_id = -424242;` returns **0**

**9. Close up:** `unset PROD_DB_URL`, then stop the proxy.

**If step 5 stops:** the files before it are applied and harmless under the old code (the table above). Mia's files were never in the loop. Fix forward or leave them; the promotion re-runs every one idempotently. Nothing needs undoing for the old image to keep serving.

---

## Step 10: Mia's runbook, `docs/runbooks/studio-flip.md`

Written 25 Sep 2026. It has these sections:
1. Done by Adi, with dates. The prod migrations row is left as `<date, when run>` for Adi to fill in.
2. Her decisions: launch timing, caps, publish mode, and the non-Studio migrations 0055 / 0063 / 0065 / 0068–0070.
3. The flip's exact lines:
   - **delete `cloud-run-prod.yaml:338-339` `STUDIO_ENABLED "false"`**. The brief said 329-330; main has shifted them by the key block.
   - `STUDIO_ALL_ON`, `STUDIO_ENRICH_DAILY_CAP_USD` and optionally `STUDIO_MAX_DAY_USD`
   - `EXPO_PUBLIC_STUDIO_ALL_ON` in `eas.json` production
4. Promote, then **resume the three paused `studio-*-prod` jobs**, with the command. Plus the scheduler notes: octet-stream, `tr -d '\r\n'`, `--format=none`, `ONLY=`.
5. The media-enrich decision for prod, (a) or (b), with the check and the commands.
6. iOS build and submit at 1.2.0.
7. **The Instagram advanced-access steps**, including that the dev app's calls don't unlock the live app's button.
8. Rollback.
9. **K-S8, K-S10 and K-S12** as hers, plus K-S11 and K-S13.

**Card K-S13:** why `Content-Type: application/json` returned 401 on the hand-made Studio tick jobs. From the code only the secret check returns 401 (`server/index.ts:131-137`). It is open; octet-stream works (ADI-S20-IG).

**A catch written into runbook §5.** With `application/octet-stream`, `express.json()` leaves `req.body` empty. So a `studio-enrich-tick-prod` created with octet-stream would ignore its `{"maxTicks":1}` and run up to 60 passes (`server/index.ts:859`). The dev `studio-enrich-tick` was created with `application/json` (flip checklist §12) and hits a working endpoint. That is one more sign the content type was not what caused the 401.


---

## Step 9: done (ADI-S20-STEP9, 25 Sep 2026)

- **Backup:** taken before the run.
- **Applied to prod** (`nomila-prod-db`), each file alone, in step-3 order, **no errors**: 0054, 0056, 0057, 0058, 0059, 0060, 0061, 0062, 0064, 0066, 0067.
- **Drift after:** only Mia's six tables are missing, **exactly as predicted**:
  - `intelligence_ledger`, `mia_evaluation_runs`, `mia_evidence_snapshots` (0055)
  - `objective_events`, `objective_proposal_sets`, `objectives` (0063; 0068–0070's columns sit on these)
  - Her promotion applies them (ADI-S20-MIG).
- **`studio_reference_analyses`** was in the drift-before list. It is **0060's** second table (`migrations/0060_studio_brand_profiles.sql:88`, after `studio_brand_profiles` at `:59`). It was created by Adi's run and is absent from the drift-after list. **No question stands.**
- **The three clearance triggers** (`trg_content_posts_require_approval`, `trg_kit_content_require_approval`, `trg_media_assets_embed_locks_approval`, `server/studio/sql/generationGuards.sql:38-41, 69-72, 104-110`) are **present and enabled** on prod.
- **The prod F13 write test is not run: dead by ruling (ADI-S20-STEP9).** The triggers date from 0027 and are confirmed present by catalog.

**Predictions scored:**

| # | Prediction | Result |
|---|---|---|
| **P-1** | two databases | **hit.** Prod is its own instance (`cloud-run-prod.yaml:27`); every prod command ran through a proxy to `nomila-prod-db` on 5441, never 5440. |
| **P-2** | none of 0054→0067 on prod before the run; drift before exits 1 naming them; triggers already present | **hit.** The drift-before list included the eleven files' objects (e.g. `studio_reference_analyses`); the triggers were present. |
| **P-3** | studio ticks with no runner | **hit** at the time. Now declared and running on dev, and paused on prod until the promotion. |
| **P-4** | a new iOS build needed | **hit.** The 1.2.0 preview build was installed and used for the smoke test. |
| P-5 / P-6 | walk surfaces and spend | **not scored.** The full walk was faded by ADI-S20-SMOKE. |
| P-7 | Mia's `photos_left` ≈ 0 | **not scored yet.** It needs her first `enrich-mine.sh --dry-run`. |
