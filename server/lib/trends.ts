import { createLogger } from "../logger";

const logger = createLogger("trends");

export interface TrendsResult {
  interestScore:  number;   // 0–100 raw Google Trends interest (30-day avg)
  relatedQueries: string[];
  timeframe:      string;
}

const EMPTY: TrendsResult = { interestScore: 0, relatedQueries: [], timeframe: "" };

// Dynamic import: google-trends-api uses CommonJS require() internally which
// breaks if imported at the module level in esbuild CJS bundles on Cloud Run.
async function getGoogleTrendsModule() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = await import("google-trends-api" as any);
  return (mod.default ?? mod) as {
    interestOverTime: (opts: { keyword: string; startTime: Date }) => Promise<string>;
  };
}

export async function fetchGoogleTrends(
  athleteName: string,
  sport?: string | null,
): Promise<TrendsResult> {
  if (!athleteName.trim()) return EMPTY;

  // Include sport to disambiguate (e.g. "Chisom Okpara basketball" not the musician)
  const keyword  = sport ? `${athleteName} ${sport}` : athleteName;
  const startTime = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90-day window

  try {
    const googleTrends = await getGoogleTrendsModule();
    const raw = await googleTrends.interestOverTime({ keyword, startTime });

    const parsed = JSON.parse(raw) as {
      default?: { timelineData?: Array<{ value?: number[] }> };
    };

    const timeline = parsed.default?.timelineData ?? [];
    if (timeline.length === 0) {
      logger.info({ athleteName, keyword }, "Google Trends: no data");
      return EMPTY;
    }

    const values   = timeline.map(p => p.value?.[0] ?? 0);
    const recent   = values.slice(-30);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
    const interestScore = Math.round(recentAvg);

    logger.info({ athleteName, interestScore }, "Google Trends result");
    return { interestScore, relatedQueries: [], timeframe: "30d" };
  } catch (err: any) {
    logger.warn({ athleteName, error: err.message?.slice(0, 120) }, "Google Trends skipped");
    return EMPTY;
  }
}
