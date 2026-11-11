# Rate Model v3 — Design Proposal (Fable 5, for review)

Design pass over the full research (`rate-model-research.md`) + the current v7 code. Produces a rate model that prices **each deal type on its correct basis**, with the MIA score as a modifier. Not yet built — this is the spec for review.

Common form: `Rate = MarketBase(deal-type-specific) × EngagementAdj × ScoreMod × SafetyMult`. MarketBase is a versioned, provenance-tagged config table (same draft→active pattern as `scoring_weights`).

> **Bug found during review:** the config's `rateEstimation.engagementMultipliers` exists but is **never applied** in v2's `computeDealTypeRates` — v1's engagement multiplier was silently dropped. Fix in Phase 2.

---

## 1. Per-deal-type architecture

### 1a. Social post — platform × follower-tier curve (log-log interpolation between IMH anchors)
Continuous curve (kills the current bracket-cliff), reproduces the §7 benchmark ranges:

| Followers | Instagram | TikTok | YouTube | X |
|---|---|---|---|---|
| 1K | $20 | $5 | $20 | $2 per 1K followers, min $10 |
| 10K | $100 | $25 | $200 | |
| 100K | $5,000 | $1,250 | $10,000 | |
| 500K | $10,000 | $2,500 | $20,000 | |
| 1M | $15,000 | $4,000 | $30,000 | |
| >1M | extrapolate last log-slope | | | |

- Format: Reels/video ×1.3, Story ×0.5. Commercial add-ons quoted separately: usage +25%, exclusivity +20%, whitelisting ×2.
- `EngagementAdj = clamp((ER_p / tierNormER)^0.5, 0.7, 1.4)` (sqrt damping). Tier-norm IG ER: nano 5% / micro 3.5% / mid 2.5% / macro 2% / mega 1.5% / celebrity 1% (TikTok ER ×0.75 first).
- **Rates are per-platform** (show IG rate + TikTok rate, not one blended number); headline = strongest platform.

Worked: **Mia** (IG 22.7K, 6.9% ER) → base $403 × 1.40 eng × 0.91 score ≈ **$515/IG post** (range $385–$695). **Livvy Dunne** (5.2M) ≈ **$66K/post**; **Arch Manning** (617K) ≈ **$13.6K**; **Caitlin Clark** (3.9M) ≈ **$50K**.

### 1b. Appearance — flat fee by prestige tier (NOT follower-scaled; followers only gate tier)
| Tier | Gate | low / mid / high (in-person) |
|---|---|---|
| P1 Megastar | pro+Icon or 10M+ | $50K / $75K / $150K |
| P2 Household pro | pro+Elite or 3M+ | $20K / $30K / $50K |
| P3 Regional pro / college mega | pro or college 1M+ | $7.5K / $12K / $25K |
| P4 College national name | P4+Elite or 250K+ | $2.5K / $5K / $10K |
| P5 College D1 standard | D1 | $500 / $1K / $2.5K |
| P6 Other college | D2/D3/NAIA | $150 / $400 / $750 |
| P7 HS | high_school | $0 / $150 / $400 |

Virtual ×0.5; shoutout sub-type $25–$500 NIL. Mia → ~$900 mid.

### 1c. Ambassador — retainer off the social rate
`monthlyRetainer ≈ 3.08 × socialPostMid` (2.5 post-equiv deliverables × (1+0.25 usage +0.20 exclusivity) × 0.85 volume discount). Quote **per month**. Mia ≈ **$1,590/mo**.

### 1d. Autograph — per-item flat tiers × batch size
| Tier | standard / premium / ultra (per item) |
|---|---|
| Pro icon | $500 / $1,000 / $2,500 |
| Pro elite | $271 / $326 / $543 (Fanatics Fest 2025) |
| Pro standard/former | $35 / $60 / $100 |
| College national name | $50 / $75 / $125 |
| College standard | $15 / $25 / $50 |
| HS | $5 / $10 / $20 |

Inscription +$98 pro / +$25 college. Deal value = per-item × batch (NIL 25, pro 150). Audience capital weight = 0.

### 1e. Licensing — royalty %, not a flat fee (output shape changes)
`{ royaltyPct: {low,mid,high}, minimumGuarantee: {low,mid,high}, category }`:
- Royalty % by category: apparel 8–12% (default 10%), headwear 10–15%, jerseys ≤18%, toys 5–8%, games 3–5%. **Score never touches the %.**
- Guarantee = `clamp(totalFollowers × $0.02 × ScoreMod, segmentFloor, —)`; floors: pro $25K, college-mega $10K, college std $500, HS $0. **The $0.02/follower coefficient is invented → calibration target #1.**

### 1f. PAV — probability-weighted (replaces the per-everyone `annualUnits` inflation)
`PAV = Σ attachProb(tier) × conditionalUnits × rate`:

| Deal type | NIL micro | NIL macro (250K+) | Pro |
|---|---|---|---|
| socialPost (posts/yr) | 12 | 24 | 36 |
| appearance | 2 | 6 | 10 |
| ambassador (attach×months) | 0.3×12 | 0.8×12 | 1.0×12 |
| autograph (batches) | 1 | 2 | 4 |
| licensing (attach) | 0.05 | 0.5 | 0.9 |

Mia PAV mid ≈ **$14.8K/yr** (range ~$9K–$22K). Keep `applyPAVFloor`.

## 2. Score as modifier
`ScoreMod = clamp(0.80 + 0.40×(S/100), lo, hi)`, S = deal-type-weighted capital blend. **Audience capital excluded where followers already drive the base (no double-count); engagement excluded everywhere (lives in EngagementAdj).**

| Deal type | Capital weights for S | Bounds |
|---|---|---|
| socialPost | brand .40, narrative .30, athletic .20, commercial .10 | [0.80,1.30] |
| appearance | athletic .40, brand .30, narrative .30 | [0.70,1.40] |
| ambassador | brand .40, commercial .30, narrative .20, athletic .10 | [0.80,1.30] |
| autograph | athletic .50, narrative .30, brand .20 | [0.70,1.50] |
| licensing guarantee | brand .40, audience .30, narrative .30 | [0.80,1.30] |

Score never touches royalty %, CPM anchors, or tier boundaries. **Cold-start shrinkage:** `mod' = 1 + (mod−1)×dataConfidence`. Max data-driven swing ~2× — deliberately far below the 11× legacy/stardom spread (star premium is out of scope for a rate card).

## 3. Two-target backtest
- **(a) Score vs star-power** (rank only): 5 anchors + ~25–30 On3 top-100. **Pass: Spearman ρ ≥ 0.75** (vs 0.40 today); anchors-only Kendall τ ≥ 0.6.
- **(b) Rate vs per-deal benchmarks** (absolute): ~50-cell test set. **Range hit-rate ≥ 80%** (mid inside benchmark range); **median |log₁₀(model/benchmark)| ≤ 0.25** (~1.8×); named-athlete within 2× for ≥70%. Exclude Arch (legacy) + Caitlin (equity/pro) from magnitude pass/fail.
- `server/scripts/evaluateRates.ts`; block activation of a version that regresses either metric.

## 4. Confidence & provenance
`confidence = benchmarkQuality × inputProvenance × marketRecency`:
- benchmarkQuality: transaction-backed 1.0 · posted prices 0.8 · aggregate estimates 0.6 · algorithmic (On3) 0.4
- inputProvenance (from `source` fields): connected 1.0 · provider 0.85 · discovery 0.7 · research 0.5
- recency: <2 quarters 1.0 · <4 0.85 · older 0.7

Drives range width: high (≥0.75) → 0.75×/1.35×; medium → 0.6×/1.6×; low → 0.5×/2.0×. **Low always labeled "conservative floor."** Store `{confidence, provenance, model_version}` in the existing `deal_type_rates` JSONB (no migration).

## 5. Refresh + calibration
- **Market refresh (quarterly):** versioned config, research pass regenerates each cell w/ citations → human diff review (alert on >30% cell moves) → activate.
- **Closed-deal calibration (Bühlmann credibility, log-space):** per cell, `log(rate) = z·log(median_ourDeals) + (1−z)·log(benchmark)`, `z = n/(n+k)`, **k=10** (per-athlete overlay k=3). Range shrinks `×(1−0.5z)`. Activates at n=1, no architecture change — cold-start→data-driven is just z rising.

## 6. Phasing
- **Phase 1 (now, ~1 wk, free data):** new `rateService.ts` (leave scoring untouched), 5 formulas + seeded config, per-platform social, prob-weighted PAV, golden-anchor backtest harness, ship in **shadow mode** then cut over.
- **Phase 2 (~2–3 wk):** confidence/provenance in API+UI, extended On3 backtest set, quarterly refresh runbook, fix dropped engagement multiplier, YouTube/X engagement norms.
- **Phase 3 (deferred/paid):** Cameo+SCN scrapers (cheap); **Opendorse ARC / INFLCR partnership** for transaction-backed NIL per-activity rates; closed-deal blending once cells reach n≥5.

## 7. Limitations & open questions
1. **NIL appearance/autograph data is thinnest** — P5–P7 + college autograph rows are interpolations; expect ±2× until ARC or own deals.
2. IMH social ranges span ~50× within a tier; anchor choice dominates. Seeded from conservative Meltwater/IMH band on purpose (safe floors).
3. **Licensing guarantee $0.02/follower is invented** — royalty % is sourced, guarantee isn't. Ship flagged low-confidence.
4. **Legacy/star premium deliberately unmodeled** (~2× max swing vs 11× anchor spread) → Arch backtests ~4–5× under On3. Correct for a rate card, but UI must say "market rate, not total valuation."
5. Cameo/bureau numbers are **asking** prices (negotiated down 20–40%); ambassador deliverable + attach assumptions are structural guesses.

**Open questions for the founder:**
- **Sport/gender multiplier?** Livvy/Caitlin/JuJu all over-index — is a women's-sport premium in scope?
- **Audience demographics into social CPM?** (US/high-value-geo audiences command higher CPM; already captured in `social_analytics_snapshots`.)
- **Athlete-vs-creator premium?** Asserted in research, no number — seeded at 1.0×.
- **Ambassador: monthly retainer or annual total** in the app?

**Bottom line:** Phase 1 is buildable now entirely from free data, prices every deal type on its correct basis, and ships with a pass/fail harness (ρ≥0.75, range hit-rate ≥80%) the current model (ρ=0.40, MAPE 70.6%) would fail.
