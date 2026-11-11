# Targeted intelligence audit — what Objectives actually need from outside

**Owner:** Mia
**Date:** 2026-09-23
**Question:** *What is the minimum additional external intelligence required between the athlete intelligence we already produce and recommending Objectives?*
**Method:** the existing seam re-read verbatim; the thirteen frozen Run 3 opportunities classified one by one. Nothing implemented, nothing researched, nothing changed.
**Supersedes** the over-broad "next moves" in `strategic-sufficiency-audit.md` §4.9 — move 5 there implied a platform. It should not have.

---

## 1. The seam already exists, and it says what it is for

`contracts/opportunity.ts`, written in PR2 under refinement #6, verbatim:

> `strategyIntelligence` — versioned shared knowledge about how athletes build value — practitioner playbooks, athlete-brand and career-development frameworks, and current trends across sponsorship, NIL, creator businesses, direct-to-fan and athlete-owned ventures. **Refreshed periodically for everyone, never researched per athlete.**
>
> `targetedResearch` — **fresh external investigation where a specific athlete or opening warrants it.**
>
> ONE RULE GOVERNS BOTH: external intelligence may inform judgment, and may **NEVER overwrite or contradict an athlete-specific fact in State.** State is authoritative about the athlete; the world is authoritative about the world.

Three facts about it that decide the design:

1. **It is on the Opportunity evaluator's input**, not between Opportunity and Objectives.
2. **"or opening"** — targeted research was designed to be triggered *by* an opportunity, which is exactly the "validate the opening, not the whole market" idea.
3. **Ordering is enforced by test**: the state block is read before any world block, so the athlete's facts come first.

The frozen prompt (`opportunity-eval-spec/1.0.0` line 125) says *"You perform NO external research in this version."* Lifting that sentence is a methodology change → `1.1.0`, one bump, no reshape.

**So the seam is sufficient.** What is missing is not a slot but the thing that fills it: a step that turns a first-pass opportunity into a precise question, and a step that answers it.

### Where ChatGPT's flow diverges from the seam, and why it matters

The proposed flow inserts *"Strategic Research / Opportunity Validation"* **after** Opportunity and **before** Objectives, as a new stage. The seam we built puts research **into** Opportunity. These reconcile as a **two-pass Opportunity**:

```
State ──► Opportunity pass 1 (research slot null)
              │
              ▼
        question generation   ← from B/C opportunities only
              │
              ▼
        targeted research     → { version, block }
              │
              ▼
State ──► Opportunity pass 2 (research slot populated, 1.1.0)
              │
              ▼
        ObjectiveProposal
```

Pass 2 is the "validation": an opportunity that pass 1 asserted and the research contradicts is downgraded, dropped, or has its confidence cut — by the same evaluator, under the same grounding gate, with the research citable. **No new layer, no new contract.** The Objective evaluator's inputs stay exactly `State + OpportunityMap`.

---

## 2. The thirteen, classified

**A** — State/internal evidence is sufficient; no external question. **B** — would materially benefit from one targeted question before becoming an Objective candidate. **C** — cannot responsibly support an Objective without validation.

| # | athlete | opportunity | class | the smallest question, or why none |
|---|---|---|---|---|
| 1 | Mia | GROW · audience — reverse cooling growth | **A** | Internal. Trajectory, engagement and (once projected) composition are all in State. "What is working for comparable athletes" is *execution* intelligence, later |
| 2 | Mia | AMPLIFY · positioning — academic/athletic trailblazer → tech & education alignments | **B** | *Are technology or education brands currently activating with student-athletes or academic-achievement narratives in US sports — and is "scholar-athlete" positioning differentiated, or already common among comparable athletes?* |
| 3 | Mia | AMPLIFY · impact — Yuwa as co-branded initiative | **B** | *Which brands run active girls'-sports, women's-sports or South Asia impact initiatives, and do any partner with individual athletes on them?* |
| 4 | Mia | UNLOCK · evidence — private metrics + Adidas terms | **A** | Internal, and the blocker is the athlete: ask her |
| 5 | Riya | GROW · evidence — identity disambiguation | **A** | Internal; ask/verify. Ground truth already confirms the US candidate |
| 6 | Riya | GROW · evidence — verify accounts | **A** | Internal; ask |
| 7 | Lilia | GROW · audience — parent-supervised socials | **A** | Internal. The one external question — platform age/guardian rules — is *compliance at execution*, not strategic validation |
| 8 | Lilia | GROW · positioning — dual narrative with sister | **B** (light) | *Is a sibling/family-legacy narrative commercially used with youth athletes, or is it a media curiosity that does not convert?* — low priority; the larger unknown is guardian intent, which is a question to the family, not the market |
| 9 | Lilia | UNLOCK · evidence — Hudl + family YouTube metrics | **A** | Internal |
| 10 | LeBron | UNLOCK · evidence — private IG | **A** | Internal |
| 11 | LeBron | AMPLIFY · content — football content for Polymarket | **C** | Cannot support an Objective — but the blocker is **not market research**. It is the deal's actual terms (what content is contracted), which are private and only the athlete's side can supply. External research cannot resolve it |
| 12 | LeBron | MAINTAIN · athletic — availability | **A** | No market question; and out of Nomila's remit |
| 13 | LeBron | FIX · commercial — reconcile Nomila's records | **A** | Internal — Nomila's own data |

**A 9 · B 3 · C 1.** Three research questions in total, all in `positioning`/`impact`, two of them Mia's. The only C is blocked by an athlete-side fact, not by the outside world.

**This is the answer to "how much research is actually necessary."** For the frozen four, nine of thirteen need none. The three that do share one shape: *is this territory real, and is it hers?*

---

## 3. What Objectives needs from outside — now

Collapsing ChatGPT's five into what the three B questions actually require:

| category | needed now? | note |
|---|---|---|
| **territory activity** — are brands/categories active around this strategic territory? | **yes** | the core of all three B questions |
| **differentiation / whitespace** — is this hers, or common among comparables? | **yes** | the second half of #2 and #8 |
| **precedent** — has this asset type produced commercial or cultural value before? | **yes, folded into the above** | rarely a separate question |
| **material timing** — an externally grounded moment that changes the opening | yes, **when it exists** | none of the thirteen turned on one; keep the category, expect it to be empty often |
| **brand-demand evidence** | **mostly internal** | for Mia this is the inbox (227 threads, dropped). External only for a territory the inbox does not cover |
| contradictory market evidence | not a category — it is the *outcome* of the above | pass 2 downgrades or drops |

Four external categories, one of which is usually empty. **Not "Bloomberg for athlete marketing."**

---

## 4. What waits for Plan / Campaign / Content / Deal

Explicitly not Objectives' business — boundary only, no design:

live social trends · trending formats and audio · content competitive analysis · campaign ideation · current creative patterns · event-by-event content opportunities · outreach target generation · campaign execution research · platform compliance for minors · league/team calendar for scheduling · rate benchmarks (Rate's job) · cross-athlete Nomila marketplace intelligence (a later proprietary asset; the dataset is small today).

---

## 5. Where the athlete speaks, and the rule that keeps it grounded

Three points, two of them questions and one a decision — and they already map onto the lifecycle in `objectives-contract.md`:

| when | what Nomila does | generated from |
|---|---|---|
| **after State, before Opportunity** | *verify* — "We believe Adidas is an active relationship; is that right? When does it end?" *fill* — "We don't have your audience data; connect Instagram?" | `materialGaps`, `evaluationRisks`, `missingEvidence`, absent `wants` |
| **after Opportunity pass 2, before Objectives** | *contextual, high-information* — "Your impact work could become a much larger part of your public platform. Do you want that, or keep it separate?" | opportunities whose outcome hinges on a preference State does not hold (`athleteStance` absent) |
| **after ObjectiveProposal** | *decide* — accept / decline / modify / "you're missing this" | the lifecycle: `unreviewed → accepted \| declined \| modified` |

**The rule:** an athlete's answer is written to `athlete_asserted`, State is rebuilt, and the evaluator runs on the new State. **Answers flow through State, never directly into an evaluator.** Otherwise a question's answer is uncitable, and the grounding gate — the thing that has caught every real failure so far — is bypassed. This is the same principle as the research slot: the evaluator sees only what it can cite.

That is "intelligence precedes the questions": every question is generated from a specific gap in a specific athlete's picture, not from a fixed list.

---

## 6. Legacy goals — a correction to the sufficiency audit, with one disagreement

`goal_archetype` and `secondary_goals` came from the old fixed onboarding. **They are not the new Objectives model**, and the sufficiency audit should not have implied they were.

**One disagreement with "preserve as historical context only":** if they are not projected into `preferences`, the Objective intent path stays at zero for every athlete — the contract requires `fromAthleteIntent` to resolve to a `wants` preference. The contract already carries provenance on every preference (`source: EvidenceRef`). So the right handling is **bring them through, labelled** — `source: onboarding_v1`, stance `wants` — so the evaluator can weigh *"she said 'grow my following' in a fixed questionnaire"* as exactly that: thin, historical, hers. Not dropped, not elevated. A later contextual answer supersedes it through the normal `athlete_asserted` supersession.

---

## 7. The smallest architecture change

**To contracts:** none. `OpportunityEvidence.targetedResearch` is the seam; `ObjectiveProposal` is unchanged.

**To the frozen Opportunity prompt:** one bump to `1.1.0`, lifting *"You perform NO external research in this version"* and stating how research is cited — it is a `sources[]`-class input, and it may never overwrite a State fact (the rule is already in the prompt).

**New, and small:**
1. **A question-generation step** after Opportunity pass 1 — from B/C opportunities only, emitting the kind of question in §2. Deterministic where it can be (an opportunity in `positioning`/`impact`/`commercial` with no `athleteStance` and no internal demand evidence → ask the territory question); an evaluator only if that proves too crude.
2. **A research executor** that answers a question into `{ version, block }` with sources — the same shape Rate's `MARKET_SOURCES_BLOCK` already uses, per athlete instead of shared.
3. **Athlete-question generation** from State gaps and pass-2 stances, feeding `athlete_asserted` — a Mila/product concern, contract-light.

**And, before any of it, State 1.2 narrowed as ChatGPT proposed** — inbox demand summary, audience composition, current representation/commercial preferences, real-world dates, richer social signals where strategic — with legacy goals labelled per §6.

Expected effect on the frozen four: nine opportunities proceed on internal evidence; three get one question each; one is blocked on a fact only the athlete has. **That is a targeted research pass at the right point in the existing system, not a missing system.**
