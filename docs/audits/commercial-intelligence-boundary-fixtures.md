# Commercial Intelligence ↔ Brain boundary — the rendered fixture pack

**Status:** fixture stage, for approval before any call. Every cell is rendered with `--dry`: the exact prompt that would be sent, and nothing sent. **No provider call was made.** Brain `brain-eval-spec/0.4.0-exp` text and digest unchanged (parity test green); Deals, Rate, State builder, Objective, Campaign, Studio untouched; #608 and #570 untouched.

**Design:** `docs/architecture/commercial-intelligence/commercial-intelligence-brain-boundary-checkpoint.md` (PR #622, corrected per the 26 Sep review). **Artifacts:** `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/` — `probe/` (the DB reads), `fixtures/` (transcribed offers, hand lines, overlays, requests), `cells/` (condition × placement per cell), `dry/<cell>/` (`inputs.json`, `prompt.txt`, `size.json`), `dry-run.sh` (re-renders everything; remove `--dry` by hand, one cell at a time, only after approval).

---

## 1. Fixture facts that differ from the assumptions in #622

Read these first. None was tuned away; each is rendered as found.

1. **The mounted producer reads the Northlight term sheet as BELOW her range — under every transcription.** As the summariser would shape it (unit `total`, four deliverables, deal type `ambassador`, no `term_months`, no `counts_basis`), `matchRate` prices it at USD 1,250 per deliverable against the `ambassador` range, which after her USD 3,602 floor is 3,602 / 3,602 / 3,718 → `BELOW`. With `counts_basis: "term"` it becomes the USD 5,000 lump against projected annual value 17,870 / 22,338 / 27,922 → `BELOW`. Every prior Brain run read USD 5,000 as *above* her ambassador floor (D2k, K2, 1C.1-K3 accepted on that reading). Two things underneath, recorded and not fixed: `deriveDealTypeRates` maps `ambassador` to the card's **monthly retainer** range, and the athlete's floor carries no unit, so the code compares per-deliverable money to a monthly-retainer range raised by a unit-less floor. The experiment does not adjudicate which reading is right. It exposes the producer's reading to the Brain and reads what the Brain does with it. This is the single most consequential fixture fact: the "accept, it exceeds her floor" answer that three runs produced is now contradicted by the specialized intelligence.
2. **Ronaldo holds no rate card at all** — there is no `athletes_current` row (#622 said one "may exist" from research refresh). His range and band render `NOT_ESTABLISHED`. He also has no persisted opportunity map (the cohort's map was not written to `objective_proposal_sets`), so V2 runs without one; research: 2 runs, 1 state row.
3. **Lilia is not "no connected commercial evidence".** A Gmail mailbox was connected and is now revoked (four rows, none active); 39 deals are recorded, all `detected`, none negotiating, accepted or completed; floors are stated for `autograph` (579) and `appearance` (612) only; her v3.1 card is a sparse-profile placeholder (socialPost 1 / 2 / 2, ambassador 3 / 6 / 10), which `withFloors` drops below USD 25, while PAV 242 / 440 / 703 survives. Cell D is therefore *a user with a stale mailbox, detections only, partial floors and a placeholder card* — a real point on the gradient, sharper than the one assumed. Chisom Okpara was probed as the fallback (no floors; card with zeros for socialPost and ambassador; PAV 1,315 – 3,826; no research) and is kept as fallback, not used.
4. **gorjana has no `deal_periods` rows**, so the contract-derived value line renders `NOT_ESTABLISHED — no contract period is recorded by Nomila (a missing record, not a missing contract)`. Mia shows 0 rows in `research_runs`; her research predates that table and nothing in the cells depends on it.
5. **`computeMissingTerms` reports `timeline` as not stated in every cell.** Its "timeline" is a *deadline* (`classification.deadline` / `key_details.deadlines`); the sheet states a term and no deadline, and the work-item line above the assessment renders the term dates. Shown as is: the Brain sees a stated term and an extractor that says no deadline was stated.
6. **The production path never sets `term_months` or `counts_basis`** (no writer anywhere), so the per-deliverable path runs. The doc comment on `counts_basis` says a null must not be guessed and the per-unit path is skipped; the code (`counts_basis !== "term"`) treats null as usable. A comment-versus-code disagreement, recorded, not fixed.
7. **Comparability of gorjana, applied literally, is INDIRECT, not NOT_COMPARABLE** (the checkpoint's illustrative line said the latter). rate-v0-design §12.4 defines INDIRECT as related but non-equivalent evidence; gorjana is Instagram content by the same athlete, twelve deliverables with 46% of value in product, against a four-post ambassador term. Rendered INDIRECT with that reason. The seven negotiating items render as one INTEREST / NOT_COMPARABLE line naming the brands; they are cited individually from EXISTING WORK, not through a composite id.
8. **The P-state path is `commercialPosition.assessment.<key>`**, without a `[<work id>]` selector, so it resolves through the existing state-path grammar with no change to the Opportunity resolver's keyed-collection table; the section header names the subject. Non-canonical, rendered for this run only.
9. **A5's second question reuses the approved D3 wording about the R2 item** (the original D3 fixture was about the R3 item): `fixtures/D3-r2.decision.json`.
10. **C and D requests are asked by "the athlete's agent, through Mila"** as part of the controlled fixture; Ronaldo is not a user and this is stated in the artifact, not hidden from the reader.
11. **The upstream State defect renders exactly as today in C and D:** `closedDeals 0 [measured · HIGH confidence]`, `activeRelationships [] [measured · HIGH confidence]`, `pricingEvidence none`. Left in place on purpose (checkpoint §8).

## 2. What the mounted functions produced, per athlete

The offer transcribed for every cell (fixture `offer`): `{ amount: 5000, product_value: null, commission_pct: null, unit: "total", deliverable_counts: { instagram_posts: 4 }, deal_type: "ambassador" }` — the summariser's shape, with the fields the production path never sets left unset.

| | Mia (A, B) | Ronaldo (C) | Lilia (D) |
|---|---|---|---|
| card as the scorer sees it (`hasRate`) | v3.1.0-calibrated; yes | none (no `athletes_current` row) | v3.1.0-calibrated placeholder; yes (PAV mid 440 > 0) |
| floors stated | socialPost 1,000 · appearance 1,213 · ambassador 3,602 · autograph 465 · licensing 1,049 | none | autograph 579 · appearance 612 |
| `totalGuaranteedValue` | 5,000 | 5,000 | 5,000 |
| `annualizedValue` | null (no term months) | null | null |
| `matchRate` | ambassador · 1,250 per deliverable | ambassador · 1,250 per deliverable | ambassador · 1,250 per deliverable |
| `withFloors` range for that basis | 3,602 / 3,602 / 3,718 | NOT_ESTABLISHED (no card) | NOT_ESTABLISHED (ambassador 3 / 6 / 10 dropped below USD 25) |
| `economicsBand` | **BELOW** — `$1250/ambassador vs {3602/3602/3718}` | NOT_ESTABLISHED (NA_CASH) — no rate card | NOT_ESTABLISHED (NA_CASH) — no ambassador rate on card |
| `computeMissingTerms` | timeline | timeline | timeline |
| `resolveDealValue` (gorjana) | NOT_ESTABLISHED — no period recorded | — | — |

Transcription sensitivity (pure functions, not used in any cell): `counts_basis: "term"` → 5,000 lump vs PAV → BELOW; `term_months: 12, counts_basis: "per_year"` → annualised 5,000 vs PAV → BELOW; `unit: per_post 1,250` → BELOW. The producer's reading of this sheet against Mia's card does not depend on the transcription.

## 3. The renderings

### 3.1 C2, P-work — cell A3 (verbatim from `dry/A3/A3.prompt.txt`)

```
    work[ctl-r2-northlight-termsheet]
        negotiating · Northlight Learning · since 2026-09-22 · toward objective[c0f587e4-750f-4575-a4e8-fd4cfa6e078e]
        Northlight Learning (EdTech) sent a term sheet on 22 September 2026: USD 5,000 for an ambassador agreement covering the 2026-27 academic year, four Instagram posts, no category exclusivity. No response has been sent.
        amount 5000 (cash 5000 / product —) · term 2026-10-01 → 2027-06-30 · deliverables recorded: 4
        commercial assessment (commercial-assessment/0.1.0-exp · derived by Nomila's deal economics from the terms above, deterministic; lines marked ‡ apply Nomila's rate-intelligence rules by hand). Cite as work[ctl-r2-northlight-termsheet].<key>.
          work[ctl-r2-northlight-termsheet].offer  USD 5,000 cash · stated product value: not stated (null is not zero) · commission: not stated · unit total · 4 deliverables (4 instagram_posts) · deal type ambassador · term months / counts basis: not set (Nomila's extraction does not set them)
          work[ctl-r2-northlight-termsheet].value  guaranteed value USD 5,000 = cash + stated product (a product value not stated contributes nothing); commission is excluded; the components of ONE offer add
          work[ctl-r2-northlight-termsheet].basis  governs: ambassador — USD 1,250 per deliverable (USD 5,000 ÷ 4). The offer's deal type maps to the ambassador rate; a floor or rate for another type does not apply to this offer
          work[ctl-r2-northlight-termsheet].range  USD 3,602 / USD 3,602 / USD 3,718 (low / mid / high) for ambassador, after the athlete's stated floor for that type (USD 3,602; a floor raises the low end only). Floors are per type and do not add across types
          work[ctl-r2-northlight-termsheet].band  BELOW — $1250/ambassador vs {3602/3602/3718}
          work[ctl-r2-northlight-termsheet].absent  established as not stated, of the terms Nomila reads (price · deliverables · timeline, where timeline means a deadline): timeline
          work[ctl-r2-northlight-termsheet].unknown  usage rights: UNKNOWN — not established by this evidence path (Nomila's extraction does not read usage rights; whether the terms state them is not known)
          work[ctl-r2-northlight-termsheet].exclusivity  as the source states it: no category exclusivity
          work[ctl-r2-northlight-termsheet].contract_9acd1d50  work[9acd1d50-0a84-4974-b3fc-bb965c8b5541] (gorjana) contract-derived value: NOT_ESTABLISHED — no contract period is recorded by Nomila for it (a missing record, not a missing contract)
        ‡ work[ctl-r2-northlight-termsheet].history_1  work[9acd1d50-0a84-4974-b3fc-bb965c8b5541] (gorjana, accepted: USD 14,000 — cash 7,500 / stated product 6,500 · 6 posts + 6 stories): COMMERCIAL_STATE AGREED · comparability to this offer INDIRECT — Instagram content by the same athlete, but a twelve-deliverable campaign with 46% of its value in product, against a four-post ambassador term; the package price is not the observed price of one post, and the product component is not evidence of cash pricing
        ‡ work[ctl-r2-northlight-termsheet].history_2  (the seven negotiating items in EXISTING WORK — TITAD (USD 300 per deliverable), IRON Peptides (commission-only), Pillar (gifting), Musugy, ProBand, AEGISLAB, Connect Me (no economics stated)): COMMERCIAL_STATE INTEREST · comparability to this offer NOT_COMPARABLE — open negotiations establish commercial contact; none is agreed economics, and a figure proposed in an open negotiation is not an accepted price
        ‡ work[ctl-r2-northlight-termsheet].high  demonstratedEconomics high USD 14,000 is the total of one agreed deal (gorjana, including USD 6,500 stated product); it is an observation of what was once agreed — not a benchmark and not a floor
        ‡ work[ctl-r2-northlight-termsheet].observed  commercial history observed by Nomila: a connected Gmail mailbox (active) and Instagram (active); 211 deal rows recorded by Nomila — 1 accepted, 7 negotiating, 2 rejected, 201 detected inbound. A count of Nomila's records is not a count of real-world history; what Nomila has not observed is not evidence of absence
```

Every `code` line is the output of the named mounted function on the transcribed offer and Mia's real card and floors (probe artifact). Every `‡` line is a fixture line with its rule recorded in `fixtures/A-mia.assessment.json`. The block contains no score, no fit reading, no counter figure and no verdict.

### 3.2 C2a, P-work — cell A2

The same block through `.contract_9acd1d50`, without the four `‡` lines (9 lines).

### 3.3 C1, numbers only — cell A1 (verbatim)

```
        commercial assessment (commercial-assessment/0.1.0-exp · the athlete's rate card as Nomila computes it, per deal type, low / mid / high in USD — numbers only). Cite as work[ctl-r2-northlight-termsheet].<key>.
          work[ctl-r2-northlight-termsheet].rateCard.socialPost  USD 689 / USD 862 / USD 1,077 (low / mid / high)
          work[ctl-r2-northlight-termsheet].rateCard.appearance  USD 804 / USD 1,005 / USD 1,256 (low / mid / high)
          work[ctl-r2-northlight-termsheet].rateCard.ambassador  USD 1,859 / USD 2,656 / USD 3,718 (low / mid / high)
          work[ctl-r2-northlight-termsheet].rateCard.autograph  USD 308 / USD 385 / USD 482 (low / mid / high)
          work[ctl-r2-northlight-termsheet].rateCard.licensing  USD 518 / USD 740 / USD 1,035 (low / mid / high)
          work[ctl-r2-northlight-termsheet].rateCard.projectedAnnualValue  USD 17,870 / USD 22,338 / USD 27,922 (low / mid / high)
          work[ctl-r2-northlight-termsheet].rateCard.version  v3.1.0-calibrated · derived per deal type by Nomila; ranges are the card's own, before any stated floor
```

The card before floors (floors are already in State, unchanged). No basis, no band, no reading.

### 3.4 C2, P-state — cell A4 (header and first lines; the 13 lines are identical to A3's)

```
COMMERCIAL ASSESSMENT — about work[ctl-r2-northlight-termsheet] (commercial-assessment/0.1.0-exp · derived by Nomila's deal economics from the terms above, deterministic; lines marked ‡ apply Nomila's rate-intelligence rules by hand).
  Cite each line by the path at its left.
      commercialPosition.assessment.offer  USD 5,000 cash · stated product value: not stated (null is not zero) · …
      commercialPosition.assessment.basis  governs: ambassador — USD 1,250 per deliverable (USD 5,000 ÷ 4). …
      commercialPosition.assessment.band  BELOW — $1250/ambassador vs {3602/3602/3718}
      …
    ‡ commercialPosition.assessment.observed  commercial history observed by Nomila: …
```

Appended at the end of ATHLETE STATE; the work item in A4 carries no assessment. The paths resolve because the same lines are attached at `commercialPosition.assessment` on a rendering-time copy of State; the builder and contract are unchanged.

### 3.5 Cell B — connected commercial withheld (B0 and B1 share this State rendering)

```
COMMERCIAL POSITION — what the market has actually paid. Counted, never estimated.
    commercialPosition.closedDeals            not known (withheld in this cell — connected commercial records rendered as not observed)
    commercialPosition.activeRelationships    not known (withheld in this cell — connected commercial records rendered as not observed)
    commercialPosition.demonstratedEconomics  not known (withheld in this cell — connected commercial records rendered as not observed)
    commercialPosition.pricingEvidence        none
…
    commercialPosition.pipeline               detected 0 · negotiating 0 · rejected 0 · accepted 0 · completed 0
…
    (no classified inbound threads)
```

EXISTING WORK holds only the controlled term sheet (the eight real rows are dropped). Floors, the card, the Objectives, the map and the context block are untouched. B1's assessment has no `contract_`, `history_` or `high` line, and its observed line reads: *commercial history: NOT OBSERVED in this rendering — Nomila's connected commercial records are withheld in this cell; no deal record and no mailbox observation is available to this evaluation. Not observed is not none.*

### 3.6 Cells C and D — the thin end

Ronaldo (C2), the three lines that differ from A3:

```
          work[ctl-c-lumen-termsheet].range  NOT_ESTABLISHED — no rate card is held for this athlete (unknown-rate athlete); stated floors: none stated
          work[ctl-c-lumen-termsheet].band  NOT_ESTABLISHED (NA_CASH) — no rate card (unknown-rate athlete)
        ‡ work[ctl-c-lumen-termsheet].observed  commercial history observed by Nomila: no connected account and no mailbox; no deal recorded by Nomila; a researched public profile is held (2 research runs). A count of Nomila's records is not a count of real-world history; what Nomila has not observed is not evidence of absence
```

Lilia (D2):

```
          work[ctl-d-fieldline-termsheet].range  NOT_ESTABLISHED — no usable ambassador range on the card (a derived range below USD 25 is a placeholder, not a benchmark, and is dropped); floor for ambassador: none stated
          work[ctl-d-fieldline-termsheet].band  NOT_ESTABLISHED (NA_CASH) — no ambassador rate on card
        ‡ work[ctl-d-fieldline-termsheet].observed  commercial history observed by Nomila: a Gmail mailbox was connected and is now revoked (four connections, none active — no current observation); 39 deal rows recorded by Nomila, all detected inbound, none negotiating, accepted or completed; no research run. A count of Nomila's records is not a count of real-world history; detected inbound is contact, not a deal; what Nomila has not observed is not evidence of absence
```

Both State blocks carry the upstream defect verbatim (fact 11); Lilia's pipeline line reads `detected 39 · negotiating 0 · rejected 0 · accepted 0 · completed 0`.

### 3.7 The controlled overlays and requests for C and D

- `ctl-c-lumen-termsheet` — "Lumen Language (online language learning) sent a term sheet on 22 September 2026: USD 5,000 for an ambassador agreement covering one year, four Instagram posts, no category exclusivity. No response has been sent." term 2026-10-01 → 2027-09-30, 4 deliverables recorded, no Objective.
- `ctl-d-fieldline-termsheet` — "Fieldline Training (youth sports training app) …" identical economics and structure.
- Requests `D2k-C` / `D2k-D`: "Should this negotiation be advanced, countered or accepted?", asked by "the athlete's agent, through Mila", about the overlay item. A5 adds `D3`: "Can this negotiation proceed alongside her other relationships?", the athlete through Mila, about the R2 item. Both fictional brands; no researched profile exists for either.

## 4. How UNKNOWN, NOT OBSERVED and NOT_ESTABLISHED render

| state | where | rendered as |
|---|---|---|
| not established by a producer (no card, placeholder card, no basis) | `.range`, `.band`, `.basis` | `NOT_ESTABLISHED — <the function's own reason>`; the band keeps the code's `NA_CASH` label in parentheses |
| outside the extractor (usage rights) | `.unknown` | `UNKNOWN — not established by this evidence path (…)`; never "not stated" |
| stated by the source | `.exclusivity` | `as the source states it: no category exclusivity`; a silent source would render `UNKNOWN — the source does not state it` |
| established as not stated (the three extractor terms only) | `.absent` | `established as not stated, of the terms Nomila reads (…): timeline` |
| a missing Nomila record | `.contract_<id>` | `NOT_ESTABLISHED — no contract period is recorded by Nomila (a missing record, not a missing contract)` |
| not observed by Nomila | `.observed` | the counts as recorded, then the constant sentence: *A count of Nomila's records is not a count of real-world history; what Nomila has not observed is not evidence of absence* |
| withheld for the cell | State (B) and `.observed` (B1) | `not known (withheld in this cell — …)`; *Not observed is not none* |
| the null product value | `.offer` | `stated product value: not stated (null is not zero)` |

## 5. The fourteen calls, with the rows selected

| cell | athlete (id) | variant · blocks | condition · placement | requests | prompt chars | calls |
|---|---|---|---|---|---|---|
| A0 | Mia Bhuta (`dc8f…`) | V3 · 3 live, 1 deferred, 1 declined, map 6, work 9 (R2 controlled), context 7 | C0 | D2k | 52,514 | 1 |
| A1 | Mia | V3 | C1 · work | D2k | 53,600 | 1 |
| A2 | Mia | V3 | C2a · work | D2k | 54,597 | 1 |
| A3 | Mia | V3 | C2 · work | D2k | 56,400 | **3** |
| A4 | Mia | V3 | C2 · state | D2k | 56,324 | 1 |
| A5 | Mia | V3 | C2 · work | D2k + D3 | 56,583 | 1 |
| B0 | Mia, withheld | V3 · work 1 (R2 only) | C0 | D2k | 49,549 | 1 |
| B1 | Mia, withheld | V3 | C2 · work | D2k | 51,655 | 1 |
| C0 | Cristiano Ronaldo | V2 · 0 live, no map, work 1 (controlled), no context | C0 | D2k-C | 34,400 | 1 |
| C2 | Ronaldo | V2 | C2 · work | D2k-C | 36,425 | 1 |
| D0 | Lilia Bhuta | V2 · 0 live, no map, work 1 (controlled), no context | C0 | D2k-D | 36,657 | 1 |
| D2 | Lilia | V2 | C2 · work | D2k-D | 38,920 | 1 |

Twelve distinct prompts, fourteen calls. Athlete ids are in `probe/*.json`. C and D run with zero live Objectives; the validator accepts an empty `decisions[]` there and the request block is the only door.

## 6. What changed in code (the envelope additions of checkpoint §7), and what did not

Added, all experimental and inert unless `--commercial` / `--withhold` is passed:

- `server/services/intelligence/brain/commercialAssessment.ts` — the `commercial-assessment/0.1.0-exp` envelope: types and the two renderers (work placement, state placement). Pure; imports nothing.
- `server/services/commercialAssessmentAssembler.ts` — outside `intelligence/` (the producers import providers): runs `totalGuaranteedValue`, `annualizedValue`, `matchRate`, `economicsBand`, `withFloors`, `deriveDealTypeRates`, `computeMissingTerms`, `resolveDealValue` on the fixture offer and the probe's real card and floors; attaches the fixture's `‡` lines under C2; the cell-B rendering ablation.
- `server/scripts/intelligence/commercialFixtureProbe.ts` — the read-only DB probe (no tokens read; platform and status only).
- `brainRun.ts` — `--commercial <cell.json>`, `--withhold connected-commercial`.
- `contract.ts` — optional `commercial?: CommercialAttachment` on `BrainInputs`. `inputBlock.ts` — the work renderer appends the lines under the subject. `brainExperimentOrchestrator.ts` — the state renderer appends the P-state section. `grounding.ts` — `work[<id>].<key>` resolves only when an assessment is attached under that item (Gate 2 otherwise unchanged).
- Tests: `commercialAssessment.test.ts` (3) and one grounding case. Brain suites and the import-boundary lock: 5 suites, 218 tests, green. `tsc --noEmit` clean.

Unchanged: `evalSpec.ts` (text, digest `ffb97cd4…`, gates, validators — parity test green), `existingWork.ts`, the context block, the State builder and `AthleteState` contract, the Opportunity state-path resolver, `dealScoreGrid.ts`, `dealDetector.ts`, `askTerms.ts`, `dealValue.ts`, `rateService.ts`, the Rate spec, every table.

## 7. Requested approval

Approve the fourteen calls as rendered (or name cells to cut), in this order: A0 → A1 → A2 → A3 ×3 → A4 → A5 → B0 → B1 → C0 → C2 → D0 → D2, one cell at a time, artifacts written per call as in every prior experiment, no rerun between calls, nothing materialised. Cost per call is recorded on the artifact as before. Nothing runs until then.
