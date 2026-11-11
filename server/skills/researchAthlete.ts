/**
 * researchAthlete.ts — Full athlete enrichment pipeline
 *
 * Gemini Grounding (4 parallel searches) → Kimi extraction (4 parallel) →
 * snapshot insert → athletes_current (story arc + research timestamp only)
 *
 * Legacy retirement P2-4 (8 Oct 2026): research no longer computes the legacy /850 score or the v3 rate
 * card (athlete_snapshots.score dropped by 0127); the athlete's score is M.I.A. (the marketability ledger).
 *
 * Called on: signup, manual refresh, scheduled re_enrich.
 * Social follower data (Composio) is NOT fetched here — Audience Capital
 * will be low until a social_connect trigger runs.
 */

import { genai, GEMINI } from "../lib/models";
import { kimiInstant } from "../lib/kimi";
import { fetchGoogleTrends } from "../lib/trends";
import { fetchGdelt } from "../lib/gdelt";
import { runPlatformDiscovery } from "../lib/platformDiscovery";
import { db } from "../db";
import { athletes, athleteSnapshots, socialAnalyticsSnapshots } from "../../shared/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { writeAthletesCurrent } from "../services/athletesCurrentWriter";
import { buildSocialFromAnalytics } from "./socialFromAnalytics";
import { mergeSocialSources, unionResearch } from "./researchMerge";
import { createLogger } from "../logger";
import { snapshotDealsFor } from "../services/snapshotDeals";
import { proposeFoundAffiliations, teamsFromAchievements, type FoundTeamInput } from "../services/affiliations";

const logger = createLogger("research-athlete");

const MAX_RETRY = 5;
// How many prior research snapshots a run unions with (see researchMerge.ts). Five covers a
// season of monthly re-enrichments plus a couple of manual runs.
const PRIOR_RESEARCH_DEPTH = 5;

// ─── Prompts ───────────────────────────────────────────────────────────────────

export const GEMINI_SYSTEM =
  "You are a sports research analyst compiling a verified athlete dossier. " +
  "Always use Google Search to find current, accurate information — do not answer from memory. " +
  "Search multiple distinct facets: profile and background, social media accounts, local and national press, " +
  "conference and league awards, statistics and records, brand partnerships, and media assets. " +
  "Attribute every fact to a specific source. If a fact cannot be found, say so explicitly. " +
  "Be thorough — a richer dossier is always better than a brief one.";

export const EXTRACTION_SYSTEM =
  "You are a sports data extraction engine. Extract structured data from research text. " +
  "Return ONLY valid JSON matching the schema exactly — no markdown fences, no explanation, no trailing commas. " +
  "Use null for missing string fields, [] for missing arrays. " +
  "For press_mentions: extract ANY media outlet mentioned in the text, even if embedded in narrative form. " +
  "If the text says 'per ESPN' or 'The Athletic reported' or 'according to the campus paper', extract it as a press mention. " +
  "The headline can be inferred from the surrounding context — a topic summary is acceptable. Do not require a formal headline. " +
  "For social handles: only extract if you see an actual @handle or account name, not just a mention of the platform. " +
  "For media assets: only include URLs visible in the research text — do not fabricate URLs. " +
  "Never invent data not present in the research text.";

export const EXTRACTION_SCHEMA = `{
  "profile": {
    "sport": "<string or null>",
    "school": "<string or null>",
    "hometown": "<string or null>",
    "class_year": "<string or null>",
    "position": "<string or null>",
    "conference": "<string or null>",
    "division": "<string or null>"
  },
  "social_handles": {
    "instagram": "<@handle or null>",
    "tiktok": "<@handle or null>",
    "x": "<@handle or null>",
    "youtube": "<channel name or null>"
  },
  "achievements": [{ "name": "<string>", "year": "<string>", "level": "<national|conference|academic|team or null>" }],
  "teams": [{ "org": "<team, school, club, national or Olympic programme as named in the text>", "kind": "<school|club|pro|national|olympic>", "level": "<as named, e.g. college division, pro league, national age-group team, senior … or null>", "role": "<captain … or null>", "from": "<YYYY or null>", "to": "<YYYY, or null if current>" }],
  "press_mentions": [{ "outlet": "<string>", "headline": "<string>", "date": "<YYYY-MM-DD or null>" }],
  "brand_deals": [{ "brand": "<string>", "type": "<partnership|gifted|feature|team_apparel or null>", "confidence": "<0.0-1.0 float>" }],
  "nil_valuation_mentions": [{ "source": "<string>", "value": "<string>" }],
  "media_assets": {
    "images": [{ "url": "<string>", "source": "<string>", "description": "<string>", "type": "<headshot|action|event|brand>" }],
    "videos": [{ "url": "<string>", "source": "<string>", "title": "<string>", "platform": "<youtube|tiktok|other>" }],
    "audio":  [{ "url": "<string>", "source": "<string>", "title": "<string>", "platform": "<spotify|apple_podcasts|youtube|other>" }]
  },
  "story_arc": "<2-3 sentence narrative summary or null>",
  "sentiment": { "positive": "<integer count of positive mentions>", "negative": "<integer count of negative mentions>" }
}`;

// ─── Types ─────────────────────────────────────────────────────────────────────

type GroundingChunk = { uri: string; title: string; domain: string };

type GroundingSupport = { segment?: { startIndex?: number; endIndex?: number; text?: string }; groundingChunkIndices?: number[]; confidenceScores?: number[] };

type GeminiRaw = {
  text:               string;
  groundingChunks:    GroundingChunk[];
  /** Step 2a: the provider's own answer-span → chunk mapping, preserved for citation validation. Additive; unread by the legacy path. */
  groundingSupports?: GroundingSupport[];
  webSearchQueries:   string[];
  finishReason:       string;
  promptTokens?:      number;
  candidateTokens?:   number;
};

type GeminiAttempt = {
  attempt:     number;
  textLength:  number;
  chunkCount:  number;
  empty:       boolean;
};

type GeminiWithRetry = {
  result:         GeminiRaw;
  attempts:       GeminiAttempt[];
  retriesFired:   number;
  finallyEmpty:   boolean;
};

interface ExtractedData {
  profile:                { sport?: string | null; school?: string | null; hometown?: string | null; class_year?: string | null; position?: string | null; conference?: string | null; division?: string | null };
  social_handles:         { instagram?: string | null; tiktok?: string | null; x?: string | null; youtube?: string | null };
  achievements:           Array<{ name: string; year?: string; level?: string | null }>;
  teams?:                 Array<{ org: string; kind?: string | null; level?: string | null; role?: string | null; from?: string | null; to?: string | null }>;
  press_mentions:         Array<{ outlet: string; headline: string; date?: string | null }>;
  brand_deals:            Array<{ brand: string; type?: string | null; confidence?: number | string | null }>;
  nil_valuation_mentions: Array<{ source: string; value: string }>;
  media_assets:           { images: unknown[]; videos: unknown[]; audio: unknown[] };
  story_arc?:             string | null;
  sentiment?:             { positive?: number | string | null; negative?: number | string | null } | null;
  _parseError?:           string;
}

interface MergedResearch {
  profile:                ExtractedData["profile"];
  social_handles:         ExtractedData["social_handles"];
  achievements:           ExtractedData["achievements"];
  teams:                  NonNullable<ExtractedData["teams"]>;
  press_mentions:         ExtractedData["press_mentions"];
  brand_deals:            ExtractedData["brand_deals"];
  nil_valuation_mentions: ExtractedData["nil_valuation_mentions"];
  media_assets:           ExtractedData["media_assets"];
  story_arc:              string | null;
  sentiment:              { positive: number; negative: number } | null;
}

export interface ResearchAthleteResult {
  snapshotId: string;
  athleteId:  string;
  extracted: {
    achievements:   number;
    press:          number;
    brands:         number;
    handles:        Record<string, string | null>;
    images:         number;
    videos:         number;
  };
  reliability: {
    queriesSucceeded:     number;
    queriesTotal:         number;
    totalRetriesFired:    number;
    groundingChunksTotal: number;
  };
  kimiUsage: {
    promptTokens:     number;
    completionTokens: number;
  };
  enrichment: {
    trendsScore:   number;
    gdeltArticles: number;
  };
}

// ─── Query builder ─────────────────────────────────────────────────────────────

function buildQueries(searchName: string) {
  return [
    {
      name:  "Profile + Social",
      query: `${searchName}: full name, hometown, state, class year, position, conference, ` +
             `team roster bio, personal background, current and past teams (school, club, professional, national team)`,
    },
    {
      name:  "Commercial + Brand",
      query: `${searchName}: NIL deals, brand partnerships, sponsorships, endorsements, ` +
             `NIL valuation 2024-2026, On3 NIL valuation, Opendorse, Athlete's Thread, ` +
             `product collaborations, ambassador programs`,
    },
    {
      name:  "Performance + Press",
      query: `${searchName}: career achievements, All-American, All-conference, player of the year, ` +
             `season statistics, records, awards, academic honors, press coverage, ` +
             `ESPN, Sports Illustrated, The Athletic, local newspaper coverage`,
    },
    {
      name:  "Media Assets",
      query: `${searchName}: highlight videos YouTube, Getty Images action photos, ` +
             `podcast interviews, broadcast media, official athletics photos, ` +
             `game footage URLs, photo galleries, media day`,
    },
    {
      name:  "Social Handles",
      query: `${searchName} @username Instagram TikTok Twitter X handle ` +
             `site:instagram.com OR site:twitter.com OR site:tiktok.com OR site:x.com ` +
             `social media profile link`,
    },
  ] as const;
}

// ─── Gemini runner ─────────────────────────────────────────────────────────────

const ai = genai();

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function runGemini(query: string): Promise<GeminiRaw> {
  const response = await ai.models.generateContent({
    model:    GEMINI.flash,
    contents: [{ role: "user", parts: [{ text: query }] }],
    config: {
      systemInstruction: GEMINI_SYSTEM,
      tools:             [{ googleSearch: {} }],
      temperature:       1.0,
      maxOutputTokens:   16384,
      thinkingConfig:    { thinkingBudget: 256 } as any,
    },
  });

  const cand = response.candidates?.[0];
  const text = response.text ?? "";
  const gm   = (cand?.groundingMetadata ?? {}) as any;
  const groundingChunks: GroundingChunk[] = (gm.groundingChunks ?? []).map((c: any) => ({
    uri:    c.web?.uri   ?? "",
    title:  c.web?.title ?? "",
    domain: c.web?.domain ?? (() => { try { return new URL(c.web?.uri ?? "http://x").hostname; } catch { return ""; } })(),
  }));

  const groundingSupports: GroundingSupport[] = (gm.groundingSupports ?? []).map((sp: any) => ({
    segment: { startIndex: sp.segment?.startIndex, endIndex: sp.segment?.endIndex, text: sp.segment?.text },
    groundingChunkIndices: Array.isArray(sp.groundingChunkIndices) ? sp.groundingChunkIndices : [],
    confidenceScores: Array.isArray(sp.confidenceScores) ? sp.confidenceScores : [],
  }));

  const usage = (response as any).usageMetadata;
  return {
    text,
    groundingChunks,
    groundingSupports,
    webSearchQueries: gm.webSearchQueries ?? [],
    finishReason:     (cand as any)?.finishReason ?? "unknown",
    promptTokens:     usage?.promptTokenCount,
    candidateTokens:  usage?.candidatesTokenCount,
  };
}

async function runGeminiWithRetry(query: string, queryName: string): Promise<GeminiWithRetry> {
  const attempts: GeminiAttempt[] = [];
  let lastResult: GeminiRaw = { text: "", groundingChunks: [], webSearchQueries: [], finishReason: "unknown" };

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const nonce = attempt > 1 ? ` [retry-${attempt}-ts:${Date.now()}]` : "";
    try {
      const result = await runGemini(query + nonce);
      lastResult   = result;
      const empty  = result.text.trim().length === 0 || result.groundingChunks.length === 0;
      attempts.push({ attempt, textLength: result.text.length, chunkCount: result.groundingChunks.length, empty });
      if (!empty) return { result, attempts, retriesFired: attempt - 1, finallyEmpty: false };
      if (attempt < MAX_RETRY) {
        const delay = Math.pow(2, attempt - 1) * 1000 + Math.random() * 500;
        logger.warn({ queryName, attempt, finishReason: result.finishReason }, `Gemini empty — retrying in ${Math.round(delay)}ms`);
        await sleep(delay);
      }
    } catch (e: any) {
      attempts.push({ attempt, textLength: 0, chunkCount: 0, empty: true });
      if (attempt < MAX_RETRY) {
        const delay = Math.pow(2, attempt - 1) * 1000 + Math.random() * 500;
        logger.warn({ queryName, attempt, error: e.message }, `Gemini threw — retrying in ${Math.round(delay)}ms`);
        await sleep(delay);
      }
    }
  }

  return { result: lastResult, attempts, retriesFired: MAX_RETRY - 1, finallyEmpty: true };
}

// ─── Kimi extraction ───────────────────────────────────────────────────────────

const EMPTY_EXTRACTED: ExtractedData = {
  profile:                {},
  social_handles:         { instagram: null, tiktok: null, x: null, youtube: null },
  achievements:           [],
  press_mentions:         [],
  brand_deals:            [],
  nil_valuation_mentions: [],
  media_assets:           { images: [], videos: [], audio: [] },
  story_arc:              null,
  sentiment:              null,
};

function parseExtraction(raw: string): ExtractedData {
  // Strip markdown fences if model ignores json_object mode hint
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as ExtractedData;
  } catch (e: any) {
    logger.warn({ error: e.message, rawSlice: raw.slice(0, 200) }, "Kimi extraction JSON parse failed");
    return { ...EMPTY_EXTRACTED, _parseError: e.message };
  }
}

const KIMI_TIMEOUT_MS = 60_000;   // research extraction runs over a large prompt — longer than the deal-path default

async function extractFromText(
  queryName: string,
  text: string,
  enrichmentContext: string = "",
): Promise<{ data: ExtractedData; usage: { prompt_tokens: number; completion_tokens: number } }> {
  if (!text.trim()) {
    return { data: { ...EMPTY_EXTRACTED, _parseError: "empty Gemini text" }, usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }

  const enrichedText = enrichmentContext ? `${text}\n${enrichmentContext}` : text;

  const prompt =
    `Research query: "${queryName}"\n\n` +
    `Schema (fill what you can find, null/[] for the rest):\n${EXTRACTION_SCHEMA}\n\n` +
    `Research text:\n${enrichedText}`;

  try {
    const response = await kimiInstant(EXTRACTION_SYSTEM, prompt, true, KIMI_TIMEOUT_MS);   // timeout now lives inside kimiInstant
    const raw      = response.choices[0].message.content ?? "{}";
    return {
      data:  parseExtraction(raw),
      usage: { prompt_tokens: response.usage?.prompt_tokens ?? 0, completion_tokens: response.usage?.completion_tokens ?? 0 },
    };
  } catch (e: any) {
    logger.warn({ queryName, error: e.message }, "Kimi extraction call failed");
    return { data: { ...EMPTY_EXTRACTED, _parseError: e.message }, usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }
}

// ─── Merge ─────────────────────────────────────────────────────────────────────

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v) || 0;
  return 0;
}

function mergeExtractions(
  results: Array<{ queryName: string; data: ExtractedData }>,
): MergedResearch {
  // Profile: first non-null wins per field
  const profile: MergedResearch["profile"] = {};
  for (const { data } of results) {
    for (const [k, v] of Object.entries(data.profile ?? {})) {
      if (v && !(profile as any)[k]) (profile as any)[k] = v;
    }
  }

  // Handles: first non-null wins per platform
  const social_handles: MergedResearch["social_handles"] = { instagram: null, tiktok: null, x: null, youtube: null };
  for (const { data } of results) {
    for (const [k, v] of Object.entries(data.social_handles ?? {})) {
      if (v && !(social_handles as any)[k]) (social_handles as any)[k] = v;
    }
  }

  // Achievements: union, dedup by normalized (name + year) key
  const achieveMap = new Map<string, ExtractedData["achievements"][0]>();
  for (const { data } of results) {
    for (const a of (data.achievements ?? [])) {
      const key = `${(a.name ?? "").toLowerCase().replace(/\s+/g, " ").trim()}|${a.year ?? ""}`;
      if (!achieveMap.has(key)) achieveMap.set(key, a);
    }
  }

  // Teams: union, dedup by normalized org + kind (a later source may add the dates the first lacked)
  const teamMap = new Map<string, NonNullable<ExtractedData["teams"]>[0]>();
  for (const { data } of results) {
    for (const t of (data.teams ?? [])) {
      if (!t?.org) continue;
      const key = `${String(t.org).toLowerCase().replace(/\s+/g, " ").trim()}|${(t.kind ?? "").toLowerCase()}`;
      const prev = teamMap.get(key);
      teamMap.set(key, prev ? { ...t, ...Object.fromEntries(Object.entries(prev).filter(([, v]) => v != null)) } : t);
    }
  }

  // Press: union, dedup by normalized headline
  const pressMap = new Map<string, ExtractedData["press_mentions"][0]>();
  for (const { data } of results) {
    for (const p of (data.press_mentions ?? [])) {
      const key = (p.headline ?? "").toLowerCase().trim();
      if (key && !pressMap.has(key)) pressMap.set(key, p);
    }
  }

  // Brands: union, dedup by brand name (keep highest confidence)
  const brandMap = new Map<string, ExtractedData["brand_deals"][0]>();
  for (const { data } of results) {
    for (const b of (data.brand_deals ?? [])) {
      const key = (b.brand ?? "").toLowerCase().trim();
      if (!key) continue;
      const existing = brandMap.get(key);
      if (!existing || toNum(b.confidence) > toNum(existing.confidence)) {
        brandMap.set(key, b);
      }
    }
  }

  // NIL valuations: concat all (no dedup)
  const nil_valuation_mentions = results.flatMap(r => r.data.nil_valuation_mentions ?? []);

  // Media: union by URL
  const imageUrls = new Set<string>();
  const videoUrls = new Set<string>();
  const audioUrls = new Set<string>();
  const images: unknown[] = [];
  const videos: unknown[] = [];
  const audio:  unknown[] = [];
  for (const { data } of results) {
    for (const img of (data.media_assets?.images ?? []) as Array<{ url?: string }>) {
      if (img.url && !imageUrls.has(img.url)) { imageUrls.add(img.url); images.push(img); }
    }
    for (const vid of (data.media_assets?.videos ?? []) as Array<{ url?: string }>) {
      if (vid.url && !videoUrls.has(vid.url)) { videoUrls.add(vid.url); videos.push(vid); }
    }
    for (const aud of (data.media_assets?.audio ?? []) as Array<{ url?: string }>) {
      if (aud.url && !audioUrls.has(aud.url)) { audioUrls.add(aud.url); audio.push(aud); }
    }
  }

  // Story arc: prefer Performance+Press (index 2), fallback to first non-null
  const storyArcResult = results[2]?.data.story_arc
    ?? results.find(r => r.data.story_arc)?.data.story_arc
    ?? null;

  // Sentiment: from Performance+Press (index 2), fallback to first non-null
  const sentimentSrc = results[2]?.data.sentiment ?? results.find(r => r.data.sentiment)?.data.sentiment;
  const sentiment = sentimentSrc
    ? { positive: Math.round(toNum(sentimentSrc.positive)), negative: Math.round(toNum(sentimentSrc.negative)) }
    : null;

  return {
    profile,
    social_handles,
    achievements:           Array.from(achieveMap.values()),
    teams:                  Array.from(teamMap.values()),
    press_mentions:         Array.from(pressMap.values()),
    brand_deals:            Array.from(brandMap.values()),
    nil_valuation_mentions,
    media_assets:           { images, videos, audio },
    story_arc:              storyArcResult,
    sentiment,
  };
}

// ─── DB helpers ────────────────────────────────────────────────────────────────


// ─── Main ──────────────────────────────────────────────────────────────────────

type ResearchTrigger = "signup" | "manual" | "re_enrich" | "scheduled_refresh";

/** Handles we KNOW — typed at signup or proven by a connection. They win over anything the
 *  model extracts, so platform discovery never runs against a guessed handle when a real one
 *  exists. Keys match the extraction schema's social_handles. */
export type KnownHandles = Partial<Record<"instagram" | "tiktok" | "x" | "youtube", string>>;

export interface ResearchOptions {
  handles?: KnownHandles;
  /** Phase A Step 2d-5 (#36): the team platform discovery is told about. Listed callers pass the ledger's primary
   *  current team (or null); when absent the legacy default (the projection column) applies, byte for byte. */
  team?: string | null;
}

/** The one search-name builder. Used to be copied in three places with the same logic. */
export function buildSearchName(a: { full_name: string; school?: string | null; sport?: string | null }): string {
  return (a.school ? `${a.full_name} ${a.school} ${a.sport ?? ""}` : `${a.full_name} ${a.sport ?? ""}`).trim();
}

export async function researchAthlete(
  athleteId: string,
  searchName: string,
  trigger: ResearchTrigger = "manual",
  options: ResearchOptions = {},
): Promise<ResearchAthleteResult> {
  const t0 = Date.now();
  logger.info({ athleteId, searchName, trigger, knownHandles: Object.keys(options.handles ?? {}) }, "researchAthlete start");

  // 1. Load athlete
  const [athleteRow] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!athleteRow) throw new Error(`Athlete not found: ${athleteId}`);

  // 3. Run Gemini searches + Trends + GDELT all in parallel
  const queries = buildQueries(searchName);
  logger.info({ queriesCount: queries.length }, "Running Gemini + Trends + GDELT in parallel");

  const [geminiResults, trendsResult, gdeltResult] = await Promise.all([
    Promise.all(queries.map(q => runGeminiWithRetry(q.query, q.name))),
    fetchGoogleTrends(athleteRow.full_name, athleteRow.sport),
    fetchGdelt(athleteRow.full_name),
  ]);

  const groundingChunksTotal = geminiResults.reduce((sum, r) => sum + r.result.groundingChunks.length, 0);
  const totalRetriesFired    = geminiResults.reduce((sum, r) => sum + r.retriesFired, 0);
  const queriesSucceeded     = geminiResults.filter(r => !r.finallyEmpty).length;
  const geminiPromptTokens   = geminiResults.reduce((sum, r) => sum + (r.result.promptTokens   ?? 0), 0);
  const geminiCandidTokens   = geminiResults.reduce((sum, r) => sum + (r.result.candidateTokens ?? 0), 0);

  logger.info({
    groundingChunksTotal,
    queriesSucceeded,
    totalRetriesFired,
    trendsScore:   trendsResult.interestScore,
    gdeltArticles: gdeltResult.articleCount,
  }, "Gemini + enrichment complete");

  // 4. Build enrichment context from Trends + GDELT to append to each Kimi prompt
  const enrichmentParts: string[] = [];
  if (trendsResult.interestScore > 0) {
    const related = trendsResult.relatedQueries.length > 0
      ? ` Related queries: ${trendsResult.relatedQueries.join(", ")}.`
      : "";
    enrichmentParts.push(
      `\n\nGoogle Trends Data: Search interest score ${trendsResult.interestScore}/100 (30-day average).${related}`,
    );
  }
  if (gdeltResult.articleCount > 0) {
    const articleSnippets = gdeltResult.recentArticles
      .map(a => `${a.source}: "${a.title}"`)
      .join("; ");
    enrichmentParts.push(
      `\n\nGDELT Media Coverage (last 30 days): ${gdeltResult.articleCount} articles found. ` +
      `Average sentiment tone: ${gdeltResult.avgTone}. ` +
      `Sources: ${articleSnippets}.`,
    );
  }
  const enrichmentContext = enrichmentParts.join("\n");

  // 5. Run Kimi extractions in parallel (enrichment context appended to each query's text)
  logger.info("Running Kimi extractions");
  const extractionResults = await Promise.all(
    queries.map((q, i) => extractFromText(q.name, geminiResults[i].result.text, enrichmentContext)),
  );

  const promptTokens     = extractionResults.reduce((sum, r) => sum + r.usage.prompt_tokens,     0);
  const completionTokens = extractionResults.reduce((sum, r) => sum + r.usage.completion_tokens, 0);

  // 6. Merge extractions
  const freshResearch = mergeExtractions(
    queries.map((q, i) => ({ queryName: q.name, data: extractionResults[i].data })),
  );
  // Research never forgets: extraction is nondeterministic (nine achievements one run, six the
  // next). Per list, the richest single run among the last few snapshots and this one wins —
  // bounded by one extraction's output, so it cannot stack near-duplicates across runs either.
  // Scalars (story arc, profile fields) prefer the fresh value. See researchMerge.ts.
  const priorResearchRows = await db.select({ research: athleteSnapshots.research })
    .from(athleteSnapshots)
    .where(and(eq(athleteSnapshots.athlete_id, athleteId), sql`${athleteSnapshots.research} IS NOT NULL`))
    .orderBy(desc(athleteSnapshots.created_at)).limit(PRIOR_RESEARCH_DEPTH);
  const priorResearch = priorResearchRows.map((r) => r.research as any).reverse()
    .reduce<any>((acc, r) => unionResearch(acc, { ...r, brand_deals: r.brand_mentions ?? r.brand_deals ?? [] }), null);
  const merged = unionResearch(priorResearch, freshResearch);

  // 2.5. Platform Discovery — pull public social data using app API keys (no athlete auth)
  //      Runs after handles are extracted so we know what to look up.
  //      Instagram requires IG_PAGE_ACCESS_TOKEN + IG_BUSINESS_ACCOUNT_ID in Secret Manager.
  //      YouTube requires YOUTUBE_DATA_API_KEY (already present).
  //      Known handles (typed at signup, or connected) override extracted ones: a real handle
  //      beats a guessed one, and the guess used to win silently here.
  for (const [platform, handle] of Object.entries(options.handles ?? {})) {
    if (handle) (merged.social_handles as Record<string, string | null>)[platform] = handle;
  }
  const discoveryResult = await runPlatformDiscovery(merged.social_handles).catch((err: any) => {
    logger.warn({ error: err.message }, "Platform discovery failed — scoring continues without social data");
    return null;
  });

  if (discoveryResult) {
    logger.info({
      youtube:   discoveryResult.youtube
        ? { subscribers: discoveryResult.youtube.subscribers, engRate: discoveryResult.youtube.engagement_rate }
        : null,
      instagram: discoveryResult.instagram
        ? { followers: discoveryResult.instagram.followers, engRate: discoveryResult.instagram.engagement_rate }
        : null,
      totalFollowers: discoveryResult._computed?.total_followers,
      dataTier:       discoveryResult._computed?.data_tier,
    }, "Platform discovery complete");
  }

  // 7. Build research JSONB (scoring fields + extra fields for profile enrichment)
  const researchJsonb = {
    achievements:           merged.achievements,
    press_mentions:         merged.press_mentions,
    brand_mentions:         merged.brand_deals.map(b => ({
      brand:      b.brand,
      type:       b.type ?? null,
      confidence: typeof b.confidence === "string" ? parseFloat(b.confidence) || 0 : (b.confidence ?? 0),
    })),
    story_arc:              merged.story_arc,
    teams:                  merged.teams,
    sentiment:              merged.sentiment ?? undefined,
    // Extra: stored for profile enrichment, not read by scoring engine
    social_handles:         merged.social_handles,
    profile:                merged.profile,
    nil_valuation_mentions: merged.nil_valuation_mentions,
    media_assets:           merged.media_assets,
  };

  // Social: the athlete's CONNECTED analytics win (best row per platform, fresh within 45 days,
  // the same builder the nightly refresh uses); public discovery only fills platforms they have
  // not connected. An athlete with nothing connected is still scored from discovery.
  // This is what stopped research from re-scoring a connected athlete off weaker public data.
  const analyticsRows = await db.select().from(socialAnalyticsSnapshots)
    .where(eq(socialAnalyticsSnapshots.athlete_id, athleteId))
    .orderBy(desc(socialAnalyticsSnapshots.snapshot_day));
  const connectedSocial = analyticsRows.length ? buildSocialFromAnalytics(analyticsRows) : null;
  const socialJsonb = mergeSocialSources(connectedSocial, discoveryResult);
  if (connectedSocial) {
    logger.info({ athleteId, connectedPlatforms: Object.keys(connectedSocial).filter((k) => k !== "_computed"), dataTier: socialJsonb?._computed?.data_tier }, "Research snapshot with connected social; discovery fills gaps only");
  }

  // 7. Deals behind the snapshot (the same read the snapshot has always persisted).
  const snapshotDeals = await snapshotDealsFor(athleteId);

  // 9. Insert the snapshot — no score (legacy retirement P2-4)
  const sources = {
    apis_called: [
      "gemini_grounding", "kimi_instant", "google_trends", "gdelt",
      ...(discoveryResult?.youtube   ? ["youtube_data_api"]           : []),
      ...(discoveryResult?.instagram ? ["instagram_business_discovery"] : []),
    ],
    kimi_usage:    { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_cost_usd: 0 },
    gemini_usage:  { prompt_tokens: geminiPromptTokens, candidate_tokens: geminiCandidTokens },
    gemini_stats:  { grounding_chunks: groundingChunksTotal, queries_succeeded: queriesSucceeded, retries_fired: totalRetriesFired },
    enrichment:    { trends_score: trendsResult.interestScore, gdelt_articles: gdeltResult.articleCount, gdelt_avg_tone: gdeltResult.avgTone },
    search_name:   searchName,
  };

  // Phase A Step 2d-6 (D1, §4.3 runtime rule): a TRUE research run dates its snapshot — as_of = created_at.
  const researchedAt = new Date();
  const [insertedSnap] = await db.insert(athleteSnapshots).values({
    athlete_id:          athleteId,
    trigger,
    created_at:          researchedAt,
    as_of:               researchedAt,
    research:            researchJsonb,
    google_trends_score: String(trendsResult.interestScore),
    gdelt_article_count: gdeltResult.articleCount,
    social:              socialJsonb,
    deals:               snapshotDeals,
    sources,
  }).returning({ id: athleteSnapshots.id });

  const snapshotId = insertedSnap.id;

  // Teams research found become FOUND affiliation rows (never primary, never the projection):
  // the athlete's word turns them into hers. Structured extraction first; national/Olympic
  // programmes named in achievements as the fallback. Never blocks the run.
  try {
    const found = merged.teams.length ? merged.teams : teamsFromAchievements(merged.achievements);
    const added = await proposeFoundAffiliations({ athleteId, teams: found.map((t) => ({
      org: String(t.org), kind: (t.kind ?? "school") as FoundTeamInput["kind"], level: t.level ?? null, role: t.role ?? null,
      from: t.from ?? null, to: t.to ?? null, position: null, conference: null,
    })), source: "research" });
    if (added.length) logger.info({ athleteId, teams: added.map((a) => a.org) }, "research: found teams proposed");
  } catch (err: any) {
    logger.warn({ athleteId, error: err.message }, "research: found teams skipped");
  }

  // 10. athletes_current: the story arc + research timestamp only (legacy retirement P2-4). No score, tier, capitals,
  //     rate card, follower copies or research counts — readers take those from the ledger, the social substrate and
  //     the research itself.
  await writeAthletesCurrent({ athleteId, research: { storyArc: merged.story_arc } });

  // 11. Update athlete status + enrich any null profile fields
  const athleteUpdate: Record<string, unknown> = {
    enriched_at: new Date(),
  };
  if (athleteRow.status === "raw") athleteUpdate.status = "enriched";
  if (!athleteRow.sport      && merged.profile.sport)      athleteUpdate.sport      = merged.profile.sport;
  // Phase A Step 2d-6 (§4.4, D11): research never writes school / conference / division — those columns are the
  // projection of the ledger's primary current row (projectPrimary). Research proposes teams as found ledger rows above.

  await db.update(athletes)
    .set(athleteUpdate as any)
    .where(eq(athletes.id, athleteId));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  logger.info({
    athleteId,
    snapshotId,
    achievements: merged.achievements.length,
    press:        merged.press_mentions.length,
    elapsed:      `${elapsed}s`,
  }, "researchAthlete complete");

  return {
    snapshotId,
    athleteId,
    extracted: {
      achievements:  merged.achievements.length,
      press:         merged.press_mentions.length,
      brands:        merged.brand_deals.length,
      handles:       merged.social_handles as Record<string, string | null>,
      images:        (merged.media_assets.images as unknown[]).length,
      videos:        (merged.media_assets.videos as unknown[]).length,
    },
    reliability: {
      queriesSucceeded,
      queriesTotal:      queries.length,
      totalRetriesFired,
      groundingChunksTotal,
    },
    kimiUsage: {
      promptTokens,
      completionTokens,
    },
    enrichment: {
      trendsScore:   trendsResult.interestScore,
      gdeltArticles: gdeltResult.articleCount,
    },
  };
}
