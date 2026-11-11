/**
 * studio/identity/types — the pack's shape and sizes, with no import of the database, so the pure
 * modules (packGate.ts, calibrate.ts) and the client-facing wire can share them without pulling
 * server/db into a unit test or a client bundle's type graph.
 */
import type { FaceVisibility } from "../../lib/visionTag";

/** Fewer than this and the pack is INCOMPLETE: saved, shown as such, and the chooser stands down. */
export const PACK_MIN = 10;
export const PACK_MAX = 15;

export interface PackEntry {
  assetId: string;
  /** The face box's long edge as a fraction of the frame's (qa/face.ts sizeFrac). Null until measured. */
  faceSizeFrac: number | null;
  /** The tagger's athlete_prominence at pack time. */
  prominence: number;
  faceVisibility: FaceVisibility;
  /**
   * The tagger's `shot_type` word at pack time (portrait | action | lifestyle | group | text_graphic |
   * other), or null on an old row. Walk-driven amendment to R-3 (Adi, 24 Sep 2026): the chooser's
   * second slot wants a BODY-bearing shot, and the largest face is by construction the tightest crop.
   */
  shotType: string | null;
}

/** A shot that shows her build, not only her face. */
export const BODY_SHOT_TYPES: readonly string[] = [
  "action",
  "lifestyle",
  "full-body",
];
export const isBodyShot = (shotType: string | null | undefined): boolean =>
  shotType !== null &&
  shotType !== undefined &&
  BODY_SHOT_TYPES.includes(shotType);

export interface IdentityBand {
  min: number;
  max: number;
  pairs: number;
}
