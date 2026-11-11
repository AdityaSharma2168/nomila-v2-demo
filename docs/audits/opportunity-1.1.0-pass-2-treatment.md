# Opportunity 1.1.0 (pass 2) — the ceremony and one controlled treatment call, 27 Sep 2026

**Status:** `opportunity-eval-spec/1.0.0` → **1.1.0** by ceremony (amend → bump → unpin → parity → exact-text review → repin); `opportunity-map/1.0.0` → **1.1.0** (additive). One provider call — the treatment — against the recorded run-d as control; the control was not rerun. Artifacts: `docs/audits/artifacts/opportunity-1.1.0-treatment/Mia_Bhuta.json` (treatment) · `docs/audits/artifacts/opportunity-1.0.0-run-d/Mia_Bhuta.json` (control, untouched). Model `gemini-3.5-flash`; cost **USD 0.022**.

## 1. The ceremony

| step | result |
|---|---|
| amendments (six, from the pass-2 checkpoint §14) | P1 the two admitted lenses (`context` slot + `targetedResearch` as responsive evidence; `supported_by[]` with `ctx[<n>]` / `research[<n>]`) · P2 the State grounds (`rests_on` must be State; a support ref inside it is refused structurally) · P3 missing is not none, scoped to the block's window and sources · P4 a positive signal manufactures no weakness · P5 deterministic key stabilization as a normaliser step (`opportunity/stabilize.ts`, `opportunity-key-stabilization/0.1.0-exp`) · P6 (`evidence`-domain openings as Intelligence Requests) **deliberately not applied** — recorded as a later candidate, so the `evidence` domain still stands in 1.1.0 |
| text added to the canonical prompt | one section after the evidence rules: "WHAT ELSE YOU MAY BE SHOWN — CONTEXT AND RESPONSIVE EVIDENCE" (context supports, the state grounds · an event is not an opportunity · a positive signal does not manufacture a weakness · missing is not none); `supported_by[]` in the output contract; urgency may cite a dated context item. Kinds, domains, judgments, athlete voice, "few is valid": **unchanged** |
| digest | 1.0.0 `6bcf91ab…` → **1.1.0 `b6883c248e1ea343091f30a99d3fad26a248e89a9ed64a743e85cdcba333c00a`** — repinned only after parity passed and the exact diff was reviewed (recorded in the PR) |
| gates | structural: `supported_by` optional, each `{ref, how}`, ref ∈ `ctx[n] \| research[n]`; `rests_on[i].state_path` of that form → refused ("context supports, the state grounds"). Grounding: `ctx[n]` must index an item of the Context block actually supplied, `research[n]` a supplied block; nothing supplied → refused. State-path resolution unchanged |
| grammar | `resolveStatePath` untouched; support refs resolved by count against what was supplied — never by content |
| key stabilization | candidate = same kind + same domain; lineage = Jaccard over normalised `restsOn` paths (indices stripped); carry only when exactly one candidate ≥ 0.50, no second within 0.15, and no other current opening claims the same prior key; `carriedFrom {key, mapAsOf, lineage}` recorded; every candidate reported |
| parity / regression | 61 Opportunity tests (parity, digest, structural, grounding, stabilization) + 14 orchestrator + 157 Objective + 62 Brain + 27 Objective orchestrator/routes — all green. `opportunityRegate.ts`: **22 recorded 1.0.0 artifacts gate identically** under the 1.1.0 validators (structural 0→0, grounding 0→0 on every one) |
| 1.0.0 history | untouched; every 1.0.0 artifact keeps its spec, digest and record |

## 2. The treatment — exactly what differed from the control

| | control (run-d, recorded) | treatment |
|---|---|---|
| State | `athlete-state/1.2.0`, asOf 2026-09-23T18:05:56Z | **the same recorded State object**, and **the control's recorded state block sent verbatim** (`stateBlockSource: recorded`) — the two renderer formatting fixes pinned since run-d were not allowed to leak in |
| methodology | 1.0.0 (`6bcf91ab…`) | 1.1.0 (`b6883c24…`) — the added section only |
| CONTEXT | none | the #638 seven-item block (window 26 Sep → 16 Oct; two fixtures, a result, a campus occasion, the USWNT friendlies, gorjana's brand activity, the F1 control) |
| responsive evidence | none | none |
| prior snapshot for key stabilization | — | run-d's map |
| provider | one sample, temperature 1.0 | one sample, temperature 1.0 |

**A caution the record must carry:** with one sample per arm at temperature 1.0, the four recorded 1.0.0 runs on the same athlete already produced four different maps. Only changes that **cite** context are attributable to Context; everything else is within run-to-run variation and is recorded as such, not scored.

## 3. Every treatment opening

| key (as emitted → after stabilization) | kind · domain | statement | State citations | Context citations | responsive | existed semantically in run-d? | Context's effect | outlives the event? | Gate 1 / Gate 2 |
|---|---|---|---|---|---|---|---|---|---|
| `grow-content-cadence` | GROW · content | Revitalize content frequency across platforms to counter the cooling audience trajectory | `contentPerformance[tiktok]`, `contentPerformance[instagram]`, `audienceTrajectory`, `findings[mia.audience_scale]` | none | none | yes — run-d's `grow-instagram-posting-cadence`, here absorbing run-d's `unlock-tiktok-channel` into one GROW | **none** (uncited; consolidation is sampling variation) | n/a | 0 / 0 |
| `amplify-gorjana-partnership` | AMPLIFY · commercial | Elevate the gorjana relationship from a gifting connection into a structured long-term ambassadorship | `commercialPosition.activeRelationships` (gorjana), `commercialPosition.inbound[3]` (GIFTING, gorjana, 8 Sep), `findings[mia.brand_fit]` | **`ctx[5]`** — "gorjana's current marketing focus on women in sport through its Sports Club collection and its strategic preference for long-term ambassadors" | none | **no** — new. Run-d had `amplify-inbound-startx1-interest` (AMPLIFY commercial on inbound demand), absent here | **created it, as support**: the interpretation (AMPLIFY an existing relationship) rests on State; context supplied the brand-side reason and the urgency claim ("aligns with gorjana's ongoing Sports Club campaign", medium) | **yes** — a relationship to amplify outlives the collection's season; the urgency is what is dated | 0 / 0 |
| `unlock-private-analytics` → **`unlock-adidas-historical-performance-data`** (carried, lineage 0.50) | UNLOCK · evidence | Secure her private campaign conversion data and Adidas contract terms | `materialGaps[0]`, `[1]`, `[2]` | none | none | yes — run-d's `unlock-adidas-historical-performance-data` | none | n/a (an epistemic gap — see §5) | 0 / 0 |
| `amplify-philanthropic-positioning` → **`amplify-yuwa-philanthropic-work`** (carried, lineage 0.67) | AMPLIFY · impact | Highlight her Yuwa leadership to elevate her global narrative and attract CSR alignment | `findings[mia.narrative_power]`, `findings[mia.cultural_relevance]` | none | none | yes | none | n/a | 0 / 0 |
| `grow-negotiation-pipeline` | GROW · commercial | Convert her active negotiation pipeline to expand her selective commercial footprint | `commercialPosition.pipeline`, `commercialPosition.closedDeals`, `findings[mia.momentum]` | none | none | no — new; run-d carried the pipeline inside the StartX1 AMPLIFY | none (uncited; variation) | n/a | 0 / 0 |

Absent from the treatment: run-d's `unlock-tiktok-channel` (consolidated), `grow-academic-tech-partnerships`, `amplify-inbound-startx1-interest`. None of the three absences cites or concerns any context item; all three are sampling variation of the kind the four 1.0.0 runs already showed.

Notes (four): athletic, relationships, owned_venture, career yielded nothing, each with a State-grounded reason. Gate 1: 0 problems. Gate 2: 0 problems, **15 of 15 citations resolved**, the one `ctx[5]` support resolved against the seven-item block. Usage 9,400 prompt · 2,135 output · 5,491 thought tokens.

## 4. Key stabilization against run-d

| treatment key | kind · domain | candidate prior keys (lineage) | qualifies ≥ 0.50 | ambiguous? | carried | why |
|---|---|---|---|---|---|---|
| `grow-content-cadence` | GROW · content | `grow-instagram-posting-cadence` (0.33) | no | no | **no** | no candidate reaches 0.50 — a correct false negative: the opening absorbed a second one and its evidence set moved |
| `amplify-gorjana-partnership` | AMPLIFY · commercial | `amplify-inbound-startx1-interest` (0.20) | no | no | **no** | correct: a different counterparty, one shared path class (`inbound[]`) |
| `unlock-private-analytics` | UNLOCK · evidence | `unlock-adidas-historical-performance-data` (0.50) | yes | no | **yes** | sole qualifying continuation — exactly at the floor (the two `materialGaps[n]` normalise to one path) |
| `amplify-philanthropic-positioning` | AMPLIFY · impact | `amplify-yuwa-philanthropic-work` (0.67) | yes | no | **yes** | sole qualifying continuation |
| `grow-negotiation-pipeline` | GROW · commercial | — | — | no | **no** | no prior opening of this kind and domain |

Two carries, both unambiguous and both right by inspection; three new keys stand, all rightly. No guess was made; the 0.50 carry sits on the floor and is the case to watch as the threshold is measured.

## 5. Acceptance

| # | criterion | result |
|---|---|---|
| 1 | Context does not produce event-shaped Opportunities merely because events exist | **met** — six of seven items (two fixtures, the result, the campus occasion, the USWNT friendlies, the F1 control) produced nothing and were never cited; the one item used is brand activity, and it supported an AMPLIFY of an existing relationship, not an event |
| 2 | every Opportunity still has Athlete State grounding | **met** — 15/15 State citations resolved; no opening rests on context |
| 3 | Context citations used only as support/timing where semantically relevant | **met, with one observation** — `ctx[5]` in `supported_by` and in the urgency claim. Observation: the urgency reads the *ongoing* Sports Club collection as a campaign that makes the opening time-dependent, although the item states no dated drop or campaign is announced; the absence was not converted into negative evidence (good), but an undated ongoing activity became mild urgency. Logged, not tuned |
| 4 | epistemic gaps do not become Opportunities | **not met — by design of this bump**: `unlock-adidas-historical-performance-data` (UNLOCK · evidence) persists and was carried. P6 (express `evidence`-domain openings as Intelligence Requests) was deliberately left as a later candidate, so 1.1.0's text still declares evidence a legitimate domain. The criterion cannot be met until P6 is decided; this run shows the cost of deferring it |
| 5 | existing strategic Opportunities can remain despite existing work | **not exercised** — Opportunity still receives no Existing Work (by design); the Yuwa and Adidas openings persisted across snapshots, which is the continuity the criterion cares about |
| 6 | gates continue to catch unsupported interpretations | **met mechanically** — both gates ran on the execution path and passed; the refusals are pinned offline (support ref in `rests_on`; `ctx[n]` beyond the block; nothing supplied) and the 22-artifact regate shows no drift |
| 7 | key stabilization carries only unambiguous continuity | **met** — §4 |
| 8 | no downstream lifecycle/governance semantics needed | **met** — the map is a snapshot; absent openings simply are not in it; `carriedFrom` is readability only |

**Verdict: pass 2 is supported on the question asked.** Real context changed the map only where it supported a State-grounded strategic interpretation (one AMPLIFY on an existing relationship, dated by brand activity); it manufactured no event-shaped opening; the gates and the stabilizer behaved as designed. The one criterion not met is the one this bump chose not to address (P6), now visible in the output.

## 6. Observations for the record (not acted on)

- **Sampling variation dominates unattributable differences.** Three of run-d's six openings are absent and two new uncited ones appear; a second treatment sample would look different again. The acceptance was judged on cited effects only, as it must be.
- **`grow-negotiation-pipeline`** ("aggressively work the open negotiations") is closer to "do the work in motion" than to a strategic condition — a Brain matter. The 1B separation (condition vs. initiate work) is the Brain's; Opportunity has no Existing Work lens to see it. Logged as pressure on the kind test, not a rule.
- **The gorjana characterisation** ("from a gifting connection") reads the GIFTING inbound as the nature of the relationship; the State block names gorjana under `activeRelationships` and counts one closed deal but does not say beside the count that the closed deal *is* gorjana's paid one. A State-rendering limitation, not a context misuse.
- The **0.50 carry** sits on the floor because `materialGaps[n]` indices normalise to one path — coarse evidence; the threshold is a hypothesis to measure.

## 7. Not done

No second provider call. No production mounting. No Opportunity ledger. No Objective 1.0.3 work. No P6 amendment. No Deals, Rate, Recommendation, Campaign/Studio or brand-relationship change. No repeatability matrix. #638 remains the Context checkpoint; #608 unchanged; `opportunity-map/1.0.0` history untouched; #570 untouched.
