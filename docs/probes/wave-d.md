# WAVE D — five cards, four built, one parked at a ratified decision

Every card had a live sentence on the acceptance sheet, and every fix is pinned through the FULL
preview route or the freeze — never `route()` alone, which is the shortcut that passed green four
times last wave while the feature was broken.

| card                              | outcome                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1 · scene sentence → generate     | **BUILT, RESCOPED.** The premise did not survive the client; what it closes is a narrower path. |
| 2 · multi-target multi-value      | **PARKED.** Collides head-on with composition decision 2a. Patch and evidence kept, not staged. |
| 3 · cross-clause reference        | **BUILT (a only).** 3(b) was a misdiagnosis — see below.                                        |
| 4 · vocab one-liners              | **BUILT**, three commits — A14, J7, A15. A14 was not a one-liner.                              |
| 5 · held-object adds              | **BUILT (part 1).** The anatomy-retry is not in it, deliberately.                              |
| bisect · B14/R8                   | **FADED.** No regression; the pin was aspirational.                                            |

---

## The bisect, run before anything was built

`remove the ball. it is in the air.`

| tree                    | answer                                          |
| ----------------------- | ----------------------------------------------- |
| `7d12dbc` (pre-wave-B)  | `REMOVE_OBJECT [ball, air]` — it removed the AIR |
| `main 27185ee`          | `ASK compound_partial`                          |

They differ, but **neither ever gave the matrix's `REMOVE_OBJECT[ball]` alone.** The old behaviour
was not "sentence 2 dropped", it was "the air becomes a second thing to remove". That is ledger
**F-WB1 · KNOWN (C3a's own cost, accepted)**, which predicts both measurements exactly. No
regression, no gate, no card — the matrix cell is wrong and B14/R8 fade.

## Card 1 — the premise did not survive the client

The interpreter's `new_image` verdict reached the route correctly and the preview blocked on it, so
F3 and D7 came back `mode: edit, status: blocked`. But `resolveSend` runs that preview
**speculatively** and uses it only to decide the send: `readingOf` answers `new_image`, which is not
`proposal`, so the client drops the frame and re-sends — a generate, her photo still in the tray as
her likeness. `createAnythingLogic.test.ts` already pinned it ("every answer but a ready proposal is
a NEW IMAGE"). **The acceptance sheet is scoring a reading the product is designed to discard.**

What IS live: `interpreterReads` returns null when a frame choice is needed (two photos of her) or
the client's interpreter flag is off, and the send then carries `autoFrame` — an edit, which blocked
with no second chance. The server now honours the verdict itself, so its answer no longer depends on
which caller asked. ⚠️ Any cell whose expectation is `generate` may share this artifact; the harness
session should re-check the others.

## Card 2 — BUILT, by not doing the thing 2a forbids (2026-09-18)

**Status: built on `studio/card2-per-target-colour`, option B.** The section below is the recon as it
stood when the card was parked, kept because its measurement is what made the decision. What changed
is the shape, not the finding.

The split turned ONE step into several, which is a change to the classification SHAPE, and that is
what decision 2a forbids. Option B leaves the shape alone: rule 5 still emits one step with the same
`op`, `targets`, `value` and `scope`, and gains `values` — the colour she gave each target, aligned
to `targets`, set only where she gave every one of them its own. The freeze's existing per-target
loop prefers `values[i]`, then the label recovery, then the `sole` fallback; the `fromPronoun` branch
right beside it is the precedent, and its own note says why ("consulting the labels at all is the bug
here"). **2a is not engaged and needed no overturning**: all four of its pins compare a projection of
`[op, targets, value]`, and option B changes none of them — verified green.

Two facts make it cheap, and both were measured before the build: the freeze already emitted one
change per target whatever the step shape, and native compiles every change into ONE call
(`compile/assemble.ts`, `changes.map(clauseFor).join(", and ")`). **Two steps were never two renders.**

Measured on the 8,608-sentence corpus against merged main `4ccc518`: interpreter prompt hashes
IDENTICAL; ROUTE moves 24 cells / 12 sentences, all `route→route`, and every one renders a
byte-identical step string — the field appeared, no reading changed; COMPILE moves the same 12, of
which 11 change a compiled colour and one ("make the jersey red and the shorts red") changes only the
frozen step, because her two colours are the same. Sweep 3.1's A2, the 152 GLOBAL_STYLE sentences,
F-WB6's adidas pair and the two-tone are all in the corpus and all unmoved.

Sweep 3.1's two guard tests were **rewritten, not deleted or loosened**. Both froze "make the jersey
red and the shorts black" with bare labels and asserted `unpaired_directive`; that sentence now
freezes, correctly, because she supplied the pairing. They moved to the guard's real domain — one
colour, two targets, `sole` false — and still refuse. **D6 moved silently and was decided before it
was pinned**: "make the socks blue, keep the jersey red" keeps its routing pin (`RECOLOR[socks|jersey]
blue`, blind to the per-target colour) while the compiled jersey goes blue → red. Adi ruled on
2026-09-18 that a keep carrying a colour is an INSTRUCTION, as D6 ratified, so a compile-level pin now
asserts socks→blue and jersey→red and the routing pin says in place that it cannot see this.

⚠️ **The two-tone is still not taken, and the reader now refuses it rather than merely not reaching
it.** A colour that runs on into a second colour ("make the shorts black and green and the socks
white") declines the WHOLE sentence: the label carries "black and green" where the step's value
carries "black", and F-WB7 measured that loss at 8 red cells. A3/R5 remain their own card.

`tools/wd/card2-option-b-run-predictions.md` holds the predictions written before the code and
`card2-revert-predictions.md` the revert checks, including the two whose predictions were wrong and
what the measurement said instead.

## The recon, as it stood when the card was parked

The recon found the per-target value binding is never DROPPED, it is never BUILT: rule 5's value is
`firstMatch` over the whole sentence — one colour, however many targets — and the pairing is left to
detection's region labels, which live wrote bare colours. The split was implemented and measured:

- corpus route tally **exactly as predicted** — ask→route 0, route→ask 0, ask→ask 0, route→route 7
  sentences;
- **but 7 jest tests went red**, and four of them pin composition's **decision 2a** verbatim:
  *"Dispatching 'make her jersey blue and make her socks red' would turn B-c2's one RECOLOR step into
  two — a change to a sentence that routes correctly, which composition's proof obligation forbids."*

So the card is not blocked by its blast radius; it is blocked by a ratified decision that forbids
exactly what it asks for. Two more reds are sweep 3.1's guard tests, which lose their exercising
sentence (the guard itself still covers "make the jersey and the shorts black", one colour, one
step); the seventh is D6's `keep the jersey red` pin.

⚠️ **The argument for re-opening 2a, for whoever takes this:** decision 2a rests on B-c2 being "a
sentence that routes correctly". It routes, but the per-target colour is recovered downstream from
detection's labels and **does not always survive** — B13, H5 and R6 block live for exactly that
reason. Patch and full diff kept in `tools/wd/card2.patch` and `card2-diff.txt`. **Superseded by option B
above; the patch is the rejected split, banked so nobody re-derives it.**

## Card 3 — (b) was a misdiagnosis

(a) is one entry on a closed list: `ADD_OBJECT` joins `ANTECEDENT_OPS`, and "add a headband and make
it red" routes. Both fences held, proved rather than argued.

(b) was "them distributes to only 1 of 2 garments". It does not. **C1's clause 1 already lost the
shorts**, in `scanTargets`, which only starts a phrase at a determiner:

| sentence                                 | routed                           |
| ---------------------------------------- | -------------------------------- |
| `make my jersey and shorts red`          | `RECOLOR[jersey]` — shorts gone  |
| `make my jersey and **my** shorts red`   | `RECOLOR[jersey, shorts]`        |

The resolver is fine; its antecedent is short. That is the same rule as A2's drop — so **A2 "by
design" and C1 "3 steps" cannot both hold.** Adi's call: keep A2, `scanTargets` untouched, and C1's
matrix cell corrects to 2 steps.

## Card 4 — A14 was not a vocabulary line

`blur the background` ALREADY routed. It died at the FREEZE with `missing_value`: rule 2's value is a
place after to/in/at/on/into, and a blur names none. There is no blur among the nine operations and
this adds none — a blur keeps the subject and changes everything else, which is CHANGE_BACKGROUND's
own contract. The value `blurred` and one template branch.

A15 found the two halves of the product **disagreeing**: the compiled prompt carried "matte black"
while the frozen step said "black", and only the step is queryable.

J7 shipped armband and scarf. **`add a captain's armband` still does not route, and the card does not
make it:** `TOKEN` carries no apostrophe, so "captain's" arrives as two words, and "captain" is not
on rule 4c's descriptor list — closed to colours and style words because the line between a
descriptor and a model name is not one a rule can see. It asks `worn_add_unclear`, which
`ASK_DECISIONS` already routes to the interpreter. What changed is that the paraphrase now lands.

## Card 5 — part 1 only

`hand`/`hands` join `HER_RESTING_PLACES` behind a closed `HAND_SIZED` list, and `in` gets its own
one-entry list read **only** for her hand. Four of the eight moved sentences were already in the
corpus as real product sentences ("put the gatorade bottle in my hand").

⚠️ **`in` is NOT an entry on `ADD_SURFACE_PREPS`, and the reason is worth keeping.** That constant is
spread into the interpreter's menu (`interpret/menu.ts`, `ADD_PREPOSITIONS`), which the prompt
renders verbatim — so an entry there reordered the rendered list and changed the prompt's TEXT,
which costs a `PROMPT_VERSION` bump and an R1 fixture re-record. The first build did exactly that and
two hash pins went red. The set never changed: **the menu already offered `in`**, and what was
missing was the classifier reading it back — a latent mismatch where the interpreter could propose a
preposition the rules then failed to route. Its own list closes that and leaves the prompt
byte-identical.

A15 had the same shape one layer up: `interpret/canonical.ts` mirrors rule 5's value expression to
predict what the rules will read back, so widening rule 5 without widening the mirror made
`make the jersey light blue` fail its own round-trip. Both are the same lesson — **the classifier's
vocabulary is not private to the classifier.**

Not built, and not absorbed:

- **the note** on a refused large object — needs its own ask copy (Mia's pile);
- **the anatomy-retry** — a generate-path change that doubles spend on a failing cell;
- **C8 `add my product to my hand`** stays `person_target`: "product" names her TILE, not an object,
  so its size is unknowable at routing time. Whether a bound product may go in her hand is a
  decision, and F-PA5 (a hand in the product photo) bears on it.

## Still open after this wave

| cell     | why                                                                        |
| -------- | -------------------------------------------------------------------------- |
| A3/R5    | two-tone values — a second discriminator, declined as a card-2 ride-along  |
| C1       | matrix correction to 2 steps                                               |
| B14/R8   | matrix correction — F-WB1 is an accepted cost                              |
| J7       | routes only via the interpreter's paraphrase                               |
| C8       | needs the product-size decision above                                      |
