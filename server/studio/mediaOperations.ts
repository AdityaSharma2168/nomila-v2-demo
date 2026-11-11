/**
 * studio/mediaOperations — every media operation in the codebase, and what it is to a planner (capability layer v3 §1,
 * "Audit: every media operation in the codebase"; PR 1a).
 *
 * Each operation is one of:
 *
 *   entry     the library has an entry for it (studio/agent/capabilityEntries.ts) — `entries` names them
 *   internal  plumbing no planner ever chooses (probes, shot detection, loudness, frame reads)
 *   later     a capability that is not offered on any surface yet — `later` names it, and the capability block prints
 *             it under "not available here yet", so no planner plans it and Mila never promises it
 *   never     never offered to a planner (kits never make a picture from nothing)
 *
 * mediaOperations.test.ts reads the code and fails when a new edit op, classifier operation, router task, or video or
 * music module appears without a row here — and when a row names one that is gone.
 */

export const OPERATION_SOURCES = [
  /** shared/schema.ts STUDIO_EDIT_OPS — the Studio's typed photo edits. */
  "edit_op",
  /** studio/classify.ts EditOperation — what a sentence asking for a photo edit can mean. */
  "classify_op",
  /** studio/types.ts GenerationTask — what the router can be asked to do. */
  "router_task",
  /** A module under server/studio/video or server/studio/music. */
  "video_module",
  "music_module",
  /** A capability the design names that has no code yet. */
  "planned",
] as const;
export type OperationSource = (typeof OPERATION_SOURCES)[number];

export type OperationStatus = "entry" | "internal" | "later" | "never";

export interface MediaOperation {
  source: OperationSource;
  /** The op, member or task as the code spells it; a module's file name without .ts. */
  name: string;
  status: OperationStatus;
  /** status entry: the library entries that describe it. */
  entries?: readonly string[];
  /** status later: the capability names a planner must not promise yet. */
  later?: readonly string[];
  note: string;
}

const op = (
  source: OperationSource,
  name: string,
  status: OperationStatus,
  note: string,
  names: readonly string[] = [],
): MediaOperation =>
  status === "entry"
    ? { source, name, status, entries: names, note }
    : status === "later"
      ? { source, name, status, later: names, note }
      : { source, name, status, note };

const MOTIONS = ["image.motion.dolly", "image.motion.zoom", "image.motion.sweep", "image.motion.punch"];

export const MEDIA_OPERATIONS: readonly MediaOperation[] = [
  // Studio photo edits (paid, behind her tap): entries when a planner can offer them behind a button.
  op("edit_op", "recolour", "later", "paid photo edit", ["image.recolour"]),
  op("edit_op", "garment", "later", "paid try-on in the app", ["image.garment"]),
  op("edit_op", "product", "later", "paid: a product added to her photo", ["image.add_product"]),
  op("edit_op", "background_clean", "later", "paid plain plate; the free image.background_place covers that case", ["image.background_clean"]),
  op("edit_op", "ad", "later", "paid AI ad; the free card.ad.cutout_hero is the entry", ["image.ad_ai"]),

  op("classify_op", "RECOLOR", "later", "paid photo edit", ["image.recolour"]),
  op("classify_op", "APPLY_DESIGN", "later", "paid photo edit", ["image.apply_design"]),
  op("classify_op", "REPLACE_OBJECT", "later", "paid photo edit", ["image.object.*"]),
  op("classify_op", "REMOVE_OBJECT", "later", "paid photo edit", ["image.object.*"]),
  op("classify_op", "ADD_OBJECT", "later", "paid photo edit", ["image.object.*"]),
  op("classify_op", "MOVE_OBJECT", "later", "paid photo edit", ["image.object.*"]),
  op("classify_op", "DISPLAY_TEXT", "entry", "words on the picture are the free caption and cards", ["caption", "card.title"]),
  op("classify_op", "CHANGE_BACKGROUND", "later", "the paid premium of image.background_place", ["image.background_swap"]),
  op("classify_op", "GLOBAL_STYLE", "entry", "a whole-frame look is the free look entry; an AI restyle is not offered", ["look", "look.preset"]),
  op("classify_op", "RELIGHT", "later", "paid photo edit", ["image.relight"]),
  op("classify_op", "CAMERA", "later", "paid photo edit", ["image.camera_angle"]),
  op("classify_op", "CROP", "internal", "the beat's frame"),
  op("classify_op", "BRAND_MARK", "entry", "the ad card's logo slot", ["card.ad.cutout_hero"]),
  op("classify_op", "GENERATE", "never", "kits never make a picture from nothing"),

  op("router_task", "image.generate", "never", "kits never make a picture from nothing"),
  op("router_task", "image.edit", "later", "serves the paid photo edits above", ["image.background_swap", "image.relight"]),
  op("router_task", "video.generate", "entry", "the generated shots", ["i2v", "broll", "product"]),
  op("router_task", "image.segment", "internal", "the try-on's garment mask"),
  op("router_task", "image.crop", "internal", "the beat's frame"),

  op("video_module", "beatGrid", "internal", "the music's beat grid"),
  op("video_module", "beds", "entry", "CC0 beds", ["music.bed"]),
  op("video_module", "captionRender", "entry", "draws caption bands", ["caption"]),
  op("video_module", "captionSuggest", "entry", "the Video tab's caption suggestions", ["caption"]),
  op("video_module", "captions", "entry", "caption text, positions and styles", ["caption"]),
  op("video_module", "ebur128", "internal", "the loudness meter's spelling, on prod's ffmpeg 5.1 and newer"),
  op("video_module", "finishing", "internal", "loudness and true peak"),
  op("video_module", "firstFrame", "internal", "a generated clip's first frame"),
  op("video_module", "frames", "internal", "frame reads for clip checks"),
  op("video_module", "look", "entry", "one colour filter per look on clips", ["look.preset"]),
  op("video_module", "materialize", "internal", "fetches media to local files"),
  op("video_module", "plan", "internal", "the stitch's conform-and-join plan"),
  op("video_module", "probe", "internal", "reads length and frame rate"),
  op("video_module", "prompts", "internal", "a generated clip's brief"),
  op("video_module", "reroll", "internal", "a failed clip's recommendation"),
  op("video_module", "seedance", "internal", "a generated shot's provider request"),
  op("video_module", "seedance.cells", "internal", "a generated shot's provider request"),
  op("video_module", "shotSnap", "internal", "snaps a trim to a camera cut"),
  op("video_module", "signals", "internal", "a clip's measured frame rate, loudness, silence, blur and freezes"),
  op("video_module", "shotType", "internal", "shot type words"),
  op("video_module", "shots", "internal", "camera-cut detection"),
  op("video_module", "spec", "internal", "lengths and holds"),
  op("video_module", "still", "entry", "a held photo, its moves and the Board's grade", ["image.held", ...MOTIONS, "look"]),
  op("video_module", "stillMotion", "entry", "the photo moves' names", MOTIONS),
  op("video_module", "stitch", "entry", "trims and joins her clips", ["clip.camera", "clip.her_instagram", "clip.made_here"]),
  op("video_module", "structure", "internal", "checks a finished clip's shape"),
  op("video_module", "structureFixtures", "internal", "test fixtures"),
  op("video_module", "structureVocab", "internal", "shape words"),
  op("video_module", "testFixtures", "internal", "test fixtures"),
  op("video_module", "types", "internal", "types"),

  op("music_module", "recommend", "entry", "the best track for a feel or mood", ["music.track", "music.mood"]),
  op("music_module", "find", "entry", "three tracks for a mood, behind AGENT_POST_KIT_MUSIC_CHOICES", ["music.mood"]),
  op("music_module", "library", "entry", "the free cleared catalogue the finder reads", ["music.mood"]),
  op("music_module", "suggest", "entry", "the Board's suggested track", ["music.track"]),
  op("music_module", "taxonomy", "internal", "the mood words and their crosswalk"),
  op("music_module", "tracks", "entry", "the licensed catalogue", ["music.track", "music.mood"]),

  op("planned", "reframe", "later", "after launch: she stays in frame when a wide clip goes 9:16", ["clip.reframe"]),
  op("planned", "stat card", "later", "a sourced number she confirmed", ["card.stat"]),
  op("planned", "upscale", "later", "soft media made sharp", ["image.upscale", "clip.upscale"]),
];

/**
 * The capability names no planner may promise yet, in inventory order, each once. An `*` name stands for a family
 * (image.object.* — remove, add, move, replace).
 */
export function laterCapabilities(): string[] {
  const out: string[] = [];
  for (const row of MEDIA_OPERATIONS) for (const n of row.later ?? []) if (!out.includes(n)) out.push(n);
  return out;
}
