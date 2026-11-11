# Rate Intelligence Beta.1 — design and proposed rubric

**Owner:** Mia
**Date:** 2026-09-17
**Status:** DESIGN DIRECTION — approved for review as written. **No implementation.**
**§9.1 (the reasoning rubric) is FROZEN** as of 2026-09-17, across seven reviewed blocks.

This is the operative document. It supersedes the earlier v0 draft in full; prior thinking is in git history rather than in override blocks, so nothing here needs mentally resolving against anything else.

---

## 1. What Rate answers

> **What should this athlete reasonably charge for this commercial activity under the standard terms basis, given current market evidence and this athlete's commercial value?**

For each established rate:

| | |
|---|---|
| **LOW** | defensible lower end of the athlete's current commercial pricing range |
| **EXPECTED** | the price Nomila estimates the athlete should generally expect or target — the athlete-facing **Suggested Rate** |
| **HIGH** | defensible upper end under current market conditions |

`LOW / EXPECTED / HIGH` describe a **plausible commercial and negotiation range**. They are **not** an uncertainty interval.

Rate is **not** a prediction of the next brand offer, not the athlete's minimum acceptable price, not the maximum imaginable ask, and not a guaranteed closing price.

### The neighbouring concepts, kept separate

```
RATE         what should I generally charge?                      ← this document
FLOOR        what am I unwilling to accept below?                 athlete preference, not intelligence
DEAL         what is this particular opportunity worth, given its actual terms?
NEGOTIATION  what should we ask or counter, given the state?
OUTCOME      what actually happened
```

---

## 2. Methodology

The v3.1-style approach is rejected and not reintroduced: **no hardcoded CPM anchors, no athlete pricing multipliers, no `scoreMod`-style adjustments, no arbitrary clamps, no five-capitals formulas, no PAV-style deterministic valuation, no synthetic athlete target rates.**

The governing principle:

> **The market anchors the estimate; athlete-specific evidence determines where the athlete should price relative to that anchor. Strong closely comparable transaction evidence carries substantial weight. Material departure above or below requires evidence-backed reasoning.**

A benchmark is **not a floor and not a ceiling.** The evaluator may place the athlete below, within or above a benchmark range where the evidence supports it.

**AI researches, classifies and evaluates. Nomila deterministically performs only genuinely arithmetic operations** — persistence, versioning, currency, totals, deltas, and projection into a rate card. Code never adjusts, weights, clamps or modifies a price.

---

## 3. The commercial reasoning rubric

Six qualitative lenses, plus a separate epistemic judgment. **No deterministic weights, no points, no formula assigning fixed importance.** Their relative importance legitimately differs by rate type.

> This section is the **summary**. The operative, frozen instruction text is **§9.1** — where any question about what the rubric actually says is settled.

**1 · Market anchor.** What does the relevant market pay? Credible benchmarks, comparable transactions, activity and platform, terms, sport and level, cohort, geography, recency, evidence quality, commercial comparability.

**2 · Distribution value.** What distribution does this athlete bring *for this activity*? Audience size, effective reach, engagement, audience quality and composition, geography, platform strength, growth, expected distribution. **Never reduce this to follower count.**

**3 · Athlete / identity premium.** Why is there commercial value beyond impressions? Athletic authority, recognition, cultural relevance, narrative, scarcity, credibility, momentum, audience affinity, identity and brand value.

**4 · Activity fit.** Why is this athlete valuable for *this specific activity*? Content ability, camera presence, credibility, audience response, speaking value, appearance value, product and category fit, and other activity-specific characteristics.

**5 · Commercial proof and demand.** What has the market already demonstrated? Real offers, contracts, completed campaigns, prior pricing, repeat business, renewals, campaign performance, inbound demand, brand quality, pricing power. **Strict evidence-status guards apply (§5).**

**6 · Pricing leverage and constraints.** Scarcity, availability, demand, season and timing, competitive position, category saturation, opportunity cost, existing commitments, and other commercially material leverage.

### The separate question: how much do we know?

Evidence sufficiency is **separate from value**. Benchmark comparability, connected versus public social evidence, transactions versus asks, missing evidence, source quality — these determine **confidence in the estimate**, and do **not** mechanically determine athlete value.

Confidence is not a seventh value lens. It is the epistemic judgment that keeps uncertainty out of the price, and it is frozen as **§9.1 Block 7**.

---

## 4. Range versus confidence

These are different things and stay separate.

- **LOW / EXPECTED / HIGH** — a commercial pricing and negotiation range.
- **CONFIDENCE** — how certain Nomila is that the recommended range is well established from the available evidence.

**Uncertainty does not enter the price — in either direction.** The range is not widened because evidence is weak, nor narrowed because it is strong; and the expected Rate is not pulled toward the market anchor because we know less. Epistemic uncertainty is expressed through **confidence**, and only through confidence. §9.1 Block 7 carries the operative wording and the evidence for why the anchor, not the range width, is where the leak actually happens.

**Confidence exists per rate estimate**, as `HIGH | MEDIUM | LOW`, emitted **directly by the evaluator as a
rubric-constrained qualitative judgment** with a concise evidence-grounded reason.

There is no numeric rate confidence, no deterministic threshold, no numeric-to-band mapping, no overall athlete rate
confidence, and no `identity_confidence` — entity resolution belongs to the identity system, not to a Rate judgment.

**This is deliberately different from M.I.A.** MIA produces a *numeric* confidence for which no versioned
HIGH/MEDIUM/LOW mapping was ever established, which is why its ledger band is null. Rate's HIGH/MEDIUM/LOW **is** the
evaluated confidence judgment, so no mapping policy is needed or wanted.

---

## 5. Evidence

### 5.1 Direct and indirect

Direct evidence is preferred. Reasoning by analogy is **not prohibited**: related commercial evidence may inform an estimate where the relationship is commercially defensible — Instagram Reel evidence may inform TikTok pricing alongside TikTok-specific audience and platform evidence.

When it does, it must be **explicitly identified as indirect**, treated accordingly, and **never promoted into an observed transaction or a direct benchmark**.

Where direct plus defensible indirect evidence still cannot support a rate, return `NOT_ESTABLISHED`. Do not manufacture a number.

### 5.2 Progressive evidence, and no connection bonus

Rate works before and after accounts are connected.

- **Connected authoritative data**, where it exists, is used for the metrics it covers and supersedes lower-authority public estimates **for those same facts**.
- **Without it**, credible public evidence, athlete-specific research, social evidence, commercial evidence and MIA context are used.
- **Where evidence does not exist**, it is marked missing.

**NOT CONNECTED does not mean LOWER VALUE.** Connection improves knowledge and accuracy, never value. The progression `public → connected → Nomila commercial evidence → transaction outcomes` must work without any change to the methodology.

### 5.3 Commercial evidence status

Nomila's **own** commercial evidence is read from the Deals domain, which is canonical. The evaluator uses `deals.status` as recorded and does not re-infer it. See [`docs/audits/deals-domain-audit.md`](../../audits/deals-domain-audit.md) §17 for the mapping and its limits.

**External, researched** commercial claims carry `evidence_method` (how Nomila came to know the evidence) and `commercial_state` (what it establishes commercially) as **separate** axes. Both vocabularies are in **§9.4**.

*Until 2026-09-17 this section pointed at an `EvidenceMethod` defined in §8, where it never appeared; the eight composite values lived only in the superseded `rate-beta1-plan.md`. §9.4 replaces them — see the supersession table there.*

Strict promotion guards apply to researched claims — seeding is not a partnership, a conversation is not an offer, an asking price is not a transaction, a reported valuation is not earnings, a package price is not the price of one component.

### 5.4 MIA

Rate consumes the **exact durable MIA assessment** used for the evaluation, by `ValueRef` prediction reference. MIA dimensions and rationale are available as athlete evidence and context.

**MIA is context, never a multiplier.** Two athletes at the same MIA with inverted dimension profiles must be able to price very differently, which a multiplier makes impossible by construction.

Rate Intelligence and M.I.A. may consume governed real-world commercial evidence independently under their respective admissibility rules. M.I.A. outputs may inform Rate Intelligence as marketability context, but Rate outputs, learned pricing parameters, and Nomila-predicted rates or values never feed back into M.I.A.

Real commercial outcomes are observations, not Rate outputs. Their use by M.I.A. is governed by M.I.A.'s evidence-admission contract; their use by Rate is governed by Rate Intelligence's own evidence and learning contract.

Outcomes admitted to M.I.A. enter as evidence only; they do not supply a score, signal value, or marketability interpretation.

*Clarified 30 Sep 2026, consistent with locked ADR-011 ("Verified commercial outcomes may inform Commercial Proof; Nomila's own predicted rate/value does not feed MIA"). This line previously read "Commercial outcomes may calibrate Rate. Commercial outcomes must never feed back into MIA scoring (ADR-011)."; it is narrowed to the Rate-learning boundary.*

---

## 6. Commercial activity taxonomy

**Nine families are supported by Rate Beta.1.** Licensing royalty is deferred — see §6.3. **Supported does not mean a number is always returned** — every applicable category is attempted, and `NOT_ESTABLISHED` is returned where evidence is insufficient.

| # | activity family | platform-specific |
|---|---|---|
| 1 | Social feed / static post | ✅ |
| 2 | Social short-form video (Reel-type) | ✅ |
| 3 | Social Story | ✅ |
| 4 | UGC content | — |
| 5 | In-person appearance | — |
| 6 | Virtual appearance | — |
| 7 | Annual Brand Partnership | — |
| 8 | Autograph session | — |
| ~~9~~ | ~~Licensing royalty~~ — **deferred from Beta.1, see §6.3** | — |
| 10 | Camp / clinic | — |

### 6.1 Platform-specific social rates

Social rate identity is **platform-specific**. Platform is required where commercially applicable and null otherwise.

```
Instagram   feed/static · Reel · Story
TikTok      video/post
YouTube     Short
```

Additional commercially meaningful combinations can be added later. **Do not create dozens of arbitrary platform types** — maintain an explicit, extensible set of valid activity/platform combinations.

Connected platform data can legitimately produce different rates across platforms. **There is never a value bonus merely because an account is connected.**

### 6.2 Annual Brand Partnership

This replaces the earlier `ambassador_monthly` and answers the Nike/adidas-shaped question: **what is this athlete worth as an ongoing brand partner over a 12-month relationship?**

Basis: *estimated annual value for an ongoing athlete–brand partnership, assuming a commercially reasonable mix of activations across 12 months, potentially including social content, appearances, events, shoots, signings, travel and other brand participation.*

- **Do not invent a fixed package** ("6 posts + 4 appearances + 2 shoots").
- **Do not compute it** as `Reel + Story + Appearance × multiplier`.
- It is **independently evaluated**, because partnership value includes association, identity, access, continuity, scarcity, category relationship and strategic value that summing one-off activities does not represent.

Specific deliverables, rights, travel, exclusivity and performance bonuses belong to Deal Intelligence. The baseline exclusivity and rights assumptions are **stated explicitly in the terms basis (§7.4)**, never hidden inside a premium.

### 6.3 Licensing royalty — deferred from Beta.1

**The economically meaningful quantity cannot be expressed in the frozen estimate contract, and nothing could yet learn from it if it could.**

A licensing royalty is a percentage of a contract-specific revenue base. The base itself — net sales, gross, wholesale, after returns — varies per contract and is among the most negotiated definitions in licensing. §9.2 fixes `low / expected / high` as **USD**, which cannot represent a percentage without a unit discriminator on the estimate or a second estimate kind.

Naming the family "Licensing Royalty" while returning USD would be **semantically false**. Returning a minimum guarantee under that name is only marginally better: it invites an athlete to read the number as their royalty economics.

The deferral is decided on **P-9 (evidence-bounded capability)** — where the required evidence or outcome observability does not exist, defer the capability or represent the limitation explicitly rather than inventing unsupported structure. The Deals audit found royalty, revenue-share and bonus economics have **no representation anywhere in the schema**: `licensing` is a valid `deal_type` while a licensing deal cannot record its royalty terms. A Rate output for this family would therefore have no deal-side counterpart, nothing to compare against, and no path to calibration — a permanent structural cost to the estimate contract for a capability nothing could validate.

**The trigger for revisiting**, so this is a decision rather than an omission: Deals gaining royalty-base and royalty-rate representation, at which point both the outcome side and the type question can be settled together on evidence.

**Before any of that, one definition must be settled**: what Nomila's Licensing Royalty Rate is intended to express — a royalty percentage, a guaranteed minimum licensing fee, or a combination. That question is open and is not answered here.

---

## 7. Terms basis

**A rate type without an explicit terms basis is meaningless.** The basis defines what the estimate means *and* what counts as comparable transaction evidence later. §9.1's standing instruction says *price each activity at its stated terms basis exactly* — so **an activity with no stated basis cannot be priced at all.**

**Seven bases are frozen below, covering all nine Beta.1 families.**

### 7.1 Base social terms — families 1–3, per platform

```
athlete-created · athlete-posted · organic distribution on the athlete's own account
non-exclusive · no paid media or whitelisting
no standalone content licensing beyond ordinary organic resharing
minimum_live_duration: 30 days          [declared parameter]
rights_territory: N/A — no reusable brand licence is granted
```

**No usage-window assumption.** The earlier 30-day figure was arbitrary and is removed. Extended usage rights, paid amplification, whitelisting and exclusivity are priced downstream by Deal Intelligence against actual market rights evidence — **never by a fixed percentage premium or a deterministic multiplier in Rate.**

**`minimum_live_duration` is not a usage term.** It governs how long the athlete's own post remains available and grants the brand **no additional usage rights** of any kind. The naming matters: conflating it with a usage window is precisely the error §7.1 already corrected once.

**Thirty days is a declared Beta.1 parameter**, chosen deliberately at the shorter end so that a longer live requirement remains a **visible commercially material difference** rather than being silently included in the basis. **It is not presented as an observed market convention for minimum live duration** — the research consulted returned exclusivity windows and post-campaign usage windows, neither of which is the athlete's own post remaining live.

**`rights_territory: N/A`, not `GLOBAL`.** No reusable licence exists in this basis, so naming a territory would assert a worldwide grant Nomila never made. A field value that misdescribes the contract is worse than an absent one.

### 7.2 UGC — family 4

```
athlete-created, delivered to the brand · the athlete does NOT post it
non-exclusive
90 days organic use on the brand's owned social channels   [declared parameter]
rights_territory: unrestricted within that channel scope — the channel scope is the limit
one edited deliverable · one revision round
excluded: paid media, whitelisting / Spark Ads, broadcast, OOH, print, retail,
          website or e-mail use beyond owned social, raw or unedited footage,
          additional hook or CTA variants, exclusivity
```

UGC differs structurally from base social: usage is **intrinsic**, because the athlete creates content *for the brand* rather than distributing it to their own audience. Market practice consistently separates a **creation fee** (the athlete's time and craft) from a **licence fee** (how the brand deploys it), with organic use on owned channels included in the base and everything else licensed separately. That separation is the convention; the basis above adopts it.

> **Beta.1 canonical parameter: 90 days of non-exclusive organic use on the brand's owned social channels.** Ninety days is a **versioned Nomila terms-basis choice within observed market practice, not a claim that 90 days is the industry-standard duration.** Available guidance spans different windows and explicitly acknowledges variation.

The choice is made on asymmetry: the card tells an athlete what to charge, and quoting a shorter window than a brand reasonably expects within a base rate means the athlete under-charges for what they actually hand over.

**Every UGC benchmark must preserve its own usage duration and rights scope**, or §9.1 Block 1 cannot judge comparability against this basis — "rights and usage" is listed there as a commercially material difference, and the evaluator has nothing to evaluate it from otherwise.

### 7.3 Appearance, autograph and clinic bases — families 5, 6, 8, 10

**In-person appearance (5)**

```
one appearance · 2 hours on site                        [declared parameter]
travel, lodging and per diem EXCLUDED — borne by the organiser
no content licensing: photography or video captured at the appearance is not
  licensed for advertising use
non-exclusive · rights_territory: N/A
```

Travel exclusion is **convention, not a Nomila choice**: appearance fees are generally quoted exclusive of travel and accommodation, handled separately by the organiser, precisely so the fee itself remains consistent regardless of distance. Adopting it is what makes appearance rates comparable across geography by construction.

**Virtual appearance (6)** — as above, **1 hour** *[declared parameter]*, no travel line, and one term that must be explicit because silence would be read as permission: **the recording is not licensed for reuse.** A virtual appearance is trivially recordable.

**Autograph session (8)**

```
one session · 2 hours                                   [declared parameter]
signatures bounded by session duration — a time deal, not a numeric cap
items supplied by the organiser · standard items
excluded: personalisations and inscriptions, travel, lodging, per diem,
          any licensing of the signed items' resale
non-exclusive · rights_territory: N/A
```

**Duration bounds the session, and that is a declared choice — not a convention we found.** What the research supports is narrower than the basis above: private signings are commonly **time-bounded**, and payment within that window is frequently structured **per signature**, often with a minimum-signature guarantee. Time-bounding is therefore observed; **the flat session fee is Nomila's choice**, adopted so the family quotes one comparable quantity rather than two.

It follows that **per-signature pricing with a minimum guarantee is a genuine market structure that this basis does not represent.** It belongs to Deal Intelligence against an actual opportunity, and a benchmark struck on that structure is not directly comparable to this basis — §8's terms-admissibility rule is what makes that visible rather than silent.

**Camp / clinic (10)**

```
one session · 2 hours                                   [declared parameter]
athlete participates as an instructor or featured clinician
flat participation fee — NOT a share of enrolment revenue
travel, lodging and per diem EXCLUDED — borne by the organiser
no content licensing · non-exclusive · rights_territory: N/A
```

**Instructor or featured clinician specifically.** Merely attending or participating in someone else's clinic is commercially closer to an appearance, and folding both into one basis would make the two families non-comparable against their own benchmarks.

Two hours is chosen to match the in-person appearance basis, so the two differ by **instruction content rather than duration** — which is what lets them be separately comparable instead of confounded.

### 7.4 Annual Brand Partnership — family 7

```
12-month ongoing athlete–brand partnership
category exclusivity against direct competitors in the sponsor's
  PRIMARY product or service category, for the term      [declared boundary]
brand promotional use of athlete NIL on the brand's OWNED channels,
  organically, during the term
ongoing reasonable participation in brand activations appropriate to the
  partnership — the mix, quantity, timing and format are NOT fixed here
non-exclusive as to every category other than the sponsor's primary one

excluded: broader exclusivity (multiple or adjacent categories, whole industry
          verticals, platform exclusivity, territory exclusivity, restrictions
          extending beyond the term, any category definition broader than the
          sponsor's primary category)
          paid media and amplification · OOH · retail and POS · packaging
          print · broadcast · e-mail acquisition campaigns
          standalone content licensing · post-term use
          travel and accommodation · performance bonuses
```

This is the only basis that describes a **relationship** rather than a deliverable, which is why §6.2 forbids both routes that would turn it into one: no fixed package, and no derivation from the atomic rates.

**Exclusivity is included, and that reverses an earlier position in this design.** The reasoning is recorded because the reversal is instructive rather than incidental. An initial reading of the research emphasised that exclusivity is priced as *"a premium over the base ambassador fee"*, which implies a non-exclusive base object. But the same body of guidance says sponsorship relationships *"usually come with exclusivity"*, that the premium varies with **category breadth** rather than with exclusivity's bare existence, and that the recommended shape is to narrow exclusivity *"to competing categories … which protects the sponsor without unfairly blocking unrelated income."* Narrow category exclusivity is therefore the normal form of the relationship, not an uplift on it.

Pricing an artificially stripped-down non-exclusive arrangement would make the estimate answer a question nobody asks, and would put the basis further from the modal executed contract than it needs to be — which is a comparability cost paid for nothing.

**"Primary category" is a declared Beta.1 boundary**, not a universal contract convention. The research supports narrow competitor and category exclusivity; **Nomila is choosing the precise normalisation boundary.** The alternative — deferring the definition to "the sponsor's defined category" — would leave the quantity unfixed, since a sponsor may define its category as broadly as it likes, and scope vagueness here is a known contractual ambiguity.

**The NIL grant is narrower than convention, deliberately.** The conventional endorsement grant conveys broad use of name, likeness, signature and handles across *advertising, marketing, promotion and sale* for the term. This basis takes a **channel-scoped subset** — the brand's owned organic channels — applying §7.5's rule that channel scope, not geography, is what constrains a grant. That subset is a declared narrowing; no research establishes an "announce-only" tier as a market convention, and none is claimed here.

**The athlete's commitment is stated qualitatively on purpose.** Annual's defining property is that the activation mix is negotiated, so fixing it here would recreate the package §6.2 rejects, while leaving it unstated would not describe a quantity at all. *Ongoing reasonable participation* is the honest middle: Annual prices **relationship and partnership value**, and the actual contract determines what the athlete must do to hold that relationship.

**Annual benchmarks must preserve the actual activation obligations where known.** Materially intensive or unusually light obligations affect comparability and must **not** be silently treated as equivalent to the canonical relationship. A $500K partnership requiring thirty posts and a $500K partnership involving a handful of activations are different commercial objects, and §9.1 Block 1 can distinguish them only if the obligations travel with the benchmark — **without** Nomila inventing an allocation back into atomic rates, which §6.2 forbids.

**Two scopes must accompany every annual benchmark**, for the same reason and with more force than elsewhere on the card: its **exclusivity scope** and its **NIL scope**. This basis sits close to the modal executed contract on exclusivity but narrower on NIL, so a bare annual figure is likely struck on broader rights than this basis grants. Recorded scopes let Block 1 judge that difference; absent them, Annual is the family where systematic under-pricing would be most likely, and it would present as a rubric failure rather than as the terms mismatch it actually is.

### 7.5 Geography — three concepts, never one field

| | what it is | where it lives |
|---|---|---|
| **audience geography** | evidence about the athlete's commercial value | §9.1 Block 2 distribution evidence |
| **rights territory** | a contract term, applicable only where the brand receives deployment rights | the terms basis |
| **appearance / travel geography** | who bears travel cost, and the scheduling burden of fulfilling an appearance | **outside** the fee, per convention |

**Territory is meaningful only once media scope exceeds organic owned social.** Social platforms are global by mechanics, so for owned-channel organic use geography is not the limiter — **channel scope is.** Territory becomes a real variable when media expands to paid regional targeting, OOH, retail, broadcast or print.

That is why base social is `N/A` (no reusable licence at all) while UGC is *unrestricted within the specified owned-social channel scope* (the channel list does the constraining). Endorsement agreements distinguish geographic scope, media and channel rights, and product or category limitations as separate axes; collapsing them into one "geography" field is a known source of contractual ambiguity.

### 7.6 Declared parameters

Every value below is a **definition of what Nomila is quoting**, not an assertion that the market has one universal value. Each is versioned with its basis and changeable on evidence.

| basis | parameter | value | settled by convention? |
|---|---|---|---|
| base social | `minimum_live_duration` | 30 days | **no** — declared Beta.1 parameter |
| UGC | organic owned-channel use | 90 days | **no** — declared within observed practice |
| in-person appearance | session duration | 2 hours | **no** — declared |
| virtual appearance | session duration | 1 hour | **no** — declared |
| autograph session | session duration | 2 hours | **no** — declared |
| autograph session | signature bound | by session duration | **partly** — time-bounding observed; flat session fee is a Nomila choice |
| camp / clinic | session duration | 2 hours | **no** — declared, aligned to appearance |
| annual partnership | exclusivity scope | sponsor's **primary** category, direct competitors | **partly** — narrow category exclusivity is the recommended shape; the *primary-category* boundary is Nomila's normalisation |
| annual partnership | NIL scope | brand-owned organic channels | **no** — declared narrowing of a conventionally broader grant |
| annual partnership | athlete commitment | ongoing reasonable participation, mix not fixed | **no** — declared; §6.2 forbids both a fixed package and derivation from atomic rates |
| appearance / autograph / clinic | travel, lodging, per diem | excluded | **yes** — market convention |
| UGC | creation fee separate from licence fee | — | **yes** — market convention |

### 7.7 The research firewall

The terms-basis research recorded above establishes **contractual structure and convention only.** It is **not** Rate benchmark evidence and is **not** admissible under §8.

The sources consulted are creator-education and agency guidance. For **terms structure** that is the right material to read, because it describes how contracts are conventionally shaped. For **prices** it is `MARKETPLACE_ASK` at best — what creators are advised to charge, never what buyers paid — and §9.1 Block 5's status-promotion discipline applies to it exactly as it applies to any other researched commercial claim.

Benchmark seeding (§8.3) is a separate exercise with its own verification step. **Nothing in §7 seeds a benchmark.**

**Research context — not canonical, not a term, not a benchmark.** One quantitative observation surfaced while establishing the autograph structure: signing throughput of roughly **200–300 signatures per 2 hours**. It is recorded here, deliberately outside §7.3, because an unverified market observation must not become quasi-canonical merely by sitting beside frozen terms. It is **not** part of the autograph basis, carries no verification, and has no standing until the benchmark registry takes it through §8.3. Its only present use is as a note for whoever later judges whether a benchmark quoting a numeric signature cap is comparable to a duration-bounded session.

### 7.8 Versioning

Each rate type/platform has exactly **one active canonical terms basis**. Bases are versioned. When one changes, historical estimates under the old basis remain immutable and valid as historical intelligence; new estimates use the active basis; the athlete's current rate card shows **only** estimates on the active basis. Multiple historical bases are never presented as simultaneously current.

**A terms-basis version identifies the commercial quantity being priced**, and changes **only** when that quantity's canonical terms change.

| identifier | families | |
|---|---|---|
| `social/1.0.0` | 1–3 | all applicable platforms |
| `ugc/1.0.0` | 4 | |
| `appearance/1.0.0` | 5 | |
| `virtual/1.0.0` | 6 | |
| `annual/1.0.0` | 7 | |
| `autograph/1.0.0` | 8 | |
| `clinic/1.0.0` | 10 | |

**The seven versions move independently.** Changing UGC from 90 to 60 days bumps `ugc` and nothing else. Changing the social `minimum_live_duration` bumps `social`, and every social rate estimate thereafter uses the new social basis.

**A single version across all of §7 would be wrong**, not merely coarse: it would mark appearance estimates as sitting on a superseded basis when their basis never moved, contradicting the guarantee above that historical estimates remain valid under the basis they were struck on.

**Platform does not require its own basis version.** Platform is already part of Rate identity (§11), and the canonical social terms are shared across platforms — so the three social families share `social/1.0.0` and move together when it changes, which is correct, because they share the same terms text.

Licensing royalty (family 9) has no identifier because the family is deferred (§6.3).

---

## 8. Market benchmarks

**One canonical Rate Benchmark Specification**, not ten unrelated systems. Within it, separate benchmark sets per rate type and platform.

```
RATE BENCHMARK SPECIFICATION
├── common benchmark contract
└── one set per: IG feed · IG Reel · IG Story · TikTok video · YouTube Short
                 UGC · in-person appearance · virtual appearance
                 annual partnership · autograph · camp/clinic
```

Licensing royalty is absent because the family is deferred from Beta.1 (§6.3). When it returns, its set is where royalty base and percentage belong.

The **common specification** governs provenance, source, evidence method and type, verification, versioning, lifecycle, date and recency, terms basis, athlete and cohort context, and confidence. Individual sets may extend it with economically necessary attributes — platform and reach context for social; usage context for UGC; duration, location and travel for appearances; duration, and for annual partnership specifically **exclusivity scope, NIL scope and the actual activation obligations where known** (§7.4).

**Every benchmark carries its own terms, not just its price.** §9.1 Block 1 lists rights and usage among the commercially material differences the evaluator must weigh, and it has nothing to weigh them from unless each benchmark records the terms it was struck on — usage duration and rights scope for UGC, session duration and what travel was included for appearances, live-duration and exclusivity requirements for social. A benchmark price without its terms cannot be compared to §7's bases, and is therefore not usable as a benchmark.

**Benchmarks do not automatically cross rate types.** Cross-type evidence is usable only as explicitly identified indirect evidence, where commercially defensible (§5.1).

### 8.1 Comparability

Benchmark strength depends on **both** evidence quality **and** commercial comparability. *"Real transaction" does not automatically mean "good benchmark."*

Comparability is a **qualitative evaluator judgment** over commercially relevant characteristics — activity and platform, terms, market and competition level, audience scale and quality, sport and category, geography, recognition, recency. The evaluator states whether evidence is strongly, moderately or weakly comparable **and the commercially relevant reason**.

**No deterministic similarity scores, no fixed cohort multipliers, no weighted comparability formulas.**

### 8.2 Shared market research versus athlete research

These are separate and stay separate.

- **Shared market research** creates and maintains the approved Benchmark Registry.
- **Athlete-specific research** researches the individual being priced.

A Rate evaluation consumes: *approved versioned benchmarks + the exact MIA assessment + Nomila-known athlete evidence + connected social data where available + fresh athlete-specific grounded research*.

**Market evidence researched during an evaluation is used and recorded for that evaluation, and does not automatically become shared reusable evidence.** If research surfaces a transaction valuable to a shared registry, it may later enter a candidate/verification process — it does **not** become a shared benchmark by having been used once.

> **Amended 2026-09-18 (`rate-eval-spec/1.1.0`).** This previously read *"General market benchmarks are never rebuilt during an athlete evaluation."* That prohibition made a pre-approved registry a precondition for any market anchor. The benchmark discovery spike (`docs/audits/rate-benchmark-evidence-landscape.md`) found that public evidence is heterogeneous, single-sourced and rarely states rights — so pre-curating it into an approved registry would add substantial machinery before we know it improves Rate quality. The concern the sentence protected was real and survives in the retained half: per-athlete research must not silently redefine the shared market.

### 8.3 Seeding the registry

Bounded: **grounded research → structured candidate evidence → verification → approved versioned registry.**

Research broadly across defensible sources — disclosed transactions, accepted marketplace deals, marketplace asks, reported deals, brand budget information, industry surveys, agency guidance, modelled benchmarks. **Preserve the evidence method; do not collapse everything into equivalent "market rate" observations.**

Candidates preserve source and citation, date, amount or range, activity and platform, relevant terms, athlete and cohort context, geography, evidence method, verification status and confidence.

For Beta.1 the initial evidence is **inspected and verified before activation**. This is not a permanent requirement that a human approve every future item — verification becomes increasingly automated as failure patterns are observed.

### 8.4 Versioning and refresh

Benchmark sets are **immutable and versioned**; exactly one version of each is active for new evaluations. Default review cadence **every 90 days**, with event-driven refresh where material new evidence warrants it. A review need not change values if evidence does not support a change. Historical estimates retain the exact benchmark version that produced them. New evidence passes the research and verification process before activation.

---

## 9. The evaluator call

**One call per athlete**, covering all applicable rate type and platform combinations, producing **multiple individually persisted estimates**.

The reason is coherence: the evaluator should understand the athlete's commercial profile across the whole rate card, and an annual partnership figure that contradicts the per-post rate is a defect a per-type call cannot see.

The trade is accepted deliberately: a malformed or failed whole-card evaluation fails together. **No partial-recovery architecture** is built unless real failures demonstrate the need.

**Annual Brand Partnership remains independently reasoned**, never mechanically derived from the atomic rates.

### 9.1 Rubric instructions — FROZEN

> **Status: frozen 2026-09-17**, block by block, across seven reviews. Written from principles and benchmark
> structure, **without reference rate numbers in view**, so the cohort validation (§15) remains an uncontaminated
> behavioural test.
>
> Changing any block requires a version bump and a shadow comparison, on the same terms as the M.I.A. Beta.1 freeze
> (`docs/architecture/beta1-learning-log.md` §1). Correcting the *software* that delivers the rubric is maintenance;
> changing what the rubric *says* is a new version.

**The principle that governed every block:**

> **Structured output is not deterministic reasoning.** We may require the evaluator to expose intermediate
> judgments necessary for consistency, auditability and learning **without** prescribing a formula, threshold, fixed
> weighting or lookup process.

Each block was accepted only after passing five tests: is the instruction clear; is the resulting judgment auditable;
does it preserve **price dispersion** as distinct from **knowledge uncertainty**; does it constrain unsupported
judgment; and does it push the evaluator toward deterministic behaviour.

Two invariants were promoted out of Rate because they are not Rate-specific:

- **Measurement validity.** *Zero measured activity is not measured zero performance. A metric is evidence only where
  its measurement conditions make the value meaningful.* Now **P-8** in
  `docs/architecture/intelligence-architecture-principles.md`; it already caught the YouTube retention defect in MIA
  (`features.ts` v3) and applies to story efficiency, campaign performance and every future metric with a denominator.
- **Preserve disagreement.** Where material evidence sources disagree, reason about the disagreement rather than
  silently preferring one or averaging them away. Stated first for the two anchors in Block 1, then reused in
  Blocks 2, 5 and 7.

---

#### Standing instruction

> You are estimating what this athlete should reasonably charge for each commercial activity listed, at its stated
> terms basis. You are given evidence about this athlete and a marketability assessment, and where reusable market
> benchmark evidence exists you are given that too. **Research current market pricing evidence for each activity**, and
> judge for yourself whether what you find is credible and comparable enough to anchor an estimate.
>
> **Price each activity at its stated terms basis exactly.** Do not price additional usage rights, paid amplification,
> exclusivity, travel or bundling: those are priced downstream against an actual opportunity.
>
> **LOW, EXPECTED and HIGH are a commercial range, not an uncertainty interval.** EXPECTED is what this athlete should
> generally expect to command. LOW and HIGH are the defensible ends of their current pricing range under current market
> conditions.
>
> **Reason through six commercial questions**, weighing them as this activity warrants rather than uniformly. Then
> judge separately how well the evidence establishes the estimate.
>
> **Where evidence cannot support an estimate, return `NOT_ESTABLISHED` with no figures.** An honest refusal is more
> valuable than a fabricated range.
>
> **Never invent a transaction, a brand relationship or a benchmark.** If it is not in the supplied evidence or found
> in research with a retrievable source, it does not exist.

---

#### Block 1 · Market anchor and comparability

*What does the relevant market evidence imply for this activity, and where does this athlete sit relative to it?*

> Determine what the relevant market evidence implies for this commercial activity under the canonical terms basis.
> Consider market benchmark evidence — whether supplied to you or found in your own research — and, where available,
> the athlete's own sufficiently comparable commercial transactions.
>
> **Comparability is not determined by counting matching attributes.** Evaluate whether the differences between the
> evidence and the Rate being estimated are commercially material to price. Relevant differences may include activity
> and deliverable, platform and format, rights and usage, athlete market and competition level, audience
> characteristics, sport or category, geography, recognition and marketability, and recency.
>
> When treating evidence as sufficiently comparable, **explain why any meaningful differences do not materially
> undermine its pricing relevance.** Do not promote an ask, offer, bundle allocation, reported valuation or other
> non-equivalent evidence into a comparable observed transaction.
>
> Where sufficient credible and comparable market evidence exists, state the `benchmark_implied_range` and **cite the
> specific market evidence references that produce it** — each individually identifiable, and each resolvable to a
> source that supports the pricing proposition you attribute to it.
>
> **Credibility is your judgment to make and to show.** Market evidence is not admissible because it exists or because
> it is confidently stated. Assess what each source actually is and what it actually establishes, and say why the
> evidence you relied on is strong enough to anchor an estimate.
>
> Where sufficient athlete-own transaction evidence exists, separately state the `athlete_transaction_anchor`.
>
> Either, both or neither may be present. Identify which evidence source **primarily** anchors the final estimate. The
> presence of athlete-own transactions does not automatically make them the primary anchor.
>
> **Evidence authority and evidence relevance are separate.** Athlete-own transactions are authoritative evidence of
> what that athlete actually accepted. They are **not** automatically authoritative evidence of current market value.
> Approved market benchmarks provide external evidence of market pricing. When the two disagree materially, preserve
> the disagreement and reason about it rather than mechanically privileging either source.
>
> If athlete-own transactions materially anchor the estimate, do not assume prior accepted price equals current market
> value. Assess whether those transactions represent current pricing power or merely what the athlete previously
> accepted, considering evidence of demand, leverage, market context, repeat and renewal behaviour, pricing power, and
> changes in the athlete's commercial position.
>
> **Where the evidence indicates prior accepted prices understated the athlete's market position, the estimate should
> reflect the assessed position rather than the prior price.** Prior transactions constrain the estimate only to the
> extent they remain evidence of current market-clearing value.

**Why citation replaced sequence.** The draft said to state the benchmark range *before* positioning the athlete. In a
single call, output ordering does not constrain reasoning order — the model can settle on a price and back-fill a range
that justifies it, and we would never know. Requiring the range to **name the benchmark ids supporting it** makes a
back-filled range mechanically detectable against the registry, which the word "before" never could.

**The four anchor cases, and the audit each implies:**

| `benchmark_implied_range` | athlete evidence | outcome |
|---|---|---|
| absent | insufficient **direct and defensible indirect** | `NOT_ESTABLISHED` — absence is recorded, not an omission |
| absent | sufficient direct | `ESTABLISHED`, anchored on the athlete's own transactions |
| no sufficient direct anchor | sufficient defensible **indirect** (§5.1) | `ESTABLISHED`, `anchor_basis = INDIRECT_EVIDENCE` |
| present | — | `expected` inside the range → no departure rationale required |
| present | — | `expected` outside the range → **`departure_rationale` required** |

> **Reconciliation, 2026-09-17.** The first row originally read *"absent / insufficient"*, and the indirect row was
> missing entirely — which read as forbidding what §5.1 already authorises (*"where direct plus defensible indirect
> evidence still cannot support a rate, return `NOT_ESTABLISHED`"* implies that together they sometimes can). This
> records a case the frozen table failed to represent; it adds no pricing rule. Surfaced by the §9.3 assembly gate.
> Values in §9.4.

**No `anchor_disagreement` field.** Disagreement is fully derivable from the two ranges plus `anchor_basis` — adding a
flag would duplicate derivable state. The retrospective question it exists to answer (*when both anchors were present
and disagreed, which better anticipated subsequent accepted transactions?*) is answerable from what is already
persisted.

**Self-anchor stickiness is a conditional diagnostic.** An `ATHLETE_OWN_TRANSACTIONS` estimate staying close to prior
accepted prices is *correct* when the athlete's market value has not moved. The finding only means something where
there is **independent evidence that commercial position increased** — rising MIA, growing reach, inbound demand, or
subsequent deals closing above the estimate — and the estimate did not follow.

---

#### Block 2 · Distribution value

*What distribution and audience value can this athlete reasonably provide for this activity?*

> Assess the commercial value of the distribution the athlete can reasonably provide for this activity on the
> applicable platform.
>
> Consider the evidence most relevant to expected distribution and audience value, which may include reach, engagement
> quality, audience authenticity, audience composition and geography, platform strength, recent audience growth or
> decline, content consumption patterns, and the athlete's demonstrated performance on commercially relevant content.
>
> **Do not price from follower count alone.** Followers describe potential audience scale; they are not equivalent to
> expected impressions, reach, engagement or commercial impact.
>
> Prefer authoritative connected measurements where available **for the metrics they actually measure**. Where
> connected measurements are unavailable, use credible public evidence or research **without penalising the athlete
> merely for not having connected an account.**
>
> **An authoritative measurement is evidence about distribution only where there was activity to measure.** A connected
> account with no recent content provides no distribution evidence for that platform; it is not evidence of zero
> distribution.
>
> **Authority and recency are separate.** Prefer authoritative measurements, but weigh how recently they were observed;
> a stale authoritative measurement may be less informative than current credible public evidence.
>
> Distinguish **observed platform performance** from **inferred expected distribution.** Historical reach, engagement,
> views, retention or similar measurements are evidence; the distribution expected for a future commercial activity
> remains an evaluation unless directly established.
>
> Evaluate evidence in the context of the specific commercial activity. A metric is relevant only to the extent that it
> informs the distribution or audience value reasonably expected from that activity. Do not mechanically transfer
> performance across platforms, formats or content types when commercially material differences exist. Where evidence
> from another platform, format or content type is useful, it may inform the judgment as **indirect** evidence, but its
> limitations must remain explicit.
>
> **Absence of authoritative distribution data is uncertainty about distribution value, not evidence of low
> distribution value.** Conversely, authoritative evidence of weak distribution is evidence about value and may
> appropriately affect the Rate.
>
> **MIA and its dimensions are contextual athlete intelligence, not Rate conversion factors.** They may inform the
> judgment but must not be mechanically translated into price, nor used to overwrite more direct activity-specific
> distribution evidence. Where MIA context and direct activity evidence disagree, that disagreement is itself
> informative: preserve it and reason about it rather than silently preferring one.
>
> **Do not convert audience or engagement metrics into price** using a fixed CPM, follower multiplier, engagement
> multiplier, percentile lookup or other deterministic pricing formula. Distribution value is one part of the
> commercial Rate judgment, not an independently calculated price.

**Structured output.** `distribution_evidence` — **per claim**, not a free-text summary:

```
distribution_evidence:
  - metric
    value
    source_class: CONNECTED | PUBLIC | RESEARCHED | ATHLETE_ASSERTED | NOMILA_RECORD | MIA
    observed_or_inferred: OBSERVED | INFERRED
    observed_at
    evidence_refs
```

> **Reconciliation, 2026-09-17.** The list originally read `CONNECTED | PUBLIC | RESEARCHED | MIA`, which could not
> truthfully hold two sources the frozen rubric already authorises: an athlete-asserted distribution claim (*"my Reels
> get 50K views"*) is not `PUBLIC` merely because the evaluator can reason from it, and internal campaign history is
> not `CONNECTED`. Blocks 2, 3 and 4 now share one six-value vocabulary (§9.4). Surfaced by the §9.3 assembly gate.

Per-claim structure is what makes test 4 enforceable. A free-text summary can still say *"strong engagement"* without
our knowing whether that rested on connected Reel reach, a public follower count, a MIA dimension or something
researched. No `distribution_value_score`, no `expected_impressions`, no dollar-valued distribution component — those
create false precision or begin decomposing Rate into weighted sub-prices.

---

#### Block 3 · Athlete and identity premium

*Why might a brand rationally pay more — or less — for this athlete than for another offering comparable distribution?*

> Assess the athlete-specific commercial value that is **not explained by distribution alone.**
>
> Consider evidence relevant to why a brand may value association with this particular athlete, including athletic
> authority and achievement, recognition, cultural relevance, narrative distinctiveness and authenticity, credibility,
> scarcity, momentum, audience affinity, and other demonstrated sources of athlete-specific commercial value.
>
> This is an assessment of **commercial association value, not fame for its own sake.** A characteristic matters only
> where there is a defensible connection between that characteristic and why a commercial buyer may value association
> with the athlete.
>
> Do not assume that greater athletic achievement, fame, cultural relevance or narrative strength automatically
> produces a proportional pricing premium. Evaluate how the evidence bears on the commercial activity being priced.
>
> **Distinguish evidence that the athlete possesses an attribute from evidence that the attribute has commercial
> relevance.** An unusual personal story may be strongly established without necessarily increasing the value of every
> commercial activity.
>
> Athlete identity may create value even where distribution is modest. Conversely, large distribution does not by
> itself establish an athlete-specific identity premium.
>
> **Do not create commercial value merely by constructing a persuasive narrative from biographical facts. Narrative
> coherence is not evidence of buyer demand.**
>
> **Identity factors may reduce commercial value as well as increase it.** Assess evidence of controversy,
> brand-safety exposure, category conflict, reputational risk or other constraints on commercial demand using the same
> standard applied to positive attributes. Where an identity factor's commercial effect depends on the buyer or
> category, **state that dependence rather than averaging it into a single undifferentiated adjustment.**
>
> **Absence of demonstrated commercial response to an identity attribute is not evidence that the attribute has zero
> commercial value**; it limits what can be claimed about its demonstrated contribution.
>
> MIA and its dimensions may inform this judgment as structured athlete intelligence, but they are **not pricing
> multipliers.** Do not translate MIA, Athletic Authority, Cultural Relevance, Narrative Power, Brand Fit, Momentum or
> any other dimension mechanically into dollars or percentage premiums.
>
> Where direct commercial evidence indicates that buyers value a particular athlete attribute — repeated demand,
> premium brand interest, selection despite lower distribution, or comparable evidence — preserve that evidence as
> **distinct from the underlying identity attribute itself.**
>
> Where the commercial relevance of an identity attribute is **inferred** rather than observed, identify that inference
> and its evidence basis. Do not present inferred commercial value as demonstrated buyer behaviour.

**Structured output.**

```
identity_value_evidence:
  - attribute
    evidence
    source_class
    commercial_relevance: OBSERVED | INFERRED
    evidence_refs
```

`OBSERVED` means we have evidence of **commercial relevance for this athlete** — not that the dollar contribution of
the attribute was measured. Category-level or general-market evidence that brands pay for an attribute is `INFERRED`,
not `OBSERVED`, unless we have evidence of the commercial effect for this athlete specifically.

No `identity_premium_amount` and no `identity_premium_percent` — either would imply that the total Rate decomposes
neatly into a distribution price plus an identity markup, which we do not know to be true.

**On double-counting.** MIA already encodes athletic authority, cultural relevance and narrative power, and Rate may
research the same facts again. No separate deduplication rule is imposed: **the no-additive-decomposition architecture
already prevents the same World Cup appearance from being counted three times merely because it informs three lenses.**
A rule is warranted only if testing reveals qualitative overemphasis.

---

#### Block 4 · Activity fit

*Why is this athlete particularly well — or poorly — suited to delivering this specific commercial activity?*

> Assess the athlete's demonstrated or reasonably supported ability to create value through the **specific commercial
> activity being priced.**
>
> Consider evidence relevant to successful execution of that activity, which may include demonstrated content creation
> ability, performance in the applicable format or platform, camera or live presence, speaking ability, audience
> response to similar activity, credibility in the relevant context, prior execution of comparable commercial work, and
> other activity-specific evidence.
>
> **Activity fit is distinct from general athlete marketability.** A highly marketable athlete may be poorly suited to
> a particular activity, while an athlete with lower overall marketability may have unusually strong value for a
> specific activity.
>
> Prefer evidence of actual comparable execution where available. Evidence from related activities may inform the
> judgment where the relationship is commercially defensible, but preserve it as **indirect** evidence and explain the
> relevant differences.
>
> **Do not infer ability merely from opportunity.** Being invited to an event, appearing in media, having a large
> following, signing a sponsorship or being offered a deliverable does not establish that the athlete executes that
> activity effectively.
>
> **Likewise, absence of prior execution does not establish poor activity fit.** Where the athlete has not previously
> performed the activity, distinguish lack of evidence from evidence of weak performance.
>
> Consider negative evidence where it is meaningful: repeated weak performance in comparable activity, poor audience
> response, demonstrated difficulty with the format or other credible evidence may reduce assessed activity fit. Apply
> the measurement-validity principle — a zero or weak metric is evidence only where sufficient relevant activity
> occurred for the measurement to be meaningful.
>
> **The weight of performance evidence depends on how much relevant activity was observed.** A single instance is weak
> evidence in either direction; consistency across multiple instances is what makes performance evidence strong.
>
> **Repeat engagement by the same buyer is evidence relevant to activity fit**, because the buyer had prior experience
> with the athlete and chose to transact again. **It does not by itself establish that the specific activity performed
> well, or why the buyer returned.** Distinguish repeated engagement by one buyer from a similar number of unrelated
> one-off engagements.
>
> **Do not infer activity capability or incapability from demographic characteristics, athlete status, fame, sport or
> broad identity labels** when direct or relevant behavioural evidence is absent.
>
> **Evaluate activity fit independently for each Rate type.** Do not propagate a strong or weak activity-fit judgment
> across commercially different activities without evidence supporting that transfer.
>
> Do not translate activity fit into a fixed multiplier, percentage premium or discount, or component dollar value. It
> informs the overall Rate judgment.

**Structured output.**

```
activity_fit_evidence:
  - capability_or_result
    evidence
    source_class
    evidence_kind: DEMONSTRATED_EXECUTION | OBSERVED_PERFORMANCE | SUPPORTED_CAPABILITY | INDIRECT
    evidence_refs
```

- `DEMONSTRATED_EXECUTION` — the athlete actually performed the comparable activity
- `OBSERVED_PERFORMANCE` — we have meaningful evidence about how that activity performed
- `SUPPORTED_CAPABILITY` — credible evidence suggests capability despite no comparable execution or performance
- `INDIRECT` — related activity informs the judgment but is not equivalent

These are **evidence classifications, not scores.** The separation matters because an athlete may be excellent on
camera and have never done a paid brand Reel, while a brand may repeatedly hire an athlete for Reels without that
proving the Reels performed well.

**Why per-type independence is stated explicitly.** The single evaluator call was chosen so that an annual partnership
figure cannot contradict the per-post rate — **not** so that every activity inherits one verdict. One-call coherence
must not become cross-activity homogenisation.

---
#### Block 5 · Commercial proof and demand

*What has the market actually demonstrated about willingness to pay for, hire, retain or pursue this athlete?*

> Assess evidence of demonstrated commercial demand for the athlete, including accepted agreements, completed
> commercial relationships, repeat engagements and renewals, inbound demand, offers and negotiations, prior pricing,
> brand quality, demonstrated pricing power, and other credible evidence of buyer behaviour.
>
> **Preserve the commercial status of every piece of evidence.** Different stages establish different facts:
>
> - a conversation establishes **interest**, not an offer
> - an offer establishes **proposed willingness to transact at stated terms**, not accepted market value
> - an athlete ask establishes **what was requested**, not what a buyer would pay
> - an accepted or agreed transaction establishes **willingness of the parties to transact at the agreed economics and
>   terms**
> - completion establishes **fulfilment at the Deal level**, but does not by itself establish campaign performance
> - repeat engagement or renewal establishes that **a buyer chose to transact again**, but does not by itself prove why
>
> **A detected opportunity records that a brand made contact and that Nomila classified the contact as commercial.** It
> is not evidence that a genuine opportunity existed, that terms were proposed, or that the buyer would transact.
> **Volume of detected opportunities is not evidence of demand.**
>
> For Nomila's own commercial records, **use the canonical Deals status and underlying evidence. Do not reinterpret or
> promote internal Deal status from prose.** For researched external evidence, classify what the source actually
> establishes and apply the same status-promotion discipline.
>
> **Do not promote evidence into a stronger commercial state than the source supports.** Seeding is not a paid
> partnership; conversation is not offer; offer is not accepted transaction; appearance is not ambassador relationship;
> ask is not transaction; reported valuation is not earnings; package economics are not atomic activity economics.
>
> Consider both the amount **and** the terms and context of commercial evidence. A higher observed dollar amount is not
> necessarily stronger evidence for the Rate being estimated when the activity, bundle, rights, duration, geography,
> platform, exclusivity, product compensation or other commercially material terms differ.
>
> **Where commercial evidence is wholly or partly product or in-kind compensation, treat the stated value as weak
> evidence of cash pricing.** In-kind value is commonly stated at retail, which may differ materially from both the
> buyer's cost and the athlete's realised value.
>
> **Commercial evidence ages faster than benchmark evidence**, because an athlete's commercial position moves faster
> than a market's. A deal from an earlier career stage is weak evidence of current pricing even where the activity
> matches exactly.
>
> **Repeat engagement by the same buyer is distinct from multiple unrelated transactions.** It can provide evidence of
> sustained buyer preference after prior experience, while multiple independent buyers can provide evidence of breadth
> of demand. Preserve that distinction rather than reducing both to deal count.
>
> Evaluate evidence of **pricing power** where supported — accepted increases in price, buyers transacting despite
> higher asks, repeated demand under improved economics, or other observed behaviour. Do not infer pricing power merely
> from fame, MIA, an athlete asking for more, or an unaccepted counteroffer.
>
> **Negative commercial evidence may also matter.** Repeated failed negotiations, declining buyer interest, loss of
> renewals or other credible behaviour can inform demand where the evidence supports that interpretation. Do not treat
> a single declined offer or unsuccessful negotiation as proof that the athlete's Rate is too high or demand is weak;
> the reason may be budget, fit, timing, terms, category conflict or another factor.
>
> **Separate observed buyer behaviour from inferred motive.** Do not infer *why* a buyer offered, accepted, renewed,
> declined or ended a relationship unless evidence supports the reason.
>
> **Assess evidence of demand separately from evidence of realised pricing.** High demand does not establish a
> particular Rate, and historically low accepted prices do not establish weak demand. Preserve disagreement between
> these signals and reason about it rather than forcing them into a single conclusion.
>
> Where evidence is sparse, preserve that as **limited knowledge.** Lack of recorded deals is not evidence of lack of
> demand unless the evidence establishes that relevant commercial opportunities existed and buyers repeatedly declined
> to transact.
>
> Commercial proof informs the Rate judgment but is **not a deterministic price history.** Do not mechanically average
> prior deals, anchor to the latest transaction, multiply by deal frequency, or convert counts, brand names, MIA or
> negotiation events into a fixed pricing adjustment.

**Structured output.** Stricter here than elsewhere, because status promotion is the most consequential failure mode in
this block:

```
commercial_evidence:
  - evidence_ref
    evidence_method
    commercial_state
    amount_or_range: nullable
    activity_context
    buyer: nullable
    observed_at
    relevance: DIRECT | INDIRECT
```

For internal Deals, `commercial_state` **comes from canonical Deals data**. For external evidence it is the evaluator's
evidence classification — never a mutation of Deals. No `commercial_proof_score`, no `demand_score`, no deal-count
threshold, no brand-quality tier, no pricing-power multiplier.

**Why `detected` earns its own sentence.** It is 257 of 276 deals on dev — the dominant state of Nomila's commercial
data by an order of magnitude — and a `detected` deal is an unreviewed inbox extraction that may be mass outreach, a
gifting request, a misclassification or spam. Highest volume and weakest evidence is a dangerous combination, and the
audit's §17 mapping stating it is not enough: the **rubric** has to say it.

---

#### Block 6 · Pricing leverage and constraints

*What current circumstances affect this athlete's ability to command or sustain the Rate, beyond the market anchor,
distribution, identity, activity fit and demonstrated demand?*

> Assess current evidence that materially affects the athlete's **bargaining position** or the **scarcity and
> availability of their commercial inventory.**
>
> Relevant evidence may include scarcity of athlete availability, competing commercial demand, season or event timing,
> recent or upcoming athletic moments, limited inventory, category saturation, existing commitments, category
> conflicts, exclusivity restrictions, geographic or scheduling constraints, opportunity cost, and other evidenced
> circumstances that affect the athlete's ability to command or sustain a price.
>
> Treat leverage and constraints as **current commercial conditions, not generic athlete attributes.** A factor matters
> only where there is a defensible connection between that condition and the commercial activity being priced.
>
> **Distinguish observed constraints from inferred constraints.** An existing exclusivity clause, documented schedule
> conflict, known inventory commitment or competing accepted opportunity is observed evidence. Statements such as
> *"elite athletes are busy"*, *"championship athletes are scarce"* or *"this athlete probably has limited
> availability"* are not evidence of this athlete's current commercial constraints.
>
> **Similarly, distinguish observed leverage from inferred leverage.** Multiple genuine buyers pursuing limited
> available inventory, documented competing opportunities, demonstrated ability to improve accepted economics or other
> buyer behaviour may support leverage. Fame, MIA, follower count or athletic success alone does not establish
> bargaining leverage.
>
> **Do not manufacture scarcity from prestige.** Scarcity must describe an evidenced limitation on **commercially
> relevant** supply, or an evidenced imbalance between demand and available supply. A count of how few people hold a
> position, a title or a roster place is not by itself evidence of commercially relevant scarcity.
>
> **Distinguish transient conditions from sustained changes in commercial position.** A sustained change — turning
> professional, a major honour, a step change in demand — is evidence about the athlete's general Rate. A transient
> condition — a specific event week, a short-term scheduling conflict, an imminent deadline — affects a particular
> opportunity and belongs to Deal Intelligence rather than the standing Rate.
>
> Consider both positive and negative effects. Scarcity or competing demand may strengthen pricing power; oversupply of
> commercial inventory, category saturation, existing obligations, restricted rights or other constraints may limit the
> set of commercially available opportunities or affect what the athlete can command.
>
> **A constraint on whether an opportunity can occur is not automatically a constraint on price.** Distinguish factors
> that affect eligibility, availability or buyer set from factors that provide evidence about the price the athlete can
> command when the activity is commercially available.
>
> **Eligibility constraints affect the Rate only through evidenced reduction in competition for the athlete's available
> inventory, never by assumption.** Where a constraint removes particular buyers without materially reducing
> competition, preserve it as conditional for Deal Intelligence.
>
> **Do not price a hypothetical buyer-specific conflict into the generic Rate.** Where a constraint applies only to
> particular buyers, categories, territories, dates or deal structures, preserve that conditionality for Deal
> Intelligence rather than averaging it into the athlete's general Rate.
>
> **Opportunity cost must be real, not hypothetical.** Do not infer opportunity cost merely because the athlete could
> theoretically spend time elsewhere. Treat opportunity cost as commercially relevant where evidence shows competing
> uses of limited inventory, time, rights or category capacity that bear on the activity being priced.
>
> Do not convert leverage or constraints into fixed premiums, discounts, scarcity multipliers, seasonality adjustments
> or other deterministic pricing rules. Explain how the evidenced condition bears on the Rate judgment without
> assigning a formulaic adjustment.

**Structured output.**

```
leverage_constraint_evidence:
  - factor
    evidence_ref
    evidence_status: OBSERVED | INFERRED
    effect_scope: GENERAL | ACTIVITY_SPECIFIC | CONDITIONAL
    commercial_relevance
```

**`effect_direction` was deliberately removed.** A `SUPPORTS` / `CONSTRAINS` / `LIMITS_AVAILABILITY` enum per item
invites the evaluator to treat the block as a plus-minus adjustment list, and would have been the first field to harden
into weights. `commercial_relevance` carries what the condition means instead, which keeps the evaluator reasoning
about commercial consequences rather than tallying adjustments.

**Interaction with Block 3.** Category conflict appears in both blocks — as a negative identity factor and as an
availability constraint. The no-additive-decomposition architecture prevents the two from compounding, and both blocks
give the same instruction: state the buyer- or category-dependence rather than averaging it into the generic Rate.

---

#### Block 7 · How much do we know? (confidence)

*Separate from every block above: how well does the evidence establish this estimate?*

> **Confidence is a judgment about the quality and sufficiency of evidence supporting the Rate estimate.** It is not a
> judgment about the athlete's commercial value and it does not determine the width of the commercial price range.
>
> - The **Rate range** represents **price dispersion**: the plausible range of prices at which the athlete could
>   transact under the canonical terms basis.
> - **Confidence** represents **knowledge uncertainty**: how well Nomila knows that the estimated range and expected
>   Rate are correct.
>
> **Do not widen the Rate range because evidence is weak. Do not narrow it because evidence is strong.**
>
> **Uncertainty must not move the expected Rate toward the market anchor.** Where the evidence supports a position
> above or below the anchor, hold that position and express the uncertainty as confidence. Proximity to the anchor must
> be something the evidence supports, not a consequence of knowing less.
>
> Evaluate confidence separately for each Rate estimate as `HIGH | MEDIUM | LOW`.
>
> Consider the evidence actually supporting that estimate, including benchmark availability and comparability, direct
> athlete transaction evidence, authority and recency of social and distribution measurements, commercial evidence
> quality, activity-specific evidence, consistency or disagreement among material evidence sources, and important
> missing information.
>
> **Confidence must reflect whether the evidence is informative, not merely whether data exists.** Connected but stale
> data, measurements with no underlying activity, unverified detected opportunities, weak analogies, asks rather than
> transactions, or numerous repetitions of the same underlying fact do not become strong evidence through availability
> or volume.
>
> **Evidence quantity alone does not establish confidence.** A small amount of highly relevant, authoritative evidence
> may support greater confidence than a large amount of weak, stale, indirect or duplicative evidence.
>
> **Consumed model outputs carry their own uncertainty and are not measurements**, regardless of the precision with
> which they are stated.
>
> **Where material evidence sources disagree, preserve the disagreement.** Assess whether the conflict can be
> reasonably understood from differences in timing, terms, activity, measurement conditions or commercial context. **Do
> not manufacture consensus merely to increase confidence.**
>
> **Missing evidence should lower confidence only to the extent that the missing information is material to the
> particular Rate estimate.** Do not penalise an athlete simply because every possible data source is not available.
>
> **Confidence is confidence in the Rate estimate, not confidence that each underlying factual claim is true.**
> Individual evidence retains its own provenance and status.
>
> **Uncertainty arising from evidence common to all of the athlete's estimates** — positioning, distribution,
> commercial evidence — **should be assessed consistently across them.** Confidence may differ between estimates where
> the estimate-specific evidence differs: benchmark availability and comparability for that activity, and
> activity-specific evidence.
>
> `HIGH`, `MEDIUM` and `LOW` are **qualitative evaluator judgments.** Do not derive them from a numeric confidence
> score, a count of evidence items, a percentage of fields present, a fixed threshold or a deterministic formula.

**Structured output.**

```
confidence: HIGH | MEDIUM | LOW
confidence_rationale:
  principal_uncertainties:          # multiple may apply; diagnostic labels, never formula inputs
    - BENCHMARK
    - ATHLETE_POSITIONING
    - DISTRIBUTION
    - ACTIVITY_FIT
    - COMMERCIAL_EVIDENCE
    - OTHER                         # the rationale must say what OTHER was
  important_missing_data
  rationale
```

**Why the labels exist.** They are the second learning axis. If Rate misses cluster on `BENCHMARK`, the fix is
benchmark research; if they cluster on `ATHLETE_POSITIONING`, the fix is the rubric. `BENCHMARK` concentrated on one
activity is a research gap; `BENCHMARK` everywhere is a benchmark-basis problem. And if connecting social moves
`DISTRIBUTION` uncertainty **without** materially changing Rate, that is evidence the progressive-evidence
architecture is behaving as designed. If `OTHER` becomes common, the label set is wrong — which we can only discover if
each use is legible.

**Why the anchor-retreat prohibition was added.** The range is not where uncertainty naturally escapes. When an
evaluator is unsure, the fluent behaviour is not to widen but to **retreat to the anchor** — positioning gets pulled
toward the benchmark midpoint, range width stays reasonable, and the uncertainty has silently entered the expected
Rate. MIA Beta.1 documents exactly this mechanism: `priors-v1` sets every unevidenced signal to 50, and the
counterfactual moved 15 athletes by a mean of ±10.9 **in both directions** — −48 for one, +63 for another
(`beta1-learning-log.md` OBS-4). Missing evidence did not inflate or deflate; it compressed toward the middle. Without
this sentence, Block 7's separation would hold on paper and fail in the numbers, invisibly, because range width is what
we would be watching.

**Why consumed model outputs are called out.** Rate consumes MIA, MIA Beta.1 emits `confidence: null` (the invented
70/40 band was removed rather than kept), and OBS-3 measured 45 points of run-to-run movement on identical evidence —
mean absolute movement 15.3 for evidence-rich athletes and 29.1 for evidence-poor. The evaluator receives `782` and has
no way to know it could have been `740`. The real fix is upstream, in what we hand the evaluator; the rubric's job is
only to stop it reading a bare number as a measurement.

**This is validated behaviourally, not prescribed.** See §15.1. If the behaviour fails, we fix the rubric — we do not add
a range-width formula.

### 9.2 Required output, per rate estimate

Derived from the frozen blocks. Every structured field exists to make a judgment **auditable**, never to be summed,
weighted or thresholded — see the governing principle in §9.1.

| field | | block |
|---|---|---|
| `status` | `ESTABLISHED` · `NOT_ESTABLISHED` | — |
| `low` / `expected` / `high` | USD; omitted when `NOT_ESTABLISHED` | — |
| `benchmark_implied_range` | nullable; **must cite the market evidence references producing it** | 1 |
| `athlete_transaction_anchor` | nullable; independently of the above | 1 |
| `anchor_basis` | which source **primarily** anchored the estimate | 1 |
| `departure_rationale` | **required** where `expected` falls outside a present `benchmark_implied_range` | 1 |
| `distribution_evidence[]` | metric · value · `source_class` · `observed_or_inferred` · `observed_at` · refs | 2 |
| `identity_value_evidence[]` | attribute · evidence · `source_class` · `commercial_relevance` · refs | 3 |
| `activity_fit_evidence[]` | capability or result · evidence · `source_class` · `evidence_kind` · refs | 4 |
| `commercial_evidence[]` | ref · `evidence_method` · `commercial_state` · amount · activity · buyer · `observed_at` · `relevance` | 5 |
| `leverage_constraint_evidence[]` | factor · ref · `evidence_status` · `effect_scope` · `commercial_relevance` | 6 |
| `confidence` | `HIGH` · `MEDIUM` · `LOW` | 7 |
| `confidence_rationale` | `principal_uncertainties[]` · `important_missing_data` · `rationale` | 7 |
| `rationale` | concise prose, generated *with* the judgment (P-6), never written afterwards from the numbers | — |

**The mechanically checkable invariants**, available without a second model call:

1. `expected` outside a present `benchmark_implied_range` ⇒ `departure_rationale` present
2. every `benchmark_implied_range` cites references that **resolve** — a registry id that exists, or a retrievable
   source carrying the claim — and that **support the pricing proposition attributed to them**. Resolution is
   mechanical; whether the source supports the proposition may need a second judgment. The fetched source and extract
   are preserved either way, so a failure is auditable
3. every `commercial_evidence` entry sourced from internal Deals carries a `commercial_state` permitted by §9.4's
   mapping for its `deals.status` — a permitted-value check, **not** a strength ordering between two different
   vocabularies, which would be exactly the deterministic status ladder the rubric refuses
4. `confidence` is present on every `ESTABLISHED` estimate, and no numeric confidence appears anywhere
5. `principal_uncertainties` containing `OTHER` ⇒ the rationale says what it was

**Fields deliberately absent**, each rejected during a block review: `distribution_value_score`,
`expected_impressions`, `identity_premium_amount`, `identity_premium_percent`, `commercial_proof_score`,
`demand_score`, `effect_direction`, `anchor_disagreement`, and any numeric confidence. Adding any of them is a
methodology change, not a schema change.

---

### 9.3 Spec identity, the basis manifest, and drift detection

**Evaluator-spec version and terms-basis versions are independent version axes.** The prompt embeds both the reasoning rubric and the terms bases, so its text changes when either moves — but they answer different questions and must not be collapsed into one version.

The canonical prompt artifact carries a manifest:

```
evaluator_spec: rate-eval-spec/1.0.0

embedded_terms_bases:
  social:      social/1.0.0
  ugc:         ugc/1.0.0
  appearance:  appearance/1.0.0
  virtual:     virtual/1.0.0
  annual:      annual/1.0.0
  autograph:   autograph/1.0.0
  clinic:      clinic/1.0.0

prompt_digest: <computed from the exact canonical prompt text>
```

**A basis moving does not bump the evaluator spec.** A future artifact may still implement `rate-eval-spec/1.0.0` while its manifest records `ugc/1.1.0`; its `prompt_digest` changes naturally, because the text did. Bumping the spec for a basis change would recreate exactly the coupling the two axes exist to prevent — a commercial-quantity update masquerading as a methodology change, and therefore attracting the wrong review.

**This makes provenance diagnostic rather than merely detectable:**

| what moved | what it means |
|---|---|
| `evaluator_spec` | the reasoning methodology changed — a frozen-rubric change, §9.1 freeze terms apply |
| a `terms_bases` entry | the commercial quantity changed — an ordinary versioned basis update |
| **`prompt_digest` alone, with neither of the above** | **unauthorised prompt drift — this fails CI** |

The third row is the one that earns the manifest. Without it, a hand-edit to the prompt text is indistinguishable from an authorised change, and the digest is a change alarm rather than a control.

**Parity tests assert the three layers independently.** A digest-only test would be a green check that verifies nothing about the design, and would fail uninformatively — *"expected `abc123`, got `def456`"* tells whoever broke it nothing about what they broke. The tests therefore assert, separately:

1. **Rubric parity** — the prompt states the seven reasoning blocks and their load-bearing invariants: the standing instruction and `NOT_ESTABLISHED`; LOW/EXPECTED/HIGH as a commercial range rather than an uncertainty interval; the confidence separation including the anchor-retreat prohibition; the five mechanically checkable invariants of §9.2; and the rejected-field list.
2. **Terms-basis parity** — all nine active families are present with the canonical terms of §7, and each manifest entry matches the basis version it claims. Licensing royalty is asserted **absent and deferred**.
3. **Digest** — the computed digest of the canonical prompt text matches the pinned value.

A failure then names the layer that moved instead of producing an unexplained hash mismatch.

**The prompt is executable source, not generated from this document.** Assembling the runtime prompt from Markdown would couple production behaviour to documentation formatting and heading structure. The canonical prompt file is source; the parity tests lock its substantive content to the frozen design, so drift is caught immediately in either direction. This is the pattern M.I.A. already uses for `blind-eval-spec/0.2.1`.

---

### 9.4 Output vocabularies — FROZEN

> Surfaced by the §9.3 assembly gate: translating the frozen design into an executable prompt exposed four output
> fields whose values had never been fixed. Each was decided on its own, and **none introduces a pricing rule,
> weighting or hierarchy** — they are the value sets the frozen blocks already presuppose.

**Naming convention, stated once so the difference is legible.** Evaluator classifications and judgments are
`SCREAMING_CASE`; durable database identity values are `snake_case`, matching every existing identity vocabulary in
this codebase (`deals.deal_type`, `deals.status`, `athlete_facts.source_class`). The two differ deliberately.

#### `commercial_state` — what the evidence establishes commercially

```
INTEREST | ASK | OFFER | AGREED | COMPLETED          nullable
```

| value | the evidence establishes |
|---|---|
| `INTEREST` | a prospective buyer made actual commercial contact or engagement concerning a potential relationship or activity. **Detection or classification of an inbound message does not establish INTEREST.** |
| `ASK` | the athlete or seller requested particular economics. Does not establish buyer willingness to pay. |
| `OFFER` | a buyer proposed particular economics. Does not establish acceptance. |
| `AGREED` | the parties agreed the stated economics and terms. Fulfilment not implied. |
| `COMPLETED` | the agreed activity was fulfilled. Campaign performance not implied. |
| **null** | the evidence is commercially relevant enough to retain but **does not establish that a buyer initiated or participated in a commercial interaction.** |

**`AGREED`, not `ACCEPTED`, deliberately.** `accepted` is a canonical Deals workflow status. `AGREED` names the
evidentiary proposition, so an external article reporting a signed deal cannot wear internal workflow clothing while
still recording the economically important fact.

**`REPEAT` is not a state.** Repeat engagement is a property of a buyer relationship **across** interactions, not a
stage of one — a second deal with the same brand is *also* `AGREED`. It is **derived** from `commercial_evidence[]`
entries sharing a `buyer`, never asserted, for the same reason `anchor_disagreement` was rejected in Block 1: derivable
state that is also asserted can disagree with itself. Blocks 4 and 5 both read repeat engagement, and both need it
alongside the transaction state rather than instead of it.

**`DETECTED` and `REJECTED` are not states.** `detected` is internal workflow. Rejection is an *outcome* of an ask,
offer or negotiation — not a price proposition — and collapsing it into a market-value state would do exactly what
Block 5 forbids.

**Internal Deals evidence carries both** the canonical `deal_status` and `commercial_state`; external evidence carries
only `commercial_state`. Authoritative status **constrains what may be claimed; it never manufactures evidence the
evaluator was not given**, so the mapping below is a ceiling rather than a requirement:

| `deals.status` | permitted `commercial_state` |
|---|---|
| `detected` | **null** — `INTEREST` only where the underlying evidence establishes commercial contact |
| `pending` | **null** |
| `negotiating` | `INTEREST`; `ASK` or `OFFER` only where the underlying evidence states the economics **and** who proposed them |
| `accepted` | `AGREED` permitted |
| `completed` | `COMPLETED` permitted |
| `rejected` | **null**, or `OFFER` where the evidence establishes the buyer proposed economics |

The `detected` row carries the most weight: 257 of 276 dev rows, defaulting to null. This is Block 5's *"volume of
detected opportunities is not evidence of demand"* made mechanical.

#### `evidence_method` — how Nomila came to know the evidence

```
OBSERVED | MARKETPLACE | REPORTED | SELF_REPORTED | SURVEY | MODELLED | EXPERT_GUIDANCE
```

**`evidence_method` describes how Nomila came to know the evidence. It does not describe what commercial proposition
the evidence establishes — `commercial_state` describes that, separately.**

| value | |
|---|---|
| `OBSERVED` | economics evidenced by a **first-party transactional record** available to Nomila — a contract, accepted agreement, invoice or payment record, or authoritative internal Deal evidence. **Not** "Nomila observed a webpage." |
| `MARKETPLACE` | a marketplace listing or platform record |
| `REPORTED` | media or third-party reporting |
| `SELF_REPORTED` | an **attributable statement by the athlete, brand, buyer or seller** — not a third party describing what they supposedly said |
| `SURVEY` | aggregated survey data |
| `MODELLED` | computed, formula-derived or estimated |
| `EXPERT_GUIDANCE` | practitioner judgment |

**This supersedes the earlier composite vocabulary** in `rate-beta1-plan.md`, which predates `commercial_state` and
bundled both axes into single labels. Since §9.2's `commercial_evidence[]` carries **both** fields, adopting those
verbatim would assert the same fact twice on fields that can contradict each other:

| superseded | replaced by |
|---|---|
| `OBSERVED_TRANSACTION` | `OBSERVED` + the appropriate `commercial_state` |
| `ACCEPTED_MARKETPLACE_DEAL` | `MARKETPLACE` + `AGREED` |
| `MARKETPLACE_ASK` | `MARKETPLACE` + `ASK` |
| `REPORTED_DEAL` | `REPORTED` + the appropriate `commercial_state` |
| `BRAND_BUDGET` | the method by which the budget was learned + **null** `commercial_state` |
| `SURVEY` · `MODELLED_BENCHMARK` · `EXPERT_GUIDANCE` | `SURVEY` · `MODELLED` · `EXPERT_GUIDANCE` |

`BRAND_BUDGET` is the clearest demonstration that decomposition is the right fix: learned from an authoritative brief
it is `OBSERVED`, from the brand directly `SELF_REPORTED`, from an article `REPORTED`. **It was never a method.**

**Method never establishes state.** A media article is `REPORTED` whether it reports interest, an offer or a signed
deal; the content determines `commercial_state`, the source does not. `MARKETPLACE` does not imply `ASK` or `AGREED`.
`REPORTED` + `AGREED` is valid only where the report actually says an agreement was reached.

**Semantic constraint, not a second taxonomy.** For athlete-specific `commercial_evidence[]`, the normal methods are
`OBSERVED | MARKETPLACE | REPORTED | SELF_REPORTED`. `SURVEY`, `MODELLED` and `EXPERT_GUIDANCE` describe market and
benchmark evidence. An athlete-specific entry carrying `MODELLED` + `AGREED` is **invalid, not merely weak** — a model
cannot establish that an agreement occurred.

#### `anchor_basis` — what evidentiary foundation supports the estimate

```
MARKET_BENCHMARK | ATHLETE_OWN_TRANSACTIONS | INDIRECT_EVIDENCE | NONE
```

| value | |
|---|---|
| `MARKET_BENCHMARK` | sufficiently **credible and comparable** market evidence is the primary anchor — supplied or researched at evaluation time |
| `ATHLETE_OWN_TRANSACTIONS` | the athlete's own sufficiently comparable transaction evidence is the primary anchor |
| `INDIRECT_EVIDENCE` | neither direct anchor supports the estimate sufficiently; an `ESTABLISHED` Rate rests primarily on explicitly identified, commercially defensible indirect evidence (§5.1) |
| `NONE` | no evidentiary anchor supports an estimate — valid **only** with `NOT_ESTABLISHED` |

**`anchor_basis` reports what primarily *supports* the estimate, not which fields are populated.** A weak direct
benchmark may exist while stronger defensible indirect evidence does the real work; that is `INDIRECT_EVIDENCE`.

Indirect evidence **never** becomes `benchmark_implied_range` or `athlete_transaction_anchor` — §5.1 forbids promoting
it into a direct benchmark — so it stays visibly indirect, and `INDIRECT_EVIDENCE` is how an estimate resting on
analogy says so instead of borrowing a direct anchor's label.

Two further mechanical invariants follow:

```
ESTABLISHED      ⇒ anchor_basis ≠ NONE
NOT_ESTABLISHED  ⇒ anchor_basis = NONE
anchor_basis = INDIRECT_EVIDENCE ⇒ the cited evidence is identified as indirect under §5.1
```

The cohort distribution of `anchor_basis` is a useful **benchmark-coverage diagnostic** — heavy `INDIRECT_EVIDENCE` on
a family means that family's benchmark set is thin. That is an **observability benefit, not methodology**: the
evaluator must not behave differently because of the distribution.

#### `source_class` — shared across Blocks 2, 3 and 4

```
CONNECTED | PUBLIC | RESEARCHED | ATHLETE_ASSERTED | NOMILA_RECORD | MIA
```

| value | |
|---|---|
| `CONNECTED` | authoritative connected/verified platform evidence |
| `PUBLIC` | public platform evidence not obtained through an authoritative connection |
| `RESEARCHED` | evidence obtained through web or grounded research |
| `ATHLETE_ASSERTED` | asserted by the athlete and not independently established by another source |
| `NOMILA_RECORD` | Nomila's internal structured record — Deals and commercial history |
| `MIA` | a referenced marketability assessment or its dimensions |

**One vocabulary across the three blocks.** Block 2's original four could not represent evidence the frozen rubric
already authorises: Block 4 cites *"prior execution of comparable commercial work"* (Deals), Block 3 cites *"repeated
demand, premium brand interest, selection despite lower distribution"* (also Deals), and both can rest on
athlete-asserted claims. Giving one field name three different meanings across sibling structures would be worse than
amending the list.

**Relationship to the platform vocabulary — documented, not merged**, so a later tidy-up cannot collapse provenance:

| Rate `source_class` | `athlete_facts` / platform concept |
|---|---|
| `CONNECTED` | `connected_verified` |
| `PUBLIC` | `platform_public` |
| `RESEARCHED` | `web_researched` |
| `ATHLETE_ASSERTED` | NULL `source_class` + athlete assertion/proof origin |
| `NOMILA_RECORD` | *no `athlete_facts` equivalent* |
| `MIA` | *no `athlete_facts` equivalent* |

**`MIA` does not violate R1.** `athlete_facts` excludes inferred and imputed values *for facts* by design. Rate's
`source_class` classifies **evidence consumed by an evaluation**, and does not assert that the evidence is a fact.
`source_class: MIA` must **never** upgrade an MIA-derived judgment into measured or factual evidence — which is Block
7's rule that consumed model outputs remain model outputs regardless of apparent precision.

**`ATHLETE_PROOF` is deliberately absent.** Where Nomila has verified documentary proof sufficiently to establish a
fact, the evidence enters through the appropriate verified representation. Where it has not, uploading proof must not
confer a stronger source class — that would have Rate inventing a second verification lifecycle.

---

## 10. Persistence

A Rate estimate is an **`ESTIMATE`** in `intelligence_ledger` — not an `ASSESSMENT`. Rate has a commensurable future
observation; MIA does not, and the type system already enforces the difference.

**Provenance class: `EVALUATED`.** The class follows *how the quantity was produced*, not whether it is numeric. A
suggested rate built from approved benchmarks, athlete evidence, connected social data, MIA context and commercial
evidence through the frozen rubric is an evidence-grounded judgment. `ASSUMED` remains available to Rate and narrows
to its proper meaning — an **explicit** assumption adopted where evidence is unavailable or the methodology requires
one. `ENGINE_EMITS.rates` was corrected accordingly (§18).

```
owner      "rates"
kind       ESTIMATE
unit       "usd"
subject    athlete
value      { rate_type, platform, terms_basis_version,
             low, expected, high, status, confidence,
             benchmarks_used, drivers, departure_rationale,
             important_missing, rationale }
versions   { methodology, evaluator, rubric, benchmarks, terms_basis }
inputs     [ ValueRef → MIA ledger entry (predictionId, material: true),
             ValueRef → benchmark set version ]
```

MIA is **referenced, not duplicated** — the ledger entry is immutable and has no cascade, so the reference gives durable access to the score and all eight dimensions. The scalar MIA value is copied into `value` only so a row is self-describing.

### 10.1 Persisted rationale

A **concise, structured, evidence-grounded decision record per estimate**: principal drivers, benchmarks used and their comparability basis, important athlete evidence, important missing evidence, the confidence reason, and any material-departure explanation.

Underlying evidence and provenance references are preserved separately. **Unrestricted model chain-of-thought is neither required nor persisted** — this is an audit record, not hidden reasoning.

---

## 11. Identity, idempotency and supersession

**Identity:** `(athlete_id, rate_type, platform, terms_basis_version)` — platform null where not applicable.

**The eleven allowed slots.** Beta.1 is an explicit allow-list, **not a `rate_type` × `platform` cross-product**. New
combinations require an explicit contract addition; **the evaluator cannot invent them.**

| `rate_type` | `platform` | terms basis |
|---|---|---|
| `social_feed_post` | `instagram` | `social/1.0.0` |
| `social_short_video` | `instagram` | `social/1.0.0` |
| `social_short_video` | `tiktok` | `social/1.0.0` |
| `social_short_video` | `youtube` | `social/1.0.0` |
| `social_story` | `instagram` | `social/1.0.0` |
| `ugc` | null | `ugc/1.0.0` |
| `appearance_in_person` | null | `appearance/1.0.0` |
| `appearance_virtual` | null | `virtual/1.0.0` |
| `annual_partnership` | null | `annual/1.0.0` |
| `autograph_session` | null | `autograph/1.0.0` |
| `camp_clinic` | null | `clinic/1.0.0` |

**`platform = null` is semantically meaningful**: this rate type has no platform dimension. It is therefore a
**contract requirement, not an implementation detail**, that:

> The Rate estimate identity uniqueness constraint MUST treat NULL `platform` values as equal (`NULLS NOT DISTINCT`
> semantics). For non-platform rate types, at most one estimate may exist for a given athlete, rate type and
> terms-basis version.

Postgres treats NULLs as **distinct** in a unique constraint by default, so without this the constraint would enforce
nothing for six of the nine families — two-thirds of the card — and every supersession guarantee below would rest on
an index that permits unlimited duplicates. Application-level idempotency is **not** a substitute: the invariant has to
hold under retries and concurrency. The codebase already uses `.nullsNotDistinct()` for exactly this reason on
`smo_identity_uq`, `sad_identity_uq` and `sf_feature_uq`.

**Rate's taxonomy is not required to match Deals'.** Rate needs Instagram Reel ≠ TikTok short video ≠ Instagram Story
because those are different commercial quantities; `deals.deal_type` has neither platform nor format distinction (the
Deals audit: *"one `social_post` covers Instagram, TikTok and YouTube alike"*). So an existing `social_post` Deal
**must not be silently mapped to one of the finer Rate identities** unless its underlying evidence establishes platform
and format — such a deal is `INDIRECT` or not comparable under the learning seam rather than a source of manufactured
specificity.

The direction of resolution is **Deals gaining structured deliverable detail**, never Rate being coarsened until it
matches today's Deals schema — which would destroy the platform-specific rate learning §6.1 exists for.

**Idempotency** covers everything that would change the answer: athlete evidence, the MIA entry consumed, the benchmark set version, the rate type and platform, the terms basis, and the rubric version. Same digest ⇒ same question ⇒ skip.

**Supersession is within an identity.** A new estimate supersedes the previous estimate for the same rate type, platform and terms basis, ordered on `evidenceAsOf` and never on completion time. Estimates for different rate types or platforms never supersede one another — they are different questions, simultaneously valid.

A **terms-basis change is a new identity**, not a supersession (§7.8).

---

## 12. Learning

### 12.1 Observed versus derived

Two classes, and the distinction is absolute:

- **OBSERVED** — what actually happened commercially.
- **DERIVED / EVALUATED** — what Nomila inferred through allocation, normalization or other reasoning.

**A derived allocation is never promoted into observed transaction truth.** No calibration-weight hierarchy is built —
no hop counting, no weighting by derivation distance. If real data later demonstrates the need, it is designed from
empirical evidence then.

### 12.2 Deals remains canonical

**No second deal system inside Rate.** Opportunities, lifecycle, offers, counters, economics, deliverables, rights,
accepted/declined/closed states and transaction outcomes live in Deals. Deal economics are **never duplicated** into a
Rate record.

**No parallel Rate lifecycle.** For Nomila's own commercial records the canonical `deals.status` is used **as recorded**
— the evaluator is never asked to re-infer Nomila's own deal lifecycle from prose. For **external, researched** claims
the evidence-classification and promotion guards apply: seeding ≠ paid partnership, conversation ≠ offer, ask ≠
transaction, reported valuation ≠ earnings, package value ≠ atomic activity value.

### 12.3 The learning seam

One append-only record, holding the temporal linkage and a conservative comparability judgment:

```
rate_estimate_id   the exact historical ESTIMATE that existed at the time
deal_id            the canonical Deals record
linked_at
comparability      DIRECT | INDIRECT | NOT_COMPARABLE
basis              evidence-grounded reason
```

It answers exactly one question: **what, if anything, does this real commercial outcome tell us about this particular
historical Rate estimate?** The property it buys is temporal — *this estimate existed before this outcome* — which is
what prevents hindsight contamination.

### 12.4 Comparability

**`DIRECT`** — the evidence is specific and economically attributable enough to the rate activity, platform and standard
terms to serve as a direct comparable outcome. **A high bar.** Example: an accepted deal clearly establishing $2,500 for
one Instagram Reel under sufficiently comparable terms.

**`INDIRECT`** — commercially informative, but not a direct observation of the atomic rate: a bundle with no defensible
allocation, materially different rights or terms, unclear platform or format, package economics, or other relevant but
non-equivalent evidence.

**`NOT_COMPARABLE`** — the relationship exists, but the evidence does not support a useful comparison to that estimate.

**Never infer specificity the deal evidence does not contain.** *"Social posts"* does not become *"Instagram Reel"*
without evidence. An optional appearance clause does not prove an appearance occurred. A package price does not become
the observed price of one component. **Unclear platform or format stays unclear.**

### 12.5 Agreed is evidence; fulfilment is a separate fact

**Fulfilment of every deliverable is not required before an agreed package provides useful evidence.** An accepted or
sufficiently supported agreement is evidence of what the parties agreed the relationship was worth.

Three distinct facts, never collapsed:

| | |
|---|---|
| **A** | what was agreed / contracted |
| **B** | what was actually delivered |
| **C** | what economic value can be attributed to a particular rate type |

A $75K annual partnership broadly covering social participation, appearances, shoots and travel may be **very useful
evidence for Annual Brand Partnership Value** even though the $75K cannot be allocated among its components. **Do not
manufacture that allocation.** Equally, an appearance being *contemplated* in a contract does not make the package a
direct Appearance Rate observation.

**Lifecycle strength is not comparability.** `accepted` or `completed` proves agreed commercial value, and `completed`
additionally evidences fulfilment at the deal level — but DIRECT comparability still depends on whether the evidence
supports attribution to the specific activity, platform and terms. So *accepted + unclear package* is potentially
valuable **INDIRECT** evidence, while *accepted + clearly attributable comparable activity* may be **DIRECT**.

### 12.6 Evidence improves progressively; nothing here blocks Beta.1

Rate learning **may begin now**, using existing deal, contract and email evidence wherever it is sufficiently
informative. Structured deliverables, platform and format, rights and exclusivity are **progressive improvements, not
prerequisites**:

```
existing deal / contract / email evidence
  → structured contract deliverables
    → observed fulfilled deliverables
      → performance and outcome evidence
```

Each rung improves comparability and attribution **without changing Rate methodology**.

Two explicit non-prerequisites:

- **Negotiation history extraction is deferred.** Economics are currently overwritten in place and the offer → counter →
  accepted sequence is not preserved. Beta.1 uses the best-supported accepted or agreed economics, with the underlying
  emails and contracts as supporting evidence. The richer sequence belongs to the Deals / Negotiation workstream, and
  Rate can consume it later without methodology change.
- **`deals.deal_type` is not exploded** into `instagram_reel`, `tiktok_video` and so on. A deal is a commercial
  *container* and may hold several activities. The data model must be able to say **UNKNOWN / UNSPECIFIED**, because
  real contracts say *"social posts"* and *"content support"*. Forcing precision would manufacture it.

### 12.7 Starting small, deliberately

Dev currently holds **six** accepted or completed transactions. That is not a reason to build a calibration engine, and
not a reason to wait.

The goal of Beta.1 is **not** to claim six transactions calibrate Rate. It is to ensure the 7th, 20th, 100th and
1,000th useful transaction arrive carrying a durable relationship to the Rate intelligence that preceded them.

So: create the seam, inspect what the existing transactions actually support, classify them conservatively, and
accumulate future outcomes correctly.

**Rate learning outputs, learned pricing parameters and Nomila-predicted rates/values never feed into M.I.A.**
(ADR-011); real commercial outcomes reach M.I.A. only as observations under M.I.A.'s evidence-admission contract (§5.4).

---

## 13. Triggers, history and deltas

**Recalculation is event-driven**, on material change to actual inputs: a new or updated MIA assessment; material authoritative social or athlete evidence change; relevant commercial or Deal evidence change; activation of a new benchmark version; manual refresh.

Closely occurring triggers are coalesced and debounced. **No routine nightly re-evaluation merely because time passed.** Because one call evaluates the coherent rate card, a trigger refreshes the athlete's applicable card together.

**A transient condition is not a trigger.** §9.1 Block 6 separates sustained changes in commercial position — turning professional, a major honour, a step change in demand — from transient conditions such as an event week, a short-term scheduling conflict or an imminent deadline. The former is evidence about the standing Rate and may trigger recalculation; the latter belongs to Deal Intelligence and must not. Without this line the "material change" test would fire on every seasonal shift, and the rate card would become a spot quote rather than a standing rate.

**Every successful evaluation is preserved immutably.** Deltas are computed deterministically from actual prior and current values. **No fixed material-change percentage threshold is part of the methodology** — whether a change warrants UI emphasis or a notification is separate product policy.

Change explanations are grounded in **actual evidence and input differences** between the two evaluations. The AI is never asked to invent a retrospective explanation from seeing two different prices.

---

## 14. The athlete-facing rate card

```
Instagram Reel

Suggested Rate    $2,500
Typical Range     $2,000–$3,200
Confidence        High

[ Why this rate? ]
```

EXPECTED is prominent; LOW–HIGH is secondary; confidence is separate. *Why this rate?* exposes concise meaningful drivers and important missing evidence.

**Not exposed in the primary UX:** ledger ids, benchmark version ids, raw provenance structures, internal evidence statuses. All remain internally and auditably available.

Where evidence is insufficient:

```
Licensing Royalty
Rate not established yet.
```

Never `$0`, a fake range or a placeholder. Actionable missing evidence may be shown — *"Connecting Instagram could improve this estimate"* — but **never implying that connecting increases value.**

---

## 15. Validation

**No synthetic golden rate targets. No hand-authored target-rate calibration exercise.**

**The existing athlete cohort** is used for broad public-evidence validation, observing behaviour across sports, levels, audience sizes, commercial maturity, evidence richness and marketability profiles.

**Mia Bhuta and Lilia Bhuta** are the deep real-athlete cases, because they can supply connected authoritative data and their real-world context can be checked. For them, compare **public-only versus connected authoritative evidence** — confirming that connection improves *knowledge* rather than mechanically increasing *value*.

**Independent real-world validation** is gathered where possible from athletes, agents and managers, NIL and commercial professionals, and brand-side participants — distinguishing carefully between *"what would you charge?"*, *"what were you offered?"* and *"what did you actually close?"*. These are different evidence classes.

### 15.1 The three behavioural tests of the range/confidence separation

The §9.1 Block 7 separation is validated by **observed behaviour**, never enforced by a formula. If any of these fails,
the fix is the rubric.

| | setup | expected behaviour |
|---|---|---|
| **A** | similar market dispersion, **different evidence quality** | similar range **widths**, different **confidence** |
| **B** | similar evidence quality, **different genuine price dispersion** | different range widths, **similar confidence** |
| **C** | **the same athlete**, public-only then connected | connected evidence improves the **evidence basis**, and confidence rises **where that evidence resolves material uncertainty**; range width does **not** systematically narrow; and the expected Rate does **not** systematically sit closer to the anchor in the low-evidence state |

**C is the decisive one**, and the cheapest. A and B are cross-athlete and therefore confounded by everything that
differs between athletes; C removes the confound entirely and tests the invariant directly — including the
anchor-retreat failure, which A and B cannot see. It doubles as the progressive-evidence check: connecting social
should move `DISTRIBUTION` uncertainty without materially moving Rate.

**C's confidence arm is conditional, so its failure condition has to be stated or the test proves nothing.** Connection
is not an epistemic bonus (§5.2, §9.1 Block 2), and a connected account carrying stale data or no recent activity may
correctly leave confidence unchanged — so *"confidence rose"* is not the pass condition and *"confidence held"* is not
the failure. Partition the connected cases by whether the connected evidence is **materially informative**:

- confidence rises where connection resolved material uncertainty → **passing**
- confidence holds where the connected data was stale, or covered no activity → **passing**
- confidence rises **uniformly on connection**, regardless of whether the data was informative → **failing**

The third is the connection bonus reappearing in the confidence axis, and it is the direct test of Block 7's
*"informative, not merely whether data exists."*

Mia Bhuta and Lilia Bhuta are the available C cases. Mia's YouTube — connected, authoritative, no recent content — is
already a known instance of the second row.

**The cohort is a behavioural validation set, not ground truth.** Where outputs look wrong, the diagnosis is a methodology or evidence failure — benchmark, research, evidence classification, rubric, terms basis. **No athlete-specific patches.** Any correction applies globally and is rerun.

Once behaviour is judged commercially credible: freeze the methodology and version, preserve the cohort outputs as the **Beta.1 behavioural baseline** — historical behaviour, *not* "true rates" — and move to shadow and real-world learning. Real empirical calibration begins as actual commercial outcomes accumulate.

---

## 16. Migration

The v3.1 audit found **no rate history to migrate**: `rateService.ts` is pure computation and its output lands in `athletes_current.rate_card`, a jsonb column on a primary-keyed row, overwritten in place.

1. New Rate writes ledger `ESTIMATE` entries in **shadow**. `athletes_current.rate_card` keeps serving existing readers untouched.
2. Readers migrate individually behind the read seam. The real product surface is **~14** — UI (5), Mila (7), API (2) — not 40; seven of the forty are scripts and backfills to **retire**, not migrate.
3. The projection is cut over last, after shadow output has been reviewed.
4. v3.1 stays until then. No dual-write of history, because there is no history.

---

## 17. Architectural constraints

Legacy implementation does not define target architecture — adapters during migration, never deforming new contracts to fit legacy ones. Do not invent capabilities unsupported by evidence. Preserve provenance, timestamps and as-of semantics, and versioning. Keep confidence separate from value, and observed separate from evaluated and derived. No athlete-specific patches. No connection bonus. No hidden assumptions. No synthetic precision. No MIA feedback circularity. Snapshot and composition layers never silently create intelligence. Learning compares a durable historical intelligence output with later commensurable reality.

---

## 18. The frozen-contract correction

`server/services/intelligence/contracts/provenance.ts`

```diff
- rates: ["MEASURED", "ASSUMED", "MISSING"],
+ rates: ["MEASURED", "EVALUATED", "ASSUMED", "MISSING"],
```

**A correction, not a widening.** The original entry described v3.1's conception of Rate — a deterministic formula
engine over lookup-table constants, whose numbers genuinely *were* assumptions. The approved Beta.1 methodology
replaces that with a rubric-constrained evaluator pricing an athlete against verified market benchmarks.

The evidence class follows **how a quantity was produced**, not whether it happens to be numeric. Classifying a rate as
`ASSUMED` because it is a number would make the vocabulary describe the output's *type* rather than its *epistemic
status*, and would leave Rate unable to state the one true thing about itself.

`ASSUMED` remains available to Rate, narrowed to its proper meaning: an **explicit** assumption adopted where evidence
is unavailable or the methodology requires one.

**The Opportunity principle is undisturbed.** Opportunity's quantities stay `ASSUMED` because nothing yet provides a
basis to estimate them. Rate is an `ESTIMATE` with commensurable commercial outcomes coming, making an evidence-grounded
pricing judgment rather than adopting a placeholder.

Four tests pin the corrected contract, including that marketability still may **not** emit `ASSUMED`.

---

## 19. Implementation sequence

Rate Beta.1 is **not** blocked on a Deals rebuild. Deals improvements proceed as an adjacent workstream.

**Benchmark seeding does not begin before every supported family has a terms basis.** Otherwise "the benchmark registry for the v0 surface" quietly becomes "the registry for the easy subset of it", while the taxonomy still claims the full set. As of §7 being complete, this condition is met.

| # | step | gate |
|---|---|---|
| 1 | ~~Freeze the reasoning rubric~~ **done (§9.1)**; ~~terms bases, all nine families, versioned~~ **done (§7)**; remaining: **`rate-eval-spec/1.0.0` — canonical prompt source, basis manifest, parity tests, pinned digest** | §7, §9.1 and §9.3 |
| 2 | Benchmark registry contract + seeding for the v0 surface: grounded research → candidates → verification → versioned approval | §8.3 |
| 3 | Rate evaluator client + one-call-per-athlete runner, reusing the M.I.A. apparatus | §9 |
| 4 | Persistence: `ESTIMATE` entries, identity, idempotency, supersession | §10, §11 |
| 5 | Cohort validation — behavioural, not target-fitting | §15 |
| 6 | Mia / Lilia connected-data validation: public-only vs connected — **test C**, the decisive range/confidence check | §15.1 |
| 7 | Shadow Rate beside `athletes_current.rate_card`; no reader switched | §16 |
| 8 | Rate ↔ Deal temporal learning seam with conservative comparability | §12.3 |
| 9 | Accumulate real outcomes; reader migration; projection cut over last | §16 |

Adjacent Deals workstream, visible but **not pulled into Rate Beta.1**: structured deliverables with platform and
format where known and explicit UNKNOWN where not; rights, usage, exclusivity and territory; term and duration;
royalty, revenue-share and bonus economics; negotiation history; fulfilment evidence; repeat and renewal relationships.
