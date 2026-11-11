# Product add referent (C3) — the evidence

Branch `studio/product-add-referent`, built on main **`29b2fc8`** (#492, C2 merged) and then merged onto main
**`2dc602e`** (#497, wave A). **Every baseline is re-cut on `2dc602e`** — see "Re-cut on main 2dc602e" below, which
supersedes the counts in the sections before it; those are kept as the record of what was predicted and run first.

## The defect

An add could consume a photo only from the Object tile.

- **A Product photo on an edit** rode along as "PRODUCT: … Render this exact object", and nothing in the instruction
  pointed at it. The add invented its thing beside it (F-AM5).
- **Auto-mark therefore refused to mark a You + Product add** (D5 b), and C2's reading made the same send a new image
  (D2).
- **Adi hit it live twice** (2026-09-16): "add a water bottle from image 2" with the bottle in the Product tile became a
  new image; the same flow through the Object tile was a clean edit.
- **The "flag" he had to flip was D5 (b)'s forced tap on his photo.** No variable exists.

**Recon ($0):** Adi's sentence routes `add_unclear` (interpretable) whatever is attached. The CLIENT gates made it a new
image. A server-only fix would have moved nothing unless she tapped.

## What was decided (Adi, 2026-09-17)

|     | decision                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **(c): automatic + a card note.** With no Object photo attached, her one Product photo is the thing an add places, and the preview says so before she pays, through the existing `degraded` warning. Copy goes to the review pile. The different-thing case ("add a water bottle" beside a photo of sneakers) is disclosed pre-spend. (b), binding only when she points at it, is a future card behind wave A's V1 (F-PA3). |
| 2   | **Replacements are out.** "change my shoes to these sneakers" with a product still asks; its own card (F-PA2).                                                                                                                                                                                                                                                                                                              |
| 3   | **The placed product reads the Object line**, Q1's measured shape.                                                                                                                                                                                                                                                                                                                                                          |
| 4   | **Two or more products and no Object photo:** ask when she marked the photo, and D5 (b)'s new image when only auto-mark would have.                                                                                                                                                                                                                                                                                         |
| 5   | **Two adds beside a product ask**, as two adds beside an Object photo do.                                                                                                                                                                                                                                                                                                                                                   |
| 6   | **Flag question closed:** D5 (b)'s forced tap. Post-C3 default: auto-mark whenever the server can bind. **Probe: yes**, the 4-call version, staged for Adi to run — cap raised to **$0.80** after the dry run (below): the fourth cell is load-bearing. The person-in-product-shot residual goes to the weak-ref-detection card's scope note (F-PA5).                                                                       |

## The commits

|             | commit    | what                                                                                                                                                                                                                                                                                                                                              |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PA.1        | `6e3b7a2` | **Freeze + spend guard.** `freezeEditIntent`: no Object photo → the lone Product photo is the add's `objectAssetId`; two products ask `{products: 2}`; two adds beside a product ask `{adds: 2, products: 1}`; adds only. `readNativeIntent` re-reads the same rule: no Object photo on the brief and exactly one product. Two new refusal lines. |
| PA.2        | `802d1c9` | **Compile + goldens.** `placedPhoto`; `objectImageNumber` finds the photo under its own role (a brand piece planned as a product is never it); the placed product, and only it, reads the Object line. Nine goldens added, none of the 101 moved.                                                                                                 |
| PA.3        | `13ec226` | **Disclosure.** `placedProductNote` as a `degraded` warning: "Your product photo will be used as the water bottle. If it shows something else, put the right photo in the Object tile and check again." Four goldens gain it, nothing else moves.                                                                                                 |
| PA.4        | `1364814` | **Client gates.** D5 (b) holds only for two or more products. C2's `add_unbound` reads what the server bound (`changes[].add.objectAssetId`), not the tray.                                                                                                                                                                                       |
| consent pin | `f8e14bc` | Tests only: an edit with a photo tagged as her and her product placed is still blocked by `refusedOnEdit`, routes no character slot and writes no likeness line.                                                                                                                                                                                  |
| PA.5        | —         | This document, and ledger entries F-PA1–F-PA6.                                                                                                                                                                                                                                                                                                    |

Nothing in classify.ts, the interpreter (prompt, menu, memo key), route()'s `Attached`, `referencesFor`'s person half,
the preview route, the generate leg, the screens, or deploy config changed.

## How a You + Product add goes now (routing on)

1. **The composer:** an add with one Product photo and no Object photo is edit-shaped like any other: auto-mark marks
   the photo (A2). An `add_unclear` ask is read by the interpreter at send (C2).
2. **The freeze:** the add places her product (`objectAssetId` = the product's asset id). With two products, or two
   adds, it asks instead.
3. **The compile:**
   - `Image 2 — THE OBJECT to place in the frame: "product 1". Take the object from this image and render it into the
scene, in the position the instruction names. …`
   - `add the water bottle from Image 2, place it next to the person. …`
   - Byte-identical to the same sentence with the bottle in the Object tile (golden pair, below). A brand's piece rides
     beside it on its PRODUCT line.
4. **The preview:** ready, with "Your product photo will be used as the water bottle. …" beside the resolution note.
   No "invent" line.
5. **At spend:** `readNativeIntent` refuses a product id the freeze would not have written (an Object photo on the
   brief, two products, a different id).

## Goldens — 101 unchanged, 9 added, 4 recaptured (compile/golden.test.ts, 101 → 110)

- **PA.2's pre-capture run:** red on EXACTLY the nine new fixtures and the count guard; green on all 101 existing.
  The golden file's diff is additions only (113 lines).
- **PA.3's pre-capture run:** red on EXACTLY the four placed-product fixtures; the diff is their `disclosures` lines
  and nothing else.

| fixture                                                                                                      | what it pins                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| op ADD_OBJECT — her lone Product photo, placed as Image 2 on the Object line (C3)                            | by hand; the Object line, "from Image 2", the note (PA.3)                                        |
| op ADD_OBJECT — her placed Product photo is Image 2, a brand piece rides as Image 3 on the PRODUCT line (C3) | the numbering proof beside brand material                                                        |
| product add — Adi's live sentence, the bottle in the Product tile (C3)                                       | "add the water bottle from image 2 next to me" through the real classifier and freeze            |
| product add — the same sentence, the bottle in the Object tile: the same prompt (C3)                         | the prompt byte-identical to the one above; no note                                              |
| product add — worn: her hoops in the Product tile, worn in her ears (C3)                                     | "add these gold hoops to my ears" → "add the gold hoops from Image 2, worn in the person's ears" |
| product add — an Object photo beside her product is the thing; the product keeps its PRODUCT line (C3)       | Object precedence; the ball is Image 3                                                           |
| product add — two product photos: it asks which, and nothing compiles (C3)                                   | decision 4's server half                                                                         |
| product add — two adds beside one product photo: it asks, and nothing compiles (C3)                          | decision 5                                                                                       |
| replace-with-ref — the founder's sentence, her hoops as a PRODUCT: it still asks (C3 is adds only)           | decision 2's scope pin                                                                           |

## Corpus diff — server arm, 36,128 cells ($0; tools/pa/serverDiff.ts)

**Scope.** 4,516 sentences: the 29b2fc8 corpus, the branch's test sentences and Adi's live list. Eight trays. Each cell
goes through real `route`, `freezeEditIntent`, `readNativeIntent`, `plannedInputs` and `previewGeneration` on both
trees. Recolour regions are synthesized from BASE's route.

| tray                                  |   moved | how                                                                                                                |
| ------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------ |
| none                                  |       0 |                                                                                                                    |
| object                                |       0 |                                                                                                                    |
| object + product                      |       0 | the Object photo is placed; the product keeps PRODUCT                                                              |
| two objects                           |       0 |                                                                                                                    |
| **product**                           | **118** | 115 `frozen[add:∅] ⇒ frozen[add:bottle]`; 3 two-add sentences `frozen ⇒ ask ambiguous_object {adds 2, products 1}` |
| **two products**                      | **118** | 115 `frozen ⇒ ask {products 2}`; 3 `⇒ ask {adds 2, products 2}`                                                    |
| **product + brand piece**             | **118** | as product; the brand piece is Image 3 PRODUCT on every frozen cell, both trees                                    |
| **her photo tagged person + product** | **118** | as product; blocked on both                                                                                        |

**Checks, cell by cell (all 0 bad):**

- moved ⇔ the base froze ≥1 add there: **0 mismatches**.
- All **345** placed cells carry the Object line, " from Image 2", the placed note, and no invented note.
- **The consent tray:** every side that froze, on either tree, carries the `refusedOnEdit` blocker (0 without). No
  cell on either tree plans a character slot. The 3 two-add cells are refused before anything compiles on the branch.
- **Origin:** exactly 103 moved per tray come from the 29b2fc8 corpus (recon's count); 15 from the live list and the
  branch's new test sentences.

The different-thing case, by design (decision 1): "add the sneakers next to me" beside a product photo of a bottle is
placed and disclosed. It is not refused.

## Corpus diff — client arm, 1,000,468 cells ($0; tools/pa/clientDiff.ts)

**What was adapted from C2's harness (tools/ca/corpusDiff.ts):**

- **Scripted P2 binds like the server now does:** the Object photo; with none, the one product; else nothing.
- **One new shape:** two products.
- **A harness fix.** C2's harness compared every preview variant with BASE's P1. That was right against a base with
  no reading, and wrong against 29b2fc8, which reads (the first smoke showed P3–P8 "moving" on a plain `you1`). Every
  variant now runs on both trees. C2's own evidence is unaffected: its base did not read.

**Result:**

- I4 (the request builder ≡ base's hook) 1,071,248 / 1,071,248; I3 59,851 / 59,851.
- Twins: I1 38,743, I2 130,121, E1–E4 42,216 each — **0 bad**. Double calls 0. Reading unbalanced 0.
- **148 keys identical (651,798 cells)**, including:
  - every flag-off arm (A0, A1);
  - every tray with no product;
  - every SetupScreen surface;
  - her mark before typing;
  - Edit this, continuation, restore, check-again;
  - **two products in every arm (D5 b)**.

| key                                     |      moved | how                                                                                                                                                                                 |
| --------------------------------------- | ---------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2 you1+product, product+you1           |   160 each | 106 `gen ⇒ edit` (routed adds); 43 `gen ⇒ ask:add_unclear`, 11 `gen ⇒ ask:worn_add_unclear` (auto-mark marks them, as with an Object photo). These 108 are the run's only new asks. |
| A3 you1+product, product+you1 (no read) |   106 each | `gen ⇒ edit` (routed adds)                                                                                                                                                          |
| A3 …@P1E0                               |    54 each | the add asks, now read: `gen ⇒ edit(interp)+seed`                                                                                                                                   |
| A3 …@P2E0                               | 3,527 each | the 54 add asks, plus every sentence already read beside a product whose scripted proposal adds: base `add_unbound ⇒` branch proposal, because the server placed the product        |
| A3 …@P3–P8                              |          0 |                                                                                                                                                                                     |
| A3 …@E1                                 |    54 each | `gen ⇒ edit(interp)`, her tap                                                                                                                                                       |
| A3 …@E2–E4                              |    54 each | `gen ⇒ gen`. **Harness artefact, not a behaviour change:** a mid-read tray change can only happen on the tree that reads. Both plan a new image.                                    |

### Predictions vs the result (tools/pa/predictions-corpus.md, written before either harness existed)

- **Matched: G1–G5, every server-arm transition and tray, and C1–C6 row by row.**
- **One count clause was scoped too narrowly.** "T2 moved ≤ 103" was counted on the 29b2fc8 corpus; the run's corpus
  adds the live list and the branch's test sentences (+15). The rule itself (moved ⇔ base froze an add) holds with 0
  mismatches, and exactly 103 per tray come from the 29b2fc8 corpus.

## Revert checks — 17: 16 exactly as predicted by name, one more red than predicted

**Method.**

- Predictions were written before any check ran (`tools/pa/predictions-revert.md`).
- Each check mutates production lines at `f8e14bc` so the file still compiles, runs the suites with jest directly
  (`--json`), counts reds by name, and restores from HEAD (`tools/pa/rc.py`). Every restore verified clean.
- SERVER = nativeIntent, nativeEdit, compile/golden, preview, routes/studio.native. CLIENT = createAnythingLogic.

| RV    | mutation                                                   | suites |    predicted | red                                                                                                                                                                                                                                                                                                                         |
| ----- | ---------------------------------------------------------- | ------ | -----------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RV-1  | the freeze never places a product                          | SERVER |            7 | **7**                                                                                                                                                                                                                                                                                                                       |
| RV-2  | two products: the first is placed, no ask                  | SERVER |            2 | **2**                                                                                                                                                                                                                                                                                                                       |
| RV-3  | two adds beside a product don't ask                        | SERVER |            2 | **2**                                                                                                                                                                                                                                                                                                                       |
| RV-4  | a product outranks an Object photo                         | SERVER |            3 | **3**                                                                                                                                                                                                                                                                                                                       |
| RV-5  | the spend guard accepts any product the brief carries      | SERVER |            1 | **1**                                                                                                                                                                                                                                                                                                                       |
| RV-6  | the spend guard refuses a product (base)                   | SERVER |            7 | **7**                                                                                                                                                                                                                                                                                                                       |
| RV-7  | `objectImageNumber` finds Object photos only               | SERVER |            6 | **6**                                                                                                                                                                                                                                                                                                                       |
| RV-8  | the placed product keeps its PRODUCT line                  | SERVER |            5 | **5**                                                                                                                                                                                                                                                                                                                       |
| RV-9  | `placedPhoto` lets a replacement read a product            | SERVER | 0 (designed) | **0**: readNativeIntent refuses first                                                                                                                                                                                                                                                                                       |
| RV-10 | no placed-product note                                     | SERVER |            5 | **5**                                                                                                                                                                                                                                                                                                                       |
| RV-11 | the note for ANY placed photo                              | SERVER |           10 | **11**. The 10 predicted, plus `studio.native.test.ts` › "freezes the ball's asset id, and the spend sends frame then ball with the instruction pointing at Image 2": it reads the warnings of an Object-photo add. The prediction named that suite as the uncertain one; the extra red is a second guard on the same line. |
| RV-12 | D5 (b) for any product (base's rule)                       | CLIENT |            2 | **2**                                                                                                                                                                                                                                                                                                                       |
| RV-13 | D5 (b) never holds                                         | CLIENT |            2 | **2**                                                                                                                                                                                                                                                                                                                       |
| RV-14 | add_unbound by the tray (base's rule)                      | CLIENT |            1 | **1**                                                                                                                                                                                                                                                                                                                       |
| RV-15 | add_unbound never                                          | CLIENT |            2 | **2**                                                                                                                                                                                                                                                                                                                       |
| RV-16 | `refusedOnEdit` never fires (consent)                      | SERVER |            2 | **2**: "refuses a person reference on an EDIT…" and the C3 consent pin                                                                                                                                                                                                                                                      |
| RV-17 | a refused person still routes its character slot (consent) | SERVER |            2 | **2**: the same two                                                                                                                                                                                                                                                                                                         |

60 reds; the rows of the predictions file predict 59, and its own total line mis-sums them as 57 (the rows are the record). No check failed to run, and none was invalid.

## Tests

- **Scoped Studio suite** (`server/studio server/routes/studio client/lib client/screens/studio`, jest direct, `--runInBand`):
  - base `29b2fc8`: **81 suites / 2,677 tests / 0 red**;
  - branch `f8e14bc`: **81 / 2,697 / 0**.
  - By name: 0 base passes lost, 22 new (all green). Two base names are gone, and both are the pins inverted on
    purpose: "freezes no object when only a PRODUCT is attached — the role, not the slot, decides" (now "binds her
    lone PRODUCT photo…") and "D5 (b): an add whose thing could only come from a PRODUCT photo is not auto-marked…"
    (now the one-product and two-product tests).
- **Per commit** (nativeIntent, nativeEdit, compile, preview, routes/studio.native, createAnythingLogic), in a
  detached worktree at each SHA:

  | commit                | suites / tests / red     |
  | --------------------- | ------------------------ |
  | `6e3b7a2` PA.1        | 8 / 577 / 0              |
  | `802d1c9` PA.2        | 8 / 586 / 0              |
  | `13ec226` PA.3        | 8 / 587 / 0              |
  | `1364814` PA.4        | 8 / 589 / 0              |
  | `f8e14bc` consent pin | in the branch scoped run |

- **Typecheck:** `check:types` is clean at every commit. The touched test files are clean as ts-jest compiles them
  (types jest+node). `client/lib/logger.ts` and `query-client.ts` ambient errors appear on base alike.
- **Lint** (eslint, per touched file, branch vs `29b2fc8`): identical on all 14. 0 errors; warnings 5/5/7 on the three
  test files, as on base.
- **Format:** every touched file keeps its base prettier state. The server files and goldens are clean.
  `createAnythingLogic.ts`, its test and `use-studio.ts` were unformatted on main and are left so (check:format fails
  on main).

## The probe — STAGED, not run (Adi runs; 4 calls, $0.80 cap)

`tools/pa/probe.ts`: gemini-3-pro-image, native edit, his frame and his product photo.

- **Writes no database row:** it reads two `media_assets` rows under his athlete id and signs their paths. Outputs
  go to `tools/pa/probe-out/`.
- **Dry by default;** `RUN=1` spends. It stops before any call whose quote would pass the cap. No retries.

| cell       | request                                                                                          | question                                |
| ---------- | ------------------------------------------------------------------------------------------------ | --------------------------------------- |
| F1a, F1b   | "make the socks blue", her product on its PRODUCT line, unaddressed                              | F-AM5 / F-PA1: does the product appear? |
| F2-object  | "add the water bottle from image 2 next to me", the product placed on the Object line (as built) | does the output render HER bottle?      |
| F2-product | the same, only the Image 2 line swapped back to the PRODUCT wording                              | decision 3's alternative, once          |

**Dry run, offline** (synthetic 1008×1476 pixels, $0): every prompt is as the goldens say.

- **Reference images cost input tokens.** A native edit with the frame and one product quotes **~$0.196 a call, not the
  ~$0.134** a no-reference image quotes. Budget any 2-reference probe from ~$0.196.
- **The four calls quote $0.7852.** That was over the first $0.75 cap, and the fourth cell (F2-product-line) is the one
  it would have dropped. Adi raised the cap to **$0.80** (2026-09-17): the fourth cell answers F-AM5 and is
  load-bearing.
- A large frame quotes at a bigger size, so read the dry run's quotes before `RUN=1`. The harness still stops before
  any call that would pass the cap.

**⚠️ Choosing the two photographs.** A parallel probe session found (2026-09-17, `docs/probes/framing-identity-stranger.md`
on `studio/probe-framing-identity`, unpushed) that athlete `3811cedd`'s uploaded library holds **at least three
different women**, and that a press photograph with a surname on the bib is where the "model invents a surname" defect
comes from — the text is read off the reference.

- Nothing in C3's evidence is affected: every fixture, golden and corpus cell here is synthetic.
- It matters for THIS probe, whose ids are passed by hand: pick the frame from one consistent cluster, and avoid any
  photograph carrying printed text in either slot. F1 asks whether an unaddressed product appears; a bib in the frame
  would give the model a second thing to copy and muddy the read.

```
cd /Users/adi/nomila-v2-worktrees/product-add-referent && STUDIO_COST_LOG=/Users/adi/nomila-v2-worktrees/tools/pa/probe-out/cost-log.jsonl \
  npx tsx --require dotenv/config /Users/adi/nomila-v2-worktrees/tools/pa/probe.ts \
  --athlete <her athlete uuid> --frame <asset uuid: a photo of her in socks> --product <asset uuid: the water-bottle photo>
# read the quotes, then the same line with RUN=1 in front
```

## Live acceptance (Adi runs)

**Setup:**

- **Client:** this branch, `npx expo start --port 8083` with `EXPO_PUBLIC_STUDIO_SERVER_ROUTING=true` and
  `EXPO_PUBLIC_STUDIO_INTERPRETER=true`.
- **Server:** this branch, with `STUDIO_SERVER_ROUTING`, `STUDIO_INTERPRETER` and `STUDIO_NATIVE_EDIT` on. Check the
  running server's build first (lsof cwd + rev-parse).
- **Stop at the plan card.** Pressing Make on a cell is a real generation (~$0.13).

| #   | tray                       | sentence                                              | predicted                                                                                                                                                                                           |
| --- | -------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | You + Product (the bottle) | add the water bottle from image 2 next to me          | auto-marked; an edit plan; "Your product photo will be used as the water bottle…" on the card; no "invent" line                                                                                     |
| 2   | You + Product (the bottle) | add a water bottle from image 2                       | **Adi's live hit.** Spinner (interpreter read at send), then "Here's what we'll do" with the photo marked and the note, or a new image if the interpreter declines. Never the old D5 (b) new image. |
| 3   | You + Object (the bottle)  | add a water bottle from image 2                       | as #2 without the note: the control                                                                                                                                                                 |
| 4   | You + Product (sneakers)   | add a water bottle next to me                         | an edit plan WITH the note: the different-thing case, disclosed pre-spend                                                                                                                           |
| 5   | You + two Products         | add a water bottle next to me                         | no badge; a new-image plan (D5 b). Tap her photo, re-send: "More than one product photo is attached…"                                                                                               |
| 6   | You + Product              | add a ball on the bench and add a bottle on the grass | auto-marked; the ask "This adds more than one thing, and a product photo is attached…"                                                                                                              |
| 7   | You + Product (hoops)      | change my earrings to these gold hoops                | unchanged from main: the Object-photo ask (replacements are out)                                                                                                                                    |
| 8   | You + Product              | make the socks blue                                   | unchanged from main: an edit; the product rides on its PRODUCT line (F-PA1)                                                                                                                         |

## Re-cut on main `2dc602e` (#497, wave A, merged 2026-09-17)

Wave A merged first, by Adi's call. Main `2dc602e` is merged into this branch as `aedbabe` and **every baseline below
is re-cut on it**. The amendment was written before any re-run (`tools/pa/predictions-recut.md`).

**The merge.** One conflict: docs/probes/sweep-4-ledger.md, where wave A and C3 both appended entries; resolved by
keeping wave A's F-WA block and then C3's F-PA block. No source conflict — wave A's `nativeIntent.ts` hunk is the
`blockedOnAsk` / `blockedBy` log event, C3's is the freeze. Wave A also touched classify.ts (G1 resting places, V1
photo-pointer parity, V2 worn anchors, V4 removal locations, V5 generate compounds, V6 kept lists), keepVocab,
objectVocab, compile/templates.ts and compile/describe.ts.

**Goldens: nothing recaptured.** All 110 fixtures are byte-identical at the merged tip, so wave A's rules moved none
of C3's prompts (G-R1, G-R2 matched). The count guard stays 110.

**The corpus is wider, and every earlier count is superseded rather than corrected.** Wave A's F-WA11 records that the
`ca` builder C3 used is not affected by the template-literal bug, but that it is narrower — double-quoted, single-line
only. The re-cut runs over the union of that corpus and a fixed-regex extractor over both trees
(`tools/pa/buildCorpus2.ts`, all three quote forms, each newline-excluded): **5,315 strings, against 4,499.**

### Server arm — 42,632 cells, 5,329 sentences (digest `a6ef1be7c08b`)

| tray                                        |   moved | how                                                                                         |
| ------------------------------------------- | ------: | ------------------------------------------------------------------------------------------- |
| none, object, object + product, two objects |   **0** | as before                                                                                   |
| product                                     | **166** | 163 `frozen[add:∅] ⇒ frozen[add:product]`; 3 two-add sentences `⇒ ask {adds 2, products 1}` |
| two products                                | **166** | 163 `⇒ ask {products 2}`; 3 `⇒ ask {adds 2, products 2}`                                    |
| product + brand piece                       | **166** | as product; the piece stays Image 3 PRODUCT on every frozen cell, both trees                |
| person-tagged + product                     | **166** | as product; blocked on both                                                                 |

- **Checks, all 0 bad:** moved ⇔ the base froze an add (0 mismatches); all **489** placed cells carry the Object line,
  " from Image 2", the placed note and no invented note; the brand piece is never mistaken for the placed photo.
- **Consent:** 726 frozen cells on the person tray, **0** frozen sides without the `refusedOnEdit` blocker and **0**
  character slots on either tree.
- **Why the count rose from 118 (S-R2, both reasons and only these):**
  - **108 per tray now come from the old 29b2fc8 corpus, against 103** — wave A's G1 routes placements that used to
    refuse. Adi's own "add a water bottle from image 2 onto my head" is one: `person_target` before, an add now, and
    on this branch it binds the product.
  - **58 per tray are new to the wider corpus.**

### Client arm — 1,179,220 cells, 5,315 sentences (digest `563aa46c7f32`)

- **148 keys identical, 770,148 cells** — the same set as the first cut: every flag-off arm, every tray with no
  product, every SetupScreen surface, her mark before typing, Edit this, continuation, restore, check-again, and
  **two products in every arm**.
- I4 1,263,256 / 1,263,256; I3 70,222 / 70,222. Twins I1 45,466, I2 152,582, E1–E4 49,512 each — **0 bad**. Double
  calls 0, reading unbalanced 0.

| key                           |      moved | how                                                                                                                      |
| ----------------------------- | ---------: | ------------------------------------------------------------------------------------------------------------------------ |
| A2 you1+product, product+you1 |   252 each | 156 `gen ⇒ edit`; 69 `gen ⇒ ask:add_unclear`; 27 `gen ⇒ ask:worn_add_unclear`. The 192 asks are the run's only new asks. |
| A3 the same shapes (no read)  |   156 each | `gen ⇒ edit`                                                                                                             |
| A3 …@P1E0                     |    96 each | the add asks, read: `gen ⇒ edit(interp)+seed`                                                                            |
| A3 …@P2E0                     | 4,142 each | those 96, plus every sentence already read beside a product whose scripted proposal adds                                 |
| A3 …@P3–P8                    |          0 |                                                                                                                          |
| A3 …@E1                       |    96 each | her tap                                                                                                                  |
| A3 …@E2–E4                    |    96 each | `gen ⇒ gen`; the harness artefact described above                                                                        |

### Revert checks — re-run in full, and every one is red on the same tests, by name, as the first cut

|                                     |                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| RV-1 to RV-8, RV-10, RV-12 to RV-17 | identical to the first cut (R-R1 matched)                                                           |
| RV-9                                | the designed zero, still zero                                                                       |
| RV-11                               | 11 again — the ten predicted plus `studio.native.test.ts`'s object-add warnings test (R-R2 matched) |
| wave A's new tests                  | joined no mutation's reds (R-R3, the re-cut's least certain prediction, matched)                    |

Every mutation was restored from HEAD and the tree verified clean.

⚠️ **A correction to the first cut's arithmetic.** The reds total **60**, and the rows of
`tools/pa/predictions-revert.md` predict **59** (RV-11's 10 against its 11). That file's own total line says 57 and
mis-sums its rows — the same slip C2's build recorded. The per-check rows are the record, and 16 of 17 matched
exactly by name in both cuts.

### Suites — base `2dc602e` **82 suites / 2,724 tests / 0 red**; branch **82 / 2,744 / 0**

- By name: **0 base passes lost**, 22 new (all green), and the same two renamed pins.
- Targeted suites at the merged tip before anything else: 8 suites / 601 tests / 0 red, goldens included.
- **T-R1 was off, and here is why:** it predicted 83 / 2,730 by quoting wave A's own number at `fdec709`. Wave A's
  scoped path set also includes `client/components/studio/referencePack.test.ts`; over C3's four paths the same tree is
  82 / 2,724. The substance of T-R2 (0 lost, 22 new) holds.
- `check:types` clean. Lint and format per touched file identical to the new base.

### Main moved again: `3558df5` (#496), docs only — merged, nothing re-cut

`3558df5` is a single commit changing one file,
`docs/architecture/commercial-intelligence/rate-v0-design.md` (the Annual Brand Partnership terms basis). It is merged
in as `0d1303e`.

**Nothing was re-run, and that is the claim, not an omission:** between `2dc602e` and `3558df5` the count of changed
files outside `docs/architecture/` is **zero**. Every input the baselines above read — server/studio, server/routes,
client, the compile goldens, the test files the corpus is extracted from — is byte-identical across the two, so the
re-cut on `2dc602e` IS the re-cut on `3558df5`. The targeted suites were re-run at the merged tip as a sanity check.

The push helper's BASE moves to `3558df5` so it keeps refusing on any main that moves for a reason this argument does
not cover.

## What is NOT measured here

- **Whether the model renders the placed product** (F2) and **whether it inserts an unaddressed one** (F1). That is
  the probe.
- **The screen:** the badge on a You + Product tray, the note on the card, phone-width Chrome and the iOS Simulator.
- **A product shot with a person in it** (F-PA5).

## Follow-ups

|     | card                                                                  | why                |
| --- | --------------------------------------------------------------------- | ------------------ |
| —   | Replacements pointed at a Product photo                               | F-PA2 (decision 2) |
| —   | (b): bind on a pointer, behind wave A's V1                            | F-PA3              |
| —   | Unaddressed products on native edits, after the probe                 | F-PA1              |
| —   | Copy review: the note and the two ask lines                           | F-PA4              |
| —   | Person in a product shot, in the weak-ref-detection card's scope note | F-PA5              |
