/**
 * acquisitionRegistry.ts — every path that acquires ATHLETE / WORLD knowledge from outside Nomila, with its owner,
 * purpose, disposition and exit criteria (Phase A research-acquisition architecture, LOCKED 30 Sep 2026:
 * D13 + R-c in §13, the §9.3 retirement gate, the §11 disposition table).
 *
 * Data only: nothing imports this at runtime and it imports nothing. acquisitionRegistry.test.ts enforces it in CI:
 *   - only an entry's `allowedImporters` may import that entry's guarded functions (a type-only import is not a use);
 *   - the external endpoints in ENDPOINTS appear only in their owning client;
 *   - nothing here is stale: every guarded module exports what is listed, every allowed importer still uses it;
 *   - every file that configures a provider web-search tool inline is in WEB_SEARCH_TOOL_OWNERS (closes the gap where
 *     an inline `genai()` + `googleSearch` call bypasses the import guard).
 *
 * To add an acquisition path: add (or extend) an entry with owner, purpose, disposition and exit criteria, and cite
 * the §11 row it falls under. A path §11 does not cover needs an architecture decision first, not just an entry.
 *
 * §-line citations below are to docs/architecture/phase-a/research-acquisition-architecture.md as merged in #709.
 */

/** §11 dispositions. */
export type Disposition = "KEEP" | "CONSOLIDATE" | "RETIRE" | "FALLBACK-ONLY" | "NEEDS-DESIGN";

/** A provider-calling module (repo-relative, no extension) and the exports that reach the provider. */
export interface GuardedModule { module: string; exports: readonly string[] }

/** A file allowed to call the guarded functions, and why. */
export interface AllowedImporter { file: string; why: string }

export interface AcquisitionEntry {
  id: string;
  owner: string;
  purpose: string;
  disposition: Disposition;
  /** The §11 row (doc line) this disposition comes from. */
  section11: string;
  /** Required unless KEEP: what must be true before the path changes or goes. */
  exitCriteria: string | null;
  guards: readonly GuardedModule[];
  allowedImporters: readonly AllowedImporter[];
}

export const ACQUISITION_REGISTRY: readonly AcquisitionEntry[] = [
  {
    id: "direct-research-provider",
    owner: "research",
    purpose: "Gemini direct research call (research-spec/1 queries, cited findings): the modern provider",
    disposition: "KEEP",
    section11: "§11 `geminiDirect` KEEP (doc :1077)",
    exitCriteria: null,
    guards: [{ module: "server/lib/research/providers/geminiDirect", exports: ["geminiDirect", "runGeminiDirectOnce"] }],
    allowedImporters: [
      { file: "server/skills/researchRefresh.ts", why: "the direct binding (RESEARCH_REFRESH_PROVIDER=direct): injected into the research_refresh v3 provider stage and the calibration loop (PR E2a, design record §5.8)" },
      { file: "server/scripts/calibration/providerBenchmark.ts", why: "benchmark tool, §11 providerBenchmark KEEP (dev) (doc :1085)" },
    ],
  },
  {
    // PR E2a: `direct-research-runner` (runDirectResearch, CONSOLIDATE) met its exit criterion — the per-query v3 stage
    // absorbed it and the calibration CLI runs that stage — so it was deleted with its entry (design record §5.8).
    id: "research-refresh-v3-stage",
    owner: "research",
    purpose: "research_refresh v3 provider stage: one research-spec/1 query per runner step (Q1 the identity gate), persisted per query; the v2 Trends/GDELT signals lane as its last step",
    disposition: "KEEP",
    section11: "§11 `research_refresh` v2 provider binding CONSOLIDATE → v3 (doc :1075) and `runDirectResearch` CONSOLIDATE into the v3 provider stage (doc :1076); research_refresh v3 per PR E design record §5",
    exitCriteria: null,
    guards: [{ module: "server/services/intelligence/research/v3Stage", exports: ["runV3Query", "runV3Signals", "runV3Calibration"] }],
    allowedImporters: [
      { file: "server/skills/researchRefresh.ts", why: "binds the real providers into the stage for the research_refresh v3 steps and the calibration loop" },
    ],
  },
  {
    id: "direct-research-calibration",
    owner: "calibration",
    purpose: "The calibration CLI's research: the v3 stage with governIdentity false (identity gate observed, never written; D9)",
    disposition: "KEEP",
    section11: "§11 calibration CLI KEEP (doc :1084)",
    exitCriteria: null,
    guards: [{ module: "server/skills/researchRefresh", exports: ["runDirectCalibration"] }],
    allowedImporters: [
      { file: "server/scripts/calibration/runDirectResearch.ts", why: "calibration CLI, §11 KEEP (doc :1084)" },
    ],
  },
  {
    id: "grounded-search-v2-binding",
    owner: "research",
    purpose: "Gemini grounded search used by the research_refresh v2 provider binding",
    disposition: "CONSOLIDATE",
    section11: "§11 `research_refresh` v2 provider binding (grounded + Kimi) CONSOLIDATE → v3 (doc :1075)",
    exitCriteria: "research_refresh v2 binding replaced by the v3 direct provider stage; no research caller left",
    guards: [{ module: "server/lib/research/providers/geminiGrounded", exports: ["groundedSearch", "runGeminiOnce"] }],
    allowedImporters: [
      { file: "server/skills/researchRefresh.ts", why: "research_refresh v2 provider binding (never executed; flags off)" },
      { file: "server/scripts/calibration/providerBenchmark.ts", why: "benchmark tool, §11 KEEP (dev) (doc :1085)" },
    ],
  },
  {
    id: "benchmark-providers",
    owner: "calibration",
    purpose: "OpenAI direct/web-search adapters and Kimi extraction v3, for provider benchmarks; the web-search adapter's runOpenAIOnce is also the sign-up quick score's one call",
    disposition: "KEEP",
    section11: "§11 `kimiExtractV3`, OpenAI adapters KEEP (benchmark only) (doc :1080)",
    exitCriteria: null,
    guards: [
      { module: "server/lib/research/providers/openaiDirect", exports: ["openaiDirect", "runOpenAIDirectOnce"] },
      { module: "server/lib/research/providers/openaiWebSearch", exports: ["webSearch", "runOpenAIOnce"] },
      { module: "server/lib/research/providers/kimiExtractV3", exports: ["extractWithCitationsV3", "extractPartitionedV3"] },
    ],
    allowedImporters: [
      { file: "server/scripts/calibration/providerBenchmark.ts", why: "benchmark tool, §11 KEEP (dev) (doc :1085)" },
      { file: "server/services/quickScore/step.ts", why: "the sign-up quick score's one OpenAI web-search call (openaiQuickScoreProvider: fast model, low context, search cap), one search provider (4 Nov 2026)" },
    ],
  },
  {
    id: "kimi-cited-extraction",
    owner: "research",
    purpose: "Kimi cited-claims/2 extraction over search envelopes",
    disposition: "FALLBACK-ONLY",
    section11: "§11 `kimiExtract` FALLBACK-ONLY, no normal caller (doc :1079; D8)",
    exitCriteria: "No normal-path caller: the remaining importer retires (v2 binding → v3; the dual-write importer is already gone). A fallback caller needs a new entry",
    guards: [{ module: "server/lib/research/providers/kimiExtract", exports: ["extractWithCitations"] }],
    allowedImporters: [
      { file: "server/skills/researchRefresh.ts", why: "research_refresh v2 provider binding (flags off), CONSOLIDATE (doc :1075)" },
    ],
  },
  {
    id: "kimi-web-search",
    owner: "research",
    purpose: "Moonshot-hosted Kimi $web_search (only this symbol; lib/kimi.ts is otherwise a generic model wrapper)",
    disposition: "RETIRE",
    section11: "§11 `kimiSearch` RETIRE, no callers (doc :1081)",
    exitCriteria: "Delete kimiSearch; it has no caller and none may be added",
    guards: [{ module: "server/lib/kimi", exports: ["kimiSearch"] }],
    allowedImporters: [],
  },
  {
    id: "legacy-research-athlete",
    owner: "research",
    purpose: "Legacy researchAthlete: grounded ×5 + Kimi + Trends + GDELT + legacy platform discovery",
    disposition: "RETIRE",
    section11: "§11 `researchAthlete` RETIRE (gate §9.3) (doc :1072); research_refresh v1 RETIRE (:1073); reEnrichAthletes RETIRE (:1094); POST /athletes/:id/research CONSOLIDATE → v3 (:1095)",
    exitCriteria: "§9.3 gates G1–G7 (doc :771-777). Admin re-research reaches it only through the research_refresh v1 definition",
    guards: [{ module: "server/skills/researchAthlete", exports: ["researchAthlete"] }],
    allowedImporters: [
      { file: "server/workflow/definitions/onboarding.ts", why: "onboarding run at account creation (lifecycle trigger until G3)" },
      { file: "server/workflow/definitions/researchRefresh.ts", why: "research_refresh v1 definition (admin re-research while the planner gate is false)" },
      { file: "server/skills/reEnrichAthletes.ts", why: "monthly re-enrichment cron, RETIRE (self-suppresses once the planner executes)" },
    ],
  },
  {
    id: "legacy-platform-discovery",
    owner: "social",
    purpose: "Legacy platform discovery inside researchAthlete (the one discovery client → athlete_snapshots.social; the Claude web resolver rung was deleted 4 Nov 2026)",
    disposition: "RETIRE",
    section11: "§11 `lib/platformDiscovery.ts` fetchers CONSOLIDATE (done, #712), then RETIRE with legacy (doc :1088)",
    exitCriteria: "G7 (doc :777): deleted with researchAthlete",
    guards: [{ module: "server/lib/platformDiscovery", exports: ["runPlatformDiscovery"] }],
    allowedImporters: [
      { file: "server/skills/researchAthlete.ts", why: "legacy research, RETIRE behind G1–G7" },
    ],
  },
  {
    id: "public-platform-discovery",
    owner: "social",
    purpose: "The one public discovery client: IG Business Discovery + YouTube Data API for unconnected platforms",
    disposition: "KEEP",
    section11: "§11 `lib/integrations/discovery.ts` KEEP, the one client (doc :1089); collectDiscoveryAnalytics KEEP (:1091)",
    exitCriteria: null,
    guards: [{
      module: "server/lib/integrations/discovery",
      exports: ["requestInstagramBusinessDiscovery", "requestYouTubeChannel", "requestYouTubePlaylistItems", "requestYouTubeVideos", "fetchInstagramDiscovery", "fetchYouTubeDiscovery"],
    }],
    allowedImporters: [
      { file: "server/skills/collectDiscoveryAnalytics.ts", why: "nightly discovery cron, KEEP (doc :1091)" },
      { file: "server/lib/platformDiscovery.ts", why: "legacy platform discovery, RETIRE with legacy at G7 (doc :1088)" },
      { file: "server/services/marketabilityBeta1SocialBlock.ts", why: "dormant M.I.A. social block (discovery: true never passed), CONSOLIDATE → one client (doc :1087)" },
    ],
  },
  {
    id: "attention-signals",
    owner: "research",
    purpose: "Google Trends interest and GDELT news volume, as signals",
    disposition: "KEEP",
    section11: "§11 Trends / GDELT KEEP as signals, never volume (doc :1093)",
    exitCriteria: null,
    guards: [
      { module: "server/lib/trends", exports: ["fetchGoogleTrends"] },
      { module: "server/lib/gdelt", exports: ["fetchGdelt"] },
    ],
    allowedImporters: [
      { file: "server/skills/researchAthlete.ts", why: "legacy research, RETIRE behind G1–G7" },
      { file: "server/skills/researchRefresh.ts", why: "research_refresh v2 provider binding (flags off), CONSOLIDATE → v3; the same lane is the v3 signals step (D13, PR E2a), bound in the same file" },
    ],
  },
  {
    id: "mia-evaluator-research",
    owner: "marketability (M.I.A.)",
    purpose: "The M.I.A. evaluator call: facts-only (no tools), scoring only from the facts held in memory. Its own grounded research call (Gemini + googleSearch) was retired 4 Nov 2026 (one search provider): an athlete with no memory facts is not evaluated",
    disposition: "KEEP",
    section11: "§11 M.I.A. evaluator grounded research KEEP (ADR-017) (doc :1086), superseded 4 Nov 2026: owner decision, M.I.A. never searches",
    exitCriteria: null,
    guards: [{ module: "server/services/marketabilityBeta1Evaluator", exports: ["callEvaluator"] }],
    allowedImporters: [
      { file: "server/services/marketabilityBeta1Orchestrator.ts", why: "the M.I.A. evaluation run (identity invariant applies to every trigger)" },
      { file: "server/services/miaPreview/factsOnlyInMemory.ts", why: "the facts-only evaluator call (no tools) on facts held in memory, for the leanRun command's shadow mode (dev, writes nothing); the same prompt, parser and enforcement as the evaluation run" },
    ],
  },
  {
    id: "mia-quick-score",
    owner: "marketability (M.I.A.)",
    purpose: "The sign-up quick score: ONE OpenAI web-search call (fast model, low search context; openaiWebSearch.ts runOpenAIOnce) with the existing search-enabled M.I.A. prompt, beside the sign-up research (signup_research v3, QUICK_SCORE_ONE_CALL, dev only). Writes no memory_facts; the answer's score is shown to the athlete who asked, with the cited pages as clickable links, and is never handed to another model or fetcher",
    disposition: "NEEDS-DESIGN",
    section11: "§11 has no row: owner decision 26 Oct 2026 (one-call quick score, evidence from the PR #1129 comparison); adding one is a doc follow-up",
    exitCriteria: "The dev evaluation decides: KEEP (then prod) or RETIRE (delete the step and v3). The Google-grounding store gate (QUICK_SCORE_STORE_GROUNDED) went with the move to OpenAI web search, 4 Nov 2026",
    guards: [{ module: "server/services/quickScore/step", exports: ["openaiQuickScoreProvider", "runQuickScoreStep", "QUICK_SCORE_STEP"] }],
    allowedImporters: [
      { file: "server/agent/onboarding/signupResearchWorkflow.ts", why: "signup_research v3's quick_score step (opt-in, QUICK_SCORE_ONE_CALL)" },
    ],
  },
  {
    id: "agent-research-skills",
    owner: "agent harness",
    purpose: "The Research skill (two independent OpenAI web_search passes, then a merge), the Understand skill (no web search since understand 1.11.0) and the weekly moments scan (one OpenAI web_search call on the fast tier), as structured skill calls (Responses API, JSON schema, the sources each search saw). Facts are kept only with a URL the run saw (a schedule or partner moment may instead rest on the athlete's own fact or deal, as a source ref), as memory_facts; every call is an agent_runs row with its searches in the trace",
    disposition: "KEEP",
    section11: "The 9 Oct 2026 rebuild (agent build plan v2): Research and Understand rebuilt fresh on the harness from the tested baseline prompt; §11 `geminiDirect` KEEP, the modern direct-provider path (doc :1077); §11 has no row for these skills yet, adding one is a doc follow-up",
    exitCriteria: "Replaces legacy-research-athlete and research-refresh-v3-stage for onboarding once AGENT_ONBOARDING is on; each legacy entry retires by its own criteria",
    guards: [
      { module: "server/agent/research/llm", exports: ["callStructured"] },
      { module: "server/agent/research/runSkill", exports: ["runSkill"] },
    ],
    allowedImporters: [
      { file: "server/agent/research/runSkill.ts", why: "the one place a structured skill call is made, traced and costed (agent_runs)" },
      { file: "server/agent/research/research.ts", why: "the Research skill: two search passes and the merge" },
      { file: "server/agent/research/v2/extract.ts", why: "narrow research v2 EXTRACT (research/extract skill; SHADOW only behind RESEARCH_PIPELINE_V2_SHADOW, on in dev, off in prod): no tools, no web search; reads only pages our own fetcher read; output goes through the research pass checks and is stored only in the shadow run's step output" },
      { file: "server/agent/research/v2/discover.ts", why: "narrow research v2 DISCOVER, the one search provider (OpenAI; the Gemini grounding arm was removed 4 Nov 2026; SHADOW only): fast tier, web_search capped at 1 call at low context, links only. Not a runSkill call because it is one search per planned query; the extract step is the traced skill run" },
      { file: "server/agent/research/v2/extractAll.ts", why: "LEAN research's two model steps (research/extract-all, research/verify-facts; signup_research v4 and lean_research_refresh behind LEAN_SIGNUP_RESEARCH, dev on, prod off; and the leanRun shadow command): no tools, no web search, over pages our own fetcher read. LIVE through runSkill (agent_runs, cost, retry reuse); SHADOW through callStructured with no row and nothing written" },
      { file: "server/agent/research/understand.ts", why: "the Understand skill (the Brief; no web search since understand 1.11.0)" },
      { file: "server/agent/onboarding/turn.ts", why: "an onboarding turn (no web search; the same traced skill call)" },
      { file: "server/services/atmosphere/model.ts", why: "the atmosphere/queries and atmosphere/check skill calls (cheap tier = Gemini Flash on Vertex via agent/geminiProvider.ts, no web search): search words for, and a vision check of, an atmosphere image; the outside fetch is the atmosphere-imagery entry" },
      { file: "server/agent/plan/run.ts", why: "plan skill call; reasoning tier, no tools, no web search" },
      { file: "server/agent/plan/tell.ts", why: "the plan/ready skill call (Mila's follow-up line when a plan she asked for in chat is done): reasoning tier, no tools, no web search; it writes only from a facts object built by code, and code checks the line before it is shown. Nothing outside is fetched" },
      { file: "server/skills/researchBrand.ts", why: "brand research (OUT OF SCOPE, R-c: brand knowledge, not athlete): four OpenAI web searches per brand on the fast tier at low context (≤2 calls each), plus the one-call official-site search; Kimi extracts the profile. One search provider, owner 4 Nov 2026" },
      { file: "server/studio/direction/moment.ts", why: "Studio research_moment (OUT OF SCOPE, R-c; §11 doc :1097): ONE OpenAI web search per ask on the fast tier at low context, behind STUDIO_DIRECTION_MOMENTS and the shared per-athlete limiter; writes no athlete knowledge" },
      { file: "server/agent/moments/scan.ts", why: "the weekly moments scan (skill moments): fast tier (OpenAI), web_search capped at AGENT_MOMENTS_MAX_SEARCHES, behind AGENT_MOMENTS (on in dev, off in prod)" },
      { file: "server/agent/postKit/build.ts", why: "the post-kit/match skill call (cheap tier = Gemini Flash on Vertex, no tools, no web search): re-rank the athlete's own library candidates against one post's brief; nothing outside is fetched" },
      { file: "server/agent/postKit/ideas.ts", why: "the post-kit/ideas skill call (cheap tier = Gemini Flash on Vertex, no tools, no web search): post ideas from the athlete's own new media; nothing outside is fetched" },
      { file: "server/skills/dealEngineModels.ts", why: "the deal-engine/summary and deal-engine/partition skill calls (cheap tier = Gemini Flash on Vertex, no tools, no web search; behind DEALS_SUMMARY_FLASH / DEALS_PARTITION_FLASH, default off): a deal thread's summary + term sheet and the same-deal partition, read from the athlete's own stored mail; nothing outside is fetched" },
      { file: "server/agent/playbook/refresh.ts", why: "the shared content playbook refresh (skill playbook): fast tier (OpenAI), web_search capped at PLAYBOOK.MAX_SEARCHES, behind AGENT_PLAYBOOK (off in both yamls); not athlete-scoped (one call per sport×stage×platform key, shared across every athlete at that key), so it calls callStructured directly rather than the athlete-scoped runSkill wrapper" },
      { file: "server/services/opportunityRead.ts", why: "the deal-read skill call (a deal's fit and goal lines): fast tier (OpenAI), no tools, no web search; reads only confirmed brand research already stored, her facts and her goals, and stores two checked lines in deal_reads; behind DEALS_READ_MODEL (off). Nothing outside is fetched" },
      { file: "server/services/brandCoverSearchModel.ts", why: "the brand/cover-search skill call: fast tier (OpenAI), web_search capped at 1 call; brand knowledge, not athlete (pages that show a brand's products, read by lib/brandImage for a card cover; every image is fetched and vision-ranked before it is used). Not athlete-scoped, so it calls callStructured directly like brandSiteSearchModel" },
      { file: "server/agent/engine/mastra/webSearch.ts", why: "Mila's chat web_search on Mastra (P1, 5 Nov 2026; the harness chat's provider built-in, as our own tool): the chat/web-search skill call, fast tier (OpenAI), web_search capped at 1 call per tool call and at the chat skill's max_web_searches (2) a turn, through runSkill (an agent_runs row per search, in the athlete's day cap); returns a short answer for the turn and the provider's pages for its \"How I got this\" card; nothing is kept as a fact" },
      { file: "server/voice/webSearchRoute.ts", why: "the voice/web-search skill call (Mila voice, MILA_VOICE_WEB_SEARCH): fast tier (OpenAI), web_search capped at 1 call, through runSkill (an agent_runs row in the athlete's day cap); returns bounded title/snippet/hostname/url hits for one spoken answer and persists only a sources card (title + link per page) in the voice session's own chat thread" },
      { file: "server/services/brandSiteSearchModel.ts", why: "the brand/official-site skill call: fast tier (OpenAI), web_search capped at 1 call; brand knowledge, not athlete (finds a domain-less brand's own site so its logo can show; code checks the homepage before anything is stored). Not athlete-scoped, so it calls callStructured directly like the playbook refresh" },
      { file: "server/agent/onboarding/footprintCheck.ts", why: "the onboarding/athlete-footprint skill call (the \"real athlete?\" check before sign-up research; ATHLETE_FOOTPRINT_CHECK): fast tier (OpenAI), web_search capped at 1 call, through runSkill (an agent_runs row counted in the daily sign-up cap). It stores only { found, confidence, reason } as an admin flag and gates the full research; no fact is kept from it" },
      { file: "server/services/dealReply.ts", why: "the deal-engine/reply skill call (DEALS_REPLY_V2, off): fast tier (OpenAI), no tools, no web search (max_web_searches 0); writes one reply body from the deal thread for her to review — nothing outside is fetched and nothing is sent without her tap" },
    ],
  },
  {
    id: "atmosphere-imagery",
    owner: "atmosphere imagery",
    purpose: "Stock atmosphere photos (venues, surfaces, equipment, light, texture; never a person, logo or text) from the Pixabay API for screens not about the athlete: search (cached 24 h, rate-limited) and download of the few candidates checked; accepted images stored as our own copies in atmosphere_images. Behind ATMOSPHERE_IMAGERY (off in dev and prod)",
    disposition: "KEEP",
    section11: "§11 has no imagery row: world imagery, not athlete knowledge. Owner decision 10 Oct 2026 (DESIGN.md §9, draft #900) chose Pixabay stored copies with a credit line; adding a §11 row is a doc follow-up",
    exitCriteria: null,
    guards: [{ module: "server/services/atmosphere/pixabay", exports: ["searchPixabay", "downloadHit"] }],
    allowedImporters: [
      { file: "server/services/atmosphere/picker.ts", why: "the atmosphere picker: the one caller, after stored reuse and inside the per-athlete and daily cost caps" },
    ],
  },
  {
    id: "atmosphere-library-import",
    owner: "atmosphere imagery",
    purpose: "The SHARED atmosphere library (0120): hand-picked individual Unsplash (Unsplash License; Unsplash+ refused) or Pexels (Pexels License) photos downloaded once — Unsplash through each photo page's normal download URL, Pexels directly from its keyless image CDN — resized to WebP and stored under atmosphere/shared/ for every athlete. A person runs the import scripts with a list of photo pages; nothing runs at request time, no Unsplash or Pexels API beyond that one keyless CDN fetch, no search",
    disposition: "KEEP",
    section11: "§11 has no imagery row: world imagery, not athlete knowledge. Owner decision 10 Oct 2026 (one shared library, stored copies, no API, no per-athlete spend); adding a §11 row is a doc follow-up",
    exitCriteria: null,
    guards: [{ module: "server/services/atmosphere/library", exports: ["downloadUnsplashPhoto", "downloadPexelsPhoto"] }],
    allowedImporters: [
      { file: "scripts/fill-atmosphere-library.ts", why: "the list import (and, through it, scripts/import-atmosphere-image.ts for one photo): run by a person, dry run by default" },
    ],
  },
];

/** External endpoints that only their owning client may name. Scanned in non-test source under server/ and scripts/. */
export interface EndpointOwnership { id: string; pattern: RegExp; owners: readonly AllowedImporter[] }

export const ENDPOINTS: readonly EndpointOwnership[] = [
  {
    id: "ig-business-discovery",
    pattern: /business_discovery\.username\(\$\{/, // a built request, not the family name used as lineage vocabulary
    owners: [{ file: "server/lib/integrations/discovery.ts", why: "the one public discovery client" }],
  },
  {
    id: "youtube-data-api",
    pattern: /googleapis\.com\/youtube\/v3/,
    owners: [
      { file: "server/lib/integrations/discovery.ts", why: "public channel discovery (API key)" },
      { file: "server/lib/integrations/youtube.ts", why: "connected OAuth pull of the athlete's own channel (mine=true); §11 collectSocialAnalytics KEEP (doc :1092)" },
    ],
  },
  {
    id: "gdelt",
    pattern: /api\.gdeltproject\.org/,
    owners: [{ file: "server/lib/gdelt.ts", why: "the GDELT client" }],
  },
  {
    id: "google-trends",
    pattern: /(?:\bimport\s*\(|\brequire\s*\(|\bfrom)\s*["']google-trends-api["']/, // loading the package, not the provider label
    owners: [{ file: "server/lib/trends.ts", why: "the Trends client" }],
  },
  {
    id: "pixabay-api",
    pattern: /pixabay\.com\/api/,
    owners: [{ file: "server/services/atmosphere/pixabay.ts", why: "the Pixabay client (atmosphere-imagery)" }],
  },
  {
    id: "unsplash-photo-download",
    pattern: /unsplash\.com\/photos\/\$\{/, // a built download request, not a photo page named in a comment or a list
    owners: [{ file: "server/services/atmosphere/library.ts", why: "the one download of a hand-picked photo (atmosphere-library-import)" }],
  },
  {
    id: "pexels-photo-download",
    pattern: /images\.pexels\.com\/photos\/\$\{/, // a built CDN download request, not a photo page named in a comment or a list
    owners: [{ file: "server/services/atmosphere/library.ts", why: "the one download of a hand-picked photo (atmosphere-library-import)" }],
  },
];

/**
 * Existing files that break the guard and are NOT registered: duplicate acquisition paths kept only until they are
 * deleted. The test tolerates exactly these findings and fails once one disappears, so this list can only shrink.
 * Never add to it.
 */
export interface KnownViolation { file: string; findings: readonly string[]; exitCriteria: string }

// Empty: both prior violations (_testDiscovery.ts, _debugEnrichment.ts) were deleted (#716 guard, this registry's
// own exit criteria). Keep the mechanism — add an entry here, never widen an existing one, for the next genuine
// duplicate acquisition path found before it can be registered or deleted outright.
export const KNOWN_UNREGISTERED: readonly KnownViolation[] = [];

/**
 * Deliberately OUTSIDE the guard (R-c, doc :1215): not athlete/world acquisition, or not guardable without guarding a
 * generic model wrapper. Listed so the boundary is a decision, not an omission.
 */
export interface OutOfScope { id: string; files: readonly string[]; reason: string }

export const OUT_OF_SCOPE: readonly OutOfScope[] = [
  { id: "studio-generation", files: ["server/studio/direction/moment.ts"], reason: "Studio generation incl. research_moment: creative, not athlete acquisition (R-c; §11 doc :1097). Its use of the grounded call is listed on grounded-search-v2-binding" },
  { id: "brand-research", files: ["server/skills/researchBrand.ts", "server/services/brandIntel.ts"], reason: "researchBrand acquires brand, not athlete, knowledge (R-c; §11 doc :1097)" },
  { id: "inbox-classification", files: ["server/skills/dealDetector.ts"], reason: "kimiInstant classifies the athlete's own inbox; untouched by D8 (R-c)" },
  { id: "generic-llm-helpers", files: ["server/lib/models.ts", "server/lib/kimi.ts", "server/lib/llm.ts"], reason: "Generic model wrappers used for non-acquisition work; guarding them would guard every LLM call. Only kimiSearch is guarded (kimi-web-search)" },
  { id: "connected-oauth-pulls", files: ["server/skills/collectSocialAnalytics.ts", "server/skills/collectInstagramStories.ts"], reason: "The athlete's own connected accounts via OAuth; call no guarded function (§11 KEEP doc :1092). The YouTube host is owned by lib/integrations/youtube.ts in ENDPOINTS" },
  { id: "first-look", files: ["server/workflow/definitions/firstLook.ts"], reason: "Arithmetic over the athlete's own posts plus one caption call; not research (§11 KEEP doc :1096)" },
  { id: "blind-eval-calibration", files: ["server/scripts/calibration/blindEval/runBlindEval.ts"], reason: "Dev calibration tool (§11 KEEP (dev) doc :1085); calls providers inline through the generic wrappers, so it is not guardable here" },
  { id: "search-score-eval", files: ["server/scripts/research/searchScoreEval.ts"], reason: "Dev comparison harness (PR #1129): quick search + M.I.A. score across Vertex models; dry-run by default, --run needs the owner's OK; reads the dev database, writes only a local JSON file. Calls Gemini's googleSearch inline through the generic genai() wrapper, so it is not guardable here; its result never reaches memory_facts or the ledger" },
  { id: "brand-imagery", files: ["server/lib/brandImage.ts", "server/services/brandCoverSearchModel.ts"], reason: "OpenAI web search for pages showing a brand's products, read for a card cover (fetchBrandImagesViaSearch, skill brand/cover-search): brand, not athlete, knowledge, same family as brand-research (R-c)" },
];

/**
 * WEB-SEARCH TOOL OWNERSHIP. The import guard above only sees calls to a guarded function; an inline
 * `genai().models.generateContent({ config: { tools: [{ googleSearch: {} }] } })` (or any provider's own web-search
 * tool) reaches the web without importing anything guarded. So every non-test file that CONFIGURES a provider
 * web-search / grounding tool is listed here, and acquisitionRegistry.test.ts fails on an unlisted file, on a pattern
 * a file uses but does not list, and on a listed pattern or file that is gone.
 *
 * Each file is either
 *   - `registered`: it IS the guarded module of an ACQUISITION_REGISTRY entry, so every caller already passes the
 *     import guard; or
 *   - `out-of-scope`: it is named in an OUT_OF_SCOPE group (Mila ephemeral grounding, brand, Studio, dev tooling).
 * Listing a file here never makes it an athlete/world acquisition path; a new one needs an ACQUISITION_REGISTRY entry
 * (and a §11 row) first.
 */
export type WebSearchPattern =
  | "gemini-google-search" // `googleSearch` / `googleSearchRetrieval` / `google_search(_retrieval)` tool key, or `type: "google_search"`
  | "anthropic-web-search" // `type: "web_search_YYYYMMDD"` server tool
  | "openai-web-search" //    `type: "web_search"` / `"web_search_preview"` tool, or `web_search_options`
  | "kimi-web-search"; //     Moonshot builtin function `"$web_search"`

export type WebSearchOwnership =
  | { kind: "registered"; entry: string }
  | { kind: "out-of-scope"; group: string };

export interface WebSearchToolOwner { file: string; patterns: readonly WebSearchPattern[]; owner: WebSearchOwnership; why: string }

export const WEB_SEARCH_TOOL_OWNERS: readonly WebSearchToolOwner[] = [
  // (a) registered acquisition paths: the file is the entry's guarded module
  { file: "server/lib/research/providers/geminiDirect.ts", patterns: ["gemini-google-search"], owner: { kind: "registered", entry: "direct-research-provider" }, why: "the modern direct research provider" },
  { file: "server/lib/research/providers/geminiGrounded.ts", patterns: ["gemini-google-search"], owner: { kind: "registered", entry: "grounded-search-v2-binding" }, why: "grounded search for the v2 binding" },
  { file: "server/lib/research/providers/openaiDirect.ts", patterns: ["openai-web-search"], owner: { kind: "registered", entry: "benchmark-providers" }, why: "benchmark-only OpenAI direct adapter" },
  { file: "server/lib/research/providers/openaiWebSearch.ts", patterns: ["openai-web-search"], owner: { kind: "registered", entry: "benchmark-providers" }, why: "OpenAI web-search adapter: the benchmark arm, and runOpenAIOnce for the sign-up quick score" },
  { file: "server/lib/kimi.ts", patterns: ["kimi-web-search"], owner: { kind: "registered", entry: "kimi-web-search" }, why: "kimiSearch is the only $web_search use; RETIRE, no callers" },
  { file: "server/skills/researchAthlete.ts", patterns: ["gemini-google-search"], owner: { kind: "registered", entry: "legacy-research-athlete" }, why: "legacy research runs its own inline grounded calls; entry point guarded, RETIRE at G1–G7" },
  { file: "server/agent/research/runSkill.ts", patterns: ["openai-web-search"], owner: { kind: "registered", entry: "agent-research-skills" }, why: "runSkill passes a skill's web_search budget to callStructured and records each search (queries, sources) as a web_search trace step" },
  { file: "server/agent/research/llm.ts", patterns: ["openai-web-search"], owner: { kind: "registered", entry: "agent-research-skills" }, why: "callStructured offers web_search to the research and moments skills and returns every source the searches saw; callStructured guarded" },
  // (b) explicitly out of scope: not athlete/world acquisition (R-c)
  { file: "server/scripts/calibration/blindEval/runBlindEval.ts", patterns: ["gemini-google-search", "kimi-web-search", "openai-web-search"], owner: { kind: "out-of-scope", group: "blind-eval-calibration" }, why: "local blind-eval experiment; writes files only" },
  { file: "server/scripts/research/searchScoreEval.ts", patterns: ["gemini-google-search"], owner: { kind: "out-of-scope", group: "search-score-eval" }, why: "local search + score comparison harness; dry-run default, writes files only" },
];
