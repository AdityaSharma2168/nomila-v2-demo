# Diverse-athlete Objective validation — design

**Owner:** Mia
**Date:** 2026-09-25
**Status:** approved 2026-09-25 (Option A) and **run the same day**. The run and the audit are in `docs/audits/objective-validation-cohort.md`; artifacts under `docs/audits/artifacts/objective-validation-cohort/`.
**Question:** *have we built an athlete-general Objective system, or accidentally optimised it around Mia?*
**Not the question:** ranking athletes, or proving every generated Objective is good.

**What is frozen and will not move during the experiment:** the M.I.A. evaluator, `athlete-state/1.2.0` and its validator, `opportunity-eval-spec/1.0.0` (digest `6bcf91ab…`), `objective-eval-spec/1.0.1` (digest `5c9087b8…`), `objective-reconciliation/2.0.0` (`lineageMin 0.5`, wording `0.6`, `90` days), every prompt. Failures are to be visible, not fixed.

---

## 1. The cohort — six athletes, each a different stress

Selected from the 44 athletes that hold a current M.I.A. assessment. Mia is the reference case (already run through the whole path) and is not re-run. Riya, Lilia and LeBron were the original frozen four and are not repeated; their results are the second reference.

| athlete | stress conditions | what could break |
|---|---|---|
| **Cristiano Ronaldo** · soccer · international · team · mega-audience · commercially saturated | established pro · rich research (134 rows) · non-U.S. context · no connected social, no Nomila deals or inbox | State shows a global icon with zero measured audience, zero pipeline and zero inbound. Does Opportunity say *"we cannot see his commercial world"* (evidence domain, uncertainty), or invent strategy for a man whose problems are not audience or a first deal? Are U.S./NIL assumptions anywhere in the path? |
| **Katie Ledecky** · swimming · U.S. · individual · Olympic · mature | individual sport · quadrennial calendar · mainstream-sport but niche-attention rhythm · rich research (122) | Team-sport assumptions in State (`competitionContext`, seasons) and in Opportunity's domains. Whether an Olympic cycle produces `MAINTAIN`/`career` territory rather than audience growth by default. |
| **Ilona Maher** · rugby · U.S. · team · very large audience for a niche sport · cultural crossover | niche sport with outsized cultural relevance · audience >> sport · likely `positioning`/`impact` territory · rich research (132) | Whether the evaluators read the crossover as the strategic asset it is, or default to "grow the audience". Whether `cultural_relevance` findings carry through State to Objectives. |
| **Flau'jae Johnson** · basketball · LSU · college · dual career (music) · established audience | college like Mia but a materially different shape: an existing owned venture and a second profession · rich research (120) | The `owned_venture` and `career` domains, which yielded nothing for the frozen four. Whether the contract's `domain` set can hold "grow the music career alongside the sport" without a Mia-shaped assumption that the athlete has one identity. |
| **Chisom Okpara** · basketball · Stanford D1 · sparse | M.I.A. assessment only: **0** research rows, 0 social, 0 deals, 0 inbox, 0 assertions · same school and level as Mia | The cleanest test of *uncertainty rather than invented strategy*. Every Objective here must rest on `evidence` territory or nothing. Also the Mia-specificity test: same affiliation, none of her evidence — does anything in the path treat "Stanford D1" as if it implied her profile? |
| **Picabo Street** · alpine skiing · U.S. · individual · retired (1998 Olympic champion) · `career_status` recorded as `active` | post-career athlete · niche sport · stale identity data · rich research (136) | Whether wrong `careerStatus` propagates into Objectives that assume competition ahead, and whether the model can represent post-career outcomes at all (`career`, `impact`, `owned_venture`). A legitimate Nomila user whose goals are not a college athlete's. |

Deliberately *not* chosen: Jim Thorpe (deceased, `active`) — a data-quality test so extreme it teaches nothing about the architecture; Anthony Batson / Matt Rose (duplicate Okpara's case); Aditya (a team member's test account).

Coverage of the requested axes: college vs pro (Okpara, Flau'jae vs Ronaldo, Ledecky, Maher, Street); sparse vs rich (Okpara vs all); small vs mega audience (Okpara vs Ronaldo, Maher); commercially immature vs saturated (Okpara vs Ronaldo); team vs individual (Ronaldo, Maher, Flau'jae vs Ledecky, Street); U.S. vs international (Ronaldo); mainstream vs niche (Ledecky, Street, Maher); active vs post-career (Street).

## 2. Frozen inputs, and one decision needed before running

**Path per athlete:** live `buildAthleteState` (1.2.0, validator on the path) → `opportunityRun` (frozen 1.0.0, no tools, one call) → `objectiveRun --from` that artifact (frozen 1.0.1, one call). Artifacts under `docs/audits/artifacts/objective-validation-cohort/`, each `{ state, map, record }` as for the frozen four. **Nothing is materialised**: no proposal set is persisted, no Objective row is created, no reconciliation runs (none of the six has Objectives). Cost ≈ $0.06 per athlete for the two evaluator calls.

**The decision: the M.I.A. rows.** Mia's, LeBron's, Riya's and Lilia's assessments were refreshed on 22 Sep under the corrected ledger mapping and carry per-finding `rationale`, `citedEvidence` and `components`. The six cohort athletes' assessments date from **16 Sep, before that mapping**: same evaluator (`blind-eval-spec/0.2.1`), but the row holds dimensions only. State degrades gracefully (thin findings, no rationale), so the run *can* proceed, but the evaluators would see less of M.I.A.'s reasoning than they saw for Mia. Two options:

| option | what it tests | cost |
|---|---|---|
| **A · refresh M.I.A. for the six first** (recommended) | the same path Mia went through, so a difference is the athlete, not the row shape | 6 M.I.A. calls at ≈ $0.21 each (average of the last 14 days' runs) ≈ $1.25, plus the ≈ $0.36 above. Provider calls: 18 total |
| B · run on the 16 Sep rows | the degraded path; also a real question (rows of this shape exist for 40 athletes) but it confounds "the architecture does not generalise" with "the row was thin" | 12 provider calls, ≈ $0.36 |

If A: the refresh goes through the existing M.I.A. workflow definition (`workflow/definitions/miaEvaluation.ts`), which supersedes the old row and writes the run record; nothing else changes. Riya's 22-row research and Okpara's zero rows are what they are; no research refresh is proposed.

## 3. The rubric — per athlete, seven checks, each with a failure layer

Each check is scored **pass / partial / fail**, and every non-pass is assigned a layer: **A data/evidence** (the input was wrong, stale or absent) · **B evaluator quality** (the frozen prompt reasoned poorly over adequate input) · **C contract/architecture** (a faithful result could not be expressed, or the contract forced a wrong shape) · **D presentation** (wording, person, casing — recorded, never counted against the architecture).

| # | check | how it is judged |
|---|---|---|
| 1 | **State represents the athlete without Mia's shape** | Every section of the rendered block read against what the athlete actually is. Fail: a section that presumes a college/NIL/U.S./team/active shape (e.g. `competitionContext` forced, onboarding-goal preferences where there was no onboarding, `careerStatus` stated as fact when stale); a validator refusal on a legitimate athlete; a MISSING that should be MEASURED from evidence Nomila holds. |
| 2 | **Opportunity discovers territory appropriate to the athlete** | Kinds and domains of the map against the athlete's real situation. Fail: audience growth proposed to a saturated icon; commercial "first deal" for someone with decades of deals; nothing in `career`/`impact`/`owned_venture` for an athlete whose profile is those. Notes ("why nothing in X") are read as carefully as opportunities. |
| 3 | **Objectives are outcomes worth governing** — not Actions, Recommendations, evidence tasks or raw Opportunities | The Adidas and StartX1 tests applied to every proposal: is it a changed future state the athlete would govern, or a thing to do / a lead to evaluate / data to collect? Structural gates catch the crude case; the judgement here is the semantic one. |
| 4 | **Sparse or missing evidence produces uncertainty, not invented strategy** | For every claim in `currentState` and every `restsOn`, does the cited State path establish it? Any proposal that asserts a fact State does not carry is an invention, however plausible (the "Stanford scholar-athlete" class of error). Okpara and Street are the primary cases; Ronaldo's empty pipeline is the trap. |
| 5 | **The contract holds materially different goals without athlete-specific fields** | Attempt to write, by hand, the Objective the athlete would plausibly want that the run did *not* produce (a post-career outcome for Street; a music-career outcome for Flau'jae; a legacy/ownership outcome for Ronaldo). Can `objective-proposal/1.0.0` express it — domain, success, horizon, provenance? Where it cannot, that is the finding. |
| 6 | **Nothing structurally Mia-specific** | A read of the *path*, not the output: any enum, default, band, threshold, renderer line, prompt sentence or State projection that only makes sense for Mia's profile. Checked once across the six, since the path is shared. |
| 7 | **Failure attribution** | Every non-pass above assigned A/B/C/D with the evidence for the assignment. Disagreements recorded, not resolved. |

Also recorded per athlete: proposals in/out, kinds and domains, origin distribution (an athlete with no onboarding goals cannot produce `joint` — is that right?), entailment SUPPORTED/PARTIAL/UNSUPPORTED as in the frozen-four audits, prescription leakage, third-person prose (D).

## 4. What would show the Objective architecture itself needs to change

Evidence for **C, a contract or architecture change**, is any of:

- a faithful Objective for one of the six cannot be written under the current contract without a new field, enum value or domain (check 5), or requires an athlete-specific field to be honest;
- State's validator refuses, or its projection misrepresents, a legitimate athlete condition (check 1) — e.g. no way to say "post-career", "represented by an agency that governs deals", "team-level commercial rights", "no social by choice";
- the provenance or origin rules yield a wrong origin for a non-Mia case (an athlete with no intent path can only ever be `nomila`; if that is wrong for an athlete who has stated goals elsewhere, the intent seam is the finding);
- the grounding grammar cannot cite what matters for the athlete (a citable fact exists in Nomila and has no path);
- the same failure appears across athletes with different data quality, which rules out A.

Evidence that it is **B or A**, to be logged and *not* acted on now:

- wrong or stale facts from a 16 Sep row or thin research (A);
- plausible-but-uncited claims, prescriptive wording, poor consolidation, a domain missed that the evidence supported (B);
- third-person prose, casing, rendering (D).

**The checkpoint decision after the run** is one sentence per athlete on whether the boundary held, and one overall: *is the Objective boundary stable enough to be the Brain's input?* If C findings exist, they are designed before the Brain; if only A/B/D, the Brain proceeds and those go to the evaluator-quality backlog.

## 5. What this experiment does not do

No tuning of any threshold, prompt or contract during or after the run. No materialisation. No reconciliation. No athlete-originated Objective (remains first-class, exercised on a natural case). No research refresh. No Brain.

---

**Approved as written** (six athletes, Option A, rubric and criteria). Result: `docs/audits/objective-validation-cohort.md`.
