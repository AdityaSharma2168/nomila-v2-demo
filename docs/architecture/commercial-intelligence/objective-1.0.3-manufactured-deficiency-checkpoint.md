# Objective 1.0.3 — manufactured deficiency: design/evidence checkpoint, 27 Sep 2026

**Controls:** `objective-eval-spec/1.0.2` (frozen); `opportunity-eval-spec/1.2.0` upstream (frozen). No provider call, no bump. Corpus: **84 Objective proposals** across every recorded Objective artifact (25 under 1.0.0, 42 under 1.0.1, 17 under 1.0.2; four Mia/Lilia/Riya/LeBron runs and the six-athlete cohort before and after 1.0.2), read against the maps they were judged from.

**In plain words.** When Nomila sees something already working for an athlete and proposes doing more of it, it has been in the habit of first inventing something wrong: "her channel lacks a diversified programming matrix", "her academy has unused capacity", "she lacks formal advocacy partnerships". None of those was in the evidence. The evaluator wrote them because its contract says the current state must differ from the desired one, and the easiest way to make a strength differ from "more of that strength" is to call it a shortfall. The fix is not to stop proposing growth from strength; it is to describe today honestly — the strength as measured — and let the ambition live in the desired state.

---

## 1. The seven known cases (validation cohort §3.2, all under 1.0.1, all AMPLIFY)

| # | athlete · Opportunity (kind · domain) | Opportunity wording | Objective desired state | `currentState` — the deficiency introduced | evidence cited | in the Opportunity? | in State? | useful without the deficiency? |
|---|---|---|---|---|---|---|---|---|
| 1 | Ronaldo · `amplify-youtube-programming` (AMPLIFY · content) | "Expand and diversify content programming on his record-breaking YouTube channel" | the channel "operates as a diversified digital media network featuring multiple structured … formats" | "has achieved massive rapid scale **but lacks a diversified programming matrix** beyond its initial launch content" | `findings[mia.audience_scale]`, `findings[mia.momentum]` (both strengths) | no — "expand and diversify" names room, not a lack | no — nothing about programming structure | **yes**: "the channel reaches 83 M subscribers on launch-era formats" → desired: a recurring multi-format slate |
| 2 | Flau'jae · `amplify-crossover-cultural-narrative` (AMPLIFY · positioning) | "Scale her category-defining dual identity … into integrated lifestyle and performance campaigns" | "portfolio is dominated by premium crossover campaigns that integrate both identities" | "possesses separate high-profile athletic partnerships and a prominent music career, **but lacks commercially scaled campaigns that structurally unite her dual identity**" | `narrative_power`, `cultural_relevance`, `brand_fit` (strengths) | no | no — State does not enumerate campaign structure | **yes**: "her athletic partnerships and her music career are each established" → desired: campaigns built on both |
| 3 | Flau'jae · `amplify-unrivaled-ownership-influence` (AMPLIFY · owned_venture) | "drive direct audience engagement toward her equity venture in the Unrivaled league" | "her equity venture is translated into a highly visible role as a league co-builder" | "holds an equity stake … **but her public-facing identity remains primarily focused on her rookie season and her music**" | `commercial_proof`, `audience_scale` | no | no | **yes**: "she holds an equity stake in the Unrivaled league" → desired: her ownership is a visible part of her public identity |
| 4 | Maher · `amplify-hello-sunshine-docuseries` (AMPLIFY · career) | "Integrate her upcoming competitive return … as the central narrative arc" | the docuseries "is structured with her return … as its central arc" | "in active development, **but her competitive return is not yet integrated as the primary storyline**" | `cultural_relevance`, `athletic_authority` | partly — the Opportunity presumes the arc is not yet central | no — State records a docuseries in development, nothing about its storyline | **yes**: "a self-titled docuseries with Hello Sunshine is in development" → desired: it chronicles her return |
| 5 | Maher · `amplify-medalist-skin-growth` (AMPLIFY · owned_venture) | "Leverage her massive social audience … to drive growth for her co-founded brand" | Medalist Skin "is a primary commercial driver … powered by direct conversion of her audience" | "established, **but its marketing and sales channels do not systematically leverage or monetize her 9.2 million followers**" | `narrative_power`, `audience_scale`, `commercial_proof` | no | no — State knows the brand exists and her audience size; nothing about its channels | **yes**: "she co-founded Medalist Skin; her audience is 9.2 M" → desired: her audience is a measured driver of the brand |
| 6 | Maher · `amplify-house-of-maher-sponsorship` (AMPLIFY · content) | "Scale the commercial sponsorship model of the podcast following its validated integration with Samsung" | "operates under a scaled, multi-brand sponsorship model" | "**primarily relies on a single presenting partnership** with Samsung Galaxy" | `audience_scale`, `brand_fit` | partly — "following its Samsung integration" | partly — findings name Samsung as presenting partner; "single" and "relies on" are the evaluator's | **yes**: "the podcast has a presenting partnership with Samsung" → desired: a multi-brand model |
| 7 | Street · `amplify-academy-commercial-partnerships` (AMPLIFY · owned_venture) | "Expand and scale corporate sponsorship integrations through her established Academy" | the Academy "operates with expanded sponsorship tiers and newly integrated partnerships" | "maintains active, strategic corporate sponsorships, **but has unused capacity to scale these integrations further**" | `commercial_proof`, `brand_fit` | no | no | **yes**: "the Academy holds active corporate sponsorships" → desired: more, and deeper |

Common shape: the Opportunity names a strength and a direction; the Objective's `currentState` restates the strength and then appends **"but [absence]"**; the appended absence rests on nothing (the cited paths are strength findings); the desired state is fine as written. Removing the clause after "but" preserves a useful, ambitious Objective in all seven.

## 2. The whole corpus — semantically equivalent cases beyond the seven

Method: every `currentState` and `observable_condition` keyword-flagged (35 + 7 of 84), then each read against its cited evidence and its map. Evidence-domain proposals are excluded (they are 1.0.2's subject, already refused). Classification:

| class | count | cases |
|---|---|---|
| **M — manufactured deficiency** (a negative baseline the cited evidence does not establish) | **12** | the seven above · LeBron `amplify-football-promotional-content` ×2 (1.0.0 run, run-b: "channels **lack structured promotional integration**" / "**do not yet feature a coordinated output**" — cited: cultural_relevance, audience_scale, commercial_proof) · Mia positioning 1.0.1-run-c ("her landmark Adidas NIL deal **lacks active integration** with her tech studies" — cited: activeRelationships, narrative_power, brand_fit) · **Ronaldo under 1.0.2** ("operates primarily as a rapid-growth distribution channel **without a formalized multi-show programming structure**" — the same gap, softened) · **Ledecky under 1.0.2** (`amplify-health-and-wellness-advocacy`: "**lacks formalized impact partnerships** … recorded in her profile" — an absence read off Nomila's record) |
| **R — absence read from Nomila's record** (a subclass of M with the MISSING → NONE mechanism) | 3 of the 12 | Ledecky 1.0.2; Mia Yuwa 1.0.1 ("**has not yet been commercialized** or translated into active CSR sponsorships" — from `activeRelationships = [gorjana]`); Mia positioning 1.0.0/1.0.1 ("relationships **limited to** a lifestyle brand, which **does not reflect** her academic accomplishments") |
| **S — supported negative baseline** (the evidence establishes it) | 11 | Mia cooling trajectory / dormant TikTok (×4 runs: `audienceTrajectory`, `contentPerformance[tiktok]` 553 days) · Lilia no personal channels (×3: research finding + `materialGaps`, world-real) · LeBron 17 games missed (×2, MAINTAIN) · Ronaldo lawsuit / missing disclosures (FIX, from `brand_fit`) · Ledecky first defeats (MAINTAIN) · Street "footprint highly limited … modest audiences" (from `audience_scale`, measured) · Lilia "local youth media, limited crossover" (from `cultural_relevance`) |
| **N — neutral factual baseline** | 2 | Mia StartX1 "has not yet been converted" (pipeline, factual) · Maher docuseries under 1.0.2 ("in development and has not yet been produced, as documented in findings") |
| success-condition leakage | **0** | seven flagged `observable_condition`s are all future-world statements ("without extended injury absences", "no longer classified as cooling", "a single verified identity"); none asserts a present deficiency |

**Distribution of M by upstream kind:** AMPLIFY 10 · GROW+AMPLIFY combined 2 · UNLOCK 0 · MAINTAIN 0 · FIX 0. **By spec:** 1.0.0 ×3, 1.0.1 ×7, **1.0.2 ×2** — the knowledge boundary did not touch this class, as the cohort audit predicted.

## 3. The exact failure taxonomy

1. **Appended absence** ("…, but lacks / does not / has not / without / unused / single"): a strength restated, then a shortfall invented so that `current_state` "differs". 9 of 12.
2. **Absence from Nomila's record** ("no CSR sponsorship recorded", "limited to gorjana"): `activeRelationships` or an empty section read as the athlete's condition — MISSING → NONE, one layer down from the Opportunity case. 3 of 12.
3. **Not present:** deficiency in the success condition (0); deficiency invented under FIX, UNLOCK or MAINTAIN (0 — FIX and MAINTAIN cases all cited affirmative evidence; UNLOCK cases were evidence-domain and are gone).

The mechanism is the contract: `current_state — what is true today that this intends to change` + `desired_state and current_state must differ` + the 1.0.2 sentence "you do not carry [knowledge gaps]… you do not rephrase them". For a strength, "what this intends to change" reads as "what is wrong", and the evaluator supplies one.

## 4. Direction versus deficiency — the principle, tested

> **A desired direction does not imply a deficient baseline.**

Holds on all 12: in each, the desired state is a legitimate extension of a measured strength (more formats, both identities in campaigns, a visible ownership role, a multi-brand model, more sponsorship tiers, formal advocacy roles), and the invented deficiency contributes nothing to it. GROW from strength (Street's audience, Mia's cadence from a healthy engagement rate), AMPLIFY as "do more of what works", UNLOCK as "realise available upside", MAINTAIN as "keep what is worth keeping": none needs a failure premise. FIX is the one kind whose premise *is* a problem — and in the corpus every FIX cited affirmative evidence (Ronaldo's lawsuit). **Kind-relative semantics are warranted at the level of "what the current state must establish"**, not as templates (§6).

## 5. `currentState` must be evidenced

> **A negative or deficient baseline asserted in `current_state` must be established by the cited `current_state_evidence`. Where the evidence establishes a strength, an opportunity or an unknown, the current state describes that — the strength as measured, the asset as it stands, the unknown as unknown — and does not convert it into a weakness.**

Tested against the corpus: every M case fails it (the cited paths are strength findings, or a Nomila count); every S case passes it (the trajectory is measured cooling; the games were missed; the lawsuit is in `brand_fit`); the N cases pass trivially. The example shape in the brief ("her public positioning includes athletics and entrepreneurship, with emerging technology associations" instead of "her technology positioning is weak") **is supported by the corpus**: Mia's positioning cases are exactly this — the honest baseline is `activeRelationships = [gorjana]` plus her narrative findings, and the desired state (a tech/STEM partnership) needs no "weak" to be worth proposing.

## 6. Kind-relative findings (semantics, not templates)

| upstream kind | what `current_state` must establish | corpus |
|---|---|---|
| FIX | the cost being paid now, from evidence | Ronaldo lawsuit ✓ (only FIX in the non-evidence corpus) |
| GROW | the factual baseline it grows from — a measured weakness, an affirmatively established absence, or a small base; never an absence inferred from Nomila's record | Mia cadence ✓ · Lilia channels ✓ · Street footprint ✓ · Mia positioning ✗ (record-inferred) |
| UNLOCK | the asset, as evidenced, and that it is idle as evidenced | no non-evidence UNLOCK in the corpus after 1.2.0 |
| AMPLIFY | the strength as measured; nothing else | 10 of 12 failures are here |
| MAINTAIN | the desirable condition and the named risk, from evidence | LeBron durability ✓ · Ledecky legacy ✓ |

The Objective contract does not carry the Opportunity kind on the proposal and should not start to; the kind is readable from `from_opportunities` and the map. The rule is written kind-relatively in prose (§13), not as fields.

## 7. Success condition

Zero leakage in 84. `observable_condition` describes the desired observable world state ("the channel regularly publishes three recurring formats"; "her TikTok features content published within 14 days") and never asserts that its opposite is currently true. No rule needed there; the checkpoint records it so the 1.0.3 text does not over-reach into `success`.

## 8. Unknown versus neutral

UNKNOWN ≠ negative; MISSING ≠ deficient (State 1.2, #638, P6). Interaction with `currentState` and confidence: where the cited evidence cannot establish baseline quality (an UNKNOWN finding, an empty section, a Nomila count for an unconnected athlete), the current state says what is known and what is not — "her engagement quality is not measured" — and the proposal's confidence carries the uncertainty. It does **not** say "her engagement is weak". The three R cases are the ones this would have changed. The 1.0.2 sentence "Absence is not evidence of weakness" is already in the Objective text; 1.0.3 extends it from *knowledge* absence to *baseline* invention.

## 9. Interaction with 1.0.2 — additive, never weakening

1.0.2: an Objective must describe an athlete-world desired outcome, not a Nomila knowledge change. **1.0.3 candidate: an Objective must not manufacture an unsupported deficient athlete-world baseline to justify that outcome.** They compose: 1.0.2 keeps the *desired* state in her world; 1.0.3 keeps the *current* state honest. Neither touches the other's enforcement (1.0.2's structural refusal of `domain: evidence` stays; 1.0.3 adds no structural rule, §12). The two Ronaldo/Ledecky cases under 1.0.2 show that 1.0.2's "you do not rephrase them into outcome language" did not, and was not meant to, address the baseline.

## 10. Athlete voice and ambition — no timid Objectives

The rule removes premises, not reach. Every corrected case in §11 keeps the same desired state, the same success condition and the same horizon; the only change is the sentence about today. An ambition from her own words stays an ambition ("she wants national brands" is a reason to propose, not a deficiency). Where the honest baseline is a strength, the proposal reads as *growth from strength*, which is what a representative would actually say to her.

## 11. Corrected versions of the historical cases (current state only; desired state unchanged)

| case | manufactured `current_state` | corrected `current_state` (neutral, evidenced) |
|---|---|---|
| Ronaldo YouTube | "…but lacks a diversified programming matrix beyond its initial launch content" | "'UR · Cristiano' reaches 83.3 M subscribers and 1.65 B views within two years of launch (`findings[mia.audience_scale]`, `findings[mia.momentum]`)." |
| Flau'jae crossover | "…but lacks commercially scaled campaigns that structurally unite her dual identity" | "She holds high-profile athletic partnerships and is a signed Roc Nation artist (`narrative_power`, `cultural_relevance`, `brand_fit`)." |
| Flau'jae Unrivaled | "…but her public-facing identity remains primarily focused on her rookie season and her music" | "She holds an equity ownership stake in the Unrivaled league (`commercial_proof`)." |
| Maher docuseries | "…but her competitive return is not yet integrated as the primary storyline" | "A self-titled docuseries with Hello Sunshine is in development; her return to the national programme is upcoming (`cultural_relevance`, `athletic_authority`)." (1.0.2's own rerun produced this) |
| Maher Medalist Skin | "…do not systematically leverage or monetize her 9.2 million followers" | "She co-founded Medalist Skin; her combined social audience is 9.2 M (`narrative_power`, `audience_scale`, `commercial_proof`)." |
| Maher podcast | "…primarily relies on a single presenting partnership with Samsung Galaxy" | "'House of Maher', co-hosted with her sisters, has a presenting partnership with Samsung Galaxy (`audience_scale`, `brand_fit`)." |
| Street Academy | "…but has unused capacity to scale these integrations further" | "The Picabo Street Academy holds active corporate sponsorships (`commercial_proof`, `brand_fit`)." |
| LeBron football content (×2) | "…channels lack structured promotional integration" | "He signed a USD 15 M annual football-content endorsement with Polymarket in September 2026 (`commercial_proof`, `cultural_relevance`, `audience_scale`)." |
| Mia positioning (×3) | "…limited to a lifestyle brand, which does not reflect her academic accomplishments" / "…Adidas deal lacks active integration with her tech studies" | "Her active relationship is gorjana; her narrative findings record accelerated Stanford study in Symbolic Systems and an MS&E master's (`activeRelationships`, `narrative_power`)." |
| Mia Yuwa | "…has not yet been commercialized or translated into active CSR brand sponsorships" | "Her leadership in the Yuwa programme is a core narrative finding; her recorded active relationship is gorjana (`narrative_power`, `cultural_relevance`, `activeRelationships`)." |
| Ledecky advocacy (1.0.2) | "…lacks formalized impact partnerships or structured advocacy roles in the health sector recorded in her profile" | "Her POTS diagnosis is disclosed in her memoir (`cultural_relevance`, `narrative_power`); no advocacy role is recorded in State (which does not establish that none exists)." |

Every corrected baseline still differs from its desired state; every proposal stays ambitious.

## 12. Enforcement options

| location | rule | verdict |
|---|---|---|
| **semantic instruction (primary)** | the block in §13 | **adopt** — the failure is judgment, exactly as 1.0.2's was; verified by rerun, proposal by proposal |
| grounding gate | "a negative claim in `current_state` must be supported by a cited path" | **not adoptable deterministically**: the cited path *exists* in every M case (a strength finding); the gate resolves existence, not truth, by design. Deciding that "lacks a programming matrix" is unsupported by `findings[mia.momentum]` is semantic |
| structural gate | a negative-word regex on `current_state` | **rejected** — "cooling", "dormant", "missed 17 games" are supported negatives; "lacks structured integration" is not; syntax cannot tell "grow an already strong audience" from "fix a weak audience" |
| normaliser | — | nothing to normalise |

Enforcement = one semantic block + the rerun test the cohort used (§14). No new gate.

## 13. Proposed contract wording (`OBJECTIVE_BASELINE_BLOCK`, for the 1.0.3 candidate; not applied)

> THE CURRENT STATE IS WHAT THE EVIDENCE SHOWS, NOT WHAT THE OUTCOME NEEDS
>
> current_state describes today as the cited evidence establishes it. A desired direction does not imply a deficient baseline: an outcome that extends a strength starts from the strength as measured; an outcome that realises an asset starts from the asset as it stands; an outcome that protects something starts from the thing worth protecting and the named risk. Only an outcome that repairs a cost starts from a problem, and then the evidence must show the cost being paid.
>
> Do not add a shortfall so that the current state differs from the desired one. "Her channel reaches 83 million subscribers" and "her channel runs a recurring multi-format slate" already differ; "but lacks a diversified programming matrix" is an invention unless the state records it. If the evidence establishes a strength, an opportunity or an unknown, say that; do not convert it into a weakness, an absence, an under-use or a dependence. A count of Nomila's records — zero closed deals, one active relationship — describes Nomila's records, not her world, and is never by itself the basis for "she lacks".
>
> Where the evidence cannot establish the baseline's quality, the current state says so plainly and confidence carries the uncertainty; it does not fill the silence with a deficiency. An ambitious outcome from a strong position is a legitimate proposal, and the honest baseline is what makes it credible.

Placement: after `OBJECTIVE_OUTCOME_BLOCK`; `desired_state and current_state must differ` stays (the block explains how they differ without invention). The success section is untouched.

## 14. Tests

Parity phrases for the block (direction ≠ deficiency; do not add a shortfall; strength/opportunity/unknown not converted; Nomila's counts; silence not filled; ambition legitimate); the digest ceremony; no structural change (gate tests unchanged); **the rerun test** on the frozen cohort artifacts and the four Mia/LeBron/Lilia/Riya `{state, map}` pairs: (a) the twelve M cases are absent for the same semantic purpose — read proposal by proposal, not by regex; (b) no disguised replacement (a softened "without a formalized structure" counts as the same invention); (c) every S and N baseline still present as evidence-supported; (d) desired states, success conditions and horizons of the retained proposals unchanged in substance (tier A/B lineage); (e) zero gate refusals; (f) 1.0.2's 10 of 10 knowledge refusals still hold.

## 15. Is 1.0.3 sufficient, or does the taxonomy need more?

**1.0.3 is sufficient.** The failure is one class with one mechanism and one enforcement point; no field, kind or domain changes; the Opportunity kind stays readable through provenance. The only larger pressure recorded is upstream and already logged (R12: Opportunity feasibility prescribing execution), not here.

## 16. Is a provider forcing call warranted?

**Yes, one — after the 1.0.3 ceremony**, on the frozen cohort artifacts the 1.0.2 rerun used (same six `{state, map}` pairs, spec changed only), read exactly as the cohort was: the twelve M cases gone without disguised replacement, the strength-based proposals retained and ambitious, 1.0.2's refusals intact. Not now.

## 17. Not done

No provider call. No Objective bump (1.0.2 frozen). No Opportunity, Brain, Deals, Rate, Recommendation, Campaign/Studio or brand-relationship change. No mounting. No repeatability matrix. Opportunity 1.2.0 is the upstream control; #570 untouched.

## 18. Review outcome (27 Sep 2026) — accepted; proceed with 1.0.3

**Architectural rule adopted:** *A desired direction does not imply a deficient baseline.* `current_state` describes today as the cited evidence establishes it; the desired outcome may be ambitious without the system inventing something wrong with today. Composes with 1.0.2 (desired outcome in her world, not Nomila's knowledge) — neither weakened.

**Current-state invariant adopted** (`OBJECTIVE_BASELINE_BLOCK`): a negative or deficient baseline asserted in `current_state` must be established by the cited evidence. Strength → describe the strength; asset → the asset; opportunity → what is actually established; unknown → preserve the unknown; a real measured problem → a valid negative baseline. Strength, opportunity, unknown or incomplete records are never converted into weakness.

**Kind-relative semantics kept as semantics, not templates:** FIX — the evidence must establish the cost being paid now · GROW — the factual baseline; growth from strength is valid · UNLOCK — the evidenced asset and, only where established, the condition preventing realization; no invented idleness · AMPLIFY — the strength as measured; no deficiency premise · MAINTAIN — the desirable condition and the evidenced risk. No new fields; the kind stays readable through provenance.

**Nomila records:** a count of Nomila's records describes Nomila's records unless completeness is established — one recorded relationship ≠ only one; zero recorded deals ≠ no deals; no recorded advocacy partnership ≠ none. **Success conditions:** not modified (zero leakage found). **Enforcement:** semantic instruction only — no negative-word regex, no structural gate, no grounding-path-existence rule, no normaliser repair; the grounding gate establishes that cited evidence exists, not that a negative claim is entailed by it.

**Correction to the forcing acceptance (important):** the twelve affected Objectives are **not** required to disappear — that would reward timidity. The acceptance condition is that the twelve manufactured-deficiency **baseline claims** are absent with no disguised semantic replacement; the ambitious Objectives may remain where still warranted with neutral/positive/evidenced baselines. "Strength today → ambitious extension tomorrow" is a successful result; "strength today → Objective omitted" is not inherently better. Each historical M case is classified on the rerun as: (1) retained + corrected baseline (preferred); (2) legitimately absent by provider variation (acceptable, not evidence of the rule by itself); (3) retained + same manufactured deficiency — fail; (4) retained + disguised/softened equivalent — fail; (5) retained + new unsupported deficiency — fail.

Next: the 1.0.3 ceremony and one frozen-cohort forcing rerun (`docs/audits/objective-1.0.3-cohort-rerun.md`).

## 19. Ceremony and cohort rerun (27 Sep 2026)

`objective-eval-spec/1.0.3` (digest `16627fb2…`) by ceremony; one frozen-cohort evaluation (six athletes, USD 0.110, 15 proposals) — `docs/audits/objective-1.0.3-cohort-rerun.md`. Of the nine historical manufactured-deficiency cases the cohort exercises, **seven came back retained with corrected baselines** (Ronaldo's programming matrix "not recorded in the system"; Maher's docuseries, Medalist and podcast stated neutrally; Street's Academy as its partner list; Ledecky's advocacy as a characterisation of enumerated partners); supported negatives, ambition, success conditions, the 1.0.2 knowledge boundary (10 of 10) and both gates held. **Two retained proposals (Flau'jae's crossover and Unrivaled) replaced the invented world-deficiency with a record-scoped "lacks recorded …" — the same MISSING → "lacks" mechanism in hedged form; scored class 4, fail.** Per the rule, not patched and not rerun. **1.0.3 is not supported on acceptance conditions 1 and 2**; the residual is one sentence the block does not yet say outright — a record *absence* worded as "lacks" is the same conversion as a record *count* — recorded as the 1.0.4 candidate, not applied.

## 20. Verdict (27 Sep 2026, reviewed) — Objective 1.0.3: NOT SUPPORTED

Not merged into the accepted Objective contract. What the experiment established: the baseline rule substantially improved behaviour; seven of nine exercised historical cases returned corrected; supported negatives stayed expressible; ambition preserved; success conditions clean; the 1.0.2 knowledge boundary intact; no new structural or grounding machinery. But two manufactured-deficiency cases survived as hedged equivalents — the same mechanism, **MISSING → deficiency, with epistemic hedging** — so 1.0.3 is not accepted. **Version status: 1.0.2 = accepted frozen control; 1.0.3 = experimental candidate that failed acceptance.** The refinement is not a syntax patch on "recorded … lacks"; the deeper candidate — *an epistemic absence may be acknowledged as uncertainty but must not serve as the deficient side of the current→desired contrast* — is tested against the corpus in `objective-1.0.4-epistemic-contrast-checkpoint.md`.
