# Objective reconciliation — experiment 1

**Owner:** Mia
**Date:** 2026-09-25
**Question:** with real governed Objectives in place, does a fresh run of the frozen Objective evaluator reconcile against them under `objective-reconciliation/1.0.0` (similarity `0.6`, decline window `90 days`), or duplicate them?
**Nothing tuned.** Evaluator `objective-eval-spec/1.0.1` (digest `5c9087b8…`), inputs the retained Run D `{state, map}` for Mia, block rendered with the two deterministic fixes (#595). One provider call, $0.031. Artifact: `docs/audits/artifacts/objective-1.0.1-run-c/Mia_Bhuta.json`.

**Not materialised.** Reconciliation is deterministic, so the verdicts below are exactly what `materialiseProposalSet` would write. Three of four would create duplicate rows in her real queue, and there is no delete path by design. The set is persisted only as an artifact until the result is reviewed.

---

## 1. The governed portfolio going in (dev, as of 25 Sep 01:33Z)

| Objective | disposition / lifecycle | her wording |
|---|---|---|
| audience growth | modified · active | "Grow my audience and build a stronger, more consistent presence across Instagram and TikTok." |
| positioning | modified · active | "Build my positioning at the intersection of athletics, technology, AI, innovation and entrepreneurship, and secure partnerships that align with that identity." |
| Yuwa | modified · active | "Expand the impact and visibility of my work with Yuwa through aligned global brand and CSR partnerships." |
| StartX1 | deferred · proposed | "I don't know enough about StartX1 yet … Evaluate the opportunity first." |
| Adidas data | declined · proposed | "…collecting evidence is an action that supports my commercial objectives, not an objective itself." |

## 2. The fresh raw proposals, before reconciliation

Four, 0 notes; all gates passed.

| key | domain · origin | rests on | desired state |
|---|---|---|---|
| `active-cross-platform-audience-growth` | audience · joint | `grow-instagram-posting-cadence`, `unlock-tiktok-channel` + `grow_my_following` | "Her social media audience trajectory is in an active growth phase across both Instagram and TikTok." |
| `premium-academic-impact-partnerships` | positioning · joint | `grow-academic-tech-partnerships`, `amplify-yuwa-philanthropic-work` + `get_my_first_deal` | "Her commercial brand portfolio features active partnerships with corporate social responsibility (CSR), STEM, or educational tech brands." |
| `secure-startx1-commercial-agreement` | commercial · joint | `amplify-inbound-startx1-interest` + `get_my_first_deal` | "She has an active, formalized commercial partnership with StartX1." |
| `acquire-adidas-performance-metrics` | evidence · nomila | `unlock-adidas-historical-performance-data` | "Her commercial profiles contain verified campaign performance metrics, audience retention figures, and financial valuations from her historic Adidas NIL contract." |

Note the evaluator consolidated differently this time: positioning and Yuwa became one proposal (four proposals, not five), and the two content openings again became one audience outcome.

## 3. Reconciliation verdicts

Token Jaccard on desired-state wording, same domain only, best of the Objective's current wording and its `modifiedFrom` original.

| fresh proposal | closest existing (same domain) | vs her wording | vs evaluator's original | verdict | what would happen |
|---|---|---|---|---|---|
| audience | audience (live, modified) | 0.22 | **0.50** | **new** | a duplicate of a live Objective enters the queue |
| positioning | positioning (live, modified) | 0.04 | 0.24 | **new** | a duplicate enters the queue; the Yuwa half is invisible to matching (different domain) |
| StartX1 | StartX1 (deferred) | 0.67 | — | **re_surfaces** | returns to the queue, unchanged, despite "evaluate the opportunity first" |
| Adidas | Adidas (declined 25 Sep) | 0.17 | — | **new** | the 90-day suppression does not fire; a duplicate of a 3-hour-old decline enters the queue |

**One match in four.** The only match is the one where the evaluator happened to keep nearly the same words.

## 4. What this shows

1. **Wording similarity is the wrong identity for an Objective once the athlete has governed it.** Her rewrites are first-person and reframed; Jaccard against them is 0.04–0.22. Matching against `modifiedFrom` was meant to cover this and reaches only 0.24–0.50, because the evaluator itself rephrases at temperature 1.0.
2. **The 0.6 threshold is not the problem; the axis is.** Lowering it to catch 0.50 would still miss 0.17 and 0.24 and would start matching unrelated outcomes in the same domain.
3. **Provenance already identifies them.** Every fresh proposal cites the same opportunity keys as the Objective it duplicates: audience → the same two content openings; positioning → the academic opening (plus Yuwa's); StartX1 → the same inbound opening; Adidas → the same evidence opening. Overlap on `fromOpportunities` would have matched 4 of 4, and would have flagged the positioning proposal as touching *two* live Objectives. This is an observation, not a change.
4. **`re_surfaces` on a deferral is technically correct and semantically wrong here.** Her deferral named a condition ("evaluate the opportunity first"). Nothing changed between runs, so re-surfacing the same proposal is noise. A deferral carries a reason the rule does not read.
5. **A decline's protection is only as good as the match.** Adidas was declined three hours earlier with a precise reason; a rephrased duplicate walks straight past the window.
6. **Consolidation drift.** The evaluator folded Yuwa into positioning this run. Under the current rule that is a "new" proposal in the positioning domain that partly duplicates two live Objectives; under a provenance rule it is a consolidation to surface as such, not a new outcome.

## 5. On the portfolio question

Are the three live Objectives a representative portfolio of what Mia wants Nomila to help with, or the survivors of one evaluator batch? On this evidence: **the survivors of one batch, materially improved by her.** Three observations. Every live Objective descends from the Run D opportunity map; nothing in the portfolio came from her directly (the athlete-created path exists and was not used). Two of the five proposals were the wrong layer, and their absence from the portfolio is governance working, not coverage. And the run that followed proposed nothing outside the same territory, because the frozen evaluator sees the same State and map. Whether the portfolio is *representative* cannot be answered from proposals alone; it needs her stated goals from outside the evaluator's loop, which is exactly the athlete-created path and the intent-acquisition question already on the list. That is the input the Brain should not assume it has.

## 6. Two things preserved from the checkpoint, untouched

- **Adidas and StartX1 are different failures.** Adidas: evidence acquisition promoted to the Objective layer (belongs downstream as a Recommendation / "Needs you"). StartX1: broad intent (`get_my_first_deal`) plus one specific inbound opening was enough to make a *specific* partnership `joint`; the question is what evidence a specific commercial outcome needs before it is proposed as an Objective.
- **The three modifies were substantive**, not copy edits: positioning broadened the territory; Yuwa made impact the purpose and partnerships the mechanism. Third-person evaluator prose is a rendering concern, separate from that.

## 7. Defects fixed before this run (#595)

The State renderer's pad overflow (`…]WANTS` run together) and the context parser's dependence on a separator. The block is evidence, excluded from every digest; no pin moved. The parser also reads pre-fix records, so the onboarding-intent lines on Mia's presented set now resolve.

**The review-context contract, traced (not redesigned).** `objective_proposal_sets` persists the set and the run record, and the record carries the evaluator's inputs only as rendered text. The composed `AthleteState` is not persisted anywhere (it is a view composed on demand) and the `OpportunityMap` exists only in run artifacts. So the surface parses text because text is the only form of the evidence-as-seen that survives the run. Transitional by necessity; the structured fix is to persist the State snapshot and map on the set row and resolve citations with `resolveStatePath`.

---

Stopped here. No evaluator, threshold, window, rule, State or UI change made on this result.
