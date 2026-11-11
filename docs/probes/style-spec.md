# PR 18 — Style spec: reference → spec → edit and generate · ledger

| | |
|---|---|
| Branch | `studio/style-spec` (worktree `/Users/adi/nomila-v2-worktrees/style-spec`) |
| Tip = base | **`7a083fc6`** (origin/main, "Merge pull request #590 from nomila-co/studio/flow-eval") |
| Phase | **R: read-only, $0.** No jest, no server, no DB, no model call. Nothing committed. `npm ci` ran clean in the worktree. |
| AUDIT2 pin | `c8242e07`. Merged since then: 9.5, 10, 11, 12, 12.5, 13, 14, 15, 15.1, 16 (#590 is PR 16, the flow census). |
| Map read first | `docs/probes/flow-eval.md`: the 432-row census, its verdict table (`agent/eval/census/verdicts.ts`), cards K1–K40, ADI-24SEP R1–R11. |

**The standing process rule from PR 16** is in force here. Any ruling that makes a field dead is written into this ledger when it is made, with its cite. See §DEAD-BY-RULING below.

---

## R-hold rulings — Adi, 24 Sep 2026 (the "GO for Phase B after these rulings" message; cited below as **ADI-GO18**)

| # | Ruling | Effect |
|---|---|---|
| G1 | **Derive on read** (S1-A). A pure, versioned function of the stored reading, frozen onto the brief at quote. No DDL, no second model call, the strict decomposition shape not widened. | The derivation's version rides the brief, so an old quote replays with the derivation it was made under. Added mutation **M20**: "a spec derived under a new version replays an old quote differently". R-3's "stored on studio_reference_analyses" is superseded: the reading is what is stored; the spec is stored per quote on the frozen brief. |
| G2 | **No sixth op.** Style is a **MODIFIER** on the five existing ops. | A standalone "match this look" edit is **out of scope** for PR 18. **Card K-S1 → PR 19** (the ops PR, where a migration is expected; `shared/schema.ts:2241` "a sixth is a migration, on purpose"). |
| G3 | **Narrow carve-out** in `routes/studio.ts`: the role allowlist entry at `:291` and a style arm in `resolveReferences` (`:649-673`). No handler logic. Nothing else in that file. | R-5 lands on **(a)**. `buildPrompt` stays where the parity PR will find it. |
| G4 | Pickers: **Create Anything's tray** (`PICKABLE_ROLES`, AttachSheet) and **the edit sheet**. `ReferencePicker.tsx` stays untouched: its "A look" tag was removed because faces leaked. | |
| G5 | **Census verdict rows are added in the same commit as the leaf**: data, not tests. **R-11 amended:** `agent/eval/census/verdicts.ts` is this PR's to add rows to; the census's tests are not. | |
| G6 | **Correction, named:** the brief's mutation "an edit with no style reference changes with the flag on" is **retired**. It is replaced by: *with the flag on and no style reference, stripping the fences gives back the flag-off bytes exactly* (M6). | |
| G7 | **R-C item 6 is DEAD**: the influence-role removal (`brief.ts:222-237`), because faces leaked from a style slot on gemini-3-pro-image. Adi wrote the item from the audit's delta without checking that its role had already been killed on purpose. | §DEAD-BY-RULING |
| G8 | The picker lists **only already-read references**. **No decompose-on-attach** in this PR. The "still reading this reference" refusal **stays in the engine** as the invariant: the list is a UI convenience, and a hand-built request must not slip past the refusal. | |
| G9 | **Framing on the generate cell only.** The UI check is amended: light and palette are judged on the edits, framing on the generate. | |
| G10 | Identity on accept: gated on **`STUDIO_STYLE_SPEC && STUDIO_IDENTITY_PACK`**, compares **output → source** against **her** band, ≈ **$0.00128** per accept. | The pack comparison (≈ 8× the cost) is **carded, K-S2**: not worth it until the control passes for more than one athlete. |
| — | **Predictions:** all registered as written. The 12-vs-8 video goldens is **a clean miss on the brief's count**: recorded as one, not retrofitted. | §Misses |
| — | **Spend:** the UI check approved at ≈ $0.85, with the generate cell contingent on (a) landing (it has, G3). The optional recommend grounding check (S-2, $0.013) is **approved: run it**. If fencing lowers grounding, that is a finding for this PR. | |
| — | **Carry forward (K1's real exposure):** see §7, first bullet, stated plainly. | |

---

## 0. STOP items: rulings needed before Phase B

These are places where the brief's rules contradict each other or the code. None was worked around. Each one has a recommendation, and each one blocks part of the component map (§4).

| # | What stops | Evidence at the tip | Options (the recommended one first) |
|---|---|---|---|
| **S1** | **R-3: no free jsonb column, so the "store the spec" rule triggers.** `studio_reference_analyses` has exactly one jsonb column, `decomposition`, and it is the strict **stored shape**. | `shared/schema.ts:2139-2171`; `reference/schema.ts:23-29` ("This is the STORED shape"), `:210-216` (`.strict()`). A nested `style_spec` key would fail that schema. Widening the schema would also widen what `readReferenceReply` (`decompose.ts:198-202`) accepts **from the model**, which would let a reply inject its own spec. | **(A) Derive on read.** The spec is a pure, versioned (`style-spec/1`) function of the stored reading, keyed by analysis id. The quote freezes it onto the brief, so the run replays exactly what was quoted. It is then stored per quote in `studio_generation_previews` and `generation_jobs.brief`, but not on the analysis row. No DDL. P-reuse holds, because no edit (first or second) makes a model call for the spec. **(B)** DDL: `style_spec jsonb NULL` on the analyses table. **(C)** `media_assets.metadata.style_spec` on the reference asset: not recommended, because brief-text readings have no asset and whole-object metadata writes are a known hazard (flow-eval §2.9). |
| **S2** | **R-4's edit path needs a sixth typed op, and a sixth op is DDL.** | `migrations/0064_studio_edit_previews.sql:93-94` has `CHECK (op IN ('recolour','garment','product','background_clean','ad'))`. `shared/schema.ts:2241` says "a sixth is a migration, on purpose". `PARAMS_FOR` has `satisfies Record<StudioEditOp,…>` (`edit/ops.ts:233-239`). | **(A)** A migration that widens the CHECK to add `style`, through Adi's DDL path (db-migrate.sh step-3 list, schema.ts and the LEGACY re-add in one commit). **(B)** No DDL: style becomes an optional modifier on the five existing ops. There is then **no standalone "match this look" edit**, and the UI check's edit cell cannot run as written. **(C)** No DDL: the standalone style edit goes through Create Anything (`/studio/preview`). That needs S3's carve-out, and she has to type a LOOK word, because "make it look like this" cannot be read without editing classify.ts (R-11). |
| **S3** | **R-11 conflicts with R-5(a) and R-14.** Every image generate enters through `/studio/preview` in `routes/studio.ts`, which R-11 lists as do-not-touch. | The role allowlist is at `routes/studio.ts:291`. `resolveReferences` is at `:649-673`; it is the only producer of a tagged `JobReference` on a generate. An explicit `shot` on a still is **dropped** at `:1445-1446` ("Motion only: a still has no camera to move"). No client sends `planId` on an image generate (only `storyboardRun.ts:93,177`, which are clips), so the carrier cannot bring a reference to a still either. | **A narrow carve-out** (recommended): add `style_reference` to `:291`, add a style arm in `resolveReferences` (read the analysis under her id; refuse with R-8's copy), and change no handler logic. The image ShotSpec is then **derived from the spec** (§5, R-5), so `:1445` stays untouched. Without the carve-out, generates cannot be reached. That is neither R-5's (b) nor (c) by R-5's own criteria: `buildPrompt` does **not** need to move (§2 C4). |
| **S4** | **R-11's "the pickers" conflicts with Phase B's "style reference in the picker".** | Create Anything's tray is `AttachSheet.tsx` plus `studio-contract.ts` `PICKABLE_ROLES` (`:480`). Its retired `inspiration` role is still in the union (`:56`), and `ENGINE_ROLE` maps it to `null` (`:454-464`). CampaignWorkspace uses `ReferencePicker.tsx` (`ROLES :90-93`). The typed-edit sheet (`EditSheet.tsx`) has no reference picker at all. | Name the file(s). Recommended: Create Anything's tray (studio-contract `PICKABLE_ROLES`, `ENGINE_ROLE`, AttachSheet tile) for the generate, and a style choice on the edit sheet for the typed op. `ReferencePicker.tsx` stays untouched. |
| **S5** | **The census reds on any new leaf, and its verdict table is inside `agent/eval/` (R-11).** | `agent/eval/census/rows.ts:368-402` derives rows from `BriefInput`, `BriefJob`, `ShotSpec`, `PARAMS_FOR`, `CreativeQaVerdict` and `PreviewRequest`. `rows.test.ts:34` "no census row is unverdicted" reds on every new leaf until `verdicts.ts` has a row for it. | **Add verdict rows (data, not tests) to `census/verdicts.ts`** in the same commit as the leaf, each with its cite (recommended). The alternative is to hold with a named red. I don't recommend that: a red gate weakens a check just as surely as deleting it. |
| **S6** | **One M-list mutation contradicts R-12.** "an edit with no style reference changes with the flag on". But R-12 puts the fences behind the same flag, so a branded edit with no style reference **does** change with the flag on. | `compile/assemble.ts:174-177`: the brand's DO NOTs are on every branded native edit. | Restate the invariant: with the flag on and no style reference, **stripping the fence wrappers gives back the flag-off bytes exactly** (`unfence(on) === off`). A mutation that changes any byte outside a fence reds. |
| **S7** | **R-C item 6 (a reference image handle as a style slot) conflicts with R-8** and with the cut feature. | `brief.ts:222-237` and `ReferencePicker.tsx:7-12`: the `influence` / "A look" role was cut because faces leaked from a style slot on gemini-3-pro-image. `preview.ts:143-146` and `routes/studio.ts:283-285` say the same. | **DEAD by R-8.** Recorded below. The handle stays on the spec for provenance (the analysis id and `source_asset_id`) and never becomes a `RefSlot`. |
| **S8** | **R-8's refusal copy, "still reading this reference", describes a state nothing produces.** | `decomposeReference` runs synchronously inside the decompose door's request (`direction/decompose.ts:399`, `BrandPostScreen.tsx:229`). There is no async reader. `listReferenceAnalyses` (`reference/store.ts:162-189`) has no route and deliberately returns no asset id. | **(A)** The picker lists only her analysed `style_reference` rows (a new list route on the typed door, `edit/routes.ts`). A raced or stale id gets R-8's refusal; the copy is kept as Adi wrote it and is true while her decompose call is still in flight. **(B)** Attaching an unread image triggers a decompose: a new spend door, ≈ $0.0018 per reference. |
| **S9** | **The UI check judges "framing" on an EDIT, but the edit law keeps the frame.** | `edit/engine.ts:102` sets `MAX_EDIT_ASPECT_DRIFT` 0.15, and `assertKeptItsShape` (`:390-412`) refuses a reframed output. The GLOBAL_STYLE scope says "Keep everything in the photograph exactly where and what it is" (`assemble.ts:78-79`). | A reference's crop and composition can land **only on a generate**. The edit cells are judged on light and palette; framing is judged on the generate cell. |
| **S10** | **Which flag gates identity-on-accept, and which instrument it uses.** R-6 applies to all typed edits, not only style edits. | Census flags-on sets `STUDIO_IDENTITY_PACK` but not `STUDIO_STYLE_SPEC` (`census.test.ts:253`). | Gate on **`STUDIO_STYLE_SPEC && STUDIO_IDENTITY_PACK`**, so the census's accept flows stay inert. Instrument: **source → output** (`checkIdentity`, `qa/identity.ts:115-205`) with **her** band from `bandFor` (`identity/profile.ts:194-204`, null unless `control_passed === true`). That is 2 face boxes + 2 embeds, ≈ **$0.00128** per accepted edit. It is the shape `qa/inspect.ts:251-259` already uses for derived assets. The alternative, output → pack, costs (1 + pack) × $0.00064, up to ≈ **$0.0102** at PACK_MAX 15 (`identity/types.ts:10`). |

---

## DEAD-BY-RULING (written at the moment of the ruling, per PR 16's standing rule)

| Field / item | Ruling | Cite |
|---|---|---|
| R-C item 6: a reference image handle attached as a style slot | **DELIBERATE-DEAD.** A raw style image is never forwarded to the model. | Brief R-8 (Adi, PR 18 brief, 24 Sep 2026); **ADI-GO18 G7**: the influence-role removal, `brief.ts:222-237`, because faces leaked from a style slot on gemini-3-pro-image |
| A standalone "match this look" typed edit (no other op) | **DELIBERATE-DEAD in PR 18**, carded to PR 19 (K-S1) | **ADI-GO18 G2** |
| The reading's `typography` inside the **style spec** (R-C 3) | **DELIBERATE-DEAD in the spec, PR 18 only**: no image consumer. It returns with PR 19's type re-laid ops (K-S5). | **ADI-GO18-R3** (Adi, 24 Sep 2026, the "Rulings:" message). This is the build-time decision `55f9cb4c` wrote as "ledger §0-bis, awaiting ratification": **no §0-bis section ever existed**, and the decision was the author's until this ruling. |
| Output → pack identity comparison on an accepted edit | **DELIBERATE-DEAD in PR 18**, carded (K-S2) | **ADI-GO18 G10** |
| R-3's "the spec lives on studio_reference_analyses" | superseded: the reading is stored there; the spec is derived on read and frozen per quote | **ADI-GO18 G1** |

Proposed only, **not ruled**. Each waits on Adi and is not dead until he rules:
- R-C 3 (typography lockup): no image consumer in this PR (§3).
- R-C 4 on edits (crop, aspect, focus): the edit law (S9).
- R-C 7 on edits (wardrobe): a look never changes clothing (`preview.ts:612`; `assemble.ts:78-79`).

---

## 1. Phase R deliverable (a): the claims

### The brief's context cites, re-verdicted at `7a083fc6`

| Cite in the brief | Verdict | At the tip |
|---|---|---|
| `reference/schema.ts:127-140` DIMENSIONS (12) | CONFIRMED | `:127-140` |
| `schema.ts:2135-2150` analyses table | PARTIAL (drift) | `shared/schema.ts:2139-2171` |
| `brief.ts:237` ReferenceRole | PARTIAL (off by 1) | `brief.ts:238` |
| compile/ has no style slot | CONFIRMED | `compile/index.ts:23-55` exports none |
| colour and typography are prose, not values | CONFIRMED | `DIMENSION_VOCAB` has no color or typography (`reference/schema.ts:154-160`); prompt meanings are prose (`reference/prompt.ts:51,58-59`) |
| no image shot spec | CONFIRMED | `ShotSpec` is video (`types.ts:206-213`); the route keeps `shot` for motion only (`routes/studio.ts:1445-1446`) |
| only style op is GLOBAL_STYLE over LOOKS, `classify.ts:1371-1374` | CONFIRMED | rule 3 `:1368-1375`; also rule 5¾ `:1583-1591` through `readWhollyLook`; `lookVocab.ts:59` `LOOKS` |
| PR 14 resolves ref_N → source_asset_id at save | CONFIRMED | `campaign/resolveRefs.ts:26-54` |
| census: `references[].assetId` reaches zero readers | CONFIRMED | `census/verdicts.ts:378`; `carrier.ts:65-69` ("PR 18 reads it") |
| typed edits import nothing from qa/ | CONFIRMED | `edit/engine.ts:27-92` |
| K1 `preview.ts:646-656` | CONFIRMED | `:646` `if (brand)` to `:657` |
| K1 `compile/assemble.ts:174-177` | CONFIRMED | `:174-177` |
| K2 `edit/recommend.ts:69-75` | CONFIRMED | `:69` `RECOMMEND_PROMPT`, `:74-75` the lines, `:71` the brand |
| `mila/…/getBrand.ts:17-23` | PARTIAL | `server/mila/tools/getBrand.ts:17-23` is the rationale; the wrappers are `:41-47` (`external`, `externalArr`). Name, domain and logo stay unwrapped by that pattern (`:21-23`). |
| `agent/capabilities.ts:42-101` | CONFIRMED | 48 members: camera 11, movement 11, lighting 11, composition 7, motion 8 |
| `qa/cost.ts:46` | CONFIRMED | `EMBED_CALL` $0.0001 |
| `vertex.ts:156-161` | CONFIRMED | `:156` `orderBySlot` |
| `routes/studio.ts:610-628` resolveReferences | **STALE** | now `:649-673` (`:611` is `readOwnedImage`) |
| `preview.ts:567-788` buildPrompt | PARTIAL | `:567-782` |
| 118 image goldens | CONFIRMED | `compile/compile.golden.json`, pinned by `compile/golden.test.ts` |
| 8 video goldens | PARTIAL | **12** cells in `video/prompts.golden.json`. The **8 original** are the flag-off pin (`video/prompts.test.ts:461,757`); 4 are carrier-on. |
| AUDIT2 C4, F29, recon R-C | CARRIED | not re-read here; PR 16 re-verdicted "reading → edit style spec; style role" CONFIRMED absent (`flow-eval.md:303`) |

### C1–C10

| # | Claim | Verdict | At the tip |
|---|---|---|---|
| C1 | The reading | CONFIRMED, plus S1 | 12 dims (`schema.ts:127-140`), each `{summary ≤300, tags ≤6, basis}` strict (`:178-192`). **Only 5 carry tags:** camera (shots + movements), lighting, composition, environment, motion (`:154-160`). Color, typography, wardrobe, subject_placement, lens_perspective, editing_rhythm and emotional_tone are prose only. `commercial_style` ≤3 (`:214`). REQUIRED: camera, lighting, composition, color, emotional_tone (`:145-151`). Written once by `decomposeReference` (`decompose.ts:339-354`) with `prompt_version` `reference/1` (`prompt.ts:32`). **No free jsonb (S1).** |
| C2 | ReferenceRole and its readers | PARTIAL: **four** role vocabularies exist | Server job role `brief.ts:238` (person\|product\|object). The reading's role `reference/schema.ts:225-229` (style_reference\|composition_reference; the carrier uses this one, `carrier.ts:61`). Client `use-studio.ts:72` (person\|product\|object). Client engine tray `studio-contract.ts:56` (source-frame\|product\|object\|**inspiration**). **Breaks at compile time** (good; it forces a decision): `PLANNED_ROLE` Record (`preview.ts:326-330`), `ENGINE_ROLE` Record (`studio-contract.ts:454`). **Refuses:** the route allowlist (`routes/studio.ts:291`, a 400). **Drops by construction:** `referencesFor` filters `r.role in PLANNED_ROLE` (`preview.ts:385-387`). Leaving `style_reference` out of `PLANNED_ROLE` is the R-8 seam: it can never become a sent reference. **Ignores:** `attachedIn` (`nativeIntent.ts:203-211`), `likenessDecision` (`referenceGate.ts:163`), identity targets (`qa/identitySet.ts:74`), the manifest (`manifest.ts:210-211,268`), `orderBySlot` (it sees slots only). |
| C3 | compile/ at tip | CONFIRMED | templates, looks, constraints, preservation, aspect, order, disclosure, describe, manifest, text (`compile/index.ts:10-21`). **Generate reaches compile/ only for `referenceManifest` and `aspectFor`** (`preview.ts:60-69,617`). Templates and preservation are native-edit only. Style slot attach points: (edit) a fenced style block after the instruction in `buildNativePrompt` (`assemble.ts:169-178`), plus the GLOBAL_STYLE template's spec arm (`templates.ts:291-292`); (generate) one call from `buildPrompt`'s generate arm into a new `compile/style.ts`. |
| C4 | buildPrompt seam | CONFIRMED: **no move needed** | `buildPrompt` already imports from compile/. The seam is one `parts.push(styleBlock(...))` in the generate arm plus the fences at `:646-656`. The TODO (`:559-566`) says moving it means *splitting* the function. That split is the parity PR's (ADI-24SEP R5), and this seam does not require it. Reaching it from a client needs S3. |
| C5 | A GLOBAL_STYLE spec arm without editing classify.ts | CONFIRMED by reading; B pins it against `route()` | A typed style op writes `canonicalSentence([{kind:"look", term:"colour grade"}])`, which is "make it colour grade" (`interpret/canonical.ts:97-98`). `GLOBAL` matches "colour grade" (`classify.ts:612-613`); "it" is not a determiner (`:617-622`), so it has no region target, so rule 3 gives GLOBAL_STYLE / "colour grade" (`:1368-1375`). The spec arm is in **compile**, keyed on the frozen brief carrying a style reference. The closed-LOOKS arm (`looks.ts:66-69`) is untouched. Needs S2 for a typed op to exist. |
| C6 | The typed op's sentence | CONFIRMED | `planOp` → `canonicalSentence` (`ops.ts:391-558`) → `route()` gate (`engine.ts:279-298`) → freeze → `buildNativePrompt`, with `campaignBlock` appended at run (`engine.ts:562-566`). The spec must **not** enter the sentence: the sentence is the classifier's input and must stay in the canonical grammar. It rides on the frozen brief and is rendered by compile as a fenced data block, on the same pattern as the CAMPAIGN block (`ops.ts:368-386`). One renderer serves both paths, since a generate has no edit row to append from. |
| C7 | PR 17's pack and control | CONFIRMED | `identity_profiles` (`shared/schema.ts:2900-2917`). `position()` (`qa/identity.ts:101-104`). `control_passed` is written only by `writeControl` (`profile.ts:174-183`). `bandFor` is null unless `controlPassed === true` (`profile.ts:194-204`). The chooser is client-only (census C8, `identityPack.ts:123-192`) and never reaches an edit: a person ref on an edit is refused (`preview.ts:417`). Per call: face box ≈ $0.00054 (`identity-pack.md:133`), embed $0.0001 (`cost.ts:46`). |
| C8 | The fences | CONFIRMED | Three sites (above). Pattern: `<external_content>` + verbatim + no escaping (`getBrand.ts:42-47`). With R-12, **0 existing goldens move with the flag off.** With it on, **4 of the 6** brand-bearing cells change and 2 (DO NOT from our own `exclude_marks` only) do not (§3, P-fence). Recommend has **no byte pin today** (`recommend.test.ts:248-254` checks substrings only), so B adds one before touching it. |
| C9 | R-C's ten items | see §3 | 4 pure mappings, 1 compile-constant, 4 need extraction (2 partly map), 1 dead by R-8 |
| C10 | Census rows moved and broken | see §3 P-census | **0** existing rows flip DEAD → CONSUMED under this design. The census's two `references[].assetId` rows are the **carrier's** (plan brief → Board clips); this PR's style reference arrives on `JobReference` (Create Anything, typed op). New leaves red `rows.test` until `verdicts.ts` rows land (S5). |

---

## 2. What the design is, in one paragraph

A **style reference** is one of her `studio_reference_analyses` rows with role `style_reference`, read under her id. It becomes a fourth `JobReference` role, carrying the analysis id and a **StyleSpec** derived deterministically from the stored reading (`style-spec/1`; S1-A). The quote freezes it onto the brief. `referencesFor` never plans it (R-8), so no pixel of it reaches the model. compile/ renders it as a fenced `<style_reference>` data block with an explicit "never write any words from this block into the image". On an edit, the GLOBAL_STYLE clause's spec arm points at that block. On a generate, `buildPrompt` pushes the same block and the **image ShotSpec** phrases derived from the reading's tags. Flag off, none of it exists and every byte is today's.

---

## 3. Phase R deliverable (b): predictions, pre-registered 24 Sep 2026 before any code

**R-C's ten items (C9), verdicted:**

| # | Item | Verdict | Why |
|---|---|---|---|
| 1 | a target in the edit grammar | **MAPPING** | Whole frame: GLOBAL_STYLE via the canonical look sentence (C5) |
| 2 | colour as values | **NEW EXTRACTION** | `color` has no tags and is prose (`schema.ts:154-160`). A deterministic pixel read (sharp: dominant colours, warm/cool) would be $0, with no model call and no re-decompose. It needs a ruling, and it reads the reference's bytes server-side only. |
| 3 | typography lockup | **NEW EXTRACTION; proposed dead for images** | Prose only, and no image consumer in this PR: a look edit adds no type, the generate asks for no words, and the headline template is PR T's measured wording (`templates.ts:281-282`), which belongs to PR 19 |
| 4 | composition and subject placement as geometry | **PARTIAL** | The 7 composition tags map (generate only). Crop, aspect and focus point are new extraction. The aspect is the deliverable's (`aspect.ts:8-15`). On edits all of it is dead by the edit law (S9). |
| 5 | preservation clause | **MAPPING from compile's own constants**, not from the reading | GLOBAL_STYLE scope (`assemble.ts:78-79`), `preservationClause` (`preservation.ts:49-58`), `PRESERVE_PERSON_CLAUSE` (`constraints.ts`) |
| 6 | image handle as a style slot | **DEAD by R-8** | S7 |
| 7 | wardrobe in garment vocabulary | **NEW EXTRACTION (deterministic token match); proposed dead on edits** | Prose only. A look never changes clothing. On a generate the summary can ride fenced as-is. |
| 8 | video-only dims stripped | **MAPPING** | Drop `motion`, `editing_rhythm`, and the `CAMERA_MOVEMENTS` members of `camera.tags` |
| 9 | versioning on the wire | **MAPPING** | `schema: "style-spec/1"`, plus the row's `prompt_version` and `model` |
| 10 | untruncated summaries | **MAPPING** | Stored at full ≤300 (`schema.ts:162`); copied verbatim |

| # | Prediction | Falsified if |
|---|---|---|
| **P-off** | Flag off: all **118** image goldens, all **12** video goldens (8 original + 4 carrier), the recommend prompt (a new pin captured at `7a083fc6`), and every compiled edit, generate and recommend prompt are byte-identical | any byte differs |
| **P-reuse** | A style edit makes **zero** reference-model calls: the first edit and the second (S1-A derives the spec; nothing re-decomposes). A style op is region-free, so **zero detection calls** too. The only paid call is the one `image.edit`. | the transport mock records ≥ 1 decompose call, or detection runs, on either edit |
| **P-roles** | Adding the fourth role changes **0** of the 118 goldens and no existing-role prompt. The only difference a style reference makes is its own fenced block (and, on an edit, the GLOBAL_STYLE clause's spec arm). | any byte outside those differs |
| **P-spec** | **4** of R-C's ten are a pure mapping from the reading (1, 8, 9, 10) | B needs extraction for any of the four, or maps any other purely from the reading |
| **P-route** | "make it colour grade" routes as one GLOBAL_STYLE step, value "colour grade", no ASK, with classify.ts untouched | `route()` returns ASK, another op, or another value |
| **P-identity** | An accepted edit gets an identity observation where `control_passed === true`, and **none** where it is false or null. The accept succeeds, with identical rows and response, when the embed throws, the pack is missing, or the control failed. | any of the three |
| **P-fence** | Flag on: 4 golden cells change (`op ADD_OBJECT — her placed Product photo…`, `interpreter — exclude_marks beside the brand's DO NOTs`, `native — a brand's DO NOTs…`, `generate — a post with a brand…`), and only inside fences. Our own `show a Nike logo…` stays outside every fence. 2 cells do not change. | a different set, or a byte outside a fence |
| **P-census** | **0** existing rows DEAD → CONSUMED. New rows: **2** (`briefInput:references[].style`, `briefJob:references[].style`, where `StyleSpec` is imported and so opaque by the counting rule), plus `opParams:style.*` (**1**: the analysis id) if S2-A. `rows.test` reds on each by name until `verdicts.ts` has it (S5). The census's measured runs do not move (it never sets `STUDIO_STYLE_SPEC`). | a different count, or a measured census row moves |
| **P-seam** | **(a)**, conditional on S3's carve-out. `buildPrompt` does not move. | reaching the generate needs a file move, or any route logic beyond the allowlist and the style arm in `resolveReferences` |
| **P-capabilities** | Of the 48: **13 meaningless on any still** (movement 11: a still has no camera move and `static` is vacuous; motion `slow_motion` and `speed_ramp` are temporal). On a **generate**, 35 apply, but only the **29** the reading's vocab carries (camera 11, lighting 11, composition 7) reach a prompt through a style reference. The motion tags are stripped by R-C 8. On an **edit**, only lighting 11 apply: camera, composition and depicted motion would re-shoot or re-pose (`preview.ts:612`; `assemble.ts:78-79`; S9). | a member outside those sets renders, or one inside has no phrase |

---

## 4. Phase R deliverable (d): the component map

Files marked **[S#]** are touched only if that STOP item is ruled the recommended way.

**Lane 1: spec and role (server)**
- `server/studio/reference/styleSpec.ts` (new): the `StyleSpec` type (`style-spec/1`), `styleSpecFrom(decomposition, row)` (pure), and `readStyleReference(athleteId, analysisId)` (tenancy; a refusal with R-8's copy). **[S1-A]**
- `server/studio/brief.ts`: `ReferenceRole` gains `style_reference`; `JobReference` gains `style?: { analysisId, spec }`.
- `server/studio/preview.ts`: `PLANNED_ROLE` over `Exclude<ReferenceRole,"style_reference">` (the R-8 seam); one `styleBlock` push in `buildPrompt`'s generate arm; the fences at `:646-656`.
- `server/studio/config.ts`: `styleSpecEnabled()` (`STUDIO_STYLE_SPEC`), documented beside the other gates.

**Lane 2: compile**
- `server/studio/compile/style.ts` (new): the fenced style block, the image ShotSpec (members from `CAPABILITY_LISTS`), and its phrase table (a `Record` over each applicable member).
- `compile/templates.ts` (GLOBAL_STYLE spec arm), `compile/assemble.ts` (the style block, and the fence at `:174-177`), `compile/index.ts` (exports).

**Lane 3: edit**
- `shared/schema.ts` `STUDIO_EDIT_OPS`, plus a migration **[S2-A, DDL, Adi's approval]**.
- `server/studio/edit/ops.ts` (the style op), `edit/engine.ts` (the style `JobReference`; identity on accept), `edit/routes.ts` (the style op body; the analysed-references list **[S8-A]**), `edit/recommend.ts` (fence).
- `server/studio/edit/identityOnAccept.ts` (new): `checkIdentity` plus `bandFor`, fire-and-forget after accept, never throws.

**Lane 4: generate door [S3]**
- `server/routes/studio.ts`: `:291` allowlist and a style arm in `resolveReferences` **only**.

**Lane 5: client [S4]**
- `client/lib/flags.ts` (`EXPO_PUBLIC_STUDIO_STYLE_SPEC`), `client/hooks/use-studio.ts` (`StudioReferenceRole`), `client/lib/studio-contract.ts` (`ENGINE_ROLE`, `PICKABLE_ROLES` behind the flag), `client/screens/studio/AttachSheet.tsx` (the tile), `client/hooks/use-studio-edits.ts` + `EditSheet.tsx` (the style op, the refusal).

**Census [S5]:** `server/studio/agent/eval/census/verdicts.ts` rows only; no test edits. Re-verdicts go in `flow-eval.md`'s re-verdict section at merge.

**Tests** (all new unless named): `reference/styleSpec.test.ts`, `compile/style.test.ts`, `compile/styleFlag.test.ts` (P-off, S6's `unfence` invariant), `compile/fences.test.ts`, `edit/engine.style.test.ts`, `edit/identityOnAccept.test.ts`, `edit/ops.test.ts` (the style sentence against `route()`), `edit/recommend.test.ts` (the fence and the byte pin), `server/routes/studio.style.test.ts` (the end-to-end generate, crossing the boundary).

**Not touched (R-11):** classify.ts, interpret/, agent/plan.ts, the plan and preview route **handlers**, boardStitch/stitchLogic, library.ts, visionTag.ts, `ReferencePicker.tsx`, qa/identity.ts's band and control logic (read, and called as-is), `agent/eval/**` tests. **Not added:** any `EXPO_PUBLIC_*` line in `.env.development` (R-9).

---

## 5. Phase R deliverable (c): the mutation list

Runner: before and after each mutation it asserts `git diff HEAD --quiet` and an empty `git status --porcelain`. The file is backed up once; restored from the backup; never `git checkout --`.

| # | Mutation | Test file |
|---|---|---|
| M1 | a style spec is not stored. **[S1-A restatement:** the spec is not derived from the stored reading; a spec from the request body is accepted] | `reference/styleSpec.test.ts` |
| M2 | a second edit off the same reference re-decomposes | `edit/engine.style.test.ts` (PGlite; transport call count) |
| M3 | a raw style image is forwarded to the model (`style_reference` added to `PLANNED_ROLE`) | `edit/engine.style.test.ts` + `routes/studio.style.test.ts` (adapter inputs) |
| M4 | a style reference is usable before decomposition | `routes/studio.style.test.ts`, `edit/engine.style.test.ts` |
| M5 | spec content reaches the output as literal text (a summary rendered outside the fence) | `compile/style.test.ts` |
| M6 | an edit with no style reference changes with the flag on (**S6's form:** a byte changes outside a fence) | `compile/styleFlag.test.ts` |
| M7 | an image golden moved with the flag off | `compile/styleFlag.test.ts` (replays all 118 with the flag unset and `"false"`) |
| M8 | a fence changes a prompt with the flag off | `compile/styleFlag.test.ts`, `edit/recommend.test.ts` |
| M9 | the fourth role changes an existing role's compiled prompt | `compile/style.test.ts` |
| M10 | brand research text reaches the image prompt unfenced | `compile/fences.test.ts` |
| M11 | a brief line reaches recommend unfenced | `edit/recommend.test.ts` |
| M12 | a fenced field is concatenated into an instruction (a brand DO NOT joined unfenced with our `exclude_marks`) | `compile/fences.test.ts` |
| M13 | an accepted edit is never inspected | `edit/identityOnAccept.test.ts` (PGlite) |
| M14 | a failed identity check blocks an accept (the embed throws) | `edit/identityOnAccept.test.ts` |
| M15 | an identity score is shown for an athlete whose control failed (`bandFor` bypassed) | `edit/identityOnAccept.test.ts` |
| M16 | the image ShotSpec renders a member with no phrase (runtime completeness over the applicable members) | `compile/style.test.ts` |
| M17 | the image ShotSpec never reaches a generate through the real client path. **Crosses the boundary:** client `toEngineReferences` → `POST /studio/preview` → adapter prompt. | `routes/studio.style.test.ts` |
| M18 | the style spec never reaches an edit through the real client path. **Crosses the boundary:** client `use-studio-edits` body → `/studio/edits/quote` → run → adapter prompt. | `edit/engine.style.test.ts` |
| M19 | the GLOBAL_STYLE closed-LOOKS arm changes when a spec is present elsewhere | `compile/style.test.ts` |

R-14's "at least two cross the boundary": M17 and M18.

---

## 6. Phase R deliverable (e): spend cells

Every cell needs Adi's explicit go per run. Artifacts go to `probe-out/style-spec/`.

| Cell | What | Formula | Ceiling |
|---|---|---|---|
| S-0 | Every test, golden replay and compile dump | in-process, mocked | **$0** |
| S-1a | Decompose one reference (UI check) | 1 × measured $0.0017–0.0019 (`reference-decomposition.md:50`) | **$0.002** |
| S-1b | Style edits #1 and #2 on her photo | 2 × the engine's own quote. Measured quotes: $0.1654 at 2K, $0.271 at 4K (`image-edit.md:225-227,354-355`). 0 detection calls (region-free). | **$0.542** (4K) |
| S-1c | Identity on accept, if she accepts both and `control_passed` | 2 × (2 face boxes × ≈$0.00054 + 2 embeds × $0.0001) | **$0.0026** |
| S-1d | One generate against the same spec (only if (a) lands) | 1 × quote. Measured $0.1963 at 2K with refs, $0.3019 at 4K (`image-edit.md:354-355`). | **$0.302** |
| **S-1 total** | The UI check, all four | | **≈ $0.85** |
| S-2 (optional) | Recommend's grounding rate unfenced vs fenced, 5 photos × 2 | 10 × (≈1,650 in × $0.3/M + ≈300 out × $2.5/M) ≈ 10 × $0.0013. **Estimated** from the decomposition's measured image tokens, not measured on recommend. | **$0.013** |

S-2 exists because fencing changes what the model sees beside a rule that says "copy the line exactly" (`recommend.ts:87`; `groundRecs` drops anything not verbatim). A fenced line could be copied **with** its tags and then dropped as ungrounded. It is unmeasured until S-2 runs or the UI check exercises it.

---

## 7. Things to know (not STOP items)

- **K1's real-world exposure is narrower than PR 16's finding implied (ADI-GO18, carried forward).** There is no palette writer anywhere (flow-eval §2.10), and `dos`/`donts` are always `[]` because `researchBrand` writes `brand_safety` as a string while `brief.ts:598-615` reads it as an object (K27). So on real data **the only brand line the fence touches in production is `BRAND:`** (name, category, content style, values). `PALETTE:`, `DO:` and `DO NOT:` fencing changes only fixture-data goldens today. It becomes live when Mia fixes K27. The next reader should not treat the fence as a large behavioural change.
- **Verbatim fences can be closed early.** Content containing `</external_content>` ends the fence, because the getBrand pattern does not escape (`getBrand.ts:42-43`) and ADI-24SEP R1 rules the content unsanitised. Stated, not fixed.
- **Following getBrand exactly leaves the brand *name* unfenced in the image prompt** (`getBrand.ts:21-23`: identity fields are app-owned). But R-7 names recommend's brand name explicitly, and that one arrives from the **client body**, so it is fenced. The census notes that `getOrResearchBrand` overwrites the shared name with what an athlete typed (`brandIntel.ts:143-147`). If Adi wants the image prompt's name fenced too, that is a one-word ruling.
- **Recommend's memo key omits prompt version** (`recommend.ts:209`, K10). A flag flip can serve recs computed under the other prompt for the memo's life. Out of lane (PR 19's K10); stated.
- **R-10 (brand channel imagery):** the spec is a pure function of any `ReferenceDecomposition`, so a spec from a brand's imagery needs **no change to the spec**. What would change: `decomposeReference` reads only her own `media_assets` (`decompose.ts:277-291`), so brand imagery would first have to be stored as her `origin:'reference'` asset (the URL door already exists, `direction/decompose.ts:133-218`) and filed under her brand profile (`brand_profile_id`, unwired: K26). Choosing *which* of a brand's ranked images (or merging several readings) is new logic. The reading stays external content, fenced.
- **Two "style_reference"s.** `reference/schema.ts:226` already has the member, meaning the same thing. B imports that literal rather than retyping it.
- **K2's owner.** flow-eval §9 wrote K2 as PR 19; ADI-24SEP R1 and this brief's R-7 move it here. They agree now.
- **The tree is not porcelain-clean at the tip, before anything is touched:** `server/scripts/calibration/runs/blind-eval/blind-eval-2026-09-14.zip` shows ` M` right after checkout (the known gitattributes quirk; never staged). The mutation runner's "byte-identical to the tip" check will compare against that same state (the zip's porcelain line recorded at start, and everything else empty). It will not silently drop the check.

## Phase B — built (24 Sep 2026)

Base `7a083fc6` (origin/main did not move; no rebase). Commits: `a955a95f` (ledger + ADI-GO18), `55f9cb4c` (the build), `1356695d` (the suites), then this ledger. **Unpushed.** Flag pair **`STUDIO_STYLE_SPEC` / `EXPO_PUBLIC_STUDIO_STYLE_SPEC`**, both default off (`server/studio/config.ts` `styleSpecEnabled`, `client/lib/flags.ts`). Per R-9, no `EXPO_PUBLIC_*` line was added to `.env.development`.

### Per lane

| Lane | What | Files |
|---|---|---|
| Spec (G1) | `styleSpecFrom`, PURE and versioned `style-spec/1`: the still's 9 dimensions, whole summaries, camera shots without movements, lighting, composition, the commercial style, provenance. Reads under her id in a separate module so compile stays pure. Refusal copy. | `reference/styleSpec.ts`, `reference/styleStore.ts` |
| Role (R-1, R-8) | `style_reference` is the 4th `ReferenceRole`; `JobReference.style` carries the frozen spec. `PLANNED_ROLE` excludes it, so its image is never planned or sent. `styleBlockers`: flag off, two style refs, no spec (still reading), an unrenderable version, an edit that changes no look. Each is a blocking gap she reads. | `brief.ts`, `preview.ts` |
| Compile (R-4, R-5, R-14) | The fenced `<style_reference>` block. Edit mode: light, colour, mood, and `LIGHT:`. Generate mode: all 9 still dimensions, and `CAMERA:` / `LIGHT:` / `COMPOSITION:` from `CAPABILITY_LISTS`, every member phrased (`Record`s). GLOBAL_STYLE's spec-driven arm (`addressing.styleLook`), with the closed-LOOKS arm untouched. | `compile/style.ts`, `compile/templates.ts`, `compile/assemble.ts` |
| Fences (R-7, R-12) | `<external_content>`, verbatim, per field, flag-gated: legacy BRAND (category, content style, values; the name stays bare as in get_brand), PALETTE, DO, DO NOT. The native DO NOT's brand fields are fenced, and our `exclude_marks` stays outside. Recommend's brand and each line are fenced; `groundRecs` takes markers off a copied line (flag on only). | `compile/fence.ts`, `preview.ts`, `compile/assemble.ts`, `edit/recommend.ts` |
| Edit (G2) | `planOp(op, params, {style})` appends ONE canonical look clause ("make it colour grade") to any of the five ops. `quoteEdit` takes `styleAssetId` (flag on only; otherwise the strict body refuses the key) and resolves it under her id, refusing an unread one with R-8's copy. Row params record `{assetId, analysisId, version}`; the cost line's `promptVersion` is `typed-op/1+style-spec/1`. `GET /studio/style-references`: her already-read list, gated on the style flag alone, lazily loaded. | `edit/ops.ts`, `edit/engine.ts`, `edit/routes.ts` |
| Identity (R-6, R-13, G10) | After the library write, never awaited: `bandFor` (null unless her control passed, and then no observation), `checkIdentity` output→source on her band, one cost line (`image.inspect`), and `metadata.edit_identity` merged in one statement. Any failure means no observation and the accept unchanged. | `edit/identityOnAccept.ts`, `edit/engine.ts` |
| Generate door (G3) | The carve-out: `referenceRoles()` adds `style_reference` with the flag on; a style arm in `resolveReferences`. | `routes/studio.ts` |
| Client (G4) | The Style tile (`pickableRoles(flag)`; `PICKABLE_ROLES` unchanged), `ENGINE_ROLE.style → style_reference`, the already-read list in Create Anything's picking modal, "Match a look · optional" on the edit sheet, `quoteBodyFor`. | `studio-contract.ts`, `AttachSheet.tsx`, `CreateAnythingScreen.tsx`, `EditSheet.tsx`, `StyleReferenceList.tsx` (new), `editPopoverLogic.ts`, `use-studio-edits.ts`, `use-studio.ts`, `flags.ts` |
| Census (G5) | 2 verdict rows, CONSUMED, static (the census flows never set the flag): `briefInput:references[].style`, `briefJob:references[].style`. | `agent/eval/census/verdicts.ts` |

### The predictions, measured

| # | Registered | Measured | Verdict |
|---|---|---|---|
| P-off | flag off: 118 + 12 goldens, recommend, every prompt byte-identical | 118 image goldens with the flag unset AND `"false"` (golden.test); 12 video goldens unset, `"true"` and `"false"` (prompts.test); recommend byte-equal to a pin captured from `7a083fc6`'s own source, unset and `"false"` | **HELD** |
| P-reuse | zero reference-model calls on both edits; **zero detection calls** | reference engine and transport: **0 calls** over two quote+run cycles (engine.style.test) | **Model half HELD. Detection half MISSED, premise overturned:** it assumed a standalone region-free style op. Under G2 the look rides on an op, and a region-bound op (recolour, garment, product remove, background) runs detection exactly as it does without the look (one call per new sentence, memoized). Region-free ops (product add or place, ad) make none. |
| P-roles | the 4th role changes no existing prompt | 0 of 118 goldens move from the role; a generate with ME + BOOT + style equals today's prompt plus the block, with the same planned refs and aspect (style.test) | **HELD** |
| P-spec | 4 of 10 items a pure mapping (1, 8, 9, 10) | built as exactly those four; 5 from compile's constants; 2, 3, 4-numbers and 7 not built | **HELD** |
| P-route | "make it colour grade" routes as one GLOBAL_STYLE, no ASK | all five ops (9 param shapes) with the modifier: the op's own steps plus exactly one GLOBAL_STYLE "colour grade", no ASK, no GENERATE (ops.test); classify.ts untouched | **HELD** |
| P-identity | observed where control passed; none otherwise; never blocks | observed on her band (A); B's control failed → `skipped`, 0 calls; a throwing check → accept ok, nothing written; a check that never answers → the accept still returns | **HELD** |
| P-fence | exactly 4 golden cells change flag on, only inside fences | exactly those 4; `unfence(on) === golden` for all 118 | **HELD** |
| P-census | 0 flips; 2 new rows (+1 if S2-A) | 0 flips; exactly the 2 named rows (S2-A not taken, G2) | **HELD** |
| P-seam | (a), `buildPrompt` not moved | (a): `buildPrompt` edited in place, no file moved | **HELD**, with the carve-out's exact touch points below |
| P-capabilities | 13 meaningless on a still; 29 reach a generate; lighting 11 on an edit | as built and pinned (style.test: every one of the 29 phrased, no extra) | **HELD** |

### Mutations — 23, every one red by name, then restored (tree byte-identical to `1356695d` before and after each)

| # | Mutation | Red, by name |
|---|---|---|
| M1 | the resolve returns a spec with the reading's dimensions emptied | styleSpec.test "a style spec is not derived from the stored reading — it must be" |
| M2 | styleStore calls `decomposeReference` | engine.style.test "a second edit off the same reference re-decomposes — it must not" |
| M3 | `style_reference` added to PLANNED_ROLE and planned into the object slot | style.test, engine.style.test, studio.style.test "a raw style image is forwarded to the model" (3 suites) |
| M4 | styleStore never refuses an unread image | engine.style.test "a style reference is usable before decomposition"; styleSpec.test "…still being read" |
| M4b | preview's no-spec blocker removed | style.test "a style reference with no spec is refused as still reading" |
| M5 | the reading rendered outside the fence | style.test "spec content reaches the output as literal text" |
| M6 (G6) | a fence adds a byte outside its markers | golden.test "flag on, no style reference: unfencing … gives back its golden exactly" (the 4 fenced cells) |
| M7 | fence regardless of the flag | golden.test "every fixture compiles byte-identical" + flag `"false"` (8 reds) |
| M8 | recommend fences with the flag off | recommend.test "a fence changes a prompt with the flag off" (unset and `"false"`) |
| M9 | the style block placed first | style.test "the fourth role changes an existing role's compiled prompt" |
| M10 | the brand category unfenced | fences.test "brand research text reaches the image prompt unfenced" |
| M11 | a recommend line unfenced | recommend.test "a brief line reaches recommend unfenced" |
| M12 | our `exclude_marks` fenced together with the brand's DO NOTs | fences.test "a fenced field is concatenated into an instruction" |
| M13 | the accept never starts the observation | engine.style.test "an accepted edit is never inspected" |
| M14 | the accept awaits the observation and throws on no observation | engine.style.test "a failed identity check blocks an accept" + "the accept does not wait" |
| M15 | the band read without `bandFor` (control ignored) | engine.style.test "an identity score is shown for an athlete whose control failed" |
| M16 | one member's phrase emptied | style.test "the image ShotSpec renders a member with no phrase" |
| M17 | **client**: `ENGINE_ROLE.style → null` | studio.style.test "the image ShotSpec never reaches a generate through the real client path" (+5) |
| M17b | **server**: the generate renders the edit-mode block | same name |
| M18 | **client**: `quoteBodyFor` drops `styleAssetId` | engine.style.test "the style spec never reaches an edit through the real client path" (+4) |
| M18b | **server**: the route drops `styleAssetId` | same name |
| M19 | GLOBAL_STYLE always takes the spec arm | style.test "the closed-LOOKS arm changes when a spec is present elsewhere" |
| M20 | the run re-derives the spec from the row | engine.style.test "a spec derived under a new version replays an old quote differently" |

R-14's "at least two cross the boundary": **four do** (M17, M18 client-side; M17b, M18b server-side). Each test drives the client's own builder (`toEngineReferences`, `paramsFor` + `quoteBodyFor`) through the real route.

### The gate — the full suite, once, at the hold (main did not move, so no rebase and no second run)

`npm test` bare at `1356695d`, every per-batch summary read (its exit code is not a verdict):

| Batch | Suites | Tests | Failed |
|---|---|---|---|
| client #1 / #2 | 40 / 35 | 534 / 1117 | 0 / 0 |
| scripts · server root · server/lib · server/mila | 2 · 2 · 38 · 27 | 21 · 70 · 533 · 381 | 0 |
| server/routes #1 / #2 | 40 / 3 | 714 / 32 | 0 |
| server/scripts | 4 | 23 | 0 |
| server/services #1 | 40 | 634 | **1: `affiliationSync` "a year-only from/to (registry v2 allows YYYY)…"** (the house flake) |
| server/services #2 / #3 · server/skills | 40 / 22 · 21 | 350 / 315 · 153 | 0 |
| server/studio #1–#5 | 40, 40, 40, 40, 23 | 674, 1264, 1239, 783, 485 | 0 |
| server/voice · server/workflow | 29 · 5 | 703 · 45 | 0 |
| **Total** | **531** | **10,070** | **1** |

**The one red is the house flake:** re-run alone, `affiliationSync.test.ts` is 8 / 8 green, and this PR touches nothing under `server/services`. `npx tsc --noEmit` is clean on both `tsconfig.json` and `tsconfig.jest.json`. Lint: no error in any touched file except the tip's own `EditSheet.tsx:330`.

### Spend lines
- Phase R: **$0**.
- Phase B build and every test: **$0**.
- **S-2, the recommend grounding check (ADI-GO18 GO): 8 flash calls, ≈ $0.00454** (quoted $0.0104 ceiling; approved $0.013). Run file `probe-out/style-spec/recommend-grounding-2026-09-24T22-37-03-453Z.json`.
- The UI check (≈ $0.85) is Adi's.

### S-2 result: fencing did not lower grounding (n = 1 per cell)

| Cell (the spike's) | Unfenced | Fenced | Input tokens |
|---|---|---|---|
| plant 7fe0b609 | 1 rec, `because` = "No Nike marks on kit or ball." verbatim (product remove "logo") | 1 rec, the same line verbatim (product remove "logos") | 1633 → 1687 |
| clean e64e900a | 0 | 0 | 1630 → 1684 |
| clean 9677d97e | 0 | 0 | 1607 → 1661 |
| observation 37df2f85 | 0 | 0 | 1594 → 1639 |

The fence costs ≈ 45–54 input tokens a call. Not one rec was dropped as ungrounded in either state. Whether the model copied the markers into `because` is not visible (a kept rec is stored unfenced), and it did not matter: `groundRecs` accepts either form with the flag on. **The spike's own hit changed op between runs** (recolour "Nike logos" black on 23 Sep; product remove here, both states). That is model variance at n = 1, not a fence effect.

### Things to know — deviations, stated plainly

1. **routes/studio.ts touch points (G3):** the allowlist became TWO edits, the definition (`referenceRoles()` beside `REFERENCE_ROLES`, `:291`) and its single read site in `parsePreviewBody` (`oneOf(referenceRoles(), …)`), plus the style arm in `resolveReferences` and two import lines. No handler logic changed.
2. **The route's unread copy is not R-8's wording.** The handler maps refusals through `referenceGate.ts`'s copy table, which is outside the map, so the route's style arm reuses the door's existing `reference_unread` reason: *"We're still reading this photo. Give it a moment and try again."* The typed-edit door uses R-8's copy exactly. **Adi's call:** accept this, or approve a 2-line data addition to `referenceGate.ts` (`style_unread` + copy).
3. **Out-of-map files, pulled in by exhaustive `Record`s over the widened roles, one label each:** `MakeItScreen.tsx` (`BUILT_FROM_ROLE.style_reference = "STYLE"`), `use-studio-pending.ts` (`UNNAMED.style_reference`), `SetupScreen.tsx` (`PICKER_TITLE.style`). Tests edited outside the new files: `composerBoundary.test.ts` (filters `style_reference` before `shotTypeFor`; typing only, no assertion changed), `client/lib/studio-contract.test.ts` (its hand-written member list gains `style`, as that test demands), `video/prompts.test.ts` and `compile/golden.test.ts` (P-off blocks added; no existing assertion touched).
4. **Not built, needing a ruling:** R-C 2 (colour values), R-C 4's numbers (crop, aspect, focus point), R-C 7 (garment vocabulary): each needs a new extraction nothing ruled in. **R-C 3 typography is not carried in the spec** (no image consumer, and a type description invites text). It was proposed dead in R; **ratification is still open.**
5. **A style reference on a Create Anything EDIT** must come with a look in the frozen intent; otherwise it is a blocking gap. When her own look word ("make it moodier") and a style reference are both present, the reference's look replaces her word (the spec arm).
6. **A generate with only a style reference** shows the existing degraded gap "None of these references is tagged as you…". That is accurate (a style reference carries no likeness), and it is newly reachable.
7. **The identity observation has no reader or UI.** It sits on `metadata.edit_identity`, while the QA display route reads `creative_qa`. Observation only, as ruled.
8. **Mutation-runner incident, caught and recovered.** The first run of the 23 was started in the background, and I stopped it on a timeout concern. The kill stranded M4's one-line edit in `styleStore.ts`. It was found by `git status`, reversed by applying the exact inverse edit (not checkout), and the tree verified byte-identical to HEAD. The runner now writes each backup to disk before mutating. **All 23 were re-run from scratch in foreground batches; no result from the killed run is used.**
9. **Prettier slip, caught before commit.** I formatted `client/lib/studio-contract.test.ts`, which was already unformatted on the tip. It was rebuilt from HEAD plus my 3-line edit, so no whole-file diff landed. The 8 production files unformatted on the tip were left unformatted.
10. `EditSheet.tsx:330` carries a `react/no-unescaped-entities` lint **error that is on the tip already** ("photo's"). Not mine; left.
11. **The UI check must pair the look with an op (G2).** There is no standalone "match this look" edit (K-S1 → PR 19). The least disturbing pairing is `background_clean` with its default setting, or a recolour of a small item.

### Cards

| # | Card | Owner |
|---|---|---|
| K-S1 | A standalone typed "match this look" edit: a sixth op, which is a migration (ADI-GO18 G2) | PR 19 |
| K-S2 | Identity on accept against her pack (output → pack), not only the source | when the control passes for more than one athlete (ADI-GO18 G10) |
| K-S3 | The route's style refusal copy (item 2 above) | Adi's call |
| K-S4 | R-C 2 / 4 / 7 extractions | unruled |
| K-S6 | **Read every image by default** (Adi, 24 Sep 2026). Full text in §K-S6 below. | its own PR, after PR 18 merges |
| K-S7 | The kill-safe mutation runner (the trap plus disk PENDING, `--selftest term\|kill`). Was K-S6 until Adi named the read-everything card K-S6. | its own chore PR, after PR 18 merges (Adi, 24 Sep 2026) |

### After the hold — Adi's rulings (24 Sep 2026, the "Rulings:" message; cited **ADI-GO18-R3** and **ADI-GO18-K3**)

- **R3 ratified:** typography is not carried in the style spec in PR 18, and returns with PR 19's type re-laid ops (§DEAD-BY-RULING; K-S5).
  - **Does it bear on G1?** Not the decision itself: dropping a dimension the stored reading already holds adds no call and no extraction. But G1 bounds the options: a typography *lockup as values* would need a second call or a wider decompose schema, and G1 forbids both.
  - **Is the reading's typography read anywhere else? Yes.** The planner renders every reading dimension (`agent/plan.ts:413-414`), and the census measured it: `readingDimension:typography`, `campaignBrief:references[].intent.typography.summary` and `.basis` all reach `concepts_prompt` and `planner_prompt` (`census/verdicts.ts:343-358, 1029-1034`). `.tags` was already DELIBERATE-DEAD under §8's vocabulary ruling. **So no census row goes DEAD under R3, nothing flips, and P-census holds.** R3 makes typography dead only inside `StyleSpec`, which the census holds as one opaque leaf.
- **K-S3 left as is (ADI-GO18-K3), carded.** The preview route says "We're still reading this photo…". **Reachability, checked:** that 422 needs a request naming an image of hers with no style reading. The picker cannot produce one, because `listReadStyleReferences` lists only images joined to a reading that passes the strict stored schema, and every stored row passed that same schema at write. Nothing in Studio deletes an analysis, a brand profile or a media asset (a grep for deletes finds only account removal, `routes/account.ts:89`, which ends the session). So it is reachable **only by a hand-built request**, or in future if `REFERENCE_SCHEMA` changes while old rows stay listed.
- **The comment amendment**, `1780d661`: comment lines only (`git diff -U0` shows no non-comment line). It cites R3 at `reference/styleSpec.ts`, and G3/G8 at `routes/studio.ts`'s style arm. No re-gate.

| # | Card | Owner |
|---|---|---|
| K-S5 | Typography returns with the type re-laid ops: carry the reading's typography summary (and, if a lockup spec is wanted, the extraction G1 bars from this PR) where a headline is laid (ADI-GO18-R3) | **PR 19** |
| K-S3 (kept) | The preview route's "still reading" copy is the door's own `reference_unread`, not R-8's words; reachable only by a hand-built request | Adi's ruling: leave; carded |

### Before the walk (24 Sep 2026)

**Quotes per UI-check cell, from the engine's own pricing** (`probe-out/style-spec/quotes.ts`, $0, `previewGeneration` → `router.estimate`, gemini-3-pro-image):

| Cell | Resolution | References billed | Quote |
|---|---|---|---|
| decompose one reference (Brand post → A reference) | — | the image, as its one input | ≈ $0.0018 (measured, `reference-decomposition.md:50`) |
| edit 1 (an op + Match a look) | **4K** at both a 12 MP and a 24 MP frame | **1: the source frame IS billed** as a reference (≈ 258 tok). The style reference is never sent, so never billed. | **$0.271** |
| edit 2 (same reference) | 4K | 1 | **$0.271**, and **no** reference-model call |
| identity on accept (each accepted edit, only if her `control_passed`) | — | 2 face boxes + 2 embeds | **≈ $0.00128**; $0 and no observation otherwise |
| generate (Create Anything, Style tile) | 2K (post, 4:5) | 0 with the client pack flag off; **3 pack refs** when `EXPO_PUBLIC_STUDIO_IDENTITY_PACK` is on, her pack is complete (≥ 10), and her words name her ("me", "my") | **$0.1344**, or **$0.2273** with the 3 pack refs |

Worst case, everything on and both edits accepted: 0.0018 + 0.542 + 0.0026 + 0.2273 ≈ **$0.774**, inside the approved ≈ $0.85.

**Item 5: was M4's stranded line in the tree while the gate ran? No.**

| When | What (evidence) |
|---|---|
| 15:33:08 | `1356695d` committed (git log) |
| 15:33:15–15:33:25 | the background runner born → killed (`tasks/b7xwa9zih.output` born / modified) |
| (between) | M4's line reversed by hand |
| 15:33:54 | batch 1's first "tree identical to HEAD" check passes (`mut-backup-M1.json` born) |
| 15:34:06 / 15:35:53 | batches 1 / 3 end, each mutation checked before and after |
| 15:37:03 | S-2 run file |
| **15:37:26 → 15:53:19** | **the gate** (`gate.log` born → modified) |

**How "byte-identical to HEAD" was checked.** In the runner: `git diff HEAD --quiet` (content, not stat) with the zip excluded by pathspec, plus `git status --porcelain` showing only the zip line. **So the zip was not covered there.** Checked explicitly after the fact:
- `git hash-object` of every tracked file against `git ls-tree -r HEAD`: **2208 of 2209 identical**.
- The one exception is the zip, and only through git's clean filter (CRLF). Its raw bytes hash the same as the main repo's copy of the same blob: sha256 `9a0a2898…cf33` on both, blob `c21c8022…` at HEAD, at `7a083fc6` and at main.
- The zip's mtime is 14:35:34, which is the worktree's checkout time. Nothing touched it.

**The runner now survives a kill** (PR 16 and PR 18 each lost one):
- `mut-PENDING.json` is written before any file changes and removed only after the restore.
- A SIGINT, SIGTERM or SIGHUP restores the file synchronously, then exits.
- SIGKILL cannot be trapped, so the next start restores from PENDING before doing anything else. jest now runs as an async child, so the handler can fire.

Proven on a real mutation (M16) with `--selftest`, where the runner signals itself, because house rules bar killing a process by pid:
- **SIGTERM** → "restored compile/style.ts (SIGTERM)"; the tree is clean.
- **SIGKILL** → exit 137, the tree dirty and PENDING on disk; the next start restores "a previous run died mid-mutation", and the tree is clean.

The runner lives in the session scratchpad, not the repo. **Adi's ruling (24 Sep 2026): not in PR 18. It goes in its own chore PR after 18 merges** (card K-S7).

### Every model call on the walk, and the table the engine prices from

**Path A: "Read it" → the edit sheet → an accepted edit**

| Step | Calls | Model | Quote |
|---|---|---|---|
| Brand post → pick a brand | 0 | — | $0 (the brands come from her deals, from the DB) |
| **Brand research** | **0 on this path**, whichever brand | — | $0. No Studio path calls `getOrResearchBrand` (its callers are `/brands/resolve`, Mila's tools and deal contracts), and the brief carries the brand's name only. Whether a brand is researched changes neither spend nor any prompt here. |
| A reference → Read it | 1 | Flash (`gemini-3.5-flash`) | $0.0017–0.0019 (measured, `reference-decomposition.md:50`) |
| Confirm the brief | 0 | — | $0 |
| Plan it (**concepts**) | 1, required: "Plan this one" needs a picked concept | `GEMINI.pro` (`gemini-3.1-pro-preview`, the planner's transport), $2 in / $12 out per M | ≤ $0.075 ceiling; the planner's measured mean is $0.0751 (`ingest-flip.md` C5), and concepts prompts are shorter |
| Plan this one → the Agent screen | **0**: a confirmed brief hands off to compose, and the **planner** runs only if she taps plan there | (if tapped: `GEMINI.pro`) | $0 (≈ $0.075 if tapped; not needed to reach the edit sheet) |
| Select a photo | **recommend**: 1 Flash call per photo selected, **only when the brief carries lines** (constraints, a product line, a story); memoized 10 minutes per (photo, brief) | Flash | ≈ $0.0005–0.0007 (S-2 measured: 1594–1687 in / 10–94 out) |
| See the price | **detection**: 1 Flash call for a region-bound op (recolour, garment, product remove, background_clean); 0 for product add or place; memoized per (photo, sentence) | Flash | ≈ $0.0005 (estimated by analogy to the measured face box, `identity-pack.md:133`; not measured) |
| Make it | 1 | gemini-3-pro-image | **$0.271** at 4K (frame > 4.19 MP, the rule `config.ts:449-454`), or **$0.1654** at 2K (frame ≤ 4.19 MP) |
| Keep it | identity: 2 face boxes + 2 embeds, only if `control_passed` | Flash + multimodalembedding | ≈ $0.00128 |

**Path B: the generate.** Create Anything → ＋ → Style → her words → Make it.
- `/studio/classify`: rules only, $0.
- The preview: 0 calls. The interpreter never runs on a generate, and `STUDIO_INTERPRETER` is not set.
- Make it: 1 image.generate, **$0.1344** (2K, no references sent), or **$0.2273** with 3 pack refs.
- QA: 0 (`STUDIO_CREATIVE_QA` not set).

**Off both paths, but real:** production's media-enrich cron (every 15 minutes, `/api/internal/media-enrich-cron`) runs over the **shared** database. It will tag (Flash) and embed every new generated asset the walk creates: each accepted edit and the generate's output. That's roughly $0.001 an asset, estimated and not measured, billed through production, not the local server. The reference image is excluded (`origin 'reference'`, `mediaEnrichment.ts:210,279`).

**Which table the engine prices from: one table.**
- The rate: `server/studio/config.ts:635-639`, gemini-3-pro-image at **$0.00012 per output token**.
- Output tokens: **1,120** at 1K/2K, **2,000** at 4K (`:503-507`).
- References: **258 tokens each**, priced at the same output rate (`:528`).
- The arithmetic: `pricing.ts:88-96`.

The lineup's figures are this same table:
- $0.1654 = a **2K** edit (1,120 + one 258-token reference).
- $0.271 = a **4K** edit (2,000 + one reference).
- **$0.271 already includes the frame's $0.031.** It is not "$0.271 + $0.031 per reference". Each reference *beyond* the frame adds $0.031.
- The generate's $0.1344 is 2K with no reference, and $0.2273 is 2K with three.

The table's own label says references are quoted "at the OUTPUT rate on a per-image base count, which over-prices each token and under-counts a large photo". The image-edit lane recorded reported costs of $0.1344 / $0.24 against quotes of $0.1654 / $0.271 (`image-edit.md:354-355`), exactly the reference part.

**After the walk (pending):** reconcile **quoted** (the edit row's `cost_quoted_usd` / the preview's quote), **reported** (the job's `cost_usd`, with its basis) and, where one exists, the **invoice line**, cell by cell in this ledger. Never summed across kinds.

### K-S6 — read every image by default (Adi, 24 Sep 2026; its own PR, after PR 18 merges)

As Adi wrote it:
- **Uploads:** a `reference/1` reading fired async after the tagger; it never blocks the upload.
- **Edits and generates:** read on accept, not on preview.
- **A separate call, the same reader;** not merged into the tagger.
- **Picker:** made-here readings keep the "Made here" label; dedupe by source image (see the duplicate-row card).
- **Flag-gated, default off;** a cost line per read with `athleteId`; the backfill quoted per athlete before it runs.

**Phase R must answer first:**
1. Does `agent/plan.ts:413-414` select readings by the brief's reference or by athlete? If by athlete, this floods the planner and breaks fingerprint `0ebb8528a218`; say what scoping is needed.
2. Do any of `STILL_DIMENSIONS`' nine members describe the subject? If yes, a look read from her own photo carries a text description of her into prompts; say what is stripped.
3. Library size per athlete for the test athlete, and the backfill quote.
4. Every other reader of `studio_reference_analyses`, and whether any changes behaviour when every asset has a row.

Not answered here: they are that PR's Phase R, and PR 18 does not build any of it.

## Misses
- **The brief's count of video goldens: 8 registered, 12 at the tip.** A clean miss on the brief's count (ADI-GO18). The 8 are the original, flag-off set; the 4 carrier-on cells were added by PR 14. P-off is measured against all 12.
- **P-reuse's detection clause** (above): registered "zero detection calls"; under G2 a region-bound op detects as it always has. The premise (a standalone op) was overturned by the ruling. Stated as a miss, not re-registered.
