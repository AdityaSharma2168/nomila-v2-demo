# Opportunity 1.2.0 (P6) — the ceremony and one forcing call, 27 Sep 2026

**Status:** `opportunity-eval-spec/1.1.0` → **1.2.0** by ceremony; `opportunity-map/1.1.0` → **1.2.0**. One provider call on the same input as the #640 treatment (run-d's recorded state block verbatim + the seven-item Context block + run-d as the prior snapshot); the #640 treatment is the comparison and was not rerun. Artifacts: `docs/audits/artifacts/opportunity-1.2.0-forcing/Mia_Bhuta.json`; comparison `…/opportunity-1.1.0-treatment/Mia_Bhuta.json`. Model `gemini-3.5-flash`; cost **USD 0.024**.

**Result: 1.2.0 is supported on all eight acceptance conditions.** No Nomila-world epistemic opening survives; nothing was re-dressed under another domain; the genuine openings remain, State-grounded, with Context as support only.

## 1. The ceremony

| step | result |
|---|---|
| exact contract change (canonical text) | the `evidence` line and the paragraph "EVIDENCE IS A REAL STRATEGIC DOMAIN…" **removed** from THE DOMAINS; in their place **THE BOUNDARY WITH NOMILA'S OWN KNOWLEDGE** (the invariant, regardless of domain; the epistemic satisfactions listed: know · verify · connect · record or reconcile · count correctly · obtain an existing contract · observe an existing relationship · resolve its own identity/data error; "It is a material gap, already recorded in the state… a later decision that cannot be made without it will ask for it"; "you do not rephrase it") · **HER PARTICIPATION DOES NOT CHANGE WHAT IT IS** · **RECORDING AN EVENT IS NOT THE EVENT** · **NOMILA'S COUNTS DESCRIBE NOMILA'S RECORDS** ("it is never a FIX"; "zero recorded does not mean zero exists") · **A CONDITION OF HER WORLD THAT CONCERNS PROOF** — genuine, in the domain of the thing proven, only when **two things both hold, independently**: affirmative completeness (never a missing field) and the kind test in its own words ("a complete zero is evidence, not automatically a deficiency"). Output contract: `domain` list without `evidence`; `notes[]` may say what is missing is Nomila's knowledge. Everything from 1.1.0 preserved (Context/responsive support, State grounding, kinds, the nine remaining domains, gates) |
| contract (`opportunity-map/1.2.0`) | `OPPORTUNITY_STRATEGIC_DOMAINS` = the shared enum without `evidence` (the evaluator's vocabulary); **`OPPORTUNITY_DOMAINS` unchanged** — older maps type, the Objective contract keeps its domain type, `routes/objectives.ts` validation unchanged, Objective 1.0.2's structural refusal of `evidence` keeps firing (tested) |
| structural gate | one narrow backstop: `domain: evidence` → "a deficiency in Nomila's knowledge, records, observation or verification is not a Strategic Opportunity for the athlete; it is a material gap, already in the state". Refuses the response; never reclassifies. Unknown domains stay "domain invalid". No keyword regex; the semantic block is primary |
| digest | 1.1.0 `b6883c24…` → **1.2.0 `7416ff47cca4f575e49fad30fd23955aa9ac612d22ffd40e2129d552f56ec4eb`**, repinned after parity and the exact-text review |
| parity / regression | 67 Opportunity tests (incl. `knowledgeBoundary.test.ts`) + 14 orchestrator + 157 Objective + 62 Brain + 33 Objective-orchestrator/routes — green |
| **historical re-gate** | **all 23 recorded artifacts change, and only in the intended way**: structural 0 → the number of evidence-domain openings in that map (run 2·2·2·2, run-b 2·2·2·1, run-c 1·1·1·2, run-d 2·1·1·1, cohort 2·1·1·2·2·1, treatment 1 = **35 refusals = the 35 historical evidence-domain openings**); grounding 0→0 everywhere; no strategic opening changed result; artifacts untouched as historical outputs under their own specs. Key stabilization is unreachable for a refused response, so no epistemic candidate can be carried |
| synthetic positive control (offline) | passes structurally as **GROW · commercial** ("establish a measurable outcome record with her current partner"), resting on a registry marked complete and her stated ambition; refused when filed as `evidence`; the same content resting on `materialGaps[0]` is structurally indistinguishable — which is exactly why the boundary is semantic and verified by rerun, not by regex |

## 2. The forcing call — every opening

| key (emitted → after stabilization) | kind · domain | wording | State citations | Context | gates | athlete- or Nomila-world | vs #640 treatment | stabilization |
|---|---|---|---|---|---|---|---|---|
| `grow-instagram-content-cadence` → **`grow-instagram-posting-cadence`** (carried, 0.75) | GROW · content | "Establish a consistent publishing schedule on Instagram to reverse her current audience growth contraction" | `contentPerformance[instagram]` (0.47 posts/week, 10 days since last post), `findings[mia.audience_scale]` (GAP, contraction), `preferences[onboarding_goal.grow_my_following]` | none | 0 / 0 | **athlete-world** (her cadence, her audience) | same condition as #640's `grow-content-cadence` (which had absorbed TikTok); here TikTok is not separately carried and audience is consolidated into content by note | carried — sole qualifying continuation of run-d's cadence GROW |
| `amplify-gorjana-ambassadorship` | AMPLIFY · commercial | "Elevate her existing gifting relationship with gorjana into a formal, paid long-term ambassadorship" | `commercialPosition.activeRelationships` (gorjana), `commercialPosition.inbound[3]` (GIFTING, 8 Sep), `findings[mia.brand_fit]` | **`ctx[5]`** (Sports Club roster; long-term-ambassador preference) — support only; **no urgency this time** (the #640 campaign-language overreach did not recur) | 0 / 0 | **athlete-world** (a relationship to grow into a paid one) | same opening as #640's `amplify-gorjana-partnership`, again created with Context as support | new key — the only same-kind/domain prior (StartX1 AMPLIFY) at 0.20 |
| `unlock-tech-academic-positioning` | UNLOCK · positioning | "Leverage her elite Stanford academic path … to secure tech and startup partnerships" | `findings[mia.narrative_power]`, `findings[mia.brand_fit]`, `commercialPosition.inbound` (the StartX1 inbounds as market interest) | none | 0 / 0 | **athlete-world** (an idle positioning asset) | run-d/#640-era `grow-academic-tech-partnerships` re-read as UNLOCK ("highly valuable but currently idle"); the StartX1 demand now cited *inside* this opening rather than as its own AMPLIFY | new key — kind differs from the prior GROW, so no candidate (correct: a different interpretation) |

Notes (six): athletic, audience (consolidated into content), relationships ("the state lacks sufficient data regarding her … network" — Nomila's knowledge, **kept as a note, not an opening**), owned_venture, impact, career. 9 of 9 citations resolved; usage 9,816 prompt · 1,661 output · 6,564 thought tokens.

**Gone from the #640 treatment:** `unlock-adidas-historical-performance-data` (UNLOCK · evidence) — **the target, eliminated**; `amplify-yuwa-philanthropic-work` and `grow-negotiation-pipeline` — uncited, both within run-to-run variation (the note on impact says the state lacks a distinct opening there; Yuwa was present in three of four 1.0.0 runs and absent in one).

## 3. Semantic audit for re-dressed gaps — the complete raw output

| class searched | hits | reading |
|---|---|---|
| connect accounts / authenticate / OAuth | 0 | — |
| upload / share contract / contract terms / wrap reports | 0 | — |
| verify / verified / verification | 0 | — |
| reconcile / Nomila's records / database / profile | 0 | — |
| cannot see / blind spot / not visible / unseen | 0 | — |
| material gap / imputed / assumed | 0 | no `materialGaps[n]` cited anywhere (the treatment had cited three) |
| counts / closed deals / recorded | 1 | "no **recorded** active, planned, or desired owned business ventures in the state" — a note explaining an empty domain; not an opening, not a deficiency claim |
| **Adidas** | 1 | "her primary commercial partnerships (Adidas) have focused on traditional athletics" — a world fact used to argue that her tech positioning is idle; **not the terms, not the metrics, not a gap** |
| data / metrics / analytics | 2 | "engagement metrics" (her measured strength) and "the state lacks sufficient data regarding her … network" (a note about Nomila's knowledge, correctly placed in `notes[]`) |

No opening's statement, rationale, impact or feasibility asks Nomila to obtain, see, record, verify or connect anything. The evaluator did what the block asked: it dropped the epistemic candidate and said in `notes[]` where Nomila's knowledge is thin, instead of filing that as an opening under another domain.

## 4. Key stabilization (over the gated set only)

| opening | candidates (same kind · domain) | lineage | carried | why |
|---|---|---|---|---|
| `grow-instagram-content-cadence` | `grow-instagram-posting-cadence` | 0.75 | yes | sole qualifying continuation |
| `amplify-gorjana-ambassadorship` | `amplify-inbound-startx1-interest` | 0.20 | no | below the floor — correct, a different counterparty |
| `unlock-tech-academic-positioning` | — | — | no | no prior UNLOCK · positioning (the prior was GROW) — correct, a re-read is a new key |

Stabilization ran only because both gates passed; the 35 refused historical openings never reach it.

## 5. Acceptance

| # | condition | result |
|---|---|---|
| 1 | no Nomila-world epistemic opening survives | **met** — the Adidas UNLOCK is gone; nothing epistemic emitted |
| 2 | none re-dressed under another domain | **met** — §3: zero hits for every class; the only knowledge-thinness statement is a note |
| 3 | genuine strategic openings remain | **met** — cadence (carried), gorjana (Context-supported), academic-tech positioning; absences (Yuwa, negotiation pipeline) are uncited variation, not scored |
| 4 | every opening State-grounded | **met** — 9/9 State citations resolved; `rests_on` is State only |
| 5 | Context remains support, not ground | **met** — one `ctx[5]` in `supported_by`, no urgency built on it this time |
| 6 | missing records do not become real-world absence | **met** — no zero-count deficiency; empty domains explained as Nomila's knowledge in notes |
| 7 | no automatic Intelligence Request created | **met** — nothing exists to create one; the pipeline writes a map and a record only |
| 8 | key stabilization runs only over gated strategic Opportunities | **met** — §4; refused corpus sets never reach it |

Semantic-instruction success; the structural backstop was not needed on this run (no `evidence` domain emitted). No counterexample recorded.

## 6. Observations (not acted on)

- `unlock-tech-academic-positioning` reads the StartX1 inbounds as market interest *inside* a positioning opening and its feasibility says "vet, organize, and reply to the existing StartX1 inbounds" — the 1B separation (a condition vs. work to initiate now) touched from the Opportunity side again; the Brain's, not this boundary's.
- `commercialPosition.inbound` was cited as a bare collection (not `inbound[n]`); the grammar resolves the collection as existing, which is honest but coarse. Logged.
- The impact-domain note ("the state lacks specific targets or infrastructure") is a knowledge statement placed correctly as a note; Yuwa's absence as an opening is variation rather than an effect of the boundary — the boundary never mentions impact.

## 7. Not done

No second call. No auto Intelligence Requests. No Opportunity lifecycle. No mounting. No Objective 1.0.3. No Deals, Rate, Recommendation, Campaign/Studio or brand-relationship change. No repeatability matrix. 1.1.0 and 1.0.0 histories untouched; #640 the pass-2 acceptance; #638 the Context checkpoint; #608 unchanged; #570 untouched.
