# PR-0 — model-native capability probe

Run 2026-09-09 evening. Athlete `3811cedd-ec59-44b0-b613-b39d03f9d5ca`. Model
`gemini-3-pro-image` (Nano Banana Pro) via **Vertex**, not fal — `routes()` sends `image.edit` to
Vertex by default and fal serves only SAM-3. **Total spend $5.0136** (51 router-logged calls),
against a $4–6 target and an $8 cap. Q1–Q4 came to $3.8144; Q5 added $1.1992.

> ⚠️ **That figure is router-logged spend only, and it is not the whole bill.** Region detection
> calls `genai()` directly (`studio/autoMask.ts:78`) instead of going through `studio/router`, so
> `recordGeneration` never sees it and it does not appear in `studio-cost-log.jsonl` at all. Roughly
> 8 detection calls ran across Q4 and Q5 — a flash-class model on a 1024px probe, so on the order of
> a cent in total, but unlogged rather than free. Anything that reports Studio spend from the cost
> log is under-reporting by this amount.

Scripts: `server/scripts/studioModelNativeProbe.ts` (Q1–Q3, direct router) and
`server/scripts/studioRimMatrixProbe.ts` (Q4, the real masked pipeline). Outputs in `probe-out/`.
**STATUS: FINAL.** Verdicts are **Adi's**, in the sweep's vocabulary (CLEAN / ARTIFACT / PARTIAL /
FAILED); the observations are the probe's and are deliberately not verdicts.

**All nine verdicted cells came back CLEAN** — Q1's six, Q2's one, Q3's two. Q4's eight cells were
**not** verdicted visually: its conclusion rests on the depth-band measurement below, and the rim
crops (`probe-out/q4-small-rim.jpg`, `probe-out/q4-large-rim.jpg`) remain open for a visual read.
That is the one claim in this memo standing on a number alone.

> **Amended 2026-09-10 (PR N, item N.1):** Q5L — the 4000px arm Q5 said it was owed, $1.6216 — and
> the **Routing decision** it closes, both placed after the `classify.ts:166` note below. Everything
> above that point is the original record, unchanged.

---

## Answered before any spend: the client takes two images

`adapters/vertex.ts:152-157` puts **every** reference into one `contents` turn as inline parts;
`adapters/openrouter.ts` does the same through `input_references`. Multi-image is wired on both
paths and needed no workaround.

The real constraint is **addressing, not count**. The provider has no typed reference field, so
`refOrder.ts` is load-bearing: `SLOT_ORDER = ["frame","character","object","style"]` makes position
the addressing scheme, and that is the only thing making "the second image" a true sentence. This
probe sets slots itself, so **Q1 measures the model and not sweep 7.2's role inversion** — a Q1 pass
does not make PR R optional.

---

## Q1 — two-image add-object. 6 cells, $0.806

| cell         | reference                          | object                               | placement         | out dims  | aspect Δ  | frame excess (3 patches) | verdict |
| ------------ | ---------------------------------- | ------------------------------------ | ----------------- | --------- | --------- | ------------------------ | ------- |
| q1-a         | ball, **700×700 square**           | present, **BOLYN legible**           | between cleats    | 2048×2048 | **46.4%** | 12.8 / 46.5 / 39.2       | CLEAN   |
| q1-b         | ball, square                       | present                              | at feet           | 2048×2048 | **46.4%** | 10.1 / 40.5 / 30.8       | CLEAN   |
| q1-c         | ball, square                       | present                              | beside right foot | 2048×2048 | **46.4%** | 12.2 / 41.1 / 37.8       | CLEAN   |
| q1-d         | **none**                           | present, **different invented ball** | at feet           | 1696×2496 | 0.5%      | 2.7 / 4.5 / 4.0          | CLEAN   |
| q1-e control | bottle, **1812×2720 portrait**     | present, **Gatorade G legible**      | on top of head    | 1696×2528 | 1.8%      | 2.3 / 4.2 / 4.3          | CLEAN   |
| q1-a-ratio   | ball, square, **ratio pinned 2:3** | present, **BOLYN legible**           | between cleats    | 1696×2528 | 1.8%      | 4.1 / 3.5 / **14.8**     | CLEAN   |

Resample floor 1.05–1.62 on every cell. "Excess" is mean-abs-diff above that floor, on three fixed
200×200 windows far from the insertion point.

**Observed.** Object present and placement obeyed in **6/6**, across four prepositions (between, at,
beside, on top of). The **positive control reproduced** — the bottle sits on her head, logo legible
— so the prompt shape is right and the other cells are not measuring a bad prompt.

The reference is genuinely consumed as an **object source**, not a style hint: BOLYN survives on the
ball, the Gatorade G on the bottle, and removing the reference (q1-d) yields a plausible but
**different** ball. Both work; only the reference reproduces _that_ object.

**Aspect ratio is a knob, not a property of the operation.** All three square-reference cells
returned square (46.4% Δ); the portrait reference and the no-reference cell held the frame within
2%. Pinning `aspectRatio: "2:3"` (`generationConfig.imageConfig.aspectRatio`, `vertex.ts:162-176`)
returned 1696×2528 with the ball and the wordmark intact. **One line fixes it.**

**Frame preservation is good where aspect is held** — excess 2.3–4.5 against a ~1.3 floor on q1-d
and q1-e, and 3.5–4.1 on two of three q1-a-ratio patches. The large numbers belong to the reframed
cells, where the same coordinates hold different content. The one number that resists this reading
is **q1-a-ratio's mid-left at 14.8**, on the advertising boards, with aspect held — worth one look
when verdicting.

> ⚠️ **Two measurement bugs were found and corrected mid-probe; both inflated these numbers.**
> (1) sharp does not chain `.resize()` — a second call replaces the first, so the resample control
> read exactly `0.000` everywhere and `excess` was a copy of `modelDiff`. (2) The sources are
> 4-channel PNGs and the outputs 3-channel; comparing raw buffers walked two strides down one index
> and produced large, stable, meaningless figures. Before the fix these cells read 52–79 excess
> **everywhere**, which supported the opposite conclusion. Corrected numbers came from re-analysing
> the **saved outputs** at zero extra cost — which is the argument for the script saving every
> output and for `--analyze` existing.

**All six CLEAN, including the three that reframed to square.** That is the verdict on quality, and
it settles something the numbers could not: the 46.4% reframe is not a _defect_. It remains a
frame-continuity change the product should make deliberately rather than inherit from whatever shape
a brand's product shot happens to be — a square reference silently squaring an athlete's portrait is
a surprise even when the picture is good.

**Recommendation: MODEL-NATIVE**, with the output ratio pinned from the source frame and identity
covered by PR Q.

## Q2 — background swap, model-native vs composite. 1 cell, $0.24

Source `a81be2c0` (4000×6000, orientation 8) — sweep 4.2's green-halo case.
Prompt: `change the background to a beach at sunset, keep the person exactly as-is`.

**Observed.** Beach at sunset applied. **No green halo. No border degradation.** Both sweep 4.2
defects are absent. Her pose, outfit (maroon Adidas bra, white shorts, maroon Copa cleats) and the
ball are preserved and recognisable.

The structural change is one the composite could never make: **the white goal net crossing the
entire foreground is gone.** Nothing asked for that. On the masked path it is impossible — the net
is outside the person mask, so it is preserved by construction; here it was simply not repainted.
That is the trade in one image: the composite cannot damage what it does not touch, and cannot
remove it either.

**Verdict: CLEAN.** Note what that means against sweep 4.2's ARTIFACT on the same source and the
same intent: the halo did not survive the move off the composite.

**Recommendation: MODEL-NATIVE for background**, gated on PR Q identity scoring. This is the
concrete answer to "generate over composite": the halo exits through this door.

## Q3 — compound edit in one call. 2 cells, $0.269

| cell | prompt                                       | observed                                                                                         | verdict |
| ---- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------- |
| q3-a | `make the jersey red and the shorts black`   | **both applied**; STANFORD, number 8, Nike swoosh, green armband all survive legibly             | CLEAN   |
| q3-b | `make the jersey red and add an adidas logo` | red jersey + **correct adidas three-bar mark and wordmark** on the chest; STANFORD and 8 survive | CLEAN   |

**Caveat on q3-a:** the source's shorts were already black, so only the jersey half was a real
change. It is the sweep's own 3.1 prompt, so the comparison holds, but it is a weaker multi-target
test than it looks. A cell with two genuinely different target colours would settle it.

**Note on q3-b:** the jersey's Nike swoosh was replaced by the adidas mark — correct — but the
**cleats and socks still carry Nike swooshes**. Mixed-brand output is a live NIL brand-safety case
and belongs in PR Q's logo-integrity check, not just "did the logo render".

**Both CLEAN**, with the mixed-brand cleats explicitly logged as **PR Q scope** rather than as a
defect of this cell.

**Recommendation: MODEL-NATIVE for compound recolor + design.** PR D′ shrinks accordingly.

## Q4 — rim deconfound, on the real masked pipeline. 8 cells, $1.3232 (+$1.3232 wasted, see below)

`change the socks to yellow` × {1008 src, 4000 src} × {band 0+3, 2+6}, n=2. Regions derived **once
per source and frozen** across both bands, so the band is the only variable. All 8 cells confirmed
`mask: ["used","used"]` with `maskEdgePx` exactly as forced.

Rim strength = mean change magnitude 1px inside the region boundary, as a percentage of the deep
interior — the same depth-band method `composite.ts` `defaultErodeFor` already uses. **Lower =
stronger rim** (more original garment surviving at the edge).

| source    | band | r1    | r2    | mean  |
| --------- | ---- | ----- | ----- | ----- |
| 1008×1476 | 0+3  | 70.9% | 66.3% | 68.6% |
| 1008×1476 | 2+6  | 58.1% | 70.9% | 64.5% |
| 4000×6000 | 0+3  | 85.6% | 97.4% | 91.5% |
| 4000×6000 | 2+6  | 86.8% | 81.6% | 84.2% |

**By source:** small 58.1–70.9 (mean 66.6), large 81.6–97.4 (mean 87.9). **The two ranges do not
overlap at all.**
**By band:** the within-source band gap is 4.1 points (small) and 7.3 points (large) — _smaller than
the repeat-to-repeat spread within a single cell_ (12.8 points on small 2+6; 11.8 on large 0+3).

**Verdict target answered: RESOLUTION tracks the rim. Band width does not.** This confirms what
sweep 1.3 suspected but explicitly could not conclude — and it is now the deconfounded version,
because the two cells that carry the argument (**small @ 2+6** and **large @ 0+3**) cannot occur on
shipped code at all.

**Why they cannot occur, mechanically:** the ramp is derived from the crop's own resample ratio via
`maskEdgeUncertaintyFor`, so band **is a function of** source resolution. Measured with the knob
unset: a small unresampled crop yields exactly `"0+3"` and a large resampled one exactly `"2+6"` —
i.e. sweep 1.3a and 1.3b were not two settings, they were one variable observed twice. Sweep 1.3
could not have separated them.

**n=2 earned its cost.** On a single run per cell, small-2+6 would have read 58.1% and looked like a
band effect; its repeat read 70.9%. Model variance on this path is larger than the band effect,
exactly as sweep 1.5a/1.5b (byte-identical masks, opposite outcomes) implied.

**Recommendation: the rim is a RESOLUTION problem, not a band problem.** PR X should not spend its
budget on band config.

---

## Q5 — recolor head-to-head, masked vs full-frame. 8 cells, $1.1992

The measurement the `classify.ts:166` note says it is waiting for. Source `afc78262` (1008×1476),
two prompts × two paths × n=2.

- **Path A** — the real masked pipeline at **shipped defaults**. Sweep flag parity forced, no band
  forcing (the erode override is explicitly deleted, and the ramp knob no longer exists).
- **Path B** — full-frame direct, ratio pinned `2:3`, with an explicit preservation clause:
  `…Keep everything else exactly as-is — change only the <garment>.`

> ⚠️ **THIS IS THE SMALL SOURCE, WHICH Q4 IDENTIFIED AS THE MASKED PATH'S WEAK ARM.** Every path-A
> cell composited at band `"0+3"`, which is the arm where Q4 measured the rim (small-source
> outer/interior 58–71% against large-source 82–97%). **A rim on path A here is the expected result
> of the source, not evidence that masking loses in general.** Do not read a masked loss on this
> frame as a verdict on the masked path; the 4000px arm was not run.

| cell       | path       | regions / label                                 | maskEdgePx  | cost    | latency | patch excess (3 windows) |
| ---------- | ---------- | ----------------------------------------------- | ----------- | ------- | ------- | ------------------------ |
| q5-p1-A-r1 | masked     | 1 · 320×99 · `"black and green shorts"`         | `0+3`       | $0.1654 | 23.8s   | **0 / 0 / 0**            |
| q5-p1-A-r2 | masked     | 1 · 320×99 · `"black and green shorts"`         | `0+3`       | $0.1654 | 36.0s   | **0 / 0 / 0**            |
| q5-p2-A-r1 | masked     | 2 · 107×300, 121×242 · `"blue and green socks"` | `0+3`,`0+3` | $0.1654 | 25.9s   | **0 / 0 / 0**            |
| q5-p2-A-r2 | masked     | 2 · same · `"blue and green socks"`             | `0+3`,`0+3` | $0.1654 | 34.8s   | **0 / 0 / 0**            |
| q5-p1-B-r1 | full-frame | —                                               | —           | $0.1344 | 33.2s   | 4.21 / 4.07 / 15.01      |
| q5-p1-B-r2 | full-frame | —                                               | —           | $0.1344 | 23.0s   | 4.26 / 4.10 / 14.81      |
| q5-p2-B-r1 | full-frame | —                                               | —           | $0.1344 | 27.7s   | 4.36 / 4.22 / 14.83      |
| q5-p2-B-r2 | full-frame | —                                               | —           | $0.1344 | 28.1s   | 4.40 / 3.99 / 14.80      |

Sheets: `q5-shorts.jpg`, `q5-socks.jpg` (full frames) and `q5-{shorts,socks}-zoom.jpg` (garment
boundary). Path B is aligned to the source grid before cropping so both arms zoom at one scale.

**Both colours applied.** Path B: 4/4. Path A: 3/4 — `q5-p2-A-r2` read "blue and green socks" as one
colour _per sock_ (one solid blue, one solid green) where `r1` striped both. Same frozen boxes, same
label; the split is model variance inside the crop, which is the same variance Q4 measured.

**Boundary at zoom.** Path A shows **a dark contour tracing the sock edge in both repeats** — the
rim, at band `0+3` on the small source, exactly where Q4 predicts it. Path B shows no rim; its
garment edges sit clean against skin and grass. **No rectangle edge, no hard region boundary and no
misaligned crop appeared on path B in any of the four runs.**

**Wordmark / number / swoosh.** STANFORD and the number 8 are legible in all eight. The paths differ
_inside_ the garment: on the shorts, **path A preserves the Stanford tree logo in its original red**,
while **path B renders it white-on-green and adds a green Nike swoosh that the source does not
have**. On the socks the reverse holds — path B preserves the white Nike swoosh cleanly. So neither
path is uniformly better on marks: A protects what it does not touch, B redraws marks that fall
inside the thing it was told to change.

**Face.** Unchanged at full-frame scale on both. On path A this is guaranteed rather than observed —
the face is outside every region and the composite pastes the original pixels.

**The leak test passed, exactly.** Path A's patch excess is **0.000 on every window of every run**,
not "near zero". That is the masked composite's pixel-identity contract holding literally: outside
the regions the output is the original. Path B's excess is 4.0–4.4 on two windows and a very stable
**~14.8–15.0** on the third — the advertising-board window at `40,502`, which read 14.8 on
`q1-a-ratio` too. That is a systematic property of the full-frame path on this frame, not noise:
four runs land within 0.2 of each other.

**Recommendation: INCONCLUSIVE-NEEDS-4000px-ARM.** The two paths did not fail in the same currency.
Masked buys a byte-exact frame and pays with a rim; full-frame buys a clean boundary and pays with a
repainted frame and redrawn in-garment marks. On _this_ source the rim is the known weak arm, so the
comparison is loaded against A. Rerun both arms on `5581e882` before anyone routes RECOLOR.

### The `classify.ts:166` falsification — SUPERSEDED, and not for the reason on offer

**Recorded outcome: superseded.** But the reason is neither "prompt quality" nor "ratio", and that
matters more than the label:

**The falsification never tested full-frame.** It ran with `STUDIO_GARMENT_MASK=false`, and that flag
does not select a path. `studio/config.ts` says so in its own docstring: _"the flag does not select
between two edit paths, it decides whether one extra ALPHA SOURCE is consulted"_, and _"every region
composites through the rectangle ramp it always did."_ So that run still cropped the region, still
sent a crop, and still pasted it back — with a **rectangle** alpha instead of a shape mask.

The three symptoms it recorded are precisely what a rectangle composite produces: _"visible rectangle
edges"_ is the rectangle; _"hard boundaries at the top of each region"_ is the paste seam; _"a
misaligned crop"_ is the crop. **None of them can occur on a path that never crops.** Path B ran the
whole frame through one call, four times, and produced none of them.

So the claim `RECOLOR: FULL_IMAGE is falsified` rests on evidence from a _different configuration_ —
masked-with-rectangle-alpha, which is a degraded MASKED, not FULL_IMAGE. The prompt and ratio
improvements in path B are real but secondary; the config difference alone is disqualifying.

**What this does and does not license.** It does **not** license moving the `RECOLOR` row to
`FULL_IMAGE`. Q5's own recommendation is INCONCLUSIVE pending the 4000px arm, and full-frame's costs
here are real and measured (a repainted frame, a recoloured team mark). It licenses exactly one
thing: **retiring the existing evidence**, so whoever wires path dispatch decides on Q5's numbers and
the 4000px rerun rather than on a measurement of something else. The note at `classify.ts:166` should
be amended to say the falsification was run on the rectangle-composite configuration — that edit is
**not made here**, because `classify.ts` is outside this probe's no-code-changes scope and the file
is currently being edited on another branch.

## Q5L — the owed 4000px arm. 8 cells, $1.6216

Run 2026-09-10 for PR N (item N.1), before any routing code. Source `5581e882` (4000×6000 JPEG;
white shorts, white ankle socks, adidas trefoil on the socks). Q5's two prompts × both paths × n=2,
and nothing else changed:

- **Path A** — the real masked pipeline at sweep flag parity, no band forcing. `assertMaskParity`
  refuses to spend if `garmentMaskEnabled()` reads false, and now also pins `STUDIO_NATIVE_EDIT`
  off. Every region reported `mask: "used"`.
- **Path B** — full-frame direct, Q5's prompt verbatim, `aspectRatio` pinned `2:3`.

`studioModelNativeProbe.ts --q 5L`; sheets from `--sheet 5L` — `probe-out/q5L-{shorts,socks}.jpg`
(full frames) and `q5L-{shorts,socks}-zoom.jpg` (garment boundary, every row cut from the same
source-grid window, full-frame outputs resized onto the source grid first).

**The one variable that moved without being chosen here is SIZE.** Path B derives `imageSize` from
the frame through `smallestImageSizeFor`, which is **4K** on a 24 MP frame where it was 2K on Q5's
1.5 MP one. 4K is also what the native edit path requests for a frame this size (PR N, D1), so this
arm measures the resolution the product would actually return — **3392×5056, 71% of the source's
pixels** — at $0.24 a call instead of $0.1344.

| cell        | path       | regions / label                                 | maskEdgePx  | cost    | latency | out dims  | patch excess (3 windows) | verdict   |
| ----------- | ---------- | ----------------------------------------------- | ----------- | ------- | ------- | --------- | ------------------------ | --------- |
| q5L-p1-A-r1 | masked     | 1 · 588×582 · `"black and green shorts"`        | `0+3`       | $0.1654 | 32.8s   | 4000×6000 | 0.043 / 0.042 / 0.114    | CLEAN-ish |
| q5L-p1-A-r2 | masked     | same                                            | `0+3`       | $0.1654 | 37.0s   | 4000×6000 | 0.043 / 0.042 / 0.114    | CLEAN-ish |
| q5L-p2-A-r1 | masked     | 2 · 200×198, 220×198 · `"blue and green socks"` | `2+6`,`2+6` | $0.1654 | 61.7s   | 4000×6000 | 0.043 / 0.042 / 0.114    | FAILED    |
| q5L-p2-A-r2 | masked     | same                                            | `2+6`,`2+6` | $0.1654 | 46.1s   | 4000×6000 | 0.043 / 0.042 / 0.114    | FAILED    |
| q5L-p1-B-r1 | full-frame | —                                               | —           | $0.2400 | 52.5s   | 3392×5056 | 4.03 / 4.35 / 8.36       | ACCEPTED  |
| q5L-p1-B-r2 | full-frame | —                                               | —           | $0.2400 | 45.3s   | 3392×5056 | 5.00 / 5.05 / 8.71       | ACCEPTED  |
| q5L-p2-B-r1 | full-frame | —                                               | —           | $0.2400 | 47.2s   | 3392×5056 | 5.27 / 4.14 / 8.51       | ACCEPTED  |
| q5L-p2-B-r2 | full-frame | —                                               | —           | $0.2400 | 62.4s   | 3392×5056 | 4.72 / 5.01 / 8.01       | ACCEPTED  |

**Verdicts are Adi's, verbatim in substance:**

- **Shorts, masked — CLEAN-ish.** Faithful recolour; seam line at zoom.
- **Shorts, full-frame — ACCEPTED.** Colours applied both runs; garment restyled, with run-to-run
  variance. Restyle-and-variance is **accepted as product behaviour** — an explicit decision,
  recorded in the Routing decision below, and **not** a pass.
- **Socks, masked — FAILED.** One blue sock and one green sock in both repeats — "blue and green"
  read as distributive. r1 also swapped the trefoil for a different adidas mark inside the mask.
- **Socks, full-frame — ACCEPTED.** Both socks patterned coherently, both runs.

`ACCEPTED` is deliberately not in the sweep's vocabulary: it records a decision about behaviour the
product will now ship, not the absence of an artifact.

**Observed** — the probe's, not verdicts:

- **The masked leak test reads 0.043 / 0.042 / 0.114, not Q5's exact 0.000, and that is the source
  format rather than a leak.** This frame is a JPEG, so the composite re-encodes it (`JPEG_LADDER`,
  max delta 4/255) and every untouched pixel carries that noise. The figures are identical across
  all four masked cells — which is what re-encoding the same untouched pixels produces, and what a
  leak would not. The script's leak threshold is 1.0.
- **A 4000px source did not buy the masked path its strong band.** The shorts composited at `0+3` —
  the same band as Q5's small-source cells — because that crop fit its render size without being
  resampled, and the band follows the crop's resample ratio (Q4's mechanism). The socks ran at
  `2+6`. The seam line Adi saw is on the shorts, at `0+3`, which is what Q4 predicts.
- **Masked, inside the mask:** Q5 saw the distributive sock split once (q5-p2-A-r2); here it is both
  repeats. The composite guarantees the pixels OUTSIDE the mask, and says nothing about what the
  model does inside it.
- **Full-frame restyled every garment it was asked to recolour.** Shorts: the hem cut changed to a
  curved split hem in both runs; r1 has an abstract print; r2 adds three-stripes and **an adidas
  logo on the leg the source does not have**. Socks: lengthened from ankle to crew in both runs,
  trefoil removed in both, and r2 kept a white base under blue and green bands. The `COPA` heel
  wordmark on the left boot is lost in both socks cells.
- **Scene lighting visibly shifted** on the full-frame cells (Adi). They ran Q5's prompt, which has
  no lighting or grade clause — see the preservation clause below.
- Full-frame held the pinned ratio on all four (3392×5056, aspect Δ 0.633%). Patch excess is
  4.0–5.3 on the two sky windows and 8.0–8.7 on the trees window at `160,2040` — the same shape as
  Q5 (4.0–4.4, and a stable ~14.8 on its boards window).

**Process.** Two path-B cells failed on the first invocation with a bare `fetch failed` while reading
the source out of storage — `storage.googleapis.com` was timing out from the machine while other
Google endpoints answered. It was before the model call, nothing billed, and the two cells were rerun
individually once storage answered. The four masked `media_assets` rows are in
`docs/probes/probe-cleanup-list.txt`.

## Routing decision

Recorded here, beside the retired `classify.ts:166` note, per the convention "Contradictions with
documented findings" states: the originals above are not overwritten.

**The decision.** All editing moves to Nano Pro full-frame — one call carrying the full source frame,
the references, and an instruction compiled from her classified intent — behind `STUDIO_NATIVE_EDIT`
(PR N). Adi's call, 2026-09-09, on the Q5 side-by-side.

**It was made on the small-source arm,** and that arm was loaded against masked: Q5 ran on the 1008px
frame Q4 had already measured as masked's weak one, and this memo recorded Q5 as
INCONCLUSIVE-NEEDS-4000px-ARM for exactly that reason.

**What the 4000px arm showed: full-frame holds** (Q5L above — full-frame ACCEPTED on both prompts;
masked CLEAN-ish on the shorts and FAILED on the socks). **Routing is therefore unconditional.** There
is no resolution threshold back to masked.

**Masked is not a clean fallback for multi-colour recolours.** Its own 4000px failures are the
distributive split ("blue and green socks" as one colour per sock, both repeats) and an in-mask mark
swap (r1's trefoil). The dormant stack's guarantee is pixel-identity outside the mask; it is no
guarantee about the edit itself.

**EXPLICIT DECISION — restyle and run-to-run variance are accepted as product behaviour.** Not a
pass. On every full-frame cell the colours landed and the garment itself was redesigned — cut,
print, length, marks — and differently each run. Adi accepts that as what a native edit does. It
changes what "edit" promises on kit content, where the garment a brand paid for is the point.
**→ Mia check-in item.**

**PERMANENT RULE — explicit spatial intent routes masked; linguistic intent routes native.** A box
she drew is an instruction about which pixels change, and the native path has nowhere to put it —
it would discard her box and re-render the frame. So a drawn box keeps the masked path, with the flag
on or off. That is the masked stack's ongoing job description, not a transitional carve-out. (The same
rule the generate route already states for inference versus an explicit action.)

**REQUIRED-BUT-UNVALIDATED — the preservation clause.** The native compiler's prompt carries a
mandatory clause directing that the source's lighting, exposure, contrast, colour grade and scene be
kept unless her request is itself about them — a named constant in `studio/nativeEdit.ts`, and the
seed template CD inherits. It is required because Q5L's full-frame cells visibly shifted scene
lighting. It is **unvalidated** because those cells ran Q5's prompt, without it. Nothing tonight
measures it; **sweep #2 does**.

**NAMED UNTESTED GAP — brand art direction on a full-frame edit.** A brand-tagged edit sends the
brand's cover and gallery imagery into the style slot, whose manifest line reads "reference for
colour, light, styling and composition". On masked that reached one crop. On full-frame it can
restyle the whole photograph. Nothing has measured it, and sweep #2 has no brand. **→ a sweep #3
cell, or a constraint on CD** — decided before brand-tagged edits go flag-on, not discovered after.

**Resolution, measured.** A 24 MP source requested at 4K returns 3392×5056 (71% of its pixels) for
$0.24; at 2K it would be ~1696×2528 (18%) for $0.1344. The native path requests
`smallestImageSizeFor(source)` (PR N, D1), and PR N's N.3 puts the tier and both sets of dimensions
on the generation record.

**Backlog.** "Restyle" as its own named operation, so the accepted behaviour eventually has a front
door rather than arriving as a side effect of a recolour. Colour-phrase and per-target value
extraction in the classifier (PR N's option C) — CD's territory.

### Resolution rule (PR N, N.3) — accept, record, and tell her before she pays

**The rule: accept.** A native edit is the model's canvas at the tier `smallestImageSizeFor(source
pixels)` picks — 4K for anything over ~16.8 MP. A 4000×6000 frame comes back 3392×5056 (Q5L,
measured on all four full-frame cells). No threshold routes large sources back to masked; Q5L is why.

**It is never a surprise, in two places:**

- **She sees it before she pays.** A native preview whose tier returns fewer pixels than her photo
  carries a `degraded` warning — "An edit comes back at about 17 megapixels, and your photo is 24 —
  so the edited version will be smaller than the original." Information, not a refusal: the preview
  stays ready.
- **The record carries all three numbers.** Source dimensions in `generation_jobs.brief.job.source`
  (frozen, as always); the tier in `generation_jobs.brief.job.editIntent.imageSize` (frozen with the
  intent, so the size that ran is the size she was quoted); the output's **measured** dimensions on
  its `media_assets` row. The adapter stamps dimensions from the request, which names none for an
  edit, so before N.3 a native output's row carried nulls. The job's closing log line carries all
  three side by side.

The $0.1344-versus-$0.24 fidelity split is therefore one join away for the pricing conversation:

```sql
SELECT j.id,
       j.brief -> 'job' -> 'editIntent' ->> 'imageSize'    AS tier,
       (j.brief -> 'job' -> 'source' ->> 'width')::int      AS source_w,
       (j.brief -> 'job' -> 'source' ->> 'height')::int     AS source_h,
       a.width  AS output_w,
       a.height AS output_h,
       j.cost_estimated_usd
FROM   generation_jobs j
JOIN   media_assets    a ON a.generation_job_id = j.id
WHERE  j.athlete_id = $1
  AND  j.brief -> 'job' ? 'editIntent';
```

(Pinned in `server/routes/studio.native.test.ts` against real Postgres: tier `4K`, source
4000×6000, output 3392×5056.)

**The follow-up lever is output-side upscaling** — the parked upscaling request, now with a measured
reason. Named here; not built.

## Downstream implications

| item                         | what the probe says                                                                                                   | what changes                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PR C′ (ADD_OBJECT, thin)** | Insertion + placement 6/6; reference reproduces the specific object; frame held within ~4 excess when ratio is pinned | **Thin survives.** No relational detection, no geometric place-finding, no SAM. Add: pin `aspectRatio` from the source frame — without it a square product shot silently squares the output. The old large PR C is **not** needed. |
| **PR R (reference roles)**   | Slots set server-side made "the second image" work first try                                                          | **Unchanged and still required.** Q1 bypassed the 7.2 inversion rather than testing it; `object` must become a real role, and ENGINE_ROLE should map it to "the object to insert".                                                 |
| **Background path**          | No halo, no border damage, likeness held; but the goal net was removed unasked                                        | **Move to model-native**, behind PR Q. The 4.2 green halo and 4.3 borders exit through this door and leave PR X's scope.                                                                                                           |
| **PR X (rim)**               | Resolution separates cleanly; band does not, and is dominated by model variance                                       | **Scope narrows to the small-source arm** — minimum-source-size handling or output-side SR. Do **not** spend on band config, and the parked ~1px dilation stays parked: it is a band lever, and band is not what moves this.       |
| **PR D′ (orchestrator)**     | Compound recolor + design succeeded in one call, wordmark intact                                                      | **Shrinks substantially.** Chain only where masked precision is genuinely required; a single full-frame call covers the multi-part cases the masked path failed.                                                                   |
| **PR Q (creative QA)**       | Nothing outside the edit is pixel-guaranteed on any model-native path; mixed-brand output observed                    | **Elevated, as the roadmap already argues.** Identity distance is the precondition for every recommendation above. Add **logo/brand-conflict** to its scope: q3-b shipped adidas on the jersey and Nike on the boots.              |

---

## Contradictions with documented findings

Recorded here rather than overwriting the originals, per the `classify.ts:166` convention.

1. **Sweep 3.1 — "multi-target FAILED, wordmark and number destroyed."** True on the **masked**
   path. On full-frame, q3-a applied both changes with STANFORD, the 8, the swoosh and the armband
   intact. The sweep's diagnosis (labels collapsing to bare values, A.1) is about the masked
   directive and is untouched by this; the _operation_ is not the thing that was failing.

2. **Sweep 2.4 — "add an adidas logo FAILED."** Failed masked. Succeeded full-frame (q3-b), with a
   correctly-formed mark.

3. **Sweep 4.2 — "green halo, borders cooked."** Both are **artifacts of the composite's inversion
   band**, not of background replacement. Neither reproduced model-native. The sweep already named
   the mechanism (`maskEdgePx "3+9"` — "on the inversion arm that band is exactly where the old
   background survives"); this confirms it by removing the band.

4. **Sweep 1.3 — "resolution tracks the visible outcome; band width does not… not conclusive."**
   Now conclusive, and in the same direction. Upgrade from suspicion to measurement.

5. **`classify.ts:166` — full-image falsified FOR RECOLOR.** **Not contradicted, and not extended.**
   Q3 is a recolor _plus_ a second operation on a frame with no drawn box, which is a different
   trade from the one that falsification measured. The two Q3 cells are not grounds to move the
   `RECOLOR` row to `FULL_IMAGE`; that row still needs its own measurement against a masked run on
   the same frame. Nothing here licenses that move.

---

## Process notes

- **$1.3232 was spent answering the wrong question.** The first Q4 run had every studio flag off, so
  the composite took the rectangle fallback — `mask: ["off","off"]`, `maskEdgePx: []`. The runs
  succeeded and returned plausible recoloured images, which is exactly why nothing caught it. The
  sweep states its flag set in its own header. `studioRimMatrixProbe.ts` now forces sweep parity
  in-process and **refuses to spend** if `garmentMaskEnabled()` reads false.
- **The band knob is reverted.** `STUDIO_MASK_RAMP_PX` was a temporary read in `maskEdgeFor`;
  `server/studio/composite.ts` is back to its shipped form (`git diff` clean, 116 mask tests green).
  The rim script's header records how to re-apply it. It is deliberately not kept: a live env var
  that silently rewrites mask geometry is a footgun aimed at the composite's only-subtracts
  guarantee.
- **16 `media_assets` rows** were created under this athlete (8 flagless + 8 real), all tagged in
  `docs/probes/probe-cleanup-list.txt` for the media-tile cleanup.
- **Both measurement bugs were caught by disbelieving a number, not by a test.** The resample
  control reading exactly `0.000` and the rim box selecting the entire frame were each impossible
  results that happened to look plausible in a table. The `--analyze` mode exists so that correcting
  an instrument costs nothing.
