# SWEEP #4 — LEDGER

> **Started 2026-09-11 with the text-rendering finding.** No earlier sweep-4 ledger was found in the
> repo, on any branch or worktree, in Downloads, in Drive or among the published artifacts. The only
> on-disk record of the sweep is the dev server's log for 00:46–01:15 that night, cited below by
> timestamp. If the ledger lives somewhere else, these entries move there as written.

Verdicts are **Adi's** unless marked otherwise, in the sweep's vocabulary (CLEAN / ARTIFACT /
PARTIAL / FAILED). F-T's was recorded from Claude's 1:1 read, at Adi's instruction. The
observations are the probe's and are deliberately not verdicts.

**The interpreter** cites this ledger throughout: the plan is
[docs/plans/studio-interpreter-plan-v2.md](../plans/studio-interpreter-plan-v2.md) (on
[v1](../plans/studio-interpreter-plan-v1.md)), and its §14 records where each entry below landed — F-T and
F-I1/F-I2 in PR T, F-C and F-R in its I.1, F-E and F-T2 at R2, F-I3 and F-I4 as deferred fixes.

---

## F-T · Text rendered in-model — the ad-treatment decision. `[model tier]` — **CLEAN / CLEAN: in-model text is viable**

**This one verdict decides the ad-treatment feature's architecture: text rendered in-model, or text
composited outside the model.** The question is only this: is the text legible and correctly
spelled, or garbled?

**Run.** `studioModelNativeProbe.ts --q 6 --run --cap 0.34`, 2026-09-11. Direct router, the way
Q1–Q3 ran: no classifier and no compile. The prompts were sent verbatim because the product path
cannot carry them (F-I2). The run refused to spend unless `image.edit` resolved to the shipped model
with no override, and it did: `gemini-3-pro-image` via Vertex. Q1 frame `afc78262` (1008×1476), 2K,
ratio pinned `2:3` (what `aspectFor` asks for on this frame). **$0.2688 billed**, $0.3308 quoted.

| cell  | prompt                                                                                                                                                                                        | out dims  | aspect Δ | latency | cost    | verdict |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------- | ------- | ------- | ------- |
| q6-t1 | Add a large banner across the top of the background that reads GET LOUD in bold white capital letters. Keep the person, her pose, clothing, lighting and everything else exactly as they are. | 1696×2528 | 1.763%   | 27.4s   | $0.1344 | CLEAN   |
| q6-t2 | Add a small adidas logo with the words IMPOSSIBLE IS NOTHING beneath it in the upper right corner of the background. Keep everything else exactly as it is.                                   | 1696×2528 | 1.763%   | 23.3s   | $0.1344 | CLEAN   |

**For the 1:1 read:** open at 100%, not zoom-to-fit.

- `probe-out/q6-t1-text-1x1.png`: 1696×560 from `0,0`, the banner.
- `probe-out/q6-t2-text-1x1.png`: 516×420 from `1180,0`, the logo block.
- `probe-out/q6-t1.png` and `probe-out/q6-t2.png`: the full outputs.

The crops are extracted from the outputs and never resized, so every pixel is one the model returned.

**Observed** (the probe's, not verdicts):

- **t1:** "GET LOUD" in white bold sans capitals on a dark maroon fabric banner, with grommets along
  its edges. It spans the full width where the empty stands were, and it was rendered as a physical
  stadium banner that is soft-focused with the rest of the background. Her head is in front of it and
  hides the foot of the L, which is the correct depth order.
- **t2:** an adidas trefoil, a lowercase "adidas" wordmark with ®, and "IMPOSSIBLE / IS NOTHING" in
  two lines of condensed bold white capitals. This one is a flat overlay graphic, not something placed
  into the scene.
- **Two brand observations on t2.** Neither is about rendering; both marks rendered cleanly.
  - `[Mia]` `[recalibration]` **Trefoil vs three-bar, inconsistent across calls.** Asked only for
    "an adidas logo", t2 drew the trefoil (the Originals mark) where q3-b drew the three-bar mark.
    Which mark a campaign may use is a brand call. That the model picks differently from one call to
    the next is something a check has to catch.
  - `[Mia]` `[recalibration]` **adidas rendered onto a Nike frame.** She wears Nike (the swoosh on
    the jersey, Nike cleats), and t2 put the adidas mark and tagline over it. It is the mixed-brand
    case q3-b logged, and it weighs more on an ad treatment, where the mark is the deliverable.
- **Both:** STANFORD, the 8, the swoosh, the S crest and the green armband survive at full-frame
  scale.
- **Patch windows:** the top-left and top-right windows sit where both cells were told to put text,
  so t1's 76.3 / 70.6 and t2's 36.7 top-right measure the insertion, not preservation. t2's top-left
  reads 4.3, in line with Q1/Q5. Mid-left is the boards window, at **15.15 on both**. That matches
  the stable ~14.8–15.0 of q1-a-ratio and every Q5 path-B cell: a property of full-frame on this
  frame, not of text.

**Reach of the result.** n=1 per cell, one frame, and short headline strings (two words; three words
plus a wordmark). A pass says the model renders short display text on this frame. It does not
measure long copy, small point sizes, or spelling stability from run to run. Q4 is the reminder that
a single run can mislead on this model.

**Verdict (Claude's 1:1 read, recorded at Adi's instruction, 2026-09-11):** t1 — **CLEAN** · t2 —
**CLEAN**. Both are legible and correctly spelled at native pixels:

- t1: G-E-T L-O-U-D evenly weighted and following the banner's folds, and the foot of the L
  correctly behind her head.
- t2: the trefoil's three leaves and three cuts, "adidas" and the ® crisp, and IMPOSSIBLE / IS
  NOTHING with no malformed or doubled glyph.

Adi's own look at 1:1 overrides this line if it disagrees.

**Decision: in-model text is viable.** The ad treatment renders text in the model, within the reach
above. Long copy, small point sizes and run-to-run spelling are not measured yet.

---

## F-I1 · "add the text X" has no operation, so it ASKs. Correct fail-closed. `[interpreter tier]`

- **Sweep 4, 01:05:55:** `classifier fell through to ASK`, `fast_path_declined`, extracted targets
  `"text get loud"` and `"top"`. Nothing spent.
- **Replayed on b9ad08b** (`route()` and `freezeEditIntent`, both pure, $0): the same ASK. The
  freeze refuses `not_routed`, and the preview carries the generic rephrase note ("We couldn't pin
  down exactly what to change from that. Name the thing and what it should become…").
- **Correct as a refusal.** No fast-path rule claims the sentence. The only text-bearing operation,
  APPLY_DESIGN, puts text on a region.
- **Gap, now that F-T is CLEAN:** text needs a front door. The current note tells her to "name the
  thing and what it should become", which does not fit a text ask. That is a copy item for as long
  as it stays an ASK.

## F-I2 · The banner phrasing half-extracts, or fails OPEN. One preposition decides. `[interpreter tier]` `[classifier-fix]` — **FIXED in `f92b432`**

- **Sweep 4, 01:15:15:**
  - Detection found a background scope.
  - The sentence froze as a background change with **no value**, and the freeze refused
    `missing_value`.
  - The preview showed the same rephrase note ("couldn't pin down").
  - This is the half-extract: the operation came out and its value did not. It failed closed, and
    nothing was spent.
  - The sentence itself isn't in the log (statements are not logged). It is on preview
    `b4c893e9-277a-40ff-98b8-6136df27d571`.
- **Mechanism:**
  - Rule 2 (`classify.ts:806`) matches any sentence that names the background, including as a
    location ("the top of the background").
  - It takes the new background from the first `to|in|at|on|into …` phrase anywhere in the sentence
    (`classify.ts:807–809`).
  - A banner sentence with no such phrase half-extracts. The same sentence with one such phrase
    **freezes with a junk value**.
- **Replayed on b9ad08b** through `freezeEditIntent` and `compileNativeInstruction` (pure, $0):

| sentence                                                                          | freeze                   | compiled instruction, first clause                            |
| --------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| Add a banner across the top of the background that says GET LOUD                  | refused, `missing_value` | —                                                             |
| Add a banner across the top of the background that says GET LOUD in white letters | **frozen**               | change the background to white letters                        |
| add a GET LOUD banner to the background                                           | **frozen**               | change the background to background                           |
| q6-t1's sentence                                                                  | **frozen**               | change the background to bold white capital letters           |
| q6-t2's sentence                                                                  | **frozen**               | change the background to upper right corner of the background |

- **What a frozen one costs her:** a ready preview at $0.1654 and, if she approves it, a background
  replacement she did not ask for.
  - These sentences were **not** run through the preview route, because detection is billable.
  - The sweep-4 banner sentence reached the freeze by the same detection → brief path, so nothing
    upstream of the freeze is known to stop them.
- **This is sweep 3's value bug with a new trigger.** Sweep 3 had "change the background to her
  feet" (B-c11, B-c14). Here "background" is a place in the sentence, not the thing being changed.
- **The half-extract is the lucky case.** The fail-open is the finding.

**Fixed in `f92b432` (studio/text-render-probe): a background named only as a place now asks.**

- **How it tells them apart:** by the lead verb's object, meaning the words after a change verb up to
  the first preposition. "of" is the exception, because "the colour of the background" is the
  background.
  - A setting noun inside the object is a change of setting, and rule 2 reads the sentence exactly
    as before.
  - An object that is something else, with a setting noun after it, is a change that happens in the
    setting. That sentence asks.
- **Why it asks instead of falling through:** below rule 2 it gets worse. Rule 4½ cannot place
  "across the top of…", and rule 5 reads "…in white letters" as a recolour:
  `RECOLOR [banner across, top, …] white`. That was measured with the setting noun swapped out.
- **It decides only where it is certain.** Every other sentence reaches rule 2 unchanged: a lead
  word that is not a change verb, an empty object ("change to a beach background"), an object led by
  a pronoun, "put me in…", and "…behind me".
- **Route diff:** main b9ad08b against the fix, over every quoted string in the Studio test files
  (3,409), each with and without a photo.
  - **5 moved.** All were a `CHANGE_BACKGROUND` misroute that now asks. They are exactly the five
    sentences in the table above.
  - **Nothing else moved:** 0 ASK → route, 0 reason changes, 0 routes with changed steps. No
    sentence already in the corpus moved.
- **Pinned** in `classify.test.ts` and `nativeIntent.test.ts`:
  - T1 asks with `add_unclear`, and T2 with `fast_path_declined`.
  - Every moved sentence asks.
  - Ten background-as-the-thing sentences route exactly as on main.
  - Neither T sentence freezes.
- **Checks:** the three F-I2 pins fail on b9ad08b's classifier and pass on the fix. The Studio
  suites are 53 / 1,717 / 0 red.

**Residual — deliberately not touched.** The fix had to change zero routes, so these stay:

- **"replace the background with a stadium at night" routes as `CHANGE_BACKGROUND "night"`.** Rule
  2's value regex has no `with`, so it takes the first phrase it does know. The operation is right and the value is
  wrong: the same value bug, reached from a real background change. `[classifier-fix]`
- **An object led by a pronoun is not read.** "make her jersey red in this scene" still routes as
  `CHANGE_BACKGROUND "this scene"`. The check declines to decide, because "her" is a determiner as
  often as it is her, and "make me stand in a stadium scene" really is a change of setting.
- **Rule 2's value extraction is unchanged.** The fix removes one trigger, not the bug. Composition's
  per-clause dispatch and this rule are the two fences around it.

---

_The two entries below are A13's (the interpreter plan): Adi confirmed their substance on 2026-09-12, and
they were recorded here with the interpreter's compile commit, before anything cites them._

## F-C · Four changes in one call: all four landed, n=2. `[model tier]` — **CLEAN (Adi's live verdicts, sweep #4 session)**

- **Source.** Adi's live verdicts in the sweep #4 session, about 01:00 on 2026-09-11 (the blue-kit image).
- **Cell.** "make her jersey blue, make her socks red, add a soccer ball at her feet, and change the background to a stadium": RECOLOR · RECOLOR · ADD_OBJECT · CHANGE_BACKGROUND, compiled into one native call.
- **Observed.** Both runs landed all four changes, and STANFORD and the 8 were re-rendered legibly.
- **What it supports.**
  - No splitting below the step cap: one call carries up to `MAX_STEPS` = 4.
  - Composition's one-call design stands, and D″ (the orchestrator) stays parked.
- **Reach.**
  - n=2, on one frame, with one combination of operations.
  - No text change was in the cell. A four-change call that includes a display line has not been measured.

## F-R · Tiny-target removal: silently skipped in a compound, hard-failed alone. `[model tier]` — **FAILED (Adi's live verdicts, sweep #4 session)**

- **Source.** Adi's live verdicts in the sweep #4 session, 2026-09-11.
- **Target.** A small Nike swoosh.
- **Observed.**
  - **In a compound run,** the removal was silently skipped: the other changes landed, the swoosh stayed, and nothing reported it.
  - **In the solo run,** it hard-failed. That's the dev-server log lines at 01:06:50–01:06:54 (preview `2565aaa7…`, job `a9485125…`): "Vertex returned no image data".
- **Contrast.**
  - Removing a larger logo on another frame worked.
  - Replacing a target of the same small size worked.
- **What it decides.** The interpreter never compiles "if there are any X logos, remove them" into a removal of each small logo. It reads the clause as an exclusion across the photo, plus replacements of the items that carry the logos (plan v2 §6). R2 measures the exclusion clause before it ships (M4's engineering gate).
- **Reach.** One small-logo target, compound and solo. The size threshold is not measured.

---

_The two entries below were found at $0 while building the interpreter (studio/interpreter), replayed on main
`7bbe608` through `route()`, `freezeEditIntent` and `compileNativeInstruction` — pure, no model, no row.
Neither is fixed there: that PR's route diff must stay zero rows. Both are fix-PR candidates for after it
lands. Each entry carries its own repro sentences; plan v2 §14.2 lists both as deferred._

## F-I3 · Rule 2's value eats the first letters of a setting: "an arena" freezes "n arena". `[classifier-fix]` — **LIVE on main**

- **Mechanism:** rule 2 takes the new setting from
  `/\b(?:to|in|at|on|into)\s+(?:a|an|the)?\s*([a-z][a-z -]{0,40})/i` (classify.ts, rule 2). The
  optional article has no word boundary after it, and alternation tries `a` first. So "an arena" matches
  `a`, the `\s*` matches nothing, and the capture starts at "n arena". An article-less setting that starts
  with "a" or "the" loses those letters the same way.
- **Repros** (main `7bbe608`):

| sentence                                         | frozen value             | compiled instruction, first clause              |
| ------------------------------------------------ | ------------------------ | ----------------------------------------------- |
| change the background to an arena                | `n arena`                | change the background to n arena                |
| change the background to an empty arena at night | `n empty arena at night` | change the background to n empty arena at night |
| change the background to an ocean at sunset      | `n ocean at sunset`      | change the background to n ocean at sunset      |
| put me in an indoor gym                          | `n indoor gym`           | change the background to n indoor gym           |
| put me on an island                              | `n island`               | change the background to n island               |
| change the background to arena                   | `rena`                   | change the background to rena                   |
| change the background to athletics track         | `thletics track`         | change the background to thletics track         |
| change the background to theater stage           | `ater stage`             | change the background to ater stage             |
| change the background to a stadium at night      | `stadium at night`       | change the background to stadium at night       |
| change the background to the beach               | `beach`                  | change the background to beach                  |

- **Reach:** every vowel-initial setting written with its natural article "an", through both of rule 2's
  doors ("change the background to…", "put me in/on/at…"), and every article-less setting that starts
  with "a" or "the". The mangled value reaches a ready preview and, if she approves it, the paid prompt.
- **Not in the corpus:** none of the 3,864 quoted strings in the Studio test files exercises it — all 37
  routed backgrounds there are word-aligned — so no route or compile diff ever showed it.
- **The interpreter works around it** (studio/interpret/canonical.ts): its C always says
  "…to the <setting>", which that regex consumes whole whatever the setting starts with, and its round trip
  checks the frozen value regardless. Sentences she types are unchanged.
- **The fix, for its own PR:** a word boundary after the article (`(?:(?:a|an|the)\s+)?`), with a route
  diff whose only moved rows are these values becoming her words.

## F-I4 · A quoted headline beside a place routes as an ADD of an object named by her words. `[classifier-fix]` — **LIVE on main**

- **Mechanism:** the tokenizer drops quotes, so `add "GET LOUD" at the top` reaches rule 4½ as
  "add get loud at the top": a one-to-three-word thing and a place it reads. Rule ⅛ does not claim it —
  only its strict `add the headline "…" across the top` shape is a headline (PR T, departure 3), and that
  holds with STUDIO_DISPLAY_TEXT on or off.
- **Repros** (main `7bbe608`, the switch either way):

| sentence                        | route                                     | compiled instruction, first clause         |
| ------------------------------- | ----------------------------------------- | ------------------------------------------ |
| add "GET LOUD" at the top       | `ADD_OBJECT [get loud] "at the top"`      | add a get loud, place it at the top        |
| add "RISE UP" at the top        | `ADD_OBJECT [rise up] "at the top"`       | add a rise up, place it at the top         |
| add "GAME DAY" beside me        | `ADD_OBJECT [game day] "beside me"`       | add a game day, place it beside the person |
| add "GO" at my feet             | `ADD_OBJECT [go] "at my feet"`            | add a go, place it at the person's feet    |
| add "GET LOUD" to the top       | `ADD_OBJECT [get loud, top] "to the top"` | add a get loud, place it to the top        |
| add "OWN THE MOMENT" at the top | ASK `add_unclear` (four words)            | —                                          |
| add "GET LOUD" across the top   | ASK `add_unclear`                         | —                                          |

- **What it costs her:** an add is region-free, so the preview runs no detection and, with
  STUDIO_NATIVE_EDIT on, is READY at $0.1654 quoted for an object called "get loud" — the F-I2 class, her
  headline read as an instruction, arriving through rule 4½ instead of rule 2.
- **Not in the corpus:** no quoted test string routes as an add of its quoted words.
- **The interpreter never sees it** — it routes — and never produces it: its headline is always rule ⅛'s
  strict shape.
- **The fix, for its own PR:** a quoted phrase is never an add's thing (rule 4½ reads the raw sentence
  for quotes, as rule ⅛ does), with a route diff whose only moved rows are these, route → ASK.

---

_The two entries below are R2's — the interpreter's engineering gates (plan v1 §7, v2 §5/§6, M4, C-8) —
run by Adi on 2026-09-14 with `server/scripts/studioInterpreterR2.ts --run --cell r2-combined` (n=2). The
prompt is the product's: the real classifier and freeze over C, the constraint riding as a version 2
intent, the real compile tier, run through `runGeneration`. Outputs: `probe-out/interpreter-r2/`._

## F-E · The exclusion clause: no Nike mark anywhere, n=2. `[model tier]` — **CLEAN (Adi's verdicts, R2)**

- **Cell.** `r2-combined` on the Q1 frame (Nike on the jersey, the socks and the cleats), 2:3, 2K,
  gemini-3-pro-image via Vertex. C = "change my uniform to a black adidas uniform, change my cleats to pink
  adidas cleats, and add the headline "OWN THE MOMENT" across the top", with `exclude_marks { nike }`.
- **Prompt, verbatim:** `replace the uniform with black adidas uniform, and replace the cleats with pink
adidas cleats, and add a large banner across the top of the background that reads OWN THE MOMENT in bold
white capital letters. Keep everything else exactly as-is — change only the uniform, the cleats and the
added banner. Keep the original photograph's lighting, exposure, contrast, colour grade and scene
exactly as they are.` then `DO NOT: show a Nike logo anywhere in the photograph.`
- **Observed, both runs:** the swaps landed — a black adidas uniform, pink adidas cleats — and no Nike mark
  is left anywhere at 1:1, the socks and the cleats included.
- **What it decides:** M4's engineering gate passes. The interpreter may propose `exclude_marks` — the
  conditional in sentence 4 reads as an exclusion, never as a removal of each small logo (F-R). Recorded in
  code as `EXCLUSION_CLEARED` (server/studio/interpret/eligibility.ts), and an ad's exclusion of every
  competitor it saw is the kit swap's backstop (plan v2 §14.1).
- **Reach:** n=2, one frame, one excluded brand, marks on garments only, inside a three-change call with a
  headline. Not measured: the clause alone, another brand, a mark off the kit (signage, a ball — C-7).

## F-T2 · A headline inside a three-change call: spelling stable, presentation not, n=2. `[model tier]` `[Mia]` — **CLEAN for spelling (Adi's verdicts, R2)**

- **Cell:** the same run (F-E above).
- **Observed:** "OWN THE MOMENT" legible and correctly spelled in both runs. The PRESENTATION differed: run 1
  a flat overlay across the top of the frame, run 2 a physical fabric banner standing in the scene. Both
  read correctly.
- **What it decides:** spelling holds run to run inside a multi-change call (C-8's unmeasured case), so
  STUDIO_DISPLAY_TEXT is cleared to ship enabled (Adi). F-C's open reach — a display line inside a
  multi-change call — is measured here at three changes plus an exclusion.
- **Open, for Mia — a taste call, not a blocker:** overlay or in-scene banner. q6-t1's template ("a large
  banner across the top of the background") admits both readings; settling it is a template wording change,
  and that change needs its own measurement.
- **Reach:** n=2, one headline, one frame.

---

_Measured from R1's recordings (studio/interpreter; the interpreter's Flash call on the Q1 frame,
`server/scripts/studioInterpreterRecord.ts`, Adi's runs, ~$0.06 each). No verdict is needed: these are
observations of the replies, checked at $0 through the core._

## F-I5 · The interpreter at temperature 0 is not deterministic run to run; Puma's slogan survives the prompt. `[interpreter tier]` `[model tier]` — **OBSERVED**

- **Cell.** 42 eligible asks, the same interpret/3 prompt, the same frame, `gemini-3.5-flash`, temperature 0,
  `thinkingBudget: 0`, recorded twice on 2026-09-14 (~12:53 and ~13:30).
- **Observed — run to run.** 4 of 42 outcomes changed, and 9 of 42 changed outcome or C:
  - "give me these gold hoops" — run 1 a pointed swap of her earrings (`invalid_slot`: none in the frame's
    reply to point at), run 2 an add to her ears (proposed);
  - "make the socks blue and change nothing else" — run 1 "change nothing else" as filler (`uncovered`),
    run 2 as a keep (proposed);
  - "i want my jersey in adidas colours" — run 1 an adidas jersey (proposed), run 2 `uncovered`;
  - "make my jersey a nike adidas kit" — `uncovered`, then `declined`;
  - and five Cs: the suggested headline's words, and which items the model saw a Nike mark on (the socks
    in one run and not the other — R1 run 2's perception miss, again).
- **Observed — the slogan.** For "turn this into a puma ad but dont change my face" the model suggested
  "FOREVER FASTER" in all three runs that asked (interpret/2 run 2, interpret/3 runs 1 and 2), although
  interpret/3's prompt says never a brand's slogan. The deny-list (`headlineBound`) refused it each time,
  so the whole reply asked.
- **What it decides.**
  - Every change was between two answers the checks allow. None was a proposal the core should have
    refused, which is the property that matters: the checks, not the model, decide what may run.
  - The recording is one sample. `interpret/recorded.test.ts` pins what the core does with these replies,
    never what the model will say next time.
  - The 30-minute memo holds one reading per athlete, frame and sentence, so her re-check inside a session
    sees the same card. After it expires she may see another.
  - The tagline guard must live in the rule, not the prompt. It does (N8).
- **Open → FIXED on studio/wave3-fixes (2026-09-17, Adi's call).**
  - A refused _suggestion_ cost the whole reply. Dropping just the suggestion keeps her own words' changes and
    the brand's swaps — now built in the core (`refusedSuggestion`, `withoutRefusedSuggestions`): a suggestion
    beside an ad, of a suggestible kind, on the menu, that fails its own slot is dropped alone and the reply is
    read without it; nothing left, it still asks `invalid_slot`. A suggestion outside the protocol (no ad, a
    look or a swap, a headline with the switch off, two of a kind) still asks whole. R1's Puma cell now proposes
    the two puma swaps and the suggested background, and "FOREVER FASTER" reaches no C, intent or instruction.
    Replayed over every recording on disk, interpret/2's two nike ads ("FIND YOUR GREATNESS") move the same way.
- **Reach.** Two runs of one prompt version, one frame, 42 sentences.
- **Added to the unstable set (2026-09-16, interpret/5 — F-I6's probe).** "make it pop" — `declined` in every recording
  before interpret/5 (interpret/2, /3 ×2, /4, and interpret/5 iteration 1, 2/2), then under iteration 2 `invalid_slot`
  in 1 of 2 probe runs. Alone, n=6, same prompt (hash `006633321b906a36`), same frame, model and menu: **3 `invalid_slot`,
  3 `declined`** — two byte-identical replies, a look with the term "punchy" (not her word, so the core refuses it) and
  a decline. Adi's rule, set before the n=6 run: mixed is this entry's noise, not the prompt's reach. Both outcomes are
  asks, and she is shown the same line for either (the route falls back to `fast_path_declined`'s rephrase).

---

_The two entries below were found in the style vocabulary's recon ($0, main `c4951e2`, 2026-09-14): route() and
the compile tier replayed in-process, no model, no row. Both are rule 3's, which that PR leaves byte-identical —
its widened words are rule 5¾'s, which reads only a sentence that is wholly one look and so reaches neither
shape. Adi's decisions: F-L1 is its own fix PR; F-L2 is A3b (plan v1 §5), promoted from "follow-up" to the
named PR right after the style vocabulary._

## F-L1 · Two looks in one clause: rule 3 keeps the first of main's words and drops the other. `[classifier-fix]` — **LIVE on main**

- **Mechanism:** rule 3's value is the first `GLOBAL` match in the sentence, and nothing counts a second
  look. Rule ½ asks `compound_conflict` for two looks only when they are two clauses ("make it warmer, and
  make it brighter"); said as one clause, the second look is dropped without a word.
- **Repros** (main `c4951e2`; the same after the style vocabulary, which moves no routed sentence):

| sentence                             | route                            | the look she loses                |
| ------------------------------------ | -------------------------------- | --------------------------------- |
| make it warmer and brighter          | `GLOBAL_STYLE "warmer"`          | brighter                          |
| make it moodier and warmer           | `GLOBAL_STYLE "warmer"`          | moodier — a look she can name now |
| make it warmer and moodier           | `GLOBAL_STYLE "warmer"`          | moodier                           |
| make it black and white and warmer   | `GLOBAL_STYLE "black and white"` | warmer                            |
| make it warmer, and make it brighter | ASK `compound_conflict`          | — (two clauses: asks)             |

- **The fix, for its own PR:** two different looks in one clause ask `compound_conflict`, as two clauses
  do — with a route diff whose only moved rows are these, route → ASK.

## F-L2 · A look beside her keep routes, and her keep is dropped or recoloured. `[classifier-fix]` — **FIXED on studio/style-vocab (A3b)**

- **Mechanism:** rule 3 reads any sentence with a `GLOBAL` word and no region. "dont change anything
  about me" names no region (no determiner), so the whole sentence is a bare look: FULL_IMAGE, never
  interpretable, compiled with no keep sentence and no "This look covers the whole photo, you included."
  line. And "keep me the same" DOES name a region — "the same" — so rule 3 steps aside, and where the
  look is a colour word rule 5 recolours "the same".
- **Repros** (main `c4951e2`):

| sentence                                                  | route                     | compiled instruction, first clause                      |
| --------------------------------------------------------- | ------------------------- | ------------------------------------------------------- |
| make it warmer, dont change anything about me             | `GLOBAL_STYLE "warmer"`   | give the whole photograph this look: warmer             |
| make it warmer but dont change me                         | `GLOBAL_STYLE "warmer"`   | give the whole photograph this look: warmer             |
| make it golden hour, keep me the same                     | `RECOLOR [same] "golden"` | make the same golden                                    |
| make it black and white, keep me the same                 | `RECOLOR [same] "black"`  | make the same black                                     |
| make it black and white and keep everything else the same | `RECOLOR [same] "black"`  | make the same black                                     |
| make it warmer and keep everything else the same          | ASK `fast_path_declined`  | — (the interpreter reads the look and the keep)         |
| make it moodier, dont change anything about me            | ASK `fast_path_declined`  | — (a new word: rule 5¾ asks, the interpreter keeps her) |

- **What it costs her:** her "don't change me" is silently discarded on a whole-frame grade, which re-grades
  her too; or her keep becomes a thing to recolour. The interpreter would read every one of these as the look
  plus `preserve_person` — it never sees them, because they route.
- **The fix, as built (A3b, added to the style vocabulary's branch; Adi's Option A).** Not the route → ASK
  first written here: a keep she types beside a sentence that ROUTES is set aside before the rules read it
  (studio/keepVocab.ts, a closed set, one whole clause first or last), and rides beside their steps as the
  interpreter's own `preserve_person` — version 2, the keep sentence in the prompt, the whole-photo line,
  and the card on the preview. Detection and the freeze read the rest, so her keep is never region text.
  Only where the sentence already routes: every ask is the interpreter's, as it was. The recon's 25
  sentences all move route → route — 13 gain her keep beside the same steps, 12 misreads come out clean
  ("the same" as a target: 8; her keep inside rule 2's value: 4). Every sentence in the table above that
  routed now compiles its edit and the keep sentence, and "remove the cone and keep me the same" no longer
  removes "the same".
- **The fail-closed path, found while writing A3b's revert checks.** "remove it, keep me the same" and
  "remove it and keep everything else the same" routed on main only because her keep was read as a thing:
  `REMOVE_OBJECT [same]`, compiled "remove the same and fill the space where it was…". Set aside, what is
  left is "remove it", which names nothing — so they ASK (`fast_path_declined`), as "remove it" alone
  always has. The one route → ASK class A3b adds: a destructive misread, refused.

## F-L3 · R1 under interpret/4: 11 of 42 cells moved, every one the model's reply; the kit swap is evidence-based; Puma's slogan came back a fourth time. `[interpreter tier]` `[model tier]` — **OBSERVED**

- **What changed:** one line of the prompt, the look terms (11 → 27, the style vocabulary's V.3). Same wire,
  menu, frame and 42 calls. Adi's run, 2026-09-14, ~$0.06.
- **Method (F-I5's):** every interpret/4 reply read through main's core (`c4951e2`) and the branch's, and every
  interpret/3 reply through the branch's. The branch's checks move nothing: each interpret/3 reading
  reproduces, and each interpret/4 reply reads the same through both cores. So every move is the model's
  reply — the prompt change and temperature-0 nondeterminism cannot be told apart at n=1, and no moved
  cell involves a look.
- **Outcomes** (proposed / invalid_slot / declined / uncovered: 30/4/6/2 → 28/6/6/2):

| sentence                                    | interpret/3     | interpret/4        | why                                                                                                                                                             |
| ------------------------------------------- | --------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| make my cleats pink and adidas              | proposed        | ASK `invalid_slot` | the reply split it into a recolour AND a brand swap of the cleats, the swap's quote just "adidas": two changes to one thing. Not the look check — no look in it |
| give me a nike swoosh on my shorts          | proposed        | ASK `invalid_slot` | the reply wrote the design as "nike logo"; "logo" is not her word                                                                                               |
| make the socks blue and change nothing else | proposed        | ASK `uncovered`    | "change nothing else" read as filler — F-I5's interpret/3 run 1, again                                                                                          |
| i want my jersey in adidas colours          | ASK `uncovered` | proposed           | "colours" spanned into the swap's quote — F-I5's other flipper                                                                                                  |

- **C alone (7):** all ad cells — the suggested headline's words, and which items the model reported a Nike
  mark on (the socks: F-I5's perception miss).
- **The kit swap is evidence-based, not reflexive.** In every ad cell that proposes, the swapped items are
  exactly the items the reply reported a competitor's mark on (pinned in `interpret/recorded.test.ts`); both
  nike ads, on this nike kit, swap nothing. Where three swaps and the headline fill the four-change cap, the
  suggested background is what drops — a required swap outranks it (C-2).
- **Puma's slogan:** "FOREVER FASTER" came back for "turn this into a puma ad but dont change my face" again —
  four runs of four, interpret/2 to interpret/4. The deny-list refused it and the whole reply asked, exactly
  as under interpret/3 (`invalid_slot` both times). No deny-listed slogan reached a proposal in either
  recording: the guard held, as it did before. The prompt's slogan rule is unchanged and did not stop it.
- **Held:** sentence 4's primary cell (both swaps — its third clause alone is the cleats row above); cell 3;
  "add small gold hoops to my ears" (normalized since interpret/3); "if there are any nike logos remove
  them" (declined in both).

## F-L4 · A keep of a THING is read as a change to it: "keep the jersey the same and make the socks blue" recolours the jersey. `[classifier-fix]` — **FIXED on studio/preservation-fixes**

- **Mechanism:** rule 5 reads every determiner phrase in the sentence as a region, and "the jersey" and "the
  same" are two. The keep names the jersey to leave it alone; the recolour takes it as a target.
- **Repros** (main `c4951e2`; unchanged on the style vocabulary's branch):

| sentence                                         | route                                  | compiled instruction, first clause                                    |
| ------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------- |
| keep the jersey the same and make the socks blue | `RECOLOR [jersey, same, socks] "blue"` | make the jersey blue, and make the same blue, and make the socks blue |
| make the socks blue but keep the jersey the same | `RECOLOR [socks, jersey, same] "blue"` | make the socks blue, and make the jersey blue, and make the same blue |

- **Why not in A3b:** A3b is her keep of HERSELF, riding as `preserve_person`. A keep of a thing is its own
  class, with no constraint to ride as yet: the honest near fix is an ask. Its own PR, with a route diff
  whose only moved rows are these, route → ASK.
- **Wider than recolours** (the preservation fixes' recon, main `8603f24`, 2026-09-16). No rule reads "keep",
  "leave … alone", "dont change" or "dont touch", so the rule that read her sentence took the kept noun as its
  own: rule 1 froze "remove the cone but keep the ball" as REMOVE [cone, ball] — and live, Adi's "remove the
  goalpost but keep the ball" (asset `c877f259`) removed both, detection handed the whole sentence returned
  no mask (`absent`), the job ran full-frame and the lighting drifted, where "remove the goalpost" alone held;
  rule 4a put a logo on the shorts she kept; rule 5 recoloured "make everything blue but keep my cleats" as the
  cleats ALONE; rule 2 swallowed "but keep the bench" into the setting, and read "dont change the background,
  just make it warmer" as a background change.
- **The fix, as built (Adi's K2, D6, D7).** Not the ask first written here. studio/keepVocab.ts's
  `readThingKeep` reads a keep of ONE thing — keep, leave … alone, dont change, dont touch; a determiner and one
  to three words — as a whole clause, first or last, and `route` sets it aside. The rules read the rest and
  nothing rides beside the steps: the scope sentence every native compile writes already keeps what she did
  not name. `readAs` is the rest, so detection never looks for the kept thing: "remove the goalpost but keep
  the ball" now freezes, detects and compiles byte-identically to "remove the goalpost".
  - **It asks `keep_conflict`** where the rest would change the kept thing — a step naming it, or a look or a
    background, which change the whole photo — or where the whole sentence routed and the rest cannot be read
    ("make everything blue"). Never an interpreter code (D7). Placeholder copy, for the copy-review pile.
  - **Reads as today:** a keep carrying a colour or a look ("keep the jersey red", D6); her or a part of her
    as the thing; a keep read first whose rest leads no change (a list she kept); a sentence that already asked
    whose rest asks too.
  - **Known remaining:** a list she keeps, read first — "keep the ball, cone and bench, and remove the net" —
    still removes the ball, as on main (REMOVE [ball, net]); and "make the jersey and cleats blue but keep the
    cleats the same" recolours the jersey alone without asking, because rule 5 never reads the determiner-less
    "cleats" in the rest.

## F-L5 · Her keep of her face is refused as an edit of her: "make it warmer, dont change my face" gets "we don't edit people". `[classifier-fix]` — **FIXED on studio/preservation-fixes**

- **Mechanism:** the rules read "my face" in her keep as a region, and a region that names her is refused —
  by `validate`'s person guard (`person_target`), or by the fall-through when every region is her
  (`person_mentioned`). She hears "We don't edit people in photos" about a sentence asking us NOT to.
- **Repros** (main `c4951e2`; unchanged on the style vocabulary's branch, pinned in keepVocab.test.ts):

| sentence                                                 | today                  | with her keep set aside                       |
| -------------------------------------------------------- | ---------------------- | --------------------------------------------- |
| make it warmer, dont change my face                      | ASK `person_mentioned` | `GLOBAL_STYLE "warmer"` + `preserve_person`   |
| make my jersey blue, dont change my face                 | ASK `person_target`    | `RECOLOR [jersey] "blue"` + `preserve_person` |
| add gold hoops to my ears, dont change my face           | ASK `person_target`    | `ADD_OBJECT [gold hoops]` + `preserve_person` |
| add gold hoops to my ears, keep everything else the same | ASK `person_target`    | `ADD_OBJECT [gold hoops]` + `preserve_person` |

- **Why no path fixes it today:** a person code is never interpreted (studio/interpret/eligibility.ts, A4 —
  "her body: no rephrasing changes that"), and A3b sets a keep aside only on a sentence that already routes
  (Adi's Option A). So these fall between the two: the rules refuse them, and the interpreter never sees them.
- **The next preservation PR:** extend A3b's absorption to a sentence whose only refusal is her keep — the
  keep set aside, the rest routes, `preserve_person` beside it — with a route diff whose only moved rows are
  these four, ask → route. The same machinery, one condition wider.
- **The fix, as built (the preservation fixes, main `8603f24`, 2026-09-16; Adi's D1 and D2).** `route` sets her
  keep aside where her sentence routes (A3b) **or** where the rules refused it with a person code
  (`person_target`, `person_mentioned`) — D1: only those, every other ask stays the interpreter's. What is left
  is read by the same rules and guard, so an edit of her beside her keep is refused with the code it always had
  ("make my arms bigger, dont change my face" → `person_mentioned`). D2 widens the closed set by name: "keep my
  face / hair / body / pose the same (as it is)" and "preserve my / the face …", with "as much as possible".
  - The four route, and so do "make it warmer, dont change my hair" and "… my body" (the same class, in the
    corpus). Each freezes version 2 with the keep sentence; two are goldens.
  - D2's intended pin flip: "make it brighter, keep my face the same" was pinned as a wording the set does NOT
    read (A3b). Now it reads it — and the sentence still asks `fast_path_declined`, the interpreter's, because
    its ask is not a person refusal (D1).
  - A live repro given with this entry — "generate a professional sports photograph of her … preserve the face as
    much as possible within the reference image" — is not this class: the keep was never why it was refused. It is
    F-L8.

---

_The entries below were found while building the preservation fixes (studio/preservation-fixes, main `8603f24`,
2026-09-16), replayed at $0: route(), the freeze and the compile in-process, no model, no row._

## F-L6 · An add of a thing onto her body is refused by one preposition and routed by another: "add a water bottle onto my head" gets "we don't edit people"; "… on top of my head" routes. `[classifier-fix]` `[Mia]` — **FIXED on studio/wave-a** (G1, Adi's bound — Mia to see)

- **Found live** (Adi, 2026-09-16): "add a water bottle onto my head" refused `person_target`.
- **Mechanism:** rule 4½ (`parseAddObject`) reads "onto my head" and "on my head" as a SURFACE, so "head" is a
  target, and the person guard refuses it. "on top of my head" is read as a place with no surface, so nothing
  names her and it routes `ADD_OBJECT [water bottle] "on top of my head"`. The same split for "onto my foot"
  (refused) and "at my feet" (routes). A thing she WEARS takes rule 3¾b instead ("add a hat onto my head"
  routes, PR M3), and a water bottle is not on WORN_ITEMS.
- **Repros** (main `8603f24`):

| sentence                             | route                                           |
| ------------------------------------ | ----------------------------------------------- |
| add a water bottle onto my head      | ASK `person_target`                             |
| add a water bottle on my head        | ASK `person_target`                             |
| add a water bottle on top of my head | `ADD_OBJECT [water bottle] "on top of my head"` |
| add a hat onto my head               | `ADD_OBJECT [hat] "onto my head"` (worn, M3)    |
| add a soccer ball onto my foot       | ASK `person_target`                             |
| add a soccer ball at my feet         | `ADD_OBJECT [soccer ball] "at my feet"`         |

- **Why not in the preservation fixes:** it is not a keep. It is which things may be put ON her that she does
  not wear — M3 allowed worn items and ruled out body modification, and says nothing of a bottle balanced on
  her head. Whether the refusal or the routing is the defect is that policy question, so it is Mia's before it
  is a fix: either the preposition split closes toward the refusal ("on top of my head" asks too), or a
  non-worn thing onto her routes like a worn one.
- **Wave A, G1 (2026-09-17) — Adi decided the direction: a non-worn thing onto her routes, bounded both sides.**
  Non-contact prepositions (near, by, behind, in front of, toward(s), close to) before any part of her, or her by
  pronoun; contact (on, onto, to) only onto a part a thing rests on (head, foot, feet, shoulder(s), lap). Never a
  body modification, a worn thing (rule 3¾b's table), M3's N6 costume words (crown, tiara, mask, shades) or a thing
  naming her. "add a water bottle onto my head" → `ADD_OBJECT [water bottle] "onto my head"`, compiled "place it onto
  the person's head" (never "worn"). "put paint on my face", "add a towel to my arm", "add a tattoo on my arm", "add a
  crown on my head" still refuse. "put the ball closer to my feet" asks `add_unclear` (a move — F-WA6). The
  interpreter's `addOk` is unchanged: it still refuses a non-worn place naming her (F-WA7).

## F-L7 · A keep of a thing has no line of its own: the card does not show it, and the prompt keeps it only through the scope sentence. `[classifier-fix]` — **FOLLOW-UP CARD** (Adi's K3)

- **What K2 left out, on purpose.** F-L4's fix sets "keep the ball" aside and routes "remove the goalpost";
  what keeps the ball is the scope sentence every native compile writes ("Keep everything else exactly as-is —
  change only the goalpost"). Her keep is not on the card, and no sentence names the ball.
- **The card (K3):** a closed `preserve_thing { target }` constraint beside `preserve_person` — a keep sentence
  naming the thing, and a card line ("Keep the ball as it is · yours"), frozen as version 2.
  - Her noun enters the prompt, so the target is bounded to the rules' own vocabulary.
  - It is a new closed shape in `EditConstraint`, so a frozen intent's well-formedness and the interpreter's
    menu need a decision each.
  - With it, a keep of a thing could become the interpreter's too (D7 says not yet).

## F-L8 · "photograph" was not a new-image word: "generate a professional sports photograph of her …" with her photos attached was read as an edit and refused. `[classifier-fix]` — **FIXED on studio/preservation-fixes** (the word); the rest of the new-image words **FIXED on studio/wave-a** (V3)

- **Live** (Adi's acceptance, Create anything, photos of her attached, a client before #486): "generate a professional
  sports photograph of her striking the ball into the net, mid-shot with her leg extended at the moment of contact,
  in her uniform, goalkeeper diving, packed stadium behind her, golden hour light, sharp focus on her face. preserve
  the face as much as possible within the reference image." — refused as an edit that cannot carry photos of her
  (`refusedOnEdit`).
- **Mechanism** (main `8603f24`, $0): `EXPLICIT_GENERATE`'s noun list had `photo`, and the word boundary keeps it from
  matching `photograph`. "mid-shot" does not rescue it — `shot` is 75 characters past "generate a", outside the
  40-character window; `photograph` is 21. With a frame (every photo of hers before #486; after it, a marked photo,
  Edit this, a continuation, or SetupScreen's first photo) the sentence is not a new image, and rule 2 reads "behind
  her": `CHANGE_BACKGROUND [person] "net"` (its value, "into the net"). With her other photos beside it, the edit is
  refused; with ONE photo it prices a background edit of her photo to "net".
- **Not her keep.** The sentence with the last clause removed is refused the same way; with "photo" in place of
  "photograph" and the keep kept, it generates, and her words — keep included — ride verbatim in the generate prompt
  (Adi's D4, P1; byte-identical before and after).
- **The fix (Adi's D3):** `photograph` and `photographs` join the noun list. Every sentence that moves is one the same
  sentence with "photo" already read as a new image, and it shares that one's false positive: "make a black and white
  version of this photograph" is a new image, as "…of this photo" has always been. Pinned both ways.
- **Follow-up card — the rest of the new-image words, one vetted word at a time** (each still an edit with a frame,
  pinned as it is): "generate a **pic** of me playing soccer", "generate a **headshot** of me", "create a **portrait**
  of me in a stadium", "make me a professional **photoshoot**", and a plural with no article — "generate professional
  sports **photos** of her" (the construction needs a|an|another|new).
- **Wave A, V3 (2026-09-17):** pic, pics, headshot, portrait, photoshoot and photos join the nouns, and a plural gets
  its own arm with no article (generate/create/render/design, or "make me"; nothing between that points at hers). Each
  card sentence generates. The shared wrong answer, named and pinned: "make a black and white version of this pic" is a
  new image. Also moved: "don't generate new photos, just make the socks blue" (the negated-generate class "photo" has).
  Still out: "generate pic of me …" (singular, no article) and the plurals headshots/portraits/photoshoots.

---

_The entries below were found building auto-mark (studio/auto-mark, 2026-09-16). The evidence is in
[auto-mark.md](auto-mark.md). Routes are replayed on main `e7580f1` (#488 merged)._

## F-AM1 · Edit-shaped sentences the rules cannot read land in the catch-all, so with one unmarked photo they become new images. `[classifier-fix]` — **FIXED on studio/wave-a** (V4)

- **Mechanism:** auto-mark (Adi's D1, S2) marks a photo only on a routed edit, or on an ask whose code names an
  edit. `fast_path_declined` is excluded because the same code holds generates the rules cannot read.
- **Repros** (`route(s, true)`):

| sentence                          | route                    | one unmarked photo, today |
| --------------------------------- | ------------------------ | ------------------------- |
| take the logo off my sleeve       | ASK `fast_path_declined` | new image                 |
| make the sky moodier              | ASK `fast_path_declined` | new image                 |
| generate pic of me playing soccer | ASK `fast_path_declined` | new image (correct)       |

- **The fix is vocabulary**, so the first two route: a separated-particle removal ("take X off Y") and a look on a
  named region.
- **Its own PR, with a route diff.** The interpreter route (card C2) is blocked on F-AM6.
- **C2 (studio/catch-all-interpret, 2026-09-16):** the catch-all is now read by the interpreter at send with one photo
  of hers. A proposal marks the photo; anything else is the new image it was. The first two rows still come back
  `invalid_slot`, so they stay new images: F-CA2. The vocabulary fix above is still the edit path.
- **Wave A, V4 (2026-09-17):** both rows route at the rules — `REMOVE_OBJECT [logo]` and `RECOLOR [sky] "moodier"` —
  so auto-mark marks the photo and C2 never reads them (interaction check: `interpreterReads` does not fire).

## F-AM2 · A pose sentence reads as an add she did not place, so auto-mark marks it and she is asked. `[known behavior]` — **LIVE on the branch**

- "put me mid-air dunking" routes `ASK add_unclear`, which is an S2 code, so one photo is auto-marked.
  - With the interpreter OFF, she hears the add-unclear ask instead of getting a new image.
  - With it ON, the preview interprets it, and the scene probe's two runs of this sentence declined, so it blocks
    with an ask.
- Pre-frame-defaulting parity: a defaulted frame did the same.
- Follow-up card C4: an interpreter fallback to a new image for every auto-marked ask, with this sentence in its
  acceptance set.
- **C4 folded into C2 (Adi's D1, 2026-09-16):** with the interpreter on, the send reads "put me mid-air dunking" once.
  A proposal marks the photo; a decline is a new image, never the ask (F-CA4 for the badge she saw while typing).

## F-AM3 · Scene sentences the RULES route as edits: auto-marked with one photo. `[classifier-fix]` — **LIVE on main**; the red-carpet misread **FIXED on studio/wave-a** (G3)

| sentence                                    | route                                                         |
| ------------------------------------------- | ------------------------------------------------------------- |
| put me in a stadium at night celebrating    | `BACKGROUND CHANGE_BACKGROUND "stadium at night celebrating"` |
| me walking the red carpet at an awards show | `FULL_IMAGE RECOLOR [awards show] "red"` — a misread          |

- The first is a background edit of her photo, not a new pose. The second recolours a region detection will not
  find.
- Pre-frame-defaulting parity. Territory of the identity plan's G.4 (`new_pose_or_edit`).
- **Wave A, G3 (2026-09-17):** rule 5 reads its colour outside a closed list of compound names (red carpet, red/yellow
  card, green screen, white house, gold/silver/bronze medal, black belt), so the red-carpet sentence asks
  `fast_path_declined` — the interpreter's, and C2's new image. "golden hour" is NOT on the list: F-WA2. The stadium row
  is unchanged (G.4).

## F-AM4 · "generate a pic of me playing soccer and change the background to a stadium" routes as the background edit. `[accepted]` — **FIXED on studio/wave-a** (V3's word; V5 pins it)

- `route(s, true)` is `BACKGROUND`, so one photo is auto-marked and the "generate … pic of me" half is dropped.
- G.4 / `new_pose_or_edit` territory (docs/plans/studio-generation-identity-plan.md).
- **Wave A, V3 + V5 (2026-09-17):** rule 0 already read EXPLICIT_GENERATE over the whole sentence before composition, so
  only "pic" was missing. With it (V3) the sentence is one GENERATE with a photo and without, composes nothing, the
  freeze refuses it as an edit, and her whole sentence is the generate's DIRECTION (V5's pins). "generate pic of me …
  and change the background to a stadium" (no article) is still the background edit.

## F-AM5 · A Product photo on a marked edit travels as "render this exact object" whether or not the instruction names it. `[model tier]` — **LIVE on main**, unmeasured

- `referencesFor` keeps product and object references on an edit (only a person is refused).
- The native manifest's product line reads "PRODUCT: … Render this exact object". With You + Product(sneakers) and
  "make the socks blue", the instruction never names it.
- Whether the model inserts it is unmeasured (a paid probe).
- Its narrowest case, an ADD with a product and no object photo, is excluded from auto-mark (D5 b). Binding a lone
  product as the added thing is card C3.
- Auto-mark widens this: every You + Product edit-shaped send is now an edit.
- The add onto her body in the same tray ("add a water bottle from image 2 onto my head") is still refused by its
  preposition, so it is never auto-marked. That is F-L6's card.

## F-AM6 · The interpreter reads scene sentences as background edits: 4 of 12, stable 2/2. `[interpreter tier]` — **MEASURED 2026-09-16** ($0.0305, interpret/4, gemini-3.5-flash)

- "me on a beach", "make me look like im at the beach", "picture of me running on a track at sunset" and "make a
  pic of me training in the gym" each came back `change the background to …`, on both runs.
- The other eight asked or declined, "generate pic of me playing soccer" included.
- Cause: the prompt frames every request as an edit of the photograph, and `background {setting}` has no "this is a
  new image" exit.
- Blocks card C2. Fix: card C1, a prompt exit with a PROMPT_VERSION bump and an R1 re-record.
- **Fix building:** F-I6 below (interpret/5, studio/interpreter-generate-exit).

## F-AM7 · A video "You" beside a marked photo asks "you marked one photo and added other photos of you". `[known behavior]` — **LIVE on main**

- `frameChoiceNeeded` (F.4) counts any "You" chip beside the mark, a video included.
- Auto-mark never marks the video (`canvasesIn`), but a video + photo tray asks `frame_with_likeness` when the photo
  is marked, by her or by auto-mark (corpus diff, twin-identical).

---

_The entries below were found building the interpreter's new-image exit (studio/interpreter-generate-exit,
2026-09-16). Probe outputs are outside the repo; routes are replayed on main `f3ff6af` (#489 merged)._

## F-I6 · The interpreter has no "new image" answer: a scene sentence comes back as a background edit of her photo. `[interpreter tier]` — **EXIT BUILDING on studio/interpreter-generate-exit** (interpret/5; probe PASSED on the second wording)

- **Measured as F-AM6** (auto-mark's gate probe: interpret/4, 12 scene sentences ×2, ~$0.0305). What it adds here:
  every one of the 4 misreads passes every check the core has — her quote says the setting's words, so "your words"
  on the card would be true of an edit she never asked for. Rule 6 declines words that fit nothing, but a place always
  fits the background.
- **The exit (interpret/5).** A first-class `newImage` answer, said only on a call that is not an ad (an ad is an edit of
  this photograph by definition, M1 — and so an ad's prompt stays interpret/4's byte for byte). It comes alone, it is a
  terminal answer and never a refusal, and the preview blocks on it with the `generate_on_edit` line word for word
  (⚠️ copy-review pile). Probe: A must-flip (the 12, ×2), B controls (12 outcome-stable R1 cells, ×2), C the auto-mark
  card's catch-alls (×2), D held-out scenes (×1); cap $0.10. Acceptance (Adi's): the 4 misreads new image 8/8; B no
  new image and its outcome as r1.json's 24/24 (an outcome, not C — F-I5 makes C noise); C no new image 4/4.
- **Iteration 1** (non-ad hash `430b02dbaa12c17f`, ~$0.0752, 56 calls) — **FAILED the 4 misreads, 4/8.** "me on a beach"
  and "make me look like im at the beach" were background edits in both runs; the two with an action or a picture word
  flipped. The other 8 of A new image 16/16, D 4/4 (every D sentence has an action), B 24/24 and C 4/4 clean. Its
  examples shared words with the cells ("picture", "put", "me"), caught only after the run.
- **Iteration 2** (Adi's one reword, hash `006633321b906a36`, ~$0.0778, 56 fresh calls) — the terse shape named in the
  new-image block and rule 8 ("herself and a place alone", "asking to appear to be there"), the background line said
  only for her words naming the background, and a minimal pair on one place that shares no word with any cell
  ("myself beside lake tahoe" / "turn this backdrop into lake tahoe"). **The 4 misreads 8/8**, the rest of A 16/16,
  D 4/4, C 4/4, B no new image 24/24 — and B's outcome 23/24: "make it pop" `invalid_slot` once. Alone n=6 it split 3/3
  (F-I5), so by Adi's rule, set before that run, the probe PASSED.
- **The ad prompt** hashes `3e9ae408475b33a4` under interpret/4 and interpret/5.
- **R1 re-recorded under interpret/5** (Adi's run, 42 calls, 2026-09-16 22:38Z; `interpret/recorded.test.ts`). Every ad
  call's input tokens equal interpret/4's (10/10) and every other call's are +372, "make it pop" at the probe's own 3,648
  — the recording answered the prompt the probe passed. **34 cells read the same, 4 in C alone, 4 in outcome; no call
  answered a new image, and none said `newImage`.**
  - The 4 in C are all ads, whose prompt did not move: which items the model saw a Nike mark on (socks, cleats), and so
    which suggestion the cap dropped — and one suggested background's words. The model's, by construction.
  - The 4 in outcome are all cells that had already moved between earlier recordings (F-I5, F-L3):
    - "make my cleats pink and adidas" `invalid_slot` → proposed "change my cleats to pink adidas cleats" — one swap
      with a pink descriptor, as interpret/2 and /3 read it; interpret/4 had split a recolour and a swap of the same
      cleats.
    - "make my jersey a nike adidas kit" `declined` → `uncovered` — the same unreadable span with `decline` false.
    - "i want my jersey in adidas colours" proposed → `declined` — its fifth reading: declined, proposed, uncovered,
      proposed, declined.
    - "make the socks blue and change nothing else" `uncovered` → `unparseable` — interpret/4's own reading, plus a stray
      `"source": "yours"` on each visible mark that the strict read refuses first. 1 of 160 interpret/5 replies (0 of
      42 under interpret/4). It fails closed: she hears the same ask.
  - Puma's "FOREVER FASTER" came back again — five R1 runs of five — and the deny-list refused it again.

## F-I7 · The line between "a new picture of her" and "a background edit" is drawn twice, and not in the same place. `[classifier-fix]` `[interpreter tier]` — **KNOWN, G.4 / `new_pose_or_edit` territory** (not the new-image exit's to reconcile)

- **The rules' line.** Rule 2 reads a place she puts herself in as a background change of this photo, and those sentences
  never reach the interpreter (main `f3ff6af`, $0): "can you put me at the beach" → `CHANGE_BACKGROUND` "beach", "put me
  on a rooftop at dusk" → "rooftop at dusk", "put me in front of a sunset" → "front of a sunset", "add a crowd behind me"
  → `CHANGE_BACKGROUND`.
- **The interpreter's line (interpret/5, F-I6).** Words that describe her somewhere or doing something are a new picture
  — "make me look like im at the beach" answers `new_image` by design (Adi's must-flip set).
- **So** two near-identical asks get opposite readings depending on which tier reads them first. Neither is wrong on its
  own terms, and the new-image exit only stops the interpreter inventing background edits; it does not move a rule.
- **Where it belongs.** The generation identity plan's G.4 (docs/plans/studio-generation-identity-plan.md): its
  `new_pose_or_edit` ask ("new photo of you, or edit this one?") is a rules-level answer to exactly these sentences, a
  named tightening with its own route diff. F-L8's follow-up card (the rest of the new-image words — "pic", "headshot",
  "portrait") is its neighbour: each word it adds takes sentences out of the interpreter's reach, and should re-run the
  new-image probe's A set when it lands.

---

_The entries below were found building the catch-all through the interpreter (studio/catch-all-interpret, card C2,
2026-09-16). The evidence is in [catch-all-interpret.md](catch-all-interpret.md). Routes are replayed on main `5385e57`._

## F-CA1 · Every catch-all send with one photo of hers pays one interpreter call, the generate-shaped ones included. `[known behavior]` — **BY DESIGN (Adi's C2 card)**

- **What reads:**
  - "generate pic of me playing soccer" is `fast_path_declined`, the same code as "take the logo off my sleeve".
    With one photo of hers it is read at send, and a reading that is not a proposal plans the new image it always
    planned.
  - An auto-marked S2 ask the interpreter takes (D1) is read too.
- **Cost:**
  - About $0.0014–0.002 per call at QA's Flash rates. R1's recording: p50 1.7 s, max 3.1 s.
  - Detection runs on C only for a region proposal. That is the same economics as before #486, when the defaulted
    frame sent these sentences to the interpreter from the sheet.
- **Corpus share ($0, `tools/ca/codes.ts`):** of the 4,426 quoted strings in the Studio test files, 3,233 are the
  catch-all with a photo, and 229 are S2 asks the interpreter takes. Many are test strings, not sentences; it is a
  share of the corpus, not of her traffic.

## F-CA2 · "take the logo off my sleeve" and "make the sky moodier" come back `invalid_slot`, so C2 makes them new images, not edit proposals. `[classifier-fix]` `[interpreter tier]` — **FIXED at the rules on studio/wave-a** (V4)

- **Measured by the new-image exit's probe, set C** (interpret/5): 8/8 `invalid_slot` across both wordings.
  - The model reads remove "logo on sleeve", and the core's her-words check refuses "on".
  - It reads look "moodier" on the sky, which is not wholly a look.
- **With C2:** each is read once at send, and the ask becomes a new image of her. That is never a dead end, but it is
  not the edit she asked for.
- **Their true edit path is the rules' vocabulary:**
  - a separated-particle removal ("take X off Y");
  - a look on a named region.
  - Its own PR, with a route diff. When those route, C2 no longer reads them at all.
- **Wave A, V4 (2026-09-17):** "take X off" is a removal verb and a removal's on/from/off place is not a second target
  (so the logo alone is removed — see F-WA3 for what that fixed on main), and "the sky" plus a whole look is `RECOLOR
[sky] <look>`, detection-paired like every recolour. Neither sentence reaches the interpreter now. Unmeasured: the
  sky's pairing label and its SAM mask on the flag-off path (the acceptance cell measures the first).

## F-CA3 · With the interpreter off, a catch-all over her mark builds the same preview request as the interpreted edit. `[known behavior]` — **HELD by the hook's `ready` gate**

- "take the logo off my sleeve" over a marked photo, interpreter OFF: the verb list reads "take … off" as an edit
  (`editBaseFor`). The request body is byte-identical to the interpreted edit's (`seededPreview` would match).
- It routes as an ASK there, and `useGenerationPlan` reads a seed only when `ready`, which needs no `askReason`.
  Pinned as that property (studio-contract.test.ts). Found writing CA.2's pins.
- The client flag is a build constant, so the send and the sheet cannot disagree about it in one build.

## F-CA4 · An auto-marked S2 ask shows the EDITING badge while she types, and the send can still plan a new image. `[known behavior]` `[Mia]` — **LIVE on the branch**, copy/UX pile

- The badge follows `autoMarkShape` on the draft answer (auto-mark D2). For an S2 ask the interpreter takes, the
  photo is marked only if the reading at send proposes.
  - Example: "put me mid-air dunking" is badged as she types. It is read at send, the interpreter declines, and she
    gets a new image with the badge gone.
- Before C2 the same send marked the photo and the sheet asked.
- Hiding the badge on interpretable asks would move D2's live badge. Not done here.

## F-CA5 · "Not what I meant" on a C2 proposal gives the tray back with the photo marked as hers; her re-send is a marked edit, and the sheet's reading can ask. `[known behavior]` — **LIVE on the branch**, for Adi to confirm

- `composerAfterReject` puts back the tray as sent, with its frame (auto-mark D3: a frame comes back as her mark).
- A marked photo is hers, and C2 never reads over her mark. The re-send goes to the sheet as a marked interpreted
  edit, and an ask there is today's ask.
- Check again on a seeded plan rebuilds the job with no seed (pinned), so it reads again. The reading can differ
  (F-I5), within the server's 30-minute memo per instance.

## F-CA6 · A reading that falls back leaves a preview row no screen names. `[known behavior]` — **BY DESIGN**

- Blocked readings (new image, declined, not ready) are stored like any blocked check and cannot be spent.
- Two fallbacks store a READY row: an interpreted add beside a product (D2), and a ready preview with no
  interpretation. The client drops the previewId, so nothing can spend it, and the row expires with the 30-minute
  preview TTL.
- The call past the 20 s client cap is aborted; the server may still write its row.

## F-CA7 · Acceptance cell 3, "add in hoops from the second picture": the interpreter answered `uncovered`, so nothing was proposed or frozen, and C2 planned a new image. `[classifier-fix]` `[interpreter tier]` — **FIXED at the rules on studio/wave-a** (V1, V2; the log wart G4)

- **The row** (preview `467bbf7a`, 2026-09-17 06:27Z, You + one Object photo; read at $0 through one pinned SELECT):
  - status `blocked`;
  - interpreter record outcome **`uncovered`**, `askReason` null, `canonical` null, no edits, no spans;
  - interpret/5, not a memo hit, 3,696 tokens in and 88 out, 2.8 s, ~$0.0013;
  - no edit intent on the brief, and the blocker is the rephrase line.
- **Not a freeze refusal of a proposal.** There was no C to freeze. The `native_freeze_refused` log event is also what
  `blockedOnAsk` writes when the interpreter asks: reason `not_routed`, with `route(S)`'s own code, `add_unclear`.
  - The event name covers both. Read its `reason` before calling a refusal a freeze.
  - A naming wart in the log, not a behaviour; noted, not changed.
- **C2 did what D1 says:** no proposal, so a new image. That is job `78b3b028`, mode `generate`: her photo as the
  `person` likeness, the hoops as the `object`.
- **Why it could not be read (vocabulary):**
  - The rules ask `add_unclear`: "add in hoops" names no place.
  - The interpreter's reply left her words uncovered. The record keeps no spans, so which words is not recorded;
    "in" and the photo pointer "from the second picture" are the candidates.
  - The same tray with "add the hoops from image 2 to my ears" routes (`FULL_IMAGE` `ADD_OBJECT`) and ran as a native
    edit (job `7977d7ae`), frame held.
- **Wave A (2026-09-17):** V1's recon found "from the second picture" already read (`sourceAt`); the sentence failed on
  "add in" and on no place. V2: a worn thing with no place takes its anchor (`WORN_DEFAULT_PLACES`), and "add in" is a
  particle, so it routes `ADD_OBJECT [hoops] "in my ears"` and compiles byte-identically to "add the hoops from image 2
  to my ears". V1 closed the pointer parity gaps it did find ("in image 2" in a replacement, "in the second picture"
  after an add). G4: `blockedOnAsk` logs `interpreter_ask_blocked`; `native_freeze_refused` is a refused freeze only.

## F-CA8 · A C2 fallback on an edit-shaped add is a NEW PHOTOGRAPH of her: full-body became knees-up, her frame not kept. Not an interpreter-frozen edit losing its frame. `[known behavior]` — **KEPT AS BUILT (Adi, 2026-09-17)**; the frame-discipline question moves to the native path, unobserved

- **Reported at acceptance as** "an interpreter-frozen native edit reframed, while the rules-compiled add held its
  frame". **The rows say otherwise** (every hoops job of the 36 hours before the read; none carries an interpreter
  record):

  | job        | when (Z)    | mode                                                           | her words                             | result                                            |
  | ---------- | ----------- | -------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------- |
  | `78b3b028` | 09-17 06:27 | **generate** (C2's fallback for F-CA7)                         | add in hoops from the second picture  | knees-up — a new photograph                       |
  | `7977d7ae` | 09-17 06:33 | native edit, rules-compiled (`FULL_IMAGE` `ADD_OBJECT` v1, 2K) | add the hoops from image 2 to my ears | frame held; 1008×1476 → 1696×2528, the 2:3 canvas |

- **A generate's prompt tells the model to take nothing of her photo but her likeness**: "Take nothing else from this
  photograph: not its background, its lighting or its framing". A reframe is that prompt working.
- **No interpreter-frozen edit ran in the pair**, so the pair cannot show a difference between the paths. There is
  none in the code:
  - an interpreter proposal freezes through the same `freezeEditIntent` and the same compile tier as typed words;
  - an add is region-free on both (no detection, no mask);
  - an interpreted add of this shape compiles to a byte-identical instruction ($0 replay: "add the hoops from the
    attached photo to her ears" ≡ "add the hoops from image 2 to my ears");
  - the only additions an interpreted intent can carry are a keep-the-person sentence and brand DO NOTs.
- **What IS real, and where it belongs:**
  1. **The product trade in D1.** "Never an ask" means an add she meant as an edit, which neither tier could read,
     comes back as a new image. Her frame and everything else in it are not kept.
     - **Adi's decision (2026-09-17): keep D1 as built.**
     - The mitigation is the generate card's copy line, already on the sweep pile, plus vocab-batch (F-CA7) making
       this sentence route as an edit.
     - Revisit only if it bites after the vocabulary lands.
  2. **The native path has no framing pin inside its ratio** (unobserved, a latent gap):
     - `aspectRatio` is pinned to the nearest supported ratio (compile/aspect.ts);
     - `assertEditKeptItsShape` refuses only an aspect drift above 15%;
     - the preservation clause names lighting, exposure, contrast, colour grade and scene, not framing;
     - QA has no framing check.
       A same-ratio zoom on a native edit would pass everything. No such output has been seen (7977d7ae held). A probe
       should come before a fix.

---

_The entries below were found building wave A (studio/wave-a, main `29b2fc8`, 2026-09-17). The evidence is in
[wave-a.md](wave-a.md). Routes are replayed at $0 on `29b2fc8` and the branch tip._

## F-WA1 · Rule 1 reads nouns across a full stop: "remove the ball in the air. for the cone on the ground make it blue" removes the cone. `[classifier-fix]` — **FIXED on studio/wave-b-paths** (C3a, the boundary half); per-clause refusal is C3b

- **Mechanism:** a clause is cut only at a joiner followed by an operation verb. "for the cone on the ground make it
  blue" leads with no verb, so the whole text is one clause and rule 1 claims every phrase after the stop: main froze
  `REMOVE_OBJECT [ball, air, cone, "ground make it"]`; wave A's V4 drops "ground make it" (a place after "on") and
  still removes the air and the cone.
- **Live repro for G2:** "remove the ball in the air. for the ball on the ground move it closer to my feet." is refused
  whole — `person_target` on "feet", which rule 1 claimed across the stop. Its second sentence alone is the catch-all
  (no rule reads "move", F-WA6), so even a per-clause refusal would ask `compound_partial` rather than route.
- **The card (Adi, 2026-09-17: split out of wave A as L-sized):** the sentence-stop boundary in the clause reader
  first; then per-clause refusal — a new `Routed` field for the dropped clause, carried by the freeze and the intent,
  disclosed on the preview, excluded from detection text, and composition's d1 reversed.
- **The boundary half, as built (wave B, C3a, on main `b3ee70c`).** `SENTENCE_STOPS` in `clausesOf`: a full stop cuts
  whatever leads the next sentence. The cone is recoloured, not removed, and the live G2 repro moves `person_target`
  → `compound_partial` — it still asks, because a move is still no operation (F-WA6).
  - **The cut does not ship alone, measured.** By itself it moved **24 corpus cells from routing to asking**, and the
    one class that is typed English is a courtesy tail ("make the socks blue. thanks"). So it ships with a drop:
    `ASKS_FOR_NOTHING`, a trailing clause leading with keep/leave/preserve/dont or a thank-you.
  - **The drop is a closed list because the obvious test is unsafe — built, measured, discarded.** "Does this clause
    name a change" (an operation verb anywhere, or a colour) is only as good as the verbs the rules have, and it
    silently dropped the move clause of this very card's repro. See F-WB1.
  - **Residue, ledgered:** `"ground make it"` is claimed as a second RECOLOR target. Rule 5 has no place-after-
    preposition reading — V4 added that to rule 1 only (F-WA3). The cone is still correctly recoloured.
  - **Corpus** (main `b3ee70c`, 8,084 sentences / 24,252 cells): 36 cells over 18 sentences — 2 route→route (this
    fix), 6 route→ask over three sentences (two are our own error copy; the third is F-WB1), 28 ask→ask.
    Scoped suite 82/2753/0 from a base of 82/2744/0.

## F-WA2 · "golden hour" on a region recolours it gold, and her golden-hour keep routes only because of that. `[classifier-fix]` — **LIVE on main**

- "make the beach golden hour" → `RECOLOR [beach] "golden"`; "give the whole photograph this look: golden hour." (our
  own GLOBAL_STYLE template's words) → `RECOLOR [whole photograph this] "golden"`.
- G3 measured taking "golden hour" out of rule 5: "make it golden hour, keep me the same" stopped routing. A3b sets her
  keep aside only where her WHOLE sentence routes, and it routes whole only as `RECOLOR [same] "golden"`. So the misread
  holds her keep up. Fixing either needs the other: A3b's gate, or rule 3 reading a look beside a keep.

## F-WA3 · A removal compiled "remove the sleeve": "remove the logo from my sleeve" froze REMOVE [logo, sleeve]. `[classifier-fix]` — **FIXED on studio/wave-a** (V4)

- Rule 1 claimed every phrase, and the freeze compiles one change per target. "remove the logo from the photograph"
  removed the photograph. V4 reads a phrase after on/from/off, right after a removed thing, as its place. Still read as
  a second target, ledgered: a place after "in" ("remove the ball in the air" removes the air).

## F-WA4 · Our own keep words, beside a removal, are removed: "keep the person exactly as-is and remove the net" froze REMOVE ["person exactly as-is", net]. `[classifier-fix]` — **LIVE on main**

- `readThingKeep` reads "the person" as a kept thing and `keptThing` refuses it (her), so rule 1 reads the whole
  sentence, and `namesPerson("person exactly as-is")` is false — its last word is "as-is". A compiled-line shape, not
  typed live; unchanged by V6, which holds every list item to the same check.

## F-WA5 · Clothing she wears is removable: "take my jersey off" and "remove my jersey" route REMOVE [jersey]. `[Mia]` — **LIVE on main**; V4 adds the separated form

- "take off my jersey" and "remove my jersey" routed on main; V4's "take X off" makes "take my jersey off" route the
  same way (the client's flag-off verb list already read it as an edit). Whether a garment she has on may be removed is
  a policy question, not a vocabulary one.

## F-WA6 · A move has no rule: "put the ball closer to my feet" asks `add_unclear`, and "move it closer to my feet" is the catch-all. `[classifier-fix]` — **FIXED on studio/wave-b-paths** (card 2), behind `STUDIO_MOVE_OBJECT`

- Main refused "put the ball closer to my feet" as an edit of her ("closer" read into the thing, "to my feet" a
  surface). G1 ends the thing at "closer to" and reads no place: a comparative measures from where the thing already
  is, and as an add it would put down a second ball. A move (REMOVE here + ADD there) is not an operation.
- **One correction to this entry, measured on main `2dc602e`:** "move it closer to my feet" is **`person_mentioned`**,
  not the catch-all. And the two-balls incident is not hypothetical — "put the soccer ball on the ground" **routes as
  an ADD today**, with `inventedObjectNote` telling her the edit will invent one.
- **The fix, as built (wave B, card 2; Adi's decisions, 2026-09-17).** `MOVE_OBJECT`, a ninth operation, behind
  `STUDIO_MOVE_OBJECT`, default off. Not compiled as a removal plus an add: two clauses cannot say "the same one,
  not a second" — nothing ties them to one object, `PATH_ORDER` runs the ADD before the REMOVE, and the add's own
  disclosure says the model will invent the thing.
  - **Verbs: move, shift, slide. `put` is NOT one.** It heads a real add whenever the thing is not in the frame —
    "put the gatorade bottle from image 2 on top of my head" says its source out loud — and no rule can tell the two
    apart, because that is a fact about the PHOTOGRAPH. Its move-or-add question is the freeze's (Adi's D-2b: definite
    thing, no source named or attached, detection found it). **Not built in this commit** — `put` routes exactly as it
    does on main, and the two-balls incident is still live. Its own commit.
  - **Where it already is, against where it goes** (Adi's call). A DIRECTIONAL preposition (to, onto, into, toward,
    closer to, next to, beside, between, on top of) is the destination and is REQUIRED; a LOCATIVE one (on, in, at, by)
    says which one she means and is consumed and dropped. So "move the ball on the ground closer to my feet" is
    `MOVE [ball] "closer to my feet"`; read the other way it was F-WA3's mangle, `MOVE [ball, "ground closer"]`.
  - **A fronted thing**, bounded to `for <the thing> … move it <destination>` — the shape the G2 repro is written in.
    A bare fronted phrase collides with rule 5's determiner reading and declines; so does a verb slot naming a second
    thing. Its destination is read by the plain form's own parser, so the two cannot disagree.
  - **The freeze demands the thing.** One region naming it, or the sentence asks: `move_target_absent` (none — a
    mis-detection, a stale region set, or a thing not in this photograph) and `ambiguous_move` (several). **Neither
    falls back to an add**, which is the whole point.
  - **Flag-off is byte-identical**, gated at the rule AND at `operationAt` — the second half matters because
    `CLAUSE_JOINERS`' verb test is shared by every sentence, so a move verb joining `OPERATION_VERBS` unconditionally
    would cut clauses in unrelated compounds. Measured: the flag-off corpus diff is C3a's 36 cells exactly, +0.
  - **Corpus, flag on** (main `7d12dbc`, 8,084 sentences / 24,252 cells): 40 cells over 20 sentences — C3a's 36 plus
    4 ask→route, every one a move. No route→ask beyond C3a's three. The compile goldens are +5, **purely additive
    (95 insertions, 0 deletions)**: no existing compiled prompt moved.
  - **`changeIsWellFormed` had no MOVE arm**, so its `default` read every frozen move as invalid and the preview
    refused it — a whole operation unrunnable, with nothing downstream able to say why. golden.test.ts's
    operation-coverage pin caught it, not a reading of the code.

## F-WA7 · G1's placements are the rules' only: the interpreter still refuses a non-worn thing placed on her. `[interpreter tier]` — **KNOWN**

- `addOk` (interpret/menu.ts) refuses a place naming her unless the thing is worn, and G1's prepositions are kept off
  ADD_PREPOSITIONS so interpret/5's text does not move. A reply proposing "add a bottle on her head" is `invalid_slot`,
  while the typed sentence routes. Parity needs a prompt version and an R1 re-record.

## F-WA8 · V2's anchors default words that name other things: glasses, chain, cap, ring. `[known behavior]` — **BY DESIGN (Adi's V2)**

- "add glasses" is sunglasses-on-her-face, not drinking glasses; "add a chain" a necklace; "add a cap" headwear; "add
  a ring" a finger ring. Each was already a worn word (M3); with no place, it now lands on her. A place still decides:
  "add glasses to the table" is rule 4½'s.

## F-WA9 · Unread photo pointers and sky edges. `[classifier-fix]` — **KNOWN**

- "the 2nd picture" / "3rd image": the tokenizer reads "nd" / "rd" (V1's recon; Adi: ledgered).
- "make the sky <look>" is RECOLOR [sky] with her look word, paired by detection; that the directive comes back as
  "<look> sky" and that SAM masks a sky well on the flag-off path are both unmeasured (V4). "make the grass moodier"
  and any other region's look still ask.

## F-WA10 · A kept list is bounded: five or more things, or a list of scene words, reads as main did. `[classifier-fix]` — **KNOWN** (V6)

- Two to four items. Past four ("keep the ball, cone, bench, goal and flag and remove the net") no list is read and
  rule 1 removes the ball. A list whose items are our preservation sentence's words ("keep the lighting and the
  contrast") is refused as a list (#488's guard, extended) and reads as main did — recolouring them beside a colour.

## F-WA11 · The corpus extractor dropped about a third of the quoted strings: earlier corpus diffs covered less than they reported. `[evidence]` — **FIXED in wave A's harness** (tools/wa/diff.ts); earlier counts are not to be trusted

- **The bug:** the extractor's template-literal branch, `` `((?:[^`\\$]|\\.)*)` ``, could span lines. A template's
  closing backtick opened a false match that ran to the next backtick in the file, and every quoted string in between
  was swallowed — single-line strings included, not only multi-line ones.
- **Measured on main `29b2fc8`** (83 Studio and client/lib test files): the old extractor finds **5,261** strings, the
  fixed one (`\n` excluded from the template branch) **7,668**. It covered **68.6%** — it dropped 31.4%.
- **Which harnesses carried it** (the regex, by file, outside the repo under `nomila-v2-worktrees/tools/`): `route-diff.ts`
  (composition PR 2), `guard-scope/`, `m3/`, `t/` (the text op), `i/` (the interpreter), `v/` (the style vocabulary),
  `pf/` (the preservation fixes), `ge/preview-diff.ts` (the new-image exit), and wave A's own first runs. **Not:**
  `am/`, `ca/`, `fd/` (auto-mark, C2, frame defaulting — a separate double-quote-only builder, single-line by
  construction, with its own narrower scope), and `w3/` (wave-3 fixes — already had the fix).
- **What it means:** each affected PR's predictions still matched on what its diff ran; the diff simply ran over fewer
  sentences than the evidence said. Any "N sentences / N cells" count from those builds is an undercount of the test
  corpus, and a claim of "zero unexplained moves" holds only over the strings that were read. **Future archaeology must
  not trust earlier counts**; re-run with the fixed extractor before leaning on one.
- **Wave A's own record:** every per-commit diff was re-cut with the fixed extractor (~8,000 sentences) before its
  numbers were recorded in wave-a.md; the first runs' counts are superseded, not cited.

## F-PA1 · A Product photo on a NON-add native edit still travels as "PRODUCT: … Render this exact object" with nothing pointing at it. C3 narrowed F-AM5 and did not fix it. `[model tier]` — **LIVE on main**, probe STAGED (Adi runs)

- **C3 fixed F-AM5's narrowest case.** A lone Product photo and an add, no Object photo: the instruction now names it
  ("add the water bottle from Image 2, …"), its manifest line is the Object line, and the preview says so.
- **Inherited, unchanged:**
  - a product beside a non-add edit ("make the socks blue" + her sneakers in the Product tile);
  - a product beside an add that places an Object photo (golden "product add — an Object photo beside her product is
    the thing…": the boot keeps its PRODUCT line);
  - an add beside two or more products (asks when marked, a new image when auto-mark would have marked);
  - a brand's SKU pieces on every brand-job native edit (golden "native — a brand's DO NOTs and its imagery ride
    along": the training jersey rides a recolour). These are never binding candidates: they are `brief.brand`'s,
    not her references.
- **Whether the model inserts an unaddressed product is unmeasured.** Probe F1 (n=2) is staged in
  `tools/pa/probe.ts` beside F2, 4 calls, $0.80 cap (two-reference calls quote ~$0.196 each).
- **The fix, if F1 shows insertion, is its own card:** drop or reword an unaddressed product on a native edit. It
  moves 3 native goldens: the brand's DO NOTs, and the two "a product sorts ahead" fixtures.

## F-PA2 · A replacement pointed at a PRODUCT photo still asks for an Object photo. `[known behavior]` — **OUT of C3 (Adi, 2026-09-17), its own card**

- "change my shoes to these sneakers" with the sneakers in the Product tile asks `object_photo_missing`. So does
  "change my earrings to these gold hoops" with the hoops there (golden "replace-with-ref — the founder's sentence,
  her hoops as a PRODUCT: it still asks").
- **Why it is not C3's two-line change.** A pointed replacement is decided by the CLASSIFIER, on a count of Object
  photos:
  - route()'s `Attached`, which the client sends as `objectPhotos` (`objectPhotosIn`);
  - the interpreter's `pointed_swap` menu entry and canonical clause read the same count;
  - so does its memo key.
    Counting a lone product there moves the route diff, the interpreter's menu text (a PROMPT_VERSION and R1
    question) and the client contract, not only the freeze.
- 32 pointed replacements in the 29b2fc8 corpus route with an Object photo; each asks beside a product.

## F-PA3 · (b), binding a product only when she points at it ("from image 2", "this bottle", "the second picture"), is a future upgrade card, sequenced behind wave A's V1. `[classifier-fix]` — **CARD**

- Adi chose (c) for C3: bind automatically, and say so before she pays (F-PA4).
- **(b)'s costs, from C3's recon:**
  - the pointer must be read from HER words, but an interpreted preview freezes C, so her pointer has to travel
    beside it;
  - demonstratives are ambiguous: "put a water bottle next to this cone" points into the frame;
  - with two or more products an ordinal needs tray position mapped to the server's reference order, which nothing
    does today;
  - the classify response needs a field for the composer's auto-mark gate;
  - the pointer grammar is exactly what wave A's V1 is extending in classify.ts.
- **Corpus, 29b2fc8 (approximate regex):** about 19 of 103 routed adds and 7 of 53 add asks carry a pointer.

## F-PA4 · The placed-product card note cannot name WHICH photo, and three new lines are placeholder copy. `[copy]` `[Mia]` — **LIVE on the branch**, copy/UX pile

- The client sends no label for a reference, so the manifest's label is "product 1" and the note says "your product
  photo". With one product that is unambiguous, which is the only case that binds.
- For the review pile:
  - "Your product photo will be used as the water bottle. If it shows something else, put the right photo in the
    Object tile and check again."
  - "More than one product photo is attached, and it isn't clear which one to add. Put the one you want added in the
    Object tile and check again."
  - "This adds more than one thing, and a product photo is attached — which thing it shows isn't clear. Add them one
    at a time."

## F-PA5 · A product shot showing a PERSON (a model wearing the piece) can now be an add's thing, and nothing checks the photo for a person. `[guard]` — **LIVE on main; its home, the weak-ref-detection card, is SHELVED (Adi, 2026-09-17). Warn-only whenever it revives.**

- Before C3 a Product photo rode an edit unaddressed. Now a lone one is placed: "THE OBJECT to place in the frame …
  Take the object from this image … Nothing else about this image carries over". That line is prose the model can
  disobey, and brand product shots are more often lifestyle shots than an Object-tile photo is.
- **The same exposure already exists** for the Object tile (a hoops photo worn on a model), and no model output has
  shown a leak from either.
- **What C3 does NOT change:** a photo tagged as her is never an add's thing (nativeIntent pin);
  `refusedOnEdit` still blocks a person reference on an edit and routes no likeness (preview pin, revert checks
  RV-16/17, corpus T6 with 0 exceptions).
- **The right future home is face detection on references** (the weak-ref-detection card): a person found in a
  product or object photo placed by an add is WARNED ABOUT — never refused, and never an ask.
- **⚠️ AMENDED 2026-09-17 (wave C, Adi). The wording above used to read "refuses or asks"; it is warn-only now,
  and the card that would carry it is shelved.** Both halves matter to whoever revives this:
  - **Warn-only, not a gate.** A refusal here would block a legitimate job on a guess about a photograph we never
    read. The exposure is a model DISOBEYING prose ("Nothing else about this image carries over"), which no
    output has yet shown, and the same exposure has ridden the Object tile since before C3 without incident.
    Advice she can overrule is proportionate to that; a refusal is not.
  - **Why the card faded, so this is not re-litigated from scratch.** Three reasons, in order of weight:
    reference packs already mitigate the failure this would have prevented — the measured one was a weak LONE
    upload (`e58f3a5a`, face 0.19 of frame, a stranger 6/6), and the same photograph inside a pack of three came
    back as her 4/4 (docs/probes/reference-packs.md); the threshold evidence is **n=3 photographs from one
    athlete**, which is not enough to site a number on; and warn-only advice does not justify new plumbing on the
    upload or attach path today.
- **What reviving it would have to solve, recorded now while it is known.** There is no "You photo" upload to hang
  a scan on: the picker's roles are `source-frame` / `product` / `object` (client/screens/studio/AttachSheet.tsx),
  the person role is decided by her SENTENCE at classify time, and `UploadRole` is `"product"` alone
  (client/hooks/use-media-library.ts). So the Product half is identifiable at register and the You half is not.
  `enrichNextChunk` is also fired UNAWAITED from POST /media, so nothing vision-derived is reliably present when
  the upload response is built — an upload-time warning needs its own call, not a free ride on enrichment.
  `server/studio/qa/face.ts` already returns `sizeFrac`, a `small` flag and the closed `FaceMiss` codes, so the
  measurement half is built; only the placement is open.

## F-PA6 · An add beside two or more products, or two adds beside one product, ASKS when she marked the photo, and is a new image when only auto-mark would have marked it. `[known behavior]` — **BY DESIGN (Adi's decisions 4 and 5, 2026-09-17)**

- The freeze answers `ambiguous_object` with `products` (and `adds`), each with its own note. It never guesses.
- The composer keeps D5 (b) for two or more products, so auto-mark never hands her that question. Two adds beside
  ONE product are marked, as with one Object photo, and the sheet asks.

---

_The entries below were found while building wave B (studio/wave-b-paths, main `b3ee70c`, 2026-09-17), replayed at
$0: `route()` and the corpus diff in-process, no model, no row._

## F-WB1 · A second sentence that points BACK at the first loses its verb to the stop boundary: "remove the ball. it is in the air" asks. `[classifier-fix]` — **KNOWN** (C3a's own cost, accepted)

- **Before (main `b3ee70c`):** `REMOVE_OBJECT [ball, air]` — rule 1 read across the stop and claimed "the air" as a
  second thing to remove, which is F-WA3's ledgered residue (a place after "in"). **After C3a:** `compound_partial`,
  and the interpreter reads it (`+i`).
- **Why it is accepted.** The old greed served an elliptical continuation ("…it is in the air", "…the cone too") by
  accident, and served it wrongly — the compiled instruction removed the air. An ask the interpreter answers is the
  better of the two, and it is the only typed-English route→ask in C3a's whole corpus diff.
- **What would close it** is a reading for a clause that refers back to the first's target — the same class as rule
  4½'s `continuationAt` ("place it …"), which is read only after an add. Not attempted here.

## F-WB2 · `!` and `?` do not end a clause: "remove the cone! for the ball on the ground make it blue" reads as one. `[classifier-fix]` — **KNOWN**

- `TOKEN` emits all of `. , ; : ! ?`, but `CLAUSE_JOINERS` has only `, . ;` — so the loop in `clausesOf` skips `!`
  and `?` before C3a's stop test is ever consulted. Unchanged from main; C3a's boundary is the full stop's alone.
- **An earlier draft of C3a's own note claimed they cut, and jest caught it.** Worth recording as a reading error a
  docstring can carry: the tokenizer emitting a character is not the same as the clause reader joining on it.
- **What closing it costs:** `CLAUSE_JOINERS` is also the set the loop CONSUMES in its joiner run
  (`while (CLAUSE_JOINERS.has(t[j]) …)`), so adding two members is a second behaviour on every sentence with a run,
  not a one-line widening. Its own commit, with its own corpus diff.

## F-WB3 · Per-instance targeting: one noun, two of the thing, and only where each one is tells them apart. `[classifier-fix]` — **BY DESIGN (Adi, 2026-09-17)**

- **The sentence** is the G2 card's own lead repro: "remove the ball in the air. for the ball on the ground move it
  closer to my feet." There are TWO balls. Both clauses target `ball`, so `removesWhatAnotherChanges` fires and the
  sentence asks `compound_conflict` — correctly, by that guard's own rule, which cannot see that they are different.
- **Why it is not fixed.** A target is a NOUN handed to detection. What distinguishes these two is a LOCATION, and
  the single-noun target model has no room for one: "ball on the ground" is four words against `MAX_TARGET_WORDS`'
  three, and it is a phrase detection cannot find. The same limit produces `ambiguous_move` at the freeze when one
  noun matches two regions.
- **Both patches were weighed and refused (Adi's call).** Exempting a move from the removal-conflict guard weakens a
  guard that is usually right — "remove the ball and move the ball closer" IS contradictory. A disambiguator field on
  `EditStep` is architecture for one sentence, with no second incident to justify it.
- **Where it would live if it recurs:** the MASKED / region path, card 1's territory. A masked arm points at a
  REGION, not a noun, so two instances are two regions and the ambiguity disappears at the point where the evidence
  already exists. Nothing to build until a second sentence needs it.
- **The progression on the lead sentence is the actual win, and it is what card 2 claims:**

|                | route                                                                         |
| -------------- | ----------------------------------------------------------------------------- |
| main `2dc602e` | ASK `person_target` — a refusal about HER, for a sentence that edits no one   |
| + C3a          | ASK `compound_partial` — the stop boundary; the removal is read on its own    |
| + card 2       | ASK `compound_conflict` — both clauses read, and the conflict is the true one |

## F-WB4 · A lone background edit dead-ends on a field detection may or may not return. `[Mia]` `[guard]` — **PROPOSAL ONLY, NO DIFF** (shared detection, not Mila's code)

**The symptom, from probe 1b (`docs/probes/framing-identity-stranger.md`).** With real detection,
`"change the background to a beach at sunset"` **blocked at preview on both frames tried** —
`7fe0b609` (region 1106x1518, the whole frame) and `517ed082` (959x1408, 91% of it). The probe stopped
after two, fabricated no region, and never got to measure the background arm's framing at all. Her
library nonetheless holds **12 background natives that DID run**, this very sentence among them
(`5581e882`). So whatever refuses is not refusing a malformed ask.

**The mechanism, read off the code rather than inferred** (all of this is shared, pre-existing, and
none of it is touched by wave B):

1. `parseAutoMask` (`server/studio/autoMask.ts:359`) short-circuits a background answer **only** when
   the detection entry carries `scope: "background"` **and** `backgroundMaskEnabled()` is true. That
   branch is the one place in the codebase that ever sets `subjectNoun`, and it sets it to `"person"`
   by construction rather than reading it — correctly, since there is exactly one word it could be.
2. Miss either condition and the entry falls through to the object loop, where the label becomes
   `labelFor(directive)` — **the directive is the region's label**, so a whole-frame box comes back
   labelled "a beach at sunset" with no `samNoun` and no `subjectNoun`.
3. `wholeFrameEditBlocker` (`server/studio/preview.ts:817`) then finds a region that
   `coversMostOfFrame` with no `subjectNoun`, and blocks:

   > "We couldn't work out what to change here — the area we found covers the whole photo, and editing
   > all of it would redraw you along with the background. **Try naming the thing you want changed**, or
   > mark just that area."

   She named the thing she wanted changed. That is the whole sentence.

**⚠️ AND THE ROLLBACK STORY IN `autoMask.ts` IS STALE — this is the part worth Mia's attention.** Its
own comment says of the flag: _"With the flag off a background entry is simply not recognised: it falls
through to the object loop below, becomes an ordinary whole-frame region with no noun, and **re-renders
the frame the way it did before this feature existed**. Ungated, turning the flag off would REFUSE
background edits instead of reverting them — which is a different product, not a rollback."_

That comment is from **#373 (`3f92fe9`)**. `wholeFrameEditBlocker` arrived in **#377 (`8f8ecc8`)**,
four PRs later, and it refuses precisely the shape the comment describes as the safe fall-through. So
the flag's documented "off is today's behaviour exactly" guarantee was silently inverted by a later
guard: **with `STUDIO_BACKGROUND_MASK` unset — which is its default (`config.ts:804`, it must equal the
string `"true"`) — a whole-frame background detection is now blocked, not reverted.** Nobody chose
that; two correct changes composed into it.

**Which also makes the probe's two blocks diagnosable for free.** Either the probe ran with the flag
off (in which case the block is #377 refusing #373's fall-through, and it reproduces for every athlete
on every frame), or it ran with the flag on and the detection model did not label the entry
`scope: "background"` (in which case it is genuinely non-deterministic, as 1b concluded). **One env var
separates those two stories** and the answer changes the fix completely — so read it before building
anything.

**Proposal, and it is a proposal because the blast radius is every background edit in the product:**

- **If the flag is off in production:** reconcile #373's comment with #377's guard. Either the blocker
  exempts a whole-frame region whose label came from a background directive, or the flag's default
  changes, or the comment is corrected and the "rollback" is acknowledged as a refusal. Pick one
  deliberately; today the code does the third by accident and says the first.
- **If the flag is on and detection is unreliable:** the guarantee has to move out of the model.
  `scope` is a judgement we already refuse to trust about geometry (the box is SET, not read, and the
  comment says why) — the same argument applies to `scope` itself when the instruction is a background
  ask the classifier has already routed as `CHANGE_BACKGROUND`. We know it is a background edit before
  detection is called.
- **Either way, the copy is wrong in this case.** "Try naming the thing you want changed" cannot be
  acted on by someone who named it. A refusal she can act on would name what we could not do.

**Not ours to fix, and deliberately not attempted here.** `autoMask.ts`, `preview.ts`'s blocker and the
flag are shared code on the path every edit takes; `CLAUDE.local.md`'s scope rule puts a change there
with Mia, and the honest version of this entry is the diagnosis plus the choice, not a patch.

## F-WB5 · A move refuses when detection returns a region but no noun — and `moveRegion` reads the wrong field to begin with. `[classifier-fix]` — **FIXED in `f3ea3ca`: (a) + (d), Adi's order** (wave B, card 2 acceptance)

**Found in acceptance, 2026-09-17, on a frame that plainly holds the ball.** The preview shows the
detected region, quotes $0.17, and then refuses:

> "We couldn't find that in your photo, so there's nothing to move. Name something that's already in
> the picture, or add it instead."

**Adi's log line settles the first half:** `found:1 scopes:["object"] nouns:[{reason:"absent"}]`
(`autoMask.ts:688`). Detection **did** find one object-scope box — the ball — and proposed **no
`samNoun`**, so `classifyNoun` returned `"absent"` (objectVocab.ts: "no samNoun proposed at all").

**And the refusal is card 2's own defect, not detection's.** `moveRegion` (nativeIntent.ts:268) is:

```ts
const found = regions.filter((r) => namesTarget(r.label, target));
if (!found.length) return { reason: "move_target_absent" };
```

It reads **`label`, and only `label`**. Two things are wrong with that:

1. **The label is the DIRECTIVE, not the noun.** `parseAutoMask`'s object loop sets
   `label = labelFor(directiveOf(e) ?? instruction)` — that is the whole point of the multi-target fix
   ("THE LABEL IS THE DIRECTIVE, AND THIS ONE LINE IS THE WHOLE MULTI-TARGET FIX", autoMask.ts). The
   concrete noun goes to `samNoun`, which this function never reads. `namesTarget` requires the label
   to END with her target words, and a move's directive does not end with her noun. Since the log
   shows `found:1` and the freeze still refused, the label here did not end with it — that is
   inference from the refusal, not a guess.
2. **My own docstring on `namesTarget` records the misreading**, and it should be read as the bug
   report it is: _"Detection is asked for the CONCRETE noun — 'soccer ball' for the ball at her feet …
   (studio/autoMask.ts, `samNoun`) — so … her 'ball' against a region labelled 'the soccer ball'."_ It
   cites `samNoun` as the reason the LABEL is specific. The field it describes is not the field it
   matches.

**Why the recolour path does not have this bug**, which is why it went unnoticed: `recolourChange`
also reads labels, and for a recolour the directive _happens_ to end with the noun ("make the socks
blue" → "blue socks" → ends with "socks"). Label-matching is coincidentally right for recolours and
structurally wrong for moves.

### The options

|         | shape                                                                                                                                                                               | fixes THIS case?                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** | `moveRegion` matches `samNoun` **as well as** `label`                                                                                                                               | **No** — the noun is absent here. Right regardless, and small.                                                                           |
| **(b)** | Trust the request: a region returned to a single-target detection request IS that target. Needs the request's target list beside the frozen region                                  | Yes, but it is a frozen-brief shape change                                                                                               |
| **(c)** | Loosen `namesTarget` from "label ends with target" to containment / word overlap                                                                                                    | Sometimes — and it weakens the over-match that `ambiguous_move` depends on, which is the property F-WB3 is built on. Cheapest and worst. |
| **(d)** | **Adi's.** Noun absent **and exactly one object-scope region** → treat that region as the candidate, with a pre-spend note naming the assumption (C3's `placedProductNote` pattern) | **Yes**                                                                                                                                  |

### (d) is the right shape, and the codebase already argues for it

`samNoun`'s own documentation says its absence is **"a supported state rather than a gap"** and that
such regions "composite through the rectangle exactly as they did before this feature" — and that it
"exists only to be handed to SAM-3 … never sent to the edit model". So a missing `samNoun` is a
**mask-quality** fact, not an identity fact. Blocking a move on it conflates the two: we know WHERE
the thing is (we have the box, and the preview draws it); we merely lack the word the segmenter would
have used to tighten the mask.

It does not reopen the two-balls risk. "Exactly one" is the guard: two regions are still
`ambiguous_move`, and the invented-second-ball failure was an ADD's, which is untouched.

**⚠️ One implementation constraint, measured rather than assumed: the frozen `EditRegion` has no
`scope`.** It carries `label`, the box, `samNoun?` and `subjectNoun?` — scope lives in `autoMask.ts`
and is consumed there. So "exactly one object-scope region" is not a fact the freeze can read today.
Two ways out, and the second needs no new field:

- plumb `scope` (or a count) onto the frozen region — a brief shape change, and old briefs lack it;
- **use "exactly one region, and it carries no `subjectNoun`"**, which is equivalent: background is
  the only other scope, `parseAutoMask` sets `subjectNoun` on it by construction, and `EditRegion`'s
  own doc says the two nouns are NEVER set together. Same discriminator, existing fields.

### BUILT — `f3ea3ca`, (a) then (d), and what (d) cost

**(a)** `moveRegion` matches `samNoun` as well as `label`. **(d)** when nothing names her thing and
exactly ONE region carries no noun to confirm it with, that region is the candidate and
`assumedMoveNote` tells her before she pays — C3's `placedProductNote` pattern, through the existing
degraded warning, no new UI. The guard is kept: two unnamed candidates still ask `ambiguous_move`, and
a frame with no regions still asks `move_target_absent`.

**⚠️ THE TRADE, PINNED AS A TEST RATHER THAN LEFT IN THE DIFF.** A region that named something ELSE
used to refuse, and is now assumed-and-disclosed. Nothing on the frozen record separates "detection
proposed no noun" from "the noun it proposed was rejected" — `samNoun` is `undefined` for both, as that
field's own doc states — so a single region cannot be told from a single WRONG region. The old test
asserted that all three of `[]`, `[cone]`, `[boot]` refuse; it now asserts `[]` refuses and `[cone]` is
assumed with a note. That is the new truth, not a loosened assertion, and the disclosure plus the drawn
region are what make it acceptable.

**Revert checks, 4 of 4 flipped by name** (`tools/wb/rc-w5.sh`): (a) reverted; (d) reverted; "exactly
one" widened to "the first" (flips the two-balls guard); and the assumption no longer recorded (flips
both disclosure cells — the difference between (d) and a silent guess).

## F-WB6 · "make my uniform, shoes and socks adidas. make them the color blue too." — a cross-clause PRONOUN recolour, unread since long before wave A. `[classifier-fix]` — **NOT A REGRESSION; BUILT in `a29427d`** (wave B, card 2 acceptance)

**Raised in acceptance as a gating regression in the founder brand-compound family. It is not one.**
Routed on three trees, `photo=true`, `route()` in process:

| tree                                | route                   |
| ----------------------------------- | ----------------------- |
| pre-wave-A `29b2fc8`                | `ASK(compound_partial)` |
| main / this branch's base `7d12dbc` | `ASK(compound_partial)` |
| wave B tip `87eacbc`                | `ASK(compound_partial)` |

**Byte-identical.** It is **not one of C3a's 6 route→ask cells** — those are three sentences, two of
them our own error copy and the third `"remove the ball. it is in the air"` (F-WB1). Neither wave A
nor wave B moved this sentence.

### What DOES work, which is why it reads as a regression

| sentence                                                                 | route                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `make my uniform, shoes and socks adidas.`                               | three `REPLACE_OBJECT`s — **the brand compound is fine**                       |
| `make my uniform, shoes and socks adidas. make the socks blue too.`      | the three, **plus** `RECOLOR[socks]=blue` — **a NOUN second sentence is fine** |
| `make my uniform, shoes and socks adidas. make them the color blue too.` | `ASK(compound_partial)`                                                        |
| `make my uniform, shoes and socks adidas and make them blue`             | `ASK(compound_partial)` — **the stop is irrelevant**                           |
| `make my jersey adidas. make it blue.`                                   | `ASK(compound_partial)` — singular too                                         |

The family works. The **pronoun** does not, and never has.

### And the stop is not the cause, so C3a is not implicated

`CLAUSE_JOINERS` has contained `"."` since before wave A (`classify.ts:2650` at `29b2fc8`), cutting
at a stop whenever an operation verb follows. `make` IS an operation verb, so this sentence has been
cut into two clauses on every tree. C3a only added the case where the next clause does **not** lead
with one. The `and`-joined variant asking identically is the proof.

**So of the two fixes proposed, one is a no-op:** "revert the drop for verb-led second sentences" has
nothing to revert. The drop (`ASKS_FOR_NOTHING`) is a closed list of keeps and courtesy; a clause
leading with `make` is never on it. The sentence asks because the clause is **UNREAD**, not dropped.

### The real fix, costed

**What it would read:** a clause whose recolour target is a bare PLURAL pronoun (`them`) resolved to
the immediately preceding READ clause's targets.

**Where it lands, and the architectural cost — this is the headline.** `readClauses` today is
`clauses.map((c) => ({ text: c.text, read: classifyFast(c.text, true) }))`: **every clause is
classified in isolation, with no reference to any other.** Anaphora is the first cross-clause
dependency in that function. Two shapes:

- **(i) a pre-classification rewrite** — after the independent pass, re-read an unread clause that
  leads with a recolour verb plus a plural pronoun, substituting the previous clause's targets into
  its TEXT and classifying that ("make them blue" → "make the uniform, shoes and socks blue").
  Rule 5, `validate` and the step shape are untouched, and the precedent is `readAs`, which already
  rewrites what detection and the compile tier see. **Recommended.**
- **(ii) an unresolved pronoun target on the step**, filled in by `compose`. More invasive: the step
  carries a target no rule can validate until later.

**⚠️ IT MUST NOT TOUCH `it`.** Measured: **75 corpus cells ROUTE** on `make it warmer / moodier /
golden hour` as `GLOBAL_STYLE`. `it` already means the photograph. Reading `it` as "the previous
clause's targets" puts all 75 at risk and needs a colour-vs-look discriminator (`isDescriptor` could
carry it) — a second decision, not this one. Scoping to `them` costs those 75 nothing.

**⚠️ AND THE CORPUS CANNOT EVIDENCE IT.** The whole plural-pronoun population is **8 cells**, and
**not one is this shape**: six are demonstrative DETERMINERS with their own family and reason
(`make these cleats pink adidas`, `make those adidas` → `brand_change`), one routes (`make these pics
black and white`), and the last — `make them yellow because the brand asked` — is a LEADING clause
with no antecedent to resolve. So a corpus diff on this fix would move **≈0 cells and prove only that
it broke nothing**. Its evidence has to be hand-written cells, and the question it cannot answer is
how often she types it. **That question is free to answer from the live ask log** (`fast_path_declined`
and `compound_partial` events), and should be, before the build rather than after.

**Size: S–M, one commit** — `classify.ts` (the rewrite pass), `classify.test.ts` (the family and the
negatives, including `it` left alone), `nativeIntent.test.ts` (the freeze and compile of the resolved
targets), a corpus diff predicted at ~0, and goldens unmoved unless a new fixture is added.

### BUILT — `a29427d`, scoped to `them` by Adi

The rewrite went in as costed. Both live forms route with **all three garments**, and the repeated
determiner is why: `"make the uniform, shoes and socks blue"` reads `RECOLOR[uniform]` alone, so a plain
join would have dropped two of them silently. The antecedent's operation is a closed list because
`CHANGE_BACKGROUND`'s step target is `person` — a background antecedent would have recoloured HER.

Numbers, this commit alone against a worktree at `020dd34`: corpus **10 cells over 5 sentences, every
one `ask→route`**, and the 5 are exactly the 5 hand-written cells. The **`it` control: 141 sentences,
423 cells, 295 of them routing, 0 MOVED.** Goldens 0 of 115. **Revert checks 4 of 4 by name**
(`tools/wb/rc-w6.sh`) — including one that had to be rewritten because the first draft mutated the guard
and not the constant, and so flipped nothing while appearing to pass.

### ⚠️ THE ASK-LOG COUNT IS NOT FREE FROM THE DATABASE, AND HERE IS WHY

Adi asked for the live count of this shape. **There is no table to query.** `logFallThrough`
(`classify.ts:4421`) writes `event: "fast_path_declined"` with the reason code through **pino only** —
nothing inserts it into Postgres, so no SQL answers it. It has to come from Cloud Logging, which Claude
is permission-denied for here. The query, for Adi to run:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND jsonPayload.event="fast_path_declined" AND jsonPayload.reason="compound_partial"' \
  --project gamechanger-pocket-agent --freshness=30d --limit=500 --format='value(timestamp)' | wc -l
```

**And it can only ever give a COUNT, never the sentences** — deliberately: the log line's own note says
"Reason codes only. Her sentence and the labels detection wrote from it never reach a log line." So the
number bounds how often the _class_ fires; which sentences are inside it stays unknowable from the log,
by design. That is worth knowing before anyone plans to mine it for the next vocabulary batch.

## F-WB8 · Detection under-finds: `found: 1` on a frame holding TWO balls. `[Mia]` `[recalibration]` — **VARIANCE, recorded not solved** (wave B, deep sweep D1)

The live D1 frame holds two balls — one on the crossbar, one already on the ground — and detection
returned **one** region, with its noun `absent`. D1's fix is built on top of that answer and cannot
correct it: "exactly one candidate" is a count of what detection returned, so an under-find presents as
a clean single candidate and takes the assumed-target branch with its disclosure, where two found
regions would have asked `ambiguous_move`.

**So the guard is only as good as the count.** That is the honest bound on D1 and on F-WB5 (d) both, and
it is why the assumption is disclosed and the preview draws the region: she can see which ball is about
to move. Owner: detection calibration, Mia's. Not solved here, per Adi.

## F-WB9 · Finish and material adjectives are not read at all — "shiny", "look worn". `[classifier-fix]` — **OPEN, vocab card** (wave B, deep sweep D3)

Confirmed on the tip, and it is **not** F-WB6's pronoun path:

    make the cleats white                  RECOLOR[cleats]=white
    make the cleats shiny                  ASK(fast_path_declined)      ← the VALUE, with a noun
    make my jersey look worn               ASK(fast_path_declined)
    make the cleats and socks white and make them shiny   ASK(compound_partial)
    make my jersey and shorts red. make them look worn.   ASK(compound_partial)

The pronoun resolves fine; the clause then asks because **"shiny" and "look worn" are values no rule
reads**. A noun in the same sentence asks identically, which is the proof. The wave-B test cells that
used these sentences were mine and they overreached — F-WB6 is scoped to a colour.

**The card:** a finish/material vocabulary on garments — shiny, matte, glossy, worn, faded, distressed —
and the decision of whether each is a `RECOLOR` value, a `GLOBAL_STYLE`, or its own operation. Sized
with the style vocabulary's own precedent (`lookVocab.ts`), not here.

## F-WB10 · A half-routable compound falls to a generate rather than routing what reads. `[product]` — **3b's LIVE INCIDENT** (wave B, deep sweep D4)

`make my jersey and shorts red. make them look worn.` untapped → generate. That is C2 working as
designed: auto-mark eligible → interpreter read → declined → generate, never an ask. But the sentence is
**half routable** — the recolour reads perfectly and only "look worn" does not.

**Routing what reads and disclosing what was dropped is exactly 3b**, which this wave faded for lack of
a live incident. This is the live incident. Recorded here as 3b's revival evidence; whether 3b un-fades
is Adi's call. Nothing built.

## F-WB11 · A logo swap: most of it already routes, and what does not splits into three small pieces and one large one. `[classifier-fix]` — **COSTED, not built** (wave B, deep sweep D5)

**⚠️ THE VOCABULARY ASK IS ALREADY DONE.** Mark nouns are not rejected as brand targets — `brandItemAt`
reads an open target and rejects only `VAGUE_NOUNS`, `META_NOUNS` and pronouns, and "logo"/"swoosh" are
in none of them. Measured on the tip:

    change the nike logo to adidas             REPLACE_OBJECT[nike logo]="adidas logo"
    swap the nike logo for adidas              REPLACE_OBJECT[nike logo]="adidas logo"
    make the logo adidas                       REPLACE_OBJECT[logo]="adidas logo"
    change the nike swoosh to adidas stripes   REPLACE_OBJECT[nike swoosh]="adidas swoosh"
    replace the nike logo to be adidas         ASK(brand_change)        ← the live sentence
    make the logo on my jersey adidas          ASK(brand_change)

**And the auto-mark ask is already done too:** `brand_change` is in `EDIT_SHAPED_ASKS`
(`client/lib/studio-contract.ts`), so a marked You-photo already badges without a tap. The untapped
fall-to-generate in the sweep is the interpreter declining `invalid_slot` and the client's D1 new-image
fallback (F-CA8) — not a missing auto-mark. **And the compile decision is already made in code:** the
routing phrasings compile `REPLACE_OBJECT` on the MARK, not the garment. Whether the model renders a
mark-only swap better than a garment swap is **unmeasured** — I found no Q5 evidence for a mark-only
cell, so that recon would be paid.

**So what is actually missing is four things, and only one of them is big:**

|     | piece                                                                                                                                                                                                                                                                  | size                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | **`replace` as a brand verb.** `BRAND_VERBS` is change/turn/switch/swap/make. ⚠️ `replace` is already the replace-with-reference verb (`parseReplacement`), so adding it here is not one word — it is an ordering decision between two rules, with its own corpus diff | **S**, with a collision to prove absent                           |
| 2   | **`to be` as a brand link.** `BRAND_LINKS` is to/into/for; "to be" is two tokens                                                                                                                                                                                       | **S**                                                             |
| 3   | **A place after the target** — "the logo ON MY JERSEY". Exactly the reading V4 gave rule 1 and rule 5 and rule 4c never got                                                                                                                                            | **S–M**, with a precedent to copy                                 |
| 4   | **The exclusion** — swapping TO adidas compiling an explicit removal of the nike mark so the two never coexist                                                                                                                                                         | **M–L**, and it touches `exclude_marks` and the both-marks defect |

**⚠️ AND ONE DEFECT FOUND WHILE COSTING IT, worth its own line:**
`change the nike swoosh to adidas stripes` compiles **`"adidas swoosh"`**. She said STRIPES and the value
normalizes to the mark she is swapping AWAY from. Same family as B.1c's dropped-word disclosure, and it
is live today on a sentence that routes.

**Verdict, per Adi's rule: pieces 1–3 are S/S–M and could land; piece 4 pushes the card as a whole above
S–M, so the card goes to wave D** and the exclusion goes with it. Nothing built here.

## F-WB12 · Two Vertex no-image replies (`finishReason STOP`) — and the "two trademarks" hypothesis is REFUTED by the compiled prompts. `[Mia]` `[model tier]` — **OPEN, one cell each, Adi's to fire** (wave B, deep sweep E3)

Two sentences came back with no image. Adi's read was that both name two trademarks explicitly. The
compiled prompts say otherwise — and they are what the model actually received:

    change the nike swoosh to adidas stripes
      "replace the nike swoosh with adidas swoosh. Keep everything else exactly as-is — change only
       the nike swoosh. Keep the original photograph's lighting, …"                    TWO marks ✓

    add hoops and make the jersey adidas
      "add hoops, worn in the person's ears, and replace the jersey with adidas jersey. Keep
       everything else exactly as-is — change only the jersey and the added hoops. …"  ONE mark ✗

**So the two share no trademark count.** The second names only adidas, and "make my jersey adidas"
rendered fine in the same sweep (cells 1 and 2), so naming one brand is plainly not fatal. Whatever the
common factor is, it is not the one the hypothesis names, and a fix built on that premise would have
been built on nothing.

**⚠️ AND THE FIRST PROMPT CARRIES F-WB11's VALUE DEFECT, which may be the more likely trigger of the
two:** she asked for **stripes** and the instruction says **"adidas swoosh"** — so the model is being
told to replace a swoosh with a swoosh, and one of them is the wrong brand's. That is a contradictory
instruction before it is a trademark question.

**NO CHARGE, confirmed in code.** `server/studio/adapters/vertex.ts:191` throws
`GenerationError("Vertex returned no image data (finishReason STOP)")` **before returning**, and
`recordGeneration` in `studio/router.ts` runs only on the adapter's result — its own note says
"Failures are not logged … a throw costs nothing". So nothing reached our cost log and the job billed
$0 on our books. Whether Google bills input tokens for a STOP with no candidate image is a question
only the billing console answers, and this entry does not claim it does.

**The retries are Adi's, because they spend.** One cell each, through the probe that already sends the
product's compiled prompt:

```bash
cd /Users/adi/nomila-v2-worktrees/wave-b-paths
npx tsx --require dotenv/config server/scripts/studioModelNativeProbe.ts --q 7 \
  --src-q7 <assetId|path> --q7-target "swoosh"        # dry first; the quote prints
```

**What to read if they reproduce:** whether the STOP follows the CONTRADICTION (swoosh→swoosh) rather
than the trademark count. If it does, F-WB11's value fix is also this fix. The alternative Adi proposed —
compiling the swap as "replace the existing logo with the adidas mark", naming no outgoing brand — is
worth measuring, but it should be measured against the contradiction hypothesis and not instead of it.

## F-WC1 · There is NO client QA surface: the creative-QA verdict is written to jsonb and never read by any screen. `[known behavior]` `[Mia]` — **PARKED product question (Adi, 2026-09-17)**

- **What was checked.** `grep creative_qa` over `client/` is empty. `runGenerateQa`'s call site in
  `server/studio/generate.ts:1281` says it outright: the stage "writes a verdict to
  `media_assets.metadata.creative_qa`, and RETURNS NOTHING … the return value is discarded, so no verdict can
  reach `assets`, the job row or the client". Nothing routes it, nothing shapes it, no screen renders it.
- **So the "card showed a clean pass" incident was the SERVER LOG read by grep, not a screen** (Adi, 2026-09-17).
  Wave C's copy sweep dropped its QA row on that basis: there is no card whose words could be fixed.
- **The server side is already honest, and that is the point.** `qa/verdict.ts` carries `unknownChecks` as its own
  count, never folded into `overall`, and its docstring states the contract: "a verdict reads `pass, 1 unknown`
  rather than `pass`". The dishonesty Adi saw was in READING a bare `overall` without its `unknownChecks`
  neighbour — not in what the stage recorded.
- **The parked question is a product one, not a wording one:** should a verdict reach her at all? It is on a stage
  that is flag-off by default (`STUDIO_CREATIVE_QA`), carries an identity ruler that failed its stranger control
  (`DEAD_RULER_CAVEAT`), and excludes `marks` from `overall` by design. Surfacing any of that to an athlete is a
  decision about what a check is FOR, and it is Mia's.
- **If it is ever built, the honest shape is already specified** and should not be re-derived: "passed N checks,
  couldn't verify M" — never a bare pass while `unknownChecks > 0`. That sentence was wave C's approved copy for a
  card that turned out not to exist; it is recorded here so it is not lost with the card.

## F-WC2 · A brand-attached ad carries the brand's tone but never its MARK — and the logo is deliberately filtered out of the reference list one line before it would have travelled. `[product]` `[Mia]` — **WAVE D CARD, BLOCKED ON MIA (Adi, 2026-09-18)**

- **The state today.** Card 3 gave a brand-attached ad the brand's look, tone, audience and recent
  campaigns. It carries no adidas mark, because `studio/preview.ts` (the brand-imagery block) does this:

      .filter((img) => img.role !== "logo") // a logo is not art direction

  Brand **cover and gallery** imagery already travels as `brand-imagery` in the `style` slot. The logo
  alone is excluded, and **the exclusion is correct as written**: `style` is diffuse art direction and a
  logo has to render literally.

- **So the plumbing exists; the logo is opted out of it.** `BrandImage` already has a first-class `logo`
  role (`brief.ts`), and `adapters/vertex.ts` (`toInlinePart`) already FETCHES a url reference to bytes —
  a signed https url is not accepted as `fileData`, so it fetches. Nothing new is needed to send one.
- **⚠️ `logo_url` IS A THIRD-PARTY SOURCE URL, NOT A REHOSTED BINARY.** `server/lib/brandImage.ts` says
  it outright: _"we store SOURCE URLs, not the binary … GCS-rehosting the binary is the durable upgrade
  (a third-party URL can rot, redirect, or hotlink-block)."_ It comes from Clearbit via brandResolver.
  Binding it would put a live third-party dependency inside a paid render. **Rehosting is shared-code
  work and NOT ours — Mia's** (Adi, 2026-09-18).

### Adi's decisions, 2026-09-18 — the S parts only

- Logo takes the **`object` slot**, not `style`, so it inherits the literal-render manifest line
  ("Render this exact object. Do not substitute it, restyle it or redesign it.").
- **Corner lockup ONLY.** On-garment stays `kitSwaps`' job — a second literal logo aimed at a jersey
  would fight the swap and risk two marks on one garment.
- **Pre-spend disclosure when no logo is on file**, mirroring `brandNote`'s existing sentence. **Never
  drawn from the name**: `inventedObjectNote` exists because q1-d measured that the model invents a
  DIFFERENT object with no reference, and a brand's mark invented from its name is the publicity-rights
  class of defect, not a cosmetic one.
- **Cap policy: her own Product and Object photos always win.** The logo takes a slot only if one is
  free (`caps.object` is shared and `hers` go first), and the disclosure says so when it is bumped.

### Deferred, with reasons

- **A QA logo-fidelity check is NOT built now** (Adi). It would be a real M: `qa/marks.ts` is a PAIRED
  delta — both images in ONE call, because independent enumeration produced unstable names ("sfsi" /
  "stanford 's' with tree logo" / "Stanford tree crest") — and on a generate `marks` is `unknown` by
  construction. Verifying a BOUND logo is a different comparison: output against the logo REFERENCE, not
  against the source frame. New pair, new calibration, new per-generate cost.
  **Until a live incident says otherwise the check is Adi's eye**, and `MarkProvenance` already records
  a requested mark as `source: "brand"`, so "we asked for this one" is known in code already.

### ⚠️ BLOCKED: build nothing until Mia answers question 2

Both questions go to her verbatim (Adi):

1. **Where do brand logos come from** — upload at brand-connect, or Clearbit as today?
2. **May we render a brand's mark at all, and where?** The `HEADLINE_TAGLINES` deny-list precedent —
   Mia's _"no trademarked taglines until she clears them"_ — says a brand's mark is a **cleared-rights**
   question, not an engineering one. Placing a real logo is the larger version of that.

**If Mia says no to (2), the entire card is the disclosure line.** That is why nothing is built first.

### ⚠️ COVERAGE RAN (Adi, 2026-09-18) — AND IT DECIDES THE CARD: the ceiling IS the disclosure

The headline looks fine and is misleading. **178 brands, 139 with a `logo_url` — 78.1%.** Then:

| what was asked                                | answer                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| how many logos are REHOSTED (GCS)             | **0 of 139.** 137 other third-party, 2 Clearbit                                                  |
| what kind of image the 139 are                | **106 Google favicons (unusable)**, 31 `yoku.app` logo CDN, 2 Clearbit                           |
| of `BRAND_WORDS`' **14**, how many have a row | **2** — adidas, ASICS                                                                            |
| of those 2, how many have a usable logo       | **1** — adidas (`cdn.yoku.app`, 256px PNG). ASICS' is `google.com/s2/favicons?domain=…`, 16–64px |
| any second source in `enrichment`             | **none** — `logo`, `logo_url`, `brand_assets`, `wordmark` all 0                                  |

Matched loosely on purpose (name, `normalized_name`, domain), because the first pass used exact
equality and a miss could have been "Nike, Inc." rather than an absent brand. It was not: **nike, puma,
under armour, new balance, reebok, jordan, umbro, kappa, castore, hummel, mizuno and fila have no row
at all.**

So the real usable-logo population is **at most 33 of 178 (~18%)**, not 78% — and **1 of the 14 brands
she can actually name**.

**Adi's own rule fires** (2026-09-18): _if the nameable brands mostly lack one, the ceiling is the
disclosure and the card shrinks to that._ It does. **The build is one honest sentence on the preview,
and the S parts above are parked, not scheduled.**

The same run independently re-confirms the palette finding: `enr_palette` and `enr_colors` are both 0,
matching `BrandHalf.palette`'s docstring and `brief.ts:426`.

### What this does to the two Mia questions

- **Question 1 changes character and is now the ONLY one that matters.** It was "rehost what Clearbit
  gives us, or upload at brand-connect?". It is now: **there is no logo source at all for 13 of the 14
  brands she can name, and three quarters of what we do hold are favicons.** Rehosting cannot fix an
  absent row.
- **Question 2 stops blocking.** Whether we may render a brand's mark is still worth her answer and
  still a cleared-rights question — but it gates nothing today, because for all but adidas there is
  nothing to render either way.
