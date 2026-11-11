# `rate-eval-spec/2.0.0` — DRAFT for line-by-line review

**Status: DRAFT. Not implemented, not pinned, not run.** Nothing in the codebase reads this file.
**Date:** 2026-09-19

This is the **exact text** proposed for the Rate evaluator, plus the output contract. Read it as the model will
receive it. `rate-eval-spec/1.1.0` remains frozen and intact in `server/services/rateBeta1EvaluatorSpec.ts`; this
replaces it only if approved.

**Why 2.0 rather than 1.2.0.** The output contract changes materially and the governing philosophy changes with it.
1.x asked the evaluator to establish that evidence had earned the right to produce a rate. 2.x asks it to price.
Calling it 2.0 keeps that history honest.

**What is unchanged and not restated here:** §7's seven terms bases, all at `1.0.0`, and the eleven canonical rate
slots. Those were the part of Beta.1 that the experiment validated rather than strained.

---

## What changed, and why — read this before the text

| | 1.1.0 | 2.0.0 | evidence |
|---|---|---|---|
| **Governing task** | establish whether evidence supports an estimate | estimate what the athlete should charge | the whole experiment |
| **Block 1** | comparability tests, benchmark-implied range, departure rationale, anchor selection | use benchmarks as guidance; explain what moved the estimate | Block 1's apparatus produced no observed benefit |
| **Block 4** | prior execution effectively required | prior execution not required; activities differ by *kind*, not duration | Livvy: 2h appearance = 2h autograph = 2h clinic = $150k |
| **NOT_ESTABLISHED** | whenever evidence cannot support an estimate | only when no **athlete-specific** basis exists, or the activity doesn't apply | Mia's dormant TikTok refused rather than priced low |
| **Output fields** | ~17 per estimate, five evidence arrays | 9 per estimate, one evidence array | most of the structure audited the methodology, not the product |
| **Research** | evaluator researches from scratch every time | named preferred starting sources, plus open research | appearance/autograph/clinic moved ~2.5× run to run; starting points reduce, but do not remove, that variance |

**Kept deliberately, against the general simplification:**

- **`anchor_basis`** — one enum, not machinery. It answers *"is this card grounded in market evidence, her own
  history, or analogy?"* at cohort scale. §15.1 made its distribution the benchmark-coverage diagnostic.
- **`commercial_state`** — the only structured field with a demonstrated catch rate: 199 detected deals across four
  run-conditions, zero promoted. Its permitted-mapping table is mechanically checkable; prose discipline is exactly
  where it *did* fail (the structure said `null` while the rationale said *"a cash deal with SoFi"*).
- **one sentence on transient vs sustained** — §13's trigger design depends on it, or event-driven recalculation
  fires on every seasonal shift and the card becomes a spot quote.
- **measurement validity** — *a lack of measurement is not measured poor performance* (P-8).

---

# THE PROMPT TEXT

```
NOMILA RATE INTELLIGENCE — EVALUATION SPEC rate-eval-spec/2.0.0

YOUR TASK

Estimate what this athlete should reasonably charge today for each commercial activity listed, at its stated terms
basis.

Use all available information holistically: the athlete's marketability assessment and underlying context, connected
or public social measurements, commercial history and evidence — with closed deals treated as stronger evidence of
demonstrated economics — current market pricing evidence, and your own research.

Produce LOW / EXPECTED / HIGH for each activity. EXPECTED is the rate the athlete should generally ask and expect to
command today. LOW and HIGH are the defensible ends of a commercial range — not a statistical interval.

Missing or limited information should normally affect your CONFIDENCE, not prevent an estimate.

Do not invent athlete facts, transactions, partnerships, social metrics or market evidence. Distinguish what is
measured and known from what is researched or inferred.

Use commercial judgment. You are not given, and must not construct, a pricing formula.


WHEN TO DECLINE

Provide a rate whenever there is a reasonable, athlete-specific basis for estimating what this athlete should charge.

Return NOT_ESTABLISHED only when there is not enough athlete-specific information to produce a meaningfully
athlete-specific estimate, such that any number would merely restate the general market.

The following do NOT individually require NOT_ESTABLISHED: no recorded transactions; no connected social data; no
prior execution of the activity; no directly comparable benchmark; a dormant or inactive account. Each of those is
evidence to reason about and to reflect in confidence.


────────────────────────────────────────────────────────────────────────────────────────────────

1 · MARKET PRICING

Use the supplied market pricing sources as general guidance, and research further where it materially improves the
estimate.

When using a market price, understand what that price actually buys — activity and format, quantity, duration, and
material rights where the source states them — before judging its relevance.

Market examples need not match this athlete precisely. Judge how relevant each is, considering activity, platform,
audience size and quality, athlete stature, sport, geography, rights and recency.

Consider the athlete's own prior closed deals where relevant. A previously accepted price is evidence of what the
athlete accepted; it is not automatically what they can command now, and it is not automatically transferable to a
different activity.

Explain the principal market evidence that moved your estimate.

Record ANCHOR_BASIS: which foundation primarily supports this estimate —
  MARKET_EVIDENCE           market pricing evidence is the primary basis
  ATHLETE_OWN_TRANSACTIONS  the athlete's own closed deals are the primary basis
  INDIRECT_EVIDENCE         neither directly; the estimate rests mainly on analogy or adjacent evidence
  NONE                      no meaningful athlete-specific basis was available; use only with NOT_ESTABLISHED

This is a description of what you relied on. It is not a permission gate, and no value is preferred over another.


2 · DISTRIBUTION

For social activities, consider the athlete's actual ability to distribute content on that platform: followers,
reach or views, engagement, audience quality and composition, growth, posting activity, and format-specific
performance where available.

Prefer connected measurements over public estimates for the metrics they directly measure. Where connected data is
unavailable, use credible public or researched data.

Do not price from follower count alone. Actual reach and engagement can materially change the value a follower count
implies — in either direction.

A lack of measurement is not the same as measured poor performance.

Account inactivity, short measurement history or missing performance data are relevant evidence. They may lower the
rate or the confidence, and they do not by themselves prevent an estimate.

Do not apply a fixed CPM, follower multiplier or engagement multiplier.


3 · ATHLETE VALUE

Consider why a brand may value association with this athlete beyond distribution: athletic achievement and level,
recognition, cultural relevance, narrative, audience affinity, brand fit, scarcity and momentum.

Use the marketability assessment and its dimensions as structured context about this athlete. It informs the
judgment and is not a dollar conversion or a multiplier.

Weigh these factors according to their relevance to the specific activity being priced.

Commercial context can reduce value as well as raise it. Consider credible, evidenced factors such as brand-safety
concerns or category conflicts where they are relevant to the activity being priced. Do not infer such concerns from
demographic or identity characteristics.


4 · ACTIVITY FIT

Consider how well suited this athlete is to the activity being priced.

Use demonstrated experience where available. Prior execution is NOT required to estimate a rate.

Different activities draw on different things, and similar duration does not imply similar value:
  social content     platform distribution and content performance
  appearances        recognition, live draw, regional demand
  autograph sessions recognition and collector or fan demand
  camps and clinics  athletic authority, instructional credibility, local demand
  UGC                content ability and brand fit
  annual partnership sustained association, exclusivity and breadth of the relationship

Do not carry one activity's rate across to another because the sessions are the same length.


5 · COMMERCIAL HISTORY

Consider credible evidence of prior partnerships, offers, closed deals, repeat business and demonstrated demand.

Preserve what each piece of evidence actually establishes. A detected inbound email is not a partnership or a
transaction. An offer is not an accepted deal. Product or in-kind compensation is not equivalent to cash.

Consider prior deal economics in the context of what the brand actually received, and do not apply the price of one
activity to a different one.

For Nomila's own commercial records, use the canonical deal status exactly as given on each row. Record
COMMERCIAL_STATE for each piece of commercial evidence you rely on:

  INTEREST    a buyer made actual commercial contact. Detection of an inbound message does not establish this.
  ASK         the athlete requested particular economics.
  OFFER       a buyer proposed particular economics.
  AGREED      the parties agreed the stated economics and terms.
  COMPLETED   the agreed activity was fulfilled.
  null        commercially relevant, but establishes no transactional proposition.

Permitted values by canonical Nomila deal status — this is a ceiling, not a requirement:
  detected      null, or INTEREST only where the underlying evidence establishes commercial contact
  pending       null
  negotiating   INTEREST; ASK or OFFER only where the economics and the proposer are both evidenced
  accepted      AGREED
  completed     COMPLETED
  rejected      null, or OFFER where the buyer's proposed economics are evidenced

A publicly researched brand relationship may inform athlete stature and marketability. Only commercial evidence that
actually establishes economics may be treated as known deal economics. Preserve its source and provenance when
judging how reliable it is — how a transaction was recorded tells you how well it is evidenced; it does not erase
the transaction.

Your written rationale must agree with the states you record. Do not describe evidence as a partnership or a deal in
prose when you have recorded it as null.


6 · CURRENT COMMERCIAL POSITION

Consider material current circumstances affecting what the athlete can command: rising or falling athletic profile,
recent achievements, changing demand, category conflicts, limited availability.

Distinguish sustained changes in commercial position — turning professional, a major honour, a step change in
demand — from transient conditions such as an event week or a short-term scheduling conflict. Sustained changes
belong in this rate; transient and buyer-specific conditions are priced later against an actual opportunity.


7 · CONFIDENCE

Assign HIGH, MEDIUM or LOW confidence to each estimate, based on the quality, recency, relevance and completeness of
the evidence you actually used.

Confidence describes how well established the estimate is. It does not describe the athlete's value, and it does not
set the width of the range.

Evidence must be informative, not merely present. Connected data with no underlying activity, unverified inbound
opportunities, and repetition of the same underlying fact do not become strong evidence through volume.

Missing information should normally lower confidence rather than force NOT_ESTABLISHED.

State briefly the most important reason for the confidence level.

────────────────────────────────────────────────────────────────────────────────────────────────

REQUIRED OUTPUT

Return a single JSON object: { "estimates": [ ... ] }, one entry per activity listed, each carrying:

  rate_type            as listed
  platform             as listed, null where not applicable
  status               ESTABLISHED | NOT_ESTABLISHED
  low / expected / high   USD. Omitted when NOT_ESTABLISHED. LOW <= EXPECTED <= HIGH.
  confidence           HIGH | MEDIUM | LOW
  confidence_reason    one sentence
  anchor_basis         MARKET_EVIDENCE | ATHLETE_OWN_TRANSACTIONS | INDIRECT_EVIDENCE | NONE
  rationale            concise prose, written with the judgment rather than afterwards from the number
  key_evidence[]       the evidence that actually moved this estimate:
                         what            the fact relied on
                         source_class    CONNECTED | PUBLIC | RESEARCHED | ATHLETE_ASSERTED | NOMILA_RECORD | MIA
                         commercial_state  for commercial evidence only; otherwise omitted
                         ref             a URL where the evidence is external
  sources[]            market pricing sources used, with URLs where external

Return JSON only.
```

---

## What Nomila supplies alongside this prompt

**Athlete evidence** — identity and athletic context; the marketability assessment with its dimensions and summary;
connected social measurements where they exist, otherwise Business Discovery or researched public figures.

**Applicability is decided here, not by the evaluator.** A slot is sent only where the activity is possible for this
athlete — an Instagram slot is not sent to an athlete with no Instagram presence. That keeps NOT_ESTABLISHED with a
single meaning (*we cannot price this athlete-specifically*) rather than two, and avoids adding a NOT_APPLICABLE
state to the contract.

Commercial history is supplied as follows. **Closed deals (`accepted`, `completed`) in full detail** — each row
stating its own canonical status, how it was recorded, the cash/product split, the activity and the deliverables.
**`negotiating` rows carrying evidenced economics also in detail**, because those are the only rows that can
legitimately bear `ASK` or `OFFER`: defining those states while never supplying a row that could support one would
make that part of Block 5 hollow. Everything else — `detected` above all — appears **only as counts**, so volume of
inbound contact cannot become demand.

**Preferred market pricing sources**, versioned as `rate-benchmarks/2026-09`, given as **starting points rather than
a closed set**:

| source | covers | why |
|---|---|---|
| OpenSponsorship | athlete-specific social pricing; CPV/CPE derived from their own completed marketplace deals | closest to Nomila's population, and the only source deriving from transactions rather than surveys |
| Influencer Marketing Hub | platform-specific creator rates (IG / TikTok / YouTube), format multipliers | platform differentiation, which OpenSponsorship does not break out |
| Speaker bureaus (AAE, Mayfield) | **appearance and live-event** fees by athlete stature | a starting point where stature matters more than distribution |

**These are starting points, not a closed set.** Speaker-bureau appearance fees are **not** good evidence for
autograph or clinic pricing — those are different commercial products with different demand drivers. The prompt
directs the evaluator to seek activity-specific evidence for them rather than adapting an appearance fee.

The pack is dated and versioned so it can be refreshed and so a stale card is identifiable. It is a list of sources,
not extracted data — no registry, no verification pipeline.

---

## The four questions, resolved 2026-09-19

1. **`MARKET_EVIDENCE`** replaces `MARKET_BENCHMARK`. New contract; naming continuity with 1.x is not worth implying
   a curated set that does not exist.
2. **`priced_quantity` stays dropped as a field**, but the concern behind it moved into Block 1 as an instruction —
   understand what a market price actually buys before judging its relevance. The behaviour without the schema.
3. **`range_absent_reason` dropped.** Its job was to prevent manufacturing a benchmark range; 2.0 asks for Nomila's
   own LOW/EXPECTED/HIGH and never for a synthesised market range, so the job is gone with it.
4. **Source list broadened.** Bureaus are a starting point for appearance and live-event pricing only.

**Still genuinely open:** if appearance, autograph and clinic still move ~2.5× between runs under 2.0, the cause is
neither the rubric nor the source list, and the next question is whether those products can be priced from public
evidence at all.

---

## Sequence, if approved

1. Read this text line by line and settle the four open questions
2. Implement as `rate-eval-spec/2.0.0` — amend, bump, parity tests updated to the new contract, exact-text review,
   deliberate digest repin
3. Add the deterministic output validator: `LOW <= EXPECTED <= HIGH`, rejected and retried rather than stored
4. Rerun the same eight athletes, two runs each
5. Evaluate **behaviour first, prices second** — and do **not** treat the 1.1.0 cards as truth to converge toward.

   Behaviour: does it price when it should and decline when it should; does it use athlete-specific evidence rather
   than restating the market; does it respond sensibly to strong connected measurements; does it distinguish
   activities that share a duration; does it preserve deal states, in the structure *and* in the prose; does it
   avoid invented facts; and is it more stable across repeated runs.

   Only then: do the actual dollar amounts make commercial sense.
