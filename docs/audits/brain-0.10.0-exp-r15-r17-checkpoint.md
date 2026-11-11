# R15 semantic forcing + R17 carrier design — checkpoint

**Status:** findings for review · stacked on #649 · branch `feat/brain-0.10.0-exp-r15-r17`
**Provider calls:** 1 (Gemini 3.5 Flash) · **USD 0.029**. No rerun. Everything else offline.
**Changed:** the Brain spec only, by ceremony — `brain-eval-spec/0.10.0-exp`, digest `b39cd28b1152ee57f9715467c11421fc8ca91595af9218cb4c213a6664d93275` (0.9.0 `8d08728e…` preserved). No Recommendation schema change, no router change, no new evidence, no persistence, no planner, no Campaign, no Creative Intelligence, no Studio, Deals, Rate, Objective or Opportunity change. #570 untouched (read from its branch for §3).
**Artifacts:** `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/shape/R15/` (run, routing) and `ledger-r15/`.

---

## 1. The ceremony (R15)

One block added after THE ARTEFACT IS NOT YOURS, verbatim as sent to the provider:

> FOR SPECIALIZED_PLAN, NAME THE STRATEGIC MOVE, NOT THE PLANNER'S OUTPUT. On this path `what` describes the change worth pursuing — the subject and the direction it should move — and never the planner's product: no deck, list, proposal, outline, plan, calendar, workflow, series format or channel routine, unless that product is itself the subject of the decision. Ask: could two competent planners choose different artefacts or mechanics while carrying out the same recommendation? If yes, the artefact or mechanic is theirs and does not belong in `what`. Stay concrete: name the lane, the counterpart, the channel or the relationship the move concerns, so this move is distinguishable from every other move on the same Objective. "Advance the Objective" is not a move.

Amend → bump → unpin → parity (two new phrases) → exact-text review → repin. Brain suites 54 + orchestrator 36 green. C23 regated under 0.10.0 gates: `0→0`, no gate moved. The forcing input is byte-identical to C23 (same live Objectives, same state block, same context and overlay); the prompt differs only by the spec.

## 2. Result of the single forcing call — deliverables 1–5

### 2.1 Before / after, verbatim (deliverable 2)

**Yuwa Objective `b1c799e3…` — specialized_plan, both runs**

| | 0.9.0 (C23) | 0.10.0 (R15) |
|---|---|---|
| what | Develop a focused commercial pitch and outreach **strategy** integrating her Yuwa philanthropic leadership to secure global brand and CSR sponsorships. | Initiate outreach to global brand CSR departments to secure partnerships co-funding her work with the Yuwa girls empowerment program. |
| why | Her philanthropic leadership with the Yuwa program is an exceptionally strong and distinctive element of her brand narrative, but she currently lacks active corporate sponsorships co-promoting or co-funding this work. | Mia has a highly compelling narrative around her philanthropy and leadership with the Yuwa Academy, which is currently uncommercialized. Initiating outreach to global brand CSR departments can secure co-funded partnerships that expand her impact. |

**Academic/tech Objective `c0f587e4…` — specialized_plan, both runs**

| | 0.9.0 (C23) | 0.10.0 (R15) |
|---|---|---|
| what | Develop a commercial positioning **deck** emphasizing her Stanford academic and technology credentials to target partnerships in STEM, EdTech, and tech venture sectors. | Target premium brand partnerships and ambassador roles within the EdTech, STEM, and technology venture capital sectors. |
| why | Her academic acceleration … provides a unique and premium narrative that is completely untapped by her current lifestyle and sportswear-focused brand portfolio. | Mia's elite academic credentials and studies in technology and management science at Stanford offer a unique, peer-free positioning. Actively targeting partnerships in EdTech, STEM, and technology ventures will establish her commercial presence in these core domains. |

The other two decisions (not plan-shaped, recorded for drift): TikTok `feb62891…` stayed `direct_action` — what: "Reactivate her dormant TikTok channel by cross-posting short-form video content to expand her platform breadth and reverse audience contraction." Match-day `ctl-obj-matchday-series` stayed `campaign` — what: "Launch a recurring match-day social media series across her channels for each remaining Stanford women's soccer fixture of the season."; why ends "…a recurring campaign through the end of the season will satisfy her athletic narrative."

### 2.2 Acceptance, criterion by criterion (deliverables 1, 3, 4)

| Criterion | Result |
|---|---|
| Zero planner-owned artefacts in plan-shaped `what` | **Met.** 0/2 (was 2/2: "strategy", "deck"). |
| Zero planner-owned mechanics in plan-shaped `what` | **Met with one residual to record.** "Initiate outreach to global brand CSR departments" names an approach. Applying the spec's own test: any planner serving "secure CSR partnerships co-funding Yuwa" approaches CSR departments; what planners would choose differently is the artefact (deck, warm introduction, proposal), and that is what disappeared. The counterpart ("CSR departments") is what the block asked for. Recorded as verb-level, not a leak of a planner product. |
| `what` concrete enough to distinguish the move | **Met.** "CSR co-funding partnerships around Yuwa" and "premium partnerships and ambassador roles in EdTech/STEM/tech VC" are distinct moves, each tied to its Objective. |
| `why` strategic rationale, not execution planning | **Met.** The Yuwa `why` restates the move in its second sentence (rationale + echo), which is redundancy, not planning. |
| executionPath remains specialized_plan | **Met.** 2/2. |
| No regression into vague wording | **Met.** No "advance the Objective" form. |
| No Campaign / Direct Action drift caused by the wording | **Met.** The shape set is identical run to run: plan, plan, direct_action, campaign. The TikTok `direct_action` mis-shape is the same one C23 produced under 0.9.0 and the router refused it again ("must advance an in-motion subject"); it is R16, not drift caused by this block. |

**Did the ownership test bind (deliverable 3)?** On the plan shape, yes: the two-planners question removed the artefact nouns in one call, on the same input, with no other change. It bound only where it was aimed. The `direct_action` TikTok `what` still carries "by cross-posting short-form video content" — a mechanic the general R13 paragraph names explicitly ("cross-post her Reels weekly" is not yours) and did not remove. So the general paragraph does not bind; the shape-specific block does.

**Shape drift (deliverable 4):** none attributable to the change. See the table.

**Is R15 prompt-closable (deliverable 5)?** For the plan shape, on this evidence, **yes — and R15 is closed semantically**, with two honest limits stated: n = 2 plan-shaped decisions in one run, and the closure is per-shape (a matching block would be needed for `direct_action` if that shape's mechanic leak is to be closed the same way, which is not requested here). A typed strategic-move representation is not needed to close R15; it may still be wanted later for R16-style stability, which is a different problem.

Secondary observations, not patched: `notSeen` now carries execution-capacity thoughts on every decision ("content creation and editing support available … during travel matches", "budget parameters … of target CSR funds") — the Brain reasoning one level below its seam in the *gap* field, where it does no harm to `what` but shows the pull. Reconciliation kept keys: the Yuwa record `rec_9feaeb54fb19c6b1` was reaffirmed by key and its `what` updated to the 0.10.0 wording (the ledger records `reworded`); the academic decision minted a new key because its subject wording changed under the same Objective — the key includes shape and advances, not `what`, so this was a new decision identity only because the earlier record had been keyed from a different run's subject; noted for the substrate, no action.

## 3. R17 — the carrier for the campaign's reason to end (deliverables 6–9)

**What the experiment established.** A campaign is selectable and distinct only because something outside it can end it. In #649 the router recovered that fact from prose and misread it once. In this run the Brain again put the end in `why` ("through the end of the season") as the 0.9.0 text asks — the fact is *stated*, but nothing carries it as a fact.

**Invariant:** the router may validate a stated end condition; it must not infer one from prose.

### 3.1 The four options, pressure-tested (deliverable 6)

| | Where the fact lives | Who establishes it | Router work | Fails when |
|---|---|---|---|---|
| **A** Recommendation carries a typed end condition | a field on the RECOMMEND body, present iff `execution_path = campaign` | the Brain *states* the kind and a reference; a structural gate refuses a campaign without it | resolve the reference; refuse if it does not carry an end | the Brain invents a date or a condition nobody owns |
| **B** the shape classification carries it | `execution_path` becomes an object `{path, ends}` | same as A | same as A | it changes the shape enum every contract keys on; A does the same work without touching the key |
| **C** CampaignOriginProposal carries it; Brain supplies the source fact | the router's output object | the Brain must still emit the source fact — so C *is* A at the Brain side, plus a copy | copy + resolve | identical to A; the copy is not a carrier |
| **D** another existing object supplies it by reference | the Objective's `horizon`, a deal's `termEnd` / `deal_periods`, an athlete assertion | those objects already exist and are authoritative | resolve only | there is no reference to follow — D needs A to say *which* object |

**Recommended carrier (deliverable 7): A, constrained to references — the Brain names the source, never the end.** On a campaign-shaped RECOMMEND the Brain emits one typed reference to the thing that ends the activation; the router resolves it against the authoritative object and types the proposal from *that* object. The Brain never emits a date, a window or a condition of its own. Concretely (names provisional until checked against #570 §"period"):

```
ends: { source: "objective_horizon", ref: "objective[<id>]" }
    | { source: "deal_term",         ref: "deal[<id>]" }
    | { source: "athlete_stated",    ref: "<state path of the assertion>" }
```

A structural gate: `execution_path = campaign` without `ends` is refused at the Brain's own validator, before the router — so "a campaign with nothing to end it will be refused" becomes a gate, not a sentence. The 0.9.0 spec line "state in `why` what ends it" stays as prose for the reader; the *fact* moves to `ends`. This is a Recommendation schema change and needs its own ceremony; **not made here.**

### 3.2 Authoritative source per end-condition type (deliverable 8)

| End condition | Authoritative source | Exists today | Router check |
|---|---|---|---|
| `objective_horizon` | the Objective's `horizon` (kind `period` or a date) | yes — Objective 1.0.4 carries it (`this_season` in the forcing case) | referenced Objective is live and its horizon is a period or date, not `open` |
| `deal_term` | the deal's term (`termEnd`; `deal_periods` where a contract has its own years) | yes on deals with a recorded term; #570 H1 covers periods | referenced deal has a non-null term end |
| `athlete_stated` | the athlete's own assertion (`athlete_asserted`-class record, the onboarding/Studio doors) | the table exists; no field for a stated finish yet | the referenced assertion exists and names a finish; the Brain may cite it, never create it |
| explicit date / window | never Brain-originated: it is the *resolved* form of one of the three above (`endsOn` from the Objective's date, the deal's term end, or the assertion) | derived | carried as `period.endsOn` alongside `endsWith`, only when the source gives a date |
| Brain-defined condition ("until growth turns positive") | none outside the Brain | #570 A6 anticipates `recommendation_condition` | **not admitted**: it has no external owner and contradicts #570's operational edge. Recorded as the one place this design and #570's A6 pull apart. |

### 3.3 The router's exact responsibility after R17 (deliverable 9)

For a governed, deduplicated, campaign-shaped Recommendation the router asks three questions and reads no prose:

1. **Is there a purpose?** `what` is non-empty and cites the Objective (existence and citation, not meaning).
2. **Is there an explicit strategic reason to end?** `ends` is present (already gated) and its `source` is one of the admitted kinds.
3. **What authoritative source establishes it?** Resolve `ends.ref`: the Objective's horizon / the deal's term / the assertion. If the referenced object does not carry an end, **refuse** ("the cited Objective has an open horizon") — never downgrade, never substitute.

Then emit `CampaignOriginProposal.period = { endsWith: <source>, endsOn: <date if the source gives one>, endsRef: <ref> }`. The prose reader `reasonToEnd` is retired for this boundary once `ends` exists; it stays only as the experimental reader it was.

## 4. #570 — does it need a contract amendment before the Campaign door (deliverable 10)?

**Yes, a small one, at the Campaign checkpoint — not now.** Read against the branch text:

- `CampaignOrigin.period` carries `endsWith` as an enum plus `endsOn`; it does not carry the *reference* that established it. Add `endsRef` (or equivalent) so the origin records its source, matching invariant 2 ("without a reason to end … is refused") as a resolvable fact.
- `deliverables` must be optional at origin (`idea` → `planning`); #649 produced an accepted campaign Recommendation with none, and #570's "one brief per match day" row shows they arrive after planning.
- A3 ("accepting the Recommendation approves the campaign") → the three-act flow preserved from #649: Recommendation accepted · Campaign scope/spec proposed and approved · execution/publication/spend authorized per action. #570's exact wording is validated when that checkpoint opens.
- A6 `recommendation_condition`: decide whether to drop it or define its owner (§3.2).

Nothing in #570's definition, lifecycle or doors is contradicted by this run; the campaign it produced sits exactly on #570's "Run a match-day series all season → campaign, ends with the season" row.

## 5. Readiness (deliverables 11–12)

**Specialized Plan seam — ready to design.** R15 closed semantically on the plan shape; handoff by reference is proven (`PlannerHandoff`: id, runId, Objectives, subject, domain, what, why, notSeen); domain derives from the Objective; no generic Plan entity is needed. Conditions the design must carry: the planner treats any residual noun in `what` as non-binding; R16 stays covered by the router + reconciliation, not by a gate; the seam is `Recommendation → PlannerHandoff → domain planner → typed domain work`.

**Campaign door — not ready; the design is.** Two prerequisites, in order: (1) the R17 ceremony on the Recommendation (typed `ends` reference + structural gate), which is a schema change and the user's decision; (2) the small #570 amendment above at the Campaign checkpoint. After those, `Recommendation → CampaignOriginProposal → Campaign → CampaignSpec / BriefSeed → Creative Intelligence` can be opened. Creative Intelligence is not designed before both seams exist.

## 6. Backlog

- **R15 — closed (semantic)** on the plan shape at 0.10.0; per-shape closure noted; direct_action mechanic leak remains under R13's general text (not requested).
- **R17 — carrier decided (design)**: typed `ends` reference on the campaign shape; implementation needs a Recommendation ceremony.
- **R16** — unchanged; the same Objective mis-shaped identically in both runs, and the router refused it both times.
- New observation: `notSeen` drifting toward execution capacity. Watch, no action.

---

## 7. Acceptance (27 September 2026)

Accepted by the user. R15 closed semantically for `specialized_plan`; the single verb-level residual is not grounds to reopen it and is recorded as the planner-boundary watch item (`specialized-plan-seam-checkpoint.md` §8). R17 accepted: the campaign-shaped Recommendation carries a typed reference to the authoritative source of its reason to end; the Brain names the source and never the resolved date or condition; the router resolves, confirms, refuses, and no longer parses `what`/`why`. Ceremony performed at `brain-eval-spec/0.11.0-exp` (§1 of the seam checkpoint); #570's three corrections recorded in `campaign-slice-design-amendment-1.md`.
