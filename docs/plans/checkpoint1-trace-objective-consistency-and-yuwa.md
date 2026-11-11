# Checkpoint 1 trace — Objective modification consistency, and Yuwa "Work on it" → outreach planner

**Read-only trace, 27 Sep 2026.** Working tree `fix/checkpoint0-stabilize` @ `b5f4cc6c` (Brain stack tip + audit docs);
`origin/main` = `9fff9b15`. No code changed, no provider calls. Dev DB read with SELECT-only scripts (deleted).

Status labels: **MAIN** = file present on `origin/main` · **stack** = only on this branch/stack · **flag** = gated off ·
**deployed(dev)** = observed in dev rows.

What the athlete experiences, in one paragraph: Mia rewrote three Objectives in her own words. The words were kept,
but the line that says *how anyone would know it happened* (`success`) and the *by when* reason (`horizon.why`) still
carry Nomila's original wording. The Brain is shown both, is told it may not ground a move in her wording alone, and
reaches for the old Opportunity map — so she gets back Nomila's earlier idea. Separately, when she eventually taps
"Work on it" on the Yuwa Recommendation, nothing can happen: readiness says no planner owns `impact`, no route lets her
authorize, and the outreach planner that *could* take it has no caller.

---

## PART A — Objective modification consistency

### A1. The governance path for `modify`

| step | where | what it does | status |
|---|---|---|---|
| Surface | `client/screens/brand/ObjectivesReviewScreen.tsx:106-107` shows desiredState + "You'd know it happened when: {success.observableCondition}"; `:152-158` shows horizon | The proposal card shows success and horizon. | MAIN |
| Modify sheet | `ObjectivesReviewScreen.tsx:192-199, 237-251, 260-266` | Only two inputs: "The outcome, in your words" (desiredState) and "By when" (period pills + why). **No success field.** Save sends `desiredState` if changed and `horizon` if changed; nothing else. The success line is not shown inside the sheet at all. | MAIN |
| Hook | `client/hooks/use-objectives.ts:61` | `Decision` modify = `{ desiredState?, horizon?, said? }`. The sheet never sends `said` for modify. | MAIN |
| Route | `server/routes/objectives.ts:59-83` | Validates action; passes `desiredState` (77) and `horizon` (78). No `success` input exists. | MAIN, deployed(dev) |
| Pure transition | `server/services/intelligence/objective/entity.ts:210-235` | modify requires wording or horizon change; writes `desiredState` as a `MeasuredValue` owned by `athlete_intelligence`, sets `modifiedFrom`, optional `horizon`; `disposition: modified`, `lifecycle: active`. **Does not touch `success`, `currentState`, `domain`, `provenance`, `lineage`.** | MAIN |
| Fold | `entity.ts:314-326` | Re-applies `delta.desiredState` / `delta.horizon` only. | MAIN |
| Contract | `server/services/intelligence/contracts/objectiveEntity.ts:108-111` | `success: ObjectiveSuccess` — "**Immutable.**" · `horizon` — "Mutable by the athlete through `modify`." · delta type `:174-176` has only `desiredState` / `horizon`. · decision `:235-238` modify carries only `desiredState` / `horizon`. | MAIN |
| Store write | `objective/store.ts:223-234` (`decide`) → `insertEvent` + `UPDATE objectives SET projection(o)`; `projection()` `:332-343` writes only mutable columns (`desired_state, horizon, disposition, lifecycle, modified_from, deferral, superseded_by, *_at`) | `success`, `current_state`, `provenance` columns are written once in `insertObjective` `:345-356` together with `created_snapshot`. | MAIN |
| Store read | `fromRow()` `store.ts:365-381` | Spreads `created_snapshot` and overlays only the mutable columns. **`success` and `currentState` are read from the snapshot, not from their columns** — even a future column update would be ignored by the reader. | MAIN |
| Brain render | `server/services/intelligence/brain/inputBlock.ts:17-32` (`renderObjectivesBlock`) | Per live Objective: `domain · origin · disposition · horizon.period` (**period only; `horizon.why` is not rendered**, `:15,25`); "desired state, in the athlete's words" (`:26`); "(Nomila's original proposal, superseded by her wording: …)" (`:27`); "current state, as proposed" (`:28`); "how anyone would know: {success.observableCondition}" (`:29`); "rests on openings: {lineage.opportunityKeys}" (`:30`). No evidence paths, no confidence. Unchanged vs main. | MAIN |
| Brain spec pressure | `brain/evalSpec.ts:170-172` | "A recommendation grounded only in the Objective's own wording is the Objective restated, and will be refused. Cite … a state fact, an opening …" — so the Brain *must* reach past her sentence, and the only openings on offer are the stale 1.0.0 map's. | stack (0.12.0-exp) |
| Planner render | `server/services/outreachPlannerOrchestrator.ts:79` | The outreach planner also receives `desired`, `current`, **`success`**, `horizon` — the inconsistency propagates into planning. | stack, flag off |

Net: of the five Objective lines the Brain sees for a modified Objective, **one is hers and four are Nomila's
pre-modification framing** (original proposal, current state, success, openings), plus a spec rule that forbids
grounding in her line alone.

#### Dev rows now (athlete `dc8f37f1-deff-43f8-8c02-e37a5cc20d4f`) — deployed(dev)

All three: `disposition=modified`, `lifecycle=active`, `from_proposal.specVersion=objective-eval-spec/1.0.1`, set
`5dd8bdcc…`, and `success`/`current_state` columns byte-equal to `created_snapshot` (checked in SQL: `success_eq=true`,
`cs_eq=true`). Every modify event has `said: null` and a delta with **only** `desiredState` — horizon was never touched.

**Positioning `c0f587e4-750f-4575-a4e8-fd4cfa6e078e`** — origin `joint`, domain `positioning`
- desiredState (MEASURED, athlete, 2026-09-25T01:31:48.404Z): *"Build my positioning at the intersection of athletics, technology, AI, innovation and entrepreneurship, and secure partnerships that align with that identity."*
- modifiedFrom: *"She is established as an active commercial partner or ambassador for brands in the STEM, EdTech, or tech venture sectors."*
- currentState (EVALUATED): *"Her commercial portfolio remains selective and focused, primarily featuring a sportswear brand and lifestyle gifting, with no active partnerships in her core academic or technology domains."*
- success: *"She has signed at least one brand partnership or ambassador role with a company in the EdTech, STEM, or tech venture sectors."*
- horizon: `next_12_months` — *"Developing outreach materials and establishing credibility with non-traditional corporate partners requires a longer, structured pipeline."*
- fromAthleteIntent: `preferences[onboarding_goal.get_my_first_deal]` · fromOpportunities: `grow-academic-tech-partnerships`
- currentStateEvidence: `findings[mia.brand_fit]`, `findings[mia.narrative_power]`, `commercialPosition.activeRelationships`, `findings[mia.commercial_proof]`
- later events: `spans_live` ×2 (sets `87c095ff`, `1916e5cc`; proposal `premium-academic-impact-partnerships`, 0.833, sibling `b1c799e3`)

**Audience `feb62891-8b9f-44e4-8c1f-677d6947334b`** — origin `joint`, domain `audience`
- desiredState (01:30:23.470Z): *"Grow my audience and build a stronger, more consistent presence across Instagram and TikTok."*
- modifiedFrom: *"Her social media audience is growing across both Instagram and TikTok, supported by active posting channels on both platforms."*
- currentState: *"Her social media audience is currently in a minor contraction phase with a cooling trajectory, with Instagram posting at less than once a week and TikTok being dormant for over 500 days."*
- success: *"Her TikTok account has been reactivated with recent content, and her audience trajectory on primary platforms is no longer classified as cooling."*
- horizon: `null`
- fromAthleteIntent: `preferences[onboarding_goal.grow_my_following]` · fromOpportunities: `grow-instagram-posting-cadence`, `unlock-tiktok-channel`
- later events: `reaffirmed_by_run` ×2 (proposal `active-cross-platform-audience-growth`, similarity 1; rationale "…reactivating TikTok will expand her digital reach…")

**Impact / Yuwa `b1c799e3-59fc-4986-b3ab-a0b7b4869601`** — origin `nomila`, domain `impact`
- desiredState (01:32:31.861Z): *"Expand the impact and visibility of my work with Yuwa through aligned global brand and CSR partnerships."*
- modifiedFrom: *"Her philanthropic leadership with the Yuwa girls empowerment program is a commercially active part of her identity, attracting global CSR sponsorships."*
- currentState: *"Her deep involvement with Yuwa is a key part of her personal narrative but has not yet been commercialized or translated into active CSR brand sponsorships."*
- success: *"She has secured a corporate partnership or global brand sponsorship that actively co-funds, co-promotes, or is structurally tied to her work with the Yuwa Academy."*
- horizon: `multi_year` — *"Building international philanthropic campaigns and aligning corporate CSR departments is a long-term strategic branding outcome."*
- fromAthleteIntent: `[]` · fromOpportunities: `amplify-yuwa-philanthropic-work`
- later events: `spans_live` ×2 (0.6, sibling `c0f587e4`)

Observation: the Brain's final Yuwa `why` — "*her work with Yuwa has not yet been commercialized*" — is the
`currentState` line nearly verbatim; the positioning `what` is the `success` + opening wording; the audience `what` is
the `unlock-tiktok-channel` opening + `success` (TikTok only).

### A2. Where semantic reconciliation can live without reopening Objective evaluator 1.0.4

**What exists and why none of it fits as-is**

- `objective/reconcile.ts` (`objective-reconciliation/2.0.0`, MAIN) runs only when a **new proposal set** is
  materialised (`store.ts:104-118`). Its own header forbids the job: reruns "cannot merge, split, reshape, replace,
  suppress or redefine athlete-governed live Objectives" (`reconcile.ts:12-15`). `spans_live`/`reaffirmed_by_run`/
  `re_surfaced` are relationships on the record, never edits. It also compares *wording* against both current and
  `modifiedFrom` (`:102-103`), and lineage is immutable (`objectiveEntity.ts:119-121`), so nothing there ever notices
  that her restatement moved away from `success`.
- Governance handlers: `applyDecision` (`entity.ts:194-275`) — no re-derivation of anything on modify; `validateObjective`
  V3 (`entity.ts:361`) only checks `modifiedFrom` exists.
- No re-derivation exists anywhere. The PR3b design explicitly chose **"Modify never re-runs the evaluator"**
  (`docs/architecture/commercial-intelligence/objectives-pr3b-design.md:52-55`, decision 2 at `:302`).

**What the contract already says about modify vs substance**

- `objectives-pr3b-design.md:57` — "She may change `desiredState` wording and `horizon`. She may not change `domain` or
  `success.quantified.statePath` under the same Objective: those change what the Objective *is*. Wanting that is
  decline + create (§3), or supersede (§6)."
- `objectives-pr3b-design.md:74-86` (§4 table) lists as immutable only `success.quantified.statePath, baseline` —
  **`success.observableCondition` is not listed either way.** The code is stricter than the design: the entity type
  marks the whole `success` immutable (`objectiveEntity.ts:108`), and `fromRow` reads it from the snapshot.
- `objectives-pr3b-design.md:145-149` (§6) — "Strategic meaning lives in `domain`, `desiredState`'s **substance**,
  `success` and `provenance`. When any of that changes, the answer is a **new Objective**… The athlete modifies beyond
  wording → decline + create, or explicit supersede from the review surface ('replace this with…')."
- `objectives-contract.md:45` — "If the reshaping is large enough to be a genuinely new, jointly authored outcome, the
  old objective is `superseded` and a new one is created with its own honest origin."

So the contract anticipated this case and assigned it to **supersession** — but the surface offers only "Change
wording", with no materiality check and no "replace this with…" door. Mia's positioning and audience edits are
substance changes that went through the wording door. `success`/`horizon` are **proposal-owned** fields (copied byte
for byte from the proposal, P2 at `pr3b-design.md:263`); `horizon` is athlete-mutable, `success` is not; neither is
derived from `desiredState` by any code.

**Options and the versioned specs each would touch**

| option | what it is | athlete authorship | versioned things touched | evaluator 1.0.4 |
|---|---|---|---|---|
| **G0 — use supersede as designed** | Surface gains "replace this with…" → `POST /me/objectives` with `replaces` (route `objectives.ts:85-101`, store `createAthleteObjective` `store.ts:204-219`) where she writes desiredState **and** observableCondition. | full | client only (+ an athlete prompt). No contract bump. | untouched |
| **G1 — "restate after modify" (governance only)** | The modify sheet shows `success` and `horizon.why` beside her new wording and asks per field: *still right* / *change* (her words). Modify may then carry `success.observableCondition` (never `quantified`). | full | **Objective entity contract** `objective/1.1.0 → 1.2.0` (`objectiveEntity.ts`: `success.observableCondition` mutable via modify, `ObjectiveDelta.success`, `ObjectiveDecision.success`); `entity.ts` modify + fold; `store.ts` `projection()` + `fromRow()` (read success from column); route + hook + sheet; `objectives-pr3b-design.md` §2/§4/V3 amended; rebuild test (P3). No DB CHECK change (still action `modify`). | untouched |
| **G2 — governed repair draft (semantic)** | When a modify is material and she chooses "let Nomila redraft", a small provider call drafts `success` (+ `horizon.why`) *for her sentence*; she confirms or edits via the G1 modify path. | desiredState hers verbatim; drafted success is Nomila's until she confirms | Everything in G1 **plus a new versioned semantic spec**, e.g. `objective-restatement/0.1.0-exp` (prompt under digest, same apparatus as `objective/evalSpec.ts`), a materiality classifier inside it, and its own acceptance cases (A3). Needs the tap-to-send-style confirmation. If a new event action (`restated`) is chosen instead of reusing `modify`: `objective_events_action_check` (`shared/schema.ts:2908`) + migration + the hand-mirrored CHECK list in `deploy.yml`. | untouched |
| G3 — reopen the evaluator | re-run Objective evaluation seeded with her wording | Nomila becomes author of her goal | `objective-eval-spec` bump | **reopened** — rejected by the brief and by pr3b decision 2 |

A render-only mitigation also exists and touches **no** spec: `renderObjectivesBlock` is "Evidence, not methodology:
excluded from the canonical digest" (`brain/inputBlock.ts:1-2`). It could label `success`/`currentState` as
"Nomila's wording before her restatement — not re-confirmed by her" when `modifiedFrom` is present and success was not
re-reviewed, and render `horizon.why`. It changes Brain behaviour, so it needs an experiment arm, but no spec bump.

**Answer.** The fix belongs in **governance**, not reconciliation and not the evaluator:
1. G0 is available today with zero contract change and is the design's own answer for substance changes — but it
   loses lineage (athlete-created Objectives have `evidencePaths: []` and never match by lineage, `reconcile.ts:15`;
   `currentState` becomes null; origin becomes `athlete`), so a later evaluator run would treat the old ground as
   `new_with_history` against the superseded row. Acceptable as an interim for a severe case, not as the product path.
2. The product path is **G1 (entity-contract bump, no semantic spec)**: make `success.observableCondition`
   athlete-mutable through modify — which the design table already permits by omission — and make the modify sheet
   put success and horizon.why in front of her. This alone would have caught all three of Mia's edits.
3. **G2 requires a new versioned semantic contract** (`objective-restatement/0.1.0-exp`) only if Nomila is to *draft*
   the repaired success. It is additive to G1, and evaluator 1.0.4 stays closed.
4. Independently: the Brain render change (digest-excluded) for already-modified rows that nobody re-confirms.

### A3. Pressure-test cases (DRAFT — not implemented, nothing written)

Dependent fields: `success.observableCondition`, `horizon` (period + why), `currentState` (immutable evaluator reading),
`domain`, `lineage.opportunityKeys` (immutable). "Material" = the edited desiredState names a scope, sector, channel or
end that the dependent field contradicts or omits.

| case | example | materially affected | expected behaviour |
|---|---|---|---|
| (i) semantic expansion | positioning: "STEM/EdTech/tech venture ambassador" → "athletics, technology, AI, innovation and entrepreneurship … partnerships that align with that identity" | **success** (names EdTech/STEM/tech venture; omits AI, innovation, entrepreneurship; frames "ambassador role" only). horizon.why — not contradicted. domain — *possibly*: "entrepreneurship" can mean `owned_venture`; ask, don't infer. currentState — still true. | Modify blocked from silently saving: sheet shows success, flags "your wording goes beyond this". Choices: edit success (G1), let Nomila draft (G2), or "this is a different goal" → supersede (G0). If she signals a venture of her own → supersede into `owned_venture`. |
| (ii) scope expansion | audience: success TikTok-only → her wording "Instagram and TikTok" | **success** (Instagram absent). horizon null — unaffected. currentState — still true (names both). | Same as (i): success must be re-confirmed; a success that measures only half her scope is not allowed to stand unreviewed. |
| (iii) framing change, no scope change | Yuwa: "commercially active … attracting CSR sponsorships" → "Expand the impact and visibility of my work with Yuwa through aligned global brand and CSR partnerships" | success (partnership tied to Yuwa) still measures the **means** she names; it does not measure impact/visibility (the **end**). currentState "not yet been commercialized" is framing she moved away from, but factual. horizon — unaffected. | Soft prompt, not a block: "Your wording leads with impact and visibility — should success say how you'd see that?" Keep-as-is is a valid, recorded answer. Brain render should mark currentState as Nomila's reading. |
| (iv) non-material wording | first-person rewrite ("Her audience is growing…" → "My audience is growing…"), typo fix | none | No prompt, no nag. Save as today. A materiality check that fires here is a false positive and a test failure. |

A deterministic pre-check can be a *hint* (new scope nouns in `to` absent from success: platforms, sectors, named
orgs; nouns success depends on removed from `to`) — on Mia's rows it flags (i) {AI, innovation, entrepreneurship} and
(ii) {Instagram}, soft-flags (iii) {impact, visibility}, and nothing on (iv). Her confirmation is authoritative;
the check never edits.

#### Mia's two Objectives in three states

**Positioning (`c0f587e4`)**

| field | 1 · proposal (1.0.1) | 2 · after her edit, before repair (dev now) | 3 · after governed repair — **DRAFT, not written anywhere** |
|---|---|---|---|
| desiredState | She is established as an active commercial partner or ambassador for brands in the STEM, EdTech, or tech venture sectors. | Build my positioning at the intersection of athletics, technology, AI, innovation and entrepreneurship, and secure partnerships that align with that identity. | *(unchanged — hers)* |
| success | She has signed at least one brand partnership or ambassador role with a company in the EdTech, STEM, or tech venture sectors. | *(same as 1)* | **DRAFT:** She has signed at least one partnership, ambassador or advisory role with a company or programme in technology, AI or entrepreneurship that presents her as an athlete at that intersection — not only as a sports endorser. *(Must not name StartX1: deferred by her.)* |
| horizon | next_12_months — Developing outreach materials and establishing credibility with non-traditional corporate partners requires a longer, structured pipeline. | *(same as 1)* | **DRAFT:** next_12_months — Building a recognised position across athletics, AI and entrepreneurship takes a sequence of visible partnerships; twelve months allows the first signed one and the positioning around it. |
| open question for her | — | — | "Does *entrepreneurship* here include founding something of your own?" (yes → supersede into `owned_venture`) |

**Audience (`feb62891`)**

| field | 1 · proposal (1.0.1) | 2 · after her edit, before repair (dev now) | 3 · after governed repair — **DRAFT, not written anywhere** |
|---|---|---|---|
| desiredState | Her social media audience is growing across both Instagram and TikTok, supported by active posting channels on both platforms. | Grow my audience and build a stronger, more consistent presence across Instagram and TikTok. | *(unchanged — hers)* |
| success | Her TikTok account has been reactivated with recent content, and her audience trajectory on primary platforms is no longer classified as cooling. | *(same as 1)* | **DRAFT:** Both her Instagram and her TikTok show recent posts on a regular cadence she has chosen (neither channel dormant), and her audience trajectory is no longer classified as cooling. |
| horizon | null | null | **DRAFT:** null (she chose none; not materially affected). Optionally offered: this_season — "a consistent presence is judged over a season of matches". |

(Yuwa, for completeness, needs no mandatory repair under (iii); optional DRAFT success: *She has secured a partnership
that co-funds, co-promotes or is structurally tied to her work with Yuwa, and that work is publicly visible through
it.*)

### A4. An ephemeral coherent reconstruction for a Brain experiment (no writes to her rows)

`buildLiveBrainInputs` (`server/services/brainInputsBuilder.ts:71-116`, stack) options (`:31-47`):
`objectiveOverlay` **only appends** (`:80`, `live.push({...o, controlled: true})`) — it cannot replace a live
Objective, so overlaying a repaired copy would render her Objective **twice** (original + repaired). There is **no map
override**: `latestMap()` (`:59-63`) takes the newest `objective_proposal_sets.opportunity_map`. On dev all three sets
(`5dd8bdcc`, `87c095ff`, `1916e5cc`) carry the same `opportunity-eval-spec/1.0.0` map, asOf 2026-09-23T18:06:58, 6
openings (deployed(dev)).

Assembly (caller-side, no builder change needed):
1. `const full = await buildLiveBrainInputs(db, { athleteId, variant: "V3", context, includePersistedExecution: true })`.
2. Replace by id in `full.inputs.live`: `c0f587e4` and `feb62891` (and optionally `b1c799e3`) with in-memory copies
   whose `success` (and `horizon`) are the A3 DRAFT values; mark `controlled: true`; keep ids so citations resolve.
3. Map: set `full.inputs.map = null` for the primary arm (no stale openings; the Brain must ground in State/work/
   context), and strip `lineage.opportunityKeys` on the copies so `renderObjectivesBlock:30` does not advertise
   openings that are not rendered. **Do not** substitute `opportunity-1.2.0-forcing/Mia_Bhuta.json` as "fresh": it has
   no Yuwa opening (impact note: "state lacks specific targets"), and its positioning opening rests on the StartX1
   inbound she deferred — it would import a governed exclusion. Use it only as a labelled comparison arm.
4. Evaluate with `evaluateBrain(gateForVariant(full, "V3"), "V3")` (`brainExperimentOrchestrator.ts:63`) into an
   **ephemeral** store (the durable-loop script's ephemeral path), never `persistRunDecisions` on dev.
5. Arms: A0 current rows (control) · A1 repaired success only · A2 repaired + map null · A3 repaired + render-label
   change. Record every override as CONTROLLED; count whether the `what` carries AI/innovation/entrepreneurship and
   Instagram.

---

## PART B — Yuwa "Work on it" → outreach planner

Founder decision (taken): Objective domain ≠ planner domain; Yuwa routes to **OUTREACH with impact context**; no impact
planner.

### B1. Trace as it stands

| hop | evidence | status |
|---|---|---|
| Objective | `b1c799e3…`, domain `impact`, live (A1). | deployed(dev) |
| Recommendation | `rec_2507ecb0723f9dd8`, run `f9e00c6f…` (`brain-eval-spec/0.12.0-exp`, V3), subject `objective[b1c799e3…]`, `executionPath=specialized_plan`, what: *"Target global brand and corporate social responsibility partnerships that align with her philanthropic leadership at the Yuwa girls empowerment program."*, notSeen: "Specific CSR contact list", "Yuwa academy's own corporate sponsorship guidelines". `response={state:none}`, `authz={state:none}`, `execution={state:none, refs:[]}`, one event `created` by system. | deployed(dev) |
| Router domain | `plannerDomainFor` `brain/executionRouter.ts:90-96`: `impact → "impact"` (`positioning → "outreach"`, `audience → "content"`). | stack |
| Readiness | `executionReadiness.ts:62-66`: outreach planner mounted with `domains: ["outreach","commercial"]` → for `impact` `:90-91` returns `unavailable`, `capability[planner:impact]`. Test pins it: `executionReadiness.test.ts:45`. | stack |
| Planner mapping (already says outreach) | `planner/contract.ts:17-24` `plannerFor`: `outreach, positioning, impact, relationships → "outreach"`; `content → "content"`; **`commercial → null`**. So readiness and the planner contract **disagree twice**: impact (planner says outreach, readiness says nobody) and commercial (readiness says outreach, planner says nobody). | stack |
| Router handoff | `route()` `executionRouter.ts:102-138`: refuses unless `authorization.state === "prepare_authorized"` (`:105`); dedup (`:108-114`); `specialized_plan` → `PlannerHandoff{domain:"impact", what, why, subject, objectiveIds, notSeen, runId}` (`:124-128`). | stack |
| Durable loop | `routeGoverned` `server/services/brainLoopDurable.ts:88-103`: routes, and **acts only on `campaign`** (`:93`); a `specialized_plan` result is returned and dropped. | stack |
| Authorization | `respondToRecommendation` / `authorizeRecommendationPrepare` `brain/substrate.ts:98-101` exist; **no HTTP route** calls them (no `server/routes/*recommend*`); only scripts, labelled SIMULATED (`scripts/intelligence/brainLoopDurable.ts:102-103`, `brainRoute.ts:48-49`). | stack |
| Outreach planner | `prepareOutreach` `outreachPlannerOrchestrator.ts:56-92`: throws unless `OUTREACH_PLANNER_ENABLED=true` (`:29,57`); requires `shape === specialized_plan` but **never checks `plannerFor(handoff.domain) === "outreach"`** (`:58`); idempotency (`:63-64`); exclusions built with **`ledger: null`** (`:68`) — confirmed: so declined/deferred *Recommendations* are never excluded (`planner/exclusions.ts:71-75` iterates `input.ledger?.records ?? []`); deferred/declined *Objectives* are (`:69-70`). Inputs (`:32-42`): handoff, live/deferred/declined, work, `StateNames`, and the run's rendered `stateBlock`/`workBlock`. **Callers: none** outside its test (`outreachPlannerOrchestrator.test.ts`). | stack, flag off |
| Gates | `validatePlanningResult` `planner/evalSpec.ts:149-186`: version, id, planner kind, result; SENDS regex (`:143`) forbids a sending step with gate `none` (`:175`); outreach: exclusions + ownership (`:179-182`). Gates vocabulary `planner/contract.ts:26`: `none · athlete_approval · tap_to_send · spend`. | stack |
| Persistence | `outreach_plans` (`shared/schema.ts:2950-2972`; statuses `prepared·reviewed·complete·attached·escalated·refused·superseded`, one active per Recommendation). Store: `insertOutreachPlan`, `markOutreachReviewed`, `markOutreachPlanningComplete`, `supersedeOutreachPlan` (`planner/outreach/store.ts:20-52`). Execution ref helper `outreachPlanRef` (`outreach/contract.ts:49`) — **never recorded on the Recommendation** by the orchestrator. Dev: **0 rows**. | stack, deployed(dev) table |
| Durable actions | `pending_actions_kind_check = (kind = 'send_reply')` (dev constraint read) and `send_reply` requires `thread_id` (`schema.ts:2454+`). `tasks_type_check` has no outreach type (`schema.ts:662`). **No store can hold a planned outreach step.** | deployed(dev) |
| Outbound | `sendThreadReply` refuses with no inbound message (`services/threadReply.ts:74-78`); `sendGmailReply` needs a `gmailThreadId` (`lib/integrations/gmail.ts:553-561`); `sendGate.ts` is reply-only by design. The only thread-less outbound primitive is **`upsertGmailDraft` with `gmailThreadId: null`** (`gmail.ts:687-697`) — a draft in her Gmail, not a send. No LinkedIn integration. | MAIN |

**Case A as evidence of expected output** (`docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/shape/planner/A/A.json`):
fed `rec_9feaeb54fb19c6b1` (R15, 0.10.0 — *not* the live rec), handoff `domain: "impact"` → planner `outreach`,
`planner-eval-spec/0.1.0-exp`. Parsed: `result: planned`; target classes "Global Sports & Athletic Brands"
(candidates: **Adidas** — her existing NIL relationship, not in Deals so not an in-motion counterpart), "Education
Technology & Youth Development Corporations", "Multinational Technology & Consulting Firms with South Asian
Initiatives"; research: CSR budgets (external), Yuwa's funding needs (athlete), NIL/CSR compliance (connected);
sequence 1 research (`none`) → 2 coordinate with Mia and Yuwa leadership (`none`) → 3 commission pitch deck (`none`) →
4 present targets + deck (**`athlete_approval`**) → 5 draft email templates + LinkedIn sequences (`none`) → 6 initiate
outreach (**`tap_to_send`**). **Correction to the audit's framing:** under its own 0.1.0 gate this reply was
**refused** (`A.json.problems`: steps 3 and 5 matched SENDS with gate `none`; `result: null`, `projection: null`). The
`A.regated.json` re-gate at 0.2.0 leaves only `version planner-eval-spec/0.1.0-exp` — i.e. the *shape* passes today's
gates (the SENDS regex now exempts "pitch deck"), but no accepted plan for Yuwa has ever been produced at the current
spec. Also: Case A saw `ledger: null` and an older Recommendation.

### B2. Minimal changes to make "Work on it" real (in order)

1. **Readiness/domain mapping** (stack, `executionReadiness.ts:62-66`): derive the outreach planner's `domains` from
   `plannerFor` instead of a literal — `["outreach","positioning","impact","relationships"]` — and drop `commercial`
   (planner contract says none). Keep `plannerDomainFor` returning `impact` so the handoff carries impact context
   (`handoff.domain: "impact"`, rendered at `planner/evalSpec.ts:95`). Update `executionReadiness.test.ts:45`
   (impact → outreach planner, `flag[OUTREACH_PLANNER_ENABLED]`). No spec version touched (readiness is unversioned,
   derived, "never stored").
2. **Planner domain guard** (`outreachPlannerOrchestrator.ts:58`): refuse unless `plannerFor(handoff.domain) ===
   "outreach"`, so a content handoff can never reach it.
3. **Pass the ledger** (`:68`): add `ledger` to `OutreachPlannerInputs` and pass `loadLedger(db, athleteId)`
   (`brain/substrate.ts`) so declined/deferred Recommendations are excluded. Changes the exclusions content and
   therefore `contextSha256`, not the planner digest.
4. **Athlete authorization route** (new, stack): `POST /me/recommendations/:id/response` and
   `POST /me/recommendations/:id/prepare` → `respondToRecommendation` + `authorizeRecommendationPrepare`
   (`substrate.ts:98-101`), `requireAuth`, actor from `req.userId` as `routes/objectives.ts:37-40` does. "Work on it" =
   accept + authorize, offered only when `mayOfferPrepareAuthorization` (`executionReadiness.ts:117-119`) is true.
5. **Caller** (`brainLoopDurable.ts:88-103`): add a `specialized_plan` branch — if `plannerFor(handoff.domain) ===
   "outreach"` and the flag is on, assemble `OutreachPlannerInputs` from canonical stores: live/deferred/declined
   (`objective/store.ts`), work (`existingWorkForRun`, `:76`), `StateNames` (`buildAthleteState`), and
   `rendered.stateBlock/workBlock` from `brain_runs.record.rendered` for `handoff.runId` (dev run `f9e00c6f…` has
   `record.rendered` — verified). Call `prepareOutreach` **outside** a transaction (provider call), then insert the
   plan and `recordRecommendationExecution(…, outreachPlanRef(plan))` **in one transaction**, mirroring the campaign
   branch (`:97-101`). This needs `prepareOutreach` split into *plan* and *persist* (today it persists internally,
   `:71,90`), otherwise the execution ref is written in a second, non-atomic step.
6. **Flag** `OUTREACH_PLANNER_ENABLED=true` on dev only, via `gcp/cloud-run-v2.yaml` (hand-set vars are wiped each
   deploy). Prod untouched.
7. **Presentation**: `GET /me/outreach-plans` (`activeOutreachPlans`, `outreach/store.ts:25`) + a read surface for
   target classes, research questions (the `athlete`-sourced ones become questions to her — e.g. "What does Yuwa
   actually need?"), sequence with gates, materials, omitted.
8. **Athlete approval**: `POST /me/outreach-plans/:id/reviewed` → `markOutreachReviewed` (`outreach/store.ts:39`) is
   the only approval that exists — a scope approval, not per-step. Step 4 (`athlete_approval`) can map to it for v1.

**What remains missing for actual sending** (not minimal; each is its own design):
- a durable per-step action store: `pending_actions` is `send_reply`-only with `thread_id` required — a new kind (e.g.
  `send_outreach`) needs a migration and the `deploy.yml` hand-mirrored CHECK list;
- recipients: no CSR contact data exists (the Brain's own notSeen); needs research or her input;
- an outbound path: no thread-less send exists; the honest v1 last mile is `upsertGmailDraft(gmailThreadId: null)`
  (tap-to-send rule preserved — she sends from Gmail); `gmail.send` is a restricted scope (`gmail.ts:36-45`);
- the pitch-deck commission: Creative boundary refuses written deliverables (`creative-intent-forcing.md` Case 1); no
  Studio executor for a deck;
- LinkedIn: no integration.

### B3. Status summary for Part B

Everything on the Yuwa path after the Recommendation row is **stack-only**, and the planner is **flag-off with no
caller**; the dev DB has the tables (`recommendations`, `outreach_plans`) but 0 plans, 0 campaigns, and her three
Recommendations are ungoverned (`response` and `authz` both `none`).
