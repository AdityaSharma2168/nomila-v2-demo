# Strategic-information sufficiency audit

**Owner:** Mia
**Date:** 2026-09-22
**Question:** *Does Nomila now have the information and intelligence necessary to act like an exceptional personalised marketing/business agency for this athlete?*
**Method:** every claim verified against `shared/schema.ts`, the live dev database, and the State/Opportunity/Objective code paths. Nothing implemented; nothing changed.

---

## 1. The finding that reframes the last two audits

**The pipeline drops far more than it lacks.** Of the intelligence an agent would want, most of what is *missing downstream* is *present upstream* and never projected. Three drops are large enough to have shaped the experiments we have been interpreting as evaluator behaviour:

| dropped intelligence | where it sits, verified | what reads it | consequence |
|---|---|---|---|
| **Athlete intent** — `goal_archetype = "grow_my_following"`, `secondary_goals = ["get_my_first_deal"]` (Mia, Lilia) | `athletes` table, written by onboarding under **"want"** | **nothing.** `preferencesFrom()` reads only `athlete_asserted`, which holds **two fields in the entire database** (`note`, `sport`) | every State reported 0 preferences → the Objective intent path was exercised **zero** times → `athlete`/`joint` origins never observed |
| **Commercial demand** — Mia: **227 inbox threads** classified `PAID`/`GIFTING` with advertiser names (Marriott Bonvoy, Prozis, Hypershe, gorjana…), confidence and **deadlines**; **200 `detected` deals**, 7 `negotiating` | `inbox_threads.classification`, `deals.status` | **nothing.** State reads `accepted`/`completed` only → sees **1** deal | Opportunity and Objectives reasoned about Mia's commercial position as *one gorjana deal*, while the market is knocking 227 times |
| **Athlete floors and representation** — `deal_preferences.minimum_rates` (autograph 465, licensing 1049…), `agent_name`, `agency_name` | `athletes.deal_preferences` | nothing in the intelligence chain (`routes/deals.ts` reads it for the product) | the "recommend vs. floor" separation the design relies on exists in data and is invisible to strategy |

**Revised verdict on the Objective run:** the 1:1 mapping was recorded as *evaluator reasoning*. That was too generous to the pipeline. Selection requires something to select *against* — what the athlete wants, what the market is asking for. Both were present upstream and absent from the input. **An evaluator cannot consolidate toward intent it cannot see.** The failure is at least half Type A.

---

## 2. Intelligence matrix

**Have** = present and reaches strategy · **A** = have it, architecture drops it · **B** = obtainable from existing integrations/product, not collected or projected · **C** = requires new external intelligence · **—** = absent.

| # | intelligence | status | where it exists | reaches Opportunity/Objective? | material? |
|---|---|---|---|---|---|
| 1 | identity & narrative | **Have** (post-PR2 fix) | M.I.A. `dimensionAssessments` + cited evidence; `athlete_facts` (LeBron 28, **Mia 0**) | ✅ rationale + citations | — |
| 2 | athletic trajectory & current context | partial | affiliations, `career_status`, M.I.A. `athletic_authority`/`momentum` rationale (E1 contract, E8 injuries) | ✅ prose only; **no structured season/schedule/milestone anywhere** | **material** |
| 3 | audience composition, growth, engagement | **A** | **40 social feature keys** + `social_audience_distributions` **8,400 rows** for Mia — age (18–24: 30%), gender (F 38%), country (US 69%), city | State projects **one categorical** (`audienceTrajectory: cooling`). Composition, reach, saves, shares, `top_decile_share`, `breakout_rate` — all dropped | **material** |
| 4 | content performance | **A** | `format_mix`, `reach_median_by_format`, `views_median_by_format`, `posts_per_week`, `content_n`, `performance_cv` | dropped | material |
| 4b | content themes | **B** | `media_assets` 591 rows; `content_posts` **0 rows**; no topic/theme classifier exists | — | nice-to-have |
| 5 | brand fit / category fit | **A** | M.I.A. `brand_fit` rationale (✅ reaches); **`brand_fit_narratives` 19 rows, per-brand `audience`/`credibility`/`whitespace`** | narratives dropped | material |
| 6 | existing sponsorships & commercial history | **A/B** | `deals` (1 accepted); **Adidas exists only in M.I.A. prose (E4)** — no deal row, no canonical fact for Mia; LeBron's endorsements are `disputed` facts | 1 deal | **material** |
| 7 | deal economics | **B** | `deals.amount` + cash/product split (✅); `deal_deliverables` / `deal_periods` / `deal_installments` — **schema built, 0 rows**; `contractExtract.ts` exists | amount only | material |
| 8 | relationships & network | **A/B** | `inbox_brands` **179**, `inbox_senders`, `deal_preferences.agent_name` — a contact graph nobody reads; `brand_relationships` was designed, **not built** | — | material |
| 9 | athlete ambitions | **A** | `goal_archetype`, `secondary_goals` — see §1 | **dropped** | **material** |
| 10 | preferences (activities) | **B** | onboarding "want" group captures a goal, **not** activity preferences; `athlete_asserted` has none | — | **material** |
| 11 | refusals / constraints | **B** | no data anywhere; acquisition path (Mila onboarding/chat) exists and does not ask | — | material |
| 12 | owned-business ambitions | **B** | not captured; the two `goal_archetype` values observed suggest a narrow vocabulary (size unverified) | — | material for the intent path |
| 13 | philanthropy / impact | A/B | M.I.A. cites Yuwa (E3, ✅ reaches); no structured record | prose | nice-to-have |
| 14 | career / post-playing ambitions | **B** | not captured | — | material (LeBron `career` miss) |
| 15 | upcoming milestones & calendar | **—** | **no fixtures, schedule, calendar or milestone table exists.** `class_year` is a registry fact for some athletes | — | **material** |
| 16 | cultural moments | **A/B** | `lib/trends` + `lib/gdelt` produce interest score, related queries, article count, tone, **recent article titles** via `researchRefresh` → `research_evidence` signal rows — **Riya 22, LeBron 142, Mia 0** | **read by nothing downstream**; snapshot columns are legacy and zero | material |
| 17 | comparable athletes | **C** | `athlete_index_matches` is identity resolution, not comparables; M.I.A. cohort priors not exposed | — | nice-to-have now |
| 18 | brand / category market activity | **C** | — | — | nice-to-have now |
| 19 | sponsorship-market trends | **C** | Rate's `MARKET_SOURCES_BLOCK` is a pointer list, not intelligence | — | nice-to-have now |
| 20 | whitespace | **A** (per-brand) / C (category) | `brand_fit_narratives.whitespace` — *"Zero clutter in the connected fitness category…"* | dropped | material |
| 21 | active brand campaigns | **C** | `deals.campaign` column exists for attribution; no market view | — | nice-to-have now |
| 22 | likely commercial demand | **A** | see §1 — 227 classified threads, 200 detected deals | **dropped** | **material** |
| 23 | relationship pathways into brands | B/C | `inbox_senders` is the raw material; no graph | — | nice-to-have now |
| 24 | timing / urgency | **A** + C | `inbox_threads.classification.deadline` (set on some), `deals.term_end`, `affiliations.ended_on` — **all dropped**; no calendar | State exposes no real-world date | **material** |
| 25 | external opportunities | A (inbound) / C (outbound) | inbound = the inbox, dropped; outbound discovery = none | — | material (inbound) |
| 26 | evidence freshness | Have-minor | every value carries `asOf`; `context/coverage.ts` has freshness families | asOf yes; **no staleness judgment** | nice-to-have |
| 27 | missing info → research / athlete question | partial / **B** | M.I.A. `missingEvidence` + `evaluationRisks` now reach State; `research/planner.ts` exists; **no path from a State gap to a research trigger or an athlete question** | gaps visible, not actionable | material |

**Tally: A ≈ 11 · B ≈ 8 · C ≈ 6.** The architecture's own losses outnumber the genuine absences.

---

## 3. The frozen four as an agent's intelligence packet

*If this were the complete packet handed to a world-class agent today, what would they still need before deciding what to pursue?*

**Mia.** The packet says: strong narrative, one deal, cooling audience, three evidence gaps. An agent would immediately ask — *what does she want?* (recorded: grow following, first deal — **dropped**). *Who is already asking for her?* (227 threads, Marriott/Prozis/gorjana — **dropped**). *Who is her audience?* (69% US, 38% F, 18–24 — **dropped**). *What are her floors?* (recorded — **dropped**). *What content works?* (format performance — **dropped**). *What are the Adidas terms and when does it end?* (unknown; the relationship itself is prose). *What's her calendar?* (none exists). **Roughly half of what the agent needs is in the database.**

**Riya.** The packet is honest and nearly empty — and *that is the right output*. Identity first; then no accounts, no intent, no inbox, no deals. An agent would ask twenty questions. The system correctly proposed the first two. What is missing is not intelligence but **a path from "we don't know X" to "ask Riya X"** (#27).

**Lilia.** Same shape as Mia at smaller scale: goal recorded and dropped; floors recorded and dropped; **4 connected accounts and 41 inbox threads** — dropped. Plus what no data holds: guardian context, school calendar, U-15 schedule.

**LeBron.** The packet is a **media profile, not client intelligence** — 0 connected accounts, 0 inbox, 0 deals, everything public research. An agent already knows all of it; what they'd need (his team's calendar, actual portfolio terms, what he wants next) is what Nomila cannot have for a non-client. He is a useful stress test of research quality and a poor test of agency, and should be read that way.

---

## 4. Answers

### 4.1 What we have
Marketability judgment with rationale and citations (post-fix); measured social distribution *and* composition; inbound commercial demand, classified; deal amounts with cash/product split; athlete goals and floors; per-brand fit and whitespace narratives; cultural-signal capability; affiliations with dates; identity resolution; canonical facts for research-covered athletes.

### 4.2 What we're missing
Structured calendar/milestones; activity preferences, refusals, constraints, owned-venture and career ambitions (not asked); populated deal structure (deliverables, rights, terms); canonicalised commercial relationships (Adidas is prose); market-side intelligence (category activity, campaigns, comparables, trends beyond the athlete's own name); a gap→question→research loop.

### 4.3 Where each belongs
- **State** (projection only): intent, floors, demand summary, audience composition, content format performance, brand-fit whitespace, deadlines/term dates, cultural signal summary — all Type A.
- **Research / substrate**: run the substrate for Mia (0 `research_evidence` rows); canonicalise endorsements; resolve why 67% of `athlete_facts` is `disputed`.
- **Product / acquisition** (Mila onboarding & chat): activity preferences, refusals, ambitions, calendar events the athlete knows.
- **Deals**: populate `deal_deliverables`/`periods` from `contractExtract`.
- **New capability** (Type C, later): Strategy Intelligence + targeted research — already designed as the reserved evidence slots on the Opportunity contract.

### 4.4 Material vs nice-to-have
**Material now:** intent, demand, floors, audience composition, commercial relationships (Adidas), timing/deadlines, gap→question path. **Nice-to-have now:** content themes, comparables, category spend, campaigns, cultural moments beyond deadlines, freshness judgment.

### 4.5 What needs to change
**State, first and mostly.** It projects roughly 6 of ~14 populated sources. Research needs one run (Mia) and one data-quality answer (`disputed`). **Opportunity and Objectives need no change until State is complete** — judging them on inputs missing half the picture is judging the wrong thing.

### 4.6 External / market intelligence capability
**Yes, eventually; not next.** You cannot act on category whitespace before you can see that Marriott is in the inbox. Type C is the fourth or fifth move, and its contract slot already exists.

### 4.7 Athlete intent acquisition
**Yes — but project what exists first.** Two goals are recorded and dropped; the vocabulary looks narrow; activity preferences, refusals and ambitions are never asked. Fixing the projection is one afternoon; widening the acquisition is a product change and comes second.

### 4.8 Is the Objectives layer necessary, and what is its unique job?
**Necessary — and its unique job was invisible in the run because its inputs were.** Opportunity says where openings lie. Objectives' distinct job is **reconciliation**: what the athlete wants × what the market is asking for × what the evidence supports → the outcomes worth intending. With intent = 0 and demand = 0 there was nothing to reconcile, and the layer degenerated into rephrasing — which is what we observed. That is a diagnosis of the inputs, not a verdict on the layer. If, with intent and demand present, it *still* rephrases 1:1, then it is not earning its place.

### 4.9 Next moves, in dependency order
1. **State 1.2 — project what is dropped.** Intent (`goal_archetype`, `secondary_goals`), floors and representation (`deal_preferences`), demand summary (classified inbox by category/advertiser/deadline; `detected`/`negotiating` counts), audience composition (top country/age/gender), content format performance, `brand_fit_narratives.whitespace`, and real-world dates (`term_end`, `ended_on`, classification `deadline`) — which also unlocks `grounded_deadline`. Type A only; no research, no evaluator change.
2. **Regenerate Opportunity and Objectives on the frozen four** from State 1.2 — frozen prompts, new inputs. **This is the real test of consolidation**: does Objectives select when it has intent and demand to select against?
3. **Intent acquisition** — widen the "want" capture: activity preferences, refusals/constraints, owned-venture, impact and career ambitions; reconcile the goal vocabulary. Type B.
4. **Canonicalise commercial relationships** — run the substrate for Mia; make Adidas a fact/relationship rather than prose; populate deal structure from contracts; answer `disputed`. Type A/B.
5. **Strategy Intelligence + targeted research** — the Type C layer, into the reserved slots. Last, because everything above it changes what it should look for.

---

## 5. Two corrections to prior audits

- **Objective run:** "evaluator reasoning" → **at least half State insufficiency (Type A)**. The consolidation-as-deliverable remedy stays recorded but should not be applied before move 2.
- **Opportunity Run 3, LeBron `career` miss:** still a real miss — but LeBron is a non-client with a research-only packet, and the more instructive version of that gap is Mia's `career`/`owned_venture` silence, which traces to intent never being asked (#12, #14).
