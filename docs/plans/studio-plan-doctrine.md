# Studio — planner doctrine + plan eval (report, before code)

> **Status:** REPORT. Nothing built. Worktree `/Users/adi/nomila-v2-worktrees/plan-doctrine`,
> branch `studio/plan-doctrine`, off `origin/main` at `b430f01` (C2 #557 merged).
> One PR, two halves with a clean seam: Half A (harness + fixtures + baseline) lands first as its
> own commits; Half B (prompt doctrine) lands on top, measured against A's baseline.

## 0. What the tree actually has (read, not remembered)

- **The planner** is `server/studio/agent/plan.ts` — `agentPrompt(ask)` builds one string, `parsePlan`
  refuses on shape (invented kind, unknown ref, segment, ref-on-b-roll, >6 items) and NULLS
  capabilities outside §8's lists, reporting each in `AgentPlan.nulled`. `derivePlan` logs one line
  per null under `capability_outside_vocabulary` and the count on `plan derived`. The transport is
  injected — CI never calls a model.
- **The library the planner sees is built in the route**, `POST /studio/agent/plan`
  (`server/routes/studio.ts` ~2129–2280): picks (always) → `searchMedia(prompt)` photos of her (16)
  → `rankWithoutHer(prompt)` scenes (8) → `listClips` newest 8 → refs `a1…aN`. Two `embedText`
  calls per assembly; the library **depends on the brief text**. This code is not exported.
- **Provenance** (`agent/provenance.ts`) folds `media_assets.origin` into three words. **A stitched
  compilation is not distinguishable by it**: `publishStitchOutput` (video/materialize.ts:872)
  writes `origin: "generated", media_type: "VIDEO", generation_job_id: NULL`, path
  `athletes/<id>/studio/stitch/<job>/output.mp4`; a generated i2v/t2v clip writes
  `origin: "generated"` **with** `generation_job_id` set (jobs.ts:235). So the planner's line says
  `from: made here` for both, and the OWN YOUR GAME trust problem cannot be addressed by a prompt
  rule on the label that exists. (§3.)
- **The current prompt already contains an anti-doctrine rule**: _"Where the idea is better served by
  a place, a detail or an object between shots of her, mix in "broll" — a video that is all
  close-ups of one person reads as a slideshow."_ It is the likeliest author of the generic
  spinning ball. Baseline must be measured with it in; Half B replaces it.
- The planner runs on `GEMINI.pro` at temperature 0.6, "a few cents" a call (config.ts). A plan is
  therefore not deterministic and not $0 — it is $0 of _generation_.
- The blind-judge pattern exists in `server/scripts/studioVideoBakeoff.ts`: `--sheet` writes
  `sheet.html` with cells shuffled by a fixed LCG seed behind `C01…` codes, `key.json` beside it and
  unlinked, `--reveal` joins. `probe-out/*` is gitignored except `runs.jsonl`.
- The still pipeline is a **pre-encode** (`video/still.ts`): sharp → upright fitted JPEG → ffmpeg
  `-loop 1 -t N` → mp4 that the engine joins like any clip. That is exactly where a zoompan would go
  (§5).

## 1. Half A — the plan eval harness

### 1.1 Files

| file                                          | what                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server/studio/agent/eval/briefs.ts`          | the fixture: 11 briefs, synthetic text, objectives from the closed list, per-brief _expectations_ (shown only on reveal)                                     |
| `server/studio/agent/eval/metrics.ts` (+test) | pure: kinds histogram, generation share, real share, b-roll count, null count/rate, refs unique, would-cast (pass-1 `fitsKind` against the recorded library) |
| `server/studio/agent/eval/sheet.ts` (+test)   | pure: the blind HTML from a list of cells + a key; renders each item the way the Agent screen labels it                                                      |
| `server/scripts/studioPlanEval.ts`            | the runner (below)                                                                                                                                           |
| `docs/probes/plan-eval.md`                    | ledger: the scoresheet format, the baseline numbers, and each later run's row                                                                                |

### 1.2 The runner — one command, three artifacts

```
DOTENV_CONFIG_PATH=/Users/adi/nomila-v2/.env \
npx tsx --require dotenv/config server/scripts/studioPlanEval.ts --run --n 3 --max-calls 40
```

1. **Record the library once per brief** (`probe-out/plan-eval/library/<briefId>.json`) by running
   the route's assembly under Adi's athlete id, read-only. Recorded so both configs see byte-identical
   inputs and re-runs cost no embedding. Refs only, no asset ids in the file the sheet reads.
2. **Run the live planner** `derivePlan` through the product transport, `n` times per brief
   (temperature 0.6 → repeats are the only way to tell doctrine from noise). Every reply is saved
   raw + parsed with the **prompt sha** and the git sha in `probe-out/plan-eval/runs/<sha>-<date>.json`.
   `--max-calls` is the spend guard (the transport returns no usage; a call count is the honest cap).
   `--dry` prints the prompts, their sizes and the call count, sends nothing.
3. **Sheet**: `--sheet run1.json run2.json` shuffles every (brief × config × repeat) cell behind a
   code; shows brief, objective, feel, the library lines, and the plan; never the config, never the
   expectation. `key.json` beside it.
4. **Score**: `scores.csv` — `code, i2v_reserved, stills_where_carried, real_clips_used,
broll_earned, product_rules, overall_mix, relevance, note` — each 1–5.
5. **Reveal**: `--reveal` joins scores + key → per-config mean and spread per criterion, per brief,
   plus the auto metrics, into a markdown block that is pasted into `docs/probes/plan-eval.md`.

### 1.3 Cost per run

| item                                  | count | each              | subtotal     |
| ------------------------------------- | ----- | ----------------- | ------------ |
| library recording (2 embedText/brief) | 11    | ~$0.0002          | ~$0.00, once |
| planner calls, one config, n=3        | 33    | a few cents (Pro) | ~$1–2        |
| generation                            | 0     | —                 | **$0**       |

A baseline + doctrine comparison is ~66 calls, ~$2–4. Cheap enough for every planner-touching merge;
`--n 1` for a smoke (~$0.50).

### 1.4 What is committed and what is not

Committed: the brief fixture (synthetic), the metrics + sheet modules with tests, the runner, the
ledger with **aggregates only** (scores, mixes, null rates). Not committed: the recorded library and
the plans (tagger text about real photos of a real person — a bib's text has already surfaced as a
"surname" once). They live under the gitignored `probe-out/`.

### 1.5 The brief set

| id               | objective                   | brief (paraphrased)                    | expectation on reveal                                      |
| ---------------- | --------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| adidas-ad        | showcase-product            | an adidas ad                           | b-roll only if tied to adidas; the device-evidence brief   |
| training-recap   | recap                       | this week's training, real footage     | mostly real (clip/image)                                   |
| product-drop     | showcase-product, 1 product | new boots drop                         | product per rules, product last/first, no invented product |
| announce         | announce                    | announce the partnership               | mix; no invented logos/text                                |
| hype             | grow-following              | cinematic season-opener hype           | mostly generated is acceptable                             |
| thank-partner    | thank-partner               | thank the brand for the season         | mix                                                        |
| real-footage     | recap                       | "use my real footage"                  | clips as-is; **stitched output must not be "your clip"**   |
| day-in-life      | grow-following              | a day in my life                       | mostly stills/clips                                        |
| concept          | concept                     | an idea for a night-match reel         | mostly generated                                           |
| boots-then-match | recap                       | tying my boots, then the match         | image/i2v simple beat, clip for the match                  |
| complex-i2v-trap | grow-following              | me beating three defenders and scoring | never i2v; clip or b-roll or leave out                     |

Eleven, so the "mostly real" and "mostly generated" ends are each covered by two.

### 1.6 Predictions for the baseline — written before the run

- b-roll present in ≥ 8 of 11 briefs (the "mix in broll" rule fires almost always).
- Mean generation share (i2v+broll+product ÷ items) ≥ 0.7.
- `clip` used in ≤ 3 briefs; `image` in ≤ 2 (both kinds are offered but nothing prefers them).
- The stitched compilation is cast as "your clip" in `real-footage` in at least 1 of 3 repeats
  (it is the newest clip, and `listClips` is newest-first).
- Null rate: unknown; this is the first measurement. Recorded, not predicted.

## 2. Half B — the doctrine, prompt-side

One `DOCTRINE — HOW TO CHOOSE` block in `agentPrompt`, exported heading as a deletion tripwire
(the existing `GROUNDING_HEADING` pattern), **replacing** the "mix in broll" rule:

1. `i2v` only for one simple, animatable moment — a pose, an expression, a kick; never a sequence of
   actions or a scene with several things happening.
2. Hold a photo (`image`) when the photo already _is_ the beat — on your own judgment, not because
   she said "still"; the prompt never mentions the words hold/still as triggers.
3. Use a `clip` as it is (or one beat) whenever a CLIP line covers a beat.
4. `broll` must earn its place: tied to the brand, product or story in her ask; if no such scene
   exists, plan no b-roll — a plan with no b-roll is fine.
5. Casting by origin: for a shot of her prefer `her camera` over `made here`; a `made here` clip is a
   last resort; a `stitched here` clip is never used as her footage (see §3 for why this label must
   exist first).
6. A board of N items is not N generations: when the library holds real material that fits, at
   least one item is a `clip` or an `image`.

Each rule is one sentence in the prompt and one tripwire test; the mutation for each is "delete that
sentence → its test is red by name". The prompt sha changes, so Half B's run is a new recording.

### 2.1 Predictions for doctrine vs baseline — to be written after the baseline exists, before the

prompt edit is committed. Rules that do not move their criterion by more than the repeat spread get
flagged as such in the ledger, not defended.

## 3. Boundary questions for Adi (each is code outside "prompt + harness + fixtures")

**3.1 The stitched-compilation label.** Rule 5 cannot be written against `made here`. Two options:

- (a) a fourth provenance `stitched-here`, folded in `cast.ts toCastable` from
  `origin='generated' AND generation_job_id IS NULL` on a video row (with the `/studio/stitch/` path
  as a second witness), `PROVENANCE_LABEL` gains "stitched here". ~15 lines in `server/studio/agent`,
  no DDL, one fold test, one prompt tripwire. The planner then reads it and rule 5 can say
  "never".
- (b) exclude those rows in `listClips` so the planner never sees them. Stronger (cannot be cast at
  all), also ~5 lines of SQL in agent code.
- **Recommend (a) + (b)**: the trust problem is not taste, so the caster should not offer the row;
  the label is still worth having for the line the planner reads when a stitched row arrives as a
  _pick_. If you want prompt-only, (a) alone; the harness will then show how often "never" holds.

**3.2 Library assembly is inside the route.** The harness must run "the live planner with the real
library". Either it copies ~40 lines of the route's offer/room logic (drifts silently the next time
the route changes) or the assembly is extracted to `server/studio/agent/library.ts` with the route
calling it — behaviour byte-identical, held by the existing `routes/studio.agent.test.ts`.
**Recommend extraction**; the harness then calls the same function the product calls. Your call —
it touches `routes/studio.ts`.

**3.3 The planner spends.** Half A is "$0 of generation", not $0: ~$2–4 per baseline+doctrine pass
on Pro. `--max-calls` is the guard.

## 4. Where doctrine should live long-term — recommendation

**Prompt for all six rules now; parser for none of them; caster for the trust rule.**

The parser today refuses on _shape_: an invented kind, a ref it was not shown, a segment the clip
lacks, a ref on b-roll. Every one of those is a money or identity decision the prompt cannot be
trusted to keep, and every one has a crisp predicate. Mix is neither. "An all-generation plan is
wrong" is true for `training-recap` and false for `hype` and `concept` — it depends on what the
library holds and what she asked for, so a parser that refuses it needs the library and the ask,
which is a second planner in disguise. It would also refuse the _right_ answer for a thin library,
and refusal today is "I couldn't plan that", which teaches her nothing.

The exception is rule 5's stitched output: it is a trust problem with a crisp predicate that lives on
the row, not in taste — so it belongs in the caster (3.1b), the same place tenancy lives, never in
the prompt alone.

What the eval gives instead of a parser gate is the regression line: generation share, b-roll
count and null rate per merge, blind-scored against the same eleven briefs. If a later model
regresses the mix, that line moves before a device does. Revisit parser-side enforcement only if
two consecutive runs show a prompt rule holding under 70% on its criterion — then the bigger
hammer has an argument, and the harness has the numbers to make it.

## 5. Image-as-clip (Ken Burns) — decision only

**Where it goes:** `video/still.ts stillEncodeArgs` is the only site that turns a photo into an mp4;
a zoompan is a `-vf` change there: `zoompan=z='min(1+0.0008*on,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=<fps*sec>:s=<W>x<H>:fps=<fps>`
on the prepared frame. `zoompan` has existed since ffmpeg 2.x, so Debian's 5.1 in prod has it
(unmeasured, like every ffmpeg fact on prod). Known cost: zoompan rounds x/y to integers and jitters
on a 1:1 frame; the standard fix is to upscale the frame ~4× first, which is CPU, not money — a
3 s 1080×1920 hold stays well inside the encode budget the still already measured (1.9 s fitted).

**What it costs to build:** the ffmpeg half is S (one args function, one pin test, one live encode
by eye). The _option_ is not: it has to travel plan item → Agent screen → Board still row → stitch
position spec → materialize → still.ts, which is the C1b path in reverse (five sites, client and
server) and is a Board/stitch change by the boundaries you set. **Not built in this PR.** Card it as
"C1c — a held photo may move" after doctrine; the doctrine prompt says nothing about motion on stills
until the option exists, so the planner is never asked for something the Board cannot make.

## 6. Verification plan

- Gates: `check:types`, `lint`, `test` (whole suite, one run at a time), and
  `npx tsc --noEmit -p tsconfig.jest.json`.
- New tests: metrics (pure), sheet (pure: no config leaks into the HTML; key holds it), briefs
  (objectives in the closed list, ids unique, every expectation names a criterion), six doctrine
  tripwires, fold test for `stitched-here` if approved, listClips exclusion test on PGlite if
  approved.
- Mutations, red by name: each doctrine sentence deleted; the sheet printing the config; the key
  written into the sheet; `--max-calls` removed; a stitched row folded as `made-here`; the exclusion
  clause dropped from `listClips`.
- Revert check: a plan on the Half A commit is byte-identical to main for the same transport reply
  (the prompt does not change in Half A).

---

## 7. Decisions (Adi, 2026-09-22) and what Half A found while being built

- **3.1 approved, both halves.** Enforcement in the caster, the label for the eval. Built as commits
  `3343378` (label + `listClips` exclusion, pinned against the real publisher's row, either witness)
  and `f751fcd` (the exclusion moved to the OFFER — see below).
- **3.2 approved.** Extraction as its own commit `88c2f52`; the route suite is the mutation check
  (scene room dropped → 3 red; picks-first dropped → 1 red). Dropping the CLIP room reds nothing
  there: the fixture clip also comes back through the photo search. Noted, not fixed.
- **3.3 approved** with two riders, both built: `--max-calls` defaults to 80; tokens are printed at
  the end of every run (the transport now reports usage, commit `95dce9d`); dollars only from
  `--usd-in/--usd-out`, since the registry carries no per-token price for Pro and a guessed one is
  worse than none.
- **Temperature and n.** `PLAN_TEMPERATURE` is exported and recorded in every run's metadata with
  the model, thinking config, prompt fingerprint and git sha. Baseline at n=3; the reveal marks
  ambiguous cells and the ledger names the n=5–6 re-run of just those briefs as the escalation
  path before any rule is flagged.
- **Parser-for-none / caster-for-trust, Ken Burns decision-only, probe-out gitignored, zip
  untouched:** all as argued, all standing.

**Found while building:**

- **The exclusion had a hole.** The harness's first dry run showed `stitched 8` on four briefs.
  searchMedia has no media_type filter, so compilations ranked among the 24 "photos of her" and
  filled the clip room without passing `listClips`. The refusal now lives on the offer, the one
  door every room passes through; a pick still goes through, labelled. Route-level test, mutation
  red by name.
- **Recap-like briefs leave the planner 3–4 photos of her.** The search's 24 are mostly her videos
  on those sentences. Product behaviour the doctrine half will have to plan around.
- **`product-drop` runs without a product** unless `--product <assetId>` is passed; the library has
  no product-only shot. `product_rules` is blank on it this round.

## 8. After the baseline (2026-09-22) — what Half B has to be

The baseline is in `docs/probes/plan-eval.md`. Two of my four predictions missed in the planner's
favour: it already uses clips in 11/11 briefs and its mean generation share is 0.57. The doctrine
problems are in the directions, not the kind counts: generic b-roll (16/16 stock scenes), "real
footage" that is made-here (85 of 88 CLIP lines), held photos almost never chosen.

**Rules 1–4 and 6 are prompt-side as planned.** Rule 5 cannot be: the caster offers her newest
eight clips and every one of them is generated, so "prefer her camera" has nothing to prefer.
Proposal, ~10 lines in `cast.ts listClips`: order by provenance (camera, synced, made-here), then
newest; PGlite test; mutation = drop the provenance order. This changes what the planner SEES, so:

- **Arm A** `doctrine` — the doctrine prompt on the baseline's recorded libraries (prompt effect only).
- **Arm B** `doctrine-camera-first` — the same prompt on re-recorded libraries with camera-first
  listing (prompt + offer). Another ~$2, 33 calls.

Three arms on one sheet (99 cells) is a lot of judging; the reveal's two-run diff would be run
twice (baseline→A, A→B). Alternative: skip A and accept the confound, arguing that rule 5 is
worthless without the listing change anyway. **I recommend running both arms** — the harness
exists to say which lever moved what, and this is the first question it can answer.

Half B predictions get written after this is decided, before the prompt commit.

## 9. Half B as built (2026-09-22)

Adi's process call: the first baseline's cards were read, so it is the diagnostic read; a fresh
baseline takes its place on the combined sheet; three arms (fresh baseline / doctrine on the
baseline libraries / doctrine on camera-first libraries), 99 cells, scored blind by Adi.

Commits after the baseline: `c68912b` plan-level gap lines (parsed, capped) · `ab8f078` camera
clips listed first · `8efe556` three new metrics (filler clips, axes coverage, gaps) + library
sets · `f04a4d8` diagnostic read + predictions (before the prompt) · `d3e9a8c` the nine-rule
doctrine block replacing the slideshow line, tripwires and three mutations.

**Where each rule lives**, applying the §4 split consistently: rules 1–4, 6, 9 are prompt (taste,
no crisp predicate). Rule 5's stitched clause is the caster's offer (code); its camera preference
is the listing order (code) plus the prompt. Rule 7's rival-brand clause is already the caster's
brand flag (code); "never invent a product" has no crisp predicate on text, so it is prompt, and
the eval's `product_rules` column plus the gap count are how it is measured. Rule 8's gap line is a
parsed, capped field (code) the prompt asks for. Nothing was added to the parser's refusals.

**Not done, on purpose:** the Agent screen does not show `gaps` yet (client is out of this PR's
lane); the route drops them. A follow-up card: "the plan's gap lines reach the Agent screen".
Rule 7 is prompt-side; if the combined sheet still scores product-drop at 1, the next hammer is a
caster check that refuses an i2v/b-roll direction naming the promoted product — argued then, with
the numbers.

## 10. Outcome (2026-09-22)

v2 merges. Against the fresh baseline, blind: broll_earned 3.45 → 4.7, stills 3.30 → 4.0, real
clips 4.24 → 4.6, product-drop's product_rules 1.0 → 4.0 (camera-first), and after the v2 pass mix
3.55 → 3.94 and relevance 3.85 → 4.28 on the re-run briefs, with zero fabrication and zero filler.
The one regression is aesthetic (floodlights by default where no feel is named) and is a round-2
card. Full numbers, predictions and verdicts: `docs/probes/plan-eval.md`. The eleven-brief eval
is the per-merge regression artifact from here: one command, ~$2 a full pass.
