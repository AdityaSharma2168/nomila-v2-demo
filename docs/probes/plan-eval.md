# Plan eval — the planner's per-merge regression artifact

**What this is.** Eleven fixed briefs (`server/studio/agent/eval/briefs.ts`) through the live
planner on the recorded library, scored blind, with the auto metrics beside the scores. Every
planner-touching merge adds a row here. The runs, the recorded libraries and the sheets live under
gitignored `probe-out/plan-eval/` — they hold the tagger's words about real photographs — and only
aggregates are committed.

## One command

```bash
cd <worktree>
DOTENV_CONFIG_PATH=/Users/adi/nomila-v2/.env \
npx tsx --require dotenv/config server/scripts/studioPlanEval.ts --run --label <label> --n 3
# then
… --sheet probe-out/plan-eval/runs/<A>.json probe-out/plan-eval/runs/<B>.json --name <A-vs-B>
# score probe-out/plan-eval/sheets/<A-vs-B>/scores.csv (1–5 per column), then
… --reveal probe-out/plan-eval/sheets/<A-vs-B>
```

Without `--run` it is a dry run: records any missing library, prints sizes and the call count,
sends nothing. `--max-calls` (default 80) stops a runaway loop; tokens are printed at the end. The
recorded libraries are what make two runs comparable — `--refresh-library` is deliberate.

## The scoresheet

| column                 | 1 … 5                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `i2v_reserved`         | i2v used for complex multi-action scenes … i2v only for one simple animatable moment                                             |
| `stills_where_carried` | a photo that already carries the beat was animated … held as a still on the planner's own judgment                               |
| `real_clips_used`      | real footage ignored where a clip covered a beat … used as-is or cut to the beat                                                 |
| `broll_earned`         | generic b-roll unmoored from the brief … every b-roll item tied to the brand, product or story, or none planned                  |
| `product_rules`        | product invented, doubled or ignored … one item per product she picked, about that product (blank when the brief has no product) |
| `overall_mix`          | a board of N generations … a mix that uses the real material the library offered                                                 |
| `relevance`            | shots that do not serve the brief … every shot serves it                                                                         |

## Escalation path for an ambiguous cell

n=3 is thin when the spread is measured from three samples. Baseline runs at n=3; the reveal marks a
brief × criterion **ambiguous** when the delta between two runs is inside the larger repeat sd.
Before flagging a rule as no-effect, re-run **just the ambiguous briefs** at n=5–6
(`--run --label <label>-n5 --n 5 --only a,b,c`), re-sheet, re-score, re-reveal. Only then is a rule
flagged — honestly, not defended.

## Baseline predictions — written before the run (2026-09-22)

1. b-roll present in ≥ 8 of 11 briefs (the current "mix in broll" rule fires almost always).
2. Mean generation share (i2v + broll + product over items) ≥ 0.7.
3. `clip` used in ≤ 3 briefs; `image` in ≤ 2 (offered, nothing prefers them).
4. The stitched compilation cast as "your clip" in `real-footage` at least once in three —
   **voided before the run**: the exclusion now holds at the offer (see findings), so the row
   never reaches the planner. What replaces it: `stitchedRefs` must be 0 on every cell.
5. Null rate: unmeasured; recorded, not predicted.

## Findings before any plan was made

- **The exclusion had a hole.** The first dry run showed `stitched 8` on four briefs: searchMedia
  has no media_type filter, so stitched outputs ranked among the 24 "photos of her" and filled the
  clip room without passing `listClips`. Fixed at the offer (`library.ts`, commit f751fcd). This is
  the M1 lesson in production form: the fixture clip reached the prompt through the search too.
- **Recap-like briefs see only 3–4 photos of her.** On `training-recap`, `real-footage`,
  `product-drop` and `boots-then-match`, the search's 24 slots were mostly her videos (stitched
  and generated), so after the exclusion the "her" room held 3–4 photos. The planner is then
  choosing shots of her from a handful. Product behaviour, not the harness's; noted for the
  doctrine half — "real footage first" on a library where the search is already video-heavy.
- **No product photo given.** `product-drop` ran without a product (`--product` was not passed;
  the measured library has no product-only shot). `product_rules` is unscorable on it this round.
- **Prompt size is 12–17k characters** per call, most of it the library block.

## Runs

### baseline-2026-09-22-774d403e4051 — the current planner, before any doctrine

git `abe85b9` · prompt `774d403e4051` · gemini-3.1-pro-preview @ 0.6, no thinking config · n=3 ·
33 calls · tokens 118,970 in / 111,354 out · 14–40 s per call · blind scores: **not yet** (sheet
`probe-out/plan-eval/sheets/baseline-only`, 33 cells; scored together with the doctrine run so the
judge cannot tell the arms apart).

Auto metrics, per brief (kinds shown per repeat):

| brief                     | null  | items | i2v   | broll | image | clip  | gen share  | nulled |
| ------------------------- | ----- | ----- | ----- | ----- | ----- | ----- | ---------- | ------ |
| adidas-ad                 | 0     | 6.00  | 2/2/2 | 2/3/2 | 0/0/0 | 2/1/2 | 0.72 ±0.10 | 0      |
| training-recap            | 0     | 5.67  | 2/1/2 | 0/0/0 | 1/1/1 | 3/3/3 | 0.29 ±0.08 | 0      |
| product-drop (no product) | 0     | 4.67  | 2/2/2 | 1/2/2 | 0/0/0 | 1/1/1 | 0.78 ±0.03 | 0      |
| announce                  | 0     | 4.33  | 1/2/1 | 1/1/1 | 0/0/0 | 2/2/2 | 0.53 ±0.06 | 0      |
| hype                      | 0     | 5.67  | 2/2/2 | 2/2/3 | 0/0/0 | 1/2/1 | 0.77 ±0.09 | 0      |
| thank-partner             | 0     | 5.33  | 2/3/3 | 1/1/2 | 0/0/0 | 2/1/1 | 0.74 ±0.13 | 0      |
| real-footage              | 0     | 5.33  | 0/0/0 | 0/0/0 | 0/0/0 | 6/5/5 | 0.00 ±0.00 | 0      |
| day-in-life               | 0     | 5.33  | 1/2/1 | 1/1/1 | 1/1/1 | 2/2/2 | 0.43 ±0.06 | 0      |
| concept                   | 0     | 4.67  | 2/2/2 | 2/1/2 | 0/0/0 | 1/1/1 | 0.78 ±0.03 | 0      |
| boots-then-match          | **1** | 5.00  | 1/1   | 1/2   | 0/0   | 3/2   | 0.50 ±0.14 | 0      |
| complex-i2v-trap          | 0     | 4.67  | 1/1/2 | 2/3/1 | 0/0/0 | 2/1/1 | 0.72 ±0.10 | 0      |

All 33 cells: mean generation share **0.57** (sd 0.26) · null rate **0.00** (no value outside §8's
lists in 33 plans) · i2v-without-her 0 · stitchedRefs 0 · b-roll in 9/11 briefs · a clip in
**11/11** · a held photo in 2/11 · one null plan (transport failure, no reply — the run file now
records the reason; this one predates that).

**Predictions, scored honestly:**

| #   | predicted                   | measured | verdict                                            |
| --- | --------------------------- | -------- | -------------------------------------------------- |
| 1   | b-roll in ≥ 8 of 11 briefs  | 9/11     | held                                               |
| 2   | mean generation share ≥ 0.7 | 0.57     | **missed** — the planner already reaches for clips |
| 3   | `clip` in ≤ 3 briefs        | 11/11    | **missed**, badly — clips are used everywhere      |
| 3   | `image` in ≤ 2 briefs       | 2/11     | held                                               |
| 4′  | stitchedRefs 0              | 0        | held                                               |
| 5   | null rate: unmeasured       | 0.00     | recorded                                           |

I predicted a planner that ignores real material. It does not: given CLIP lines it uses them in
every brief, and "use my real footage" came back as six clips and nothing generated. What the
numbers cannot see, and the doctrine is actually about, is in the directions:

- **B-roll is generic stock, everywhere.** Across `adidas-ad`, `hype` and `complex-i2v-trap`,
  16 b-roll items: a ball on dewy grass, a net rippling, floodlights powering on. On the adidas
  brief, 1 of 7 mentions adidas at all. The device evidence reproduces exactly.
- **"Real footage" is made-here.** The recorded libraries hold 88 CLIP lines: **85 made-here, 3
  camera** — `listClips` is newest-first and her camera uploads are older than every generated
  clip, so they never make the eight. 59 of 65 clip items cast a made-here clip. The
  `real-footage` brief's "nothing made up" board is six generated clips.
- **Held photos are nearly absent** (2 of 11 briefs, one item each) even where a photo carries the
  beat.
- The `complex-i2v-trap` did not trap: the planner decomposed the sequence into single kicks for
  i2v and gave the dribble to b-roll ("a ball dodging unseen obstacles"). Competent; the judge
  decides if it is relevant.
- A clip cut to two beats was counted as a "reused ref" on three cells; the metric now counts the
  same cut twice, not the same file.

**Implication for Half B:** rule 5 ("her camera over made-here") has three lines of material to act
on. A prompt rule cannot prefer what the caster does not offer — `listClips` must put camera clips
first (provenance, then newest). That is agent code the C2 ledger reserved for the doctrine PR, and
it changes the LIBRARY, not just the prompt — so the doctrine run is confounded unless it is split:
arm A = doctrine prompt on the baseline libraries; arm B = doctrine prompt on re-recorded,
camera-first libraries. Adi's call (docs/plans/studio-plan-doctrine.md §8).

## The diagnostic read of the first baseline (Adi + a reviewer, 2026-09-22)

Reading the 33 cards broke the blinding on this arm, so it is the **diagnostic read**, not the
arm on the combined sheet; a fresh baseline (`baseline-fresh`, same prompt, same libraries, new
samples at 0.6) takes its place there. Scores are in
`probe-out/plan-eval/sheets/baseline-only/scores.csv`; the reveal:

| criterion            | mean | sd   | n                                               |
| -------------------- | ---- | ---- | ----------------------------------------------- |
| i2v_reserved         | 4.03 | 0.59 | 32                                              |
| stills_where_carried | 3.45 | 0.91 | 29                                              |
| real_clips_used      | 4.28 | 0.85 | 32                                              |
| broll_earned         | 3.41 | 1.07 | 32                                              |
| product_rules        | 2.33 | 1.51 | 6 (the three product-drop cells scored 1, 1, 1) |
| overall_mix          | 3.66 | 0.87 | 32                                              |
| relevance            | 3.81 | 0.90 | 32                                              |

Findings from the read, in the reviewer's order, each now a doctrine input:

1. **Product-drop fabricates the product.** All three cells generated b-roll of fictional "new
   boots" and captioned a rival-kit clip as "wearing them". No product exists in the library and
   the brief picked none; the right answer is her product photos or a declared gap, never
   invented branded imagery.
2. **Generic filler migrated into $0 clip rows.** A ball-on-grass clip is cast as "grounding in the
   sport" filler in many plans. Rule 4 as drafted policed only b-roll. Measured floor, first
   baseline: **22 of 32 plans** carry at least one clip whose line says person_in_frame: no.
3. **The trap brief shows evasion, not refusal.** "Beating three defenders" became object b-roll of
   a ball dodging invisible obstacles. Policy: the honest-gap line.
4. **Stills are only ever screenshots.** Warm portrait sign-offs get i2v'd micro-motion instead of
   a hold.
5. **Boots-then-match papers over the missing match** with net-ripple b-roll.
6. **Directions are short and drop §8 axes.** Measured floor: of 94 generated items, 6 carry all
   five axes (axes coverage **0.07**); 61 carry four, 27 carry three.

Three metrics were added for these: `clipsWithoutHer`, `axesCoverage`, `gaps` (+ `productItems`).
And one caster change: `listClips` orders her camera clips first, then synced, then made-here,
newest within — a prompt rule cannot prefer what is not offered. It changes what the planner SEES,
so it is its own arm.

**A hard ceiling found while recording arm B's libraries: the athlete has exactly TWO camera
clips.** Camera-first puts both in every brief's eight (default set: 0–1); the other six lines are
still made-here. "Real footage first" on this library can move at most two of eight lines.

## Predictions for the doctrine arms — written before the prompt commit (2026-09-22)

Three arms on one 99-cell sheet: **F** `baseline-fresh` (old prompt, default libraries), **A**
`doctrine` (new prompt, default libraries), **B** `doctrine-camera-first` (new prompt, camera-first
libraries). Floors are the first baseline's auto metrics (F should land within its spread) and the
diagnostic read's blind means.

Auto metrics, A against the first baseline:

| metric                             | floor (first baseline) | A predicted                                                                                                                     | B predicted                            |
| ---------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| axesCoverage (mean)                | 0.07                   | **≥ 0.80** — the strongest prediction; the prompt asks for all five by name                                                     | same                                   |
| cells with ≥ 1 clip without her    | 22/32                  | ≤ 11/33                                                                                                                         | ≤ 11/33                                |
| briefs with any b-roll             | 9/11                   | ≤ 6/11                                                                                                                          | ≤ 6/11                                 |
| b-roll items per plan (mean)       | ~1.5                   | ≤ 0.8                                                                                                                           | ≤ 0.8                                  |
| briefs with any held photo         | 2/11                   | ≥ 5/11                                                                                                                          | ≥ 5/11                                 |
| generation share (mean)            | 0.57                   | ≤ 0.45                                                                                                                          | ≤ 0.42                                 |
| cells with ≥ 1 gap line            | 0 (not asked)          | ≥ 8/33; on boots-then-match, complex-i2v-trap and product-drop ≥ 2 of 3 repeats each; on real-footage and training-recap 0 of 3 | same                                   |
| clip items cast from a camera clip | 6 of 65                | ≤ 10% (nothing more to offer)                                                                                                   | **≥ 30%** (two per library, put first) |
| productItems                       | 0                      | 0 (no product picked)                                                                                                           | 0                                      |
| null rate                          | 0.00                   | 0.00                                                                                                                            | 0.00                                   |
| i2v items per plan                 | ~1.7                   | 1.0–2.0, unchanged                                                                                                              | unchanged                              |

Blind means, A against the diagnostic read (sd across repeats was 0.6–1.1, so anything under
+0.3 is inside the spread and will be called ambiguous):

| criterion                         | diagnostic | A predicted                                                  | which rule                           |
| --------------------------------- | ---------- | ------------------------------------------------------------ | ------------------------------------ |
| broll_earned                      | 3.41       | ≥ 4.0                                                        | rule 4 (every shot earns its place)  |
| stills_where_carried              | 3.45       | ≥ 4.0                                                        | rule 2                               |
| relevance                         | 3.81       | ≥ 4.1                                                        | rules 4, 7, 9                        |
| overall_mix                       | 3.66       | ≥ 4.0                                                        | rules 2 and 4, NOT rule 6 on its own |
| product_rules (product-drop only) | 1.0        | ≥ 3.0 — the plan declares the gap instead of inventing boots | rule 7 + gap line                    |
| real_clips_used                   | 4.28       | 4.0–4.5, unchanged in A; ≥ 4.3 in B                          | rule 3 / the listing                 |
| i2v_reserved                      | 4.03       | unchanged (± 0.3)                                            | rule 1 — already held                |

**Rules I expect to show NO independent movement, said now:** rule 1 (i2v simple — the baseline
already scores 4.03 and never i2v'd a sequence) and rule 6 (the mix expectation — the baseline
already mixes; any `overall_mix` gain will come from rules 2 and 4). If the reveal agrees, both
stay in the prompt as guard rails but are flagged as unmeasured, not defended.

**Named risk:** rule 4 generalised to clips may make the planner prune clips it should keep. If
`real_clips_used` falls below 3.9 in A, that is rule 4 overreaching and the wording narrows.

**Added mid-run, before any reveal (Adi, 2026-09-22):** arm A's b-roll count is near zero on every
cell so far, which looks like over-rotation — the `concept` brief (the tunnel walk, the
floodlights) and `announce` (the signing) contain b-roll that legitimately earns its place.
Prediction: those cells score LOWER on `overall_mix` and `relevance` than the fresh baseline's
equivalents. If the sheet confirms it, rule 4 gets a calibration pass — from "earns its place" to
a positive existence clause ("b-roll is welcome when it serves the brief's brand, product or
story; generic sport imagery never does") — and only the affected briefs are re-run (~$1), not all
three arms.

**Second prediction on record, mid-run (Adi, 2026-09-22):** arm A's plans are shorter — 2–4 items
against ~5 on the baseline. Items-per-plan under ~4 will cost `overall_mix`: `announce` and `hype`
cells at 3 or fewer items score below their fresh-baseline equivalents on mix even where
`relevance` improves. If the sheet confirms both over-rotations (the b-roll ban and the shrinkage),
the calibration is ONE move, not two: they share an omission-is-safe root, so the doctrine gets a
composition floor beside its restrictions — "a plan is a complete reel: typically 4–6 shots
covering an opening, the subject and a close; prefer improving a weak beat over deleting it;
atmospheric b-roll that serves the brief's feel counts as serving the brief." Rule 4's positive
clause folds into it rather than standing alone. Same targeted re-run economics: the affected
briefs only, ~$1–2.

## The three arms — auto metrics (2026-09-22; blind scores follow Adi's pass over the 99-cell sheet)

| metric                                       | first baseline | **F** baseline-fresh | **A** doctrine      | A predicted   | verdict                                                                                                    |
| -------------------------------------------- | -------------- | -------------------- | ------------------- | ------------- | ---------------------------------------------------------------------------------------------------------- |
| axesCoverage (mean)                          | 0.07           | 0.05                 | **0.79**            | ≥ 0.80        | missed by 0.01 — eleven-fold, one short of the line                                                        |
| cells with ≥ 1 clip without her              | 22/32          | 22/33                | **6/33**            | ≤ 11/33       | held                                                                                                       |
| briefs with any b-roll                       | 9/11           | 10/11                | **4/11**            | ≤ 6/11        | held — and over-rotated (Adi's prediction 1)                                                               |
| b-roll items per plan                        | 1.34           | 1.27                 | **0.18**            | ≤ 0.8         | held, far past it                                                                                          |
| briefs with any held photo                   | 2/11           | 3/11                 | **8/11** (18 items) | ≥ 5/11        | held                                                                                                       |
| generation share                             | 0.57           | 0.55                 | **0.39**            | ≤ 0.45        | held                                                                                                       |
| cells with ≥ 1 gap line                      | 0              | 0                    | **21/33**           | ≥ 8/33        | held                                                                                                       |
| gaps ≥ 2 of 3 on boots / trap / product-drop | —              | —                    | 3/3, 3/3, 3/3       | ≥ 2/3 each    | held                                                                                                       |
| gaps on real-footage / training-recap        | —              | —                    | 2/3, 3/3            | 0/3           | **missed** — and the lines are right: "you asked for real footage; the library only holds made-here clips" |
| clip items cast from a camera clip           | 6/65           | 8/71                 | **10/60 (17%)**     | ≤ 10%         | missed upward — every camera clip offered was used (3 briefs had one)                                      |
| items per plan                               | 5.16           | 5.03                 | **3.73**            | not predicted | shrinkage (Adi's prediction 2): announce 3/3/3, boots 2/2/2, trap 3/2/2                                    |
| i2v per plan                                 | 1.59           | 1.45                 | 1.18                | 1.0–2.0       | held                                                                                                       |
| null rate · null plans                       | 0.00 · 1       | 0.00 · 0             | 0.01 · 0            | 0.00          | one value outside the lists in 33 plans                                                                    |
| tokens in / out                              | 119k / 111k    | 122k / 115k          | 144k / 152k         | —             | the doctrine costs ~30% more thinking                                                                      |

Read from A's directions, before the blind pass: **no invented product anywhere** — not one direction
in 33 plans says "boots"; the three product-drop cells declare the gap ("no product photos of the
boots in the library") and plan around it. The ball-on-grass filler survives in product-drop as a
$0 clip on 2 of 3 cells even so. Concept kept one b-roll per repeat (the tunnel, the floodlights —
tied to the brief); hype dropped to zero. The gap lines read as an athlete would want them.

**Third pre-registration, before the sheet (Adi, 2026-09-22):** gaps declared on 21/33 is
over-rotation symptom #3, same omission-is-safe root. Prediction: cells whose gap line is
provenance commentary (`real-footage`, `training-recap` — the beat IS covered, just by made-here
material) score no better on `relevance` for having it, and the line reads as hedging. Calibration
for v2: a gap line fires only when a requested beat cannot be covered by ANYTHING in the library;
a provenance caveat is not a gap. A scoping clause on rule 8, folded into the same
composition-floor v2 pass. Still one targeted re-run.

### Arm B — doctrine on camera-first libraries (`doctrine-camera-first-2026-09-22-bff3140b84d4`, git b1ac2a5)

| metric                             | F            | A                   | **B**                                   | B predicted    | verdict                                                                                     |
| ---------------------------------- | ------------ | ------------------- | --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| clip items cast from a camera clip | 8/71 (11%)   | 10/60 (17%)         | **50/57 (88%)**                         | ≥ 30%          | held, far past it — every brief but thank-partner cast both camera clips                    |
| `real-footage`                     | 6 made-here  | 5 made-here + a gap | **3 camera, no gap**, all three repeats | —              | the provenance caveat disappears when the footage IS hers                                   |
| axesCoverage                       | 0.05         | 0.79                | 0.73                                    | ≥ 0.80         | missed                                                                                      |
| cells with ≥ 1 clip without her    | 22/33        | 6/33                | **2/33**                                | ≤ 11/33        | held                                                                                        |
| briefs with any b-roll · per plan  | 10/11 · 1.27 | 4/11 · 0.18         | 6/11 · 0.33                             | ≤ 6/11 · ≤ 0.8 | held; less over-rotated than A                                                              |
| briefs with any held photo         | 3/11         | 8/11                | 5/11 (13 items)                         | ≥ 5/11         | held                                                                                        |
| generation share                   | 0.55         | 0.39                | **0.37**                                | ≤ 0.42         | held                                                                                        |
| cells with ≥ 1 gap line            | 0            | 21/33               | **23/33** (≥ 2/3 on eight briefs)       | —              | symptom #3 again (Adi's third pre-registration)                                             |
| items per plan                     | 5.03         | 3.73                | **3.45**                                | —              | shrinkage, worse than A                                                                     |
| i2v per plan                       | 1.45         | 1.18                | 1.00                                    | unchanged      | dropped — with two camera clips per library, she is shown as footage more and animated less |
| null rate · null plans             | 0.00 · 0     | 0.01 · 0            | 0.00 · 0                                | 0.00           | held                                                                                        |
| tokens in / out                    | 122k / 115k  | 144k / 152k         | 145k / 148k                             | —              | —                                                                                           |

**The combined sheet:** `probe-out/plan-eval/sheets/three-arms/` — 99 cells from F, A and B behind
codes `P01…P99`, `scores.csv` to fill, `key.json` unlinked. Reveal:
`… --reveal probe-out/plan-eval/sheets/three-arms`.

## Reveal — the three arms, blind-scored (sheet of record, 2026-09-22; Adi's veto pass over a reviewer's reads)

99 cells, 0 unscored, 0 null plans. Full tables in `probe-out/plan-eval/sheets/three-arms/reveal.md`.

| criterion                    | **F** fresh baseline | **A** doctrine | **B** doctrine + camera-first | A predicted | verdict                                         |
| ---------------------------- | -------------------- | -------------- | ----------------------------- | ----------- | ----------------------------------------------- |
| broll_earned                 | 3.45                 | **4.73**       | 4.70                          | ≥ 4.0       | held, +1.3                                      |
| stills_where_carried         | 3.30                 | **4.00**       | 3.67                          | ≥ 4.0       | held, on the line                               |
| real_clips_used              | 4.24                 | **4.67**       | 4.58                          | unchanged   | moved up, +0.4                                  |
| product_rules (product-drop) | 1.00                 | 2.33           | **4.00**                      | ≥ 3.0       | A missed, B held                                |
| relevance                    | 3.85                 | 3.91           | 3.91                          | ≥ 4.1       | **missed** — inside the spread                  |
| overall_mix                  | 3.55                 | 3.61           | **3.27**                      | ≥ 4.0       | **missed** — flat in A, down in B               |
| i2v_reserved                 | 4.09                 | 4.09           | 4.27                          | unchanged   | held (rule 1: no independent movement, as said) |

Rules 1 and 6 showed no independent movement, as pre-registered. The two criteria that did not
move — mix and relevance — are exactly where the three pre-registered over-rotations land, and the
per-brief split says which:

| brief            | mix F → A → B          | relevance F → A → B    | what happened                                                                                                                                                                                 |
| ---------------- | ---------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| boots-then-match | 3.00 → **2.00** → 2.33 | 3.0 → 3.0 → 3.0        | shrinkage: 2 items + a gap, five of six doctrine cells (pre-reg 2)                                                                                                                            |
| announce         | 3.67 → 3.33 → **2.67** | 3.67 → 4.0 → 4.0       | shrinkage to 3 items; relevance up, mix down (pre-reg 1 + 2)                                                                                                                                  |
| concept          | 3.33 → 3.33 → 3.00     | **5.00** → 3.67 → 4.00 | gap MISFIRE: three cells refused the tunnel b-roll the brief asks for because "no photo of you in a tunnel" — b-roll needs no photo of her (new)                                              |
| training-recap   | **5.00** → 4.00 → 3.00 | 5.00 → 4.33 → 3.33     | provenance-caveat gaps read as hedging, and B shrank to camera-only (pre-reg 3)                                                                                                               |
| real-footage     | 4.33 → 4.33 → **2.67** | 4.0 → 4.0 → 3.67       | B: three camera clips and nothing else — right footage, too thin a board (pre-reg 2)                                                                                                          |
| hype             | 3.00 → 3.67 → **4.00** | 4.0 → 4.0 → 4.33       | pre-reg 1 NOT confirmed here: dropping hype's stock b-roll helped                                                                                                                             |
| product-drop     | 3.00 → 3.00 → **4.00** | 2.0 → 2.3 → **4.0**    | F fabricated boots (1/1/1); A captioned the rival-kit clip neutrally with gaps (2.33; one cell still "wearing the boots"); B cast her real cleats clip as the product with a gap line (4/4/4) |
| adidas-ad        | 3.67 → **4.67** → 4.00 | 4.0 → **5.0** → 4.67   | the device brief: fixed                                                                                                                                                                       |
| thank-partner    | 3.33 → **4.33** → 3.67 | 4.33 → 5.0 → 5.0       | held photo as sign-off                                                                                                                                                                        |
| day-in-life      | 4.33 → 4.33 → 4.00     | 4.33 → 4.33 → 4.0      | unchanged; one A cell and one F cell cast a basketball asset — a tagging miss, not doctrine                                                                                                   |
| complex-i2v-trap | 2.33 → 2.67 → 2.67     | 3.0 → 3.3 → 3.0        | A's held crossbar photo as "the top corner finish" was the best trap answer of the 99                                                                                                         |

**The cited cards, by arm:** the seven filler-clip leaks the read flagged (P08/36/45/50/71/94/97)
are **all F** — the doctrine's filler rate is 6/33 (A) and 2/33 (B), so rule 4's clip clause is
working and the leak is the baseline. The three fabricated-product cards are F; the three
"cleats as product" wins are B; the concept gap-misfires are A×2, B×1; the 2-item boots cards are
A×3, B×2; the creative wins (P49 crossbar hold, P48/P85 branded still as sign-off) are A; P10's
"no brand named" note is B.

**Calibration list for v2** (one pass, then a targeted re-run of the affected briefs only:
announce, boots-then-match, concept, training-recap, real-footage — 5 briefs × 3 × 1 arm ≈ $1):

1. **Composition floor** (pre-reg 2): a plan is a complete reel, typically 4–6 shots — an opening,
   the subject, a close; improve a weak beat rather than delete it.
2. **Gap scope** (pre-reg 3 + the concept misfire): a gap is declared only when neither her material
   nor legitimate b-roll can serve a requested beat; a provenance caveat is not a gap; b-roll
   needs no photo of her, so "no photo of you in a tunnel" is never a reason to skip the tunnel.
3. **Positive b-roll clause** (pre-reg 1): b-roll is welcome when it serves the brief's brand,
   product, story or feel; generic sport imagery never does. Hype says the ban helped; announce
   and concept say it over-rotated — the clause has to name the difference.
4. **Wrong-kit tightening** (P73): a clip whose brands name another brand is never captioned as
   wearing or using the promoted product — the caster already flags it; the prompt must say it
   harder, or the flag gates the direction.
5. **Positive examples in the rules:** hold her real crossbar photo for "the finish" (P49); hold a
   branded still as the campaign sign-off (P48/P85).
6. **Routed elsewhere:** the basketball asset cast into a soccer day-in-life (P31/P54) is a
   tag/similarity miss for the enrichment eval, not doctrine. Filler-clip naming is already in rule
   4 and measured working; no change.

**Camera-first listing (arm B):** ships. It is the only lever that moved `product_rules` past 3
and it put her real footage into every board — but on its own it makes boards thinner (mix 3.27),
which is calibration item 1's job, not a reason to hold it back.

## v2 — the calibration pass (pinned by Adi, 2026-09-22, before predictions)

**Builds on B.** B is the arm with the designed behaviour (product_rules 1.00 → 4.00, filler 2/33,
her cleats clip cast as the product) and the arm carrying the worst over-rotations (real-footage
mix 4.33 → 2.67; mix 3.27 under the baseline's 3.55). **Success criterion:** hold B's
product_rules and filler while recovering overall_mix to ≥ the baseline's 3.55 and real-footage
to ≥ A's 4.33. A fix that recovers mix by re-admitting filler or a fabricated product has failed.

The four wording changes, each pinned: (1) gap scope names the concept mechanism — generated
b-roll never requires her in the source material; a gap is only for a beat that needs HER and her
library cannot supply (P15/P74/P88 already did this in the same arm, so the clause licenses
existing behaviour); (2) composition floor, library-relative, no number — a complete reel given
what is available, improve a beat rather than delete it; (3) the positive b-roll clause is the
hype/announce split — hype improved when its decorative stock died, announce and concept lost
load-bearing atmosphere — so b-roll is licensed when it serves a named feel or brief-requested
imagery, never by default; (4) wrong-kit tightening (P73). Plus the P49/P48 patterns as positive
examples.

**Validity, recorded before the re-run:** this eval validates the doctrine for THIN libraries only
— 18–31 lines per brief, two camera clips in the whole library. Re-running the same eleven briefs
when real footage exists is a **standing card**, not optional.

**The re-run:** six briefs, n=3, camera-first libraries, one arm, 18 calls (~$1.2): the five Adi
named — concept (gap misfire), boots-then-match + announce + real-footage (shrinkage), hype (the
regression check that the positive clause does not re-admit its stock filler) — plus
**product-drop**, added so "hold product_rules" is measured rather than inferred (3 calls).
Scored blind against B's cells for the same six briefs: 36 cells, two runs, so the reveal's diff
applies.

### v2 predictions, per brief, against B — written before the prompt commit

| brief               | B                                                                                                     | v2 predicted                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| concept             | mix 3.00 · rel 4.00 · gaps on 3/3 cells ("no photo of you in a tunnel") · items 3.7 · b-roll 1.7/plan | mix ≥ 3.67 · rel ≥ 4.67 · gap cells ≤ 1/3 · items ≥ 4 · b-roll ≥ 1/plan, tunnel or rain named in it · broll_earned ≥ 4.3                                                                        |
| boots-then-match    | mix 2.33 · items 2.3 · gap "the game" 3/3 · broll_earned 5.0 · filler 0                               | mix ≥ 3.33 · items ≥ 4 · the gap STAYS 3/3 (it needs her) · broll_earned ≥ 4.5 (no net-ripple stand-in) · filler 0 · the camera cleats clip kept 3/3                                            |
| announce            | mix 2.67 · items 2.7 · b-roll 0/3 · gap "signing close-up" 2/3                                        | mix ≥ 3.67 · items ≥ 4 · b-roll in ≥ 2/3 cells (the signing, the atmosphere) · that gap ≤ 1/3 (b-roll can serve it) · broll_earned ≥ 4.5 · rel ≥ 4.0                                            |
| real-footage        | mix 2.67 · items 2.7 · clips 5.0 · all camera · b-roll 0 · gaps 0                                     | mix ≥ 4.33 (= A) · items ≥ 4 (beat cuts + held camera photos) · real_clips_used ≥ 4.67 · clip items 100% camera · b-roll 0/3 (the clause must not re-admit it here) · gaps 0 · gen share ≤ 0.25 |
| hype (regression)   | mix 4.00 · broll_earned 4.33 · b-roll 0.67/plan · filler cells 2/3                                    | mix ≥ 4.0 · broll_earned ≥ 4.3 · b-roll ≤ 0.67/plan, any b-roll names the crowd, the opener or the feel · filler cells ≤ 1/3                                                                    |
| product-drop (hold) | product 4.0 · mix 4.0 · items 3 · gap 3/3                                                             | product_rules ≥ 4.0 (cleats clip as the product 3/3) · mix ≥ 4.0 · items ≥ 4 · no direction says "boots" · no direction says she is wearing the promoted product                                |

Across the six: overall_mix **≥ 3.6** (B 3.11; baseline 3.55) · relevance ≥ 4.0 (B 3.83) · filler
cells ≤ 2/18 · items per plan ≥ 4.0 (B 3.2) · axesCoverage ≥ 0.7 (hold) · no invented product.
**Failed if** mix recovers with b-roll > 1/plan on real-footage, boots or product-drop, or filler >
2/18, or any fabricated product.

**Addendum, pinned by Adi before the prompt commit (point 7):** the predictions carry an expected
EARNED b-roll count per plan, and the re-run reports counts beside scores:

| brief                                          | B b-roll/plan | v2 predicted b-roll/plan                                                                                         |
| ---------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| announce                                       | 0.00          | **≥ 1** earned (the signing, the reveal's atmosphere), ≤ 2                                                       |
| concept                                        | 1.67          | **≥ 1** earned (tunnel, rain, floodlights), ≤ 2                                                                  |
| hype                                           | 0.67          | **≥ 1** earned (crowd, opener, the feel she named), ≤ 2 — and none of it the stock ball / net / bare floodlights |
| boots-then-match · real-footage · product-drop | 0             | 0 — b-roll here would be the failure condition                                                                   |

"Earned" is the judge's `broll_earned` on the cell, not the count: a count of 1 with broll_earned
≤ 3 is decoration re-admitted, not the clause working. **Camera-clip volume is OUT of the v2
criteria**: it is supply-capped until the upload enriches (the recorded sets hold two camera
clips; Adi counts three — the third is presumably the un-enriched upload, which the listing cannot
offer until it has been read as a clip).

### v2 re-run — auto metrics against the predictions (`doctrine-v2-2026-09-22-c22297e7616b`, git 5023f3a, 18 calls, tokens 82k / 71k; blind scores follow)

| brief               | items B → v2  | b-roll/plan B → v2                                             | gaps B → v2                                          | filler        | verdict on the auto half                                                                                                                           |
| ------------------- | ------------- | -------------------------------------------------------------- | ---------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| concept             | 3.7 → **4.3** | 1.67 → 2.0 (tunnel + rain, every cell)                         | 3/3 → **3/3**, still "no photo of you in the tunnel" | 0             | floor held; b-roll held; **gap scope MISSED** — the clause did not stop the hedge, though the b-roll is made every time                            |
| boots-then-match    | 2.3 → **4.0** | 0 → **1.0** (empty pitch, floodlights, touchline)              | 3/3 → 3/3 "the game" (correct)                       | 0             | floor held; gap right; **b-roll re-admitted as decoration** — predicted 0                                                                          |
| announce            | 2.7 → 3.3     | 0 → **1.0** (a pen on the contract — asked-for imagery)        | 3/3 → **1/3**                                        | 0             | b-roll earned as predicted; gap scope held; **floor short of 4**                                                                                   |
| real-footage        | 2.7 → 2.7     | 0 → 0                                                          | 0 → 0                                                | 0             | b-roll held at 0, gaps 0; **floor did not move it** — two camera clips and four photos is the ceiling, and the floor is library-relative by design |
| hype (regression)   | 4.7 → 4.3     | 0.67 → **1.33**: floodlights powering on ×3, a net rippling ×1 | 3/3 → 3/3                                            | 2/3 → **0/3** | filler held; **stock b-roll RE-ADMITTED** — the regression the check was for                                                                       |
| product-drop (hold) | 3 → **4**     | 0 → **1.0** (locker bench, tunnel, floodlights)                | 3/3 → 3/3                                            | 0             | no "boots" in any direction, the cleats clip cast 3/3, no wrong-kit caption — product hold looks intact; **b-roll re-admitted** — predicted 0      |

Across the six: items/plan 3.2 → **3.78** · filler cells **0/18** (held) · axes **0.81** (held) ·
gap cells 13/18 · generation share 0.35 → **0.51**.

**Read before the blind pass:** the composition floor did what it was for on three briefs, but it
paid for the extra items with b-roll by default — floodlights powering on appear in nine of the
eighteen plans. The positive clause ("welcome when it serves a feel she named") is being read as
"a night-match feel is always available", which is the decoration case the clause was written to
exclude. The gap-scope clause fixed announce and left concept's hedge in place. Whether mix and
relevance recovered is the judge's; the failure condition in the predictions ("recovers mix by
re-admitting filler or fabrication") is NOT tripped on filler clips or product (both held), but
the hype regression check is tripped on the auto count alone.

Sheet: `probe-out/plan-eval/sheets/v2-vs-b/` — 36 cells, v2 and B on the same six briefs.

### v2 reveal — 36 cells, v2 against B on the six briefs (2026-09-22). **The scorer had the key this round**: not blind.

| criterion        | B          | v2       | criterion             | verdict                                                                                            |
| ---------------- | ---------- | -------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| overall_mix      | 3.11       | **3.94** | ≥ 3.55 (the baseline) | held — recovered past it                                                                           |
| relevance        | 3.83       | **4.28** | —                     | up                                                                                                 |
| product_rules    | 4.83       | 4.83     | hold                  | held; zero fabrication, zero wrong-kit in 36 cells                                                 |
| real_clips_used  | 4.83       | 4.83     | hold                  | held                                                                                               |
| filler clips     | 2/18 cells | **0/18** | hold                  | held                                                                                               |
| broll_earned     | 4.39       | **4.17** | —                     | **the one regression**, concentrated where predicted                                               |
| real-footage mix | 3.33       | 3.33     | ≥ 4.33 (= A)          | **missed** — P05/P19 butt two whole clips together; the library's two camera clips are the ceiling |

Per brief, the reveal's own diff (B → v2, "moved" = past the repeat spread): boots-then-match mix
2.33 → 4.00 moved, relevance +0.67 moved, broll_earned 4.00 → 2.67 moved down; hype mix 3.00 →
4.00 moved, relevance +0.67 moved; announce broll_earned 4.00 → 5.00 moved, relevance +1.00 moved,
mix +1.00 inside a 1.15 spread; concept +1.00 mix and +0.67 relevance inside the spread;
product-drop broll_earned −1.00 inside the spread; real-footage flat.

**What the b-roll regression is:** where the brief names a feel, atmosphere stayed earned — hype
4.33 flat, concept 5.0 flat, announce up to 5.0 (P21/P36: the pen-on-contract b-roll MAKES the
signing instead of gapping it; P36 is the best plan of the whole eval). Where it does not,
floodlights arrive by default — boots-then-match (P29's boots-to-game bridge) and product-drop
(P16's floodlights say nothing about boots), the 9-of-18 pattern; P14's net ripple is baseline
stock back from the dead. The positive clause works when a feel is named and defaults to wallpaper
when it is not.

**Residual warts, for the ledger and the round-2 card, not v3:** the concept hedge survives
everywhere (gap lines on beats the b-roll covers; P31 declares the signing gap after making the
pen); P05/P19 still butt two whole clips on real-footage; P34 holds a photo in a clips-only brief.

**Decision (Adi): merge v2.** Floodlights-by-default and the residual hedge go on a
"doctrine round 2" card for Mia's taste loop — aesthetic warts, not trust failures — and the
libraries change under the doctrine the moment the third camera clip is re-enriched and its 51 s
of beats land (peer finding, 2026-09-22: the poster worker overwrote that asset's enrichment from
a stale read).

**Standing cards out of this eval:** (1) re-run the eleven briefs when real footage lands — this
eval validated thin libraries only; (2) doctrine round 2: floodlights-by-default, the residual
hedge, whole-clip butting on real-footage; (3) the gap lines reach the Agent screen (client);
(4) the basketball asset cast into a soccer day-in-life → the enrichment eval; (5) image-as-clip
(Ken Burns) as C1c, after doctrine.
