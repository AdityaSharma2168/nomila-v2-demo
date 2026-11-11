# Brain Decision Experiment 1B.1 — audit (S2–S5 under spec 0.2.0-exp)

**Owner:** Mia
**Date:** 2026-09-26
**Design:** `docs/architecture/commercial-intelligence/brain-decision-experiment-1b1.md`, approved with the materiality-threshold wording. Four calls approved and run once, in order, unchanged; no repair, rerun or tuning between them.
**What changed, and only this:** `brain-eval-spec/0.1.0-exp` (digest `d470d089…`) → `0.2.0-exp` (digest `0a589ba6…`), three text insertions through the full ceremony. Same State snapshot discipline, same map, same live Objectives, same approved context, the same four overlays byte-for-byte from `1b/overlays/`. Artifacts: `docs/audits/artifacts/brain-context-experiment-1/1b1/arm/S2..S5.json`; `1b/arm/` and `arm-a/` untouched. **Nothing materialised. StartX1 untouched. No Stage-2 research, no connected read.**

**Headline.** Two of the three principles landed cleanly and one did not fire. **Work in flight (1b):** S4 produced NO_ACTION on Yuwa — "appropriate work is already actively in flight… it is correct to wait for external responses" — where R4 had manufactured supporting work. **Anti-over-trigger (S2):** the known-terms case stayed a bounded direct action, unchanged from R2, with its minor unknowns still in `not_seen`. **Planning control (S5):** unchanged, no suppression. **Decision-material missingness (1a) did not fire in S3:** the Brain did discriminate the S2/S3 contrast — terms known → act, terms absent → do not act — but it expressed the absent-terms case as NO_ACTION under the widened "work in flight" definition, and the missing terms, which R3 had at least named in `not_seen`, disappeared from the output altogether. The two new principles interacted: an open negotiation with nothing recorded now reads as "appropriate work in flight", and the materiality question is worded to run "before recommending execution", so it never ran. **Schedule gap (1c):** reduced, not eliminated — absent from S2, S3 and S4 (which now put availability in `not_seen`, the correct treatment), present in S5 on two of three decisions.

---

## 1. Gates, usage, cost — per run

| run | repeats | overlay | tokens in / out / thought | latency | cost | gate 1 | gate 2 | output |
|---|---|---|---|---|---|---|---|---|
| S2 | R2 | term sheet, no response sent | 12,167 / 2,264 / 9,791 | 58.5 s | $0.034 | pass | pass | accepted |
| S3 | R3 | negotiating, nothing recorded | 12,107 / 1,608 / 10,094 | 57.4 s | $0.033 | pass | pass | accepted |
| S4 | R4 | proposal sent to six brands, no reply | 12,126 / 1,750 / 7,417 | 42.4 s | $0.027 | pass | pass | accepted |
| S5 | R5 | none | 11,980 / 1,872 / 7,562 | 46.6 s | $0.027 | pass | pass | accepted |
| **total** | | | | | **$0.121** | | | |

Prompt 48,371–48,855 chars (the three insertions add ≈ 1,320 chars over 1B). Digest `0a589ba6…` asserted in all four. No format refusal this time; the 1B refusals stay logged as reliability findings and nothing was changed about citation formatting.

## 2. Before / after on the stable fields

Objectives: **Yuwa** `b1c799e3` · **Positioning** `c0f587e4` · **Audience** `feb62891`.

| pair | target | 1B (0.1.0-exp) | 1B.1 (0.2.0-exp) | read |
|---|---|---|---|---|
| R2 → **S2** | Positioning | RECOMMEND · direct_action · advances `work[ctl-r2…]` · `not_seen`: marketing timeline, deliverable detail | RECOMMEND · direct_action · advances `work[ctl-r2…]` — "Instruct her agent to review and respond to the pending USD 5,000 academic-year ambassador term sheet from Northlight Learning." · `not_seen`: her schedule for the four posts; "any category exclusivity conflicts with other active conversations or her Adidas deal" | **held** — no over-trigger; the floor connected from State again ("exceeds her recorded… floor of USD 3,602"); the contract start date read from the overlay |
| R3 → **S3** | Positioning | RECOMMEND · direct_action · advances `work[ctl-r3…]` · `not_seen`: "the proposed commercial terms, financial budget, and specific deliverables" | **NO_ACTION** — "An active brand partnership negotiation is already underway with EdTech brand Northlight Learning, meaning appropriate work is in flight to address this objective." · cites `work[ctl-r3…]`, the map opening, and `opportunity[unlock-adidas-historical-performance-data]` | **changed, but not to a request** — the discrimination against S2 is real (known terms → act; unknown terms → do not act); the absent facts are no longer mentioned anywhere |
| R4 → **S4** | Yuwa | RECOMMEND · specialized_plan · advances `work[ctl-r4…]`; supporting assets manufactured | **NO_ACTION** — "Appropriate work is already actively in flight. A CSR partnership proposal was recently sent on 20 September 2026 to the corporate impact teams of six brands, and it is correct to wait for external responses from these targets before initiating further outreach campaigns." · cites `work[ctl-r4…]` | **landed** — waiting tolerated, grounded in the item, no additional work |
| R5 → **S5** | Positioning | RECOMMEND · specialized_plan · new_work | RECOMMEND · specialized_plan · new_work — "Create a tailored commercial partnership presentation…" | **held** — planning where planning is warranted; no suppression |

**Non-target Objectives** did not move in decision type, path or relation in any run: Yuwa and Audience stayed RECOMMEND · specialized_plan · new_work in S2 and S3; Positioning and Audience in S4. No portfolio effect.

**Noise floor.** 1B established that type, path and relation are stable across identical inputs (V3, R0, R5 — nine of nine) while wording and context citation drift. The S3 and S4 changes are on the stable fields and are read as spec effects. Each is one run; the 1B counterparts were one run each.

## 3. The paired contrasts

**S2 / S3 — terms known versus decision-material terms absent.** The Brain separated the pair: with the term sheet in hand it produced a bounded action attached to the item; with nothing recorded it stood down. What it did not do is the thing 1a asked for: treat the absent amount, terms and exclusivity as facts the decision materially depends on and request them. Why, reading the spec as shipped: the widened NO_ACTION says "appropriate work is in flight" is a complete answer, and an open negotiation is work in flight; the materiality question is phrased "before recommending execution", so a Brain that is not recommending execution never asks it. The result is a NO_ACTION whose premise — that the work in flight is *appropriate* — depends on exactly the facts nobody holds (is there an exclusivity that collides with her positioning; is the amount below her floor), and the output carries no trace of that dependency. R3 at least listed them. **1a and 1b interacted, and 1b won.**

Also in S3: a citation of `opportunity[unlock-adidas-historical-performance-data]` — the Adidas evidence opening — in support of the positioning NO_ACTION. It resolves (gate 2 is resolution, not entailment) and bears on nothing in the decision; recorded as a spurious citation.

**S4 / S5 — work appropriately in flight versus nothing in flight.** Separated exactly as designed: NO_ACTION with the proposals-in-flight reason in S4; a plan in S5. Per Mia's nuance, S4's NO_ACTION is read as following from this fixture holding no evidence that another intervention was warranted, not as "waiting means NO_ACTION". S4's `why` says as much: "correct to wait for external responses… before initiating further outreach campaigns".

## 4. The schedule-gap check, per decision

Legitimate use: schedule cited for timing. Failure: gap converted into availability, capacity or readiness.

| run | Yuwa | Positioning | Audience |
|---|---|---|---|
| S2 | no schedule cite; capacity listed as unknown in `not_seen` ("her capacity to film or edit content given her academic and athletic commitments") | no schedule cite | no schedule cite; capacity in `not_seen` |
| S3 | no schedule cite | no schedule cite (NO_ACTION) | no schedule cite; capacity in `not_seen` ("weekly capacity and available hours… during her active… season and MS program") |
| S4 | no schedule cite (NO_ACTION) | no schedule cite | no schedule cite; availability in `not_seen` |
| S5 | **failure** — "the current low-density competitive schedule offers a flexible window to prepare corporate partnership materials"; `ctx[1]` cited as "creating campus-based preparation time" | no schedule cite | **failure** — "an upcoming 26-day gap in home soccer fixtures that allows for content production"; `ctx[1]` "freeing up time on campus for content batching" |

Under 1B the conversion appeared in four of six runs (R0 on all three decisions; R1, R3, R4 on one each). Under 1B.1 it appeared in one of four runs, on two decisions, and three runs instead placed capacity where it belongs, in `not_seen`. **Reduced, not eliminated.** The same fixture and the same sentence produced both behaviours; S5 is the run with no overlay, where the map openings are the only thing that bears on the decisions and the schedule is the only "moment" available to cite.

## 5. StartX1 across the four runs

REQUEST_INTELLIGENCE in the deferred block in four of four, source class `connected` in all four (no `external` this time); never in `decisions[]`; nothing mutated, no connected read made. S2's `why` closes "Obtaining this intelligence is essential to resolve her deferral condition" and S3's "would resolve her information condition" — consistent with the recorded invariant that resolving the condition is not reactivation. S5's proposition again presumes the answer ("terms that align with Mia's brand values and meet her baseline floors") — the same pattern as R5 and 1B's R2; recorded, not a transition matter.

## 6. Observational execution shape

| run · Objective | Brain's path | reviewer's shape |
|---|---|---|
| S2 · Positioning | direct_action | **direct action** — review and respond to the term sheet |
| S3 · Positioning | NO_ACTION | **unclear** — the shape that belonged was intelligence acquisition; the output is a stand-down with the dependency dropped |
| S4 · Yuwa | NO_ACTION | NO_ACTION (waiting on external responses) |
| every other RECOMMEND (S2–S5, 8) | specialized_plan | larger plan/campaign |

Three shapes emerged again — NO_ACTION, direct action, larger plan. Intelligence acquisition on a live Objective has still not emerged in fourteen runs across three experiments.

## 7. Other observations

- Intent citations appeared for the first time: `preferences[onboarding_goal.grow_my_following]` on the audience decisions (S2, S4) — apt; and `preferences[onboarding_goal.get_my_first_deal]` on S3's Yuwa decision, "matches her onboarding ambition of getting her first deal" — a real State path, a stretched use.
- S5's positioning `not_seen` names "the exact brand categories of existing negotiations with AEGISLAB, Connect Me, and Pillar" — the first time any run has looked at the seven real negotiations at all; still as an unknown, not as a request.
- Gate 2 remains resolution, not entailment (the Adidas cite in S3).

## 8. What 1B.1 says, as observation — and what it does not decide

1. **Work in flight (1b): landed.** S4 stood down with the right reason; S5 still planned; no suppression elsewhere.
2. **Anti-over-trigger (S2): held.** Known terms → bounded action, unchanged.
3. **Decision-material missingness (1a): did not fire.** Not because the Brain failed to notice the contrast — it did — but because the widened NO_ACTION absorbed the case first and the materiality question is scoped to "before recommending execution". A candidate refinement, **not made here**: the materiality question should also govern the judgment that work in flight is *appropriate* — "before deciding that existing work covers the need or is appropriately in flight, ask whether a fact you do not have could materially change whether it does". One run; to be confirmed, not assumed.
4. **Schedule gap (1c): reduced, not eliminated.** Three of four runs treated capacity as an unknown; one converted the gap twice.
5. **StartX1:** unchanged, correct, `connected` ×4.
6. No gate refusals; the 1B format refusals stand as logged.

## 9. Not done, on purpose

No tuning, repair or rerun. No further spec change (the §8.3 candidate is proposed to Mia, not made). No Stage-2 research, no StartX1 connected read, no 1C, no production Brain.
