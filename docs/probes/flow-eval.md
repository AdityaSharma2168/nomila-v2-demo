# PR 16 — Flow census + evals · ledger

| | |
|---|---|
| Branch | `studio/flow-eval` (worktree `/Users/adi/nomila-v2-worktrees/flow-eval`) |
| Tip = base | `b5469982` (origin/main, "Merge pull request #587 … studio/composer") |
| Phase | **R — read-only, $0.** No jest, no server, no DB, no model call. Nothing committed. |
| AUDIT2 pin | `c8242e07`; 90 commits since; merged in between: #579 (9.5) #580 (10) #581 (11) #582/#584 (12, 12.5) #583 (13) #585 (14) #586 (17) #587 (15) |
| Planner prompt fingerprint at tip | **`0ebb8528a218`** — computed twice at the tip: every Studio flag unset, and every `=== "true"` flag in `config.ts` set. Identical. |

Scope widened at Adi's ask (24 Sep 2026) beyond the brief-→-plan path: image generate, image edit, video input and output, the media library, and brand knowledge. Every row below is a file:line at `b5469982`. Nine read-only recon passes plus the author's own reads and spot-checks; claims marked **(spot-checked)** were re-read by the author at the tip.

## R-hold rulings — Adi, 24 Sep 2026 (the "rulings, then GO" message; cited below as **ADI-24SEP**)

These are the cites for every verdict they settle. The census's verdict table points here.

| # | Ruling | Effect on the census / cards |
|---|---|---|
| R1 | Brand text in the image prompt is left **unsanitised on purpose**: the model reads the brand's own voice, not a paraphrase. It is still **fenced**: `<external_content>`, the `getBrand.ts:17-23` pattern, verbatim inside. | K1 narrows to *fence only* at `preview.ts:646-656` and `compile/assemble.ts:174-177`: no sanitising, no paraphrase, no dropped fields. K2 is the same: recommend's brief lines stay verbatim inside a fence. **Both ride PR 18**, not a hotfix. |
| R2 | The carousel offers the ad op only, **by ruling**. | K10 keeps only: a product-place rec with no productAssetId bails the whole batch quote (`CarouselCreateScreen.tsx:155` / `batch.ts:222`), and the memo key omits the brand. "recs[0] unfiltered" is dropped as a defect. |
| R3 | Generate and several edit ops are **deliberately restricted** from the Board edit popup. | Those paths are DELIBERATE-DEAD, cite ADI-24SEP. |
| R4 | K3–K6 are **one follow-up PR** ("composer-boundary"): `storyboardRun.ts:111`, `agentLogic.ts:754`, held rows dropping capabilities, join reasons / dropped slots never leaving the client. The same commit **corrects `composer.md:315-316`**. | Note on that card: PR 15's fourteen mutations were all on one side of the client/server boundary, which is why none caught it. |
| R5 | K7 + K14 + K15 + K16 + K17 are **one finding and one PR** ("image-path parity"): `buildPrompt` into `compile/`, campaign and constraints reaching image compile, a route-level end-to-end `image.generate` test, the dead `Routed` fields, the unreachable arms. **Lands before PR 19.** Not split across 18 and 19. | |
| R6 | Constraints absent on images and typed edits are **DEAD BY DEFECT**, into the image-path PR. Called out separately: the known-brand ad freezes `exclude_marks` for its own brand (`ops.ts:539-541`) — **shipping-visible**. | |
| R7 | Every other §9 row is **DEAD** unless a cite is produced. Ruled now, cite ADI-24SEP: `studio_plans.brief_file_path` content and `extras.notes` / `moment` / `extraction` are **DISPLAY by intent**. | |
| R8 | Concept rubric: **"groundable in her library", judged against the plan that follows** — not "groundedness", not the concept alone. Frozen at that wording before any run. | P-concept's fourth median is re-stated below. |
| R9 | The camera-vs-shot_type table (§7) is **Adi's table, pre-registered**. The finer shot-size tag (the PR 12 card) would replace it with a measured relation. | |
| R10 | Route cells may write `studio_plans` rows under Adi's athlete id. **S-1 GO. S-2 GO after S-1 reports.** S-3 one ambiguous brief at a time, a go each. | |
| R11 | Publish the report as a private page at the hold. Mia needs §0, §2.10 and §9 verbatim; K27–K29 are her code. | |

**Re-stated P-concept (R8), frozen before any run:** relevance median ≥ 4; non-genericness median 3; distinctness ≥ 80% of within-brief pairs below the 0.5 Jaccard bar; **groundable-in-her-library, judged with the following plan beside it, median ≥ 3** (the planner may trim a concept to what her library holds, `concepts.ts:8-10`, so most picked concepts should be groundable). Falsified if any median lands on the other side of its line.

### Things to know (standing process change, not a finding)

The DELIBERATE-DEAD set came back empty because **rulings have been living in chat, not in ledgers**. From here, any ruling that makes a field dead is written into the owning PR's ledger at the moment it is made. The census's verdict table accepts DELIBERATE-DEAD only with a cite to a ledger line or a code comment that names the ruling.

---

## 0. The findings that matter most, ranked

Ranked by what can hurt a user or a decision. None is fixed here; every one is carded in §9 with an owner.

1. **Brand text reaches the image model unfenced (spot-checked).** `preview.ts:646-656` renders `BRAND:`, `PALETTE:`, `DO:`, `DO NOT:` straight from `inbox_brands`, whose `content_style`, `brand_values` and `competitors` are web-derived (`skills/researchBrand.ts:196`). The native edit's `DO NOT:` (`compile/assemble.ts:174-177`) is the same. Mila's own `get_brand` treats those fields as `<external_content>` (`mila/…/getBrand.ts:17-23`). House rule 4 makes this blocker-class.
2. **Recommend puts brief lines and the brand name into its prompt unfenced (spot-checked).** `edit/recommend.ts:69-75` — the lines are introduced as "exactly as the brand wrote it". Same rule.
3. **The composer's composition and action slots never leave the Board (spot-checked).** `storyboardRun.ts:111` calls `slotsAllowed(row)` without the composer argument (default `false`, `storyboardLogic.ts:458-461`), so a photo-less row's `composition` and `motion` are stripped before the clip request. `withPlannedShot(composer=true)` set them (`agentLogic.ts:406`). The COMPOSITION / MOTION phrases (`video/prompts.ts:303-326`) are reachable only by a direct API call. `docs/probes/composer.md:315-316` claims the opposite for Board requests. 15 of the 48 capability members are affected.
4. **A generated image never runs the classifier or the interpreter.** The only preview-time `classifyRequest` is gated on `intent === "image.edit"` (`routes/studio.ts:1190-1194`). Her sentence reaches the model as one `DIRECTION:` line in the legacy `buildPrompt` (`preview.ts:774-777`). The spend leg only ever receives `ASK` as a path (`routes/studio.ts:1943-1956`, `:1496`), so `initialPath`'s other values are dead at spend.
5. **Her brief stops at the planner for almost everything.** Every `campaignBriefSchema` leaf reaches the planner prompt. Past it, only tone, style, energy, aesthetic, concept and constraints survive, only into **video** prompts, and only with `STUDIO_BRIEF_CARRIER` on (default off). The image compiler never reads `BriefJob.campaign`. Confirmed output type, aspect ratio and platform drive nothing but the planner text.
6. **A "do not" is not honoured on images or edits.** Constraints render on all four video templates (carrier on) and nowhere on an image generate. Typed edits carry no constraints (`edit/engine.ts:302-312`, `ops.ts:202-231` strict). A known-brand ad freezes `exclude_marks` for **its own brand** (`ops.ts:539-541`) → `DO NOT: show a <brand> logo anywhere`.
7. **Video analysis is paid for and mostly unread.** Of 14 per-beat fields, 9 are never read after parse (`videoTag.ts:275-314` is their only reader). Zero vision fields reach a compiled video prompt. Stitched outputs are tagged and billed but refused by the planner (`cast.ts:374`, `library.ts:409`).
8. **The deal's brand is dropped on the two flag-on brand flows.** The Board plan and the carousel ad send the brand **name** only (`brandLogic.ts:162-218`, `carouselLogic.ts:92-112`); no `brandId`, so none of the stored research, competitors or imagery reaches them. Only the flag-off single-photo path passes `brandId`.
9. **Cost lines cannot answer "what did this plan cost".** Planner, concepts, direction tools, interpreter and clip read write no JSONL line. Recommend and detection write lines with all attribution null (unjoinable; `qa/join.ts:224-238` matches only jobId/assetId/editPreviewId). Stitch has no cost line and no plan id. Video's `generation_jobs.cost_usd` stays null.
10. **Generated and stitched assets fall off the date-ordered library after page 1.** They never get `posted_at`; the cursor `lt(posted_at, c)` (`routes/media.ts:177-178`, spot-checked) never matches NULL. Shared code → Mia.

---

## 1. The architecture, as the code runs it

```
                     ┌── brand post / deal ──┐   ┌── reference URL ──┐   ┌── moment search ──┐
her words ──► confirm step (client, direction/*) ──► campaign brief (campaign/brief.ts, 23 leaves / 58 with readings)
                                                           │  stored on studio_plans (PR 13)
                                                           ▼
media library ──► tagger (photos: 17 fields; clips: 16 + 14/beat) ──► library lines ──► PLANNER (agent/plan.ts) ◄── concepts step (no library)
                                                                                           │ plan.items
                                                                                           ▼
                                                                          CASTER (agent/cast.ts: gates A1b A2 S1 S1b S2) → CastItem
                                                                                           │ route answer
                                                                                           ▼
                                                            BOARD (client storyboardLogic; rows live in memory only)
                                                              │ clipRequestFor (5 of 19 row fields)      │ boardStitch → joins (client only)
                                                              ▼                                          ▼
                                             /studio/preview → assembleBrief → BriefJob          stitch spec → ffmpeg
                                                              │ + carrier (flag) from the plan row
                                                              ▼
                                             video/prompts.ts (4 templates) → videoRunner → Veo / Seedance / Kling

CREATE ANYTHING: sentence → client classify picks edit|generate
   ├─ generate: brief → legacy buildPrompt (preview.ts) → image model        (no classifier, no interpreter, no campaign)
   └─ edit: classify → interpreter (flag) → detection → FrozenEditIntent → buildNativePrompt (compile/) or masked crop
TYPED EDITS (PR 9): op params → planOp sentence → native prompt + CAMPAIGN block → image model   (no QA, no constraints)
QA (flag): writes media_assets.metadata.creative_qa; read only by a display route. Gates nothing.
```

Two image compilers exist: `buildPrompt` (`preview.ts:567-788`, every generate, masked edit, non-native edit — outside `compile/`, TODO at `:561-566`) and `buildNativePrompt` (`compile/assemble.ts:152-179`, native edits only).

---

## 2. Census by surface

Verdicts: **CONSUMED** (reaches a model prompt or an output-deciding artifact) · **DECIDES** (a branch — named) · **DISPLAY** · **DELIBERATE-DEAD** (needs a ruling cite) · **DEAD**.

### 2.1 Campaign brief → planner → generation

| Leaf | Planner | Past the planner | Verdict |
|---|---|---|---|
| objective.type | `plan.ts:374` | brand-work decision `music/suggest.ts:33-65` | DECIDES |
| objective.goal | `:374` | ad op `ops.ts:376`; row objective via carrier, not rendered | CONSUMED (planner, ad op) |
| story | `:376` | ad op `ops.ts:375`; recommend lines | CONSUMED |
| brand.name, brand_attributes | `:382` | — | CONSUMED (planner only) |
| brand.profile | `:379-382` if non-null | every writer sets null (`brandLogic.ts:175`, `direction/brief.ts:63`, `echo.ts:33`); a handle string, never resolved | **DEAD in practice** |
| subject.identity_priority, sport | `:386` | composed-ask phrase `directionLogic.ts:588-596` | CONSUMED (planner) |
| product.ref / fidelity / line | `:389-391` | line → ad op + recommend | CONSUMED |
| creative_direction.tone / style / energy | `:397` | carrier `feelLine` `carrier.ts:175-182` → identity + b-roll templates, flag on | CONSUMED (flag) |
| references[].ref / role | `:401,:420` | carried `carrier.ts:154-155`, never rendered | CONSUMED (planner) |
| references[].intent (12 dims × summary/tags/basis) | `:413-419`, 300 chars | never in a compiled prompt (`carrier.ts:196-197`, spot-checked). `editing_rhythm.summary` → join rule (composer, client). emotional_tone / motion → tone / energy only via decompose | CONSUMED (planner) |
| references[].assetId | no | carried `carrier.ts:157`, no reader ("PR 18 reads it") | **DEAD** (owner PR 18) |
| output.type / aspect_ratio / platform | `:424-427` | not the deliverable, not the aspect | CONSUMED (planner text only) |
| constraints | `:430-433` | carrier → all 4 video templates (flag); recommend lines | CONSUMED (video, flag) |

`JobCampaign` (12 leaves, `carrier.ts:59-94`): 6 rendered (tone, style, energy, aesthetic, concept, constraints); planId, objective, references[].{ref, role, intent, assetId} never rendered. The bridge renders constraints only.

`studio_plans` (14 columns, `schema.ts:2180-2207`): `brief_file_path` written `plans.ts:110`, read only by the replan carry-forward, content never read. `confirm` (flags, basis) written `plans.ts:117`, echoed by GET, carried by replan, **read by nothing**. `concept` read by the carrier (flag); never by cast or stitch.

`BriefProposal` extras (19 leaves, `envelope.ts:74-170`): `extras.notes`, `moment`, `extraction` shown on the confirm screen only (`ConfirmBriefStep.tsx:82,103-145`). `sourceTool` client-side except the propose prompt (`directionLogic.ts:494` → `proposePrompt.ts:105`) and a server log.

### 2.2 Photo tagger and the library line (PR 12)

Tagger: 17 model-answered fields + derived `athlete_present` (`visionTag.ts:57-82`). Flag `STUDIO_LIBRARY_FIELDS` (`config.ts:1706`), default off.

| | Flag off (production default) | Flag on |
|---|---|---|
| Reach the planner | 5 of 17 (shot_type, description, brands_visible, setting, vibe) + person_in_frame | 17 of 17 (`library.ts:512`, `plan.ts:300-313`) |
| Picker reads | — | 4 (subject, shot_type, disposition, hero_suitability) |
| Gates | subject guard | + hard-flag drop (`library.ts:399`), reject gate (`cast.ts:602`) |

`face_visibility` and `role` now exist (AUDIT2 said absent) and are read by the likeness gate and packGate; the picker does not read them. `vision.role` is never a gate. The agent's own subject guard (`agent/subject.ts:263`) ignores `vision.subject` and uses word regexes — two different answers to "who is in it".

### 2.3 Capabilities (PR 15)

48 members (camera 11, movement 11, lighting 11, composition 7, motion 8; `capabilities.ts:42-101`, spot-checked).

| Leg | Composer on | Composer off (default) |
|---|---|---|
| Maps to a slot | 48 of 48; 3 collapse (`medium_wide→medium`; `extreme_close_up`, `macro → close`) | 12 map; 36 ride as prose on the direction (`cast.ts:974-979`) |
| Has a phrase | 48 of 48 in `video/prompts.ts` phrase tables (`capabilityEntries.ts` covers 0 — it keys kinds, music, look, caption) | same |
| Renders — text-to-video b-roll via direct API | 6 slots | — |
| Renders — Board b-roll | 4 of 6 slots (**composition and motion stripped**, §0.3) | — |
| Renders — row from her photo | movement only (11 members); others refused `slotRefusal` `prompts.ts:366-393` | movement only |
| Renders — bridge | none | none |
| Prose-only set | **empty** (`capabilityProse` returns "" `:318`) | 36 |

Capabilities on held `image` and `clip` rows drop with no record: `rowsOf` (`agentLogic.ts:315-356`) never calls `withPlannedShot` for held rows, so the `nothing-filmed` reason can never be produced. `brandBoardSeed` passes `campaign !== null` as the composer flag (`agentLogic.ts:754`, spot-checked) — a brand plan with no proposal brief seeds as if the composer were off.

**Join reasons** (9, `joinLogic.ts:32-41`): position-0, her-cut, bridge-edge, after-own-bridge, continuation, on-beat, rhythm-fast, rhythm-slow, default-fade. Chosen by `chooseJoin` (`:70-84`), recorded only in `BoardStitch.joins` (`boardStitch.ts:94,175`). Not in the stitch body, spec, DB or server; their only exit is a `__DEV__` console log (`StoryboardTab.tsx:925-942`). **Dropped slots** (`StoryboardRow.droppedSlots`, `storyboardLogic.ts:192`) are client memory only.

### 2.4 Video input — are her clips analysed, and used?

Yes, behind `STUDIO_VIDEO_ENRICH`: one Gemini Flash call per clip at 1 fps with audio (`videoTag.ts:95-110`). Flag off, a video is tagged from its **poster** by the photo tagger; its embedding is always poster-derived (`mediaEnrichment.ts:122`).

| Field | Planner | Caster | Compiled prompt | Verdict |
|---|---|---|---|---|
| 16 whole-clip fields | 6 flag off / 16 flag on | brands → brandFlag; disposition → reject gate | **none** | CONSUMED / DECIDES |
| beats[].start_s / end_s | segment + window validation `plan.ts:703-724` | trim `cast.ts:1030-1048` → stitch trim | no | DECIDES |
| beats[].description | `beatWords` `plan.ts:289-291` | subject guard | no | CONSUMED |
| beats[].camera, motion | via `nearestCapability` `library.ts:520-522` | — | no | CONSUMED (planner) |
| beats[].shot_type, athlete_present, athlete_prominence, aesthetic_quality, hero_suitability, setting, attire, vibe, brands_visible (**9**) | — | — | — | **DEAD** (parse-time merge only) |
| vision.video.*, vision.prev | — | — | — | DEAD in product (eval record; `prev` leaks into `/me/media` text search `media.ts:168`) |
| provenance_signal.signal | `(verified)` + order `library.ts:238-256` | — | — | DECIDES (order) |
| provenance_signal.evidence, clip_read.quotedUsd / billedUsd | — | — | — | DEAD (record) |

The video tagger lacks `face_visibility` and `role`; `retag.ts` (no product caller) would write a poster/clip hybrid. Clip QA's drift-from-beats hop is effectively dead: QA runs straight after generation, before any read has tagged the new clip, so drift falls back to "strip" (`inspectClip.ts:275-276`).

### 2.5 Generated clip path

Board clip body: 8 keys (`storyboardRun.ts:60-94`); bridge 7. Never sent: `durationSeconds` (always the default 4s, `preview.ts:257`), `brandId`, `sourceAssetId`, `regions`. `clipRequestFor` reads 5 of the row's 19 fields; `direction`, `hasPerson`, `stillSec` unread.

Templates (`prompts.ts:417-531`): identity-static, identity-pose (**unreachable** — `opts.shotBeat` has no product caller, `preview.ts:227,1019`), transition-first-last, broll-no-marks. Model: identity → Veo; b-roll → Seedance Fast; transition → Kling (`config.ts:179-214`; the "UNREACHABLE" transition comments at `config.ts:201`, `prompts.ts:537-548` are stale). The brief's athlete and brand halves are read by no video template.

### 2.6 Stitch

All 15 spec fields (caption's 5 sub-fields included) reach ffmpeg (`spec.ts:272-588` → `video/plan.ts`). The Board never sends `bedLevel`, `bedStartSec`, `bedAssetId` (`boardStitch.ts:341`), and always sends `durationPreciseSec: null` (`:217`). Join reasons never reach the spec (§2.3).

### 2.7 Image generate (Create Anything / MakeIt)

- `PreviewRequest`: 13 fields declared, 8 sent by Create Anything. `references[].label` is never sent (`studio-contract.ts:579`), so the manifest says `"product 1"` (`preview.ts:388`).
- The classifier's `Routed` (16 leaves): `ambiguity` always null, `confidence` always 1 or 0; the `low_confidence*` asks (`classify.ts:4297-4301`) are unreachable. `/studio/classify` wire `op` / `targets` have no client reader.
- `/studio/preview` hard-codes `origin:"system"` (`routes/studio.ts:1419`), so `direction.untrusted` is always false and the fence arm (`preview.ts:775-777`) is unreachable.
- `ProductPiece.reference` always null (`brief.ts:664,675`) → the brand-pieces reference arm never fires.
- AthleteHalf: 22 leaves, 3 reach the prompt (AUDIENCE, register, GOAL). BrandHalf: 14 leaves, 7 read by the legacy prompt, `donts` only by the native one; tier, audience, recentCampaigns stored, never compiled.
- References reach the adapter only as ordering (`vertex.ts:156-161` sends bytes in slot order); labels live only in the prompt manifest.
- 4:5 is not in the image model's supported list (flagged at `compile/aspect.ts:24-26`).
- The identity pack's `shot.framing` branch (`identityPack.ts:136-139`) is dead on images (the image path never sends `shot`). The Board never gets pack refs.
- Interpreter spend has no cost line; it lives only in `record.costUsd`.
- No route-level end-to-end test exists for `image.generate` (edits have `studio.native.test.ts`).

### 2.8 Image edit

Typed ops: 19 param leaves (recolour 2, garment 3, product 6, background_clean 1, ad 7) — server-side 18 CONSUMED + 1 DECIDES.

| Defect | Cite |
|---|---|
| Her recolour colour is overridden by detection's label ("crimson jersey" replaces "red") | `nativeIntent.ts:370` vs `:393` |
| Recommend's "ad" suggestion is structurally dead: prompt offers `{headline}`, `AD_PARAMS.brand` required → always dropped as bad_op | `recommend.ts:83`, `ops.ts:205` |
| Carousel takes `recs[0]` with no op filter; a product-place rec has no productAssetId → the whole batch quote bails | `CarouselCreateScreen.tsx:155`, `batch.ts:222` |
| No client sends `brandId` on an edit; `rerollBatch` drops it server-side too | `EditSheet.tsx:100-104`, `batch.ts:580-587` |
| Carousel `ad.headline` always null; `ad.instruction` never sent | `CarouselCreateScreen.tsx:220` |
| With `STUDIO_NATIVE_EDIT` off a derived op still quotes at the masked price and always refuses at run | `nativeIntent.ts:1182`, `engine.ts:449` |
| Recommend memo key omits brand; client query key includes it | `recommend.ts:209` |
| `DetectedBox.label` asked of the model, never parsed | `autoMask.ts:144,563` |
| `readThingKeep.thing` decides a branch, never reaches the prompt | `nativeEdit.ts:204-206` |
| Typed ops run **no QA** | `engine.ts` imports nothing from `qa/` |
| `studio_edit_previews`: `content_type`, `bytes`, `ran_at` write-only; params meta `because`, `stage`, `variation`, `reroll`, `chain` write-only | `schema.ts:2236-2266`, `batch.ts:220-586` |
| Recommend `dropped` and `usage` never leave the server | `routes.ts:201` |
| Objective, deliverable, brand tone / palette / dos: dead on edits (by design for tone, `assemble.ts:136-150`) | `engine.ts:302-313` |
| Style reference / reading: used by no edit (PR 18) | `brief.ts:238` |
| Human accept / discard verdict stored, never read as a label; identity-observation link dead; discard deletes bytes | `engine.ts:745,792-799` |

### 2.9 Media library

`media_assets`: 37 columns, 34 written; `deal_id`, `deleted_at` (read as a filter in 12+ places, never set) and `deal_deliverable_id` never written. `metadata`: 17 top-level keys, 87 leaves written.

Asymmetries that change behaviour:
1. Uploaded images never get `gcs_thumb_path`; they embed from the full original and are the ones the oversize brake abandons.
2. Generated / stitched rows never get `posted_at` → unreachable past page 1 in date order (§0.10).
3. Uploads get moderation and EXIF normalisation; generated rows get neither.
4. `approval_status` starts `draft` only for generated rows; uploads are NULL and `allowedNext(null)` is `[]` → **only generated or stitched rows can ever be queued to publish** (`eligibility.ts:121`).
5. `approval_status` is not read by the picker, caster or search → a `rejected` generation is still castable.
6. Stitched outputs are excluded from the planner but **not from the picker** (`mediaList.ts:142-152`).
7. The Board and Agent pickers offer upload and generated only (`mediaPickerLogic.ts:86-89`); a synced photo reaches the Board only through a plan.
8. Hand-added Board photos hard-code `hasPerson:false` (`StoryboardTab.tsx:980-1006`).
9. Board rows are never persisted; `picked` on the library line lasts only while the client re-sends it.

Hazards (outside the lane, read not tested): `videoPoster` repoints `gcs_path` after transcode (`videoPoster.ts:175-181`), breaking `publishStitchOutput`'s idempotency lookup (`materialize.ts:918-927`); whole-object metadata read-modify-writes can erase another writer's key (`mediaEnrichment.ts:159`, `qa/record.ts:88`, two skills); `resolveClips` is looser than `herClip` (`materialize.ts:351-358`); identity `herPhotos` has `LIMIT 200` (`identity/routes.ts:131-151`); `content_brands` has no writer and no reader.

### 2.10 Brand knowledge — does Studio use what Mila knows?

**Stored** (shared catalog `inbox_brands`, no athlete_id; `researchBrand` fills it once for every athlete, refreshed at 60 days): name, domain, logo, cover + ranked imagery, category, description, tier, audience, sport categories, partnerships, and `enrichment` {content_style, brand_values, recent_campaigns, competitors, product_categories, partnership_style, markets, brand_safety (a string)}. Per athlete: deals, thread `conversation_state` (the brand's ask, deliverable counts), `brand_fit_narratives`, media kits. `deal_deliverables` exists but **no server code inserts into it**. Palette: no writer anywhere.

**Read by Studio:** the flag-off single-photo path and the "make this an ad" interpreter read `inbox_brands` in full (`brief.ts:899-931`, `interpret/ad.ts:193-215` — the latter fenced). The Board plan and the carousel send the name only. From a deal: brand name, deliverable `campaign` title, and a `dealLinked` boolean — not the ask, formats, due dates, quantities or terms.

**Shape mismatch:** `researchBrand.ts:39` writes `brand_safety` as a string (spot-checked); `brief.ts:600,614-615` reads it as an object → brand dos/donts are always `[]`.

**`studio_brand_profiles`** (per athlete, correct composite key) exists since 0060; `createBrandProfile` has no caller. `studio_reference_analyses.brand_profile_id` always null.

**A new brand today:** the brand-post door lists only her deals' brands (`BrandPostScreen.tsx:58-61`) — no way to enter one. Create Anything recognises a brand only if it is on a hard-coded sportswear list (`ad.ts:107-123`); an unknown one proceeds on the name with no research, no write, no spend. Direction tools re-derive everything per brief; nothing is remembered. Research runs only outside Studio (pitch flow, inbox, contracts, Mila `get_brand`, a refresh cron).

**Tenancy notes for Mia:** any brand row is readable by id — a **documented, deliberate** decision (`routes/studio.ts:841-853`, spot-checked: brand-public research, "pitch any brand"). What remains worth her ruling: sequential ids reveal which brands entered the shared catalog via other athletes' inboxes; and `getOrResearchBrand`'s upsert overwrites the shared row's display `name` with what the picking athlete typed (`brandIntel.ts:143-147`).

**Improvement options, ranked:**

| # | Option | Lane | Spend | Risk |
|---|---|---|---|---|
| 1 | Fence + sanitise brand lines in `preview.ts:646-656` and `assemble.ts:174-177` (reuse `sanitizeBrandField` / `delimited`). Do first. | PR 18 (compile / brief) | $0 | moves byte-pinned goldens |
| 2 | Carry the deal's `brandId` on Board plan and carousel bodies; server reads the row and fills a fenced tone line, attributes, competitor DO NOTs | Studio | $0 | low |
| 3 | Put the picked deliverable's format / due / quantity into the brief | Studio | $0 | little value until `deal_deliverables` has a writer (Mia) |
| 4 | Read the deal thread's `key_details.ask` and deliverable counts via an athlete-scoped join, as inferred lines on the confirm step | Studio (+ Mila parser reuse) | $0 | email text: must be fenced |
| 5 | Wire `studio_brand_profiles`: save what she confirms per brand, resolve the `brand.profile` handle to content — per-athlete memory | Studio, behind `STUDIO_BRAND_PROFILES` | $0 | low; table exists, no DDL |
| 6 | Let the brand-post door use `/brands/search` + `/brands/resolve` for brands outside her deals | Studio calling shared code | one research run per new brand, shared across athletes | writes the shared catalog; fix the name overwrite first |
| 7 | For Mia: palette + structured dos/donts in `researchBrand`'s schema; fix the brand_safety shape; a `deal_deliverables` writer; stop the name overwrite | shared | marginal per run | shared blast radius |
| 8 | `brand_fit_narratives` for concept angles | Voice / Mia | $0 | blocked by the narrateWhyFits she/her defect |

### 2.11 QA and cost

- QA (`STUDIO_CREATIVE_QA`, default off) writes `metadata.creative_qa`; read only by `GET /studio/assets/:id/qa` (`STUDIO_QA_DISPLAY`). **Display-only; gates nothing.** On an image generate only text and anatomy run; identity, marks, adherence record `unknown` (`verdict.ts:403-466`). `clip.reroll` written, no reader.
- Cost line: 6 attribution keys (`types.ts:334-341`), always written. `costLinesFor` matches 3 of them. Image generate `assetId` always null (`generate.ts:1284-1291`); no athleteId on any line.

---

## 3. Phase R deliverable (a) — claims

### C1–C10

| # | Claim | Verdict | At the tip |
|---|---|---|---|
| C1 | Harness | CONFIRMED, with a correction | `sheet.ts:21-29` CRITERIA (7), `shuffle`/`assignCodes` seed 20260922 (`:61-90`), `SheetCell` has no run field (`:41-53`). `runs.ts:64-173` FINGERPRINT_ASK now carries a fixed campaign; `promptFingerprint` `:176-181`. `reveal.ts` escalation n=5–6 (`:7,:224`). `routeCell.ts` pools CastItems. `briefs.ts:36-195` 13 briefs. `studioPlanEval.ts:61` MAX_CALLS 80, dry by default. **Correction:** `studioPlanEval --run` is FENCED (`studioPlanEval.ts:207-212`) — planner cells go through `studioPlanRoute.ts`, which takes one `--brief` per invocation, `MAX_CALLS` default n (`:43`), `PER_CALL_CEILING_USD 0.075` (`:103`) is a **printed** ceiling, not a refusal. `--concepts` makes 2 calls per cell (`:201-213`) and keeps all concepts on the cell (`:127,:174`). Reusable unchanged: `shuffle`, `assignCodes`, `routeCell`, `briefs`. Needs a concept variant: `renderSheet`, `scoresTemplate`, `parseScores`/`reveal` (all hard-wired to `CRITERIA`, `reveal.ts:31-45`). |
| C2 | Census row set | see §4 | 398 rows over the 16 R-1 sources; +289 over the widened sources |
| C3 | Capture points reachable with the model mocked | CONFIRMED, one partial | All 9 reachable. Planner prompt: `generateContent.mock.calls` (precedent `studio.agent.test.ts:286`). Parsed `AgentPlan`: route returns cast items only → wrap `derivePlan` with `requireActual` (precedent `direction/routes.test.ts:84`). Board rows, clip requests: pure client functions. Compiled prompts: `plan.inputs.prompt` / `plannedInputs(brief)`. Stitch spec: `toStitchBody` → `parseStitchSpec`. Join row: `qa/join.ts:244` on PGlite with a tmp `STUDIO_COST_LOG`. **Cost lines: PARTIAL** — five spend sources write no JSONL (§0.9); the census records that as a finding, not a gap it papers over. |
| C4 | Mockability per flow | CONFIRMED — all 8 drivable, **zero production seams needed** | (1) summarize → plan → board → clip → prompt → stitch: yes; the TSX wiring (`BrandPlanStep.tsx:133-175`, `AgentScreen.tsx:258-303`, `StoryboardTab.tsx:882-900`) must be replicated in the test from pure functions. (2) reference: yes. (3) moment: yes; distinct athlete per case (module rate-limiter). (4) ideas: yes. (5) carousel: yes; recommend memo is module state → `jest.isolateModules`. (6) Create Anything: yes (edit precedent `studio.native.test.ts`; generate has none). (7) clip read: yes, plus `jest.mock` of `provenanceSignal` (else real `ffprobe` spawns). (8) identity pack: chooser is client-only; refs visible as `router.generate` inputs. |
| C5 | Carrier ground truth | CONFIRMED | §2.1: 6 of 12 `JobCampaign` leaves rendered, video only, flag only; tone/style/energy/constraints/references also need `STUDIO_BRAND_PROFILES` (`carrier.ts:137-141`). |
| C6 | Composer | PARTIAL | Join reasons 9, client-only. Slot mapping complete (48/48, 3 collapse). Prose-only empty with the flag on — **held**. But composition and motion never reach a Board request (§0.3). |
| C7 | Library line | CONFIRMED | §2.2. |
| C8 | Chooser | CONFIRMED | Client `identityPack.ts:123-192`; up to 3 person refs appended after hers; image.generate with person intent only; never the Board. Visible in a capture as `router.generate` `inputs.references` (slot `character`) and in the POST body; `refIds` are GCS paths, not asset ids. |
| C9 | Cost join | PARTIAL | §2.11. A mocked generation's row is complete only if the router runs real and the adapter is mocked; `assetId` null on image generate. |
| C10 | DELIBERATE-DEAD set | **Mostly WRONG as expected** | No ruling found for `brief_file_path`, `sourceTool`, `extras.notes` (mila-direction.md:748-749 goes the other way: it added a card showing them), or the confirm basis (brief-carrier.md:307 calls it REVIVED). The only "display-only" statements are code comments (`brandLogic.ts:268-271`, `routes/studio.ts:2305-2306`). Citable rulings: readings not rendered in clip prompts (`carrier.ts:194-197`, PR 14 R-3 — and PR 18's by the roadmap); bridge renders constraints only (same cite); tone/palette/dos off edits (`assemble.ts:136-150`); `fromPut`/`fromPronoun` not frozen (`classify.ts:386-389`); `captionSuggest` ignores objective (`captionSuggest.ts:15`); brand catalog readable by id (`routes/studio.ts:841-853`). **Everything else becomes a DEAD candidate for Adi.** |

### AUDIT2 §5.0, re-verdicted row by row

| AUDIT2 row | Verdict | Now |
|---|---|---|
| output.{type,aspect,platform} overridden `brandLogic.ts:177` | STALE | `confirmedOutput` `brandLogic.ts:147-154` — but the fields still drive only planner text |
| product overridden `:176` | STALE | `confirmedProduct` `:137-145` |
| objective.goal → isBrandWork | STALE | `brandWorkFor` decides on type / brand / deal (`suggest.ts:33-65`) |
| identity_priority no phrase | STALE | `directionLogic.ts:588-596` |
| brand.profile never rendered | PARTIAL | rendered `plan.ts:379-382`, never filled |
| referenceAssetId no consumer | STALE (deleted 3244fb4f) | successor `references[].assetId` also unconsumed |
| words / aesthetic / objective no columns | STALE | `schema.ts:2199-2206` |
| re-plan from stored brief | STALE | `routes/studio.ts:2666-2733` |
| confirm flags / notes / sourceTool client-local | PARTIAL | flags stored, never read; notes / moment display; sourceTool client + propose |
| tone → generator | PARTIAL | video only, flag only, not the bridge, never image |
| constraints → clip / compile | PARTIAL | video only, flag only, never image or edit |
| readings tags+basis, 120-char | STALE | full 300-char + tags + basis in the planner; never in a compiled prompt |
| references[].ref → asset | PARTIAL | resolved at save (`resolveRefs.ts:26-54`); nothing reads the asset id |
| concept → cast / compile / stitch | PARTIAL | compile yes (flag); cast and stitch no |
| direction on image / clip rows | PARTIAL | carried (`agentLogic.ts:299-303`), **read by nothing** |
| capabilities prose-only | PARTIAL | fixed behind `STUDIO_COMPOSER` (off); 36 prose-only with it off |
| editing_rhythm / onBeat → join | STALE behind flag | client-only record |
| tagger 11 → planner; tag → picker | STALE behind flag | 17 / 4 with flag; 5 / 0 without |
| face_visibility, role absent | STALE | tagged, read by gates |
| beats for a chosen clip; saved plan after a read | STALE | PR 9.5 (`videoEnrichment.ts:156-162`, `plans.ts:123-165`) |
| QA verdict → any reader | STALE | display-only reader |
| cost line ↔ ids; recommend + detection | PARTIAL | keys exist; 3 of 6 matched; recommend/detection null-attributed |
| human verdict ↔ identity; discarded bytes | CONFIRMED | still dead; `engine.ts:792-798` |
| reading → edit style spec; style role | CONFIRMED | absent (PR 18) |

---

## 4. The census row set (R-1), counted

Counting rule: every scalar or scalar array is one leaf; nested objects flatten to dotted paths; arrays of objects to `path[].field`. Readings are expanded to 12 × {summary, tags, basis}.

| Source | Leaves | Cite |
|---|---|---|
| campaignBriefSchema | 58 | `campaign/brief.ts:92-201` |
| studio_plans columns | 14 | `schema.ts:2180-2207` |
| BriefProposal flags + sourceTool + extras | 19 | `direction/envelope.ts:74-170` |
| AssetTags (17 + derived) | 18 | `lib/visionTag.ts:57-82` |
| LibraryEntry (what library.ts passes; tags counted above) | 16 | `agent/types.ts:186-238` |
| Reading dimensions | 12 | `reference/schema.ts:127-140` |
| CAPABILITY_LISTS members | 48 | `agent/capabilities.ts:42-101` |
| CastItem | 25 | `agent/cast.ts:645-731` |
| StoryboardRow (the Board row) | 19 | `storyboardLogic.ts:83-193` |
| clipRequestFor → PreviewRequest | 13 | `use-studio.ts:263-308` |
| BriefInput | 47 | `studio/brief.ts:277-347` |
| BriefJob | 49 | `studio/brief.ts:366-460` |
| ShotSpec | 6 | `studio/types.ts:206-213` |
| CreativeQaVerdict (top level) | 14 | `qa/verdict.ts:139-206` |
| Cost line (GenerationRecord + attribution) | 21 | `costLog.ts:82-114`, `types.ts:334-341` |
| Typed-op params | 19 | `edit/ops.ts:121-231` |
| **R-1 total** | **398** | |

Widened sources (Adi's ask): Routed 18 · FrozenEditIntent 23 · InterpretationRecord 16 · AthleteHalf 22 · BrandHalf 14 · recommend output 10 · studio_edit_previews 22 · video tagger per-beat 14 + meta 6 · stitch spec 15 · media_assets columns 37 + metadata leaves 87 (overlapping the tagger rows by 23) = **289** more.

**These counts are hand-derived for R.** The enumerator in B derives them from code (zod `.shape` walk; drizzle `getTableColumns`; the TypeScript checker, already a devDependency at `~5.9.2`, for interfaces; runtime walks of `CAPABILITY_LISTS` and `DIMENSIONS`). Any difference from 398 is reported as a miss, not reconciled.

---

## 5. Phase R deliverable (b) — predictions, pre-registered 24 Sep 2026 before any capture

| # | Prediction | Falsified if |
|---|---|---|
| **P-coverage** | Flags-on, over the 398 R-1 rows: **0.78** CONSUMED or DECIDES | measured outside 0.73–0.83 |
| **P-delta** | **19** rows DEAD flags-off that are CONSUMED flags-on: 12 tagger fields (library-fields), 6 carrier-rendered `JobCampaign` leaves (carrier), `planId` (carrier) | measured outside 16–22 |
| **P-dead** | DEAD flags-on, by name: `brand.profile` (in practice), `references[].assetId` (both the brief and `JobCampaign`), `JobCampaign.objective`, `studio_plans.confirm`, `studio_plans.brief_file_path` (content), `StoryboardRow.direction`, `StoryboardRow.droppedSlots` (no persisted reader), `ShotSpec.composition` and `ShotSpec.motion` **on the Board path**, `CastItem.beats` on the uncast arm, `PreviewRequest.references[].label` (from Create Anything), `PreviewRequest.durationSeconds` (from the Board), `Routed`-derived fields outside the census set; cost line `previewId`, `batchId`, `promptVersion` (never matched by the join); QA `clip.reroll` | any named field comes back alive, or any unnamed field comes back DEAD (both directions reported) |
| **P-caps** | Prose-only is 0 with the composer on — **holds**. "All 48 render" — **MISSES**: 15 members (composition 7, motion 8) never render through a Board request; 3 collapse onto another member's phrase; on any row from her photo only the 11 movement members render | prose-only ≠ 0, or composition/motion render through `clipRequestFor` |
| **P-constraint** | A "do not" fixture is honoured in every compiled **video** prompt with the carrier on (all 4 templates), and **absent from every image-generate and every typed-edit prompt**; with the carrier off it is absent everywhere. The known-brand ad contradiction fixture fails fidelity | the constraint appears in an image prompt, or is missing from any carrier-on video template |
| **P-concept** | Relevance median ≥ 4; non-genericness median 3; distinctness: ≥ 80% of within-brief pairs below the 0.5 Jaccard bar; **groundedness-in-her-library median ≤ 2**, because the concept step never sees her library by design (`concepts.ts:1-18`, ground rule 01) | any of the four medians on the other side of its line |
| **P-fingerprint** | `0ebb8528a218`, flags on and off, at the PR's tip | any other value |
| **P-seams** | This PR touches **zero** production files | any production file in the final diff |

**Concern on the concept rubric (stated, not acted on):** "groundedness in her library" grades the concept step on something it is forbidden to see. As registered it will score low by construction. The rubric stays as specified. Adi may rule that criterion to mean "groundable in her library" (checked against the plan that follows), which is measurable. The rubric freezes at Adi's go and does not change after any run.

---

## 6. Phase R deliverable (c) — mutations, each red by name

| # | Mutation | Test file |
|---|---|---|
| M1 | a CONSUMED field goes dead without failing the census (drop `tone` from `feelLine`) | `server/studio/agent/eval/census/census.test.ts` |
| M2 | a new brief field passes the census unverdicted (add a leaf to the census fixture's schema view) | `census/rows.test.ts` |
| M3 | the census green with the carrier flag off (force the off-run to reuse on-run captures) | `census/census.test.ts` |
| M4 | a capability member renders with no phrasing entry (delete one phrase-table key in a test double) | `census/capabilities.test.ts` |
| M5 | a constraint present in the prompt but contradicted passes fidelity | `eval/fidelity.test.ts` |
| M6 | the concept sheet reveals the run label | `eval/conceptSheet.test.ts` |
| M7 | the concept sheet is not shuffled between runs (constant seed ignored) | `eval/conceptSheet.test.ts` |
| M8 | a judge sees the model name | `eval/conceptSheet.test.ts` |
| M9 | a run exceeds MAX_CALLS (total across the 13-brief loop) | `eval/spendGuard.test.ts` |
| M10 | a run exceeds the per-call ceiling (refuses up front, never truncates) | `eval/spendGuard.test.ts` |
| M11 | an un-picked concept is written to the DB | `eval/conceptRun.test.ts` (PGlite: row counts before/after) |
| M12 | a capture seam is live outside the census — **moot if P-seams holds** (no seam exists); replaced by "the census imports a production module that reads `process.env` for a capture switch" | `census/census.test.ts` |
| M13 | the census writes to production tables (`DATABASE_URL` set, or `server/db` unmocked) | `census/census.test.ts` |
| M14 | a dropped slot vanishes without a DEAD row (strip `composition` in the Board path and expect the census to name it) | `census/flows.board.test.ts` |
| M15 | an unverdicted DELIBERATE-DEAD with no cite passes | `census/verdicts.test.ts` |
| M16 | camera-vs-shot_type metric counts a compatible pair as a disagreement | `eval/watch.test.ts` |

---

## 7. Phase R deliverable (d) — component map

**Lane 1 — census** (all new)
- `server/studio/agent/eval/census/rows.ts` — the mechanical enumerator
- `…/census/verdicts.ts` — one verdict + cite per row; DELIBERATE-DEAD requires a cite
- `…/census/fixture.ts` — nonce campaign (ZQ001…), non-default enum members, synthetic library rows
- `…/census/capture.ts` — writes `probe-out/flow-eval/<run>/<point>.txt`
- `…/census/flows.*.test.ts` — the eight flows (flows 1 and 5 replicate TSX wiring from pure client functions)
- `…/census/census.test.ts`, `capabilities.test.ts`, `rows.test.ts`, `verdicts.test.ts`
- `server/scripts/studioFlowCensus.ts` — regenerates §2's census tables and the coverage line in this ledger

**Lane 2 — evals**
- `server/studio/agent/eval/sheet.ts` — add `CONCEPT_CRITERIA`; `scoresTemplate` takes criteria
- `server/studio/agent/eval/reveal.ts` — `parseScores` / `reveal` take criteria
- `server/studio/agent/eval/conceptSheet.ts` (new) — concept blind sheet
- `server/studio/agent/eval/fidelity.ts` (new) — the deterministic half of R-10
- `server/studio/agent/eval/watch.ts` (new) — R-12 metrics
- `server/studio/agent/eval/spendGuard.ts` (new) — refuse-up-front on MAX_CALLS and per-call ceiling
- `server/scripts/studioConceptEval.ts` (new) — loops `studioPlanRoute`'s logic over the 13 briefs under one total cap
- tests beside each; `docs/probes/plan-eval.md` gains a section; this ledger

**Production files touched: none.** No seam is needed (C4). If B finds one is, it STOPS and reports.

**R-12 (a) needs a written compatibility table** — no code relates `shot_type` to `camera`. Pre-registered here:

| shot_type | Compatible camera members |
|---|---|
| portrait | medium, close_up, extreme_close_up, medium_wide, low_angle, high_angle, over_the_shoulder |
| action | wide, medium_wide, medium, low_angle, high_angle, overhead, pov |
| lifestyle | wide, medium_wide, medium, close_up, pov, over_the_shoulder, high_angle |
| group | wide, medium_wide, medium, overhead, high_angle |
| text_graphic | none — any camera ask counts as a disagreement |
| other | any (not counted) |

---

## 8. Phase R deliverable (e) — spend cells

Per-call ceiling $0.075 (`studioPlanRoute.ts:103`; `ingest-flip.md:185-199`). Formula for every cell: **calls × $0.075**.

| Cell | What | Calls | Ceiling |
|---|---|---|---|
| S-0 | The census, both runs; all fidelity compiles (in-process, pure) | 0 | **$0** |
| S-1 | Concept eval + fidelity input: 13 briefs × 1 cell × 2 calls (concepts, then plan with pick A) through the route | 26 | **$1.95** |
| S-2 | Plan-eval baseline (R-11) at `0ebb8528a218`: 13 briefs × n=3 × 1 call through the route | 39 | **$2.93** |
| S-3 | Escalation, per ambiguous brief after a reveal: n=6 × 1 call | 6 per brief | **$0.45 per brief** |

S-1 + S-2 = 65 calls, **$4.88**, under the 80-call cap. Each cell needs Adi's explicit go per run.

**Two things Adi should know before any go:**
- Every route plan cell **writes a `studio_plans` row** to the live database under Adi's athlete id. That is the route's existing behaviour, and it is how every prior route-based eval ran. The concepts stage writes nothing. If rows must not be written, no route-based cell can run; say so and B will stop there.
- `PER_CALL_CEILING_USD` is printed today, not enforced. `spendGuard` will refuse a run up front when `calls × 0.075` exceeds the cell's quote or `calls` exceeds 80. After a run it compares billed tokens to the ceiling, and it cannot cut a run short.

---

## 9. Cards — every DEAD / broken row, with a proposed owner. None fixed here.

| # | Card | Owner |
|---|---|---|
| K1 | Fence brand lines in the legacy image prompt and the native DO NOT | PR 18 |
| K2 | Fence recommend's brief lines and brand name | PR 19 (image ops) |
| K3 | `storyboardRun.ts:111` passes no composer flag → composition / motion stripped | unowned — PR 15 follow-up |
| K4 | `brandBoardSeed` uses `campaign !== null` as the composer flag | unowned — PR 15 follow-up |
| K5 | Held rows' capabilities drop with no record | unowned — PR 15 follow-up |
| K6 | Join reasons and dropped slots never leave the client | unowned — PR 15 follow-up |
| K7 | Image generate never classifies or interprets; non-ASK `initialPath` dead at spend | PR 19 |
| K8 | `Routed.ambiguity` / `confidence` dead; `low_confidence*` unreachable; wire `op`/`targets` unread; `proposal.steps` dead | PR 19 |
| K9 | Recolour colour overridden by detection label | PR 19 |
| K10 | Recommend "ad" structurally dead; carousel `recs[0]` unfiltered; memo key omits brand | PR 19 |
| K11 | Edits carry no constraints; known-brand ad excludes its own logo | PR 19 |
| K12 | Native-off derived ops quote but always refuse | PR 19 |
| K13 | `DetectedBox.label`, `readThingKeep.thing` | PR 19 |
| K14 | Campaign never reaches image compile; `references[].assetId`, `JobCampaign.objective` unrendered; identity-pose unreachable | PR 18 |
| K15 | `references[].label` never sent; `ProductPiece.reference` always null; `direction.untrusted` constant on `/studio/preview` | PR 18 |
| K16 | 19 AthleteHalf leaves and BrandHalf tier / audience / recentCampaigns stored, never compiled | PR 18 |
| K17 | Legacy `buildPrompt` lives outside `compile/` | PR 18 |
| K18 | `studio_plans.confirm` and `brief_file_path` read by nothing; `StoryboardRow.direction` read by nothing | unowned |
| K19 | Nine per-beat fields paid for, never read; `vision.video`/`prev`; provenance evidence; `clip_read` quoted/billed | unowned (clip lane) |
| K20 | Video tagger lacks face / role; `retag.ts` has no caller | unowned |
| K21 | Stitched outputs tagged and billed, refused by the planner, offered by the picker | unowned |
| K22 | Drift-from-beats hop dead (QA before any read) | unowned |
| K23 | Typed edits run no QA; QA display-only; generate QA 2 of 5 checks | unowned |
| K24 | Cost: five spend sources write no line; recommend / detection unjoinable; stitch no line; video `cost_usd` null; no athleteId | unowned |
| K25 | Deal's `brandId` not sent on Board plan / carousel | unowned (Studio client) |
| K26 | `studio_brand_profiles` unwired; `brand.profile` never filled | unowned (Studio) |
| K27 | `brand_safety` string vs object → dos/donts always `[]`; no palette writer; no `deal_deliverables` writer; shared-name overwrite | **Mia** |
| K28 | Generated rows unreachable past page 1 (`posted_at` null); `deleted_at` never set; `content_brands` dead | **Mia** |
| K29 | `videoPoster` gcs_path repoint breaks stitch idempotency; whole-object metadata writes | **Mia** |
| K30 | `rejected` generations still castable; stitched outputs in the picker; hand-added Board photos `hasPerson:false` | unowned |
| K31 | Subject guard ignores `vision.subject` | PR 19 |
| K32 | `DEFAULT_CLIP_SECONDS` always used from the Board; bed level / start / asset never sent | unowned |

---

## 10. Decisions for Adi

1. **Go / no-go on Phase B** as mapped in §7, with zero production files.
2. **Every DEAD row in §9**: rule DELIBERATE-DEAD (with the ruling becoming the cite) or DEAD.
3. **The concept rubric's "groundedness" criterion** — as written, or "groundable in her library".
4. **The camera-vs-shot_type table** in §7 — accept, or amend before any metric is computed.
5. **Spend:** S-1 ($1.95) and S-2 ($2.93), each a separate go; and whether route cells may write `studio_plans` rows.
6. **Blocker-class items K1 and K2** — they are not this PR's to fix, but they meet house rule 4. Raise them with PR 18 / PR 19 now or after the census confirms them.

## Spend lines
- Phase R: $0.

## Misses
- None yet — nothing has been measured against a prediction.

---

## Lane 1 — built and held (2026-09-24)

Branch `studio/flow-eval`, base `b5469982`, commits `c7cbffd2` (step 1) and `9f7484d1` (step 2), **unpushed**. Everything lives in `server/studio/agent/eval/census/**`. **No production file was touched**, so P-seams holds.

| Piece | File |
|---|---|
| Row set, derived from code (zod walk, drizzle columns, syntax-only TS walker) | `census/rows.ts` |
| Nonce campaign, member words, op params | `census/fixture.ts` |
| Capture points in pipeline order, consuming set, writer | `census/capture.ts` |
| Reach measurement (tokens exclusive to a field within its object; member words) | `census/measure.ts` |
| The eight flows | `census/flows/{brief,reference,moment,ideas,carousel,makeIt,clipRead,identity}.ts` |
| One verdict and cite per row | `census/verdicts.ts` |
| Standing flow census, flags on and flags off | `census/census.test.ts` |
| Row set / verdict completeness / cite rules | `census/rows.test.ts` |
| Capability (48 × 4 legs + composer-off) and reading (12) census, unit | `census/capabilities.test.ts` |

**Scoped gate at the step-2 hold (Adi's ruling for this PR: no full suite here):**

    NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=8192" LOG_LEVEL=silent \
      npx jest server/studio/agent/eval/census --runInBand --json --outputFile=<scratch>/run.json

3 suites / 20 tests / 0 failed. `npx tsc --noEmit -p tsconfig.jest.json` is clean for the census. `CENSUS_OUT=<dir>` writes every capture point as text, plus `measured-{on,off}.json`.

### Misses and deviations, stated plainly

- **Row count: 432, not 398. A clean miss.** R-1's list omitted the carrier's `JobCampaign` (imported into `BriefJob`, so it's one opaque leaf there by the counting rule). Lane 1 added it as its own source (12 leaves). The mechanical enumerator also expands in-file types the hand count did not (for example `AssetTags.content_flags` into 6 leaves, and `LibraryEntry.tags` and `beats[]`), and keeps imported types opaque where the hand count expanded them (`BriefInput.shot`, `BriefInput.campaign`).
- **P-coverage, re-stated against 432 as a derived figure, not re-registered.** The registration stands: 0.78 of 398 rows, band 0.73–0.83. The derived equivalent for the same fraction over 432 rows is 337 rows. The measured figure and its comparison are lane 2's step 4. The prediction is not retro-fitted.
- **Verdicts were written after the first measurements, from recon plus measurement.** The table is the standing expectation. The predictions in §5 were registered before any capture and are unchanged.
- **Five fixture choices were wrong, and were fixed; they were not product defects.** A nonce inside the preposition "beside" broke the product place and add sentences. An ad headline whose words were not in its campaign was correctly refused by the grounding check. An identity pack of three photos is incomplete by design (`PACK_MIN` = 10). The profile route answers `{ profile, quote }`, not the bare profile. And `UPLOAD_LIMITS` was missing from the storage stand-in, which hung the stitch-options route.

### New findings from measurement (carded, not fixed)

| # | Finding | Evidence | Owner |
|---|---|---|---|
| K9 (confirmed by measurement) | Her colour loses to detection's region label. "make my jersey teal" compiled to `make the jersey zq160` (the stood-in region label) | `census-on/18-adapter_inputs.txt`, Create Anything edit; `nativeIntent.ts:370` vs `:393` | image-path parity PR (ADI-24SEP R5), before PR 19 |
| K33 | A garment swap to a brand outside the classifier's brand list is refused with "That edit can't be read as a change to this photo." (422, `field: op`). A design on the same garment quotes fine | `census-on/15-op_quote.txt`; `edit/ops.ts` garment `REPLACE_OBJECT` path (`canonical.ts:147`, `templates.ts:227`) | **PR 19** (image ops and classifier additions) |
| K34 | The identity pack reaches the adapter only with `STUDIO_IDENTITY_PACK` on. Measured: 3 `character` refs flags on, 0 flags off, for a first-person sentence with no attachment | `census-{on,off}/18-adapter_inputs.txt`, flow 8 | not a defect: the roadmap's delta, for P-delta |
| K35 | Clip read is 404 with the gate off, so the off-run's clip is never read and the plan has nothing to cut into | flow 7, `plan_request` capture | not a defect: roadmap delta |

### When composer-boundary (PR 15.1) merges, re-run and re-verdict

From the composer-boundary session, measured on its branch (Adi's rulings there, `docs/probes/composer-boundary.md`):
1. `census/flows/brief.ts` `boardAndBeyond` calls `boardRequests(seed.rows, seed.objective, planId)`. That call needs the new fourth argument, `composer`, or the census keeps measuring the old strip: Board b-roll stays 33/48, and 48/48 with the argument.
2. With the flag on these flip. `capabilities.test` `EXPECTED_BOARD_DROPS` goes to empty (P-caps' "15 never render" becomes 0). `capability:composition.*` and `capability:motion.*` go DEAD to CONSUMED. `boardRow:droppedSlots[].*` goes alive, persisted at `studio_stitch_jobs.spec.composer`. §2.3's "Board b-roll 4 of 6" becomes 6 of 6, and "join reasons never reach the spec" becomes false. K3–K6 close.
3. `parseStitchSpec(stitch.body)` picks up `spec.composer` with no census edit (the parser defaults to `composerEnabled()`).
4. **By ruling (ADI-24SEP-GO there), these are not DEAD:** i2v-of-her 10/48, product-from-photo 11/48, bridges no slots, and held rows render nothing but record nothing-filmed.

The census will red by name on each of these the first time it runs on a tip that includes #15.1. That is the instrument working. Re-verdict, never loosen.

**The composer-boundary walk's stitch finding: explained (2026-09-24).** A live stitch from a manually built Board (`e8759769`) stored no `spec.composer`. 15.1's answer: **the same builder and no server strip.** The app's client composer flag resolved FALSE in the dev bundle. PR #588's committed `.env.development` sets `EXPO_PUBLIC_STUDIO_COMPOSER=false`, and Expo loads `.env.development` after `.env`, so the committed false outranks a developer's `.env`. With a `.env.local` override the field lands (stitch `ceed40be`, joins `[position-0, default-fade]`). **The census's stitch capture point is right and does not move.**

**Does any census leg read a client flag from the environment? No. The census is unaffected.** Checked at `5e15de50`:
- **No env reads:** no file under `server/studio/agent/eval/census/` reads an `EXPO_PUBLIC_*` value. `census.test.ts` sets `process.env` for SERVER flags only, and never loads a `.env` file (jest does no Expo layering).
- **Literals throughout:** every client flag is passed as an argument. Composer and carrier are `ctx.flagsOn` (`flows/brief.ts` `boardAndBeyond`). The identity pack is `previewBody(…, ctx.flagsOn)` (`flows/identity.ts`). The interpreter is `interpreter: true` (`flows/makeIt.ts`, `flows/identity.ts`), deliberately the same in both runs, since `STUDIO_INTERPRETER` is a base flag, not one of the six gates.
- **No client module reads the flags module:** none of the ones the census calls import `client/lib/flags.ts`. The one client module that reads a flags constant at load, `client/hooks/use-studio`, is imported type-only everywhere in the census, so it is erased.

**Two argument lags that keep composition and action stripped after #15.1 merges** (literals, not environment):
- `flows/brief.ts:450`: `boardRequests(…)` needs its new fourth argument, `composer`.
- `capabilities.test.ts:183`: `clipRequestFor(rows[0], "grow-following")` needs `null, true` (the planId, then the composer).

**Kept, on its own merit:** add a hand-built Board to flow 1's Board step, so the manual path is censused beside the plan-seeded one.

---

**Published for Mia (ADI-24SEP R11):** §0, §2.10 and §9 word for word, plus K33 and a table of the rulings that change the cards, as a private Claude Doc: https://claude.ai/code/artifact/b73338ea-8640-41cd-adda-ed271a71c8d1 . It is private until Adi shares it from the doc's Share menu.

## Lane 2 — the hand-off (a fresh session runs this from the ledger alone)

**Start:** worktree `/Users/adi/nomila-v2-worktrees/flow-eval`, branch `studio/flow-eval`, tip `9f7484d1` or later. Read, in this order: this ledger's R-hold rulings (ADI-24SEP), §5 predictions, §6 mutations, §7 component map, §8 spend, then this section. House rules: CLAUDE.local.md. Never push; one jest slot across sessions (announce to peers); scoped runs call jest directly with `--runInBand --json --outputFile` and read `assertionResults`; `tsc -p tsconfig.jest.json` before every commit; commit per step; if context tightens, stop after the step that landed.

**Lane 1 steps moved here (Adi, 24 Sep):**
- **Step 3: the five census mutations**, red by name, then green. Back the file up, mutate, run, then restore from the backup; never `git checkout --`.
  - **M1**, "a CONSUMED field goes dead": drop `tone` from `feelLine` in `server/studio/campaign/carrier.ts`. `census.test` must red naming `campaignBrief:creative_direction.tone` and `jobCampaign:tone` at `compiled_prompts`.
  - **M2**, "a new brief field passes unverdicted": add an optional leaf to `campaignBriefSchema`. `rows.test` "no census row is unverdicted" reds naming it.
  - **M3**, "the census green with the carrier flag off": make the off-run set `STUDIO_BRIEF_CARRIER`. `census.test`'s off-run reds on the carrier rows ("now reaches compiled_prompts — re-verdict").
  - **M13**, "the census writes to production tables": set `DATABASE_URL`, or remove the `server/db` mock. The suite refuses to run.
  - **M15**, "a DELIBERATE-DEAD with no cite passes": strip a DELIBERATE-DEAD cite to plain words. `rows.test` reds.
  - M12 is moot (no seams), and is replaced as §6 says.
- **Step 4: coverage and delta.** From `measured-{on,off}.json` and `verdicts.ts`:
  - Print "N of 432 CONSUMED or DECIDES, K DELIBERATE-DEAD, D DEAD" for each flag state, and the delta: rows CONSUMED with flags on and DEAD with them off.
  - Compare to P-coverage (0.78 of 398, derived 337 of 432) and P-delta (19, band 16–22).
  - Walk P-dead's named list against the table, and report every miss in both directions.
- **Step 5: the ledger-rendering script**, `server/scripts/studioFlowCensus.ts`. It runs the census suites with `CENSUS_OUT`, then renders the coverage line, the per-source table and the DEAD list with owners into this ledger between two marker comments. It is a convenience; the assertions are the instrument.

**The lane 2 evals (R-9 to R-13). Adi judges every sheet. The session never grades.**

1. **CONCEPT_CRITERIA** is a new const beside `CRITERIA` in `server/studio/agent/eval/sheet.ts` (`CRITERIA` is at `:21-29`). The four criteria are frozen at this wording before any run:
   - `relevance`: the concept answers what the brief asks for.
   - `groundable`: groundable in her library, **judged with the plan that follows beside it** (ADI-24SEP R8), not the concept alone.
   - `non_generic`: the concept could not be pasted onto any other athlete or brand.
   - `distinct`: different from the other concepts for the same brief.
   Each is scored 1–5, with a free-text note column.
2. **Sheet mechanics that need a criteria parameter:**
   - `scoresTemplate(codes)` (`sheet.ts`) and `parseScores(csv)` / `reveal(...)` (`reveal.ts:27-45`) are hard-wired to the plan `CRITERIA`. Give each a `criteria` parameter that defaults to `CRITERIA`, so the plan sheet stays byte-identical.
   - Reuse `shuffle` and `assignCodes` (seed 20260922) unchanged.
   - Write a `conceptSheet.ts` whose cell is `{ code, briefId, prompt, objective, aesthetic?, concepts: {angle, feeling, line}[], plan items (for groundable) }`, with **no field for a run label, a model name, a fingerprint, a git sha or a timestamp**. The type is the guard.
   - `key.json` is written beside the sheet and never linked from it.
3. **The concept run (R-9, spend cell S-1)** uses `server/scripts/studioPlanRoute.ts --concepts` against a running server started by Adi on this worktree:
   - Each cell is 2 calls: the concept stage, then the plan with pick A.
   - The script takes one `--brief` per invocation, so a new `server/scripts/studioConceptEval.ts` loops the 13 briefs of `server/studio/agent/eval/briefs.ts` under **one total cap**.
   - Every concept, picked or not, is kept on the run file (`probe-out/flow-eval/…`), **never in the DB**.
   - The route writes a `studio_plans` row per plan cell under Adi's athlete id. This is allowed (ADI-24SEP R10).
4. **Brief fidelity (R-10), split in two:**
   - **Deterministic, asserted in code** in `server/studio/agent/eval/fidelity.ts`:
     - (a) every confirmed constraint appears in every compiled prompt that should carry it, and a "do not X" beside an X is a failure, not a pass;
     - (b) the confirmed output type and aspect are respected;
     - (c) the product line is carried;
     - (d) the tone triple is present.
     - Compiled prompts come from replaying each cell's cast items through `seedRowsFrom` → `boardRequests` → `plannedInputs(brief)`, in-process at $0. If `plannedInputs` needs the DB, STOP and report.
     - **P-constraint predicts:** honoured in every video prompt with the carrier on; absent from every image-generate and typed-edit prompt (DEAD by defect, ADI-24SEP R6); absent everywhere with the carrier off; and the known-brand ad's own-logo exclusion (`ops.ts:539-541`) fails fidelity.
   - **Judged, on a blind sheet:** only "the concept's angle is traceable in the plan".
5. **Watch metrics (R-12)** go in `server/studio/agent/eval/watch.ts`. Free, deterministic, no threshold; report a number per run:
   - **(a) camera vs shot_type disagreement rate on photo rows**, using **Adi's pre-registered table (ADI-24SEP R9)**. The finer shot-size tag (the PR 12 card) would replace it with a measured relation:

     | shot_type | Compatible camera members |
     |---|---|
     | portrait | medium, close_up, extreme_close_up, medium_wide, low_angle, high_angle, over_the_shoulder |
     | action | wide, medium_wide, medium, low_angle, high_angle, overhead, pov |
     | lifestyle | wide, medium_wide, medium, close_up, pov, over_the_shoulder, high_angle |
     | group | wide, medium_wide, medium, overhead, high_angle |
     | text_graphic | none: any camera ask counts as a disagreement |
     | other | any (not counted) |

     Inputs are a stored plan's items (kind, `capabilities.camera`, `assetId`) plus the asset's `metadata.vision.shot_type`, read under her athlete id.
   - **(b) capability drop-rate per plan:** recompute with `slotsAllowed(row, composer)`, because `droppedSlots` is not stored until #15.1 lands.
   - **(c) join-reason distribution per stitch:** `boardStitch(...).joins`, or `spec.composer` once #15.1 lands.
6. **spendGuard (R-13)** goes in `server/studio/agent/eval/spendGuard.ts`. **Refuse up front, never truncate:**
   - Before the first call, refuse if planned calls exceed `MAX_CALLS` (80), or if planned calls × `PER_CALL_CEILING_USD` ($0.075) exceed the cell's quoted ceiling.
   - After a run, compare billed tokens to the ceiling and report. A run is never cut short midway.
   - M9 and M10 red by name in `spendGuard.test.ts`.
7. **The plan-eval baseline (R-11, spend cell S-2):** the existing route harness at fingerprint **`0ebb8528a218`**. Re-verify it first: at `b5469982` it is identical with every Studio flag on and off. Record it in `docs/probes/plan-eval.md` as **THE** baseline after the carrier and the composer.
8. **Mutations M5–M11** (§6), each red by name, then green.

**Spend (quoted; every cell needs Adi's explicit go per run; formula calls × $0.075):**

| Cell | What | Calls | Ceiling | Go |
|---|---|---|---|---|
| S-1 | Concepts + plan with pick A, 13 briefs × 1 cell × 2 calls, through the route | 26 | **$1.95** | **GO** (ADI-24SEP R10) |
| S-2 | Plan-eval baseline at `0ebb8528a218`, 13 briefs × n=3 × 1 call, through the route | 39 | **$2.93** | **GO after S-1 reports** |
| S-3 | Escalation, one ambiguous brief at a time, n=6 | 6 per brief | **$0.45 per brief** | a go each |

**Gate for the PR:** one full `npm test` (bare, every per-batch summary read and quoted) runs at the very end, on the tip that merges, after lane 2 (Adi's ruling). The `affiliationSync` year-only test is the house flake: re-run it in isolation before believing it.

## Lane 2 — steps 3 to 5 of lane 1 (2026-09-24, this session: Adi said start lane 2 now)

### Step 3: the five census mutations, each red by name, then restored from a backup to a clean tree

| # | Mutation | Red, by name |
|---|---|---|
| M1 | drop `tone` from `feelLine` (`campaign/carrier.ts`) | census.test, flags on: `jobCampaign:tone: CONSUMED at compiled_prompts (flags on) — not reached now; last seen at nowhere downstream` |
| M2 | add `census_probe` to `campaignBriefSchema` | rows.test "no census row is unverdicted": `campaignBrief:census_probe` |
| M3 | the off-run sends the carrier (`const carrier = true` + `STUDIO_BRIEF_CARRIER` set) | census.test, flags off: red. **Named rows were not the ones predicted:** `studioPlans:plan`, `castItem:direction` and `boardRow:prompt` stopped reaching `compiled_prompts` in the off-run. I had predicted the carrier rows would come alive. The instrument reds, but on a different axis. Not investigated. |
| M13 | `DATABASE_URL` set | all 4 census.test tests: `census: DATABASE_URL is set — refusing to run` |
| M15 | a DELIBERATE-DEAD cite stripped to plain words | rows.test "a DELIBERATE-DEAD cites the ruling that made it so": `jobCampaign:references[].ref` |

Runner: back the file up, apply the edit (asserting the old text is present), run jest `--json`, read `assertionResults`, then restore from the backup and check `git diff` is clean after each.

### Step 4: coverage and delta, against the pre-registered predictions

**Measured on the merged tip** (`96796537`: this branch plus `origin/main` with PR 15.1 #589, merged at `32eb639f`). Before measuring:
- `boardRequests` took its fourth argument, `composer`.
- `clipRequestFor` took `null, true`.
- The stitch's composer input carries `planId`, as `StoryboardTab.tsx:904-906` does.
- The composer's record on the spec is measured as its own, non-consuming point, `stitch_record` (it reaches no ffmpeg argv, `composer-boundary.md:44`).

The checklist rows were re-verdicted as follows:
- The 15 composition and action members went DEAD → CONSUMED; K3 is closed, and the Board drops no member.
- `boardRow:droppedSlots[].*` went DEAD → DELIBERATE-DEAD: recorded on `studio_stitch_jobs.spec.composer` by 15.1's ruling (`composer-boundary.md:105-115`).

| Prediction | Registered | Measured on the merged tip | Verdict |
|---|---|---|---|
| **P-coverage** | 0.78 of 398 (band 0.73–0.83); derived 337 of 432 | **320 of 432 = 0.741** CONSUMED or DECIDES, flags on (211 + 109) | **HELD within the band.** Below the 0.78 point and below the derived 337. |
| **P-delta** | 19 (band 16–22) | **33** | **MISS, above the band** |

- **Flags on:** 320 CONSUMED or DECIDES, 81 DISPLAY, 13 DELIBERATE-DEAD, 18 DEAD.
- **Flags off:** 287, 48, 10, 87.
- **Why the delta is 33, not 19.** The census counts the tagger's fields twice: once as `assetTags` (11 in the delta) and once as `libraryEntry.tags` (12). I predicted the 12 fields once. The carrier adds 10: six `jobCampaign`, the two campaign rows on `briefInput`/`briefJob`, and the plan row's `concept` and `aesthetic`.
- **Reverse delta (DEAD with flags on, alive with them off): 0.** It was 15 before the merge: composition and action, carried as prose with the composer off and stripped at the Board with it on. PR 15.1 removed it.
- **Superseded:** the pre-merge numbers in `1fa1d91d` (305 of 432 = 0.706, a miss below the band; reverse delta 15) were measured before #15.1 and are kept here only as the record of what 15.1 changed.
- **P-dead, walked name by name:**
  - **Held, predicted DEAD and measured DEAD (11):** `brand.profile`, `references[].assetId` (brief and JobCampaign), `JobCampaign.objective`, `studio_plans.confirm`, `StoryboardRow.direction`, `PreviewRequest.references[].label`, `PreviewRequest.durationSeconds`, cost line `previewId` / `batchId` / `promptVersion`, QA `clip.reroll`.
  - **Missed in the "alive" direction:**
    - `studio_plans.brief_file_path` is DISPLAY by ruling (R7).
    - `ShotSpec.composition` / `ShotSpec.motion` are CONSUMED, and the Board path is fixed by #15.1.
    - `StoryboardRow.droppedSlots` is recorded by #15.1's ruling, so DELIBERATE-DEAD, not DEAD.
    - `CastItem.beats` is one row, DISPLAY.
  - **Missed in the "dead" direction (DEAD, not named):** `studioPlans:created_at`; `briefJob:direction.untrusted` and `direction.featuredPieces` (K15); `briefInput`/`briefJob` `references[].label` (K15); `shotSpec:environment` (no planner axis can fill it; new; unowned).
- **P-caps, re-measured after the merge:** prose-only 0; **0 members dropped at the Board** (was 15; the registration's "15 never render through a Board request" is now false, as the checklist said it would be); 3 collapse; movement only on her photo.
- **P-seams:** held.
- **P-fingerprint:** not re-measured at this tip; S-2 re-verifies it before it runs.

### Step 5: the ledger script

`server/scripts/studioFlowCensus.ts` runs the census suites (with `CENSUS_OUT`) and renders the section below between its markers. It is a convenience; the suites are the instrument. `--no-run` renders from the verdict table alone, which is what produced the section below at `145b0761`+.

## Lane 2 — the evals, built (2026-09-24, same session; tip after `cfaa52d4`)

**Built:**
- `CONCEPT_CRITERIA` (relevance, groundable, non_generic, distinct), frozen at ADI-24SEP R8's wording, in `sheet.ts`.
- A `criteria` parameter on `scoresTemplate`, and `parseScoresFor` in `reveal.ts`. The plan sheet is byte-identical, and its suites stay green.
- `conceptSheet.ts`: a blind, fixed-seed sheet (20260924) whose cell type has no run, model, fingerprint, sha or time field; the key holds those. It includes a median reveal, and the deterministic half of distinctness (share of within-brief pairs under the 0.5 Jaccard bar).
- `fidelity.ts`: the deterministic half (constraints present and NOT contradicted, output kind and aspect, product line, tone).
- `watch.ts`: Adi's camera/shot_type table (R9), the drop-rate, and the join-reason distribution.
- `spendGuard.ts`: refuse up front on MAX_CALLS 80 or calls × $0.075 above the quote; report after, never stop midway.
- `server/scripts/studioConceptEval.ts`: dry by default, spendGuard first, 13 briefs × (concepts + plan with A), every concept on the run file, `--sheet`, `--reveal`.
- Eval suites: 14 / 71 green (scoped).

**Mutations, each red by name, then restored to a clean tree:**

| # | Mutation | Red, by name |
|---|---|---|
| M5 | fidelity skips the contradiction check | fidelity.test "a constraint present in the prompt but contradicted passes fidelity — it must FAIL" |
| M6 + M8 | the sheet renders the key's `source` into a cell | conceptSheet.test "the concept sheet reveals the run label — it must not" AND "a judge sees the model name — it must not" |
| M7 | the sheet keeps input order (no shuffle) | conceptSheet.test "…shuffled, by a fixed seed…" |
| M9 | the MAX_CALLS comparison doubled | spendGuard.test "a run exceeds MAX_CALLS — refused whole" |
| M10 | the ceiling comparison ×10 | spendGuard.test "a run exceeds the per-call ceiling — refused whole" |
| M11 | the runner imports `savePlan` | conceptRun.test "an un-picked concept is written to the DB — it cannot be…" (held structurally: the runner imports no db, schema or drizzle) |
| M16 | every counted camera ask is a disagreement | watch.test "a compatible pair counts as a disagreement — it must not" |

**Things to know:**
- **A mutation-runner defect, caught and fixed.** M6's two edits to one file overwrote the pristine backup. `conceptSheet.ts` was left mutated for M7–M16's runs. I found it in `git diff`, reversed that single line by hand (not by checkout), fixed the runner to back a file up only once, and re-ran M6 and M7. M9–M16 touch other files and stand.
- **M6's first form failed to COMPILE,** which is not a red; its second form reds.

**P-constraint, measured at $0 on the census's own captures** (merged tip; flow 1's confirmed brief carries "do not show ZQ040 any stopwatch"):

| | Flags on | Flags off |
|---|---|---|
| Clip jobs carrying the brief's do-not | 3 | 0 |
| Video prompts carrying it | 3 of 3 of those jobs (templates: identity, b-roll) | 0 |
| Contradicted (the thing asked for outside the constraint line) | 0 | 0 |
| Image-generate prompts carrying it | 0 of 2 | 0 of 2 |
| Adapter calls carrying it (typed ad, carousel batch ads, Create Anything edit and generate) | 0 of 8 | 0 of 8 |

**P-constraint's verdict:**
- **Held:** honoured in every carrier-on video prompt measured, and absent everywhere with the carrier off.
- **Held, K11 confirmed by measurement:** absent from every image and edit prompt. The carousel's ads were quoted from the same brief's lines and still carry no constraint to the model.
- **Partly unmeasured:** "all 4 templates". The census board has no bridge (transition template), and identity-pose is unreachable (K14).
- **Not measured:** the known-brand ad's own-logo exclusion. The census names no real brand by design, and the classifier knows only a real brand list.

**Gaps and ambiguities in the hand-off, stated rather than filled:**
1. **Fidelity on S-1 has almost nothing to check.** The 13 eval briefs (`briefs.ts`) carry no confirmed campaign: no constraints, output, product line or tone, only her sentence and an optional feel. Fidelity's deterministic half can only run where a confirmed brief exists. Today that is the census captures (above). On S-1 it reduces to "her feel line reaches the plan". To score fidelity at plan level, the 13 briefs need confirmed campaigns: a fixture change that is Adi's call, since the briefs are the plan-eval's fixed set.
2. **S-1 needs a running server on this worktree and a bearer token**, as every route eval has. House rules keep the session from starting one. **To run S-1:** start `npm run dev:proxy` and `npm run server:dev` in `/Users/adi/nomila-v2-worktrees/flow-eval`, put a token in `probe-out/flow-eval/.token`, then:

       DATABASE_URL=postgres://x:x@127.0.0.1:1/none npx tsx server/scripts/studioConceptEval.ts --run --label s1 --quote 1.95

   Dry run, verified: 13 briefs × 2 = 26 calls, ceiling $1.95. A quote of $1.50 is refused whole, nothing sent.
3. **S-2's plan-eval baseline** uses `studioPlanRoute.ts` per brief, n=3 (39 calls, $2.93), after S-1 reports. **P-fingerprint re-verified at `14738a15`** (the tip, with #15.1 merged): `0ebb8528a218`, identical with every Studio flag unset and with every `=== "true"` flag set. **P-fingerprint HELD.**
4. **The judged half of fidelity** (is the concept's angle traceable in the plan) rides the concept sheet: the plan sits beside the concepts, and `groundable` is judged against it.

## Before S-1 — Adi's three items (2026-09-24)

**1. Every mutation re-run on a clean tree.** The runner now asserts before and after each mutation that the tree is byte-identical to the tip: `git diff HEAD --quiet` and an empty `git status --porcelain`. It refuses to start otherwise, and stops if a restore leaves anything behind. All twelve were re-run at `5494adb3`: M1, M2, M3, M13, M15, M5, M6 (+M8), M7, M9, M10, M11, M16. **Every one reds by the same name as before, and the tree was byte-identical to the tip before and after each. No result changed; nothing new surfaced.** M3 still reds on the unpredicted axis (`studioPlans:plan`, `castItem:direction`, `boardRow:prompt` in the off-run).

**2. Fidelity: the plan-eval briefs stay fixed; the code-checked half runs on the census's own nonce campaign.**
- The 13 briefs (`eval/briefs.ts`) are **FIXED ON PURPOSE** (Adi): changing them breaks comparability with every prior plan-eval run. They carry no confirmed campaign.
- **The fixture set's limitation, recorded:** fidelity's code-checked half cannot run on S-1's plans beyond **her feel line** (the one confirmed-ish field those briefs carry, as `aesthetic`). S-1 records only that. A separate campaign-carrying fixture set is an option **later, at Adi's ruling, not now**.
- **Where it runs instead:** `census.test.ts` "brief fidelity on the census campaign". It is standing, and checks flow 1's Board clip prompts against `CENSUS_CAMPAIGN`, the brief summarize-brief answered, so every field is traceable. Measured at the merged tip:

| Check | Flags on | Flags off |
|---|---|---|
| constraints (present in every clip prompt, not contradicted) | **pass** | fail (absent) |
| output (type video; aspect as confirmed) | **fail**: every clip is 9:16 by deliverable; the confirmed 4:5 shapes nothing | fail |
| product line in at least one clip prompt | **fail**: the carrier does not render `product.line` (K36) | fail |
| tone in at least one clip prompt | **pass** | fail |

**3. The not-measured items, carded by name:**

| # | Card | Cite | Owner |
|---|---|---|---|
| K36 | The confirmed product line never reaches a clip prompt. The carrier renders feel, aesthetic, concept and constraints only (`campaign/carrier.ts:201-217`); `product.line` reaches the planner and the ad op, never a clip. Measured by the standing fidelity test above. | `carrier.ts:201-217`; `census.test.ts` fidelity | PR 18 (brief / carrier), proposed |
| K37 | **Bridge template not measured.** The census Board never requests a bridge, so the transition template (`video/prompts.ts:472`, carrier `feel: false`: constraints only) is not driven, and "a do-not binds the bridge" is unmeasured. | `video/prompts.ts:472`; `storyboardRun.ts:130-167` `bridgeRequestFor` | the census (flow 1 needs a `bridgeRequested` row), this PR's follow-up |
| K38 | **The known-brand ad's own-logo exclusion, SHIPPING-VISIBLE, not measured here.** An ad for a brand on the classifier's list freezes `exclude_marks` for its own brand (`edit/ops.ts:539-541`), which compiles to `DO NOT: show a <brand> logo anywhere` (`compile/constraints.ts:59`) on an ad FOR that brand. The census names no real brand by design, so it cannot drive the listed-brand path. | `ops.ts:539-541`, `constraints.ts:59` | **the image-path parity PR's card** (ADI-24SEP R5/R6): it must add a test with a listed brand |

## S-1 — the concept run (2026-09-24, Adi's GO; spend line)

- **Run:** `s1-2026-09-24-b0f42149` (run file under `probe-out/flow-eval/runs/`, gitignored). The server ran from this worktree at `5494adb3`+, verified by the listening process's cwd. The prompt fingerprint is `0ebb8528a218`.
- **Cells:** 13 of 13 briefs; each answered 3 concepts and a plan with concept A (HTTP 200 on all 26 calls). Plans ran 4–6 items. **No failed cell.**
- **Spend line:** 26 planner calls; ceiling 26 × $0.075 = **$1.95** (the quote). The route reports no bill per call, so the billed amount is not measured; every call is within the per-call ceiling by construction. A `studio_plans` row was written per plan cell under Adi's athlete id (ADI-24SEP R10).
- **P-concept, the deterministic half:** distinctness is **39 of 39 within-brief pairs under the 0.5 Jaccard bar (100%)** against the registered ≥ 80%. **HELD.** Relevance, groundable and non-generic await Adi's blind scores.
- **The blind sheet:** `probe-out/flow-eval/sheets/s1-concepts/` (`sheet.html`, `key.json`, `scores.csv`): 13 cells, codes C01–C13, seed 20260924. The page holds no run label, sha or model name (checked), and `key.json` is not linked. Each cell shows the brief, the three concepts, which was planned, and that plan's items, so `groundable` is judged against the plan (R8).
- **Fidelity on S-1:** only her feel line (the briefs' `aesthetic`), per the fixture-set limitation above. The code-checked half ran on the census campaign instead.

## S-2 — the plan-eval baseline (2026-09-24, Adi's GO; spend line)

**THE baseline after the carrier and the composer (R-11)** at prompt fingerprint **`0ebb8528a218`**, re-verified at the merged tip flags on and off. The route is `studioPlanRoute.ts`, the server ran from this worktree, n=3 per brief.

| Brief | Cells | Slots | Camera | i2v (made-here) | Held | Clips | B-roll | Lookalike | All-camera |
|---|---|---|---|---|---|---|---|---|---|
| adidas-ad (re-run) | 3 | 16 | 6 (38%) | 4 (4) | 3 | 6 | 3 | 0 | 0/3 |
| training-recap (re-run) | 3 | 12 | 12 (100%) | 0 | 0 | 12 | 0 | 0 | 3/3 |
| announce | 3 | 11 | 8 (73%) | 2 (0) | 3 | 3 | 3 | 0 | 0/3 |
| hype | 3 | 17 | 9 (53%) | 3 (0) | 3 | 9 | 2 | 0 | 0/3 |
| thank-partner | 3 | 15 | 6 (40%) | 2 (2) | 4 | 6 | 3 | **1** | 0/3 |
| real-footage | 3 | 15 | 15 (100%) | 0 | 0 | 15 | 0 | 0 | 3/3 |
| day-in-life | 3 | 12 | 12 (100%) | 1 (0) | 3 | 8 | 0 | 0 | 3/3 |
| concept | 3 | 16 | 0 (0%) | 4 (4) | 0 | 6 | 6 | 0 | 0/3 |
| boots-then-match | 3 | 13 | 4 (31%) | 3 (3) | 3 | 4 | 3 | 0 | 0/3 |
| complex-i2v-trap | 3 | 13 | 6 (46%) | 3 (3) | 0 | 6 | 4 | 0 | 0/3 |
| acceptance-recap | 3 | 15 | 15 (100%) | 0 | 0 | 15 | 0 | 0 | 3/3 |
| acceptance-only | 3 | 15 | 15 (100%) | 0 | 0 | 15 | 0 | 0 | 3/3 |

- **All 36 cells answered 200.** One cell on thank-partner cast the known lookalike still (`routeCell.ts` `LOOKALIKE_PREFIX`).
- **The blind sheet:** `probe-out/flow-eval/sheets/s2-plans/` (36 cells, the plan eval's seed and seven criteria, built by `studioPlanRouteSheet.ts`). It holds no run label, sha or model name (checked). `sheets/s2-plans-trial/` is a 15-cell trial of the builder: **not for scoring**.
- **Sheet limitations (on the key too):** the route does not return the library lines the planner read, nor its gap lines, so the sheet's library panel is empty and gaps are not shown. That differs from the in-process sheets of 22 Sep, which showed both.

**Spend line and a QUOTE REVISION (not a silent overage):**

| | Calls | Ceiling |
|---|---|---|
| Quoted (Adi's GO) | 39 (13 briefs × 3) | $2.93 |
| Run: 12 briefs × 3 | 36 | $2.70 |
| Re-run: adidas-ad and training-recap × 3 | 6 | $0.45 |
| **Total, against the REVISED quote** | **42** | **$3.15** |

- **Why the revision:** a mid-run patch invalidated two run files. The route runner recorded only its cast summary, not each item's beat and direction, so a route run could not be sheeted. It was patched mid-S-2 (`c67112a1`) to record them. The two briefs finished before the patch (adidas-ad, training-recap) had no items and were re-run under new labels (`s2r-…`); the originals are kept, not overwritten.
- **Adi approved the revision** (42 calls / $3.15) explicitly before the re-run.
- **spendGuard worked as built:** on the original quote, 42 calls is refused up front: `42 calls × $0.075 = $3.15 exceeds the quoted $2.93 — refused whole, nothing sent`. On the revised quote it allows it.
- A `studio_plans` row was written per plan cell under Adi's athlete id (ADI-24SEP R10).

**K39 — product-drop was not run: a FIXTURE-vs-RUNNER gap, not a product defect.**
- The brief is flagged `product: true` (`eval/briefs.ts`). The route runner refuses any such brief before sending anything (`studioPlanRoute.ts:117-120`: "picks a product; this runner does not pick one yet").
- The in-process runner, before it was fenced, ran it with no product photo (`plan-eval.md:66`).
- No call was made and nothing was spent. **Owner:** the eval runner (a `--product <assetId>` flag, or a deliberate no-product mode matching `plan-eval.md:66`). This PR's follow-up, at Adi's ruling.

**Comparability, a limitation on the baseline, stated beside the number:**
- **S-2 is 12 briefs, not 13.** Prior plan-eval runs included product-drop (run without a product; `plan-eval.md:66`, `:150`, `:307`, `:324`), and **it is the only brief that measures `product_rules`**. So **S-2 cannot be compared with any prior run on `product_rules`**; that column will be blank or near-blank on this sheet.
- On the other six criteria, comparison is **per brief** on the 12 shared briefs. The pooled means are over 12 briefs, not the prior sets (11 briefs on 22 Sep, before the acceptance briefs were added), so **compare brief by brief, never pooled to pooled**.
- The sheets also differ in what the judge sees: no library or gap lines here.

## The reveals — S-1 and S-2 (2026-09-24)

**Scores of record: Adi's**, blind and scored first, transcribed from `s1-s2-blind-scores-both-scorers.xlsx` into each sheet's `scores.csv`. All 49 card codes and briefs matched the keys, and every value was 1–5. The workbook also carries a second scorer's columns ("CLAUDE — independent, scored after"). By this PR's rule no model's grading is a result, so those columns are kept **for comparison only**, in `sheets/*-COMPARE-claude-scorer/`, and never feed a verdict below.

**S-1, concepts (medians, Adi):**

| Criterion | Median | Registered | Verdict |
|---|---|---|---|
| relevance | **5** | ≥ 4 | **HELD** |
| groundable (with the plan beside it, R8) | **3** | ≥ 3 | **HELD** |
| non_generic | **4** | 3 | **MISS: registered 3, measured 4.** A miss in the good direction is still a miss; the prediction stays as written. |
| distinct (judged) | 4 | not registered as a median | — |
| distinctness, deterministic (pairs < 0.5 Jaccard) | 39 / 39 | ≥ 80% | **HELD** |

Second scorer (comparison): 5 / 3 / 3 / 4. The only median that differs is non_generic.

**S-2, plans (Adi; pooled over 12 briefs × 3; compare brief by brief with prior runs, never pooled; no product-drop, K39):**

| i2v_reserved | stills_where_carried | real_clips_used | broll_earned | product_rules | overall_mix | relevance |
|---|---|---|---|---|---|---|
| 3.47 ±1.86 | 3.78 ±1.62 | 4.83 ±0.56 | 4.31 ±0.95 | 4.47 ±1.16 | 4.75 ±0.50 | 3.67 ±1.01 |

**Per brief (means over n=3):**

| Brief | i2v | stills | real | b-roll | product | mix | relevance |
|---|---|---|---|---|---|---|---|
| acceptance-only | 5.00 | 5.00 | 5.00 | 5.00 | 5.00 | 5.00 | 5.00 |
| acceptance-recap | 5.00 | 5.00 | 5.00 | 5.00 | 5.00 | 5.00 | 5.00 |
| adidas-ad | 1.00 | 2.00 | 5.00 | 3.33 | 1.33 | 5.00 | 3.33 |
| announce | 5.00 | 5.00 | 5.00 | 3.00 | 5.00 | 5.00 | 3.00 |
| boots-then-match | 2.33 ±2.31 | 3.00 ±1.73 | 5.00 | 4.00 | 5.00 | 4.33 | 3.33 |
| complex-i2v-trap | 1.00 | 1.00 | 5.00 | 3.67 | 5.00 | 4.00 | 2.33 |
| concept | 1.00 | 1.67 | 5.00 | 5.00 | 5.00 | 3.67 | 4.67 |
| day-in-life | 4.00 ±1.73 | 4.00 ±1.73 | 3.00 | 5.00 | 4.33 | 5.00 | 2.67 |
| hype | 4.00 | 5.00 | 5.00 | 5.00 | 3.00 | 5.00 | 3.00 |
| real-footage | 5.00 | 5.00 | 5.00 | 5.00 | 5.00 | 5.00 | 4.33 |
| thank-partner | 3.33 ±2.08 | 3.67 ±1.53 | 5.00 | 2.67 | 5.00 | 5.00 | 3.00 |
| training-recap | 5.00 | 5.00 | 5.00 | 5.00 | 5.00 | 5.00 | 4.33 |

Second scorer, pooled (comparison): 3.61 / 3.83 / 4.83 / 4.39 / 4.61 / 4.33 / 3.78, within about 0.4 of Adi's on every column; overall_mix differs most.

**Read against S-2's own auto counts (an observation, not a grade).** The three briefs Adi scored i2v_reserved 1.00 are exactly the three where the route cast i2v onto made-here stills in every repeat: adidas-ad 4/4, concept 4/4, complex-i2v-trap 3/3. Every all-camera brief scored 5s. The weakest column tracks a signal the code already counts.

**CORRECTION (same day):** "exactly the three" was wrong. boots-then-match was ALSO made-here in every repeat (3/3), and Adi scored its i2v_reserved 2.33 ±2.31, not 1.00. The briefs scored 1.00 are all fully made-here, but full made-here does not always score 1.00. It is a strong signal, not a one-to-one match.

**K40, PROMOTED to a built watch metric (Adi, 24 Sep 2026)** in `watch.ts` (`i2vOnMadeHere`): i2v cast onto a made-here still, per plan, deterministic, no judge. Its mutation ("a camera i2v counts as made-here") reds by name. Measured on S-2's route cells, made-here i2v over cast i2v, per repeat:

| Brief | per repeat | Adi's i2v_reserved |
|---|---|---|
| adidas-ad | 2/2 · 1/1 · 1/1 | 1.00 |
| concept | 1/1 · 2/2 · 1/1 | 1.00 |
| complex-i2v-trap | 1/1 · 1/1 · 1/1 | 1.00 |
| boots-then-match | 1/1 · 1/1 · 1/1 | 2.33 ±2.31 |
| thank-partner | 1/1 · 1/1 · 0/0 | 3.33 ±2.08 |
| announce, hype, day-in-life | 0 made-here of 1–3 cast | 5.00 / 4.00 / 4.00 |
| training-recap, real-footage, acceptance-recap, acceptance-only | no i2v cast | 5.00 |

**S-2 total: 16 of 22 cast i2v (73%) were on a made-here still.**

**S-3: SKIPPED (Adi, 24 Sep 2026).** No ambiguous brief was flagged, and a spread check on a single run measures variance, not disagreement. The second run happens after PR 18 or 19 moves the prompt; then it compares to something. Background: the reveal's escalation compares TWO runs (`reveal.ts` `diff`); S-2 is one run, so **no brief was flagged ambiguous by rule.** The within-run spread candidates are boots-then-match (i2v ±2.31), thank-partner (±2.08) and day-in-life (±1.73). Choosing one is Adi's call, not a reveal result; $0.45 each at n=6.

<!-- census:begin (rendered by server/scripts/studioFlowCensus.ts — do not edit by hand) -->

### The census, as measured

- **Flags on:** 320 of 432 CONSUMED or DECIDES (211 + 109), 81 DISPLAY, 13 DELIBERATE-DEAD, 18 DEAD.
- **Flags off (the six roadmap gates off):** 287 of 432 CONSUMED or DECIDES (178 + 109), 48 DISPLAY, 10 DELIBERATE-DEAD, 87 DEAD.
- **Delta:** 33 rows are CONSUMED or DECIDES with the flags on and DEAD with them off.

| Source | Rows | CONSUMED | DECIDES | DISPLAY | DELIBERATE-DEAD | DEAD | held by flow / unit / static / cite |
|---|---|---|---|---|---|---|---|
| campaignBrief | 58 | 48 | 1 | 0 | 7 | 2 | 49 / 0 / 1 / 8 |
| studioPlans | 14 | 4 | 7 | 1 | 0 | 2 | 8 / 0 / 5 / 1 |
| briefProposal | 19 | 4 | 1 | 14 | 0 | 0 | 15 / 0 / 4 / 0 |
| assetTags | 23 | 17 | 6 | 0 | 0 | 0 | 17 / 0 / 6 / 0 |
| libraryEntry | 33 | 31 | 2 | 0 | 0 | 0 | 25 / 0 / 8 / 0 |
| readingDimension | 12 | 12 | 0 | 0 | 0 | 0 | 12 / 0 / 0 / 0 |
| capability | 48 | 48 | 0 | 0 | 0 | 0 | 0 / 48 / 0 / 0 |
| castItem | 27 | 2 | 12 | 13 | 0 | 0 | 5 / 0 / 22 / 0 |
| boardRow | 23 | 2 | 13 | 4 | 3 | 1 | 4 / 0 / 16 / 3 |
| clipRequest | 19 | 3 | 14 | 0 | 0 | 2 | 5 / 0 / 13 / 1 |
| briefInput | 31 | 5 | 25 | 0 | 0 | 1 | 6 / 0 / 25 / 0 |
| briefJob | 33 | 6 | 23 | 1 | 0 | 3 | 7 / 0 / 26 / 0 |
| jobCampaign | 12 | 6 | 1 | 0 | 3 | 2 | 10 / 0 / 0 / 2 |
| shotSpec | 6 | 5 | 0 | 0 | 0 | 1 | 0 / 5 / 0 / 1 |
| qaVerdict | 34 | 0 | 0 | 33 | 0 | 1 | 0 / 0 / 0 / 34 |
| costLine | 21 | 0 | 3 | 15 | 0 | 3 | 0 / 0 / 18 / 3 |
| opParams | 19 | 18 | 1 | 0 | 0 | 0 | 17 / 0 / 2 / 0 |

**The delta, by row:** `studioPlans:concept`, `studioPlans:aesthetic`, `assetTags:subject`, `assetTags:athlete_prominence`, `assetTags:aesthetic_quality`, `assetTags:brand_safe`, `assetTags:attire`, `assetTags:hero_suitability`, `assetTags:disposition`, `assetTags:edit_note`, `assetTags:reason`, `assetTags:face_visibility`, `assetTags:role`, `libraryEntry:tags.subject`, `libraryEntry:tags.prominence`, `libraryEntry:tags.quality`, `libraryEntry:tags.hero`, `libraryEntry:tags.brandSafe`, `libraryEntry:tags.flags`, `libraryEntry:tags.attire`, `libraryEntry:tags.disposition`, `libraryEntry:tags.editNote`, `libraryEntry:tags.reason`, `libraryEntry:tags.face`, `libraryEntry:tags.role`, `briefInput:campaign`, `briefJob:campaign`, `jobCampaign:tone`, `jobCampaign:style`, `jobCampaign:energy`, `jobCampaign:constraints`, `jobCampaign:concept`, `jobCampaign:aesthetic`.

**Every DEAD row (flags on), with its owner:**

| Row | Owner | Cite |
|---|---|---|
| `campaignBrief:brand.profile` | K26 → brand profiles (studio_brand_profiles wiring), unowned | no writer ever fills it: brandLogic.ts:175, direction/brief.ts:63, echo.ts:33 set null; summarizePrompt.ts never extracts it (the renderer at plan.ts:379-382 is live) |
| `campaignBrief:references[].assetId` | K14 → PR 18 (style spec) | server/studio/campaign/carrier.ts:65-69 — resolved at save (resolveRefs.ts), carried, read by nothing; "PR 18 reads it" |
| `studioPlans:confirm` | K18, unowned — rule DISPLAY or wire a reader | written plans.ts:117, echoed by GET, carried by replan — read by nothing (brandLogic.ts:268-271 says display-only; no ruling) |
| `studioPlans:created_at` | unowned — bookkeeping; rule DISPLAY or leave | a column default; no Studio reader orders or shows it (grep of server/studio/agent and routes/studio.ts) |
| `boardRow:direction` | K18, unowned | client/screens/studio/agentLogic.ts:299-303 — carried onto held rows, read by nothing (the stitch body leaves it out) |
| `clipRequest:durationSeconds` | K32, unowned | client/screens/studio/storyboardRun.ts:60-94 — the Board never sends it: every clip is DEFAULT_CLIP_SECONDS (preview.ts:257) |
| `clipRequest:references[].label` | K15 → image-path parity PR (ADI-24SEP R5) | client/lib/studio-contract.ts:579 — toEngineReferences sends {assetId, role} only; the manifest says "product 1" (preview.ts:388) |
| `briefInput:references[].label` | K15 → image-path parity PR (ADI-24SEP R5) | client/lib/studio-contract.ts:579 — never sent from Create Anything or the Board; the manifest falls back (preview.ts:388) |
| `briefJob:direction.untrusted` | K15 → image-path parity PR (ADI-24SEP R5) | server/routes/studio.ts:1419 — /studio/preview hard-codes origin "system", so untrusted is always false and the fence arm (preview.ts:775-777) is unreachable |
| `briefJob:direction.featuredPieces` | K15 → image-path parity PR (ADI-24SEP R5) | server/routes/studio.ts:1419 — always [] on /studio/preview |
| `briefJob:references[].label` | K15 → image-path parity PR (ADI-24SEP R5) | client/lib/studio-contract.ts:579 — never sent from Create Anything or the Board; the manifest falls back (preview.ts:388) |
| `jobCampaign:objective` | K14 → PR 18 | server/studio/campaign/carrier.ts:196-217 — carried, never rendered |
| `jobCampaign:references[].assetId` | K14 → PR 18 | server/studio/campaign/carrier.ts:65-69 — carried, no reader ("PR 18 reads it") |
| `shotSpec:environment` | unowned — a planner axis or the Board's own setting slot | server/studio/agent/capabilities.ts:198-258 — no capability axis maps to environment; the slot is phrased (prompts.ts settingLine) but nothing the planner writes can fill it |
| `qaVerdict:clip.reroll` | K23, unowned | server/studio/qa/inspectClip.ts — written and logged; no reader (client QaChip.tsx:24 reads overall and the observations only) |
| `costLine:previewId` | K24, unowned | server/studio/qa/join.ts:224-238 — written, never matched by the join |
| `costLine:batchId` | K24, unowned | server/studio/qa/join.ts:224-238 — written, never matched by the join |
| `costLine:promptVersion` | K24, unowned | server/studio/qa/join.ts:224-238 — written, never matched by the join |

<!-- census:end -->
