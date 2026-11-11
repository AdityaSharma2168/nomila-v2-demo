# Generation identity — recon + plan (2026-09-15)

Read-only recon on `e8143a4` (server/studio byte-identical to origin/main `bdbd8c0`). $0 spent. No branch, no code.
Probe staged dry: `identityProbe.ts` beside this file.

---

## RECON

### 1. The data we already have — and the data we don't

**QA has never scored a generate. Not one.** `inspectAsset` returns null when `chainDepth === 0`
(server/studio/qa/inspect.ts:118), and `recordGeneratedAsset` writes `derived_from_asset_id = null` for every
generate (studio/generate.ts:1056). The identity check's only pairing is "output face vs chain-root face", and a
generate has no chain. So "generate is worse than edit" cannot be read off the QA record — it has only edits in it.

Within edits, the numbers are bimodal by construction:
- **masked edits** paste her face back byte-for-byte → distance ≈ 0 regardless of the model (2.4a: head-region diff
  0.000, embedding 0.0127);
- **native edits** (`brief->job->editIntent IS NOT NULL`) re-render the whole frame → the only edit scores that say
  anything about the renderer's hold on her face (q2-a full-frame background: 0.3669, inside the band).

**3625060c** (Sept 14, identity:pass on an image.edit): whatever its number is, it is an EDIT score by construction —
QA cannot have scored it otherwise. It is not evidence about generation. (Its sentence/native flag are in the pull
below; not verified because the pull did not run.)

**Drift under the pinned name:** no time series exists. Vertex responses carry `modelVersion`; nothing persists it
(the adapter keeps `raw` in memory only; the cost log stores our model id). Google's docs disagree on whether an
unsuffixed Vertex id is an auto-updated alias. So drift is currently undetectable, not absent.

**Pose class:** taggable from the job's `direction.statement` — but only after the pull.

**The pull is staged, not run.** The auto-mode classifier denied writing it (production read). Three read-only
SELECTs pinned to athlete 3811cedd, session forced read-only — Adi's call to run (see "Staged for Adi").

### 2. The current generate path — what reaches the model

Request (vertex.ts:152–180): `parts = [ref images in slot order (full stored bytes, inline base64)…, {text}]`,
`generationConfig = {responseModalities:[TEXT,IMAGE], imageConfig:{aspectRatio}}`. **No imageSize → 1K.**
No seed, no mediaResolution, no personGeneration.

Prompt (pinned: compile.golden.json "generate — a post with a brand, her likeness and a product"):
```
Generate a single photorealistic image - a post-format social visual for an athlete. …
REFERENCES — …
Image 1 — HER LIKENESS. This is the person to render; her face, hair and build come from this image. Preserve her
exact face and features — the output must be recognisably the same person. Match the angle of the output to the
angle of this reference.
[product / brand-imagery lines]
AUDIENCE: <profile descriptor>. Register: <tier · segment · sport>.
[BRAND / PALETTE / DO / DO NOT]
GOAL: <profile goal>
DIRECTION: <her sentence, verbatim>        (or <requester_brief> fenced, if inbound)
```

What the classifier/compiler does for generate vs edit:

| | edit (native) | generate |
|---|---|---|
| sentence read by rules | yes — ops, targets, values, composition, keep | **no** — rule 0 returns GENERATE before any rule reads it (classify.ts:876) |
| frozen intent | FrozenEditIntent v2 | **none** — the freeze refuses GENERATE (`generate_on_edit`, nativeIntent.ts:261) |
| her words reach model | never — compiled from the intent | **verbatim** in `DIRECTION:` |
| keep ("dont change me") | set aside → `preserve_person` constraint | **skipped** — `route` returns early for GENERATE (classify.ts:3133) |
| prompt lives in | compile/ (goldens, templates) | preview.ts `buildPrompt`, interleaved with the masked arms (TODO: "a split needs its own proof") |
| size | frozen tier | API default 1K |
| QA | scored vs root | **not scored** |

Concrete defects found:
- **The angle sentence.** "Match the angle of the output to the angle of this reference" — on a mid-air or side-on
  generate this directly contradicts her direction. The model has to disobey one of them. Plausible contributor to
  "worst on action"; single-variable probe arm `noangle1`.
- **Multi-ref is already live, unbound.** Caps: `character: 5` on Pro (config.ts:487), total 6. Client: ReferencePicker
  allows any number of "You" tiles; Create Anything maps every non-frame "Your media" attachment to `person`
  (studio-contract.ts:329), MAX_ENGINE_REFERENCES 6. Three You photos today produce three separate "HER LIKENESS. This
  is the person to render…" lines — nothing says they are one person.
- **Full-resolution refs inline.** Refs are fetched and base64'd whole; three 24 MP uploads is ~20 MB of JSON. The
  Vertex inline request limit was not verifiable from docs this session — treat as a risk, downscale refs in R1.
- **Profile boilerplate between identity and scene** (AUDIENCE/Register/GOAL). Precedent that it hurts: job e4814552
  rendered basketball AND soccer because the profile and her sentence disagreed (sportVocab.ts header).
- **No frame, any sentence → GENERATE.** `allowedOps(false, …) = ["GENERATE"]` regardless of wording. Sept 15's
  "change the background as well." generated a random image this way (sessions-client memory; the thread
  continuation fixed the client path, not the server rule).
- **With a frame, generate needs the narrow EXPLICIT_GENERATE shape** (creation verb + a/an/new + artifact noun).
  "put me mid-air doing a bicycle kick, keep my face" with a photo attached reads as an edit — the be5588d9 class,
  where "Keep this exact person…" made an ad request a CHANGE_BACKGROUND. (Static reading; the $0 replay was denied.)

### 3. What the model supports

- gemini-3-pro-image: **up to 5 character images, 6 object, 3 style, 14 total** (ai.google.dev image-generation
  table; Firebase agrees). Our caps already mirror it. Whether the API *enforces* it: undocumented.
- **No typed reference field, no identity/strength parameter.** Vertex ImageConfig = aspect_ratio, image_size,
  person_generation (a safety gate), image_output_options. Attribution is prose + position only (types.ts RefSlot
  note already says this).
- **No documented "same person" wording.** Google's guidance is "clearly define the role of each image"; its own
  multi-image example ("these people") means different people. So R1's binding sentence is ours and must be measured.
- Input cost: 560 tokens/ref ($0.0011). Thinking is always on for Pro (can't be disabled; billed).
- 1K and 2K both bill 1120 output tokens ($0.134); 4K 2000 ($0.24). **2K is free relative to today's 1K.**
- `mediaResolution` exists per-Part on Gemini 3 but nothing documents image models honouring it (pricing fixes Pro
  image input at 560 tokens). Not probed — unverified wire.
- gemini-3-pro-image GA since 2026-05-28; 4K GA 2026-08-31. No newer Google still-image model as of 2026-09-15.

### 4. Model inventory of one photo generation

Every model call in one Create-Anything still, in order. Flags as they ship (STUDIO_INTERPRETER / STUDIO_CREATIVE_QA
default off; both are on paths that never run for a generate anyway).

| # | stage | model | reads or writes | receives | cost | what swapping it could / could NOT change |
|---|---|---|---|---|---|---|
| 1 | `route()` classify.ts | **none** (rules) | — | her sentence | $0 | op + path. Nothing about pixels |
| 2 | interpreter (flag, ASK sentences only; **never a GENERATE**) | gemini-3.5-flash, pinned in studio/config.ts | READS | her sentence (no image) | ~$0.0015 | whether an ask becomes a routed sentence. **Cannot touch identity** |
| 3 | detection `autoMask.detectRegions` (**edit only**) | GEMINI.flash = gemini-3.5-flash | READS | photo + sentence → regions | ~$0.001–0.002 | where an edit lands. **Never runs on a generate** |
| 4 | segmentation (masked edit only) | fal-ai/sam-3/image | READS | one crop + noun → mask | $0.005/region | mask shape. Never on a generate |
| 5 | **RENDER** studio/adapters/vertex.ts | **gemini-3-pro-image** (Vertex, `global`) | **WRITES PIXELS** | refs inline + prompt text | **$0.1344** (1K/2K), $0.24 (4K), +$0.0011/ref input, + thinking tokens | **identity lives here and nowhere else** |
| 6 | QA identity (flag, **edits only**) | face box: gemini-3.5-flash ×2 · distance: **multimodalembedding@001** ×2 | READS | root + output | ~$0.002 | the SCORE. Never the picture |
| 7 | QA anatomy / adherence / marks | gemini-3.5-flash (marks: 5 vision calls) | READS | root + output + instruction | $0.0212/gen stage, marks $0.0154 | scoring fidelity only |
| 8 | thumbnail, composite, orient | sharp (no model) | — | bytes | $0 | — |

**The two-tier split holds, with one correction:** the reader tier is *not* only gemini-3.5-flash. The identity NUMBER
comes from `multimodalembedding@001`; flash only draws the face box. Swapping flash changes where the crop is cut;
swapping the embedding changes the ruler itself.

**The renderer's own knobs** (everything else in the request is fixed by code): `imageConfig.imageSize` (1K→2K is
free), `aspectRatio` (already set per deliverable), reference COUNT (≤5 characters), reference resolution (ours — we
send stored bytes today), and the prompt text. There is no identity, strength or subject-weight parameter on this
API, `personGeneration` is a safety gate, seed/temperature are undocumented for image output, and thinking cannot be
disabled on Pro. **So on the current renderer the prompt and the references ARE the levers — which is exactly R1+R2.**

**Is QA a strong enough ruler?** No, on two counts, and this is the first thing to fix:
1. **It cannot score a generate at all** (no chain root). Zero generate coverage today.
2. **Its discriminating power is unmeasured.** `multimodalembedding@001` is semantic, not face recognition
   (qa/embed.ts says so outright). The calibration measured tier 1 (clean edits), tier 2 (same person, other photo)
   and one tier-3 anchor that turned out not to be a failure at all. **A different-person band was never measured.**
   Until it is, "0.42" means nothing: we do not know what a stranger scores.

**Alternative renderers, and whether any takes multiple references natively.** Nearly all of them do — our
renderer's 5-character cap is mid-pack, not a ceiling anyone else lacks:

| where | model | refs | price | integration cost |
|---|---|---|---|---|
| Vertex (our adapter) | **gemini-3.1-flash-image** | 4 characters | $0.067 @1K | **none** — same wire. Probe arm `flash1` |
| OpenRouter (our adapter, `input_references` is the documented field for `/images`) | `bytedance-seed/seedream-5-0-pro` — **already in our MODELS registry** | 14 | ~$0.045/img | env flip + bytes-not-url for privacy |
| OpenRouter | `openai/gpt-image-2` family | **16** | $30–40/M out tokens | as above |
| OpenRouter | `black-forest-labs/flux.2-pro` | 8 | $0.03/MP | as above |
| fal | `nano-banana-pro/edit` (14 imgs, "resemblance for up to 5 people"), `seedream/v5/pro/edit` (10), `flux-2-pro/edit` (9), `qwen-image-3/edit` (1–3, markets facial-identity preservation), `ideogram/character` (1) | varies | $0.03–0.15 | **new adapter** — fal is segmentation-only today |
| Vertex | Imagen person customization | — | — | **gone**: `imagen-3.0-capability-001` discontinued 2026-06-30 |

Per-model ref limits are machine-readable on OpenRouter (`GET /api/v1/images/models` →
`supported_parameters.input_references.max`), so a swap does not need a guess. **Every one of these means sending
her photographs to a third party** — the rule fal's adapter already encodes (bytes, never a signed url) applies, and
the vendor decision itself is Adi's and Mia's, not an implementation detail.

Recommendation: hold the renderer fixed for R1/R2 (on our path, the prompt and the references ARE the levers), and
carry exactly one cheap renderer arm in the probe — `flash1`, $0.27, zero wire risk. A Seedream or GPT-image arm is
~$0.20–0.50 more and a privacy decision first.

---

## PLAN

## PROBE RESULTS — ran 2026-09-15, $2.1504 billed over two runs (16 images)

**R0.a: the ruler failed its control.** Held-out same-person band on this set (6 pairs) **0.3158–0.4186**. The
no-reference control — an invented person, no photograph of her anywhere in the request — scored **0.3584**
(portrait, face sizeFrac 0.20, a clean full-size face) and 0.354 / 0.364 on action. A stranger lands inside the
same-person band and beats the production arm. **No threshold exists at any value**, and re-scoring an identical
image moved a score by 0.006 (the face box comes from a flash call at default temperature), so the instrument is not
even deterministic. Decision 5 (replace the instrument) is LIVE and Mia's.

**Medians, held-out distance, n=2:**

| arm | portrait | action |
|---|---|---|
| base1 — production, 1 photo | 0.3681 | 0.4561 |
| noangle1 — 1 photo, angle sentence deleted | 0.3849 | 0.4177 |
| **bound3 — 3 photos, bound** | **0.3254** | **0.3764** |
| base0 — no likeness (control) | 0.4229 | 0.3593 |

**The verdict is the eye's, and it replicated.** Adi picked `bound3.portrait.2` and `bound3.action.2` blind; the
sheets were then RE-SHUFFLED with the `noangle1` arm added and he picked **the same two images again**, passing over
`noangle1` in both poses. Two poses, two shuffles, one answer: **the pack wins**.

**The angle sentence is worth about half the action gap and nothing on portrait** (0.4561 → 0.4177 of a 0.0797 gap;
portrait marginally worse). It never won a blind pick, so it is NOT a substitute for the pack — it rides inside R1's
manifest change rather than shipping as its own PR.

**Why the pack wins, best available explanation.** The single reference production uses (`e58f3a5a`) is the outlier
of her seven photos — mean distance 0.4235 to the others, the highest of any, and the smallest face in frame of the
three pack photos (sizeFrac 0.19 vs 0.39 / 0.38). One reference inherits everything idiosyncratic about one
photograph; three make the constant part (her) separable from the variable part (that day's light, hair, crop).
Caveat: that arithmetic uses the same ruler that failed the stranger test.

**Two defects found free, and they are the DEFECTS PR:**
1. **No-reference generates render literal social-media UI** — 3/3 checked came back as Instagram posts (a whole
   iPhone mockup with likes and hashtags, a framed post card, a feed overlay), with invented handles and an invented
   university jersey. Cause is our own header: *"a post-format social visual"*. Live for every generate she makes
   without attaching a photo of herself.
2. **Unrequested real surname on kit** — "McLAUGHLIN" printed across the jersey in **2 of 4** one-reference action
   frames, zero of two `bound3` frames. The name is in no prompt. A named athlete's kit carrying someone else's
   surname is a publicity-rights blocker, not a cosmetic artifact.

**R1 sizing, revised: unchanged at 2–3 days**, now with the angle-sentence deletion folded into the same manifest
commit (it is one sentence and one golden, and the probe already measured it). Nothing in the probe moved the client
half; the picker and Create Anything already send several "You" photos.

---

### R0 — the ruler, before anything is decided by a number

Two pieces, both small, and the first is pennies.

**R0.a — calibrate a different-person band ($0.03–0.05, no generation).** The probe's `--set ctl` arm and/or her
existing no-reference generates give faces that are demonstrably NOT her (invented people — synthetic, no real
person's data involved). Score them with the same instrument against the same held-out set. Outcome:
- if the invented-face band sits clear ABOVE the same-person band → the ruler discriminates, use it;
- if it overlaps → the ruler cannot support any identity sentence, and R1/R2 are judged by Adi's blind picks while a
  better metric is chosen. Options, if the ruler has to be replaced:

| instrument | what it is | cost | catch |
|---|---|---|---|
| **fal AuraFace-v1** | Apache-2.0 ArcFace-style recognizer, published by fal, LFW 0.9965, explicitly cleared for commercial use | $0 per comparison, runs locally | **new dependency** (onnxruntime + weights) — needs your approval |
| **AWS Rekognition CompareFaces** | stateless 1:1 comparison, similarity 0–100 | $0.001/image | new vendor; her face crop leaves for AWS |
| Azure AI Face Verify | gated behind a Limited Access application | — | practically out |
| Google Cloud Vision | detection only — "specific individual facial recognition is not supported" | — | not an option |
| InsightFace buffalo_l / antelopev2, PuLID, InstantID, IP-Adapter FaceID | the usual open stack | — | **non-commercial research weights** — out for a commercial product without a licence |

Same-person thresholds for ArcFace-style cosine land around 0.30–0.45 depending on the false-match rate; whatever we
adopt gets calibrated on her own photographs and reported with its FMR, never taken off a blog.

⚠️ **Legal, and it belongs to Mia, not to us:** the trigger for BIPA (Illinois), CUBI (Texas) and Washington's
biometric statute is *computing a face template*, not storing a photo — Illinois courts treat the faceprint
extracted from a photograph as covered. Even for one consenting athlete, the shape of compliance is a written
release, a published retention/destruction schedule, no sale, and deletion on request; damages are per-violation.
The cheap posture: keep comparisons **stateless or ephemeral**, run them only on the consenting athlete, and don't
persist embeddings. Today's QA is already on the right side of this — it embeds a face crop in memory and stores
only the distance in `media_assets.metadata.creative_qa`, never the vector (`metadata.embedding` from enrichment is
a whole-image semantic embedding, not a face template). Keep that property whatever the instrument becomes.

**R0.b — QA scores generates (small PR, `server/studio/qa/**` only).** `inspectAsset` at depth 0: if the job carries
person references, compare the output face against each reference AND against an identity set (her library photos
with `metadata.vision.athlete_present` and prominence ≥ 0.5, excluding the references), and record
`comparedAgainst: "references" | "identity-set"` in the detail. Still observation-only, still behind
STUDIO_CREATIVE_QA. ~150 lines + PGlite-backed tests. **Without this the product accumulates no generate identity
data at all, and R3's escalation decision has nothing to read.** ~0.5 day.

---

### R1 — multi-photo reference packs

**Design.** Person tile accepts up to N photos of the SAME athlete. The consent boundary is unchanged: several
photographs of one person, never a second person; the edit path keeps refusing person refs outright
(`refusedOnEdit`, preview.ts:394).

1. **Manifest binding** (compile/manifest.ts): with ≥2 character refs, the per-image "HER LIKENESS" lines collapse
   into ONE block naming them as one person, and the angle sentence goes (three references have three angles — the
   instruction is incoherent and, on an action pose, actively harmful). Exact wording = whatever the probe's
   `bound3` arm wins with; it is pinned as a named constant and goldened.
2. **Reference downscale before send** (studio/generate.ts `resolveStoredReference`, person role only): long edge
   2048, JPEG. Today three 24 MP refs are base64'd whole into one request body. The model's input is 560 tokens per
   image however large it is, so this costs no fidelity and removes a payload cliff we have not measured.
3. **The cap** is already config: `defaultRefCapacities` (character 5) plus `STUDIO_REF_CAPS_JSON`. Adi's decision
   sets the default; my recommendation is **3** (Google documents 5; 3 is what the probe measures, and raising it
   later is an env flip).
4. **Consent, honestly:** nothing verifies that a "You" photo is her — that is true of one reference today. Add
   (a) picker copy "photos of you only", (b) a free check that each ref's `metadata.vision.athlete_present` is true,
   (c) an ADVISORY pack-consistency warning (refs whose faces sit outside the same-person band from each other) once
   R0 says the ruler can carry it. Not blocking, and a biometric gate is Mia's call, not ours.
5. **Client:** ReferencePicker already allows multiple "You" tiles and Create Anything already maps every non-frame
   "Your media" attachment to `person` — so this is copy, a count hint, and the drop-notes sentence, not new
   plumbing.

**Not in R1:** a SAVED pack ("this is me", reused across jobs — the B3 note in preview.ts). That needs storage and a
DDL path; it is the obvious follow-up once packs prove out.

**Measurement BEFORE the build** — the probe, `--set r1`: `base1` (production today, 1 ref) vs `bound3` (3 refs,
bound) × {portrait, action} × n=2. It runs **today**, on `identityProbe.ts`, with hand-built requests through
`studio/router` — no product plumbing, no classifier, no preview, no job rows. The scoring reuses QA's own
`faceCrop` + `embedImageBytes` against a held-out set of her photos.

**Acceptance bar (Adi owns the numbers; this is the proposal):**
- primary: median held-out distance on the **action** cell improves by **≥ 0.05** AND the two cells' ranges do not
  overlap;
- guard: the portrait cell does not regress by more than 0.03;
- absolute: the action cell lands **inside the same-person band** (≤ 0.5282) — i.e. no further from her than two
  photographs of her are from each other;
- human: Adi's blind pick (the probe writes shuffled `blind/<pose>/A.png…` plus a key) agrees.
- If the metric fails R0.a, the blind pick is primary and the distance is reported as context only.

**Size:** server ~200 lines + goldens/tests ~300; client ~150–250. **2–3 days**, not 1 — the manifest change touches
every generate golden, and the downscale touches the one function that already refuses rather than falling back.

---

### R2 — generate-side intake (its own PR, and the bigger one)

Today a generate is the only path in Studio where her prose reaches the renderer verbatim and nothing is frozen.
Everything the edit side learned — classify, freeze, compile, goldens, route diff, revert checks — stops at rule 0.

**G.0 — extract, byte-identical.** Move `buildPrompt`'s generate arm out of preview.ts into
`server/studio/compile/generate.ts`. Capture generate goldens FIRST (the 3 that exist plus ~10 new: portrait/action/
airborne/profile, 0/1/3 refs, brand, inbound, keep variants), then move. Proof: goldens byte-identical, route diff 0.
Lands as its own commit so every later diff is readable. ~0.5–1 day.

**G.1 — `FrozenGenerateIntent` (versioned, frozen on the brief, re-checked at spend like the native edit's).**
```
{ version: 1,
  subject:  { who: "her" | "invented", wardrobe: string | null },
  action:   { text: string | null, poseClass: PoseClass },
  setting:  string | null,
  lighting: string | null,
  camera:   { framing: "portrait"|"half"|"full"|null, faceVisible: boolean },
  props:    string[],
  details:  string | null,         // her words the parser did not place — carried, never dropped
  identity: { refs: number, strength: "standard" | "strict", from: "refs" | "keep" },
  imageSize: ImageSizeName,        // frozen, because pricing reads it
  provenance: Record<slot, "hers" | "default"> }
```
Filled by **rules, not a model**: pose/action lexicon, setting prepositions, lighting vocab, framing vocab, wardrobe
via garmentVocab, sport via the existing sportVocab precedence. Deterministic, goldenable, no latency, no spend —
the same discipline that makes the edit side's answers testable. Unplaced words ride in `details` (fenced as her
words) so structuring can never silently drop what she asked for. An interpreter-model slot-fill stays available as
a later flag for high-residue sentences; it is NOT in this PR. ~1.5–2 days.

**G.2 — pinned identity language.** One managed constant block (compile/identity.ts), placed FIRST after the header
and never interleaved with profile boilerplate; pose-tolerant (no angle matching); a face-visibility anchor on the
CAMERA line when references exist and the pose class is not "back". The exact sentences are **whatever the probe's
`struct1` / `noangle1` arms win with** — if `struct1` wins as a bundle, one ablation run (~$0.5) splits it before the
wording is pinned. Profile boilerplate (AUDIENCE / Register / GOAL) moves behind the scene block or goes; the sport
contradiction (job e4814552) is the standing precedent that unexplained profile context costs output quality.

**G.3 — pose-class awareness.** `PoseClass = portrait | standing | action-grounded | action-airborne | profile |
back | contorted | unknown`, from a lexicon over her ACTION/CAMERA words. At preview: a high-risk class adds a
`degraded` note on the card ("Mid-air shots hold your face less reliably") and offers a ONE-TAP steer that appends
the face-forward anchor. **The steer copy ships only if `struct1-ff` measurably beats `struct1`** — otherwise it is a
warning and nothing more. Never blocking; never silently rewriting her shot.

**G.4 — the keep machinery, on generation.** `readKeep` gains identity-keep wordings ("keep my face", "preserve my
face", "make sure it looks like me"). On a GENERATE they set `identity.strength = "strict"` and are removed from the
scene content — they must never again be scene prose, and they must never flip the task. Two new ASK codes close the
two misroutes recon found:
- `edit_without_photo` — no frame + an edit-shaped sentence ("change the background as well.") asks which photo
  instead of generating a stranger. This narrows `allowedOps(false, …)`, today GENERATE-always.
- `new_pose_or_edit` — a frame attached + a sentence naming a NEW pose/action of her ("put me mid-air…", with or
  without a keep) asks "new photo of you, or edit this one?" instead of silently becoming a background edit.
Both are named tightenings with a nonzero route diff, listed row by row, exactly as the interpreter's 12 rows were.

**G.5 — compile + freeze + size.** `compileGeneratePrompt(brief, references, intent)`; imageSize frozen on the
intent (2K if the probe says it is free and not worse — Google prices 1K and 2K identically); `DIRECTION:` disappears
for system-origin generates (her words arrive as structured slots + `details`). Inbound/untrusted generates keep
today's fenced path — structuring attacker-controlled text is not a safety trade I will make quietly.

**G.6 — proof, the same as edits.** Generate goldens (~20 fixtures); a generate-shaped corpus diff (her real
sentences from the pull + sweep sentences + synthetic pose/keep/edit-shaped variants, ~200–300) reporting op/path
changes, slot extraction and pose class; a route diff over the existing 4,152-string corpus showing 0 rows outside
the two named tightenings; revert checks per guard (keep never flips op; identity block always present when refs
exist; no raw direction on a system-origin generate; each new ASK); acceptance on the branch server (~$0.5–1 of live
generates) after proving which commit the server actually loaded.

**Honest size, as one PR:** ~2.5–3.5k lines including tests and goldens; **6–8 build days**. The last two PRs came in
at 2.4× and 2.8× their line estimates, so plan on **~2 weeks elapsed** with gates at G.0 (byte-identical) and G.1
(parser tables reviewed before anything compiles from them). G.0 can be split off as a zero-behaviour PR if you want
the risk staged.

---

### R3 — LoRA per athlete (reality check only)

**Does any model in our provider set accept a custom adapter today? On Vertex, no — at all.** Vertex cannot
fine-tune any Gemini image-generation model ("fine-tuning image generation models is not supported"), and Imagen
tuning died with the Imagen deprecations. So R3 cannot be an addition to our current renderer; it is a **renderer
fork**, and that is the real cost, not the training fee.

Where it could run, with real numbers (fal, commercially cleared):

| route | train | images needed | per image | note |
|---|---|---|---|---|
| **Phota** (`fal-ai/phota/create-profile`) | **$2.90** per profile | 30–50 | $0.09 @1K, $0.18 @4K | managed subject token, referenced as `[[id]]` in the prompt; markets "no identity drift" |
| **FLUX.2 [dev] LoRA** (`fal-ai/flux-2-trainer`) | $0.0064/step → **$6.40**/1000 | 9–50 | $0.021/MP | outputs commercially cleared *through fal* |
| FLUX.1 LoRA (`flux-lora-fast-training`) | $2/1000 steps | ≥4, more is better | $0.035/MP | face-mask option for people |
| Qwen image trainer | ~$0.95–1.50/1000 steps | 15–30 for a subject | — | cheapest |

Per-athlete cost is therefore **$3–7 once**, plus **cheaper** per-image inference than Nano Pro ($0.09 vs $0.134).
Money is not what makes this hard. What makes it hard:
1. **It leaves Gemini.** Native edit, composition, the text op, marks QA and every golden are Gemini-shaped. A second
   renderer means a second compiler and a second QA calibration — the whole edit tier does not come along.
2. **It creates a per-athlete artifact derived from her face**, which is squarely the biometric-retention problem
   above: consent, retention schedule, deletion on request, portability. Mia's and legal's call before a line is
   written.
3. **Retraining** whenever her look changes, and a cold-start for every new athlete (30–50 photos before she can
   make anything) — which is a product question, not an engineering one.

**Escalation threshold (proposal).** Escalate only when all three hold: (a) the ruler is validated (R0); (b) after
R1+R2's best configuration, action-pose identity distance still sits **outside the same-person band** on a third or
more of action generates — or, with a face recognizer, cosine similarity to her real photographs below the
same-person threshold at FMR 1e-4; and (c) Adi's blind picks agree that those outputs do not read as her. Anything
less and the honest answer is that prompt + references were enough.

---

### Sequencing

R0.a is pennies and gates the meaning of every number below it — run it with the probe.
Then the probe's `r1` set decides R1 vs R2 order:
- **multi-ref is a clear win** → R1 first (2–3 days), R2 next;
- **multi-ref is a wash** → R1 dies for ~$1 and **R2 is the whole plan**, built before the video arc's i2v work,
  because an animated still inherits whatever the still's identity was. Veo holds identity for a full 8s
  (measured) — so a drifted face is a drifted face for eight seconds, and the fix belongs upstream.
R0.b rides with whichever lands first.

