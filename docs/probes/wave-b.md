# Wave B — the clause boundary, the move op, and the probe's three additions (the evidence)

Branch `studio/wave-b-paths`, off main **`457dc09`** after #500 (the CI jest-memory fix) landed
mid-build — merged in and **every baseline re-cut on it**, see "The re-cut" below. Originally cut on
`7d12dbc` (#499, the framing/identity/stranger probe).
One commit per item. **$0 throughout**: every number below is `route()`, the freeze, the compile tier,
sharp and jest, in process — no model call, no row, no spend. The one thing here that would spend is
Q7, and it is staged and has never been fired.

## What was decided, and by whom

|                             | decision                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| card 1 (masked removal)     | **Measure first.** The card's cited repro was already fixed by K2; Q7 is that measurement, staged for Adi.                                                   |
| card 2 (the move op)        | **One `MOVE_OBJECT` op**, behind `STUDIO_MOVE_OBJECT`, default off. Not REMOVE + ADD.                                                                        |
| card 3 (G2 split)           | **C3a now** — the sentence-stop boundary plus a narrow closed-list drop. **C3b split out.**                                                                  |
| additions (a)–(c)           | The three the probe authorised, in Adi's order, ahead of 3b.                                                                                                 |
| 3b (per-clause refusal)     | **SPLIT OUT** after a $0 recon sized it L — **ratified by Adi, 2026-09-17**. Its card is a section of this document.                                         |
| the two unmeasured wordings | **Accepted as ledgered** (Adi, 2026-09-17): the framing line's words and "clothing" ship unmeasured, recorded here rather than re-measured before the merge. |
| the `ambiguous_move` copy   | **Adi's wording, approved directly** 2026-09-17, and landed here rather than in the wave-C session that first relayed it.                                    |

Authorisation for (a)–(c) is the final table in `framing-identity-stranger.md` (#499). What is DEAD
there and deliberately not built: a framing line in the shared preservation clause, a QA framing check
on backgrounds, G.2's canonical identity block, an ablation of D1–D5.

## The commits

|              | commit                 | what                                                                                                     |
| ------------ | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| C3a          | `7e630a1`              | a full stop ends a clause whatever leads the next one, plus the closed-list drop that makes the cut safe |
| C3a fu       | `85e6053`              | the ledger entries (F-WA1 → FIXED for its boundary half, F-WB1, F-WB2) and the added block formatted     |
| card 1       | `a926df5`              | Q7 staged — a clean removal on the native path, two cells, never fired                                   |
| card 2       | `ec08c5d`              | `MOVE_OBJECT`: move/shift/slide with a required directional destination, behind its own flag             |
| **(a)**      | `e122371`              | the ADD template's framing line, and an adds-only content-bounds observation in the QA stage             |
| **(c)**      | `cbff913`              | F-WB4 — the background dead-end, diagnosed; a proposal, no diff                                          |
| card 1       | `4353757`              | Q7 also reports the content bounds, through the instrument (a) now ships                                 |
| **(b)**      | `b6fd9cd`              | "clothing" in the scene release — one word, both forms                                                   |
| card 2 copy  | `5302784`              | the ambiguous-move refusal in Adi's words, approved directly 2026-09-17                                  |
| evidence     | `eb3e401` (+ this row) | this document, and 3b's card                                                                             |
| acceptance   | `87eacbc`              | F-WB5 — a move refuses on a frame that holds the thing; the diagnosis and four options                   |
| acceptance   | `020dd34`              | F-WB6 — the pronoun clause has asked since before wave A; measured on three trees                        |
| **F-WB6**    | `a29427d`              | a bare `them` takes the things she just named                                                            |
| **F-WB5**    | `f3ea3ca`              | the move's thing by detection's noun, and by elimination with a pre-spend note                           |
| live fix     | `f1c0941`              | F-WB6 fired at route and died at the freeze — a pronoun colour is hers, not the label's                  |
| harness      | `d196611`              | the interpreter-reliability probe, staged and never fired                                                |
| **F-WB7**    | `9e2331d`              | an add beside a recolour freezes — her colour as the last resort (deep sweep D2, pre-existing)           |
| **D1**       | `e2c5f4b`              | a bare `put` asks the frame instead of inventing a second ball (the deep-sweep gate)                     |
| ledger       | `565a4b7`              | the sweep's four ledger-only findings — F-WB8 to F-WB11                                                  |
| **E1/E2/E4** | `c437996`              | `replace` as a brand verb, a place after a mark, `it` for a colour — and E3's hypothesis refuted         |
| E1 fu        | `60bb0da`              | the `with` link's own pin, which RV-e1b found missing                                                    |
| D1 fu        | `<pin>`                | the `put` route pin carries the marker                                                                   |

## The re-cut, on main `457dc09`

#500 landed while this branch was staged and the push helper refused — which is what it is for. The
merge (`f17d0e0`) touches **zero product files**: `.github/workflows`, `jest.config.cjs`,
`package.json`, `scripts/run-tests.ts`, `scripts/testRunner`, `tsconfig.jest.json` and a docs audit.

**But the HARNESS moved, so the suite baseline is not comparable across it and was re-cut anyway.**
ts-jest is **transpile-only** now (`isolatedModules`), and jest runs batches of ≤8 suites per process.

| re-cut                               | result                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corpus, on `457dc09`                 | **108 cells / 54 sentences** — and **42 of those are the `fromPut`/`fromPronoun` markers alone**. Behaviourally **66**: C3a's 28 ask→ask + 6 route→ask + 2 route→route, and 30 ask→route from the fixes |
| Scoped suite, base `457dc09`         | **82 / 2744 / 0**                                                                                                                                                                                       |
| Scoped suite, branch                 | **83 / 2825 / 0** — **+81 tests, 0 lost**, every one in a suite this branch touched                                                                                                                     |
| `tsc --noEmit -p tsconfig.jest.json` | **0** — the NEW authoritative test typecheck                                                                                                                                                            |
| Revert checks re-run                 | `rc-d1.sh` 5/5 and `rc-e.sh` 5/6 (RV-e4c unexercisable), all by name, **no failed-to-run**                                                                                                              |

⚠️ **AND #500 SUPERSEDES ONE OF THIS WAVE'S OWN WORKAROUNDS.** `tsconfig.jest.json` is now type-checked
by `tsc --noEmit -p tsconfig.jest.json` in CI, so test files have a first-class typecheck for the first
time — which is exactly the gap `tools/am/tsc-tests.sh` was hand-rolled to cover. Use the repo's config
from here; the hand-rolled one is obsolete.

⚠️ **One consequence worth knowing for the revert harnesses:** transpile-only means a mutation with a
TYPE error no longer fails to compile — it runs. That removes the phantom "0 tests / 0 red" that
RV-d1a and RV-e4c hit, and it also means a type-invalid mutation now silently executes. Both rc
reporters name a failed-to-run suite regardless, and both re-ran clean here.

## Corpus — route-only, tree A vs tree B in one process (`tools/wb/rdiff.ts`)

Cut against main in `wb-probe`, re-cut after every merge. **Default flags** (so `STUDIO_MOVE_OBJECT`
off), 8,193 sentences / 24,579 cells a side at the tip:

|                               | moved                    | ask→ask | route→ask | route→route | ask→route            |
| ----------------------------- | ------------------------ | ------- | --------- | ----------- | -------------------- |
| C3a, measured on `b3ee70c`    | 36 cells / 18 sentences  | 28      | 6         | 2           | 0                    |
| card 2, flag OFF              | **C3a's 36 exactly, +0** |         |           |             |                      |
| card 2, flag ON, on `7d12dbc` | 40 cells / 20 sentences  | 28      | 6         | 2           | 4 (every one a move) |
| **(a), default flags**        | **C3a's 36 exactly, +0** | 28      | 6         | 2           | 0                    |

The 6 route→ask are three sentences: two are our own compiled error copy, and the third is
`"remove the ball. it is in the air"` — the boundary's own cost, ledgered as F-WB1 and read by the
interpreter. **(a) and (b) are compile-tier and QA-stage changes and must move zero route cells**; the
tip's diff being C3a's 36 exactly is that claim.

## Goldens — `compile.golden.json`, 115 fixtures

|         | fixtures moved                                                                        | unchanged |
| ------- | ------------------------------------------------------------------------------------- | --------- |
| card 2  | +5 added, **purely additive** (95 insertions, 0 deletions) — no existing prompt moved | 110       |
| **(a)** | **14**                                                                                | **101**   |
| **(b)** | **4**                                                                                 | **111**   |

(a)'s 14 are every fixture carrying a **placed** add. Proved tighter than "14 moved": striking the
framing sentence out of each new fixture yields the old fixture byte for byte, so the only change is
that sentence, inserted **exactly once**, and **no unchanged fixture carries it**. The **13 worn-add
fixtures are among the 101** — and RV-a2 below is what makes that a claim rather than a coincidence.

## Scoped suite — 82 suites, `--runInBand`, jest called directly

|                                        | suites / tests / red                                                  |
| -------------------------------------- | --------------------------------------------------------------------- |
| base `b3ee70c`                         | 82 / 2724 / 0                                                         |
| + C3a                                  | 82 / 2733 / 0                                                         |
| + C3a follow-up                        | 82 / 2753 / 0                                                         |
| + card 2                               | 82 / 2773 / 0                                                         |
| **+ (a)**                              | **82 / 2787 / 0** (`client/lib/studio` scope — see the warning below) |
| **+ (b)**, on the baseline's own scope | **83 / 2793 / 0**                                                     |
| **+ F-WB6 and F-WB5's fix**            | **83 / 2804 / 0**                                                     |
| **+ the deep sweep's fixes (D2, D1)**  | **83 / 2818 / 0**                                                     |
| **+ the E-series**                     | **83 / 2825 / 0**                                                     |

**0 lost at every step.** (a) adds 20 tests and drops none: framing 7 (new file), inspect 5, nativeEdit
5, verdict 2, generate 1.

⚠️ **A SCOPE MISMATCH, CAUGHT AND CORRECTED, AND IT WAS 6 TESTS WIDE.** (a)'s runs used
`client/lib/studio` where the earlier ones used `client/lib`, so `client/lib/recordLogic.test.ts`
(6 tests, untouched by any of this) left the scope while `qa/framing.test.ts` (7) entered — which is
why that line reads 82 suites and +14 rather than 83 and +20. **The last row is the like-for-like
figure on the baseline's own scope: 2773 → 2793, which is exactly the +20 the per-suite deltas
predict.** Recorded rather than quietly re-run, because a suite total that moved for a reason other
than the diff is the thing these tables exist to make visible.

## Revert checks for (a) — `tools/wb/rc-a.sh`

Each breaks ONE hunk and runs only the tests that should flip. **8 of 8 flipped**, by name:

|       | hunk broken                                                   | flipped                                                          |
| ----- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| RV-a1 | `framingClause` dropped from the assembled instruction        | 2 by name + the 14 goldens                                       |
| RV-a2 | the **worn exclusion** removed, so every add gets the line    | **13** — every worn-add golden, plus "is ABSENT from a worn add" |
| RV-a3 | a framing word put INTO the shared preservation clause        | 15, including "does not go in the shared preservation clause"    |
| RV-a4 | the `placedAdds` gate removed                                 | "measures NOTHING when the intent placed no add"                 |
| RV-a5 | the held short-circuit removed                                | "a held frame costs ONE alignment and renders no baseline"       |
| RV-a6 | excess measured against the IDENTITY, not the closer baseline | both baseline-selection tests                                    |
| RV-a7 | the failure path returns an identity fit instead of null      | "answers `null` — never a held frame"                            |
| RV-a8 | `generate.ts` stops telling QA what the intent placed         | the call-site pin                                                |

RV-a2 is the one worth reading: 13 flips is exactly the 13 worn-add fixtures predicted to be
unaffected, so the exclusion is load-bearing rather than decorative. RV-a3 is the dead blanket clause,
kept dead by a test.

## Revert checks for the E-series — `tools/wb/rc-e.sh`

**5 of 6 flip by name. The sixth cannot, and that is recorded rather than glossed.**

|            | breaks                                        | flips                                                                        |
| ---------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| RV-e1a     | `replace` out of `BRAND_VERBS`                | the live E1 sentence                                                         |
| RV-e1b     | `with` out of `BRAND_LINKS`                   | the `with`-form pin — **which RV-e1b itself found missing on its first run** |
| RV-e2a     | the place after a mark no longer consumed     | both E2 cells                                                                |
| RV-e2b     | the place kept as a TARGET instead of dropped | the "garment is never a target" cell                                         |
| RV-e4a     | `it` no longer resolved                       | both E4 cells                                                                |
| **RV-e4c** | the RECOLOUR test on `it` dropped             | **NOTHING — unexercisable**                                                  |

⚠️ **RV-e4c is unexercisable, measured.** A look word reaches the resolver's recolour test by neither
route: `"make it vintage"` READS on its own as a `GLOBAL_STYLE`, so the resolver never fires on it, and
`"make the jersey vintage"` — the substitution — does not read at all, so the re-read is null and the
clause is returned first. No sentence exists for which that test is what stops the resolution. It stays
because it is the fence Adi's condition names and a future look word that failed to read alone would
arrive there — but it is labelled in the code and in the check, because **a check that cannot fail is
not a check**.

⚠️ **And RV-e1b's first run flipped nothing for a different reason: the pin was missing.** Every E1 cell
used the "to be" form, so the link had no test of its own and the check was proving the verb twice.
That is the fourth empty-but-green check in this wave, and the first where the emptiness pointed at a
missing TEST rather than a broken mutation.

## Revert checks for the deep sweep's fixes

**5 of 5 for D1** (`tools/wb/rc-d1.sh`): the branch removed · the object-photo exemption dropped · the
flag gate dropped · the assumption no longer recorded · the marker never set. **2 of 2 for F-WB7** are
carried by its own cells (the live compound and sweep 3.1's two-target guard, which move in opposite
directions).

⚠️ **RV-d1a reported "0 tests / 0 red" on its first run and that was a LIE.** The mutation wrote
`if (false && …)`, the typechecker rejected it, the suite failed to COMPILE, and jest reports a
failed-to-run suite as zero tests and zero failures — which reads exactly like a check that flipped
nothing. `rc-d1.sh`'s reporter now names a failed-to-run suite and says **THIS CHECK PROVED NOTHING**.
Third time this wave a green-looking check was empty: RV-w6d (guard vs constant), the route-only F-WB6
cells, and this.

## Revert checks for the two acceptance fixes

**8 of 8 flipped by name** — `tools/wb/rc-w6.sh` (4) and `tools/wb/rc-w5.sh` (4). The four worth reading:

|        | breaks                                              | flips                                                                                               |
| ------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| RV-w6b | the repeated determiner in the pronoun rewrite      | the three-target cells drop to ONE target — the check that the determiner is load-bearing, not tidy |
| RV-w6c | the antecedent allow-list widened to every op       | the background-antecedent cell starts recolouring HER                                               |
| RV-w5c | "exactly one" unnamed region widened to "the first" | the two-balls guard                                                                                 |
| RV-w5d | the assumption no longer recorded                   | both disclosure cells — the difference between (d) and a silent guess                               |

⚠️ **RV-w6d had to be rewritten, and that is worth recording.** Its first draft widened the resolver's
GUARD to admit `it` and flipped **nothing** — the substitution below is keyed on the same constant, so
the clause was re-read with its text unchanged and stayed unread. A revert check that flips nothing
proves nothing while appearing to pass. Mutating the constant moves the guard and the substitution
together, and it flips four cells including the `it` control.

## Revert checks for (b) — `tools/wb/rc-b.sh`

**2 of 2 flipped**, and the split between them is the point: the word is in two sentences and each is
pinned by its own fixtures, so neither form can lose it silently.

|       | hunk broken                                                            | flipped                       |
| ----- | ---------------------------------------------------------------------- | ----------------------------- |
| RV-b1 | the word taken out of the **plural** release (the measured arm)        | the 3 pack fixtures, by name  |
| RV-b2 | the word taken out of the **singular** release (the extrapolated twin) | the 1 fixture that carries it |

**RV-b3 is not a revert and says so:** "no EDIT prompt carries a likeness release at all" is a property
of the golden diff — 0 of the ~100 edit fixtures moved — and it is held by construction, since
`likenessBlock` reaching an edit's manifest would move them all and `golden.test.ts` would name them.

## The instrument's cost, measured — and what it did to the suite

Not in any prediction, and it re-shaped `framing.test.ts` twice:

|                                                 | one alignment | eight alignments |
| ----------------------------------------------- | ------------- | ---------------- |
| plain node, canvas 288 (how the server runs it) | ~3.9s         | ~30s             |
| jest `--experimental-vm-modules`, canvas 144/96 | ~40s          | **334s**         |
| jest, canvas 64                                 | ~22s          | **180s**         |

**~50x, and the search grid is FIXED** (22,491 coarse + 4,913 fine evaluations per alignment), so
dropping the canvas barely helps: 4x less pixel work bought 1.9x less time. Two things followed, both
recorded in the files rather than in a session:

1. **A jest timeout does not cancel the work.** The first calibration test blew its 120s bound and its
   four alignments kept computing for ~8 more minutes, holding the jest lock.
2. **The observation's 45s production bound fired inside the VM**, so two tests recorded
   `reframed: null` and were asserting a timeout instead of geometry. The bound is now read at call
   time (`framingTimeoutMs()`), the idiom `studio/config.ts` already uses, and the suite raises it.

Final shape: the **decision** (cheap path vs baseline path, held vs reframed vs unanswered) against a
stubbed aligner, the **instrument** against two real synthetic cells. **7 tests, 61s** — and the
decision's coverage went UP: it now pins baseline _selection_ and the snap-explains-it case, neither of
which the 180s version tested.

**And a periodic fixture is a trap.** The first scene was a 50px checkerboard; NCC on a repeating
pattern has many near-equal maxima, and the combined cell reported a 7.5% X shift for a constructed
4.5% Y one at 0.97 correlation. The scene is now a smooth low-frequency ground plus 45 blocks at random
sizes and places, which has one maximum.

## 3b — per-clause refusal: SPLIT OUT, and this is its card

Measured at $0 on `studio/wave-b-paths` (C3a + card 2 in), against main `7d12dbc`. `route()` in
process: no model, no row, no spend.

**Verdict: this is L, and the standing instruction is to split it out rather than start it. Done —
it is its own card, and nothing of it ships in this PR.** What follows is why, and what its plan is.

---

### What C3a already absorbed

The original G2 split (plan.md, card 3) was: the sentence-stop boundary, and per-clause refusal. C3a
shipped the boundary **plus** the narrow drop that makes it safe (a closed list: keeps and courtesy).
The lead repro the card was written for is already answered by C3a plus card 2:

|                | route                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------ |
| main `2dc602e` | ASK `person_target` — a refusal about HER, for a sentence editing no one                         |
| + C3a          | ASK `compound_partial` — the stop boundary; the removal read on its own                          |
| + card 2       | ASK `compound_conflict` — both clauses read, and the conflict is the true one (F-WB3, by design) |

So 3b is no longer "the fix for the G2 card". It is a separate product behaviour: **when one clause
of a compound cannot be read, route the rest and tell her what was left out**, reversing
composition's decision d1 (never silently drop a clause) by making the drop not silent.

### The population it would serve — MEASURED

Corpus **8,202 sentences**, one route each:

|                                              | count                |
| -------------------------------------------- | -------------------- |
| route                                        | 959                  |
| ASK                                          | 7,243                |
| **ASK `compound_partial`**                   | **33**               |
| of those 33, read by C2's interpreter (`+i`) | **33 — all of them** |

Of the 33, roughly twenty are our own test titles and error copy that happen to sit in the corpus
("Studio can't make more than one change at once here…", "REPLACE WITH REFERENCE, R.1 — …"). The
typed-English sentences are:

    add a ball on the bench and make it pop
    add a soccer ball at my feet. make it pop
    make the socks blue and make it pop
    change my jersey to blue and add an adidas logo
    make the jersey red and add an adidas logo
    make her jersey blue and give the socks some stripes
    make the socks blue and change nothing else
    dont change me, make it warmer, keep me the same
    remove the ball. it is in the air                                    ← F-WB1, ledgered
    remove the ball in the air. for the ball on the ground move it …     ← card 2 answers it
    C add the headline "…" across the top, and change the background …   ← the interpreter's own C

Subtract the two already accounted for and the interpreter's own composed sentences, and **the class
3b uniquely serves is about six sentences: "make it pop", "add an adidas logo", "give the socks some
stripes"** — each a real request the rules cannot read, beside a clause they can.

**Every one of them already gets an answer**: C2's interpreter reads all 33 and returns a proposal
card. 3b's value is therefore not "she gets an answer" but "she gets a cheaper answer than one model
call, and the part we CAN do runs without a round trip".

### The discriminator exists — but only for half the cases

plan.md recorded that `declineReason` cannot separate a request from a courtesy, and that is right.
It is not the whole picture: `compose` (classify.ts:3563) **already computes the unread clause's own
reason** and maps only the generic case away:

```ts
const own = declineReason(unread.text);
return {
  kind: "ask",
  reason: own === "fast_path_declined" ? "compound_partial" : own,
};
```

So a clause refused for a NAMED reason (`person_target`, `brand_change`, `conditional`, `add_unclear`)
is already distinguishable from one we merely failed to read — and that is exactly the split 3b needs:

- **named reason** → we can say what we could not do and why. Droppable with a real disclosure.
- **`fast_path_declined`** → we cannot tell "add an adidas logo" from "thanks". A drop here can only
  say "we did not do this part: '<her words>'" — disclosure without diagnosis.

Which of those two is acceptable product copy is **Adi's call, not a derivation**, and it is the
first thing the card needs settled: a note quoting her own words back with no reason may read worse
than today's honest "try each change on its own".

### Why it is L

| piece                                                                                      | file                                                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `dropped: { text, reason }` on `Routed`, populated in `compose` instead of asking          | `studio/classify.ts`                                         |
| the drop excluded from `readAs`, so detection and the freeze never see it (K2's mechanism) | `studio/classify.ts`                                         |
| carried through the freeze onto the brief, since the disclosure is shown at preview time   | `studio/nativeIntent.ts`, `studio/brief.ts`                  |
| `droppedClauseNote` beside the three existing disclosures                                  | `studio/compile/disclosure.ts`                               |
| surfaced in the preview's degraded-warning path                                            | `studio/preview.ts`                                          |
| her copy, and the ask-vs-route change on the card                                          | `client/lib/studio-contract.ts`, the Ask Mila UI             |
| corpus diff, goldens, and pins across all of the above                                     | classify / nativeIntent / golden / preview / routes / client |

`brief.ts` is shared code (CLAUDE.local.md), so that hop is a proposal rather than an edit, and the
copy is a product decision. That is three owners and a reversed decision for six sentences the
interpreter already answers — which is the case for scheduling it deliberately, not for doing it at
the end of a wave.

### Two things this recon found that are NOT 3b

- **`make the socks blue and change nothing else` still asks.** The trailing clause leads with
  `change`, an operation verb, so C3a's closed list does not set it aside and #488's
  preservation-sentence guard does not catch it here. Our own compiled scope line, read back as a
  request. Worth a ledger entry; a one-word candidate for the closed list, with its own corpus diff.
- **`dont change me, make it warmer, keep me the same` asks on clause 1 or 2, not the keep.** The
  keep at the end IS set aside by C3a. Nothing to fix, worth knowing before anyone re-reads that
  sentence as a closed-list gap.

### If it is picked up, start here

1. Settle the copy question above (named reason vs quoting her words back).
2. Build it on the NAMED-reason half only, and leave `fast_path_declined` asking exactly as it does
   today. That half is S–M, needs no new copy vocabulary, and is measurable on the corpus.
3. Re-measure the population first: `compound_partial` is 33 cells on a corpus that is mostly our own
   strings, and the number that matters is how often it fires in the live product, which
   `interpreter_ask_blocked` and the ask log can answer for free.

## What is measured here, and what is NOT

**Measured:** that the framing line reaches exactly the prompts it should and no others; that the
instrument recovers a constructed transform (identity → 1.0000/0/0; 1b's 0.89/+0.045 shape → 0.8900,
+0.045); that the observation branches correctly and never throws; that zero route cells move.

**NOT measured, and not claimed:**

- **The framing line's WORDING.** 1b authorises _a line_ at 4/4. Nothing has measured _these words_.
  The re-measure is the four cells the probe already paid for (`/Users/adi/pfi/probe1b.ts`, $0.5376).
- **Whether the line works at all** — i.e. whether a render that would have reframed now holds its
  frame. That needs the same four cells re-run, and it is the acceptance question.
- **"clothing" in the release.** (b) edits a line the reference-pack work measured WITHOUT the word, so
  every identity number from that work is, after (b), a statement about a prompt we no longer send. The
  re-measure is probe 2's own harness (`/Users/adi/pfi/probe2.ts`). Adi's to run.
- **Q7.** Never fired. Card 1 stays undecided until it is.
- **The client.** No screen is exercised by (a), (b) or (c).
- **Any acceptance bar in the identity metric** — probe 3 put a stranger below the bottom of her own
  same-person band on a curated single-person set, and R0.a's decision 5 stands.

## Gates

- `check:types` — 0 errors. ⚠️ `tsconfig` excludes `**/*.test.ts`, so a type error only ts-jest would
  see is invisible there; the touched tests compile under ts-jest in the runs above.
- `prettier` — clean on every file that was clean at base. `server/studio/generate.test.ts` was
  **already unformatted on main**, so only the added block is formatted there, verified by extracting
  it and diffing against prettier's own output. Never `--write` over a file main left unformatted.
- `lint`, `test` — the scoped runs above; the full-server suite is not this branch's baseline (see
  `full-server-suite-baseline`, four red suites on main, unrelated).
