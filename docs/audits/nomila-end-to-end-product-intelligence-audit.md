# Nomila end-to-end product and intelligence audit

**As of 27 Sep 2026 · read-only · no provider calls, no dev writes, no implementation.**
Evidence was collected by nine parallel agents under one control file
(`docs/audits/nomila-e2e-audit/00-control.md`); synthesis and every quality judgment below are the lead's. Detailed
inventories are linked, not repeated.

The question this audit answers is not *does each contract work* — it is *would an athlete who joined tomorrow
receive the product Nomila was meant to be*: understands me, understands my world, understands what I want,
identifies what matters, recommends what I should do, plans the work, helps execute it, learns from what happens.

---

## 1. Executive assessment

**Short answer: an athlete joining tomorrow would get a real front door, a real deals inbox, a real creative studio
and a real chat assistant — and none of Nomila's strategic intelligence.** The Opportunity → Objective → Brain →
planner chain that the last forty pull requests built exists only in scripts, open PRs and one athlete's dev rows. It
has no athlete surface, no product caller, and no path into the execution systems that do exist.

Scored against the promise, for a new athlete tomorrow:

| promise | where it stands | why |
|---|---|---|
| understands **me** | **partial — the strongest part** | M.I.A. produces genuinely athlete-specific reasoning (Mia's narrative_power 88.9 with the right reasons). But research and M.I.A. don't share evidence, State reads no research, M.I.A. can score the wrong person with HIGH confidence, and the athlete sees a different score (672) from the one the Brain reasons with (624). |
| understands **my world** | **absent** | Nothing time-sensitive is acquired or stored — no fixtures, season, results, moments, trends, news or peer activity, on any branch. Every "timely" Brain output on record came from one hand-typed JSON file. Mia's research last changed 3 Sep. |
| understands **what I want** | **nearly absent** | Mia's entire captured intent is two signup slugs from 30 May (`grow_my_following`, `get_my_first_deal`), one of which her own record contradicts. The designed "get to know you" onboarding was never built, and State silently drops most of what an athlete does assert. |
| identifies **what matters** | **partial, experimental** | Opportunities and Objective proposals are athlete-specific in content (Yuwa, StartX1, gorjana for Mia; Medalist Skin for Maher; POTS for Ledecky) but templated in structure and uniformly HIGH-confidence. For Mia they ran on specs two to three versions behind the frozen ones. |
| recommends **what to do** | **valid, not yet valuable** | Three clean, grounded, athlete-specific *categories of move*. None is timely, none names who or when, one overrides the athlete's own wording, and she has no way to see or answer any of them. |
| **plans** the work | **experiment only** | The planner produced useful preparation for older recorded Recommendations — and in one case targeted the counterparty Mia had deferred. Nothing has ever planned a live Recommendation. Two of three live Recommendations have no planner at all. |
| helps **execute** | **real, but disconnected** | Deals (inbox, drafts, terms, payments) and Studio (548 generation jobs, identity, QA, Instagram publish) are genuinely built — and nothing Nomila decides reaches either. Studio only makes what the athlete types. |
| **learns** | **absent** | Outcome attribution is an unmounted derivation, there are no deliverables, and the one live publish on dev belongs to a test account. |

**The dominant finding is not a missing model or a weak prompt. It is three disconnections:**
the athlete's own voice doesn't reach the intelligence; the athlete's world doesn't reach it at all; and the
intelligence doesn't reach either the athlete or the systems that could act. Each of those is closed by plumbing,
capture and one missing producer — not by another reasoning layer.

---

## 2. As-of manifest

| ref | SHA | status |
|---|---|---|
| `origin/main` | `9fff9b15` | last merge #620, 26 Sep. **All of Aditya's Studio work is on main** (through #607). |
| Brain/intelligence stack tip = #665 | `3f0139f6` | ~40 stacked open PRs (#626–#665), 69 commits not on main |
| #664 | `3f0139f6` (remote) · accepted tip `fa001d09` | **known overlap**: #664's branch carries #665's commits; #665 is based on marker `base/brain-live-activation-accepted` for a clean diff. Not rewritten. |
| dev Cloud Run | image `202771d3`, revision `nomila-v2-00757-gs2` | parent of `3f0139f6`; the difference is 5 script/doc files. Migrations 0071–0076 applied. |
| production | not inspected | UNKNOWN which code `nomila-v2-prod` runs; the stack is not deployed there. Studio's own ledger records 11 hand-applied prod migrations on 25 Sep (unverified). |
| Studio unmerged | PR #507 (acceptance harness), PR #567 (two classifier guards + client dev flags) | full 138-branch table in `14-studio-inventory.md` §A |

**Corrections to the control file the agents found (all verified):**

1. **Two of the four "off" flags are effectively ON on dev.** Dev sets `STUDIO_ALL_ON=true` and has no line for
   `STUDIO_CREATIVE_INTENTS` or `STUDIO_CAMPAIGN_GOVERNANCE`; `studioFlag()` treats an unset flag as on under the
   master switch (`server/studio/studioFlag.ts:35-36`). So the creative-intent and `/campaigns` routes answer on dev,
   and Mila is offered `request_creative` on every turn (`mila/loop.ts:198`). The 0.12.0 readiness projection reads the
   same flag strictly and reports it off — two readings of one flag. Unexercised: 0 rows in both tables. *I reported
   these flags as off at the last two checkpoints; that was wrong for these two.*
2. Dev env lives in `gcp/cloud-run-dev.yaml`; `cloud-run-v2.yaml` no longer exists.
3. Mia's live Objectives are products of **Objective 1.0.1 over Opportunity 1.0.0**, not the frozen 1.0.4 / 1.2.0.
   Main pins Objective 1.0.2 and Opportunity 1.0.0. Neither knowledge boundary has reached a live Brain run.
4. State 1.2 and the M.I.A. pipeline are on **main**, not only on the stack.
5. `feat/schedule-as-form` is a *contract payment* schedule (merged, #289), not an athlete schedule;
   `claude/athlete-social-media-agent-8ff6ax` merged via #303 carrying no agent code; `adi/studio-athlete-context` is on
   main; the context-intelligence design (#608) is on neither main nor the stack.

**Status vocabulary** used throughout: implementation `BUILT · PARTIAL · EXPERIMENTAL · DESIGNED · MISSING · UNKNOWN`
× location `MAIN · OPEN_PR · UNMERGED_BRANCH · DEV_ONLY · DESIGN_DOC_ONLY · HISTORICAL_ARTIFACT`, plus deploy/flag.

---

## 3. What Mia actually received, Objective by Objective

Sources: `02-mia-lineage-evidence.md` (every quote below is exact; 57 recorded Brain replies in its Appendix A) and
`06-planners-actions-campaigns.md`. Labels: **REAL** = her governed data on dev · **EXPERIMENT** = a recorded run over
her real inputs · **SYNTHETIC** = a controlled fixture.

### What Nomila knew going in (shared by every chain)

M.I.A. (REAL, ledger 22 Sep, score **624**; she sees **672** from the legacy score):

| dimension | score | Nomila's reading |
|---|---|---|
| narrative_power | **88.9** strength | first player of Indian descent at any FIFA World Cup for the US; co-captain U-17; Symbolic Systems in 2.5 years; Yuwa |
| brand_fit | 83.6 strength | safety 98, values 88 |
| athletic_authority | 80 strength | ACC champions 2025, All-America 4th team 2024 |
| commercial_proof | 71.5 | two of six components ASSUMED |
| engagement_quality | 67.1 | 4.07% median ER; two components ASSUMED |
| audience_scale | **41 gap** | cooling; TikTok dormant 557 days |

Everything the Brain knows about Yuwa is **one sentence from a 17 Apr 2025 web profile** (research evidence E3).
Existing work: gorjana (accepted, USD 14,000) and seven negotiating inbound deals. Intent: two onboarding slugs.
Context: a hand-typed seven-item file covering 26 Sep – 16 Oct (fixtures at Syracuse and vs California, USWNT vs
Spain, a campus event already past by the live run, a gorjana page, and one deliberate control item).

**How her Objectives came to be (REAL).** One evaluator batch (set `5dd8bdcc`, 1.0.1, 23 Sep) proposed five. On
25 Sep she governed all five in **3 minutes 41 seconds**: modified three into her own first-person wording, deferred
StartX1, declined the Adidas-evidence Objective. She accepted nothing unmodified. That is the single strongest
signal in the whole audit: **given something to react to, she immediately made it hers** — and nothing downstream
listened.

### 3.1 Yuwa — impact (`b1c799e3`)

| stage | what she received |
|---|---|
| **Learned** | narrative_power cites Yuwa as part of "a three-dimensional story of intelligence, heritage, and service" — from one web sentence. No programme facts, no contacts, no Yuwa needs. |
| **Opportunity** | *"Elevate and integrate her active work with the Yuwa girls empowerment program in India to attract global Corporate Social Responsibility (CSR) sponsorships."* (1.0.0). **The 1.2.0 forcing run dropped Yuwa entirely.** |
| **Objective proposed** | *"Her philanthropic leadership with the Yuwa girls empowerment program is a commercially active part of her identity, attracting global CSR sponsorships."* — origin `nomila`; **none of her captured intent mentioned Yuwa.** |
| **What she made it** | *"Expand the impact and visibility of my work with Yuwa through aligned global brand and CSR partnerships."* — her framing leads with **impact and visibility**, not commercialisation. |
| **Brain (REAL, 0.12.0)** | *"Target global brand and corporate social responsibility partnerships that align with her philanthropic leadership at the Yuwa girls empowerment program."* · why: *"…her work with Yuwa has not yet been commercialized."* · specialized_plan · not seen: "Specific CSR contact list", "Yuwa academy's own corporate sponsorship guidelines" |
| **Planner (EXPERIMENT, fed an older Recommendation)** | three target classes, the only named candidate **Adidas**; research CSR budgets, Yuwa's current funding needs (ask Mia), compliance; a six-step sequence: research → coordinate with Mia and Yuwa leadership → *"Commission the creation of a high-impact, professional pitch deck"* → athlete approval → draft outreach templates → tap-to-send outreach. |
| **Actions / Campaign / Studio / outcome** | none. The one CreativeIntent test on this material was refused: *"a written … piece has no Studio deliverable"*. |
| **Where it stops** | at `rec_2507ecb0`, response `none`. Readiness says **no planner owns `impact`** — even though the planner experiment ran this exact handoff through the outreach planner. |

**Judgment.**
*Technically valid:* yes. *Strategically useful:* **partly.** Spotting Yuwa as her most distinctive commercial-and-
values asset is the kind of thing a good manager would lead with, and nothing in her onboarding pointed to it — this
is the one genuinely non-obvious insight in her whole lineage. But the Recommendation is a *category*, not a move:
no brands, no angle, no moment. The Brain also reframed her Objective back into commercialisation ("not yet been
commercialized") when she had rewritten it around impact and visibility — it heard the proposal, not her.
*Product-worthy:* not yet. A strong human manager would name three to five specific brands with girls'-sport or
South-Asia CSR programmes, ask what Yuwa actually needs, and anchor the approach to a moment (an awareness day for
girls' education falls inside the hand-typed context window — illustrative; Nomila had no such calendar).
*Planner uplift:* **real.** Case A turns a category into a sequence of preparation work with the right gates. That
is the clearest evidence in the repo that planning is where Recommendations become valuable.
*Executable:* no — no planner owns the domain, no outbound action kind exists, no Studio executor for a deck.
*What would have made it substantially better:* Yuwa facts (research), her stated aim for it (intent), a
calendar of relevant moments (context), and a named-brand candidate list (commercial research).

### 3.2 Technology / positioning (`c0f587e4`)

| stage | what she received |
|---|---|
| **Learned** | Symbolic Systems in 2.5 years, MS&E master's; M.I.A.'s "tech-entrepreneurial mindset". Three StartX1 inbound signals in State. Nothing on AI, innovation or entrepreneurship as an aspiration. |
| **Opportunity** | *"Leverage her exceptional academic acceleration and tech-oriented studies at Stanford to target premium brand partnerships in EdTech, STEM, and enterprise venture spaces."* |
| **Objective proposed** | *"…an active commercial partner or ambassador for brands in the STEM, EdTech, or tech venture sectors."* |
| **What she made it** | *"Build my positioning at the intersection of athletics, technology, AI, innovation and entrepreneurship, and secure partnerships that align with that identity."* (`success` and `horizon` still carry the old wording.) |
| **Brain (REAL, 0.12.0)** | *"Target brand partnerships and ambassador roles within the EdTech, STEM, and technology venture sectors that align with her academic positioning."* |
| **Planner (EXPERIMENT)** | named **StartX1** — the Objective she had deferred (*"When u know more about this"*) — as its first warm lead, and sequenced follow-up templates to it. Under today's exclusion gates that plan is refused with 12 problems. |
| **Where it stops** | at `rec_40c8ca0b`; readiness: outreach planner mounted but off, with no caller. |

**Judgment.**
*Technically valid:* yes. *Strategically useful:* **weak.** The Recommendation restates the proposal's framing and
**drops the three words she added** — AI, innovation, entrepreneurship — which is precisely the ambition that
distinguishes her from any other Stanford athlete. "Target partnerships in EdTech/STEM" is sector advice anyone
could give. It also ignores her founder-shaped ambition (entrepreneurship is not an ambassador deal).
*Product-worthy:* no — an athlete who wrote her own sentence and gets back the machine's earlier sentence learns the
system isn't listening. *Planner:* the recorded plan **drifted across her governance** — the single most serious
quality failure in the lineage, now caught by a gate but never seen live. *Executable:* no.
*What would have helped:* her Objective edit flowing back into State and into the Brain's reading (it doesn't);
intent capture of "AI / founder" aspirations; research on StartX1 so the deferral could resolve.

### 3.3 Audience — Instagram and TikTok (`feb62891`)

| stage | what she received |
|---|---|
| **Learned** | cooling trajectory (measured, 120 evidence rows); Instagram 0.23 posts/week, last post 14 days ago; TikTok dormant **557 days**; 21,951 IG / 15,485 TikTok followers. |
| **Opportunities** | *"Increase her Instagram posting frequency…"* and *"Reactivate her dormant TikTok channel to re-engage short-form video audiences and expand her platform breadth."* — the TikTok one claims Reels are "50% of her Instagram mix"; State at that moment showed one carousel. **1.2.0 dropped the TikTok opening.** |
| **What she made it** | *"Grow my audience and build a stronger, more consistent presence across Instagram and TikTok."* |
| **Brain (REAL, 0.12.0)** | *"Reactivate her dormant TikTok channel to engage short-form video audiences and expand her platform reach."* — shares 92% of its content words with the Opportunity and 8% with her Objective; **Instagram, half her sentence, is gone.** |
| **Earlier Brain (EXPERIMENT, 0.1.0 V3)** | *"Initiate a channel reactivation strategy for her dormant TikTok account during her upcoming mid-season home-game schedule gap…"* — the **only** Recommendation in her whole lineage that used her calendar. The 0.2.0 principle "a schedule gap is not capacity" removed it, correctly, and nothing replaced it. |
| **Planner (EXPERIMENT, content)** | *"3 cross-posts per week, alternating between adapted Reels and carousel-to-video formats"*; audit six months of IG content → adapt to TikTok specs → queue weekly. Deliberately not productionised. |
| **Studio (REAL, unlinked)** | 1 session, 50 generation jobs, 27 assets — 26 draft, 1 rejected, **none approved or published**. Her asks: *"put my hair in a ponytail"*, *"remove all the nike signs from this"*, *"turn this into an ad for nike"*. Every job carries Studio's own `grow-following` code; none links to her Objective. |
| **Where it stops** | at `rec_454fd683`; no content planner; no TikTok publishing exists; Instagram publish is off on dev. |

**Judgment.**
*Technically valid and grounded:* yes — the best-grounded of the three, from measured data. *Strategically useful:*
**low.** A 557-day-dormant account is the first thing any dashboard shows; the Recommendation discovers nothing, says
nothing about *what* she should post or *why her*, and narrows her two-platform Objective to one. *Planner:* adds
real mechanics but no creative strategy — it answers "how often" and "how to reformat", not "what story". *Studio:*
she is already *using* Studio — on her own, to make Nike-flavoured edits — and nothing connects that activity to the
audience Objective she set. This is the chain where Nomila is closest to executing and furthest from knowing what to
make. *What would have helped:* context (fixtures, the national-team window, match days), peer/format intelligence,
and a content planner whose output is creative intent Studio can take — not a posting cadence.

### 3.4 The two Objectives she did not accept

- **StartX1 — deferred (REAL).** She wrote: *"I don't know enough about StartX1 yet to decide… Evaluate the
  opportunity first."* The Brain did the right thing — REQUEST_INTELLIGENCE, 50 of 58 times: *"StartX1 is a venture
  accelerator or technology platform that aligns with her tech-entrepreneurship academic positioning."* **But the
  request is not persisted and no research ever runs.** She asked Nomila a question; Nomila agreed it was a good
  question; nobody answered it.
- **Adidas evidence — declined (REAL).** She wrote: *"This is important and I should be prompted to provide my Adidas
  contract and available performance data, but collecting evidence is an action… not an objective itself."* That is
  a precise product instruction. **It exists only as `said` text.** No task, no request, no prompt — and the evaluator
  re-proposed the declined Objective twice. Her own "Personal contract with Adidas" fact is also dropped by State.

These two are the most product-telling moments in the audit: **the athlete gave Nomila explicit direction, and the
system recorded it and did nothing.**

### 3.5 The one working Campaign (SYNTHETIC)

The Recommend → Campaign → Existing Work → reconsider loop works — on a controlled match-day Objective with
hand-typed fixtures, in an ephemeral store. It proves the machinery; it says nothing about Mia.

---

## 4. Recommendation quality and product value

Across Mia's lineage and the cross-athlete artifacts (`09-cross-athlete.md`):

| criterion | verdict | evidence |
|---|---|---|
| athlete-specific | **yes in content** | Yuwa, StartX1, gorjana for Mia; distinct named assets for every cohort athlete |
| grounded | **yes, narrowly** | every cite resolves — but grounded in *thin* evidence (Yuwa = one sentence; research 24 days stale) |
| strategically meaningful | **partly** | Yuwa is a real insight; tech and audience are category restatements |
| commercially useful | **not yet** | no named counterparties, no values, no angles; the Brain never sees the scorer's verdict (correct) but gets no brand intelligence either |
| sufficiently ambitious | **no** | "target partnerships in sector X" is the floor, not the ceiling; her own edits were more ambitious than the output |
| actionable | **only through a planner** | the Brain correctly stops at WHAT; nothing picks it up |
| timely | **no** | none of the three live Recommendations cites a context item; the one timely output was removed and not replaced |
| aware of existing work | **yes** | eight negotiations correctly left alone; relation `new_work` correct |
| aware of her governance | **no — the biggest quality failure** | overrides her modified wording twice; planner targeted a deferral; declined Objective re-proposed; her "prompt me" instruction lost |
| different across athletes | **content yes, structure no** | Opp 1.0.0: "connect / verify / reconcile" openings for 10 of 10 athletes; 82 of 83 openings and 111 of 114 proposals HIGH confidence regardless of evidence density |
| leads to execution | **no** | 0 of 3 executable |
| not generic marketing advice | **mixed** | Yuwa is not generic; "reactivate TikTok" and "target EdTech partnerships" are |

**Examples, as asked.**
*Strong output:* the Yuwa insight (non-obvious, athlete-specific, values-aligned); REQUEST_INTELLIGENCE on StartX1
(the right humility); leaving the eight negotiations alone.
*Generic:* "Reactivate her dormant TikTok channel"; "Target brand partnerships … within EdTech, STEM".
*Missing opportunity:* her national-team and match-day moments; her founder ambition; her existing Adidas
relationship as an asset (State doesn't know it exists); her unapproved Studio work.
*Lacks context:* all three live Recommendations.
*Stops too early:* every chain — at the Recommendation.
*Planner adds meaningful HOW:* Case A (Yuwa).
*Planner drifts:* Case B (StartX1 across a deferral).
*Useful Campaign-shaped thinking:* the controlled match-day series — which only existed because a human typed fixtures.
*Where more intelligence would change the result most:* intent (her own words), context (her calendar), and research
depth on the thing the Brain already picked (Yuwa, StartX1).

**The distinction the brief asked for, applied to the three live Recommendations:**

| | technically valid | strategically useful | product-worthy | executable |
|---|---|---|---|---|
| Yuwa | ✓ | partly | not yet | ✗ |
| Tech positioning | ✓ | weak | ✗ (overrides her words) | ✗ |
| Audience/TikTok | ✓ | low | ✗ | ✗ |

**Is the gap reasoning or inputs?** Inputs, overwhelmingly. The Brain's behaviour under its gates is disciplined and
often right (existing work, deferrals, requests for intelligence). What it lacks is anything worth reasoning *about*:
her intent, her world, deep research on its own picks. Another Brain version will not fix that.

---

## 5. Golden athlete journey

Full table with pointers: `01-product-intent-and-journey.md` §4. Each step shows implementation · location, then
whether the contract works / the output is useful / the product can execute it.

| stage | step | status | contract · useful · executable |
|---|---|---|---|
| **ARRIVE** | find / confirm me | BUILT · MAIN · dev | ✓ · ✓ · ✓ |
| | research me | BUILT · MAIN (legacy) / EXPERIMENTAL (spec-grade, harness-only) | ✓ · partial (stale, noisy, wrong-person risk) · ✓ |
| | connect my world | BUILT · MAIN (IG, mail, TikTok read) | ✓ · ✓ · partial |
| **UNDERSTAND** | show what you know | PARTIAL · MAIN (Record, Facts behind a default-off switch) | ✓ · partial · ✓ |
| | let me correct / add | PARTIAL · MAIN (confirm cards; State drops most fields) | ✓ · ✗ · ✗ |
| | my marketability / identity | BUILT · MAIN (v7.2 shown; M.I.A. unshown) | ✓ · partial · n/a |
| **DECIDE WHAT MATTERS** | understand what I want | MISSING (two slugs) | ✗ · ✗ · ✗ |
| | identify opportunities | EXPERIMENTAL · OPEN_PR · script-only | ✓ · partial · ✗ |
| | establish Objectives | PARTIAL · MAIN (review queue only; live ones never shown again) | ✓ · ✓ · partial |
| **MANAGE ME** | Recommendations | EXPERIMENTAL · OPEN_PR · DEV_ONLY (3 rows) · no surface | ✓ · partial · ✗ |
| | Plans | EXPERIMENTAL · OPEN_PR · flag off · no caller | ✓ · partial · ✗ |
| | Actions | MISSING as a concept; only `send_reply` inbox drafts | — · — · ✗ |
| | Campaigns | EXPERIMENTAL · OPEN_PR · synthetic only (routes live on dev by accident) | ✓ · — · ✗ |
| | Mila coordination | BUILT · MAIN — **but Mila cannot read Objectives, Opportunities or Recommendations** | ✓ · ✗ for strategy · ✗ |
| **CREATE / EXECUTE** | outreach / deals | Deals BUILT · MAIN; outbound outreach MISSING | ✓ · ✓ · deals only |
| | Creative Intelligence | interpretation BUILT · MAIN; strategic CI MISSING; CreativeIntent seam broken for real asks | partial · partial · ✗ |
| | Studio generation | BUILT · MAIN · dev | ✓ · ✓ · ✓ |
| | publishing | BUILT · MAIN, off on dev, Instagram Reels only, no scheduling | ✓ · ✓ · partial |
| **MEASURE / LEARN** | outcomes | EXPERIMENTAL · OPEN_PR · unmounted | ✓ · — · ✗ |
| | reconsideration | EXPERIMENTAL · OPEN_PR (works in the durable loop) | ✓ · — · ✗ |
| | updated recommendations | MISSING as a product loop | ✗ · ✗ · ✗ |

**Athlete-facing surfaces today:** Brand · Opportunities (= Deals) · Mila · Studio · Settings
(`MainTabNavigator.tsx:539-543`). **No Home, Plan, Recommendations, Actions or Campaigns screen exists.**
Notifications: none to the athlete (email path no-ops without a key; escrow has a `TODO(notify)`).

---

## 6. Planned versus actual — summary

47-row capability matrix: `10-capability-matrix.md` (21 rows block product value). Supporting inventories:

| inventory | file |
|---|---|
| capability matrix | `nomila-e2e-audit/10-capability-matrix.md` |
| athlete data and research | `nomila-e2e-audit/11-data-research-inventory.md` (62 rows) |
| athlete world and context | `nomila-e2e-audit/12-context-inventory.md` (26 rows) |
| planners, actions, campaigns | `nomila-e2e-audit/13-planner-action-campaign-inventory.md` |
| Studio (incl. 138-branch manifest) | `nomila-e2e-audit/14-studio-inventory.md` (48 capability rows) |
| agents, prompts, models | `nomila-e2e-audit/15-agent-inventory.md` (~45 rows) |
| cross-athlete matrix | `nomila-e2e-audit/16-cross-athlete-matrix.md` (10 athletes) |
| artifact and source index | `nomila-e2e-audit/17-source-index.md` |

Narrative reports behind them: `01` product intent · `02` Mia lineage · `03` research, M.I.A., State · `04` context and
world · `05` Objective coverage and intent · `06` planners, actions, campaigns · `07` Studio · `08` agents and models ·
`09` cross-athlete.

**The shape of what's built, in one picture:**

```
  BUILT, ON MAIN, ATHLETE-FACING                 EXPERIMENTAL, SCRIPTS ONLY, NO SURFACE
  ─────────────────────────────                  ──────────────────────────────────────
  signup · identity claim · onboarding greet      Opportunity 1.0→1.2 · Objective 1.0.1→1.0.4
  research (legacy) · M.I.A. · v7.2 score          Brain 0.1→0.12 · Recommendation substrate
  inbox · deal detection · drafts · terms          outreach planner · content planner (experiment)
  payments · rates · deck / Nomi Card              Campaign · CreativeIntent · outcome attribution
  Mila chat + voice
  Studio (548 jobs) · Instagram publish            ── the only bridge between the two columns:
  Objective review queue ◄─────────────────────────── a script persists Objectives, the app shows the queue
```

**Research sufficiency, in brief** (`03`, `11`): production research is the legacy five-query pipeline, which never
asks about injuries, transfers, representation, ventures, causes, interests, reputation or schedule. The 55-item
research spec exists but only a calibration CLI calls it, and no product athlete has a row in the research substrate.
M.I.A. researches separately from name + sport alone. **State reads no research.** Things research already knows —
position, class year, a transfer (one athlete's Stanford → TCU), causes — reach the Brain only as M.I.A. prose, and
M.I.A.'s strengths, constraints ("high academic load … may limit her availability"), risks and summary are dropped.
Requested-and-noisy examples for Mia: Yuwa extracted twice as a brand *partnership*; press mentions all undated; NIL
market statistics recorded as facts about her.

**Social-media-manager reconciliation** (`04` §4–5): Peer Scout, Trend Miner, Analyst, Brief Composer and Outcome Loop
**were never built on any branch**. PR #309's weekly plan is open and unmerged; its proposed weekly "Strategist" would
be a second recommendation system that ranks, which the Brain is forbidden to do. Studio separately runs an
unstored live "moment" search, a trend door that always says unavailable, and a fixtures stub returning `[]`, and its
`CampaignBrief` is a different object from the #570 Campaign. The right relationship: the weekly/social work becomes
the **content planner** and **Context Intelligence producer** under the Brain — not a parallel recommender — and
Studio's moment/trend doors read that one context store.

**Agent boundaries** (`08`): one boundary is already right — the Brain reads a deterministic Deals projection, never
the scorer's verdict. Overlaps: research vs M.I.A. research (two web-grounded pipelines, plus at least five research
entry points in total); Studio's moment search vs a Context producer; Studio planner vs CreativeIntent interpretation
vs content planner. Deterministic resolvers should replace model reasoning for fixtures, dates and team resolution
(Studio already refuses model-supplied dates). Genuinely missing specialised capability: **planners for the domains
the Brain actually emits** (impact, content) and **a Context Intelligence producer**. Not missing: more evaluators.

---

## 7. Major gaps, classified by kind

| kind | gap | blocks value? |
|---|---|---|
| **Data** | no store for anything time-sensitive about her world; no intent fields populated; no Yuwa, brand-target or Adidas-terms data | **yes** |
| **Research** | spec-grade research harness-only; legacy research narrow and 24 days stale; M.I.A. unanchored identity (a "HIGH" wrong-person evaluation on dev); no research answers the Brain's own requests (StartX1) | **yes** |
| **Intelligence** | State drops research, most assertions (name-regex filter), M.I.A.'s constraints and risks; her Objective edits never flow back; confidence labels don't track evidence density | **yes** |
| **Strategy** | Recommendations are categories without who/when; the positioning and audience Recommendations override her wording; live objectives came from specs two to three versions stale | partly |
| **Planning** | no planner for impact or content; the outreach planner has no caller; `ledger: null` on the production planner path means deferrals aren't excluded there | **yes** |
| **Execution** | no outbound-action kind; no Studio path for decks or written pieces; no TikTok publishing; no scheduling; strategy → Studio carries nothing; the CreativeIntent interpretation call fails for real free-text asks (`creative/interpret.ts:35`, masked by a mock in its test) | **yes** |
| **UX / governance** | no surface for live Objectives, Recommendations, plans or actions; Mila blind to all of them; her explicit instructions (Adidas "prompt me", StartX1 "know more") are not durable; no proactivity setting | **yes — the most visible** |
| **Measurement** | no deliverables, no attribution reader, ingest coverage gap, one live publish (not hers) | not yet (nothing to measure) |
| **Learning** | no loop from outcome to later decisions in the product | not yet |

**Defects found in passing** (record, not fixed — this audit is read-only):
1. `creative/interpret.ts:35` passes her free text as a closed-code `objective` → `invalid_input` → HTTP 502; the slice's
   end-to-end test mocks it (#657).
2. Readiness reads `STUDIO_*` flags strictly while Studio reads them through `studioFlag()` — two answers for one flag.
3. Readiness says no planner owns `impact` while the planner experiment ran the impact handoff through outreach.
4. `preferencesFrom` / `constraintsFrom` keep asserted fields only by name regex (`state/build.ts:528,556`): `never_post`,
   `note`, `cadence`, `brands_causes`, `hobbies` never reach State; a prose restriction in `secondary_goals` would be read as a "want".
5. Goal slugs always labelled `onboarding_v1_choice` whatever door wrote them.
6. The live Brain's StartX1 REQUEST_INTELLIGENCE is not persisted anywhere but the run's output blob.
7. **Model deadlines:** the voice worker defaults to `gemini-live-2.5-flash-native-audio` — the Gemini 2.5 line retires
   **16 Oct, 19 days away**. The Kimi workhorse still defaults to `kimi-k2-thinking-maas`, which an earlier architecture
   doc called end-of-life (not verifiable from the repo). `GEMINI.pro` is a preview id on production paths.

---

## 8. What stays frozen

Keep frozen, as briefed: Brain semantics (0.12.0-exp), Opportunity (1.2.0) and Objective (1.0.4) semantics, the
Recommendation substrate, Campaign (#570 + A1–A3), CreativeIntent's contract, outcome attribution, Measure → Learn,
Rate, State semantics (K5 stays recorded), the ingest gap. **Nothing in this audit argues for reopening any of them.**
The gaps sit upstream (intent, world, evidence) and downstream (surface, planners, Studio bridge) of the frozen core.

---

## 9. Proposed next implementation sequence

The smallest set of workstreams that closes the largest gaps in the promise — ranked by athlete value, not
architectural order. Each names its smallest empirical test.

### 0. Housekeeping that must precede any of it (days, not a workstream)

Merge the Brain stack (the authorized reviewer, as a train); fix the two-flag contradiction; fix the interpret 502;
decide the voice model before 16 Oct. *Why first:* none of the workstreams below can be judged against a baseline
spread across forty open PRs, and two of those items are live defects on dev.

### 1. "Understand what I want" — intent capture and the correction loop

- *Athlete value:* her Objectives start from what she wants, and what she tells Nomila sticks. Closes the most
  product-visible failure in the audit: her own words being overridden and her instructions lost.
- *Scope:* one structured first-Mila intent conversation (ambitions, causes, commercial aims, what she won't do, how
  proactive to be); State reads every asserted field by type, not by name regex; modified Objective wording reaches
  the next Opportunity/Objective/Brain reading; her explicit asks ("prompt me for my Adidas contract", "know more
  about StartX1") become durable requests.
- *Depends on:* nothing new — onboarding, the ledger and State exist.
- *Evidence it is missing:* §3 throughout; `05` items 1–13.
- *Blocks launch:* yes.
- *Smallest test:* run the intent conversation with Mia and two cohort athletes, regenerate Objective proposals at
  1.0.4 from the enriched State, and compare coverage against what each athlete says they want (would Mia's AI /
  entrepreneurship and Yuwa-impact framing appear unprompted?).

### 2. "Understand my world" — a Context Intelligence producer, version zero

- *Athlete value:* Recommendations and Campaigns that say *why now*.
- *Scope:* a deterministic fixtures/season resolver for the athlete's team from official sources; a small curated
  calendar of moments (national-team windows, awareness days, school moments); one context store that replaces the
  hand-typed file as the Brain's CONTEXT input and that Studio's moment/trend doors read too. Context stays separate
  from State.
- *Depends on:* team resolution (`athlete_affiliations` exists).
- *Evidence it is missing:* `04` items 1–5; zero live Recommendations cite context.
- *Blocks launch:* yes, for anything timely.
- *Smallest test:* auto-assemble Mia's next-three-weeks context, diff it against the hand-typed file, run one Brain call,
  check whether any Recommendation now cites a context item.

### 3. "Tell me, and let me answer" — the Recommendation surface and Mila

- *Athlete value:* she sees what Nomila thinks, and her responses become the adoption signal the system has never had.
- *Scope:* the previously proposed respond-only activation — live Objectives visible again, Recommendations readable
  with what/why/readiness, her response recorded; Mila given read tools for Objectives and Recommendations so the
  coordinator can talk about them. No preparation offered where readiness is unavailable.
- *Depends on:* 0, and benefits from 1.
- *Evidence it is missing:* no surface exists; Mila is blind to the strategy layer.
- *Blocks launch:* yes.
- *Smallest test:* Mia reads and responds to her three live Recommendations through Mila; record whether she accepts,
  modifies or declines, and why, in her words.

### 4. "Help me make it" — a content planner that emits creative intent Studio can take

- *Athlete value:* strategy reaches the one execution system that is genuinely ready — Studio.
- *Scope:* the content planner (productionised from the recorded experiment) whose output is CreativeIntent rather
  than a posting cadence; a working interpretation step (fix #1 in §7); Studio's planner reading the intent's
  Objective/context lineage. Athlete approval before generation; no auto-publish.
- *Depends on:* 2 for "when", 3 for her approval.
- *Evidence it is missing:* `07` §4 — handoffs 1–5 are contract-only; Studio makes only what she types.
- *Blocks launch:* yes, for the content half of the product.
- *Smallest test:* Mia's audience Recommendation → content plan → CreativeIntent → one Studio brief → one approved asset,
  every handoff carrying real data.

### 5. "Help me reach out" — outreach preparation to execution

- *Athlete value:* the commercial half — brands approached, with her tap.
- *Scope:* turn on the outreach planner with a caller, map the impact domain honestly (outreach with an impact lane, or
  a stated decision it isn't), add an outbound-approach action kind behind tap-to-send, and give the planner the
  ledger on the production path so deferrals are excluded.
- *Depends on:* 1 (her exclusions and aims), 3 (her authorization).
- *Blocks launch:* no — Deals already covers inbound.
- *Smallest test:* the Yuwa Recommendation through the planner live, reviewed by Mia, one approach prepared and not sent.

### Deferred, deliberately

The research-substrate unification (one evidence spine feeding M.I.A., State and research) is the largest structural
gap in *understand me* — but workstream 1 closes the part athletes feel first, and M.I.A.'s identity anchoring
(name + sport + school/team) is a small fix that should ride with workstream 0. Measure → Learn waits until something
is executed; the ingest gap stays separate.

### Cross-athlete Brain evaluation — warranted, next, small

Existing evidence **cannot** show that Brain Recommendations vary by athlete type: only Mia has governed Objectives.
Agent I's proposal (`09` §7): 26 Brain calls, about **USD 0.66**, with governance simulated in the harness only and
labelled as such. It needs one harness flag (`--objectives-fixture`) — a small code change, so it belongs to the next
phase, not this audit. Run it after workstream 1's first test, so it measures the Brain on inputs worth measuring.

---

## 10. Questions that need a product or founder decision

1. **Intent before Objectives?** Should Objective generation wait until a structured intent conversation has happened,
   or keep running from the signup slugs and let governance correct it?
2. **What does "modify" mean?** When Mia rewrites an Objective's desired state, should `success` and `horizon` re-derive,
   and should her wording outrank the proposal's wherever the Brain reads it?
3. **Instructions in governance text** — should "prompt me for X" / "know more about Y" in a defer or decline become
   durable, actionable requests?
4. **Is impact an outreach domain?** Is Yuwa-style work outreach with an impact lane, or its own planning domain?
5. **Which surface first** — a Plan/Home screen, or Mila as the only surface for Recommendations at launch?
6. **Two scores.** Which score does the athlete see — v7.2 (672) or M.I.A. (624) — and when do they converge?
7. **The accidental flags.** Should `STUDIO_CREATIVE_INTENTS` / `STUDIO_CAMPAIGN_GOVERNANCE` be explicitly off on dev
   until the governance surface exists, or stay on under `STUDIO_ALL_ON`?
8. **Merge train timing.** Should the ~40-PR Brain stack merge before workstream 1 starts, or should workstream 1 branch
   from the stack tip?
9. **Voice model.** Which live-audio model replaces `gemini-live-2.5-flash-native-audio` before 16 Oct?
10. **Studio intent from the athlete vs from Nomila.** When Nomila's content plan and the athlete's own typed ask
    conflict, whose intent wins in Studio?
11. **Proactivity.** How proactive should Nomila be by default — and is that per athlete, per action type, or both?

---

## 11. The final question

> **If an athlete joined Nomila tomorrow, how close are we to delivering the experience we originally intended?**

**Roughly a third of the way — and the missing two thirds are connective, not foundational.**

The athlete would be found and confirmed, researched, connected, scored, given a working deals inbox, a capable
creative studio and an assistant to talk to. That front and back of the product is real and deployed to dev.

What they would not get is the middle — the part that makes Nomila a *manager* rather than a set of tools. Nomila
would know a thin, stale version of who they are, nothing about what's coming up in their world, and two dropdown
choices about what they want. Its strategic layer would produce athlete-specific but untimely categories of advice,
into a store nobody can see, with no path to anyone or anything that could act on it. And whatever the athlete told it
along the way would be recorded and not used.

The encouraging part is what the lineage shows about Mia herself: given proposals, she governed all five in under
four minutes and rewrote three into something sharper and more ambitious than the machine's version. **The athlete is
ready to direct Nomila. Nomila isn't yet listening, looking, or connected.**

> **What are the smallest number of workstreams that close the largest gaps in that promise?**

**Four, after a few days of housekeeping:**

1. **Understand what I want** — intent capture, and her words and instructions actually reaching the intelligence.
2. **Understand my world** — one Context Intelligence producer, starting with fixtures, season and moments.
3. **Tell me, and let me answer** — a Recommendation surface and a Mila that can see the strategy layer.
4. **Help me make it** — a content planner whose output is creative intent Studio can take.

Outreach execution (5) is the fifth, and it can follow. None of the five reopens a frozen contract.

*Stopped here for review. Nothing has been implemented.*
