# SWEEP #3 · PART B — FINDINGS & FIX LIST (2026-09-10, ~12:00–12:35)

> **Read the addendum at the end before citing F3, F5, F6, F9 or F10.** After this was written, the compiled prompt for every Part B job was pulled from the database. Every dropped change in Part B was dropped by the classifier before the model saw it. (Addendum added 2026-09-10.)

**Important caveat up front:** the "B-p" cells were run through the **UI**, not the probe harness — so every result here is product-path (classifier + compiler + model). The harness tier that isolates the model **has still never run**, and several B-p cells never reached the model at all because the probe phrasing ("the person's feet") trips the person guard. Blame assignment between compiler and model is therefore still open for the add-combos. What IS settled is listed below.

---

## The routing table (what the classifier did)

| Cell | Sentence | Classifier outcome |
|------|----------|--------------------|
| B-c1 | make her jersey blue and change the background to a stadium | ROUTED — but recolor dropped in output |
| B-c2 | (recolor + recolor) | ROUTED, worked |
| B-c3 | make her jersey blue and remove the water bottle | ROUTED, worked (⚠ known-bug predicted jersey removal — did NOT reproduce; see F9) |
| B-c4 | make her jersey blue and remove the cleats | ROUTED → Vertex IMAGE_SAFETY |
| B-c5 | remove the 8 and nike logo | ASK `brand_change` |
| B-c6 | remove the cleats and change the background to a stadium | ROUTED — removal worked, stadium didn't; outfit replaced wholesale |
| B-c7 | add a soccer ball at her feet and make her jersey blue | ASK `person_target: feet/her` |
| B-c8 | add a soccer ball at her feet and remove the nike logo | ASK `person_target` |
| B-c9 | add ball + add bottle ("water bottle next to her") | ASK `add_unclear`, junk target "water bottle next" |
| B-c10 | recolor + lightning bolt design | ROUTED — design landed, recolor dropped |
| B-c11 | 3-op (recolor + add + background) | ROUTED — only a mangled background-ish change; all three `happened:false` per adherence |
| B-c12 | 3-op with remove | ROUTED → IMAGE_SAFETY |
| B-c13 | two sentences ("also") | ASK `person_target` |
| B-c14 | "then" | ROUTED — giant-cleats surreal composite, adherence `not_done` |
| B-p1 | Add a soccer ball at the person's feet, and change the background… (UI) | ROUTED — background landed, ball dropped |
| B-p2/p3/p6/p7 | "…the person's feet / next to the person" (UI) | ASK `person_target: person` — **never reached the model** |
| B-p4 | Remove the soccer ball, and change the background to a packed stadium at night (UI, different frame) | ROUTED — ball removed + background changed, "night" dropped |
| B-p5 | Remove the soccer ball, and make her jersey blue (UI) | ROUTED — both landed, recolor weak (blue-ish black) |
| B-p8 | 4-op (UI) | ASK `person_target` — never reached the model |

---

## Findings ledger

**F1 · Compound sentences containing an ADD clause never route. `[classifier-fix]` — top priority.**
C′'s ADD parser handles single-intent sentences only. Any compound with an add clause falls through to the legacy extractor, which re-extracts the place phrase ("her feet", "the person") as a *target*, and the person guard denies it. D1's surface-vs-spatial rule lives only inside the ADD parser — the fall-through path doesn't know it. Every add-combo (B-c7, c8, c9, c13, B-p2/3/6/7/8) died here. Repro sentences all recorded above. **Consequence: the model has NEVER been tested on an add-combo through any path. The capability question for add+X is still fully open.**

**F2 · The person-guard decline copy lies on these declines. `[classifier-fix]` (copy)**
"We don't edit people in photos" shown for "add a soccer ball at her feet and make her jersey blue" — nothing in that sentence edits a person. Same reason-code plumbing as C.4; the compound fall-through needs either the D1 rule or at minimum honest copy ("we couldn't follow the multi-part sentence — try one change at a time").

**F3 · When a multi-op prompt DOES reach the model, changes get dropped — background usually wins. `[CD]` / `[D″-candidate]`**
b-c1 (recolor dropped, background kept), b-c10 (recolor dropped, design kept), b-c11 (all three nominally dropped, background mangled), B-p1 (ball dropped, background kept). Adherence's `requested` lists prove the frozen intents contained every change — the drop happens at compile or model tier. **Contradicts B1/B2's clean two-change result from Sept 9**, which means it's not a hard model ceiling — it's prompt-sensitive. Counter-evidence the same day: B-p4 and B-p5 landed both changes (remove-combos), B-c2 and B-c3 landed both. Pattern so far: **remove+X and recolor+recolor compose; recolor+background and anything+add-shaped are flaky; 3-op fails.**

**F4 · Blame assignment for F3 is still open — two cheap instruments, neither run yet.**
(a) Retrieve the **compiled prompt** for a failed job (b-c11's `bd9ceaea…` or B-p1's) — if it's mushy, it's the compiler. If it's not persisted anywhere, that's an observability gap to fix (we spend money on prompts we can't post-mortem). (b) True **harness runs** with hand-built prompts — now also the only way to test add-combos at all (F1 blocks the product path). Use "her feet"-free phrasing that can't trip anything, e.g. "Add a soccer ball on the grass in front of the pink cleats."

**F5 · Vertex IMAGE_SAFETY fires nondeterministically on garment-removal sentences. `[Mia]` + error-copy**
"remove the cleats" → SAFETY twice (b-c4, b-c12), succeeded once (b-c6). Provider-side, content-sensitive, nondeterministic. The user currently sees a raw failed job — needs honest retry/decline copy. Adjacent to the remove-jersey gap already on Mia's agenda; garment removal as a class needs a policy call.

**F6 · b-c6 is the restyle-variance worst case on record. `[Mia]` exhibit**
Asked: remove cleats + stadium background. Got: barefoot, entire kit replaced (maroon adidas-style bra + white shorts), plain field, goalpost removed. Adherence caught every deviation. This is the accepted-restyle-variance decision showing its teeth — Mia should see this image next to the acceptance record.

**F7 · Adherence is production-grade. `[CD]` foundation**
Across every failed cell its `requested[].happened`, `observedDelta`, and `unrequestedChanges` were accurate and specific. CD's feedback loop and any future orchestrator's per-step verifier already exist — it's Q's adherence check pointed at a step.

**F8 · Compound extraction junk persists outside ADD. `[classifier-fix]` (rides F1's fix)**
"water bottle next" as a target (b-c9), "person s feet" (12:34 log). The legacy extractor's phrase-boundary issues, now with live repro.

**F9 · b-c3 did NOT reproduce the removal-claims-everything bug.** "make her jersey blue and remove the water bottle" routed and landed both. Either C′'s tokenizer fix altered composition or the bug is phrasing-dependent (CC's repro was "remove the ball"). Needs a route() check on both phrasings before the fix-PR spec claims it — cheap, $0.

**F10 · Brand-change decline also catches brand-mark REMOVAL. `[brand-PR scope]`**
"remove the 8 and nike logo" → `brand_change` ASK. The in-flight brand PR should claim removal sentences too (and note "the 8" — a jersey number — rode along with the logo into the decline).

**F11 · QA latency/timeout again.** 69.5s and 64.8s inline runs today, second marks-adjacent slowdown. QA-async PR evidence keeps stacking.

---

## What this means for the two decisions

**D″ / orchestrator: still not decided — but the shape sharpened.**
The naive "model can't do multi-op" claim is false (B-p4/p5, B-c2/c3, and B1/B2 all landed 2-op). The naive "it all works" claim is also false (F3's drops). What exists is a **reliability gradient by combo class**, and the honest next steps are F4's two instruments before any build. If harness runs show add+background failing with a clean prompt at n=2 — that's real D″ evidence. If they pass — F3 is a compiler problem and CD owns it. Adi's proposed design (edits first, background last, single visible result) is consistent with F3's background-wins pattern either way — background last means it can't eat the other edits — and gets recorded as the leading design IF the evidence lands orchestrator-side.

**CD: its problem list grew and got specific.**
Multi-op prompt reliability (F3) with per-class evidence · change-ordering strategy (background-last) · compiled-prompt observability (F4a) · restyle-degree control (F6) · adherence as the feedback loop (F7). CD is no longer speculative — today produced its spec.

---

## Fix list, priority order

| # | Fix | Size | Vehicle |
|---|-----|------|---------|
| 1 | **Compound-ADD composition** — multi-clause sentences with add clauses parse into multi-step intents; D1's surface/spatial rule applies in composition; person guard stops eating place phrases; honest copy where it still ASKs (F1, F2, F8) | M | own PR, next after brand |
| 2 | **Compiled-prompt persistence** — store the compiled instruction on the generation job/asset metadata (F4a) | S | ride fix 1 or QA-async PR |
| 3 | **Harness runs for add-combos + recolor+background** — n=2, guard-safe phrasing, ~$0.85 (F4b) | measurement | CC session, after fix 2 ideally |
| 4 | **QA async + timeout tightening** (F11 + this morning's 45s timeout) | S | own PR, already queued |
| 5 | **Brand PR scope add** — brand-mark removal sentences (F10) | XS | in-flight brand PR |
| 6 | **IMAGE_SAFETY handling** — retry-once + honest user copy; garment-removal policy to Mia (F5) | S | own PR after Mia |
| 7 | **B-c3 vs known-bug reconciliation** — route() both phrasings (F9) | XS | $0, any CC session |
| 8 | **removal-claims-everything fix** — pending F9's answer | S | fix PR with 1 or standalone |

**Mia agenda additions from today:** F5 (garment removal + SAFETY), F6 (the b-c6 exhibit), F10's "the 8" wrinkle (number removal ≠ brand removal?).

**Explicitly NOT decided today:** orchestrator revival. Blocked on fixes 2–3. Part A (chains) remains scheduled and now matters more — if the orchestrator does revive, chaining is its mechanism, and A1's quality data is its feasibility test.

---

## ADDENDUM · THE COMPILED PROMPTS (2026-09-10, same day)

**Source.** The exact prompt each job sent, from `studio_generation_previews.plan->'inputs'->>'prompt'`, joined to the job on `consumed_by_job_id`. The generate route re-renders from that same stored brief, so this is what the model received, not just what was quoted. The query covered every job on this athlete since 2026-09-10: 62 jobs, 11 of them Part B. All 11 ran native. Query and verbatim prompts are at the end. Code references are at dc7bfb4.

**The finding that replaces the others: the classifier has no multi-operation composition.** Every fast-path rule returns one step. A sentence with two different operations routes as whichever rule matches first, and that rule claims every noun phrase in the whole sentence. Rule 1 (remove) turns them all into removal targets. Rule 2 (background) drops everything else and takes its value from the sentence's first prepositional phrase. **No Part B job sent the model two different operations.**

| Cell | Job | Sentence (abridged) | What the model was told | Where the change went |
|------|-----|---------------------|-------------------------|-----------------------|
| B-c1 | `d03eb070` | jersey blue + background stadium | background → "stadium" | Recolor dropped by rule 2 |
| B-c2 | `1ae8803f` | jersey blue + socks red | recolor jersey blue, recolor socks red | Composed: one operation, two targets |
| B-c4 | `f115eefa` | jersey blue + remove cleats | remove jersey, remove cleats | Recolor became "remove the jersey" (rule 1) → IMAGE_SAFETY |
| B-c6 | `7fdbbdab` | remove cleats + background stadium | remove cleats, background, stadium | Background change became two removals (rule 1) |
| B-c10 | `5f5f4a2a` | jersey blue + lightning bolt on socks | design on socks | Recolor dropped by rule 4a |
| B-c11 | `bd9ceaea` | jersey blue + ball at feet + background stadium | background → "her feet" | Recolor and add dropped by rule 2; value from "at her feet" |
| B-c12 | `235d7377` | remove ball + jersey blue + background stadium | remove ball, jersey, background, stadium | Recolor and background became removals (rule 1) → IMAGE_SAFETY |
| B-c14 | `02ab0844` | ball at feet, then background stadium | background → "her feet" | Add dropped by rule 2; same value bug |
| B-p1 | `d320bb2d` | ball at the person's feet + packed stadium at night | background → "person" | Add dropped by rule 2; value stops at the apostrophe |
| B-p4 | `c2c62376` | remove ball + packed stadium at night | remove ball, background, packed stadium | Background change became two removals (rule 1); "night" never reached the model |
| B-p5 | `95ab99ff` | remove ball + jersey blue | remove ball, jersey | Recolor became "remove the jersey" (rule 1) |

**F3 · Re-attributed: the drops are the classifier's, not the compiler's or the model's.**
In all 11 jobs the compiler rendered the frozen intent as written, and every dropped change was lost at the classifier, before compile. B-c2 is the only job that sent more than one change, and both were one operation. **Part B holds no model-tier evidence on one-call multi-op editing, for or against.** The one model-tier signal is obedience: each output tracks its wrong intent. B-c14's "giant-cleats surreal composite" is what "change the background to her feet" asks for.
Why the original inference failed: adherence's `requested[]` is built from `direction.statement`, her raw sentence (`generate.ts` → `qa/adherence.ts`), not from the frozen intent. It correctly answers "did she get what she typed?" but cannot say where a change was lost. F7 stands for what it measures; pair it with `prompt_sent` to localize a drop.
The "reliability gradient by combo class" was a map of rule order:
- "Background usually wins" is rule 2 claiming any sentence without a removal verb.
- "Remove+X composes" is rule 1 turning X into a removal. B-p4 and B-p5 did not compose; they removed.
- "Recolor+recolor composes" is the one multi-change shape the fast path supports: one operation, many targets.
D″ stays undecided, and Part B no longer bears on it.

**F5 · The trigger is "remove the jersey", and the classifier wrote it.**
- Both IMAGE_SAFETY failures compiled "remove the jersey" (B-c4, B-c12). B-c12's sentence never mentions cleats, so "remove the cleats → SAFETY twice" misread it.
- No job without "remove the jersey" hit SAFETY. Cleats (B-c6) and ball removals (B-p4, and `0319f1fc` "remove the ball" earlier the same day) all returned images.
- It wasn't 3 of 3. B-p5 also compiled "remove the jersey" and returned an image: the dark jersey. The cause is deterministic (the removal-claims-everything bug); the provider refused it 2 of 3 times.

There is no SAFETY evidence yet on a correctly classified garment removal, and composition removes the cause. The Mia item changes from "garment-removal SAFETY is nondeterministic" to "we sent 'remove the jersey' three times". Whether "remove the cleats" should run at all is still her call; B-c6 shows that it does.

**F6 · Withdrawn as an exhibit: the model obeyed a bad intent.**
B-c6 was told to remove the cleats, remove the background and remove the stadium. Barefoot, a plain field and the goalpost gone are obedience, and the stadium was never asked for. The kit swap (bra and shorts) is still an unrequested change, but a prompt with three removals, one of them "the background", is not a clean restyle-variance test. Off the Mia agenda.

**F9 · Inverted: the two-target preview WAS the bug.**
B-p5 ("Remove the soccer ball, and make her jersey blue.") froze remove [soccer ball, jersey] and compiled "…and remove the jersey…". No colour word reached the model, so the "weak recolor (blue-ish black)" was its rendering of removing a jersey she is wearing. Two targets in the preview is exactly what the bug looks like, because rule 1 claims every noun phrase in the sentence. B-c3 has no generation job for this athlete in the window, so its "worked" can't be checked against a prompt; on dc7bfb4 its sentence freezes remove [jersey, water bottle]. Fix #7 is answered and fix #8 folds into composition. The composition PR's pins must fail on dc7bfb4:
- `route("make her jersey blue and remove the ball")` → [recolor jersey, remove ball].
- B-p5's sentence compiles with both operations and no "remove the jersey".

**F10 · Dropped from the brand PR's scope.**
Rule 1 (remove) runs before rule 4, so no "remove …" sentence ever reaches 4a or 4c, and the brand PR cannot claim removals. B-c5 asked because rule 1 found no target: digits aren't tokens, and "nike logo" has no determiner of its own (the "the" belongs to "8"). `declineReason` then labels it `brand_change` because a brand word is present, so the B.2 copy fix still stands. Digits in targets and shared-determiner lists are deferred and recorded (composition plan, decision 7). The "the 8" wrinkle is an extraction gap before it is a policy question.

**Also changed.**
- **F1 broadened.** It isn't an ADD-parser gap: the fast path composes no pair of different operations. The fix is a composition layer in `route()` (decided 2026-09-10; lands after the brand PR).
- **F4a resolved.** The compiled prompt was persisted all along; see the query. The caveat: a masked-path job stores only its first crop's prompt.
- **F4b.** The harness is now the only route to model-tier evidence on multi-op, and nothing in Part B confirms or contradicts what it would find.

**Fix list, amended.**

| # | Was | Now |
|---|-----|-----|
| 1 | Compound-ADD composition | Composition for every operation pair: clauses dispatched to the existing rules. Decided; lands after brand. |
| 2 | Compiled-prompt persistence | Already persisted; use the query below |
| 3 | Harness runs | Unchanged; the only model-tier evidence on multi-op |
| 5 | Brand PR scope add | Dropped from the brand PR; B.2's copy fix stands |
| 6 | IMAGE_SAFETY handling | Evidence base changed (F5); re-scope with Mia |
| 7 | B-c3 reconciliation | Answered by B-p5's prompt (F9) |
| 8 | removal-claims-everything fix | Folded into #1, pinned by a test that fails on dc7bfb4 |

**Mia agenda, amended:** F5 reframed as above; F6 withdrawn; F10's "the 8" is an extraction gap first.

### The prompts, verbatim

**B-c1** · `d03eb070-9e1a-4f24-a517-9f3d67d7bcfe` · succeeded

Sentence: "make her jersey blue and change the background to a stadium"

```text
change the background to stadium. Keep the person exactly as-is — change only the background. Keep the original photograph's lighting, exposure, contrast and colour grade exactly as they are.
```

**B-c2** · `1ae8803f-5ce8-482e-8961-2aa8854abafc` · succeeded

Sentence: "make her jersey blue and her socks red"

```text
make the jersey blue, and make the socks red. Keep everything else exactly as-is — change only the jersey and the socks. Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.
```

**B-c4** · `f115eefa-79ea-46e0-9b4c-1d1a592fd4bf` · failed — Vertex returned no image data (finishReason IMAGE_SAFETY)

Sentence: "make her jersey blue and remove the cleats"

```text
remove the jersey and fill the space where it was with what naturally lies behind it, and remove the cleats and fill the space where it was with what naturally lies behind it. Keep everything else exactly as-is — change only the jersey and the cleats. Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.
```

**B-c6** · `7fdbbdab-9f64-40be-ab1c-20df7fa60f08` · succeeded

Sentence: "remove the cleats and change the background to a stadium"

```text
remove the cleats and fill the space where it was with what naturally lies behind it, and remove the background and fill the space where it was with what naturally lies behind it, and remove the stadium and fill the space where it was with what naturally lies behind it. Keep everything else exactly as-is — change only the cleats, the background and the stadium. Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.
```

**B-c10** · `5f5f4a2a-8165-4f7b-a8a4-d28b7fda3c35` · succeeded

Sentence: "make her jersey blue and add a lightning bolt design to her socks"

```text
add lightning bolt design to the socks. Keep everything else exactly as-is — change only the socks. Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.
```

**B-c11** · `bd9ceaea-2978-41f5-9cac-598bd3803d32` · succeeded

Sentence: "make her jersey blue, add a soccer ball at her feet, and change the background to a stadium"

```text
change the background to her feet. Keep the person exactly as-is — change only the background. Keep the original photograph's lighting, exposure, contrast and colour grade exactly as they are.
```

**B-c12** · `235d7377-c2e4-4f3b-9f2b-495dbae643e4` · failed — Vertex returned no image data (finishReason IMAGE_SAFETY)

Sentence: "remove the soccer ball, make her jersey blue, and change the background to a stadium"

```text
remove the soccer ball and fill the space where it was with what naturally lies behind it, and remove the jersey and fill the space where it was with what naturally lies behind it, and remove the background and fill the space where it was with what naturally lies behind it, and remove the stadium and fill the space where it was with what naturally lies behind it. Keep everything else exactly as-is — change only the soccer ball, the jersey, the background and the stadium. Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.
```

**B-c14** · `02ab0844-811e-4a72-9ec8-cabe8dce60da` · succeeded

Sentence: "add a soccer ball at her feet, then change the background to a stadium"

```text
change the background to her feet. Keep the person exactly as-is — change only the background. Keep the original photograph's lighting, exposure, contrast and colour grade exactly as they are.
```

**B-p1** · `d320bb2d-d586-4280-815f-23e8a6218978` · succeeded

Sentence: "Add a soccer ball at the person's feet, and change the background to a packed stadium at night."

```text
change the background to person. Keep the person exactly as-is — change only the background. Keep the original photograph's lighting, exposure, contrast and colour grade exactly as they are.
```

**B-p4** · `c2c62376-a772-41e3-be14-cd511febda0b` · succeeded

Sentence: "Remove the soccer ball, and change the background to a packed stadium at night."

```text
remove the soccer ball and fill the space where it was with what naturally lies behind it, and remove the background and fill the space where it was with what naturally lies behind it, and remove the packed stadium and fill the space where it was with what naturally lies behind it. Keep everything else exactly as-is — change only the soccer ball, the background and the packed stadium. Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.
```

**B-p5** · `95ab99ff-b85f-4bd8-b851-029d51e0b865` · succeeded

Sentence: "Remove the soccer ball, and make her jersey blue."

```text
remove the soccer ball and fill the space where it was with what naturally lies behind it, and remove the jersey and fill the space where it was with what naturally lies behind it. Keep everything else exactly as-is — change only the soccer ball and the jersey. Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.
```

### The query

Read-only, scoped to the athlete who owns `bd9ceaea`. Run through the Cloud SQL Auth Proxy. The date filter uses the database session's timezone.

```sql
SELECT j.id AS job_id, j.status, j.last_error,
       j.brief->'job'->'editIntent' IS NOT NULL AS native,
       j.brief->'job'->'editIntent'->'changes' AS frozen_changes,
       p.plan->'inputs'->>'prompt' AS prompt_sent,
       j.brief->'job'->'direction'->>'statement' AS sentence
FROM generation_jobs j
JOIN studio_generation_previews p
  ON p.consumed_by_job_id = j.id AND p.athlete_id = j.athlete_id
WHERE j.athlete_id = (SELECT athlete_id FROM generation_jobs WHERE id = 'bd9ceaea-2978-41f5-9cac-598bd3803d32')
  AND j.created_at >= '2026-09-10'
ORDER BY j.created_at;
```
