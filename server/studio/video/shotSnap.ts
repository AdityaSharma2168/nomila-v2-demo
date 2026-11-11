/**
 * shotSnap.ts — where a clip's shots change, as stored, and how a beat's cut snaps onto one (quality-scrappy piece 3,
 * docs/probes/quality-scrappy.md, ADI-QS-GO). Pure: no database, no ffmpeg — the caster (agent/cast.ts) reads it, and
 * video/shots.ts writes what it reads.
 *
 * ─── WHAT A BOUNDARY IS, AND WHY A CUT SNAPS TO IT ─────────────────────────────────────────────────────
 *
 * A boundary is the time of the FIRST frame of a new shot — the frame ffmpeg's scene score jumped on. The Flash beats
 * (vision.beats) are PHASES of what happens, read by a model, at half-second grain; a boundary is where the PICTURE
 * cuts. When a beat's edge sits within half a second of a cut, cutting there lands the edit on the camera's own cut
 * instead of a few frames either side of it — a flash of the neighbouring shot at the start or end of the segment.
 *
 * A start snaps TO the boundary (the segment opens on the new shot's first frame); an end snaps TO it too (the
 * segment closes just before the next shot begins). A snap that would leave the segment shorter than MIN_SEGMENT_SEC,
 * or outside the clip, does not happen.
 *
 * ⚠️ PREDICTED TO FIRE RARELY on her library (P3/P3b): her uploads are mostly single takes and her generated clips are
 * one shot each, so most beats have no cut near them. Built anyway (ADI-QS-GO); the ledger counts how often it fires.
 *
 * ⚠️ MUTATION (shots.test.ts): widen the window (`within`) to 5 s — "a boundary 0.6 s from the edge does not snap" reds.
 */

/** A beat edge snaps to a boundary no further than this away. */
export const SNAP_WITHIN_SEC = 0.5;
/** A snapped segment keeps at least this much. */
export const MIN_SEGMENT_SEC = 0.5;

/** `metadata.shots` — written by video/shots.ts. */
export interface ShotRecord {
  version: 1;
  method: "ffmpeg-scene";
  /** The scene-score threshold the boundaries were found at. */
  threshold: number;
  /** Seconds into the clip, ascending: the first frame of each new shot. Empty for a single take. */
  boundaries: number[];
  durationSec: number;
  at: string;
}

/** The boundaries off a row's metadata — only well-formed numbers, ascending — or [] when there is no record. */
export function shotsOf(metadata: unknown): number[] {
  const raw = (metadata as { shots?: { boundaries?: unknown } } | null)?.shots
    ?.boundaries;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0,
    )
    .sort((a, b) => a - b);
}

const nearest = (t: number, boundaries: readonly number[], within: number) => {
  let best: number | null = null;
  for (const b of boundaries)
    if (
      Math.abs(b - t) <= within &&
      (best === null || Math.abs(b - t) < Math.abs(best - t))
    )
      best = b;
  return best;
};

export interface SnappedWindow {
  startSec: number;
  endSec: number;
  /** Which edges moved — [] when nothing snapped. */
  snapped: ("start" | "end")[];
}

/** A beat's window with each edge snapped to a cut within `within` seconds, when doing so keeps a real segment. */
export function snapWindow(
  window: { startSec: number; endSec: number },
  boundaries: readonly number[],
  opts: { durationSec?: number | null; within?: number } = {},
): SnappedWindow {
  const within = opts.within ?? SNAP_WITHIN_SEC;
  const limit = opts.durationSec ?? Infinity;
  let { startSec, endSec } = window;
  const snapped: ("start" | "end")[] = [];
  const s = nearest(startSec, boundaries, within);
  if (s !== null && s !== startSec && s >= 0 && endSec - s >= MIN_SEGMENT_SEC) {
    startSec = s;
    snapped.push("start");
  }
  const e = nearest(endSec, boundaries, within);
  if (
    e !== null &&
    e !== endSec &&
    e <= limit &&
    e - startSec >= MIN_SEGMENT_SEC
  ) {
    endSec = e;
    snapped.push("end");
  }
  return { startSec, endSec, snapped };
}
