/**
 * research/policy.ts — the research policy shape, the code defaults and the source-type
 * classifier. Pure (no database, no logger): the resolver and state tests import this; the
 * effective policy (active model_params rows over these defaults) is read in config.ts.
 */

import { SOURCE_TYPES, type FreshnessFamily, type ResearchDomain, type SourceType } from "./registries";
import { DEFAULT_DOMAIN_POLICY, type DomainPolicy } from "./injection";
import type { DirectSource } from "./spec/directEvidenceV1";
import { hostOf } from "./spec/directLineage";

export interface ResearchPolicy {
  /** Days after which a family's facts are stale; null = never. */
  ttlDays: Record<FreshnessFamily, number | null>;
  rawRetentionDays: number;
  /** Confidence ceiling for an uncited claim. */
  uncitedConfidenceCap: number;
  /** Independent domains needed for a lower-tier candidate to displace a stale higher-tier fact, or to establish an affiliation at the corroborating tier. */
  minCorroboration: number;
  domains: DomainPolicy;
  /** Hostname suffix → source type. Unknown → `unknown` (tier 8). Versioned with the policy row. */
  sourceTypeDomains: Record<SourceType, string[]>;
  /** Step 2b: the nightly planner's caps and cadences (design §5). Call caps are authoritative; USD caps are provisional. */
  planner: PlannerPolicy;
  /** Step 2b: provisional per-provider cost estimates (design §5); corrected from measured medians on dev. */
  costModel: CostModel;
  /** The model_params version the effective policy came from, or "defaults". */
  version?: string;
}

export interface PlannerPolicy {
  maxRunsPerNight: number;
  /** AUTHORITATIVE: Gemini + Kimi attempts per UTC day, retries included, reserved atomically. */
  maxLlmCallsPerNight: number;
  /** AUTHORITATIVE: LLM attempts per run. */
  maxCallsPerRun: number;
  /** AUTHORITATIVE for planner runs (the legacy path keeps its own MAX_RETRY). */
  geminiRetryMax: number;
  /** Client-side bound on ONE direct-research provider attempt (ms). A timed-out attempt is a counted, failed attempt. */
  geminiCallTimeoutMs: number;
  retryAllowancePerRun: number;
  /** PROVISIONAL (cost model). */
  maxUsdPerNight: number;
  maxUsdPerRun: number;
  maxRunsPerAthletePerDay: number;
  /** Signals lane (Trends/GDELT): no LLM. */
  maxSignalRunsPerNight: number;
  /** Discovery and other non-LLM API calls: counted separately, never on the LLM counter. */
  maxOtherCallsPerNight: number;
  /** Domains whose facts never expire still get a periodic scan for NEW items. */
  rescanDays: Partial<Record<ResearchDomain, number>>;
  disputeRecheckDays: number;
  maxDisputeRechecks: number;
  failureDeferDays: number;
  maxConsecutiveFailures: number;
}

export interface CostModel {
  /** perSearchQueryUsd: a per grounding-query fee (Gemini 3.x bills each Google Search query the model makes). provisional: list-price only, not reconciled with billing. */
  [provider: string]: { perCallUsd?: number; perMTokInUsd?: number; perMTokOutUsd?: number; perSearchQueryUsd?: number; provisional?: boolean };
}

/**
 * Per-attempt client timeout for the direct research call. Measured: six sequential calls ≈ 2 min, i.e. ≈ 20 s each.
 * 60 s is ≈ 3× that mean, so a slow but healthy grounded call is not cut off, while the worst case for one query
 * (1 + geminiRetryMax = 3 attempts × 60 s + ≈ 4 s backoff ≈ 184 s) stays well inside the 5-min runner lease.
 * 90 s (≈ 274 s worst case) would leave almost no margin under that lease.
 */
export const DEFAULT_GEMINI_CALL_TIMEOUT_MS = 60_000;

export const DEFAULT_PLANNER_POLICY: PlannerPolicy = {
  maxRunsPerNight: 25, maxLlmCallsPerNight: 150, maxCallsPerRun: 8, geminiRetryMax: 2, geminiCallTimeoutMs: DEFAULT_GEMINI_CALL_TIMEOUT_MS, retryAllowancePerRun: 2,
  maxUsdPerNight: 5.0, maxUsdPerRun: 0.6, maxRunsPerAthletePerDay: 1, maxSignalRunsPerNight: 200, maxOtherCallsPerNight: 400,
  rescanDays: { achievements: 90 }, disputeRecheckDays: 30, maxDisputeRechecks: 3, failureDeferDays: 7, maxConsecutiveFailures: 3,
};

export const DEFAULT_COST_MODEL: CostModel = {
  // gemini_grounded runs GEMINI.flash (gemini-3.5-flash, Vertex global): $1.50 / $9.00 per 1M input / output (Vertex
  // pricing page, checked 27 Oct 2026; was 0.30 / 2.50, the Flash-LITE rate). perCallUsd is NOT a list price: Vertex
  // bills grounding per query ($14 per 1,000 after 5,000 free a month); $0.035 a call stands in for ~2.5 queries.
  gemini_grounded: { perCallUsd: 0.035, perMTokInUsd: 1.5, perMTokOutUsd: 9.0 },
  kimi_extract: { perMTokInUsd: 0.6, perMTokOutUsd: 2.5 },
  // PROVISIONAL (1 Oct 2026): the v3 direct research call (geminiDirect, gemini-3.5-flash on the global endpoint) at the
  // Vertex list prices verified 30 Sep 2026: $1.50 / $9.00 per 1M input / output tokens (thinking tokens are billed as
  // output, and the adapter already counts them in completionTokens), plus $0.014 per grounding search query, counted
  // from the measured webSearchQueries of every attempt. The monthly free query allowance is ignored (upper bound). Not
  // reconciled with the billing export (none exists yet); replace once measured. Before this entry v3 runs recorded $0.
  gemini_direct: { perMTokInUsd: 1.5, perMTokOutUsd: 9.0, perSearchQueryUsd: 0.014, provisional: true },
  google_trends: { perCallUsd: 0 },
  gdelt: { perCallUsd: 0 },
};

export const DEFAULT_RESEARCH_POLICY: ResearchPolicy = {
  ttlDays: { identity: 365, affiliations: 180, achievements: null, press: 30, brand_mentions: 180, narrative: 180, social_handles: 365, signals: 30 },
  rawRetentionDays: 90,
  uncitedConfidenceCap: 0.5,
  minCorroboration: 2,
  domains: DEFAULT_DOMAIN_POLICY,
  sourceTypeDomains: {
    official_governing_body: ["ncaa.com", "ncaa.org", "fifa.com", "uefa.com", "concacaf.com", "olympics.com", "olympic.org", "fiba.basketball", "worldathletics.org", "itftennis.com", "wtatennis.com", "atptour.com", "nba.com", "wnba.com", "nfl.com", "mlb.com", "nhl.com", "mlssoccer.com", "nwslsoccer.com", "ussoccer.com", "usab.com", "usatf.org", "usaswimming.org", "usagym.org", "teamusa.org", "ioc.org", "theacc.com", "big12sports.com", "bigten.org", "secsports.com", "pac-12.com"],
    official_team_or_school: [".edu", "athletics.com"],
    major_news: ["espn.com", "si.com", "theathletic.com", "nytimes.com", "washingtonpost.com", "apnews.com", "reuters.com", "bbc.com", "bbc.co.uk", "cbssports.com", "foxsports.com", "nbcsports.com", "usatoday.com", "theguardian.com", "wsj.com", "forbes.com", "bloomberg.com", "yahoo.com", "sportsillustrated.com", "goal.com", "skysports.com", "espnfc.com", "bleacherreport.com"],
    reference: ["wikipedia.org", "wikidata.org", "sports-reference.com", "baseball-reference.com", "basketball-reference.com", "pro-football-reference.com", "soccerway.com", "transfermarkt.com", "fbref.com"],
    regional_news: [],
    athlete_authored_public: ["instagram.com", "tiktok.com", "x.com", "twitter.com", "youtube.com", "linktr.ee", "threads.net", "facebook.com"],
    aggregator_or_blog: ["on3.com", "247sports.com", "rivals.com", "opendorse.com", "nilstore.com", "medium.com", "substack.com", "reddit.com", "fandom.com"],
    unknown: [],
  },
  planner: DEFAULT_PLANNER_POLICY,
  costModel: DEFAULT_COST_MODEL,
  version: "defaults",
};

/** Suffix match on the hostname (a bare TLD entry like ".edu" matches any .edu host). */
export function classifySourceType(hostname: string | null | undefined, policy: ResearchPolicy = DEFAULT_RESEARCH_POLICY): SourceType {
  if (!hostname) return "unknown";
  const h = hostname.toLowerCase().replace(/^www\./, "");
  const order: SourceType[] = ["official_governing_body", "official_team_or_school", "major_news", "reference", "regional_news", "athlete_authored_public", "aggregator_or_blog"];
  for (const t of order) for (const suffix of policy.sourceTypeDomains[t] ?? []) {
    const s = suffix.toLowerCase();
    if (h === s || h.endsWith(s.startsWith(".") ? s : "." + s)) return t;
  }
  return "unknown";
}

/** Evidence that a platform URL is the athlete's own: the URLs and channel/outlet names to test against her known handles. */
export interface OwnershipEvidence { urls?: ReadonlyArray<string | null | undefined>; names?: ReadonlyArray<string | null | undefined>; knownHandles?: ReadonlyArray<string | null | undefined> }

/** A handle or channel name, normalized for a plain string match: lower-case, letters and digits only. */
export const normalizeHandleText = (s: unknown): string => (typeof s === "string" ? s.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]/g, "") : "");
const NOT_A_HANDLE = new Set(["watch", "channel", "c", "user", "shorts", "live", "embed", "p", "reel", "reels", "tv", "stories", "explore", "hashtag", "status", "i", "video", "videos", "share", "home", "search", "intent", "groups", "events", "pages", "photo", "photos", "permalink.php", "profile.php"]);
/** The handles / channel ids a platform URL names: any `@handle` segment, YouTube /channel|c|user/<x>, else the first path segment. */
export function urlHandles(u: string | null | undefined): string[] {
  let x: URL;
  try { x = new URL(String(u ?? "").trim()); } catch { return []; }
  const segs = x.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  const out = segs.filter((s) => s.startsWith("@")).map((s) => s.slice(1));
  if (["channel", "c", "user"].includes(segs[0] ?? "") && segs[1]) out.push(segs[1]);
  else if (segs[0] && !segs[0].startsWith("@") && !NOT_A_HANDLE.has(segs[0].toLowerCase())) out.push(segs[0]);
  return out;
}
/** The URL's handle/channel, or the channel/outlet name, equals a handle Nomila already holds for this athlete (normalized). */
export function ownedByAthlete(e: OwnershipEvidence | undefined): boolean {
  const known = new Set((e?.knownHandles ?? []).map(normalizeHandleText).filter(Boolean));
  if (!known.size) return false;
  const candidates = [...(e?.urls ?? []).flatMap((u) => urlHandles(u)), ...(e?.names ?? [])].map(normalizeHandleText).filter(Boolean);
  return candidates.some((c) => known.has(c));
}

/**
 * Outlet classification (research v3, identity sources). No registry layer beyond the domain list above.
 *   - A real outlet domain the list classifies (official, governing body, news, reference, aggregator…) keeps that class,
 *     whatever the model says.
 *   - A PLATFORM host (the list's athlete_authored_public hosts: YouTube, Instagram, TikTok, X, Facebook, Threads, Linktree) says
 *     nothing about who published: the model's valid outlet type decides (a network's channel → major_news, a team's channel →
 *     official_team_or_school, the athlete's own → athlete_authored_public). With no valid model type it is
 *     athlete_authored_public only when the URL's handle/channel (or the channel name) matches a handle Nomila holds for the
 *     athlete; otherwise unknown.
 *   - An unlisted domain takes the model's valid type; else unknown.
 */
export function resolveSourceType(modelOutletType: string | null | undefined, hostname: string | null | undefined, policy: ResearchPolicy = DEFAULT_RESEARCH_POLICY, ownership?: OwnershipEvidence): SourceType {
  const byDomain = classifySourceType(hostname, policy);
  const t = typeof modelOutletType === "string" ? modelOutletType.trim().toLowerCase() : "";
  const model = t && t !== "unknown" && (SOURCE_TYPES as readonly string[]).includes(t) ? (t as SourceType) : null;
  if (byDomain === "athlete_authored_public") return model ?? (ownedByAthlete(ownership) ? "athlete_authored_public" : "unknown");
  if (byDomain !== "unknown") return byDomain;
  return model ?? "unknown";
}

/**
 * The model's outlet type for the source an evidence row is bound to: the typed source whose host is the bound chunk's domain;
 * else the one type all the finding's typed sources agree on; else the claim's own `outletType` (athlete_media). Validated by
 * resolveSourceType (an invalid or `unknown` value falls back to the domain list); null when the model described nothing.
 */
export function modelOutletType(c: { sources?: unknown }, claim: Record<string, unknown>, chunkDomain: string | null): string | null {
  const typed = ((Array.isArray(c.sources) ? c.sources : []) as DirectSource[]).filter((x) => x && typeof x.outletType === "string" && !!x.outletType);
  const host = chunkDomain ? chunkDomain.toLowerCase().replace(/^www\./, "") : null;
  const byHost = host ? typed.find((x) => hostOf(x.url)?.toLowerCase() === host) : undefined;
  if (byHost) return byHost.outletType!;
  const distinct = [...new Set(typed.map((x) => x.outletType!))];
  if (distinct.length === 1) return distinct[0];
  return typeof claim.outletType === "string" ? claim.outletType : null;
}
