# Nomila Commercial Intelligence Architecture — Beta.1 Developer Implementation v3

> **Imported into the repository 14 Sep 2026.** Previously held outside the repo, which meant engineering could not
> diff it, correct it, or see which parts implementation had overtaken. It is now versioned like any other design
> record.
>
> **This document is HISTORICAL IN PART.** Implementation has overtaken several of its decisions. Superseded sections
> are listed in [`SUPERSEDED.md`](./SUPERSEDED.md) and each carries an inline marker below. Nothing is deleted — the
> original decision and the evidence that overturned it are both preserved, so the reasoning survives.
>
> The single most important correction: §1/§3/§6 specify that Nomila deterministically converts evidence into
> sub-signal values and that "a fact does not directly become points because an LLM feels it is important". That was
> built (Slice E) and withdrawn. See [ADR-017](../adr/ADR-017-evaluator-owns-qualitative-judgment.md) before
> implementing anything from §6.

---


Nomila Commercial Intelligence Architecture
Working Draft v1.0-alpha • Product, Data, AI, Scoring, Pricing & Learning Architecture
Updated from voice-chat decisions and subsequent calibration discussions • September 2026
Status: ENGINEERING WORKING SPECIFICATION — NOT YET PRODUCTION-FROZEN
1. Executive Decision
Nomila should operate as an Athlete Enterprise OS with a proprietary commercial-intelligence stack. OpenAI researches and structures evidence; Nomila converts evidence into normalized signals; deterministic Nomila engines calculate marketability, rates, opportunities, and earning potential; LLMs explain results and power agent experiences. The LLM is not the source of truth for the score or price.
The system is being calibrated against a 37-athlete benchmark cohort. The existing scores and rate ranges are provisional expert-calibrated target labels, not outputs from a frozen deterministic implementation. The current objective is to convert those targets into reproducible V1 algorithms, then replace expert calibration progressively with empirical calibration from verified account data and commercial outcomes.
2. Architecture at a Glance
Google / Apple / Email Auth        ↓Name + Sport + Optional Team/School        ↓Lightweight Identity Resolution        ↓User Confirms Athlete        ↓OpenAI Research + Web Search        ↓Canonical Athlete Intelligence Profile        ↓Signal Engine / Normalization Engine        ↓Deterministic Marketability Engine (0–850)        ↓Rate Engine → Opportunity Engine → Earnings Engine        ↓Agent Context Builder        ↓Mila / Content / Commercial / Deal Agents        ↓Observed Outcomes → Learning & Calibration Engine
3. System Boundaries & Sources of Truth
Layer
Primary responsibility
Source of truth?
OpenAI Research
Identity resolution, current web research, evidence extraction, structured classification, concise research summary
Research evidence only
Athlete Intelligence Profile
Canonical structured athlete record with provenance
Yes — athlete research state
Signal/Normalization Engine
Convert raw evidence and connected-account data into standardized 0–100 signals and cohort percentiles
Yes — normalized signals
Marketability Engine
Compute dimension scores and 0–850 MIA/Marketability Score
Yes — marketability
Rate Engine
Estimate deliverable-specific low/expected/high pricing
Yes — suggested rates
Opportunity Engine
Estimate realistic commercial demand, cadence, capacity and conversion
Yes — opportunity volume
Earnings Engine
Estimate conservative/expected/upside 12-month commercial potential
Yes — earnings potential
LLM/Agents
Explain, recommend, create content, negotiate workflows using authoritative outputs
No — interpretation/application only
Learning Engine
Calibrate parameters from verified social, deal and campaign outcomes
Yes — future parameter updates, after validation/versioning
4. Research Orchestration, UX & Cost Control
Recommended onboarding flow
AUTH → confirm name → ask sport → cheap identity lookup → show likely profile → athlete confirms → full research once → save canonical profile
Do not run a full research job immediately from Google-auth name alone. Names are ambiguous and deep research before identity confirmation wastes cost and risks attaching the wrong profile. The product should make identity confirmation feel like part of the onboarding experience rather than a form-heavy process.
Cost-control principles
Full research runs after identity confirmation, not every login.
Cache the canonical research dossier and version it.
Refresh individual signal families based on TTL, events, and connected-account updates instead of repeating a full research job.
Use compact strict JSON and a concise human-readable summary; avoid unnecessary long-form output.
Cap research depth/search calls by policy and stop when evidence confidence is sufficient.
Keep the research-model router configurable so Nomila can change OpenAI models without changing downstream architecture.
Record cost telemetry per research job: model, input/output/cached tokens, search calls, latency, confidence, and estimated USD cost.
Prefer first-party connected data and authoritative direct sources over repeated general web retrieval as Nomila grows.
Research provider strategy
V1 should use OpenAI as the generalized web-research provider because the tested output quality already matches the desired Nomila experience. Tavily, Google grounding, or other providers should not be added by default. Keep a pluggable ResearchProvider interface so additional providers can be benchmarked later if OpenAI shows measurable coverage, accuracy, latency, or cost gaps.
5. Canonical Athlete Intelligence Profile
OpenAI should return strict, versioned structured JSON so Nomila engines and agents never need to parse prose to determine facts. Every important claim must include provenance, timestamp, source type, and confidence. Identity ambiguity must be returned explicitly rather than forcing a match.
AthleteResearchProfile {  schemaVersion  athlete / identityConfidence  athleticAuthority  audience  media  commercial  narrative  evidence[]  researchQuality { overallConfidence, missingFields, conflicts[] }  researchSummary { headline, summary, keySignals[] }  researchLimitations[]}
Agent Context Builder
Agents should not receive the entire canonical profile by default. A Context Builder creates purpose-specific views for Mila, Content, Deal, Commercial, and other agents. This reduces token cost, improves focus, and ensures every agent works from the same authoritative athlete truth.
6. Signal Engine / Normalization Engine — First-Class Module
The Signal Engine is the bridge between research facts and deterministic scoring. It converts raw evidence and connected-account observations into standardized quantitative signals. This is where Nomila becomes defensible: a fact does not directly become “points” because an LLM feels it is important; it is mapped through explicit rules or normalized against a comparable cohort.
Signal conversion hierarchy
Raw evidence / connected data      ↓Canonical feature extraction      ↓Cohort selection (sport, level, stage, platform, geography where appropriate)      ↓Percentile / lookup / transformation      ↓0–100 normalized signal + signal confidence      ↓Dimension calculation
Quantitative signals
Follower count, engagement, reach, growth, Story views, media volume, search interest and similar measures should normally be percentile-normalized within an appropriate cohort. The same raw number may score differently across sports and competition levels because market scarcity and norms differ.
Categorical signals
Competition level, awards, national-team selection, commercial proof types and similar categorical evidence use explicit, versioned lookup tables. Exact lookup values are alpha parameters until the 37-athlete deterministic calibration is completed.
AI-assisted classifications
For harder-to-quantify evidence such as narrative distinctiveness, brand coherence or crossover recognition, OpenAI may classify evidence into a bounded taxonomy (for example: very_low, low, moderate, high, very_high). Nomila deterministically maps that classification to numeric values. AI may classify evidence; AI does not assign the final dimension score.
7. Marketability V1 — Alpha Specification
Current candidate top-level weights are frozen for the deterministic calibration run. These are expert-designed V1 priors, not yet empirically optimized weights.
Dimension
Weight
Athletic Authority
15%
Audience Scale
15%
Engagement Quality
15%
Cultural Relevance
10%
Narrative Power
10%
Brand Fit
10%
Commercial Proof
15%
Momentum
10%
7.1 Athletic Authority — 15%
Sub-signal
Subweight
Competition level
25%
Performance/results
25%
Rankings/recognition
15%
National/international status
15%
Role/importance
10%
Achievement recency
10%
7.2 Audience Scale — 15%
Sub-signal
Subweight
Cross-platform effective reach
50%
Sport/level audience percentile
25%
Audience growth
15%
Platform breadth
10%
7.3 Engagement Quality — 15%
Sub-signal
Subweight
Engagement percentile
30%
Reach efficiency
25%
Shares/saves quality
15%
Video retention/completion
10%
Story efficiency
10%
Audience authenticity
10%
7.4 Cultural Relevance — 10%
Sub-signal
Subweight
Media-volume percentile
30%
Media-source quality
20%
Search interest
20%
Social conversation
15%
Crossover recognition
15%
7.5 Narrative Power — 10%
Sub-signal
Subweight
Distinctiveness
25%
Story depth
20%
Evidence/authenticity
20%
Media resonance
15%
Commercial applicability
10%
Durability
10%
7.6 Brand Fit — 10%
Sub-signal
Subweight
Category breadth
25%
Brand safety
20%
Audience attractiveness
20%
Identity/values coherence
15%
Content versatility
10%
Geographic relevance
10%
7.7 Commercial Proof — 15%
Sub-signal
Subweight
Verified commercial value
30%
Deal/partnership frequency
20%
Brand quality
15%
Renewals/repeat business
15%
Campaign performance
10%
Demonstrated pricing power
10%
7.8 Momentum — 10%
Sub-signal
Subweight
Athletic trajectory
30%
Audience growth
25%
Media trajectory
20%
Search/social trajectory
15%
Commercial acceleration
10%
8. Missing Data, Imputation & Confidence
Unknown data must not silently become zero, and it must not be treated as verified. V1 uses a hierarchy of priors for missing signals while lowering confidence. The exact prior tables and confidence penalties will be calibrated and versioned.
Verified athlete data  ↓ unavailableSport + level + stage cohort prior  ↓ unavailableSport + level prior  ↓ unavailableCompetitive-level prior  ↓ unavailableGlobal athlete prior
Connecting an account therefore does not earn bonus points. It replaces estimates with verified observations. A score or rate may increase or decrease, while Data Confidence should normally increase because uncertainty is reduced.
9. Composite Score & 0–850 Mapping
Each dimension is calculated on 0–100 and multiplied by its fixed top-level weight. The weighted composite is then mapped to the 0–850 Nomila scale using a versioned calibration function. The current alpha function being tested is: MIA = 850 × (Composite / 100)^0.8, rounded to the nearest integer. The exponent is a calibration parameter, not a permanent design decision.
Composite
Approx. alpha MIA
30
324
40
408
50
488
60
565
70
639
80
711
90
782
95
816
100
850
The calibration run will determine whether the mapping needs a different exponent, piecewise function, percentile mapping or other monotonic transformation. The mapping must be general and cohort-wide; it must not be changed to force an individual athlete to a target score.
10. Calibration Dataset: What the Existing 37 Scores Mean
The existing athlete scores are currently calibration targets/labels. They were produced through evidence-informed expert calibration and relative cohort comparison, not by executing the frozen deterministic algorithm above. They are therefore useful benchmark anchors, but they are not treated as immutable truth.
The deterministic implementation should be tested against them for ranking consistency, tier consistency and reasonable absolute error. If a general rule systematically improves fit across the cohort, the methodology may be updated. Athlete-specific exceptions are not allowed merely to hit a target.
Initial acceptance goals
Metric
Alpha goal
Median absolute score error
≤ 10 points
Mean absolute score error
≤ 15 points
Tier consistency
≥ 90%
Ranking correlation
Very high / target to be quantified
Top-10 / bottom-10 consistency
High
Explanation consistency
No contradictions with dimension inputs
37-athlete benchmark targets
Athlete
Sport
Target score
Cristiano Ronaldo
Soccer
850
LeBron James
Basketball
846
Shohei Ohtani
Baseball
838
Caitlin Clark
Basketball
827
Neymar Jr.
Soccer
824
Alex Morgan
Soccer
815
Marta
Soccer
804
JuJu Watkins
Basketball
794
Katie Ledecky
Swimming
789
Ben Shelton
Tennis
781
Michael Phelps
Swimming
779
Ilona Maher
Rugby
768
Bethany Hamilton
Surfing
741
Flau'jae Johnson
Basketball
729
Diana Taurasi
Basketball
706
DeWanna Bonner
Basketball
687
Waylon Fletcher
Baseball
681
Mia Bhuta
Soccer
674
Sammy Smith
Soccer / dual-sport
657
David Shields
Baseball
628
Muggsy Bogues
Basketball
628
Jimmer Fredette
Basketball
615
Jim Thorpe
Track / Football
602
Jordyn Listro
Soccer
586
Eddie 'The Eagle' Edwards
Ski Jumping
578
Carlin Isles
Rugby / Track
571
Nitro Tuggle
Football
563
Isla Silva
Wrestling
563
Zippy Fish
Australian Rules Football
548
Ukko-Pekka Luukkonen
Ice Hockey
542
D'Brickashaw Ferguson
Football
511
Picabo Street
Alpine Skiing
498
Hannah Yu
Soccer
472
Moh Bility
Football
471
Ellie Lebe
Soccer
438
Lilia Bhuta
Soccer
426
Riya Mehta
Gymnastics
390
11. Rate Engine
Rate is deliberately separate from Marketability. The same marketability score can produce very different pricing because deliverables, verified reach, engagement, name recognition, sport economics, rights, exclusivity, geography and demand differ.
Deliverable taxonomy
Social distribution: Instagram Post, Reel, Story, TikTok, YouTube integration, X/Threads.
Brand content: UGC video, product photography, brand photoshoot, short-form package, long-form video.
In-person: appearance, speaking, meet & greet, camp/clinic, autograph session.
Long-term: brand ambassador, season partnership, annual partnership.
Rights/add-ons: paid media, organic brand usage, whitelisting/Spark Ads, exclusivity, perpetual/extended usage, travel, production complexity.
base_rate = benchmark(deliverable, sport, athlete_level, audience_band)          × audience_factor          × engagement_factor          × recognition_factor          × marketability_factor          × sport_commerciality_factor          × demand_momentum_factor          × commercial_proof_factorfinal_rate = base_rate + usage + paid_media + whitelisting + exclusivity + production + travel
The existing 37-athlete rate ranges are calibration targets, not yet deterministic outputs. Rate Engine calibration must be done independently from Marketability so pricing problems do not distort the score.
12. Opportunity & Earnings Engines
Opportunity Engine estimates how often an athlete can realistically sell commercial inventory based on brand demand, fit, conversion probability, availability, capacity, seasonality and repeat likelihood. Earnings Engine combines rate scenarios with opportunity-volume scenarios.
Conservative 12m = Σ(low_rate × conservative_volume)Expected 12m     = Σ(expected_rate × expected_volume)Upside 12m       = Σ(high_rate × upside_volume)
Nomila should distinguish Current Market Potential from Optimized Nomila Potential. The latter estimates what the athlete could realistically capture with improved positioning, outreach, pricing, negotiation and deal cadence. Neither is a guarantee.
13. Connected Accounts: Score, Rate & Confidence Behavior
Connected social accounts improve measurement quality; they do not automatically increase value. Verified reach, impressions, Story views, shares, saves, retention, demographics, audience geography, authenticity and growth replace public estimates. Marketability Score and deliverable-specific rates can move up or down independently. Confidence should rise when reliable verified data replaces uncertainty.
Illustrative behavior
Public-only: Marketability 674, Confidence 67%, Reel $1.0K–$2.5KConnected data: strong reach/engagement → Marketability may rise modestly, Reel rate may rise materially, Confidence risesConnected data: weak verified reach → Marketability and/or Reel rate may fall, Confidence still rises
History and explanations
Never overwrite history. Store score/rate snapshots and an explanation graph identifying which signal changes drove each movement. Nomila should answer “Why did my score change?” and “What would move me to 700/750/800?” using the deterministic model, not invented LLM advice.
14. Learning System: How the Benchmark Evolves
Yes: the current 37 athlete targets are bootstrapping labels. Once Nomila has enough verified first-party data, the learning system should build its own empirical benchmark distributions and calibrate parameters from observed outcomes. The 37-athlete set remains a regression/legacy test set, but it should not permanently dictate the model.
Learning progression
V1: expert weights + public benchmarks + 37-athlete target cohort  ↓V2: connected-account calibration and true cohort percentiles  ↓V3: observed offers, negotiated prices and closed deals  ↓V4: repeat deals, campaign performance and conversion outcomes  ↓V5: predictive/empirical models with versioned validation
Observed outcome data to capture
Brand and category
Offer price
Nomila suggested price
Negotiated and closed price
Deliverables and platform
Usage rights and exclusivity
Campaign duration
Performance outcomes
Renewal/repeat outcome
Athlete and brand satisfaction
Lead/contact → response → meeting → offer → close funnel
Connected social performance at time of deal
Deal data should initially calibrate Rate and Opportunity models. Only validated, capped commercial-proof evidence should later influence Marketability, avoiding circular feedback where a high score raises a rate, the higher deal raises the score, and the loop self-inflates.
15. Calibration & Model-Governance Rules
No athlete-specific score hacks to match a target.
All model changes are versioned and benchmarked across the entire cohort.
LLMs may not silently change weights, lookup tables, priors or scoring formulas.
Every score change must be attributable to input changes or an explicit model-version change.
Research, normalized features, score results, rates and earnings results are persisted separately for reproducibility.
When the model changes, Nomila should be able to rerun historical profiles and quantify distribution shifts.
The benchmark evolves from expert labels toward empirical outcome-based calibration as data grows.
16. Calibration Run — Immediate Work Plan
The deterministic calibration is now the next required engineering/research task before marketability-v1.0 can be considered production-frozen.
Phase A — build standardized feature vectors
Reconstruct a canonical research profile for each of the 37 athletes using the evidence already gathered where available.
Map evidence into the exact sub-signals above.
Record whether each sub-signal is verified, public, inferred or imputed.
Attach confidence and provenance to every signal.
Phase B — deterministic marketability run
Calculate all sub-signals and eight dimensions.
Calculate weighted 0–100 composite.
Apply the alpha 0–850 mapping.
Compare deterministic output to target score and cohort rank.
Measure mean/median/max error, tier accuracy and rank correlation.
Phase C — calibrate globally
Identify systematic error by sport, level, legacy status, audience scale and missing-data pattern.
Change only general rules/parameters that improve cohort-wide behavior.
Rerun all 37 after every model change.
Freeze marketability-v1.0 when acceptance criteria are met.
Phase D — rate/opportunity/earnings
Encode deterministic rate formulas and modifier tables.
Run all 37 against calibrated rate-card targets.
Calibrate opportunity-volume logic independently.
Run 12-month earnings scenarios and compare with known/credible outcomes where available.
Use known contract/deal data as private ground truth when available, without leaking it into public research.
17. Engineering Interfaces — TypeScript Direction
export interface NormalizedSignal {  key: string;  value: number;          // 0-100  confidence: number;     // 0-1  source: 'verified'|'public'|'inferred'|'imputed';  evidenceIds: string[];  modelVersion: string;}export interface DimensionScore {  dimension: MarketabilityDimension;  score: number;          // 0-100  weight: number;  contribution: number;  signals: NormalizedSignal[];}export interface MarketabilityResult {  score: number;          // 0-850  potential: number;      // 0-100  confidence: number;     // 0-100  tier: MarketabilityTier;  dimensions: DimensionScore[];  drivers: Driver[];  version: string;}export interface RateEstimate {  deliverable: DeliverableType;  low: number;  expected: number;  high: number;  confidence: number;  assumptions: string[];  drivers: Driver[];  version: string;}export interface EarningsPotential {  conservative12m: number;  expected12m: number;  upside12m: number;  optimizedExpected12m?: number;  confidence: number;  opportunityVolume: OpportunityRange;  assumptions: string[];  version: string;}
18. Evolution Log — What We Tried and Why It Changed
Stage
What we did
What we learned / resulting decision
Initial scoring
Researched athletes and assigned evidence-informed marketability scores on a 0–850 FICO-like scale.
Useful calibration cohort, but not yet reproducible enough for engineering.
Dimension framework
Defined eight marketability dimensions and provisional weights.
Needed explicit sub-signals and deterministic transformations.
Rate design
Separated rates from marketability; calibrated deliverable ranges across the cohort.
Same score can yield very different prices; rate must be deliverable- and economics-specific.
Opportunity/Earnings
Added Opportunity Engine and 12-month scenarios.
Annual potential is not rate × posts; demand/capacity/conversion matter.
Research architecture
Separated OpenAI research from Nomila calculation.
Prevents opaque LLM scoring and enables reproducibility/provenance.
Cost architecture
Identity confirmation before full research; cache and targeted refresh.
Best way to control lifetime research cost without degrading quality.
Agent architecture
Canonical Athlete Intelligence Profile + Context Builder.
All agents share one truth while receiving only relevant context.
Connected accounts
Verified data may move score/rates up or down while confidence rises.
Connection is an accuracy event, not a bonus-point event.
Deterministic calibration
Existing 37 scores/rates treated as provisional target labels.
Now encode formulas, run cohort, measure error, calibrate globally, then freeze V1.
Future learning
Move from expert targets to verified social/deal/campaign outcomes.
Benchmark becomes empirical; original cohort remains regression suite, not permanent truth.
19. Locked V1 Principles
Marketability measures commercial marketability, not athletic greatness or follower count alone.
Sport/level normalization is required.
OpenAI researches and classifies evidence; Nomila calculates.
Every signal carries provenance, timestamp and confidence.
Marketability, Rate, Opportunity and Earnings remain separate engines.
Connected accounts improve accuracy and can move estimates either direction.
Confidence is a separate metric.
Rates are ranges and deliverable-specific.
Annual earnings are scenarios, not promises.
Actual commercial outcomes train/calibrate the system without circular self-inflation.
All formulas and changes are versioned and benchmarked.
Explanations are generated from deterministic drivers, not invented after the fact.
20. Next Milestone
Produce the 37-athlete deterministic comparison matrix: target score, calculated score, delta, eight dimension scores, confidence, tier match and rank position. Iterate only on global rules until the acceptance criteria are met. Then freeze Marketability v1.0 and repeat the same process for Rate v1.0, Opportunity v1.0 and Earnings v1.0.

21. Marketability V1.0-Beta.1 — Calibration & Holdout Update
Status: The eight-dimension Marketability architecture and top-level weights are now frozen as marketability-v1.0-beta.1 for the next validation phase. This is a candidate model, not a final production model.
21.1 What changed from alpha
Added explicit signal ownership and anti-double-counting rules. Each evidence item has one primary scoring dimension; secondary reuse is capped and must represent a genuinely distinct commercial effect.
Separated career status from current commercial activity. Retired athletes can remain commercially active; active athletes do not automatically receive high commercial relevance.
Added evidence timestamps and an asOfDate to athlete profiles and score snapshots.
Added signal-family-specific freshness and recency treatment so historical recognition cannot masquerade as current momentum.
Improved sparse-data handling: missing public or youth data shrinks toward cohort priors and reduces confidence rather than becoming zero.
Preserved sport, competition level and career-stage normalization so elite athletic performance does not automatically equal elite commercial marketability.
Kept the top-level weights unchanged during this iteration: Athletic Authority 15%, Audience Scale 15%, Engagement Quality 15%, Cultural Relevance 10%, Narrative Power 10%, Brand Fit 10%, Commercial Proof 15%, Momentum 10%.
21.2 Development cohort results
The 37-athlete development cohort was used to convert the earlier expert-calibrated labels into a reproducible deterministic framework. The key conclusion is not that every historical label must be reproduced exactly. The cohort is a bootstrap calibration set, and benchmark drift must be distinguished from model error when an athlete's real-world commercial profile has changed since the original score snapshot.
The deterministic beta retained very strong ordering across the development cohort.
Several previously difficult archetypes improved after signal ownership, recency and career-stage rules were introduced.
Mia Bhuta, David Shields, Waylon Fletcher and several youth/prospect profiles remained close to their original calibration anchors without athlete-specific score patches.
Flau'jae Johnson became the first formal benchmark-drift example: current commercial evidence can justify a materially higher present-day score than an older calibration label.
No athlete-specific final-score bonus or penalty is permitted in the beta model.
21.3 Unseen holdout cohort
A separate holdout cohort was assembled after beta.1 was frozen. The cohort intentionally spans global stars, professional athletes, college/NIL athletes, youth prospects and niche sports. Katie Ledecky is included only as an existing-cohort control; Mia Carona was withheld because public identity resolution was not sufficiently reliable.

> **RELOCATED 14 Sep 2026 — the holdout athletes and their prior-model scores are no longer printed here.**
> They live in `server/services/marketabilityHoldout.ts` behind the same never-send rule as the development-cohort
> targets. The reason is exposure, not secrecy: architecture documents get pasted wholesale into model contexts, and
> one careless paste would permanently burn the only independent evidence set we hold. A typed constants module does
> not travel that way. Note also what those numbers are — OUTPUTS of the earlier expert/alpha process, not expert
> targets and not results of the frozen evaluator. The holdout remains unspent.

Interpretation: the holdout behaved directionally as intended even without connected first-party social analytics. The model distinguished athletic greatness from commercial marketability, surfaced hidden marketability in niche sports, and produced a stable control result for Katie Ledecky. These are qualitative validation signals, not yet a final statistical validation against ground-truth commercial outcomes.
21.4 Beta.1 freeze rule
Do not continue tuning beta.1 against the 37-athlete development cohort or the new holdout athletes. Any future parameter change must be versioned and justified by new evidence, connected-account validation, observed commercial outcomes, or a separate training/validation protocol. Preserve beta.1 as a regression baseline.
22. Public Social Data vs. Connected Social Data
Nomila should explicitly model two social-data states: public/discovered data and connected/verified first-party data. Public discovery supports onboarding and initial estimates; connected data replaces estimates with verified observations and should normally increase confidence, while the score itself may move up or down.
22.1 Public/discovered social layer
Use public/discovered platform fields to establish account identity, audience scale, content cadence and observable content performance where legally and technically available.
Store raw platform observations with platform, account ID/handle, observation timestamp, source method, permissions/access class and provenance.
Do not treat a public follower count as equivalent to verified reach or impressions.
Compute public engagement proxies only when the underlying post/video metrics are available and sufficiently recent; label them as observed-public rather than verified-first-party.
Keep platform-specific metric definitions. Do not silently merge Instagram views, YouTube views and TikTok views as if they are identical measures.
22.2 Connected/verified social layer
When the athlete authorizes an account, connected analytics should supersede public estimates for the same signal and time window. The connected layer is expected to materially improve Audience Scale, Engagement Quality, Rate Engine accuracy, Opportunity modeling and confidence.
Reach and impressions by content type and time window.
Video/Reel views, watch-time or retention/completion metrics where exposed.
Story reach/views, replies, exits and link interactions where exposed.
Likes, comments, shares, saves/favorites and other high-intent engagement.
Follower growth and audience growth velocity.
Audience demographics and geography where available and permitted.
Content-level distributions, medians, percentiles and outlier/viral behavior rather than relying only on account averages.
Historical snapshots so Nomila can distinguish durable performance from a single viral post.
22.3 Social Signal Registry
Engineering should implement a canonical SocialSignal registry so platform APIs can change without contaminating the Marketability Engine. Platform adapters map provider-native fields into canonical signals; the scoring engine consumes canonical signals only.
SocialSignal {  athleteId  platform                 // instagram | youtube | tiktok | ...  accountId  metricKey                // followers | reach_30d | reel_median_views | shares_rate | ...  value  unit  windowStart  windowEnd  observedAt  sourceClass              // public_discovery | connected_verified | inferred | imputed  sourceMethod             // meta_business_discovery | youtube_data_api | oauth_insights | ...  confidence  provenanceId  definitionVersion}
22.4 Recommended social-derived features
Engine / Dimension
Canonical use
Audience Scale
Effective cross-platform reach; follower/subscriber cohort percentile; 30/90-day growth; platform breadth.
Engagement Quality
Median engagement rate; median views-to-followers; shares/saves rate; reach efficiency; retention/completion; Story efficiency; authenticity/quality indicators.
Momentum
Audience growth velocity; recent content-performance trend; frequency of breakout posts; acceleration/deceleration.
Cultural Relevance
Use social conversation/virality only when it reflects broader cultural attention. Do not double-count the athlete's own account performance already used in Audience/Engagement.
Rate Engine
Verified median/percentile distribution by deliverable type should become a direct pricing input. A Reel rate should react more strongly to verified Reel distribution than the overall MIA score does.
22.5 Public API research notes — September 2026
YouTube's public Data API exposes channel-level subscriber count, view count and public video count, plus video-level view and like statistics. TikTok's standard Display API is designed around an authorized creator's profile and recent videos; TikTok's richer Research API exposes public follower counts and video metrics such as views, likes, comments, shares and favorites, but access is restricted to qualifying research use cases and should not be assumed to be a commercial production-data source. Meta/Instagram fields should be implemented from the exact Business Discovery and connected Insights responses currently available to Nomila rather than from a generic field list.
Engineering implication: do not design the canonical schema around what one platform API happens to expose today. Build adapters and preserve source/method/version metadata.
23. Connected-Data Validation Plan
The next validation milestone is a paired public-only vs. connected-data experiment. This should be run before materially changing Marketability beta.1.
Select 5–10 athletes spanning audience sizes, sports and career stages.
Snapshot public-only canonical signals and calculate Marketability, confidence and initial Rate estimates.
Ingest the same athletes' connected Instagram/YouTube/TikTok analytics using the SocialSignal registry.
Recalculate without changing model parameters.
Measure score delta, dimension delta, confidence delta and deliverable-specific Rate delta.
Compare both states with known sponsorship offers, closed prices, renewals or other private commercial ground truth where available.
Classify every difference as improved measurement, benchmark drift, model miss, platform-definition mismatch or insufficient data.
Only after this evaluation should the Learning Engine propose a new model version.
23.1 Data request from the Nomila repository
Before changing the schema again, export the exact fields Nomila currently receives from Instagram Business Discovery and YouTube, plus the fields available after account connection. Include TikTok if implemented or under evaluation. Field names and example JSON are more useful than prose because they allow direct mapping into canonical signals.
Provider and endpoint/API name.
Exact raw field name and type.
Whether it is public/discovered or requires athlete authorization.
Account-level vs. content-level vs. audience-level.
Available historical window and pagination limits.
Update frequency / known lag.
Any fields Nomila derives internally from raw values.
A redacted example response for each endpoint.
Current storage model/table/interface in the Nomila repo, if one already exists.
24. Evolution Log Addendum — Beta.1
Evolution step
Decision / learning
Alpha deterministic calibration
Converted expert-calibrated labels into an explicit scoring framework; discovered that exact target reproduction is not the objective.
Curve-only correction rejected
Changing the 0–850 transformation alone did not solve archetype errors; the primary issues were upstream signal construction.
Archetype shortcuts rejected
Temporary archetype adjustments improved fit but were not accepted as architecture. Their useful behavior was translated into signal-level rules.
Signal ownership introduced
Prevents one social/cultural observation from receiving full credit across multiple dimensions.
Career status separated from commercial activity
Retired athletes can remain commercially active; historical fame and current demand are distinct signals.
Benchmark drift formalized
Every score and benchmark requires an as-of date; current evidence can invalidate an older calibration label.
Beta.1 frozen
Top-level weights remain 15/15/15/10/10/10/15/10 while connected-data validation proceeds.
Holdout test added
A new cross-sport cohort was scored after the beta freeze; Katie Ledecky served as a control and unresolved identity was correctly withheld.
Next empirical frontier
Connected social analytics and real commercial outcomes should now improve measurement and pricing before further model tuning.
25. Immediate Engineering Milestone
Freeze marketability-v1.0-beta.1; map the repository's real public and connected social fields into SocialSignal; run the paired public-only vs. connected validation cohort; then calibrate Rate Engine v1.0 using verified distribution and actual deal outcomes. Do not change Marketability simply because a pricing estimate is wrong.

26. V1 Social Data Strategy — Native APIs, No Paid Data Provider
Decision: Nomila V1 will not depend on Modash, HypeAuditor, Social Blade, Phyllo or another paid social-data provider. The preferred architecture is native platform APIs + athlete-connected first-party analytics + OpenAI/web research + Nomila's own longitudinal snapshots and commercial outcomes. Paid enrichment can be benchmarked later only if a specific, measurable coverage gap justifies its cost.
26.1 Provider hierarchy
Nomila's V1 collection ladder is intentionally simple: web research first for broad public intelligence; native public/platform APIs where available for structured platform-native evidence; and connected OAuth analytics as the highest-confidence source. These layers complement rather than replace one another.
1. Web research — broadest pre-connect coverage for identity, audience indicators, media, brand relationships, cultural relevance, momentum and other public evidence. Treat values as researched observations/estimates with appropriate confidence; do not require every public follower count to be platform-verified.
2. Native public/platform APIs — Meta Business Discovery and public YouTube/API data where available. These provide more structured, platform-native public evidence and should supersede weaker web estimates for the same observation when fresher and comparable.
3. Connected first-party OAuth data — gold-standard measurement for owner-only analytics such as reach, saves, shares, watch/retention metrics, demographics and deeper history. Connected observations replace estimates where appropriate; connection itself is never a score bonus.
4. Nomila historical snapshots — accumulate longitudinal evidence for growth, momentum and eventually sport/level/stage/platform benchmarks.
5. Cohort priors / imputation — only when a required signal remains unknown. Unknown is never zero; imputation lowers confidence.
5. Cohort priors / imputation — only when a required signal remains unknown. Unknown is never zero; imputation lowers confidence.
26.2 Immediate platform changes
YouTube public: expand beyond channel statistics to recent public video statistics and metadata; derive median views, p75 views, views/subscriber, posting frequency, breakout rate, Shorts vs. long-form performance and snapshot-based growth.
YouTube connected: expand the analytics-derived feature set around watch-time efficiency, average percentage viewed, subscriber conversion, traffic sources and other available engagement metrics.
Instagram public: request additional Business Discovery content metadata that Meta exposes and Nomila currently omits where permitted; increase useful history/pagination where supported.
Instagram connected: retain raw per-content reach/saves/shares/interactions but derive medians and distributions by content type rather than relying primarily on means.
TikTok: keep the athlete-connected API as the reliable V1 source. Investigate legitimate TikTok Business/Creator Marketplace API access for public creator benchmarking, but do not make V1 dependent on approval.
26.3 Distributional features, not averages
Social performance is heavy-tailed. A single viral post can distort an average, so Marketability and Rate Engine features should prefer robust distributions and content-type segmentation.
median reach/views by content type
p25 / p75 / p90 reach or views
median shares and saves per 1,000 reach/views
median comments and likes per 1,000 reach/views
coefficient of variation / performance consistency
breakout-post rate and top-decile contribution
30/90-day posting frequency and growth velocity
Reels/Shorts/video vs. static/carousel/long-form segmentation
26.4 Preserve complete audience distributions
Top audience country, city, age range and gender are useful display fields but are insufficient for scoring and brand matching. Preserve the full provider-returned distributions whenever available. Brand Fit and future campaign matching should operate on distributions (for example, US 46%, Canada 12%, UK 8%) rather than only the top bucket.
26.5 Unknown TikTok/public data handling
Missing public TikTok analytics must remain UNKNOWN, not zero. Use the appropriate cohort prior, mark the signal as imputed, and reduce Data Confidence. Connecting an account is an accuracy event rather than a score bonus: verified data may move Marketability or Rate estimates up or down while confidence should normally rise.
26.6 Nomila-owned benchmark moat
Every discovery and connected observation should create a timestamped snapshot. Over time this produces sport-, level-, stage- and platform-specific benchmarks that are more relevant to athlete commercialization than generic influencer benchmarks. The same dataset should eventually connect social performance to actual outreach, offers, negotiated prices, closed deals, renewals and campaign outcomes.
27. Single-Athlete Raw-Data Validation — Mia Pilot
A complete raw-data export for one athlete is useful even though it cannot calibrate cohort percentiles. Its purpose is schema and feature validation: prove that Nomila preserves the provider's raw information, maps it correctly into canonical SocialSignals, derives the intended metrics, and does not accidentally discard commercially useful fields.
Mia is particularly useful as a pilot if Nomila also has real-world commercial outcomes for her. Keep those outcomes separate from feature construction until the social-data mapping is complete, then use them as a case study for whether connected social data improves Rate Engine and earning-potential estimates.
27.1 Preferred export
Raw provider JSON exactly as received for Instagram, YouTube and TikTok; do not pre-summarize it.
Endpoint/API name, retrieval timestamp, account ID/handle and whether the response is discovery or connected.
All pages of recent content available to the integration, not only the top posts or computed averages.
Raw audience-demographic breakdown arrays, not only top_audience_* fields.
Raw account insights and content-level insights, including null/zero values.
The corresponding stored database snapshot/raw_metrics object.
Any TypeScript transformation that converts the raw response into SocialAnalyticsResult or scoring inputs.
If available, several historical snapshots for the same athlete so growth and consistency calculations can be checked.
27.2 What one athlete can and cannot validate
Can validate: API completeness, raw-field preservation, source provenance, canonical mapping, formulas, content-type segmentation, missing-data behavior, confidence changes, and the public-only → connected score/rate transition.
Cannot validate: sport-wide percentiles, cohort priors, population distributions, universal weights, or general predictive accuracy. Those require multiple athletes and eventually observed commercial outcomes.

28. Developer Implementation Specification — Social Intelligence V1
Purpose: convert the current social analytics MVP into a scalable pre-launch data foundation without changing Nomila's locked product strategy. This section is written as an implementation contract for engineering and Claude. Where it conflicts with earlier exploratory recommendations, this section governs V1.
28.1 Locked product strategy — do not redesign
Pre-connect: use web research broadly. It is acceptable for public follower counts and similar values to be estimates; provenance and confidence distinguish them from verified data.
Use Meta Business Discovery and native public APIs where available. Fix permission/configuration issues rather than replacing this layer with a paid provider.
Post-connect: use athlete-authorized first-party analytics as the highest-confidence source and replace weaker estimates when the metrics are comparable.
Connecting an account is an accuracy event, not a score bonus. Marketability and Rate estimates may rise or fall; confidence should normally rise.
No Modash, HypeAuditor, Social Blade or Phyllo dependency for V1.
Do not change Marketability beta.1 weights because of the Mia case study. Validate the data/feature pipeline first.
28.2 Required data-layer boundaries
Do not let provider response objects or UI analytics contracts become scoring inputs. Implement explicit boundaries so provider APIs can evolve without changing the Marketability Engine.
Provider/Web Evidence        ↓Ingestion + secret sanitization        ↓Raw/Semantically-complete source record        ↓Platform adapter / canonical observations        ↓Versioned derived social features        ↓Cohort normalization        ↓Marketability beta.1 / Rate Engine
28.3 Canonical storage model
Recommended logical entities (physical tables may be consolidated if engineering has a strong reason):
social_identities — athlete/platform account identity, platform account ID, handle, canonical URL, discoveredAt, lastVerifiedAt, source, confidence and status. Preserve prior handles/account IDs rather than overwriting history.
social_sync_runs — one record per provider sync with provider, endpoint family, API version, start/end timestamps, status, pagination state and error metadata.
raw_source_payloads — sanitized source payload or semantically complete representation sufficient to reprocess later. Never persist access tokens, refresh tokens, signed URLs, auth headers or secrets embedded in paging URLs.
social_content — one durable row per provider content item. Preserve platform-native fields instead of forcing TikTok/YouTube into an Instagram-shaped object.
social_metric_observations — account/content metric observations with metricKey, value, unit, observedAt, windowStart/windowEnd, provider and sourceClass.
social_audience_distributions — full country/city/age/gender distributions where available; top-audience fields are display conveniences only.
social_features — versioned derived features consumed by scoring/rates, with calculationVersion and lineage to input observations.
28.4 Canonical observation contract
SocialMetricObservation {  athleteId  platform  accountId  entityType              // account | content | audience  entityId  metricKey               // followers | reach | views | shares | saves | ...  value  unit  sourceClass             // connected_verified | platform_public | web_researched | imputed  provider  observedAt  windowStart?  windowEnd?  confidence  definitionVersion  syncRunId}
Web research belongs in the same evidence system but remains distinguishable through sourceClass and confidence. Do not create a separate scoring path for web estimates.
28.5 Platform adapter requirements
Instagram connected: preserve account insights, complete demographic distributions, per-content reach/saves/shares/total_interactions, media_product_type where available, carousel structure and type-specific insights. Add a second content-type-specific insights pass rather than limiting every media item to one universal metric list.
Instagram Stories: collect connected Story analytics where the approved API exposes them. Because Stories are ephemeral, use an appropriate capture cadence rather than assuming one daily snapshot is sufficient.
Instagram public: retain Business Discovery as the native public layer. Expand useful media metadata/history where permitted. Business Discovery permission failures are an operational/configuration issue, not an architecture change.
TikTok connected: preserve TikTok-native fields such as duration, title/video_description, view_count, like_count, comment_count and share_count. Do not normalize TikTok into an Instagram-shaped recent_media object before canonical storage.
TikTok demographics: do not depend on the currently disabled creator-info demographics path until the exact approved TikTok product, scopes and response contract are verified.
YouTube public: expand discovery beyond channel totals to recent public video statistics/metadata and paginate to a defined window/limit rather than an arbitrary ten-video cap.
YouTube connected: preserve channel/video metrics and Analytics outputs separately; add useful engagement/watch/subscriber conversion metrics supported by the approved API. Keep ad-revenue economics out of MIA unless a future product requirement explicitly calls for it.
28.6 Feature engineering rules
Social performance is heavy-tailed. Do not use a single mean as the primary representation of content performance. Calculate robust distributions by platform and content type.
median, p25, p75 and p90 reach/views
median interaction rate using the correct denominator
shares per 1,000 reach/views and saves per 1,000 reach where supported
reach/view-to-follower efficiency
breakout frequency and top-decile contribution
performance consistency / coefficient of variation
30/90-day posting frequency and follower/view/reach trajectory
Reels/Stories/static/carousel and Shorts/long-form segmentation
full demographic target-market features rather than only the largest bucket
Name metrics precisely. For example, Σ(total_interactions)/Σ(reach) is a reach-weighted interaction rate, not a generic 'average engagement rate.' Public follower-based engagement and connected reach-based engagement are different features and must not be silently compared as the same metric.
28.7 Inference vs. provider truth
Any Nomila heuristic must be labeled as derived/inferred. The current rule is_shared_to_feed=false AND reach>=2×followers is useful for identifying unusually broad non-feed distribution, but it is not provider proof that a post is an Instagram 'Trial/Discovery Reel.' Rename the derived feature accordingly and retain its derivation method/version.
28.8 Snapshot efficiency and history
Avoid copying complete recent-media payloads into every daily snapshot at scale. Store durable content metadata once and append time-stamped metric observations. Account-level time series should likewise be observations. This preserves history while reducing duplication and makes feature recomputation straightforward.
28.9 Source authority and replacement rules
For the same comparable metric and time window:connected_verified > platform_public > web_researched > imputedThis is an authority rule, not a collection-order rule. Web research remains the broad first-pass collection layer.A higher-authority observation should replace or supersede a lower-authority estimate for calculation while preservingthe earlier observation for history/audit.
28.10 Acceptance criteria
No scoring code imports provider-specific integration response types.
Every score-driving social feature has sourceClass, asOfDate/observedAt, confidence and calculation/definition version.
No credentials or secret-bearing paging URLs can be persisted.
TikTok and YouTube platform-native fields survive ingestion without being forced into Instagram semantics.
Full demographic distributions are retained when returned.
Historical features can be recomputed from stored observations without refetching the provider.
A provider/API definition change can be versioned without rewriting historical observations.
Unknown data is distinguishable from zero.
Connected data can lower a score/rate while raising confidence.
Feature calculations have unit tests using fixed provider-response fixtures.
29. Mia Connected Validation #1 — Findings and Interpretation
The 9 Sep 2026 Mia export is the first deep connected-data instrumentation case. It contains 71 connected Instagram snapshots, 72 connected TikTok snapshots, 6 connected YouTube snapshots and 569 media-asset records. Mia has no stored Business Discovery/public snapshot, so a literal historical public-before-connect vs. connected comparison is not possible.
29.1 What the export validated
Connected Instagram supplies materially richer commercial signals than follower count alone: per-content reach, saves, shares, total interactions and demographic distributions.
Connected TikTok supplies per-video views/likes/comments/shares, but the current transformation drops platform-native fields such as duration and collapses title/description.
Connected YouTube history is currently shallow for Mia because the OAuth connection expired; this is an account-state/history limitation, not evidence that YouTube is unimportant.
The current raw_metrics object is the closest retained representation to provider responses, but it is not a guaranteed verbatim wire log.
The current pipeline mixes provider-derived data and Nomila-derived aggregates in the same snapshot structure; the V1 implementation should make that boundary explicit.
29.2 Marketability interpretation — do not overfit
The connected evidence supports the qualitative Beta.1 behavior we wanted: Mia shows stronger distribution/engagement efficiency than follower counts alone imply, while recent social momentum is not uniformly positive. These forces can offset one another. The prior 674 calibration anchor should not be used as a target to tune toward.
A provisional connected-data estimate around the high-600s is directionally plausible, but do not promote a precise new production score from this single case. Exact deterministic rerunning still requires the complete persisted feature matrix, cohort percentile tables and versioned confidence calculation.
29.3 Why Mia remains useful
Keep Mia as Connected Validation Case #1. She is useful for validating raw-to-canonical mapping, feature calculations, source replacement, confidence movement, score explanations and Rate Engine sensitivity. She cannot validate universal weights, cohort percentiles or general predictive accuracy by herself.
30. Revised Validation Sequence
1. Implement the social data-layer changes in Section 28.
2. Add fixed test fixtures from Mia's export and verify canonical observations + derived features against expected calculations.
3. Re-run Mia through the completed deterministic Beta.1 feature pipeline without changing weights.
4. Record public/researched estimate, connected verified result, dimension deltas, confidence delta and Rate Engine deltas with explanation lineage.
5. Do not spend time scoring the small nine-athlete public export; it adds little validation value given overlap and incomplete public API collection.
6. As beta athletes connect accounts, collect a deliberately diverse connected validation set across sports, levels, audience sizes and commercial profiles.
7. Only after multiple connected cases and commercial outcomes should the Learning Engine propose Beta.2 changes.
31. Engineering Handoff — Definition of Done for This Milestone
Engineering/Claude should treat the following as the immediate milestone. Do not redesign Marketability weights while implementing it.
Schema/migrations for source payloads, identities, canonical observations, audience distributions and versioned features (or an equivalent normalized design that preserves these boundaries).
Adapters for current Instagram, TikTok and YouTube connected/public paths.
Secret sanitization before raw/source persistence.
Migration/backfill plan from existing social_analytics_snapshots and media_assets without losing provenance.
Versioned feature calculator with robust distribution metrics.
Unit/integration tests built from redacted Mia fixtures.
One reproducible command/job that produces Mia's canonical feature vector and Beta.1 input vector for a specified asOfDate.
An explanation artifact showing every score-driving social feature, its source, value, confidence, observation window and calculation lineage.
Documentation of API fields intentionally not collected, with reason, so omissions are explicit rather than accidental.
31.1 Explicit non-goals for this milestone
No paid social-data provider integration.
No Beta.1 weight optimization around Mia.
No claim of statistical validation from one connected athlete.
No requirement that web-researched public follower counts be independently verified before use as lower-confidence evidence.
No redesign of the overall collection strategy away from web research + native public APIs + connected OAuth.

