# Brain Decision → Recommendation → Execution Path → executable work: boundary checkpoint, 27 Sep 2026

**Controls:** the canonical loop; `brain-eval-spec/0.8.1-exp` and `recommendation/0.1.0-exp` (frozen experimental); `execution-intent/0.1.0-exp`; #570 (Campaign slice design, untouched); #608. No provider call, no bump, no implementation, no persistence, no mounting. Evidence: **100 gated RECOMMEND decisions** across every recorded Brain run (nine spec versions), the three-record reconciled Recommendation ledger, the Deals execution seam, and a full repo trace of every work, action, approval and Studio-entry representation.

**In plain words.** The Brain can now say, with evidence, *what* Nomila should do for Mia and *why*. The next question is how that sentence becomes something that actually happens — a counter to a term sheet, a plan to bring TikTok back, a season-long series — without the Brain quietly becoming the thing that writes the counter, schedules the posts, or picks the formats. This checkpoint draws the line: which words in a Recommendation are the Brain's to say, which identifiers must travel with it so nothing is done twice and everything can be traced back, and which existing door each kind of work goes through. It does not design Campaign or Creative Intelligence; it finds where they attach.

---

## 1. The Recommendation corpus, as it actually exists

| fact | value |
|---|---|
| gated RECOMMENDs | **100** (Gate 1 and Gate 2 clean), across `0.1.0` → `0.8.1-exp`; refused sets excluded |
| execution path (Brain-chosen, structurally required) | `specialized_plan` **81** · `direct_action` **19** · `campaign` **0** |
| relation to existing work | `new_work` 80 · `advances_existing_work` 20 (every one of the 20 advances the Northlight term sheet or the CSR-outreach overlay) |
| typed `intent` (0.7.0+) | present once: A3 `counter` (the only run under a spec that has it) |
| strategic intents, by Objective | Yuwa → CSR partnerships (~30 wordings) · academic-tech positioning (~25) · TikTok reactivation / Instagram cadence (~30) · Northlight term sheet (19 direct actions) · one-off commercial cells (Lumen, Fieldline, INIU, gorjana) as REQUESTs, not RECOMMENDs |
| Decision sources · subjects · questions | live Objectives (`the Objective loop` · `objective[id]` · the loop question) and requested commercial decisions (`her agent, through Mila` · `deal[id]` · "advance, counter or accept?") |
| existing work visible | 8–9 real deal rows (TITAD, AEGISLAB, Connect Me, Pillar, gorjana…) + controlled overlays (Northlight, TikTok series, CSR outreach); queued Objectives as `under_review` |
| governance state | **none anywhere**: no Recommendation has ever been responded to, authorized or executed; the reconciled ledger holds 3 records from one run (A3), all `response.state: none` |
| reconsideration lineage | only in the ledger's reconciliation vocabulary (created / reaffirmed / reworded / superseded / withdrawn / reconsidered); one run's worth of data |
| where any of this lives | **harness files only**: `docs/audits/artifacts/…/<cell>.json` (`{inputs, record}`), `recommend-070/recommendations.json`, `acquire-*/intelligence-requests.json`. In code: the pure contracts (`recommendation.ts`, `intelligenceRequest.ts`, `dealsExecutionSeam.ts`) with **no callers** outside scripts and tests |

## 2. Persistence and lineage — what is true today, and the minimum required

**Today.** A Brain run persists nothing. The artifact carries the inputs byte-for-byte (objectives, State `asOf`, map `asOf`, work, context, research blocks) and the record (spec, digest, prompt sha, raw text, gates, normalised output) — the same evidence-as-seen discipline `objective_proposal_sets` applies in a table. Decision identity is a deterministic key (source · subject · question). Recommendation identity is a deterministic key over decision + routing + intent, with a ledger record. Nothing downstream exists.

**Minimum lineage** for `Brain Run → Decision → Recommendation → execution work → outcome`, answered item by item:

| question | answer | why |
|---|---|---|
| does BrainRun need durable identity? | **yes — as an audit/run record, not a business object** (exactly what `objective_proposal_sets` is for Objectives): id, spec, digest, prompt sha, inputs digests / snapshots (`stateAsOf`, `mapAsOf`, `workAsOf`, `contextAsOf`, research blocks), gate results, normalised output | reproducibility and "what did it see"; nothing governs a run, nothing is re-surfaced by one |
| does Decision need durable identity? | **a durable key, not an entity**: source · subject · question is already deterministic and stable across runs (it reconciled A3's three decisions and the request ledger's keys) | the governed thing is what was *decided about* the decision — the Recommendation or the Intelligence Request — not the question itself |
| which owns evaluation-time evidence-as-seen? | **the run record** (inputs byte-for-byte); a Recommendation cites the run (`versions.runId`, `runs[]`) and carries its own `cites` by path | one copy of the evidence; many governed objects may point at it |
| what must a Recommendation carry? | `id`, `key` (decision + routing + intent), the decision identity (`source`, `subject`, `question`, `objectiveIds`), `versions {spec, runId, runAt}`, `runs[]`, the value (`what`, `why`, `cites`, `executionPath`, `relationToExistingWork`, `advances`, `intent`, `notSeen`), `response`, `authorization`, `execution.refs[]`, `outcome`, `supersededBy`, `reconsiders`, `events[]` — **all already in `recommendation/0.1.0-exp`**; nothing to add | the contract was designed for this; it lacks only a table and a caller |
| what must downstream work carry? | **`recommendationId`** (and through it the decision key and objective ids), plus the executing system's own id. #570's `CampaignOrigin.recommendationId` and `Campaign.recommendationIds[]` already say so for campaigns; `pending_actions` and `generation_jobs` would need a nullable `recommendation_id` (or a `source` jsonb) — a later additive column, not now | one pointer up is enough; the Recommendation record holds the rest |
| how does a later run know what it is reconsidering? | by **Recommendation key** (same decision + routing + intent → reaffirm/reword), by **decision key** (same decision, different routing/intent → supersede or `reconsiders`), and by **Existing Work** items whose `for.recommendationId` is set (the run *sees* that its earlier recommendation is in execution) | the first two exist in `reconcileRun`; the third is the Existing Work view of §7 |
| what does outcome attribution need? | work ref → `recommendationId` → decision key + `objectiveIds`; `Recommendation.outcome {at, followed, result}` (exists, unwritten); for campaigns, #570's aggregate outcome (n of m, `endedBecause`) attached to the campaign's `recommendationIds` | Measure/Learn is deferred; the pointers must exist before then, the writers may wait |

**Audit/run record vs governed object:** BrainRun and the Intelligence Request ledger are records; the Recommendation is the governed business object (it has response, authorization, execution, outcome and events); Campaign is a governed execution container (its own lifecycle, #570 §7). Nothing else on this path is governed.

## 3. The Recommendation semantic boundary — WHAT/WHY audit of all 100

Signals were located mechanically over the `what` field, then each class read against the spec era:

| signal class | count | A legitimate WHAT/WHY | B useful constraint / consideration | C execution HOW leakage |
|---|---|---|---|---|
| channel named (TikTok, Instagram, Reels) | 34 | **mostly A** — the channel *is* the subject the Opportunity named (a dormant TikTok is the asset; "reactivate her TikTok channel" is WHAT) | — | C when the channel is a *means*: "by cross-posting existing Instagram Reels" |
| format / artefact named (deck, brief, case studies, pitch materials, workflow, pipeline, calendar) | **48** | — | B only where the Opportunity is about materials | **C in 40+**: "Develop a specialized CSR pitch deck", "storytelling assets and impact case studies", "an automated cross-posting workflow", "content batching workflow", "a content calendar" — the Brain choosing the deliverable |
| sequencing / mechanism (automated, batch, cross-post, syndicate, schedule) | 23 | — | — | **C** — production mechanics |
| timing window (the 20/26-day gap) | 6 | — | **B** — "why now" from Context, a legitimate consideration (R4's capacity inference aside) | C once it schedules ("during her October lull, batch…") |
| a figure (USD 7,602 counter; USD 3,602 floor) | 11 | — | B when citing the counterparty's number | **C** under ≤ 0.4.0 (constructed counters, floor arithmetic) — **closed by 0.5.0 invariant 2**; the sole 0.7.0 direct action says "bring the compensation in line with her established floor" — A |
| an instruction to a person ("Direct her management team to…", "Instruct her agent to review and respond") | 19 | — | — | **C-shaped** under ≤ 0.4.0 — the Brain scripting the agent; **replaced by the typed `intent`** at 0.7.0 (accept · counter · ask_terms · decline · wait), which is A |
| deliverable specification ("four social posts", "at least USD 7,602 for an ambassador role and four posts") | 3 | — | B when restating the term sheet | C when proposing |

**Reading.** The commercial half is now clean: after 0.5.0/0.7.0 the direct-action Recommendations say *what* (counter) and *why* (below her floor) with no amount and no script. The strategic half is not: **12 of the 16 current-era (0.6.0+) `specialized_plan` Recommendations name the deliverable** (a pitch deck, a storytelling plan, a cross-posting plan, a "content strategy and production plan"). The `what` should be the outcome the plan serves — "secure CSR partnerships around her Yuwa leadership", "bring her TikTok channel back into use" — and the deck, the batch, the cross-post are the planner's. This is the strategic-side twin of the Rate lesson (invariant 2): **the Brain names the move, never the artefact.** Recorded as R13; not rewritten here.

**The boundary, stated:** a Recommendation is Nomila's durable, governable proposal for what should be done and why. It carries: the decision it answers; the move (`what`) as an outcome-directed sentence; the reasons (`why`, `cites`); the execution shape (§8); what it advances; the typed intent where the shape is a direct action; considerations (`notSeen`, and constraints from evidence, verbatim and labelled — #570's `constraints[]` shape); governance. It does **not** carry a task list, a schedule, a channel plan, formats, counts, an amount, a message, an asset requirement, or an instruction to a named person.

## 4. Existing work — every representation Nomila holds

| representation | what it is | identity · status | in code / mounted? |
|---|---|---|---|
| `deals` | a brand conversation with commercial state | id, `deal_group_id`; `detected · negotiating · accepted · completed · rejected · (pending)`; `negotiation_state` jsonb | mounted |
| `deal_deliverables` / `deal_periods` | what is owed under a deal, with due dates and amendments | `(deal, seq)` + `superseded_at`; `open · fulfilled · waived · cancelled` | schema mounted; **zero rows — no writer** |
| `pending_actions` | a proposed outward effect awaiting her tap | id; `pending · approved · dismissed · failed`; **`kind` is a one-element enum (`send_reply`)** | mounted; the tap-to-send door |
| `agent_actions` | receipts of what Nomila did on her behalf, reversible | append-only; `undone_at`; `held_until` (no executor reads it) | mounted |
| `workflow_runs` / `workflow_steps` | a durable process instance (onboarding, research, the acquisition seam) | one active per (athlete, scope); step statuses | mounted |
| `generation_jobs` · `studio_publish_jobs` · `studio_stitch_jobs` · `studio_edit_previews` · `studio_plans` | Studio work: a render, a post, a stitch, an edit, a plan | own status enums; `studio_sessions` status is *derived* from job rows by design | mounted |
| Intelligence Request | a typed need in acquisition | derived status | **harness file** |
| Recommendation | the governed proposal | response / authorization / execution states | **harness file**, contract only |
| Campaign | a persistent activation | `idea · planning · approved · active · ended` (+ `endedBecause`) | **design only** (#570); `WORK_KINDS.activation` and `SUBJECT_KINDS.campaign` reserved for it |
| Brain's `ExistingWork` lens (`existing-work/0.4.0-exp`) | an itemised projection: deals in `negotiating` / `accepted` + Objectives `under_review`, each with ref, statement, amount, term, `deliverablesRecorded`, `since` | ref = `SubjectRef` | contract + harness assembler |

**Four disjoint answers to "what is in motion"** exist today and none derives from another: State `commercialPosition.pipeline` (counts over five deal states), the Brain's `ExistingWork` items (two deal states + queued Objectives), `liveObjectives`, and the pending-action queue. The Brain reads the second and cites the first.

## 5. The minimum Existing Work view

The Brain needs to answer one question — *is this Recommendation already being executed?* — and needs, per item, only: **what is underway** (a statement), **why / for what** (objective ids, and the Recommendation it executes if any), **the subject** (`SubjectRef`), **status** (a small shared vocabulary: proposed · awaiting_her · in_progress · done · abandoned, derived per source), **ownership** (which system executes: deals · studio · campaign · workflow · athlete), and **enough to judge duplication/conflict** (`for.recommendationId`, `for.objectiveIds`, `since`, and for commercial items the deal ref). It does **not** need the underlying objects, amounts beyond what `WorkItem` already carries, or any execution detail.

**What it is:** a **Brain input projection**, not a State section (State holds facts about her business; "a plan Nomila proposed is in preparation" is Nomila's work, not her fact — the same placement rule as #638), not a new shared entity (each source keeps its identity and status; the view derives). It is the existing `ExistingWork` lens with two additions: a `for {objectiveIds, recommendationId}` link on each item and sources beyond deals (pending actions awaiting her tap, workflow runs, Recommendations with `authorization ≠ none`, campaigns when they exist, Studio plans linked to a deliverable). `WORK_KINDS` already reserves `activation` for the campaign row. The Objective-under-review items stay (they are "decisions pending", correctly labelled).

## 6. Deduplication — three identities, three places

| identity | means | where the check belongs |
|---|---|---|
| **same Recommendation** | same decision + routing + intent (`recommendationKey`) | **Recommendation reconciliation** (exists: reaffirm / reword / supersede / withdraw / reconsider); a governed record is never re-created |
| **same strategic intent** | same decision (or same objective + subject) under a different routing/intent | Recommendation reconciliation: `supersedes` / `reconsiders` with the governed-record rule; the Brain sees the earlier one as Existing Work (`advances_existing_work`) |
| **same execution work** | an execution ref already exists for that intent (a pending action on this thread, a campaign for this objective, a plan for this recommendation) | **the execution router** — before creating work it reads `Recommendation.execution.refs` and the Existing Work view; a live ref for the same `recommendationId` or the same `(objectiveId, subject)` → attach or refuse, never a second creation — and **each execution system's own idempotency** (one active workflow run per scope; one pending action per thread would need adding; Campaign invariant 2 from #570) |

The within-run invariant (two Decisions may not independently advance the same next step) stays the Brain's. Across runs the Brain is *informed* (Existing Work) and the router *enforces*. A Recommendation that is `reaffirmed_by_run` with `execution.state ≠ none` creates nothing.

## 7. Execution-shape classification of the actual corpus

| family (of the 100) | count | shape by the definitions below | what the corpus shows |
|---|---|---|---|
| counter / accept / respond to a term sheet (Northlight) | 19 | **Direct Action** — Deals owns the next meaningful work (a draft reply with a typed intent → her tap) | the one clean fit; the `ExecutionIntent` seam exists and was dry-run (#631) |
| reactivate TikTok / restore Instagram cadence | ~30 | **Specialized Plan → Actions** (content: a planner produces briefs/posts) — **not a Campaign**: no reason to end ("a consistent cadence" is a practice), no aggregate outcome beyond the metric | every wording names formats and mechanics (C leakage) |
| CSR partnerships around Yuwa / academic-tech outreach | ~50 | **Specialized Plan → Actions** in the *outreach* domain (materials, target list, proposals, follow-up) — **borderline Campaign** only where a bounded activation with a reason to end is proposed (R4's "proposals sent to six brands" has scope and outcome; its end is "replies or the horizon") | the Brain proposes the *materials* (deck, brief, case studies); no planner or executor exists for outreach |
| supporting assets for outstanding proposals (R4 storytelling assets) | 1 | **direct to Studio** via a brief (no campaign, attached later) — or an action of the outreach plan | the only creative-shaped Recommendation in the corpus |
| Campaign | 0 | — | never chosen; nothing in the corpus meets #570's definition unforced |

**Direct Action, defined:** a specialized execution capability that already exists can own the next meaningful work from the Recommendation's `what` + typed `intent` alone, produce the proposal for her tap, and report back a ref — no intermediate plan. Today only Deals satisfies it (draft with intent → `pending_actions.send_reply`).

**Specialized Plan — warranted, but not as a generic entity.** The corpus's largest class needs *someone* to turn "bring TikTok back" into posts, and "secure CSR partnerships" into materials and outreach. #608 §7 already places the content planner (the surviving half of #309) behind a Recommendation's execution path; an outreach planner does not exist. What is warranted is the *seam*: a Recommendation of shape `specialized_plan` hands `{recommendationId, what, why, objectiveIds, subject, constraints}` to a domain planner that owns the plan's shape and its actions, and reports refs. No generic `Plan` table; each domain keeps its plan (Studio has `studio_plans`).

**Campaign boundary against #570** (§10 below). **Counterexamples the three paths do not hold:** (i) *a standing practice* ("post consistently", "keep her TikTok active") — no completion condition, no reason to end; neither an action nor a campaign; its executor is a habit the athlete keeps, which Nomila can only support (a planner's recurring briefs) and measure; (ii) *an instruction to a person* ("direct her management team to respond") — an athlete-side action with a human executor; the typed intent + tap covers the Deals case, but "her agent should call the brand" has no door; (iii) *monitoring* (NO_ACTION with a watch) — by rule creates no work, which is right, but "watch for X" is a request to Context, not to execution.

## 8. Who chooses the path — **D, a bounded hybrid**

The Brain chose a path in 100 of 100 because the contract requires one, and chose sensibly (direct action only when a term sheet was in motion). That is strategic classification and it should stay: the Brain can recognise "this is the next step on an in-motion item", "this needs a coordinated plan in one domain", "this is a persistent activation with a purpose and a reason to end". What must not follow from the choice is HOW. So: **A for the shape, with C validating it deterministically, and the Recommendation carrying no more than the shape needs** — `direct_action` requires an in-motion subject and a typed intent (exists); `campaign` requires a one-sentence purpose in the Brain's words and a reason to end (`endsWith`: objective horizon / a stated finish) — #570 §4.1 and invariant 2, applied at the seam; `specialized_plan` requires a domain (content · outreach · relationship · …) and nothing else. A `campaign` without a reason to end is refused, not downgraded (refuse, never repair). The router never infers a shape from prose.

## 9. Action — audit and proposed semantics

Every action-like object in the repo (inventory in the trace): `pending_actions` (one kind, tap-executed), `agent_actions` (receipts), `workflow_steps` (incl. `await_human`), `generation_jobs`, `studio_publish_jobs`, `studio_stitch_jobs`, `studio_edit_previews`, `payments`, plus typed intents (`CommercialIntent`, `ReplyIntent`, `ExecutionIntent`, `StudioIntent`, `RecAction`) and Objective/Run actions. Each has its **own status enum and its own completion condition**, and several deliberately derive status rather than store it (`studio_sessions`).

Candidate tested — *an Action is a discrete unit of work with a defined owner/capability and an observable completion condition* — **holds as a description and fails as an entity**: the completion condition of a send is "sent once", of a job "succeeded with an asset", of a payment "settled after dual confirm", of an athlete answer "the step completed by her hand". Flattening these into one table would reproduce the `tasks` table (five producer types, a progress bar, no semantics). **Proposal:** no universal Action entity; a **thin read envelope** only — `ExecutionRef {kind, id, owner, status: proposed|awaiting_her|in_progress|done|failed|abandoned, since}` derived per source — which is what `Recommendation.execution.refs` and the Existing Work view consume. Domain actions stay typed and domain-owned. Athlete-required actions are `pending_actions` and `await_human` steps; automated ones are jobs and runs.

## 10. Approval versus execution authorization — the map

| gate | what is approved | by whom | what it authorizes | exists |
|---|---|---|---|---|
| Objective decision | a desired outcome | identified athlete/admin | the Objective is live → the Brain may recommend on it | mounted |
| Recommendation `respond` | the strategic judgment | athlete | **nothing** outward | contract, no caller |
| Recommendation `authorizePrepare` | that a consumer may prepare (draft, plan, originate) | athlete / system | a draft, a plan, a `CampaignOrigin` — never a send | contract, no caller |
| Campaign scope (`CampaignSpec.approval`: athlete / brand / contractual) | the scope of an activation | athlete (brand later) | the campaign is `approved` → `active` | design (#570) |
| tap-to-send (`pending_actions` approve) | one message body | athlete | one send, once | mounted |
| Studio spend | a dollar ceiling for one frozen brief | athlete | one generation job | mounted |
| Studio clearance (`media_assets.approval_status`) | one asset | athlete | embed + publish | mounted |
| publish mode | — | athlete at the tap | `live` may send; `dry` never | mounted |
| payment dual confirm | delivery | athlete + brand | the transfer | mounted |

**Findings.** (1) The distinction the brief asks for already exists in code and in the contract: accepting a Recommendation authorizes nothing outward; each execution system keeps its own gate. Keep it. (2) **#570 A3 and the Recommendation contract disagree**: #570 says accepting the Recommendation approves a recommendation-door campaign; the contract (three days later) says `respond` authorizes nothing and `authorizePrepare` is a separate act. Resolution to propose to #570 (not applied): accept = `respond`; `authorizePrepare` = the `CampaignOrigin` may be created (`idea` → `planning`); `CampaignSpec.approval: athlete` = the scope gate (`planning` → `approved`). Three acts, three states #570 already has. (3) `pending_actions` stamps `approved_at` and `executed_at` together, so it cannot express authorize-then-execute; a Recommendation's execution refs point at it after the fact — adequate for direct action. (4) `agent_actions.held_until` is written and read by nothing (backlog). (5) There is no universal approval boolean and none is proposed.

## 11. Campaign pressure test against #570

| case wanted | from the corpus | verdict under #570 §1 |
|---|---|---|
| multi-step, **not** a Campaign | "reactivate TikTok by cross-posting Reels; establish a consistent cadence" (30 wordings) | not a campaign: no reason to end, no aggregate outcome beyond a trajectory — a plan of recurring briefs |
| clearly **should** be a Campaign | none unforced in the corpus. Closest: R4's "proposals sent to six brands on 20 Sep" (purpose, managed scope, an outcome) — if given a reason to end (the Objective horizon, or "until replies") it meets the definition; the gorjana deal is the clear campaign but arrives by the **deal door**, not from a Recommendation | needs a synthetic case |
| single-major-deliverable activation that is still a Campaign | none in the corpus ("a hero video with contractual obligations, an approval chain and a measured result" — #570 §1) | needs a synthetic case |
| creative request straight to Studio, no Campaign | R4's "develop storytelling assets and impact case studies" (supporting materials, no lifecycle) — a brief, attachable later | fits #570 §1.1 row 5; today reachable only by the athlete in Studio; no Mila tool creates a brief |

**Minimum synthetic forcing cases for the next experiment (specified, not run):** (a) a Recommendation with a bounded activation and an explicit reason to end (a match-day series through the season, objective-linked) → expect `campaign` with purpose + `endsWith: objective_horizon`; (b) the same content intent without a finish → expect `specialized_plan`, and a `campaign` choice refused by the router; (c) a single hero deliverable under a contract with an approval chain → expect `campaign` by scope, not by count; (d) "make a post about the upcoming game" → expect a direct creative brief, no campaign, no plan; (e) the Northlight counter → `direct_action` + intent (control). Each read for HOW leakage under §3.

## 12. The Creative Intelligence seam — located, not designed

Canonical direction holds: `Campaign → CampaignSpec → BriefSeed (content deliverables only) → Studio`, exactly #570 §5 — and **the Recommendation never talks to Studio directly**: a `campaign`-shaped Recommendation enters through `CampaignOrigin`; a `specialized_plan` in the content domain enters through the planner, whose actions are brief seeds; a creative request from the athlete or Mila enters Studio's own door (`BriefInput`, the direction tools), which needs no Opportunity, Objective, Recommendation or Campaign — invariant 1 of #570, already true. Minimum input to Creative Intelligence: **from Campaign** — purpose (verbatim), `DeliverableIntent` (category, format, quantity, due), brand, constraints (verbatim, labelled), lineage; **from a Recommendation** — purpose, why, objective ids, subject, constraints — and **never** format, count, shot, copy or model; **from the athlete** — the brief itself, with the creative objective chosen by her. `AssetSpec` / `ShotSpec` / `EditSpec` remain below the brief and out of scope (#570 §9).

## 13. Confidence and the reliability backlog

**Confidence** — recorded, not solved: 46 of 46 gated Objective cohort proposals under 1.0.2/1.0.3/1.0.4 emitted HIGH; the 1.0.4 semantics are right and MEDIUM/LOW remains unobserved. Carried into uncertainty-sensitive Brain experiments; Objective not reopened.

| item | class |
|---|---|
| Recommendation persistence (table + caller for respond / authorizePrepare / recordExecution) | **semantic architecture blocker** for anything past this checkpoint — no governed object, no lineage |
| Brain run record (evidence-as-seen, like proposal sets) | semantic blocker for reconsideration and outcome attribution |
| Intelligence Request persistence | semantic blocker for the acquisition path in production; not for this checkpoint |
| Campaign persistence (C1) | semantic blocker for the `campaign` shape only |
| `pending_actions.kind` one-element enum; `approved_at` = `executed_at` | production-mounting blocker for any non-reply direct action |
| `deal_deliverables` has no writer | production blocker for the deal door and for `deliverablesRecorded` meaning anything |
| concurrent acquisition completion (R8); non-transactional assertion/evidence updates (R9); per-run Objective-event idempotency (R10) | **production-hardening** |
| `agent_actions.held_until` unread; `deals.pending_action` jsonb dead | production hygiene |
| **R13 (new)**: strategic Recommendations name deliverables (deck, plan, workflow) — the Brain choosing artefacts | **semantic reliability** — the strategic twin of invariant 2; watch, and address at the next Brain bump with a "name the move, never the artefact" line |

## 14. Deliverables — index

1 corpus §1 · 2 persistence reality §2 · 3 lineage §2 · 4 WHAT/WHY §3 · 5 HOW leakage §3 · 6 work representations §4 · 7 Existing Work view §5 · 8 dedup §6 · 9 shape classification §7 · 10 Direct Action §7 · 11 Specialized Plan §7 · 12 Campaign boundary §11 · 13 counterexamples §7 · 14 path chooser §8 · 15 Action §9 · 16 approval map §10 · 17 Creative seam §12 · 18 direct-to-Studio §12 · 19 synthetic cases §11 · 20 blockers §13.

## 15. Not done

No provider call. No contract bump. No implementation, persistence or mounting. No Objective, Opportunity, Rate, Campaign, Creative Intelligence or Studio change. #570 untouched (one amendment *proposed*, §10). The Objective iteration remains closed; State → Opportunity → Objective frozen.

## 16. Accepted (27 Sep 2026)

Accepted as the Recommendation → Execution Path checkpoint; the findings advance. The five forcing cases are **not** run yet: before testing Direct Action / Specialized Plan / Campaign, the minimum durable substrate that execution attaches to is defined and the R13 WHAT/HOW boundary closed — `recommendation-substrate-checkpoint.md`. No Campaign, planner or execution implementation.
