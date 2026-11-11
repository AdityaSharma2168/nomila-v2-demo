# PR 9 — AI image edit from the storyboard (edit-only), pre-gen fix button, ad carousel, Board photo mode, UI pruning — ledger

Branch `studio/image-edit` off origin/main 9d82252 (PR 6 merged). Runs beside PR 7 (`studio/mila-direction`,
live): PR 7 owns BrandPostScreen / SetupScreen / the brand-flow screens / `server/studio/direction/**`; the
shared UI surfaces (StoryboardTab, the pre-gen check, StudioHomeScreen, SetupScreen's chips) are this PR's
Lane 3 and build only after PR 7 merges. Test athlete `3811cedd`. Probes under gitignored
`probe-out/image-edit/`. Order: 0 → 1 → 2 → [PR 7 merges] → rebase → 3a → 3b → 3c → 4.

**Standing law, extended to edits (Adi):** EDIT-ONLY, NO GENERATE-FROM-SCRATCH — every op, the ad op
included, is a constrained image-to-image transformation of an existing photo; the pipeline must be unable
to synthesize without a source. Ground rule 06: quoted before it runs, previewed after, accepted or
discarded by her tap; nothing enters her library until accept / keep. Casting law on uploads-as-bases: a
reference with a person in it passes the existing her-verification before any op reads it; person-free
references proceed.

**Migration numbers are a shared resource** (Adi, 23 Sep 2026): PR 7 took 0062 (`media_assets.origin`
gains `'reference'`, applied to dev). This PR's previews table was 0063 — applied to dev under that number —
until the objectives PR (#573) merged to main as 0063 the same day; **it is now 0064_studio_edit_previews**
(same table, same file, a no-op where it already ran; the list line moved after 0063_objectives). A
rebase onto the moved main (39 commits, incl. #573/#547/#574/#575) is pending — Adi's lane.

## Decisions, with who made them (Adi, 23 Sep 2026, on the opening report)

1. 0a's query approved as written; the entry-sharpening fix approved as S; its $0.38 re-measure needs a
   server window (PR 7 owns :8080) — requested when ready.
2. 0b's log fix approved as S: one line at the routed decision, pre-split passes to debug, mutation
   "person_target logged on a routed sentence" red by name.
3. Edit previews get their own table (0063), not the no-DDL media_assets fallback — "a mutation you can't
   name cleanly is a law you can't enforce". schema.ts + the migration in ONE commit; Adi applies it.
4. Build order confirmed; envelope $6 with the per-op asks intact.
5. Fall-through: Lane 1's door is typed-op-only, so the four from-scratch paths on the MakeIt sentence door
   are unreachable from it and the mutation reds there; the MakeIt door stays; "fence or keep
   image.generate" is a product card, not fenced silently.
6. Asset versioning: `media_assets.derived_from_asset_id` is the vehicle, `origin = 'generated'`. **An edited
   camera photo is no longer verifiable camera, so it is made-here to the cast gates and needs her pick on
   own-footage briefs.** That is the law's intent, stated in those words.
7. Source gate fail-closed: the tagger's `subject` — `nobody` and `the_athlete` proceed, `another_person`
   refuses `source_not_her`, untagged refuses `source_unverified`; Lane 4 waits for the tag before quoting.
8. The "format shapes the plan, render picks the output" amendment was a ruling for this PR, not landed
   code: plan rows store no format today. 3c adds a nullable `format` to the stored plan body (jsonb, no
   DDL) and makes its prediction true.
9. 3b: full removal of "Personal posts" and "Edit a photo", orphans and all; NowFeed's suggestion tap
   rewired to the brand flow — on the Mia list as a product-surface change.
10. Drafts listed everywhere (below) is a real pre-existing finding, carded for PR 10 with evidence.

## Commit 0 — measurement + recon ($0)

### 0a — motion usage from stored plans (read-only, athlete-scoped; run 23 Sep 2026)

The query, as approved (run through the project's db client, `probe-out/image-edit/motion-usage.ts`):

```sql
SELECT coalesce(i->>'motion', 'still')                              AS motion,
       count(*)                                                     AS items,
       count(*) FILTER (WHERE jsonb_typeof(i->'focus') = 'object')  AS with_focus,
       count(DISTINCT p.id)                                         AS plans
FROM studio_plans p
CROSS JOIN LATERAL jsonb_array_elements(p.plan->'items') i
WHERE p.athlete_id = '3811cedd-ec59-44b0-b613-b39d03f9d5ca' AND i->>'kind' = 'image'
GROUP BY 1 ORDER BY 2 DESC;
```

Population: 19 plans (1 parent → child), all the test athlete's, 02:40–05:59Z on 23 Sep 2026 (the 6b / 6c /
6d cells and walks — nothing was stored before 6a3). 98 items: clip 55, broll 15, image 13, i2v 10, product 5.

| motion | items | with focus | plans | reason entry                                |
| ------ | ----: | ---------: | ----: | ------------------------------------------- |
| dolly  |     7 |          0 |     7 | image.motion.dolly 6, image.held 1          |
| zoom   |     4 |          2 |     4 | image.motion.zoom 3, image.held 1           |
| still  |     1 |          0 |     1 | image.held                                  |
| sweep  |     1 |          0 |     1 | image.motion.sweep                          |
| punch  |     0 |          — |     — | —                                           |

**The registered prediction MISSED.** I registered "dolly ≥ 80% of moved items, sweep and punch 0". Dolly is
7 of 12 moved items (58%), zoom 4 (33%), sweep 1; only punch is 0. The hypothesis — the planner defaults to
dolly and never picks zoom / sweep — is wrong on zoom and sweep; it holds on punch (0 of 13, in a population
where music was set in 1 of 5 ad cells, so a "peak on a beat" almost never existed to plan). Focus: 2 of the
5 focused moves carry a point; the other 3 fall to the (0.5, 0.28) prior.

**Diagnosis from the entry text ($0), still true of the wording:** dolly's `whenItWorks` was "Any held photo
that should read as alive rather than as a slide" — a catch-all every held photo satisfies — while zoom's
measured summary led with the 0-of-8 saliency miss, which reads as a caution. The planner was told when the
three focused moves fit and never when dolly does not. **Fix (S, approved, built here):** dolly's line now
names itself the fallback and hands off to zoom / sweep / punch in its own words; zoom's summary states the
prior and asks for a point, and the 0-of-8 moves to its `fails`. No behaviour changes; the field-scope test
("every dolly is on an image.motion line") still passes because the entry line IS an image.motion line.

**Re-measure ($0.38, 5 planner calls): the baseline already meets the 40% non-dolly bar I registered, so I
recommend NOT spending it.** The one open question the data leaves is punch, and the sample has no
on-the-beat cell to plan it in. If Adi wants it anyway, the re-registered prediction is: non-dolly ≥ 50% of
moved items (from 42%), and punch appears only beside `music.onBeat`.

### 0b — the two log lines (built)

`person_target` and `fast_path_declined` were `logger.info` lines written the moment a pass refused. `route`
reads a sentence more than once (whole, then with her keep set aside, then with a kept thing set aside), so
"make my jersey blue, dont change my face" logged `person_target` — and then ROUTED, as RECOLOR beside her
keep (keepVocab.test pins the route; classifyPurpose.test pinned the log). A sentence that asked after two
passes logged the same refusal twice. Across a request the same sentence is also re-routed by
detectionTextFor, the freeze and the recheck — each a `route` call of its own; that is OUTSIDE this fix
(each now writes one line) and is noted, not carded: the purpose tag (`routeAs`) is the existing seam if it
ever matters.

**Built (classify.ts):** a pass hands its one diagnostic back through a sink instead of writing it; `route`
writes exactly the line of the pass whose answer she gets, at info, and a superseded pass at debug with
`superseded: true`. `validate` called alone (tests, callers outside `route`) writes at once as before.
`object_photo_missing` goes through the same sink. Draft calls still write nothing at either level; shape
calls tag both.

Prediction, before the run: classify.test 297 + classifyPurpose.test unchanged in answers (the "never
changes the answer" test is the tripwire); keepVocab, nativeIntent.log and routes/studio.classify green
untouched. **Held:** classify 299/299 (both suites), keepVocab 19, nativeIntent.log 2, routes/studio.classify
31, entries 9, entryPrompt 11, plan 89 — 0 red.

**Mutation "person_target logged on a routed sentence"** (emit writes the line the moment it refuses,
whatever the sink): classifyPurpose.test **4 red by name** — the routed-beside-her-keep case, the look
beside her keep, the asks-after-both-passes ONCE case, and the draft/shape levels case. Restored from a
backup; md5 equal before and after.

### 0c — pre-gen check, Board rows, the asset flow (recon; components in the opening report)

- Pre-gen check = AgentScreen's THE PLAN section (`AgentScreen.tsx:699-1017`; held photo :789-834). Board
  photo rows = `BoardRow` (`StoryboardTab.tsx:1576`; icons :1816-1840). No asset-swap setter exists on either;
  Lane 3a adds one in storyboardLogic — `rowSignature` already includes `assetId`, so a swap re-quotes.
- `derived_from_asset_id` is "the frame an EDIT preserved" (`jobs.ts:29-33`), written only by
  `recordGeneratedAsset` from the job's source (`generate.ts:1387`), read by QA's chain walker. The vehicle.
- **Drafts are listed everywhere (PR 10 card, evidence):** a generated result becomes a `media_assets` row at
  once, `approval_status = 'draft'` (`generate.ts:1370-1388` → `jobs.ts:226-262`), and NOTHING that lists her
  library filters on approval: `studio/mediaList.ts`, `agent/library.ts`, `agent/cast.ts` read no
  `approval_status` (grep, 23 Sep 2026); the only reader is `approval.ts` itself and `concept.ts`. So today's
  generate IS a library write before any tap. Lane 1's previews table fixes it for edits; the finding is
  about everything else.

### 0d — upload, brief, viewer (recon; in the opening report)

Upload: `use-media-library.ts` → `POST /media/upload-url` (rights ack 428 once) → PUT → `POST /media`
`registerUploadedAsset` (`routes/media.ts:288`), origin `upload`, straightened in place at upload
(`orient.ts:175`; the orientation=8 rows predate it), no thumbnail, SafeSearch, then the async vision tagger
(`lib/visionTag.ts:33-45`, `subject` + `athlete_present`). Brief: `campaign/brief.ts:88-181`, sent as
`campaign` on the plan route, rendered fenced by `campaignBlock` (`plan.ts:351`). Viewer: the
`MediaGallery.tsx:125-143` pager. captionRender: a PNG band (`renderCaptionBand`), composited by sharp at its
`y`; 4:5 needs a 1080×1350 target. Lane 4 is L.

## Lane 1 — the edit engine (built, $0)

**Shape.** `server/studio/edit/` behind `STUDIO_IMAGE_EDIT_OPS` (off: every route 404s; needs
`STUDIO_NATIVE_EDIT`, and `STUDIO_DISPLAY_TEXT` for the ad op). One mount line in routes/studio.ts, one flag
reader appended to config.ts; nothing else outside the directory.

- `ops.ts` — the five ops as closed zod params, each WRITTEN into the classifier's own grammar through
  `canonicalSentence` (interpret/canonical.ts), so `route` reads our words, never hers: recolour → "make the
  jersey red" (RECOLOR); garment → "change my jersey to an adidas jersey" (rule 4c, REPLACE_OBJECT) or "add a
  stripe to the jersey" (APPLY_DESIGN); product → "add this ball on the ground next to me" with her product
  photo as the `product` reference (ADD_OBJECT, region-free, C3); background_clean → "change the background
  to the same place with nobody else and no signs" (CHANGE_BACKGROUND, subject preserved); ad → a headline
  across the top (DISPLAY_TEXT) + an optional setting + `exclude_marks` for a known brand + the fenced
  CAMPAIGN block (plan.ts's fence) appended to the prompt at run time as data. Every sentence is pinned
  against `route` in ops.test.ts: routes, the intended op, no ASK, no GENERATE step.
- `source.ts` — the casting law on the source AND on the product reference: the tagger's `subject`
  (media_assets.metadata.vision) through `herPhoto`; nobody / the_athlete proceed, another_person →
  `source_not_her`, untagged → `source_unverified`. Fail-closed as ruled.
- `previews.ts` — the 0063 table, athlete-scoped, a compare-and-set `advance` for the status machine.
- `engine.ts` — quote (gate → measure → detect → assembleBrief in mode "edit" → withNativeEditIntent →
  previewGeneration → savePreview + our row) · run (loadPreview under her id → approvalRefusal →
  re-route the sentence → re-price → assertSpendWithinCaps → CAS quoted→running → createGenerationJob →
  consumePreview once → claimJob → ONE `generate("image.edit")` → shape guard → bytes under
  `athletes/<id>/studio/edit-previews/<row>`) · accept (CAS ready→accepted → copy bytes to the studio job
  path → `recordGeneratedAsset`, origin generated, derived_from = source → delete the preview object) ·
  discard (CAS → delete the object).
- `routes.ts` — POST /studio/edits/quote · /:id/run · /:id/accept · /:id/discard · GET /studio/edits[/:id].

**Decisions made in the build (for Adi's eyes):**

1. **A known brand's name is never a headline.** The rules refuse it as display text (`headlineBound`:
   "a brand's name as display text is a mark"), so the ad op for adidas / nike NEEDS a headline from the
   campaign or her words, or the quote refuses (422, "needs a headline"). An unknown brand ("Jane Street")
   may stand as the headline. The brand reaches the ad through `exclude_marks`, its own do-nots and the
   CAMPAIGN block. My opening report's "headline defaults to the brand name" was wrong by the rules' own law.
2. **An ungrounded headline is REFUSED, not rewritten.** The claim lexicon (every content word in the brand's
   name, the campaign's lines or her instruction; plurals equal) refuses and names the word. Substituting a
   different headline would be inventing her ad.
3. **A background setting is 40 characters** — the rules keep exactly that many of a CHANGE_BACKGROUND value
   (measured: "…and no cl"), so the param is capped there and the default is exactly 40.
4. **The sentence and the CAMPAIGN block ride on the row's params**; the run re-routes the sentence (the
   recheck) and appends the block after the compiled instruction, labelled as data.
5. **The product reference passes the same gate as the source.** A product photo of someone else is refused
   as `productAssetId`.

**Tests (all `npm test -- --filter …`, one at a time):** previews.migration 11 · ops 18 · engine 18 (PGlite;
router, store, detection and the reference resolver stood in; a 640×960 PNG source) · routes 5. tsc clean on
both tsconfigs. **Mutations, each red by name, restored byte-identical:** "quote skipped" (no cap check, quote
never consumed) → 1 red; "preview written to library without accept" (recordGeneratedAsset at run) → 1 red;
"edited asset claims camera provenance" (accepted row set to origin upload) → 1 red; "edit falls through to
from-scratch generate" (a generate call on a refused measure) → 2 red; "unverified person used as op source"
(sourceDecision always null) → 3 red; "another athlete's edit preview is invisible" (athlete filter dropped)
→ 1 red. Plus the 0063 DDL mutation (source FK to SET NULL) → 2 red.

**Costs quoted per op class (the same estimate the quote shows, Nano Banana Pro on Vertex, frame as the one
reference):** ≤ 2K $0.165, 4K $0.271 per call; product op + $0.031 for the product reference; ad op one call
plus, at run time, no extra reference. Unquoted: the flash detection call on the three region-bound ops
(recolour, garment, background_clean); none on product or ad (region-free). No SAM, no interpreter, no QA on
this door.

**Not built here (cards):** a sweep for expired rows' objects under edit-previews/ (24 h ttl on the row;
the object stays until discard / accept — PR 10 housekeeping); `batchId` is written and listed but no route
quotes a batch (Lane 4's).

**Lane 2 needs no server window:** quoteEdit / runEdit run in-process against the dev DB and real GCS +
Vertex, per op, per ask (≈ $0.50–0.80 an op at n=3). The first run also tells whether the vertex adapter's
estimate is priced for gemini-3-pro-image in this environment (the PGlite test asserts `unpriced === false`
on the real estimate path, so it should be).

## Lane 2 — per-op evals (spend, per Adi's go)

### recolour, n=3 (23 Sep 2026; quoted $0.60, reported $0.51)

Sources: her two camera photos 7fe0b609 (1106×1518, studio Stanford black kit) and 37df2f85 (1056×1408,
Gotham FC teal jersey, sponsor wall), and the made-here still 64c28710 (1696×2528, black Stanford kit on the
field). Op `recolour {target: "jersey", colour: "red"}` → "make the jersey red". Runner:
`probe-out/image-edit/lane2-run.ts` (quote-only, then RUN=1 with a cap; ACCEPT=n accepts one and discards the
rest). Sheet: `probe-out/image-edit/recolour/contact-sheet.png` (source | result | diff).

| cell | source    | quoted | reported |  ms | output    | aspect drift | inside box ΔE | inside \|Δ\| | outside \|Δ\| | head \|Δ\| |
| ---- | --------- | -----: | -------: | --: | --------- | -----------: | ------------: | ------------: | -------------: | -----------: |
| 0    | 7fe0b609  | 0.1654 |   0.1344 |  27 s | 1792×2400 |        2.48% |          27.3 |          39.0 |           6.07 |        11.68 |
| 1    | 37df2f85  | 0.1654 |   0.1344 |  28 s | 1792×2400 |        0.44% |          47.1 |          61.4 |           7.94 |         7.49 |
| 2    | 64c28710  | 0.271  |   0.24   |  44 s | 3392×5056 |        0.00% |          35.0 |          27.8 |           5.65 |         6.48 |

(|Δ| = mean per-channel absolute difference on 0–255, after resampling the output to the source's size; the
"box" is the detection region the freeze fixed, e.g. "red jersey 586×496@241,260"; "head" is the band of the
box's width directly above it, 22% of the frame tall — a proxy, not a face mask.)

**Against the pre-registered criteria:**

- **Output dimensions equal the source — MISSED, 0 of 3.** A native edit is the model's own canvas: 1792×2400
  for a 2K call, 3392×5056 for a 4K one, whatever the source's pixels. generate.ts already says so ("a native
  output is the model's own canvas — 3392x5056 from a 4000x6000 frame at 4K") and holds only the aspect,
  within 15%. My criterion was the masked path's, not the native path's. Aspect drift here: 2.48%, 0.44%,
  0.00% — all inside the pipeline's own bound. **Adi's call:** keep the native canvas (what MakeIt ships
  today; the row records the real size) or resample to the source's size at accept (one sharp call, loses
  the 4K cell's extra resolution). I recommend keeping the canvas and re-registering the criterion as
  "aspect within 15%" — which all three pass.
- **Inside the region ΔE > 15 — HELD, 3 of 3** (27.3, 47.1, 35.0).
- **Outside the region |Δ| < 3/255 — MISSED, 0 of 3** (6.07, 7.94, 5.65). The same cause: a native edit
  re-renders the whole frame at a new canvas, so every pixel is resampled and lightly re-drawn; only the
  masked composite is byte-exact outside the mask. The outside change is 2–3% of range and, on the sheet,
  invisible: backgrounds, sponsor wall, crests, socks, cleats, the ball and the captain's armband all read as
  the source. A re-registered bound that these three would pass is |Δ| < 10/255 outside — stated as fitted
  to this run, not as a prior.
- **One call each — HELD 3/3.** Quoted ≥ reported on every cell (the estimate is conservative by ~19%).
- **Library unchanged by the run — HELD** (489 → 489). **Accept adds exactly one — HELD** (→ 490).

**Eyes (mine, before Adi's):** all three jerseys are red; every mark on them is kept (STANFORD and the 8 on
cells 0 and 2, the NJ crest and CarMax sponsor on cell 1, the armband on cell 2); nothing else in any frame
reads as changed. Cell 2's red is darker than the other two's — the source's stadium light, plausibly.

**The accepted row (Adi's storage note — verified against the real library):** media_assets
`e2ea1e6f`, origin `generated`, platform `studio`, IMAGE, status `stored`, approval `draft`, 1792×2400,
4.96 MB PNG, `derived_from_asset_id` = 7fe0b609, `generation_job_id` set, `gcs_thumb_path` written, under
`athletes/<her id>/studio/<job>/0.png`. It passes the picker's listing predicate (hers · stored · not deleted ·
top-level · IMAGE), so it is a real library entry in every list that shows generated photos. The two other
results were discarded (objects deleted, rows `discarded`); five stray `quoted` rows from an interrupted
first pass were discarded too (nothing ran under them).

**Noise found:** the edit quote's `warnings` carry two generic brief gaps ("No brand on this job…", "No
first-class aesthetic…") that mean nothing on a recolour. Fix (S, engine): filter `brief.gaps` out of the
edit quote's warnings, keep only the native notes and the op's own. Built with the next op's run.

**Spend to here:** commit 0 $0 · Lane 1 $0 · recolour $0.51 reported ($0.60 quoted). Envelope $6.

### Lane 2 batch — pre-registration for garment · product · background_clean · ad (BEFORE the first run)

Adi's batch authorization (23 Sep 2026): the four remaining ops run sequentially without per-op approval,
**total cap $3.00 quoted**, accept NONE, one retry on a transient error, a second failure stops that op only.
Standing rulings, confirmed: the model's canvas stays; aspect ≤ 15% (generate.ts's documented bound, a real
prior); **outside-region 10/255 and the head proxy 12/255 are RATCHETS** — fitted once on recolour, frozen as
binding priors for every remaining op and run; loosening again needs a named mechanism finding. The warning
filter shipped first as its own commit (427dcda; two tests, mutation red by name).

**Common to every op** (same three sources as recolour: 7fe0b609, 37df2f85, 64c28710): aspect drift ≤ 15%;
outside-region mean |Δ| < 10/255; head proxy < 12/255; one image.edit call per cell; quoted ≥ reported; library
count unchanged by every run (accept none); a correct refusal counts as HELD and is reported by cell and path.

**GARMENT** — `{garment: "jersey", brand: "adidas"}` → "change my jersey to an adidas jersey" (rule 4c;
REPLACE_OBJECT [jersey] = "adidas jersey"). **The op's own spec, compiled at $0** (compile/assemble.ts):
"replace the jersey with adidas jersey. Keep everything else exactly as-is — change only the jersey. Keep the
original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are." So the spec
replaces THE JERSEY AS AN ITEM and protects everything OFF it; it says NOTHING about marks ON the jersey.
Pre-registered mark behaviour, from that spec:

- adidas lands where the kit brand lives (chest/sleeve mark on the jersey): predicted **3/3**.
- The Nike swoosh ON THE JERSEY leaves with the kit: predicted 3/3. The swoosh on the SHORTS, the socks, the
  cleats and the ball is off the jersey → kept, 3/3 (cells 0, 2 shorts + ball; cell 1 shorts).
- STANFORD wordmark + number 8 (cells 0, 2) and the NJ crest (cell 1): **the NIL interim rule says school /
  team marks are never deliberately removed — the engine does NOT encode it.** The spec is silent on marks on
  the replaced item, so no prediction of "kept" can rest on it. Prediction as a measurement: wordmark and
  number kept in ≥ 1 of 2 cells, the crest altered or dropped. If any school / team mark is dropped, that is
  the mechanism finding: the garment op needs a keep line for the item's identity marks (a constraint the
  compile can write — brand_swap's `descriptors` slot is the nearest seam), carded for Adi's go.
- The CarMax sponsor (cell 1): **the spec says nothing** — it is on the replaced item and nothing keeps it.
  Declared prediction: **dropped** (a generic "adidas jersey" carries no sponsor). Whether it should survive
  is a product call (a sponsor is a third brand's mark); this run only shows what the spec does.
- Off-jersey everything (background, wall, hair, face, shorts, ball): unchanged within the ratchets, 3/3.

**PRODUCT** — `{productAssetId: e64e900a, thing: "soccer ball"}` → "add this soccer ball on the ground next
to me" (ADD_OBJECT, region-free, the product photo as the `product` reference; C3: the freeze reads the
Product photo where an Object photo would stand). **Binding verify (Adi's one-liner):** buildNativePrompt
(compile/assemble.ts) writes a placed Product photo on the OBJECT manifest line — `placedPhoto(brief,
intent)` role "product" → `referenceManifest(..., placed.ref)` — so the typed op binds via the Object line by
C3's own mechanism, not the PRODUCT line; the compiled prompt's manifest is read back off the quote row
before any spend and quoted in the results. **The product photo:** the library's only product shot is
e64e900a (700×700, "a classic black and white soccer ball with the BOLYN sporting goods logo", person-free,
brands_visible BOLYN). It is a PRE-TERNARY row (`athlete_present: false`, no `subject`), which the source
gate refuses as `source_unverified` — the rule working as ruled, and a finding: **older person-free rows
(products, scenery) are refused until the tagger's ternary is on them.** Re-tag of that ONE row through the
app's own tagger (a single flash call, not the cron) to `subject: nobody`, then the op proceeds. Criteria:
the ball placed on the ground beside her per the op's semantics (not in her hands; Q8's refusals), 3/3; the
BOLYN label legible and the REAL label (not redrawn) — eyes; person and jersey marks unchanged; the rest of
the frame within the ratchets; the manifest line names the Object image.

**BACKGROUND_CLEAN** — one setting per cell, declared, each ≤ 40 characters and route-checked at $0 (the
rules keep the whole value): cell 0 "plain studio backdrop with nothing else" (39) · cell 1 "plain red wall
with no text or logos" (36) · cell 2 "empty stadium with no signs or people" (37) → CHANGE_BACKGROUND
[person], subject preserved (SUBJECT_INVERSE). Criteria: subject edge integrity with HAIR as the named check
(no cut-out edge, flyaways kept), no halo; the lighting on her coherent with the new background; jersey
marks and face untouched (head proxy < 12/255 — note the proxy band sits above the jersey box, so on a
background op it will carry background change; the eyes decide the face); aspect within bound. The
outside-region ratchet does not apply as pass/fail here (the background IS the region changed); it is
reported.

**AD** — brand "Jane Street" (not in the rules' BRANDS vocabulary → no `exclude_marks`; the note says so),
context = the confirmed Jane Street brief on studio_plans (970be251, 23 Sep 21:41Z: objective announce /
brand_campaign, product line "trading firm", story "Draw the parallel between athletic preparation and the way
Jane Street approaches problems — deliberately, iteratively, without theatrics.", tone understated · precise ·
quietly confident, style ugc) — its lines go in as `campaign.{product, story, goal}`. Headline, grounded in
that brief and inside the rules' bound (≤ 4 words, ≤ 24 characters): **"Without theatrics"** (its words are
the story's). Setting, all three cells: "stadium pitch at dusk" (21 chars; a treatment, not a claim). The
op's sentence: `add the headline "Without theatrics" across the top, and change the background to the
stadium pitch at dusk` → DISPLAY_TEXT + CHANGE_BACKGROUND, route-checked. **A fourth quote, on purpose, $0:**
cell 2 first asks with the 6d walk's invented claim "Built to keep cool" — predicted to REFUSE AND NAME
("built") at the params, never rewrite; then cell 2 runs with the grounded headline. Criteria: the headline
spelled correctly (WITHOUT THEATRICS — DISPLAY_TEXT uppercases) at whatever size, 3/3; grounded (by
construction) and never a known brand's name (mark law — Jane Street is unknown to the rules, and the
headline is not its name anyway); the setting honoured; the CAMPAIGN fence respected — no invented product
claim anywhere in the frame (no "trading" copy, no invented tagline); identity holds (eyes); STANFORD /
crest per the NIL rule (the ad op names no garment, so the scope clause "change only the added banner and
the background" protects the jersey — predicted kept 3/3); a headline crop annotated on every sheet row.

**Budget, quoted:** garment $0.60 (quoted) + product ≈ $0.69 (+ $0.031 per product reference) + background
$0.60 + ad $0.60 ≈ **$2.50** of the $3.00 cap; the running total is checked before each op's run.

### Lane 2 batch results — garment · product · background_clean · ad (23 Sep 2026)

Quoted $2.50 of the $3.00 cap; **reported $2.04** (each 2K cell reports $0.1344 against $0.1654–0.1963
quoted; the 4K cell $0.24 against $0.271–0.3019). Accept none: every result sits `ready` under
studio/edit-previews/ (24 h), the library count was 490 before and after every run. Stray `quoted` rows
from the quote-only passes were discarded. Sheets (source | result | diff | crop, captions per row):
`probe-out/image-edit/<op>/contact-sheet.png`.

**Ratchets (outside < 10/255, head proxy < 12/255) and the measurement's own limit:** "outside" is
everything off the detection BOX, and the box is tighter than the garment — on garment cell 1 the sleeves
sit outside it, so garment pixels the op was asked to change count against "outside". That is a
measurement mechanism, named here, not a loosening: the ratchets stand as written and the misses are
recorded as misses.

| op · cell | quoted | reported | aspect | inside |Δ| / ΔE | outside |Δ| | head |Δ| | verdict on the pre-registered criteria |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| garment 0 · 7fe0b609 | 0.1654 | 0.1344 | 2.48% | 25.0 / 12.8 | 6.02 | **16.44** | adidas landed; swoosh left; 8 kept; **STANFORD dropped**; **shorts changed to adidas shorts** (off the named item); head ratchet MISSED |
| garment 1 · 37df2f85 | 0.1654 | 0.1344 | 0.44% | 37.8 / 20.4 | **10.06** | 11.32 | adidas landed; NJ crest altered (predicted); CarMax dropped (declared); jersey teal → light blue (not asked); outside ratchet MISSED by 0.06 (sleeves outside the box) |
| garment 2 · 64c28710 | 0.271 | 0.24 | 0.00% | 23.6 / 14.4 | 5.70 | 6.96 | adidas landed; STANFORD, 8, crest, armband kept; swoosh left; HELD |
| product 0 · 7fe0b609 | 0.1963 | 0.1344 | 2.48% | — | 10.51* | — | BOLYN ball placed on the floor beside her, real label (crop); person and marks unchanged; HELD |
| product 1 · 37df2f85 | 0.1963 | 0.1344 | 0.44% | — | 12.56* | — | ball placed bottom-left on the floor; held ball, crest, CarMax unchanged; HELD |
| product 2 · 64c28710 | 0.3019 | 0.24 | 0.00% | — | 7.47* | — | ball on the grass by her right foot; STANFORD, 8, armband unchanged; HELD |
| background 0 · 7fe0b609 | 0.1654 | 0.1344 | 2.48% | 7.4 / 4.2 | n/a | — | a plain backdrop asked of a plain backdrop: near no-op; her edges and hair intact; HELD |
| background 1 · 37df2f85 | 0.1654 | 0.1344 | 0.44% | 66.5 / 40.9 | n/a | — | sponsor wall → plain red wall; hair edge clean at full res, no halo; light on her coherent; kit and CarMax unchanged; HELD |
| background 2 · 64c28710 | 0.271 | 0.24 | 0.00% | 18.4 / 12.9 | n/a | — | stands emptied, signage gone, pitch kept; her unchanged; HELD |
| ad 0 · 7fe0b609 | 0.1654 | 0.1344 | 2.48% | — | 136.5* | — | WITHOUT THEATRICS spelled correctly; setting honoured; STANFORD, 8, ball kept; identity holds; no invented copy; HELD |
| ad 1 · 37df2f85 | 0.1654 | 0.1344 | 0.44% | — | 72.8* | — | headline correct; wall → dusk stadium; NJ, CarMax, ball kept; HELD |
| ad 2 · 64c28710 | 0.271 | 0.24 | 0.00% | — | 36.4* | — | headline correct; dusk stadium; STANFORD, 8, armband kept; HELD — and the $0 refusal on this cell first ("Built to keep cool" → 422 naming "built") HELD |

(* whole-frame |Δ| where the op has no detection box — a placed add and the ad change the frame by design;
reported, not a pass/fail. Background ops change the whole background by design; the head proxy band
sits in the background above the jersey box, so it is not reported as pass/fail there either.)

**Findings (engine defects or gaps, no fixes without Adi's go):**

1. **The garment op does not encode the NIL interim rule.** Cell 0 dropped STANFORD; cell 1 replaced the NJ
   crest. The compiled spec is "replace the jersey with adidas jersey … change only the jersey" — silent on
   marks ON the item. Mechanism: a keep line for the item's identity marks (school / team wordmark, crest,
   number), written by the compile from brand_swap's `descriptors` slot or a new constraint kind
   (`keep_marks`). Card, with the sheet as evidence.
2. **Scope miss on garment cell 0:** the shorts became adidas shorts although the sentence named the jersey
   alone. The scope clause ("change only the jersey") did not hold on the model's side; a second-instance
   check (the shorts' region unchanged) would catch it at QA, not at the prompt. Card (QA, logging-only
   today).
3. **Jersey colour drift on garment cell 1** (teal → light blue): "adidas jersey" carries no colour, and the
   rules' brand change keeps `descriptors` empty. A brand swap that should keep the garment's colour needs
   the descriptor written ("an adidas teal jersey") — same seam as finding 1.
4. **CarMax dropped on a brand swap, as declared.** A product call: a sponsor is a third brand's mark; whether
   a kit swap keeps or clears it is policy, not a defect.
5. **Pre-ternary rows are refused by the source gate until re-tagged.** The library's only product photo
   (e64e900a) carried `athlete_present: false` and no `subject`; the gate refused it as `source_unverified`
   (correct by the rule), and one re-tag through the app's own tagger (`tagAsset`, one flash call) wrote
   `subject: nobody` and the op ran. Lane 3a / 4 will meet this on every older person-free row; the
   backfill is the enrichment's (a re-tag pass for rows with no `subject`), carded.
6. **Measurement:** the detection box under-covers the garment (finding on the ratchet's yardstick, above).
7. **Product binding** is C3's Object manifest line — verified on the quote row's compiled prompt before spend
   ("Image 2 — THE OBJECT to place in the frame: "product 1" … add the soccer ball from Image 2, place it on
   the ground next to the person"), the reference carried as role `product`. No flag.
8. **The ad's CAMPAIGN block** is appended at run time from the row (`params.campaignBlock`, ~300 characters,
   fenced <<<CAMPAIGN>>> … <<<END_CAMPAIGN>>>), so the quote row's stored prompt does not show it; the
   engine test pins the run-time composition and the three ad rows carry the block. The cost log stores no
   prompt, so there is no second live witness — noted.
9. **Latency:** 25–28 s a 2K call, 37–45 s a 4K call; detection adds ~4–6 s to a region-bound quote.

**Refusals, with paths:** ad cell 2's ungrounded headline → `ops.ts groundedHeadline` → `planOp` refusal →
`quoteEdit` 422 naming "built", before any row, quote or call. The product photo → `source.ts
sourceDecision(null)` → `source_unverified` 422 (before the re-tag).

**Spend to date:** recolour $0.51 + batch $2.04 = **$2.55 reported** ($3.10 quoted) of the $6 envelope.

**Adi's review (23 Sep 2026): all four sheets — "solid pass for all".** Lane 2 closed.

## Lane 3a — the recommendation editor

**Recon (accepted by Adi, 23 Sep 2026):** the popover is a card BELOW the strip that fired, owned by
AgentScreen, driven by one `lastPicked` state set in `togglePick` / `toggleProduct` on a select only and
cleared on the next interaction; selection never reads it; the shared StudioMediaPicker stays
edit-ignorant. The pre-ternary source-gate refusal is surfaced as honest copy in the popover, never
swallowed. No wiring until the spike verdict.

### The spike (Option B + Adi's two riders; 4 flash calls, 23 Sep 2026)

`server/studio/edit/recommend.ts` (module only — no route, no UI): one flash call with the photo and the
brief's lines, strict JSON; `groundRecs` keeps a rec only when its `because` is a VERBATIM substring of a
brief line and its op parses through ops.ts. The synthetic line "No Nike marks on kit or ball." entered as
one more brief line, same shape, same substring check as the real four (rider 1). The real lines were the
confirmed Jane Street brief's constraints (970be251): the caption tags, no financial advice, name the
internship once, "No competitor firms named or shown." Runner: `probe-out/image-edit/spike-recs.ts`.

| cell | lines | recs | dropped | ms | tokens in / out |
| --- | --- | ---: | ---: | ---: | --- |
| plant · 7fe0b609 (Nike on jersey, shorts, ball) | real 4 + synthetic | 1 | 0 | 10.2 s | 1589 / 91 |
| clean · e64e900a (BOLYN ball) | real 4 + synthetic | 0 | 0 | 3.3 s | 1586 / 10 |
| clean · 9677d97e (gold hoops) | real 4 + synthetic | 0 | 0 | 2.8 s | 1563 / 10 |
| observation · 37df2f85 (Gotham / CarMax) | real 4 only (rider 2) | 0 | 0 | 4.0 s | 1550 / 10 |

**The plant's rec, verbatim:** `{"op":"recolour","params":{"target":"Nike logos","colour":"black"},
"because":"No Nike marks on kit or ball.","what":"There are visible Nike logos on the jersey, shorts, socks,
and soccer ball."}`.

**Against the registered success:**

- Plant caught: **YES** — one rec, the right line quoted character for character, op recolour (one of the
  two named).
- "…on the jersey": **PARTIAL** — the target is "Nike logos", the marks themselves, not the jersey. That is
  arguably the more precise reading of the line (the marks are on four things), but it is not the registered
  target, and it decides whether the chip is tappable: "make the Nike logos black" ROUTE CHECK below.
- Zero recs on the clean pair: **HELD** (0 and 0; the caption / advice / internship lines produced nothing
  either — the "only what is VISIBLE" rule held).
- Observation cell: the model did NOT read CarMax or the Gotham crest as "competitor firms" — 0 recs. On the
  realest ambiguous input we have, no nag.

**Cost and latency:** 1.55–1.59k input tokens a photo (the image dominates), 10–91 out. `textPriceFor(
"gemini-3.5-flash")` is NULL in config — **the flash model the tagger and the interpreter already use has no
text price in the table** (finding; the cost log would call these unpriced). At the published flash list
rate the four calls are ≈ $0.002–0.003 total, under the $0.15 by two orders. Latency 2.8–4.0 s on an empty
answer, 10.2 s on the hit — the popover must be async (it is designed so) and the 12 s timeout stands.

**Route check of the plant's rec, $0:** "make the Nike logos black" → **ASK, `brand_change`** — the rules
decline a brand word as a recolour target (rule 4b). "make the logos black" and "make the jersey black" both
route (RECOLOR). So the rec as the model wrote it would NOT be tappable into a quote: **a finding, and the
one mechanism the rec pass needs before it is shown to her** — either the grounding step route-checks each
rec's sentence and drops one that asks (fail-closed, would have turned this hit into a miss), or the
prompt's edit list says a target is a THING never a brand word and `groundRecs` strips BRANDS words from
targets ("Nike logos" → "logos", which routes). Adi's call, with the verdict.

**Verdict (Adi, 23 Sep 2026, in the Lane 4 revision): rec-included — "3a (rec + manual popover)".**
Mechanism chosen for the route finding: BOTH — `groundRecs` strips brand words from a rec's target
("Nike logos" → "logos") and then route-checks the op's sentence, dropping a rec that still asks. The strip
keeps the spike's hit; the route check is the fail-closed floor. The ad op is NOT offered in the popover
until Lane 4's screen exists (its chip deep-links there — "no dead ad chip ever renders").

### Lane 3a — built (23 Sep 2026)

**Server half (1e6bda6):** `server/studio/edit/recommend.ts` — one flash call with the selected photo (the
detection probe's bytes) and the brief's lines; `groundRecs` keeps a rec only when its `because` is a
verbatim brief line, its op parses through ops.ts, its target is stripped of BRANDS words and its sentence
ROUTES (a rec that would ask is dropped, `not_routed`); memoized per athlete × asset × brief hash for ten
minutes (a timeout answers manual-only and is not cached). `POST /studio/edits/recommend {assetId,
briefLines[≤12], brand?}` behind the same gate and flag; a source the gate refuses answers `{recs: [],
skipped: "source", refusal: <copy>}` — never swallowed. Tests: recommend 11, routes 8 (+3). Mutations red by
name: "rec shown without a brief line grounding it" (2 red), "rec that asks is shown" (1), "rec runs an op
without her tap" (1 — structural: the module imports no engine; a lazy `import("./engine")` reds it).

**Client half:** `editPopoverLogic.ts` (pure: `toggleIn` unchanged, `lastPickedAfterToggle` on a select
only, `swapIn`, `briefLinesFrom` = constraints + product line + story, `MANUAL_OPS` without the ad op,
`canAccept`, `paramsFor`), `use-studio-edits.ts` (recommend as a query keyed on asset + brief hash, quote /
run / accept / discard as mutations; accept invalidates the media strips), `EditPopover.tsx` (the card:
"PHOTO 3 · CHANGE ANYTHING?", the rec chips with their because, "Change it…", the refusal copy),
`EditSheet.tsx` (op → words → quote → run → preview → Keep | Discard; Accept renders only on the preview
step with a ready url), AgentScreen wired behind `EXPO_PUBLIC_STUDIO_IMAGE_EDIT` (the toggles compute
`lastPicked` from their own outcome; the popover renders under the PHOTOS strip or the PRODUCTS strip;
typing, an objective, a video toggle, the sheet's close and Keep all clear it; Keep swaps the server's
accepted id into `picked` / `products` in place). Tests: editPopoverLogic 9. Mutations red by name: "edit
offered on an unselected photo", "popover blocks selection" (the toggle's parameter list is exactly the
list, the id and the cap, and every AgentScreen call passes three arguments naming no popover), "edited
selection loses derived_from" (swapIn keeps the source id), "accept without preview shown", "edit affordance
renders anywhere outside the picker popup" (a walk of client/: EditPopover and EditSheet are imported by
AgentScreen alone). Both tsconfigs clean.

**Not measured here, for the device pass:** the popover's placement on a phone (the card sits below a
horizontal strip that may be scrolled), the sheet's keyboard behaviour, and the 10 s tail of a rec on a
hit (the card shows "Checking it against your brief…" until then).

## Lane 3b — chooser + pruning (built, 23 Sep 2026)

- **The chooser:** `BRAND_FORMATS` (brandLogic.ts) is Video and Carousel; `BrandFormat` is the same two;
  BrandPlanStep reads it. Story and Photo are gone from the brand post. **Interim, stated:** the Carousel chip
  keeps the OLD next-screen path (SetupScreen → MakeIt, one image) until Lane 4's Carousel Create screen
  replaces it — the Photo path is dead, the Carousel path is not yet the new one. SetupScreen's own chips
  are untouched (not in the revised 3b list; SetupScreen is reached only through that interim path now).
- **Pruning:** "Personal posts" and "Edit a photo" removed from Make something (`CreateDoor` is brand ·
  pitch · anything). Orphans removed with them: PersonalPostScreen.tsx, its `StudioPersonalPost` route and
  param type, `conceptFor` + its Concept table and tests (`suggestionsFrom` stays — NowFeed reads it).
  Kept on purpose: CampaignWorkspaceScreen (the sourceAssetId handoff), `useFixtures`, the Made shelf's
  "personal" section label (it labels output). NowFeed's "worth making" tap now starts the brand flow
  (`onStart` → StudioBrandPost) — on the Mia list as a product-surface change, as ruled.
- **One string:** the un-read video's row reads "Added at the end, as-is · $0 — this clip hasn't been read
  yet, so the plan can't cut into it." The section hint above the strip is unchanged.
- **Not touched:** MakeIt, the Board, StoryboardTab, any generate path.
- **Diff discipline:** five of the touched files were unformatted on main; prettier was run once by mistake
  and its wholesale reformat was reverted — the committed hunks are the edits alone.

Tests: brandPlan 19 (+1), brandLogic 15, editPopoverLogic 9 (the affordance walk still finds AgentScreen
alone), madeShelfLogic 17; both tsconfigs clean. **Mutation "brand-post chooser shows Story or Photo"**
(Photo added back to BRAND_FORMATS): brandPlan.test 1 red by name; restored.

### Lane 4, revised (Adi, 23 Sep 2026) — the Carousel Create screen

Entry: chooser → Carousel (after 3b the chooser is Video + Carousel only). SCREEN: a reference strip (library
or upload, 1–3 max — a 4th refused in UI and API), a per-ref variation count, CREATE. Distribution is hers:
default one ad per ref, or fewer refs with more variations; total initial candidates ≤ 3, +1 re-roll max.
Casting law per reference. ON CREATE: one ITEMIZED batch quote — per-ref Class-A cleanup (ONLY where a
grounded rec exists for that ref, never speculative) + per-ref ad counts; her Create tap on the quoted chain
is the consent. The job runs IN THE BACKGROUND (Create never blocks; navigate away; returning restores
state); recon proposes ONE away-completion surface (Now-feed row vs badge). PIPELINE per candidate: Class A
(if quoted) → Class B ad op on the cleaned intermediate → candidate; intermediates ephemeral (never library
rows, deleted with the run); candidates record derived_from their ORIGINAL reference, the cleanup stage in
chain metadata. RESULTS on the same screen: full-size view, Download one / Download all, Discard — a
download IS the keep (recordGeneratedAsset at download; Download-all skips discarded). POPOVER TIE-IN: the
3a ad chip deep-links here with the selected photo as ref 1 — one machinery, two doors, no headless runs.
MUTATIONS (supersede the prior set where they overlap): "run starts without the itemized quote", "candidate
or stage count exceeds the quote", "a 4th reference accepted", "cleanup runs on a ref with no grounded rec",
"unverified person reference reaches generation", "Create blocks the screen until completion",
"intermediate persists as a library row", "downloaded frame loses derived_from", "download-all includes a
discarded frame", "ad chip runs headless instead of opening this screen". Recon + plan before build; order
3a → 3b → 4.

## Lane 4 — recon + plan (APPROVED by Adi, 23 Sep 2026, with three riders)

**Riders:** (1) **single-owner discipline from day one** — the stitch-tick double-fire (in-process cron +
external scheduler both live) is the standing lesson; kick-after-Create plus tick-sweep is allowed ONLY with
an atomic job claim; new mutation red by name: "kick and tick both run the same job". (2) The interim
Carousel chip → old next-screen path: **the final gate proves Lane 4's screen replaced it and the old path is
unreachable from the chooser — one test, so the interim cannot survive to merge.** (3) Download-all names
the count it will save in its copy.

**What exists to reuse (read-only recon):**

- **Background jobs:** the house mechanism is a cron tick — `POST /api/internal/studio-video-tick` (index.ts,
  INTERNAL_CRON_SECRET, an advisory lock) calls `videoTick()` which reaps expired leases and claims queued
  video jobs (`generation_jobs` lease columns). Nothing runs in-process across a request. A batch of edits
  gets the same shape: **`/api/internal/studio-edit-tick` → `editTick()`** claiming queued edit-batch rows,
  plus an immediate in-process kick right after Create so dev needs no scheduler; a missed kick is picked
  up by the next tick.
- **Polling on the client:** one precedent, `use-studio-publish.ts` (`refetchInterval` from the row's state).
  The carousel screen polls `GET /studio/edits?batchId=` the same way while any row is quoted or running,
  and stops when none is.
- **Upload in-screen:** `useUploadMedia` (use-media-library.ts; rights ack, orientation fix, SafeSearch, the
  async tagger). A fresh upload is untagged for a few seconds → the source gate answers `source_unverified`
  → the screen shows that copy on the tile and re-asks on a timer until the tag lands (Adi's ruling: wait
  for the tag before quoting).
- **Download:** `saveRemoteAsset(url, fileNameFor(url, assetId))` (lib/download-asset.ts), web and native.
- **Full-size view:** `AssetViewer` (pinch, pan, Close, Download) — takes one asset; the grid opens it.
- **The chooser's Carousel chip** today takes the old SetupScreen path (3b's stated interim); Lane 4 points it
  at the new screen. **The 3a ad chip** appears in the popover only once this screen exists, and deep-links
  to it with the selected photo as ref 1 (`StudioCarouselCreate { refs: [assetId] }`).

**The plan.**

SERVER (behind STUDIO_IMAGE_EDIT_OPS; all in server/studio/edit/, one mount line):

1. `POST /studio/edits/batch/quote` `{refs: [{assetId, variations 1–3, cleanup: rec | null}] (1–3; a 4th is a
   400 — "a 4th reference accepted" reds), brand, campaign {product, story, goal}, headline?, setting?}`.
   Every ref passes `verifiedSource` (person → must be her; person-free proceeds — "unverified person
   reference reaches generation" reds at the quote, before any row). A `cleanup` is accepted ONLY when it
   re-grounds server-side through `groundRecs` against the same brief lines (its `because` verbatim, its
   sentence routing) — else 422 ("cleanup runs on a ref with no grounded rec" reds; never speculative).
   Writes ONE `batch_id`: per ref, an optional stage-A row (the rec's op, `params.role = "intermediate"`)
   and N stage-B ad rows (`params.stage = "B"`, `params.after = <A row id>` when there is one), each under
   its own studio_generation_previews quote — the existing machine — and answers the ITEMIZED quote: per
   ref, "cleanup $x" + "N ads × $y", and the total. Total candidates ≤ 3 across refs.
2. `POST /studio/edits/batch/:batchId/run` — her Create tap. For every row: `createGenerationJob` +
   `consumePreview` (once) + `queueJob`; rows go `quoted → running` only inside the tick. Answers at once
   ("Create blocks the screen until completion" reds: the route returns before any model call; a client test
   pins that the screen's Create handler navigates freely after the call resolves). Nothing without every
   row's quote consumed ("run starts without the itemized quote" reds).
3. `editTick()` — claims the batch's queued jobs oldest-first; a stage-B row whose `after` is not yet `ready`
   is deferred; a stage-A row runs as today (its output under edit-previews/); a stage-B row runs the ad op
   with a **source override** (a new internal option on `runEdit`: the A row's preview object as the frame's
   bytes and dimensions, the ORIGINAL reference as `source_asset_id`), so `derived_from` at download is the
   original and `params.chain = {cleanup: <A row id>}` records the stage. When every B row of a ref is ready
   the A row is `discarded` and its object deleted — an intermediate is ephemeral and can never be accepted:
   `acceptEdit` refuses `params.role === "intermediate"` ("intermediate persists as a library row" reds).
   Candidates beyond the quote cannot exist: the tick runs rows, never creates them ("candidate or stage
   count exceeds the quote" reds — a test that the batch's row count equals the quote's count after the run).
4. `POST /studio/edits/batch/:batchId/reroll {assetId}` — ONE more B row for that ref, quoted afresh and run
   through the same tick; refused when the batch already holds 4 candidates.
5. Download = keep: `acceptEdit` as it is (recordGeneratedAsset, origin generated, derived_from the ORIGINAL
   — "downloaded frame loses derived_from" reds) — the client downloads the accepted asset's signed url.
   `POST /studio/edits/batch/:batchId/accept-all` accepts every candidate that is `ready`, skipping
   `discarded` ("download-all includes a discarded frame" reds), and answers the asset ids.

CLIENT:

6. `CarouselCreateScreen` (route `StudioCarouselCreate { refs?: string[] }`): the reference strip (library
   picker ≤ 3 + upload; a 4th tap refused in copy), per-ref "how many" (1–3, total ≤ 3), the cleanup line per
   ref only when `useRecommendEdits` answers a grounded rec for it, the brand/brief lines from the handoff,
   CREATE → the itemized quote sheet → her tap → `run` → she is free (the screen shows "Making 3…" and the
   tab bar works). Results as a 2×2 GRID (≤ 4 tiles; a deck hides the count and the per-tile decision, a grid
   shows all four and their state), per tile Download / Discard, "Download all", full size via AssetViewer.
   State restore: the batch id in the route params; opening the route with one polls it. The 3a ad chip
   deep-links here ("ad chip runs headless instead of opening this screen" reds: the popover's ad chip is a
   navigation, and a structural test pins that no client file posts the ad op outside this screen).
7. **Away-completion: the Now feed row** (proposed, one surface): NowFeed already lists what she made and
   what is due; a batch with ready, undecided candidates is one more row ("Your carousel is ready · 3
   frames") that opens the screen. Not a badge: a badge says "something", the row says what and opens it.

**Predictions, pre-registered:** a Carousel flow with 1 ref × 3 and a grounded cleanup rec yields exactly
4 rows under one batch (1 A + 3 B), one itemized total shown before any run, Create returns in < 1 s, the
tick finishes 4 calls in ≈ 2 min, the A row ends `discarded` with no library row, and library rows equal
downloads (0 until she taps). A 4th reference is a 400. A second ref with 1 variation plus the first with 3
is refused at the quote (total 4 > 3). Acceptance spend ≈ $1.00 (1 ref × 3 + 1 re-roll + 1 cleanup, 2K).

**Size L**: server two commits (quote + batch rows + tick; run/reroll/accept-all + tests), client two commits
(screen + polling; grid + downloads + the popover's ad chip). Ten mutations red by name as listed above.

### Lane 4 — built (23 Sep 2026)

**Server (a1dbca2):** `server/studio/edit/batch.ts` — `quoteBatch` (1–3 refs, ≤ 3 candidates, every ref
through the source gate, a cleanup only where the rec re-grounds through `groundRecs`; rows under one
`batch_id`, each under its own quote; the itemized lines and total; a half-made batch is discarded on any
refusal), `runBatch` (all rows checked, then each quote consumed and its job queued OLDEST ROW FIRST so a
reference's A job precedes its B jobs; returns at once; kicks the tick), `claimEditJobs` (status queued AND
mode edit, FOR UPDATE SKIP LOCKED — one owner; `claimVideoJobs` now takes `mode <> 'edit'`), `editTick`
(A runs; a B whose A is not ready is deferred with its attempt not counted; a B whose A failed fails; B
runs the ad op with A's object as the frame via `executeEdit`'s `sourceOverride`, its `source_asset_id`
the ORIGINAL, `params.chain.cleanup` recorded), `sweepIntermediates` (A discarded once its B rows are at
least ready AND either no re-roll can need it or every B is decided), `rerollBatch` (one more, quoted afresh,
refused at four), `acceptAllBatch` (ready kept, discarded skipped and counted), `batchView`. `engine.ts`:
`runEdit` split into `prepareRun` + `executeEdit` (the inline door and the tick check the same things);
`quoteEdit` takes `meta`; `acceptEdit` refuses `params.role === "intermediate"`; `presentEdit` says
`intermediate`. Routes: batch/quote · :id/run · :id/reroll · :id/accept-all · GET :id, and
`POST /api/internal/studio-edit-tick` beside the video tick with its own lock key. Tests: batch 12 (PGlite;
the queue drained before each tick test), videoJobs 26 (+1: the video claim never takes an edit job),
engine 20, routes 10 (+2). **Ten mutations red by name:** run starts without the itemized quote (1),
candidate or stage count exceeds the quote (1), a 4th reference accepted (1 — pinned by the refs-count
refusal's own words, since four refs also exceed the three-ad total), cleanup runs on a ref with no grounded
rec (1), Create blocks the screen until completion (1), intermediate persists as a library row (1),
downloaded frame loses derived_from (2), download-all includes a discarded frame (1), kick and tick both run
the same job (7 — the claim without its status predicate re-claims running jobs), unverified person
reference reaches generation (1).

**Client (69043a8):** `carouselLogic.ts` (addRef / removeRef / setVariations / canCreate / batchBody /
downloadAllLabel / candidatesOf / readyBatches), `use-studio-edits.ts` (+ useBatchQuote / useBatchRun /
useBatch polling every 3 s while running / useBatchReroll / useBatchAcceptAll / useEditsList),
`CarouselCreateScreen.tsx` (route `StudioCarouselCreate {refs?, brand?, campaign?, briefLines?, batchId?}`;
the strip, the stepper, the cleanup line, the quote card, the grid with AssetViewer for full size, Download
one / Download all · N frames / Discard / Make one more), BrandPlanStep's Carousel chip → the screen
(brand, the campaign's lines, the brief lines, the product photo as ref 1 when picked) and the interim
next-screen path REMOVED (BrandPostScreen keeps SetupScreen for the flags-off flow only), the popover's
"Make it an ad…" → the screen with the photo as ref 1 (a navigation, never a call), NowFeed's READY row
("Your carousel is ready · N frames to look at · nothing saved yet") → the screen with the batch id.
Tests: carouselLogic 7; editPopoverLogic 9, brandPlan 19, brandLogic 15, engine 20, routes 10 green.
**Five mutations red by name:** a 4th reference accepted (client), candidate or stage count exceeds the
quote (client), download-all names its count, ad chip runs headless instead of opening this screen
(structural), the interim chooser path survives (rider 2, structural).

**Not measured here, for the acceptance run and the device pass:** the live batch (1 ref × 3 + 1 re-roll +
1 cleanup ≈ $1.00, registered), the tick's real latency per candidate (≈ 30–45 s each, serial), the
scheduler wiring for `/api/internal/studio-edit-tick` (Cloud Scheduler — Adi's lane, like the video tick),
the upload path's tag wait on a fresh photo, and the grid on a phone.

## Adi's correction (23 Sep 2026, on the device walk)

The screenshot showed the plain brand post's **Set-it-up** screen (Photo · Carousel · Video · Story): the
chooser this PR changed lives on the flagged plan step and never rendered on his run, and the carousel entry
had been put there instead of on the screen he uses. Fixed (e076c3d): Set-it-up's Carousel chip → "Make the
ads" → the Carousel Create screen with the brand on the brief, the concept as the brief's lines and her first
attached photo as the reference, never Make it; and that screen is now **one photo → three ads** (the first
photo takes all three variations, "Change photo" swaps it), the engine's three-reference capacity kept
underneath. Pinned in carouselLogic.test. **Amendment (Adi, same day): the popover's ad door is DELETED, not consolidated** — no "Make it an ad…", no
`onAd`, no ad label, a grounded ad rec filtered before the card renders; the carousel's ONLY entry is the
brand post's format chip after the brief. The rec popover and the manual sheet (four ops, ad excluded) stay
as built. The structural test's successor, "carousel entry renders in the edit popover", reds by name.

## Add / remove a thing (Adi, 23 Sep 2026) — modes of the product op, not new ops

Adi, on the sheet's WHAT TO CHANGE list: "there should be a remove or add object/prod too" — then, before a
migration was cut: "why cant we add it in to place a product/swap the kit as another chip". It can, and it
is: the product op takes a `mode` — `place` (her product photo, the shape Lane 1 shipped; a body with no
mode IS this mode, so nothing already stored or already calling changes), `add` (a thing the model draws
in, in words: "add a soccer ball on the ground next to me" → ADD_OBJECT, region-free, no reference, and
the sheet says the model draws it) and `remove` (a thing in the photo: "remove the water bottle" →
REMOVE_OBJECT, region-bound). The table's CHECK stays on five `op` values; params are validated in ops.ts,
so no 0065 and no DDL apply. Route-checked at $0 before the build: both phrasings route with no ASK.

- `server/studio/edit/ops.ts` — PRODUCT_PARAMS is a discriminated union under a preprocess that defaults
  the mode; planOp's product arm writes the three sentences. Pinned in ops.test (mode add/remove routes;
  a remove with no target, an add with a photo, each refused; both in the no-GENERATE sweep).
- `recommend.ts` — the closed list gains `product {"mode":"remove","target"}` (a rival's product, a sign);
  the placeholder asset id is injected only for the place mode.
- Client — "Place a product" keeps its chip; the sheet's params step opens with three mode chips (My
  product photo / Draw a thing in / Take a thing out), `paramsFor` mirrors the three shapes (pinned).
- Live: not run. The two modes reuse the lane-2 product/recolour paths (native edit, same measure); the
  first `add` and the first `remove` on the device are Adi's acceptance calls at the usual $0.17 each.

## The brand's name is not a word (Adi's device walk, 23 Sep 2026)

The carousel's quote refused "Sunrise Oats Co. (SEED)": `ad params: brand — letters, digits, spaces and
hyphens only`. The ad op's brand was a `word` (a sentence slot's charset) though it is never a sentence
slot: it is data in the CAMPAIGN block, the mark to exclude, and — an unknown brand, no headline given —
the display text. Now it takes a name's characters (`. & ( ) ' + ! ,`, ≤60). Used as the headline, the
name is written as the banner can write it (`headlineOfName`: capitals, HEADLINE_CHARACTERS only —
"SUNRISE OATS CO. SEED"), noted on the plan, with the exact name still in the CAMPAIGN block; a name the
bounds still refuse (five words, a tagline) asks for a headline at the quote, in the op's own words,
instead of the rules' ASK. Probed at $0 with display text on: Sunrise Oats Co. (SEED) → DISPLAY_TEXT
"SUNRISE OATS CO. SEED"; Ben & Jerry's and H&M route as written; a 6-word name refuses. Pinned in ops.test.

Seen in the same walk, no change: "remove the soccer ball" on a photo with TWO balls (the earlier drawn-in
one, accepted, had taken the source's place in the selection) removed the floating one and left the held
one — region diffs 76.5 vs 10.4. Card: a remove whose detection finds more than one match should say so
at the quote rather than let the model choose. And the rec pass dropped a `product {thing: "package"}`
proposal as not_routed ("package" is not a thing the add rule reads) — designed, logged at info.

## The photo is picked on the Plan-it screen (Adi, 23 Sep 2026)

"I should be able to see photos / select them for myself before going to click Make a carousel." The
Plan-it screen's Carousel card now holds the photo picker (the same StudioMediaPicker the Carousel Create
screen uses, agent-pick origins, upload allowed, one selection); the door is shut ("Pick the photo first")
until she has picked, and carries the pick as ref 1 WITH its thumbnail (a new `thumbs` route param), so
the Carousel screen no longer opens on a blank grey tile. The product photo is no longer the carousel's
ref. Pinned structurally in carouselLogic.test. The flags-off Set-it-up path is unchanged (it already
had the picker: its first attached photo is the ref).

## The setting is required; a period breaks a compound (Adi's device walk, 23 Sep 2026)

- **Setting required** ("the setting can't be optional"): the batch quote's schema, `QuoteBatchInput`,
  the client body and the quote CTA all require it; the label lost "· OPTIONAL". The first ad is set
  where she says, the other two take settings she did not give. Pinned in routes.test (no setting →
  400 before the engine), batch.test's fixture, carouselLogic.test (body + structural).
- **"That edit can't be read as a change to this photo"** on "Sunrise Oats Co. (SEED)" with a setting,
  fine on "Sunrise Oats Co": measured at $0, the compound `add the headline "SUNRISE OATS CO. SEED"
  across the top, and change the background to …` ASKS add_unclear; without the period it routes as
  DISPLAY_TEXT + CHANGE_BACKGROUND. "!" "?" "&" "'" "-" all survive; only "." breaks — the clause
  splitter reads it as a sentence's end inside the quotes. Fixed in the op (`bannerText`: the display
  text never carries a period, on both the name-derived and the given-headline paths); the splitter
  is classify.ts's (shared), carded: quotes should shield a period from the split.

## The gate (23 Sep 2026, on 84dae95's tree)

`npm test` bare: **470 suites, 8,964 tests, 0 red, exit 0** — 18 batches, every one green; affiliationSync's
known tie did not fire this run. Both tsconfigs clean. Spend to date $2.55 reported + the spike's ≈ $0.003;
the Lane 4 acceptance batch (≈ $1.00, registered) is NOT run — it is Adi's go, after review.

## Cards (not built)

- **Quotes should shield a period from the clause split** (classify.ts, shared): `"CO. SEED"` inside a
  headline's quotes ends the sentence for the compound splitter. The ad op works around it.
- **Remove with more than one match**: detection returned two regions for "the soccer ball" and the model
  picked one. The quote should name the count and ask which, before spend.

- **PR 10 — drafts listed everywhere** (0c, evidence above).
- **Garment op — keep the item's identity marks (NIL interim rule) and its colour** (Lane 2 findings 1, 3):
  a keep line / `keep_marks` constraint or brand_swap descriptors written by the compile. Needs Adi's go.
- **QA — a scope check on a brand swap** (finding 2: the shorts changed on "change only the jersey").
- **Enrichment — re-tag pass for pre-ternary rows** (finding 5): rows with no `subject` are refused as edit
  sources / references until tagged; a backfill, not the cron's next tick.
- **Sponsor marks on a kit swap** — a product call (finding 4).
- **Cloud Scheduler for `/api/internal/studio-edit-tick`** — deploy config, Adi's lane (the video tick's twin).
- **Edit-previews sweep** — objects under edit-previews/ for rows past their 24 h ttl (PR 10 housekeeping).
- **Text price for gemini-3.5-flash** in config's table (the rec pass, the tagger and the interpreter all
  log as unpriced today).
- **Product call — fence or keep `image.generate`.** The four from-scratch paths on the MakeIt sentence door
  (interpreter new_image exit `routes/studio.ts:1348`; EXPLICIT_GENERATE rule 0 `classify.ts:1234`;
  `hasSourcePhoto: false` `classify.ts:199`; a client-sent `image.generate` intent, no server guard).
- **Mia list — NowFeed's "start personal" suggestion tap** rewired to the brand flow (3b).
- **Cross-call log duplicates** (0b): one `route` line per CALL, several calls per request — the purpose tag is
  the seam, if it ever matters.
- Everything Lane 2 exposes; planner-stills carousel; cost-line UI + "let the agent build" copy (folded into
  3a if trivial); Story / Video deeper cleanup; edit ops beyond the 5; multi-reference carousels.
