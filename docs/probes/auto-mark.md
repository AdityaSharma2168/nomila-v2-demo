# Auto-mark — the evidence

Branch `studio/auto-mark`. The build ran against a moving main:

- AM.1–AM.2 were built on main `8603f24` (#486, frame defaulting).
- Main `5a21a11` (#487, wave-1 fixes) was merged in (`ab21516`), and AM.3–AM.4 were built on it.
- Main `e7580f1` (#488, preservation fixes) was merged in (`1df3c7f`), with a follow-up for what it met (`8e2b528`).

**Every baseline below is cut on `e7580f1`.** The first corpus run, against `5a21a11`, is kept where it is the
record of a prediction.

## The regression

#486 made a photo of hers the frame only when she marks it. That was right for her pack, and it regressed the flow
most sends are: ONE photo and an edit-shaped sentence ("make the socks blue", "remove the soccer ball") planned a
new image unless she tapped the photo first.

**Recon, $0.** `route(sentence, false)` answers GENERATE for EVERY sentence, so the edit/generate shape can only be
read as `route(sentence, true)`. Only the classifier reads that, so the client reaches it through
`POST /studio/classify`.

## What was decided (Adi, 2026-09-16)

|     | decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **S2.** Edit-shaped means a routed edit path, or an ask whose code names an edit: brand_change, brand_removal, compound_partial, compound_conflict, conditional, add_unclear, worn_add_unclear, object_photo_missing, too_many_changes, headline_bounds, look_unknown — and, since #488, keep_conflict (placed beside compound_conflict when #488 was merged in; **for Adi to confirm**). **Never the catch-all** `fast_path_declined`, which holds both "take the logo off my sleeve" and "generate pic of me playing soccer". The edit-shaped ones there are ledgered as classifier vocabulary (F-AM1), not stretched into. |
| D2  | **Live badge.** The composer asks the classifier about her words once she pauses. At send it RE-ASKS on the exact sentence sent. Partial sentences stay out of the classifier's log (AM.1).                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D3  | A tap on the badge (hers or auto-mark's) takes it off and switches auto-mark off until the tray empties or another photo of hers is attached. "Not what I meant" on a no-frame plan gives the tray back switched off. Pinned: untap, then an immediate send, plans a new image.                                                                                                                                                                                                                                                                                                                                               |
| D4  | Two or more photos of her, none marked, edit-shaped words: the `frame_pick` ask, never a silent pick. Placeholder copy, for the review pile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D5  | **(b).** An add whose thing could only come from a PRODUCT photo is not auto-marked. An edit's add binds only an Object photo (`nativeIntent.ts`), so the product would travel beside an invented thing. Binding a lone product is follow-up card C3.                                                                                                                                                                                                                                                                                                                                                                         |
| —   | **The catch-all through the interpreter is OUT of this PR**, gated on the scene-sentence probe below. It is follow-up card C2, stacked behind C1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## The commits

|          | commit    | what                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AM.1     | `4ffbbb8` | `POST /studio/classify` takes `purpose: "draft" \| "shape"`. A draft call writes no classifier log line; a shape call's lines are tagged. The answer never depends on it.                                                                                                                                                                                                                      |
| AM.2     | `3f7b74f` | `editShaped`, `autoFrame`, `productAddUnbound`, `tapBadge`, `autoOffAfterAttach` and `resolveSend`. The composer's live badge. `make` resolves the screen's tray through `resolveSend`.                                                                                                                                                                                                        |
| —        | `ab21516` | merge main `5a21a11` (#487)                                                                                                                                                                                                                                                                                                                                                                    |
| AM.3     | `a1dcf7a` | `frame_pick`: the ask, its sentence, and its card. "Edit the marked photo" appears once she taps one.                                                                                                                                                                                                                                                                                          |
| AM.4     | `5e27f82` | `autoOffAfterReject`, plus pins that Check again and "Not what I meant" replay exactly. `checkAgainJob` and `composerAfterReject` are untouched.                                                                                                                                                                                                                                               |
| AM.3 fu  | `87f49cb` | **AM.3 broke the test file's COMPILE.** `SendResolution` became a union, and AM.2's pins read `.frameAssetId` unnarrowed. `check:types` excludes `*.test.ts`, so only ts-jest saw it: `createAnythingLogic.test.ts` failed to run at `a1dcf7a` and `5e27f82`. `frameOf` narrows. It is a separate commit because history rewrites (`rebase`, `reset --soft`) are permission-denied for Claude. |
| —        | `1df3c7f` | merge main `e7580f1` (#488)                                                                                                                                                                                                                                                                                                                                                                    |
| merge fu | `8e2b528` | #488 met auto-mark in three places. Its new `keep_conflict` log line bypassed `note` (a draft call would have logged it). The code needed placing. F-L5 now routes "…dont change my face", so those sentences are edit-shaped.                                                                                                                                                                 |
| AM.5     | —         | This document, and the ledger entries F-AM1–F-AM7 (`docs/probes/sweep-4-ledger.md`).                                                                                                                                                                                                                                                                                                           |

Nothing in `use-studio-pending.ts`, `threadLogic.ts`, SetupScreen, the preview route, the freeze or the compile tier changed.

## Scene-sentence probe — the interpreter extension's gate ($0.0305 estimated)

**Setup:** twelve generate-shaped sentences, each sent twice through the product transport: interpret/4,
gemini-3.5-flash, thinking 0, R1's menu, Adi's Q1 frame. Script: `tools/am/sceneProbe.ts`, dry by default, hard cap
$0.035. The replies are in `tools/am/out/scene-probe.json`. A PROPOSAL is a misread: auto-marked, it would become an
edit of her photo.

**Result:** 24 calls, 0 errors. Latency 1,246–3,115 ms (p50 ≈ 1.6 s). About 3,280 tokens in and 53–188 out per call.

| sentence                                     | run 1                                                       | run 2               |
| -------------------------------------------- | ----------------------------------------------------------- | ------------------- |
| me on a beach                                | **PROPOSAL** "change the background to the beach"           | **PROPOSAL** (same) |
| make me look like im at the beach            | **PROPOSAL** "change the background to the beach"           | **PROPOSAL** (same) |
| picture of me running on a track at sunset   | **PROPOSAL** "change the background to the track at sunset" | **PROPOSAL** (same) |
| make a pic of me training in the gym         | **PROPOSAL** "change the background to the gym"             | **PROPOSAL** (same) |
| generate pic of me playing soccer            | ask (uncovered)                                             | ask (uncovered)     |
| a photo of me celebrating a goal in the rain | ask (uncovered)                                             | ask (uncovered)     |
| me holding a trophy on stage                 | ask (invalid_slot)                                          | ask (invalid_slot)  |
| put me mid-air dunking                       | declined                                                    | declined            |
| me dunking in a stadium                      | declined                                                    | declined            |
| me doing a bicycle kick in a packed stadium  | declined                                                    | declined            |
| me scoring a header in a cup final           | declined                                                    | declined            |
| a shot of me stretching before practice      | declined                                                    | declined            |

**Conclusion:** 4 of 12 sentences misread, stable across both runs, every one as a `background` edit, the menu item
with no "this is a new image" exit. Per Adi's rule the extension is out, stacked behind a prompt fix (C1). Two more
scene sentences never reach the interpreter, because the RULES route them (F-AM3).

## Corpus diff — 468,180 cells ($0), re-cut on `e7580f1`

**Harness.** `tools/am/corpusDiff.ts` runs one process over `am-base-e7580f1` and the branch at `8e2b528`. The first run (`am-base-5a21a11` vs `5e27f82`, 456,732 cells) is described under Predictions.

- **Sentences:** 4,335. That is every quoted string in both trees' Studio test files, plus the 17 focus sentences.
- **Arms:** routing off, routing on, routing + interpreter.
- **Trays:** 27 action sequences:
  - attach;
  - tap BEFORE typing (auto-mark badges nothing) and tap AFTER typing (the badge follows her words);
  - remove, Edit this, continuation;
  - "Not what I meant" with and without a frame, then re-send;
  - Check again with and without a frame;
  - a VIDEO "You" beside a photo;
  - a photo still uploading beside one.
- **Surfaces:** Create anything, plus SetupScreen.
- **Per cell:** the frame ask, and each job's classify inputs, intent, `sourceAssetId`, references, ask reason and
  `plannedInputs` verdict.
- **Real vs replicated.** The branch's send runs the real `resolveSend`. The screen's handlers and the hook are
  replicas (the hook is untouched on the branch).
- **The invariant.** For every moved cell with one plausible canvas, the harness checks that the branch's plans
  equal BASE's plans for the same tray with that photo tapped. Auto-mark ≡ her tap.

**Results (summary digest `9030522f309e`).**

- **Identical in every arm and every sentence** (78 of 108 surface × arm × tray keys; the twin invariant held on all 14,942 cells it checked):
  - every SetupScreen tray;
  - empty / product / object;
  - a photo she tapped before typing (alone, + product, + object, tapped twice, tapped then removed);
  - a marked photo beside two others (F.4's ask);
  - Edit this (alone, + product, + a photo of hers);
  - continuation;
  - **"Not what I meant" with and without a frame, then re-send**;
  - **Check again with and without a frame**.

- **Moved** (routing on unless said):

| tray                               | moved       | how                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| one photo (you1, you2+removeFirst) | 926 / 4,335 | 644 `gen ⇒ edit`; 282 `gen ⇒ ask:<edit code>` (150 brand_change, 40 add_unclear, 32 object_photo_missing, 14 conditional, 11 worn_add_unclear, 9 compound_partial, 9 keep_conflict, 8 compound_conflict, 6 look_unknown, 2 brand_removal, 1 too_many_changes). **Twin invariant 926 / 926.** |
| one photo, routing + interpreter   | 926         | as above, with the 226 interpretable asks as `gen ⇒ edit(interp)`. keep_conflict stays an ask. Twin 926 / 926.                                                                                                                                                                               |
| one photo, routing off             | 741         | `gen ⇒ edit`, the verb list. Twin 741 / 741.                                                                                                                                                                                                                                                 |
| you1 + product, product + you1     | 772         | 926 − 154 adds (103 routed, 40 add_unclear, 11 worn_add_unclear) — **D5 (b)**. Twin 772 / 772.                                                                                                                                                                                               |
| you1 + object                      | 926         | 676 `gen ⇒ edit`: the 32 "these gold hoops" now route. Twin 926 / 926.                                                                                                                                                                                                                       |
| you1, tap after typing             | 926         | the exact inverse: the tap takes auto-mark's badge off, `<base marked plan> ⇒ gen`.                                                                                                                                                                                                          |
| you3, you4, you1 + uploading       | 926         | `gen ⇒ ASK:frame_pick→edit:<the marked plan>\|new:gen`. you4's `new:` keeps the up-to-3 refusal.                                                                                                                                                                                             |
| video + you1                       | 926         | `gen ⇒ ASK:frame_with_likeness→…` (F-AM7). Twin 926 / 926.                                                                                                                                                                                                                                   |

**Focus sentences, one photo:**

| sentence                                                                   | routing on               | + product                | + object        | + interpreter            | routing off      | 3 photos   |
| -------------------------------------------------------------------------- | ------------------------ | ------------------------ | --------------- | ------------------------ | ---------------- | ---------- |
| make the socks blue                                                        | edit                     | edit                     | edit            | edit                     | =gen             | frame_pick |
| remove the soccer ball                                                     | edit                     | edit                     | edit            | edit                     | edit             | frame_pick |
| remove the watermark                                                       | edit                     | edit                     | edit            | edit                     | edit             | frame_pick |
| put me on a rooftop at dusk                                                | edit                     | edit                     | edit            | edit                     | =gen             | frame_pick |
| change my jersey to adidas                                                 | edit                     | edit                     | edit            | edit                     | edit             | frame_pick |
| change my earrings to these gold hoops                                     | ask:object_photo_missing | ask:object_photo_missing | edit            | ask:object_photo_missing | edit             | frame_pick |
| add this bottle next to me                                                 | edit                     | **=gen (D5 b)**          | edit            | edit                     | =gen             | frame_pick |
| generate pic of me playing soccer                                          | =gen                     | =gen                     | =gen            | =gen                     | =gen             | =gen       |
| take the logo off my sleeve                                                | =gen                     | =gen                     | =gen            | =gen                     | edit (verb list) | =gen       |
| make the sky moodier                                                       | =gen                     | =gen                     | =gen            | =gen                     | =gen             | =gen       |
| me on a beach                                                              | =gen                     | =gen                     | =gen            | =gen                     | =gen             | =gen       |
| put me mid-air dunking                                                     | ask:add_unclear          | =gen                     | ask:add_unclear | edit(interp)             | =gen             | frame_pick |
| add a water bottle from image 2 onto my head                               | =gen                     | =gen                     | =gen            | =gen                     | =gen             | =gen       |
| create an adidas ad featuring me, remove any nike logos                    | =gen                     | =gen                     | =gen            | =gen                     | edit (verb list) | =gen       |
| generate a pic of me playing soccer and change the background to a stadium | edit                     | edit                     | edit            | edit                     | edit             | frame_pick |
| put me in a stadium at night celebrating                                   | edit                     | edit                     | edit            | edit                     | =gen             | frame_pick |
| me walking the red carpet at an awards show                                | edit                     | edit                     | edit            | edit                     | =gen             | frame_pick |

(`=` means identical to base.)

### Predictions vs the result (`tools/am/predictions-corpus.md`)

**First run** (base `5a21a11`, branch `5e27f82`, 456,732 cells, 4,229 sentences, digest `615e24a9d45a`; predictions written before the harness existed):

- **Matched:**
  - the same 78 identical keys;
  - every class transition, and which codes move per arm;
  - D5 (b) as the only you1 + product difference;
  - the tap-after inverse;
  - frame_pick on 3, 4 and 1 + uploading;
  - every focus row;
  - twin 13,998 / 13,998.
- **MISSED: video + you1.** I predicted "as you1, marking the photo". Auto-mark DOES mark the photo and never the
  video, but F.4's `frameChoiceNeeded` counts the video as another photo of her, so the send asks
  `frame_with_likeness`. That is what base does when she taps the photo herself (twin-identical). It is
  pre-existing F.4 behaviour, ledgered as F-AM7, not changed here.

**Re-cut on `e7580f1`** (amendment written before it ran):

- **Matched:**
  - the identical-key set is exactly the first run's;
  - the moved one-photo keys grew only by #488's newly edit-shaped sentences: F-L5's keeps route (`gen ⇒ edit`), and thing-keep conflicts ask `keep_conflict`;
  - routing off grew only by sentences #488's test files added;
  - all 1,836 focus cells are identical to the first run's;
  - twin 14,942 / 14,942.

## Revert checks — 16, every one as predicted by name

**Method.** Predictions were written before any check ran (`tools/am/predictions-revert.md`), and amended after the
`e7580f1` merge, still before any run. Each check mutates production lines on `8e2b528`, runs the suites with `jest
--json`, counts reds by name, and restores from HEAD (`tools/am/rc.py`).

|       | mutation                                                               | predicted | red                                                                                                                                                                                                                                            |
| ----- | ---------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RV-1  | the catch-all counts as edit-shaped                                    | 4         | **4**                                                                                                                                                                                                                                          |
| RV-2  | routing on ORs the verb list                                           | 6         | **6**                                                                                                                                                                                                                                          |
| RV-3  | no answer falls back to the verb list                                  | 2         | **2**                                                                                                                                                                                                                                          |
| RV-4  | `productAddUnbound` always false (D5 b)                                | 1         | **1**                                                                                                                                                                                                                                          |
| RV-5  | a video counts as a canvas                                             | 2         | **2**                                                                                                                                                                                                                                          |
| RV-6  | `autoFrame` ignores autoOff                                            | 2         | **2**                                                                                                                                                                                                                                          |
| RV-7  | a tap on the badge does not switch auto-mark off                       | 4         | **4**                                                                                                                                                                                                                                          |
| RV-8  | `resolveSend` never re-reads her tray after the answer                 | 3         | **3**                                                                                                                                                                                                                                          |
| RV-9  | the Object-photo count is not compared                                 | 1         | **1**                                                                                                                                                                                                                                          |
| RV-10 | send asks about a stale draft, not the exact sentence (**the D2 pin**) | 6         | **6**                                                                                                                                                                                                                                          |
| RV-11 | no frame_pick                                                          | 3         | **3**                                                                                                                                                                                                                                          |
| RV-12 | `autoOffAfterReject` always false                                      | 2         | **2**, on the second attempt. The first mutation did not compile (TS narrowed `refused` to `never`), so both suites FAILED TO RUN. That was counted as invalid, not a pass, and re-run with a mutation that compiles and means the same thing. |
| RV-13 | `autoOffAfterAttach` never turns auto-mark back on                     | 2         | **2**                                                                                                                                                                                                                                          |
| RV-14 | a draft classify call is logged (AM.1)                                 | 4         | **4**                                                                                                                                                                                                                                          |
| RV-15 | a shape call is logged untagged                                        | 4         | **4**                                                                                                                                                                                                                                          |
| RV-16 | the route accepts any purpose                                          | 1         | **1**                                                                                                                                                                                                                                          |

**Designed zero:** the screen's wiring (the draft classify, `latest`, `make` → `resolveSend`, `rejectedIn`'s switch,
the card rows). No renderer test exists, and the corpus harness replicates the screen. That is device acceptance.

## Tests

- **Scoped Studio suite** (`server/studio server/routes/studio client/lib client/screens/studio`, jest direct, `--runInBand`):
  - **base `e7580f1`:** 77 suites / 2,524 tests / 0 red;
  - **branch `8e2b528`:** 78 / 2,582 / 0;
  - **test by test:** 0 base passes lost, 0 base tests removed or renamed, 58 new tests, all green;
  - the composite red earlier builds carried is gone on main since #487.
- **The run that found the AM.3 compile break** (branch `5e27f82` against base `5a21a11`): 78 suites, one FAILED TO
  RUN (`createAnythingLogic.test.ts`), and its 45 base tests missing by name. Fixed in `87f49cb`.
- **Per commit** (createAnythingLogic, studio-contract, threadLogic, classifyPurpose):

| commit          | tests | red                                                                                                                            |
| --------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| `4ffbbb8` AM.1  | 246   | 0                                                                                                                              |
| `3f7b74f` AM.2  | 274   | 0                                                                                                                              |
| `ab21516` merge | 274   | 0                                                                                                                              |
| `a1dcf7a` AM.3  | 201   | **createAnythingLogic.test.ts failed to run**                                                                                  |
| `5e27f82` AM.4  | 201   | **the same**                                                                                                                   |
| `87f49cb` fu    | 287   | 0                                                                                                                              |
| `1df3c7f` merge | 288   | **2**: the every-code pin (keep_conflict unplaced) and the refusal pin (F-L5 routes it). Both expected and fixed in `8e2b528`. |
| `8e2b528`       | 292   | 0                                                                                                                              |

- **Typecheck:** `check:types` is clean at every commit. The touched test files are clean as ts-jest compiles them (`tools/am/tsc-tests.sh`). `client/lib/logger.ts` and `query-client.ts` ambient-type errors appear on base alike.
- **Lint** (`expo lint`): base 1,807 problems / 73 errors, branch 1,808 / 73. The +1 is an `import/first` warning in the new `classifyPurpose.test.ts`, the logger-mock pattern every such suite carries.
- **Format:** every touched `.ts`/`.tsx` file has the same prettier state as on base. `classify.ts`, `studio.classify.test.ts` and the new `classifyPurpose.test.ts` are clean.
- **Goldens:** no compile-tier or golden file is in the diff. `compile/golden.test.ts` passes inside the scoped suite on both sides.

## Follow-up cards

|     | card                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | why                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| C1  | **Server: an interpreter-prompt "this is a new image" exit.** A rule and a decline for a request describing a new photo of her, a PROMPT_VERSION bump, and an R1 re-record. Acceptance: the four probe misreads decline or ask; "take the logo off my sleeve" and "make the sky moodier" still propose edits.                                                                                                                                                                                                                                                                           | The scene probe: 4/12 read as background edits. |
| C2  | **Client: the catch-all through the interpreter** (stacked behind C1). One photo + `fast_path_declined` + interpretable + STUDIO_INTERPRETER → the send runs the marked-edit preview once. A ready proposal auto-marks and passes the preview through (build-once, no persistence). Every other outcome falls back to a new image, never a refusal. Design and fallback table: `tools/am/recon-interpreter.md`. Acceptance: "take the logo off my sleeve", "make the sky moodier" → edit proposals; "generate pic of me playing soccer" → new image; the four C1 sentences → new image. | D1's catch-all gap.                             |
| C3  | **Server: a lone Product photo binds as the added object** when no Object photo is attached (D5 c). Moves the goldens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | D5 (b) leaves You + Product adds as new images. |
| C4  | **Client: interpreter fallback for EVERY auto-marked ask** — an interpreter ask on an auto-marked S2 ask falls back to a new image. Acceptance includes "put me mid-air dunking" (add_unclear → marked → an ask today).                                                                                                                                                                                                                                                                                                                                                                 | F-AM2.                                          |

## What is NOT measured here

- **The screen on a device:**
  - the badge appearing and leaving as she types;
  - a tap on it;
  - the send's pause while it re-asks;
  - the frame_pick card and its rows;
  - history after a reload.

  That is Adi's acceptance, on the iOS Simulator and phone-width Chrome.

- **The screen wiring as code:** the draft classify, `latest`, `make` → `resolveSend`, `rejectedIn`'s auto-mark
  switch and the card rows. No renderer test exists; these are designed zeros for both jest and the harness.
