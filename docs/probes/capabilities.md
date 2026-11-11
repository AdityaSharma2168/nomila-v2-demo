# PR 6 — capability library, plan persistence, campaign briefs, concept picker, brand flow → Board — ledger

Branch `studio/capabilities` on origin/main 2bedd2e (PR 8 music-fonts merged; chore/expo-dev-flags
deleted, not landing — the worktree `.env` carries the EXPO_PUBLIC flags). Order: 0 → 0b → 6a1 → 6a2 →
6a3 → 6b → 6c → 6d, a gate between lanes.

## Decisions, with who made them (Adi, 22–23 Sep 2026, on the opening report)

1. `dolly` stays the image-item push-in (ratified). Entries are field-scoped — `image.motion` vs
   `shot.movement` — and the planner never sees the bare word without its field; a test pins it.
2. `CampaignBrief.product.line` (`shortText(120).nullable()`); product photo picks become `product.ref`
   handles resolved server-side.
3. A slim brand setup step (format chips, product photo + line, instructions); "Plan it" → concepts →
   plan → Board. "Your media" goes. PersonalPostScreen untouched.
4. The deal stays out of the brief: `studio_plans.deal_deliverable_id`, nullable. The seed carries a
   `dealLinked` boolean and the brand objective.
5. A brief-upload route mirroring the contract-upload pattern, PDF only, `studio-briefs/<athleteId>/`.
   `expo-document-picker ~14.0.8` is already a dependency — nothing installed.
6. PR 3's `studio_campaign_briefs` card is SUPERSEDED by the plan-row brief (this ledger, decision 6).
7. Commit 0 as two runs, ad-brief n=5 cap $0.45 and recap n=3 cap $0.30. Envelope ~$2.90 for the PR.

DDL 0061 cleared by Adi (his lane) as drafted, `deal_deliverable_id` in. PGlite 0.5.4 (Postgres 18.3)
accepts `ON DELETE SET NULL (parent_plan_id)` on the composite parent FK — probed: a cross-athlete
parent is refused by the FK, and deleting a parent nulls only the child's `parent_plan_id`.

## The eval runner went through the route (commit 0)

`server/scripts/studioPlanEval.ts --run` called `derivePlan` in-process: no `castPlan`, so none of the
gates, and its ask dropped `sport` — the probe/route divergence (c3-doctrine2.md:9-16). Its model path
is now FENCED (dry run, `--sheet`, `--reveal` still work). Planner cells go through
`server/scripts/studioPlanRoute.ts`: `POST /studio/agent/plan` on this worktree's server, the token from
`probe-out/capabilities/.token` (never printed), each cell's cast slots with whole asset ids
(`studio/agent/eval/routeCell.ts`). Mutation "runner calls derivePlan directly" (a `derivePlan(` call
appended to studioPlanEval.ts) → reds that test by name; restored from a backup.

## Commit 0 — the baseline, through the route (23 Sep 2026, 2bedd2e)

Server verified before the runs: the process listening on :8080 had this worktree as its cwd, HEAD
2bedd2e, and nothing it loads differed from origin/main (the only edits were the fenced script and new,
unimported files). Spend: 8 planner calls, ≈ $0.59 at ingest-flip's $0.071–0.075 per call — ad-brief
≈ $0.37 (cap $0.45), recap ≈ $0.22 (cap $0.30). Run files: `probe-out/capabilities/runs/ad-base-*.json`,
`recap-base-*.json`.

### B_ad — "a soccer ad with me in it", objective grow-following, n=5

| cell | slots | camera | i2v (ref · provenance) | held (ref · provenance · motion) |         clips (made-here) | b-roll | list $ |
| ---- | ----: | -----: | ---------------------- | -------------------------------- | ------------------------: | -----: | -----: |
| #0   |     5 |      5 | 5581e882 · camera      | —                                |                     4 (0) |      0 |   0.80 |
| #1   |     6 |      3 | 354c4ff4 · made-here   | 3bb6f269 · made-here · pan       |                     3 (0) |      1 |   1.41 |
| #2   |     6 |      2 | e5a29547 · made-here   | 8d7f81ef · made-here · pan       |           3 (1: ebe01971) |      1 |   1.41 |
| #3   |     6 |      3 | 5581e882 · camera      | 699deca9 · made-here · pan       | 4 (2: 4ecafec0, ebe01971) |      0 |   0.80 |
| #4   |     5 |      3 | 5581e882 · camera      | 3bb6f269 · made-here · pan       |           3 (1: ebe01971) |      0 |   0.80 |

Camera clips were all d076a790 windows. **Pooled: camera 16/28 = 57%, i2v 5 (2 on made-here stills),
held 4 (all made-here, all pushed in, 0 demoted), b-roll 2, made-here 10 slots, lookalike 0, all-camera
1/5, mean list $1.04.**

Against the prediction: camera 55–75% **held** (57%); lookalike 0 **held**; ≥1 held **held**;
i2v 2–4 **missed** (5, one per cell); "0 made-here i2v" **missed as written** — 2 of 5 i2v name a
made-here still. The ad brief is not an own-footage brief, so S2 admits a made-here still that is
identity-bound; the route answer does not carry `identityBound`, so this run cannot say whether 354c4ff4
and e5a29547 are bound. Not a gate violation on its face; the prediction was mis-stated against S2.

### B_recap — "recap my training, use live footage" (acceptance-recap), objective recap, n=3

| cell | slots | camera | made-here (ids)            | i2v | held                    | b-roll | left out | list $ |
| ---- | ----: | -----: | -------------------------- | --: | ----------------------- | -----: | -------: | -----: |
| #0   |     5 |      2 | 4ecafec0, d20824c7 (clips) |   0 | —                       |      1 |        0 |   0.61 |
| #1   |     4 |      3 | 4ecafec0 (clip)            |   0 | —                       |      0 |        0 |   0.00 |
| #2   |     4 |      3 | 4ecafec0 (clip)            |   0 | 5581e882 · camera · pan |      0 |        1 |   0.00 |

Camera slots: e055746a@0-3 in all three, d076a790 windows, 64c9bf0d once. **Pooled: camera 8/13 = 62%,
made-here 4 (all clips; 4ecafec0 OPENS every cell), i2v 0, b-roll 1, all-camera 0/3.**

Against the prediction (0 made-here, 0 i2v, camera ≥ 85%, 1–2 b-roll): i2v 0 **held**; b-roll 1
**held** (B_recap for PR 2b's card: 1 b-roll from words in 3 cells, #0's closer, $0.61); made-here 0
**MISSED** — 4; camera ≥ 85% **MISSED** — 62%.

**Finding — no gate covers a made-here CLIP on an own-footage brief.** `fitsKind` (cast.ts:590):
`if (kind === "clip") return row.mediaType === "clip";` — S1, S1b and the own-footage order are photo
gates; a clip the planner names is cast as named whatever its provenance. On c3-doctrine2's after-S1b run
this brief had zero made-here (c3-doctrine2.md:209); today a made-here clip opens all three cells. The
camera-first order reaches clips only through `listClips`' offer order and the doctrine's prose, which
is the "prompt rules bend" case. NOT fixed here — a gate change is Adi's call (see the report).

### Regression rule for every later lane (pre-registered, opening report)

Any gate violation (A1b miss, A2 / S1 / S1b cast, a lookalike) reds with zero tolerance. Ad-brief:
pooled camera share more than 15 points under B_ad (57% → below 42%) or under 50%, whichever is higher —
**i.e. below 50%**; pooled i2v more than 2 over B_ad (above 7 at n=5); mean list price more than 25% over
B_ad (above $1.30). Recap: any made-here slot, any i2v after demotion, pooled camera share more than 10
points under B_recap (below 52%).

**The recap rule's first clause is already red on the baseline** (4 made-here clips at n=3). Proposed,
NOT adopted — Adi's call: until a clip gate exists, a later lane reds on more made-here slots than
B_recap's 4 at n=3, and a clip gate, if he wants one, is what turns the clause back to zero.

## Decision 2 — are B_ad's two made-here i2v refs identity-bound? (read-only, $0)

Read through the caster's own `loadCastable` (the predicate S2 judges), her two rows only:
354c4ff4 and e5a29547 are both `provenance made-here, athlete_present true, identity_bound true, meta
false`. **S2 admitted them as designed — not a breach.** The "0 made-here i2v" line was a mis-stated
prediction: off an own-footage brief a bound made-here still is hers to animate.

## S1c — a made-here clip is never cast unpicked on an own-footage brief (Adi: decision 1 (a))

**Prediction, before the commit.** `fitsKind("clip", …, { ownFootage })` is true only for her camera
or synced clips, or one she picked; off an own-footage brief every clip fits, as before. A named
made-here clip on an own-footage brief is LEFT OUT and shown (`UNCAST_CLIP_LINE` — a clip is never
searched for), its reason naming `provenance made-here, own_footage`; on the route, a plan whose only
item is that clip answers 422. Mutation "made-here clip castable on own footage" (drop
`(!ownFootage || hers)`) → reds one case in cast.test and one in studio.agent.test, by that name.

**Result.** Held: cast.test 77/77 and studio.agent.test 46/46 green; the mutation red exactly the two
named cases (1 of 77, 1 of 46), restored from a backup. Recap's zero-tolerance made-here rule stands as
pre-registered; B_recap' (recap n=3 with the gate in) replaces B_recap for every later lane.

### B_recap' — the same brief with S1c in (98b9d0d, server restarted by Adi, 3 calls ≈ $0.22)

Prediction (Adi's, on the decision): 0 made-here, camera share recovers toward the after-S1b level.

| cell | slots | camera | made-here | i2v | held                                 | b-roll | left out | list $ |
| ---- | ----: | -----: | --------: | --: | ------------------------------------ | -----: | -------: | -----: |
| #0   |     3 |      3 |         0 |   0 | 5581e882 · camera · pan (A1b demote) |      0 |        2 |   0.00 |
| #1   |     4 |      3 |         0 |   0 | 5581e882 · camera · pan              |      1 |        2 |   0.61 |
| #2   |     5 |      5 |         0 |   0 | —                                    |      0 |        0 |   0.00 |

**Pooled: camera 11/12 = 92%, made-here 0, i2v 0, b-roll 1, left out 4, all-camera 2/3, mean list
$0.20.** Held on both lines — made-here 0, camera 62% → 92% (after-S1b was 12/14 = 86%). The planner
still NAMES made-here clips (4 left out over 3 cells, shown, not cast): the gate holds, the prompt does
not know about it yet — that is 6a2's to show in the entries. **B_recap' is the recap baseline for every
later lane**; its rule is the pre-registered one, made-here zero-tolerant.

Spend to here: commit 0 ≈ $0.59 + B_recap' ≈ $0.22 = **≈ $0.81** of the ~$2.90 envelope.

## 6a1 — the push-in is "dolly" on the wire, "pan" read as its alias

**Prediction, before the commit.** The four held-photo moves live in a leaf,
`server/studio/video/stillMotion.ts` (no imports, so the planner reads them without loading sharp or
ffmpeg): `dolly | zoom | sweep | punch`, `pan` → dolly as a read-only alias. `parseStitchSpec` (incoming
AND stored — `readStoredSpec` goes through it) and `parsePlan` read through it; the renderer, the
planner's prompt and parse, the A1b demotion, the client's chips and seed write "dolly". Every test that
pinned "pan" as the push-in pins "dolly"; `spec.test`'s refusal list, which had "dolly" as a WRONG word,
takes "tilt" instead (same size). Mutation "alias dropped" (delete `pan` from the aliases) → reds one
case each in spec.test, plan.test and capabilityEntries.test, by that name. No model run: the prompt
change is one word, measured with 6a2's.

**Result.** Held. Nine suites 448/448 after the rename; the mutation red exactly the three named cases
(151 tests in the three suites), restored from a backup. `tsc -p tsconfig.jest.json` caught one test
fixture still writing `motion: "pan"` (routeCell.test.ts:41) that jest's transpile-only run had passed —
the blind gate, again; fixed.

**Skew, stated.** A native client built before this sends "pan" to /stitch — read as dolly. The agent
route now answers "dolly"; an old client reads that as no push-in (a dead-still hold) — degraded, not
broken, and the agent is flag-off in prod.

## 6a2 — the planner plans against the entries, and every choice says why

**Built.** The per-kind prose (plan.ts's "Each item is one of") is replaced by `capabilityBlock`
(studio/agent/entryPrompt.ts): one line per entry the Board can hold, for the kinds this plan may use,
with its cost READ FROM THE REGISTRY at render time (i2v: "$0.80 per 4 s shot, $1.60 with sound",
likeness risk high; a held photo $0), its measured line and its failure modes — S1c's effect is on the
made-here clip line, A1b's on i2v's. Plan-level music (tracks — brandSafe only on brand work — and the
listed beds) and look follow. Each item returns `reason {entry, fits, over}`; an image item takes any
of the four moves and a `focus`; the plan returns `look` and `music`. Parsed fail-closed: a reason
naming an entry outside the library, or of another kind, is NULLED and logged
(`reason_outside_library`); a track that is not brandSafe on brand work is dropped. Cast carries reason
and focus; the route answers look and music; the plan card has a WHY chip; the seed carries any move
and its point. Rule 3 and OWN_FOOTAGE_LINE now say a made-here clip is not used unpicked (S1c).

Mutations, each red by name, restored from a backup: "reason names an entry not in the library"
(accept any entry) → entryPrompt.test + studio.agent.test; "brand work never gets a track that is not
brandSafe" (skip the check) → entryPrompt.test. Decision 1's test: every "dolly" in the prompt sits on
an image.motion line, the motion field, or the `movement:` list. 52 suites, 1463 green.

**Prediction, before the after-run** (thresholds pre-registered above; B_ad and B_recap' are the
before):

- Every item the route answers carries a reason naming a real entry: **100%** pooled, zero
  `reason_outside_library` lines.
- Ad-brief n=5: gates 0 violations, lookalike 0; camera share ≥ 50% (predicted 50–70%); i2v ≤ 7
  (predicted ≤ 4 — its $0.80 and "likeness risk: high" now sit beside $0 moves); mean list ≤ $1.30;
  at least one held photo with a zoom, sweep or punch across the five cells.
- Recap n=3 (against B_recap'): made-here 0, i2v 0, camera ≥ 82%; left-out falls from 4 to ≤ 2,
  since the made-here clip line now says S1c leaves it out.
- Look and music: music named in ≥ 3 of 5 ad cells. No threshold — the first measurement.

### 6a2 after-run (21e361a, server restarted by Adi; 8 calls ≈ $0.60)

**Ad-brief n=5**

| cell | slots | camera | i2v (ref · prov)  | held (ref · prov · move)     | made-here       | b-roll | reasons | music             | list $ |
| ---- | ----: | -----: | ----------------- | ---------------------------- | --------------- | -----: | ------: | ----------------- | -----: |
| #0   |     6 |      4 | 5581e882 · camera | —                            | ebe01971 (clip) |      1 |     6/6 | save, on the beat |   1.41 |
| #1   |     5 |      5 | 5581e882 · camera | —                            | —               |      0 |     5/5 | —                 |   0.80 |
| #2   |     6 |      4 | 5581e882 · camera | 3bb6f269 · made-here · dolly | 3bb6f269 (held) |      1 |     6/6 | —                 |   1.41 |
| #3   |     5 |      4 | 5581e882 · camera | e64e900a · camera · zoom     | —               |      1 |     5/5 | —                 |   1.41 |
| #4   |     5 |      5 | 5581e882 · camera | —                            | —               |      0 |     5/5 | —                 |   0.80 |

**Pooled: camera 22/27 = 81% (B_ad 57%), i2v 5 — all on her camera photo, 0 made-here (B_ad 2 of 5
made-here), held 2, b-roll 3, made-here 2 slots (B_ad 10), lookalike 0, all-camera 2/5, reasons 27/27,
mean list $1.17 (B_ad $1.04).**

**Recap n=3 (against B_recap')** — every cell six or five windows of her camera clips (d076a790,
e055746a once): **camera 16/16 = 100% (B_recap' 92%), made-here 0, i2v 0, b-roll 0, left out 0
(B_recap' 4), all-camera 3/3, reasons 16/16, list $0.**

Against the prediction:

- Reasons 100% — **held** (43 of 43 items; a nulled reason would have reached the route as null, and
  none did).
- Ad gates 0, lookalike 0 — **held**. Camera ≥ 50% — **held**, and above the predicted 50–70% (81%).
  Mean list ≤ $1.30 — **held** ($1.17; +13% on B_ad, one more b-roll). A zoom across five cells —
  **held** (#3, on her own product photo e64e900a).
- i2v ≤ 4 — **missed**: 5, one per cell, as in B_ad. What moved is WHICH photo: 5 of 5 on her camera
  photo, against 3 of 5 in B_ad. The stated cost and risk did not remove the one i2v an ad asks for;
  they moved it off made-here stills. Inside the ≤ 7 threshold.
- Recap: made-here 0, i2v 0, camera ≥ 82% — **held**. Left-out ≤ 2 — **held**, at 0: with S1c on the
  made-here line the planner stopped naming the clips the gate would refuse.
- Music in ≥ 3 of 5 ad cells — **missed**: 1 of 5 (a track, "save", on the beat, brandSafe). Look 0 of 8. The fields are optional in the prompt and the model mostly leaves them; 6d seeds what it sets and
  falls back to the Board's own suggestion when it sets none. Carded, not chased: whether the planner
  should be REQUIRED to pick music is a taste call for Adi.

Spend to here: ≈ $0.81 + $0.60 = **≈ $1.41** of ~$2.90.

## 6a3 — a plan is a stored, versioned object (migration 0061)

**Recon, as found.** Nothing stored a plan: the route answered JSON, the Agent screen held it in
`useState`, and the Board took rows in route params (card 4 of docs/studio-agent-open-cards.md decided
saving OUT of v1; this reverses it with its own table, not studio_session_entries, which is the leak card
4 feared). Minimal points: WRITE in the route after castPlan; READ a new GET by id; SEED `BoardSeed`
gains `planId`.

**Prediction, before the commit.** 0061 is one additive table, the drafted DDL with ONE change stated:
the parent FK is NO ACTION, not `ON DELETE SET NULL (parent_plan_id)`. PGlite and Postgres 15 run the
drafted form, but Drizzle 0.39 cannot declare a column list, so the parity test against schema.ts could
not hold it — and a bare SET NULL on the composite key would null athlete_id. NO ACTION is the fallback
Adi approved (the reason differs from the one he pre-approved it for — PGlite does support it — and is
said here). The migration test (server/studio/agent/plans.migration.test.ts, 0060's harness) holds:
applies and re-runs as a no-op; the revert leaves no orphan; a child under another athlete's plan is
refused by `studio_plans_parent_fk`; deleting the athlete takes parents and children in one statement;
a parent with a child cannot be deleted alone; the deal row going nulls `deal_deliverable_id` and keeps
the plan; parity with a schema.ts push; names under 63; listed once in db-migrate.sh step 3, after 0060.
**For the first "delete this plan" feature:** with NO ACTION on the parent FK, a single plan row
cannot be deleted while a child points at it — the DELETE fails on `studio_plans_parent_fk`. Nothing
deletes a plan today, so nothing hits it; that feature must delete the lineage leaf-first, or re-point
or null the children's `parent_plan_id` in the same transaction, or change the FK (a new migration).
Only the athlete cascade removes a parent today, and it takes the whole lineage in one statement.
Mutations: plain parent FK → "refuses a child filed under ANOTHER athlete's plan" (+ parity); deliverable
CASCADE → "nulls the deliverable and keeps the plan" (+ parity).

The route writes a row per answered plan (signed urls stripped; a failed write is logged and the plan is
still answered, with `planId: null`); `parentPlanId` in the body is a regenerate — checked as hers BEFORE
any model call, written as version + 1. `GET /studio/agent/plans/:id` re-opens the stored object with
fresh urls from her own rows — no planner, no search. Mutation "cross-athlete plan read" (drop the
athlete filter in `readPlan`) → reds that case by name. The Agent screen sends `parentPlanId` when the
same ask is planned again; the seed carries `planId`; `openStoredPlan` is the client's read.

**Result.** Held: plans.migration.test 9/9 (and 0060's suite unchanged, 34/34 across both); the route
suite 52/52 — stored and re-opened as the same items, look, music and gaps with zero model and zero
search calls on the read; no signed url in the row; version 2 under its parent; another athlete's id a
404 to read and as a parent, before any model call. Each mutation red exactly its named case(s),
restored from a backup. DDL applies to Cloud SQL only through db-migrate.sh on a deploy — not run here.

### Gate — lane 6a (the whole suite, `npm test` bare, on the 6a3 working tree)

Read from the per-batch summaries, not the exit code (exit 1): 18 batches, 16 green — server/routes
670, server/studio 1130 + 1320 + 798 + 345, client#2 731, voice 703, and the rest. Two reds, BY NAME:

- `agentLogic.test.ts` › buildSeed "hands the Board the objective with the rows" — MINE: the seed now
  carries `planId: null` and the exact-shape assertion did not name it. Fixed (the field named, and a
  case for a stored id); the file re-run green, 40/40 with routeCell.
- `affiliationSync.test.ts` "a year-only from/to (registry v2 allows YYYY)…" — the ORDER BY tie of
  commit 0b, red as expected, and the ONLY red outside this PR's own diff.

### Do the reasons read like reasons? (Adi, before 6b — one ad cell on 21e361a, ≈ $0.075)

The run files had kept only each reason's entry id; the runner now keeps the whole reason and prints the
line she reads. One ad-brief cell, verbatim:

- clip.camera — "A perfect, authentic opening beat showing preparation for the ad."
- clip.camera — "Shows dynamic action and her taking the pitch to build energy."
- clip.camera — "High-energy skill showcase that serves as the core action of the ad."
- i2v — "A premium, slow-motion hero shot from her own photos that elevates the edit to ad quality."
- broll — "Adds scale and a professional stadium atmosphere to the ad without needing her in frame."
- clip.camera — "A strong, confident portrait from her own footage to close the ad."

They read as reasons — each ties the choice to its moment, and the paid one says what it buys. Two
notes: `over` ("what it beat") was null on all six — the half of the reason the planner mostly skips;
not chased here. And the card doubled the stop ("…for the ad. — your camera clip.") — `reasonWords`
now ends a line with one stop (tested). The i2v line's "slow-motion" is the model's taste, not a
capability the entry offers: a watch item for 6b, where the prediction is that `fits` cites the
campaign.

Spend to here: ≈ $1.41 + $0.075 = **≈ $1.49** of ~$2.90.

## 6b — the campaign brief enters the planner, behind STUDIO_BRAND_PROFILES

**Built, to PR 3's carded boundary.** `PlanAsk.campaign?: CampaignBrief`. The route takes `campaign`
only with STUDIO_BRAND_PROFILES on — off, it is an unknown field (400) exactly as before, and nothing is
called; on, `validateCampaignBrief` (strict: an unknown key or an athlete id is a 400 with its issues,
before any model call), and a product handle must name one of the products she picked ("product_2" is
p2). The prompt renders it in `campaignBlock`: every value through `fenced` inside `<<<CAMPAIGN>>>` /
`<<<END_CAMPAIGN>>>`, under a header that says it is data, placed after her ask and before the library,
and it asks that a choice the campaign shapes say so in its reason. The brief is stored on the plan row
(0061's `brief`), and PR 3's `studio_campaign_briefs` card is superseded by it (decision 6).
`CampaignBrief.product` gains `line` (decision 2) and its `ref` becomes nullable — a product named only
in words, as the 6d walk has it; a product with neither is refused.

`over` (Adi's 6a2 question — skipped, or a phrase dropped?): the parse now keeps an `over` that is not an
entry id and logs it as `reason_outside_library` with `over:<words>`, and the reason field asks for
`over` whenever another line could have carried the moment. That prompt line changes the NO-campaign
prompt too, so the no-brief control is re-run below.

Mutations, each red by name, restored from backups: "fence removed" (markers dropped from
campaignBlock); "brief text reaches the prompt unfenced" (`fenced` skipped on the story); "with the flag
off a campaign is an unknown field, and nothing is called" (the flag check dropped). A prompt without a
campaign is byte-identical to one that never had the field (tested).

**Prediction, before the runs.** Fixture `server/studio/campaign/fixtures/bottle-campaign.json`
(synthetic brand Solstice, product LINE "the matte-black Solstice insulated bottle", no photo; tone calm,
focused; energy steady), planned n=3 on "a soccer ad with me in it", grow-following, through the route:

- **≥ 1 item per cell whose reason cites the campaign** — `fits` contains any of: campaign, brief,
  solstice, bottle, calm, focused, steady (the runner's `--cites`). Predicted 3/3 cells.
- Gates 0, lookalike 0. No i2v of a product it has no photo of.
- Flag-off cell: the same body with STUDIO_BRAND_PROFILES off answers 400 `campaign`, $0.
- No-brief control n=3 (the `over` line changed its prompt), against B_ad: camera ≥ 50%, i2v ≤ 4 at
  n=3, mean list ≤ $1.30, reasons 100%. `over` named on ≥ 30% of items (was 0 of 6) — if it stays near
  0 with no `over:` lines in the server log, the model skips it even when asked, and it is carded.

### 6b runs (dd133da; the flag-off server, then STUDIO_BRAND_PROFILES=true — both started by Adi)

**Flag-off cell:** the fixture body answered `400 unknown field` (`campaign`) in 818 ms — nothing called,
$0. **Held.**

**No-brief control n=3** (the `over` line is in its prompt): camera 13/17 = 76%, i2v 2, held 1, b-roll 2,
made-here 2 (clips, off an own-footage brief), reasons 17/17, mean list $0.94 — **inside every threshold**
(≥ 50%, ≤ 4, ≤ $1.30, 100%). **`over` named on 12 of 17 (71%), from 0 of 6**: the answer to Adi's
question is SKIPPED — optional in the prompt, the model left it; asked for, it names it. The `--cites`
words matched 1 of 17 here with no brief at all ("focused" in an i2v line) — the measure's noise floor.

**Fixture brief n=3** (Solstice, the bottle as a line, calm/focused/steady):

| cell | slots | camera | i2v | held (move)               | b-roll | cites campaign | over | look | list $ |
| ---- | ----: | -----: | --: | ------------------------- | -----: | -------------: | ---: | ---- | -----: |
| #0   |     6 |      5 |   0 | 5581e882 · camera · dolly |      1 |            5/6 |  1/6 | cool |   0.61 |
| #1   |     5 |      4 |   0 | 5581e882 · camera · dolly |      1 |            3/5 |  4/5 | cool |   0.61 |
| #2   |     5 |      4 |   0 | 5581e882 · camera · dolly |      0 |            5/5 |  5/5 | cool |   0.00 |

**Pooled: cites the campaign 13/16 (control 1/17), every cell — HELD, well above the noise floor.**
Camera 13/16 = 81%, i2v 0 (control 2), held 3 — all her camera photo pushed in, each "over i2v" — made-here
1, lookalike 0, reasons 16/16, mean list $0.41. The look was set in all three cells, "cool", each reason
naming the brand's clean, minimal feel or the "staying cool" story (the planner left look unset in 8 of 8
no-brief cells). No i2v of a product it has no photo of; the b-roll's reason says it sets the brand's look
"without showing the missing product". Gates 0. Verbatim, #0's opener: "Starts the ad with a calm,
focused moment of preparation using her own footage."

Spend: 6b ≈ $0.46 (control $0.23, fixture $0.23, flag-off $0). To here **≈ $1.95** of ~$2.90.

## 6c — concept before coverage

**Built.** Two model steps behind the one route. `stage: "concepts"` → `deriveConcepts`
(studio/agent/concepts.ts): her ask, objective, feel, sport and campaign — NONE of her library (the route
reads the library for her sport alone, the identity fact the planner already gets) — two or three
concepts (angle, feeling, one line); a reworded repeat of an angle is dropped and fewer than two refuse
the step; nothing is planned or stored. Then `concept` in the plan body carries her pick: rendered in a
fenced CONCEPT block that asks the coverage to serve it, and to TRIM the concept to what her library
holds and say so in the reason — never to stand in a shot the rules refuse, never to plan a generated
shot of her only because the concept wants one; cast.ts vetoes whatever it asks regardless. The picked
concept is stored on the plan row (0061's `concept`) and answered with the plan. The Agent screen: "Plan
it" asks for the ideas; they show as cards with the first picked; "Plan this one" plans — nothing plans
or spends past the one concept call until she taps (the interaction proposed in the opening report).

Mutation "the concept step never sees her library" (the ask serialised into the concept prompt) reds by
name in concepts.test; the route suite stays green under it because the route never hands the library
over. A plan without a concept is byte-identical to one that never had the field (tested).

**Prediction, before the runs** (pre-registered in the opening report; FOLDED to fit the envelope — one
recap run serves three of them):

- Recap ("recap my training, use live footage", brief 12) `--concepts --pick B`, n=3 (6 calls):
  - concepts DISTINCT in every cell: 2–3 distinct angles and every pairwise line overlap (word Jaccard,
    4+ letters, stopwords out) < 0.5 — and by my read, three ideas, not three rewordings;
  - picking B: **≥ 50% of the items' reasons reference B** (its angle/feeling words, or "concept");
  - against B_recap': made-here 0, i2v 0, camera ≥ 82%.
- Ad-brief `--concepts --pick A`, n=3 (6 calls), against B_ad: camera ≥ 50%, i2v ≤ 4, mean list ≤ $1.30,
  reasons 100%, gates 0.
- Ceiling 12 × $0.075 = $0.90; concept calls are shorter, so ≈ $0.75 expected. To ≈ $2.70, leaving 6d's
  walk ≈ $0.15.

### 6c runs (d3ee1b2, server restarted by Adi; 12 calls, ≈ $0.75 expected)

**Recap `--concepts --pick B`, n=3.** Concepts: 3 per cell, 3 distinct angles every cell, every pairwise
line overlap 0.00 — **distinct, HELD.** By my read, three ideas each time, not rewordings — with one
honest caveat: in two cells A and C both lean on "practice is rehearsal for match day" (A: "the
translation from practice to pitch", C: "mastering the chaos"); different angles, not fully independent
ideas. B each cell — "the pursuit of the perfect touch", "the relentless pursuit of muscle memory",
"instinct versus calculation". **Reasons reference B: 10 of 14 pooled (71%) — HELD** (cells 4/5, 4/5,
2/4; the last exactly at the bar). Against B_recap': **made-here 0, i2v 0, camera 12/14 = 86% — HELD.**
b-roll 2 (B_recap' 1), left out 1, all-camera 1/3, reasons 15/15, mean list $0.41. Cell #1 chose a bed on
the beat, citing B: "A dark, heavy phonk beat that perfectly underscores the gritty, relentless pursuit
of muscle memory."

**Ad-brief `--concepts --pick A`, n=3.** Concepts distinct again (angles 3/3/3, overlaps ≤ 0.14).
**Against B_ad: camera 10/15 = 67%, i2v 0, mean list $0.61, reasons 15/15, gates 0, lookalike 0 —
HELD.** Reasons reference A on 14 of 15 items. Music chosen in 2 of 3 cells (the track "status", on the
beat, "over music.bed"), a "muted" look once — each reason naming the concept's gritty tone.

**Taste note, carded:** several concept LINES speak in her voice about making the ad itself ("They told
me to make a soccer ad, but the truth is…", "If I had my own commercial…"). Meta, and maybe not what a
brand wants; a prompt-wording question for Adi, not a gate.

Spend: 6c ≈ $0.75 (estimate — the route does not return tokens). To here **≈ $2.70** of ~$2.90; 6d's walk
≈ $0.15 left.

## 6d — the brand post terminates in the Board

**Recon, answered.** (1) All three steps are one route, `client/screens/studio/BrandPostScreen.tsx`
(brand pick; `BriefStep`) plus `SetupScreen.tsx` (shared with the personal post). Brand pick and the
brief step survive; "Set it up / Build the plan" is replaced for the brand post only, behind the flags.
(2) Formats: Photo, Carousel and Story are one image pipeline (the aspect is the only difference; a
carousel is one image) — the Board is a video editor, and a "photo" of held stills would be a video
file. So **Video lands on the Board; Photo / Carousel / Story continue to the old screen in that
format** (a TODO card, not faked). (3) "Your media" (`MediaLibraryView`, /me/media, attachment roles)
does not map to the Board (`StudioMediaPicker`, /studio/media): it is dropped (decision 3); the product
photo uses the Board's own picker, as the Agent screen's products tray does. The plan→Board mapping is
`seedRowsFrom` (not `asPick`, a server cast helper) — extended, not duplicated.

**Built.** Behind `STUDIO_AGENT` + a new client flag `EXPO_PUBLIC_STUDIO_BRAND_PROFILES` (both off →
today's flow exactly), the brief step keeps the deliverable's id, "Upload a brief" stores a PDF under
`studio-briefs/<her id>/` through a signed write url (the contract upload's pattern — which signs only
with a service-account key, so it works deployed, not on a laptop), and the last step is
`BrandPlanStep`: format chips, the product as a photo and / or a line, her words. "Plan it" runs the
concept step on the brief the screen assembled (`brandCampaignBrief`, no model call, the server's own
schema — tested); "Plan this one" plans it with the concept, and `brandBoardSeed` lands her on the Board
under the brand objective: every row with its WHY (a shared `WhyChip`), any of the four moves with its
point, the plan's look, its music as HER pick (touched, so the suggestion never overrides it) and On the
beat, `dealLinked`, the plan id. `applySeed` now sets look and music from the seed — or resets them, the
pre-PR-6 carry-over of the last board's pick fixed. A seed with a plan id and no rows RE-OPENS the stored
plan (GET, no planner) into the same rows under the same nonce. The route takes `dealDeliverableId`
(hers, checked before any call) and `briefFilePath` (under her prefix), both stored on the plan row.
Nothing on the Board runs or spends until she taps it there — the same Board.

Mutations, red by name, restored: "brief dropped between flow and planner" (campaign left out of the
plan body) → brandPlan.test; "another athlete's deliverable is refused, before any model call" (athlete
predicate dropped in `ownsDeliverable`) → studio.agent.test. The forBrand prediction as a test: the
brand Board's seed objective is brand work, and the server's own `suggestMusic` never offers a
brandSafe=false fixture track under it — with the own-content control offering the same track; PR 8's
suggest and recommend suites green.

**Gap list — plan fields with no Board control to land in (for Adi, not silently dropped):**

- Captions, their font, a title — the Board has no caption control (Video tab only); entries
  `onBoard: false`, never planned.
- text_graphic — no plan kind, no row type.
- `capabilities.camera` / `.lighting` on an i2v or product row with a photo — the Board allows only its
  movement slot there; the values are lost (pre-existing).
- `capabilities.environment` — nothing maps it to the Setting slot.
- A clip's trim — seeded, but the Board shows it read-only ("Use the whole clip" is the only edit).
- `direction` / `beat` on a held photo or clip row — no text control there; the WHY chip carries the
  reason.
- A held photo's hold length — no plan field; the server's default, or 4 s with a move.
- The concept and `gaps` — stored on the plan row and answered, not shown on the Board.
- `dealLinked` — carried into the Board, not shown.

**Prediction for the walk, before it** (Adi: Jane Street, skip the brief, Video, one product line;
server with STUDIO_AGENT and STUDIO_BRAND_PROFILES on; Metro on 8083 with both client flags; phone-width
Chrome): the concept step answers 2–3 ideas; "Plan this one" lands on the Board with the plan as rows,
each with a WHY, at least one naming the product line or Jane Street; the Board's objective is brand work;
a stored plan row exists with the brief (read back through GET /studio/agent/plans/:id, no planner); and
GET's items equal the plan's — so re-opening renders the same rows. Two planner-sized calls, ≈ $0.15.

## The 6d walk (Adi, phone-width Chrome, f17507b) — and what it showed

**The walk** (Jane Street, skip the brief, Video, product photo e64e900a and the line "the matte-black
insulated soccer ball", no words of her own): the concept step answered; she picked B; the plan landed
on the Board — five rows, each with a WHY, the brand objective, a "warm" look. The stored row holds the
brief, concept B, the look, one gap line; `GET /studio/agent/plans/:id` re-opened it in 990 ms with NO
planner call and the same five items as stored — **the plumbing predictions held.** Two planner-sized
calls, ≈ $0.15. Only one row (shot 3, the product) read as relevant — Adi's "a little RNG".

**Diagnosis — the exact prompt read back (33k characters, rebuilt from the stored brief and concept on
the real library path; one embedding call, no planner).** The planner did roughly what it was given:

1. Her ask was the flow's own fallback line ("A video for Jane Street, with the matte-black insulated
   soccer ball") — "Anything else" was empty.
2. The CAMPAIGN held a brand NAME and the product line, nothing else — no feel, no story, no attributes;
   the flow collects none.
3. The concept step, handed those two lines, invented an idea AND a product claim — "No matter how much
   the match heats up, the Jane Street matte-black insulated soccer ball is built to keep its cool". **An
   ungrounded concept inventing a brand claim: a 6c bug** (fixed below).
4. The product PHOTO contradicts the product LINE: p1's own line is "a classic black and white soccer
   ball with the 'BOLYN sporting goods' logo"; the plan merged them ("…BOLYN… The Jane Street ball").
5. **The library holds very little of HER** — 30 lines; all sixteen photos with a person in them are
   MADE HERE, of several different players (Stanford, Gotham FC, Adidas / Nike kits); her own camera
   gives three clips (unverified) and non-person photos (bangles, earrings, colour blocks). The i2v (a13,
   a made-here Stanford still) and the held "OWN THE PITCH" photo were the best the library had.
6. Two sampling steps at temperature 0.6 compound the spread.

**Cards (Adi, 22 Sep 2026):**

- **PR 7 — collect the feel.** A brief's feel, story and attributes are `propose_campaign` /
  `summarize_brief`'s output; not a raw field on the brand step. This walk is the citation.
- **PR 7 — the product mismatch.** A product photo whose line names another brand than the campaign's
  is Mila's confirm-inferred-lines step reading the reference; not a pick-time flag in 6d.
- **THE UPSTREAM CARD — the library's identity problem, gating plan quality.** Her library is mostly
  made-here images of several different players: the data behind the lookalike (a6a8b954), the
  "several women" note (athlete 3811cedd), and this walk's thin plan. Not a planner card — the raw
  clips ask to Mia solves it. No prompt or gate change downstream of it can make a plan of her out of
  images that are not of her.

## 6c fix — the concept step is grounded (prompt-only)

**Built.** `CONCEPT_GROUNDING` in the concept prompt: never state or imply a product or brand feature,
benefit or claim — how it performs, what it is built or designed to do, what it keeps, resists or
survives — unless the campaign's own line or story says it; the product is shown, never sold with a
claim; a thin brief builds each idea around HER and the product as it is. Mutation "the concept step
invents no claim the brief does not make" (the line dropped) reds by name; restored.

**Prediction, before the recheck** — the walk's own inputs through the route (the stored brief, product
e64e900a, the fallback ask, showcase-product), `--concepts --pick A`, 2 cells (4 calls, ≈ $0.30,
**approved PAST the $2.90 envelope — an overage, ledgered**): no concept line claims what the product
does ("keeps its cool", "built / designed / engineered to", "withstands", "performs", "never …") — "insulated"
itself is HER word, from the line, and is not a claim; and each thin-brief concept is built around her
(her sport, her moment) with the product as shown.

### The grounding recheck (3df5702; the walk's inputs; 4 calls ≈ $0.30 — PAST the envelope, ledgered)

Six concepts over two cells, every one built around HER with the product as shown — "…just me, the
pitch, and the matte-black insulated soccer ball from Jane Street", "Before the whistle blows, it's just
a quiet field, my cleats, and the Jane Street matte-black insulated soccer ball", "Another day on the
pitch, putting in the work with Jane Street and this matte-black insulated soccer ball". **No concept
claims what the product does** — no "keeps its cool", no "built / designed / engineered to", no
"withstands"; "insulated" appears only as her own word from the line. **Both predictions HELD.** Angles
distinct in both cells (line overlaps ≤ 0.47). Reasons reference the picked concept 9 of 10.

Noted, not chased: (a) angles are cut at 60 characters mid-phrase ("…the product on a traditional") —
`MAX_ANGLE`; (b) the concept lines still speak in her first person, and name the brand and product in
every line — the taste note above stands; (c) the plans themselves still lean on made-here stills of
other players (cell #1: an i2v on e05973aa, list $2.82; pooled camera 5/10, mean $2.02) — THE upstream
library card, not a planner or concept issue.

**Spend, final:** ≈ $2.70 to 6c + ≈ $0.15 the walk (Adi's, through the UI) + ≈ $0.30 this recheck =
**≈ $3.15 against the ~$2.90 envelope — ≈ $0.25 over, the recheck Adi approved past it.** All figures
are planner-call estimates at $0.071–0.075; the route does not return tokens.

## OPEN before close — the agent door drops a brand board's context (6d wiring gap)

Recon (Adi's question): the manual Board's "or let the agent build this for you" is
`StudioHomeScreen.tsx:149` → `nav.navigate("StudioAgent")` with NO params (`StudioAgent: undefined`,
`MainTabNavigator.tsx:209`). It lands on a BLANK Agent ask — no words, the objective `grow-following`
(`AgentScreen.tsx:108`). It does go through 6c → the planner → a stored plan → the Board (no MakeIt, no
bypass), but it carries nothing — and the Board holds nothing to carry: after `applySeed` it keeps rows,
objective, look and music; the seed's `planId` and `dealLinked` are not kept in state. From a board the
BRAND flow seeded, the door therefore drops the brand objective, the CampaignBrief (product line), the
product photo and the deal deliverable: the re-plan is own-content work — no CAMPAIGN block, the music
guard's forBrand false (uncleared tracks eligible again), no deal or brief on its row, no parent link.
On a hand-built Board nothing is lost. **By Adi's rule a 6d wiring gap, not a card — FIXED in this PR
(Adi: "forBrand flipping false on a brand board is the exact uncleared-track exposure we've been gating
against").**

**The fix.** The Board keeps the seed's plan id (`boardPlanId`; an emptied board forgets it); the door
passes `{ fromPlanId }` (`StudioAgent: { fromPlanId?: string } | undefined`); the Agent screen opens that
plan — `openStoredPlan`, GET, no planner — and inherits it through one helper
(agentLogic `inheritFromStoredPlan` / `inheritedBody`): the CampaignBrief and the deal deliverable ride on
the concept call and the plan call; the plan's product photos are set, in order (so "product_1" still
names the first — and if she removes them all, the brief's handle goes and its line stays); the objective
is the brand objective; the re-plan is the stored plan's CHILD (`parentPlanId`, version + 1). The concept
step rebuilds from the brief and the product. **Her original words are NOT preserved** — the plan row
does not store the ask and no DDL was added for it: the ask starts from the brief's own fallback line
("A video for <brand>, with <product line>"), which she can type over; the BRIEF is the signal. Also
fixed on the way: the Agent screen's own Board seed now carries the plan's look, music and deal linkage
(`planSeedExtras`), not only its plan id.

Tests (brandPlan.test): "brand context dropped at the agent door: never — …" (the request carries
campaign, deal, brand objective and product, as the stored plan's child) — mutation (campaign dropped in
`inheritedBody`) reds it by name; "forBrand stays true through the re-plan" (the inherited objective is
brand work and the server's own `suggestMusic` never offers an uncleared fixture track under it); a
hand-built board's plan inherits only its lineage; removing the product photo drops the handle, keeps
the line. Client suites 807 green.

**Verification, predicted before it:** (a) $0 — the walk's stored plan re-opened (GET) and inherited:
the request it builds carries the Jane Street brief, the product e64e900a, showcase-product, and the walk
plan as parent; (b) one brand re-plan cell through the route with exactly that request (the concept
step, then the plan; ≈ $0.15, past the envelope, on Adi's approval): 200, a CHILD row (version 2, parent
the walk plan) holding the brief, and the concept built from the brief and the product.

**Verification — both HELD** (server 21:01 on 515389a, STUDIO_BRAND_PROFILES on):
(a) $0 — `GET /studio/agent/plans/e562d337…` (the walk plan) answered 200 in 1.7 s, no planner; the
client's own `inheritFromStoredPlan` / `inheritedBody` built the request: prompt "A video for Jane
Street, with the matte-black insulated soccer ball" (the brief's fallback line), objective
showcase-product, productAssetIds [e64e900a], campaign = the Jane Street brief (product_1 + its line),
dealDeliverableId null (the walk skipped the deal — correct), parentPlanId e562d337.
(b) one cell, Adi's "go" (2 calls ≈ $0.15): 200; concepts rebuilt from the brief and the product, none
claiming what the ball does ("Before the stadium gets loud, I find my focus on the pitch with Jane
Street"); the stored row d170cab4 is **version 2, parent e562d337**, holding the Jane Street brief and
the picked concept "the quiet isolation of pre-game focus". The plan itself: camera 3/5, one i2v on a
made-here still (e05973aa, list $2.82) — THE upstream library card again, not the door.

**Spend, final:** ≈ $3.15 (above) + ≈ $0.15 this cell = **≈ $3.30 against the ~$2.90 envelope —
≈ $0.40 over, all of it past-the-envelope spend Adi approved by name** (the grounding recheck, this
re-plan cell).

## UI cards from the manual-Board screenshot (Adi, 22 Sep 2026 — not PR 6 blockers)

- **PR 9/11 UI polish — the agent door reads like a plan-review step.** "or let the agent build this for
  you" is the manual Board's door to the Agent screen (recon: `StudioHomeScreen.tsx:149` passes
  `onOpenAgent` → `nav.navigate("StudioAgent")`, behind EXPO_PUBLIC_STUDIO_AGENT; it prices and spends
  nothing). It renders directly above the quote panel (`StoryboardTab.tsx:1281`, "below her uploads,
  above the price"), so it reads as part of the pre-generation check. Tighten the copy (and/or its
  place) so it reads as an alternative way to build the board, not an action on this one.
- **PR 9 (the cost / quote surface) — the cost line contradicts the button.** The quote label is built
  as "3 shots · 2 photos held · $0" (`StoryboardTab.tsx:2205`): the "$0" belongs to the held photos, but
  it reads as the total beside "$2.77 Make the board". Show the real breakdown — "$0 held + $2.77
  generated = $2.77".

## PR 6 — CLOSED (23 Sep 2026)

**Final gate, the whole suite at 515389a** (`npm test` bare, read from the per-batch summaries — exit 1):
446 suites, 8,670 tests; 17 of 18 batches green. **One red, by name:** `affiliationSync.test.ts` "a
year-only from/to (registry v2 allows YYYY) never reaches a date column…" — commit 0b's ORDER BY tie
(red, red, green in isolation on origin/main; green on the f17507b gate, red on this one), outside this
PR's diff; its fix is queued on its own chore branch. Nothing else red.

**What PR 6 is, commit by commit** (all unpushed; Adi pushes): 57115f9 route runner + eval bypass fenced

- baselines · 98b9d0d S1c (made-here clip gate) · 7ff7733 / d90a671 6a1 (dolly + capability entries) ·
  21e361a / 00c59fa 6a2 (planner on entries, reasons) · 933729d 6a3 (0061 studio_plans, applied to dev by
  Adi) · dd133da / 0619c2e 6b (campaign brief) · d3ee1b2 / 53c73e7 6c (concepts) · f17507b 6d (brand post →
  Board) · 3df5702 6c grounding fix · 515389a 6d agent-door fix · docs 87b46db, 54b98cb, this.

**Spend ≈ $3.30 against ~$2.90** — ≈ $0.40 over, the grounding recheck and the door re-plan, each
approved past the envelope by name. Planner-call estimates at $0.071–0.075; the route returns no tokens.

**Cards carried out of PR 6:** PR 7 — the brief's feel / story / attributes (summarize_brief /
propose_campaign), the product-photo-vs-line mismatch (Mia's confirm-inferred-lines); PDF → brief;
Mila pre-fill; entry auto-refresh; "save as template"; bed mood tags; made-here-still-never-held-when-
camera-covers (a score, not yet a gate); Photo / Carousel / Story on the Board; the 6d gap list above;
the concept lines' first-person voice and the 60-character angle cut; PR 9 — the cost line's "$0";
PR 9/11 — the agent door's copy; stitch re-checking brandSafe; A2 on the planner side (the library still
shows meta images); a Board clip-trim editor. **THE upstream card gating plan quality:** her library is
mostly made-here images of several different players — the raw-clips ask to Mia.

## Commit 0b — affiliationSync "year-only from/to" (read-only, $0)

Isolated on origin/main 2bedd2e, three runs of the file: **red, red, green** — both reds are line 149,
`Expected "2026-09-11", Received null`. Not a date bug: `AT` is a fixed UTC instant and nothing reads the
clock. The two facts share `retrieved_at` (AT); `affiliationSync.ts:42-44` orders by `retrieved_at,
created_at` with no final tie-break, and `created_at` is `defaultNow()` on two back-to-back inserts. When
Current Club is processed first there is no open row for it to close, and Year Only FC's `ended_on` stays
null (line 65 has no year-only rule) — the "existing rule" the test's comment names is a side effect of
line 87, not a rule. Fix belongs on its own chore branch: distinct `at` per fact, `id` as a last
tie-break, and an explicit decision on a year-only historical end.
