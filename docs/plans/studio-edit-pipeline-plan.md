# Studio edit pipeline — real full-res photo editing inside Create anything

**Branch:** `studio-edit-pipeline` · **Status:** plan only, nothing built · **Ships:** session-only, no thread persistence

Mia's ruling: editing lives **in** Create anything. She types "remove the soccer ball" with a photo
attached and it edits. There is no separate door. `CampaignWorkspaceScreen` — the reconnected door
with the hand-drawn mask editor — is the interim stopgap this replaces.

---

## 0 · The one sentence that decides the architecture

**The model never preserves pixels, so we have to.**

Three live probes settled this and none of it is re-litigated here:

| Probe | Result |
|---|---|
| Maskless text-only edit | Full re-render at **1/22 resolution** — 848×1264 out of a 6000×4000 in |
| Masked edit at `imageSize:4K` | Still a full re-render. **9%** of pixels outside the mask survived; output 3392×5056 (85% linear, not the input's own resolution) |
| Masked **composite** at 4000×6000 | **99.6% bit-identical**, and pixel-identical outside the mask |

So "send the text" does not work, and "send a mask" does not work either. The only thing that gives
a real full-res edit is **pasting the model's changed region back into the untouched full-res
original**. That is our arithmetic, not the provider's behaviour — which is the good news, because a
property we compute is a property jest can prove, and a property the provider supplies is one that
drifts with the next model update.

There is a second, sharper way to say it, and it is the framing the rest of this plan uses:

> **The crop is what buys fidelity. `imageSize` only buys patch resolution.**

They are different jobs, and conflating them is what makes 4K look load-bearing when it is not
(see §3).

---

## 1 · What I verified before planning

Four of these change the shape of the work, and two correct things the repo currently says.

### 1.1 `sharp` is already load-bearing — on this exact code path

`server/studio/imageSize.ts:16` says:

> *"NOT `sharp`. It is declared in package.json and installed but imported nowhere in this repo."*

**That is stale.** `server/studio/orient.ts:52` imports it, and `resolveStoredReference` in
`studio/generate.ts` calls it on every rotated source frame — i.e. on the edit path, on the source
frame, in a request. `sharp@^0.34.5` is a production dependency doing production work.

**Consequence: the composite needs no new dependency and nothing to approve.** `extract`,
`composite` and `resize` are the same library in the same lane. The `imageSize.ts` comment should be
corrected in this PR (one comment, no behaviour).

### 1.2 Auto-mask is available on our stack — Gemini's own spatial understanding

Verified against current Google documentation, not assumed:

- Gemini returns **bounding boxes from a text prompt**: `{"box_2d": [ymin, xmin, ymax, xmax], "label": "…"}`,
  coordinates **normalized to 0–1000**.
- From 2.5 onward it also returns **segmentation polygons** (`"mask"`), and **conversational**
  segmentation handles descriptive phrases — "the person holding the umbrella", "the car that is
  farthest away" — not just noun labels.
- Recommended posture in Google's own guidance: request strict JSON, keep thinking minimal.

We need a **box, not a polygon**: `EditRegion` is a rectangle and the paste-back composites
rectangles. Box detection is also the more mature arm. The polygon is dropped.

### 1.3 Google's own binary-mask inpaint endpoint is dead

`MaskReferenceImage` / `EDIT_MODE_INPAINT_REMOVAL` are still typed in the installed `@google/genai`,
and they are dead code. The only model that served them, `imagen-3.0-capability-001`, was
**retired 30 June 2026**; Google's stated migration is to the Nano Banana `:generateContent`
re-render path — i.e. back to the thing §0 says does not preserve pixels. Verified in the A4 phase-0
work (`adi/studio-a4-mask-edit`, 2026-09-03).

This is the first question any reviewer asks. Asked and answered: not on the table, and it does not
matter, because this design never needed a provider-side mask.

### 1.4 The 4K token count — the pricing bug, confirmed by arithmetic

Google's published output-token table for Gemini 3 Pro Image:

| `imageSize` | Output tokens | At $120/M (= `$0.00012/tok`, exactly what `config.ts` holds) |
|---|---|---|
| 1K, 2K | **1120** | $0.1344 |
| **4K** | **2000** | **$0.24** |
| 512px | *not published* | — |

`server/studio/config.ts:158` hardcodes `1120` for every tier. `1120 × $0.00012 = $0.1344`. So a 4K
job **bills $0.24 and quotes $0.1344 — a 79% underquote**, exactly as briefed, and the file's own
comment already predicted it ("*It will still be wrong at 2K/4K*"). §5 fixes it.

Accepted values are `"512px" | "1K" | "2K" | "4K"`, uppercase K, **default 1K**. Both `nanoPro` and
`nanoFlash` support all sizes.

### 1.5 Nothing sets `providerParams` on the image path today

The type plumbing is complete — `PreviewOptions extends ProviderOpts` → `plannedInputs` →
`estimate`/`generate` → the vertex adapter's `imageConfig` merge, which names `imageSize` as a
sibling knob. **But no caller sets it.** The preview route passes only `durationSeconds`
(`routes/studio.ts:747`); the generate route calls `runStudioGeneration` with **no `opts` at all**
(`routes/studio.ts:872`).

So "the edit path already forwards it" is true of the wire and false of every live caller. That is a
gap to close, not a feature to reuse — and §3.2 explains why closing it as a *caller option* would
be a bug.

---

## 2 · AUTO-MASK — text instruction → region, no drawn box

**The piece with the most unknowns, and the answer is better than expected: no new model, no new
vendor, no new dependency, no new auth.**

### 2.1 The call

One Gemini vision call, in the shape `server/lib/visionTag.ts` already uses in production:
inline base64 image + text prompt + `responseMimeType: "application/json"`, on `GEMINI.flash`
(`gemini-3.5-flash`) through the existing `genai()` Vertex client in `server/lib/models.ts`.

```
her instruction ──▶ target phrase ("the soccer ball")
                          │
       downscaled probe of the source frame (long edge ~1024px)
                          │
                    GEMINI.flash, JSON out
                          ▼
        [{ "box_2d": [ymin, xmin, ymax, xmax], "label": "soccer ball" }]
                          │        0–1000, Y-FIRST
                          ▼
              RegionFraction { label, left, top, width, height }   0..1
                          │
                          ▼
            mapRegions(fractions, frame)   ← EXISTING, tested, refuse-never-clamp
```

**The fit is the point.** Auto-mask emits the *same wire format the drawn box already emits* —
fractions of the frame's own extent, 0..1. Everything downstream is unchanged and already tested:
`mapRegions` validates and multiplies, `MIN_REGION_PX` rejects mis-taps, `LOOSE_REGION_AREA` warns,
`resolveSource` measures the frame from its own bytes, `orientPath.test.ts` pins the orientation
round trip. **We are adding a producer, not a pipeline.**

The probe is **downscaled deliberately**: fractions are scale-invariant, so a 1024px probe yields the
same fractions as the 24MP original, at a fraction of the input tokens. This is the same argument
the `MaskEditor` docstring makes for why the client sends fractions.

### 2.2 ⚠️ `box_2d` is **Y-FIRST**. This is the trap this codebase has already been burned by.

`[ymin, xmin, ymax, xmax]` — not `[x, y, w, h]`, not `[xmin, ymin, …]`. A transposed read produces a
box that lands rotated 90° off, and because the mask is consumed as geometry rather than as
something anyone looks at, **nothing downstream can notice** — which is precisely the failure
`imageSize.ts`'s ONE SPACE note, `geometry.ts`'s fraction wire format and `orientPath.test.ts` all
exist to prevent.

The conversion lives at **one boundary**, in one function, with a unit test that asserts a
deliberately non-square box on a deliberately non-square frame. A square fixture would pass a
transposed implementation.

The probe must also be measured in **DISPLAY space** — after EXIF orientation — because that is the
space `mapRegions` multiplies in and the space the model is looking at. The frame handed to the
probe therefore goes through `orientToPixels` first, exactly as the generation path already does.

### 2.3 Two strings out of one instruction

`mapRegions` requires a `label` per region and caps it at `MAX_LABEL_LEN = 60`, and that label
**rides into the prompt verbatim**. Her instruction has to become two different strings:

| | Feeds | Example |
|---|---|---|
| **target phrase** | the detection call — what to FIND | `the soccer ball` |
| **change label** | `EditRegion.label` — what to DO there | `remove the soccer ball` |

A long instruction ("change the blue jersey she's wearing to a red one with white sleeves" — 62
chars) would be refused outright by `MAX_LABEL_LEN`. So the label is derived and bounded, and the
**full** instruction still reaches the model as `job.direction` where it is not length-capped.

### 2.4 ⚠️ Cost, and where this call may NOT run

**This is a model call the brief did not account for.** It is cheap — flash, a downscaled probe
(258 input tokens per 768×768 tile), tens of output tokens; well under a cent — but it is not free,
and there are two hard constraints on where it can sit:

1. **Never inside `previewGeneration`.** That function's contract, stated in its own header and
   relied on by `runStudioGeneration`'s re-derivation, is *"No network, no spend, no writes."*
   Breaking it breaks the defence-in-depth argument the whole spend boundary rests on.

2. **The preview fires on every fingerprint change.** `useGenerationPlan` re-runs the check whenever
   `{title, request}` changes (`client/hooks/use-studio-pending.ts:393`). Preview is free today, so
   that is fine. The moment preview costs money, a re-check is a spend.

**Recommendation:** the auto-mask call runs in the **preview route**, before `previewGeneration`,
memoized on `(athleteId, sourceAssetId, targetPhrase)` for the preview TTL. `previewGeneration`
stays pure. The regions are frozen into the brief the same way a drawn box is, so `/studio/generate`
replays them and never re-detects.

**Why preview-time and not generate-time:** she has to be able to *see the box before she approves*.
An auto-mask she cannot see is a box she cannot correct, and the whole geometry design is built on
"refuse and show her, never clamp silently". Generate-time detection would mean approving blind, and
would also mean an empty `editRegions` at preview time — which `brief.ts:544` raises as a **blocking**
gap, so the preview could never go green in the first place.

### 2.5 What happens when detection fails

Three cases, all of which need an answer she can read, and none of which may silently widen the box:

- **Nothing found** — refuse. "We couldn't find *the soccer ball* in this photo." Not a full-frame
  fallback: a mask that covers the frame is the re-render this pipeline exists to leave.
- **More than `MAX_REGIONS` (3) found** — take the highest-confidence 3? Refuse? **Open decision (§11.6.)**
- **Box larger than the crop cap** — the §11.4 band. Recommended: downscale that region's crop to fit.

---

## 3 · EDIT — the model call, and why the size is derived from the crop

### 3.1 `image.edit` on a crop, not on the frame

The existing `image.edit` task, the existing `nanoPro` route, the existing vertex adapter. What
changes is **what it is handed**: a padded crop around one region, not the whole frame.

That crop **is** the mask. There is no alpha channel to send and none is needed — the model can only
change what it can see, and it cannot see outside the crop. Everything outside is preserved by
construction rather than by instruction.

**Consequence for `buildPrompt`:** the `CHANGE ONLY: <label> (at x,y, WxH)` block and its
"the coordinates are authoritative" paragraph are **actively wrong on this path**. Those coordinates
are in *frame* space; the model is looking at a *crop*. Handing it coordinates that do not match
what it sees is worse than handing it none. The prompt on this path is the label and the frame
statement for the **crop's** dimensions. `buildPrompt` gains an arm; the existing edit arm is
untouched so `CampaignWorkspace` keeps behaving exactly as it does today.

### 3.2 `imageSize` must be derived from the **frozen brief**, never passed as an option

This is load-bearing and it is easy to get wrong.

`runStudioGeneration` **re-derives** the verdict — `previewGeneration(brief, opts)` — and compares
the fresh quote to the stored ceiling (`generate.ts:327`). If preview and generate derive a
different `imageSize`, **the quote and the spend are for different jobs**. A caller-supplied knob
makes that divergence one missing argument away.

So `imageSize` is a **pure function of the brief** — the source dimensions and the editRegions are
both already frozen in it — computed in `plannedInputs` (`preview.ts:609`). That is the exact seam
where `generateAudio` already lives, for the exact same reason, and it makes preview and generate
agree *by construction* rather than by agreement.

### 3.3 ⚠️ Does this even need 4K? Probably not, and that is a real saving

Once we crop, output resolution is decoupled from frame resolution. The rule is only: **the returned
patch must not be smaller than the crop**, or the paste-back upscales a blurry patch into a sharp
photo.

A typical crop, from the A4 phase-0 crop math on real 24MP frames, is **1.3–2.0 MP** — roughly
1300×1300 to 1843×1085. The long edge is **under 2048**, so **2K covers it**:

| Size | Tokens | Cost | Covers a crop up to |
|---|---|---|---|
| 2K | 1120 | $0.134 | ~2048px long edge |
| 4K | 2000 | $0.24 | ~4096px long edge |

**Recommendation: pick the smallest `imageSize` whose output is ≥ the crop's long edge.** Typical
edits then run at 2K for **56% of the 4K cost**, and 4K is there for the large-crop case rather than
as the default.

This does **not** make §5 optional. The moment 4K is reachable at all, the quote has to be able to
say $0.24. And it is reachable the first time someone marks a big region.

---

## 4 · PASTE-BACK COMPOSITE — the guarantee

```
full-res original (upright bytes — orient.ts already guarantees this)
        │
   ① per REGION: pad by CONTEXT_PAD, clamp to frame, cap at MAX_CROP_MP  → cropRect
   ② sharp(frame).extract(cropRect)                                      → cropBytes
        │
        ▼   image.edit(cropBytes, label, imageSize derived from cropRect)
   ③ patch — asserted to be ≥ cropRect; downscaled to cropRect exactly
        │
   ④ paste back: sharp(ORIGINAL).composite([{ input: regionSlice, left, top }])
                 .removeAlpha()          ← LOAD-BEARING, see below
        ▼
   final image — every pixel outside the marked regions equal to the original
```

### 4.1 Paste back per **REGION**, not per crop

This is the subtle one and it is the entire guarantee. The crop is **padded**, so it contains a ring
of pixels the model saw and re-rendered but was never asked to change. Compositing the whole patch
would silently import that drift into a ring around every edit.

Compositing **only the region rectangle** means the padded ring is used for context and then thrown
away, and the property becomes: *pixels outside `editRegions` are equal to the original, by
construction.*

**Proven, against an adversarial provider** that perturbs every single pixel of the crop
(A4 phase 0, offline, synthetic 24MP frame, zero cost, no athlete pixels):

```
frame:   4000x6000 (24.0 MP)     crop: 1843x1085 @ (1121,2310) = 2.00 MP
OUTSIDE the mask:  0 of 23,313,600 pixels differ   (max delta 0)  → PIXEL-IDENTICAL
INSIDE  the mask:  686,400 of 686,400 changed                     → fully patched
orientation:       4000x6000 in, 4000x6000 out                    → PRESERVED
```

Also verified across **all 8 EXIF orientations**: a marker painted at a known display-space position
is patched at exactly the drawn coordinates every time.

### 4.2 `.removeAlpha()` after `.composite()` is load-bearing, not tidiness

`sharp.composite()` **promotes the pipeline to RGBA**. Without `.removeAlpha()`, every edited asset
silently gains an alpha channel its source never had — changing file size, and changing what
`parseImageSize`, the media pipeline and every downstream consumer see.

The first run of the A4 proof reported *23,313,432 of 23,313,600 pixels differing, max delta 255* —
a near-total **false** mismatch, entirely from this. So the test asserts **channel and dimension
parity before diffing a single pixel**, and throws rather than compares if they disagree. A "proof"
that assumes buffer geometry can report a confident falsehood in either direction.

### 4.3 Crop **per region**, not one union box

Two 300×300 logos in opposite corners produce an **18.6 MP** union box — a single crop is then the
whole frame, and the whole frame is the thing we are leaving. So each region gets its own crop, its
own call and its own paste-back. Bounded at 3 by `MAX_REGIONS`.

Cost becomes N calls. At three regions and 2K that is ~$0.40 — **which the quote must reflect**, and
which §5's fix makes expressible.

### 4.4 Say "pixel-identical", never "byte-identical"

After a paste-back, the region outside the mask is **pixel**-identical. Re-encoding a JPEG changes
every byte of the file even when every pixel is equal. The 99.6% figure in §0 is a whole-file
comparison — the changed region plus the re-encode account for the remainder. "Byte-identical"
appears in `SourceAsset.editRegions`' docstring and it should not be a sentence anyone repeats to a
brand.

### 4.5 No feathering in v1

A hard rectangular seam at the region edge can be visible, and a 2–4px alpha feather hides it — at
the cost of "outside is exactly equal" being true only outside the feather band. Ship the hard,
provable property; look at real output; add feathering as a measured decision if seams actually
show, restating the claim honestly at the same time. Trading a testable guarantee for a cosmetic one
before seeing a single real frame is the wrong order.

---

## 5 · ⚠️ THE PRICING FIX (D3) — mandatory in this PR

### 5.1 Why it cannot wait

`config.ts:158` hardcodes `tokensPerImage = 1120` for every tier. **This PR is the first to ship a
size above the default**, so this PR is where it has to be fixed.

The dangerous part is *which* direction it errs. Both money guards read **the same estimate**:

```ts
if (preview.cost.amountUsd > approvedCostUsd) throw overCeiling(...)   // her approval
if (Number.isFinite(cap) && preview.cost.amountUsd > cap) throw ...    // the house cap
```

So **one wrong number defeats both.** She approves $0.13 and is billed $0.24, and the house limit
never fires either. Under-quoting is the direction the entire spend boundary exists to prevent.

Note the receipt was *already* honest: `costFromUsage` in the vertex adapter recomputes from the
tokens Vertex actually reported. **The invoice was right and the quote was wrong** — which is exactly
why nothing caught it. Same class as the Veo audio SKU fix.

### 5.2 The fix, using the mechanism that already exists

`studio/pricing.ts` already resolves a **SKU from `providerParams`** — `wantsAudio()` reads
`providerParams.parameters.generateAudio`, the same field the adapter spreads into the request body,
*"so the SKU we price and the SKU we buy are the same value by construction rather than by
agreement."*

`imageSize` gets the identical treatment, one field over:

- `tokensPerImage` becomes a **function of size**: `1K`/`2K` → 1120, `4K` → 2000.
- `estimateCost`'s `per_image_token` arm resolves the size from
  `providerParams.generationConfig.imageConfig.imageSize` — the same object the adapter merges into
  the wire body — and uses `price.tokensPerImage` as the 1K/2K default when nothing names a size.
- `detail` names the size, so the "why" line reads `1 × ~2000 tok (4K) × $0.00012/tok`.

**`512px` is not published. Do not invent it.** Map it to 1120 and say so in `detail` — over-quoting,
in the direction the file already states is the safe one ("*being billed less than quoted surprises
nobody*").

**The `STUDIO_TOKENS_PER_IMAGE` override stays working**, including `=0` → `unpriced`, because that
escape hatch is how a per-token model reports honestly when we have no figure. It becomes the 1K/2K
base; the 4K figure gets its own override.

### 5.3 Tests

Pure, no harness: 1K/2K → $0.1344; 4K → $0.24; unset → today's number unchanged; `=0` → `unpriced`;
`n` and references still fold in. Plus one that pins **the same `providerParams` object** through
`plannedInputs` → `estimateCost` → the adapter's request body, so the priced SKU and the bought SKU
cannot drift.

---

## 6 · INTENT ROUTING — how the flow knows it is an edit

### 6.1 `deriveIntent` is the right shape and the wrong inputs

`client/lib/studio-contract.ts:184` already exists and is already tested:

```ts
const hasSourceFrame = refs.some((r) => r.role === "source-frame");
return hasSourceFrame ? "image.edit" : "image.generate";
```

It is dead because `engineIntentFor` hardcodes generate, and `engineIntentFor` hardcodes generate
for a **mechanical** reason that this PR removes: an edit needs a `sourceAssetId` *and* at least one
measured region, and Create anything has no mask editor, so an edit routed out of it was a 400 or a
permanently-blocked verdict. **Auto-mask is exactly what unblocks it.**

### 6.2 ⚠️ But the role alone cannot decide it — the `source-frame` collision

Documented in the repo as `TODO(mila)`: **one tile, two meanings.**

| Screen | `source-frame` means | Maps to |
|---|---|---|
| `CampaignWorkspace` | "the frame being **edited**" | the edit base |
| **Create anything**, Setup | "this is **me**" | engine role `person` — the identity anchor |

So in Create anything, a `source-frame` attachment on `"put me on a rooftop at dusk"` is a
*generate*, and the same attachment on `"remove the ball"` is an *edit*. **The instruction is what
separates them**, and `deriveIntent` never sees it.

### 6.3 Recommendation: two-stage, cheap gate first

```
instruction + ≥1 source-frame attachment
        │
   ① client heuristic — does this name a change to an existing photo?
      (createAnythingLogic.ts already has exactly this regex shape for its
       product/her gates; this is a third one beside them)
        │  no ──▶ image.generate. No model call. Unchanged behaviour.
        │ yes
        ▼
   ② the SAME preview-route Gemini call that finds the box also confirms
      "is this an edit of the attached photo, and what is the target phrase"
        │  nothing found ──▶ refuse with something she can read (§2.5)
        ▼
      image.edit + regions
```

**Why the server decides and not a client regex:** the fork must be decided in one place, and it is
already one call — the detection call has to look at the photo anyway. A client regex that *also*
decided the intent would be a second authority on the same question, and the two would drift.
The client heuristic is a **cost gate**, not a decision: it only ever decides whether to *ask*.

**What I am not deciding:** renaming or splitting the `source-frame` role. That is the ref-role
decision the repo says is Mia's. This design works with the collision in place, by reading the
instruction.

---

## 7 · The spend boundary — confirmed unchanged

Traced end to end. **`image.edit` already goes through the identical gate**, with no mode-specific
branch anywhere in it:

1. `POST /studio/preview` → `savePreview` persists the verdict and the figure she was shown.
2. `POST /studio/generate` carries `{ previewId }` and **no cost field**; the ceiling is read back
   off our own row (`loadPreview`).
3. `runStudioGeneration` **re-derives** the verdict from the frozen brief, checks it against the
   ceiling and against `maxJobUsd()`.
4. `consumePreview` — one atomic guarded `UPDATE … WHERE consumed_at IS NULL` — claims the approval
   **before** anything billable. A double tap returns the winner's job and bills once.

Three things this PR must not disturb, and one it adds:

- **The composite is post-generation**, so it costs nothing and cannot affect the quote. ✅
- **The quote must reflect the derived `imageSize`** (§5) and **the region count** (§4.3: N crops =
  N calls). ✅ once §3.2 and §5 land.
- **`previewGeneration` stays pure** — the auto-mask call sits in the route, outside it (§2.4). ✅
- **NEW:** the auto-mask call is a real, if tiny, spend that happens **before** any approval exists.
  It cannot be inside the approved ceiling, because it is what *produces* the thing being quoted.
  It must be memoized (§2.4) and it must be logged through `costLog` like every other model call, so
  it shows up in the spend rollup rather than being invisible. **Flagged as the one genuinely new
  spend surface in this PR.**

---

## 8 · Scope boundary — SESSION-ONLY

**No thread persistence. Nobody wires it early.**

Attachments are local component state plus route params; `useStudioThreads` is a stub. An edit
result lands in `media_assets` as `draft` exactly as a generate does, and the conversation that
produced it is not persisted. Thread persistence is deliberately the **last** phase and is out of
scope here.

Concretely, this PR does **not**: add a threads table, write conversation turns, make an edit
resumable across app launches, or chain edit N+1 onto edit N's output as a session. The last one is
the tempting one — it looks like one more line — and it is the thing that quietly requires
persistence.

---

## 9 · Files

### Server

| File | Change |
|---|---|
| `server/studio/autoMask.ts` | **NEW.** Instruction → target phrase + change label; one `GEMINI.flash` JSON call; `box_2d` (0–1000, Y-first) → `RegionFraction[]`. IO confined to one function; the conversion is pure. |
| `server/studio/composite.ts` | **NEW.** `cropFor(region, frame)` (pad, clamp, cap), `extract`, patch fit-check + downscale, per-region `composite` + `.removeAlpha()`. Pure arithmetic separated from the sharp IO. |
| `server/studio/preview.ts` | `plannedInputs` derives `imageSize` from the brief (§3.2). `buildPrompt` gains a crop arm (§3.1); the existing edit arm untouched. |
| `server/studio/pricing.ts` | `per_image_token` resolves size from `providerParams` (§5.2). |
| `server/studio/config.ts` | `tokensPerImage` becomes size-aware; 4K override env. |
| `server/studio/generate.ts` | The composite step, between the router's return and `storeAsset`. `assertEditKeptItsShape` now runs on the **pre-composite** patch (post-composite it is trivially the source's shape and would assert nothing). |
| `server/routes/studio.ts` | Preview route resolves auto-mask before `previewGeneration`, memoized; new refusals. |
| `server/studio/imageSize.ts` | Correct the stale "sharp is imported nowhere" comment (§1.1). Comment only. |

### Server tests — where the weight goes

| File | Proves |
|---|---|
| `composite.test.ts` | **The guarantee.** Synthetic frame, adversarial patch, **channel + dimension parity asserted before diffing**, then zero differing pixels outside the region. This is the most valuable test in the plan. |
| `autoMask.test.ts` | `box_2d` Y-first conversion on a **non-square box on a non-square frame**; 0–1000 → 0..1; malformed/empty/over-count model output → refusal, never a widened box. Model mocked. |
| `pricing.test.ts` | The §5.3 table. |
| `routes/studio.test.ts` | PGlite: an auto-masked edit preview → regions frozen in the brief; tenancy (another athlete's `sourceAssetId` → 404); the memoization does not leak across athletes. |

### Client

| File | Change |
|---|---|
| `client/screens/studio/createAnythingLogic.ts` | The edit heuristic (§6.3 ①) — a third gate beside the product and her gates. |
| `client/lib/studio-contract.ts` | `engineIntentFor` takes the instruction; `deriveIntent` reconciled. Its long "why never edit" note gets rewritten rather than deleted — it is a true account of why this was blocked and of what unblocked it. |
| `client/hooks/use-studio-pending.ts` | Send `sourceAssetId` when the intent is edit; drop the "NO sourceAssetId, ever" comment with its reason. |
| Make it screen | Show the derived region — what will change, before she approves (§2.4). |

**No schema change. No migration. No new dependency. No deploy-config change.**

---

## 10 · Verification

### Live (the acceptance run)

Attach a real photo in Create anything → type "remove the soccer ball" → send.

1. Output is **full-res** — same dimensions as the source, not 848×1264 and not 85% linear.
2. **1:1 comparison**: `sharp` diff of source vs output → **zero** differing pixels outside the
   region rectangle; the ball gone inside it.
3. **DB receipt**: `generation_jobs.mode = 'edit'`, `source_asset_id` set, `brief.job.source
   .editRegions` holding the derived box, `media_assets.derived_from_asset_id` pointing at the
   source.
4. **The quote matches the invoice**: `cost_estimated_usd` on the job vs the tokens Vertex reported
   in the cost log. This is the D3 fix proving itself on a real run.

### Gates
`npm run check:types` · `npm run lint` · `npm run check:format` · `npm test`
(jest scoped to touched files, **`--runInBand`** — the PGlite suites need it.)

UI on both surfaces: iOS Simulator and phone-width Chrome.

---

## 11 · Open decisions — your call

1. **Where the auto-mask call runs.** Recommended: **preview route, memoized** (§2.4). The
   alternative — generate-time — makes preview free again but means she approves a box she never
   saw, and `brief.ts:544` blocks an empty-region preview anyway. I do not think the alternative
   works, but the cost-in-a-free-gate change is yours to accept.
2. **Is 4K the default, or is size derived from the crop?** Recommended: **derived** (§3.3). Typical
   edits run at 2K for 56% of the cost. 4K stays reachable, and stays correctly quoted either way.
3. **Can she correct the auto-box?** `MaskEditor` exists and could be seeded with the derived
   region. Recommended: **show it, allow correction** — it matches the existing "refuse and show
   her, never clamp silently" posture. Costs UI work.
4. **The crop-cap band.** `geometry.ts` *warns* at 25% of frame area and never blocks; a 2MP crop cap
   on a 24MP frame refuses at ~8%. There is a band where she is told "fine" and then refused.
   Recommended: **downscale that region's crop to fit**, degradation named in the preview `detail`.
   Only the patched region loses detail; the guarantee holds.
5. **`source-frame` role collision** (§6.2) — Mia's, not mine. This design works with it in place.
6. **Detection returns >3 regions** — take the top 3 by confidence, or refuse and ask her to be more
   specific? I lean refuse: a wrong third box is a silent edit in a place she did not ask about.
7. **`CampaignWorkspace`'s fate.** This replaces it as the real path. Does it get removed in this
   PR, left as the manual-mask escape hatch, or removed in a follow-up? Recommended: **leave it**
   this PR — deleting a working door in the PR that opens a new one doubles what a rollback has to
   undo.

---

## 12 · What I am least sure about

- **Detection quality on athlete photos specifically.** Conversational segmentation is documented
  and the box format is stable, but I have not run it on a real 24MP action shot with motion blur
  and a ball at the frame edge. §10's live run is the first real evidence. If quality is poor, §11.3
  (she can correct the box) stops being a nicety and becomes required.
- **Seams at the region boundary** on textured backgrounds (grass, crowd). §4.5 ships without
  feathering on purpose, but this is the thing most likely to send us back.
- **Whether one crop per region is enough context** for edits that need global lighting continuity.
  `CONTEXT_PAD` is a starting guess in a named constant, tuned on real frames.

---

## 13 · Reversibility

Safe to be live the moment it merges. Everything new is on the `image.edit` path, which is reachable
today only from `CampaignWorkspace` with a hand-drawn mask — and that path is unchanged by
construction (§3.1 adds a prompt arm rather than editing the existing one). Create anything cannot
route an edit until `engineIntentFor` changes, which is one function.

The pricing fix (§5) is a strict correction in the safe direction and is independent of everything
else here. **If any of this slips, §5 should still ship.**

---

## 14 · Out of scope, flagged not fixed

**`migrations/0038_deal_deliverables.sql` is not wired into the deploy.** PR #338 shipped the
migration file and the `shared/schema.ts` table, but `.github/workflows/deploy.yml` on `main` does
not run it. Drizzle names every column of a table in the SQL it generates, so a table in `schema.ts`
that never reached the DB breaks every insert *and* every bare select on it — which is what the
deploy's own drift-gate comment says it is there to catch.

There is an **uncommitted local edit** to `deploy.yml` that adds exactly this migration. Deploy
config is out of scope and ships to prod, so I have **not** touched it, committed it, or included it
in this branch. Raising it because a merged PR's table may not exist in the live database.

---

# 15 · BUILD ADDENDUM — what stages 1–3 changed about the plan

Recorded here rather than edited in above, the way the A4 plan's Phase 0 addendum is: the plan is a
record of what was decided, and this is a record of what running it corrected.

## 15.1 §4.4 was not strong enough. "Pixel-identical" is only free if you never re-encode.

The plan said to say *pixel-identical* rather than *byte-identical*, which was right and was not
sufficient. **A JPEG output re-encodes the whole frame**, so pixels outside the region are not
identical either, and shipping the phrase unqualified would have been a false claim in a file that
reads as the contract. Measured on a detailed synthetic 24MP frame, diffing every subpixel outside
the composited region:

| encode | max delta | output |
|---|---|---|
| sharp defaults | **116** / 255 | — |
| q92 4:2:0 (what the source itself was) | 55 | 7.4 MB |
| q95 4:4:4 | 14 | 10.5 MB |
| **q100 4:4:4** | **4** | 20.3 MB |
| PNG (lossless) | **0** | **59.9 MB — over the 25 MB store cap** |

Three things fall out, and none was visible from the plan:

1. **Chroma subsampling is the damage, not quality.** q100 at 4:2:0 still moved a pixel by 91; q92
   at 4:4:4 moved it by 22. `4:4:4` is load-bearing on this path and is now pinned by a test.
2. **Lossless output is not available at 24MP.** A PNG of a real frame is over twice the store cap,
   so "just write PNG" — the obvious way to keep the guarantee exact — fails the primary use case.
3. **One encode setting is not enough either.** q100 4:4:4 on a real camera JPEG lands near the
   25 MB cap, so a single setting would fail a full-res edit with "over the media size cap". The
   encoder now steps a measured ladder, deterministically, and logs the rung.

So the honest claim, and what the code and tests now say: **exact for a lossless source, and
measured-and-bounded (max delta 4/255) for a JPEG one — the container, not the model.** The
`editRegions` docstring in `brief.ts`, which said "byte-identical", is corrected to match.

The store cap itself is shared code and is **read, never raised** — `saveBuffer` takes a `maxBytes`
override, and taking it would put a 40 MB object in every athlete's library on this module's say-so.
**Proposal, not taken here:** a larger cap for studio edit outputs specifically. It is a real storage
and download cost and it is Mia's trade to make.

## 15.2 §3.3's crop ceiling is grounded now, and it is an AREA

The plan reasoned about a "long edge" and inherited A4's 2 MP figure from a different provider.
Neither survives contact: `imageSize: "4K"` does not cap the long edge, it caps the **area** at about
4096² and distributes it by aspect ratio — which is why a 4000×6000 frame came back 3392×5056
(17.1 MP against a nominal 16.8). So `MAX_PATCH_PIXELS` is 4096², derived from the observed
behaviour of the knob we are actually turning, and the size derivation in stage 4 compares areas.

## 15.3 One decision the plan left open resolved itself downward

§11.2 asked whether 4K should be the default. With the crop ceiling expressed as an area, a typical
1.3–2.0 MP crop sits inside **2K** (4.19 MP nominal) — so the derived size is 2K for ordinary edits,
at 1120 tokens rather than 2000. 4K is reachable and correctly priced; it is not the common path.

## 15.4 What is NOT built yet

Stages 4 and 5 — the wiring. `composite.ts` and `autoMask.ts` are called by nothing; `imageSize` is
priced correctly but nothing sets it. Held deliberately for review before it propagates.
