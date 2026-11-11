# Commercial Intelligence ↔ Shared Brain — boundary design checkpoint

**Status:** design checkpoint — direction approved 26 Sep; corrected per that review (usage-rights epistemics, thin controls, the meaning of "minimum", P-state as ablation, the exclusion list as experimental). Fixture stage approved; calls not. Nothing implemented, no provider call, no schema, no prompt change, no Deals, Rate-redesign, Campaign or Studio change. #608 and #570 untouched. The live defects recorded in the Deals audit (PR #621, §12) stay there and are not part of this work.

**Inputs:** the Deals intelligence audit (PR #621) · the Brain experiment series (1 · 1B · 1B.1 · 1B.2 · 1B.3 · 1C · 1C.1) · the Decision-Set Semantics checkpoint (§13, the elevated commercial boundary) · `rate-eval-spec/2.0.0` on `main` · the six-athlete Objective cohort.

---

## 0. In plain words

The Brain got commercial decisions wrong for one reason that recurred in seven runs: it was handed reference numbers — floors by type, a past deal's cash, a demonstrated high — and had to decide for itself which number governed the offer in front of it, whether numbers add, and whether the past was comparable. It decided differently on different days. The audit found that the working Deals system already answers those questions in deterministic, tested code, for every inbound offer, and simply never says so anywhere the Brain can read.

The question this checkpoint puts to an experiment: **if specialized Commercial Intelligence hands the Brain that meaning, as cited evidence, does the Brain stop reconstructing commercial semantics — and does the same interface hold for an athlete Nomila knows only from public research, with no floors, no deals and no mailbox?**

The experiment is designed so the evidence can say *where* the interface belongs (attached to the opportunity, to the athlete's State, or to the decision itself) rather than assuming it. It reuses the frozen Brain, the approved fixtures and the observed failures as regression probes. Fourteen provider calls, none yet approved.

**My recommendation on the path, in one paragraph.** Integrate, do not recreate. Commercial Intelligence is a semantic responsibility inside UNDERSTAND whose first producers already exist inside the Deals system and should stay there; the redesign's vocabulary is the comparability language nothing mounts yet. In this experiment the Brain is not shown the 1–10 score, the fit judgment, the counter amount or the inbox's accept/negotiate/reject verdict; it is shown what the offer *is*, what it is *worth under Nomila's own rules*, what *governs* it, which terms are *established as not stated* and which are *unknown to Nomila*, what past evidence is *comparable*, and what is *not observed* — and decides, across deals, campaigns and content, what to do. Whether that exclusion becomes the production interface is what the experiment establishes; it is not frozen here. Whether that arrives as decision input, as State, or as a property of the opportunity is what the experiment is for. If the experiment falsifies this, the likely alternative is not a bigger Brain but a narrower one: the accept-or-counter call itself moving to specialized intelligence, with the Brain deciding only whether to engage.

## 0.1 Where I agree with the review of #621, and three refinements

I agree with every constraint in the review: canonical architecture as the control; Commercial Intelligence ≠ Deals Intelligence; connected Deals data is an enrichment, not a prerequisite; MISSING / NOT OBSERVED ≠ NONE; the composite score is not the Brain's commercial truth; "deterministic" is a property of today's strongest components, not the definition of the layer; brand understanding is reusable specialized intelligence with a provenance gap; test the boundary, do not freeze it.

Three refinements the code forces:

1. **Almost all of the needed meaning is opportunity-relative, not athlete-level.** The governing basis, the band, the missing terms, and the comparability of past evidence are all computed *against a particular offer*. Only two things are athlete-level: the floors themselves (already in State, with "a floor is not a market value") and the observed-ness of the athlete's commercial history. This does not settle placement — it is the reason placement must be tested rather than assumed — but it means "put it in State" is not the obvious answer it might look like.
2. **The MISSING ≠ NONE constraint is violated today upstream of the Brain, in State.** `commercialPosition.closedDeals` is written as MEASURED 0 with HIGH confidence for an athlete with no connected mailbox (the count is of Nomila's records, labelled as an athlete fact), and the builder never emits the `public_only` value the contract declares (`server/services/intelligence/state/build.ts` emits only `athlete_transactions | connected_measurement | none`). The cohort audit called Ronaldo's empty pipeline "the trap". The experiment observes whether the Brain falls into it with and without Commercial Intelligence stating observed-ness explicitly. Recorded, not fixed here.
3. **The Deals system contains a second decision-maker on WHAT.** `reconcileRecommendation` (accept / negotiate / reject / delete, per deal, model + code, no view of Objectives or other work) is a per-deal Recommendation living inside EXECUTE. The experiment does not touch it. The boundary decision after the experiment will have to say whether an inbox verdict becomes an execution-path suggestion downstream of a Brain decision, or stays a legacy surface. I flag it now so it is not discovered later as a duplicate Brain.

---

## 1. The proposed zoom-in to the canonical architecture — not a replacement

The canonical loop is the control and is unchanged:

```
OBSERVE → UNDERSTAND → STATE → OPPORTUNITY → OBJECTIVE → RECOMMEND / SHARED BRAIN → EXECUTION PATH → EXECUTE → MEASURE → LEARN
                │                                                        │
                ├ Athlete Intelligence                                   ├ Direct Action
                ├ Commercial Intelligence   ◀── this checkpoint          ├ Specialized Plan → Actions
                └ Context / Opportunity Intelligence                     └ Campaign → CampaignSpec → Creative Intelligence → AssetSpec → ShotSpec/EditSpec → ExecutionPlan
                                                                                     ↓
                                                                    Mila / Inbox / Deals · Studio / Generation
```

The proposed amendment is a **zoom-in on the Commercial Intelligence box and on one interface line** out of it. Nothing moves between boxes.

```
UNDERSTAND · Commercial Intelligence  (a semantic responsibility: interpret commercial evidence into decision-useful commercial understanding)

  evidence classes it may draw from (the gradient; none is a prerequisite)
    public / researched commercial evidence · public brand relationships · athlete-stated preferences & history (floors)
    · Rate Intelligence (v3.1 card today; 2.0.0 estimates when mounted) · connected inbox / deal evidence · contracts
    · accepted / declined deals · outcomes and historical economics

  producers that exist today, mounted, inside the Deals execution system (they STAY there; the amendment exposes meaning, not code)
    offer_struct (Kimi summariser, model)                 → what the offer is, structured
    totalGuaranteedValue / annualizedValue                 → what it is worth under Nomila's rule (cash + stated product; commission excluded)
    matchRate + RATE_KEY_FOR_DEAL_TYPE                     → which basis governs this offer
    withFloors                                             → the athlete's floor-raised range, per type, non-additive across types
    economicsBand                                          → the offer's position, or NOT_ESTABLISHED with the reason
    computeMissingTerms                                    → which material terms are absent (price · deliverables · timeline; usage/exclusivity NOT extracted)
    resolveDealValue                                       → what a contract establishes (TCV / ACV, guaranteed vs conditional, holes as null)
  vocabulary that exists, unmounted (Rate redesign 2.0.0, main)
    COMMERCIAL_STATE of a piece of evidence · ANCHOR_BASIS · source_class · comparability (DIRECT / INDIRECT / NOT_COMPARABLE) · terms bases

  ──────────────────────────────────── the interface line under test ────────────────────────────────────
  Commercial Intelligence ──▶ RECOMMEND / SHARED BRAIN     "commercial meaning about a subject, with provenance, MISSING preserved"
                                                            excluded in this experiment (not yet a production contract): the 1–10 score · the fit judgment · the counter amount · the inbox verdict
  Commercial Intelligence ──▶ Deals execution (already)     counter arithmetic, draft composition, send — HOW, unchanged
  Commercial Intelligence ◀─▶ Rate Intelligence             rate is an evidence class in; deal outcomes are rate evidence out (2.0.0 §12)
  Brand Intelligence ──▶ Commercial · Opportunity · Campaign · Pitch · Creative   (recorded, §1.1; not part of this experiment)
```

Where the four audit labels land on the canonical boxes, unchanged from #621: classification, extraction, brand research, drafting, leak defence, propose/approve/send, auto-file, payments, grouping = **EXECUTE (Mila / Inbox / Deals)**; the deterministic economics = **UNDERSTAND · Commercial Intelligence, currently hosted inside EXECUTE**; the fit judgment and the reconciled verdict = **a per-deal RECOMMEND overlapping the Brain**, recorded (§0.1.3); the Rate redesign = **UNDERSTAND · Commercial Intelligence, unmounted**.

### 1.1 Brand Intelligence — architectural implication recorded, nothing changed

The brand-research service is a genuine reusable specialized intelligence (one gate, one global catalog, five triggers), consumed today only by presentation surfaces, while the deal scorer re-infers category, tier and summary from the email. Architecturally it belongs in UNDERSTAND beside Commercial Intelligence, feeding Commercial, Opportunity, Campaign, Pitch and Creative rather than each surface reconstructing what a brand means. Its provenance (one timestamp, grounding sources discarded, no run history) is a future boundary issue relative to Athlete Intelligence's runs, evidence and lineage. The experiment below does not use brand research: the controlled term sheets name fictional brands, so no researched profile exists and none is missed. A Brand Intelligence checkpoint is a separate, later item.

---

## 2. The exact boundary hypothesis

> **H.** For a commercial decision about a specific subject, the shared Brain needs from Commercial Intelligence a small set of *interpreted* propositions — what the subject is, what it is worth under Nomila's own rule, which basis governs it and where it stands against that basis (or that no basis is established and why), which material commercial terms are established as not stated by the terms Nomila can read and which are unknown to Nomila, for each historical economic reference whether it is comparable and what commercial state it establishes, and what about the athlete's commercial history is observed versus not observed. Given those as cited evidence, the Brain makes grounded strategic decisions **without reconstructing commercial semantics itself** (no floor arithmetic of its own, no comparability inference of its own, no benchmark chosen by itself), its decisions are **stable on the accept/counter axis across runs**, and the same interface **degrades gracefully**: where the propositions are NOT_ESTABLISHED or NOT_OBSERVED the Brain requests or declines to price, and never treats absence as zero.

Corollaries that the matrix tests separately:

- **H-min.** Reference numbers alone (the rate card and floors as numbers) do not achieve this; the *meaning* is what is needed. (Tested by C1 versus C2.)
- **H-mounted.** The mounted Deals semantics alone fix the governing-basis and additivity failures but not the comparability failure; the additional semantic layer (comparability, commercial state, the role of a demonstrated high, observed-ness — added together in C2) is necessary for that failure. (Tested by C2a versus C2. The layer is added as one step; which of its four lines is operative is read from citations and rationale, not concluded from the step.)
- **H-placement.** The Brain uses the propositions wherever they are attached, and derives decision-relative missingness itself from a subject-level assessment. If instead it only uses them when attached to the decision, or standing decisions ignore them when attached to the subject, the interface is decision-specific input. (Tested by P-work versus P-state, and by the two-question run A5.)
- **H-gradient.** The same block, with most propositions NOT_ESTABLISHED, produces grounded requests rather than invention for a public athlete and for a user with no observed commercial history; and stating observed-ness explicitly is what prevents "no deals observed" reading as "no deals". (Tested by C and D against their controls.)

**Epistemic discipline the block must keep, everywhere:** NOT EXTRACTED ≠ NOT STATED. NOT OBSERVED ≠ NONE. NO NOMILA RECORD ≠ NO REAL-WORLD HISTORY. `computeMissingTerms` can establish absence only for the three terms the extractor reads (price, deliverables, timeline). Usage rights are outside the extractor, so the block renders them **UNKNOWN — not established by this evidence path**, never "not stated by the offer"; the Brain may decide that knowing them is decision-material and request them, but the evidence must not tell it the offer omitted them unless a source establishes that. Exclusivity is rendered only as the source states it (the R2 sheet states "no category exclusivity"; a sheet silent on it renders UNKNOWN).

The hypothesis says nothing about *where the producer lives* (it lives in the Deals code today) and nothing about a schema. `CommercialAssessment` is not proposed; the experimental block below is an envelope, versioned `-exp`, exactly as the context block and existing-work envelope were.

---

## 3. Which required semantics exist where

The audit's §6.2 five requirements, expanded to what the experiment block needs, classified as asked.

| semantic the Brain needs | 1 · mounted Deals | 2 · Rate redesign, unmounted | 3 · neither | 4 · conflict / overlap |
|---|---|---|---|---|
| the offer as structure (amount, product value, unit, deliverable counts, deal type, term months, counts basis) | `OfferStruct` from the summariser; persisted in `deals.conversation_state.key_details.offer_struct` | — | usage rights never extracted; exclusivity only from contracts (jsonb, no reader) | — |
| guaranteed value; components additive within one offer; commission excluded | `totalGuaranteedValue` (code + doc comment) | one sentence (product ≠ cash) | additivity as a machine-readable property | — |
| annual reading of a lump sum | `annualizedValue` (term ≥ 12 months only) | fixed per terms basis | — | annual partnership: Deals annualises; 2.0.0 says never decompose — different questions, both defensible, undocumented together |
| which basis governs this offer | `matchRate` + `RATE_KEY_FOR_DEAL_TYPE` (silent `socialPost` fallback) | 11/13 slots each with a stated basis | a mapping between the two vocabularies | **four deliverable vocabularies on `main`, no mapping table** |
| floors: per type, non-additive across types, raise `low` only | `withFloors` (in code; in no contract) | out of scope ("a preference, not intelligence") | a type stating additivity | Deals applies floors to scoring; redesign disowns them; Brain read them three ways |
| the offer's position against the athlete's range | `economicsBand` (six bands incl. two NOT_ESTABLISHED reasons; `MIN_USABLE_RATE`) | LOW/EXPECTED/HIGH at a basis | — | v3.1 range width = confidence; 2.0.0 range = commercial range, "not an uncertainty interval" |
| which material commercial terms are established as not stated, and which are unknown | `computeMissingTerms` (price · deliverables · timeline; absence establishable only for these three — usage/exclusivity are outside the extractor and are UNKNOWN, not absent) | — | usage / exclusivity / rights gap detection | Brain's REQUEST_INTELLIGENCE is decision-relative (D2/D3); Deals' list is offer-relative — different layers, both needed |
| what a contract establishes | `resolveDealValue` (TCV/ACV null when a guaranteed period's cash is unknown; conditional ≠ guaranteed) | "agreed is evidence; fulfilment is a separate fact" | — | — |
| comparability of a historical economic reference to this offer | absent (provenance ≠ comparability) | defined: DIRECT / INDIRECT / NOT_COMPARABLE, "do not apply the price of one activity to a different one", package ≠ component | — | — |
| commercial state of a piece of evidence | `deals.status` (six values, two dead) | INTEREST / ASK / OFFER / AGREED / COMPLETED with a ceiling per status | — | three vocabularies (status · COMMERCIAL_STATE · existing-work kinds) |
| the role of a demonstrated high | absent as a role; State derives min/max of closed totals | ruled in prose: an observation, never a benchmark or floor; no field | a field | State renders it as one line with no role — the line K4 summed |
| observed vs not observed commercial history | — | source_class per evidence | **State says MEASURED 0 for a count of Nomila's records; `public_only` declared, never produced** | the MISSING ≠ NONE constraint is unmet in State today |
| a rate for an athlete with no transactions | v3.1 card computed on research refresh (followers, tier, segment) — may exist for a researched public athlete; no unit test | 2.0.0 estimate with confidence and anchor basis; eight-athlete cohort run exists (none of the Objective cohort) | — | two rate systems, one mounted, one not |
| counter amount | `max(floor, rateCardMid)` twice (server, client) | out of scope | — | **execution, not Brain input** — the Brain re-derived it ad hoc in K3/K4 |
| accept / negotiate / reject | `reconcileRecommendation`, per deal | out of scope | — | **a second decision-maker on WHAT** (§0.1.3) |

Reading: every semantic the connected-case failures turn on exists either as mounted code (rows 2–8) or as redesign vocabulary (rows 9–11). Nothing new needs inventing for the experiment; the block is assembled from those two sources and labelled by source. The one thing that exists in neither is a stated observed-ness of commercial history (row 12), which the experiment supplies as a producer statement of fact ("no connected mailbox; no deal recorded by Nomila") and tests.

---

## 4. The smallest experimental matrix

Three content conditions, two placements, four evidence positions. **Fourteen calls.**

### 4.1 Content conditions (what Commercial Intelligence supplies)

| condition | what the Brain sees about commerce | source |
|---|---|---|
| **C0 · control** | exactly today's envelope: State (`representation.floors[…]`, `commercialPosition.*`), existing work with `amount {total, cash, product}`, the term-sheet statement | unchanged |
| **C1 · numbers only** | C0 plus the athlete's v3.1 rate card ranges `{low, mid, high}` per key, rendered as numbers with no reading | `athletes_current.rate_card` via `deriveDealTypeRates`, as the scorer receives it |
| **C2a · mounted meaning** | C0 plus the assessment block, rows 1–8 of §3 only: structured offer · guaranteed value with the additivity rule stated · governing basis · floor-raised range for that basis with the per-type rule stated · band or NOT_ESTABLISHED with reason · terms the extractor establishes as not stated; usage rights rendered UNKNOWN (not established by this evidence path), never "not stated"; exclusivity only as the source states it · contract-derived value for any accepted item that has periods | computed by running the mounted functions on the overlay offer as an `OfferStruct` and the athlete's real card and floors |
| **C2 · full meaning** | C2a plus rows 9–12: for each historical economic reference rendered anywhere in the inputs (each accepted deal in existing work, `demonstratedEconomics`), its COMMERCIAL_STATE and its comparability to this offer with the one-line reason, the role statement for a demonstrated high, and the observed-ness statement of the athlete's commercial history | the 2.0.0 rules applied by hand, labelled `assembledBy: "code+hand"`; the exact rule cited per line; shown before any call |

C1 is the discriminator between "the Brain needed more numbers" and "the Brain needed meaning". C2a versus C2 is the discriminator for what the minimum is: whether the unmounted comparability vocabulary is required to stop K3/K4's use of gorjana's cash and the USD 14,000 high as benchmarks.

### 4.2 Placements (where the same C2 block is attached)

| placement | rendering | citation | needs |
|---|---|---|---|
| **P-work** (default) | under the work item it assesses, inside EXISTING WORK | `work[<id>].<path>` | grounding resolves sub-paths of a work item (an experimental change to `grounding.ts`, no spec text change) |
| **P-state** | inside ATHLETE STATE as `commercialPosition.assessment[<work id>].<path>` — **an experimental placement ablation, non-canonical**: the path is rendered for this run only and is not an implied Athlete State contract | a state path, as the spec already permits | the rendered State carries an experimental section appended by the orchestrator; the `AthleteState` contract type and the State builder are not changed; no production State conclusion before the result |

P-work is the default because every proposition in the block except observed-ness is computed relative to the offer, so the offer is its natural subject. Decision-level placement (a block keyed to the request) is **not** rendered in this run: it would need a new citation namespace and therefore a spec line, and the same question is answered more cleanly by A5 below, which poses two different questions about one subject-level assessment and reads whether the Brain derives decision-relative missingness itself.

### 4.3 Evidence positions (who) and cells

| position | athlete | evidence actually held | calls |
|---|---|---|---|
| **A · connected, rich** | Mia | real State (three live Objectives, deferred StartX1), real existing work incl. gorjana accepted (USD 14,000; 7,500 cash / 6,500 product), floors stated, v3.1 card, the R2 Northlight overlay verbatim, the 7-item context block | A0 C0 ×1 · A1 C1 ×1 · A2 C2a P-work ×1 · A3 C2 P-work ×3 · A4 C2 P-state ×1 · A5 C2 P-work with two requests ×1 = **8** |
| **B · athlete-stated + live opportunity, no history** | Mia, connected commercial evidence withheld from the rendering | same Objectives, floors, card; `commercialPosition` rendered as NOT OBSERVED (a labelled ablation, §7); real deal rows removed from existing work; the R2 overlay is the only item | B0 C0 ×1 · B1 C2 P-work ×1 = **2** |
| **C · public / research-only, non-user** | Cristiano Ronaldo (Objective cohort) | rich research, no connection, no mailbox, no deals, no floors, no Objectives; a v3.1 card may exist from research refresh (fixture-time DB read, reported before calls); a controlled term-sheet overlay | C0 ×1 · C2 P-work ×1 = **2** |
| **D · user, no connected commercial evidence** | Lilia (tester; fallback Chisom Okpara if her rows do not fit the position at fixture time) | a signed-up athlete: State from her real rows, deals 0, floors as stated or none, no live Objectives; a controlled term-sheet overlay | D0 C0 ×1 · D2 C2 P-work ×1 = **2** |

Fourteen calls. If a smaller first run is wanted, A3 ×1 instead of ×3 and D dropped gives ten; A1 and A2 should not be cut, because they are the only cells that answer "what is the minimum".

**A3 runs three times deliberately.** The failure is a between-run flip. Under 0.3.x/0.4.0 with the identical R2 fixture there are already seven runs (D2k, K2, K3, K4, 1C.1 K2, K3, K4): accept in three, counter in four. Those seven are the C0 distribution; A0 is a same-day anchor, not a resampling. Three C2 runs cannot prove stability, but 3/3 on one side against 3/7 is a directional result, and 2/3 or worse is a clean negative.

### 4.4 Fixtures

- **Term sheet, A and B:** the approved R2 overlay, byte for byte (`ctl-r2-northlight-termsheet`: USD 5,000, ambassador agreement for the 2026-27 academic year, four Instagram posts, no category exclusivity, term 2026-10-01 → 2027-06-30, no response sent).
- **Term sheet, C and D:** the same economics and structure with only the brand and the term wording changed to fit the athlete (a fictional brand, never a real one; a one-year term rather than an academic year where the athlete is not a student). USD 5,000 is held constant on purpose: the evidence gradient is the variable, not the offer. For Ronaldo the constant is also a probe — whether a Brain with no benchmark says anything about the level of the offer at all, and on what grounds.
- **Requests:** the approved D2k wording in every cell — "Should this negotiation be advanced, countered or accepted?", asked by the athlete's agent through Mila, about the overlay item. A5 adds the approved D3 wording — "Can this negotiation proceed alongside her other relationships?", asked by the athlete through Mila — about the same item. No other request. No fixture, overlay or block mentions the assessment, coordination, priority or the other decisions.
- **Objectives:** Mia's live set as it stands on dev. C and D run with **zero live Objectives**, which the validator permits (it checks one decision per live id; with none, `decisions[]` is empty and the request block is the only door). This is architecturally honest: a public athlete governs nothing, and reading the cohort's *proposed* Objectives as live would fabricate governance. It also means C and D test only requested decisions; standing-decision behaviour on the gradient is what B is for.
- **Context:** the existing 7-item hand block for A and B (window 26 Sep – 16 Oct, incl. the control item); omitted for C and D (no hand block exists for them and none is assembled — a block not shown does not exist).

### 4.5 The assessment block, as it would render (C2, P-work, cell A) — illustrative, computed at fixture time

```
work[ctl-r2-northlight-termsheet]
  Northlight Learning (EdTech) sent a term sheet on 22 September 2026: … (statement unchanged)
  commercial assessment  (commercial-assessment/0.1.0-exp · derived by Nomila's deal economics, deterministic, from the terms above; lines marked ‡ apply Rate 2.0.0 rules by hand)
    .offer            USD 5,000 total · cash 5,000 · stated product none · commission none · unit total · 4 deliverables (Instagram posts) · deal type ambassador · term 9 months
    .value            guaranteed value USD 5,000 = cash + stated product; commission excluded; components of ONE offer add
    .basis            governs: <matchRate result — e.g. "ambassador, per deliverable: USD 1,250 each"> — a floor or rate for another type does not apply to this offer
    .range            her range for that basis: {low, mid, high} after her floor for that type; floors are per type and do not add across types
    .band             <economicsBand — e.g. UPPER · "USD 1,250/ambassador vs {…}"> | NOT_ESTABLISHED: <reason>
    .absent           established as not stated (of the terms Nomila reads: price · deliverables · timeline): <computeMissingTerms>
    .unknown          usage rights: UNKNOWN — not established by this evidence path (Nomila's extraction does not read usage rights; whether the sheet states them is not known)
    .exclusivity      as the source states it: none (category)
  ‡ .history         gorjana (accepted, USD 14,000; cash 7,500 / product 6,500): COMMERCIAL_STATE AGREED · comparability to this offer NOT_COMPARABLE — different activity and mixed compensation; its price does not transfer
  ‡ .high            demonstratedEconomics high USD 14,000 is an observation of what was once agreed; it is not a benchmark and not a floor
  ‡ .observed        commercial history: connected mailbox observed · N deals recorded by Nomila. A count of Nomila's records is not a count of real-world history; what Nomila has not observed is not evidence of absence
```

Every value is computed, not typed; `basis`, `range`, `band` and `absent` are the outputs of `matchRate`, `withFloors`, `economicsBand` and `computeMissingTerms` on the real card and floors. Rendered text is shown in full before any call. What the block never contains: a score, a fit reading, a counter figure, a verdict, or any word about what the Brain should do.

---

## 5. What stays frozen

- `brain-eval-spec/0.4.0-exp`, canonical text and digest `ffb97cd4…`; every gate, validator and grounding rule as merged in #620. **No prompt change.** The block is cited through forms the spec already lists (a state path; `work[<id>]` extended to sub-paths in the resolver only).
- `existing-work/0.2.0-exp`, `context-block/0.1.0`, the R2 overlay, the D2k and D3 request wordings, the 7-item context block.
- The Deals path, the score, `dealScoreGrid`, the Rate redesign and its spec, State's builder and contract, the Objective spec 1.0.2. The experiment *reads* the mounted functions; it changes none.
- The discipline: nothing materialised, no `information_available` writer, no StartX1 read, no coordination field, no repairing validator, no re-runs between calls, no per-athlete tuning, no provider call without approval.

## 6. What changes between variants — one variable per comparison

| comparison | the only difference | reads |
|---|---|---|
| A0 → A1 | rate-card numbers added, no meaning | does more data alone change anything |
| A1 → A2 | mounted meaning added (rows 1–8) | do basis, additivity and band stop own arithmetic (P1, P2) |
| A2 → A3 | comparability, commercial state, role of the high, observed-ness added (rows 9–12) | does the history stop being a benchmark (P3) |
| A3 → A4 | placement only (work item → State) | does the Brain's use of the block change with where it sits |
| A3 → A5 | a second, different question about the same item | does one subject-level assessment support decision-relative missingness for both questions |
| B0 → B1, C0 → C2, D0 → D2 | the block, on a thinner gradient | graceful degradation (§8) |
| A3 → B1 | history withheld | is connected history a prerequisite for a grounded decision |

## 7. Envelope changes required, and why (item 10)

Two experimental additions and one ablation; each labelled in every artifact; nothing else.

1. **`commercial-assessment/0.1.0-exp`** — a versioned experimental evidence block, assembled by a script that calls the mounted functions on the overlay offer and the athlete's real card and floors, plus hand-applied 2.0.0 lines marked as such. Rendered in P-work or P-state. `grounding.ts` learns to resolve `work[<id>].<path>` (P-work) — a resolver change, not a gate change; P-state resolves through the existing state-path resolver against a State object carrying an experimental `commercialPosition.assessment` property. **Why:** without a citable block there is nothing to test; without per-line citation there is no way to read *which* semantic the Brain used. This is an envelope, not a contract, exactly as `context-block/0.1.0` was.
2. **`--withhold connected-commercial`** on `brainRun` (cell B only) — renders `commercialPosition` as NOT OBSERVED and drops real deal rows from existing work; the artifact records the ablation. **Why:** it is the only way to hold Objectives, floors and the offer constant while removing history, and so the only clean test that connected Deals data is an enrichment rather than a prerequisite. State's *builder* is not changed; the rendering is.
3. **Two new controlled overlays and two request fixtures** for C and D, in the approved R2/D2k shape. **Why:** those athletes hold no live opportunity; the position "live opportunity with no history" needs one.

Not changed, deliberately: the spec text (no line for a new namespace — hence no decision-level placement this run); the validator (zero-live runs already pass); the context block (not assembled for C/D); any State builder logic; `dealScoreGrid` (called, not edited).

## 8. How the public and no-deals cases test graceful degradation

For C (Ronaldo) and D (Lilia / Okpara), and B (Mia with history withheld), each read against its C0 control:

- **Absence stays absence.** With the block's `.observed` line ("no connected mailbox; no deal recorded by Nomila") and `.band NOT_ESTABLISHED: no rate on card` or the v3.1 card as it exists, does the Brain say the offer cannot be priced against her/his position and REQUEST (source class `external` for a market rate, `athlete` for floors) — or does it accept, counter with a number, or reason as if there were no deals ("secure his first partnership", "no commercial track record")? The latter in C2 falsifies H-gradient; the latter in C0 only is the expected trap and supports it.
- **No invention from the researched profile.** Ronaldo's research is rich; the block gives it no commercial reading. A rationale that prices him from his fame without a cited basis is invention, recorded as in the cohort audit's check 4.
- **Floors absent ≠ floors zero.** For C and D the block's `.range` is NOT_ESTABLISHED for lack of floors and possibly of a card. A "below her floor" or "above his floor" anywhere is a fabricated bound.
- **The upstream State defect is left in place on purpose.** `closedDeals` MEASURED 0 / HIGH and the never-emitted `public_only` render exactly as they do today in every cell. The experiment exposes whether an explicit observed-ness line from Commercial Intelligence prevents that upstream defect from becoming a Brain inference; it does not fix the defect.
- **B isolates history.** Same floors, same card, same Objectives as A; only the history and pipeline are withheld. If B1 reaches the same decision as A3 on the same cited basis lines, history was an enrichment. If B1 collapses to REQUEST for history that A3 never used, the Brain is treating history as a prerequisite — a finding either way, and one only this cell can produce.
- **Standing decisions on the gradient.** B is the only thin cell with live Objectives. Whether the positioning Objective's standing decision still defers to the request (the 1C.1 pattern) with a NOT OBSERVED history, and whether the content and audience Objectives are untouched by a commercial block (the K1 lesson — no contamination of non-commercial decisions), are both read.

## 9. How the connected case tests whether existing specialized intelligence fixes the observed failures

Regression probes, each anchored to a recorded failure; read on A2, A3 (×3), A4, A5 and compared with A0/A1 and the seven historical runs:

| probe | recorded failure | supported when | falsified when |
|---|---|---|---|
| **P1 governing basis / floor** | floors read separately (D2k, K2, 1C.1-K3) or summed (K3, K4, 1C.1-K2/K4); the ambassador floor and the post floor both applied to one offer | the answer cites `.basis` / `.range` / `.band` and names no other floor; no per-post × 4 reasoning | it still picks its own floor(s), or cites the block and then computes anyway |
| **P2 non-additivity** | 3,602 + 4 × 1,000 = 7,602 as "cumulative floors" | no summed floor in any of the five C2 runs | any 7,602 |
| **P3 history vs comparable evidence** | gorjana's USD 7,500 cash as "demonstrated cash economics"; the USD 14,000 high added into a counter | history cited, if at all, as NOT_COMPARABLE / an observation; no number from it enters the decision; **A2 (mounted-only) still uses it and A3 does not** → the redesign vocabulary is part of the minimum | A3 uses it as a benchmark; or A2 already does not (then comparability was not the lever) |
| **P4 decision-relative missingness** | D2 asked for compensation, term, deliverables and not exclusivity; K4 called exclusivity unseen though the overlay stated none | `not_seen` / requests for the D2 question are drawn from `.absent` (usage rights) and the stated exclusivity is read as known; in A5 the D3 answer marks exclusivity and term material and compensation not, from the *same* block | the block's `.absent` is copied wholesale as material regardless of question; or A5's two answers do not differ in what they treat as material |
| **P5 term / rights / exclusivity** | rights never considered; exclusivity misread once | an "accept" that treats usage rights as UNKNOWN (from `.unknown`) and either requests them as decision-material or says why they are not; never asserts the sheet omitted them; exclusivity read from the sheet as stated, not requested | rights asserted absent, or ignored in an accept; exclusivity requested when the source states it |
| **Stability** | accept in 3 of 7, counter in 4 of 7 on identical inputs | A3 ×3 on one side of the axis with the same cited lines | a flip within A3 |
| **Coherence unchanged** | 1C.1 decision-set semantics held | standing positioning decision accounts for the request (cites it) and does not own the step; no double ownership | regression on the 0.4.0 semantics — read as an interaction, not tuned |

None of the probes encodes the expected decision. Accept and counter are both admissible; what is read is *what the decision is grounded on* and whether it moves between runs.

### 9.1 Interpretation rule — separate boundary validity from producer correctness (added 26 Sep, before the calls)

Two independent questions, never collapsed:

1. **Boundary / responsibility.** When Commercial Intelligence supplies interpreted commercial meaning, does the Brain consume that meaning rather than reconstructing rate, floor, additivity, comparability and observed-ness semantics itself?
2. **Producer correctness.** Is the interpretation supplied by Commercial Intelligence itself semantically valid?

The fixture stage made this concrete: the mounted producer reads the Northlight sheet as BELOW (USD 1,250 per deliverable against an ambassador range of 3,602 / 3,602 / 3,718), while the probe established that the ambassador card range is a monthly-retainer range and the athlete floor carries no unit. That is deliberately not adjudicated before the experiment. Therefore:

- A Brain that consistently uses `.basis` / `.range` / `.band` and stops doing its own floor arithmetic **supports the responsibility boundary even if the producer's BELOW is later judged wrong**.
- A3 stable because all three runs rely on `.band = BELOW` is recorded as **boundary support + unresolved producer-semantic correctness**, not as "the correct commercial decision is counter".
- A counter is not correct merely because the producer says BELOW. An accept is not incorrect merely because it differs from BELOW: inspect whether the Brain reconstructed its own commercial semantics or identified an actual evidentiary or semantic inconsistency.
- A Brain that notices the supplied basis/range carry incompatible or insufficient unit semantics and **requests clarification rather than independently repricing** is recorded separately: the interface may be directionally right while Commercial Intelligence needs typed unit/basis semantics.
- A Brain that ignores the assessment and returns to "5,000 > 3,602" arithmetic is the boundary failure the experiment exists to detect.

The same rule covers the other fixture discoveries, all left frozen: `timeline` means a deadline rather than a term; `term_months` / `counts_basis` have no production writer; the null `counts_basis` behaviour contradicts its comment; gorjana is INDIRECT under the current Rate rule; Lilia's placeholder card is dropped; a missing contract-period record is not a missing contract. The experiment tests **who owns commercial interpretation**, not whether every existing commercial producer is right.

**Two result dimensions recorded per commercial claim in every run**, beside the probes of §9:

| dimension | values |
|---|---|
| source of commercial reasoning | raw evidence / Brain-derived · Commercial Intelligence block · mixed · unsupported |
| producer semantic status | internally coherent on the supplied evidence · known unresolved producer-semantic issue · new producer-semantic issue exposed by the run |

## 10. What evidence would support the boundary

The boundary — Commercial Intelligence interprets, the Brain decides, Deals executes — is supported if, across the fourteen runs:

1. C2 cells ground every commercial claim in block lines and contain no own floor arithmetic, no own comparability call, and no counter figure (P1–P3, P5);
2. A1 does not achieve (1) — numbers were not the missing thing;
3. A2 achieves P1 and P2 but not P3, and A3 achieves all three — the additional semantic layer was necessary in this experiment; if the rationale cites the NOT_COMPARABLE line and stops transferring gorjana's economics, that is strong evidence that comparability was the operative semantic, and it is not proof that every other C2 line is part of the minimum interface (those variables are not isolated in this run, deliberately);
4. A3 is stable ×3 on the accept/counter axis;
5. A4 shows the same use of the block as A3 — placement is an engineering choice — **or** shows a difference that the citations make legible (standing decisions use State-placed lines; request answers use either) — placement is a semantic choice, and the evidence says which;
6. A5 shows decision-relative materiality derived from one subject-level assessment — the interface is subject-level, and the Brain does the decision-relative selection, as 1B.3 showed it can;
7. B1, C2, D2 remain grounded under sparse evidence: their commercial claims are limited by the NOT_ESTABLISHED / NOT_OBSERVED / UNKNOWN lines, and the block changes grounding, requested information or stated confidence relative to each control; where a control did fail, supplying meaning repairs it. **A control behaving correctly is not evidence against the boundary** — it is recorded as a limitation on causal attribution for that cell (the failure did not reproduce in that call);
8. non-commercial standing decisions are unchanged by the block (no contamination).

## 11. What would falsify it, or force a different boundary

- **C2 still reconstructs semantics or still flips (P1–P3 fail, or A3 splits).** Meaning-as-evidence is insufficient. The likely alternative boundaries, in order of how little they add: (a) the accept-or-counter call belongs to specialized intelligence and Deal execution, with the Brain deciding only whether to engage, at what priority, against which Objective — a narrower Brain; (b) a refusing gate on commercial claims (cites required for any figure) — verification, not repair, in the 1C §9 sense; (c) the semantics must be enforced in the producer's *output shape* (typed, not prose), which is a contract question, not a prompt one.
- **A1 fixes it as well as A3.** The Brain can reconstruct semantics from numbers when given all of them; the interface is "complete evidence", not "interpreted meaning", and Commercial Intelligence's job is narrower than hypothesised. Then the redesign's vocabulary is for Rate, not for the Brain.
- **A2 already fixes P3.** The additional layer was not necessary for the comparability failure in this run; the mounted semantics sufficed here, and the redesign vocabulary's role at the Brain boundary is not shown by this experiment (not disproved either — one run, one fixture).
- **The Brain ignores the block and reasons from State's raw lines.** Either salience (it reads State before work) or the block is not decision-useful as rendered; A4 versus A3 separates the two.
- **A5's two answers treat the same things as material.** Decision-relative missingness is not derivable from a subject-level assessment; the interface needs a decision-specific component — that is the case for decision input rather than State or the opportunity, and would justify the spec line this run avoided.
- **C2/D2 invent, or price from research without a basis.** The producer must carry more on the thin end (most likely a Rate estimate with anchor basis and confidence — i.e. the redesign mounted as an evidence class), or the Brain needs a gate on unfounded figures. Either way Commercial Intelligence without Deals data is *not* enough as assembled, which is the finding the review most needs to know.
- **The controls (B0, C0, D0) do not fall into the trap.** Not a falsification. It limits what the thin cells can attribute causally (no repaired failure to point to), and the reading falls back to whether C2/D2/B1 stayed grounded and appropriately limited. The State-level defect (§0.1.2) remains a State correctness item in either case, frozen for this experiment.

## 12. What this checkpoint does not decide

Where the producer of commercial meaning lives in production; whether it is a service, a projection or a State section; whether the inbox's per-deal verdict survives as a surface; which deliverable vocabulary wins; whether floors are Commercial Intelligence's to interpret or the athlete's to assert; anything about Brand Intelligence beyond §1.1; whether `deals.status` reaching `accepted` from a model reading a signature is acceptable as an evidence source (audit finding 7 — it feeds `.history` and `.observed`, so it is *inside* the block's provenance and is stated as such). The live defects in #621 §12 remain recorded there.

## 13. Not done

No implementation, no provider call, no spec bump, no schema, no `CommercialAssessment` type, no change to Deals logic, score, prompts, Rate redesign, Campaign or Studio, no coordination field, no separate Deal Brain, no touch on #608 or #570.

---

**Requested decision:** approve the hypothesis (§2), the fourteen-call matrix (§4) with its fixtures shown before calls, and the three envelope additions (§7); or cut to the ten-call form; or redirect the boundary. On approval the next step is the fixture stage only — the assembled block rendered for every cell as a dry run, the DB read for Ronaldo's and Lilia's rows, and the exact rendered text shown for review — with the calls a separate approval after that.
