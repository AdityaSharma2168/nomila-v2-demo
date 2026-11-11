import { createLogger } from "../logger";

const logger = createLogger("gdelt");

export interface GdeltArticle {
  title:  string;
  url:    string;
  date:   string;
  source: string;
}

export interface GdeltResult {
  articleCount:    number;
  recentArticles:  GdeltArticle[];
  avgTone:         number;  // GDELT tone: positive = good press, negative = bad press
}

const EMPTY: GdeltResult = { articleCount: 0, recentArticles: [], avgTone: 0 };

// GDELT free API rate-limits aggressively (HTTP 429). Retry with backoff before giving up.
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = [4_000, 10_000];  // 4s then 10s

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchGdelt(athleteName: string): Promise<GdeltResult> {
  if (!athleteName.trim()) return EMPTY;

  const query = encodeURIComponent(`"${athleteName}"`);
  const url   = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=artlist&maxrecords=50&format=json&timespan=30d`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAY_MS[attempt - 1];
      logger.info({ athleteName, attempt, delay }, "GDELT retry after rate-limit");
      await sleep(delay);
    }

    try {
      const response = await fetch(url, {
        signal:  AbortSignal.timeout(15_000),
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      if (response.status === 429) {
        if (attempt < MAX_RETRIES) continue;  // will retry
        logger.warn({ athleteName, attempts: attempt + 1 }, "GDELT rate-limited (429) — all retries exhausted");
        return EMPTY;
      }

      if (!response.ok) throw new Error(`GDELT HTTP ${response.status}`);

      const text = await response.text();
      if (!text.trim()) return EMPTY;

      const data = JSON.parse(text) as {
        articles?: Array<{
          title?:    string;
          url?:      string;
          seendate?: string;
          domain?:   string;
          tone?:     number;
        }>;
      };

      const articles = data.articles ?? [];
      const tones    = articles.map(a => a.tone ?? 0).filter(t => t !== 0);
      const avgTone  = tones.length > 0
        ? Math.round((tones.reduce((a, b) => a + b, 0) / tones.length) * 100) / 100
        : 0;

      const recentArticles: GdeltArticle[] = articles.slice(0, 10).map(a => ({
        title:  a.title    ?? "",
        url:    a.url      ?? "",
        date:   a.seendate ?? "",
        source: a.domain   ?? "",
      }));

      logger.info({ athleteName, articleCount: articles.length, avgTone, attempt }, "GDELT result");
      return { articleCount: articles.length, recentArticles, avgTone };

    } catch (err: any) {
      if (attempt < MAX_RETRIES && err.message?.includes("429")) continue;
      logger.warn({ athleteName, attempt, error: err.message?.slice(0, 120) }, "GDELT skipped");
      return EMPTY;
    }
  }

  return EMPTY;
}
