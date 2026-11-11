# Brain Experiment 1C — audit (K1–K4 under spec 0.3.1-exp)

**Owner:** Mia
**Date:** 2026-09-26
**Design:** `docs/architecture/commercial-intelligence/brain-experiment-1c.md` (approved with the scope correction: coherence, ownership, coverage and non-duplication — **not** prioritisation).
**What ran:** `brain-eval-spec/0.3.1-exp` (digest `7c4a1980…`; the only change from 0.3.0 is "one or more questions… answer each"), four calls once each, no tuning or rerun. Overlays byte-identical (R2; R2+R1; R2+R4); context unchanged; two new request fixtures carrying only the question and the subject. Artifacts: `docs/audits/artifacts/brain-context-experiment-1/1c/arm/K1..K4.json`; prior artifacts untouched. **Nothing materialised. StartX1 untouched, unread.**

**Headline.** Ownership and the requested/standing relationship are **legible from the existing emitted surface** in all four runs — no structured relationship field was needed to read them. The decision sets are **coherent in three of four** and **incoherent by double ownership in K4**, where the standing positioning decision and the request both claim the identical next step (counter the term sheet, `direct_action`, `advances` the same item, near-identical wording). Across the four runs the standing positioning decision took **four different relationships to the same term sheet** — owning the step itself (K1), planning other work beside two requests that own it (K2), deferring to the request (K3), duplicating the request (K4) — so no stable coordination emerged from the frozen semantics. Suppression did not occur: unrelated Objectives were decided on their own evidence in every run. Two cross-run findings outside the coherence question: the same term sheet was **accepted in K2 and countered in K3 and K4** on different readings of her floors, and StartX1 flipped to `CONDITION_APPEARS_RESOLVED` a second time (K2) on unchanged evidence.

---

## 1. Gates, usage, cost

| run | overlays | requests | tokens in / out / thought | latency | cost | gates | output |
|---|---|---|---|---|---|---|---|
| K1 | R2 | K1a (athlete: gorjana post?) | 12,728 / 2,314 / 8,225 | 53.9 s | $0.030 | pass / pass | accepted |
| K2 | R2 | K2a (agent) + K2b (athlete), same item | 12,748 / 2,509 / 12,059 | 61.5 s | $0.040 | pass / pass | accepted |
| K3 | R2 + R1 | K3a (agent) | 12,851 / 1,757 / 9,098 | 50.9 s | $0.031 | pass / pass | accepted |
| K4 | R2 + R4 | K4a (agent) | 12,853 / 2,035 / 9,267 | 56.6 s | $0.032 | pass / pass | accepted |
| **total** | | | | | **$0.134** | | |

## 2. Ownership tables

Objectives: **Yuwa** `b1c799e3` · **Positioning** `c0f587e4` · **Audience** `feb62891`. NL = Northlight term sheet `work[ctl-r2-northlight-termsheet]`.

### K1 — unrelated request beside a pending term sheet

| decision | type | next step (`what`) | on | cites another decision | relation |
|---|---|---|---|---|---|
| request K1a (gorjana post?) | REQUEST_INTELLIGENCE · connected | proposition: the accepted gorjana deal has a mandated posting deadline or active brief this week | gorjana deal | — | — |
| Yuwa | RECOMMEND · specialized_plan | brand partnership brief and outreach plan | — | no | new_work |
| Positioning | RECOMMEND · direct_action | "Review and respond to the pending Northlight Learning… term sheet" | NL | no | advances |
| Audience | RECOMMEND · specialized_plan | cross-posting plan to reactivate TikTok | — | no | new_work |

Readings: no suppression (all three standing decisions decided on their own evidence, none cites the request). The gorjana answer was **not forced into action**: deliverables and term dates unrecorded → material to *posting* → request, `connected`. Cross-advancement (a gorjana post advancing audience): not mentioned. No duplicate: the audience plan does not cover a gorjana post and the request answer creates no work. One leak in the request's `why_material`: "instead coordinate her next post with… her first home match… on October 16" — advice inside a request, using the schedule for timing. With no request about Northlight, the loop owned the term-sheet step itself — consistent with D2k's deferral in the other direction.

### K2 — two parties, one next step

| decision | type | next step | on | cites another decision | relation |
|---|---|---|---|---|---|
| request K2a (agent) | RECOMMEND · direct_action | "Accept the Northlight Learning term sheet…" | NL | no | advances |
| request K2b (athlete) | RECOMMEND · direct_action | "Accept this partnership…" (second person) | NL | no | advances |
| Yuwa | RECOMMEND · specialized_plan | pitch deck and narrative strategy | — | no | new_work |
| Positioning | RECOMMEND · specialized_plan | "tailored commercial presentation… outreach to other potential partners" — "While she is currently negotiating… with Northlight Learning" | — | no (rationale mentions the negotiation, not the requests) | new_work |
| Audience | RECOMMEND · specialized_plan | cross-platform content strategy | — | no | new_work |

Readings: **two requested decisions were answered; one execution step was created** — both answers are "accept", both advance the same item, neither creates a second piece of work. They agree. Neither cites the other and neither says the other exists: the non-duplication is by outcome, not by any visible coordination. The standing positioning decision **neither defers nor duplicates**: it plans outreach to *other* partners "while she is currently negotiating", which is new work beside a step two requests own — not the same step, but work manufactured while the Objective's next step is covered (property 4, borderline: different step, same Objective).

### K3 — cross-advancement without false deduplication

| decision | type | next step | on | cites another decision | relation |
|---|---|---|---|---|---|
| request K3a (agent) | RECOMMEND · direct_action | "counter… to negotiate a higher fee of at least USD 7,500" | NL | no | advances |
| Yuwa | RECOMMEND · specialized_plan | outreach plan and pitch deck | — | no | new_work |
| Positioning | NO_ACTION | — | NL | **cites `request[K3a]`**: "the strategic next step for this negotiation is currently being addressed under the agent's decision request, making further intervention on this objective duplicate at this time" | deferring |
| Audience | NO_ACTION | — | TikTok series `work[ctl-r1…]` | no | (covered by work in flight) |

Readings, in the two columns the design requires: **same execution step / true overlap** — none: the series and the term sheet were kept separate, neither treated as covering the other, no merged or duplicate content work (no false deduplication). **Same Objective / cross-advancement** — not surfaced: nothing says that the term sheet's four Instagram posts would also advance the audience Objective; the audience NO_ACTION cites only the series. The positioning deferral is explicit and legible — the clearest statement of the "deferring" relationship in the series. The request's counter cites gorjana's real cash component (`work[9acd1d50…]`, USD 7,500) as "demonstrated cash economics" and sums the two floors (USD 3,602 + 4 × 1,000 = 7,602).

### K4 — coherence by suppression?

| decision | type | next step | on | cites another decision | relation |
|---|---|---|---|---|---|
| request K4a (agent) | RECOMMEND · direct_action | "Propose a counter-offer… at least align with her cumulative floors" | NL | no | advances |
| Yuwa | NO_ACTION | — | CSR outreach `work[ctl-r4…]` | no | (in flight, waiting on replies) |
| Positioning | RECOMMEND · direct_action | "Counter the Northlight Learning term sheet to propose a higher fee…" | NL | **no** | advances — **the same step as K4a** |
| Audience | RECOMMEND · specialized_plan | cross-posting workflow "during her current low-travel athletic window" | — | no | new_work |

Readings: **no suppression** — Yuwa's NO_ACTION is grounded in its own in-flight work (S4's pattern), and audience was decided on its own evidence and still planned; "a lot is happening" silenced nothing. **Double ownership** — the standing positioning decision and the request claim the identical step with near-identical rationale (the same 7,602 arithmetic, the same USD 14,000 reference to `commercialPosition.demonstratedEconomics`), and neither refers to the other. Property 3 violated. The schedule-gap conversion recurred on the audience decision ("quiet athletic schedule… presenting a stable window"); logged.

## 3. The relationship, per run — read from the outputs

| run | standing positioning vs the term-sheet step | legible? |
|---|---|---|
| K1 (no request on it) | **owns it** — direct_action on the term sheet | yes |
| K2 (two requests on it) | **plans other work** beside the requests' step; mentions the negotiation, not the requests | yes |
| K3 (one request on it) | **defers** — NO_ACTION citing `request[K3a]` as addressing the step | yes |
| K4 (one request on it) | **duplicates** — the same counter, no reference to the request | yes |

Legibility: in every run the relationship could be attributed from `what`, `advances`, `cites` and the rationale; the design's "illegible" reading did not occur. Coherence: K1, K2, K3 pass the six properties (K2 with the property-4 borderline noted); K4 fails property 3. Consistency: **the same evidence and the same spec produced four different relationships**; D2k had produced a fifth reading of the same configuration (deferral with an explicit "covered by request[D2k]"). No coordination behaviour is stable under the frozen semantics.

## 4. Two cross-run findings, recorded

**Accept in K2, counter in K3 and K4, on the same term sheet.** K2 (and D2k before it) read USD 5,000 against each floor separately (above 3,602; above 4 × 1,000) and accepted. K3 and K4 summed the floors to 7,602, added gorjana's cash (K3) or her USD 14,000 demonstrated high (K4), and countered. All four cite the same State paths. The floors' semantics — additive or not — are not stated anywhere in State or the renderer; the Brain chose differently on different days. A Recommendation that flips between accept and counter on identical evidence is a coherence problem across calls, not within one, and belongs with the reliability findings, not with 1C's question. Not tuned.

**StartX1 `CONDITION_APPEARS_RESOLVED` again (K2).** "Her inbox now shows three highly recent inbound inquiries… persistent interest that can now be actively explored" — the same three detected rows as in every run; nothing retrieved. Second instance in nineteen runs (the first was 1B.3 D1). Both occurred in runs with heavier reasoning load (K2 had the highest thought-token count of the series). The invariant stands and now has two cases: a future `information_available` writer depends on persisted evidence-as-seen, never on this entry.

## 5. Other observations

- K1's request proposition is well-scoped (a deadline or brief *this week*), and its `why_material` correctly makes posting conditional on the unknown; the "instead coordinate her next post with the home match" clause is advice that does not belong in a request.
- `commercialPosition.demonstratedEconomics` was cited for the first time (K4), correctly resolving.
- Within-run controls held on type for Yuwa and Audience relative to their baselines (S4, R1) wherever the same overlay was present.
- Schedule-gap conversion: one instance (K4 audience), plus timing-only use in K1's request; logged, closed for this series.
- No gate refusals; no format lapses.

## 6. What 1C says, as observation

1. **Legible without a coordination field.** Ownership and the standing/requested relationship were readable in all four runs from the existing surface. The case for a structured relationship surface is not made by illegibility.
2. **Coherent by outcome three times, incoherent once.** No suppression anywhere; no false deduplication; no contradiction; one double ownership (K4) and one borderline manufactured-beside-covered (K2's positioning plan).
3. **No stable coordination emerged.** The standing decision's relationship to a requested step varied across owning, planning beside, deferring and duplicating, on identical evidence. The frozen semantics say "answer each question" and "the per-Objective decisions are still required" and nothing about how the two relate — and the outputs show exactly that absence.
4. **Cross-advancement was not surfaced** in either place it was available (K3's four posts; K1's gorjana post), while separate work was correctly kept separate.
5. **Two reliability findings recur** across experiments: floor semantics read differently between runs; a deferred information condition declared resolved on unchanged evidence.

## 7. Not decided here

Whether requested decisions should be independently scoped, participate in standing reasoning, or cause the standing decision to defer is now a design question with evidence on all sides: K3 shows deferral is reachable and legible; K4 shows that without a rule the same configuration duplicates; K2 shows a standing decision can carry on planning beside covered work. That rule — and where it lives (spec semantics, a decision-request door that scopes what the standing loop sees, or a post-hoc coherence check on the set) — is Mia's call. No spec change, no rerun, no Stage-2, no StartX1 read, no `information_available` writer, no production contract.

---

## 8. Review outcome (Mia, 26 Sep) — accepted; closed; no 1D

**The result:** the existing output surface is sufficient to observe ownership and coordination, but the frozen Brain semantics do not determine a consistent relationship between standing decisions and requested decisions. K3 proves deferral / accounting for a requested decision is reachable and legible; K4 proves it is not governed. A semantic design problem now, not a prompt-discovery one.

- **No coordination field.** Ownership was reconstructed from `what`, `advances`, `relation`, `request[…]` and `work[…]` citations; a field is not added to describe what is already observable.
- **Proposed semantics, to design and challenge (not production wording):** *within one Brain evaluation, two decisions must not independently create or advance the same underlying next execution step*; and *when a Decision Request and a standing decision concern the same step, the request answers the posed question; the standing decision may account for it when deciding whether additional work is warranted, but must not independently recreate or advance the step.* Not "requests always win" (K1); not "one work item, one decision" (K2). **Decision multiplicity ≠ execution multiplicity.**
- **Where it lives:** the Brain's decision-set semantics — not the Decision Request door (source, question, subject only), not a post-hoc component that chooses a surviving recommendation. A validator may refuse an incoherent set; it must not author the repaired one.
- **K2:** no canonical "decision owner"; authority to approve or execute is a separate governance question.
- **Reliability findings kept outside the coordination conclusion:** the accept/counter flip as pressure on commercial / rate semantics (several reference values without structured meaning — comparable, additive, historical, product-specific, governing), not prompt-tuned; StartX1 `CONDITION_APPEARS_RESOLVED` twice on unchanged evidence — the invariant *Brain judgment alone must never satisfy an information condition* strengthened, no writer; cross-advancement not reliably surfaced — recorded, not forced into the rule.
- **Next artifact:** `docs/architecture/commercial-intelligence/brain-decision-set-semantics.md`, a design checkpoint, before any spec change, call or production contract.
