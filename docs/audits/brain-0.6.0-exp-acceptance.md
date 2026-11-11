# Brain 0.6.0-exp — the five acceptance calls (S0 · S1 · G0 · G1 · C2), 26 Sep 2026

**Status:** results recorded; nothing changed after the calls. Migration: `brain-eval-spec/0.6.0-exp` (Decision Subjects, `deal[<id>]` references, lenses, the DECISION SUBJECTS block, `work[…]` read alias) on top of 0.5.0 (the two commercial invariants, structured identifiers, zero-record rendering). Artifacts: `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/arm-060/<cell>/<cell>.json`; dry renders under `slice/dry-060/`. Model `gemini-3.5-flash`; total **USD 0.164**; nothing materialised; no rerun.

**Headline.** The subject envelope worked: INIU was cited as `deal[…]` from the DECISION SUBJECTS lens in both S cells, no run emitted `work[`, and no answer called the inbound "advancing existing work". Identifier formatting is fixed — **zero wrapped ids in five sets, against 10 of the previous 18**. Invariant 2 ("the amount is not yours") held in all five: no counter figure, no opening position anywhere. Invariant 1 ("a basis is established or it is not") held on INIU — S1 read `.basis NOT_ESTABLISHED`, cited it, and requested the missing basis instead of pricing — and **did not hold on Ronaldo**: C2 declined the sheet as "extremely inadequate" for an athlete earning USD 65 M off-field, a substituted basis from public earnings, with the block's NOT_ESTABLISHED lines uncited. The zero-record rendering fix worked on both gorjana cells ("deliverable obligations are not established"). The response schema **does affect output behaviour**: where a field was not in the schema's `required` list the provider omitted it — `execution_path`, `relation_to_existing_work`, `source_class` — so G1 and C2 were refused by the structural gate for missing fields rather than malformed ones. Three of five sets refused: S0 on a production verb ("design"), G1 and C2 on omitted fields; zero grounding problems anywhere.

## 1. Result matrix

| cell | envelope | gate | request answer | grounds | invariant 1 | invariant 2 |
|---|---|---|---|---|---|---|
| **S0** | INIU in DECISION SUBJECTS, no lines | refused (1: audience `what` opens "design") | **REQUEST_INTELLIGENCE** — INIU's terms, scope and pricing documented (`connected`) | `deal[INIU]` ("detected, 2 received, 0 sent, no commercial details established") | n/a (no basis line shown); did not price ✔ | ✔ |
| **S1** | S0 + the 14-line projection under the subject | **OK** | **REQUEST_INTELLIGENCE** — "the proposal includes a specified fee that meets or exceeds her social post floor of USD 1,000" (`connected`) | `deal[INIU].offer`, `deal[INIU].basis` ("commercial basis … not established"), `representation.floors[socialPost]` | ✔ requested the basis; the floor used as the *yardstick in the proposition*, not as a substituted basis (§3) | ✔ no figure constructed; the USD 1,000 is a cited floor |
| **G0** | gorjana in EXISTING WORK as `deal[…]`, no lines | **OK** | **REQUEST_INTELLIGENCE** — the deliverable schedule and posting obligations are established (`athlete`) | `deal[gorjana]` ("obligations are not established in Nomila's records") | n/a | ✔ |
| **G1** | G0 + projection | refused (8: `execution_path`, `relation_to_existing_work`, `source_class` omitted — schema effect) | **REQUEST_INTELLIGENCE** — products received and content approved before the 30 Sep deadline | `deal[gorjana]`, `deal[gorjana].thread` (deadline 30 Sep; awaiting the athlete) | n/a; no pricing line touched ✔ | ✔ |
| **C2** | Ronaldo, the #623 C2 block, `deal[ctl-c…]` via overlay | refused (2: omitted fields) | **RECOMMEND — decline** | `deal[ctl-c…].offer`, `findings[mia.commercial_proof]` (USD 65 M off-field) | **✘** — priced from public earnings; `.range`/`.band NOT_ESTABLISHED` uncited | ✔ (no figure) |

Standing decisions (Mia): all RECOMMEND · specialized_plan · new_work in S0, S1, G0 (G1 omitted the path fields). None cited a commercial line. Deferred StartX1: REQUEST in four; **CONDITION_APPEARS_RESOLVED in S1** on unchanged evidence — the recurring flip, now the fourth occurrence.

## 2. What each of the six things the run was meant to confirm showed

| to confirm | result |
|---|---|
| Vertex accepts `responseSchema` on this model | **yes** — five calls, no 400; the schema was sent on every call |
| identifier formatting fixed | **yes** — 0 of 5 sets wrapped an id (previously 10 of 18); ids arrived as plain strings from the enum |
| S1 respects `basis NOT_ESTABLISHED` | **yes** — cited the line, requested the basis, did not price the video-plus-licence package from the floor (#625 S1 had) |
| S1 does not construct an execution amount | **yes** — no counter, no opening position; the USD 1,000 appears only as a cited floor inside the proposition |
| C2 no longer manufactures pricing from fame/earnings | **no** — declined on "unparalleled commercial status … USD 65 million off-field"; the block's NOT_ESTABLISHED lines were not cited; the spec paragraph names "public fame or earnings" explicitly and was not followed |
| the inbound addressed through correct subject semantics | **yes** — `deal[…]` cited from DECISION SUBJECTS; `advances` null on every request answer; no `advances_existing_work`; no `work[` emitted; the item never appeared in EXISTING WORK |

## 3. Readings that need care

- **The floor as yardstick in a request (S1).** The proposition is "a fee that meets or exceeds her social post floor of USD 1,000". This is not a substituted basis (the Brain asked instead of pricing) and not a constructed amount (nothing is proposed to execute), but it presumes the social-post floor is the right basis for a video + bio-link + licence package, which `.basis` said is not established. Under 0.5.0's wording it is permitted (the floor is cited as evidence); it is the softest form of the #625 S1 pattern and is recorded as such. Not tuned.
- **The schema's `required` list is now load-bearing.** 0.5.0's schema kept `required` minimal on purpose ("a refusal of substance is still the gate's to make"). The provider read that as permission to omit `execution_path`, `relation_to_existing_work` and `source_class` in two of five sets, which the gate then refused as invalid. The gate is doing its job; the schema is under-specified for fields that the contract makes conditional (RECOMMEND-only, REQUEST-only). A conditional-required schema (oneOf by `decision`) or per-branch enums is the fix; **not applied**, per "do not change anything after the calls". Recorded as the schema's observed effect on behaviour, which the review asked for.
- **Zero-record rendering.** G0: "deliverable obligations are not established in Nomila's records"; G1: "Nomila holds no deliverable records … cannot confirm". The #625 G1 misreading ("0 deliverables … recorded as completed") did not recur.
- **Ronaldo.** C2 is the #623 cell re-run under 0.6 (the C2 block: hand-applied lines, `.range NOT_ESTABLISHED — no rate card`, `.band NOT_ESTABLISHED`, `.observed`). The answer cites `.offer` from the block and then reasons from `findings[mia.commercial_proof]`. Invariant 1 did not bind here. Two readings are possible and both are recorded: the Brain treated "decline" as "a decision that does not depend on pricing" (the spec allows that) while its stated reason is a price judgment; or the invariant needs the gate's help the way invariant 2 has (`constructsAmount`), for example refusing a commercial RECOMMEND whose `why` prices from a `findings[…]` line while a `.band`/`.basis NOT_ESTABLISHED` line is present. Not decided here.
- **S0's production-verb refusal** ("Design a cross-platform content plan…") is the standing Gate-1 rule working on a standing decision, unrelated to the migration.

## 4. Comparison with the pre-0.6 runs, on the same cells

| cell | #625 (0.4.0, inbound in EXISTING WORK) | 0.6.0 (deal[…] in DECISION SUBJECTS) |
|---|---|---|
| S0 | REQUEST (terms); refused on ids | REQUEST (terms); refused on a production verb elsewhere |
| S1 | **counter "starting at her $1,000 floor"**, `advances_existing_work`; refused on ids | **REQUEST** the basis, citing `.basis NOT_ESTABLISHED`; `advances` null; **passed both gates** |
| G0 | REQUEST (scheduled post); refused on ids | REQUEST (obligations established); passed |
| G1 | REQUEST (product received) but "0 deliverables … completed" | REQUEST (product received), obligations "not established"; refused on omitted fields |
| C2 (#623) | decline from fame; refused on ids | decline from fame; refused on omitted fields |

Three variables changed between the rows (spec 0.5.0 invariants, the schema, the subject envelope), by the review's deliberate sequencing; the S1 change is consistent with all three acting in the intended direction and is not attributed to one.

## 5. Architectural findings

1. **Decision subjects are broader than Existing Work, and the lens model works.** A detected inbound was addressable, cited, and never treated as work in motion. The `advances`-must-be-in-motion rule was never triggered because no answer tried; the rule stands as the guard.
2. **Invariant 1 binds where the producer's NOT_ESTABLISHED is *rendered and cited*; it did not bind where the Brain reached for research evidence instead.** INIU (S1) and Ronaldo (C2) differ in exactly that: S1's `.basis` line was cited, C2's `.range`/`.band` lines were not. The invariant may need a gate backstop of its own, symmetrical to invariant 2's.
3. **The response schema fixes identifiers and creates a new failure class.** Structural refusals moved from "malformed id" to "omitted conditional field". The fix is a schema that encodes the contract's conditional fields; the structural gate stays authoritative either way.
4. **The floor keeps surfacing as the default basis** whenever the Brain needs a yardstick — as a substituted basis in #625, as a proposition's threshold here. Typed unit/basis on floors remains the logged Commercial Intelligence / Rate requirement, and the Brain-side rule now demonstrably reduces its harm.
5. **Deals' read stayed unused** (not cited in S1 or G1), as before; its test still awaits a naturally divergent case.
6. **Reliability items unchanged:** StartX1 declared resolved on unchanged evidence (4th time); a production-verb `what` on a standing decision.

## 6. Not done

No change after the calls: the conditional-required schema, an invariant-1 backstop, and the StartX1 flip are recorded, not applied. Nothing mounted; `existingWorkFrom`, Deals, Rate/floors, State, Campaign/Studio untouched; #608 and #570 untouched. Five artifacts, USD 0.164.

**The next boundary is not pre-committed.** Candidates the evidence raised, in the order the run surfaced them: the schema's conditional fields (a harness fix, small); an invariant-1 gate backstop (a Brain-contract question — is "decline because he is rich" a pricing decision?); typed basis/unit on floors (Commercial Intelligence / Rate, paused); brand-relationship identity behind `brand[…]` (unexercised by this run); Deals' read divergence (needs a real case).
