# C3 + doctrine round 2 — ledger

Branch `studio/c3-doctrine2` off origin/main 3e121d1 (enrich-fixes #561 merged). Test athlete
`3811cedd`, sport soccer. Probes under gitignored `probe-out/c3-doctrine2/` — every one read-only
on the database; `baseline-route.ts` spends planner calls through the REAL route and nothing else.
Measured 22 Sep 2026. Order built: A → S1 → B1 → B2 → B3 → D1 → S2 → D2; B4 and E are cards.

## Recon, before anything was built

- **The eval runner was the divergence.** `studioPlanEval.ts` records libraries by calling
  `assembleLibrary` and `derivePlan` directly; it never touches the route, the caster or `castTo`.
  This round's probe POSTs the real route (`/api/v1/me/studio/agent/plan` — the studio router is
  mounted under `/me`; a first run at `/api/v1/…` 404'd 33 times in 3 ms each, before any gate,
  $0) with a pasted Firebase token, and records the offered library in-process right before each
  call as a cross-check: a cast id outside that library (and not a swap) is a divergence. 0 of 33.
- **The lookalike is `a6a8b954`**: origin generated, IMAGE, athlete_present true, job `aea27a73`
  in generate mode carrying ZERO person references. Exactly S2's case.
- **Evidence shapes on her made-here photos (aggregate):** present-true with a person reference on
  the job 93; present-true with NONE 267; present-false 2. Uploads of her 15. So S1 removes 360
  from i2v and S2 restores 93. `brief.job.references` is on 426 of 442 jobs.
- **BOLYN product-only upload: `e64e900a`** (IMAGE, present false). The product-drop brief ran
  with a product for the first time this round.
- **The live-footage clause was prompt-only.** Nothing in code knew when it applied.
- **Ken Burns has a home:** `still.ts` already pre-encodes a photo into a clip; a zoompan variant
  measured 0.43–0.56 s wall for a 4 s 1080×1920 clip on ffmpeg 9.0.1.
- **edit_note** (`disposition` crop | enhance | reject | as_is, plus a note) is stored on every clip
  the lane read and reached nothing.
- **Price is a LIST ESTIMATE** from studio/pricing (Veo 4 s at $0.20/s, $0.40/s with sound; Seedance
  4 s at 720p) — no preview rows written. Not the Board's quote.

## A · Round-2 baseline, through the real route (n=3, 33 calls, 22 Sep 2026)

Planner tokens off the server log: 184,623 in / 163,342 out. **Booked at $1.86** ($1.25 / $10 per
M — the rate the $2.10 cap was set on); **$2.33 noted as the alternate** if Pro bills $2 / $12.
The registry lacks a per-token price for `gemini-3.1-pro-preview` (server/lib/models.ts
`GEMINI.pro`; studio/pricing prices images and video only), so the true figure is between them —
recorded for PR 5's card below. Mean 40 s per call, max 74 s.

| brief            | items | cast | camera slots | d076a790 share | i2v (made-here) | lookalike | floodlights | $ avg |
| ---------------- | ----: | ---: | -----------: | -------------: | --------------: | --------: | ----------: | ----: |
| adidas-ad        |   5.0 |  5.0 |          42% |            33% |           4 (4) |         0 |         3/3 |  2.48 |
| training-recap   |   4.0 |  4.0 |     **100%** |            49% |               0 |         0 |         0/3 |  0.20 |
| product-drop     |   4.7 |  4.7 |          63% |             7% |           4 (4) |         0 |         1/3 |  2.48 |
| announce         |   4.0 |  4.0 |         100% |             0% |           3 (0) |         0 |         0/3 |  1.41 |
| hype             |   5.3 |  5.3 |          64% |            36% |           4 (3) |         0 |         3/3 |  2.88 |
| thank-partner    |   5.0 |  5.0 |          44% |            28% |           3 (3) |         0 |         0/3 |  1.61 |
| real-footage     |   4.7 |  4.7 |     **100%** |            60% |               0 |         0 |         0/3 |  0.00 |
| day-in-life      |   6.0 |  6.0 |          47% |            18% |           6 (6) |     **3** |         0/3 |  2.87 |
| concept          |   5.0 |  5.0 |           0% |             0% |           7 (7) |         0 |         3/3 |  4.09 |
| boots-then-match |   3.7 |  3.7 |          39% |            11% |           4 (4) |         0 |         3/3 |  2.48 |
| complex-i2v-trap |   4.0 |  4.0 |          67% |            33% |           3 (3) |         0 |         0/3 |  2.21 |

**Predictions, all held.** Live briefs (training-recap, real-footage) ≥ 80% camera slots: **96%**
(25 of 26); zero i2v on both; d076a790 holds half of real-footage's slots. Non-live: every plan
carries ≥ 1 generated item (9 of 9 briefs, every cell) and a camera clip appears in **8 of 9**
briefs (concept is the exception, and should be — a night reel of a library with no night
footage). Lookalike cast as an i2v ≥ 1 of 33: **3 of 33**, all on day-in-life (offered in 12
cells, cast in 3). Floodlights on briefs naming no night feel ≥ 5: **10 of 30** (B4's before).

**The referendum on the live-footage rule:** it discriminates. On the two briefs whose sentence
asks for her footage the planner is 25/26 camera; on the nine that do not it is 51/128 (40%), with
a camera beat still present wherever her clip covers the content (announce 100% because its three
slots are two d076a790-free camera clips and the camera photo 517ed082 as the i2v).

**The number that matters for S1/S2 — 34 of 38 i2v items named a made-here ref.** Of the fourteen
made-here ref ids across the run, eight are identity-bound (their job carried her reference —
03d07851, 132e7373, 9b90c792, f0e9aa91, 493166ca, 6a2befda, 904d8bf4, e05973aa) and six are not
(2342131e, e67518db, 48d3326e, f9cd838a, c96680ef and the lookalike a6a8b954). S1 alone would have
refused 34 items; S1 + S2 refuse **13 items in 9 of 33 cells** (day-in-life 6, concept 4,
complex-i2v-trap 3 — c96680ef was the trap brief's i2v all three times, and is unbound) and keep
the bound eight. Every refused item swaps to a camera photo of her by query or is dropped and shown.

**Product-drop with a product (first time):** the BOLYN upload was cast as the product item 3/3;
no direction claimed she wears or holds it; no beat named BOLYN (0 of 13 beats across the three
cells). The invented product is not gone: #0's first beat is "Lacing up the new cleats" — the
brief's boots by another name, on a clip beat. B3's continuity clause is the re-run.

**Wart seen, not chased:** training-recap #0 held the BOLYN product-only upload as an `image`
($0) in a training recap — a bottle in a recap is rule 4's "earns its place" failing on a still.
Carded under B4's taste loop.

## Round-2 re-runs — predictions, written before the run (approved 22 Sep 2026, $1.50 cap)

Seven briefs at n=3 through the real route on the built tip (server restarted 12:40 from this
worktree, after f1df568): B's four (training-recap, real-footage, boots-then-match, product-drop
with e64e900a) and D2's three (adidas-ad, hype, concept). 21 calls.

- **B1** — training-recap and real-footage hold at or above A: camera slots ≥ 96% across the six
  cells, zero i2v. The explicit line is belt and braces on briefs the model already read right;
  a regression here would be the line, and would be a finding.
- **B3** — product-drop: adjacent beats name BOLYN in ≥ 2 of 3 cells (`bolyn-beats ≥ 1` per
  cell); zero directions off the product item claim she wears / holds / drinks it.
- **S1 + S2, on every cell** — no i2v item names an unbound made-here ref (the six ids from A);
  the bound eight may still appear; the lookalike a6a8b954 is cast 0 of 21. Any i2v that A cast
  to an unbound ref now swaps to a camera photo or is left out and shown.
- **D2** — adidas-ad: a pushed-in `image` at $0 appears in ≥ 1 of 3 cells (`pan ≥ 1`), and the
  cell's price is lower than A's for the same brief where it replaces an i2v. Hype and concept
  keep ≥ 1 i2v per cell — a "cinematic, loud" ask and a night reel want motion, and a push-in is
  offered as the choice for a look, a pose or a place, not for an action.
- **B4's before stands** — floodlights are not addressed this round; expect them again on
  adidas-ad, hype and boots-then-match.

## Round-2 re-runs — measured (21 calls, 22 Sep 2026; tokens 122,172 in / 97,107 out → **booked at $1.12** (1.25/10), $1.41 noted as the alternate (2/12), under the $1.50 cap; 0 divergent cells; lookalike 0 of 21)

| brief            | camera slots | d076a790 | i2v (made-here, unbound) | push-in cells | BOLYN beats | wears claim | floodlights | $ avg (A → now) |
| ---------------- | -----------: | -------: | -----------------------: | ------------: | ----------: | ----------: | ----------: | --------------: |
| training-recap   |          89% |      46% |                 0 (0, 0) |           2/3 |           — |           — |         0/3 |     0.20 → 0.00 |
| real-footage     |         100% |      76% |                 0 (0, 0) |           0/3 |           — |           — |         0/3 |     0.00 → 0.00 |
| product-drop     |          65% |      22% |                 3 (3, 0) |           1/3 |   0 · 5 · 2 |           0 |         1/3 |     2.48 → 2.21 |
| boots-then-match |          36% |       0% |                 4 (4, 0) |           1/3 |           — |           — |         3/3 |     2.48 → 2.74 |
| adidas-ad        |          42% |      25% |                 4 (4, 0) |           3/3 |           — |           — |         3/3 |     2.48 → 2.48 |
| hype             |          69% |      22% |                 3 (3, 0) |           3/3 |           — |           — |         3/3 |     2.88 → 2.82 |
| concept          |          17% |       0% |                 5 (4, 0) |           1/3 |           — |           — |         3/3 |     4.09 → 3.35 |

**Against the predictions, in order.**

- **B1 — held, by a hair.** Live briefs 27 of 28 camera slots = 96.4% (predicted ≥ 96%), zero
  i2v on all six cells. The one non-camera slot is training-recap #0's "The aftermath": a made-here
  still (8fbe1dff, unbound) taken as a PUSHED-IN IMAGE under "what I actually filmed". D2 made a
  $0 made-here still attractive on a live brief; S1 gates i2v and nothing wider, so as an image it
  is allowed. Two consequences, both acted on: the image card now says MADE HERE (the follow-up
  commit — it was the one card without provenance words); and rule 3's own-footage clause covers
  CLIP lines, not stills — carded under B4 ("a made-here still on a live brief"), not patched
  blind.
- **B3 — held.** BOLYN named in the beats beside the product item in 2 of 3 cells (#1 five beats,
  #2 two; #0 none), zero directions claim she wears / holds / drinks it. The A-run claim above is
  corrected: A named it in 0 of 13 beats. Not a claim of B3's, but seen: "Lacing up the new boots"
  survives as a beat on her CAMERA clip (#0, #2) — her sentence names the boots and the beat is on
  real footage, so it is the judge's call, not a fabrication by rule 7's definition.
- **S1 + S2 — held everywhere.** 0 of 19 i2v items name an unbound made-here ref (A: 13 of 38);
  the lookalike is cast 0 of 21 (A: 3 of 33). Every made-here i2v ref this run is identity-bound
  (03d07851, 132e7373, 9b90c792, e05973aa, f0e9aa91, 7ec80973 — verified on the jobs); concept #2
  reached for a camera photo of her (25499d98) instead. The unbound stills still appear as
  IMAGES (6ad0308d pushed-in on concept #1 and boots #0) — the S1 line, exactly.
- **D2 — held on hype, missed on adidas-ad's price.** A push-in appears in 11 of 21 cells. On
  adidas-ad it is 3/3, but on the campaign sign-off still (e5a29547 / 9b3a8d0e) that was already
  a $0 image — the i2v count is 4 → 4 and the price 2.48 → 2.48, so "instead of i2v" did not
  happen there. It DID on hype: A cast the camera photo 517ed082 as an i2v (#0, $3.62); now all
  three hype cells hold it as a pushed-in image ("Game face on", "The elite mindset") and hype
  #0 is $2.82. Hype and concept keep ≥ 1 i2v per cell (held). Concept 4.09 → 3.35 is mostly S1+S2
  (fewer castable i2v refs), not the push-in.
- **B4's before stands** — floodlights 10 of 12 on adidas-ad, hype, boots-then-match, product-drop.

## S1b — on an own-footage brief a made-here still is refused in every motion (approved 22 Sep 2026, size S)

**Built:** `fitsKind` takes `ownFootage` beside `picked`. When her sentence asks for her own
footage (the B1 detector — the same reading the planner is told), every photo kind — i2v ref,
held still, pushed-in still — takes S1's gate: her camera, her accounts, or a photo she picked.
S2's identity-bound arm does not apply there (a still generated FROM her is still not what she
filmed). Off an own-footage brief nothing changes. The route computes the flag from her sentence
and hands it to `castPlan`; the left-out reason says `own_footage`. Route fixture: the
training-recap sentence with a made-here still named as a held image → swapped to her upload;
pushed in with no upload → left out and shown (422, nothing castable); the same still on a brief
that does not ask for her footage → held as before. Mutation "held stills exempt": reds 2 in
cast.test and 2 in studio.agent.test, by name.

**Prediction, written before the run (the after-S1b runs approved as one set, 15 calls, $0.80 cap):**
training-recap and real-footage at n=3 → **28 of 28 camera slots**, zero i2v, zero made-here of any kind; a
made-here still the planner names is swapped to a camera photo of her or left out and shown.
Everything else in those cells (d076a790 beats trimmed, e64e900a held when the beat is the gear)
as in round 2.

### S1b, second finding — the leaked direction, and the acceptance pair (Adi, 22 Sep 2026, before the code)

**Live plan on f1df568, "recap my training, use live footage" (PR 1's acceptance brief, 10/10
camera on 8f6c17e at 11:22):** 2 of 5 camera at 13:09 — `castTo: [null (b-roll), e055746a:camera@0-3,
d076a790:camera@30.5-35.5, 37e0eedb:made-here (i2v), 6391794d:made-here (held)]`. Item 4's
direction was a6a8b954's description verbatim — "framed by the shoulders of her teammates in the
foreground" — after S1 swapped its ref to 37e0eedb (identity-bound, so S2 let it in): the swap
fixed the photo and leaked the words, and the Board's classifier read "her teammates" off it.

**The scrub (built into S1b):** on a swap or a drop of an i2v ref, a direction naming any
other-person noun (teammates, opponents, coach, fans, crowd, spectators, supporters, other
players, defenders, keeper — a closed list, unicode boundary) is replaced by the swapped photo's
own description (its beat on a drop), the capability prose kept, and the item carries
`rewritten` for the card. The planned photo is never rewritten. Mutation "direction kept on swap"
reds by name in cast.test and studio.agent.test. **Prediction:** day-in-life n=3 → zero
other-person nouns in i2v directions.

**The acceptance pair, measured BEFORE S1b on f1df568 (n=3 each, $0.60 cap):** brief 12
`acceptance-recap` "recap my training, use live footage" and brief 13 `acceptance-only` "only use
my real footage, recap my training" — added to the fixed set as ids 12 and 13, never reworded.
Adi's hypothesis: B1's line fired but is too soft under D2's $0 competition. The read: 13 beats
12 by ≥ 4 slots → the line is the bug, rewrite it (camera beats are the material; made-here only
for a moment no camera beat covers) inside S1b; equal and both ≥ 13 → the 2/5 plan was variance;
both ≤ 9 → a regression on this branch, bisected by prompt diff (B1 line, B2 bullet, B3 rule 7)
before S1b. After S1b lands, 12 and 13 again at n=3: **≥ 13 of 15 each.**

**Measured before S1b, f1df568, 6 calls (tokens 33,869 in / 29,834 out → $0.34 booked, $0.43
alternate; under the $0.60 cap — booked, 22 Sep 2026):** brief 12 **13 of 16** camera slots (cells of 6, 5, 5 — #0 and
#2 all camera with d076a790 trimmed into five beats each; #1 is the 2/5 pattern again: three
made-here HELD stills beside two camera beats); brief 13 **15 of 15**. The gap is 2 slots, under
the ≥ 4 that would convict the line, and both are ≥ 13 — by the rule set before the run, **the
2/5 plan was variance, and S1b ships as scoped.** What the variance IS: every non-camera slot on
brief 12 is a made-here still held at $0 — precisely the kind S1b refuses on an own-footage
brief. Brief 13's exclusivity ("only") closes the door in the model's reading alone; S1b closes
it at the cast for both wordings.

### After S1b — measured (d2d8d0d, server restarted 13:33, 15 calls, 22 Sep 2026)

Tokens 84,219 in / 79,779 out → **booked at $0.90, $1.13 alternate — $0.10 over the $0.80
cap, booked as an overage** (this run's calls averaged $0.060, above the session's $0.053–0.056; the cap was set
on the lower figure). 0 divergent cells; lookalike 0 of 15.

| brief            | camera / cast | made-here (any kind) | b-roll from words | i2v refs                              | other-person nouns in i2v | rewritten |
| ---------------- | ------------: | -------------------: | ----------------: | ------------------------------------- | ------------------------: | --------: |
| training-recap   |       13 / 14 |                **0** |                 1 | —                                     |                         0 |         0 |
| real-footage     |       13 / 13 |                **0** |                 0 | —                                     |                         0 |         0 |
| acceptance-recap |       12 / 14 |                **0** |                 2 | 5581e882 (camera) ×1                  |                         0 |         0 |
| acceptance-only  |       14 / 14 |                **0** |                 0 | —                                     |                         0 |         0 |
| day-in-life      |        9 / 17 |                    7 |                 1 | 132e7373 ×3, 91b22f93 ×2 (both bound) |                         0 |         0 |

- **S1b on training-recap + real-footage: held.** Every cast photo or clip is her camera — 26 of
  26 (the prediction's "28 of 28" assumed five-item plans; the ratio is what it claimed, 100%).
  Zero made-here of any kind, zero i2v. The one non-camera cast slot is a b-roll FROM WORDS
  (training-recap #0's opener, $0.61) — not a photo kind, so outside S1b by design.
- **Acceptance pair: 13 held (14 of 14); 12 is 12 of 14** — zero made-here, one camera-photo i2v
  (5581e882, the same photo the ad-brief control cast on 8f6c17e), and the two non-camera slots are
  b-roll from words (#1's opener, #2's bridge). Against "≥ 13 of 15": under by one slot on a
  14-slot run; by the thing the prediction was about — nothing made here standing in for her
  footage — it holds. #2 also shows the gate working in the open: an i2v whose made-here ref S1b
  refused, with no camera photo left to swap to, is LEFT OUT and shown rather than cast.
- **Day-in-life: zero other-person nouns in i2v directions — held.** No rewrite fired live,
  because S1 + S2 never swapped a ref this run (both i2v refs are identity-bound, cast as named);
  the scrub's live moment is the fixture's moment — a swap off a photo of other people — and the
  route test holds it. 7 made-here slots is the S1 line: off an own-footage brief, bound stills
  are hers to animate and any still is hers to hold.
- **Finding, carded as PR 2b (below), not Mia's:** on the four own-footage briefs the planner
  opened or bridged with a b-roll from words in 3 of 12 cells ($0.61 each). Rule 3 already says a
  generated shot enters only for a gap her camera does not cover, and an opener is not a gap.

## What was built (each its own commit, each mutation red by name before the commit)

| item | commit                                                 | mutation(s), red by name                                                                                                                                    |
| ---- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | made-here still never an i2v ref unless picked         | drop the provenance clause → 2 in cast.test, 1 in studio.agent.test (the teammates fixture)                                                                 |
| B1   | own-footage detector + one explicit prompt line        | return true always → 11 in footageAsk.test ("make me an ad" first), 1 in plan.test                                                                          |
| B2   | grounding: a generated shot shows her, or no one       | drop the bullet → 1 in plan.test; the fixture is S1's teammates still                                                                                       |
| B3   | rule 7: a cast product persists by name                | drop the sentence → 1 in plan.test                                                                                                                          |
| D1   | AI-edit chip: the clip's stored edit_note on the card  | note whatever the disposition → 1 cast.test + 1 route; chip on any kind → 1 agentLogic.test                                                                 |
| S2   | identity-bound made-here fits i2v (join, athlete-safe) | drop the arm → 1 cast.test + 1 route; athlete off the join → 1 cast.test                                                                                    |
| D2   | image `motion: "pan"` → still row → zoompan encode     | still ignores motion → 2 still.test; spec stores on a clip → 1; parser any kind → 1; boardStitch drops → 1; seed dead still → 1; setStillMotion any row → 1 |

**D2's prod-ffmpeg check (flip checklist §11):** `node:20-slim` + apt ffmpeg 5.1.9-0+deb12u1 on
Debian 12.13, `--platform linux/amd64`, `npm ci` + `npm rebuild sharp`, `still.test.ts` twice —
see the D2 commit for the counts. zoompan on 5.1 renders the same 60 frames at 1080×1920, limited
range, BT.709, and the first/last-frame diff holds.

**Gate on the S1b tip (d2d8d0d, whole suite, one jest at a time, in PR 3's returned slot):** 423
suites / 8,294 tests / 1 red — affiliationSync's "a year-only from/to", the house flake, in a file
this branch never touched; green on the one isolated re-run (8/8). Everything this branch touched
is green.

**Gate on the round-2 tip (f1df568, whole suite, one jest at a time):** every batch summary 0 failed,
"All suites passed", no red batch — the affiliationSync house flake was green this run. eslint: 73
errors project-wide, none in a file this branch touched (pre-existing). tsc on both configs clean
after every commit; prettier restored on every touched file (all were clean on main).

**S2's tenancy, as built:** every castable row comes through one SELECT with `generation_jobs`
LEFT JOINed on `generation_job_id` AND `generation_jobs.athlete_id = req.athleteId` — content.ts's
fail-safe for the same bare uuid. Read-only; primary-key join, no index added; studio/jobs.ts is
the table's only writer. Adi ruled it in lane (22 Sep 2026).

## Cards (not built)

### B4 · Floodlights by default — Mia's taste call, two drafts

Baseline: floodlights in 10 of 30 plans on briefs naming no night feel (adidas-ad 3/3, hype 3/3,
boots-then-match 3/3, product-drop 1/3). Rule 4's positive clause — "B-roll is WELCOME when it
serves a feel she named or imagery she asked for — the tunnel, the rain, the floodlights of a
night match" — is read as "a night-match feel is always available". One-line switch on rule 4,
gated on Mia's answer:

- **Variant 1 — atmosphere only in an ad.** Replace the clause's tail with: `…the floodlights of a
night match — and atmosphere of that kind belongs to an AD (objective showcase-product, or a
sentence that says "ad" or "spot"); on any other ask it is decoration.` Prediction: hype and
  boots-then-match lose their floodlights (0/6), adidas-ad keeps them (3/3); concept unchanged.
- **Variant 2 — atmosphere only when she names a feel.** `…the floodlights of a night match —
ONLY when her sentence or her feel names the night, the weather or the place; a feel she did
not name is never supplied for her.` Prediction: adidas-ad ("clean, confident, big-brand")
  loses them too (0/3); hype ("cinematic, high energy") is the ambiguous cell — "cinematic" is a
  feel, not a place — expect 1–2/3; concept unchanged.

Also under this card: a product-only still held in a recap (A's training-recap #0, the BOLYN
ball as an `image`; round 2's #1 again, pushed-in, "Closing on the gear") — rule 4 on stills. The
made-here still pushed-in on a live-footage brief (round 2's training-recap #0) is **resolved by
S1b** below, not a card; B4 keeps only the floodlights question.

### E · Evidence-based provenance tiering — gated on Mia's raw clips through the upload path

**The open question, answered from the code (22 Sep 2026):**

- Native OS picker (`use-media-library.ts` `pickFromCameraRoll`): `launchImageLibraryAsync` with
  `quality: 0.9` and no `videoExportPreset`. expo-image-picker 17.0.11 defaults the preset to
  `Passthrough`, so a VIDEO is copied, not transcoded — its container atoms survive to the PUT.
  `quality: 0.9` re-encodes a PHOTO, so photo EXIF is gone before the PUT.
- Camera-roll review import: photos only in this version; PUTs the original bytes.
- Web: the picker's `File` is PUT straight to GCS. Bytes unchanged.
- Server, images: `registerUploadedAsset` rewrites every image through sharp `rotate()` +
  `toBuffer()` with no `withMetadata()` — sharp strips EXIF by default. No photo keeps capture
  metadata whatever path it took.
- Server, videos: the upload object is never rewritten; ffprobe reads its header over a signed
  URL; the poster transcode writes elsewhere and keeps `original_gcs_path`.

So video atoms survive the app's paths IN PRINCIPLE — yet d076a790, the one real camera clip,
carries `no-device-metadata`. Either it was edited or exported before upload, or iOS's automatic
asset representation transcoded it on the way out of the picker (a HEVC / Dolby Vision capture
is the likely case). The code cannot tell which. **The test the card gates on:** one fresh,
unedited iPhone clip through the native picker and one through web, then `ffprobe` of the stored
object for `com.apple.quicktime.make`. Until that runs, signal 1 is a demotion and never an
exclusion, and the tiering (verified camera > unverified camera > identity-bound made-here >
made-here) stays a card.

### PR 2b · own-footage brief refuses b-roll from words (alongside the i2v demotion)

**What:** when `asksForOwnFootage` is true, a `broll` item is left out and shown (the honest-gap
line) rather than made from words — the cast-side twin of S1b for the one kind S1b does not
touch, because b-roll names no photo. Rule 3's text already says it ("a generated shot enters
only for a genuine gap her camera does not cover"); the after-S1b run showed the planner reading
an opener as a gap in 3 of 12 own-footage cells. One line in `castPlan` beside the `ownFootage`
gate, a route fixture on the acceptance-recap sentence, mutation "b-roll exempt" red by name.
**Prediction:** acceptance-recap n=3 → 14 of 14 camera; training-recap's opener gone. Sits with
the i2v demotion (verified camera before unverified, E's tiering) as PR 2b's pair.

### For PR 5's card — planner spend has no registry price

The registry lacks a per-token price for `gemini-3.1-pro-preview`: `studioPlanEval.ts` prints
"pass --usd-in/--usd-out for a figure", and this round's A was booked at an assumed $1.25 / $10
per M ($1.86) with $2.33 as the alternate. Until the price is on the registry every planner run
is booked on an assumption, and a cap set on one rate can be over on the other. Measured per-call
rate this session, at the booked $1.25 / $10 per M: **$0.053–0.060 per planner call** ($0.056 on
the 33-call baseline, $0.053 on the 21-call round 2, $0.060 on the 15-call after-S1b run —
prompt size moves it), and the after-S1b run went $0.10 over its $0.80 cap on the difference.
(Recorded here because this session does not hold PR 5's card file; carry it across.)

### S3 · S4 — rejected as the mechanism (recorded)

S3 (prominence + her-words on the line) and S4 (the tagger's `subject` after the backfill): the
lookalike passes both — prominence high, "she" throughout, subject "the athlete". No text signal
exists for a lookalike; the model cannot tell one. S1 + S2 are the shapes; the ladder's next rung
is E's tiering, not more text.

**Re-booked at the registry rate (PR 4 C5, 22 Sep 2026):** `gemini-3.1-pro-preview` is $2 / $12 per M (https://ai.google.dev/gemini-api/docs/pricing, read 2026-09-22; every prompt < 200k) — so the "alternates" were the real figures: A **$2.33** (over its $2.10 cap by $0.23), round 2 **$1.41**, before-S1b **$0.43**, after-S1b **$1.13** (over its $0.80 cap by $0.33); **$5.30 for the day, not $4.22**, and a planner call is **$0.071–0.075**, not $0.053–0.060.
