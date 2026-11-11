# Evaluator → Ledger → State: the contract

**Owner:** Mia
**Date:** 2026-09-21
**Status:** Architecture note. Nothing implemented.
**Decides:** what an evaluator must persist, what the Intelligence Ledger must carry, and what Athlete State may therefore be.

---

## 1. The root cause, and it is not a missing design

`contracts/commercial.ts` **already specifies** what a marketability dimension must carry:

```ts
export interface MarketabilityDimensionResult {
  dimension: string;
  score: number;
  confidence: ConfidenceLevel;
  /** Why the evaluator judged this dimension as it did. Persisted with the judgment; never regenerated alone. P-6. */
  rationale: string;
  confidenceRationale: string;
  materialGaps: string[];
}
```

The orchestrator writes something else:

```ts
value: {
  score, composite, confidence,
  dimensions: result.dimensions,   // score · weight · signals · confidence · contribution — NO rationale
  drivers, summary, overallConfidence, identityConfidence, importantMissingData,
}
```

**And nothing catches the divergence, because `commercial.ts` has zero importers.** That was the headline of the repo audit in #542, recorded then as a dead contract. It turns out to be the direct cause of the PR2 failure four steps later:

```
commercial.ts declares rationale, and is imported by nothing
  → the orchestrator writes dimensions without it
    → M.I.A.'s real rationale is stranded in mia_evaluation_runs.judgements
      → the ledger row State reads has no rationale
        → State projects score + band only
          → Opportunity reconstructs "Stanford scholar-athlete" from the word Stanford
```

So this is not a gap in the architecture. **It is an implementation that never conformed to a contract nothing enforced.**

---

## 2. What is lost, and where

M.I.A.'s `judgements` carries **eleven** keys. The ledger keeps **four** of them plus the scoring layer's `dimensions`.

| `judgements` key | in the ledger? | what it holds |
|---|---|---|
| `summary` | ✅ | headline prose |
| `overallConfidence` · `identityConfidence` | ✅ | `{level, explanation}` |
| `importantMissingData` | ✅ | → State `materialGaps` |
| **`dimensionAssessments`** | ❌ | **per-dimension `{prose, confidence, confidenceReason}`** |
| **`evidence`** | ❌ | **`E1…En` — claim, sourceUrl, sourceType, sourceTitle, date** |
| **`keyStrengths`** · **`keyConstraints`** | ❌ | the evaluator's own summary of what matters |
| **`identityOrEvidenceRisks`** | ❌ | what could make this assessment wrong |
| `judgements` · `summaryWords` | ❌ | raw per-signal output, length control |

Second loss, one layer down: the ledger's `dimensions[].signals` **is** present, and **State discards it**. `narrative_power = 88.65` is really `distinctiveness 92 · media_resonance 85 · evidence_authenticity 90 · commercial_applicability 88`, each with its own `evidenceIds`.

**Both losses are silent and neither is recorded as a decision.**

### What the discarded material actually says

`dimensionAssessments.narrative_power` for one athlete, present in the run table today:

> *"…centering on her pioneering status for South Asian representation in soccer and her deep commitment to empowering young girls globally through her partnership with the Yuwa academy in India… she graduated high school early and is finishing a Master's degree in engineering."*
> `confidence: HIGH` · `confidenceReason: "widely documented, authentic, and consistently validated across multiple independent media sources."`

Every element Opportunity invented was already written down, at HIGH confidence, with four cited sources.

---

## 3. The three designs

### A · Widen the ledger value

Persist the evaluator's findings, rationale and cited evidence directly in `value`.

| | |
|---|---|
| provenance | ✅ one row carries judgment and its reasons |
| immutability | ✅ unchanged — rows still never update in place |
| replay | ✅ `evaluation_run_id` still reaches the full artifact |
| genericity | ⚠️ only if the shape is generic, not M.I.A.-shaped |
| token cost | ⚠️ ~5 KB per row; a reader takes it all or nothing |
| coupling | ✅ **State reads the ledger and nothing else** |
| duplication | ⚠️ rationale exists in both run and ledger |
| citation | ✅ |
| `EVALUATED` ownership | ✅ owner travels with the value |
| migration | ✅ pure backfill from runs, no provider cost |
| evidence vs interpretation | ✅ if the shape separates them |

### B · Artifact reference

Ledger carries the normalised finding plus a stable reference to an evaluator-owned artifact; State projects through a generic artifact contract.

| | |
|---|---|
| provenance | ✅ |
| immutability | ⚠️ two objects that can drift |
| replay | ✅ |
| genericity | ✅ strongest — every evaluator implements one interface |
| token cost | ✅ smallest ledger |
| coupling | ❌ **State resolves engine-specific artifacts — the thing we are trying to avoid** |
| duplication | ✅ none |
| citation | ✅ after a second read |
| migration | ✅ nothing to migrate |
| evidence vs interpretation | ✅ |

**This is essentially what exists today** — `ledger → evaluation_run_id → run → snapshot` — and it is what failed. Not because the link is missing, but because **no generic contract exists over it, so nobody projects it.** Choosing B means building that contract and accepting State reaches through it.

### C · Hybrid — recommended

Decision-critical structure in the ledger: findings, sub-signals, confidence, concise rationale, and the evidence each finding **cited**. The complete artifact — the snapshot, every retrieved chunk, the provider envelope — stays attached by `evaluation_run_id`.

| | |
|---|---|
| provenance | ✅ |
| immutability | ✅ |
| replay | ✅ full artifact still reachable |
| genericity | ✅ generic finding shape; domain payload inside |
| token cost | ✅ bounded by what was cited, not by what was retrieved |
| coupling | ✅ **State reads the ledger only** |
| duplication | ⚠️ bounded: cited evidence appears twice, lineage once |
| citation | ✅ |
| `EVALUATED` ownership | ✅ |
| migration | ✅ backfillable, though see §6 |
| evidence vs interpretation | ✅ separate fields, separate classes |

**The line C draws:** *cited evidence is part of the judgment; lineage is how the run was assembled.* That line already exists in the ledger contract —

> *"Evidence lineage does NOT belong here. It is engine-specific and recoverable through the engine's own records."*

C respects it. A quietly erases it, and that erasure is how "put everything in the ledger" begins.

---

## 4. The generic contract

Deliberately free of `narrative_power`, dimensions, or anything marketability-shaped. The domain payload sits inside `value`.

```ts
/** One source the evaluator cited. Closest thing to canonical in an EVALUATED artifact. */
export interface LedgerEvidenceCitation {
  /** Evaluator-local, e.g. "E1". Unique within this entry; NOT a global id. */
  id: string;
  claim: string;
  sourceUrl?: string;
  sourceType?: string;   // official · major_media · secondary · …
  sourceTitle?: string;
  observedAt?: string;
}

/** One thing the evaluator concluded. */
export interface LedgerFinding {
  key: string;                        // "narrative_power"
  label?: string;
  value: unknown;                     // domain payload — a score, a band, a range
  confidence: ConfidenceLevel | null;
  /** WHY. Evaluator-generated, EVALUATED, never canonical fact. P-6: persisted with the judgment. */
  rationale: string;
  confidenceReason?: string;
  /** ids into this entry's `evidence` — not URLs, so a source is stated once. */
  citedEvidence: string[];
  /** Sub-signals, where the evaluator decomposes. */
  components?: Array<{ key: string; value: unknown; imputed?: boolean; confidence?: number; citedEvidence?: string[] }>;
  materialGaps?: string[];
}

/** The `value` of any ASSESSMENT entry, whichever engine wrote it. */
export interface AssessmentValue {
  headline?: { key: string; value: unknown; confidence: ConfidenceLevel | null };
  findings: LedgerFinding[];
  evidence: LedgerEvidenceCitation[];
  notes?: { strengths?: string[]; constraints?: string[]; missing?: string[]; risks?: string[] };
}
```

M.I.A. maps onto it without a special case:

```
dimensions[]            → findings[]
dimensions[].signals[]  → findings[].components[]
dimensionAssessments.X  → findings[].rationale + confidenceReason
judgements.evidence     → evidence[]
keyStrengths/Constraints/importantMissingData/identityOrEvidenceRisks → notes
score + composite       → headline
```

**Nothing here is M.I.A.-specific**, which is the requirement: a future evaluator writes findings, rationale, cited evidence, confidence, provenance and version, and State projects it with no new code.

---

## 5. Athlete State after this change

Responsibility, stated once:

> **Reference evaluator-owned intelligence rather than re-deriving it. Own only what no evaluator sees. Contribute one thing of its own: a single citable address space with absence made explicit.**

| State owns | State references | State does not touch |
|---|---|---|
| deals and economics | M.I.A. findings, rationale, cited evidence | raw research evidence |
| preferences and ambitions | | provider envelopes |
| constraints | | snapshots and digests |
| affiliations and context | | `athlete_facts` — see §7 |
| structured social measurement | | |
| explicit missing/unknown | | |

### `findings` is not eliminated — it becomes a projection

Today it is `score + band + imputation` with the semantics stripped. It becomes the same thing **carrying what M.I.A. already said**:

```ts
export interface StateFinding {
  key: string;
  direction: FindingDirection;              // strength | gap | neutral | unknown — State's own, and load-bearing
  basis: MeasuredValue<number> | MissingValue;
  imputedShare?: { imputed: number; total: number };
  evidence: EvidenceRef[];

  /**
   * NEW — projected, never authored. `owner: "marketability"`, `evidenceClass: "EVALUATED"`, so State carries
   * someone else's judgment without ever emitting one. The no-EVALUATED rule on `athlete_state` is untouched.
   */
  rationale?: EvaluatedValue<string>;
  confidenceReason?: string;
  citedEvidence?: LedgerEvidenceCitation[];
  components?: Array<{ key: string; value: unknown; imputed?: boolean }>;
}
```

`direction` stays State's own contribution — C-1 proved it changes downstream reasoning materially, and no evaluator produces it.

### The distinction that must survive rendering

Opportunity should see, and be able to tell apart:

```
FINDING     narrative_power — strength (88.65, 0/6 imputed)
WHY M.I.A. CONCLUDED THIS   (M.I.A.'s evaluation, not established fact)
            "…pioneering status for South Asian representation…"      confidence HIGH
EVIDENCE M.I.A. CITED
            E1  Wikipedia · co-captained the U.S. team at the 2022 FIFA U-17 World Cup
            E3  major_media · involvement with Yuwa in Jharkhand
```

**The rationale is labelled as evaluation. The evidence is labelled as cited source.** Neither is presented as canonical athlete fact, which is exactly the boundary that `athlete_facts` would have blurred by giving the same material a second, fact-shaped home.

---

## 6. Migration

Every ledger row already links to its run — `evaluation_run_id` is non-null for all 44 — and runs retain `judgements` in full. So the lost material is **recoverable from data we already hold, with no provider cost**.

But the ledger is immutable by contract: *"rows are never updated in place. The point of the row is what we believed THEN."*

| option | verdict |
|---|---|
| update rows in place | ✗ violates immutability outright |
| write superseding rows carrying the recovered fields | ✗ falsely implies a new assessment was made |
| **leave history thin; new assessments carry the full shape** | **✓** |

**Recommended: no backfill.** `rationale`, `citedEvidence` and `components` are optional on the projection, State degrades to today's behaviour for old rows, and any athlete we want enriched gets a **normal M.I.A. re-run** — which legitimately supersedes, is routine, and is cheap. The migration is running the engine, not editing history.

---

## 7. The `athlete_facts` work in #547

**Recommendation: extract to its own branch and remove it from #547.**

Not revert-and-discard — the contract, reader, resolver and 14 tests are sound and canonical facts likely matter to other consumers. But it should not ship in the Opportunity line, for three reasons:

1. **It is not dormant.** State populates `facts` and the block renders them, so the evaluator sees them. Leaving it in means shipping an active behaviour we have decided is not the fix.
2. **67% of `athlete_facts` is `disputed`** and nobody knows why. Shipping the reader implies an endorsement of data we have not understood.
3. **It would create the third home for the same material** — `judgements.evidence`, `athlete_facts`, and State — with disjoint evidence identities and no reconciliation. That is the duplication this note exists to prevent.

Preserve on `feat/state-canonical-facts` with its tests intact, and revisit when the `disputed` question is answered.
