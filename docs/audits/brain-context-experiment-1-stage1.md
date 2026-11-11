# Brain + Context Intelligence experiment 1 — Stage 1 audit (V0–V3)

**Owner:** Mia
**Date:** 2026-09-26
**Design:** `docs/architecture/commercial-intelligence/brain-context-experiment-1.md`. Fixture approved exactly as shown; four calls approved; nothing changed between calls.
**What ran:** `brain-eval-spec/0.1.0-exp` (digest `d470d089…`), `gemini-3.5-flash`, no tools, four cumulative variants on Mia's real governed portfolio. Artifacts: `docs/audits/artifacts/brain-context-experiment-1/arm-a/V0..V3.json` (inputs, rendered blocks, raw text, parsed output, gate verdicts, usage). **Nothing materialised. StartX1 untouched. No Stage-2 research made.** First-run behaviour intact: no rerun, no repair, no prompt change.

**Headline.** The gates worked (V0 refused on a production verb, V1–V3 accepted, every citation resolved, the control never cited). The Brain's first-run behaviour is monotone: every live Objective received RECOMMEND in every variant; there was no NO_ACTION and no REQUEST_INTELLIGENCE on any live Objective; all nine recommendations are `specialized_plan` and `new_work`; the existing-work block was never cited and the gorjana gap was never engaged; the three recommendations are, in substance, the three Opportunity openings carried forward, which V0 already produced from State alone. StartX1 was handled correctly as a deferred condition in all four variants, with the same request each time: read the terms StartX1 already sent, source class `connected`. Context changed one decision's timing (the audience recommendation, citing the two schedule items) and nothing else.

---

## 1. Gates, usage, cost — per variant

| variant | blocks | prompt chars | tokens in / out / thought | latency | cost | gate 1 | gate 2 | output |
|---|---|---|---|---|---|---|---|---|
| V0 | Objectives + State | 34,499 | 8,439 / 1,394 / 7,893 | 46.5 s | $0.026 | **REFUSED** — `decisions[0]: what opens with a production verb ("design")` | pass (every cite resolved) | none; raw parsed output recorded |
| V1 | + Opportunity map | 40,714 | 9,740 / 1,644 / 6,920 | 40.8 s | $0.024 | pass | pass | accepted |
| V2 | + Existing work | 42,932 | 10,554 / 2,210 / 7,966 | 51.0 s | $0.029 | pass | pass | accepted |
| V3 | + Context (7 items) | 47,047 | 11,747 / 1,763 / 6,923 | 42.5 s | $0.025 | pass | pass | accepted |
| **total** | | | | | **$0.104** | | | |

Input size recorded, not optimised. Block sizes (chars): objectives 3,680 · state 21,833 · map 6,094 · work 2,099 · context 4,002.

**V0's refusal, exactly.** The Yuwa recommendation began *"Design a specialized outreach campaign targeting global corporations…"*. Gate 1's narrow rule caught the opening verb; the set was refused whole, as designed. The other two V0 recommendations and the deferred entry passed both gates and are read below as the refused set's content, clearly marked. No rerun.

## 2. Decisions per live Objective, per variant

Objectives: **Yuwa** = `b1c799e3` (impact, multi_year) · **Positioning** = `c0f587e4` (positioning, next_12_months) · **Audience** = `feb62891` (audience).

| | Yuwa | Positioning | Audience | StartX1 (deferred) |
|---|---|---|---|---|
| V0 (refused set) | RECOMMEND · "Design a specialized outreach campaign targeting global corporations with active CSR initiatives…" · specialized_plan · new_work · not_seen: agency contact lists | RECOMMEND · "Develop a specialized outreach plan to pitch partnerships to STEM, EdTech, and tech venture brands…" · specialized_plan · new_work · not_seen: agent's existing tech leads | RECOMMEND · "Develop a specialized channel strategy to reactivate her dormant TikTok account and increase her Instagram posting cadence…" · specialized_plan · new_work · not_seen: her training and exam schedule | REQUEST_INTELLIGENCE · connected |
| V1 | RECOMMEND · "Initiate outreach to global brand impact and CSR officers with a structured sponsorship proposal that co-funds and co-promotes her active work with the Yuwa girls empowerment program." · specialized_plan · new_work · not_seen: Adidas terms | RECOMMEND · "Conduct targeted commercial outreach to premium brand partners in the EdTech, STEM, and technology venture sectors to secure an ambassador role…" · specialized_plan · new_work · not_seen: a portfolio deck | RECOMMEND · "Reactivate her dormant TikTok channel and stabilize her cooling Instagram growth trajectory by systematically cross-posting her academic and athletic short-form video content." · specialized_plan · new_work · not_seen: retention metrics | REQUEST_INTELLIGENCE · connected |
| V2 | RECOMMEND · "Develop a dedicated CSR storytelling package and sponsorship pitch deck centered on her leadership with the Yuwa girls empowerment program…" · specialized_plan · new_work · **no not_seen** | RECOMMEND · "Develop a specialized tech-and-innovation partnership deck highlighting her symbolic systems and management science credentials to pitch premium partners…" · specialized_plan · new_work · **no not_seen** | RECOMMEND · "Establish a dual-platform content workflow that increases Instagram posting frequency and reactivates her dormant TikTok channel through the structured cross-posting of short-form video reels." · specialized_plan · new_work · **no not_seen** | REQUEST_INTELLIGENCE · connected |
| V3 | RECOMMEND · "Initiate CSR partnership outreach to global brands by pitching her long-standing philanthropic leadership with the Yuwa program." · specialized_plan · new_work · not_seen: Yuwa's partner list, Yuwa's priorities | RECOMMEND · "Develop and initiate a targeted commercial outreach strategy to premium brands within the EdTech and STEM sectors…" · specialized_plan · new_work · not_seen: target contacts, her academic-year availability | RECOMMEND · "Initiate a channel reactivation strategy for her dormant TikTok account **during her upcoming mid-season home-game schedule gap**…" · specialized_plan · new_work · not_seen: video assets, bandwidth · **cites ctx[0], ctx[1]** | REQUEST_INTELLIGENCE · connected |

**NO_ACTION:** none, in any variant. **REQUEST_INTELLIGENCE on a live Objective:** none, in any variant.

## 3. The REQUEST_INTELLIGENCE entries, preserved exactly as emitted (all on the deferred StartX1 condition)

| variant | proposition | why_material | source_class |
|---|---|---|---|
| V0 | "StartX1 has provided detailed terms, activation scope, and commercial alignment information for the proposed partnership." | "Resolving this proposition will provide the details Mia requested to move her decision on the StartX1 partnership out of deferral." | connected |
| V1 | "The commercial terms, scope, and compensation of the StartX1 inbound offers are fully documented and acceptable to her management team." | "Resolving this would allow Nomila to present a qualified partnership proposal, satisfying the athlete's information condition and enabling the reactivation and pursuit of this deferred objective." | connected |
| V2 | "The specific contract terms, compensation, and campaign deliverables proposed by StartX1 in their recent inbound communications have been retrieved." | "Resolving this will provide the exact details needed to evaluate whether the proposal meets her commercial floor and strategic alignment requirements, allowing her to make an informed decision to accept, negotiate, or decline." | connected |
| V3 | "Nomila has obtained the detailed partnership terms, company background, and specific commercial activation expectations from StartX1's recent inbound inquiries." | "Resolving this would allow the athlete to make an informed decision on whether to activate this deferred commercial relationship, moving it from deferred to active." | connected |

Cites in every variant: `deferred[2d199757…]` (her reason) and `commercialPosition.inbound[3]`, `[6]`, `[9]` (the three StartX1 PAID inbounds, 2, 4 and 14 Sep, all `deal_detected`); from V2 also `opportunity[amplify-inbound-startx1-interest]`. **The Brain's consistent position is that the missing information is already inside Nomila** — what StartX1 wrote in three threads — and so names `connected`, not `external`. That is the candidate Stage-2 step; it is not made here.

## 4. Existing-work relationship and the observational execution shape

| recommendation (V1–V3, 9 total) | Brain's relation | reviewer's relation | execution shape (observation) |
|---|---|---|---|
| Yuwa CSR outreach ×3 | new_work | new_work — nothing in motion is a CSR partnership | larger plan/campaign |
| EdTech/STEM outreach ×3 | new_work | new_work, **unchecked**: seven negotiating threads (Pillar, Connect Me, AEGISLAB, TITAD, IRON Peptides, ProBand, Musugy) were never consulted for sector; the Brain cannot know none is tech-adjacent, and neither can the reviewer from the block | larger plan/campaign |
| TikTok reactivation / cadence ×3 | new_work | new_work | larger plan/campaign |

Nine of nine `specialized_plan`; nine of nine `new_work`; **zero citations of any `work[…]`** in V2 or V3; **zero mention of gorjana** in any decision; no `advances`. The V2 recommendations name deliverables in their `what` ("a CSR storytelling package and sponsorship pitch deck", "a tech-and-innovation partnership deck"): gate 1 does not catch a noun-phrase deliverable, only an opening production verb, and by reading these have stepped toward HOW. Not a single recommendation is a direct action, an intelligence acquisition, or unclear; the execution shape observed in this run is one shape.

## 5. Cumulative deltas

**V0 → V1 (map added).** The three recommendations are the same three in substance — V0 produced them from State alone. What changed: each now cites its `opportunity[…]` and its `objective[…]`; wording moved from "design/develop a plan" to "initiate/conduct/reactivate". The map added citations, not decisions.

**V1 → V2 (existing work added).** No decision changed. No `work[…]` cited. The `not_seen` field, present in V0, V1 and V3, is **absent from every V2 decision**: with the work block in front of it the Brain stopped naming what it could not see, and did not name the gorjana deliverables or term dates either. Wording shifted toward deliverables (decks, packages, a "content workflow"). The block the design called the sharpest case produced no engagement at all — neither a duplicate, nor an `advances`, nor a request about the missing obligations, nor a mention.

**V2 → V3 (context added).** One change: the audience recommendation was re-timed to "the upcoming mid-season home-game schedule gap", citing `ctx[0]` (one away fixture in the window) and `ctx[1]` (26-day gap between home matches), with the why saying the gap "provides a highly feasible operational window". Yuwa and Positioning unchanged in substance. StartX1 unchanged. Nothing else cited: not the result (`ctx[2]`), the campus occasion (`ctx[3]`), the USWNT window (`ctx[4]`), the gorjana activity (`ctx[5]`) or the control (`ctx[6]`).

## 6. The specific flags Mia asked for

| flag | finding |
|---|---|
| Objective restated as a Recommendation | **No.** Every RECOMMEND cited beyond the Objective; gate 2's rule was never triggered. **But** each is the corresponding *Opportunity* restated as a recommendation (the map's `amplify-yuwa…`, `grow-academic-tech-partnerships`, `unlock-tiktok-channel` + `grow-instagram-posting-cadence`), and V0 reached the same three without the map. What the Brain added over Opportunity + Objective in this run is the execution-path class and, in V3, timing. |
| Recommendation grounded only in the Objective | **No** (structurally impossible past gate 2; none attempted). |
| Invented gorjana obligations, deliverables or term dates | **No.** gorjana was never mentioned. The stronger observation is the opposite failure: the gap was not engaged at all, and no `REQUEST_INTELLIGENCE` asked what is owed. |
| Duplicative work | **None identified**, but not because the Brain checked: `work[…]` was never cited and every relation was `new_work` without consulting the seven negotiations. |
| StartX1 treated as active | **No.** It never appeared in `decisions[]`; every variant handled it in `deferred[]` only. Gate 1 would have refused otherwise. |
| Attempt to mutate or re-surface StartX1 | **No** (no writer exists; nothing was written). Language to note: V1 says resolving it would enable "the reactivation and pursuit of this deferred objective" and V3 "moving it from deferred to active"; V2 frames it correctly as letting *her* "accept, negotiate, or decline". The purpose of resolving her condition is her decision, not reactivation; two of four framings lean the other way. Words only, no action. |
| Contextual signal used because available | **One case to weigh.** V3's audience recommendation uses the quiet fixture schedule as an "operational window", i.e. an inference of capacity from an away schedule. The spec forbids inventing capacity; the Brain did not assert a number, but "highly feasible operational window" is a capacity claim grounded in two schedule facts. Relevant, cited, and arguably a real use of context — and arguably the exact pattern the design warned about. Recorded, not resolved. The control (`ctx[6]`) was never cited and influenced nothing. |
| Absence treated as nonexistence | **No.** The two absence statements in the fixture (`ctx[3]` no soccer event listed; `ctx[5]` no dated gorjana drop) were neither cited nor converted; the `not_seen` fields (where present) name what the Brain could not see rather than asserting it does not exist. |

## 7. Entailment spot-check of the Brain's factual claims

Every named fact checked resolves to the rendered State: the agency and agent (`representation.agency`, `.agent`), Symbolic Systems in 2.5 years and the MS&E programme, the 4.07% engagement and 47.03% reach efficiency, 555.3 days since a TikTok post, 0.2333 posts/week and 12.1 days since the last Instagram post, "cooling", the diaspora note, Adidas, the three StartX1 inbounds as `deal_detected`. "Minor contraction phase" is not in State but is in the Objective's own proposed current state, rendered and cited. "Zero athletic peer competition" is carried from the cited opportunity's text, not independently in State.

## 8. What Stage 1 says about the six questions — observations only, decisions later

- **Q1 (inputs beyond Objectives).** In this run the map added citations, existing work added nothing, context re-timed one decision. State alone produced the substance. The honest reading is that the Brain, as specified, largely re-emits the Opportunity layer; what would make an input *necessary* was not exercised because the Brain never chose NO_ACTION or REQUEST_INTELLIGENCE on a live Objective.
- **Q2 (State vs Brain input).** The only context cited was athlete-proximate schedule (`ctx[0]`, `ctx[1]`). World context (USWNT, campus, brand activity) was not used. Too early to classify; one run.
- **Q3 (NO_ACTION / REQUEST_INTELLIGENCE).** Expressible, structurally validated, and reached for exactly where the input made it unavoidable (a deferral whose kind is `information`). Not reached for on any live Objective, including where the Brain itself listed what it could not see (`not_seen`) and where the design planted a known material gap (gorjana). The vocabulary exists; the disposition to use it did not appear.
- **Q4 (research as evidence-as-seen).** Not exercised (Stage 2 not run). The Brain's own request points at a `connected` read of Nomila's inbox threads, not external research.
- **Q5 (existing work).** No duplicates and no engagement. The block was present and inert.
- **Q6 (Recommendation vs planning).** Gate 1's narrow rule caught one opening verb; three further recommendations named deliverables (decks, packages, a workflow) that read as planning by inspection. All nine are one execution shape.

## 9. Not done, on purpose

No Stage-2 research or connected read. No tuning, prompt change, repair or rerun. No change to the fixture. No event on any Objective. The V0 refusal stands as the first-run result.

---

## 10. Review outcome (Mia, 26 Sep) — accepted; Stage 2 on hold

Stage 1 is accepted as a successful experiment. **Stage 2 does not proceed yet and the StartX1 threads are not read.** Mia's read, which the audit's evidence supports: the experimental Brain currently behaves primarily like Objective/State/Opportunity → specialized planning, rather than an independent portfolio-aware decision layer deciding whether anything should happen now. The observations above are not to be "fixed" by adding instructions; the next experiment distinguishes the decision problem first: `docs/architecture/commercial-intelligence/brain-decision-experiment-1b.md`.

Recorded from this run:

- **Positive architectural signal, preserved:** deferred-for-information Objective + known connected source → REQUEST_INTELLIGENCE against the existing StartX1 threads, without treating StartX1 as active, four of four. The connected read is not performed.
- **Invariant:** *satisfying an information condition does not itself reactivate an Objective.* Targeted intelligence may establish that the condition is satisfied and may eventually justify an `information_available` signal; it does not decide that the Objective becomes active or that Mia wants the opportunity pursued.
- **Reasoning-overreach candidate:** *a gap in the competition schedule is evidence of a schedule gap, not proof of athlete availability or execution capacity* (V3's "operational window"). No rule added; no tuning on this instance.
- **A limitation of this stage's own design, stated plainly:** the existing-work block never intersected the live portfolio (gorjana and the seven negotiations are commercial; the live Objectives are impact, positioning and audience), so Stage 1 could not have shown existing-work discrimination, and no bounded pending step existed in the real evidence for those Objectives. 1B constructs those intersections as controlled conditions.

