# ADR-017 — The evaluator owns qualitative judgment; the engine owns arithmetic, policy and calibration

**Status:** ACCEPTED — 14 Sep 2026. Supersedes the deterministic signal-conversion design in
Commercial Intelligence v3 §1, §3 and §6 for qualitative sub-signals.

**Context documents:** [`commercial-intelligence-v3.md`](../commercial-intelligence/commercial-intelligence-v3.md),
[Blueprint v1](../commercial-intelligence/product-intelligence-blueprint-v1.md) §14, ADR-001, ADR-010, ADR-011.

## Decision

A rubric-constrained evaluator produces the 44 M.I.A. sub-signal **judgments** — each a 0–100 value with a
confidence, an evidence list and a rationale, or an explicit MISSING. Nomila's deterministic engine owns everything
downstream: sub-weights, dimension weights, the missingness policy, the 0–850 mapping, versioning and calibration.

The boundary moved. It did not dissolve.

## What was tried and withdrawn

Commercial Intelligence v3 §6 states the original premise plainly:

> "This is where Nomila becomes defensible: a fact does not directly become 'points' because an LLM feels it is
> important; it is mapped through explicit rules or normalized against a comparable cohort."

That was built. `marketabilityBeta1ResearchSignals.ts` ("Slice E") deterministically derived 13 sub-signals from
canonical research facts under a founder-approved mapping. Scored against the 37-athlete development/calibration
reference set it reached a **Spearman of 0.08**. The rubric-constrained evaluator, given only athlete name and sport,
reaches **0.887** on the same athletes. Slice E was withdrawn before it reached main.

## Why it failed — the part that matters

Not because deterministic scoring is wrong. Because **the conversion required data we do not have and cannot have
yet.**

§6's hierarchy is: evidence → canonical feature → cohort selection → percentile/lookup → 0–100 signal. That
presupposes cohort percentile distributions per sport, level and stage. We have none. Of 44 sub-signals only the
lookup-backed handful are parameter-ready; every quantitative path lacks a cohort table. The same document says where
those tables come from — §26.6, the "Nomila-owned benchmark moat", accumulated from longitudinal snapshots and
commercial outcomes over time.

**The Signal Engine is a V3 architecture that the specification sequenced as V1.** Attempting it early forces the
remaining gap to be filled with proxies, and the founder's own central rule then bites: a retrieval count is not a
real-world volume. Counting the media articles a search returned measures the search, not the athlete.

## What survives

Every defensibility property the original design wanted, obtained a different way:

| Property | How it holds now |
|---|---|
| The LLM is not the source of truth for the score | It produces bounded per-sub-signal judgments; it never sees or computes a dimension score, a composite or an 0–850 number |
| Judgments are constrained, not free | A frozen rubric, digest-pinned; each judgment carries evidence ids and a confidence from an evidence-based rubric |
| Reproducible and versioned | Weights, sub-weights, missingness policy and mapping are versioned parameters; the frozen 37 judgment sets re-score to identical outputs, enforced by `marketabilityBeta1Freeze.test.ts` |
| No silent methodology change | Five guards: canonical rubric digest, artifact digests, policy/version assertion, exact golden outputs, production/scripts boundary |
| Explainable | Evidence lineage per judgment plus evaluator rationale per dimension (see P-6) |

## Consequences

**Do not rebuild Slice E from §6.** Any future deterministic conversion of evidence into a qualitative sub-signal
value requires the cohort distributions to exist first, and must beat the frozen evaluator on the development cohort
before replacing it.

**Deterministic conversion remains correct where the inputs are genuinely quantitative and anchored.** Rate
Intelligence is the live example: benchmark tables, audience and engagement measurements, formulas. ADR-010 stands —
Rates is its own service, MIA is one input.

**The validity test for using an evaluator elsewhere is not "is this qualitative" but "can we tell whether it
worked."** Marketability had a 37-athlete development/calibration reference set, which gave us an external basis for
comparing approaches — the only reason we could establish that the evaluator succeeded where the deterministic mapping
failed. That set is prior-process judgment, not ground truth; the same caution applies to it as to the independent
holdout comparison set.

Opportunity has no comparable reference set. A rubric-constrained evaluator may still make qualitative Opportunity
judgments — category fit, commercial relevance — as EVALUATED values carrying their evidence basis and, where one
exists, a falsifier. But it must not emit pseudo-empirical quantities such as an expected deal count or a conversion
probability. Those stay ASSUMED with an explicit source, version and range until outcomes give us a basis. See P-4,
P-5.

**Connected data remains an accuracy event, not a bonus** (ADR-002), and Nomila's own predictions still never feed MIA
(ADR-011). Neither is weakened by this change.
