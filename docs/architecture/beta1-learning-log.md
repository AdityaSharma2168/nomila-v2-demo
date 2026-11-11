# M.I.A. Beta.1 — freeze policy and learning log

**Owner:** Mia
**Started:** 2026-09-16
**Status:** Live. Append-only.

Beta.1 is Nomila's first production measurement system. This document records **what freezing it means**, and **what we have observed about it without changing it**.

The distinction this file exists to protect: an observed limitation is evidence for a future Beta.2, *not* a reason to adjust Beta.1 until the cohort produces a preferred answer. Tuning a methodology until it reproduces the answers we already believe is how a measurement quietly becomes a preference.

---

## 1. What "frozen" means — and what it does not

**Frozen: the methodology.** No changes, for any reason, to:

- dimension weights, sub-signal weights, the 44-signal structure
- the composite → MIA mapping (`850 × (composite/100)^0.8`)
- priors, cohorts, lookups, normalization policy
- the evaluator prompt/spec text and its pinned digest
- missing-data treatment, including `structurallyPrivate`

Specifically: **none of these may be changed to improve how the cohort scores.** A candidate change becomes a versioned Beta.2 experiment, compared in shadow, and promoted only on evidence.

**Not frozen: the software.** These may be corrected under normal versioning and audit:

- genuine implementation defects (a scoring bug, a reader serving mixed calculation versions)
- reliability and operational behaviour (retry classification, leases, idempotency, failure containment)
- instrumentation that records what happened without altering what is computed

The test is *purpose*, not file: **does this change what the methodology says, or does it make the system faithfully do what the methodology already says?** The first is frozen. The second is maintenance.

A parameter change always bumps the version and leaves the prior row intact and inactive — never mutated, never deleted.

---

## 2. Observations — recorded, not fixed

### OBS-1 · Credential taxonomy promotion
**Observed:** 2026-09-16, cohort run · **Class:** evidence/research error · **Status:** open

Grounded research can correctly discover a **real** credential and then incorrectly restate it as a **more prestigious adjacent** one.

The observed instance: an athlete's genuine *Girls Academy National Talent ID* roster inclusion was reported as selection for a *U.S. Women's Youth National Team ID Camp*. The source was credible and the underlying fact was real — the error was in the category, not the citation. The evaluator rated its own confidence **HIGH**, and the claim drove `athletic_authority.national_international_status = 68`.

In youth soccer alone the ladder is: club/league talent ID event → US Soccer Talent Identification Center → YNT ID camp → YNT roster selection → international cap. Five semantically adjacent rungs, materially different in prestige. Analogous ladders exist in every sport.

**Why it matters beyond one athlete.** This is not a hallucination — nothing was invented — which is exactly what makes it hard to catch: it is anchored to a true fact, it reads plausibly, and it survives a casual review. It also cannot be fixed by weighting, priors or missing-data policy. No scoring change corrects a wrong fact.

**What we are NOT doing:** adjusting any athlete's score, or adding athlete-specific handling.

**Hypothesis to test:** credential-bearing signals (`national_international_status`, `rankings_recognition`, `competition_level`) show a higher verified-error rate than performance or audience signals. Requires the verification record in §3 before it can be measured.

### OBS-2 · Narrative Power may not discriminate
**Observed:** 2026-09-16, cohort run (n=42) · **Class:** possible rubric saturation · **Status:** open

`narrative_power` distribution: min 7.5, **p25 84.1, median 90.5**, p75 94.5, max 99.4. Nearly every athlete scores 84–95 on a dimension weighted 0.10.

For contrast in the same run: `cultural_relevance` spans 3.25–100, `audience_scale` 11.75–98.5.

A dimension that assigns almost everyone the same high score contributes little ranking information regardless of its weight.

**What we are NOT doing:** changing the weight or the rubric.

**Hypothesis to test:** if repeated cohort runs keep showing the same upper-end crowding, this is rubric saturation rather than a property of this population — evidence for Beta.2 rubric work. One run is not enough to tell those apart.

### OBS-3 · Evaluator run-to-run variance is material and uneven
**Observed:** 2026-09-16 · **Class:** measurement property · **Status:** open

Identical evidence, identical params, identical prompt produced **593 → 638** for one well-evidenced athlete: a 45-point swing with nothing changed but the sample.

Across the cohort versus the frozen reference: mean absolute movement **15.3** for evidence-rich athletes (≤5 of 44 signals missing) and **29.1** for evidence-poor (≥10 missing) — but athletes whose dimensions are *entirely* prior-imputed are perfectly stable, because a prior is a constant and contributes no variance. The relationship is U-shaped, not linear.

**Consequence, recorded without acting on it:** MIA currently emits `782` and `491` with identical apparent precision. One rests on dense consistent evidence; the other on sparse evidence, a third of it imputed.

**What we are NOT doing:** publishing intervals. A single repeat per athlete yields one difference, not a variance — presenting `±30` as a calibrated interval would assert more certainty about our uncertainty than the data supports.

**To resolve:** a designed experiment across evidence-density regimes, with repeats chosen statistically rather than by re-running all 43 several times.

### OBS-4 · Missing data behaves as regression toward the mean
**Observed:** 2026-09-16 · **Class:** missing-data treatment · **Status:** open

`priors-v1` is a single global rule — every missing signal is **50** (plus `brand_fit.brand_safety` = 85). There is no sport, level or signal-specific structure, and `cohorts-v0-empty` is empty.

**15 of 43 athletes** have at least one dimension where *every* signal is missing, so the dimension is a constant 50: `engagement_quality` for 15, `commercial_proof` for 7, `audience_scale` for 2. All 15 sit between 246 and 644; none are in the top 20.

`engagement_quality` is effectively unevidencable for a public-only athlete — three of its six signals are structurally private, and the other three need social data the evaluator cannot obtain.

Counterfactual (excluding fully-unevidenced dimensions and renormalizing) moves those 15 by a mean of **+10.9**, but in *both* directions: −48 for the weakest athlete, +63 for one whose remaining evidence is strong. The prior is not inflation; it is compression toward 50 from both sides.

**What we are NOT doing:** changing priors, renormalizing dimensions, or confidence-weighting the composite. Confidence-weighting in particular mixes marketability with our certainty about marketability, which makes the score no longer a measurement of the construct.

---

## 3. Proposed, NOT built — the evidence verification record

The observations above cannot become measurements without somewhere to record human checks. Today OBS-1 exists only as prose, so we can count errors we happened to notice and never compute a rate.

The record must capture **confirmations as well as corrections** — otherwise we learn the numerator and never the denominator. *"47 credential claims reviewed, 3 materially wrong, taxonomy promotion responsible for 2"* is a measurement; a list of three errors is an anecdote.

**Shape (smallest viable):**

| field | purpose |
|---|---|
| `evaluation_run_id` | which run made the claim |
| `signal_key` | which of the 44 signals it supported (nullable — some claims are summary-level) |
| `evidence_id` | which item in the run's evidence array (e.g. `"E4"`) |
| `claim` | the asserted text, copied at verification time so later edits cannot rewrite history |
| `verdict` | `CONFIRMED` · `CORRECTED` · `REJECTED` · `UNVERIFIABLE` |
| `error_class` | nullable, from a small controlled vocabulary — e.g. `taxonomy_promotion`, `wrong_entity`, `stale`, `fabricated` |
| `correction` | the verified fact, where one exists |
| `verified_by`, `verified_at`, `method` | who checked, when, and how |
| `material` | whether it could plausibly change the signal's score |

**Properties it must have:**

- **Append-only.** A verification is an observation, never an edit. It does **not** change the run, the judgement, the ledger entry or any score.
- **No athlete-specific logic.** OBS-1 becomes the first row, not a special case.
- **Sampling-friendly.** Rates require a denominator, so the design must support "these N claims were reviewed" — including the ones that were fine.

**Explicitly out of scope:** re-scoring on a correction, feeding corrections back to the evaluator, and any automatic action. A verified correction changes what we *know about* an assessment, not the assessment — which was made from the evidence available at the time, and remains a true record of that.

---

## 4. Carried forward — a constraint on Rate Intelligence

Rate will consume MIA as one versioned input. Given OBS-3, MIA carries material run-to-run movement, so **Rate inherits it.**

When a rate is eventually compared against an actual deal, the error decomposition must be able to separate *"the rate model was wrong"* from *"MIA sampled high that day."* So Rate's ledger entry must record, in `inputs`:

- the **exact MIA ledger entry id** it consumed (`ValueRef.predictionId`), and
- the **MIA value as consumed**, snapshotted at the time

The entry id alone is not enough in practice — reconstructing what MIA said requires a join and assumes the entry is still reachable. Recording the value makes the decomposition possible directly from the row.

---

*Append new observations with the next OBS number. An entry is only removed when its hypothesis has been tested and the result recorded — not when it stops being convenient.*
