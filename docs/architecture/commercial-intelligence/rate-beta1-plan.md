# Rate Intelligence Beta.1 — plan of record (14 Sep 2026, revised 16 Sep 2026)

**Status: PLANNED, NOT STARTED.** No code, no benchmark set, no evaluator, no run. This document exists so the work is
recoverable — it captures decisions made, the reasoning behind them, and what each side owes before anything is built.

The upstream dependency it was paused on is **done**: the M.I.A. evaluator service is productionised, shadow-wired on
dev, and the prediction ledger this plan said "must be built alongside Rate v0.1" already exists as
`intelligence_ledger` with an `ESTIMATE` kind whose calibration error the type system permits — and structurally
refuses for an `ASSESSMENT`.

> **SUPERSEDED AS AN OPERATIVE DOCUMENT — 17 Sep 2026.**
>
> The design direction is now [`rate-v0-design.md`](./rate-v0-design.md), which is internally consistent and needs no
> reconciliation against this file. This plan is retained for the reasoning it records, not as instructions.
>
> **What survived into the operative design:** the evaluator-owns-judgment shape; shared, versioned market benchmarks
> researched once rather than per athlete; the `EvidenceMethod` vocabulary; §4's validation honesty — that published
> NIL figures are annual totals, so they validate composition and never a component; §4.2 source verification; and
> §6's record of the two discarded drafts and the pull that produced them.
>
> **What was overturned, and where the current position lives:**
>
> | this plan said | now |
> |---|---|
> | `athlete × deliverable × terms` implied | `athlete × rate_type × platform × terms_basis` — deal terms are Deal Intelligence's (design §6, §11) |
> | 37 hand-authored reference rate ranges, frozen before the rubric | **not commissioned.** Cohort used as a behavioural validation set, never as targets (design §15) |
> | `ambassador_monthly` | **Annual Brand Partnership**, independently evaluated, never summed from atomic rates (design §6.2) |
> | social rate types without platform | platform-specific and required where applicable (design §6.1) |
> | open-ended manual source verification gating any run | bounded: grounded research → candidates → verification → versioned registry (design §8.3) |
> | full taxonomy with confidence carrying thin evidence | all ten families supported; `NOT_ESTABLISHED` where evidence is insufficient (design §6) |
> | "the only real validation is closed deals" | still true, and now qualified: the Deals audit shows the corpus is six transactions with unstructured deliverables and no rights, so calibration is gated on Deals capturing them |
>
> Later drafts also proposed a 30-day base social usage window, a 0/1/2-hop calibration-weight hierarchy, a Rate-side
> commercial lifecycle vocabulary, an overall athlete rate confidence, and `identity_confidence`. **All five are
> withdrawn** — see design §7.1, §12.1, §5.3 and §4 respectively.

---

## 1. The approach

Rate Intelligence follows the shape that rescued Marketability, while remaining a **separate engine** (ADR-010 — MIA
informs the rate, it does not determine it):

```
versioned market benchmark evidence (shared, researched, dated)
        +
athlete evidence (public research, public/connected social, commercial proof, MIA Beta.1 artifact)
        ↓
rubric-constrained Rate evaluator (Gemini, grounded)
        ↓
per deliverable: low / expected / high · confidence · evidence · drivers · gaps · prose
        ↓
deterministic composition and persistence (Nomila)
```

Then progressively: connected social supersedes public estimates; real closed deals supersede both. The conceptual
architecture does not change as evidence improves — only the evidence class and the confidence do.

### What is explicitly NOT the approach

- **Not** `MIA × factor`. The same score can price very differently depending on deliverable and distribution.
- **Not** the existing v3.1 formula engine with a new input. `ScoreMod`, its clamps, the capital structure and its
  constants are **not assumed to survive**. Two drafts drifted into this and were discarded; see §6.
- **Not** a single collapsed Nomila lookup table. Preserving source observations and letting the evaluator reconcile
  them is the direct lesson of Slice E ([ADR-017](../adr/ADR-017-evaluator-owns-qualitative-judgment.md)).

---

## 2. Evidence architecture

Three versioned registries rather than one benchmark table, each observation carrying source, publication date,
population, geography, sample size where available, evidence method and limitations:

| registry | holds |
|---|---|
| `RateMarketBenchmark` | observed pricing by platform / deliverable / cohort |
| `RightsMarketBenchmark` | usage duration, paid media, whitelisting, exclusivity, buyouts, territory |
| `OpportunityMarketBenchmark` | observed deal counts, mix, categories, relationship structures (deferred, §5) |

**`EvidenceMethod` is the most important idea in the design** and a genuine refinement of the P-2 vocabulary for this
domain. A marketplace *ask* is not a completed transaction, and a formula-generated benchmark is neither:

```
OBSERVED_TRANSACTION | ACCEPTED_MARKETPLACE_DEAL | MARKETPLACE_ASK | BRAND_BUDGET
| REPORTED_DEAL | SURVEY | MODELLED_BENCHMARK | EXPERT_GUIDANCE
```

Weight follows method. A marketplace median of listed packages must not carry the authority of thousands of completed
deals, and a vendor stating its rate matrix is formula-computed must not be read as transaction evidence.

Segment only where evidence supports it — platform, deliverable, audience band, creator vs athlete, college vs pro,
sport, geography, date. **Do not create empty cells.** If there is no defensible evidence for "D1 women's soccer ×
37K followers × 4.2% engagement", there is no such benchmark; the evaluator reasons from the broader evidence instead.

### Benchmark refresh

Benchmarks are researched in a deliberate run, versioned (`RateMarketBenchmark/v0.1`), and refreshed on a cadence
(quarterly initially) — **never re-researched per athlete**. Per-athlete market research would make two similar athletes
receive different benchmarks because their searches differed, and would pay for the same research repeatedly. The
athlete's evidence is individual; the market's pricing is shared.

This is the structural piece Marketability never had. Cohort percentile distributions could only come from Nomila's own
accumulated data, which is why §6 of the Commercial Intelligence spec was premature. **Market rate benchmarks are
publicly researchable today** — a real asymmetry between the two engines.

---

## 3. Decisions taken

| decision | resolution |
|---|---|
| Scope of v0.1 | **Full deliverable taxonomy**, with confidence carrying the uncertainty where evidence is thin |
| Result segmentation | Results MUST be reported segmented by benchmark evidence strength. `status: ESTABLISHED / NOT_ESTABLISHED` per deliverable is the hook. Thin-evidence deliverables coming back wide and LOW is a finding, not a failure — but only visible if the report is cut that way from the start |
| Opportunity engine | **Deferred** until Rate v0.1 validates. Its only real anchor is one college-basketball cohort that does not generalise to soccer, to pros, or to most of the 37. Running both at once makes a poor result unattributable |
| Provider | Gemini 3.5 Flash via Vertex, Google Search grounding, default thinking — identical to M.I.A., so provider and methodology do not change together |
| Existing Nomila rate data | **Not used as a foundation.** The v1-extracted tables and the five On3/Forbes PAV anchors are out. `docs/rate-model-research.md` is kept as a *bibliography* — it names Opendorse, On3 and Hookit as publishing by activity type — but every number is re-researched and re-verified from source |
| Prose | First-class output, generated *with* the judgment, never afterwards from the numbers (P-6) |
| Relationships vs deliverables | Opportunity, when built, estimates brand **relationships** first and deliverables second. One annual partnership containing six Reels is one relationship, not six deals |
| Annual partnership | Its own commercial object. **Not** 12 × monthly rate — evaluate relationship structure, guaranteed volume, exclusivity and deliverables |
| Rights | No fixed Nomila multipliers in Beta.1. Base compensation → actual requested rights → market rights evidence → evaluator judgment → incremental range + confidence |

---

## 4. The validation problem — read this before trusting any result

**Rate v0.1 has no direct external validation available.** This is the single most important constraint and it differs
sharply from Marketability.

A rate prices one deliverable. Validating it requires evidence of what someone actually *paid* for that deliverable.
Published NIL valuations are **annual totals**, and annual total = rate × volume × mix — so a correct rate with wrong
volume and a wrong rate with compensating volume produce the same annual figure. **Annual anchors validate the
composition, never the component.** They become useful only once Opportunity and Earnings exist.

Meanwhile most readily available market data is *asks*, not transactions — which is exactly why `EvidenceMethod`
matters so much.

What v0.1 can therefore test:

1. **Ordering and internal consistency** across the cohort.
2. **Run-to-run stability** on identical inputs (M.I.A.'s noise floor was 20.5 points; Rates needs its own).
3. **Agreement with the independently-produced reference ranges** — subject to §4.1.

What it cannot test is correctness. **The only real validation is closed deals**, which is why the prediction ledger
(P-7) must be built alongside Rate v0.1 rather than after it. Rate v0.1 ships as an honest estimate with confidence and
immediately begins accumulating the evidence that will eventually judge it.

### 4.1 The reference set, and how it must be handled

Rate ranges for the 37 cohort athletes were produced by an earlier research-and-judgment process (Commercial
Intelligence v3 §11 refers to them as calibration targets). They are a **development reference set, not truth** — one
author's researched judgment, exactly the status the 37 marketability targets now carry.

Protocol, non-negotiable:

1. **Freeze them before the rubric is finalised**, in a typed module with the never-send rule, carrying an as-of date.
2. **The rubric is written from principles and benchmark evidence, not with the reference numbers in view.** If the
   rubric author is looking at the targets while writing the instructions, the test is contaminated invisibly.
3. **They never enter a prompt**, enforced the way the M.I.A. targets are.
4. Agreement proves the evaluator *reproduces that judgment* — which is what M.I.A.'s 0.887 proved, and no more.

If they turn out to have been produced *during* rubric design rather than before it, they drop to a consistency check
and carry no validation weight.

### 4.2 Source verification

Every cited source must be verified as real and re-retrievable **before** it enters the benchmark registry. An evidence
registry built on unverified citations is the same defect as `LICENSING_GUARANTEE.coeffPerFollower` — a number with a
confident story attached. Anything that cannot be re-retrieved is dropped.

---

## 5. Sequence

1. **M.I.A. evaluator service productionised** (shadow on dev) — upstream dependency. Establishes the persistence and
   prediction-ledger patterns Rates will reuse.
2. Source verification of every benchmark citation.
3. `CommercialBenchmarkObservation` implemented as a versioned artifact, seeded into the `rates` `model_params` family
   (the family already exists).
4. Rate rubric v0.1 frozen; canonical prompt digest pinned, as with the M.I.A. evaluator.
5. Blind run over the eight pilot athletes; artifacts persisted and digested; nothing tuned.
6. Compare against the reference ranges, segmented by evidence strength; measure run-to-run stability.
7. Decide: freeze Rate Beta.1 and run the 37, or revise the rubric — once, deliberately, never per athlete.
8. Only then: Opportunity, then Earnings, then the Commercial Snapshot.

### What transfers from M.I.A. (most of the apparatus)

`runBlindEval.ts` already provides provider configuration, tagging, artifact persistence, cost telemetry and bounded
concurrency. The freeze machinery — canonical prompt digest, artifact digests, goldens, the five guards — applies
unchanged. This is the difference between weeks of build and running within a day of a frozen benchmark and rubric.

### Owed by each side

| owner | owes |
|---|---|
| founder / research | the 37 reference rate ranges (before rubric finalisation); verified benchmark contents across the full taxonomy; the rubric text |
| engineering | source verification; benchmark registry implementation; Rate evaluator runner; the prediction ledger; the blind run and its report |

---

## 6. Two drafts that were discarded, and why

Recorded because the pull that produced them will recur.

**Draft 1 — project Beta.1 onto the legacy capitals.** Cheap and contained, and wrong: Opportunity and Earnings arrive
immediately downstream and would inherit the same lossy shape. Three engines designed against a representation already
known to be obsolete.

**Draft 2 — re-specify `ScoreMod`'s weight vector over the eight Beta.1 dimensions.** Superficially different,
structurally identical: still `market base → adjustments → ScoreMod → price`, the legacy architecture with a new knob.
It treats the existing implementation as the architecture and asks only what feeds it.

Both came from the same pull — *preserve what is already calibrated*. Blueprint §49 already answers it: **use adapters
rather than allowing legacy contracts to define future intelligence.** "Preserve working systems" is a migration
tactic, not architectural authority. The audit question is "which components of v3 are valid parts of the new
architecture", never "how do we wire Beta.1 into v3".

Supporting evidence that v3's economics deserve scrutiny rather than deference: a P-4 classification of every constant
in `rateModelConfig.ts` found that the genuinely sourced components are licensing royalty percentages, the Fanatics
autograph tier, IMH social CPM anchors and speaker-bureau appearance tiers — while the score-modifier formula constants
are not even exported, the confidence-band thresholds that set negotiation numbers are uncited, `PAV_VOLUME_MIX` is
uncited, and `LICENSING_GUARANTEE.coeffPerFollower` carries the comment `INVENTED — calibration target #1` while
feeding a licensing guaranteed minimum that reaches the negotiation composer. Five of six licensing royalty rows are
unreachable because `category: "default"` is hardcoded.
