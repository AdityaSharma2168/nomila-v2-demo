# Nomila Intelligence Architecture — cross-system principles

Principles that apply to every Nomila intelligence surface (research substrate, canonical context, M.I.A., Mila agent,
brand/creative generation). Each step's design document applies them; none of them may be overridden locally.

## P-1 Grounding is task-dependent, not a global model setting (13 Sep 2026)

Whether a model call runs with web grounding/search ON or OFF is decided by the task, per call, never by a global
model configuration.

**Research / Fact Mode — grounding/search ON.** External factual discovery, freshness, evidence collection, citations,
provenance, conflict detection and appropriate abstention. Output is evidence in Nomila's contracts (research-spec/1,
cited-claims/3, direct-evidence/1) with provenance that Nomila validates deterministically. This is the mode under
evaluation in the Step 4 Gemini/OpenAI direct-research experiment.

**Reasoning / Creative Mode — grounding/search OFF by default.** The model receives Nomila's canonical intelligence
(the Canonical Athlete Profile, facts with provenance, features, verified commercial evidence) plus the relevant
context and assets, and reasons, synthesizes, strategizes, brainstorms and creates without being constrained to
grounded-search behaviour. Examples: athlete positioning, narrative development, campaign concepts, content ideas,
recommendations, pitch storytelling, bios, website copy and other creative generation.

**Mixed workflows separate the stages:**

```
grounded external research  →  canonical Nomila intelligence  →  ungrounded reasoning / creative generation
```

For example, research into a brand's current campaigns runs grounded; the verified facts plus the Athlete Profile are
then handed to an ungrounded reasoning/creative model to develop the campaign concept. Facts never originate in the
creative stage; creativity never runs inside the research stage.

**Routing implication.** Model routing selects **model + execution mode**. The provider that performs best at grounded
research need not be the provider that performs best at reasoning, strategy or creative generation, and the choice is
made per stage.

**Clarification for the Gemini hybrid research format.** The factual prose Gemini returns in the direct-research hybrid
response exists solely to preserve native grounding/citation lineage (grounding supports attach to natural-language
text, not to JSON). It is research/evidence prose, produced in Research / Fact Mode, and it is not a precedent for
downstream Nomila generation.

## P-2 One provenance vocabulary across every intelligence surface (14 Sep 2026)

Every material value Nomila produces carries exactly one evidence class. The same four words are used by Marketability,
Rates, Opportunity, Earnings and the Commercial Snapshot — a surface may use fewer, never different ones.

| class | meaning |
|---|---|
| `MEASURED` | observed from authoritative first-party or platform data (connected analytics, a platform API) |
| `EVALUATED` | a judgment made from evidence — the evaluator read public material and formed a view |
| `ASSUMED` | a value we chose rather than observed: a benchmark, a policy constant, an expert prior |
| `MISSING` | not known, and not silently replaced by a number that looks known |

`DERIVED` is **not** an evidence class. It describes how a value was produced — computed from other values — and a
derived value keeps lineage to its inputs, each of which carries its own class. `MEASURED` is deliberately the word,
not `OBSERVED`: the vocabulary was established for M.I.A.'s social sub-signals and Commercial Intelligence extends it
rather than forking it.

**A surface does not manufacture uses for every class.** M.I.A. today emits `MEASURED`, `EVALUATED` and `MISSING`; it
has no business producing `ASSUMED` unless an assumption is deliberately introduced. Each engine declares the classes
it may emit, and that declaration is enforced by test rather than by review.

## P-3 Confidence propagates from the weakest material input (14 Sep 2026)

> A derived value's confidence may never exceed the confidence of its least-confident **material** input.

Without this rule a chain of four plausible multiplications produces one confident-looking number and every provenance
label upstream becomes decorative. `Earnings = Rate x volume x conversion x capacity` is LOW confidence when volume is
an assumption at LOW confidence, however well-evidenced the rate is.

**Material must be defined per derivation**, or the rule is unenforceable: everything is an input and everything
collapses to LOW. An input is material when it can move the output by more than the derivation's stated threshold.
Inputs below it are recorded in the lineage but do not bind the confidence.

Propagation may later become more sophisticated if empirical evidence warrants it. It may never move **upward**.

## P-4 An assumption must name its source and its version (14 Sep 2026)

An `ASSUMED` value carries the basis it came from — published benchmark, expert judgment, Nomila policy, or an
empirical model — plus a version, a confidence and, where it is a quantity, an explicit range.

This exists because of a live example. `PAV_VOLUME_MIX` in `rateModelConfig.ts` assumes 12, 24 or 36 social posts per
year by follower tier, and Projected Annual Value is literally rate x that constant. `LICENSING_GUARANTEE.coeffPerFollower`
carries the comment `INVENTED — calibration target #1`. Both are honest in the source and invisible in the output: the
athlete sees a number with no indication that an assumption is inside it, and those numbers already feed deal scoring
and negotiation advice. Assumptions stop being invisible constants only when the contract forces them to declare
themselves.

Assumption sets are versioned the way engine parameters are, through `model_params` — the `rates`, `opportunity` and
`earnings` families already exist for this.

## P-5 An EVALUATED field states what would falsify it (14 Sep 2026)

An `EVALUATED` value carries its evidence basis, its confidence, and — **where an eventual observable outcome exists** —
the outcome that would validate or falsify the judgment.

The qualifier is deliberate: some qualitative judgments have no clean future falsifier, and inventing one to satisfy a
schema is worse than admitting there isn't one. But where a falsifier does exist it is written down when the field is
defined, not later. Otherwise "EVALUATED, LOW confidence" becomes an excuse that never expires; with it, the claim
becomes testable the moment the prediction ledger has data.

## P-6 Rationale and change explanation are different artifacts (14 Sep 2026)

Blueprint §19 locks: *explanations are generated from deterministic drivers, not invented after the fact.* That was
written when every value was to be deterministically derived. Once judgment is evaluator-owned, arithmetic cannot
explain a judgment — a driver diff can say engagement quality is 86; it cannot say why the evaluator read the public
evidence as exceptional. So there are two artifacts, and only one of them was specified:

**Evaluator rationale** explains why the evaluator made a qualitative judgment. It is generated at the same time as the
judgment, grounded in the same evidence, persisted with it, and shares its evaluator and methodology version. It is
**never independently regenerated** — prose regenerated apart from the judgment it describes will eventually explain a
number it did not produce, which is worse than having no prose because the mismatch is invisible.

**Change explanation** explains why a deterministic result moved between snapshots. It is generated from the actual
input and driver diff and is **never reconstructed by a model after the fact**.

This resolves the apparent conflict with §19 rather than overriding it: the locked rule governs change explanation,
which remains deterministic.

## P-7 Every prediction is persisted with what produced it (14 Sep 2026)

An estimate written without the versions, inputs, evidence classes, confidence and assumptions that produced it is
unusable as evidence later. Learning does not begin with an algorithm; it begins with not discarding the prediction.

Each prediction is one immutable row recording subject, kind, value, evidence classes, confidence, the parameter
versions in force, a snapshot of its material inputs, its assumptions, and an as-of date. Corrections supersede rather
than overwrite, following `research_evidence`/`athlete_facts`. Every realised outcome links back to the prediction that
preceded it — **including when the outcome happened anyway.** Without that link, outcome data cannot distinguish "this
deal happened because we recommended it" from "this happened regardless", and a system that learns from the deals it
caused is confirming itself. ADR-011 blocks that loop through the score; this blocks the subtler one through
Opportunity and Rates.

The pattern already exists in the repo: `pending_actions` records a proposal and its disposition in one row.

## Related records

- `phase-a/step4-research-spec-v1.md` — the frozen research brief (`research-spec/1`).
- `phase-a/step4-direct-research-experiment.md` — the direct-research A/B design, probe findings and the execution rule that applies P-1 to research calls.

## P-8 Zero measured activity is not measured zero performance (17 Sep 2026)

A metric is evidence only where its **measurement conditions** make the value meaningful. A number produced by a
measurement with nothing to measure carries no information about the thing it appears to describe, and it is dangerous
precisely because it arrives in the same shape as a real one.

The instance that produced this principle: YouTube's `averageViewPercentage = 0` for an account with no videos means
*"nothing to average"*, and the v2 reader rendered it as *"0.00% of video viewed"* — a measurement of weakness where
there was an absence of measurement. It would have depressed Engagement Quality for an athlete whose YouTube presence
simply had not started yet.

The same trap is open wherever a metric has a denominator: story efficiency, retention, campaign performance, rate
activity fit, any future ratio. And it is not limited to zero — a ratio over a sample of one is valid arithmetic and
weak evidence.

**Connected and authoritative is not the same as informative.** A measurement's authority comes from its source; its
informativeness comes from whether there was activity to measure. Treating the first as the second is how an absence of
evidence becomes evidence of absence, in a form that survives review because the number is technically correct.

So: before a metric is read as evidence, establish that sufficient relevant activity occurred for the value to mean
what it claims. Where it did not, the metric is **missing evidence**, not weak performance.

## P-9 Evidence-bounded capability (17 Sep 2026)

**Do not claim, model or operationalize a capability that current evidence cannot support.** Where the required
evidence or outcome observability does not exist, **defer the capability or represent the limitation explicitly**
rather than inventing proxies, precision or unsupported structure.

An abstraction built for a case we cannot yet observe, compare or learn from is not foresight — it is a commitment
made at the moment we know least, which every later decision must then honour. The same applies to a number: precision
we cannot support is unsupported structure wearing a more convincing shape.

The principle governs three distinct moves, and the third is the one most easily missed: deferring a capability,
representing its absence honestly, and **declining to manufacture a proxy that looks like the thing**. MIA Beta.1 took
the third route twice — publishing no confidence interval from a single repeat per athlete, and emitting a null
confidence band rather than keeping invented 70/40 thresholds.

The instance that produced this principle: Rate Beta.1's estimate contract is `low / expected / high` in USD. A
Licensing Royalty is a percentage of a contract-specific revenue base. Making the contract carry both would mean a unit
discriminator or a second estimate kind — a real type change, adopted to serve one activity family for which Nomila has
**no outcome representation at all** (royalty, revenue-share and bonus economics have no columns anywhere), so nothing
it produced could be compared against anything or corrected by anything.

The test is not *"might we need this?"* — the answer to that is always yes. It is: **can the capability be exercised,
observed and corrected with the evidence we actually have?** Where it cannot, defer it and record why, so the deferral
is a decision with a stated trigger rather than an omission someone later reads as an oversight.

This is distinct from ADR-011, which protects against circularity — an output quietly becoming its own input. P-9
protects against something simpler: paying a permanent structural cost for a capability nothing can yet validate, or
asserting a precision the evidence never supported.
