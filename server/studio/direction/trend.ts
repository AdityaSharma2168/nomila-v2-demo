/**
 * studio/direction/trend — the trend pillar's honest answer today (PR 7, Lane D2).
 *
 * Nothing in this codebase reads trending audio, formats or sounds: no table, no provider, no feed. A
 * search-costumed listicle would be the model-only-research failure class the brief names, so this
 * pillar SAYS it is not available rather than simulating one. The planned first real signal is her own
 * top-performing posts' formats and audio from the IG integration (card: "Real trend signal"), which
 * needs Lane G to land and Mia's call on reading performance data.
 *
 * ⚠️ MUTATION (routes.test, "trend returns fabricated data"): return `available: true` with any list —
 * "the trend door says, honestly, that it is not available — and carries nothing else" reds by name.
 */

export interface TrendSignal {
  available: false;
  reason: string;
}

export const TREND_NOT_AVAILABLE: TrendSignal = {
  available: false,
  reason:
    "No trend signal is wired yet — nothing here reads trending audio or formats, and nothing is simulated. " +
    "The first real signal will be your own top-performing posts.",
};

/** What the trend pillar has to offer: today, an honest no. */
export function trendSignal(): TrendSignal {
  return { ...TREND_NOT_AVAILABLE };
}
