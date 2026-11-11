# PR 15.1 — Composer boundary — ledger

Worktree `composer-boundary`, branch `studio/composer-boundary` off origin/main **487053e2** (#588
`chore/composer-dev-flag` merged on top of #587). The only change between PR 15's merge (b5469982) and
the tip is one `.env.development` line (`EXPO_PUBLIC_STUDIO_COMPOSER=false`), so **no cited line moved
for that reason**. Upstream unset on the branch (it was created tracking origin/main). `npm ci` clean.
Artifacts go under gitignored `probe-out/composer-boundary/`. Phase R: read-only, $0, no jest, no
server, no DB. The C4 "before" count below was MEASURED with a scratch tsx script over the pure modules
(bogus `DATABASE_URL`, no model, no network) — deterministic code, so evidence, not a claim.

PR 16's ledger (`docs/probes/flow-eval.md`) is untracked in the `flow-eval` worktree; its §0.3, §2.3,
§5 and cards K3–K6 were read there, not edited.

## Phase R — claims

Verdicts: CONFIRMED / STALE (behaviour holds, line moved) / WRONG / PARTIAL. Every cite re-read at 487053e2.

### The block's own cites, re-verdicted first

| # | Cite in the block | Verdict | At the tip |
|---|---|---|---|
| B1 | storyboardRun.ts:111 calls `slotsAllowed(row)` with no composer | **CONFIRMED** | `shotFor` :110-118, `const allowed = slotsAllowed(row);` :111. `shotFor` takes no flag and `clipRequestFor` :60-94 / `boardRequests` :171-199 have none to give it. |
| B2 | default false at storyboardLogic.ts:458-461 | **CONFIRMED** | signature :458-461 (`composer = false`), body :462-474: held → `[]`, photo → `["movement"]`, photo-less → six with the flag, four without. |
| B3 | withPlannedShot(composer=true) sets them, agentLogic.ts:406 | **CONFIRMED** | `withPlannedShot` :400-428; `slotsAllowed(row, composer)` :406. |
| B4 | COMPOSITION / MOTION phrase tables video/prompts.ts:303-326 | **CONFIRMED** | `COMPOSITION` :303-315, `MOTION` :317-326; rendered only by `settingLine` :402-413 (b-roll template). |
| B5 | "15 of the 48 never render through the Board" | **CONFIRMED (measured)** | C4: generated b-roll renders 33/48 — composition 0/7, motion 0/8. |
| B6 | brandBoardSeed passes `campaign !== null`, agentLogic.ts:754 | **CONFIRMED** | `brandBoardSeed` :743-758; `seedRowsFrom(answer.items, nonce, stillSec, campaign !== null)` :754. |
| B7 | rowsOf never calls withPlannedShot for held rows, :315-356 | **CONFIRMED (range approximate)** | `rowsOf` is :306-392. Clip branch :315-331 and image branch :332-354 return without `withPlannedShot`; :355 opens the b-roll branch, which does call it (:359), as does the photo branch (:378). |
| B8 | Join reasons joinLogic.ts:32-41 | **CONFIRMED** | `JoinReason` :32-41 (nine); `chooseJoin` :70-84. |
| B9 | recorded in BoardStitch.joins, boardStitch.ts:94,175 | **CONFIRMED** | field :94, written `joins[key] = decision` :175 inside `joinInto` :162-179; returned :349. The body is `toStitchBody(...)` :341 — no join in it. |
| B10 | StoryboardRow.droppedSlots, storyboardLogic.ts:192 | **CONFIRMED** | :192 (doc :186-191). |
| B11 | only exit a __DEV__ console log, StoryboardTab.tsx:925-942 | **STALE (+3/+2)** | `onStitch` :923-957; the log comment :928, `if (__DEV__ && STUDIO_COMPOSER)` :930, `console.log` :931-944, after `queueStitch.mutateAsync(stitchPlan.body)` :926. |
| B12 | composer.md:315-316 says the opposite of the code | **CONFIRMED** — and **:309-310 is wrong too** | See C8. |
| B13 | PR 15's fourteen mutations were each on one side of the boundary | **CONFIRMED** | composer.md:190-205: 1-5, 8 client-only (joinLogic / boardStitch / agentLogic tests); 6, 7, 9-12, 14 server-only; 13 spans three files but each is one side. No test drove a seeded row into a request, or a stitch body into the server. |

### C1–C8

| # | Claim | Verdict | At the tip |
|---|---|---|---|
| C1 | `slotsAllowed` signature, default, every call site | **CONFIRMED** | `(row, composer = false)` storyboardLogic.ts:458-461. Non-test call sites (4): storyboardLogic.ts:736 `setShotSlot` passes its `composer` param (caller StoryboardTab.tsx:1166 passes `STUDIO_COMPOSER`); agentLogic.ts:406 passes its param; StoryboardTab.tsx:2072 passes `STUDIO_COMPOSER` (chip rendering); **storyboardRun.ts:111 passes nothing** — the only one. Tests: storyboardLogic.test.ts :775, :781, :1164, :1326 pass nothing (legacy pins, correct); :1546-1569 pass the flag. |
| C2 | `withPlannedShot` — what, for which kinds, where skipped | **CONFIRMED** | Keeps the item's `shot` slots the row may carry; with the composer on, names every other set slot with `droppedSlotReason` as `droppedSlots`; returns the row untouched when nothing is kept or named (:400-428). Called for photo-less b-roll (:359) and photo rows `motion`/`product` (:378). **Skipped** for `clip` (:315-331) and `image` (:332-354). Consequence: the cast item's `shot` (server cast.ts:975 `toShotSpec(item.capabilities)`, set for every kind, held included) is dropped on a held row with no record; `droppedSlotReason`'s `nothing-filmed` arm (storyboardLogic.ts:491) is unreachable from a seed. Measured: 0 drops recorded on held rows for all 48 members (C4). |
| C3 | Composer-flag inference sites | **CONFIRMED — one inferred, one omitted** | Full grep of client + server, non-test (`STUDIO_COMPOSER`, `composerEnabled`, every `composer` param and every caller): **inferred from data: 1** — agentLogic.ts:754. **Omitted (defaults to off on a flag-on path): 1** — storyboardRun.ts:111. Everything else reads the flag: AgentScreen.tsx:368, :399, :441; BrandPlanStep.tsx:175; StoryboardTab.tsx:851, :899, :930, :1166, :1594, :2072, :2076, :2137-2139; TimelineBuilder.tsx:780; server `toShotSpec` / `capabilityProse` default `composerEnabled()` (capabilities.ts:269, :316); routes/studio.ts:3091-3092. **Not an inference, stated so it is not mistaken for one:** `planSeedExtras` :775 `campaign === null ? null : rhythmFrom(campaign)` is a data-null check (no brief → no reading → no rhythm); every one of its three callers gates the campaign on the flag at the call site (AgentScreen.tsx:441, agentLogic.ts:566, and :757 via BrandPlanStep.tsx:175). It is hardened anyway in B, inside `brandBoardSeed`, so a campaign passed with the flag off can never produce a rhythm. |
| C4 | Render count today, per row kind, all 48 | **MEASURED** | See the R-1 table below (before half). |
| C5 | Join reasons, the body, the cheapest server home | **CONFIRMED + candidate named** | Nine reasons joinLogic.ts:32-41. `toStitchBody` stitchLogic.ts:836-876 sends `clips` (only `WIRE_FIELDS`, :214-216), `target`, `bed`, `bedAssetId`, `bedLevel`, `bedStartSec`, `look` — no reason, no row key, no plan id. Server: `parseStitchSpec` spec.ts:272+ **rebuilds the spec from known fields**, so an unknown key is silently dropped today; `queueStitch` stitchJobs.ts:100-113 inserts it into `studio_stitch_jobs.spec` (jsonb NOT NULL, schema.ts:1953). **Candidate: an optional `composer` record on the stitch spec, in the existing jsonb column — no DDL.** Why: it is the stitch's own durable, athlete-scoped record (row carries `athlete_id`), its id is the `stitchId` the client already holds, and the runner reads the spec through `readStoredSpec` → `parseStitchSpec(spec, false)` (spec.ts:634-636) and `toStitchRequest` builds ffmpeg input from named fields only, so a record field reaches no argv. **PR 11's machinery is the wrong home:** the cost JSONL is per-instance and ephemeral on Cloud Run (costLog / jobs.ts:138-140), and a stitch writes no cost line by design (routes/studio.ts:2884-2886: "no cost row … a stitch is not a purchase"). |
| C6 | droppedSlots — where set, what it holds, every drop or some | **PARTIAL (some)** | Set only by `withPlannedShot` agentLogic.ts:411-419, only with the composer on. Holds `{slot, value, reason}` with `reason ∈ photo-decides \| in-her-sentence \| nothing-filmed` (storyboardLogic.ts:196-209). Produced for every drop on a **photo** row (37 of 37 non-movement members, measured). **Never on a held row** (C2). Never on a photo-less row because nothing drops there once R-1 lands (today composition/motion are kept on the row at seed and stripped at send — a drop with no record at all, the worst of both). Leaves the client nowhere but the dev log (B11). |
| C7 | What PR 16's census captures on the Board path | **CONFIRMED — its expectations flip; one call needs an argument for the delta to show** | flow-eval `census/flows/brief.ts` imports the pure client functions directly: `seedRowsFrom(…, composer)` :229, `planSeedExtras(…, composer ? campaign : null)` :232, **`boardRequests(seed.rows, seed.objective, planId)` :236 — three arguments**, `boardStitch(…, composer ? {rhythm} : null)` :266-275, and `parseStitchSpec(stitch.body)` :279 (captures `stitch_body` with `joins` :277). What flips after this PR, flags on: §2.3 row "Renders — Board b-roll: 4 of 6 slots" → 6 of 6; §5 **P-caps** ("15 members never render through a Board request") → 0; **P-dead** entries `ShotSpec.composition` and `ShotSpec.motion` on the Board path, and `StoryboardRow.droppedSlots` ("no persisted reader") → alive; §2.3's held-row sentence and §2.6 "Join reasons never reach the spec" → false; K3–K6 closed. **For the census to SEE the render delta, its :236 call must pass the new fourth argument** (`boardRequests(…, composer)`); this PR keeps the argument optional, so its current call compiles and keeps today's stripping — a replica lag, not a break. The spec capture at :279 picks the record up with no edit IF the parser reads `composerEnabled()` by default (proposed) and the census's flags-on run sets `STUDIO_COMPOSER` (census.test.ts:100 lists it). New `ComposerInput` fields are optional, so :266-275 still compiles. Its M14 ("strip composition in the Board path and expect the census to name it") becomes a live mutation instead of a description of main. **To report to PR 16 on merge; their files not touched.** |
| C8 | composer.md's wrong sentences | **CONFIRMED wrong, two places** | **:315-316** (inside the "Consequence with the flag on" bullet :313-316): "they are named on the row instead. On b-roll all six slots are phrased structurally." — on a Board b-roll row composition and motion are set on the row at seed and stripped before the request (storyboardRun.ts:111), so four of six are phrased; all six only by a direct API call. **:309-310**: "`nothing-filmed` (a held row); written on the row as `droppedSlots` by `withPlannedShot`" — `withPlannedShot` never runs on a held row (C2), so `nothing-filmed` is never produced. Corrected text (R-5) below. |

### New facts (not in the block)

| # | Fact | Verdict | At the tip |
|---|---|---|---|
| N1 | **The quote key cannot see composition or motion** | **CONFIRMED — R-1 turns it into a spend-against-stale-preview bug** | `rowSignature` storyboardLogic.ts:523-543 lists the shot as `["framing","movement","lighting","environment"]` :537-541. Its own header (:510-522) is the rule: "EVERY FIELD `clipRequestFor` READS HAS TO BE IN HERE, OR SHE SPENDS AGAINST A STALE PREVIEW." Harmless today only because composition/motion never reach the request. Once R-1 sends them, a composition chip tap (offered with the flag on, StoryboardTab.tsx:2072) would not re-quote, and the run would spend the preview frozen before the tap. **Must ship in the same commit as R-1.** Flag-off identity kept by appending the two terms only when either is set (flag off, nothing can set them: `setShotSlot` refuses, seed strips). |
| N2 | Photo-from-her rows: `static` renders the default | **CONFIRMED (measured)** | identity-static uses `MOVEMENT_ON_HER[shot?.movement ?? "static"]` prompts.ts:424 — asking `static` is byte-identical to asking nothing (by design, :238 "choosing `static` and choosing nothing are the same prompt"). So an i2v-of-her row renders 10 of 11 movement members distinguishably; a product-from-photo row (b-roll template, `MOVEMENT_ON_SCENE`) renders 11. |
| N3 | The server already accepts all six slots | **CONFIRMED** | Preview route validates `shot` against `SHOT_SLOTS` with no flag (routes/studio.ts:531-547); `brief.ts:960` freezes `normalizeShotSpec(input.shot)`. **R-1 needs no server change.** |
| N4 | Row key → plan item | **CONFIRMED** | Seeded row keys are `agent:<nonce>:<i>` with `i` the index into `answer.items` (agentLogic.ts:320, :339, :362, :381); cast keeps uncast items in place (cast.ts:970-972 loops `plan.items.entries()`), so `i` indexes the stored plan's items. A dropped slot's row key plus the plan id is a join to the planner's ask. |

## R-1 — render count per row kind, five axes (all 48 members)

Before is **measured** at 487053e2 (`probe-out` script in scratch, $0). After is **predicted** (P-render),
to be measured with the same script in V. Flags on both sides (server `toShotSpec(caps, true)`, client
`seedRowsFrom(…, true)`). "Renders" = the compiled prompt differs from the same request with no shot.

| Row kind | camera (11) | movement (11) | lighting (11) | composition (7) | motion (8) | total | drops recorded |
|---|---|---|---|---|---|---|---|
| generated b-roll — before | 11 (8 distinct) | 11 | 11 | **0** | **0** | **33/48** | 0 (none named; 15 stripped silently at send) |
| generated b-roll — **after (P)** | 11 (8 distinct) | 11 | 11 | **7** | **8** | **48/48** | 0 (nothing drops) |
| i2v from her photo (person) — before = after (P) | 0 | 10 (+ `static` ≡ default) | 0 | 0 | 0 | 10/48 | 37 → 37 |
| product from a photo (object) — before = after (P) | 0 | 11 | 0 | 0 | 0 | 11/48 | 37 → 37 |
| held still — before / **after (P)** | 0 | 0 | 0 | 0 | 0 | 0/48 | **0 → 48** (`nothing-filmed`) |
| held clip — before / **after (P)** | 0 | 0 | 0 | 0 | 0 | 0/48 | **0 → 48** (`nothing-filmed`) |
| bridge — before = after (P) | 0 | 0 | 0 | 0 | 0 | 0/48 | 0 — structural, see below |

Lighting (the addendum): on the Board's b-roll row it **already renders 11/11 today** — lighting is one of
the four legacy slots `slotsAllowed(row)` keeps without the flag. The bug is composition and motion only.
On every row from a photo it renders 0 by rule (`photo-decides`), before and after.

**Every member that still cannot render through a Board request after the fix, with the reason:**
- *Generated b-roll:* none fails. Three collapse onto another member's phrase — `medium_wide` → the
  `medium` phrase; `extreme_close_up` and `macro` → the `close` phrase (capabilities.ts FRAMING_OF;
  prompts.ts FRAMING_ON_SCENE has 8 framings for 11 camera members). They render; they are not
  distinguishable.
- *i2v from her photo:* 38 — camera 11, lighting 11, composition 7 (`photo-decides`: the photo already
  has them, `slotRefusal` prompts.ts:366-393), motion 8 (`in-her-sentence`: the identity templates carry
  no action line), and movement `static` (renders the measured default line, identical to no ask).
- *Product from a photo:* 37 — the same minus `static`.
- *Held still / held clip:* all 48 — nothing is filmed. After the fix each is **recorded** with
  `nothing-filmed`, not skipped.
- *Bridge:* all 48 — no plan item ever becomes a bridge (bridges are the Board's own requests,
  `bridgeRequestFor` storyboardRun.ts:137-168 sends no `shot`), and `slotRefusal` refuses every slot on a
  transition (prompts.ts:372-376). There is no capability on a bridge to drop, so there is no record;
  the row the bridge arrives at carries and records its own.

## R-2 — the flag, read not inferred

Two sites, fixed the same way: `brandBoardSeed` takes the composer as a boolean read from
`STUDIO_COMPOSER` at BrandPlanStep.tsx:169-176 (appended optional param, default `false`, so
brandPlan.test.ts:235's four-argument call still compiles) and gates its own rhythm on it too; and
`boardRequests` → `clipRequestFor` → `shotFor` take `composer` (optional, default `false`), passed
`STUDIO_COMPOSER` at StoryboardTab.tsx:377 and AgentScreen.tsx:367 (the estimate is the Board's own
requests, so it must ask for what the Board asks for).

## R-4 — where reasons land (proposal)

`studio_stitch_jobs.spec.composer`, written only with the composer on (client and server):

    composer: {
      joins:   [{ key, kind, reason }]           // aligned 1:1 with spec.clips — joins[i] is the join INTO clips[i]
      dropped: [{ row, slot, value, reason }]    // every row's droppedSlots, row = the Board row key
      planId?: uuid                              // D-2
    }

Parsed by `parseStitchSpec` as closed sets: `kind ∈ cut|fade`, `reason` ∈ the nine, `slot` ∈ `SHOT_SLOTS`
keys, `value` ∈ that slot's vocabulary, dropped `reason` ∈ the three; `joins.length === clips.length`;
keys bounded. A later reader joins **`studio_stitch_jobs.id` (the `stitchId`) → `spec.composer.joins[i]` ↔
`spec.clips[i]` by index**; `dropped[].row` ↔ the row part of `joins[].key` (`<row key>:<still|own|clip|bridge>`);
with D-2, `planId` + the `i` in `agent:<nonce>:<i>` ↔ `studio_plans.plan.items[i]` under the same
`athlete_id`. The dev log stays, as a convenience.

## Adi's rulings — 24 Sep 2026 (the Phase B GO; cited below as **ADI-24SEP-GO**)

| # | Ruling |
|---|---|
| D-1 | A malformed record is a **400 naming the field** (house rule). The client↔server reason-list drift test is added. |
| D-2 | **`planId` rides the record**, checked as hers on the stitch route, 404 if not — it makes drop-rate-per-plan answerable (PR 16 watch metric (b)). Mutation "a plan id that is not hers is stored on a stitch" is in. |
| D-3 | Server flag off → the record is **ignored exactly as an unknown key is today**. Byte-identical is byte-identical. |
| D-4 | **N1 ships in the same commit as R-1**, not as a follow-up: a composition chip that does not re-quote spends against a frozen preview — the class of bug the preview row exists to prevent. |
| RULE-A | **i2v-from-her-photo renders 10/48 and product-from-a-photo 11/48 BY RULING**: the photo already decides camera, lighting and composition; motion belongs in her sentence; `static` movement compiles identically to nothing. Changing those is a different picture — PR 19's territory, not the composer's. PR 16's census must not return these as DEAD; cite ADI-24SEP-GO. |
| RULE-B | **Bridges carry no slots BY RULING** — PR 14 R-3, `campaign/carrier.ts:193-196` (the bridge renders constraints alone). **Held rows render nothing because nothing is filmed**; after this PR they record `nothing-filmed` drops instead of skipping the path. |
| — | Correct both wrong claims in composer.md (:309-310 and :315-316) in the same commit as the code, visible as a dated correction, with the note that PR 15's mutations each sat on one side of the boundary — and that four of this PR's cross it in a single test. |
| — | At merge, tell flow-eval (PR 16): its `boardRequests` call needs the fourth argument to see the fix; P-caps, the composition / motion / droppedSlots entries in P-dead, and K3–K6 all flip. Do not edit their files. |

### A Phase-R finding that changed scope — N1, and why it is the argument for report-first

N1 (`rowSignature` names four slots) was invisible from the block: the block asked for composition and
motion to *reach* the request, and said nothing about the quote key. Read in isolation, R-1 is a
one-argument fix at storyboardRun.ts:111 — and shipping exactly that would have produced a Board where a
composition chip tap changes the request but not `boardSignature`, so "Make the board" runs the
previewId quoted *before* the tap: a spend against a frozen preview, silently, with the quote and the run
agreeing perfectly about a clip she is no longer looking at. That is the #538 shot-slot incident again,
in two new slots. It surfaced only because Phase R read every function the changed request passes
through (`rowSignature`'s own header states the rule it would have broken) before writing a line. The
fix was ruled into R-1's commit (D-4) rather than carded.

## Decisions for Adi (before B) — as proposed; ruled above

- **D-1 · A malformed record is a 400 by field** (the house rule: "a VALUE it does not know must not be
  dropped", routes/studio.ts:524-529), not a silent drop. Risk named: a client vocabulary newer than the
  server's refuses the stitch. Mitigation: a server test drives the client's `chooseJoin` through every
  branch and parses each reason, so the two sets cannot drift unseen. *Recommended.*
- **D-2 · Carry `planId` on the record**, verified hers at the route (`readPlan(athleteId, planId)`, 404
  otherwise, as music/suggest does, routes/studio.ts:3068-3075) — so PR 15's card 3 ("drop rate per plan
  from droppedSlots") and PR 16's finding 9 ("stitch has no plan id") have a key. Without it the record
  joins per stitch only. Costs one indexed read on the stitch route, only with the composer on and a plan
  behind the Board. *Recommended.*
- **D-3 · Server flag off → the record is not parsed or stored** — exactly today's behaviour for an
  unknown key — so a flag-on client against a flag-off server stores today's spec byte-for-byte.
  `parseStitchSpec` gains `composer = composerEnabled()` as its third parameter; the runner's re-parse
  does not need the record. *Recommended.*
- **D-4 · N1 is not optional.** `rowSignature` grows composition and motion in the same commit as R-1, or
  R-1 ships a stale-quote spend bug. Flagged here rather than silently added because it touches the quote
  key.

## Predictions (pre-registered, falsifiable)

- **P-render** — after B, measured with the C4 script: generated b-roll **48/48** (camera 11 with 8
  distinct phrases, movement 11, lighting 11, composition 7 distinct, motion 8 distinct); i2v-of-her
  **10/48**; product-from-photo **11/48**; held still **0/48** and held clip **0/48** with **48/48 drops
  recorded** each; bridge **0/48**, no record. Falsifier: any cell differs.
- **P-flag** — sites found: **1 inferred** (agentLogic.ts:754) + **1 omitted** (storyboardRun.ts:111).
  After B, the same grep finds **0** of either in non-test client code, and every composer-parameterised
  function on the Board path receives `STUDIO_COMPOSER` or a param threaded from it. Falsifier: one more
  site turns up in B, or one survives.
- **P-held** — with the flag on, an `image` and a `clip` item whose `shot` sets all six slots each seed a
  row with exactly six `droppedSlots`, every one `nothing-filmed`, and still no `shot` and no request.
  Flag off: the row is byte-identical to today (no `droppedSlots`). Falsifier: any drop without a reason,
  or any change flag-off.
- **P-join** — flag on, a Board stitch POSTed to `/studio/stitch` stores `spec.composer.joins` with one
  entry per `spec.clips` entry and the nine-reason vocabulary, and `spec.composer.dropped` with every
  row's `droppedSlots`. **Join key: `studio_stitch_jobs.id` + clip index** (and `planId` + row key → plan
  item, with D-2). Falsifier: a reason absent from the row, a length mismatch, or a record stored flag-off.
- **P-off** — flag off (client and server): seeded rows, `boardRequests` bodies, the stitch body and the
  stored spec are **byte-identical** to 487053e2 for the same fixture — diffed base vs tip by script, and
  pinned by test. Falsifier: any byte.
- **P-fingerprint** — `promptFingerprint()` = **0ebb8528a218** at the tip, flag on and off (no planner
  file is in the map). Falsifier: any other value.
- **P-requote** (N1) — flag on, setting `composition` on a photo-less row changes `boardSignature`;
  flag off, `boardSignature` for every fixture board is byte-identical to today.

## Mutations (Phase M) — red-by-name, and where each lives

| # | Mutation (the named test) | Applied to | Test file |
|---|---|---|---|
| 1 | "composition is stripped before a Board clip request" | `shotFor` filters out `composition` | client/screens/studio/storyboardRun.test.ts |
| 2 | "motion is stripped before a Board clip request" | `shotFor` filters out `motion` | storyboardRun.test.ts |
| 3 | "slotsAllowed is called without the composer flag" | storyboardRun.ts:111 back to `slotsAllowed(row)` | storyboardRun.test.ts |
| 4 | "the composer flag is inferred from campaign rather than read" | `brandBoardSeed` back to `campaign !== null` | client/screens/studio/brandPlan.test.ts |
| 5 | "a held row drops a capability with no reason" | held branches skip `withPlannedShot` (today's code) | client/screens/studio/agentLogic.test.ts |
| 6 | "a join reason never leaves the client" | (a) `boardStitch` omits the record; (b) `parseStitchSpec` drops it — each reds alone | server/routes/studio.stitch.test.ts (client `boardStitch` → POST → the stored row, PGlite) |
| 7 | "a dropped slot never leaves the client" | (a) record omits `dropped`; (b) parser drops it | server/routes/studio.stitch.test.ts |
| 8 | "a Board request renders a member with no phrase" | `settingLine` omits the composition (then the motion) sentence | server/studio/composerBoundary.test.ts (new: all 48 members, capability → seed → request → brief hop → `videoPromptFor`) |
| 9 | "composer changes an artifact with STUDIO_COMPOSER off" | (a) `shotFor` ignores the flag; (b) `boardStitch` attaches the record with `composer` null; (c) the server stores it with `composerEnabled()` false; (d) held rows record drops flag-off | server/studio/composerBoundary.test.ts (+ studio.stitch.test.ts for (c)) |
| 10 | "the planner fingerprint moves" | one byte in the planner prompt | server/studio/agent/plan.test.ts (existing pin :1518-1520) |
| 11 | "a composition change does not re-quote the board" (N1) | `rowSignature` back to four slots | client/screens/studio/storyboardLogic.test.ts |
| 12 | "a join reason outside the closed set is stored" | parser accepts any string reason | server/studio/video/spec.test.ts (+ every `chooseJoin` output parses) |
| 13 | "a plan id that is not hers is stored on a stitch" (D-2) | route skips the ownership read | server/routes/studio.stitch.test.ts |

Mutations 6, 7, 8 and 9 are the ones PR 15 could not have: each test crosses the boundary in one run.

## Component map — every file Phase B touches

**Lane C — client**
- client/screens/studio/storyboardRun.ts + storyboardRun.test.ts — `composer` through `boardRequests` → `clipRequestFor` → `shotFor`.
- client/screens/studio/storyboardLogic.ts + storyboardLogic.test.ts — `rowSignature` (N1).
- client/screens/studio/agentLogic.ts + agentLogic.test.ts, brandPlan.test.ts — held rows through `withPlannedShot`; `brandBoardSeed` reads its flag.
- client/screens/studio/boardStitch.ts + boardStitch.test.ts — the `composer` record on the body (flag on only); `ComposerInput` gains optional `planId`.
- client/screens/studio/StoryboardTab.tsx — pass `STUDIO_COMPOSER` to `boardRequests`; `planId` into the composer input; the dev log stays.
- client/screens/studio/AgentScreen.tsx — pass `STUDIO_COMPOSER` to the estimate's `boardRequests`.
- client/screens/studio/BrandPlanStep.tsx — pass `STUDIO_COMPOSER` to `brandBoardSeed`.

**Lane S — server**
- server/studio/video/spec.ts + spec.test.ts — `StitchSpec.composer`, parsed as closed sets, gated on `composerEnabled()`.
- server/routes/studio.ts + server/routes/studio.stitch.test.ts — D-2's ownership read on POST /studio/stitch (only if D-2 is taken; otherwise the route is untouched).
- server/studio/composerBoundary.test.ts — new; the cross-boundary render and flag-off pins.

**Lane L — ledger**
- docs/probes/composer-boundary.md (this file).
- docs/probes/composer.md — the R-5 correction, in the same commit as the R-1 code.

Not touched (R-8): server/studio/agent/eval/**, server/scripts/studioFlowCensus.ts, compile/, brief.ts,
preview.ts, edit/, classify.ts, interpret/, qa/, identity/, the planner prompt, shared/schema.ts (no DDL).

## R-5 — the correction, as it will read in composer.md

At :309-310 and :313-316, the original sentences stay, struck through in place and followed by:

> **Correction, 24 Sep 2026 (PR 15.1, docs/probes/composer-boundary.md) — this was wrong at merge.** On a
> Board b-roll row composition and motion were written onto the row at seed and then stripped before the
> clip request: `shotFor` called `slotsAllowed(row)` with no composer flag (storyboardRun.ts:111), which
> defaults to off. Four of six slots were phrased through the Board; all six only by a direct API call —
> 15 of 48 capability members never rendered. Held rows never ran `withPlannedShot`, so `nothing-filmed`
> was never produced. PR 16's flow census found both (flow-eval.md §0.3, §2.3, cards K3–K5). PR 15's
> fourteen mutations were each client-only or server-only, so none could see a value lost between the
> seeded row and the request. Fixed in PR 15.1; what the code does now: …

## Spend

**$0.** No model call in B, M or V. The C4/P-render script and the P-off byte-diff are pure, in-process,
bogus `DATABASE_URL`.

UI check for Adi: (1) the compiled b-roll prompt with a composition and a motion phrase, and the same
prompt flag-off, dumped to `probe-out/composer-boundary/` in-process — **$0**. (2) The join-reason list
for one stitch read from `studio_stitch_jobs.spec->'composer'` — needs a Board stitched from the app with
both flags on and the branch's server; **$0 if the board is held stills / her clips / already-made
pieces** (a stitch is CPU). Any newly generated clip on that board spends and is quoted before it runs.
Reading the row is a SELECT on the live DB, scoped to Adi's athlete and that stitch id — Adi runs it, or
approves that exact query.

---

## Phase B — what was built

Tip and commits: see the final report (`git log --oneline origin/main..HEAD`). Three commits: the
client half (R-1 + N1 + R-2 + R-3) **with the composer.md correction (R-5) in the same commit**; the
record (R-4, client body + server parser + route); this ledger.

**Lane C — client**
- `storyboardRun.ts` — `shotFor(row, composer)` (flag required, no default) → `slotsAllowed(row, composer)`;
  `clipRequestFor(…, composer = false)` and `boardRequests(…, composer = false)` thread it. Optional at
  the two exported entry points so PR 16's three-argument call still compiles (see C7).
- `storyboardLogic.ts` — `rowSignature` appends `[composition, motion]` **only when either is set** (N1);
  a flag-off board keys byte-identically (pinned: "a board with neither keys exactly as it did before").
- `agentLogic.ts` — held clip and held photo rows go through `withPlannedShot` (R-3); `brandBoardSeed`
  takes `composer` (appended, default `false`) and gates its rhythm on it too (R-2).
- `boardStitch.ts` — `ComposerInput.planId?`; with `composer` given the body carries
  `composer: { joins: [{key, kind, reason}] aligned with clips, dropped: [{row, slot, value, reason}], planId? }`.
- `StoryboardTab.tsx` — `boardRequests(…, STUDIO_COMPOSER)`; composer input `{ rhythm, planId: boardPlanId }`;
  the dev log stays, its comment now says it is a convenience. `AgentScreen.tsx` — the estimate passes
  `STUDIO_COMPOSER`. `BrandPlanStep.tsx` — passes `STUDIO_COMPOSER` to `brandBoardSeed`.

**Lane S — server**
- `video/spec.ts` — `StitchSpec.composer?: ComposerRecord`; `JOIN_REASONS` (9) and `DROPPED_SLOT_REASONS`
  (3) as closed sets; `parseComposerRecord` rebuilds from known fields: `joins.length === clips.length`,
  keys `^[A-Za-z0-9:_-]{1,160}$`, kind `cut|fade`, slot ∈ `SHOT_SLOTS`, value ∈ that slot's vocabulary,
  ≤ 120 drops, `planId` a UUID (lower-cased). `parseStitchSpec(body, requireBedAvailable, composer =
  composerEnabled())`; `readStoredSpec` passes `false` — the runner never reads the record, and a record
  must never fail a job she is waiting on.
- `routes/studio.ts` — POST /studio/stitch: with `spec.composer.planId`, `readPlan(athleteId, planId)` →
  404 `field: "composer.planId"` before any row exists (D-2). Only reachable with the flag on.
- **No DDL**: the record lives in the existing `studio_stitch_jobs.spec` jsonb.

**Lane L** — this ledger; composer.md :308-317 struck through in place + a dated correction block.

## Phase M — mutations, red by name, then green

Runner: scratch `mutate.py` — back up the file, apply one mutation (site asserted to match exactly once),
run its suite with `--json`, read the named test, restore from the byte copy, `cmp`. Working-tree hash
identical before and after the whole run. **14 mutations, 20 variants, all RED by name**; green re-run
after: 7 suites / 379 tests / 0 failed.

| # | Named test | Mutation | File mutated | Test file | Result |
|---|---|---|---|---|---|
| 1 | composition is stripped before a Board clip request | `shotFor` filters `composition` | storyboardRun.ts | storyboardRun.test | **RED** |
| 2 | motion is stripped before a Board clip request | `shotFor` filters `motion` | storyboardRun.ts | storyboardRun.test | **RED** |
| 3 | slotsAllowed is called without the composer flag | `slotsAllowed(row)` | storyboardRun.ts | storyboardRun.test | **RED** |
| 4 | the composer flag is inferred from campaign rather than read | `campaign !== null` restored | agentLogic.ts | brandPlan.test | **RED** |
| 5 | a held row drops a capability with no reason | held branches skip `withPlannedShot` | agentLogic.ts | agentLogic.test | **RED** |
| 6a | a join reason never leaves the client | body omits the record | boardStitch.ts | studio.stitch.test | **RED** |
| 6b | a join reason never leaves the client | parser drops the record | spec.ts | studio.stitch.test | **RED** |
| 7a | a dropped slot never leaves the client | record's `dropped` empty | boardStitch.ts | studio.stitch.test | **RED** |
| 7b | a dropped slot never leaves the client | parser never pushes a drop | spec.ts | studio.stitch.test | **RED** |
| 8a | a Board request renders a member with no phrase | `settingLine` omits composition | prompts.ts | composerBoundary.test | **RED** |
| 8b | a Board request renders a member with no phrase | `settingLine` omits the action | prompts.ts | composerBoundary.test | **RED** |
| 9a | composer changes an artifact with STUDIO_COMPOSER off | `shotFor` passes `true` | storyboardRun.ts | composerBoundary.test | **RED** |
| 9b | composer changes an artifact with STUDIO_COMPOSER off | record attached with `composer` null | boardStitch.ts | composerBoundary.test | **RED** |
| 9c | composer changes an artifact with STUDIO_COMPOSER off | server parses the record flag-off | spec.ts | studio.stitch.test | **RED** |
| 9d | composer changes an artifact with STUDIO_COMPOSER off | held rows name drops flag-off | agentLogic.ts | composerBoundary.test | **RED** |
| 10 | the planner fingerprint is pinned: 0ebb8528a218 | one byte of the planner's SYSTEM prompt | agent/plan.ts | plan.test (existing pin) | **RED** |
| 11 | a composition change does not re-quote the board | `rowSignature` back to four slots | storyboardLogic.ts | storyboardRun.test | **RED** |
| 12 | a join reason outside the closed set is stored | any string accepted as a reason | spec.ts | spec.test | **RED** |
| 13 | a plan id that is not hers is stored on a stitch | route skips `readPlan` | routes/studio.ts | studio.stitch.test | **RED** |
| 14 | the client's join reasons and dropped-slot reasons are exactly the server's (D-1 drift) | `rhythm-slow` removed from the server list | spec.ts | spec.test | **RED** |

**Crossing the boundary in one test** (the ruling's "four"): 6 and 7 (Board seed → `boardStitch` →
POST → the stored jsonb), 8 (capability → seed → request → compiled prompt, all 48), 9 (flag-off pins over
seed, request, stitch body and stored spec). 14 is a fifth, smaller one (client `chooseJoin` /
`droppedSlotReason` outputs parsed by the server).

## Phase V — evidence ($0)

- **P-render — HELD, every cell.** Same C4 script, tip, Board passing the flag
  (`probe-out/composer-boundary/render-count-after.txt`): b-roll **48/48** (camera 11 / 8 distinct,
  movement 11, lighting 11, composition 7 / 7, motion 8 / 8, 0 drops); i2v-of-her **10/48** (37 drops
  recorded); product-from-photo **11/48** (37); held still **0/48, 48 recorded**; held clip **0/48, 48
  recorded**. Pinned as a table in composerBoundary.test ("renders per row kind exactly as ruled"). The
  same script with the three-argument `boardRequests` call (PR 16's replica) still gives b-roll 33/48 —
  that is the census lag in C7, measured.
- **P-flag — HELD.** Non-test client grep at the tip: every composer-parameterised Board function is
  handed `STUDIO_COMPOSER` or a param threaded from it; no `campaign !== null`; `shotFor` has no default.
  No third site turned up in B.
- **P-held — HELD** (agentLogic.test: six slots → six `nothing-filmed`, no `shot`, no request; flag-off
  byte-identical to a row seeded with no `shot`).
- ~~**P-join — HELD**~~ **P-join — HELD IN TESTS, FAILED LIVE, cause: env layering** (see the correction
  block after Phase V) (studio.stitch.test, through the real route into PGlite): `spec.composer.joins` one
  per `spec.clips` entry, each agreeing with the wire (fade ⇔ `crossfadeSec`); `dropped` every held row's
  drops; `planId` stored only when hers. **Join key: `studio_stitch_jobs.id` + clip index**; `dropped[].row`
  ↔ the row part of `joins[].key`; `planId` + `i` in `agent:<nonce>:<i>` ↔ `studio_plans.plan.items[i]`
  under the same `athlete_id`.
- **P-off — HELD, byte for byte.** Scratch `p-off.ts` printed 771 flag-off artifacts — for all 48
  members × 5 row kinds × {flag-off server, flag-on server}: seeded rows, `boardRequests` bodies,
  `rowSignature` / `boardSignature` / `boardWorkSignature`, `brandBoardSeed`, `seedFromStoredPlan`,
  `planSeedExtras`; plus a Board stitch (stills, own clips, made clips, a passthrough, a look) and its
  parsed spec with and without an injected record — against a detached worktree at 487053e2 and against
  the tip, `STUDIO_COMPOSER` unset: **728 089 bytes each, identical (sha e731aaee…)**. Control: the tip with
  the server flag on differs on exactly one artifact (the injected record, refused by field).
- **P-fingerprint — HELD.** `0ebb8528a218`; the pin went red under mutation 10 and green after.
- **P-requote — HELD** (storyboardRun.test, composer twin of the structural signature test: 8 boards
  that ask differently, 8 distinct signatures; the four-slot board's signature byte-identical to before).

### UI check artifacts — `probe-out/composer-boundary/` (gitignored, $0, in-process)
- `broll-flag-on.prompt.txt` / `.request.json` — one Board b-roll clip, all five axes planned: the compiled
  prompt carries "The subject sits on a third of the frame, off centre. The clip plays in slow motion."
  on the setting line.
- `broll-flag-off.prompt.txt` / `.request.json` — the same plan with both flags off: four slots, and
  composition / motion riding the direction as prose ("Composition: rule of thirds. Motion: slow motion.")
  — **byte-identical to the flag-off prompt at 487053e2**.
- `broll-flag-on.BEFORE-pr15-merged.prompt.txt` — the flag-on prompt at 487053e2: **neither the phrase nor
  the prose** (0 matches). New fact from V: at PR 15's merge, turning the composer ON made the Board lose
  composition and action entirely, where flag-off at least carried them as prose.
- The join-reason list for one stitch, read from where R-4 landed it: needs a Board stitched from the app
  with both flags on against this branch's server — **$0 if the board is held stills / her clips /
  already-made pieces** (a stitch is CPU); any newly generated clip spends and is quoted first. Then, as
  Adi or with Adi's approval of this exact read-only query:

      SELECT spec->'composer' FROM studio_stitch_jobs
       WHERE id = '<stitchId from the dev log>' AND athlete_id = '<Adi's athlete id>';

## Things to know (deviations, stated plainly)

- **Mutation 11's test lives in storyboardRun.test.ts**, not storyboardLogic.test.ts as the R map said: it
  needs `boardRequests` beside `rowSignature`, next to the existing structural signature test it twins.
  storyboardLogic.test.ts is untouched.
- **One PR 15 assertion was narrowed, on purpose.** boardStitch.test "composer renders with STUDIO_COMPOSER
  off" compared the whole flag-ON body to today's; the flag-on body now carries the record by design, so
  that leg compares the body minus `composer` byte-for-byte and asserts the record is present. The
  flag-OFF leg is unchanged (full body equality).
- `clipRequestFor` / `boardRequests` take `composer` with a `false` default (census compatibility); only
  `shotFor` requires it. Every production caller passes the flag (P-flag).
- The server does not cross-check a join's `kind` against `clips[i].crossfadeSec` — it records, it does not
  judge the Board's rule. The agreement is pinned on both the client (boardStitch.test) and the real route
  path (studio.stitch.test).
- 14 mutations / 20 variants against the 13 pre-registered: #14 (the D-1 drift test) was added by ruling;
  #8 and #9 each ran more than one variant.
- Lint: 0 errors. New warnings are `import/first` after `jest.mock` only (+3 studio.stitch.test, +9 the new
  file), the pattern those suites already use (prompts.test 8, studio.stitch.test 13 on main).
- Prettier: formatted only files clean on main that the edit broke (+ the new file); `brandPlan.test.ts`,
  `studio.stitch.test.ts`, `routes/studio.ts` were unformatted on main and are left so.

## The hold — full gate at 099e8003 (code tip; the ledger commits after it change no code)

`npm test` bare, 24 Sep 2026: **20 batches, 517 suites, 9684 tests, 1 failed** — every per-batch summary
read; the one red is `[server/services#1] affiliationSync.test.ts` "a year-only from/to (registry v2 allows
YYYY)…", the named house flake (CLAUDE.local.md). Re-run in isolation: green, green, **red** (1 of 3) —
its known rate on main, and this branch touches no file under `server/services`. The runner's exit code
was 1; per the standing rule it is not the verdict, the summaries are. flow-eval (PR 16) ran 2–3 scoped
census suites during part of the gate, by Adi's ruling; no hook-timeout red appeared.
`tsc --noEmit` and `tsc --noEmit -p tsconfig.jest.json` clean; lint 0 errors. Spend: **$0**.

> **⚠️ CORRECTION — 24 Sep 2026 (Adi's ruling after the walk).** The Phase V verdict "P-join — HELD" was
> wrong as a live claim. **It held in tests and failed live; the cause was env layering, not code.**
> - **Failed live:** stitch `e8759769-67a5-43fa-aacb-369ef761ad15`, 19:28:39 UTC. `spec ? 'composer'` was
>   false. The committed `.env.development` :14 `EXPO_PUBLIC_STUDIO_COMPOSER=false` outranked `.env`, so the
>   client flag resolved off in the bundle and the Board never sent the record. Diagnosis below.
> - **Held live:** stitch `ceed40be…`, 19:34:39 UTC, the same manual Board, with a local `.env.local`
>   overriding. `spec.composer` present, `joins` [`position-0`, `default-fade`], `dropped` empty, no
>   `planId` (a manual Board, correct). The fix working confirms the diagnosis.
> - Why the tests could not see it, and the mutation that crosses it: below, and
>   `client/lib/devEnvLayering.test.ts`.

## P-join — FAILED LIVE (Adi's walk, 24 Sep 2026). Diagnosis (written before the fix)

Stitch `e8759769-67a5-43fa-aacb-369ef761ad15` (19:28:39 UTC), from a **manually built** Board. Server pid
66100 on this worktree, `.env` :80-81 both composer flags `true`, Expo `-c` from this worktree.
`spec ? 'composer'` is false. **The P-join HELD verdict above held in tests only; the live leg failed.**

**Where it drops: the client never sends the field, because the CLIENT flag is off in the running bundle.**
- `.env.development` is committed and carries `EXPO_PUBLIC_STUDIO_COMPOSER=false` (:14, added by #588
  e563487f "dev flag line for the composer").
- Expo layers env files with the later file winning: `node_modules/expo/virtual/env.js` as bundled merges
  `['.env', '.env.development', '.env.local', '.env.development.local']` in that order; `@expo/env`
  `getFiles` (build/index.js:107-111) and its load loop (:134-150) do the same. No `.env.local` or
  `.env.development.local` exists here, so `.env.development`'s `false` overrides `.env`'s `true`.
- Read from the bundle Metro is serving on :8083 (ios and web, both containing this branch's
  `function composerRecord` and `planId: boardPlanId`): module `.env` holds `"EXPO_PUBLIC_STUDIO_COMPOSER":
  "true"`, module `.env.development` holds `"false"`, and the merge makes `STUDIO_COMPOSER` **false**.
- So StoryboardTab.tsx:906 passes `null` as the composer input, and `boardStitch` attaches no record
  (boardStitch.ts:375). The request carried no `composer` key, so the server had nothing to parse.
- The **server** is on: `server:dev` is `tsx --require dotenv/config` (package.json:12), which reads only
  `.env`. So server `STUDIO_COMPOSER=true` and client `false`: the two halves of the flag split, silently.
  The server did not strip anything (spec.ts:657 only parses what arrives).
- Consequence: the whole walk ran a **flag-off client**. Legacy joins, legacy chips, no composition or
  action in any request. It exercised none of PR 15 or PR 15.1's client behaviour.

**It is not the manual Board.** The record does not depend on a plan: `ComposerInput.planId` is optional,
`boardStitch` adds `planId` only when present (:410), and the parser treats it as optional. A manual Board
(`boardPlanId` null) sends `{ joins, dropped }` with the flag on (pinned: boardStitch.test "a hand-built
board carries no plan id…"). Manual and agent-built Boards stitch through the same code:
`stitchPlan = boardStitch(…)` :888-907 → `queueStitch.mutateAsync(stitchPlan.body)` :934. **A second walk from
an agent-built Board, on this bundle, would fail identically.**

**Why the tests pass and the walk does not.** The builder is not different: the tests drive the same
`boardStitch` the stitch button sends. The gap is one layer up. Every test hands the flag in as a literal
(`boardStitch(…, { rhythm: null })`, `seedRowsFrom(…, true)`, `process.env.STUDIO_COMPOSER = "true"`), and no
test resolves `EXPO_PUBLIC_STUDIO_COMPOSER` through the env files the app actually bundles. The mutation
that would have caught it — *"the Board's composer flag resolves off in the dev bundle while .env turns it
on"* — has to run Expo's own layering (`@expo/env`, mode `development`) over a fixture `.env` setting it
`true` plus the repo's committed `.env.development`, and assert `"true"`. Applied to main as it stands (the
committed `false`), it is red. That is PR 15's class of gap one layer along: each side correct, the value
lost between the config and the code.

**Options as reported (before the ruling), each outside the component map or in Adi's environment:**
1. Walk-only: a local, uncommitted `.env.local` (or `.env.development.local`) with
   `EXPO_PUBLIC_STUDIO_COMPOSER=true`, which outranks `.env.development`; restart Metro with `-c`. No repo change.
2. Repo: change or delete the committed `.env.development` :14. That file is not in this PR's map and it
   is #588's line. It needs a ruling.
3. The crossing test above. It pins whatever (2) decides, and it lives outside the map too.

## Adi's ruling on the env layering — 24 Sep 2026 (cited as **ADI-24SEP-ENV**), and what was done

Adi: *"This is my error: I had you add `EXPO_PUBLIC_STUDIO_COMPOSER=false` to .env.development after PR 15,
to declare the flag for other worktrees. I didn't know Expo's layering makes that file outrank .env, so the
committed false silenced every local override."* Ruled:

1. **Walk:** re-walked with `.env.local`, which held live (stitch `ceed40be`, above).
2. **Repo, in this PR:** `.env.development` must not carry `EXPO_PUBLIC_STUDIO_*` values that override a
   developer's `.env`. Done the smallest way: **deleted the `EXPO_PUBLIC_STUDIO_COMPOSER=false` line**
   (1 deletion). Setting it `true` would override a developer's `.env` the other way. With the line gone,
   her `.env` decides, and a worktree with no line anywhere gets the flag's own default (off:
   `flags.ts` `=== "true"`).
   **Note: the file's other `EXPO_PUBLIC_STUDIO_*` lines have the same property.** `STUDIO_ENABLED`,
   `SESSIONS`, `SERVER_ROUTING`, `INTERPRETER`, `AGENT`, `BRAND_PROFILES`, `DIRECTION_MOMENTS`, `IMAGE_EDIT`,
   `CLIP_READ` and `QA_DISPLAY` (all `true`, from 8f746af6 and 9e8e44f3) each **silently outrank `.env`**:
   a developer who writes `=false` for any of them in `.env` gets `true` in the bundle. So do the non-studio
   `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_MILA_TEST_CONVERSATION_ID` and `EXPO_PUBLIC_MILA_VOICE_NATIVE`. Only
   `.env.local` / `.env.development.local` beat them. **Not changed here** (the ruling takes the composer
   line only); carded for whoever owns the dev-flag file.
3. **The crossing test**, approved outside the file list: `client/lib/devEnvLayering.test.ts`. It resolves
   the flag with Expo's own code: the dev bundle's merge order is read out of `@expo/metro-config`'s
   transform worker together with its `parseEnvFile`, and `@expo/env` `parseProjectEnv` is run in
   development mode. Both run over a fixture `.env` (`=true`) plus the repo's committed `.env.development`,
   and then `flags.ts`'s `STUDIO_COMPOSER` is loaded under the resolved value. It never reads a real `.env`.
   A control proves the harness sees an override: a fixture `.env.development` with `=false` wins, in both
   layerings.
   - **Mutation: "the Board's composer flag resolves off in the dev bundle while .env turns it on" — RED by
     name** with the committed line restored (the file byte-equal to HEAD before this change): `Received:
     "false"`. **GREEN** with the line deleted. Shown twice: once before the fix was written, and once on the
     final test code.
   - Uses `@expo/env` and `@expo/metro-config`, both already installed (Expo's own). No dependency was added.
4. This correction.
5. flow-eval told (below).

**Why this gap is PR 15's class, one layer along:** PR 15's tests stopped at the client/server boundary.
PR 15.1's tests crossed it but took the flag as a literal. The config → constant hop was the layer none of
them crossed. `devEnvLayering.test.ts` crosses it for the composer flag only.

### Item 5 — flow-eval told (24 Sep 2026), and its census checked read-only

**The census is unaffected by the layering.** It passes client flags as literals throughout: composer and
carrier are `ctx.flagsOn` (flows/brief.ts:425-426), the identity pack is `previewBody(…, ctx.flagsOn)`
(identity.ts:102), and the interpreter is the literal `true` (identity.ts:100, makeIt.ts:42).
census.test.ts sets only server `process.env` and never loads `.env*` files (jest does no Expo layering).
The one imported client module that reads a `flags.ts` constant at load is `client/hooks/use-studio`
(`STUDIO_IDENTITY_PACK`), and it is imported type-only everywhere in `census/`, so it is erased at runtime.
Also sent: two argument lags that keep composition and motion stripped in the census after merge:
`flows/brief.ts:450` `boardRequests` (needs the 4th `composer` argument) and
`census/capabilities.test.ts:183` `clipRequestFor(rows[0], "grow-following")` (needs `null, true`).
Their files are not touched.

### Re-gate after the ruling (scoped, per ADI-24SEP-ENV)

9 suites / 413 tests / 0 failed: `devEnvLayering.test` plus the eight PR 15.1 suites. Both `tsc`
configs are clean. `eslint` on the new file: 0 errors, 1 warning (the `require` inside
`jest.isolateModules`). No other test reads `.env.development`. The full suite was not re-run: this is an
env-file line and a new test file, and the ruling asked for a scoped re-gate.
