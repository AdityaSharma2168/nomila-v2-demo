# Objectives — lineage, deferral, and evidence-as-seen: design

**Owner:** Mia
**Date:** 2026-09-25
**Status:** design for review, revised after the first review (R1, 2026-09-25). No code. Three minimal changes that fall out of reconciliation experiment 1 (`docs/audits/objective-reconciliation-experiment-1.md`), in dependency order: the evidence a proposal was judged from must be kept (§3) before lineage can be computed from it (§1); deferral (§2) needs the same snapshot to know whether evidence changed.
**Not in scope:** the Brain, evaluator tuning, the 0.6 wording threshold, the 90-day window.

---

## 0. In plain words

**What Mia experiences.** When Nomila runs again, the objectives she has already shaped stay hers: Nomila does not re-propose them under new wording, does not merge two of them because it changed its mind about how to group them, and does not bring back something she said "not until I know more" about when nothing new is known. When Nomila's new reading genuinely cuts across two of her objectives, she is told that, as a note, not as a replacement.

**What happens underneath.** Each proposal set keeps the exact State and Opportunity Map the evaluator saw. From those, every Objective gets a lineage signature: the State evidence it ultimately rests on. A fresh proposal is reconciled by lineage into a relationship with what she already has, never into an edit of it. A deferral carries the kind of reconsideration she asked for: a date is honoured, her own return is honoured, and "when I know more" waits until something can say she does — never merely because some evidence moved.

---

## 1. Reconciliation by strategic lineage

### 1.1 The invariant

> **Evaluator reruns may describe a different topology over the same strategic territory. They cannot merge, split, reshape, replace, suppress or otherwise redefine athlete-governed live Objectives without athlete governance.** A rerun may discover or reaffirm; where its topology differs from hers — one proposal across two of her Objectives, or two proposals inside one — that is a relationship on the record, never an edit to the portfolio.

Athlete topology over evaluator topology, in both directions. A proposal that cuts across two live Objectives does not merge them (`spans`). Two proposals inside the lineage of one live Objective do not split it: the evaluator decomposed that territory differently, and her Objective is unchanged (`splits`).

### 1.2 Lineage: what a proposal rests on — continuity, not identity

Wording is unstable in both directions (experiment 1: 0.04–0.50 against the right Objective). Opportunity keys are stable only within one map: a fresh Opportunity run mints new keys. What is stable across both is **the State evidence the proposal ultimately rests on**.

**Evidence lineage identifies candidate strategic continuity or relationship; athlete-governed Objective identity remains the durable Objective entity.** The same evidence can legitimately support different strategic outcomes, so a lineage match says "this proposal stands on the same ground as that Objective" and nothing stronger. `LINEAGE_MIN` establishes a relationship candidate, never Objective equivalence; what the relationship *does* (reaffirm, record, or nothing) is decided by §1.4 against the Objective's governed state, and the Objective itself is never derived from the match.

```ts
/** Computed once at creation from the proposal and the map it was judged from. Immutable. objective/1.1.0. */
interface ObjectiveLineage {
  domain: OpportunityDomain;
  /** The cited opportunities, and the map they belong to — comparable only within that map. */
  opportunityKeys: string[];
  mapAsOf: string;
  /**
   * Every State path the proposal rests on, directly (currentStateEvidence) and through its opportunities
   * (each cited opportunity's restsOn). Positional indices normalised — `inbound[2]` → `inbound[]` — because the
   * index is a sort position, not an identity. Sorted, deduplicated.
   */
  evidencePaths: string[];
  /** The intent citations. Recorded; NOT an identity signal — one broad intent backs many outcomes. */
  intentPaths: string[];
}
```

Measured on experiment 1 (fresh proposals against the originals they duplicated), evidence-path Jaccard:

| fresh → original | right one | best wrong one |
|---|---|---|
| audience | **1.00** | 0.00 |
| positioning | **0.83** | 0.60 (Yuwa — the span, see §1.4) |
| StartX1 | **1.00** | 0.29 |
| Adidas | **1.00** | 0.14 |

Wording Jaccard on the same pairs was 0.50 / 0.24 / 0.67 / 0.17. Lineage is the primary relationship signal; wording is demoted to a weak tie-breaker.

### 1.3 Matching, tiered and deterministic

```
score(P, O):
  tier A  same map (P.mapAsOf === O.lineage.mapAsOf):   any opportunityKeys overlap  → match (strength = evJ)
  tier B  any map, same domain:                        evJ(P, O) ≥ LINEAGE_MIN       → match (strength = evJ)
  tier C  same domain, evJ below threshold:            wordingJ ≥ 0.6                → weak match, finding only
```

`evJ` = Jaccard over `evidencePaths`. `LINEAGE_MIN = 0.5` is a versioned starting hypothesis under `objective-reconciliation/2.0.0` (identity axis changed → major). On experiment 1 it separates cleanly; it must be re-measured on the first fresh *Opportunity* run, where opportunity keys change and only tier B applies.

**Athlete-created Objectives** have `evidencePaths: []` and never match by lineage, so Nomila never reaffirms, suppresses, re-surfaces, merges or modifies one of her own goals through reconciliation. They can still be *related*: a fresh proposal in the same domain with wording ≥ 0.6 produces a `may_relate` finding on her Objective and nothing else. The contract stays open to better relationship detection later (she creates "Grow my Instagram and TikTok audience" while a related Nomila-discovered Objective is live; surfacing that relationship to her is a later, explicit step, never a silent merge). L1 does not attempt semantic relationship detection.

### 1.4 Relationships, not just verdicts

A fresh proposal is classified against the set of matches it has, not the single closest:

| matches | relationship | what happens |
|---|---|---|
| none | `new` | Objective row, `unreviewed · proposed` (as today) |
| one live | `continues` | `reaffirmed_by_run` on it; no row (as today) |
| one deferred | `continues` | §2 decides whether it re-surfaces |
| one declined, inside window | `continues` | `re_proposed_while_declined`; no row (as today, now with an identity that works) |
| one closed (superseded / abandoned / achieved) | `continues` | new row with history attached (as today) |
| **two or more live** | **`spans`** | **no row.** A system event `spans_live` on each matched Objective carrying the proposal key, set id, the sibling ids and each strength. The materialisation report lists it. The evaluator's consolidation is recorded as its opinion and changes nothing |
| two fresh proposals both `continue` one live Objective | **`splits`** | her Objective is unchanged — the evaluator decomposed the territory differently. Each proposal reaffirms; one `splits_live` event on the Objective names both proposal keys. No row, no split |
| weak (tier C) | `may_relate` | event only; the proposal is otherwise treated as `new` |

The positioning proposal in experiment 1 becomes: `spans` → positioning (0.83) and Yuwa (0.60); no row; two events; Mia's two Objectives untouched.

### 1.5 The thinnest change

- **Contract:** `Objective.lineage` (immutable, computed at creation; `objective/1.0.0 → 1.1.0`, additive). Two run actions added to the enum: `spans_live`, `splits_live`, plus `may_relate` (migration widens the CHECK, as 0065 did).
- **Store:** `materialiseProposalSet` computes lineage from the set row's persisted map (§3) and classifies by §1.3–1.4. `Materialisation` gains `spans`, `splits`, `mayRelate`.
- **Backfill:** Mia's five presented Objectives get lineage computed from the Run D map (it is in the artifact and will be on the set row after §3's backfill). One script, once.
- **Surface:** nothing in v1. A `spans` finding is for the audit and, later, the Brain; the athlete has already governed.
- **Wording Jaccard** stays in the code as tier C. Its threshold is not touched.

---

## 2. Deferral carries its condition

### 2.1 The gap

"Not now" today records her words and nothing the rule can read. StartX1's deferral said *evaluate the opportunity first*; the next run, on unchanged evidence, re-surfaced it. A deferral has a reason, and the reason says when reconsideration is warranted.

### 2.2 Three kinds, one field

```ts
/** On the defer event's delta, and projected onto the row. objective/1.1.0. */
interface Deferral {
  kind: "information" | "time" | "athlete";
  /** `time` only: reconsider after this instant, derived from the period she chose. */
  after?: string;
  /** Her words, verbatim (the event's `said`), repeated here so the row is self-describing. */
  said: string | null;
}
```

| kind | she means | re-surfaces when |
|---|---|---|
| `information` | "I don't know enough to decide" | **only when the information she asked for has become available — not when some evidence changed.** Another inbound email, a moved count or a new date changes the snapshot without answering "what is StartX1 and is it a fit?". L2 cannot represent satisfaction of that condition, so in L2 an information deferral **never re-surfaces automatically**: each rerun records `reaffirmed_by_run` and leaves it deferred. Evidence change at its lineage paths is recorded on that event (`evidenceChanged: true`) as a signal for the audit and for the later intelligence-gap step, and triggers nothing. It re-surfaces by her tap, or by an explicit later mechanism that can say the condition was met |
| `time` | "later" | `now ≥ after`. Periods reuse the horizon vocabulary: this season / next 12 months, mapped to an instant at defer time |
| `athlete` | "I'll come back to it" | never automatically. The history list gets a "revisit" control that returns it to the queue by her tap (a `re_surfaced` event with an athlete actor) |

**Unspecified** (every deferral recorded before this ships, including StartX1) is treated as `information`. That is the conservative reading and the one her words support.

**Evidence changed ≠ information available.** The two are kept apart on purpose. "Evidence changed" is computable from two snapshots and is recorded. "The information required for reconsideration became available" is a judgement about *which* gap her deferral named and whether something now fills it; representing that is the intelligence-gap question already parked, and L2 does not pretend to have it. Conservative behaviour until it exists: no automatic re-surfacing of information deferrals.

### 2.3 The thinnest change

- **Contract:** `Objective.deferral?: Deferral`; `ObjectiveDelta.deferral` on `defer` events; `re_surfaced` events carry `because: "evidence_changed" | "time_elapsed" | "athlete"`.
- **Store:** the projection gains a `deferral` jsonb column (0066, additive). The `continues → deferred` branch: `time` → `re_surfaced` when `now ≥ after`, else reaffirm; `athlete` and `information` → `reaffirmed_by_run` always, the latter with `evidenceChanged` computed from the two snapshots and recorded. `re_surfaced` with `because: "information_available"` exists in the enum for the later mechanism and has no writer in L2.
- **Surface:** the Not-now sheet gains three pills above the words box: *When I know more about this* · *Later* (season / 12 months) · *I'll come back to it*. Default selection: *When I know more*. No new screen.
- **Not designed:** what "evaluate the opportunity first" triggers. That is the intelligence-gap question already parked; here the deferral only stops the nagging and names the kind of answer it is waiting for.

---

## 3. Evidence-as-seen: persist the structured inputs

### 3.1 The gap

`objective_proposal_sets` keeps the set and the run record; the record holds the State and the map only as rendered text. The composed State is never persisted (it is a view), and the map exists only in run artifacts. So audit and review parse prose, and lineage (§1) has nothing structured to read. Formatted text must not become an internal contract.

### 3.2 The thinnest change

Two nullable jsonb columns on `objective_proposal_sets` (0066):

| column | holds | invariant |
|---|---|---|
| `state_snapshot` | the `AthleteState` object passed to the evaluator, byte for byte | `state_snapshot.asOf === state_as_of` |
| `opportunity_map` | the `OpportunityMap` object passed to the evaluator | `opportunity_map.stateAsOf === state_as_of` and `.asOf === opportunity_map_as_of` |

Both are already in every run artifact and are tens of kilobytes. `persistProposalSet` takes them as arguments; the validator refuses a set without them once the columns exist. The rendered blocks stay in `record` for byte-level prompt audit (`promptSha256` is over the rendered text, and the renderer has already changed once; the text is what was sent, the snapshot is what it was rendered from).

**Reproducibility.** Given an Objective: `fromProposal.setId` → the set row → `state_snapshot` + `opportunity_map` + `record.canonicalSha256` + `record.stateBlock`/`opportunityBlock`. Every citation on the proposal resolves with the existing `resolveStatePath` against the snapshot; the review context reads structured values and renders them itself, and `stateLineFor` is retired. Nothing is re-evaluated.

**Backfill.** Mia's presented set (`5dd8bdcc…`) gets its snapshot and map from `objective-1.0.1-run/Mia_Bhuta.json`, whose `state.asOf` equals the row's `state_as_of`. One script, once, asserting the equality before writing.

**Not decided here:** whether the Opportunity Map deserves its own table. Carrying it on the set row is sufficient for lineage, review and audit, and defers that decision without loss.

---

## 4. Sequence, when approved

| step | what | proves |
|---|---|---|
| L0 | 0066: `state_snapshot`, `opportunity_map` on sets; `lineage`, `deferral` on objectives; CHECK widened for the three findings. Backfill Mia's set and her five Objectives from the artifacts, asserting `asOf` equality | §3 invariants; every existing citation resolves structurally |
| L1 | lineage computation + `objective-reconciliation/2.0.0` matching and relationships; the review context reads the snapshot | on experiment 1's inputs: audience/StartX1/Adidas `continues`, positioning `spans` two live, zero new rows |
| L2 | deferral kind on the event, row and sheet; `time` and `athlete` semantics; `information` never auto-resurfaces, evidence change recorded only | StartX1 stays deferred whatever the evidence does, until her tap or a mechanism that can say her question was answered |
| — (after L1) | rerun experiment 1's fresh set through the implementation and show the actual relationships before L2 | the invariant holds on her live portfolio: audience / StartX1 / Adidas `continues`, positioning `spans`, zero new rows |

Then the athlete-originated experiment (her verbatim goals through the existing created path), then the Brain design.

---

## 5. Decisions the reviewer may strike

1. Lineage from evidence paths with indices normalised, `LINEAGE_MIN = 0.5` as a versioned hypothesis establishing a relationship candidate only, wording demoted to tier C.
2. `spans` and `splits` are events plus a report line, not a queue item, in v1.
3. Unspecified deferrals are read as `information`, and information deferrals never re-surface automatically in L2.
4. Snapshot and map live on the set row, not in their own tables, for now.
5. The rendered blocks are kept alongside the structured snapshot rather than replaced by it.
