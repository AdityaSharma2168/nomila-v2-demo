# PROBE — does a first frame in the clip's shape hold her better? (A/B, product path)

> **RUN 2026-09-20. $6.40 quoted, four cells, all 8s.** Design and predictions below were written
> before any cell existed and are unchanged; **RESULTS are at the end.** The headline is not the one
> the probe was designed to find: **the as-stored path letterboxes the whole clip.** The identity
> half is a PILOT, not a verdict — its blinding was broken, its stranger control could not be run
> (no stranger exists in the library), and the write-up says how.

## The question

Every identity result we have was measured on frames the bake-off harness had already centre-cropped
to 720x1280. The product path sends her photograph as stored (2:3, typically) beside a 9:16 request.
`video/firstFrame.ts` (8847ed7, 3846164) makes the product path crop first. Does that change what
comes back — in composition, and in whether it is still her?

## Cells

Product path, in-process: `assembleBrief → previewGeneration → savePreview → queue → videoTick`.
Not the bake-off harness — the point is the path that ships. Veo 3.1 (`veo-3.1-generate-001`), 8s,
9:16, audio off, `identity-static` template, ONE direction sentence shared by every cell.

⚠️ **No shared seed.** The first draft of this said "same seed within a pair". The product path has
no seed — the planner never sets `inputs.seed` — and adding one to make the probe tidier would make
it not the product path. So A and B differ by the crop AND by sampling noise, at n=1. That is the
strongest reason to read a small difference here as nothing.

| cell | first frame | switch |
|---|---|---|
| F1-A | medium-face photo, as stored | `STUDIO_VIDEO_FRAME_CROP=false` |
| F1-B | same photo, cropped to 9:16 | default |
| F2-A | small-face photo, as stored | `STUDIO_VIDEO_FRAME_CROP=false` |
| F2-B | same photo, cropped to 9:16 | default |

Frames come from the curated one-woman cluster (the maroon kit), picked BY EYE via `--dump` — never
by an embedding distance, which has ranked a faceless crop as the best cell before. F1's face is
≥10% of frame height; F2's is 5–8%, at the floor where by-eye judgment starts to fail. Asset ids go
in the run manifest; no name, handle or path goes in this file or any commit.

Cell C (crop + asset reference images) is NOT in the design: references are reported 16:9-only and
mutually exclusive with a first frame (secondhand — see the ledger). Not runnable for a vertical clip.

## ⚠️ Pre-flight — two things that void a cell silently, found while planning the harness

**1 · Someone else's runner can take the job.** A clip on the product path is QUEUED and worked by
`videoTick`, which claims the oldest queued video job in the database — any athlete's, from any
process. `/api/internal/studio-video-tick` is not gated by `STUDIO_VIDEO_ENABLED`. If a Cloud
Scheduler job points a deployed service at that endpoint against the database this probe writes to,
it can claim a probe job in the window between queue and tick and run it on DEPLOYED code — which
has no crop. Cell B becomes cell A, is billed, and nothing errors.

**Confirmed clear, 2026-09-20:** Adi listed the schedulers — no `studio-video-tick` job exists on
dev or prod, so this process is the only claimant and cell isolation holds (ledger D6 records the
ungated endpoint as a flip-checklist decision). The harness DETECTS it anyway, because the check is
free: the first frame is captured at the wire from the `:predictLongRunning` body THIS process
sent, and a cell with no such capture is VOID — its spend is counted and the run stops. (An earlier
draft also checked the row's lease holder; the runner clears the lease on success, so there is
nothing to read afterwards. The wire capture is the proof.)

**2 · 8 seconds needs PR-0.** On main a clip's duration never reaches the run (quoted 8s, run at the
4s default). The harness is built on a branch with `studio/video-duration-on-brief` merged in, and
asserts after each cell that the clip's probed duration is 8s ± 0.5 — a 4s clip is a void cell, not
a cheaper one.

## What is saved, per cell

1. **The bytes that left** — the exact first-frame buffer handed to `submit`, written to disk before
   the call. A cell whose sent bytes were not saved is void, not "probably fine".
2. The compiled prompt, the request parameters, the operation name, the quote, and the cost-log row.
3. The clip, and five frames from it at 0 / 25 / 50 / 75 / 100% of its length.
4. The $0 greyscale drift curve (`video/frames.ts`). **Embedding distances are recorded if QA is on
   and are never used as a bar** — the ruler has failed its controls three times (a stranger scores
   inside her own band; it tracks framing; it tracks backdrop colour).

Spend is counted BEFORE anything that can throw. A download failure after a billed submit is a
recorded loss, never a silent retry.

## The instruments

**I1 · Composition ($0, mechanical).** Resize the SENT frame to the clip's dimensions; greyscale
mean-absolute difference against the clip's frame 0. This measures how far the model moved the
opening composition from what it was handed. It is a statement about framing and says nothing about
identity.

**I2 · Is it her (by eye, blind).** One judge — Adi. Each trial shows a REFERENCE photograph and a
five-frame STRIP, and asks: *same woman — yes / no / can't tell.* The reference is a different
photograph of her than the clip's first frame (same first frame would make it a test of clothing and
backdrop). Strips are labelled with a hash; the key is sealed in a file the judge does not open
until every answer is written down.

**I3 · Which is more like her (by eye, blind, paired).** Per frame, strips A and B side by side, left
and right randomised: *left / right / no difference.*

## ⚠️ The stranger control — and the cheapest honest version of it

Without a negative, "B looks more like her than A" has no anchor: a judge who says "yes, her" to
everything produces the same sheet as one who can tell.

**Proposed, $0: mismatched-reference trials.** The same four strips are shown again, each beside a
reference photograph of a DIFFERENT woman — from the same library's other clusters, similar kit,
which makes it a hard negative rather than an easy one. Eight I2 trials in all, four matched and four
mismatched, shuffled together; the judge does not know the split.

What it proves and what it does not, said plainly: it measures whether the JUDGMENT discriminates —
the anchor asked for. It does not measure whether the PIPELINE drifts a face toward a generic one,
because every strip is still generated from her. The paid version of that is one more cell (**S**: a
different woman's photograph as the first frame, cropped, $1.60 → $8.00 total, `--cap 8.10`), judged
against HER reference. Recommended: run the $0 control; add S only if the $0 control passes and the
A/B result is interesting enough to defend.

**The control's bar, fixed now:** the judge must answer "no" on at least 3 of the 4 mismatched
trials. Two or more "yes"/"can't tell" on mismatched trials voids I2 and I3 — the result is then
"by-eye judgment at this face size does not discriminate", which is itself worth $6.40 to know.

## Predictions — dated 2026-09-20, before any cell

| # | prediction | confidence |
|---|---|---|
| P1 | Cell A does NOT come back letterboxed with bars; Veo re-composes or crops the 2:3 frame to fill 9:16. | 70% |
| P2 | I1: frame-0 difference is lower in B than in A, for both frames. | 80% |
| P3 | I2, matched: the judge says "yes" to all four strips on F1; at most one "can't tell" on F2. | 65% |
| P4 | I3 on F1 (medium face): "no difference". | 60% |
| P5 | I3 on F2 (small face): B preferred. | 55% |
| P6 | The stranger control passes (≥3 of 4 "no"). | 75% |
| P7 | Overall: the crop's visible effect is on COMPOSITION, and its effect on identity is small or nil. V2b held 3/3 on cropped frames, and nothing has ever shown the uncropped path failing. | 60% |

What would change the plan: P2 false means Veo already handles the mismatch gracefully and lever 1
is cosmetic. P5 true with P6 passing is the first evidence for a face lever on the product path. P6
failing voids the by-eye half and says the next dollar goes to an instrument, not a lever.

## n, and what this cannot show

n = 1 per cell. This can find a large effect and cannot rank a small one. A null here is "no large
effect at n=1", not "no effect".

---

# RESULTS — run 2026-09-20

Jobs: F1-A `15333692` · F1-B `c62aa8fc` · F2-A `bd4d1f36` · F2-B `6c0e1446`. Veo 3.1, 8s, 720x1280,
quoted $6.4000. Every cell has its sent frame captured at the wire and a probed duration of 8s; none
is void. Both B cells logged `outcome: "cropped"`. Sent frames: A went out 3:4 (1056x1408,
1106x1518), B went out 9:16 (792x1408, 854x1518).

## 1 · HEADLINE — the as-stored path letterboxes the entire clip

Handed a 3:4 photograph and asked for 9:16, Veo does not crop, stretch or re-compose. **It pads the
photograph into the frame with black bars and holds the bars for all eight seconds.**

Measured two ways, both $0 and neither by eye:

| cell | frame 0 vs the SENT frame, fitted three ways (greyscale mean abs. diff, 180x320) | best fit |
| ---- | -------------------------------------------------------------------------------- | -------- |
| F1-A | stretched 0.2556 · cropped 0.3709 · **padded 0.0072**                            | padded   |
| F2-A | stretched 0.2700 · cropped 0.3142 · **padded 0.0166**                            | padded   |
| F1-B | 0.0059 all three (already the clip's shape)                                      | —        |
| F2-B | 0.0122 all three                                                                 | —        |

| cell | mean luminance (0–255) of the top 10% · middle 10% · bottom 10%, at frames 0 / 2 / 4 |
| ---- | ------------------------------------------------------------------------------------ |
| F1-A | 0.8 · 133 · 0.7 — 0.7 · 144 · 0.5 — 0.8 · 139 · 0.6                                  |
| F2-A | 0.9 · 179 · 0.9 — 0.9 · 179 · 0.8 — 0.9 · 179 · 0.9                                  |
| F1-B | 175 · 149 · 84 — 177 · 148 · 82 — 179 · 147 · 80                                     |
| F2-B | 219 · 161 · 218 — 219 · 161 · 218 — 219 · 162 · 218                                  |

A luminance under 1 across a full-width band, at the first, middle and last frame, is a black bar.

**What this means for the product.** Before #534, every clip made from a photograph that was not
already 9:16 — which is nearly all of her library — came back with black bars top and bottom. Nobody
had seen it because every earlier identity result came from the bake-off harness, which pre-cropped
its frames. This is the "measured path vs shipped path" gap the crop was built to close, and it turns
out the gap was a visible defect, not a subtle one. **Lever 1 is not cosmetic; it removes a defect a
viewer sees in the first frame.** It stands on this alone, whatever it does or does not do for
identity.

It also means the as-stored path gives her less of the frame: A's picture is 720x960 inside the bars,
B's fills 720x1280, so the crop hands her face ~33% more linear resolution. That advantage is
structural — it holds on every photograph, not only these two.

## 2 · The identity half — A PILOT, and its blinding was broken

**I3, paired A-vs-B, judged by Adi, recorded before the key was opened** (answers sha `38be8831…`;
key sha `bfd5433e…`, published before judging and verified before opening):

| sheet  | pair             | his answer | which was           |
| ------ | ---------------- | ---------- | ------------------- |
| 34F423 | F2 — small face  | BOTTOM     | **F2-B, cropped**   |
| D61C82 | F1 — medium face | TOP        | **F1-A, as stored** |

One each.

### ⚠️ The unblinding, in full

1. **The bars gave the cell away.** One strip on each sheet was letterboxed. The judge knows the crop
   is the thing that removes bars, so he could tell which strip was A without the key. The
   instructions warned about FRAMING differences; they did not anticipate bars, because the author
   predicted (P1, 70%) that Veo would fill the frame. The instrument was designed around a wrong
   belief about what the control cell would look like. I3 is UNBLINDED. The split argues against a
   simple pro-crop bias — he chose the barred strip once — but that is an argument, not blinding.
2. **The $0 stranger control could never have been blind with this judge.** A mismatched trial shows
   a different woman's reference beside a strip; a judge who knows every strip was generated from
   her can answer "no" from the design, without looking. The design doc proposed Adi as the single
   judge for I2 and the control both. That was a flaw in the design, caught after the run and before
   the trial, and it is why I2 moved to a naive judge.
3. **The sealed key was overwritten once, by the author, after judging.** A sanity-check of the sheet
   builder ran it without its mode argument; it defaulted to I3 and replaced the key. The key's
   contents and sha256 were already on record, so it was rebuilt byte-for-byte and re-verified
   against the published hash (`bfd5433e…` — match), and the builder now refuses to run without a
   mode or to overwrite any key. No judgment was affected: the answers were recorded and hashed
   first. It is here because a results doc that omits how its own evidence was handled is not one.
4. **n = 1 per cell, and no shared seed** — the product path has none. A and B differ by the crop AND
   by sampling noise. The medium-face preference for A is unexplained and is exactly the size of
   effect this design cannot distinguish from noise.

### What can be said

On the small face, the crop was preferred, consistent with the 33% resolution advantage above. On
the medium face, the as-stored clip was preferred, for no reason this probe can give. **Nothing here
supports a claim that the crop improves OR harms identity.**

## 3 · I2 and the stranger control — PILOT NOT RUN: no valid control available

Restated by Adi after the unblinding — B strips only, a naive judge, BOTH stranger trials answered
"no" or I2 is void, a pilot either way — and then **parked by Adi before any sheet was built**, for a
reason that is itself a finding:

**Every usable photograph in the dump is her. There is no stranger in this library to use.** The
control as designed needs a same-library hard negative: a different woman, photographed the way she
is, in similar kit, so that the only thing separating a matched trial from a mismatched one is WHO is
in the reference. The alternative — an external photograph of some other woman — breaks the
same-presentation rule this probe has just paid to learn (§5): a reference that differs in camera,
light, crop and kit is separable from hers on presentation alone, and a judge who says "no" to it has
told us nothing about whether they can tell two faces apart.

So I2 was not run, and the honest status of the identity question after this probe is:

- **No identity instrument in this repo has ever passed a negative control.** The embedding ruler
  failed three (a stranger inside her own band; it tracks framing; it tracks backdrop colour). The
  by-eye instrument has now failed to OBTAIN one.
- **A valid stranger control needs material that does not exist yet** — a consented second subject
  photographed to the same presentation, or the paid cell S from the design (a different woman's
  photograph as the FIRST FRAME, $1.60), which has the same sourcing problem one step earlier.
- Until one exists, a claim of the form "X holds her identity better than Y" cannot be supported by
  anything we own. That is a constraint on every future face lever, not only this one.

⚠️ A note for whoever picks this up: session memory records this athlete's library as holding several
different women. Adi's determination, looking at the 18 most recent uploads the `--dump` wrote, is
that every USABLE one is her. Both can be true — the dump is `origin = 'upload'`, images only, newest
40 — but do not assume a stranger is available without looking again.

## 4 · Predictions, scored

| #   | prediction                                          | conf. | result                                                                                                                                                                     |
| --- | --------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | A does NOT come back letterboxed                    | 70%   | **WRONG.** Barred for all 8s. The most confident prediction, and the one the instrument's blinding silently depended on.                                                   |
| P2  | I1: frame-0 difference lower in B, both frames      | 80%   | Right AS WRITTEN (sent frame stretched to the clip: 0.256 vs 0.006, 0.270 vs 0.012). The honest reading is different: Veo preserved the sent pixels in both, and padded A. |
| P3  | I2 matched: "yes" on F1, ≤1 "can't tell" on F2      | 65%   | Not run — no valid control (§3).                                                                                                                                                 |
| P4  | I3 on F1: no difference                             | 60%   | **WRONG.** A preferred.                                                                                                                                                    |
| P5  | I3 on F2: B preferred                               | 55%   | Right.                                                                                                                                                                     |
| P6  | stranger control passes                             | 75%   | Not run — no valid control (§3).                                                                                                                                                 |
| P7  | the effect is on COMPOSITION; identity small or nil | 60%   | Composition: right, and far larger than expected. Identity: unresolved.                                                                                                    |

## 5 · For whoever builds the next identity instrument

**NORMALIZE PRESENTATION BEFORE ANY STRIP IS SHOWN.** A strip must not carry anything that identifies
its cell other than the thing being judged. Concretely, and before a single sheet is rendered:

- **Bars removed or matched.** Detect letterboxing mechanically (a full-width band under ~2/255
  luminance) and either crop every strip to its active picture area, or pad every strip identically.
  This probe's I3 died here.
- **Field of view matched.** If two cells frame her differently by design, crop both to the FACE
  REGION at the same pixel size, so the judge compares faces and cannot read the framing.
- **Look at one frame of the CONTROL cell before designing the sheets.** The blinding here rested on
  a prediction about what cell A would look like. One dry frame would have falsified it for $1.60
  less than it cost to find out.
- **The judge of a negative control must not know the design.** If every positive is generated from
  one person and the judge knows it, a mismatched trial is answerable without looking.
- **A sealed key is written once.** The builder refuses a second write; keep it that way, and publish
  the key's hash before judging so a restore can be proven.
- **Embedding distances stay recorded-never-used** until one passes a stranger control. None has.
