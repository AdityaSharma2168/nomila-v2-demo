/**
 * find.ts — "find music": the catalogue filtered and ranked for one post, top 3, each with a one-line reason.
 *
 * PURE. No model, no I/O. It is the executor behind the creative agent's find_music tool (agent/postKit/tools.ts) and
 * the post-kit build's music step (agent/postKit/music.ts) — one function, so the tool and the pipeline cannot disagree.
 *
 * ─── THE CATALOGUE ──────────────────────────────────────────────────────────────────────────────
 *
 * The licensed tracks (tracks.ts, Artlist) and the free library (library.ts), seen through one shape (MusicTrack).
 * Beds (studio/video/beds.ts) are not in it: they carry no mood tags.
 *
 * ─── RULES THE RANKING CANNOT BEND ──────────────────────────────────────────────────────────────
 *
 *  1. A BRAND POST NEVER GETS A TRACK THAT IS NOT brandSafe. Filtered before anything is scored, and asserted again on
 *     the way out (find.test.ts guards every combination of inputs).
 *  2. MOOD IS HARD. A track that does not carry the mood asked for is offered only when fewer than three do, then only
 *     from the mood's named neighbours (taxonomy.ts NEIGHBOUR_MOODS), and its reason says so.
 *  3. ENERGY, TEMPO AND LENGTH ARE SOFT. A miss costs score; the reason only claims what the track actually matches.
 *  4. A REASON NAMES ONLY FACTS FROM THE CATALOGUE — its own moods, energy, BPM and length.
 */
import { MUSIC_TRACKS, type TrackId } from "./tracks";
import { LIBRARY_TRACKS, isLibraryTrackId, musicLibraryReady, type LibraryLicence } from "./library";
import {
  energyBandOf, NEIGHBOUR_MOODS, tempoBandOf, type EnergyBand, type TempoBand, type TrackGenre, type TrackMood,
  type TrackTheme, type TrackVocals,
} from "./taxonomy";
import type { Energy } from "./tracks";

export const MUSIC_USES = ["personal", "brand"] as const;
export type MusicUse = (typeof MUSIC_USES)[number];

/** One track as the finder and everything downstream sees it, whichever catalogue it is in. */
export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  moods: readonly TrackMood[];
  /** 1–5, and its low / medium / high band. */
  energyLevel: Energy;
  energy: EnergyBand;
  bpm: number;
  /** Null when the beat grid is not trusted to cut on. */
  firstBeatSec: number | null;
  genre: TrackGenre | null;
  themes: readonly TrackTheme[];
  /** Null until someone has listened. */
  vocals: TrackVocals | null;
  durationSec: number;
  loops: boolean;
  brandSafe: boolean;
  licence: LibraryLicence | "artlist";
  /** The TASL credit a post must carry, or null when none is owed. */
  credit: string | null;
  /** The same credit's short form (title, author, licence) for a caption with no room for the full one; null with it. */
  creditShort: string | null;
  /** What the source says about Content ID (library.ts), null when unknown. */
  contentIdRegistered: boolean | null;
  gcsPath: string;
}

const fromTracks = (id: TrackId): MusicTrack => {
  const t = MUSIC_TRACKS[id];
  return {
    id, title: t.title, artist: t.author, moods: t.moods, energyLevel: t.energy, energy: energyBandOf(t.energy), bpm: t.bpm,
    firstBeatSec: t.firstBeatSec, genre: null, themes: [], vocals: null,
    // The Artlist files run to their end; nobody has checked their tails, so they are not claimed to loop.
    durationSec: t.durationSec, loops: false, brandSafe: t.brandSafe, licence: "artlist", credit: null, creditShort: null,
    contentIdRegistered: null, gcsPath: t.gcsPath,
  };
};

/** Every track the finder can offer. */
const LICENCE_SHORT: Record<LibraryLicence, string> = { "CC0-1.0": "CC0", "CC-BY-4.0": "CC BY 4.0", "CC-BY-SA-4.0": "CC BY-SA 4.0" };

export const MUSIC_CATALOGUE: Readonly<Record<string, MusicTrack>> = Object.freeze({
  ...Object.fromEntries((Object.keys(MUSIC_TRACKS) as TrackId[]).map((id) => [id, fromTracks(id)])),
  ...Object.fromEntries(Object.values(LIBRARY_TRACKS).map((t) => [t.id, {
    id: t.id, title: t.title, artist: t.artist, moods: t.moods, energyLevel: t.energy as Energy, energy: energyBandOf(t.energy as Energy),
    bpm: t.bpm, firstBeatSec: t.firstBeatSec, genre: t.genre, themes: t.themes, vocals: t.vocals, durationSec: t.durationSec,
    loops: t.loops, brandSafe: t.brandSafe, licence: t.licence, credit: t.creditLine,
    creditShort: t.creditLine ? `"${t.title}" by ${t.artist}, ${LICENCE_SHORT[t.licence]}` : null,
    contentIdRegistered: t.contentIdRegistered,
    gcsPath: t.gcsPath,
  } satisfies MusicTrack])),
});

export const isMusicId = (v: unknown): v is string =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(MUSIC_CATALOGUE, v);

/**
 * MUSIC_ALLOW_ATTRIBUTION_TRACKS — owner decision M2 (12 Oct 2026): for now nothing is offered that needs a credit
 * line (CC BY / CC BY-SA). The tracks stay in the library manifest; off unless exactly "true", and turning it on brings
 * them back with the locked caption credit (agent/postKit/music.ts) already in place.
 */
export function musicAllowAttributionTracks(): boolean {
  return process.env.MUSIC_ALLOW_ATTRIBUTION_TRACKS === "true";
}

/** Whether a track may be OFFERED under the attribution switch: one that owes no credit always; one that does only when on. */
export const creditAllowed = (t: Pick<MusicTrack, "credit">, allowAttribution: boolean = musicAllowAttributionTracks()): boolean =>
  allowAttribution || t.credit === null;

/**
 * What can be OFFERED here: the licensed tracks, plus the free library when its files are installed
 * (musicLibraryReady) — and, unless MUSIC_ALLOW_ATTRIBUTION_TRACKS is on, nothing that needs a credit line. So nothing
 * suggests, signs or renders a file this environment does not have, or a track the owner has not allowed yet.
 */
export function availableCatalogue(
  libraryReady: boolean = musicLibraryReady(),
  allowAttribution: boolean = musicAllowAttributionTracks(),
): Readonly<Record<string, MusicTrack>> {
  return Object.fromEntries(Object.entries(MUSIC_CATALOGUE).filter(([id, t]) =>
    (libraryReady || !isLibraryTrackId(id)) && creditAllowed(t, allowAttribution)));
}

export interface FindMusicRequest {
  mood: TrackMood;
  use: MusicUse;
  energy?: EnergyBand;
  tempo?: TempoBand;
  /** A video theme the post fits (soft: a track filed under it ranks higher). */
  theme?: TrackTheme;
  /** The cut's length: a track shorter than this (and not loopable) would run out under it. */
  minLengthSec?: number;
  /** For a personal post: offer only brand-safe tracks anyway. Ignored (always true) for brand use. */
  brandSafeOnly?: boolean;
  /** How many to return: 3 unless asked otherwise (1–5). */
  limit?: number;
}

export interface FoundTrack {
  track: MusicTrack;
  score: number;
  /** True when the track carries a neighbour of the mood, not the mood itself. */
  neighbour: boolean;
  reason: string;
}

export type FindMusicResult =
  | { ok: true; tracks: FoundTrack[] }
  | { ok: false; reason: string };

const ENERGY_RANK: Record<EnergyBand, number> = { low: 0, medium: 1, high: 2 };
const TEMPO_RANK: Record<TempoBand, number> = { slow: 0, mid: 1, fast: 2 };

const fmtLen = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function findMusic(req: FindMusicRequest, catalogue: Readonly<Record<string, MusicTrack>> = MUSIC_CATALOGUE): FindMusicResult {
  const forBrand = req.use === "brand";
  const safeOnly = forBrand || req.brandSafeOnly === true;
  const limit = Math.max(1, Math.min(5, Math.floor(req.limit ?? 3)));
  const pool = Object.values(catalogue).filter((t) => !safeOnly || t.brandSafe);
  const neighbours = NEIGHBOUR_MOODS[req.mood] ?? [];

  const scored: FoundTrack[] = [];
  for (const t of pool) {
    const direct = t.moods.includes(req.mood);
    const near = !direct && t.moods.some((m) => neighbours.includes(m));
    if (!direct && !near) continue;
    let score = direct ? (t.moods[0] === req.mood ? 10 : 8) : 4;
    const parts: string[] = [];
    if (direct) parts.push(t.moods.join(", "));
    else parts.push(`${t.moods.join(", ")} (closest to ${req.mood})`);

    const energyHit = req.energy !== undefined && t.energy === req.energy;
    if (req.energy !== undefined) score -= 2 * Math.abs(ENERGY_RANK[t.energy] - ENERGY_RANK[req.energy]);
    parts.push(`${t.energy} energy`);

    const pace = tempoBandOf(t.bpm);
    if (req.tempo !== undefined) score -= 1.5 * Math.abs(TEMPO_RANK[pace] - TEMPO_RANK[req.tempo]);
    parts.push(`${Math.round(t.bpm)} BPM${req.tempo !== undefined && pace === req.tempo ? `, ${pace}` : ""}`);

    if (req.minLengthSec !== undefined && t.durationSec < req.minLengthSec) {
      if (t.loops) parts.push(`${fmtLen(t.durationSec)}, loops`);
      else { score -= 6; parts.push(`only ${fmtLen(t.durationSec)}`); }
    } else parts.push(t.loops ? `${fmtLen(t.durationSec)}, loops` : fmtLen(t.durationSec));

    if (req.theme !== undefined && t.themes.includes(req.theme)) { score += 1; parts.push(req.theme); }
    if (energyHit) score += 0.5;
    // Sourcing order (looks research §5d): CC0 / licensed first; a track owing a credit only when it is the better fit.
    if (!t.credit) score += 1;
    // Lyrics fight on-screen text: a sung track is a little behind an instrumental one.
    if (t.vocals === "vocal") score -= 1;
    scored.push({ track: t, score, neighbour: !direct, reason: parts.join(" · ") });
  }

  const ranked = scored.sort((a, b) => b.score - a.score || a.track.id.localeCompare(b.track.id));
  const direct = ranked.filter((r) => !r.neighbour);
  const out = (direct.length >= limit ? direct : [...direct, ...ranked.filter((r) => r.neighbour)]).slice(0, limit);

  // Rule 1, asserted where it leaves: a brand post is never handed a track that is not brand-safe.
  if (safeOnly && out.some((r) => !r.track.brandSafe)) throw new Error("findMusic: a non-brand-safe track reached a brand-safe request");

  if (!out.length) {
    const available = [...new Set(pool.flatMap((t) => t.moods))].sort();
    return {
      ok: false,
      reason: `No ${safeOnly ? "brand-safe " : ""}track carries "${req.mood}" or a mood near it. ` +
        (available.length ? `Try one of: ${available.join(", ")}.` : "No track is available for this use."),
    };
  }
  return { ok: true, tracks: out };
}
