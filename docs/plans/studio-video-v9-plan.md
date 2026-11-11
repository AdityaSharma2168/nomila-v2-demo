# Video V9 — i2v/t2v segment generation + per-frame QA

**Step 1 only: recon + plan. Nothing built, no branch, no worktree, $0 spent.**
Recon done 2026-09-19 against `origin/main` @ `801c42f`. Every claim below is cited to a file, a
commit, a probe result or an invoice in this repo.

---

## 0. Base state — V8 IS landed, and my local main was stale

|                |                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin/main`  | `801c42f` — "Merge pull request #529 from nomila-co/studio-video-v8"                                                                                                |
| V8 client half | **#529 MERGED** (reorder, drag, player, MuteToggle, library play)                                                                                                   |
| V8 server half | **#525 MERGED** as `bfa335c` — migration `0058_media_assets_duration_precise.sql` is on main, `media_assets.duration_seconds_precise` is in `shared/schema.ts:1492` |
| local `main`   | was `2ab0cf5`, two merges behind — fetched, not pulled (working tree has `M package-lock.json`)                                                                     |

So the card's premise holds. The worktree in step 2 must be cut off `801c42f` or later, not off my
stale local main. Nothing else on the ladder is outstanding: V1–V7 are all ancestors of main
(`git branch --merged main`).

---

## 1. The generation job path — what V9 reuses, what it adds

### 1.1 How a `video.generate` job flows today

```
POST /studio/generate
  └─ routes/studio.ts        deliverable ∈ {clip, reel} → task "video.generate"   (:234, :274)
  └─ runStudioGeneration     generate.ts
       1. previewGeneration(brief)          → plan { task, provider, model }, cost, references
       2. assertVideoEnabled(task)          ← THE FLAG. STUDIO_VIDEO_ENABLED, default off (:169)
       3. assertSpendWithinCaps(...)        ← approved / maxJob / maxDay, spendCaps.ts
       4. createGenerationJob(preview)      ← row INSERT: provider, model, frozen brief, quote
       5. consumePreview(...)               ← THE APPROVAL, claimed exactly once
       4a. queueJob(job.id)                 ← pending → queued, and the request RETURNS
                                              { jobId, spent: true, queued: true, assets: [] }
```

Then, off a Cloud Scheduler tick at `/api/internal/studio-video-tick`, under the advisory lock:

```
videoTick()                    videoRunner.ts, DEFAULT_BATCH = 2
  ├─ reapExpiredLeases()       orphan → fail closed · exhausted → fail · else requeue WITH handle
  ├─ claimVideoJobs(n)         UPDATE ... FOR UPDATE SKIP LOCKED, lease_until, attempts += 1
  └─ workJob(job) for each
       ├─ videoAdapterFor(job) ← provider + model OFF THE ROW, never from config
       ├─ inputsFor(job)       ← plannedInputs() re-derived from the FROZEN brief
       ├─ recordSubmitAttempt  ← guarded on holder; false ⇒ stand down without spending
       ├─ adapter.video.submit → operation handle
       ├─ recordOperationName  ← guarded on IS NULL; false ⇒ our operation is leaked, do not poll
       ├─ adapter.video.poll   → assets
       ├─ storeAsset + recordGeneratedAsset(mediaType: "VIDEO")
       └─ succeedJob · clearLease
```

That is a complete, correct, merged execution model. **V9 adds nothing to it.**

### 1.2 What V9 actually adds

Three things, all upstream or downstream of the loop above, none inside it:

1. **Upstream (preview):** a shot type, a model chosen from it, and a validated prompt — all
   resolved inside `previewGeneration`, so they land on the job row at `createGenerationJob` and
   the runner keeps reading the row exactly as it does now. §4, §5.
2. **Downstream (runner):** a per-frame QA stage after the job is terminal. §3.
3. **A recorded re-roll recommendation** that nothing acts on. §3.4.

### 1.3 How a generated segment becomes a timeline clip

It already does, with no code. Verified end to end:

| step            | mechanism                                                                                                               | verified                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| the row         | `recordGeneratedAsset` inserts `origin:'generated'`, `media_type:'VIDEO'`, `status:'stored'`, `approval_status:'draft'` | `jobs.ts:232`                  |
| the poster      | `processPosterBatch` selects `origin IN ('upload','generated') AND media_type='VIDEO' AND gcs_thumb_path IS NULL`       | `videoPoster.ts`               |
| the real length | the same poster UPDATE writes `duration_seconds_precise` from ffprobe                                                   | `videoPoster.ts:113` (V8/#525) |
| the picker      | `GET /media?type=videos` filters on `media_type` only — **origin-agnostic**                                             | `routes/media.ts:101`          |
| the timeline    | `TimelineEntry { assetId, trimStartSec?, trimEndSec? }` — an id, nothing about where it came from                       | `video/materialize.ts:206`     |
| the stitch      | `resolveClips` filters on athlete + `deleted_at IS NULL` + `status='stored'` — **not on `approval_status`**             | `materialize.ts:253`           |

That is V4's source-agnostic entry model working as designed. A generated segment is a timeline
clip the moment the poster cron has touched it.

**Two real seams, neither a blocker, both worth writing down:**

- ⚠️ **A fresh generated clip sorts to the LAST page of the picker.** The media list keysets on
  `(posted_at DESC, id DESC)` and `recordGeneratedAsset` never sets `posted_at` — `routes/media.ts:108`
  calls the null tail "a v1 simplification (falls to the last page)". So the clip she just paid for
  is the hardest one in her library to find. This is outside V9's own code (it is `jobs.ts` +
  `routes/media.ts`, shared with every image generate). **Proposal, not a change:** set
  `posted_at = now()` on a generated row, or order by `coalesce(posted_at, ingested_at)`. Blast
  radius of the first: one column on new rows only, read by one ORDER BY. Adi raises it with Mia.
- **The poster cron is the only thing that fills `duration_seconds_precise` for a generated clip**,
  and it runs on its own schedule. Until it does, `effectiveSeconds` falls back to
  `bytes / videoBytesPerSecond()` — the one guess in `materialize.ts`, which its own docstring says
  can under-count badly. Not V9's to fix; V9's QA stage probes the clip anyway (§3.2), so if we
  want it sooner the measurement is free at that point. Flagged as a decision, not taken.

---

## 2. Per-frame QA — what transfers, and what does not

### 2.1 The stage as it exists

`inspectAsset` (qa/inspect.ts) resolves lineage, fetches bytes, and runs one of two paths:

|           | `runCreativeQa(pair)` — an EDIT                  | `runGenerateQa(subject)` — a GENERATE |
| --------- | ------------------------------------------------ | ------------------------------------- |
| input     | source + output bytes                            | one image                             |
| identity  | `checkIdentity` — face crop → embedding distance | `unknown` (no source)                 |
| marks     | `checkMarks` — arrived / vanished / redrawn      | `unknown`                             |
| anatomy   | `checkAnatomy` — **reads `outputBytes` only**    | runs                                  |
| adherence | `checkAdherence` — change vs instruction         | `unknown`                             |
| text      | `checkText` — a person's name on the kit         | runs                                  |

Verdict: worst of GATING (`identity, anatomy, adherence, text`); `marks` is ADVISORY (27%
specificity on the 36-row corpus); `unknown` is counted, never folded into a pass. Written to
`media_assets.metadata.creative_qa` behind `STUDIO_CREATIVE_QA`, default off. It **gates nothing**,
and verdict.ts says so as a contract, not a phase.

### 2.2 What transfers to a video frame — directly

A frame is a JPEG. Every check takes bytes. So:

| check         | transfers?                            | how                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **anatomy**   | ✅ **directly, unchanged**            | it already reads only `outputBytes`; `runGenerateQa` already passes the output as both halves and explains why. The three-hands case is a per-frame question by nature.                                                                                        |
| **text**      | ✅ **directly, unchanged**            | 6/6 caught, 0/10 false on the 2026-09-15 probe. A Veo clip re-renders the kit every frame, so the McLAUGHLIN class is _more_ likely in motion, not less.                                                                                                       |
| **marks**     | ✅ transfers, ⚠️ stays ADVISORY       | frame t vs frame 0 is exactly a `ComparisonPair`. This is the check for the 2026-09-07 spike's Nike swoosh fading in on adidas kit by ~2.5s — the one video defect anybody has actually seen. But it is 27% specific and must not move into GATING on arrival. |
| **adherence** | ⚠️ needs adapting                     | it scores _the change_ against _her instruction_. Within one clip the "change" is motion, and her instruction is now a shot-type template (§5), not a free sentence. Per-clip rather than per-frame, and honestly `unknown` in V9.                             |
| **identity**  | 🔴 **does not transfer as a verdict** | §2.3.                                                                                                                                                                                                                                                          |

### 2.3 🔴 The identity ruler is dead, and this is the finding that shapes the whole card

`checkIdentity` returns a cosine distance from `multimodalembedding@001` over face crops. That
instrument **failed its stranger control on 2026-09-15**: an invented person scored **0.3584**
against her held-out photographs, _inside_ her own same-person band (**0.3158–0.4186**).
`qa/identity.ts:217` carries `DEAD_RULER_CAVEAT` verbatim and the generate path already records the
number as an observation with the caveat riding inside the jsonb. The bake-off's own `driftCurve`
docstring says the same thing from the other side: _"a clip that pans scores a large drift and may
hold identity perfectly; a clip that holds still and swaps her face scores a small one."_

So: **V9 may not write a bar in this metric, per-frame or otherwise.** Doing it per-frame would
make the same unusable number 5× as expensive.

**But there is one genuinely new question the dead ruler might survive, and V9 should ask it as a
hypothesis rather than assume it.** The ruler died on a _cross-photograph_ comparison, where
lighting, pose, framing and camera all vary — which is exactly why it tracks framing rather than
faces. A _within-clip_ comparison holds all of those constant by construction: frame t and frame 0
are the same camera, same light, same scene, seconds apart. That is a different measurement, and it
is the only setting in which this instrument has a chance.

**It needs its own control before any bar is written**, and the control is **$0** (§6.2): score a
frame from a _different clip of a different subject_ against t0 and check it lands clearly above
her own within-clip band. If it does not, within-clip identity is recorded as an observation with
the caveat and nothing more — same posture the generate path already takes. V9 ships correct either
way; only the _gating_ question depends on the answer.

### 2.4 The sampling strategy — adaptive, not a fixed grid

A 6s Veo clip at 24fps is 145 frames. Running the five checks on all of them is ~700 Gemini Flash
calls against a $1.20 generation. Nobody is proposing that. The question is _which_ frames, and the
answer is **not** first/mid/last.

**Tier 1 — dense, every frame, $0, no model call.**
Extract a strip with ffmpeg and compute the **drift curve**: mean absolute greyscale pixel
difference at 180×320 between frame 0 and each later frame. This instrument already exists and is
already validated — `studioVideoBakeoff.ts:681 driftCurve()`, and its numbers are in the V2b table:

| cell           | frame-change vs t0 |
| -------------- | ------------------ |
| `easy-veo-3.1` | 0.035 · 0.031      |
| `med-veo-3.1`  | 0.087 · 0.166      |
| `hard-veo-3.1` | **0.199** · 0.163  |

The hard cell's 0.199 at t=2 is the largest in the set and is _consistent with the clip actually
performing the turn_. That is the curve doing its job: it does not know whether the turn was good,
it knows where to look.

**Tier 2 — sparse, paid, pointed by tier 1.**
Run the checks on frames selected _from the curve_, not from the clock:

```
t0                  the anchor. Always. It is the i2v first frame, so it is also the
                    thing the clip is supposed to still be.
argmax(curve)       where the clip is most different from its anchor. This is the frame
                    a fixed grid misses: on hard-veo it is t=2, not the midpoint.
t_last              where it ends up. Continuity into the next segment depends on it,
                    and a stitch makes clip N's last frame clip N+1's neighbour.
```

Three frames, default, env-overridable. Against the existing checks that is **~9 vision calls +
2 embed calls ≈ $0.01–0.02** per clip against a $1.20 generation — roughly the ratio the image
stage already runs at ($0.0212 on a $0.1344 generation).

**Why argmax beats a grid, stated plainly:** a fixed first/mid/last spends exactly the same money
and looks in the wrong place. On `hard-veo` the mid-point is t=3 and the peak is t=2. On a clip
whose defect is the 2.5s swoosh, a 6s clip's midpoint is t=3 — past it.

**What this deliberately does NOT catch, written down rather than discovered later:** a _transient_
defect between samples. Three hands for six frames at t=1.4 is invisible to a three-frame sample,
and no honest amount of money makes it visible. The verdict must say `sampled: 3 of 145` on the
record so nobody ever reads "anatomy: pass" as "no frame had three hands". That is the same
discipline `unknown` exists for.

**The cheap escalation, if it earns it:** the curve is dense, so a _second_ peak well separated from
the first is detectable for $0. Sampling 3 frames by default and up to 5 when the curve has two
distinct peaks is a knob, not a redesign. Not in V9's first cut.

### 2.5 Where it lives

`server/studio/qa/` is shared with the image path and a change there has blast radius. So V9 adds a
**composer**, not a modification:

```
server/studio/video/frames.ts      extract a strip + drift curve + pick the sample (pure + ffmpeg, $0)
server/studio/qa/videoClip.ts      run the existing checks over the sample, aggregate to a clip verdict
```

Not one line changes inside `anatomy.ts`, `text.ts`, `marks.ts`, `identity.ts`, `vision.ts` or
`cost.ts`. `verdict.ts` grows a `subject: "clip"` arm beside `"edit"` and `"generate"`, and
`QA_SCHEMA_VERSION` goes to **6**.

### 2.6 ⚠️ Where the stage runs in the runner, and why it is after `succeedJob`

Non-obvious and load-bearing. The image path awaits QA _before_ `succeedJob`, so the verdict is on
the record by the time the asset is. **Video must do the opposite.**

`reapExpiredLeases` requeues on `status='running' AND lease_until < now()`. Between `poll` returning
and `succeedJob`, the job is still `running` and the lease is only renewed on poll progress. Today
that window is milliseconds. A 90s QA stage inside it — on top of a poll that may already have run
most of `leaseMs()` (≥180s) — would let the lease lapse, the reaper requeue, and the next runner
**resume polling the same operation and record every asset a second time.**

So: `storeAsset → recordGeneratedAsset → succeedJob → clearLease → THEN QA`. Once status is
`succeeded` the reaper's predicate excludes the row regardless of the lease, so the QA stage cannot
be interrupted by it. Cost: the client can see `succeeded` one poll before the verdict lands, which
is fine — the client is already polling. Revert check: a test that pins the ordering by name.

---

## 3. The fail / re-roll loop

### 3.1 The rules this codebase has already written

1. _"A failed job stays failed. Re-running is a NEW job with its own row and its own cost line."_ —
   `jobs.ts:174`.
2. _"the approval is consumed before the call on purpose (it is the double-tap guard) … a retry was
   a fresh approval at the full quote"_ — `generate.ts:910`.
3. _"a re-run is a new check and a new cost line — never a silent retry against the same
   approval"_ — `generate.ts:1437`.
4. _"nothing here blocks, retries, or downgrades an approval. Enforcement is a later flag at a
   DIFFERENT call site, and deliberately not an evolution of this line"_ — `generate.ts:1405`.

### 3.2 The decisive fact — the day cap would go blind

`spentTodayUsd` sums `cost_estimated_usd` over `generation_jobs`, and the quote is **banked at
INSERT** (`createGenerationJob`). A re-roll that reused the same job row would spend a second $1.20
that the rolling 24h ceiling never sees. That is not a policy preference; it is the one failure mode
`day-cap-is-a-quote-ceiling` exists to prevent.

And `generation_jobs.attempts` cannot be borrowed for it: it is the **lease** counter, incremented
at claim, bounded by `maxAttempts()`. A re-roll that incremented it would move a clip toward
"Gave up after 5 attempts" for having been _re-rolled_, which conflates "the instance died" with
"the clip was bad".

### 3.3 Card 5 part 2 — the parked decisions, and where they land

`docs/probes/wave-d.md:147` parked exactly this, in these words:

> Not built, and not absorbed:
> — **the anatomy-retry** — a generate-path change that doubles spend on a failing cell;
> — the note on a refused large object — needs its own ask copy (Mia's pile);
> — C8 `add my product to my hand` stays `person_target`.

The anatomy-retry is the card that lands here. The other two are image-path and stay parked.

### 3.4 My recommendation: **V9 records the decision, it does not take it**

When the clip verdict is `fail`, `workJob` writes a **re-roll recommendation** beside the verdict —
structured, with the shot type, the failing checks, the frames they failed at, and **the quote for
what a re-roll would cost** — and does nothing else. No provider call, no new row, no retry.

A re-roll is then a **new preview → new approval → new job row**, initiated from the client. That is
the only shape in which:

- the approval rule holds (rules 1–3 above);
- the day cap sees the money (§3.2);
- "whose money pays" has an answer she agreed to, at a figure she saw;
- V9 stays entirely dark-testable — the decision is a pure function of a verdict.

What V9 buys her that she does not have today: **the verdict is on the record before she is looking
at the clip**, so the surface can say _"this one came back wrong — anatomy failed at t=2. Try
again for $1.20?"_ instead of her finding out by watching it.

**The alternative, stated so you can overrule me.** Auto-re-roll once, inside the runner, bounded by
a new `reroll_count`, with the second quote banked as its own row. It is buildable and it is not
crazy — a bad clip is a worse experience than a slow one. I am not recommending it for V9 because
it puts a paid provider call behind a QA stage that **has never run on a video** and whose identity
half is on a dead ruler, and because the honest failure mode is doubling spend on the cells that
fail _most often_. Measure first, gate later — the same sequencing `verdict.ts` argues for and the
same one that kept `marks` out of GATING.

**Decision for Adi:** record-only (my recommendation) · or auto-re-roll once behind its own flag.

---

## 4. Shot-type routing

### 4.1 The constraint set, from invoices and refusals

| model                 | i2v on a real person                                                                                               | $/s (no audio) | 6s      | source                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------- | ------- | ----------------------------------------------------- |
| **veo-3.1** (Vertex)  | ✅ held identity **3/3** at every difficulty incl. the turn                                                        | $0.2000        | $1.2000 | V2b                                                   |
| **seedance-2.0-fast** | 🔴 **structurally refused, 6/6** — `InputImageSensitiveContentDetected.PrivacyInformation`, stated BytePlus policy | $0.0914        | $0.5481 | V2                                                    |
| **kling-v3.0-std**    | ✅ accepted **5/5** across 4 photographs, incl. two EXIF-8 frames Seedance refused                                 | $0.0840        | $0.5040 | kling-moderation, run 2026-09-19, `basis: "reported"` |

So "seedance-fast owns b-roll" is **not a preference — it is the only category it can enter**. And
Kling is 58% cheaper than Veo on identity work, with acceptance evidence but no identity _quality_
evidence (the moderation probe explicitly scored nothing).

### 4.2 Where the choice has to be made

`routes()` gives exactly one model per task. The runner reads `provider` + `model` **off the row**
and `videoRunner.ts` is emphatic about why (_"Config answers 'what would we do now'; the row answers
'what did we commit to then'"_). `createGenerationJob` writes both off `preview.plan`.

Therefore the shot type must be resolved **inside `previewGeneration`**, before the row exists.
Anywhere else breaks the read-the-row invariant. This is the one structural constraint on the whole
feature.

### 4.3 My read: **inferred from a fact we already hold — not picked from a menu, not guessed by a model**

The fact is: **does this brief carry a person reference?** `referencesFor` already emits typed
references with `role: "person"` → `slot: "character"`. A segment carrying one is an identity shot;
one carrying none is b-roll. That is structural, server-side, derived from the same object the quote
is derived from — so the routing and the price agree by construction, which is what this codebase
demands everywhere else (`imageSizeParams`, `editImageSizeFor`, the frozen tier).

```
shotTypeFor(brief) →  "identity"  when a person reference is planned
                      "broll"     when none is
```

It also prevents both bad outcomes on its own: a person-referenced segment sent to Seedance is a
refusal at submission, and a b-roll segment sent to Veo costs 2.2× for a clip with no face in it.

**Derived, not stored.** No new field on `CreativeBrief`, no change to `shared/schema.ts`, no
migration. If inference later proves wrong, a stored field is an additive change made then, with
evidence — not now, on a guess. This is "prefer extending what exists".

**What is NOT inferred, and stays a config decision:** identity → **Veo or Kling**. V9 pins Veo
(`MODELS.veo`, the current route, 3/3 measured quality) and makes the Kling arm reachable by env,
because Kling has acceptance evidence and _zero_ quality evidence. Swapping the default is a
separate, paid, measured card — not a $0.696/clip saving taken on faith.

**Decision for Adi:** confirm inference-from-references over an explicit picker. A product-facing
"a clip of me" vs "a cutaway" control can sit _on top_ of the inference later; it is not needed to
make the engine correct, and adding it now means a brief field and a client surface neither of which
V9's card asks for.

---

## 5. 🔴 The prompt library — this is not optional, it is a live defect

### 5.1 What the product path sends to Veo today

`plannedInputs` builds a video brief's prompt with `buildPrompt(brief, references, crop)` — the
**image** prompt builder. There is no video branch in it anywhere. Its generate arm, verbatim
(`preview.ts:596`):

> _"Generate a single photorealistic **photograph** of an athlete. Output an **IMAGE**, not text or a
> caption. Do not describe or plan the shot; render it…"_

**If `STUDIO_VIDEO_ENABLED` were flipped today, the first real clip in this product would be
generated from a sentence asking for a still photograph, with no motion beat, no camera direction
and no preservation clause.** Nothing would error. It would just come back bad, and V2's most
expensive lesson — _a bad prompt reads as a bad model_ — would be re-learned at $1.20 a cell.

### 5.2 The prompts that actually worked are in a throwaway script

The sentences behind V2b's 3/3 identity hold live in `server/scripts/studioVideoBakeoff.ts`, which
nothing imports and which the bake-off write-up explicitly calls **throwaway**:

| id         | shot type       | the beat                                                                                                                                                               |
| ---------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `i2`       | identity-static | _"She looks up from her boot into the camera and breaks into a smile. **Minimal camera movement**, natural daylight, her kit and the field behind her **unchanged**."_ |
| `i1`       | identity-pose   | _"She finishes tying her boot, stands up and looks into the camera. Handheld, natural daylight, her kit and the field behind her unchanged."_                          |
| `i3`       | identity-turn   | _"She turns and walks a few steps away from the camera, then looks back over her shoulder…"_                                                                           |
| `b1/b2/b3` | b-roll-no-marks | _"…**No people, no text, no signage.**"_                                                                                                                               |

Note what every one of them carries that `buildPrompt` does not: a **motion beat**, a **camera
instruction**, and an explicit **"unchanged"** preservation clause — the exact device `buildPrompt`'s
own edit arm credits for working (_"the long prompt SAID the preservation out loud"_).

And note the V2 correction: the `easy` cell failed because _"the prompt asked her to 'look up from
her boot' from a frame in which she is already looking up"_. **A prompt that disagrees with its frame
voids the cell.** That is a property the library must enforce, not a caveat to remember.

### 5.3 The proposal

`server/studio/video/prompts.ts` — a small, **closed**, validated set, shaped exactly like
`compile/templates.ts`: a shot type selects a template, her direction is the variable, the output is
**byte-pinned by goldens** the way `compile.golden.json` pins 36 image prompts.

| template                   | shot type | routes to         | status                              |
| -------------------------- | --------- | ----------------- | ----------------------------------- |
| `identity-static`          | identity  | Veo               | ✅ from `i2` — measured 3/3         |
| `identity-pose`            | identity  | Veo               | ✅ from `i1`                        |
| `broll-no-marks`           | broll     | seedance-2.0-fast | ✅ from `b1/b2/b3`                  |
| `identity-turn-first-last` | identity  | —                 | 🔴 **cannot ship in V9, see below** |

**Freeform is a refusal, not a fallback** — the same rule `parseStitchSpec` applies to `target` and
`bed`: a name off the wire, never an expansion. A brief that cannot be matched to a template is a
blocker with a message, not a clip generated from the photograph prompt.

### 5.4 ⚠️ Why the turn template cannot ship, and it is a one-line gap

`GenerationInputs.lastFrame` exists (`types.ts`), and the **OpenRouter** adapter consumes it
correctly — `videoImageFields` builds `frame_images` with `frame_type: "first_frame" | "last_frame"`
(V5, commit `8be9c6a`). **Vertex's `submitVideoOperation` never sends it.** It builds
`instances[0] = { prompt, image }` and stops (`vertex.ts:247`). Veo 3.1 takes a last frame; we do
not pass one.

So the turn template would have to route to OpenRouter-Kling to work at all — and frame-chaining /
first-last is **explicitly out of scope for V9** (parked, V10). The library therefore ships **three**
templates and the fourth is written down with the gap named. Wiring `lastFrame` on the Vertex arm is
a small, additive, clearly-scoped change that belongs to whichever card owns first/last.

---

## 6. Dark vs paid — the split

### 6.1 Dark, $0, `STUDIO_VIDEO_ENABLED` off

Everything architectural:

| area                                                                       | testable with                                                                                                  | harness                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `shotTypeFor(brief)`                                                       | pure function over frozen briefs                                                                               | jest, no DB                   |
| routing → provider/model on the row                                        | a queued job's row                                                                                             | PGlite                        |
| prompt selection + compiled text                                           | **goldens**, byte-pinned                                                                                       | `compile.golden.json` pattern |
| prompt-agrees-with-frame refusal                                           | fixture briefs                                                                                                 | jest                          |
| frame extraction + drift curve                                             | **a synthetic mp4 built by ffmpeg** (`testsrc`) — never a real clip; `CLAUDE.local.md`: all fixtures synthetic | jest                          |
| adaptive sample selection                                                  | pure function over a curve                                                                                     | jest                          |
| clip-verdict aggregation                                                   | the vision calls stubbed, exactly as every existing QA suite does                                              | jest                          |
| re-roll decision + its quote                                               | pure function over a verdict                                                                                   | jest                          |
| runner wiring: QA runs, verdict recorded, **nothing gated**                | claimed job → asset → verdict in metadata                                                                      | PGlite                        |
| **the ordering pin of §2.6** (QA strictly after `succeedJob`/`clearLease`) | a revert check that reds by name                                                                               | PGlite                        |
| tenancy on every new read                                                  | a foreign athlete's asset is not found                                                                         | PGlite                        |

### 6.2 ✅ The validation that looks paid and is actually free — **36 real clips are already on disk**

This is the best thing in the recon. The corpus exists, is paid for, and is local:

```
nomila-v2-worktrees/video-v2/probe-out/video-v2b/        3 Veo clips (easy/med/hard) + t0/t2/t4 strips
                                        .../video-bakeoff/  i2 i3 b1 b2 b3 + 12 blind clips + key.json
nomila-v2-worktrees/kling-probe/probe-out/kling-first-last/  5 Kling incl. k5-control-unanchored
                                        .../veo-headtohead/  3 Veo
                                                              36 .mp4 total, with results JSON
```

Against that corpus, at **$0**, with no flag and no key:

- **the drift curve reproduces V2b's published numbers** (0.035/0.031 · 0.087/0.166 · 0.199/0.163) — a
  direct check that the instrument I move into the product computes what the throwaway one did;
- **the adaptive sampler is validated** — does argmax land on the turn in `hard-veo`, where a fixed
  midpoint does not;
- **the marks check is aimed at a known positive** — the 2026-09-07 swoosh-on-adidas clip is the one
  real video defect on record;
- **the within-clip identity hypothesis gets its control** (§2.3) — `k5-control-unanchored` and the
  12 blind clips give cross-subject frames to score against t0. **If the control fails, no bar is
  written, and we learn that for nothing.**

Follows the existing precedent exactly: `qa-fixtures/` + `labeledSet.ts` + `corpus.ts`. The clips are
**real footage of a real athlete**, so they are a _local validation corpus read by a script_, never a
committed jest fixture, and no id, frame or verdict text containing personal data goes into the repo.
`.gitignore:49` already covers `probe-out/*`.

### 6.3 Paid — flag on, funded key, your explicit go, capped, dry-run first

Only two questions genuinely need new spend, and both are small:

| #   | question                                                                                                                                                                                    | cells                                  | est.                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------- |
| P1  | Does a clip generated from the **product prompt** (new library) hold identity as well as the **probe prompt** did? Same frame, same model, same duration — the prompt is the only variable. | 2 Veo identity cells                   | 2 × $1.20 = **$2.40** |
| P2  | Does the stage catch a **real, fresh** drift end to end through the runner — submit, poll, store, sample, verdict?                                                                          | 1 Veo cell, deliberately the hard turn | **$1.20**             |

**≈ $3.60, one cap, dry-run first, same discipline as every probe this session.** P1 is the one that
matters: it is the only way to know whether §5 fixed a live defect or moved it. P2 is an end-to-end
smoke test, and if the corpus work in §6.2 has already gone green it is confirmation rather than
discovery.

Not fired without your go. Predictions written and committed before the run, misses reported.

---

## 7. DDL

**V9 needs no migration.** Checked, and it is a deliberate design outcome rather than luck:

- the clip verdict goes to `media_assets.metadata.creative_qa` — an existing jsonb namespace keyed
  by producer, with `QA_SCHEMA_VERSION` bumped 5 → 6 so a stored verdict stays interpretable
  (`qa/record.ts` argues this at length: _"the cheaper correct option is the one that needs no DDL at all"_);
- the re-roll recommendation rides in the same verdict object;
- shot type and model are already columns — `generation_jobs.provider` / `.model`;
- re-roll count is **not** a column, because V9 does not auto-re-roll (§3.4).

If you choose auto-re-roll instead, that _does_ need `generation_jobs.reroll_count` plus a
`reroll_of_job_id` pointer — additive, nullable, the `0058` pattern (migration line + `schema.ts` in
ONE commit, name-only drift gate, additive beats widening). I would rather not, and I would rather
know before building than after.

---

## 8. Files V9 would touch

**New:**

```
server/studio/video/prompts.ts            the closed template set + selection        (+ prompts.test.ts, goldens)
server/studio/video/shotType.ts           shotTypeFor(brief) — derived, not stored   (+ .test.ts)
server/studio/video/frames.ts             ffmpeg strip + drift curve + sampler       (+ .test.ts, synthetic mp4)
server/studio/qa/videoClip.ts             compose existing checks over a sample      (+ .test.ts)
server/studio/video/reroll.ts             verdict → recommendation + quote (pure)    (+ .test.ts)
server/scripts/studioVideoQaCorpus.ts     $0 validation over the 36 on-disk clips (throwaway, nothing imports it)
docs/probes/video-v9-predictions.md       predictions, written before anything runs
```

**Modified — small, and named so the diff has no surprises:**

```
server/studio/preview.ts       buildPrompt gains a VIDEO arm that delegates to prompts.ts;
                               plannedInputs resolves provider/model from the shot type
server/studio/config.ts        a per-shot-type route beside routes(); MODELS unchanged
server/studio/videoRunner.ts   the QA stage, AFTER succeedJob/clearLease (§2.6)
server/studio/qa/verdict.ts    a `subject: "clip"` arm; QA_SCHEMA_VERSION 5 → 6
```

**Not touched:** `shared/schema.ts`, `migrations/`, `qa/{identity,anatomy,marks,text,vision,cost}.ts`,
`videoJobs.ts`, the adapters, `stitchJobs.ts`, `stitchRunner.ts`, `video/{stitch,plan,materialize,spec}.ts`,
any client file, `.github/workflows/**`, `gcp/**`.

---

## 9. What I need signed off before building

| #     | decision                                                                                                                                                                                                               | my recommendation |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **1** | **Re-roll: record-only, or auto-re-roll once?** Record-only keeps the approval rule and the day cap intact and needs no DDL. Auto costs a migration and puts a paid call behind a stage that has never run on a video. | **Record-only**   |
| **2** | **Shot type inferred from the person reference**, not a picker and not a model. No brief field, no schema change.                                                                                                      | **Inferred**      |
| **3** | **Identity stays an OBSERVATION per-frame** — no bar in the dead ruler. The within-clip control runs first, at $0, and only a clean control reopens the gating question.                                               | **Observation**   |
| **4** | **The prompt library is in scope and is a blocker**, not a nice-to-have — §5.1 is a live defect on the product path. Three templates ship; the turn one is written down with the `lastFrame` gap named.                | **In scope**      |
| **5** | **`argmax(drift)` + t0 + t_last**, three frames, not a fixed grid — and the verdict records `sampled: 3 of N` so a pass never reads as "every frame was clean".                                                        | **Adaptive**      |
| **6** | **Paid testing is ≈$3.60 / 3 cells** (P1 ×2, P2 ×1), dry-run first, your go, one cap. Everything else validates at $0 against the 36 clips already on disk.                                                            | **$3.60 cap**     |
| **7** | Two out-of-scope seams **proposed, not taken**: generated clips sort last in the picker (`posted_at` never set), and Vertex never sends `lastFrame`. Both are Mia's to rule on.                                        | **Proposal only** |

Nothing is built. No branch, no worktree, no commit, no push. Waiting on your sign-off.

---

---

# Part II — Build order

**Approved 2026-09-19.** Worktree `/Users/adi/nomila-v2-worktrees/video-v9`, branch
`studio-video-v9`, cut off `origin/main` @ **`801c42f`** (`main` was fetched not pulled — the
primary checkout still carries `M package-lock.json`). `0058` is present. No commits yet.

Four sign-offs taken as given and not re-argued: **record-only re-roll · three-way inferred routing ·
QA after `succeedJob` · the prompt library is a blocker.** Everything below is the order they get
built in, what each commit predicts, and the revert check that must red by name if it is undone.

---

## 0. Five new facts found while planning the build

These were not in the recon and three of them change the commit ladder.

### 0.1 ✅ ffmpeg 9.0.1 is on this laptop, and `lavfi` works

`/opt/homebrew/bin/ffmpeg`, with `testsrc` and the `concat` **filter**. Measured just now:

| step                                      | time      |
| ----------------------------------------- | --------- |
| build a 6s 180×320 h264 clip from `lavfi` | **54 ms** |
| extract 3 frames                          | **75 ms** |
| `ffprobe -show_streams`                   | **18 ms** |

So `frames.ts` is tested against a **synthetic mp4 built inside the test**, at ~150 ms. No binary
fixture is committed, no personal data is involved, and the input is deterministic. The V2 bake-off's
note that _"ffmpeg is in the Dockerfile but not on this laptop"_ is stale.

⚠️ The **concat FILTER**, never the concat demuxer — [[video-v6-stitch-build]]: the demuxer corrupts
at exit 0. Verified working:

```
-f lavfi -i "color=c=black:s=180x320:d=3:r=24" -f lavfi -i "color=c=white:s=180x320:d=3:r=24"
-filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[v]" -map "[v]"
   → YAVG  t=0:0  t=2:0  t=4:255  t=5:255
```

### 0.2 ✅ The 5 s jest ceiling is gone — `testTimeout: 120_000` is live

`jest.config.cjs:63`, top level, since `73d3b84` (V7, on main). My memory said 5 s repo-wide; that
was the bug that commit fixed. Updated. The ffmpeg-in-jest plan is not marginal.

### 0.3 🔴 **b-roll on seedance-fast is `unpriced` today, and `unpriced` means REFUSED**

The sharpest build-order fact. `plannedInputs` sets `aspectRatio` for a video brief and **never sets
`width`/`height`**. seedance bills `per_video_token`, and `pricing.ts:131` needs pixels for both
halves of the quote:

> _"a request that names no size cannot be priced at all … `videoTierFor(inputs.width, inputs.height)`
> → `unpriced`"_

`assertSpendWithinCaps` refuses an `unpriced` quote — deliberately, and `spendCaps.ts` explains at
length why it must check the flag before the amount. So **routing b-roll to seedance-fast without
also giving the brief concrete dimensions ships a feature that is refused at the money gate on every
call.** That is its own commit, before routing is wired, with its own revert check.

And the resolution is not free choice. `config.ts:542`:

> _"NO 1080p OR 4K ENTRY, and that is the price list, not an omission: seedance-2.0-fast advertises
> `supported_resolutions: ["480p","720p"]`. A request past 720p on this model is unpriced —
> correctly, because it is also unservable."_

So b-roll is **720 short edge**. Note this disagrees with `spec.ts`'s _"1080 on the short edge …
it is what the Studio's generated clips come back at"_ — which was written about Veo and is wrong
about Veo too: V2b's clips came back **720×1280**. Recorded, not fixed; the stitch target conforms
whatever arrives.

### 0.4 ✅ Setting width/height cannot make the quote and the wire disagree

`openrouter.ts:343` already sends `size: "${width}x${height}"` when both are present. So the same
two numbers that pick the price tier are the ones that buy the resolution — by construction, not by
agreement. **No adapter change.** (Vertex ignores them and sends `aspectRatio`; Veo is `per_second`
and does not need pixels, so the asymmetry costs nothing and gets a comment.)

### 0.5 ✅ The injection point for routing is one argument

`previewGeneration` → `estimate(task, inputs, { ...opts, providerParams })` → `resolve()` takes
`opts.provider ?? route.provider` and `opts.model ?? route.model` (`router.ts:39`). The plan it
returns carries provider+model, `createGenerationJob` writes them to the row, the runner reads the
row. So shot-type routing is **two override fields on one existing call** — `routes()`'s task map is
not touched, and the runner's read-the-row invariant is untouched.

`adapter.estimate(task, inputs, model, opts)` prices the _resolved_ model, so routing and price move
together automatically.

---

## 1. Decisions this plan makes that the sign-off left open

| #   | question                                                                 | decision                                                                                                                                                       | why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How is `identity-pose` selected, when both identity templates are valid? | `PreviewOptions.shotBeat?: "static" \| "pose"`, **default `"static"`**. No brief field, no schema change, no classifier.                                       | Three templates all reachable and all golden-pinned. Static is what V2b measured as the strictest face test, so the default is the measured-safest. "Which beat does her sentence want" is a classification problem, and inventing a keyword list for it now is the exact move [[wave-d]] warns against ("the classifier's vocabulary is not private to the classifier"). `durationSeconds` and `generateAudio` already ride on `PreviewOptions` for video — this is the same seam. |
| D2  | What makes `transition` unreachable, provably?                           | The union has three members and `videoRouteFor` maps all three, but **`shotTypeFor` can never return `"transition"`** — and a test pins that, with the reason. | "Prepared-but-gated" as a _proven property_ rather than a comment. A transition needs a first AND a last frame; `plannedInputs` never sets `lastFrame` and `vertex.ts:247` could not send one anyway. Routing to Kling without one does not buy a transition, it buys an ordinary i2v clip at Kling's price.                                                                                                                                                                        |
| D3  | b-roll output resolution                                                 | **720×1280 / 1280×720 / 720×720** by aspect — the top tier seedance-fast serves and prices.                                                                    | §0.3. Identity keeps `aspectRatio` only and no pixels; Veo is `per_second`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| D4  | Where the corpus harness lives                                           | `server/scripts/studioVideoQaCorpus.ts`, throwaway, imported by nothing, reading `probe-out/` **by absolute path from an env var**.                            | The `qa-fixtures`/`corpus.ts` precedent. The clips are real footage of a real athlete: a local corpus read by a script, never a committed fixture, and no asset id, frame or verdict text with personal data enters the repo. `.gitignore:49` already covers `probe-out/*`.                                                                                                                                                                                                         |

---

## 2. The commit ladder

Twelve commits, three tracks. **Track A is first and entirely $0**, because the sign-off requires
the instrument validated free before the product path moves. Every commit compiles, is green on its
own scope, and is independently revertible.

### Track A — the QA instrument. No product path touched, no provider reachable.

---

**A1 · `video/frames.ts` — the strip, the drift curve, the probe**

Moves `driftCurve` in from `studioVideoBakeoff.ts:681` (mean absolute greyscale diff at 180×320,
vs frame 0) and gives it a real extractor: ffmpeg `-ss` per stamp, streaming, `execFile` — no shell,
the same shape `videoPoster.ts` and `probe.ts` already use.

- **Predicts:** on the black→white step clip the curve is `~0` before the join and `~1.0` after; on a
  uniform clip it is `0.000` throughout; a clip shorter than one stamp yields a curve and not a throw.
- **Revert check `drift-curve-measures-change`:** replace the per-pixel absolute difference with a
  constant → the step clip's curve stops separating the halves. Reds by name.
- **Gate:** scoped jest.

---

**A2 · `video/frames.ts` — `selectFrames`, the adaptive sampler**

`t0 + argmax(curve) + t_last`, deduplicated, count env-overridable, default 3.

- **Predicts:** on the **spike fixture** — black `0–1.5s`, white `1.5–2.5s`, black `2.5–6s` — the
  sampler returns a time inside the spike. A fixed first/mid/last grid on the same clip returns
  `t=0, t=3, t=6`, all black, and sees nothing. This reproduces `hard-veo`'s shape exactly: peak at
  t=2, grid midpoint at t=3.
- **Revert check `adaptive-sampling-hits-the-peak`:** ⭐ replace `argmax` with the midpoint → the
  selected frame is black and the assertion reds by name. **Both arms are asserted in the same test**
  — the grid's miss is proven, not assumed, so this cannot pass by accident.
- **Gate:** scoped jest. ~200 ms.

---

**A3 · `qa/verdict.ts` — a `subject: "clip"` arm; `QA_SCHEMA_VERSION` 5 → 6**

The only edit to an existing `qa/` file, and it is additive: a third subject beside `"edit"` and
`"generate"`, plus the coverage field. **Not one line changes inside `identity.ts`, `anatomy.ts`,
`marks.ts`, `text.ts`, `vision.ts` or `cost.ts`.**

- **Predicts:** every existing `qa/` suite is green unchanged; a version-5 record stays readable; the
  version note explains what 6 adds the way 2–5 do.
- **Revert check:** none of its own — A4's two cover it.
- **Gate:** the whole `server/studio/qa` scope.

---

**A4 · `qa/videoClip.ts` — run the existing checks over the sample, aggregate**

A composer, not a new check. Per selected frame: `anatomy` and `text` on the frame alone; `marks` as
frame-t-vs-t0 (a `ComparisonPair`, which is exactly what it wants); `identity` **as an observation**
carrying `DEAD_RULER_CAVEAT`. `adherence` is `unknown` with a stated reason.

- **Predicts:** the clip verdict records `sampled: 3 of 145`; `overall` is the worst of the gating
  checks across sampled frames; identity contributes **nothing** to `overall` at any frame; marks
  stays advisory.
- **Revert check `identity-never-gates-a-clip`:** move `identity` into `GATING` for the clip arm → a
  fixture whose identity observation is above the band flips `overall` and reds by name.
- **Revert check `coverage-is-recorded`:** drop `sampled` from the verdict → the assertion that a
  pass cannot claim whole-clip coverage reds by name.
- **Gate:** the whole `server/studio/qa` scope.

---

**A5 · `scripts/studioVideoQaCorpus.ts` — the $0 validation harness ⛔ FIRST STOP**

Throwaway, nothing imports it, `--dry` by default, **makes no provider call of any kind** — it reads
mp4s off disk and runs the instrument. Four questions, all free:

|     | question                                                                                                                           | evidence                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| V-1 | does the ported curve reproduce V2b's published numbers?                                                                           | 0.035·0.031 / 0.087·0.166 / **0.199**·0.163  |
| V-2 | does `selectFrames` land on the turn in `hard-veo`, where a grid does not?                                                         | the 3 v2b clips                              |
| V-3 | does `marks` fire on the known swoosh-on-adidas positive?                                                                          | the 2026-09-07 spike clip                    |
| V-4 | **does within-clip identity discriminate at all?** frame-t-vs-t0 within one clip against a frame from a _different subject's_ clip | `k5-control-unanchored` + the 12 blind clips |

V-4 is the one that decides whether within-clip identity is ever allowed to become a check. **If the
control fails, no bar is written, identity stays an observation, and we learned it for $0** — which
is the whole reason this stop point exists.

⛔ **I stop here and hand you the results before anything on the product path moves.**

---

### Track B — the product path. Still dark, still $0, nothing reachable with the flag off.

---

**B1 · `video/shotType.ts` — `shotTypeFor(brief)`**

Pure. `identity` when the planner emits a `role: "person"` reference; `broll` when it does not;
`transition` **never** (D2).

- **Predicts:** a brief with a person pack → `identity`; a b-roll brief with no references → `broll`;
  no brief in the corpus yields `transition`.
- **Revert check `three-way-routing-correct`:** ⭐ three arms in one test — identity→`vertex`/`veo`,
  broll→`openrouter`/`seedance-2.0-fast`, and **transition is routable but unreachable**. Invert the
  person predicate → identity briefs route to Seedance, which refuses real people 6/6 by policy. Reds
  by name on all three.

---

**B2 · `config.ts` — `videoRouteFor(shotType)` + `videoOutputSizeFor(shotType, aspect)`**

A second, video-only table beside `routes()`. `routes()["video.generate"]` is **not touched** — it
stays the identity default, so a caller that knows nothing about shot types behaves exactly as today.

- **Predicts:** identity→`vertex`/`google/veo-3.1`; broll→`openrouter`/`bytedance/seedance-2.0-fast`
  at 720 short edge; transition→`openrouter`/`kwaivgi/kling-v3.0-std`. Every value env-overridable,
  read at call time (`config.ts`'s own rule).

---

**B3 · `preview.ts` — resolve the shot type, override the route, set the pixels 🔴**

The commit that closes §0.3. `plannedInputs` passes `{ provider, model }` into `estimate` and sets
`width`/`height` on the b-roll arm.

- **Predicts:** a b-roll brief that quotes **`unpriced` on `801c42f`** quotes a real dollar figure
  after this commit — `videoTokens(720×1280, 6s) × $0.0000042`, with the frame count at `fps × N + 1`
  ([[video-token-billing-plus-one-frame]]). An identity brief is **byte-identical** to today: Veo,
  `per_second`, no pixels.
- **Revert check `broll-is-priceable`:** drop the width/height → `videoTierFor` returns null →
  `unpriced` → `assertSpendWithinCaps` refuses. Reds by name, and the message names the model.
- **Revert check `routing-and-price-agree`:** the quoted tier equals the tier of the size that
  reaches `videoBody`'s `size` field. Pins §0.4 so they cannot drift.

---

**B4 · `video/prompts.ts` + the `buildPrompt` video branch 🔴**

Three templates, closed set, lifted verbatim from the sentences that produced V2b's 3/3 —
`identity-static` (i2), `identity-pose` (i1), `broll-no-marks` (b1–b3). A brief that matches no
template is a **blocker**, never a fallback to the image prompt.

- **Predicts:** ⚠️ **the 36 image goldens in `compile.golden.json` do not move — 0 of 36.** The video
  branch is reached only when `task === "video.generate"`, and the interpreter/native path is
  image-only (`taskFor` refuses a video edit), so no `PROMPT_VERSION` bump and no R1 re-record. If any
  image golden moves, the branch is in the wrong place and the commit is wrong.
- **Revert check `video-prompt-not-image-prompt`:** ⭐ delete the video branch → a `clip` brief's
  prompt contains _"photorealistic photograph"_ and _"Output an IMAGE, not text"_ and carries no
  motion beat. Asserted on the **string**, by name.
- **New goldens:** `video/prompts.golden.json` + `prompts.golden.test.ts`, byte-identical `toBe`, the
  `compile.golden.json` pattern (one line per array entry so a human can read the diff).

---

### Track C — the runner. Where the two halves meet.

---

**C1 · `videoRunner.ts` — the QA stage, strictly after `succeedJob` / `clearLease` 🔴**

Behind `STUDIO_CREATIVE_QA`, default off, exactly as the image hook is. Never throws; the return
value is discarded.

- **Predicts:** with the flag off it costs one boolean. With it on, the verdict is in
  `media_assets.metadata.creative_qa` and the job row is untouched. The client can see `succeeded`
  one poll before the verdict lands, which is the accepted cost of the ordering.
- **Revert check `qa-before-succeed-double-records`:** ⭐⭐ **the one that matters.** Move the QA call
  above `succeedJob`, expire the lease by writing `lease_until` into the past (the reaper's own
  predicate — the same thing `videoJobs.test.ts` already does), tick again. The reaper requeues _with
  the operation handle_, the second runner resumes polling the **same** operation, and
  `recordGeneratedAsset` runs a second time → **two `media_assets` rows for one job**. Asserted as a
  row count. `leaseMs()` has a hard `Math.max(180_000, …)` floor so it cannot be shrunk by env; the
  test writes the column, which is the honest reproduction of the state.

---

**C2 · `video/reroll.ts` — the recommendation, recorded, acted on by nothing**

Pure: verdict → `{ shotType, failedChecks, atFrames, quoteUsd }`, written into the same verdict
object. No new row, no provider call, no column.

- **Predicts:** a `fail` verdict produces a recommendation carrying the _same_ figure a fresh preview
  would quote; a `pass` produces none.
- **Revert check `record-only-no-auto-reroll`:** ⭐ across a job whose QA fails, the mocked adapter's
  `submit` is called **exactly once** and `generation_jobs` holds **exactly one row** for the
  athlete. Add a re-submit on failure → both assertions red by name.

---

**C3 · `docs/probes/video-v9-predictions.md` — the paid cells, written before they run**

P1 (×2, $2.40): does a clip from the **product** prompt hold identity as well as the probe prompt
did — same frame, same model, same duration, prompt the only variable. P2 (×1, $1.20): end-to-end
through the runner on the hard turn. **≈$3.60, dry-run first, one cap, your go.** Predictions
committed before any cell runs; misses reported.

---

## 3. Gates, in the order they run

1. **Baseline first, before commit 1** — bare `npm test` on clean `801c42f`, recorded.
   [[gate-is-the-whole-suite]]: the gate is the whole suite, never a chosen scope — card 2's four
   shards missed `server/scripts` and #511 shipped red main. No peer session is running
   (`ListAgents`, checked); re-checked before the run, handshake if one appears
   ([[coordinate-jest-across-sessions]]).
2. **Per commit** — scoped jest on the touched files, called through `npm test` (PGlite needs
   `--experimental-vm-modules`; [[npm-test-runner-drops-jest-flags]] — the runner silently drops
   `--json`/`--runInBand`, so a revert-check hold calls jest directly with
   `NODE_OPTIONS=--experimental-vm-modules` and reads `assertionResults` from `--json`
   ([[jest-holds-need-json-output]])).
3. **Both tsc configs** — `npm run check:types` _and_ `npx tsc --noEmit -p tsconfig.jest.json`, since
   the app config excludes `**/*.test.ts` and jest is transpile-only ([[check-types-skips-tests]]).
4. **Prettier base-vs-now** — `801c42f` vs the tip on the touched files only. Never `--write` across
   the tree: ~728 files are unformatted on main ([[check-format-fails-on-main]]).
5. **Full gate before handing it over** — bare `npm test`, 0 new red. `affiliationSync`'s
   "year-only from/to" fails ~1 run in 3 on main itself ([[affiliation-sync-test-is-flaky]]); a lone
   red there gets one re-run and is not my diff.
6. **Revert checks as a batch**, each proven to red by name, run after the tree is otherwise green —
   and never handed over mid-batch ([[preservation-fixes-recon]]).

## 4. Predictions for the build as a whole

Written now, scored at the end, misses reported.

1. **0 of 36 image goldens move.** The highest-risk claim in the ladder — if the video branch is
   misplaced it moves them and the commit is wrong.
2. **B3 turns a b-roll quote from `unpriced` into a number.** Provable against `801c42f` in the same
   test file, both directions.
3. **`adaptive-sampling-hits-the-peak` passes on the spike fixture and the fixed grid misses it** —
   both arms asserted in one test.
4. **`qa-before-succeed-double-records` reds with a row count of 2.** If it reds some other way the
   check is testing the wrong thing and gets rewritten, not accepted.
5. **No migration.** `git diff --stat` touches no file under `migrations/` and no line of
   `shared/schema.ts`.
6. **The suite grows by ~9 files and no existing suite changes meaning.** `qa/verdict.ts` is the only
   pre-existing test-bearing file edited, and additively.
7. **V-4 (the within-clip identity control) is the one I genuinely do not know.** My guess is it
   discriminates better than the cross-photograph ruler did and still not well enough to write a bar
   in. Recorded now so the answer is scored rather than rationalised.

## 5. Stop points

|                 |                                                 |                               |
| --------------- | ----------------------------------------------- | ----------------------------- |
| ⛔ **now**      | the build-order plan                            | ← you are here                |
| ⛔ **after A5** | the $0 corpus validation, V-1…V-4               | before the product path moves |
| ⛔ **after C3** | the full gate, the revert-check batch, the diff | before the paid confirm       |
| ⛔ **paid**     | ~$3.60, 3 cells, dry-run first                  | your explicit go              |

I never push. You review and merge with a merge commit.

---

---

# Part III — Track A results (⛔ STOP POINT)

**Built 2026-09-19 on `studio-video-v9`, five commits off `801c42f`. Nothing pushed.**

```
936080a  corpus harness            (A5)
945a521  clip QA composer          (A4)
29c8c9e  verdict clip arm, v6      (A3)
44175e3  adaptive sampling         (A2)
364916a  drift curve + extractor   (A1)
```

Gate baseline on clean `801c42f`: **371 suites · 6937 tests · 0 failed** (affiliationSync did not
flake this run). Scoped after Track A: `server/studio/qa` 14/190/0, `server/studio/video` 6/104/0.
Both tsc configs clean; every touched file prettier-clean.

---

## 1. The $0 validation

### V-1 — the ported drift curve reproduces V2b's published numbers **EXACTLY**

```
✓ easy-veo-3.1   recorded [0.035, 0.031]   got [0.035, 0.031]   maxΔ 0.000
✓ med-veo-3.1    recorded [0.087, 0.166]   got [0.087, 0.166]   maxΔ 0.000
✓ hard-veo-3.1   recorded [0.199, 0.163]   got [0.199, 0.163]   maxΔ 0.000
→ 3/3 within 0.001
```

Three places, no drift at all. This is what licenses comparing anything the stage records from now
on against the only baseline that exists. It runs through the **stamps** plan, the harness's own
`-ss`-per-timestamp method, because a dense pass picks the nearest decoded frame instead — close,
and not the same, and a reproduction that changed the method would be measuring two things at once.

### V-2 — the sampler **never loses**, and its advantage sits exactly where identity work is

24 distinct clips across both corpora: **beat the grid 16 · tied 8 · lost 0.**

A loss is impossible by construction — the grid's own frames are inside the curve the argmax
searches — so the honest claim is _never worse, sometimes materially better_, not the landslide
Part I implied. Where it is better is the finding:

| clip                  | peak              | drift at peak | grid's best | advantage |
| --------------------- | ----------------- | ------------- | ----------- | --------- |
| `kling-first-last`    | 2.50s             | 0.206         | 0.156       | **0.050** |
| `veo-crouch`          | 2.00s             | 0.205         | 0.162       | **0.043** |
| `hard-veo-3.1`        | 2.00s             | 0.197         | 0.162       | **0.035** |
| `k4-anchored-nonturn` | 2.00s             | 0.195         | 0.169       | **0.026** |
| `veo-turn`            | 4.00s             | 0.196         | 0.181       | 0.015     |
| … 8 b-roll cells      | mostly 5.50–5.75s | —             | —           | **0.000** |

**Every large advantage is a clip with a mid-clip excursion — a turn, a crouch, a first-last
anchor. Every tie is b-roll.** B-roll drifts monotonically as the camera pushes in, so the grid's
last stamp already _is_ the peak and there is nothing to beat. That is Part I's `hard-veo` argument
(peak t=2.00s against a t=3 midpoint) holding on fifteen more clips, plus something Part I did not
say: **a fixed grid is adequate for b-roll and misses precisely the shape an identity clip has.**

---

## 2. 🔴 Three corrections to Part II, found while building

### C-1 V-3 has no known positive — the 2026-09-07 swoosh clip is not on disk

A `find` for any mp4 dated 2026-09-01..09-10 across the repo and every worktree returns **nothing**.
The spike's clips were never saved. "Does `marks` fire on the known swoosh-on-adidas positive"
cannot be asked.

**What V-3 becomes instead: a SPECIFICITY probe.** Run `marks` frame-to-frame over `i2-veo-3.1` and
`i3-veo-3.1` — both carry adidas three stripes on both sleeves, on screen throughout, and neither
changes brand, so every fire is a false positive. Given marks already sits at 27% specificity on
stills (16 FP against 22 good images), the useful question is whether it is _worse_ frame-to-frame.
If it fires on most frames it stays advisory on video permanently. A real finding — just not the
one the plan promised.

### C-2 🔴 V-3 and V-4 are **not $0**. Part II said "four questions, all free". Wrong for two.

|                                  | instrument                                                            | cost          |
| -------------------------------- | --------------------------------------------------------------------- | ------------- |
| V-1 reproduce the drift curve    | ffmpeg + sharp                                                        | **$0** ✅ run |
| V-2 sampler vs grid              | ffmpeg + sharp                                                        | **$0** ✅ run |
| V-3 marks specificity            | `qa/marks.ts` → 2× `askVision`                                        | **paid**      |
| V-4 within-clip identity control | `qa/face.ts` → `askVision`; `qa/embed.ts` → `multimodalembedding@001` | **paid**      |

Scale: the image stage's full inspection measured **$0.0212**, so a 3-frame sample is ~$0.05/clip
and V-3+V-4 over ~10 clips is **≈$0.50**. Cheap, not free, and it needs Vertex credentials.

**So the A5 stop point splits.** V-1 and V-2 are delivered above at $0. V-3 and V-4 need their own
go — a _different, much smaller_ decision from the ~$3.60 generation confirm. `--paid` currently
exits 2 with a message rather than doing anything, so neither can fire by accident.

### C-3 The corpus is ~24 distinct clips, not 36

`probe-out/video-bakeoff/blind/` is **12 copies** of the bake-off clips (`blind/key.json` maps each
`clip-NN` back to its cell). Distinct: 3 v2b Veo + 5 bakeoff Veo + 7 bakeoff Seedance + 6
kling-first-last + 3 veo-headtohead = **24**. The harness skips `blind/` by name, because counting a
clip twice inflates every ratio while looking like more evidence.

---

## 3. Predictions, scored

| #   | prediction                                                                                                  | outcome                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | `adaptive-sampling-hits-the-peak` passes on the spike fixture and the grid misses it, both arms in one test | ✅ **hit** — and both mutations recorded                                                                                                                                                                         |
| 5   | no migration: nothing under `migrations/`, no line of `shared/schema.ts`                                    | ✅ **hit**                                                                                                                                                                                                       |
| 6   | ~9 new files, no existing suite changes meaning                                                             | ⚠️ **partial** — 6 files so far, and **one existing assertion moved**: verdict.test.ts's literal schema pin, 5 → 6. That is the pin working as designed, not a broken test, but Part II should have predicted it |
| 7   | V-4 is the one I do not know                                                                                | ⏸ **unrun** — it is paid (C-2)                                                                                                                                                                                  |

Predictions 1, 2 and 4 belong to Tracks B and C and are not yet in play.

---

## 4. Two defects I found in my own work, both fixed before commit

**The identity spend was a confident zero.** `runClipQa` rolled identity up as an `unknownResult`
carrying `zeroSpend()` — but every sampled frame past the anchor pays for two face detections and
two embeddings. The _answer_ is discarded; the _invoice_ is not. The stage would have reported
itself at $0.016 against a real $0.020 on the suite's own numbers, which is exactly the "confident
zero" `qa/cost.ts` refuses. Now summed, and pinned by a test.

**A revert check that went red for the wrong reason.** The literal `adaptive-sampling-hits-the-peak`
mutation (argmax → midpoint) reds via `expect(peak).toBeDefined()`: the midpoint frame is black, its
drift is under `peakFloor()`, so the sampler declares the clip motionless and emits no peak at all.
A correct red, and not the claim. A second mutation that bypasses the floor reds on the peak's own
timestamp, which _is_ the claim. Both are written on the test — "it went red" is not the same as
"it went red for the reason on the tin".

---

## 5. What is waiting on you

1. **Sign off Track A** (or send it back).
2. **V-3 + V-4: ~$0.50, ~10 clips, your go.** Separate from and much smaller than the $3.60
   generation confirm. V-4 decides whether within-clip identity may ever become a check; V-3 decides
   whether `marks` is usable on video at all. Both are needed before Track C wires QA into the
   runner, because a stage whose two comparison checks have never been pointed at a real clip is a
   stage nobody has watched run.
3. Then **Track B** (B3's pricing fix before routing) and **Track C**.

---

---

# Part IV — Track B predictions

**Written and committed BEFORE a line of Track B is built.** Scored in Part V, misses reported.

## B1 · `shotTypeFor(brief)`

| #      | prediction                                                                                                                                                                                                                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-B1.1 | A brief whose planner emits a `role: "person"` reference routes `identity`.                                                                                                                                                                                                                                                            |
| P-B1.2 | A brief with no references, or with only `style`/`product` ones, routes `broll`.                                                                                                                                                                                                                                                       |
| P-B1.3 | **No brief reachable today can return `transition`.** Pinned as a property with its reason, not as a comment — a transition needs a first AND a last frame, `plannedInputs` never sets `lastFrame`, and `vertex.ts:247` could not send one. Routing to Kling without one buys an ordinary i2v clip at Kling's price, not a transition. |

Revert check **`three-way-routing-correct`** — all three arms in one test; inverting the person
predicate sends identity briefs to Seedance, which refuses real people 6/6 by stated policy.

## B2 · `videoRouteFor(shotType)` + `videoOutputSizeFor(shotType, aspect)`

| #      | prediction                                                                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-B2.1 | `identity → vertex / google/veo-3.1` · `broll → openrouter / bytedance/seedance-2.0-fast` · `transition → openrouter / kwaivgi/kling-v3.0-std`.                                                                                                                |
| P-B2.2 | b-roll output is **720 on the short edge**: `9:16 → 720x1280`, `16:9 → 1280x720`, `1:1 → 720x720`. Not 1080 — `config.ts:542` says seedance-fast advertises `["480p","720p"]` and a request past 720p is _unpriced, correctly, because it is also unservable_. |
| P-B2.3 | An identity shot gets **no pixels at all**. Veo bills `per_second`, and the Vertex body sends `aspectRatio` and ignores width/height, so adding them would be decoration that could later be mistaken for a request.                                           |
| P-B2.4 | `routes()["video.generate"]` is **unchanged**. A caller that knows nothing about shot types behaves exactly as it does on `801c42f`.                                                                                                                           |

## B3 · the preview wiring, and the money-gate blocker

| #      | prediction                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P-B3.1 | 🔴 **The headline.** On `801c42f` a b-roll brief quotes `unpriced` and `assertSpendWithinCaps` **refuses** it. After B3 it quotes a real dollar figure. **Both directions asserted in one test** — the refusal is proven, not assumed.                                                                                                                                                                                                                       |
| P-B3.2 | The figure is arithmetic I can state now: `frames = 24×secs + 1`, `tokens = ceil(w×h×frames÷1024)`, `usd = tokens × $0.0000042`. At the 4s default and 720×1280 that is `frames 97 · tokens 87,300 · **$0.3667**`. At 6s it is `frames 145 · tokens 130,500 · **$0.5481**` — **which is the figure the bake-off was actually invoiced** for a 6s seedance-fast clip, so the prediction is checkable against a real receipt and not only against my own code. |
| P-B3.3 | An identity brief's quote is **byte-identical to today**: Veo, `per_second`, `$0.20/s`, `$0.80` at the 4s default.                                                                                                                                                                                                                                                                                                                                           |
| P-B3.4 | The two numbers that pick the price tier are the same two that reach `videoBody`'s `size` field. They cannot drift, because `openrouter.ts:343` already sends `size: "${width}x${height}"` — no adapter change.                                                                                                                                                                                                                                              |

Revert checks **`broll-is-priceable`** (drop the width/height → `videoTierFor` returns null →
`unpriced` → refused, and the message names the model) and **`routing-and-price-agree`** (the quoted
tier equals the tier of the size on the wire).

## B4 · the prompt library

| #      | prediction                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P-B4.1 | 🔴 **0 of 36 image goldens move.** The highest-risk claim in the card. The video branch is reached only when `task === "video.generate"`, and the interpreter/native path is image-only (`taskFor` refuses a video edit), so there is no `PROMPT_VERSION` bump and no R1 re-record. If any image golden moves, the branch is in the wrong place and the commit is wrong. |
| P-B4.2 | A `clip` brief's prompt carries a **motion beat**, a **camera instruction** and an explicit **preservation clause**, and contains neither `"photorealistic photograph"` nor `"Output an IMAGE"`.                                                                                                                                                                         |
| P-B4.3 | Three templates, all reachable, all byte-pinned by their own goldens: `identity-static` (from i2), `identity-pose` (from i1), `broll-no-marks` (from b1–b3). `identity-pose` is selected by `PreviewOptions.shotBeat`, default `"static"`.                                                                                                                               |
| P-B4.4 | A brief that matches no template is a **blocker**, never a silent fallback to the image prompt.                                                                                                                                                                                                                                                                          |

Revert check **`video-prompt-not-image-prompt`** — delete the video branch and a clip brief's prompt
contains `"photorealistic photograph"`; asserted on the string, by name.

## What I expect to go wrong

Stated in advance so it is not rationalised after. **B4 is where I expect trouble**, not B3. B3 is
arithmetic against a published invoice. B4 threads a branch through `buildPrompt`, which is the
single most golden-pinned function in the repo — and my own prediction is that it moves nothing.
That is the prediction most likely to be wrong, and the one whose failure would mean the design is
wrong rather than the code.

---

---

# Part V — Track B results

Four commits on top of Track A, off `801c42f`. Nothing pushed.

```
3edf1c5  prompts + the buildPrompt video branch   (B4)
109ee9c  the pricing fix / money gate             (B3)
eac8a0e  videoRouteFor + videoOutputSizeFor       (B2)
20a9d3e  shotTypeFor                              (B1)
```

Scoped `server/studio`: **103 suites · 3110 tests · 0 failed.** Both tsc configs clean, every
touched file prettier-clean. No file under `migrations/`, no line of `shared/schema.ts`.

## 1. Predictions, scored

| #        | prediction                                            | outcome                                                                                                                                                                                                                                                   |
| -------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-B1.1/2 | identity ⇔ a person reference, else b-roll            | ✅ over **all 32** subsets of the role union, not three examples                                                                                                                                                                                          |
| P-B1.3   | `transition` unreachable                              | ✅ pinned exhaustively; a count assertion guards the enumeration itself                                                                                                                                                                                   |
| P-B2.1   | the three routes                                      | ✅                                                                                                                                                                                                                                                        |
| P-B2.2   | b-roll at 720 short edge                              | ✅ — and the _why_ is tested in both directions: 720 lands in a band seedance-fast publishes a rate for, 1080 does not                                                                                                                                    |
| P-B2.3   | identity gets no pixels                               | ✅                                                                                                                                                                                                                                                        |
| P-B2.4   | `routes()` unchanged                                  | ✅                                                                                                                                                                                                                                                        |
| P-B3.1   | 🔴 unpriced → priced, **both directions in one test** | ✅ — the refusal arm re-prices the same inputs without pixels and drives the real spend gate                                                                                                                                                              |
| P-B3.2   | `$0.3667` at 4s, `$0.5481` at 6s                      | ✅ **exact to four decimals**, and $0.5481 is what the bake-off was invoiced                                                                                                                                                                              |
| P-B3.3   | identity byte-identical, `$0.80`                      | ✅                                                                                                                                                                                                                                                        |
| P-B3.4   | tier and wire cannot drift                            | ✅                                                                                                                                                                                                                                                        |
| P-B4.1   | 🔴 **0 of 36 image goldens move**                     | ✅ **held** — compile/: 3 suites, 133 tests, 0 failed                                                                                                                                                                                                     |
| P-B4.2   | motion + camera + preservation, no "photograph"       | ✅                                                                                                                                                                                                                                                        |
| P-B4.3   | three templates, golden-pinned                        | ✅ four goldens, including the untrusted-fencing cell                                                                                                                                                                                                     |
| P-B4.4   | a brief with no template is a blocker                 | ⚠️ **partial, and honestly so.** The refusal is implemented and tested, but it can only be reached by `transition`, which `shotTypeFor` cannot return. So it is a property of the FUNCTION, not of any brief. Written as reachable in Part IV; it is not. |

### The prediction about predictions was wrong

Part IV said: _"B4 is where I expect trouble, not B3."_ **Wrong.** B4's 0-of-36 held first time,
because the video arm returns before either image arm is consulted — a property of the control flow
rather than a hope about it. **B2 was the trouble**, and from a direction I had not considered at
all. Recorded because a prediction written down to be scored is only worth anything if the misses
are reported.

## 2. 🔴 What Track B found — an existing guard caught a real design mistake

**`ShotType` was declared in the wrong file, and `stitchRunner.test.ts` said so within seconds.**

I put it in `studio/video/shotType.ts`, which imports `PlannedReference` from `studio/preview.ts`.
`config.ts` needs it for the route table — so every module that reaches `config.ts` suddenly reached
`preview.ts`. The "no spend surface" guard went red immediately:

> `✗ the runner reaches the stitch engine and nothing that can spend`

That walk reads **import specifiers out of the source** and does not care that `import type` is
erased at runtime. That reading is conservative and it is **correct**: a type import is one refactor
from being a value import, and then the stitch runner really would pull the preview store and the
spend gate into a path that must never reach them.

The fix is to break the edge, not to except it. `ShotType` now lives in `studio/types.ts`, which
imports nothing — so no graph grows — and which is simply where it belongs: a `TaskRoute` is a
provider and a model, and both of those already live there.

**This is the single most valuable thing that happened in Track B**, and none of it was mine: an
existing test, written for a different card, caught an architectural mistake that would have been
invisible in review and would have quietly widened a blast radius the codebase had deliberately
narrowed.

## 3. A second bug, found by building the first fix

`durationBlockers` asked `supportedDurationsFor(routeFor("video.generate").model)` — always Veo,
which serves **4/6/8**. seedance-fast serves **4..15**. So the moment b-roll routes elsewhere, a 5s
b-roll clip would be refused for a limit belonging to a model it was never going to. Latent at the
4s default, wrong in principle, and a direct consequence of routing — so it is fixed by routing, and
both directions are tested (b-roll gets its 5s, identity still cannot).

## 4. Revert checks, all proven

| check                           | mutation                                                                        | result                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `three-way-routing-correct`     | (a) let `shotTypeFor` return transition · (b) swap the identity and b-roll arms | 3/3 and 2/8 red, in two files                                                                                                                                |
| `broll-is-priceable`            | drop the pixels — the bug as it exists on `801c42f`                             | 5 failed / 3 passed                                                                                                                                          |
| `routing-and-price-agree`       | quote one size, send another                                                    | 3 failed / 5 passed — ⚠️ and **`broll-is-priceable` still PASSES**, which is the measured reason both exist: the quote is still a number, just the wrong one |
| duration arm                    | check against the task route                                                    | 1 failed / 7 passed, perfectly isolated                                                                                                                      |
| `video-prompt-not-image-prompt` | delete the video arm                                                            | 3 failed / 8 passed, redding on `not.toContain("photorealistic photograph")`                                                                                 |

## 5. What is waiting on you

1. **The Track B diff** — 10 files, +1443/−25. Production code is five files: `types.ts` (+ShotType),
   `config.ts` (+route table, +output size), `preview.ts` (+the wiring), and two new leaves,
   `video/shotType.ts` and `video/prompts.ts`.
2. **~$0.50 instrument validation (V-3 + V-4)** — approved in principle; not fired.
3. **Track C** on your go: C1 the runner QA stage (after `succeedJob`), C2 record-only re-roll, C3
   the paid-cell predictions.

---

---

# Part VI — Track C predictions

**Written and committed BEFORE a line of Track C is built.** Scored in Part VII, misses reported.

## C1 · the runner's QA stage

### Shape

`qa/inspectClip.ts` is the entry point, a sibling of `qa/inspect.ts` and split from `qa/videoClip.ts`
exactly as `inspect.ts` is split from `verdict.ts`: resolve the asset under its athlete, get the
bytes, write them to a temp file (frames.ts takes LOCAL PATHS ONLY and carries no credential),
extract the strip, compute the curve, select the sample, run the checks, write the verdict, dispose.
Never throws, timeout-bounded, returns null when there is nothing to look at.

`videoRunner.workJob` calls it behind `creativeQaEnabled()` — **after `succeedJob` and
`clearLease`**, not before.

| #      | prediction                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-C1.1 | With `STUDIO_CREATIVE_QA` off the stage is never entered and the tick costs one boolean, exactly as the image hook does.                                                                                       |
| P-C1.2 | With it on, the verdict lands in `media_assets.metadata.creative_qa` carrying `subject: "clip"`, `coverage` and the per-frame records.                                                                         |
| P-C1.3 | The job row is **untouched** by QA — status, `last_error` and the lease columns are what `succeedJob`/`clearLease` left.                                                                                       |
| P-C1.4 | A QA stage that **throws** still leaves the job `succeeded` with its asset stored. By the time it runs the clip is paid for; an exception here would destroy something valuable to report something worthless. |

### 🔴 P-C1.5 — the revert check, and how it is made deterministic

**`qa-before-succeed-double-records`, asserted as a ROW COUNT OF 2.**

The hazard is real and specific: `reapExpiredLeases` requeues on `status='running' AND lease_until <
now()`, and it keeps `provider_operation_name`. If QA sits between the store and `succeedJob` and
outlives the lease, the reaper requeues a job whose asset is already stored, the next runner
**resumes polling the same operation**, and `recordGeneratedAsset` runs a second time.

Simulating "QA took longer than the lease" by waiting is not a test. So the **QA mock expires the
lease itself** — it writes `lease_until` into the past, which is precisely the state elapsed time
would have produced, and is the same thing `videoJobs.test.ts` already does to drive the reaper.
Then:

```
correct   store → succeedJob → clearLease → QA(expires lease) → reap → tick
          status is already 'succeeded', so the reaper's predicate excludes the row
          → 1 media_assets row
mutated   store → QA(expires lease) → succeedJob → clearLease → reap → tick
          status is still 'running' when the lease lapses; the reaper requeues WITH the handle;
          the next tick resumes the same operation and stores the asset again
          → 2 media_assets rows
```

`leaseMs()` has a hard `Math.max(180_000, …)` floor and cannot be shrunk by env, which is why the
column is written rather than the clock moved.

## C2 · `video/reroll.ts`, record-only

| #      | prediction                                                                                                                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-C2.1 | A `fail` verdict produces a recommendation naming the failing checks, the frames they failed at, and a quote **equal to what a fresh preview would quote** — so the figure she is shown is the figure she would be charged.            |
| P-C2.2 | A `pass` produces none. A verdict that is `pass` with unknowns still produces none: an unknown is not a reason to spend her money again.                                                                                               |
| P-C2.3 | 🔴 **`record-only-no-auto-reroll`** — across a job whose QA fails, the mocked adapter's `submit` is called **exactly once** and `generation_jobs` holds **exactly one row** for that athlete. Adding a re-submit on failure reds both. |
| P-C2.4 | No new column. The recommendation rides inside the same verdict object, in `media_assets.metadata.creative_qa`. `git diff` still touches no file under `migrations/`.                                                                  |

The three rules this obeys, all already written in this repo: _"A failed job stays failed. Re-running
is a NEW job with its own row and its own cost line"_ (`jobs.ts:174`); _"a re-run is a new check and
a new cost line — never a silent retry against the same approval"_ (`generate.ts:1437`); and the
decisive one — `spentTodayUsd` banks the quote at INSERT, so an in-runner re-roll would spend money
the rolling day ceiling never sees.

## C3 · the paid cells

`docs/probes/video-v9-predictions.md`, written before anything runs. Two questions, ~$3.60, dry-run
first, one cap, and not fired without an explicit go.

## What I expect to go wrong

Last time I named B4 and it was B2, so this is offered with that on the record. **C1's revert check
is the risky part** — not the runner change, which is three lines in a known place, but making the
double-record reproduce _for the right reason_. A test that reds because the mock threw, or because
the second tick claimed nothing at all, would look like a pass of the check while proving nothing.
The count must be 2 **and** the second row must have the same `generation_job_id` as the first.

---

---

# Part VII — Track C results (⛔ STOP POINT)

Three commits on top of Track B, off `801c42f`. Nothing pushed.

```
0fa241c  the paid-cell predictions, written before either gate fires   (C3)
ac84d2b  video/reroll.ts — record-only                                 (C2)
193bc05  the runner's QA stage, after succeedJob                       (C1)
76072ad  Track C predictions, committed before a line of it was built
```

Full bare `npm test`: **380 suites · 7032 tests · 0 failed**, 17 batches, exit 0.

⚠️ **THE WHOLE SUITE, NOT A CHOSEN SCOPE.** Every commit on this branch quotes a scoped
`server/studio` number, and a scoped run is exactly what shipped red main once (#511): this branch
touches `server/scripts/`, which no chosen scope sees. The first pass of the identical tree came
back with a single red — `affiliationSync.test.ts`'s year-only case, which is the house flake that
fails about one run in three on main itself. It re-ran green with nothing changed; both runs are on
the record rather than only the green one.

Both tsc configs clean — `--noEmit` on the app config and on `tsconfig.jest.json`, which is the only
thing here that type-checks the tests at all. Every file this branch touches is prettier-clean.
`expo lint` reports 73 errors repo-wide and **none in any file this branch touches**, the same
pre-existing shape `check:format` has on main.

No file under `migrations/`, no line of `shared/schema.ts`, no line of `.github/workflows/**` or
`gcp/**`. Both flags — `STUDIO_VIDEO_ENABLED` and `STUDIO_CREATIVE_QA` — are off by default and
neither default moves here.

## 1. Predictions, scored

| #      | prediction                                              | outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-C1.1 | flag off ⇒ the stage is never entered                   | ✅ `qaEnabledMock` is called, `inspectClipMock` is not, and the tick still succeeds                                                                                                                                                                                                                                                                                                                                                                                                                |
| P-C1.2 | the verdict lands with `subject: "clip"` + coverage     | ✅ — but **proven in two files, not one**, and that split is worth naming: the runner suite mocks the stage, so it pins the CALL (assetId, `athleteId` off the row, her sentence off the frozen brief, the bytes handed over rather than re-downloaded); the stored shape — `subject: "clip"`, `coverage: { checked, scanned, total }`, per-frame `frames[]` — is `inspectClip.test.ts`'s                                                                                                          |
| P-C1.3 | the job row is untouched by QA                          | ✅ status, `last_error`, `lease_until` and `lease_holder` are all exactly what `succeedJob`/`clearLease` left                                                                                                                                                                                                                                                                                                                                                                                      |
| P-C1.4 | a QA stage that THROWS leaves the job succeeded         | ✅ and it is **not decoration** — it reds without the runner's own try/catch, because `jobs.ts` `finish()` is unguarded on status and would write `failed` over a job whose clip is stored and whose money is spent                                                                                                                                                                                                                                                                                |
| P-C1.5 | 🔴 `qa-before-succeed-double-records`, row count of 2   | ✅ **held, on the second attempt** — see §2, which is the finding of this track                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P-C2.1 | a `fail` names checks, frames and the re-run's price    | ✅ every failing gating check, not just the first; the frame read off the per-frame records rather than parsed back out of a summary string — ⚠️ and `atSec` is **null for `identity` and `adherence`**, because only `anatomy`, `text` and `marks` are asked per frame; a clip-level check has no frame to name, and saying null is better than naming one it did not come from; the quote read off the row's `cost_estimated_usd`, so the figure she is shown is the figure she would be charged |
| P-C2.2 | a `pass`, and a `pass` with unknowns, recommend nothing | ✅ — and it is **four refusals, not two**. A pass. A pass carrying unknowns. A `flag` (worth a human's attention ≠ worth her money). And `marks` alone, however loudly it failed, because 16 false positives against 6 true negatives on the 36-row corpus makes that recommendation a bill for nothing four times in five                                                                                                                                                                         |
| P-C2.3 | 🔴 `record-only-no-auto-reroll`, exactly one submit     | ✅ one `submit`, one `generation_jobs` row, one asset — and a **second tick afterwards still claims nothing**, which is what catches an "act on it next tick" implementation that a single-tick assertion would miss                                                                                                                                                                                                                                                                               |
| P-C2.4 | no new column, no migration                             | ✅ the recommendation rides inside the verdict in `media_assets.metadata.creative_qa`; `git diff` touches no file under `migrations/`                                                                                                                                                                                                                                                                                                                                                              |
| C3     | the paid cells                                          | ⛔ **written, committed, not fired.** `docs/probes/video-v9-predictions.md`, two questions, ~$3.60, dry-run first, one cap, your explicit go                                                                                                                                                                                                                                                                                                                                                       |

### The prediction about predictions was RIGHT this time

Part VI said: _"C1's revert check is the risky part — not the runner change, which is three lines in
a known place, but making the double-record reproduce for the right reason."_ **That is exactly what
happened**, and it is recorded here for the same reason the Part V miss was: a prediction written
down to be scored is only worth something if both outcomes get reported.

## 2. 🔴 The double-record check PASSED UNDER ITS OWN MUTATION first

The repo keeps a memo about precisely this failure, and Track C walked into it anyway.

The first version expired the lease inside the QA mock and reaped **afterwards, sequentially**. But
with the QA block moved above `succeedJob`, `succeedJob` still runs microseconds later in the same
tick — so a sequential reaper finds a terminal job either way, and the check went green under the
mutation it exists to catch. **The hazard is concurrent by nature**, so the mock now reaps AND ticks
from _inside_ the QA stage: "another instance noticed the lapse while this one was busy". PGlite
serialises transactions, so that is deterministic rather than a race the suite hopes to hit.

Both the failure and the fix are written on the test. Two things make it prove what it claims:

- the count must be **2**, _and_ the second row must carry the same `generation_job_id` as the first
  — a second row for any other reason is not this bug;
- a **control** sits beside it — the same lapse _before_ the job is terminal DOES requeue — so
  "nothing was requeued" cannot pass merely because the reaper never works in this harness. Setting
  that control up took two goes: `workJob` narrows with `instanceof GenerationError`, so a plain
  `Error` carrying a `code` property took the `failJob` arm instead.

## 3. What nothing predicted: a static import crashed a jest worker

The first draft of C1 imported `./qa/inspectClip` statically. That reaches
`qa/videoClip → qa/identity → qa/embed → lib/mediaEmbed`, which runs `new Storage().bucket(BUCKET)`
**at module load**. `videoRunner.dispatch.test.ts` — a suite about provider dispatch that touches
none of this — died with `CRASHED (exit 1) — no JSON report produced`.

The corrected diagnosis is the part worth keeping: `lib/mediaEmbed` was **already** in this file's
transitive graph via `generate.ts → qa/inspect`, long before this card, and that path is harmless
because every suite exercising the runner mocks `./generate`. What broke was that the new import was
a **second path to the same module — the one nothing mocked**. It is also simply wrong to pay for
eagerly: the stage sits behind a flag that is off by default, so every instance was loading the
module graph of something that never runs. The import is now dynamic, inside the flag check, with
`.js` on the specifier per this repo's convention.

Four tests pin it, including one that proves the walk **can** see a deep import — so an empty answer
means something rather than meaning the instrument is blind.

## 4. Revert checks, all proven

| check                              | mutation                                   | result                                                                            |
| ---------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| `qa-before-succeed-double-records` | move the QA block above `succeedJob`       | 1 failed / 9 passed — `Expected length: 1, Received length: 2`                    |
| the dynamic-import guard           | go back to a static `import` of the stage  | 3 failed / 7 passed                                                               |
| the runner's own try/catch         | drop it and let a QA throw reach `failJob` | the job flips `succeeded → failed` with its clip still stored                     |
| `record-only-no-auto-reroll`       | re-submit on a failing verdict             | 2 failed / 10 passed — `Expected number of calls: 1, Received number of calls: 2` |

## 5. What is waiting on you

1. **The Track C diff** — production code is three files: `videoRunner.ts` (the stage, behind the
   flag, after `succeedJob`), `qa/inspectClip.ts` (new leaf, never throws, tenancy off the row), and
   `video/reroll.ts` (new leaf, pure, records and dispatches nothing).
2. **~$0.50 instrument validation (V-3 + V-4)** — approved in principle since Track A; still not
   fired.
3. **~$3.60 paid cells (G1)** — predictions committed. The `--paid` arm is still a deliberate
   refusal stub; wiring it is $0 of work that buys a dry run quoting the exact figure first.
   Credentials are yours to confirm.
4. **The push**, via `tools/v9/push-video-v9.sh`. Merging this is dark: both flags default off.
