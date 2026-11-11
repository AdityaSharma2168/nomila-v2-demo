# Sweep #2 — run sheet

**Staged in PR N (item N.4). Not run.** Adi runs it and verdicts it, in daylight.

The original sweep's prompts through the product's **native** edit path: frozen at preview, one
full-frame call, Creative QA on every output. It is the proof the product does what the probe did,
PR Q's calibration event (full-frame is the first path where an identity failure can exist), and the
Mia demo material. The routing decision it tests is in
[`2026-09-09-model-native-probe.md`](./2026-09-09-model-native-probe.md), "Routing decision".

Cells and their reasons: `server/scripts/studioSweep2Plan.ts` (pinned by its test). Runner:
`server/scripts/studioSweep2.ts`.

## Flags — the runner checks these and refuses to spend without them

| flag                     | why                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STUDIO_NATIVE_EDIT`     | the path under test — **flip it locally**                                                                                                                                                        |
| `STUDIO_CREATIVE_QA`     | every native output self-scores; without it the calibration event produces no records and nothing says so — **flip it locally**                                                                  |
| `STUDIO_BACKGROUND_MASK` | already on for sweep parity. Detection returns a background's subject noun only with it on; without it a background ask is a whole-frame region with no noun, and the whole-frame gate blocks it |

The runner calls the product functions in-process, so `STUDIO_ENABLED` is not read. The proxy on
5440 must be up.

## Commands

```bash
# The plan — every cell, its route, its size, its quote, the totals. Reads, writes and spends nothing.
npx tsx --require dotenv/config server/scripts/studioSweep2.ts

# Everything (cap is on generation quotes)
npx tsx --require dotenv/config server/scripts/studioSweep2.ts --run --cap 6

# One cell, or one section
npx tsx --require dotenv/config server/scripts/studioSweep2.ts --run --cell 1.5a-r1
npx tsx --require dotenv/config server/scripts/studioSweep2.ts --run --section 4
```

Outputs, source-vs-output sheets (`<cell>-sbs.jpg`) and `runs.jsonl` land in `probe-out/sweep2/`
(gitignored). Every asset id is appended to `docs/probes/probe-cleanup-list.txt`.

## Cost — above the ~$4–5 first estimated, and why

|                                                                                                                |             |
| -------------------------------------------------------------------------------------------------------------- | ----------- |
| generation, **quoted** (what the preview shows and the cap checks)                                             | **$5.7041** |
| generation, **billed** (image tokens only — what Vertex reports)                                               | ~$4.8672    |
| Creative QA — 25 native outputs × $0.0212 (PR Q's measured cost)                                               | ~$0.53      |
| detection — 24 unique flash calls (the n=2 repeats share a memo), **not in the cost log** (autoMask → `genai`) | cents       |
| **total, quoted**                                                                                              | **≈ $6.23** |

It is over the earlier ~$4–5 for two reasons, both deliberate:

- **4K by rule.** 13 cells are on 24 MP frames, where `smallestImageSizeFor` asks for 4K ($0.2710
  quoted / $0.24 billed) instead of 2K. That is the tier the product now ships (PR N, D1).
- **The four extra background cells** — every background prompt on both 4000px frames — are $1.084
  quoted. Without them the sweep is ≈ $5.07 quoted: $4.6201 of generation and 21 × $0.0212 of QA.

The 12 cells on 1.5 MP frames quote $0.1654 at 2K. The ball generate quotes $0.1963: 1K, the API
default, plus two references. The plan's test pins each of these figures to the price table.

## The cells

| cell          | frame    | sentence                                           | what it measures                                                                  | sweep #1  |
| ------------- | -------- | -------------------------------------------------- | --------------------------------------------------------------------------------- | --------- |
| 1.1           | afc78262 | change the color of the jersey to purple           | the control                                                                       | CLEAN     |
| 1.2           | a81be2c0 | make the sports bra white                          | line + strap distortion on masked                                                 | ARTIFACT  |
| 1.3a          | afc78262 | change the socks to yellow                         | the rim, small source                                                             | ARTIFACT  |
| 1.3b          | 5581e882 | change the socks to yellow                         | same ask at 4000px — the 4K arm                                                   | CLEAN     |
| 1.4           | afc78262 | make the cleats black                              | halo round the boots on masked                                                    | ARTIFACT  |
| 1.5a-r1, -r2  | 3b9be374 | make the jacket pink                               | **the variance / identity cell, n=2** — masked came back maroon with a third hand | FAILED    |
| 1.5b          | 3b9be374 | recolor the jacket to be black                     | the control that worked                                                           | CLEAN     |
| 2.1           | afc78262 | put a number 10 on the jersey                      | number right, lines + quality hit on masked                                       | ARTIFACT  |
| 2.2           | afc78262 | add a nike swoosh to the shorts                    | the phantom success                                                               | FAILED    |
| 2.3           | afc78262 | put a sponsor patch on the sleeve                  | part-of-garment overreach                                                         | FAILED    |
| 2.4a          | 517ed082 | add an adidas logo to the jersey                   | failed on this frame                                                              | FAILED    |
| 2.4b          | afc78262 | add an adidas logo to the jersey                   | clean — and swapped the swoosh unasked                                            | CLEAN     |
| 3.1           | afc78262 | make the jersey red and the shorts black           | the sweep's own multi-target — **its shorts are already black**                   | FAILED    |
| 3.2           | afc78262 | change my jersey to blue and add an adidas logo    | **gate cell — must BLOCK and spend nothing**                                      | ASK       |
| multi-r1, -r2 | afc78262 | make the jersey white and the socks yellow         | **two genuine changes in one call, n=2** — jersey and socks are both black        | —         |
| 4.1           | afc78262 | put me in a packed stadium                         | read as slop on masked                                                            | ARTIFACT  |
| 4.2           | a81be2c0 | change the background to a beach at sunset         | the green halo                                                                    | ARTIFACT  |
| 4.3           | 5581e882 | change the background to a plain studio backdrop   | border artifact                                                                   | ARTIFACT  |
| 4.1-halo      | a81be2c0 | put me in a packed stadium                         | background on a 4000px frame                                                      | —         |
| 4.1-large     | 5581e882 | put me in a packed stadium                         | background on a 4000px frame                                                      | —         |
| 4.2-large     | 5581e882 | change the background to a beach at sunset         | 4.2's ask on the other 4000px frame                                               | —         |
| 4.3-halo      | a81be2c0 | change the background to a plain studio backdrop   | 4.3's ask on the other 4000px frame                                               | —         |
| 5.1           | a81be2c0 | remove the ball                                    | very clean on masked                                                              | CLEAN     |
| 5.2           | a81be2c0 | change the ball to a black one                     | clean on masked; a recolour of the ball                                           | CLEAN     |
| ball          | afc78262 | create a new photo of me with this ball at my feet | **generate** — her photo as identity, the ball via the Object tile (pre-C′)       | 7.1 (ASK) |

## Going in — what the code says will happen (expectations, not verdicts)

- **3.2 blocks at the preview.** The classifier ASKs on recolour + design, the freeze refuses, and
  the preview is blocked with a sentence she can act on. It costs one detection call and no
  generation. A READY preview here is a gate failure, and the runner will not spend on it.
- **The ball is a generate, so QA never inspects it.** A generate has no source frame, so there is
  nothing to compare it against. Verdict it by eye; the test is whether it reproduces _that_ ball
  (BOLYN).
- **A multi-target recolour can refuse to freeze.** Detection sometimes collapses two-target
  directives to bare colours ("red", "black" — sweep 3.1's labels). A label that names no target is
  not guessed at: the preview blocks, it spends only the detection call, and `runs.jsonl` records
  it. That is fail-closed by design. Pairing a bare label to its target by the region's garment noun
  would rescue it; that is a proposal, not built.
- **Every 24 MP cell returns 3392×5056** and its preview carries the resolution warning.
- **The preservation clause is on every prompt, and nothing has measured it.** Compare scene
  lighting against Q5L's full-frame cells, which ran without it.
- **Restyle is accepted behaviour** (the Routing decision). A recolour that also changes a
  garment's cut or print is ACCEPTED, not FAILED, unless it breaks something else.
- **QA's marks check is advisory at 27% specificity.** Expect it to flag marks on outputs that look
  clean (PR Q). Identity is the check with no calibration yet — this sweep is where it gets one.

## Verdict template

One line per cell, in `runs.jsonl` (`"verdict": null` is waiting for it) or here:

| cell | verdict (CLEAN / ARTIFACT / PARTIAL / FAILED / ACCEPTED) | QA overall | note |
| ---- | -------------------------------------------------------- | ---------- | ---- |
|      |                                                          |            |      |

`ACCEPTED` means what it meant in Q5L: the change landed, and any restyle or variance is the accepted
behaviour, not a defect. The QA column is what makes this PR Q's second labelled set. Recalibrate
the identity band and the marks precision afterwards.
