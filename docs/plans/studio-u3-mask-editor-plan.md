# U3 — Mask editor: making "Edit a photo" run

**Branch:** `adi/studio-u3-mask-editor` (off `main` @ `7df4aa7`, U1 #286 / upload #287 / U2 #291 / cost-accuracy #301 all in)
**Status:** PLAN ONLY — nothing built, nothing committed.
**Flag:** `studioEnabled()` server / `STUDIO_ENABLED` client. Unchanged, still default-off.

---

## 0. What I found before planning, because it changes the shape of the work

Three facts from reading the existing path. The first two are load-bearing; the plan below is
built around them rather than around the brief's assumed model.

### 0.1 There is no alpha mask. The mask is TEXT in the prompt.

`server/studio/preview.ts:232` is the entire masked-composite mechanism:

```ts
if (job.mode === "edit" && job.source?.editRegions.length) {
  const regions = job.source.editRegions
    .map((r) => `${r.label} (at ${r.left},${r.top}, ${r.width}x${r.height})`)
    .join("; ");
  parts.push(`CHANGE ONLY: ${regions}. Reconstruct what sits underneath from the surrounding surface.`);
}
```

Neither adapter sends a mask image — `grep -rn "mask" server/studio/adapters/` returns nothing.
`image.edit` means "reference image + a retouch-only instruction". The source frame reaches the
model as a **signed URL to the full-res original** (`referencesFor` → `src.ref` → `gcs_path`,
resolved by `generate.ts:108`).

**Consequence for U3:** `editRegions` must be in the **original pixel space of `gcs_path`**, and
they are consumed as language, not geometry. That is what makes the coordinate question real —
and it surfaces a second problem in §0.3.

### 0.2 The "stored asset's real dimensions" are usually absent, and never verified

The brief assumes the server can re-validate regions against the asset's true size.
`resolveSource` (`server/routes/studio.ts:242`) already selects `mediaAssets.width/height`. But:

| Asset origin | `width`/`height` | Why |
|---|---|---|
| `connected` / `discovery` (ingested IG — the bulk of a library) | **NULL** | `server/skills/rehostAthleteMedia.ts` never writes them |
| `upload` (U1 #287) | Whatever the client sent | `server/routes/media.ts:226` — `typeof width === "number" ? width : null`, stored unverified |

Both columns are `integer("width")` — nullable — in `shared/schema.ts:924`.

So the server today **cannot** honestly bounds-check a region: for most photos it has no
dimensions at all, and where it has them they are a client assertion, which is precisely the input
class the tenancy rule says never to trust. This is the single biggest thing to solve, and it is
why my recommendation for (a) goes further than "do the math on the server".

### 0.3 The prompt never tells the model the frame's dimensions

`CHANGE ONLY: competitor swoosh (at 2125,2345, 780x780)` is uninterpretable without knowing the
frame is 4000×6000. Today no `editRegions` exist so this has never fired. U3 is what makes it
fire. Absolute pixel coordinates handed to a multimodal model with no stated frame size is a
coin-flip on whether the mask lands where it was drawn — the same failure mode as a bad scale.

`preview.ts` is the masked-composite logic you told me not to modify, so **this is a proposal in
§7, not a change in this plan.** Flagging it because U3 is dead on arrival without a decision:
we can get the client→server mapping perfectly right and still have the model misread the numbers.

### 0.4 Smaller: the `EditRegion` docstring contradicts the tests

`brief.ts:75` — *"A region of the source frame, in the frame's own **displayed** pixel
coordinates."* Both fixtures (`brief.test.ts:63`, `preview.test.ts:36`) use `2125,2345 780×780`
against a 4000×6000 source — i.e. **original** pixels, not displayed. The tests are right and the
comment is wrong. Doc-only, in the contract file → proposal, §7.

---

## 1. Answers to your three open questions

### (a) Client-side or server-side coordinate mapping? — **Server, and the server must establish the dimensions itself.**

Three-part recommendation:

**1. The wire carries NORMALIZED FRACTIONS (0..1), not pixels.**

The client sends `{ label, left, top, width, height }` as fractions of the image's own extent.
Fractions are **scale-invariant by construction**, which kills the entire failure class rather
than computing around it:

- device pixel ratio — irrelevant, never enters the number
- `resizeMode="contain"` letterboxing — the client subtracts the letterbox to get the drawn rect,
  so a fraction is of the *image*, never of the container
- thumbnail vs. original — the athlete could be shown a 400px preview or a 4000px one; same fraction
- aspect ratio — carried by the two axes independently, no shared scalar to get wrong

A pixel-based wire needs the client and server to agree on a scale factor. A fraction needs them
to agree on nothing. There is no off-by-scale to have.

**2. Fractions become pixels in exactly one place: `resolveSource()`.**

That function already owns "re-read this asset under the authenticated athlete", it already holds
the row, and it is the only producer of `SourceAsset`. Mapping there means the pixel coordinates
that enter `assembleBrief` — and get frozen into the preview row, and replayed by `/studio/generate`
— were computed by the server from server-held dimensions, every time. No second path.

**3. The dimensions come from the BYTES, not the row.**

Given §0.2, "multiply by `row.width`" is multiplying by NULL most of the time and by a client
claim the rest. So: read the image header out of GCS and derive the true size.

- Ranged read of the first 64 KB via `bucket.file(path).createReadStream({ start: 0, end: 65535 })`
  — `server/lib/mediaStore.ts` already holds the `bucket` handle. Not a full 4000×6000 download.
- Parse JPEG `SOF0/1/2`, PNG `IHDR`, WebP `VP8/VP8L/VP8X`. **A pure function over a Buffer** —
  which is exactly the kind of thing jest can prove, and it is where I want the test weight.
- **Not `sharp`.** It is in `package.json` (`^0.34.5`) and installed, but `grep` finds zero imports
  anywhere in the repo — it is vestigial. Making a native module load-bearing on Cloud Run for a
  header read is a deploy risk I would rather not introduce for four struct offsets.
- The resolved size goes onto the `SourceAsset` we build, so the **frozen brief records the exact
  geometry basis** that produced the job. Recoverable after the fact, no schema change.
- **If the size cannot be established → refuse the edit** with a real sentence. Never clamp, never
  fall back to the client's number, never guess. An unbounded region is the exact "loose crop
  moved the panel layout" failure the spike warned about.

**What I am NOT proposing:** writing discovered dimensions back to `media_assets.width/height`.
It is a shared table, backfilling it is a data change outside Mila/Studio's lane, and it is not
needed — the brief carries the basis. Noted in §7 as something Mia may want.

**What stays client-side:** display layout only. The client needs the drawn image rect (to convert
a finger position into a fraction), which it gets from `Image.getSize(url)` + the measured
container. That number never leaves the device and nothing downstream trusts it — if it were
wrong, the box would look wrong to the athlete *while she is drawing it*, which is a self-correcting
error, not a silent one.

### (b) One region or multiple? — **Multiple, capped at 3.**

`editRegions` is already `EditRegion[]`; `brief.ts:429` checks `.length`; `buildPrompt` already
joins with `"; "`. The whole path is plural end to end — forcing one would mean adding a guard to
narrow something that already works. And "swap the competitor logo on the ball *and* the one on
the sleeve" is one real edit, not two jobs.

Capped at 3 because each region is prompt text competing for the model's attention, and the spike's
discipline is about keeping the changed area small and specific. Cap enforced server-side (a 400),
mirrored in the UI as "add region" disabling at 3.

### (c) How is tight-mask discipline enforced? — **A warning, plus a live readout. Not a snap, not a block.**

- **Not a snap.** Snapping needs something to snap *to* — subject/object detection we do not have
  in this path. Snapping to nothing relocates her box for reasons she cannot see, which is worse
  than a loose box she chose.
- **Not a hard block.** Some legitimate edits are genuinely large (sky, background wall). A block
  would make U3 refuse work it can do.
- **A warning, computed server-side, so it is in the frozen brief and jest-tested.** Region area
  > 40% of the frame, or the union of regions > 50%, pushes a `degraded` gap:
  *"This covers most of the shot — an edit that large re-renders more than it preserves."*
  It rides the existing `warnings` array that `PreviewPanel` already renders. Zero new UI contract.
- **A live readout while dragging** — "18% of the photo" under the box, turning amber past 40%.
  Teaching the constraint at the moment of the decision beats explaining it in a doc afterwards.
- **A hard 400 at the small end**: a mapped region under 8px on either side in original space is a
  mis-tap, not an intent. Rejected, not silently used.

Thresholds are constants in `geometry.ts` with the spike's reasoning written above them, so they
are tunable from one place once you have run it on real frames.

---

## 2. The flow, end to end

```
SourcePicker (exists, reused as-is)     — she picks a photo she owns
        ↓ assetId
MaskEditor (NEW)                        — full image, drag a box, name it
        ↓ regions as FRACTIONS 0..1
POST /studio/preview  { ..., regions }
        ↓
parsePreviewBody      (edited)          — shape/type/count/range validation
resolveSource         (edited)          — ① re-read row by (id, athlete_id)
                                          ② establish TRUE dims from bytes
                                          ③ fractions × dims → original px
                                          ④ bounds + min-size check → 400
                                          ⑤ area check → degraded warning
        ↓ SourceAsset { width, height, editRegions: [absolute px] }
assembleBrief         (untouched)       — blocking gap now SATISFIED
previewGeneration     (untouched)       — buildPrompt emits CHANGE ONLY
savePreview           (untouched)       — brief FROZEN with the mapped px
        ↓ previewId
POST /studio/generate (untouched)       — replays the frozen brief
        ↓
GenerationResult      (untouched)       — draft → approve/reject, as U2
```

Everything from `assembleBrief` rightward is **already built and already tested**. U3 adds the
left half and one mapping step. The dead-button fix is the removal of the `NOT_AVAILABLE_YET`
branch in `humanize()` — that message exists only because nothing could produce regions.

---

## 3. Files

### Server

| File | Change |
|---|---|
| `server/studio/geometry.ts` | **NEW.** Pure. `mapRegions(fractions, {width,height})` → px \| `RegionError`; bounds, min-size, area thresholds. No IO, no imports from db/gcs. |
| `server/studio/imageSize.ts` | **NEW.** `parseImageSize(buf)` — pure JPEG/PNG/WebP header parse. Plus a thin `probeImageSize(gcsPath)` doing the 64 KB ranged read. IO isolated to one 8-line function. |
| `server/routes/studio.ts` | `parsePreviewBody` accepts + validates `regions`; `resolveSource` gains dims-resolution and calls `mapRegions`; `humanize()` loses the `NOT_AVAILABLE_YET` branch (`unavailable` field and its shape stay — the client contract does not change). |

### Server tests (this is where the verifiable work lives)

| File | Proves |
|---|---|
| `server/studio/geometry.test.ts` | **NEW.** 0.5/0.5/0.2/0.2 on 4000×6000 → `2000,3000,800,1200`; a 4000×6000 *and* a 6000×4000 frame (the spike's two orientations); region overflowing right/bottom edge → rejected, **not clamped**; negative/`>1`/`NaN` → rejected; sub-8px → rejected; 45%-area → warning, 20% → none; union threshold; rounding is stable and never pushes a region past the edge. |
| `server/studio/imageSize.test.ts` | **NEW.** Real JPEG (incl. progressive `SOF2` and an EXIF-heavy header), PNG, WebP fixtures → correct dims. Truncated/garbage buffer → `null`, never a throw. Fixtures are **synthetic**, generated in-test. |
| `server/routes/studio.test.ts` | **EXTENDED.** ① Athlete B sends A's `sourceAssetId` with valid regions → 404, A's `gcs_path` never echoed. ② Out-of-bounds region → 400 with a readable field error, no preview row written. ③ Valid regions → 200, `editRegions` present, no longer blocked, and the **persisted preview row's frozen brief holds the mapped ORIGINAL pixels** — the assertion that catches an off-by-scale reaching the model. ④ Undeterminable dims → refusal, not a guess. ⑤ >3 regions → 400. ⑥ Still writes nothing billable. |

Run scoped and `--runInBand`, per the PGlite note.

### Client (diff-read + your manual run — no jest roots touched)

| File | Change |
|---|---|
| `client/components/studio/MaskEditor.tsx` | **NEW.** Image + box overlay. `react-native-gesture-handler` + `reanimated` + `react-native-svg` — all already deps, **no new dependency**. |
| `client/screens/CampaignWorkspaceScreen.tsx` | Render `<MaskEditor>` under the existing `SourcePicker` when `intent === "image.edit"` and a source is chosen; hold `regions` state; `invalidate()` on any region change (same rule as every other brief edit); pass `regions` to `preview.mutate`. `SourcePicker` itself untouched. |
| `client/hooks/use-studio.ts` | `PreviewRequest.regions?: { label: string; left: number; top: number; width: number; height: number }[]` (fractions) + a doc line saying so. |

**Not touched:** `package.json`, jest config, `IntentPicker.tsx`, `GenerationResult.tsx`,
`StudioContentStrip.tsx`, `use-media-library.ts`, media routes, the pitch-deck engine,
`router.ts`, both adapters, `brief.ts`, `preview.ts`, `generate.ts`, `approval.ts`, `jobs.ts`,
`shared/schema.ts`, `.github/workflows/**`, `gcp/**`.

---

## 4. The mask UI, concretely

- Image at `m.url` (full signed original, not `thumb_url`), `resizeMode="contain"` in a
  fixed-aspect container. `Image.getSize` gives intrinsic dims → compute the drawn rect →
  letterbox offsets subtracted before any fraction is taken.
- Drag to draw. Drag a corner handle to resize, drag the body to move. Reanimated worklets only
  (never the legacy `Animated` API).
- Live "18% of the photo" readout under the active box; amber past 40%.
- Each region takes a short **label** (`"logo"`, `"competitor swoosh"`) — required, since it goes
  into the prompt verbatim and an unlabeled region tells the model nothing about what to change.
  Trimmed, length-capped, and it is *her* text on *her* photo, so it stays `origin: "system"` /
  `untrusted: false` — consistent with the `direction` field's reasoning in `brief.ts`. It is **not**
  prefilled from anything external; if that ever changes it must route the `inbound` door.
- "Add region" up to 3; per-region delete.
- Pills, `BorderRadius.lg`, Feather icons, no blur, no emoji, `Outfit_*` paired with every
  `fontWeight`. Per `DESIGN.md`.
- Empty state before a box exists: *"Drag a box around the part you want changed."*

---

## 5. Tenancy — unchanged contract, restated for the new input

- `athleteId` from `req.athleteId!`. Not in `PreviewRequest`, not in the body, nothing to send wrong.
- Source re-resolved by `(id, athlete_id, status='stored', deleted_at IS NULL)`. Not-yours and
  not-found stay the same 404 — a different answer confirms another athlete's asset exists.
- Regions are validated against dimensions **the server derived from the object it just
  authorized**, so the geometry cannot be checked against a frame she does not own.
- Nothing from the client reaches `SourceAsset` except the fractions, and those are range-checked
  before they are multiplied by anything.
- No new query in this plan is unscoped by `athlete_id`.

---

## 6. Out of scope — where each would plug in

| Deferred | Seam |
|---|---|
| **Edit a U2-generated image** | Genuinely close: a generated asset is already a `media_assets` row with `origin='generated'`, and `derived_from_asset_id` already exists in `shared/schema.ts:911` for the lineage. It needs (i) `GenerationResult` to offer "Edit this", (ii) a nav to `CampaignWorkspace` with `intent:"image.edit"` + `sourceAssetId` — **both params already exist** in `StudioStackParamList:156` — and (iii) `SourcePicker`'s `useMyMedia("photos")` to include `origin=generated`. No engine change. Not in U3. |
| **Brush / lasso / polygon** | `EditRegion` is a rectangle contract. A freeform mask changes the A2 schema *and* needs a real alpha channel through the adapters — i.e. §0.1 stops being true. Different piece of work. |
| **Freeform canvas, layers, compose** | Not a masked composite. Different primitive. |
| **Video edit** | `taskForPair` already forbids it; edit is stills-only by design. |

---

## 7. Proposals — I will not make these; they are yours to apply or hand to Mia

1. **`buildPrompt` should state the frame size** (§0.3). Either append `FRAME: 4000×6000` to the
   `CHANGE ONLY:` line, or express the region as percentages. Without one of these the mapping can
   be perfect and the mask still land wrong. **This is a `preview.ts` change — your lane, and I
   think it's the highest-value line in this document.** My preference: percentages, because the
   model has no pixel ruler and a fraction needs no frame of reference.
2. **`EditRegion` docstring says "displayed"; the contract is original pixels** (§0.4). Doc-only in
   `brief.ts`.
3. **`rehostAthleteMedia` never records dimensions** (§0.2), so every ingested photo has NULL
   `width`/`height`. Out of Studio's lane, real blast radius (a backfill over every athlete's
   library). U3 works around it with the header probe; worth Mia knowing it exists.
4. **Upload dimensions are client-asserted and unverified** (`routes/media.ts:226`). Not exploitable
   in U3 — the probe overrides them — but it means that column should not be trusted anywhere else
   either.

---

## 8. Gates

- `npx tsc --noEmit` whole-project.
- `npx jest server/studio/geometry.test.ts server/studio/imageSize.test.ts server/routes/studio.test.ts --runInBand`
- `npm run lint`, `npm run check:format`.
- Manual on both surfaces (iOS Simulator + phone-width Chrome) — yours.
- Commit on `adi/studio-u3-mask-editor`. **No push, no PR.** Pause after build for review.

## 9. Reversibility

Flag-off is unchanged: `requireStudio` 404s the route, `STUDIO_ENABLED` hides the surface. No
migration, no DDL, no script, no send, no deploy-config change. The only behaviour change on an
existing path is `humanize()` losing a message that was only ever a placeholder for this work.

---

## 10. What I am least sure about

- **The header probe's cost and failure rate on real ingested frames.** 64 KB should cover a JPEG
  `SOF` marker, but an EXIF/ICC-heavy header can push it past that. Mitigation: on a parse miss,
  one retry at 256 KB, then refuse. I would rather find this on your real library than assume it.
- **Whether 40% is the right area threshold.** It is a guess dressed as a constant. The spike's
  ball-crop failure is one data point; I have not seen the frames.
- **Whether §7.1 makes U3 conditional.** If you decide the prompt must state the frame size, that
  edit lands in `preview.ts` before U3 can honestly be called working. I would rather ship the
  mapping and have you make that call than quietly edit the file I was told to leave alone.
