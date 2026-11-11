# Studio quality, scrappy — ledger

Branch `studio/quality-scrappy`, worktree `/Users/adi/nomila-v2-worktrees/quality`, base **311cfc78**
(origin/main, #672). The brief is Adi's message of 2026-09-28, cited here as **ADI-QS-GO**. Six pieces,
each behind its own flag, flag off byte-identical.

## Phase R — 2026-09-28 (recon only; nothing built, nothing spent)

### Where each piece hooks in

| #   | piece                       | new file(s)                                                          | hooks (file:line on 311cfc78)                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | manifest + Seedance dialect | `server/studio/compile/targets/manifest.ts`, `…/targets/seedance.ts` | assert: `preview.ts:1029-1057` (after `providerParams`, before the return at `:1059`) as a blocker under the flag, plus a matrix test over `adapters/openrouter.ts:347` `videoBody` and the Vertex body; dialect: `video/prompts.ts:563` (broll arm) / `:479` (template); model seam: `preview.ts:821` and the run's `videoRunner.ts:117`                    |
| 1r  | rider                       | —                                                                    | `config.ts:207-209`, `video/shotType.ts:52-53`; same stale claim also at `types.ts:88-89`, `shotType.ts:61-80`, `prompts.ts:541-549`                                                                                                                                                                                                                         |
| 2   | clip structural check       | `server/studio/qa/structure.ts`                                      | clip: `videoRunner.ts:410-466` (bytes in hand), run after `succeedJob` in its own try/catch beside the QA block at `:504`; stitch: `stitchRunner.ts:318` (local output) → write after `:331` publish gives the asset id; wire: `qa/routes.ts:92` `presentVerdict`; chip: `client/components/studio/QaChip.tsx`                                               |
| 3   | shot detection              | `server/studio/video/shots.ts`, `tools/quality/backfill-shots.ts`    | store: `media_assets.metadata.shots` (sibling of `vision`); run at the clip read, `enrich/videoEnrichment.ts:295` (same downloaded bytes); snap: `agent/cast.ts:1099` `trimFor`                                                                                                                                                                              |
| 4   | prompt templates            | `server/studio/compile/targets/registry.ts`                          | freeze onto the brief at `routes/studio.ts:1503` (beside the carrier — the precedent for a route enriching the brief before `previewGeneration`); read: `video/prompts.ts:479` (b-roll), `:417-444` (identity), `compile/image.ts:66` `buildPrompt` generate arm                                                                                             |
| 5   | output gate                 | `server/studio/qa/gate.ts`, a client notice                          | reads structure + the verdict's `text`; record on the asset; wire on `qa/routes.ts` and the job status route; re-quote door `POST /studio/jobs/:jobId/requote`                                                                                                                                                                                               |
| 6   | finishing                   | —                                                                    | loudnorm: `video/plan.ts:460-471` (after the final audio node); 9:16 crop: `plan.ts:105` `videoNormalizeChain` (reuse `video/firstFrame.ts:83` `windowFor`); safe zone: `video/captionRender.ts:74` `captionBandGeometry` (the caption-preview route draws through the same function, so preview = render); beat snap: `video/spec.ts:806` `toStitchRequest` |

### Flags (studioFlag table, `studioFlag.test.ts` FLAGS)

`STUDIO_DIALECTS`, `STUDIO_CLIP_QC`, `STUDIO_SHOT_DETECT`, `STUDIO_PROMPT_REGISTRY`, `STUDIO_OUTPUT_GATE`,
`STUDIO_FINISHING` — readers in `config.ts` beside the others, all through `studioFlag`.

Recommended **explicit `"false"` on dev** until each is seen: `STUDIO_DIALECTS` (changes real b-roll
spends), `STUDIO_OUTPUT_GATE` (changes what she is told), `STUDIO_FINISHING` (moves every portrait
caption, changes every stitch's loudness). `STUDIO_CLIP_QC`, `STUDIO_SHOT_DETECT` and
`STUDIO_PROMPT_REGISTRY` can ride the master ($0, observational or fall-through). The lines are Adi's
to add; `gcp/**` is out of lane.

### What the prompts registry can hold without DDL

`prompts(id, key text, version int, body text, status draft|published|archived, hash text =
sha1(body)[:12], note text, created_by, created_at, published_at)`; one published row per key
(partial unique index). **No jsonb column.** `resolvePrompt` returns the body only — not the version.
Nothing in code writes the table.

### Beat grid and first-frame crop

- Beat grid: detector `video/beatGrid.ts` (offline, spectral flux); per-bed grids in `video/beds.ts:135-220`
  (`beat`) and `music/tracks.ts:96-150` (`bpm`, `firstBeatSec`); served by `bedCatalog` (`beds.ts:345`);
  the stills' snap is client-side (`client/screens/studio/beatLogic.ts`). Nothing snaps clip cuts today.
- First-frame crop: `video/firstFrame.ts` (`windowFor` :83, `cropToAspect` :109, `frameForClip` :181; sharp
  `attention` saliency, `focus` seam), called from `videoRunner.ts` `framedReferences`. A clip read carries
  no subject position (`enrich/videoTag.ts:110`: a subject enum and a prominence, no box), so the stitch
  crop is centre-only today.

### Manifest sources

OpenRouter `GET /api/v1/videos/models`, read 2026-09-28 ($0, no key): Seedance 2.0 and 2.0-fast pass
through only `watermark`, `req_key` (**no negative prompt**); 2.0-fast 480p/720p; both 4–15 s, first +
last frame, audio, seed. Kling v3 std: `negative_prompt`, `cfg_scale`; 720p; 16:9 / 9:16 / 1:1; 3–15 s.
Veo 3.1: `negativePrompt`, `personGeneration`, `aspectRatio`, `conditioningScale`, `enhancePrompt`;
16:9 / 9:16; 4/6/8 s. Vertex fields cite Google's docs at build, or are marked unverified (V10: no
recorded Vertex read for `lastFrame`).

Seedance dialect source: the Seedance 2.0 prompt guide (BytePlus ModelArk 2222480 / Volcengine
82379/2222480). The official page did not render through a fetch here; a secondary reading of it gives
**Subject → Action → Environment → Camera → Style → Constraints**, one primary camera instruction,
60–100 words. The official text is read before the emitter is written, or the step is marked secondary.

### Overlap

No other Claude session (ListAgents: none) and no jest process running at recon. The only recent
unmerged Studio branch touching these files is `studio/video-publish-instagram` (`video/plan.ts`, 8 days,
parked on Meta review) — piece 6 edits the same file.

## Decisions requested at the hold

- **R1 — registry metadata (stop-and-ask).** No JSON field exists. The only home without DDL is the
  `body` text as a JSON envelope `{meta, template}`, read only by the Studio reader; malformed, or missing a
  required slot (`{{direction}}` always, `{{preservation}}` on identity), falls back to the TS literal.
- **R2 — "the job's jsonb".** `generation_jobs` has one jsonb, the frozen `brief`. Proposed: template
  key + version + hash + body frozen onto the brief at the quote (the run compiles from the frozen body,
  so a publish never moves a queued clip); the gate's outcome goes on the ASSET
  (`metadata.creative_qa.gate`) plus a log line, and `generation_jobs.status` is not flipped.
- **R3 — loudnorm vs the bed level.** Final-mix loudnorm to −14 LUFS makes Quiet/Medium/Loud identical on
  a timeline whose clips are all silent (today: every generated clip).
- **R4 — the safe zone moves "Bottom".** Portrait band is 256 px; Bottom sits at y 1446–1702, the limit is
  1248, so Bottom moves to y 992 on every portrait caption (centre at 58 % of height, 160 px below
  Middle). Top moves down 110 px. Middle never moves.
- **R5 — rider widened** to the three other copies of the stale claim listed above (comments only).
- **R6 — D1 for the dialect.** The dialect is chosen from the route's model at the quote and from the
  ROW's model at the run (`job.model` into `plannedInputs`), which closes ledger D1 for this template.
- **R7 — $0 reads that need a go:** one read-only SELECT for exhibit A's (`d076a790`) stored path, scoped
  to her athlete; `gsutil cp` of that clip and the ten beds from the dev bucket.

## Predictions — registered 2026-09-28, before any measurement

| id  | prediction                                                                                                                                       | confidence  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| P1  | Adi picks the dialect as more "shot-like" on ≥ 2 of 3 blind pairs                                                                                | 60 %        |
| P1b | all 6 clips come back (text-to-video, no person), each invoiced at exactly $0.3667                                                               | 90 %        |
| P1c | the manifest assert over today's reachable payload matrix finds 0 violations                                                                     | 85 %        |
| P1d | dialect prompts land 60–110 words on a brief with no campaign (today's b-roll goldens: 116–223)                                                  | 75 %        |
| P2  | fixtures: black → fail, frozen → fail, wrong aspect → fail, clean → pass (deterministic)                                                         | 95 %        |
| P3  | exhibit A at the chosen threshold: 0–2 shot boundaries — its six Flash beats are activity phases in what is likely one continuous take, not cuts | 60 %        |
| P3b | ≤ 1 of exhibit A's 5 Flash beat boundaries has a shot boundary within 0.5 s                                                                      | 70 %        |
| P3c | 0 boundaries on ≥ 90 % of her generated 4–8 s clips                                                                                              | 85 %        |
| P6  | a stitch of silent clips over a bed at Medium measures ≤ −20 LUFS before loudnorm, so loudnorm moves it by > 3 LU on 10/10 beds                  | 80 %        |
| P6b | the raw beds themselves sit more than 3 LU from −14 on ≤ 5 of 10                                                                                 | 55 %        |
| P6c | Bottom moves on 100 % of portrait captions (by geometry); ≥ 1 two-line fixture crosses the right 120 px                                          | 95 % / 65 % |

## Spend

| cell | what                                                                                                 | quote                   | cap   |
| ---- | ---------------------------------------------------------------------------------------------------- | ----------------------- | ----- |
| S-1  | 3 b-roll prompts × {today's template, dialect}, Seedance 2.0-fast, 4 s, 720x1280, same seed per pair | 6 × $0.3667 = **$2.20** | $2.40 |

Everything else is $0. Nothing runs without Adi's go.

## Rulings — ADI-QS-GO (2026-09-28)

- **Flags.** `STUDIO_CLIP_QC`, `STUDIO_SHOT_DETECT`, `STUDIO_PROMPT_REGISTRY` join the master table.
  `STUDIO_DIALECTS`, `STUDIO_OUTPUT_GATE`, `STUDIO_FINISHING` are OPT-IN: read through studioFlag's
  helper but not covered by the master — on only when set exactly `"true"`; a test pins that the master
  does not reach them. No `"false"` lines in the dev yaml (shipConfig.test.ts forbids them).
- **R1** yes — a JSON envelope in `body`, versioned (`studio-template/1`). Malformed, or missing a
  required placeholder (`{{direction}}` always; the preservation clause on "her" templates) → the TS
  literal, a warning log line, and a test per fallback reason.
- **R2** yes — key, version, hash, body frozen on the brief at the quote; the gate result on
  `creative_qa.gate` plus a log line; a stored clip's job never becomes `failed`.
- **R3** keep bed levels relative: normalize each bed to a reference loudness BEFORE its level gain,
  Quiet / Medium / Loud stay relative offsets, a true-peak limiter (−1 dBTP) on the final mix. No
  whole-mix loudnorm.
- **R4** a named constant for a bottom safe zone of 25 % (y ≤ 1440 on 1920), not 35 %; right 120 px and
  top 250 px kept; portrait only; Middle unchanged; Top moves as proposed. A compromise pending Adi's
  device check.
- **R5** yes — every stale transition comment, comment-only.
- **R6** yes — the dialect from the quote's model at the quote and the job row's model at the run,
  never the current env; a test that an env change between the two does not move it.
- **R7** go on both $0 reads, to a scratch dir outside the repo; nothing committed.
- **Dialect source**: read the official guide first; if it will not load, mark every step second-hand
  (ledger and code) and keep the emitter conservative.
- **Shot detection**: build the snap anyway; the ledger records how often it fires.
- **Overlap**: ignore `studio/video-publish-instagram`; keep the `plan.ts` edits contained.
- **Spend**: S-1 approved — 6 × $0.3667, cap $2.40, same seed per pair, blind sheet before the reveal.
- Hold before S-1 fires and before the full gate.

## Predictions amended before measurement (ADI-QS-GO R3 / R4)

P6 and P6b above were written for a whole-mix loudnorm, which R3 rules out. They are **superseded** —
kept, not deleted — by these, registered before any bed was measured. The reference is
`BED_REFERENCE_LUFS = −14`, so the Medium gain (0.25, −12.04 dB) puts a bed at about −26 LUFS.

| id   | prediction                                                                                                                    | confidence |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P6′  | the ten raw beds span more than 4 LU of integrated loudness between them                                                      | 65 %       |
| P6b′ | after normalization, a silent-clip stitch at Medium measures −26 ± 1 LUFS on 10/10 beds (spread ≤ 1.5 LU)                     | 75 %       |
| P6d  | Quiet / Medium / Loud stay 4.4 / 4.1 LU apart (± 0.5) on every bed — the offsets survive normalization                        | 85 %       |
| P6e  | the final mix's true peak is ≤ −1.0 dBTP (+0.1 measurement tolerance) on every fixture, including a clipped-hot one           | 80 %       |
| P6c′ | Bottom still moves on 100 % of portrait captions at a 25 % zone (band 1446–1702 against 1440 → y 1184); Top moves 110 px down | 95 %       |

Consequence recorded now, not discovered later: a timeline of silent clips at Medium lands about 12 LU
under Reels' −14, by construction of R3 — the walk will hear it.

## Build — 2026-09-28 (after ADI-QS-GO; held before S-1 and before the full gate)

Commits, in the order given: `a69c02b7` flags · `d9ce1d0e` R5 rider · `f7faa768` piece 1 · `81f2e3c9` S-1
script (NOT RUN) · `e25ac83e` piece 2 · `f5e1f7bb` piece 3 · `cc36c4a1` the rider's `config.ts` comment
back to three lines · `23c51b7a` piece 4 · `5916dc6c` piece 5 · `b0c83696` piece 6 · `5026b03e` prettier on
one new test file. Nothing pushed.

### What each piece is, in one line

1. **Target manifest + Seedance dialect** (`compile/targets/manifest.ts`, `video/seedance.ts`, opt-in
   `STUDIO_DIALECTS`). Six targets, every field sourced; an unverified accept counts as a refusal. The
   payload check refuses at the quote. The dialect follows the six steps (second-hand, marked in code),
   one camera move and a closing `Avoid:` clause, and is chosen from the quote's route and, at the run,
   from the job ROW's model (R6 — `videoRunner.dialect.test.ts` flips the env between quote and run).
2. **Clip structural check** (`video/structure.ts`, `STUDIO_CLIP_QC`, under the master). One ffprobe
   and one ffmpeg pass after every finished clip and stitch; `creative_qa.structure`; flag-or-pass plus
   a plain sentence on the chip.
3. **Shot detection** (`video/shots.ts`, `video/shotSnap.ts`, `STUDIO_SHOT_DETECT`, under the master).
   `select='gt(scene,0.3)',showinfo` on the bytes the clip read already has; `metadata.shots` beside
   `vision`; the caster's snap within 0.5 s; backfill `server/scripts/studioShotsBackfill.ts`.
4. **Prompt templates** (`templates/*`, `STUDIO_PROMPT_REGISTRY`, under the master). The three
   templates are built from named pieces. A published row is a `studio-template/1` envelope. The quote
   freezes key, version, hash and body onto `brief.job.template`, and both legs render the frozen body.
5. **Output gate** (`outputGate.ts`, `gateVocab.ts`, opt-in `STUDIO_OUTPUT_GATE`).
   `creative_qa.gate` plus one `output gate` log line per output, by template key. The job read and
   the generate answer carry `gate`. The thread card and `GenerationResult` show the failure, with a
   Try again that only asks for a fresh quote carrying closed reason codes.
6. **Finishing** (`video/finishing.ts`, `plan.ts`, `captionRender.ts`, opt-in `STUDIO_FINISHING`).
   Each bed is normalized over the window that plays, before its level; a true-peak limiter caps the
   mix; cuts snap to the beat; off-shape sources are cropped to fill on portrait; captions keep to the
   safe zones.

### Measurements against the registered predictions

| id   | registered                                          | measured                                                                                                                                                               | verdict                          |
| ---- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| P1   | dialect more shot-like on ≥ 2/3                     | —                                                                                                                                                                      | owed: S-1 not fired              |
| P1b  | 6/6 come back, $0.3667 each                         | dry run quotes $0.3667 × 6 = $2.2002                                                                                                                                   | owed: invoice                    |
| P1c  | 0 violations, reachable matrix                      | **0 of 67** compiled payloads (identity on Vertex, b-roll on Seedance-fast and 2.0, bridges on Kling; every served duration, with/without sound)                       | held                             |
| P1d  | dialect 60–110 words, no campaign                   | 68 / 73 / 78 / 100 words (plain, static, sound, all slots); the S-1 dialect prompts are 68 / 76 / 80, against 112 / 120 / 121 for today's template                     | held                             |
| P2   | black, frozen, wrong aspect fail; clean passes      | all four, on generated fixtures                                                                                                                                        | held                             |
| P3   | exhibit A: 0–2 boundaries                           | —                                                                                                                                                                      | owed: the SELECT needs the proxy |
| P3b  | ≤ 1 of 5 Flash boundaries within 0.5 s of a cut     | —                                                                                                                                                                      | owed: same                       |
| P3c  | 0 boundaries on ≥ 90 % of her generated clips       | —                                                                                                                                                                      | owed: backfill dry run (Adi's)   |
| P6′  | raw beds span > 4 LU                                | −15.5 … −8.4 LUFS: **7.1 LU**                                                                                                                                          | held                             |
| P6b′ | Medium −26 ± 1 on 10/10, spread ≤ 1.5 LU            | **as first built (whole-track measure): 1/10 in band, −31.1 … −26.6, spread 4.5 LU. MISSED.** After measuring the played window: 10/10 at −26.0 … −26.2, spread 0.2 LU | missed, then fixed (below)       |
| P6d  | Quiet/Medium/Loud 4.4 / 4.1 LU (± 0.5)              | 4.4–4.5 / 4.0–4.1 on 10/10, both builds                                                                                                                                | held                             |
| P6e  | true peak ≤ −1.0 dBTP (+0.1) incl. a hot fixture    | fixture: a +24 dB clipped sine at Loud comes out ≤ −0.9 dBTP; ten real beds: max −2.8 dBTP                                                                             | held                             |
| P6c′ | Bottom moves on 100 % of portrait; Top 110 px       | Bottom y 1446 → 1184 (lower edge 1440); Top 140 → 250; Middle unmoved                                                                                                  | held (by geometry)               |
| P6c  | ≥ 1 two-line caption crosses the right 120 px (off) | 7 of 8 cross x 960 with the zones off (right edge up to 1013); 0 of 8 with them on (max 952)                                                                           | held                             |

**The P6b′ miss, stated plainly.** The first build measured each bed's loudness over the WHOLE track, but
a stitch plays the track's opening, and intros run quieter than the average. Normalization still cut the
spread from 11.3 LU (unfinished, Medium: −32.6 … −21.3) to 4.5 LU, but that missed the prediction. The
fix was to measure from the bed's start for the programme's length, looped as the stitch loops it
(`finishing.ts measureLoudness(path, window)`). A test pins it ("the window that plays is what is
measured", mutation M6i).

**Found, not predicted.** Every one of the ten beds has a true peak ABOVE full scale as delivered
(+0.1 … +5.6 dBTP; `save.m4a` +5.6, `with-your-hands.m4a` +4.4). The masters carry intersample overs. At
Medium's −12 dB they sit well under the ceiling. At Loud, or after a positive normalization gain (e.g.
`tokyo-sunset` +6.6 dB), the limiter is what keeps them legal.

### Mutations, all red by name (kill-safe runner, `--selftest term|hard` passed)

M0 · M1a–M1e · M2a–M2g · M3a–M3d · M4a–M4d · M5a–M5l · M6a–M6i — **42**, each named in its test
file's header. No mutation stayed green, and none reddened only an unrelated name.

### Decisions made while building, for Adi to see

- **The reference count is not a payload violation.** Veo on Vertex is sent only the first reference;
  our adapter drops the rest, and the provider never refuses them. Refusing would have turned a silent
  drop that works today into a refusal under a flag meant only to change a prompt. The count is
  recorded in the manifest and not enforced.
- **Structure and the gate live outside `qa/`.** `stitchRunner.test.ts` forbids the stitch path from
  reaching `qa/`, even through a type import. The vocabulary is in `video/structureVocab.ts` and
  `gateVocab.ts`, and `qa/routes.ts` reads them.
- **`writeVerdict` keeps `structure` and `gate`** when it replaces the verdict (`KEPT_BESIDE_VERDICT`),
  so the write order cannot erase either. With neither present it writes exactly what it did.
- **The corrective goes through the existing preview door**, not a new requote route. `corrective` on
  `POST /studio/preview` is closed codes (a 400 on anything else), honoured only under the gate flag.
  The thread's Try again is its own Check again, carrying the codes; the workspace re-checks the last
  request she made. Either way the spend is her Generate tap on the new quote.
- **A clip's gate lands after `succeeded`**, so a gated job read says `{ pending: true }` for up to five
  minutes after completion. Watchers keep polling until it lands (`pollOutcome`). A runner that dies
  in between cannot leave a watcher polling forever.
- **Required placeholders beyond R1's two:** `{{references}}` on Nano (the likeness block) and
  `{{sound}}` on Seedance (a paid-for sound must be asked for). Veo 'her' gets sound appended after
  the template, as the literal does.
- **Seeds are the literal.** Version 1 of each template reproduces today's prompt exactly (proven
  byte-identical on eight briefs, and the SQL itself is run in PGlite). Publishing a seed exercises
  the pipe without changing a word.
- **The rider cost one extra commit.** The first `config.ts` rewrite grew a comment by a line, and
  `docs/studio/phrasebook.md` cites `config.ts:532` by number, so the phrasebook reddened. The comment
  is back to three lines and the phrasebook and every numeric cite are green, with the md untouched.

### Not done, or not wired — said rather than implied

- **Exhibit A (P3/P3b) is unmeasured**: the Cloud SQL proxy was down all session, and the scoped SELECT
  needs it. The ten beds were copied (R7) and measured.
- **The gate's UI covers two surfaces**: the Create Anything thread (live watches) and
  `GenerationResult`. It is not wired on MakeIt → StudioMade, the Board or the Video tab, and a thread
  card reloaded from history does not carry the gate (history reads `outputFromAsset`). With the gate
  on, those surfaces still present a failed output as done.
- **The Seedance guide is second-hand** (the official page would not load after three tries). Google's
  Veo reference also did not load, so every Vertex field resting on it is `verified: false` and treated
  as a refusal.
- **Only the preview door freezes a template.** Quotes from the Agent/Board doors (`concept.ts`,
  `edit/engine.ts`) carry no `job.template` and compile the literal.
- **Shot detection's threshold is 0.3**, chosen on generated cut fixtures (0.2, 0.3 and 0.4 all find
  the two cuts and nothing in a single take). How it compares with exhibit A's Flash beats is owed with
  P3.

### For Adi to run (none of it run here)

- **S-1** (the hold): `npx tsx --env-file=/Users/adi/nomila-v2/.env server/scripts/studioQualityS1.ts --run --cap 2.40`
- **Seed rows on dev**: `npx tsx server/scripts/studioTemplateSeedSql.ts` prints the SQL (default
  `draft`; `--status published` to publish).
- **Shots backfill** (dry run first):
  `npx tsx --env-file=/Users/adi/nomila-v2/.env server/scripts/studioShotsBackfill.ts --athlete <her id>`,
  then `--write`.
- **Exhibit A**: the same script with `--asset d076a790-…` (her row), once the proxy is up.

## Addendum — ADI-QS-3 (Create Anything prompt library, pieces 7–11) · Phase R, held for Adi's go

Scope change cited as **ADI-QS-3**. S-1 fired under it (below). Pieces 7–11 are recon only; nothing
built. **I have no message tagged ADI-QS-2** — the "gate UI commits" it names are waiting on its text.

### Where each Create Anything template lives today (311cfc78 + this branch)

| template                                 | where                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| image generate                           | `compile/image.ts:72` `buildPrompt`, generate arm: opening `:126`, reference manifest `:130`, AUDIENCE `:138`, TEXT AND NAMES `:157`, BRAND `:177`, style `:193`, GOAL `:293`, DIRECTION `:319`     |
| masked edit (a box she drew)             | same function, edit arm: opening `:125`, crop arm (`This image is a … crop`), DIRECTION `:313`                                                                                                      |
| native edit, every op                    | `compile/assemble.ts:185` `buildNativePrompt` → `:151` `compileNativeInstruction` = clause(s) + `:70` scope + `preservation.ts:52` + framing + `constraints.ts:70` keep; DO NOT `constraints.ts:77` |
| recolour / kit                           | `compile/templates.ts:249` RECOLOR · `:250` APPLY_DESIGN · `:251` REPLACE_OBJECT                                                                                                                    |
| product (add, or replace with her photo) | `templates.ts:279` ADD_OBJECT · `:251` REPLACE_OBJECT (photo arm); roles in `compile/manifest.ts:160` `referenceManifest`                                                                           |
| background · relight · camera            | `templates.ts:316` · `:338` (+ `assemble.ts:59` RELIGHT_SCOPE) · `:342` (+ `assemble.ts:66` CAMERA_SCOPE)                                                                                           |
| text                                     | `templates.ts:312` DISPLAY_TEXT — q6-t1's measured wording                                                                                                                                          |
| match a look                             | `templates.ts:326` GLOBAL_STYLE → `compile/style.ts:187` STYLE_LOOK_CLAUSE + `:163` `styleBlock`                                                                                                    |
| ad                                       | `interpret/ad.ts:194` `adTreatment` / `:300` `adPlan` freeze a multi-op intent (kit swaps, headline, background, BRAND_MARK `templates.ts:346`, exclusions) → `buildNativePrompt`                   |
| (crop)                                   | `templates.ts:334` — never sent to a model (`local/sharp-crop`); no template to register                                                                                                            |

### Google's guidance against the code, per rule (piece 7)

Sources: Google's Nano Banana Pro prompting post (blog.google, read 2026-09-28) and the Google Cloud
"Ultimate prompting guide for Nano Banana" (read the same day). Both loaded.

| rule                                | Google says                                                                                                  | code today                                                                                                                                                                                              | the dialect's change (flag on only)                                                                                                                                                                 | source                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1 one role per reference            | "Reference inputs: … clearly define the role of each" ("Use Image A for the character's pose…")              | `referenceManifest` labels every image; her photos are ONE likeness block (`manifest.ts:78`, the measured bound3 wording); a frame-only NATIVE edit gets no manifest (`assemble.ts:188`, refs > 1 only) | add one line on a frame-only native edit: "Image 1 — the photograph being edited." Keep the likeness block as is (it is one role for all her photos, and the wording is a measured identity result) | **verified**                                                                                                 |
| 2 what stays the same on every edit | "Be explicit about what to keep exactly the same."                                                           | every native edit carries the scope sentence + preservation; masked edits carry "every other pixel … must stay exactly as they are"                                                                     | **none** — already met                                                                                                                                                                              | **verified**                                                                                                 |
| 3 aspect ratio stated               | "Composition and aspect ratio: Define the canvas" ("A 9:16 vertical poster")                                 | set in config only (`imageConfig.aspectRatio`, `compile/aspect.ts`); never in the words                                                                                                                 | one sentence: generate "A 4:5 portrait image."; edit "Keep the photograph's 2:3 portrait shape."                                                                                                    | **verified**                                                                                                 |
| 4 quoted text, named font           | "Use quotes" · "Choose a font: … name of the font"                                                           | DISPLAY_TEXT: words unquoted (fenced when hers), "in bold white capital letters" — a style, no font                                                                                                     | quote the words inside the fence and name one font — proposed **Outfit ExtraBold** (the captions' own face): `… reads "GAME DAY" in Outfit ExtraBold, white, all capitals`                          | **verified** (the font choice is ours)                                                                       |
| 5 no social-UI cues, no real names  | **absent from both pages** — and the Cloud guide says "Use positive framing", which argues against negations | generate: both lines (`image.ts:126`, `:157`); her name never in any prompt; edits: neither line                                                                                                        | edits gain one line: "Add no person's name, username or handle, and no app or social-media interface." (never against a banner or brand mark she asked for)                                         | **second-hand / our own**: generate-defects.md is first-hand for GENERATES; for edits it is an extrapolation |

### The registry, every template (piece 8)

- **Keys.** `studio.image.generate` (live) · `studio.image.edit.masked` · `studio.image.edit.<op>` for
  recolor, apply_design, replace_object, add_object, remove_object, move_object, display_text,
  change_background, global_style, relight, camera, brand_mark · `studio.image.edit.compound` (two or more
  ops) · `studio.image.edit.ad` (the ad treatment's intent). This covers Adi's list: recolour · kit
  (apply_design / replace_object) · product (add / replace with her photo) · background · relight ·
  camera · text · match a look (global_style) · ad.
- **Placeholders (native).** `{{references}} {{clause}} {{scope}} {{preservation}} {{framing}} {{keep}}
{{style}} {{donts}}`, plus the dialect's `{{aspect}} {{names}}`. **Required:** `{{clause}}`,
  `{{scope}}` (rule 2), `{{references}}`, and `{{donts}}` (the brand's DO NOTs and the ad's exclusions are
  compliance). Masked: `{{opening}} {{references}} {{crop}} {{goal}} {{direction}}`, with `{{crop}}` and
  `{{direction}}` required.
- **The clause stays a code piece.** Its wording carries the fence around her words and the "Image N"
  numbering, so a row arranges it and cannot reword it. A clause-level template would need that fence
  moved into the renderer — a separate decision.
- **Seeds.** Version 1 of every key reproduces today's prompt; the proof is all 134 image goldens
  rendered through the resolver and its seed, plus the 12 video and 6 dialect goldens.

### The resolver's inputs (piece 9)

Rules only, no embeddings:

- the operation(s) — the frozen native intent's ops, masked when the regions were drawn, or generate
- the ad treatment (`brief.job.interpretation` from `adPlan`)
- the reference roles attached (person / product / object / style)
- brand present (`brief.brand`)
- style spec present (`styleSpecOf`)

It returns candidates, most specific first — `…+style`, `…+brand`, `…+product`, `…+her`, then the base
key. The first one published wins; today no variant exists, so it is the base key, which is today's
prompt. Recorded on `brief.job.template` (key, version, hash, source) together with the inputs it
resolved from.

### Scoring hook points (piece 10)

- Images: `generate.ts`, right after `inspectAsset` and `recordGate`. Clips: `videoRunner.ts`, after
  `recordGate`.
- Signals: `creative_qa.checks.text.status` (both); `creative_qa.checks.adherence.status` (EDITS only —
  the generate path runs no adherence judge); `creative_qa.gate.reasons`.
- Output: one `template score` log line per output — key, version, source, text / adherence / gate, each
  pass or fail — so counts per key and version come from a log query, with no table.
- **"Plus the frozen brief" needs a ruling.** The brief is frozen at the quote; a score exists only after
  the run, and R2 put the gate's outcome on the ASSET for that reason. Proposed: `creative_qa.score` on the
  asset, plus the log line. If it must be on the job, the least bad place is a top-level `scores` key on
  `generation_jobs.brief`, outside `job.*` — Adi's call.

### S-2 (on Adi's go only)

8 blind pairs = 16 Gemini 3 Pro Image generations. The price table quotes **$3.0174**, as follows:

| arm cell                       | quote   |
| ------------------------------ | ------- |
| generate, no refs              | $0.1344 |
| generate, her pack (3)         | $0.2273 |
| generate, pack + product       | $0.2582 |
| generate, brand + 1 ref        | $0.1654 |
| edit, recolour (frame only)    | $0.1654 |
| edit, her object added         | $0.1963 |
| edit, text banner              | $0.1654 |
| edit, match a look (style ref) | $0.1963 |

That is $1.5087 per arm. A Pro figure is a floor (reasoning tokens bill on top), so the proposed cap is
**$4.50** under the $5 ceiling. Inputs are her own photos, chosen by eye with the proxy up; the same
inputs go to both arms of a pair. There is **no seed** on this target (the manifest has it unverified),
so each pair also differs by chance — n = 8 is a first read.

### Predictions — registered 2026-09-28, before any of 7–11 is built

| id  | prediction                                                                                                                            | confidence |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P7a | flag off, all 134 image goldens are byte-identical                                                                                    | 97 %       |
| P7b | flag on: rule 3 changes 100 % of image prompts; rule 4 only the DISPLAY_TEXT / headline fixtures; rule 1 only frame-only native edits | 85 %       |
| P7c | S-2: the dialect wins ≥ 5 of 8 blind pairs                                                                                            | 30 %       |
| P7d | S-2: the text pair goes to the dialect                                                                                                | 65 %       |
| P7e | S-2: ≥ 3 of 8 pairs judged "same"                                                                                                     | 55 %       |
| P8  | the seed SQL, rendered, reproduces 100 % of the goldens (134 image + 12 video + 6 dialect)                                            | 95 %       |
| P9  | the resolver picks today's template on every existing fixture                                                                         | 95 %       |
| P10 | under the flag, every image output emits exactly one score line carrying key and version                                              | 90 %       |

### Rulings asked for at this hold

1. The text of **ADI-QS-2**.
2. Scoring's home: the asset plus the log (proposed), or a `scores` key on the job's brief.
3. Rule 5 on edits (second-hand), and Outfit ExtraBold as the named font.
4. The clause stays a code piece (proposed), or the fence moves into the renderer so a row can reword a
   clause.
5. S-2's go: cap $4.50, and the proxy on for picking her photos.

## Rulings — ADI-QS-2 (re-sent) and ADI-QS-5 (2026-09-28)

- **ADI-QS-2**: the reference count is not a violation (card below: Veo on Vertex); the re-quote through the preview
  door with closed codes; pending plus client polling ≤ 5 min; `{{references}}`/`{{sound}}` required; the rider
  fix-up. **Gate UI on the Board and on thread cards reloaded from history, in this PR**; MakeIt/StudioMade and the
  Video tab carded; STUDIO_OUTPUT_GATE stays opt-in until every surface shows it. Seedance and Veo sources stay
  second-hand; **S-1's blind result is the first real evidence on the dialect.**
- **ADI-QS-5**: (2) scores on the asset + the log line, the frozen brief untouched, key and version on the line.
  (3) rule 5 on text-bearing edits only, positive, ours; the font a template FIELD with a widely known bold sans as its
  default; Outfit stays for captions. (4) the clause stays code — a row positions it, never rewords it. (5) S-2 go, cap
  $4.50; no seed, so pairs also differ by chance.

## Build 7–10, S-1, S-2, the gate UI — 2026-09-28 (held before the full gate)

| commit     | what                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `5edc7cd8` | piece 7 — the Gemini 3 Pro Image dialect (STUDIO_DIALECTS, opt-in)                                        |
| `850a8dde` | piece 5 fix — a native edit's prompt closes with the re-quote's fix (it did not; found building 8)        |
| `08179170` | piece 8 — every Create Anything template in the registry; the renderer tidies the template, not her words |
| `4f8b629a` | piece 9 — the rules-only resolver, its variants, the inputs frozen beside the key                         |
| `cb022bb4` | piece 10 — a template's score per output (STUDIO_PROMPT_REGISTRY)                                         |
| `df44ab45` | S-2's script (run: $3.9860 counted at quote)                                                              |
| `0df10365` | gate UI — history cards and the Board                                                                     |

### S-1 — the first real evidence on the Seedance dialect (the dialect's source is still second-hand)

Ran on ADI-QS-GO's go: **6 of 6 stored**, each 720x1280, 4.04 s; **$2.2000 reported against $2.2002 quoted**. Sealed
key sha256 `d0eee9839bca59750b5b4f1bf8af483a48ca9d40716d7e065d79855d46456eda`. The blind sheet is
`probe-out/quality-s1/sheet.html`, with `scores.csv` beside it for Adi. **No reveal until his scores are in.**

### S-2 — eight blind pairs on Gemini 3 Pro Image (ADI-QS-5 (5))

**Inputs** (her row, `3811cedd`, read only, chosen by eye — the maroon-kit woman's photos,
athlete-library-is-several-women):

- the pack: `5581e882`, `d47dad12`, `b2d6edcd` — the last is EXIF-8, straightened by `personReference`
- the frame for every edit: `d47dad12`, no EXIF flag, 24 MP
- a product: `e64e900a`, a soccer ball with its maker's mark
- an object: `9677d97e`, gold hoops
- a style reference: `2e0593c6`, a warm, grainy film photograph of a pitch at dusk (already read)
- a brand: adidas, `#52`

**Deviations, each recorded:**

- **p5's region** is hand-placed on the jacket. It stands in for the box the route's detection would derive, which is
  a Flash call this run did not make. A native prompt never reads a region.
- **The edits** are frozen by the rules (compile/golden.test.ts `said`), under the master as dev runs it.
- **The quote is $3.9860, not $3.0174.** Her frames are 24 MP, so each edit is the 4K tier at $0.2710, and the brand
  cell carries the brand's own imagery.

| result                  | figure                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| stored                  | **15 of 16**                                                                                                  |
| refused                 | **p4** (brand + one photo): one arm came back `IMAGE_SAFETY`, no image. The pair is void; which arm is sealed |
| spend, counted at quote | **$3.9860** of the $4.50 cap                                                                                  |
| Vertex's own estimates  | $2.8608 — the router's Vertex figure leaves out reference input tokens, which the quote includes              |
| key                     | sealed, sha256 `fc28f64f04a334d0f2e4e7943d3f1ae2bd31418e8d10587cb6beb58c0c5ac7cb`                             |
| sheet                   | `probe-out/quality-s2/sheet.html` — p4 has no B                                                               |

Whether a safety-refused call bills is not known from here. **There is no seed on this model, so every pair also
differs by chance.** P7c–P7e wait on Adi's scores.

### Piece 7 — the Gemini 3 Pro Image dialect

| rule                                                 | change (flag on only)                                                                                                            | source           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1 one role per reference                             | a frame-only native edit gains `Image 1 — the photograph being edited.` (every other call already names each image)              | Google, verified |
| 2 what stays the same                                | none — already met                                                                                                               | Google, verified |
| 3 the canvas in the words                            | generate `A 4:5 portrait image.`; edit `Keep the photograph's 2:3 portrait shape.`; masked `Keep this image's 1:1 square shape.` | Google, verified |
| 4 quoted text, a named face                          | `reads "GAME DAY" in white capital letters, set in Helvetica Bold` — the face is `meta.font`, defaulted                          | Google, verified |
| 5 the exact text, positive (text-bearing edits only) | `Any text added to the image is exactly: "GAME DAY".` — an ad: `…, plus the nike logo.`                                          | **ours**         |

- **The face: Helvetica Bold.** It's the most widely used sans-serif there is, so the model has seen it rendered more
  than any other, and it's bold. It's also neutral: Impact reads as a meme, and Futura Condensed ExtraBold as Nike's
  own. Outfit stays with the captions, where our code draws it.
- **⚠️ One word differs from ADI-QS-5's phrasing: "added".** The ruling said "Any text in the image is exactly". But
  a photograph she edits can already carry lettering (her kit, a sign) that the scope sentence promises to keep, and
  "in the image" would order the model to strip it. It's one word to revert if Adi prefers his.
- An ad with no headline carries no line: its logo is a mark, not words she wrote.
- **Which model**: chosen from the model the image call routes to (`routedModel`, the same one capsFor reads and the job
  row records), its OpenRouter id included. A crop is cut in-process and never written in it.

| prediction | measured                                                                                                                                                                                                                                                                                                 | verdict                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| P7a        | 134 of 134 goldens byte-identical, with the flag unset and set to "false"                                                                                                                                                                                                                                | **held**                                                         |
| P7b        | 122 cells go to the model. Rule 3 changes **121 of 122**: the edit on an unmeasured frame pins no canvas, and says nothing rather than guess. Rule 1 changes exactly the 91 frame-only native edits; rule 4 exactly the 9 headline cells. Taking the dialect's words out gives back every golden exactly | **rule 3's "100 %" missed by that one cell; rules 1 and 4 held** |

Mutations M7a–M7f, red by name.

### Piece 5 fix — a native edit dropped the corrective (M5m)

`buildNativePrompt` never appended `correctiveBlock`. On the most common edit path, "Check the cost to try again"
re-ran the prompt that had just failed. It now closes with the fix, as the image and clip prompts do.

### Piece 8 — every Create Anything template in the registry

- **Keys**: `studio.image.generate` · `…edit.masked` · `…edit.<op>` for the twelve operations sent to a model ·
  `…edit.compound` · `…edit.ad`. A crop has none.
- **Native placeholders**: `{{references}} {{clause}} {{text}} {{scope}} {{preservation}} {{framing}} {{keep}} {{aspect}}
{{style}} {{donts}}`. Required: references, clause, scope, aspect, donts, plus text on the headline, compound and
  ad keys.
- **Masked**: `{{opening}}` (its keep) and `{{edit}}` (the region block) are required.
- **The clause stays code.** The headline's face is `meta.font`.
- **The renderer tidies the TEMPLATE before her words go in.** Piece 4 tidied after, so a direction with three newlines
  or a trailing space rendered differently from the literal: a latent defect of mine, fixed here (M8b).
- **P8 held.** All 122 model-bound image cells render from their seeds byte-identical: to the golden with the dialect
  off, to the dialect's literal with it on. Each is proven through a marked copy, so a silent fall-back could not
  pass. On video: the 4 "her" cells and the 6 Seedance cells. The other 8 video templates have no registry key.
- **The generate seed is now version 2** (it gains `{{aspect}}`). If piece 4's SQL was already run on dev, version 1
  falls back with a `missing_placeholder` warning. The published SQL archives only an older row it wrote itself
  (`created_by = 'quality-scrappy seed'`); a row anyone else published stops the transaction instead.
- M8a–M8e, red by name.

### Piece 9 — the resolver

- **Candidates**, most specific first: `+style`, `+brand`, `+product`, `+her`, then the base. Each applies only where
  its condition holds, and the first one published wins.
- **A variant renders under its base's placeholders**, so it can drop nothing the base keeps.
- **What it read** (operations, the ad treatment, reference roles, brand, style spec) is frozen on `brief.job.template`
  beside the key.
- **P9 held.** With only the seeds published, it picks every cell's base key. Pinned per key: generate 7, masked 2,
  recolor 13, apply_design 1, replace_object 10, add_object 22, remove_object 3, move_object 5, change_background 2,
  global_style 21, display_text 4, relight 1, camera 1, brand_mark 1, compound 29.
- The ad key has no golden cell (no fixture carries the interpreter's treatment); `templates/resolve.test.ts` pins it.
- M9a–M9e, red by name.

### Piece 10 — a template's score

- **What it writes**: `creative_qa.score` on the asset, plus one `template score` log line carrying key, version and
  source.
- **The signals**: text; adherence on edits only ("n/a" on a generate and a clip); the gate.
- **The values**: each is pass, flag, fail or **unmeasured**, and a check that did not run never counts as a pass.
- **Behind STUDIO_PROMPT_REGISTRY.** That is my choice: it measures what the registry serves, and it is observation
  only.
- **P10 held.** A real generate scores each stored image once; the unit test counts one line per output. The clip
  harness's stored brief is bare, so its score and gate name no key: they are asserted equal, and a real key is proven
  on images.
- M10a–M10e, red by name.

### The gate UI (ADI-QS-2)

- **History**: `readSession` carries each output's gate (the job route's `gateWire`, opt-in flag, outputs only), and a
  reloaded card shows a failed output as failed. Try again was already wired through `checkAgainJob`.
- **The Board**: its shot and bridge entries opt in to the notice (`VideoEntry`'s `gate` prop). "Check the cost to try
  again" re-prices the row with the gate's codes on the failed piece (`withRowFix`), and the row's own button spends on
  her tap.
- **Not built**: the Video tab (VideoEntry without the prop), MakeIt/StudioMade, and the stitch result — see the cards.
- **A gap**: a history reload inside the 5-minute pending window shows the output as done, because history is not
  polled.
- MG1–MG4, red by name.

### Exhibit A (P3, P3b) — measured at $0 (R7: her row, a scoped read, the clip to scratch)

- **Detection**: 0 boundaries at 0.3, 0.2 and 0.15. The highest scene score in the clip is 0.147.
- **By eye**: a one-frame-per-second strip shows one handheld take. The camera follows her from tying her boots,
  through a whip-pan past sky, goal and fence, to playing far off and then at the goal.
- **P3 held** (0 boundaries). **P3b held** (0 of Flash's 5 beat edges near a cut).
- **P3c** is still Adi's (the backfill's dry run).
- ⚠️ I briefly read a contact sheet as proof of cuts. A glob had sorted `f_10.0` before `f_9.0`; in true order, the
  frames were continuous.

### Merge forecast — main moved (`311cfc78` → `955febe7`)

`git merge-tree`: **four conflicts**, `brief.ts`, `config.ts`, `studioFlag.ts`, `studioFlag.test.ts`.

- **They are all additive.** Main added creative-intent provenance to the brief, and a governance flag helper.
- **The one real decision**: main's `studioGovernanceFlag` is exactly this branch's `studioOptIn` (exactly "true", the
  master never reaches it). Unify them, or keep both. Adi's call. Nothing is merged or rebased here.

## Cards

1. **Veo on Vertex gets only the FIRST reference.** The adapter drops the rest silently (ADI-QS-2). Fix or disclose
   before any multi-reference Veo work.
2. **The gate UI on the Video tab, MakeIt/StudioMade and the stitch result.** The stitch path records no gate at all.
   STUDIO_OUTPUT_GATE stays opt-in until every surface shows it.
3. **Investigation 12's fix** (below): pending Adi's go.

## Investigation 12 (ADI-QS-4) — "can't be used" before any preview · read-only, $0 · held

**Where the words are.** "It's in your library, but it can't be used here." is the client's only such copy:
`mediaPickerLogic.ts uploadOutcome`, on `StudioMediaPicker`'s upload-in-place path. That picker is mounted by the
Board, the Agent tab, Brand post, Carousel and the Video tab. **Create Anything's Style tile never mounts it.** Its tile
(`AttachSheet` → `StyleReferenceList`) lists only references already read, from `/me/studio/style-references`, with no
upload.

**Hypothesis A** (the Style slot runs the likeness gate) is **false at both layers**:

- The client's pre-send ask (`frameChoiceNeeded`) counts only `source-frame` photos.
- The server's door (`routes/studio.ts resolveReferences`) resolves a `style_reference` and moves on BEFORE its likeness
  gate.

**Hypothesis B** (unread images are refused) is **true in substance, by a different mechanism**. `uploadOutcome` looks
for the new upload on the list's FIRST PAGE only (24 rows). Under STUDIO_LIBRARY_FIELDS that list is ranked, and an
unread photo ranks −1, below every read one. Measured on her row: **346 photos outrank a fresh upload**. Every photo she
uploads from inside a picker is therefore refused, and a READ one is too, unless it ranks in the top 24.

| repro                                   | outcome                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1. a camera-roll image, never read      | refused, as above                                                                                            |
| 2. a Brand-posts reference              | origin `reference` is on no picker mount. It is never listed by a picker; the Style list offers it once read |
| 3. an Instagram screenshot              | an upload, so repro 1                                                                                        |
| 4. Style + her photo, "match this look" | no refusal: a GLOBAL_STYLE edit driven by the reading, with no style pixels sent. S-2's p8 ran exactly this  |
| 5. a plain photo of her as Style        | not offered (the Style list is read references only), so no message                                          |

**What I cannot confirm.** That the symptom came from main's code on the Style tile, which cannot produce it. Which
surface, and which build, was Adi on?

**Proposed fix (not built, $0):**

- `GET /me/studio/media?ids=<uuid>`, answering under the mount's own filters (kind, origins, still), her athlete only.
- `uploadOutcome` checks the uploaded id there, not on page 1.
- Files: `server/studio/mediaList.ts` (+ the route's parse), `client/hooks/use-studio-media.ts`,
  `client/components/studio/StudioMediaPicker.tsx`, `client/screens/studio/mediaPickerLogic.ts`, and tests.

**On ADI-QS-4's proposed fix.** "The Style slot never applies the likeness gate" is already true. "An unread style
image read on the spot" would be a NEW capability (the Style tile gaining an upload); nothing in this symptom needs it.
That is a separate decision.

## S-1 and S-2 revealed — the first real evidence on both dialects (2026-09-28)

**How it was scored.** Adi scored both sheets blind: "1st/2nd" is each pair as shown, which the sheets draw A then B.
The picks are written into both `scores.csv` files. Each sealed key hashed to its recorded sha256 before it was read
(`d0eee983…`, `fc28f64f…`). p4's mapping stays sealed: its missing image was re-run (below), and Adi scores that pair
blind, separately.

### S-1 — Seedance 2.0-fast b-roll, the same seed within each pair (the dialect's source is still second-hand)

| pair                          | pick         | arm picked              |
| ----------------------------- | ------------ | ----------------------- |
| p1 stadium at dusk            | B            | today's shared template |
| p2 track at dawn              | A            | **the dialect**         |
| p3 locker room, close/push-in | tie, leans A | leans today's           |

**Tally:** dialect 1 · today 1 · ties 0 · ties leaning today 1 · leaning the dialect 0.

**P1 — the dialect picked on ≥ 2 of 3: MISSED** (1 of 3).

### S-2 — Gemini 3 Pro Image, no seed (every pair also differs by chance)

| pair                           | pick                                   | arm picked      |
| ------------------------------ | -------------------------------------- | --------------- |
| p1 generate, nothing attached  | A                                      | today's         |
| p2 generate, her pack          | A                                      | today's         |
| p3 generate, pack + product    | A                                      | **the dialect** |
| p4 generate, brand + one photo | void; re-run filled; scored separately | sealed          |
| p5 edit, recolour              | tie                                    | —               |
| p6 edit, her object added      | A                                      | **the dialect** |
| p7 edit, a headline            | tie, leans A                           | leans today's   |
| p8 edit, match a look          | tie ("both good")                      | —               |

**Tally (7 scoreable):** dialect 2 · today 2 · ties 2 · ties leaning today 1 · leaning the dialect 0 · void 1.

| prediction                              | verdict                                                             |
| --------------------------------------- | ------------------------------------------------------------------- |
| P7c — the dialect wins ≥ 5 of 8         | **MISSED** — 2 of 7, and at most 3 of 8 whatever p4 turns out to be |
| P7d — the text pair goes to the dialect | **MISSED** — a tie, leaning today's                                 |
| P7e — ≥ 3 of 8 judged "same"            | **held** — 3 (p5, p7, p8)                                           |

### What this is evidence of, and what it is not

- **No evidence that either dialect makes a better picture.** At these n (3 and 7), with S-2 unseeded, the reads fit
  "no effect". Nothing says either dialect is worse, either.
- **S-2 split by kind:**
  - Today's prompt won both plain generates (p1, p2).
  - The dialect won the two reference-heavy cells (p3 pack + product, p6 her object).
  - Every other edit tied.
  - That pattern is **n = 1 per kind**, and is noted as nothing more.
- **Rule 4 and rule 5 (the quoted, named face and the exact-text line) did not win the text pair.** Both wordings
  rendered well enough to tie.
- **Both dialects stay opt-in** (STUDIO_DIALECTS, which the master never reaches). Nothing here argues for turning them
  on.

### p4's re-run (Adi's approval: one call, cap $0.26)

- **Why it was re-run**: the missing letter (B) was filled from the SAME prompt, checked byte for byte against the
  run's own before spending (`--rerun p4`, which never prints the arm).
- **Outcome**: stored. **The first try's `IMAGE_SAFETY` refusal was chance, not the prompt.**
- **Cost**: $0.2582 counted at quote; Vertex's own estimate $0.1344.
- **S-2 in total**: **$4.2442** counted, inside the original $4.50 cap.

## The full gate — 2026-09-28

**Run 1 (at `f248bc89`): 3 red of 12,343 tests.** The log's tail says `exit 1`, and the runner's notification said 0;
the verdict below is from every batch summary, never the code.

1. `routes/studioSessions.test.ts` "no spend surface" (**mine**): the gate UI's `sessions.ts → outputGate.ts → brief.ts`
   chain reached compile/, the router and the adapters.
2. `agent/eval/census/rows.test.ts` "no census row is unverdicted" (**mine**): the four fields this branch added had no
   verdict.
3. `affiliationSync.test.ts` "a year-only from/to" (**not mine**): red in isolation here twice, and red on main's own
   checkout at `311cfc78`. This branch touches nothing under `server/services/intelligence/`. The house flake, out of
   lane, left alone.

**The fixes (`5352fe38`):**

- The gate's record and wire move into `gateVocab.ts`, which has no database and no brief; `outputGate.ts`
  re-exports them.
- The census gets four DECIDES verdicts, each held by its cited reader.

**Run 2 (at `5352fe38`): GREEN.** 80 batch summaries read: **586 of 586 suites, 12,343 of 12,343 tests, 0 skipped**.

| other gates                 | result                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `check:types`               | exit 0                                                                                              |
| `tsc -p tsconfig.jest.json` | exit 0                                                                                              |
| `lint`                      | 81 errors repo-wide, **0 in any file this branch touches** (37 files, all outside the diff)         |
| format vs base              | 50 new files and 37 clean-on-base files all pass; the 7 already unformatted on base were left alone |

## ADI-QS-10 (2026-09-28) — p4 scored; the wording kept; the next steps

- **p4: tie.** The blind is closed; the key hashed to `fc28f64f…` when read. p4 was A = today, **B = the dialect**.
  The arm Vertex refused (`IMAGE_SAFETY`) on the first try was the DIALECT'S; its re-run with the identical prompt
  stored. That is one refusal and one success on one prompt: chance at n = 1, and recorded as nothing more.
- **S-2, final over 8 pairs:** dialect 2 (p3, p6) · today 2 (p1, p2) · ties 3 (p4, p5, p8) · a tie leaning today 1 (p7).
  - P7c (≥ 5 of 8): **missed** (2).
  - P7d (the text pair): **missed** (a tie leaning today).
  - P7e (≥ 3 same): **held** (4).
- **Rule 5's wording** — "Any text **added** to the image is exactly: …" — **kept** (Adi).
- **The flags unify onto main's `studioGovernanceFlag`**; `studioOptIn` goes.
- **Investigation 12's by-id fix is built HERE.**
- **Then**: merge main, run the full gate, and hold for Adi's merge.
