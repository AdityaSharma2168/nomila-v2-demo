# Studio interpreter — plan (APPROVED by Adi 2026-09-12; Mia's M1–M6 open, M7 shipping as default)

> **[I.8] Moved into docs/ with the interpreter PR (2026-09-14).** This is v1 as approved. It is the base
> [plan v2](studio-interpreter-plan-v2.md) amends: v2 keeps v1's architecture and A1–A14, and replaces its
> readings of M1–M7 (Mia answered them, with Adi's corrections to M2 and M6). Where the two differ, v2 wins;
> what was built is v2's §14. v2's planning file overwrote this one, so this text was recovered from the
> planning session's transcript; the only edits are this note and the worktree path below.

> **Status.**
>
> - The architecture (A1, canonical sentence C) and all fourteen A-decisions are approved. See §8 for each one.
> - Sequence: I.0 first, as its own PR (the rule 4c "this" misroute, a live spend hazard). Then the A13 ledger entries. Then I.1–I.8. R1 and R2 recon run after I.3, under a $1.25 cap.
> - Interim defaults stand until Mia's sit-down: hero-only ads (M1), and ask on a competitor-kit frame (M2).
> - **M7 was pre-answered by Adi:** a brand named in her sentence counts as the ad's brand. It ships as the default and is flagged for Mia to confirm. §3 carries the revised ad gate.

**Base: main `d90efda`.**

- It is #444 (replace-with-ref), merged as a real merge commit with parents `959d631` and `333ef25`.
- #433 is `4c475fb`.
- `server/studio/**` on main is byte-identical to `333ef25`.
- Main has 42 compile goldens.

Every number below is a $0 replay (`route`, `freezeEditIntent`, `compileNativeInstruction`) on a detached, read-only worktree of main at `d90efda`. No detection ran, no model was called and the DB was not touched. The replay scripts were in the planning session's scratchpad and are not committed.

**The plan in one paragraph.**

- The interpreter is a paraphraser into the rules' own grammar. It runs only after `route(S)` asks with an eligible reason, and makes one Flash call.
- It produces typed slot-fills from a closed menu. Deterministic checks then turn them into a canonical sentence **C** in words `route()` already reads, and `route(C)` must reproduce the slots exactly.
- The preview then continues as if she had typed C: detection, the freeze, the compile and the quote are all unchanged. She is shown plain-words lines rendered from the frozen intent, and Generate is her approval.
- Two changes she never sees: a small closed set of constraints (keep me as I am; no X logos) rides beside C, and an intent that carries them is written as version 2.
- The spend path, `route()`, every guard and every existing golden are untouched. Her sentence, the proposal and the outcome live on the preview row, like the compiled prompt.

---

## 0. What recon found that shapes the plan

1. **The spend gate re-classifies her words, so a model-authored spec cannot be frozen directly.**
   - `nativeRecheck` (routes/studio.ts:1274) and `refusalFor` (:1237) re-run `route()` over `brief.job.direction.statement` at Generate. `intentsAgree` refuses on any difference.
   - `freezeEditIntent` calls `route(ask)` itself (nativeIntent.ts:230).
   - A spec frozen as the model wrote it would disagree with `route(her sentence) = ASK` on every job, and be refused at Generate.
   - "Freeze the proposal" and "spend integrity untouched" can both hold only if the proposal is expressed in words `route()` reads. That is the design.
2. **The code records "no LLM stage" as a decision** (classify.ts:2353–2366): a ~90% model would sit in "the layer that chooses whether to destroy a source photo". The design keeps `route()` LLM-free, and the note is appended to, not contradicted.
3. **A live fail-open sits on the ad path.** "turn this into an adidas ad" ROUTES on main.
   - Cause: rule 4c's item reader accepts "this", because it is not a determiner and passes `isItemWord` (classify.ts:1556–1604).
   - Result: `REPLACE_OBJECT ["this"] "adidas this"`, with "ad" dropped, which freezes `replace the this with adidas this. Keep everything else exactly as-is — change only the this…`.
   - 9 of 9 probed siblings route the same way: "turn this into a nike ad", "make this a nike ad", "change this to an adidas ad", "turn this into an adidas poster", "…campaign", "switch this to adidas", "turn this into adidas", "change this to adidas".
   - No Studio test string contains the shape, so a corpus diff would never show it. See §9.
4. **Preservation language already misfires on routed sentences.**
   - "change the background to a beach but dont change me" freezes `change the background to beach but dont change me` (rule 2's value regex, classify.ts:843).
   - "make my jersey blue, keep everything else the same" routes `RECOLOR [jersey, same]`.
   - "make my jersey blue and change nothing else" asks `compound_partial`.
5. **Create anything never attaches a brand.**
   - `CreateAnythingScreen.tsx:195–208` passes no `brandId`, so the preview sends `brandId: null`.
   - A brand attaches only through Brand post (active-deal brands only), then Setup, then "Extra instructions".
   - Under Mia's rule, "turn this into an ad" typed in Create anything can never route.
6. **Client facts:**
   - There is no plain-words "what will change"; the only element of that kind is the geometric box preview.
   - An ASK stops the preview call entirely (`use-studio-pending.ts:457–461`).
   - On an ASK, the client's intent is the old verb list's guess (studio-contract.ts:648–654).
   - Make it renders only the first blocker (MakeItScreen.tsx:296).
7. **Two of the cited "measured constraints" are not recorded on main.**
   - docs/probes/ holds only F-T, F-I1 and F-I2.
   - "Tiny-target removal is unreliable" appears in #444's local body as "ledger entry pending".
   - "≥4 changes in one call cleanly" I could not find anywhere.
   - §4 leans on both. See A13.

---

## 1. Where it sits

### The shape

```
her sentence S
  │
  ├─ route(S) ── routes ─────────────────────────────▶ exactly today (interpreter never called)
  │     │
  │     └─ ASK, reason ∈ ELIGIBLE · STUDIO_INTERPRETER on · native on · a frame · no drawn box
  │           │
  │           ├─ ad gate ($0, deterministic): an ad ask and no brand on the request → ASK ad_needs_brand
  │           ▼
  │     interpret(S, frame probe, attachment counts, brand name/category) — ONE flash call
  │           → edits (slot-fills from a closed menu), constraints, spans, visibleMarks
  │           ▼
  │     checks: schema · span coverage · negation tripwire · slot vocab/bounds
  │           ▼
  │     render(edits) → C   (a canonical sentence in the grammar route() already reads)
  │           ▼
  │     route(C) must reproduce the edits exactly (round trip), and every clause of S the fast
  │     path reads on its own must survive with the rules' own steps (first claim) — else ASK
  │           ▼
  └──── the preview continues AS IF SHE HAD TYPED C: detection on C, assembleBrief(direction C),
        withNativeEditIntent → freeze → compile (+ constraints) → previewGeneration → saved row
              ▼
        the preview shows interpretation.lines, rendered from the FROZEN intent
              ▼
        Generate (= accept)  ·  "Not what I meant" (= reject)
              ▼
        /studio/generate is UNCHANGED: nativeRecheck re-routes C and agrees by construction
```

**Why C, rather than freezing the model's spec:**

- **Guards run on its output literally as they run on rule output, because it is rule output.** That covers:
  - `route(C)` → `validate` (the person guard and the GENERATE invariant);
  - composition (too_many_changes, compound_conflict);
  - object_photo_missing;
  - the freeze (echo, unpaired, missing_value, ambiguous_object);
  - detection's own person rule.

  So constraint C holds by construction, not by re-implementation.

- **The spend path is untouched** (constraint A). `refusalFor` and `nativeRecheck` read `statement = C` and agree by construction. `intentsAgree`, `consumePreview` and the ceiling get no diff.
- **Rules keep first claim** (constraint B). `route()` does not change. The interpreter runs only after `route()` asks, and can only produce sentences `route()` reads.
- **Detection reads clean text**: C's region-bearing clauses, never her conversational sentence. That is also the preservation fix (§5).
- **What the choice costs:** the interpreter can express only what the rules can route. Display text, "blur the background" and a non-brand swap ("change the ball to a basketball") each need a deterministic front door first, and the interpreter inherits it. That is the conservative direction for the first model in the loop. Decision A1.

### What it receives — `InterpretationInput`

- **`sentence`:** her typed words (`explicitAsk(input)`). System origin only; an `inbound` ask is never interpreted.
- **Server-side only, for the first-claim check (never sent to the model):**
  - `route(S)`'s decline code;
  - `clausesOf(S)`, with each clause's own fast-path reading.
- **`frame`:** the same 1024px upright probe detection uses (`probeBytesFor`). It is fetched once and shared with detection.
- **`attached`:** counts by role (objects, products). Never the attachment images.
- **`brand`:** `{ name, category }`, only when a brand is on the request (server-resolved). Nothing from enrichment, tone or audience: scraped text stays out of the prompt.
- **Not sent:** her profile, prior turns, brand imagery.

### What it returns

`{ kind: "proposal", canonical: C, constraints, lines, record } | { kind: "ask", reason, record }`.

**The executable part is C.** It becomes the existing `FrozenEditIntent` through the existing freeze. There is one shape change:

- `FrozenEditIntent.constraints?: EditConstraint[]`, a closed set: `preserve_person` and `exclude_marks{brand}`.
- An intent that carries constraints is written as **version 2**. An older instance mid-deploy then refuses it ("unknown version", nativeEdit.ts:265) rather than running it without its constraints.
- Every intent with no constraints stays version 1 and byte-identical.

**Provenance** is `BriefJob.interpretation?`, which sits beside `editIntent` (brief.ts:330). It carries:

- `from: S`, `promptVersion`, `model`;
- `spans`, `edits`, `constraints`, `canonical`, `lines`, `visibleMarks`;
- `usage`, `costUsd`, `ms`, `outcome`.

It is display and record only; nothing in it executes. It is persisted on the `studio_generation_previews` row exactly as the compiled prompt is (constraint E), and joins to the job through `consumed_by_job_id`.

### Hook points

| where                                                              | change                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| routes/studio.ts:819, the preview route, before `detectionTextFor` | When `route(S)` asks and the sentence is eligible, interpret first. On a proposal, C replaces `parsed.direction` everywhere downstream (detection, `BriefInput.direction`, the freeze) and `interpretation` is attached. On an ask, the response is a blocked preview carrying the ask note, and **no detection runs on S** (today an ASK sentence sent straight to the preview route still pays for detection; #444 lists this as known remaining). |
| routes/studio.ts:1094, `/studio/classify`                          | Adds `interpretable: boolean`, deterministic: reason ∈ ELIGIBLE, the flag is on and there is a source photo. It stays pure and spends nothing.                                                                                                                                                                                                                                                                                                       |
| routes/studio.ts, new                                              | `POST /studio/previews/:id/interpretation/reject`, scoped by `athlete_id` (see A6).                                                                                                                                                                                                                                                                                                                                                                  |
| nativeEdit.ts:155 and :253                                         | `constraints?`, version 2, and `readNativeIntent` validates the constraint kinds.                                                                                                                                                                                                                                                                                                                                                                    |
| compile/                                                           | `constraints.ts` (templates), `describe.ts` (plain-words lines from the frozen intent), goldens.                                                                                                                                                                                                                                                                                                                                                     |
| nativeIntent.ts:384                                                | `ASK_NOTES` for the new codes.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| brief.ts:306                                                       | `BriefJob.interpretation?`, a jsonb field only, no migration.                                                                                                                                                                                                                                                                                                                                                                                        |
| config.ts                                                          | The flag and the pinned interpreter model.                                                                                                                                                                                                                                                                                                                                                                                                           |
| classify.ts                                                        | Additive exports only (COLOR, GLOBAL, BRANDS, DESIGN, the descriptors, the add prepositions), so the menu is built from the rules' own vocabulary. No behaviour change.                                                                                                                                                                                                                                                                              |

### How the preview renders it

- `routeWithServer`: an `interpretable` ASK with a frame returns `{ intent: "image.edit", editBase: frame, askReason: null, interpreting: true }`, so the preview fires. Today it cannot, and on an ASK the intent would be the verb list's guess.
- **An interpretation card on Make it**, above the cost:
  - heading "Here's what we'll do:", then one line per change and constraint;
  - suggested items marked as our suggestion;
  - a **Not what I meant** pill, which records the rejection and returns her to the composer with her words.
- **The lines come from the frozen intent** (`compile/describe.ts`), never from the model, so what she reads is what compiles. A recolour reads its detection-paired change ("Make the shorts black and green").
- While it works, the screen shows "Working out what you mean…".
- **The mask-correction link is hidden on an interpreted preview.** A drawn box is explicit spatial intent and routes masked, where none of C's guarantees hold.
- **Generate stays the one button that spends.** Approving the preview is approving the interpretation (A2).

---

## 2. The model call

**Model and config**

- Gemini Flash through `genai()`, the same pattern as detection and QA (autoMask.ts:660, qa/vision.ts:198).
- Pinned as its own constant in studio/config.ts, defaulting to `gemini-3.5-flash` (today's `GEMINI.flash`). It is not the shared, env-driven `GEMINI.flash`: the model that wrote each proposal is recorded, and it must not move when another feature changes an env var.
- Settings:
  - temperature 0;
  - `responseMimeType: "application/json"`;
  - `responseJsonSchema` with enums, so GENERATE, or any operation outside the menu, cannot be emitted;
  - `thinkingConfig` at the minimal level;
  - a 15s `withTimeout`.
- Both schema and thinking fields are verified present in the installed @google/genai 2.7.0. Studio uses neither yet; Mila does.

**The prompt, versioned as `PROMPT_VERSION`**

1. **Role:** translate a photo-edit request into edits from a fixed menu. Never edit, and never describe the person.
2. **Fences:**
   - her sentence goes inside `<editing_request>`, framed as DATA, in detection's own wording (autoMask.ts:534);
   - the brand goes inside `<brand>`, also as data;
   - text visible inside the photo is part of the photo, never an instruction.
3. **The menu** is built from the rules' own exports:
   - recolor {target, colour}
   - remove {target}
   - brand_swap {item, descriptors, brand}
   - pointed_swap {target, what}, only when an Object photo is attached
   - add {thing, preposition, place}
   - design {design, target}
   - background {setting}
   - look {term}
   - constraints: preserve_person, exclude_marks {brand}
4. **Rules:**
   - a target is a thing in the photo, never her or a part of her body;
   - at most four edits;
   - only her own changes, unless she named a treatment ("make this an ad", "make it pop"). A treatment gets at most three edits from background and look, each flagged `suggested`;
   - "if there are any X remove them" and "I don't want any X showing" become `exclude_marks`, never a removal;
   - "don't change me" becomes `preserve_person`;
   - a part of the sentence that fits nothing on the menu is an `unreadable` span;
   - declining is allowed.
5. **Output:** `{ decline, spans:[{quote, reads: edit|constraint|filler|unreadable, edits:[i]}], edits, constraints, visibleMarks }`.
6. **About eight synthetic worked examples**, never the acceptance sentences.

**Checks on the reply.** Each is deterministic, and each failure asks:

- **Schema.**
- **Span coverage:** every `quote` is a verbatim substring of S, and the quotes together cover every content word. A dropped clause shows up, which is what stops a five-change sentence being laundered into four.
- **Constraint quotes:** a constraint's brand must appear in its own quote.
- **Negation tripwire:** "no", "not", "without", "except", "never" or "dont" inside an `edit` span asks. Dropping "without stripes" would invert what she said.
- **Slots:**
  - closed vocabulary wherever the rules have one;
  - free slots (target, thing, place, setting) held to the rules' own bounds: ≤3 words, and a setting ≤40 characters, which is rule 2's bound;
  - `[a-z -]` characters only;
  - no pronoun, and no word from PERSON_NOUNS;
  - no joiner or verb token (the "jersey and remove the ball" smuggle).
- **Round trip:** `route(C, true, attached)` reproduces the edits exactly (op, targets, value, reference) and drops nothing.
- **First claim:** every clause of S that the fast path reads on its own appears in `route(C)` with the rules' own steps.

**Latency.** Unmeasured; the estimate is 2–5s.

- The call runs before detection, because C decides what detection reads.
- An interpreted preview should take about 3–9s, against about 2–4s for a detected deterministic one.
- Worst case: 15s here plus detection's 20s.

**Cost.** About $0.002–0.004 per call. That is an estimate at QA's Flash rates ($0.30/M in, $2.50/M out; basis "estimated", qa/cost.ts).

- **Tokens:** about 2.5k prompt plus up to 1.1k image in, and about 300–500 out.
- **Measured per call:** `usageMetadata` (prompt, candidates and thoughts tokens) is recorded on every proposal.
- **Memo:** keyed by athlete, frame, S, object count, brand and `promptVersion`, with a 30-minute TTL, per instance, like detection's memo (autoMask.ts:757). Make it's re-fire and a format change cost nothing.
- **No retries:** one call per key.

**On failure she always gets today's ask:**
| failure | she sees | outcome recorded |
|---|---|---|
| timeout, API error | S's original ask copy | `timeout` / `error` |
| unparseable or schema-invalid reply | S's original ask | `unparseable` |
| the model declines | S's original ask | `declined` |
| span coverage fails, or a quote is not in S | S's original ask | `uncovered` |
| negation tripwire | S's original ask | `negation` |
| a slot out of vocabulary or bounds | S's original ask | `invalid_slot` |
| `route(C)` ≠ the edits | S's original ask | `round_trip_mismatch` |
| first claim broken | S's original ask | `first_claim` |
| `route(C)` asks on a guard (person, add*onto_body, object_photo_missing, too_many_changes, compound_conflict, brand*\*) | **C's code**, the truer line (ask → better ask) | `guarded:<code>` |
| C's freeze refuses, or detection on C finds nothing | today's freeze note, or today's 400 | `freeze:<code>` / `not_found` |

**Logs** carry reason codes, ids, milliseconds and token counts only: never S, C or a slot value (the rule at classify.ts:2691). The record lives on the preview row, not in a log line.

---

## 3. "Turn this into an ad"

**The ad gate: deterministic, before the interpreter, $0.** It fires when, with the preservation span set aside, the ask's object is an ad, advert, advertisement, campaign (shot/image) or commercial.

The ad's brand is the **attached brand OR a brand named in her sentence** (M7, Adi's default, to be confirmed by Mia).

| brand attached to the request | brand named in the sentence (BRANDS vocabulary)                  | answer                                                         |
| ----------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| none                          | none                                                             | ASK `ad_needs_brand`, no model call                            |
| none                          | exactly one ("turn this into an adidas ad", "…an ad for adidas") | passes, with that brand as the ad's brand context              |
| X                             | none, or X                                                       | passes, with X                                                 |
| X                             | Y ≠ X                                                            | ASK `ad_brand_mismatch` ("You picked X but asked for a Y ad…") |
| any                           | two different brands ("a nike adidas ad")                        | ASK `ad_brand_mismatch`                                        |

**A named brand is resolved to its `inbox_brands` row.** Its DO NOTs and category then apply exactly as an attached brand's would.

- **How:** one new SELECT-only read, `brandIdForName(name)`: a case-insensitive exact match on `inbox_brands.name`. It uses the same brand-public, existence-only argument as `resolveBrand` (routes/studio.ts:604–620).
- **Exactly one row:** its id becomes `BriefInput.brandId`, and `assembleBrief` builds the brand half, competitor DO NOT and all.
- **No row, or several:** the ad proceeds on the name alone. The interpreter gets the name, no DO NOTs apply, and a `degraded` note says so: "We don't have adidas's brand guidelines on file, so none are applied." That default is flagged; the alternative is to ask.
- **Brands outside the BRANDS vocabulary** aren't recognised as brands ("turn this into a gatorade ad" with nothing attached), so they get `ad_needs_brand`.

**`ad_needs_brand` copy** needs sign-off. It must say _where_, because Create anything has no brand picker (M5): "An ad for which brand? Name it — 'turn this into an adidas ad' — or start from Brand post and pick it."

**Prerequisite: I.0.** On main today, "turn this into an adidas ad" misroutes in rule 4c before any of this can run. I.0 lands first and makes it ask (`brand_change`, which is on the eligible list), so the sentence reaches this gate.

**With a brand:** the interpreter proposes a treatment from the menu, every item flagged suggested:

- **Background:** one setting of up to 40 characters, fitted to the frame and the brand's category. CHANGE_BACKGROUND; Q2 measured it native and CLEAN.
- **Look:** one term rule 3 already reads: warmer, cooler, brighter, darker, more contrast, golden hour, film look, vintage look, black and white, sepia or monochrome. GLOBAL_STYLE; no native look cell has been measured.
- **`preserve_person`:** always on for a treatment.
- **The brand's DO NOTs** already ride every native prompt as `DO NOT: Never show a competitor of <brand>: …` (brief.ts:770, compile/assemble.ts:132).

An example C: `change the background to a stadium at night under floodlights, and make it more contrast`. Both clauses route today and compose (replayed: "make it warmer and change the background to a stadium at night" freezes with the background last). She would see:

- Change the background to a stadium at night under floodlights (suggested)
- Give the photo more contrast (suggested)
- Keep you exactly as you are

**Mia's calls, not decided here:**

- **M1: a hero image, or one that carries text?**
  - F-T says in-model short display text is viable: two words, and three words plus a wordmark, n=1 per cell, on one frame.
  - Text has no front door today. F-I1: "add the text GET LOUD across the top" asks. #433's rule-2 fix also makes any "…of the background" object ask.
  - If the answer is text, the plan adds one commit: an op `DISPLAY_TEXT {content ≤4 words, placement ∈ top-banner | upper-right, fixed style}`, its rule, a template taken from q6-t1's measured wording, and goldens.
  - Mia also decides whose words go in: hers only, the brand's name only, or a suggestion she approves.
  - A brand's trademarked tagline (F-T used "IMPOSSIBLE IS NOTHING") is a separate policy call.
  - The plan defaults to a hero image only.
- **M2: an ad on a frame showing a competitor's kit.**
  - This is Mia's F-T observation (adidas over a Nike frame), and on an ad it collides with `preserve_person`: the competitor DO NOT pulls toward changing her kit, and "don't change me" pulls against it.
  - The interpreter reports `visibleMarks` from the photo (a closed BRANDS enum), and a deterministic rule acts on it.
  - The options are to ask, to disclose, or to offer a kit swap. I recommend asking (`ad_brand_conflict`).
- **M6: does "don't change anything about me" rule out a whole-frame grade?**
  - A look re-grades her skin too.
  - I recommend: preservation means face, hair, body and pose, compiled as one reinforcing clause; a grade is allowed and disclosed.
- **"make an ad out of this"** is out of reach and not touched (A14).
  - Rule 0 claims it as GENERATE, because EXPLICIT_GENERATE matches "make an … ad", and the edit freeze refuses it `generate_on_edit`.
  - Constraint B and rule ② both put it beyond the interpreter.

---

## 4. Sentence (4), clause by clause

> change my uniform so that its a black adidas uniform. i dont want any nike logos showing in this so if there are any remove them. also make my cleats pink and adidas

Today it asks `conditional`: rule ¼ fires on the whole sentence. `clausesOf` cuts before "also make…", and neither clause reads on its own.

| her clause                                                                 | rules today                                                             | the interpreter reads                            | canonical                                   | `route(C)`                               |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------- | ---------------------------------------- |
| change my uniform so that its a black adidas uniform                       | ASK `brand_change` ("so that its a" is left over)                       | brand_swap{uniform, [black], adidas}             | change my uniform to a black adidas uniform | REPLACE [uniform] "black adidas uniform" |
| i dont want any nike logos showing in this so if there are any remove them | ASK `conditional`                                                       | exclude_marks{nike}: a constraint, not a removal | —                                           | —                                        |
| also make my cleats pink and adidas                                        | ASK `brand_change` ("and" between a colour and a brand is not a joiner) | brand_swap{cleats, [pink], adidas}               | change my cleats to pink adidas cleats      | REPLACE [cleats] "pink adidas cleats"    |

**C** = "change my uniform to a black adidas uniform, and change my cleats to pink adidas cleats".

- Replayed on main, it routes as two REPLACE steps and freezes `replace the uniform with black adidas uniform, and replace the cleats with pink adidas cleats. Keep everything else exactly as-is — change only the uniform and the cleats. Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.`
- The exclusion joins the existing `DO NOT:` line (assemble.ts:132) as something like "show a Nike logo anywhere in the photograph". R2 settles the wording.
- Detection reads C (the uniform and the cleats). It is never asked to find a logo.

**Why the conditional becomes a constraint, not a REMOVE:**

- "If there are any" is a question about the picture. As an exclusion it is true whether there are none, one or several, and it needs no perception.
- REMOVE [nike logos] is the tiny-target removal that the unrecorded sweep-4 finding calls unreliable. Detection would also have to find every logo, and finding none is a 400.
- The two replacements already take the swooshes off the uniform and the cleats; replace works. The constraint covers what she didn't name, which on the Q1 frame means the socks.

**What still asks, honestly:**

- an exclusion of anything that is not a brand mark ("no people in the background");
- a negation inside an edit ("…to adidas without stripes");
- a fifth change;
- the exclusion colliding with a mark she is wearing (M4).

The exclusion clause itself is unmeasured. R2 measures it before the build (§7).

---

## 5. "dont change anything about me"

**How it trips today.** I read this from the code; reproducing it needs a paid detection call, so I haven't.

- Detection reads her whole sentence whenever the rules ask, or route a single change (`detectionTextFor`, nativeIntent.ts:544).
- A detection entry with no directive takes `labelFor(instruction)`, which is her sentence, as its label (autoMask.ts:388).
- The freeze refuses any recolour whose regions carry that label: `echoed_directive` (nativeIntent.ts:246–254).
- So a preservation clause that detection doesn't turn into a directive leads straight to the echo refusal.
- Separately, on sentences that route, preservation words leak into values and targets (§0.4).

**The fix, on the interpreter path (this PR):**

- The interpreter emits `preserve_person` for that span, as a typed constraint that is never part of an edit.
- C never contains the words, so neither `route(C)` nor detection sees them. The echo set is `labelFor(C)` plus `labelFor(detected C)`, so it cannot contain her preservation phrase.
- She is shown it back: "Keep you exactly as you are".
- It compiles to one reinforcing sentence: "Keep the person's face, hair, body and pose exactly as they are." Every native scope clause already implies this, so it matters only where a look re-grades the frame.

**On sentences that route today, this PR changes nothing.**

- Stripping preservation words before `route()` would change their steps: "…beach but dont change me" would lose the junk in its value, and "…keep everything else the same" would lose its "same" target.
- Both are route → route changes, which constraint B forbids. They are a second named exception and a separate fix (A3b).
- The corpus cases that ask today do become interpretable, which is ask → route and allowed:
  - "add a soccer ball between my cleats, keep everything else the same" (add_unclear);
  - "make the socks blue and change nothing else" (compound_partial).

---

## 6. Scope fence

**Not in this PR:**

- **Style vocabulary (the next PR).** The interface is the look slot's enum, built from rule 3's own vocabulary (GLOBAL, exported). The round trip makes a look valid only if rule 3 reads it. The style PR widens rule 3 and its templates; the interpreter inherits both and needs no change.
- **Session memory, "make it blue" (the persistence PR).** No earlier turn reaches the interpreter. A pronoun with no referent in the sentence or the photo is `unreadable`, so it asks. The interface `InterpretationInput.prior?: { canonical, steps }` (the last accepted C) is reserved and not built.
- **Quality templates, CD.** No existing clause template and no preservation text changes. The only new templates are the constraints (and text, if M1 goes that way).
- **Also out:**
  - GENERATE: rule 0 keeps everything it claims.
  - A drawn box, and the flag-off native arm: the interpreter needs `STUDIO_NATIVE_EDIT`.
  - Sentences that route but then fail the freeze: "blur the background" gets `missing_value`.
  - Multi-turn clarification: the interpreter proposes or declines, and never asks her a question.
  - Resolving a brand from her words.
  - A brand picker on Create anything (M5).
  - Plain-words lines on deterministic previews: a follow-up, though `describe.ts` is general.
  - Rule 4c's "this" fix (A3a), which is its own PR.
  - Folding `SETTING_HEADS` into `BG_NOUNS`.
  - Digits in targets.
  - QA enforcement.
  - A `studio_interpretations` table (A6).
  - Anything outside Studio.

---

## 7. Proof plan

### Corpus-diff obligations ($0, a harness on the #444 pattern)

1. **route() diff.** Main `d90efda` against the branch, over every Studio test string (3,497+), each run with and without a photo and with 0 and 1 Object photos.
   - Required result: **0 rows**. The interpreter never touches `route()`.
   - If A3a is bundled into this PR instead of landing first, the only rows allowed are its named "this"-as-item misroutes moving to ASK.
2. **Preview-decision diff (new).** The same corpus × {no brand, brand attached} × {flag off, flag on}, run through the real preview decision: eligibility → the interpreter on a fixture transport → C → route → freeze → compile.
   - **Flag off:** identical to main, 0 rows.
   - **Flag on, rows that route on main:** byte-identical frozen intent and compiled prompt.
   - **Flag on, rows that ask on main:** either the same ask, a better ask, or an interpreted route whose reply is a recorded fixture.
   - Rows with no recorded reply run a transport that always declines, which proves they ask exactly as on main.
   - Nothing moves from route to ask.

### Testing interpreter cells deterministically

The interpreter takes a transport, `(prompt, image) → raw text`. Tests inject the replies, so CI never calls a model.

**Recorded replies**

- They live in `server/studio/interpret/fixtures/*.json`, keyed by sentence and `PROMPT_VERSION`.
- They are captured once by a capped script that is dry by default (`--run --cap`), in the probe scripts' style.
- A prompt-version bump makes stale fixtures fail loudly rather than drift.

**Adversarial replies, hand-written.** This is the fail-closed proof. Each of these must ask:

- a body target;
- GENERATE, or an unknown kind;
- five edits;
- four edits for a five-clause sentence (the coverage check);
- a quote that is not in S;
- a joiner smuggled into a slot;
- a pronoun or a person word in a setting;
- a colour outside the vocabulary;
- two backgrounds;
- a negation inside an edit span;
- a first-claim override (re-reading "make her jersey blue" as red);
- `exclude_marks{brand:"the person"}`;
- a constraint that carries a step;
- over-long values;
- a pointed swap with no Object photo;
- `decline: true`.

**Route tests through the real preview and generate routes** (the studio.native.test.ts pattern: PGlite, genai mocked with fixture replies):

- the preview row carries `interpretation`, and its statement is C;
- the frozen intent equals `route(C)`'s;
- Generate is accepted, because nativeRecheck agrees;
- setting the stored statement back to S makes Generate refuse with NATIVE_INTENT_CHANGED;
- an older reader refuses a version 2 intent;
- detection is never called with S;
- reject is scoped to her own rows.

Plus a log-scan test: no interpreter log line contains S or C.

### Goldens

The existing **42 stay byte-identical**. New fixtures:

- the canonical forms of the four acceptance sentences, through the real `route()` and freeze;
- the `preserve_person` and `exclude_marks` clauses;
- a version 2 intent;
- the describe lines for every operation;
- the ask notes for the new codes.

Plus a guard that every menu kind's render round-trips through `route()`.

### Revert checks

Runbook: `cp` aside, mutate, run with `--json`, and write the predictions down first.

| mutation                                                   | red expected                                         |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| ELIGIBLE gains `person_target`                             | the eligibility pins, the body-sentence preview test |
| round-trip check off                                       | the smuggle, `dropped` and value-truncation fixtures |
| span-coverage check off                                    | the 5→4 laundering fixture                           |
| negation tripwire off                                      | the "without stripes" fixture                        |
| first-claim check off                                      | the jersey-override fixture                          |
| a constraint may carry a step                              | the constraint adversarials                          |
| the version 2 bump off                                     | the older-reader refusal pin                         |
| detection given S instead of C                             | the "detection never sees S" pin                     |
| the statement left as S                                    | the generate route test (nativeRecheck refuses)      |
| the memo key without athleteId                             | the memo tenancy pin                                 |
| the flag defaults on                                       | the flag-off diff, the config pin                    |
| the interpreter runs on a drawn box                        | the drawn-arm pin                                    |
| the lines read from the model instead of the frozen intent | the describe-vs-freeze pin                           |
| the ad gate off with no brand                              | the `ad_needs_brand` pins                            |
| a log line carries the sentence                            | the log-scan test                                    |

### Paid recon, after approval (Adi runs it; cap $1.00)

- **R1: record the interpreter's replies.**
  - About 45 sentences: the corpus asks, the neighbourhoods around the four acceptance sentences, and the ad, conditional and preservation classes.
  - About $0.15. It also measures tokens and latency.
- **R2: the exclusion clause.**
  - n=2 on the Q1 frame, which has Nike on the jersey, the cleats and the socks. Direct router, using sentence (4)'s C plus the exclusion sentence.
  - About $0.27 billed at 2K ($0.33 quoted).
  - The verdict question: is any Nike mark left anywhere, and did anything else change?
  - If it fails, (4)'s logo clause asks instead, and M4 and A11 are revisited before anything ships.

### Acceptance

Adi drives. First prove the server is running the branch head.

| cell                                                                                                      | setup                                                                                                                                                                                                                                                                                      | expected                                                                                                                                                                                                        | spend                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| (1a) "turn this into an ad. dont change anything about me"                                                | adidas attached. The UI only offers brands with an active deal, so this may need a direct API call with `brandId`.                                                                                                                                                                         | The interpretation card shows a suggested background, a suggested look, and "Keep you exactly as you are". After Generate: identity, pose and clothing are kept, and M2's rule applies if the frame shows Nike. | ~$0.003 + $0.1344 at 2K                                             |
| (1b) the same sentence, no brand anywhere (Create anything)                                               | —                                                                                                                                                                                                                                                                                          | The `ad_needs_brand` line. The log shows no interpreter call.                                                                                                                                                   | $0                                                                  |
| (1c) "turn this into an adidas ad. dont change anything about me" from Create anything, no brand attached | I.0 merged                                                                                                                                                                                                                                                                                 | Adidas is resolved from the sentence, so its DO NOTs and category apply. Same card as (1a).                                                                                                                     | ~$0.003 (preview only)                                              |
| (2) "change my earrings in the first picture to these gold hoops" with an Object photo                    | as on #444                                                                                                                                                                                                                                                                                 | Routes deterministically, with no interpreter event. The stored prompt equals its golden ("replace the earrings with the gold hoops from Image 2…").                                                            | $0: compare the stored prompt; #444's acceptance already covered it |
| (3) the no-earrings add, with a hoops photo, on a frame with no earrings                                  | Phrasings: the five that already get `add_onto_body`; "give me these gold hoops", "i dont have earrings in this one, add these gold hoops" and "add these gold hoops" (interpreted); "can you add these earrings to my ears" (gets the person line today; a deterministic copy fix in I.4) | Every phrasing asks with `add_onto_body`'s line, and none is ever a ready preview.                                                                                                                              | ~$0.01                                                              |
| (4) the uniform sentence                                                                                  | Q1 frame                                                                                                                                                                                                                                                                                   | The three lines from §4. Detection finds the uniform and the cleats. Generate once. Verdict: a black adidas uniform, pink adidas cleats, and no Nike mark anywhere, socks included.                             | ~$0.003 + $0.1344 at 2K                                             |

**Total ≈ $0.70:** about $0.28 of acceptance and $0.42 of recon. Cap $1.25.

---

## 8. Decisions needed

**Adi — all approved 2026-09-12.** Specifics:

- **A3a:** I.0 is pulled forward as its own PR, built and merged FIRST, and not gated on the interpreter.
- **A13:** the evidence is Adi's live verdicts from the sweep #4 session. The ledger entries come before the build, and Adi confirms the wording.
- **A12:** I.7 stays conditional on M1.

The table below keeps the original wording.

| #   | decision                                                                                                                                                                                                                                                                                                                 | recommendation                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | The interpreter as a paraphraser into the rules' grammar (C), vs freezing the model's spec (which needs an arm in the spend gate)                                                                                                                                                                                        | C                                                                                                                                                                |
| A2  | Confirmation: one screen (the lines and the cost, where Generate accepts, plus "Not what I meant"), vs two steps (accept, then quote)                                                                                                                                                                                    | one screen                                                                                                                                                       |
| A3a | An exception to B: rule 4c never reads a demonstrative as an item, so "turn this into an adidas ad" asks                                                                                                                                                                                                                 | Yes, as its own small PR landing first, with #433-style proof. Otherwise those phrasings stay misrouted and never reach the ad path.                             |
| A3b | An exception to B: preservation words leaking into rule 2's value and targets on routed sentences                                                                                                                                                                                                                        | Not in this PR; a follow-up with its own route diff                                                                                                              |
| A4  | Which asks the interpreter may take. **Eligible:** fast_path_declined, compound_partial, conditional, brand_change, brand_removal, add_unclear. **Never:** person_target, person_mentioned, add_onto_body, object_photo_missing, too_many_changes, compound_conflict, generate_not_permitted, low_confidence\*, no_steps | as listed                                                                                                                                                        |
| A5  | Send the frame image in the interpreter call                                                                                                                                                                                                                                                                             | Yes. It fits treatments to the photo, feeds M2's `visibleMarks`, and tells add from replace for "give me these hoops". About +$0.0003 a call.                    |
| A6  | Where proposals live: on the preview row as jsonb (no migration; a rejection is written into the advisory `plan` column; accepted means the row was consumed), vs a new `studio_interpretations` table (a shared-schema change, Mia's call)                                                                              | The preview row for v1. The previews table's expiry index (shared/schema.ts:1762) anticipates a sweep; whoever builds that sweep must spare interpretation rows. |
| A7  | All-or-nothing (inheriting composition's decision 2), vs a disclosed partial                                                                                                                                                                                                                                             | all-or-nothing                                                                                                                                                   |
| A8  | A pinned interpreter model, a recorded `PROMPT_VERSION`, and minimal thinking                                                                                                                                                                                                                                            | yes                                                                                                                                                              |
| A9  | QA adherence scores C (what she approved), not S                                                                                                                                                                                                                                                                         | yes                                                                                                                                                              |
| A10 | `STUDIO_INTERPRETER` (server) plus `EXPO_PUBLIC_STUDIO_INTERPRETER` (client), both off by default, both required                                                                                                                                                                                                         | as named                                                                                                                                                         |
| A11 | Constraint kinds in v1: `preserve_person` and `exclude_marks` (brand marks only), gated on R2                                                                                                                                                                                                                            | yes                                                                                                                                                              |
| A12 | Build the text arm now, behind M1, or later                                                                                                                                                                                                                                                                              | later, unless M1 lands first                                                                                                                                     |
| A13 | Record "≥4 changes in one call" and "tiny-target removal is unreliable" in the sweep-4 ledger before this PR cites them. Where is that evidence?                                                                                                                                                                         | first                                                                                                                                                            |
| A14 | "make an ad out of this" stays claimed by GENERATE                                                                                                                                                                                                                                                                       | leave it                                                                                                                                                         |

**Mia**
| # | decision |
|---|---|
| M1 | What an ad produces: a hero image, or one carrying text. If text, whose words go in, and whether trademarked taglines are allowed. |
| M2 | An ad on a frame showing a competitor's kit: ask, disclose, or offer a kit swap (which conflicts with "don't change me"). |
| M3 | D1 is unchanged, so (3) keeps asking. If D1 opens, the change is a rules PR, and the interpreter inherits it for free. |
| M4 | Can she ask for "no <brand> logos anywhere" on kit she is wearing? This is F10's open question of whether a mark may be removed at all. |
| M5 | A brand attach on Create anything (there is none today), or an ask that sends her to Brand post. |
| M6 | Whether "don't change anything about me" still allows a whole-frame grade. |
| M7 | **Pre-answered by Adi and shipping as the default:** a brand named in her sentence counts as the ad's brand, resolved by name, with its DO NOTs and category applied. Mia to confirm. |

---

## 9. Conflicts with the constraints

**A: freezing the proposal.** A model-authored spec cannot get through the spend gate unchanged (§0.1). C resolves that, but it is a design choice (A1), not the only possible reading of A.

**B: fail-opens and misroutes on this PR's path.** Constraint B, as written, would lock all four in place:

- the "this"-as-item misroute (A3a);
- preservation words in the values of routed sentences (A3b);
- ad asks that GENERATE claims (A14);
- sentences that route but then fail the freeze.

**C: the constraints bypass `route()`.** `preserve_person` and `exclude_marks` are the one interpreter output that does not pass through the rules. They are closed in shape and subtractive only: each can add a keep sentence or a DO NOT sentence, never a step or a target. `readNativeIntent` validates them, and the adversarial fixtures test them.

**E: "logged".** The codebase never logs her sentence (classify.ts:2691; autoMask keeps the same rule). "Logged like a compiled prompt" is read here as persisted on the preview row, never written to a log line.

**Mia's ad rule vs the product.** The surface where she would type "turn this into an ad" (Create anything) cannot attach a brand (M5).

---

## 10. Build shape (approved)

**Sequence:**

1. I.0 as its own PR, merged first.
2. The A13 ledger commits.
3. I.1–I.8, landed with a merge commit.

R1 and R2 run after I.3, under a $1.25 cap.

| #   | commit                    | contents                                                                                                            |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| I.0 | rule 4c demonstrative fix | its own PR, built and merged FIRST (a live spend hazard on main)                                                    |
| I.1 | compile                   | constraints, version 2, describe, goldens. No producer yet (the R.2 precedent).                                     |
| I.2 | interpret core, pure      | the menu, reply validation, spans, the tripwire, render, the round trip, first claim, the adversarial fixtures      |
| I.3 | transport                 | the prompt, the memo, the record script, the R1 fixtures                                                            |
| I.4 | eligibility and copy      | the eligibility list, the ad gate, the new codes and copy, the `add_onto_body` copy for "can you add…"              |
| I.5 | route wiring              | the preview hook, `interpretable` on classify, the reject endpoint, the flag, the PGlite route tests                |
| I.6 | client                    | the flag, the interpreted arm, the card, reject, the copy. Verified in the iOS Simulator and in phone-width Chrome. |
| I.7 | text arm                  | only if M1 chooses text                                                                                             |
| I.8 | docs                      | an appendix to the "no LLM stage" note, and cross-references in the ledger                                          |

**Files:**

- **server/studio:**
  - `interpret/**` (new)
  - `compile/{constraints,describe}.ts`
  - `nativeEdit.ts`, `nativeIntent.ts`
  - `brief.ts`: one optional field
  - `config.ts`
  - `classify.ts`: exports only
- **server/routes:** `studio.ts`
- **client:**
  - `lib/studio-contract.ts`
  - `lib/flags.ts`
  - `hooks/use-studio{,-pending}.ts`
  - `screens/studio/MakeItScreen.tsx`
- **tests:** plus `compile.golden.json`

No migration, no deploy config, no change to any flag's default, and nothing run against the DB beyond Adi's acceptance.
