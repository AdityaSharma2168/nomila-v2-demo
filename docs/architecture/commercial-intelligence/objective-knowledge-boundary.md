# The Objective / knowledge boundary — the thinnest enforcement

**Owner:** Mia
**Date:** 2026-09-25
**Status:** approved 2026-09-25 with the clarification in §3 (spec rule primary, gate 1 a narrow structural backstop); **implemented** as `objective-eval-spec/1.0.2` + the gate-1 rule and **verified** the same day (`docs/audits/objective-validation-cohort.md` §7). The Objective boundary checkpoint is closed.
**Follows:** `docs/audits/objective-validation-cohort.md` §3.1 — nine of 24 cohort proposals were changes to Nomila's knowledge, and the contract admitted them as Objectives. Mia's decision at that checkpoint: they are not Objectives, and the Brain must not be left to reinterpret them later.

---

## 1. The rule

> **An Objective describes a desired change in the athlete's world, business or position. A change whose primary outcome is improving Nomila's knowledge about the athlete is not, by itself, an Objective.**

The athlete's consent to the underlying action does not promote it. Connecting Instagram, uploading the Adidas contract, recording existing deals: each needs her tap, none is a goal of hers. Mia's own review already drew this line when she declined `acquire-adidas-performance-metrics` as a task rather than an outcome.

| | example | is |
|---|---|---|
| world | "her audience is large enough that partners approach her" | Objective |
| world | "her sponsorship business is understood and improving" — if the state of the business changes | can be an Objective |
| knowledge | "connect Instagram" | information acquisition |
| knowledge | "upload the Adidas contract" | information acquisition |
| knowledge | "record my existing deals" | information acquisition |
| knowledge | "her fifth-year programme is updated in the identity section of State" | information acquisition |

**The tell, in one sentence:** if the desired state would be reached by Nomila learning something while nothing in the athlete's world moved, it is knowledge, not an Objective.

## 2. Where the gap lives instead — nothing new to build upstream

The information gap is already represented three times before the Objective layer, and the Objective evaluator was duplicating it a fourth time downstream:

```
State          materialGaps[n] · findings with direction UNKNOWN · "not recorded" identity lines
Opportunity    domain `evidence` — "what Nomila cannot currently see about this athlete" (spec 1.0.0 §domains)
                     │
                     ▼
Brain          judges that the missing knowledge prevents or materially weakens a decision
                     │
                     ▼  REQUEST INTELLIGENCE
               research · connected-data request · athlete Action (connect, upload, confirm)
                     │
                     ▼
               new evidence returns as evidence-as-seen → State rebuilds → evaluators rerun → Brain reconsiders
```

The Opportunity contract keeps `evidence` as a legitimate strategic domain: for an athlete Nomila barely knows, "connect this account" is often the highest-value honest move. That stays exactly as it is. What changes is only that the Objective layer stops carrying it forward as a goal. The Opportunity map is the Brain's source for REQUEST INTELLIGENCE; the Objective's accounting notes (`not_carried`, why) are the audit trail that the evaluator saw it and declined it for the right reason.

## 3. The enforcement — two pieces, mirroring the execution-verb gate

The chain already has one boundary of exactly this kind: a `desired_state` that opens with a verb of execution is named in the spec as refused, and gate 1 refuses it structurally. The knowledge boundary is built the same way.

**The two pieces do different jobs, and this must not be blurred.** The spec rule is the **primary semantic enforcement**:

> An Objective's desired state must describe a meaningful change in the athlete's world, business, position or outcomes. A state reached merely because Nomila learned, received, connected, recorded or obtained information is information acquisition, not an Objective, even when athlete consent or action is required.

The `evidence`-domain rule at gate 1 is a **structural backstop**, not a mechanical test of that invariant. Flau'jae's ninth case is why: a knowledge-state proposal can be filed under `commercial` and is then undetectable from its domain. **Passing gate 1 does not itself prove that every proposal satisfies the athlete-world-change invariant when the proposal is assigned a non-evidence domain. The evaluator is responsible for that semantic distinction; the evidence-domain rule catches an unambiguous structural violation.** No lexical or verb heuristics are added to gate 1 to chase the residual: the deterministic gate stays narrow rather than becoming a brittle semantic classifier.

### 3a. `objective-eval-spec/1.0.2` — one block, the semantic rule

A new block, `OBJECTIVE_KNOWLEDGE_BLOCK`, between the outcome block and the horizon block; nothing else in the frozen 1.0.1 text is touched. Its content, in full:

```
THE BOUNDARY WITH NOMILA'S OWN KNOWLEDGE

An objective's desired state must describe a meaningful change in the athlete's world, business, position or
outcomes. A state reached merely because Nomila learned, received, connected, recorded or obtained information
is information acquisition, not an objective — even when the athlete's consent or action is required to obtain
it. Connecting an account, recording deals that already exist, uploading a contract, confirming a programme,
verifying metrics: these are represented upstream of you, in the state's material gaps and in the opportunity
map's evidence domain, and a later layer requests them. You do not carry them, and you do not rephrase them
into outcome language: "her partnerships are documented in her profile" is Nomila learning something while
nothing in her world moved. "She holds a partnership she did not hold" is an outcome.

evidence is an opportunity domain, never an objective domain. A proposal in it will be refused. An opportunity
in the evidence domain is accounted for as not_carried, with why — "information acquisition, not an outcome"
is a complete why. The same applies to an opening in any other domain whose only outcome is Nomila's record
changing: the domain does not make it an outcome.

A quantified measure on a Nomila count (closed deals, active relationships) is legitimate only where the world
changes too: a first deal signed is an outcome; an existing deal recorded is not.
```

Version ceremony as before: amend → bump to 1.0.2 → unpin → parity test → exact-text review → repin. Pinned digest `92b803536195…`. The 1.0.1 text and digest remain in the record for the cohort artifacts. **The AMPLIFY deficiency paragraph does not ride along**: bundling two methodology changes in one bump would confound the rerun's attribution. It stays a 1.0.3 candidate.

### 3b. Gate 1 — one structural rule in `validateProposal`

```
if (x.domain === "evidence")
  p.push(at("domain evidence is an opportunity domain, not an objective domain — a change in what Nomila knows is information acquisition, not an outcome"));
```

A structural problem nulls the set, as every structural problem does today. That is the point, not a side effect: the evaluator was told the boundary and crossed it, and the chain refuses rather than repairs. No new accounting outcome, no new field, no schema version. `objective-proposal/1.0.0` stays; the `domain` type stays `OpportunityDomain`, with its comment updated to say `evidence` never appears here because gate 1 refuses it. Contract digest unchanged.

### 3c. What is deliberately not enforced structurally

A knowledge-state proposal filed under another domain (the cohort had one, §4) is not lexically separable from a world outcome — "her deals are recorded" and "she signs a deal" both move `commercialPosition.closedDeals` from 0 to 1. Only the spec rule catches it, and the rerun (§5) is the test of whether it does. Upstream, the Opportunity evaluator filed that case as a `FIX · commercial` whose statement was about "Nomila's transactional database"; under the Opportunity spec's own domain definitions that is `evidence`. Recorded as a B note for an eventual `opportunity-eval-spec/1.0.1`; not bumped now, so that the correction touches one evaluator.

## 4. The nine cohort cases under the rule

| athlete · proposal | domain | the tell in `desired_state` | caught by | where the gap already lives upstream | the request the Brain would make |
|---|---|---|---|---|---|
| Okpara · `verified-audience-baselines` | evidence | "analytics are integrated into Nomila" | gate 1 | `unlock-audience-metrics` · `materialGaps[0]` · `findings[mia.audience_scale]` UNKNOWN | athlete Action: connect accounts |
| Okpara · `localized-market-alignment` | evidence | "commitment is finalized **and recorded**" | gate 1 | `evidence-track-transfer-commitment` · `materialGaps[2]` | research (public commitment) or athlete confirmation |
| Ronaldo · `verify-private-metrics` | evidence | "data is programmatically integrated" | gate 1 | `unlock-private-engagement-metrics` · `materialGaps[0]` | athlete Action: connect accounts |
| Ledecky · `private-metrics-integration` | evidence | "platforms are authenticated with her Nomila profile" | gate 1 | `unlock-private-engagement-metrics` · `materialGaps[0]` · `audienceTrajectory` | athlete Action: connect accounts |
| Ledecky · `commercial-contract-integration` | evidence | "recorded in her Nomila profile" | gate 1 | `unlock-active-commercial-contracts` · `commercialPosition.*` empty · `materialGaps[1]` | athlete Action: upload contracts / record deals |
| Maher · `operational-and-commercial-evidence-baseline` | evidence | "supported by verified metrics and documented history" | gate 1 | `unlock-private-audience-engagement` + `grow-commercial-contract-registry` | connect accounts + record deals |
| Flau'jae · `authenticate-private-performance-metrics` | evidence | "metrics are integrated into her analytics profile" | gate 1 | `unlock-private-performance-metrics` · `materialGaps[0]` | athlete Action: connect accounts |
| Street · `resolve-audience-data-blindspot` | evidence | "**Nomila** possesses direct, continuous integration" | gate 1 | `unlock-private-audience-metrics` · `materialGaps[0]` | athlete Action: connect accounts |
| Flau'jae · `verify-commercial-records` | **commercial** | "documented and represented in her verified commercial registry"; quantified on `closedDeals` for deals she already holds | **spec rule only** (§3c) | `fix-missing-commercial-records` — mis-domained upstream | athlete Action: record existing deals |

Eight of nine are refused structurally; the ninth depends on the evaluator honouring the spec. In every case the Brain's REQUEST INTELLIGENCE has an upstream object to cite, so nothing is lost by not carrying them.

**And the near neighbours that stay Objectives** — the rule must not over-reach:

| proposal | why it stays |
|---|---|
| Okpara · `direct-corporate-partnerships` (commercial, quantified `closedDeals` 0 → ≥1) | a deal he does not hold, signed: the world changes; Nomila's count follows |
| Mia · StartX1 (commercial, deferred `information`) | a deal, deferred until she knows more — the deferral kind records the knowledge gap on a real Objective, which is the right place for it |
| Maher · `athletic-reentry-security` (athletic) | her world; Nomila acts toward nothing, and the Brain's answer is NO ACTION |
| Street · `establish-year-round-sports-broadcasting-presence` (career) | a role she does not hold |
| Mia · Adidas metrics (evidence, declined) | under 1.0.2 never proposed; the existing declined row is governed history and is not touched |

No live Objective is in the `evidence` domain (Mia's three live Objectives are audience, positioning, impact), so the gate changes nothing already governed.

## 5. Verification — targeted, then the checkpoint closes

1. **Unit tests, synthetic proposals only.** Gate 1 refuses a proposal in `evidence` and accepts one in each of the nine other domains; the spec digest test moves through the pin ceremony; the 1.0.1 canonical text is asserted unchanged in the record. No test names an athlete or asserts an athlete's outcome.
2. **Offline classification, not a test.** A script runs the nine cohort proposals from the committed artifacts through gate 1 and prints the table in §4 — eight refused, one not — appended to the audit page.
3. **The direct test of the spec rule — needs approval, six provider calls, ≈ $0.14.** Rerun the **Objective stage only** on the six frozen Opportunity artifacts under 1.0.2. No M.I.A. or Opportunity rerun; not a new cohort. Success is all of:
   - zero gate-1 refusals (the evaluator obeyed, since a refusal would null the set);
   - the nine prior knowledge-state proposals all accounted for and no longer carried as Objectives *for the same semantic purpose*;
   - **no disguised replacements**: a knowledge-state proposal does not count as removed if the evaluator merely paraphrases it into world-outcome language while its actual desired state is still primarily Nomila knowing, holding, connecting or recording something — the semantic outcome is judged, not the wording or the domain;
   - genuine athlete-world outcomes from the 1.0.1 run still represented, checked by lineage tier A/B and by reading, offline, nothing materialised;
   - no unexpected structural regression.
4. **Then:** the Objective boundary checkpoint is **closed**. No further cohort unless step 3 exposes a structural problem the rule did not anticipate.

## 6. Recorded alongside, not acted on

- **AMPLIFY deficiency invention** — B, `objective-eval-spec/1.0.3` candidate, after this bump lands.
- **Street's `career_status` vs cited evidence** — a State conflict-representation pressure point (a fact and its contradiction with no marker, a validator that reads structure only). Not a State redesign now.
- **Flau'jae's music under `career`** — taxonomy pressure on the domain gloss ("media, broadcasting, coaching, education, business, life after playing"), not an Objective-contract failure.
- **Okpara** — this cohort did not validate a true no- or very-low-evidence athlete: after the M.I.A. refresh his State carried nine cited sources. The genuinely sparse condition is still untested and stays on the list.

## 7. After the checkpoint

Design the first **Brain + Context Intelligence experiment** so that the open questions in #608 are answered empirically rather than settled in advance: what the Brain needs beyond governed Objectives; which contextual signals enter State and which remain Brain inputs; how NO ACTION and REQUEST INTELLIGENCE are expressed; how targeted research returns as durable evidence-as-seen; how the Brain sees existing work and avoids duplicates; where Recommendation ends and Campaign/Creative planning begins. No Brain implementation until that design is reviewed.

---

**Agreed as above.** Verification results are appended to `docs/audits/objective-validation-cohort.md` §7.
