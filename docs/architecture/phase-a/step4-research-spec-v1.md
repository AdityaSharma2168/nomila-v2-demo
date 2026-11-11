# Step 4 — ResearchSpec v1 (provider-neutral athlete research brief)

Status: **FROZEN as `research-spec/1`** once this revision is merged (direction approved 12 Sep 2026 on PR #442; the three
adjustments requested at review — item-level coverage, provider-does-not-classify, S9 and minor privacy — are in this text).
Scope: what the research providers are asked to find, in what shape, with what outcome vocabulary. It is an
evidence-collection specification. It contains no scoring, no weights, no targets, and it is supplied
identically to every provider (Gemini Grounded, OpenAI web search); only the transport is compiled per provider.
The code mirror of this text is `server/services/intelligence/research/spec/researchSpecV1.ts`.

What the athlete experiences: nothing changes in the app. Underneath, research runs ask for the evidence the
Canonical Athlete Profile and the Beta.1 methodology actually need, and record for every requested category — and
for every important item inside it — whether it was found with a citation, not found, conflicting, or not
applicable, instead of a dossier that is "richer is better".

---

## 1. The existing research brief (as built, Step 2a/2b)

System instruction (`server/lib/research/providers/geminiGrounded.ts` `GROUNDED_SYSTEM`, also duplicated in
`server/skills/researchAthlete.ts`):

> You are a sports research analyst compiling a verified athlete dossier. Always use Google Search to find current,
> accurate information — do not answer from memory. Search multiple distinct facets: profile and background, social
> media accounts, local and national press, conference and league awards, statistics and records, brand partnerships,
> and media assets. Attribute every fact to a specific source. If a fact cannot be found, say so explicitly. Be
> thorough — a richer dossier is always better than a brief one.

Query plan (`server/services/intelligence/research/plans.ts`, `searchName` = `<full name> <school> <sport>`):

| Query | Text | Domains served |
|---|---|---|
| Profile + Social | `<name>: full name, hometown, state, class year, position, conference, team roster bio, personal background, current and past teams (school, club, professional, national team)` | identity, profile, affiliations |
| Commercial + Brand | `<name>: NIL deals, brand partnerships, sponsorships, endorsements, NIL valuation 2024-2026, On3 NIL valuation, Opendorse, Athlete's Thread, product collaborations, ambassador programs` | brand_mentions |
| Performance + Press | `<name>: career achievements, All-American, All-conference, player of the year, season statistics, records, awards, academic honors, press coverage, ESPN, Sports Illustrated, The Athletic, local newspaper coverage` | achievements, press |
| Social Handles | `<name> @username Instagram TikTok Twitter X handle site:instagram.com OR site:twitter.com OR site:tiktok.com OR site:x.com social media profile link` | social_handles |

Extraction (`kimiExtract.ts`, schema `cited-claims/2`): one Kimi call over all chunks; claims of kinds
`profile_attribute | affiliation | achievement | press_mention | brand_mention | social_handle | nil_mention |
identity_signal`, each with chunk ids + verbatim quote; 16 registry fact keys; `about_identity_confidence`;
`domain_outcomes` per asked domain with only two statuses: `found | none_found`. Narrative is a single `story_arc`
inference. Signals (Trends, GDELT) are a separate non-LLM lane.

Gaps against today's requirements (why v1 exists):

- "a richer dossier is always better" invites filling; there is no `not_applicable` and no `conflicting` outcome, and a
  single "found" says nothing about which of the requested items were found.
- No request for career status/trajectory, injuries, transfers or recency — Momentum and `careerStatus` have no evidence source.
- Press is bundled with performance; nothing asks for outlet type, dates, crossover/mainstream coverage or cultural moments.
- Narrative is synthesized by the extractor, not collected as cited storylines, values or advocacy.
- Commercial: no deal dates, categories, renewals, campaigns, representation (agent/agency) or own ventures; NIL valuations are not distinguished from actual deals.
- Social presence: handles only; no verified-status, no dated follower-count claims (evidence only), no authenticity concerns.
- Nothing asks for reputation / brand-safety evidence, so Brand Fit `brand_safety` has no evidence source.
- Identity disambiguation is implicit (a hint line), not an explicit section with its own outcome.

---

## 2. ResearchSpec v1

### 2.1 Principles

1. **Evidence, not scoring.** The spec never mentions scores, tiers, dimensions, weights, targets or the cohort. Providers receive the athlete's name, sport and identity anchor only.
2. **Four outcomes per section**: `found_cited` (at least one requested item with a cited claim), `not_found` (searched, nothing reliable), `conflicting` (credible sources disagree; report both), `not_applicable` (the category does not apply to this athlete, with the reason, e.g. a retired athlete's current-season statistics). Every section must end in exactly one of these.
3. **Item-level coverage beneath every section.** Each section lists its important requested items (§2.3). Every item gets the same four-way outcome. A section's `found_cited` never implies all its items were found: S7 with one sponsorship found and S7 with deals, dates, renewals, campaigns, representation and ventures all found are different results, and the comparison must see that. Coverage is captured twice: as reported by the extractor per item, and derived deterministically from the cited claims (§2.5); both are recorded.
4. **No filling.** Unknown stays unknown. Estimates, guesses and "likely" statements are not evidence. A third-party estimate (an NIL valuation) is reported as an estimate from a named source, never as a deal.
5. **One person.** If sources may describe different people with the same name, say so and keep the candidates apart; abstaining is the correct outcome when the anchor cannot be matched.
6. **Provenance on every claim**: source URL, publication date when visible, and the exact supporting text. Recency matters: dates are requested everywhere.
7. **Providers gather; Nomila classifies.** Gemini and OpenAI return observable, descriptive evidence only — source, URL, date, headline, outlet, deal, brand, category, reported facts. They must not assign Nomila source-quality tiers, brand-quality tiers, narrative-strength values, brand-safety scores, rankings of importance or any other downstream classification. Descriptive outlet context (national/regional, sport-specific vs mainstream) is welcome as description; the canonical source tier, taxonomy and quality classification are assigned downstream by the same Nomila policy (`classifySourceType`, the resolver, the lookups) for both arms, and a provider's description never becomes a tier without that normalization.
8. **Same semantics for every provider.** Compilation may only change how the instruction is delivered (system instruction vs `instructions`, "Google Search" vs "web search", tool declaration).
9. **Substrate-compatible.** Sections extend the existing research domains; the query plan reuses the four working queries where they still fit; evidence lands in the same `SearchEnvelope → cited extraction → lineage → resolver` path.
10. **Minors (corrected 13 Sep 2026).** Minor status triggers data minimization, not a different intelligence architecture: the SAME nine sections run, including S9 narrowly framed around documented, materially relevant public matters (official eligibility rulings, suspensions, governing-body findings, doping findings, disciplinary actions, documented legal outcomes, significant well-sourced public-conduct incidents). Publicly sourced identity, affiliations, sport/position/level, performance, national-team participation, trajectory, media, public narrative, commercial relationships and public social presence are collected as for any athlete. Not sought or retained: home/street address, personal phone or e-mail, an exact date of birth when a birth year or age band suffices, private family/contact or school records, rumors, unsourced allegations, speculative reputation material. The stored artifact is minimized by `minor-evidence-policy/2` (PII patterns and prohibited fields removed; uncited reputation claims dropped; everything else kept). Activation: the cohort flag, or reliable cited evidence that deterministically establishes under-18 at the as-of date (a cited birth year with asOfYear − birthYear ≤ 17); never from "high school", youth leagues or other context.

### 2.2 Sections (evidence categories)

| # | Section | Existing domain(s) | Seeks (each item dated and sourced) |
|---|---|---|---|
| S1 | Identity & disambiguation | identity | Full legal/known name, aliases and nicknames, birth year or date (adults; minors: only when publicly reported, never sought), nationality, hometown (minors: region/country only), sport and discipline, distinguishing markers (school, club, national team, era). Namesakes encountered and how they were told apart. Identity confidence for the match to the anchor. |
| S2 | Biography & affiliations | profile, affiliations | Current team/club/school/organization with league, level, division, conference and market (city/country); past affiliations with years; position/role (starter, captain); class year, degree, graduation; national team programme and age group. |
| S3 | Career status & recent trajectory | *(new; today implicit in profile)* | Status: active / injured or out this season / between teams / retired, with the date and the source. Last 12 months: transfers, signings, promotions, injuries, comebacks, retirements, milestones, major selections — each with a date. |
| S4 | Performance & honors | achievements | Results, titles, records, season statistics, rankings by named bodies, awards and all-conference/all-league selections, national-team caps and international results (Olympics, world championships), academic honors — each with season/year and the competition level as stated by the source (international, national, conference, regional, school, club). |
| S5 | Media coverage & cultural footprint | press | Coverage by outlet with date and headline, described as national/international, regional/local, sport-specific or mainstream/non-sport (description only; the tier is Nomila's); documented viral moments; appearances outside sport (television, entertainment, podcasts, books, documentaries, advertising as talent); documented social conversation (trending, memes) as reported by sources. |
| S6 | Narrative & public identity | narrative | Documented storylines (origin, adversity, comeback, firsts), stated values, causes and advocacy, foundations, public positions, recurring personal-brand themes — only as reported by named sources, quoting them. No synthesized biography; no strength or distinctiveness rating. |
| S7 | Commercial relationships | brand_mentions | Brand partnerships, endorsements, NIL deals and collaborations: brand, category, deal type, start and end or renewal, campaign names, reported value if published; representation (agency/agent); own businesses, product lines, equity deals; third-party valuations (On3 and similar) reported separately as estimates with the estimator named. No brand-quality rating. |
| S8 | Public & social presence | social_handles | Official accounts per platform (handle, verification if visible, official website); follower/subscriber counts **as dated claims with the source that stated them** (evidence for provider comparison only — never authoritative); notable content formats and series; documented audience authenticity concerns. |
| S9 | Reputation & brand safety | *(new)* | Documented incidents with the stage of each statement kept apart: **reported allegation or claim**, **official finding or action** (suspension, sanction, charge, ruling), **resolution or outcome** (cleared, upheld, settled, served) — each with its source and date. A sourced allegation is evidence that an allegation was reported; it is not a confirmed fact about the athlete's conduct and is never resolved into one. `not_found` after searching is an acceptable and expected outcome. No speculation, no allegations without a source, no safety score. **For a minor: narrowed to documented, materially relevant public matters (principle 10); no rumors or unsourced allegations.** |

Signals (search interest, news volume) stay on the non-LLM lane and are not part of the provider brief.

### 2.3 Requested items per section (item-level coverage)

Every item receives one of `found_cited | not_found | conflicting | not_applicable`. Item ids are the stable keys used
by the extractor, the artifacts and the comparison.

| Section | Item id | Requested item |
|---|---|---|
| S1 | `full_name` | full legal/known name |
| S1 | `aliases` | other names, nicknames |
| S1 | `birth_year` | birth year or date (adults); minors: only if publicly reported, never sought |
| S1 | `nationality` | nationality |
| S1 | `hometown` | hometown (minors: region/country only) |
| S1 | `sport_discipline` | sport and discipline/event |
| S1 | `namesakes` | other people with this name seen in sources and how they were told apart (`not_found` = none seen) |
| S2 | `current_affiliation` | current team/club/school/organization |
| S2 | `league_level_division` | league, level, division, conference of the current affiliation |
| S2 | `market` | city/country of the current affiliation |
| S2 | `past_affiliations` | past teams with years |
| S2 | `position_role` | position, role (starter, captain) |
| S2 | `education_class_year` | class year, degree, graduation year |
| S2 | `national_team_programme` | national team programme and age group |
| S3 | `current_status` | active / injured or out this season / between teams / retired, with date |
| S3 | `transfers_signings` | transfers, signings, promotions in the last 12 months |
| S3 | `injuries` | injuries, recoveries in the last 12 months |
| S3 | `milestones_selections` | milestones, major selections in the last 12 months |
| S3 | `retirement_comeback` | retirement or comeback announcements |
| S4 | `results_titles` | results, titles |
| S4 | `records` | records set |
| S4 | `season_statistics` | season statistics |
| S4 | `rankings` | rankings by named bodies |
| S4 | `awards_selections` | awards, all-conference/all-league/all-star selections |
| S4 | `international_results` | national-team caps and international results |
| S4 | `academic_honors` | academic honors |
| S5 | `national_coverage` | national/international coverage (outlet, headline, date) |
| S5 | `regional_coverage` | regional/local coverage |
| S5 | `sport_specific_coverage` | sport-specific outlets |
| S5 | `mainstream_coverage` | mainstream/non-sport outlets |
| S5 | `viral_moments` | documented viral moments |
| S5 | `appearances_outside_sport` | television, entertainment, podcasts, books, documentaries, advertising as talent |
| S5 | `social_conversation` | trending/meme/social conversation as reported by sources |
| S6 | `storylines` | reported storylines (origin, adversity, comeback, firsts) |
| S6 | `values_causes` | stated values, causes, advocacy |
| S6 | `foundations_positions` | foundations, public positions |
| S6 | `brand_themes` | recurring personal-brand themes as described by sources |
| S7 | `partnerships_deals` | brand partnerships, endorsements, NIL deals, collaborations |
| S7 | `deal_categories` | category of each brand/deal |
| S7 | `deal_dates` | start, end dates |
| S7 | `renewals_repeat` | renewals, repeat partnerships |
| S7 | `campaigns` | campaign names |
| S7 | `published_values` | published deal values |
| S7 | `representation` | agency, agent |
| S7 | `ventures` | own businesses, product lines, equity deals |
| S7 | `third_party_valuations` | valuations (On3 and similar) as estimates with the estimator named |
| S8 | `official_accounts` | official accounts per platform (handle) |
| S8 | `verification_status` | verified status where visible |
| S8 | `official_website` | official website |
| S8 | `follower_counts_as_stated` | follower/subscriber counts exactly as a source stated them, with source and date |
| S8 | `content_formats` | notable content formats, series |
| S8 | `authenticity_concerns` | documented audience-authenticity concerns |
| S9 | `reported_allegations` | reported allegations or claims (source, date) |
| S9 | `official_findings_actions` | official findings or actions: suspensions, sanctions, charges, rulings (source, date) |
| S9 | `resolutions_outcomes` | resolutions or outcomes: cleared, upheld, settled, served (source, date) |

Derived section status from items (deterministic, §2.5): `conflicting` if any item is conflicting; else `found_cited` if any
item is found_cited; else `not_applicable` if every item is not_applicable; else `not_found`. The extractor's reported
section status is stored alongside; disagreement between the two is itself a quality signal.

### 2.4 Query plan v1 (per athlete, per provider)

Six search calls replace the four. Existing query text is kept where it still expresses the section; wording is
added only for coverage gaps. `<anchor>` is the identity anchor line, identical for every provider.

| Query | Reuse | Sections |
|---|---|---|
| Q1 Identity + Biography + Affiliations | adapted from *Profile + Social* (adds birth year, nationality, league/level/market, national team, namesakes) | S1, S2 |
| Q2 Performance + Honors | adapted from *Performance + Press* (press removed; adds dates, levels, rankings bodies, national-team results) | S4 |
| Q3 Media Coverage + Cultural Footprint + Narrative | split out of *Performance + Press* (new: outlet dates, mainstream crossover, viral moments, storylines, values, advocacy) | S5, S6 |
| Q4 Commercial + Brand + Representation | adapted from *Commercial + Brand* (adds categories, dates, renewals, campaigns, agency, own ventures; valuations flagged as estimates) | S7 |
| Q5 Public + Social Presence | adapted from *Social Handles* (adds website, verification, dated follower claims, content formats, authenticity reports) | S8 |
| Q6 Recent Developments + Reputation | new | S3, S9 (for a minor, item 10 is the narrowed reputation framing) |

Extraction (Kimi, identical in both arms) is **partitioned by query** since 13 Sep 2026: one cited-claims/3 call per query over that query's envelopes and sections (Q1→S1/S2, Q2→S4, Q3→S5/S6, Q4→S7, Q5→S8, Q6→S3/S9), each under the 300 s benchmark limit, merged deterministically (claims concatenated in query order, one outcome per section, identity confidence from Q1 with every partition's value kept). Cross-query agreement and conflict remain a downstream evidence-layer concern.

### 2.5 Extraction contract (`cited-claims/3`)

- `section_outcomes` per asked section: `status` (four-way), `items: { <item id>: status }` for every requested item of
  that section, `reviewedChunkIds`, `conflicts: [{ item, values: [{ value, chunkIds }] }]` for conflicting items, and a
  one-line `reason` for `not_applicable`.
- Deterministic item coverage is also derived from the cited claims by a fixed item→claim predicate (kind, fact key,
  claim fields) in `server/services/intelligence/research/spec/researchSpecV1.ts`; both the reported and the derived
  coverage are stored.
- New evidence kinds (seven; closed registry vocabulary, `registries.ts` + the `research_evidence.kind` CHECK in 0046 — a
  versioned change, in-memory only for the benchmark): `career_event` (S3: `{ event, kind: transfer|signing|promotion|injury|comeback|retirement|milestone|selection, date }`),
  `reputation_event` (S9: `{ event, category, stage: reported_allegation|official_finding_or_action|resolution_or_outcome, outcome?, date }`),
  `social_metric_claim` (S8: `{ platform, metric: followers|subscribers|…, value, statedOn, statedBy }` — **never a fact, never a signal**),
  `representation` (S7: `{ agency, agent?, since? }`), `venture` (S7: `{ name, kind: business|product_line|equity, since? }`),
  `crossover_appearance` (S5: `{ title, medium, date }`), `narrative_claim` (S6: `{ topic: storyline|values_causes|foundation_position|brand_theme, text }` — replaces the synthesized `story_arc` inference for the benchmark).
- New registry fact keys for the Canonical Profile: `birth_year`, `representation`; `career_status` gains an `asOf` date. Existing 16 keys unchanged.
- Providers and the extractor describe; they do not classify. Descriptive outlet context is carried as `outletContext:
  national|regional|sport_specific|mainstream` on `press_mention` and is not a tier. `classifySourceType` assigns the
  canonical source tier from the cited domain downstream, identically for both arms; brand and narrative taxonomies are
  downstream lookups.
- A `reputation_event` with stage `reported_allegation` is evidence of a report only; the resolver never derives a conduct
  fact from it.
- **Arm states** (13 Sep 2026): `complete | extraction_failed | extraction_degenerate | search_failed`. A template echo, a malformed response, a response whose section keys match no exact alias, or zero claims on clearly substantive evidence is `extraction_degenerate` — an infrastructure state eligible for re-extraction from the saved envelopes, never a semantic abstention. Section keys normalize only through exact deterministic aliases of this spec (`S1`, `S1 <canonical name>`, `<canonical name>`); no fuzzy matching.
- **Canonicalization** (`claim-canonicalization/1`): a versioned, closed, deterministic layer between the parsed claim and the STRICT registry — unambiguous field aliases, closed enum alias tables, safe season/year representations, removal of known non-semantic extra keys. It never infers a missing value, invents a fact, resolves an ambiguity, strengthens a claim or loosens validation; raw value, canonical value and the rules applied are kept on every evidence record; whatever cannot be safely canonicalized stays refused by the registry.
- Everything else (chunk fencing as untrusted data, verbatim quote ≤ 300 chars, one athlete only, identity confidence) unchanged.

---

## 3. What was added or changed, and why

| Change | Why |
|---|---|
| "richer is better" removed; four-outcome vocabulary added | Stops filling; makes abstention a first-class, scoreable outcome (identity-fidelity evaluation). |
| Requested items per section with their own outcomes (review adjustment 1) | A section-level `found_cited` hid how much of the requested evidence was found; item coverage is what provider quality and later confidence/coverage calculations need. |
| Providers describe, Nomila classifies (review adjustment 2) | Keeps source tiers, brand quality, narrative strength and safety out of provider text so both arms are normalized by one policy; prevents a provider's own rating from leaking into scoring. |
| S9 stages: allegation / official finding or action / resolution (review adjustment 3) | A sourced allegation is a report, not a conduct fact; the stage keeps the two apart all the way to the resolver. |
| Minor privacy (review adjustment 3) | S9 omitted; birth year only if already public; no exact DOB, no private location, no home-life detail; plus the storage policy. |
| S1 as an explicit section with namesake reporting | Identity resolution is the primary risk for sparse athletes; today it is a hint line and a single confidence number. |
| S3 career status & 12-month trajectory | `careerStatus` is a canonical field with no research source; Momentum (`athletic_trajectory`, `commercial_acceleration`, `media_trajectory`) needs dated recent events. |
| S4 asks for dates and levels on every honor | `achievement_recency`, `competition_level`, `national_international_status` need the level and the date, not a list of names. |
| S5 press split from performance; outlet context, dates, crossover, viral moments | Cultural Relevance sub-signals (`media_volume_percentile`, `media_source_quality`, `crossover_recognition`, `social_conversation`) need volume, outlet type and mainstream reach, not "press coverage" as one bag. |
| S6 narrative collected as cited storylines/values instead of a synthesized `story_arc` | Narrative Power `evidence_authenticity`, `story_depth`, `distinctiveness`; Brand Fit `identity_values_coherence`; Brain's narrative layer must be said/found, not made. |
| S7 deal dates, categories, renewals, campaigns, representation, ventures; valuations as estimates | Commercial Proof `deal_frequency`, `brand_quality`, `renewals_repeat`, `pricing_power`; Brand Fit `category_breadth`; Brain's commercial-relationships object. Estimates must not masquerade as deals. |
| S8 dated follower claims, verification, formats, authenticity reports | Provider comparison on social metrics (decision 12 Sep 2026: evidence only); `platform_breadth`; `audience_authenticity` concerns as reported. Quantitative audience signals still require platform/connected observations. |
| S9 reputation & brand safety (not for minors) | Brand Fit `brand_safety` has no evidence source today; a documented `not_found` is itself informative. |
| Six queries instead of four | Each section gets a query whose intent is unambiguous; the four existing queries are reused, one is split, one is added. Cost ×1.5 per athlete. |
| `cited-claims/3` outcomes, items and kinds | The extractor must be able to record what the providers were asked to report; the same extractor runs in both arms. |

Kept as-is: the sports-research-analyst framing, "do not answer from memory", "attribute every fact to a specific source",
the chunk/quote citation contract, the resolver, source-type tiers and the identity-hints shape.

---

## 4. Mapping: sections → Canonical Athlete Profile / Brain → M.I.A. dimensions and sub-signals

Legend for the research column: **primary** (research is the intended evidence source), **partial** (research supplies
part; the value also needs platform, connected, proof or signal data), **none** (not a research input).

### 4.1 Canonical Profile and Brain needs

| Profile / Brain need | Contract field(s) | Section |
|---|---|---|
| Identity, aliases, nationality, hometown, sport | `identity.name/aliases/sport/hometown/nationality`, `identityConfidence` | S1 |
| Biography, position, class year, education | `profile.position/classYear/graduationYear/event` | S2 |
| Affiliations and level | `affiliations.current/all/level`, market | S2 |
| Career / current status | `identity.careerStatus` (+ proposed asOf) | S3 |
| Accomplishments | `achievements[]` | S4 |
| Media coverage | `press[]` (+ outlet context, date; tier downstream) | S5 |
| Narrative | `inferences.storyArc` → cited storylines/values (said/found) | S6 |
| Commercial relationships, representation | `brandMentions[]`, `nilMentions[]` (+ representation, ventures) | S7 |
| Social / public presence | `social.handles`, website, dated metric claims (evidence only) | S8 |
| Reputation | *(new; staged)* | S9 |
| Provenance | every claim: URL, domain, tier (downstream), date, quote, lineage | all |

### 4.2 M.I.A. dimensions and frozen Beta.1 sub-signals

| Dimension | Sub-signal | Research | Section(s) / items |
|---|---|---|---|
| Athletic Authority | competition_level | primary | S2 `league_level_division`, S4 |
| | performance_results | primary | S4 `results_titles`, `season_statistics`, `records` |
| | rankings_recognition | primary | S4 `rankings`, `awards_selections` |
| | national_international_status | primary | S2 `national_team_programme`, S4 `international_results` |
| | role_importance | partial (position/role; weight is a lookup) | S2 `position_role` |
| | achievement_recency | primary (dates) | S4, S3 |
| Audience Scale | cross_platform_effective_reach | none (platform/connected) | S8 claims are evidence only |
| | sport_level_audience_percentile | none | — |
| | audience_growth | none | — |
| | platform_breadth | partial (presence, not reach) | S8 `official_accounts` |
| Engagement Quality | engagement_percentile, reach_efficiency, shares_saves_quality, video_retention, story_efficiency | none (platform/connected) | — |
| | audience_authenticity | partial (documented concerns) | S8 `authenticity_concerns` |
| Cultural Relevance | media_volume_percentile | partial (counts need a cohort table) | S5 coverage items |
| | media_source_quality | primary (tier assigned downstream from cited domains) | S5 |
| | search_interest | none (signals lane) | — |
| | social_conversation | partial (documented moments) | S5 `social_conversation`, `viral_moments` |
| | crossover_recognition | primary | S5 `mainstream_coverage`, `appearances_outside_sport` |
| Narrative Power | distinctiveness | partial | S6 |
| | story_depth | primary | S6 `storylines` |
| | evidence_authenticity | partial (cited share) | S6, all |
| | media_resonance | partial | S5, S6 |
| | commercial_applicability | partial | S6, S7 |
| | durability | partial (dated span) | S4, S5, S6 |
| Brand Fit | category_breadth | primary | S7 `deal_categories` |
| | brand_safety | primary (staged S9 evidence; score downstream) | S9 |
| | audience_attractiveness | none (platform demographics) | — |
| | identity_values_coherence | partial | S6 `values_causes` |
| | content_versatility | none (platform) | S8 `content_formats` as context |
| | geographic_relevance | partial | S1 `hometown`, `nationality`; S2 `market` |
| Commercial Proof | verified_commercial_value | none (proof channel only) | — |
| | deal_frequency | partial | S7 `partnerships_deals`, `deal_dates` |
| | brand_quality | partial (taxonomy downstream) | S7 |
| | renewals_repeat | partial | S7 `renewals_repeat` |
| | campaign_performance | none (proof) | — |
| | pricing_power | partial (published values; valuations as estimates) | S7 `published_values`, `third_party_valuations` |
| Momentum | athletic_trajectory | primary | S3, S4 |
| | audience_growth | none (platform) | — |
| | media_trajectory | partial (dated coverage) | S5 |
| | search_social_trajectory | none (signals lane) | — |
| | commercial_acceleration | partial (dated deals) | S7 `deal_dates`, S3 |

### 4.3 Never exposed to a provider

Target M.I.A. scores, expected dimension scores, tiers, rankings, cohort group labels (high-data / sparse …), calibration
status, the gold sheet and negative anchors, other athletes in the cohort, anything about the holdout, and Nomila's
classification vocabularies (source tiers, brand taxonomy, safety scale).

---

## 5. Provider-neutral research instructions (verbatim, `research-spec/1`)

### 5.1 System instruction (all providers)

```
You are a sports research analyst collecting verified, sourced evidence about ONE athlete for an athlete profile.
Always use web search to find current information; never answer from memory. The athlete is identified by the
identity anchor in the request. If sources may describe a different person with the same name, keep them apart,
say so, and do not merge them; if you cannot confidently match the anchor, report that the identity could not be
resolved. Attribute every statement to a specific source with its URL and, when visible, its publication date.
Report only what sources state. Do not estimate, extrapolate, or fill gaps; a third-party estimate must be
labelled as an estimate from the named source. Describe, do not rate: do not assign quality tiers, scores,
rankings of importance, strength or safety judgements to sources, outlets, brands, stories or the athlete —
report the observable facts (who, what, where, when, which outlet, which brand, which category) and leave any
classification to the reader. For every evidence category and every listed item you are asked about, end with
exactly one status: FOUND (with cited evidence), NOT FOUND (you searched and found nothing reliable), CONFLICTING
(credible sources disagree — report each position with its source), or NOT APPLICABLE (the item does not apply to
this athlete — give the reason). Omitting a category or an item is not allowed; saying NOT FOUND is always
acceptable.
```

Per-provider compilation (the only permitted differences): Gemini receives this as `systemInstruction` with the
`googleSearch` tool; OpenAI receives it as `instructions` with the `web_search` tool. No other wording changes.

### 5.2 Request template (one per query; identical text for every provider)

```
Athlete identity anchor: <anchor>
Athlete: <full name> — <sport>
As-of date: <YYYY-MM-DD>
<minor line, only for a minor: "This athlete is a minor. Collect the same publicly sourced athletic, team,
performance, media, narrative, commercial and social information as for any athlete, with data minimization: do
not seek or report a home or street address, personal phone number, personal e-mail, private family or contact
details, or an exact date of birth (a birth year or age band from a reliable public source is sufficient); report
no rumors or unsourced allegations.">

<query text below>

For each numbered category, list dated, sourced findings for each listed item, then give the status of each
item and of the category (FOUND / NOT FOUND / CONFLICTING / NOT APPLICABLE).
```

Q1 — Identity + Biography + Affiliations *(for a minor, item 1 reads "birth year or age band (not an exact date of birth)" and "hometown (city or region, never a home or street address)")*
```
1. Identity — items: full name; other names or nicknames; birth year or date; nationality; hometown; sport and
   discipline; other people with this name that appear in sources and how they differ from the anchor.
2. Biography and affiliations — items: current team, club, school or organization; its league, level, division
   and conference; its city/country; past teams with years; position and role (starter, captain); class year,
   degree or graduation year; national team programme and age group.
```

Q2 — Performance + Honors
```
3. Performance and honors — items: results and titles; records; season statistics; rankings by named ranking
   bodies; awards and all-conference / all-league / all-star selections; national-team caps and international
   results (Olympics, world championships); academic honors. Give the season or year and the competition level
   as the source states it for each finding.
```

Q3 — Media Coverage + Cultural Footprint + Narrative
```
4. Media coverage — items: national/international outlets; regional/local outlets; sport-specific outlets;
   mainstream/non-sport outlets. For each finding give outlet, headline and date; describe the outlet type, do
   not rate it.
5. Cultural footprint — items: documented viral moments; appearances outside sport (television, entertainment,
   podcasts, books, documentaries, advertising as talent); social conversation (trending, memes) as reported by
   sources.
6. Narrative and public identity — items: storylines reported about the athlete (origin, adversity, comeback,
   firsts); stated values, causes, advocacy; foundations and public positions; recurring personal-brand themes
   as sources describe them. Quote the source; do not write a biography or judge the story's strength.
```

Q4 — Commercial + Brand + Representation
```
7. Commercial relationships — items: brand partnerships, endorsements, NIL deals, collaborations and ambassador
   roles (brand and deal type); the category of each brand; start and end dates; renewals or repeat
   partnerships; campaign names; published deal values; representation (agency, agent); own businesses, product
   lines or equity deals; third-party valuations (for example On3) reported separately as estimates naming the
   estimator — they are not deals. Do not rate brands.
```

Q5 — Public + Social Presence
```
8. Public and social presence — items: official accounts per platform (handle); whether each is verified, where
   visible; official website; follower or subscriber counts exactly as stated by a source, with the source and
   the date of the statement; notable content formats or series; documented concerns about audience
   authenticity.
```

Q6 — Recent Developments + Reputation *(for a minor, item 10 is replaced by the narrowed framing below)*
```
9. Career status and recent developments — items: current status (active, injured or out this season, between
   teams, retired) with date and source; transfers, signings or promotions in the last 12 months; injuries or
   recoveries in the last 12 months; milestones or major selections in the last 12 months; retirement or
   comeback announcements. Give a date for each event.
10. Reputation — items, kept strictly apart: reported allegations or claims; official findings or actions
    (suspensions, sanctions, charges, rulings); resolutions or outcomes (cleared, upheld, settled, served). For
    each give the source and date and say which of the three it is. A reported allegation is not a finding.
    NOT FOUND is an expected result; do not speculate, do not report allegations without a source, and do not
    give any safety or risk judgement.
```

Item 10 for a minor:
```
10. Reputation — for this minor athlete report only documented, materially relevant public matters: official
    eligibility rulings; suspensions; governing-body findings; doping findings; disciplinary actions; documented
    legal outcomes; significant, well-sourced public-conduct incidents. Keep strictly apart: reported allegations
    or claims; official findings or actions; resolutions or outcomes — each with source and date, saying which of
    the three it is. A reported allegation is not a finding. NOT FOUND is the expected result; report no rumors,
    no unsourced allegations, no speculative material, and no safety or risk judgement.
```

### 5.3 Extraction instruction (Kimi, identical in both arms; `cited-claims/3`, delta to today's `CITED_EXTRACTION_SYSTEM`)

- "Report for EACH named section in `section_outcomes` a `status` and, under `items`, a status for EVERY listed item id,
  each exactly one of `found_cited`, `not_found`, `conflicting`, `not_applicable`; for a conflicting item list each
  competing value with its chunk ids; for `not_applicable` give the reason."
- Claim kinds extended with `career_event`, `reputation_event` (with `stage`), `social_metric_claim`, `representation`,
  `venture`, `crossover_appearance`, `narrative_claim` (shapes in §2.5). A follower or subscriber count is always a `social_metric_claim`,
  never a fact. A `press_mention` may carry `outletContext` as the source described it; never a tier.
- "Do not classify: record no tiers, scores, ratings or strength judgements, even if the research text contains them —
  quote such statements as press claims at most."
- Unchanged: strict JSON, chunk ids + verbatim quote ≤ 300 chars per claim, omit uncitable claims, one athlete only,
  lower `about_identity_confidence` when sources may describe someone else, never merge people.

---

## 6. Projected calls and cost under v1 (20 athletes, both arms, one pass)

| Arm | Model | Search calls | Max retries | Extractions | ≈ USD / athlete | ≈ USD total | Worst case (all retries) |
|---|---|---|---|---|---|---|---|
| Gemini Grounded | gemini-3.5-flash (Vertex) | 120 | 240 | 20 | 0.45 | 9.0 | 26 |
| OpenAI web search | gpt-5.4-mini (Responses, `web_search`, medium context) | 120 | 240 | 20 | 0.21 | 4.2 | 9 |
| Kimi extraction (both arms) | kimi-k2-thinking (Vertex MaaS) | — | — | 40 | included | included | included |

Assumptions: list prices read 12 Sep 2026 (gemini-3.5-flash $1.50/$9.00 per M tokens; gpt-5.4-mini $0.75/$4.50; web
search $10 per 1k calls plus search-content tokens; Kimi $0.60/$2.50); Vertex grounding at the substrate's assumed
$0.035 per grounded call (Vertex list price not verified); ~3k output tokens per search, ~8k search-content tokens
per OpenAI call, ~30k input tokens per extraction (the v3 prompt is longer). Totals under $15 expected, under $40 worst
case. Writes: none to any database; artifacts to a gitignored calibration folder; production untouched.

---

## 7. Decisions taken at review (12 Sep 2026)

1. Nine sections and the six-query plan: approved.
2. `cited-claims/3` direction, the new evidence kinds and fact keys as a versioned registry change: approved for the benchmark in memory; substrate adoption is a later, separate PR with its migration.
3. S9 in scope with the three stages for adults and, narrowly framed, for minors (corrected 13 Sep 2026: minimization, not a reduced research model); follower claims as `social_metric_claim` evidence only: approved.
4. Item-level coverage beneath every section; providers describe and Nomila classifies; minor privacy limits: added at review and part of the frozen text.
5. The wording in §5 is frozen as `research-spec/1`; both providers receive it byte-for-byte apart from the compilation rules in §5.1.
6. 13 Sep 2026 recovery decisions: partitioned cited-claims/3 extraction (one call per query, 300 s limit, no further raises without a decision); `extraction_degenerate` as a fourth arm state, eligible for re-extraction; `claim-canonicalization/1` before the strict registry; the corrected minor policy (`minor-evidence-policy/2`, S9 kept and narrowed, minimization only, automatic activation solely from a cited birth year that deterministically establishes under-18).
