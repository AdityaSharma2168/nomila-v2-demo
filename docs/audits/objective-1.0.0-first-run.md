# Objective 1.0.0 — first provider run and audit

**Owner:** Mia
**Date:** 2026-09-22
**Spec:** `objective-eval-spec/1.0.0` · digest `d3aba4b5…` · no tools · prompt identical for all four
**Inputs:** the frozen Run 3 Opportunity artifacts — each athlete's exact `{ state, map }` pair, so `map.stateAsOf === state.asOf` and the run is reproducible
**Scale:** 4 athletes, 13 opportunities in, **13 proposals out**, $0.079
**Raw:** [`artifacts/objective-1.0.0-run/`](artifacts/objective-1.0.0-run/)

Nothing tuned. Nothing fixed after.

---

## Headline

**Both gates passed for all four — and the evaluator performed no selection at all.**

| athlete | opps in | proposals out | consolidated | not carried | notes |
|---|---|---|---|---|---|
| Mia | 4 | 4 | 0 | 0 | 0 |
| Riya | 2 | 2 | 0 | 0 | 0 |
| Lilia | 3 | 3 | 0 | 0 | 0 |
| LeBron | 4 | 4 | 0 | 0 | 0 |
| **total** | **13** | **13** | **0** | **0** | **0** |

Strictly 1:1. Every proposal cites exactly one opportunity, and **zero notes were written across all thirteen** — the thing the design called *"the declining is the deliverable"* was never exercised once. The portfolio-accounting invariant is satisfied, trivially: the degenerate mapping accounts for every opportunity by making each one a proposal.

This is the failure the design predicted (*"Opportunity count should not dictate Objective count"*) and deliberately declined to prevent with a numeric cap. The construction it relied on instead — outcomes are fewer than openings because an athlete has fewer intended outcomes than evidence — did not bite, because the evaluator never attempted a consolidation for it to bite on.

---

## Quantitative report

| measure | result |
|---|---|
| proposals per athlete | 4 · 2 · 3 · 4 |
| cardinality | 1:1 throughout; no proposal cites two opportunities; no opportunity feeds two proposals |
| consolidated / not carried | 0 / 0 |
| athlete-intent-only proposals | **0** — every one of the four States holds **zero recorded preferences**, so the intent path was structurally exercised zero times. Expected, and flagged before the run |
| joint proposals | 0, for the same reason |
| origin | 13 × `nomila`, all derived at normalisation; the evaluator emitted none |
| domains | evidence **6** · audience 2 · positioning 2 · impact 1 · athletic 1 · content 1 — an exact mirror of the map, because 1:1 |
| quantified / non-quantified | **1 / 12**. The one: LeBron `closedDeals`, baseline **0 read from State**, `at_least 5` |
| horizon | null **11** · `this_season` 2 (both LeBron; both grounded — 24th season per E1, Polymarket signed Sept 2026 per E6) |
| citation resolution | 100% — gate 2 passed for all four |
| provenance validity | 100% |
| portfolio accounting | valid, and degenerate |
| prescription leakage | 0 opening execution verbs (gated); 0 imperatives on read |
| unsupported current-state claims | **1** — see LeBron #11 |
| unsupported desired-state claims | 0 |
| Opportunity paraphrase (heuristic) | max Jaccard 0.39, all under the 0.6 gate. On read, 6 are grammatical reformulations — see value-add |
| invented numeric targets | 0 invented from nothing; 1 loosely grounded — see #13 |
| invented deadlines | 0 (structurally impossible) |
| brand / archetype invention | 0. No brand characterised; Lilia's "parent-supervised" traces to her own State |
| duplicates / inflation | 0 duplicates (gated). Inflation is the 1:1 itself |

---

## Per-proposal audit

Entailment against the cited State (traced through M.I.A. rationale and cited evidence). Value-add: **A** synthesis/consolidation/outcome formation · **B** legitimate strategic interpretation · **C** mostly reformulation · **D** weak.

| # | athlete | proposal | domain | entail | value | note |
|---|---|---|---|---|---|---|
| 1 | Mia | audience trajectory reversed | audience | SUPPORTED | B/C | adds a concrete observable ("net positive growth over consecutive months"); otherwise the opening as a state |
| 2 | Mia | portfolio includes tech/education partnerships | positioning | SUPPORTED | **B** | forms a real outcome from "extend positioning": *at least one relationship in tech or higher-ed*. Symbolic Systems and MS are in `narrative_power`'s rationale (E3); `activeRelationships = [gorjana]` grounds "do not yet align" |
| 3 | Mia | Yuwa structured as a co-branded initiative | impact | SUPPORTED | **B** | outcome formed; observable is concrete (a partner co-funds or co-promotes) |
| 4 | Mia | representation has API access + Adidas terms | evidence | SUPPORTED | C | the three gaps restated as a dashboard state |
| 5 | Riya | single verified identity | evidence | SUPPORTED | **B** | E1/E2 fully support the US/India ambiguity; the outcome is a genuine end state |
| 6 | Riya | verified digital presence **or confirmed absence** | evidence | SUPPORTED | B/C | the "or a certified status that she does not operate public platforms" clause is a real contribution — a negative confirmation is a valid end state the opportunity did not name |
| 7 | Lilia | parent-supervised socials active | audience | SUPPORTED | C | highest Jaccard (0.39); the opening in state form |
| 8 | Lilia | dual narrative with sister | positioning | SUPPORTED | C | restatement |
| 9 | Lilia | Hudl + family YouTube metrics integrated | evidence | SUPPORTED | C | tooling outcome |
| 10 | LeBron | maintains availability, minimises games missed | athletic | SUPPORTED | **B** | **the layer de-prescribed its source.** The opportunity said *"Implement strict load management and physical maintenance protocols"* — the one prescription leak we had. The objective says *"maintains consistent active availability and minimizes games missed"* — an outcome. E1 (24th season) and E8 (17 games, arthritis, sciatica) ground it. Remit caveat stands: not something Nomila delivers |
| 11 | LeBron | football content is a prominent pillar | content | **PARTIAL** | C | current_state asserts *"his current digital channels do not yet feature a coordinated output of football-related promotions."* **State says nothing about his channel content.** The cited path (`cultural_relevance`) resolves and does not entail it. Resolution ≠ entailment, again |
| 12 | LeBron | private IG data integrated | evidence | SUPPORTED | C | tooling outcome |
| 13 | LeBron | Nomila's record reflects real sponsorships | evidence | SUPPORTED | **B** | **re-domained** from the source's `commercial` to `evidence`, which is correct — it fixes Nomila's data. Quantified `at_least 5`: baseline 0 is read from State; the 5 is loosely grounded (six partners named across E6/E7/E9) but the number itself is not in State. Also the target is on Nomila's record count, not a strategic quantity |

**Entailment: 12 SUPPORTED · 1 PARTIAL · 0 UNSUPPORTED.**
**Value-add: A 0 · B 5 · B/C 2 · C 6 · D 0.**

**Zero A is the number that matters.** A requires synthesis or consolidation, and no consolidation happened.

---

## Should any have remained an Opportunity, or gone to Plan?

**None is an action in form** — the gates held, and #10 actually converted an action into an outcome.

**The six `evidence` proposals are the honest concern.** Each is a valid outcome per the contract (*"Nomila can see her audience"* was explicitly permitted). But four of them describe **Nomila's tooling** as the end state — *"analytics dashboard displays…"*, *"integrated into Nomila's data systems"* — which is an outcome for Nomila's operations, not the athlete's enterprise. They read like tickets in outcome grammar. Six of thirteen is inflation inherited from a map that was itself evidence-heavy (5 of 13), passed through 1:1.

The contract permits them. Whether they are *objectives* in the sense a representative would recognise is a judgment I'd flag rather than resolve here.

---

## The primary question

*Does this layer convert evidence-backed openings into genuinely distinct intended outcomes rather than restating them?*

**Partially, and unevenly.**

- On the **non-evidence** opportunities it formed real outcomes five times (B) — including #2's concrete portfolio outcome, #10's de-prescription, and #13's re-domaining. Those are the layer doing its job.
- On the **evidence** opportunities it reformulated six times (C).
- **"Distinct" was never tested.** Distinctness came free from 1:1. The layer did not once weigh two openings against each other, so it never demonstrated the consolidation capability the design exists for.

---

## Failure layer

| | verdict |
|---|---|
| **A · State insufficiency** | No. Every proposal that failed did so with sufficient State |
| **B · Evaluator reasoning** | **Yes — the main one.** The prompt says it *may* consolidate and *may* decline; "every opportunity ends in exactly one of two places" is satisfied most easily by 1:1, and the evaluator took the easy path every time. One unsupported absence claim (#11) |
| **C · Contract** | A gap, not a defect: the accounting invariant cannot distinguish *"considered merging and kept separate"* from *"never considered it."* The design foresaw the count problem and rejected a cap, correctly — but left consolidation as a permission rather than an act the evaluator must show |
| **D · Correct behaviour** | Five B-grade outcomes; the de-prescription; the re-domaining; zero invention of brands, dates, or preferences; baseline read from State and never asserted; the intent path correctly dormant on States with no preferences |

**Recorded, not fixed** — a candidate remedy for the next spec version: make **distinctness a deliverable** the way declining is. For each proposal, name the other proposals it was considered for merging with and why they remain separate. Not a cap; an obligation to show the consolidation judgment was made. Whether that is enough is a question for a rerun, not for prose.

---

## What this run did not establish

- **The intent path** (`athlete` and `joint` origins) — zero preferences in any State, so zero empirical exercise. Contract and validator tested; behaviour untested.
- **Consolidation** — never attempted, so never observed.
- One run per athlete; no claim here is a rate.
