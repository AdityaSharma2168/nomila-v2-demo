# The first live Brain run on the durable substrate

What happens, for Mia, when Nomila thinks about her real situation and writes down what it decided: the Brain reads
her live Objectives, her Athlete State, her Opportunity map, the eight brand negotiations she already has open and the
hand-assembled Context block; it answers one question per Objective; and each answer becomes a Recommendation she can
later accept or decline. Nothing is sent, nothing is planned, nothing is executed. This checkpoint is the first time
that path ran against a real provider with real inputs and wrote its result into the durable substrate rather than a
file beside it.

Underneath: one shared input assembly feeds both the harness and the durable loop, the run is written before any
Recommendation that points at it, Campaign creation and the Recommendation's execution reference now land in one
transaction, and the audit ledger is generated out of the database instead of written alongside it.

Backend only. No athlete-facing surface ships here. `BRAIN_SUBSTRATE_LOOP` stays off by default.

---

## 1. One live input assembly, shared

`server/services/brainInputsBuilder.ts` now holds the only live Brain input assembly, lifted verbatim out of
`brainRun.ts`. `buildLiveBrainInputs` reads the five blocks from the database — live Objectives, deferred and declined
from history, Athlete State, the latest persisted Opportunity map, Existing Work — and `gateForVariant` applies the
same variant gating as before (`map` from V1, `work` from V2, `context` from V3, `research` on V3 only). Decision
requests, decision subjects and the commercial attachment are still established by the caller and passed in; the
builder invents no input.

Three callers share it: the harness (`brainRun.ts`), the durable loop's operator
(`server/scripts/intelligence/brainLoopDurable.ts`), and any future scheduled caller.

**Equivalence was proved against real dev data, and the proof caught a regression.** The first refactor did not pass
`context` and `research` through, and the comparison reported `differs: context` with the rendered prompt 4,115
characters shorter than the legacy path. After the fix:

| check | result |
|---|---|
| inputs structurally identical | true |
| prompt byte-identical, timestamps normalised | true |
| prompt length, legacy vs builder | 60,236 / 60,236 |

The claim was then re-proved between the two callers that remain — the harness's definitive pass and the durable
operator's pass, same athlete, same `asOf`:

| check | result |
|---|---|
| inputs identical, build timestamps normalised | true |
| prompt identical, build timestamps normalised | true, 60,252 characters each |
| inputs byte-identical without normalising | false |

The one residual difference is worth stating exactly, because it is not in the builder. `buildAthleteState` stamps
`asOf` from the wall clock on the State and on seven fields beneath it, and takes no `asOf` argument, so two assemblies
at the same logical time differ in those eight stamps and nowhere else. The audit trail is unaffected: a run stores the
inputs it was given, so re-rendering a stored run's prompt reproduces its `promptSha256` exactly. What is not
reproducible is re-assembling the same prompt from the database at a later moment. Recorded, not changed — State is
frozen and its signature is not this checkpoint's to alter.

Existing Work optionally folds in persisted execution rows (campaigns, outreach planning work). Each source degrades
to nothing on its own — a database whose migrations lag these PRs must not fail a run — so the projection is empty
rather than broken on dev today.

## 2. Campaign creation and the execution reference are one transaction

`routeGoverned` previously created the Campaign, then recorded the execution reference on the Recommendation, and
relied on a recovery path if the second write failed. Both now run inside one `db.transaction` owned by the
orchestrator. The separation of ownership is unchanged and is the point: the Campaign writer writes Campaign tables,
the Recommendation store writes Recommendation tables, and neither reaches into the other's. Either both land or
neither does.

A rollback test proves it: with the Recommendation update forced to throw, no Campaign row survives. Writing that test
surfaced a trap worth recording — a `{ ...db }` spread loses drizzle's prototype methods, so the double must be a Proxy
that binds through to the target and throws only on the one inner call under test.

## 3. The live run

`BRAIN_SUBSTRATE_LOOP=true`, one dev athlete, V3, the shared assembly, `brain-eval-spec/0.11.0-exp`
(digest `13c38cf1…`), model `gemini-3.5-flash`. Inputs read live from dev:

```
Mia Bhuta · live 3 · deferred 1 · declined 1 · map 6 opps · work 8 (persisted execution 0) · context 7
```

Governance was not simulated. Nothing was routed. The loop stopped after the run was persisted, the Recommendations
were reconciled, and the audit ledger was exported.

### Where the run is persisted, and why that is not dev

Migrations 0071–0076 ship with the pull requests above this one and are **not deployed to dev** — `brain_runs`,
`recommendations`, `recommendation_events`, `campaigns`, `creative_intents` and `outreach_plans` were each verified
absent. So the run reads its inputs live from dev and persists into an ephemeral store built from `shared/schema.ts`,
the same device used for the closed-loop experiment. Hand-applying the DDL to dev was rejected: a hand-applied file
leaves no ledger entry, and schema present is not the same as recorded as applied.

**This is the one prerequisite for everything in §8: deploy 0071–0076 to dev through the normal path.** Until then no
Brain run on this path survives the process that produced it.

### Three attempts, two refusals

| attempt | verdict | artifact |
|---|---|---|
| 1 | refused — 1 structural, 0 grounding | not recorded; the operator discarded the reply |
| 2 | refused — 1 structural, 0 grounding | `attempt-2-refused.json` |
| 3 | accepted; run and three Recommendations persisted | `attempt-3-accepted.json` |

Attempt 1's reply was lost because the operator threw on the gate verdict before recording anything. That is fixed: a
live reply is now written to disk **before** the gates decide, so a refusal is inspectable and replayable and no
refusal costs a second provider call. Attempt 2's refusal, recorded:

```
decisions[2]: what opens with a production verb ("design") — that is HOW, not WHAT
```

The refusal is stochastic, not systematic. Identical inputs, two refusals and one acceptance.

### What persisted

Run `153dda13-3603-4875-9e14-18fb8218f338`, three Recommendations created, none reconsidered, none withdrawn, nothing
accepted or authorized. Read back out of the store through `loadLedger`, so the round trip is proved, not assumed.

## 4. The three live Recommendations

All three are `RECOMMEND`, subject `objective[…]`, question *what should Nomila do about this Objective now?*,
execution path `specialized_plan`, relation `new_work`, no `intent` (not a commercial subject), no `ends` (not campaign
shaped), `advances` null, `not_seen` empty.

**Yuwa / corporate social responsibility** — `rec_ac0ade506826aabe`, objective `b1c799e3…` (impact).
*What:* develop a targeted commercial outreach strategy to present her leadership with the Yuwa girls empowerment
program to global brands for corporate social responsibility sponsorships.
*Why:* her philanthropic work is a key differentiator in her narrative but has not been commercialized or translated
into active brand sponsorships.
*Cites:* the Objective, `findings[mia.narrative_power]`, `opportunity[amplify-yuwa-philanthropic-work]`.

**Academic and technology positioning** — `rec_91a9601812abc76a`, objective `c0f587e4…` (positioning).
*What:* target premium brand partnerships in education technology, science and engineering, and enterprise venture
spaces by leveraging her Stanford engineering and academic credentials.
*Why:* a strong academic narrative with no active commercial partnership in those sectors.
*Cites:* the Objective, `findings[mia.narrative_power]`, `opportunity[grow-academic-tech-partnerships]`.

**Dormant channel** — `rec_a435736e9f04847a`, objective `feb62891…` (audience).
*What:* reactivate her dormant TikTok channel by cross-posting short-form video content to expand reach and reverse
the cooling audience trajectory.
*Why:* TikTok dormant for over 550 days and a cooling overall trajectory.
*Cites:* the Objective, `contentPerformance[tiktok]`, `audienceTrajectory`, `opportunity[unlock-tiktok-channel]`.

Objective lineage is exact in all three: one Objective per decision, cited as the first reference, and every other
reference resolves to a rendered input. Reconciliation created three and touched nothing else, which is correct for a
first run on an empty ledger.

### R13 — the artefact is not yours

Recorded, not patched.

The gate is **head-anchored**: `opensWithProductionVerb` matches only the first word of `what`. That is what caught
attempt 2's *"Design an integrated content plan…"*. It is also why the dormant-channel decision passed while carrying
*"by cross-posting short-form video content"* — a production method in the middle of the sentence, downstream of the
anchor. The residual R13 leak now sits in the durable ledger rather than a recorded file.

The Yuwa and positioning decisions carry the softer form of the same thing: *"develop a targeted commercial outreach
strategy"* and *"by leveraging her Stanford credentials"* name an approach, not only an outcome. Neither is a
production verb and neither should be refused by the current gate. Whether the Brain's `what` should be outcome-only
is a spec question for a future version bump, not a patch.

### Gate granularity is an availability problem

One structural problem nulls the whole reply. Attempt 2 lost two well-formed decisions and the entire BrainRun because
a third decision opened with the wrong word. On a controlled harness that is correct and cheap. On an athlete-facing
path where a run is expected to produce something, a two-in-three refusal rate that discards everything is a hard
availability problem. Recorded as a decision to take deliberately: per-decision refusal, a bounded retry, or accepting
that a refused run yields nothing. No change made here.

### Existing Work language

Eight open negotiations rendered — TITAD, Musugy, ProBand, IRON Peptides and four more, all `negotiating`, one with a
recorded amount, none with deliverables. All three decisions are `new_work`, which is correct: none of them touches
any of the eight. No decision claimed to advance work it had not been shown, and no negotiation was restated as if the
Brain had produced it.

Worth noting rather than fixing: the eight open negotiations produced no decision at all. This run asked only the
Objective-loop question, with no decision subjects and no requests, so that is the expected shape and not a gap.

### Shape selection

Three of three `specialized_plan`, in both the refused and the accepted reply. Zero `direct_action`, zero `campaign`.

This is the finding that constrains activation most. The dormant-channel decision is close to a single content act and
still came back as a plan. Two of the three need an outreach planner that exists but is behind
`OUTREACH_PLANNER_ENABLED` and deliberately frozen; the third needs a content planner that was deliberately not
productionized. **No Recommendation from this live run is executable today**, and that is by design rather than by
omission.

## 5. No automatic routing

Nothing was routed. No Campaign, no Deal, no planner work, no creative intent. `governedRecommendations` returned
empty because nothing has been accepted or authorized — and the athlete's two acts are hers, performed through the
store by an explicit caller, never by the loop.

## 6. The audit ledger, generated from the database

`ledgerJsonFrom` builds the compatibility `RecommendationLedger` JSON out of the substrate tables. No dual write: the
database is authoritative and the JSON is an export.

Compared structurally against the recorded file ledger from the closed-loop experiment: same version
(`recommendation/0.2.0-exp`), 47 shared keys, nothing present in the file ledger that the export omits. The single
difference is `records[].value.ends`, which the export carries as an explicit `null` where the pre-R17 file ledger had
no such field. A compatible superset.

## 7. Measure → Learn stays frozen

Nothing published, no identity backfill, no ingest change, no outcome table.

The dependency is unchanged and is recorded again because it still blocks: the join from a published post to its
observations depends on **ingest coverage**, not on the join itself. One live publish exists, with a 17-digit platform
media id in the same key shape as the 12,630 observations already stored, and zero observations against it because
ingest next ran two days later. Attribution on real published work cannot be tested until ingest covers that post.

## 8. The smallest athlete-facing activation

**Prerequisite, not optional: deploy migrations 0071–0076 to dev through the normal path.** Nothing below can be built
against a database that has no substrate.

**Proposal: her response, and nothing downstream.** One authenticated read of her open Recommendations — what, why,
the shape, and what each one cites — and her two acts recorded against them: respond (accept, modify, decline) and then
authorize preparation. Behind `BRAIN_SUBSTRATE_LOOP`. No routing, no planner, no Campaign, no send.

Why this and not execution: every decision this run produced needs a planner that is off, so routing cannot be the
first activation without turning on frozen work. Her response is the one input the system provably does not have —
adoption read `unknown` in production until the substrate mounted, and it will keep reading `unknown` until a real
accept or decline is recorded against a real Recommendation. Capturing that produces the first genuine adoption signal
while executing nothing.

What it deliberately leaves out: any surface that implies the work will now happen. `prepare_authorized` must not be
presented as "Nomila is doing this" while no planner is on.

No UI in this pull request.

---

## Artifacts

`docs/audits/artifacts/brain-substrate-live/` — `attempt-2-refused.json` (the recorded refusal and its inputs),
`attempt-3-accepted.json` (the accepted reply and its inputs), `ledger-from-database.json` (the export).

## Provider spend

Three calls on `gemini-3.5-flash`, two of them refused by the gates. The two recorded replies cost $0.0315 and $0.0322;
attempt 1 was not recorded, so the total is approximately $0.095. A refused run costs the same as an accepted one,
which is the other half of F5's cost.
