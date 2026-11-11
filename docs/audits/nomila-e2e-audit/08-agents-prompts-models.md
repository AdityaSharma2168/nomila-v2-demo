# 08 — Agents, prompts and models: inventory and specialized-intelligence boundaries (Agent H)

Manifest: working tree `3f0139f6` (Brain stack tip), `origin/main 9fff9b15`. Dev Cloud Run observed read-only
(`gcloud run services describe nomila-v2 --region=us-central1`): revision `nomila-v2-00757-gs2`, image
`nomila-v2:202771d3` (parent of `3f0139f6`). The full row-per-agent table is `15-agent-inventory.md`; this file holds
the findings, boundary evaluation and governance.

## 1. Summary

1. **Every model call in the stack goes to four vendors, through three wrappers.** Gemini on Vertex (`genai()`,
   models.ts:44-47), Kimi on Vertex MaaS through the `openai` SDK (kimi.ts:86), Anthropic (narrator.ts:37,
   socialWebResolver.ts:35), and OpenAI only in the research benchmark providers (openaiWebSearch.ts:29). Studio adds
   OpenRouter/Vertex/fal generators. `BUILT · MAIN`.
2. **The Kimi workhorse is still the id the architecture doc calls end-of-life.** `KIMI.vertexModel` defaults to
   `moonshotai/kimi-k2-thinking-maas` (models.ts:133), with no override in the dev env or `gcp/cloud-run-dev.yaml`.
   The thread summariser, deal scorer, deal grouping, reply drafts, researchAthlete/researchBrand extraction and one
   of the narrator's three models all use it. The dev DB is *consistent with* it still serving: 272 of 292 threads
   are scored, and the latest scored thread has last_message_at 2026-09-25. That is not proof of which model
   answered. The EOL date itself is `CANNOT VERIFY` from the repo (see §5). `BUILT · MAIN · deployed-dev`.
3. **The Gemini 2.5 retirement (2026-10-16) is handled in the server but not in voice.** No server production path
   uses a 2.5 id; only two scripts still do (compareSearch.ts:203, testGeminiGrounding.ts:11). The voice worker
   defaults to `gemini-live-2.5-flash-native-audio` (mila-voice local clone `eedd988`, src/agent.ts:1307).
   `BUILT · separate repo`, deployed revision UNKNOWN.
4. **`GEMINI.pro` is a preview model id in production paths.** `gemini-3.1-pro-preview` (models.ts:123) drives the
   deck Strategist (shotList.ts:48), the Narrator and its judge (narrator.ts:27,29), the Studio agent planner
   (studio/agent/config.ts:26) and `propose_campaign` (studio/config.ts:1375). `BUILT · MAIN · prod-path`.
5. **Contradicts the control file: on dev, two of the four "off" flags evaluate ON.** The dev env has
   `STUDIO_ALL_ON=true` and no `STUDIO_CREATIVE_INTENTS` or `STUDIO_CAMPAIGN_GOVERNANCE` line. `studioFlag()` treats
   an unset flag as on under the master switch (studioFlag.ts:35-36), and both flags read through it (config.ts in
   `202771d3`, lines 1080 and 1082). So on the running dev image:
   - Mila offers `request_creative` (loop.ts diff; registry.ts `creativeTools`);
   - the creative-intent and campaign-governance routes answer instead of returning 404 (creative/routes.ts:18,
     campaignGovernance.ts:23).
   Dev still has 0 `creative_intents` and 0 `campaigns` rows. `OUTREACH_PLANNER_ENABLED` and `BRAIN_SUBSTRATE_LOOP`
   are genuinely off: both are unset and read as `=== "true"`.
6. **All of the commercial intelligence runs only from harness scripts.** The Opportunity, Objective and Brain
   evaluators, the outreach planner and the rate evaluator are called only from `server/scripts/intelligence/*` or
   `server/scripts/rate/*`. `prepareOutreach` has no caller except its test. Objectives do reach the product through
   `/objectives` (routes/objectives.ts:49-85) once a script has persisted them. `EXPERIMENTAL · OPEN_PR · harness`.
7. **None of the three live Recommendations can be executed.** All three are `specialized_plan` (dev DB
   `recommendations.value->>'executionPath'`):
   - *"Target global brand and corporate social responsibility partnerships … Yuwa …"* comes from an `impact`
     Objective. The router maps impact to `"impact"`, which is not in `PLANNERS` (executionRouter.ts:94,
     planner/contract.ts:14), so no planner exists for it.
   - *"Target brand partnerships … EdTech, STEM …"* is `positioning`, which routes to the outreach planner. That
     planner is off and has no production caller.
   - *"Reactivate her dormant TikTok channel …"* is `audience`, which routes to the content planner. That planner
     was deliberately not built.

   The contract works, and the agent produced a plausible WHAT. The product cannot execute any of it.
8. **The prompt-governance "ceremony" covers exactly the intelligence stack.** Six specs are sha256-pinned and
   asserted in tests: Brain, Objective, Opportunity, planner, M.I.A. blind-eval v0.2 and rate. Only the planner
   checks its pin at runtime (outreachPlannerOrchestrator.ts:59), plus the rate harness (rateExperiment.ts:68).
   Every model call on the live athlete path uses inline, unversioned constants: classifier, scorer, summariser,
   Mila, contract extractor, Narrator and Strategist.
9. **The prompt registry exists, but its lock is inert and its table is empty.**
   - Only `chat.suggestions` and `first_look.themes` call `resolvePrompt` (chat.ts:282,454; firstLook.ts:159).
   - `LOCKED_PROMPTS` names `classify.system`, `score.system` and `contract.extract.system` (promptRegistry.ts:41-44),
     but none of those call sites ever consults the registry. The lock guards keys that nothing requests.
   - `select count(*) from prompts` → 0, even though `PROMPT_REGISTRY=true` on dev.

   `PARTIAL · MAIN`.
10. **At least five separate web-grounded "research" entry points read the same world:**
    - researchAthlete (researchAthlete.ts:227-232)
    - the research substrate providers
    - the M.I.A. evaluator's own `googleSearch` (marketabilityBeta1Evaluator.ts:222)
    - Studio `research_moment` (moment.ts:1-30)
    - researchBrand (researchBrand.ts:52-57)

    Mila's `googleSearch` tool and the Claude `web_search` handle resolver add two more. M.I.A. deliberately does not
    read the research substrate: it is frozen as a single-provider grounded condition (evaluator header :10-12).
    `BUILT · MAIN`.
11. **Mila's loop is still invisible to tracing.** mila/gemini.ts:15 builds its own `GoogleGenAI` rather than calling
    `genai()`. The traced proxy also only wraps `generateContent`, not `generateContentStream` (models.ts:59-66).
    `BUILT · MAIN`.
12. **The Brain has no tools, by design, and reasons only from what it is shown** (brainExperimentOrchestrator.ts:107).
    Its commercial view is produced deterministically from the Deals functions, not by a second model
    (dealAssessmentProjection.ts:1-17). This is the one boundary on the stack that already follows "shared evidence +
    specialized intelligence + shared contracts". `EXPERIMENTAL · OPEN_PR`.

## 2. Evidence — inventory

See `15-agent-inventory.md`, sections A–G: 7 Deals rows, 6 Mila rows (including voice), 6 research/identity/M.I.A.
rows, 8 commercial-stack rows, 7 media-kit/imagery rows, the Studio model table, and scripts-only ids.

Differences between main and the stack for model-calling components
(`git diff --stat 9fff9b15 3f0139f6 -- server/...`):

| component | main `9fff9b15` | stack `3f0139f6` |
|---|---|---|
| Brain spec | `brain-eval-spec/0.4.0-exp` (main contract.ts:23) | `0.12.0-exp` (contract.ts:24); + brainLoopDurable, brainInputsBuilder, intelligenceAcquisition |
| Objective spec | `objective-eval-spec/1.0.2` | `1.0.4` |
| Opportunity spec | `opportunity-eval-spec/1.0.0` | `1.2.0` (+ key stabilization) |
| Outreach planner / planner evalSpec | absent | present (flag off) |
| CreativeIntent + `studio/creative/*` + Mila `request_creative` | absent | present (reads ON on dev, §1.5) |
| Model registry (models.ts, kimi.ts), Studio model ids | identical | identical (studio/config.ts diff is +4 flag lines only) |

Two other branches were checked:

- **Weekly plan** (`5dc4dcdc`): deterministic only. `deriveOccasions` has "no model involved", and the
  "Strategist (model call 1)" is designed but not present (`git show 5dc4dcdc:server/skills/weeklyPlan.ts:1-14`;
  `git grep genai 5dc4dcdc -- server/skills` → no weekly call).
- **Social-media-agent branch** (`f157b97b`): adds plans and docs (agent-runtime.md, social-media-manager.md,
  prompt-registry migration). No new model call site.

## 3. Boundary evaluation — "Do we have the right specialized intelligence boundaries?"

The evidence points to five problems, and most are duplicated perception rather than duplicated judgment.

**3.1 Overloaded agents**
- **Mila loop (B1).** One Gemini Flash loop does four jobs:
  - conversation;
  - Deals Q&A across ~15 tools;
  - onboarding writes (onboardingTools);
  - on the stack, creative intake (`request_creative`).

  That is by design, per the hub-and-spoke doc, and the tools are thin. The overload risk is in the prompt: a
  232-line prompt.ts with no version, no digest and no scored conversation corpus. Nothing measures a regression.
- **Deal scorer (A3).** One Kimi call produces fit ratings, brand tier, red flags and a verdict. That verdict drives
  auto-filing, where a high-confidence reject is archived (dealDetector.ts:1787-1822). It is money-deciding, but
  unversioned and without a quality corpus. The classifier has one: 30 lines in classifier-eval.dev.jsonl.

**3.2 Two agents reasoning over the same thing**

| pair | what they both do | evidence | verdict |
|---|---|---|---|
| Deals scorer vs Brain commercial | both judge whether a deal is good | Brain is fed a deterministic projection that explicitly excludes Deals' 1–10, verdict and draft (dealAssessmentProjection.ts:8-9) | **Boundary drawn correctly on the stack.** The duplication left is the scorer's own verdict, which the Brain never sees. |
| Research vs M.I.A. vs research_moment vs Mila web search | each runs its own grounded web search about the athlete or her world | C1/C2/C6, moment.ts header, mila/config.ts:18 | **Duplicated perception.** M.I.A.'s independence is a deliberate freeze condition. `research_moment` explicitly writes nothing to the research ledger (moment.ts:21-25). Moments found by Studio therefore never become Context Intelligence the Brain can see. |
| Research vs first look | both derive "who she is" | first look reads only her captions (firstLook.ts:160); research reads the web | Different evidence. Acceptable. |
| Weekly plan vs Brain | "what should she do this week" | weekly plan is a deterministic occasion spine, unmerged (`5dc4dcdc`); the Brain decides per Objective | No model duplication today. The weekly plan's occasions are the natural *Context Intelligence* input the Brain lacks. |
| Studio agent planner vs `propose_campaign` vs interpreter vs (unbuilt) content planner | all turn an ask into "what to make" | studio/agent/plan.ts (GEMINI.pro); direction/propose (3.1-pro-preview); interpret/6 (flash); interpret.ts reuses propose_campaign for CreativeIntent | **Three Studio model surfaces interpret intent.** CreativeIntent interpretation deliberately reuses `propose_campaign` rather than adding a fourth (interpret.ts:2-4). The Brain→content handoff has no receiver. Agent G owns the depth. |
| Opportunity vs Objective | both read State and draw conclusions | Objective consumes the Opportunity map as input | Layered, not duplicated. |

**3.3 Where a deterministic resolver should replace model reasoning (evidence only)**
- **Dates of moments and fixtures.** Studio already refuses model-supplied dates (moment.ts:10-16: "a date in the
  model's answer is never read"). That is a symptom of a missing fixture/schedule resolver. The weekly-plan spine
  records six occasion kinds "blocked on DATA" (`5dc4dcdc` weeklyPlan.ts:24-25).
- **Social handle identity.** It is resolved by a Claude web search (socialWebResolver.ts). The Identity module
  (`services/intelligence/identity/*`) is deterministic, but handle discovery still falls through to a model.
- **Deal scoring.** Already hybrid, and the right way round: the model rates components and code owns the number
  (dealDetector.ts:1343).
- **Classifier timeout → NOISE.** Handled deterministically with `llm_error` (dealDetector.ts:1020-1023).

**3.4 A missing specialized capability that is genuinely warranted**
- **Planners (the HOW) for the domains the Brain actually emits.** On Mia's live data the router produces `impact`,
  `positioning` and `audience`. Only positioning maps to a mounted planner, and that one is off. This is the single
  place where evidence shows an athlete-value dead end.
- **Context Intelligence is not a producer.** The Brain accepts a `context` block (orchestrator:135). No model or
  resolver on the production path fills it, except harness fixtures (`brain-context-experiment-1/ci-boundary`).

## 4. Prompt / spec governance

| class | members | evidence |
|---|---|---|
| Digest-pinned, test-asserted | Brain 0.12.0-exp, Objective 1.0.4, Opportunity 1.2.0, planner 0.2.0-exp, M.I.A. blind-eval v0.2, rate-eval 2.0 | `*_CANONICAL_SHA256` in brain/evalSpec.ts:435, objective/evalSpec.ts:293, opportunity/evalSpec.ts:298, planner/evalSpec.ts:88, marketabilityBeta1EvaluatorSpec.ts:511, rateBeta1EvaluatorSpec.ts:456; tests listed in 15 §D |
| …and pin enforced at runtime | planner (orchestrator:59), rate harness (rateExperiment.ts:68) | others record `promptSha256` per run but do not refuse |
| Versioned string, no digest | Studio: interpret/6, reference/1, summarize_brief/2, propose_campaign/1, research_moment/1, typed-op/1; research-spec/1, direct-research/1, extraction v3 | grep `PROMPT_VERSION` |
| Registry-resolved (table empty → in-code fallback) | `chat.suggestions`, `first_look.themes` | promptRegistry.ts:117; `prompts` count 0 |
| Inline, unversioned | classifier, scorer, summariser, grouping, draft, contract extractor, Mila system prompt, follow-ups, rolling summary, profile extraction, researchAthlete/researchBrand extraction, Strategist, Narrator (×3 + judge), visionTag, brandImage, brandNarration, socialWebResolver | 15 §A–E |
| No eval corpus found | scorer, summariser, grouping, draft, Mila loop, Narrator, Strategist, visionTag, brandNarration, researchBrand, socialWebResolver | absence after searching `server/scripts/*eval*`, `docs/audits/artifacts/` |

## 5. Prior findings re-verified

| prior finding | source | status | evidence |
|---|---|---|---|
| "ONE conversational agent, hub-and-spoke, no router/sub-agents" | `origin/docs/mila-agent-architecture:docs/mila-agent-architecture.md:7-15` (doc is on an **unmerged branch**, not at the path the brief names) | STILL TRUE | loop.ts, registry.ts — one loop; tools only |
| "Both models in code are sunset — kimi-k2-thinking EOL 2026-05-25; Gemini 2.5 retires 2026-10-16" | same doc :103-104 | PARTIALLY SUPERSEDED | Gemini moved to 3.x server-side (models.ts:120-124). Kimi K2-thinking is still the default (models.ts:133). The voice worker is still on Gemini Live 2.5. The EOL date is CANNOT VERIFY from the repo. |
| "Two-tier plan: Flash-Lite routing + Kimi K2.6 / Gemini 3.1 Pro synthesis" | same doc :108-141 | NOT DONE (still a design) | Mila runs `GEMINI.flash` for everything (config.ts:100); `GEMINI.flashLite` has no caller |
| "Mila's own loop bypasses the traced client (`mila/gemini.ts:15`)" | `origin/docs/agentic-platform-readiness:docs/plans/agentic-platform-readiness.md:44` (**unmerged branch**) | STILL TRUE | mila/gemini.ts:15 |
| "only 3 prompts use the registry" | same :44 | SUPERSEDED (now 2) | chat.suggestions, first_look.themes |
| "Zero MCP / OpenAPI in server" | same :45 | STILL TRUE at 3f0139f6 | none found by grep (not exhaustive; outside this agent's scope) |
| "fourteen prompts live as module-level string constants" | docs/plans/agent-runtime.md:156 | STILL TRUE in kind (count now larger) | 15 §A–E |
| "our own table for money/compliance prompts" (registry, locked set) | agent-runtime.md:197 | PARTIALLY | table + LOCKED set built; locked prompts not wired; table empty |
| "prompts table empty" | memory note (recommendation-system-map) | STILL TRUE | `select count(*) from prompts` → 0 |
| "Postgres workflow runner, not LangGraph" | agentic architecture review (memory) | STILL TRUE | server/workflow/* in use (miaEvaluation, socialSync, intelligenceAcquisition) |
| Control: "all four flags off on dev" | 00-control.md:65-66 | **PARTIALLY CONTRADICTED** | §1.5 |

## 6. UNKNOWNs

- **Whether `kimi-k2-thinking-maas` is still served on Vertex, and its real EOL date.** Settle with a Langfuse
  `kimi.vertex-maas` span from the last 7 days, or the Vertex Model Garden lifecycle page.
- **The voice worker's deployed model.** The local clone may be stale. Settle with `lk agent` / LiveKit Cloud
  deployment config, or `git log origin/main` in `nomila-co/mila-voice`.
- **Whether anyone reached `request_creative` or the campaign routes on dev.** DB rows are 0. Settle with dev
  request logs for `/studio/creative*` and `/campaigns*`.
- **Real quality of the scorer, summariser and Mila answers.** No corpus exists, so nothing to settle it with yet.

## 7. Open questions for the founder

1. Should `STUDIO_ALL_ON` be allowed to switch on the stack's governance surfaces
   (`STUDIO_CREATIVE_INTENTS`, `STUDIO_CAMPAIGN_GOVERNANCE`)? Or should those two carry an explicit `"false"` line on
   dev until reviewed?
2. The Brain's live Recommendations land in `impact`, `positioning` and `audience`. Which planner is built first, and
   does `impact` get its own planner or map to outreach?
3. Money-deciding prompts (classifier, scorer, contract extractor) are named as "locked" but are unversioned inline
   strings. Should they join the digest ceremony the intelligence stack uses?
