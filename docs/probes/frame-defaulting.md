# Frame defaulting — the evidence ($0)

Branch `studio/frame-defaulting`. Commits F.1–F.4 were built on main `69ea5d4`, then main `374cc3a` was merged in
after R0.b (#484) landed. **Every baseline below was re-cut on `374cc3a`.** The first run against `69ea5d4` is kept
only where it is the record of a prediction.

## The defect

Confirmed live three times on R1's pack acceptance (`docs/probes/reference-packs.md`, the tray blocker section).
With photos of her in the tray, a new image could not be asked for. The client did three things, and the server
had no say in any of them:

1. `nextFrameAssetId` marked her first photo the moment it was attached. Removing the marked photo handed the mark
   to the next one, so × moved the EDITING badge instead of clearing it.
2. The plan hook told `/studio/classify` `hasSourcePhoto: true` whenever ANY photo of hers was attached.
3. `frameFor`'s null-mark fallback picked the first photo anyway.

`route("generate pic of me playing soccer", true)` is `ASK fast_path_declined`; with `false` it is `GENERATE`.

## What was decided (Adi, 2026-09-16)

| | decision |
|---|---|
| D1 | **B — ask first.** A marked photo beside other photos of her asks "edit the marked one, or a new image from all of them" when she sends. It folds in the "which one am I working on?" card. New client ask code `frame_with_likeness`, stored and rendered in thread history. Copy is placeholder. |
| D2 | An unmarked photo is her likeness, never a frame. "make the socks blue" with an unmarked photo is now a new image. Accepted as written. `routes/studio.ts`'s classify comment was fixed (comment only). |
| D3 | SetupScreen passes its first photo of hers explicitly, so it routes exactly as before. |
| D4 | The badge is shown wherever a photo is marked, one photo or several. A tap marks it, a second tap clears it, and × still removes the photo. |
| D5 | Check again and "Not what I meant" replay the frame exactly as sent. Pre-fix threads replay with their defaulted frame. |

## Corpus diff — 368,730 cells

`tools/fd/corpusDiff.ts` (untracked, in the tools dir beside the worktree). It runs one process over both trees:
`fd-base-374cc3a` and the branch at `9372d49`.

- **Sentences:** 4,097. That is every quoted string in the Studio test files at `374cc3a` (4,094), plus the
  acceptance sentence and two relatives.
- **Trays:** 21 action sequences (attach / tap / remove / Edit this / continuation), replayed through each tree's
  own functions.
- **Arms:** routing off, routing on, routing + interpreter.
- **Surfaces:** Create anything, plus SetupScreen for the nine shapes it can build.
- **Per cell:** the mark, whether a frame ask fires, and for each resulting job:
  - `hasSourcePhoto`
  - the classifier's answer
  - intent
  - `sourceAssetId`
  - references
  - the ask reason
  - the server's verdict from `plannedInputs` (the up-to-3 cap, `refusedOnEdit`)

⚠️ **The one replica.** The SCREEN's handlers and the HOOK's composition cannot be called without a renderer, so
the harness replicates them, reading them off each tree. Everything they call is the real function. The
consequence is that a mutation of the hook itself is invisible to the harness (see RV-4).

**Results at `374cc3a`:** 57 of 90 surface × arm × tray keys are byte-identical in every cell.

| tray | routing off | routing on | routing + interpreter |
|---|---|---|---|
| empty, product, object | identical | identical | identical |
| **every SetupScreen tray** | identical | identical | identical |
| a photo she tapped (alone, + product, + object); tapped then removed | identical | identical | identical |
| Edit this; Edit this + product; continuation | identical | identical | identical |
| 1, 3 or 4 untapped photos (and + product / + object, removed-first, tapped twice) | every edit becomes gen; 3,432 of 4,097 identical on the wire | every edit and every ask becomes gen; 24 identical on the wire | every edit, interpreted edit and ask becomes gen; 24 identical on the wire |
| a tapped photo beside other photos of her (3 + tap one; Edit this + a library photo) | frame ask, every cell | frame ask, every cell | frame ask, every cell |

"On the wire" means what reaches the server: intent, frame, references, ask and verdict. It leaves out the tray's
mark and the job's stored `frameAssetId`.

**The acceptance sentence**, "generate pic of me playing soccer", routing on:

- **4 untapped photos:** base `ASK fast_path_declined` → branch `image.generate`, 4 people, blocked with
  *"4 photos of you — a piece can be built from up to 3. Remove one and check again."*
- **3 untapped photos:** base `ASK fast_path_declined` → branch `image.generate`, 3 people, verdict `[]` (priced).
- **3 photos, interpreter on:** base went to the preview as an interpreted edit and hit `refusedOnEdit` → branch
  `image.generate`, verdict `[]`.
- **3 photos, one tapped:** the frame ask.
  - EDIT sends the tapped photo alone (this sentence then asks `fast_path_declined`, since it names no edit).
  - NEW is a new image from all three, verdict `[]`.

### Predictions vs the result (`tools/fd/predictions-corpus.md`, written before the first run)

- **Matched:**
  - every byte-identical shape, including every SetupScreen tray;
  - every class transition (edit → gen, ask → gen, interpreted edit → gen, 4 photos → the cap, the frame ask on
    every cell of the two mixed trays);
  - "< 5% of asks stay asks" (0 did);
  - all four focus-sentence cells.
- **MISSED, and why:** routing off, untapped photos. I predicted "every base gen cell identical". Every one moved,
  because the harness also records the tray's mark and the job's stored frame. Base carried
  `frameAssetId = the first photo` on a generate, and the branch carries `null`, which is exactly the fix. A
  wire-level count was added AFTER that first run. It shows 3,409 / 3,409 of those cells identical in what reaches
  the server, the prediction's actual claim (3,432 / 3,432 on the re-cut corpus).
- **Re-cut:** the same diff against `374cc3a` changes no key's outcome (0 of 90). 25 more sentences come from R0.b's
  test files.

## Revert checks — 10 run, 9 exactly as predicted

Predictions are in `tools/fd/predictions-revert.md`, written before any check ran. F.4's were appended after F.4
and before any run. Each check mutates one production line, runs the four client suites with `jest --json`, and
restores from HEAD. All 10 ran twice, at `5d1567c` and after the merge at `9372d49`, with identical red lists.

| | mutation | predicted | red |
|---|---|---|---|
| RV-1 | `nextFrameAssetId` defaults again | 5 | **5** — the names predicted |
| RV-2 | `routeMarked` routes over the whole tray | 4 | **4** |
| RV-3 | `markedFrame` falls back to the first photo | 6 | **8** — the 6 predicted, plus 2 of F.4's `frameChoice` tests. They use `markedFrame` and did not exist when this prediction was written at F.1. |
| RV-4 | the hook asks classify with any photo again | 0 in jest; "the corpus diff shows it" | **not run.** The prediction was wrong about its own instrument: the harness replicates the hook, so it cannot see a hook mutation. It is a DESIGNED ZERO, carried by acceptance. |
| RV-5 | a tap cannot clear the badge | 1 | **1** |
| RV-6 | Check again re-defaults | 1 | **1**; the pre-fix replay test held |
| RV-7 | "Not what I meant" re-defaults | 1 | **1** |
| RV-8 | the frame ask never fires | 2 | **2** |
| RV-9 | EDIT keeps her other photos | 2 | **2** |
| RV-10 | NEW keeps the frame | 1 | **1** |
| RV-11 | the ask code loses its sentence | 2 | **2** |

**Also a designed zero:** the screen's wiring. That covers `make()` routing through `askFrame`, the sheet and the
flag-off push taking the answer's frame exactly (null included), and the badge rendering. No renderer test exists
here, so Adi's acceptance carries these.

## Tests

- **Scoped Studio suite** (`server/studio server/routes/studio client/lib client/screens/studio`, jest direct,
  `--runInBand`):
  - **base `374cc3a`:** 77 suites / 2,475 tests / 1 red;
  - **branch `9372d49`:** 77 / 2,498 / 1.
  - **The one red is the same on both sides:** `composite.test.ts › changes NOTHING outside when the model returns
    the crop untouched`, main's known pixel-diff red.
  - **Test by test:** 0 tests pass on base and fail on the branch, and 23 new tests all pass. 3 base tests are
    renamed on purpose. They are the `nextFrameAssetId` tests whose answer changed, each title now saying what it
    used to answer.
  - No hook-timeout red appeared, so nothing needed a rerun. The base run was uncontended (the R0.b session had
    exited). The earlier `69ea5d4` base run overlapped that session's revert checks and is not used.
- **Goldens:** `compile/golden.test.ts` 98/98 on both sides; no golden file and no `server/studio` file is in the
  diff.
- **Per commit:** every commit typechecks on its own. The four client suites pass at each one: 230 / 234 / 237 /
  246 tests at F.1 / F.2 / F.3 / F.4.

## What is NOT measured here

- **The screen on a device.** Badge, tap, the ask card and its three buttons, and history after a reload are all
  Adi's acceptance, on the iOS Simulator and phone-width Chrome.
- **"Edit the marked photo" with a sentence that routes GENERATE.** It sends the marked photo alone and the
  classifier still decides, so it can price a new image from that one photo. The button says "Edit"; the priced
  card says what it is. It is recorded rather than changed, because the sentence deciding edit-or-generate for a
  marked photo is D2 as written.
- **The copy.** Every new string is placeholder, for the copy-review pile: the ask's question, "Edit the marked
  photo", "Make a new image from all of them", "Never mind", and "Or tap a photo in the tray to change which one is
  marked."
