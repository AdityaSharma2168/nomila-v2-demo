/**
 * studio/capabilityRoutes — the ONLY place an engine is named for a library entry (capability layer v3 §4, PR 1a).
 *
 * The library (studio/agent/capabilityEntries.ts) says what a capability does, needs and costs, in words with no
 * engine in them; the agent plans against those words. This table says which engine serves each entry today and
 * which LANE it runs in:
 *
 *   inline  inside the preview render that already runs (the API, or the media worker when previews run there)
 *   media   needs the media worker's image (speech, cut-out, motion graphics). Down until that service exists and
 *           post-kit previews are routed to it (AGENT_POST_KIT_RENDER_LANE=media) — so every media entry is left
 *           out of the block until then, whatever its flag says.
 *   paid    the studio router, only after her tap and the spend gate
 *
 * An engine can be swapped without a deploy: STUDIO_CAP_ENGINE_<ENTRY> (the entry id upper-cased, every dot an
 * underscore) replaces the engine string — never a prompt. Nothing dispatches through this table yet: the post-kit
 * compiler (PR 1b) and each capability's own PR are where it starts to.
 *
 * Tests (capabilityRoutes.test.ts): every entry on any surface has a route, and every route names an entry.
 */
import { CAPABILITY_ENTRIES } from "./agent/capabilityEntries";

export const LANES = ["inline", "media", "paid"] as const;
export type Lane = (typeof LANES)[number];

export interface EntryRoute {
  lane: Lane;
  /** Engine and version: what the logs record against a step. */
  engine: string;
  /** A second engine for when the first is missing from the build (steadying's built-in fallback). */
  fallback?: string;
}

export const ENTRY_ROUTES: Readonly<Record<string, EntryRoute>> = {
  "clip.camera": { lane: "inline", engine: "ffmpeg-trim/1" },
  "clip.her_instagram": { lane: "inline", engine: "ffmpeg-trim/1" },
  "clip.made_here": { lane: "inline", engine: "ffmpeg-trim/1" },
  "image.held": { lane: "inline", engine: "still/1" },
  "image.motion.dolly": { lane: "inline", engine: "still-move/1" },
  "image.motion.zoom": { lane: "inline", engine: "still-move/1" },
  "image.motion.sweep": { lane: "inline", engine: "still-move/1" },
  "image.motion.punch": { lane: "inline", engine: "still-move/1" },
  i2v: { lane: "paid", engine: "router:video.generate" },
  broll: { lane: "paid", engine: "router:video.generate#broll" },
  product: { lane: "paid", engine: "router:video.generate#product" },
  caption: { lane: "inline", engine: "satori-band/1" },
  "music.track": { lane: "inline", engine: "catalogue/1" },
  "music.bed": { lane: "inline", engine: "beds/1" },
  "music.mood": { lane: "inline", engine: "catalogue-mood/1" },
  look: { lane: "inline", engine: "sharp-grade/1" },
  "look.preset": { lane: "inline", engine: "ffmpeg-look/1" },
  "clip.stabilise": { lane: "inline", engine: "ffmpeg-vidstab/1", fallback: "ffmpeg-deshake/1" },
  "clip.slow_mo": { lane: "inline", engine: "ffmpeg-retime/1" },
  "caption.auto": { lane: "media", engine: "whisper.cpp:small-q5_1+satori" },
  "image.cutout": { lane: "media", engine: "rembg:isnet-general-use" },
  "image.background_place": { lane: "media", engine: "rembg+sharp:place/1" },
  "card.ad.cutout_hero": { lane: "media", engine: "satori+sharp:cutout_hero/1" },
  "card.title": { lane: "media", engine: "remotion:title-card/1" },
  "card.countdown": { lane: "media", engine: "remotion:countdown/1" },
};

/** The variable that swaps one entry's engine: `image.motion.zoom` → STUDIO_CAP_ENGINE_IMAGE_MOTION_ZOOM. */
export const engineOverrideVar = (entryId: string): string =>
  `STUDIO_CAP_ENGINE_${entryId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

type Env = Readonly<Record<string, string | undefined>>;

/** An entry's route now, with any engine override applied; null for an entry that has none. */
export function routeFor(entryId: string, env: Env = process.env): EntryRoute | null {
  const route = Object.prototype.hasOwnProperty.call(ENTRY_ROUTES, entryId) ? ENTRY_ROUTES[entryId] : undefined;
  if (!route) return null;
  const swapped = env[engineOverrideVar(entryId)]?.trim();
  return swapped ? { ...route, engine: swapped } : route;
}

/**
 * Whether a lane can carry work in this environment. inline and paid are always up (the render and the router
 * exist); media is up only when post-kit previews run on the media worker.
 */
export function laneUp(lane: Lane, env: Env = process.env): boolean {
  if (lane === "media") return env.AGENT_POST_KIT_RENDER_LANE === "media";
  return true;
}

/**
 * Whether a route's ENGINE can run here. A Remotion engine runs on the motion renderer (media/remotion), which is up
 * when REMOTION_RENDER_URL is set; every other engine follows its lane.
 */
export function routeUp(route: EntryRoute, env: Env = process.env): boolean {
  if (route.engine.startsWith("remotion:")) return Boolean(env.REMOTION_RENDER_URL?.trim());
  return laneUp(route.lane, env);
}

/** Entries on at least one surface — the ones that must have a route. */
export const routedEntryIds = (): string[] => CAPABILITY_ENTRIES.filter((e) => e.surfaces.length > 0).map((e) => e.id);
