# Campaign slice design (#570) — Amendment 1

**Status:** APPLIED to `docs/campaign-slice-design` on 27 September 2026 (commit `94579d0f`) — amended #570 is the Campaign control. Kept as the record of the deltas · stacked with the R17 ceremony (`brain-eval-spec/0.11.0-exp`, `recommendation/0.2.0-exp`, `execution-router/0.2.0-exp`)
**Scope:** exactly the three corrections established by #649/#650 and accepted on 27 September 2026. No other redesign. Nothing here changes the Campaign definition (§1), the doors, the lifecycle, the deal-door mechanics, `DeliverableIntent`, or any status name.
**Why a record and not an edit:** #570 is the Campaign control and lives on its own branch (`docs/campaign-slice-design`). This file states each amendment as an exact delta against the branch text so the control can be edited in one reviewed commit; the design in this stack treats these three deltas as adopted.

---

## Amendment 1 — the origin carries the typed end reference (R17)

**Where:** §4.1 `CampaignOrigin`, the `period` field:

> `/** The reason to end. At least one of endsOn / endsWith must be present. */`
> `period: { startsOn: string | null; endsOn: string | null; endsWith: "deal_term" | "objective_horizon" | "athlete_stated" | null };`

**Replace with:**

```ts
/**
 * The reason to end, as a RESOLVED fact with its source. `endsWith` names the kind of authoritative object that ends the
 * campaign and `endsRef` the object itself (an Objective with a bounded horizon, a deal with a recorded term end, a finish
 * the athlete has stated on record). `endsOn` is present when that object yields a date. Never recovered from prose: a
 * recommendation-door origin receives it resolved from the Recommendation's typed `ends` reference; the deal door
 * resolves it from the contract; the athlete door from her assertion. An origin without a resolvable `endsRef` is refused.
 */
period: { startsOn: string | null; endsOn: string | null; endsWith: "deal_term" | "objective_horizon" | "athlete_stated"; endsRef: string };
```

**Consequences inside #570 (wording only):** invariant 2 ("A `CampaignOrigin` without a reason to end (`period.endsOn` or `endsWith`) is refused") reads "without a resolvable `endsRef`". Row A6 ("The reason to end is one of three kinds … add `recommendation_condition` when the Brain can state one"): the third column becomes "not admitted — a condition the Brain authors has no owner outside the campaign; it is admitted only when an authoritative object represents it, at which point it is one of the three kinds by reference".

**Source of the semantic:** `brain-eval-spec/0.11.0-exp` — a campaign-shaped RECOMMEND carries `ends: { source: objective_horizon | deal_term | athlete_stated, ref }`; the Brain names the source and never the date; the execution router resolves the reference and refuses when the object carries no end.

## Amendment 2 — deliverables optional at origin

**Where:** §4.1 `CampaignOrigin`:

> `/** What is owed. May be empty for the athlete door. */`
> `deliverables: DeliverableIntent[];`

**Replace with:**

```ts
/**
 * What is owed, when known at origin. Empty for the athlete door and for the recommendation door: an accepted strategic
 * Recommendation carries no deliverables (they are the planner's and the spec's, never the Brain's), so a campaign is
 * created from it before its deliverables exist. Deliverables enter at `planning` through the CampaignSpec (and, beneath
 * `content`, through Creative Intelligence). The deal door fills them from the contract as before.
 */
deliverables: DeliverableIntent[];
```

**Consequences inside #570:** §7 row `planning → active` ("first deliverable enters work … or `period.startsOn` passes") is unchanged; it already tolerates a `planning` state with no deliverables. The **Scope** paragraph ("Scope is the deliverable list of the current spec version") is unchanged: scope is a spec property, not an origin property. Evidence: #649 Case 3 produced an accepted campaign Recommendation whose origin proposal carried zero deliverables; #570's own table row "Run a match-day series all season → campaign … one brief per match day" shows them arriving after planning.

## Amendment 3 — three-act approval

**Where (a):** §3 doors table, the **Recommendation** row, last column:

> `the athlete, by accepting the Recommendation (\`athlete\`)`

**Replace with:** `three acts, none implied by another — (1) the athlete accepts the Recommendation (the strategic move; governs the Recommendation only); (2) the athlete approves the CampaignSpec (the activation being proposed: scope, period, constraints) — \`planning → approved\`; (3) each consequential action (publish, spend, send) is authorized at its own execution boundary (Studio's gates, tap-to-send). No single flag stands for all three.`

**Where (b):** the assumptions table, row A3:

> `| A3 | Accepting the Recommendation is what approves a recommendation-door campaign (\`approval: "athlete"\`) | … |`

**Replace with:** `| A3 | Accepting the Recommendation governs the Recommendation and nothing else; the campaign is approved by the athlete on its CampaignSpec, and execution is authorized per action at the execution boundary | an athlete who accepts a move and then declines the activation proposed for it must leave the Recommendation accepted and the campaign at \`planning\` (or \`ended · cancelled\`) — the states already exist | none: \`idea\` → \`planning\` on Recommendation acceptance + preparation authorization, \`planning\` → \`approved\` on spec approval; \`approval: "brand"\` remains a later rule |`

**Where (c):** §7, "`idea` and `approved` exist in the enum for the Recommendation door (a proposed campaign before acceptance) and are unused by the deal door in v1."

**Replace with:** "`idea` is the recommendation door's origin state (a proposal the athlete has not yet accepted the move for); `planning` follows Recommendation acceptance **and** preparation authorization (two acts on the Recommendation, `respond` and `authorizePrepare`); `approved` follows the athlete's approval of the CampaignSpec. Neither `idea` nor `approved` is used by the deal door in v1."

**Consequences:** the "Still open: `idea` / `approved` in the status enum now, or when the Recommendation door is built" note resolves to "now, as above". Invariant preserved from #648/#649/#650: **Recommendation acceptance ≠ execution authorization.**

---

## Not amended, deliberately

The Campaign definition and its operational edge (§1), the deal door and `deal_deliverables` mechanics, `DeliverableIntent`, the outcome reading, the H1 hypothesis on deal periods, and every status name. The `brandIds` / `participantAthleteIds` columns are untouched. The recommendation-door seam row still says "the Brain must satisfy this contract when it exists" — after R17 it does, at the shape level: purpose (`what`), Objective ids, typed `ends`, evidence refs, constraints from `notSeen`, no deliverables.
