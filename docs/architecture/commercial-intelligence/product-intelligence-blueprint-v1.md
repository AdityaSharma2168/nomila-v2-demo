# Nomila Product & Intelligence Architecture Blueprint v1

> **Imported into the repository 14 Sep 2026**, for the same reason as the Commercial Intelligence document: a master
> architecture held outside the repo cannot be diffed, corrected, or checked against what was actually built.
>
> This document holds up well against implementation. Its locked decisions and ADRs were largely vindicated — ADR-011
> (Nomila's own predictions must not feed MIA) and §37's learning loop (observe → evaluate → propose → validate offline
> → promote a version) are exactly the architecture we arrived at independently. Corrections are recorded in
> [`SUPERSEDED.md`](./SUPERSEDED.md) rather than applied in place.

---


NOMILA
Product & Intelligence Architecture Blueprint
V1 — Canonical Business, Product, Agentic & Technical Architecture
PURPOSE
Master source of truth for what Nomila is building, how its intelligence and agents fit together, what can be packaged for enterprise/API use, and the order in which engineering should execute.
STATUS
Working architecture. Locked decisions are explicit; proposed areas remain open to validation; Deals and Studio retain dedicated follow-up audits/specifications.
DATE
10 September 2026
Core thesis
Nomila is the intelligence and agentic operating layer for the business of athletes.

Executive Summary
Nomila should be designed as one intelligence platform with multiple product surfaces, not as a collection of disconnected AI features. The athlete-facing product, agency/school/club enterprise products, and future APIs should all consume the same versioned intelligence services. Agents reason, orchestrate and execute; reusable proprietary logic lives in services.
UNDERSTAND → DIAGNOSE → IDENTIFY OPPORTUNITY → SET OBJECTIVES      → PLAN → EXECUTE → MEASURE → LEARN ↺
The platform's core decision spine is: Athlete Profile → Marketability / Social / Commercial Intelligence → Athlete State → Opportunity Map → Objective Engine → Strategy Orchestrator → Actions → Deals / Studio / Mila → Results → Learning.
What this document does
Defines Nomila's product thesis and buyer-specific packaging.
Defines the canonical intelligence, recommendation, agentic, execution and learning architecture.
Separates facts, inferences, decisions, recommendations, actions and outcomes.
Defines service boundaries so the same capabilities can power athletes, agencies, colleges, clubs and external APIs.
Maps verified current-state findings into KEEP / MODIFY / REPLACE / ADD decisions.
Creates an execution sequence so engineering can build without simultaneously redesigning every subsystem.
Establishes Architecture Decision Records (ADRs) so Claude and developers understand not only what was chosen, but why.
Documentation model
Document
Role
01 — This Blueprint
Master architecture and product source of truth.
02 — Commercial Intelligence Specification
Marketability, social intelligence, rates, earnings and calibration.
03 — Recommendation & Strategy Specification
Athlete State, Opportunity, Objectives, Strategy, Actions, Weekly Plan.
04 — Deals Engine Specification
Inbox/DM triage, valuation, recommendations, negotiation, actions and outcomes.
05 — Studio & Creative Intelligence Specification
Content strategy, media intelligence, trends, Creative Director, ShotSpec, routing, generation and evaluation.
06 — Enterprise / Portfolio Intelligence Specification
Organization/portfolio intelligence, sponsorship valuation, brand-to-athlete matching and enterprise workflows.
07 — Data Contracts & API Specification
Canonical schemas, service APIs, events, permissions, versioning and external interfaces.

Part I — Product Thesis
1. What Nomila Is
LOCKED
Nomila is the intelligence and agentic operating layer for the business of athletes.
Nomila should not be defined by any single surface such as a score, inbox assistant, media kit, content studio or brand marketplace. Those are applications of a common intelligence system that understands the athlete, determines what matters, recommends what to do next, executes permitted work and learns from outcomes.
Packaging
Customer promise
Athlete
An AI management team for my brand, business and opportunities.
Enterprise
An AI operating system for my athlete portfolio.
Platform / API
Embed Nomila athlete commercial intelligence into my own workflow or product.
2. Core Product Loop
UNDERSTAND   ↓DIAGNOSE   ↓IDENTIFY OPPORTUNITY   ↓SET OBJECTIVES   ↓PLAN   ↓EXECUTE   ↓MEASURE   ↓LEARN   ↺
Every major Nomila feature should map to this loop. Features that cannot identify their role in the loop should be treated as suspect because they risk becoming isolated UI or prompt logic.
3. Product & Engineering Principles
Know before asking — Infer what can reasonably be inferred. Ask the athlete to confirm, correct or add what Nomila cannot know.
Recommend before asking for goals — Nomila should proactively propose priorities from evidence; the athlete accepts, modifies or rejects them.
Facts ≠ inferences ≠ decisions — Keep observed evidence, interpretations and recommendations structurally distinct.
Connected data improves truth, not status — OAuth connection raises measurement confidence; score/rates may rise or fall.
Services know; agents reason and act — No reusable proprietary business logic should live only in a prompt.
Every recommendation is explainable — Recommendation → rationale → evidence → objective → expected impact.
Every action traces to an objective — Weekly plans are prioritized action queues, not free-form calendars.
Execution systems are downstream — Deals and Studio execute strategy; they do not independently define the athlete's long-term strategy.
Outcomes are first-class — Approvals, edits, rejections, replies, content performance, deal outcomes and renewals should become structured learning data.
Preserve working systems — Migrate incrementally; use compatibility adapters where needed rather than forcing a rewrite.
Model-agnostic by design — Creative and reasoning intent should be structured independently from any single model/provider.
Multi-tenant capable from the service layer — B2C, B2B and API packaging should consume the same canonical intelligence.
Part II — Customers & Product Packaging
4. Athlete Product
Core promise: every athlete gets an AI management team that understands the athlete and helps run the business around the athlete.
Mila as chief of staff and primary conversational interface.
Marketability + confidence + explanations.
Rate intelligence and commercial earning potential.
Proactive opportunities, objectives and strategy.
Weekly prioritized action plan.
Deals execution: triage, evaluate, draft, negotiate and track.
Studio execution: pitches, posts, ads and media assets.
Brand opportunities and proactive outreach.
Continuous learning from athlete behavior and outcomes.
5. Agency Product
Core promise: make each agent capable of intelligently managing a much larger roster while reducing manual research, inbox, pricing, pitch and negotiation work.
Deal Desk: noise filtering, opportunity detection, term extraction, valuation, recommended action and negotiation support.
Portfolio Intelligence: roster reach, marketability, demographics, momentum and commercial opportunity.
Brand Match: brand → athlete and athlete → brand ranking.
Rate Intelligence and negotiation support.
Athlete Intelligence research and briefing.
Pitch Builder and Studio.
Opportunity Intelligence and athlete development recommendations.
Portfolio-level action queues for agents.
6. School / College Product
Core promise: understand, develop and commercialize the distributed influence of the institution's athletes rather than relying only on school/program reach.
Portfolio Intelligence across teams and athletes.
Athlete Development: identify who needs audience, brand, content or commercial support.
Sponsorship Valuation: quantify institution + athlete creator network value.
Audience Intelligence and geographic/demographic reach.
Hidden Marketability discovery.
Athlete Mila access under appropriate privacy/permission boundaries.
Deal support, content support and education.
7. Club / League Product
Player Commercial Intelligence and roster commercial value.
Sponsor inventory and partnership valuation.
Global audience and cultural footprint.
Player acquisition commercial-impact analysis.
Portfolio Brand Match and category white-space analysis.
Deal Intelligence and Studio support.
8. Platform / API Product
The following should be designed as internal services first and made externally addressable only when product/market demand warrants it:
Identity API
Athlete Research API
Marketability API
Social Intelligence API
Rate API
Brand Match API
Opportunity API
Portfolio Intelligence API
Sponsorship Valuation API
Strategy API
8.1 Enterprise micro-products
Micro-product
Primary buyer
Job to be done
Deal Desk
Agency / Athlete / School
Filter noise, identify real opportunities, value them, recommend action and negotiate.
Portfolio Intelligence
Agency / School / Club
Understand the combined commercial assets and gaps of an athlete portfolio.
Sponsorship Valuation
School / Club / League
Quantify program + athlete creator network value for brand negotiations.
Brand Match
Agency / Brand / School
Rank the best athletes for a brand/campaign or the best brands for an athlete.
Athlete Intelligence
Agency / School / Club
Instant structured research and commercial profile.
Rate Intelligence
Agency / Athlete / School
Price deliverables, rights and partnerships with evidence and confidence.
Pitch Builder
Agency / Athlete / School
Athlete/portfolio × brand intelligence → pitch/deck/outreach.
Opportunity Intelligence
Agency / School
Find under-monetized athletes, categories, audiences and moments.
Athlete Strategy
Agency / School / Athlete
Recommend objectives and a 30/60/90-day action plan.
Studio
Agency / Athlete / School
Create brand pitches, content and ads from real athlete media + AI.
Part III — Canonical Nomila Architecture
9. System Architecture
LOCKED
This is the canonical system shape. Individual modules may evolve, but their responsibilities should remain separated.
                         ATHLETE PROFILE                               │        ┌──────────────────────┼──────────────────────┐        ↓                      ↓                      ↓ MARKETABILITY             SOCIAL               COMMERCIAL INTELLIGENCE           INTELLIGENCE           INTELLIGENCE        │                      │                      │        └──────────────────────┼──────────────────────┘                               ↓                         ATHLETE STATE                               ↓                        OPPORTUNITY MAP                               ↓                        OBJECTIVE ENGINE                               ↓                     STRATEGY ORCHESTRATOR                               ↓          ┌────────────────────┼────────────────────┐          ↓                    ↓                    ↓       CONTENT               BRAND               GROWTH      STRATEGIST           STRATEGIST          STRATEGIST          │                    │                    │          └────────────────────┼────────────────────┘                               ↓                          ACTION PLAN                               ↓             ┌─────────────────┼──────────────────┐             ↓                 ↓                  ↓        DEALS ENGINE         STUDIO              MILA             │                 │                  │             └─────────────────┼──────────────────┘                               ↓                           EXECUTION                               ↓                            RESULTS                               ↓                         LEARNING ENGINE                               ↺
9.1 Responsibility of each layer
Layer
Responsibility
Athlete Profile
Canonical facts, evidence, preferences, relationships and histories.
Marketability Intelligence
How commercially marketable the athlete is today and why.
Social Intelligence
Audience, content performance, demographics, distribution, cadence and momentum.
Commercial Intelligence
Deals, relationships, pricing power, commercial proof, categories and outcomes.
Athlete State
Derived interpretation of where the athlete is today.
Opportunity Map
Where meaningful upside, gaps or underutilized strengths exist.
Objective Engine
Which opportunities should become current priorities.
Strategy Orchestrator
Resolves competing domain recommendations into a coherent plan.
Strategists
Generate domain-specific strategies in service of approved objectives.
Action Plan
Concrete prioritized actions with owners, due dates and expected impact.
Deals Engine
Commercial execution across inbox/DM, outreach, evaluation and negotiation.
Studio
Creative execution for pitches, posts, ads and media.
Mila
Chief of staff: explains, coordinates, asks for approval and orchestrates services/agents.
Results / Learning
Measure outcomes, evaluate recommendations and improve future decisions.
Part IV — Identity, Research & Athlete Intelligence Foundation
10. Athlete Identity & Cheap Lookup
LOCKED
Always check Nomila's athlete index before paying for identity resolution or full research.
AUTH ↓NAME ↓SEARCH NOMILA ATHLETE INDEX ↓matches? ├─ YES → "Is this you?" / "Which one is you?" → claim profile └─ NO  → ask SPORT → cheap identity resolution → confirm → create ↓CHECK RESEARCH STATUS ├─ fresh research → continue ├─ stale research → targeted refresh └─ seed_only / no research → full research
Nomila may seed large athlete populations with inexpensive identity records (name, sport and basic disambiguation) without paying for deep research. Full research should generally occur when an athlete signs up/logs in for the first time, becomes commercially relevant, or is intentionally pre-enriched for an enterprise/customer use case.
10.1 Identity state
seed_onlyidentity_resolvedresearch_partialresearch_completeresearch_staleconnected
11. Research Intelligence
Research builds and refreshes evidence about athletic authority, audience/public presence, media, brand relationships, narrative, cultural relevance and commercial proof. It should not calculate MIA or rates itself.
Web research for broad public intelligence.
Native platform/public APIs where available.
Structured LLM extraction/classification tied to evidence.
Targeted domain refresh rather than full re-research when only volatile fields are stale.
Evidence provenance, source, timestamp and confidence on every material observation.
Research output lands in the canonical athlete profile; downstream services derive their own intelligence.
11.1 Domain-specific freshness
Research domain
Typical freshness behavior
Identity / historical bio
Long-lived; refresh on contradictory evidence or known transition.
Athletic affiliation / role
Medium; refresh around seasons, transfers, graduation or roster change.
Commercial relationships
Medium/short; new deals and renewals matter.
Public social
Short; follower counts and public activity move frequently.
Media / news / cultural relevance
Short; momentum can change quickly.
Connected social
Event/daily observation; do not treat as research text.
Trend intelligence
Very short; can decay in days/hours depending on platform.
12. Canonical Athlete Profile / Digital Twin
PROPOSED
Use 'Athlete Digital Twin' internally as the conceptual model; the physical implementation can remain normalized relational + feature stores.
ATHLETE├── Identity├── Athletic career├── Audience + Social├── Content + Media├── Narrative + Brand├── Commercial relationships + Deals├── Preferences + Constraints├── Objectives├── Schedule / key events├── Marketability + Rates├── Opportunities + Recommendations├── Actions└── Outcomes
Agents should not receive this entire representation by default. A Context Builder should produce purpose-specific, minimized views such as deal_negotiation, content_strategy, brand_pitch or onboarding.
13. Facts → Inferences → Decisions
LOCKED
Do not store LLM interpretation as if it were observed fact.
Layer
Example
Storage behavior
Fact
4 Instagram posts in prior 90 days.
Observed/researched with provenance.
Inference
Content consistency is low.
Versioned derived interpretation.
Opportunity
Strong distribution + low cadence suggests unrealized supply.
Versioned opportunity with rationale.
Objective
Increase high-quality posting consistency.
Recommended, then athlete accepted/modified/rejected.
Action
Create two short-form posts this week.
Assigned execution record.
Outcome
2 posts completed; median reach X; athlete approved both.
Measured feedback/outcome.
Part V — Intelligence Services
14. Marketability Intelligence
LOCKED
The legacy four capitals are not the canonical future architecture. Beta.1 uses eight dimensions and a 0–850 score.
Detailed methodology belongs in the Commercial Intelligence specification. The master contract is: deterministic/versioned calculation, cohort normalization, evidence lineage, confidence, history and explanations.
Athletic Authority
Audience Scale
Engagement Quality
Cultural Relevance
Narrative Power
Brand Fit
Commercial Proof
Momentum
During migration, existing downstream surfaces may receive a compatibility adapter. The adapter must not dictate the new canonical model.
15. Social Intelligence
LOCKED
Collection ladder: web research → native public/platform APIs → connected OAuth. Connected is the highest-authority measurement source, not a score bonus.
Canonical social observations independent of provider payload shapes.
Robust distributions (median, p25, p75, p90) rather than only averages.
Platform/content-type segmentation.
Audience demographics and geography.
Posting cadence and follower/reach/view trajectories.
Distribution efficiency and breakout behavior.
Source authority and confidence preserved.
16. Commercial Intelligence
Commercial Intelligence is broader than rates. It should understand:
deal history, status and value
brand relationships and category penetration
renewals / repeat business
pricing power and negotiation outcomes
campaign performance
commercial demand and inbound quality
rights / exclusivity / usage obligations
commercial trajectory and monetization efficiency
17. Rate Intelligence
LOCKED
Rate is not score × factor. MIA can be an input, but rate calculation is its own service.
RateEstimate = f(  deliverable,  platform / format,  actual distribution,  audience,  engagement,  demographics,  sport economics,  rights,  exclusivity,  brand fit,  demand,  commercial proof,  benchmarks,  MIA)
Outputs should include low / expected / high, confidence, assumptions and key drivers.
18. Brand Intelligence & Brand Match
Athlete → Which brands?Brand   → Which athletes?Campaign → Which portfolio subset?
Brand fit should become one shared service rather than being separately regenerated in kits, voice and pitch endpoints. Inputs should include athlete state, audience, narrative, commercial conflicts, brand positioning, target audience and campaign requirements.
19. Media Intelligence
Media Intelligence understands the athlete's camera roll, uploaded media, historical posts and generated assets so strategists and Studio can search by meaning rather than file name.
who/what is present
setting, activity, emotion and wardrobe
brand/product presence
quality and orientation
sport vs lifestyle vs personal context
whether/where previously posted
historical performance of similar assets
fit for an objective, brand or deliverable
20. Trend Intelligence
Trend Intelligence should be reusable across Content Strategy and Studio.
platform and format
creative pattern / hook
audio or meme structure where applicable
trend velocity and likely half-life
brand safety
athlete relevance
audience relevance
execution requirements
21. Portfolio Intelligence
Portfolio Intelligence aggregates athlete-level intelligence for agencies, schools, clubs and leagues. It must not simply sum follower counts and call the result reach.
marketability distribution
estimated / verified audience reach with overlap handling
audience demographics and geography
content supply and monthly distribution
hidden marketability / under-monetized athletes
commercial inventory and category penetration
portfolio momentum
brand/campaign fit across the roster
estimated realized vs unrealized commercial value
Part VI — Decision Intelligence
22. Athlete State
PROPOSED
Athlete State is the missing interpretation layer between intelligence services and recommendations.
AthleteState {  athletic  audience  brand  content  commercial  cultural  constraints  preferences  confidence  asOfDate}
Athlete State should summarize what matters now, not repeat raw profile fields. It is derived and versioned. Two athletes with similar follower counts can have radically different state and therefore different strategies.
23. Opportunity Engine
The engine identifies where action could create meaningful upside. Opportunity types:
Type
Meaning
FIX
A material weakness is currently blocking value.
GROW
An underdeveloped area has attractive improvement potential.
UNLOCK
The underlying asset already exists but is not being converted into value.
AMPLIFY
Something is working unusually well and deserves more investment.
MAINTAIN
An important strength should be protected rather than aggressively optimized.
Opportunity ranking should consider expected impact, fit, feasibility, timing, confidence, constraints and effort. Do not simply target the athlete's lowest MIA dimension.
24. Universal Goal Taxonomy
LOCKED
Use a small set of universal top-level pillars; personalize through micro-goals and targets.
Goal pillar
Universal intent
1. Grow My Audience
Increase the amount or quality of people reached/following.
2. Build My Brand
Strengthen identity, narrative, differentiation and recognition.
3. Create Better Content
Build a sustainable content engine that represents the athlete well.
4. Grow My Business
Convert marketability into durable commercial value.
5. Attract the Right Opportunities
Prioritize opportunities aligned with long-term identity/career, not just immediate money.
6. Advance My Athletic Career
Use brand/media positioning to support recruiting, transition, visibility and career moments.
7. Build Long-Term Impact
Create durable businesses, causes, media, community and post-playing relevance.
24.1 Standardized micro-goal library
Pillar
Micro-goal ID
Description
Grow My Audience
grow_platform_audience
Grow audience on a specific platform.
Grow My Audience
increase_nonfollower_reach
Increase distribution beyond owned followers.
Grow My Audience
expand_target_demographic
Grow a desired demographic segment.
Grow My Audience
expand_geography
Build presence in a strategic geography.
Grow My Audience
convert_attention_to_followers
Turn viral/media attention into durable audience.
Grow My Audience
cross_platform_growth
Build a stronger second/third platform.
Build My Brand
define_positioning
Clarify what the athlete stands for.
Build My Brand
strengthen_narrative
Develop a more differentiated story.
Build My Brand
expand_beyond_sport
Increase recognition for non-sport dimensions.
Build My Brand
build_visual_identity
Create consistent visual/creative expression.
Build My Brand
strengthen_cultural_identity
Develop authentic cultural/community positioning.
Build My Brand
prepare_transition
Prepare identity for college/pro/post-career transition.
Create Better Content
increase_consistency
Increase sustainable posting cadence.
Create Better Content
improve_short_form
Improve short-form video quality/performance.
Create Better Content
build_content_franchise
Create recurring recognizable formats.
Create Better Content
increase_lifestyle_content
Broaden content beyond sport.
Create Better Content
improve_storytelling
Increase narrative/emotional quality.
Create Better Content
increase_sponsorable_inventory
Create more sponsor-friendly content opportunities.
Grow My Business
first_brand_deal
Secure first meaningful partnership.
Grow My Business
increase_deal_volume
Increase qualified partnership volume.
Grow My Business
increase_deal_size
Improve average economics.
Grow My Business
improve_pricing_power
Increase evidence-backed rate/negotiation leverage.
Grow My Business
increase_renewals
Move toward repeat/annual partnerships.
Grow My Business
diversify_revenue
Expand beyond social posts into appearances, UGC, licensing, products, etc.
Grow My Business
increase_inbound_quality
Attract better inbound commercial opportunities.
Attract the Right Opportunities
enter_brand_category
Build credibility in a target category.
Attract the Right Opportunities
target_specific_brand
Develop relationship with specific brand(s).
Attract the Right Opportunities
increase_media_opportunities
Increase press, interview, broadcast or speaking opportunities.
Attract the Right Opportunities
build_business_network
Attract founders, investors or commercial partners.
Attract the Right Opportunities
increase_event_access
Gain access to relevant cultural/sport/business events.
Advance My Athletic Career
recruiting_visibility
Improve coach/scout/recruiting visibility.
Advance My Athletic Career
capitalize_on_breakout
Use a performance/milestone to accelerate visibility.
Advance My Athletic Career
support_pro_transition
Prepare brand for next athletic level.
Advance My Athletic Career
national_team_visibility
Improve positioning around national/international opportunities.
Advance My Athletic Career
maintain_relevance_during_gap
Stay relevant during injury/off-season/transition.
Build Long-Term Impact
launch_business
Build an athlete-owned company/product.
Build Long-Term Impact
build_media_ip
Create durable owned media/IP.
Build Long-Term Impact
social_impact
Build credible social/community impact.
Build Long-Term Impact
speaking_thought_leadership
Develop authority outside sport.
Build Long-Term Impact
post_sport_career
Build an intentional post-playing pathway.
25. Objective Engine
Goals are hypotheses until the athlete confirms them. The Objective Engine converts opportunity candidates into a small number of current priorities.
Research + Athlete State + MIA + Rates + Social + Commercial + Constraints                           ↓                     Goal Candidates                           ↓                    Nomila recommends                           ↓             athlete accepts / modifies / rejects                           ↓                  ACTIVE OBJECTIVES
Objectives should be versioned, measurable, time-bounded where practical and tied to evidence/rationale.
26. Strategy Orchestrator
Domain strategists may compete for scarce athlete time. The Strategy Orchestrator resolves conflicts using objective priority, expected impact, deadlines, season/schedule, workload, athlete preferences and commercial obligations.
27. Action Model & Weekly Plan
LOCKED
Weekly Plan is a prioritized/scheduled action queue, not a free-form LLM calendar.
Objective   ↓Recommendation   ↓Action   ↓Executor   ↓Outcome
Core Action fields should include:
actionId / athleteId
objectiveId / recommendationId
action type
owner (athlete, Mila, Deal Agent, Studio, strategist, etc.)
priority and dueAt
expected impact
status
execution context
result / outcome linkage
Part VII — Agentic System
28. Agent Architecture
LOCKED
No agent owns reusable proprietary business logic.
ATHLETE  ↕ MILA  ↕STRATEGY ORCHESTRATOR  ↕ACTIONS  ↕┌──────────────┬──────────────┬───────────────┐Deals Agent    Studio Agent   Strategists  ↕               ↕               ↕        NOMILA INTELLIGENCE SERVICES
Agents may reason over service outputs, synthesize choices, plan multi-step work, ask for approval and execute permitted actions. They should call versioned services for Marketability, Rates, Brand Match, Social Intelligence, Opportunity, Media Intelligence, etc.
29. Mila
Mila is the athlete's chief of staff and conversational operating interface, not another domain strategist. Mila should summarize what matters, explain recommendations, coordinate execution, obtain approvals and route work to services/agents.
Daily/weekly prioritization: 'Three things need your attention today.'
Explain why a recommendation exists and what evidence supports it.
Ask for athlete confirmation where strategy requires preference or consent.
Coordinate Deal Agent, Studio and strategists.
Surface changes after connected data or outcomes alter the athlete's state.
Maintain purpose-specific memory/context rather than stuffing all athlete data into prompts.
30. Strategists
Strategist
Primary question
Content Strategist
What should we create and why?
Brand Strategist
Which brands/categories/positioning should we pursue?
Growth Strategist
What actions most efficiently improve audience/brand/commercial outcomes?
Commercial Strategist
How should we increase commercial conversion/value while respecting objectives and constraints?
Creative Director
How should a specific creative asset be made?
30.1 Service access pattern
BAD:Agent prompt contains pricing / brand-fit / score rules.GOOD:Agent → RateService      → BrandMatchService      → SocialIntelligenceService      → ObjectiveService      → explains / plans / acts
Part VIII — Deals Engine
31. Product role
LOCKED
Deals is an execution system downstream of athlete intelligence and objectives. Preserve the mature workflow; extract reusable intelligence rather than rewriting the whole pipeline.
The Deals system addresses a validated operational pain point: athletes and agents spend significant time distinguishing noise from real opportunities, deciding what matters, replying, negotiating and tracking outcomes.
INBOX + DMs   ↓TRIAGE   ↓QUALIFY   ↓VALUE   ↓PRIORITIZE   ↓RECOMMEND ACTION   ↓DRAFT / NEGOTIATE   ↓ATHLETE OR AGENT APPROVAL   ↓EXECUTE   ↓OUTCOME
31.1 Future opportunity taxonomy
NOISE — irrelevant/non-commercial.
LOW-VALUE — real opportunity but unattractive economics/fit.
INCOMPLETE — potentially interesting but missing terms.
QUALIFIED — legitimate with reasonable fit/economics.
HIGH-PRIORITY — strong fit + economics + urgency.
STRATEGIC — may deserve attention despite lower immediate economics because it advances an objective.
31.2 Enterprise wedge: Nomila Deal Desk
For agencies, Deal Desk can be a stand-alone entry product: connect portfolio inboxes/DMs, filter noise, surface action-needed opportunities, value them, draft responses and support negotiation. This creates clear ROI through fewer missed opportunities, fewer manual hours, faster response and better economics.
31.3 Current-state findings to preserve
Existing classifier → scorer → summarizer → rank/voice → draft workflow.
Structured pending action / approval pattern before sending.
Rate-aware negotiation and floor handling.
Thread summaries and deal-stage extraction.
Existing feedback traces such as draft edits, pending action decisions, outbound replies and deal outcomes.
NEEDS AUDIT
Before changing Deals internals, produce a dedicated Deals Engine audit/spec and classify every component KEEP / EXTRACT / REFACTOR / REMOVE / ADD.
Part IX — Studio & Creative Intelligence
32. Product role
LOCKED
Studio is a creative execution system. Strategy decides what to make and why; Creative Director decides how; Studio executes.
OBJECTIVE   ↓CONTENT STRATEGIST   ↓CONTENT PLAN   ↓MEDIA INTELLIGENCE + TREND INTELLIGENCE   ↓CREATIVE DIRECTOR   ↓CREATIVE SPEC / SHOT SPEC   ↓MODEL ROUTER + GENERATION   ↓EVALUATION   ↓ATHLETE APPROVAL   ↓PUBLISH / USE   ↓PERFORMANCE OUTCOME
33. Content Strategy vs Creative Production
Layer
Question
Output
Content Strategist
What should we create and why?
Content recommendation tied to objective.
Creative Director
How should it be made?
CreativeSpec / ShotSpec / asset plan.
Studio
Create it.
Pitch, post, ad, image, video, copy, deck, etc.
34. Media Intelligence
The Content Strategist and Creative Director should search a canonical media service rather than independently inspecting raw camera-roll data on each task.
35. Model-agnostic creative architecture
LOCKED
Creative intent is the source of truth; model-specific prompts are compiled execution artifacts.
Creative Director      ↓CreativeSpec      ↓ShotSpec      ↓Capability Engine      ↓Model Router      ↓Execution Strategy      ↓Model-specific Compiler      ↓Generation      ↓Evaluator      ↓Learning
Athlete identity is represented by a model-independent Identity Profile plus optional model-specific adapters/LoRAs/reference packs. Do not make 'one LoRA per athlete' the canonical identity architecture.
NEEDS AUDIT
Studio is still evolving. Keep this master interface stable, then update a dedicated Studio specification after the current implementation reaches a useful audit point.
Part X — Results, Feedback & Learning
36. Outcome System
First build structured outcomes. Machine learning comes later.
recommendation shown / accepted / modified / rejected / ignored
action scheduled / started / completed / failed
draft edited before send
deal reply sent / brand replied / terms changed
offer / counter / final value / accepted / rejected / renewal
content approved / rejected / reopened
content published / reach / views / engagement / conversions where available
brand pitch sent / opened / forwarded / responded
payment / campaign completion / satisfaction
37. Learning Engine
OBSERVATIONS    ↓EVALUATION    ↓PARAMETER / POLICY PROPOSAL    ↓OFFLINE VALIDATION    ↓VERSION PROMOTION    ↓MONITOR    ↺
The first learning system should be evaluation and version management, not unconstrained online learning. This protects against circularity and lets Nomila improve Marketability, Rates, Brand Match, Opportunity ranking, content strategy and negotiation deliberately.
Part XI — Enterprise & Portfolio Architecture
38. Entity model
PROPOSED
Do not make athleteId the only root of intelligence. Enterprise requires organization, portfolio, brand and campaign entities.
AthleteOrganizationPortfolioBrandCampaignOpportunityDealContentAudienceObjectiveRecommendationActionOutcome
39. Relationship graph
Athlete ──belongs_to / affiliated_with── OrganizationAthlete ──represented_by─────────────── AgencyAthlete ──matches────────────────────── BrandAthlete ──participates_in────────────── CampaignBrand   ──targets────────────────────── AudienceOrganization ──owns/manages──────────── PortfolioPortfolio ──contains──────────────────── AthleteRecommendation ──targets──────────────── ObjectiveAction ──implements───────────────────── RecommendationOutcome ──evaluates───────────────────── Action
40. Portfolio commercial intelligence
The portfolio product should answer not only 'who are our best athletes?' but 'what commercial asset does our entire portfolio create, what is underutilized, and which brands/categories can we credibly sell?'
Combined and overlap-adjusted audience/reach.
Marketability distribution and emerging/rising talent.
Demographic and geographic audience concentration.
Commercial category coverage and conflicts.
Content supply and high-performing formats.
Under-monetized athlete clusters.
Sponsorship inventory and estimated value.
Brand-specific roster subsets and activation plans.
Part XII — Technical Platform Architecture
41. Modular Monolith with Explicit Service Boundaries
LOCKED
Do not create distributed microservices prematurely. Build a modular monolith with clean service contracts and API boundaries; extract deployment units only when scale/security/customer needs justify it.
/services  identity  research  athlete-profile  marketability  social-intelligence  commercial-intelligence  rates  brand-intelligence  opportunity  objectives  strategy  media-intelligence  trend-intelligence  portfolio  outcomes/agents  mila  orchestrator  brand-strategist  content-strategist  growth-strategist  commercial-strategist  creative-director  deal-agent/execution  deals  studio  messaging  publishing/api  internal  enterprise  partners
42. Service contract standard
Each service should document:
Purpose
Inputs
Outputs
Source of truth
Version
Callers
Dependencies
Events emitted / consumed
Confidence and provenance behavior
Failure behavior
Authorization / tenant boundary
43. Example internal APIs
IdentityService.resolveCandidate(...)ResearchService.researchAthlete(...)AthleteProfileService.getContext(...)MarketabilityService.compute(...)SocialIntelligenceService.getState(...)CommercialIntelligenceService.getState(...)RateService.getRateCard(...)BrandMatchService.rank(...)OpportunityService.getOpportunities(...)ObjectiveService.recommendObjectives(...)StrategyService.buildPlan(...)MediaIntelligenceService.search(...)TrendIntelligenceService.getRelevantTrends(...)PortfolioService.getPortfolioIntelligence(...)OutcomeService.record(...)
44. Event architecture
Use domain events to reduce cross-module hard coupling:
ATHLETE_CLAIMEDRESEARCH_COMPLETEDSOCIAL_CONNECTEDSOCIAL_SYNCEDMARKETABILITY_UPDATEDRATE_UPDATEDDEAL_RECEIVEDDEAL_UPDATEDOBJECTIVE_CREATEDOBJECTIVE_CHANGEDACTION_CREATEDACTION_COMPLETEDCONTENT_PUBLISHEDCAMPAIGN_COMPLETEDOUTCOME_RECORDED
45. Context architecture
ContextBuilder.build({  athleteId,  tenantId,  purpose: "deal_negotiation" | "content_strategy" | "brand_pitch" | ...})
Context Builders should select the minimum purpose-relevant athlete facts, state, objectives and constraints, rather than copying the entire profile into agent prompts.
46. Versioning, provenance & explanations
Every material intelligence output should carry:
version
asOfDate
input/evidence lineage
source authority
confidence
explanation / drivers
tenant/athlete ownership context
47. Security, Privacy & Permissions
Email and DM access should be least-privilege and purpose-scoped.
Social OAuth should remain read-only unless a publishing workflow is explicitly approved.
Camera-roll/media access should be explicit and revocable.
Athlete-level data should not automatically become visible to a school/agency merely because the athlete belongs to that portfolio.
Portfolio analytics should support aggregation and privacy boundaries.
Minors require additional consent, commercial and data-governance controls.
Secrets/tokens must be sanitized before persistence in source payloads.
All agent actions that create external side effects should be auditable and permission-aware.
Part XIII — Current State → Target State
48. Verified current-state findings
The following items are grounded in the two 10 Sep 2026 Claude audits supplied for this blueprint. They describe current implementation and should not be confused with target architecture.
System
Current
Decision
Target
Identity / signup
Existing code can claim seeded athlete rows by identity cues; no formal Identity Service.
MODIFY
Formalize index, candidate matching, claim flow and research states.
Research
Onboarding research exists and is freshness-skipped; re-research occurs periodically.
KEEP / MODIFY
Extract domain freshness and canonical evidence contracts.
MIA
Current production engine uses four capitals and legacy cold-start profiles.
REPLACE
Introduce Beta.1 eight-dimension engine with compatibility adapter.
Rates
Rate card is recomputed with score and reads legacy capitals/tier.
MODIFY
Decouple as independent Rate Service using broader commercial/social inputs.
Goals
Captured in several places but have almost no downstream decision use.
REPLACE
Infer/recommend through Opportunity → Objective; preserve athlete corrections/preferences.
Recommendation
No generalized recommendation engine; deal engine is the mature recommendation path.
ADD
Build Athlete State, Opportunity, Objective, Strategy and Action spine.
Deals
Mature classify/score/summarize/rank/draft/action workflow.
SALVAGE
Preserve orchestration; extract reusable intelligence into services.
Studio
Generation exists; content recommendations/weekly plan are incomplete.
BUILD / MODIFY
Put Content Strategy + Media/Trend Intelligence + Creative Director above execution.
Brand fit
Generated/stored through multiple independent paths.
CONSOLIDATE
One Brand Intelligence / Match service.
Athlete context
Several readers assemble their own context.
CONSOLIDATE
Purpose-specific Context Builder.
Feedback
Many useful signals are logged but no unified learner consumes them.
ADD
Outcome Service first; Learning Engine later.
Weekly plan
In-flight/partial; not a canonical server-side decision system.
REPLACE / ALIGN
Build from structured Actions and objective priority.
49. Compatibility strategy
Preserve stable external contracts where doing so reduces migration risk, but use adapters rather than allowing legacy contracts to define future intelligence. The most important example is Marketability: existing score/tier readers can be temporarily supported while the canonical internal dimension set changes.
Part XIV — Execution Roadmap
50. Build order
LOCKED
Sequence by dependency, not by product surface. Do not redesign MIA, Recommendations, Deals and Studio simultaneously.
Phase
Scope
Why now
Phase A — Intelligence foundation
Identity → Research → Canonical Athlete Profile → Social Intelligence → Beta.1 Marketability → Rates → Commercial Intelligence
Creates reliable facts and reusable intelligence services.
Phase B — Decision layer
Athlete State → Opportunity Engine → Goal taxonomy → Objective Engine → Strategy Orchestrator → Action model
Creates one coherent recommendation spine.
Phase C — Deals execution
Detailed Deals audit → KEEP/EXTRACT/REFACTOR → connect to new services/objectives/outcomes
Salvages mature workflow while removing embedded duplicate intelligence.
Phase D — Studio execution
Media Intelligence → Trend Intelligence → Content Strategist → Creative Director → ShotSpec → routing/generation/evaluation
Makes Studio a strategy-driven execution engine.
Phase E — Enterprise
Organization/Portfolio model → Portfolio Intelligence → Deal Desk packaging → Brand Match → Sponsorship Valuation
Turns the same intelligence into B2B products.
Phase F — Learning
Outcome instrumentation → evaluation datasets → parameter/policy proposals → controlled version promotion
Builds empirical moat without uncontrolled online learning.
51. Immediate engineering milestone
Before broad feature expansion, engineering should establish the shared contracts that later modules depend on:
Finalize Athlete Identity Service flow and research-state model.
Complete the social data-layer changes already specified in the Commercial Intelligence document.
Implement the canonical Beta.1 Marketability result and migration/compatibility adapter.
Decouple Rate Intelligence from the legacy four-capital contract.
Define canonical AthleteState, Opportunity, Objective, Recommendation, Action and Outcome contracts.
Create shared Context Builder patterns for agent/tool consumers.
Instrument outcome events before the new Recommendation Engine begins generating high volumes of recommendations.
Do not materially refactor the Deals Engine until the dedicated Deals audit/spec is complete.
Do not make the in-flight weekly-plan code the canonical plan engine unless it is reconciled with the new Action model.
52. Definition of Done for architecture phase
One source-of-truth master document (this blueprint) with locked decisions and open areas clearly marked.
Module specifications reference this blueprint and do not redefine core architecture.
Canonical TypeScript interfaces exist for AthleteState, Opportunity, Objective, Recommendation, Action and Outcome.
Services have clear ownership and no new proprietary calculation is introduced only inside an agent prompt.
Existing mature Deals behavior remains operational during migration.
New recommendation outputs are explainable and traceable to evidence/objectives.
B2C and enterprise callers can consume the same internal service outputs with tenant/permission controls.
Part XV — Architecture Decision Log
ID
Status
Decision
Reason
ADR-001
LOCKED
Marketability uses the new canonical 8-dimension architecture; legacy 4 capitals are not preserved as product truth.
Prevents UI/legacy coupling from dictating intelligence design.
ADR-002
LOCKED
Connected social is an accuracy/confidence event, not a scoring bonus.
Keeps score and rates evidence-based.
ADR-003
LOCKED
Goals are proactively recommended and then confirmed/modified by the athlete.
Makes onboarding intelligent and produces better preference signals.
ADR-004
LOCKED
Agents do not own reusable proprietary business logic.
Enables reuse across athlete, enterprise and API products.
ADR-005
LOCKED
Deals and Studio are downstream execution systems.
Prevents each execution surface from inventing its own strategy.
ADR-006
LOCKED
Nomila starts as a modular monolith with explicit service boundaries.
Avoids premature distributed-system complexity.
ADR-007
LOCKED
Check the Nomila athlete index before paid identity resolution or research; seed cheaply and research on demand.
Reduces onboarding cost and latency.
ADR-008
LOCKED
Weekly Plan is a prioritized action queue tied to objectives.
Makes plans explainable, schedulable and executable.
ADR-009
LOCKED
Facts, inferences, decisions/actions and outcomes are separate data concepts.
Supports debugging, trust and learning.
ADR-010
LOCKED
Rate Intelligence is independent from Marketability; MIA is only one input.
Avoids hidden coupling and circular pricing.
ADR-011
LOCKED
Verified commercial outcomes may inform Commercial Proof; Nomila's own predicted rate/value does not feed MIA.
Prevents circularity while rewarding real market proof.
ADR-012
LOCKED
Creative intent is model-agnostic; prompts are compiled execution artifacts.
Allows model routing and provider evolution.
ADR-013
PROPOSED
Athlete State is the canonical interpretation layer before Opportunity.
Separates raw intelligence from decision context.
ADR-014
PROPOSED
Enterprise intelligence uses Organization + Portfolio entities and relationship graph.
Allows agency/school/club packaging without duplicating athlete logic.
Appendix A — Canonical Domain Interfaces (Draft)
type SourceClass =  | "connected_verified"  | "platform_public"  | "web_researched"  | "imputed";interface AthleteState {  athleteId: string;  asOfDate: string;  athletic: unknown;  audience: unknown;  brand: unknown;  content: unknown;  commercial: unknown;  cultural: unknown;  constraints: unknown[];  preferences: unknown[];  confidence: number;  version: string;}type OpportunityType = "fix" | "grow" | "unlock" | "amplify" | "maintain";interface Opportunity {  opportunityId: string;  athleteId: string;  type: OpportunityType;  title: string;  rationale: string;  evidenceIds: string[];  expectedImpact: unknown;  feasibility: number;  urgency: number;  confidence: number;  version: string;  createdAt: string;}interface Objective {  objectiveId: string;  athleteId: string;  pillarId: string;  microGoalId: string;  title: string;  rationale: string;  sourceOpportunityIds: string[];  status: "recommended" | "accepted" | "modified" | "dismissed" | "completed";  target?: unknown;  horizon?: string;  createdAt: string;  updatedAt: string;}interface Recommendation {  recommendationId: string;  athleteId: string;  objectiveIds: string[];  actionProposal: string;  rationale: string;  evidenceIds: string[];  expectedImpact: unknown;  effort?: number;  urgency?: number;  confidence: number;  ownerAgent?: string;  version: string;  createdAt: string;}interface Action {  actionId: string;  athleteId: string;  objectiveId?: string;  recommendationId?: string;  type: string;  owner: "athlete" | "mila" | "deal_agent" | "studio" | "strategist";  priority: number;  dueAt?: string;  expectedImpact?: unknown;  status: "proposed" | "approved" | "scheduled" | "in_progress" | "completed" | "failed" | "dismissed";  executionContext?: unknown;  createdAt: string;}interface Outcome {  outcomeId: string;  athleteId: string;  actionId?: string;  recommendationId?: string;  type: string;  value?: unknown;  observedAt: string;  sourceIds?: string[];}
Appendix B — Source Audits Used for Current-State Mapping
Current-state mapping in this blueprint was informed by two Claude audits supplied on 10 Sep 2026: 'M.I.A. Score Engine Audit' and 'Nomila Recommendation System Map'. These audits are treated as factual implementation maps, not target architecture.
Important findings preserved here include: a single current score writer with many downstream readers; rate dependence on legacy score/tier/capital structures; goals collected but scarcely consumed; the Deals Engine as the only mature recommendation/action pipeline; weekly plans/posting schedules largely not built; brand-fit/context/rate logic duplicated across several paths; and useful feedback/outcome data already being logged without a unified learner.

