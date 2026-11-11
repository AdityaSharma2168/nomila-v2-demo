# WAVE C — the copy sweep, and what the other two cards became

Three cards were scoped. One built, one shelved to the ledger, one plan-first.

| card                             | outcome                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1 · weak-ref detection at upload | **FADED** (Adi, 2026-09-17). Ledger only — F-PA5 amended to warn-only, F-WC1 opened. Nothing built.    |
| 2 · copy sweep                   | **BUILT.** Every placeholder string is real words. Table below is the acceptance, approved as written. |
| 3 · brand-aware ad fill          | **PLAN-FIRST.** Recon at $0 below; Adi's fork is A+C plus the brand widening.                          |

---

## CARD 2 — the copy table, as approved

Approved by Adi, 2026-09-17, including the three rows flagged as judgment calls (3, 9, 12). Two rows
could not be applied from this branch and are listed at the bottom with the reason.

### 1 · `frame_pick` — client/lib/studio-contract.ts

- **was** "You added more than one photo of you. Which one should change? Tap it in the tray — or make a new image from all of them."
- **now** "You added more than one photo of you, so we don't know which to edit. Tap the one that should change — or make a new image from all of them."
- "Tap it" had no antecedent once "Which one should change?" was the preceding sentence. The new line also says _why_ it is asking.

### 2 · `frame_with_likeness` — client/lib/studio-contract.ts

- **was** "… An edit only changes the marked photo — it can't use the others. …"
- **now** "… An edit only ever changes the marked photo, so the others wouldn't be used. …"
- "can't use the others" states our limitation; "wouldn't be used" states the consequence to her, which is the part she can act on.

### 3 · the frame card's two notes — client/screens/studio/CreateAnythingScreen.tsx ⚠️ vocabulary change

- **was** "Tap the photo you want to edit in the tray." / "Or tap a photo in the tray to change which one is marked."
- **now** "Tap the photo you want to edit." / "Or tap a different photo to edit that one instead."
- **"marked" is OUR word and never reaches her** — the badge she sees says EDITING. The second note now says what a tap _does_ rather than naming an internal state. This was flagged to Adi as the one row changing vocabulary rather than phrasing, and approved.

### 4 · `keep_conflict` — client/lib/studio-contract.ts **and** server/studio/nativeIntent.ts `ASK_NOTES`

- **was** "We couldn't make that change and still keep what you asked us to keep — a look or a new background changes the whole photo. Name just the thing to change, like \"make the socks blue\"; everything you don't name stays as it is."
- **now** "A look or a new background covers the whole photo, so it can't leave that part untouched. Name just the thing to change — \"make the socks blue\" — and everything you don't name stays as it is."
- "keep what you asked us to keep" was circular. Leads with the reason now, and drops a semicolon that was heavy for the register. **The example is unchanged, so its routing pin still holds.** The two copies are word-for-word identical, as before.

### 5 · the catch-all — `fast_path_declined` and the unknown-code fallback

- **was** "We're not sure what to change here. Try naming the thing and what it should become — \"the socks blue\", \"the logo off my sleeve\"." (fallback: the same without examples)
- **now** "We couldn't tell what to change here. Name the thing and what it should become — \"the socks blue\", \"the logo off my sleeve\"."
- "We're not sure" reads as a standing state; "couldn't tell" is about this attempt. "Try naming" → "Name" drops a hedge.
- `no_steps` was deliberately **left as it was** — not marked placeholder, and already specific (Adi: stays as-is).

### 6 · `new_image` — client/lib/studio-contract.ts **and** server/studio/nativeIntent.ts `NEW_IMAGE_NOTE`

- **was** "That reads as a new image rather than an edit of this photo — start a new image instead."
- **now** "That asks for a new picture of you, not a change to this photo — start a new image instead."
- "a new image … start a new image" repeated itself. "New picture" now describes the thing; "new image" names the affordance.

### 7 · the generate card's teaching line — NEW, client/screens/studio/threadLogic.ts + ThreadCards.tsx

- **now** "This makes a new image. Your photo is a reference for how you look — tap it to edit that photo instead."
- Shown on a GENERATE she attached a photo of herself to, and nowhere else. Frame defaulting made this the ordinary case — an unmarked photo of hers is her likeness for a new image — so the commonest send was silently picking the branch she was never asked about. Both branches are legitimate; nothing said which was happening.
- Deliberately not an ask and not a block: `new_image` and `frame_pick` already ask where a question is warranted. **Null in history**, where the tray "tap it" points at no longer exists.

### 8 · the pre-spend product note (C3) — server/studio/compile/disclosure.ts

- **was** "Your product photo will be used as the {thing}. …"
- **now** "We'll use your Product photo as the {thing}. …"
- Active voice — the assumption is ours and is owned in the first person. Capital-P **Product** because it names the tile she has to find to correct it.

### 9 · plural-You — client/lib/studio-contract.ts `numberRepeatedNames` ⚠️ behaviour change

- **was** three photographs of her → three BUILT FROM tiles all captioned **YOU**, and a screen reader saying "You. Open it." three times over three different thumbnails.
- **now** **YOU 1 / YOU 2 / YOU 3**; a name appearing once is untouched.
- Numbering is over the resolved **name**, not the role, so two Object photos become OBJECT 1 / OBJECT 2 by the same rule. Order is the engine's reference order, so "YOU 2" and the prompt's "Image 2" are the same photograph.
- MAX_PERSON is 3, so reference packs made this the ordinary shape rather than an edge case.

### 10 · the draft-badge note (F-CA4) — NEW, client/screens/studio/CreateAnythingScreen.tsx

- **now** "We'll try to edit this photo. If your words turn out to need a new picture, we'll make one instead."
- Shown only over **auto-mark's** badge, never over a mark she placed herself. The EDITING badge follows `autoMarkShape` on the draft answer; for an S2 ask the interpreter takes, the photo is marked only if the reading at send proposes. "put me mid-air dunking" is badged as she types, declined at send, and she gets a new image with the badge gone. The badge was a draft, but nothing said so, so it read as a promise.
- F-CA4 rules out hiding the auto badge (it would move D2's live badge). This tells the truth and leaves the badge where it is.

### 13 · the carry-on reply — client/screens/studio/CreateAnythingScreen.tsx ⚠️ found by Adi, not by the sweep

- **was** "Fine — then it is a generic one, not theirs. I will not pass it off as the real product."
- **now** "Then it will be a generic one rather than their actual product. Attach a photo of it any time and I will use that instead."
- Three things were wrong and only one was voice. **"Fine —" conceded a dispute she was not having** — she tapped a button we offered her, and that word invented an argument. **"I will not pass it off as the real product" puts the suspicion on her** rather than stating what we will do. And **it left her nowhere to go**, where every other line in this flow ends with an action.
- The commitment is kept rather than softened: "rather than their actual product" says exactly what the output will be. The register is Mila's — first person, no contractions, as in "That is what I was missing" — not the server's "we'll" voice from row 8.
- ⚠️ **The sweep did not find this line, Adi did.** It was never marked placeholder, so "every placeholder becomes real words" never reached it. **That is the scope hole worth recording: unmarked copy that is nonetheless bad.** The placeholder markers were a good index of what somebody had already doubted, and a poor index of what is wrong.
- **Three sites quoted the string and all three moved in one commit** — the string, a test NAME (`createAnythingLogic.test.ts`, "never 'then it is a generic one'" → "never the carry-on line"), and a comment (`createAnythingLogic.ts:90`). The test's assertion is behavioural and did not change; only the quotation would have rotted. That is the third instance of this pattern in this wave, after the prompt-hash pin's stale claim and one of wave B's test names.

### DROPPED — the QA card's honesty fix

**There is no client QA surface.** `grep creative_qa` over `client/` is empty; `generate.ts:1281` says the stage "RETURNS NOTHING … the return value is discarded, so no verdict can reach `assets`, the job row or the client". The incident that prompted the row was **the server log read by grep, not a screen** (Adi). Row dropped; the question is parked as **F-WC1**, with the approved sentence recorded there so it outlives the card.

### MOVED TO WAVE B — the two move-op rows

`move_target_absent` and `ambiguous_move` live on `studio/wave-b-paths`, not on main, so this branch
could never edit them. They were briefly listed here as a follow-up for wave C to land after the merge.

**They are wave B's now, and nothing is pending.** Adi approved the `ambiguous_move` rewrite directly to
that session, which landed it there — one word different from card 2's draft: _"we can't tell which ONE
to move"_. `move_target_absent` is unchanged. The wave-B session declined to act on the approval while
it only had it second-hand through this session, which was the right call: a relayed approval leaves
nobody able to say later who signed off on the words that shipped.

Two things were recorded there rather than lost:

- **The trade in the rewrite.** Cutting "Try a photo with just the one" removes the only half that
  offered her an action on the photo in front of her; what survives names the constraint and leaves
  nothing to do to _this_ frame. Made knowingly, on the grounds that a move we genuinely cannot
  disambiguate should not pretend otherwise.
- **A third option, with its bound.** Naming the distinguishing attribute ("the red one") keeps the
  target a noun and so keeps F-WB3's constraint — but it is narrower than it sounds: `MAX_TARGET_WORDS`
  is three, so "the red ball on the ground" does not fit, and detection has to actually find whatever
  attribute she names. "The red ball" plausibly; "the one on the left" never. It belongs with a widened
  target, not with this string.

---

## CARD 2 — proof

### Scoped suites, head vs base, test by test

Base `7d12dbc` in its own worktree, same seven suites, `--runInBand`, `--json`.

|              | suites |   tests |   red |
| ------------ | -----: | ------: | ----: |
| base 7d12dbc |      7 |     625 |     0 |
| this branch  |      7 | **636** | **0** |

**Added 11, removed 0, status flips 0.** The 11 are this card's own: six for `numberRepeatedNames`, five for the teaching line.

### Golden corpus — prediction, then recapture

**The prediction is derivable rather than remembered**, and is stated as such: the goldens that must move are exactly those whose stored payload contains one of the two changed server strings. Derived from the corpus independently of the test run:

- `placedProductNote` (row 8) → **4** goldens
- the `keep_conflict` note (row 4) → **1** golden
- **predicted total 5 of 110; the other 105 unmoved**

**Actual after `COMPILE_GOLDEN_CAPTURE=1`: 5 of 110 moved, 0 added, 0 removed** — the same five by name, with exactly one string replaced in each and nothing structural. Ordering note for honesty: the failing five were seen in the first suite run before the enumeration above was written; the enumeration is offered as a _checkable derivation_, not as a claim of foresight.

### Gates

- `check:types` — clean. (It excludes `**/*.test.ts`; the test files were compiled by running them.)
- `lint` — **equal to base**: 5 pre-existing `import/first` warnings in `nativeIntent.test.ts`, 0 errors. The sixth line is eslint declining to lint a `.json` file.
- `check:format` — **parity per touched file**, head vs base, on all 11. Four files were already unformatted at base and were left that way; `threadLogic.test.ts` was clean at base, drifted from this card's addition, and was reformatted back — that file only.

---

## CARD 3 — brand-aware ad fill

Plan-first, as asked. The recon ran at $0 and **the card's premise was wrong in a way that changed the
build**, so the recon is recorded before the decisions it fed.

### The premise: it was never a static "stadium"

There is no constant. The background is a MODEL SUGGESTION (`kind: "background"`, `source: "suggested"`,
`interpret/core.ts`), and the only fixed thing was the prompt's single format example, `"stadium at
night"`. The collapse is real but it is the model's, not a hard-coded value.

Measured on the committed R1 recording at `interpret/5` — 42 entries, 10 of them ads:

| brand     | suggested background                                                 | suggested headline                     |
| --------- | -------------------------------------------------------------------- | -------------------------------------- |
| adidas ×6 | stadium under bright lights (×5), modern stadium under bright lights | OWN THE FIELD / OWN THE PITCH          |
| nike ×2   | stadium under bright lights                                          | RISE TO THE CHALLENGE / RISE AND REIGN |
| puma ×1   | stadium under bright lights                                          | FOREVER FASTER                         |

**10 of 10 ads got a stadium, 9 of them the identical string, across three different brands — while the
headline varied by brand every single time.** The model reads the brand perfectly well. The background
was simply the one suggestion with nothing brand-shaped to reason about, because `AdTreatment` carried
`name` and `category` and nothing else.

(The Puma row is that brand's real slogan. Not a live defect: `headlineBound` refuses it and F-I5 drops
the suggestion alone. Checked rather than reported.)

### (1) Where the fill comes from, and what it could already see

`AdTreatment = { brand, category, swapTo, competitors }`, reaching the prompt as
`<brand>\nname: …\ncategory: …\n</brand>` — correctly delimited as data already.

### (2) The brand-attached path

`forPreview.adFor` already resolves a real row via `getBrandContext`, and **the preview route already
calls it and throws all but three fields away**. So the widening costs no new query. `BrandHalf` also
offers `tone.values`, `pieces`, `referenceImagery` and `competitors`; the three taken are the ones that
describe how a brand LOOKS and who it talks to, which is what a setting has to fit.

⚠️ **Palette is dead, and it is a finding rather than an omission.** `server/studio/brief.ts:426`:
_"NO source exists for this today — the field is present on zero of the brands in `inbox_brands`."_ A
palette-driven fill is not buildable at any price until a source exists.

### (3) The no-brand fork — Adi's call: **A + C together**

| option                                   | cost                                         | chosen                     |
| ---------------------------------------- | -------------------------------------------- | -------------------------- |
| A · register-derived variety pool        | 1 commit, one lazy query on the ad path only | ✅                         |
| B · defer to the unbuilt aesthetic field | $0, indefinite                               | —                          |
| C · stay static, sharpen the disclosure  | 1 commit, $0                                 | ✅ (beside A, not instead) |

### (4) Blast radius — different from the card's guess

- **Compile goldens: 0 of 110.** Predicted before the run and confirmed after: `source`
  (`yours`/`suggested`) does not survive into `FrozenEditIntent`, so by compile time a suggested
  background is an ordinary `BACKGROUND` change, and brief gaps are brief-tier, not compile-tier. None
  of the five strings card 3 touches appears anywhere in the corpus. The card's guess that "every ad
  golden carries the static fill" does not hold — **no compile golden carries an ad treatment at all.**
- **The real gate is `PROMPT_VERSION`.** `recorded.ts:62` throws on any recording whose version differs.
  The bump to `interpret/6` invalidates **all 72 recorded replies** (r1.json 42, scene.json 30).

### What was built

1. **The brand widening.** `AdTreatment.profile` carries `contentStyle`, `audience` and
   `recentCampaigns`, sanitised; the `<brand>` block states them as `key: value` lines.
2. **Fork A.** `AdTreatment.register` carries her sport and level, and a new `<athlete>` block states
   them — read **only** on the no-brand-row branch, through a thunk, so an ordinary preview pays nothing.
3. **Fork C.** Both disclosure lines rewritten (see below).
4. **Rule 3a**, naming what a background should fit and in what priority order.

### ⚠️ Untrusted content — the part that needed the most care

`inbox_brands.enrichment` is derived from **inbound brand email**. A brand that mails her controls,
transitively, every field added here. Two defences, both required:

- **Placement** — inside the existing `<brand>` block, already introduced as data, never an instruction.
  Nothing new sits outside a delimiter, and the introduction is strengthened to say so explicitly.
- **Shape** — `sanitizeBrandField` strips angle brackets (so no value can forge `</brand>`), collapses
  all whitespace including newlines (so no value can mint a second `key:` line), caps length at 120, and
  caps a campaign list at 3. Eight adversarial tests, including the forged-closing-tag and injected-line
  cases.

### The sport precedence — not optional

`brief.ts` records job **e4814552**, live 2026-09-09: profile _Basketball_, direction _"create an adidas
soccer ad featuring me"_, output a basketball court, a basketball in her hands, a soccer ball at her feet
and a caption reading _"Wait, soccer? … #basketball #soccer"_. Carrying two sports is what did it. So
`resolveRegister` drops the profile sport whenever her own sentence names one, using the same
`namesSport` vocabulary `athleteHalf` uses, so the two cannot drift. Pinned by test.

### Fork C — the two lines

- **was** "No brand on this job, so nothing is tailored to a partner's tone, palette or product."
- **now** "No brand on this job, so nothing is tailored to a partner's tone or product. What is made is fitted to you instead — your sport and level."
- Both too broad (something _is_ tailored now) and too narrow ("palette" implied one would be used if a brand were attached, and none exists for any brand).

<!-- -->

- **was** "No first-class aesthetic or visual-identity field exists on an athlete today; the register below is derived from her level and credential only."
- **now** "No first-class aesthetic or visual-identity field exists on an athlete today. The register below stands in for one and is derived from her sport, level and credential alone — enough to fit a setting to her, not a visual identity."
- It omitted the SPORT, which `athleteHalf` puts in the register and which is the field a setting turns on, and read as a pure apology when the register is now load-bearing.

### Proof

Sixteen suites, head against base `7d12dbc`, **suite lists compared and identical** (not just totals):

|              | suites |   tests | failed-to-run |              red |
| ------------ | -----: | ------: | ------------: | ---------------: |
| base 7d12dbc |     16 |     574 |             0 |                0 |
| this branch  |     16 | **589** |         **0** | **2 (expected)** |

- **Added 16**: 8 sanitiser, 7 register/precedence, 1 the renamed prompt-hash test.
- **Removed 1**: that test's old name.
- **Status flips 2**, both `passed → failed`, both the stale-recording assertions — **by design and
  listed below**, not regressions.
- **Goldens: 0 of 110 moved**, predicted first.
- `check:types` clean. Format parity per touched file, head vs base, on all 12 — including
  `routes/studio.ts` and `brief.ts`, which were already prettier-dirty at base and were **restored and
  re-edited by hand** after a `--write` reformatted them wholesale (1,461 and 209 lines of churn, now 36
  and 15).

### The two red, and the ONE run that clears them

`interpret/recorded.test.ts` and `interpret/scene.test.ts` replay recordings keyed to
`PROMPT_VERSION` and throw when it moves. **A red suite does not merge**, so the recorder was
extended rather than the redness explained away.

**`scene.json` had no recorder in the repo.** It came from `tools/am/sceneProbe.ts`, which lives
outside the worktree, writes to its own output path, and only ever sent twelve of the thirty — so the
fixture could not be regenerated from anything committed, and the bump would have left that suite
permanently red. Its 30-sentence set is rebuilt from the fixture's own entries and folded into
`studioInterpreterRecord.ts`, so **one `--run` now re-records both files**.

Three things that make the cost and the coverage come out right:

- **Eleven of the thirty are already R1 cases**, with identical `objects` and `brand` — checked, not
  assumed. They are one call whose reply is written into both files, so covering `scene.json` costs
  **nineteen extra calls, not thirty**.
- **Four scene sentences are claimed by the rules now** (wave A's V2, V3 and V4 — "add these gold
  hoops", "make a pic of me training in the gym", "take the logo off my sleeve", "make the sky
  moodier"). R1's filter would never send them. They are sent anyway, because `scene.test.ts` pins all
  thirty and its `CLAIMED_BY_RULES` map exists to say "a rule reads this now, and here is what the
  interpreter made of it anyway". Carrying the old replies forward instead would put `interpret/5`
  answers inside a file stamped `interpret/6` — the exact dishonesty the version gate prevents.
- **Both "none added, none lost" pins hold**: the run sends 42 R1-eligible and all 30 scene, against
  `recorded.test.ts`'s pinned 42 and `scene.test.ts`'s pinned 30. Verified on the dry run.

**The recorder now sends what production sends.** It used to build the ad's treatment from name and
category alone, which is what the request path sent _before_ card 3. It now reads the brand's real
`inbox_brands` row through the same lookup `forPreview` uses, and her register under her own athlete
id — so a re-recorded ad cell exercises the widened `<brand>` block and fork A's `<athlete>` block
instead of replaying the old shape. `recordedInput` gained optional `profile`/`register`, defaulting
null so every existing caller still describes exactly the call it made.

**Adi fires this; nothing here runs it.** Dry run is free and prints every sentence and the quote:

```
npx tsx --require dotenv/config server/scripts/studioInterpreterRecord.ts
npx tsx --require dotenv/config server/scripts/studioInterpreterRecord.ts --run --cap 0.32
```

Dry run at `interpret/6`: **60 of 64 sentences eligible, quote ~$0.240.** The cap is **0.32** and not
the script's 0.25 default, because 0.25 sits below the quote and would budget-stop the run partway
through — leaving both fixtures half-written. Actual spend will be well under the quote (R1's original
42 calls billed ~$0.06 against the same $0.004-per-call estimate), but the cap has to clear the
estimate, not the outturn.

⚠️ **Neither suite can be verified green from here** — that needs the recording to exist. What is
verified is that the run will produce the right entries in the right files at the right version.

---

## CARD 4 — a pointed replacement reads the Product tile

Live: "replace the earrings with these gold hoops" with the hoops in the **Product** tile asked her to
attach them with the **Object** tile — advice she had already taken, about a photo already in the
request. A product of hers worn in place of what she has on is product placement, which is what the
Product tile is for. C3 shipped that binding for adds and deferred replacements; this is that card.

### Why the blast radius is provable rather than hoped for

`attached.objects` is read in **exactly one place** in the classifier (the `object_photo_missing` gate)
and `reference: "object"` is set by **exactly one rule** (3½). So handing the freeze's _placeable_
count in can reach a pointed replacement and nothing else — not an add, a removal, a background, a look
or a brand change. **Adi's control cell holds by construction, not by luck**, and the probe confirms it.

### ⚠️ THERE WERE TWO GATES, NOT ONE — and the first fix looked like it worked

Changing `route`'s count made the golden's _copy_ move while the case still asked, which read as "the
change had no effect". A direct probe of the freeze showed `placeable = 1` and `route` returning
`MASKED`, so the refusal had to be downstream — and it was: the `REPLACE_OBJECT` case re-checks
`objects.length` and binds `objects[0]`. **A second gate on the same question, which had to move with
the first.** Worth recording because the symptom (copy moves, behaviour does not) looks exactly like a
stale cache, and clearing the cache is the wrong thing to chase.

### The tray states, probed head against base

| tray                                    | base 82f862f                  | this branch                                     |
| --------------------------------------- | ----------------------------- | ----------------------------------------------- |
| Product only                            | asks `object_photo_missing`   | **compiles, bound to the product**              |
| Object only                             | compiles, bound to the object | unchanged                                       |
| both                                    | object wins                   | unchanged                                       |
| two products                            | asks `object_photo_missing`   | **asks `ambiguous_object`** — the which-one ask |
| two objects                             | asks `ambiguous_object`       | unchanged                                       |
| neither                                 | asks                          | unchanged                                       |
| "swap my cleats for these" + Product    | asks                          | **compiles, placement inherited**               |
| **CONTROL** "add my product to my hand" | refuses `person_target`       | **identical**                                   |

⚠️ **One deviation from the card as written, flagged not silently resolved.** The card said "both
attached → the existing which-one ask". It is not an ask today and this branch does not make it one:
the Object tile wins, which is exactly what C3 does for an add (golden: "an Object photo beside her
product is the thing"). The which-one ask is what **two of the same tile** gets. Bullet 2 of the card
("Object tile attached → unchanged") is satisfied; say the word if you want both-attached to ask.

### Corpus — predicted first, then run

**Predicted: 2 of 115 move**, named in advance — the PRODUCT replacement (ask → compiles, and its name
made false) and the no-photo case (ask copy only). **Actual: exactly those 2**, 0 added, 0 removed.

The fixture set then changed deliberately: the retired refusal became four fixtures — the PRODUCT path,
the inherited placement, the two-product ask and the Object-wins control — so **115 → 118**, and the
hand-written count guard moved with it.

### The gate was widened because the narrow one was wrong

⚠️ **My scoped set missed two suites that card 2 and card 3 had already broken**: `preview.test.ts`
pinned the old placed-product copy, and `brief.test.ts` held four snapshots of fork C's disclosure
lines. Both were red and neither was in the set I had been running. The gate is now the whole studio
surface — `server/studio`, `server/routes/studio`, `client/` — rather than a list I chose.

|              |  suites |    tests | failed-to-run |   red |
| ------------ | ------: | -------: | ------------: | ----: |
| base 82f862f |     106 |     3183 |             0 |     0 |
| this branch  | **106** | **3213** |         **0** | **0** |

**Suite lists identical, 0 status flips.** The large added/removed counts are the `interpret/5` →
`interpret/6` describe rename moving ~88 test names on both sides; net new coverage is +30.

### Pins that assert the opposite of what they used to

Two tests existed to assert that a product is _not_ a replacement's photo — "a product is not one (C3's
scope)" and "counts a PRODUCT photo as no photo of the thing". Card 4 overturns both claims, so both
names and both bodies flip rather than being deleted, and a new pin keeps the case they used to cover:
**neither tile still asks**. The two-product refusal also gained product-aware copy, because "more than
one object photo is attached" is false of two photos in the Product tile.

### Revert check — predicted by name, then run

Both gates reverted to `objects`, the named pins run, then restored (the tree is byte-identical to the
committed card afterwards).

|                                                                               | predicted | outcome  |
| ----------------------------------------------------------------------------- | --------- | -------- |
| RC-1 `…reads her PRODUCT photo too (card 4)`                                  | RED       | ✅ red   |
| RC-2 `takes her PRODUCT photo as the thing when the Object tile is empty`     | RED       | ✅ red   |
| RC-3 golden `her hoops as a PRODUCT…`                                         | RED       | ✅ red   |
| RC-4 golden `a PRODUCT with no place in the sentence…`                        | RED       | ✅ red   |
| RC-5 golden `two PRODUCT photos: it asks which…`                              | RED       | ✅ red   |
| RC-6 golden `an Object photo beside her product is still the thing (control)` | GREEN     | ✅ green |
| RC-7 `still asks when NEITHER tile has a photo`                               | GREEN     | ✅ green |

**5 of 5 predicted red went red; both predicted green held. One RED was not predicted** and is recorded
rather than quietly absorbed: `the golden set itself › covers every operation a native edit compiles`.
Reverting turns a compiling fixture back into a refusal, which drops `REPLACE_OBJECT` out of the
op-coverage guard. That the guard notices is the guard working — but the prediction should have said so,
and did not.

---

## CARD 4 — THE LIVE FAIL, AND THE THREE GATES THE FIRST PASS MISSED

Adi, live on `5832ee0`: "replace the earrings with these gold hoops" with her photo as the source.
Object tile → REPLACE plan, $0.30, bound. **Product tile → GENERATE mode, "1 of 1 frames invented",
the ask showed the new copy and asked anyway, and BUILT FROM listed only the PRODUCT.** Her frame was
gone from a request that had one.

### Why the first proof did not catch it

Card 4's proof was a **constructed call straight into `freezeEditIntent`** with a hand-built references
array. That skips the entry entirely. **The same bypass class as pinning `route()` and calling the
request path covered** — a fix proved below the entry point is not proved.

### There were FIVE places that counted this question, not two

| #   | site                                | what it gated                          | first pass |
| --- | ----------------------------------- | -------------------------------------- | ---------- |
| 1   | `freezeEditIntent` → `route(...)`   | the classifier's ask                   | ✅ moved   |
| 2   | `REPLACE_OBJECT` case in the freeze | the bind                               | ✅ moved   |
| 3   | **`attachedIn`**                    | **what the PREVIEW ROUTE counts with** | ❌ missed  |
| 4   | **`objectPhotosIn`** (client)       | **what `/studio/classify` is told**    | ❌ missed  |
| 5   | **`readNativeIntent`**              | **whether the frozen intent may RUN**  | ❌ missed  |

Sites 3 and 4 are why it asked at the entry and fell back to a generate. Site 5 is what it hit _next_,
once 3 and 4 were fixed: the validator re-read the intent the freeze had just bound to a product and
called it _"saved in a form we can't run any more"_ — **a validator disagreeing with the thing it
validates, telling her a true request was stale.**

### The fix: one definition, read everywhere

`attachedIn` now _is_ the rule — _her Object photos, or, when the Object tile is empty, her Product
photos; never summed_ — and the freeze **reads it rather than repeating it**. They agreed the first time
too; the route did not. Deriving the number from the shared function is what makes divergence
impossible rather than merely unlikely. The client's `objectPhotosIn` carries the same rule with a
comment naming the server function it must agree with.

### Proved through the HTTP path this time

New pins in `routes/studio.native.test.ts` drive `POST /studio/preview` with the hoops as a PRODUCT.
**The pin was written first and reproduced Adi's failure** (`blocked`, not `ready`) before any fix.

And the outcome is stronger than "it works": the Product-tile prompt is now **byte-identical to the
Object-tile prompt** — 5 lines, zero diff — which is C3's parity property extended to replacements.
Before the fix the Product case compiled the _masked/retouch_ prompt: a different implementation at a
different price, which is exactly what `nativeBlocker` exists to stop.

### Gate, re-run whole-surface

|              |  suites |    tests | failed-to-run |   red |
| ------------ | ------: | -------: | ------------: | ----: |
| base 82f862f |     106 |     3183 |             0 |     0 |
| this branch  | **106** | **3215** |         **0** | **0** |

Suite lists identical, 0 status flips. Two goldens moved (masked → native, and both now equal to the
Object-tile golden); two pins asserting the old scope flipped, each gaining a case that keeps its real
guard — a photo the brief does not carry is still invalid, whichever tile it claims to be in.

### ⚠️ The copy nit is NOT reproduced, and I am not guessing at it

"With a Product attached and no source frame, the ask should point at tapping a photo, not attaching a
thing." I could not reproduce it from the code:

- `classify.ts:199` — with `hasSourcePhoto` false, `route` returns **GENERATE** and never reaches
  `object_photo_missing`, so the server cannot be the source of that ask.
- `createAnythingLogic.ts`, `whatIsMissing` — already returns `"photo"` when the sentence needs her and
  no `source-frame` is attached, which shows the "Add a photo of you" card, i.e. already the right copy.

So either the trigger is a sentence `NEEDS_HER` does not match, or it is a path I have not found. **The
log tail referenced in the report did not arrive**, so this is open and un-guessed rather than silently
"fixed". The exact sentence and tray state would settle it in one run.
