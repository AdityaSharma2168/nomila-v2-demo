# Commercial Intelligence ↔ Brain boundary — experiment audit (14 calls, 26 Sep 2026)

**Status:** results recorded; nothing changed after the calls. No production contract, no fix, no rerun, no prompt change, no integration. Design: `docs/architecture/commercial-intelligence/commercial-intelligence-brain-boundary-checkpoint.md` (§9.1 interpretation rule applied throughout). Fixtures: `docs/audits/commercial-intelligence-boundary-fixtures.md`. Artifacts: `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/arm/<cell>/<label>.json` (`{inputs, record}` per call). Model `gemini-3.5-flash`; total cost **USD 0.351**; nothing materialised.

**One incident, recorded:** the first invocation of D2 died on a Cloud SQL proxy timeout during the State read, before any provider call and before any artifact was written; it was invoked once more and ran. No call was repeated.

**Headline.** With interpreted commercial meaning attached to the term sheet, the Brain **consumed it in every run that received it** — 7 of 7 answers to "advance, counter or accept" cited `.band` (and `.basis`, `.absent`, `.unknown`), none summed floors, none used gorjana's cash or the USD 14,000 high, and all seven landed on the same side of the axis (counter), against a control that accepted on the old floors-read-separately reading. That is **boundary support with producer correctness unresolved**: every one of those seven rests on the producer's BELOW, which rests on a per-deliverable reading against a monthly-retainer range raised by a unit-less floor, and no run noticed. Numbers alone did not help (A1 summed the floors to 7,602 and reached for the card's highs). Placement made no difference to consumption, and no standing decision used the block in either placement. One subject-level block supported two decision-relative answers (A5). With history withheld the Brain still decided on the block (B1) where without the block it had asked for history (B0). At the thin end the block was **not** consumed: Ronaldo was declined from his researched earnings rather than priced against a basis or requested; Lilia's answers were a request to the athlete about deliverability, which pre-empted pricing. No thin cell fell into the "no deals" trap, so that attribution is limited. Seven of fourteen sets were refused by the structural gate on id formatting, zero on content, zero on grounding.

---

## 1. The complete result matrix

| cell | condition · placement | gate | request answer (D2k / D2k-C / D2k-D) | grounds of the commercial claim | standing (Yuwa / positioning / audience) | deferred StartX1 |
|---|---|---|---|---|---|---|
| A0 | C0 control | OK | **accept** · direct_action · advances R2 | `floors[ambassador]` 3,602 < 5,000; `floors[socialPost]` × 4 = 4,000 | REC plan / NO_ACTION (defers to request) / REC plan | REQUEST |
| A1 | C1 numbers · work | **refused** (ids) | **counter to ≥ 7,602** | floors summed (3,602 + 4 × 1,000); `rateCard.socialPost` and `.ambassador` highs cited to inflate | same | **CONDITION_APPEARS_RESOLVED** |
| A2 | C2a mounted · work | OK | **counter** "to her ambassador floor of USD 3,602 per deliverable" | `.band`, `.absent`, `.unknown`, `floors[ambassador]` | same | **CONDITION_APPEARS_RESOLVED** |
| A3-1 | C2 full · work | **refused** (ids) | **counter** | `.band`, `floors[ambassador]` | same | REQUEST |
| A3-2 | C2 full · work | OK | **counter** | `.band`, `.absent`, `.unknown`, `floors[ambassador]` | same | REQUEST |
| A3-3 | C2 full · work | OK | **counter** | `.basis`, `.band`, `floors[ambassador]` | same | REQUEST |
| A4 | C2 full · **state** | **refused** (ids) | **counter** | `assessment.basis/.band/.absent/.unknown`, `floors[ambassador]` | same | REQUEST |
| A5 | C2 full · work · D2k + D3 | **refused** (ids) | D2k **counter** "to 3,602 per deliverable (totalling 14,408)"; D3 **proceed alongside** | D2k: `.band`, `floors[ambassador]`; D3: `.exclusivity`, `activeRelationships`, `work[gorjana]` | same; positioning cites both requests | REQUEST |
| B0 | C0, history withheld | OK | **REQUEST_INTELLIGENCE** (Adidas contract terms / ROI, `connected`) | `floors` read separately ("exceeds individual baseline floors"); `materialGaps[0,1]` | same | REQUEST |
| B1 | C2 full · work, history withheld | OK | **counter** | `.band`, `floors[ambassador]` | same | REQUEST |
| C0 | C0 (Ronaldo) | **refused** (request id) | **decline** | `findings[mia.audience_scale]` 679 M, `findings[mia.cultural_relevance]` USD 65 M off-field | — (zero live) | — |
| C2 | C2 full · work (Ronaldo) | **refused** (request id) | **decline** | same findings; "1,250 per post" stated without citing `.basis`; no `.range`/`.band`/`.observed` cite | — | — |
| D0 | C0 (Lilia) | OK | **REQUEST_INTELLIGENCE** (`athlete`: will she run a public Instagram) | `findings[mia.audience_scale]`, `materialGaps[0]`, `preferences[onboarding_goal.get_my_first_deal]` | — | — |
| D2 | C2 full · work (Lilia) | OK | **REQUEST_INTELLIGENCE** (same) | `findings[mia.audience_scale]`, `materialGaps[0]`; no block line cited | — | — |

Refused sets are read as refused sets and marked so; their content is reported because the refusals were on identifier formatting, not on content or grounding.

## 2. Gate results

- **Structural:** 7 of 14 refused — A1, A3-1, A4, A5, C0, C2 wrapped ids as `objective[<id>]` / `request[<id>]` in the `objective_id` / `request_id` fields (the 1B formatting failure, there 2 of 6). No refusal for a forbidden field, a missing decision, a production-verb opener or an unrequested answer. The rate is higher than any prior series; A0 and B0 (no block) passed, and six block-supplied runs passed, so it is not attributable to the block on this evidence. Not tuned; a reliability item (§12).
- **Grounding:** 0 problems in 14. Every cited reference resolved, including the seven `work[<id>].<key>` and four `commercialPosition.assessment.<key>` citations.
- **Truncation:** none. Finish reason STOP in all 14.

## 3. Decisions and paths

Every request answer that recommended chose `direct_action` · `advances_existing_work` · `advances: work[<the sheet>]` — the bounded-step reading held in all 11 RECOMMEND answers. The three REQUEST_INTELLIGENCE answers (B0, D0, D2) requested and did not price. Standing decisions were identical in type, path and relation across all ten Mia runs: Yuwa RECOMMEND · specialized_plan · new_work; positioning NO_ACTION deferring to the request (citing `work[R2]` and `request[D2k]`, and in A5 both requests); audience RECOMMEND · specialized_plan · new_work. **No contamination:** the Yuwa and audience decisions never cited a commercial line and did not change under any condition or placement.

## 4. Citations actually used

| line | cited by | never cited by |
|---|---|---|
| `.band` | A2, A3-1, A3-2, A3-3, A4 (state path), A5, B1 — 7 of 7 block-supplied Mia runs | C2, D2 |
| `.basis` | A3-3, A4 | the others (its number was restated in A2, A5, B1, C2 without citation) |
| `.absent` | A2, A3-2, A4 | A3-1, A3-3, A5, B1, C2, D2 |
| `.unknown` | A2, A3-2, A4 | the rest |
| `.exclusivity` | A5 (D3) | every D2k answer |
| `.range` | — | all — the range figures were carried by `.band`'s detail string and by `floors[ambassador]` |
| `.value`, `.offer`, `.contract_9acd1d50` | — | all |
| `.history_1` (gorjana INDIRECT), `.history_2`, `.high` | — | **all** — and no run used gorjana's cash or the USD 14,000 high in any condition, including the controls |
| `.observed` | — | all — no run in B1, C2 or D2 cited the observed-ness line |
| C1 `rateCard.*` | A1 (`socialPost`, `ambassador` highs) | — |
| `representation.floors[ambassador]` | every Mia request answer, 10 of 10 | — |
| `representation.floors[socialPost]` | A0, A1, B0 — **only the runs without interpreted meaning** | every C2/C2a run |

Reading: the Brain used the block for the position of the offer (`.band`) and for what is absent or unknown; it did not use the block for history, the demonstrated high, the guaranteed value, the contract line or observed-ness. Whether that is because those lines were unneeded for this decision (the controls did not misuse history either) or because they were not salient cannot be separated on this run.

## 5. Own arithmetic and reconstructed semantics — per claim, with the §9.1 dimensions

| run | commercial claim | source of commercial reasoning | producer semantic status |
|---|---|---|---|
| A0 | 5,000 > 3,602; 4 × 1,000 = 4,000 → accept | raw evidence / Brain-derived | — (no producer) |
| A1 | 3,602 + 4,000 = 7,602 "combined floor"; card highs "mid-range over 6,100" | raw evidence / Brain-derived (numbers present, semantics reconstructed) | — |
| A2 | 1,250 per deliverable is BELOW 3,602–3,718 → counter "to 3,602 per deliverable" | Commercial Intelligence block (the reading) + Brain-derived (the counter *figure*, treating the floor as per-deliverable) | **known unresolved** — per-deliverable vs monthly-retainer basis; unit-less floor |
| A3-1 / A3-2 / A3-3 | same reading → counter; A3-3 "3,602 per deliverable" | block; the "per deliverable" unit inherited from the producer | known unresolved |
| A4 | same, from State-placed lines | block | known unresolved |
| A5 D2k | 3,602 × 4 = **14,408** as the counter total | **mixed** — the block's basis, the Brain's multiplication into a counter amount | known unresolved, and a new observation: the producer's unit becomes the Brain's unit silently |
| A5 D3 | no category exclusivity; gorjana is jewellery → proceed | block (`.exclusivity`) + State + work | internally coherent on the supplied evidence |
| B0 | "exceeds individual baseline floors" but pricing power unknown → request Adidas terms | raw evidence / Brain-derived (floors read separately again); `materialGaps` | — |
| B1 | as A3 | block | known unresolved |
| C0 | 5,000 is "extremely undervalued" for the highest-paid athlete → decline | raw evidence / Brain-derived (researched earnings, no rate basis) | — |
| C2 | same; "1,250 per post" restated | **mixed** — the block's per-post figure, the judgment from research; the block's NOT_ESTABLISHED lines ignored | producer said NOT_ESTABLISHED; the Brain priced anyway from research |
| D0 / D2 | deliverables need a public Instagram she does not run → request | raw evidence (State) — not a commercial-pricing claim | — |

**Floor summing:** absent in every run that received interpreted meaning (7 of 7); present in A1 (numbers only) and implicit in A0/B0 (4 × 1,000). **History as benchmark:** absent everywhere, controls included. **Unit awareness:** no run mentioned the monthly-retainer basis, the unit-less floor, or asked for clarification of the basis; every C2/C2a run took "3,602 for ambassador" as a per-deliverable figure because `.basis` said "per deliverable". **Counter figures:** A1 (7,602), A2 ("3,602 per deliverable"), A5 (14,408) — the Brain composes counter amounts, which the checkpoint places in Deals execution.

## 6. REQUEST_INTELLIGENCE and `not_seen`

- **Request answers:** B0 requested Mia's Adidas contract terms and campaign ROI (`connected`; the proposition presumes the answer — "…that exceeds her baseline floor values", the R5/S5 pattern); D0 and D2 requested whether Lilia will run a public Instagram (`athlete`), a deliverability question the term sheet turns on, grounded in `findings` and `materialGaps`. No request asked for a market rate, a basis clarification or a rights term.
- **`not_seen` on the counters:** usage rights named in A2, A3-1, A3-2, A4, A5, B1 (six of seven) as unknown/needed — from `.unknown` where cited; "campaign timeline / deadlines" in A2, A3-2, A4, B1 — from `.absent`. **None asserted that the sheet omitted usage rights**: A2's `why` says "usage rights clarity" is lacking, A3-2's "absent or unknown", A4's "usage rights terms are unknown" — the UNKNOWN discipline held in wording, with A2's "resolve these omissions" the closest to crossing it. Exclusivity was never requested and never called unseen (K4's misreading did not recur).
- **Deferred StartX1:** REQUEST_INTELLIGENCE in 8 of 10 Mia runs; **CONDITION_APPEARS_RESOLVED in A1 and A2** on unchanged evidence (three detected inbounds) — the unsupported flip recorded in 1B.3 D1 and 1C K2, now twice more. Not attributable to the block (A1 has numbers only; A3 ×3, A4, A5, B1 with the full block did not flip).

## 7. A3 ×3 stability

Counter · direct_action · advances R2 in **3 of 3**, each grounded on `.band` (A3-3 also `.basis`), none summing floors, none using history; wording and the `not_seen` list drifted as always. Against the historical 3 accept / 4 counter on identical inputs under 0.3.x/0.4.0, and A0's accept the same day. Read with A2, A4, A5 and B1: **seven of seven block-supplied runs on one side of the axis, on the same cited line.** Per §9.1 this is *boundary support + unresolved producer-semantic correctness*; it is not a finding that counter is the right commercial decision. One of the three (A3-1) was a refused set on id formatting; its content is identical in type, path, relation and grounds.

## 8. A3 versus A4 — placement

Identical decision, path, relation, grounds and `not_seen` shape; A4 cited the State paths (`commercialPosition.assessment.basis/.band/.absent/.unknown`) exactly where A3 cited the work sub-paths. **No standing decision cited the block in either placement** — positioning's NO_ACTION cited `work[R2]` and `request[D2k]` in both; Yuwa and audience cited nothing commercial. So on this run, placement was an engineering choice for the request answer, and State placement bought no uptake by athlete-level standing reasoning. The evidence leans toward the block being **decision-relative evidence attached to its subject**, not an athlete-level State section. One run each; A4 was a refused set.

## 9. A5 — decision-relative materiality from one subject-level block

Two questions about one sheet, one block. D2k (advance / counter / accept) turned on `.band` and named timeline and usage rights as unseen. D3 (proceed alongside her other relationships) turned on `.exclusivity` ("no category exclusivity"), `activeRelationships` and gorjana's category, named "exclusive category parameters in her active gorjana agreement" as unseen, and **did not mention compensation**. The standing positioning decision cited both requests and did not own the step. **Supported:** the Brain derived decision-relative materiality from a subject-level assessment; no decision-specific block was needed for this pair. Also observed: D2k's counter total of 14,408 (own multiplication on the producer's basis). Refused set on id formatting.

## 10. B / C / D — graceful degradation

- **B (Mia, history withheld).** B0 without the block: the Brain would not decide — it requested her historical pricing power (Adidas terms, ROI) and read the floors separately meanwhile. B1 with the block: it decided on `.band` exactly as A3, requested nothing about history, and never cited `.observed`. **History was not a prerequisite once meaning was present; without meaning the Brain treated absent history as a reason not to decide.** That is the cleanest degradation result of the run and it supports the enrichment-not-prerequisite constraint.
- **C (Ronaldo, public).** Both runs declined the sheet as an extreme undervaluation, grounded in `findings` (679 M followers; USD 65 M off-field earnings, with sources). Neither cited `.range NOT_ESTABLISHED`, `.band NOT_ESTABLISHED`, or `.observed`; neither requested a rate basis or floors, though both listed "floors / rate card unstated" in `not_seen`. **The block was not consumed at this end**, and the Brain priced from researched earnings without a commercial basis. By §8's own rule that is a pricing judgment without a cited basis — grounded in real evidence, but not in Commercial Intelligence. No "first partnership" / "no deals" inference in either run: the MEASURED 0 line did not mislead, so the trap did not fire in the control and attribution to `.observed` is not possible (§9.1: a limitation, not evidence against).
- **D (Lilia, revoked mailbox, 39 detections, placeholder card).** Both runs requested, from the athlete, whether she will run a public Instagram — the term sheet's deliverables cannot be fulfilled on a channel she does not operate. Neither priced; neither cited the block's NOT_ESTABLISHED lines (the deliverability question pre-empted the price question); neither read the 39 detections or `closedDeals 0` as "no deals" or "first deal" (D0 cited her own onboarding goal `get_my_first_deal`, an athlete statement, not an inference). Same decision with and without the block. The control did not fail; attribution limited.

Across the thin cells the block changed nothing observable; the boundary's degradation claim is **supported for B and unshown for C and D** — and C shows a real gap: when the producer says NOT_ESTABLISHED, the Brain substitutes research for a basis rather than asking for one.

## 11. Boundary result, kept separate from producer-correctness findings

**Boundary / responsibility (who owns commercial interpretation).**
- Supported on the connected case: interpreted meaning was consumed in 7 of 7 runs; own floor semantics (summing, per-item reading of the ambassador floor as a total) disappeared; the accept/counter axis went from 3/7 to 7/7 on one cited line; the same block served two decision-relative questions; placement did not matter; history was not required.
- Not supported by numbers alone: A1 summed floors and inflated with the card's highs — meaning, not data, is what the Brain lacked. (One run, a refused set.)
- **Not shown for the comparability layer:** A2 (mounted only) already did not use gorjana or the USD 14,000 high, and neither did A0 or B0 this time, so H-mounted's premise (that the K3/K4 history-as-benchmark failure recurs without comparability lines) did not reproduce. No run cited a history line. The additional layer's necessity is **unresolved on this run**, not disproved.
- Not honoured at the thin end for a famous public athlete: C2 ignored NOT_ESTABLISHED and priced from research.
- The Brain composes counter amounts on the producer's basis (A2, A5) — HOW leaking into WHAT.

**Producer correctness (is the supplied meaning valid) — all frozen, none adjudicated here.**
- BELOW rests on 1,250 per deliverable against an ambassador range that is a monthly retainer, raised by a floor with no unit. Every counter in the run inherits it. **No run noticed.** The interface transmitted a unit it does not type.
- `timeline` means deadline; `term_months` / `counts_basis` never set; null `counts_basis` contradicts its comment; gorjana INDIRECT; Lilia's placeholder card dropped; gorjana's missing period record. None surfaced in any rationale.

## 12. New pressure created

1. **Commercial Intelligence needs typed unit / basis semantics.** The Brain adopted "per deliverable" and "3,602" as commensurable because the block said so, then multiplied. A basis without a typed unit (per deliverable · per month · per year · per term) and a floor without a unit are transmitted as if commensurable. This is the strongest new finding and it sits in the producer, not the Brain.
2. **NOT_ESTABLISHED needs a next step.** For Ronaldo the producer said no card, no basis; the Brain filled the gap from research. Either Commercial Intelligence supplies an estimate with anchor basis and confidence (the Rate 2.0.0 evidence class, unmounted) or the Brain must treat NOT_ESTABLISHED as a REQUEST_INTELLIGENCE trigger (`external`, a market rate). Pressure on Rate (mount an estimate class for researched athletes) and on the Brain contract (a rule for unestablished bases) — which one is a boundary decision, not made here.
3. **Counter amounts are being composed by the Brain.** A1 7,602, A2 3,602-per-deliverable, A5 14,408. Deals owns counter arithmetic; the Brain should say *counter* and *why*, and the execution path should compute *how much*. Pressure on the Brain contract (RECOMMEND `what` must not carry a figure) or on Deals (expose the counter basis as HOW).
4. **State:** `materialGaps` (Adidas terms) became the Brain's reason not to decide in B0 — a gap list is being read as a decision prerequisite; `closedDeals MEASURED 0` did not mislead in C or D this time, so the §0.1.2 defect stays a correctness item without a Brain-level symptom yet. Floors in State are still consumed as unit-less numbers (`floors[socialPost]` × 4 in every run without meaning).
5. **Brain contract reliability:** 7 of 14 sets refused on identifier formatting under an unchanged spec; StartX1 declared resolved twice more on unchanged evidence; REQUEST propositions that presume their answer (B0). None tuned. The production contract will need structured output for ids and a rule for information conditions that the Brain keeps flipping.
6. **What the Brain never read:** `.value`, `.offer`, `.contract_*`, `.history_*`, `.high`, `.observed`, `.range` as such. Before those become contract fields, a run where the decision actually turns on them (a mixed cash/product offer; a decision about renewing gorjana; an athlete whose only history is comparable) is needed. Not proposed here.

## 13. Not done

No change after the calls. No production contract, no fix to any producer, no rerun, no prompt or spec change, no `CommercialAssessment` schema, no Deals, Rate, State, Objective, Campaign or Studio change, no integration, #608 and #570 untouched. Fourteen artifacts, USD 0.351.
