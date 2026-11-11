/**
 * agent/postKit/tools.ts — the post-kit (creative) tools for an agent loop. One today:
 *
 *   find_music   read   the music catalogue filtered for one post (mood, energy, tempo, length, use) → top 3, each with
 *                       a one-line reason built from the track's own tags. Executor: studio/music/find.ts findMusic —
 *                       the same function the post-kit build's music step calls (agent/postKit/music.ts), so what the
 *                       agent is told and what a kit gets cannot differ.
 *
 * Registered in the default registry (coreTools.ts) under its group; no skill lists it yet (the chat's content tools are
 * on hold, design "content sequencing", 11 Oct). Its description is prompt text: it is in the Prompt Register.
 *
 * Practice (agent tool rules, 12 Oct): grouped by job; says what it does, when to use it and when not; fixed choice
 * lists for every filter (zod enums → JSON-schema enums) so a bad call cannot be expressed; errors say what failed and
 * what to try; a brand post can never be handed a track that is not brand-safe (find.test.ts guards it).
 */
import { z } from "zod";
import { availableCatalogue, findMusic, MUSIC_USES } from "../../studio/music/find";
import { ENERGY_BANDS, TEMPO_BANDS, TRACK_MOODS, TRACK_THEMES } from "../../studio/music/taxonomy";
import { errorResult, okResult, type AgentTool } from "../tools";

export const FIND_MUSIC_DESCRIPTION = [
  "Find music for one post from Nomila's cleared music catalogue. Returns up to 3 tracks, best first, each with a one-line reason, its licence and the credit line the post must carry (null when none is owed).",
  "Use when: a post (reel or story) needs a soundtrack, or the athlete asks for different music.",
  "Don't use: for a still photo or carousel post (they carry no music); to look up a song by name or artist (the catalogue is not searchable by title, and popular songs are not in it); for a trending or platform sound (she adds those in Instagram or TikTok when she posts; they cannot go in the file); to check licences of music the athlete supplied.",
  "use: \"brand\" for any post made for or with a brand partner — only brand-safe tracks are returned; \"personal\" for her own content.",
  "min_length_sec: the cut's length; a shorter track that does not loop is ranked down.",
  "If a credit is returned for the track that is used, the post's caption must include it (the post kit adds it and keeps it there).",
  "content_id_registered true: a YouTube upload using it may be claimed (released on dispute once the credit is in the video description); prefer another track when one fits as well.",
  "Example: a 20-second hype reel of a game winner for her own account → mood \"hype\", use \"personal\", energy \"high\", min_length_sec 20.",
].join("\n");

const args = z.object({
  mood: z.enum(TRACK_MOODS).describe("The feel the post wants."),
  use: z.enum(MUSIC_USES).describe("brand = for or with a brand partner (brand-safe tracks only); personal = her own content."),
  energy: z.enum(ENERGY_BANDS).optional().describe("How much drive the music should have."),
  tempo: z.enum(TEMPO_BANDS).optional().describe("slow < 100 BPM, mid 100–109, fast 110+."),
  theme: z.enum(TRACK_THEMES).optional().describe("The kind of video, when it is one of these."),
  min_length_sec: z.number().int().min(1).max(600).optional().describe("The cut's length in seconds."),
  brand_safe_only: z.boolean().optional().describe("Personal posts only: also restrict to brand-safe tracks (always on for brand use)."),
});

export function findMusicTool(): AgentTool<typeof args> {
  return {
    name: "find_music",
    description: FIND_MUSIC_DESCRIPTION,
    kind: "ours",
    permission: "read",
    args,
    async execute(_ctx, a) {
      const r = findMusic({
        mood: a.mood, use: a.use,
        ...(a.energy ? { energy: a.energy } : {}),
        ...(a.tempo ? { tempo: a.tempo } : {}),
        ...(a.theme ? { theme: a.theme } : {}),
        ...(a.min_length_sec ? { minLengthSec: a.min_length_sec } : {}),
        ...(a.brand_safe_only ? { brandSafeOnly: true } : {}),
      // What is installed here: never a track whose file this environment does not have.
      }, availableCatalogue());
      if (!r.ok) return errorResult(r.reason);
      return okResult({
        tracks: r.tracks.map(({ track: t, reason, neighbour }) => ({
          track_id: t.id, title: t.title, artist: t.artist, moods: t.moods, energy: t.energy, energy_level: t.energyLevel,
          bpm: Math.round(t.bpm), genre: t.genre, themes: t.themes, vocals: t.vocals, length_sec: Math.round(t.durationSec),
          loops: t.loops, brand_safe: t.brandSafe, licence: t.licence, credit: t.credit,
          content_id_registered: t.contentIdRegistered,
          reason, ...(neighbour ? { nearest_mood_only: true } : {}),
        })),
      });
    },
  };
}

/** The post-kit tool group, as the registry takes it. */
export const postKitTools = (): AgentTool[] => [findMusicTool() as unknown as AgentTool];
