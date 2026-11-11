# Brain reliability backlog

Recurring behaviours observed across the experimental Brain runs that are **not** semantic boundary questions and are deliberately not tuned into a boundary experiment. Each is returned to on its own, with its own design. Ordered by how often it has recurred.

| # | item | occurrences | status |
|---|---|---|---|
| **R1** | **StartX1 declared `CONDITION_APPEARS_RESOLVED` on unchanged evidence.** The deferred Objective's information condition ("when u know more about this") is declared resolved on the strength of three *detected* inbound signals — contact, not information. The spec says the observation "changes nothing", and the invariant that Brain judgment alone must never satisfy an information condition is recorded (1B.3); the flip keeps recurring. | **5** — 1B.3 D1 · 1C K2 · #623 A1 · #623 A2 · 0.6.0 S1 | **addressed generically in 0.8.1-exp** (brain-r1-information-resolution-checkpoint.md): a Gate-2 rule requiring responsive, attributable evidence (a RESEARCH entry requested for that Objective) for any `CONDITION_APPEARS_RESOLVED` on an information deferral; four of five refused offline by the rule, the fifth (a set Gate 1 had already refused on identifiers) refused once its id is read plain; no StartX1-specific rule. Open until exercised live (the positive and negative cases on one call, when approved). |
| R2 | Identifier formatting refusals (`objective_id: "objective[<id>]"`). | 10 of 18 sets through #625 | **resolved** by the 0.5.0 response schema: 0 of 5 under 0.6.0. |
| R3 | Conditional fields omitted under the response schema (`execution_path`, `relation_to_existing_work`, `source_class`). | 2 of 5 under 0.6.0 (G1, C2) | **addressed** in 0.6.1: one schema branch per decision value with that branch's fields required; confirmed offline against the recorded replies. Live confirmation pending. |
| R4 | The schedule-gap-to-capacity conversion ("a 19-day gap … provides capacity"). Context is evidence about the schedule, not about availability; the spec says so. | recurring on standing audience/Yuwa decisions since experiment 1 | logged; not tuned. A Context Intelligence item (#608), not a Brain-contract one. |
| R5 | A production verb opening a standing RECOMMEND's `what` ("Design a … plan"). | occasional (0.6.0 S0) | the Gate-1 rule works as intended; no change. |
| R6 | A REQUEST_INTELLIGENCE proposition that presumes its answer ("…that exceeds her floor"). | R5, S5, B0, 0.6.0 S1 | logged; a wording discipline, not a contract change. |
| R7 | Zero-record counts read as zero things ("0 deliverables … completed"). | #625 G1 | **resolved** by the 0.5.0 rendering change; read correctly in 0.6.0 G0/G1. |
| **R8** | **Workflow completion is not concurrency-safe.** `completeStep` (`server/workflow/runner.ts:441-470`) is read waiting → `complete()` → write done, with no row lock, no transaction, no conditional status update and no unique index on `(run_id, step)`; two concurrent completions can both run `complete()` and create two assertions. Runner-wide: onboarding `greet` and `intelligence_acquisition` alike. | found in the acquisition-seam trace (27 Sep); serial duplicates are safe (`alreadyDone`) | **engineering reliability backlog** — not to be fixed inside the Brain architecture work unless it blocks a seam |
| R9 | Pressures recorded at the acquisition seam, none blocking: request obsolescence does not automatically cancel its workflow run (admin `cancelRun` only); `athlete_asserted.source` names the interaction door, not the acquisition purpose (`run_id` carries it); `created_at` is the only evidence time; `recordAssertions` is non-transactional (five awaits); no Intelligence Request table (ledger is a harness file). | 27 Sep | logged |
| R10 | No per-run idempotency on `objective_events`: `insertEvent` is an unconditional insert; a re-surface repeats only because the row is no longer `deferred` (behavioural guard) and the request is attributed once. | evidence→reconsideration checkpoint (27 Sep) | reliability pressure; no new idempotency system yet |
| R11 | Citation precision: an Opportunity cited `commercialPosition.inbound` as a bare collection (no index); the grammar resolves the collection as existing — honest but coarse. | 1.2.0 forcing call (27 Sep) | grounding precision pressure; not reopened from one occurrence |
| R12 | **Opportunity feasibility must not become an execution recommendation.** A feasibility claim prescribed the next execution step ("reply to the existing StartX1 inbounds"); Opportunity = what strategic condition exists, Brain = what Nomila should do now. Seen at the 1.1.0 treatment (`grow-negotiation-pipeline`) and the 1.2.0 forcing call. | 2 occurrences | semantic reliability backlog; watch for recurrence; 1.2.0 not amended |
| **R13** | **Strategic Recommendations name the execution artefact** ("develop a pitch deck", "a cross-posting plan", "a storytelling outline"): 12 of 16 current-era `specialized_plan` Recommendations choose the planner's artefact or mechanism. The strategic twin of invariant 2. | #647 corpus audit; the 100-RECOMMEND scan | **semantic** — closed at contract level by the candidate invariant THE ARTEFACT IS NOT YOURS (`recommendation-substrate-checkpoint.md` §7), to be applied by ceremony at the next Brain bump and verified by rerun |
| R14 | Subject identity across inbox threads: one brand deal on several threads mints several deal ids (cross-thread grouping unbuilt; `deal_group_id` set by a script) → several subjects → several Decisions and Recommendations for one negotiation. Inherited by the Existing Work view. | Deals audit; substrate checkpoint §3 | semantic blocker for commercial direct actions in production; not for the substrate |

## R15 — plan-shaped `what` names artefacts after R13
Forcing experiment (`docs/audits/recommendation-execution-shape-forcing.md`, #649): 4/4 specialized_plan Recommendations name a deck, proposal, partner list or outreach plan under `brain-eval-spec/0.9.0-exp` (THE ARTEFACT IS NOT YOURS present). The ownership test in prose did not bind on the plan shape; campaign and direct_action `what`s were clean. Candidate closure: typed move on `what` (schema ceremony) or one added spec line tested by a single forcing run.

## R16 — execution shape unstable across runs for one Objective
Same Objective, three runs: specialized_plan, direct_action, specialized_plan. The router refused the mis-shape; stability is not established, and only the router stands between a shape flip and a duplicate record.

## R17 — carrier for the campaign's "reason to end"
#570 invariant 2 is recovered from prose by the router's reader, which missed "through the end of the season" once. Decide: typed `ends_with` on the campaign shape, or an athlete assertion at the Campaign door. Blocks any Campaign door.

## R11 (extended by #649)
Work items of every kind are cited as `deal[…]`; the ExecutionIntent `why` prose can carry amounts that `seamCarriesNoAmount` (structural) cannot see.

## R15 — CLOSED (semantic) at brain-eval-spec/0.10.0-exp
One shape-specific block (FOR SPECIALIZED_PLAN, NAME THE STRATEGIC MOVE…) on the identical C23 input: 0/2 artefact nouns (was 2/2), shapes unchanged, no vagueness. Per-shape closure; direct_action mechanic leak remains. `docs/audits/brain-0.10.0-exp-r15-r17-checkpoint.md`.

## R17 — carrier decided (design only)
Typed `ends {source, ref}` on the campaign-shaped RECOMMEND, Brain names the source never the end; router resolves the reference and refuses; Brain-defined conditions not admitted. Needs a Recommendation ceremony + a small #570 amendment (endsRef, optional deliverables at origin, three-act approval).

## R17 — CLOSED (carrier implemented) at brain-eval-spec/0.11.0-exp · recommendation/0.2.0-exp · execution-router/0.2.0-exp
Typed `ends {source, ref}` on the campaign shape; structural gate iff campaign; grounding by kind; router resolves against the Objective horizon / deal term / athlete assertion and refuses; prose reader retired. #570 corrections recorded in `campaign-slice-design-amendment-1.md` (not applied to the control branch).

## Planner-boundary watch item (from #650)
Brain names the strategic move; the planner owns targeting, sequencing, channels, artefacts, cadence, dependencies, resourcing and completion unless one is the Decision's subject. A residual noun in `what` is non-binding on the planner. Watch, no gate.

## P1–P5 — from the Specialized Plan forcing experiment (`docs/audits/specialized-plan-forcing.md`)
P1 planner context must carry deferred/declined subjects by reference (an outreach plan targeted a deferred counterpart). P2 counterpart already in motion is Existing Work for the outreach planner — hand to Deals. P3 Creative Intelligence edge can be crossed in prose inside a content step; draw it as a contract before a content planner. P4 additive reference kinds `planning_result` / `studio_plan` for Existing Work. P5 a residual mechanic in `what` binds planners in practice — confirms the Brain-side watch item.

## P1–P3 — CLOSED (outreach preconditions, `outreach-planner-checkpoint.md`)
P1 governed exclusions by reference (`planner-exclusions/0.1.0-exp`), StartX1 control refused offline; P2 counterpart-in-motion ownership rule, Deals' verbs refused whatever the gate; P3 typed `Commission` — the creative solution has no field. P4 partly: `outreach_plan` reference kind added (`existing-work/0.6.0-exp`); `studio_plan` waits for the content planner. P5 stands (Brain-side).

## R11 (extended again)
Indexed state paths (`commercialPosition.inbound[n]`) drift across state rebuilds: the deferred StartX1 Objective's cited indices pointed at other counterparties by the time of the run. Canonical-name resolution covered it; a stable evidence locator would remove the need.

## Seam findings (campaign-creative-seam-checkpoint.md)
S1 `BriefOrigin` has no `athlete` value (her own ask is `system`). S2 no FK from `generation_jobs`/previews to `studio_plans` — the intent id on the job closes the chain. S3 `idea` campaign state has no writer from the router door. S4 a Campaign's non-creative work has no planner entry (tracked as obligations only, per #570). S5 #570 Amendment 2 proposed: retire `BriefSeed` for `CreativeIntent`.

## Creative seam findings (creative-intent-forcing.md)
C1 `CreativeIntent` carries no lifecycle `status` — derived downstream; only `withdrawnAt`. C2 `written`/`other` commissions have no Studio executor (adapter refuses). C3 no campaign-scoped BriefProposal persistence; the shared carrier reuse is the mechanism, `shared_from_plan_id` the smallest later reference. C4 `studio_plan_id` on jobs not needed — `campaign.planId` rides the frozen brief. C5 athlete-ask format detection is whole-word ("post-game"); confirmation must be able to fix `format.class`. S5 #570 Amendment 2 applied.

## Creative slice follow-ups (#657 accepted) — recorded, not solved
F1 `studio_plans.confirm` duplicates confirmation now authoritative on `creative_interpretations`. F2 no server-side Context reader supplies the athlete moment (`ask.moment` is null). F3 `proposeCampaign` is Creative Intelligence interpretation under a historical name. F4 written/other creative work has no executor (422 at the preview path).

## Campaign source findings (`campaign-source.md` §13) — #570 Amendment 3 candidates
K1 deliverable identity must span spec versions (implemented as introduced/superseded versions). K2 no completion criterion for non-deal content deliverables — fulfilment is reported under each candidate criterion, never written. K3 `idea` has no writer from the router. K4 fate of work under dropped scope: unproduced intents withdrawn, in-production left to Studio. Also: the Recommendation ledger's `execution.refs += campaign:<id>` is isolated (`executionRefFor`) until the ledger mounts.

## K1–K4 — CLOSED by #570 Amendment 3 (`campaign-closed-loop.md` §1)
Deliverable identity spans versions; `completesWhen` declared at introduction and the only closer; `idea` removed, `active` derived; dropped scope supersedes and withdraws unproduced intents only.

## Closed-loop observations (campaign-closed-loop.md §8)
L1 the campaign-shaped `what` named channels ("across her Instagram and TikTok channels") — the R13 residual on the campaign shape. L2 the Brain called a `planning` campaign with an empty draft scope "active … fully covering" in its NO_ACTION rationale — the projection carried the true state; a Brain-side reading discipline to watch.

## R18 — Campaign-shape residual of R13 (watch, not patched)
The campaign-shaped `what` named channels ("across her Instagram and TikTok channels"). Controlling principle: the Brain may define the strategic activation; Campaign planning and Creative Intelligence own downstream channel and execution decisions unless the channel is itself strategically constitutive of the Decision. Watch on the next Campaign exercise.

## R19 — lifecycle wording in Brain rationale (watch)
The Brain called a `planning` campaign with an empty draft scope "active … fully covering". The Existing Work projection is authoritative and was correct. Future Brain guidance should prefer the lifecycle terms actually rendered in Existing Work over synonyms. No lifecycle change.

## M1–M4 — Measure/Learn gaps found by the outcome inventory (`campaign-lifecycle-close-and-measure-checkpoint.md` §7)
M1 no join between a published Studio asset and its ingested metric observations (publish writes permalink/ig_media_id; observations are keyed by the ingested platform id) — the first thing to build. M2 `MeasuredOutcome` / `adoption` / `CalibrationPair` exist as contracts with zero writers; `Recommendation.outcome` now has a writer (`recordOutcome`) and no production caller. M3 no per-post or per-campaign baseline; the only baseline is `ObjectiveSuccess.quantified.baseline`. M4 `confirmExternally` discards who confirmed and when — an external confirmation is itself an outcome observation and belongs in the Measure design.

## M1, M4 — CLOSED (`outcome-attribution-forcing.md`)
M1 publish → observation join built (`published_asset_identities`, platform-media-id precedence, permalink only when unique, nothing copied). M4 external confirmation keeps actor, time and reference.

## O1 — `LedgerSubjectType` is too narrow for outcomes (proposed contract change)
Four of six outcome subjects the forcing cases produced are not expressible (creative intent, campaign deliverable, campaign). Proposal: align `LedgerSubjectType` on the Brain's `SUBJECT_KINDS` plus `thread`, `campaign_deliverable`, `creative_intent`. Nothing else about `MeasuredOutcome` changes.

## O2 — evidence class: one written rule, no new field
Recoverable from `source_class` for observation sources; for domain-state sources (deal, payment, campaign confirmation, publish record) the class is the reader's rule. Write the rule table once instead of adding a field to every outcome.

## O3 — adoption is `unknown` in production
`adoptionFor` cannot resolve a named Recommendation without the ledger, which is still the harness's file ledger. The cheapest argument for the substrate.

## O4 — two empirical dependencies before outcomes run for real
Identities fill only at publish time (a backfill from existing `studio_publish_jobs.ig_media_id` is available and needs a named command); and ingest must observe the published post for any metric to exist.

## O1, O2, O3 — CLOSED (`brain-substrate-mounted.md`)
O1 one subject vocabulary in `contracts/subjects.ts`, re-exported by the Brain and widened onto by the ledger; no second taxonomy, no migration needed (the column has no CHECK). O2 evidence class frozen as derived with the source→class rule written down once. O3 adoption now derives all four values from durable records; `unknown` is reserved for real ambiguity.

## S1 — the substrate has no production caller yet
`brain_runs`, `recommendations` and `recommendation_events` are mounted with a thin store and tests; the harness scripts still read and write the file ledger, and the campaign origin writer's execution-ref write stays isolated behind `executionRefFor`. Wiring a caller is the next reviewed step.

## O4 (restated) — one empirical unknown remains for Measure
Ingest observing a Studio-published post has never been exercised end to end. Publication identity now exists as a mechanism (0075) and the backfill is available and unexecuted.

## S1 — CLOSED (`durable-brain-loop.md`)
One controlled path now runs BrainRun → Recommendation → governance → router → Campaign → Existing Work → later run → reconsideration → outcome → adoption → eligibility entirely through durable records, behind BRAIN_SUBSTRATE_LOOP (off). The audit JSON is exported from the database (`brain/ledgerExport.ts`); the file-ledger scripts are classified historical audit fixtures and nothing dual-writes.

## L1 — campaign creation and its execution ref are two writes, not one transaction
Deliberate ordering (a campaign without its ref is recoverable; a ref to a missing campaign is not). One transaction would be an improvement when a route calls it.

## L2 — the durable script is artifact-seeded
Its inputs come from a recorded artifact's `inputs`. The smallest product-facing step is lifting `brainRun.ts`'s input builders into a shared function so the durable loop can assemble live inputs for one dev athlete.

## M5 — ingest does not observe the one live-published Studio post (dev, read-only evidence)
Dev has one `succeeded`/`live` publish with a 17-digit platform media id; ingested content observations use the same key shape (12,630 of them) and ingest ran two days after that publish, yet there are zero observations for it. The gap is COVERAGE, not timing and not the contract — a pipeline question for whoever owns ingest. Also `posted_at` is recorded only on `content_posts`, never on the generated asset, so the asset-id path cannot rescue it. No live publish and no backfill were run.

## L1 — CLOSED (`brain-live-activation-checkpoint.md`)
Campaign creation and the Recommendation's execution ref now run in one `db.transaction` owned by `routeGoverned`. Ownership is unchanged — the Campaign writer writes Campaign tables, the Recommendation store writes Recommendation tables — and a rollback test proves no Campaign survives a failed ref write. No recovery path is relied on. (Test double must be a Proxy: a `{ ...db }` spread loses drizzle's prototype methods.)

## L2 — CLOSED (`brain-live-activation-checkpoint.md`)
`services/brainInputsBuilder.ts` is now the one live input assembly, shared by the harness and the durable operator, with `gateForVariant` preserving the per-variant gating. Byte equivalence proved against real dev data; the proof caught a real regression (`context`/`research` not passed through, prompt 4,115 chars short).

## R20 — the R13 production-verb gate is head-anchored
`opensWithProductionVerb` matches only the first word of `what`. It caught `"Design an integrated content plan…"` on a live reply, and let `"Reactivate her dormant TikTok channel by cross-posting short-form video content"` through — a production method mid-sentence, downstream of the anchor. The residual now sits in the durable ledger. Softer forms (`"develop a … strategy"`, `"by leveraging …"`) name an approach rather than an outcome and are not refused. Whether `what` must be outcome-only is a spec question for a deliberate version bump, never a patch.

## F5 — one structural problem discards the whole run
A single gate failure nulls `output`, so the entire reply is refused. Observed live: two of three attempts on identical inputs refused, one of them losing two well-formed decisions and the BrainRun because a third decision opened with the wrong word. Correct and cheap on a harness; an availability problem on a path an athlete is waiting on. The choice — per-decision refusal, a bounded retry, or accepting that a refused run yields nothing — is deliberate and unmade.

## S2 — the substrate is not deployed to dev
Migrations 0071–0076 ship with the unmerged pull requests, so `brain_runs`, `recommendations`, `recommendation_events`, `campaigns`, `creative_intents` and `outreach_plans` are all absent on dev (verified). The first live run therefore read inputs live from dev and persisted into an ephemeral store built from `shared/schema.ts`; no Brain run on this path survives the process that produced it. Hand-applying DDL was rejected — a hand-applied file leaves no ledger entry. Deploying 0071–0076 through the normal path is the prerequisite for any athlete-facing activation.

## L3 — nothing the live run recommended is executable today
Three of three live decisions came back `specialized_plan`, in both the refused and the accepted reply; zero `direct_action`, zero `campaign`. Two need the outreach planner, which is frozen behind `OUTREACH_PLANNER_ENABLED`; the third needs a content planner that was deliberately not productionized. By design, but it means routing cannot be the first activation — her response can.

## K5 — the State builder stamps wall-clock time, so an assembly is not reproducible at a logical `asOf`
`buildAthleteState` takes no `asOf` and stamps `new Date()` on the State and on seven fields beneath it. Two assemblies for the same athlete at the same logical time therefore differ in exactly those eight stamps and nowhere else (proved between the harness and durable callers: identical once normalised, 60,252 chars each). A stored run remains fully auditable — it stores the inputs it was given, so its `promptSha256` reproduces — but the same prompt cannot be re-assembled from the database later. Threading an `asOf` through State is a change to frozen State semantics and needs its own reviewed step.

## F6 — the 0061 migration-parity test breaks whenever a later migration adds a column to a table 0061 created
It compares the table 0061's file produces against a full `shared/schema.ts` push, so 0072's additive `studio_plans.creative_intent_id` makes 0061 "not match" even though 0061 is correct and unchanged. Pre-existing in this stack, not introduced by the live-activation work, and it will recur on every future additive migration. The parity comparison needs to be against the schema as of that migration, not against head.

## R20 — CLOSED (`brain-reliability-0.12.0-checkpoint.md`)
Ownership of `what` is read across the whole value on a specialized_plan (`brain/ownership.ts`), with the prose stating the rule at `brain-eval-spec/0.12.0-exp`. Artefacts and mechanics are refused wherever they sit; a CHANNEL is never refused, which is what lets the gate avoid judging whether a surface is "materially the subject" — the escape then covers only artefacts and mechanics and is read from the decision's own subject. The gate refuses and reports; `strategicRemainder` is review-only and is never written back. Corpus measure: 99 of 127 recorded specialized_plan values fail the corrected boundary (`plan` 33, `cross-posting` 25, `pitch deck` 18). The head-anchored verb check is KEPT, so nothing previously refused is now allowed.

## F5 — CLOSED (`brain-reliability-0.12.0-checkpoint.md`)
Decision-local validity is scoped, set validity is not (`brain/decisionGate.ts`). Coverage is measured over CANDIDATES so a local rejection cannot manufacture a coverage violation; every set-level violation, duplicates included, still refuses the whole run. BrainRun needed no redesign and no schema change — `setProblems`, `rejectedCandidates`, `accepted` on the existing jsonb record. `decisionsFromRun` reads the accepted set, so a rejected candidate never becomes a Recommendation. Recovery measured on the recorded replies: the refused attempt 2 would have yielded 3 accepted of 4 candidates.

## S2 — CLOSED (`brain-reliability-0.12.0-checkpoint.md`)
Migrations 0071–0076 deployed to dev through `deploy-dev.yml` dispatched on the branch (run 36356955934, green including the schema step). No DDL hand-applied. All tables verified present on dev, 0074's constraint reads the Amendment-3 three-state list. One live run now survives process exit: one `brain_runs` row, three `recommendations`, three `recommendation_events`.

## L3 — restated with a projection (`brain-reliability-0.12.0-checkpoint.md`)
`brain/executionReadiness.ts` answers available/unavailable per Recommendation with a reason and a chaseable ref, reusing the router's domain derivation. Derived, never stored; never alters a Recommendation; availability is not part of strategic validity. All three live Recommendations are unavailable for three different reasons — no planner owns `impact`, no planner owns `content`, the outreach planner is mounted but off. The product rule is recorded in code: she may respond to anything; preparation may only be offered where the path is mounted.

## R21 — the per-Decision refusal rate has not been measured live
The two-in-three refusal rate recorded at the previous checkpoint was measured under the old whole-reply rule. Under per-Decision gating the equivalent question is how often a single Decision is rejected while its siblings stand, and one live run (0 rejected of 4 candidates) is not a measurement. Worth a handful of runs before any surface promises her a Recommendation set every time.
