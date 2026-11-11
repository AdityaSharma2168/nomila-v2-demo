# Video V9 — paid-cell predictions

**Written and committed BEFORE any cell runs. Nothing here has been fired.**
Branch `studio-video-v9`, off `801c42f`. `STUDIO_VIDEO_ENABLED` is off; none of this is reachable
until it is flipped.

There are **two** paid gates, and they are different sizes and different decisions.

| gate   | what it buys                                                                 | cost       | status                                                                    |
| ------ | ---------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| **G1** | finishing the INSTRUMENT's validation — V-3 and V-4 on clips already on disk | **~$0.50** | approved at the cap, **not fired**; needs the `--paid` arm built (see §3) |
| **G2** | confirming the instrument and the new prompt on FRESH generation             | **~$3.60** | not approved; needs the Track C gate + diff first                         |

---

## 1. G1 — the instrument, on clips we already paid for

Both questions run the REAL checks, which is why they are not free: `qa/marks.ts` makes two
`askVision` calls, `qa/face.ts` one, `qa/embed.ts` an embedding. At the image stage's measured
**$0.0212** per inspection a 3-frame sample is ~**$0.05 a clip**.

### V-3 · is `marks` usable frame-to-frame, or only advisory?

⚠️ **This is a SPECIFICITY probe, not a recall one, and that is a correction to the original plan.**
The plan said "aim marks at the known swoosh positive" — but the 2026-09-07 spike's clips were never
saved (a `find` for any mp4 dated 2026-09-01..09-10 across the repo and every worktree returns
nothing). **There is no known video positive anywhere.** So the question inverts.

**Cells:** `i2-veo-3.1` and `i3-veo-3.1` — both carry adidas three stripes on both sleeves, on
screen throughout, and neither changes brand. Every fire is a false positive. **~6 marks calls,
≈$0.10.**

> **Prediction.** `marks` fires on **at least one** sampled frame in at least one of the two clips.
> Frame-to-frame comparison is strictly harder than the still case it already scores 27% specificity
> on: the same ~20px mark, re-read at two different moments of motion blur. I expect it to be worse,
> not better, and I expect the outcome to be "marks stays advisory on video permanently".
>
> **What would change my mind:** 0 fires across 6 frames. That would be weak evidence — n is tiny —
> but it would be the first evidence in either direction and would justify a larger cell.

### V-4 · does WITHIN-CLIP identity discriminate at all?

The ruler is dead for the cross-photograph question: an invented person scored **0.3584** against her
held-out photographs, **inside** her own same-person band of **0.3158–0.4186**. The genuinely new
question is whether frame-t-against-frame-0 **within one clip** is different, since the camera, the
light and the framing — the confounds that killed it — are held constant by construction.

**Cells:**

| arm    | pairs                                                         | what it measures                                                |
| ------ | ------------------------------------------------------------- | --------------------------------------------------------------- |
| WITHIN | frame t vs frame 0 of the SAME clip, over the 3 V2b Veo cells | how far her face moves across a clip that held identity         |
| CROSS  | frame 0 of clip A vs frame 0 of a DIFFERENT SUBJECT's clip    | **the control** — what a stranger scores on the same instrument |

The CROSS arm is the whole point. `k5-control-unanchored` and the b-roll cells give frames that are
not her. **~10 face crops + 10 embeddings, ≈$0.40.**

> **Prediction — and this is the one I genuinely do not know.** WITHIN distances land **below 0.15**
> (well under the cross-photograph floor of 0.3158), because almost nothing varies between two frames
> of one clip. CROSS lands **above 0.30**. So the two separate — **and I still do not think that
> licenses a bar**, because a separation that large is what you would get from comparing any two
> frames of any one video against any two frames of any other video. It would be measuring
> "same clip / different clip", not "her / not her".
>
> **The outcome that would change the card:** CROSS landing INSIDE the WITHIN range. That would kill
> within-clip identity outright and the check stays an observation forever, which is where it already
> is — so V9 ships correct either way and only the FUTURE gating question depends on the answer.
>
> **⚠️ No bar is written in this metric on any outcome of this probe.** A separation on n=3 clips is
> not a calibration. The most it can earn is "worth building a real instrument against".

---

## 2. G2 — fresh generation, ~$3.60

### P1 · does the PRODUCT prompt hold identity as well as the PROBE prompt did? (2 cells, $2.40)

The only variable is the prompt. Same frame, same model, same duration, same 9:16 — V2b's `med` and
`hard` cells re-run through `video/prompts.ts`'s `identity-static` template instead of the harness's
hand-written sentence.

> **Prediction.** Both hold, and the drift curves land **within ±0.05** of V2b's published pairs
> (`med` 0.087·0.166, `hard` 0.199·0.163). The templates carry the same three devices the probe
> sentences did — a motion beat, a camera instruction, an explicit preservation clause — and
> `identity-static` asks for a CONTINUATION rather than a state change, which is strictly safer than
> the sentence V2's easy cell failed on.
>
> **What a miss would mean.** If the product prompt does materially worse, the library is wrong and
> the fix is the template, not the model — which is exactly the question this cell exists to answer
> and the reason B4 was treated as a blocker rather than a polish.

### P2 · does the whole stage work end to end on a fresh clip? (1 cell, $1.20)

The `hard` turn, generated through the real path: `POST /studio/generate` → queue → runner → submit
→ poll → store → **QA after `succeedJob`** → verdict on the record.

> **Prediction.** The job closes `succeeded`, exactly **one** `media_assets` row exists, and
> `metadata.creative_qa` carries `subject: "clip"` with `coverage.checked = 3` and
> `coverage.total ≈ 144`. The sampled peak lands **between t=1.5 and t=3.0** — V2b measured `hard`'s
> peak at t=2.00.
>
> **The failure I would most expect** is not in the clip: it is the QA stage timing out, or ffmpeg
> behaving differently on Cloud Run's tmpfs than on this laptop. Both would show as a `null` verdict
> and a stored clip, which is the designed degradation.

---

## 3. What has to happen before either gate can fire

1. **G1 needs the `--paid` arm built.** `server/scripts/studioVideoQaCorpus.ts` currently exits 2 on
   `--paid` with a message, deliberately, so it cannot spend by accident. Wiring V-3 and V-4 is **$0**
   of work and gives a dry run that quotes the exact figure before anything bills.
2. **Credentials.** Both gates need a working Vertex path. I cannot verify what is configured here —
   reading `.env` is permission-blocked, which is correct — so that check is Adi's.
3. **G2 needs the flag.** `STUDIO_VIDEO_ENABLED` is off by default and every commit in this card
   keeps it that way.
4. **Dry run first, one cap, and the cap named on the command line.** Same discipline as every probe
   this session: the dry run prints the quote, the quote is checked against the cap, and the cap is
   the ceiling rather than the estimate.

## 4. The rule these predictions are written under

Committed before the run, scored after, **misses reported**. This card's record so far: every
numbered prediction in Tracks A and B held, and the two META-predictions — "B4 will be the trouble"
and "C1's revert check is the risky part" — were respectively wrong and right. The second one was
right in the most useful way: the first version of `qa-before-succeed-double-records` **passed under
its own mutation**, and only writing down in advance that this was the likely failure made it worth
checking rather than assuming.
