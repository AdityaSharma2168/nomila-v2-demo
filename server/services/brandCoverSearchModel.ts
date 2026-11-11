/**
 * brandCoverSearchModel.ts — the one model call behind lib/brandImage fetchBrandImagesViaSearch: skill brand/cover-search
 * (listed in the Prompt Register) through the agent's structured call, with ONE native web search (OpenAI, by the
 * provider rule; this replaced a third-party search API in Nov 2026). The model only proposes pages; only pages the
 * search itself returned are kept, and lib/brandImage reads them, checks every image and ranks them with the same vision
 * pass as a scraped cover. Brand knowledge, not athlete: not athlete-scoped, so it calls callStructured directly like
 * brandSiteSearchModel.ts (no agent_runs row: that ledger is per athlete); its cost is logged on every call. No athlete's
 * day cap covers it, so it has a global daily cap of its own (brandCoverSearchDailyCap).
 */
import { loadJob } from "../agent/jobs";
import { modelFor } from "../agent/models";
import { callStructured, normalizeUrl } from "../agent/research/llm";
import { take } from "../lib/publicRateCounters";
import { createLogger } from "../logger";

const logger = createLogger("brand-cover-search");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pages"],
  properties: { pages: { type: "array", items: { type: "string" } } },
};

/**
 * The global daily cap on brand cover searches (BRAND_COVER_SEARCH_DAILY_CAP, default 100, owner-confirmed 5 Nov 2026;
 * clamped to 1–1,000), the same rule as BRAND_RESEARCH_DAILY_CAP (skills/researchBrand.ts). Brand knowledge, not athlete: no athlete's day cap covers it.
 * One search is ONE web_search call plus a few hundred tokens. No row records a cover search, so the count is the
 * fleet-wide day counter (lib/publicRateCounters take, UTC day windows): every attempt counts one. Fail closed: a count
 * that cannot be read runs no search. Over the cap the search returns no pages, so the brand keeps its gradient and is
 * tried again on a later research.
 */
export function brandCoverSearchDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Math.floor(Number(env.BRAND_COVER_SEARCH_DAILY_CAP));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000) : 100;
}

/** At most this many pages are read for candidate images. */
export const MAX_COVER_PAGES = 5;

/** Social profiles and link pages: never a cover source (the skill says so; code holds it too). */
const SOCIAL_HOST = /(^|\.)(instagram\.com|tiktok\.com|facebook\.com|fb\.com|x\.com|twitter\.com|linkedin\.com|pinterest\.[a-z.]+|threads\.net|youtube\.com|linktr\.ee|beacons\.ai)$/i;

function isSocial(url: string): boolean {
  try { return SOCIAL_HOST.test(new URL(url).hostname); } catch { return true; }
}

/** Pages that show the brand's products or campaigns, best first: ONLY the pages the model chose that the search also
 *  saw (as the search's own clean URL, tracking params removed), never a social profile. The search's other sources are
 *  NOT a fallback: an empty list is the skill saying nothing clearly belongs to this brand (a similar-named company). */
export async function searchBrandCoverPages(brandName: string, now: Date = new Date()): Promise<string[]> {
  const cap = brandCoverSearchDailyCap();
  const within = await take(["brand_cover_search"], cap, "day", now).catch(() => false);
  if (!within) {
    logger.warn({ brandName, cap }, "Brand cover search skipped — the daily cap is reached or its count could not be read");
    return [];
  }
  const skill = loadJob("brand/cover-search");
  const model = modelFor(skill);
  const res = await callStructured({
    skill, model, input: JSON.stringify({ brand_name: brandName }),
    schemaName: "brand_cover_pages", schema: SCHEMA, webSearch: { maxCalls: 1, contextSize: "low" }, maxOutputTokens: 600,
  });
  logger.info({ costMicroUsd: res.cost.microUsd, searches: res.cost.webSearchCalls, sources: res.sources.length }, "brand cover search");
  const seen = new Map(res.sources.map((s) => [normalizeUrl(s.url), s.url] as const));
  const listed = Array.isArray((res.json as any)?.pages) ? ((res.json as any).pages as unknown[]) : [];
  const out: string[] = [];
  for (const u of listed) {
    const clean = typeof u === "string" ? seen.get(normalizeUrl(u)) : undefined;
    if (!clean || !/^https:\/\//i.test(clean) || isSocial(clean)) continue;
    if (out.some((x) => normalizeUrl(x) === normalizeUrl(clean))) continue;
    out.push(clean);
  }
  return out.slice(0, MAX_COVER_PAGES);
}
