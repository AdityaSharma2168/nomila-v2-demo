# Recommendation → PlannerHandoff → Specialized Planner → typed domain work — checkpoint

**Status:** design/evidence checkpoint for review · stacked on #650 · branch `feat/brain-0.11.0-exp-r17-ends`
**Provider calls:** 0. **Changed:** Brain spec, Recommendation contract and router by the R17 ceremony (§1); everything else here is design. No persistence, no planner, no Campaign, no Creative Intelligence, no Studio, Deals, Rate, Objective or Opportunity change. #570 not edited; its three corrections are recorded as an amendment (§4).

Deliverables 1–4 (R17 and #570) are §1–§4. Deliverables 5–15 (the seam) are §5–§15.

---

## 1. R17 ceremony result (deliverable 1)

`brain-eval-spec/0.11.0-exp`, digest `13c38cf1b3799b58abac319c40f35d839f18729a961a784d49d0bd33c0159115` (0.10.0 `b39cd28b…` preserved). Amend → bump → unpin → parity → exact-text review → repin. Brain suites 51 + orchestrator 48 + Opportunity 158 + Objective/seam 33, all green.

**What changed in the prose (verbatim delta, the campaign line):**

> − …state in `what` what the activation is for and in `why` what ends it. Several tasks do not make a campaign; a campaign with nothing to end it will be refused
> + …state in `what` what the activation is for and carry in `ends` the reference to what ends it — the Objective whose horizon ends it, the deal whose term ends it, or her own stated finish as rendered. You name the source; you do not invent the date, and a condition of your own ("until engagement improves") is nobody's to end and is not a source. Several tasks do not make a campaign; a campaign with nothing to end it will be refused, and `ends` on any other path is refused

**Historical artifacts, preserved under their versions:** regate of C23 and R15 under 0.11.0 gates shows exactly one new structural problem each — `decisions[3]: campaign without ends` — and nothing on any direct_action or specialized_plan decision (C4, N: `0→0`). The R15 ledger re-routed under the new router refuses the historical campaign record: "campaign without a typed reason to end (`ends`) — refused, not downgraded". Both are the intended consequence: a campaign judged before R17 has no typed end and cannot pass the boundary until judged again.

## 2. Exact Recommendation schema delta (deliverable 2)

Smallest possible; nothing broadened; Direct Action and Specialized Plan unchanged.

| Layer | Delta |
|---|---|
| `contract.ts` | `CAMPAIGN_END_SOURCES = ["objective_horizon", "deal_term", "athlete_stated"]`; `CampaignEnd { source, ref }`; `BrainDecision.ends?: CampaignEnd \| null` (RECOMMEND with `execution_path = campaign` only) |
| Output schema (spec text + provider response schema) | `"ends": { "source": …, "ref": <reference exactly as shown> } — RECOMMEND with execution_path campaign only; omit otherwise`. In the response schema `ends` is a nullable object with the three-value enum, **not** schema-required (the structural gate decides) |
| Structural gate (`validateDecision`) | campaign without `ends` → refused; `ends.source` outside the three → refused; `ends.ref` empty → refused; `ends` present on any non-campaign path, on NO_ACTION, on REQUEST_INTELLIGENCE, or on a deferred entry → refused |
| Grounding | `ends.ref` must resolve like any reference, and match its source's kind: `objective_horizon → objective[…]`; `deal_term → deal[…]` rendered in EXISTING WORK; `athlete_stated` → a state path, never an Objective, deal or evidence item |
| `recommendation/0.2.0-exp` | `RecommendationValue.ends: CampaignEnd \| null`; parsed from the run body; records written before 0.2.0 read as `null` |
| `execution-router/0.2.0-exp` | `resolveEnd(ends, sources)` replaces the prose reader (retired, not kept); `CampaignOriginProposal.period` gains `endsRef` and `endsWith` is no longer nullable; `route()` refuses `ends` on a non-campaign shape |

Not changed: `recommendationKey` (a campaign's identity is still decision + shape + advances; the end is a property, not identity), `FORBIDDEN_DECISION_FIELDS`, `WorkItem`, `ExecutionIntent`, `PlannerHandoff`.

## 3. Router behaviour with the typed end reference (deliverable 3)

Order unchanged: governance → dedup → shape → handoff. For a campaign-shaped record the shape step is now:

1. **receive** `value.ends` (typed; absent on pre-0.2.0 records → step 4);
2. **resolve** `ends.ref` against the authoritative object: `objective_horizon` → a live Objective in the run's inputs; `deal_term` → a `deal[…]` item in the Existing Work view; `athlete_stated` → a finish on the athlete's record (`assertions` in the router context — none exist in the harness yet, so today this path refuses honestly);
3. **confirm** the object carries a usable end: the Objective's `horizon` is bounded (not open); the deal has a recorded `termEnd`; the assertion exists;
4. **refuse** otherwise, with the specific reason ("whose horizon is open", "no recorded term end", "not a finish she has stated on record", "not a live Objective", "not rendered in EXISTING WORK") — never downgrade, never substitute;
5. **pass** `period { endsWith, endsRef, endsOn (from the deal's term or the assertion; null for a period horizon), startsOn (the deal's term start, else null) }` into `CampaignOriginProposal`.

`what` and `why` are read for nothing at this boundary. Purpose is checked for existence only. Tested: prose alone refused; open horizon refused; bounded Objective horizon → proposal; deal term → dates; assertion present/absent; `ends` on a plan refused.

## 4. #570 narrow amendment (deliverable 4)

Recorded as `campaign-slice-design-amendment-1.md` with exact replacement text for each site, because #570 is the control and lives on its own branch: (1) `CampaignOrigin.period` carries `endsWith` + `endsRef` (+ `endsOn` when the source yields a date), never recovered from prose; A6's `recommendation_condition` not admitted; (2) `deliverables` optional at origin, entering at `planning` through the CampaignSpec; (3) three-act approval replacing "accepting the Recommendation approves the campaign" at the doors table, row A3 and the `idea`/`approved` note, with no universal approval flag. Nothing else in #570 touched.

---

## 5. Specialized Planner input contract (deliverable 5)

**Core question:** what must every specialized planner receive from a Recommendation to plan without the Brain re-specifying execution?

Start from the existing `PlannerHandoff` (`execution-router/0.2.0-exp`):

```
{ version, shape: "specialized_plan", recommendationId, domain, what, why, subject, objectiveIds, advances, intent, notSeen, runId }
```

Pressure-tested field by field against the four plan-shaped Recommendations routed in #649/#650 (Yuwa ×2, academic/tech ×2) and the ~80 plan-shaped judgments of the #647 corpus:

| Field | Needed? | Why |
|---|---|---|
| `recommendationId` | **yes** | the only lineage key; every planner output points back to it |
| `subject` | **yes** | what the move is about (`objective[…]`, `deal[…]`, `brand[…]`) — the planner's anchor for Existing Work and for domain-native objects |
| `objectiveIds` | **yes** | the success condition and horizon live on the Objective; the planner reads them by reference, it does not receive a copy |
| `what` (strategic move) | **yes** | the move itself. After R15 it names subject + direction + counterpart and no artefact; see §8 for the standing rule when a noun still slips through |
| `why` (strategic rationale) | **yes** | the reason the move is worth it now; the planner uses it to choose *between* mechanics, not to re-derive strategy |
| `domain` | **yes** | selects the planner (§9); derived by the router from the Objective's domain or the subject's kind, never guessed |
| `runId` (evidence by reference) | **yes** | the run artifact holds the state block, the map, the context and the cites; the planner reads there. **No evidence is copied.** |
| `notSeen` → **constraints** | **yes, renamed in meaning** | what the Brain could not see and judged anyway is exactly what a planner must either obtain or plan around; it is the Recommendation's only constraint-like content. Carried verbatim with `source: "recommendation"`, as the campaign proposal already does |
| `advances` | **yes when present** | a plan that advances an in-motion item must attach to it, not start beside it (Existing Work, §13) |
| `intent` | **carry, rarely used** | non-null only on a deal subject; a plan-shaped deal move (rare in the corpus) needs it for the commercial planner |

**Verdict: the existing handoff is the contract.** Nothing must be added for a planner to start; two things must be *named* that the object already carries implicitly: `notSeen` is the constraints channel, and `runId` is the evidence channel. A planner that needs more than this is asking the Brain to specify execution, which is the boundary R13/R15 closed.

## 6. Which PlannerHandoff fields survive (deliverable 6)

All eleven survive unchanged. No field is dropped; none is added. The one rename is semantic, not structural: `notSeen` is read by planners as *constraints from the Recommendation*. If a later version wants the name to say so, that is a router ceremony (`constraints: [{text, source: "recommendation"}]` mirroring `CampaignOriginProposal`), not a Brain change.

## 7. Missing input semantics (deliverable 7)

Three were tested and none is required from the Brain:

- **Athlete constraints** (time, travel, what she will not do): needed by every planner, **not the Brain's to carry** — they are on her record (State: preferences, career status, affiliations, calendar when it exists). The planner reads them by reference via the run's state block or the record. The R15 run showed the Brain reaching for them in `notSeen` ("content creation and editing support available during travel matches"); that is a planner fact leaking upward, and confirms the planner must read them itself.
- **Priority among several Recommendations**: `rank`/`priority` are forbidden fields by design; ordering across moves is the athlete's (Objective acceptance) and later the Campaign's, not the planner's input.
- **A deadline**: the Objective's horizon is the only legitimate one and is on the Objective. A plan-shaped move has no end of its own (that is what makes it not a campaign, §12).

One genuinely open semantic, **not a Brain input**: the planner's own *completion condition* (§10). It is the planner's to declare, and Existing Work needs it (§13).

## 8. The planner-owned HOW boundary (deliverable 8)

Standing rule, recorded from #650's acceptance as the **planner-boundary watch item**:

> The Brain may name the strategic move. The planner owns execution targeting, sequencing, channels, target lists, artefacts, cadence, intermediate actions, dependencies, resourcing and completion conditions for its work — unless one of those is itself the subject of the Decision. A noun in `what` that names an artefact or mechanic is **non-binding on the planner** (R15 closed the leak on the plan shape; the residual "initiate outreach to CSR departments" is the counterpart, not a mechanic; a planner that reads it as "must do outreach" has misread the seam).

What the Brain still legitimately fixes: the subject, the direction, the counterpart lane ("CSR departments of global brands", "EdTech/STEM/tech VC"), the Objective. What it never fixes: which brands, in what order, with what materials, on what channel, how often, by when within the horizon.

## 9. Specialized planner domains (deliverable 9)

The router's `PlannerDomain` today: `content | outreach | relationships | athletic | impact | career | commercial | owned_venture | positioning`, derived from the Objective domain (`audience → content`, `positioning → outreach`, others 1:1) or the subject (`deal`/`brand → commercial`). Tested against what the corpus actually asked for and what execution capability exists:

| Planner domain | Corpus share (#647) | Planning behaviour | Native downstream objects today | Shares the handoff? | Distinct semantics? |
|---|---|---|---|---|---|
| **content / audience** | ~30 of 100 | choose formats, channels, cadence, references; produce briefs | `studio_plans` (a versioned plan with items, brief, objective, `deal_deliverable_id`), Studio briefs, jobs, `media_assets` | yes | **yes** — the only domain with a native plan object and a creative pipeline beneath it; Creative Intelligence sits under it |
| **outreach / positioning** | ~50 | choose targets, materials, sequencing, follow-up; escalate to commercial when a counterpart replies | none (no planner, no executor, no target-list object) | yes | **yes** — target selection and a message sequence with an external counterpart; no `pending_actions` kind for it |
| **commercial** | (19 direct; plan-shaped rare) | structure a negotiation or a package across deals; mostly direct_action territory | Deals (drafts, `pending_actions.send_reply`, payments) | yes | **yes** — amounts, floors, terms; the only domain where money is executed |
| **impact** | (with outreach in the corpus) | partnerships and activations around her cause; in practice outreach with an impact counterpart | none | yes | **no distinct planner logic found** — the Yuwa move routed as `impact` plans exactly like outreach; treat as outreach with an impact lane until a case shows otherwise |
| **relationships** | 0 | nurture existing brand/partner relationships | brand relationships (deferred workstream) | yes | shares outreach's mechanics; no planner until brand-relationship work exists |
| **career, athletic, owned_venture** | 0 | none observed | none | yes | **undetermined** — no Recommendation has reached them; do not design planners on zero cases |

**Conclusion:** one shared handoff, at most three distinct planner semantics today (content, outreach, commercial), and *none* of the three is generic. Domains with zero cases get no planner and no assumption. The router's mapping stays as is; `impact` continues to route to an impact domain so a later case can prove it distinct.

## 10. Proposed planner output semantics (deliverable 10)

Not chosen in advance; four candidates tested against the two planners that have any downstream substance:

| Candidate | Content planner | Outreach planner | Verdict |
|---|---|---|---|
| a. typed bundle of domain actions | briefs are already typed actions; a bundle without a parent loses the plan's reasons and gaps | a target list + message sequence is a bundle | too flat alone: no place for rationale and completion |
| b. planning result: actions + dependencies + rationale (+ completion) | matches what `studio_plans.plan` already stores (items, reasons, gaps) | matches what an outreach planner would need to record | **the shape of the output**, domain-typed |
| c. create an existing domain-native object | **yes** — `studio_plans` *is* this, plus `recommendationId` lineage | none exists; the first outreach planner creates its own native object | preferred wherever the object exists |
| d. escalate to Campaign | see §12 | see §12 | an outcome, not an output shape |

**Proposal:** a planner emits a **domain-typed PlanningResult** = `{ recommendationId, domain, rationale, actions[] (domain-typed), dependencies, completion: { condition, owner }, escalation?: "campaign" }`, and *materialises it as the domain's own object* where one exists (`studio_plans` for content, with a `recommendation_id` link added in that domain's own migration when the seam is built; a new outreach-native object for outreach). The PlanningResult is the **seam type**; the persisted thing is domain-native. No cross-domain table.

## 11. Does a generic Plan object remain unnecessary? (deliverable 11)

**Yes.** The content domain already has `studio_plans` with items, rationale, brief, objective and a deal link; the outreach domain needs targets and a sequence that have no meaning to Studio; the commercial domain plans in Deals' own terms. A generic Plan row would hold `recommendation_id`, `domain`, `status` and a JSON blob — the `tasks`-table failure #647 named (five producers, a progress bar, no semantics). What *is* shared is small and already exists: the Recommendation's `execution.refs` (`ExecutionRef {kind, id}`) and the Existing Work projection (§13). Lineage by `recommendationId` on the domain object is enough.

## 12. Can a planner escalate to Campaign? (deliverable 12)

Tested explicitly with the three things that must not be confused:

- **Shape validation** (router): the Brain's `specialized_plan` was checked against the plan contract and handed off. That is final *for that Recommendation*.
- **Downstream discovery of complexity** (planner): the content planner for "rebuild active presence on TikTok" finds the work is many pieces over months. Complexity alone is **not** a campaign — #570's edge is a reason to end owned outside, and a practice ("a consistent cadence") has none. The planner plans; it does not escalate.
- **Strategic reclassification** (Brain): the planner finds the work *is* a bounded activation with an external end (a season, a term, a stated finish) — e.g. "for the season" was in the Objective's horizon all along. That is a **change to the governed strategic undertaking** (a different shape, a different key, a different approval flow) and the planner may not make it.

**Rule:** a planner may **flag** `escalation: "campaign"` with the source it believes ends the activation (`{source, ref}`, the same typed carrier as R17), and stop. The flag is an input to the next Brain run (as a requested decision on the same subject, or simply visible as planned work with a note), and only a new campaign-shaped Recommendation — governed by the athlete, with its own `ends` — opens a Campaign. No silent conversion, ever. The router already refuses a campaign without a typed end, so a planner's flag cannot smuggle one in.

## 13. Existing Work projection from planned work (deliverable 13)

Existing Work today derives from deals (`accepted_deal | negotiating | under_review | activation`, with `for {recommendationId, objectiveIds}` since 0.5.0) and Objective proposals under review. A planner's work must appear there so the next Brain run can cite it (Case 4 showed NO_ACTION depends on the link) and the router can dedup (execution refs and `for`).

**Minimum projection**, one item per planning result, not per action:

```
WorkItem { id: <domain object id>, ref: { kind: "plan", id }, kind: "activation" (existing enum; a plan in motion is an activation),
           brand: null | brand, statement: <one sentence from the planner: what is in motion and where it stands>,
           since, termStart: null, termEnd: null, deliverablesRecorded: <count of done actions>,
           for: { recommendationId, objectiveIds } }
```

and, on the Recommendation, `execution.refs += { kind: "plan", id }` at hand-off (`execution_proposed`) — the two are the same fact from two sides. The Brain reads `· executing recommendation[<id>]` as it already does. **Lineage:** planner object → `recommendationId`; Recommendation → `execution.refs`; Objective ← `for.objectiveIds`. The store is not built here; the projection is what any store must be able to emit. One gap to record: `WorkItem.ref.kind` is `deal | objective` today; `plan` (and later `campaign`) is an additive enum value for the existing-work contract when the seam is built.

## 14. Approval / authorization findings (deliverable 14)

Preserved: **Recommendation acceptance ≠ execution authorization.** For the plan seam:

| Planner output | Status | Athlete act required |
|---|---|---|
| the PlanningResult itself (targets, sequence, briefs as intents) | **prepared work** | none beyond `respond` accept + `authorizePrepare` on the Recommendation — those two acts are what let the router hand off at all |
| a Studio brief → priced preview → generation | prepared until the spend gate | Studio's own spend approval (existing) |
| a post / publish | consequential | Studio's clearance + publish gates (existing) |
| an outreach message to a counterpart | consequential | tap-to-send (`pending_actions`; a new kind beyond `send_reply` when outreach exists) |
| a counter / accept on a deal | consequential | tap-to-send (existing) |
| a payment | consequential | dual confirm (existing) |
| `escalation: "campaign"` | a flag | nothing until a new Recommendation is governed |

No new gate is invented; no gate is removed; no planner output executes by itself. The one structural note: `authorizePrepare` today is one act for the whole Recommendation; a planner producing several consequential actions still needs each of them tapped, so preparation authorization must never be read as "send all".

## 15. Minimum forcing cases for the first planner experiment (deliverable 15)

Provider calls only if a planner is exercised as a model; the seam itself is testable offline. Proposed, in order of cost:

1. **Handoff sufficiency (offline):** take the four routed `PlannerHandoff`s from #649/#650 (Yuwa ×2, academic/tech ×2) and write, by hand, the PlanningResult each planner would need to emit; record every fact the planner needed that was not on the handoff and where it came from (record / run artifact / nowhere). Pass: nothing needed from the Brain.
2. **Content planner on the TikTok move (one call at most):** the one plan-shaped content move in the corpus; produce a PlanningResult and map it onto `studio_plans` + briefs; check no field on the handoff was treated as binding HOW; check the Existing Work item it projects lets a Brain rerun (offline regate against Case 4's overlay pattern) return NO_ACTION.
3. **Outreach planner on the Yuwa move (one call at most):** targets, sequence, first message as a `pending_actions` proposal; check every consequential action is behind a tap; check nothing is sent.
4. **Escalation (offline):** hand the content planner the match-day Objective's move as if it had been classified `specialized_plan`; the correct output is `escalation: "campaign"` with `{source: objective_horizon, ref}` and no plan — and the router must still refuse any campaign that arrives without a governed campaign-shaped Recommendation.
5. **Dedup (offline):** re-route the same Recommendation after its plan is projected into Existing Work; expect the router's dedup refusal on `for.recommendationId` and the Brain's NO_ACTION on the next run (the two layers, kept separate).

Before any of these: the additive `ref.kind: "plan"` on the existing-work contract and a `PlanningResult` type at the seam — both design-only here.

---

## 16. Backlog

- **Planner-boundary watch item** (from #650): recorded in §8; no gate.
- **R16** unchanged.
- **Existing Work `ref.kind: "plan"`** — additive contract change when the seam is built.
- **`athlete_stated` end source** — no assertion carrier exists yet; the router refuses it honestly until one does.
- **`notSeen` drifting toward planner facts** (R15 run) — watch; it confirms §7.

---

## 17. Acceptance (27 September 2026)

Accepted by the user as the Specialized Plan seam checkpoint; R17 accepted. The seam was judged sufficiently defined to test empirically, with no further design-only checkpoint before the forcing experiment. Experiment: `docs/audits/specialized-plan-forcing.md`.
