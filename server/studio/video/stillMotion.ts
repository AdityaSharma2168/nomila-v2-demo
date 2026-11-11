/**
 * studio/video/stillMotion — how a held photo may move, on the wire. A leaf: no imports, so the planner
 * (studio/agent) reads the vocabulary without loading the renderer (still.ts, sharp, ffmpeg).
 *
 * PR 6's naming contract (docs/probes/photos-motion.md:12-23): the centred push-in is "dolly" — it was
 * "pan" until PR 6 — beside "zoom", "sweep" and "punch". "pan" stays the generated-shot camera word
 * (studio/agent/capabilities.ts), so on an image it is read as dolly (`STILL_MOTION_ALIASES`) and never
 * written: stitch specs stored before PR 6 and an older client's body keep working.
 */
export const STILL_MOTIONS = ["dolly", "zoom", "sweep", "punch"] as const;
export type StillMotion = (typeof STILL_MOTIONS)[number];

/** Pre-PR-6 spellings → the wire name. Read, never written. ⚠️ MUTATION: drop `pan` — "alias dropped" reds by name. */
export const STILL_MOTION_ALIASES: Readonly<Record<string, StillMotion>> = {
  pan: "dolly",
};

const isStillMotion = (v: string): v is StillMotion =>
  (STILL_MOTIONS as readonly string[]).includes(v);

/** A stored or incoming value → the wire name, or null when it names no move this renderer makes. */
export function readStillMotion(v: unknown): StillMotion | null {
  if (typeof v !== "string") return null;
  if (isStillMotion(v)) return v;
  return STILL_MOTION_ALIASES[v] ?? null;
}
