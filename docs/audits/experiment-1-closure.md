# Experiment 1 — closure: Objectives on State 1.2 under `objective-eval-spec/1.0.1`

**Owner:** Mia
**Date:** 2026-09-23
**Question under test:** *Does exposing information Nomila already possesses materially improve strategic intelligence without changing evaluator reasoning?*
**This step:** the enum-case defect fixed as a deliberate `objective-eval-spec/1.0.1` (commit `98c77af2`, digest `d3aba4b5… → 5c9087b8…`, three casing changes and nothing else); the Objective evaluator rerun **only**, on the exact retained Run D `{state, map}` pairs (`opportunity-1.0.0-run-d`). State not rebuilt; Opportunity not rerun; no upstream artifact altered; nothing tuned after the result.

Artifacts: `docs/audits/artifacts/objective-1.0.1-run/`. Cost $0.090.

---

## 1. Result

| athlete | opps in | set | proposals | intent-cited | origins | horizons | notes |
|---|---|---|---|---|---|---|---|
| **Mia** | 6 | **accepted** | **5** | 3 | joint 3 · nomila 2 | this_season 1 · next_12_months 1 · multi_year 1 · null 2 | 0 |
| **Riya** | 2 | accepted | 2 | 0 | nomila 2 | this_season 1 · next_12_months 1 | 0 |
| **Lilia** | 3 | **refused** (gate 1) | 3 drafted | 2 (drafted) | would derive joint 2 · nomila 1 | null 3 | 0 |
| **LeBron** | 4 | accepted | 4 | 0 | nomila 4 | this_season 2 · null 2 | 0 |
| **total** | 15 | 3 / 4 | 11 accepted + 3 drafted | 5 of 14 | joint 5 · nomila 9 · athlete 0 | this_season 4 · next_12 2 · multi_year 1 · null 7 | 0 |

**Lilia's set was refused again**: `athlete_stance.stance invalid: WANTS` ×2. Grounding passed; raw and parsed proposals retained. **This is my diagnostic error from the previous audit, not a new defect** — see §2. Her three drafts are audited below as drafts.

### 1.1 Opportunity → Objective cardinality, consolidation, not-carried

| athlete | opps → proposals | consolidation | not carried |
|---|---|---|---|
| Mia | 6 → 5 | **`grow-instagram-posting-cadence` + `unlock-tiktok-channel` → `active-multiplatform-audience-growth`** (both cited as the proposal's provenance, so no note is required by the accounting rule) | none |
| Riya | 2 → 2 | none | none |
| Lilia | 3 → 3 (drafted) | none | none |
| LeBron | 4 → 4 | none — the 1.0.0 Run B consolidation of the two `evidence` openings did not recur | none |

Every opportunity accounted for exactly once in all four; **0 not-carried**, 0 notes. Same as the first run: the evaluator carries everything it is given. The one consolidation is a good one — two content openings on the same intent became one audience outcome.

### 1.2 Athlete intent, origins, and whether onboarding `wants` stayed contextual

Five proposals cite `preferences[onboarding_goal.*]`; all five also cite an opportunity, so all derive **`joint`**. Zero `athlete`-origin proposals: nothing was created from intent alone, which is correct — a fixed-set onboarding tick is thin evidence and the evaluator did not build on it without an opening.

How the evaluator described the intent citations, verbatim: *"her explicitly recorded onboarding choice to grow her following"*, *"her onboarding choice to secure brand deals"*, *"the athlete explicitly stated a preference to grow her following"*. It named the source as an onboarding choice in three of five and as a stated preference in two. **No proposal promoted the tick into current strategic truth**: no desired state asserts "she wants X" as fact; the tick appears only in provenance and in `athleteStance`. The renderer's label did its work.

The residual concern is unchanged from the previous audit: Lilia's `secure-first-partnership` rests on a 14-year-old's onboarding tick with no guardian stance in State. Per instruction, **not resolved by inference** — it stays as the evidence that an athlete-question path is needed.

### 1.3 Entailment and grounding

Grounding: all 14 proposals resolve every path (Lilia's `groundingProblems` is empty). Entailment, proposal by proposal:

| | verdict | note |
|---|---|---|
| Mia audience (joint) | SUPPORTED | "less than once a week" ← 0.47 posts/wk; "dormant over 500 days" ← 553; cooling ← `audienceTrajectory` |
| Mia StartX1 (joint) | SUPPORTED | three PAID threads cited; success is a signed contract. Horizon-why says *"while sponsor budgets are active"* — **invented external claim**, in the `why` field only |
| Mia academic/tech (joint) | SUPPORTED | "a sportswear brand and lifestyle gifting" ← Adidas (M.I.A. rationale) + gorjana (activeRelationships). Horizon-why *"developing outreach materials"* — **prescription leakage in `why`** |
| Mia Yuwa (nomila) | SUPPORTED | unchanged from first run |
| Mia Adidas data (nomila) | SUPPORTED | unchanged |
| Riya identity, Riya presence | SUPPORTED ×2 | current states quote their own citations inline — a new, harmless habit |
| Lilia channels (draft, joint) | SUPPORTED | |
| Lilia first partnership (draft, joint) | **PARTIAL** | "active inbound interest" — the twelve threads are ten weeks old; `pipeline` (39 detected) and `closedDeals` (0) are true |
| Lilia evidence (draft, nomila) | SUPPORTED | |
| LeBron IG data, LeBron records | SUPPORTED ×2 | |
| LeBron athletic (nomila) | **PARTIAL** | "76ers", "age 41", "17 games", "sciatica" are all in the state block (M.I.A. rationale) — grounded. But *"active medical alignment"* in the horizon-why is **prescription leakage**, inherited from the still-prescriptive frozen Opportunity |
| LeBron football content (nomila) | SUPPORTED | Polymarket and $15M are in the block |

**11 SUPPORTED · 2 PARTIAL · 0 UNSUPPORTED · 0 invented preferences.** Both PARTIALs are carried over from the Opportunity layer (Lilia's "active", LeBron's prescription), not introduced here.

### 1.4 Prescription leakage

Desired states and success conditions: **none** open with an execution verb (gate enforced, and none tripped it). Leakage confined to the free-text `horizon.why` field in three places (Mia ×2 light, LeBron ×1). Recorded; not tuned. If it matters later, `why` is the field to constrain — a `1.0.2` question, not now.

### 1.5 A/B/C/D value-add

- **A (information now present, used):** Mia's five and Lilia's three all rest on material that State 1.1 did not hold. Mia's set is the first on the frozen four that a manager could hand her.
- **B (evaluator reasoning):** consolidation worked; quantified target read against the real baseline (Lilia closedDeals 0 → ≥1); horizons carry reasons. No new B-layer failure.
- **C (frozen-evaluator defects):** the enum case (fixed, 1.0.1) and its second source (§2); prescription in `why`.
- **D (nothing to say):** Riya and LeBron — unchanged in substance from the first run; the correct outcome for athletes whose new sections are empty.

---

## 2. The residual refusal — correcting my previous diagnosis

The State 1.2 audit said: *"The State renderer has printed stances uppercase since 1.0.0; that is unchanged"* and treated the prompt prose as the sole cause. That was wrong. There were **two sources** of uppercase in front of the evaluator:

1. the prompt prose — `stance WANTS` ×3 — **fixed in 1.0.1**;
2. the state block — `opportunity/stateBlock.ts:184` renders `p.stance.toUpperCase()`, so every preference line reads `preferences[…]  WANTS — "…"` — **unchanged, and still in front of the evaluator**.

The Objective prompt's `athlete_stance` output line (`{ stance, subject } | null`) lists no vocabulary, so the evaluator copies whichever casing it last saw. At temperature 1.0 that is a coin flip: in this run Mia's three stances came back `wants` (from the prose) and Lilia's two came back `WANTS` (from the block). In Run B, Mia's came back `WANTS`. The Opportunity evaluator emitted lowercase on the same block in Run D because *its* prompt spells the enum on the output line (`stance   wants | open | avoids | refuses`).

Also observed in the same lines: `preferences[onboarding_goal.grow_my_following]WANTS` — the path is longer than the 46-column pad, so the stance runs into it with no space. Cosmetic; recorded.

**Not fixed, per instruction.** Three candidate fixes, one recommended, for the next deliberate step:

| fix | what it is | digest effect |
|---|---|---|
| **A — render the stance in its enum spelling** (`stateBlock.ts:184`, drop `toUpperCase()`; widen the pad) | evidence formatting: the block shows citable data and its vocabulary should be the contract's | none on either evaluator (the block is excluded from both digests). Changes the Opportunity *input* rendering; its prompt already spells the enum lowercase and it emitted lowercase in Run D |
| B — list the enum on the Objective `athlete_stance` line | a methodology-text change, `1.0.2` | Objective digest moves |
| C — case-fold in the Objective structural validator | normalisation change; should also be versioned | none, but it makes the gate lenient about the contract's own vocabulary |

**Recommend A**, then rerun Objectives on the same Run D pairs. It is the root cause (the block is what the evaluator copies), it costs no digest, and it removes the class rather than the instance. B is defensible as belt-and-braces later. C I would not do.

---

## 3. Direct comparison: State 1.1 run (`objective-1.0.0-run`) vs State 1.2 run (`objective-1.0.1-run`)

| | State 1.1 · spec 1.0.0 | State 1.2 · spec 1.0.1 |
|---|---|---|
| sets accepted | 4 / 4 | 3 / 4 (Lilia refused on casing, §2) |
| proposals | 13 | 11 + 3 drafted = 14 |
| citing athlete intent | **0 / 13** | **5 / 14** |
| origins | nomila 13 · joint 0 · athlete 0 | nomila 9 · **joint 5** · athlete 0 |
| `commercial`-domain proposals | 0 | 2 (Mia StartX1 accepted; Lilia first partnership drafted) |
| quantified targets read from a real baseline | 1 (LeBron closedDeals 0 → ≥5, on a record the evaluator itself called wrong) | 1 drafted (Lilia 0 → ≥1); Mia's StartX1 proposal chose an observable condition (a signed contract) instead of a count — better |
| horizons with a `why` | 2 (LeBron) | **7** (Mia 3, Riya 2, LeBron 2) |
| consolidation | 0 | 1 (Mia, two content openings → one audience outcome) |
| not carried | 0 | 0 |
| entailment | 12 S · 1 P · 0 U | 11 S · 2 P · 0 U (both P inherited from Opportunity) |
| invented preferences | 0 | 0 |
| prescription leakage | LeBron athletic (de-prescribed by the evaluator in that run) | confined to `horizon.why` ×3 |
| citations into new State sections | — | `commercialPosition.inbound` ×3, `contentPerformance` ×2, `pipeline`, `preferences` ×5 |
| Mia, in one line | *reverse the audience trend · align with tech brands · package Yuwa · get the Adidas data* | *grow across both platforms (post more, wake TikTok) · sign StartX1 this season · an EdTech/STEM partner within twelve months · Yuwa as a CSR asset over years · get the Adidas data* |

Riya and LeBron are the same sets in substance under both States. Every material difference is on Mia and Lilia, and every one traces to a State 1.2 section.

---

## 4. Conclusion — stated precisely

**Exposing information Nomila already possessed materially improved the strategic intelligence of the frozen evaluators, with no change to their reasoning.**

Precisely:

- **The improvement is real and attributable.** Opportunity `1.0.0`'s digest never moved. Objective `1.0.0 → 1.0.1` changed three words' casing and nothing else; the reasoning text is byte-identical otherwise. Every material difference between the before and after runs occurs on the two athletes for whom State 1.2 carried new sections, and cites those sections. The two athletes for whom it carried nothing new are unchanged. That is a controlled result.
- **The improvement is in specificity and provenance, not in volume.** 13 → 15 opportunities and 13 → 14 proposals is noise; 0 → 18 citations into demand, intent and content, 0 → 5 joint-origin proposals, and the disappearance of Run 3's invented motive for Mia's flat commerce are the result.
- **The earlier "13 → 13, 0 notes, intent at zero" ceiling was an information-flow problem**, as the sufficiency audit predicted, and is now explained: intent and demand were not reaching the evaluator. The evaluators were better than the State they were given.
- **What the experiment did not show:** that `audience[…]` composition matters (rendered, uncited, one observation — no conclusion); that dates matter (none exist to test); that an onboarding tick is sufficient intent for a minor (it is not, and the evaluator honoured the label but could not know the guardian's stance).
- **What it surfaced:** one frozen-spec defect with two sources — one fixed (1.0.1), one identified and left for a deliberate step (§2) — and the confirmation that the grounding and structural gates catch what they are meant to catch, on real data, without ever refusing a grounded proposal.

**Experiment 1 is closed on that conclusion.** Its one loose end — Lilia's set — is a casing defect in evidence rendering, not a reasoning result, and its drafts are grounded and audited. Nothing here changes the next question, which is not research but routing: *given a strategic decision, what proposition remains unresolved, and which source resolves it — the athlete, the world, or nothing?* Not designed here.
