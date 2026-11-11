# The catch-all through the interpreter (C2) — the evidence

Branch `studio/catch-all-interpret`, off main `5385e57`: #489 auto-mark and #490, the interpreter's new-image exit
(interpret/5). The sections below were cut on `5385e57`. **After #491 merged, every baseline was re-cut on
`7fafeed`, and each came back as predicted** (see "Re-cut on main `7fafeed`").

## Re-cut on main `7fafeed` (#491, wave-3 fixes, merged 2026-09-17)

#491 landed after the `5385e57` base. It is server-only: generate, interpret/core and its recorded pins,
qa/{embed, face, identity, inspect, verdict, vision}, and docs. It merged cleanly as `62b37c3`; its ledger edit is
inside F-I5.

Every baseline was re-cut on `7fafeed`. The amendments were written before anything ran
(`tools/ca/predictions-corpus.md`, `predictions-revert.md`).

- **Corpus, R1** — the first run's corpus over the new trees (`ca-base-7fafeed` vs `62b37c3`). Predicted
  byte-identical. **Identical: digest `27cd34e55399`, 895,404 cells, and every line of the report.**
- **Corpus, R2** — the corpus rebuilt from both new trees: 4,466 strings, 43 added and 3 changed by #491's tests.
  Predicted: no new key, no new kind of move, flag-off still 0.
  - **Matched:** 903,864 cells, digest `3154ac03ad0a`.
  - Keys 224 → 224, 0 new kinds of move.
  - A0–A2 and setup: 0 moved, 0 calls.
  - I1 27,878, I2 111,194, E1–E4 34,768 each, all 0 bad.
  - I3 45,262 / 45,262, I4 970,608 / 970,608, 0 new asks.
  - All 2,745 focus rows identical to the first run.
  - One photo: 3,498 reads (3,267 catch-alls + 231 S2); beside a product, 3,445.
- **Scoped suite** (jest direct, `--runInBand`):
  - base `7fafeed` 81 suites / 2,659 / 0 red / 0 failed to run;
  - branch `62b37c3` 81 / 2,677 / 0 / 0;
  - by name: 0 lost, 0 removed, the same 18 new, all green.
- **Revert checks:** all 18 re-run on `62b37c3`, 0 failed to run, the tree clean after each. **Every one red on exactly
  the same tests by name as on `5385e57`** (18 / 18; RV-3 still 1, the builder's second guard), as the amendment
  predicted.
- **Typecheck and lint:** `check:types` is clean at `62b37c3`. `expo lint`: base `7fafeed` 1,812 problems (73 errors),
  branch 1,811 (73) — the same one warning gone.
- **What #491 means for C2's acceptance:** its core change only drops a refused suggestion BESIDE AN AD, alone. No C2
  acceptance sentence is an ad, so its predictions stand.

## The dead ends

These were hit live on 2026-09-16, each with one photo of hers attached:

- "make me hold the gatorade bottle from image 2"
- "put the gatorade bottle in my hand"
- "add in hoops from the second picture"
- "take the logo off my sleeve"

**Recon ($0, `tools/ca/route0.ts`, `route(s, true)`):** these are two kinds of ask, not one.

| sentence                                      | objects 0 / 1                       | what happened before C2                                                   |
| --------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| make me hold the gatorade bottle from image 2 | `fast_path_declined`, interpretable | never auto-marked (D1): a new image, or an ask once she marked it         |
| take the logo off my sleeve                   | `fast_path_declined`, interpretable | the same                                                                  |
| put the gatorade bottle in my hand            | `add_unclear`, interpretable        | auto-marked, so the sheet's interpreter ran, and its ask was the dead end |
| add in hoops from the second picture          | `add_unclear`, interpretable        | the same                                                                  |

A trigger on the catch-all alone could not reach the last two. That was card C4's scope.

## What was decided (Adi, 2026-09-16)

|     | decision                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **The send reads through the interpreter on the catch-all AND on every ask auto-mark would mark that the server says the interpreter takes** (C4 folded in). A proposal marks the photo. Anything else is a new image. Her own mark is never read at send. |
| D2  | **An interpreted ADD with a Product photo and no Object photo is a new image.** That is D5 (b)'s parity, read off the frozen steps.                                                                                                                        |
| D3  | **A 20 s client cap** on the send's check. It aborts the call and plans a new image (the server's interpreter gives up at 15 s).                                                                                                                           |
| D4  | **The send button spins** and stays off while the check is out, and only then. Flag-off renders exactly as before.                                                                                                                                         |

No server change: every signal the client reads was already on the wire.

## The commits

|         | commit    | what                                                                                                                                                                      |
| ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA.1    | `a8751fb` | `previewRequestFor`: the hook's request composition moved verbatim, key order included. `previewNow` is the preview POST. No behaviour change.                            |
| CA.2    | `5d55fdd` | `PreviewSeed`, `seededPreview`; `useGenerationPlan({ seed })` shows a seed checked for exactly its request; SheetJob / StudioMakeIt params carry it; never stored. Inert. |
| CA.3    | `2c310ce` | `interpreterReads`, `readingOf`, and `resolveSend`'s one reading: the cap, the working state, and a re-read of her tray after it. Inert until CA.4.                       |
| CA.3 fu | `bf8494a` | Two pins the revert-check predictions found missing: a ready preview nobody interpreted, and `interpreter` omitted. Tests only.                                           |
| CA.4    | `b896077` | The screen: `resolveSend` gets the flag, `previewNow` and `setReading`, and `hand` passes the seed on. The spinner.                                                       |
| CA.5    | —         | This document, and ledger entries F-CA1–F-CA6.                                                                                                                            |

## How a send goes now (routing and interpreter on)

1. Her words go into the thread. The product and photo gates are unchanged.
2. **Her mark, auto-mark off, or no photo of hers:** decided before any question, as auto-mark does.
3. **The shape re-ask** on the exact words sent (auto-mark D2), told there is a photo.
4. **Two or more photos of hers and edit-shaped words:** `frame_pick`, unchanged.
5. **A reading** (`interpreterReads`), only when ALL of these hold:
   - the answer asks with `interpretable: true`;
   - the code is `fast_path_declined`, or one auto-mark marks on (`autoMarkShape`, so D5 b's adds stay unread);
   - nothing is marked and auto-mark is on;
   - exactly one plausible canvas with a row;
   - no other photo of hers beside it (F.4 would ask).
6. **The check.** The request is `previewRequestFor` over that photo, exactly the sheet's (I3). It is sent once, with
   the button spinning, a 20 s cap, and an abort.
7. **Her tray, re-read.** A tap marks it hers (a marked edit, no seed). An untap or auto-mark switched off is a new
   image. Any change to the chips, roles or rows is a new image.
8. **`readingOf`:**
   - `proposal` (interpretation, ready, canGenerate, a previewId, priced) → the photo is the frame and the preview
     is the seed. The sheet shows "Here's what we'll do" without asking again.
   - Everything else is a new image, never an ask: `add_unbound`, `new_image`, `no_proposal`, `not_ready`,
     `failed` (a throw, a 400 from detection, the cap).

## Corpus diff — 895,404 cells ($0)

**Harness** (`tools/ca/corpusDiff.ts`): one process over `ca-base-5385e57` and the branch.

- **Sentences:** 4,426 — every quoted string in both trees' Studio test files, plus 15 focus sentences.
- **Arms:** A0 routing off; A1 interpreter only; A2 routing on; A3 routing + interpreter.
- **Trays:** auto-mark's 27, on both surfaces.
- **Scripted preview answers:** a cell whose send calls the preview is re-run under each one, P1–P8 (proposal, add
  proposal, new image, declined, not frozen, unpriced, throws, never answers), and under in-flight events E1–E4 (tap,
  attach an Object photo, remove the photo, a second photo of hers) with P1 and P4.
- **Real:** `resolveSend`, `previewRequestFor`, `route()`, `interpretable()`.
- **Replica:** the screen's handlers, and base's hook composition of the request.

**Invariants checked by the harness (digest `27cd34e55399`):**

|     | invariant                                                                     | result                           |
| --- | ----------------------------------------------------------------------------- | -------------------------------- |
| I1  | a proposal ≡ base with her tap before typing                                  | **27,590 / 27,590**              |
| I2  | a fallback ≡ base with auto-mark off                                          | **110,042 / 110,042**            |
| I3  | `seed.request` ≡ the request the sheet's hook builds                          | **44,794 / 44,794**              |
| I4  | branch `previewRequestFor` ≡ base's hook composition, every cell of every arm | **961,568 / 961,568**            |
| I5  | no ask base did not have                                                      | **0 new asks**                   |
| —   | calls per send                                                                | never two                        |
| —   | working state                                                                 | on/off balanced on every reading |

**Results:**

- **In-flight events:** her tap mid-reading ≡ base with her tap, 34,408 / 34,408. An Object photo attached, the photo
  removed, or a second photo of hers mid-reading is a new image with no seed, 34,408 / 34,408 each.
- **Per arm:** A0, A1 and A2 each 159,336 cells, 0 moved, 0 calls. A3 417,396 cells (preview variants included),
  169,730 moved, 275,264 calls.
- **Identical, 0 calls:** A0, A1, A2 everywhere; every SetupScreen tray; every A3 tray except the five below. That
  covers her mark, auto-mark off, two or more canvases, video + photo (F.4), continuation, Edit this, Check again,
  and "Not what I meant" and re-send.
- **A3 reading trays** — you1, you2+removeFirst, you1+object: 3,462 sentences read (3,233 catch-alls + 229 S2).

  | answer      | catch-all (base: new image)                 | S2 ask (base: interpreted edit)    |
  | ----------- | ------------------------------------------- | ---------------------------------- |
  | P1 / P2     | `gen ⇒ edit(interp)+seed`                   | `edit(interp) ⇒ edit(interp)+seed` |
  | P3–P8       | identical                                   | `edit(interp) ⇒ gen`               |
  | E1, her tap | `gen ⇒ edit(interp)` (her mark, no seed)    | identical                          |
  | E2–E4       | a new image, no seed, over the changed tray | the same                           |

- **you1+product and product+you1:** 3,409 read. The 53 `add_unclear` / `worn_add_unclear` sentences are D5 (b)'s,
  and are never read. P2 there is a new image (D2).

S2 codes read (`tools/ca/codes.ts`):

| code             | sentences |
| ---------------- | --------- |
| brand_change     | 151       |
| add_unclear      | 42        |
| conditional      | 14        |
| worn_add_unclear | 11        |
| compound_partial | 9         |
| brand_removal    | 2         |

**Focus sentences, A3:**

| sentence                                         | you1                              | you1+object    | you1+product               |
| ------------------------------------------------ | --------------------------------- | -------------- | -------------------------- |
| make me hold the gatorade bottle from image 2    | reads                             | reads          | reads                      |
| put the gatorade bottle in my hand               | reads                             | reads          | **not read** (D5 b), = gen |
| add in hoops from the second picture             | reads                             | reads          | **not read**, = gen        |
| take the logo off my sleeve                      | reads                             | reads          | reads                      |
| make the sky moodier                             | reads                             | reads          | reads                      |
| generate pic of me playing soccer                | reads (control)                   | reads          | reads                      |
| me on a beach                                    | reads                             | reads          | reads                      |
| put me mid-air dunking                           | reads (C4)                        | reads          | not read                   |
| make the socks blue / change my jersey to adidas | identical: routed edits           |                |                            |
| change my earrings to these gold hoops           | identical: `object_photo_missing` | identical edit | identical ask              |

Where it reads: P1 → `edit(interp)+seed`, anything else → gen.

### Predictions vs the result (`tools/ca/predictions-corpus.md`, written before the harness existed)

- **Matched:**
  - the identical set: all of §1, A0–A2, setup;
  - the reading shapes;
  - every row of §2 for you1, you2+removeFirst and you1+object;
  - every event row;
  - every focus row;
  - I1–I5.
- **INCOMPLETE: product trays under P2.** The table said "— (no read there: D5 b)" for the S2 column. That is true of
  the ADD asks (53), but the 176 non-add S2 asks (`brand_change` and the rest) DO read beside a product. An
  interpreted add there is `edit(interp) ⇒ gen` (D2), with I2 holding on every one. It is D2 working as decided; the
  prediction did not enumerate it.

## Revert checks: 18, 17 exactly as predicted by name

**Method.**

- Predictions were written before any check ran (`tools/ca/predictions-revert.md`). They were written at the CA.4 tip
  plus the CA.3 follow-up; writing them is what found that follow-up's two missing pins.
- Each check mutates production lines on `bf8494a` so the file still compiles, runs three client suites with
  `jest --json`, counts reds by name, and restores from HEAD (`tools/ca/rc.py`).
- 18 runs, 0 failed to run, and the tree was clean after every restore.

|       | mutation                                                                  | predicted | red                       |
| ----- | ------------------------------------------------------------------------- | --------- | ------------------------- |
| RV-1  | the catch-all only: auto-marked S2 asks never read (D1)                   | 3         | **3**                     |
| RV-2  | every interpretable ask reads, auto-mark's shape unconsulted (D5 b)       | 1         | **1**                     |
| RV-3  | `interpreterReads` ignores `interpretable`                                | 2         | **1 — MISSED**, see below |
| RV-4  | F.4's frame-ask guard dropped                                             | 1         | **1**                     |
| RV-5  | a proposal need not be spendable                                          | 1         | **1**                     |
| RV-6  | an interpreted add beside a product is a proposal (D2)                    | 1         | **1**                     |
| RV-7  | `interpretation` not required                                             | 1         | **1**                     |
| RV-8  | a tray change mid-reading unnoticed                                       | 1         | **1**                     |
| RV-9  | her tap or untap mid-reading not re-read                                  | 1         | **1**                     |
| RV-10 | the cap stops aborting (D3)                                               | 1         | **1**                     |
| RV-11 | the working state never ends (D4)                                         | 2         | **2**                     |
| RV-12 | the send builds its request with the interpreter off (never interpreting) | 7         | **7**                     |
| RV-13 | `seededPreview` matches any request                                       | 1         | **1**                     |
| RV-14 | `materialOf` stores the seed                                              | 1         | **1**                     |
| RV-15 | `checkAgainJob` carries a seed                                            | 1         | **1**                     |
| RV-16 | the builder writes `brandId` before `objective`                           | 2         | **2**                     |
| RV-17 | the builder sends the edit base as a reference too                        | 1         | **1**                     |
| RV-18 | an omitted `interpreter` counts as on                                     | 1         | **1**                     |

**RV-3, MISSED (2 predicted, 1 red).** The predicate's own test went red. The send-level test ("reads NOTHING…",
its "not interpretable" and "an ask the interpreter never takes" rows) held. The reason is a second guard:

- `resolveSend` builds the request with `previewRequestFor`, which routes through `routeWithServer`.
- `routeWithServer` makes an ask interpreted only when `classification.interpretable === true` (I.6).
- With the predicate's check gone, the job is still not `interpreting`, so the send takes auto-mark's path and never
  calls the preview.

That is defence in depth, left as it is. The predictions file's total line reads 28, but its rows sum to 29; 28
went red.

**Designed zeros:**

- the hook's seed branch (`ready` gating, and the effect skipping `mutate`). No renderer test exists; its decision,
  `seededPreview`, is RV-13's.
- CA.4's screen wiring. That is device acceptance.

## Tests

- **Scoped Studio suite** (`server/studio server/routes/studio client/lib client/screens/studio`, jest direct, `--runInBand`):
  - base `5385e57`: 79 suites / 2,636 tests / 0 red / 0 failed to run;
  - branch `bf8494a`: 79 / 2,654 / 0 / 0;
  - test by test: 0 base passes lost, 0 base tests removed or renamed, 18 new, all green.
  - Of the 18: 4 `previewRequestFor`, 3 `seededPreview`, 1 thread (the seed is never stored), 10 in the C2 send.
- **Per commit** (client/lib + client/screens/studio, each commit's files over its parent in `ca-percommit`):

  | commit            | tests | red                                                                                                        |
  | ----------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
  | base `5385e57`    | 408   | 0                                                                                                          |
  | `a8751fb` CA.1    | 412   | 0                                                                                                          |
  | `5d55fdd` CA.2    | 416   | 0 (the first run had 1 red: the interpreter-off `seededPreview` pin, rewritten as F-CA3 before the commit) |
  | `2c310ce` CA.3    | 426   | 0                                                                                                          |
  | `bf8494a` CA.3 fu | 426   | 0 (two cases inside existing tests)                                                                        |
  | `b896077` CA.4    | —     | no test file                                                                                               |

- **Typecheck:** `check:types` is clean at every commit. The touched test files are clean as ts-jest compiles them
  (`tools/ca/tsc-tests.sh`); only base's `__DEV__` ambient noise shows.
- **Lint** (`expo lint`): base 1,808 problems (73 errors, 1,735 warnings), branch 1,807 (73, 1,734). The one warning
  gone is main's `react-hooks/exhaustive-deps` "unnecessary dependency: 'attachments'" on the hook's old request memo.
  No new lint message in any touched file.
- **Format:**
  - `threadLogic.ts`, `threadLogic.test.ts` and `ThreadMakeIt.tsx` are prettier-clean, as on base.
  - Every other touched `.ts`/`.tsx` file is unformatted on main, and stays so.
  - The added lines follow prettier (`tools/ca/hunkfmt.py`) except where they re-flow a line in the file's own
    compact idiom: import rows, the hook's destructure and memo deps, the send button's existing icon line, and the
    long test lines of createAnythingLogic.test.ts.

## Cost and latency

- **One interpreter call per reading send:**
  - ~$0.0014–0.002 at QA's Flash rates: R1, ~3,340 tokens in and ~173 out per call;
  - p50 1.7 s, p90 2.2 s, max 3.1 s (r1.json, interpret/4). interpret/5 adds ~372 input tokens.
  - Plus detection on C, only for a region proposal.
- **Same economics as before #486.** The defaulted frame sent these sentences to the interpreter from the sheet.
  Every catch-all send with one photo of hers now pays one call at send, including generate-shaped ones like "generate
  pic of me playing soccer" (F-CA1).
- **No second call for a proposal.** The sheet shows the seed. For an auto-marked S2 ask, the call moved from the
  sheet to the send; it was not added.
- **No call** with either flag off, with her mark, with two photos of hers, beside a video of hers, or on an add
  beside a product with no object photo.

## Live acceptance (Adi runs; ~$0.012, no generation)

**Setup:**

- Client: this branch, `npx expo start --port 8083` with `EXPO_PUBLIC_STUDIO_SERVER_ROUTING=true` and
  `EXPO_PUBLIC_STUDIO_INTERPRETER=true`.
- Server: main at `5385e57` or later, with `STUDIO_SERVER_ROUTING`, `STUDIO_INTERPRETER` and `STUDIO_NATIVE_EDIT` on.
  Check the running server's build before the first cell.
- Create anything, one photo of hers per tray.
- Stop at the plan card; do not press Make.

**Cells:**

| #   | tray                      | sentence                                      | predicted                                                                                               |
| --- | ------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | You + Object (the bottle) | make me hold the gatorade bottle from image 2 | spinner ~2 s, then "Here's what we'll do" with the photo marked, or a new-image plan. **Never an ask.** |
| 2   | You + Object (the bottle) | put the gatorade bottle in my hand            | the same                                                                                                |
| 3   | You + Object (the hoops)  | add in hoops from the second picture          | the same                                                                                                |
| 4   | You                       | take the logo off my sleeve                   | **a new-image plan**: the interpreter answers `invalid_slot` (8/8 in interpret/5's probe, F-CA2)        |
| 5   | You                       | make the sky moodier                          | **a new-image plan** (the same)                                                                         |
| 6   | You                       | generate pic of me playing soccer             | control: spinner, then a new-image plan, no mark                                                        |

**On every reading cell:**

- one interpreter record in the server log for the send;
- for a proposal, no second `POST /studio/preview` from the sheet: it shows the seed.

**Flag-off repeat ($0).** With `EXPO_PUBLIC_STUDIO_INTERPRETER` unset, the same six cells give no spinner and today's
plans: cells 2 and 3 auto-marked, and the sheet asks `add_unclear` (no interpreter on the client); cells 1 and 4–6
new images.

## What is NOT measured here

- **What the interpreter answers** to cells 1–3 under interpret/5. The corpus scripts every answer; the live answer
  is the acceptance.
- **The screen:**
  - the spinner;
  - the send button's disabled state while reading;
  - the sheet opening on the seed without a second preview;
  - "Not what I meant" and Check again on a seeded plan (F-CA5);
  - phone-width Chrome and the iOS Simulator.
- **The hook's seed branch as code.** No renderer test exists, so the hook is a designed zero for jest and the harness.

## Follow-ups

|     | card                                                                                                                                                                                                                                                                                                                                                 | batch       | why                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------- |
| —   | **Rules vocabulary for the two invalid_slot edits:** "take X off Y" as a removal, and a look on a named region ("make the sky moodier"). Its own PR, with a route diff.                                                                                                                                                                              | vocab-batch | F-CA2, F-AM1           |
| —   | **The badge on an interpretable S2 ask.** Show it, hide it, or show it as tentative while she types.                                                                                                                                                                                                                                                 | —           | F-CA4 (Mia)            |
| —   | **"Not what I meant" on a C2 proposal.** Give the tray back marked (as built) or unmarked with auto-mark off.                                                                                                                                                                                                                                        | —           | F-CA5 (Adi to confirm) |
| —   | **"add in hoops from the second picture" as an edit.** The rules read an add with no place (`add_unclear`), and the interpreter answered `uncovered`. Teach the place-less worn add and the photo pointer ("from the second picture"), so it routes as the edit "add the hoops from image 2 to my ears" already does. Its own PR, with a route diff. | vocab-batch | F-CA7                  |
| —   | **D1's fallback, seen live — KEPT AS BUILT (Adi, 2026-09-17).** An add she meant as an edit, unread by both tiers, becomes a new photograph and loses her frame. Mitigation: the generate card's copy line (sweep pile) and the vocab-batch row above. Revisit only if it bites after the vocabulary lands.                                          | —           | F-CA8                  |
| —   | **Framing on native edits.** Probe first: the same frozen add ×4 and a background ×4, measuring content bounds against the source. A framing line in the preservation clause and a QA framing check only if it reframes.                                                                                                                             | guard-batch | F-CA8                  |
| —   | **The `native_freeze_refused` log event also names an interpreter ask** (`reason: not_routed`), which reads as a refused freeze. Split the event name or the message.                                                                                                                                                                                | guard-batch | F-CA7                  |
