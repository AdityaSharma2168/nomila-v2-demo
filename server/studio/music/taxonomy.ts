/**
 * taxonomy.ts — the words a music track is tagged with, and how they line up with the libraries people already use.
 *
 * ─── WHY A CROSSWALK, NOT A NEW VOCABULARY ──────────────────────────────────────────────────────
 *
 * The mood enum is the one the post-kit match skill already answers in (tracks.ts TRACK_MOODS), so a kit and the
 * catalogue speak the same eight words. Those eight are not invented: each is the same idea a widely used production
 * library files music under, and MOOD_CROSSWALK below says which of THEIR filters each one corresponds to. If the
 * taxonomy is ever changed to follow one of those libraries exactly, this table is the one place to remap: a track's
 * tags, the finder and the tests all read the enum, never the other libraries' words.
 *
 * The mapping follows the looks research (scratchpad looks-research.md §5a/§8f, 12 Oct 2026), which read:
 *   Epidemic Sound moods — https://www.epidemicsound.com/music/moods/ (34 moods; themes in its themes sitemap)
 *   Artlist category facets — https://artlist.io/music-categories/sitemap.xml (mood, video theme, genre, and a
 *     low / medium / high band, read as energy)
 *   YouTube Audio Library — https://support.google.com/youtube/answer/3376882 (filters: genre, mood, attribution)
 *   Meta Sound Collection needs a login and was not verified; TikTok's Commercial Music Library is cleared for use ON
 *   TikTok only. Both are platform-native: "add a sound in the app" options, never catalogue tracks here.
 *
 * ENERGY is stored 1–5 (tracks.ts's scale) and bucketed to Artlist's low / medium / high (energyBandOf). TEMPO is the
 * BPM, banded the way recommend.ts already bands it (slow < 100 ≤ mid < 110 ≤ fast). GENRE uses Artlist / Epidemic
 * genre names; THEME the video themes those libraries file sport content under; VOCALS whether words compete with
 * on-screen text.
 *
 * LOUDNESS: every file is normalised to −14 LUFS integrated with a −1 dBTP true-peak ceiling — studio/video/
 * finishing.ts BED_REFERENCE_LUFS / TRUE_PEAK_DBTP, the same rule the render applies. −14 LUFS is YouTube's playback
 * reference and Spotify's published target (with true peak below −1 dBTP); Meta, TikTok and YouTube Shorts publish no
 * LUFS target, so no platform-specific figure is claimed for them.
 */
import { TRACK_MOODS, type Energy, type TrackMood } from "./tracks";

export { TRACK_MOODS, type TrackMood };

export const ENERGY_BANDS = ["low", "medium", "high"] as const;
export type EnergyBand = (typeof ENERGY_BANDS)[number];

export const TEMPO_BANDS = ["slow", "mid", "fast"] as const;
export type TempoBand = (typeof TEMPO_BANDS)[number];

/** Energy 1–5 as a band: 1–2 low, 3 medium, 4–5 high. */
export const energyBandOf = (e: Energy): EnergyBand => (e <= 2 ? "low" : e === 3 ? "medium" : "high");

/** Genre, in the names Artlist and Epidemic file music under. */
export const TRACK_GENRES = [
  "rock", "pop", "electronic", "synthwave", "hip-hop", "lofi", "phonk", "funk", "disco", "cinematic", "latin", "reggae",
  "chiptune", "acoustic",
] as const;
export type TrackGenre = (typeof TRACK_GENRES)[number];

/** Video themes (Artlist's video-theme facet, Epidemic's sports and workout themes). */
export const TRACK_THEMES = ["sport-fitness", "workout", "championships", "slow-motion", "vlog"] as const;
export type TrackTheme = (typeof TRACK_THEMES)[number];

/** Whether words are sung: lyrics fight on-screen text. Null on a track until someone has listened. */
export const TRACK_VOCALS = ["instrumental", "vocal", "backing"] as const;
export type TrackVocals = (typeof TRACK_VOCALS)[number];

/** Where a BPM sits — the same cut-offs as recommend.ts tempoOf. */
export const tempoBandOf = (bpm: number): TempoBand => (bpm < 100 ? "slow" : bpm >= 110 ? "fast" : "mid");

/** Each of our moods as Epidemic / Artlist name the same feel. Documentation and the remap point, never matched on. */
export const MOOD_CROSSWALK: Readonly<Record<TrackMood, readonly string[]>> = {
  hype: ["Epic", "Exciting", "Powerful"],
  driving: ["Running", "Chasing"],
  reflective: ["Sentimental", "Peaceful"],
  bright: ["Happy"],
  warm: ["Hopeful", "Laid Back"],
  dark: ["Dark"],
  playful: ["Playful", "Quirky"],
  uplifting: ["Uplifting", "Euphoric"],
};

/**
 * The moods nearest each one, nearest first — what the finder falls back to, and says it did, when too few tracks
 * carry the mood asked for. Symmetric where it can be; never crosses light ↔ dark.
 */
export const NEIGHBOUR_MOODS: Readonly<Record<TrackMood, readonly TrackMood[]>> = {
  hype: ["driving", "uplifting"],
  driving: ["hype", "dark"],
  dark: ["driving"],
  bright: ["playful", "uplifting"],
  playful: ["bright", "warm"],
  uplifting: ["bright", "hype"],
  warm: ["reflective", "bright"],
  reflective: ["warm"],
};

export const isMood = (v: unknown): v is TrackMood => typeof v === "string" && (TRACK_MOODS as readonly string[]).includes(v);
export const isEnergyBand = (v: unknown): v is EnergyBand => typeof v === "string" && (ENERGY_BANDS as readonly string[]).includes(v);
export const isTempoBand = (v: unknown): v is TempoBand => typeof v === "string" && (TEMPO_BANDS as readonly string[]).includes(v);
export const isTheme = (v: unknown): v is TrackTheme => typeof v === "string" && (TRACK_THEMES as readonly string[]).includes(v);
