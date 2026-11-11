# Outreach planner — preconditions closed, first production-shaped planner (preparation only)

**Status:** for review · two stacked PRs on #652 — preconditions (`feat/planner-preconditions`) and the planner (`feat/outreach-planner`)
**Provider calls:** 0. Everything here is deterministic: the StartX1 control runs offline over the recorded #652 reply; the production path is exercised with an injected provider against PGlite.
**Mounted:** nothing. `OUTREACH_PLANNER_ENABLED` is off everywhere; no route, no cron, no workflow step calls the orchestrator; migration `0071_outreach_plans.sql` is in the deploy list and applies on the next dev deploy after merge, creating an empty table nothing reads. Content planner not productionised. No Campaign, Creative Intelligence, Studio, Deals, Rate, Brain, Objective or Opportunity change. No generic Plan table, no Action entity.

---

## 1. Governed exclusions — the exact context contract

`planner-exclusions/0.1.0-exp` (`planner/exclusions.ts`). Answers one question for the planner: **what subjects must this planner not advance?**

```
GovernedExclusions { version, asOf, items: ExcludedSubject[] }
ExcludedSubject {
  ref:            "objective[<id>]" | "recommendation[<id>]"     // the governed object, by reference
  kind:           "deferred" | "declined" | "excluded"
  statement:      string        // the object's own one line (desired state / what) — the only text copied
  said:           string | null // her words, verbatim (deferral.said / response.said); never paraphrased
  counterparties: string[]      // canonical names the object concerns — resolved from the state's inbound
                                // counterparties and deal brands (cited index, cited deal ref, or a canonical
                                // name present in the statement); never extracted from prose
  paths:          string[]      // state paths and references the object cites (recorded)
  since:          string | null
}
```

Built by reference from deferred and declined Objectives (`objectiveHistory` filtered as `brainRun` does) and declined/deferred Recommendations in the ledger. Rendered to the planner as a block ("GOVERNED EXCLUSIONS — … name it under `omitted` and move on"). Deferral is not reinterpreted, nothing is resurfaced, and the Objective/Recommendation governance stays authoritative: this is a read.

**Enforcement (`exclusionProblems`)** — identity matching, not vocabulary: a candidate naming an excluded counterparty; a dependency citing a *subject-identifying* reference of the object (the object, its opportunity, a deal, an inbound thread; general evidence paths such as `findings[…]` are recorded and not enforced); a dependency `commercialPosition.inbound[n]` that resolves to an excluded counterparty; a sequence step naming one as a whole word. `omitted[{subject, why}]` is the sanctioned acknowledgement.

One thing learned building it: the deferred Objective's cited inbound indices no longer pointed at StartX1 (the inbound list had re-ordered since the Objective was made), so index resolution alone would have missed it; the canonical-name-in-statement resolution is what catches it. Indexed state paths are unstable across rebuilds — folded into R11.

## 2. StartX1 regression test

`planner/exclusions.regression.test.ts`: loads the recorded #652 Case B reply and the R15 run it was planned from, builds exclusions from that run's own deferred/declined Objectives and state, and asserts the recorded plan is refused for the deferred counterparty. Result under the new gates, offline: **12 refusals** on B — the candidate "StartX1", three dependencies `commercialPosition.inbound[3|6|9]` resolving to StartX1, three sequence steps acting toward it, and four ownership refusals for the same counterpart being an active inbound thread. A/C/E drift only on version. Plus a synthetic unit test with a fictional counterparty for CI. The original artifact is untouched.

## 3. Counterpart-in-motion ownership rule

`planner/ownership.ts`. **A counterpart already in motion is Existing Work, not a new outreach target.** In motion = a deal in Existing Work (negotiating, accepted, activation) or an active inbound thread (`deal_detected`, `unread`, …; archived is not). Owner: Deals. The planner may identify target classes, research and select prospective counterparties, prepare strategy, materials and sequence, and commission supporting work. It may not reply to an inbound, negotiate, counter, accept, decline, or take over a deal or thread. Meeting one it **attaches** (`attachments[{ref, why}]`), **omits**, or surfaces a dependency; never a new object for the same counterpart. Enforcement: a candidate or a sequence step naming an in-motion counterpart (unless attached/omitted) is refused; **Deals' verbs on any counterpart are refused whatever the gate** ("counter the term sheet" with `tap_to_send` is still not the planner's). System ownership; Deals unchanged.

## 4. Creative Intelligence ownership rule

`planner/creativeBoundary.ts`. **The planner may commission creative work; Creative Intelligence owns the creative solution.**

```
Commission { purpose, audienceRole, channelOrFormatClass | null, timing | null, constraints[], why }
```

That is the whole type. There is no field for a hook, caption, visual treatment, tone execution, shot design, edit style, references or concept, so a planner holding one has nowhere to put it — `commissionProblems` refuses any other field as "a field that does not exist", which is structural ownership, not a word list. The #652 counterexample is recorded as the boundary case: "adapt to TikTok specs (aspect ratios, **trending audio hooks, caption styling**)" inside a content step — it appeared in prose inside `does`, which is exactly why the boundary is drawn as a type on the commission and not as a filter on prose. The earlier key-level guard on content plans stays as a backstop and is not the mechanism.

## 5. Minimum production outreach planner input

`OutreachPlannerInputs` (`outreachPlannerOrchestrator.ts`): the **unchanged `PlannerHandoff`**; the live Objectives it names (by id, read from the store); deferred and declined Objectives (→ exclusions); Existing Work (→ reconcile, counterparts); the state's canonical names (`commercialPosition.inbound[].counterparty`); and the run's own rendered `stateBlock`/`workBlock` cited by the handoff's `runId`. No Brain field added. Nothing copied from the Brain's evidence set beyond the run's rendered record, which is what "evidence by reference" resolves to.

## 6. Minimum domain-native outreach output

`OutreachPlan` (0.2.0): `targetClasses[{class, why, candidates[]}]`, `researchNeeded[{question, sourceClass}]`, `sequence[{step, does, dependsOn[], gate}]`, `materials[{material, purpose}]`, `commissions: Commission[]`, `omitted[]`, `attachments[]`, inside the thin envelope (`result`, `rationale`, `dependencies` by reference, `completion`, `escalation`, `attachedTo`). No `actions[]`; the content planner's output shares nothing but the step vocabulary.

## 7. Persistence / native identity decision

No thinner outreach-native object exists in the repo (no target list, sequence, or thread of outreach's own), so a **narrow record** is the identity: `outreach_plans` — one row per governed Recommendation holding the handoff verbatim (small; the lineage), spec + digest, a sha256 of the exclusions/counterparts context it saw (audit; not copied), status, the result, and completion timestamps. Not a Plan table: nothing but outreach reads `result`; the content planner will use `studio_plans`. Statuses: `prepared · reviewed · complete · attached · escalated · refused · superseded`; none means "sent"; no column can hold a message.

## 8. Existing Work projection

`outreachWorkItems(rows)` → one item per active record: `ref: outreach_plan[<id>]` (additive `SUBJECT_KINDS` value; `existing-work/0.6.0-exp`), `kind: activation`, `for {recommendationId, objectiveIds}`, statement carrying status and "none sent" ("Outreach planned toward <classes>: n step(s), m commission(s), none sent."). `existingWorkFrom` takes the projected items as a trailing parameter so one view exists. A later Brain run reads `· executing recommendation[<id>]`; the router deduplicates on `for`. Tested end to end against PGlite.

## 9. Preparation-only authorization enforcement

Three layers, all tested: (a) **structural absence** — the orchestrator has no send path and imports nothing that drafts, proposes or publishes (asserted by test on the module source); (b) **the gate** — any sequence step that would send, publish or spend with `gate: "none"` is refused, by verbs with an object, not nouns (the #652 correction); Deals' verbs refused whatever the gate; (c) **the record** — no status or column can represent a sent message. Consequential execution stays behind later explicit authorization (tap-to-send, Studio's gates, dual confirm).

## 10. Idempotency / dedup

One ACTIVE record per (athlete, recommendation): a partial unique index on `outreach_plans`, and the orchestrator returns the existing record without a call (`kind: "existing"`). Before any call, `alreadyExecuting` attaches to work that carries the Recommendation (`for`) or an activation on the same Objective — including the planner's own projected item, so the two Brain-side layers (NO_ACTION when shown the work; router dedup on `for`) keep their meaning. Tested: second preparation → no call; projection present → attached, no call.

## 11. Planning completion semantics

On the record, separate from anything strategic: `prepared → reviewed` (the athlete saw the scope) `→ complete` (`planning_completed_at`; the planner's own condition — target set prepared, research resolved, sequence prepared, materials commissioned, dependencies surfaced). There is deliberately no path from the store to the Recommendation ledger's outcome: planning complete never marks the Recommendation achieved. The projected statement changes to "planning complete … none sent".

## 12. Campaign escalation behaviour

A planner returning `escalated` with a typed `ends {source, ref}` is persisted as a record with `output: null`, status `escalated`, projected as "nothing planned, nothing sent". It creates no Campaign and no Campaign work; the router still refuses any campaign shape that is not a governed campaign-shaped Recommendation with `ends`. Routing back for a new governed Recommendation is a Brain/governance cycle, not a planner act. Tested.

## 13. Tests

- `planner/preconditions.test.ts` (7): exclusions built by reference with canonical counterparties and her words; index drift resolved by canonical name; candidate / dependency / step refusals; `omitted` allowed; in-motion counterparts listed; targeting and acting refused; Deals' verbs refused whatever the gate; attachment allowed; commission fields structural.
- `planner/exclusions.regression.test.ts` (1): the StartX1 control over the recorded artifacts.
- `planner/evalSpec.test.ts`, `reconcile.test.ts` (5): spec frozen at `planner-eval-spec/0.2.0-exp` (digest `90654028…`), gates, escalation, projection.
- `outreachPlannerOrchestrator.test.ts` (6, PGlite, injected provider): flag off; gate refusal persists nothing; prepared + projection + idempotent + attach; completion separate; escalation persisted, no Campaign; no send path.
- Brain (51 + 44) unchanged and green; regated recorded replies preserved beside their originals.

## 14. What remains intentionally unmounted

The orchestrator has no caller: no route, no workflow step, no Mila tool. `OUTREACH_PLANNER_ENABLED` off. The Recommendation ledger is still file-based in the harness, so `execution.refs += outreach_plan:<id>` is the caller's to record when the substrate mounts (`outreachPlanRef` is exported for it). `athlete_stated` transport untouched. Content planner experimental. No Campaign door. The `reviewed` act has no surface yet (it is a store function).

## 15. Ready to open the Campaign + Creative Intelligence seam?

**Campaign door: yes, on the design side** — the R17 carrier exists (`ends`), the router resolves it, the #570 amendment is recorded, and the planner escalation now lands as a durable record that a governance cycle can pick up. What the door still needs is the amendment applied to #570 and a `CampaignOrigin` writer, which is the Campaign checkpoint's work.
**Creative Intelligence seam: yes, and it now has a fixed entry** — the `Commission` type is the object that crosses into it from planners (and the Case 5 direct door crosses from the athlete). What is not yet decided is what Creative Intelligence emits back (the `BriefProposal`-shaped interpretation the athlete confirms) and where `studio_plans` sits under it; that is the seam's own checkpoint, and the content planner stays experimental until it is drawn.

---

## 16. Acceptance (27 September 2026)

#653 and #654 accepted; the outreach planner arc is frozen: no callers, flag off, no generalisation of the outreach record or the planner abstractions. Next checkpoint: Campaign → CampaignSpec / BriefSeed → Creative Intelligence → Studio (`campaign-creative-seam-checkpoint.md`).
