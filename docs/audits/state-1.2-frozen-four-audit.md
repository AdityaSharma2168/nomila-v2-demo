# State 1.2 — frozen-four before/after audit

**Owner:** Mia
**Date:** 2026-09-23
**Question:** *Does giving the existing reasoning system the information Nomila already possesses materially improve its strategic intelligence — without changing the evaluators?*
**Method:** State bumped `athlete-state/1.1.0 → 1.2.0` (commit `88d2811f`). The frozen Opportunity evaluator (`opportunity-eval-spec/1.0.0`, digest `6bcf91ab…`) and the frozen Objective evaluator (`objective-eval-spec/1.0.0`, digest `d3aba4b5…`) were run **unchanged** on the rebuilt State for Mia, Riya, Lilia and LeBron. Compared against Run 3 (`opportunity-1.0.0-run-c`) and the first Objective run (`objective-1.0.0-run`). **Nothing was tuned after the run.**

Artifacts: `docs/audits/artifacts/opportunity-1.0.0-run-d/`, `docs/audits/artifacts/objective-1.0.0-run-b/`. Cost: $0.082 + $0.086.

---

## 0. The answer

**Yes — materially, and only where the information existed.**

- For **Mia and Lilia**, whose tables held intent, an inbox, a pipeline and content measurements that State 1.1 never read, the *same* Opportunity evaluator moved from generic diagnoses to specific ones, produced the first `commercial` opportunities grounded in actual demand, and cited the new material in **18 of 46** citations. The *same* Objective evaluator drafted the first intent-linked proposals (origin would derive to `joint`), the first quantified commercial target read against a real baseline, and horizons with reasons — none of which Run 3 contained for either athlete.
- For **Riya and LeBron**, whose new sections are all empty (no goals, no inbox, no pipeline, no audience rows), the maps and sets are the same in substance as before. That is the control: the change is attributable to State, not to run-to-run variance.
- **One latent defect surfaced**, and it is in the frozen Objective spec, not in State: Mia's and Lilia's Objective sets were **refused by the structural gate** (§5). The gate did its job; the raw proposals are retained and are audited below as drafts.

What did *not* improve, and why, is in §6.

---

## 1. What State 1.2 exposed, per athlete

| | Mia | Riya | Lilia | LeBron |
|---|---|---|---|---|
| **intent** (`preferences[onboarding_goal.*]`, labelled `onboarding_v1_choice`) | grow_my_following, get_my_first_deal (chosen 2026-05-30) | — | grow_my_following, get_my_first_deal (2026-06-18) | — |
| **pipeline** (distinct counts) | detected 200 · negotiating 7 · rejected 2 · accepted 1 · completed 0 | all 0 | detected 39, else 0 | all 0 |
| **inbound** (cap 12, most recent) | 12: PAID 8 · GIFTING 3 · EDITORIAL 1 — StartX1 ×3, gorjana, Stan Eats, ANAZE… | 0 | 12: GIFTING 5 · PAID 3 · SCHOOL_NIL 2 · EDITORIAL · MEDIA — lululemon, SHEIN ×2, Gotham FC, Girls Academy League ×4 | 0 |
| **audience** | instagram 21,975 · US 69% · 18–24 30% · F 38 / U 35 / M 27 (2026-09-23) | — | — | — |
| **contentPerformance** | instagram 0.47 posts/wk · 10 days since last · reel 50 / carousel 50 · top-decile share 0.48 · breakout 0; **tiktok 553 days since last post** | — | — | — |
| **representation** | agent Spencer Wasworth · Bhuta Management · floors ×5 (socialPost 1,000 … ambassador 3,602) | null | floors ×2 (appearance 612, autograph 579) | null |
| **dates** | **[]** | [] | [] | [] |

Two honest findings about the data itself:

1. **`dates` is empty for all four.** No deal carries `term_end`, every recent classification has `deadline: null`, and no current affiliation has `started_on`. The section renders "(none recorded)" — the timing category the sufficiency audit called material remains **Type A: the information is not there**, not "State didn't project it". `grounded_deadline` stays deferred for that reason.
2. **`representation` is projected as stated.** Mia's `deal_preferences` names an agent and agency. State makes no judgement about whether that is real; it is her record. If it is test data, it is hers to correct — and the evaluator did lean on it (§2, Mia note on `relationships`).

Deliberately not projected: `brand_fit_narratives` (written by a Mila pitch feature — evaluator material) and `athlete_facts` (67% disputed).

---

## 2. Opportunity — Run 3 (State 1.1) vs Run D (State 1.2), frozen `1.0.0`

### 2.1 Shape

| | Run 3 | Run D |
|---|---|---|
| opportunities | 13 (Mia 4 · Riya 2 · Lilia 3 · LeBron 4) | **15** (Mia **6** · Riya 2 · Lilia 3 · LeBron 4) |
| citations resolved | 35 / 35 | **46 / 46** |
| kinds | GROW 5 · AMPLIFY 3 · UNLOCK 3 · MAINTAIN 1 · FIX 1 | GROW 6 · AMPLIFY 3 · UNLOCK 4 · MAINTAIN 1 · FIX 1 |
| domains with a `commercial` opportunity | 0 (LeBron's was a records fix) | **2** (Mia AMPLIFY, Lilia GROW) |
| map confidence | MEDIUM / LOW / LOW / LOW | unchanged |

### 2.2 Where the citations went

| section | Run 3 | Run D |
|---|---|---|
| `findings[mia.*]` | 23 (66%) | 20 (43%) |
| `materialGaps` | 8 | 8 |
| `commercialPosition.*` | 2 | **10** (pipeline ×2, inbound ×4, closedDeals, activeRelationships ×2 …) |
| `preferences[...]` | 0 | **6** |
| `contentPerformance[...]` | — | **2** |
| `audienceTrajectory` / `identity` | 1 / 1 | 0 / 0 |
| `audience[...]` | — | **0** |
| `representation.*`, `dates[...]` | — | 0 |

The evaluator stopped leaning on M.I.A.'s dimension scores as soon as it had something more specific to cite. It never cited `audience[instagram]` (§6).

### 2.3 Mia, opportunity by opportunity

| Run 3 | Run D | what changed |
|---|---|---|
| GROW·audience "rebuild and expand her niche follower base following a period of minor contraction" · rests on findings + `audienceTrajectory` | **GROW·content "increase her Instagram posting frequency to reverse her cooling follower trajectory"** · rests on `contentPerformance[instagram]`, findings, `preferences[onboarding_goal.grow_my_following]` · stance `wants` | a diagnosis with a cause: 0.47 posts/week is cited, not inferred. SUPPORTED |
| — | **UNLOCK·content "reactivate her dormant TikTok channel"** · rests on `contentPerformance[tiktok]` (553 days) | new; entailed by a number State 1.1 did not carry. SUPPORTED |
| AMPLIFY·positioning "elite academic and athletic trailblazer → tech- and education-focused alignments" | GROW·positioning "academic acceleration and tech-oriented studies … EdTech, STEM, enterprise venture" + `commercialPosition.activeRelationships` + intent `get_my_first_deal` | same territory, now tied to intent. SUPPORTED (the "tech-oriented studies" claim still rests on M.I.A.'s rationale, as in Run 3) |
| — | **AMPLIFY·commercial "capitalize on repeated, highly motivated inbound interest from StartX1"** · rests on `inbound[2]`, `[5]`, `[8]` (three StartX1 PAID threads, 2 – 14 Sep), `pipeline`, intent | **the first demand-grounded commercial opportunity for any athlete.** "Repeated" is entailed (three threads in twelve days); "highly motivated" is colour. SUPPORTED |
| AMPLIFY·impact Yuwa | AMPLIFY·impact Yuwa | unchanged |
| UNLOCK·evidence private metrics + Adidas terms | UNLOCK·evidence Adidas historical data | unchanged in substance |
| note: no `commercial` opportunity "because her commercial acceleration is flat by design; she is intentionally prioritizing … Stanford" | note on `relationships`: "she has active representation (Bhuta Management / Spencer Wasworth) … no evidence of friction" | **Run 3's note was an invented motive.** With 200 detected / 7 negotiating / 12 inbound visible, the evaluator no longer explains the absence of commerce by inventing her priorities — it names the commerce. |

### 2.4 Lilia

| Run 3 | Run D |
|---|---|
| GROW·audience parent-supervised socials · findings only | GROW·audience establish channels · findings + **`preferences[onboarding_goal.grow_my_following]`**, stance `wants` |
| GROW·positioning dual narrative with sister Mia | dropped to a note: "cannot be positioned until a public channel exists" — a *better* ordering than Run 3 |
| UNLOCK·evidence Hudl + family YouTube | GROW·evidence resolve missing digital and commercial evidence |
| note: `commercial` "yielded nothing … zero commercial history" | **GROW·commercial "selectively convert active inbound brand interest into her first formal partnership or gifting deal"** · rests on `closedDeals`, `pipeline` (39 detected), intent `get_my_first_deal`, `inbound[9]` (lululemon GIFTING, 2026-07-08) |

Rating the new commercial opportunity **PARTIAL**: everything cited resolves and is true, but "active" overstates twelve threads whose most recent is ten weeks old, and the stance it carries is a fixed-set onboarding choice for a 14-year-old whose guardian's intent State does not hold. The label on the preference line did its work — the evaluator called it her stated goal, not her strategy — but this is exactly the opportunity that should generate an athlete-side question, not proceed on its own.

### 2.5 Riya and LeBron — the control

- **Riya:** 2 → 2; identity disambiguation and a first public channel, in both runs. Domains and citations unchanged in substance (GROW·evidence became UNLOCK·evidence for identity).
- **LeBron:** 4 → 4; the same four openings. `fix-commercial-portfolio-records` moved from `commercial` to `evidence` — the re-domaining the Objective evaluator had already applied in Run 3, now done upstream. The MAINTAIN·athletic opportunity is **still prescriptive** ("proactively manage workloads and physical recovery") — defect #7 from the Run 3 audit, unchanged because the evaluator is unchanged. Recorded, not tuned.

### 2.6 Entailment and value-add, Run D

Grounding 46/46 (Run 3: 35/35). Entailment: **13 SUPPORTED · 2 PARTIAL · 0 UNSUPPORTED** (Run 3: 11 · 2 · 0). The two PARTIAL are Lilia's commercial (above) and LeBron's MAINTAIN (prescription, carried over). Failure layers for what remains weak: Lilia commercial → **athlete-side question** (stance not held); LeBron MAINTAIN → **C, evaluator** (frozen; known). Nothing new in layers A or B was produced by this run.

Strategic value-add, before → after, for Mia specifically: Run 3 said *grow the audience, lean on the scholar narrative, package Yuwa, get the Adidas data.* Run D says *post more than once every two weeks, wake the TikTok that has been dead 18 months, answer StartX1 who has written three times, and the scholar narrative is now a partnership target tied to what you said you want.* Three of the six are things a competent manager reading her inbox and her analytics would say in the first ten minutes — and could not have been said from State 1.1.

---

## 3. Objectives — first run vs Run B, frozen `1.0.0`

| | first run (from Run 3) | Run B (from Run D) |
|---|---|---|
| sets produced | 4 / 4 | **2 / 4** — Mia and Lilia **refused** (§5) |
| proposals | 13 (Mia 4 · Riya 2 · Lilia 3 · LeBron 4) | 5 accepted (Riya 2 · LeBron 3) + 7 drafted-and-refused (Mia 4 · Lilia 3) = 12 |
| proposals citing athlete intent | **0 of 13** | **4 of 12** drafted (Mia 3, Lilia 2 — origin would derive `joint`) |
| `commercial`-domain proposals | 0 | 2 drafted (Mia StartX1, Lilia first partnership) |
| quantified targets read against a real baseline | 1 (LeBron closedDeals 0 → ≥5) | 2 drafted (Mia closedDeals 1 → ≥2; Lilia 0 → ≥1) |
| horizons with a `why` | LeBron only (this_season ×2) | LeBron ×2 + **Mia ×3** (this_season / next_12_months / multi_year) |
| consolidation | none | **LeBron: two `evidence` opportunities → one proposal** (`evidence-integrity-alignment`), accounted `consolidated` |

**Riya:** 2 → 2, same substance. **LeBron:** 4 → 3 by a valid consolidation; the athletic proposal still inherits the prescription.

**Mia's refused drafts**, audited as drafts: `active-audience-expansion` (current state quotes 0.4667 posts/week and 553 dormant TikTok days — entailed); `startx1-commercial-partnership` (from `amplify-inbound-startx1-interest`, intent `get_my_first_deal`, evidence `inbound[2]/[5]/[8]`, target closedDeals ≥ 2 — the first proposal on the frozen four that is *joint* by provenance); `premium-narrative-partnerships` (intent-linked, multi-year); `adidas-performance-evidence` (unchanged from the first run). All four rest on paths that resolve; `groundingProblems` is empty. **Lilia's:** `establish-social-presence` (intent-linked), `secure-first-partnership` (intent-linked, "zero closed despite 39 detected", target ≥ 1), `verify-profile-evidence`.

The first-run finding "13 → 13, 0 notes, intent path at zero for every athlete" is now explained in the way the sufficiency audit predicted: it was ≥ half Type A. Give the evaluator the intent and the demand, and the same prompt uses both.

---

## 4. Invariants that held

- **Inbound never became a deal.** Every proposal and opportunity that mentions inbound interest keeps `closedDeals` at its true count; Mia's StartX1 proposal targets closedDeals *from 1*, not from 12. The renderer's "inbound interest is NOT a deal" line and the validator's no-`amount` rule were both exercised on real data.
- **Intent stayed labelled.** No opportunity or proposal called an onboarding choice an objective; the evaluator's own language was "her stated goal", "aligns with her ambition".
- **A floor was never a market value.** `representation.floors` was rendered for Mia and Lilia and cited by neither evaluator — correct, since nothing here prices.
- **State emitted no EVALUATED value** (validator, on the path, for all four builds).
- **Both digests unchanged.** `canonicalSha256` on every Run D record is `6bcf91ab…`; on every Run B record `d3aba4b5…`.

---

## 5. The gate refusal — a latent defect in the frozen Objective spec

Mia and Lilia's sets were refused: `proposals[n]: athlete_stance.stance invalid: WANTS`. Grounding passed; only the structural gate failed; raw text and parsed proposals are retained.

**Cause, verified in the spec text, not in State:** `objective/evalSpec.ts` writes the vocabulary in uppercase in the prompt — line 67 *"preferences in the state with stance WANTS"*, line 141 *"each path must be a preference with stance WANTS"* — while its structural validator (line 214) accepts only lowercase `wants | open | avoids | refuses`. The Opportunity prompt writes the enum in lowercase (line 183) and its evaluator emitted lowercase in the same run. The State renderer has printed stances uppercase since 1.0.0; that is unchanged.

**Why it never fired before:** no athlete on the frozen four had a `wants` preference until State 1.2 projected onboarding intent, so the Objective evaluator had never emitted `athlete_stance` at all. It is a PR3a defect exposed by State 1.2, not created by it.

**Not fixed here**, per "do not tune after this run". The fix is a deliberate `objective-eval-spec/1.0.1` — amend the two prompt lines to the lowercase enum (methodology text changes → digest changes → unpin, parity, repin) — or, alternatively, case-fold the enum in the structural validator, which is a normalisation change and should also be versioned. Either is a one-line decision for the next step; I recommend the prompt amendment, because the validator's vocabulary is the contract's and the prompt should match it, not the other way round.

---

## 6. What did not improve, and why

| | why | layer |
|---|---|---|
| **`audience[instagram]` rendered, never cited** (Mia: 69% US, 18–24 30%, F 38%) | the evaluator had it and did not use it for any of six openings. Either composition is not decision-relevant for these particular openings, or the prompt gives it no role. Not tuned; noted as the first candidate for a targeted question ("is a 69%-US, mixed-gender audience a positioning fact for an EdTech alignment?") | evaluator, or genuinely immaterial — undetermined |
| **no dates, for anyone** | not recorded anywhere (§1). Timing stays Type A | A — information absent |
| **Riya and LeBron unchanged** | nothing new existed for them; the intent, inbox and audience tables are empty. The system cannot reason about what Nomila does not hold | A |
| **Lilia's commercial opportunity proceeds on a 14-year-old's onboarding tick** | State holds no guardian stance; the label was honoured but the question was not asked | athlete-side question (the seam in the targeted-intelligence audit §5) |
| **LeBron MAINTAIN still prescribes** | frozen evaluator; known | C |

---

## 7. Recommendation (no action taken)

1. Cut `objective-eval-spec/1.0.1` for the enum case (§5), rerun **Objectives only** on the retained Run D pairs — no new Opportunity call — and confirm Mia and Lilia's sets pass both gates as drafted.
2. Then the athlete-question step from the targeted-intelligence audit §5, starting with the two cases this run produced: Lilia's guardian stance on commercial entry; Mia's audience composition as a positioning fact.
3. Targeted research (Opportunity 1.1) after that, unchanged in scope: the three B-class questions still stand, and this run did not add to them.
