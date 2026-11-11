/**
 * researchBrand.ts — Async brand enrichment pipeline.
 *
 * OpenAI web search (4 parallel searches on the fast tier at low context: the one search
 * provider, owner 4 Nov 2026) → Kimi extraction → upsert enriched data to inbox_brands.
 * The search goes through the same structured call and cost path as research v2 discover
 * (agent/research/llm callStructured: web_search calls capped per search, priced by
 * agent/models costOf including the per-call search fee). The pages each search saw are
 * kept on enrichment.sources, so every screen that shows the profile can link them (OpenAI's
 * terms: information from web results is shown with clickable citations).
 *
 * Called fire-and-forget from dealDetector when a brand is first detected.
 * Re-enrichment is skipped if enriched_at is less than 90 days old.
 */

import { kimiInstant } from "../lib/kimi";
import { modelFor } from "../agent/models";
import { callStructured, ModelCallError } from "../agent/research/llm";
import { db } from "../db";
import { brandFitNarratives, inboxBrands } from "../../shared/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { createLogger } from "../logger";
import { fetchBrandImages, fetchBrandImagesViaSearch, candidateDomains } from "../lib/brandImage";
import { brandIdentityGateEnabled, carriedEnrichment, decideIdentity, hostOf, onDomain, type BrandIdentity } from "../lib/brandIdentity";
import { brandDomainOf } from "../lib/senderProfile";

const logger = createLogger("skills/researchBrand");

/** Prompt Register: brand research search (OpenAI web search). */
export const BRAND_SEARCH_SYSTEM =
  "You are a brand research analyst building a concise company profile. " +
  "Always search the web for current, accurate information — do not answer from memory. " +
  "Focus on: what the company makes/sells, their target audience, sport/athlete marketing history, and company scale. " +
  "Put your findings, in plain prose, in the answer field.";

const BRAND_SEARCH_SKILL = { id: "brand/research-search", version: "2.0.0", instructions: BRAND_SEARCH_SYSTEM };
const ANSWER_SCHEMA = {
  type: "object", additionalProperties: false, required: ["answer"],
  properties: { answer: { type: "string" } },
} as const;
/** Web searches one research search may run. The profile's four searches are broad; the official-site one runs 1. */
export const BRAND_SEARCH_MAX_CALLS = 2;
/** Sources kept on enrichment.sources (all four searches together). */
export const MAX_BRAND_SOURCES = 10;

/**
 * The global daily cap on brand research (BRAND_RESEARCH_DAILY_CAP, default 100, clamped to 1–1,000). Brand research is
 * per brand, not per athlete, so no athlete's day cap covers it. One research is at most 8 web_search calls plus tokens
 * (about $0.10), so the default bounds the day near $10. Counted from inbox_brands: every row researched since UTC
 * midnight whose run searched (a no-domain verdict runs no search and is not counted). Over the cap the research is
 * skipped and nothing is written, so the brand is researched on a later read.
 */
export function brandResearchDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Math.floor(Number(env.BRAND_RESEARCH_DAILY_CAP));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000) : 100;
}

/** Brand researches that searched since UTC midnight. */
export async function brandResearchesToday(now: Date = new Date()): Promise<number> {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inboxBrands)
    .where(and(
      gte(inboxBrands.enriched_at, midnight),
      sql`coalesce(${inboxBrands.enrichment}->'identity'->>'basis', '') <> 'no_domain_evidence'`,
    ));
  return Number(r?.n ?? 0);
}

const KIMI_SYSTEM =
  "You are a brand data extraction engine. Extract structured data from brand research text. " +
  "Return ONLY valid JSON matching the schema exactly — no markdown, no explanation. " +
  "Use null for missing string fields, [] for missing arrays. Never invent data.";

const EXTRACTION_SCHEMA = `{
  "industry": "<short category tag, max 2 words, e.g. 'Sportswear', 'Sports Tech', 'Nutrition' or null>",
  "description": "<2-3 sentence brand description or null>",
  "brand_tier": "<emerging|mid|established|premium or null>",
  "audience_summary": "<who their primary audience is or null>",
  "sport_categories": ["<sport name>"],
  "known_athlete_partnerships": ["<athlete name>"],
  "brand_safety": "<any controversies or red flags found, or null>",
  "content_style": "<visual aesthetic in 1-3 words, e.g. 'clean minimal', 'bold streetwear', 'luxe', 'playful' or null>",
  "recent_campaigns": ["<a current or recent campaign / product launch / activation they are running now>"],
  "competitors": ["<name of a directly-competing brand (for conflict filtering)>"],
  "brand_values": "<their brand values / voice / tone in a short phrase, or null>",
  "product_categories": ["<a product category they sell, e.g. 'running shoes', 'protein powder'>"],
  "partnership_style": "<ambassador|one-off|affiliate|mixed or null — how they typically work with creators/athletes>",
  "markets": ["<geo / market they focus on, e.g. 'US', 'EU', 'global'>"]
}`;

/**
 * One web search: the answer text, the hosts of the pages the search saw, those pages (url + title) and its cost.
 * `hosts` come from the source URLs only, never a page title, so a page cannot claim a domain it is not hosted on.
 */
export interface BrandSearchResult {
  text: string;
  hosts: string[];
  sources: Array<{ url: string; title?: string }>;
  /** What the call cost (tokens + web search fees, agent/models costOf); 0 when it failed before any usage. */
  costMicroUsd: number;
}

async function runWebSearch(query: string, maxCalls = BRAND_SEARCH_MAX_CALLS): Promise<BrandSearchResult> {
  try {
    const r = await callStructured({
      skill: BRAND_SEARCH_SKILL,
      model: modelFor({ id: BRAND_SEARCH_SKILL.id, model: "fast", effort: "low", tools: ["web_search"] }),
      input: query, schemaName: "brand_research", schema: ANSWER_SCHEMA as any,
      webSearch: { maxCalls, contextSize: "low" }, maxOutputTokens: 2_000,
    });
    const answer = (r.json as { answer?: unknown } | null)?.answer;
    const hosts = r.sources.map((s) => hostOf(null, s.url)).filter((h): h is string => !!h);
    return { text: typeof answer === "string" ? answer : "", hosts, sources: r.sources, costMicroUsd: r.cost.microUsd };
  } catch (err: any) {
    const partial = err instanceof ModelCallError ? err.partial : undefined;
    logger.warn({ query: query.slice(0, 60), err: err?.message }, "brand web search failed");
    return { text: "", hosts: [], sources: [], costMicroUsd: partial?.cost?.microUsd ?? 0 };
  }
}

/** The pages the searches saw, de-duplicated by URL and capped: what the profile's source links show. */
export function brandSourcesOf(results: BrandSearchResult[]): Array<{ url: string; title: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; title: string | null }> = [];
  for (const s of results.flatMap((r) => r.sources)) {
    if (!/^https?:\/\//.test(s.url) || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ url: s.url.slice(0, 500), title: s.title?.trim() ? s.title.trim().slice(0, 160) : null });
    if (out.length >= MAX_BRAND_SOURCES) break;
  }
  return out;
}

/** The four research searches — the same queries whether the result is stored or only checked (backfill). */
export async function searchBrand(brandName: string, domain: string): Promise<BrandSearchResult[]> {
  const searchName = brandName || domain;
  return Promise.all([
    runWebSearch(`${searchName} company brand overview industry products founded`),
    runWebSearch(`${searchName} athlete sponsorships partnerships sport marketing campaigns`),
    runWebSearch(`${searchName} ${domain} company size funding valuation tier market position`),
    runWebSearch(`${searchName} brand aesthetic visual style values voice recent 2025 2026 campaigns competitors target markets`),
  ]);
}

/** Hosts that are never a brand's own site, whatever page names the brand. */
const NOT_A_BRAND_SITE = /(^|\.)(instagram\.com|tiktok\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|facebook\.com|linkedin\.com|linktr\.ee|threads\.net|wikipedia\.org|amazon\.[a-z.]+|crunchbase\.com|bloomberg\.com|zoominfo\.com|pitchbook\.com)$/i;

/**
 * A CANDIDATE domain for a brand known only by name — a proposal for the athlete to confirm ("Confirm this is
 * [brand]"), never evidence by itself. One web search; the domain the answer names counts only when the search saw
 * a page hosted on that very domain (a source URL on it), so the model cannot supply one from memory.
 */
export async function searchOfficialSite(brandName: string): Promise<{ domain: string | null; hosts: string[] }> {
  const name = brandName.trim();
  if (!name) return { domain: null, hosts: [] };
  const r = await runWebSearch(`What is the official website of the brand or company "${name}"? Reply with its domain only, for example example.com.`, 1);
  for (const m of r.text.toLowerCase().matchAll(/(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?![a-z0-9-])/g)) {
    const d = brandDomainOf(m[1]);
    if (!d || NOT_A_BRAND_SITE.test(d)) continue;
    if (r.hosts.some((h) => onDomain(h, d))) return { domain: d, hosts: r.hosts };
  }
  return { domain: null, hosts: r.hosts };
}

/**
 * BRAND_IDENTITY_GATE, unconfirmed: store the verdict and NOTHING from the research. Profile columns a
 * previous (unchecked) run may have written are cleared — description, tier, audience, sports, partners,
 * research imagery, and the category only when it came from research (enrichment.industry). The logo and
 * the brand's name/domain are identity, not research, and stay. The run's logs remain; the wrong profile
 * is not persisted anywhere, including enrichment (some readers dump it whole).
 */
export async function storeUnconfirmed(brandId: number, identity: BrandIdentity): Promise<void> {
  const [row] = await db
    .select({ category: inboxBrands.category, enrichment: inboxBrands.enrichment, image_url: inboxBrands.image_url })
    .from(inboxBrands)
    .where(eq(inboxBrands.id, brandId))
    .limit(1);
  const researchedCategory = (row?.enrichment as { industry?: unknown } | null)?.industry;
  const clearCategory = !!row?.category && typeof researchedCategory === "string" && row.category === researchedCategory;
  // Not research, so not cleared: her confirmation, a name-search candidate, and own-site imagery she vouched for
  // (carriedEnrichment keeps own_site through an unconfirmed verdict ONLY when she confirmed that domain).
  const carried = carriedEnrichment(row?.enrichment, identity);
  const keptCover = (carried.own_site as { cover?: string | null } | undefined)?.cover ?? null;
  const keepImagery = !!keptCover && row?.image_url === keptCover;
  await db
    .update(inboxBrands)
    .set({
      description:                null,
      brand_tier:                 null,
      audience_summary:           null,
      sport_categories:           null,
      known_athlete_partnerships: null,
      ...(keepImagery ? {} : { image_url: null, images: null }),
      ...(clearCategory ? { category: null } : {}),
      enriched_at:                new Date(),
      enrichment:                 { ...carried, identity },
    })
    .where(eq(inboxBrands.id, brandId));
  // Cached "why this fits" prose was written from the profile just discarded; it regenerates on demand.
  await db.delete(brandFitNarratives).where(eq(brandFitNarratives.brand_id, brandId));
}

export async function researchBrand(
  brandId: number,
  brandName: string,
  domain: string,
  opts: { force?: boolean; now?: Date } = {},
): Promise<void> {
  if (!brandName && !domain) return;

  // Re-enrichment guard — skip if enriched within 90 days. Bypassed by the brand
  // freshness path (getOrResearchBrand / brand-refresh cron), which owns its own,
  // shorter staleness window and passes force:true once it has decided to refresh.
  if (!opts.force) {
    const [existing] = await db
      .select({ enriched_at: inboxBrands.enriched_at })
      .from(inboxBrands)
      .where(eq(inboxBrands.id, brandId))
      .limit(1);

    if (existing?.enriched_at) {
      const age = Date.now() - new Date(existing.enriched_at).getTime();
      if (age < 90 * 24 * 60 * 60 * 1000) {
        logger.debug({ brandId, brandName }, "Brand recently enriched — skipping");
        return;
      }
    }
  }

  logger.info({ brandId, brandName, domain }, "researchBrand start");

  const searchName = brandName || domain;
  const gate = brandIdentityGateEnabled();

  // Gate on and no domain held as evidence: nothing a search returns could be confirmed, so don't run one.
  const now = opts.now ?? new Date();
  if (gate && !decideIdentity(domain, [], now).domain) {
    const none = decideIdentity(domain, [], now);
    await storeUnconfirmed(brandId, none);
    logger.info({ brandId, brandName, identity: none.basis }, "Brand research unconfirmed — no domain evidence, profile not stored");
    return;
  }

  // The global daily cap (fail closed: a count that cannot be read runs no search).
  const cap = brandResearchDailyCap();
  const today = await brandResearchesToday(now).catch(() => Number.POSITIVE_INFINITY);
  if (today >= cap) {
    logger.warn({ brandId, brandName, today, cap }, "Brand research skipped — the daily brand research cap is reached");
    return;
  }

  const results = await searchBrand(brandName, domain);
  const searchCostMicroUsd = results.reduce((n, r) => n + r.costMicroUsd, 0);
  const identity = gate ? decideIdentity(domain, results.flatMap((r) => r.hosts), now) : null;
  if (identity && identity.status === "unconfirmed") {
    await storeUnconfirmed(brandId, identity);
    logger.info({ brandId, brandName, domain: identity.domain, identity: identity.basis, searchCostMicroUsd }, "Brand research unconfirmed — no own-domain source, profile not stored");
    return;
  }

  const combinedText = results.map((r) => r.text).filter(Boolean).join("\n\n---\n\n");
  if (!combinedText.trim()) {
    logger.warn({ brandId, brandName, searchCostMicroUsd }, "No web search results for brand research");
    return;
  }
  const sources = brandSourcesOf(results);

  const prompt =
    `Brand: "${searchName}"\n\n` +
    `Schema (fill what you can find, null/[] for the rest):\n${EXTRACTION_SCHEMA}\n\n` +
    `Research text:\n${combinedText.slice(0, 8000)}`;

  let extracted: Record<string, any> | null = null;
  try {
    const resp = await kimiInstant(KIMI_SYSTEM, prompt, true);
    const raw  = resp.choices[0]?.message?.content ?? "{}";
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    extracted = JSON.parse(cleaned);
  } catch (err: any) {
    logger.warn({ brandId, brandName, err: err.message }, "Kimi brand extraction failed");
    return;
  }

  if (!extracted) return;

  // Best-effort brand imagery (og:image + real product/lifestyle shots, ranked by a Gemini
  // vision pass) — only when the row has no cover yet.
  // NEVER fails enrichment: neither fetch throws, and we only add the columns to the update
  // when we actually captured something (never null out an existing image/set).
  //
  // Two sources, in cost order:
  //   1. The homepage, via every candidate domain — the stored one, the marketing domain
  //      under any email-sending prefix, then a "<name>.com" guess. Many advertisers named
  //      inside an agency's mail have no domain of their own at all.
  //   2. Web search, when no page yields anything. This is not an edge case: a brand whose
  //      site blocks our scraper (the large ones all 403) or simply carries no og:image
  //      would otherwise be created with no cover FOREVER, since research only re-runs when
  //      a row is new or stale. Search found a real cover for HLTH Code — 5 images — where
  //      both candidate domains returned zero. Same Gemini vision rank either way, so a
  //      searched image clears the same bar as a scraped one.
  let cover: string | null = null;
  let images: string[] = [];
  let carried: Record<string, unknown> = {};
  {
    const [row] = await db
      .select({ image_url: inboxBrands.image_url, enrichment: inboxBrands.enrichment })
      .from(inboxBrands)
      .where(eq(inboxBrands.id, brandId))
      .limit(1);
    // Gate on: the non-research keys (her confirmation, own-site imagery, a candidate) outlive this profile write.
    if (identity) carried = carriedEnrichment(row?.enrichment, identity);

    if (!row?.image_url) {
      // Gate on: images only from the confirmed domain — no name-guessed domains, no web-search images.
      for (const d of identity ? [identity.domain!] : candidateDomains(brandName, domain)) {
        const captured = await fetchBrandImages(d);
        if (captured.cover) {
          cover = captured.cover;
          images = captured.images;
          break;
        }
      }
      if (!cover && brandName && !identity) {
        const searched = await fetchBrandImagesViaSearch(brandName);
        cover = searched.cover;
        images = searched.images;
      }
      if (cover) logger.info({ brandId, brandName, cover, count: images.length }, "Brand images captured");
    }
  }

  const toArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const toStr = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  const validTier = (v: unknown): "emerging" | "mid" | "established" | "premium" | null =>
    (["emerging","mid","established","premium"] as const).includes(v as any) ? v as any : null;

  await db
    .update(inboxBrands)
    .set({
      // industry IS the category tag — populate the `category` column that getBrandContext / whyFits
      // read (previously it only landed in description + enrichment, so category stayed null). Only
      // set when present so we never null out a category assigned at brand creation.
      category:                   toStr(extracted.industry) ?? undefined,
      description:                toStr(extracted.industry) ? `${toStr(extracted.industry) ?? ""}. ${toStr(extracted.description) ?? ""}`.trim() : toStr(extracted.description),
      brand_tier:                 validTier(extracted.brand_tier),
      audience_summary:           toStr(extracted.audience_summary),
      sport_categories:           toArr(extracted.sport_categories),
      known_athlete_partnerships: toArr(extracted.known_athlete_partnerships),
      enriched_at:                new Date(),
      // sources: the pages the searches saw, shown as links wherever the profile is shown.
      enrichment:                 identity ? { ...extracted, sources, ...carried, identity } : { ...extracted, sources },
      // Only set when captured this run — never null out an existing image/set.
      ...(cover ? { image_url: cover } : {}),
      ...(images.length ? { images } : {}),
    })
    .where(eq(inboxBrands.id, brandId));

  logger.info({ brandId, brandName, tier: extracted.brand_tier, sports: extracted.sport_categories, sources: sources.length, searchCostMicroUsd }, "Brand enrichment complete");
}
