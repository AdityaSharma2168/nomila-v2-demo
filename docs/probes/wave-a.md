# Wave A — the guard batch and the vocabulary batch (the evidence)

Branch `studio/wave-a`, off main `29b2fc8` (#492, C2 merged). One commit per item, guards first. $0 throughout: every
number below is `route()`, the freeze, the compile tier and jest, in-process — no model, no row, no spend.

## What was decided (Adi, 2026-09-17, after a $0 recon)

| | decision |
| --- | --- |
| G2 | **Split out.** L-sized on the clause reader (ledger F-WA1). |
| G1 | **Resting places.** Non-contact prepositions onto any part of her; contact (on, onto, to) only onto head, foot, feet, shoulder(s), lap; BODY_MODS never. |
| V1 | **Close the parity gaps** the recon found; "2nd/3rd" ledgered. |
| V4 | **The location reading** for removals, beside "take X off" and the sky's look. |

**What the recon changed about the brief:**
- **G2** — the live repro is not `compose` dropping a legal sibling. The second sentence leads with no verb, so the
  clause reader never cuts at the full stop and rule 1 claims every noun across it (F-WA1). A per-clause refusal is a
  wire change through freeze, intent and preview, and the repro would still ask `compound_partial`.
- **V1** — "from the second picture" already read. The lead sentence failed on "add in" and on having no place (V2's).
- **V4** — "take the logo off my sleeve", read by rule 1 as it stood, would have compiled "remove the sleeve", as
  "remove the logo from my sleeve" already did on main (F-WA3).
- **V5** — no production code: rule 0 reads the whole sentence before composition; only "pic" was missing (V3).

## The commits

| | commit | what |
| --- | --- | --- |
| G1 | `dcb836a` | a part of her after a closed preposition is a place, not a target; compile/card say "worn" only for a worn thing |
| G3 | `620375c` | rule 5's colour outside a closed list of compound names (not "golden hour": F-WA2) |
| G4 | `e719d04` | `interpreter_ask_blocked` for the interpreter's ask; `native_freeze_refused` for a refused freeze only |
| V1 | `19bd0a2` | "image 2" reads as "second image"; "in the Nth picture" after an add's thing is its source |
| V2 | `e078c63` | a place-less worn add takes its anchor (`WORN_DEFAULT_PLACES`); "add in" is a particle |
| V3 | `d11d4aa` | pic, pics, headshot, portrait, photoshoot, photos; a plural arm with no article |
| V4 | `f0def71` | "take X off"; a removal's on/from/off place; rule 5½, the sky's look |
| V5 | `5c5715a` | pins only: an explicit generate claims its compound, route → freeze → prompt |
| V6 | `d5927cc` | a list of two to four kept things; every item held; our preservation sentence never a list |
| V3 fu | `3c0213d` | the no-indefinite "photographs" pin V3 missed (test only) |
| G1 fu | `6eb9d2a` | client pin: the bottle "onto my head" (test only) |
| V2 fu | `8683e46` | client pins: "add sunglasses", C2's hoops cell (test only) |
| V3 fu 2 | `c859475` | client pins: "a pic" catch-all row, F-AM4's parity pin renamed (test only) |
| V4 fu | `8dd15e4` | client pins: C2's catch-all fixture is "make the grass moodier"; cells 4 and 5 pinned (test only); lookVocab's sky row |
| V5 fu | `fdec709` | the guard pin RV-V5a showed was missing: a generate an operation verb heads never composes (test only) |

The follow-ups exist because the per-commit runs covered the server suites and not the client ones that read the real
server route (`createAnythingLogic.test.ts`), one server pin was missed, and the revert checks found one guard
unpinned (RV-V5a, below); history rewrites are not available here. Each follow-up belongs to its item: revert an item
together with its follow-ups.

## The scoped suite ($0, jest in-process)

**Paths:** server/studio, server/routes/studio, client/lib, client/screens/studio, plus
client/components/studio/referencePack.test.ts. `jest --runInBand --json`, called directly (`npm test` drops the
flags), judged by name from the JSON (`tools/wa/byname.js`).

**At the tip `fdec709`: 83 suites / 2,730 tests / 0 red, 0 failed to run** (`out/tip-scoped-fdec709.json`). Against
main `29b2fc8` — 82 / 2,683 / 0 (C3's base run of the four paths, 81 / 2,677, plus referencePack 1 / 6):
- **0 tests lost.**
- **2 intended renames:** G.3's "keeps add_unclear where no place on her is named — including (c)'s candidates, pending
  Mia's words" (V2 reads them at their anchor now) and auto-mark's "ACCEPTED, pre-frame-defaulting parity: a generate
  phrasing with a background clause routes as the background edit" (V3 and V5 make it one new image).
- **49 new, all passing** (48 at `8dd15e4`, plus the V5 follow-up's pin).

**Per commit** (the same paths in the scratch tree `wa-cur`; `out/percommit-scoped.tsv`, `out/scoped-<sha>.json`):

| | commit | suites | tests | red | failed to run | red, by file |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | `dcb836a` | 82 | 2,693 | 1 | 0 | createAnythingLogic 1 |
| G3 | `620375c` | 82 | 2,695 | 1 | 0 | createAnythingLogic 1 |
| G4 | `e719d04` | 83 | 2,697 | 1 | 0 | createAnythingLogic 1 |
| V1 | `19bd0a2` | 83 | 2,701 | 1 | 0 | createAnythingLogic 1 |
| V2 | `e078c63` | 83 | 2,709 | 3 | 0 | createAnythingLogic 3 |
| V3 | `d11d4aa` | 83 | 2,712 | 6 | 0 | createAnythingLogic 5, classify 1 |
| V4 | `f0def71` | 83 | 2,717 | 14 | 0 | createAnythingLogic 12, classify 1, lookVocab 1 |
| V5 | `5c5715a` | 83 | 2,722 | 14 | 0 | createAnythingLogic 12, classify 1, lookVocab 1 |
| V6 | `d5927cc` | 83 | 2,726 | 14 | 0 | createAnythingLogic 12, classify 1, lookVocab 1 |
| V3 fu | `3c0213d` | 83 | 2,726 | 13 | 0 | createAnythingLogic 12, lookVocab 1 |
| G1 fu | `6eb9d2a` | 83 | 2,727 | 12 | 0 | createAnythingLogic 11, lookVocab 1 |
| V2 fu | `8683e46` | 83 | 2,728 | 11 | 0 | createAnythingLogic 10, lookVocab 1 |
| V3 fu 2 | `c859475` | 83 | 2,728 | 10 | 0 | createAnythingLogic 9, lookVocab 1 |
| V4 fu | `8dd15e4` | 83 | 2,729 | **0** | 0 | — |
| V5 fu | `fdec709` | 83 | 2,730 | **0** | 0 | — |

Every red from `dcb836a` to `c859475` is a pin in a test file a follow-up edits, and none is a production defect: nothing
after `d5927cc` touches production code (`git diff d5927cc fdec709` is three test files and the two docs). The count
reaches 0 at `8dd15e4`. The per-commit route and compile diffs, run on the server suites at each commit, are below.

## Corpus diff ($0, `tools/wa/diff.ts`)

**Method.** One process, both trees required by absolute path.
- **Sentences:** every quoted string in both trees' Studio and client/lib test files, both fixture recordings (r1,
  scene) and the focus file. ⚠️ The extractor used by earlier builds let a template literal span lines and dropped
  about a third of the strings; fixed here (single-line templates, comment lines read both ways).
- **Cells:** `route(s, photo, {objects})` for photo+0, photo+1 and no photo, with `interpretable()`; the whole compile
  tier (freeze, native prompt, references, instruction, notes, masked prompt) over four request shapes; generate
  requests per deliverable; the interpreter prompt hashed for an ad, a non-ad and a text-off menu.
- **Predictions** were written per commit before its diff ran (`tools/wa/predictions-*.md`), and amended only before a
  re-run, each amendment saying what the run before it showed.

**The branch** (main `29b2fc8` vs the tip `fdec709`, `tools/wa/out/pc-branch.txt`): 84 files, **8,012 sentences**,
24,036 route cells a side, 3,264 native prompts.

| | cells | sentences |
| --- | --- | --- |
| **moved** | **234** | **117** |
| ask→route | 162 | 83 |
| route→ask | 11 | 6 |
| route→route | 41 | 21 |
| ask→ask | 20 | 12 |

Compile differences: 1,940, over the same 117 sentences — **0 sentences compile-moved without route-moving.** The V5
follow-up adds one moved sentence, its own pin: "make a pic of me playing soccer and remove the cone" asked
`compound_partial` on main and is GENERATE at the tip, inside V3's class ("pic" names a new image). The moved set is
otherwise the one cut at V6 `d5927cc` before the follow-ups (`out/pc-branch-prev.txt`: 7,999 sentences, 116 moved);
the follow-ups' other new strings move nothing.

**Per commit** (parent vs commit, the corpus of both trees):

| | cells | sentences | ask→route | route→route | route→ask | ask→ask | compile sentences outside the moved set |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G1 | 56 | 28 | 27 | 0 | 0 | 1 | 0 |
| G3 | 4 | 2 | 0 | 0 | 2 | 0 | 0 |
| G4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| V1 | 14 | 7 | 6 | 1 | 1 | 4 | 0 |
| V2 | 44 | 22 | 18 | 0 | 0 | 4 | 0 |
| V3 | 28 | 14 | 11 | 3 | 0 | 0 | 0 |
| V4 | 64 | 32 | 18 | 10 | 2 | 2 | 0 |
| V5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| V6 | 18 | 9 | 0 | 7 | 1 | 1 | 0 |

(Cells count photo+0 and photo+1; no-photo cells never moved. A sentence can appear in two columns across its cells.)

**Every moved row is inside its commit's predicted class.** What each prediction missed, and what the amendment did,
before the next run:
- **G1, run 1:** "add a crown on my head", "…on her head" (and its compound), "put a tiara on my head" routed — M3's N6
  keeps those words off the worn list so they ask onto her. Fixed (`NOT_PLACED_ON_HER`). And "put the ball closer to
  my feet" compiled "add a ball, place it closer to the person's feet" — a second ball; "closer to" became a move that
  reads no place (asks `add_unclear`).
- **G3, run 1:** with "golden hour" on the list, "make it golden hour, keep me the same" stopped routing (F-WA2).
  "golden hour" came off the list.
- **Harness, after V4:** the per-commit chain and the branch diff did not reconcile; the cause was the extractor above.
  After the fix, the chain's end states equal the branch diff's on every shared cell; the branch diff's 4 extra cells
  are two V5 test sentences, which V3's rule moves and which did not exist in V3's trees.
- **Scoped suite, after V6:** 13 client and look pins used sentences wave A now reads — the four client follow-ups.
- Named inside the classes: V1 reads our own compiled clause "replace the earrings with the gold hoops from Image 2." as
  the replacement it is (main: RECOLOR [earrings] gold); V4 still removes the cone across the G2 card's full stop, but
  no longer "ground make it"; test titles that parse as sentences move with their class.

**Interpreter prompt:** identical at every commit and at the tip — non-ad `006633321b906a36`, ad `3e9ae408475b33a4`,
text-off `e575bde75e86ecab` — and identical with `STUDIO_DISPLAY_TEXT` on.

**Goldens:** `compile.golden.json` and `golden.test.ts` are not in the diff; `compile/golden.test.ts` passes at every
commit. No recapture.

## C2's acceptance sentences — the interaction check ($0, `tools/wa/interaction.ts`)

The client's real `interpreterReads` and `editShaped` over each tree's server answer, one photo of hers, with and
without an Object photo:

| sentence | base | tip |
| --- | --- | --- |
| make me hold the gatorade bottle from image 2 | catch-all, read | the same (no rule reads "hold") |
| put the gatorade bottle in my hand | add_unclear, read | the same ("in my hand" is not G1's) |
| add in hoops from the second picture | add_unclear, read | **`ADD_OBJECT`, auto-marked, not read** (V2) |
| take the logo off my sleeve | catch-all, read | **`REMOVE_OBJECT`, auto-marked, not read** (V4) |
| make the sky moodier | catch-all, read | **`RECOLOR`, auto-marked, not read** (V4) |
| generate pic of me playing soccer | catch-all, read | the same (no article: V3 leaves it) |

The three the vocabulary covers route as edits and the interpreter read never fires — rules win before the catch-all.

## Revert checks ($0, `tools/wa/rc.py`)

**Method.** Each check mutates production lines in the scratch tree `wa-cur` at the tip, runs the full scoped paths
(server/studio, server/routes/studio, client/lib, client/screens/studio, plus referencePack.test.ts) with
`jest --runInBand --json`, compares the red tests **by name** to predictions written before any check ran
(`tools/wa/predictions-revert.md`, amendment 1 before the run, amendment 2 before the re-run), and restores from HEAD.
A dirty tree, an anchor found other than once, or a suite that failed to run voids the check. None was void.

**19 checks at `8dd15e4`, 65 predicted reds, 64 red by name. 18 as predicted; one real miss (RV-V5a), pinned and
re-run as RV-V5a-pin.**

| check | mutation | predicted | red | verdict |
| --- | --- | --- | --- | --- |
| RV-G1a | G1: contact onto a resting place is a surface again | 2 | 2 | as predicted ¹ |
| RV-G1b | G1: the compile tier and card say worn for any add onto a worn-on place | 2 | 2 | as predicted |
| RV-G1c | G1: a non-contact preposition reads any place, not only her | 3 | 3 | as predicted ¹ |
| RV-G1d | G1: M3's N6 costume words are placeable | 15 | 15 | as predicted ¹ |
| RV-G3a | G3: rule 5 reads colours inside the compounds again | 1 | 1 | as predicted |
| RV-G4a | G4: the interpreter's ask logs the freeze's event again | 1 | 1 | as predicted |
| RV-V1a | V1: a photo's number is not read as its ordinal | 2 | 2 | as predicted |
| RV-V1b | V1: "in the Nth picture" is not a source | 1 | 1 | as predicted |
| RV-V2a | V2: a place-less worn add takes no anchor | 6 | 6 | as predicted |
| RV-V2b | V2: "add in" is not a particle | 5 | 5 | as predicted |
| RV-V3a | V3: the plural arm never matches | 2 | 2 | as predicted |
| RV-V3b | V3: the singular arm loses pic, headshot, portrait, photoshoot and photos | 7 | 7 | as predicted |
| RV-V4a | V4: a removal's place is a second target again | 4 | 4 | as predicted |
| RV-V4b | V4: "take X off" is not a removal verb | 5 | 5 | as predicted |
| RV-V4c | V4: the sky's look is not read | 3 | 3 | as predicted |
| **RV-V5a** | V5: composedClauses answers for a generate's compound | 1 | **0** | **MISS** ² |
| RV-V6a | V6: no list is read | 3 | 3 | as predicted |
| RV-V6b | V6: a kept list may be our own preservation sentence | 1 | 1 | as predicted |
| RV-V6c | V6: a conflict checks only the first kept item | 1 | 1 | as predicted |
| RV-V5a-pin | the same mutation as RV-V5a, at `fdec709` | 1 | 1 | as predicted ³ |

¹ **A format artefact, not a miss.** The runner printed NOT AS PREDICTED for RV-G1a, RV-G1c and RV-G1d because four
prediction strings joined describe and test with " › ", while jest's `fullName` joins them with a space. The red tests
are exactly the predicted ones by name, with equal counts. Re-reading the recorded JSON with the same matcher, and
only the separator changed (`tools/wa/rejudge.py`, `out/rc-rejudged.txt`, no jest run), all three read AS PREDICTED;
the other 16 verdicts are unchanged. The runner's original lines stay in `out/rc-results.txt`.

² **RV-V5a, a real miss.** Disabling composedClauses' EXPLICIT_GENERATE guard turned nothing red. The guard is not
load-bearing for V5's compound: "generate" is no operation verb, so the clause reader never splits "generate a pic of
me playing soccer and change the background to a stadium" — compose() answers null with the guard or without, and
route() had already claimed the sentence at rule 0. The guard bites only for a generate an operation verb heads: with
it disabled, "make a pic of me playing soccer and remove the cone" composes as GENERATE + REMOVE_OBJECT (probed at
`8dd15e4`), a composition route() never made — and the freeze and the preview route read composedClauses. The V5
follow-up `fdec709` pins that sentence (route GENERATE with a photo and without; composedClauses null), and the same
mutation re-run on it is RV-V5a-pin.

³ **RV-V5a-pin** (`out/rc-RV-V5a-pin.json`): 1 red, the new pin by name ("never composes a generate an operation verb
heads…"), 2,729 passing of 2,730. V5's original pin stays green under the mutation, as the miss showed. The prediction
was written before the run (amendment 2).

**With the pin: 20 runs, 66 predicted reds, 65 red by name; every check now has at least one test that fails when its
production lines are reverted.**

## Gates

At the tip `fdec709`:

- **check:types** (`tsc --noEmit -p .`): **0 errors.**
- **Touched tests, typechecked as ts-jest compiles them** (`check:types` excludes `*.test.ts`; `tools/wa/tsc-tests.sh`,
  types jest + node): the 11 touched server test files, **0 errors.** createAnythingLogic.test.ts: 4 errors, all
  `__DEV__` in client/lib/logger.ts and client/lib/query-client.ts (untouched), **identical on main `29b2fc8`** — the
  harness leaves out React Native's globals. The suite compiles and runs under ts-jest (0 failed to run).
- **lint** (eslint on each touched .ts, branch vs main): **0 errors** in all 18. Warnings equal main's on every existing
  file; the new nativeIntent.log.test.ts has 2 (`import/first`, the imports after its `jest.mock`).
- **check:format** is red on main (pre-existing, not fixed here; `.md` is outside its glob). Of the 18 touched TS files,
  14 are formatted, as on main; 4 were unformatted on main and still are. **The branch adds prettier drift in two of
  those:** classify.test.ts +2 hunks (4 source lines, from G1 `dcb836a` and V4 `f0def71`) and
  createAnythingLogic.test.ts +7 hunks (10 source lines). Not reformatted: prettier is not run over files main leaves
  unformatted; whether to rewrap those lines is Adi's call.
- **test:** the scoped suite above, 83 / 2,730 / 0 at the tip. The full server suite was not run (its baseline carries
  four red suites unrelated to Studio).

## What is NOT measured here

- **The screen and the model.** Every cell is Adi's acceptance: the cards, the auto-mark badge, and — for the sky — the
  detection directive the recolour pairs with ("moodier sky") and the edit itself.
- **The interpreter's answers** to the sentences that still reach it (unchanged prompt, unchanged fixtures).
- **G1's placements on the model** beyond Q1's measured "on top of her head" (q1-e): "onto her head", "near her feet".
