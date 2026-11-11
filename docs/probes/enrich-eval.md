# Enrichment quality eval — ledger

Branch `studio/enrich-eval` off main 213552c (C2 #557 and enrich-51s-bug #559 both merged in).
Test athlete `3811cedd`. Probes live under gitignored `probe-out/enrich-eval/` (`run.sh` runs all
four; every one is read-only; `part0` makes two embedText calls, the rest are $0). Measured
22 Sep 2026. No fix is built until the blind sheet reads out.

## Part 0 — why the 51 s upload was missing from two live libraries

**Mechanism: the dev server was on a build that predates the doctrine PR (#558).** Not a row-shape
problem, not the enrichment record, not the embedding.

Evidence, in order:

1. **Row shape.** `d076a790` diffed field by field against the two camera clips that were selected
   (`e055746a`, `64c9bf0d`): every column and every key the predicate or the offer reads is the
   same — `status` stored, `content_type` video/mp4, `gcs_path` set, `vision` an object with all 18
   keys, `athlete_present` a boolean `true`, `beats` an array (6 / 3 / 1), `enrichment` **null on all
   three** (the clip write drops that key on every success — videoEnrichment.ts `writeVision`, not a
   rerun quirk), `embedding` 1408-dim on all three. The only differences: `duration_seconds_precise`
   51.48 vs null, `original_gcs_path` present (it was transcoded, the other two were not), newer
   `ingested_at`. Assembly reads none of those. The brief's hypothesis — that the rerun's null
   enrichment record or embedding recency excludes it — is **falsified**: assembly never reads
   `metadata.enrichment`, and all three uploads have the same enrichment/embedding state.
2. **On main, it is offered.** `assembleLibrary(3811cedd, "recap using my real footage")` on 213552c
   returns 18 lines with `d076a790` at **a11 — the first clip slot**, camera, 6 beats, 51.5 s,
   shot=action. `listClips` ranks it `rn=1`.
3. **Timing is ruled out.** `/tmp/enrich-dev.log` shows the server started 07:21:53 local and the
   three `agent plan cast` lines at 07:22:56 / 07:27:03 / 07:30:07 local (14:22–14:30Z), each
   `library: 18`. The beats landed at 13:51:12Z. The row was in its current state for all three.
4. **The old build's assembly.** The log is the enrich-51s-bug worktree's (tip 4206da0). That commit
   does not contain `f751fcd` (stitched refused at the offer), `3343378` (stitched refused in
   listClips), `ab8f078` (camera-first order) or `88c2f52` (library.ts). On it, `searchMedia`'s
   top-24 for this brief is **21 stitched compilations + 3 photos** (section D of `out-part0.txt`),
   `offer()` accepts a compilation, and the 8-slot clip room is full **before `listClips` runs**.
   `d076a790` is refused at `left <= 0`. So are `e055746a` and `64c9bf0d` — the "cleats-tying" and
   "studio foot-on-ball" clips the plan cast were stitched compilations _of_ those camera clips
   (`01b7b9eb`: "transitions from sitting on a sunny field … to standing in a black Stanford
   uniform"), exactly the trust problem f751fcd's message describes. The library count is 18 on both
   builds by coincidence: 3 her + 7 scenes + 8 clips either way.

**Prediction (Adi to run):** restart the server on 213552c and send the same brief. The library
holds `d076a790` at a11; the plan casts it (its 6 beats are the only action beats in the room).
If the server was in fact on 213552c when the three plans ran, this report is wrong and the next
step is to log the library's ids on the `agent plan cast` line.

**The decision posed (normalize rerun writes vs. tolerant assembly) is moot** — neither path is the
cause. Recorded so it is not re-litigated.

**Prediction CONFIRMED (Adi, 22 Sep 2026):** on 213552c the same brief offered and cast d076a790 —
six items, items 1–4 its beats [0]–[3], then a held BOLYN photo and a studio-clip sign-off,
doctrine-correct, $0, gaps 0. **And it exposed the next bug down:** `plan derived items: 6` →
`agent plan cast items: 6, cast: 3, dropped: 3`. Beat [0] cast; beats [1]–[3] came back
"Couldn't use that clip here."

### The cast-lane bug: a clip's later beats were refused as a reuse

_Finding #0 first:_ the caster logged no per-item reason — the route's line carried counts only.
Commit `adb13b7` adds `leftOut` to the cast result (index, kind, ref, segment, and a two-half
reason: why the named ref was not reserved, then where the fallback stopped) and logs it on
"agent plan cast". With it, the three dropped items each read
`ref_already_used(a11 by item 0); no_pick_fits; clip_never_searched`.

_Mechanism:_ `castPlan`'s pass 1 reserves each item's named row and marks it `used` by **asset id**.
The rule was written for photographs ("a board of the same photograph twice is not a plan"). A clip
item names a ref _and a beat_; items 2–4 named the same ref with segments 1–3, found the id already
in `used`, were not reserved, had no pick to swap to, and a clip is never searched for — so each
fell to `UNCAST_CLIP_LINE`. Not a per-asset cap by design, not beat-index resolution, not a trim
check: the reuse key was too coarse. The plan eval already disagreed with the caster —
`eval/metrics.ts` `refsReused` keys on `ref#segment` with the comment "two windows of one file, not
a reuse" — and an existing test ("a swapped clip goes in whole") had encoded the caster's behaviour
with two _different_ beats.

_Fix (commit `c2c680f`):_ `used` is keyed on the **cut** — `id#segment` for a beat, `id#whole` for a
whole clip or a photograph. Two beats of one clip both cast; the same beat twice is still refused;
the whole clip and any of its beats block each other. Picks, products and search hits stay whole.
The reasons line names the item that holds the blocking cut (`ref_already_used(a1#1 by item 1)`).

_Predictions:_ (1) the acceptance brief casts 6/6 — items 1–4 on d076a790 with trims 0–9.5,
9.5–14.5, 14.5–20.5, 20.5–30.5; (2) "a swapped clip goes in whole" reds under the fix as written
(it asserted two different beats are a reuse) — rewritten to the same beat twice; (3) the mutation
"key `used` on the id alone" reds exactly "casts each beat of one clip to that clip …" and nothing
else — **measured: 1 failed / 37 passed, that test by name**; (4) no photo behaviour changes:
"casts a photo named twice only once" stays green — measured green. Scoped suites 61/61.

_Gate on the tip (c2c680f), `npm test` bare, read from the per-batch summaries:_ **418 suites /
8130 tests / 1 failed** — `affiliationSync.test.ts` "a year-only from/to (registry v2 allows
YYYY)", the house flake. Isolated reruns: 4 red / 5 runs, on a `server/services` tree byte-identical
to origin/main (my diff is three files under `studio/agent` and `routes`). Both tsconfigs clean.
Formatting: the two agent files were clean on main and are formatted; `routes/studio.ts` was dirty
on main and is left as found. **Acceptance on device (Adi, 08:10):** `cast: 5, dropped: 0,
leftOut: []`, items 1–4 on d076a790 with trims 0–9.5 / 9.5–14.5 / 20.5–30.5 / 30.5–42.5; the Board
seeded the rows with their windows and sound flags.

_Cards raised, not built:_ (a) per-beat thumbnails — every beat row shows the clip's poster (frame
0), a frame at each trim's start needs the poster worker's ffmpeg at an offset; (b) play a clip row
on the Board within its window — the row carries no video URL and renders a static `Image`;
`ClipPlayer` (Video tab) already seeks and stops at an out-point, so the card is a signed `videoUrl`
on the cast item + row and a tap-to-play with in/out from `clipTrim`. Separate PRs, one card each.

### Found on the way: the "photos of her" room is starved on main

Same run: 16 slots for photos of her, **3 filled** — because `searchMedia` is asked for k=24 with no
media-type filter, 21 of the 24 come back as stitched compilations, and the offer refuses them
_after_ the k was spent. The 3 that survive are basketball photos (a1–a3) on a soccer brief. This is
live on main, is one root of the cross-sport leak in Part 3, and is the mechanism behind the stills
starvation the doctrine baseline measured (camera clips cast 88%, stills under-used — the planner
was never shown them). Carded here; not built in this PR. Two fix shapes, with predictions:

**Shape A — exclude stitched at the query.** Add a "no stitched compilations" filter to the search
the her-room uses (a `SearchOpts.filters` flag in `services/mediaSearch.ts`, the SQL twin of
`notStitchedHere`), so k=24 is spent on rows the offer can accept.

- Blast radius: `mediaSearch.ts` is shared code (kits, hero picks, the picker's search) — Mia's
  file. The flag would default off, so no other caller changes, but the change still lands there.
- Predictions: her-room fills 16/16 on this brief; the three basketball photos drop out of the top
  16 only if 16 soccer photos outscore them (the score is 0.7·sim + 0.3·hero, and hero is flat at
  0.85–0.91 across the generated set, so sim decides — likely but not certain: predict ≤1 basketball
  photo in the 16). Library count 18 → 31 on this brief. One fewer refusal path in `offer()` to
  reason about. Doctrine eval: re-cut the baselines (the recorded libraries change).

**Shape B — overfetch until the rooms fill.** In `library.ts` only: ask searchMedia for a larger k
(e.g. 3× the room, or loop: k, 2k, 4k until the her-room is full or the ranking is exhausted) and let
the existing offer refuse the compilations.

- Blast radius: `server/studio/agent/library.ts` alone — in lane. No shared change, no flag.
- Cost: searchMedia already loads and scores every row of the athlete in memory (one SELECT, no
  LIMIT); k only truncates the sorted list, so a larger k is free until the diversity pass, which is
  O(k²) cosine on 1408-dim vectors — at k=96 that is ~9k cosines, milliseconds.
- Predictions: identical library to Shape A on this brief (same ranking, same 16 survivors), so
  the two shapes are distinguishable only by where the code lives, not by output. The loop form
  also fixes the case Shape A does not: a library whose top-k is crowded by rows the offer refuses
  for any _other_ reason (untagged, `athlete_present` null) — those are refused post-search too.

**Recommendation:** Shape B, because it is in lane, needs no flag, and handles every post-search
refusal rather than the one we have named. Shape A is the cleaner long-term home and should be
proposed to Mia as the follow-up once B has measured the effect. Prediction for either, on the
recorded doctrine libraries: stills cast rises from the baseline on the briefs that asked for
stills; b-roll count is unchanged (scenes have their own room and their own ranking).

## Part 1 — sweeps and samples

### "Video-lane-never-ran" sweep (the card called it the clobber-victim sweep; `out-sweep.txt`)

| athlete         | origin    | victims | vision null | photo-shaped | abandoned | has enrichment |
| --------------- | --------- | ------- | ----------- | ------------ | --------- | -------------- |
| 3811cedd (test) | —         | **0**   | 0           | 0            | 0         | 0              |
| dc8f37f1        | generated | 8       | 0           | 8            | 0         | 0              |
| dc8f37f1        | upload    | 1       | 0           | 1            | 0         | 0              |

Context: 3811cedd has 66 transcoded video rows, all 66 read as clips. dc8f37f1 has 9 transcoded
rows, 0 read as clips. **The card's query finds "video-lane-never-ran", not "clobbered"**: it
matches any transcoded video row without beats, and `STUDIO_VIDEO_ENRICH` runs were only ever fired
for the test athlete, so dc8f37f1's 9 are rows the clip lane never visited. A true clobber (read,
then erased) is indistinguishable from that in the row, and none is known to exist after the 51 s
fix. The card's language is corrected here so the number is never read as a defect count
(Adi, 22 Sep 2026). **Approved for video-lane re-enrichment** (dev data, tiny spend): the 9 rows of
dc8f37f1, through the ordinary cron door with that athlete id, one request, never in parallel —
`probe-out/enrich-eval/reenrich.ts`, Adi runs it. Ids are not listed here (another athlete's rows).

Beats-count query, test athlete: generated 73 clips / 73 read / 73 with prev / 8 double-read;
upload 3 / 3 / 3 / 0; candidates 0; abandoned 0; model gemini-3.5-flash; avg beats 2.07 / 3.33.

### Repeatability — the 8 double-read rows, prev (Flash) vs current (Flash), `out-repeat.txt`

| field                            | agree                | note                                                                                      |
| -------------------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| athlete_present                  | 8/8                  |                                                                                           |
| shot_type                        | 6/8                  | `943bfc9e` action↔other, `5f4173d8` other↔action                                        |
| disposition                      | 6/8                  | as_is↔crop twice                                                                         |
| brands_visible (set, normalized) | 7/8                  | mean Jaccard 0.92; the miss is "Bolyn" vs "Bolyn Sporting Goods"                          |
| beat count                       | 7/8                  | `f2338ddc`: 1 beat [0-3] vs 4 beats at 1 s each — a phantom split on a static studio pose |
| attire                           | 4/8                  | string level; paraphrase in 3 of the 4 misses                                             |
| setting                          | 3/8                  | string level; **all 5 misses are paraphrase** ("empty stadium" / "empty soccer stadium")  |
| vibe                             | 2/8                  | string level; paraphrase                                                                  |
| athlete_prominence               | mean abs delta 0.012 |                                                                                           |
| aesthetic_quality                | 0.031                |                                                                                           |
| hero_suitability                 | 0.050                |                                                                                           |

Read: the categorical and numeric fields are stable; the free-text fields are stable in meaning and
unstable as strings, so nothing downstream should compare them as strings. One real instability:
beat segmentation on a 4 s static clip (1 vs 4). Beat _boundaries_ on the multi-beat clips agree to
within 0.5 s (`8e9a56f4`: 0-3-6-10-14 vs 0-3.5-6.5-10.5-14.5).

Bonus finding: `943bfc9e` (generated 6 s) is "a CGI ball into a goal, followed by a still photo of
Sadio Mané" — **athlete_present=true on both reads**. See Part 3.

### Exhibit A — ground truth, `d076a790` (owner-verified against the footage)

6 beats at 0–9.5 / 9.5–14.5 / 14.5–20.5 / 20.5–30.5 / 30.5–42.5 / 42.5–50. Real moments ≈9 s (sits
up), 14.5 s (stretches), ≈22.5 s (dribbling starts), ≈30 s (kick-ups), ≈42 s (shoots, walks).
Verdict: 6/6 phases correctly segmented, no merges, no phantom splits; 4/5 boundaries within 0.5 s;
one boundary (20.5) ≈2 s early on a soft transition. The poster-frame (photo-path) read of the same
row, now under `vision.prev`, said shot=lifestyle "tying her cleat"; the full-clip read says
shot=action — single-frame tagging of a video materially mislabels it. Full-clip read: $0.0213,
17.5 s, one call.

## Part 2 — the blind grid (design; awaiting go)

**Sampling frame** (every stored top-level row of the athlete is tagged; `out-suspects.txt`):

| stratum                        | n        | in the sheet                                                                                                                       |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| photo / upload                 | 20       | all 20 (this is where the Mané photos and the AI-generated uploads live)                                                           |
| photo / generated              | 362      | 12, stratified: the 3 that reached the live library (a1–a3), 4 basketball-tagged, 1 jersey-8 (`19cf70ad`), 4 random soccer         |
| photo / discovery or connected | 0 tagged | **stratum is empty** for this athlete (5 connected VIDEO rows are status=failed, untagged)                                         |
| video / upload, clip-read      | 3        | all 3                                                                                                                              |
| video / generated, clip-read   | 73       | all 73 per the brief; beat-sanity scoring required only on the 30 with ≥2 beats, the 43 single-beat 4 s clips get tag scoring only |

Sheet: `probe-out/enrich-eval/sheets/grid-1/{sheet.html,key.json,scores.csv}`, reusing
`studio/agent/eval/sheet.ts`'s `shuffle` / `assignCodes` / `scoresTemplate` and a new renderer
(`renderGridSheet`) for image + tag cells — the plan sheet renders plan items, not tags. Codes
`P001…`, the key holds `{code → assetId, model}`. Thumbnails and posters are downloaded once into
the gitignored sheet dir (signed URLs expire in an hour; a sheet must survive a day). The sheet
shows: the image/poster (and the clip's mp4 for videos), then the stored tags — athlete_present,
shot_type, setting, attire, vibe, brands_visible, and for clips the beat list with times and
descriptions. Score columns: `present_ok`, `shot_ok`, `setting_ok`, `brand_ok` (y / n / na), `beats_ok`
(videos; 1–5, boundaries land on real changes, count neither merged nor inflated), `beats_fail`
(one of `none`, `merged`, `inflated`, `phantom_split`, `boundary_off` — **`phantom_split` is the
named failure mode from the repeat sample**: a static 4 s pose read once as 1 beat and once as four
1 s beats), `note`.

**Pro cell — storage: a file, not the row.** Options considered:

- scratch key on the row (`metadata.vision_eval`): a write to shared prod rows for eval-only data —
  refused under the house rules;
- side table: DDL — refused;
- **file** `probe-out/enrich-eval/pro-tags.json` keyed by assetId, gitignored: zero DB writes, zero
  DDL, the sheet reads it. Recommended.

Pro cell membership (15): the 3 upload clips, 8 generated clips (the 4 multi-beat ones with the
largest beat count, `943bfc9e`, `f2338ddc`, 2 random), 4 photos (2 Mané uploads, 1 basketball, 1
soccer). Both models' tags for these 15 go in the sheet as separate unlabeled cells (30 cells for
the 15 assets; the key says which). Videos re-tag through `tagVideo` with `STUDIO_ENRICH_VIDEO_MODEL`
set in the eval process only. **Photos go through a verbatim prompt copy** (approved, Adi 22 Sep 2026):
`lib/visionTag.ts` hardcodes `GEMINI.flash` and does not export its prompt, and it is shared code,
so `probe-out/enrich-eval/pro-cell.ts` carries a byte-for-byte copy of the photo prompt and the
same call shape (inline JPEG, JSON response, temperature 0.2) with the model swapped. **Drift
risk, by name:** if the shared prompt changes, the copy is stale and the Pro photo cells measure a
different prompt, not a different model. Guard: the script hashes the `const PROMPT` block of
`visionTag.ts` at start-up and refuses to run if it differs from the copy's hash
(`fdebbfcbb14cf2d3bf2ca044a3980f89` on 213552c). The copy never touches `visionTag.ts`.

**Itemized spend** (estimator in `studio/enrich/videoCost.ts`, Pro list rates $2/M in, $12/M out;
the estimator ran ≈1.5× over Flash's invoice on the 51 s clip, so these are ceilings):

| cell                                                   | n   | est.                               |
| ------------------------------------------------------ | --- | ---------------------------------- |
| Pro, 51.5 s upload                                     | 1   | $0.045                             |
| Pro, uploads with unknown duration (estimated at 60 s) | 2   | $0.102                             |
| Pro, generated 4 s clips                               | 7   | $0.064                             |
| Pro, generated 14.5 s clip                             | 1   | $0.017                             |
| Pro, photos                                            | 4   | $0.022                             |
| **Pro cell total**                                     | 15  | **≈ $0.25** (cap the run at $0.60) |
| sheet build, sweeps, repeatability                     | —   | $0                                 |

Nothing billable runs before the go.

## Part 3 — suspects (measured; nothing fixed)

**athlete_present.** Two upload photos are tagged "Professional soccer player Sadio Mané mid-air …"
with `athlete_present: true, athlete_prominence: 0.9` (`f608e704`, `65d290cf`), and one generated clip
holds a Mané still, also `true` (`943bfc9e`). The tagger's prompt asks "is the athlete clearly the
subject" with no notion of _which_ athlete — it has never been told who she is, so a named male
professional is "the athlete". All three go in the grid. Also in: `19cf70ad` ("jersey number 8").

**Cross-sport.** There is **no sport field** in the tags (keys: aesthetic*quality, athlete_present,
athlete_prominence, attire, beats, brand_safe, brands_visible, content_flags, description,
disposition, edit_note, hero_suitability, prev, reason, setting, shot_type, vibe, video). Running
`sportVocab.namesSport` over description+setting+attire: soccer 403, basketball 32, running 9, none 14. So the data \_does* support a filter today, derived from free text, at the cost of 14 unknowns;
and `setting` alone is nearly enough ("outdoor basketball court" ×9 etc.). The 32 basketball rows
are all generated. On the live library the leak is amplified by the starved her-room (Part 0).

**Brand normalization.** 38 distinct strings after `normalizeBrandName`; case variants fold fine
(Adidas/adidas, CarMax/Carmax). What does not fold: **Stanford / Stanford University / Stanford
Cardinal / Stanford Athletics** (183 / 39 / 8 / 1), **NJ/NY Gotham FC / Gotham FC** (30 / 8),
**Bolyn / Bolyn Sporting Goods / BOLYN sporting goods** (5 / 7), Georgetown G / Hoyas, and two
"unidentified … logo" strings that are not brands at all. Team and school names dominate the top of
the table and are not in `SPORTSWEAR_BRANDS`, so nothing in brands.ts sees them either way.

**Provenance vs authenticity.** The three her-camera clips' tags: `64c9bf0d` (studio, 1 beat,
aq 0.85, hero 0.9), `e055746a` (field, 3 beats, aq 0.85, hero 0.9), `d076a790` (field, 6 beats,
aq 0.75, hero 0.7). Nothing in the schema names synthesis — no `looks_generated`, no reason text
mentioning it. The only tell in the stored data: the two AI-generated uploads have `duration_seconds`
0 and `duration_seconds_precise` null (never transcoded), score _higher_ on aesthetic and hero than
the real 51 s clip, and one has a whole-clip `disposition: as_is` with "the clip is clean and
well-framed". None of that is a detector and none was built. Report only.

## Runs (Adi, 22 Sep 2026)

- **Re-enrich dc8f37f1:** 17/17 read as clips through the ordinary cron door (the 9 victims plus
  8 more the lane had never visited). One request.
- **Pro cell:** 15 assets, **$0.3894** at Pro list rates by the meter (estimate $0.297; cap $0.60
  held), mean 16.9 s a call, 0 null reads, into `pro-tags.json`. No row written.
- **Grid:** 125 cells (110 stored + 15 Pro), `sheets/grid-1/`. Beats pre-scored from the text:
  **5 phantom splits** — P030 / P041 / P088 / P114 / P117 — the named failure mode at n=5 of 76
  clips. Visual pass in progress; `scores.csv` not yet exported when this was written.

### What the Pro cell says before any scoring (read straight off `pro-tags.json`)

| asset                                         | Flash (stored)                                 | Pro                                                                                                                                                                                  | read                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `f608e704`, `65d290cf` (the two Mané uploads) | athlete_present **true**, prominence 0.9       | athlete*present **true**, prominence 0.9 — while its own description says *"A male soccer player in a white uniform…"\_                                                              | **Same failure on both models.** The tagger is never told who she is; "the athlete" means any athlete. Not a model problem — a prompt/schema problem. |
| `943bfc9e` (CGI ball + Mané still)            | true, 0.4                                      | true, 0.5, "…a male soccer player controlling a ball"                                                                                                                                | same                                                                                                                                                  |
| `d076a790` (exhibit A, owner truth 6 beats)   | **6 beats, 6/6 phases, 4/5 boundaries ≤0.5 s** | **5 beats**: 0–10 / 10–18 / 18–24 / **24–42** / 42–51 — merges dribbling (20.5–30.5) with kick-ups (30.5–42.5), puts the stretch boundary 3.5 s late, relabels shot action→lifestyle | Flash beat Pro on the one row with ground truth.                                                                                                      |
| `f2338ddc` (static studio pose)               | 4 phantom 1 s beats (its `prev` read said 1)   | 1 beat                                                                                                                                                                               | Pro avoided the phantom split here.                                                                                                                   |
| `e055746a`                                    | 3 beats                                        | 2 beats                                                                                                                                                                              | unverified                                                                                                                                            |
| brands on the Mané photos                     | (stored: not captured in my notes)             | Puma, New Balance, Adidas                                                                                                                                                            | richer, unverified                                                                                                                                    |

**Model decision the data supports:** stay on Flash. Pro costs 1.3× on the meter, is identical on
the athlete_present failure, and lost on the only beat ground truth we own. Pro's win is on phantom
splits on static clips, which a post-parse rule can take for $0.

### Reveal — grid-1, Adi's pre-score (beats from the text + notes; the yes/no columns unscored)

`sheets/grid-1/reveal.md`. 90 of 125 cells carry a beat score or a note; `present_ok` / `shot_ok` /
`setting_ok` / `brand_ok` were not filled (Adi called the visual pass a pass on sight, 22 Sep 2026),
so the per-field accuracies are not measured and this reveal is the beats plus the flagged cells.

|                                  | stored (Flash)                                                                     | Pro                                                                                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clips with beats scored          | 73                                                                                 | 9                                                                                                                                                                                             |
| beats ≥4 of 5                    | **68/73 (93%)**                                                                    | 9/9                                                                                                                                                                                           |
| phantom splits                   | **5** (`c018b475`, `2fca5571`, `32b1b9bf`, `f2338ddc`, `234008e8` — all generated) | 0                                                                                                                                                                                             |
| merged / inflated / boundary off | 0                                                                                  | 0 — **but the pre-score is text-derived and cannot see a merge**: exhibit A's Pro cell (5 beats, dribbling + kick-ups merged, stretch 3.5 s late) scored 5/none. Pro's 9/9 is an upper bound. |

**Blind, both models, all six cells flagged "possibly not her":** `65d290cf` and `f608e704` (the two
Mané uploads) and `943bfc9e` (the CGI clip with a Mané still) — stored AND Pro, without knowing
which was which. That is the athlete_present conviction, model-independent, blind.

**A second athlete_present class, found by the pre-score:** four stored cells with
`athlete_present: true` and a description that names no person — `267ededf` (clip), `2a7d49f0`
(clip), `e58f3a5a` (upload photo), `2da2c459` (upload photo). Present-true on an empty frame is the
mirror failure of present-true on the wrong person; the same prompt gap ("is the athlete clearly the
subject" with no athlete defined) produces both. Pending the visual pass to confirm the four.

**Brand variants flagged blind:** 4 cells, all the Bolyn family (BOLYN sporting goods / Bolyn) —
the one cluster the grid sampled; Stanford's four variants were not in the photo sample.

## Fix list — ranked by what the eval convicts (updated after the Pro cell and the pre-score)

1. **athlete_present** — CONVICTED twice over, blind, on both models: true on a named male
   professional (6/6 cells flagged) and true on frames whose description names nobody (4 stored
   cells). A _prompt/schema_ gap, not a model gap: both models say true at 0.9 on a photo they
   themselves describe as a male professional. The fix is to tell the tagger who she is (a two-line profile: sport, sex, team) and
   ask it to distinguish "the athlete" from "another person" — that is `lib/visionTag.ts` and the
   video prompt, shared code → **Mia**. In-lane mitigation available today: a library-line guard in
   `studio/agent/library.ts` that reads the description for a named/male subject and drops
   `athletePresent` to null (offered as a scene, never as her). Proposed, not built.
2. **Her-room starvation** — CONVICTED by one deterministic run (3/16 photos, all basketball on a
   soccer brief). Shape B in `library.ts`, in lane. Predictions above.
3. **Phantom beat splits on static clips** — CONVICTED at n=5 of 76 (≈7%), plus the 1-vs-4 repeat
   disagreement. In lane: a post-parse rule in `studio/enrich/videoTag.ts` that merges adjacent
   beats whose descriptions match and whose length is under a floor, or a minimum beat length
   relative to clip length. Prediction: the five named cells collapse to one beat each; exhibit A's
   six beats (all ≥5 s, all distinct) are untouched.
4. **Brand normalization** — counts known (Stanford ×4 variants, Gotham ×2, Bolyn ×3), correctness
   not yet scored. In lane: an alias fold in `studio/agent/brands.ts` `brandsOf` for team/school
   families before the planner line is built; `normalizeBrandName` itself is shared → Mia.
5. **Cross-sport** — no field; `namesSport` over the stored text classifies 444/458. In lane: a
   `sport` on the library line (derived, $0) so the planner can prefer the brief's sport; the
   starvation fix (2) removes most of the live symptom first. Measure after (2).
6. **Part 0 mechanism** — already fixed on main by #558; **the cast-lane bug it exposed is fixed on
   this branch** (c2c680f) and accepted on device.

## Proposed fix list — provisional order, to be re-ranked by the sheet (superseded above; kept for the record)

1. **Her-room starvation** (Part 0 side finding; live on main; certain from one run): 3/16 photos
   offered, and those three off-sport. Shape B proposed above; the highest-leverage assembly change
   on the table because it also underlies items 4 and the baseline's stills starvation.
2. **athlete_present on a named other person** (3 rows found by grep alone; the grid measures the
   rate).
3. **Brand normalization** (Stanford ×4 variants, Gotham ×2, Bolyn ×3 — counts known; the grid
   measures string _correctness_).
4. **Cross-sport** (no field; derive from setting/description, or ask the tagger for a `sport` key —
   the latter is a shared-prompt change → Mia).
5. **Part 0 mechanism**: already fixed on main by #558; the follow-up is logging the library's ids on
   the `agent plan cast` line so this is never inferred from a plan again.
6. Beat phantom splits on static clips (1 in 8 on the repeat sample; the grid's `beats_ok` measures).

## Fix pass 1 — predictions, written before the code (studio/enrich-fixes, 22 Sep 2026)

Branch off main 1564425. Items 1–5 of the fix list, server/eval lane; 6–8 (Board play, per-beat
posters, picked-video → beats) follow as pass 2 with their own predictions. No DB or GCS write in
this pass. Production reads are blocked from Claude's shell, so every live measurement is a probe
Adi runs (`probe-out/enrich-fixes/`, gitignored).

**Two corrections to the reveal, from reading the cells' stored text.** (a) Of the four "present-true,
names nobody" cells, `2a7d49f0` is HER — its whole-clip line names no person but its beats say "the
athlete … tying her shoe"; `267ededf` and `2da2c459` are hands-only; `e58f3a5a` is a NAMED other
person (a hurdler with her medal), not nobody. (b) The stored Mané descriptions carry no male word
at all — "Professional soccer player Sadio Mané mid-air …" — so a word-list guard catches none of
the three blind-flagged cells. The name is the only signal, and the guard uses it.

### 1 · athlete_present guard (`studio/agent/subject.ts`, applied in `library.ts`)

`subjectOf(vision)` → `her | other | nobody`, read from `description` plus the beats' descriptions
on a clip, and consulted only when the row claims `athlete_present: true`. OTHER: a male word
(unicode-aware boundary — to a plain `\b`, "Mané" ends in the word "Man") or a Capitalised bigram
outside quotes, not all-caps, neither token inside `brands_visible`, not on a short place/org
stoplist. NOBODY: no person word at all, or only body-part / "a person" words with none of
she·her·woman·girl·female·athlete·player.

Measured over the sheet's 110 stored descriptions ($0, local file): fires on `f608e704`,
`65d290cf`, `e58f3a5a` (named), `943bfc9e` (male), three present-true empty frames (`e64e900a`
ball on a logo, `7666e86d` ball in a stadium, `cf5ba50e` abstract graphic), and the two hands-only
shots. Zero fires on rows of her once quoted spans are ignored — the draft's two false fires were
'MUMBAI COBRAS' and 'Get Loud', both quoted signs.

Effect: OTHER is never offered (a photo of someone else is nobody's scene either). NOBODY is offered
with `athletePresent` forced false on the row copy — in the LibraryEntry AND in `byRef`, so the
caster's `fitsKind` agrees — and only after the ranked scenes. Her own picks are never dropped, only
relabelled. Predictions: (P1a) a Mané-described photo is absent from the prompt; (P1b) a hands-only
photo appears as `person_in_frame: no` after the scene lines; (P1c) a she-described photo is
unchanged. Mutation "subjectOf always returns her" reds P1a and P1b by name. Shared-code fix
(prompt profile + subject enum) written as `docs/proposals/enrich-athlete-present-prompt.md`, not
applied.

### 2 · Her-room overfetch, Shape B (`library.ts` only)

k = 24, then 96, then 384 — a further step only while the her-room survivors are under 16 AND the
last search returned a full k. Each extra step is one embedText and one repeat of searchMedia's
whole-library SELECT. Predictions on the recap brief ("a recap of this week's training, using what
I actually filmed"): (P2a) her-room 16/16, was 3; (P2b) library 18 → 31; (P2c) basketball among
the 16 below 3, expected 0–1 by base rate (403 soccer / 32 basketball rows). Route test: 24
stitched rows that outrank 16 photos of her → 16 photo lines; mutation "k fixed at 24" reds it by
name. Shape A carded as `docs/proposals/media-search-stitched-filter.md`.

### 3 · Phantom-split merge (`videoTag.ts`, post-parse)

On a clip of ≤ 8 s, a run of ≥ 2 adjacent beats each ≤ 1.25 s with the same `shot_type` and
`athlete_present` merges into one: first start, last end, descriptions joined and deduped, first
camera, motions joined, numerics max, brands union. Fixtures: the five stored beat sets, exhibit A,
P006. Predictions: (P3a) P030 3→1, P041 4→1, P088 3→1, P114 4→1, P117 3→1; (P3b) exhibit A
deep-equal before/after (every beat ≥ 5 s); (P3c) P006 untouched (1.5 s, 2 s). Mutation "rule off"
reds the five by name and nothing else. Corrections to the pinned prediction: there is no re-tag
door — `VIDEO_UNTAGGED` requires `beats IS NULL` — so a live re-tag is an in-process read that
writes nothing; and "byte-identical across a re-tag" is not a claim the model supports (the repeat
sample paraphrases). Quoted, not run: 5 × 4 s + 51.5 s on Flash ≈ $0.03, ceiling $0.05.

### 4 · Brand alias folding (`brands.ts` `brandsOf`)

Literal table: Stanford {University, Athletics, Cardinal} → Stanford; Bolyn {Sporting Goods,
BOLYN sporting goods} → Bolyn; NJ/NY Gotham FC → Gotham FC. `normalizeBrandName` equality, order
kept, deduped. Reaches the library line and `brandFlag`'s input; sportswear matching unchanged.
Grid table in the test; mutation "identity fold" reds it.

### 5 · Derived sport on the library line (`types.ts`, `library.ts`, `plan.ts`)

`sport` = `namesSport` over description + setting + attire; rendered `sport: soccer` / `unknown`;
the brief's sport in the prompt header from `namesSport(prompt)`, else `athletes.sport`. A line
cannot keep anything out of ASSEMBLY — it changes what the planner casts. Measured by Adi's probe
after #2: (P5a) basketball lines in the recap library — a count, no prediction; (P5b) basketball
items in one live recap plan: 0. Next mechanism if P5b fails, proposed not built: sport-aware
ORDER of the her-room in `library.ts` — rows whose derived sport differs from the brief's offered
after rows that match; a demotion, never an exclusion, $0.

### Addenda to the reveal (Adi, 22 Sep 2026, accepted)

- The "possibly not her" exhibit set is at least FOUR real people/classes, not three: the two Mané
  uploads (`f608e704`, `65d290cf`), the CGI clip holding his still (`943bfc9e`), and `e58f3a5a`, a
  named female hurdler with her medal — read by the pre-score as "names nobody", wrong.
- The stored Mané descriptions name him and carry no male word; Flash answered present at 0.9
  while writing his name. The model knows who it is looking at; the prompt never said who to look
  for. That sentence is the argument for the prompt fix (docs/proposals/enrich-athlete-present-prompt.md).

### 1b · The prompt fix — predictions, written before the code (Mia-approved, minimal)

Shared code: two profile lines in both taggers (name · sport · school off the athlete row, no new
schema), the question rephrased to THE ATHLETE, the answer's first key `subject:
the_athlete|another_person|nobody`, parsed into `athlete_present` with the ternary stored beside it
as `vision.subject`. Beats unchanged. The in-lane guard (1) stays as defense for every row tagged
before this; it is deleted with the backfill, which is carded with its cost in the proposal doc.

Predictions: (P1b-1) `applySubject`: the_athlete → true, another_person / nobody → false, a reply
without a valid subject keeps its boolean; mutation "ternary collapsed to always-the_athlete" reds
the another_person and nobody cases by name in both taggers' suites — **measured: 3 red by name,
32 green**. (P1b-2) The transport receives the prompt that names her, and the profile-less prompt
when no profile is given. (P1b-3) Live, Adi runs `probe-out/enrich-fixes/retag-exhibits.ts` on
approval (≈ $0.03, cap $0.10, no row written): 9/9 exhibits answer a non-the_athlete subject — the
four named/male as another_person, the five empty/hands as nobody; 4/4 she-controls answer
the_athlete. A miss is recorded, not tuned away. Flagged shifts beyond athlete_present are listed
in the proposal doc: her name is withheld from descriptions by one added sentence; prominence and
hero on photos of other people fall (intended); brands/setting/attire untouched.

## Fix pass 2 — predictions, written before the code (items 6·7·8, client/cast lane)

**6 · Tap-to-play on the Board.** `videoPath` on `CastableRow` (the clip's `gcs_path`), signed as
`videoUrl` on `CastPick` and on the clip arm of `CastItem` (asPick route — the stitch-clips list
caps at the newest 60, so an older upload would have no URL). It rides `AgentPlanItem.videoUrl` →
`heldClipRow` → `StoryboardRow.videoUrl`, display-only: out of `rowSignature` and
`boardWorkSignature` by construction (both are explicit field lists). A clip row's thumbnail is a
button; a tap swaps it for `BoardClipPlayer` (client/components/studio/BoardClipPlayer.tsx), which
owns its player, seeks to `clipTrim.startSec` once the source is ready, plays, and pauses at
`endSec` on `timeUpdate` — the out-point TimelinePreview enforces, the same way. Muted unless the
row's sound is on. Tap again restarts. Predictions: (P6a) cast.test: a clip item carries a signed
`videoUrl`, a photo item carries null; (P6b) agentLogic.test: the seeded clip row carries it;
(P6c) storyboardLogic.test: two rows differing only in `videoUrl` have equal signatures —
mutation "add videoUrl to rowSignature" reds it by name. Device (Adi): each of the four seeded
d076a790 rows plays exactly its window and stops.

**7 · Per-beat thumbnails.** `server/studio/agent/beatPoster.ts`: for a clip item cut to a window,
`thumbUrl` becomes a frame from INSIDE the window — its midpoint — grabbed by ffmpeg from a signed
URL, stored once at `athletes/<id>/studio/beats/<assetId>/<start>-<end>.jpg` (headObject first;
a hit signs and returns), signed. No DB write. Any failure keeps the clip's poster and logs.
Injected grabber + store in tests. Predictions: (P7a) beatPoster.test: first call grabs and
uploads, second call for the same window grabs nothing; a grab failure returns null — mutation
"skip the headObject" reds the cache test by name; (P7b) cast.test: a cut clip item's `thumbUrl`
is the beat poster's URL, a whole-clip item's is the clip's poster. Device: the four d076a790
rows show visibly different frames. Cost: one ffmpeg per (clip, window), once; ~1–2 s each on the
first plan of a clip, in parallel with the other items' signing; nothing after.

**8 · Picked video → beats.** `GET /studio/media` clip rows carry `beats` (a count off
`vision.beats`, 0 when none) — `MEDIA_COLUMNS` + `MediaClip`, in lane. On the Agent form a picked
video with beats ≥ 1 defaults to CUT and travels in `assetIds` (the route already loads a clip
through `herPhotoOrClip`, offers a picked clip as a CLIP line "her pick: yes", and the caster's
pick fallback takes a clip whole — no plan-route change); a per-video chip flips it to AS IS,
which stays passthrough; a beat-less video shows no chip and stays passthrough. The 12-pick cap is
shared between photos and cut videos; `askedFor` includes the cut set; the videos-section copy
changes. Predictions: (P8a) agentLogic.test: `agentRequest` puts cut videos after the photos in
`assetIds` and leaves as-is videos out; `buildSeed`'s passthrough holds only the as-is videos —
mutation "every video is passthrough" reds both by name; (P8b) studio.media.test: a clip with two
beats serves `beats: 2`, one without serves 0; (P8c) mediaPickerLogic.test: `beats` rides off the
wire. Device (Adi): pick the 51 s video, plan the recap brief → clip items cut to its beats, no
51 s tail.

## Fix passes 1 and 2 — measured against the predictions (studio/enrich-fixes, tip 4dfd2d8)

Seven code commits on main 1564425: 0706fb1 / e0a4bf6 / 3995b1d (predictions and cards, each
before its code), e556b26 (items 1·2·4·5), fcac006 (1b prompt fix + 3), 056289b (6·7·8), 4dfd2d8
(1b: school dropped). No DB row written; no GCS object written by any test. Pass 2 writes JPEGs
under `athletes/<id>/studio/beats/` at cast time, in production only.

| prediction        | measured                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1a·P1b·P1c guard | all green; mutation "subjectOf always her" → 8 red by name (2 route + 6 unit), nothing else                                                                                            |
| P2 overfetch      | green; mutation "k fixed at 24" → P2 alone red                                                                                                                                         |
| P3a–c merge       | P030/P041/P088/P114/P117 → 1 beat each; exhibit A deep-equal; P006 untouched; mutation "rule off" → the five red + the two shape tests, exhibit A and P006 green (they hold the no-op) |
| P4 fold           | grid 14 rows green; mutation "identity fold" → 8 red by name                                                                                                                           |
| P5 demotion       | green (a basketball line offered after 16 soccer, and offered when there is room); mutation "search order" → P5 alone red                                                              |
| P1b-1 ternary     | green; mutation "collapse to the_athlete" → 3 red by name across both taggers                                                                                                          |
| P1b-2 prompt      | green — the transport receives the prompt that names her, the profile-less one without                                                                                                 |
| P6a·b·c           | green; mutation "videoUrl in rowSignature" → P6c alone red                                                                                                                             |
| P7a·b             | green; "skip headObject" → the cache test red; "ignore the poster" → the cut-clip test red                                                                                             |
| P8a·b·c           | green; "every video passthrough" → 4 red by name                                                                                                                                       |

**One correction to the prompt-fix design, found by the pass-1 gate:** `athletes.school` is a
projection column an allow-list test guards (sourceGuard G5, "never add without a design entry"),
and the guard greps every file for the column's name. The profile is name + sport; `team` stays on
the type as null. Recorded in the proposal doc.

**Unmeasured, for Adi (production reads are blocked from Claude's shell):**

- `probe-out/enrich-fixes/library-probe.ts` — the recap brief's library, before (run in the
  enrich-eval worktree) and after (this worktree): her-room fill (P2a), library size (P2b),
  basketball lines in the her-room (P2c / P5a). Then one live plan on the recap brief: basketball
  items (P5b).
- `probe-out/enrich-fixes/retag-exhibits.ts` — the 13-cell re-tag, ≈ $0.03, cap $0.10, no row
  written; approval first. Note the profile now carries no team.
- Device: the four seeded d076a790 rows play their windows and stop; four different frames; the
  51 s video picked on the recap brief comes back as beats, not a tail.

**Gate on the final tip 4dfd2d8** (detached worktree, `npm test` bare, per-batch summaries
summed): **420 suites / 8193 tests / 1 failed** — `affiliationSync.test.ts` "a year-only from/to
(registry v2 allows YYYY)", the house flake. Both tsconfigs clean. `npm run lint`: 73 errors, the
same 73 as main (react/no-unescaped-entities, none in a touched file); the one new warning is an
import-order note in visionTag.test.ts, the style hundreds of existing files carry. The pass-1 tip
fcac006 had gated at 419 / 8179 with the flake plus the G5 red that 4dfd2d8 fixes.

### The 13-cell re-tag (Adi, 22 Sep 2026, $0.0464 by the estimator, no row written) — and what it corrected

10/13 as predicted. **The hard claim held: 9/9 exhibits answered a subject other than the_athlete**,
so every one now lands `athlete_present: false`. The three misses:

- `267ededf`, `2da2c459` (hands): `another_person`, not `nobody`. The model reads hands as a person
  it cannot identify. Wrong prediction, right outcome; `nobody` is for empty frames, and all three
  of those hit.
- `19cf70ad` (control — her, Stanford soccer uniform, face turned): **`another_person`.** Her
  profile row says `sport: Basketball`; the line said "a female Basketball athlete"; the model read
  the kit as the test. The two soccer CLIP controls survived on more of her. **Two corrections
  built from it:** (1) the profile line names her and "a female athlete" — no sport; the name and
  the "anyone else" clause carried every hit without it. (2) Item 5's fallback for a brief that
  names no sport is the sport her searched library MOSTLY shows (403 soccer to 32 basketball here),
  then the profile — profile-first would have read the recap brief as basketball and demoted her
  soccer footage, the leak inverted. Route test P5b holds it; mutation "profile before majority"
  reds it by name. Predictions for the re-run (≈ $0.05): `19cf70ad` → the_athlete, the other 12
  unchanged in truth value; the library probe on the recap brief prints `brief sport: soccer`.

### Live, 22 Sep 2026, post-fix (Adi) — three findings and two asks

**1 · `athletes.sport` was `basketball`.** On the tip before 286c2e7 the profile-first fallback read
it, the demotion inverted, and the recap brief produced a fictional basketball session, $2.40,
all i2v. 286c2e7 puts the library's majority before the profile; this commit adds `sportSource`
and `sportDisagreement` to the "agent library assembled" line and WARNS above one half (on that
run: 73 survivors, mostly soccer, brief basketball — a disagreement near 0.9). Adi corrected the
row to soccer. The data-quality question is carded for Mia:
`docs/proposals/athlete-sport-data-quality.md` — the column is free text from the signup form,
coalesced (never replaced) on a waitlist join, and overridden at read time by the identity
context reader, which is how a wrong row stays invisible.

**2 · The lookalike gap fired on day one.** The re-run's item 4 — "a female soccer player smiles
joyfully while dribbling… teammates frame the foreground" — is an i2v cast on a ref that is
visually not her (owner-confirmed). It passes the subject guard (unnamed, person-worded) and would
pass the ternary: no text signal exists. **Identity ladder L0 un-fades itself the moment plans
animate refs — today.** An i2v does not show a photo; it puts a face in motion under her name.

_Provenance, the likelier bug:_ the line reads as a MADE-HERE still (a generate without a reference
pack renders a stranger — generate-identity-probe, reference-packs), tagged present because the
prompt names "a female athlete". A generated image enters the photos-of-her room on the tagger's
word alone; nothing records whether the generation was identity-bound. The probe should print the
asset's origin and `generation_job_id`, and whether that job carried a reference pack.

_Shapes for i2v, proposed not built (Adi's ask 1):_

- **S1 — provenance gate at the cast.** `fitsKind("i2v")` requires `provenance ∈ {camera, synced}`;
  made-here fits i2v only when she PICKED it. Doctrine rule 5 already says "prefer her camera" and
  the planner ignored it here — a cast rule cannot be ignored. Blast radius: cast.ts `fitsKind` +
  one route test; a made-here ref on an i2v item swaps to a camera photo by query or is dropped
  and shown. Prediction on this plan: item 4 swaps or drops; nothing else moves. Cost: made-here
  stills that WERE identity-bound lose i2v too, until S2.
- **S2 — S1 plus "identity-bound made-here".** A made-here row fits i2v when its
  `generation_job_id`'s job carried her reference pack (a read-only join to `generation_jobs`),
  the one fact that says a generated face was hers by construction. Needs the pack to be recorded
  on the job — verify before building.
- **S3 — prominence + her-words on the line.** Rejected as the mechanism: the lookalike passes both
  (prominence high, "she" throughout).
- **S4 — the tagger's `subject` after the backfill.** Also passes: the model cannot tell a
  lookalike, and the proposal says so. S1 now, S2 as its refinement.

**3 · d076a790 and the doctrine miss.** The post-fix log line is `steps 2, k 96, found 96,
herSurvivors 71, thin false, guard {other 0, nobody 1}, library 31` — P2a and P2b confirmed live.
It carries no ids; this commit adds the offered clips' short ids. With three uploads and an
eight-slot camera-first clip room, d076a790 was offered. The plan cut beats from at least four
OTHER clips and generated item 4 — "running dribbling drills" — as an i2v while d076a790's
20.5–30.5 beat IS her dribbling. Real-footage-first says the beat wins; the planner chose a
generated stranger over it. One line for CC: rule 3 is advisory and lost to an i2v on the exact
beat it covers; the shape that holds it is S1 (a made-here ref cannot be an i2v while a camera
clip's beat covers the moment), not more prompt.

### Doctrine rule for live footage + trimmable beats — predictions, written before the code

**Verdict on the fork (Adi's probe):** assembly vindicated — d076a790 at a4 with all six beats,
e055746a at a10, 64c9bf0d present. The 10:42 plan cast ONE camera beat (e055746a[0]) and took
heading / juggling / Gatorade from generated-origin clip beats plus the lookalike i2v, while her
real dribbling (a4 [3]) and juggling (a4 [4]) sat offered. Camera-first ordering: closed, working.

**Mechanism, read from the parser:** a `segment` names a WHOLE beat and the planner has no way to
trim inside one — item 3's "1.5–3 s" is a generated clip's own beat, not a trim. Every window the
planner cast was ≤ 3 s; d076a790's beats run 5–12 s. A rule saying "long beats are trimmed, never
skipped" is unassertable without a place to put the trim, so the contract gains one:

- `PlanItem.window` — `{startSec, endSec}` in SOURCE seconds, INSIDE the named beat, optional. The
  parser clamps it into the beat, drops it (whole beat) when it is shorter than 1 s or malformed,
  and ignores it on any item that is not a clip with a segment. The caster's `trim` is the window
  when set, else the beat. The Board row shows the window as it shows a beat today.
- Doctrine rule 3 gains: when the brief asks for real / live / her own footage, a CLIP line "from:
  her camera" OUTRANKS a made-here line for any content it covers; made-here clips and generated
  shots enter only for genuine gaps; a long beat is trimmed to the seconds that carry the moment
  (`window`), never skipped for its length.
- Every cast item carries `provenance`, and the plan card says it: "YOUR CLIP · FILMED BY YOU" /
  "· MADE HERE" / "· FROM YOUR ACCOUNTS"; an i2v ref shows the same words, so a made-here still
  animated as her is visible as what it is. The "agent plan cast" log line carries each item's
  short asset id and provenance.

**Predictions.** (D1) parse: a window inside the beat is kept; one spilling past the beat's edges is
clamped; one under 1 s, inverted, on a whole-clip item, or on a photo item is dropped to null;
mutation "skip the clamp" reds by name. (D2) cast: `trim` is the window when set, the beat when
not. (D3) the doctrine block carries the new sentences; DOCTRINE_RULES stays 9. (D4, live — Adi,
the same brief "recap my training, use live footage"): d076a790's action beats are cast for the
training content ([3] dribbling, [4] juggling) with windows inside them; the lookalike i2v is gone
because her real dribbling covers it; camera-provenance clip items ≥ 3 of the plan's clip items.
A miss on D4 is recorded, and the next shape is the cast-side S1 (a made-here ref cannot be an
i2v while a camera beat covers the moment), not more prompt.

**Precedence of the brief's sport, stated:** her sentence > the majority sport of her searched
library > the athlete row > none. Adi corrected the row to soccer; both coexist — the majority is
the guard against the next wrong row, the row the last resort for a library with no majority.

**Still owed:** the lookalike ref's asset id and origin. Not in the 10:42 log (no ids on the cast
line then); it is the probe's a-line whose `shows:` begins "A female soccer player smiles
joyfully…". From this commit the cast line carries short ids and provenance, so the next run
answers it directly.

**Measured (D1–D3), tip after e7a29e2:** window parse — inside kept, spill clamped, short /
inverted / malformed / whole-beat / non-clip → null; mutation "skip the clamp" reds 2 by name.
Cast — the window is the trim, an outside window falls back to the beat; mutation "ignore the
window" reds 1 by name. The doctrine block carries both sentences at 9 rules. Route D2: a clip
item with `window {22.5, 26}` on a 20.5–30.5 beat casts trim 22.5–26 with `provenance: camera`.
The cast log line now carries `castTo: ["d076a790:camera@22.5-26", …]`. D4 is Adi's live re-run.

## Provenance verification — report and predictions, written before the code (Adi, sequenced after the live-footage gate)

**Gate the rule landed on (d21398a): 421 suites / 8206 tests / 1 red — the affiliationSync flake.**

**Where signal 1 is read — the clip lane, not the transcode.** The transcode is
`services/videoPoster.ts` (shared code, Mia's) and it re-muxes through libx264 + `-movflags
+faststart` with no `-map_metadata`, so whether a device atom survives it is ffmpeg's default, not
ours — the ORIGINAL is the only safe read, and the transcode keeps it at
`metadata.original_gcs_path`. The clip lane (`studio/enrich/videoEnrichment.ts`, in lane) already
visits every video row once with the bytes in hand; it now also ffprobes `original_gcs_path ??
gcs_path` over a signed URL — ffprobe reads the moov atom, kilobytes, never the object — and
writes the score in the SAME jsonb_set statement as `vision`, under `metadata.provenance_signal`
= `{ signal, evidence, probed_at }`. A generated row is skipped (origin is ground truth).

**The score (`studio/enrich/provenanceSignal.ts`, pure, tested on fixtures):** `device-camera`
when a device atom is present (`com.apple.quicktime.make` / `.model`, `com.android.*`);
`no-device-metadata` when the probe succeeded and none is; `unknown` when the probe failed or
found no video stream. Evidence stored beside it, never scored alone: encoder string, GPS atom,
creation_time and whether it precedes ingest, audio track presence. Presence is strong; absence
proves nothing — an edited real clip legitimately loses its atoms, which is why consumption is a
demotion and never an exclusion.

**Signal 2 — `vision.looks_generated`: yes | no | unsure**, one question in both tagger prompts,
parsed to those three strings or dropped. Soft; never a decision input alone. ⚠️ This extends the
prompt diff Mia approved as "as simple as possible" by one key and one sentence — flagged for her
nod before merge. Perturbation risk: the model is asked to judge synthesis, and a "synthetic
looking" read may pull `aesthetic_quality` on generated rows; nothing else in the wording moves.
Not in scope: photos' EXIF (signal 1 is a video signal; a photo's `verified` is null).

**Consumption.** `CastableRow` reads both keys; `LibraryEntry` gains `verified` (camera rows only:
true on device-camera, false otherwise) and `looksGenerated`. The line renders `from: her camera
(verified)` / `(unverified)`; a `⚠ looks generated` token appears ONLY when signal 2 says yes on
a camera or synced row. Within the clip room, camera rows sort verified-first (a stable re-sort
of `listClips`' camera-first order — demotion, never exclusion). Doctrine rule 3 gains: among her
camera lines, a (verified) line before an (unverified) one.

**Backfill.** The three uploads need a one-shot probe: `probe-out/enrich-fixes/provenance-backfill.ts`
reads each original over a signed URL (ffprobe pulls the moov atom — kilobytes; $0, no model)
and WRITES `metadata.provenance_signal` — a DB write, Adi runs on approval. The generated fleet
is skipped. Until it runs every camera row reads (unverified) and the ordering is unchanged, so
the acceptance re-run depends on it.

**Predictions.** (V1) unit: Apple atoms → device-camera; a generic Lavf muxer with no atoms →
no-device-metadata; a failed probe → unknown; mutation "score always device-camera" reds by name.
(V2) the clip lane writes `provenance_signal` beside `vision` for an upload and not for a
generated row; mutation "skip the probe" reds. (V3) route: a verified camera clip lists before an
unverified one whatever `ingested_at` says; the line says (verified)/(unverified); a synced row
with looks_generated yes carries the warning token, a made-here row never does. Mutations: "signal
ignored in ordering" reds V3's order case; "verified forced on all rows" reds V3's label case.
(V4, live — Adi): the two AI camera-roll uploads → no-device-metadata + looks_generated yes;
d076a790 → device-camera + no; the acceptance brief re-run prefers d076a790 over the AI uploads
for any overlapping content.

### The d076a790 absence (Adi's 11:06 clean-HEAD run) — answered from the code, before V4

The line logged `clips: [648a8906 c690065d e055746a 234008e8 f03fdad5 e04c29a1 aaf4c82a 6b229a66]`,
`herSurvivors 71`, and no d076a790. listClips is camera-first with LIMIT 8, so it RETURNED all
three camera uploads first; e055746a made the library and d076a790 and 64c9bf0d did not. The
stage is the offer, not the search: **searchMedia has no media-type filter, her clips come back
among the "photos of her", and the her-room pass offered them IN THE SEARCH'S ORDER before
listClips' order ran** — eight higher-similarity clips (the AI upload e055746a and seven
generated) filled the clip room, and when listClips' turn came its camera-first rows were refused
at `left <= 0`. The same door the eval's Part 0 found full of compilations. It also inflated
`herSurvivors` (71 counted clips as photos of her).

Fix (its own commit, before provenance): clips enter through listClips ALONE — `fillsHer` and the
nobody-leftover pass skip `mediaType === "clip"`; `herSurvivors` now counts photographs only. Route
test D076: nine made-here clips that outrank a camera clip for the brief → the camera clip is a1;
mutation "drop the guard" reds it by name (measured red). The assembly line now logs `listed`
(what listClips returned) beside `clips` (what was offered), so a clip in one and not the other
names its stage without a probe. Prediction for Adi's next run: `listed` and `clips` both hold
d076a790, e055746a, 64c9bf0d first; `herSurvivors` drops by the number of clips the search had
been counting (expect ≈ 71 → ≈ 60).

**V4 is conditional on this fix** — on the 11:06 tip d076a790 could not be preferred because it
was not offered. The perturbation prediction (Adi's ask 2): `probe-out/enrich-fixes/retag-perturb.ts`
re-tags her three uploads with the current prompt and diffs every field pre/post (no row written,
≈ $0.03, cap $0.15); it prints the ids, which settles which two uploads are the AI ones. Predicted:
`looks_generated` yes on the two AI uploads and no on d076a790; only `aesthetic_quality` moves,
and only on the generated-looking rows; the free-text fields paraphrase (the repeat sample's
known instability, not a perturbation); beats within ±0.5 s. Anything else that moves is a
finding. The lookalike PHOTO's id is still owed — it is a photo, not an upload video; the next
plan's `castTo` line names it.

### D4 live, on 8f6c17e (Adi, 22 Sep 2026) — and the control brief's prediction

Two plans nine seconds apart on "recap my training, use live footage", nothing picked:
`castTo: d076a790:camera@0-4, @9.5-13.5, @20.5-25.5, @30.5-35.5, @42.5-47.5` and
`@5-9, @15-19, @22-26, @37-41, @43-47`. Ten of ten slots her camera clip, zero made-here,
e055746a absent both times. Beats [3] (20.5–30.5) and [4] (30.5–42.5) were TRIMMED to 4–5 s
windows inside them, not skipped — **"long beats skipped" is closed as a suspect**: the planner
had nowhere to put a trim, and given `window` it uses it on every beat. D4's second half —
d076a790 preferred over the AI uploads on overlapping content — waits on the backfill (V4).

**Control brief, prediction before the run — "a soccer ad with me in it", same server.** The rule's
camera-outranks clause is conditional on the brief asking for real / live / her own footage, and
this brief does not; what still favours her camera is rule 3's "a clip that covers a beat beats a
generated shot of it" and rule 5's "prefer her camera for a shot of her". An AD asks for what a
training recap does not — a hero opening, a sign-off, a product or a place — and her camera clip
holds none of it. **Predicted: a MIXED plan — at least one made-here or generated item (an i2v
of her or b-roll from words) and at most three d076a790 beats.** If d076a790 sweeps 5/5 again,
the live-footage clause is not what discriminates: rule 3 plus camera-first ordering are doing
the whole job, and the clause is redundant rather than wrong. If the plan holds NO camera beat,
that is the miss to look at — an ad about her at soccer with her real soccer footage offered.

**herSurvivors, measured (Adi):** 71 on the 11:06 failing run → 57 and 57 on the two 11:22 passes
on 8f6c17e. The prediction was "≈ 71 → ≈ 60": the fourteen rows the search had been counting as
photos of her were her clips. Held.

**Control ran (Adi, 11:32:24, "a soccer ad with me in it", same server):** `castTo:
d076a790:camera@20.5-25 · 5581e882:camera (i2v) · d076a790:camera@30.5-36 · null (b-roll from
words, $1.17) · 64c9bf0d:camera@0-4`. Mixed — two d076a790 beats, one i2v of her, one b-roll —
**prediction held: the live-footage clause discriminates.** On the recap brief it is ten of ten
her clip; on the ad it is her clip where her clip covers the beat and generation where it does
not. Note for the tiering card: 64c9bf0d — one of the two AI camera-roll uploads by the eval's
reading — cast as "FILMED BY YOU" on the ad brief. That is the live example of why provenance
(origin = upload) is not verification, and what signal 1's (unverified) label is for once the
backfill has run.

**Signal 2 reverted (Mia's call, 22 Sep 2026):** the `looks_generated` key and its sentence come
out of both prompts, the parse, the row, the line and the doctrine; the prompt diff returns to the
one she approved. The V4 prediction loses its `looks_generated` half; the perturbation probe
diffs the prompt as it now stands (profile line + subject) and its "only aesthetic_quality moves"
prediction stands for that.
