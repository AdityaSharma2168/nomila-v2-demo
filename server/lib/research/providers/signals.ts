/**
 * lib/research/providers/signals.ts — Google Trends and GDELT → SignalEnvelope (Step 2a).
 *
 * Pure mappings over the results researchAthlete already fetches (no second call). GDELT items
 * carry the article URL from GDELT's own list, so a signal record cites its provider record.
 */

import type { SignalEnvelope } from "../../../services/intelligence/research/providers";
import type { TrendsResult } from "../../trends";
import type { GdeltResult } from "../../gdelt";

export function trendsEnvelope(r: TrendsResult, opts: { envelopeId: string; fetchedAt: string; name: string; sport: string | null }): SignalEnvelope {
  return { id: opts.envelopeId, provider: "google_trends", fetchedAt: opts.fetchedAt, windowDays: 30, values: { interest_score: r.interestScore }, items: [], raw: { interestScore: r.interestScore, relatedQueries: r.relatedQueries, timeframe: r.timeframe }, request: { path: "google-trends-api", params: { query: `${opts.name} ${opts.sport ?? ""}`.trim(), window: r.timeframe || "90d" } } };
}

export function gdeltEnvelope(r: GdeltResult, opts: { envelopeId: string; fetchedAt: string; name: string }): SignalEnvelope {
  return { id: opts.envelopeId, provider: "gdelt", fetchedAt: opts.fetchedAt, windowDays: 30, values: { article_count: r.articleCount, avg_tone: r.avgTone }, items: (r.recentArticles ?? []).slice(0, 10).map((a: any) => ({ url: a.url ?? null, title: a.title ?? null, date: a.seendate ?? a.date ?? null, domain: a.domain ?? null })), raw: { articleCount: r.articleCount, avgTone: r.avgTone, recentArticles: r.recentArticles }, request: { path: "/api/v2/doc/doc", params: { query: `"${opts.name}"`, mode: "artlist", maxrecords: 50, timespan: "30d" } } };
}
