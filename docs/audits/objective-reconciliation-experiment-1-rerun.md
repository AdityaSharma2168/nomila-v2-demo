# Objective reconciliation — experiment 1, rerun through L1 (reconciliation 2.0)

**Owner:** Mia
**Date:** 2026-09-25
**What ran:** the same fresh proposal set from experiment 1 (`objective-1.0.1-run-c`, four proposals, frozen evaluator, no new provider call) materialised for real against Mia's governed portfolio on dev under `objective-reconciliation/2.0.0` (L1, #599), after L0 (#598) persisted the evidence-as-seen and the five existing Objectives were backfilled with lineage from their own proposals in the persisted map. Set `87c095ff…`. Nothing tuned; `lineageMin 0.5`, `wordingTieBreak 0.6`, `declineWindowDays 90` as versioned.

**Headline: zero duplicate rows.** Under 1.0.0 the same set would have created three duplicates and re-surfaced one deferral. Under 2.0.0: 0 created · 1 reaffirmed · 1 recorded against a decline · 1 span across two live Objectives · 1 re-surfaced deferral (the 1.0.0 rule, kept until L2).

---

## 1. Every proposal: lineage, every candidate, the relationship

| fresh proposal | lineage (evidence paths) | candidates considered (tier · evidence J · wording J · keys∩) | relationship → verdict |
|---|---|---|---|
| `active-cross-platform-audience-growth` | audienceTrajectory · contentPerformance[instagram] · contentPerformance[tiktok] · findings[mia.audience_scale] · findings[mia.engagement_quality] · preferences[onboarding_goal.grow_my_following] | audience (live, modified): **A · 1.00 · 0.50 · 2** | `continues` → **reaffirmed**; no row |
| `premium-academic-impact-partnerships` | commercialPosition.activeRelationships · findings[mia.brand_fit] · findings[mia.cultural_relevance] · findings[mia.narrative_power] · preferences[onboarding_goal.get_my_first_deal] | positioning (live, modified): **A · 0.83 · 0.24 · 1**; Yuwa (live, modified, *impact* domain): **A · 0.60 · 0.13 · 1** | **`spans`** → `spans_live` on both; **no row; both Objectives unchanged** |
| `secure-startx1-commercial-agreement` | commercialPosition.activeRelationships · commercialPosition.inbound[] · commercialPosition.pipeline · preferences[onboarding_goal.get_my_first_deal] | StartX1 (deferred): **A · 1.00 · 0.67 · 1** | `continues` → **re-surfaced** (1.0.0 deferral rule; L2 refines by the deferral's kind) |
| `acquire-adidas-performance-metrics` | findings[mia.commercial_proof] · materialGaps[] | Adidas (declined 3h earlier): **A · 1.00 · 0.17 · 1** | `continues` → **repeats a decline inside the window**; recorded, not shown |

No `splits`, no `may_relate`. Every candidate above is the *only* candidate for its proposal: no wrong Objective reached either lineage tier.

## 2. Events written (all system-authored, all carrying tier, evidence Jaccard and the proposal key)

| Objective | before | event | after |
|---|---|---|---|
| audience | modified · active | `reaffirmed_by_run` (A · 1.00) | unchanged |
| positioning | modified · active | `spans_live` (A · 0.83, sibling = Yuwa) | unchanged |
| Yuwa | modified · active | `spans_live` (A · 0.60, sibling = positioning) | unchanged |
| Adidas | declined · proposed | `re_proposed_while_declined` (A · 1.00) | unchanged |
| StartX1 | deferred · proposed | `re_surfaced` (A · 1.00) | **unreviewed · proposed** (back in the queue) |

Every row equals its rebuild from events, field for field. Her three modified wordings are canonical and untouched.

## 3. Resulting portfolio

- **`liveObjectives()`**: the same three, in her words: Yuwa, positioning, audience.
- **`reviewQueue()`**: StartX1, re-surfaced.
- **`objectiveHistory()`**: StartX1 (presented, defer, re_surfaced), Adidas (presented, decline, re_proposed_while_declined).
- **Rows**: 5 before, 5 after.

## 4. The invariant, on her real portfolio

The fresh evaluator's consolidation (positioning + Yuwa as one proposal) produced two `spans_live` events and changed neither Objective. Her topology held over the evaluator's. The strengths are recorded (0.83 / 0.60) so the finding can later be surfaced to her as a relationship if that is ever wanted; nothing was merged, and nothing is scheduled to be.

## 5. Does the 0.5 hypothesis behave?

Yes, on this set. Every relationship was found at tier A (same map, opportunity-key overlap) with evidence Jaccard 1.00 / 0.83 / 1.00 / 1.00 and the span at 0.60 — all above 0.5, with nothing else in range. The threshold was not exercised by a near miss. It has still not been tested where it matters most: a fresh *Opportunity* run, where keys change and only tier B applies. That remains the stated re-measurement point.

## 6. Two implementation decisions that changed the page, flagged for review

1. **Lineage tiers are not domain-gated.** The page said tier B is "any map, same domain". The experiment's own span is cross-domain: the positioning proposal folded the Yuwa Objective, whose domain is `impact`. With gating, this rerun would have reported `continues → reaffirmed` on positioning and silently missed the consolidation. Gating removed for tiers A and B; the wording tie-breaker (C) stays domain-gated; `sameDomain` is recorded on every candidate (the Yuwa candidate carries `sameDomain: false`).
2. **One live match beats a stronger non-live one on the same ground.** Surfaced by a test, not by Mia's data: with cross-domain lineage, a proposal can match a live Objective and a deferred sibling at once, and the strongest match was the deferred one. `continues` now prefers a live match; the sibling stays visible in candidates rather than being re-surfaced past her governed Objective.

## 7. What is still wrong, and known

StartX1 re-surfaced on unchanged evidence, against her stated condition ("evaluate the opportunity first"). That is the 1.0.0 deferral rule, kept deliberately until L2, and this rerun is its exhibit: evidence Jaccard 1.00 means *nothing changed*, and it came back anyway. L2's approved rule (information deferrals never auto-resurface; time and athlete kinds implemented) is the fix. StartX1 is left in the queue as it is; she is not asked to act on it before L2 lands.

## 8. Ambiguous or surprising

- Nothing ambiguous in the relationships: one candidate per proposal, all tier A.
- The surprise was the domain gate (§6.1), found because the test suite was written against the experiment's own topology rather than a tidy fixture.
- Wording Jaccard against the *original* evaluator wording (0.50 / 0.24 / 0.67 / 0.17) confirms again that wording would have matched one of four; it is reported on every candidate and decides nothing.

Stopped before L2.
