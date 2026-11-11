# Rate Model — Research Reference (extracted from nomila v1)

**Purpose.** Preserve everything v1 knew about athlete **deal rates** and **Projected Annual Value (PAV)** — the models, the market sources, the ground-truth data, and the honest limitations — so v2 can build a credible, refreshable, market-anchored rate system. Sourced from `C:\ClaudeProjects\nomila` (v1) via a full code + docs extraction (2026-07).

---

## TL;DR
- v1 documented a **market-benchmarked, segment-aware CPM rate model** (based on **Opendorse / On3 / Hookit** + ad-tech CPMs) — but **never shipped it**.
- Both v1 *and* v2 shipped a weaker **segment-blind follower-bracket** model (cited to **Influencer Marketing Hub** only). v2 inherited it unchanged.
- v1's own eval flagged the shipped rates as **uncalibrated**: **Spearman ρ ≈ 0.40, MAPE ≈ 70.6%**.
- v1 has a **portable golden-athlete ground-truth set** (5 anchors with published PAV from On3/Forbes) — ideal for validating any new model. (One anchor's cohort even overlaps v2's roster: Chisom Okpara.)
- Direction confirmed: **restore segment-aware CPM (benchmark-anchored) + score as a modifier + periodic external-research refresh + later calibrate with our own closed deals.**

---

## 1. The two v1 rate models

### 1a. SHIPPED (v1 code = what v2 also runs today)
`miaScoreService.ts` + `seedWeightsV6.ts`. Same shape as v2's `scoringService.ts`.

- **Per-post base:** `baseRate = lerp(bracket.lerpMin, bracket.lerpMax, score/100)`, then `× engagementMult` (1.3 if ER≥5%, 1.15 if ER≥3%, else 1.0).
- **Follower→$ brackets** (segment-blind — followers only):

  | Min followers | lerpMin | lerpMax |
  |---|---|---|
  | 1,000,000 | $22,500 | $75,000 |
  | 500,000 | $7,500 | $22,500 |
  | 100,000 | $1,500 | $7,500 |
  | 10,000 | $300 | $1,500 |
  | 1,000 | $30 | $300 |
  | < 1,000 | → $0 |

- **Deal-type rates & PAV:** `neutralBase = bracket-midpoint`; `effectiveScore = Σ(capital × dealTypeWeight)`; `mid = neutralBase × (effectiveScore/50)`; `low = mid×0.5`, `high = mid×1.8`; `PAV = Σ(rate × annualUnits)`.

  | Deal type | audience | commercial | brand | athletic | narrative | annualUnits |
  |---|---|---|---|---|---|---|
  | socialPost | 0.50 | 0.10 | 0.15 | 0.10 | 0.15 | 20 |
  | appearance | 0.15 | 0.05 | 0.20 | 0.30 | 0.30 | 12 |
  | ambassador | 0.20 | 0.15 | 0.30 | 0.05 | 0.30 | 18 |
  | autograph | 0.20 | 0.05 | 0.20 | 0.30 | 0.25 | 8 |
  | licensing | 0.30 | 0.10 | 0.15 | 0.20 | 0.25 | 1 |

- **Narrative (5th capital, rate-only):** `min(100, (googleTrends[0–10] + gdelt[0–6]) × 6.25)`.
- **PAV floors:** pro/olympic $10K; power-conf D1 $2K; else $0.
- **Source cited (shipped brackets):** *"published influencer market-rate benchmarks (Influencer Marketing Hub) with an engagement-rate multiplier"* — `miaScoreService.ts:566`.

### 1b. PLANNED (documented, industry-benchmarked, NEVER shipped)
`docs/MIA_ALGORITHM_V2_PLAN.md` + ideation assets. **This is the better-grounded model.**

- **Formula:** `Rate = (Followers / 1000) × BaseCPM × MIA_Multiplier` (CPM = cost per 1k views; midpoint of the tier range used).
- **Segment-tiered CPM** *(based on "2024–2025 market data", normalized against Opendorse/On3/Hookit + ad-tech CPMs):*

  | Tier | Base CPM | elite (≥90) | standard (60–89) | risk (<60) |
  |---|---|---|---|---|
  | High school | $15–35 | 1.5× | 1.0× | 0.8× |
  | College G5 / D2 | $25–50 | 1.2× | 1.0× | 0.8× |
  | College P4 | $75–150 | 1.3× | 1.0× | 0.9× |
  | Pro | $500–2000 | 2.0× | 1.0× | 1.0× |

- **Worked examples (doc):** HS QB 50k/94 → $1,875; SEC LB 15k/78 → $1,687; D1 gymnast 2M/91 → $292,500.
- **Key regression vs shipped:** this differentiates by **athlete tier** (pro CPM is 10–40× HS). The shipped bracket model does **not** — a high-schooler and a pro with equal followers get the same base. This is the single biggest fidelity gap.

---

## 2. External market sources (what each was used for)
- **Opendorse, On3, Hookit** — the foundational rate *methodology* basis for the CPM table (*"researched the current valuation models (Opendorse, On3, Hookit) and normalized them against standard ad-tech CPMs"*). Only in narrative/plan docs — **no numbers survived into shipped code.**
- **Influencer Marketing Hub** — the source cited for the **shipped** follower-bracket table.
- **On3** — ground-truth NIL valuations (4 golden anchors).
- **Forbes** — ground-truth pro off-field earnings (1 golden anchor).
- **2024–2025 market data** — generic citation for the CPM tiers.

> Opendorse's public reports break pricing down by **activity type (social post / appearance / autograph / shout-out)** — a near-1:1 map to our deal types, making it the best single external calibration source for the athlete side. Extend research to **general creator/influencer rate cards** for the audience-based portion (athletes carry a premium on top).

---

## 3. Golden-athlete ground-truth set (for validation/calibration)
Portable — the anchors are **hardcoded** in `enrichGoldenSubset.ts` (not DB-locked).

**The 5 calibration anchors (only rows with ground-truth PAV):**

| Name | School | Sport | Ground-truth PAV | Source |
|---|---|---|---|---|
| Arch Manning | Texas | Football | $5.4M | On3 |
| Livvy Dunne | LSU | Gymnastics | $4.0M | On3 |
| Caitlin Clark | Indiana Fever | Basketball | $22.0M | Forbes (off-field, pro) |
| Travis Hunter | Colorado | Football | $3.0M | On3 |
| JuJu Watkins | USC | Basketball | $1.0M | On3 |

Plus **41 Stanford athletes** enriched but with **no PAV** (distribution set, not ground truth) — includes **Chisom Okpara** (overlaps v2's roster).

**v1 `golden_athletes` schema** had `tier`, `sport`, `ground_truth_pav`, `ground_truth_source` (`on3|forbes|opendorse|manual`), `notes`, `active`. **v2's `golden_athletes` is simpler** (`athlete_id`, `ground_truth_pav`, `notes`, `active`) — to migrate faithfully, add a `ground_truth_source` column.

**Migration path (recommended):** re-seed the 5 anchors in v2 by looking up/creating each athlete via `full_name + sport + school`, then insert `golden_athletes` rows with PAV + source. (v1 `athlete_profile_id` UUIDs don't carry over — re-key by name.) The 41 Stanford rows add nothing to PAV calibration; skip unless wanted for distribution testing.

---

## 4. Known accuracy & limitations (v1's own eval, `evaluate.ts` / `mia-score-algorithm.md`)
- **Spearman ρ ≈ 0.40, MAPE ≈ 70.6%** (2026-05-25) — rates explicitly labeled **uncalibrated**. *This is the strongest argument for a benchmark-anchored model + closed-deal calibration.*
- **Commercial Capital = 0** for all seeded profiles (no deal data) — same structural gap as v2.
- **Arch Manning outlier:** GT-PAV ~$5.4M vs projected ~$192K — name/legacy premium not modeled; follower count dominates the estimate.
- Many golden athletes had 0 followers / missing engagement → floored, sparse baselines.
- Prior PAV was `estimatedRate × 48 posts/yr`; replaced by the multi-deal-type sum (the model both v1-shipped and v2 use).

---

## 5. Design principles worth carrying forward
- **"Relative Score, Absolute Value"** — separate **Score** (quality, 0–850) from **Rate** (dollars, market-anchored). A "99" HS player ≠ a "99" pro. *v2 currently blurs this.*
- **Midpoint/median CPM strategy** — quote the median of a benchmark range so numbers feel precise and defensible, not arbitrary.
- **TikTok engagement ×0.75** — views-based ER inflates vs IG followers-based ER (still in v2).
- **Commercial weight reduced until deal data exists** — cold-start reality (still true; the inbound-demand idea addresses it).
- **"Trust but Verify"** — engagement/velocity/safety aren't searchable → verify via OAuth or ask.

---

## 6. Gap analysis & recommendations (v2)
**Where v2 stands vs the research:**
1. Uses the **segment-blind bracket** model → systematically mis-prices across tiers. **The CPM-tier research (Opendorse/On3/Hookit) exists on paper but isn't in the live model.**
2. `dealTypeWeights` + `annualUnits` carried over from v1 **never re-derived** from market data.
3. Rates are known-**uncalibrated** (ρ=0.40) and there's no refresh or calibration loop for the *market model* (per-athlete inputs now refresh daily via Part B; the global model is static).

**Recommended direction (this is the foundation for it):**
1. **Restore segment-aware CPM** — `Rate = MarketBase(platform, tier/sport, deal_type) × EngagementAdj × ScoreMultiplier`; seed MarketBase from the v1 CPM tiers.
2. **Migrate the 5 golden anchors** → backtest every model version against them.
3. **Quarterly external-research refresh** of the market model (grounded research over Opendorse/On3/Hookit + creator rate cards → versioned draft → human review → activate).
4. **Closed-deal calibration** (credibility-weighted blend) once deal flow exists — the real per-athlete rate.
5. Present **low/mid/high with the low as the floor**, plus **provenance + per-deal-type confidence** — because these are used in negotiations and by athletes to set a floor.

---

## 7. Per-deal rate benchmarks — Influencer Marketing Hub + corroborating sources (2026)
The **right** ground-truth for the *rate card* (per-deal, not total valuation). IMH is the source v1 originally cited; its own page renders the tables as charts, so figures below are the canonical IMH tier structure as reproduced by Meltwater, cross-checked against ContentGrip. Expect **source variance** — these are estimates; treat as ranges, not truth.

**Tier boundaries (IMH):** Nano 1K–10K · Micro 10K–50K · Mid 50K–500K · Macro 500K–1M · Mega 1M+. (Some sources collapse Micro+Mid at 10K–100K, Macro 100K–500K, Mega 500K+.)

**Per-post / per-video rate ranges (Meltwater/IMH baseline):**

| Platform | Nano (≤10K) | Micro–Mid (10K–100K) | Macro (100K–500K) | Mega (500K+) |
|---|---|---|---|---|
| **Instagram** (post) | $20–$100 | $100–$5,000 | $5,000–$10,000 | $10,000+ |
| **TikTok** (post) | $5–$50 | $25–$1,250 | $1,250–$2,500 | $2,500+ (top $10k+) |
| **YouTube** (video) | $20–$200 | $200–$10,000 | $10,000–$20,000 | $20,000+ |
| IG Stories | — | $53–$1,205 | — | — |
| X/Twitter | ~**$2 per 1,000 followers / tweet** | | | |

ContentGrip's card runs **higher** (IG micro $500–$5k, mid $5k–$20k, macro $10k–$50k, mega $100k+) — a more agency/B2B-weighted view. Use as the upper band.

**Format multipliers:** video/Reels **+25–50%** vs static; Reels ~**+32%** vs equivalent TikTok; Stories cost less than feed posts.

**Commercial multipliers (map directly to our deal types):** usage rights **+20–30%**, category exclusivity **+15–25%**, rush (<72h) **+20–50%**, whitelisting can **~2×** base.

### Why this matters for the model
1. **Platform-specific.** TikTok « Instagram « YouTube for the *same* follower count (a 50K-follower post is ~$25–$1,250 on TikTok vs ~$200–$10,000 on YouTube). **v2's model isn't platform-specific in the base rate** (it uses *total* followers) — a real gap this data exposes.
2. **This is the per-deal rate target** — anchors the `socialPost` rate directly, and via the +% commercial multipliers, the `ambassador`/`licensing` premiums (usage rights + exclusivity). On3/Forbes totals stay as a loose star-power upper bound only.
3. **Ranges are wide + sources disagree** → present rates as ranges with a conservative floor, and calibrate toward our own closed deals as they arrive.

Sources: [Influencer Marketing Hub](https://influencermarketinghub.com/influencer-rates/), [Meltwater](https://www.meltwater.com/en/blog/influencer-marketing-costs-rates-pricing), [ContentGrip](https://www.contentgrip.com/influencer-marketing-rate-card/).

---

## 8. Per-deal benchmarks for the non-social deal types (appearance / autograph / licensing)
IMH (§7) covers social posts. The other deal types need different sources — researched below (2025–26). **Key reality: no single source publishes clean transaction-backed per-activity rate cards for free.** The usable data splits into (i) free *real posted prices* on marketplaces, (ii) free *aggregate* NIL reports, (iii) paid granular datasets.

### Appearance
| Segment | Rate | Source |
|---|---|---|
| Pro/celebrity (in-person) | $5K–$10K (regional) · $20K–$40K (household) · $50K–$100K (legend) · $100K+ (megastar); floor ~$7,500 | Speaker bureaus (AthleteSpeakers, SportsSpeakers360, [Mayfield](https://mayfieldsportsmarketing.com/), BigSpeak, AAE) |
| Pro virtual | 20–50% cheaper than in-person | same |
| Named ex. | Allyson Felix $100K–200K live/$50K–100K virtual; Deion Sanders $200K+ | AAE |
| Cameo (shoutout proxy) | avg ~$50; athletes $50–$1,000+ (Drew Brees $712, Ray Lewis $330) | [Cameo](https://financebuzz.com/cameo-cost-analysis) (free, scrapable) |
| College/NIL | median deal <$500; avg approved deal ~$7,300; D-I ~$3,063/deal; rare outliers ($80K single) | Opendorse reports; College Sports Commission |

- **Best free sources:** speaker bureaus (pro, posted ranges) + Cameo (virtual, real prices). **Best NIL:** Opendorse ARC rate-card engine — but login/partnership-gated.

### Autograph
Per-**item** tiered pricing (Fanatics Fest NYC 2025 sheet): standard (cards/flats) **$271** · premium (jerseys/bats) **$326** · ultra-premium (game-used/milestone) **$543**; inscription **+$98**. Named: Jordan **$500–$2,500**/sig, Jeter **$400–$1,000**; budget names **$33–$40**. NIL autograph deals: sub-$500 median, rare outliers ($24K, $10.5K).
- **Best free sources:** [cllct Fanatics Fest price guide](https://www.cllct.com/sports-collectibles/autographs/fanatics-fest-nyc-2025-price-guide-for-autographs) (tiered per-athlete sheet); autograph dealers (Powers, Ultimate Autographs); **grassroots current signing fees: Sports Collectors Net (SCN)** — cheap subscription, best per-athlete real fees (via Gemini). Secondary-market *value*: SigPrices (eBay/auction scrape), Beckett, PSA.

### Licensing
Priced as **royalty % of net wholesale** against an **advance + guaranteed minimum** (not a flat fee):

| Category | Royalty % |
|---|---|
| Sports overall | 8–12% |
| Apparel | 8–12% (up to 15%) |
| Headwear | 10–15% |
| Jerseys / limited editions | up to 18% |
| Toys & games | 5–8% |
| Electronics / video games | 3–5% |

`Annual royalty $ = net sales × royalty %`, athlete earns **greater of** accrued royalties or the guarantee. **Group licensing** (players-association pools, equal-share + premium): NFLPA floor **~$38K**, top **$1M–$17.7M** (Shedeur Sanders record ~$17.7M); college EA game flat **$600→$1,500** (no royalty); college cards guaranteed **~$500–$1,600/athlete**.
- **Best free sources:** [Number Analytics](https://www.numberanalytics.com/blog/royalty-rates-in-sports-licensing) (royalty % by category); **NFLPA LM-2 DOL filings** (real per-player $ distribution). Market size: Licensing International (paid).

### Source landscape — accessibility & recommendation
| Deal type | Best source | Free today? | Nature |
|---|---|---|---|
| Social post | IMH/Meltwater rate cards + Opendorse mix; **Collabstr / OpenSponsorship** athlete calculators | ✅ | estimate + aggregate |
| Appearance | Speaker bureaus (pro) + Cameo (virtual) | ✅ real posted | asking prices |
| Autograph | Fanatics Fest sheet + dealers + **SCN** | ✅ real | posted/grassroots |
| Ambassador | SponsorUnited NIL report + Opendorse value bands | partial | transaction-backed |
| Licensing | Number Analytics royalty % + NFLPA LM-2 $ | ✅ | industry norm + real $ |

**Transaction-backed but paid/partnership-gated (granular per-activity):** Opendorse ARC/API, INFLCR-Teamworks, SponsorUnited platform, Basepath, MarketPryce, OpenSponsorship API. **Directional only (algorithmic estimate, not real deals):** On3 valuations.

**Caveat:** Opendorse & INFLCR annual PDFs are image-based (not text-extractable) — headline stats come from their text + secondary coverage. For production-grade per-activity rates, a paid Opendorse/INFLCR partnership is the eventual upgrade; the free marketplace sources (Cameo, bureaus, Fanatics/SCN, royalty norms) are enough to seed and sanity-check the model now.

Sources (agents + Gemini): AthleteSpeakers, SportsSpeakers360, Mayfield, AAE, BigSpeak, Cameo/FinanceBuzz, cllct/Fanatics Fest, Powers/Ultimate Autographs, SigPrices, Beckett, PSA, Sports Collectors Net, Number Analytics, NFLPA LM-2, Licensing International, OneTeam, Opendorse "NIL at 4", INFLCR/Teamworks, SponsorUnited, Collabstr, OpenSponsorship, Launchpoint, On3.
