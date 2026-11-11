# Objective 1.0.4 — the ceremony and one frozen-cohort evaluation, 27 Sep 2026

**Status:** `objective-eval-spec/1.0.3` (failed candidate) → **1.0.4** by ceremony, cumulative; one provider evaluation of the same six frozen `{state, map}` pairs used in #644 and the 1.0.2 rerun (no State refresh, no Opportunity rerun, no Context, no added evidence); no rerun, no patch. Artifacts: `docs/audits/artifacts/objective-validation-cohort/objective-1.0.4/`. Model `gemini-3.5-flash`; **cohort cost USD 0.111**; **14 gated proposals across five sets; one set (Okpara) refused at Gate 2** on an accounting double-listing (see §3).

**Verdict: 1.0.4 PASSES the acceptance bar on every gated proposal — zero E, zero F, zero manufactured deficiency, supported negatives preserved, ambition intact, success conditions clean, 1.0.2 intact, no new machinery.** Two things are recorded beside the pass: the Okpara refusal (a gate doing its job on an unrelated accounting error; its raw baseline is classified below and is supported), and the fact that the confidence clause was not exercised because no proposal rests on an unknown.

## 1. The ceremony

| step | result |
|---|---|
| root cause recorded | `current_state — what is true today that this intends to change` + `must differ` demanded a reason today is deficient; three versions supplied three fillers (shortfall → count → record absence → observed-set generalisation). Not lexical; the semantic role of the field |
| exact contract change | **field redefined**: `current_state — the evidenced athlete-world baseline relevant to the desired state: what the cited evidence establishes about where the athlete is starting from — a strength, an asset, a measured problem, a constraint, a trajectory, or a factual situation. Not what is wrong today, and not what Nomila has failed to observe.` · **difference rule restated**: "The difference is the proposed movement, not evidence that the current state is deficient: a strength today and a larger expression of that strength tomorrow are meaningfully different, and no claim about what is absent today is required unless the evidence establishes it." · **1.0.3 block amended** ("its job is fidelity to the evidence, not justification of the outcome"; the sentence that invited epistemic commentary into the baseline replaced: what remains unknown belongs in the rationale and the confidence level) · **invariant added**: UNKNOWN MAY QUALIFY; IT MAY NOT JUSTIFY, with the semantic test ("if Nomila observed the missing fact tomorrow and found everything already fine, would today's current_state be false?"), "however phrased", and the observed-set rule ("establishes neither that no others exist nor that her portfolio is concentrated; only a source that establishes completeness can") · **confidence line extended** (material unknowns lower it; not mechanically) · output-contract line: `current_state — one sentence, the evidenced baseline — where she is starting from`. No field, schema, gate, regex, negative-word rule or exception |
| digest | 1.0.3 `16627fb2…` → **1.0.4 `99773087c1e89821a457e2a5a13c0e5399164a4118d626e1c715446d219ac116`**, repinned after parity and the exact-text review |
| parity / regression | 124 Objective-tree tests (23 spec parity incl. 17 new 1.0.4 phrases and orderings) · 33 Objective orchestrator/routes · 62 Opportunity · 23 Brain — green; gates and output contract unchanged; the `baseline:`-field prohibition still holds |
| histories | 1.0.2 (accepted control) and 1.0.3 (failed candidate) untouched |

## 2. Every gated proposal (14), classified A–G

A affirmative athlete-world fact · B established athlete-world problem · C strength/asset · D unknown as qualifier · E record absence as contrast · F observed set generalised · G other

| athlete · proposal (from) | `current_state` | evidence | class | 1.0.3 counterpart (its class) | desired state — ambition kept? | success | conf |
|---|---|---|---|---|---|---|---|
| Ronaldo · content (AMPLIFY `amplify-youtube-programming`) — **hist. M #1/#10** | "'UR · Cristiano' has acquired over 83.3 million subscribers and 1.65 billion cumulative views as of September 2026" | audience_scale, momentum | **C** | "…**but** its programming matrix … not recorded in the system" (E) | "a fully diversified programming network … independent of traditional media" — yes | future observable | HIGH |
| Ronaldo · positioning (FIX) | "facing a proposed $1 billion class-action lawsuit … without proper paid disclosures … despite his highly active global commercial portfolio" | brand_fit | **B** | B | yes | ✓ | HIGH |
| Ronaldo · career (GROW) | "At 41 he remains active as captain of Al-Nassr and Portugal, supported by a legendary athletic authority and the 'CR7' narrative" | careerStatus, athletic_authority, narrative_power | **A/C** | "…**with no** formalized post-retirement structure recorded in the system" (E) | "a formalized business and legacy architecture" — yes | ✓ | HIGH |
| Ronaldo · owned_venture (AMPLIFY) | "partnerships include traditional licensing and endorsements alongside a landmark Nike lifetime deal, yielding an estimated $65 million in annual off-field earnings" | commercial_proof, momentum | **A** | A(+D) | "anchored by high-equity stakes" — yes | ✓ (a ≥10 % stake in a new venture) | HIGH |
| Flau'jae · positioning (AMPLIFY) — **hist. M #2** | "an active WNBA rookie … and a signed Roc Nation artist with a combined following of nearly 5 million, whose existing commercial campaigns have separately featured fashion/tech and cosmetics brands" | narrative_power, cultural_relevance, brand_fit (Puma → e.l.f.), audience_scale | **A/C** — describes the campaigns the evidence records (Puma, Samsung, e.l.f.); asserts no absence; the test passes (an integrated campaign observed tomorrow would not falsify it) | "**but lacks recorded** campaign integrations" (E) | "dominated by integrated crossover campaigns" — yes | ✓ | HIGH |
| Flau'jae · owned_venture (AMPLIFY) — **hist. M #3** | "holds an equity ownership stake in the Unrivaled league, alongside her massive sports and entertainment following" | commercial_proof, audience_scale | **C** | "…**but her recorded** digital platforms **lack**…" (E) | "activated as a prominent pillar of her public commercial identity" — yes | ✓ | HIGH |
| Maher · athletic (MAINTAIN) | "a two-time Olympian and 2024 bronze medalist on a competitive break from rugby since late 2025" | athletic_authority, momentum | **A** | A | yes | ✓ | HIGH |
| Maher · career (AMPLIFY) — **hist. M #4** | "co-producing and developing a self-titled docuseries with Hello Sunshine" | cultural_relevance, athletic_authority | **A** | A | yes | ✓ | HIGH |
| Maher · owned_venture (AMPLIFY) — **hist. M #5** | "co-founder of Medalist Skin, an active skincare brand for female athletes" | commercial_proof, audience_scale, narrative_power | **C** | "…**but** its distribution and retail scale are not documented" (E) | "expanded retail distribution or an increased product line" — yes | ✓ | HIGH |
| Maher · content (AMPLIFY) — **hist. M #6** | "co-hosts 'House of Maher', 4.9 on Apple Podcasts, presented by Samsung Galaxy" | audience_scale, brand_fit | **C** | C | yes | ✓ | HIGH |
| Ledecky · positioning (MAINTAIN) | "historic athletic authority as the most decorated female U.S. Olympian, but recently experienced her first international defeats … at the 2026 Pan Pacific Championships" | athletic_authority, momentum | **C + B** (the evidenced risk) | C+B | yes | ✓ | HIGH |
| Ledecky · impact (AMPLIFY) — **hist. M #11** | "disclosed her battle with POTS in her best-selling memoir, establishing an authentic narrative layer of resilience" | narrative_power, cultural_relevance, brand_fit | **A/C** | "…**but** … remain heavily concentrated in traditional … brands" (F) | "a structured, active public platform with dedicated organizational alignments" — yes | ✓ | HIGH |
| Street · owned_venture (AMPLIFY) — **hist. M #7** | "maintains active strategic brand partnerships with Stifel, Hydro Flask, Comcast/Xfinity, Wildhorn, Kappa, and Cloudflare" | commercial_proof, brand_fit | **C** | C | yes | ✓ | HIGH |
| Street · career (AMPLIFY) | "debuted as an NBC sports analyst and women's hill reporter during Milano Cortina 2026, refreshing her legacy of athletic authority" | athletic_authority, momentum | **A/C** | A/C | yes | ✓ | HIGH |

**Totals (gated): A/B/C 14 · D 0 · E 0 · F 0 · G 0.** No "but … not recorded", no "lacks recorded", no "concentrated". Every contrast is carried by an affirmative fact or strength alone; every desired state is as ambitious as its 1.0.3 and 1.0.2 counterparts (several more so); all 14 success conditions are future-world observables.

## 3. The refused set — Okpara

Gate 2 refused the set: `amplify-values-based-positioning` and `grow-direct-brand-relationships` each appear in the proposal's `from_opportunities` **and** in `notes` as "consolidated into" that same proposal — the accounting rule requires exactly one. A provider slip on a rule unchanged since 1.0.0 (the 1.0.1 and 1.0.2 cohorts had zero refusals; this is the first). The gate did its job; no set was produced; not rerun. For the record, the refused raw baseline — "estimated team-roster NIL valuations up to $500,000, but he currently has zero closed corporate deals or active individual brand relationships" — is **A/B**, not E: the cited `commercial_proof` finding (researched, direction neutral) itself states "he has no verified individual corporate endorsements on his record. His pricing power is currently restricted to systemic team roster pools" — an affirmative research finding about a public athlete, not Nomila's count (which the 1.0.3 version cited as "on record"). Had the set gated, it would have passed the baseline test.

## 4. Historical M cases — outcomes under 1.0.4

| # | case | 1.0.3 | 1.0.4 |
|---|---|---|---|
| 1/10 | Ronaldo YouTube | E ("not recorded in the system") | **C — retained, corrected** |
| 2 | Flau'jae crossover | E ("lacks recorded") | **A/C — retained, corrected** |
| 3 | Flau'jae Unrivaled | E ("recorded platforms lack") | **C — retained, corrected** |
| 4 | Maher docuseries | A | A |
| 5 | Maher Medalist | E ("not documented") | **C — retained, corrected** |
| 6 | Maher podcast | C | C |
| 7 | Street Academy | C | C |
| 11 | Ledecky advocacy | F ("heavily concentrated") | **A/C — retained, corrected** |
| 8, 9 | LeBron ×2, Mia | not in the cohort | not exercised |

Nine exercised: **nine retained with A/B/C baselines; zero absent; zero E/F.**

## 5. Supported negatives, growth from strength, 1.0.2

- **Supported negatives expressible:** the lawsuit (B, FIX), the first defeats (B, MAINTAIN risk), the competitive break (A). The rule did not neutralise real evidence. (Cooling / dormant / missed games / limited footprint are not in this cohort's evidence; they were preserved under 1.0.3 and nothing in 1.0.4 touches them.)
- **Growth from strength:** every AMPLIFY-derived proposal starts from the strength itself (subscriber count, the stake, the brand, the podcast, the partner list, the memoir, the NBC debut) with no problem premise.
- **1.0.2 knowledge boundary intact:** 11 of 11 evidence-domain openings `not_carried` as information acquisition across the six sets (incl. `fix-missing-commercial-records`, filed under `commercial`); zero knowledge-shaped proposals.
- **Gates:** structural 0 ×6; grounding 0 ×5, 2 accounting problems ×1 (Okpara); no new machinery.

## 6. Confidence (recorded separately, as instructed)

All 14 gated proposals: `HIGH`. Inspected each for a materially unresolved premise the Objective requires: **none rests on an unknown** — with the E/F contrasts gone, every rationale rests on the cited strength or fact (Ronaldo's programming plan on scale and momentum; Flau'jae's on her two identities; Medalist's on the brand and the audience; Ledecky's on the memoir). No rationale mentions an unknown. So HIGH does not coexist with an unresolved required premise anywhere in this run — but the new confidence clause was **not exercised**: this cohort produced no proposal that needed it, so whether the evaluator lowers confidence when an unknown *is* material remains unobserved.

## 7. Acceptance

| bar | result |
|---|---|
| E class: zero | **met** (14/14) |
| F class: zero | **met** |
| manufactured deficiencies incl. disguised: zero | **met** |
| supported negatives preserved | **met** |
| growth from strength uses the strength as baseline | **met** |
| ambition intact | **met** |
| success = future-world observables | **met** |
| 1.0.2 boundary intact | **met** (11/11) |
| confidence | recorded separately; not contradicted; clause unexercised |
| gates: no new machinery | **met**; one accounting refusal recorded, unrelated to the rule |

**Objective 1.0.4 passes.** Per the hard-stop rule: **State → Opportunity → Objective is frozen for now** and the architecture moves forward (next: Recommendation → Execution Path).

## 8. Observations (not acted on)

- The Okpara accounting refusal is the cohort's first gate refusal in three runs; one sample, unattributable to 1.0.4's text; if it recurs it is a spec-clarity item on the accounting rule ("exactly once"), not a baseline matter.
- Confidence remains uniformly HIGH across 1.0.2/1.0.3/1.0.4 (46 of 46 gated proposals). The clause now ties it to material unknowns, but the evaluator has yet to emit anything but HIGH in a cohort; a case whose reasoning genuinely depends on an unknown has not arisen since the E/F contrasts were removed. Watch, do not tune.
- Ronaldo's `desired_state` ("a fully diversified programming network … independent of traditional media platforms") is more expansive than 1.0.3's; ambition rose slightly as the manufactured contrast fell away — the intended direction, noted for the record.

## 9. Not done

No second evaluation. No patch. No Opportunity, Brain, Deals, Rate, Recommendation, Campaign, Creative Intelligence, Studio or brand-relationship change. No mounting. No repeatability matrix. Opportunity 1.2.0 frozen; Objective 1.0.2 and 1.0.3 histories preserved; #570 untouched.
