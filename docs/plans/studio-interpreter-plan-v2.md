# Studio interpreter — plan v2 (APPROVED as final by Adi; built as I.1–I.8)

> **[I.8] Moved into docs/ with the interpreter PR (2026-09-14).** Approved as final before the build, with
> Adi's A1–A14 (v1, [plan v1](studio-interpreter-plan-v1.md)), Mia's M1–M7 and N1–N8. The only edits since
> approval are marked **[I.8]**: this note, the cell-3 row in §10 (tripwire wins), the appendix's pointer,
> and **§14 — As built**, which records every decision taken during the build, what was deferred, and what
> is known to remain. The state header below is as it stood at approval.

> **State.**
>
> - **I.0 is merged:** #445 → **`bccaf2b`**, a real merge commit (parents `d90efda` and `dc7a746`), with its PR body attached.
> - **Studio code on main** is identical to `dc7a746`.
> - **The v1 architecture stays approved:** A1–A14, with the canonical sentence C.
> - **This version adds** Mia's answers M1–M7, including Adi's corrections to M2 and M6, which replace every earlier reading of those two.
> - **It restructures the build:** PR M3 is new, and the text op joins the main line. Every $0 replay below ran on a read-only worktree at `bccaf2b`.
> - **No code, branch or commit** was made for this revision.

---

## 0. What changed since v1

|                                 | v1 (approved)                                      | v2                                                                                        |
| ------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| What an ad produces (M1)        | a hero image only; text deferred (I.7 conditional) | **carries text**: a short headline. DISPLAY_TEXT is a new op, and it's unconditional      |
| Competitor kit in an ad (M2)    | ask                                                | **swap the kit** to the ad's brand, listed as required by the brand, no ask               |
| Adding worn items onto her (M3) | asks (D1)                                          | **allowed**. **PR M3** is a rules change that ships first. D1 is gone                     |
| Excluding a brand's logos (M4)  | allowed if R2 passes                               | allowed by default. R2 stays as the engineering gate                                      |
| Brand from Create anything (M5) | interim                                            | confirmed: named in her sentence, or via Brand post                                       |
| Looks (M6)                      | suggested for ads                                  | **opt-in only**: a look comes only from her words. The interpreter never suggests one     |
| Named brand (M7)                | Adi's default                                      | confirmed                                                                                 |
| What preserve_person covers     | "keep you exactly as you are"                      | face, hair, body and pose. **Not clothing**                                               |
| Sequence                        | I.0 → ledger → I.1–I.8                             | **PR M3 → PR T (text) → I.1 (with the ledger) → … → I.6 → I.8**. See §11 and conflict C-1 |

---

## 1. Mia's answers

| #                         | Her answer                                                                                                                                                                                                                                                                                                                                                                          | What it changes in the build                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1**                    | **Ads carry text.** A short headline, in the shape of F-T's measured wording (q6-t1). **Still open:** whose words. Default: we suggest a short line, shown on the card as "our suggestion", and Generate approves it. **No trademarked taglines** until she clears them.                                                                                                            | The DISPLAY_TEXT op, its strict rule, a template taken from q6-t1, goldens and bounds (§5). The ad treatment suggests one headline.                                          |
| **M2** (Adi's correction) | **On competitor kit, the ad swaps the kit** to the ad's brand. No ask. It's a listed change marked as required by the brand ("adidas ads can't show Nike — we'll swap your kit"), and "Not what I meant" is her way out. `preserve_person` covers face, hair, body and pose, not clothing. The swap is an ordinary garment REPLACE, the same class as "change my jersey to adidas". | The ad gate assembles the brand-required swaps from the interpreter's `visibleMarks` (§4). Card provenance tags. QA marks provenance (conflict C-6). Cell 1a is re-expected. |
| **M3**                    | **Worn items onto her body are allowed.** D1 is dead. Body modification is never allowed.                                                                                                                                                                                                                                                                                           | **PR M3**, a rules change the interpreter inherits (§8). The never-list drops `add_onto_body`. The menu's add slot accepts worn locations.                                   |
| **M4**                    | Exclusion works **without asking**; allowed is the product default.                                                                                                                                                                                                                                                                                                                 | R2 is only the engineering gate: if the live run shows surviving Nike marks, that clause falls back to asking until it's fixed.                                              |
| **M5**                    | Interim confirmed: the brand is named in her sentence, or picked via Brand post.                                                                                                                                                                                                                                                                                                    | Nothing new.                                                                                                                                                                 |
| **M6** (Adi's refinement) | **Grades are opt-in only.** A look applies only when her words ask for one, and the interpreter **never** suggests one, with or without `preserve_person`. If she asks for a grade and says "don't change me" in the same sentence, the grade applies (she asked), and the preview keeps the line that says it covers the whole photo.                                              | Ad suggestions are background and text only. A look must be quoted from her words, and the checker enforces that (§3). The card marks it "your words".                       |
| **M7**                    | Confirmed as shipped.                                                                                                                                                                                                                                                                                                                                                               | Nothing new.                                                                                                                                                                 |

---

## 2. Where it sits (v1's architecture, unchanged)

```
her sentence S
  ├─ route(S) ── routes ──────────────────────────────▶ exactly today (interpreter never called)
  │     └─ ASK with an eligible reason · STUDIO_INTERPRETER on · native on · a frame · no drawn box
  │           ├─ ad gate ($0): an ad ask with no brand attached or named → ASK ad_needs_brand
  │           ▼
  │     interpret(S, frame probe, attachment counts, brand{name, category}) — ONE Flash call
  │           → edits (typed slots, each tagged yours|suggested|brand-required) · constraints ·
  │             spans · visibleMarks[{brand, item}]
  │           ▼
  │     checks: schema · span coverage · negation tripwire · slot vocab and bounds ·
  │             looks must be hers (M6) · fit to the cap (§4)
  │           ▼
  │     render → C  →  route(C) must reproduce the edits (round trip) + first claim — else ASK
  │           ▼
  └──── the preview continues AS IF SHE TYPED C: detection on C → brief → freeze → compile
        (+ constraints) → preview row  →  card lines rendered from the FROZEN intent
        →  Generate (accept) · "Not what I meant" (reject)
```

Unchanged from v1, and still approved:

- the spend gate, which re-routes C;
- the version 2 bump when constraints are present;
- provenance saved on the preview row;
- a pinned Flash model and a versioned prompt;
- a 15-second timeout, a 30-minute memo, and no retries;
- every failure falls back to today's ask;
- her sentence is never logged.

**v2 additions to the frozen record.** Each edit carries `source: "yours" | "suggested" | "brand"`. It lives on `BriefJob.interpretation`, for the card, QA and CD's training data, and nothing executable reads it.

---

## 3. The model call: menu changes only

The model, config, fences, output checks and failure table are as in v1. Changes to the menu:

| kind                                  | v1                                                | v2                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| look {term}                           | the interpreter could suggest one for a treatment | **only from her words.** Checker: a look edit must be `source: "yours"`, and its span's quote must contain the look's own term from rule 3's vocabulary. Otherwise the reply is rejected and it asks. |
| text {content}                        | —                                                 | **new (M1):** `source` is "yours" when her quote contains the words, otherwise "suggested". Bounded by the rule's own text bounds (§5).                                                               |
| add {thing, prep, place}              | the place couldn't name her                       | **M3:** the place may name her when the thing is worn and the location is in that thing's class (the same predicate as PR M3's rule, imported).                                                       |
| brand_swap {item, descriptors, brand} | her words only                                    | **M2:** also `source: "brand"`, assembled deterministically from `visibleMarks` (§4), never chosen freely by the model.                                                                               |
| `visibleMarks`                        | [brand]                                           | **[{brand, item}]:** brands from the BRANDS enum, items from a closed garment and footwear list. It's perception only; the ad gate decides.                                                           |
| body-modification words               | caught by the person guard via round trip         | **also rejected in any slot** (PR M3's BODY_MODS list), so the ask gets the person line.                                                                                                              |

Eligibility (A4) after PR M3:

- **Never-list:** `person_target`, `person_mentioned`, `object_photo_missing`, `too_many_changes`, `compound_conflict`, `generate_not_permitted`, `low_confidence*`, `no_steps`. `add_onto_body` is gone: after M3 no sentence asks with it.
- **Eligible:** unchanged. `fast_path_declined`, `compound_partial`, `conditional`, `brand_change`, `brand_removal`, `add_unclear`.

---

## 4. The ad treatment v2

**The ad gate ($0, before the interpreter).** Unchanged from v1 plus M7.

- **When it fires:** the preservation span is set aside, and what remains asks for an ad, advert, advertisement, campaign (shot/image) or commercial.
- **Whose brand:** the attached brand, OR one brand named in her sentence, resolved by name. With no brand anywhere, it asks `ad_needs_brand`. An attached brand that differs from the named one, or two named brands, ask `ad_brand_mismatch`.

**What the proposal is built from.** The interpreter reads her words and reports `visibleMarks`. Code assembles the treatment in a fixed order:

| order | what                                                                                                                                            | source tag        | card wording                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------- |
| 1     | her own changes, from her words, including a look **only** if she named one (M6)                                                                | yours             | "Make it warmer · your words"                                                     |
| 2     | **the kit swap (M2).** One `brand_swap{item, [], adBrand}` for each item of hers carrying a visible mark of a competing brand (competitor = N1) | brand             | "Swap your jersey, socks and cleats for adidas ones — adidas ads can't show Nike" |
| 3     | **one headline (M1)**, suggested unless her words give it                                                                                       | suggested / yours | 'Add the headline "OWN THE MOMENT" across the top · our suggestion'               |
| 4     | **one background**, suggested                                                                                                                   | suggested         | "Change the background to a stadium at night · our suggestion"                    |
| —     | `preserve_person` (always on for an ad)                                                                                                         | constraint        | "Keep your face, hair, body and pose as they are"                                 |
| —     | `exclude_marks{competitor}` when competitor marks are visible outside her kit, and **only if R2 passed**                                        | constraint        | "No Nike logos anywhere in the photo"                                             |

**Fitting within the four-change cap (conflict C-2):**

- Priority, highest first: her words, then brand-required swaps, then the headline, then the background.
- Suggestions drop, lowest priority first, until the total is ≤ `MAX_STEPS` (4).
- If her words plus the required swaps already exceed 4, it asks (`too_many_changes`, with copy that fits an ad).
- **How many swaps an item list costs depends on grouping (N3):**
  - Per item on the Q1 frame (jersey, socks, cleats) = 3 swaps + the headline = 4, so the background suggestion drops.
  - One "kit" swap plus the cleats = 2, so both the background and the headline fit.

**Canonical C for cell 1a** (Q1 frame, adidas, per-item swaps):

- **Sentence:** `change my jersey to an adidas jersey, change my socks to adidas socks, change my cleats to adidas cleats, and add the headline "OWN THE MOMENT" across the top`.
- **How it routes:** the first three clauses route today, as rule 4c's canonical shape. The fourth routes once PR T's rule exists.
- **What's frozen alongside it:** `preserve_person` rides as a constraint.
- **How it compiles:**
  - the three REPLACE clauses;
  - the banner clause (q6-t1's wording);
  - the scope sentence;
  - the preservation clause;
  - "Keep the person's face, hair, body and pose exactly as they are";
  - the brand's DO NOTs.

**Why `preserve_person` doesn't block the swap.**

- It covers face, hair, body and pose only.
- The swap is a garment REPLACE, and the person guard never reads garments as her.
- The card line for `preserve_person` changes from "Keep you exactly as you are" to "Keep your face, hair, body and pose as they are". The v1 wording would contradict the swap line on the same card (conflict C-4).

**Scope of M2:**

- It applies only inside the ad treatment. A brand attached to a non-ad edit never swaps anything.
- The swap targets worn garments and footwear. Other competitor marks (a ball, a bag, signage) aren't swapped:
  - signage in the background goes when the background suggestion runs;
  - the rest are covered by `exclude_marks` when R2 has passed, or listed on the card otherwise (conflict C-7).

---

## 5. DISPLAY_TEXT — the text op (M1)

This is the new, ninth operation, and it's reachable only as a native edit.

**The rule — "rule 3¾": strict, deterministic, placed after rule 3½ and before rule 4.** It has to sit before rule 4 because DESIGN contains "text", and rule 4 would otherwise claim the sentence.

- **Shape:** `[please] add|put the headline|the text|the words "<TEXT>" across the top`, with straight or curly quotes and nothing left over.
- **Parsing:** from the raw string. The tokenizer drops quotes and digits.
- **Why so strict:** it stays strict on purpose, so #433's natural-language banner sentences keep asking (their pins don't flip) and reach the interpreter, which renders this exact shape.
- **One placement in v1:** the top banner, the one text-only shape that was measured (q6-t1). q6-t2's corner-plus-logo shape isn't included: it drew a trefoil where q3-b had drawn the three-bar mark, and Mia flagged that inconsistency for recalibration.

**Bounds, enforced by the rule itself so her typed text and the interpreter's C face the same guard:**

- 1 to 4 words and at most 24 characters, uppercased;
- characters `[A-Z0-9 !?&'.-]` only;
- no BRANDS word in v1: a brand's name as display text is a mark;
- no tagline from a closed deny-list (M1: "no trademarked taglines until cleared"). The starter list covers the BRANDS vocabulary: "just do it", "impossible is nothing", "i will what i want", "forever faster", …;
- two DISPLAY_TEXT steps give `compound_conflict`: one headline per image.

**The rest of the plumbing:**

- `ROUTE: FULL_IMAGE`, and it's in `REGION_FREE_OPS`, so no detection runs.
- The freeze writes `{op, target: null, change: TEXT}`.
- `changeIsWellFormed` requires no target and a text value.
- **Across a deploy:** an old instance doesn't know the op, so `readNativeIntent` returns "invalid" and the job refuses. Deploy skew fails closed automatically.
- **Compile order** (SCENE_RANK): changes to things, then the background, then text, then a look. The banner joins the new background, and a look of hers grades it too.
- **Template, q6-t1 verbatim:** `add a large banner across the top of the background that reads ${TEXT} in bold white capital letters`.
- **Scope sentence:** "…only add the banner", or combined: "change only the jersey, the background and the added banner".
- **Preservation:** text waives nothing.
- **Card line:** `Add the headline "GET LOUD" across the top`, tagged our suggestion or your words.
- **Flag:** the rule is pure (no flag in `route()`). The freeze blocks DISPLAY_TEXT unless `STUDIO_DISPLAY_TEXT` is on (**N4**; default off), the same fail-closed pattern as `native_edit_off`. Copy: "Text on photos isn't available yet."
- **Goldens:**
  - text alone;
  - text plus a background;
  - text plus a kit swap (the cell-1a shape);
  - text plus her own look;
  - a refusal fixture for two headlines.
- **What's unmeasured:**
  - spelling from run to run;
  - text over a changed background;
  - text inside a four-change call. F-C's four-change cell had no text.

  Cell 1a measures these at n=1. There's no QA spelling check (conflict C-8).

---

## 6. Sentence (4), clause by clause (as v1, now with M4)

C = "change my uniform to a black adidas uniform, and change my cleats to pink adidas cleats", plus `exclude_marks{nike}`.

- **M4:** the exclusion applies without asking.
- **R2 is the gate:** if Nike marks survive in the live run, only that clause falls back to asking.
- **Why exclusion, not removal:** F-R records that removing a small swoosh gets silently skipped or hard-fails, while replacement works.
- **Card:**
  - Swap your uniform for a black adidas uniform · your words
  - Swap your cleats for pink adidas cleats · your words
  - No Nike logos anywhere in the photo · your words

---

## 7. Preservation, v2

- **What `preserve_person` covers:** face, hair, body and pose, **never clothing**. That's M2's resolution. Its compiled clause is unchanged from v1 ("Keep the person's face, hair, body and pose exactly as they are"). Its card line changes to "Keep your face, hair, body and pose as they are".
- **Her grade plus "don't change me" (M6):** the grade applies, and the preview carries a degraded note: "This look covers the whole photo, you included."
- **Her worn add plus "don't change me" (M3):** allowed. A worn item isn't a change to her face, hair, body or pose.
  - **Edge (C-5):** eyewear covers part of the face. QA's identity score may flag it; QA is logging-only.
- **Sentences that route today** still don't have their preservation words removed (A3b follow-up, unchanged).

---

## 8. PR M3 — worn items onto her body (the rules change; ships first)

**Scope (Mia's M3, Adi's brief).** The add path accepts a worn item with a location on her body. It reuses #405's worn-items list and its location-consumption reading, and body modification never routes.

**What recon found at `bccaf2b`** ($0 replays):

- **Every worn-onto-her add asks today**, under one of three codes:
  - `add_onto_body` for jewelry and bands, e.g. "add these gold hoops to my ears", "put a watch on my wrist", "add a nike headband to my head";
  - `person_target` for hats, caps, helmets and sunglasses, e.g. "add a hat on her head". One of them is also branded, "put an adidas cap on my head": rule 4a reads it as APPLY_DESIGN on her head;
  - `person_mentioned` for "can you add these earrings to my ears", where "can you" defeats the verb-leads check.
- **Piercings would leak.** "add a ring to my nose" and "put a stud in my nose" already count as worn-onto-her. A naive M3 would route nose piercings.
- **Body modifications ask, but not always with the person line.**
  - With a place they get the person ask: "add a tattoo on my arm", "add muscles to my arms", "add a scar to my face".
  - Without a place, "add a tattoo", "add muscles", "add abs" and "add a scar" ask `add_unclear`, whose copy invites her to name a place. "give me abs" asks `fast_path_declined`.
- **Detection: nothing to extend** (verified by reading the code, pinned in the build). A routed add is region-free, so the preview skips detection. A composed one sends detection only its region-bearing clauses. Detection's person rule never sees her ears. Widening WORN_ITEMS does extend `namesAWornThing` to headwear and eyewear targets on recolor and replace sentences, as intended.

**The changes:**

1. **WORN_ITEMS gains** hat(s), cap(s), beanie(s), visor(s), helmet(s), bandana(s), sunglasses, glasses, eyeglasses and goggles. **Not** crown, tiara, mask or "shades", which are costume items or ambiguous words (**N6**).
   - The list also drives decision 2's location reading everywhere. So "change the hat on my head to red" and "change the sunglasses on my face to black" move from ask to route: a recolor of the hat or glasses, her head and face consumed as the location. That's in scope.
2. **Rule 3¾b, "a worn thing, added onto her"**, placed after rule ½ (so it runs per clause) and before rule 4 (so a branded worn item isn't read as a design on her).
   - **Shape:** `[please|can you|could you|would you] add|put|place|stick <worn thing, colours and one brand allowed> [from the second image] <onto-her preposition> <her>`, with nothing left over.
   - **Her location:** either a lone pronoun ("on me") or a phrase whose head is **in the thing's own location class** (**N5**):

     | worn class                                    | allowed locations  |
     | --------------------------------------------- | ------------------ |
     | earrings, hoops, studs                        | ears               |
     | necklace, pendant, choker, chain              | neck               |
     | watch, bracelet, bangle, wristband, sweatband | wrist(s), arm(s)   |
     | ring(s)                                       | finger(s), hand(s) |
     | anklet                                        | ankle(s)           |
     | glove(s)                                      | hand(s)            |
     | headband, hairband, hair tie, scrunchie       | head, hair         |
     | hat, cap, beanie, visor, helmet, bandana      | head               |
     | sunglasses, glasses, goggles                  | face, eyes, head   |

     A location outside its class isn't this rule's. A ring or stud in her nose, or earrings on her lips, fall to rule 4½, where the surface names her, so they get the person ask. The piercing class stays out.

   - **Output:** `ADD_OBJECT`. `targets: [thing]` only, because the location is consumed and isn't a surface. `value`: her place. The person guard reads the thing, so it routes. Everything else follows existing C′/#444 semantics: her Object photo becomes its `objectAssetId`, two photos give `ambiguous_object`, no photo gives the invented-object note.

3. **rule ¼'s `addsWornOntoHer → return null` is removed.** `add_onto_body` is no longer produced: its `declineReason` arm, its ASK_NOTES entry and the client `askCopyFor` entry are deleted. G.3's "a call we haven't made yet" copy goes with them.
4. **Placeless body modifications get the person line** (ask → better ask). A closed BODY_MODS list: tattoo(s), scar(s), muscle(s), abs, six pack, freckles, piercing(s), wrinkles, mole(s), birthmark(s). An add/put/give sentence whose thing is on it asks `person_mentioned` instead of `add_unclear` or `fast_path_declined`.
5. **Compile: wording for a worn add.** When the frozen place's head is a body location, the ADD template reads `add the gold hoops from Image 2, worn in the person's ears`. Without a photo: `add gold hoops, worn in the person's ears`.
   - The preposition comes from the location: ears → in; neck → around; wrist, arm, finger, hand, ankle, head, hair, face and eyes → on. Her own "to" never ends up as "place it to the person's ears".
   - This adds no frozen field. An old instance compiles the existing spatial wording, which is still coherent.
   - The wording is unmeasured; M3's acceptance cell measures it.

**Pins that flip — the old D1 hat pin and G.3, listed by name in the PR with their before/after:**

- **`classify.test.ts`:**
  - the D1 asks-when-it-lands-on-her test;
  - the D1 spatial-side list;
  - `reasonFor("add a hat on her head")`;
  - the composed hat-and-socks sentence;
  - two "must stay ASK" invariant lists;
  - decision 2's "not on the list, on purpose" hat;
  - the G.3 block: its "does not touch an add onto her" and "asks every add of a worn thing … as add_onto_body" tests flip. In "keeps the person line for a tattoo, hat, crown, muscles", the hat flips and the others stay.
- **`nativeIntent.test.ts`:** the `add_onto_body` note, and the hat freeze, region-free, composed and brief-input pins.
- **`objectVocab.test.ts`:** the word-for-word WORN_ITEMS list and "headwear is D1's".
- **`client/lib/studio-contract.test.ts`:** the `add_onto_body` copy pins.

**Proof obligations:**

- **`route()` corpus diff** (`bccaf2b` against the branch; corpus × photo × 0/1 Object photos). Only these rows are allowed:
  - (a) worn-onto-her adds, ASK → ADD_OBJECT route;
  - (b) decision-2 location sentences newly covered by headwear or eyewear, ASK → route;
  - (c) ASK → ASK for body-mod copy only.
  - **Zero route → route and zero route → ask.**
- **Body-mod invariant:** a body-mod list (tattoo, muscles, abs, scar, freckles, nose ring or stud, piercing, crown, "make my arms bigger", …) × photo × 0/1 photos asks in every row, with the person line where it names a place.
- **Compile diff:** only the moved sentences differ. Every existing ADD prompt is byte-identical, because the worn wording fires only for body locations, and those never routed before.
- **Goldens:** the existing 42 stay byte-identical. New fixtures:
  - a worn add with her photo;
  - a worn add without a photo (the invented note);
  - a worn add composed with a recolor;
  - a branded worn add ("put an adidas cap on my head");
  - eyewear.
- **Live-path pin** through the real preview route, with genai and the probe mocked, on "add these gold hoops to my ears" plus her photo:
  - returns 200 and a ready preview;
  - freezes `ADD_OBJECT [gold hoops]` with her photo;
  - **detection is called 0 times**;
  - the compiled prompt equals its golden.
- **Revert checks, each with a predicted red count:**
  - the rule off;
  - the location map off (the nose ring must go red);
  - the politeness prefix off;
  - WORN_ITEMS without headwear;
  - the body-mod copy off;
  - the worn wording off.
- **Scoped suite:** `bccaf2b` is the baseline (53 / 1,778 / 0 expected). Every test on main must be present by name, apart from the flipped pins, which are rewritten and documented.
- **Gates:** the usual 7-point review pass.

**Acceptance (Adi drives, about $0.30):**

- **Paid:** "add these gold hoops to my ears" with the hoops photo, on a frame with no earrings. She should get **her** hoops (the reference reproduced), on her ears, with her face held (QA identity). That's n=2 at 2K, $0.1344 billed each. This is founder sentence 3, now a routed cell.
- **Free, preview only** (an add costs no detection):
  - "add a tattoo on my arm" gets the person ask;
  - "add muscles" gets the person line;
  - "put a hat on my head" routes, and the preview is ready.

**Size: M.** It touches `classify.ts` (rule, vocabulary, copy), `objectVocab.ts`, one compile template variant, `nativeIntent.ts` (notes), client copy, about 20 flipped pins, new pins, and one route test.

---

## 9. Scope fence (v2)

**In this plan, beyond v1:**

- text-bearing ads, as PR T plus the interpreter's headline suggestion;
- kit swaps inside ads;
- worn adds, as PR M3, inherited by the interpreter;
- looks from her words only.

**Still out:**

- style vocabulary (the next PR; the look slot's interface is unchanged);
- session memory;
- CD quality templates;
- q6-t2's corner or logo text;
- a brand logo rendered in the ad;
- a QA spelling check (follow-up);
- non-garment competitor objects beyond `exclude_marks`;
- GENERATE claims such as "make an ad out of this" (A14);
- drawn boxes, and the flag-off native arm;
- a brand picker on Create anything;
- A3b;
- a `studio_interpretations` table;
- anything outside Studio.

---

## 10. Proof plan (v2 deltas; v1's obligations all stand)

**Interpreter corpus diffs:** as in v1 (route() diff 0 rows; the preview-decision diff moves only asks). They are rebased onto main after PR M3 and PR T.

**New adversarial replies,** each of which must ask:

- a look tagged `suggested`;
- a look whose quote doesn't contain the look's term;
- a brand swap the model invented with no matching `visibleMarks` entry;
- a text over the bounds;
- a tagline on the deny-list;
- a BRANDS word inside the text;
- a worn add at a location outside its class;
- a BODY_MODS thing;
- more than 4 changes after the cap-fitting;
- required swaps alone over 4.

**QA provenance (conflict C-6):** in I.5, QA's marks record carries `requestedBy` for each mark: her, suggested, or brand. The disappearance of the swapped-out brand's marks counts as requested when the edit swapped the item carrying them. A pin checks this on a fixture verdict.

**Acceptance, re-expected** (after I.6; Adi drives; the server must first be proven to run the branch head):

| cell                                                                                   | setup                                                           | expected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | spend             |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **1a** "turn this into an adidas ad. dont change anything about me"                    | Q1 frame (Nike jersey, socks, cleats), adidas attached or named | **The card:**<ul><li>the kit swap, tagged required by the brand;</li><li>a headline, tagged our suggestion;</li><li>the background suggestion only if it fits the cap (N3);</li><li>"Keep your face, hair, body and pose as they are";</li><li>no look.</li></ul>**The output:**<ul><li>her kit is adidas;</li><li>the headline is legible and spelled right;</li><li>face, hair, body and pose are held;</li><li>QA marks show the adidas arrivals and Nike removals as requested-by-treatment (brand).</li></ul>                                                                                                                                                                                                                                                      | ~$0.003 + $0.1344 |
| **1b** the same sentence, no brand anywhere                                            | Create anything                                                 | `ad_needs_brand`; no interpreter call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | $0                |
| **1c** "turn this into an adidas ad. dont change anything about me", no brand attached | Create anything                                                 | Adidas is resolved from her words; the same card as 1a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | ~$0.003 (preview) |
| **2** the earrings regression                                                          | with her photo                                                  | routes by rule, no interpreter event, and the prompt equals its golden                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | $0                |
| **3** the earrings add                                                                 | the hoops photo, a frame with no earrings                       | **Routes after PR M3.** The rules phrasings were already accepted in M3's own cell. **[I.8] The primary interpreter phrasing, "give me these gold hoops", renders to C "add these gold hoops to my ears", which routes.** Card: "Add the gold hoops from your photo, worn in your ears". **[I.8] "i dont have earrings in this one, add these gold hoops" ASKS, honestly — a tripwire-wins decision (Adi, 2026-09-14):** its "dont" is "I don't have", but the negation tripwire cannot tell that from "don't change", and a reading that let it through would open the class where preservation language is misread as an edit. Mia's actual wording is pending; if her real sentence trips the same check, it is revisited with her sentence as the spec, not before. | ~$0.01 (previews) |
| **4** the uniform sentence                                                             | Q1 frame                                                        | The three lines from §6. The exclusion stands only if R2 passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ~$0.003 + $0.1344 |

---

## 11. Build sequence v2

| #   | unit                                           | size | what it holds                                                                                                                                                                             | then stops for Adi                                                                         |
| --- | ---------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | **PR M3** — worn items onto her                | M    | §8                                                                                                                                                                                        | push, merge, acceptance (~$0.30)                                                           |
| 2   | **PR T** — DISPLAY_TEXT (was I.7)              | M    | the op, the strict rule, the q6-t1 template, bounds and deny-list, the `STUDIO_DISPLAY_TEXT` flag (off), goldens; its own route and compile diffs (**C-1, N4**)                           | push, merge. $0 with the flag off; an optional text-alone paid cell (~$0.13)               |
| 3   | **I.1** compile                                | S/M  | constraints (`preserve_person` narrowed, `exclude_marks`), version 2, describe lines with provenance tags, goldens, **plus the A13 ledger entries F-C and F-R** (Adi's confirmed wording) | —                                                                                          |
| 4   | **I.2** interpret core, pure                   | L    | the menu (text, worn locations, looks-must-be-hers, `visibleMarks` items), validation, render, round trip, first claim, **cap-fitting**, adversarial fixtures                             | —                                                                                          |
| 5   | **I.3** transport, prompt, memo, record script | M    | —                                                                                                                                                                                         | **R1** (~$0.15, recorded replies) and **R2** (~$0.27, the exclusion gate). Adi verdicts R2 |
| 6   | **I.4** eligibility and the ad gate            | M    | M7 resolution, **M2 swap assembly**, cap-fitting, headline suggestion, M6 enforcement, copy                                                                                               | —                                                                                          |
| 7   | **I.5** route wiring                           | M/L  | the preview hook, `interpretable`, the reject endpoint, the flag, **QA marks provenance (C-6)**, PGlite route tests                                                                       | —                                                                                          |
| 8   | **I.6** client                                 | M    | the card with its provenance tags, "Not what I meant", copy; the iOS Simulator and phone-width Chrome                                                                                     | —                                                                                          |
| 9   | **I.8** docs                                   | S    | the addendum to the "no LLM stage" note; ledger cross-references                                                                                                                          | **Interpreter acceptance** (§10, ~$0.40)                                                   |

**Spend:**

- PR M3's acceptance, about $0.30, is on its own.
- The interpreter's recon plus acceptance is about $0.85, under the $1.25 cap.
- If `STUDIO_CREATIVE_QA` is on, add about $0.02 per generation.

**What Adi decides at each stop:**

1. M3 merge and acceptance.
2. PR T merge.
3. R2's verdict (whether the exclusion stays) and the R1 fixtures.
4. Pushing the interpreter PR.
5. The final acceptance.

**Interpreter PR structure:** I.1–I.6 and I.8 ship as one merge-commit PR, as v1 planned, rebased onto main after M3 and T.

---

## 12. Conflicts, named, not bent

**C-1 · I.7 ("main line") contains a rules change.**

- DISPLAY_TEXT adds a deterministic rule, and typed strict-shape sentences start routing (ask → route). By the same constraint-B reasoning that makes M3 its own PR, it should ship separately, before the interpreter's ad gate uses it.
- **Recommend:** PR T, right after M3. The interpreter's headline suggestion stays in I.4. **N4.**

**C-2 · The four-change cap versus an ad.**

- A swap on a competitor frame (1–3 items), a headline and a background can pass 4, and any change of her own makes it worse.
- **Resolution:** fit to the cap with a fixed priority (§4). If her words plus the required swaps pass 4, it asks.
- Grouping the kit (N3) decides whether the background suggestion survives on the Q1 frame.

**C-3 · The swap depends on perception.**

- Which items carry a competitor's mark comes from Flash reading the photo (`visibleMarks`).
- **A missed mark:** that item isn't swapped. The backstops are `exclude_marks` (only if R2 passed) and QA marks (logging-only).
- **A false one:** an unneeded swap is proposed. She sees it and can reject it.
- The swap trigger must not depend on the brand's DO NOT. A brand's `competitors` list is often empty, and a brand resolved by name may have none.

**C-4 · Her literal words versus M2.**

- "dont change **anything** about me" literally includes her clothes. M2 resolves it: `preserve_person` means face, hair, body and pose, and the swap is visible, has its reason on it, and can be refused.
- The v1 card line "Keep you exactly as you are" **must change**, or the card contradicts itself. v2 changes it (§7).

**C-5 · Eyewear versus face preservation and QA identity.**

- Sunglasses cover part of the face, and QA's identity score may flag the output. That's logging-only, so there's no block.
- **Recommend:** allowed, per M3 (eyewear joins the list).

**C-6 · Cell 1a's QA expectation isn't in the code today.**

- **How QA reads marks now:** `wasRequested` is binary and reads the instruction string.
- **What cell 1a would show without a fix (with A9, QA reads C):**
  - adidas arrivals: requested;
  - the Nike marks leaving: flagged as "vanished";
  - a school mark the replacement redraws: "altered", which is a fail;
  - nothing records "requested-by-treatment".
- **Resolution:** QA provenance in I.5 (N7). The redrawn school mark needs M-N2.

**C-7 · Competitor marks on things that aren't garments** (a ball, a bag, signage).

- v1 swaps worn garments and footwear only. Signage goes when the background suggestion runs. Anything else is covered by `exclude_marks` if R2 passed, or listed on the card if not.
- **Recommend:** this default.

**C-8 · Model-written text is rendered into her image.**

- The suggested headline is the one place model-written words reach the output directly.
- **Bounds live in the rule** (§5), and the card marks the line "our suggestion".
- **Unmeasured:** spelling from run to run, text inside four-change calls. Cell 1a covers these at n=1, and no QA spelling check exists yet.

**C-9 · WORN_ITEMS relaxes a guard in two places.**

- Adding headwear and eyewear widens decision 2's location reading for every rule, and detection's worn-thing exemption. The route diff will show those sentences move from ask to route. They're consistent with M3, but they reach past adds.

**C-10 · `add_onto_body` leaves the protocol.**

- A client that predates M3, talking to a new server, never receives the code. A new client talking to an old server mid-deploy shows the default copy for it. That's harmless.
- The never-list entry and the G.3 copy are removed in PR M3.

---

## 13. Decisions needed (new)

**Adi:**

| #      | decision                                                                                                                                                        | recommendation                                                                                                                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **N1** | Who counts as a competitor for M2 swaps                                                                                                                         | Any brand in the BRANDS vocabulary other than the ad's brand, plus the brand's listed competitors when they exist                                                                                                                                      |
| **N3** | Swap granularity                                                                                                                                                | **Per item** (jersey, shorts, socks, cleats are separate REPLACEs). It's more precise, and the background suggestion drops when the cap needs it. The alternative is one "kit" REPLACE plus footwear, where it's unmeasured whether "kit" covers socks |
| **N4** | DISPLAY_TEXT as its own PR T before I.1, with its own `STUDIO_DISPLAY_TEXT` flag (default off)                                                                  | Yes (C-1)                                                                                                                                                                                                                                              |
| **N5** | M3's location classes: worn items only in their natural places; placements that imply a piercing (nose, lip, eyebrow, navel) keep the person ask                | Yes. Mia may want to see it                                                                                                                                                                                                                            |
| **N6** | M3's list additions: hat(s), cap(s), beanie(s), visor(s), helmet(s), bandana(s), sunglasses, glasses, eyeglasses, goggles; **not** crown, tiara, mask or shades | Yes                                                                                                                                                                                                                                                    |
| **N7** | QA marks provenance (`requestedBy`; swapped-away marks count as requested) in I.5, so cell 1a can be judged as Mia expects                                      | Yes                                                                                                                                                                                                                                                    |
| **N8** | Display-text bounds in v1: no BRANDS words, and a starter tagline deny-list                                                                                     | Yes                                                                                                                                                                                                                                                    |

**Mia** (new; Adi decides whether it goes on her page):

| #        | question                                                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M-N2** | School and team marks on a swapped kit in a brand ad. Keep them (the replacement may redraw them; QA flags that as "altered"), or deliberately remove them? NIL rules often restrict school marks in commercial content. Default: left alone, not deliberately removed. |

**Still open from M1:** whose words go in the headline. Default: our suggestion, which she approves by generating.

---

## Appendix — A13 ledger entries (Adi's confirmed wording; commit with I.1)

**[I.8]** Committed with I.1, in [docs/probes/sweep-4-ledger.md](../probes/sweep-4-ledger.md) (F-C, F-R).

**F-C** — CLEAN, four changes in one call, n=2.

- **Sentence:** "make her jersey blue, make her socks red, add a soccer ball at her feet, and change the background to a stadium".
- **Operations:** RECOLOR, RECOLOR, ADD and BACKGROUND.
- **Result:** all four landed in both runs, and STANFORD and the 8 were re-rendered legibly.
- **Verdict:** Adi's, live, at about 01:00 on Sept 11.

**F-R** — FAILED, tiny-target removal.

- **In a compound run:** the small Nike swoosh was silently skipped.
- **Solo:** it hard-failed. That's the log lines at 01:06:50–01:06:54 (preview `2565aaa7…`, job `a9485125…`): "Vertex returned no image data".
- **Contrast:** removal on a frame with a larger logo worked, and replacement at the same small size worked.

---

## 14. As built [I.8]

The PR is I.1–I.6 and I.8 as one merge-commit PR on `studio/interpreter`, one commit per unit, off main
`7bbe608` (#461, with #445 and #456). I.7 shipped before it as PR T (§11, C-1, N4).

### 14.1 Decisions taken during the build

Named against main at the start of the build; Adi's calls at the I.3 stop (2026-09-14), all defaults approved:

- **The headline lives behind T's switch, inside `route()`.** The menu offers a headline only with
  `STUDIO_DISPLAY_TEXT` on, read from the same switch (`interpreterMenu`), so the menu and the classifier
  cannot disagree.
- **A4, re-confirmed against main** (`server/studio/interpret/eligibility.ts`, a `Record` over every ask code
  so a new code does not build without a decision). Interpret: v1's six plus `worn_add_unclear` (M3 deferred
  it here). Never: v1's list plus `headline_bounds` (her words broke the bounds; only other words fix it).
  `add_onto_body` is gone since M3; `text_off_native` is a freeze refusal, not an ask code.
- **`ad_too_many_changes`** is its own code, so an ad's too-many says the kit swap is part of the count.
- **The Gatorade class fails closed.** An attached brand whose name carries no BRANDS word cannot be swapped
  to; an ad over competitor kit asks her own ask. See 14.3.
- **The memo key** carries the menu's switches, and (I.4) the brand's category, which is in the prompt.
- **"Not what I meant" also blocks the preview**, so the reading she refused is never one tap from running.
- **Cell 3's second phrasing asks** — the tripwire wins (§10, cell 3).
- **The her-words check.** Every slot of an edit tagged "yours" must be words of her quote, except a worn
  thing at its natural place (M3's `wornGoesOn`). Keeps about "else" and "the rest" read as `preserve_person`.

During recon:

- **R1's first call failed 400 on Vertex.** Diagnosed by diffing against the calls that work: the wire now
  sends no `responseJsonSchema` and `thinkingBudget: 0` (interpret/2). The strict parser is the guard. A
  named-field preflight in the R1 script names the next mismatch instead of a bare 400.
- **R1's review → interpret/3.** No brand's slogan in a suggested headline (a prompt rule, plus six Nike /
  Puma / Under Armour siblings on the deny-list — a named rules tightening: with `STUDIO_DISPLAY_TEXT` on,
  exactly those six headlines move route → ask); a worn thing keeps only colour words and at most one brand;
  an edit span holds its verb; "but" is filler. The R1 script sets and asserts `STUDIO_DISPLAY_TEXT` to match
  the menu it records under.
- **R2** (`r2-combined`, n=2, Adi's verdicts): the exclusion is CLEAN (ledger F-E), so
  `EXCLUSION_CLEARED = true` — a code constant, because it records a measurement. Spelling is CLEAN and the
  headline's presentation varies (F-T2, for Mia); the text switch is cleared to ship enabled, as an env
  flip, never a code default.

In the build, stated:

- **The exclusion is the kit's backstop too — a departure from §4.** `exclude_marks{brand}` rides for every
  competitor the model saw anywhere, tagged "brand", not only for marks outside her kit. R1 missed the
  socks' mark in 7 of 10 ad replies: the swap names the items the model saw, the exclusion names the brands
  wherever they are (C-3).
- **"Named" is literal.** Every BRANDS word in her sentence counts toward the ad's brand, so a second brand
  named for another reason asks `ad_brand_mismatch` (14.3).
- **A named brand with no row** proceeds on the name alone, and the preview says no guidelines were applied
  (v1 §3's default).
- **The interpreter defaults to the ad's plan**, so no caller can leave a competitor's kit in an ad by
  forgetting to pass it.

### 14.2 Deferred — not in this PR

- **A3b** — preservation words leaking into rule 2's value and targets on sentences that already route. A
  follow-up with its own route diff.
- **Worn-item descriptors** beyond colour and one brand ("small", "tiny", "trucker"). interpret/3 leaves
  them out of the worn thing, so "add small gold hoops to my ears" is proposed as "add gold hoops…", and the
  card shows it. Reading them is a rules change to rule 3¾b.
- **`InterpretationInput.prior`** — reserved for prior turns, once Studio has threads. Nothing but her
  sentence, the frame, the attachment count and the brand's name and category is sent today (v1 §1).
- **F-I3** (rule 2's article eats a setting's first letters) — a real fix-PR candidate once this lands; it
  mangles routed sentences on main today. **F-I4** (a quoted headline beside a place routes as an ADD).

### 14.3 Known remaining

- **The model is not deterministic at temperature 0** (ledger F-I5). Two interpret/3 runs moved 4 of R1's 42
  outcomes and 9 of its 42 C sentences, always between answers the checks allow. The memo holds one reading
  per athlete, frame and sentence for 30 minutes; after that, a re-check can read her differently.
- **A refused suggestion costs the whole reply — FIXED in the wave-3 fixes.** Puma's "FOREVER FASTER" came back in
  every run despite the prompt rule; the deny-list refuses it. It is now dropped alone and the ad proposes
  without it (ledger F-I5).
- **Off-list ad brands (the Gatorade class)** ask on a frame with competitor kit. The right eventual answer
  for a non-apparel brand's ad is probably a background and a headline with no kit swap — a Mia question,
  in M-N2's neighbourhood. Not built.
- **"turn this into an adidas ad and remove the nike logo"** asks `ad_brand_mismatch`.
- **Perception misses.** An item whose mark the model does not report is not swapped. The exclusion covers
  the brand; QA marks (logging-only) flag a surviving competitor as a conflict.
- **Headline presentation** varies run to run (F-T2) — overlay or in-scene banner, Mia's call.
- **School marks on a swapped kit** (M-N2): QA marks call a redrawn crest "altered".
- **The ad gate reads any AD_WORDS ask as an ad.** Over the test corpus, 104 rows that asked on main ask
  `ad_needs_brand` or `ad_brand_mismatch` instead — mostly test titles ("an ad that cannot be assembled
  asks"). An ask either way.
- **Copy** for `ad_brand_mismatch` and `ad_too_many_changes` is placeholder, for Mia.
- **On device:** the card is verified in the iOS Simulator and phone-width Chrome at acceptance, on the
  branch's server and Metro.

### 14.4 Where it lives

- `server/studio/interpret/` — `menu`, `reply`, `canonical`, `core` (pure); `prompt`, `transport`,
  `interpret`, `recorded`, `preflight` (the call); `eligibility`, `ad`, `brandName` (I.4); `forPreview`,
  `markProvenance` (I.5).
- `server/studio/compile/constraints.ts`, `describe.ts`; `server/studio/nativeEdit.ts` (version 2);
  `server/routes/studio.ts` (the preview hook, `interpretable`, the reject endpoint); `server/studio/qa/marks.ts`
  (N7 provenance); `client/screens/studio/MakeItScreen.tsx` (the card).
- Flags: `STUDIO_INTERPRETER` and `EXPO_PUBLIC_STUDIO_INTERPRETER`, both off. The server's needs
  `STUDIO_NATIVE_EDIT`; the client's needs `EXPO_PUBLIC_STUDIO_SERVER_ROUTING`; headline suggestions need
  `STUDIO_DISPLAY_TEXT`.
- Scripts, dry by default: `server/scripts/studioInterpreterRecord.ts` (R1), `studioInterpreterR2.ts` (R2).
  R1's recording is `server/studio/interpret/fixtures/r1.json`, keyed by `PROMPT_VERSION`.
- The ledger: F-C, F-R, F-E, F-T2, F-I3 and F-I4 in `docs/probes/sweep-4-ledger.md`.
