# 09 — Cross-athlete pressure test (Agent I)

**Question:** does Nomila genuinely behave differently because the athlete is different?
**Method:** existing artifacts only, plus read-only dev DB SELECTs (via the Cloud SQL proxy on :5440; the scripts `_audit_q_I_db*.ts` were deleted afterwards). No provider calls. Working tree = `3f0139f6` (manifest Brain tip). Matrix with quotes: `16-cross-athlete-matrix.md`.

Abbreviations: **OVC** = `docs/audits/artifacts/objective-validation-cohort/` · **CIB** = `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/`.

---

## 1. Summary

1. **Only Mia has the full lineage.** Dev DB: `objective_proposal_sets` 3 rows, `objectives` 5 rows, `brain_runs` 1 row, `recommendations` 3 rows, and **every one belongs to Mia** (`select a.full_name, … from objective_proposal_sets|objectives|brain_runs|recommendations join athletes …`). No other athlete has a governed Objective or a standing Brain Recommendation. So the evidence **cannot show** that Brain Recommendations vary by athlete type. *Brain loop: EXPERIMENTAL · DEV_ONLY (one row) · `BRAIN_SUBSTRATE_LOOP=off`.*
2. **Upstream, the content is clearly athlete-specific.** Across 10 athletes (Opportunity `1.0.0`) and 6 athletes (Objective `1.0.4`), the outputs are built around each athlete's own named assets: Ronaldo's "UR · Cristiano" channel and the NFT lawsuit, Ledecky's POTS memoir and her Pan Pacs defeats, Maher's Medalist Skin / House of Maher / Hello Sunshine, Flau'jae's Roc Nation + Unrivaled stake, Street's Academy + NBC role, Mia's Yuwa / StartX1 / gorjana. None of these appears for any other athlete (OVC `opportunity/*.json`, `objective-1.0.4/*.json`; `opportunity-1.0.0-run-d/*.json`). *Opportunity/Objective evaluators: EXPERIMENTAL · OPEN_PR (#626–#665 stack) · test-harness-only for every athlete except Mia.*
3. **Sport, career stage and commercial position do change the outputs.** Examples: Street's athletic note ("retired from competition since 2002") and her post-career territory (broadcasting, Academy); Ronaldo gets post-playing structure and equity over licensing, not audience growth; Ledecky's athletic domain is left to "elite national governing bodies"; Lilia (14) gets "owned_venture … premature"; Maher gets MAINTAIN athletic re-entry. Cited in §3.
4. **The structure is templated, and the template shows at the sparse end.** Opp `1.0.0`: 15 of 42 openings were knowledge-shaped ("connect / reconcile / verify"). That happened for **10 of 10** athletes whatever their data density. "Connect [her] … accounts" opened 5 statements across 5 athletes. "Establish …" (a presence, channels, an identity) was the opening for **4 athletes, 3 of them LOW-confidence States** (Okpara, Lilia, Riya) plus Street. §4.
5. **Sparse data produces restrained content but confident labels.** Riya gets 2 openings and 8 "why nothing" notes, so the evaluator held back. Even so, **82 of 83** recorded Opportunity openings are `confidence: HIGH`, including every opening for the LOW-State athletes (Okpara, Street, LeBron, Riya, and Lilia apart from one run-1 opening). **111 of 114** Objective proposals are HIGH. The confidence field does not track data density. §5.
6. **Knowledge boundaries visibly help, and they help every athlete.** Objective `1.0.2` removed all 9 "Nomila's data need" proposals across the 6 cohort athletes (24 → 17). `1.0.4` removed all "lacks recorded…" and "concentrated" baselines (0 E/F in 14). Verified from OVC artifacts. *Objective 1.0.4: EXPERIMENTAL · OPEN_PR · test-harness-only.*
7. **But Opportunity `1.2.0` has only ever run on Mia (1 call).** For the other athletes the Opportunity boundary exists only as an offline re-gate that refused 35 historical evidence openings (re-verified: 35). Flau'jae's `fix-missing-commercial-records` is filed under `commercial`, so the structural gate cannot catch it; only the semantic rule would, and that rule has never been run on her. *Opportunity 1.2.0: EXPERIMENTAL · OPEN_PR · test-harness-only (Mia-only).*
8. **Neither boundary has reached a live Brain run.** The dev Brain run `f9e00c6f…` (`0.12.0-exp`) read `opportunity-map/1.0.0` with `specVersion opportunity-eval-spec/1.0.0`, and Mia's live Objectives come from `objective-eval-spec/1.0.1` sets (`select spec_version, opportunity_map->>'version' from objective_proposal_sets` → 3 × `1.0.1` / `opportunity-map/1.0.0`). *BUILT (spec) ≠ on the live path.*
9. **Mia's three live Recommendations mostly restate Opportunity `1.0.0` and drift from her own edits.** The TikTok `what` shares 92% of its content words with the `unlock-tiktok-channel` opening, and only 8% with her modified Objective ("…across Instagram and TikTok"). The positioning `what` ("EdTech, STEM, and technology venture sectors") drops the "AI, innovation and entrepreneurship" she wrote into Objective `c0f587e4`. All three are `RECOMMEND · specialized_plan · new_work`. §6.
10. **The only cross-athlete Brain evidence is a controlled fixture.** The same synthetic term sheet (USD 5,000 for 4 Instagram posts) went to Ronaldo (CIB `C0/C2`) and Lilia (`D0/D2`) with **zero live Objectives**. Answers differed by athlete: Ronaldo got a decline at `0.4.0`/`0.6.0`, citing 679 M followers and USD 65 M off-field; Lilia got REQUEST_INTELLIGENCE on whether she would run a public Instagram. At `0.6.1`/`0.8.0` Ronaldo's answer became a generic "request a rate card" (`NOT_ESTABLISHED`). Stricter contracts made that answer *less* athlete-aware. §6.2.
11. **With no live Objectives, the Brain has nothing to decide.** Every non-Mia Brain artifact has `decisions: []` and answers only the injected request (CIB `C0,C2,D0,D2` `record.parsed`). For any athlete who has not governed Objectives, Nomila's strategy layer produces nothing today. That is by design; §7 covers what it means for a cohort test.
12. **Other layers do show athlete sensitivity, measured differently.** M.I.A. Beta.1 was validated on a 37-athlete cohort (Spearman 0.887, `docs/architecture/phase-a/README.md:16`). Rate 2.0 (8 athletes) declined all 11 products for Riya but priced Mia's dormant TikTok; LeBron's session prices were unstable (`docs/audits/rate-2.0-cohort-run.md`). *Rate 2.0: EXPERIMENTAL · not production (per the report).*
13. **The sparse athlete ends in a refusal at the frozen spec.** Okpara's `1.0.4` set was refused at Gate 2 (an accounting double-listing), so at the accepted spec he has **0 Objectives** (OVC `objective-1.0.4/Chisom_Okpara.json` `groundingProblems`). Riya, the truly footprint-less case, was never run past Objective `1.0.1`.
14. **One prior claim is numerically wrong.** `objective-1.0.4-cohort-evaluation.md:191` says confidence was "uniformly HIGH across 1.0.2/1.0.3/1.0.4 (46 of 46 gated)". Street's 1.0.2 `expand-platform-footprint` is MEDIUM, so the true figure is 45 of 46 (OVC `objective-1.0.2/Picabo_Street.json`).

---

## 2. Athlete inventory (who has what)

| athlete | M.I.A. runs (dev) | research_state (dev) | State artifact | Opportunity artifacts | Objective artifacts | governed Objectives (dev) | Brain |
|---|---|---|---|---|---|---|---|
| **Mia** | 4 | **none** | yes (run-d, 1.1.0, 1.2.0) | 1.0.0 ×4, 1.1.0, **1.2.0** | 1.0.0 ×2, 1.0.1 ×2 | **5** (3 active modified · 1 deferred · 1 declined) | ~45 experiment artifacts + 1 dev `brain_runs` + 3 recs |
| Lilia (tester) | 3 | none | yes | 1.0.0 ×4 | 1.0.0 ×2, 1.0.1 | 0 | CIB `D0`, `D2` (`0.4.0`, fixture request) |
| LeBron | 3 | 1 | yes | 1.0.0 ×4 | 1.0.0 ×2, 1.0.1 | 0 | none |
| Riya | 3 | 1 | yes | 1.0.0 ×4 | 1.0.0 ×2, 1.0.1 | 0 | none |
| Ronaldo | 2 | 1 | OVC | 1.0.0 | 1.0.1, 1.0.2, 1.0.3, 1.0.4 | 0 | CIB `C0`, `C2` (`0.4.0`), `C2` at `0.6.0`, `0.6.1`, `0.8.0` |
| Ledecky | 2 | 1 | OVC | 1.0.0 | 1.0.1–1.0.4 | 0 | none |
| Maher | 2 | 1 | OVC | 1.0.0 | 1.0.1–1.0.4 | 0 | none |
| Flau'jae | 2 | 1 | OVC | 1.0.0 | 1.0.1–1.0.4 | 0 | none |
| Okpara | 2 | **none** | OVC | 1.0.0 | 1.0.1–1.0.3; 1.0.4 **refused** | 0 | none |
| Street | 2 | 1 | OVC | 1.0.0 | 1.0.1–1.0.4 | 0 | none |
| 35 others (16 Sep M.I.A. batch, e.g. Caitlin Clark, Livvy Dunne, Shohei Ohtani, Marta) | 1 each | most 1 | none | none | none | 0 | none |

Sources: dev DB `mia_evaluation_runs`, `athlete_research_state`, `objectives`, `brain_runs` grouped by `athletes.full_name`, and `ls docs/audits/artifacts/*`. The dev `athletes` table has 57 rows, including test and placeholder rows. **Chosen set (7):** Mia (college, rich Nomila-owned data) · Flau'jae (college → pro, dual career) · Ronaldo (established team-sport pro) · Ledecky (individual-sport star) · Maher (creator/business identity) · Okpara (sparse) · Street (post-career). LeBron, Riya and Lilia appear as supplementary rows in the matrix. Riya is the truest low-evidence case, and Lilia is the only non-Mia athlete with Nomila-owned data and a Brain artifact.

---

## 3. Does the athlete change the output? (per axis)

| axis | evidence it changes the output | evidence it does not |
|---|---|---|
| **Sport / calendar** | Ledecky's athletic note: "managed natively by elite national governing bodies". Maher: MAINTAIN re-entry "this_season" to the US Sevens. LeBron: "maintain-physical-durability" (24th season, 17 missed games). Street: "athletic career is inactive (retired … since 2002)". Sources: OVC `opportunity/*.json` notes; `opportunity-1.0.0-run-d/LeBron_James.json` | `identity.competitionContext` is null for all 5 pros (only Okpara and Mia have affiliation rows, OVC §4 of `objective-validation-cohort.md:229`), so sport shows up only through M.I.A. prose |
| **Career stage** | Ronaldo: `grow-post-retirement-framework`. Street: year-round broadcasting. Flau'jae: career "first rookie season; no post-playing ambitions recorded". Lilia: "owned_venture … premature for a 14-year-old". Mia: career "premature" | Flau'jae's music career was squeezed into `positioning` (the C-minor domain gloss, `objective-validation-cohort.md:126`), so a second profession is not expressed as its own trajectory |
| **Data density** | Riya 2 openings / 8 notes. Okpara 2 of 4 openings in evidence, 6 notes. Mia 6 openings citing inbound/pipeline/intent (State 1.2 audit: 18 of 46 citations went to new Nomila-owned sections, `state-1.2-frozen-four-audit.md:15`) | Confidence labels stay HIGH at every density (§5). The evidence-domain opening appears for all 10 athletes |
| **Commercial position** | Ronaldo: equity over licensing ("commercial … we defer"). Okpara: first direct partnership, quantified `closedDeals 0 → ≥1`. Lilia: "first formal partnership or gifting deal". Mia: StartX1 / gorjana conversion. Ledecky: "capacity for new sponsorships cannot be verified" | Under Opp 1.0.0, Nomila's zero-deal count still drove the commercial reasoning for Ronaldo, Ledecky, Maher and Street ("gated by resolving evidence gaps"). Commercial openings were deferred behind Nomila's own records rather than the athlete's world |
| **Creator / business identity** | Maher: 5 distinct domains (the richest map). Flau'jae: Unrivaled equity. Street: Academy sponsors | Owned-venture desired states converge on one template: "expanded … portfolio / multi-partner / structured tiers" (Maher podcast, Street Academy, Ronaldo equity; §4) |

**Verdict at Opportunity/Objective: PARTIALLY athlete-specific.** The subjects, assets, domains chosen and domains declined are specific to each athlete. The move applied to each asset is mostly one of a few templates.

---

## 4. Recurrence counts (templates vs specifics)

Computed by script over `record.parsed` (Opp: OVC `opportunity/` ×6 + `opportunity-1.0.0-run-d/` ×4, all `opportunity-eval-spec/1.0.0`; Obj: OVC `objective-1.0.4/` ×6 and `objective/` + `objective-1.0.1-run/` ×10).

**Opportunity statements (10 athletes, 42 openings)**

| measure | count |
|---|---|
| kinds | AMPLIFY 14 · UNLOCK 11 · GROW 11 · FIX 3 · MAINTAIN 3 |
| domains | **evidence 14** · positioning 5 · content 5 · commercial 4 · owned_venture 4 · career 3 · audience 3 · athletic 2 · impact 2 · relationships **0** |
| knowledge-shaped openings (evidence domain + Flau'jae's commercial FIX) | **15 of 42, present for 10 of 10 athletes** |
| "private metrics / private accounts" UNLOCK | 7 of 10 athletes (Ronaldo, Ledecky, Maher, Flau'jae, Street, Okpara, LeBron) |
| opening word | connect 5 · leverage 5 · scale 3 · integrate 3 · secure 2 · build 2 · expand 2 · reconcile 2 · protect 2 · establish 2 · 14 singletons |
| athletes whose statements contain "leverage" | 6 of 10 · "integrat-" 6 · "connect" 6 · "platform" 5 · "expand" 4 · "sponsor" 4 · "partnership" 4 · "establish" 4 (Okpara, Street, Lilia, Riya) |
| "CSR / corporate social" | **Mia only** (1 of 10). The CSR framing is not a template; it comes from her Yuwa evidence |

**Objective desired states**

| measure | 1.0.1 (10 athletes, 38) | 1.0.4 (6 athletes, 15 incl. refused Okpara) |
|---|---|---|
| evidence-domain proposals | 13 | 0 |
| athletes with "verified" in a desired state | **8 of 10** | 0 |
| athletes with "platform" | 7 of 10 | 2 of 6 |
| athletes with "partnership" | 6 of 10 | 1 of 6 |
| "expand/expanded" | 1 | 2 (Maher ×2, Street) |

**Reading.** The generic "make Nomila's data complete" template (connect / verify / reconcile) was the single most recurrent structure. It was athlete-independent, and it is exactly what the knowledge boundaries removed (Objective `1.0.2` and later; Opportunity `1.2.0` for Mia only). What remains after `1.0.4` is athlete-specific in subject but shares an AMPLIFY → "expanded / diversified / structured / multi-partner" grammar. Examples: Maher "an expanded, multi-partner commercial sponsorship model"; Street "an expanded portfolio of corporate partners and structured commercial sponsorship tiers"; Ronaldo "a fully diversified programming network". "Leverage narrative" as a phrase: "leverage" opens 5 Opp statements, and "narrative" appears for only 2 athletes (Maher, Ledecky), so it is not a dominant template. "Expand platform presence" appears as a generic GROW for sparse or low-digital athletes: Street TikTok/X (feasibility low), Lilia "establish social media channels", Riya "establish-foundational-digital-presence".

---

## 5. Sparse data → confident-sounding output

| athlete | State conf | Opp openings (HIGH) | Obj proposals (HIGH) | what the sparse athlete actually got |
|---|---|---|---|---|
| Riya | LOW | 2 (2) | 1.0.1: 2 (2) | "Resolve the identity discrepancy between regional profiles…" · "Set up and launch a single, verified public digital channel…" (both HIGH). Content is honest; confidence is not |
| Okpara | LOW | 4 (4) | 1.0.1: 3 (3) → 1.0.2: 2 → 1.0.3: 1 → 1.0.4: **refused set** | Positioning on "Ivy League and Stanford academic pedigree" is supported by cited E1 (OVC report §2.5). The 1.0.2/1.0.3 baselines read Nomila's zero as his ("zero closed deals … on record") |
| Street | LOW | 4 (4) | 1.0.1: 1 HIGH + 2 MEDIUM (the only sub-HIGH in any cohort) | GROW TikTok/X at feasibility "low" but confidence HIGH. Carried at 1.0.2 (MEDIUM), declined at 1.0.1/1.0.3/1.0.4: run-to-run variance on the same inputs |
| Lilia | LOW | 3 (3) | 1.0.1: 3 (3), set **refused** (`athlete_stance.stance invalid: WANTS`) | "Establish public-facing personal social media channels…" |
| LeBron | LOW | 4 (4) | 1.0.1: 4 (4) | "Leverage LeBron's massive cross-platform reach to maximize … football-focused content" rests on one M.I.A. finding |

Totals, re-verified: Opportunity openings HIGH **82 / 83** across all recorded maps. The lone non-HIGH is Lilia `amplify-athletic-narrative` MEDIUM in `opportunity-1.0.0-run`. Objective proposals HIGH **111 / 114** (script over all 8 objective artifact dirs). **The sparse cases hold back on content (fewer openings, many "why nothing" notes) but not on stated confidence.** That matters at the product surface if confidence is ever shown or used for gating.

---

## 6. Brain: what exists

### 6.1 Mia, the only governed case (dev DB)

| Objective (her governed wording) | Brain `what` (`0.12.0-exp`, run `f9e00c6f`) | nearest Opp 1.0.0 statement | overlap of `what` with Opp / with her Objective |
|---|---|---|---|
| `feb62891` audience: "Grow my audience and build a stronger, more consistent presence across Instagram and TikTok." | "Reactivate her dormant TikTok channel to engage short-form video audiences and expand her platform reach." | `unlock-tiktok-channel`: "Reactivate her dormant TikTok channel to re-engage short-form video audiences and expand her platform breadth." | **0.92 / 0.08** |
| `c0f587e4` positioning: "…intersection of athletics, technology, AI, innovation and entrepreneurship…" | "Target brand partnerships and ambassador roles within the EdTech, STEM, and technology venture sectors that align with her academic positioning." | `grow-academic-tech-partnerships`: "…premium brand partnerships in EdTech, STEM, and enterprise venture spaces." | 0.50 / 0.29 |
| `b1c799e3` impact: "Expand the impact and visibility of my work with Yuwa through aligned global brand and CSR partnerships." | "Target global brand and corporate social responsibility partnerships that align with her philanthropic leadership at the Yuwa girls empowerment program." | `amplify-yuwa-philanthropic-work`: "…to attract global Corporate Social Responsibility (CSR) sponsorships." | 0.57 / 0.29 |
| `2d199757` commercial (deferred): StartX1 | REQUEST_INTELLIGENCE ("Requesting the brand's profile and alignment…") | — | — |

Overlap = the share of the `what`'s content words (stop-words removed) that also appear in the source text. All three decisions are `RECOMMEND · specialized_plan · new_work`, and each cites the Opportunity key (`value.cites`). **Reading:** the Recommendations are athlete-specific because the Opportunity map was. The Brain's added contribution in this run is choosing among openings and setting the path. The athlete's own governance edits (AI / entrepreneurship; Instagram) are **not visible** in the `what`. *Brain `0.12.0-exp`: EXPERIMENTAL · OPEN_PR · deployed-dev (one run).*

### 6.2 Non-Mia Brain artifacts (controlled fixture, zero live Objectives)

| cell | spec | athlete | answer to the same USD 5,000 / 4-post term sheet | grounds |
|---|---|---|---|---|
| CIB `arm/C0`, `arm/C2` | 0.4.0 | Ronaldo | **decline** ("extremely undervalued for an athlete of Ronaldo's commercial magnitude"). Both sets **refused** at gate (id formatting) | `findings[mia.audience_scale]` 679 M · `findings[mia.cultural_relevance]` USD 65 M |
| `slice/arm-060/C2` | 0.6.0 | Ronaldo | decline ("advise the athlete's agent to decline") | same |
| `slice/arm-061/C2` | 0.6.1 | Ronaldo | **REQUEST_INTELLIGENCE**: "A defined rate card or minimum floor price has been set…" | `.range`/`.band` NOT_ESTABLISHED |
| `slice/arm-080/C2` | 0.8.0 | Ronaldo | REQUEST_INTELLIGENCE, `need: athlete_commercial_basis` | same + `pricingEvidence` |
| CIB `arm/D0`, `arm/D2` | 0.4.0 | Lilia | REQUEST_INTELLIGENCE: "Lilia Bhuta is willing and plans to launch a public-facing personal Instagram account…" | `findings[mia.audience_scale]`, `materialGaps[0]`, `preferences[onboarding_goal.get_my_first_deal]` |

The Brain answered differently for different athletes (scale-based decline vs deliverability question), and that is real evidence of athlete sensitivity **on a request**. After `0.6.1` the Ronaldo answer turned on a rule (NOT_ESTABLISHED → request) rather than on who he is. Whether asking Ronaldo for a rate card to judge a USD 5,000 offer is product-acceptable is a founder/lead judgment, not made here (`docs/audits/commercial-intelligence-boundary-experiment.md:101,122`; `brain-0.8.0-exp-c2-need-confirmation.md:13`).

**Standing decisions for non-Mia athletes: none exist.** `decisions: []` in all six non-Mia artifacts. `brainRun.ts` reads live Objectives only from the DB (`server/scripts/intelligence/brainRun.ts:44`, `liveObjectives`), and it has no Objective overlay flag (flags listed at `:7–26`).

---

## 7. Proposed empirical cohort (NOT run)

**Why the existing evidence is insufficient.** One athlete has governed Objectives. Brain-level variation by athlete type is **UNKNOWN — no governed Objective / Brain run exists** for anyone else.

**The governance constraint.** The six cohort athletes and LeBron/Riya are public figures, not Nomila users. Nobody can accept Objectives on their behalf, and writing `objectives` rows for them on dev would manufacture governance, which the control file forbids. The honest options:

| option | real governance? | athletes | status |
|---|---|---|---|
| A. Real users only | yes | Mia + Lilia (after her planned delete-and-fresh-signup, she governs her own set) | Lilia's re-signup is deliberately last in the test order. Two soccer athletes from one family is not a type spread |
| **B. Harness-only simulated governance (recommended)** | **no, and labelled so** | Mia (control) + the 6 OVC athletes | needs a `--objectives-fixture` flag in `brainRun.ts`, analogous to `--work-overlay` ("marked controlled in the artifact"). Nothing written to `objectives`. Every artifact carries `governance: SIMULATED — no athlete review` |
| C. No-Objective run | n/a | any | the output is `decisions: []` by construction. It shows only that the Brain is inert without governance, which is already established |

**Option B design.**
- **Inputs:** for each of the 6 OVC athletes, first rerun Opportunity `1.2.0` (6 calls) and then Objective `1.0.4` from those maps (6 calls, which also re-derives Okpara's refused set), so the Brain sees the *current* boundaries. Then treat every gated 1.0.4 proposal as `accepted (SIMULATED)`, with verbatim wording and no founder edits. Mia's arm uses her real governed Objectives, so there is a control with real edits.
- **Brain calls:** 7 athletes × 2 repetitions at `0.12.0-exp` = **14** (two repetitions separate a 2/2 decision from variance, the Rate 2.0 rule, `rate-2.0-cohort-run.md`). Context block: none for the six, because Context Intelligence was hand-assembled for Mia only. That is a known confound; record it.
- **Cost:** Brain ~USD 0.03 × 14 ≈ **0.42** (recorded `costUsd` 0.029 for `f9e00c6f`). Opportunity ~0.024 × 6 ≈ 0.14. Objective ~0.017 × 6 ≈ 0.10. **Total ≈ USD 0.66, 26 calls.**
- **Measures:** (i) the decision and execution-path mix per athlete; (ii) the echo rate, meaning `what`-to-source-Opportunity content-word overlap (Mia's baseline is 0.50–0.92); (iii) a blind swap test, where a reviewer matches each `what` to its athlete; (iv) pre-registered predictions from the cohort report: Maher `athletic-reentry-sevens` → NO_ACTION (`objective-validation-cohort.md:105`); Street's broadcasting → RECOMMEND; the sparse athlete → REQUEST_INTELLIGENCE, not invented strategy.
- **What would change a decision:**
  - *If* every decision is `RECOMMEND · specialized_plan · new_work` for every athlete *and* the echo rate is above ~0.6, the Brain is a pass-through of the Opportunity map. In that case stop iterating the Brain spec and invest in Opportunity quality, planners and Context.
  - *If* decisions diverge sensibly (NO_ACTION where the athlete owns the outcome, REQUEST where evidence is thin) and the blind swap succeeds, the Brain is adding athlete-level judgment, and live activation for a second real user (Lilia) is worth prioritising.
  - *If* the Ronaldo pattern recurs (rule-driven REQUEST for a saturated athlete), the NOT_ESTABLISHED rule needs a boundary decision before any pro athlete is onboarded.

---

## 8. Prior findings re-verified

| prior finding | source | status | evidence |
|---|---|---|---|
| 27 opps → 24 proposals; 9 of 24 are Nomila-data needs | `objective-validation-cohort.md:246` | **STILL TRUE** | counted from OVC `opportunity/`, `objective/` (4+5+4+6+4+4; 3+5+4+5+4+3; 8 evidence + `verify-commercial-records`) |
| 7 manufactured gaps across 4 athletes under AMPLIFY | same §3.2 | **STILL TRUE** (for 1.0.1 artifacts); **SUPERSEDED** as behaviour by 1.0.4 | quotes match OVC `objective/*.json` current_state; 1.0.4 baselines are all A/B/C |
| 1.0.2: 24 → 17, 10/10 knowledge opps not carried | same §7.3 | **STILL TRUE** | OVC `objective-1.0.2/` (2+4+2+4+2+3) |
| 1.0.3: 15 proposals, two Flau'jae "lacks recorded" failures | `objective-1.0.3-cohort-rerun.md:5,27–28` | **STILL TRUE** | OVC `objective-1.0.3/Flau'jae_Johnson.json` |
| 1.0.4: 14 gated, 0 E/F, Okpara refused | `objective-1.0.4-cohort-evaluation.md:3,138` | **STILL TRUE** | OVC `objective-1.0.4/`; Okpara `groundingProblems` accounting |
| "Confidence uniformly HIGH … 46 of 46 gated" | `objective-1.0.4-cohort-evaluation.md:191` | **INCORRECT (45 of 46)** | Street 1.0.2 `expand-platform-footprint` MEDIUM |
| Confidence HIGH 22/24; Street's two MEDIUM | `objective-validation-cohort.md:220` | **STILL TRUE** | OVC `objective/Picabo_Street.json` |
| 1.2.0 historical re-gate = 35 refusals | `opportunity-1.2.0-knowledge-boundary-forcing.md:15` | **STILL TRUE** | recount: run 8 · run-b 7 · run-c 5 · run-d 5 · cohort 9 · treatment 1 = 35 |
| "Nothing structurally Mia-specific on the path" | `objective-validation-cohort.md:234` | **CANNOT VERIFY at this manifest** (not re-grepped by this agent); consistent with outputs: no Mia asset appears in any other athlete's output (§4, CSR = Mia only) | — |
| State 1.2: Riya and LeBron maps unchanged in substance (control) | `state-1.2-frozen-four-audit.md:14` | **STILL TRUE** in shape (Riya 2 openings, LeBron 4) | `opportunity-1.0.0-run-c` vs `-run-d` counts |
| CI boundary: Ronaldo declined from research, block not consumed; Lilia request | `commercial-intelligence-boundary-experiment.md:101–102` | **STILL TRUE**; **PARTIALLY SUPERSEDED** by 0.6.1/0.8.0 (Ronaldo → REQUEST) | CIB `slice/arm-061`, `arm-080` |
| Rate 2.0: Riya declined all 11 (2/2) | `rate-2.0-cohort-run.md` | **CANNOT VERIFY** here (did not decompress `runs.jsonl.gz`) | — |

---

## 9. UNKNOWNs

- **Whether Brain Recommendations vary by athlete type:** UNKNOWN — no governed Objective / Brain run exists for anyone but Mia. Settled by §7 option B (or real governance by a second user).
- **Opportunity `1.2.0` on any athlete but Mia:** UNKNOWN. Six calls would settle it; Flau'jae's commercial-domain FIX is the discriminating case.
- **Whether the Brain honours the athlete's modified Objective wording rather than the Nomila opening:** one datum (Mia, 3 Recommendations), all leaning toward the opening. A second governed athlete with edits would settle it.
- **How `identity.competitionContext` renders a club, national programme or governing body:** untested; no pro athlete has an affiliation row (`objective-validation-cohort.md:229`).
- **Confidence behaviour when an unknown is material:** unexercised (`objective-1.0.4-cohort-evaluation.md:169`).
- **Mia's `research_state`:** dev has no `athlete_research_state` / `research_runs` row for Mia, Lilia or Okpara, yet the Brain inputs carry a `research` block. Where Mia's research comes from was not traced here; another agent or the lead should settle it.

## 10. Open questions for the founder

1. Is a **labelled, harness-only "simulated governance"** Brain cohort (§7 B, about USD 0.66) acceptable as evidence, or must cross-athlete Brain evidence wait for a second real user's own governance?
2. When the Brain's `what` restates Nomila's original Opportunity rather than the wording the athlete edited into her Objective, which should win? (Mia's positioning: "AI, innovation and entrepreneurship" vs "EdTech, STEM".)
3. For a commercially saturated athlete, is "request a rate card before judging a USD 5,000 offer" (Brain 0.8.0) the intended behaviour, or should researched scale suffice (0.4.0/0.6.0)?
