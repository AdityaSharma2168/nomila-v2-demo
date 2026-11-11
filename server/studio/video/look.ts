/**
 * look.ts — a post's LOOK as one fixed ffmpeg colour filter (design "Moments → post kits" §11: the treatment plan's
 * `lookPreset`, which the preview render applies through StitchFinishing.look).
 *
 * A NAME travels, never a filter: the post kit stores the name (shared/postKit.ts LOOK_PRESETS) and the expansion lives
 * here, in one table, so a look that turns out wrong is corrected in one place. Nothing off a wire or a model reaches
 * this string — the name is checked against the closed set first, and every value below is ours.
 *
 * Two filters, both in every ffmpeg build this repo runs on (Debian 5.1 in the image, Ubuntu's on CI, 9.x on a laptop)
 * and both LGPL, so no build flag decides whether a look exists:
 *
 *   colorbalance   shifts red against blue in the shadows and mid-tones: warm, cool
 *   hue=s          scales saturation in YUV directly (no RGB round trip): vivid, muted, and 0 for mono
 *
 * "natural" is NO filter — a clip graded natural goes through the engine byte for byte as it would have without a look.
 * The filter is applied per position AFTER the conform and BEFORE any caption is laid over it (plan.ts), so the words are
 * never tinted.
 */
import { LOOK_PRESETS, type LookPreset } from "../../../shared/postKit";

export type VideoLook = LookPreset;

const LOOK_FILTERS: Record<VideoLook, string | null> = {
  natural: null,
  warm: "colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.05:bm=-0.05",
  cool: "colorbalance=rs=-0.08:bs=0.08:rm=-0.05:bm=0.05",
  vivid: "hue=s=1.3",
  muted: "hue=s=0.7",
  mono: "hue=s=0",
};

export const isVideoLook = (v: unknown): v is VideoLook =>
  typeof v === "string" && (LOOK_PRESETS as readonly string[]).includes(v);

/** The filter for a look, or null for one that changes nothing (natural). Throws on a name outside the set. */
export function lookFilter(look: VideoLook): string | null {
  if (!isVideoLook(look)) throw new Error(`Unknown look: ${String(look)}`);
  return LOOK_FILTERS[look];
}
