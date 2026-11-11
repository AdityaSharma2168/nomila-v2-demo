# Superseded decisions — Commercial Intelligence v3 and Blueprint v1

Both documents were written **before** implementation. Several of their decisions have since been overturned by
evidence produced while building M.I.A. Beta.1. Nothing is deleted: each entry records the original decision, what
overturned it, and where the replacement lives — so a future reader understands *why* the architecture changed rather
than finding a silently edited document.

Entries are ordered by how much damage a stale reading would do.

---

## S-1 — Deterministic conversion of evidence into qualitative sub-signals

**Original** — Commercial Intelligence v3 §1, §3, §6. Research extracts evidence; a Signal Engine deterministically
converts it into 0–100 sub-signals through cohort percentiles and lookup tables; *"a fact does not directly become
'points' because an LLM feels it is important."*

**Overturned by** — the implementation. Slice E (`marketabilityBeta1ResearchSignals.ts`) built exactly this for 13
sub-signals and reached **Spearman 0.08** against the 37-athlete development cohort, where a rubric-constrained
evaluator reaches **0.887** on the same athletes. Withdrawn before merge.

**Why** — the conversion needs cohort percentile distributions per sport, level and stage. None exist, and §26.6 says
where they come from: the benchmark moat accumulated from longitudinal snapshots and outcomes. The Signal Engine is a
V3 architecture that §6 sequenced as V1. Filling the gap early forces proxies, and the document's own central rule
then bites — a retrieval count is not a real-world volume.

**Replacement** — [ADR-017](../adr/ADR-017-evaluator-owns-qualitative-judgment.md). The evaluator owns qualitative
judgment; the engine owns arithmetic, missingness policy, mapping, versioning and calibration. **This is the entry
that matters most: someone reading §6 fresh would rebuild Slice E.**

**Still true from §6** — deterministic conversion is correct where inputs are genuinely quantitative and anchored.
That is Rate Intelligence, and ADR-010 stands.

---

## S-2 — Acceptance criteria for the deterministic calibration run

**Original** — §10: median absolute score error ≤ 10, mean ≤ 15, tier consistency ≥ 90%.

**Overturned by** — the 37-athlete run on frozen `blind-eval-spec/0.2.1`: Spearman **0.887**, median absolute error
**53**, exact-quartile agreement 51% with 100% inside one quartile, top-10 overlap 8/10.

**Why** — the same document already contains the reasoning that invalidates §10. §21.2: *"the key conclusion is not
that every historical label must be reproduced exactly"*; benchmark drift is formalised in §24 and demonstrated by
Flau'jae Johnson. The targets are expert labels with as-of dates, not ground truth. By §10 the run failed; by §21.2's
own reasoning it passed.

**Replacement** — ordering and consistency criteria, not absolute-error criteria: rank correlation, quartile
consistency, top/bottom-10 overlap, and an explicit classification of each large residual as improved measurement,
benchmark drift, model miss, definition mismatch or insufficient data (the vocabulary §23 already proposes). Absolute
error is reported, not gated.

**Note on the remaining error** — it is a scale effect, not disorder: regression slope of MIA on target is 0.778, so
the elite end is compressed while the bottom third sits slightly above its targets. A global rescale would break a
correctly-calibrated low end. The decomposition and the decision not to rescale are recorded in
`server/scripts/calibration/analyzeTopEndCalibration.ts`.

---

## S-3 — Research provider

**Original** — §4: *"V1 should use OpenAI as the generalized web-research provider… Tavily, Google grounding, or other
providers should not be added by default."*

**Overturned by** — a blind head-to-head on eight athletes, identical rubric, identical inputs, neither provider seeing
the other's output: Gemini **0.952**, OpenAI **0.833** against the founder's targets. Kimi was evaluated and dropped
(its web-search builtin is incompatible with thinking mode).

**Replacement** — Gemini 3.5 Flash via Vertex with Google Search grounding is the Beta.1 evaluator and research
provider, pinned in `marketabilityBeta1EvaluatorSpec.ts`. §4's *principle* held and should be kept: a pluggable
provider interface, benchmarked rather than assumed.

---

## S-4 — `MarketabilityResult` shape

**Original** — §17: `{ score, potential: number, confidence, tier: MarketabilityTier, dimensions, drivers, version }`.

**Overturned by** — the implementation. `potential` is returned `null`; `tier` is **deliberately absent**, with the
engine carrying the comment *"Tier is intentionally absent: the architecture leaves tier vocabulary/display policy
open."* Blueprint §49 makes the same point from the other side — legacy tier/score readers get a compatibility adapter,
and the adapter must not dictate the canonical model.

**Replacement** — the canonical result adds what §17 lacks and Beta.1 requires: per-dimension confidence, rationale and
confidence rationale; per-signal evidence class, evidence ids and observation date; overall confidence and thesis; the
evaluator spec version alongside the methodology version; and the digest of the judgment set that produced it. Tier
stays a display policy decided downstream.

---

## S-5 — Holdout cohort scores printed in the specification

**Original** — §21.3 listed all 22 unseen-holdout athletes with their scores and confidences.

**Overturned by** — exposure risk rather than evidence. Architecture documents get pasted wholesale into model
contexts; the Beta.1 freeze rule names that holdout as the designated independent evidence set for any future
calibration question, and one careless paste would burn it permanently.

**Replacement** — `server/services/marketabilityHoldout.ts`, behind the same never-send rule as the development
targets. The document keeps the descriptive paragraph and a pointer. The relocation happened **during** conversion, so
the raw table never entered git history.

**Correction of substance** — those numbers are OUTPUTS of the earlier expert/alpha process. They are not expert
targets and not results of the frozen evaluator. They are a comparison baseline if the frozen evaluator is ever run on
that cohort. The holdout remains unspent.

---

## S-6 — Social Intelligence implementation milestone (§28–§31)

**Original** — a detailed implementation contract for the social data layer: identities, sync runs, sanitized
payloads, canonical observations, audience distributions, versioned features; §28.10 acceptance criteria; §31
definition of done.

**Overturned by** — it shipped. Phase A Steps 1a and 1b built it (migrations 0044, 0045). §28.10's first criterion —
*"no scoring code imports provider-specific integration response types"* — is `boundary.test.ts`, enforced in CI. §5's
Context Builder is `buildCanonicalContext` from Step 2d.

**Replacement** — none needed; the sections are a record of work done. They are flagged because a fresh reader would
rebuild a working subsystem. The one genuinely open item is operational, not architectural: Instagram Business
Discovery still fails on token scopes, which §28.5 correctly classifies as a configuration issue.

---

## S-7 — PAV as an earnings figure

**Original** — Projected Annual Value is produced today by `rateService.ts` and written to `athletes_current`.

**Overturned by** — §12's own rule, which the implementation predates: *annual potential is not rate × posts.* PAV is
computed as `Σ(rate × PAV_VOLUME_MIX volume)` where the volume mix is an uncited constant table (12/24/36 posts per
year by follower tier). It carries no confidence, no as-of, no assumptions list — and it already feeds deal scoring
and the negotiation composer.

**Replacement** — PAV is legacy annualization and retires from the canonical Commercial Snapshot in favour of the
Earnings contract, which states scenarios with confidence and declared assumptions. The deliverable-specific Rate
Engine underneath it is kept: it is calibrated and useful. During migration PAV survives as a projection, per Blueprint
§49, and must not define the Earnings model.

---

## Decisions that held

Worth recording, because the failures above are easier to see than the calls that were right.

- **ADR-011** — Nomila's own predicted rate or value must never feed MIA, while verified commercial outcomes may inform
  Commercial Proof. We reached the same conclusion independently from the circularity risk in the learning loop.
- **ADR-002 / §13** — connected data is an accuracy event, not a bonus. The structurally-private missingness rule was
  adopted precisely so connecting an account could not mechanically unlock points.
- **ADR-010** — Rates is its own service and MIA is one input. Reinforced: Beta.1 feeds Rates through a defined
  contract, never by projecting back onto legacy capitals.
- **§37 / Phase F** — learning is observation → evaluation → parameter proposal → offline validation → version
  promotion, not online learning. The freeze guards built in `marketabilityBeta1Freeze.test.ts` are the enforcement
  half of exactly that loop.
- **§15 / §19** — sport and level normalization, provenance on every signal, confidence as a separate metric, ranges
  rather than point prices, scenarios rather than promises. All still correct.
