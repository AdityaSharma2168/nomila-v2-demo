# Step 4 — M.I.A. evaluator service: design for review

**Status: DESIGN, NOT BUILT.** No code, no migration. For review before implementation, per design-before-code.

Scope: produce and persist a real, canonical `MarketabilityResult` for an athlete on dev, shadow-only. No reader
switched, no route, no UI, nothing in prod. Prerequisites: #463 and #464 merged, and the dev `model_params` row
re-seeded to `v1.0.1-beta.1`.

---

## 0. A finding that changes the trigger model — read first

The frozen evaluator's entire input surface is:

```ts
blindEvalPromptV02(a: BlindEvalAthlete, socialBlock: string | null)
// → SPEC + V02_ADDITIONS + "Name: {name}\nSport: {sport}" + socialBlock + output instruction
```

**Name, sport, and the authoritative social block. Nothing else.** The evaluator does its own grounded research; it
does not consume Nomila's research substrate, canonical facts, affiliations or evidence rows.

That invalidates part of the proposed trigger list, and it is better to say so now than to build triggers that fire
without changing anything:

| proposed trigger | does it change what the evaluator sees? |
|---|---|
| initial research completion | **Indirectly** — it establishes sport and resolves the social handles the block is built from. Real, but the trigger is *identity/handles resolved*, not *research completed*. |
| material research refresh | **No.** New facts about awards, affiliations or media change nothing the evaluator receives. Firing here burns ~$0.21 and 85s to re-sample research drift. |
| first meaningful connected-social sync | **Yes.** This materially changes the social block. The strongest trigger. |
| any material evidence change affecting a Beta.1 input | **Only social.** Today "a Beta.1 input" means the social block. |
| manual / admin | Yes, by definition. |

So the honest trigger set for the frozen evaluator is: **identity established with a resolvable sport; the authoritative
social block materially changed; manual.** Research refresh is not a trigger.

This is a consequence of the freeze, not a defect. Extending the evaluator to receive Nomila's canonical evidence is a
legitimate future design — it would bump the methodology version and invalidate the 37 goldens, so it is a deliberate
Beta.2 question, not something to slip in here.

**Recommendation:** implement the three real triggers; keep `RESEARCH_REFRESHED` as a recognised event that is recorded
and then *deliberately ignored* with a logged reason, so the decision is visible rather than an omission.

---

## 1. Evidence snapshot ↔ evaluator boundary

```
athlete identity (name, sport)        ─┐
authoritative social block            ─┼─→  EvidenceSnapshot  ──→  frozen prompt  ──→  Gemini
                                       │         (immutable, digested)
trigger reason ─── X never crosses ────┘
```

**The snapshot is the evaluator's only Nomila-supplied input.** It is built, digested and persisted *before* the
provider call, so what was sent is recoverable independently of what came back.

```ts
interface EvidenceSnapshot {
  snapshotId: string;
  athleteId: string;
  name: string; sport: string;              // identity as resolved at snapshot time
  socialBlock: string | null;               // exact text, or null
  socialSources: Array<{ platform: string; accountId: string; observedAt: string; sourceClass: string }>;
  evidenceAsOf: string;                     // §3
  digest: string;                           // sha256 of the canonical snapshot
  builtAt: string;
}
```

**Trigger reason never enters the snapshot or the prompt.** An orchestration fact is not evidence. If
`SOCIAL_CONNECTED` could reach the evaluator, an athlete who just connected would score differently from an identical
athlete who did not — which is exactly the bonus ADR-002 forbids, arriving by a side channel.

This is already enforced rather than merely intended: the canonical prompt digest
(`BLIND_EVAL_SPEC_V02_CANONICAL_SHA256`) pins the delivered text, so adding any input to the prompt changes the digest
and fails the rubric guard in `marketabilityBeta1Freeze.test.ts`. The snapshot builder's signature takes no trigger
argument, and a test asserts the built prompt equals `blindEvalPromptV02(identity, socialBlock)` exactly.

---

## 2. Coalescing and idempotency

**Job key:** `(athleteId, snapshotDigest, evaluatorVersion, paramsVersion)`.

**Idempotency:** if a successful entry already exists for that key, do not call the provider. Return the existing
entry. This is the single most valuable rule here, because of §3: with an unchanged snapshot, a re-run samples research
drift and nothing else — the measured run-to-run movement is a mean of 20.5 MIA points (max 55). Paying $0.21 and 85
seconds to move an athlete's score by noise is worse than not running.

Manual re-evaluation may override idempotency, but must supply a reason, which is recorded on the entry. That keeps
"we re-ran it because the number looked wrong" visible instead of invisible.

**Coalescing:** events for one athlete inside a debounce window (propose **10 minutes**) collapse to one evaluation,
using the latest snapshot in the window. A connect that triggers an immediate sync, a backfill and a features
recompute should produce one evaluation, not three.

**Concurrency:** at most one in-flight evaluation per athlete. A second request while one is running attaches to it if
the snapshot digest matches, or queues if it does not.

---

## 3. What `evidenceAsOf` is

**`evidenceAsOf` = the maximum observation date across the Nomila-supplied evidence in the snapshot** — the social
observations that built the block, and the identity record's own as-of. It is *not* the trigger time, the job start,
or the completion time.

Two properties follow, and both matter:

**Supersession is keyed on it** (`supersedes()` in `intelligenceLedger.ts`). A refresh reading 10:00 evidence that
finishes at 10:25 must not overwrite a sync reading 10:10 evidence that finished at 10:15.

**It does not capture the evaluator's own research clock.** The evaluator retrieves public material at call time; that
retrieval is recorded in the artifact's evidence array but is *not* `evidenceAsOf`, because it is not Nomila evidence
and we do not control it. Consequently two entries can share an `evidenceAsOf` and still differ — that difference is
the noise floor, and it is why idempotency (§2) refuses the second run by default.

For an athlete with no connected social, `evidenceAsOf` changes rarely. That is correct and honest: our evidence about
them genuinely has not changed.

---

## 4. Persistence — append-only, three records

```
evidence_snapshots   what we sent            (immutable, digested)
evaluation_runs      what came back          (immutable: raw provider envelope, parsed judgements, usage, cost, digest)
intelligence_ledger  the ASSESSMENT entry    (immutable, superseded not updated)
```

Separating the snapshot, the raw run and the ledger entry mirrors the discipline that made the freeze work: when
something moves, we can say whether the inputs moved, the evaluator moved, or the scoring moved. Collapsing them into
one row loses exactly that.

The ledger entry is an `AssessmentEntry` (kind `ASSESSMENT`), carrying `versions` (methodology, evaluator, params),
`inputs` (ValueRefs to the snapshot and its social observations), `evidenceAsOf`, and the judgement-set digest so a
stored result is traceable to the exact judgements that produced it.

**Superseding:** a newer entry sets `supersededBy` on the older. Nothing is updated in place. `MarketabilityResult`
for display = the non-superseded entry with the greatest `evidenceAsOf`.

**A failed or stale run never supersedes.** Supersession is applied only on a successful, parsed, scored result whose
`evidenceAsOf` is greater than the incumbent's.

---

## 5. Failure and retry

| failure | behaviour |
|---|---|
| provider call errors / times out | retry up to 2 times with backoff, same snapshot. Attempts recorded on `evaluation_runs` with status `failed`; **no ledger entry**, no supersession |
| response parses but is incomplete (not 44 signals, missing dimensions) | **no ledger entry.** Recorded as `failed_validation` with the raw envelope kept. A partial assessment is worse than none |
| response valid but scoring throws | `failed_scoring`, raw kept. This indicates a contract or params problem and should page, not retry |
| all retries exhausted | the athlete keeps their previous entry, which remains current. Shadow mode means nothing user-visible degrades |

The evaluator is non-deterministic, so a retry is a **new sample, not a repeat**. Retries reuse the same snapshot but
produce a distinct `evaluation_run`; only the successful one becomes an entry. Every attempt's cost is recorded — at
~$0.21 a call, a retry loop is the most plausible way to spend real money by accident.

---

## 6. The golden regression — proving the persisted path, not the scoring function

`marketabilityBeta1Freeze.test.ts` today proves `computeMarketabilityBeta1` reproduces the 37. That is the scorer, not
the path. The service test must exercise **everything between a raw provider envelope and a row read back**:

```
frozen raw artifact (37, unchanged, digest-checked)
   → the production parser            (the same normalizer the orchestrator uses)
   → buildBeta1Dimensions             (judgements → engine input)
   → computeMarketabilityBeta1        (frozen params v1.0.1-beta.1)
   → the production writer            → PGlite
   → the production reader            → MarketabilityResult
   → compare against the goldens, exactly
```

This catches what the current gate cannot: a parser that drops a confidence, a serializer that rounds a dimension, a
column too narrow, a reader that reconstructs signals in a different order. If any of those exist, the arithmetic is
still perfect and the product is still wrong.

Two additional assertions in the same suite:

- **Snapshot determinism** — building a snapshot twice from identical inputs yields an identical digest, and the built
  prompt equals `blindEvalPromptV02(identity, socialBlock)` byte for byte (the trigger-leak guard from §1).
- **Idempotency** — a second evaluation request with an unchanged snapshot digest makes no provider call.

---

## 7. Orchestrator boundaries

The orchestrator **does not** research, interpret, score, or decide. It:

1. builds and persists the evidence snapshot,
2. checks idempotency,
3. calls the evaluator with the frozen prompt,
4. persists the raw run,
5. converts judgements → dimensions → result using the frozen params,
6. writes the ledger entry and applies supersession,
7. records cost and telemetry.

Anything resembling a judgment inside the orchestrator is a bug. It imports the evaluator spec from
`server/services/marketabilityBeta1EvaluatorSpec.ts` (production, post-#463), never from `server/scripts/` — enforced
by `scriptsBoundary.test.ts`.

---

## 8. Migration and rollout

1. Migration `0054`: `evidence_snapshots`, `evaluation_runs`, `intelligence_ledger`. Additive only; no existing table
   altered. Single file, no transaction control, per the migration rule.
2. Re-seed `model_params`: insert `marketability v1.0.1-beta.1+lookups-v1+policy-v0` as **draft** (family+version is
   immutable, so this is a new row, never an edit), then activate; the current row goes inactive.
3. Apply on dev through the deploy path. Verify idempotently, check drift.
4. Run manually for **Mia**, then **Lilia**. Inspect the persisted snapshot, raw run and entry by hand before anything
   else is enabled.
5. Enable the three triggers on dev behind `MIA_EVALUATOR_SERVICE=true`. Prod flag absent.
6. Golden regression green in CI.

**Explicitly out of scope:** any reader switch, route, UI, prod enablement, Rates integration, the `potential` field
(stays null), and Opportunity.

---

## 9. Open questions for review

1. **Debounce window of 10 minutes** — long enough to coalesce a connect cascade, short enough that a manual connect
   feels responsive. Reasonable?
2. **Manual re-evaluation requires a reason.** Agreed, or too much friction for dev?
3. **`RESEARCH_REFRESHED` recorded-but-ignored** (§0) — or omitted entirely? Recording it means the decision is visible
   when someone later asks why a research refresh did not move the score.
4. **Retry count of 2.** With a non-deterministic evaluator, more retries means more sampling; fewer means more
   athletes stuck on a stale entry after a transient provider error.
