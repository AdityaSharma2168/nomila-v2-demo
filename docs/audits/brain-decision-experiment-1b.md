# Brain Decision Experiment 1B — audit (R0–R5)

**Owner:** Mia
**Date:** 2026-09-26
**Design:** `docs/architecture/commercial-intelligence/brain-decision-experiment-1b.md`, approved with the R2 and R3 wording changes. Six calls approved and run unchanged, in order, no tuning or rerun between conditions.
**Frozen, asserted in every artifact:** `brain-eval-spec/0.1.0-exp`, digest `d470d089…`; gates; `gemini-3.5-flash`; Mia's three live Objectives; one State snapshot; the persisted map; the approved seven-item context; renderers. **The one variable:** a controlled overlay on the real existing-work block. Artifacts: `docs/audits/artifacts/brain-context-experiment-1/1b/arm/R0..R5.json`; overlays: `…/1b/overlays/R1..R4.json`. **Nothing materialised. StartX1 untouched. No Stage-2 research, no connected read.**

**Headline.** When the evidence intersects the Objective, the decision *type* moves — and it moves on the fields that were rock-stable across three identical runs, so the movement is outside the noise floor. R1 produced the experiment's first **NO_ACTION** on a live Objective, citing the work already in motion. R2 produced the first **direct action** — respond to the outstanding term sheet — after connecting the offer to her recorded floor on its own, with `advances_existing_work` naming the item. R3 noticed the missing terms, named them in `not_seen`, chose `direct_action` toward the same brand rather than a plan to pitch others — and did **not** request the information. R4 noticed the outreach already sent, attached to it, and then manufactured supporting work instead of waiting. R5 planned, as it should. So: the Brain reads existing work when it intersects an Objective and discriminates *work in motion* and *bounded step*; it does not yet reach for REQUEST_INTELLIGENCE on a live Objective or tolerate a waiting state. Two of six sets were refused by the gates on citation and id **formatting** under an unchanged prompt; their content is read as refused sets, clearly marked.

---

## 1. Gates, usage, cost — per run

| run | overlay | tokens in / out / thought | latency | cost | gate 1 | gate 2 | output |
|---|---|---|---|---|---|---|---|
| R0 | none (V3 repeated) | 11,749 / 1,837 / 9,016 | 50.1 s | $0.031 | pass | pass | accepted |
| R1 | TikTok series in production | 11,893 / 1,791 / 10,298 | 62.3 s | $0.034 | pass | **refused** — five opportunity cites written as bare keys (`amplify-yuwa-philanthropic-work`, …) instead of `opportunity[<key>]` | none; raw parsed recorded |
| R2 | Northlight term sheet, no response sent | 11,936 / 1,708 / 4,782 | 33.4 s | $0.020 | pass | pass | accepted |
| R3 | Northlight negotiating, nothing recorded | 11,876 / 1,754 / 5,868 | 38.5 s | $0.023 | **refused** — every `objective_id` written as `objective[<id>]` instead of the bare id, so no live Objective had a decision | pass | none; raw parsed recorded |
| R4 | CSR proposal sent to six brands, no reply | 11,895 / 1,758 / 8,287 | 50.0 s | $0.029 | pass | pass | accepted |
| R5 | none (real positioning condition) | 11,749 / 1,461 / 4,786 | 32.2 s | $0.019 | pass | pass | accepted |
| **total** | | | | **$0.155** | | | |

Prompt size 47,051–47,535 chars; the overlay adds 380–490 chars. Digest identical in all six.

**On the two refusals.** Both are formatting, not substance: R1 dropped the `opportunity[…]` wrapper on five cites (every other cite in the set resolved, including `work[ctl-r1-tiktok-series]`); R3 wrapped every id in `objective[…]`/`deferred[…]` where the contract asks for the bare id. The gates did exactly what they are for — a reference that does not resolve as written is refused — and the raw content is intact. Stage 1 had no such lapse in four runs; 1B had two in six with the same prompt. Whether an obvious-format normalisation belongs in front of gate 2 is a later decision; nothing was repaired.

## 2. The discrimination table

Objectives: **Yuwa** `b1c799e3` · **Positioning** `c0f587e4` · **Audience** `feb62891`. Target in bold.

| run | condition | target decision | execution path | relation · `advances` | cited the controlled item? | noticed vs changed | non-targets |
|---|---|---|---|---|---|---|---|
| R0 | repeat V3 | all three RECOMMEND | specialized_plan ×3 | new_work ×3 | — | — | — |
| **R1** | work already advances audience | **Audience: NO_ACTION** — "A newly launched TikTok reactivation series is already in active execution, with two videos published and the next scheduled for October 3 alongside Instagram cross-posting. This directly addresses her dormant channels and cooling trajectory…" | (none) | (none) | **yes** — `work[ctl-r1-tiktok-series]` "Shows an active eight-video TikTok and Instagram cross-posting series is underway…" | **noticed and changed**: RECOMMEND → NO_ACTION | Yuwa and Positioning: RECOMMEND · specialized_plan · new_work, unchanged in type |
| **R2** | bounded step pending | **Positioning: RECOMMEND** — "Direct her management team to respond to and negotiate the outstanding USD 5,000 ambassador term sheet from Northlight Learning to secure her first tech-academic partnership." | **direct_action** | **advances_existing_work** · `work[ctl-r2-northlight-termsheet]` | **yes**, plus `representation.floors[ambassador]` — the Brain connected the offer to her real floor itself ("offers compensation exceeding her ambassador fee floor"); no such word was in the fixture | **noticed and changed**: plan → bounded action; new_work → advances | Yuwa, Audience: RECOMMEND · specialized_plan · new_work, unchanged |
| **R3** | material facts absent | **Positioning: RECOMMEND** — "Advance the active negotiations with Northlight Learning to secure a partnership that aligns with her tech and educational positioning." · `not_seen`: "The proposed commercial terms, financial budget, and specific deliverables for the Northlight Learning negotiation" | **direct_action** | **advances_existing_work** · `work[ctl-r3-northlight-open]` | **yes** | **noticed, half-changed**: it named exactly the missing facts and chose the open thread over a plan to pitch other brands — but recommended advancing anyway rather than REQUEST_INTELLIGENCE | Yuwa: RECOMMEND · specialized_plan; Audience: RECOMMEND · specialized_plan citing `ctx[0]` (schedule gap) |
| **R4** | outreach sent, waiting | **Yuwa: RECOMMEND** — "Develop specialized digital storytelling assets and impact case studies highlighting her direct work with the Yuwa program to support outstanding corporate social responsibility proposals." | specialized_plan | **advances_existing_work** · `work[ctl-r4-csr-outreach]` | **yes** — "an active outbound outreach campaign is underway but has received no replies and lacks follow-up dates" | **noticed, changed content, did not wait**: new_work → advances; "initiate outreach" → "supporting materials for the outstanding proposals"; no NO_ACTION; additional work manufactured | Positioning: RECOMMEND · specialized_plan · new_work; Audience: RECOMMEND · specialized_plan citing `ctx[0]`, `ctx[1]` |
| **R5** | planning warranted (no overlay) | **Positioning: RECOMMEND** — "Launch a specialized outreach campaign targeting premium EdTech and STEM brands…" | specialized_plan | new_work | n/a | as expected | Yuwa, Audience: RECOMMEND · specialized_plan · new_work |

**Reading against the noise floor.** Across the three runs with identical inputs (V3, R0, R5) the decision type, execution path and relation never moved: nine of nine RECOMMEND · specialized_plan · new_work. Wording drifted freely, and context citation swung from one decision (V3) to all three (R0) to none (R5). So: **changes in decision type, execution path and relation in R1–R4 are outside the noise floor; changes in wording and in context citation are not.** The 1B effects are read on the stable fields only.

## 3. Per-condition inspection, as Mia asked

**R1 — did existing work change the decision, not just get noticed?** Yes. The audience Objective went from RECOMMEND (V3, R0, R5) to NO_ACTION with the series cited as the reason and the next publication date read correctly. The `why` also cites `ctx[0]` ("a quiet athletic schedule") as reinforcement — the schedule-gap inference persists even inside a NO_ACTION. The two non-target Objectives did not move. The set was refused on the bare-key citation format, so this NO_ACTION lives in a refused artifact; the content is unambiguous.

**R2 — a bounded next step rather than a larger plan?** Yes. `direct_action`, `advances_existing_work`, the term sheet named, the floor connected by the Brain from State. Of note: the `what` opens "Direct her management team to respond to and negotiate…" — a bounded step, but delegated to her agency; and the `why`'s "aligns perfectly" and "secure her first tech-academic partnership" add framing the fixture did not carry. Non-targets stable.

**R3 — request the missing commercial information before recommending activity that could depend on it?** No. The Brain saw the missingness precisely ("terms, financial budget, and specific deliverables" in `not_seen`), chose the open negotiation over pitching other EdTech brands (the good half: no plan that could collide with an unknown exclusivity), and then recommended advancing the negotiation anyway. REQUEST_INTELLIGENCE was reached for only where a deferral said "information" — never once on a live Objective, in ten runs across both experiments. This is the cleanest single finding of 1B: **the request vocabulary is triggered by an explicit information condition in the input, not by the Brain's own recognition that a decision depends on facts it lacks.** The set was refused on the `objective[…]`-wrapped ids; content unambiguous.

**R4 — tolerate a waiting state rather than manufacturing work?** No. The outreach was noticed, cited, and attached to (`advances_existing_work`), and the recommendation changed from "initiate outreach" to "develop storytelling assets and case studies to support the outstanding proposals". That is additional work manufactured six days after a proposal went out with no reply yet — the opposite of waiting. No NO_ACTION. It did, correctly, stop citing context for Yuwa (R0 had cited the schedule gap as "perfect for developing outreach materials"); the audience decision in the same run cited `ctx[0]` and `ctx[1]` again.

**R5 — still plans when planning is warranted?** Yes: RECOMMEND · specialized_plan · new_work on positioning, unchanged from V3/R0. 1B did not push the Brain toward NO_ACTION everywhere.

## 4. StartX1 across the six runs

Never in `decisions[]`; REQUEST_INTELLIGENCE in the deferred block in six of six (R3's entry refused on id format; content the same). Source class `connected` in five; **R2 named `external`** ("StartX1's business model, commercial legitimacy, and specific partnership alignment… have been researched and verified") — the first external framing in ten runs, with identical StartX1 evidence in every run, so a variance observation about the request, not a new signal. R5's proposition presumes a concrete offer ("represent a concrete commercial offer with details that meet the athlete's representation floors…"), which the inbound rows do not establish — a proposition stated as if the answer were known. R4's `why` says resolving it "will clarify the terms and resolve her deferral condition" — consistent with the recorded invariant (satisfying the condition does not itself reactivate). Nothing mutated; no connected read made.

## 5. The context observations, carried forward

- **The schedule-gap capacity inference is systematic, not a one-off.** Stage 1 V3 had it once (audience). R0 applied it to all three Objectives ("a quiet 20-day window… the dedicated time required", "the upcoming athletic lull provides an ideal window", "the ideal moment"); R3 and R4 applied it to audience; R1 used it to reinforce NO_ACTION; R5 did not use it at all. Same prompt, same fixture. The reasoning-overreach candidate from Stage 1 stands, with five more instances and one counter-instance, and is still not tuned.
- **The control (`ctx[6]`) was never cited** in any of six runs. **The absence statements** (`ctx[3]`, `ctx[5]`) were never converted into nonexistence claims. The USWNT window, the campus occasion and the gorjana activity were never cited.

## 6. Observational execution shape, all RECOMMENDs and the one NO_ACTION

| run · Objective | Brain's path | reviewer's shape |
|---|---|---|
| R1 · Audience | NO_ACTION | NO_ACTION (itself) |
| R2 · Positioning | direct_action | **direct action** — respond to a term sheet |
| R3 · Positioning | direct_action | **unclear / intelligence acquisition** — "advance the negotiation" without terms is, in substance, a step to obtain them; the Brain did not say so |
| R4 · Yuwa | specialized_plan | larger plan (manufactured while waiting) |
| every other RECOMMEND (R0–R5, 12) | specialized_plan | larger plan/campaign |

Across 1B the outputs did separate into three of the four shapes — NO_ACTION, direct action, larger plan — with the shapes emerging from the evidence rather than from instruction. The fourth, intelligence acquisition on a live Objective, did not emerge; where it belonged (R3) the Brain produced an action whose real content is acquisition. Names not frozen.

## 7. What 1B says, as observation

1. **Reading existing work:** when work intersects an Objective, the Brain reads it, cites it, and changes relation and path accordingly, in four of four conditions. Stage 1's inertness was fixture-caused; the refinement recorded after Stage 1 holds.
2. **Work in motion:** it can stand down (R1). Partially executed work with a visible next step produced NO_ACTION; fully sent work awaiting replies produced more work (R4). The line between "in motion, nothing to add" and "in motion, add supporting material" was drawn on the wrong side once.
3. **Bounded step:** it can recognise one and route it as `direct_action` (R2), reasoning from State (the floor) to do so.
4. **Missing material facts:** it recognises them (`not_seen`) and does not act around them, but does not ask. The request vocabulary is input-triggered (a deferral's `information` kind), not judgment-triggered.
5. **Waiting:** not yet a state it tolerates on a live Objective.
6. **Portfolio effects:** none observed — non-target Objectives did not move in type across R1–R4.
7. **Format variance:** two of six sets refused on reference formatting under a frozen prompt; the gates are correct and the content survives; a decision about normalisation is deferred.

## 8. Not done, on purpose

No tuning, prompt change, repair or rerun. No Stage-2 research. No StartX1 connected read. No production Brain. No portfolio-level 1C. The next change — whether at the decision-spec level (what triggers a request; what "nothing to add" means when work is in flight) or at the input level — is proposed to Mia after review, not made here.
