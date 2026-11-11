# Thin slice — the dry-render checkpoint (before any provider call)

**Status:** dry render for approval. **No provider call.** No production integration, no Rate change, no Rate/floor fix, no Deals behaviour change, no State change, no Campaign/Studio change, no Brain prompt or spec change. #608 and #570 untouched.

**Approved basis (26 Sep):** the A/B/C ownership split, transition option 2 ("Deals' read" as labelled input), the per-thread projection as the slice interface (experimental, not a frozen schema), the dry-render-first sequence. **Design:** `docs/architecture/commercial-intelligence/deals-intelligence-brain-leverage-checkpoint.md` (#624).

**Artifacts:** `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/` — `S-iniu.decision.json`, `G-gorjana.decision.json`, `dry/S0 S1 G0 G1/` (`inputs.json`, `prompt.txt`, `size.json`; `S1.rows.json` / `G1.rows.json` are the exact rows the projection read). Probe dumps of the three threads examined: `ci-boundary/probe/probe.{iniu,gorjana,titad}-thread.json`.

---

## 1. The thread selected, and why the first candidate was rejected

**Selected: the INIU inbound** — deal `82cf1d6f-fa8c-42d5-8ab8-f8ac0196953c`, thread `14df5058-1b8b-4f91-bb5c-ffbac1350867`, Gmail. Subject "⚡Paid Partnership: Hi miabhuta! Elevate Your Power Setup with INIU (No.1 Power Bank Brand on Amazon US)". Two inbound messages (25 and 26 Aug 2026), zero outbound: the athlete has never replied, so nothing on the thread can be a test reply. Classified PAID; the summariser's ask "1 video + 3-month bio link + copyright license"; no price stated; the brand is researched (Tech Accessories, established, enriched 25 Aug). Deals' own read: negotiate, low confidence. It is the "qualify the opportunity or ask for terms" case the review named, and it sits on the Explore All screen.

**How "on the Explore All screen" was checked.** The list is `GET /me/deals?view=active` (`routes/deals.ts loadRankedDeals`): every deal row of the athlete whose thread is not archived, ordered by the deterministic rank (`lib/dealRanking.ts computeDealRank`), and the client hides archived threads. A deal row exists only after the ingest gates and the classifier's `is_deal`, so being in this list means the filtering already happened. Mia has 34 active rows in 29 groups. INIU sits in the middle band (rank 1040, the same as most unanswered inbounds; the top band is reserved for items with a deadline or a fresh reply).

**Rejected first candidate: TITAD.** It was the only *negotiating* thread with a priced structured offer, but (a) it ranks **last** of the 34 on Explore All (rank 20: score 2, reject, awaiting the brand, 88 days idle), (b) its one outbound message is the athlete's own counter, which the structured offer then recorded as "the offer" (USD 300 per deliverable is her ask, not the brand's), and (c) the review's caution stands — the outbound replies on the negotiating rows may be test replies. The other six negotiating rows are unpriced and each carries one outbound reply of the same doubtful kind. **The seven "negotiating" statuses are not treated as real negotiations by this slice.**

**Companion for the priced path: gorjana** — deal `9acd1d50-0a84-4974-b3fc-bb965c8b5541`, the one real deal that went through negotiation and closed (61 messages, USD 7,500 cash + USD 6,500 product, six posts + six stories, `accepted`). It is rendered so the priced lines (`value`, `basis`, `range`, `band`) are seen on a real row, with the athlete's own K1-style question ("Should I post about gorjana this week?"). It is not the negotiation case.

Other candidates examined and set aside, with the reason recorded: Stan Eats (student-ambassador recruiting, Instagram DM, brand not researched), Harrison Szep (a creator's video collaboration, not a brand deal), HLTH Code and MPG (gifting only), Public Records / Xingye / Wildthings (the brand resolver attached the wrong researched brand row — Public Rec, Finish Line, Wild Things — a live defect of the kind #621 §12 records; not fixed), StartX1 (the deferred Objective; never read, by standing instruction), the four detected gorjana campaign inbounds (cross-thread grouping gap, known).

## 2. The exact fourteen-line projection as it renders — INIU (cell S1, verbatim from `dry/S1/S1.prompt.txt`)

```
    work[82cf1d6f-fa8c-42d5-8ab8-f8ac0196953c]
        inbound · INIU · since 2026-08-25
        Inbound from INIU, detected 2026-08-25: 2 messages received, 0 sent. Not work in motion — the subject of a decision request.
        amount not recorded · term not recorded → not recorded · deliverables recorded: 0
        commercial assessment (deal-assessment-projection/0.1.0-exp · assembled from Nomila's own records of this thread by its deal economics, deterministic; where a line says model, that is Nomila's summariser or scorer; a unit is stated only where a source establishes it). Cite as work[82cf1d6f-fa8c-42d5-8ab8-f8ac0196953c].<key>.
          work[…].offer  as structured by Nomila's thread summariser (model): cash: not stated · stated product value: not stated (null is not zero) · commission: not stated · unit not stated · 1 deliverable (1 videos) · deal type social_post (classification category PAID). The summariser's own reading of the offer: "—"; the ask: "1 video + 3-month bio link + copyright license". Whose figure the amount is, is stated only in that prose.
          work[…].thread  2 messages (2 inbound, 0 outbound) · first 2026-08-25 · last 2026-08-26 (32 days ago) · awaiting response from: athlete · deadlines recorded: none · deals.status detected, how reached: thread stage "outreach" read by the summariser (model) · thread status deal_detected · deliverables recorded by Nomila: 0
          work[…].value  NOT_ESTABLISHED — neither cash nor a product value is stated on the structured offer (a value not stated is not zero)
          work[…].basis  NOT_ESTABLISHED — no guaranteed value, or the offer's unit cannot be matched to a rate type
          work[…].range  NOT_ESTABLISHED — no governing basis
          work[…].band  NOT_ESTABLISHED (NA_NOCASH) — offer unit not matchable to a rate type
          work[…].absent  established as not stated, of the terms Nomila's extractor reads (price · deliverables · timeline, where timeline means a deadline): price, timeline
          work[…].unknown  usage rights: not extracted as a field by Nomila; the thread's recorded text mentions rights (see the classification's deliverables and the summariser's prose) — what rights terms are, or whether they are agreed, is NOT ESTABLISHED. Exclusivity: UNKNOWN — no recorded source states it.
          work[…].risk  red flags as judged by Nomila's deal scorer (model; rubric: pay-to-play, rights grabs, exposure-only with exclusivity, pressure, impersonation): none
          work[…].completeness  economics state as assessed by the scorer (model): tbd — its note: "No offer stated; athlete's floor is $1,000/post"
          work[…].brand  researched brand row: INIU · category Tech Accessories · tier established · Tech Accessories. Provenance: Nomila brand research, enriched 2026-08-25; grounding sources not retained; no confidence recorded.
          work[…].contract  not applicable — a detected item; no contract or contract period is recorded
          work[…].dealsRead  Deals' read = the existing per-deal system's judgment using its current evidence and logic: negotiate · confidence low · urgency low · fit read "Lifestyle product fit" (fair) · brand as the scorer inferred it from the email: Consumer Electronics, mid. Reconciliation direction: not persisted. No timestamp is persisted on the score. Made per deal with no view of Objectives, State, other work or context. Evidence, not an instruction.
          work[…].observed  commercial history observed by Nomila: connected accounts active — youtube, tiktok, gmail, instagram; deal rows recorded by Nomila — 2 rejected, 7 negotiating, 201 detected, 1 accepted; research runs 0. A count of Nomila's records is not a count of real-world history; what Nomila has not observed is not evidence of absence.
```

(`work[…]` abbreviates the full id, which is rendered in full on every line.)

### 2.1 The priced companion — gorjana (cell G1), the lines that differ in kind

```
          work[9acd1d50-…].offer  as structured by Nomila's thread summariser (model): USD 7,500 cash · stated product value: USD 6,500 · commission: not stated · unit total · 12 deliverables (6 posts, 6 stories) · deal type social_post (classification category GIFTING). The summariser's own reading of the offer: "Final offer: $7.5k cash + $6.5k product credit, 6 posts + 6 stories, plus affiliate commission structure"; the ask: "College Roster partnership with social media deliverables". Whose figure the amount is, is stated only in that prose.
          work[9acd1d50-…].thread  61 messages (38 inbound, 23 outbound) · first 2026-07-29 · last 2026-09-08 (18 days ago) · awaiting response from: athlete · deadlines recorded: 2026-08-24; 2026-09-30 · deals.status accepted, how reached: thread stage "agreed" read by the summariser (model) · thread status deal_detected · deliverables recorded by Nomila: 0
          work[9acd1d50-…].value  guaranteed value USD 14,000 = cash + stated product on the structured offer above; commission excluded; components of ONE offer add. (This reads offer_struct.amount as the offer's cash whatever the prose says about whose figure it is.)
          work[9acd1d50-…].basis  the producer compares USD 1,167 per deliverable (USD 14,000 ÷ 12; the offer's own unit is total) against the socialPost range. Key chosen because: deal type social_post maps to socialPost. Offer unit: total (source: the summariser's offer_struct). Card range unit: per post (rate card field headlineSocial.ratePerPost). Relationship between the offer's unit and the card's unit: applied by the producer as equivalent; NOT_ESTABLISHED by any source.
          work[9acd1d50-…].range  USD 1,000 / USD 1,000 / USD 1,077 (low / mid / high) for socialPost — the card's own range USD 689 / USD 862 / USD 1,077 (low / mid / high) (rate source: v3.1.0-calibrated; unit per post (rate card field headlineSocial.ratePerPost)) after the athlete's stated floor for socialPost: USD 1,000 — unit: NOT_ESTABLISHED (deal_preferences.minimum_rates records no unit). A floor raises the low end only; floors are per type and do not add across types.
          work[9acd1d50-…].band  ABOVE — $1167/socialPost vs {1000/1000/1077}. Unit relationship: NOT_ESTABLISHED (see basis); this is the producer's read on its current evidence, not a commercial verdict
          work[9acd1d50-…].contract  contract-derived value NOT_ESTABLISHED — no contract period is recorded by Nomila (a missing record, not a missing contract)
          work[9acd1d50-…].dealsRead  … accept · confidence high · urgency medium · fit read "Strong lifestyle fit" (good) · brand as the scorer inferred it from the email: Fashion Jewelry, established …   (researched row says Luxury Goods · established)
```

## 3. Provenance and source, line by line

| line | how produced | source class | model or code or persisted evidence |
|---|---|---|---|
| `offer` | `inbox_threads.conversation_state.key_details.offer_struct`, `.offer`, `.ask`; `classification.category`; `deals.deal_type` | persisted evidence, written by the thread summariser and classifier | **model** (Kimi summariser; Gemini classifier), quoted as recorded |
| `thread` | `inbox_messages` directions and timestamps; `key_details.awaiting_response_from`, `.last_contact`, `.deadlines` (code-owned turn fields); `conversation_state.deal_stage`; `deals.status`; thread status; `deal_deliverables` count | persisted evidence | **code** (mechanical thread state) except `deal_stage`, which is **model** and is labelled so |
| `value` | `totalGuaranteedValue(offer_struct)` | deterministic | **code** on model-structured input |
| `basis` | `matchRate`, `annualizedValue`, `RATE_KEY_FOR_DEAL_TYPE`; offer unit from `offer_struct.unit`; card unit from the rate-card field name behind `deriveDealTypeRates` | deterministic | **code**; the unit relationship is stated as the producer's practice and NOT_ESTABLISHED |
| `range` | `deriveDealTypeRates(athletes_current.rate_card)` → `withFloors(…, deal_preferences.minimum_rates)` | deterministic; **rate-dependent, provisional** | **code**; card version quoted; floor unit NOT_ESTABLISHED |
| `band` | `economicsBand` | deterministic; **rate-dependent, provisional** | **code** |
| `absent` | `computeMissingTerms(classification, conversation_state)` | deterministic | **code** |
| `unknown` | the extractor's scope (rights and exclusivity are not fields) plus a mention scan of recorded text | deterministic | **code**; a mention is reported as a mention |
| `risk` | `score.redFlags` | persisted evidence | **model** (scorer), rubric named |
| `completeness` | `score.economicsState` | persisted evidence | **model** (scorer), note quoted |
| `brand` | `inbox_brands` row | persisted evidence | **model + search** (brand research), provenance stated as weak |
| `contract` | `deal_periods` → `resolveDealValue`, for accepted items | deterministic | **code**; absence rendered as a missing record |
| `dealsRead` | `score.recommendation`, `.recommendation_confidence`, `.urgency`, `.fitRead`, `.brandAnalysis.category/.brandTier` | persisted evidence | **model reconciled by code** (`reconcileRecommendation`), labelled as a read |
| `observed` | `connected_accounts`, `deals` counts by status, `research_runs` | persisted evidence | **code** |

Every line's `source` field is `code` in the artifact, meaning *assembled by code from the named rows*; the text says where a value came from a model. No hand line exists in the projection (`transcription: "none — assembled from rows"`).

## 4. Every NOT_ESTABLISHED, UNKNOWN and missing value, exactly as it appears (INIU)

- `offer`: `cash: not stated` · `stated product value: not stated (null is not zero)` · `commission: not stated` · `unit not stated` · the summariser's offer reading `"—"` (null).
- `thread`: `deadlines recorded: none` · `deliverables recorded by Nomila: 0`.
- `value`: `NOT_ESTABLISHED — neither cash nor a product value is stated on the structured offer (a value not stated is not zero)`.
- `basis`: `NOT_ESTABLISHED — no guaranteed value, or the offer's unit cannot be matched to a rate type`.
- `range`: `NOT_ESTABLISHED — no governing basis`.
- `band`: `NOT_ESTABLISHED (NA_NOCASH) — offer unit not matchable to a rate type`.
- `absent`: `price, timeline` (timeline meaning a deadline; the ask names no deadline).
- `unknown`: usage rights `not extracted as a field … mentions rights … NOT ESTABLISHED`; exclusivity `UNKNOWN — no recorded source states it`.
- `contract`: `not applicable — a detected item`.
- `dealsRead`: `Reconciliation direction: not persisted` · `No timestamp is persisted on the score`.
- `observed`: `research runs 0` (Mia's research predates the runs table; a record fact, not an absence of research).

And in gorjana: the floor's `unit: NOT_ESTABLISHED`; the offer-unit ↔ card-unit relationship `NOT_ESTABLISHED by any source`; `contract … NOT_ESTABLISHED — no contract period is recorded (a missing record, not a missing contract)`; exclusivity `UNKNOWN`.

**No unit was manufactured.** The only units rendered are the summariser's `offer_struct.unit` (source: the summariser) and the rate card's own field names (`ratePerPost`, `monthlyRetainer`, `ratePerEvent`, `ratePerDeal`, `guaranteedMinimum`, `pav`). Mia's floors render with `unit: NOT_ESTABLISHED` everywhere. One source *does* assert a floor unit: the scorer's own note (`"athlete's floor is $1,000/post"`), because the scorer prompt calls it a "per-post FLOOR" — quoted as the scorer's note under `completeness`, not adopted by the projection. Recorded as a producer-semantic fact for the Rate/Commercial contract (§9 of the leverage checkpoint), not fixed.

## 5. Deals' read for the selected thread

`negotiate · confidence low · urgency low · fit read "Lifestyle product fit" (fair) · brand as the scorer inferred it from the email: Consumer Electronics, mid` — against the researched row's *Tech Accessories, established*. The persisted score carries no timestamp and no reconciliation direction; `recommendation_ui`, `negotiate_terms`, `draft_points` and `recommendation_agent` exist on the row and are **not** rendered. The line ends "Evidence, not an instruction."

## 6. What the Brain sees today versus what the projection adds

**Today (A0 through 1C.1 and #623):** INIU does not exist for the Brain. It is a `detected` deal, and `existingWorkFrom` never assembles detections ("detections never work", experiment 1); it is also outside State's capped `commercialPosition.inbound[]` list. A Decision Request about it cannot be posed, because `about` must name an Objective or a work item. The 201 detections are visible only as the pipeline count `detected 201`.

**Cell S0 (control, this slice):** the request can be posed because the inbound is rendered as the *subject* of the request under an experimental kind `inbound` (existing-work/0.3.0-exp): the four header lines of §2 with no assessment lines. Prompt 52,356 chars.

**Cell S1:** S0 plus the fourteen lines. Prompt 56,335 chars; the block adds 3,979 chars.

**Gorjana today (G0):** one line — "Deal with gorjana recorded as accepted. amount 14000 (cash 7500 / product 6500) · term not recorded → not recorded · deliverables recorded: 0" — plus State's `demonstratedEconomics {14000, 14000}`, `cashShare 0.54`, `activeRelationships [gorjana]`. **G1** adds the fourteen lines (5,000 chars).

## 7. Confirmation of what is excluded

Checked on the rendered prompts and enforced by the projection's test: no `scoreNumeric`, no verdict, no `recommendation_ui`, no `negotiate_terms`, no `draft_points`, no `recommendation_agent`, no counter figure, no CTA, no draft text. The only figures in the block are the offer's own (as recorded), the card ranges with their source, the floor with `unit: NOT_ESTABLISHED`, and the producer's per-deliverable division stated as its computation. Test: `server/services/dealAssessmentProjection.test.ts` (4 cases: sourced units, exclusion list, mentioned-not-stated rights and unpriced NOT_ESTABLISHED, no-card athlete). Brain suites, the import-boundary lock and the projection suite: 6 suites, 222 tests, green; `tsc` clean.

## 8. The two proposed Brain contract changes — proposed, not applied

Both are for a future spec bump (0.5.0-exp) and are **not** in this branch. Exact text proposed:

**(a) RECOMMEND may not construct a counter amount.** Add to `BRAIN_DECISION_BLOCK`, after the RECOMMEND fields:

> A RECOMMEND about a commercial subject says what to do and why — accept, counter, ask, wait, decline — and never how much. It does not state, compute or propose a figure for a counter, an ask, a fee or a rate: the amount is decided by the execution path from whatever commercial semantics are current when it acts. Where the evidence carries a figure, cite it; do not derive one.

And in Gate 1 (`validateDecision`), for `decision === "RECOMMEND"` where `cites` include any `work[…]` reference: refuse when `what` matches a currency amount (`/(USD|\$)\s?\d[\d,]*/`) or the words *counter at* / *raise to* / *at least USD*. Refuse, never repair. Test cases: A5's "counter … (totalling USD 14,408)" and A1's "increase the fee to at least USD 7,602" must be refused; A3-2's "align the fee with her ambassador floor" must pass (a reference, not a constructed figure — this boundary is the one to review).

**(b) Identifiers are structurally constrained.** Seven of fourteen sets in #623 were refused because the model wrapped ids as `objective[<id>]` / `request[<id>]` inside `objective_id` / `request_id`. Proposal: pass a JSON response schema to the provider call (`responseSchema` on the Gemini request in `brainExperimentOrchestrator.ts`) in which `objective_id` and `request_id` are `enum`s of the ids supplied in that run, `decision` is the three-value enum, and `cites[].ref` is a string. The prompt text is unchanged; the structural gate is unchanged (it still runs). This constrains the *form* at the source rather than teaching it in prose. Risk to name: a response schema may change the provider's sampling; the acceptance calls below read whether decision content moves against #623's A3 pattern.

Neither change is needed to run the dry render; both are needed before anything is mounted.

## 9. The smallest acceptance-call plan

Four calls, one per cell, no reruns, artifacts per call, nothing materialised. Each cell already has its exact prompt in `slice/dry/`.

| call | cell | establishes |
|---|---|---|
| 1 | **S0** — INIU as subject, no lines | what the Brain does with a real unanswered paid inbound on today's evidence: does it ask for terms, qualify, or invent a price from `commercialPosition` / floors; does it read the 201 detections as anything |
| 2 | **S1** — INIU with the projection | whether it grounds the same decision on `.absent` (price), `.unknown` (rights), `.completeness`, `.brand` and `.dealsRead`; whether it treats Deals' read as evidence or instruction; whether NOT_ESTABLISHED on value/basis/band produces a request or a made-up basis (the C2 failure of #623, on a real row) |
| 3 | **G0** — gorjana, the athlete's posting question, no lines | the K1 pattern on real rows: is the deliverables-recorded 0 read as "not known" (as the block says) or as "no obligations" |
| 4 | **G1** — gorjana with the projection | whether `.thread` (deadlines 24 Aug and 30 Sep, awaiting the athlete, 18 days idle) and `.contract` NOT_ESTABLISHED change the answer's grounding; whether the priced lines are used at all for a non-pricing question; whether the floor's `unit: NOT_ESTABLISHED` and the basis relationship are noticed (the #623 §12.1 pressure, on a real row) |

Read per §9.1 of the boundary checkpoint: source of commercial reasoning (raw / block / mixed / unsupported) and producer semantic status per claim, kept separate. If S1 requests terms grounded on `.absent` and `.unknown` and does not price, and G1 keeps the K1 answer while citing the projection where it bears, the slice is accepted at the experimental level. If S1 ignores the block and prices from State, or reads NOT_ESTABLISHED as zero, the projection's rendering needs work before mounting, not the Brain. Contract changes (a) and (b) are applied *after* these four, so their effect is attributable.

## 10. Facts that differ from #624's assumptions, and what this exposes

1. **An unanswered legitimate inbound has no subject in the Brain's envelope today.** The most common real case on the Explore screen (unreplied paid inbound) is unrepresentable as a Decision Request without the experimental `inbound` kind. Where that subject belongs for good — a work kind, a State inbound item with sub-paths, or an Opportunity — is an architectural decision for the next checkpoint, not made here. The slice uses the kind only for the request's subject; `existingWorkFrom` is unchanged and still never assembles detections.
2. **The "negotiating" rows are not reliable negotiations.** Seven exist; each has exactly one outbound reply, six are unpriced, one (TITAD) recorded the athlete's own counter as the offer. The slice does not treat them as real.
3. **The scorer asserts a per-post unit for the floor** in its economics note (from its prompt's wording); the data carries none. Quoted, not adopted.
4. **`deal_stage` is the only recorded provenance for `deals.status`**, and it is a model read; gorjana's `accepted` came from `"agreed"`. Rendered as such.
5. **Brand resolver misattributions** on three candidate threads (Public Records → Public Rec; Xingye → Finish Line; Wildthingsanalyzed → Wild Things). A `.brand` line on those threads would carry a confident, wrong row. Recorded with #621 §12's defects; not fixed; INIU's row is correct.
6. **`offer_struct.deal_type` is always the deal row's type**, so an `other` deal falls back to the socialPost rate silently; the projection now says so in `.basis` when it happens.
7. **Gorjana has no contract period and no deliverable rows** even as the one closed deal, so `.contract` is NOT_ESTABLISHED and "deliverables recorded: 0" on the only accepted item — the block says "a missing record, not a missing contract".

## 11. What changed in code (experimental, inert unless the flags are passed)

- `server/services/dealAssessmentProjection.ts` — `projectDealAssessment(rows)` (pure) and `loadDealAssessmentRows(db, dealId)` (read-only). Outside `intelligence/`.
- `server/services/dealAssessmentProjection.test.ts` — four cases; the DB module is stubbed because the mounted floor function's module loads the client.
- `commercialAssessment.ts` — `DEAL_PROJECTION_VERSION = "deal-assessment-projection/0.1.0-exp"`, a `projection` condition and its header.
- `contract.ts` — `EXISTING_WORK_VERSION = "existing-work/0.3.0-exp"`; `WORK_KINDS` + `inbound`, with its doc comment. `existingWork.ts` unchanged; its test reads the constant.
- `brainRun.ts` — `--projection <deal id>` and `--inbound-subject <deal id>`.

Unchanged: the Brain spec and gates (parity green), `existingWorkFrom`, State builder and contract, Deals, Rate, every table.

## 12. Requested approval

Approve the four acceptance calls as rendered (S0 → S1 → G0 → G1), and the two contract changes as *proposals to apply after* those calls. Or redirect the thread selection. Nothing runs until then.
