# Thin slice — the four acceptance calls (S0 · S1 · G0 · G1), 26 Sep 2026

**Status:** results recorded; nothing changed after the calls. The two proposed contract changes remain unapplied; the projection is not mounted; the `inbound` subject stays experimental; no Deals, Rate/floor, State, Campaign/Studio change; #608 and #570 untouched. Artifacts: `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/arm/<cell>/<cell>.json` (`{inputs, record}`; `S1.rows.json` / `G1.rows.json` are the rows the projection read). Model `gemini-3.5-flash`; total cost **USD 0.139**; nothing materialised.

**One incident, recorded:** the first invocation of S1 failed with `fetch failed` at the provider call — a network error before any response; no record, no output, no artifact except the pre-call rows dump. It was invoked once more and ran. No completed call was repeated. Dry-render checkpoint: `commercial-intelligence-thin-slice-dry-render.md` (#625).

**Headline.** The projection was consumed where it bore on the question and ignored where it did not, which is the result the review asked for — with one sharp failure inside it. **S1** read `.value` as *not stated* (never zero), then reached past the block's `basis NOT_ESTABLISHED` into State's unit-less social-post floor, adopted it as the basis for "1 video + bio link + copyright licence", and constructed the ask ("counter … starting at her $1,000 social post floor"): the reconstruction-and-HOW-leakage pair the two unapplied contract changes exist to stop, on a real row. S0 without the block requested the offer's terms and did not price. **G1** answered the posting question from `.thread` alone (the 30 Sep deadline, the thread stalled since 8 Sep, awaiting the athlete), requested what actually decides it (product received, creative approved), and cited none of the priced lines — the positive non-uptake the review named — but read "deliverables recorded: 0" as *zero completed*, the exact misreading the line's own caption forbids. Deals' read was cited by no run. The experimental `inbound` subject resolved and was cited cleanly; the Brain nonetheless called its counter `advances_existing_work` on a thing the statement says is not work in motion. Three of four sets were refused by the structural gate on identifier formatting (S1 partially: the three live decisions were well-formed, the request and deferred ids were not); G1 passed both gates.

---

## 1. Result matrix

| cell | inputs | gate | request answer | path · relation | commercial grounds cited |
|---|---|---|---|---|---|
| **S0** | INIU as `inbound` subject, no lines | refused (10 structural, all id formatting) | **REQUEST_INTELLIGENCE** — "brand identity, proposed partnership terms, and financial details … fully documented" (`connected`) | — | `work[INIU]` ("no recorded commercial terms, deliverables, or brand category"), `representation.floors[socialPost]` (as the yardstick "any inbound terms" will be compared to) |
| **S1** | S0 + the 14-line projection | refused (4: `request_id` and deferred id wrapped; the three `objective_id`s correct) | **RECOMMEND — counter** "with a commercial rate starting at her $1,000 social post floor and request clarification on product terms and usage rights" | direct_action · **advances_existing_work** → `work[INIU]` | `work[INIU].value` (cash and product not stated), `representation.floors[socialPost]`, `work[INIU].completeness` (tbd; the scorer's "$1,000 floor" note) |
| **G0** | gorjana, no lines | refused (10, id formatting) | **REQUEST_INTELLIGENCE** — "the accepted gorjana deal includes a contractually scheduled post or deliverable due during the week of 26 Sep" (`athlete`) | — | `work[gorjana]` ("term dates and deliverables not recorded"), `commercialPosition.activeRelationships` |
| **G1** | G0 + the projection | **OK** (0 structural, 0 grounding) | **REQUEST_INTELLIGENCE** — "Mia has received the gorjana products and approved the specific creative content for her first contractually required post" (`athlete`) | — | `work[gorjana].thread` (deadline 30 Sep; awaiting the athlete since 8 Sep), `work[gorjana]` ("0 deliverables … recorded as completed") |

Standing decisions in all four: Yuwa / positioning / audience all RECOMMEND · specialized_plan · new_work (S1's Yuwa chose `campaign`), none citing a commercial line. The Northlight overlay is absent in the slice, so positioning has no work to defer to and plans, as it did in R0/V3. Deferred StartX1: REQUEST_INTELLIGENCE in 4 of 4 (no unsupported resolution this time); S0 named `external`, the others `connected` / `athlete`.

## 2. The twelve things to record, per call

### Gate result
S0 refused, all ids wrapped. S1 refused on `request[S-agent]` and `deferred[…]` only — the three live ids were plain for the first time in a refused set. G0 refused, all wrapped. G1 clean. Zero grounding problems in four: `work[<id>].thread`, `.value`, `.completeness` and the inbound subject all resolved. Refused sets are read as refused sets.

### Decision · execution path
S0 REQUEST; S1 RECOMMEND · direct_action; G0 REQUEST; G1 REQUEST. The only recommendation (S1) chose the bounded step and attached it to the subject.

### Citations
Of the fourteen lines: S1 cited `.value` and `.completeness`; G1 cited `.thread`. Never cited in either: `.offer`, `.basis`, `.range`, `.band`, `.absent`, `.unknown`, `.risk`, `.brand`, `.contract`, `.dealsRead`, `.observed`. S1 did **not** cite `.absent` (price, timeline) or `.unknown` (rights) though its `not_seen` names "usage rights duration and product value" — the content of those lines reached the answer without the citation. S1 did not cite `.brand` (INIU · Tech Accessories · established) and did not mention the brand's category or tier anywhere; S0, lacking the line, explicitly requested "brand identity".

### `not_seen`
S1: "the specific usage rights duration and product value that INIU intends to provide" — decision-material, drawn from the block's content (rights mentioned, product not stated). G1: none on the request (a REQUEST carries the unknown in its proposition instead). Standing decisions: the usual capacity / budget-cycle items.

### REQUEST_INTELLIGENCE propositions
- S0: the offer's brand identity, terms and financials documented — appropriate for what S0 could see (nothing), `connected`.
- G0: a post contractually scheduled this week — correct epistemics ("term dates and deliverables not recorded" → verify before advising), `athlete`.
- G1: products received and creative approved for "her first contractually required post" — sharper, grounded in `.thread`; the proposition presumes a contractual requirement the block does not establish (`.contract NOT_ESTABLISHED`), the R5/S5/B0 pattern of a proposition that assumes its answer. `why_material` also reaches into execution ("direct her management to contact gorjana") as a conditional consequence — HOW at the edge of a REQUEST.

### Deals' read — followed, disagreed with, or unused
**Unused in both S1 and G1.** Neither cited `.dealsRead`; neither rationale mentions it. S1's *counter* and Deals' *negotiate* coincide in substance without reference; G1's question is not one Deals' read addresses. So the read was neither followed as an instruction nor argued with; on this run its presence had no observable effect. That is consistent with "evidence, not instruction" and gives no evidence yet on whether the Brain *understands* what the read is.

### Raw versus projection-derived reasoning (per commercial claim; §9.1 dimensions)

| run | claim | source of commercial reasoning | producer semantic status |
|---|---|---|---|
| S0 | terms unknown → request; floor as the future yardstick | raw evidence (State floors) — no producer present | — |
| S1 | cash and product not stated | **projection** (`.value`) — read as NOT_ESTABLISHED, not zero ✔ | coherent |
| S1 | the deal is tbd with no offer stated | **projection** (`.completeness`) | coherent; the scorer's note carries a per-post floor unit the data does not |
| S1 | counter at her USD 1,000 social-post floor for "1 video + 3-month bio link + copyright licence" | **raw evidence / Brain-derived** — the block said `basis NOT_ESTABLISHED`; the Brain chose `floors[socialPost]` as the basis itself and treated a video-plus-licence package as a social post | **new producer-semantic issue exposed**: with no established basis, the nearest unit-less floor becomes the basis by default; the scorer's "$1,000/post" note gave it a unit |
| S1 | "request clarification on product terms and usage rights" | **mixed** — the content of `.unknown` / `.absent` without citing them | coherent |
| G0 | deliverables and terms not recorded → cannot say if a post is due | raw evidence (the existing-work line) — correct reading of "not recorded" | — |
| G1 | deadline 30 Sep; stalled since 8 Sep; awaiting the athlete | **projection** (`.thread`) ✔ | coherent |
| G1 | "0 deliverables have been recorded as **completed**" | **projection misread** — the line says Nomila holds no deliverable rows; the block's caption says "0 … not that there are none" | misread by the consumer, not a producer fault |
| G1 | "her first contractually required post" | Brain-derived — `.contract` says NOT_ESTABLISHED | invented contractual requirement (mild) |

### Invented commercial semantics
S1: a social-post floor applied to a video-plus-licence package with no established basis (the #623 §12.1 pressure, now on a real row and in the *absence* of a producer basis rather than in the presence of a wrong one). G1: a "contractually required" post where no contract is recorded. Neither run priced from public evidence or from `demonstratedEconomics`; neither summed floors; neither used gorjana's economics for INIU.

### Execution HOW leakage
S1's `what` constructs the ask: "counter … with a commercial rate starting at her $1,000 social post floor" — a figure and an opening position. This is exactly what contract change (a) targets, and it confirms the review's qualification: the figure cited is *an existing floor*, not a computed counter, so a currency regex alone would refuse it for the right reason by accident; the production invariant is "the Brain does not construct or propose the execution amount", and here the construction is the adoption of the floor *as the opening ask*, not arithmetic. G1: "direct her management to contact gorjana" inside `why_material` — a conditional execution step, minor.

### NOT_ESTABLISHED / UNKNOWN / missing records
- **Not zero:** S1 read `.value NOT_ESTABLISHED` as "lacks explicit monetary or product compensation details" ✔.
- **Basis NOT_ESTABLISHED:** not respected — substituted (above).
- **Rights UNKNOWN / mentioned:** S1 asked for "usage rights duration" — treated as unknown and material ✔, without asserting the sheet omitted them ✔, without citing `.unknown`.
- **Exclusivity UNKNOWN:** not mentioned by S1 in either direction (not requested, not asserted). Neutral.
- **Brand evidence:** S1 did not use `.brand`; S0 had asked for it. A regression in uptake, not in epistemics.
- **`.contract NOT_ESTABLISHED`:** G1 did not cite it and then presumed a contractual requirement — the line was not enough to prevent the presumption.
- **"deliverables recorded: 0":** G0 read it correctly as *not recorded*; G1 read it as *none completed*. Same words, two readings, one call each.

### The experimental `inbound` subject
Resolved as `work[<id>]`, cited in both S0 and S1, named in `advances`; the request's `about` validated; grounding clean. **One contamination:** S1 classified its counter as `advances_existing_work` and the answer's `why` calls countering "the standard commercial step required to advance negotiations" — the Brain treated a never-answered inbound as a negotiation in motion because it sat in the EXISTING WORK block, despite the statement "Not work in motion". The subject mechanism worked as a *door*; rendering it inside existing work leaked the block's semantics onto it. This is evidence for the taxonomy decision the review deferred, not a decision.

## 3. Reading against the review's questions

**S1.** Price NOT_ESTABLISHED, not zero ✔. Rights mentioned, terms unknown ✔ (uncited). Exclusivity UNKNOWN — silent. Brand evidence — unused ✘. Deals' read as evidence not instruction — unused (neither). Materiality decided ✔ (rights and product value named as the unknowns that matter). If requesting, the decision-material items — it did not request; it recommended a counter and put the unknowns in `not_seen`, which under 1B.1's reading is the S3 failure (acting while the premises are unknown) in mild form. Invented rate from State ✘ (the social-post floor as basis). Constructed the ask ✘.

**G1.** `deliverables recorded: 0` understood as no rows ✘ (misread as none completed). `.thread` helped ✔ (the whole answer turns on it). `.contract NOT_ESTABLISHED` epistemically respected — partially (not cited; a requirement presumed). Did not turn the question into pricing ✔ (no `.band`, `.range`, floor, or economics anywhere in the answer — the strongest positive result of the run). Identified the missing obligation information ✔ (scheduled post, product received, creative approved), source `athlete` ✔.

## 4. Architectural findings

1. **A missing basis is filled from State.** When Commercial Intelligence says `basis NOT_ESTABLISHED`, the Brain does not stop; it takes the nearest floor from State and prices with it. In #623 the failure was a wrong producer basis adopted silently; here it is *no* producer basis and a State floor adopted silently. The invariant this asks for is not "supply a basis" but "when no basis is established, the Brain must request one (or decline to price), not derive one" — a Brain-contract rule (it belongs with the NOT_ESTABLISHED rule named in #623 §12.2), and a reason the unit-less floors in State are a hazard wherever they are rendered. Not fixed.
2. **The execution amount leaks as an opening position, not as arithmetic.** S1 did not compute; it adopted. Contract change (a) must be written as the review said — *the Brain does not construct or propose the execution amount* — and the regex kept as a Gate-1 backstop that will catch this case by coincidence, not by definition.
3. **"deliverables recorded: 0" is ambiguous to the consumer** even with the caption. G0 read it right, G1 read it wrong. The line should say what it means in the value, not only in the caption ("Nomila holds no deliverable rows for it; obligations unknown"), and the Brain's misreading is a consumer fault to record, not a producer one.
4. **The inbound subject works as a door and misleads as a work item.** Rendering a detected, unanswered inbound under EXISTING WORK gave the request a citable subject with clean grounding, and it also made the Brain call its answer "advancing existing work". The durable home for a commercial opportunity that is neither work nor an Objective is the taxonomy decision the review deferred; the evidence now says: not inside the existing-work block as it stands.
5. **Decision-relative use held.** G1 used one of fourteen lines and the right one; S1 used the two that bore on "what is on the table" and none of the economics lines (all NOT_ESTABLISHED). Maximum-field consumption did not happen and was not wanted.
6. **Deals' read had no observable effect.** No citation, no agreement, no disagreement, in either run where it was present. Whether the Brain understands it as a read is untested by this pair; a thread where Deals' read and the Brain's broader context plausibly diverge (a high-fit deal that conflicts with an Objective or an existing relationship) is what would test it.
7. **Brand evidence was dropped once it was present.** S0 asked for brand identity; S1, holding a researched row (Tech Accessories, established), used none of it. Either the line's position (eleventh of fourteen) or its relevance to a price-less counter; one run cannot say which.
8. **Identifier formatting refusals continue** (3 of 4 sets; 10 of 18 across #623 and this run). Contract change (b) is the fix and remains unapplied by instruction.
9. **The schedule-gap conversion recurred** in S0 and G0 standing decisions ("19-day gap … capacity", "quiet competitive window … capacity") and not in S1/G1. Logged, as before; unrelated to the projection.

## 5. Not done

No contract change applied (both stay proposals; (a) to be reworded to the execution-amount invariant per the review). Projection not mounted. `inbound` not promoted. No Deals, Rate/floor, State, Campaign/Studio change. No rerun. #608 and #570 untouched. Four artifacts, USD 0.139.
