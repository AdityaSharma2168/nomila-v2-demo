# Framing, identity language, and a stranger baseline — three probes

Three measurements, no product code. The gate Adi set was wave A merged first: it is in as
**#497 → `2dc602e`**, and every compiled prompt below is compiled on that commit, in a worktree off it
(`studio/probe-framing-identity`).

| probe | question                                                                     | state                                                                           |
| ----- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1     | do unmasked native edits reframe inside the pinned aspect?                   | **1a ANSWERED at $0.** 1b (the ×4/×4 repeats) is pre-registered below, unspent  |
| 2     | does a canonical identity block (G.2) beat today's compiled generate prompt? | designed, compiled, **unspent** — and its INPUTS are now in doubt (see probe 0) |
| 3     | what does a production stranger score against her library?                   | designed, **unspent**; needs a curated held-out set, see probe 0                |

Everything in "probe 0" below was found for $0 while building the harnesses, and it is the most
important thing in this document.

---

## Probe 0 — the free finding: the test library is several different women

Not a design decision and not a fixture: `athletes/3811cedd…` holds 17 uploaded photographs, and by
eye they are **at least three different people**. The contact sheet is
`out/pack/montage.jpg` in this session's scratchpad (not committed — real faces).

- a Stanford #8 kit (2 photographs),
- a teal media-day kit (2, near-duplicates of each other),
- a maroon adidas soccer player (7 photographs) — the largest cluster,
- and **one press photograph of a well-known track athlete**, whose surname is printed across the
  bib she is wearing in the frame.

### What that voids, and what it explains

**R1's `bound3` pack was two photographs of one woman and one of another.**
`docs/probes/reference-packs.md` records the pack as `e58f3a5a, 25499d98, b2d6edcd`; the last two are
the maroon-kit player and the first is the track athlete. The block the pack ships with says _"three
photographs of the SAME person — her — … They show ONE person, not three."_ On that pack the sentence
was false.

**The single-reference "stranger, 6/6" was not a prompt failure at all.** That arm's one reference
_was_ a photograph of someone else, so a render of someone else is the correct output for the request
that was sent. The plan's best-available explanation — an outlier photograph, a small face in frame,
a model "falling back to a generic female-soccer-athlete prior" — is not needed: the arm asked for a
different woman and got her. The recorded caveat "⚠️ the single-reference failures are not random:
across two runs the outlier produced the SAME stranger — a woman about a decade older, with braids"
is the same woman as the reference, described.

**The invented surname is text leakage from a reference, not invention.** The defects PR records
_"the model invents a surname — the name is in NO prompt"_, which is true and incomplete: the name is
in the **request**, printed on the bib in that reference photograph. `2 of 4` one-reference action
frames printed it and `0 of 2` three-reference frames did, which is what dilution across three images
looks like. The `TEXT AND NAMES` line asks the model not to write names; nothing yet notices that a
person reference _contains_ legible text.

**R0.b's identity set for this athlete is not one person either.** `identityTargetsFor`'s rule
(non-generated, `athlete_present`, prominence ≥ 0.5, most prominent first, 4 of them) selects
`5581e882, 7fe0b609, e58f3a5a, 25499d98` on this row — three different women. Production is
observation-only so nothing downstream moves, but any future ruler "calibrated on her own
photographs" would be calibrated against a mixed set.

### What it does NOT void

R1's _build_ — the collapse into one block, the angle-sentence deletion, the cap, the downscale, the
picker copy — rests on the corpus diff, the revert checks and the goldens, and all of those are $0
proofs about prompt assembly. They are untouched. What moves is the **acceptance narrative**: the
claim "one good photograph of her is enough; what failed was one specific photograph" is now better
explained as "that photograph is of someone else".

### The card this files

**Reference hygiene, and it is not ours to fix.** A person reference carrying legible text leaks that
text onto the output, and a "You" tile can hold a photograph of somebody else entirely — today only
copy says otherwise (`reference-packs.md`, "Nothing verifies whose face is in a photograph"). For a
commercial product the second half is a publicity-rights problem, not a quality one. Proposal for
Mia, blast radius stated, no code: (a) the advisory pack-consistency check R1 item 4(c) already
describes, now with a reason to exist; (b) a note that a reference with a name on it will print it.
**Out of scope here** — the fix is in shared reference handling, not in Mila's own code.

---

## The instrument (probe 1, both halves)

Ratio is not the question: `compile/aspect.ts` pins `imageConfig.aspectRatio` from the frame, and the
2026-09-09 probe already settled that a square reference squares the output. **A same-ratio zoom or
pan has to be detectable**, so the measurement is the similarity transform that best aligns the output
to the source — content scale and translation — by normalized cross-correlation on Sobel gradient
magnitude, coarse-to-fine, at a 288px canvas. Pure `sharp` plus arithmetic: no model call, $0.
(`measure.ts`; the two sharp traps the 2026-09-09 probe recorded — chained `.resize()` and mismatched
channel counts — are avoided by resizing once per plane and reading raw single-channel bytes.)

Reported per pair: `scale` (>1 ⇒ the output's content is LARGER, i.e. zoomed in), the shift as a
fraction of the frame, the peak NCC, and the NCC at the identity transform.

**Calibration, on synthetic transforms of a real frame of hers** (`measure.control.ts`):

| truth             | measured                                  |
| ----------------- | ----------------------------------------- |
| identity          | scale 1.000, shift 0.000/0.000, ncc 1.000 |
| zoom +5%          | **1.050**, 0.000/0.000                    |
| zoom +12%         | **1.120**, 0.000/0.000                    |
| zoom −8%          | **0.920**, 0.000/0.000                    |
| pan +3% x         | 1.000, **−0.031**/0.000                   |
| pan −5% y         | 1.000, 0.000/**+0.050**                   |
| zoom +8% + pan 2% | **1.080**, **−0.019/−0.019**              |

Scale recovers exactly, shift recovers to 0.1% with the sign inverted (the measurement says where the
source's content went, not where the crop window moved). Identity reads exactly 1.000/0/0.

**Each pair also gets its own no-reframe control.** A snapped canvas cannot be a pure similarity
transform of the frame: `nearestAspect` turns a 0.6829 frame into a 2:3 ask that returns 0.6709, so
something is cropped or padded, and a render that reframed NOTHING still measures ~0.5–1% off. So the
source itself is re-rendered at the output's exact dimensions under both no-reframe conventions
(`cover` = keep scale, crop; `contain` = keep everything, pad), measured by the same instrument, and
the verdict is read off the **difference** (`snapBaselines`). That control is what turns a systematic
0.993 into Δscale 1.002.

**Pre-registered verdict rule** (written before any of the numbers below):
a cell **reframed** iff `|Δscale − 1| ≥ 0.02` or `|Δshift| ≥ 0.01` of the frame, against its own
baseline. The instrument's floor is 1.000 on identity and its observed residual across 30 real pairs
is Δscale 1.0025, so the threshold sits ~8× above the floor.

---

## Probe 1a — the reframe rate on native edits SHE HAS ALREADY PAID FOR ($0)

Her library holds **86 native-edit outputs with the frame they edited** (`generation_jobs.brief ->
job -> editIntent IS NOT NULL`, output `derived_from_asset_id` present). Thirty of them froze exactly
one of the two operations the card names. That is a bigger n than the ×4/×4 the card asks for, on
production renders, for nothing.

| path                |   n | reframed | Δscale median | max \|Δscale−1\| | max \|Δshift\| |
| ------------------- | --: | -------: | ------------: | ---------------: | -------------: |
| `ADD_OBJECT`        |  18 |    **1** |        1.0025 |       **0.1018** |     **0.0443** |
| `CHANGE_BACKGROUND` |  12 |    **0** |        1.0025 |           0.0076 |         0.0059 |

**The one positive.** `2379cd65` — _"add the gatorade bottle on top of my head"_ — came back with its
content **10% smaller** (Δscale 0.898) and pushed **4.4% down** the frame: the model zoomed out and
panned to make room above her head for the thing it was asked to put there. NCC at the identity
transform is 0.081 and 0.901 at the recovered transform, so this is not a marginal reading.

**The same sentence shape did not do it twice.** `91d0bfdc` and `45090c2c` are the same "on top of my
head" add on a different frame, and both measure Δscale 1.000, shift 0.000/0.000, ncc 0.97. So the
reframe is neither a property of the operation nor of the sentence — it is a property of a cell, and
of whether the thing being added has room in the frame it is given.

**A nineteenth add arrived mid-session, from the running app.** `f226a375` — "add the hoops in image 2
to my ears", made by the product while this probe was being built — measures Δscale 1.0025, Δshift
0.0059: no reframe. It is counted above.

**Backgrounds never moved the frame.** Twelve cells, max 0.76% scale and 0.59% shift, including two
pairs whose source ratio already matched the output canvas exactly (3392x5056 → 3392x5056): those read
1.000/0.000/0.000. A background edit's absolute NCC is low (0.28–0.75) because most edges in the frame
are genuinely replaced, but the peak sits at the identity transform, which is the question being
asked.

**A free by-product: the aspect snap itself costs content.** On a 0.6829 frame asked for 2:3, the
raw fit is 0.993 with a 0.6% downward shift, and the `contain` baseline reproduces it — so ~1% of the
frame's height is being given up to the snap, by our own choice of canvas, on every edit of a photo
whose ratio is not one of the eight the model accepts. Not a reframe and not a defect; a number worth
having before anyone writes a framing clause.

### Verdict on the cards

- **The QA framing check: DIES for backgrounds, LIVES in a narrow form for adds.** 0/12 backgrounds,
  1/18 adds, and the one positive is exactly the case a check could catch cheaply (content bounds,
  measurable with no model call — this instrument is ~5s of CPU per image).
- **A blanket framing clause in the preservation block: NOT authorized.** 29 of 30 renders already
  hold the frame without one, and the native preservation clause it would join already says _"Keep
  everything else exactly as-is"_ and _"Keep the original photograph's … scene exactly as they are."_
  Adding a sentence that 29 of 30 cells obey anyway is the kind of prompt growth this codebase's own
  compile tier exists to resist.
- **What IS authorized is narrower and cheaper**: a framing line on the ADD template only, and only
  once 1b shows the reframe reproduces on a fixed cell. See the pre-registration below.

---

## Probe 1b — RAN (the add arm). The reframe is not variance; it is the cell

**Spend: 4 image calls, $0.5376 on the cost log**, of the 8 authorized. The background arm never ran
— see below — so half the cap went unspent.

**4 of 4 reframed**, and tightly:

| cell  | asset      |     Δscale |     Δdx |         Δdy |   ncc |
| ----- | ---------- | ---------: | ------: | ----------: | ----: |
| add.1 | `1708cdb0` | **0.8931** | +0.0035 | **+0.0481** | 0.702 |
| add.2 | `eb4bd2b6` | **0.8931** | +0.0208 | **+0.0519** | 0.830 |
| add.3 | `a630a75d` | **0.8880** | +0.0052 | **+0.0468** | 0.898 |
| add.4 | `15b1f45e` | **0.8651** | +0.0122 | **+0.0405** | 0.896 |

Content 11–13% smaller and pushed 4–5% down, four times out of four, against a threshold of 2% and an
instrument floor of 0.3%. 1a's single positive (`2379cd65`: Δscale 0.898, Δdy +0.044) is reproduced
almost to the third decimal. **This cell always reframes.**

**And the mechanism is visible rather than inferred.** The frame is a tight full-body studio portrait:
her head sits against the top edge and the ball against the bottom. "On top of my head" names a place
that is **outside the frame's existing content bounds**, so the only way to obey it is to make room —
the canvas stays pinned at 3:4 (1792x2400 every time) and the _content_ is rescaled and dropped to fit
the bottle in. All four renders place the bottle upright on her head, so the instruction was obeyed;
the reframe is the cost of obeying it.

That closes 1a's split. The same sentence on `37df2f85`, which has headroom above her, is 0 of 2 with
Δscale 1.000; on this frame it is 5 of 5 counting 1a's. So the predictor is not the operation and not
the wording — **it is whether the place she names has room in the frame she gave**.

### ⚠️ The background arm could not run, and that is its own finding

With real detection, `"change the background to a beach at sunset"` **blocks at preview** on both
frames tried — `7fe0b609` (region 1106x1518, the whole frame) and `517ed082` (959x1408, 91% of it).
In both, detection returned the **directive** as the region label ("a beach at sunset") and **no
`subjectNoun`**, so `wholeFrameEditBlocker` refused: without the subject named the mask does not
invert, and the edit would redraw her along with the background. That guard is doing exactly what it
was added for.

Two attempts, two frames, then stop — no third frame, and **no fabricated region**: hand-supplying a
`subjectNoun` would have measured a cell the product cannot currently produce.

**But her library holds 12 background natives that DID run**, including this very sentence on
`5581e882`. So `subjectNoun` is _non-deterministic_, not absent, and a lone background edit's ability
to run at all depends on a field a flash call may or may not return. **New card, and it is bigger than
framing:** a background ask that blocks is a dead end she can do nothing about (the copy tells her to
"name the thing you want changed", which is precisely what she did). Owner: detection, i.e. shared
code — proposal only, not ours to fix.

The background path's framing question is already answered by 1a at n=12 of paid renders: **0
reframes, max 0.76% scale**. Nothing was lost by not running it.

---

## Probe 2 — RAN and DECIDED. G.2's canonical identity block is a tie, so it dies

**Spend: 8 image calls, exactly $1.0752 on the cost log** — $0.1344 per cell, 1120 image tokens each,
against a $1.8184 quote (references are quoted at the output rate on purpose). The pack was the
confirmed one-person set: `25499d98`, `3b9be374`, `5581e882`.

**Every cell verified at the wire**, which is what makes this an A/B and not two runs:

| cell         | job        | swapped | prompt | input tokens |
| ------------ | ---------- | ------- | -----: | -----------: |
| A.portrait.1 | `fab75040` | no      |   1484 |         2015 |
| B.portrait.1 | `ed4a7af5` | **yes** |   1700 |         2058 |
| A.action.1   | `46145947` | no      |   1482 |         2017 |
| B.action.1   | `a63c2d85` | **yes** |   1698 |         2060 |
| A.portrait.2 | `ebba590d` | no      |   1484 |         2015 |
| B.portrait.2 | `eb1bc0a1` | **yes** |   1700 |         2058 |
| A.action.2   | `43615533` | no      |   1482 |         2017 |
| B.action.2   | `072aac98` | **yes** |   1698 |         2060 |

Three inline JPEGs at 571/612/881 KB on all eight — the same bytes every time, so the references are
not a variable. Arm A's prompt was asserted equal to the compiled one on every cell (the swap function
throws otherwise), and arm B's was asserted to be arm A's before replacement. The arms differ by 216
characters and 43 input tokens and by nothing else.

### The part order, which is delta D1 and D5 in one line

```
A:  header · REFERENCES(+HER LIKENESS) · AUDIENCE · TEXT AND NAMES · GOAL · DIRECTION
B:  header · IDENTITY                  · TEXT AND NAMES · DIRECTION · AUDIENCE · GOAL
```

### The technical gate (not the verdict)

All eight renders are photographs: face visible, no interface, no caption, no invented handle and no
name anywhere — the defects PR's fix holding across 8 more cells. So every cell is valid for the pick,
and **the pick is Adi's**; nothing in this document says which tile is which arm.

### Two arm-agnostic findings the renders gave up for free

**The wardrobe leaks from the references, and the scene release does not cover it.** The action
direction names no clothing, and all four action renders put her in the pack's maroon kit — _with its
adidas trefoil_. `bound3`'s release says "Take nothing else from these photographs: not their
backgrounds, their lighting or their framing"; `struct1`'s said "not its background, **clothing**,
lighting or framing". The word that is missing is the one the renders needed. That is a one-word
candidate for whatever wave-B PR touches this block, and it is measurable the same way this probe was.

**An unrequested competitor mark rides in on a person reference.** The trefoil is in the output because
it is in the pack, which is the same NIL class as the mixed-marks finding from the earlier sweeps —
now with a second route into the frame that has nothing to do with a brand job.

### The verdict — a TIE, and the pre-registered consequence is that G.2 dies

**Adi's blind picks, 2026-09-17: a tie on both sheets** — "genuinely indistinguishable at sheet
quality". The pre-registered rule for a tie was written before the cells ran, and it stands:
**the canonical block does not ship, the G.2 card dies, and there is no ablation.** R2 has no build
candidate left. The five deltas stay unseparated, permanently, because nothing was bought by
separating them.

**⚠️ The tie is bounded by the instrument, and is NOT a proof of equality.** n=4 per arm, two poses,
one athlete, judged from 2x2 contact sheets at 440px a tile. That is enough to say the block buys
nothing an eye can see at this resolution and this n; it is not enough to say the two prompts are
equivalent. The harness, the arms, the pack and the wire swap are all committed and re-runnable: if a
real likeness complaint ever arrives, re-run this at a larger n and at full render size before
re-opening the card, and do not treat this tie as having closed the question.

**⚠️ And identity language is effectively unevaluable on action shapes right now.** The action cells'
faces measured **sizeFrac ~0.075** (probe 3 scored the same pose class at 0.075 against 0.154–0.265 for
portraits) — near the floor of what can be judged at all, on a sheet or at full size. So the action
half of this probe could not have detected a difference in identity language even if one existed: the
face is too small a part of the frame to read. Any future identity measurement on an action pose needs
a face crop or a larger render before it means anything, and G.2's death is carried by the portrait
half, where the faces were legible and the arms still tied.

---

## Probe 3 — RAN. The stranger baseline, and the ruler is worse than dead

**Spend: 2 image calls, $0.2688 on the cost log** (jobs `e932e245` portrait, `05cc8de9` action; assets
`114ac0c1`, `48d3326e`), plus **$0.0346** of QA on this run's three scorings and ~$0.013 wasted on a
first attempt the cap refused (see the shim note below). **~$0.316 against a ~$0.30 cap** — the
overshoot is QA pennies, and the hard part of the cap, 2 renderer calls, was never exceeded.

**⚠️ The first attempt cost a cell and taught the shim something.** The cap counted every
`:generateContent` call, and QA's face box is a `gemini-3.5-flash` `:generateContent` through the same
`fetch`. So the portrait rendered, its scoring fired eight concurrent flash calls, the second tripped
the cap, and the action cell never left. Nothing overspent — it failed closed — but a cap that
refuses the work it is meant to permit is broken, so the shim now caps only calls that ask for an
IMAGE back (`generationConfig.responseModalities`, with the model id as a second signal) and records
everything else. The portrait was then scored from the bytes already on disk rather than re-rendered.

### The numbers

Mean embedding distance from the render's face crop to each of her photographs, by set. `n` is how
many of the set produced a distance; the rest carry a reason code, which is R0.b working.

| render                                         | production-rule set (**three different women**) | curated one-person set | output face sizeFrac |
| ---------------------------------------------- | ----------------------------------------------: | ---------------------: | -------------------: |
| existing production no-ref render (`cea68f2e`) |                                      0.4199 (4) |         **0.3047** (2) |                0.154 |
| new portrait stranger (`114ac0c1`)             |                                      0.4394 (4) |         **0.3044** (2) |                0.265 |
| new action stranger (`48d3326e`)               |                                      0.5366 (4) |         **0.4405** (2) |                0.075 |

Her recorded held-out **same-person band on this instrument is 0.3158–0.4186** (R0.a, 6 pairs), and
the 2026-09-15 stranger scored 0.3584 inside it.

**Two of three strangers now score BELOW the bottom of her own same-person band** — 0.3044 and 0.3047
against a curated set of three photographs of one woman. An invented person is _closer to her than
she is to herself_, on a curated set, which removes the last excuse the mixed set gave the instrument.

**And the number tracks FRAMING, not identity.** The two portrait-shaped strangers land at 0.304 with
face sizeFrac 0.154 and 0.265; the action-shaped one lands at 0.4405 with sizeFrac 0.075. Within every
row the same ordering holds: distances to the two curated photographs (0.28–0.45) sit below distances
to the production set's wider framings (0.31–0.63). `qa/embed.ts` already says
`multimodalembedding@001` is semantic rather than face recognition; this is that sentence with numbers
on it. A ruler that rewards a matching crop is not measuring a face.

**Reason codes earned their place.** `b2d6edcd` returned `no_face` on two renders and `vision_error`
on the third — the same photograph, two different failures, which is exactly the ambiguity R0.b's
codes were added to end (one of her three references came back null and nothing could say why).

**Log-only, as agreed.** No `metadata.creative_qa` was written, no verdict moved, and
`identityTargetsFor` still refuses to score a reference-free generate in production. What is banked is
`out/p3/observations.json` plus the two renders, for whatever instrument eventually replaces this one.

---

## What this authorizes for wave B — final

| #   | commit                                                                                                                                      | authorized by                                                                                                                                                                                           | shape                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **A framing line on the ADD template only** — an add whose place lies outside the frame's content bounds keeps the frame, or says it cannot | 1b, 4/4 at Δscale 0.87–0.89, reproducing 1a's positive to the third decimal                                                                                                                             | one template string + goldens. It must NOT go in the shared preservation clause                                                             |
| 2   | **A QA content-bounds check, adds only**                                                                                                    | the same, plus the instrument: `measure.ts` is ~5s of CPU per image and makes NO model call, the cheapest check in the QA stage by an order of magnitude                                                | observation-only, beside `identityObservation`. Fire it when the frozen intent is an add with a place                                       |
| 3   | **"clothing" in the scene release** — one word                                                                                              | probe 2's renders: 4 of 4 action cells took the pack's kit _and its competitor mark_, with no wardrobe anywhere in her direction. `struct1`'s release had the word; `bound3`'s, which shipped, does not | one word + a golden recapture. Note it edits the wording R1 measured, so it is a measured change to a measured line: re-run the corpus diff |

### Dead here — do not build these

| card                                                 | why it dies                                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| a framing line in the **shared preservation clause** | 0/12 backgrounds and 18/19 adds already hold the frame without one. A line that fires on the minority of renders is worse than no line |
| a **QA framing check on backgrounds**                | 0/12, max 0.76% scale, on renders she had already paid for                                                                             |
| **G.2's canonical identity block**                   | a blind tie on both poses (bounded as above). The plan's own rule: a tie kills it                                                      |
| an **ablation of D1–D5**                             | it was conditional on G.2 winning                                                                                                      |

### Also filed for wave B — a card, not a commit

**A lone background edit can dead-end on a non-deterministic field.** Detection returned the directive
as the region label and no `subjectNoun` on two frames, so `wholeFrameEditBlocker` refused the preview
— while 12 background natives in her library did run. The copy then tells her to "name the thing you
want changed", which is exactly what she did. **Owner: shared detection, not Mila's code.** Proposal
only: either detection guarantees a subject noun for a whole-frame background answer, or the refusal
says something she can act on. Blast radius is every background edit in the product, which is why it is
a proposal and not a diff.

### Cards filed for Mia, outside our scope — proposals only, no code

1. **A person reference leaks its legible text.** The surname on a bib in a reference printed itself
   across the kit; `TEXT AND NAMES` asks the model not to write names and cannot see that a reference
   contains one.
2. **Nothing verifies whose face a "You" photo holds**, and this library proves it matters: three
   different women, one of them a public figure.
3. **R0.b's identity set is not one person** for this athlete, so any ruler "calibrated on her own
   photographs" would be calibrated against a mix.

### And one thing this probe session does NOT authorize

**Any acceptance bar written in the current identity metric.** Probe 3 put a stranger 0.011 below the
bottom of her own same-person band on a curated single-person set. R0.a's decision 5 — replace the
instrument — is not merely live, it is now the only thing standing between R3's escalation threshold
and a number that cannot support it.

---

## What is NOT measured anywhere here

- **The 4K tier.** Probe 1's paid cells are 2K (a 1.68MP frame), which is what keeps 8 calls inside
  the cap. 1a's corpus spans both tiers and the one positive is 2K; whether a 24MP/4K native edit
  reframes more or less often is unmeasured. Eight 4K cells would bill $1.92.
- **Anything about the athlete's own eye on probe 1.** The instrument measures geometry. Whether an
  11% zoom-out reads as wrong to her is a different question, and the four renders are in
  `out/p1b/blind/add/` for it — all four place the bottle correctly.
- **The background arm of 1b**, which detection would not let run (two frames, two blocks).
- **Which of probe 2's five deltas did anything.** It was a bundle by design, the bundle tied, and the
  ablation that would have separated them was conditional on a win. They stay unseparated.
- **Whether the arms differ at full render size, at larger n, or on a legible action face.** The tie is
  this instrument's answer, not the question's.
- **Whether any of probe 1a's 30 renders are GOOD.** The measurement is content bounds, not quality.
- **The client.** No screen is exercised by any of this.
- **G.1 and G.3.** Probe 2 moves the identity block only. Her prose still reaches the model as
  `DIRECTION:`, and no pose class is computed.
