# Kling first-and-last: does it BRIDGE two arbitrary frames, or only hold a turn?

**Status:** written 2026-09-20, **BEFORE the run.** Predictions in §4 are dated ahead of the result on
purpose. Nothing in this file is edited after `--run` except §6, which is the result section.

**Spend:** dry run is the default and costs $0. `--run --cap <usd>` is the only thing that bills.
The quote is **$2.5200** and the expected invoice is **$1.6800**. They differ on purpose and §5 says
why; the cap to pass is **`--cap 2.59`**.

**Referenced by name before it existed:** `server/scripts/studioKlingModeration.ts:20` — "If you want to
know whether Kling holds a face, that is a different probe with a different design (see
docs/probes/kling-first-last.md)." This is that probe.

---

## 1. The question, and why the moderation probe did not answer it

`studioKlingModeration` (2026-09-19, 4/4 accepted, $2.0160) asked whether Kling's route **takes** a real
athlete's photograph as a first frame. It does — 5 of 5 across four photographs, counting the V5 recon
cell. That is a moderation finding and it is the only thing it may be read as; its own header says so.

**It sent no last frame.** Every cell was ordinary image-to-video with one anchor, so nothing in it
speaks to the thing V10 is for:

> Given frame A and frame B, does Kling produce a clip that STARTS at A and ARRIVES at B — or does it
> produce a clip that starts at A and ignores B?

That is the whole load-bearing question under `videoRouteFor("transition")`. The route, the price and the
type are already in place and unreachable; `shotTypeFor` cannot return `transition`, `plannedInputs` never
sets `GenerationInputs.lastFrame`, and `videoPromptFor("transition")` is a deliberate refusal. If Kling
does not honour a last frame, all of that stays parked and card 2 has no engine.

### Why "only the turn" is a real possibility and not a strawman

V2b's turn-and-return cell held identity 3/3 with **no last frame at all** — a first frame plus a prompt
describing a turn was enough. So a clip that appears to "arrive" somewhere may be the PROMPT arriving,
not the frame. A probe that only tests a turn cannot tell those apart, and would license first-last on
evidence that never touched `frame_images[1]`.

⚠️ **THE DISCRIMINATING CELL IS THEREFORE THE ONE WHERE THE PROMPT CANNOT DO THE WORK.** Two frames far
enough apart that no sentence bridges them by luck, and a prompt that names no destination.

---

## 2. What is measured, and what may not be concluded

**Measured:** how close the clip's FINAL frame is to the supplied frame B, against how close its final
frame is to A. Both are mean pixel distance on a downscaled grid — `driftCurve`'s arithmetic
(`server/studio/video/frames.ts`), which is $0, already in-repo, and already used this way by video QA.

**⚠️ NOT MEASURED, AND NO CELL MAY BE READ AS EVIDENCE ABOUT IT: identity.** The project has no identity
number. `qa/identity.ts` carries `DEAD_RULER_CAVEAT` because multimodalembedding@001 scored an invented
person at 0.3584 inside her own same-person band of 0.3158–0.4186, and a later curated run put a stranger
at 0.304 against a 0.3158 floor — the metric tracks framing, not faces
(`stranger-scores-below-her-own-band`). Whether Kling holds her face across a bridge is a separate
question with no instrument, and nothing here may stand in for it.

**⚠️ ALSO NOT MEASURED: quality, and cost-per-second against Veo.** One is a judgement, the other is
already in the price table.

### The arithmetic, stated before the run

For each cell: extract the clip's last frame, and compute `d(last, B)` and `d(last, A)` on the
`DRIFT_WIDTH x DRIFT_HEIGHT` grid frames.ts already uses.

- **`arrived`** iff `d(last, B) < d(last, A)`. The clip ended nearer where it was told to end than
  where it began.
- **`ratio` = `d(last, B) / d(A, B)`** — how far it closed the gap it was given. `d(A, B)` is the
  control distance and is computed on the two INPUTS, free, before any call.

⚠️ **`arrived` IS THE VERDICT AND `ratio` IS COLOUR.** A threshold on `ratio` would be a bar invented on
the day, on an instrument with no calibration for this task — the mistake
`stranger-scores-below-her-own-band` is written down to prevent. The comparison against `d(last, A)` is
sound because both terms come off the same clip on the same grid.

---

## 3. The cells — four, chosen BY EYE

⚠️ **The cells were chosen twice by a number and both times it was the wrong instrument.** That is the
most transferable thing in this document, so it is recorded rather than quietly fixed.

### ⚠️ d(A,B) measures backdrop colour. It cannot select a pair.

A first set was picked from subject matter and its gaps came out inverted. The fix attempted was to
pick from measured `d(A,B)` instead — a number beats an impression. Measured, that is false:

| pair                     | what they actually are                             | `d(A,B)`  |
| ------------------------ | -------------------------------------------------- | --------- |
| `77146781` ↔ `3b9be374` | **same shoot** — same field, same net, same outfit | **0.316** |
| `3b9be374` ↔ `37df2f85` | field → an indoor branded backdrop                 | 0.301     |
| `3b9be374` ↔ `7fe0b609` | field → a white studio sweep                       | **0.281** |

**A same-scene pair scores farther apart than two different-scene pairs.** Within-shoot distances span
**0.174–0.405**; cross-shoot distances span **0.281–0.504**. The ranges overlap almost entirely and no
threshold separates them. The grid tracks how much green versus white is in the frame — the same
lesson `qa/identity.ts` carries for its own ruler and `stranger-scores-below-her-own-band` carries for
framing, arriving here in a third costume.

**⚠️ And it is blind to whether there is a subject at all.** The pair the metric ranked as the best
possible `c2`, and which was one keystroke from being bought, had a first frame with **no face in
it** — a detail crop ending at the chin. It ranked widest because it was neither green nor white. A
bridge from that to a portrait is an image morph; the number it returned would have said nothing about
the feature. A second metric-chosen frame was a wide action shot with the face at roughly 3% of frame
height, below the judgement floor `generate-identity-probe` records.

**An earlier explanation, also wrong, also worth keeping:** the inversion was first blamed on the 9:16
cover crop discarding 62.5% of a 6000x4000 landscape's width. False — those files are stored
`orientation=8`, so `.rotate()` makes them 4000x6000 **portrait** before the crop and **84.4%** of the
width survives. `--pairs` prints per-frame retention so that claim is checkable rather than believable.

### The corrected posture

**Selection is an eye judgement.** `--dump` writes the exact 720x1280 bytes a cell would send into
gitignored `probe-out/`, and every frame below was looked at. `d` is **reported as a recorded fact and
justifies nothing**. c1 and c2 now sit 0.015 apart, which is fine: they differ by what they ARE.

`--dump` exists because `--confirm-pairs` was otherwise a gate nobody could satisfy — `prepareFrame`
holds its bytes in memory and only `pairs.json` was ever written. A confirmation that cannot be
checked is worse than none, because the only way past it is to wave it through.

### The set

| cell               | A → B                                                                               | `d`   | what it rules out                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| `c1-same-scene`    | seated → standing, one shoot, one outfit, the same net behind both; two clear faces | 0.316 | the floor. A bridge the prompt could plausibly manage alone; if even this fails the feature does not exist.       |
| `c2-far-apart`     | outdoor field → indoor branded backdrop, different kit; front-facing arrival face   | 0.301 | **THE DISCRIMINATOR.** No sentence in the prompt names this destination, so arrival is the last frame doing work. |
| `c3-identical`     | a duplicate upload, two DISTINCT rows                                               | 0.000 | **THE INSTRUMENT.** A zero gap that must close.                                                                   |
| `c4-no-last-frame` | c2's A and B, **`lastFrame` omitted**                                               | 0.301 | **THE PROMPT.** The only difference from c2 is the field under test.                                              |

**c2's arrival frame is the clearest front-facing face in the library, not the most dramatic backdrop
change.** The white-studio alternative is full-body, so its face is small, and it was only ever
preferred for backdrop contrast — which is precisely the noise `d` turned out to be measuring. Trading
contrast for a clear face to arrive AT is the right way round.

**c3 is two distinct rows, not one asset id twice.** Same zero gap, but the request carries two rows,
two signed urls and a `lastFrame` from a row of its own; the same-id form could be short-circuited and
read as a pass it had not earned.

**⚠️ c2 and c4 still need same-woman confirmation.** Both frames were looked at and read as one
person, but this library is 3+ different people (`athlete-library-is-several-women`) and that call is
Adi's — `--run` refuses without `--confirm-pairs`.

**One prompt across all four, naming no destination**, so the prompt cannot confound the reading.
**5 seconds** — Kling allows 3..15; 5 is the shortest that leaves a bridge room, at $0.42/cell.

## 4. Predictions, written before the run

| cell               | prediction          | confidence | reasoning                                                                                                                                                                                                                            |
| ------------------ | ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `c1-same-scene`    | **ARRIVE**          | high       | `supported_frame_images: ["first_frame","last_frame"]` is advertised per-model and was re-read from `GET /api/v1/videos/models` on 2026-09-18. A short hop is the easiest thing a first-last model does.                             |
| `c2-far-apart`     | **ARRIVE**          | **low**    | The genuine unknown. Kling may interpolate a scene change, or may treat B as a soft hint and drift back toward A's backdrop.                                                                                                         |
| `c3-identical`     | ARRIVE, `ratio` ≈ 0 | high       | Instrument check. A surprise here invalidates the other three.                                                                                                                                                                       |
| `c4-no-last-frame` | **NOT ARRIVE**      | medium     | If this arrives, `frame_images[1]` is not what moved c2 and the whole reading collapses. Medium because a prompt-free clip may simply end near its own start, which `arrived` would read as "not arrived at B" for the right reason. |

**Overall shape predicted:** c1 and c3 arrive, c4 does not, and **c2 is the finding either way.**

---

## 5. Spend, and the guards

### ⚠️ The quote and the invoice are different numbers, and the cap goes above the QUOTE

|                  |                                                         |
| ---------------- | ------------------------------------------------------- |
| quote ceiling    | **$2.5200** — 4 x 5s x **$0.126**/s, the with-audio SKU |
| expected invoice | **$1.6800** — 4 x 5s x **$0.084**/s, the audio-off arm  |
| `--cap`          | **2.59**                                                |

`assertBudget` refuses against the **quote**, never against what a cell is expected to bill. So a cap set
from the expected invoice is a cap that buys two cells and throws on the third — which is exactly what the
`--cap 1.75` an earlier draft of this section asked for would have done, and what the dry run caught before
anything was bought.

**Why the quote is the dearer arm on purpose.** `openrouterAdapter.estimate` always quotes the audio arm for
a model that has one, so an unverified `generate_audio` flag can never under-quote. That gate is worth more
than a tidy headline: under-quoting is the one direction a pre-generation check exists to prevent, so this
probe keeps it rather than flattening `usdWithAudio` out of the override to make its own number smaller.

**The audio-off arm is verified, which is why the INVOICE line can be stated at all.** All four moderation
cells invoiced exactly `6s x $0.084` — the first Kling invoices this account has seen — so
`generate_audio: false` is honoured and $0.084/s is real. With the flag unset, OpenRouter's documented
default would have bought the $0.126 arm.

**The same shape as the moderation probe**, which quoted a $3.0240 ceiling and billed $2.0160. Coming in
under the ceiling is the expected outcome, not a surprise.

House rules this follows, each one a scar:

- **Dry run is the default.** `--run` is the only thing that spends, `--cap` refuses BEFORE each call,
  cumulatively, and `maxJobUsd()` applies on top.
- **⚠️ COUNT THE MONEY BEFORE ANYTHING THAT CAN THROW.** V2 billed $5.6007 while its counter read $0.00,
  because the download threw first.
- **⚠️ DOWNLOAD WITH THE BEARER.** `unsigned_urls` are authenticated `/api/v1/videos/{id}/content`
  endpoints; a bare fetch gets 401 and the V2 bake-off lost all seven of its billed clips that way.
- **Read the balance before the first call** and refuse if it cannot cover the quote.
- **Predictions dated ahead of the result** — §4, above, and not edited after.

---

## 6. Verdict gate, agreed before the run

- **c1 and c3 arrive, c4 does not, and c2 ARRIVES** → the last frame is load-bearing on arbitrary pairs.
  Kling first-last is wired, and card 2's ladder proceeds as planned.
- **c1 and c3 arrive, c4 does not, and c2 does NOT arrive** → Kling bridges only NEAR pairs. That is a
  real feature and a narrower one: a transition between two clips of the same scene. Card 2 ships with a
  same-scene precondition, or does not ship.
- **c4 arrives** → the prompt was doing the work; `frame_images[1]` is unproven whatever c2 did. Nothing
  is wired, and the probe is redesigned before anything else is bought.
- **c3's `ratio` is not near zero** → the instrument is wrong. No cell is read at all.

The count is reported. **The decision is Adi's.**

## 7. Result — RUN 2026-09-20, $1.6800 invoiced

**The last frame is load-bearing on an arbitrary pair.** All four cells generated; nothing refused.

| cell               | predicted  | `d(last,B)` | `d(last,A)` | ratio     | read                                              |
| ------------------ | ---------- | ----------- | ----------- | --------- | ------------------------------------------------- |
| `c1-same-scene`    | arrive     | **0.079**   | 0.315       | 0.250     | ✅ ARRIVED                                        |
| `c2-far-apart`     | arrive     | **0.017**   | 0.302       | **0.056** | ✅ ARRIVED, and by the widest margin of the run   |
| `c3-identical`     | arrive     | **0.005**   | 0.005       | n/a       | ✅ held the target — **but see the defect below** |
| `c4-no-last-frame` | not-arrive | 0.307       | **0.123**   | **1.020** | 🛑 did not arrive, exactly as predicted           |

### ⚠️ The control is the whole finding

`c2` and `c4` are **the same first frame, the same target, the same prompt, the same duration**. The
only difference between them is whether `frame_images[1]` was sent.

- **with** a last frame: the clip ended **0.017** from B — ratio **0.056**, having closed 94% of the gap.
- **without** it: the clip ended **0.307** from B — ratio **1.020**, having closed _none_ of it, and sat
  0.123 from its own first frame, which is simply where a 5s clip drifts to on its own.

**An 18x difference in ratio on a one-field change.** V2b's worry — that a turn-and-return "arrives"
because the prompt said so — is answered: this prompt names no destination, and without the field the
clip goes nowhere near B. `frame_images[1]` is doing the work.

`c4`'s 0.123 is also a useful free number in its own right: **that is how far an unconstrained 5s Kling
clip wanders from its own first frame.** Every other reading here is against that scale.

### ⚠️ c3 exposed a defect in this probe's own verdict, not in the model

`c3` reported **"did not arrive"** and that verdict is meaningless. With A and B the same image,
`d(last,A)` and `d(last,B)` are **the same number** — 0.005 and 0.005 — so the strict `dLastB < dLastA`
is false however well the clip performed. **The cell could never pass.** A tautology, printed as a
failure, on the one cell whose job is to validate the instrument.

What c3 actually measured is a **pass, and a strong one**: told to end where it began, the clip ended
**0.005** from the target against a free drift of **0.123** — roughly 25x stiller than a clip left to
its own devices. Its mp4 is **922 KB** against 7–13 MB for the other three, which is the same fact
arriving independently through the encoder: almost nothing moved.

Fixed after the run, and deliberately not before it: `arrived` is now **null** for an identical pair,
and the instrument gate compares c3's distance-from-target against the free drift **measured in the
same run** rather than against a threshold invented on the day. The numbers above are what the run
printed; no figure has been restated.

### Two observations, recorded not concluded

1. **The hard cell beat the easy one.** c2 (cross-scene, ratio 0.056) landed nearer its target than c1
   (same-shoot, ratio 0.250). Whether a larger visual gap gives the model a clearer instruction, or
   whether c2's target is simply an easier frame to land on, this probe cannot say — one cell each.
2. **`generate_audio: false` honoured again.** Four invoices at exactly `$0.42 = 5s x $0.084`. Eight
   real Kling invoices now, all on the audio-off arm.

### Spend

|                  |                                                            |
| ---------------- | ---------------------------------------------------------- |
| quote ceiling    | $2.5200                                                    |
| **invoiced**     | **$1.6800** — 4 x $0.42, `basis: "reported"` on every cell |
| under ceiling by | $0.8400, as §5 predicted                                   |

All four clips downloaded and stored — the bearer header held, no 401s.

### ⚠️ What this does NOT establish

**Nothing about identity.** No clip here may be read for whether her face survives a bridge; there is
no instrument for that (§2). The metric that produced every number above is the same one §3 shows
cannot tell a same-scene pair from a cross-scene one — it is sound for _this_ comparison because both
terms come off the same clip on the same grid, and sound for nothing wider.

**Nothing about quality.** Whether these bridges look good is unexamined.

**One pair per condition.** c2 is a single cell. The finding is that the field is load-bearing, not a
characterisation of how well it bridges across the space of possible pairs.

### Gate

§6's first branch: **c1 and c2 arrived, c4 did not, and c3 held its target.** Kling first-last can be
wired, and card 2's ladder proceeds as planned.

**The count is reported. The decision is Adi's.**
