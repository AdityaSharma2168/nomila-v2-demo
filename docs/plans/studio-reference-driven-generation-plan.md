# Reference-driven generation & editing — typed reference roles

**Branch:** `adi/studio-reference-gen` (off `main` @ `bb6898d` — U3 #311, upload-fix, U2, cost-accuracy all in)
**Status:** BUILT, then AMENDED. §11 is what verification changed during the build; **§12 is what
shipping changed after it, and it removes a feature this plan is largely about — read it first.**
**Flag:** `studioEnabled()` server / `EXPO_PUBLIC_STUDIO_ENABLED` client. Unchanged, still default-off.
**Ledger:** #2 — typed reference roles, and the flattening bug that makes them unenforceable today.

---

## 0. What I found before planning, because two findings change the shape of the work

### 0.1 The flattening is real, and it is one line

`server/studio/preview.ts:390` is the whole bug:

```ts
references: references.map((r) => ({ kind: "url", url: r.ref }) as ImageRef),
```

`PlannedReference` carries `{ role, ref, label }`. `ImageRef` is `{kind:"url", url}` or
`{kind:"bytes", bytes, mimeType}`. The role and the label are dropped at the boundary, so by the
time either adapter sees the list, **array position is the only surviving signal** — and neither
adapter uses it for anything except order. `vertex.ts:170` spreads every reference into
`contents[0].parts` in whatever order it arrived; `openrouter.ts:129` does the same into
`input_references`. Nothing downstream can distinguish the frame from a product shot from a mood
board.

That is fixable and it is the core of this PR.

### 0.2 THE FINDING THAT MATTERS MOST: there is no typed slot on the wire for our model

I checked this rather than assuming it, because the whole no-face-leak claim rests on it.

**Google does ship a typed reference-image API** — `SubjectReferenceImage`, `StyleReferenceImage`,
`ControlReferenceImage`, and a `SubjectReferenceType` enum with `SUBJECT_TYPE_PERSON` /
`SUBJECT_TYPE_PRODUCT` / `SUBJECT_TYPE_ANIMAL`. It is in the package this repo already depends on:

```
node_modules/@google/genai/dist/genai.d.ts:9675   ReferenceImage = RawReferenceImage | MaskReferenceImage
                                                  | ControlReferenceImage | StyleReferenceImage
                                                  | SubjectReferenceImage | ContentReferenceImage
node_modules/@google/genai/dist/genai.d.ts:10862  enum SubjectReferenceType { SUBJECT_TYPE_PERSON, ... }
```

**But it hangs off `EditImageParameters` (line 3378: "The reference images for Imagen 3 editing"),
not off `generateContent`.** It is the Imagen capability endpoint — a different model
(`imagen-3.0-capability-001`), a different method, a different price. Our route is
`gemini-3-pro-image` via `:generateContent`, where reference images are **plain inline image parts
in `contents[0].parts` with no type field at all.**

Google's own docs confirm the same thing from the other direction: the per-model limits are
expressed as prose capacities — objects / characters / style references — over an untyped list, and
the guidance for telling the model which image is which is *to describe them in the prompt text*
("Using the attached napkin sketch as the structure and the attached fabric sample as the
texture"). There is no field to set.

**Consequence, and it is the answer to your question (a):** "route it to the provider's CHARACTER
slot" is not a thing our provider offers. A "slot" for us is three things we control — **the
position in the parts array, the label in the prompt manifest, and the per-role cap** — and zero
things the provider enforces. §1(a) states what that makes the guarantee.

### 0.3 The per-model capacities I read do not agree with each other

Your numbers: Pro `5 character + 6 object + 3 style`; Flash `4 + 10 + 3`.

Google's table on `ai.google.dev/gemini-api/docs/image-generation` renders with the columns shifted
depending on how it is scraped; two reads of the same page gave me two different answers for
whether **Gemini 3 Pro Image supports style references at all** (one read: "style references not
listed / N/A" for Pro; a secondary source: 3 style refs for Pro). Flash's `4 / 10 / 3` matched your
numbers exactly in both reads.

This matters because `nanoPro` is the **default route for both `image.generate` and `image.edit`**
(`config.ts:routes()`), so if Pro genuinely has no style capacity, the influence ref on the default
model is an inline image governed by nothing but the prompt. §1(a) and §10 carry this; the design
puts the capacity table in `config.ts` behind an env override so correcting it is one value, not a
code change.

### 0.4 Reference count does not move the dollar estimate, today or after this change

`estimateCost` (`pricing.ts`) prices `per_image_token` from `n × tokensPerImage × rate`. It never
reads `inputs.references`. `router.estimate()` puts the *count* on `GenerationPlan.inputs.references`
— which is why the client can already render "N references" — but the count reaches no arithmetic.
On the return leg, `costFromUsage` (`vertex.ts:213`) sums only
`candidatesTokensDetails[modality=IMAGE]`, i.e. **output** tokens; `promptTokenCount` is ignored.

So input images are unpriced on both the before and the after number. Adding five references makes a
generation genuinely cost more and we will quote it identically. That is not new — but this PR is
what makes it *load-bearing*, because references go from "occasionally one brand cover" to "the
primary input". §2.6 handles it the only honest way available: name it in the `detail` basis line
rather than invent a rate, and log `promptTokenCount` so the rate can be *measured* later the way
`tokensPerImage: 1120` was.

### 0.5 A frozen brief can outlive a deploy

`studio_generation_previews.brief` is jsonb with a 30-minute TTL, and `runStudioGeneration` re-derives
the whole verdict from **that stored object**, not from the request. A preview taken before this ships
and generated after it lands will have no `job.references` key. Every read of the new field must be
`?? []`. Not a nicety — it is the difference between a deploy and a deploy that 500s in-flight taps.

---

## 1. Your three open questions

### (a) Is no-face-leak a HARD guarantee or best-effort? — **Best-effort. Strong, layered, testable in our half; not absolute.**

Plainly: **you cannot tell a brand "a stranger's face can never leak from a mood board."** You can
tell them something narrower that is completely true, and I would put that sentence in front of
them instead:

> An image the athlete tags as inspiration is never sent to the model as a person reference, is
> never described to it as anyone, is capped and positioned separately from identity references,
> and always travels with an explicit instruction that no person in it may appear in the output.
> We do not rely on image ordering to keep them apart.

Here is what each layer actually buys, so the line between the two is visible:

| Layer | What it enforces | Hard? |
|---|---|---|
| 1. Role survives UI → brief → planner → adapter as typed data | An influence ref is *identifiable* at every stage. Kills §0.1. | **Hard** — types + tests |
| 2. `slotFor()` maps `influence → "style"`, never `"character"`/`"frame"` | An influence ref cannot occupy an identity position | **Hard** — pure function, tested |
| 3. Parts array ordered BY SLOT, not by insertion | Manifest numbering matches the wire by construction; a reordered client array cannot shift a mood board into the identity position | **Hard** — adapter-level, tested |
| 4. Per-role caps from `config.ts`, over-cap ⇒ blocking gap | Bounded, and never a silent drop | **Hard** — refusal we author |
| 5. Prompt manifest labels the influence ref STYLE ONLY + "no person from this image" | The model's actual behaviour | **BEST-EFFORT.** An instruct model can disobey |
| 6. (Not built — §7) vision pre-check on influence refs | Would let us *refuse* a mood board with a prominent face | Would be hard-ish, costs a model call |

Layer 5 is the only place a face can leak, and there is no API surface on `generateContent` that
closes it. The two things that *would* move it are both real decisions for you, not for me:

- **Layer 6 — a pre-flight vision check.** Cheap Gemini call on each influence ref, refuse if a face
  is prominent. This breaks the rule that *the preview spends nothing*, which is the property the
  whole approval design rests on. It could sit at **upload** time instead of preview time, where
  enrichment already runs a vision pass (`enrichNextChunk`) and already writes
  `athlete_present`/`shot_type` — so we may be able to read a face signal we are **already paying
  for**. That is worth checking before anyone writes a new model call. Out of scope here; flagged.
- **Switching the influence path to Imagen's typed `StyleReferenceImage`.** A genuinely typed slot
  (§0.2). But: different model, different price, different quality, and *even then* Google does not
  promise a style reference contributes no person — it is still a conditioning signal, not a filter.
  It would upgrade "we labelled it" to "the API labelled it". It would not reach "cannot happen".

**My recommendation:** build layers 1–5 now, write the narrow sentence above into the brand-facing
copy, and treat layer 6 as the follow-up that gets you closer. Do not let anyone write "guaranteed"
on this.

### (b) Do refs need persistence? — **No. Per-job, no schema change, no DDL.**

Three facts make this easy:

1. The **pixels are already durable**. Every ref is an upload, which means a `media_assets` row with
   `origin='upload'` and a permanent `gcs_path`. Nothing about a ref is lost when a job ends.
2. The **tagging already has a home**. The brief is frozen into `studio_generation_previews.brief`
   and `generation_jobs.brief`, both `jsonb`. A `JobReference[]` on `BriefJob` rides there for free,
   which means **zero migration, zero DDL, nothing for you to apply**, and it gets the replay
   property for nothing: the job that runs is the job that was quoted, references included.
3. The tag is **job-scoped by meaning**. The same photo of her is `person` in one job and could
   plausibly be `influence` in another (her own past post used as a vibe reference). A persisted
   role would be a lie the second time.

The one argument for persistence is ergonomic — re-tagging the same three photos every session. If
that turns out to bite, the cheap answer is a **client-side recent-references list**, not a table.
A "saved ingredient sets" library is a real feature and a different lane (new table, new routes, new
tenancy surface). I would not smuggle it in here.

**Flag, per your instruction to say if I disagree:** I do not. Per-job, and I am confident.

### (c) Does tagging need a default? — **No default. Force the choice — but make it one tap, and make "untagged" a not-ready state, never an error.**

The tag is the safety boundary. A default assigns a safety property she did not choose, and the
specific default you floated is the dangerous direction: *"first upload defaults to person"* means
**someone who uploads a mood board first has their mood board silently declared an identity
reference.** That is precisely the failure this whole feature exists to prevent, installed as a
default.

The friction argument is real but small, and the screen already has the exact pattern for it. An
edit today needs every drawn box labelled, and an unlabelled box does not error — it disables the
check and shows a hint:

```
client/screens/CampaignWorkspaceScreen.tsx:110
const canCheck = !needsSource || (!!sourceAssetId && labelledRegions.length === regions.length && ...)
```

Same shape here: an untagged reference tile renders visibly incomplete, `canCheck` is false, and the
hint reads *"Say what each photo is for."* One tap on a three-chip row clears it. Nothing red,
nothing lost.

---

## 2. The design

### 2.1 Vocabulary — three names, three layers, deliberately not the same name at each layer

| Layer | Type | Values |
|---|---|---|
| What she tags (`brief.ts`) | `ReferenceRole` | `person` · `product` · `influence` |
| What the planner resolved (`preview.ts`) | `PlannedReference.role` | `source-frame` · `person` · `product` · `influence` · `brand-imagery` |
| What the adapter places (`types.ts`) | `RefSlot` | `frame` · `character` · `object` · `style` |

They are kept distinct on purpose. Her vocabulary is product language and should be free to change
without touching the wire. The planner's vocabulary has to hold **both** her uploads and the
brief-derived references that already exist (`product` from `PieceReference`, `brand-imagery` from
the brand's own gallery) — and `product` deliberately keeps its current name and meaning so no
frozen brief in the previews table is invalidated. The adapter's vocabulary is about provider
capacity and nothing else.

```ts
// server/studio/preview.ts — the whole mapping, one pure function, exhaustively tested
function slotFor(role: PlannedReference["role"]): RefSlot {
  switch (role) {
    case "source-frame":  return "frame";
    case "person":        return "character";
    case "product":       return "object";
    case "influence":     return "style";
    case "brand-imagery": return "style";   // ← see 2.2
  }
}
```

### 2.2 A quiet safety win worth naming: brand imagery is style too

`referencesFor` already ships `brand-imagery` — a brand's cover and gallery images — into the
untyped list. Brand campaign photography **routinely contains models**. Today those images are
indistinguishable from a subject reference, exactly like an untagged mood board.

Mapping `brand-imagery → style` puts them under the same style-only instruction as an influence ref,
which means this PR closes a face-leak path that already exists in production code, not just the one
it is introducing. Worth stating in the PR description.

### 2.3 Where the refs live: on the brief

```ts
// server/studio/brief.ts
export type ReferenceRole = "person" | "product" | "influence";

export interface JobReference {
  role: ReferenceRole;
  /** Stored GCS PATH — never a signed url. Same rule as SourceAsset.ref: this object is logged and frozen. */
  ref: string;
  /** The media_assets uuid it was resolved from. Provenance + cost-log ids. */
  mediaAssetId: string;
  /** Her own words. Trusted: origin "system", her text on her photo — same reasoning as BriefInput.direction. */
  label?: string;
}

interface BriefInput { /* … existing … */ references?: JobReference[]; }
interface BriefJob   { /* … existing … */ references: JobReference[]; }   // always present, may be empty
```

On the brief and not as a side input to the router, exactly as you specified — and the reason is
mechanical rather than aesthetic: **`previewGeneration`, `estimate`, the blocking gate,
`savePreview` and `createGenerationJob` all read the brief and only the brief.** A side input would
be invisible to the preview she approves and absent from the frozen record the spend replays from.

**A2 behaviour is preserved exactly.** `mode`, `source`, `direction`, `origin`, the per-piece
`PieceReference` product slots, every gap rule — untouched. This adds one array.

### 2.4 The order, and why order stops being a signal while still being deterministic

`referencesFor` emits in slot order, always:

```
frame (edit only, max 1)  →  character  →  object  →  style
```

Then the adapter **re-sorts by slot before building the request**. Both, deliberately: the planner's
order is what the prompt manifest numbers against, and the adapter's sort is what makes that
numbering true no matter how the array arrived. Ordering goes from *the only signal* to *a derived
consequence of the typing* — which is the actual fix for ledger #2. The test that matters is: hand
the adapter a deliberately shuffled array and assert the influence ref is never at position 1 and
never adjacent-to-identity.

### 2.5 The prompt manifest — layer 5, the best-effort half, written to be as strong as prose gets

`buildPrompt` gains one block, emitted only when references exist:

```
REFERENCES — each image below has exactly one job, and only that job:
  Image 1 — THE FRAME being edited. Every pixel outside the marked regions stays as it is.
  Image 2 — HER LIKENESS (Jordan Reyes). This is the person to render. Her face, hair and build
            come from this image.
  Image 3 — PRODUCT: "the M charm". Render this exact object. Do not substitute or redesign it.
  Image 4 — STYLE ONLY. Take colour grade, light, lens feel and composition from this image.
            Do NOT copy any person, face, body, hair or clothing from it. Nobody who appears in
            this image appears in the output.

No person may be taken from a STYLE ONLY image. If a style image contains people, they are
reference for lighting and framing only and must not be rendered.
```

Two properties: the numbering matches the parts array **by construction** (§2.4), and the style-only
rule is stated twice — once per image and once as a standing rule — because a single mention buried
in a list is the weakest form of this instruction.

Untrusted text handling is unchanged. Her labels are `origin: "system"` and go in verbatim, on the
same reasoning `direction` already carries (`brief.ts:BriefInput.direction`). **The seam stated
there applies here identically:** the moment a ref label is prefilled from an inbox message or a
brand email, the job is inbound-origin and the label must be fenced by `delimited()` like the ask.
I will restate that in the docstring so it cannot be missed.

### 2.6 Cost and preview — the count is honest, the dollars are unchanged, and that is said out loud

- `plan.inputs.references` already carries the count; the client already renders it. The copy
  becomes *"conditioned on N references"* rather than a bare count.
- The dollar figure **does not move with reference count** (§0.4). Rather than invent a
  per-reference rate, `estimateCost`'s `detail` gains a clause naming it:
  `"… + 4 reference images (input tokens — not priced here)"`. The "never a hard number, basis
  shown" discipline is exactly what this preserves: the basis line stops being silently incomplete.
- `costLog` records `promptTokenCount` from `usageMetadata`. Free instrumentation, and it is the
  measurement that would let a real per-reference rate be *derived* later the way
  `tokensPerImage: 1120` was measured rather than guessed.
- **Spend boundary unchanged.** Refs are brief inputs. No new billable call, preview still spends
  nothing, the approval/consume path is untouched.

### 2.7 Caps

`config.ts` gains one table, env-overridable, seeded with your numbers:

```ts
export function refCapacityFor(model: string): { character: number; object: number; style: number; total: number }
// nanoPro   → { character: 5, object: 6, style: 3, total: TOTAL }
// nanoFlash → { character: 4, object: 10, style: 3, total: TOTAL }
// unknown   → conservative floor
```

Over a per-role cap ⇒ a **blocking gap** with a readable note, never a silent slice. (Today
`referencesFor` ends in `.slice(0, max)` — a silent drop, which for a person ref means quietly
generating something that no longer looks like her.)

`TOTAL` is **not** the model's 14. Vertex has no url form for our refs — `toInlinePart`
(`vertex.ts:150`) fetches every reference and base64s it into the request body — so fourteen
full-resolution uploads is a tens-of-megabytes payload built in memory inside a Cloud Run request,
on top of the source frame. **I propose a total of 6 for v1** (frame + 5), on payload and latency
grounds rather than model grounds, env-overridable. Flagging it as mine to justify, not Google's.

### 2.8 What I am NOT doing

- Not requiring a reference for `image.generate` at the engine level. That would change behaviour
  for `runConceptGeneration`, which is the deck engine's path and out of lane. Instead: a
  **`degraded` gap** when a generate carries no `person` ref ("nothing anchors this to you"), and
  the workspace leads with the picker. The product gets "always from reference" through the UI and
  the warning; the engine keeps its existing contract.
- Not adding img2img / base-image-for-generation. Per your scope.
- Not touching the pitch-deck engine, `concept.ts`, `shared/schema.ts`, `package.json`, jest config,
  `.github/workflows/**`, `gcp/**`.

---

## 3. Files

### Server — engine

| File | Change |
|---|---|
| `server/studio/types.ts` | `RefSlot` type. `ImageRef` gains optional `slot?: RefSlot` and `label?: string` on **both** union members. Optional so nothing existing breaks; the planner always sets it. |
| `server/studio/brief.ts` | `ReferenceRole`, `JobReference`. `BriefInput.references?` → `BriefJob.references` (`?? []`). Validation: role allowlist, per-role + total caps, refs allowed in **both** modes. New gaps: over-cap (blocking), generate-with-no-person (degraded). Docstring restating the untrusted-label seam. |
| `server/studio/preview.ts` | `PlannedReference.role` widened. `slotFor()`. `referencesFor` merges job refs with the existing source-frame / product / brand-imagery refs and emits in slot order, applying per-role caps. `plannedInputs` sets `slot`+`label` on each `ImageRef` — **the flattening fix, §0.1**. `buildPrompt` emits the manifest + standing rule. |
| `server/studio/config.ts` | `refCapacityFor(model)` + `STUDIO_REF_CAPS_JSON` / `STUDIO_MAX_REFERENCES` overrides. |
| `server/studio/adapters/vertex.ts` | Sort references by slot before building `contents[0].parts`. No new wire field — there isn't one (§0.2). |
| `server/studio/adapters/openrouter.ts` | Same sort into `input_references`. |
| `server/studio/generate.ts` | `resolveStoredReference` handles the new roles: job refs are GCS paths → signed url; the `source-frame` orient branch is unchanged. `refIds` carries job ref ids. |
| `server/studio/pricing.ts` | `detail` names the reference count as an unpriced input (§2.6). |
| `server/studio/costLog.ts` | `inputRefs` gains `roles?: string[]`; record `promptTokens` when the provider reports it. |

### Server — route

| File | Change |
|---|---|
| `server/routes/studio.ts` | `PreviewBody.references?: { assetId: string; role: string; label?: string }[]`. Validated (role allowlist, count cap **before** any query, label trimmed + length-capped) then **re-resolved under `req.athleteId`**. Extract the ownership read `resolveSource` already does into a shared `readOwnedImage(athleteId, assetId)` used by both — the predicate is identical and duplicating it is how one copy later loses a clause. |

### Server tests — where the verifiable work is

| File | Proves |
|---|---|
| `server/studio/preview.test.ts` (extended) | Every role → its slot, exhaustively. **`influence` never yields `character` or `frame`** — the no-face-leak routing test, asserted directly and again through `plannedInputs`. Order is slot-derived. Per-role cap over-run ⇒ blocking gap, not a silent slice. The manifest enumerates in the same order as `inputs.references` and contains the style-only rule. `brand-imagery → style`. A frozen brief with **no** `job.references` still plans (§0.5). |
| `server/studio/adapters/vertex.test.ts` (extended) | A deliberately shuffled reference array leaves as parts in **slot order**; the influence part is never first and never in an identity position. `slot`/`label` never appear as fields on the wire body. |
| `server/routes/studio.test.ts` (extended) | ① Athlete B passes A's `assetId` as a ref → **404, A's `gcs_path` never echoed**. ② Unknown role → 400. ③ Over the total cap → 400, before any DB read. ④ Valid refs → 200, and the **persisted preview row's frozen brief holds server-resolved paths and the roles she chose**. ⑤ Still writes nothing billable. |
| `server/studio/brief.test.ts` (extended) | Refs land on `job.references`; gaps fire correctly; A2's existing assertions unchanged. |
| `server/studio/generate.test.ts` (extended) | Refs resolve under auth at run time with roles intact; the source-frame orient branch still fires for an edit that also carries refs. |

PGlite suites scoped and `--runInBand`, per the standing note.

### Client — diff-read + your manual run. No jest root, no `package.json`, no jest config.

| File | Change |
|---|---|
| `client/components/studio/ReferencePicker.tsx` | **NEW.** Upload/pick tiles + a three-chip role row per tile. |
| `client/screens/CampaignWorkspaceScreen.tsx` | Mount it for **both** generate and edit; hold `references` state; `invalidate()` on any change (same rule as every other brief edit); extend `canCheck` for untagged refs; pass `references` to `preview.mutate`. |
| `client/hooks/use-studio.ts` | `StudioReferenceRole`, `PreviewRequest.references`, doc lines. |

---

## 4. The compose UI, concretely

**The one visual job:** *ingredients* (person, product — things that appear) must read as a
different category from *influence* (a vibe, never the people in it). Not three equal chips in a
row.

- Two labelled groups on one strip: **"What's in it"** (person · product) and **"The vibe"**
  (influence), separated, with the influence group carrying its own one-line explanation:
  *"We'll take the look — never the people."* That sentence is the whole feature explained in seven
  words, and it belongs on the screen and not just in a doc.
- Per tile: a role chip row, one tap, no default (§1c). Untagged tiles show a dashed outline and a
  "Tag this" affordance.
- An influence-tagged tile gets a persistent small caption — *"Look only"* — so the promise is
  visible on the thing itself while she works, not only at the moment she tags it.
- Optional short label per tile ("the charm", "my kit"), same trim/cap treatment as a mask region.
- Caps surface as a full state: *"That's the most product photos this model takes (6)."*
- `DESIGN.md`: pills min-width 120, `BorderRadius.lg` cards, Feather icons only, **no emoji**, no
  blur, reanimated only, `Outfit_*` paired with every `fontWeight`.
- Empty state: *"Add the photos this should be built from."*

**Both surfaces verified by you** — iOS Simulator and phone-width Chrome.

---

## 5. Tenancy — the A2 contract, restated for the new input

- `athleteId` from `req.athleteId`. There is **no** athlete field in `PreviewRequest`, unchanged.
- Every ref arrives as an **assetId only** and is re-resolved by the same predicate `resolveSource`
  uses: `(id, athlete_id = req.athleteId, status='stored', deleted_at IS NULL)`. Not-yours and
  not-found are the **same 404** — a different answer confirms another athlete's asset exists.
- **No client-supplied path ever reaches `JobReference.ref`.** The path comes from the row.
- Count is capped **before** the resolution loop, so a hostile body cannot amplify one request into
  N queries.
- Paths, never signed urls, on the brief — it is logged and frozen (`costLog.safeRef`'s rule).
- At generate time the refs are replayed from the **frozen brief**, which `loadPreview` already
  scopes by `athlete_id` — so a ref path can only ever be re-signed by the athlete it was resolved
  for.
- No new query in this plan is unscoped by `athlete_id`.

---

## 6. Out of scope — and where each would plug in

| Deferred | Seam |
|---|---|
| **img2img (base image for generate)** | Per your scope. `mode` already forks; it would be a third mode, not a flag on generate. |
| **Persisted ref sets / "my ingredients"** | New table + routes + tenancy surface. §1(b). |
| **Vision pre-check on influence refs** | §1(a) layer 6 — and check `enrichNextChunk`'s existing vision pass first; we may already be paying for a face signal. |
| **Imagen typed `StyleReferenceImage`** | Real typed slot, different model + price + quality. §0.2. |
| **Video refs** | Veo takes only a first-frame image (`vertex.ts:generateVideo`); a typed multi-ref model has no meaning there yet. Video is still held inline anyway. |

---

## 7. Proposals — I will not make these; yours to apply or hand to Mia

1. **Brand-facing copy must not say "guaranteed".** §1(a) has the sentence I believe is true.
2. **`enrichNextChunk` may already give us a face signal** on uploads (`athlete_present`,
   `shot_type`). If so, layer 6 is nearly free and needs no new model call. Worth an hour to check;
   it is media/enrichment lane, not Studio's.
3. **Input tokens are unpriced everywhere** (§0.4) — this predates the PR and affects the concept
   path too.
4. **`referencesFor`'s `.slice()` silently drops references** today. This PR replaces it with a
   refusal for job refs; the brand-imagery tail keeps the slice, which is the right call for
   art-direction extras but is worth knowing about.

---

## 8. Gates

- `npx tsc --noEmit` — whole project.
- `npx jest server/studio/preview.test.ts server/studio/brief.test.ts server/studio/generate.test.ts server/studio/adapters/vertex.test.ts server/routes/studio.test.ts --runInBand`
- `npm run lint`, `npm run check:format`.
- Manual on both surfaces — yours.
- Commit on `adi/studio-reference-gen`. **No push, no PR.** Pause after build for review.

---

## 9. Reversibility

Flag-off is unchanged: `requireStudio` 404s the surface, `EXPO_PUBLIC_STUDIO_ENABLED` hides it.
**No migration, no DDL, no script, no deploy-config change, no new dependency** — the refs ride
existing jsonb. Safe live with the flag off.

The one behaviour change on an existing path with the flag **on** is §2.2: brand imagery starts
landing in the style slot with a style-only instruction. That is a safety improvement, and it is the
only thing here that alters an already-working generation.

---

## 10. What I am least sure about

- **Whether Nano Banana Pro has a style capacity at all** (§0.3). Two reads of Google's own table
  disagree, and Pro is the default model — so if it has none, the influence path on the default
  route is prompt-only and even weaker than §1(a) describes. The cap table is env-overridable so the
  fix is a value, but **I would want this confirmed before the brand-facing sentence is written.**
- **How well an instruct model actually honours "no person from this image."** I have no measurement
  and I am not going to assert one. A cheap way to find out before shipping: three or four real runs
  with a mood board that has an obvious face in it, at ~$0.13 a run. I would rather buy that answer
  than write a doc that assumes it.
- **Whether total-6 is the right ceiling** (§2.7). It is a payload judgement, not a measurement.
- **Whether "no default tag" survives contact with real use** (§1c). I believe the safety argument
  wins and the mask-label precedent supports it, but you will know within a day of using it.

---

## 11. Build addendum — what verification changed

Two open questions were settled by checking rather than by assuming. Both were checked before any
code was written, because both determined what got built.

### 11.1 The reference mechanism — VERIFIED, and it is prose-only

Checked against the actual `@google/genai` 2.7.0 type surface, not an AI overview.

**A `Part` — the only container a reference image can travel in on `:generateContent` — carries:**
`mediaResolution`, `codeExecutionResult`, `executableCode`, `fileData`, `functionCall`,
`functionResponse`, `inlineData`, `text`, `thought`, `thoughtSignature`, `videoMetadata`,
`toolCall`, `toolResponse`, `partMetadata`. **There is no type, role or reference-kind field.** The
single free-form field, `partMetadata`, is documented *"This field is not supported in Vertex AI"* —
which is our transport.

The typed machinery is real but lives elsewhere: `SubjectReferenceImage`, `StyleReferenceImage`,
`SubjectReferenceType.SUBJECT_TYPE_PERSON` hang off `EditImageParameters` — *"The reference images
for Imagen 3 editing"* — a different model on a different endpoint.

**So: prose-only, and the best-effort posture is confirmed, not assumed.** "14 references accepted"
and "a typed style slot" are unrelated claims, and only the first has any support.

**On the max:** there is no `maxImages` constant anywhere in the package, and the endpoint enforces
no limit we can read. So the cap table is explicitly OUR refusal, seeded from Google's documented
per-kind capacities, env-overridable, with a conservative floor for unknown models — and `total: 6`
is ours on payload grounds (`toInlinePart` base64s every reference into the request body). **Nothing
is hardcoded to 14.**

### 11.2 The face signal — IT ALREADY EXISTS, so the warning shipped

`routes/media.ts` kicks `enrichNextChunk` on every upload → `server/lib/visionTag.ts` runs Gemini
Flash and writes `media_assets.metadata.vision`. Reading it costs **one more column on a query the
route already runs** — no new model call, and the preview still spends nothing.

**But it is a proxy, and the code says so.** `visionTag`'s prompt never asks "are there people in
this image"; it asks whether *the athlete* is the subject, for media-kit casting. So the signal is
derived from `shot_type` (`portrait`/`group`) plus `athlete_present`, and a face in the background
of a `lifestyle` frame reads as clear — a known false negative.

That produced a **third state rather than two**: `people` warns, `clear` says nothing, and
`unknown` (enrichment is fire-and-forget, so a photo added seconds ago genuinely has no tags) says
so out loud. Collapsing `unknown` into `clear` would turn "we have not looked" into "we looked and
it is fine", which is the only dishonest option available.

### 11.3 One bug this found in my own work

The cost log recorded reference slots in the CALLER's order while the adapters send them in slot
order — so a log line would have disagreed with the request it claims to describe. Caught by the
test that asserts the logged order, fixed by routing the log through the same `orderBySlot`. Worth
noting because that line's entire value is being readable later as evidence of what a generation was
conditioned on.

### 11.4 Gates, honestly

- `npx tsc --noEmit` whole-project: **clean** for this work. Pre-existing, unrelated: `@langfuse/*`
  and `@opentelemetry/sdk-node` are declared in `package.json` but were not installed in the working
  tree, so `server/lib/tracing.ts` and friends do not resolve. Running `npm install` (declared deps
  only, no new packages) fixes it locally; the lockfile churn it produced was reverted.
- Tests: **476 passing across 17 suites**, run as `NODE_OPTIONS=--experimental-vm-modules ... --runInBand`.
- `npm run lint`: **zero errors in every file this touches.** The repo reports 58 errors and 887
  warnings elsewhere, all pre-existing.
- `npm run check:format`: fails on **592 files repo-wide** and did so at `bb6898d` — including the
  five studio files here, before any edit. Not fixed: `npm run format` would produce a 592-file diff
  that has nothing to do with this work.

---

## 12. What shipped, and the feature this plan describes that no longer exists

Read this before §1-§10. Three commits followed the original build, and the second one removes the
`influence` role that most of this document is written around.

### 12.1 The edit output came back rotated — and it was none of the three suspected layers

Diagnosed before touching anything, because the layer had been guessed wrong before.

| Layer | Finding |
|---|---|
| Bytes SENT to the model | **Upright.** A fresh upload is straightened in place at ingest, so `probeImageSize` reports orientation 1, `resolveStoredReference`'s orient branch is a no-op, and the signed url serves the already-upright object. The base was never the problem. |
| What the model RETURNS | **The rotation is in its own bytes.** `saveBuffer` is pure passthrough — no re-encode, no `sharp`, no thumbnail — display renders that stored object, and the model returns PNG, which carries no EXIF orientation. There is no layer between the model and the screen able to flip anything. |
| The transposed-output guard | **Not bypassed.** `assertEditKeptItsShape` runs on the edit path. But it measures SHAPE and only refuses, so it is a backstop, never a cause — and it is blind to a rotated picture inside a correctly shaped canvas. |

**The root cause was upstream of all three: an edit was sent with no aspect ratio at all.**
`plannedInputs` gated `aspectRatio` on `mode === "generate"`, on the reading that "an edit inherits
the frame" — true of the reference we send, false of the image we get back. `:generateContent`
composes a new picture every time; asked for no canvas it picks one.

Fixed on the way IN: an edit now states the source frame's own ratio, snapped to the closed set the
model accepts (`1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9` — read off `ImageConfig.aspectRatio` in
the SDK), compared in **log space** so a portrait frame is not biased toward square. An unmeasured
frame asks for nothing rather than guessing; the guard stays behind it.

**A premise worth correcting, because it was in the brief:** ingest does not *record* the base
image's orientation, it *destroys* it. There is no `orientation` column on `media_assets`, and a
normalized upload's orientation is 1 — so there is nothing to rotate the output back by. Correcting
a transposed return post hoc would mean choosing between +90 and −90 with no signal, wrong half the
time, on an image that already cost money. Prevention beat the coin flip.

One existing test asserted the old behaviour ("and none when editing"). It was **inverted rather
than deleted** — that assertion is why the bug shipped: the behaviour was pinned as correct.

### 12.2 The `influence` role is GONE

§1(a), §2.1, §2.2, §2.5 and §4 of this plan describe a three-role vocabulary and a layered
best-effort face-isolation posture. **The third role no longer exists.** Faces leaked from look
references on gemini-3-pro-image, observed live.

The plan was right about the ceiling — §0.2 verified there is no typed reference field to enforce a
style slot with, so layer 5 was always prose the model could ignore. What it under-weighted is that
the failure was not the leak on its own. It was the **promise**: the picker said *"We'll take the
look — never the people"*, on the screen where she chooses the photo. A best-effort mitigation is
defensible to ship; a guarantee we cannot keep, printed where she acts on it, is not.

So the feature was removed rather than softened. Style direction moved to the brief text, which
`buildPrompt` already carries.

Removed with it: the influence→style mapping, its cap, the three-state people warning and the
vision-tag proxy behind it (`readOwnedImage` no longer selects `metadata` — that column was read for
nothing else), the "Do NOT copy any person" manifest line and its standing rule, and the picker's
THE VIBE group, "Look only" caption and two-group layout.

Two roles remain — `person` and `product` — and everything §1(a) listed as **hard** still holds for
them: the role survives to the adapter, `slotFor` is a total switch, caps refuse rather than slice,
and the parts leave in slot order.

### 12.3 Brand imagery kept the style slot — a separate decision, not a revert

§2.2 flagged this as the one change touching an already-working path, so it was decided explicitly
rather than swept along with the cut.

**It keeps the style treatment.** The look reference was cut for a promise; brand cover and gallery
imagery makes no promise to anyone — the athlete never tags it, never sees it, is told nothing about
it. There is no false claim to retract. Untyping it would give up deterministic placement and a
manifest line that says what the image is for, in exchange for nothing, and before this work it
travelled in the same undifferentiated list as the source frame — strictly worse than where it sits
now.

**What did change is the wording.** The style line is art direction — *"reference for colour, light,
styling and composition. Do not reproduce it."* — and says nothing about people, because that is the
sentence we watched fail. Continuing to write it in the file that reads as the contract is how a
best-effort mitigation gets mistaken later for a control.

### 12.4 The claim that can still be made

§1(a) offered a sentence for brands. It no longer applies to a look reference, because there is no
look reference. What remains true, and is narrower:

> References the athlete tags are placed by type, not by array position: her likeness goes to the
> identity slot, a product to the object slot, and the request states which image is which. What the
> model does with an image is not something we control, and we do not claim to.
