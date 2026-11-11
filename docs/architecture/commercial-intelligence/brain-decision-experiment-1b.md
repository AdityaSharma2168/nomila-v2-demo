# Brain Decision Experiment 1B — can the Brain discriminate next-move shapes?

**Owner:** Mia
**Date:** 2026-09-26
**Status:** approved 26 Sep 2026 with two fixture changes (R2: facts only, no judgment word; R3: missingness purely factual) and the two envelope additions as experimental. Six calls approved. Run and audit: `docs/audits/brain-decision-experiment-1b.md`.
**Follows:** `docs/audits/brain-context-experiment-1-stage1.md` (Stage 1, accepted). Stage 2 of experiment 1 is on hold behind this.
**Question:** *is the experimental Brain a decision layer, or a recommendation generator?* Stage 1 could not tell: every live Objective had a map opening and no existing work, pending step or missing fact intersected the live portfolio, so RECOMMEND · `specialized_plan` · `new_work` was the only reachable answer. 1B constructs evidence conditions under which materially different decisions are plausible and watches which decision type emerges. It is **not** an attempt to produce better recommendations.

---

## 0. In plain words

The same frozen Brain, the same real picture of Mia, the same approved context fixture. Six calls. In each, one thing about *what is already in motion* is different — a piece of work already advancing an Objective, a reply she owes, a brand whose terms nobody recorded, outreach already sent and awaiting answers, or nothing at all — and we read whether the Brain's decision changes with it, in the direction the evidence supports, citing the thing that changed. Nothing tells the Brain what the right answer is. Nothing is materialised. StartX1 stays exactly as deferred.

## 1. What stays frozen (everything from Stage 1 except the existing-work block)

| frozen | value |
|---|---|
| spec | `brain-eval-spec/0.1.0-exp`, digest `d470d089…` — not one character changes; a different digest invalidates the experiment |
| gates | gate 1 (narrow structural) and gate 2 (grounding) as in Stage 1 |
| model, temperature, output budget | as Stage 1 (`gemini-3.5-flash`, 1.0, 32k) |
| live Objectives | Mia's three, through `liveObjectives()`; StartX1 rendered as the deferred condition; Adidas rendered as declined |
| State | live `buildAthleteState` at run time, persisted with each artifact (the same snapshot for all six calls, taken once) |
| Opportunity map | the persisted map (six openings), as in V1–V3 |
| context | the approved seven-item fixture, unchanged, in every run |
| renderers | unchanged; a controlled item renders exactly as a real one |

**The one variable:** the EXISTING WORK block. Every run carries the real block (gorjana accepted, seven negotiations) plus, per condition, a controlled overlay of one or two items. The overlay is the evidence condition.

## 2. Exact changes relative to Stage 1

1. **Run script:** `brainRun.ts` gains `--work-overlay <file.json>` (items appended to the assembled real block) and `--label <name>` (the artifact's condition name). Nothing else in the script changes. The artifact records `inputs.work.items[].controlled: true` on overlay items so the audit can separate real from controlled; **the renderer does not show that flag** — the Brain sees a work item like any other.
2. **Existing-work envelope:** one additional kind, `activation` — a committed piece of work in execution toward an Objective (a series in production, outreach sent). Stage 1 had no such kind because Nomila holds no such rows; the experiment needs the shape to exist. `WorkItem` gains an optional `objectiveId` (which Objective the work is understood to serve, rendered as "toward objective[<id>]"), because "work already advancing an Objective" is not representable without saying which. Both are `existing-work/0.1.0` → `0.2.0-exp`; **explicitly experimental** — not inferred to be the shape production work objects carry, nor that a durable work→Objective relationship exists in the architecture. 1B needs only an unambiguous experimental representation of "this existing work is advancing this Objective".
3. **Nothing else.** No spec text, no gate rule, no renderer wording, no new cite kind, no context change.

## 3. The matrix — six calls, one variable

Each run: all three live Objectives, State, map, the real existing work, the seven-item context. The **target** is the Objective the condition is built around; the other two are within-run controls (they should not move when the overlay does not concern them — if they do, that is a portfolio-effect observation).

| run | condition | target | controlled overlay (rendered as plain facts) | what a decision layer could plausibly do |
|---|---|---|---|---|
| **R0** | repeatability | — | none — Stage 1 V3 repeated exactly | same as V3 (measures run-to-run variance so 1B's differences can be read against it) |
| **R1** | existing work already advances the Objective | audience | `activation` toward objective[audience]: "TikTok reactivation series in production since 20 Sep 2026: eight short-form videos planned, two published (22 and 25 Sep), next scheduled 3 Oct; Instagram cross-posting of the same clips began 22 Sep." | NO_ACTION · or RECOMMEND that `advances_existing_work` naming it · or a bounded addition — anything but a second reactivation plan |
| **R2** | a bounded executable step is pending | positioning | `negotiating` toward objective[positioning]: "Northlight Learning (EdTech) sent a term sheet on 22 Sep 2026: USD 5,000 for an ambassador agreement covering the 2026–27 academic year, four Instagram posts, no category exclusivity. No response has been sent." Her recorded ambassador floor (USD 3,602) is already in State as `representation.floors[ambassador]` and is not repeated in the overlay: the Brain has to connect the two facts itself. **No word of judgment** ("above floor", "acceptable", "strong") appears anywhere (Mia, 26 Sep). | RECOMMEND · `direct_action` (reply / accept / counter) · `advances_existing_work` — or REQUEST_INTELLIGENCE if something material is still missing — rather than a new outreach plan |
| **R3** | material information is missing, with no deferral saying so | positioning | `negotiating` toward objective[positioning]: "Northlight Learning (EdTech) · negotiating since 19 Sep 2026 · amount not recorded · terms not recorded · exclusivity not recorded." (the shape of Nomila's seven real negotiations). **Purely factual missingness**: no "insufficient information", "needs review" or "cannot decide" (Mia, 26 Sep). REQUEST_INTELLIGENCE has to emerge from the Brain understanding why those facts matter. | REQUEST_INTELLIGENCE (`connected`: read the thread; or `athlete`: ask her) · or RECOMMEND `direct_action` to obtain the terms — rather than a plan to pitch *other* EdTech brands while one is open with unknown exclusivity |
| **R4** | relevant context exists but no intervention is warranted | Yuwa | `activation` toward objective[Yuwa]: "CSR partnership proposal sent 20 Sep 2026 to six brands' impact teams (Meridian Foods, Halden Bank, Corvina Apparel, Ashgrove Energy, Tessera Software, Bright Harbor Health); no reply yet; follow-up date not set." Context (real, unchanged): nothing in the window bears on Yuwa; the control item is present. | NO_ACTION (wait) · or `no_new_work` — rather than a new CSR outreach plan; and no citation of `ctx[…]` that does not bear on Yuwa |
| **R5** | a larger strategic intervention genuinely appears warranted | positioning | none for positioning (real state: no tech partner, no negotiation, no inbound in that sector) | RECOMMEND · `specialized_plan` · `new_work` may be right here; this preserves the case where planning is appropriate and checks the Brain does not swing to NO_ACTION everywhere once conditions vary |

R2 and R3 are the same brand at two levels of information; R1 and R4 are work in motion at two stages (partly done with a next step vs fully sent and pending). R5 is Stage 1's real positioning condition and, with R0, anchors what "unchanged" looks like.

**What is real and what is controlled.** Real: Mia's Objectives, State (incl. her floors), map, gorjana and the seven negotiations, the seven context items. Controlled: the five overlay items above, with fictional brand names (no real company is implied). Every overlay item is a statement of fact in the same register as the real items; none says "already covers", "no action needed", "pending your decision" or anything that names a decision. The controlled facts are chosen so that different decisions are *plausible*, not so that one is *stated*.

## 4. What is read after the run — observations, not a score

Per run, per live Objective: the decision type; `what`; execution path; relation to existing work and `advances`; every cite, split real / controlled / context / control item; `not_seen`; the deferred StartX1 entry (should be unchanged in all six — a change is a finding).

**The discrimination table** (the point of the experiment):

| condition | decision type emerged | cited the controlled item? | relation | execution shape (observation: direct action · larger plan/campaign · intelligence acquisition · unclear) |
|---|---|---|---|---|
| R1 work advances | | | | |
| R2 bounded step | | | | |
| R3 missing fact | | | | |
| R4 nothing warranted | | | | |
| R5 planning warranted | | | | |

**Readings that would say "decision layer":** the decision *type* varies across R1–R5 in the direction the evidence supports; the controlled item is cited where it is the discriminating fact; R4 produces NO_ACTION or `no_new_work` with no context citation that does not bear on Yuwa; R3 asks rather than plans around an unknown exclusivity; R2 is action-shaped rather than plan-shaped; R5 still plans.

**Readings that would say "recommendation generator":** RECOMMEND · `specialized_plan` · `new_work` in R1–R4 regardless; overlay items uncited; R1 produces a second reactivation plan; R3 pitches other EdTech brands without asking; R4 re-sends outreach that was sent six days ago.

**Mixed readings** are the likely outcome and are the useful one: which conditions the Brain discriminates and which it does not tells us whether the failure is *reading existing work* (R1/R4 fail, R2/R3 pass), *reaching for the request vocabulary* (R3 fails), or *shape* (everything is a plan). That distinction is what decides the next change: a spec-level change to the decision question, a change to what existing work must carry, or a renderer change — decided after, not now.

**Within-run controls and repeatability:** the two non-target Objectives per run, and R0 against V3. A difference smaller than R0-vs-V3 variance is not read as a condition effect.

**The execution-shape question, revisited:** the reviewer annotates every RECOMMEND as before (direct action · larger plan/campaign · intelligence acquisition · unclear); NO_ACTION and REQUEST_INTELLIGENCE are recorded as themselves. Across R1–R5 the audit reports whether the observed outputs separate into something like NO_ACTION · REQUEST_INTELLIGENCE · DIRECT ACTION · LARGER PLAN, or whether one shape still absorbs the others. Names not frozen; no contract.

## 5. Recorded from Stage 1, carried as invariants and candidates (not rules, not tuned)

- **Interpretation refinement (Mia, 26 Sep):** because the real existing-work block did not intersect Mia's live portfolio, Stage 1 did **not demonstrate** portfolio awareness — but it was also **not a clean test** that the Brain would ignore overlapping existing work. 1B is the proper test of that hypothesis. In R1 and R4 the audit distinguishes *the Brain noticed existing work* (a citation) from *existing work changed the decision*; a citation alone is not discrimination.

- **Invariant — satisfying an information condition does not itself reactivate an Objective.** Targeted intelligence may establish that the condition is satisfied and may eventually justify an `information_available` signal; it does not decide that the Objective becomes active or that Mia wants the opportunity pursued. Two of Stage 1's four StartX1 framings ("enabling the reactivation", "moving it from deferred to active") lean against this; the invariant is written here so the Brain contract inherits it.
- **Reasoning-overreach candidate — a gap in the competition schedule is evidence of a schedule gap, not proof of availability or execution capacity.** Stage 1 V3 inferred an "operational window" from two schedule facts. One instance; no rule added.
- **Stage 1's StartX1 result is preserved as a positive signal:** deferred-for-information Objective + known connected source → REQUEST_INTELLIGENCE against the existing threads, without treating StartX1 as active, in four of four runs. The connected read is not performed.

## 6. Cost, calls, rules

Six calls at roughly Stage-1 size (≈ 12k input tokens each): **≈ $0.17**. No external research, no connected read of any thread, no event on any Objective, no table, no flag. The controlled overlay never reaches State; it exists only in the existing-work block of these six artifacts and is labelled controlled there. The spec digest is asserted identical to Stage 1 in every artifact. No tuning during or after; a prompt weakness exposed by a run is recorded and the run continues.

## 7. After 1B

The audit answers the discrimination question per condition and the execution-shape question, and proposes — does not make — the next change. Stage 2 of experiment 1 (the StartX1 connected read, then research as evidence-as-seen) waits behind that.

---

**Awaiting review on:** the six-run matrix (§3), in particular the five controlled overlays' wording; the two envelope additions (`activation`, `objectiveId`) as the only code change (§2); the readings in §4; and the ≈ $0.17 of calls, which are not made until approved.
