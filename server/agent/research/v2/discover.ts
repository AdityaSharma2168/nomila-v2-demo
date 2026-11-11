/**
 * agent/research/v2/discover.ts — the DISCOVER step: each planned query → a short list of result pages (URL, title,
 * snippet), de-duplicated and ordered by how authoritative the site usually is. The pages are read later by our own
 * fetcher (fetchClean.ts); discovery never hands page text to the extract model.
 *
 * Provider: openai_search — OpenAI's web_search on the fast tier, one call per planned query at low context, asked
 * only for result links. The one search provider (owner, 4 Nov 2026); the Gemini Google Search grounding arm
 * (geminiDiscover, its redirect resolver and RESEARCH_V2_DISCOVER) was removed then. OpenAI's terms ask that any
 * screen showing web results shows their sources as clickable links; the shadow shows nothing to the athlete.
 */
import { modelFor, webSearchCallMicroUsd } from "../../models";
import { callStructured } from "../llm";
import { isPlatformCapError, PlatformCapError } from "../../../lib/platformSpend";
import { V2, type DiscoverProviderId } from "./config";
import type { PlannedQuery } from "./plan";

export interface FoundPage {
  url: string;
  title: string;
  snippet: string;
  /** The planned query (aim) that found it first. */
  aim: PlannedQuery["aim"];
  /** 0–3: how authoritative the site usually is (official > major outlet > encyclopedia > other). */
  quality: number;
}

export interface DiscoverResult {
  pages: FoundPage[];
  queries: number;
  /** Web searches the provider actually ran; each is billed. */
  searchQueries: number;
  /** The part of costMicroUsd that is per-search fees (OpenAI web_search calls), at list price. */
  searchFeeMicroUsd: number;
  costMicroUsd: number;
  provider: DiscoverProviderId;
  errors: string[];
}

/** One query → raw results. Injectable so tests never reach a provider. costMicroUsd includes any per-search fee;
 *  searchQueries / searchFeeMicroUsd say how much of it was search fees. */
export type DiscoverQuery = (q: string) => Promise<{ results: Array<{ url: string; title?: string; snippet?: string }>; costMicroUsd: number; searchQueries?: number; searchFeeMicroUsd?: number }>;

const OPENAI_DISCOVER_SKILL = {
  id: "research/v2-discover",
  version: "1.0.0",
  // Prompt Register: research/v2 discover (OpenAI baseline).
  instructions: "Search the web for the query about this specific athlete and return only the result pages you found, " +
    "most authoritative first (official team, school, league and governing-body pages, then major outlets). " +
    "Do not answer the question; list pages.",
};
const LINKS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["pages"],
  properties: { pages: { type: "array", items: { type: "object", additionalProperties: false, required: ["url", "title"], properties: { url: { type: "string" }, title: { type: "string" } } } } },
} as const;

export const openaiDiscover = (): DiscoverQuery => async (q) => {
  const r = await callStructured({
    skill: OPENAI_DISCOVER_SKILL, model: modelFor({ id: OPENAI_DISCOVER_SKILL.id, model: "fast", effort: "low", tools: ["web_search"] }), input: q, schemaName: "found_pages", schema: LINKS_SCHEMA as any,
    webSearch: { maxCalls: 1, contextSize: "low" }, maxOutputTokens: 1_200,
  });
  const listed = Array.isArray((r.json as any)?.pages) ? (r.json as any).pages : [];
  // Only pages the search actually returned count (a listed URL it never saw is dropped).
  const seen = new Set(r.sources.map((s: { url: string; title?: string }) => s.url));
  const results = [...r.sources.map((s: { url: string; title?: string }) => ({ url: s.url, title: s.title ?? "" })), ...listed.filter((p: any) => seen.has(p.url))];
  // OpenAI's web_search call fee is already inside r.cost (agent/models.ts webSearchCallMicroUsd).
  const calls = Number((r.cost as any).webSearchCalls ?? 0);
  return { results, costMicroUsd: r.cost.microUsd, searchQueries: calls, searchFeeMicroUsd: calls * webSearchCallMicroUsd() };
};

// Generic signals only — no named league, team, school or outlet is hard-coded (no-hardcoding rule; the extract step
// classifies each source's type from the page itself). School and government sites, then the open encyclopedias.
const INSTITUTIONAL = /^https?:\/\/[^/]*\.(edu|gov|ac\.[a-z]{2})(\/|$)/i;
const ENCYCLOPEDIA = /^https?:\/\/[^/]*\b(wikipedia|wikidata)\.org\//i;
const DROP = /\.(pdf|jpg|jpeg|png|gif|webp|mp4|mp3|zip)(\?|$)|\b(facebook|instagram|tiktok|x|twitter|linkedin|pinterest)\.com\//i;

/**
 * The platform day cap refused at least one search of a discover call. A PlatformCapError (so the runner holds a
 * sign-up research step), carrying what the queries that did run spent, so the caller can still record that spend.
 */
export class DiscoverCapRefusal extends PlatformCapError {
  constructor(cause: unknown, readonly spent: { costMicroUsd: number; searchQueries: number; searchFeeMicroUsd: number }) {
    super((cause as any)?.spentMicroUsd ?? 0, (cause as any)?.capMicroUsd ?? 0);
    this.name = "PlatformCapError";
  }
}

export function qualityOf(url: string): number {
  if (INSTITUTIONAL.test(url)) return 3;
  if (ENCYCLOPEDIA.test(url)) return 2;
  return 1;
}

const canonical = (u: string) => { try { const x = new URL(u); x.hash = ""; x.search = ""; return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}`.toLowerCase(); } catch { return u.toLowerCase(); } };

/**
 * Every planned query, in parallel; results de-duplicated by page, social-network and file links dropped (social
 * numbers come from the athlete's connected accounts, never scraped), ordered by site quality then by the order found.
 */
export async function discover(queries: PlannedQuery[], run: DiscoverQuery, provider: DiscoverProviderId): Promise<DiscoverResult> {
  const errors: string[] = [];
  let cost = 0, searchQueries = 0, searchFee = 0;
  let capRefusal: unknown = null;
  const settled = await Promise.all(queries.map(async (pq) => {
    try { const r = await run(pq.q); cost += r.costMicroUsd; searchQueries += r.searchQueries ?? 0; searchFee += r.searchFeeMicroUsd ?? 0; return { pq, results: r.results }; }
    catch (err: any) {
      // The platform day cap's refusal is not a failed query: the caller must see it (a sign-up research step is then
      // HELD and runs again later), never a search that "found nothing" (which would write a disputed #identity fact).
      if (isPlatformCapError(err)) capRefusal = err;
      errors.push(`${pq.aim}: ${String(err?.message ?? err).slice(0, 160)}`); return { pq, results: [] };
    }
  }));
  if (capRefusal) throw new DiscoverCapRefusal(capRefusal, { costMicroUsd: cost, searchQueries, searchFeeMicroUsd: searchFee });
  const seen = new Set<string>();
  const pages: FoundPage[] = [];
  for (const { pq, results } of settled) {
    for (const r of results.slice(0, V2.resultsPerQuery)) {
      if (!/^https?:\/\//.test(r.url) || DROP.test(r.url)) continue;
      const key = canonical(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      pages.push({ url: r.url, title: r.title ?? "", snippet: r.snippet ?? "", aim: pq.aim, quality: qualityOf(r.url) });
    }
  }
  pages.sort((a, b) => b.quality - a.quality);
  return { pages, queries: queries.length, searchQueries, searchFeeMicroUsd: searchFee, costMicroUsd: cost, provider, errors };
}
