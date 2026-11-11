/**
 * structureVocab.ts — the structure check's vocabulary and record shape (quality-scrappy piece 2), with NO imports:
 * the QA wire (qa/routes.ts) reads it without pulling video/structure.ts's database and ffmpeg in, and the stitch path
 * reaches it without reaching qa/.
 */

/** The reasons a structure check can give, closed. Each has one plain sentence (`STRUCTURE_LINE`). */
export type StructureReason =
  | "duration"
  | "aspect"
  | "resolution"
  | "black"
  | "frozen"
  | "silent";

export type StructureStatus = "pass" | "flag" | "fail" | "unknown";

/** What she is told for each reason — no number, no threshold (qa/routes.ts's rule). */
export const STRUCTURE_LINE: Record<StructureReason, string> = {
  duration: "It came back a different length than asked.",
  aspect: "It came back in the wrong shape.",
  resolution: "It came back at the wrong size.",
  black: "Part of it is a black screen.",
  frozen: "Part of it is frozen.",
  silent: "It came back without the sound that was asked for.",
};

/** A finding and how bad it is. */
export interface StructureFinding {
  reason: StructureReason;
  severity: "flag" | "fail";
}

/** What was asked of this output. Null means "not asked", and is not checked. */
export interface StructureExpectation {
  durationSec: number | null;
  /** "9:16" and the like. */
  aspect: string | null;
  width: number | null;
  height: number | null;
  /** Sound was paid for (a clip), or a bed was laid under it (a stitch). */
  sound: boolean;
}

export interface StructureMeasurement {
  durationSec: number;
  width: number;
  height: number;
  displayAspect: number;
  hasAudio: boolean;
  blackSec: number;
  longestBlackSec: number;
  frozenSec: number;
  longestFrozenSec: number;
  /** Null when sound was not expected — silence on a clip that did not pay for sound is not measured. */
  silentSec: number | null;
}

/** `metadata.creative_qa.structure`. */
export interface StructureRecord {
  version: 1;
  at: string;
  subject: "clip" | "stitch";
  status: StructureStatus;
  findings: StructureFinding[];
  expected: StructureExpectation;
  measured: StructureMeasurement | null;
  /** Present only when the check could not run (status "unknown"). */
  error: string | null;
  latencyMs: number;
}
