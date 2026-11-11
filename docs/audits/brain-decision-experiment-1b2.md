# Brain Decision Experiment 1B.2 — S3 only, under spec 0.2.1-exp

**Owner:** Mia
**Date:** 2026-09-26
**Design:** `docs/architecture/commercial-intelligence/brain-decision-experiment-1b1.md` §6 (the materiality test generalised to not acting; S3-only rerun approved).
**What changed, and only this:** `brain-eval-spec/0.2.0-exp` (`0a589ba6…`) → `0.2.1-exp` (`1a0e52f5…`): one paragraph appended to the REQUEST_INTELLIGENCE passage, through the full ceremony; NO_ACTION definition unchanged; 26 tests green. Overlay `1b/overlays/R3.json`, context, State discipline, map, model, gates, renderers byte-identical to 1B.1. One call, $0.025, run once, no rerun. Artifact: `docs/audits/artifacts/brain-context-experiment-1/1b2/arm/S3.json`. Prior artifacts untouched. **Nothing materialised. StartX1 untouched.**

**Headline (as first read): still bypassed.** *Reclassified on review — see §7.* Positioning → **NO_ACTION** again — "No further intervention is needed now because appropriate work is already in motion toward this objective. Mia's team has been in active negotiation since September 19, 2026, with Northlight Learning… which directly addresses her goal." The absent amount, terms and exclusivity are not mentioned anywhere in the output. This is the second of the three discriminating outcomes named in the design: NO_ACTION relying on the negotiation being appropriate or sufficient. Two S3 runs under 0.2.x now agree on this field, so it is not read as noise. The generalised text, as worded, did not change the Brain's judgment that an open negotiation *is* appropriate work regardless of what is known about it.

---

## 1. The run

| | value |
|---|---|
| gates | structural pass · grounding pass · output accepted |
| tokens | in 12,241 · out 1,778 · thought 6,875 (0.2.0-exp S3: 10,094 thought) |
| cost / latency | $0.025 · 41.7 s |
| prompt | 49,602 chars (the paragraph adds ≈ 850) |

## 2. Decisions

| Objective | decision | read |
|---|---|---|
| **Positioning (target)** | **NO_ACTION** — cites `objective[c0f587e4…]`, `work[ctl-r3-northlight-open]` ("an active, ongoing negotiation… established specifically toward this objective"), `opportunity[grow-academic-tech-partnerships]` | bypassed: the premise "appropriate work is already in motion" is asserted from the negotiation's existence; no fact the judgment depends on is named; no request. "Mia's team" is an inference from State's representation, not in the overlay |
| Yuwa | RECOMMEND · specialized_plan · new_work — a partnership deck; `not_seen`: past philanthropic campaign metrics | unchanged in type from 1B.1 |
| Audience | RECOMMEND · specialized_plan · new_work — dual-platform content strategy; cites `ctx[0]`, `ctx[1]`; `not_seen`: "her specific content production capacity and academic workload constraints" | unchanged in type; **schedule-gap conversion present**: "offers an ideal competitive lull to establish a sustainable dual-platform content strategy" — while, in the same decision, capacity is listed as unknown. Both behaviours in one output |
| StartX1 (deferred) | REQUEST_INTELLIGENCE · `connected` — "The details, budget, and scope of the inbound proposals from StartX1 have been retrieved and evaluated." | unchanged, correct, untouched |

Non-targets did not move in type. The S3 Adidas-citation anomaly from 1B.1 did not recur.

## 3. Against the three discriminating outcomes

| outcome | met? |
|---|---|
| REQUEST_INTELLIGENCE naming the materially missing information → landed | no |
| NO_ACTION while relying on the negotiation being appropriate or sufficient → still bypassed | **yes** |
| RECOMMEND execution despite the uncertainty → materiality not governing | no |

The materiality check on the requested information is moot: nothing was requested. Whether the Brain would have asked for every absent field or only the material ones remains untested.

## 4. Reading, as observation

- The 0.2.1 paragraph asks the Brain, before concluding that work is appropriately in flight, whether a fact it lacks could materially change that judgment. The Brain's output shows no sign of that question having been asked: the `why` moves from "in active negotiation" to "directly addresses her goal" in one step. Under both 0.2.0 and 0.2.1 the model treats the existence of a negotiation, delegated to her team, as sufficient for "appropriate", and does not treat unknown exclusivity or amount as bearing on that.
- Thought tokens fell from 10,094 to 6,875 between the two S3 runs with a longer prompt; a single observation, recorded because it is the only visible difference in how the run was reasoned.
- The schedule-gap conversion recurred on the audience decision ("ideal competitive lull") in the same output that lists capacity as unknown — the fourth 0.2.x instance (S5 ×2, S3-0.2.1 ×1, plus the correct `not_seen` treatment in five decisions). Kept as an unsupported-inference finding; not tuned.

## 5. Not decided here — options for Mia, none taken

1. **Variance check:** a second S3 run under 0.2.1-exp would show whether the bypass is stable at n=2 under this text as it was under 0.2.0 (it agrees across 0.2.0 and 0.2.1 already, which is suggestive but not the same thing).
2. **The premise itself:** is NO_ACTION wrong here? The overlay says a negotiation is open with nothing recorded; the Brain infers her team is running it and that Nomila has nothing to add. If Nomila's role in a negotiation her agent is running is genuinely nothing, the missing terms are material to *her agent's* decision, not to Nomila's — and the Brain's answer is defensible. If Nomila is meant to judge whether the negotiation is appropriate to her positioning (an exclusivity that would collide with the Objective), the answer is wrong. This is a question about what the Brain is *for* in a delegated negotiation, and it should be decided before the text is changed again.
3. **Wording:** a sentence that names the judgment directly ("work whose appropriateness you cannot judge from what you hold is not known to be appropriate") is close to the general form and may land; anything that names terms, amounts or exclusivity would be the special case Mia ruled out.

## 6. Not done

No rerun, no second call, no further spec change. S2, S4, S5 stand as the 0.2.0-exp controls. No Stage-2 research, no StartX1 read, no 1C, no production Brain.

---

## 7. Review outcome (Mia, 26 Sep) — S3 reclassified: ambiguous, premise not established

The repeated S3 result exposed an assumption in the experiment rather than proving another prompt failure: **it was never established that the missing amount, terms and exclusivity were material to the decision the Brain believed it was making.** If the decision is "should Nomila create additional work toward the positioning Objective now?", NO_ACTION is defensible without the terms — relevant work is under way and the agent is handling it. The terms become material only under other questions ("should Northlight be advanced or accepted?"; "can Northlight proceed alongside another relationship?"), and different facts are material to each.

- The expectation that S3 had to produce REQUEST_INTELLIGENCE is **withdrawn**. S3 is **ambiguous — premise not established**, not a clean failure of the materiality rule.
- Recorded principle, not yet in any production contract: **materiality is relative to the decision being made; a fact is not globally material merely because it is commercially important.**
- The general-form sentence proposed in §5.3 is **not added**: "appropriate" is itself ambiguous, and the sentence could make the Brain request deal details whenever in-flight work appears, whatever the decision.
- Next: a decision-relative materiality experiment in which the decision question is an explicit, sourced input — `docs/architecture/commercial-intelligence/brain-decision-relative-materiality.md`. If it shows the per-Objective question is underspecified, that is an architectural finding leading into 1C, not prompt prose.
- **Schedule gap:** no further prompt wording. "Ideal competitive lull" beside "production capacity unknown", with the prior occurrences, is a repeated unsupported-inference problem; the current rule stays and the failures are logged until the mechanism (evidence semantics, entailment validation, context typing) is chosen.

