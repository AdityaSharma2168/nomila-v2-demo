# Kling moderation confirmation — does the route accept real-athlete input RELIABLY?

**Status:** written 2026-09-19, BEFORE the run. Predictions below are dated ahead of the result on
purpose; nothing in this file is edited after `--run` except §5, which is the result section.

**Script:** `server/scripts/studioKlingModeration.ts`
**Spend:** dry run is the default and costs $0. `--run --cap <usd>` is the only thing that bills.

---

## 1. The question, and the only question

Kling's real-athlete acceptance is **n = 1**. The V5 recon cell (`throwaway/kling-hard-cell`,
2026-09-18) submitted one athlete photograph and the route took it. One acceptance is not a
property — Seedance's route _refused_ real-person i2v 6 of 6 as stated BytePlus policy
(`InputImageSensitiveContentDetected.PrivacyInformation`), and Kling's user policy has no
real-person clause at all, only a discretion to "moderate, block, or delete the Input". Discretion
is exactly the shape that produces an **intermittent** refusal.

So, before Kling is wired as a load-bearing production adapter:

> Does `kwaivgi/kling-v3.0-std` accept a real athlete's photograph as an image-to-video first frame
> **reliably**, across different photographs?

This probe measures **acceptance only**. It is not an identity probe, not a quality probe, not a
cost bake-off. No clip produced here is scored, and no conclusion about how Kling _renders_ her may
be drawn from it.

## 2. Why the prompt is identical across all four cells

V2's most expensive lesson was a prompt that disagreed with its frame, which turned a "near-static"
cell into a large head movement and voided the reading. The usual fix is a per-frame prompt (the
`PRESETS` in `studioKlingFirstLast.ts`).

Here the fix is the opposite one. The **variable under test is the frame**; a per-frame prompt would
confound "the route refused this photograph" with "the route refused this sentence". So every cell
carries the same deliberately neutral, near-static, backdrop-agnostic beat, and the frame is the only
thing that changes between cells.

## 3. The four frames

Three are the corpus frames V2b vetted by rendering all 18 of athlete `3811cedd`'s uploads through
the 9:16 crop and looking at every one. The fourth is one of that pass's named "usable front-facing
alternates".

| Cell             | Asset                                  | Cluster        | Stored         | Why it is in the set                                                                                                                                                                                                       |
| ---------------- | -------------------------------------- | -------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c1-studio`      | `7fe0b609-740e-409b-a0e0-b159f5a7718e` | studio subject | 1106x1518 png  | The corpus's strongest frame: studio light, plain seamless backdrop, dead-on front-facing, face ~12.5% of frame height. A refusal HERE is the route refusing a clean studio portrait.                                      |
| `c2-maroon-med`  | `77146781-cedc-44e4-a437-f0f0f98626a0` | maroon         | 6000x4000 jpeg | V2b's MED frame — a crouching/shoelace beat, field backdrop.                                                                                                                                                               |
| `c3-maroon-hard` | `3b9be374-7b0e-4372-a506-4f48e3d89ac9` | maroon         | 4000x6000 jpeg | V2b's HARD frame — largest clean face in the maroon set, standing medium, three stripes down both sleeves.                                                                                                                 |
| `c4-alt`         | `37df2f85-8ff6-4726-bef9-7129c5e9d105` | unpinned       | 1056x1408 png  | A front-facing alternate from the same library, carrying large "GET LOUD" background text. Deliberately a frame NOBODY has submitted anywhere, so the set is not four re-runs of the two frames the bake-off already used. |

All four ids were resolved from `media_assets` against this athlete (read-only, `origin='upload'`,
18 rows) rather than taken from an 8-character prefix in a comment — the V2b write-up records
prefixes only, and a hand-expanded UUID would have been a guess.

**The maroon cluster is in the set because most of it is stored EXIF-flagged**, and a sideways
reference voided an identity result once already (`person-refs-sent-sideways`). `prepareFrame`
applies `.rotate()` before the crop, so the model is handed upright pixels either way.

The per-frame flag is **reported, not asserted** — read off the bytes by the dry run and printed per
cell. Measured 2026-09-19:

| Cell             | `media_assets` row | Actual bytes | EXIF                |
| ---------------- | ------------------ | ------------ | ------------------- |
| `c1-studio`      | 1106x1518          | 1106x1518    | `orientation=1`     |
| `c2-maroon-med`  | 6000x4000          | 6000x4000    | **`orientation=8`** |
| `c3-maroon-hard` | 4000x6000          | 6000x4000    | **`orientation=8`** |
| `c4-alt`         | 1056x1408          | 1056x1408    | `orientation=1`     |

`c3` is the one worth noticing: the DB row carries the **display** dimensions (4000x6000, upright)
while the stored bytes are 6000x4000 with the flag set. So a reader who trusts the row believes the
frame is portrait and a reader who trusts the bytes believes it is landscape, and both are "right".
That is exactly the disagreement `.rotate()` removes, and it is why the set is 2 flagged + 2 clean
rather than four of either.

### ⚠️ The frame this set deliberately does NOT include

`e58f3a5a` — a **recognizable real public figure with her name legible on the bib**. V2b excluded it
on principle, not on quality: generating video of her is a likeness exposure. It is also, precisely
because of that, the frame most likely to trip a moderation route — which makes it the most
informative cell and the one we are least entitled to run. **It stays out unless Adi says otherwise.**
If "the Stanford frame" in the V5 brief meant this asset, that is a decision to reverse a documented
exclusion and it is his to make, not mine.

## 4. Predictions, written before the run

Per cell, and the overall shape. These are recorded so the result is interpretable either way.

| Cell             | Prediction | Confidence | Reasoning                                                                                                                                                                                                |
| ---------------- | ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c1-studio`      | **ACCEPT** | high       | The n=1 acceptance was on a frame of this quality; a plain studio portrait is the least likely thing any route refuses.                                                                                  |
| `c2-maroon-med`  | **ACCEPT** | medium     | Nothing about a field backdrop should matter. The residual risk is that acceptance is _per-submission random_ rather than _per-image_, which is the whole hypothesis under test.                         |
| `c3-maroon-hard` | **ACCEPT** | medium     | As above. Largest clean face in the set — if a face-size heuristic drives moderation, this is where it bites first.                                                                                      |
| `c4-alt`         | **ACCEPT** | medium-low | The only frame nobody has submitted. Legible background text ("GET LOUD") is the one feature in this set that a text/IP filter could plausibly catch, and it would be a false positive for our purposes. |

**Overall prediction: 4 of 4 accept.** Stated plainly so a 3/4 is a real surprise and not something
that can be narrated as expected afterwards.

**The most likely way this is WRONG:** not a flat refusal on one image, but a _rate-_ or
*load-*shaped refusal — cells 3 and 4 refusing after 1 and 2 passed, which would look like image
sensitivity and would actually be submission sensitivity. The script therefore records the wall-clock
time and submission order of every cell, and `--repeat` re-submits the SAME cell N times so that
"the image" and "the submission" can be told apart on a follow-up.

## 5. Result — RUN 2026-09-19, 4/4 ACCEPTED

```
c1-studio       accepted   68.3s   billed $0.5040
c2-maroon-med   accepted  103.6s   billed $0.5040
c3-maroon-hard  accepted   99.2s   billed $0.5040
c4-alt          accepted   93.4s   billed $0.5040
```

**4 of 4 accepted, every cell as predicted.** Billed **$2.0160** against a $3.0240 quoted ceiling
and a $3.11 cap. Every figure is `basis: "reported"` — OpenRouter's own `usage.cost`, not our
estimate. All four clips downloaded and are on disk.

Counting the V5 recon cell (`throwaway/kling-hard-cell`, 2026-09-18), Kling's route has now accepted
real-athlete image-to-video input **5 times out of 5**, across four different photographs.

### What 5/5 does and does not establish

**It does not prove determinism.** Five acceptances cannot rule out a refusal on the sixth, on a
photograph not in this set, or under different load. Nothing here licenses the claim that Kling
_never_ refuses a real person.

**It is categorically different from Seedance**, and that is the finding. BytePlus refused 6 of 6
with a stated, named policy code (`InputImageSensitiveContentDetected.PrivacyInformation`) — a route
that rejects this input class _by design_. Kling has accepted 5 of 5 including two `orientation=8`
maroon frames of the same athlete Seedance turned down. That is the difference between "this route
is not for real people" and "this route takes real people". The residual risk is an occasional
refusal, which a job can surface and a human can retry; it is not the structural disqualification
Seedance carries.

**Read as:** strong evidence of reliability, sufficient to wire Kling load-bearing. Not proof of
determinism across all inputs, and not a reason to remove refusal handling from the path.

### The free second reading: `generate_audio: false` is HONOURED

Every cell invoiced **$0.5040 = 6s x $0.084/s** — the audio-OFF arm, exactly. Not one landed on the
$0.756 audio-on arm.

This is the first Kling invoice anybody has seen from this account, and it settles the question
`config.ts` had to leave open. The table's flat `$0.084` is **real once the flag is sent**, and the
pre-generation quote is honest. It also confirms the inverse: with the flag _unset_, OpenRouter's
documented default (`generate_audio` true for audio-capable models) would have bought the $0.126 arm
and the flat quote would have under-quoted by 50%.

**Consequence for V5 commit 1:** force `generate_audio: false` on the wire and keep the `$0.084`
price. Verified, not assumed.

## 6. Verdict gate, agreed before the run

- **4 of 4 accept** → Kling's moderation is reliable enough to wire as a load-bearing adapter.
- **Any refusal** → Kling's route is nondeterministic in the way Seedance's is. Wiring it as
  load-bearing is **off the table** until an alternate route is recon'd. The finding is written
  down; nothing is wired on the strength of a partial pass.

The count is reported. The decision is Adi's.
