# Diverse-athlete Objective validation — the run and the audit

**Owner:** Mia
**Date:** 2026-09-25
**Design:** `docs/architecture/commercial-intelligence/objective-validation-cohort.md` (approved, Option A).
**Question answered here, and only this one:** *is the Objective boundary athlete-general, and stable enough to be the input of the first Brain + Context Intelligence experiment?* Not answered: whether any particular Objective is good, or how the six athletes rank.

**What ran, unchanged, for all six:** M.I.A. refresh through the normal workflow (`requestEvaluation`, `USER_REQUESTED_REFRESH`, force) → live `buildAthleteState` (`athlete-state/1.2.0`, validator on the path) → `opportunityRun` (`opportunity-eval-spec/1.0.0`, digest `6bcf91ab…`, no tools) → `objectiveRun --from` that artifact (`objective-eval-spec/1.0.1`, digest `5c9087b8…`). Nothing tuned between athletes. **Nothing materialised:** no proposal set persisted, no Objective row, no reconciliation. Model for both evaluators: `gemini-3.5-flash`, no truncation on any call.

**Headline.** The boundary held for all six. No college, NIL, U.S., team-sport or "active athlete" assumption reached any output. Post-career, dual-career, individual-sport, sparse and commercially saturated athletes were all expressible under `objective-proposal/1.0.0` without a new field, enum value or domain. Where evidence was missing the path produced absence with a reason, not strategy. Two patterns recur across every athlete regardless of data richness, which rules out data as their cause: **(1)** nine of the 24 proposals are changes to *Nomila's data*, not the athlete's world — "connect your accounts", "record your deals" — and the contract admits them as Objectives; **(2)** under AMPLIFY-derived proposals the evaluator writes an unevidenced deficiency into `currentState` so that a gap exists to close. Pattern 1 is the single C-class finding and needs a decision at the checkpoint (§5). Pattern 2 is evaluator quality (B), logged for a future spec bump, not acted on.

---

## 1. Provenance — exactly what fed State

Every cohort athlete's M.I.A. row dated from 16 Sep (dimensions only, no rationale). Under Option A all six were refreshed first; the refreshed row supersedes the 16 Sep row and carries per-finding rationale and cited evidence. Both rows are preserved under `docs/audits/artifacts/objective-validation-cohort/mia-pre-refresh/` and `mia-post-refresh/`.

| athlete | 16 Sep row (superseded) | refreshed row that fed State | refresh cost | `career_status` on the row |
|---|---|---|---|---|
| Cristiano Ronaldo | `346099af` | `a5f3e6f3` · 2026-09-25 17:46 | $0.213 | active |
| Katie Ledecky | `8be54928` | `24e03829` · 17:49 | $0.209 | active |
| Ilona Maher | `aa36ba50` | `73536fc5` · 17:44 | $0.212 | active |
| Flau'jae Johnson | `77246d1d` | `1666a371` · 17:51 | $0.204 | active |
| Chisom Okpara | `cf47b672` | `86287c8d` · 17:42 | $0.203 | active |
| Picabo Street | `3de8814a` | `14b5a206` · 17:48 | $0.217 | active — **stale, kept deliberately** (retired 2002) |

Evaluator artifacts: `…/opportunity/<name>.json` and `…/objective/<name>.json`, each `{ state, map, record }` with the rendered State block the evaluator saw, the raw response, and the parsed set.

| cost | M.I.A. ×6 | Opportunity ×6 | Objective ×6 | total | provider calls |
|---|---|---|---|---|---|
| | $1.258 | $0.141 | $0.137 | **$1.54** | 18 |

**Two upstream observations recorded, not fixed (A):**
- Okpara's refreshed row carries `evidence_as_of 2026-05-29` while its own cited evidence is observed up to `2026-08-05` (his transfer-portal entry). The ledger's as-of does not describe the evidence the evaluator actually used.
- Street's `career_status: active` is wrong (retired 2002) and was rendered as fact in `IDENTITY`. The same State carries M.I.A.'s rationale saying "retired since 2002". State therefore contained two contradictory statements about one fact, and the validator cannot see it (it checks structure, not prose). How the evaluators handled that is in §2.6.

**One limitation of the design's premise, stated plainly.** Okpara was chosen as the "0 research rows" case. The refreshed M.I.A. row brought nine cited sources of its own, so his State was thin in Nomila-owned evidence but not in M.I.A. evidence. What all six athletes genuinely share is the absence of *every* Nomila-owned source: no connected social, no content, no deals, no inbox, no assertions, no onboarding preferences, no representation, no dates, no constraints. Each State was M.I.A. findings + identity + material gaps and nothing else. So this cohort tests the "M.I.A.-only State" condition six times over, at six levels of M.I.A. richness. It does **not** exercise the intent seam (every proposal is `origin: nomila`, correctly) or the social/deals projections, which the frozen four covered.

## 2. Per athlete — inputs, what came out, the seven checks

Legend for the checks: **pass / partial / fail**, with the layer for every non-pass: **A** data or evidence · **B** evaluator quality · **C** contract or architecture · **D** presentation (recorded, never counted against the architecture). Entailment is judged claim by claim: does the cited State path establish what `currentState` asserts?

### 2.1 Cristiano Ronaldo — saturated icon, zero Nomila evidence

State MEDIUM. Findings: seven strengths, `engagement_quality` UNKNOWN (92 but imputed). `identity.competitionContext` not recorded (no affiliation row). Pipeline, inbound, closed deals all zero — Nomila's counts. One material gap (private engagement metrics).

Opportunity (5, MEDIUM): UNLOCK evidence (private metrics) · AMPLIFY content (YouTube programming) · FIX positioning (paid-disclosure compliance after the NFT suit) · GROW career (post-playing structure, urgency medium, resting on `identity.careerStatus`) · AMPLIFY owned_venture (equity over licensing). Notes decline audience growth ("no composition data"), athletic ("already at maximum"), commercial ("Nomila records zero deals inside our system; we defer"), relationships, impact.

Objective (5, MEDIUM, all HIGH confidence, horizon null on four, `multi_year` on career): `verify-private-metrics` (evidence) · `optimize-youtube-programming` (content) · `standardize-paid-disclosure` (positioning) · `structure-post-playing-business` (career) · `expand-equity-ventures` (owned_venture). Every opportunity carried; nothing consolidated.

| # | check | verdict | evidence |
|---|---|---|---|
| 1 | State without Mia's shape | **pass** | Absent sections rendered as absences ("not recorded", "the athlete has stated nothing"); nothing forced. No U.S./NIL/college token anywhere in State or outputs. The missing competition context is an absence of data (A), not a projection fault. |
| 2 | Territory appropriate | **pass** | The trap was avoided explicitly: no audience growth for a man with 98.9 audience scale, no "first deal"; the commercial note reads the zero as Nomila's record. Territory is career, owned_venture, content, positioning — what a saturated icon's next moves plausibly are. |
| 3 | Outcomes worth governing | **partial** | Three are (post-playing structure, equity ventures, YouTube as a programmed network). `standardize-paid-disclosure` is an operating practice — a Recommendation with a policy shape — and `verify-private-metrics` is Nomila's data need (§3.1). |
| 4 | Uncertainty, not invention | **partial** | Age 41, $235M of $300M on-field, the NFT class action, the "UR · Cristiano" channel: all in the cited findings. "Lacks a diversified programming matrix beyond its initial launch content" is not in State — a manufactured deficiency (§3.2, B). |
| 5 | Contract holds his goals | **pass** | Hypothetical, not run: *"his commercial decisions run through his agency; Nomila proposes nothing his agency governs."* `representation` (agent/agency) and `constraints` exist in State to carry the fact; an Objective bounded by it needs no new field. The legacy-entity outcome the run produced is already a post-playing Objective under `career`. |
| 6 | Structurally Mia-specific | see §4 | — |
| 7 | Attribution | A absence of affiliation/social; B one manufactured gap; D third person throughout | — |

**Conclusion:** the boundary held; the path did not treat a saturated icon as a growth case, and expressed his kind of outcomes without a new field.

### 2.2 Katie Ledecky — individual, Olympic, mature

State MEDIUM. `athletic_authority` 97 strength; `audience_scale` neutral 74.8; `momentum` neutral 73; `engagement_quality` UNKNOWN. No competition context recorded. Two gaps (private metrics; sponsor ROI).

Opportunity (4, MEDIUM): UNLOCK evidence ×2 (private metrics; active contracts) · MAINTAIN positioning (legacy narrative after her first international defeats) · AMPLIFY impact (POTS and chronic-health advocacy). Notes decline audience growth (unmeasured), content, athletic ("managed natively by governing bodies"), commercial ("capacity for new sponsorships cannot be verified until existing agreements are logged"), relationships, owned_venture ("has not stated entrepreneurial ambitions"), career ("remains an active elite athlete focused on LA 2028").

Objective (4, MEDIUM, all HIGH): `private-metrics-integration` (evidence) · `commercial-contract-integration` (evidence) · `legacy-narrative-resilience` (positioning, multi_year) · `health-advocacy-expansion` (impact, multi_year; success: "an active advisory, ambassadorial or speaking role with a national health organisation").

| # | check | verdict | evidence |
|---|---|---|---|
| 1 | State without Mia's shape | **pass** | No season or team assumption; the quadrennial (LA 2028) entered through the findings and was respected. Competition context "not recorded" — the affiliation projection had nothing (A). |
| 2 | Territory appropriate | **pass** | Exactly the MAINTAIN / impact territory the design predicted for a mature Olympian; audience growth gated on measurement rather than assumed. |
| 3 | Outcomes worth governing | **partial** | Two are (a positioning she would govern; an advocacy role). Two are Nomila's data needs (§3.1). |
| 4 | Uncertainty, not invention | **pass** | The best entailment of the six: every `currentState` claim names its path and is established by it (the 800m/400m defeats, the memoir, public sponsorship reports, the empty relationship list read as Nomila's). |
| 5 | Contract holds her goals | **pass** | Hypothetical: *"selected for LA 2028"* → `athletic`, `multi_year`, observable; no quantified needed. Expressible. |
| 7 | Attribution | A absence; D third person | — |

**Conclusion:** the boundary held; the individual, quadrennial shape produced no forced team or season assumption.

### 2.3 Ilona Maher — niche sport, outsized audience, crossover

State MEDIUM. Seven strengths (`audience_scale` 92, `cultural_relevance` 93), `engagement_quality` UNKNOWN. Two gaps.

Opportunity (6, MEDIUM — the richest map): UNLOCK evidence (private engagement) · GROW evidence (contract registry) · MAINTAIN athletic (re-entry to the US Sevens programme, urgency high) · AMPLIFY career (the Hello Sunshine docuseries around the comeback) · AMPLIFY owned_venture (Medalist Skin) · AMPLIFY content (House of Maher sponsorship). Notes: audience "already outstanding and self-generating — feed it, do not build it from weakness"; positioning "no fix needed; it powers the others"; commercial deliberately deferred behind the registry.

Objective (5, MEDIUM, all HIGH): the two evidence opportunities consolidated into one `operational-and-commercial-evidence-baseline` (provenance cites both) · `athletic-reentry-security` (this_season) · `hello-sunshine-comeback-narrative` (career, next_12_months) · `medalist-skin-audience-monetization` (owned_venture) · `house-of-maher-sponsorship-expansion` (content, next_12_months).

| # | check | verdict | evidence |
|---|---|---|---|
| 1 | State without Mia's shape | **pass** | The crossover read as a strength, not a mismatch. Competition context "not recorded" (A) — "US Rugby Sevens" could have been held there. |
| 2 | Territory appropriate | **pass** | The strongest map of the six: five distinct domains, the cultural asset used to power ventures rather than "grow the audience". `cultural_relevance` carried through State into the docuseries Objective. |
| 3 | Outcomes worth governing | **partial** | Four are. `athletic-reentry-security` is her outcome though not one Nomila acts toward — a legitimate Objective for which the Brain's answer is NO ACTION. The evidence composite is Nomila's need (§3.1). |
| 4 | Uncertainty, not invention | **fail** | Three manufactured deficiencies, none in State: "competitive return not yet integrated as the primary storyline"; "channels do not systematically leverage or monetize her 9.2M"; "relies on a single presenting partnership with Samsung". The facts around them (sabbatical, 2026–27 return, Hello Sunshine, Samsung, Bristol Bears) are all cited. B (§3.2). |
| 5 | Contract holds her goals | **pass** | Hypothetical: *"House of Maher signs three distinct sponsors"* → content, observable, no State metric so no `quantified` — the optional mechanism behaves as designed. |
| 7 | Attribution | A absence; B three manufactured gaps; D third person | — |

**Conclusion:** the boundary held, and the contract carried five domains for one athlete; the failures are evaluator-written gaps, not shape.

### 2.4 Flau'jae Johnson — dual career, now professional

State MEDIUM. Seven strengths (`narrative_power` 97.6), `engagement_quality` UNKNOWN. Three gaps. The design called her "college"; the refreshed M.I.A. row has her as an 8th-overall WNBA pick with the Seattle Storm, Roc Nation artist, Unrivaled equity holder. State carried that through the findings; identity still says only "basketball", no competition context.

Opportunity (4, MEDIUM): FIX commercial — *"reconcile her partnerships within Nomila's database to correct her zero-deal baseline representation"* · UNLOCK evidence (private metrics) · AMPLIFY positioning (the athlete-and-artist crossover) · AMPLIFY owned_venture (Unrivaled). Notes decline athletic (pinnacle), impact, career ("first rookie season; no post-playing ambitions recorded"), relationships (already aligned with top agencies).

Objective (4, MEDIUM, all HIGH): `verify-commercial-records` (commercial, this_season, **quantified** `commercialPosition.closedDeals` baseline 0 → at least 1) · `authenticate-private-performance-metrics` (evidence) · `integrated-crossover-brand-positioning` (positioning, multi_year) · `unrivaled-league-ownership-visibility` (owned_venture, next_12_months).

| # | check | verdict | evidence |
|---|---|---|---|
| 1 | State without Mia's shape | **pass** | The stale "college" premise was the design's, not the path's; State represented the professional she now is through the findings. Competition context absent (A). |
| 2 | Territory appropriate | **pass** | The FIX on Nomila's own wrong zero is the cleanest proof in the cohort that the pipeline section is read as Nomila's counts, not her situation. Owned venture and crossover positioning are her real territory. |
| 3 | Outcomes worth governing | **partial** | Two are. `verify-commercial-records` is bookkeeping in the `commercial` domain, and it carries the cohort's only quantified success on a *Nomila count* — `closedDeals ≥ 1` would be met by recording a deal she already has. B, with a C note in §3.1: the contract lets a Nomila-side count serve as an athlete-outcome metric. `authenticate-…` is §3.1. |
| 4 | Uncertainty, not invention | **partial** | Facts cited (8th pick, Roc Nation, Unrivaled equity, LSU title). Two manufactured gaps: "lacks commercially scaled campaigns that structurally unite her dual identity"; "public-facing identity remains primarily focused on her rookie season and music" (§3.2, B). |
| 5 | Contract holds her goals | **partial** | Hypothetical: *"her music reaches a charting release or headline tour in the 2027 off-season."* Expressible without a new field — but which domain? `career` is glossed "media, broadcasting, coaching, education, business, life after playing"; a second profession running *alongside* the sport fits only by stretching "media". The evaluator did what the gloss steers toward: it used her music as narrative material inside `positioning` rather than as a career with outcomes of its own. **C-minor: a domain gloss, not a missing domain.** A spec bump could widen the gloss; recorded, not designed here. |
| 7 | Attribution | A absence; B two manufactured gaps + quantified-on-a-count; C-minor domain gloss; D third person | — |

**Conclusion:** the boundary held; the dual career was expressible, and the one shortfall is the wording of a domain gloss, not the contract's shape.

### 2.5 Chisom Okpara — sparse, same school and level as Mia

State LOW. `audience_scale` and `engagement_quality` UNKNOWN (fully imputed); `narrative_power` 76.5 and `brand_fit` 77.8 strengths (his NCAA eligibility lawsuit, Harvard → Stanford); `commercial_proof` neutral 46. `identity.competitionContext` "Stanford University · D1" — the only athlete with an affiliation row. Three gaps, including "official commitment announcement regarding his next transfer-portal destination".

Opportunity (4, LOW): UNLOCK evidence (audience metrics) · AMPLIFY positioning (values-based, "Ivy League and Stanford academic pedigree" — supported by cited E1: All-Ivy at Harvard before transferring) · GROW commercial (direct brand relationships) · GROW evidence (track his transfer commitment, urgency high). Six "why nothing" notes: audience, content, owned_venture, impact, career, relationships — each stating what State does not hold.

Objective (3, LOW): `verified-audience-baselines` (evidence, HIGH) · `direct-corporate-partnerships` (commercial, HIGH, **quantified** `closedDeals` 0 → at least 1) · `localized-market-alignment` (evidence, this_season; success: "the official fifth-year university and competition context are updated and verified in the identity section of the athlete's state"). The positioning opportunity consolidated into the partnerships proposal with a stated reason.

| # | check | verdict | evidence |
|---|---|---|---|
| 1 | State without Mia's shape | **pass** | Same affiliation as Mia, none of her evidence, and nothing in State or the outputs borrowed her profile: no onboarding preferences appeared, no "first deal" archetype, no audience-growth default. Sparse sections rendered as absences. (A: `evidence_as_of` predates the cited evidence, §1.) |
| 2 | Territory appropriate | **pass** | Two of four in `evidence`, as the design said a sparse athlete's honest territory would be; the six notes are the graceful-absence behaviour, exercised fully. |
| 3 | Outcomes worth governing | **partial** | `direct-corporate-partnerships` is an outcome. `verified-audience-baselines` is Nomila's need. `localized-market-alignment` is a data refresh whose success is "the identity section of State is updated" — his programme decision is his, and the Objective governs only Nomila's record of it (§3.1). |
| 4 | Uncertainty, not invention | **partial** | Every substantive claim traces to the refreshed findings (lawsuit, portal entry, injury, "roster collective pools"). The one lapse: "Okpara has zero closed deals and no verified individual corporate endorsements" reads Nomila's zero as his zero. For a sparse athlete the two are indistinguishable in State, and the five richer runs show the same renderer line was read correctly as Nomila's count — so B, not the renderer. |
| 5 | Contract holds his goals | **pass** | Hypothetical: *"he commits to a fifth-year programme whose collective supports individual deals."* `athletic`, this_season, observable; origin necessarily `nomila` (no intent path exists), which is truthful. Nothing needed. |
| 7 | Attribution | A as-of defect; B one Nomila-count-as-fact; D third person | — |

**Conclusion:** the boundary held for the sparse case — nothing was invented from thin air and nothing Mia-shaped leaked through the shared affiliation — but two of his three proposals are Nomila's data needs.

### 2.6 Picabo Street — post-career, wrong `careerStatus`

State LOW. `athletic_authority` 80.5 strength (her 2026 NBC Olympic broadcasting role), `audience_scale` **gap** 37.5, `engagement_quality` UNKNOWN, `narrative_power` 88.8. Identity says `active`; M.I.A.'s rationale says "retired since 2002".

Opportunity (4, LOW): UNLOCK evidence (private metrics) · AMPLIFY owned_venture (Picabo Street Academy sponsorship) · AMPLIFY career (year-round broadcasting off the Olympic momentum, urgency medium) · GROW audience (TikTok/X presence, feasibility **low**). The athletic note: *"her athletic career is inactive (retired from competition since 2002)"* — the evaluator followed the evidence, not the flag. Positioning note: no fix needed.

Objective (3, LOW): `resolve-audience-data-blindspot` (evidence, HIGH; desired state: "*Nomila* possesses direct, continuous integration…") · `establish-year-round-sports-broadcasting-presence` (career, next_12_months, **MEDIUM**) · `expand-academy-sponsorship-portfolio` (owned_venture, next_12_months, **MEDIUM**). The audience opportunity **not carried**, with the reason: "not a digital-first creator; low feasibility of maintaining new platforms; focus on her indirect reach through broadcasting and the academy."

| # | check | verdict | evidence |
|---|---|---|---|
| 1 | State without Mia's shape | **partial** | `careerStatus active` rendered as fact — the documented A defect. The contract can say retired; the data did not. What this exposed: State carried a fact and its contradiction with no representation of the conflict, and the validator cannot see prose. Recorded for the State backlog; not a projection fault. |
| 2 | Territory appropriate | **pass** | Post-career territory (career, owned_venture) found without any competition-ahead assumption; the audience GROW was proposed at feasibility low and then declined at Objective with an honest reason — graceful absence exercised end to end. |
| 3 | Outcomes worth governing | **partial** | Two post-career outcomes she would govern. The evidence proposal's desired state has Nomila as its grammatical subject — the cleanest example of §3.1. |
| 4 | Uncertainty, not invention | **partial** | "Highly cyclical, tied to her NBC Milano Cortina role" — cited. "Has unused capacity to scale these integrations further" — manufactured (§3.2, B). The retired-versus-active contradiction was resolved silently in the athletic note rather than surfaced as a conflict (B; the flag itself is A). The only sub-HIGH confidences of the cohort are hers, on the two non-evidence proposals — calibration in the right direction. |
| 5 | Contract holds her goals | **pass** | The post-career probe the design asked for — a recurring national broadcast role outside Olympic years — *was produced by the run itself*. Second hypothetical: *"academy enrolment grows"* → owned_venture, observable, unquantified. Expressible. |
| 7 | Attribution | A wrong flag; B one manufactured gap + silent conflict resolution; D "the athlete" impersonal third person | — |

**Conclusion:** the boundary held despite wrong identity data; post-career outcomes were represented without a new field, and the wrong flag did not propagate into any competition-ahead Objective.

## 3. What recurs across athletes — separated by layer

Counted so that "everywhere regardless of data richness" can be seen; the counts are not a quality score.

### 3.1 The one C-class finding: Nomila's data needs are proposed as the athlete's Objectives

| athlete | proposals whose desired state is a change in Nomila's data |
|---|---|
| Ronaldo | verify-private-metrics |
| Ledecky | private-metrics-integration · commercial-contract-integration |
| Maher | operational-and-commercial-evidence-baseline |
| Flau'jae | authenticate-private-performance-metrics · verify-commercial-records (`commercial` domain, quantified on Nomila's `closedDeals`) |
| Okpara | verified-audience-baselines · localized-market-alignment |
| Street | resolve-audience-data-blindspot |
| **total** | **9 of 24**, present for every athlete at every level of richness |

Why this is C and not only B. The contract lists `evidence` among an Objective's domains, and the Opportunity contract says in so many words that evidence is "a legitimate strategic domain, not bookkeeping". So a faithful evaluator carrying every UNLOCK opportunity forward is doing what the contract permits. The evaluator *can* leave one behind (`not_carried`, as Street's audience opportunity shows) — that is the B side of the disagreement, recorded. But the effect is architectural: an athlete's review queue will always carry "connect your accounts" and "record your deals" alongside her real goals, and Mia's own review already answered how that reads — she declined the Adidas-metrics analogue as a task, not an outcome. The Context Intelligence design names REQUEST INTELLIGENCE as a first-class Brain output, which is the natural home for exactly this class.

**Sub-finding, same layer:** `success.quantified` accepted `commercialPosition.closedDeals` — a count of what Nomila has recorded — as the metric of an athlete outcome (Flau'jae, Okpara). Baseline-from-State worked as built; the contract does not distinguish a Nomila-record metric from an athlete-world metric.

Nothing here is designed in this page. It is the decision the checkpoint has to make (§5).

### 3.2 Manufactured gaps under AMPLIFY (B — evaluator quality, logged, not acted on)

| athlete | the unevidenced deficiency written into `currentState` |
|---|---|
| Ronaldo | YouTube "lacks a diversified programming matrix beyond its initial launch content" |
| Flau'jae | "lacks commercially scaled campaigns that structurally unite her dual identity"; identity "remains primarily focused on her rookie season and music" |
| Maher | docuseries "not yet integrated as the primary storyline"; Medalist Skin "does not systematically leverage or monetize her 9.2M"; podcast "relies on a single presenting partnership" |
| Street | academy "has unused capacity to scale these integrations further" |
| **total** | **7 claims across 4 athletes**, all on AMPLIFY-derived proposals; none on FIX, UNLOCK or MAINTAIN |

The mechanism: the contract requires a `currentState` that differs from `desiredState`. For an amplification the honest current state is *the measured strength*, and the honest desired state is its extension; the evaluator instead invents a shortfall so that a gap exists to close. The grounding grammar cannot catch this because the cited path exists — it is the claim, not the citation, that is unsupported. The fix would be one paragraph in `objective-eval-spec` (a 1.0.2 candidate: "for AMPLIFY, current state is the strength as measured; do not assert a deficiency the State does not carry"). Not made; the spec is frozen for this experiment.

### 3.3 Nomila's count read as the athlete's fact (B, sparse-specific)

One case (Okpara: "has zero closed deals"), against five athletes where the same rendered zero was read correctly as Nomila's record — Flau'jae's run even proposed a FIX to correct it. The renderer already labels the section as counts; for an athlete with no other commercial evidence the distinction collapses in the prose.

### 3.4 Contradictory State with no representation of conflict (A, with a State-backlog note)

Street only. `identity.careerStatus` and a finding's rationale disagreed; neither side is marked; the validator checks structure. The evaluators sided with the evidence silently. Whether an identity fact contradicted by M.I.A.'s cited evidence should be surfaced (a `disputed` marker, or a validator that compares identity against `citedEvidence` claims) is a State question for later, not an Objective one.

### 3.5 Presentation (D — recorded, not counted)

Third-person prose on 24 of 24 proposals; Street's read "the athlete". Same finding as the frozen four; nothing new.

### 3.6 Things that behaved and are worth stating once

- **Origin** `nomila` on 24/24 — correct: none of the six has said anything to Nomila. The intent seam and `joint` are untested by this cohort (limitation, §1), not wrong.
- **Accounting** complete: 27 opportunities → 24 proposals + 2 consolidated (Okpara positioning, Maher's second evidence opp) + 1 not carried (Street audience), each with a stated reason.
- **Horizon** used, not defaulted: null 8 · this_season 4 · next_12_months 7 · multi_year 5. Null is the spec's stated common answer.
- **Confidence** HIGH on 22/24, MEDIUM on Street's two real outcomes — monotone, but moved in the right direction for the least-known athlete.
- **Graceful absence** exercised at three points: State's "not recorded / stated nothing" lines; Opportunity's per-domain "why nothing" notes (29 across the six); Objective's `not_carried` with reason.

## 4. Check 6 — the path itself, read once for all six

`grep -n "Stanford|NIL\b|college|collegiate|USWNT|soccer|Mia\b|onboarding|season"` over `server/services/intelligence/` excluding tests:

- **No athlete, sport, school, league or country token** in any production file of the intelligence tree. The only matches are test fixtures (`context/testFixtures.ts`, a synthetic soccer athlete), and one doc comment in `contracts/opportunity.ts` listing "NIL, creator businesses…" as examples for `strategyIntelligence`, a declared-but-null future field. Nothing shapes a value.
- **Calendar-shaped vocabulary:** `this_season | next_12_months | multi_year` (Objective horizon) and the deferral periods 90/365 days (versioned hypothesis, already flagged in the lineage design). `this_season` held meaning for a club player, a college player and a broadcaster; for a quadrennial athlete it is loose but usable. Not Mia-specific; sport-calendar-specific in the way any period word is.
- **`identity.competitionContext`** is projected from affiliation rows only. Okpara had one (school-shaped) and got "Stanford University · D1"; the five professionals had none and got "not recorded". Whether the projection can render a club, a national programme or a governing body is **untested by this cohort** — an absence, not a finding.
- **Onboarding preferences** are labelled `onboarding_v1_choice` by the validator; none existed for the six, so the labelling was not exercised here (it was for Mia).
- **The validator** checks structure (sources, labels, paths); §3.4 is the consequence.
- **Score bands** (`STRENGTH / GAP / NEUTRAL / UNKNOWN`) come from M.I.A.'s normalisation and are outside this experiment.

Nothing structurally Mia-specific was found on the path.

## 5. Counts, and the cohort conclusion

| athlete | State conf | opps · kinds | proposals | domains | Nomila-data proposals (§3.1) | manufactured gaps (§3.2) | conf | consolidated / not carried |
|---|---|---|---|---|---|---|---|---|
| Ronaldo | MEDIUM | 5 · U·A·F·G·A | 5 | evidence, content, positioning, career, owned_venture | 1 | 1 | 5 HIGH | 0 / 0 |
| Ledecky | MEDIUM | 4 · U·U·M·A | 4 | evidence ×2, positioning, impact | 2 | 0 | 4 HIGH | 0 / 0 |
| Maher | MEDIUM | 6 · U·G·M·A·A·A | 5 | evidence, athletic, career, owned_venture, content | 1 | 3 | 5 HIGH | 1 / 0 |
| Flau'jae | MEDIUM | 4 · F·U·A·A | 4 | commercial, evidence, positioning, owned_venture | 2 | 2 | 4 HIGH | 0 / 0 |
| Okpara | LOW | 4 · U·A·G·G | 3 | evidence ×2, commercial | 2 | 0 (one count-as-fact, §3.3) | 3 HIGH | 1 / 0 |
| Street | LOW | 4 · U·A·A·G | 3 | evidence, career, owned_venture | 1 | 1 | 1 HIGH · 2 MEDIUM | 0 / 1 |
| **six** | | **27** | **24** | 9 of 10 domains used (never `relationships`) | **9** | **7** | | 2 / 1 |

Kinds: U unlock · A amplify · F fix · G grow · M maintain.

**Per-athlete, one sentence each:** Ronaldo — held; not treated as a growth case. Ledecky — held; no team or season assumption. Maher — held; five domains for one athlete, failures are evaluator-written. Flau'jae — held; dual career expressible, the domain gloss steered it into positioning. Okpara — held; nothing invented, nothing of Mia's leaked through the shared affiliation. Street — held; post-career outcomes without a new field, the wrong flag did not propagate.

**Cohort conclusion — the only question this page answers.** The Objective boundary is athlete-general. Across six athletes chosen to break it, no college, NIL, U.S., team or active-athlete assumption reached an output; post-career, dual-career, individual-sport, sparse and saturated cases were all expressible under `objective-proposal/1.0.0` as it stands; missing evidence produced absence with reasons rather than strategy; and the path contains nothing shaped around Mia. It is **stable enough to be the input of the first Brain + Context Intelligence experiment, on one decision the checkpoint must make first**: what the Brain is to do with the nine-of-24 evidence-acquisition Objectives (§3.1). A Brain fed these unchanged either spends its first experiment issuing REQUEST INTELLIGENCE or mistakes Nomila's needs for the athlete's goals. **Decision (Mia, 2026-09-25):** they are not Objectives. Consent to the underlying action does not make a change in Nomila's knowledge a goal of the athlete's; the information gap stays upstream (State material gaps, the Opportunity `evidence` domain) for the Brain's REQUEST INTELLIGENCE. Enforced as a semantic boundary plus one gate-1 rule, no schema change: `docs/architecture/commercial-intelligence/objective-knowledge-boundary.md`. The checkpoint closes once that correction is agreed and targeted tests show the nine cases routed correctly. Everything else found (§3.2–3.5) is A, B or D and goes to the evaluator-quality and State backlogs without blocking the Brain.

## 6. Not done, on purpose

No threshold, prompt or contract changed. Nothing materialised or reconciled. No athlete-originated Objective. No research refresh. No Brain. The 1.0.2 candidate in §3.2 and the routing decision in §5 are recorded for the checkpoint, not started. The `objectiveRun` zero-iteration seen on the first attempt (header printed, no athlete lines, empty output directory) was not reproduced: the two subsequent invocations with `--athletes` processed exactly the named artifacts; the script's filter is unchanged.

---

## 7. The knowledge-boundary correction, verified — checkpoint closed

Design: `docs/architecture/commercial-intelligence/objective-knowledge-boundary.md` (approved with the clarification that the spec rule is the primary semantic enforcement and the gate-1 rule a narrow structural backstop). Implemented as `objective-eval-spec/1.0.2` (digest `92b80353…`) plus one gate-1 rule refusing `domain: evidence`. Contract shape unchanged. The AMPLIFY finding was not bundled.

### 7.1 Synthetic tests and the ceremony

Gate 1 refuses a proposal in `evidence` and accepts one in each of the nine other domains; a knowledge-state sentence filed under `commercial` passes gate 1 by design (the test says so in its own comment). Parity tests assert the block's key sentences and its position between the outcome and horizon blocks. Digest unpinned, recomputed, reviewed as text, repinned. 22 spec tests, 123 Objective and route tests green; both typecheck configs clean for the touched files.

### 7.2 Offline classification of the 24 committed 1.0.1 proposals through gate 1

| result | proposals |
|---|---|
| refused (`evidence`) | Okpara `verified-audience-baselines`, `localized-market-alignment` · Ronaldo `verify-private-metrics` · Flau'jae `authenticate-private-performance-metrics` · Maher `operational-and-commercial-evidence-baseline` · Ledecky `private-metrics-integration`, `commercial-contract-integration` · Street `resolve-audience-data-blindspot` — **8** |
| passes gate 1 | the 15 world outcomes, **and Flau'jae `verify-commercial-records`** (`commercial`) — the documented residual the backstop cannot see |

Exactly as the design predicted: eight of nine structurally, the ninth left to the evaluator.

### 7.3 The Objective-stage-only rerun under 1.0.2 — six calls, $0.113, nothing materialised

Same six frozen Opportunity artifacts, same State blocks; only the spec changed. Artifacts under `…/objective-1.0.2/`. Matched against the 1.0.1 sets by lineage (`lineageFor`, tier A = shared opportunity key, tier B = evidence Jaccard ≥ 0.5) and then read.

| athlete | 1.0.1 → 1.0.2 | gate | knowledge opportunities → `not_carried` | world outcomes kept (tier A) | new |
|---|---|---|---|---|---|
| Okpara | 3 → 2 | pass | 2 of 2, "information acquisition… does not constitute a changed state in the athlete's own world" | 1 of 1 | positioning no longer consolidated into partnerships (a world outcome, ambassador/campaign) |
| Ronaldo | 5 → 4 | pass | 1 of 1 | 4 of 4 | — |
| Flau'jae | 4 → 2 | pass | 2 of 2 — **including `fix-missing-commercial-records`**: "internal database reconciliation and information acquisition rather than a change in the athlete's real-world commercial position" | 2 of 2 | — |
| Maher | 5 → 4 | pass | 2 of 2 (the two that 1.0.1 had merged) | 4 of 4 | — |
| Ledecky | 4 → 2 | pass | 2 of 2 | 2 of 2 | — |
| Street | 3 → 3 | pass | 1 of 1 | 2 of 2 | `expand-platform-footprint` (audience, MEDIUM): the opportunity 1.0.1 declined as low-feasibility is now carried — run-to-run judgement variance, a world outcome, not a boundary matter |
| **six** | **24 → 17** | **0 refusals** | **10 of 10** | **15 of 15** | 2 |

Accounting complete: 27 opportunities = 17 carried + 10 not carried, each with a reason. Origin `nomila` throughout. The only quantified success is Okpara's first partnership (`closedDeals` 0 → ≥1), a world change.

**The semantic check for disguised replacements, proposal by proposal.** No 1.0.2 desired state has Nomila as its subject or would be reached by Nomila learning something while the athlete's world stood still. The nearest cases, read closely: Maher's Medalist Skin proposal has a `currentState` phrased as a knowledge gap ("scaling and retail footprint are not documented in her commercial profile") under a desired state that is squarely the world (retail distribution, verified revenue growth) — an outcome, not a disguise; Flau'jae's two proposals cite the zero `activeRelationships` as "recorded… at zero", correctly labelled as Nomila's count, with desired states that are new partnerships and campaigns. Nothing was paraphrased across the line: the evaluator declined the nine rather than re-dressing them, which is what the block's "you do not rephrase them" sentence asked.

**Observed alongside, not part of the criterion.** Okpara's and Street's `currentState` still read Nomila's zero closed deals as the athlete's fact (§3.3, B, unchanged). Ledecky's positioning proposal kept its lineage (tier A, Jaccard 1.0) but drifted in purpose from narrative resilience to commercial insulation — variance between runs, both world outcomes. Several 1.0.1 manufactured gaps (§3.2) came back better grounded this time (Maher's docuseries "in development, not yet produced"; Medalist "not documented") and one did not ("presented exclusively by Samsung"); the AMPLIFY finding stands as the 1.0.3 candidate and nothing here is attributed to it.

### 7.4 Verdict

All five success conditions hold: zero gate-1 refusals; the nine knowledge-state proposals accounted for and no longer carried for the same semantic purpose; no disguised replacements; every genuine athlete-world outcome still represented, by lineage and by reading; no structural regression. **The Objective boundary checkpoint is closed.** No further Objective cohort unless a later run exposes an actual structural problem. Logged for later: Flau'jae's upstream mis-domain (B, Opportunity spec), the AMPLIFY paragraph (B, 1.0.3), Street's State conflict pressure point, Flau'jae's `career` gloss as taxonomy pressure, and the untested true-low-evidence athlete.

