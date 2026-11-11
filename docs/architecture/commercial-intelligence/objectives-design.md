# PR3 — Objectives: design

**Owner:** Mia
**Date:** 2026-09-22
**Status:** Design. Nothing implemented. The frozen Opportunity evaluator is untouched.
**Builds on:** `athlete-state/1.1.0` · `opportunity-map/1.0.0` · `opportunity-eval-spec/1.0.0` (`6bcf91ab…`)

---

## 1. Repo audit

Four existing concepts bear on this. **None of them is an Objective**, and no objective, priority or commercial plan table exists — so this is ADD, with no competing implementation to reconcile.

| what | where | bearing |
|---|---|---|
| **`RECOMMENDATION` + `ADOPTION`** | `contracts/intelligenceLedger.ts` | `RecommendationEntry { proposedAction }`, and `ADOPTION = recommended_and_followed \| recommended_and_not_followed \| not_recommended \| unknown`. Its stated purpose: *"the difference between a calibration dataset and a self-confirming loop… `not_recommended` is as important a value as `recommended_and_followed`."* |
| **`pending_actions`** | `shared/schema.ts` | A proposal and its disposition in one row: `status`, `approved_at`, `dismissed_at`, `executed_at`, `expires_at`. The ledger contract names it explicitly as a *"structural precedent to imitate rather than reinvent"*. |
| **`athletes.goal_archetype` · `secondary_goals`** | `shared/schema.ts`, written by `mila/onboarding.ts` | The athlete's stated goals, captured under the onboarding label **"want"**, projected into `athletes_current`. Athlete intent already has a home. |
| **`athlete_asserted`** | `shared/schema.ts` | One fact per row of what the athlete told us, with `said` (their words), supersession and retraction. Already projected into `AthleteState.preferences`. |

**Not relevant, despite the name:** `research_planner_runs` (research scheduling) and Studio's `Objective` (a creative campaign brief).

**`MeasurableEntry = Exclude<IntelligenceLedgerEntry, AssessmentEntry>`** — the ledger already decides that recommendations can be measured against outcomes and assessments cannot. An Objective is measurable; M.I.A. is not. That distinction is already typed.

---

## 2. Objective ≠ RECOMMENDATION — the test you asked for, and it fails

The tempting shortcut is `Objective = RecommendationEntry`. **It does not hold, and the reason is precise.**

`RECOMMENDATION` means *Nomila proposed an action to a decision-maker, and we record whether they followed it.* Its whole value is `ADOPTION` — measuring influence separately from accuracy.

Now take an **athlete-originated** Objective:

> *"I want to build a fashion business."*

Nomila recommended nothing. There is no adoption to record — `recommended_and_not_followed` is meaningless, and `not_recommended` is true but says nothing useful. Forcing it into `RecommendationEntry` would either fabricate an adoption value or make `proposedAction` a lie about who proposed it.

**So `RECOMMENDATION` is the right home for a Nomila-originated Objective and the wrong one for an athlete-originated Objective.** The shapes coincide for half the population, which is exactly the kind of near-fit that becomes a wrong abstraction.

### What this forces: three orthogonal axes

The error would be a single `status` enum mixing them. They vary independently.

| axis | question | values |
|---|---|---|
| **origin** | Who proposed this? | `athlete` · `nomila` · `joint` |
| **disposition** | What does the athlete say about it? | `unreviewed` · `accepted` · `declined` · `deferred` · `modified` |
| **lifecycle** | Where is it in its life? | `proposed` · `active` · `achieved` · `abandoned` · `superseded` |

The combinations that matter are the ones a single enum would lose:

- `origin: athlete`, `disposition: accepted` **at birth** — the athlete's own goal needs no approval; it arrived approved.
- `origin: nomila`, `disposition: unreviewed`, `lifecycle: proposed` — Nomila's idea, not yet the athlete's goal. **Never `active`.**
- `origin: nomila`, `disposition: declined` — recorded, not deleted. A declined proposal is evidence about the athlete's priorities and belongs in the record.
- `origin: nomila`, `disposition: modified` — the athlete reshaped it. Now `joint`, and the original text is preserved.

**Adoption is recorded only where origin is `nomila` or `joint`.** For an athlete-originated Objective the field is `not_applicable`, not `unknown` — we did not fail to observe it; there was nothing to observe.

---

## 3. Responsibility boundary

```
Athlete State   What is currently known and relevant?
Opportunity     What deserves strategic attention, and why?
Objective       What outcome do we intend or propose to pursue?
Plan / action   How do we pursue it?
```

**An Objective names an OUTCOME. It never names a move.** The discriminator has to be stronger than prose, because "Grow X" reads identically as an opportunity and an objective.

### Objective vs Opportunity

| | Opportunity | Objective |
|---|---|---|
| answers | there is an opening here, and here is why | we intend to reach this state |
| exists without the athlete | yes | **no** — an objective is intended by someone |
| count | as many as the evidence supports | as few as the athlete can actually pursue |
| carries | impact, feasibility, urgency | a desired end-state and how we would know |
| tense | descriptive | **committal** |

**The structural discriminator:** an Objective must state a **desired end-state that differs from the current state**, and must cite the State evidence establishing the current state. An opportunity rewritten as `Objective: Grow X` fails this immediately — it has no end-state and no current-state citation, only a verb.

That is checkable, not a matter of taste.

### Objective vs action

Three structural guards, no prose required:

1. **No verb-object payload.** The contract has no `steps`, `tasks`, `channel`, `recipient` or `deliverable` field. There is nowhere to put "email five CSR directors".
2. **An Objective may not name a counterparty, a quantity of deliverables, or a date of execution.** Its `targetHorizon` is a period, never a deadline for a specific act.
3. **An Objective must survive its own plan changing.** If replacing the approach invalidates the Objective, it was an action. *"Increase the strategic value and visibility of Mia's impact platform"* survives; *"publish three Yuwa posts"* does not.

Guard 3 is the strongest and is testable by inspection.

---

## 4. The Objective contract

```ts
export const OBJECTIVE_VERSION = "objective/1.0.0";

export type ObjectiveOrigin = "athlete" | "nomila" | "joint";
export type ObjectiveDisposition = "unreviewed" | "accepted" | "declined" | "deferred" | "modified";
export type ObjectiveLifecycle = "proposed" | "active" | "achieved" | "abandoned" | "superseded";

/** Where an Objective came from. Origin is not disposition and neither is lifecycle. */
export interface ObjectiveProvenance {
  origin: ObjectiveOrigin;
  /** Opportunities this was derived from. Empty for a purely athlete-originated objective — and that is valid. */
  fromOpportunities: Array<{ key: string; mapAsOf: string; how: string }>;
  /** The athlete's own stated intent, where one motivated this. Cites AthleteState, like everything else. */
  fromAthleteIntent?: Array<{ statePath: string; how: string }>;
  /** The state evidence establishing the CURRENT state this objective proposes to change. Never empty. */
  currentStateEvidence: Array<{ statePath: string; how: string }>;
  /** Only where origin is nomila or joint. Athlete-originated objectives carry `not_applicable`. */
  adoption?: Adoption | "not_applicable";
}

export interface ObjectiveOutcome {
  /** The end-state, as a state of the world rather than an activity. */
  desiredState: string;
  /**
   * How we would know. MUST be observable and MUST NOT be invented.
   * `measurable` where a real metric already exists in Nomila; `observable` where a human can tell but no
   * metric does; `not_yet_determinable` where neither is true today — which is an honest and common answer.
   */
  knownBy: | { kind: "measurable"; metric: string; statePath: string; direction: "increase" | "decrease" | "maintain"; target?: { low: number; high: number } }
           | { kind: "observable"; condition: string }
           | { kind: "not_yet_determinable"; whyNot: string };
  /** A period, never a deadline for a specific act. Null where nothing makes it time-bound. */
  horizon: { period: "this_season" | "next_12_months" | "multi_year"; why: string } | null;
}

export interface Objective {
  key: string;
  /** One sentence naming the OUTCOME. Never a move. */
  statement: EvaluatedValue<string> | AthleteAssertedValue<string>;
  domain: OpportunityDomain;            // reuse — the same ten, whole-enterprise
  provenance: ObjectiveProvenance;
  outcome: ObjectiveOutcome;
  disposition: ObjectiveDisposition;
  lifecycle: ObjectiveLifecycle;
  /** Set when the athlete reshaped a Nomila proposal. The original survives. */
  modifiedFrom?: { statement: string; at: string };
  confidence: ConfidenceLevel;
  asOf: string;
}
```

**Note the `statement` union.** A Nomila-originated statement is `EvaluatedValue` owned by `objectives`. An athlete-originated statement is **the athlete's assertion, not our judgment** — it keeps `athlete_intelligence` as owner and is not EVALUATED at all. Collapsing those would make Nomila the author of the athlete's own goal, which is the precise failure this layer must not have.

---

## 5. Athlete disposition and approval

**Nomila recommends; the athlete decides.** Structurally, not by convention:

- A `nomila`-originated Objective is born `disposition: unreviewed`, `lifecycle: proposed`.
- **`lifecycle: active` requires `disposition: accepted` or `modified`.** An invariant, not a workflow nicety: a Nomila proposal cannot become the athlete's goal by sitting unread.
- An `athlete`-originated Objective is born `accepted` and may be `active` immediately. It was never a proposal.
- `declined` is **recorded, never deleted**. Same reasoning as `ADOPTION`'s `not_recommended`: a system that keeps only its accepted proposals is measuring its own influence and calling it insight.

`pending_actions` is the precedent for the disposition timestamps (`approved_at`, `dismissed_at`, `expires_at`) and should be imitated rather than re-derived — but an Objective is **not** a pending action: it has no executor, no payload, and nothing happens on approval.

---

## 6. Cardinality — and why 13 opportunities must not make 13 objectives

**Many-to-many, deliberately.**

**Many opportunities → one objective.** Mia's `AMPLIFY/positioning` and `AMPLIFY/impact` both rest on the same three findings and both concern activating her narrative commercially. One objective — *"establish her narrative as a commercially legible asset"* — subsumes both without losing either, because both remain cited in `fromOpportunities`.

**One opportunity → many objectives.** LeBron's `FIX/commercial` (Nomila's records contradict his real partnerships) supports both *"Nomila's view of his commercial position is accurate"* and *"his portfolio is managed against conflicts"* — different outcomes, same opening.

**The count is broken by construction, not by a rule.** Opportunities are indexed by evidence; objectives are indexed by **intended outcomes**, and an athlete has far fewer of those. Three separate forces keep the number down:

1. **Consolidation is structural** — `fromOpportunities` is an array, so merging loses nothing.
2. **Every objective needs a distinct end-state.** Two objectives whose `desiredState` differ only in wording are one objective, and that is inspectable.
3. **Every objective needs an athlete disposition.** The cost of proposing is that someone must respond to it, which is a real and healthy brake.

**No numeric cap.** "Select ~3" would replace *"force 13 rates"* with *"force 3 objectives"*, which is the mistake this whole sequence has been unwinding.

---

## 7. Prioritisation — and your sharpest question

> *"If Objectives receives 13 Opportunities and emits 3 proposed Objectives, the system has performed portfolio selection, even if it never assigns ranks or scores."*

**Correct, and it does.** Selection cannot be avoided: emitting fewer objectives than opportunities *is* selection, and emitting one per opportunity is also a selection decision (a bad one).

**The right conclusion is not a new layer.** It is that **selection and ranking are different things**, and only one of them belongs here.

| | belongs to Objectives | belongs elsewhere |
|---|---|---|
| **Selection** — which outcomes are worth intending at all | ✅ unavoidable and appropriate | |
| **Ordering** — which to do first | | Plan / sequencing, where capacity, season and dependencies are known |
| **Resource allocation** — how much to spend on each | | Plan |

Objectives selects because it must; it does not order, because **ordering requires information Objectives does not have** — the athlete's time, the season calendar, what is already in flight. An ordering asserted without those is invented precision, exactly like a fabricated numeric target.

**Recommendation: Objectives selects and explains its selection. It does not rank, score or sequence.** The contract has no `rank` and no `priority` field, and `notes` records **why something was not made an objective** — the declining, which is the deliverable.

A separate portfolio layer is **not** justified yet. Revisit if and only if two objectives are observed to genuinely contend for the same capacity, which needs the Plan layer to exist first.

---

## 8. Success and measurement — how invented targets are prevented

The convention that objectives must be measurable is precisely how fabricated numbers enter, and we have watched that happen once already with Rate.

**Three kinds, and the contract makes the honest one easy:**

- **`measurable`** — a real metric that **already exists in Nomila**, cited by `statePath`. `followers_growth_pct`, `closedDeals`, `demonstratedEconomics`. `direction` is required; `target` is **optional**, because "increase this" is a legitimate objective and "increase this to 42,000 by March" is usually fiction.
- **`observable`** — a human can tell, no metric exists. *"She is publicly associated with the Yuwa work."*
- **`not_yet_determinable`** — neither, with `whyNot` stated. **A valid and expected answer.**

**Two invariants:**

1. **A `measurable` outcome must cite a `statePath` that resolves** — the same grounding discipline as Opportunity. A metric that does not exist in State cannot be a target.
2. **A `target` range may only be set where State contains a current value to move from.** No baseline, no target. This is what makes *"grow her audience to 50,000"* impossible for an athlete whose audience we cannot measure — which was the Run 1 failure shape in a new costume.

---

## 9. Whole-enterprise coverage

Reuse `OPPORTUNITY_DOMAINS` unchanged — `audience · content · positioning · athletic · commercial · relationships · owned_venture · impact · career · evidence`. A second vocabulary would drift from the first within one version.

**`evidence` remains a legitimate objective domain.** *"Nomila can see her audience"* is a real intended outcome, and for a thin athlete it may be the only honest one.

---

## 10. Illustrations — examples only, not expected outputs

**These are written by hand to show the shape. They are NOT predictions of what the evaluator should produce, and no test may assert them.**

**Mia — consolidating two opportunities**
`origin: nomila` · `disposition: unreviewed` · `lifecycle: proposed` · domain `positioning`
*desiredState:* her narrative is a commercially legible asset that partners approach her for
*from:* `amplify-stanford-scholar-athlete`, `amplify-yuwa-impact`
*currentStateEvidence:* `findings[mia.narrative_power]` (strength, under-activated), `commercialPosition.activeRelationships` (one)
*knownBy:* `observable` — inbound interest references her narrative rather than only her sport
*horizon:* `next_12_months`

**Mia — athlete-originated, hypothetically**
`origin: athlete` · `disposition: accepted` **at birth** · `adoption: not_applicable`
*statement:* owned by `athlete_intelligence`, not EVALUATED
*from:* `preferences[...]` only — **no opportunity required**

**Riya — the honest one**
`origin: nomila` · domain `evidence`
*desiredState:* Nomila knows which athlete Riya Mehta is
*from:* `resolve-identity-ambiguity`
*knownBy:* `observable` — a confirmed identity with no competing candidate
*horizon:* `null` — nothing makes it time-bound

**LeBron — one opportunity, two objectives**
`FIX/commercial` supports *"Nomila's view of his commercial position is accurate"* (domain `evidence`) **and** *"his portfolio is actively managed against category conflicts"* (domain `commercial`). Different outcomes, one opening.

---

## 11. PR3 sequence

**3a — contract + lifecycle.** Types, the three axes, invariants as pure functions (`canActivate`, `requiresAdoption`, `isOutcomeNotAction`). No evaluator, no persistence. Testable without a database.

**3b — the evaluator.** Frozen prompt, digest pin, parity tests, structural + grounding validation against **both** the Opportunity map and Athlete State. Same apparatus as M.I.A., Rate and Opportunity. Provider call outside `server/services/intelligence/` — the boundary rule I broke once already.

**3c — athlete-intent path.** Objectives from `goal_archetype`, `secondary_goals` and `athlete_asserted` **without** an evaluator. Deterministic, like PR1. Proves the athlete-originated path does not depend on Nomila having an opinion.

**3d — persistence.** Ledger `RECOMMENDATION` entries for `nomila`-originated objectives; decide then whether athlete-originated objectives belong in the ledger at all, given they are not judgments.

**3e — the run.** Same frozen four, same discipline, same diagnostic.

---

## 12. Invariants the tests must enforce

**Structural**
1. `lifecycle: "active"` requires `disposition` ∈ {`accepted`, `modified`}.
2. `origin: "athlete"` ⟹ `adoption === "not_applicable"`.
3. `origin: "nomila"` ⟹ `adoption !== "not_applicable"`.
4. `currentStateEvidence` is never empty, and every `statePath` resolves against the cited State.
5. `fromOpportunities[].key` exists in the cited map; the map's `stateAsOf` matches the State.
6. An athlete-originated `statement` is **not** `EVALUATED` and is **not** owned by `objectives`.

**Anti-prescription**
7. No `steps`, `tasks`, `channel`, `recipient` or `deliverable` field exists on the type.
8. `horizon.period` is an enum, never a date.
9. A `desiredState` must differ from the cited current state — an objective that restates the present is rejected.

**Anti-invention**
10. `knownBy.kind === "measurable"` ⟹ `statePath` resolves **and** State holds a current value.
11. `target` may not be set without a resolving baseline.
12. `not_yet_determinable` is always valid and never penalised.

**Anti-inflation**
13. Two objectives may not share a `desiredState` modulo whitespace.
14. Objective count is **never** asserted against opportunity count, in either direction.

**Anti-Mia**
15. No test asserts a specific objective for a specific athlete. Shape, provenance and refusal only — the discipline that has held for three layers.
