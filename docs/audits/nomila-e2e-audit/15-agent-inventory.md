# 15 — Agent / evaluator / model-call inventory (Agent H)

Manifest: working tree `3f0139f6` (Brain stack tip) unless a row says `main 9fff9b15`. Dev Cloud Run was observed
running image `nomila-v2:202771d3` (revision `nomila-v2-00757-gs2`) via a read-only `gcloud run services describe`;
`202771d3` is the parent of `3f0139f6` and carries the same model registry. Model ids come from
`server/lib/models.ts:120-135` unless noted. **No `GEMINI_*_MODEL`, `KIMI_*_MODEL` or `NARRATOR_*` override exists in
`gcp/cloud-run-dev.yaml` or in the live dev env** (describe output filtered for `MODEL|KIMI|GEMINI` returned none), so
code defaults are what runs:

| role constant | id | where |
|---|---|---|
| `GEMINI.flash` | `gemini-3.5-flash` | models.ts:121 |
| `GEMINI.flashLite` | `gemini-3.5-flash-lite` (no caller found) | models.ts:122 |
| `GEMINI.pro` | `gemini-3.1-pro-preview` (a **preview** id in production paths) | models.ts:123 |
| `KIMI.vertexModel` | `moonshotai/kimi-k2-thinking-maas` (**the id the Mila architecture doc calls EOL 2026-05-25**) | models.ts:133 |
| `KIMI.moonshotModel` | `kimi-k2.6` (only `kimiSearch`; **no caller** in server) | models.ts:134; `git grep kimiSearch\(` → none |

Legend — Impl: BUILT/PARTIAL/EXPERIMENTAL/DESIGNED/MISSING. Loc: MAIN/OPEN_PR/UNMERGED_BRANCH/DEV_ONLY.
"Digest" = canonical prompt text sha256-pinned and asserted in a test (and whether also enforced at runtime).
"Path" = where it is invoked from: **prod-path** (a server route/workflow/ingest reaches it), **harness** (only
`server/scripts/**` or tests reach it).

## A. Deals / inbox (the only model-driven loop that runs on every inbound message)

| # | name · job | inputs | prompt/spec · versioned/digest | provider/model | structured output | gates in path | persistence | consumer | eval corpus / tests | status · path |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | **Deal classifier** — is this message a deal, which category | one email (fenced as untrusted) | `CLASSIFY_SYSTEM` inline const, dealDetector.ts:884 · **no version, no digest**; named `classify.system` in `LOCKED_PROMPTS` (promptRegistry.ts:41-42) but **never resolved through the registry** (only `chat.suggestions` and `first_look.themes` call `resolvePrompt`: chat.ts:282,454; firstLook.ts:159) | Gemini `GEMINI.flash`, temp 0, JSON mime (dealDetector.ts:1037-1045); behind `geminiGate` | JSON mime, no `responseSchema` | retry → explicit `llm_error` (dealDetector.ts:1020-1023); timeout | inbox_threads / deals | detectDeal → deal pipeline, UI | `server/scripts/evalClassifier.ts` + committed `server/skills/__fixtures__/classifier-eval.dev.jsonl` (30 lines); mocked unit tests | BUILT · MAIN · prod-path (Gmail push → detectDeal) |
| A2 | **Thread summariser** — offer struct, key details, state | whole thread transcript | `SYSTEM` inline, threadSummarizer.ts:44 · no version/digest | Kimi `kimiInstant` (kimi-k2-thinking-maas, thinking disabled, JSON) threadSummarizer.ts:249 | json_object mode, parsed by code | none beyond parse | `inbox_threads.summary`, key_details.offer_struct | scoreDeal, Brain's deal projection (dealAssessmentProjection.ts:13) | mocked unit tests only | BUILT · MAIN · prod-path (dealDetector.ts:443,633) |
| A3 | **Deal scorer** — fit ratings, brand tier, red flags, verdict | deal + athlete tier/rate card + summariser offer | `SCORE_SYSTEM` inline, dealDetector.ts:1091 · `score.system` in LOCKED set but not registry-resolved | Kimi `kimiInstant` dealDetector.ts:1337 | JSON; **the 1–10 is derived in code** from the grid (`scoreDealGrid`, dealDetector.ts:1343-1380) | retry (dealDetector.ts:1327-1336); verdict required | `inbox_threads.score` (dealDetector.ts:865,1526) | Deals UI, auto-file on high-confidence reject (dealDetector.ts:1787-1822) | mocked tests (`dealDetector.scoreRetry.test.ts` etc.); no quality corpus found | BUILT · MAIN · prod-path. Dev DB: 272/292 threads scored, latest scored thread last_message_at 2026-09-25 (`select … from inbox_threads`) |
| A4 | **Deal grouping** — same-brand thread grouping | candidate threads | `SYS` inline dealGrouping.ts:47 | Kimi `kimiInstant` dealGrouping.ts:73 | JSON | parse | deals grouping | inbox | mocked tests | BUILT · MAIN · prod-path |
| A5 | **Deal reply draft** (streamed) | thread + deal | inline in dealDraft.ts | Kimi `kimiStream` dealDraft.ts:377 | prose | send gate is separate (tap-to-send) | draft only | routes/deals.ts, Mila `draft_reply` tool (tools/draftReply.ts imports it) | none found | BUILT · MAIN · prod-path |
| A6 | **Contract extractor** (two reads, reconciled) | contract text | `SYSTEM` inline contractExtract.ts:175 · `contract.extract.system` in LOCKED set, not registry-resolved | Gemini flash temp 0, JSON (contractExtract.ts:450-453, 481-487) — moved off Kimi for repeatability (contractExtract.ts:435) | JSON, validated by code | numbers refused not salvaged; disagreement fails safe (contractExtract.test.ts:50,469) | deal columns / periods | routes/dealContracts.ts | unit tests with fixtures; no model-quality corpus | BUILT · MAIN · prod-path |
| A7 | **Deal embedding** (kNN prior) | deal text | n/a | Vertex `text-embedding-004` dealEmbed.ts:41 | vector | — | — | kNN prior | `server/scripts/evalKnnPrior.ts` | BUILT · MAIN |

## B. Mila (conversational agent)

| # | name · job | inputs | prompt/spec | provider/model | structured output | gates | persistence | consumer | eval | status · path |
|---|---|---|---|---|---|---|---|---|---|---|
| B1 | **Mila agent loop** (v2) — one hub-and-spoke ReAct loop, ~15 tools (server/mila/tools/*) | conversation + athlete context + tool results | `buildSystemPrompt` in mila/prompt.ts:37 (232-line file) · no version/digest | Gemini `MILA.MODEL = GEMINI.flash` (mila/config.ts:100), streamed via `generateContentStream` on a **directly constructed client** (mila/gemini.ts:15,31) — bypasses the traced `genai()` | function calling (zod→Gemini decls) | MAX_TOOL_ITERATIONS 8 (config.ts:108); web-search limiter; tap-to-send in tools | chat_messages | athlete | unit tests (loop.test.ts, prompt.test.ts, grounding.test.ts); no scored conversation corpus found | BUILT · MAIN · prod-path; `MILA_AGENT_V2=true` on dev and prod yaml (cloud-run-dev.yaml `MILA_AGENT_V2 "true"`; cloud-run-prod.yaml:311) |
| B1a | `request_creative` tool — records a CreativeIntent | her verbatim ask | tool schema requestCreative.ts:13-17 | (no model call itself) | zod | idempotency key | creative_intents (0 rows on dev) | Studio interpret | tests | EXPERIMENTAL · OPEN_PR (stack only) · **reads ON on dev** — see §C of 08 (STUDIO_ALL_ON) |
| B2 | Mila v1 chat fallback | message | inline in chat.ts | Kimi `kimiStream` chat.ts:427 | prose | — | chat | athlete | — | BUILT · MAIN · dormant while MILA_AGENT_V2=true |
| B3 | Follow-up chips | Q + answer | `SUGGESTION_SYSTEM` chat.ts:31, **registry-resolved** `chat.suggestions` | Gemini flash (mila/gemini.ts:65-75) | JSON | — | — | chat UI | tests | BUILT · MAIN · prod-path |
| B4 | Rolling conversation summary | older turns | inline mila/gemini.ts:101 | Gemini flash | prose | — | conversations.summary | Mila memory | tests | BUILT · MAIN · prod-path |
| B5 | Profile-update extraction | turn | inline mila/gemini.ts:134 | Gemini flash, JSON | JSON | profileExtraction.ts writes via receipts | athlete_asserted / receipts | profile | profileExtraction.test.ts | BUILT · MAIN · prod-path |
| B6 | **Mila voice worker** (separate repo `nomila-co/mila-voice`) | audio | in-repo | local clone `eedd988` (2026-09-05): default `gemini-live-2.5-flash-native-audio` (mila-voice src/agent.ts:1307); xAI realtime when `MILA_VOICE_XAI` (src/agent.ts:1137-1138) | realtime tools | — | via server tools | athlete | — | BUILT · separate repo · deployed state UNKNOWN. **Gemini 2.5 line** — retires 2026-10-16 per models.ts:9 |

## C. Research, identity, first look, M.I.A.

| # | name · job | inputs | prompt/spec | provider/model | structured | gates | persistence | consumer | eval | status · path |
|---|---|---|---|---|---|---|---|---|---|---|
| C1 | **researchAthlete** (legacy) — grounded web search → extraction | name/sport/team | `EXTRACTION_SYSTEM` researchAthlete.ts:50 inline | search: Gemini flash + googleSearch (researchAthlete.ts:227-232); extract: Kimi `kimiInstant` (researchAthlete.ts:340) | JSON | parse | athlete_snapshots.research; dual-write to substrate when `RESEARCH_SUBSTRATE_WRITE` (false on dev yaml) | score, deck, Mila | — | BUILT · MAIN · prod-path (onboarding/firstLook/researchRefresh workflow definitions) |
| C2 | Research substrate providers — `geminiGrounded`, `geminiDirect`, `openaiWebSearch`/`openaiDirect`, `kimiExtract`, `kimiExtractV3` | spec'd queries | `research-spec/1`, `direct-research/1`, extraction v3 (`server/services/intelligence/research/spec/*`) · versioned, not digest-pinned | Gemini flash (+googleSearch); OpenAI `gpt-5.4-mini` (openaiWebSearch.ts:29); Kimi vertex | envelopes with schemaVersion | citation/lineage validators in research/spec | research_source_payloads (490 rows, all `gemini-3.5-flash`, last 2026-09-14) | Opportunity/Brain research blocks | `server/scripts/calibration/runs/2026-09-13*`, providerBenchmark.ts | PARTIAL · MAIN · `RESEARCH_REFRESH_ENABLED=false` on dev |
| C3 | **researchBrand** | brand name | `KIMI_SYSTEM` researchBrand.ts:28 | Gemini flash grounded (researchBrand.ts:52-57) + Kimi extract (researchBrand.ts:121) | JSON | — | inbox_brands.description/enrichment | deals UI, voice brandNarration | — | BUILT · MAIN · prod-path |
| C4 | **First look** — themes from her captions | ≤10 captions | `FIRST_LOOK_THEMES_SYSTEM` firstLook.ts:150, **registry-resolved** (`first_look.themes`) | Gemini flash, JSON (firstLook.ts:161-164) | JSON | — | first-look output | onboarding reveal | — | BUILT · MAIN · prod-path |
| C5 | **socialWebResolver** — find/verify a handle + follower estimate | name, sport, team | inline | **Anthropic `claude-haiku-4-5-20251001`** + web_search (socialWebResolver.ts:28,98) | JSON | refuses to guess (header :1-18) | social identity | platformDiscovery | — | BUILT · MAIN · prod-path when ANTHROPIC_API_KEY set (it is, dev & prod yaml) |
| C6 | **M.I.A. evaluator** (Marketability Beta.1) — 44 judgements | athlete name + social block | `blind-eval-spec` v0.2, marketabilityBeta1EvaluatorSpec.ts · **digest-pinned** (`BLIND_EVAL_SPEC_V02_CANONICAL_SHA256` :511, asserted marketabilityBeta1Freeze.test.ts:39) | Gemini flash **+ its own googleSearch** (marketabilityBeta1Evaluator.ts:222-238), temp 1.0 | parsed judgement set, sha256 of judgements | parse; missing allowed | mia_evaluation_runs (60 rows, last 2026-09-25) | score / rings | 37-athlete blind-eval cohort (`server/scripts/calibration/runs/blind-eval-v2/`), Spearman 0.887 claimed (evaluator header :10-12) | BUILT · MAIN · prod-path (auth.ts:152 signup, admin.ts:326, workflow miaEvaluation/socialSync) |

## D. Commercial intelligence stack (Opportunity → Objective → Brain → planner)

| # | name · job | inputs | prompt/spec | provider/model | structured | gates | persistence | consumer | eval | status · path |
|---|---|---|---|---|---|---|---|---|---|---|
| D1 | **Opportunity evaluator** — where openings lie | Athlete State, context, research | `opportunity-eval-spec/1.2.0` (evalSpec.ts:39) · **digest-pinned** :298, test evalSpec.test.ts:293 (main has 1.0.0) | Gemini flash (opportunityBeta1Orchestrator.ts:126-127) | JSON + validators; key stabilization (stabilize.ts, orchestrator:165-166) | grounding + structural gates | **file artifact only** (opportunityRun.ts:68 writes JSON); no table write | Objective evaluator, Brain `map` block | `docs/audits/artifacts/opportunity-1.0.0-run*`, `-1.1.0-treatment`, `-1.2.0-forcing` | EXPERIMENTAL · OPEN_PR (1.2.0) / MAIN (1.0.0) · **harness** (only server/scripts/intelligence/opportunityRun.ts imports it) |
| D2 | **Objective evaluator** — proposes changed future states | State + Opportunity map | `objective-eval-spec/1.0.4` (evalSpec.ts:61) · **digest-pinned** :293, test :246 (main 1.0.2) | Gemini flash (objectiveBeta1Orchestrator.ts:94) | JSON proposal set | evidenceProblems + grounding (objective/store.ts:50) | objectives table via `persistProposalSet` (store.ts:59) — dev: 5 rows (3 active, 1 deferred, 1 declined) | athlete review via routes/objectives.ts:49-85 | `docs/audits/artifacts/objective-validation-cohort/objective-1.0.4` | EXPERIMENTAL · OPEN_PR · harness-invoked, product-visible (`OBJECTIVES_V1=true` dev) |
| D3 | **Brain** — WHAT and WHY per live Objective | Objectives, State, map, Existing Work, context, research, requests | `brain-eval-spec/0.12.0-exp` (contract.ts:24) · **digest-pinned** (evalSpec.ts:435; evalSpec.test.ts:197); prompt sha256 recorded per run (orchestrator:131) | Gemini flash, **no tools** (brainExperimentOrchestrator.ts:108-110), temp 1.0 | `responseSchema` with enum identifiers | structural + grounding + per-Decision gate F5 (orchestrator:118-124) | brain_runs (1 row, 0.12.0-exp, gemini-3.5-flash) + recommendations (3) via brainLoopDurable.ts:48 | Recommendation ledger → execution router | `docs/audits/artifacts/brain-substrate-live/*`, `brain-ownership-corpus/corpus.json`, `brain-context-experiment-1/**` | EXPERIMENTAL · OPEN_PR (main at 0.4.0-exp) · **harness** (scripts/intelligence/brainLoopDurable.ts:44 requires `BRAIN_SUBSTRATE_LOOP`; no route) |
| D4 | **Outreach planner** — HOW for a specialized_plan | PlannerHandoff + Objectives + Existing Work + exclusions | `planner-eval-spec/0.2.0-exp` (planner/contract.ts:11) · **digest-pinned AND runtime-enforced** (outreachPlannerOrchestrator.ts:59; evalSpec.ts:88) | Gemini flash, responseSchema (orchestrator:47) | schema + `validatePlanningResult` | flag, handoff shape, idempotency, reconcile/attach (orchestrator:6-10) | outreach_plans (0 rows) | none (no send path by design) | `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/shape/planner/*`; orchestrator test | EXPERIMENTAL · OPEN_PR · `flag:OUTREACH_PLANNER_ENABLED=off` · **no production caller** (`prepareOutreach` referenced only by its test) |
| D5 | Content planner | — | `plannerFor("content")` exists (planner/contract.ts:14-21) | only via plannerRun.ts `--planner content` | — | — | — | — | — | DESIGNED/harness only · deliberately not productionized |
| D6 | **Rate evaluator** (rate-eval-spec 2.0) | deal/athlete facts | rateBeta1EvaluatorSpec.ts · **digest-pinned + runtime-enforced in harness** (rateExperiment.ts:68) | via rateExperiment.ts (genai) | JSON | pin check | artifacts | none in product | `docs/audits/artifacts/rate-2.0-cohort` | EXPERIMENTAL · MAIN · harness. Product rates are deterministic `v3.1.0-calibrated` (rateModelConfig.ts:10) |
| D7 | Commercial assessment / deal projection | Deals rows + Deals functions | `commercial-assessment/0.1.0-exp` | **no model** (dealAssessmentProjection.ts:6-7) | — | — | — | Brain input | tests | EXPERIMENTAL · OPEN_PR |
| D8 | Execution router / readiness, Campaign, CreativeIntent store, State, Context, Identity | — | versioned contracts | **no model** (nothing under `services/intelligence/` imports a provider; `git grep genai` there → none) | — | — | — | — | tests | various |

## E. Media kit / deck / imagery / voice copy

| # | name · job | provider/model | prompt | status · path |
|---|---|---|---|---|
| E1 | **Strategist / shot list** (deck plan) | Gemini `GEMINI.pro` (3.1-pro-preview) shotList.ts:48,131 | inline `SYSTEM` shotList.ts:78 | BUILT · MAIN · prod-path (mediaKitService.ts:129-161) |
| E2 | **Narrator** — kit copy, multi-model + judge | Gemini pro (narrator.ts:27,202) + Kimi `kimiThinking` temp 0.9 (:209) + **Anthropic `claude-fable-5`** (:28,215) ; judge Gemini pro ranks only (:29,263) | inline | BUILT · MAIN · prod-path (mediaKitService.ts:170) |
| E3 | Curator | no model of its own; ranks visionTag tags + embeddings (curator.ts:14) | — | BUILT · MAIN |
| E4 | visionTag — image tags | Gemini flash (visionTag.ts:226-232) | inline | BUILT · MAIN · prod-path (mediaEnrichment) |
| E5 | Media embedding | Vertex `multimodalembedding@001` (mediaEmbed.ts:13; studio/qa/embed.ts:47) | — | BUILT · MAIN |
| E6 | Brand image vision ranking | Gemini flash (brandImage.ts:368-374) | inline | BUILT · MAIN |
| E7 | brandNarration — one spoken brand sentence | Gemini flash (voice/brandNarration.ts:75,266) | inline, JSON | BUILT · MAIN · prod-path (voice/dealBriefRoute) |

## F. Studio (listing only — Agent G owns Studio depth)

Model calls at `main 9fff9b15` (same ids at `3f0139f6`; stack only adds `studio/creative/*`, which calls the existing
`propose_campaign`/`research_moment`, interpret.ts:34-39):

| surface | model | where | prompt version |
|---|---|---|---|
| Studio agent planner | `STUDIO_AGENT_MODEL ?? GEMINI.pro` | studio/agent/config.ts:26; agent/plan.ts | — |
| Interpreter | `gemini-3.5-flash` | studio/config.ts:1268; interpret/transport.ts:70 | `interpret/6` (interpret/prompt.ts:68) |
| Reference analysis | `gemini-3.5-flash` | config.ts:1321 | `reference/1` |
| Brief summariser | `gemini-3.5-flash` | config.ts:1348 | `summarize_brief/2` |
| `propose_campaign` (direction) | `gemini-3.1-pro-preview` | config.ts:1375 | `propose_campaign/1` |
| `research_moment` | Gemini flash + googleSearch via research provider | direction/moment.ts:1-30,397 | `research_moment/1` |
| QA vision / inspect / inspectClip | Gemini flash | qa/vision.ts:201; qa/inspect.ts:205,289; qa/inspectClip.ts:229 | — |
| Edit recommend / identity-on-accept / autoMask | Gemini flash | edit/recommend.ts:251,296; edit/identityOnAccept.ts:117; autoMask.ts:665,689 | `typed-op/1` |
| Video enrich tagging | `STUDIO_ENRICH_VIDEO_MODEL ?? GEMINI.flash` | enrich/config.ts:30 | — |
| Generators | `gemini-3-pro-image`, `gemini-3.1-flash-image`, `seedream-5-0-pro`, `veo-3.1`, `seedance-2.0(-fast)`, `kling-v3.0-std` (OpenRouter/Vertex), `fal-ai/sam-3` segmentation | studio/config.ts:37-52; adapters/openrouter.ts, vertex.ts, fal.ts | — |

Dev DB `generation_jobs` by model: gemini-3-pro-image 456, veo-3.1-generate-001 58, seedance-2.0-fast 31,
kling-v3.0-std 2 (last 2026-09-25). Studio prompts are versioned strings, **none digest-pinned**. Evals:
`server/studio/agent/eval/**` (census, conceptRun, fidelity), `server/scripts/studioPlanEval.ts`,
`studioConceptEval.ts`, interpret fixtures (`server/studio/interpret/fixtures/r1.json`, `scene.json`).

## G. Scripts-only / stale ids (not production)

`server/scripts/compareSearch.ts:203` and `server/scripts/testGeminiGrounding.ts:11` still pin `gemini-2.5-flash`
(also at main). Harness-only; no production call site uses a 2.5 id (`git grep "gemini-2\.[05]" -- server` outside
scripts → none).
