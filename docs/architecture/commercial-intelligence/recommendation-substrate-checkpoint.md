# Brain Run → Decision → Recommendation → execution lineage, and the WHAT/HOW boundary (R13): pre-execution substrate checkpoint, 27 Sep 2026

**Controls:** #647 (accepted); `recommendation/0.1.0-exp`, `brain-eval-spec/0.8.1-exp`, `execution-intent/0.1.0-exp` (frozen experimental); the Objective proposal-set persistence pattern (`objective_proposal_sets` + `objectives` + `objective_events`); #570 untouched. No provider call, no forcing cases, no implementation, no mounting — this page defines the minimum substrate and the invariant; nothing is built.

**In plain words.** Before Nomila can turn a Recommendation into work, two things have to be true. First, the Recommendation has to exist somewhere durable — today every one of the hundred lives in a file in the repo, and nothing has ever been accepted, authorized or executed. Second, the Recommendation has to stop telling the executor what artefact to make. "Secure CSR partnerships around her Yuwa leadership" is the Brain's sentence; "build a five-slide pitch deck" is the planner's. This page defines the smallest two tables that make a Recommendation a real parent of work, tests whether one pointer up is enough for lineage, and writes the rule that keeps the Brain out of the planner's chair without making it vague.

---

## 1. #647 findings, preserved as current

100 gated Recommendations across nine specs · 81 Specialized-Plan-shaped · 19 Direct-Action-shaped · 0 Campaign-shaped · every Direct Action is Northlight · none ever responded to, authorized or executed · the contracts have no production callers · BrainRun is an audit/evaluation record · Decision is a durable key, not a governed entity · Recommendation is the governed business object · Existing Work is a Brain input projection · Specialized Plan is a seam to specialized planners, not a Plan table · no universal Action entity · Campaign never empirically selected · R13 (strategic Recommendations leak artefacts/mechanics) · #570's approval conflict, untouched.

## 2. Minimum BrainRun persistence — `brain_runs`, an immutable evaluation record

Modelled on `objective_proposal_sets`, which persists exactly what a Brain run needs and nothing it does not: `as_of`, `spec_version`, `canonical_sha256`, the evidence timestamps, the normalised set, the run record, and the structured evidence byte for byte (0068). No status, no lifecycle, no update path, no delete.

| column | holds | proposal-set analogue |
|---|---|---|
| `id` uuid · `athlete_id` · `as_of` | run identity and time (the harness's `promptSha256` and label become `prompt_sha256` and an optional `label`) | same |
| `spec_version` · `canonical_sha256` · `prompt_sha256` · `model` | which methodology, which exact prompt | `spec_version`, `canonical_sha256` |
| `inputs` jsonb | **evidence-as-seen, byte for byte**: live/deferred/declined Objective ids + `stateAsOf`, the State snapshot, the map (+ `mapAsOf`), Existing Work (+ `asOf`), Context block, research blocks, requests, subjects — exactly `{inputs}` of today's artifact | `state_snapshot`, `opportunity_map`, `state_as_of`, `opportunity_map_as_of` |
| `record` jsonb | raw text, parsed, both gate verdicts, usage, cost, latency, finish reason — today's `{record}` minus `output` | `record` |
| `output` jsonb | the normalised decision set: `decisions[]`, `deferred[]`, `requested[]` — **the Decisions evaluated**, with their `decision` values | `set` |
| `created_at` | — | same |
| index `(athlete_id, as_of)` | — | same |

**What is deliberately absent.** No `reconciliation` column: what reconciliation did is recorded on the Recommendations (`events[].note` names the run; `runs[]` lists reaffirming runs), and on Intelligence Requests (`raisedBy.runId`, `reconsideredInRun`). The run is the *pointer target*, never the owner of downstream state. No `status`: a run is done when its row exists. No `supersededBy`: runs do not supersede runs. Immutable append-only rows are **sufficient** — every question this checkpoint asks of a run ("what did it see", "what did it decide", "which Recommendations cite it") is answered by the row or by pointers to it. **BrainRun is not governable and gets no lifecycle by being persisted.**

## 3. Decision identity — the key holds; no entity

`decisionKey = sha(source · subject · question)`; today it is the "family" lookup in `reconcileRun` and the first half of both `recommendationKey` and `requestKey`.

| case | what the key does | result |
|---|---|---|
| repeated Brain runs on the same live Objective | the loop question is a constant; the key is identical run to run; the family lookup finds the open Recommendation → reaffirm / reword | holds (A3 ledger; 1B's 14 reaffirmations) |
| reconsideration after new evidence | evidence is not identity (cites, `notSeen`, wording are outside the key); the same decision is re-answered; a governed record is `reconsidered_by_run` | holds — the R1 pair re-answered one deferred decision twice with different evidence and the request keyed on it both times |
| same subject, different question | `deal[northlight]` · "advance, counter or accept?" vs `deal[northlight]` · "does its exclusivity conflict?" (cell D3) → two keys | holds, and is right: they are different decisions with different needs |
| one Objective, different questions | the loop question on `objective[X]` and a *requested* question about the same Objective → two keys; both may RECOMMEND | holds; duplication across the two is the within-run invariant's job (`advances` must name one in-motion item) — the Brain's, not the key's |
| NO_ACTION then RECOMMEND on one decision | NO_ACTION creates nothing; the later RECOMMEND creates a record on the same key | holds |
| REQUEST_INTELLIGENCE then RECOMMEND on one decision | the Intelligence Request (decision + need) and the later Recommendation (decision + routing + intent) coexist on the same decision key; the request's `reconsideredInRun` names the run that recommended | holds — the 0.8.x slice did exactly this |

**The one real pressure is upstream of the key, in subject identity.** Deals' identity is per thread; the same brand deal on four threads mints four deal ids (recorded, unbuilt: cross-thread grouping — `deal_group_id` exists, set by a script). Four subjects → four decisions → four Recommendations for one negotiation. That is not a Decision-entity need; it is the subject store's identity discipline, and the Existing Work view inherits it too. Recorded as a blocker for commercial direct actions in production (R14), not for this substrate. **Conclusion: Decision = source + subject + question, a durable key with no lifecycle or governance.**

## 4. Recommendation persistence — the record, mounted one to one

The governed object; nothing in its semantics changes. Two tables, the Objective pattern (row + append-only events), or one row with an events array — the Objective pattern is preferred because the ledger already proved append-only events with `actor_role`/`actor_user_id` and a CHECK that system events carry no user.

| record field | persists as | note |
|---|---|---|
| `id`, `version` | `recommendations.id`, `contract_version` | |
| `key` · `source` · `subject` · `question` | `recommendation_key`, `decision_key`, `source`, `subject_kind`, `subject_id`, `question` | `decision_key` stored explicitly so the family lookup is an index, not a recompute |
| `objectiveIds[]` | `objective_ids uuid[]` | Objective lineage; may be empty for a requested commercial decision |
| `value {what, why, cites, executionPath, relationToExistingWork, advances, notSeen, intent}` | `value jsonb` (immutable per version; a reword is a new `value` with the old kept in events) | rationale = `why` + `cites`; considerations = `notSeen`; constraints — **not a field, by design** (§8) |
| `versions {spec, runId, runAt}` · `runs[]` | `spec_version`, `run_id → brain_runs`, and `runs` in events | originating run + reaffirming runs |
| `response` · `authorization` · `execution` · `outcome` | four jsonb columns, each with its own transitions (never one standing for another) | governance; `execution.refs[]` = execution linkage by reference |
| `supersededBy` · `reconsiders` · `closed` | columns | the withdrawal rule and supersession semantics, unchanged |
| `events[]` | `recommendation_events` (`at`, `actor_role`, `actor_user_id`, `event`, `note`, `delta`) | the 17 event names of the contract; CHECK on `event` |

Invariants to carry into CHECKs: `closed ⇒ (response.state = declined ∨ superseded_by ≠ null ∨ a withdrawn_by_run event)`; `authorization.state = prepare_authorized ⇒ response.state ∈ {accepted, modified}`; `execution.state ≠ none ⇒ authorization.state = prepare_authorized`. All three are what `respond` / `authorizePrepare` / `recordExecution` already enforce in code. The **writer** is `reconcileRun` applied per run against the athlete's open records — the `brainRecommend.ts` script, moved off a JSON file onto the tables, behind a flag, dev only.

## 5. Strategic provenance chain — and execution lineage, tested

**Chain:** `work.recommendation_id → recommendations (decision_key, objective_ids, run_id) → brain_runs (inputs, output) → objectives / State / map as seen`. One pointer from work resolves everything above it.

| case | recommendationId alone? | what else carries the rest |
|---|---|---|
| A · one Recommendation → one execution item (Northlight counter → one `pending_actions` row) | **yes** | `execution.refs[]` points back; the row carries `recommendation_id` |
| B · one Recommendation → several domain actions (a content plan → n briefs) | **yes** for strategic provenance; the plan's own id groups its actions (`studio_plans`) | execution lineage is the domain's (plan → jobs → assets), not the Recommendation's |
| C · one Recommendation → one Campaign → many items | **yes, via the campaign**: `Campaign.recommendationIds[]` (#570 §4.2) and every job carries `campaign_deliverable_id` / `source_spec_id` (#570 §6) → job → campaign → Recommendation | work under a campaign carries campaign lineage, not `recommendation_id`; the chain resolves in two hops |
| D · a later run reconsiders while work is active | **yes** — the record is governed → `reconsidered_by_run`; a different judgment creates a new record with `reconsiders`; active work keeps its parent; nothing is rewritten | the execution system is told nothing by intelligence alone (withdrawal rule) |
| E · superseded while authorized work is active | **cannot occur**: a governed record is never superseded — only reconsidered. If the athlete later *declines* it, the record closes with its refs intact; whether to cancel the work is the execution system's act, recorded as `execution_failed`/a cancel ref | holds by the established rule |
| F · execution fails and is retried | **yes** — `recordExecution` appends refs (`execution_failed`, then `execution_proposed` again); `execution.state` is the latest, the events keep the history | the retry is the domain's; no new field |
| G · one execution item serves two Objectives through one Recommendation | **yes** — `objective_ids[]` on the record; the work carries the one `recommendation_id` | outcome attribution splits at the Recommendation, never at the work |
| the inverse (one item serving two Recommendations — a post that fulfils a deal deliverable *and* a cadence plan) | the work carries the parent that *originated* it; the other Recommendation lists it in `execution.refs[]` | #570's many-to-many is on the campaign side (`campaign_deliverables.assetIds`); the same shape here |

**Finding: `recommendationId` is sufficient as the strategic parent of downstream work.** Strategic provenance (why this work exists, for which decision and Objectives, judged from what) resolves through the Recommendation; execution lineage (plan → action → job → asset, retries, cancels) stays inside each execution system. BrainRun and Decision ids are **not** pushed into downstream objects; they are one hop away through the Recommendation. Two additive nullable columns are all execution needs: `pending_actions.recommendation_id` and `generation_jobs.recommendation_id` for work originated directly; campaign work already has #570's lineage.

## 6. R13 — the twelve current-era leaks, under the ownership test

The test: *is this choice part of the strategic Decision being made, or is the Brain making a downstream execution choice on the planner's behalf?* Artefact nouns are not banned; a medium may be the Decision ("launch a podcast" when that is the question).

| run · Objective | emitted `what` | HOW element | ownership | the WHAT that survives |
|---|---|---|---|---|
| G0 · Yuwa | "Develop a targeted commercial pitch highlighting her leadership with the Yuwa … to secure corporate CSR partnerships" | "a targeted commercial pitch" (artefact) | planner's | Secure CSR partnerships grounded in her Yuwa leadership |
| S1 · Yuwa | "prepare a specialized CSR pitch deck and storytelling outline …" | pitch deck; storytelling outline | planner's | same |
| A3 · Yuwa | "Develop a specialized CSR commercial pitch deck highlighting …" | pitch deck | planner's | same |
| N · Yuwa | "Develop a specialized commercial pitch strategy … to present to CSR officers at global brands" | "pitch strategy … to present to CSR officers" (artefact + channel) | planner's; "CSR officers" is a legitimate *who*, the deck is not | Secure CSR partnerships with global brands' impact teams around Yuwa |
| P · Yuwa | "Develop a specialized storytelling content plan and pitch materials …" | content plan; pitch materials | planner's | same |
| PB · Yuwa | "Develop a specialized CSR outreach campaign and presentation deck …" | "campaign" used loosely + deck | planner's (and a shape word misused) | same |
| S1 · positioning | "construct a targeted outreach plan and commercial deck emphasizing her Stanford tech credentials …" | outreach plan; deck | planner's | Establish commercial partnerships in EdTech/STEM that use her Stanford tech credentials |
| N · positioning | "Formulate a specialized commercial partnership deck showcasing …" | deck | planner's | same |
| P · positioning | "Develop a tailored commercial pitch deck …" | deck | planner's | same |
| G0 · audience | "Establish a consistent social media posting cadence to reactivate her TikTok channel and increase her Instagram post frequency" | none — cadence and the two channels are the Opportunity's own terms | **Brain's** (A) | keep |
| S1 · audience | "outline a specialized content creation plan to batch and cross-post video content during her October schedule lull …" | batch; cross-post; the lull as schedule | planner's | Restore an active presence on TikTok and a regular Instagram cadence (why-now from the window, as a consideration) |
| A3 · audience | "Create a specialized plan to reactivate her dormant TikTok channel by cross-posting existing video formats like Reels and carousels" | cross-posting; Reels; carousels | planner's | Bring her dormant TikTok channel back into use |
| N · audience | "Create a specialized content cross-posting plan to reactivate her dormant TikTok channel and boost her Instagram posting frequency" | cross-posting plan | planner's | same |
| P · audience | "Reactivate her dormant TikTok channel by implementing a cross-posting plan for her high-performing Instagram Reels …" | cross-posting; Reels | planner's | same |
| PB · audience | "Develop a specialized content strategy and production plan designed to increase her Instagram posting cadence and reactivate …" | production plan | planner's (mild) | same |
| G0 · positioning | "Initiate targeted commercial outreach to premium brands in the EdTech, STEM, and tech venture sectors …" | none — sectors are the Opportunity's | **Brain's** (A) | keep |

Twelve of sixteen leak; in every one the artefact (deck, plan, outline, workflow) or mechanism (batch, cross-post, format) is a choice a content or outreach planner would make differently, and none is what the Decision is about. The two clean ones show the target register. **Nothing about this is vague:** the surviving WHATs still name the subject, the direction and the reason; they stop naming the thing to be built. (The verb "Develop a specialized … plan" is a symptom of the enum name `specialized_plan` echoing into prose — noted for the invariant's wording.)

## 7. The invariant — exact wording (candidate for the next Brain bump, not applied)

> **THE ARTEFACT IS NOT YOURS.** You recommend the strategic change or undertaking — what should be different for her and why. You do not choose the execution artefact, channel, format, workflow, sequence or mechanics that would bring it about, unless that choice is itself the decision being made. The test is ownership: if a planner or executor could reasonably make this choice differently and still serve your recommendation, it is theirs, and you leave it to them. "Secure CSR partnerships grounded in her Yuwa leadership" is yours; "build a pitch deck" is not. "Bring her dormant TikTok channel back into use" is yours; "cross-post her Reels weekly" is not. "Launch a podcast" is yours only when the question was whether she should launch a podcast. Say the move, the subject, the direction and the reason, and stop.

Paired with the existing commercial invariant (THE AMOUNT IS NOT YOURS) and the existing execution-path enum, this closes R13 at the contract level; it is verified only by rerun.

## 8. What a planner needs from a Recommendation — existing fields suffice

| planner need | existing field |
|---|---|
| intended strategic change | `what` (post-R13 register) |
| why | `why` + `cites` |
| subject | `subject` (SubjectRef) |
| Objective lineage | `objectiveIds` |
| what it advances / relation to work | `advances`, `relationToExistingWork` |
| commercial intent | `intent` |
| considerations | `notSeen` |
| constraints (exclusivity, usage, approval rights, availability) | **not a Recommendation field — read from the subject's canonical sources** (the deal's commercial projection, State constraints, the athlete's assertions), which the planner resolves by `subject`; putting them on the Recommendation would copy evidence (#570 keeps them verbatim and source-labelled on the origin for the same reason) |
| relevant evidence | the run's `inputs` via `run_id` — cited, never copied |
| timing / urgency, where strategically established | `why` and `cites` (a `ctx[n]`) — the Brain states why now; the planner schedules |

**No new field.** The only addition anywhere is the two nullable `recommendation_id` columns on execution stores (§5).

## 9. Execution shape — emitted, validated; not derived

Could the shape be derived from semantics instead of emitted? Direct Action: derivable in principle (a typed `intent` on an in-motion commercial subject ⇒ direct action) — but the Brain also chooses between "counter now" and "wait", which is the intent, not the shape. Campaign: **not derivable** — it requires the Brain to state a purpose and a reason to end (#570 A1, invariant 2), which no prose parser may infer. Specialized Plan: the residual. **Keep the emitted enum** (it exists: `EXECUTION_PATHS`), read it as the Brain's *strategic classification*, and let the router validate — the hybrid from #647, confirmed. When `campaign` is chosen the Recommendation must carry a purpose sentence and a reason to end in its own words — expressible today in `what`/`why` and checked by the router; a dedicated field is decided at the Campaign checkpoint, not here.

## 10. Deterministic router — responsibilities, and nothing else

1. **Validate the shape against its contract**: `direct_action` ⇒ `advances` names an in-motion subject whose executing system exists and a typed `intent` is present (commercial) — else refuse; `campaign` ⇒ a purpose and a reason to end are stated and a `CampaignOrigin` can be filled without invention — else **refuse, never downgrade**; `specialized_plan` ⇒ a domain can be named from the subject/Objective.
2. **Deduplicate against execution** (§6 of #647): read `execution.refs[]` and the Existing Work view; a live ref for the same `recommendationId`, or work `for` the same `(objectiveId, subject)` in the same domain → attach or refuse; never a second creation.
3. **Hand off by reference**: `{recommendationId, what, why, subject, objectiveIds, advances, intent}` to the domain (Deals seam, a planner, the Campaign origin) — never a copy of evidence, never an artefact choice.
4. **Record the ref back** (`recordExecution`) when the domain reports one.
5. **Never**: infer a shape from prose, repair an invalid choice, send or spend or publish, or hold state of its own.

## 11. The #570 approval conflict — resolved conceptually (no edit to #570)

Invariant: **accepting a Recommendation governs the strategic Recommendation; it does not authorize execution.** The three acts and the #570 sentences that would change:

| act | Recommendation contract | #570 today | proposed #570 change (later) |
|---|---|---|---|
| 1 · the athlete accepts the judgment | `respond("accept")` → `response.accepted`; authorizes nothing | §3 table, Recommendation row, "who approves the scope: **the athlete, by accepting the Recommendation** (`athlete`)"; §7 lifecycle "Recommendation door: **origin accepted by the athlete**" → `planning`; A3 "Accepting the Recommendation is what approves a recommendation-door campaign" | these three say acceptance approves the campaign — **change to**: acceptance records her response; the campaign is not yet created |
| 2 · preparation is authorized | `authorizePrepare` → `prepare_authorized`; the consumer may originate | (no equivalent) | **add**: a `CampaignOrigin` may be created only from a `prepare_authorized` Recommendation; the campaign enters `idea` → `planning` (the enum already has `idea`) |
| 3 · scope is approved | (outside the Recommendation; on the execution record) | `CampaignSpec.approval: "athlete"`; `planning` → `approved` | keep — this is the scope gate; `approved` → `active` on first work or `startsOn` unchanged; spend, clearance, publish and send keep their own gates |

The exact semantic that must eventually change in #570 is one sentence in three places: "accepting the Recommendation approves the campaign". Nothing else in #570 is touched by this resolution; `idea`/`approved` — #570's own open question — become used by the Recommendation door.

## 12. `pending_actions` — disposition: keep reply-specific now; extend minimally later; never a task table

What prevents it from representing `proposed → authorized → executing → completed/failed` today: `kind` is a one-element CHECK (`send_reply`); `status` has no `authorized` or `executing` value; `approved_at` and `executed_at` are stamped in one statement, so approval and execution are one instant by construction; the executor is a single `if (kind === "send_reply")` branch; there is no `recommendation_id`. It represents exactly one thing well — a message she taps to send — and the Recommendation's `execution.refs[]` can point at it as-is (act 3 of §11 is the tap). **Disposition:** remain Mila/reply-specific for this substrate; when a second direct-action kind exists, extend additively (widen `kind`; add `authorized_at` and `recommendation_id`; dispatch per kind) into a **thin typed envelope over domain payloads** — not a universal task table, which is what `tasks` already is and what §9 of #647 refused. Do not replace it; do not mutate it now.

## 13. Deal → Campaign — the exact missing data and writer

| Campaign needs (`CampaignOrigin`, deal door) | exists today | where |
|---|---|---|
| `dealIds` (exactly one), `brandIds`, lead athlete | yes | `deals` |
| `period {startsOn, endsOn, endsWith: deal_term}` | yes | `deals.term_start/term_end` (nullable — null ≠ perpetual) |
| `constraints[]` verbatim (exclusivity scope, usage, approval rights, territory) | partly | `contractExtract` → `exclusivity {exists, scope}` and terms; `deals.negotiation_state`; thread classification; **not persisted as constraints** |
| `deliverables[]`: `category`, `contentFormat`, `format` verbatim, `quantity`, `dueOn`, `optional`, `dealDeliverableId`, `sourceQuote` | **the shape exists, the rows do not**: `deal_deliverables` (seq, format verbatim, kind, quantity, due_on, optional, status, source_quote, superseded_at) has **zero rows** | writer missing |
| the sources a writer would read | `contractExtract.ts` → `ContractDeliverable {what, count, per, …}` from a contract document (routes exist); the inbox classifier → `deliverables: string[]` free text + `key_details.deadlines[]` per thread; `contractExtract` exclusivity | extraction exists; persistence does not |

**The blocker, exactly:** no code path writes `ContractDeliverable[]` or the classifier's `deliverables[]` into `deal_deliverables` (with `seq`, a `kind` mapping onto the CHECK vocabulary, `due_on` from `deadlines[]`, `source_quote`). Until it exists the deal door cannot open, `WorkItem.deliverablesRecorded` is always 0, the Now feed's OWED and the calendar's DUE are empty, and Campaign C0 (#570 §11) is the first step. Input to the Campaign checkpoint; not solved here.

## 14. Minimum persistence before the forcing cases

| work | needed for the forcing cases? | scope |
|---|---|---|
| `brain_runs` (§2) | **yes** — a run must be a pointer target | one table, one insert in the run harness; flag off; dev |
| `recommendations` + `recommendation_events` (§4) and the reconcile writer | **yes** — Recommendation must be a real parent; `respond`/`authorizePrepare`/`recordExecution` get their first callers (a script, then tests) | two tables; the existing pure functions; no route |
| `recommendation_id` on `pending_actions` / `generation_jobs` | **no** — the forcing cases validate shapes and refusals; refs can be recorded as `{kind, id}` without the back-pointer | later, additive |
| Campaign tables | **no** — cases (a)–(c) test the router's refusal/acceptance of the `campaign` shape and the `CampaignOrigin` validator in memory | Campaign checkpoint |
| Existing Work `for` link | **no** for the cases; **yes** before any cross-run dedup experiment | with the reconcile writer |
| the R13 invariant in the Brain spec | **yes, by ceremony (0.9.0-exp)** before the cases, since the cases are read for HOW leakage | one block; unpin; parity; repin |

## 15. Semantic architecture versus production hardening

| semantic architecture (in scope next) | production hardening (out of scope) |
|---|---|
| `brain_runs` and `recommendations` as the substrate (§2, §4) | concurrent acquisition completion (R8), transactionality (R9), per-run event idempotency (R10) |
| the R13 invariant (§7) and the shape/router contract (§9–10) | retries, generalized idempotency, mounting unrelated stores |
| the #570 approval resolution (§11), applied at the Campaign checkpoint | `agent_actions.held_until` unread; `deals.pending_action` dead column |
| subject identity across threads (R14) — before commercial direct actions are real | repeatability matrix |
| `deal_deliverables` writer (§13) — before the deal door | — |

## 16. Not done

No provider call. No forcing cases. No implementation, persistence or mounting. No Objective, Opportunity, Campaign, planner, Creative Intelligence, Studio or Rate work. No generalized Action entity. #570 untouched (one sentence identified for a later change). State → Opportunity → Objective remains frozen.

## 17. Accepted (27 Sep 2026) — substrate design; do not expand the substrate project

Accepted with every finding preserved (BrainRun = immutable audit record; Decision = durable key; Recommendation = governed object; `recommendationId` = downstream strategic provenance pointer; execution systems keep their own lineage; Existing Work = Brain input projection; shape = Brain strategic classification validated by a router that refuses rather than repairs; no universal Action, no generic Plan table; R13 = THE ARTIFACT IS NOT YOURS; the #570 approval conflict must be corrected before Campaign is mounted; R14 stays a subject-identity backlog item; the deal-deliverable writer stays a Deal → Campaign dependency).

**Separation ordered:** what must be *semantically established* before the next experiment (R13 applied to the Brain experimental spec by ceremony; a corpus free of known HOW leakage) from what must be *production-mounted* before real execution (the substrate). Persistence is **not** implemented merely because its design is accepted: first determine whether the existing harness can faithfully represent BrainRun → Decision key → governed Recommendation → execution-shape classification → proposed handoff for the forcing cases; mount only if a specific semantic fact cannot be tested otherwise. Next: the Recommendation → Execution Shape forcing experiment (five cases), `recommendation-execution-shape-forcing.md`.
