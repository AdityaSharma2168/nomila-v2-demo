# M.I.A. identity anchoring — plan (DRAFT, not applied)

**Status:** proposal only. Nothing in this document has been applied. No code, prompt, schema or data was changed, and no
provider call was made while writing it. Every evaluator-text change below is a **digest-pinned methodology change** and
goes through the ceremony (amend → bump → unpin → parity → exact-text review → repin). The re-validation in §5 spends
provider money and **needs founder approval**.

**As of:** 27 Sep 2026, dev database (read-only SELECTs through the Cloud SQL proxy), tree at `b5f4cc6c`.

---

## 0. What the athlete experiences, and what goes wrong underneath

When someone signs up or connects an account, Nomila asks the M.I.A. evaluator (Gemini with Google Search) to research
them and score their marketability. The evaluator is told only the athlete's **name** and **sport**, plus measured
numbers from any connected social accounts. It is never told their school, team, position, or that the connected
handle is the way to tell them apart from a namesake. So an athlete with a common name can be scored as **someone
else**, and the evaluator will still say it is sure (`identityConfidence: HIGH`).

The dev case: **Aditya Sharma** (`3811cedd…`). The evaluator scored *"an active professional goalkeeper for Calangute
Association in the Goa Professional League"* at **412**, identity **HIGH**. It cited four Goa match reports. The same
prompt also contained Aditya's connected Instagram account (`@fightquant`, OAuth, 45 followers), which the evaluator
**cited as evidence E5 and then ignored as an identity anchor**. Legacy research found a *different* namesake (Malvern
Prep / Solon HS). Aditya's own onboarding answer says **Basketball**, but `athletes.sport` still says `soccer`. So the
evaluator was sent the wrong sport as well.

Two separate faults, then:

1. **Input fault (code, no ceremony):** the athlete's asserted sport never reached `athletes.sport`, and the snapshot
   reads the column.
2. **Method fault (evaluator text, ceremony):** nothing tells the evaluator which person it is looking for, and nothing
   checks that the person it found matches anything Nomila knows.

---

## 1. What the evaluator receives today, and where it is assembled

| step | file:line | what it does with identity |
|---|---|---|
| trigger | `server/routes/auth.ts:153` (`IDENTITY_RESOLVED` at signup); social connect/sync → `SOCIAL_BLOCK_CHANGED`; manual refresh | Records a reason. The reason is **never sent** (ADR-002). |
| workflow | `server/workflow/definitions/miaEvaluation.ts` — steps `wait` → `snapshot` (:63) → `evaluate` (:76) → `score` (:97) | Nothing about identity. `snapshot` returns `skipped: "no resolvable identity"` only when sport is null. |
| snapshot | `server/services/marketabilityBeta1Snapshot.ts:126` `buildEvidenceSnapshot` | Reads **only** `athletes.full_name`, `athletes.sport` (:132), plus `connectedBlock()`. Discovery for research-cited handles is off by default. |
| social block | `server/services/marketabilityBeta1SocialBlock.ts:39` `connectedBlock` | Per active connected account: handle, source, observed date, `identity: athlete-connected account (OAuth) … (HIGH)` (:69), and metrics. The only identity-bearing input. |
| digest | `marketabilityBeta1Snapshot.ts:86` `snapshotDigest` | sha256 over `{name, sport, socialBlock}` — exactly what is sent. |
| prompt | `marketabilityBeta1Snapshot.ts:98` `promptFor` → `marketabilityBeta1EvaluatorSpec.ts:489` `blindEvalPromptV02` | `SPEC v0.1 + v0.2 ADDITIONS + "ATHLETE TO EVALUATE\n\nName: …\nSport: …" + social block (or its no-data fallback)`. |
| canonical pin | `marketabilityBeta1EvaluatorSpec.ts:501` `CANONICAL_EVALUATOR_TEXT`; digest `167e6c50…`; guarded by `marketabilityBeta1Freeze.test.ts` (rubric → policy → evidence → scoring) | Any change to the delivered text fails the freeze. |
| call + parse | `marketabilityBeta1Orchestrator.ts:137` `runEvaluation` → `marketabilityBeta1Evaluator.ts:195` `parseEvaluatorResponse` | `identityConfidence` is read verbatim from `athlete.identity_confidence` (:171). |
| record | `marketabilityBeta1Orchestrator.ts` `scoreAndRecord` | `identityConfidence` copied into the ledger `value`. |

**The evaluator's current identity rules (the gates that exist today):**

- Spec v0.1 (`EvaluatorSpec.ts:92`): *"If identity is uncertain, say so and reduce confidence."* Research priority list
  item 1 is *"identity and current career status"*.
- v0.2 confidence rubric: HIGH requires *"Athlete identity is clear"*; LOW when *"Identity or applicability is
  uncertain"*.
- Output: `athlete.identity_confidence` (HIGH|MEDIUM|LOW) and `identity_or_evidence_risks[]`.
- **Code gates:** only two. Parse failure (retryable) and *refusal* = no signal scored (`EvaluatorRefusedError`, not
  retried). **No code reads `identityConfidence`.** Nothing checks the evaluator's evidence against anything Nomila
  holds. The orchestrator is designed to "not judge" (ADR-017).

**How reliable is the self-reported identity confidence?** In the frozen 37-athlete development run it was **HIGH for 36 of
37**. That includes 8 of the 9 athletes whose cohort anchor is only `"<sport> athlete"` (Hannah Yu, Moh Bility, Ellie Lebe,
Riya Mehta, Waylon Fletcher, David Shields, Nitro Tuggle, Isla Silva). Only Sammy Smith came back MEDIUM, with a namesake
collision reported. On dev, 42 of the 44 current ledger rows are HIGH. **As a signal, HIGH carries almost no information.**

---

## 2. Identity information Nomila already holds

Dev has 57 athlete rows. 44 of them have a current M.I.A. ledger row. Of the 57, 17 have an `auth_id`, and 14 have
`athlete_users` memberships.

| source | authority | dev availability | athlete-confirmed? | usable as anchor? |
|---|---|---|---|---|
| **connected_accounts** (active, IG/TT/YT/X, `platform_username`) + `social_identities` `connected_verified` | **Highest**: OAuth proves the athlete controls the account | **2 athletes** (Mia: IG+TT+YT; Aditya: IG). 4 `connected_verified` identity rows | Yes, by proof | **Yes.** Already in the prompt, but as metrics, not as an identity anchor. |
| **athlete_asserted** `sport` (live, not superseded) | Athlete's own words (onboarding/chat), receipted | **1 row total** (Aditya → "Basketball"). No asserted school, team or position on any athlete. Only 3 live asserted rows in the table. | Yes | **Yes, and it must override the column.** |
| **athlete_affiliations** `kind='said'` (current) | Athlete statement at signup. **But** on seeded demo rows (no auth), an operator wrote it | 18 current `said` rows. 5 are `"x"` placeholders. 4 real rows are on authenticated athletes (Mia: Stanford; Lilia: Century United; Aaron C-S Nguyen: Berkeley; zaengle: USC). 9 are operator-seeded demo rows. `position` 0/19, `role` 1/19, `level` 10/19 | Only when the athlete has a self membership | **Yes**, for said/proof rows on athletes with a self membership. Exclude placeholders (`x`). |
| athlete_affiliations `kind='proof'` | Contract names the team | **0 rows** | Yes | Yes, when they exist. |
| athlete_affiliations `kind='found'` | Research | 1 current (DeWanna Bonner). **Aditya has 5 ended `found` rows, all from a namesake** (Malvern Prep, Lionville SC, Solon HS ×2, Fritz-Soccer-Team) | No | **Never.** This is the namesake-pollution source. |
| athletes.school / division / conference | Projection of the primary current affiliation (schema comment) | school 19/57 (5 are `x`), division 11, conference 11 | Same as the affiliation it projects | Read the affiliation row instead. |
| athletes.sport | Column; should follow the asserted sport (`server/mila/onboarding.ts` header) | 52/57 | Mixed | Only after the asserted-sport override. **Aditya is the counter-example.** |
| athletes.socials (jsonb) | Self-typed at the landing page or seeded; unverified | 9 athletes | Typed, not proven | **No** (a typo anchors to a stranger). Candidate for later. |
| identity claims / Athlete Index (Step 3: `identity_claims`, `athlete_index_matches`) | Claim proof ladder | **0 claims**; 9 index matches, all `candidate / proof=none / possible_duplicate` | — | **No.** Nothing is confirmed. `ATHLETE_INDEX_CLAIM` is on dev, but no claim has been made. |
| athlete_research_state.identity_confidence | Research lifecycle | **0.00 for all 35 rows** | — | No (never populated). |
| athlete_facts (sport, position, hometown, birth_year, nationality, class_year) | `origin='backfill'` from legacy research: sport 26, birth_year 27, nationality 25, hometown 24, position 16, class_year 1 | No | No. Research-derived, so it has the same namesake risk. |
| research_evidence (affiliation 45, identity_signal 16, profile_attribute 54, social_handle 40) | Research lineage (`native_supported` / `asserted_only`) | Mostly cohort athletes | No | No |
| social_identities `platform_public` (0.70) / `web_researched` (0.70) | Research or discovery | 8 rows / 7 athletes; 2 rows (Aditya IG+TT, unverified) | No | No |
| legacy research snapshot (`athlete_snapshots.research`) | Legacy research, and **namesake-polluted for Aditya** (audit §2.4) | Real college athletes are coherent | No | No |

**The anchor set that is both confirmed and available is small:** a connected handle (2 athletes), an asserted sport
(1 athlete), and said/proof affiliations on self-member athletes (4 real ones). Every research-derived field is
excluded by design. **Research is where namesakes come from.**

---

## 3. Options for the smallest anchor

### (a) IDENTITY ANCHOR block in the prompt, with an instruction that evidence must match it

- **What:** render athlete-confirmed anchor facts (each with its basis) next to Name/Sport. Instruct the evaluator to
  research *that* person, reject sources about non-matching namesakes, and give HIGH only when cited non-platform
  evidence matches an anchor. Add `anchor_match` + `anchor_evidence_ids` to the output.
- **Would it have caught Aditya?** Partly by itself. With the anchor saying "Basketball (athlete-stated)" and
  "IG @fightquant (OAuth)", a Goa soccer goalkeeper matches neither anchor. The expected output is LOW or UNVERIFIED, not
  a confident namesake.
- **Cost:** **prompt text change** → `blind-eval-spec/0.2.1` → `0.3.0`, new canonical digest, new goldens bundle, and a
  new validation run. The snapshot digest input and the snapshot row gain an `identity_block` (additive migration).
  The canonical text must also carry a **no-anchor fallback line**, like the social block's, so athletes with no
  anchors get a defined prompt.
- **Principle change:** the spec header says *"No Nomila data … ever enter the prompt"*, and the calibration harness
  says *"Anchors … never leave this function"*. Anchors are athlete-stated or ownership-proven identity facts. They are
  not scores, targets or predictions, so ADR-011's concern (M.I.A. consuming Nomila intelligence) is not engaged. It is
  still a deliberate reversal and must be recorded as a founder decision (ADR-017 amendment).

### (b) Structural gate (code only): refuse a HIGH identity that does not match the anchor

- **What:** after parse and before `scoreAndRecord`, compare the evaluator's cited evidence with Nomila's anchors. When
  they contradict, or HIGH is unsupported, record the run as `failed_identity`. Write no ledger entry and do not retry.
  Refuse, never rewrite. This is the same philosophy as `EvaluatorRefusedError`. The orchestrator still does not judge
  marketability.
- **Would it have caught Aditya without (a)?** Only through the sport check. His one non-sport anchor is the handle, and
  the evaluator *does* mention `@fightquant`, but only in E5, which echoes the supplied block (`source_type:
  "platform"`). A naive "does the output mention the anchor?" check therefore **passes** Aditya. The gate has to exclude
  platform-type evidence. Once it does, the handle requirement is too strict for real athletes whose press never cites
  their Instagram. On dev, Mia's handles appear nowhere in her evaluator output, and she is correct (her anchor match is
  Stanford).
- **Other gate hazards found in the data:** stale anchors are legitimate. Lara Somfai is anchored to Stanford, and the
  evaluator correctly reports her TCU transfer. Travis Hunter is anchored to Colorado and is now NFL. Caitlin Clark's
  anchor "Indiana Fever" is absent from the ledger `value` but present in the run `judgements`. So the gate must read
  `mia_evaluation_runs.judgements` (evidence is complete there; 0 of 59 runs have empty evidence), not the ledger
  projection. It must also accept a "former team" mention.
- **Cost:** no digest change. It needs design approval (it adds a run outcome), plus unit tests. `mia_evaluation_runs.status`
  has no CHECK constraint (0055), so no migration.
- **Limitation:** a gate only blocks. Without (a), a re-ask samples the same namesake again, so the athlete ends up
  with no score (honest, but empty).

### (c) Deterministic pre-resolution

- **What:** resolve the athlete's public identity before evaluating (a confirmed claim, a resolved official roster URL,
  or research identity ≥ threshold), and evaluate only resolved athletes, or pass the resolved profile URL.
- **Today:** nothing to build on. There are 0 identity claims, `research_state.identity_confidence` is 0.00 everywhere,
  and research is exactly where the namesakes come from. This becomes viable after Step 3c/claims and a research
  identity gate (`ONBOARDING_V3`). It is too large for this fix.

### Pre-work that is code-only and needs no ceremony (do first, whichever option wins)

- **Asserted sport wins.** In `buildEvidenceSnapshot`, when a live `athlete_asserted(field='sport')` differs from
  `athletes.sport`, either use the asserted value or return `null` with `skipped: "identity conflict"` (zero cost).
  Also fix the projection bug: Aditya's 21 Sep assertion (with an `agent_action`) never reached the column, and the
  25 Sep snapshots still sent `soccer`. This changes the prompt *values* but not the canonical text, so the freeze pin
  holds. It does change Aditya's snapshot digest, which is correct.

---

## 4. Recommendation: (a) + the (b) gate as one change under `blind-eval-spec/0.3.0`, after the sport pre-work

(b) alone cannot anchor, and (a) alone trusts the same self-report that was HIGH 36 of 37 times. Put together, the
evaluator is told whom to find and must declare what it matched, and code checks that the declaration is backed by a
cited, non-platform source. The gate reads the new `anchor_match` field, so it ships inside the same version bump.
Athletes with **no anchors** get the fallback line and pass the gate untouched, so the change is inert for them apart
from the fallback text itself (§5 measures this).

### 4.1 Anchor assembly (code; DRAFT)

`identityAnchorFor(athleteId)` returns lines in this order, each with a basis, and only these sources:

1. Sport: the latest live `athlete_asserted(field='sport')`, otherwise `athletes.sport`. Basis `athlete-stated` or `record`.
2. Current `athlete_affiliations` with `kind IN ('said','proof')`, only when the athlete has a self `athlete_users`
   membership. Skip placeholders (`org_name` shorter than 2 characters, or `x`). Render `org_name (org_kind[, level][, position])`.
   Basis `athlete-stated` or `contract`. Ended said/proof rows are rendered as `former:`.
3. Active `connected_accounts` handles. Basis `athlete-connected account (OAuth)`.

Never used: `found` affiliations, `athlete_facts`, research evidence, `platform_public`/`web_researched` identities,
`athletes.socials`. The rendered block goes into the snapshot row (`identity_block`, with `identity_sources` jsonb for
provenance) **and** into `snapshotDigest` (`{name, sport, socialBlock, identityBlock}`). `promptFor` gains the argument.
The trigger still has nowhere to go.

Rendered example (Aditya, after the sport pre-work):

```
IDENTITY ANCHOR

Facts about the athlete to evaluate, held by Nomila from the athlete themself or from an account the athlete has proven they own.
- sport: Basketball — basis: athlete-stated
- instagram @fightquant — basis: athlete-connected account (OAuth)
```

### 4.2 Proposed evaluator text (DRAFT, appended as v0.3 ADDITIONS; the v0.1 text and the v0.2/0.2.1 additions stay verbatim)

```
==================================================
ADDITIONS (v0.3) — identity anchoring; everything above is unchanged
==================================================

IDENTITY ANCHOR (optional input)

When a block titled IDENTITY ANCHOR is supplied with the athlete, it lists facts that identify WHICH person to
evaluate: facts the athlete stated themself, or an account the athlete has proven they own. Each line states its
basis. Anchor facts identify the athlete; they are not evidence of marketability and never raise or lower a score on
their own.

- Many athletes share a name with other people, including other athletes in the same sport. Research the person the
  anchor describes.
- Before relying on a source, check that it is about the anchored person: it should agree with at least one anchor
  fact (team or school, sport, position, or handle) and contradict none. A source about a same-named person who does
  not match the anchor is about a different person: do not cite it and do not score from it.
- Anchors can be out of date. An athlete may transfer, turn professional or retire. A source that names a different
  current team does not contradict the anchor when it also records the anchored team as a former one.
- Set athlete.identity_confidence to HIGH only when at least one cited evidence item, other than the supplied social
  data, independently matches an anchor fact. If you cannot find such evidence, set it to LOW, say "identity not
  corroborated against the anchor" in identity_or_evidence_risks, and mark signals MISSING rather than scoring a
  namesake. Supplied platform metrics remain usable for the signals they cover.
- Add to "athlete": "anchor_match": "MATCHED|UNVERIFIED|CONTRADICTED" and "anchor_evidence_ids": [the ids of evidence
  items that match an anchor fact]. MATCHED means such evidence exists; CONTRADICTED means the only same-named person
  you found is inconsistent with the anchor; UNVERIFIED means neither.
```

The no-anchor fallback, which also becomes canonical text:

```
IDENTITY ANCHOR

No athlete-confirmed identity facts are available for this athlete.
```

Ceremony: amend (the text above plus the `promptFor`/snapshot/digest plumbing) → bump `BLIND_EVAL_SPEC_V02_VERSION`
to `blind-eval-spec/0.3.0` (this re-labels `EVALUATOR_VERSION` on every run and ledger row) → unpin
(`BLIND_EVAL_SPEC_V02_CANONICAL_SHA256 = "UNPINNED"`) → parity tests. These assert each sentence above, the survival of
every v0.1/v0.2/v0.2.1 passage, the fallback line, and that `promptFor` still has no trigger parameter → exact-text
review of the rendered canonical text → repin. The 0.2.1 digest `167e6c50…` and its dev37 goldens stay as the historical
record. The freeze test gets a 0.3.0 bundle from the new run (§5), under a new artifact tag.

### 4.3 Proposed gate (DRAFT, code, runs between `evaluate` and `score`, no provider call)

```
IDENTITY GATE — blind-eval-spec/0.3.0
Input: the snapshot's identity_sources (structured anchors) and the parsed run judgements (not the ledger projection).
1. No anchors supplied                     → PASS (unchanged path).
2. anchor_match = "CONTRADICTED"           → status "failed_identity", error "evaluator reported the anchor
                                              contradicted"; no ledger entry; not retried.
3. identity_confidence = "HIGH" and NOT (≥1 id in anchor_evidence_ids that exists in evidence[], has
   source_type ≠ "platform", and whose claim / source_title / source_url contains a normalized anchor token:
   an org-name token of ≥3 chars outside a stop-list {university, of, the, school, high, college, club, fc, sc,
   team}, or a handle, or the anchor sport)
                                           → status "failed_identity", error "HIGH identity without
                                              anchor-matching evidence"; no ledger entry; not retried.
4. Otherwise                               → PASS; MEDIUM/LOW are recorded exactly as the evaluator said.
```

A `failed_identity` run leaves any previous assessment standing, the same way a refusal does. Surface it in admin as
"identity unresolved". A new trigger that changes the digest (for example, the athlete adds a team) asks again.

---

## 5. Re-validation (REQUIRES FOUNDER APPROVAL before any provider call)

**Corpus and harness that exist:** `server/scripts/calibration/cohort.dev37.json` (37 athletes; 28 carry a descriptive
`anchor` (drafted *"for founder confirmation"*; only 12 also have a `currentAffiliation`, since many are retired); 9 carry
only `"<sport> athlete"`, five of them deliberate identity stress tests);
reference targets in `server/services/marketabilityBeta1Benchmark.ts`; 0.2.1 artifacts
`server/scripts/calibration/runs/blind-eval-v2/gemini/<key>.dev37.{raw,parsed}.json`; runner
`blindEval/runBlindEval.ts` (`--spec`, `--cohort`, `--tag`, `--keys`; social blocks from files); analysis
`blindEval/dev37Report.ts` (Spearman, MAE, slope, identity, social M/E/Miss); goldens
`generateBeta1Goldens.ts` → `marketabilityBeta1.goldens.json`; gates `marketabilityBeta1Freeze.test.ts`,
`…Evaluator.test.ts`, `…Orchestrator.test.ts`, `…GoldenPath.test.ts`, `…BenchmarkValidation.test.ts`,
`…CanonicalQuarantine.test.ts` (the withdrawn deterministic path stays quarantined; this change must not import it).
**The 21-athlete holdout (`marketabilityHoldout.ts`) stays unspent.** Mia Carona is not used, even though she is the
holdout's own namesake example.

Harness change needed: `runBlindEval.ts` gains `--spec v0.3` and reads an identity block per athlete from a file
(`anchors.dev37/<key>.txt`), the same way social blocks are read, rendered by the same function as production.

**Per-call cost (recorded):** dev `mia_evaluation_runs`: 59 ok runs, mean **$0.209** (min $0.164, max $0.251). One
failed_validation cost $0.197. The frozen dev37 run: 37 calls, **$7.77**, mean $0.210. Mean usage ≈ 3.5k prompt, 6.8k
output and 12.0k thought tokens, 12.7 searches, 96 s.

| arm | athletes | calls | est. cost |
|---|---|---:|---:|
| **A. Cohort parity** | All 37 dev37 athletes on 0.3.0. The 28 with a descriptive anchor get an IDENTITY block of structured lines (sport, current or `former:` team, position), derived from the drafted anchor. The founder confirms these first, because they stand in for athlete-stated facts. The 9 `"<sport> athlete"` athletes get the no-anchor fallback. | 37 | $7.77 |
| **B. Wrong-person set** | Aditya ×2 (asserted Basketball + @fightquant); Aditya ×1 with the stale `soccer` sport (isolates prompt effect from data fix); Sammy Smith anchored "Stanford Cardinal" ×2 and "Boston Legacy (NWSL)" ×2 (both real namesakes, so the anchor must select); negative controls with a deliberately false anchor ×2 each: David Shields + "Stanford Cardinal, catcher", Hannah Yu + "Harvard Crimson", Mia Bhuta + "University of Texas"; stale-anchor controls: Lara Somfai + Stanford, Travis Hunter + Colorado; positive control: Mia Bhuta + Stanford + connected IG/TT/YT | 18 | $3.78 |
| **C. Dev live check** | After deploy to dev only, forced refresh of the 12 dev athletes that have anchors (Aditya, Mia, Lilia, Lara, Matt, Chisom, Anthony, Arch, Caitlin, JuJu, Livvy, Travis) | 12 | $2.52 |
| **Total** | | **67** | **≈ $14.1** (≈ $15.5 with a 10% parse-retry allowance; request a cap of **$20**) |

Note: the digest now includes the identity block, so every athlete's next *trigger* re-evaluates (up to 44 × $0.21 ≈
$9.2 on dev over time). A digest change is not itself a trigger, so nothing cascades automatically.

**Pass criteria (all must hold; otherwise do not repin):**

1. **Rank validity:** Spearman vs reference targets on arm A ≥ **0.86** (0.2.1: 0.887). Median absolute error ≤ **60**
   (0.2.1: 53). Regression slope within 0.70–1.00 (0.2.1: 0.801).
2. **Score stability:** per-athlete |MIA(0.3.0) − MIA(0.2.1)| median ≤ **25**, against a measured repeat drift of 20.5.
   No athlete with a real, correct anchor moves more than **80** unless the evaluator's identified person changed and
   the change is explained in the review.
3. **Identity honesty:** the 28 anchored athletes stay HIGH + MATCHED (≥ 26/28), and **0** of them
   `failed_identity` (the gate's false-positive rate). The 9 no-anchor athletes are reported as a distribution (not
   gated), compared with 8/9 HIGH under 0.2.1.
4. **Wrong-person set:** **0** HIGH evaluations of a person contradicting the anchor. Every false-anchor control ends
   `CONTRADICTED` or `UNVERIFIED` with identity ≤ LOW, or `failed_identity`. Aditya is never the Goa goalkeeper.
   Sammy Smith's two anchors produce two different people. The stale-anchor controls pass the gate (MATCHED via
   "former").
5. **Mechanics:** parse/refusal rate ≤ 1/37 (0.2.1: 0 on dev37, 1/43 in the 43-athlete run). All 44 sub-signals are
   still present. The existing freeze, golden-path and quarantine suites are green on 0.3.0.

**Gating score convergence:** after 0.3.0 is repinned, the v7.2 (672) vs M.I.A. (624) convergence work for Mia can use
M.I.A. as the reference. Until then, M.I.A. numbers for athletes without a corroborated anchor should not be used to
retire or re-weight v7.2.

---

## 6. Dev athletes at risk now (read-only ledger query, 27 Sep)

- **Current M.I.A. ledger rows: 44.** identityConfidence: HIGH 42 · MEDIUM 1 (Sammy Smith, collision reported) · LOW 1
  (Riya Mehta; her three runs were HIGH, LOW, LOW, so identity is unstable across samples).
- **Anchored athletes (any confirmed or seeded anchor): 12.** Checked against the run judgements:
  - **Confirmed wrong-person, HIGH: 1. Aditya Sharma.** The asserted sport (Basketball) contradicts the evaluation
    (soccer goalkeeper). The only non-sport anchor (@fightquant) appears solely in echoed platform evidence. The
    evidence URLs are bare domains (`gfagoa.com`, `heraldgoa.in`, `thegoan.net`).
  - Matched: 11. Stale but correctly handled: Lara Somfai (TCU transfer), Travis Hunter (NFL). The org is present in
    the judgements but missing from the ledger `value`: Caitlin Clark, Travis Hunter.
- **Unanchored and uncheckable: 32.** These are cohort-seeded rows with no Nomila anchor. 30 are HIGH. The namesake-risk
  subset is athletes with a minimal public footprint and HIGH identity: **Hannah Yu, David Shields, Ellie Lebe, Isla
  Silva, Moh Bility, Waylon Fletcher, Nitro Tuggle (7)**. The evaluator itself noted "overlap with unrelated
  individuals" for Hannah Yu and "older amateur players named Waylon Fletcher" for Waylon Fletcher, yet stayed HIGH. They
  cannot be classified as right or wrong without an anchor. Plus Riya Mehta and Sammy Smith, where the evaluator was
  already honest.
- **Upstream pollution to clean separately:** Aditya's 5 `found` affiliations are namesake rows, and so are 2
  `web_researched` social identities. None of these may ever feed the anchor.

**At-risk count: 1 confirmed (Aditya), 7 plausible and unverifiable.** The confirmed case is live today. Aditya's 412
is the current ledger row and feeds State.

---

## 7. Order of work (each step a separate, approved PR)

1. **Pre-work (code only, no ceremony):** asserted sport wins (snapshot guard + projection fix). Test that Aditya's
   snapshot sends Basketball or skips. No provider call.
2. **Design approval** of §4 (anchor sources, text, gate) and the ADR-017 amendment. Founder confirms the dev37
   drafted anchors used in arm A.
3. **Implement under the ceremony** (unpinned during review): migration (additive `identity_block`, `identity_sources`
   on `mia_evidence_snapshots`, dry-run with BEGIN…ROLLBACK per file), `identityAnchorFor`, digest, `promptFor`, gate,
   parity tests, harness flag.
4. **Founder-approved provider run** (§5, ≈ $14, cap $20), then the report via `dev37Report.ts`, then exact-text review,
   then repin. Only then deploy to dev and run arm C. Prod stays untouched until a named command.
