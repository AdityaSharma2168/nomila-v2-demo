# 16 — Cross-athlete matrix (athlete × stage)

Companion to `09-cross-athlete.md`. Every cell quotes a recorded artifact or a read-only dev DB row. **OVC** = `docs/audits/artifacts/objective-validation-cohort/` · **CIB** = `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/`. Beyond the evidence, a cell reads `UNKNOWN — no governed Objective / Brain run exists`.

Stage versions: Research = M.I.A. refresh + research rows (dev) · State = `athlete-state/1.2.0` · Opportunity = `opportunity-eval-spec/1.0.0` (1.2.0 only where stated) · Objective = `objective-eval-spec/1.0.1 → 1.0.4` · Governed = dev `objectives` · Brain = dev `recommendations` / CIB artifacts.

## A. Main set (7)

| stage | **Mia** (college, rich Nomila-owned data) | **Flau'jae Johnson** (college → WNBA, music) | **Cristiano Ronaldo** (saturated team-sport pro) |
|---|---|---|---|
| Research | M.I.A. ×4 (dev); **no** `athlete_research_state` row | M.I.A. ×2; research 120 rows (OVC design) | M.I.A. ×2; research 134 rows |
| State | MEDIUM; intent `grow_my_following`, `get_my_first_deal`; inbound 12; TikTok "553 days since last post" (`state-1.2-frozen-four-audit.md` §1) | MEDIUM; `competitionContext` null; zero Nomila deals | MEDIUM; `competitionContext` null; "Pipeline, inbound, closed deals all zero — Nomila's counts" |
| Opportunity | 1.0.0 run-d (6): "Reactivate her dormant TikTok channel…", "…Yuwa … to attract global Corporate Social Responsibility (CSR) sponsorships", "Acquire her historical Adidas partnership metrics…" (evidence). **1.2.0** (3): "Elevate her existing gifting relationship with gorjana into a formal, paid long-term ambassadorship"; no evidence opening | 1.0.0 (4): FIX/commercial "Reconcile … within Nomila's transactional database to correct her zero-deal baseline"; "Scale her category-defining dual identity as both an elite WNBA rookie and a signed Roc Nation artist…"; Unrivaled | 1.0.0 (5): "Expand and diversify content programming on … 'UR · Cristiano'"; "Implement strict promotional paid-disclosure compliance…"; post-retirement; equity. Note: "commercial … we defer" |
| Objective proposals | 1.0.1 (5): "active, fully executed commercial partnership with StartX1"; "…Yuwa … attracting global CSR sponsorships"; Adidas terms (evidence). Never run at 1.0.2+ | 1.0.1: `verify-commercial-records` (quantified `closedDeals ≥ 1`) → 1.0.3 "…but lacks recorded campaign integrations" (**fail**) → **1.0.4** (2): "dominated by integrated, crossover campaigns…", "Unrivaled … activated as a prominent pillar…" | 1.0.1 (5) incl. `verify-private-metrics` → **1.0.4** (4): "a fully diversified programming network…", "legally compliant disclosure practices…", "formalized business and legacy architecture…", "high-equity stakes … rather than … licensing" |
| Governed Objectives | 3 active modified: "Grow my audience … across Instagram and TikTok" · "…athletics, technology, AI, innovation and entrepreneurship…" · "…Yuwa through aligned global brand and CSR partnerships"; 1 deferred (StartX1); 1 declined (Adidas terms) | UNKNOWN — no governed Objective / Brain run exists | UNKNOWN — no governed Objective / Brain run exists |
| Brain Recommendation | `0.12.0-exp` run `f9e00c6f`: "Reactivate her dormant TikTok channel…" · "Target brand partnerships … EdTech, STEM, and technology venture sectors…" · "Target global brand and corporate social responsibility partnerships … Yuwa…"; all RECOMMEND · specialized_plan · new_work; StartX1 → REQUEST_INTELLIGENCE | UNKNOWN — no governed Objective / Brain run exists | No standing Recommendation: UNKNOWN — no governed Objective / Brain run exists. Fixture request only (CIB, zero live Objectives): 0.4/0.6 "Decline the Lumen Language term sheet…" → 0.8 "…has an established commercial rate card or minimum fee requirement…" (REQUEST) |

| stage | **Katie Ledecky** (individual-sport star) | **Ilona Maher** (creator / business identity) | **Chisom Okpara** (sparse; Stanford D1) | **Picabo Street** (post-career; flag says `active`) |
|---|---|---|---|---|
| Research | M.I.A. ×2; 122 rows | M.I.A. ×2; 132 rows | M.I.A. ×2; **0 research rows** (9 M.I.A. sources) | M.I.A. ×2; 136 rows |
| State | MEDIUM; `athletic_authority` 97; 2 gaps | MEDIUM; `audience_scale` 92, `cultural_relevance` 93 | **LOW**; audience/engagement UNKNOWN; "Stanford University · D1" | **LOW**; `careerStatus: active` vs rationale "retired since 2002" (unflagged conflict) |
| Opportunity | 1.0.0 (4): 2× UNLOCK evidence; "Protect … legacy narrative by framing recent competitive defeats as lessons in late-career resilience"; "Amplify her public advocacy around POTS…". Athletic note: "managed natively by elite national governing bodies" | 1.0.0 (6): "Connect Ilona's primary social accounts…"; "Build a comprehensive historical registry…"; "Protect her competitive selection pathway back into the US Rugby Sevens…"; Hello Sunshine; Medalist Skin; House of Maher | 1.0.0 (4): "Secure direct access to Okpara's personal social media platform data…"; "Position Okpara for premium corporate partnerships leveraging … Ivy League and Stanford academic pedigree"; "Build out … endorsement portfolio from … no active brand partnerships"; transfer-portal tracking. 6 "why nothing" notes | 1.0.0 (4): UNLOCK private metrics; Academy sponsors; "…secure year-round winter sports analyst and media commentator roles"; "Establish a structured presence on … TikTok and X" (feasibility low, confidence HIGH). Note: "retired from competition since 2002" |
| Objective proposals | 1.0.1 (4, 2 evidence) → **1.0.4** (2): "…frame her late-career competitive defeats as lessons in resilience…", "advocacy for … (POTS) … a structured, active public platform…" | 1.0.1 (5; 3 manufactured gaps) → **1.0.4** (4): "active in the US Rugby Sevens national team training and competition pool" (this_season), docuseries "greenlit or distributed", Medalist "expanded retail distribution", podcast "expanded, multi-partner commercial sponsorship model" | 1.0.1 (3; 2 evidence) → 1.0.2 (2) → 1.0.3 (1): "zero closed deals … on record" → **1.0.4: set refused at Gate 2** (accounting), so **0 Objectives at the accepted spec** | 1.0.1 (3; 2 MEDIUM) → 1.0.2 adds `expand-platform-footprint` (MEDIUM) → **1.0.4** (2): Academy "expanded portfolio … structured commercial sponsorship tiers"; "year-round … roles … beyond the quadrennial Olympic cycle"; TikTok/X declined ("a retired legacy athlete and broadcaster") |
| Governed Objectives | UNKNOWN — no governed Objective / Brain run exists | UNKNOWN — no governed Objective / Brain run exists | UNKNOWN — no governed Objective / Brain run exists | UNKNOWN — no governed Objective / Brain run exists |
| Brain Recommendation | UNKNOWN — no governed Objective / Brain run exists | UNKNOWN — no governed Objective / Brain run exists (cohort report predicts NO_ACTION for athletic re-entry, `objective-validation-cohort.md:105`; untested) | UNKNOWN — no governed Objective / Brain run exists | UNKNOWN — no governed Objective / Brain run exists |

## B. Supplementary (3)

| stage | **Riya Mehta** (truest low-evidence) | **LeBron James** (established pro, frozen four) | **Lilia** (tester; only non-Mia with Nomila-owned data) |
|---|---|---|---|
| Research / State | M.I.A. ×3; LOW; "identity uncertainty and regional name collisions" | M.I.A. ×3; LOW; new State 1.2 sections all empty | M.I.A. ×3; LOW; intent ×2, 39 detections, 12 inbound (lululemon, SHEIN, Gotham FC…) |
| Opportunity (1.0.0 run-d) | 2: "Resolve the identity discrepancy between regional profiles…"; "Set up and launch a single, verified public digital channel…"; 8 notes | 4: "Integrate LeBron's private Instagram platform logs…"; "Reconcile Nomila's structured database…"; "Proactively manage workloads … late-career"; "…football-focused content" | 3: "Establish public-facing personal social media channels…"; "Selectively convert active inbound brand interest into her first formal partnership or gifting deal"; evidence; owned_venture "premature for a 14-year-old" |
| Objective proposals | 1.0.1 (2): "anchored to a single, verified identity…" (evidence); "a verified, public-facing digital platform…". Never run at 1.0.2+ | 1.0.1 (4; 2 evidence): "…elite athletic availability … 24th NBA season with the Philadelphia 76ers"; "…active, highly visible football-focused promotional content vertical" | 1.0.1 (3): set **refused** (`athlete_stance.stance invalid: WANTS`); "secured her first formal commercial partnership or gifting arrangement" |
| Governed Objectives | UNKNOWN — no governed Objective / Brain run exists | UNKNOWN — no governed Objective / Brain run exists | UNKNOWN — no governed Objective / Brain run exists (0 rows on dev) |
| Brain | UNKNOWN — no governed Objective / Brain run exists | UNKNOWN — no governed Objective / Brain run exists | No standing Recommendation: UNKNOWN — no governed Objective / Brain run exists. Fixture request (CIB `D0/D2`, 0.4.0): REQUEST_INTELLIGENCE "Lilia Bhuta is willing and plans to launch a public-facing personal Instagram account…" |

## C. Stage reach per athlete

| athlete | Research | State | Opp 1.0.0 | Opp 1.2.0 | Obj ≤1.0.1 | Obj 1.0.4 | Governed | Brain standing rec |
|---|---|---|---|---|---|---|---|---|
| Mia | ✓ (M.I.A.; no research row) | ✓ | ✓ | ✓ (1 call) | ✓ | — | ✓ 5 | ✓ 3 (fed by Opp 1.0.0 + Obj 1.0.1) |
| Flau'jae | ✓ | ✓ | ✓ | — | ✓ | ✓ 2 | — | — |
| Ronaldo | ✓ | ✓ | ✓ | — | ✓ | ✓ 4 | — | fixture request only |
| Ledecky | ✓ | ✓ | ✓ | — | ✓ | ✓ 2 | — | — |
| Maher | ✓ | ✓ | ✓ | — | ✓ | ✓ 4 | — | — |
| Okpara | M.I.A. only | ✓ | ✓ | — | ✓ | refused (0) | — | — |
| Street | ✓ | ✓ (conflicting flag) | ✓ | — | ✓ | ✓ 2 | — | — |
| Riya | ✓ | ✓ | ✓ | — | ✓ | — | — | — |
| LeBron | ✓ | ✓ | ✓ | — | ✓ | — | — | — |
| Lilia | M.I.A. only | ✓ | ✓ | — | ✓ (refused) | — | — | fixture request only |

Sources for section C: the dev DB (`mia_evaluation_runs`, `athlete_research_state`, `objectives`, `brain_runs`, `recommendations`, `objective_proposal_sets` grouped by `athletes.full_name`) and the artifact directories listed in `09-cross-athlete.md` §2.
