# Objectives — the contract, for review

**Owner:** Mia
**Date:** 2026-09-22
**Status:** Proposed. Nothing implemented. Supersedes the contract sketch in [`objectives-design.md`](objectives-design.md) §4 and §8.
**Four things changed under review**, each noted where it appears: the proposal/entity split, success semantics, grounded deadlines, and an honest account of what the validator cannot do.

---

## 1. The proposal/entity split — the M.I.A. lesson applied up front

**This is the change with the widest effect, and it is right.** An evaluator artifact and an operational entity are different jobs, and M.I.A. cost us a week by conflating them.

```
ObjectiveProposal    what the evaluator emits. Frozen, digest-pinned, immutable.
                     No lifecycle. No disposition. No adoption. No timestamps but its own.

Objective            the live entity. Lifecycle, athlete disposition, adoption, supersession.
                     References the proposal it came from — or has none at all.
```

An athlete-originated Objective **has no proposal**. Nothing evaluated it into being. That falls out of the split naturally, and is impossible to express if the two are one type.

It also keeps the frozen contract frozen: an athlete accepting an objective must never mutate an evaluator's artifact.

---

## 2. The three axes, and every combination

```ts
/** WHO created this, AT CREATION. Immutable. Nothing that happens later rewrites it. */
export type ObjectiveOrigin = "athlete" | "nomila" | "joint";

/** What the ATHLETE says about it. Changes over time; never touches origin. */
export type ObjectiveDisposition = "unreviewed" | "accepted" | "declined" | "deferred" | "modified";

/** Where it is in its life. */
export type ObjectiveLifecycle = "proposed" | "active" | "achieved" | "abandoned" | "superseded";
```

### `joint` means one thing

`joint` was carrying two meanings under review — *created from both Opportunity and athlete intent*, and *a Nomila proposal the athlete later reshaped*. Those are different, and the second rewrote origin on modification, which contradicted the contract's own immutability rule.

**Fixed: `origin` is creation-based only.** `joint` means both an Opportunity and a recorded athlete intent were inputs *when the objective was created*. An athlete reshaping a Nomila proposal is `disposition: modified` with `modifiedFrom` preserving the original — and origin stays `nomila`. If the reshaping is large enough to be a genuinely new, jointly authored outcome, the old objective is `superseded` and a new one is created with its own honest origin.

### Adoption does not live on the Objective

This goes one step past the review comment. The comment was right that `accepted` does not mean `recommended_and_followed`. But the existing ledger already places `adoption` on **`MeasuredOutcome`**, not on the entry — it is recorded when an outcome is *observed*, by whoever observes it, against the RECOMMENDATION ledger entry.

So the Objective entity carries **no `adoption` field at all.** Disposition is what the athlete said. Lifecycle is where it is. Adoption is what actually happened, determined at outcome time, and it lives where the ledger already put it. An athlete-originated objective has no RECOMMENDATION entry, so no outcome will ever carry adoption for it — which is the correct answer without needing `not_applicable`.

### Valid combinations

| case | origin | disposition | lifecycle | adoption (on a later outcome, if any) |
|---|---|---|---|---|
| athlete's own goal, being pursued | `athlete` | `accepted` | `active` | never recorded — no RECOMMENDATION entry exists |
| athlete's own goal, reached | `athlete` | `accepted` | `achieved` | never recorded |
| Nomila proposed, not yet seen | `nomila` | `unreviewed` | `proposed` | not yet observable |
| Nomila proposed, athlete agreed, in progress | `nomila` | `accepted` | `active` | **`unknown` until follow-through is observed** |
| Nomila proposed, athlete said no | `nomila` | `declined` | `proposed` | `recommended_and_not_followed`, once an outcome is observed |
| Nomila proposed, athlete reshaped it | **`nomila`** | `modified` | `active` | as observed |
| created from intent + opportunity together | `joint` | `accepted` | `active` | as observed |
| accepted, not started | `nomila` | `accepted` | `proposed` | not yet observable |
| abandoned after being active | any | `accepted` | `abandoned` | as observed |
| replaced by a better-formed one | any | as recorded | `superseded` | as observed |

**`declined` rests at `lifecycle: proposed`.** It was never active, so it did not end.

### Impossible combinations, rejected by validation

| | why |
|---|---|
| `nomila` + `unreviewed` + `active` | **the central invariant** — a proposal cannot become the athlete's goal by sitting unread |
| `declined` + `active` | a refused proposal is not pursued |
| `athlete` + `unreviewed` | the athlete's own goal arrives reviewed |
| `athlete` + `declined` | an athlete does not decline their own goal — they `abandon` it |
| `modified` without `modifiedFrom` | the original must survive |
| `origin` differing between any two versions of the same objective | origin is creation-based and immutable |
| any `adoption` field on the entity | adoption belongs to the observed outcome, per the ledger |

## 3. Statement vs outcome — preventing Opportunity paraphrase

An Objective must name a **changed future state**, not rename the opening. Four guards, three of them structural:

1. **`currentState` is required, is an `EvaluatedValue` owned by `objectives`, and must cite State.** An Objective declares what is true now and intends something different. `Objective: Grow X` has no current state to cite and fails immediately.

   The wrapper is there for epistemic honesty, not to solve entailment. **Citation resolution ≠ entailment** — PR2 proved an evaluator can cite a valid path in support of a sentence the path does not establish. Wrapping `currentState` as EVALUATED says plainly what it is: *the objective evaluator's reading of the state, citing these paths*. It is not a fact. Whether the reading is actually supported by what it cites remains an **eval-harness invariant**, checked in the diagnostic exactly as it was for Opportunity, and no brittle semantic validator is added to pretend otherwise.
2. **`success.observableCondition` is required.** A paraphrase cannot say how anyone would know it had been reached.
3. **`desiredState` and `currentState` must differ.** An objective restating the present is rejected.
4. **Lexical distinctness from its own sources** — `desiredState` may not be a near-restatement of any cited opportunity's statement. Normalised token overlap above a threshold is rejected.

Guard 4 is a **heuristic**, and I am marking it as one. It catches verbatim and near-verbatim copying, not clever paraphrase. It belongs in the validator because it is cheap and high-precision, not because it is sufficient.

---

## 4. Success semantics — the correction you asked for

**You were right and my design was wrong.** I required a numeric baseline for a success condition at all, which would make *"Establish an athlete-owned fashion venture"* unrepresentable. Observability and quantification are different things, and only the second needs evidence.

```ts
export interface ObjectiveSuccess {
  /**
   * ALWAYS PRESENT, NEVER NUMERIC BY REQUIREMENT. How a person would know the outcome had been reached.
   *
   * "A registered entity exists with product available for sale." "Inbound interest references her narrative
   * rather than only her sport." "A confirmed identity with no competing candidate."
   *
   * An objective with no observable condition is not an objective; it is a wish.
   */
  observableCondition: string;

  /**
   * OPTIONAL, AND EVIDENCE-BOUND. Only where a real metric exists in Nomila AND State holds a value to move from.
   *
   * The convention that objectives must be measurable is precisely how fabricated numbers enter. An objective
   * without this block is not a lesser objective — for most non-commercial outcomes it is the honest shape.
   */
  quantified?: {
    metric: string;
    /** Must resolve against the cited State. A metric that does not exist there cannot be a target. */
    statePath: string;
    /** READ FROM STATE, never asserted by the evaluator. No baseline, no quantification. */
    baseline: { value: number; asOf: string };
    direction: "increase" | "decrease" | "maintain";
    /** Optional even here. "Increase this" is legitimate; "increase this to 42,000" usually is not. */
    target?: QuantifiedTarget;
  };
}

/**
 * NOT a range by default. `{ low, high }` was frozen because it was convenient; inspecting what State can actually
 * ground says otherwise. The quantifiable metrics available today:
 *
 *   commercialPosition.closedDeals            a count      -> "at least N"
 *   commercialPosition.cashShare              a ratio      -> "at least 0.6"
 *   commercialPosition.demonstratedEconomics  a range      -> a floor on its high, or a range
 *   findings[x].basis.value                   0-100 score  -> "maintain", rarely a target at all
 *
 * Almost every honest strategic target is a floor. "Get between three and five deals" is odd; "at least three" is
 * what anyone means. `exact` is deliberately absent: an exact numeric target on a strategic objective is invented
 * precision by definition. Three kinds, no DSL.
 */
export type QuantifiedTarget =
  | { kind: "at_least"; value: number }
  | { kind: "at_most"; value: number }
  | { kind: "range"; low: number; high: number };
```

**A caution recorded, not enforced:** M.I.A. dimension scores are quantifiable and resolvable, so *"raise `narrative_power` to at least 90"* would pass every validator. It is also Goodhart's law in one line: targeting the evaluator's judgment rather than the world. Prefer operational metrics. An eval-harness concern, not a structural rule, because a rule forbidding it would be wrong the first time a score is the honest thing to maintain.

So `Establish an athlete-owned fashion venture` carries an `observableCondition` and no `quantified` block, and is fully valid. `Rebuild her audience` may carry both, because `followers_growth_pct` exists in State with a current value.

---

## 5. Horizon — you were right that I overcorrected, with one caveat

A blanket period enum makes real deadlines unrepresentable: graduation, a season start, a contract expiry, a launch date the athlete chose. Those are facts about the world, not evaluator inventions.

**The distinction is evaluator-selected versus externally grounded**, and it is enforced the same way `quantified` is — a deadline must cite where its date came from.

```ts
export type ObjectiveHorizon =
  /** The evaluator's own framing. Coarse on purpose: it cannot know a date, so it may not state one. */
  | { kind: "period"; period: "this_season" | "next_12_months" | "multi_year"; why: string }
  /**
   * A real date, grounded in something Nomila holds. `statePath` must resolve AND the value it resolves to must
   * contain this date. The evaluator cannot invent a deadline because it cannot invent the citation.
   */
  | { kind: "grounded_deadline"; date: string; statePath: string; why: string }
  /** Nothing makes this time-bound. The common and correct answer. */
  | null;
```

### The caveat, and it is load-bearing

**`AthleteState` exposes no citable date today.** Every date on it is an `asOf` — when we observed something — never a real-world date. I checked:

| date | exists upstream | exposed in State |
|---|---|---|
| `deals.term_start` / `term_end` | ✅ | ❌ |
| `athlete_affiliations.started_on` / `ended_on` | ✅ | ❌ — `constraintsFrom` projects `org_name` only |
| `athlete_facts.valid_from` / `valid_to` | ✅ | ❌ (facts extracted from State) |

So `grounded_deadline` is **correct in shape and unusable in practice** until State projects dates. Two honest options:

- **Ship `period` and `null` only in PR3a**, and add `grounded_deadline` when State carries a date. Nothing is lost; the type can gain a variant later.
- **Project dates into State first** — a small, well-scoped change to `constraintsFrom` and `commercialPosition`.

**Decision: the implemented type is `period | null`.** `grounded_deadline` is documented above as the intended extension and is **not** in the shipped union. Adding a variant the data cannot ground is how `commercial.ts` came to declare a `rationale` nobody populated — the exact failure this whole sequence started from. It is added the day State projects a date its validator can check, and not before.

---

## 6. Cardinality — all four cases

```ts
export interface ObjectiveProvenance {
  origin: ObjectiveOrigin;
  /** Opportunities this derives from. EMPTY IS VALID — an athlete-originated objective has none. */
  fromOpportunities: Array<{ opportunityKey: string; mapAsOf: string; how: string }>;
  /** The athlete's own stated intent, where one motivated this. Cites State like everything else. */
  fromAthleteIntent: Array<{ statePath: string; how: string }>;
  /** What is true now that this intends to change. NEVER EMPTY, whatever the origin. */
  currentStateEvidence: Array<{ statePath: string; how: string }>;
}
```

| case | `fromOpportunities` | `fromAthleteIntent` | `origin` |
|---|---|---|---|
| many opportunities → one objective | 2+ entries | `[]` | `nomila` |
| one opportunity → many objectives | the same key appears in each | `[]` | `nomila` |
| intent + opportunity together | 1+ | 1+ | **`joint`** |
| athlete intent alone | **`[]`** | 1+ | `athlete` |

**`origin` is derivable and therefore checkable**: `athlete` ⟺ opportunities empty and intent non-empty; `joint` ⟺ both non-empty; `nomila` ⟺ opportunities non-empty and intent empty. A validator rejects a mismatch rather than trusting the label.

**There is no 1:1 requirement anywhere**, and `currentStateEvidence` is required in all four cases — including the athlete-originated one, because *"I want to build a fashion business"* still needs Nomila to say what is true today that this would change.

---

## 7. Portfolio selection — what the evaluator may and may not use

Emitting 3 objectives from 13 opportunities **is** selection. Making the criteria explicit is what stops it being hidden scoring.

**Permitted, because each is available in the inputs:**

| criterion | grounded in |
|---|---|
| **outcome distinctness** | two opportunities pointing at one end-state consolidate — readable from the opportunities themselves |
| **strategic coherence** | opportunities that reinforce one another, visible in shared `restsOn` citations |
| **athlete intent** | a stated ambition makes an outcome objective-worthy — `preferences` in State |
| **evidence sufficiency** | an outcome nobody could tell had been reached cannot be an objective |
| **stance** | a refused activity may still be proposed, but the refusal is recorded — never silently dropped |

**Forbidden, because the evaluator cannot see them:**

> urgency ranking · expected value or ROI · the athlete's capacity or available time · sequencing or dependencies · what is already in flight · anything resembling a score

**And the deliverable is the declining.** Every opportunity that did not become an objective is accounted for in `notes` — consolidated into which objective, or not carried and why. An unexplained drop is a silent judgment, which is what we are trying to prevent.

No `rank`, no `priority`, no `score` field exists on the type.

---

## 8. Anti-prescription — what the type system does and does not solve

**Structural, and genuinely enforced:**

- No `steps`, `tasks`, `actions`, `channel`, `recipient`, `deliverable`, `cadence` or `budget` field exists. There is nowhere to put *"email five CSR directors"* as data.
- `horizon` is a period or a grounded date; never a deadline for a specific act.
- `success.observableCondition` describes a state, and `quantified.statePath` must resolve to a metric.

**Lexical, cheap and high-precision, low recall:**

A statement opening with an execution verb — `email · call · post · publish · send · draft · schedule · pitch · DM · launch · create` — is rejected. This catches the obvious leak at near-zero cost.

**What it does NOT catch, stated plainly:**

It would **not** have caught the one real instance we have. *"Implement strict load management and physical maintenance protocols"* opens with "implement", and while that verb could be added, the general form — an imperative dressed as an outcome — is not lexically distinguishable from a legitimate objective without semantic classification. Adding a broad classifier here would be brittle in exactly the way that produces false rejections on good output.

> **Anti-prescription is an evaluator and eval-harness invariant, not a type-system guarantee.** The contract removes the places prescription would naturally live and catches the crude cases. The eval corpus — where the LeBron instance is already recorded — is where recurrence is actually detected.

I would rather say that than imply the types solve it.

---

## 9. The complete contract

```ts
// ─── contracts/objective.ts ──────────────────────────────────────────────────

export const OBJECTIVE_PROPOSAL_VERSION = "objective-proposal/1.0.0";
export const OBJECTIVE_VERSION = "objective/1.0.0";

/** Creation-time only. Immutable. */
export type ObjectiveOrigin = "athlete" | "nomila" | "joint";
export type ObjectiveDisposition = "unreviewed" | "accepted" | "declined" | "deferred" | "modified";
export type ObjectiveLifecycle = "proposed" | "active" | "achieved" | "abandoned" | "superseded";

export interface StateCitation { statePath: string; how: string }

export interface ObjectiveProvenance {
  origin: ObjectiveOrigin;
  /** EMPTY IS VALID — an athlete-originated objective has none. */
  fromOpportunities: Array<{ opportunityKey: string; mapAsOf: string; how: string }>;
  fromAthleteIntent: StateCitation[];
  /** NEVER EMPTY, whatever the origin. */
  currentStateEvidence: StateCitation[];
}

export type QuantifiedTarget =
  | { kind: "at_least"; value: number }
  | { kind: "at_most"; value: number }
  | { kind: "range"; low: number; high: number };

export interface ObjectiveSuccess {
  /** Always present. Never numeric by requirement. */
  observableCondition: string;
  /** Optional and evidence-bound. */
  quantified?: {
    metric: string;
    statePath: string;                          // must resolve
    baseline: { value: number; asOf: string };  // read from State, never asserted
    direction: "increase" | "decrease" | "maintain";
    target?: QuantifiedTarget;
  };
}

/**
 * SHIPPED SHAPE. `grounded_deadline` is the documented extension (§5) and is deliberately NOT here: State exposes
 * no citable real-world date today, and a variant no valid input can produce is a contract lie.
 */
export type ObjectiveHorizon =
  | { kind: "period"; period: "this_season" | "next_12_months" | "multi_year"; why: string }
  | null;

/**
 * WHAT THE EVALUATOR EMITS. Frozen, digest-pinned, immutable.
 * No lifecycle, no disposition, no adoption, no timestamps but the set's own.
 */
export interface ObjectiveProposal {
  key: string;
  /** The OUTCOME, one sentence. Never a move. Owned by `objectives`, EVALUATED. */
  desiredState: EvaluatedValue<string>;
  /** What is true today that this intends to change. The evaluator's READING of the state — EVALUATED, owned by
   *  `objectives`, citing State. Not a fact. Resolution ≠ entailment; see §3. */
  currentState: EvaluatedValue<string>;
  domain: OpportunityDomain;
  provenance: Omit<ObjectiveProvenance, "origin"> & { origin: "nomila" | "joint" };
  success: ObjectiveSuccess;
  horizon: ObjectiveHorizon;
  /** Recorded, never used to drop the proposal. */
  athleteStance?: { stance: StatePreference["stance"]; subject: string };
  confidence: ConfidenceLevel;
}

export interface ObjectiveProposalSet {
  athleteId: string;
  asOf: string;
  version: typeof OBJECTIVE_PROPOSAL_VERSION;
  specVersion: string;
  stateAsOf: string;
  opportunityMapAsOf: string;
  proposals: ObjectiveProposal[];
  /** Every opportunity not carried, and why. The declining is the deliverable. */
  notes: Array<{ opportunityKey: string; outcome: "consolidated" | "not_carried"; into?: string; why: string }>;
  overallConfidence: ConfidenceLevel;
}

/**
 * THE LIVE ENTITY. Mutable only where stated.
 *
 * NO `adoption` FIELD. Adoption is what actually happened, and the ledger already records it on
 * `MeasuredOutcome` at observation time, against the RECOMMENDATION entry. Acceptance is disposition; it proves
 * nothing about follow-through, and deriving adoption from it would be the self-confirming loop ADOPTION exists to
 * prevent. An athlete-originated objective has no RECOMMENDATION entry and therefore no adoption, ever.
 *
 * NO `proposedAt`. An athlete-originated objective was never proposed. `createdAt` is semantically neutral;
 * proposal timing lives on the immutable ObjectiveProposalSet where one exists.
 */
export interface Objective {
  id: string;
  athleteId: string;
  version: typeof OBJECTIVE_VERSION;

  /** `EvaluatedValue` owned by `objectives` when Nomila proposed it. `MeasuredValue` owned by
   *  `athlete_intelligence` when the athlete stated it — Nomila must never become the author of the athlete's goal. */
  desiredState: EvaluatedValue<string> | MeasuredValue<string>;
  currentState: EvaluatedValue<string>;
  domain: OpportunityDomain;

  /** IMMUTABLE after creation. */
  provenance: ObjectiveProvenance;
  success: ObjectiveSuccess;
  horizon: ObjectiveHorizon;

  disposition: ObjectiveDisposition;
  lifecycle: ObjectiveLifecycle;

  /** Set when the athlete reshaped a proposal. The original survives verbatim. Origin does NOT change. */
  modifiedFrom?: { desiredState: string; at: string };
  /** The frozen artifact this came from. Absent for athlete-originated objectives. */
  fromProposal?: { key: string; setAsOf: string; specVersion: string };
  /** Where this was replaced by a new objective rather than modified in place. */
  supersededBy?: string;

  createdAt: string;
  reviewedAt?: string;
  activatedAt?: string;
  closedAt?: string;
}
```

---

## 10. Invariants the validator enforces

**Axis consistency**
1. `lifecycle: "active"` requires `disposition` ∈ {`accepted`, `modified`}.
2. `origin: "athlete"` ⟹ `disposition ∉ {unreviewed, declined}` and `fromProposal` absent.
3. `disposition: "declined"` ⟹ `lifecycle !== "active"`.
4. `disposition: "modified"` ⟹ `modifiedFrom` present.
5. `origin` is derivable from provenance and must match: `athlete` ⟺ no opportunities ∧ ≥1 intent; `joint` ⟺ both; `nomila` ⟺ ≥1 opportunity ∧ no intent.
6. **`origin`, `provenance` and `createdAt` are byte-identical across every version of an objective.** Disposition and lifecycle change; provenance never does.
7. No `adoption` field exists on `Objective` (compile-time). Adoption is read from `MeasuredOutcome`.

**Grounding**
8. Every `statePath` in `currentStateEvidence`, `fromAthleteIntent` and `success.quantified` resolves against the cited State.
9. Every `fromOpportunities[].opportunityKey` exists in the cited map; `mapAsOf` matches.
10. `currentStateEvidence` is never empty, whatever the origin.
11. `currentState.evidenceIds` equals the set of `currentStateEvidence[].statePath` — the wrapper cites what the provenance cites.

**Outcome, not opening**
12. `desiredState.value` ≠ `currentState.value`.
13. `desiredState` is not a near-restatement of any cited opportunity statement (token-overlap heuristic, §3).
14. `success.observableCondition` is always present and non-empty.

**Quantification is evidence-bound**
15. `quantified` requires a resolving `statePath` **and** a `baseline` whose value matches what State holds at that path.
16. `target` may not be set without `baseline`.
17. `target.kind === "range"` requires `low ≤ high`; `at_least` / `at_most` values are finite.
18. An objective with no `quantified` block is valid and is never penalised.

**Anti-prescription**
19. No `steps` / `tasks` / `actions` / `channel` / `recipient` / `deliverable` / `cadence` / `budget` field exists (compile-time).
20. `desiredState` does not open with an execution verb (lexical; **low recall by admission**, §8).
21. `horizon` is `period` or `null` in `objective/1.0.0`; a `grounded_deadline` is rejected until the variant ships.

**Anti-inflation**
22. No two objectives share a `desiredState` modulo whitespace and case.
23. Every opportunity in the cited map appears in `notes` or in some proposal's `fromOpportunities`.
24. Objective count is never asserted against opportunity count, in either direction.

**Anti-Mia**
25. No test asserts a specific objective for a specific athlete.

---

## 11. What changed under review

| | was | now | why |
|---|---|---|---|
| **proposal/entity** | one type | split | M.I.A. lesson |
| **success** | baseline required | `observableCondition` always; `quantified` optional, evidence-bound | observability ≠ quantification |
| **horizon** | `period \| grounded_deadline \| null` | **shipped as `period \| null`**; `grounded_deadline` documented, not shipped | State exposes no citable date |
| **`joint`** | also meant "modified later" | creation-time only; modification is disposition + `modifiedFrom` | origin is immutable |
| **`adoption`** | on the entity, derived from disposition | **removed from the entity** — lives on `MeasuredOutcome` per the ledger | acceptance ≠ follow-through |
| **`proposedAt`** | required on every objective | `createdAt`; proposal timing on the proposal set | athlete objectives were never proposed |
| **`currentState`** | bare string | `EvaluatedValue` owned by `objectives` | epistemic honesty; entailment stays an eval invariant |
| **`target`** | `{ low, high }` | `at_least \| at_most \| range`; no `exact` | floors are what anyone means; exact is invented precision |
| **anti-prescription** | implied structural | stated as an eval-harness invariant | it would not have caught the LeBron instance |
