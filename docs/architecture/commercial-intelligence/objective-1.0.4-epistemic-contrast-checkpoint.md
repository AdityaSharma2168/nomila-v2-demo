# Objective 1.0.4 — epistemic absence as baseline contrast: evidence/design checkpoint, 27 Sep 2026

**Controls:** `objective-eval-spec/1.0.2` (accepted, frozen); `objective-eval-spec/1.0.3` (experimental candidate, **not supported**, #644); `opportunity-eval-spec/1.2.0` upstream. No provider call, no bump, no patch. Evidence: the 15 #644 proposals with their cited evidence and their 1.0.2 counterparts, the twelve original manufactured-deficiency cases, the supported-negative controls, and the cited findings' actual text.

**In plain words.** 1.0.3 taught the evaluator to stop calling a strength a weakness. It then found the next-easiest way to make "today" look different from "tomorrow": say what Nomila hasn't seen. "Her programming structure is not recorded in the system." "She lacks recorded campaign integrations." Those sentences are true about Nomila and say nothing about her — and they were doing the job the invented weakness used to do. The fix is to separate two things the contract currently lets blur: what Nomila doesn't know (which should make Nomila *less sure*) and what is true of her world (which is the only thing an Objective may be built on).

---

## 1. All 15 #644 baselines, classified by the source of the present→desired contrast

A affirmative athlete-world fact · B affirmatively established athlete-world problem · C strength/asset · D explicit unknown that merely qualifies confidence · **E Nomila record absence used as baseline contrast** · **F incomplete observed set generalised into athlete-world absence/concentration** · G other

| # | athlete · proposal | `current_state` (the contrast-bearing clause in bold) | cited evidence establishes… | class | confidence emitted |
|---|---|---|---|---|---|
| 1 | Okpara · commercial GROW | "**zero closed deals and zero active relationships on record**, with his commercial valuation restricted to collegiate team roster pools" | the roster-pool valuation (`commercial_proof`) — A; the counts are Nomila's records | **A + E** — the record-zero is stated as a record, but it is the first clause of the contrast | HIGH |
| 2 | Ronaldo · content AMPLIFY (historical M #1) | "83.3 M subscribers and 1.65 B views…, **but its current programming matrix and format breakdown are not recorded in the system**" | `audience_scale`, `momentum`: scale and momentum only; nothing about programming | **E** — an explicit unknown, but placed after "but" as the pivot; the desired state (a diversified grid) already differs from the strength without it; the rationale rests on the strength, not on the absence | HIGH |
| 3 | Ronaldo · positioning FIX | "facing a proposed $1 billion class-action lawsuit … alleging lack of proper paid disclosures …; brand safety component score 72" | `brand_fit`: the lawsuit | **B** | HIGH |
| 4 | Ronaldo · career GROW | "continues to play actively at 41, captaining Al-Nassr and Portugal, **with no formalized post-retirement corporate structure recorded in the system**" | `careerStatus`, `athletic_authority`, `narrative_power`: active at 41; nothing about corporate structure | **E** — the record absence is the whole contrast | HIGH |
| 5 | Ronaldo · owned_venture AMPLIFY | "records zero active relationships or closed deals **inside the system, while secondary sources report** traditional licensing and endorsement partnerships with Nike, Binance, Herbalife, and Clear" | `commercial_proof`, `momentum`: endorsement-type partnerships (world) | **A (+D)** — the record is named as a record and the contrast is drawn from the world fact (endorsements vs equity) | HIGH |
| 6 | Flau'jae · positioning AMPLIFY (M #2) | "…Samsung and Puma…, alongside a music career with Roc Nation, **but lacks recorded campaign integrations that merge both facets**" | strengths only; nothing records campaign structure | **E** (hedged "lacks") | HIGH |
| 7 | Flau'jae · owned_venture AMPLIFY (M #3) | "holds an equity stake in the Unrivaled league, **but her recorded digital platforms lack co-branded content properties**" | `commercial_proof` (the stake), `audience_scale` (platform size); nothing about platform content | **E** (hedged "lack") | HIGH |
| 8 | Maher · athletic MAINTAIN | "taking a competitive sabbatical after a bronze at Paris 2024 and a short-term club contract in England" | `athletic_authority` | **A** | HIGH |
| 9 | Maher · career AMPLIFY (M #4) | "currently developing and producing a self-titled docuseries with Hello Sunshine while on a competitive break" | `cultural_relevance`, `athletic_authority` | **A** | HIGH |
| 10 | Maher · owned_venture AMPLIFY (M #5) | "co-founder of Medalist Skin, an active skincare brand for female athletes, **but its current commercial distribution and retail scale are not documented**" | `narrative_power`, `audience_scale`: the brand exists; nothing about distribution | **E** — same shape as #2: an unknown placed as the "but" pivot | HIGH |
| 11 | Maher · content AMPLIFY (M #6) | "co-hosts 'House of Maher' with her sisters, 4.9 rating on Apple Podcasts, currently presented by Samsung Galaxy" | `audience_scale` | **C** | HIGH |
| 12 | Ledecky · positioning MAINTAIN | "the most decorated female U.S. Olympian with premium partners, but recently suffered her first international defeats … at the 2026 Pan Pacific Championships" | `athletic_authority`, `commercial_proof`: the defeats | **C + B** (the evidenced risk MAINTAIN needs) | HIGH |
| 13 | Ledecky · impact AMPLIFY (M #11, 1.0.2's new case) | "POTS diagnosis disclosed in her June 2024 memoir, **but her current public profile and brand partnerships remain heavily concentrated in traditional athletic, apparel, and consumer brands**" | `commercial_proof`: "high-value contracts with sponsors **like** TYR Sport and Athleta"; `narrative_power`: the memoir, resilience; (`cultural_relevance`, not cited: "Her memoir has established her as an inspiring voice for health and wellness advocacy") | **F** — see §5: the finding lists example partners; it does not characterise the distribution; the evaluator generalised an observed set into "heavily concentrated", and an adjacent finding says the opposite of the implied absence | HIGH |
| 14 | Street · owned_venture AMPLIFY (M #7) | "runs the Picabo Street Academy in Park City, partnering with Stifel, Hydro Flask, Comcast/Xfinity, Wildhorn, Kappa, and Cloudflare" | `commercial_proof`, `brand_fit` | **C** | HIGH |
| 15 | Street · career AMPLIFY | "recently completed a prominent broadcasting role as NBC's women's hill reporter at Milano Cortina 2026" | `athletic_authority`, `momentum` | **A/C** | HIGH |

**Totals:** A/B/C clean **7** (#3, 5, 8, 9, 11, 12, 14, 15 — eight, counting #5 as A) · **E 6** (#1 partly, 2, 4, 6, 7, 10) · **F 1** (#13) · **D-only 0**. Every explicit unknown in the set sits after "but" or as the sole contrast; none is written as a qualifier. **All 15 proposals carry `confidence: HIGH`**, including the six whose baselines say a material fact is not recorded — the 1.0.3 sentence "confidence carries the uncertainty" had no effect.

## 2. The seven "corrected" historical cases, reclassified

| historical case | #644 outcome | 1.0.3 scoring | reclassified |
|---|---|---|---|
| Ronaldo YouTube | "programming matrix … not recorded in the system" | class 1 | **E** — the absence replaced the weakness in the same position |
| Maher docuseries | "developing and producing a self-titled docuseries" | class 1 | **A — holds** |
| Maher Medalist | "distribution and retail scale are not documented" | class 1 | **E** |
| Maher podcast | "4.9 rating, presented by Samsung Galaxy" | class 1 | **C — holds** |
| Street Academy | the partner list | class 1 | **C — holds** |
| Ledecky advocacy | "remain heavily concentrated in traditional … brands" | class 1 (noted) | **F** |
| Ronaldo (1.0.2 softened) | = Ronaldo YouTube | class 1 | **E** |

So of the nine exercised cases, **three hold (A/C), four are E, two are F/E-hedged (Flau'jae, scored E above; Ledecky F)**. The 1.0.3 rule removed the *word* "lacks" from five of them and the *mechanism* from three.

## 3. The two Flau'jae failures, exactly

| | crossover (#6) | Unrivaled (#7) |
|---|---|---|
| 1.0.1 baseline | "lacks commercially scaled campaigns that structurally unite her dual identity" | "remains primarily focused on her rookie season and her music" |
| 1.0.2 baseline | "recorded active relationships stand at zero … despite …" | "zero active commercial relationships or co-branded campaigns recorded … that leverage her audience" |
| 1.0.3 baseline | "**lacks recorded** campaign integrations that merge both facets of her identity" | "her **recorded** digital platforms **lack** co-branded content properties dedicated to her ownership role" |
| what the citations establish | brand_fit (Puma, e.l.f., Samsung — versatile execution), cultural_relevance (Roc Nation, ESPYs), narrative_power | commercial_proof (the equity stake; "Samsung, Google, Puma, Amazon"), audience_scale (5 M, breadth across sports and entertainment) |
| what they do not | anything about which campaigns exist or how they are structured | anything about her platforms' content |
| the mechanism | the same across all three versions: Nomila has not observed X → "she lacks X". 1.0.2 moved it to a count; 1.0.3 moved it to a record absence with "recorded"; the *role* — the negative premise that makes the outcome look necessary — never moved | same |
| under the candidate invariant (§10) | "lacks recorded campaign integrations" is an epistemic absence in the contrast position → refused as a baseline; permitted only as "the evidence does not record her campaign structures", lowering confidence; the Objective stays warranted by the strength (two established identities → campaigns that use both) | "her recorded platforms lack…" is an observed-set generalisation about her platforms → refused; permitted: "her platforms' content is not measured here"; the Objective stays warranted by the stake + the audience |

## 4. Ronaldo "not recorded in the system" — is the absence doing argumentative work?

- Desired: "a structured, diversified programming grid of recurring content formats". Strength half of the baseline: 83.3 M subscribers, 1.65 B views. **These already differ**: a grid of formats is not a subscriber count. The contrast does not need the clause.
- The clause: "**but** its current programming matrix and format breakdown are not recorded in the system". It is introduced with "but", in the exact position where 1.0.1 wrote "but lacks a diversified programming matrix" and 1.0.2 wrote "but operates … without a formalized multi-show programming structure". Three versions, one position, three phrasings of the same absence.
- The rationale ("expanding and diversifying content leverages his record-breaking subscriber growth") rests on the strength alone — evidence that the Objective was never *warranted* by the absence. But `current_state` is the field the ledger persists as "what is true today", and it presents Nomila's silence as the athlete's situation from which the grid would be a departure.
- **Verdict: E.** Epistemically true, argumentatively the same manufactured contrast without the word "lacks". Valid form: "the evidence establishes the channel's scale and momentum; it does not establish its programming structure" — as a qualifier that lowers confidence, or simply omitted, since the strength already carries the contrast. The emitted confidence was HIGH.

## 5. Ledecky "remain heavily concentrated" — enumeration is not completeness

- The cited `commercial_proof` finding: "high-value contracts with sponsors **like** TYR Sport and Athleta … major multi-year partnerships with blue-chip brands **like** Visa and Athleta". "Like" — examples, not a census. It characterises her partnerships as long-term, premium, multi-year; it does **not** characterise the distribution of her portfolio, and it does not say what is absent from it.
- The evaluator inferred "heavily concentrated in traditional athletic, apparel, and consumer brands" from the examples — an observed set generalised into a portfolio property. And `cultural_relevance` (in State, not cited by this proposal) says "Her memoir has established her as an inspiring voice for health and wellness advocacy" — the implied absence (no health-advocacy dimension) is contradicted by an adjacent finding.
- **Verdict: F**, not supported. The 1.0.3 scoring ("the partners are enumerated") was wrong on exactly the point the brief names: a list of observed partners does not establish concentration. Valid form: "her recorded partnerships include TYR, Visa and Athleta; her memoir has made her a public voice on POTS" — a C/A baseline from which "formal advocacy roles" is an ambitious extension, no concentration claim needed.

## 6. The D versus E/F boundary

| | D — qualifies | E/F — justifies |
|---|---|---|
| grammatical role | a qualifier beside affirmative facts ("the evidence does not establish X") | the pivot of the contrast ("…, **but** X is not recorded / lacks recorded X / remains concentrated in [the observed]") |
| what it does to the proposal | lowers confidence; the outcome stays warranted by A/B/C evidence and the Opportunity | supplies the negative premise; remove it and the stated reason for movement is gone — or, as in Ronaldo, remove it and nothing is lost, which shows it was filler for the "must differ" rule |
| subject | Nomila's evidence | her world (or her world via "her recorded …") |
| test | *If Nomila later observed X and it turned out fine, would the proposal's current state be false?* D: no — it said the evidence didn't establish X. E/F: yes — it said she lacked / was concentrated |
| corpus | none of the 15 is a clean D | 6 E, 1 F |

The boundary is not lexical: "not recorded" appears in both an A(+D) baseline (#5, where the world fact carries the contrast) and E baselines (#2, #4, #10). What distinguishes them is **whether an affirmative athlete-world fact carries the contrast on its own**.

## 7. Confidence — is it already the right home for uncertainty?

- Contract: the proposal carries `confidence: HIGH | MEDIUM | LOW` only; **there is no `confidenceReason` field** on `objective-proposal/1.0.0` or the Objective row. The spec: "CONFIDENCE describes how well established the proposal is, given the evidence you actually used. It does not describe how attractive it is."
- Corpus: **15 of 15 HIGH** under 1.0.3; the 1.0.2 cohort was also uniformly HIGH on retained proposals. The evaluator reads confidence as "how sure am I this outcome is warranted", which — given strong Opportunity findings — is always high. Uncertainty about the *baseline* never reaches it, and 1.0.3's "confidence carries the uncertainty" changed nothing.
- **Finding:** confidence is the right and only existing home, but the text must say what lowers it: an outcome proposed over a baseline the evidence does not establish is less well established, whatever the strength of the opportunity. No field is added; `rationale` (free text, persisted on `desiredState.rationale`) is where "what remains unknown" may be written in words. So: **`current_state` says only what is affirmatively known; unknowns go to confidence (level) and, where worth saying, to rationale (words).** This matches the contract as it stands and removes the temptation to put epistemic commentary in the baseline at all.

## 8. The `current_state` field definition — the root instruction pressure

`current_state — what is true today that this intends to change`, plus "desired_state and current_state must differ. A proposal that restates the present is not a proposal." Read together by an evaluator whose Opportunity is a strength: the field asks for "the thing that will change", the strength is not going to change (it is what the outcome extends), so the evaluator names something that *will* change — a shortfall (1.0.1), a count (1.0.2), a record absence (1.0.3). Three bumps, three fillers, one instruction. **Assessment: yes, this is the actual root pressure**; the 1.0.3 block treated the symptom (what the filler may say) without removing the demand for a filler. Candidate definition (not applied): **`current_state — the evidenced athlete-world baseline relevant to the desired state: what the cited evidence establishes about today — a strength, an asset, a measured problem or a factual situation`**, with the difference rule restated: *they differ because the desired state extends, realises, protects or repairs what the baseline shows — never because the current state names something the evidence does not establish.*

## 9. The exact residual failure mechanism

**MISSING → contrast.** A fact Nomila has not observed, recorded, documented, or fully enumerated is placed in the contrast position of `current_state` ("but … not recorded", "lacks recorded", "her recorded platforms lack", "remain concentrated in [the observed]"), where it supplies the negative premise for movement toward `desired_state`. It is one mechanism with three surface forms (record absence · hedged "lacks" · observed-set generalisation), driven by the field definition's demand for "what this intends to change" and the "must differ" rule, and left unaddressed by confidence because nothing in the text ties baseline uncertainty to the confidence level.

## 10. The proposed 1.0.4 invariant — tested

> **UNKNOWN MAY QUALIFY; IT MAY NOT JUSTIFY.** `current_state` may say that a material fact is unknown when the evidence cannot establish it, and that lowers confidence. The Objective must not use that unknown — a missing record, an incomplete observed set, an absence from Nomila's system, however phrased — as the negative premise that justifies movement toward `desired_state`. The Objective remains warranted by the athlete-world evidence and the source Opportunity.

| case | under the invariant | preserved? |
|---|---|---|
| Flau'jae crossover | "lacks recorded campaign integrations" → refused as contrast; baseline = the two established identities (C); Objective warranted by the strength | ambitious Objective kept |
| Flau'jae Unrivaled | "her recorded platforms lack…" → refused (observed set); baseline = the stake + the audience (C) | kept |
| Ronaldo YouTube | "but … not recorded" → refused as contrast; the strength alone carries the difference; the unknown, if stated, is a qualifier and lowers confidence | kept |
| Ronaldo career, Maher Medalist, Okpara | same shape → same treatment; Okpara keeps the roster-pool fact (A) as its baseline | kept |
| Ledecky advocacy | "remain heavily concentrated" → refused (F); baseline = her partners as listed + her public POTS voice (A/C) | kept |
| supported negatives (lawsuit, defeats, sabbatical, cooling, dormant, missed games, no personal channels) | untouched — each is B or A from evidence | preserved |
| legitimate uncertainty ("the evidence does not establish her engagement quality") | allowed as a qualifier; must lower confidence | preserved, and now consequential |

The invariant resolves all seven E/F cases and neutralises none of the controls.

## 11. Cumulative or rewrite? — **A, cumulative**

The 1.0.3 block is right about what it addresses (kind-relative baselines; no invented shortfall; Nomila's counts) and improved seven of nine surface outcomes. What it lacks is (i) the epistemic-contrast rule, (ii) the tie between baseline uncertainty and confidence, and (iii) a field definition that stops demanding a filler. 1.0.4 keeps the block, adds the invariant paragraph to it, amends the two lines in the outcome block that create the pressure, and adds one clause to the confidence line. No rewrite; no new field; no gate.

## 12. Exact candidate wording (not applied)

**Outcome block — replace two lines:**
> `current_state          the evidenced athlete-world baseline relevant to the desired state: what the cited evidence establishes about today — a strength, an asset, a measured problem or a factual situation. Not what Nomila has failed to observe.`
>
> `desired_state and current_state must differ. They differ because the desired state extends, realises, protects or repairs what the baseline shows — never because the current state names something the evidence does not establish. A proposal that restates the present is not a proposal.`

**Baseline block — append one paragraph:**
> UNKNOWN MAY QUALIFY; IT MAY NOT JUSTIFY. Where a material fact about today is unknown — not recorded, not observed, not documented, not measured — the current state may say so, and that lowers confidence. It may not be the contrast. "But its programming structure is not recorded", "but lacks recorded campaign integrations", "her recorded platforms lack…", "remains concentrated in the partners observed": each puts Nomila's silence where today's deficit would go, and makes the outcome look necessary because Nomila has not looked. An absence from Nomila's records, however phrased, is not a fact about her world; a set of observed partners or platforms establishes neither that no others exist nor that her portfolio is concentrated — only a source that establishes completeness can. When the strength already differs from the desired state, no further contrast is needed; when nothing affirmative differs, the proposal is not warranted, and an unknown does not warrant it.

**Judgments block — extend the confidence line:**
> CONFIDENCE describes how well established the proposal is, given the evidence you actually used — including what the evidence leaves unknown about today's baseline. An outcome proposed over a baseline the evidence does not establish is less well established, whatever the strength of the opening; say what is unknown in the rationale, and let the level show it. It does not describe how attractive the outcome is.

## 13. Offline tests (for the ceremony; nothing added now)

Parity phrases for the three changes (the new field definition; "never because the current state names something the evidence does not establish"; "UNKNOWN MAY QUALIFY; IT MAY NOT JUSTIFY"; "however phrased"; "establishes neither that no others exist nor that her portfolio is concentrated"; the confidence extension) and the ordering; the digest ceremony; gates and output contract unchanged (existing structural/grounding tests untouched; the `baseline:`-field prohibition test still passes — the new wording avoids the pattern); the 1.0.2 knowledge tests untouched. No syntax gate: no `lacks`/`recorded` regex, no negative-word rule, no per-athlete or per-domain rule. The semantic result is measured only by rerun (§14) with the A–G classification, not by counts.

## 14. Is one further provider forcing evaluation warranted?

**Yes, one — after the 1.0.4 ceremony**, the same frozen six-athlete cohort, read with the A–G scheme proposal by proposal. Acceptance: zero E and zero F baselines; any D is a qualifier beside an A/B/C fact and carries a confidence below HIGH; the twelve historical cases retained-and-corrected or legitimately absent; supported negatives (B) preserved; ambition intact; success conditions clean; 1.0.2's 10 of 10 intact; no new gate machinery. If an E/F survives, record and stop.

## 15. Not done

No provider call. No bump (1.0.2 the accepted control; 1.0.3 an unaccepted candidate). No patch. No Opportunity, Brain, Deals, Rate, Recommendation, Campaign/Studio change. No mounting. No repeatability matrix. #570 untouched.

## 16. Review outcome (27 Sep 2026) — accepted; proceed with the 1.0.4 ceremony and one cohort evaluation

**Root cause, recorded explicitly.** `current_state — what is true today that this intends to change` combined with `desired_state and current_state must differ` creates pressure to manufacture a reason that today is deficient. Across versions that pressure produced (1) an unsupported athlete-world deficiency, (2) a softened deficiency, (3) a Nomila-record absence used as deficiency, (4) an incomplete observed set generalised into an athlete-world property. The failure is not primarily lexical; it is the semantic role assigned to `current_state`.

**Redefinition adopted:** `current_state` is the evidenced athlete-world baseline relevant to the desired state. It answers *what does the evidence establish about where the athlete is starting from?* — not *what is wrong today that justifies this Objective?* It may be strong, neutral, weak, constrained, growing, declining, at risk, or incomplete where incompleteness is affirmatively established; its job is fidelity to evidence, not justification. **Difference rule restated:** the difference between current and desired is the proposed movement, not evidence that the current state is deficient; a strength today and a larger expression of it tomorrow are meaningfully different; no absence claim is required unless evidence establishes it. **Invariant adopted:** UNKNOWN MAY QUALIFY; IT MAY NOT JUSTIFY — with the semantic test: if observing the missing fact tomorrow and finding everything already fine would make today's `current_state` false, the current state converted an epistemic gap into an athlete-world baseline. **Uncertainty:** existing semantics only — `current_state` faithful to affirmative evidence; rationale may explain what remains unknown; confidence must reflect *material* uncertainty rather than silently returning HIGH (not lowered mechanically). **Incomplete observed sets (the Ledecky class) closed:** "sponsors like A and B" does not establish concentration; one recorded relationship does not establish concentration — MISSING ≠ NONE applied to set completeness. **1.0.4 cumulative:** the 1.0.3 block kept, amended by this wording; wording that conflicts with the corrected field definition not preserved; no new fields, schema, gates, regex, negative-word detection or domain exceptions.

**This is the final planned Objective iteration before moving forward.** Hard stop: one evaluation, no patch, no rerun. Pass → freeze State → Opportunity → Objective for now and move forward (next: Recommendation → Execution Path). Fail → record the counterexample and bring it back for an architectural decision on whether prompt-semantic refinement has reached diminishing returns and stronger semantic evaluation machinery is warranted; no 1.0.5 designed immediately.

## 17. Ceremony and cohort evaluation (27 Sep 2026) — PASS; State → Opportunity → Objective frozen for now

`objective-eval-spec/1.0.4` (digest `99773087…`) by ceremony, cumulative on 1.0.3; one frozen-cohort evaluation (six athletes, USD 0.111) — `docs/audits/objective-1.0.4-cohort-evaluation.md`. **All 14 gated proposals classified A/B/C; zero E, zero F, zero manufactured deficiency; all nine exercised historical cases retained with corrected baselines** (Ronaldo's channel is its subscriber count; Flau'jae's campaigns are the ones the evidence records; Medalist is the brand; Ledecky's advocacy is the memoir); supported negatives (lawsuit, defeats, competitive break) preserved; every desired state as ambitious as before; success conditions clean; 1.0.2 boundary 11 of 11; no new machinery. One set (Okpara) refused at Gate 2 on an accounting double-listing unrelated to the rule — not rerun; its raw baseline is supported by the researched finding. Confidence: 14 of 14 HIGH, no proposal rests on an unknown, so the new clause was not exercised. **Version status: 1.0.4 = accepted frozen experimental contract (supersedes 1.0.2 as the Objective control); 1.0.2 and 1.0.3 preserved historically.** Per the hard-stop rule the Objective iteration ends here; next checkpoint: Recommendation → Execution Path.

## 18. Accepted (27 Sep 2026)

**State → Opportunity → Objective is frozen for now.** Objective 1.0.4 is the current Objective control; 1.0.2 and 1.0.3 remain preserved historical contracts/experiments. Objective is not reopened for confidence, cohort size or the Okpara refusal; the Okpara refusal is recorded as an unrelated Gate 2 accounting failure and is not rerun. Carried forward, not solved: MEDIUM/LOW confidence behaviour remains experimentally unobserved (46 of 46 gated cohort proposals HIGH) — to be watched in future uncertainty-sensitive Brain experiments. The architecture moves forward: next checkpoint **Brain Decision → Recommendation → Execution Path → executable work** (`recommendation-execution-path-boundary-checkpoint.md`).
