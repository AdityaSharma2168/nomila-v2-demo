# Brain — evidence → derived availability → reconsideration: design/repo checkpoint, 27 Sep 2026

**What the athlete experiences.** She deferred an Objective saying "when I know more about this". Later, Nomila learns something responsive — a brand's actual terms, say. The Objective does not quietly change. If, on reconsideration, what arrived appears to answer what she said she needed, the Objective comes back to her queue for her to accept, change, decline or defer again. Her original words stay on the record, and the record says exactly which evidence brought it back.

**What happens underneath.** An evidenced Intelligence Request (derived, no status field) makes the blocked decision *eligible for reconsideration* — generic, request-side, nothing more. For a deferred Objective, one consumer applies the ledger's existing `re_surfaced(because: information_available)` only when a gated Brain run observed `CONDITION_APPEARS_RESOLVED` for that Objective citing the RESEARCH block projected *from that request*. The ledger's own transition moves the row; the request is attributed once. Nothing is written to any other place; no `information_available` flag exists anywhere.

**Status:** deterministic design + offline tests, no provider call, no store mounting, no real athlete. Branch `feat/brain-evidence-reconsideration`, stacked on the acquisition seam.

---

## 1. Objective resurfacing — repo trace

| piece | where | what it does |
|---|---|---|
| deferral record | `contracts/objectiveEntity.ts:39-47` `Deferral {kind: information\|time\|athlete, after?, said}`; row column `objectives.deferral jsonb` (0070), absent pre-L2 → read as `information` | her words verbatim on the row while deferred, and forever in the `defer` event (`said` + `delta.deferral.said`) |
| `RESURFACE_REASONS` | `objectiveEntity.ts:48-50` `["time_elapsed","athlete","information_available"]`; "`evidence_changed` is deliberately NOT a reason" | vocabulary; `information_available` has **no producer anywhere** (`reconcile.ts:150-172` emits only `time_elapsed`) |
| `re_surfaced` transition | `objective/entity.ts:177-188` `applyRunEvent`: `allowed()` requires `proposed · deferred`; system may re-surface only for `time_elapsed` or `information_available` (else `bad_resurface`); sets `disposition: unreviewed`, lifecycle untouched, **removes `deferral` from the row**; event actor `{userId: null, role: system}`, `said: null` | the only mover; `fold` agrees (`entity.ts:334`) |
| who appends | `objective/store.ts:174-180` inside `materialiseProposalSet` (`continues → re_surfaces`), and `decide()` for her `revisit` (persisted as `re_surfaced` with an athlete actor, `because: athlete`, `entity.ts:254-260`) | no HTTP route, no cron, no Brain path calls `applyRunEvent` |
| validation | `applyRunEvent` (above); `validateObjective` (`entity.ts:346`) refuses `deferral` on a non-deferred row; `objective_events.action` CHECK (`schema.ts:2899`) | no validation of `delta` keys anywhere (jsonb, typed only in TS) |
| resulting state | `unreviewed · proposed`; in `reviewQueue` (`store.ts:258-261`) | **she decides** — accept / modify / decline / defer again; nothing becomes active by itself |
| her wording | dropped from the row; kept in the `defer` event | preserved in the ledger, not shown (next row) |
| presentation | `routes/objectives.ts:49-57` `GET /objectives` → `{queue, live, history}`; `ReviewContext` (`objective/context.ts:15-24`) carries rationale/opportunities/evidence/intent only; `ObjectivesReviewScreen.tsx` shows the queue | a re-surfaced Objective is **indistinguishable from a first proposal**; her earlier words and the returning evidence are not shown; no deferred list, no revisit control in the client (route exists) |
| side effects | none: `insertEvent` + `db.update(objectives)`; no run, Recommendation, notification or Mila message | **information available → Objective returns for her review**, never → Brain decides the Objective. Assumption confirmed |
| Brain output into the ledger | none: `DEFERRED_DECISIONS` are parsed, gated, printed and dropped (`brainRun.ts:225`) | `CONDITION_APPEARS_RESOLVED` has no operational consumer today |
| idempotency on events | none: `objective_events` has only a non-unique `(objective_id, at)` index; `insertEvent` is an unconditional insert; re-running a set appends `reaffirmed_by_run` each time | a second `re_surfaced` is prevented only because the row is no longer `deferred` |

## 2. The generic bridge (`brain/reconsideration.ts`)

- `reconsiderationEligibility(request)` → `{eligible, status, because, blocks}`: eligible iff `deriveStatus === evidenced` and `reconsideredInRun === null`. Obsolete → never (evidence kept). This is all the request knows; it never touches an Objective.
- `blockedDecisionOf(request)` → `{kind: deferred_objective, objectiveId}` when the Decision identity is `subject: objective[<id>]` + question `INFORMATION_CONDITION` ("information condition"); otherwise `{kind: requested_decision, subject}`. **Read from the identity, never from the proposition or the evidence.**
- `requestFromDeferredEntry(entry)` — the builder that was missing: a gated `REQUEST_INTELLIGENCE` on a deferred entry becomes a `RequestInRun` whose Decision identity names the Objective explicitly (`deferredObjectiveDecision(id)`). No request raised from a deferral can lack the reference.

## 3. The Objective-specific consumer

`objectiveResurfaceFrom(request, objective, run)` → a pure verdict, every refusal named:
1. request eligible (§2); 2. it blocks a deferred Objective; 3. **that** Objective; 4. `allowed(objective, "re_surfaced")` (proposed · deferred); 5. deferral kind `information` (or absent) — `athlete` is hers alone, `time` is the clock's; 6. the run passed both gates; 7. the run's deferred entry for this Objective is `CONDITION_APPEARS_RESOLVED` (a `REQUEST_INTELLIGENCE` or `NO_REQUEST` → "responsive evidence arrived, but the condition is not observed resolved"); 8. that entry cites a `research[n]` whose block has `requestedBy.objectiveId === objective.id` **and** `requestedBy.requestId === request.id`.
→ `delta = { because: information_available, requestId, observedInRun: run.id, evidenceRefs: [{store, id, at}…], rationale: entry.why }`.

`resurfaceDeferredObjective(...)` applies it: `applyRunEvent(objective, "re_surfaced", delta)` (the ledger's own rule) + `attributeReconsideration(request, run.id)`. Not mounted: the store would persist the event and projection exactly as it does for `time_elapsed`.

## 4. A / B / C — resolved: **B**

| option | against the existing semantics |
|---|---|
| **A** — responsive evidence arriving re-surfaces automatically | The ledger's own doc (`objectiveEntity.ts:30-38`) reserves `information_available` for "a later mechanism that can say **her question was answered**". `evidenced` says the *request's need* was answered (attributable, right class, after), not that *her* condition was. Her words are open-ended ("when u know more"); the R1 P cell showed the Brain treating documented terms as sufficient **as a judgment**, and it could legitimately have asked for the counterparty's profile instead. Under A the Objective would return on the first evidenced request even when reconsideration would say "not yet" — she would review with partial information, and the three-way distinction (new evidence / responsive evidence / established) collapses 2→3 mechanically. Rejected. |
| **B** — evidenced makes it eligible; the gated `CONDITION_APPEARS_RESOLVED` permits resurfacing | Preserves `evidenced ≠ established`; the observation is admissible only with responsive attributable evidence (Gate 2, 0.8.1); the ledger transition stays the mover and she stays the decision-maker. Cost: resurfacing is provider-dependent (one reconsidering run per evidenced request, bounded by `reconsideredInRun`). **Adopted.** |
| **C** — another mechanism | `reaffirmed_by_run.evidenceChanged` is "a SIGNAL, never a trigger" and lists nothing responsive; her `revisit` exists (route) but has no client path and requires her to know evidence arrived; no other reason is admitted. Nothing cleaner exists. |

Correction to the R1 checkpoint §11, which read "what moves is derived: … `information_available` true … `re_surfaced`": the derived status makes the request **eligible**; the consumer requires the judgment. Noted there.

## 4a. Architectural decision — recorded 27 Sep 2026 (reviewed, adopted)

> **Responsive evidence makes a blocked Decision eligible for reconsideration. It does not itself establish that the athlete's deferral condition has been satisfied.**

For an information-deferred Objective: `Intelligence Request evidenced` → Decision eligible for reconsideration → the Brain evaluates the athlete's original condition with the responsive evidence → only a gated `CONDITION_APPEARS_RESOLVED` attributable to that request → `re_surfaced(reason = information_available)` → the Objective returns to athlete review. **The athlete still decides.**

A/B/C closed: A rejected (collapses "responsive evidence arrived" into "her condition has been answered"); C rejected (neither generic evidence change nor her revisit expresses the missing semantic judgment); **B adopted.**

`CONDITION_APPEARS_RESOLVED` is kept permanently in the current architecture unless later evidence changes its role; the earlier idea that it may be redundant with derived `information_available` is withdrawn. Its demonstrated responsibility: **it is the Brain's judgment that responsive evidence is sufficient for the athlete's actual deferred condition.** The Intelligence Request does not own that judgment; the acquisition layer does not own it; the Objective ledger does not infer it.

Generic vs Objective-specific behaviour stays as separated in this checkpoint (§2 vs §3); Objective behaviour is never put into the Intelligence Request. Lineage as in §8 approved, no new schema; `requestedBy.requestId` on the projection is appropriate and **stays unrendered** — it exists for deterministic attribution, not to influence provider reasoning. Idempotency: the request's one-reconsideration attribution + "re-surfaced only while actually deferred" is sufficient; no further idempotency system; the lack of per-run Objective-event idempotency is recorded as reliability pressure (backlog R10).

**Governance-surface requirement (promoted from a UX note):** a re-surfaced Objective must eventually be presented as a *previously deferred Objective returning because new relevant information became available*, not as an indistinguishable new Objective. The athlete-facing surface should ultimately have access to her original deferral wording, what new information arrived, why Mila believes the condition may now be satisfied, and the relevant evidence/provenance. Not built in this slice; the lineage preserved now (the `defer` event's `said`; the `re_surfaced` delta's `requestId`, `observedInRun`, `evidenceRefs`, `rationale`) is what that surface will read.

## 5. The role of `CONDITION_APPEARS_RESOLVED`

Traced against B: it is **the necessary semantic judgment for open-ended conditions** and, under this design, the *only* thing that permits resurfacing. It is not redundant with the derived status: `evidenced` is request-side and mechanical; the observation is decision-side and judged, and it is what carries `why`/`rationale` to her queue. It remains "observation only" in the prompt — it changes nothing by itself; the consumer changes something *because of it*, once, and only with the request's projection cited. Where "enough information" is not subjective (a crisp proposition), the judgment is cheap, not skippable: `evidenced` alone is sufficient for **eligibility**, never for **resurfacing**. Not removable while information deferrals exist; the R1 §6 "option D" (drop it) is withdrawn.

## 6. Idempotency — single consumption

Two existing checks, no new key: (i) `attributeReconsideration` sets `reconsideredInRun` — a second run finds the request ineligible ("already reconsidered in run …"); (ii) `allowed(objective, "re_surfaced")` refuses a row that is no longer `deferred`. Belt and braces, both pre-existing. The event `delta.requestId` additionally lets a reader see whether an Objective was already re-surfaced by this request (no unique index; not needed while (i) and (ii) hold). Tested: repeated observation → refused twice over.

## 7. Athlete governance

`re_surfaced` never turns `deferred → accepted/active`: disposition becomes `unreviewed`, lifecycle stays `proposed`, the row leaves `deferral` and enters her queue. Preserved: the original `defer` event with her words and reason; the resurfacing event with lineage; the deferral kind rule (`athlete` → only her revisit; `time` → the clock). **Presentation gap recorded (not built):** her queue does not show that she deferred it, her words, or the evidence that brought it back — `ReviewContext` would need the `defer` event and the `re_surfaced` delta. A UX slice, not this boundary.

## 8. Evidence lineage — fields used

On the `re_surfaced` event's existing `delta` (jsonb; TS type amended additively): `because: information_available` (existing) · `requestId` · `observedInRun` · `evidenceRefs: [{store, id, at}]` (references, never copies) · `rationale` (existing field; the observation's `why`). Auditable: Objective → event → `requestId` → request (Decision identity: `objective[id]` + question) → `evidenceRefs` → the stores (`inbox_messages`, `athlete_asserted`, …) with their own provenance. On the projection: `ResearchBlock.requestedBy.requestId` (additive, unrendered). **No new column, no schema change; the existing jsonb carries it.**

## 9. C2 / non-Objective behaviour

A requested commercial decision's evidenced request (deal subject) → `eligible: true`, `blocks: requested_decision`; `objectiveResurfaceFrom` refuses ("blocks deal[…], not a deferred Objective"). Nothing written to Objective governance. What eligibility permits there is the reconsidering Brain run itself (a later RECOMMEND reconciles under the withdrawal rule) — unchanged, not built further here.

## 10. Obsolescence

Obsolete request → `eligible: false` with its evidence refs kept; the consumer refuses; no run, no event. Late evidence on an obsolete request is recorded (`receiveEvidence`) and resurrects nothing (`deriveStatus` stays `obsolete`).

## 11. Tests (`brain/reconsideration.test.ts`, 7 tests, pure)

evidenced + unresolved (REQUEST / NO_REQUEST / silent) → no resurfacing · evidenced + gated resolved observation citing this request's block → one `re_surfaced`, lineage on the event, her `defer` event intact · repeated observation → refused twice over · C2 evidenced → eligible, no Objective event · obsolete → nothing · wrong attribution (other Objective's request; block for another Objective; block without request id; a different request's block) → refused · athlete-kind / time-kind → refused · ungated run → ignored · `requestFromDeferredEntry` names the Objective explicitly. Plus `resolution.test.ts` updated for `requestedBy.requestId`. All 13 brain suites (85 tests) and the 7 objective suites (123 tests) green; typecheck clean.

## 12. Schema pressure

None blocking. Recorded: no per-run idempotency on `objective_events` (behavioural only); `ReviewContext` cannot show deferral history or returning evidence; `objective_events` has no `runId` (the delta now carries `observedInRun` for this event only); the request ledger is still a harness file, so "request → Objective" is a file→table link until a request store exists.

## 13. Smallest contract amendments (both additive, no version bump, no prompt change)

- `ResearchBlock.requestedBy.requestId?: string` — set by `evidencedRequestAsResearchBlock`; not rendered (the prompt and the eval-spec digest are unchanged; `targeted-research/0.1.0` keeps its rendered shape).
- `ObjectiveDelta.requestId? · observedInRun? · evidenceRefs?` — lineage on `re_surfaced(information_available)`.
Both are lineage for consumers; neither changes any judgment.

## 14. What remains provider-dependent

The judgment itself: a reconsidering run, shown the projection, emitting a gated `CONDITION_APPEARS_RESOLVED` (the R1 P cell is the one live instance) or a further REQUEST. Whether it re-surfaces reliably on real evidenced requests, and how often it asks for more instead, is empirical — one call per evidenced request when approved. Everything from the gated output to her queue is deterministic and tested here.

## 15. Not done

No provider call. No real athlete. No new acquisition experiment. No production mounting (the store does not call the consumer). No `information_available` writer. No Objective actually re-surfaced. No Recommendation materialisation. No Deals / Rate / State / Campaign / Studio / brand-relationship change. No repeatability matrix. #608 remains the Context Intelligence control. #570 untouched.

---

**Closure record (27 Sep 2026).** One live confirmation under the controlled R1 P condition — `docs/audits/brain-0.8.1-exp-evidence-reconsideration-confirmation.md` (USD 0.041, no rerun). The evidenced request was eligible and moved nothing by itself; the Brain emitted a gated `CONDITION_APPEARS_RESOLVED` citing `research[0]` (`requestedBy.requestId` = the request); the bridge satisfied every precondition with nothing inferred from prose; the offline transition produced `deferred → re_surfaced(information_available) → unreviewed · proposed` with full lineage on the event and the original `defer` event intact; a second application was refused by the request guard (and would be by the ledger guard). The dev Objective was verified unchanged. **evidence → reconsideration judgment → Objective resurfacing is closed at the experimental architecture level.** Still not built: production mounting of the consumer, the governance surface (§4a), any `information_available` writer.

---

## Closure of the vertical slice (27 Sep 2026, reviewed)

**Accepted and closed:** evidence → reconsideration judgment → Objective resurfacing, at the experimental architecture level.

**The larger closure — the missing-information loop is experimentally connected end-to-end:**
`DON'T KNOW` → `REQUEST_INTELLIGENCE` → Intelligence Request → resolver → acquisition → provenance-bearing evidence → `evidenced` → reconsideration eligibility → Brain judgment → governance consequence. The vertical slice is not extended further now.

### Frozen semantic responsibilities

| layer | owns | does not |
|---|---|---|
| **Intelligence Request** | *What information is missing for this Decision?* — a typed `need` | decide whether the athlete's broader condition has been satisfied |
| **Resolver / acquisition** | *How can Nomila obtain evidence capable of answering that need?* | make the strategic decision |
| **`evidenced`** | *qualifying responsive evidence attributable to this request has arrived* | mean the proposition is proven; mean the deferral condition is resolved |
| **Brain reconsideration** | *Given the responsive evidence, what should we now conclude about the blocked Decision?* — for an information deferral, `CONDITION_APPEARS_RESOLVED` is the explicit judgment that the evidence is sufficient for her actual condition | — |
| **Objective governance** | *What happens to the governed Objective after that judgment?* — proven case: `deferred · proposed` → `re_surfaced(information_available)` → `unreviewed · proposed`; she reviews it again; nothing becomes active automatically | infer the judgment |

### Lineage to preserve
Objective → blocked Decision → Intelligence Request → acquisition → evidence → observing Brain run → `CONDITION_APPEARS_RESOLVED` → `re_surfaced` event. The governance-surface requirement (§4a) stands; not built now.

### Backlog kept, not solved because visible
workflow completion concurrency (R8) · non-transactional `recordAssertions` (R9) · request obsolescence → workflow cancellation not automatic (R9) · no generic Mila exposure for acquisition steps · request ledger still harness-only (R9) · no per-run Objective-event idempotency (R10) · assertion source / acquisition-purpose vocabulary pressure (R9) · evidence observed-time pressure (R9) · RESEARCH envelope naming pressure (R1 checkpoint §9a) · governance surface for resurfaced Objectives (§4a) · historical pre-L2 resurfacing events without reasons (confirmation audit §8).

### Stopped here
No more provider calls in this slice; no repeatability matrix; no materialisation of Intelligence Requests or Recommendations; no production mounting; no real-athlete acquisition; no mutable `information_available`; no additional Objective work. Next checkpoint: return to Context / Opportunity Intelligence with #608 as the control.
