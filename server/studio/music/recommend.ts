/**
 * recommend.ts — her words about a video's feel → the catalogue's tracks, best first, each with one
 * line saying why.
 *
 * PURE. No model call, no I/O: a synonym table, a tempo test and an energy distance. A feel is a
 * handful of words ("warm, slow, golden light"), the catalogue is a handful of tracks, and every
 * reason has to be checkable against the catalogue — which a model's prose is not.
 *
 * ─── TWO RULES THE SCORE CANNOT BEND ────────────────────────────────────────────────────────────
 *
 *  1. BRAND WORK NEVER SEES A TRACK THAT IS NOT brandSafe. It is filtered out before scoring, not
 *     ranked low — a list she scrolls to the bottom of is still a list she can pick from.
 *  2. A REASON NAMES ONLY MOODS THE TRACK CARRIES. It is built from the intersection of what she
 *     asked for and the track's own tags, never from what she asked for alone.
 */
import {
  MUSIC_TRACKS,
  TRACK_MOODS,
  type Energy,
  type TrackDefinition,
  type TrackMood,
} from "./tracks";

export type TempoHint = "slow" | "mid" | "fast";

export interface RecommendRequest {
  /** Her words. Free text; split and matched against FEEL_WORDS. */
  feel: readonly string[];
  /** The energy the edit wants, if known. */
  energy?: Energy;
  /** The edit's own tempo, if it has one. A tempo word in `feel` sets this when absent. */
  tempo?: TempoHint;
  /** True when the video is for a brand: only brandSafe tracks are considered. */
  forBrand: boolean;
}

export interface Recommendation {
  id: string;
  score: number;
  /** One line, built only from facts in the catalogue. */
  reason: string;
}

/**
 * Her word → a mood tag or a tempo. Lower-case, single words; a word not here is ignored rather
 * than guessed at. Mood tags map to themselves.
 */
export const FEEL_WORDS: Readonly<Record<string, TrackMood | TempoHint>> = {
  ...Object.fromEntries(TRACK_MOODS.map((m) => [m, m])),
  // hype
  hyped: "hype",
  energetic: "hype",
  intense: "hype",
  epic: "hype",
  // warm
  golden: "warm",
  cozy: "warm",
  cosy: "warm",
  soft: "warm",
  sunset: "warm",
  // reflective
  calm: "reflective",
  chill: "reflective",
  moody: "reflective",
  thoughtful: "reflective",
  nostalgic: "reflective",
  // bright
  sunny: "bright",
  happy: "bright",
  fresh: "bright",
  // Not "light": in "golden light" it is lighting, not brightness.
  // driving
  drive: "driving",
  momentum: "driving",
  confident: "driving",
  // dark
  gritty: "dark",
  heavy: "dark",
  // playful
  fun: "playful",
  bouncy: "playful",
  // uplifting
  hopeful: "uplifting",
  inspiring: "uplifting",
  triumphant: "uplifting",
  // tempo
  slow: "slow",
  slower: "slow",
  relaxed: "slow",
  fast: "fast",
  quick: "fast",
  upbeat: "fast",
  medium: "mid",
  steady: "mid",
};

const isMood = (v: string): v is TrackMood =>
  (TRACK_MOODS as readonly string[]).includes(v);

/** The moods and the tempo her words ask for. */
export function readFeel(feel: readonly string[]): {
  moods: TrackMood[];
  tempo: TempoHint | undefined;
} {
  const moods = new Set<TrackMood>();
  let tempo: TempoHint | undefined;
  for (const word of feel
    .join(" ")
    .toLowerCase()
    .split(/[^a-z]+/)) {
    if (!word || !Object.prototype.hasOwnProperty.call(FEEL_WORDS, word))
      continue;
    const hit = FEEL_WORDS[word];
    if (isMood(hit)) moods.add(hit);
    else tempo ??= hit;
  }
  return { moods: [...moods], tempo };
}

/** Where a BPM sits. Slow is under 100, fast is 110 and up. */
export const tempoOf = (bpm: number): TempoHint =>
  bpm < 100 ? "slow" : bpm >= 110 ? "fast" : "mid";

/** The energy an empty request is ranked toward: the middle, so nothing extreme leads by default. */
export const NEUTRAL_ENERGY: Energy = 3;

export function recommend(
  req: RecommendRequest,
  catalogue: Readonly<Record<string, TrackDefinition>> = MUSIC_TRACKS,
): Recommendation[] {
  const { moods: asked, tempo: feltTempo } = readFeel(req.feel);
  const tempo = req.tempo ?? feltTempo;
  const neutral = asked.length === 0 && !tempo && req.energy === undefined;
  const targetEnergy = req.energy ?? (neutral ? NEUTRAL_ENERGY : undefined);

  return Object.entries(catalogue)
    .filter(([, t]) => !req.forBrand || t.brandSafe)
    .map(([id, t]) => {
      const hits = asked.filter((m) => t.moods.includes(m));
      const pace = tempoOf(t.bpm);
      let score = 3 * hits.length;
      if (tempo) score += pace === tempo ? 2 : -1;
      if (targetEnergy !== undefined)
        score -= Math.abs(t.energy - targetEnergy);

      const parts: string[] = [];
      if (hits.length) parts.push(hits.join(", "));
      parts.push(
        `${Math.round(t.bpm)} BPM${tempo && pace === tempo ? `, ${pace}` : ""}`,
      );
      parts.push(`energy ${t.energy}/5`);
      return { id, score, reason: parts.join(" · ") };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
