# Brain Experiment 1C.1 — audit (K1–K4 under spec 0.4.0-exp)

**Owner:** Mia
**Date:** 2026-09-26
**Design:** `docs/architecture/commercial-intelligence/brain-experiment-1c1.md` (approved with the final-paragraph wording; semantic-only intervention; joint pass condition).
**What ran:** `brain-eval-spec/0.4.0-exp` (digest `ffb97cd4…`) — the only change from 0.3.1 is the one approved block; verified before the calls that every overlay, request fixture and the context block are byte-identical to what the 1C artifacts recorded. Four calls once each, no tuning or rerun. Artifacts: `docs/audits/artifacts/brain-context-experiment-1/1c1/arm/K1..K4.json`; 1C's `1c/arm/` untouched. **Nothing materialised. StartX1 untouched, unread.**

**Headline — the semantics were sufficient, and did not overcorrect.** In every run where a request concerned the term-sheet step, the standing positioning decision **accounted for it, citing the request** (K2 cites both requests, K3 and K4 cite theirs), and did not propose the step itself. Where no request concerned it (K1) the standing decision still acted on the term sheet. K2 kept both answers, each substantive and in its asker's register, and each states that it proposes the same step as the other. K3 kept the series and the term sheet separate, with the audience decision standing down on its own work. K4's duplicate is gone — the standing decision says, in its own words, "to avoid proposing the same execution step twice". Yuwa and audience were decided on their own evidence in every run. **Joint pass on all four.** One caveat stated plainly: K1's set was refused by gate 1 on a production verb in an unrelated standing decision (the audience plan opened "Design…"), so K1's reading is of refused-set content. Two reliability findings recurred and one gate refusal occurred; none bears on the semantics.

---

## 1. Gates, usage, cost

| run | overlays | requests | tokens in / out / thought | latency | cost | gate 1 | gate 2 | output |
|---|---|---|---|---|---|---|---|---|
| K1 | R2 | K1a | 12,954 / 2,044 / 8,051 | 49.3 s | $0.029 | **refused** — `decisions[2]: what opens with a production verb ("design")` (the audience plan) | pass | none; raw parsed recorded |
| K2 | R2 | K2a + K2b | 12,974 / 2,587 / 11,384 | 65.9 s | $0.039 | pass | pass | accepted |
| K3 | R2 + R1 | K3a | 13,077 / 2,361 / 8,666 | 56.0 s | $0.032 | pass | pass | accepted |
| K4 | R2 + R4 | K4a | 13,079 / 1,686 / 9,078 | 53.1 s | $0.031 | pass | pass | accepted |
| **total** | | | | | **$0.130** | | | |

The block adds ≈ 1,100 chars; digest identical in all four.

## 2. Before / after — the standing positioning decision against the term-sheet step

| run | 1C (0.3.1-exp) | 1C.1 (0.4.0-exp) | relationship now |
|---|---|---|---|
| K1 (no request on the step) | RECOMMEND · direct_action · advances — owned it | RECOMMEND · direct_action · advances — "Review and respond to the pending term sheet"; cites the floor | **owns** (unchanged, correctly) |
| K2 (two requests on it) | RECOMMEND · specialized_plan · new_work — planned other outreach beside it | **NO_ACTION** — "the next steps for this negotiation are fully addressed and recommended in the decision requests (request[K2a] and request[K2b])"; cites both | **accounts, cited** |
| K3 (one request) | NO_ACTION citing `request[K3a]` — deferred | NO_ACTION — "currently the subject of an agent decision request (K3a) and is being addressed directly within that requested decision"; cites it | **accounts, cited** (unchanged) |
| K4 (one request) | RECOMMEND · direct_action — **duplicated** the request's counter | **NO_ACTION** — "being addressed directly through the response to the agent's decision request (request[K4a]). No duplicate or independent action is warranted… to avoid proposing the same execution step twice"; cites it | **accounts, cited** |

Under 1C the same evidence produced four relationships; under 1C.1 it produced one where a request concerned the step and the right other one where none did.

## 3. Ownership tables

Objectives: **Yuwa** `b1c799e3` · **Positioning** `c0f587e4` · **Audience** `feb62891`. NL = `work[ctl-r2-northlight-termsheet]`.

### K1 — unrelated request must not suppress (refused set, content read)

| decision | type | proposed next step | on | cites another decision | relation |
|---|---|---|---|---|---|
| request K1a (gorjana post?) | REQUEST_INTELLIGENCE · connected | proposition: a mandated posting deadline or delivery window this week | gorjana deal | — | — |
| Yuwa | RECOMMEND · specialized_plan | partnership presentation for CSR sponsors | — | no | new_work |
| Positioning | RECOMMEND · direct_action | "Review and respond to the pending term sheet" | NL | no | advances |
| Audience | RECOMMEND · specialized_plan | "Design a specialized cross-platform content reactivation plan…" (the gate-1 refusal) | — | no | new_work |

**Reading:** no suppression — each standing decision on its own evidence; the loop owns the term-sheet step because no request concerns it; the gorjana answer asks rather than acts, and cites `ctx[5]` (no dated gorjana drop announced) as evidence that nothing external dictates timing — the first use of the brand-activity item, and a correct use of an absence statement. **Overcorrection check: none.** The gate refusal is the same first-run verb lapse Stage 1 V0 showed; the refused set is read as content and marked.

### K2 — two parties, one next step

| decision | type | proposed next step | on | cites another decision | relation |
|---|---|---|---|---|---|
| request K2a (agent) | RECOMMEND · direct_action | counter to USD 7,602 — "This recommendation proposes the same counter-offer next step as the response to request[K2b]." | NL | **yes** | advances |
| request K2b (athlete) | RECOMMEND · direct_action | counter to USD 7,602, second person — "…the same counter-offer next step as the response to request[K2a]." | NL | **yes** | advances |
| Yuwa | RECOMMEND · specialized_plan | outreach plan to CSR brands | — | no | new_work |
| Positioning | NO_ACTION | — | NL | **cites `request[K2a]`, `request[K2b]`** | accounts |
| Audience | RECOMMEND · specialized_plan | channel strategy | — | no | new_work |

**Reading:** both requests received substantive answers in their askers' registers; decision multiplicity kept; the shared proposed step is named as shared by both answers — accounted for, not duplicated. The standing decision accounts for both requests with a cited ground, which is accounting, not suppression. **Overcorrection check: none** (no answer collapsed into "see the other"; the standing NO_ACTION is grounded and cited). Unlike 1C's K2, no additional outreach was planned beside the covered step.

### K3 — cross-advancement without false deduplication

| decision | type | proposed next step | on | cites another decision | relation |
|---|---|---|---|---|---|
| request K3a (agent) | RECOMMEND · direct_action | **accept** at USD 5,000 (floors read separately) | NL | cites `request[K3a]` | advances |
| Yuwa | RECOMMEND · specialized_plan | commercial deck concept | — | no | new_work |
| Positioning | NO_ACTION | — | NL | **cites `request[K3a]`** | accounts |
| Audience | NO_ACTION | — | `work[ctl-r1-tiktok-series]` | no | covered by work in flight |

**Reading:** *same execution step* — none shared between the series and the term sheet; neither treated as covering the other; no merged content work; the audience decision stands down on the series alone (as R1 and 1C's K3). *Same Objective / cross-advancement* — still not surfaced (nothing links the term sheet's four posts to the audience Objective). **Overcorrection check: none** (audience unchanged by the request, which concerns another step).

### K4 — coherence by suppression?

| decision | type | proposed next step | on | cites another decision | relation |
|---|---|---|---|---|---|
| request K4a (agent) | RECOMMEND · direct_action | counter to ≥ USD 7,602 | NL | no | advances |
| Yuwa | NO_ACTION | — | `work[ctl-r4-csr-outreach]` | no | in flight, awaiting replies |
| Positioning | NO_ACTION | — | NL | **cites `request[K4a]`** — "to avoid proposing the same execution step twice" | accounts |
| Audience | RECOMMEND · specialized_plan | cross-platform strategy from existing Reels | — | no | new_work |

**Reading:** the 1C duplicate is gone, by accounting with a cited ground, not by silence; Yuwa stands down on its own in-flight work; audience is decided on its own evidence and still plans. **Overcorrection check: none** ("a lot is happening" silenced nothing; the standing NO_ACTION names the request it accounts for).

## 4. Joint pass / fail

| criterion | result |
|---|---|
| K1 — unrelated request does not suppress standing reasoning | **pass** (on refused-set content; the refusal is unrelated to the semantics) |
| K2 — both requests answered substantively; multiplicity kept; shared proposed step not independently duplicated | **pass** — and the shared step is acknowledged by both answers |
| K3 — separate work stays separate; shared Objective relevance does not become false deduplication | **pass** |
| K4 — standing and requested answers no longer independently propose the same counter | **pass** — accounted for, cited |
| overcorrection: a standing decision NO_ACTION merely because a request exists | **not observed** — every standing NO_ACTION on positioning cites the request(s) it accounts for; K1's positioning, with no request on it, acts |
| overcorrection: collapsed multiplicity (K2) | **not observed** |
| overcorrection: false deduplication (K3) | **not observed** |
| **joint** | **pass** — four of four, on one run each |

Reading against the design's four outcomes: **coherent and legible.** The relationship in §2 is attributable from `cites`, `advances`, `what` and rationale in every run; no coordination field, id, schema or gate was needed to produce or to read it.

## 5. Reliability recurrences — recorded, outside the criterion

- **Rate / floor semantics, again, now inside one experiment:** K3 read the floors separately and accepted USD 5,000; K2 and K4 summed them to USD 7,602 and countered. Same State, same term sheet, three runs, two answers. The commercial-semantics pressure item stands (checkpoint §10.4). Not tuned.
- **Gate-1 verb refusal (K1):** the audience standing decision opened "Design…". Same lapse as Stage 1 V0; a reliability finding about first-run formatting, content intact.
- **Schedule / capacity:** K1's request `why_material` says she "can defer posting to avoid creating content unnecessarily during a heavy academic and travel week" — a capacity claim not in any input (the context says one away fixture in the window; nothing about a heavy week). K4's audience `why` says the workflow "requires minimal extra time". Two mild instances; logged under the closed finding.
- **A small entailment lapse (K4):** the request's `not_seen` lists "specific terms of exclusivity" although the overlay states "no category exclusivity". Gate 2 is resolution, not entailment.
- **StartX1:** REQUEST_INTELLIGENCE, `connected`, four of four; no `CONDITION_APPEARS_RESOLVED` this time. Nothing read, nothing written.
- **Cross-advancement:** still not surfaced in K1 or K3. Recorded.

## 6. What 1C.1 says, as observation

1. **Sufficiency.** Four sentences of decision-set semantics, and nothing structural, took the standing/requested relationship from four different behaviours on identical evidence to one consistent behaviour: account for a request on the same proposed step, citing it; own the step when no request concerns it.
2. **No overcorrection** on any of the three named risks. The rule did not become "requests win": K1's standing decision acted where no request existed, and every standing NO_ACTION on positioning is grounded in a cited request.
3. **Multiplicity kept, convergence acknowledged.** K2's two answers each name the other's step as the same step — legibility improved beyond 1C without any instruction to acknowledge.
4. **The coherence gate remains unbuilt and, on this evidence, unneeded to produce coherence.** Whether it is needed to *verify* it at scale is a later question.
5. **Each configuration ran once.** The semantics are sufficient on this evidence; stability across repeats is untested and is the honest next question if the checkpoint's semantics are to be relied on.

## 7. Not done

No rerun, no tuning, no further spec change. No Stage-2, no StartX1 read, no `information_available` writer, no production Brain contract, no coherence-gate implementation, no Campaign/Studio integration. Rate semantics, the gate-1 verb lapse, schedule/capacity, cross-advancement and the exclusivity misread are recorded as reliability findings only.

---

## 8. Review outcome (Mia, 26 Sep) — accepted; the decision-set coordination question is closed at the experimental architecture level

**Accepted finding:** *a small decision-set semantic rule was sufficient, on the tested evidence, to produce coherent standing/requested coordination without adding structural coordination machinery.* The controlled comparison is what carries it: under 0.3.1 the same architecture produced inconsistent standing/request relationships including K4's duplication; 0.4.0 changed only the decision-set semantics; K1–K4 then produced coherent accounting under the joint criterion; none of the predeclared overcorrection failures fired. Preserved specifically: K1, the standing loop still owned the Northlight step when no request concerned it; K2, both requested decisions remained independently answered while the standing decision accounted for the shared proposed step; K3, separate work remained separate and the standing decision accounted for the relevant request; K4, the previous duplicate counter disappeared and the standing decision explicitly accounted for the request.

**Limitation preserved exactly:** K1's ownership/coherence reading comes from refused-set content; the refusal was the previously observed, unrelated "Design" structural lapse at gate 1.

**Status of the semantics:** promoted in the checkpoint from *proposed semantics to challenge* to **experimentally supported design semantics — not yet a production contract**. Each 0.4 configuration ran once; repeatability remains a requirement before any production freeze, deliberately not spent now. The K1–K4 repeat stays available for when the production Brain contract is being prepared.

**Structural conclusion:** on current evidence no coordination/relationship field, no execution-step id, no ownership schema, no post-hoc repairing component, no coherence-gate implementation. The architecture stands: decision sources / Decision Requests → shared Brain over the decision set → coherent answer set → eventual refusing verification → downstream Recommendation / execution.

**Reliability findings recorded, 0.4 unchanged:** commercial floors/rates interpreted inconsistently again; unsupported capacity inference recurred; K4 treated exclusivity as unseen despite the overlay stating none; cross-advancement still not surfaced; StartX1 did not falsely resolve in this run. None is prompt-tuned into the decision-set semantics.

**Elevated:** commercial/rate semantics is now an upstream architecture pressure point, not a Brain-coordination issue — see the checkpoint §10.4 and §13.
