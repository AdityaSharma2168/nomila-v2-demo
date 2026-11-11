# M.I.A. Beta.2 Stage 2 — authoritative commercial block (design record)

**Status:** design record, rescoped 30 Sep 2026. Not scheduled or implemented. No code, prompt, schema, flag or
provider change comes with it. It does not block Concept 0.4 Slice 1 or Slice 2.
**Constrained by:** `research-acquisition-architecture.md` (#709) §10 and decision **D12**, LOCKED 30 Sep 2026. This
record is the "Stage 2 — authoritative commercial block" that §10.2 names. Where this record and #709 disagree, #709
wins and the difference is reported, not resolved here.
**Deal authority:** the fact-specific rule in PR #714 (`docs/709-deal-authority-correction`, open at the time of
writing). Its text is used verbatim in §4.2.
**Continues:** `step4-evaluator-service-design.md §0`, which names canonical evidence "a deliberate Beta.2 question".
**Baseline:** origin/main `b50c5ddd` (30 Sep 2026). Line numbers are at that commit.
**Marks:** **V** = verified in code at the cited line · **D** = stated in a repo doc · **I** = inferred.

---

## In plain words

**What the athlete experiences today.** Nomila's marketability score (M.I.A.) reads about her on the public web. It
never sees what she has told Nomila about her own deals, or the contracts she uploaded. An athlete with a real, signed
partnership that was never announced can therefore score low on Commercial Proof. Closing a deal does not update the
score either.

**What changes with Stage 2.** Once Nomila is sure who she is (Stage 1), her confirmed deals are shown to M.I.A. as
labelled evidence: "this brand, this status, she confirmed it", or "this brand, these terms, from her contract".
M.I.A. still decides what those deals mean for her marketability. A newly confirmed deal can trigger a fresh
evaluation.

**What does not change.** Connecting her inbox earns no points. Having no private deals on file costs her nothing.
Nothing M.I.A. concludes is written back into her deals or facts. Her goals, preferences and direction never reach the
score.

**The mechanism, in one line.** A new digest-pinned evaluator version receives one additional supplied block, the
**commercial block**, under the admission contract in §4. It enters the snapshot digest, is gated on resolved identity,
and is measured against Beta.1 before it can replace it.

**The governing rule:** ADR-011 governs (decision D-1, §3). Real, verified commercial outcomes may inform Commercial
Proof only through this admission contract; Nomila's own predictions never feed M.I.A.

---

## 1. Where Stage 2 sits (#709 §10.2, §12 step 4, D12)

| Stage | What M.I.A. is given | Status |
|---|---|---|
| **Stage 1 — identity anchor** | athlete-confirmed identity only | **prerequisite** for Stage 2 |
| **Stage 2 — authoritative commercial block** | confirmed deals and partners (this record) | design |
| **Stage 3 — identity-resolved canonical evidence** | the broader canonical-evidence envelope | **EXPERIMENTAL**; must not be assumed better |

- Each stage is its own digest-pinned spec version and is compared with Beta.1 on the §10 metrics before it replaces
  anything.
- The first draft of this record put deals first. That order is **withdrawn**: Stage 2 follows Stage 1.
- Why the order matters, beyond being locked: supplying authoritative private deal brands next to a public search that
  may land on a namesake mixes her real commercial record into another person's profile. Stage 1 removes that risk.

## 2. Current behaviour (verified at `b50c5ddd`)

- **Supplied inputs:** name, sport and the connected social block (`marketabilityBeta1Snapshot.ts:126-173`) (V). The
  social block carries account metrics only, with no sponsored-post, paid-partnership or brand fields.
- **Its own research:** Gemini with Google Search (`marketabilityBeta1Evaluator.ts:222`) (V). The frozen spec
  (`blind-eval-spec/0.2.1`, canonical digest `167e6c50…`, `marketabilityBeta1EvaluatorSpec.ts:432,511`) (V) instructs it
  to research identity, team, achievements, national team, media, story, endorsements and brand safety.
- **Snapshot digest:** `{name, sport, socialBlock}` only (`marketabilityBeta1Snapshot.ts:86-89`) (V).
- **Not consumed:** `athlete_facts`, `research_evidence`, `athlete_affiliations`, `athlete_asserted`, `deals`,
  uploaded contracts, and the Canonical Athlete Context (#709 §1.5). A facts-reading path exists only as a withdrawn
  shadow (ADR-017: Spearman 0.08 vs 0.887), and the discovery branch that once read research handles is dormant (#709
  R1).
- **Deals reach M.I.A. only if public.** Public mentions of a deal reach it through its own web research; Nomila's deal
  records never do. Commercial Proof's signals (verified commercial value, deal frequency, brand quality,
  renewals/repeat, campaign performance, pricing power) are filled from whatever the search finds. Example: Mia's
  Commercial Proof is 69, citing a single 2023 article and "sparse evidence of secondary sponsorships", while an
  `accepted` $14K deal sits in Nomila unread. This is consistent with #709 §7 (endorsements = duplicated evidence;
  commercial demand = M.I.A.-only judgement).
- **No deal-driven re-scoring.** `TRIGGER_REASONS` is `IDENTITY_RESOLVED`, `SOCIAL_BLOCK_CHANGED`,
  `USER_REQUESTED_REFRESH`, `ADMIN_REQUESTED_REFRESH` (`marketabilityBeta1Snapshot.ts:31-36`) (V). A deal being accepted,
  a contract uploaded, a deal mined from the inbox or a fact corrected triggers nothing. `RESEARCH_REFRESHED` is
  recorded and ignored (`definitions/researchRefresh.ts:66-74`) (V).
- **The legacy display score counted earned deals** (`scoringService.ts:522-523`) (V). Legacy is **frozen at cutover**
  (O5, decided) and always excluded from M.I.A. input (#709 §9.5, §10.1). It is not a bridge for deal-awareness: after
  cutover, neither score reflects new deals until Stage 2 lands.
- **Deal status vocabulary.** `deals.status ∈ {detected, pending, negotiating, accepted, completed, rejected}`
  (`schema.ts:247`) (V). There is no "confirmed" or "closed" status. "Earned" in code means `accepted` or `completed`
  (`snapshotDeals.ts:26`) (V). `accepted` can be written by `threadSummarizer` from its own reading of an email thread,
  with no human involved (`snapshotDeals.ts:111-116`) (V). Status alone therefore does not mean "she confirmed it".
- **Deal source vocabulary.** `deals.source ∈ {inbox_scan, self_reported, contract_upload, api, public_profile,
  outbound_agent}` (`schema.ts:248`) (V). Code treats `contract_upload` and `self_reported` as athlete-confirmed
  (`ATHLETE_CONFIRMED_SOURCES`, `snapshotDeals.ts:38`) (V). The deck's confirmed-partner list uses exactly that bar
  (`confirmedPartnersFor`, `snapshotDeals.ts:103-117`; Step 2d D7) (V).

## 3. ADR-011 vs `rate-v0-design.md` — **DECIDED (D-1): ADR-011 governs**

### The passages, exactly (as they stood before this PR)

ADR-011, Blueprint v1 Part XV decision log (`commercial-intelligence/product-intelligence-blueprint-v1.md:825-828`),
status LOCKED:

> ADR-011 · LOCKED · Verified commercial outcomes may inform Commercial Proof; Nomila's own predicted rate/value does
> not feed MIA. · Prevents circularity while rewarding real market proof.

`commercial-intelligence/rate-v0-design.md:137` (§5.4 MIA):

> Commercial outcomes may calibrate Rate. **Commercial outcomes must never feed back into MIA scoring** (ADR-011).

`commercial-intelligence/rate-v0-design.md:1548` (end of §12.7, Rate learning):

> **Rate learning never feeds commercial outcomes into MIA scoring** (ADR-011).

How rate-v0 defines the word it uses (`rate-v0-design.md:31,35`):

> `RATE         what should I generally charge?` …
> `OUTCOME      what actually happened`

Restatements elsewhere on main:
- `SUPERSEDED.md:145-146` ("Decisions that held"): "Nomila's own predicted rate or value must never feed MIA, while
  verified commercial outcomes may inform Commercial Proof."
- `ADR-017-evaluator-owns-qualitative-judgment.md:78-79`: "Nomila's own predictions still never feed MIA (ADR-011)."
- `intelligence-architecture-principles.md:128-130` (P-7): "a system that learns from the deals it caused is confirming
  itself. ADR-011 blocks that loop through the score".
- `product-intelligence-blueprint-v1.md:6-7`: "ADR-011 (Nomila's own predictions must not feed MIA)".

### Reading

1. **ADR-011 draws exactly the predicted-vs-observed line.** Its first clause admits *observed* outcomes ("verified
   commercial outcomes may inform Commercial Proof"). Its second clause excludes *predicted* values ("Nomila's own
   predicted rate/value does not feed MIA"). Every other restatement on main is consistent with that line.
2. **rate-v0 does not use that line.** `:137` excludes "commercial outcomes", and rate-v0's own vocabulary defines
   OUTCOME as "what actually happened" (`:35`): the *observed* side. It does not say "predicted rates", "Rate estimates"
   or "Nomila's values". Read literally, it forbids what ADR-011 permits, while citing ADR-011 as its authority.
3. **So the predicted-vs-observed distinction does not, by itself, dissolve the conflict.** Both passages are about the
   same thing — observed commercial outcomes reaching M.I.A. — and reach opposite conclusions as written.
4. **A narrower reading of rate-v0 is possible but not stated.** `:1548` is scoped to "Rate learning", and `:137`
   follows "Commercial outcomes may calibrate Rate" in a section about Rate consuming M.I.A. Under a *channel* reading,
   rate-v0 forbids outcomes reaching M.I.A. **through Rate's calibration loop** (an outcome paired with a Rate estimate
   flowing on into the score), which is the circularity ADR-011 and P-7 guard against. It would then say nothing about
   M.I.A. receiving a confirmed deal as direct evidence, and the two would agree. But `:137` carries no such scope in its
   words, so adopting that reading is a decision, not an interpretation.

**Finding: genuinely semantic as written.** The candidate distinction (predicted vs observed) is ADR-011's own line,
and rate-v0 put observed outcomes on the forbidden side. A channel reading could reconcile them, but the text did not
say it, so it was put to the user rather than resolved by assumption.

### Decision (user, 30 Sep 2026)

**ADR-011 governs.** Reasoning:
- ADR-011 is a LOCKED decision, and rate-v0 cites it as its own authority, so rate-v0 cannot be broader than it.
- Every other restatement on main (SUPERSEDED, ADR-017, the Blueprint header, P-7) reads ADR-011 as
  "predictions out, verified outcomes in".
- The circularity ADR-011 and P-7 guard against runs through Nomila's predictions and Rate's learning loop, not through
  a real, confirmed deal supplied as labelled evidence that M.I.A. interprets.

**Amendment in this PR.** `rate-v0-design.md:137` and `:1548` are narrowed, as a clarification of the Rate-learning
boundary consistent with ADR-011. The governing statement at `:137` (§5.4) is now:

> Rate Intelligence and M.I.A. may consume governed real-world commercial evidence independently under their
> respective admissibility rules. M.I.A. outputs may inform Rate Intelligence as marketability context, but Rate
> outputs, learned pricing parameters, and Nomila-predicted rates or values never feed back into M.I.A.
>
> Real commercial outcomes are observations, not Rate outputs. Their use by M.I.A. is governed by M.I.A.'s
> evidence-admission contract; their use by Rate is governed by Rate Intelligence's own evidence and learning
> contract.
>
> Outcomes admitted to M.I.A. enter as evidence only; they do not supply a score, signal value, or marketability
> interpretation.

`:1548` (§12.7) becomes the consistent one-liner: "Rate learning outputs, learned pricing parameters and
Nomila-predicted rates/values never feed into M.I.A. (ADR-011); real commercial outcomes reach M.I.A. only as
observations under M.I.A.'s evidence-admission contract."

This record **is** M.I.A.'s evidence-admission contract for commercial outcomes (§4).

rate-v0 deliberately does not restate today's per-fact rules. They live **only** in this record's admission contract
(§4.2). Under it, "verified" is per fact and is not independent third-party verification:
- **deal existence / status:** athlete confirmation is sufficient (explicit confirmation or self-report, or a contract
  she provides);
- **terms:** only through the verified deal-record concept (D-4), and not supplied until it exists;
- **marketability meaning:** neither source determines it; M.I.A. interprets.

**Consequence.** Nomila's own **predicted** rates and values never enter the block (§4.5).

**Nomila-originated deals (`source = outbound_agent`) — D-2: excluded for Stage 2.** Their *existence* is observed, but
Nomila caused them (P-7: learning from deals it caused "is confirming itself"), and their *terms* may embed a price
Nomila proposed from its own Rate estimate. The exclusion is a **validation-stage anti-feedback-loop safeguard**, not a
claim that these real outcomes are invalid evidence. It is revisited empirically once Stage 2 has validation data.

## 4. Supplied-block admission contract — the commercial block

The five fields #709 §10.1 requires (classes, minimum authority, identity, freshness, exclusions), plus dedup and
exposure.

### 4.1 Admitted classes

Deals for this athlete with `status ∈ {accepted, completed}` that meet the minimum authority in §4.2, with their
contract evidence where it meets the terms bar. Each supplied item carries:
- brand (`brand_id` / `brand_name`), `deal_type`, `status`;
- an **authority label** for existence (§4.2), and a separate terms label only where the terms bar is met;
- terms (`amount`, `amount_cash`, `amount_product`, `term_start`, `term_end`) **only** where §4.2 allows them;
- the deal group id and the as-of time (§4.4).

Labels are preserved per item and never flattened into one generic "confirmed commercial" class (#709 §10.1).

### 4.2 Minimum authority, per fact (PR #714 rule)

This contract is the **only** place today's per-fact rules live; `rate-v0-design.md` refers to "M.I.A.'s
evidence-admission contract" without restating them. "Verified" is per fact:

| Fact | Authority order (#714) | Admitted in Stage 2 |
|---|---|---|
| Deal existence / status | signed or verified contract evidence > athlete-confirmed deal > inbox-detected deal > public evidence | **athlete confirmation is sufficient**: explicit confirmation or self-report, or a contract she provides (today `source ∈ {self_reported, contract_upload}`, `snapshotDeals.ts:38`). Inbox-detected deals are **excluded until athlete-confirmed** (D-3). Public evidence is not supplied: M.I.A. finds it itself |
| Terms (amounts, deliverables, dates) | the contract / verified deal record is authoritative over inference and self-report | **only through the verified deal-record concept** (D-4), and **not supplied until it exists**; every item is supplied for existence only |
| Marketability meaning | none of these sources | **neither source determines it; M.I.A. interprets** |

- "Verified deal record" has no schema representation today, and `contractExtract.ts` output is a proposal until
  reviewed (#709 §5.3). A `contract_upload` row is therefore athlete-confirmed existence, not verified terms (D-4).
  Designing the verified deal-record concept is follow-up work (§14.2).
- The authority rule covers **whether a deal exists and its terms**, never what it means for marketability.

### 4.3 Identity prerequisite

**`identity_resolution = resolved` is required.** Once the lifecycle flag is on, no evaluation with the commercial
block runs against an unresolved or ambiguous identity (#709 invariant, R-a). Deal-event triggers that arrive earlier
are deferred and coalesced, like `SOCIAL_BLOCK_CHANGED`; the mechanics are implementation design.

### 4.4 Freshness carried into `evidenceAsOf`

- The block contributes its own as-of time to the snapshot's `evidenceAsOf`, which today is derived from social
  sources only (`marketabilityBeta1Snapshot.ts:173`) (V).
- A deal's as-of is its latest status or confirmation time. `deals` has `detected_at` and `created_at` but no
  status-change timestamp (`schema.ts:184-243`) (V); the source of that time is **NEEDS-DESIGN**. No column is proposed
  here.

### 4.5 Exclusions

**Always excluded (#709 §10.1):** direction / preferences, objectives, legacy score, `story_arc`, M.I.A.'s own prior
outputs (ADR-011) and web follower counts.

**Also excluded by this block:**
- **Nomila's own predicted rates and values** (ADR-011): rate-card amounts, Rate estimates, suggested asks and
  counters, `negotiation_state`, `pending_action`.
- `outbound_agent` deals (D-2; validation-stage safeguard).
- `detected`, `pending`, `negotiating` and `rejected` deals.
- `inbox_scan` deals she has not confirmed (D-3); `api` and `public_profile` sources (no defined authority; public
  evidence is M.I.A.'s own to find).
- All terms, until the verified deal-record concept exists (D-4).
- `payment_status`, `deposit_status` and `commission_pct`: payment mechanics and contingent value, not evidence of the
  relationship.
- Raw inbox text and `raw_data`.

### 4.6 Dedup by deal group

One underlying deal can span several email threads and therefore several `deals` rows. The block is supplied **one item
per deal group** (`deal_group_id`; NULL = the row is its own group, `schema.ts:239-243`) (V). Within a group, existence
takes the highest-authority member and terms come only from a member that meets the terms bar. Without this, "deal
frequency" and "renewals/repeat" are inflated by thread count (the cross-thread grouping gap).

### 4.7 Exposure: privacy inheritance (preserved)

**A derived output inherits the most private input class.** An assessment evaluated with private deal evidence is
itself private-class wherever it, or a rationale quoting it, could reach a brand-facing surface. Nothing in #709
contradicts this. Privacy inheritance is to be added as the sixth §10 admission-contract field (#709 follow-up; D-6).

## 5. Evidence, never values

- The block is **evidence, not deterministic signal values** (#709 §10.2, D12). No per-signal number, floor, bonus or
  mapping is derived from it. This keeps closed the facts→sub-signal path ADR-017 withdrew (Spearman 0.08).
- It is **never a score override**. M.I.A. remains the judge of Commercial Proof and of every other dimension.
- Commercial Proof is where the evidence is expected to matter. It is not an admission gate: M.I.A. is one holistic
  call, and any dimension guidance is evaluator text inside the pinned spec.

## 6. Conflicts (preserved, rescoped)

- **A confirmed deal vs contradictory public claims.** The deal's authority covers **existence and terms only**: a
  contract outranks web research on whether the relationship exists and what it says. What it means for marketability
  is M.I.A.'s judgement.
- **M.I.A. vs canonical:** never reconciled into facts. A disagreement is a review signal (#709 §9.2).

## 7. ADR-002 and missingness (preserved)

ADR-002: "Connected social is an accuracy/confidence event, not a scoring bonus" (Blueprint `:789-792`). Applied to
deals:
- **Connecting the inbox can't be a scoring bonus.** The presence of the block must not mechanically add points.
- **Missing private deals mustn't count against her.** An athlete with no supplied deals is evaluated as Beta.1
  evaluates her today, from public evidence. The canonical text carries a **no-commercial-block fallback line** (like
  the social block's) stating that no Nomila deal records were supplied and that this is not evidence of absence.

## 8. No write-back

No write-back from M.I.A. into `deals`, contracts or canonical facts at any stage (#709 §10.4, Approved core).

## 9. Spec version and digest

- Stage 2 is a **new, separately pinned spec version** with its own canonical-text SHA-256. Provisional name: the
  version after Stage 1's (Stage 1 is planned as `blind-eval-spec/0.3.0` in `docs/plans/mia-identity-anchoring.md`),
  i.e. `0.4.0`. The name is fixed when Stage 1 lands.
- **The commercial block enters `snapshotDigest`** (#709 §10.5). The snapshot row gains the block (additive).
- The goldens are **re-baselined** and the guards in `marketabilityBeta1Freeze.test.ts` move deliberately, through the
  full ceremony (amend → bump → unpin → parity → exact-text review → repin). Beta.1 stays pinned as the comparison
  baseline.

## 10. Triggers

- **New trigger reasons:** deal confirmation (a group reaches the §4.2 existence bar, or moves between `accepted` and
  `completed`) and contract verification (a group reaches the terms bar). Exact names are implementation design.
- **Material change = the commercial block's digest changes.** An unchanged digest hits the existing digest skip;
  bursts hit the existing 10-minute debounce (#709 §9.2).
- **Behind the identity invariant:** once the lifecycle flag is on, no deal-triggered evaluation runs on an unresolved
  identity (§4.3).
- **`RESEARCH_REFRESHED` is not a trigger** in Stage 2. It stays recorded and ignored until Stage 3 (#709 §10.5).

## 11. Freshness (D6)

Event-driven invalidation (§10) **plus a maximum-age policy. No number is set here** (D6; #709 §10.6).

## 12. Validation and exit

Stage 2 replaces Beta.1 only after a **measured comparison against Beta.1** on the #709 §10 metrics, on dev37 and
later cohorts:

| Metric | Measured as |
|---|---|
| Ranking / correlation | Spearman vs the reference set (Beta.1 = 0.887) |
| Identity correctness | wrong-namesake rate (needs labelled identity ground truth) |
| Grounding / support | share of cited evidence actually retrieved (#706) |
| Unsupported claims | claims with no retrieved support (#706/#708) |
| Coverage | MISSING count of 44 |
| Stability | variance across repeated runs per athlete (temperature 1.0, so repeats are required) |
| Latency | `mia_evaluation_runs.latency_ms` |
| Cost | **measured** `usage.searchCalls` (`marketabilityBeta1Evaluator.ts:247`) plus tokens; dollars **provisional** until Vertex pricing is reconciled (O3) |
| Novel-evidence yield | useful evidence M.I.A. finds beyond what was supplied, per search; analysis only, never a scoring input |

**Telemetry requirement** (#709 §10.3), recorded per run from Stage 2 on: provider calls and `searchCalls`, latency
and cost; supplied evidence volume **by block and authority label**; newly discovered (not supplied) evidence; grounded
vs unsupported citations; evaluation result and spec digest.

**Fallback.** Supplying the commercial block does **not** narrow M.I.A.'s own research. **Broad M.I.A. research is
retained** if Stage 2 fails to match or improve on Beta.1, and Beta.1 stays the methodology. Breadth is revisited only
by the Stage 3 experiment.

Running the comparison spends provider money and needs founder approval at the time.

## 13. Minor policy

M.I.A. has no minor policy (#709 §10.7). Deal evidence for a minor follows that separate methodology decision once it
is made.

## 14. Decisions

### 14.1 Decided (user, 30 Sep 2026)

| # | Decision | Where |
|---|---|---|
| **D-1** | **ADR-011 governs.** Rate Intelligence and M.I.A. each consume governed real-world commercial evidence under their own admissibility rules. Real commercial outcomes are observations, not Rate outputs, and reach M.I.A. only under this evidence-admission contract, as evidence only. Rate outputs, learned pricing parameters and Nomila-predicted rates or values never feed back into M.I.A. `rate-v0-design.md:137,1548` amended in this PR as a clarification of the Rate-learning boundary | §3 |
| **D-2** | `outbound_agent` (Nomila-originated) deals are **excluded for Stage 2**, as a validation-stage anti-feedback-loop safeguard. Not a claim that those real outcomes are invalid evidence; revisited empirically later | §3, §4.5 |
| **D-3** | Inbox-detected deals are **excluded until athlete-confirmed** | §4.2, §4.5 |
| **D-4** | Terms require a **verified deal-record concept**; until it exists, **no terms are supplied** | §4.2, §4.5 |
| **D-5** | **No exception**: Stage 1 (identity) precedes Stage 2, per D12 | §1 |
| **D-6** | Privacy inheritance is **approved**. It is to be added as the sixth §10 admission-contract field in a separate, narrow #709 follow-up after #714 merges, not in this PR | §4.7 |

### 14.2 Still open / follow-up

- **Verified deal-record concept (from D-4):** what makes a deal record "verified" for terms, given contract extraction
  is a proposal until reviewed. Needs its own design; until then no terms are supplied.
- **#709 follow-up (from D-6):** add privacy inheritance as the sixth §10.1 field, after #714 merges.
- **D-2 revisit:** the empirical test for re-admitting Nomila-originated deals, once Stage 2 has validation data.
- **Deal as-of time (§4.4):** where a deal's status/confirmation time comes from (NEEDS-DESIGN).
- **Deal status/category vocabulary map:** open debt. This record uses the schema values and invents no new status.

## Related work

- **#709** (LOCKED, on main): §10 and D12 constrain this record.
- **#714** (open): fact-specific deal authority rule, used in §4.2.
- **#702** (merged): per-signal rationale, confidence and MISSING status survive into the ledger.
- **#706** (merged, b907c073): explicit evidence strength per citation (`intelligenceLedger.ts:91-99`) plus State
  1.5.0 — `grounded`, `site_only`, `nomila_supplied`, `not_support` (asserted or unsupported: never support), and
  `unrecorded`, which means **historical lineage absence** (citations saved before lineage existed), **not**
  unsupported; it keeps its #706 treatment and stays in `citedEvidence` as legacy (`state/build.ts:278-282`).
  Commercial-block citations would classify as `nomila_supplied`.
- **#708** (merged): documents the M.I.A. grounding limitation.
- **Stage 1:** `docs/plans/mia-identity-anchoring.md` (draft plan; needs an ADR-017 amendment as a founder decision).
