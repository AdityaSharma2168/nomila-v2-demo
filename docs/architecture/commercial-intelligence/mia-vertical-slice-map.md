# Mia vertical slice — what exists, what is missing

**Owner:** Mia
**Date:** 2026-09-20
**Method:** repo audit of writers and readers, not documents. Every claim below cites a file, and "live" means
something imports it at runtime.

**Scope:** one vertical seam for one athlete — canonical evidence → MIA/social/commercial → Athlete State →
Opportunity Map → Objectives → relevant Suggested Rates → floors → Deals/Mila.

---

## The finding that changes the plan

**`server/services/intelligence/contracts/commercial.ts` has zero importers.**

```
$ grep -rn "contracts/commercial" server/ client/ shared/
(no results outside the file itself)
```

Its header declares the whole chain — *Athlete Intelligence → MIA + Rate → Athlete State → Opportunity → Earnings →
Commercial Snapshot → Objectives* — and nothing reads or writes any of it. `provenance.ts` is imported by exactly
three files, two of which are that dead contract and its own test.

The seam was not lost, but it was never connected either. **It is a declaration, not an implementation**, and for
the middle of the chain the classification is ADD rather than MODIFY.

Two related absences, confirmed by grep returning nothing at all:

| searched | result |
|---|---|
| `AthleteState` · `athlete_state` · `athleteState` | **no matches anywhere** |
| `OpportunityMap` · `AMPLIFY` · `UNLOCK` · `opportunity_map` | **no matches anywhere** |
| `Objective` (commercial sense) | only `server/studio/*` — creative campaign briefs, unrelated |
| `weeklyPlan.ts` | **does not exist** — the plan spine is not in the tree |

---

## KEEP — live, correct, reusable as-is

| what | where | evidence it is live |
|---|---|---|
| **Provenance envelope** | `contracts/provenance.ts` | MEASURED/EVALUATED/ASSUMED/MISSING + confidence + lineage. Imported by `intelligenceLedger.ts`. The vocabulary is right and the slice should adopt it rather than invent one. |
| **Intelligence ledger** | `contracts/intelligenceLedger.ts`, `shared/schema.ts` | Real table. Written by `marketabilityBeta1Orchestrator.ts`, read by `server/scripts/rate/rateExperiment.ts` — **the one proven engine-to-engine seam in the system.** |
| **M.I.A.** | `marketabilityBeta1Orchestrator.ts` | Writes ASSESSMENT rows with score, dimensions, per-signal imputation counts, summary. Mia currently 638/850. |
| **Canonical athlete context** | `intelligence/context/*` (build, coverage, views) | Live behind `contextReaderEnabled`. Consumed by `mila/onboarding.ts`, `mila/tools/getProfile.ts`, `routes/admin.ts`. Views already exist for identity, prompt, record, deck, search. |
| **Rate evaluator methodology** | `rateBeta1EvaluatorSpec.ts` + `rateBeta1Freeze.test.ts` | `rate-eval-spec/3.2.0`, digest-pinned, 43 parity tests, 8 independently versioned terms bases. |
| **Athlete rate floors** | `routes/deals.ts:1172-1269` `minimum_rates` | Athlete-set per-type minimums, merged key-by-key. The recommend-vs-accept separation already exists in product. |
| **Social substrate / identity** | `intelligence/identity/*`, social features | Live on dev; feeds both MIA and Rate evidence blocks. |

---

## MODIFY — exists, but the contract or seam is wrong

**1. `contracts/commercial.ts` — three specific mismatches, beyond being unimported.**

- `DeliverableKind` is the old nine-value union (`social_post … ambassador_month, licensing`). The shipped taxonomy
  is **thirteen slots across eight terms bases**, with buyer context. One of these must become the source of truth;
  the contract should import from the evaluator spec rather than restate it.
- `RateEstimate.rate` is `DerivedValue<MoneyRange>` with `drivers[].contribution` — a **computed** model. The Beta.1
  evaluator produces judgment with `anchor_basis`, `NOT_ESTABLISHED`, `confidence_reason` and `buyer`. The contract
  describes a system we deliberately stopped building.
- `OpportunityEstimate` is **monetization capacity** — categories, deliverables, volume, conversion, capacity. The
  Blueprint's strategic Opportunity is FIX/GROW/UNLOCK/AMPLIFY/MAINTAIN with rationale, impact, feasibility,
  urgency. These are different objects that share a word. Keeping both under one name guarantees confusion.

**2. `MINIMUM_RATE_KEYS` = `["socialPost","appearance","ambassador","autograph","licensing"]`** (`routes/deals.ts:1173`).
Five keys against thirteen slots. An athlete cannot set a floor on UGC, clinic, coaching or either licence, and
`autograph` no longer exists as a product.

**3. Two live rate systems.** v3.1 `rate_card` on `athletes_current` is consumed by `mila/rateCard.ts`,
`mila/tools/getRateCard.ts`, `mila/offerMoney.ts`, `lib/dealVoice.ts`, `mila/navChips.ts`. **Beta.1 Rate has zero
production consumers** — it is reachable only from `server/scripts/rate/`. Cutover is a real piece of work and is
not part of this slice; the slice should read Beta.1 directly and leave v3.1 alone.

---

## ADD — genuinely missing for the slice

| # | what | why it cannot be skipped |
|---|---|---|
| 1 | **Athlete State** | Nothing assembles a current diagnosis. Every consumer re-derives its own view from raw evidence. |
| 2 | **Strategic Opportunity Map** | The FIX/GROW/UNLOCK/AMPLIFY/MAINTAIN object does not exist in any form. |
| 3 | **Objectives** | No commercial objective model; no way to say "these three, not all eleven". |
| 4 | **The relevance seam** | Nothing decides *which* slots reach Rate for a given athlete. Today all thirteen are sent to everyone — which is exactly why LeBron is asked to price 1:1 coaching. |

---

## DEFER — real architecture, not needed to prove this slice

`EarningsPotential` and `CommercialSnapshot` (both compose outputs that do not exist yet) · prediction and learning
ledger · v3.1 → Beta.1 rate cutover · floors extended to all thirteen slots · generalisation beyond one athlete ·
any Rate prompt work.

---

## Proposed sequence — five PRs

Each lands behind a flag, dev only, and is independently reviewable.

**PR 1 · Athlete State for one athlete.**
A reader that composes state from what is already live — canonical context, the MIA ledger row, social features,
deal history — and returns it in the `provenance.ts` envelope. No new evidence gathering, no new tables initially.
Proves the sources compose before anything reasons over them.

**PR 2 · Opportunity Map.**
An evaluator over Athlete State producing FIX/GROW/UNLOCK/AMPLIFY/MAINTAIN items, each with rationale, supporting
evidence, expected impact, feasibility, urgency and confidence. Same shape as MIA and Rate: frozen prompt, digest
pin, parity tests. Qualitative judgments stay EVALUATED; no invented quantities.

**PR 3 · Objectives.**
Select and rank a small set from the Opportunity Map. The deliverable is the *selection*, and the discipline is that
it must decline to recommend things rather than ranking everything.

**PR 4 · The relevance seam.**

**Three distinct decisions, never collapsed:**

```
13 candidate products
  → APPLICABILITY        can this product reasonably exist for this athlete, on known facts?
  → STRATEGIC RELEVANCE  does it support the Opportunities and Objectives we are recommending now?
  → RATE EVALUATOR       ESTABLISHED with a range and confidence, or NOT_ESTABLISHED
```

`applicableSlots()` keeps decision 1 and **must not be reused for decision 2.** Relevance gets its own seam —
`relevantRateSlots()` or similar, named at implementation. The failure this prevents is concrete: encoding "LeBron
should not focus on coaching" as "coaching is not applicable to LeBron" would make a strategic judgment permanently
indistinguishable from a fact about the athlete, and it is the same conflation `2.0.0` removed from inside the
evaluator.

The three decisions read differently for different athletes:

| | applicable | relevant | rateable |
|---|---|---|---|
| LeBron · 1:1 coaching | yes | **no** — Rate is never called | — |
| Mia · 1:1 coaching | yes | yes | Rate answers, possibly MEDIUM confidence |
| Riya · camp/clinic | yes | possibly | **NOT_ESTABLISHED** — evidence insufficient |
| any athlete · a platform they affirmatively do not have | **no** | — | — |

**Two things to settle in this PR, flagged now rather than discovered later:**

- **Applicability is still a pass-through.** `knownAbsentPlatforms` is always `null` — Nomila has no representation
  of affirmative non-presence — so decision 1 currently filters nobody and relevance does all the work. That is the
  honest state; it must not be "fixed" by moving strategy into applicability.
- **What happens before Objectives exist.** An athlete with no computed Objectives must not silently lose every
  rate. The default has to be stated: fall through to all applicable slots, so absent strategy means unfiltered
  rather than empty.

**Rateability is an outcome, not a gate.** It is the evaluator's own judgment, already expressed as
`NOT_ESTABLISHED` plus confidence. Nothing should pre-check it.

**This is the PR that fixes the LeBron problem**, and it fixes it outside Rate.

**PR 5 · Read path.**
Expose State / Opportunities / Objectives / relevant rates to Mila and Deal as one reader, so downstream surfaces
stop reinventing strategy. Reconcile `contracts/commercial.ts` to what was actually built, deleting what was not.

---

## Two rules for the build

**Mia is the forcing function, never the fixture.** No hardcoded strategy, no test asserting her expected
opportunities. The tests assert *shape, provenance and refusal* — that confidence propagates, that MISSING stays
MISSING, that an unevidenced opportunity is not emitted.

**Preserve the Rate work as evidence, not as architecture.** 3.0/3.1/3.2 established what Rate can and cannot
credibly price — that elite athletes have no B2C coaching market, that instruction fees are bounded by an
organiser's budget, that a substitute seller's rate is not evidence. That is input to Opportunity, not a reason to
keep tuning Rate.
