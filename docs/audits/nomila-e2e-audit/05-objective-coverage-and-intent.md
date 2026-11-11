# 05 — Objective coverage and upstream athlete-intent acquisition (Agent E)

**Scope:** does Nomila have a reliable way to establish what the athlete wants Nomila to accomplish, and does that reach Objective generation? This is a diagnosis of inputs and coverage only. It proposes no change to Objective semantics.
**As-of:** working tree `3f0139f6` (stack tip #665) unless a line says `main 9fff9b15`. Dev DB read-only, queried 2026-09-27 through the cloud-sql proxy (SELECT-only scripts `_audit_q_E_*.ts`, now deleted). Nothing was written except this file.

---

## 1. Summary

1. **The only strategic intent Nomila holds for Mia is two fixed-set signup choices from 30 May 2026: `grow_my_following` and `get_my_first_deal`.** Nothing else she wants, rules out, cares about, or aims for is in any table the intelligence chain reads. — onboarding goals: `BUILT · MAIN · deployed-dev`. Richer intent capture: `MISSING`.
2. **The designed "get to know you" onboarding was never built.** Onboarding v2 has two steps, `greet` and `doors` (`server/mila/onboarding.ts:101`). The file itself says the brands/causes, hobbies and "anything else" questions "are PR 4 and are not asked here" (`onboarding.ts:6-8`). PR 4, the Brand Layer (`athlete_narratives`), Brand Direction and `brand_relationships` have no table in `shared/schema.ts` and no commit on any branch. — `DESIGNED · DESIGN_DOC_ONLY` (memory design notes; artifacts af64dbf2, f0677dea, ef8b5b79, 27e6e18f).
3. **Across the whole dev DB there are 3 `athlete_asserted` rows.** Mia has one: a `note` about Adidas and Nike. Another athlete has a `sport` correction, and a test athlete has a `cadence` test value. There are 0 rows for `brands_wanted`, `never_post`, `brands_causes`, `hobbies` or `brand_voice`. The capture doors exist, as the Facts "What you want" group and the chat confirm cards, but they are passive and unused. — `BUILT · MAIN` (behind a device-local Brand-tab switch that defaults OFF, `client/lib/brandTabFlag.ts:8`). Usage is effectively nil.
4. **Even when intent is captured, State drops most of it.** `preferencesFrom()` keeps only asserted fields whose *name* matches `/prefer|want|avoid|refus|wont|won_t|interest|goal/` (`server/services/intelligence/state/build.ts:556`). So `never_post`, the only designed "what I don't want" field, never reaches State as `avoids`. It is not read as a constraint either: `constraintsFrom` matches `/availab|constraint|schedule|eligib/` (`build.ts:528`). `cadence`, `brands_causes`, `hobbies`, `note` and `brand_voice` are also dropped. Mia's Adidas `note` is invisible to Opportunity and Objectives. — `PARTIAL · MAIN`.
5. **Goal slugs are always labelled `onboarding_v1_choice`, whatever door wrote them.** `onboardingPreferencesFrom` reads the `athletes.goal_archetype` and `secondary_goals` columns (`build.ts:379-393`). A chat or Settings write to `goal` updates that column (`onboarding.ts:77`), so the label is wrong for it. A goal written through the ledger would also appear twice: once as the column preference, once as the asserted `goal`. Another athlete's `secondary_goals` holds free prose, "only work with fitness and wellness brands". That is a restriction, but State would project it as stance `wants`. — latent defect, `BUILT · MAIN`.
6. **Mia's stated intent is stale and contradicted by her own record.** `get_my_first_deal` (chosen 30 May) sits beside an accepted gorjana deal (created 29 Jul, dev `deals`) and her own 7 Sep statement "I have a personal contract wiyh adidas". The evaluator still cited it as her explicit wish to justify the StartX1 and tech-partnership proposals. There is no staleness or recency handling for intent. — `MISSING`.
7. **What reaches Objective generation:** the rendered State block (preferences = those two onboarding choices) plus the Opportunity Map, and nothing else (`server/services/objectiveBeta1Orchestrator.ts:80-88`). Chat history (786 user messages over 30 conversations for Mia), voice memory (14 `voice_context` rows), her Objective decisions and her modified wording, deal floors in their product sense, and the Brand/Record layer all do NOT reach it.
8. **Mia's live portfolio is the governed survivors of one evaluator batch.** All three live Objectives, plus the deferred and the declined one, come from proposal set `5dd8bdcc` (`objective-eval-spec/1.0.1`, over `opportunity-eval-spec/1.0.0`, State as of 23 Sep). The two later sets (`87c095ff`, `1916e5cc`) are the same re-run output materialised twice. They created 0 rows and only wrote reconciliation events. **Hypothesis CONFIRMED** (§4).
9. **Her portfolio is not an Objective 1.0.4 product.** Every persisted proposal set on dev is 1.0.1. Mia was never re-run under 1.0.2, 1.0.3 or 1.0.4 ("LeBron ×2, Mia: not in the cohort, not exercised", `docs/audits/objective-1.0.4-cohort-evaluation.md` §4). `main 9fff9b15` pins Objective **1.0.2** and Opportunity **1.0.0**. — contradicts the control file's framing (§6).
10. **Her own words exceed what the system knows.** Her three modifications widened the proposals to "technology, AI, innovation and entrepreneurship" and to "my work with Yuwa". At the same moment the Opportunity evaluator was writing "no recorded active, planned, or desired owned business ventures" and that impact "lacks specific targets" (1.2.0 Mia notes, `docs/audits/artifacts/opportunity-1.2.0-forcing/Mia_Bhuta.json`). Her modified Objective wording never flows back into State preferences, so the next Opportunity run cannot see it. Under 1.2.0 the impact opening disappeared entirely while she holds a live impact Objective.
11. **An athlete-created Objective path exists at the API level and has never been used.** `POST /api/v1/me/objectives` → `athleteObjective()` (`server/routes/objectives.ts:85`, `objective/entity.ts:109`), behind `OBJECTIVES_V1=true` on dev (`gcp/cloud-run-dev.yaml:289`). The client has no caller: `client/hooks/use-objectives.ts` wraps only GET and decision. Dev has 0 `origin='athlete'` Objectives and 0 `created` events. Mila has no tool for it. — `BUILT · MAIN · deployed-dev · flag:OBJECTIVES_V1=on(dev) · no UI`.
12. **The Brain's acquisition seam can ask the athlete exactly one intent question.** `athlete_capability_intent` → `cadence` (`server/workflow/definitions/intelligenceAcquisition.ts:34`). `cadence` has no State reader, by its own comment. There are 2 runs on dev, both on a test athlete. It cannot ask about ambitions, refusals or causes. — `EXPERIMENTAL · OPEN_PR (not on main) · test-harness-only`.
13. **There is no proactivity or autonomy setting anywhere.** There is no per-athlete `tap_to_send` column and no proactivity field in `shared/schema.ts` (grep for `tap_to_send|proactiv|autonomy` found nothing). `server/lib/sendGate.ts` is a structural send-path gate, not a preference. "Tap to send" survives only as a planner gate type (`server/services/intelligence/planner/contract.ts:26`) and as a standing product rule. — `MISSING`.
14. **Answer:** No. Nomila does not currently have a reliable way to establish what an athlete wants Nomila to accomplish. On whether onboarding should provide richer strategic intent before Objective generation, the evidence supports yes (§5).

---

## 2. Intended vs built: how onboarding and first Mila were meant to establish intent

| intent area (brief) | what was intended (source) | what is built (status · location) | evidence |
|---|---|---|---|
| **Who I am** | Landing 1–5 → first-look + research at connect → forced first Mila conversation: greeting + "what we know", athlete reacts, Mila writes corrections without a tap (onboarding design v3.3, 3 Sep; PR 3 note) | Greet + corrections + two doors. `BUILT · MAIN · deployed-dev`. Only Mia (v2, 7 Sep) and one test account have completed v2. Lilia ran v1 only (no conversation). `ONBOARDING_V3=false` | `server/workflow/definitions/onboarding.ts:115-199`. Dev `workflow_runs`: onboarding v1 ×2 (Lilia, Mia 3 Sep), v2 ×2 (Mia 7 Sep, test 21 Sep). `gcp/cloud-run-dev.yaml:293` |
| **What matters to me / causes / interests** | Discover step: "brands you love & causes", "outside your sport: activities/hobbies", "anything else" (4 Sep revision; values derived, never asked) | `DESIGNED · DESIGN_DOC_ONLY`. The fields exist in the vocabulary (`brands_causes`, `hobbies`, `onboarding.ts:86-87`) but no step asks for them. 0 rows on dev | `onboarding.ts:6-8, 101`. Dev `athlete_asserted` field counts |
| **What I want to accomplish** | Five goal slugs at signup (active) or four (retired); the Brand Direction design called them "too coarse" and proposed two concrete follow-ups | Slugs `BUILT · MAIN`. 9 of 57 dev athletes have `goal_archetype`, 5 have `secondary_goals`. The two concrete questions are `DESIGN_DOC_ONLY` | `shared/goals.ts:15-28`. Dev `athletes` query. Memory `brand-direction-design.md` |
| **What I don't want** | `never_post` list; Direction `ease_off`/`guardrails`; brand-controversy hold | `never_post` is in the vocabulary and on the Facts screen: `BUILT · MAIN`, 0 rows. **State drops it** (§1 item 4). Direction and guardrails: `DESIGN_DOC_ONLY` | `onboarding.ts:83`. `server/services/athleteRecord.ts:268`. `build.ts:528,556` |
| **Commercial aspirations** | `brands_wanted`; `brand_relationships` table (`endorsed / promoted / wanted`); Direction `to` (12-month positioning) | `brands_wanted`: `BUILT · MAIN`, 0 rows (it would reach State as `wants`). `brand_relationships`: `MISSING` (no table, no commit). Adidas lives only as a free-text `note` | `onboarding.ts:82`. `grep pgTable shared/schema.ts`. Dev `athlete_asserted` |
| **Audience / content ambitions** | `cadence` ("posts a week you keep"); Direction cadence floor | `cadence` `BUILT` (ledger). No State reader, by design (`intelligenceAcquisition.ts:31-33`). 1 test row | as cited |
| **Career ambitions** | Research scope + Direction; `career_status` declared | Only `career_status` (active / between / out / retired) is `BUILT · MAIN`. No career-ambition field anywhere | `shared/goals.ts:61-66` |
| **Brand voice / narrative** | Brand Layer: 7 registry prompts, `athlete_narratives`, voice proposed from captions then confirmed | `brand_voice` field + confirm card `BUILT`. Mia's is NULL; one athlete on dev has it (`{"tone":"bold and direct"}`). Nothing in the intelligence chain reads it (not in `buildAthleteState`). Layer `DESIGN_DOC_ONLY` | dev `athletes.brand_voice`. `build.ts:130-133` |
| **How proactive Nomila should be** | Per-athlete `tap_to_send` field, default ON, read by the one send gate (tap-to-send rule, 4 Sep) | `MISSING`: no column, no setting. The rule is enforced structurally per surface | grep of `shared/schema.ts`. `server/lib/sendGate.ts:1-40` |
| **Ongoing intent capture in chat** | profileExtraction proposes `goal` / `secondary_goals` / `brand_voice` / achievement, written only on a confirm tap | `BUILT · MAIN` (`server/routes/chat.ts:310`). It is the source of the prose restriction stored as a `secondary_goal`. Mia: nothing captured from 786 user messages | `server/mila/profileExtraction.ts:30-43`. Dev query |

---

## 3. What is captured today (dev) and what reaches Objective generation

### 3.1 Captured

| store | Mia | other athletes | reaches State? | reaches Objective evaluator? |
|---|---|---|---|---|
| `athletes.goal_archetype` / `secondary_goals` | `grow_my_following` / `["get_my_first_deal"]` (30 May) | 9 / 5 of 57 set. One holds prose ("only work with fitness and wellness brands") | yes, as `preferences[onboarding_goal.*]`, stance `wants`, labelled ONBOARDING CHOICE (`build.ts:379-393`) | yes (via State block). Cited in 3 of 5 batch-1 proposals |
| `athlete_asserted` | 1 row: `note` "Personal contract with Adidas; Nike is Stanford-affiliated" | 2 rows (a `sport` correction, a test `cadence`) | only fields whose name matches the regex. `note` does not | no |
| `athletes.deal_preferences` | agent, agency, 5 floors | — | yes, `representation` (`build.ts:479-489`). **SUPERSEDES** the sufficiency audit's "dropped" | yes, as State |
| `athletes.brand_voice` | NULL | 1 athlete | no | no |
| chat (`conversations` / `chat_messages`) | 30 conversations, 786 user messages | 3 athletes have any | no | no |
| `voice_context` | 14 rows (ids and enums only, by design) | — | no | no |
| Objective decisions and her words | 3 modifies, 1 decline with a reason, 2 defers with reasons (`objective_events`) | none | **no**: State never reads Objectives | only as reconciliation after the fact. The Brain reads live, deferred and declined (`brain/inputBlock.ts:17-48`) |
| Brand Layer / Direction / narratives / `brand_relationships` | none | none | — | — |
| proactivity / tap-to-send setting | none | none | — | — |

### 3.2 What the Objective evaluator is given

`evaluateObjectives(state, map)` renders two blocks and nothing else: `renderStateBlock(state)` and `renderOpportunityBlock(map)` (`objectiveBeta1Orchestrator.ts:80-88`). No tools. The spec lets recorded `wants` preferences create an Objective directly, and forbids inferring any intent ("An athlete who has stated nothing has stated nothing", `objective/evalSpec.ts` `OBJECTIVE_INPUTS_BLOCK`). The Opportunity evaluator sees the same "WHAT THE ATHLETE HAS SAID" section (`opportunity/stateBlock.ts:185-196`).

The contract works: intent → `fromAthleteIntent` → `joint` origin was exercised on Mia. But the intent it can carry is limited to the two slugs. The generator itself runs only from a script (`server/scripts/intelligence/objectiveRun.ts` / `objectivePresent.ts`). No route, workflow or cron starts it (grep of `evaluateObjectives` outside scripts and the orchestrator: none).

---

## 4. Mia: intent vs Objectives, end to end

### 4.1 Every source of "what Mia wants", with exact wording

| layer | exact wording | date / source |
|---|---|---|
| onboarding goal | `grow_my_following` · secondary `get_my_first_deal` | 2026-05-30, `athletes` |
| athlete-stated intent (ledger) | "I have a personal contract wiyh adidas not nike. Nike is through stanford" → `note` | 2026-09-07, onboarding v2 greet, run `9e2b6392` |
| athlete-created Objectives | **none** (0 rows, 0 `created` events) | dev `objectives`, `objective_events` |
| researched Opportunities (map `opportunity-eval-spec/1.0.0`, as of 2026-09-23; the map every persisted set used) | `grow-instagram-posting-cadence` GROW content — stance wants `grow_my_following` · `unlock-tiktok-channel` UNLOCK content — wants `grow_my_following` · `grow-academic-tech-partnerships` GROW positioning — wants `get_my_first_deal` · `amplify-inbound-startx1-interest` AMPLIFY commercial — wants `get_my_first_deal` · `amplify-yuwa-philanthropic-work` AMPLIFY impact — no stance · `unlock-adidas-historical-performance-data` UNLOCK evidence — no stance | `objective_proposal_sets.opportunity_map` |
| map notes on intent absence | owned_venture: "No information is recorded … has expressed an ambition to build an owned venture" · career: "no preferences or data points regarding post-playing career directions" | same |
| later maps (artifacts, not persisted) | 1.1.0: gorjana, content cadence, private analytics, philanthropic positioning, negotiation pipeline · 1.2.0: 3 openings (IG cadence, gorjana, tech-academic positioning); Yuwa/impact **not carried** ("lacks specific targets") | `docs/audits/artifacts/opportunity-1.1.0-treatment/Mia_Bhuta.json`, `…/opportunity-1.2.0-forcing/Mia_Bhuta.json` |

### 4.2 Every evaluator batch, every proposal, with fate

**Batch 1: set `5dd8bdcc`, `objective-eval-spec/1.0.1`, 5 proposals from 6 openings, presented 2026-09-25 00:20.**

| proposal key | domain | evaluator's desired state (exact) | intent cited | fate | her words (exact) |
|---|---|---|---|---|---|
| `active-multiplatform-audience-growth` | audience | "Her social media audience is growing across both Instagram and TikTok, supported by active posting channels on both platforms." | `grow_my_following` | **modify → active** (`feb62891`, joint) | "Grow my audience and build a stronger, more consistent presence across Instagram and TikTok." |
| `establish-academic-tech-brand-partnerships` | positioning | "She is established as an active commercial partner or ambassador for brands in the STEM, EdTech, or tech venture sectors." | `get_my_first_deal` | **modify → active** (`c0f587e4`, joint) | "Build my positioning at the intersection of athletics, technology, AI, innovation and entrepreneurship, and secure partnerships that align with that identity." |
| `elevate-philanthropic-csr-partnerships` | impact | "Her philanthropic leadership with the Yuwa girls empowerment program is a commercially active part of her identity, attracting global CSR sponsorships." | — | **modify → active** (`b1c799e3`, nomila) | "Expand the impact and visibility of my work with Yuwa through aligned global brand and CSR partnerships." |
| `secure-startx1-commercial-partnership` | commercial | "She has an active, fully executed commercial partnership with StartX1." | `get_my_first_deal` | **defer** (`2d199757`, joint), then re-surfaced, then deferred again (`information`) | "I don't know enough about StartX1 yet …" · "When u know more about this" |
| `secure-historical-partnership-performance-data` | evidence | "Her historical Adidas partnership terms and campaign performance metrics are fully documented and accessible to her team." | — | **decline** (`ca4976d6`, nomila) | "… collecting evidence is an action that supports my commercial objectives, not an objective itself." |

**Batch 2: set `87c095ff`, 1.0.1, 4 proposals (the `objective-1.0.1-run-c` re-run), materialised 2026-09-25 03:29.** 0 rows created. `active-cross-platform-audience-growth` → `reaffirmed_by_run` (audience). `premium-academic-impact-partnerships` ("…active partnerships with corporate social responsibility (CSR), STEM, or educational tech brands") → `spans_live` over positioning + Yuwa. `secure-startx1-commercial-agreement` → `re_surfaced`. `acquire-adidas-performance-metrics` → `re_proposed_while_declined`.

**Batch 3: set `1916e5cc`, 1.0.1, identical 4 proposals re-materialised 2026-09-25 15:23** (the L2 run). 0 rows. Same relationships, except StartX1 → `reaffirmed_by_run` under the `information` deferral. All from dev `objective_events` / `objective_proposal_sets`. (`canonical_sha256` is the same on all three sets because it is the 1.0.1 spec digest `5c9087b8…`, `docs/architecture/commercial-intelligence/objective-validation-cohort.md`, "What is frozen" paragraph.)

**Governed live Objectives (dev): 3.** audience `feb62891`, positioning `c0f587e4`, impact `b1c799e3`. Deferred: StartX1. Declined: Adidas evidence. All match the control file.

### 4.3 The hypothesis

*"Her live portfolio is the governed survivors of one evaluator batch rather than a representative portfolio of what she wants."* **CONFIRMED**, on four counts:

- **One batch.** 5 of 5 Objectives come from set `5dd8bdcc`. Reconciliation 2.0 is designed never to add, merge or replace a governed Objective from a re-run (`objective/reconcile.ts:9-14`). The re-runs could only reaffirm or relate, so the portfolio is structurally frozen to batch 1 until someone runs a new generation or she creates one herself.
- **The batch mirrors the map.** 6 openings → 5 proposals; only the two content openings were consolidated. This is the near-1:1 pattern already recorded for 1.0.0 (`docs/audits/objective-1.0.0-first-run.md:26`). The portfolio's topology is Opportunity 1.0.0's topology.
- **The intent axis was two stale slugs.** Batch 1 cites `get_my_first_deal` for StartX1 ("Supports her onboarding choice to secure brand deals") and for tech partnerships. Her record at the time held an accepted gorjana deal and her Adidas statement, and the latter never reached State.
- **Her governance widened it, and that widening is invisible upstream.** "AI, innovation and entrepreneurship" and "my work with Yuwa" are her words, but they live only in `objectives.desired_state` and `modified_from`. The 1.2.0 Opportunity run still reports no owned-venture desire and no impact target. Downstream, the Brain is shown both her wording and "Nomila's original proposal, superseded by her wording" (`brain/inputBlock.ts:26-27`). The live recommendation on the positioning Objective reads "…within the EdTech, STEM, and technology venture sectors…" (dev `recommendations` `rec_40c8ca0b…`), which is the superseded proposal's vocabulary, not hers.

What the portfolio does NOT show is also evidence. There are no owned-venture, career, content-identity (voice/pillars) or "hold / never" Objectives. For each of those the map notes cite an absence of *recorded intent*, not an absence of opportunity.

---

## 5. Answers

**Q1. Does Nomila currently have a reliable way to establish what this athlete actually wants Nomila to accomplish? No.**
- The only systematic capture is one primary plus secondary pick from a 5-slug (or 4-slug retired) list at signup (`shared/goals.ts`). The design notes themselves call it "too coarse" (memory `brand-direction-design.md`).
- The conversational capture that was meant to deepen it (discover step, Brand Layer, Direction, `brand_relationships`) is `DESIGN_DOC_ONLY`.
- The passive doors that exist (the Facts "What you want" group, chat confirm cards) produced 0 intent rows for any athlete on dev.
- Where intent is captured, State projects it by a name regex that drops `never_post`, `cadence`, `brands_causes`, `hobbies` and `note`. It mislabels any column goal as an onboarding choice, and it would read a prose restriction as `wants`.
- Intent has no recency or staleness handling (`get_my_first_deal` after two deals).
- The richest intent signal Nomila holds, her Objective modifications and decline/defer reasons, does not feed back into State.
- There is no athlete-facing way to state an Objective (API only) and no proactivity setting.

**Q2. Should onboarding / the initial Mila conversation provide richer strategic intent before Objective generation? The evidence says yes.** This is a coverage finding, not a semantics change; the decision itself is the founder's. The reasons:
- (a) Every intent-shaped gap in the maps is attributed by the evaluator itself to "not recorded" (owned venture, career, impact targets).
- (b) The evaluator spec forbids inferring intent. So without capture, the intent axis collapses to whatever the signup slug says, and the `athlete` origin can never occur from generation.
- (c) Mia's own modifications show the gap is real: her intent was broader and more specific than any input.
- (d) The strategic-sufficiency audit already ranked "intent acquisition — widen the want capture" as move 3. Moves 1–2 are now largely done (State 1.2 projects goals, floors and inbound), which leaves acquisition as the binding gap.

**What is missing, and where it would have to land (inventory, not design):**

| missing | where it is designed | nearest existing seam |
|---|---|---|
| commercial aspirations (brands / categories wanted, the 12-month "to") | `brands_wanted`; `brand_relationships`; Direction `to` | `brands_wanted` field (reaches State as `wants`); nothing asks for it |
| what I don't want | `never_post`; Direction `ease_off` / guardrails; controversy hold | `never_post` field (dropped by the State regex) |
| causes / interests | discover step (`brands_causes`, `hobbies`) | fields exist; no step; no State reader |
| career / owned-venture ambitions | Direction; sufficiency audit #12, #14 | none |
| audience / content ambition | `cadence`; Direction cadence floor | `cadence` field; the Brain acquisition need `athlete_capability_intent` (experimental) |
| proactivity / autonomy | `tap_to_send` per-athlete field | none (planner gate type only) |
| intent freshness | — | none |
| feedback of governed wording and decline/defer reasons into intent | — | none (State does not read `objectives` / `objective_events`) |
| athlete-authored Objective | `POST /me/objectives` | route + entity built; no client, no Mila tool |

---

## 6. Prior findings re-verified

| prior finding | source | verdict | evidence |
|---|---|---|---|
| Athlete intent (`goal_archetype`, `secondary_goals`) is dropped: `preferencesFrom()` reads only `athlete_asserted`, so State reports 0 preferences | `strategic-sufficiency-audit.md` §1, #9 | **SUPERSEDED** | `onboardingPreferencesFrom` (`build.ts:379-393`) projects both, and every persisted set's `state_snapshot.preferences` holds them. Also on `main 9fff9b15` (2 matches) |
| Floors and representation are dropped | same, §1 | **SUPERSEDED** | `representationFrom` (`build.ts:479-489`); rendered at `stateBlock.ts:176-182` |
| `athlete_asserted` holds two fields in the entire database (`note`, `sport`) | same, §1 | **PARTIALLY SUPERSEDED** | now 3 rows (a test `cadence` added 27 Sep). Substance unchanged |
| Activity preferences, refusals, owned-venture and career ambitions are never asked | same, #10–#12, #14, §4.2 | **STILL TRUE** | §2. Onboarding steps are `greet` and `doors` only |
| `brand_relationships` designed, not built | same, #8 | **STILL TRUE** | no `pgTable`, no commit on any ref |
| No path from a State gap to an athlete question | same, #27 | **PARTIALLY SUPERSEDED** | the Brain acquisition seam exists for one need → `cadence` (`EXPERIMENTAL · OPEN_PR`, 2 test runs). Nothing for ambitions or refusals |
| `athlete`/`joint` origins never observed | same, §1 | **PARTIALLY SUPERSEDED** | `joint` is observed (3 of Mia's). `athlete` is still never observed (0 rows) |
| Objective 1:1 mapping is at least half State insufficiency (Type A) | same, §5; `objective-1.0.0-first-run.md:26` | **STILL TRUE for Mia** | batch 1 is near-1:1 (6 → 5) even with intent present, because intent was two slugs. The sufficiency audit's own test ("does it select when it has intent and demand?") has not been run with real intent |
| `goal_archetype`/`secondary_goals` "written by `mila/onboarding.ts` … projected into `athletes_current`" | `objectives-design.md:18` | **PARTIALLY SUPERSEDED** | written by the landing/waitlist signup, `PATCH /me/profile`, and the ledger (`onboarding.ts:77-78`). The State reader reads `athletes`, not `athletes_current` (`build.ts:130-133`) |
| 3c: deterministic athlete-intent path, Objectives from goals / asserted without an evaluator | `objectives-design.md:269` | **SUPERSEDED / not built** | no such generator. The athlete path became the route-only `athleteObjective()` |
| `currentStateEvidence` is required even for athlete-originated Objectives ("NEVER EMPTY, whatever the origin") | `objectives-contract.md:203,217` | **SUPERSEDED for the entity** | `athleteObjective()` sets `currentState: null`, `currentStateEvidence: []` ("Null is honest", `entity.ts:100,120-130`). Still true for evaluator proposals |
| An athlete-originated Objective is born accepted and may be active immediately | `objectives-design.md:53,162` | **STILL TRUE (code)**, never exercised | `entity.ts:131-134`; 0 rows |
| Mia's decline of the Adidas metrics proposal drew the knowledge boundary; no live Objective is in `evidence` | `objective-knowledge-boundary.md:14,121-123` | **STILL TRUE** | dev: `ca4976d6` evidence · declined; live = audience / positioning / impact |
| Onboarding intent is labelled `onboarding_v1_choice` so it is not promoted to "her objective" | `objective-validation-cohort.md` (audit) §6; `build.ts:374-378` | **STILL TRUE, with a defect** | the label is applied to any value in the column, including chat/Settings writes (§1 item 5) |
| Origin `nomila` 24/24 in the cohort is correct because none of the six said anything; the intent seam is untested by the cohort | `docs/audits/objective-validation-cohort.md:206` | **STILL TRUE** | also true of the 1.0.4 cohort. Mia's intent path is exercised only under 1.0.1 |
| 1.0.4 passes acceptance on every gated proposal | `objective-1.0.4-cohort-evaluation.md` | **CANNOT VERIFY for Mia** | Mia is not in that cohort; none of her persisted sets is 1.0.2+ |
| Control file: "Objective (1.0.4) = the changed future states the athlete has chosen" | `00-control.md` | **CONTRADICTED as a description of the live portfolio** | chosen states are 1.0.1 products over Opportunity 1.0.0. `main` pins 1.0.2 / 1.0.0; 1.0.4 / 1.2.0 exist only on the stack |

---

## 7. UNKNOWNs

- **Whether a 1.0.4 run over a 1.2.0 map with Mia's current State would reproduce her portfolio.** Settle by running the frozen chain for Mia (provider call, needs approval) and reconciling without materialising.
- **Whether prod athletes hold richer intent than dev.** Prod was not touched. Settle with a read-only count of `athlete_asserted` by field and of `goal_archetype` on prod, under explicit approval.
- **Whether the landing page's current goal screen matches `shared/goals.ts`.** A test asserts it (`server/routes/waitlist.goals.test.ts`, per `goals.ts:6`). Not run here.
- **The success conditions of the three live Objectives after modify.** Modify changed `desired_state` only; not queried. Settle with `SELECT success FROM objectives WHERE athlete_id=Mia`.
- **How many real users have the Brand-tab switch on (and so can reach the Facts "What you want" group).** It is device-local AsyncStorage; the server cannot see it.

## 8. Open questions for the founder

1. Should strategic intent (ambitions, commercial aspirations, never-list, causes, career/venture, proactivity) be acquired *before* the next Objective generation for Mia? Or should the current 1.0.1 portfolio stand until she authors changes herself?
2. Should her Objective modifications and her decline/defer reasons count as athlete-stated intent for future Opportunity/Objective runs (a State input), or remain governance history only?
3. Should `get_my_first_deal`-style signup choices expire or be re-confirmed once the record contradicts them?
4. Is "how proactive should Nomila be" a per-athlete setting (the 4 Sep `tap_to_send` plan), or a fixed product rule?
5. Should the athlete be able to author an Objective from the app or through Mila? The API exists; no surface does.
