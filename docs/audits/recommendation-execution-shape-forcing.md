# Recommendation → Execution Shape — the forcing experiment

**Status:** findings for review · stacked on #648 (`docs/recommendation-substrate`) · branch `feat/brain-0.9.0-exp-execution-shape`
**Provider calls:** 2 (Gemini 3.5 Flash) · **USD 0.059** total (C23 0.034 · C4 0.025). Everything else in this experiment ran offline.
**Controls, untouched:** #570 (`campaign-slice-design.md`) · #608 · Opportunity 1.2.0 · Objective 1.0.4 · Deals · Studio · State.
**Nothing mounted.** No persistence, no table, no flag, no Studio or Deals change. The whole chain — Brain run → Decision key → governed Recommendation → shape classification → proposed handoff — ran on run artifacts, a file ledger and pure functions. The harness was sufficient (§1), so per #648's acceptance the substrate stays unmounted.

Artifacts: `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/shape/` — `C23/` (Cases 2+3 run, ledger routing, first-reader routing kept as `routed.first-reader.json`), `C4/` (Case 4 run + routing), `case1-routed.json`, `case5-direct-creative-request.json`, `ledger-case1|case23|case4/`, the two controlled overlays.

---

## 0. What was established before the experiment (semantic preconditions)

**R13 ceremony — `brain-eval-spec/0.9.0-exp`** (digest `8d08728e…`; amend → bump → unpin → parity → exact-text review → repin; Brain suites 62 + orchestrator 23 green; 0.8.1 artifacts regate `0→0` structural and grounding, so no gate moved). Two additions, both text, no schema change:

- **THE ARTEFACT IS NOT YOURS** — "You recommend the strategic move and why … The test is ownership, not vocabulary … 'Launch a podcast' is yours only when the question was whether she should launch a podcast. Say the move, the subject, the direction and the reason, and stop."
- **The campaign shape statement** — campaign = "a persistent activation with a purpose, a managed scope, an aggregate outcome and a reason to end owned by something outside it … state in `what` what the activation is for and in `why` what ends it. Several tasks do not make a campaign; a campaign with nothing to end it will be refused."

**`existing-work/0.5.0-exp`** — optional `for {recommendationId, objectiveIds}` on a WorkItem; rendered as `· executing recommendation[<id>]`. This is the only link the Brain gets between work it sees and a Recommendation it made.

**`execution-router/0.1.0-exp`** (`brain/executionRouter.ts`, pure) — order is fixed: **governance** (must be `prepare_authorized`) → **dedup** (own execution refs; a work item `for` this Recommendation; same-intent work on the same Objective+shape; a governed sibling with execution on the same Objective+shape) → **shape** (contract per shape) → **handoff** (by reference). The router **refuses and never repairs**: no shape is downgraded, no field is filled in for the Brain.

Harness additions: `brainRun.ts --objective-overlay` (a controlled live Objective, marked `controlled`), `brainRoute.ts` (offline: simulate athlete `accept` + `authorizePrepare`, labelled SIMULATED, then route), `shapeCase4Ledger.ts`, `studioDirectRequest.ts`.

**Corpus check.** The corpus was not "free of known HOW leakage" after the ceremony — see Case 2 (§2) and Q8. That is the experiment's central negative result and is recorded, not patched.

---

## 1. Why the harness was sufficient (no substrate mounted)

| Substrate element (#648) | Represented by |
|---|---|
| BrainRun immutable record | run artifact `{inputs, record}` with `promptSha256`, spec digest, model, gates |
| Decision durable key | `recommendationKey` in `reconcileRun` (source · subject · question + shape + advances + intent) |
| Governed Recommendation | file ledger + pure `respond` / `authorizePrepare` / `recordExecution` |
| Execution-shape classification | the Brain's `executionPath` on the gated decision |
| Proposed handoff | `route()` → `ExecutionIntent` / `PlannerHandoff` / `CampaignOriginProposal` — objects, written to a file, never sent |

Nothing in the five cases needed a row to exist. The one thing a real mount changes is **who** governs: here every `accept` and `prepare_authorized` is simulated and labelled.

---

## 2. The five cases

### Case 1 — Direct Action (control pattern: Deals)

1. **Intent/Decision:** recorded A3 run (0.7.0 era, no new call) · decision on `deal[ctl-r2-northlight-termsheet]`, question "what should she do with this term sheet".
2. **Recommendation:** `rec_94b6d20dee8c9b5a` (reaffirmed unchanged by reconciliation of both new runs — the key held across three runs).
3. **WHAT/WHY:** "Counter the Northlight Learning ambassador term sheet to bring the commercial compensation in line with her established per-deliverable floor." / below-floor per-deliverable value.
4. **Shape:** `direct_action` · `advances_existing_work → deal[…]` · intent `counter`.
5. **Router:** governance (simulated) → dedup clear → shape **OK** (advances an in-motion subject; deal subject carries a typed intent; Deals is the only capability that owns a direct act).
6. **Existing work:** the term sheet *is* the existing work; the shape advances it rather than creating beside it.
7. **Owner:** Deals (draft → `pending_actions` `send_reply` → athlete tap).
8. **Crosses the seam:** `ExecutionIntent` — subject, dealId, intent, why, considerations, constraints, objectiveIds; then Deals' own draft request (`reply_intent: negotiate`, style, voice) and a `send_reply` proposal carrying `recommendation_id`.
9. **Brain does not specify:** the reply text, the counter figure, tone, timing.
10. **Approval:** `respond` (accept) → `authorizePrepare` → Deals drafts → the athlete's tap on the pending action is the send. Three separate acts; none implied by another.
11. **Downstream object:** the existing Deals draft + pending action. No new entity.
12. **Lineage:** `recommendation_id` on the proposal payload; the Recommendation's `execution.refs` would carry `pending_action:<id>`.
13. **Counterexample / ambiguity:** *the seam is amount-free only structurally.* `seamCarriesNoAmount` is true, yet the `why` prose carries "USD 1,250 … floor of USD 3,602" from the pre-0.8 run (the amount-construction gate was added later and regate flags exactly this on A3-1). A prose leak survives a structural check. Also: the two ungoverned siblings in the same ledger were refused at governance — the gate is real (§3 Q7).

### Case 2 — Specialized Plan (planner seam, typed domain, no Plan entity)

1. **Intent/Decision:** Objective loop on Mia's two live Objectives `b1c799e3…` (impact — Yuwa) and `c0f587e4…` (positioning — academic/tech), in both new runs.
2. **Recommendation:** C23 → `rec_9feaeb54fb19c6b1` (reaffirmed), `rec_33a591daf92bcf01` (new key); C4 → `rec_9feaeb54…` (reaffirmed), `rec_2daca3f5bb2362eb` (new).
3. **WHAT/WHY (verbatim):** "Develop a focused commercial pitch and outreach strategy integrating her Yuwa philanthropic leadership to secure global brand and CSR sponsorships." · "Develop a commercial positioning **deck** emphasizing her Stanford academic and technology credentials…" · C4: "Create a specialized digital storytelling **proposal** and outreach **plan**…" · "Develop a tailored commercial pitch **deck** and a targeted **partner list**…"
4. **Shape:** `specialized_plan` · `new_work` — 4/4, stable across both runs.
5. **Router:** **OK** ×4 → `PlannerHandoff {domain: impact | outreach, subject, objectiveIds, advances: null, intent: null, notSeen, runId}`. Domain derived from the Objective's domain (`impact → impact`, `positioning → outreach`); a Recommendation whose Objective has no derivable domain is refused (tested), never guessed.
6. **Existing work:** none for these Objectives; `new_work` correct.
7. **Owner:** a domain planner — impact / outreach. There is no generic planner and no Plan row; the handoff names a domain and a reference.
8. **Crosses the seam:** the Recommendation by reference (id, runId) + `what`, `why`, subject, Objectives, domain, `notSeen`. Nothing about format, channel, schedule, deliverables (asserted by test).
9. **Brain does not specify — but did:** every one of the four `what`s names an artefact (deck, proposal, partner list, outreach plan). The planner is handed "make a deck" and its ownership of the artefact is compromised *by phrasing*, even though the handoff carries no artefact field.
10. **Approval:** `respond` accept + `authorizePrepare` (simulated) gate the handoff; the planner's own artefacts would need their own gates (Studio's, Deals') — the router grants none.
11. **Downstream object:** proposed `PlannerHandoff` only. No table.
12. **Lineage:** `recommendationId`, `runId`, `objectiveIds` on the handoff; the reciprocal link is a WorkItem `for` (Case 4).
13. **Counterexample:** the **R13 leak** — 0.9.0's ownership test did not stop artefact nouns on the plan shape (4/4). Also, the C4 `notSeen` entries reason about *assets* ("high-resolution digital media … from Yuwa") — the Brain thinking one level below its seam.

### Case 3 — Campaign (the most important case)

1. **Intent/Decision:** Objective loop on a **controlled** live Objective `ctl-obj-matchday-series` (overlay, domain audience, horizon `this_season`, desired state "a match-day presence on my own channels for every match, through the end of the season", origin athlete). It is shaped as a bounded activation with an external end so that #570's definition is *reachable*, not assumed.
2. **Recommendation:** `rec_9896ca4ebabbcb0e` (C23).
3. **WHAT/WHY (verbatim):** "Launch a match-day content campaign across her channels to document every Stanford soccer match through the end of the season." / "Launching a season-long match-day content routine will directly satisfy her goal to have her audience follow her Stanford season with her, leveraging the upcoming schedule to build consistent presence." cites `objective[ctl-obj-matchday-series]`, `ctx[0]`, `ctx[1]` (the schedule).
4. **Shape:** `campaign` · `new_work`. The Brain **selected the campaign shape unprompted** on the one Objective built to qualify, and left the three ordinary Objectives on other shapes in the same run. Selection was clean.
5. **Router — two outcomes, both on record.** First routing: **REFUSED** "campaign without a stated reason to end … not downgraded (#570 invariant 2)". The refusal was *wrong in reading*: the Brain had stated the end ("through the end of the season") and the reader's pattern only knew "through the season". The reader was widened to the Brain's phrasing (tests added, `season-long` alone still names no end), and the re-route — offline, same artifact — gave **OK → `CampaignOriginProposal {door: recommendation, purpose, objectiveIds, period {endsWith: objective_horizon}, constraints: [], evidence: [objective, ctx[0], ctx[1]], deliverables: none}`**. Refuse-not-repair held both times; what changed was the router's competence at reading prose, which is the finding (item 13).
6. **Existing work:** none; `new_work`.
7. **Owner:** the Campaign system under #570 — origin `idea` → `planning`, then a `CampaignSpec` the athlete approves.
8. **Crosses the seam:** purpose (the Brain's `what`), Objective ids, `period.endsWith`, evidence refs, `recommendationId`. **No deliverables, no dealIds, no brandIds** (empty, honestly — nothing in the Recommendation names them).
9. **Brain does not specify:** format, cadence per match, channels beyond "her channels", creative angle, any deliverable. `what` names purpose + scope + end; `why` names the Objective and the schedule. Under the ownership test this is the Brain's move — the question *was* the activation.
10. **Approval:** three acts, as #648 proposed: `respond` accept (a judgment) → `authorizePrepare` (origin may become `planning`) → `CampaignSpec.approval` by the athlete (→ `approved`). #570's A3 sentence "accepting the Recommendation approves the campaign" is contradicted by this run in a concrete way: the accepted Recommendation carries **zero deliverables**, so there is nothing yet for acceptance to approve.
11. **Downstream object:** proposed `CampaignOriginProposal` (a subset of #570's `CampaignOrigin` — `deliverables` deliberately absent). No campaign row.
12. **Lineage:** `recommendationId`, `objectiveIds`, evidence refs `ctx[n]` with `how`.
13. **Counterexample / ambiguity — #570's "external reason to end" is the fragile invariant.** It is a *semantic* fact the router must recover from prose. A pattern reader missed a plain statement of it once; a stricter reader would refuse more true campaigns, a looser one would admit "season-long" (bounded by implication only). The honest options: a typed `ends_with` on the campaign shape (a Recommendation schema change — deliberately **not** made here per the brief), or the athlete states the end at the Campaign door (making "external reason to end" an athlete assertion, not a Brain output). Second ambiguity: "several tasks do not make a campaign" — a post per match *is* several tasks; what made it a campaign here was the aggregate purpose and the external end, which is #570's own line, so the boundary held but only because the Objective was built to sit on the right side of it.

### Case 4 — Existing Work (no duplicate execution)

1. **Intent/Decision:** Objective loop on the audience Objective `feb62891…`, with a work overlay: activation `ctl-r1-tiktok-series` in production, `for: {recommendationId: rec_764257cd61ef9777}`; ledger prepared offline so that `rec_764257cd61ef9777` is governed (simulated) with `execution.refs = [activation:ctl-r1-tiktok-series]`.
2. **Recommendation:** none new. Reconciliation recorded `reconsidered_by_run` on the governed record ("NO_ACTION on a governed Recommendation — recorded, not withdrawn").
3. **WHAT/WHY:** the Brain returned **NO_ACTION**: "An active TikTok reactivation series (deal[ctl-r1-tiktok-series]) is already in production and execution, with videos successfully published on 22 and 25 September … the next strategic steps are already covered." cites the Objective and the work item.
4. **Shape:** n/a (NO_ACTION).
5. **Router (on the governed record, run against the same work view):** **REFUSED (dedup)** "already in execution: activation:ctl-r1-tiktok-series — attach, do not create". A second refusal path also exists and is tested: a *new* Recommendation on the same Objective+shape while a governed sibling has execution refs.
6. **Existing work:** prevented duplication at **both** levels — the Brain's (decision time) and the router's (route time).
7. **Owner:** whoever already executes (the activation).
8. **Crosses the seam:** nothing — that is the point.
9. **Brain does not specify:** anything; it declined.
10. **Approval:** none needed; the governed record keeps its authorization; the run's NO_ACTION is an event on it, not a withdrawal.
11. **Downstream object:** none.
12. **Lineage:** the `for` link on the WorkItem is what let the Brain *cite* the executing work by reference; without it the Brain would have seen unattributed work and had to infer.
13. **Counterexample / ambiguity — the two are empirically different and both are needed.** *NO_ACTION at decision time* happened here because the Brain saw the work. *RECOMMEND reconciled against execution underway* happened in C23: the same Objective, without the overlay, produced a fresh RECOMMEND with a **different shape** (`direct_action`), which the ledger keyed as a new record and, because the old record was ungoverned in that ledger, withdrew the old one — correct under the withdrawal rule, and exactly the case where only the router (dedup on execution refs) stands between the athlete and a duplicate. The Brain is not a dedup mechanism; it is a witness when shown the work. Minor: work items of any kind are cited as `deal[…]` (the harness gives overlay items a `deal` ref) — vocabulary conflation to fold into R11.

### Case 5 — Direct Creative Request (athlete → Creative Intelligence / Studio)

1. **Intent:** the athlete's own words, "Create a post about today's win". No Decision, no Objective, no Opportunity.
2. **Recommendation:** none, by design.
3. **WHAT/WHY:** hers. Nothing strategic is derived.
4. **Shape:** none of the three; this is not an execution path of a Recommendation.
5. **Router:** not involved.
6. **Existing work:** may attach *later* to a Campaign if one exists (#570 §3 freeform attach, reversible) — never required.
7. **Owner:** Studio (today) / Creative Intelligence (when it exists).
8. **Crosses the seam (offline mapping onto the `BriefInput` Studio already requires):** `athleteId` server-injected; `origin: "system"` (Studio's enum has no `athlete` origin — her own ask is not `inbound`, which means untrusted brand text); `objective: "recap"`; `deliverable: "post"`; `mode: "generate"`; `brandId: null`. That is the **entire** minimum: four enum values and no brand.
9. **Not specified:** references (her own `media_assets`, Studio's "never generate from scratch"), spend (priced preview), clearance, publish mode — all Studio's gates, all hers.
10. **Approval:** Studio's existing gates (`hasBeenScored`, priced `previewId`, clearance, publish). No new gate.
11. **Downstream object:** a Studio brief — existing object, created through the existing door. No Mila tool creates briefs today, so the *entry seam* is the missing piece, not the object.
12. **Lineage:** athlete intent (verbatim) → brief. No Brain provenance to attach, and attaching any would be false.
13. **Counterexample / ambiguity:** `origin: "system"` is a misnomer for "she asked" — Studio's origin enum lacks the athlete-as-author case; a Creative Intelligence seam would carry the ask verbatim plus the *moment* (today's match — Context, if supplied) and her voice/brand layer, and would produce a creative interpretation she confirms (the direction tools' `BriefProposal` shape already exists for this). What belongs to Creative Intelligence and not to the Brain: angle, feeling, line, references, format below the brief. What the Brain never sends it: a Recommendation, an Objective, a Campaign spec.

---

## 3. Comparison across the five

| | Direct Action | Specialized Plan | Campaign | Existing Work | Direct Creative |
|---|---|---|---|---|---|
| Brain classified | direct_action (stable ×3 runs) | specialized_plan (4/4, stable) | campaign (selected unprompted) | NO_ACTION | n/a |
| Router | OK | OK ×4 | refused (reader) → OK | refused (dedup) | n/a |
| Refuse-not-repair held | yes | yes | yes, both times | yes | — |
| HOW leak in `what` | none (the counter is the move) | **4/4 artefact nouns** | none (purpose+scope+end) | — | — |
| Handoff carries | ExecutionIntent | reference + domain | origin proposal, **no deliverables** | nothing | four enum values |
| Athlete acts | accept · authorize · tap send | accept · authorize · (planner's own gates) | accept · authorize · approve CampaignSpec | none | Studio's gates |
| New entity needed | no | no | no (proposal only) | no | no |

The mis-shape that mattered: in C23 the TikTok Objective came back `direct_action · new_work · advances: null` — refused at shape ("direct_action must advance an in-motion subject"). The same decision was `specialized_plan` in A3 and C4. **Shape is not stable across runs for the same Objective**, and the router caught the unstable one.

---

## 4. The fourteen questions

1. **Direct Action valid as a general shape?** Yes, with a narrow meaning: *one act an existing execution capability owns on a subject already in motion.* Deals is the only such capability today and the router says so. It is not a general "do a small thing" bucket — the TikTok mis-shape shows what happens when the Brain uses it that way.
2. **Specialized Plan a real seam without a Plan entity?** Yes. A handoff by reference (id, runId, Objectives, domain, what/why) is enough for a planner to start; the domain comes from the Objective, not from a table. What is *not* solved is the Brain's phrasing (Q8).
3. **Campaign selectable cleanly under #570?** Yes — once. The Brain selected it on the one Objective built to qualify and on nothing else, and stated purpose, scope and end. The clean part is selection; the fragile part is proving "external reason to end" from prose.
4. **Plan vs Campaign, empirically?** A stated **end owned by something outside the work** and an **aggregate purpose** — both present in `what`/`why` of the campaign and absent from all four plans. Domain and size did not separate them; the season did.
5. **Existing Work prevents duplicates across shapes?** At the router, yes, and across shapes: dedup keys on execution refs and `for` links, not on shape. At the Brain, only when the work is shown *with its link*; a shape flip between runs otherwise mints a new record. Both layers are needed.
6. **Brain shape classification useful or redundant?** Useful and insufficient. It carried real information (campaign selected on the right Objective; plans on the rest) and it was wrong once (direct_action on a channel reactivation). Emitted by the Brain, validated by the router — #648's design — is the right division; neither alone is.
7. **Router protection real?** Yes, on the evidence: two governance refusals, one dedup refusal, one shape refusal that caught a genuine mis-shape, and one refusal that was the router's own reading error. The last is the caution: the router is only as good as its reading of the Brain's prose, and refuse-not-repair means a bad reader blocks good work rather than mangling it — the safe failure, but a failure.
8. **R13 keeps the Brain strategic without vagueness?** **Not established.** Vagueness did not appear; leakage did: 4/4 plan-shaped `what`s name an artefact after the ownership test was added. The campaign and direct-action `what`s were clean. The pattern is specific: when the shape is a plan, the model reaches for a noun to make the plan concrete. Prompt text alone did not close R13.
9. **Minimum Recommendation → planner:** `recommendationId`, `runId`, `objectiveIds`, subject, domain, `what`, `why`, `notSeen`, `advances`/`intent` if any. Nothing about artefacts — and, given Q8, the planner must treat any artefact noun inside `what` as **non-binding** (a stated rule at the seam, until the Brain stops emitting them).
10. **Minimum Recommendation → Campaign:** `recommendationId`, purpose (`what`), `objectiveIds`, `period.endsWith` (+ dates when stated), evidence refs, constraints from `notSeen`. **No deliverables** — they are the Campaign system's, after `planning`. `dealIds`/`brandIds` only when the subject names them.
11. **Minimum into Creative Intelligence:** the athlete's ask verbatim, the moment (Context), her voice/brand layer, references. From the Brain: nothing directly. From a Campaign, when one exists: the campaign's purpose and constraints as *context*, never as a brief.
12. **Direct athlete → Studio without the loop?** Yes, on paper: four enum values on the existing `BriefInput` and Studio's own gates. The missing piece is the door (no tool creates a brief from an ask) and one honest enum (`origin` has no "athlete" value). Neither is a Studio change made here.
13. **What #570 requires:** (a) the three-act approval in place of A3's "accepting the Recommendation approves the campaign" — this run produced an accepted campaign Recommendation with **no deliverables**, so the sentence cannot hold; (b) `CampaignOrigin.deliverables` must be **optional at origin** and owned after `planning`; (c) "external reason to end" needs a *carrier* — either a typed field on the Recommendation's campaign shape (schema ceremony, the user's decision) or an athlete assertion at the door. #570 was not modified; these are recorded as contradictions for its owner.
14. **Build next (recommendation):** not persistence, not a planner. **Close R13 structurally**: a `brain-eval-spec/0.10.0-exp` ceremony that makes `what` a typed move (subject · direction · reason) rather than free prose on the plan shape, or — the cheaper first test — one forcing run of the same four Objectives with a single added spec line naming the plan-shape failure ("on a plan, name the direction, not the document") to see whether the leak is prompt-closable at all. Second, in parallel and offline: decide the carrier for "reason to end" (Q13c), because the Campaign door cannot be built until it exists. Third: the Studio entry seam for Case 5 is the smallest real door in the whole map and touches no strategy; it can be designed independently.

---

## 5. Backlog additions

- **R15** — plan-shaped `what` names artefacts after R13 (4/4 in this experiment). Structural, not vocabulary: the ownership test did not bind.
- **R16** — execution shape unstable across runs for one Objective (specialized_plan ↔ direct_action). The router catches the wrong one; stability itself is not established.
- **R17** — "reason to end" carrier for the campaign shape: typed field vs athlete assertion (decision needed before any Campaign door).
- **R11 (extend)** — work items cited as `deal[…]` regardless of kind; the ExecutionIntent `why` prose carries amounts a structural check cannot see.

## 6. What was not done, by rule

No provider call beyond the two above. No Deals, Rate, Objective, Opportunity, Studio, State or #570 change. No table, flag, row, or mount. All athlete responses in this experiment are simulated and labelled as such; nothing here is a real decision by Mia.

---

## 7. Acceptance (27 September 2026)

Accepted by the user as the Recommendation → Execution Shape forcing result. The experiment supports Recommendation → Direct Action / Specialized Plan / Campaign, with Direct Action valid but narrow, Specialized Plan a real seam with no generic Plan entity, Campaign a real distinct shape under #570, Existing Work required at both the Brain and router layers (defense in depth, not duplication — do not collapse them), and direct creative intent able to bypass the strategic loop (the missing piece is the door, not the Studio object). Two semantic blockers before any seam is built: **R15** (plan-shaped `what` names planner artefacts) and **R17** (the campaign's reason to end is recovered from prose). R16 recorded, not solved; no stability gate. The #570 approval conflict stays separate: Recommendation acceptance governs the Recommendation and does not approve Campaign scope or execution; Campaign needs its own three-act flow. Continued in `docs/audits/brain-0.10.0-exp-r15-r17-checkpoint.md`.
