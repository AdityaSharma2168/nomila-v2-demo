# Brain + Context Intelligence — experiment 1 (design)

**Owner:** Mia
**Date:** 2026-09-25
**Status:** direction agreed 2026-09-25 with three clarifications (§2.1 the live-Objective boundary and the deferred condition, §2.5 the context block as an experimental envelope, §3.1 the existing-work classification). Implementation may follow; **no provider call until stage 1 is explicitly approved**. The Objective boundary checkpoint is closed (`docs/audits/objective-validation-cohort.md` §7); this is step 4 of the sequence in `context-intelligence.md` §8.
**Builds on:** `context-intelligence.md` (the principle, the two modes, §6 the StartX1 constraint, §9 the open questions), `objective-knowledge-boundary.md` (the gap stays upstream for REQUEST INTELLIGENCE), `campaign-slice-design.md` (#570, the adapter that must not invent intent), `objectives-lineage-design.md` (evidence-as-seen, deferral kinds).

---

## 0. In plain words

**What Mia would experience, if this were live.** Nomila looks at the three things she has actually decided to pursue, at what it knows about her, at what is already in motion (gorjana, the seven conversations, the StartX1 threads) and at what is happening around her this fortnight — a Stanford fixture, a result, a moment — and says, for each of the three: *nothing to do right now, and why* · *here is one thing worth doing, why, and what kind of thing it is* · *I need to know something before I can say, and here is what*. It never tells her which shots to film. It never repeats a goal back to her as advice. It never recommends the deal she already has.

**What happens underneath, in this experiment.** Nothing goes live. A frozen experimental Brain evaluator is run by a script against Mia's real governed portfolio, with its inputs added one block at a time, so that the artifacts show which input changed which decision. Every claim the Brain makes must cite a path that resolves, as the Opportunity and Objective evaluators already must. The output is a set of artifacts and an audit page, not a table, not a screen.

## 1. The questions, and what in the experiment answers each

These are the open questions from `context-intelligence.md` §9 as Mia restated them. They are answered by observation, not settled in advance.

| # | question | what answers it here |
|---|---|---|
| Q1 | What does the Brain actually need as inputs beyond governed Objectives? | the **ablation**: the same Brain run with inputs added cumulatively (§4); the diff of decisions between adjacent runs says which input changed a decision and which was noise |
| Q2 | Which contextual signals should enter State, and which remain contextual Brain inputs? | context is supplied as a **separate cited block**, never through State, in this experiment; afterwards every context item the Brain cited is classified: athlete's-own-situation vs world, and whether an Opportunity/Objective evaluator would also have needed it (§7). The decision follows the data |
| Q3 | How does the Brain express NO ACTION and REQUEST INTELLIGENCE? | both are **first-class outputs of the experimental contract** (§3), structurally validated; the run shows whether the evaluator reaches for them where they are right (Yuwa in a quiet fortnight; obligations it cannot see) |
| Q4 | How does targeted research return as durable evidence-as-seen? | **stage 2** (§5): each REQUEST INTELLIGENCE is answered, the answer is persisted as a versioned block with sources, the Brain is rerun with it cited, and the decision is compared |
| Q5 | How does the Brain handle existing work so it does not recommend duplicates? | the **existing-work block** (§2.4) built from real rows; success is that no recommendation duplicates the gorjana deal or a negotiating thread, and that in-flight work is recognised as such |
| Q6 | Where does the boundary between Recommendation and Campaign/Creative planning fall? | a **forbidden-content gate** on the Brain's output (§3) plus a reading of every RECOMMEND: was WHAT and WHY complete without any creative or scheduling content, and what would the Campaign adapter (#570) need from it not to invent intent (§7) |

One hypothesis is added because the portfolio makes it testable, framed as Mia framed it: **H-deferral — can the Brain identify and resolve the information condition associated with a deferred Objective without treating that Objective as active?** StartX1 is deferred for information; the Brain may name that condition and request what resolves it. The experiment **does not** mutate StartX1, re-surface it, or write `information_available` into governance state. It records whether the returned evidence appears sufficient that a future `information_available` writer *would* fire, and why; that result is inspected before any Brain or intelligence output is ever connected to the deferral transition. The rule this preserves: the Brain cannot silently reactivate something the athlete deferred.

## 2. Inputs — five blocks, each versioned, each citable by path

The Brain reads only what it is given, rendered by the same discipline as the other evaluators: prose it may cite by the path at the left of each line, never a free-floating fact.

### 2.1 GOVERNED OBJECTIVES — `liveObjectives()`, the Brain's only door

Mia's three live Objectives as they stand on dev, with the wording she gave them (the MEASURED `athlete_intelligence`-owned desired state), origin, horizon, and the lineage summary (domain, opportunity keys). Cited as `objective[<id>]`.

| id | domain | her wording | horizon |
|---|---|---|---|
| `feb62891` | audience (joint, modified) | "Grow my audience and build a stronger, more consistent presence across Instagram and TikTok." | — |
| `c0f587e4` | positioning (joint, modified) | "Build my positioning at the intersection of athletics, technology, AI, innovation and entrepreneurship, and secure partnerships that align with that identity." | next_12_months |
| `b1c799e3` | impact (nomila, modified) | "Expand the impact and visibility of my work with Yuwa through aligned global brand and CSR partnerships." | multi_year |

**The live-Objective boundary.** These three are the Brain's active portfolio and the only things it recommends on. StartX1 does **not** enter through this door. It is rendered in a separate block, `DEFERRED — standing information conditions`, as history and context: `disposition deferred · lifecycle proposed · deferral kind information · the athlete's reason: "When u know more about this"`, cited as `deferred[<id>]`. The Brain may name the information condition and issue REQUEST_INTELLIGENCE against it (H-deferral); it may not recommend on it, re-propose it, or treat it as active. Adidas metrics is rendered as `declined 2026-09-25` and nothing may be done with it.

### 2.2 STATE — the same rendered block the Opportunity evaluator reads

`athlete-state/1.2.0`, the snapshot as of the run, persisted with the artifact (evidence-as-seen). Cited by State paths as today.

### 2.3 OPPORTUNITY MAP — the latest persisted map for Mia

Rendered as the Objective evaluator's input block. Cited as `opportunity[<key>]`. The Brain does not re-derive openings; it may use them as a prior layer's judgment about where an Objective is most tractable, and it may name an `evidence`-domain opportunity as the ground of a REQUEST INTELLIGENCE.

### 2.4 EXISTING WORK — `existing-work/0.1.0`, assembled from real rows

What is already in motion, so the Brain cannot recommend it again. Assembled by the run script from the tables that exist today, no hand-editing:

| kind | source | what Mia's block will hold |
|---|---|---|
| accepted deal | `deals` status accepted | gorjana, $14,000 (7,500 cash / 6,500 product), accepted 29 Jul; **no term dates, no deliverables** (0 rows in `deal_deliverables`; `term_end` null on every deal) |
| negotiating | `deals` status negotiating | seven threads by brand name and date |
| ~~detected, repeated~~ | dropped at implementation | the inbox classifies recurring senders (newsletters, repeated pitches) as detections, so "same brand ≥ 2" put Temu and SoFi beside StartX1; a detection is a signal, not work, and State already carries it in the pipeline counts and inbound list. StartX1 reaches the Brain through State and its deferred Objective |
| objectives under review | `reviewQueue()` | none (queue empty after Mia's decisions) |

Cited as `work[<deal id>]`. **The gap is part of the experiment:** Nomila holds no deliverable or term for the one accepted deal. A Brain that recommends around gorjana without knowing what is owed is guessing; the honest outputs are REQUEST INTELLIGENCE (source class `athlete` or `connected`) or a recommendation that says what it could not see. Which one it produces is a Q3/Q4 observation.

### 2.5 CONTEXT — `context-block/0.1.0`, hand-assembled from real public sources

The continuous-mode inputs named in `context-intelligence.md` §8, for the fortnight after the run date, each with source, as-of and confidence, each an observation and never a verdict. Assembled by hand once, committed with the artifacts, labelled as hand-assembled. Nothing from it enters State.

| id | kind | what is gathered |
|---|---|---|
| `ctx[0]`, `ctx[1]` | schedule | Stanford women's soccer: the next two fixtures (date, opponent, home/away), from the official schedule |
| `ctx[2]` | recent result | the most recent result and Mia's part in it if reported, from the official recap |
| `ctx[3]` | upcoming occasion | one relevant event in the window (a conference or programme event, an awards or appearance date), from an official source |
| `ctx[4]` | sport-wide hook | one current national-team or league moment in her sport, from a major outlet |
| `ctx[5]` | brand activity | gorjana's current campaign or launch, from the brand's own channels |
| `ctx[6]` | **control** | one real, dated, plainly irrelevant world item (another sport, another country). If the Brain cites it, that is noise measured |

The block is small on purpose: seven items, one per kind, one control. The point is to measure what the Brain does with each kind, not to build a collector.

**This block is an experimental evidence envelope, not a Context Intelligence contract.** Nothing about its shape, its seven kinds or its versioning is inferred to belong in Athlete State or in a permanent `ContextBlock` schema. The experiment exists to discover, from what the Brain actually cites and what changes its decisions: what context the Brain consumes at all; what of it belongs in State as a citable fact about the athlete's own situation; what should remain separate contextual evidence; what should only ever be fetched on demand; and what evidence-as-seen must be persisted for the run to be reproducible. The fixture helps discover the contract; it does not become it.

## 3. The experimental Brain — `brain-eval-spec/0.1.0-exp`

**Experimental, not a contract.** The Brain contract is step 5 and is written from what this run shows. The evaluator is nonetheless built with the full apparatus, because the apparatus is what makes the artifacts reviewable: prompt as methodology under a digest pin with parity tests; a structural gate and a grounding gate in the execution path; no provider import anywhere under `server/services/intelligence/brain/`; the provider call in an orchestrator beside the Objective one; a script `brainRun.ts` that writes `{ inputs, record }` artifacts and touches no table.

**What the Brain is told it is.** It owns WHAT and WHY. It reads the five blocks. For every live Objective it returns exactly one decision. It does not rank Objectives, does not invent capacity or dates, does not restate an Objective as advice, does not describe creative work, and does not recommend what is already in motion.

**Output, per live Objective — one of three:**

```
NO_ACTION            { objective, why, cites[] }
                     the Objective is best served by monitoring now; why must cite what was read

RECOMMEND            { objective, what, why, executionPath: direct_action | specialized_plan | campaign,
                       cites[], notSeen?[] }
                     what: one sentence, the thing worth doing, as WHAT not HOW
                     executionPath: the class of thing it is, for the execution path to route — never the plan
                     notSeen: what the Brain could not see and chose to recommend anyway, named

REQUEST_INTELLIGENCE { objective | deferred objective, proposition, whyMaterial, sourceClass: athlete | connected | external,
                       cites[] }
                     a named proposition, why resolving it would change this decision, where it should be resolved
```

**Gate 1 (structural).** Exactly one decision per live Objective, none for declined, at most one per deferred-information Objective and only REQUEST_INTELLIGENCE. Forbidden fields and content, refused as the Objective spec refuses plan-shaped fields: `shots`, `format`, `caption`, `script`, `schedule`, `cadence`, `postingPlan`, `budget`, `deadline`, `date`, `rank`, `priority`, `score`, `channelPlan`. A `what` that opens with a creative or production verb (film, shoot, edit, design, storyboard, caption) is refused. No lexical heuristic beyond that: whether a RECOMMEND has crossed into planning is otherwise judged by reading (§7), as the knowledge boundary is.

**Gate 2 (grounding).** Every entry in `cites[]` resolves: `objective[id]` to a live or deferred Objective, a State path through `resolveStatePath`, `opportunity[key]` to the map, `work[id]` to the existing-work block, `ctx[n]` to the context block. A RECOMMEND with no cite outside `objective[…]` is refused: a recommendation grounded only in the Objective's own wording is the Objective restated.

### 3.1 The existing-work classification — observational, not schema

For every RECOMMEND the audit classifies its relationship to existing work as one of: **new work** (no existing execution object represents it) · **advances existing work** (it should attach to or continue an existing deal, campaign or action, named) · **no new work** (existing work already covers it, it is redundant, or no additional execution step is warranted). The Brain is asked to state which it believes applies and to cite the `work[…]` it read; the reviewer classifies independently, and the two are compared. This is not frozen into the Recommendation schema. The invariant it tests: **the Brain must not recommend duplicate execution merely because it sees an Objective without understanding work already underway toward it.**

**The gorjana gap is the sharpest case.** Nomila knows the deal exists and holds no deliverables or term dates. The Brain must not invent contractual facts, and must not assume a new activation is safe merely because it cannot see those details. Where the missing obligations materially affect whether a recommendation is appropriate, REQUEST_INTELLIGENCE is a valid and potentially preferable result, and a RECOMMEND that proceeds anyway must say so in `notSeen`.

**No tuning.** One spec, one prompt, every variant, every stage. If a variant exposes a prompt weakness, it is recorded and the run continues unchanged, as the cohort did.

## 4. Stage 1 — the ablation (Q1, Q3, Q5, Q6)

Four runs on Mia, inputs added cumulatively, the same spec:

| run | blocks | what its diff against the previous run shows |
|---|---|---|
| V0 | Objectives + State | what the Brain does with governed Objectives and State alone — the floor |
| V1 | + Opportunity map | whether a prior layer's map changes WHAT the Brain recommends, or only its citations |
| V2 | + Existing work | whether the Brain stops duplicating gorjana / the negotiations, and whether the missing deliverables produce REQUEST_INTELLIGENCE |
| V3 | + Context | which context kinds changed a decision; whether the control item was cited; whether NO_ACTION appears where the fortnight holds nothing for an Objective |

**Measured, per Objective, across V0→V3:** the decision type; the `what` (did it change, and because of which newly added block, by citation); the cites by block; whether any RECOMMEND restates the Objective; whether any RECOMMEND names in-flight work; whether the control item is cited anywhere. A block that changed no decision and drew no citation is, for this run, noise; a block that changed a decision is a needed input. That is the empirical answer to Q1, for one athlete, one fortnight, and is presented as exactly that.

## 5. Stage 2 — the research loop (Q4, H-deferral)

For each REQUEST_INTELLIGENCE in V3 (expected candidates: what is owed on gorjana; who StartX1 is), and for at most three:

1. **Resolve it** by the source class it named. `athlete` → Mia answers, in the app or to the reviewer, and the answer is recorded as an assertion in the canonical athlete-owned store as the rules already require (never pasted into a prompt). `connected` → read from what Nomila holds. `external` → one targeted research call, **each approved individually**, through the existing research path. No new collector.
2. **Persist the answer as evidence-as-seen:** an artifact `targeted-research/0.1.0 { version, proposition, requestedBy: { run, objective }, block, sources[], asOf }`, committed beside the run. This is the same discipline L0 applied to the State snapshot and map: the block the Brain will cite is the block that is kept.
3. **Rerun V3 with the answer** as a sixth block, cited as `research[<n>]`. Compare: did the decision change; did the Brain cite the answer. For StartX1: the Brain is asked only whether the deferred information condition now appears resolved, and why. **StartX1 is not mutated, not re-surfaced, and `information_available` is not written.** The audit records whether the evidence looks sufficient that a future writer would fire, with the reasoning, for inspection before anything is connected to the deferral transition.

If V3 produces no REQUEST_INTELLIGENCE at all while gorjana's deliverables are unknown, that is a finding about the vocabulary or the prompt, recorded, and stage 2 runs once with the gorjana question posed by the reviewer instead.

## 6. Arm B, optional and strikeable — one cohort athlete

Ilona Maher's `objective-1.0.2` set (four world outcomes, the richest map), fed to the Brain **as if accepted**, plainly labelled hypothetical, nothing governed, nothing materialised; existing work empty (Nomila holds none for her); a hand-assembled context block of the same seven kinds. Same V0→V3. What it adds: whether the Brain's need for inputs is Mia-shaped. What it costs: four more calls and a second context block to assemble. Recommendation: **defer it** unless Arm A leaves Q1 ambiguous; the Objective cohort already showed the upstream layers are athlete-general, and the Brain contract can be validated on a second athlete once it exists.

## 7. What is read after the run — the audit page

One page, the shape of the cohort audit:

- **Per Objective, per variant:** the decision, the `what`, the cites, with the diff explained.
- **Q1:** the table of blocks → decisions changed → verdict needed / not needed / noise, for this run.
- **Q2:** every cited `ctx[n]` classified as athlete's-own-situation or world, and whether an Opportunity/Objective evaluator would have needed it as a citable path. The candidates for `dates[]` (and only those) are listed. Decision proposed, not made.
- **Q3:** where NO_ACTION and REQUEST_INTELLIGENCE appeared, whether they were right by reading, and whether their fields carried what the execution path would need.
- **Q4:** the stage-2 artifacts, the reconsideration diff, and whether `{version, block, sources}` was enough for the Brain to cite and for a reader to reproduce.
- **Q5:** duplicates — any RECOMMEND that names or implies gorjana or a negotiating thread; how the Brain referred to in-flight work.
- **Execution shape, observation only (Mia, 25 Sep):** every RECOMMEND is annotated by the reviewer with the downstream execution shape it appears to require — **direct action** (a bounded executable step: respond, follow up, connect, provide) · **larger plan/campaign** (coordinated multi-step or persistent activation) · **intelligence acquisition** (the apparent recommendation is really to obtain missing information) · **unclear** (does not map cleanly yet). Not a gate, not a frozen taxonomy; no output is rejected or rewritten because of it. The purpose is to learn whether the execution-path boundary naturally separates into direct action / planning / intelligence / no action before that contract is designed. NO_ACTION and REQUEST_INTELLIGENCE are first-class decisions and are not forced through this annotation.
- **Q6:** every RECOMMEND read against the boundary: was WHAT/WHY complete without planning content; what the Campaign adapter would need from it (an Objective id, a why, an execution-path class, a window?) so as not to invent intent — the input to the Brain contract and to #570's adapter.
- **Attribution A/B/C/D** for every failure, as before; C findings go to the Brain contract, B to the spec backlog.
- **What would show the design needs to change:** the Brain cannot produce NO_ACTION when the fortnight holds nothing; it cannot cite context unless it is in State; it never requests intelligence with a known material gap in front of it; its recommendations are Objectives restated; it needs a field the experimental contract does not have.

## 8. Cost, calls, rules

**Input size is recorded for every variant (prompt characters, characters per block, prompt and output tokens) and is not optimised during experiment 1.** The 34k–51k-character dry prompts are accepted as they are; one purpose of the experiment is to learn what the Brain actually needs before the input contract is tightened.


| | calls | cost |
|---|---|---|
| Arm A, stage 1 (V0–V3) | 4 | ≈ $0.12 |
| Arm A, stage 2 (≤ 3 reconsiderations) | ≤ 3 | ≈ $0.09 |
| targeted research (external only) | ≤ 3, **each approved separately** | per the research path |
| Arm B, if kept | 4 | ≈ $0.12 |

Nothing materialised: no table, no migration, no flag, no screen, no event on any Objective — in particular no change to StartX1's deferral. The Brain code is experimental and unmounted. Athlete answers flow through the canonical athlete-owned store, never into a prompt. No targets, cohort or calibration language reaches the provider. No per-athlete tuning; the one spec runs every variant unchanged. Tests are synthetic; Mia is the forcing function, never the fixture. The context block is a hand-assembled, versioned, committed fixture of real public facts and is labelled as such in every artifact.

## 9. Sequence after this page

1. Review of this design.
2. One PR: the experimental evaluator, its gates and tests, `brainRun.ts`, the existing-work assembler — no provider call, no run.
3. Approval for the stage-1 calls; the run; artifacts committed.
4. Stage 2, with each external research call approved on its own.
5. The audit page; Q1–Q6 answered as observed; Brain-contract design written from it (step 5 of `context-intelligence.md` §8).

No Brain implementation beyond the experimental evaluator until the contract design is reviewed.

---

**Agreed (25 Sep):** the live-Objective boundary with StartX1 as a separate standing information condition; the context block as an experimental envelope; the existing-work classification as an observation; NO_ACTION and REQUEST_INTELLIGENCE first-class; both gates; Objective wording alone cannot ground a Recommendation; the cumulative addition. **Still to approve, separately:** the stage-1 provider calls, each external research call, and whether Arm B runs.
